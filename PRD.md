# PRD — Lebanon Private Label Product Research Agent

## Problem
Product research for private labeling is the most time-consuming and demoralizing part of starting an ecommerce business. Manually scrolling Meta ads, checking Alibaba, verifying margins, and researching local competition takes hours and causes analysis paralysis. This agent automates the entire research pipeline so the owner wakes up on Monday morning with a shortlist of vetted product opportunities ready to review in Notion.

## Goal
Run once per week. Analyse ~200 global Meta ads. Deliver 10–20 qualified product candidates to Notion with full analysis, supplier options, and Lebanon-specific insights.

## Pipeline overview

### Phase 1 — Meta Ad Library scraper
**What it does**: Queries Meta's public Ad Library API for active ads across product categories relevant to private labeling (health, home, beauty, fitness, lifestyle, gadgets).

**How to identify good candidates from ads**:
- Ad has been running for 30+ days (signals it's converting)
- Ad has significant reach/impressions
- Product is physical and shippable
- Product is not clothing/fashion (sizing issues for private label)
- Product is not food/consumable (customs issues for Lebanon)

**API details**:
- Endpoint: `https://graph.facebook.com/v19.0/ads_archive`
- Required params: `access_token`, `ad_type=ALL`, `ad_reached_countries`, `search_terms`
- Search in batches by keyword (e.g. "back pain", "kitchen gadget", "skin care device", "home organization")
- Store raw results in `data/ads.json`

**Output shape**:
```json
[{
  "ad_id": "string",
  "page_name": "string",
  "ad_creative_body": "string",
  "ad_delivery_start_time": "string",
  "ad_delivery_stop_time": "string | null",
  "impressions": { "lower_bound": number, "upper_bound": number },
  "spend": { "lower_bound": number, "upper_bound": number },
  "search_term_used": "string"
}]
```

### Phase 2 — Product filter + scoring (three-tier criteria)
**What it does**: For each ad keyword group, applies a three-tier private-label criteria framework. Phase 2 (Claude) and Phase 2.1 (heuristic stopgap) both use the same framework so swapping between them keeps semantics identical.

**Private label criteria framework**

**Must-have (any failure = hard reject, don't include in output)**
- Gross margin ≥ 70% before ads — `(price − landed_cost) / price * 100`
- Selling price ≥ $30
- Weight < 0.5 kg including packaging
- Has a natural repeat-purchase / reorder reason
- Evergreen demand (stable Google Trends over 5 years, no spike-crash pattern)
- Supports at least 2–3 logical cross-sells or upsells over time

**Strong (subtract 10 from score for each that's missing)**
- Top 3 competitor listings have < 300–500 reviews
- Landed cost allows a 3× markup minimum
- Clear differentiation angle (materials, formulation, bundling — not just logo swap)
- Solves a specific searchable problem (not impulse-only)
- First-order MOQ achievable under 500 units
- No dominant national brand controlling the category

**Nice to have (add 5 to score for each that applies)**
- Selling price ≥ $50
- Giftable product
- No patent or trademark conflicts
- Simple manufacturing (no electronics, food certs, or children's compliance)

**Score formula**: Start at 50 if all must-haves pass, then apply strong penalties (−10 each) and nice-to-have bonuses (+5 each). Floor at 0, cap at 100.

**Verdict thresholds**
- Score 75+: keep, flag as **Investigate**
- Score 60–74: keep, flag as **Watch**
- Score < 60 OR any must-have failed: drop entirely

**Output limit**: After filtering, sort remaining candidates by score descending and take the top 5 only. These 5 go through Phases 3, 4, 5, and 6.

**Heuristic stopgap (Phase 2.1)**: A deterministic version that uses pre-computed estimates per keyword (`src/config/keyword-estimates.ts`). It can evaluate all 6 must-haves, 2 of 6 strong items (3× markup, MOQ <500), and 3 of 4 nice-to-haves (price ≥$50, giftable, simple manufacturing). The remaining strong/nice items (competitor reviews, differentiation, problem-solving angle, dominant brand, IP/trademark) are deferred to the Claude version.

### Phase 3 — Lebanon competition check
**What it does**: For each candidate product, re-queries Meta Ad Library with `ad_reached_countries=LB` and the product name as search term. Counts active local advertisers and estimates competition level.

**Competition scoring**:
- 0 active LB advertisers: Low
- 1–3 active LB advertisers: Medium
- 4+ active LB advertisers: High

**Note**: Lebanon data on Meta can be sparse. If results are very low across the board, widen to MENA (`LB,SA,AE,EG,JO`) and note this in the output.

### Phase 4 — Alibaba supplier lookup
**What it does**: Searches Alibaba for each shortlisted product. Extracts top 5 suppliers that meet quality criteria.

**Supplier quality filter** (must meet ALL):
- Verified supplier badge
- Trade Assurance enabled
- 4.0+ star rating
- Minimum 50 reviews
- Has relevant certifications where applicable (CE, ISO, etc.)

**Scraping approach**:
- Search URL: `https://www.alibaba.com/trade/search?SearchText={product_name}&tab=supplier`
- Use axios + cheerio for HTML parsing
- Add 2–3 second delay between requests
- Rotate user-agent strings
- If blocked: log the error and skip that product (don't crash the pipeline)

**Fallback**: If scraping fails consistently, switch to SerpAPI with `engine=google_shopping` targeting alibaba.com

**Output per supplier**:
```json
{
  "supplier_name": "string",
  "stars": number,
  "review_count": number,
  "certifications": ["string"],
  "trade_assurance": boolean,
  "verified": boolean,
  "price_per_unit_usd": { "min": number, "max": number },
  "moq": number,
  "url": "string"
}
```

### Phase 5 — Claude deep analysis
**What it does**: For each product that passed Phase 3 with Low or Medium competition, runs a comprehensive Claude analysis to generate the full report content.

**Claude is given**:
- Product name and niche
- Score and criteria results
- Lebanon competition level
- Top supplier data (price, MOQ)
- Instruction to write for a Lebanese private label seller

**Claude must output** (JSON):
```json
{
  "market_analysis": "string (2–3 sentences, data-driven)",
  "cross_sells": ["string", "string", "string"],
  "objections": [
    {
      "category": "Shipping | Quality | Price | Trust",
      "customer_voice": "string (written as the customer would say it)",
      "why_it_matters_in_lebanon": "string",
      "counter": "string (concrete action for product page)"
    }
  ],
  "verdict": "string (plain language, ends with specific recommended next step)"
}
```

**Objection generation instructions for Claude**:
Always generate exactly 4 objections. Consider Lebanon-specific context:
- Unreliable postal history
- Economic pressure (Lebanese pound devaluation)
- High skepticism toward unknown online stores
- Cultural preference for cash-on-delivery and word-of-mouth trust

### Phase 6 — Notion writer + scheduler
**What it does**: Creates one Notion page per product in the owner's Notion database. Then wraps the full pipeline in a cron job.

**Notion page creation**:
- Use `@notionhq/client` SDK
- Create page with all database properties set
- Write content blocks in order: checklist, market analysis, cross-sells, objections, suppliers, verdict
- Use Notion's callout block for the verdict (makes it stand out)
- Use Notion's toggle block for each objection (keeps the page clean)

**Cron schedule**: `0 8 * * 1` (every Monday at 8:00am)

**Duplicate prevention**: Before creating a page, check if a page with the same product name already exists in the database for the current week. Skip if duplicate.

## Error handling principles
- Each phase writes its output to /data before the next phase starts
- If any phase fails mid-run, the next run picks up from the last successful checkpoint
- All errors are logged with timestamp and phase number
- Pipeline never crashes silently — always log what went wrong

## Search keyword list (Phase 1 — 2025 researched set)

Keywords grouped by niche. Agent rotates 15 keywords per run so all niches get covered over time. Start with the health + beauty groups for the first test run.

```json
[
  "red light therapy device",
  "neck traction device",
  "knee compression sleeve",
  "back posture corrector",
  "cervical neck stretcher",
  "trigger point massage tool",
  "fascia gun mini",
  "eye massager electric",
  "led face mask therapy",
  "microcurrent face lifting device",
  "ice globes face roller",
  "blackhead remover vacuum",
  "sonic facial cleanser",
  "nail care electric drill",
  "resistance loop bands set",
  "ab wheel roller core",
  "grip strength trainer",
  "acupressure mat set",
  "cold plunge portable",
  "sauna blanket infrared",
  "vacuum seal food bags",
  "over door organizer hooks",
  "drawer dividers set",
  "silicone stretch lids",
  "herb stripper kitchen tool",
  "spice rack magnetic",
  "digital kitchen scale",
  "monitor riser stand",
  "cable management clips",
  "ergonomic wrist rest",
  "laptop stand portable",
  "under desk foot rest",
  "blue light glasses",
  "desk pad leather mat",
  "compression packing cubes",
  "travel jewelry organizer",
  "portable luggage scale",
  "neck wallet rfid",
  "reusable shopping bags folding",
  "jump rope weighted"
]
```

**Rotation strategy**: Use 15 keywords per weekly run, rotating through the full list. This keeps API costs low, avoids hitting Meta rate limits, and ensures fresh product categories surface each week. After 3 weeks the full list will have been covered once.

## Running costs breakdown
| Component | Cost |
|-----------|------|
| Claude API (Opus, ~200 products Phase 2 + ~15 products Phase 5) | ~$10–20/week |
| Meta Ad Library API | Free |
| Alibaba scraping | Free |
| Notion API | Free |
| Hosting (runs locally) | $0 |
| **Total** | **$10–20/week** |

## Future improvements (v2, not now)
- Add TikTok Creative Center as second data source
- Add Instagram ad scraping for Lebanon local competitor deep-dive
- Add email/WhatsApp notification with top 3 products summary
- Make keyword list configurable via Notion config page
- Add "already ordered" tracking to avoid re-surfacing products