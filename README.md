# Lebanon Private Label Product Research Agent

Personal backend agent. Runs once a week, scrapes Meta Ad Library for trending DTC products, scores them against private-label criteria, checks Lebanon competition, finds Alibaba suppliers, and writes vetted product reports to a Notion database.

Not a SaaS. Single-owner tool for finding products to private-label and sell in Lebanon.

See [CLAUDE.md](CLAUDE.md) for project conventions and [PRD.md](PRD.md) for the full spec.

---

## Setup

### 1. Install Node.js

Requires Node 18.17 or newer. Check with `node --version`.

### 2. Install dependencies

```
npm install
```

### 3. Configure `.env`

```
cp .env.example .env
```

Then fill in the keys. For Phase 1 only `META_ACCESS_TOKEN` is needed.

### 4. Generate a Meta Ad Library access token

The Ad Library API is free but requires a verified Meta dev account.

1. Sign in at <https://developers.facebook.com/> and go to **My Apps → Create App**.
2. Choose app type **"Business"** (or "Other → Business"). Skip the optional product setup steps.
3. App Settings → **Basic**: copy the **App ID** and **App Secret** somewhere safe.
4. Complete identity verification and location confirmation at <https://www.facebook.com/ads/library/api/>. This is required before `ads_archive` returns data and can take up to 48h.
5. Open the Graph API Explorer at <https://developers.facebook.com/tools/explorer/>:
    - Select your app from the top-right dropdown.
    - Click **Generate Access Token** (default `public_profile` scope is fine — Ad Library does not need extra permissions).
    - Copy the short-lived token.
6. Exchange for a 60-day long-lived token:

    ```
    curl "https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
    ```

7. Paste the long-lived token into `.env` as `META_ACCESS_TOKEN=...`.

The token expires after 60 days. The scraper logs a clear error if the token is rejected — when that happens, repeat steps 5–7.

---

## Running each phase

```
npm run phase1   # Scrape Meta Ad Library → data/ads.json
```

Phases 2–6 are not implemented yet.

---

## Project layout

```
/src
  /phases
    phase1-scraper.ts       Meta Ad Library scraper
  /types
    index.ts                Shared TypeScript types + keyword list
  /utils
    claude.ts               (placeholder — Phase 2)
    logger.ts               Timestamped console logger
/data                       Runtime JSON output (gitignored)
.env                        Local secrets (gitignored)
.env.example                Template for .env
CLAUDE.md                   Project conventions
PRD.md                      Full product requirements
```
