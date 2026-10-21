import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeNow,
  createStallClock,
  createStallWatchdog,
  EXIT_STALL,
  installProcessStallWatchdog,
  markProgress,
  resolveStallMs,
  wallClockSignal,
  wallClockTimer,
  withWallTimeout,
} from "../src/watchdog.js";

const tick = () => new Promise((r) => setTimeout(r, 15));

test("wallClockTimer fires on wall time even if monotonic timers lag (VM resume)", async () => {
  let t = 0;
  let fired = 0;
  wallClockTimer(60_000, () => fired++, { now: () => t, tickMs: 5 });
  await tick();
  assert.equal(fired, 0);
  t = 713_000; // box resumed: wall clock jumped far past the deadline
  await tick();
  assert.equal(fired, 1);
  await tick();
  assert.equal(fired, 1, "fires once");
});

test("wallClockTimer cancel", async () => {
  let t = 0;
  let fired = 0;
  const cancel = wallClockTimer(10, () => fired++, { now: () => t, tickMs: 5 });
  cancel();
  t = 100;
  await tick();
  assert.equal(fired, 0);
});

test("wallClockSignal aborts with TimeoutError; clear prevents abort", async () => {
  let t = 0;
  const a = wallClockSignal(1000, { now: () => t, tickMs: 5 });
  const b = wallClockSignal(1000, { now: () => t, tickMs: 5 });
  b.clear();
  t = 2000;
  await tick();
  assert.equal(a.signal.aborted, true);
  assert.equal((a.signal.reason as Error).name, "TimeoutError");
  assert.match((a.signal.reason as Error).message, /aborted due to timeout/);
  assert.equal(b.signal.aborted, false);
});

test("withWallTimeout rejects with label / passes value through", async () => {
  let t = 0;
  const hang = withWallTimeout(new Promise(() => {}), 50, "Clio WSS", { now: () => t, tickMs: 5 });
  t = 100;
  await assert.rejects(hang, /Clio WSS timed out \(50ms\)/);
  assert.equal(await withWallTimeout(Promise.resolve(7), 50, "x"), 7);
});

test("resolveStallMs: default 15min, override, 0 = off, junk → default", () => {
  assert.equal(resolveStallMs({}), 15 * 60_000);
  assert.equal(resolveStallMs({ UNIPUS_STALL_MINUTES: "2" }), 120_000);
  assert.equal(resolveStallMs({ UNIPUS_STALL_MINUTES: "0" }), 0);
  assert.equal(resolveStallMs({ UNIPUS_STALL_MINUTES: "abc" }), 15 * 60_000);
});

test("createStallWatchdog: touch keeps alive, idle fires once with last stage", async () => {
  let t = 0;
  const calls: Array<{ idleMs: number; stage: string }> = [];
  const wd = createStallWatchdog(1000, (i) => calls.push(i), { now: () => t, tickMs: 5 });
  t = 900;
  wd.touch("speak:part/submit");
  t = 1800;
  await tick();
  assert.equal(calls.length, 0);
  t = 2000;
  await tick();
  assert.deepEqual(calls, [{ idleMs: 1100, stage: "speak:part/submit" }]);
  wd.stop();
});

test("installProcessStallWatchdog: off when UNIPUS_STALL_MINUTES=0 and UNIPUS_IDLE_MINUTES=0", () => {
  assert.equal(installProcessStallWatchdog("x", { env: { UNIPUS_STALL_MINUTES: "0", UNIPUS_IDLE_MINUTES: "0" } }), null);
});

test("installProcessStallWatchdog: writes count as progress; stall exits EXIT_STALL with a fatal JSON line", async () => {
  const codes: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdout = { write: (s: string, cb?: () => void) => (out.push(s), setTimeout(() => cb?.(), 20), true) };
  const stderr = { write: (s: string) => (err.push(s), true) };
  // 0.002 min = 120ms stall window
  const wd = installProcessStallWatchdog("weekly-grind", {
    env: { UNIPUS_STALL_MINUTES: "0.002" },
    exit: (c) => codes.push(c),
    stdout: stdout as never,
    stderr: stderr as never,
  });
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60));
      stderr.write(`[oral-ws] turn${i} ok\n`);
    }
    assert.deepEqual(codes, [], "log lines keep it alive");
    markProgress("listen:paper");
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    wd?.stop();
  }
  assert.deepEqual(codes, [EXIT_STALL]);
  const parsed = JSON.parse(out.join("").trim());
  assert.equal(parsed.event, "fatal");
  assert.equal(parsed.error_code, "STALL");
  assert.equal(parsed.stage, "listen:paper");
  assert.match(err.join(""), /stall watchdog 退出 3/);
});

