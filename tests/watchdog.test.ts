import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("installProcessStallWatchdog: off when UNIPUS_STALL_MINUTES=0", () => {
  assert.equal(installProcessStallWatchdog("x", { env: { UNIPUS_STALL_MINUTES: "0" } }), null);
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
