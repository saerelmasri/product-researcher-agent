import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import {
  DiscoveredKeyword,
  DiscoveredKeywordsByNiche,
  DiscoveredKeywordsFile,
  ValidatedNiche,
} from "../types";
import { askClaude } from "../utils/claude";
import { log } from "../utils/logger";
import { getNichesWithKeywords, writeKeywordsToNotion } from "../utils/notion";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "validated-niches.json");
const OUTPUT_PATH = path.join(DATA_DIR, "discovered-keywords.json");

const SYSTEM_PROMPT = `You are a Meta Ad Library search specialist. You generate keywords that surface actively-running US Facebook and Instagram ads for physical DTC products. You respond with valid JSON only — no markdown, no explanation, no code fences.`;

function buildUserPrompt(niches: string[]): string {
  return `Generate 8 search keywords for each niche below. These keywords will be entered into the Meta Ad Library search box, which matches against ad creative text and advertiser page names — NOT against search-engine-style queries.

Rules for each keyword:
- 1 to 3 words (1-2 words preferred — longer queries return fewer results)
- English only
- No brand names
- Must be language that actually appears in DTC ad copy or page names, not how a buyer would Google something

Required mix per niche (8 total):
- 3 product category nouns: short, literal product names (e.g. "car organizer", "posture corrector")
- 2 hook/benefit phrases: language that appears in ad copy describing the result (e.g. "back pain relief", "saves space", "instant relief")
- 2 mechanism or feature phrases: how the product works or its key feature (e.g. "memory foam", "magnetic mount", "self-watering")
- 1 vernacular/community term: niche-specific shorthand or trend term (e.g. "EDC", "WFH setup", "dad gift", "viral")

Prefer keywords that:
- Appear in scroll-stopping ad hooks
- Are concrete and visual
- Describe what the product DOES, not what problem it solves abstractly

Avoid:
- Full sentences or question forms ("how do I...", "best way to...")
- Generic category umbrellas ("home goods", "accessories")
- Anything over 3 words

Niches:
${niches.map((n, i) => `${i + 1}. ${n}`).join("\n")}

Return JSON:
{
  "keywordsByNiche": [
    {
      "niche": "string",
      "keywords": [
        {"term": "string", "type": "category | hook | mechanism | vernacular"}
      ]
    }
  ]
}`;
}

// ── parser ─────────────────────────────────────────────────────────────────────

interface RawClaudeKeyword {
  term?: string;
  type?: string;
}

interface RawClaudeNiche {
  niche?: string;
  keywords?: RawClaudeKeyword[];
}

interface RawClaudeResponse {
  keywordsByNiche?: RawClaudeNiche[];
}

const VALID_TYPES = new Set(["category", "hook", "mechanism", "vernacular"]);

function parseResponse(
  raw: string,
): DiscoveredKeywordsByNiche[] | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as RawClaudeResponse;
    if (!Array.isArray(parsed.keywordsByNiche)) {
      throw new Error("Missing keywordsByNiche array");
    }
    return parsed.keywordsByNiche.map((n) => ({
      niche: n.niche ?? "",
      keywords: (n.keywords ?? [])
        .filter((k) => k.term)
        .map((k) => ({
          term: k.term!.toLowerCase().trim(),
          type: (VALID_TYPES.has(k.type ?? "") ? k.type : "category") as DiscoveredKeyword["type"],
        })),
    })).filter((n) => n.niche && n.keywords.length > 0);
  } catch (err) {
    log.error("Failed to parse Claude response", {
      error: (err as Error).message,
      raw: raw.slice(0, 300),
    });
    return null;
  }
}

// ── main ───────────────────────────────────────────────────────────────────────

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

  log.info(`Phase 1 starting — keyword generation for ${validated.length} niches`);

  // Load existing file so we only ADD, never overwrite
  let existing: DiscoveredKeywordsFile = { keywordsByNiche: [] };
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8")) as DiscoveredKeywordsFile;
      if (Array.isArray(raw.keywordsByNiche)) {
        existing = raw;
        log.info(`Loaded existing file with ${existing.keywordsByNiche.length} niche(s)`);
      }
    } catch {
      log.warn("Could not parse existing discovered-keywords.json — starting fresh");
    }
  }

  const existingNiches = new Set(existing.keywordsByNiche.map((n) => n.niche.toLowerCase()));

  // Check Notion for niches already written there
  log.info("Checking Notion for niches that already have keywords...");
  const nichesWithKeywords = await getNichesWithKeywords();

  const nichesToProcess = validated
    .map((v) => v.niche)
    .filter((niche) => {
      if (existingNiches.has(niche.toLowerCase())) {
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
    log.info("Run `npm run phase2` to start scraping.");
    process.exit(0);
  }

  log.info(`Generating keywords for ${nichesToProcess.length} niche(s) via Claude...`);

  let raw: string;
  try {
    raw = await askClaude(buildUserPrompt(nichesToProcess), SYSTEM_PROMPT);
  } catch (err) {
    log.error("Claude call failed", { error: (err as Error).message });
    process.exit(1);
  }

  const generated = parseResponse(raw);
  if (!generated) process.exit(1);

  // Merge with existing
  let totalNew = 0;
  const merged: DiscoveredKeywordsFile = {
    keywordsByNiche: [...existing.keywordsByNiche],
  };

  for (const entry of generated) {
    if (existingNiches.has(entry.niche.toLowerCase())) {
      log.warn(`  "${entry.niche}" already exists — skipping (keywords are generated ONCE per niche)`);
      continue;
    }
    merged.keywordsByNiche.push(entry);
    totalNew += entry.keywords.length;
    log.info(`  "${entry.niche}": ${entry.keywords.length} keywords`);
    entry.keywords.forEach((k) =>
      log.info(`    [${k.type.padEnd(11)}] ${k.term}`),
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), "utf-8");
  log.info(`Wrote ${totalNew} new keywords across ${nichesToProcess.length} niche(s) to ${OUTPUT_PATH}`);

  // Write terms to Notion
  log.info("Writing keywords to Notion...");
  for (const entry of generated) {
    await writeKeywordsToNotion(entry.niche, entry.keywords.map((k) => k.term));
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
