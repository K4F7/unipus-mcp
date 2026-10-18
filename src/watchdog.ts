/**
 * Wall-clock timeouts + process stall watchdog (#88).
 *
 * Node timers run on the monotonic clock, which stops while the box VM is
 * suspended: a 60s `setTimeout` was observed firing after 713s–2057s of wall
 * time, and one grind sat silent ~10h on a half-dead TLS socket. Everything here
 * checks `Date.now()` on a short tick, so a deadline fires within one tick of
 * the VM resuming instead of a full timeout later.
 */

export type Clock = { now?: () => number; tickMs?: number };

/** Exit code when the process-level stall watchdog fires. */
export const EXIT_STALL = 3;
export const DEFAULT_STALL_MINUTES = 15;

/** Call `onFire` once `ms` of wall time has passed. Returns cancel (always call it on settle). */
export function wallClockTimer(ms: number, onFire: () => void, clock: Clock = {}): () => void {
  const now = clock.now ?? Date.now;
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

export type StallWatchdog = {
  /** Record progress (new log line / stage advance). */
  touch(stage?: string): void;
  stop(): void;
};

/** Fires `onStall` once when no `touch()` happened for `stallMs` wall time. */
export function createStallWatchdog(
  stallMs: number,
  onStall: (info: { idleMs: number; stage: string }) => void,
  clock: Clock = {},
): StallWatchdog {
  const now = clock.now ?? Date.now;
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
  const stallMs = resolveStallMs(opts.env ?? process.env);
  if (stallMs <= 0) return null;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const originals = [stdout.write, stderr.write] as const;
  const print = (i: 0 | 1, line: string, done?: () => void) =>
    (originals[i] as (s: string, cb?: () => void) => boolean).call(i === 0 ? stdout : stderr, `${line}\n`, done);
  const wd = createStallWatchdog(stallMs, ({ idleMs, stage }) => {
    const minutes = Math.round(idleMs / 60_000);
    const message = `${label}: ${minutes} 分钟无进展（最后阶段 ${stage}），stall watchdog 退出 ${EXIT_STALL}`;
    const exit = opts.exit ?? ((code) => process.exit(code));
    let exited = false;
    const exitOnce = () => {
      if (exited) return;
      exited = true;
      exit(EXIT_STALL);
    };
    print(1, `[watchdog] ${message}`);
    // Piped stdout writes are async: exit only after the fatal line is flushed (2s cap).
    print(0, JSON.stringify({ event: "fatal", error_code: "STALL", stage, idle_ms: idleMs, message }), exitOnce);
    wallClockTimer(2000, exitOnce);
  });
  [stdout, stderr].forEach((stream, i) => {
    const original = originals[i] as (...a: unknown[]) => boolean;
    stream.write = function (...a: unknown[]) {
      wd.touch();
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
