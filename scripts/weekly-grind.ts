#!/usr/bin/env node
/**
 * Stateless weekly listen/speak grind CLI for harness routines.
 *
 *   npx tsx scripts/weekly-grind.ts [--account <id>]… | --all
 *
 * No MCP scheduler. Never prints jwt/rt/password.
 * Leaves active-account.txt unchanged (token saves use makeActive:false).
 */
import {
  parseWeeklyGrindArgs,
  runWeeklyGrind,
  sanitizeSummaryForStdout,
} from "../src/weekly-grind.js";

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/weekly-grind.ts [--account <id>]…
  npx tsx scripts/weekly-grind.ts --all

Per account (sequential, stateless):
  1. rt → refresh_jwt; else/fail → password from env; CAPTCHA → skip
  2. listWeekProgress; skip if listen+speak already done
  3. headless submit gaps (listen loadPaper+submitAnswer; speak silent TTS→upload→submit)
  4. stdout JSON summary (account_id, alias/note, before/after, errors)

--all = every accounts/ dir with jwt|rt
neither --all nor --account → active only

Harness routines call this CLI; MCP stays stateless (no run_weekly tool).
Never prints jwt / rt / password.`);
}

async function main(): Promise<void> {
  const { mode, help } = parseWeeklyGrindArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    process.exit(0);
  }
  const summary = sanitizeSummaryForStdout(await runWeeklyGrind(mode));
  console.log(JSON.stringify(summary, null, 2));
  const hardFail = summary.accounts.some(
    (a) => a.status === "error" && a.errors.length > 0,
  );
  // captcha skips are soft; exit 0 if anything ground/done/skipped
  const anyOk = summary.accounts.some((a) =>
    ["done", "ground", "skipped_done", "skipped_captcha"].includes(a.status),
  );
  if (summary.accounts.length === 0) {
    console.error("无目标账户（检查 --account / --all / active-account.txt）");
    process.exit(2);
  }
  if (hardFail && !anyOk) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
