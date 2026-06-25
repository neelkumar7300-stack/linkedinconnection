import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

// Initialize the Apify SDK
await Actor.init();

// Fetch Actor inputs with defaults matching the user's specific request
const input = await Actor.getInput() || {};
const {
    roles = [
        "Recruiter",
        "Talent Acquisition",
        "HR Manager",
        "HR Professional",
        "Technical Recruiter"
    ],
    regions = ["Greater Toronto Area"],
    contextKeywords = [
        "IT Helpdesk",
        "IT Support",
        "IT"
    ],
    limitPerQuery = 20,
    usePersistenceFilter = true,
    persistenceStoreName = "linkedin-connection-scraper-state",
    linkedinCookie = ""
} = input;

if (!linkedinCookie) {
    console.error("FATAL ERROR: 'linkedinCookie' is missing from input.");
    console.error("This actor searches LinkedIn directly and requires a valid 'li_at' session cookie.");
    await Actor.exit({ exitCode: 1 });
}

console.log(`Starting LinkedIn Authenticated Scraper with parameters:`);
console.log(`- Roles: ${JSON.stringify(roles)}`);
console.log(`- Regions: ${JSON.stringify(regions)}`);
console.log(`- Context Keywords: ${JSON.stringify(contextKeywords)}`);
console.log(`- Limit Per Query: ${limitPerQuery}`);
console.log(`- Persistent Deduplication Filter: ${usePersistenceFilter ? 'ENABLED' : 'DISABLED'}`);
console.log(`- Key-Value Store Name: ${persistenceStoreName}`);

// Load previously scraped profiles to support persistent deduplication across runs
const scrapedProfilesSet = new Set();
let store = null;

if (usePersistenceFilter) {
    try {
        console.log(`Opening named Key-Value Store: "${persistenceStoreName}"...`);
        store = await Actor.openKeyValueStore(persistenceStoreName);
        const previouslyScraped = await store.getValue('alreadyScraped') || [];
        console.log(`Loaded ${previouslyScraped.length} previously scraped profiles from persistent storage.`);
        for (const url of previouslyScraped) {
            scrapedProfilesSet.add(url.toLowerCase().trim());
        }
    } catch (e) {
        console.error(`Failed to load persistent state. Proceeding without history. Error:`, e);
    }
}

// Track seen URLs in the current run (to prevent internal query duplicates)
const seenInCurrentRun = new Set();

const initialRequests = [];

// Formulate LinkedIn internal search queries
for (const role of roles) {
    for (const region of regions) {
        if (contextKeywords && contextKeywords.length > 0) {
            for (const context of contextKeywords) {
                const searchString = `"${role}" "${region}" "${context}"`;
                const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchString)}&origin=GLOBAL_SEARCH_HEADER`;
                
                initialRequests.push({
                    url: searchUrl,
                    userData: { role, region, context, searchString }
                });
            }
        } else {
            const searchString = `"${role}" "${region}"`;
            const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(searchString)}&origin=GLOBAL_SEARCH_HEADER`;
            
            initialRequests.push({
                url: searchUrl,
                userData: { role, region, context: "", searchString }
            });
        }
    }
}

// Load Apify Proxy to prevent bot blocking (LinkedIn limits IPs even when logged in)
const proxyConfiguration = await Actor.createProxyConfiguration();

console.log(`Generated ${initialRequests.length} search queries to execute.`);

let newProfilesScraped = 0;
let duplicatesSkipped = 0;

