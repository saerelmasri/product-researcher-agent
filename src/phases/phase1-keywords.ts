import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { DiscoveredKeywords, ValidatedNiche } from "../types";
import { askClaude } from "../utils/claude";
import { log } from "../utils/logger";
import { getNichesWithKeywords, writeKeywordsToNotion } from "../utils/notion";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "validated-niches.json");
const OUTPUT_PATH = path.join(DATA_DIR, "discovered-keywords.json");

const SYSTEM_PROMPT = `You are a Meta Ad Library keyword specialist. You generate search terms that find
actively-running Facebook and Instagram ads for physical DTC products. You respond with valid JSON only —
no markdown, no explanation, no code fences.`;

function buildUserPrompt(niches: string[]): string {
  return `Generate 6–8 search keywords for each of the following product niches.
These keywords will be used to search the Meta Ad Library (Facebook/Instagram ads), so they must:
- Sound like ad headlines OR buyer search queries — NOT generic product category names
- Mix of: broad intent terms (high ad volume) and specific terms (high purchase intent)
- Include at least 2 "problem-aware" terms per niche (e.g. "messy car storage solution")
- Include at least 2 "product-aware" terms per niche (e.g. "car seat organizer buy")
- Avoid brand names
- Be 2–5 words each

Niches to generate keywords for:
${niches.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Respond with a JSON object where each key is the exact niche name and the value is an array of keyword strings:
{
  "Niche Name": ["keyword one", "keyword two", ...],
  ...
}`;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_PATH)) {
    log.error(`validated-niches.json not found at ${INPUT_PATH}. Run Phase 0.5 first.`);
    process.exit(1);
  }

  let validated: ValidatedNiche[];
  try {
    validated = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8")) as ValidatedNiche[];
  } catch (err) {
    log.error("Failed to parse validated-niches.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(validated) || validated.length === 0) {
    log.error("validated-niches.json is empty. Run Phase 0.5 first.");
    process.exit(1);
  }

  log.info(`Phase 1 starting — keyword generation for ${validated.length} validated niches`);

  // Load existing discovered-keywords.json if it exists (we only ADD, never overwrite)
  let existing: DiscoveredKeywords = {};
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8")) as DiscoveredKeywords;
      log.info(`Loaded existing discovered-keywords.json with ${Object.keys(existing).length} niches`);
    } catch {
      log.warn("Could not parse existing discovered-keywords.json — starting fresh");
    }
  }

  // Check Notion to find niches that already have keywords (skip them)
  log.info("Checking Notion for niches that already have keywords...");
  const nichesWithKeywords = await getNichesWithKeywords();

  // Determine which niches need keywords generated
  const nichesToProcess = validated
    .map((v) => v.niche)
    .filter((niche) => {
      if (existing[niche] && existing[niche].length > 0) {
        log.info(`  Skipping "${niche}" — already in discovered-keywords.json`);
        return false;
      }
      if (nichesWithKeywords.has(niche)) {
        log.info(`  Skipping "${niche}" — already has keywords in Notion`);
        return false;
      }
      return true;
    });

  if (nichesToProcess.length === 0) {
    log.info("All niches already have keywords. Nothing to generate.");
    log.info("discovered-keywords.json is up to date. Run `npm run phase2` to start scraping.");
    process.exit(0);
  }

  log.info(`Generating keywords for ${nichesToProcess.length} niches via Claude...`);

  let raw: string;
  try {
    raw = await askClaude(buildUserPrompt(nichesToProcess), SYSTEM_PROMPT);
  } catch (err) {
    log.error("Claude call failed", { error: (err as Error).message });
    process.exit(1);
  }

  let generated: DiscoveredKeywords;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    generated = JSON.parse(cleaned) as DiscoveredKeywords;
    if (typeof generated !== "object" || Array.isArray(generated)) {
      throw new Error("Response is not a plain object");
    }
  } catch (err) {
    log.error("Failed to parse Claude response", {
      error: (err as Error).message,
      raw: raw.slice(0, 300),
    });
    process.exit(1);
  }

  // Merge with existing (never overwrite existing niche keywords)
  const merged: DiscoveredKeywords = { ...existing };
  let totalNew = 0;

  for (const [niche, keywords] of Object.entries(generated)) {
    if (!Array.isArray(keywords) || keywords.length === 0) continue;
    if (merged[niche]) {
      log.warn(`  "${niche}" already exists — skipping (keywords are generated ONCE per niche)`);
      continue;
    }
    merged[niche] = keywords;
    totalNew += keywords.length;
    log.info(`  "${niche}": ${keywords.length} keywords`);
    keywords.forEach((kw) => log.info(`    - ${kw}`));
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), "utf-8");
  log.info(`Wrote ${totalNew} new keywords across ${nichesToProcess.length} niches to ${OUTPUT_PATH}`);

  // Write to Notion (skipped gracefully if DB not configured)
  log.info("Writing keywords to Notion...");
  for (const [niche, keywords] of Object.entries(generated)) {
    if (!Array.isArray(keywords) || keywords.length === 0) continue;
    await writeKeywordsToNotion(niche, keywords);
  }

  log.info("Phase 1 complete. Run `npm run phase2` to start the weekly scraping pipeline.");
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 1 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export { buildUserPrompt };
