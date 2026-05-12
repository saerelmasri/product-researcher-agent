import { Client } from "@notionhq/client";
import type {
  CreatePageParameters,
  BlockObjectRequestWithoutChildren,
} from "@notionhq/client/build/src/api-endpoints";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

import { CustomerObjection, Phase5Output, ProductReport } from "../types";
import { log } from "../utils/logger";

dotenv.config();

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const INPUT_PATH = path.join(DATA_DIR, "reports.json");

// ── Notion property names — update these if your database uses different names ──
const PROP = {
  title:          "Name",
  score:          "Score",
  verdict:        "Verdict",
  sellingPrice:   "Selling price",
  marginPct:      "Estimated margin %",
  weightKg:       "Weight kg",
  competition:    "Lebanon competition",
  niche:          "Niche",
  status:         "Status",
  weekGenerated:  "Week generated",
} as const;

type Block     = NonNullable<CreatePageParameters["children"]>[number];
type LeafBlock = BlockObjectRequestWithoutChildren; // blocks that cannot have children

// ── Notion block helpers ───────────────────────────────────────────────────────

const MAX_RICH_TEXT = 1950; // Notion limit is 2000; leave headroom

function trunc(s: string): string {
  return s.length > MAX_RICH_TEXT ? s.slice(0, MAX_RICH_TEXT) + "…" : s;
}

function richText(content: string) {
  return [{ type: "text" as const, text: { content: trunc(content) } }];
}

function h2(text: string): Block {
  return { type: "heading_2", heading_2: { rich_text: richText(text) } };
}

