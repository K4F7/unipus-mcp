import assert from "node:assert/strict";
import { test } from "node:test";

import { createFailureStreak, defaultMaxRounds, isAuthFailure, isConcurrentAnswerError, runPaperLoop } from "../src/paper-loop.js";

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
