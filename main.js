import { Actor } from 'apify';

// Initialize the Apify SDK
await Actor.init();

// Fetch Actor inputs
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
    maxTotalProfiles = 0,
    usePersistenceFilter = true,
    persistenceStoreName = "linkedin-connection-scraper-state"
} = input;

console.log(`Starting LinkedIn Orchestration Scraper with parameters:`);
console.log(`- Roles: ${JSON.stringify(roles)}`);
console.log(`- Regions: ${JSON.stringify(regions)}`);
console.log(`- Context Keywords: ${JSON.stringify(contextKeywords)}`);
console.log(`- Limit Per Query: ${limitPerQuery}`);
console.log(`- Persistent Deduplication Filter: ${usePersistenceFilter ? 'ENABLED' : 'DISABLED'}`);

// 1. Load previously scraped profiles to support persistent deduplication across runs
const scrapedProfilesSet = new Set();
let store = null;

if (usePersistenceFilter) {
    try {
        store = await Actor.openKeyValueStore(persistenceStoreName);
        const previouslyScraped = await store.getValue('alreadyScraped') || [];
        console.log(`Loaded ${previouslyScraped.length} previously scraped profiles from persistent storage.`);
        for (const url of previouslyScraped) {
            scrapedProfilesSet.add(url.toLowerCase().trim());
        }
    } catch (e) {
        console.error(`Failed to load persistent state. Proceeding without history. Error:`, e.message);
    }
}

// 2. Formulate Google Search queries
const queries = [];
const queryMetadata = {}; // Keep track of what role/region a query corresponds to

for (const role of roles) {
    for (const region of regions) {
        if (contextKeywords && contextKeywords.length > 0) {
            for (const context of contextKeywords) {
                const term = `site:linkedin.com/in/ "${role}" "${region}" "${context}"`;
                queries.push(term);
                queryMetadata[term] = { role, region, context };
            }
        } else {
            const term = `site:linkedin.com/in/ "${role}" "${region}"`;
            queries.push(term);
            queryMetadata[term] = { role, region, context: "" };
        }
    }
}

console.log(`Generated ${queries.length} search queries. Dispatching to Apify Google Search Scraper...`);

// 3. Call the official apify/google-search-scraper
// This costs a small amount of compute units but guarantees bypassing all CAPTCHAs and blocks.
let run;
try {
    run = await Actor.call('apify/google-search-scraper', {
        queries: queries.join('\n'),
        resultsPerPage: limitPerQuery > 100 ? 100 : limitPerQuery,
        maxPagesPerQuery: Math.ceil(limitPerQuery / 100) || 1,
        mobileResults: false,
    });
} catch (error) {
    console.error("Failed to call apify/google-search-scraper. Make sure you have enough Apify credits.");
    throw error;
}

console.log(`Google Search Scraper finished successfully (Run ID: ${run.id}). Processing results...`);

// 4. Fetch the dataset produced by the Google Search Scraper
const dataset = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
const { items } = await dataset.getData();

const finalProfiles = [];
let newProfilesScraped = 0;
let duplicatesSkipped = 0;
const seenInCurrentRun = new Set();

for (const item of items) {
    // Check if the query matched one of ours to fetch the metadata
    const term = item.searchQuery?.term || "";
    const meta = queryMetadata[term] || { role: "Unknown", region: "Unknown", context: "" };
    
    const organicResults = item.organicResults || [];
    let itemsProcessed = 0;

    for (const result of organicResults) {
        if (itemsProcessed >= limitPerQuery) break;

        const { title = "", url = "", description = "" } = result;

        if (url && url.includes('linkedin.com/in/') && !url.includes('/dir/') && !url.includes('/jobs/')) {
            // Normalize URL
            const normalizedUrl = url.split('?')[0].replace(/\/$/, '').toLowerCase().trim();

            if (seenInCurrentRun.has(normalizedUrl)) continue;
            seenInCurrentRun.add(normalizedUrl);

            if (usePersistenceFilter && scrapedProfilesSet.has(normalizedUrl)) {
                duplicatesSkipped++;
                continue;
            }

            // Extract Name and Role Title
            let name = 'LinkedIn Member';
            let roleTitle = 'Professional';
            
            // Clean Google's appended " - LinkedIn" string
            const cleanTitle = title.replace(/\s*[-|]\s*LinkedIn/i, '').trim();
            const parts = cleanTitle.split(/\s+[-–—]\s+/);
            
            if (parts.length > 0 && parts[0].trim()) {
                name = parts[0].trim();
            }
            if (parts.length > 1 && parts[1].trim()) {
                roleTitle = parts.slice(1).join(' - ').trim();
            }

            // Attempt to extract company
            let company = 'Unknown Company';
            const companyRegex = /\b(?:at|for|partner\s+at)\s+([A-Z][A-Za-z0-9\s,&.]{1,25})/i;
            const companyMatch = roleTitle.match(companyRegex) || description.match(companyRegex);
            if (companyMatch) {
                company = companyMatch[1].trim().replace(/\s+in\s+.*$/i, '');
            } else {
                const simpleAtRegex = /at\s+([A-Z][a-zA-Z\s]{1,15})/g;
                const simpleMatch = simpleAtRegex.exec(roleTitle) || simpleAtRegex.exec(description);
                if (simpleMatch) {
                    company = simpleMatch[1].trim();
                }
            }

            if (maxTotalProfiles > 0 && finalProfiles.length >= maxTotalProfiles) {
                break;
            }

            finalProfiles.push({
                name,
                title: roleTitle,
                company,
                location: meta.region,
                searchRole: meta.role,
                searchContext: meta.context,
                profileUrl: normalizedUrl,
                scrapedAt: new Date().toISOString()
            });

            scrapedProfilesSet.add(normalizedUrl);
            newProfilesScraped++;
            itemsProcessed++;
        }
    }
    
    if (maxTotalProfiles > 0 && finalProfiles.length >= maxTotalProfiles) {
        break;
    }
}

// 5. Save results to our own dataset
if (finalProfiles.length > 0) {
    console.log(`Pushing ${finalProfiles.length} unique profiles to the Actor's default dataset...`);
    await Actor.pushData(finalProfiles);
}

// 6. Save updated history to persistent state
if (usePersistenceFilter && store) {
    console.log(`Saving ${scrapedProfilesSet.size} total scraped profiles back to persistent storage...`);
    try {
        await store.setValue('alreadyScraped', Array.from(scrapedProfilesSet));
        console.log('Persistent storage successfully updated.');
    } catch (e) {
        console.error('Failed to save updated persistent state:', e.message);
    }
}

console.log('--------------------------------------------------');
console.log('Orchestration completed!');
console.log(`- New profiles scraped and saved to dataset: ${newProfilesScraped}`);
console.log(`- Persistent duplicate profiles skipped: ${duplicatesSkipped}`);
console.log(`- Total profiles currently in persistent filter: ${scrapedProfilesSet.size}`);
console.log('--------------------------------------------------');

await Actor.exit();
