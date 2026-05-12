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

// ── Notion property names — update these if your database uses different column names ──
const PROP = {
  NAME:                "Name",
  SCALING_SCORE:       "Scaling Score",
  VERDICT:             "Verdict",
  PRIVATE_LABEL_FIT:   "Private Label Fit",
  DURABILITY:          "Durability",
  CATEGORY:            "Category",
  NICHES_HIT:          "Niches Hit",
  COMPETITION_LEVEL:   "Lebanon Competition",
  TOTAL_COMPETITORS:   "Total Competitors",
  SERIOUS_COMPETITORS: "Serious Competitors",
  MANUAL_CHECK_URL:    "Manual Check URL",
  STATUS:              "Status",
  WEEK_GENERATED:      "Week Generated",
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

// ── assessment blocks (Section 1) ─────────────────────────────────────────────

function assessmentBlocks(r: ProductReport): Block[] {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const wpa = r.product_analysis!.winning_product_assessment;
  const blocks: Block[] = [];

  blocks.push(h2("Product Assessment"));
  blocks.push(bullet(`Verdict: ${wpa.verdict}`));
  blocks.push(bullet(`Scaling Signal: ${wpa.scaling_signal_quality}`));
  blocks.push(bullet(`Durability: ${wpa.durability_assessment}`));

  if (wpa.confidence_signals.length > 0) {
    blocks.push(para("Confidence Signals:"));
    wpa.confidence_signals.forEach((s) => blocks.push(bullet(`✅ ${s}`)));
  }

  if (wpa.concern_signals.length > 0) {
    blocks.push(para("Concern Signals:"));
    wpa.concern_signals.forEach((s) => blocks.push(bullet(`⚠️ ${s}`)));
  }

  blocks.push(para(wpa.verdict_reasoning));
  blocks.push(divider());

  return blocks;
}

// ── product intelligence blocks (Section 2) ────────────────────────────────────

function productIntelligenceBlocks(r: ProductReport): Block[] {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const pi = r.product_analysis!.product_intelligence;
  const blocks: Block[] = [];

  blocks.push(h2("Product Intelligence"));

  if (pi.problems_solved.length > 0) {
    blocks.push(para("Problem(s) solved:"));
    pi.problems_solved.forEach((p) => blocks.push(bullet(p)));
  }

  if (pi.audience_segments.length > 0) {
    blocks.push(bullet(`Audience: ${pi.audience_segments.join(", ")}`));
  }

  if (pi.emotional_drivers.length > 0) {
    blocks.push(bullet(`Emotional drivers: ${pi.emotional_drivers.join(", ")}`));
  }

  blocks.push(bullet(`Main hook: ${pi.main_hook}`));

  if (pi.positioning_angles.length > 0) {
    blocks.push(para("Positioning angles:"));
    pi.positioning_angles.forEach((a) =>
      blocks.push(bullet(`${a.angle}: ${a.example_from_ad}`)),
    );
  }

  if (pi.market_introduction_ideas.length > 0) {
    blocks.push(para("Market introduction ideas:"));
    pi.market_introduction_ideas.forEach((idea) => blocks.push(bullet(idea)));
  }

  blocks.push(divider());

  return blocks;
}

// ── economics estimate blocks (Section 3) ─────────────────────────────────────

function economicsBlocks(r: ProductReport): Block[] {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const eco = r.product_analysis!.economics_estimate;
  const blocks: Block[] = [];

  blocks.push(h2("Economics Estimate"));
  blocks.push(para(`Category cost range: ${eco.category_cost_range_usd}`));
  blocks.push(para(`Category shipping range: ${eco.category_shipping_range_usd}`));
  blocks.push(para(`Confidence: ${eco.confidence}`));
  blocks.push(para(eco.margin_universe_check));
  blocks.push(para(`Viable for private label: ${String(eco.viable_for_private_label)}`));
  blocks.push(callout(
    "Based on category-level averages only. Verify with actual supplier quote before ordering.",
    "⚠️" as "🎯",
  ));
  blocks.push(divider());

  return blocks;
}

// ── lebanon competition blocks (Section 6) ────────────────────────────────────

function competitionBlocks(r: ProductReport): Block[] {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const comp = r.lebanon_competition!;
  const blocks: Block[] = [];

  blocks.push(h2("Lebanon Competition"));
  blocks.push(para(
    `Level: ${comp.competition_level} (${comp.total_competitors} total, ${comp.serious_competitors} serious)`,
  ));

  if (comp.competitors.length > 0) {
    blocks.push(para("Competitors found:"));
    comp.competitors.forEach((c) => {
      const lastSeen = c.last_seen.split("T")[0];
      blocks.push(bullet(
        `${c.page_name} — ${c.ad_count} ads, ${c.max_days_running} days max, last seen ${lastSeen}`,
      ));
    });
  } else {
    blocks.push(para("No competitors found in Meta Ad Library Lebanon search."));
  }

  if (comp.manual_check_url) {
    blocks.push({
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text" as const, text: { content: "🔍 Manual check: " } },
          {
            type: "text" as const,
            text: { content: comp.manual_check_url, link: { url: comp.manual_check_url } },
          },
        ],
      },
    });
  }

  return blocks;
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
  // product_analysis and lebanon_competition are guaranteed non-null by Phase 5 output
  if (!r.product_analysis || !r.lebanon_competition) {
    return [para("Analysis data unavailable for this report.")];
  }

  const blocks: Block[] = [];

  // 1. Product assessment — verdict, signals, reasoning
  blocks.push(...assessmentBlocks(r));

  // 2. Product intelligence — problems, audience, hooks, angles, entry ideas
  blocks.push(...productIntelligenceBlocks(r));

  // 3. Economics estimate — cost range, margin check, viability
  blocks.push(...economicsBlocks(r));

  // 4. Market analysis (Claude Phase 5 synthesis)
  blocks.push(h2("📈 Market Analysis"));
  blocks.push(para(r.market_analysis));
  blocks.push(divider());

  // 5. Customer objections — one toggle per objection
  blocks.push(h2("💬 Customer Objections (Lebanon)"));
  r.customer_objections.forEach((obj) => blocks.push(objectionToggle(obj)));
  blocks.push(divider());

  // 6. Agent verdict — callout for visual prominence
  blocks.push(h2("🎯 Agent Verdict"));
  blocks.push(callout(r.agent_verdict));
  blocks.push(h2("📋 Recommended Next Step"));
  blocks.push(bullet(`Action: ${r.recommended_next_step.action}`));
  blocks.push(bullet(`Why: ${r.recommended_next_step.why}`));
  blocks.push(bullet(`Success criteria: ${r.recommended_next_step.success_criteria}`));
  blocks.push(bullet(`Kill signal: ${r.recommended_next_step.kill_criteria}`));
  blocks.push(divider());

  // 7. Lebanon competition detail — competitor list + manual check link
  blocks.push(...competitionBlocks(r));

  return blocks;
}

