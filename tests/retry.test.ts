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
