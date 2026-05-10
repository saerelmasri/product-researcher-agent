import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { CandidateNiche } from "../types";
import { askClaude } from "../utils/claude";
import { log } from "../utils/logger";
import { getExistingNicheNames, writeNichesToNotion } from "../utils/notion";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const OUTPUT_PATH = path.join(DATA_DIR, "candidate-niches.json");

const SYSTEM_PROMPT = `You are a private label product research specialist focused on US DTC market winners that are also importable to Lebanon. You respond with valid JSON only — no markdown, no explanation, no code fences.`;

const USER_PROMPT = `Generate exactly 8 candidate niches for private label products. Goal: identify niches where US-based DTC brands are currently scaling on Meta ads, that I can source generically and sell into Lebanon.

A niche is a broad market CATEGORY, not a specific product.
Good niche examples: "Car Accessories", "Home Office Ergonomics", "Pet Accessories", "Travel Gear", "Sleep & Recovery", "EDC (Everyday Carry)".
Bad examples (too specific): "Car Seat Organizer", "Laptop Stand Riser", "Magnetic Phone Mount".

Hard constraints — every niche must satisfy ALL:
- Typical retail price $15–$60 USD
- Generic category with strong private label history (no patent moats, no dominant single brand globally)
- No mandatory certifications for import (exclude: ingestibles, supplements, cosmetics with active ingredients, electronics requiring CE/FCC for primary function, kids' toys under 3yr, medical devices)
- Physically robust enough for COD delivery (not fragile, not perishable, not heavily personalized — because 15–30% of COD orders get refused and returned to stock)
- AOV viable at $15+ retail (excludes ultra-cheap impulse items where COD return costs eat margin)

Soft priorities (not hard filters, but stronger niches hit more of these):
- Visible scaling on US Meta ads in the past 12 months
- Repeat purchase OR natural upsell chain within the category
- Visual/demo-friendly product (works well in short-form video ads)
- Solves a problem or triggers an emotion — not just "nice to have"

Lebanon import context (informational, affects the lebanonImportRisk field):
- Trilingual market (Arabic/French/English) — products with English-only packaging are fine
- Heavy COD dependence due to post-2019 banking situation
- Frequent power cuts make backup-power and efficiency-related products resonate
- Strong Gulf and European trend influence
- Car ownership is high; remote work is growing

Return JSON in this exact schema:
{
  "niches": [
    {
      "niche": "string — broad category name",
      "rationale": "string — 2-3 sentences on why this niche is winning on US Meta right now and why it's private-label-friendly",
      "examples": ["3-5 specific product types within the niche"],
      "priceRange": "string — e.g. '$20-45'",
      "upsellOrRepeat": "string — describe the repeat/upsell mechanic",
      "lebanonImportRisk": "low | medium | high",
      "lebanonImportNotes": "string — one sentence on import/COD viability for Lebanon"
    }
  ]
}`;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  log.info("Phase 0 starting — niche generation for Lebanese private label market");

  // Check Notion for existing niches to avoid regenerating duplicates
  log.info("Checking Notion for existing niches...");
  const existingNames = await getExistingNicheNames();
  if (existingNames.length > 0) {
    log.info(`Found ${existingNames.length} existing niches in Notion — will skip duplicates`, {
      existing: existingNames,
    });
  } else {
    log.info("No existing niches found in Notion (or Notion not configured) — generating fresh");
  }

  log.info("Calling Claude to generate 8 candidate niches...");
  let raw: string;
  try {
    raw = await askClaude(USER_PROMPT, SYSTEM_PROMPT);
  } catch (err) {
    log.error("Claude call failed", { error: (err as Error).message });
    process.exit(1);
  }

  let niches: CandidateNiche[];
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { niches?: CandidateNiche[] } | CandidateNiche[];
    // Handle both { niches: [...] } wrapper and flat array
    niches = Array.isArray(parsed) ? parsed : (parsed.niches ?? []);
    if (!Array.isArray(niches) || niches.length === 0) throw new Error("No niches in response");
  } catch (err) {
    log.error("Failed to parse Claude response", {
      error: (err as Error).message,
      raw: raw.slice(0, 300),
    });
    process.exit(1);
  }

  log.info(`Claude returned ${niches.length} niches`);

  // Filter out niches already in Notion
  const existingSet = new Set(existingNames.map((n) => n.toLowerCase().trim()));
  const newNiches = niches.filter((n) => !existingSet.has(n.niche.toLowerCase().trim()));

  if (newNiches.length < niches.length) {
    log.info(
      `Filtered out ${niches.length - newNiches.length} duplicate niches already in Notion`,
    );
  }
  if (newNiches.length === 0) {
    log.warn("All generated niches already exist in Notion. Nothing to write.");
    process.exit(0);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(newNiches, null, 2), "utf-8");
  log.info(`Wrote ${newNiches.length} new niches to ${OUTPUT_PATH}`);

  // Write to Notion (skipped gracefully if DB not configured)
  log.info("Writing new niches to Notion...");
  await writeNichesToNotion(newNiches, new Map());

  log.info("Phase 0 complete. Run `npm run phase0-5` next to validate with Google Trends.");
  log.info("New niches:");
  newNiches.forEach((n) => {
    log.info(`  • ${n.niche} [import risk: ${n.lebanonImportRisk}] — ${n.rationale.slice(0, 100)}...`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 0 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}

export { main as runNicheGeneration };
