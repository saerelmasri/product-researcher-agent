import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { CandidateNiche, TrendStatus, ValidatedNiche } from "../types";
import { log } from "../utils/logger";
import { fetchGoogleTrends } from "../utils/serpapi";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "candidate-niches.json");
const OUTPUT_PATH = path.join(DATA_DIR, "validated-niches.json");

const REQUEST_DELAY_MS = 1200; // SerpApi rate limit: stay well under free tier

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function classifyTrend(data: number[]): { status: TrendStatus; change: string } {
  if (data.length < 6) {
    // Not enough data to classify — treat as STABLE
    return { status: "STABLE", change: "n/a" };
  }

  const early = average(data.slice(0, 3));
  const recent = average(data.slice(-3));

  if (early === 0) {
    // No baseline — can't compute change, assume STABLE
    return { status: "STABLE", change: "n/a" };
  }

  const changePct = ((recent - early) / early) * 100;
  const changeStr = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(0)}%`;

  let status: TrendStatus;
  if (changePct < -20) status = "DECLINING";
  else if (changePct >= 15) status = "RISING";
  else status = "STABLE";

  return { status, change: changeStr };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!process.env.SERPAPI_KEY) {
    log.error("SERPAPI_KEY is not set. Phase 0.5 requires SerpApi for Google Trends data.");
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_PATH)) {
    log.error(`candidate-niches.json not found at ${INPUT_PATH}. Run Phase 0 first.`);
    process.exit(1);
  }

  let niches: CandidateNiche[];
  try {
    niches = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8")) as CandidateNiche[];
  } catch (err) {
    log.error("Failed to parse candidate-niches.json", { error: (err as Error).message });
    process.exit(1);
  }

  log.info(`Phase 0.5 starting — trend validation for ${niches.length} niches via SerpApi`);

  const validated: ValidatedNiche[] = [];
  const dropped: string[] = [];

  for (let i = 0; i < niches.length; i++) {
    const niche = niches[i];
    log.info(`Fetching trends for "${niche.niche}" (${i + 1}/${niches.length})...`);

    const data = await fetchGoogleTrends(niche.niche);

    if (data.length === 0) {
      // SerpApi couldn't get data — default to STABLE so we don't drop it unfairly
      log.warn(`  No trend data for "${niche.niche}" — defaulting to STABLE`);
      validated.push({ niche: niche.niche, status: "STABLE", change: "n/a" });
    } else {
      const { status, change } = classifyTrend(data);
      log.info(`  "${niche.niche}": ${status} (${change})`);

      if (status === "DECLINING") {
        dropped.push(niche.niche);
      } else {
        validated.push({ niche: niche.niche, status, change });
      }
    }

    if (i < niches.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  log.info("Phase 0.5 summary", {
    total: niches.length,
    passed: validated.length,
    dropped: dropped.length,
  });

  if (dropped.length > 0) {
    log.info("Dropped (DECLINING):", { niches: dropped });
  }

  if (validated.length === 0) {
    log.error("All niches were DECLINING — nothing to pass to Phase 1. Re-run Phase 0.");
    process.exit(1);
  }

  // Sort: RISING first, then STABLE
  validated.sort((a, b) => {
    if (a.status === "RISING" && b.status !== "RISING") return -1;
    if (b.status === "RISING" && a.status !== "RISING") return 1;
    return 0;
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(validated, null, 2), "utf-8");
  log.info(`Wrote ${validated.length} validated niches to ${OUTPUT_PATH}`);
  log.info("Run `npm run phase1` next to generate keywords for these niches.");

  validated.forEach((v) => {
    log.info(`  [${v.status}] ${v.niche} (${v.change})`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 0.5 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export { classifyTrend };
