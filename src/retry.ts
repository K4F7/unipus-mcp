/** Shared retry/backoff + error classification for flaky upstreams (Edge TTS, fetch). */
import { activeNow, withWallTimeout } from "./watchdog.js";

export type ErrorClass =
  | "TIMEOUT"
  | "NETWORK"
  | "FORBIDDEN"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "UNKNOWN";

/** Normalise thrown values (node-edge-tts rejects with bare strings like 'Timed out'). */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}

export function classifyError(value: unknown): ErrorClass {
  const err = toError(value);
  const msg = err.message;
  const cause = (err as { cause?: { code?: string } }).cause?.code ?? "";
  if (/timed out|timeout|超时|ETIMEDOUT/i.test(msg) || cause === "UND_ERR_CONNECT_TIMEOUT") {
    return "TIMEOUT";
  }
  const status = /Unexpected server response: (\d{3})/.exec(msg)?.[1];
  if (status === "403" || status === "401") return "FORBIDDEN";
  if (status?.startsWith("4")) return "HTTP_4XX";
  if (status?.startsWith("5")) return "HTTP_5XX";
  if (
    /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|UND_ERR/i.test(
      `${msg} ${cause}`,
    )
  ) {
    return "NETWORK";
  }
  return "UNKNOWN";
}

export function isRetryableClass(c: ErrorClass): boolean {
  return c === "TIMEOUT" || c === "NETWORK" || c === "HTTP_5XX";
}

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Extra predicate; default: retry TIMEOUT/NETWORK/5XX only. */
  shouldRetry?: (error: Error, cls: ErrorClass, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff (base·2^n, capped, ±20% jitter). Non-retryable errors throw immediately. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? realSleep;
  const should =
    opts.shouldRetry ?? ((_e: Error, c: ErrorClass) => isRetryableClass(c));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = toError(raw);
      if (attempt >= attempts || !should(err, classifyError(err), attempt)) throw err;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      await sleep(Math.round(delay * (0.8 + Math.random() * 0.4)));
    }
  }
}

/** Reject after ms of wall time (#88); underlying work is abandoned (caller should clean up). */
export { withWallTimeout as withTimeout };

export type BudgetRetryOptions = {
  /** Shown in logs and the final error, e.g. the record tag. */
  label: string;
  /** Wall-clock budget for all attempts and backoffs together. */
  budgetMs: number;
  /** Attempt cap (default 4). */
  attempts?: number;
  /** First backoff; doubles each retry up to maxDelayMs (defaults 3000 / 30000). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Errors that must not be retried (rethrown unchanged). */
  isFatal?: (error: Error) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/**
 * Bounded retry (#98): every attempt gets only the budget left (a hung attempt is
 * cut there), retries back off exponentially, and every failure is logged so a
 * stall leaves evidence. Throws `${label}：N 次均失败…：<last cause>` at the end.
 */
export async function retryWithinBudget<T>(
  fn: (remainingMs: number, attempt: number) => Promise<T>,
  opts: BudgetRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseDelayMs ?? 3_000;
  const max = opts.maxDelayMs ?? 30_000;
  const now = opts.now ?? activeNow;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((line: string) => console.error(line));
  const start = now();
  const deadline = start + opts.budgetMs;
  let last: Error = new Error("no attempt");
  let attempt = 0;
  while (attempt < attempts) {
    // A VM suspend during backoff can overshoot the deadline: never start a late attempt.
    if (attempt > 0 && deadline - now() <= 0) break;
    attempt++;
    const remaining = Math.max(1, deadline - now());
    try {
      return await withWallTimeout(fn(remaining, attempt), remaining, `${opts.label} 重试总时长上限`, { now });
    } catch (raw) {
      last = toError(raw);
      if (opts.isFatal?.(last)) throw last;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      const retry = attempt < attempts && now() + delay < deadline;
      log(
        `[retry] ${opts.label} 第 ${attempt}/${attempts} 次失败（已用 ${now() - start}ms）：${last.message}；` +
          (retry ? `${delay}ms 后重试` : "不再重试"),
      );
      if (!retry) break;
      await sleep(delay);
    }
  }
  throw new Error(`${opts.label}：${attempt} 次均失败（${now() - start}ms）：${last.message}`, { cause: last });
}
