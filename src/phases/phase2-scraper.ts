import axios, { AxiosError } from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { KEYWORDS_2025, KEYWORDS_PER_RUN } from "../config/keywords";
import {
  DiscoveredKeywords,
  MetaAd,
  MetaAdLibraryRawAd,
  MetaAdLibraryResponse,
  MetaAdRange,
  Phase1Output,
  RunState,
} from "../types";
import { log } from "../utils/logger";

dotenv.config();

const META_API_URL = "https://graph.facebook.com/v19.0/ads_archive";
const REACHED_COUNTRIES = ["US", "GB", "CA", "AU"];
const PER_KEYWORD_LIMIT = 25;
const REQUEST_DELAY_MS = 1500;

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const RUN_STATE_PATH = path.join(DATA_DIR, ".run-state.json");
const ADS_OUTPUT_PATH = path.join(DATA_DIR, "ads.json");
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

function loadDiscoveredKeywords(): string[] | null {
  if (!fs.existsSync(DISCOVERED_KEYWORDS_PATH)) return null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(DISCOVERED_KEYWORDS_PATH, "utf-8"),
    ) as DiscoveredKeywords;
    // Flatten all niche keyword arrays into one list
    const all = Object.values(raw).flat().filter(Boolean);
    if (all.length === 0) return null;
    log.info(`Using ${all.length} keywords from discovered-keywords.json (Flow A output)`);
    return all;
  } catch {
    log.warn("Could not parse discovered-keywords.json — falling back to static list");
    return null;
  }
}

function getKeywordSliceForThisWeek(): { keywords: string[]; weekIndex: number } {
  const state = readRunState();

  // Prefer Flow A output — use ALL discovered keywords (no rotation; Flow A controls the list)
  const discovered = loadDiscoveredKeywords();
  if (discovered) {
    return { keywords: discovered, weekIndex: state.weekIndex };
  }

  // Fallback: rotate through static KEYWORDS_2025
  log.info("No discovered-keywords.json found — falling back to static keyword list");
  const totalSlices = Math.ceil(KEYWORDS_2025.length / KEYWORDS_PER_RUN);
  const slot = ((state.weekIndex % totalSlices) + totalSlices) % totalSlices;
  const start = slot * KEYWORDS_PER_RUN;
  let keywords = KEYWORDS_2025.slice(start, start + KEYWORDS_PER_RUN);
  if (keywords.length < KEYWORDS_PER_RUN) {
    keywords = keywords.concat(KEYWORDS_2025.slice(0, KEYWORDS_PER_RUN - keywords.length));
  }
  return { keywords, weekIndex: state.weekIndex };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRange(
  raw: { lower_bound?: string; upper_bound?: string } | undefined,
): MetaAdRange | null {
  if (!raw) return null;
  const lower = raw.lower_bound !== undefined ? Number(raw.lower_bound) : NaN;
  const upper = raw.upper_bound !== undefined ? Number(raw.upper_bound) : NaN;
  if (Number.isNaN(lower) && Number.isNaN(upper)) return null;
  return {
    lower_bound: Number.isNaN(lower) ? 0 : lower,
    upper_bound: Number.isNaN(upper) ? lower : upper,
  };
}

function mapRawToMetaAd(raw: MetaAdLibraryRawAd, searchTerm: string): MetaAd | null {
  if (!raw.id) return null;
  const body = (raw.ad_creative_bodies ?? []).map((s) => s?.trim()).filter(Boolean).join(" \n");
  return {
    ad_id: raw.id,
    page_name: raw.page_name ?? "",
    ad_creative_body: body,
    ad_delivery_start_time: raw.ad_delivery_start_time ?? "",
    ad_delivery_stop_time: raw.ad_delivery_stop_time ?? null,
    impressions: parseRange(raw.impressions),
    spend: parseRange(raw.spend),
    search_term_used: searchTerm,
  };
}

async function fetchAdsForKeyword(
  keyword: string,
  token: string,
  countries: string[] = REACHED_COUNTRIES,
): Promise<MetaAdLibraryRawAd[]> {
  const params = {
    access_token: token,
    ad_type: "ALL",
    ad_reached_countries: JSON.stringify(countries),
    ad_active_status: "ACTIVE",
    search_terms: keyword,
    fields: [
      "id",
      "page_name",
      "ad_creative_bodies",
      "ad_delivery_start_time",
      "ad_delivery_stop_time",
      "impressions",
      "spend",
      "publisher_platforms",
    ].join(","),
    limit: PER_KEYWORD_LIMIT,
  };

  try {
    const res = await axios.get<MetaAdLibraryResponse>(META_API_URL, {
      params,
      timeout: 20_000,
    });
    if (res.data.error) {
      log.error(`Meta API error for keyword "${keyword}"`, res.data.error);
      return [];
    }
    return res.data.data ?? [];
  } catch (err) {
    const ax = err as AxiosError<MetaAdLibraryResponse>;
    const status = ax.response?.status;
    const apiError = ax.response?.data?.error;
    log.error(`Request failed for keyword "${keyword}"`, {
      status,
      message: apiError?.message ?? ax.message,
    });
    return [];
  }
}

function filterAds(ads: MetaAd[]): MetaAd[] {
  const seen = new Set<string>();
  const out: MetaAd[] = [];
  for (const ad of ads) {
    if (!ad.ad_creative_body) continue;
    if (seen.has(ad.ad_id)) continue;
    seen.add(ad.ad_id);
    out.push(ad);
  }
  return out;
}

async function main(): Promise<void> {
  const { token } = loadEnvOrThrow();
  const { keywords, weekIndex } = getKeywordSliceForThisWeek();

  log.info(`Phase 1 starting`, {
    weekIndex,
    keywordCount: keywords.length,
    countries: REACHED_COUNTRIES,
  });
  log.info(`Keywords this run`, { keywords });

  const collected: MetaAd[] = [];
  const perKeywordCounts: Record<string, { raw: number; mapped: number }> = {};

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    const raw = await fetchAdsForKeyword(keyword, token);
    const mapped = raw
      .map((r) => mapRawToMetaAd(r, keyword))
      .filter((a): a is MetaAd => a !== null);
    perKeywordCounts[keyword] = { raw: raw.length, mapped: mapped.length };
    log.info(`Fetched "${keyword}"`, { raw: raw.length, mapped: mapped.length });
    collected.push(...mapped);
    if (i < keywords.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const filtered = filterAds(collected);

  log.info(`Phase 1 totals`, {
    rawCollected: collected.length,
    afterFilterAndDedupe: filtered.length,
    perKeyword: perKeywordCounts,
  });

  if (filtered.length === 0) {
    log.error(
      "Zero ads passed filtering. Common causes: invalid token, identity verification not complete, all results younger than 30 days, or keywords returning nothing in the chosen countries.",
    );
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const output: Phase1Output = filtered;
  fs.writeFileSync(ADS_OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Wrote ${filtered.length} ads to ${ADS_OUTPUT_PATH}`);

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

export { fetchAdsForKeyword, filterAds, getKeywordSliceForThisWeek, mapRawToMetaAd };
