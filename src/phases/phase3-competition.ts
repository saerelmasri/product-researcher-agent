import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { ProductCandidate } from "../types";
import { log } from "../utils/logger";
import { fetchAdsForKeyword } from "./phase1-scraper";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const CANDIDATES_PATH = path.join(DATA_DIR, "candidates.json");

const LEBANON_COUNTRIES = ["LB"];
const REQUEST_DELAY_MS = 1500;

function loadTokenOrExit(): string {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) {
    log.error("META_ACCESS_TOKEN is missing. Phase 3 needs the same Meta token as Phase 1.");
    process.exit(1);
  }
  return token;
}

function classifyCompetition(uniqueAdvertisers: number): "Low" | "Medium" | "High" {
  if (uniqueAdvertisers === 0) return "Low";
  if (uniqueAdvertisers <= 3) return "Medium";
  return "High";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const token = loadTokenOrExit();

  if (!fs.existsSync(CANDIDATES_PATH)) {
    log.error(
      `data/candidates.json not found at ${CANDIDATES_PATH}. Run Phase 2 or Phase 2.1 first.`,
    );
    process.exit(1);
  }

  let candidates: ProductCandidate[];
  try {
    const raw = fs.readFileSync(CANDIDATES_PATH, "utf-8");
    candidates = JSON.parse(raw) as ProductCandidate[];
  } catch (err) {
    log.error("Failed to parse data/candidates.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    log.error("data/candidates.json is empty. Run Phase 2 or Phase 2.1 first.");
    process.exit(1);
  }

  log.info("Phase 3 starting", { candidates: candidates.length });

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    log.info(`Checking Lebanon competition for "${candidate.product_name}"`);

    try {
      const ads = await fetchAdsForKeyword(candidate.product_name, token, LEBANON_COUNTRIES);
      const uniqueAdvertisers = new Set(
        ads.map((a) => a.page_name).filter((name): name is string => Boolean(name)),
      ).size;
      const level = classifyCompetition(uniqueAdvertisers);
      candidate.lebanon_competition = level;
      log.info(
        `  "${candidate.product_name}": ${ads.length} ads from ${uniqueAdvertisers} advertisers → ${level}`,
      );
    } catch (err) {
      log.warn(`Failed to check competition for "${candidate.product_name}" — leaving as Unknown`, {
        error: (err as Error).message,
      });
    }

    if (i < candidates.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidates, null, 2), "utf-8");

  log.info("Phase 3 summary:");
  candidates.forEach((c) => {
    log.info(`  ${c.product_name} — ${c.lebanon_competition}`);
  });
  log.info(`Updated ${candidates.length} candidates in ${CANDIDATES_PATH}`);
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

export { classifyCompetition };
