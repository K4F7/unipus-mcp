/**
 * Per-paper failure policy for the listen / speak grind loops (#98).
 *
 * A failed or timed-out paper is reported and skipped; the account only stops on
 * failures nothing later can fix (refusal / no LLM, login or auth) or after
 * UNIPUS_MAX_CONSECUTIVE_FAILURES papers fail in a row. There is no server-side
 * "skip" API: an unsubmitted paper stays the current one, so the next round
 * retries it from a fresh loadPaper — the streak cap keeps that bounded.
 */
import { resolveClioOverflowSkips, resolveConcurrentRetry, resolveMaxConsecutiveFailures, resolveNetWait } from "./limits.js";
import { isClioAudioOverflow } from "./clio-speech.js";
import { isNetworkFailure, networkDownReason, type NetworkWaiter } from "./net-wait.js";
import type { FindHistoryTrainingTaskResult } from "./history-training-tasks.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";

/** part/submit / submitAnswer 4021「请勿多设备同时作答」: another session reloaded the paper token. */
export function isConcurrentAnswerError(message: string | undefined): boolean {
  return /4021|多设备同时作答/.test(String(message ?? ""));
}

/** Login / auth failures: every later request would fail the same way. */
export function isAuthFailure(detail: string, errorClass?: ErrorClass): boolean {
  return errorClass === "FORBIDDEN" || /no jwt|AUTH_REQUIRED|AUTH_FAILED|\b401\b|JWT 无效|未登录|登录(已)?(过期|失效)/.test(detail);
}

/** Clio capacity failure on long free-talk (#104): skip soft, not a network wait. */
export function isClioCapacityFailure(detail: unknown): boolean {
  return isClioAudioOverflow(detail);
}

/** Round cap: the week's need plus at most `need` skipped papers (never below the streak cap). */
export function defaultMaxRounds(need: number, env?: NodeJS.ProcessEnv): number {
  // Soft Clio-1006 skips use round-- and do not burn the streak, but still give the
  // week loop headroom if a caller forgets that (#104 / #105 Codex).
  return need + Math.max(need, resolveMaxConsecutiveFailures(env)) + resolveClioOverflowSkips(env);
}

/** weekly-grind exit code when an account hit the consecutive-failure stop (#110). */
export const EXIT_STREAK_STOPPED = 7;

/** Counts papers failed in a row; `fail` returns the stop reason once the cap is hit. */
export function createFailureStreak(env?: NodeJS.ProcessEnv) {
  const max = resolveMaxConsecutiveFailures(env);
  let reasons: string[] = [];
  return {
    fail(detail: string): string | null {
      reasons.push(detail);
      return reasons.length >= max ? `连续 ${reasons.length} 张失败，停号：${reasons.join(" | ")}` : null;
    },
    ok() {
      reasons = [];
    },
  };
}

/**
 * Bounded 4021 handling: wait, let `reload` re-check the paper is still ours and
 * unsubmitted (it takes a fresh token or says why not to resend), then resend.
 * `note` explains a final failure for the JSONL ("" when 4021 never happened).
 */
export async function retryOnConcurrent<R extends { isError: boolean; message?: string }>(
  first: R,
  opts: {
    env?: NodeJS.ProcessEnv;
    sleep: (ms: number) => Promise<void>;
    label: string;
    reload: () => Promise<{ ok: true } | { ok: false; detail: string }>;
    resubmit: () => Promise<R>;
  },
): Promise<{ result: R; note: string }> {
  const { retries, waitMs } = resolveConcurrentRetry(opts.env);
  let result = first;
  let retried = 0;
  while (result.isError && isConcurrentAnswerError(result.message) && retried < retries) {
    retried++;
    console.error(`[4021] ${opts.label} 多设备作答，${waitMs}ms 后第 ${retried}/${retries} 次重试`);
    await opts.sleep(waitMs);
    const fresh = await opts.reload();
    if (!fresh.ok) return { result, note: `；4021 后不重交：${fresh.detail}` };
    result = await opts.resubmit();
  }
  return { result, note: retried > 0 ? `（4021 已重试 ${retried} 次）` : "" };
}

