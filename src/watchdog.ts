/**
 * Wall-clock timeouts + process stall watchdog (#88), freeze-aware (#100).
 *
 * The box VM gets paused by its host (dmesg: "virtual machine fork", systemd
 * "Watchdog timeout (limit 3min)"). While paused nothing runs but the wall clock
 * keeps going, so on resume every pending deadline is already past: a 45s Clio
 * timeout fired after 1033s and the retry budget was spent before a second try.
 * Timers here tick on `activeNow()` — wall time minus detected freezes — so a
 * freeze neither fires a deadline nor eats a budget, while a live-but-silent
 * socket still times out on schedule.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type Clock = { now?: () => number; tickMs?: number };

/** Exit code when the process-level stall watchdog fires. */
export const EXIT_STALL = 3;
export const DEFAULT_STALL_MINUTES = 15;
/** Exit code when the wall-clock idle watchdog fires (#110): no output for N real minutes, freezes included. */
export const EXIT_IDLE = 6;
export const DEFAULT_IDLE_MINUTES = 30;
/** Ceiling on the time excluded from activeNow per freeze (#110, #112): the excess counts as active time. */
export const DEFAULT_MAX_FROZEN_MS = 20 * 60_000;
const STALL_LOG = "[stall]";

export type StallClock = {
  /** Wall time minus every detected freeze (ms, Date.now scale). */
  now: () => number;
  /** Total frozen time detected so far. */
  stalledMs: () => number;
  stop: () => void;
};

/**
 * Detect process freezes: a `tickMs` heartbeat that arrives more than
 * `thresholdMs` late means the event loop could not run (VM paused / host
 * starved); that gap, minus one tick, is excluded from `now()`. `now()` checks
 * the gap itself, so a caller resumed before the heartbeat still sees it.
 */
export function createStallClock(opts: {
  now?: () => number;
  tickMs?: number;
  thresholdMs?: number;
  /** One freeze excludes at most this (default DEFAULT_MAX_FROZEN_MS, #110/#112); hangs are caught by EXIT_IDLE. */
  maxFrozenMs?: number;
  log?: (line: string) => void;
  /** Called with the gap (ms) of each detected freeze. */
  onFreeze?: (gapMs: number) => void;
} = {}): StallClock {
  const wall = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 1000;
  const thresholdMs = opts.thresholdMs ?? 15_000;
  const maxFrozenMs = opts.maxFrozenMs ?? DEFAULT_MAX_FROZEN_MS;
  const log = opts.log ?? ((line: string) => console.error(line));
  let last = wall();
  let stalled = 0;
  const observe = () => {
    const t = wall();
    const gap = t - last;
    // Move the heartbeat first: the log goes through the stall watchdog's stderr hook, which reads this clock again.
    last = t;
    if (gap > thresholdMs) {
      const excluded = Math.min(maxFrozenMs, gap - tickMs);
      stalled += excluded;
      const sec = (ms: number) => Math.round(ms / 1000);
      log(`${STALL_LOG} 进程冻结约 ${sec(gap)}s（VM 暂停/宿主卡顿/事件循环阻塞），扣除 ${sec(excluded)}s，计入预算 ${sec(gap - excluded)}s`);
      opts.onFreeze?.(gap);
    }
    return t;
  };
  const timer = setInterval(observe, tickMs);
  timer.unref?.();
  return {
    now: () => observe() - stalled,
    stalledMs: () => (observe(), stalled),
    stop: () => clearInterval(timer),
  };
}

let processClock: StallClock | null = null;
const freezeListeners = new Set<(gapMs: number) => void>();

/** Process-wide freeze-aware clock (lazy): the default for every timer and budget. */
export function activeNow(): number {
  processClock ??= createStallClock({ onFreeze: (gap) => freezeListeners.forEach((f) => f(gap)) });
  return processClock.now();
}

