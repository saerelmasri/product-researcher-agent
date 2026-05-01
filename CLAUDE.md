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
    keywords.ts                # KEYWORDS_2025 search list + KEYWORDS_PER_RUN
    keyword-estimates.ts       # Phase 2.1 heuristic lookup table (price, weight, niche per keyword)
  /phases
    phase1-scraper.ts          # Meta Ad Library scraper
    phase2-filter.ts           # Claude scoring + criteria filter (needs ANTHROPIC_API_KEY)
    phase2-1-heuristic.ts      # Heuristic stopgap scorer — runs offline without Claude
    phase3-competition.ts      # Lebanon competitor check
    phase4-suppliers.ts        # Alibaba supplier lookup
    phase5-analysis.ts         # Claude deep analysis + objections (needs ANTHROPIC_API_KEY)
    phase5-1-template.ts       # Templated analysis stopgap — runs offline without Claude
    phase6-notion.ts           # Notion writer
  /types
    index.ts                   # Shared TypeScript types only (no data constants)
  /utils
    claude.ts                  # Claude API helper (Anthropic SDK wrapper)
    logger.ts                  # Simple logger
  pipeline.ts                  # Main orchestrator — runs all phases in sequence
  scheduler.ts                 # Cron job wrapper
/data
  (runtime JSON files written here — gitignored)
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
```

## Build order — IMPORTANT
Build and test one phase at a time. Never move to the next phase until the current one produces clean output.

1. **Phase 1** — Meta Ad Library scraper → outputs `data/ads.json`
2. **Phase 2** — Claude product filter + scoring → outputs `data/candidates.json`
3. **Phase 3** — Lebanon competition check → updates `data/candidates.json`
4. **Phase 4** — Alibaba supplier lookup (scraping, trickiest phase) → updates `data/candidates.json`
5. **Phase 5** — Claude deep analysis + objections → outputs `data/reports.json`
6. **Phase 6** — Notion writer + cron scheduler → final live output

## Current status
> **Update this section as you complete each phase.**
- [x] Phase 1 — Meta scraper
- [x] Phase 2 — Claude filter
- [x] Phase 2.1 — heuristic stopgap (offline test scorer; no Claude required)
- [ ] Phase 3 — Lebanon competition
- [ ] Phase 4 — Alibaba suppliers
- [ ] Phase 5 — Claude deep analysis
- [ ] Phase 5.1 — templated stopgap (offline test analyser; no Claude required)
- [ ] Phase 6 — Notion writer + cron

## Key decisions already made
- **Ad platform**: Meta Ad Library (not TikTok) — better Lebanon/MENA data, public API, no auth headaches
- **Output format**: Notion database — one row per product in list view, full page with all analysis when opened
- **Alibaba**: HTTP scraping (no official API). If scraping breaks, fallback is SerpAPI (~$50/mo)
- **Lebanon geo check**: Re-query Meta Ad Library filtered to Lebanon. High local ad spend = competition exists
- **No UI**: Pure backend. Agent runs on schedule, writes to Notion, owner reviews Notion

## Product scoring criteria (Phase 2)
Claude must score each product 0–100 and check ALL of the following:
- Selling price above $30 (ideally $50+)
- Estimated margin at least 70% before ads
- Product weight under 0.5kg
- Not seasonal or trend-dependent
- Has recurring purchase potential
- Has 2–3 cross-sell product opportunities
- Low competition in Lebanon
- Verified Alibaba suppliers exist

Products scoring below 60 are auto-filtered out. Products 60–74 are flagged "Watch". Products 75+ are flagged "Investigate".

**Output limit: maximum 5 products per weekly run.** After scoring and filtering, take only the top 5 by score. If fewer than 5 pass the threshold, output only those that passed — never pad with low-scoring products.

## Notion database schema
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

## Customer objections section — context
This was added based on the insight that finding a product is easy — understanding why Lebanese customers hesitate is harder. For each product, Claude must generate 3–4 objections a Lebanese buyer would have, written as the customer would actually say it, plus a concrete counter for each one that can be used directly on the product page.

Common objection categories for Lebanon:
- Shipping time / reliability
- Product quality doubt ("cheap Chinese plastic")
- Price sensitivity (Lebanon economic situation)
- Brand trust (unknown store)

## Cost estimate
- Claude API: ~$10–20/week (200 products analysed, Opus pricing — higher than Sonnet but better analysis quality)
- Meta Ad Library: free
- Alibaba scraping: free (or $50/mo SerpAPI fallback)
- Notion API: free
- Hosting: $0 (runs locally)
- **Total: $10–20/week**

## Notes for Claude Code
- Always write clean TypeScript with proper types
- Each phase script must be runnable standalone (e.g. `npx ts-node src/phases/phase1-scraper.ts`) for testing
- Log clearly at each step so the owner can see what the agent is doing
- Handle rate limiting gracefully — add delays between API calls
- Store intermediate results in /data as JSON — if a phase fails, the previous phase output is not lost
- Never hardcode API keys — always read from .env via dotenv