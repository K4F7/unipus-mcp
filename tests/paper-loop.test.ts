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
