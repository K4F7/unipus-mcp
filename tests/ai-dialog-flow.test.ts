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

test("oral reply timeout measures inactivity and removes expired waiters", async () => {
  const { WebSocketServer } = await import("ws");
  const srv = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => srv.once("listening", resolve));
  const port = (srv.address() as { port: number }).port;
  srv.on("connection", (peer) => {
    const frames = ["Hello", Buffer.from([1, 2]), " there", "[end]"];
    const interval = setInterval(() => {
      const frame = frames.shift();
      if (frame !== undefined) peer.send(frame);
      if (!frames.length) clearInterval(interval);
    }, 80);
    peer.on("close", () => clearInterval(interval));
  });
  const socket = openOralDialogSocket({
    conversationId: "c", sceneId: "s", token: "t",
    url: `ws://127.0.0.1:${port}`,
  }, 150);
  try {
    assert.deepEqual(await socket.nextReply(), { asr: "", text: "Hello there" });
    await assert.rejects(socket.nextReply(), /reply timeout/);
    const next = socket.nextReply();
    for (const peer of srv.clients) {
      peer.send("Recovered");
      peer.send("[end]");
    }
    assert.deepEqual(await next, { asr: "", text: "Recovered" });
  } finally {
    socket.close();
    for (const peer of srv.clients) peer.terminate();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
