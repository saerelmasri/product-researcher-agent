/**
 * Phase 6.1 — Templated analysis stopgap
 *
 * Offline replacement for Phase 6. Produces the identical reports.json schema
 * using rule-based templates so Phase 7 can run without an Anthropic API key.
 *
 * IMPORTANT: The output schema must stay in sync with phase6-analysis.ts.
 * If ProductReport changes, update both files.
 */
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
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "candidates.json");
const OUTPUT_PATH = path.join(DATA_DIR, "reports.json");

// ── market analysis ────────────────────────────────────────────────────────────

function buildMarketAnalysis(c: ProductCandidate): string {
  const adCount = c.source_ads.length;
  const competitionLine =
    c.lebanon_competition === "Low"
      ? "No active local advertisers were found in Lebanon, leaving the market open for a first mover."
      : c.lebanon_competition === "Medium"
        ? "A small number of local advertisers are active in Lebanon, indicating early-stage competition."
        : c.lebanon_competition === "High"
          ? "Lebanon already has multiple active advertisers in this category — differentiation will be essential."
          : "Lebanon competition data was unavailable; a manual Facebook Ads Library check is recommended before ordering.";

  const marginLine =
    c.estimated_margin_pct >= 70
      ? `At an estimated ${c.estimated_margin_pct}% gross margin on a $${c.selling_price_usd} retail price, the unit economics support ad spend.`
      : `The estimated ${c.estimated_margin_pct}% margin is tighter than ideal — keep ad costs low and validate pricing before scaling.`;

  return (
    `${c.product_name} generated ${adCount} active ad${adCount === 1 ? "" : "s"} on Meta across US, UK, CA, and AU — ` +
    `signalling real advertiser interest in the ${c.niche} niche. ` +
    `${marginLine} ` +
    `${competitionLine}`
  );
}

// ── objections ─────────────────────────────────────────────────────────────────

function shippingObjection(c: ProductCandidate): CustomerObjection {
  const hasSupplier = c.alibaba_suppliers.length > 0;
  return {
    category: "Shipping",
    customer_voice:
      `Will this actually arrive? I've ordered online before and waited 3 months ` +
      `for something that never showed up.`,
    why_it_matters_in_lebanon:
      `Lebanon's national postal service has a poor reliability record; customers ` +
      `default to assuming the worst unless a trusted courier is named explicitly.`,
    counter: hasSupplier
      ? `State "Shipped via DHL/FedEx with tracking" prominently on the product page and ` +
        `in the ad. Display the estimated delivery window (e.g. 3–5 business days) and ` +
        `add a tracking-number follow-up message to every order confirmation.`
      : `Source from a supplier (see ${c.alibaba_search_url}) that ships via DHL or FedEx. ` +
        `Display the courier logo and tracking promise prominently — it removes the single ` +
        `biggest hesitation before the add-to-cart click.`,
  };
}

function qualityObjection(c: ProductCandidate): CustomerObjection {
  const hasCerts =
    c.alibaba_suppliers.length > 0 &&
    c.alibaba_suppliers.some((s) => s.certifications.length > 0);
  const certNote = hasCerts
    ? `At least one shortlisted supplier holds relevant certifications — feature these on the product page.`
    : `Request samples before ordering and shoot an honest unboxing video showing build quality.`;

  return {
    category: "Quality",
    customer_voice:
      `These are just cheap Chinese products that look great in the photo but fall ` +
      `apart after two weeks. No thanks.`,
    why_it_matters_in_lebanon:
      `Lebanese consumers have been burned by low-quality imports sold through informal ` +
      `channels. The phrase "Chinese product" carries a specific stigma that must be ` +
      `actively countered with proof, not just promises.`,
    counter:
      `Post a 60-second product demo video showing the item under real use — ` +
      `drop tests, flexibility, texture close-ups. ${certNote} ` +
      `"30-day return, no questions asked" as a policy headline reduces perceived risk.`,
  };
}

function priceObjection(c: ProductCandidate): CustomerObjection {
  const crossSellHint =
    c.cross_sell_opportunities.length > 0
      ? `Consider bundling with ${c.cross_sell_opportunities[0]} to increase perceived value.`
      : `Frame the price against the cost of the problem it solves, not against cheaper alternatives.`;

  return {
    category: "Price",
    customer_voice:
      `$${c.selling_price_usd}? With everything going up and the dollar rate what it is, ` +
      `I can't just spend that on something I'm not sure about.`,
    why_it_matters_in_lebanon:
      `The Lebanese economic crisis and currency volatility have made buyers hyper-conscious ` +
      `of USD-priced goods. Price sensitivity is highest on first purchases from unknown stores.`,
    counter:
      `Lead with value, not price. Show the problem prominently ("spending $${Math.round(c.selling_price_usd * 3)} a year ` +
      `on X? This pays for itself in Y weeks"). ${crossSellHint} ` +
      `Offer a COD option — it removes the financial risk of paying upfront to an unknown store.`,
  };
}

