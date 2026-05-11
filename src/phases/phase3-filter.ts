import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import {
  BrandRecord,
  MetaAd,
  Phase2Output,
  ProductAnalysis,
  ProductCandidate,
  ScalingBreakdown,
} from "../types";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const BRANDS_INPUT_PATH = path.join(DATA_DIR, "brands.json");
const ADS_INPUT_PATH = path.join(DATA_DIR, "ads.json");
const CANDIDATES_OUTPUT_PATH = path.join(DATA_DIR, "candidates.json");

const TOP_N_BRANDS_TO_ANALYZE = 30;
const PARALLEL_BATCH_SIZE = 5;
const SCALING_SCORE_FORMULA_VERSION = "v1";

// ── Prompts ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a DTC product research analyst with deep knowledge of e-commerce, private label, and DTC marketing. You analyze brands running ads on Meta to assess whether their products represent strong private label opportunities.\n\nYou analyze ONLY what is visible in the ad creative provided, plus your general knowledge of category-level economics. When estimating things you can't verify (costs, margins), you provide category-level ranges with explicit confidence levels — never fabricate precise numbers.\n\nYou distinguish between brands that are TESTING (running many short-lived ads, frequent variant changes, discount-heavy copy) and brands that are SCALING (consistent ad longevity, confident positioning, social proof). Real winners look like scaling, not testing.\n\nYou respond with valid JSON only — no markdown, no explanation, no code fences.";

function buildUserPrompt(brand: BrandRecord, ads: MetaAd[]): string {
  const adBodies = ads
    .map((a) => a.ad_creative_body.trim())
    .filter(Boolean)
    .join("\n---\n");

  return `Analyze this brand running ads on US Meta (Facebook/Instagram) as a potential private label opportunity.

BRAND CONTEXT:
- Page name: ${brand.page_name}
- Total ads in dataset: ${brand.ad_count}
- Active ads: ${brand.active_ad_count}
- Longest-running ad: ${brand.max_days_running} days
- Average ad longevity: ${brand.avg_days_running} days
- Niches this brand was surfaced under: ${brand.niches_hit.join(", ") || "unknown"}

AD CREATIVES (each separated by ---):
${adBodies}

YOUR TASK:
Based on what you can read in the ad creatives plus your general category knowledge, produce a research brief on this brand's product. Do not fabricate precise costs, weights, or competitor data. For category-level economics, give ranges with explicit confidence.

Return JSON in this exact schema:

{
  "identification": {
    "product_name": "string — 2-5 words",
    "product_description": "string — one sentence",
    "category": "string — broad category",
    "appears_generic": true | false,
    "appears_proprietary": true | false,
    "generic_vs_proprietary_reasoning": "one sentence"
  },

  "winning_product_assessment": {
    "verdict": "strong_winner | likely_winner | testing | weak_signal",
    "verdict_reasoning": "2-3 sentences",
    "scaling_signal_quality": "high | medium | low",
    "scaling_signal_reasoning": "is this real PMF or heavy testing?",
    "durability_assessment": "evergreen | seasonal | trend | fad",
    "durability_reasoning": "one sentence",
    "confidence_signals": ["signs the brand is winning"],
    "concern_signals": ["red/yellow flags visible in copy"]
  },

  "product_intelligence": {
    "problems_solved": ["primary problem", "secondary", "..."],
    "audience_segments": ["who this is sold to"],
    "emotional_drivers": ["emotions the ads trigger"],
    "positioning_angles": [
      {"angle": "string", "example_from_ad": "string"}
    ],
    "main_hook": "string",
    "secondary_hooks": ["array, max 4"],
    "creative_directions": ["formats that seem to work — UGC, demos, etc."],
    "differentiation_angle": "string",
    "differentiation_copyable": true | false,
    "market_introduction_ideas": [
      "1-2 sentence ideas for how a new private label brand could enter this market"
    ]
  },

  "economics_estimate": {
    "stated_price_in_ads": "string or null — only if explicitly stated, do NOT estimate",
    "category_cost_range_usd": "string — e.g. '$2-5'",
    "category_shipping_range_usd": "string — e.g. '$1-3'",
    "confidence": "high | medium | low",
    "based_on": "string — e.g. 'category-level averages for [category]'",
    "margin_universe_check": "string — if priced at $X with typical landed cost $Y, margin lands around Z%",
    "viable_for_private_label": true | false | "depends_on_sourcing"
  },

  "manual_review_needed": ["specific things a human should verify before sourcing"]
}

CRITICAL RULES:
- If a field cannot be determined, use null, "unclear", or empty array. Do NOT guess.
- Do not output fields not in the schema.
- For economics_estimate, give category-level ranges with confidence — never fabricate precise product-specific numbers.
- "appears_generic" and "appears_proprietary" should usually NOT both be true. If genuinely ambiguous, set both false and explain.`;
}

