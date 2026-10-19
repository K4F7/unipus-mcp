/**
 * Active-time budgets (wall time minus VM freezes, #100) so no stage can wedge the grind (#92). Defaults follow the
 * App capture (AI turn 58–72 s, score out ≈10–20 s after submit, AI report
 * generated within minutes when it is generated at all). Invalid or too-small
 * env values fall back to the default.
 */
import { activeNow } from "./watchdog.js";

function envNumber(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max = Infinity): number {
  const raw = env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

export type PollBudget = { pollMs: number; maxMs: number };

/** App history score poll after submit (听/说): UNIPUS_SCORE_POLL_MS / UNIPUS_SCORE_MAX_MS. */
/** Legacy "N tries × pollMs" test ports → the equivalent wall-clock budget. */
export function budgetFromTries(tries: number, pollMs: number): PollBudget {
  return { pollMs, maxMs: (Math.max(1, tries) - 1) * pollMs };
}

/** Total cap of one LLM request. grok-4.5 free-talk scripts take 23–74s end to end (#100 probe). */
export function resolveLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_LLM_TIMEOUT_MS", 180_000, 5_000);
}

/** No response body byte this long after the request → give up (gateway answers in 2–4s, #100). */
export function resolveLlmFirstByteMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_LLM_FIRST_BYTE_MS", 30_000, 1_000);
}

/** Streamed body silent this long → stalled (reasoning streams pause up to ~21s, #100). */
export function resolveLlmIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_LLM_IDLE_MS", 60_000, 1_000);
}

/** max_tokens per LLM request; 300 truncated 200+-word free-talk scripts on non-reasoning models. */
export function resolveLlmMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(envNumber(env, "UNIPUS_LLM_MAX_TOKENS", 1024, 64));
}

export function resolveScorePoll(env: NodeJS.ProcessEnv = process.env): PollBudget {
  return {
    pollMs: envNumber(env, "UNIPUS_SCORE_POLL_MS", 5_000, 500),
    maxMs: envNumber(env, "UNIPUS_SCORE_MAX_MS", 180_000, 0),
  };
}

/** part-report poll after a speak paper: UNIPUS_AI_REPORT_POLL_MS / UNIPUS_AI_REPORT_MAX_MS (0 = read once). */
export function resolveAiReportPoll(env: NodeJS.ProcessEnv = process.env): PollBudget {
  return {
    pollMs: envNumber(env, "UNIPUS_AI_REPORT_POLL_MS", 30_000, 1_000),
    maxMs: envNumber(env, "UNIPUS_AI_REPORT_MAX_MS", 600_000, 0),
  };
}

/** Total wall time for one voiced record's TTS→Clio→upload retries (and AI bot-audio TTS fallback). */
export function resolveTtsRetryMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_TTS_RETRY_MAX_MS", 600_000, 10_000);
}

/** Cap on one Clio scoring request; Clio needs ≈2.2× the audio length (94 s audio → 215 s, #98). */
export function resolveClioMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_CLIO_MAX_MS", 360_000, 45_000);
}

/** Papers failed in a row before the account stops (a single failure only skips that paper, #98). */
export function resolveMaxConsecutiveFailures(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(envNumber(env, "UNIPUS_MAX_CONSECUTIVE_FAILURES", 2, 1, 50));
}

/** 4021 (another session took the paper token): wait, then retry this many times (#98). */
export function resolveConcurrentRetry(env: NodeJS.ProcessEnv = process.env): { retries: number; waitMs: number } {
  return {
    retries: Math.round(envNumber(env, "UNIPUS_CONCURRENT_RETRIES", 2, 0, 10)),
    waitMs: envNumber(env, "UNIPUS_CONCURRENT_RETRY_MS", 60_000, 0),
  };
}

/** One speak part (answer build or the whole AI dialog) before its part/submit. */
export function resolvePartMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_PART_MAX_MS", 900_000, 60_000);
}

/** One whole paper up to its last part/submit (post-submit polls have their own caps). */
export function resolvePaperMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_PAPER_MAX_MS", 2_400_000, 60_000);
}

/** D9: minimum wall time between AI-dialog saves (App 58–72 s per turn; 0 = no pacing). */
export function resolveAiTurnMinMs(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_AI_TURN_MIN_MS", 55_000, 0);
}

/** 自由表达 recording must last at least this many seconds (server marks <90 s as too short). */
export function resolveFreeTalkMinSec(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_FREE_TALK_MIN_SEC", 90, 0);
}

/** 自由表达 TTS speed (Kokoro speed / say rate factor); slower = clearer for the server ASR. */
export function resolveFreeTalkTtsSpeed(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "UNIPUS_FREE_TALK_TTS_SPEED", 0.85, 0.5, 1.5);
}

/** One-line summary for doctor. */
export function describeLimits(env: NodeJS.ProcessEnv = process.env): string {
  const s = resolveScorePoll(env);
  const r = resolveAiReportPoll(env);
  const c = resolveConcurrentRetry(env);
  return (
    `App 分轮询 ${s.pollMs}ms/上限 ${s.maxMs}ms；part-report 轮询 ${r.pollMs}ms/上限 ${r.maxMs}ms；` +
    `TTS 重试总 ${resolveTtsRetryMaxMs(env)}ms；单 part ${resolvePartMaxMs(env)}ms；整卷 ${resolvePaperMaxMs(env)}ms；` +
    `AI 每轮 ≥${resolveAiTurnMinMs(env)}ms；自由表达 ≥${resolveFreeTalkMinSec(env)}s 语速 ${resolveFreeTalkTtsSpeed(env)}；` +
    `LLM 单次 ${resolveLlmTimeoutMs(env)}ms/首包 ${resolveLlmFirstByteMs(env)}ms/空闲 ${resolveLlmIdleMs(env)}ms/max_tokens ${resolveLlmMaxTokens(env)}；Clio 单次 ≤${resolveClioMaxMs(env)}ms；` +
    `连续失败 ${resolveMaxConsecutiveFailures(env)} 张停号；4021 等 ${c.waitMs}ms 重试 ${c.retries} 次`
  );
}

/**
 * Bounded poll: call `attempt` until it returns a value, at most 1 + maxMs/pollMs
 * times and never past maxMs of active time (whichever comes first).
 */
export async function pollWithin<T>(
  budget: PollBudget,
  attempt: (i: number) => Promise<T | undefined>,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<T | undefined> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? activeNow;
  const start = now();
  const tries = 1 + Math.floor(budget.maxMs / budget.pollMs);
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      if (now() - start + budget.pollMs > budget.maxMs) break;
      await sleep(budget.pollMs);
    }
    const out = await attempt(i);
    if (out !== undefined) return out;
  }
  return undefined;
}
