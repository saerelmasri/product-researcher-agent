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
  "You are a DTC product analyst. You evaluate brands running ads on Meta to identify private label opportunities. You analyze ONLY what is visible in the ad creative text provided — you do not estimate costs, margins, weights, or competitor data, because you cannot verify those from ads. You respond with valid JSON only — no markdown, no explanation, no code fences.";

function buildUserPrompt(brand: BrandRecord, ads: MetaAd[]): string {
  const adBodies = ads
    .map((a) => a.ad_creative_body.trim())
    .filter(Boolean)
    .join("\n---\n");

  return `Analyze this brand running ads on US Meta (Facebook/Instagram).

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
Based ONLY on what you can read in the ad creatives above, analyze this brand's product as a potential private label opportunity. Do not guess at costs, weights, margins, MOQs, supplier data, or competitor metrics — those will be verified manually later.

Return JSON in this exact schema:

{
  "product_name": "string — the specific product the brand is selling, in 2-5 words",
  "product_description": "string — one sentence describing what the product does",
  "category": "string — broad category (e.g. 'car accessories', 'home office', 'pet')",

  "stated_price": "string or null — only fill if a price is explicitly mentioned in ad copy, otherwise null. Do NOT estimate.",

  "problem_solved": "string — the specific problem the ads claim this product solves",
  "main_hook": "string — the primary angle/hook the brand leads with across their ads",
  "secondary_hooks": ["array of other angles used across ad variants, max 4"],

  "appears_generic": true | false,
  "appears_proprietary": true | false,
  "generic_vs_proprietary_reasoning": "string — one sentence explaining your call. Generic = could be sourced from many suppliers and rebranded. Proprietary = patented mechanism, unique design, or brand-specific IP.",

  "differentiation_angle": "string — what specifically makes THIS brand's version stand out in the ads (could be: hook, branding, bundle, demographic, use case). If undifferentiated, say so.",
  "differentiation_copyable": true | false,

  "single_product_brand": true | false | "unclear",
  "brand_observations": "string — what the ad copy and page name suggest about the brand (single-product store, catalog brand, lifestyle brand, etc.)",

  "private_label_fit": "high | medium | low",
  "private_label_reasoning": "string — 1-2 sentences. High = generic product, copyable angle, no IP moat. Low = proprietary mechanism, brand-dependent appeal, or strong patent/trademark signal.",

  "trend_or_evergreen": "trend | evergreen | unclear",
  "trend_evergreen_reasoning": "string — one sentence. Look for language like 'viral', 'trending', 'TikTok made me', seasonal hooks, or fad-style urgency vs. timeless problem-solving.",

  "red_flags": ["array of concerns visible in the ad copy — e.g. 'mentions FDA approval', 'patent pending language', 'celebrity endorsement', 'medical claims', 'requires certification', 'fragile product hints'. Empty array if none."],

  "creative_quality_signal": "string — brief observation on the ad copy itself: is it polished/professional, scrappy/UGC-style, or template-driven? This signals the brand's marketing maturity.",

  "notes_for_manual_review": "string — 1-2 sentences flagging anything specific you'd want a human to verify before sourcing this product. Be concrete."
}

CRITICAL RULES:
- If a field cannot be determined from the ad creatives, use null, "unclear", or an empty array as appropriate. Do NOT guess.
- Do not output any field not in the schema.
- Do not include cost, weight, margin, MOQ, or competitor data anywhere.
- Be skeptical: if ads make medical claims, mention FDA/CE/patents, or rely on celebrity faces, flag in red_flags.
- "appears_generic" and "appears_proprietary" should usually NOT both be true. If genuinely ambiguous, set both false and explain in the reasoning field.`;
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

function validateProductAnalysis(obj: unknown): obj is ProductAnalysis {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;

  const requiredStrings: (keyof ProductAnalysis)[] = [
    "product_name",
    "product_description",
    "category",
    "problem_solved",
    "main_hook",
    "generic_vs_proprietary_reasoning",
    "differentiation_angle",
    "brand_observations",
    "private_label_reasoning",
    "trend_evergreen_reasoning",
    "creative_quality_signal",
    "notes_for_manual_review",
  ];
  for (const field of requiredStrings) {
    if (typeof r[field] !== "string" || (r[field] as string).length === 0) return false;
  }

  if (r.stated_price !== null && typeof r.stated_price !== "string") return false;

  if (!Array.isArray(r.secondary_hooks) || !r.secondary_hooks.every((x) => typeof x === "string"))
    return false;
  if (!Array.isArray(r.red_flags) || !r.red_flags.every((x) => typeof x === "string"))
    return false;

  if (typeof r.appears_generic !== "boolean") return false;
  if (typeof r.appears_proprietary !== "boolean") return false;
  if (typeof r.differentiation_copyable !== "boolean") return false;

  if (
    r.single_product_brand !== true &&
    r.single_product_brand !== false &&
    r.single_product_brand !== "unclear"
  )
    return false;

  if (!["high", "medium", "low"].includes(r.private_label_fit as string)) return false;
  if (!["trend", "evergreen", "unclear"].includes(r.trend_or_evergreen as string)) return false;

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

function buildManualReviewItems(analysis: ProductAnalysis): string[] {
  const items: string[] = [];
  if (analysis.notes_for_manual_review) {
    items.push(analysis.notes_for_manual_review);
  }
  if (analysis.red_flags.length > 0) {
    items.push(`Red flags: ${analysis.red_flags.join(", ")}`);
  }
  if (analysis.appears_proprietary) {
    items.push("Appears proprietary — verify IP before sourcing");
  }
  return items;
}

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
      `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=skipped_no_text fit=null`,
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
      lebanon_competition: "Unknown",
      alibaba_suppliers: [],
      alibaba_search_url: "",
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
      `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=failed fit=null`,
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
      lebanon_competition: "Unknown",
      alibaba_suppliers: [],
      alibaba_search_url: "",
      manual_review_needed: ["Claude API call failed — retry or review manually"],
    };
  }

  const analysis = parseClaudeResponse(rawResponse, brand.page_name);

  if (!analysis) {
    log.info(
      `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=failed fit=null`,
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
      lebanon_competition: "Unknown",
      alibaba_suppliers: [],
      alibaba_search_url: "",
      manual_review_needed: ["Claude response failed validation — retry or review manually"],
    };
  }

  log.info(
    `[${index + 1}/${total}] page_name=${brand.page_name} scaling_score=${scaling_score} status=success fit=${analysis.private_label_fit}`,
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
    lebanon_competition: "Unknown",
    alibaba_suppliers: [],
    alibaba_search_url: "",
    manual_review_needed: buildManualReviewItems(analysis),
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
  const median = scores.length
    ? scores.slice().sort((a, b) => a - b)[Math.floor(scores.length / 2)]
    : 0;

  log.info("Phase 3 summary", {
    totalBrandsInput: brands.length,
    topNAnalyzed: topBrands.length,
    successes,
    failures,
    skipped,
    scalingScoreDistribution: {
      min: Math.min(...scores),
      median,
      max: Math.max(...scores),
    },
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
