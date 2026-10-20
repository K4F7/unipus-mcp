import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFailureStreak,
  defaultMaxRounds,
  isAuthFailure,
  isConcurrentAnswerError,
  ledgerSkipReason,
  runPaperLoop,
} from "../src/paper-loop.js";

test("isAuthFailure: login/auth stops the account; TTS / 4021 / business errors do not (#98)", () => {
  assert.equal(isAuthFailure("no jwt"), true);
  assert.equal(isAuthFailure("submit error: AUTH_REQUIRED submitAnswer 401：JWT 无效或已过期"), true);
  assert.equal(isAuthFailure("x", "FORBIDDEN"), true);
  assert.equal(isAuthFailure("tts/upload TIMEOUT: TTS 重试总时长上限 timed out (599999ms)", "TIMEOUT"), false);
  assert.equal(isAuthFailure("submit error: BUSINESS_ERROR submitAnswer 业务失败 code=4021：请勿多设备同时作答"), false);
  assert.equal(isAuthFailure("loadPaper failed: {\"taskId\":\"102237959914014011\"}"), false);
});

test("isConcurrentAnswerError matches 4021 / 多设备", () => {
  assert.equal(isConcurrentAnswerError("code=4021：请勿多设备同时作答"), true);
  assert.equal(isConcurrentAnswerError("code=4110：该任务已提交"), false);
  assert.equal(isConcurrentAnswerError(undefined), false);
});

test("failure streak stops at UNIPUS_MAX_CONSECUTIVE_FAILURES and resets on success", () => {
  const s = createFailureStreak({});
  assert.equal(s.fail("a"), null);
  s.ok();
  assert.equal(s.fail("b"), null);
  assert.match(String(s.fail("c")), /连续 2 张失败.*b \| c/);
  const one = createFailureStreak({ UNIPUS_MAX_CONSECUTIVE_FAILURES: "1" });
  assert.match(String(one.fail("x")), /连续 1 张失败/);
  assert.equal(createFailureStreak({ UNIPUS_MAX_CONSECUTIVE_FAILURES: "0" }).fail("x"), null, "invalid → default 2");
});

test("defaultMaxRounds leaves room for skipped papers", () => {
  assert.equal(defaultMaxRounds(12, {}), 24);
  assert.equal(defaultMaxRounds(1, {}), 3);
});

test("runPaperLoop: a results-file write failure stops the loop (ledger must not be skipped)", async () => {
  let rounds = 0;
  const r = await runPaperLoop({
    skill: "听", need: 3, maxRounds: 6, env: {},
    status: async () => ({ taskId: String(rounds) }),
    completeOne: async () => ({ ok: true as const, taskId: String(++rounds) }),
    report: async () => { throw new Error("ENOSPC"); },
  });
  assert.equal(rounds, 1);
  assert.match(String(r.stoppedReason), /结果写入失败.*ENOSPC/);
});

test("runPaperLoop: skipped_existing is not a failure; the same paper skipped twice stops the skill (#100)", async () => {
  const seq = [
    { ok: false as const, taskId: "A", detail: "已交", skippedExisting: true },
    { ok: true as const, taskId: "B" },
    { ok: false as const, taskId: "C", detail: "Clio 超时" },
    { ok: false as const, taskId: "D", detail: "已交", skippedExisting: true },
    { ok: false as const, taskId: "D", detail: "已交", skippedExisting: true },
    { ok: true as const, taskId: "E" },
  ];
  let i = 0;
  const r = await runPaperLoop({
    skill: "听", need: 5, maxRounds: 10, env: {},
    status: async () => ({ taskId: String(i) }),
    completeOne: async () => seq[i++]!,
    report: async () => {},
  });
  assert.equal(i, 5, "C + skips never reach the 2-failure streak cap");
  assert.deepEqual(r.taskIds, ["B"]);
  assert.match(String(r.stoppedReason), /仍在出已交的 D.*不计失败/);
});

