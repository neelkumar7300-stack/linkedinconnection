import { Actor } from 'apify';
import { CheerioCrawler } from 'crawlee';

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
    persistenceStoreName = "linkedin-connection-scraper-state"
} = input;

console.log(`Starting LinkedIn Connections Persistent Scraper with parameters:`);
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

// Formulate search dorks: site:linkedin.com/in/ "Role" "Region" "Context"
for (const role of roles) {
    for (const region of regions) {
        if (contextKeywords && contextKeywords.length > 0) {
            for (const context of contextKeywords) {
                const searchString = `site:linkedin.com/in/ "${role}" "${region}" "${context}"`;
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchString)}`;
                
                initialRequests.push({
                    url: searchUrl,
                    userData: {
                        role,
                        region,
                        context,
                        searchString
                    }
                });
            }
        } else {
            // Search without context if none provided
            const searchString = `site:linkedin.com/in/ "${role}" "${region}"`;
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchString)}`;
            
            initialRequests.push({
                url: searchUrl,
                userData: {
                    role,
                    region,
                    context: "",
                    searchString
                }
            });
        }
    }
}

// Load Apify Proxy to prevent bot blocking from DuckDuckGo
const proxyConfiguration = await Actor.createProxyConfiguration();

console.log(`Generated ${initialRequests.length} search queries to execute.`);

let newProfilesScraped = 0;
let duplicatesSkipped = 0;

// Setup Crawlee CheerioCrawler
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 3, // Low concurrency to avoid DuckDuckGo rate-limiting/blocking
    minConcurrency: 1,

    preNavigationHooks: [
        async (crawlingContext, gotOptions) => {
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ];
            const randomAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

            gotOptions.headers = {
                ...gotOptions.headers,
                'User-Agent': randomAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://duckduckgo.com/'
            };

            // Implement a randomized delay to behave like a human (1.5s to 3.5s)
            const delayMs = Math.floor(Math.random() * 2000) + 1500;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    ],

    async requestHandler({ $, request }) {
        const { url, userData } = request;
        console.log(`Processing search page: ${url}`);

        const results = [];
        let itemsProcessed = 0;

        $('.result').each((i, element) => {
            if (itemsProcessed >= limitPerQuery) return false; // Break loop if we reached query limit

            const title = $(element).find('.result__title').text().trim();
            const link = $(element).find('.result__url').attr('href');
            const snippet = $(element).find('.result__snippet').text().trim();

            if (link) {
                let cleanUrl = link;
                
                // Clean DuckDuckGo's redirection wrappers if present
                if (link.includes('uddg=')) {
                    const match = link.match(/uddg=([^&]+)/);
                    if (match) {
                        try {
                            cleanUrl = decodeURIComponent(match[1]);
                        } catch (e) {
                            cleanUrl = link;
                        }
                    }
                }

                // Check if it's a valid LinkedIn personal profile URL
                const isProfile = cleanUrl.includes('linkedin.com/in/') && 
                                 !cleanUrl.includes('/dir/') && 
                                 !cleanUrl.includes('/jobs/') &&
                                 !cleanUrl.includes('/pulse/') &&
                                 !cleanUrl.includes('/company/') &&
                                 !cleanUrl.includes('/posts/');

                if (isProfile) {
                    // Normalize URL for deduplication (strip query params, trailing slashes, downcase)
                    const normalizedUrl = cleanUrl.split('?')[0].replace(/\/$/, '').toLowerCase().trim();
                    
                    // 1. Check if seen in current run
                    if (seenInCurrentRun.has(normalizedUrl)) {
                        return; // Skip duplicate inside the current run
                    }
                    seenInCurrentRun.add(normalizedUrl);

                    // 2. Check if already scraped in previous runs (persistent state)
                    if (usePersistenceFilter && scrapedProfilesSet.has(normalizedUrl)) {
                        duplicatesSkipped++;
                        return; // Skip duplicate across runs
                    }

                    // If not a duplicate, parse title/role information
                    // DuckDuckGo title typically looks like: "Jane Doe - Technical Recruiter - Google | LinkedIn"
                    let name = 'LinkedIn Member';
                    let roleTitle = 'Recruitment Professional';
                    
                    // Strip "| LinkedIn" (case-insensitive)
                    const cleanTitle = title.replace(/\s*\|\s*LinkedIn/gi, '');
                    const parts = cleanTitle.split(/\s+[-–—]\s+/);
                    
                    if (parts.length > 0 && parts[0].trim()) {
                        name = parts[0].trim();
                    }
                    if (parts.length > 1 && parts[1].trim()) {
                        roleTitle = parts.slice(1).join(' - ').trim();
                    }

                    // Try to guess the company name from the role title or snippet
                    let company = 'Unknown Company';
                    const companyRegex = /\b(?:at|for|partner\s+at)\s+([A-Z][A-Za-z0-9\s,&.]{1,25})/i;
                    const companyMatch = roleTitle.match(companyRegex) || snippet.match(companyRegex);
                    if (companyMatch) {
                        company = companyMatch[1].trim().replace(/\s+in\s+.*$/i, ''); // Strip trailing location matches
                    } else {
                        // Fallback check: look for capitalized words after "at"
                        const simpleAtRegex = /at\s+([A-Z][a-zA-Z\s]{1,15})/g;
                        const simpleMatch = simpleAtRegex.exec(roleTitle) || simpleAtRegex.exec(snippet);
                        if (simpleMatch) {
                            company = simpleMatch[1].trim();
                        }
                    }

                    // Record the profile
                    results.push({
                        name,
                        title: roleTitle,
                        company,
                        location: userData.region,
                        searchRole: userData.role,
                        searchContext: userData.context,
                        profileUrl: normalizedUrl,
                        scrapedAt: new Date().toISOString()
                    });

                    // Add to persistence set so we don't scrape it later in this or future runs
                    scrapedProfilesSet.add(normalizedUrl);
                    newProfilesScraped++;
                    itemsProcessed++;
                }
            }
        });

        console.log(`Found ${results.length} new profiles for query: "${userData.role}" in "${userData.region}" ("${userData.context}").`);
        if (results.length > 0) {
            await Actor.pushData(results);
        }
    },

    failedRequestHandler({ request }) {
        console.error(`Request failed repeatedly: ${request.url}`);
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
