# CLAUDE.md — Lebanon Private Label Product Research Agent

## What this project is
A fully automated backend AI agent that runs weekly, scrapes Meta Ad Library for trending products globally, scores them against private label criteria, checks local Lebanon competition, finds verified Alibaba suppliers, and writes full product reports (including customer objection analysis) to a Notion database.

**This is a personal tool — not a SaaS product. The owner uses it to find products to private label and sell in Lebanon.**

## Owner context
- Based in Lebanon, selling to Lebanese market only
- Target: private labeling (not dropshipping)
- Budget: $5–20/week running cost
- Schedule: runs once per week (Monday 8am), can increase to twice/week later
- Output: Notion database with one page per qualifying product

## Tech stack
- **Language**: Node.js with TypeScript
- **AI**: Anthropic Claude API (claude-opus-4-20250514) via direct API calls
- **Scheduler**: node-cron for weekly runs
- **Hosting**: Runs locally via node-cron. No cloud hosting needed.
- **Output**: Notion API

## Project structure
```
/src
  /config
    keywords.ts                # legacy static keyword list — replaced by Phase 1 output, kept for fallback
    keyword-estimates.ts       # Phase 2.1 heuristic lookup table (price, weight, niche per keyword)
  /phases
    phase0-niches.ts           # Claude niche generation — manual trigger only
    phase0-5-trends.ts         # SerpApi Google Trends validation — runs after Phase 0
    phase1-keywords.ts         # Claude keyword generation per niche — runs once per new niche
    phase2-scraper.ts          # Meta Ad Library scraper (was phase1-scraper.ts)
    phase3-filter.ts           # Claude scoring + criteria filter (was phase2-filter.ts)
    phase3-1-heuristic.ts      # Heuristic stopgap scorer — runs offline without Claude (was phase2-1)
    phase4-competition.ts      # Lebanon competitor check (was phase3)
    phase5-suppliers.ts        # Alibaba supplier lookup (was phase4)
    phase6-analysis.ts         # Claude deep analysis + objections (was phase5)
    phase6-1-template.ts       # Templated analysis stopgap — runs offline without Claude (was phase5-1)
    phase7-notion.ts           # Notion writer (was phase6)
  /types
    index.ts                   # Shared TypeScript types only (no data constants)
  /utils
    claude.ts                  # Claude API helper (Anthropic SDK wrapper)
    serpapi.ts                 # SerpApi helper for Google Trends calls
    notion.ts                  # Notion API helper (read + write)
    logger.ts                  # Simple logger
  pipeline.ts                  # Main orchestrator — runs phases 2–7 on weekly cron
  scheduler.ts                 # Cron job wrapper
/data
  candidate-niches.json        # Output of Phase 0 — raw Claude niche list
  validated-niches.json        # Output of Phase 0.5 — niches that passed trend filter
  discovered-keywords.json     # Output of Phase 1 — keywords grouped by niche
  ads.json                     # Output of Phase 2 — raw Meta ads
  candidates.json              # Output of phases 3–5 — scored + enriched products
  reports.json                 # Output of Phase 6 — full analysis ready for Notion
.env                           # API keys — never commit (gitignored)
.env.example                   # Placeholder template — committed, no real keys
CLAUDE.md                      # This file
PRD.md                         # Full product requirements
```

## Environment variables required
```
ANTHROPIC_API_KEY=
META_ACCESS_TOKEN=
NOTION_API_KEY=
NOTION_DATABASE_ID=
SERPAPI_KEY=
```

---

## Pipeline overview

Two separate flows. Do not conflate them.

### Flow A — Niche & keyword setup (manual, infrequent)
Runs manually by the owner. Not on any cron. Only re-runs when the owner wants fresh niche ideas (every 2–3 months at most).

```
Phase 0   → Phase 0.5   → Phase 1
(niches)    (validation)   (keywords)
```

### Flow B — Weekly product research (automated cron)
Runs every Monday at 8am. Reads discovered-keywords.json written by Flow A and runs the full research pipeline.

