import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAiDialogAnswer,
  isAiDialogPartName,
} from "../src/ai-dialog-flow.js";

test("isAiDialogPartName", () => {
  assert.equal(isAiDialogPartName("AI口语对话"), true);
  assert.equal(isAiDialogPartName("自由表达"), false);
  assert.equal(isAiDialogPartName("范例学习"), false);
});

test("buildAiDialogAnswer shape", () => {
  const ans = JSON.parse(
    buildAiDialogAnswer([
      {
        type: "bot",
        text: "Hi?",
        url: "https://x/a.wav",
        audioDuration: 2,
        id: "1",
        curTime: "2026-10-14 02:00",
      },
      {
        type: "cos",
        text: "Hello",
        url: "https://x/b.wav",
        audioDuration: 3,
        id: "2",
        curTime: "2026-10-14 02:00",
      },
    ]),
  );
  assert.equal(ans.children[0].record.list.length, 2);
  assert.equal(ans.children[0].record.list[0].recordDetail.type, "bot");
  assert.equal(ans.children[0].record.list[1].recordDetail.type, "cos");
  assert.ok(ans.children[0].record.list[0].recordDetail.avator);
  assert.equal(ans.children[0].record.list[1].recordDetail.avator, undefined);
});

test("createReplyParser: ASR + chunked bot reply until [end]", async () => {
  const { createReplyParser } = await import("../src/ai-dialog-flow.js");
  const p = createReplyParser();
  assert.equal(p.push("[+]ASR: I like it."), null);
  assert.equal(p.push("That makes sense."), null);
  assert.equal(p.push(" What part is relaxing?"), null);
  assert.deepEqual(p.push("[end]\n"), {
    asr: "I like it.",
    text: "That makes sense. What part is relaxing?",
  });
  assert.deepEqual(p.push("[end]"), { asr: "", text: "" });
});

test("oral WS retry classification + timeout env (#72)", async () => {
  const { isRetryableWsError, resolveOralWsTimeoutMs } = await import("../src/ai-dialog-flow.js");
  assert.equal(isRetryableWsError(new Error("oral WS reply timeout")), true);
  assert.equal(isRetryableWsError(new Error("oral WS closed")), true);
  assert.equal(isRetryableWsError(new Error("read ECONNRESET")), true);
  assert.equal(isRetryableWsError(new Error("upload_answer_audio failed")), false);
  assert.equal(resolveOralWsTimeoutMs({}), 60_000);
  assert.equal(resolveOralWsTimeoutMs({ UNIPUS_ORAL_WS_TIMEOUT_MS: "90000" }), 90_000);
  assert.equal(resolveOralWsTimeoutMs({ UNIPUS_ORAL_WS_TIMEOUT_MS: "1" }), 60_000);
});

test("existingTurnsFromChatInfo keeps audio+text records (#74)", async () => {
  const { existingTurnsFromChatInfo } = await import("../src/ai-dialog-flow.js");
  const t = existingTurnsFromChatInfo({ record: { list: [
    { type: "cos", text: "Hi there", audioUrl: "https://x/u.wav", audioDuration: 18, id: 1, curTime: "2026-10-14 17:34:02" },
    { type: "bot", text: "", audioUrl: null, id: 2 },
    { type: "bot", text: "Nice.", audioUrl: "https://x/b.wav", audioDuration: 8, id: 3, curTime: "2026-10-14 17:34:07" },
  ] } });
  assert.equal(t.length, 2);
  assert.equal(t[0]!.type, "cos");
  assert.equal(t[0]!.curTime, "2026-10-14 17:34");
  assert.equal(t[1]!.audioDuration, 8);
  assert.deepEqual(existingTurnsFromChatInfo(null), []);
});
