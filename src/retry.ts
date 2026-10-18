/** Shared retry/backoff + error classification for flaky upstreams (Edge TTS, fetch). */
import { withWallTimeout } from "./watchdog.js";

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
