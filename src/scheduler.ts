/**
 * Flow B — Weekly cron scheduler
 *
 * Starts the pipeline every Monday at 8:00am (local server time).
 * Keep this process running in the background (e.g. via pm2 or a terminal session).
 *
 * Usage:
 *   npm run scheduler
 *
 * IMPORTANT: This only runs Flow B (phases 2–7).
 * Flow A (phases 0, 0.5, 1) must be triggered manually when you want fresh niches.
 */
import * as dotenv from "dotenv";
import { spawnSync } from "child_process";
import * as path from "path";
import cron from "node-cron";

import { log } from "./utils/logger";

dotenv.config();

const ROOT    = path.resolve(__dirname, "..");
const TS_NODE = path.join(ROOT, "node_modules", ".bin", "ts-node");
const PIPELINE = path.join(__dirname, "pipeline.ts");

// Every Monday at 8:00am — matches CLAUDE.md spec
const SCHEDULE = "0 8 * * 1";

function runPipeline(): void {
  log.info("Cron triggered — starting weekly pipeline");

  const result = spawnSync(TS_NODE, [PIPELINE], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });

  if (result.status !== 0) {
    log.error("Weekly pipeline exited with non-zero status — check logs above");
  } else {
    log.info("Weekly pipeline finished successfully");
  }
}

// Validate cron expression before starting
if (!cron.validate(SCHEDULE)) {
  log.error(`Invalid cron expression: "${SCHEDULE}"`);
  process.exit(1);
}

log.info(`Scheduler started. Pipeline runs: ${SCHEDULE} (every Monday at 8:00am local time)`);
log.info("Keep this process running. Use Ctrl+C to stop.");

cron.schedule(SCHEDULE, runPipeline, { timezone: "Asia/Beirut" });