/**
 * The ledger says this account already submitted the current paper (#100); App
 * history decides. Listed → skip; lookup failed → skip conservatively; not listed
 * while the server still offers the paper → the ledger row is stale, answer it.
 * Returns the skip reason, or null to answer.
 */
export async function ledgerSkipReason(
  lookup: () => Promise<FindHistoryTrainingTaskResult>,
  taskId: string,
  ansVersion: number,
): Promise<string | null> {
  const paper = `${taskId} v${ansVersion}`;
  const lookupFailed = (why: string) => `状态文件记录 ${paper} 已交，App 历史查询失败，保守跳过：${why}`;
  let found: FindHistoryTrainingTaskResult;
  try {
    found = await lookup();
  } catch (error) {
    return lookupFailed(toError(error).message);
  }
  if (found.isError) return lookupFailed(found.message);
  const task = found.task;
  if (task != null && (task.ansVersion == null || task.ansVersion === ansVersion)) {
    return `状态文件与 App 历史都显示 ${paper} 已交，跳过不重复交`;
  }
  console.error(`[ledger] 状态文件记录 ${paper} 已交，但 App 历史没有这张、服务器仍在出它：按服务器重新作答`);
  return null;
}

/** What one paper round reports back to the loop (listen / speak round results fit). */
export type PaperRound =
  | { ok: true; taskId: string }
  | {
      ok: false;
      taskId: string | null;
      detail: string;
      refused?: boolean;
      errorClass?: ErrorClass;
      /** Already submitted (ledger + App history): skipped, never a failure (#100). */
      skippedExisting?: boolean;
    };

/** A round that threw (e.g. NETWORK) — fails that paper only. */
export type ThrownRound = {
  ok: false;
  taskId: null;
  detail: string;
  errorClass: ErrorClass;
  refused?: undefined;
  skippedExisting?: undefined;
};

export type PaperLoopResult = {
  completed: number;
  taskIds: string[];
  stoppedReason?: string;
  errorClass?: ErrorClass;
  /** A paper was refused for lack of a valid LLM answer; the account must stop. */
  refused?: boolean;
  /** Papers skipped after a failure. */
  warnings?: string[];
  /** Network stayed down past UNIPUS_NET_WAIT_MAX_MS (#102): resumable, not the account's fault. */
  networkDown?: boolean;
  /** Stopped by the consecutive-failure rule (#110): do not restart this account. */
  streakStopped?: boolean;
};

/**
 * Shared listen / speak grind loop (#98): run papers until `need` are submitted,
 * report every round, skip a failed paper, stop on refusal / auth failure, after
 * the failure streak cap, or when the server still shows the same paper after a
 * successful submit.
 */
