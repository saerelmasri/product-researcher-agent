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

const SYSTEM_PROMPT = `You are a private label product research specialist for the Lebanese market.
You respond with valid JSON only — no markdown, no explanation, no code fences.`;

const USER_PROMPT = `Generate exactly 12 candidate niches for private label products to sell in Lebanon.

Constraints — every niche must satisfy ALL of these:
- Target selling price: $15–$60 USD
- MOQ under 300 units on Alibaba
- Shippable to Lebanon without special permits or certifications
- Generic product with no dominant brand — easy to rebrand
- NOT: food, supplements, electronics requiring CE/FCC certification, cosmetics requiring CPNP registration, children's toys requiring safety certs
- Must have repeat purchase potential OR strong upsell chain

Lebanon market context:
- Urban middle-class buyer in Beirut and major cities
- Price-sensitive but willing to pay for perceived quality
- Influenced by Gulf (KSA, UAE) and European trends
- High car ownership — car accessories are strong
- Growing remote work culture — home office products trending
- Frequent power cuts — anything related to backup power or efficiency
- Strong social media influence (Instagram, TikTok)

IMPORTANT DEFINITION — A niche is a broad market CATEGORY, not a specific product.
Good niche examples: "Car Accessories", "Home Office", "Emergency Power", "Eco Kitchen", "Personal Safety", "Baby & Toddler", "Pet Accessories", "Travel Gear".
Bad examples (too specific — these are products, not niches): "Car Seat Organizer", "Laptop Stand Riser", "UV Water Purifier Wand".
The 'examples' field is where specific products go. The 'niche' field is the broad category they belong to.

Respond with a JSON array of exactly 12 objects. Each object must follow this exact schema:
{
  "niche": "broad market category (1–3 words, e.g. 'Car Accessories', 'Home Office', 'Emergency Power')",
  "examples": ["specific product 1", "specific product 2", "specific product 3"],
  "privateLabelViable": "one sentence — why this category is easy to private label",
  "lebanonFit": 4,
  "alibabaPrice": "$3–$8",
  "sellingPrice": "$25–$45",
  "reasoning": "one sentence — why this category fits Lebanon specifically"
}

Prioritise categories with: no dominant national brand in Lebanon, clear private label angle, multiple rebrandable products within the category.`;

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

  log.info("Calling Claude to generate 12 candidate niches...");
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
    niches = JSON.parse(cleaned) as CandidateNiche[];
    if (!Array.isArray(niches)) throw new Error("Response is not an array");
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
    log.info(`  • ${n.niche} [Lebanon fit: ${n.lebanonFit}/5] — ${n.reasoning}`);
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