// Setup Crawlee PlaywrightCrawler
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 1, // Must be 1 when logged into LinkedIn to avoid account bans and aggressive rate limits
    headless: true,

    preNavigationHooks: [
        async ({ page, request }) => {
            // Inject the LinkedIn session cookie into the browser before navigating
            await page.context().addCookies([{
                name: 'li_at',
                value: linkedinCookie,
                domain: '.linkedin.com',
                path: '/'
            }]);

            // Add a randomized human-like delay before each request (3s to 6s)
            const delayMs = Math.floor(Math.random() * 3000) + 3000;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    ],

    async requestHandler({ page, request }) {
        const { url, userData } = request;
        console.log(`Processing search page for: ${userData.searchString}`);

        // Wait for results to load
        try {
            await page.waitForSelector('.search-results-container, .search-reusables__no-results', { timeout: 15000 });
        } catch (e) {
            console.error('Timeout waiting for search results. This could mean the cookie is invalid, expired, or LinkedIn is showing a CAPTCHA/Verification.');
            // Check if we hit the auth wall
            if (await page.$('.login__form') || await page.$('form[action="/checkpoint/lg/login-submit"]')) {
                throw new Error("Cookie is invalid or expired. LinkedIn redirected to the login page.");
            }
        }

        // Scroll down to ensure all result elements render fully
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const results = [];
        let itemsProcessed = 0;

        // Parse results from the DOM
        const parsedResults = await page.$$eval('.reusable-search__result-container', (elements) => {
            return elements.map(el => {
                const linkEl = el.querySelector('.app-aware-link');
                const titleWrapper = el.querySelector('.entity-result__title-text');
                const nameSpan = titleWrapper ? titleWrapper.querySelector('span[aria-hidden="true"]') : null;
                const subtitleEl = el.querySelector('.entity-result__primary-subtitle'); // Title/Role
                const locationEl = el.querySelector('.entity-result__secondary-subtitle'); // Location
                
                return {
                    link: linkEl ? linkEl.getAttribute('href') : '',
                    name: nameSpan ? nameSpan.innerText.trim() : (titleWrapper ? titleWrapper.innerText.trim() : 'LinkedIn Member'),
                    title: subtitleEl ? subtitleEl.innerText.trim() : '',
                    location: locationEl ? locationEl.innerText.trim() : ''
                };
            });
        });

        for (const element of parsedResults) {
            if (itemsProcessed >= limitPerQuery) break; // Break loop if we reached query limit

            let { link, name, title, location } = element;

            if (link && link.includes('/in/')) {
                // Ensure it's a full URL
                let cleanUrl = link;
                if (!cleanUrl.startsWith('http')) {
                    cleanUrl = `https://www.linkedin.com${cleanUrl}`;
                }

                // Normalize URL for deduplication
                const normalizedUrl = cleanUrl.split('?')[0].replace(/\/$/, '').toLowerCase().trim();
                
                // 1. Check if seen in current run
                if (seenInCurrentRun.has(normalizedUrl)) {
                    continue; // Skip duplicate inside the current run
                }
                seenInCurrentRun.add(normalizedUrl);

                // 2. Check if already scraped in previous runs
                if (usePersistenceFilter && scrapedProfilesSet.has(normalizedUrl)) {
                    duplicatesSkipped++;
                    continue; // Skip duplicate across runs
                }

                // Clean up name artifacts
                name = name.split('\n')[0].trim();

                // Record the profile
                results.push({
                    name,
                    title,
                    location: location || userData.region,
                    searchRole: userData.role,
                    searchContext: userData.context,
                    profileUrl: normalizedUrl,
                    scrapedAt: new Date().toISOString()
                });

                // Add to persistence set
                scrapedProfilesSet.add(normalizedUrl);
                newProfilesScraped++;
                itemsProcessed++;
            }
        }

        console.log(`Found ${results.length} new profiles out of ${parsedResults.length} parsed items on this page.`);
        if (results.length > 0) {
            await Actor.pushData(results);
        }
    },

    failedRequestHandler({ request, error }) {
        console.error(`Request failed repeatedly: ${request.url}`);
        console.error(`Error details: ${error.message}`);
    }
});

// Run crawler
console.log('Running search requests...');
await crawler.run(initialRequests);

// Save the updated list of scraped profiles back to persistent Key-Value Store
if (usePersistenceFilter && store) {
    console.log(`Saving ${scrapedProfilesSet.size} total scraped profiles back to persistent storage...`);
    try {
        await store.setValue('alreadyScraped', Array.from(scrapedProfilesSet));
        console.log('Persistent storage successfully updated.');
    } catch (e) {
        console.error('Failed to save updated persistent state:', e);
    }
}

console.log('--------------------------------------------------');
console.log('Crawling completed!');
console.log(`- New profiles scraped and saved to dataset: ${newProfilesScraped}`);
console.log(`- Persistent duplicate profiles skipped: ${duplicatesSkipped}`);
console.log(`- Total profiles currently in persistent filter: ${scrapedProfilesSet.size}`);
console.log('--------------------------------------------------');

// Clean up and exit
await Actor.exit();
