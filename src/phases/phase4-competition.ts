import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import {
  BrandCompetitor,
  CompetitionLevel,
  LebanonCompetition,
  MetaAdLibraryRawAd,
  ProductCandidate,
} from "../types";
import { log } from "../utils/logger";
import { fetchAdsForKeyword } from "./phase2-scraper";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const CANDIDATES_INPUT_PATH = path.join(DATA_DIR, "candidates.json");
const ENRICHED_OUTPUT_PATH = path.join(DATA_DIR, "candidates-with-competition.json");

const LEBANON_COUNTRIES = ["LB"];
const PARALLEL_BATCH_SIZE = 5;
const SERIOUS_COMPETITOR_DAYS_THRESHOLD = 30;
const THRESHOLDS_VERSION = "v1";
const MAX_PAGES_PER_QUERY = 2;
const SIGNALS_NOTE = "Based on Meta Ad Library, English queries only, Lebanon-targeted ads only";

function loadTokenOrExit(): string {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) {
    log.error("META_ACCESS_TOKEN is missing. Phase 4 needs the same Meta token as Phase 2.");
    process.exit(1);
  }
  return token;
}

// ── Query building ─────────────────────────────────────────────────────────────

function buildSearchQueries(candidate: ProductCandidate): string[] {
  const productName = candidate.product_analysis?.identification.product_name;
  const category = candidate.product_analysis?.identification.category;
  const mainHook = candidate.product_analysis?.product_intelligence.main_hook;

  const hookWords = mainHook?.split(/\s+/) ?? [];
  const shortHook = hookWords.length <= 4 ? mainHook : undefined;

  return [productName, category, shortHook]
    .filter((q): q is string => typeof q === "string" && q.length > 0 && q.length <= 50);
}

function buildManualCheckUrl(candidate: ProductCandidate): string {
  const productTerm =
    candidate.product_analysis?.identification.product_name ?? candidate.page_name;
  return `https://www.facebook.com/ads/library/?country=LB&q=${encodeURIComponent(productTerm)}&active_status=all`;
}

// ── Fetch + merge Lebanon ads ─────────────────────────────────────────────────

