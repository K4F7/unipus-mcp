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

Accounts overlap up to UNIPUS_GRIND_CONCURRENCY (default 3, integer 1–32).
One account finishes listen before speak; the two sides do not run together.

Per account (stateless):
  1. rt → refresh_jwt; else/fail → password from env/file; CAPTCHA → skip
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

--all = every accounts/ dir with jwt|rt|password
neither --all nor --account → active only

Per-account policy: npx tsx scripts/accounts.ts grind <id> both|listen|speak
Harness routines call this CLI; MCP stays scheduler-free (no run_weekly tool).
Exit codes (stdout always carries the JSON summary when accounts were resolved):
  0  at least one account done/ground/skipped_* / needs_placement
     skipped_expired = 帮刷窗口已过（meta.usage），不登录、不交卷
  1  every targeted account ended in status=error (see errors / error_class)
  2  usage error or no target accounts
  3  at least one account needs an agent answer (see next_actions; answer then resume)
  4  at least one submitted task is still grading (see next_actions; query get_training_result)
TTS: unset = say on macOS, Kokoro on Windows/Linux. Explicit kokoro|piper|say|flite. edge|auto 即将弃用
Preflight: npm run doctor -- --speech
Agent answers: UNIPUS_AGENT_ANSWER_DIR=/absolute/path; npm run answers -- list/reply
  One paper emits one stderr answer_batch. Each group_id is one question for one agent.
  UNIPUS_AGENT_ANSWER_WAIT_MS=600000(default); 0 = emit the batch and return needs_answer

CAPTCHA_REQUIRED → status skipped_captcha（继续其他账户）；有头登录后用\n  npx tsx scripts/import-tokens.ts --account <id> --jwt-file …\nNever prints jwt / rt / password.`);
}

async function main(): Promise<void> {
  const parsed = parseWeeklyGrindArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
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
    ["done", "ground", "skipped_done", "skipped_captcha", "skipped_expired", "needs_placement"].includes(
      a.status,
    ),
  );
  if (summary.accounts.length === 0) {
    console.error("无目标账户（检查 --account / --all / active-account.txt）");
    process.exitCode = 2;
    return;
  }
  if (summary.accounts.some((a) => a.status === "needs_answer")) {
    process.exitCode = 3;
    return;
  }
  if (summary.accounts.some((a) => a.status === "grading_pending")) {
    process.exitCode = 4;
    return;
  }
  // exitCode (not process.exit) so piped stdout JSON fully flushes.
  if (hardFail && !anyOk) process.exitCode = 1;
}

main().catch((error) => {
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    "[redacted-jwt]",
  );
  console.error(message);
  // Keep stdout machine-readable even on a crash outside per-account handling.
  console.log(JSON.stringify({ accounts: [], fatal: { message } }, null, 2));
  process.exitCode = 1;
});
