import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAiDialogAnswer,
  openOralDialogSocket,
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

test("oral WS handshake 500 rejects nextReply without crashing the process (#80)", async () => {
  const http = await import("node:http");
  const srv = http.createServer((_q, s) => { s.writeHead(500); s.end(); });
  srv.on("upgrade", (_req, sock) => {
    sock.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    sock.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (let i = 0; i < 2; i++) {
      const s = openOralDialogSocket({ conversationId: "c", sceneId: "s", token: "t", url: `ws://127.0.0.1:${port}/x` }, 5000);
      s.sendAudio(Buffer.from("wav"));
      await assert.rejects(s.nextReply(), /500|closed/);
      s.close();
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    srv.close();
  }
});

test("oral WS reply timeout fires on wall clock; late reply is not lost to a dead waiter (#88)", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const conns: Array<{ send: (s: string) => void }> = [];
  wss.on("connection", (c) => conns.push(c));
  try {
    const s = openOralDialogSocket({ conversationId: "c", sceneId: "s", token: "t", url: `ws://127.0.0.1:${port}/x` }, 150);
    const t0 = Date.now();
    await assert.rejects(s.nextReply(), /oral WS reply timeout/);
    assert.ok(Date.now() - t0 < 1500);
    conns[0]!.send("late reply");
    conns[0]!.send("[end]");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await s.nextReply()).text, "late reply");
    s.close();
  } finally {
    wss.close();
  }
});

test("oral WS: streaming frames reset the no-data timeout; close() fails a pending reply at once (#88)", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const conns: Array<{ send: (s: string | Buffer) => void }> = [];
  wss.on("connection", (c) => conns.push(c));
  try {
    const s = openOralDialogSocket({ conversationId: "c", sceneId: "s", token: "t", url: `ws://127.0.0.1:${port}/x` }, 200);
    const reply = s.nextReply();
    await new Promise((r) => setTimeout(r, 50));
    // 5 × 100ms of streaming (500ms total) stays under a 200ms no-data timeout.
    for (let i = 0; i < 5; i++) {
      conns[0]!.send(i % 2 ? Buffer.from([1, 2]) : `chunk${i} `);
      await new Promise((r) => setTimeout(r, 100));
    }
    conns[0]!.send("[end]");
    assert.equal((await reply).text, "chunk0 chunk2 chunk4");

    const pending = s.nextReply();
    const t0 = Date.now();
    s.close();
    await assert.rejects(pending, /oral WS closed/);
    assert.ok(Date.now() - t0 < 100);
  } finally {
    wss.close();
  }
});

test("oral WS turn cap env + error is not retryable (#88)", async () => {
  const { resolveOralWsTurnMaxMs, isRetryableWsError } = await import("../src/ai-dialog-flow.js");
  assert.equal(resolveOralWsTurnMaxMs({}), 240_000);
  assert.equal(resolveOralWsTurnMaxMs({ UNIPUS_ORAL_WS_TURN_MAX_MS: "90000" }), 90_000);
  assert.equal(resolveOralWsTurnMaxMs({ UNIPUS_ORAL_WS_TURN_MAX_MS: "1" }), 240_000);
  assert.equal(isRetryableWsError(new Error("oral WS turn1 每轮总时长上限 timed out (5000ms)")), false);
  assert.equal(isRetryableWsError(new Error("oral WS turn1 超过每轮总时长上限 5000ms（attempt=2）")), false);
});
