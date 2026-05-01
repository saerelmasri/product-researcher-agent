import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { MetaAd, Phase1Output, Phase2Output, ProductCandidate } from "../types";
import { KEYWORD_ESTIMATES } from "../data/keyword-estimates";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const ADS_INPUT_PATH = path.join(DATA_DIR, "ads.json");
const CANDIDATES_OUTPUT_PATH = path.join(DATA_DIR, "candidates.json");

const MIN_SCORE = 60;
const MAX_CANDIDATES = 5;
const NICHE_BONUS_SET = new Set(["health", "fitness", "office", "home"]);
// Ads 60+ days old signal sustained spend, not just a test campaign
const SUSTAINED_AD_AGE_DAYS = 60;

function assignVerdict(score: number): "Investigate" | "Watch" | "Skip" {
  if (score >= 75) return "Investigate";
  if (score >= 60) return "Watch";
  return "Skip";
}

interface ScoreBreakdown {
  base: number;
  adBonus: number;
  ageBonus: number;
  nicheBonus: number;
  priceBonus: number;
  weightBonus: number;
  recurringBonus: number;
  total: number;
}

export function computeHeuristicScore(
  ads: MetaAd[],
  niche: string,
  selling_price_usd: number,
  weight_kg: number,
  has_recurring_purchase: boolean,
): ScoreBreakdown {
  const base = 50;

  // +5 per ad, capped at +20
  const adBonus = Math.min(ads.length * 5, 20);

  // +10 if any ad has been running for 60+ days (sustained spend signals real demand)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SUSTAINED_AD_AGE_DAYS);
  const hasOldAd = ads.some((ad) => {
    if (!ad.ad_delivery_start_time) return false;
    return new Date(ad.ad_delivery_start_time) <= cutoff;
  });
  const ageBonus = hasOldAd ? 10 : 0;

  const nicheBonus = NICHE_BONUS_SET.has(niche) ? 5 : 0;
  const priceBonus = selling_price_usd >= 50 ? 5 : 0;
  const weightBonus = weight_kg <= 0.3 ? 5 : 0;
  const recurringBonus = has_recurring_purchase ? 5 : 0;

  const total = Math.min(
    base + adBonus + ageBonus + nicheBonus + priceBonus + weightBonus + recurringBonus,
    100,
  );

  return { base, adBonus, ageBonus, nicheBonus, priceBonus, weightBonus, recurringBonus, total };
}

function formatRationale(keyword: string, breakdown: ScoreBreakdown): string {
  const parts: string[] = [`base ${breakdown.base}`];
  if (breakdown.adBonus > 0) parts.push(`${breakdown.adBonus / 5} ads (+${breakdown.adBonus})`);
  if (breakdown.ageBonus > 0) parts.push(`60d age (+${breakdown.ageBonus})`);
  if (breakdown.nicheBonus > 0) parts.push(`niche bonus (+${breakdown.nicheBonus})`);
  if (breakdown.priceBonus > 0) parts.push(`price ≥$50 (+${breakdown.priceBonus})`);
  if (breakdown.weightBonus > 0) parts.push(`weight ≤0.3kg (+${breakdown.weightBonus})`);
  if (breakdown.recurringBonus > 0) parts.push(`recurring (+${breakdown.recurringBonus})`);
  return `Heuristic stub: ${parts.join(" + ")} = ${breakdown.total}`;
}

async function main(): Promise<void> {
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

  log.info("Phase 2.1 (heuristic) starting", { totalAds: ads.length });

  // Group ads by search_term_used
  const groups = new Map<string, MetaAd[]>();
  for (const ad of ads) {
    const key = ad.search_term_used ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ad);
  }

  const keywords = Array.from(groups.keys());
  log.info(`Grouped into ${keywords.length} keyword groups`, { keywords });

  let skippedCount = 0;
  const allCandidates: Omit<ProductCandidate, "verdict">[] = [];

  for (const keyword of keywords) {
    const estimate = KEYWORD_ESTIMATES[keyword];
    if (!estimate) {
      log.warn(`No estimate for keyword "${keyword}" — skipping`);
      skippedCount++;
      continue;
    }

    const groupAds = groups.get(keyword)!;
    const breakdown = computeHeuristicScore(
      groupAds,
      estimate.niche,
      estimate.selling_price_usd,
      estimate.weight_kg,
      estimate.has_recurring_purchase,
    );

    const candidate: Omit<ProductCandidate, "verdict"> = {
      product_name: keyword,
      niche: estimate.niche,
      score: breakdown.total,
      selling_price_usd: estimate.selling_price_usd,
      alibaba_cost_range: estimate.alibaba_cost_range,
      estimated_margin_pct: estimate.estimated_margin_pct,
      weight_kg: estimate.weight_kg,
      lebanon_competition: "Unknown",
      has_recurring_purchase: estimate.has_recurring_purchase,
      cross_sell_opportunities: estimate.cross_sell_opportunities,
      source_ads: groupAds,
      alibaba_suppliers: [],
      score_rationale: formatRationale(keyword, breakdown),
    };

    log.info(`Scored "${keyword}"`, { score: breakdown.total });
    allCandidates.push(candidate);
  }

  // Filter, sort, cap, then assign verdicts
  const passing = allCandidates.filter((c) => c.score >= MIN_SCORE);
  const sorted = passing.sort((a, b) => b.score - a.score);
  const top: ProductCandidate[] = sorted.slice(0, MAX_CANDIDATES).map((c) => ({
    ...c,
    verdict: assignVerdict(c.score),
  }));

  log.info("Phase 2.1 summary", {
    keywordsProcessed: keywords.length,
    keywordsSkipped: skippedCount,
    passedThreshold: passing.length,
    written: top.length,
  });

  if (top.length === 0) {
    log.warn(
      `No products scored >= ${MIN_SCORE}. Candidates file will be empty. Consider reviewing ad quality or scoring criteria.`,
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const output: Phase2Output = top;
  fs.writeFileSync(CANDIDATES_OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Wrote ${top.length} candidates to ${CANDIDATES_OUTPUT_PATH}`);

  if (top.length > 0) {
    log.info("Top candidates:");
    top.forEach((c, idx) => {
      log.info(`  ${idx + 1}. ${c.product_name} — score ${c.score} (${c.verdict})`);
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 2.1 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export { assignVerdict };
