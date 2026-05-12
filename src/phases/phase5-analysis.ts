import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import {
  CustomerObjection,
  Phase3Output,
  Phase5Output,
  ProductCandidate,
  ProductReport,
  RecommendedNextStep,
} from "../types";
import { MODEL_DEEP } from "../utils/claude";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "candidates-with-competition.json");
const OUTPUT_PATH = path.join(DATA_DIR, "reports.json");
const SYSTEM_PROMPT = `You are a private label product analyst specialising in the Lebanese market.
You write in plain, direct English for a Lebanese entrepreneur sourcing manually and selling locally.
You respond with valid JSON only — no markdown, no explanation, no code fences.`;

// ── prompt builder ─────────────────────────────────────────────────────────────

export function buildPrompt(c: ProductCandidate): string {
  return `You are analyzing a private label product opportunity for the Lebanese market.

=== PHASE 3 ANALYSIS ===
${JSON.stringify(c.product_analysis, null, 2)}

=== LEBANON COMPETITION ===
${JSON.stringify(c.lebanon_competition, null, 2)}

=== BRAND CONTEXT ===
Page name: ${c.page_name}
Scaling score: ${c.scaling_score}
Ad count: ${c.ad_count}
Active ads: ${c.active_ad_count}
Max days running: ${c.max_days_running}
Niches hit: ${c.niches_hit.join(", ")}

=== LEBANON MARKET CONTEXT ===
- Shipping: local postal services are unreliable; DHL/FedEx are the trusted alternative
- Quality: strong cultural distrust of "cheap Chinese products"; unboxing videos and demo content help
- Price: Lebanese pound devaluation and economic crisis make buyers hyper price-conscious; value framing beats discount framing
- Trust: buying from an unknown online store feels risky; COD option, reviews, and Instagram presence reduce hesitation

=== YOUR TASK ===
Generate a JSON report with exactly these four fields:

"market_analysis"
  2–3 sentences. Data-driven. Reference the Lebanon competition level, the scaling signal, and the
  specific opportunity or risk for a new private label entrant right now.

"customer_objections"
  Array of exactly 4 objects — one per category (Shipping, Quality, Price, Trust), in that order.
  Write customer_voice as the raw, unfiltered thought a skeptical Lebanese buyer would have.

  CRITICAL: Objections must be PRODUCT-SPECIFIC, not generic. A car organizer's Quality objection
  differs from a sleep mask's. Reference the actual product, its price point, and its specific use
  case in each objection. Generic objections (e.g. "Chinese product stigma" applied identically to
  every product) are not acceptable — anchor each objection in this specific product's context.

  Schema per object:
  {
    "category": "Shipping" | "Quality" | "Price" | "Trust",
    "customer_voice": "...",
    "why_it_matters_in_lebanon": "one sentence — the Lebanon-specific reason",
    "counter": "one concrete action for the product page or ad that neutralises this objection"
  }

"agent_verdict"
  2–3 plain sentences. What is the opportunity, what is the single biggest risk?

"recommended_next_step"
  A structured object with exactly four fields:
  {
    "action": "specific action verb + specific target — e.g. 'Order 5 samples from Alibaba for [product] and test personally within 7 days'",
    "why": "one sentence on why this is the right first action given the data above",
    "success_criteria": "one sentence on how you will know this action worked",
    "kill_criteria": "one sentence on what outcome would tell you to stop pursuing this product entirely"
  }

Respond with ONLY this JSON:
{
  "market_analysis": "...",
  "customer_objections": [ ... ],
  "agent_verdict": "...",
  "recommended_next_step": {
    "action": "...",
    "why": "...",
    "success_criteria": "...",
    "kill_criteria": "..."
  }
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
  recommended_next_step: RecommendedNextStep;
}

function isValidObjection(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.category === "string" && o.category.length > 0 &&
    typeof o.customer_voice === "string" && o.customer_voice.length > 0 &&
    typeof o.why_it_matters_in_lebanon === "string" && o.why_it_matters_in_lebanon.length > 0 &&
    typeof o.counter === "string" && o.counter.length > 0
  );
}

function isValidNextStep(v: unknown): v is RecommendedNextStep {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.action === "string" && o.action.length > 0 &&
    typeof o.why === "string" && o.why.length > 0 &&
    typeof o.success_criteria === "string" && o.success_criteria.length > 0 &&
    typeof o.kill_criteria === "string" && o.kill_criteria.length > 0
  );
}

function parseResponse(raw: string, productName: string): ClaudeAnalysis | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as ClaudeAnalysis;

    if (!parsed.market_analysis || typeof parsed.market_analysis !== "string") {
      throw new Error("market_analysis is missing or not a string");
    }
    if (!Array.isArray(parsed.customer_objections)) {
      throw new Error("customer_objections is not an array");
    }
    if (parsed.customer_objections.length !== 4) {
      throw new Error(
        `Expected exactly 4 customer_objections, got ${parsed.customer_objections.length}`,
      );
    }
    if (!parsed.customer_objections.every(isValidObjection)) {
      throw new Error("One or more customer_objections is missing required fields");
    }
    if (!isValidNextStep(parsed.recommended_next_step)) {
      throw new Error("recommended_next_step is missing required fields or wrong shape");
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
  const productName = candidate.product_analysis?.identification.product_name ?? candidate.page_name;
  let raw: string;
  try {
    raw = await askClaude(buildPrompt(candidate), SYSTEM_PROMPT, MODEL_DEEP);
  } catch (err) {
    log.warn(`Claude call failed for "${productName}"`, {
      error: (err as Error).message,
    });
    return null;
  }

  const analysis = parseResponse(raw, productName);
  if (!analysis) return null;

  return {
    ...candidate,
    market_analysis: analysis.market_analysis,
    customer_objections: mapObjections(analysis.customer_objections),
    agent_verdict: analysis.agent_verdict,
    recommended_next_step: analysis.recommended_next_step,
    week_generated: new Date().toISOString().split("T")[0],
  };
}

// ── Filter criteria ────────────────────────────────────────────────────────────
// Target: 5-10 eligible candidates per run

function skipReason(c: ProductCandidate): string | null {
  if (c.lebanon_competition?.competition_level === "Heavy")
    return "competition_level=Heavy";
  if (c.analysis_status !== "success")
    return `analysis_status=${c.analysis_status}`;
  if (c.product_analysis?.winning_product_assessment?.verdict === "weak_signal")
    return "verdict=weak_signal";
  // Proxy for private_label_fit=low — update if private_label_fit is added to the Phase 3 schema
  if (c.product_analysis?.economics_estimate?.viable_for_private_label === false)
    return "viable_for_private_label=false";
  return null;
}

// ── Cost estimation ────────────────────────────────────────────────────────────
// Rough estimate: Opus 4.7 at $15/1M input + $75/1M output

const EST_INPUT_TOKENS = 3000;  // average per call for this prompt structure
const EST_OUTPUT_TOKENS = 800;
const OPUS_INPUT_CPM  = 15;     // cost per 1M tokens
const OPUS_OUTPUT_CPM = 75;

function estimateCost(calls: number): string {
  const usd = calls * (
    (EST_INPUT_TOKENS  * OPUS_INPUT_CPM  / 1_000_000) +
    (EST_OUTPUT_TOKENS * OPUS_OUTPUT_CPM / 1_000_000)
  );
  return `~$${usd.toFixed(3)}`;
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("ANTHROPIC_API_KEY is not set. Phase 5 requires Claude.");
    process.exit(1);
  }

  const { askClaude } = await import("../utils/claude");

  if (!fs.existsSync(INPUT_PATH)) {
    log.error(`candidates-with-competition.json not found. Run Phases 2–4 first.`);
    process.exit(1);
  }

  let candidates: Phase3Output;
  try {
    candidates = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8")) as Phase3Output;
  } catch (err) {
    log.error("Failed to parse candidates-with-competition.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    log.error("candidates-with-competition.json is empty. Run Phases 2–4 first.");
    process.exit(1);
  }

  const total = candidates.length;

  // ── Filter pass — log each candidate with its global index ───────────────────
  const skippedReasons: Record<string, number> = {};
  const eligibleWithIndex: Array<{ candidate: ProductCandidate; globalIndex: number }> = [];

  for (let i = 0; i < total; i++) {
    const c = candidates[i];
    const reason = skipReason(c);
    if (reason) {
      log.info(`[${i + 1}/${total}] page_name=${c.page_name} SKIPPED reason="${reason}"`);
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    } else {
      eligibleWithIndex.push({ candidate: c, globalIndex: i });
    }
  }

  log.info(`Phase 5 — ${eligibleWithIndex.length} eligible of ${total} candidates`, {
    model: MODEL_DEEP,
  });

  if (eligibleWithIndex.length === 0) {
    log.warn("No candidates passed the filter — nothing to analyse.");
    process.exit(0);
  }

  // ── Analysis loop ─────────────────────────────────────────────────────────────
  const reports: ProductReport[] = [];
  let successCount = 0;
  let failedCount = 0;

  for (const { candidate, globalIndex } of eligibleWithIndex) {
    const product = candidate.product_analysis?.identification.product_name ?? candidate.page_name;
    const report = await analyseProduct(candidate, askClaude);

    if (report) {
      const verdict = report.product_analysis?.winning_product_assessment.verdict ?? "unknown";
      log.info(
        `[${globalIndex + 1}/${total}] page_name=${candidate.page_name} product="${product}" status=success verdict=${verdict}`,
      );
      reports.push(report);
      successCount++;
    } else {
      log.warn(
        `[${globalIndex + 1}/${total}] page_name=${candidate.page_name} product="${product}" status=failed`,
      );
      failedCount++;
    }
  }

  if (reports.length === 0) {
    log.error("No reports generated — all Claude calls failed. Check API key and quota.");
    process.exit(1);
  }

  // ── Write output ──────────────────────────────────────────────────────────────
  const output: Phase5Output = reports;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");

  // ── End-of-run summary ────────────────────────────────────────────────────────
  log.info("Phase 5 summary", {
    totalCandidatesFromPhase4: total,
    skipped: total - eligibleWithIndex.length,
    skippedReasonBreakdown: skippedReasons,
    eligible: eligibleWithIndex.length,
    successful: successCount,
    failed: failedCount,
    estimatedOpusCost: estimateCost(successCount),
  });
  log.info(`Wrote ${reports.length} reports to ${OUTPUT_PATH}`);
  log.info("Run `npm run phase6` to write reports to Notion.");
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 5 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}
