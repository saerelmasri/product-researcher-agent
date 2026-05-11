import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { KEYWORD_ESTIMATES, KeywordEstimate } from "../config/keyword-estimates";
import { MetaAd, Phase1Output, Phase2Output, ProductCandidate } from "../types";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const ADS_INPUT_PATH = path.join(DATA_DIR, "ads.json");
const CANDIDATES_OUTPUT_PATH = path.join(DATA_DIR, "candidates.json");

const MIN_SCORE = 60;
const MAX_CANDIDATES = 5;
const SUSTAINED_AD_AGE_DAYS = 60;
const STRONG_REQUIREMENT_PENALTY = 10;
const NICE_TO_HAVE_BONUS = 5;
const MAX_MOQ_FOR_FIRST_ORDER = 500;

function assignVerdict(score: number): "Investigate" | "Watch" | "Skip" {
  if (score >= 75) return "Investigate";
  if (score >= 60) return "Watch";
  return "Skip";
}

function checkMustHaves(est: KeywordEstimate): string[] {
  const failures: string[] = [];
  if (est.estimated_margin_pct < 70) failures.push(`margin <70% (${est.estimated_margin_pct}%)`);
  if (est.selling_price_usd < 30) failures.push(`price <$30 ($${est.selling_price_usd})`);
  if (est.weight_kg >= 0.5) failures.push(`weight >=0.5kg (${est.weight_kg}kg)`);
  if (!est.has_recurring_purchase) failures.push("no repeat purchase reason");
  if (!est.is_evergreen) failures.push("not evergreen demand");
  if (est.cross_sell_opportunities.length < 2) failures.push("<2 cross-sells");
  return failures;
}

interface ScoreBreakdown {
  base: number;
  adBonus: number;
  ageBonus: number;
  moqPenalty: number;
  pricePremiumBonus: number;
  giftableBonus: number;
  simpleManufactureBonus: number;
  total: number;
  rationaleParts: string[];
}

export function computeHeuristicScore(ads: MetaAd[], est: KeywordEstimate): ScoreBreakdown {
  const base = 50;
  const rationaleParts: string[] = [`base ${base}`];

  const adBonus = Math.min(ads.length * 5, 20);
  if (adBonus > 0) rationaleParts.push(`${ads.length} ads (+${adBonus})`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SUSTAINED_AD_AGE_DAYS);
  const hasOldAd = ads.some((ad) => {
    if (!ad.ad_delivery_start_time) return false;
    return new Date(ad.ad_delivery_start_time) <= cutoff;
  });
  const ageBonus = hasOldAd ? 10 : 0;
  if (ageBonus > 0) rationaleParts.push(`60d+ ad age (+${ageBonus})`);

  let moqPenalty = 0;
  if (est.est_moq >= MAX_MOQ_FOR_FIRST_ORDER) {
    moqPenalty = STRONG_REQUIREMENT_PENALTY;
    rationaleParts.push(`MOQ>=${MAX_MOQ_FOR_FIRST_ORDER} (-${moqPenalty})`);
  }

  const pricePremiumBonus = est.selling_price_usd >= 50 ? NICE_TO_HAVE_BONUS : 0;
  if (pricePremiumBonus > 0) rationaleParts.push(`price>=$50 (+${pricePremiumBonus})`);

  const giftableBonus = est.is_giftable ? NICE_TO_HAVE_BONUS : 0;
  if (giftableBonus > 0) rationaleParts.push(`giftable (+${giftableBonus})`);

  const simpleManufactureBonus = est.is_simple_to_manufacture ? NICE_TO_HAVE_BONUS : 0;
  if (simpleManufactureBonus > 0) rationaleParts.push(`simple mfg (+${simpleManufactureBonus})`);

  const raw =
    base +
    adBonus +
    ageBonus -
    markupPenalty -
    moqPenalty +
    pricePremiumBonus +
    giftableBonus +
    simpleManufactureBonus;
  const total = Math.max(0, Math.min(raw, 100));

  return {
    base,
    adBonus,
    ageBonus,
    moqPenalty,
    pricePremiumBonus,
    giftableBonus,
    simpleManufactureBonus,
    total,
    rationaleParts,
  };
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

  const groups = new Map<string, MetaAd[]>();
  for (const ad of ads) {
    const key = ad.search_terms_used?.[0] ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ad);
  }

  const keywords = Array.from(groups.keys());
  log.info(`Grouped into ${keywords.length} keyword groups`, { keywords });

  let unknownKeywordCount = 0;
  let mustHaveRejectCount = 0;
  const allCandidates: Omit<ProductCandidate, "verdict">[] = [];

  for (const keyword of keywords) {
    const estimate = KEYWORD_ESTIMATES[keyword];
    if (!estimate) {
      log.warn(`No estimate for keyword "${keyword}" — skipping`);
      unknownKeywordCount++;
      continue;
    }

    const mustHaveFailures = checkMustHaves(estimate);
    if (mustHaveFailures.length > 0) {
      log.info(`Rejected "${keyword}" — must-have failures`, { failures: mustHaveFailures });
      mustHaveRejectCount++;
      continue;
    }

    const groupAds = groups.get(keyword)!;
    const breakdown = computeHeuristicScore(groupAds, estimate);

    const candidate: Omit<ProductCandidate, "verdict"> = {
      product_name: keyword,
      niche: estimate.niche,
      score: breakdown.total,
      selling_price_usd: estimate.selling_price_usd,
      estimated_margin_pct: estimate.estimated_margin_pct,
      weight_kg: estimate.weight_kg,
      lebanon_competition: "Unknown",
      has_recurring_purchase: estimate.has_recurring_purchase,
      cross_sell_opportunities: estimate.cross_sell_opportunities,
      source_ads: groupAds,
      score_rationale: `Heuristic stub (must-haves passed): ${breakdown.rationaleParts.join(" + ")} = ${breakdown.total}`,
    };

    log.info(`Scored "${keyword}"`, { score: breakdown.total });
    allCandidates.push(candidate);
  }

  const passing = allCandidates.filter((c) => c.score >= MIN_SCORE);
  const sorted = passing.sort((a, b) => b.score - a.score);
  const top: ProductCandidate[] = sorted.slice(0, MAX_CANDIDATES).map((c) => ({
    ...c,
    verdict: assignVerdict(c.score),
  }));

  log.info("Phase 2.1 summary", {
    keywordsProcessed: keywords.length,
    unknownKeywords: unknownKeywordCount,
    mustHaveRejected: mustHaveRejectCount,
    scored: allCandidates.length,
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

export { assignVerdict, checkMustHaves };
