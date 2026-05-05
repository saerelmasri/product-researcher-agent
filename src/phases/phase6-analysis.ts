import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import {
  CustomerObjection,
  Phase3Output,
  Phase6Output,
  ProductCandidate,
  ProductReport,
} from "../types";
import { MODEL_DEEP } from "../utils/claude";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "candidates.json");
const OUTPUT_PATH = path.join(DATA_DIR, "reports.json");
const BETWEEN_CALLS_DELAY_MS = 2000;

const SYSTEM_PROMPT = `You are a private label product analyst specialising in the Lebanese market.
You write in plain, direct English for a Lebanese entrepreneur sourcing from Alibaba and selling locally.
You respond with valid JSON only — no markdown, no explanation, no code fences.`;

// ── prompt builder ─────────────────────────────────────────────────────────────

function formatSuppliers(c: ProductCandidate): string {
  if (c.alibaba_suppliers.length > 0) {
    return c.alibaba_suppliers
      .slice(0, 3)
      .map(
        (s, i) =>
          `  Supplier ${i + 1}: ${s.name} | Stars: ${s.stars ?? "n/a"} | ` +
          `Price: ${s.price_per_unit} | MOQ: ${s.moq} | ` +
          `Certs: ${s.certifications.join(", ") || "none"}`,
      )
      .join("\n");
  }
  return `  No supplier data (Alibaba blocked scraper). Manual lookup: ${c.alibaba_search_url}`;
}

function formatAdSamples(c: ProductCandidate): string {
  const samples = c.source_ads
    .slice(0, 2)
    .map(
      (ad, i) =>
        `  Ad ${i + 1} (${ad.page_name}): ${ad.ad_creative_body
          .slice(0, 220)
          .replace(/\n+/g, " ")}`,
    )
    .join("\n");
  return samples || "  No ad copy available.";
}

export function buildPrompt(c: ProductCandidate): string {
  return `Analyse this private label opportunity for the Lebanese market.

PRODUCT: ${c.product_name}
NICHE: ${c.niche}
SCORE: ${c.score}/100 — Verdict: ${c.verdict}
SELLING PRICE: $${c.selling_price_usd}
ALIBABA COST RANGE: ${c.alibaba_cost_range}
ESTIMATED MARGIN: ${c.estimated_margin_pct}%
WEIGHT: ${c.weight_kg} kg
LEBANON COMPETITION: ${c.lebanon_competition}
REPEAT PURCHASE: ${c.has_recurring_purchase ? "Yes" : "No"}
CROSS-SELL OPPORTUNITIES: ${c.cross_sell_opportunities.join(", ")}
SCORE RATIONALE: ${c.score_rationale}

ALIBABA SUPPLIERS:
${formatSuppliers(c)}

META ADS SAMPLE (how this product is marketed right now):
${formatAdSamples(c)}

---

Generate a JSON report with exactly these four fields:

"market_analysis"
  2–3 sentences. Data-driven. Reference the Lebanon competition level, the ad activity seen,
  and the specific opportunity or risk for a new private label entrant right now.

"customer_objections"
  Array of exactly 4 objects — one per category (Shipping, Quality, Price, Trust), in that order.
  Write customer_voice as the raw, unfiltered thought a skeptical Lebanese buyer would have.
  Schema per object:
  {
    "category": "Shipping" | "Quality" | "Price" | "Trust",
    "customer_voice": "...",
    "why_it_matters_in_lebanon": "one sentence — the Lebanon-specific reason",
    "counter": "one concrete action for the product page or ad that neutralises this objection"
  }

  Lebanon context to inform each objection:
  - Shipping: local postal services are unreliable; DHL/FedEx are the trusted alternative
  - Quality: strong cultural distrust of "cheap Chinese products"; unboxing videos and demo content help
  - Price: Lebanese pound devaluation and economic crisis make buyers hyper price-conscious; value framing beats discount framing
  - Trust: buying from an unknown online store feels risky; COD option, reviews, and Instagram presence reduce hesitation

"agent_verdict"
  2–3 plain sentences. What is the opportunity, what is the single biggest risk?

"recommended_next_step"
  One specific, actionable instruction for what to do in the next 7 days.
  Be concrete — name a supplier contact action, a test budget, or a specific market validation step.

Respond with ONLY this JSON:
{
  "market_analysis": "...",
  "customer_objections": [ ... ],
  "agent_verdict": "...",
  "recommended_next_step": "..."
}`;
}

// ── Claude response types ──────────────────────────────────────────────────────

interface ClaudeObjection {
  category: string;
  customer_voice: string;
  why_it_matters_in_lebanon: string;
  counter: string;
}

