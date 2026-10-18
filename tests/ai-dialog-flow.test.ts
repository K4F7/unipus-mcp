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

// ---- no template submit: user turns come only from the LLM ----
import { runAiDialogFlow as runFlow } from "../src/ai-dialog-flow.js";
import { mockHttp as mockHttpAi } from "./mock-http.js";
import { writeFile as writeFileAi } from "node:fs/promises";

function aiPorts(llmAsk?: (p: string) => Promise<string>, env: Record<string, string> = {}) {
  const http = mockHttpAi(async () => ({
    statusCode: 200,
    body: JSON.stringify({
      code: 200,
      data: { conversationId: "9001", sceneId: "1", token: "t", record: { list: [] } },
      value: { token: "qt", path: "p.wav", url: "https://cdn.example/p.wav" },
    }),
  }));
  const ports = {
    credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuaWQiOiJvIn0.s" },
    http,
    env,
    llmAsk,
    uploadFetch: async () => new Response("{}", { status: 200 }),
    synthesizeLocalWav: async (_t: string, wav: string) => writeFileAi(wav, Buffer.alloc(64000)),
    openDialogSocket: () => ({
      nextReply: async () => ({ asr: "", text: "Hi! What music do you like?" }),
      sendAudio() {},
      close() {},
    }),
  };
  return { http, ports };
}
const input = { taskId: "555", questionId: "333", partId: "p3", taskText: "Talk about the music you like." };
const calledStop = (h: ReturnType<typeof mockHttpAi>) => h.calls.some((c) => /conversation\/stop|\/stop/.test(c.url));

test("AI dialog: no taskText → ANSWER_REFUSED before any request (no canned user script)", async () => {
  const { http, ports } = aiPorts(async () => "x");
  const r = await runFlow(ports as never, { ...input, taskText: "" });
  assert.equal(r.isError, true);
  assert.equal(r.code, "ANSWER_REFUSED");
  assert.equal(http.calls.length, 0);
});

test("AI dialog: no UNIPUS_LLM_* config → ANSWER_REFUSED before any request", async () => {
  const { http, ports } = aiPorts(undefined, { SILICONFLOW_API_KEY: "k" });
  const r = await runFlow(ports as never, input);
  assert.equal(r.isError, true);
  assert.equal(r.code, "ANSWER_REFUSED");
  assert.equal(http.calls.length, 0);
});

test("AI dialog: LLM fails mid-dialog → ANSWER_REFUSED, no user audio, no stop, no answer", async () => {
  const { http, ports } = aiPorts(async () => { throw new Error("HTTP 502"); });
  const r = await runFlow(ports as never, input);
  assert.equal(r.isError, true);
  assert.equal(r.code, "ANSWER_REFUSED");
  assert.equal(r.answer, undefined);
  assert.equal(calledStop(http), false);
  assert.equal(http.calls.some((c) => String(c.body ?? "").includes("ai-dialog-") && String(c.body).includes("-u0")), false);
});

test("AI dialog: LLM replies drive every user turn", async () => {
  const reply = "I like pop music the most because the melodies are catchy and they help me relax after a long day of classes.";
  const { ports } = aiPorts(async () => reply);
  const r = await runFlow(ports as never, { ...input, userTurns: 2 });
  assert.equal(r.isError, false, r.message);
  const users = (r.turns ?? []).filter((t) => t.type === "cos");
  assert.equal(users.length, 2);
  for (const u of users) assert.equal(u.text, reply);
});

function aiPortsWithPrior(userTexts: string[], llmAsk = async () => "I like pop music because it relaxes me after class.") {
  const list = userTexts.flatMap((t, i) => [
    { type: "bot", text: `Question ${i}?`, audioUrl: `https://cdn.example/b${i}.wav`, audioDuration: 3 },
    { type: "cos", text: t, audioUrl: `https://cdn.example/u${i}.wav`, audioDuration: 5 },
  ]);
  const { ports } = aiPorts(llmAsk);
  const http = mockHttpAi(async () => ({
    statusCode: 200,
    body: JSON.stringify({
      code: 200,
      data: { conversationId: "9001", sceneId: "1", token: "t", record: { list } },
      value: { token: "qt", path: "p.wav", url: "https://cdn.example/p.wav" },
    }),
  }));
  return { http, ports: { ...ports, http } };
}

test("AI dialog: prior session holds legacy canned user turns → ANSWER_REFUSED, not reused, no stop", async () => {
  const { http, ports } = aiPortsWithPrior([
    "Last term I had some trouble with math",
    "After class I went to the teacher's office and asked for help",
  ]);
  const r = await runFlow(ports as never, input);
  assert.equal(r.isError, true);
  assert.equal(r.code, "ANSWER_REFUSED");
  assert.equal(r.answer, undefined);
  assert.equal(calledStop(http), false);
});

test("AI dialog: legacy free-talk template turn (ASR punctuation/case drift) is also refused", async () => {
  const { ports } = aiPortsWithPrior([
    "Hello there.",
    "i'd like to talk about music, first of all this topic really matters to me in my daily life as a college student",
  ]);
  const r = await runFlow(ports as never, input);
  assert.equal(r.code, "ANSWER_REFUSED");
});

test("AI dialog: prior session with ordinary user turns is still reused (#74)", async () => {
  const { http, ports } = aiPortsWithPrior([
    "I really enjoy jazz on rainy evenings.",
    "My favourite singer is Adele because her voice is powerful.",
  ]);
  const r = await runFlow(ports as never, input);
  assert.equal(r.isError, false, r.message);
  assert.equal(calledStop(http), true);
});
