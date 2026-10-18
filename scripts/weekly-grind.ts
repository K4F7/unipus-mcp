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
import { createPaperReporter, redactSecrets } from "../src/paper-result.js";
import { installProcessStallWatchdog } from "../src/watchdog.js";

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/weekly-grind.ts [--account <id>]… [--listen-only | --speak-only] [--skip-placement]
  npx tsx scripts/weekly-grind.ts --all [--listen-only | --speak-only] [--skip-placement]

Per account (sequential, stateless):
  1. rt → refresh_jwt; else/fail → password from env; CAPTCHA → skip
  2. listWeekProgress; skip if enabled sides already done
  3. headless submit gaps (listen loadPaper+submitAnswer; speak silent TTS→upload→submit)
  4. stdout is JSONL (one JSON object per line, printed as it happens):
       {"event":"paper","at","note","skill":"听|说","taskId","ansVersion","score","scoreIsOut",
        "status":"ok|low_score|grading|failed|skipped_existing","error"}   ← after every paper
       {"event":"summary", accounts:[…], totals, started_at, finished_at}  ← last line
       {"event":"fatal","error_code":"STALL"|…, "message"}                 ← on stall / crash
     paper lines are also appended to UNIPUS_RESULTS_FILE
     (default ~/.config/unipus-mcp/results.jsonl); a taskId+ansVersion already
     recorded there as ok/low_score/grading is never submitted again.

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
Per-account usage: npx tsx scripts/accounts.ts usage <id> self|assist … [--listen N|platform] [--speak N|platform]
  本周目标 = min(usage 配置篇数, 平台 weekFrequency)；0 = 这一侧本周不做；assist 到期后跳过
Harness routines call this CLI; MCP stays scheduler-free (no run_weekly tool).
Exit codes (stdout ends with the summary line when accounts were resolved):
  0  at least one account done/ground/skipped_* / needs_placement
     skipped_expired = 帮刷窗口已过（meta.usage），不登录、不交卷
     skipped_not_started = 帮刷 --from 还没到，不登录、不交卷
     启用侧配置篇数全为 0 → skipped_done（不登录、不定级）
  1  every targeted account ended in status=error (see errors / error_class)
  2  usage error or no target accounts
  3  stall watchdog: no log line / stage advance for UNIPUS_STALL_MINUTES (default 15; 0 = off)
TTS: unset → macOS say (silent, -o file) / other platforms Kokoro; UNIPUS_TTS_ENGINE=kokoro|piper|say overrides
  (edge|flite|auto legacy, deprecated). Self-check: npx tsx scripts/doctor.ts
LLM (required, answers only from it — no template / heuristic / empty blank):
  UNIPUS_LLM_BASE_URL  UNIPUS_LLM_MODEL  UNIPUS_LLM_API_KEY   (no defaults; SILICONFLOW_API_KEY ignored)
  missing or failed probe → status=error ANSWER_REFUSED before login; no valid answer → paper not submitted, account stops

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
  installProcessStallWatchdog("weekly-grind");
  const summary = sanitizeSummaryForStdout(
    await runWeeklyGrind(parsed.mode, {
      grindOverride: parsed.grindOverride,
      skipPlacement: parsed.skipPlacement,
      resultsFor: (note) => createPaperReporter({ note }),
    }),
  );
  console.log(JSON.stringify({ event: "summary", ...summary }));
  const hardFail = summary.accounts.some(
    (a) => a.status === "error" && a.errors.length > 0,
  );
  // captcha skips are soft; exit 0 if anything ground/done/skipped
  const anyOk = summary.accounts.some((a) =>
    ["done", "ground", "skipped_done", "skipped_captcha", "skipped_expired", "skipped_not_started", "needs_placement"].includes(
      a.status,
    ),
  );
  if (summary.accounts.length === 0) {
    console.error("无目标账户（检查 --account / --all / active-account.txt）");
    process.exitCode = 2;
    return;
  }
  // exitCode (not process.exit) so piped stdout JSON fully flushes.
  if (hardFail && !anyOk) process.exitCode = 1;
}

main().catch((error) => {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  console.error(message);
  // Keep stdout machine-readable even on a crash outside per-account handling.
  console.log(JSON.stringify({ event: "fatal", error_code: "CRASH", message }));
  process.exitCode = 1;
});
