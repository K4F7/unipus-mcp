import assert from "node:assert/strict";
import { test } from "node:test";
import { createFetchUnipusHttp, resolveHttpTimeoutMs } from "../src/http.js";

test("resolveHttpTimeoutMs default 60s, env override, floor", () => {
  assert.equal(resolveHttpTimeoutMs({}), 60_000);
  assert.equal(resolveHttpTimeoutMs({ UNIPUS_HTTP_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveHttpTimeoutMs({ UNIPUS_HTTP_TIMEOUT_MS: "10" }), 60_000);
});

test("fetch gets an abort signal", async () => {
  let sig: unknown;
  const http = createFetchUnipusHttp((async (_u: string, init: any) => {
    sig = init.signal;
    return new Response("{}", { status: 200 });
  }) as never);
  await http.request({ url: "https://ucloud.unipus.cn/x", method: "GET" });
  assert.ok(sig instanceof AbortSignal);
});
