import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { MetaAd, Phase1Output, Phase2Output, ProductCandidate } from "../types";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const ADS_INPUT_PATH = path.join(DATA_DIR, "ads.json");
const CANDIDATES_OUTPUT_PATH = path.join(DATA_DIR, "candidates.json");

const MIN_SCORE = 60;
const MAX_CANDIDATES = 5;
const BETWEEN_CALLS_DELAY_MS = 1500;

const SYSTEM_PROMPT =
  "You are a product research analyst specializing in identifying private label opportunities for the Lebanese market. You evaluate products based on specific criteria and always respond with valid JSON only — no markdown, no explanation.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUserPrompt(keyword: string, ads: MetaAd[]): string {
  const adBodies = ads
    .map((a) => a.ad_creative_body.trim())
    .filter(Boolean)
    .join("\n---\n");

  return `Analyze this product for private label potential in Lebanon. The product was identified from this ad keyword: "${keyword}"

Here are ${ads.length} ads for this product:
${adBodies}

Score this product 0-100 against these criteria:
- Selling price above $30 (ideally $50+) [required]
- Estimated gross margin ≥70% before ad spend [required]
- Weight under 0.5kg (affects shipping cost to Lebanon) [required]
- Not seasonal or trend-dependent [required]
- Has recurring purchase potential [bonus]
- Has 2-3 cross-sell product opportunities [bonus]

Products scoring below 60 are not viable for Lebanon private labeling.

Respond with ONLY this JSON (no markdown):
{
  "product_name": "specific product name",
  "niche": "health/fitness/home/office/travel/other",
  "score": 0-100,
  "selling_price_usd": estimated retail price in USD,
  "alibaba_cost_range": "estimated range e.g. $3-8",
  "estimated_margin_pct": estimated margin as integer 0-100,
  "weight_kg": estimated weight as decimal,
  "has_recurring_purchase": true/false,
  "cross_sell_opportunities": ["item1", "item2"],
  "score_rationale": "2-3 sentence explanation"
}`;
}

interface ClaudeProductResponse {
  product_name: string;
  niche: string;
  score: number;
  selling_price_usd: number;
  alibaba_cost_range: string;
  estimated_margin_pct: number;
  weight_kg: number;
  has_recurring_purchase: boolean;
  cross_sell_opportunities: string[];
  score_rationale: string;
}

function parseClaudeResponse(raw: string, keyword: string): ClaudeProductResponse | null {
  try {
    // Strip markdown code fences if Claude adds them despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as ClaudeProductResponse;
    return parsed;
  } catch (err) {
    log.warn(`Failed to parse Claude response for keyword "${keyword}"`, {
      error: (err as Error).message,
      raw: raw.slice(0, 200),
    });
    return null;
  }
}

function assignVerdict(score: number): "Investigate" | "Watch" | "Skip" {
  if (score >= 75) return "Investigate";
  if (score >= 60) return "Watch";
  return "Skip";
}

async function scoreProductGroup(
  keyword: string,
  ads: MetaAd[],
  askClaude: (prompt: string, systemPrompt?: string) => Promise<string>,
): Promise<ProductCandidate | null> {
  log.info(`Scoring keyword group: "${keyword}"`, { adCount: ads.length });

  const prompt = buildUserPrompt(keyword, ads);
  let rawResponse: string;

  try {
    rawResponse = await askClaude(prompt, SYSTEM_PROMPT);
  } catch (err) {
    log.warn(`Claude call failed for keyword "${keyword}"`, {
      error: (err as Error).message,
    });
    return null;
  }

  const parsed = parseClaudeResponse(rawResponse, keyword);
  if (!parsed) return null;

  const candidate: ProductCandidate = {
    product_name: parsed.product_name,
    niche: parsed.niche,
    score: parsed.score,
    verdict: assignVerdict(parsed.score),
    selling_price_usd: parsed.selling_price_usd,
    alibaba_cost_range: parsed.alibaba_cost_range,
    estimated_margin_pct: parsed.estimated_margin_pct,
    weight_kg: parsed.weight_kg,
    lebanon_competition: "Unknown",
    has_recurring_purchase: parsed.has_recurring_purchase,
    cross_sell_opportunities: parsed.cross_sell_opportunities,
    source_ads: ads,
    alibaba_suppliers: [],
    score_rationale: parsed.score_rationale,
  };

  log.info(`Scored "${parsed.product_name}"`, {
    score: parsed.score,
    verdict: candidate.verdict,
  });

  return candidate;
}

async function main(): Promise<void> {
  // Check API key before attempting to load the Claude module (which throws at import time if missing)
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error(
      "Skipping product scoring — API key not set. Set ANTHROPIC_API_KEY when you have credits.",
    );
    process.exit(1);
  }

  // Dynamically import askClaude after the key check to avoid the module-level throw
  const { askClaude } = await import("../utils/claude");

  // Load ads.json
  if (!fs.existsSync(ADS_INPUT_PATH)) {
    log.error(`data/ads.json not found at ${ADS_INPUT_PATH}. Run Phase 1 first.`);
    process.exit(1);
  }

  let ads: Phase1Output;
  try {
    const raw = fs.readFileSync(ADS_INPUT_PATH, "utf-8");
    ads = JSON.parse(raw) as Phase1Output;
  } catch (err) {
    log.error("Failed to parse data/ads.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(ads) || ads.length === 0) {
    log.error("data/ads.json is empty or not an array. Run Phase 1 first.");
    process.exit(1);
  }

  log.info(`Phase 2 starting`, { totalAds: ads.length });

  // Group ads by search_term_used
  const groups = new Map<string, MetaAd[]>();
  for (const ad of ads) {
    const key = ad.search_term_used ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ad);
  }

  const keywords = Array.from(groups.keys());
  log.info(`Grouped into ${keywords.length} keyword groups`, { keywords });

  // Score each group via Claude
  const allCandidates: ProductCandidate[] = [];

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    const groupAds = groups.get(keyword)!;

    const candidate = await scoreProductGroup(keyword, groupAds, askClaude);
    if (candidate) {
      allCandidates.push(candidate);
    }

    // Delay between Claude calls (skip delay after the last call)
    if (i < keywords.length - 1) {
      await sleep(BETWEEN_CALLS_DELAY_MS);
    }
  }

  // Filter, sort, and cap results
  const passing = allCandidates.filter((c) => c.score >= MIN_SCORE);
  const sorted = passing.sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, MAX_CANDIDATES);

  log.info("Phase 2 summary", {
    groupsProcessed: keywords.length,
    totalScored: allCandidates.length,
    passedThreshold: passing.length,
    written: top.length,
  });

  if (top.length === 0) {
    log.warn(
      `No products scored >= ${MIN_SCORE}. Candidates file will be empty. Consider reviewing ad quality or scoring criteria.`,
    );
  }

  // Write output
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const output: Phase2Output = top;
  fs.writeFileSync(CANDIDATES_OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Wrote ${top.length} candidates to ${CANDIDATES_OUTPUT_PATH}`);

  // Print a brief table of results
  if (top.length > 0) {
    log.info("Top candidates:");
    top.forEach((c, idx) => {
      log.info(`  ${idx + 1}. ${c.product_name} — score ${c.score} (${c.verdict})`);
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 2 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export { buildUserPrompt, assignVerdict, scoreProductGroup };