test("ledgerSkipReason: App history decides a ledger hit (#100)", async () => {
  const found = (task: unknown) => async () => ({ isError: false, task }) as never;
  const v1 = found({ taskId: "T", ansVersion: 1 });
  assert.match(String(await ledgerSkipReason(v1, "T", 1)), /App 历史都显示 T v1 已交/);
  assert.equal(await ledgerSkipReason(found(null), "T", 1), null, "stale ledger → answer");
  assert.equal(await ledgerSkipReason(v1, "T", 2), null, "history only has another version");
  assert.match(String(await ledgerSkipReason(async () => ({ isError: true, message: "HTTP 502" }) as never, "T", 1)), /保守跳过.*HTTP 502/);
  assert.match(String(await ledgerSkipReason(async () => { throw new Error("fetch failed"); }, "T", 1)), /保守跳过.*fetch failed/);
});

test("runPaperLoop: network failures wait and retry the same paper, never counting toward the streak (#102)", async () => {
  const seq = [
    { ok: false as const, taskId: "A", detail: "tts/upload UNKNOWN: Clio WSS 错误：Client network socket disconnected before secure TLS connection was established" },
    { ok: false as const, taskId: null, detail: "NETWORK: fetch failed" },
    { ok: false as const, taskId: "A", detail: "loadPaper getaddrinfo EAI_AGAIN ucloud.unipus.cn" },
    { ok: true as const, taskId: "A" },
  ];
  let i = 0;
  const waits: string[] = [];
  const r = await runPaperLoop({
    skill: "说", need: 1, maxRounds: 1, env: {},
    status: async () => ({ taskId: String(i) }),
    completeOne: async () => seq[i++]!,
    report: async () => {},
    waitNetwork: async (why) => { waits.push(why); return true; },
  });
  assert.equal(waits.length, 3);
  assert.deepEqual(r.taskIds, ["A"], "network rounds do not use up maxRounds");
  assert.equal(r.stoppedReason, undefined);
});

test("runPaperLoop: network still down after the cap → resumable NETWORK_DOWN stop (#102)", async () => {
  const r = await runPaperLoop({
    skill: "听", need: 3, maxRounds: 6, env: {},
    status: async () => null,
    completeOne: async () => ({ ok: false as const, taskId: null, detail: "NETWORK: fetch failed ECONNRESET" }),
    report: async () => {},
    waitNetwork: async () => false,
  });
  assert.equal(r.networkDown, true);
  assert.equal(r.errorClass, "NETWORK");
  assert.match(String(r.stoppedReason), /NETWORK_DOWN.*重跑.*fetch failed/);
});

test("runPaperLoop: real failures keep the streak stop; auth is never waited on; network retries are bounded (#102)", async () => {
  let waits = 0;
  const waitNetwork = async () => { waits++; return true; };
  const real = await runPaperLoop({
    skill: "说", need: 3, maxRounds: 6, env: {},
    status: async () => null,
    completeOne: async () => ({ ok: false as const, taskId: "X", detail: "LLM 无有效答案" }),
    report: async () => {},
    waitNetwork,
  });
  assert.match(String(real.stoppedReason), /连续 2 张失败/);
  const auth = await runPaperLoop({
    skill: "说", need: 3, maxRounds: 6, env: {},
    status: async () => null,
    completeOne: async () => ({ ok: false as const, taskId: "X", detail: "AUTH_REQUIRED fetch failed" }),
    report: async () => {},
    waitNetwork,
  });
  assert.match(String(auth.stoppedReason), /AUTH_REQUIRED/);
  assert.equal(waits, 0);
  const flaky = await runPaperLoop({
    skill: "说", need: 1, maxRounds: 4, env: { UNIPUS_NET_RETRIES: "2" },
    status: async () => null,
    completeOne: async () => ({ ok: false as const, taskId: "X", detail: "NETWORK: fetch failed" }),
    report: async () => {},
    waitNetwork,
  });
  assert.equal(waits, 2, "after UNIPUS_NET_RETRIES the failure counts normally");
  assert.match(String(flaky.stoppedReason), /连续 2 张失败/);
});