/** Subscribe to process freezes detected by activeNow's clock (#112). Returns unsubscribe. */
export function onProcessFreeze(cb: (gapMs: number) => void): () => void {
  activeNow();
  freezeListeners.add(cb);
  return () => freezeListeners.delete(cb);
}

/** Innermost budget deadline (activeNow scale) of the current async call chain. */
const budgetScope = new AsyncLocalStorage<number>();

/**
 * Run `fn` under a budget ending at `deadlineAt` (activeNow scale, #100). Nested
 * scopes keep the tighter deadline, so a part / paper cap bounds every step below
 * it; steps read it with `capToBudget`.
 */
export function withDeadline<T>(deadlineAt: number, fn: () => Promise<T>): Promise<T> {
  return budgetScope.run(Math.min(deadlineAt, budgetScope.getStore() ?? Infinity), fn);
}

/** Time left in the current budget scope (Infinity outside any scope). */
export function remainingBudgetMs(now: () => number = activeNow): number {
  const deadline = budgetScope.getStore();
  return deadline == null ? Infinity : Math.max(0, deadline - now());
}

/** A step timeout hard-capped by the remaining budget (≥1ms). */
export function capToBudget(ms: number, now?: () => number): number {
  return Math.max(1, Math.min(ms, remainingBudgetMs(now)));
}

/** Call `onFire` once `ms` of active time (`activeNow`) has passed. Returns cancel (always call it on settle). */
export function wallClockTimer(ms: number, onFire: () => void, clock: Clock = {}): () => void {
  const now = clock.now ?? activeNow;
  const deadline = now() + ms;
  const timer = setInterval(() => {
    if (now() < deadline) return;
    clearInterval(timer);
    onFire();
  }, Math.max(1, Math.min(clock.tickMs ?? 1000, ms)));
  // Kept ref'd: a pending deadline must be able to settle its promise.
  return () => clearInterval(timer);
}

/** AbortSignal that aborts after `ms` wall time; call `clear()` once the request settles. */
export function wallClockSignal(ms: number, clock?: Clock): { signal: AbortSignal; clear: () => void } {
  const ctl = new AbortController();
  const clear = wallClockTimer(ms, () => {
    const err = new Error(`The operation was aborted due to timeout (${ms}ms)`);
    err.name = "TimeoutError";
    ctl.abort(err);
  }, clock);
  return { signal: ctl.signal, clear };
}

/** Reject with `${label} timed out (ms)` once `ms` wall time passes. */
export function withWallTimeout<T>(p: Promise<T>, ms: number, label: string, clock?: Clock): Promise<T> {
  let cancel = () => {};
  return Promise.race([
    p.finally(() => cancel()),
    new Promise<never>((_, reject) => {
      cancel = wallClockTimer(ms, () => reject(new Error(`${label} timed out (${ms}ms)`)), clock);
    }),
  ]);
}

/** `UNIPUS_STALL_MINUTES` (default 15; 0 = off) → ms, or 0 when disabled. */
export function resolveStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UNIPUS_STALL_MINUTES?.trim();
  const n = raw ? Number(raw) : DEFAULT_STALL_MINUTES;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STALL_MINUTES * 60_000;
  return Math.round(n * 60_000);
}

/** `UNIPUS_IDLE_MINUTES` (default 30; 0 = off) → ms of real wall time without output before EXIT_IDLE (#110). */
export function resolveIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UNIPUS_IDLE_MINUTES?.trim();
  const n = raw ? Number(raw) : DEFAULT_IDLE_MINUTES;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_MINUTES * 60_000;
  return Math.round(n * 60_000);
}

export type StallWatchdog = {
  /** Record progress (new log line / stage advance). */
  touch(stage?: string): void;
  stop(): void;
};