function trustObjection(c: ProductCandidate): CustomerObjection {
  return {
    category: "Trust",
    customer_voice:
      `I've never heard of this brand. How do I know they won't take my money ` +
      `and disappear? At least with a shop I know I can go back if something's wrong.`,
    why_it_matters_in_lebanon:
      `Word-of-mouth is the dominant trust signal in Lebanon. An unknown online store ` +
      `with no physical presence starts at a deep trust deficit compared to a referred ` +
      `contact or a brand seen in a physical store.`,
    counter:
      `Feature 5+ real customer reviews with photos from Lebanese buyers. Add a WhatsApp ` +
      `chat button — it signals a real person is behind the store. Cash on delivery option ` +
      `converts trust-hesitant buyers who won't pay online but will pay at the door.`,
  };
}

function buildObjections(c: ProductCandidate): CustomerObjection[] {
  return [
    shippingObjection(c),
    qualityObjection(c),
    priceObjection(c),
    trustObjection(c),
  ];
}

// ── verdict & next step ────────────────────────────────────────────────────────

function buildVerdict(c: ProductCandidate): string {
  const competitionNote =
    c.lebanon_competition === "Low"
      ? "with no active local competitors this is a genuine first-mover window"
      : c.lebanon_competition === "Medium"
        ? "early-stage local competition exists but the market is not yet saturated"
        : "high local competition means differentiation or a sub-niche focus is required";

  if (c.verdict === "Investigate") {
    return (
      `${c.product_name} scored ${c.score}/100 and clears the private label bar on ` +
      `margin, weight, and repeat purchase — ${competitionNote}. ` +
      `The main risk is supplier quality consistency; request samples before committing ` +
      `to an opening order. If samples pass inspection, this is worth a test run of ` +
      `50–100 units with a small Meta ad budget.`
    );
  }

  return (
    `${c.product_name} scored ${c.score}/100 and is worth watching but not immediately ` +
    `ordering. ${competitionNote.charAt(0).toUpperCase() + competitionNote.slice(1)}. ` +
    `Revisit in 4–6 weeks with fresh ad library data before committing capital.`
  );
}

function buildNextStep(c: ProductCandidate): string {
  const supplierUrl =
    c.alibaba_suppliers.length > 0
      ? c.alibaba_suppliers[0].url || c.alibaba_search_url
      : c.alibaba_search_url;

  if (c.verdict === "Investigate") {
    const priceHint =
      c.alibaba_suppliers.length > 0 && c.alibaba_suppliers[0].price_per_unit
        ? ` at approximately ${c.alibaba_suppliers[0].price_per_unit} per unit`
        : "";
    return (
      `Contact the top Alibaba supplier for "${c.product_name}" (${supplierUrl}), ` +
      `request a sample order of 3–5 units${priceHint}, and test the product personally ` +
      `within the next 7 days. If quality passes, plan a 50-unit opening order with a ` +
      `$${Math.round(c.selling_price_usd * 0.5)} Meta test ad budget over 2 weeks.`
    );
  }

  return (
    `Search "site:facebook.com/ads/library ${c.product_name} Lebanon" twice over the next ` +
    `2 weeks to track whether local competition is growing. Set a calendar reminder to ` +
    `re-run this pipeline in 4 weeks. Do not order samples yet.`
  );
}

// ── builder ────────────────────────────────────────────────────────────────────

export function buildTemplatedReport(c: ProductCandidate): ProductReport {
  return {
    ...c,
    market_analysis: buildMarketAnalysis(c),
    customer_objections: buildObjections(c),
    agent_verdict: buildVerdict(c),
    recommended_next_step: buildNextStep(c),
    week_generated: new Date().toISOString().split("T")[0],
  };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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

  const eligible = candidates.filter(
    (c) =>
      c.lebanon_competition === "Low" ||
      c.lebanon_competition === "Medium" ||
      c.lebanon_competition === "Unknown",
  );
  const skipped = candidates.filter((c) => c.lebanon_competition === "High");

  log.info("Phase 6.1 (templated) starting — no Claude required", {
    totalCandidates: candidates.length,
    eligible: eligible.length,
    skippedHighCompetition: skipped.length,
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

  const reports: ProductReport[] = eligible.map((c) => {
    const report = buildTemplatedReport(c);
    log.info(`  Built templated report for "${c.product_name}" [${c.verdict}]`);
    return report;
  });

  const output: Phase6Output = reports;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  log.info(`Phase 6.1 complete. Wrote ${reports.length} reports to ${OUTPUT_PATH}`);
  log.info("Run `npm run phase7` to write reports to Notion.");

  reports.forEach((r, i) => {
    log.info(`  ${i + 1}. ${r.product_name} [${r.verdict}]`);
    log.info(`     Next step: ${r.recommended_next_step.slice(0, 90)}...`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    log.error("Phase 6.1 crashed", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  });
}
