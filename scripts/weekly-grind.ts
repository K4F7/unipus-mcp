#!/usr/bin/env node
/**
 * Stateless weekly listen/speak grind CLI for harness routines.
 *
 *   npx tsx scripts/weekly-grind.ts [--account <id>]… | --all
 *     [--listen-only | --speak-only] [--skip-placement]
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
  npx tsx scripts/weekly-grind.ts [--account <id>]… [--listen-only | --speak-only] [--skip-placement]
  npx tsx scripts/weekly-grind.ts --all [--listen-only | --speak-only] [--skip-placement]

Per account (sequential, stateless):
  1. rt → refresh_jwt; else/fail → password from env; CAPTCHA → skip
  2. listWeekProgress; skip if enabled sides already done
  3. headless submit gaps (listen loadPaper+submitAnswer; speak silent TTS→upload→submit)
  4. stdout JSON summary (account_id, alias/note, grind, skips, before/after, errors)

Grind side filter (two layers; CLI overrides meta):
  --listen-only   only听力 (overrides meta.grind)
  --speak-only    only口语 (overrides meta.grind)
  neither         use each account meta.grind (both|listen|speak; default both)
  --listen-only and --speak-only are mutually exclusive

Placement / 定级:
  type=grade accounts lack weekDoneTaskCount → NEEDS_PLACEMENT
  default: auto-run headless placement (loadPaper+submitAnswer) then weekly
  --skip-placement or meta.skip_placement=true → summary status needs_placement (no auto)

--all = every accounts/ dir with jwt|rt
neither --all nor --account → active only

Per-account policy: npx tsx scripts/accounts.ts grind <id> both|listen|speak
Harness routines call this CLI; MCP stays scheduler-free (no run_weekly tool).
CAPTCHA_REQUIRED → status skipped_captcha（继续其他账户）；有头登录后用\n  npx tsx scripts/import-tokens.ts --account <id> --jwt-file …\nNever prints jwt / rt / password.`);
}

async function main(): Promise<void> {
  const parsed = parseWeeklyGrindArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    printHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  const summary = sanitizeSummaryForStdout(
    await runWeeklyGrind(parsed.mode, {
      grindOverride: parsed.grindOverride,
      skipPlacement: parsed.skipPlacement,
    }),
  );
  console.log(JSON.stringify(summary, null, 2));
  const hardFail = summary.accounts.some(
    (a) => a.status === "error" && a.errors.length > 0,
  );
  // captcha skips are soft; exit 0 if anything ground/done/skipped
  const anyOk = summary.accounts.some((a) =>
    ["done", "ground", "skipped_done", "skipped_captcha", "needs_placement"].includes(
      a.status,
    ),
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