interface ClaudeAnalysis {
  market_analysis: string;
  customer_objections: ClaudeObjection[];
  agent_verdict: string;
  recommended_next_step: string;
}

function parseResponse(raw: string, productName: string): ClaudeAnalysis | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as ClaudeAnalysis;
    if (!parsed.market_analysis || !Array.isArray(parsed.customer_objections)) {
      throw new Error("Missing required fields in response");
    }
    return parsed;
  } catch (err) {
    log.warn(`Failed to parse Claude response for "${productName}"`, {
      error: (err as Error).message,
      raw: raw.slice(0, 300),
    });
    return null;
  }
}

const VALID_CATEGORIES = new Set(["Shipping", "Quality", "Price", "Trust"]);

function mapObjections(raw: ClaudeObjection[]): CustomerObjection[] {
  return raw.map((o) => ({
    category: (VALID_CATEGORIES.has(o.category)
      ? o.category
      : "Trust") as CustomerObjection["category"],
    customer_voice: o.customer_voice ?? "",
    why_it_matters_in_lebanon: o.why_it_matters_in_lebanon ?? "",
    counter: o.counter ?? "",
  }));
}

// ── per-product analysis ───────────────────────────────────────────────────────

type AskClaudeFn = (
  prompt: string,
  systemPrompt?: string,
  model?: string,
) => Promise<string>;

export async function analyseProduct(
  candidate: ProductCandidate,
  askClaude: AskClaudeFn,
): Promise<ProductReport | null> {
  log.info(`Analysing "${candidate.product_name}"...`);

  let raw: string;
  try {
    raw = await askClaude(buildPrompt(candidate), SYSTEM_PROMPT, MODEL_DEEP);
  } catch (err) {
    log.warn(`Claude call failed for "${candidate.product_name}"`, {
      error: (err as Error).message,
    });
    return null;
  }

  const analysis = parseResponse(raw, candidate.product_name);
  if (!analysis) return null;

  const report: ProductReport = {
    ...candidate,
    market_analysis: analysis.market_analysis,
    customer_objections: mapObjections(analysis.customer_objections),
    agent_verdict: analysis.agent_verdict,
    recommended_next_step: analysis.recommended_next_step,
    week_generated: new Date().toISOString().split("T")[0],
  };

  log.info(`  "${candidate.product_name}" — analysis done`);
  return report;
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("ANTHROPIC_API_KEY is not set. Phase 6 requires Claude.");
    process.exit(1);
  }

  const { askClaude } = await import("../utils/claude");

  if (!fs.existsSync(INPUT_PATH)) {
    log.error(`candidates.json not found at ${INPUT_PATH}. Run Phases 2–5 first.`);
    process.exit(1);
  }

  let candidates: Phase3Output;
  try {
    candidates = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8")) as Phase3Output;
  } catch (err) {
    log.error("Failed to parse candidates.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    log.error("candidates.json is empty. Run Phases 2–5 first.");
    process.exit(1);
  }

  // Per PRD: only run deep analysis on Low or Medium competition products
  // Unknown is also included (Phase 4 may not have run or found nothing)
  const eligible = candidates.filter(
    (c) =>
      c.lebanon_competition === "Low" ||
      c.lebanon_competition === "Medium" ||
      c.lebanon_competition === "Unknown",
  );
  const skipped = candidates.filter((c) => c.lebanon_competition === "High");

  log.info("Phase 6 starting — Claude deep analysis", {
    totalCandidates: candidates.length,
    eligible: eligible.length,
    skippedHighCompetition: skipped.length,
    model: MODEL_DEEP,
  });

  if (skipped.length > 0) {
    log.info(
      "Skipping (High Lebanon competition):",
      skipped.map((c) => c.product_name),
    );
  }

  if (eligible.length === 0) {
    log.warn("All candidates have High Lebanon competition — nothing to analyse.");
    process.exit(0);
  }

  const reports: ProductReport[] = [];

  for (let i = 0; i < eligible.length; i++) {
    const report = await analyseProduct(eligible[i], askClaude);
    if (report) reports.push(report);
    if (i < eligible.length - 1) {
      await new Promise<void>((r) => setTimeout(r, BETWEEN_CALLS_DELAY_MS));
    }
  }

  if (reports.length === 0) {
    log.error("No reports generated — all Claude calls failed. Check API key and quota.");
    process.exit(1);
  }

  const output: Phase6Output = reports;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Phase 6 complete. Wrote ${reports.length} reports to ${OUTPUT_PATH}`);
  log.info("Run `npm run phase6-1` (offline) or `npm run phase7` (Notion) next.");

  reports.forEach((r, i) => {
    log.info(`  ${i + 1}. ${r.product_name} [${r.verdict}]`);
    log.info(`     Next step: ${r.recommended_next_step}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 6 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}