```
Phase 2 → Phase 3 → Phase 3.1 → Phase 4 → Phase 5 → Phase 6 → Phase 6.1 → Phase 7
(scrape)  (filter)  (heuristic)  (comp.)   (supply)  (analysis) (template)  (notion)
```

---

## Flow A — Niche & keyword setup

### Phase 0 — Niche generation

**Trigger:** Manual only. Run with `npm run phase0`. Never add this to the cron.
**Input:** Owner constraints (hardcoded in prompt — see below)
**Output:** `data/candidate-niches.json`
**Notion interaction:** Reads existing niches from Notion Niches table before writing. Skips any niche already present (deduplication). Only writes genuinely new niches.
**Claude call:** Yes — one call per run.

#### What it does
Calls Claude API with a structured prompt describing private label constraints for the Lebanese market. Claude returns 12 candidate niches as JSON. Before saving, the phase fetches existing niche names from Notion and filters out duplicates. Only new niches are written to candidate-niches.json and to Notion.

#### Claude prompt constraints (do not change without updating this section)
Goal: identify niches where US-based DTC brands are currently scaling on Meta ads, that can be sourced generically and sold into Lebanon.

Hard constraints (all must pass):
- Typical retail price $15–$60 USD
- Generic category with strong private label history — no patent moats, no dominant single brand globally
- No mandatory certifications for import (exclude: ingestibles, supplements, cosmetics with active ingredients, electronics requiring CE/FCC for primary function, kids' toys under 3yr, medical devices)
- Physically robust for COD delivery — not fragile, not perishable (15–30% COD refusal rate)
- AOV viable at $15+ retail (COD return costs eat margin on ultra-cheap items)

Soft priorities (stronger niches hit more of these):
- Visible scaling on US Meta ads in the past 12 months
- Repeat purchase or natural upsell chain within the category
- Visual/demo-friendly (works well in short-form video ads)
- Solves a problem or triggers an emotion — not just "nice to have"

#### Niche definition — IMPORTANT
A niche is a broad market CATEGORY, not a specific product.
- Correct: "Car Accessories", "Home Office", "Emergency Power", "Eco Kitchen"
- Wrong: "Car Seat Organizer", "Laptop Stand Riser", "UV Water Purifier Wand" (those are products, not niches)
Specific products belong in the `examples` field. The `niche` field is the category they sit in.

#### Niche JSON schema
```typescript
interface CandidateNiche {
  niche: string;               // broad category, 1–3 words e.g. "Car Accessories"
  rationale: string;           // 2-3 sentences on why it's winning on US Meta + private-label-friendly
  examples: string[];          // 3-5 specific product types within the category
  priceRange: string;          // e.g. "$20–$45"
  upsellOrRepeat: string;      // repeat purchase or upsell mechanic
  lebanonImportRisk: "low" | "medium" | "high";
  lebanonImportNotes: string;  // one sentence on import/COD viability
}
```

#### Output file: candidate-niches.json
```json
{
  "niches": [
    {
      "niche": "Car Accessories",
      "rationale": "Car accessory brands are scaling hard on Meta with demo-heavy creatives. Category has no dominant global brand and dozens of OEM suppliers on Alibaba.",
      "examples": ["seat back organizer", "dashboard phone mount", "trunk organizer with dividers"],
      "priceRange": "$18–$40",
      "upsellOrRepeat": "Natural upsell chain across interior accessories — buyer of one often buys 2-3 more",
      "lebanonImportRisk": "low",
      "lebanonImportNotes": "No import restrictions, robust products handle COD returns well, high car ownership drives demand"
    }
  ]
}
```

---

### Phase 0.5 — Trend validation

**Trigger:** Runs automatically immediately after Phase 0 completes.
**Input:** `data/candidate-niches.json`
**Output:** `data/validated-niches.json`
**API:** SerpApi Google Trends endpoint. One call per niche.
**Free tier:** 100 calls/month. At 12 niches per Phase 0 run, this is 12% of monthly budget — well within limits for monthly or less frequent runs.

#### What it does
For each niche, fetches 12 months of Google Trends interest-over-time data. Computes the average of the first 3 months vs the last 3 months. Classifies the niche as RISING, STABLE, or DECLINING. Drops DECLINING niches. Passes RISING and STABLE forward.

#### Trend classification logic
```typescript
const early = average(trendData.slice(0, 3));
const recent = average(trendData.slice(-3));
const change = ((recent - early) / early) * 100;

if (change < -20)             status = 'DECLINING';  // dropped
if (change >= -20 && change < 15) status = 'STABLE'; // kept
if (change >= 15)             status = 'RISING';     // kept, prioritised
```

#### Output file: validated-niches.json
```json
[
  { "niche": "Car Interior Organizers", "status": "RISING", "change": "+23%" },
  { "niche": "Home Office Desk Accessories", "status": "STABLE", "change": "+4%" }
]
```

DECLINING niches are not written to this file. They are logged so the owner can see what was dropped.

---

### Phase 1 — Keyword generation

**Trigger:** Runs automatically after Phase 0.5. One Claude call covers all surviving niches.
**Input:** `data/validated-niches.json`
**Output:** `data/discovered-keywords.json`
**Notion interaction:** Before generating keywords for a niche, checks if that niche already has keywords in the Notion Keywords table. If yes, skips that niche entirely — keywords are never regenerated.
**Claude call:** Yes — one call per run (all niches in a single prompt).

#### CRITICAL RULE
Keywords are generated ONCE per niche and never regenerated. The weekly cron reads discovered-keywords.json as-is. Do not add regeneration logic to the cron.

#### What it does
Generates exactly 8 keywords per niche with a required mix: 3 product category nouns, 2 hook/benefit phrases, 2 mechanism/feature phrases, 1 vernacular/community term. Keywords must be 1–3 words that appear in DTC ad copy or page names — NOT search-engine-style buyer queries.

#### Output file: discovered-keywords.json
```json
{
  "keywordsByNiche": [
    {
      "niche": "Car Accessories",
      "keywords": [
        {"term": "car organizer",    "type": "category"},
        {"term": "trunk organizer",  "type": "category"},
        {"term": "phone mount",      "type": "category"},
        {"term": "clean car",        "type": "hook"},
        {"term": "road trip ready",  "type": "hook"},
        {"term": "magnetic mount",   "type": "mechanism"},
        {"term": "no drill install", "type": "mechanism"},
        {"term": "car setup",        "type": "vernacular"}
      ]
    }
  ]
}
```

Phase 2 reads this file and flattens all `term` fields into its keyword list. The schema of this file is the contract between Phase 1 and Phase 2. Do not change it without updating the Phase 2 reader.

---

## Flow B — Weekly research pipeline

Starts at Phase 2. Reads `data/discovered-keywords.json`. All phases below run on the Monday 8am cron.

### Phase 2 — Meta Ad Library scraper
*(previously Phase 1)*

**Input:** `data/discovered-keywords.json` (flat list of all keywords across all niches)
**Output:** `data/ads.json`

Scrapes Meta Ad Library for each keyword. Filters to active ads only. Returns ad copy, spend signals, creative format, advertiser info. See existing implementation.

---

### Phase 3 — Claude filter
*(previously Phase 2)*

**Input:** `data/ads.json`
**Output:** `data/candidates.json`
**Claude call:** Yes.

Scores each product against the three-tier criteria framework. See scoring criteria section below. Hard rejects are dropped. Outputs max 5 products per run (top 5 by score).

---

### Phase 3.1 — Heuristic stopgap
*(previously Phase 2.1)*

Offline scorer. No Claude required. Mirrors Phase 3 criteria. Used for testing without burning API credits. See scoring criteria section.

---

### Phase 4 — Lebanon competition check
*(previously Phase 3)*

**Input:** `data/candidates.json`
**Output:** updates `data/candidates.json`

Re-queries Meta Ad Library filtered to Lebanon geo. High local ad spend on a keyword = competition exists locally.

---

### Phase 5 — Alibaba supplier lookup
*(previously Phase 4)*

**Input:** `data/candidates.json`
**Output:** updates `data/candidates.json`

HTTP scraping of Alibaba. If scraping breaks, fallback is SerpAPI (~$50/mo). Extracts: supplier name, star rating, certifications, price/unit, MOQ, link.

---

### Phase 6 — Claude deep analysis
*(previously Phase 5)*

**Input:** `data/candidates.json`
**Output:** `data/reports.json`
**Claude call:** Yes.

Full synthesis of all upstream data into a structured report per product. See report schema in Notion section below.

---

### Phase 6.1 — Templated stopgap
*(previously Phase 5.1)*

Offline analyser. No Claude required. Must output identical JSON schema as Phase 6. Phase 7 must not care which phase produced the report.

---

### Phase 7 — Notion writer
*(previously Phase 6)*

**Input:** `data/reports.json`
**Output:** Notion database pages

Writes one Notion page per qualifying product. See Notion schema below.

---

## Build order — IMPORTANT
Build and test one phase at a time. Never move to the next phase until the current one produces clean output.

**Flow A (build first, manually):**
1. Phase 0 — niche generation → outputs `data/candidate-niches.json`
2. Phase 0.5 — trend validation → outputs `data/validated-niches.json`
3. Phase 1 — keyword generation → outputs `data/discovered-keywords.json`

**Flow B (build after Flow A produces valid discovered-keywords.json):**
4. Phase 2 — Meta Ad Library scraper → outputs `data/ads.json`
5. Phase 3 — Claude product filter → outputs `data/candidates.json`
6. Phase 4 — Lebanon competition → updates `data/candidates.json`
7. Phase 5 — Alibaba supplier lookup → updates `data/candidates.json`
8. Phase 6 — Claude deep analysis → outputs `data/reports.json`
9. Phase 7 — Notion writer + cron → final live output

## Current status
> **Update this section as you complete each phase.**
- [ ] Phase 0 — Niche generation (Claude)
- [ ] Phase 0.5 — Trend validation (SerpApi)
- [ ] Phase 1 — Keyword generation (Claude)
- [x] Phase 2 — Meta scraper (was Phase 1)
- [x] Phase 3 — Claude filter (was Phase 2)
- [x] Phase 3.1 — Heuristic stopgap (was Phase 2.1)
- [x] Phase 4 — Lebanon competition (was Phase 3)
- [ ] Phase 5 — Alibaba suppliers (was Phase 4)
- [ ] Phase 6 — Claude deep analysis (was Phase 5)
- [ ] Phase 6.1 — Templated stopgap (was Phase 5.1)
- [ ] Phase 7 — Notion writer + cron (was Phase 6)

---

## Product scoring criteria (Phase 3 + Phase 3.1)
Both Phase 3 (Claude) and Phase 3.1 (heuristic stopgap) use the same three-tier framework so they stay aligned.

**Must-have (fail any = hard reject, dropped from output)**
- Gross margin ≥ 70% before ads
- Selling price ≥ $30
- Weight < 0.5 kg including packaging
- Has natural repeat-purchase / reorder reason
- Evergreen demand (stable 5-year trend, no spike-crash)
- Supports 2–3 logical cross-sells or upsells

**Strong (−10 score for each missing)**
- Top 3 competitor listings have < 300–500 reviews
- Landed cost allows ≥ 3× markup
- Clear differentiation angle (materials/formulation/bundling, not just logo)
- Solves a specific searchable problem (not impulse-only)
- First-order MOQ achievable under 500 units
- No dominant national brand controlling the category

**Nice-to-have (+5 score for each present)**
- Selling price ≥ $50
- Giftable product
- No patent / trademark conflicts
- Simple manufacturing (no electronics, food certs, kid compliance)

**Score formula**: base 50 if must-haves pass → apply strong penalties → apply nice-to-have bonuses → floor 0, cap 100.

**Verdict**: ≥ 75 → "Investigate", 60–74 → "Watch", < 60 or any must-have failed → dropped.

**Output limit: max 5 products per weekly run.** Take top 5 by score. If fewer pass, output only those — never pad.

Phase 3.1 (heuristic) evaluates 6/6 must-haves, 2/6 strong items (3× markup, MOQ), 3/4 nice-to-haves (price ≥$50, giftable, simple mfg). The rest are deferred to Phase 3 (Claude).

---

## Notion database schema

### Niches table (used by Flow A)
- Name (title)
- Status (select: Active / Paused / Rejected)
- Lebanon Fit (number, 1–5)
- Trend Status (select: Rising / Stable / Declining)
- Alibaba Price (text)
- Selling Price (text)
- Created At (date)

### Keywords table (used by Flow A)
- Keyword (title)
- Niche (relation → Niches table)
- Created At (date)

### Products table (used by Flow B)
Each product page must have these properties:
- Title (product name)
- Score (number, 0–100)
- Verdict (select: Investigate / Watch / Skip)
- Selling price (number)
- Alibaba cost range (text)
- Estimated margin % (number)
- Weight kg (number)
- Lebanon competition (select: Low / Medium / High)
- Niche (text)
- Status (select: New / Reviewing / Ordered / Rejected)
- Week generated (date)

Page content blocks (in order):
1. Criteria checklist
2. Market analysis
3. Cross-sell opportunities
4. Customer objections (objection + why it matters in Lebanon + how to counter it on product page)
5. Top Alibaba suppliers (name, stars, certifications, price/unit, MOQ, link)
6. Agent verdict (plain language summary + recommended next step)

---

## Customer objections section — context
This was added based on the insight that finding a product is easy — understanding why Lebanese customers hesitate is harder. For each product, Claude must generate 3–4 objections a Lebanese buyer would have, written as the customer would actually say it, plus a concrete counter for each one that can be used directly on the product page.

Common objection categories for Lebanon:
- Shipping time / reliability
- Product quality doubt ("cheap Chinese plastic")
- Price sensitivity (Lebanon economic situation)
- Brand trust (unknown store)

---

## Key decisions — do not change without updating this file

- **Phase 0 is NEVER on the cron.** It is a manual trigger only (`npm run phase0`). Niches don't change week to week. Running it weekly wastes tokens and produces duplicate output.
- **Keywords are generated ONCE per niche.** Phase 1 checks Notion before generating. If a niche already has keywords in Notion, it is skipped entirely. Do not add regeneration logic without explicit owner instruction.
- **The weekly cron starts at Phase 2, not Phase 0.** Flow A and Flow B are separate entry points. Never chain Phase 0 into the cron.
- **discovered-keywords.json is the contract between Flow A and Flow B.** Do not change its schema without updating the Phase 2 reader simultaneously.
- **Phase numbering has shifted.** The old Phase 1 is now Phase 2, old Phase 2 is now Phase 3, and so on. All file names use the new numbers. Do not revert to old numbering.
- **Phase 6.1 (templated stopgap) must output the same JSON schema as Phase 6.** Phase 7 must not know or care which phase produced its input.
- **Ad platform is Meta Ad Library**, not TikTok — better Lebanon/MENA data, public API, no auth headaches.
- **Alibaba**: HTTP scraping (no official API). If scraping breaks, fallback is SerpAPI (~$50/mo).
- **No UI**: Pure backend. Agent runs on schedule, writes to Notion, owner reviews Notion.

---

## Cost estimate
- Claude API: ~$10–20/week (200 products analysed, Opus pricing)
- SerpApi: free tier (100 calls/month) — sufficient for monthly Phase 0 runs
- Meta Ad Library: free
- Alibaba scraping: free (or $50/mo SerpAPI fallback)
- Notion API: free
- Hosting: $0 (runs locally)
- **Total: $10–20/week**

---

## Notes for Claude Code
- Always write clean TypeScript with proper types
- Each phase script must be runnable standalone (e.g. `npx ts-node src/phases/phase0-niches.ts`) for testing
- Log clearly at each step so the owner can see what the agent is doing
- Handle rate limiting gracefully — add delays between API calls
- Store intermediate results in /data as JSON — if a phase fails, the previous phase output is not lost
- Never hardcode API keys — always read from .env via dotenv
- When building Phase 0, Phase 0.5, or Phase 1: add a `npm run phase0`, `npm run phase0-5`, `npm run phase1` script to package.json so they can be triggered manually without touching the cron