export async function runPaperLoop<R extends PaperRound>(opts: {
  skill: "听" | "说";
  need: number;
  maxRounds: number;
  env?: NodeJS.ProcessEnv;
  /** Current server paper (null when not logged in); compared before / after a submit. */
  status: () => Promise<Record<string, unknown> | null>;
  /** Status read after a submit; default `status`. */
  statusAfter?: () => Promise<Record<string, unknown> | null>;
  completeOne: () => Promise<R>;
  report: (r: R | ThrownRound) => Promise<void>;
  onSubmitted?: (r: Extract<R, { ok: true }>) => void;
  /** Network-outage wait (#102); absent → network failures count like any other. */
  waitNetwork?: NetworkWaiter;
}): Promise<PaperLoopResult> {
  const taskIds: string[] = [];
  const warnings: string[] = [];
  const streak = createFailureStreak(opts.env);
  let lastSkipped: string | null | undefined;
  let errorClass: ErrorClass | undefined;
  let netRetries = resolveNetWait(opts.env).retries;
  let overflowSkips = resolveClioOverflowSkips(opts.env);
  const done = (extra: Partial<PaperLoopResult> = {}): PaperLoopResult => ({
    completed: taskIds.length,
    taskIds,
    ...(warnings.length ? { warnings } : {}),
    ...(errorClass ? { errorClass } : {}),
    ...extra,
  });
  for (let round = 1; round <= opts.maxRounds && taskIds.length < opts.need; round++) {
    let result: R | ThrownRound;
    let before: Record<string, unknown> | null = null;
    try {
      before = await opts.status();
      result = await opts.completeOne();
    } catch (error) {
      const err = toError(error);
      const cls = classifyError(err);
      result = { ok: false, taskId: null, detail: `${cls}: ${err.message}`, errorClass: cls };
    }
    try {
      await opts.report(result);
    } catch (error) {
      // The JSONL is also the idempotency ledger: never go on without it.
      return done({ stoppedReason: `结果写入失败，停号：${toError(error).message}` });
    }
    if (!result.ok && result.skippedExisting) {
      // No skip API: the server offers the same submitted paper again, so a repeat ends the skill.
      if (lastSkipped === result.taskId) {
        return done({ stoppedReason: `服务器仍在出已交的 ${result.taskId}，停止本项（不计失败）：${result.detail}` });
      }
      lastSkipped = result.taskId;
      warnings.push(`跳过 ${result.taskId ?? "?"}：${result.detail}`);
      continue;
    }
    lastSkipped = undefined;
    if (!result.ok && opts.waitNetwork && netRetries > 0 && isNetworkFailure(result.detail) && !isAuthFailure(result.detail, result.errorClass)) {
      // Not this paper's fault: wait the outage out, then retry the same paper
      // (fresh loadPaper + ledger / App-history check, so no double submit).
      if (!(await opts.waitNetwork(`${opts.skill} 第 ${round} 轮：${result.detail}`))) {
        return done({ stoppedReason: networkDownReason(result.detail), networkDown: true, errorClass: "NETWORK" });
      }
      netRetries--;
      round--;
      continue;
    }
    if (!result.ok && overflowSkips > 0 && isClioCapacityFailure(result.detail) && !isAuthFailure(result.detail, result.errorClass)) {
      // Clio 1006: soft-skip without burning the consecutive-failure streak or maxRounds (#104).
      // The server will offer the same paper again; overflowSkips bounds how often we do that.
      overflowSkips--;
      errorClass ??= result.errorClass ?? "CLIO_CAPACITY";
      warnings.push(`跳过 ${result.taskId ?? "?"}（Clio 1006，不计连续失败，剩 ${overflowSkips}）：${result.detail}`);
      console.error(
        `[clio-1006] ${opts.skill} 第 ${round} 轮失败，跳过本张（不计连续失败/轮次，剩软跳过 ${overflowSkips}）：${result.detail}`,
      );
      round--;
      continue;
    }
    if (!result.ok) {
      errorClass ??= result.errorClass;
      if (result.refused) return done({ stoppedReason: result.detail, refused: true });
      if (isAuthFailure(result.detail, result.errorClass)) return done({ stoppedReason: result.detail });
      const stop = streak.fail(result.detail);
      if (stop) return done({ stoppedReason: stop, streakStopped: true });
      warnings.push(`跳过 ${result.taskId ?? "?"}：${result.detail}`);
      console.error(`[grind] ${opts.skill} 第 ${round} 轮失败，跳过本张继续：${result.detail}`);
      continue;
    }
    streak.ok();
    taskIds.push(result.taskId);
    opts.onSubmitted?.(result as Extract<R, { ok: true }>);
    try {
      const after = await (opts.statusAfter ?? opts.status)();
      if (after?.taskId != null && before?.taskId != null && String(after.taskId) === String(before.taskId) && after.status === before.status) {
        return done({ stoppedReason: "same taskId+status after submit" });
      }
    } catch (error) {
      warnings.push(`交卷后状态检查失败：${toError(error).message}`);
    }
  }
  return done();
}