function para(text: string): LeafBlock {
  return { type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function bullet(text: string): LeafBlock {
  return { type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(text) } };
}

function divider(): Block {
  return { type: "divider", divider: {} };
}

function callout(text: string, emoji = "🎯"): Block {
  return {
    type: "callout",
    callout: {
      rich_text: richText(text),
      // EmojiRequest is a string in the Notion SDK — cast required
      icon: { type: "emoji", emoji: emoji as "🎯" },
    },
  };
}

function toggle(summary: string, children: LeafBlock[]): Block {
  return {
    type: "toggle",
    toggle: {
      rich_text: richText(summary),
      children,
    },
  };
}

// ── criteria checklist ─────────────────────────────────────────────────────────

function criteriaBlocks(r: ProductReport): Block[] {
  const check = (pass: boolean, label: string) =>
    bullet(`${pass ? "✅" : "❌"} ${label}`);

  return [
    h2("📊 Score Breakdown"),
    check(r.estimated_margin_pct >= 70, `Gross margin ≥ 70%  →  ${r.estimated_margin_pct}%`),
    check(r.selling_price_usd >= 30,    `Selling price ≥ $30  →  $${r.selling_price_usd}`),
    check(r.weight_kg < 0.5,            `Weight < 0.5 kg  →  ${r.weight_kg} kg`),
    check(r.has_recurring_purchase,     `Repeat purchase potential`),
    check(
      r.lebanon_competition === "Low" || r.lebanon_competition === "Medium",
      `Lebanon competition  →  ${r.lebanon_competition}`,
    ),
    para(`Score rationale: ${r.score_rationale}`),
  ];
}

// ── objection toggles ──────────────────────────────────────────────────────────

function objectionToggle(obj: CustomerObjection): Block {
  const summary = `[${obj.category}]  "${trunc(obj.customer_voice).slice(0, 80)}…"`;
  return toggle(summary, [
    para(`🗣️  ${obj.customer_voice}`),
    para(`🇱🇧  Why it matters in Lebanon: ${obj.why_it_matters_in_lebanon}`),
    para(`✅  Counter: ${obj.counter}`),
  ]);
}

// ── full block list for one report ────────────────────────────────────────────

function buildBlocks(r: ProductReport): Block[] {
  const blocks: Block[] = [];

  // 1. Criteria checklist
  blocks.push(...criteriaBlocks(r));
  blocks.push(divider());

  // 2. Market analysis
  blocks.push(h2("📈 Market Analysis"));
  blocks.push(para(r.market_analysis));
  blocks.push(divider());

  // 3. Cross-sell opportunities
  blocks.push(h2("🔗 Cross-Sell Opportunities"));
  if (r.cross_sell_opportunities.length > 0) {
    r.cross_sell_opportunities.forEach((cs) => blocks.push(bullet(cs)));
  } else {
    blocks.push(para("No cross-sell opportunities identified."));
  }
  blocks.push(divider());

  // 4. Customer objections — one toggle per objection
  blocks.push(h2("💬 Customer Objections (Lebanon)"));
  r.customer_objections.forEach((obj) => blocks.push(objectionToggle(obj)));
  blocks.push(divider());

  // 5. Agent verdict — callout for visual prominence
  blocks.push(h2("🎯 Agent Verdict"));
  blocks.push(callout(r.agent_verdict));
  blocks.push(para(`📋 Recommended next step: ${r.recommended_next_step}`));

  return blocks;
}

// ── duplicate check ────────────────────────────────────────────────────────────

async function alreadyExists(
  notion: Client,
  dbId: string,
  productName: string,
  weekGenerated: string,
): Promise<boolean> {
  try {
    const res = await notion.databases.query({
      database_id: dbId,
      filter: {
        and: [
          { property: PROP.title,         title: { equals: productName } },
          { property: PROP.weekGenerated, date:  { equals: weekGenerated } },
        ],
      },
    });
    return res.results.length > 0;
  } catch (err) {
    // If the filter fails (e.g. property not found), skip the check rather than crash
    log.warn(`Duplicate check failed for "${productName}" — proceeding to create`, {
      error: (err as Error).message,
    });
    return false;
  }
}

// ── page creator ───────────────────────────────────────────────────────────────

async function createPage(
  notion: Client,
  dbId: string,
  r: ProductReport,
): Promise<void> {
  const competitionValue =
    r.lebanon_competition === "Unknown" ? null : r.lebanon_competition;

  const properties: CreatePageParameters["properties"] = {
    [PROP.title]:        { title: richText(r.product_name) },
    [PROP.score]:        { number: r.score },
    [PROP.verdict]:      { select: { name: r.verdict } },
    [PROP.sellingPrice]: { number: r.selling_price_usd },
    [PROP.marginPct]:    { number: r.estimated_margin_pct },
    [PROP.weightKg]:     { number: r.weight_kg },
    [PROP.niche]:        { rich_text: richText(r.niche) },
    [PROP.status]:       { select: { name: "New" } },
    [PROP.weekGenerated]: { date: { start: r.week_generated } },
  };

  if (competitionValue) {
    properties[PROP.competition] = { select: { name: competitionValue } };
  }

  await notion.pages.create({
    parent: { database_id: dbId },
    properties,
    children: buildBlocks(r),
  });
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.NOTION_API_KEY?.trim();
  const dbId   = process.env.NOTION_DATABASE_ID?.trim();

  if (!apiKey) {
    log.error("NOTION_API_KEY is not set.");
    process.exit(1);
  }
  if (!dbId) {
    log.error("NOTION_DATABASE_ID is not set.");
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_PATH)) {
    log.error(`reports.json not found at ${INPUT_PATH}. Run Phase 5 first.`);
    process.exit(1);
  }

  let reports: Phase5Output;
  try {
    reports = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8")) as Phase5Output;
  } catch (err) {
    log.error("Failed to parse reports.json", { error: (err as Error).message });
    process.exit(1);
  }

  if (!Array.isArray(reports) || reports.length === 0) {
    log.error("reports.json is empty. Run Phase 5 first.");
    process.exit(1);
  }

  const notion = new Client({ auth: apiKey });
  log.info(`Phase 6 starting — writing ${reports.length} report(s) to Notion`);

  let created = 0;
  let skipped = 0;

  for (const report of reports) {
    const exists = await alreadyExists(notion, dbId, report.product_name, report.week_generated);
    if (exists) {
      log.info(`  Skipping "${report.product_name}" — already in Notion for week ${report.week_generated}`);
      skipped++;
      continue;
    }

    try {
      await createPage(notion, dbId, report);
      log.info(`  Created page: "${report.product_name}" [${report.verdict}, score ${report.score}]`);
      created++;
    } catch (err) {
      log.error(`  Failed to create page for "${report.product_name}"`, {
        error: (err as Error).message,
      });
    }
  }

  log.info(`Phase 6 complete`, { created, skipped, total: reports.length });
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

export { buildBlocks, createPage };