async function fetchMergedLebanonAds(
  queries: string[],
  token: string,
): Promise<{ ads: MetaAdLibraryRawAd[]; allFailed: boolean }> {
  const allAds: MetaAdLibraryRawAd[] = [];
  let successCount = 0;

  for (const query of queries) {
    try {
      const { ads } = await fetchAdsForKeyword(query, token, LEBANON_COUNTRIES, MAX_PAGES_PER_QUERY);
      allAds.push(...ads);
      successCount++;
    } catch (err) {
      log.warn(`Lebanon query failed for "${query}"`, {
        error: (err as Error).message,
      });
    }
  }

  // Dedupe by page_id across all queries
  const seen = new Set<string>();
  const deduped = allAds.filter((ad) => {
    const id = ad.page_id;
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return { ads: deduped, allFailed: successCount === 0 };
}

// ── Competitor aggregation ────────────────────────────────────────────────────

function computeDaysRunning(
  startTime: string | undefined,
  stopTime: string | undefined,
  now: Date,
): number {
  if (!startTime) return 0;
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return 0;
  const end = stopTime ? new Date(stopTime) : now;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function aggregateCompetitors(ads: MetaAdLibraryRawAd[], now: Date): BrandCompetitor[] {
  const byPageId = new Map<string, MetaAdLibraryRawAd[]>();

  for (const ad of ads) {
    if (!ad.page_id) continue;
    if (!byPageId.has(ad.page_id)) byPageId.set(ad.page_id, []);
    byPageId.get(ad.page_id)!.push(ad);
  }

  const competitors: BrandCompetitor[] = [];

  for (const [page_id, pageAds] of byPageId) {
    const page_name = pageAds[0].page_name ?? "";
    let active_ad_count = 0;
    let max_days_running = 0;
    let earliest_start: Date | null = null;
    let latest_end: Date | null = null;
    let sample_ad_url = "";

    for (const ad of pageAds) {
      const isActive = !ad.ad_delivery_stop_time;
      if (isActive) active_ad_count++;

      const days = computeDaysRunning(ad.ad_delivery_start_time, ad.ad_delivery_stop_time, now);
      if (days > max_days_running) max_days_running = days;

      if (ad.ad_delivery_start_time) {
        const start = new Date(ad.ad_delivery_start_time);
        if (!earliest_start || start < earliest_start) earliest_start = start;
      }

      const endDate = ad.ad_delivery_stop_time ? new Date(ad.ad_delivery_stop_time) : now;
      if (!latest_end || endDate > latest_end) latest_end = endDate;

      if (!sample_ad_url && ad.ad_snapshot_url) sample_ad_url = ad.ad_snapshot_url;
    }

    competitors.push({
      page_id,
      page_name,
      ad_count: pageAds.length,
      active_ad_count,
      max_days_running,
      first_seen: (earliest_start ?? now).toISOString(),
      last_seen: (latest_end ?? now).toISOString(),
      sample_ad_url,
    });
  }

  return competitors;
}

// ── Classification ────────────────────────────────────────────────────────────

function classifyCompetition(
  competitors: BrandCompetitor[],
  allFailed: boolean,
): CompetitionLevel {
  if (allFailed) return "Unknown";

  const total = competitors.length;
  const serious = competitors.filter(
    (c) => c.max_days_running >= SERIOUS_COMPETITOR_DAYS_THRESHOLD,
  ).length;

  if (total === 0) return "None";
  if (total >= 6 || serious >= 3) return "Heavy";
  if (total <= 2 && serious === 0) return "Light";
  return "Moderate"; // 3-5 total, OR 1-2 total with at least one serious
}

// ── Per-candidate competition check ───────────────────────────────────────────

async function checkCompetitionForCandidate(
  candidate: ProductCandidate,
  index: number,
  total: number,
  token: string,
): Promise<ProductCandidate> {
  const manual_check_url = buildManualCheckUrl(candidate);
  const now = new Date();

  const makeUnknown = (search_terms_used: string[] = []): LebanonCompetition => ({
    search_terms_used,
    total_competitors: 0,
    active_competitors: 0,
    serious_competitors: 0,
    competitors: [],
    competition_level: "Unknown",
    manual_check_url,
    signals_note: SIGNALS_NOTE,
    thresholds_version: THRESHOLDS_VERSION,
    computed_at: now.toISOString(),
  });

  try {
    const queries = buildSearchQueries(candidate);

    if (queries.length === 0) {
      log.info(
        `[${index + 1}/${total}] page_name=${candidate.page_name} queries=0 competition=Unknown`,
      );
      return { ...candidate, lebanon_competition: makeUnknown() };
    }

    const { ads, allFailed } = await fetchMergedLebanonAds(queries, token);
    const competitors = aggregateCompetitors(ads, now);
    const level = classifyCompetition(competitors, allFailed);

    const serious = competitors.filter(
      (c) => c.max_days_running >= SERIOUS_COMPETITOR_DAYS_THRESHOLD,
    ).length;

    const primaryTerm = queries[0] ?? candidate.page_name;
    log.info(
      `[${index + 1}/${total}] page_name=${candidate.page_name} term="${primaryTerm}" competitors=${competitors.length} serious=${serious} level=${level}`,
    );

    const lebanon_competition: LebanonCompetition = {
      search_terms_used: queries,
      total_competitors: competitors.length,
      active_competitors: competitors.filter((c) => c.active_ad_count > 0).length,
      serious_competitors: serious,
      competitors,
      competition_level: level,
      manual_check_url,
      signals_note: SIGNALS_NOTE,
      thresholds_version: THRESHOLDS_VERSION,
      computed_at: now.toISOString(),
    };

    return { ...candidate, lebanon_competition };
  } catch (err) {
    log.warn(
      `[${index + 1}/${total}] page_name=${candidate.page_name} — phase 4 processing failed, using Unknown`,
      { error: (err as Error).message },
    );
    return { ...candidate, lebanon_competition: makeUnknown() };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = loadTokenOrExit();

  if (!fs.existsSync(CANDIDATES_INPUT_PATH)) {
    log.error(`data/candidates.json not found. Run Phase 3 or Phase 3.1 first.`);
    process.exit(1);
  }

  let candidates: ProductCandidate[];
  try {
    const raw = fs.readFileSync(CANDIDATES_INPUT_PATH, "utf-8");
    candidates = JSON.parse(raw) as ProductCandidate[];
  } catch (err) {
    log.error("Failed to parse data/candidates.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    log.error("data/candidates.json is empty. Run Phase 3 or Phase 3.1 first.");
    process.exit(1);
  }

  log.info("Phase 4 starting", {
    candidates: candidates.length,
    parallelBatchSize: PARALLEL_BATCH_SIZE,
    seriousCompetitorDaysThreshold: SERIOUS_COMPETITOR_DAYS_THRESHOLD,
    thresholdsVersion: THRESHOLDS_VERSION,
    maxPagesPerQuery: MAX_PAGES_PER_QUERY,
  });

  // Parallel batch processing — no delay between calls
  const enriched: ProductCandidate[] = [];

  for (let i = 0; i < candidates.length; i += PARALLEL_BATCH_SIZE) {
    const batch = candidates.slice(i, i + PARALLEL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map((candidate, j) =>
        checkCompetitionForCandidate(candidate, i + j, candidates.length, token),
      ),
    );
    enriched.push(...results);
  }

  // Write to new file — candidates.json is untouched
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ENRICHED_OUTPUT_PATH, JSON.stringify(enriched, null, 2), "utf-8");

  // Summary
  const levelCounts: Record<string, number> = {
    None: 0, Light: 0, Moderate: 0, Heavy: 0, Unknown: 0,
  };
  let totalCompetitorSum = 0;
  const unknownCandidates: string[] = [];

  for (const c of enriched) {
    const comp = c.lebanon_competition;
    const level = comp?.competition_level ?? "Unknown";
    levelCounts[level] = (levelCounts[level] ?? 0) + 1;
    totalCompetitorSum += comp?.total_competitors ?? 0;
    if (level === "Unknown") {
      unknownCandidates.push(c.product_analysis?.identification.product_name ?? c.page_name);
    }
  }

  const avgCompetitors =
    enriched.length > 0
      ? Math.round((totalCompetitorSum / enriched.length) * 10) / 10
      : 0;

  log.info("Phase 4 summary", {
    totalProcessed: enriched.length,
    competitionDistribution: levelCounts,
    avgCompetitorsPerCandidate: avgCompetitors,
    unknownCount: unknownCandidates.length,
    ...(unknownCandidates.length > 0 && { unknownCandidates }),
  });
  log.info(`Wrote ${enriched.length} candidates to ${ENRICHED_OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 4 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export {
  classifyCompetition,
  buildSearchQueries,
  buildManualCheckUrl,
  fetchMergedLebanonAds,
  aggregateCompetitors,
};
