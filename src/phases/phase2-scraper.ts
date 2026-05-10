import axios, { AxiosError } from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { KEYWORDS_2025, KEYWORDS_PER_RUN } from "../config/keywords";
import {
  BrandRecord,
  DiscoveredKeyword,
  DiscoveredKeywordsFile,
  MetaAd,
  MetaAdLibraryRawAd,
  MetaAdLibraryResponse,
  Phase1Output,
  RunState,
} from "../types";
import { log } from "../utils/logger";

dotenv.config();

const META_API_URL = "https://graph.facebook.com/v19.0/ads_archive";
const REACHED_COUNTRIES = ["US"];
const PER_KEYWORD_LIMIT = 100;
const REQUEST_DELAY_MS = 1500;

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const RUN_STATE_PATH = path.join(DATA_DIR, ".run-state.json");
const ADS_OUTPUT_PATH    = path.join(DATA_DIR, "ads.json");
const BRANDS_OUTPUT_PATH = path.join(DATA_DIR, "brands.json");
const DISCOVERED_KEYWORDS_PATH = path.join(DATA_DIR, "discovered-keywords.json");

function loadEnvOrThrow(): { token: string } {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) {
    log.error(
      "META_ACCESS_TOKEN is missing. Copy .env.example to .env and follow the README to generate a token.",
    );
    process.exit(1);
  }
  return { token };
}

