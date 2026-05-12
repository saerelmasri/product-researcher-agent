import { Client } from "@notionhq/client";
import * as dotenv from "dotenv";

import { CandidateNiche, ValidatedNiche } from "../types";
import { log } from "./logger";

dotenv.config();

function getClient(): Client {
  const auth = process.env.NOTION_API_KEY?.trim();
  if (!auth) throw new Error("NOTION_API_KEY is not set.");
  return new Client({ auth });
}

function getNichesDbId(): string {
  const id = process.env.NOTION_NICHES_DB_ID?.trim();
  if (!id) throw new Error("NOTION_NICHES_DB_ID is not set.");
  return id;
}

function getKeywordsDbId(): string {
  const id = process.env.NOTION_KEYWORDS_DB_ID?.trim();
  if (!id) throw new Error("NOTION_KEYWORDS_DB_ID is not set.");
  return id;
}

// ── Niches table ───────────────────────────────────────────────────────────────

/**
 * Returns the names of all niches already in the Notion Niches table.
 * Returns [] if the database is not configured or the call fails.
 */
export async function getExistingNicheNames(): Promise<string[]> {
  try {
    const notion = getClient();
    const dbId = getNichesDbId();
    const res = await notion.databases.query({ database_id: dbId });
    return res.results
      .map((page) => {
        if (page.object !== "page") return "";
        const props = (page as { properties: Record<string, unknown> }).properties;
        const nameProp = props["Name"] as { title?: Array<{ plain_text: string }> } | undefined;
        return nameProp?.title?.[0]?.plain_text ?? "";
      })
      .filter(Boolean);
  } catch (err) {
    log.warn("Could not read Notion Niches table — skipping deduplication", {
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Writes new niches to the Notion Niches table.
 * Skips silently if NOTION_NICHES_DB_ID is not configured.
 */
export async function writeNichesToNotion(
  niches: CandidateNiche[],
  validatedMap: Map<string, ValidatedNiche>,
): Promise<void> {
  let notion: Client;
  let dbId: string;
  try {
    notion = getClient();
    dbId = getNichesDbId();
  } catch {
    log.warn("NOTION_NICHES_DB_ID not set — skipping Notion niche write");
    return;
  }

  for (const n of niches) {
    const trend = validatedMap.get(n.niche);
    try {
      await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          Name:                  { title: [{ text: { content: n.niche } }] },
          Status:                { select: { name: "Active" } },
          "Price Range":         { rich_text: [{ text: { content: n.priceRange } }] },
          "Upsell / Repeat":     { rich_text: [{ text: { content: n.upsellOrRepeat } }] },
          "Lebanon Import Risk": { select: { name: n.lebanonImportRisk.charAt(0).toUpperCase() + n.lebanonImportRisk.slice(1) } },
          "Lebanon Import Notes":{ rich_text: [{ text: { content: n.lebanonImportNotes } }] },
          "Trend Status": {
            select: { name: trend?.status ?? "Stable" },
          },
          "Created At": { date: { start: new Date().toISOString().split("T")[0] } },
        },
      });
      log.info(`  Notion: wrote niche "${n.niche}"`);
    } catch (err) {
      log.warn(`  Notion: failed to write niche "${n.niche}"`, {
        error: (err as Error).message,
      });
    }
  }
}

// ── Keywords table ─────────────────────────────────────────────────────────────

/**
 * Returns the set of niche names that already have keywords in the Notion Keywords table.
 * Returns empty set if database is not configured or call fails.
 */
export async function getNichesWithKeywords(): Promise<Set<string>> {
  try {
    const notion = getClient();
    const dbId = getKeywordsDbId();
    const res = await notion.databases.query({ database_id: dbId });
    const niches = new Set<string>();
    for (const page of res.results) {
      if (page.object !== "page") continue;
      const props = (page as { properties: Record<string, unknown> }).properties;
      const nicheProp = props["Niche"] as
        | { rich_text?: Array<{ plain_text: string }> }
        | undefined;
      const niche = nicheProp?.rich_text?.[0]?.plain_text;
      if (niche) niches.add(niche);
    }
    return niches;
  } catch (err) {
    log.warn("Could not read Notion Keywords table — skipping keyword deduplication", {
      error: (err as Error).message,
    });
    return new Set();
  }
}

/**
 * Writes keywords for a niche to the Notion Keywords table.
 * Skips silently if NOTION_KEYWORDS_DB_ID is not configured.
 */
export async function writeKeywordsToNotion(
  niche: string,
  keywords: string[],
): Promise<void> {
  let notion: Client;
  let dbId: string;
  try {
    notion = getClient();
    dbId = getKeywordsDbId();
  } catch {
    log.warn(`NOTION_KEYWORDS_DB_ID not set — skipping keyword write for "${niche}"`);
    return;
  }

  for (const kw of keywords) {
    try {
      await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          Name: { title: [{ text: { content: kw } }] },
          Niche: { rich_text: [{ text: { content: niche } }] },
          "Created At": { date: { start: new Date().toISOString().split("T")[0] } },
        },
      });
    } catch (err) {
      log.warn(`  Notion: failed to write keyword "${kw}" for niche "${niche}"`, {
        error: (err as Error).message,
      });
    }
  }
  log.info(`  Notion: wrote ${keywords.length} keywords for "${niche}"`);
}
