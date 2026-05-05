import axios from "axios";
import * as dotenv from "dotenv";

import { log } from "./logger";

dotenv.config();

const BASE_URL = "https://serpapi.com/search.json";

function getKeyOrThrow(): string {
  const key = process.env.SERPAPI_KEY?.trim();
  if (!key) {
    throw new Error(
      "SERPAPI_KEY is not set. Add it to .env — free tier at https://serpapi.com (100 searches/month).",
    );
  }
  return key;
}

interface SerpApiTimelineValue {
  query: string;
  value: number;
}

interface SerpApiTimelinePoint {
  date: string;
  timestamp: string;
  values: SerpApiTimelineValue[];
}

interface SerpApiGoogleTrendsResponse {
  interest_over_time?: {
    timeline_data?: SerpApiTimelinePoint[];
  };
  error?: string;
}

/**
 * Fetch 12 months of Google Trends interest-over-time for a keyword.
 * Returns an array of up to 12 monthly interest values (0–100).
 * Returns [] on any error so callers can handle gracefully.
 */
export async function fetchGoogleTrends(keyword: string): Promise<number[]> {
  const apiKey = getKeyOrThrow();

  try {
    const res = await axios.get<SerpApiGoogleTrendsResponse>(BASE_URL, {
      timeout: 15_000,
      params: {
        engine: "google_trends",
        q: keyword,
        date: "today 12-m",
        api_key: apiKey,
      },
    });

    if (res.data.error) {
      log.warn(`SerpApi error for "${keyword}"`, { error: res.data.error });
      return [];
    }

    const timeline = res.data.interest_over_time?.timeline_data ?? [];
    if (timeline.length === 0) {
      log.warn(`SerpApi returned empty timeline for "${keyword}"`);
      return [];
    }

    // Extract the interest value for each time point (first query value per point)
    const values = timeline
      .map((point) => point.values?.[0]?.value ?? 0)
      .filter((v) => typeof v === "number");

    return values;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    log.warn(`SerpApi request failed for "${keyword}"`, {
      status,
      error: (err as Error).message,
    });
    return [];
  }
}