// ── duplicate check ────────────────────────────────────────────────────────────

async function alreadyExists(
  notion: Client,
  dbId: string,
  report: ProductReport,
): Promise<boolean> {
  const productName = report.product_analysis?.identification.product_name ?? report.page_name;
  const weekGenerated = report.week_generated;
  try {
    const res = await notion.databases.query({
      database_id: dbId,
      filter: {
        and: [
          { property: PROP.NAME,           title: { equals: productName } },
          { property: PROP.WEEK_GENERATED, date:  { equals: weekGenerated } },
        ],
      },
    });
    return res.results.length > 0;
  } catch (err) {
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
  // Phase 5 only produces reports with non-null product_analysis and lebanon_competition
  if (!r.product_analysis || !r.lebanon_competition) {
    throw new Error(`createPage called with null product_analysis or lebanon_competition on "${r.page_name}"`);
  }

  const id = r.product_analysis.identification;
  const wpa = r.product_analysis.winning_product_assessment;
  const pi = r.product_analysis.product_intelligence;
  const comp = r.lebanon_competition;

  const rawProperties: Record<string, unknown> = {
    [PROP.NAME]: {
      title: [{ text: { content: trunc(id.product_name) } }],
    },
    [PROP.SCALING_SCORE]: {
      number: r.scaling_score,
    },
    [PROP.VERDICT]: {
      select: { name: wpa.verdict },
    },
    [PROP.PRIVATE_LABEL_FIT]: {
      select: { name: pi.private_label_fit ?? "unknown" },
    },
    [PROP.DURABILITY]: {
      select: { name: wpa.durability_assessment },
    },
    [PROP.CATEGORY]: {
      select: { name: id.category },
    },
    [PROP.NICHES_HIT]: {
      rich_text: [{ text: { content: trunc(r.niches_hit.join(", ")) } }],
    },
    ...(comp.competition_level !== "Unknown"
      ? { [PROP.COMPETITION_LEVEL]: { select: { name: comp.competition_level } } }
      : {}),
    [PROP.TOTAL_COMPETITORS]: {
      number: comp.total_competitors,
    },
    [PROP.SERIOUS_COMPETITORS]: {
      number: comp.serious_competitors,
    },
    [PROP.MANUAL_CHECK_URL]: {
      url: comp.manual_check_url || null,
    },
    [PROP.STATUS]: {
      select: { name: "New" },
    },
    [PROP.WEEK_GENERATED]: {
      date: { start: r.week_generated },
    },
  };

  // Strip any undefined values (TypeScript safety)
  const properties = Object.fromEntries(
    Object.entries(rawProperties).filter(([, v]) => v !== undefined),
  ) as CreatePageParameters["properties"];

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
    const productName = report.product_analysis?.identification.product_name ?? report.page_name;
    const exists = await alreadyExists(notion, dbId, report);
    if (exists) {
      log.info(`  Skipping "${productName}" — already in Notion for week ${report.week_generated}`);
      skipped++;
      continue;
    }

    try {
      await createPage(notion, dbId, report);
      const verdict = report.product_analysis?.winning_product_assessment.verdict ?? "unknown";
      log.info(`  Created page: "${productName}" [${verdict}, scaling_score=${report.scaling_score}]`);
      created++;
    } catch (err) {
      log.error(`  Failed to create page for "${productName}"`, {
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
