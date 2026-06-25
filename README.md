# LinkedIn Connections Persistent Scraper (Apify Actor)

This is a serverless Apify Actor written in Node.js using **Crawlee** to search and scrape LinkedIn profile connections (recruiters and HR professionals) based on configurable locations and roles. It utilizes DuckDuckGo HTML dorking (no login/session cookies required) and contains a **persistent duplicate filter** so that you never scrape the same profile twice.

## Features

- **Guest Access**: Scrapes profiles using public search dorking, avoiding any risk of LinkedIn account restrictions or suspension.
- **Configurable Inputs**: Customize the locations, roles, and job context keywords directly from the Apify console UI.
- **Persistent Duplicate Filter**: Remembers all profiles scraped in previous runs using an Apify Named Key-Value Store (`linkedin-connection-scraper-state`), preventing duplicates in future runs.
- **Data Extracted**:
  - Name
  - Title / Role
  - Company (parsed from profile/snippet)
  - Target Location
  - Search Role used
  - Search Context keyword used
  - Profile URL (normalized)
  - Scraping Timestamp

---

## Inputs Schema Configuration

You can customize the following fields on the Apify console or via the `INPUT.json` file during local runs:

1. **Outreach Roles / Titles** (`roles`): List of recruiter/HR titles (e.g. `["Recruiter", "Talent Acquisition", "Technical Recruiter"]`).
2. **Target Regions / Locations** (`regions`): Target locations (e.g. `["Greater Toronto Area"]`).
3. **IT / Job Context Keywords** (`contextKeywords`): Domain/industry filters to qualify profiles (e.g. `["IT Helpdesk", "IT Support"]`).
4. **Limit Per Search Query** (`limitPerQuery`): Maximum profiles to extract per search query combination (default: `20`).
5. **Filter Out Previously Scraped Profiles** (`usePersistenceFilter`): Toggle to enable or disable cross-run duplicate checking (default: `true`).
6. **Named Key-Value Store for Persistence** (`persistenceStoreName`): The named Key-Value store to use for preserving scraped history (default: `linkedin-connection-scraper-state`).

---

## Local Development & Setup

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended).

### 2. Install Dependencies
In the project directory, run:
```bash
npm install
```

### 3. Configure Input (Local Emulation)
The Apify SDK simulates local storage inside the `storage` directory. To define inputs locally:
1. Create a file path: `storage/key_value_stores/default/INPUT.json`
2. Add your search parameters:
```json
{
  "roles": [
    "Recruiter",
    "Talent Acquisition"
  ],
  "regions": [
    "Greater Toronto Area"
  ],
  "contextKeywords": [
    "IT Helpdesk",
    "IT Support"
  ],
  "limitPerQuery": 5,
  "usePersistenceFilter": true,
  "persistenceStoreName": "linkedin-connection-scraper-state"
}
```

### 4. Run the Actor Locally
Start the scraper using:
```bash
npm start
```

### 5. Inspect Results
- Scraped profiles are stored in: `storage/datasets/default/` (JSON format)
- Persistent state is stored in: `storage/key_value_stores/linkedin-connection-scraper-state/alreadyScraped.json`

---

## Deploying to Apify

### Option A: Using Apify CLI
1. Install the Apify CLI:
   ```bash
   npm install -g apify-cli
   ```
2. Log in to your Apify account:
   ```bash
   apify login
   ```
3. Deploy the Actor:
   ```bash
   apify push
   ```

### Option B: Using GitHub Integration
1. Push this project folder to a GitHub repository.
2. In the [Apify Console](https://console.apify.com/), click **Create new Actor**.
3. Link the Actor to your GitHub repository.
4. Apify will automatically build and deploy the Actor on every push to your GitHub repository.
