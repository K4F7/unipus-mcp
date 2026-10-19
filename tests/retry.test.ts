import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyError, withRetry, withTimeout } from "../src/retry.js";

const noSleep = async () => {};

describe("classifyError", () => {
  test("maps edge-tts / fetch failures", () => {
    assert.equal(classifyError("Timed out"), "TIMEOUT");
    assert.equal(classifyError(new Error("Unexpected server response: 403")), "FORBIDDEN");
    assert.equal(classifyError(new Error("Unexpected server response: 404")), "HTTP_4XX");
    assert.equal(classifyError(new Error("Unexpected server response: 503")), "HTTP_5XX");
    assert.equal(classifyError(new TypeError("fetch failed")), "NETWORK");
    assert.equal(classifyError(new Error("untrusted_unipus_request_target")), "UNKNOWN");
  });
});

describe("withRetry", () => {
  test("retries transient errors then succeeds", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw new TypeError("fetch failed");
        return "ok";
      },
      { attempts: 3, sleep: noSleep },
    );
    assert.equal(out, "ok");
    assert.equal(n, 3);
  });

  test("does not retry 4xx", async () => {
    let n = 0;
    await assert.rejects(
      withRetry(
        async () => {
          n += 1;
          throw new Error("Unexpected server response: 403");
        },
        { attempts: 5, sleep: noSleep },
      ),
      /403/,
    );
    assert.equal(n, 1);
  });

  test("backoff grows exponentially (with jitter bounds)", async () => {
    const delays: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error("Timed out");
        },
        { attempts: 4, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
      ),
    );
    assert.equal(delays.length, 3);
    [100, 200, 400].forEach((d, i) => {
      assert.ok(delays[i] >= d * 0.8 && delays[i] <= d * 1.2, `delay ${i}=${delays[i]}`);
    });
  });
});

describe("withTimeout", () => {
  test("rejects with timed out", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 10, "X"), /X timed out/);
  });
});

describe("retryWithinBudget (#98)", () => {
  const fakeClock = (step = 0) => {
    let t = 0;
    return { now: () => t, advance: (ms: number) => void (t += ms), tick: () => (t += step) };
  };

  test("backs off exponentially with a cap and logs every failed attempt", async () => {
    const { retryWithinBudget } = await import("../src/retry.js");
    const clock = fakeClock();
    const delays: number[] = [];
    const logs: string[] = [];
    let n = 0;
    const out = await retryWithinBudget(
      async () => {
        n++;
        if (n < 4) throw new Error(`Clio WSS 超时 (${n})`);
        return "ok";
      },
      {
        label: "speak-1", budgetMs: 600_000, attempts: 4, baseDelayMs: 3000, maxDelayMs: 5000,
        now: clock.now, sleep: async (ms) => { delays.push(ms); clock.advance(ms); }, log: (l) => logs.push(l),
      },
    );
    assert.equal(out, "ok");
    assert.deepEqual(delays, [3000, 5000, 5000]);
    assert.equal(logs.length, 3);
    assert.match(logs[0]!, /speak-1 第 1\/4 次失败.*Clio WSS 超时 \(1\).*3000ms 后重试/);
  });

  test("gives up at the attempt cap with the last cause and attempt count", async () => {
    const { retryWithinBudget } = await import("../src/retry.js");
    let n = 0;
    await assert.rejects(
      retryWithinBudget(async () => { n++; throw new Error("upload timed out"); }, {
        label: "t", budgetMs: 600_000, attempts: 3, baseDelayMs: 1, sleep: noSleep, log: () => {},
      }),
      (e: Error) => /t：3 次均失败/.test(e.message) && /upload timed out/.test(e.message) && classifyError(e) === "TIMEOUT",
    );
    assert.equal(n, 3);
  });

  test("hands each attempt only the remaining budget and stops when a backoff would overrun it", async () => {
    const { retryWithinBudget } = await import("../src/retry.js");
    const clock = fakeClock();
    const seen: number[] = [];
    await assert.rejects(
      retryWithinBudget(async (remaining) => { seen.push(remaining); clock.advance(4000); throw new Error("boom"); }, {
        label: "t", budgetMs: 10_000, attempts: 4, baseDelayMs: 1000,
        now: clock.now, sleep: async (ms) => clock.advance(ms), log: () => {},
      }),
      /boom/,
    );
    // 10000 → fail at 4000, wait 1000 → 5000 left → fail at 9000, next wait (2000) overruns.
    assert.deepEqual(seen, [10_000, 5000]);
  });

  test("fatal errors are rethrown unchanged without retry", async () => {
    const { retryWithinBudget } = await import("../src/retry.js");
    class Fatal extends Error {}
    let n = 0;
    await assert.rejects(
      retryWithinBudget(async () => { n++; throw new Fatal("stop"); }, {
        label: "t", budgetMs: 600_000, sleep: noSleep, log: () => {}, isFatal: (e) => e instanceof Fatal,
      }),
      Fatal,
    );
    assert.equal(n, 1);
  });

  test("a hung attempt is cut at the remaining budget", async () => {
    const { retryWithinBudget } = await import("../src/retry.js");
    await assert.rejects(
      retryWithinBudget(() => new Promise(() => {}), { label: "hang", budgetMs: 30, sleep: noSleep, log: () => {} }),
      /hang.*timed out/,
    );
  });
});
