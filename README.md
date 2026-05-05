# 🇱🇧 Lebanon Private Label Research Agent

A personal backend AI agent that runs every Monday, researches trending DTC products globally, and delivers a shortlist of vetted private-label opportunities directly into Notion — scored, analysed, and ready to act on.

---

## What it does

Scans Meta Ad Library for products gaining ad traction worldwide. Filters them against strict private-label criteria. Checks Lebanon competition. Finds Alibaba suppliers. Writes a full report per product into Notion — including Lebanon-specific customer objections and a concrete next step.

**No UI. No dashboard. Open Notion on Monday morning and your research is done.**

---

## Pipeline

Two flows. One runs manually every couple of months to refresh market directions. The other runs automatically every week.

```
Flow A — Market Discovery (manual)
──────────────────────────────────
Niche Generation → Trend Validation → Keyword Generation

Flow B — Weekly Research (automated, Monday 8am)
─────────────────────────────────────────────────
Scrape Ads → Score & Filter → Lebanon Check → Supplier Lookup → Deep Analysis → Notion
```

---

## Notion output

Each qualifying product gets its own Notion page with:

- **Score & verdict** — 0–100 score against private-label criteria, Investigate / Watch
- **Market analysis** — data-driven context on the opportunity
- **Cross-sell map** — what to bundle or upsell
- **Customer objections** — how a Lebanese buyer would actually hesitate, and how to counter it
- **Alibaba suppliers** — verified, rated, with pricing and MOQ
- **Recommended next step** — one specific action for the next 7 days

---

## Scoring criteria

Every product is evaluated against a three-tier framework.

| Tier | Criteria | Effect |
|---|---|---|
| **Must-have** | Margin ≥70%, price ≥$30, weight <0.5kg, repeat purchase, evergreen demand, cross-sell potential | Fail any → rejected immediately |
| **Strong** | Low competitor reviews, 3× markup room, differentiation angle, searchable problem, MOQ <500 units, no dominant brand | Missing → −10 pts each |
| **Nice-to-have** | Price ≥$50, giftable, no IP conflicts, simple manufacturing | Present → +5 pts each |

---

## Stack

| Layer | Tool |
|---|---|
| Language | TypeScript / Node.js |
| AI | Anthropic Claude (Sonnet for scoring, Opus for deep analysis) |
| Ad data | Meta Ad Library API |
| Trend validation | SerpApi — Google Trends |
| Supplier data | Alibaba |
| Output | Notion API |
| Scheduler | node-cron |

---

## Running cost

~$0.65 per weekly run. $20 in API credits lasts roughly 6 months.
