/**
 * Flow B — Weekly research pipeline orchestrator
 *
 * Runs phases 2 → 7 in sequence. Stops immediately if any phase fails.
 * Reads discovered-keywords.json (produced by Flow A) to drive the scraper.
 *
 * Usage:
 *   npm run pipeline          — full run (Claude required for phases 3 and 6)
 *   npm run pipeline --offline — uses heuristic phases (no Claude needed)
 *
 * Never chain this into Flow A (phases 0, 0.5, 1). Those are manual-only.
 */
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as path from "path";

import { log } from "./utils/logger";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");
const TS_NODE = path.join(ROOT, "node_modules", ".bin", "ts-node");
const PHASES_DIR = path.join(__dirname, "phases");

function phase(file: string): string {
  return path.join(PHASES_DIR, file);
}

function run(label: string, scriptPath: string): void {
  log.info(`▶  ${label}`);
  const start = Date.now();

  const result = spawnSync(TS_NODE, [scriptPath], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.status !== 0) {
    log.error(`✗  ${label} failed after ${elapsed}s — pipeline halted`);
    process.exit(1);
  }

  log.info(`✓  ${label} completed in ${elapsed}s`);
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  const hasClaudeKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

  if (!hasClaudeKey && !offline) {
    log.error(
      "ANTHROPIC_API_KEY is not set. Run with `--offline` to use heuristic phases instead:",
    );
    log.error("  npx ts-node src/pipeline.ts --offline");
    process.exit(1);
  }

  if (offline) {
    log.info("Pipeline starting in OFFLINE mode (heuristic phases — no Claude required)");
  } else {
    log.info("Pipeline starting (Claude enabled)");
  }

  const pipelineStart = Date.now();

  // Phase 2 — Meta Ad Library scraper (always runs)
  run("Phase 2 — Meta scraper", phase("phase2-scraper.ts"));

  // Phase 3 — Product scoring (Claude or heuristic)
  if (offline) {
    run("Phase 3.1 — Heuristic scorer (offline)", phase("phase3-1-heuristic.ts"));
  } else {
    run("Phase 3 — Claude filter", phase("phase3-filter.ts"));
  }

  // Phase 4 — Lebanon competition check (always runs)
  run("Phase 4 — Lebanon competition", phase("phase4-competition.ts"));

  // Phase 5 — Alibaba supplier lookup (always runs)
  run("Phase 5 — Alibaba suppliers", phase("phase5-suppliers.ts"));

  // Phase 6 — Deep analysis (Claude or template)
  if (offline) {
    run("Phase 6.1 — Templated analysis (offline)", phase("phase6-1-template.ts"));
  } else {
    run("Phase 6 — Claude deep analysis", phase("phase6-analysis.ts"));
  }

  // Phase 7 — Notion writer (always runs)
  run("Phase 7 — Notion writer", phase("phase7-notion.ts"));

  const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(0);
  log.info(`Pipeline complete in ${totalElapsed}s — check Notion for new product pages.`);
}

main().catch((err) => {
  log.error("Pipeline crashed", {
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