function readRunState(): RunState {
  if (!fs.existsSync(RUN_STATE_PATH)) {
    return { weekIndex: 0, lastRunAt: null };
  }
  try {
    const raw = fs.readFileSync(RUN_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RunState>;
    return {
      weekIndex: typeof parsed.weekIndex === "number" ? parsed.weekIndex : 0,
      lastRunAt: parsed.lastRunAt ?? null,
    };
  } catch (err) {
    log.warn("Could not parse data/.run-state.json — resetting to weekIndex=0", {
      error: (err as Error).message,
    });
    return { weekIndex: 0, lastRunAt: null };
  }
}

function writeRunState(state: RunState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RUN_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

type KeywordEntry = { term: string; type: DiscoveredKeyword["type"] | null };

function loadDiscoveredKeywords(): KeywordEntry[] | null {
  if (!fs.existsSync(DISCOVERED_KEYWORDS_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(DISCOVERED_KEYWORDS_PATH, "utf-8")) as DiscoveredKeywordsFile;

    if (Array.isArray(raw.keywordsByNiche)) {
      const entries = raw.keywordsByNiche
        .flatMap((n) => n.keywords.map((k) => ({ term: k.term, type: k.type })))
        .filter((k) => k.term);
      if (entries.length > 0) {
        log.info(`Using ${entries.length} keywords from discovered-keywords.json (Flow A output)`);
        return entries;
      }
    }

    return null;
  } catch {
    log.warn("Could not parse discovered-keywords.json — falling back to static list");
    return null;
  }
}

function getKeywordSliceForThisWeek(): { keywords: KeywordEntry[]; weekIndex: number } {
  const state = readRunState();

  // Prefer Flow A output — use ALL discovered keywords (no rotation; Flow A controls the list)
  const discovered = loadDiscoveredKeywords();
  if (discovered) {
    return { keywords: discovered, weekIndex: state.weekIndex };
  }

  // Fallback: rotate through static KEYWORDS_2025 (no type metadata available)
  log.info("No discovered-keywords.json found — falling back to static keyword list");
  const totalSlices = Math.ceil(KEYWORDS_2025.length / KEYWORDS_PER_RUN);
  const slot = ((state.weekIndex % totalSlices) + totalSlices) % totalSlices;
  const start = slot * KEYWORDS_PER_RUN;
  let staticKws = KEYWORDS_2025.slice(start, start + KEYWORDS_PER_RUN);
  if (staticKws.length < KEYWORDS_PER_RUN) {
    staticKws = staticKws.concat(KEYWORDS_2025.slice(0, KEYWORDS_PER_RUN - staticKws.length));
  }
  return {
    keywords: staticKws.map((term) => ({ term, type: null })),
    weekIndex: state.weekIndex,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDaysRunning(
  startTime: string,
  stopTime: string | null,
  now: Date,
): number {
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return 0;
  const end = stopTime ? new Date(stopTime) : now;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function mapRawToMetaAd(
  raw: MetaAdLibraryRawAd,
  searchTerm: string,
  searchTermType: DiscoveredKeyword["type"] | null,
  now: Date,
): MetaAd | null {
  if (!raw.id) return null;
  const body = (raw.ad_creative_bodies ?? []).map((s) => s?.trim()).filter(Boolean).join(" \n");
  const stopTime = raw.ad_delivery_stop_time ?? null;
  return {
    ad_id: raw.id,
    page_id: raw.page_id ?? "",
    page_name: raw.page_name ?? "",
    ad_creative_body: body,
    has_creative_text: body.length > 0,
    ad_snapshot_url: raw.ad_snapshot_url ?? "",
    publisher_platforms: raw.publisher_platforms ?? [],
    ad_delivery_start_time: raw.ad_delivery_start_time ?? "",
    ad_delivery_stop_time: stopTime,
    days_running: computeDaysRunning(raw.ad_delivery_start_time ?? "", stopTime, now),
    is_still_active: stopTime === null,
    page_ad_count: 0, // filled in after full dedup
    search_terms_used: [searchTerm],
    search_term_types: [searchTermType],
  };
}

const MAX_PAGES      = 3;
const PAGE_DELAY_MS  = 500;
const RETRY_DELAYS   = [3_000, 9_000, 27_000]; // backoff on 429

const AD_FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_creative_bodies",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "ad_snapshot_url",
  "publisher_platforms",
].join(",");

async function fetchOnePage(
  params: Record<string, unknown>,
  keyword: string,
  pageNum: number,
): Promise<MetaAdLibraryResponse | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await axios.get<MetaAdLibraryResponse>(META_API_URL, {
        params,
        timeout: 20_000,
      });
      return res.data;
    } catch (err) {
      const ax = err as AxiosError<MetaAdLibraryResponse>;
      const status = ax.response?.status;

      if (status === 429 && attempt < RETRY_DELAYS.length) {
        const wait = RETRY_DELAYS[attempt];
        log.warn(
          `Rate limited (429) on "${keyword}" page ${pageNum} — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS.length})`,
        );
        await sleep(wait);
        continue;
      }

      const apiError = ax.response?.data?.error;
      log.warn(`Request failed for "${keyword}" (page ${pageNum})`, {
        status,
        message: apiError?.message ?? ax.message,
      });
      return null;
    }
  }
  return null;
}

async function fetchAdsForKeyword(
  keyword: string,
  token: string,
  countries: string[] = REACHED_COUNTRIES,
): Promise<{ ads: MetaAdLibraryRawAd[]; pages_fetched: number }> {
  const baseParams: Record<string, unknown> = {
    access_token: token,
    ad_type: "ALL",
    ad_reached_countries: JSON.stringify(countries),
    ad_active_status: "ALL",
    search_terms: keyword,
    fields: AD_FIELDS,
    limit: PER_KEYWORD_LIMIT,
  };

  const all: MetaAdLibraryRawAd[] = [];
  let pages_fetched = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchOnePage(baseParams, keyword, page + 1);
    if (!data) break;

    if (data.error) {
      log.warn(`Meta API error for "${keyword}" (page ${page + 1})`, data.error);
      break;
    }

    const pageData = data.data ?? [];
    all.push(...pageData);
    pages_fetched++;

    const afterCursor = data.paging?.cursors?.after;
    const hasNextPage = !!data.paging?.next && !!afterCursor && pageData.length === PER_KEYWORD_LIMIT;
    if (!hasNextPage) break;

    baseParams.after = afterCursor;
    await sleep(PAGE_DELAY_MS);
  }

  return { ads: all, pages_fetched };
}