test("createStallClock: active time excludes a process freeze, keeps normal time (#100)", () => {
  let t = 1_000_000;
  const logs: string[] = [];
  // The log re-reads the clock, like installProcessStallWatchdog's stderr hook does.
  const clock: ReturnType<typeof createStallClock> = createStallClock({
    now: () => t, thresholdMs: 15_000, tickMs: 1000, log: (l) => (logs.push(l), clock.now()),
  });
  try {
    const a0 = clock.now();
    t += 10_000; // slow but alive: counts
    assert.equal(clock.now() - a0, 10_000);
    t += 900_000; // VM paused 15 min: nothing ran
    assert.equal(clock.now() - a0, 10_000 + 1000, "freeze counted as one tick");
    assert.equal(clock.stalledMs(), 899_000);
    assert.match(logs.join("\n"), /冻结约 900s/);
    assert.equal(logs.length, 1);
    t += 5000;
    assert.equal(clock.now() - a0, 16_000);
  } finally {
    clock.stop();
  }
});

test("wallClockTimer on the stall clock does not fire on resume from a freeze (#100)", async () => {
  let t = 0;
  const stall = createStallClock({ now: () => t, thresholdMs: 15_000, log: () => {} });
  let fired = 0;
  try {
    wallClockTimer(45_000, () => fired++, { now: stall.now, tickMs: 5 });
    await tick();
    t = 1_033_000; // resumed after ~17 min frozen
    await tick();
    assert.equal(fired, 0, "the frozen time is not request time");
    for (let i = 0; i < 4; i++) {
      t += 10_000; // live time: below the freeze threshold
      await tick();
    }
    assert.equal(fired, 0, "40s of the 45s budget used");
    t += 10_000;
    await tick();
    assert.equal(fired, 1);
  } finally {
    stall.stop();
  }
});

test("activeNow is the default clock of wall timers", () => {
  assert.equal(typeof activeNow(), "number");
  assert.ok(Math.abs(activeNow() - Date.now()) < 24 * 3600_000);
});

test("withDeadline / remainingBudgetMs: nested scopes keep the tighter deadline; none = unbounded (#100)", async () => {
  const { withDeadline, remainingBudgetMs, capToBudget } = await import("../src/watchdog.js");
  assert.equal(remainingBudgetMs(), Infinity);
  assert.equal(capToBudget(45_000), 45_000);
  const t = 1_000_000;
  const now = () => t;
  await withDeadline(t + 900_000, async () => {
    assert.equal(remainingBudgetMs(now), 900_000);
    await withDeadline(t + 2_000_000, async () => {
      assert.equal(remainingBudgetMs(now), 900_000, "an inner, looser budget cannot extend the outer one");
      await withDeadline(t + 30_000, async () => {
        await new Promise((r) => setTimeout(r, 1));
        assert.equal(remainingBudgetMs(now), 30_000, "survives awaits");
        assert.equal(capToBudget(45_000, now), 30_000);
      });
    });
  });
  await withDeadline(t - 5, async () => assert.equal(capToBudget(45_000, now), 1, "spent budget → 1ms, never 0/negative"));
});

test("createStallClock: the exclusion ceiling is per freeze, not per process (#110, #112)", () => {
  let t = 0;
  const lines: string[] = [];
  const freezes: number[] = [];
  const clock = createStallClock({
    now: () => t, thresholdMs: 15_000, tickMs: 1000, maxFrozenMs: 1_200_000,
    log: (l) => lines.push(l), onFreeze: (ms) => freezes.push(ms),
  });
  try {
    t += 1_900_000; // first long freeze: 1200s excluded, the rest counts
    const a1 = clock.now();
    assert.equal(a1, 1_900_000 - 1_200_000);
    t += 1_277_000; // second long freeze in the same process: still excluded up to the ceiling
    const a2 = clock.now();
    assert.equal(a2 - a1, 1_277_000 - 1_200_000, "a later freeze is excluded again; next paper keeps its budget");
    t += 1000;
    assert.equal(clock.now() - a2, 1000, "normal time still counts");
    assert.match(lines[0]!, /扣除 1200s，计入预算 700s/);
    assert.deepEqual(freezes, [1_900_000, 1_277_000]);
  } finally {
    clock.stop();
  }
});

test("installProcessStallWatchdog: [stall] lines are not progress; wall-clock IDLE exits EXIT_IDLE (#110)", async () => {
  const { EXIT_IDLE } = await import("../src/watchdog.js");
  assert.ok(![1, 2, 3, 4, 5].includes(EXIT_IDLE));
  const codes: number[] = [];
  const out: string[] = [];
  const stdout = { write: (s: string, cb?: () => void) => (out.push(s), setTimeout(() => cb?.(), 5), true) };
  const stderr = { write: (_s: string) => true };
  const wd = installProcessStallWatchdog("weekly-grind", {
    // Active-time stall off-scale (frozen clock never advances); wall IDLE 120ms.
    env: { UNIPUS_STALL_MINUTES: "100", UNIPUS_IDLE_MINUTES: "0.002" },
    exit: (c) => codes.push(c),
    stdout: stdout as never,
    stderr: stderr as never,
  });
  try {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 50));
      stderr.write("[stall] 进程冻结约 800s（VM 暂停），超时与预算不计这段\n");
    }
  } finally {
    wd?.stop();
  }
  assert.deepEqual(codes.slice(0, 1), [EXIT_IDLE]);
  const parsed = JSON.parse(out.join("").trim().split("\n")[0]!);
  assert.equal(parsed.event, "fatal");
  assert.equal(parsed.error_code, "IDLE");
});