/** Fires `onStall` once when no `touch()` happened for `stallMs` active time (a VM freeze is not a hang). */
export function createStallWatchdog(
  stallMs: number,
  onStall: (info: { idleMs: number; stage: string }) => void,
  clock: Clock = {},
): StallWatchdog {
  const now = clock.now ?? activeNow;
  let last = now();
  let stage = "start";
  const timer = setInterval(() => {
    const idleMs = now() - last;
    if (idleMs < stallMs) return;
    clearInterval(timer);
    onStall({ idleMs, stage });
  }, Math.max(1, Math.min(clock.tickMs ?? 5000, stallMs)));
  timer.unref?.();
  return {
    touch(s) {
      last = now();
      if (s) stage = s;
    },
    stop: () => clearInterval(timer),
  };
}

let active: StallWatchdog | null = null;

/** Mark a stage advance for the installed process watchdog (no-op when none). */
export function markProgress(stage: string): void {
  active?.touch(stage);
}

type Writable = { write: (...a: never[]) => boolean };

export type ProcessWatchdogOptions = {
  env?: NodeJS.ProcessEnv;
  exit?: (code: number) => void;
  /** Test seam; default process.stdout / process.stderr. */
  stdout?: Writable;
  stderr?: Writable;
};

/**
 * CLI entry: any stdout/stderr write or markProgress() counts as progress.
 * On stall prints a `{"event":"fatal","error_code":"STALL",…}` line and exits
 * with EXIT_STALL so a wrapper can restart instead of hanging for hours.
 */
export function installProcessStallWatchdog(
  label: string,
  opts: ProcessWatchdogOptions = {},
): StallWatchdog | null {
  const env = opts.env ?? process.env;
  const stallMs = resolveStallMs(env);
  const idleMs = resolveIdleMs(env);
  if (stallMs <= 0 && idleMs <= 0) return null;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const originals = [stdout.write, stderr.write] as const;
  const print = (i: 0 | 1, line: string, done?: () => void) =>
    (originals[i] as (s: string, cb?: () => void) => boolean).call(i === 0 ? stdout : stderr, `${line}\n`, done);
  let exited = false;
  const fatal = (code: number, errorCode: string, kind: string) => ({ idleMs, stage }: { idleMs: number; stage: string }) => {
    if (exited) return;
    exited = true;
    const minutes = Math.round(idleMs / 60_000);
    const message = `${label}: ${minutes} 分钟无进展（最后阶段 ${stage}），${kind} 退出 ${code}`;
    const exit = opts.exit ?? ((c) => process.exit(c));
    let done = false;
    const exitOnce = () => {
      if (done) return;
      done = true;
      exit(code);
    };
    print(1, `[watchdog] ${message}`);
    // Piped stdout writes are async: exit only after the fatal line is flushed (2s cap, real time).
    print(0, JSON.stringify({ event: "fatal", error_code: errorCode, stage, idle_ms: idleMs, message }), exitOnce);
    wallClockTimer(2000, exitOnce, { now: Date.now });
  };
  const dogs: StallWatchdog[] = [];
  if (stallMs > 0) dogs.push(createStallWatchdog(stallMs, fatal(EXIT_STALL, "STALL", "stall watchdog")));
  // Real wall clock: a run of "freezes" (host throttling) can no longer hide a hang (#110).
  if (idleMs > 0) dogs.push(createStallWatchdog(idleMs, fatal(EXIT_IDLE, "IDLE", "idle watchdog（墙钟）"), { now: Date.now }));
  const wd: StallWatchdog = {
    touch: (s) => dogs.forEach((d) => d.touch(s)),
    stop: () => dogs.forEach((d) => d.stop()),
  };
  [stdout, stderr].forEach((stream, i) => {
    const original = originals[i] as (...a: unknown[]) => boolean;
    stream.write = function (...a: unknown[]) {
      // The freeze notice is not progress, else every detected "freeze" resets the watchdog (#110).
      if (!String(a[0]).startsWith(STALL_LOG)) wd.touch();
      return original.apply(stream, a);
    } as Writable["write"];
  });
  active = wd;
  return {
    touch: wd.touch,
    stop() {
      wd.stop();
      stdout.write = originals[0];
      stderr.write = originals[1];
      if (active === wd) active = null;
    },
  };
}