async function main(): Promise<void> {
  const { token } = loadEnvOrThrow();
  const { keywords, weekIndex } = getKeywordSliceForThisWeek();

  log.info(`Phase 2 starting`, {
    weekIndex,
    keywordCount: keywords.length,
    countries: REACHED_COUNTRIES,
  });
  log.info(`Keywords this run:`);
  keywords.forEach((k) =>
    log.info(`  [${(k.type ?? "static").padEnd(11)}] ${k.term}`),
  );

  const now = new Date();
  // Incremental dedup map — merges keyword attribution on collision
  const seen = new Map<string, MetaAd>();

  for (let i = 0; i < keywords.length; i++) {
    const { term, type } = keywords[i];

    const { ads: raw, pages_fetched } = await fetchAdsForKeyword(term, token);

    const mapped = raw
      .map((r) => mapRawToMetaAd(r, term, type, now))
      .filter((a): a is MetaAd => a !== null);

    const with_text    = mapped.filter((a) => a.has_creative_text).length;
    const without_text = mapped.length - with_text;
    let new_unique = 0;
    let merged     = 0;

    for (const ad of mapped) {
      if (seen.has(ad.ad_id)) {
        const existing = seen.get(ad.ad_id)!;
        const newTerm = ad.search_terms_used[0];
        if (newTerm && !existing.search_terms_used.includes(newTerm)) {
          existing.search_terms_used.push(newTerm);
          existing.search_term_types.push(ad.search_term_types[0]);
        }
        merged++;
      } else {
        seen.set(ad.ad_id, { ...ad });
        new_unique++;
      }
    }

    log.info(`"${term}" [${type ?? "static"}]`, {
      pages_fetched,
      raw_ads: raw.length,
      with_text,
      without_text,
      new_unique,
      merged,
    });

    if (i < keywords.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const filtered = Array.from(seen.values());

  // Compute page_ad_count — how many ads each advertiser has in the full dataset
  const pageAdCounts = new Map<string, number>();
  for (const ad of filtered) {
    if (ad.page_id) pageAdCounts.set(ad.page_id, (pageAdCounts.get(ad.page_id) ?? 0) + 1);
  }
  for (const ad of filtered) {
    ad.page_ad_count = pageAdCounts.get(ad.page_id) ?? 1;
  }

  log.info(`Phase 2 totals`, {
    unique_ads: filtered.length,
  });

  if (filtered.length === 0) {
    log.error(
      "Zero ads passed filtering. Common causes: invalid token, identity verification not complete, all results younger than 30 days, or keywords returning nothing in the chosen countries.",
    );
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── ads.json ──────────────────────────────────────────────────────────────
  const output: Phase1Output = filtered;
  fs.writeFileSync(ADS_OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Wrote ${filtered.length} ads to ${ADS_OUTPUT_PATH}`);

  // ── brands.json ───────────────────────────────────────────────────────────
  // Build keyword → niche lookup from discovered-keywords.json (if available)
  const nicheByKeyword = new Map<string, string>();
  if (fs.existsSync(DISCOVERED_KEYWORDS_PATH)) {
    try {
      const kwFile = JSON.parse(
        fs.readFileSync(DISCOVERED_KEYWORDS_PATH, "utf-8"),
      ) as DiscoveredKeywordsFile;
      for (const entry of kwFile.keywordsByNiche ?? []) {
        for (const kw of entry.keywords) {
          nicheByKeyword.set(kw.term, entry.niche);
        }
      }
    } catch { /* skip — brands.json will have empty niches_hit */ }
  }

  const brandMap = new Map<string, { page_name: string; ads: MetaAd[] }>();
  for (const ad of filtered) {
    if (!ad.page_id) continue;
    if (!brandMap.has(ad.page_id)) brandMap.set(ad.page_id, { page_name: ad.page_name, ads: [] });
    brandMap.get(ad.page_id)!.ads.push(ad);
  }

  const brands: BrandRecord[] = [];
  for (const [page_id, { page_name, ads }] of brandMap) {
    const keywords_hit = [...new Set(ads.flatMap((a) => a.search_terms_used))];
    const niches_hit = [
      ...new Set(keywords_hit.map((k) => nicheByKeyword.get(k)).filter(Boolean) as string[]),
    ];
    const days = ads.map((a) => a.days_running);
    brands.push({
      page_id,
      page_name,
      ad_count: ads.length,
      active_ad_count: ads.filter((a) => a.is_still_active).length,
      avg_days_running: Math.round(days.reduce((s, d) => s + d, 0) / days.length),
      max_days_running: Math.max(...days),
      niches_hit,
      keywords_hit,
      ad_ids: ads.map((a) => a.ad_id),
    });
  }
  brands.sort((a, b) => b.ad_count - a.ad_count);

  fs.writeFileSync(BRANDS_OUTPUT_PATH, JSON.stringify(brands, null, 2), "utf-8");
  log.info(`Wrote ${brands.length} brand records to ${BRANDS_OUTPUT_PATH}`);
  log.info("Top 5 brands by ad count:");
  brands.slice(0, 5).forEach((b) =>
    log.info(`  ${b.page_name} — ${b.ad_count} ads, ${b.active_ad_count} active, avg ${b.avg_days_running}d`),
  );

  writeRunState({
    weekIndex: weekIndex + 1,
    lastRunAt: new Date().toISOString(),
  });
  log.info(`Advanced weekIndex to ${weekIndex + 1}`);
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 1 crashed", { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  });
}

export { fetchAdsForKeyword, getKeywordSliceForThisWeek, mapRawToMetaAd };