// ── Scaling score ──────────────────────────────────────────────────────────────

function computeScalingScore(brand: BrandRecord): {
  score: number;
  breakdown: ScalingBreakdown;
} {
  const raw =
    brand.active_ad_count * 2 +
    brand.max_days_running * 0.5 +
    brand.ad_count * 1;
  const score = Math.min(100, Math.round(raw));
  return {
    score,
    breakdown: {
      active_ad_count: brand.active_ad_count,
      max_days_running: brand.max_days_running,
      ad_count: brand.ad_count,
      formula_version: SCALING_SCORE_FORMULA_VERSION,
    },
  };
}

// ── Response parsing & validation ─────────────────────────────────────────────

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && (v as unknown[]).every((x) => typeof x === "string");
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

function validateProductAnalysis(obj: unknown): obj is ProductAnalysis {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;

  // identification
  const id = r.identification as Record<string, unknown> | undefined;
  if (typeof id !== "object" || id === null) return false;
  if (!isNonEmptyString(id.product_name)) return false;
  if (!isNonEmptyString(id.product_description)) return false;
  if (!isNonEmptyString(id.category)) return false;
  if (typeof id.appears_generic !== "boolean") return false;
  if (typeof id.appears_proprietary !== "boolean") return false;
  if (!isNonEmptyString(id.generic_vs_proprietary_reasoning)) return false;

  // winning_product_assessment
  const wpa = r.winning_product_assessment as Record<string, unknown> | undefined;
  if (typeof wpa !== "object" || wpa === null) return false;
  if (!["strong_winner", "likely_winner", "testing", "weak_signal"].includes(wpa.verdict as string)) return false;
  if (!isNonEmptyString(wpa.verdict_reasoning)) return false;
  if (!["high", "medium", "low"].includes(wpa.scaling_signal_quality as string)) return false;
  if (!isNonEmptyString(wpa.scaling_signal_reasoning)) return false;
  if (!["evergreen", "seasonal", "trend", "fad"].includes(wpa.durability_assessment as string)) return false;
  if (!isNonEmptyString(wpa.durability_reasoning)) return false;
  if (!isStringArray(wpa.confidence_signals)) return false;
  if (!isStringArray(wpa.concern_signals)) return false;

  // product_intelligence
  const pi = r.product_intelligence as Record<string, unknown> | undefined;
  if (typeof pi !== "object" || pi === null) return false;
  if (!isStringArray(pi.problems_solved)) return false;
  if (!isStringArray(pi.audience_segments)) return false;
  if (!isStringArray(pi.emotional_drivers)) return false;
  if (
    !Array.isArray(pi.positioning_angles) ||
    !(pi.positioning_angles as unknown[]).every(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        isNonEmptyString((a as Record<string, unknown>).angle) &&
        isNonEmptyString((a as Record<string, unknown>).example_from_ad),
    )
  )
    return false;
  if (!isNonEmptyString(pi.main_hook)) return false;
  if (!isStringArray(pi.secondary_hooks)) return false;
  if (!isStringArray(pi.creative_directions)) return false;
  if (!isNonEmptyString(pi.differentiation_angle)) return false;
  if (typeof pi.differentiation_copyable !== "boolean") return false;
  if (!isStringArray(pi.market_introduction_ideas)) return false;

  // economics_estimate
  const eco = r.economics_estimate as Record<string, unknown> | undefined;
  if (typeof eco !== "object" || eco === null) return false;
  if (eco.stated_price_in_ads !== null && typeof eco.stated_price_in_ads !== "string") return false;
  if (!isNonEmptyString(eco.category_cost_range_usd)) return false;
  if (!isNonEmptyString(eco.category_shipping_range_usd)) return false;
  if (!["high", "medium", "low"].includes(eco.confidence as string)) return false;
  if (!isNonEmptyString(eco.based_on)) return false;
  if (!isNonEmptyString(eco.margin_universe_check)) return false;
  if (
    eco.viable_for_private_label !== true &&
    eco.viable_for_private_label !== false &&
    eco.viable_for_private_label !== "depends_on_sourcing"
  )
    return false;

  // manual_review_needed
  if (!isStringArray(r.manual_review_needed)) return false;

  return true;
}

