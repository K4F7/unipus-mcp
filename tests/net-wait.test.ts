import assert from "node:assert/strict";
import { test } from "node:test";

import { createHttpProbe, createNetworkWaiter, isNetworkFailure } from "../src/net-wait.js";

test("isNetworkFailure: round-3 outage messages are network; auth / refusal / ledger are not (#102)", () => {
  for (const msg of [
    "NETWORK: fetch failed",
    "ANSWER_REFUSED: LLM 探活失败（2 次），本账号不登录、不交卷：fetch failed",
    "Clio WSS 错误：Client network socket disconnected before secure TLS connection was established",
    "progress_after: NETWORK_ERROR: 拉取听力本周失败（网络）：fetch failed",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
    "getaddrinfo ENOTFOUND ucloud.unipus.cn",
  ]) assert.equal(isNetworkFailure(msg), true, msg);
  const withCause = Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
  assert.equal(isNetworkFailure(withCause), true);
  for (const msg of [
    "AUTH_REQUIRED submitAnswer 401：JWT 无效或已过期",
    "ANSWER_REFUSED: LLM 探活失败（2 次）：empty reply",
    "结果写入失败，停号：EACCES",
    "LLM 首包超时 60000ms",
    "Clio 评分超时",
    "submit error: BUSINESS_ERROR code=4021",
  ]) assert.equal(isNetworkFailure(msg), false, msg);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("network waiter: exponential backoff until the probe succeeds", async () => {
  const c = fakeClock();
  const sleeps: number[] = [];
  let probes = 0;
  const lines: string[] = [];
  const wait = createNetworkWaiter({
    env: { UNIPUS_NET_WAIT_BASE_MS: "1000", UNIPUS_NET_WAIT_CAP_MS: "4000" },
    now: c.now,
    sleep: async (ms) => { sleeps.push(ms); await c.sleep(ms); },
    probe: async () => ++probes >= 4,
    log: (l) => lines.push(l),
  });
  assert.equal(await wait("x"), true);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 4000]);
  assert.match(lines.at(-1)!, /第 4 次探测网络已恢复/);
});

test("network waiter: gives up at UNIPUS_NET_WAIT_MAX_MS with a resumable log line; probe throws count as down", async () => {
  const c = fakeClock();
  const lines: string[] = [];
  const wait = createNetworkWaiter({
    env: { UNIPUS_NET_WAIT_MAX_MS: "10000", UNIPUS_NET_WAIT_BASE_MS: "3000", UNIPUS_NET_WAIT_CAP_MS: "3000" },
    now: c.now,
    sleep: c.sleep,
    probe: async () => { throw new Error("fetch failed"); },
    log: (l) => lines.push(l),
  });
  assert.equal(await wait("x"), false);
  assert.equal(c.now(), 10000, "never sleeps past the cap");
  assert.match(lines.at(-1)!, /仍未恢复.*重跑续上/);
  const zero = createNetworkWaiter({ env: { UNIPUS_NET_WAIT_MAX_MS: "0" }, ...fakeClock(), probe: async () => true, log: () => {} });
  assert.equal(await zero("x"), false, "cap 0 = no wait (callers skip the waiter entirely)");
});

test("http probe: any response is up, a throw is down", async () => {
  assert.equal(await createHttpProbe(["https://a", "https://b"], (async () => new Response(null, { status: 401 })) as typeof fetch)(), true);
  assert.equal(await createHttpProbe(["https://a"], (async () => { throw new TypeError("fetch failed"); }) as typeof fetch)(), false);
});

test("network waiter: one cumulative cap across repeated outages (one waiter per account)", async () => {
  const c = fakeClock();
  let up = true;
  const wait = createNetworkWaiter({
    env: { UNIPUS_NET_WAIT_MAX_MS: "10000", UNIPUS_NET_WAIT_BASE_MS: "4000", UNIPUS_NET_WAIT_CAP_MS: "4000" },
    now: c.now, sleep: c.sleep, probe: async () => up, log: () => {},
  });
  assert.equal(await wait("a"), true);
  assert.equal(await wait("b"), true);
  up = false;
  assert.equal(await wait("c"), false);
  assert.equal(c.now(), 10000, "8s already spent → only 2s more");
});
