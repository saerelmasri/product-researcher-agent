/**
 * One-time setup script — creates all required properties across all three Notion databases.
 *
 * Run once (safe to re-run — Notion ignores properties that already exist):
 *   npm run setup
 *
 * Before running, make sure these are set in .env:
 *   NOTION_API_KEY          — your Notion integration token
 *   NOTION_DATABASE_ID      — Products table (Flow B output)
 *   NOTION_NICHES_DB_ID     — Niches table (Flow A)
 *   NOTION_KEYWORDS_DB_ID   — Keywords table (Flow A)
 *
 * How to get a database ID from Notion:
 *   Open the database as a full page → copy the URL.
 *   The ID is the 32-character string before the "?" in the URL.
 *   Example: notion.so/myworkspace/357274118e338058878ed443a8e4393e?v=...
 *                                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ this part
 */
import { Client } from "@notionhq/client";
import * as dotenv from "dotenv";

import { log } from "./logger";

dotenv.config();

async function setupProductsDb(notion: Client, dbId: string): Promise<void> {
  log.info(`Setting up Products database (${dbId})...`);
  await notion.databases.update({
    database_id: dbId,
    properties: {
      "Score": {
        number: { format: "number" },
      },
      "Verdict": {
        select: {
          options: [
            { name: "Investigate", color: "green" },
            { name: "Watch",       color: "yellow" },
            { name: "Skip",        color: "red" },
          ],
        },
      },
      "Selling price": {
        number: { format: "dollar" },
      },
      "Alibaba cost range": {
        rich_text: {},
      },
      "Estimated margin %": {
        number: { format: "percent" },
      },
      "Weight kg": {
        number: { format: "number" },
      },
      "Lebanon competition": {
        select: {
          options: [
            { name: "Low",    color: "green" },
            { name: "Medium", color: "yellow" },
            { name: "High",   color: "red" },
          ],
        },
      },
      "Niche": {
        rich_text: {},
      },
      "Status": {
        select: {
          options: [
            { name: "New",       color: "blue" },
            { name: "Reviewing", color: "yellow" },
            { name: "Ordered",   color: "green" },
            { name: "Rejected",  color: "red" },
          ],
        },
      },
      "Week generated": {
        date: {},
      },
    },
  });
  log.info("  ✓ Products database ready");
}

async function setupNichesDb(notion: Client, dbId: string): Promise<void> {
  log.info(`Setting up Niches database (${dbId})...`);
  await notion.databases.update({
    database_id: dbId,
    properties: {
      "Status": {
        select: {
          options: [
            { name: "Active",   color: "green" },
            { name: "Paused",   color: "yellow" },
            { name: "Rejected", color: "red" },
          ],
        },
      },
      "Price Range": {
        rich_text: {},
      },
      "Upsell / Repeat": {
        rich_text: {},
      },
      "Lebanon Import Risk": {
        select: {
          options: [
            { name: "Low",    color: "green" },
            { name: "Medium", color: "yellow" },
            { name: "High",   color: "red" },
          ],
        },
      },
      "Lebanon Import Notes": {
        rich_text: {},
      },
      "Trend Status": {
        select: {
          options: [
            { name: "Rising",    color: "green" },
            { name: "Stable",    color: "blue" },
            { name: "Declining", color: "red" },
          ],
        },
      },
      "Created At": {
        date: {},
      },
    },
  });
  log.info("  ✓ Niches database ready");
}

async function setupKeywordsDb(notion: Client, dbId: string): Promise<void> {
  log.info(`Setting up Keywords database (${dbId})...`);
  await notion.databases.update({
    database_id: dbId,
    properties: {
      "Niche": {
        rich_text: {},
      },
      "Created At": {
        date: {},
      },
    },
  });
  log.info("  ✓ Keywords database ready");
}

async function main(): Promise<void> {
  const auth            = process.env.NOTION_API_KEY?.trim();
  const productsDbId    = process.env.NOTION_DATABASE_ID?.trim();
  const nichesDbId      = process.env.NOTION_NICHES_DB_ID?.trim();
  const keywordsDbId    = process.env.NOTION_KEYWORDS_DB_ID?.trim();

  if (!auth) {
    log.error("NOTION_API_KEY is not set.");
    process.exit(1);
  }

  const notion = new Client({ auth });
  let ran = 0;

  if (productsDbId) {
    await setupProductsDb(notion, productsDbId);
    ran++;
  } else {
    log.warn("NOTION_DATABASE_ID not set — skipping Products database setup");
  }

  if (nichesDbId) {
    await setupNichesDb(notion, nichesDbId);
    ran++;
  } else {
    log.warn("NOTION_NICHES_DB_ID not set — skipping Niches database setup");
  }

  if (keywordsDbId) {
    await setupKeywordsDb(notion, keywordsDbId);
    ran++;
  } else {
    log.warn("NOTION_KEYWORDS_DB_ID not set — skipping Keywords database setup");
  }

  if (ran === 0) {
    log.error("No database IDs found in .env — nothing was set up.");
    log.error("Add NOTION_DATABASE_ID, NOTION_NICHES_DB_ID, NOTION_KEYWORDS_DB_ID to .env and re-run.");
    process.exit(1);
  }

  log.info(`Setup complete — ${ran}/3 database(s) configured.`);

  if (!nichesDbId || !keywordsDbId) {
    log.info("To finish Flow A setup, add the missing database IDs to .env and re-run `npm run setup`.");
  } else {
    log.info("All databases ready. Flow A: `npm run phase0` → `npm run phase0-5` → `npm run phase1`");
    log.info("Flow B: `npm run pipeline` (or `npm run scheduler` to run every Monday at 8am)");
  }
}

main().catch((err) => {
  log.error("Setup failed", { error: (err as Error).message });
  process.exit(1);
});