function parseClaudeResponse(raw: string, pageName: string): ProductAnalysis | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (!validateProductAnalysis(parsed)) {
      log.warn(`Response for "${pageName}" failed schema validation`, {
        keys: typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [],
      });
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`Failed to parse Claude response for "${pageName}"`, {
      error: (err as Error).message,
      raw: raw.slice(0, 200),
    });
    return null;
  }
}

// ── Per-brand analysis ─────────────────────────────────────────────────────────

async function analyzeBrand(
  brand: BrandRecord,
  index: number,
  total: number,
  adMap: Map<string, MetaAd>,
  { scaling_score, scaling_breakdown }: { scaling_score: number; scaling_breakdown: ScalingBreakdown },
  askClaude: (prompt: string, systemPrompt?: string) => Promise<string>,
): Promise<ProductCandidate> {
  const brandAds = brand.ad_ids
    .map((id) => adMap.get(id))
    .filter((a): a is MetaAd => a !== undefined && a.has_creative_text);

  if (brandAds.length === 0) {
    log.info(
      `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=skipped_no_text verdict=null`,
    );
    return {
      page_id: brand.page_id,
      page_name: brand.page_name,
      ad_count: brand.ad_count,
      active_ad_count: brand.active_ad_count,
      avg_days_running: brand.avg_days_running,
      max_days_running: brand.max_days_running,
      niches_hit: brand.niches_hit,
      keywords_hit: brand.keywords_hit,
      scaling_score,
      scaling_breakdown,
      product_analysis: null,
      analysis_status: "skipped_no_text",
      source_ad_ids: brand.ad_ids,
      lebanon_competition: null,

      manual_review_needed: ["No ad text available — analysis skipped"],
    };
  }

  const prompt = buildUserPrompt(brand, brandAds);
  let rawResponse: string;

  try {
    rawResponse = await askClaude(prompt, SYSTEM_PROMPT);
  } catch (err) {
    log.warn(`Claude call failed for "${brand.page_name}"`, {
      error: (err as Error).message,
    });
    log.info(
      `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=failed verdict=null`,
    );
    return {
      page_id: brand.page_id,
      page_name: brand.page_name,
      ad_count: brand.ad_count,
      active_ad_count: brand.active_ad_count,
      avg_days_running: brand.avg_days_running,
      max_days_running: brand.max_days_running,
      niches_hit: brand.niches_hit,
      keywords_hit: brand.keywords_hit,
      scaling_score,
      scaling_breakdown,
      product_analysis: null,
      analysis_status: "failed",
      source_ad_ids: brand.ad_ids,
      lebanon_competition: null,

      manual_review_needed: ["Claude API call failed — retry or review manually"],
    };
  }

  const analysis = parseClaudeResponse(rawResponse, brand.page_name);

  if (!analysis) {
    log.info(
      `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=failed verdict=null`,
    );
    return {
      page_id: brand.page_id,
      page_name: brand.page_name,
      ad_count: brand.ad_count,
      active_ad_count: brand.active_ad_count,
      avg_days_running: brand.avg_days_running,
      max_days_running: brand.max_days_running,
      niches_hit: brand.niches_hit,
      keywords_hit: brand.keywords_hit,
      scaling_score,
      scaling_breakdown,
      product_analysis: null,
      analysis_status: "failed",
      source_ad_ids: brand.ad_ids,
      lebanon_competition: null,

      manual_review_needed: ["Claude response failed validation — retry or review manually"],
    };
  }

  const fit = analysis.winning_product_assessment.verdict;
  log.info(
    `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=success verdict=${fit}`,
  );

  return {
    page_id: brand.page_id,
    page_name: brand.page_name,
    ad_count: brand.ad_count,
    active_ad_count: brand.active_ad_count,
    avg_days_running: brand.avg_days_running,
    max_days_running: brand.max_days_running,
    niches_hit: brand.niches_hit,
    keywords_hit: brand.keywords_hit,
    scaling_score,
    scaling_breakdown,
    product_analysis: analysis,
    analysis_status: "success",
    source_ad_ids: brand.ad_ids,
    lebanon_competition: null,
    manual_review_needed: analysis.manual_review_needed,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error(
      "Skipping product analysis — ANTHROPIC_API_KEY not set.",
    );
    process.exit(1);
  }

  const { askClaude } = await import("../utils/claude");

  // Load inputs
  if (!fs.existsSync(BRANDS_INPUT_PATH)) {
    log.error(`data/brands.json not found. Run Phase 2 first.`);
    process.exit(1);
  }
  if (!fs.existsSync(ADS_INPUT_PATH)) {
    log.error(`data/ads.json not found. Run Phase 2 first.`);
    process.exit(1);
  }

  let brands: BrandRecord[];
  let adsFlat: MetaAd[];
  try {
    brands = JSON.parse(fs.readFileSync(BRANDS_INPUT_PATH, "utf-8")) as BrandRecord[];
    adsFlat = JSON.parse(fs.readFileSync(ADS_INPUT_PATH, "utf-8")) as MetaAd[];
  } catch (err) {
    log.error("Failed to parse input files", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(brands) || brands.length === 0) {
    log.error("data/brands.json is empty. Run Phase 2 first.");
    process.exit(1);
  }
  if (!Array.isArray(adsFlat) || adsFlat.length === 0) {
    log.error("data/ads.json is empty. Run Phase 2 first.");
    process.exit(1);
  }

  // Build ad lookup map
  const adMap = new Map<string, MetaAd>();
  for (const ad of adsFlat) {
    adMap.set(ad.ad_id, ad);
  }

  log.info("Phase 3 starting", {
    totalBrands: brands.length,
    totalAds: adsFlat.length,
    topNToAnalyze: TOP_N_BRANDS_TO_ANALYZE,
  });

  // Score, sort, slice
  const scored = brands.map((brand) => ({
    brand,
    ...computeScalingScore(brand),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topBrands = scored.slice(0, TOP_N_BRANDS_TO_ANALYZE);

  log.info(`Analyzing top ${topBrands.length} brands by scaling_score`, {
    scoreRange: `${topBrands.at(-1)?.score ?? 0}–${topBrands[0]?.score ?? 0}`,
  });

  // Parallel batch analysis
  const candidates: ProductCandidate[] = [];

  for (let i = 0; i < topBrands.length; i += PARALLEL_BATCH_SIZE) {
    const batch = topBrands.slice(i, i + PARALLEL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(({ brand, score, breakdown }, j) =>
        analyzeBrand(
          brand,
          i + j,
          topBrands.length,
          adMap,
          { scaling_score: score, scaling_breakdown: breakdown },
          askClaude,
        ),
      ),
    );
    candidates.push(...results);
  }

  // Sort output by scaling_score descending
  candidates.sort((a, b) => b.scaling_score - a.scaling_score);

  // Summary stats
  const successes = candidates.filter((c) => c.analysis_status === "success").length;
  const failures = candidates.filter((c) => c.analysis_status === "failed").length;
  const skipped = candidates.filter((c) => c.analysis_status === "skipped_no_text").length;
  const scores = candidates.map((c) => c.scaling_score);
  const sortedScores = scores.slice().sort((a, b) => a - b);
  const median = sortedScores.length ? sortedScores[Math.floor(sortedScores.length / 2)] : 0;

  const verdictCounts = { strong_winner: 0, likely_winner: 0, testing: 0, weak_signal: 0 };
  for (const c of candidates) {
    const v = c.product_analysis?.winning_product_assessment.verdict;
    if (v && v in verdictCounts) verdictCounts[v]++;
  }

  log.info("Phase 3 summary", {
    totalBrandsInput: brands.length,
    topNAnalyzed: topBrands.length,
    successes,
    failures,
    skipped,
    scalingScoreDistribution: {
      min: sortedScores[0] ?? 0,
      median,
      max: sortedScores.at(-1) ?? 0,
    },
    verdictDistribution: verdictCounts,
  });

  // Write output
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const output: Phase2Output = candidates;
  fs.writeFileSync(CANDIDATES_OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Wrote ${candidates.length} candidates to ${CANDIDATES_OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 3 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export { buildUserPrompt, computeScalingScore, validateProductAnalysis, analyzeBrand };
