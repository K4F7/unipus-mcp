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
    sleep: async () => {},
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

// ---- #92: dialog flow mirrors the App capture (D1/D2/D3/D5/D9) ----
const pcm = (sec: number) => Buffer.alloc(Math.round(sec * 32000));
type FakeReply = { asr: string; text: string; audio?: Buffer };
function appLikePorts(sockets: Array<Array<FakeReply | Error>>, env: Record<string, string> = {}) {
  const events: string[] = [];
  let t = 1_000_000;
  let synth = 0;
  const reply = "I had a bad flu last winter with a high fever, so I stayed in bed and drank lots of warm water every day.";
  const { ports: base } = aiPorts(async () => reply, env);
  const http = mockHttpAi(async (c) => {
    if (/ebcp\/speakers/.test(c.url)) events.push("speakers");
    if (/conversation\/stop/.test(c.url)) events.push("stop");
    return {
      statusCode: 200,
      body: JSON.stringify({
        code: 200,
        data: { conversationId: "9001", sceneId: "1", token: "t", record: { list: [] } },
        value: { token: "qt", path: "p.wav", url: "https://cdn.example/p.wav" },
      }),
    };
  });
  let opened = 0;
  const ports = {
    ...base,
    http,
    clockMs: () => t,
    sleep: async (ms: number) => { t += ms; events.push(`sleep:${ms}`); },
    synthesizeLocalWav: async (_t: string, wav: string) => { synth++; await writeFileAi(wav, Buffer.alloc(44 + 32000 * 5)); },
    openDialogSocket: () => {
      const queue = sockets[opened++] ?? [];
      events.push(`open${opened}`);
      return {
        nextReply: async () => {
          const r = queue.shift();
          if (r == null) throw new Error("oral WS closed");
          if (r instanceof Error) throw r;
          return r;
        },
        sendAudio() { events.push("send"); },
        close() { events.push("close"); },
      };
    },
  };
  return { ports, http, events, synthCount: () => synth, reply };
}
const saves = (h: ReturnType<typeof mockHttpAi>) =>
  h.calls.filter((c) => /conversation\/save/.test(c.url)).map((c) => JSON.parse(String(c.body)));

test("AI dialog: opener save + one user+AI save per turn, wall-clock duration, server audio, paced turns (#92)", async () => {
  const { ports, http, events, synthCount, reply } = appLikePorts([[
    { asr: "", text: "I heard you got sick. What happened?", audio: pcm(8) },
    { asr: "I had a bad flu.", text: "That sounds rough. How did you treat it?", audio: pcm(7.5) },
    { asr: "I stayed in bed.", text: "Good. What did you learn?", audio: pcm(6) },
    { asr: "Rest matters.", text: "Great lesson. Thanks for sharing!", audio: pcm(5) },
  ]], { UNIPUS_AI_TURN_MIN_MS: "60000" });
  const r = await runFlow(ports as never, { ...input, userTurns: 3 });
  assert.equal(r.isError, false, r.message);
  const s = saves(http);
  assert.equal(s.length, 4, "3 turns → 4 saves like the App");
  assert.deepEqual(s.map((b) => b.speakAddTaskRecord.sort), [0, 1, 2, 3]);
  assert.deepEqual(s.map((b) => b.speakAddTaskRecord.speakType), [1, 2, 2, 2]);
  const [open, t1] = [s[0].speakAddTaskRecord, s[1].speakAddTaskRecord];
  assert.equal(open.botEnContent, "I heard you got sick. What happened?");
  assert.equal(open.botAudioDuration, 8);
  assert.equal(open.userAudioUrl, "");
  assert.equal(t1.userEnContent, "I had a bad flu.");
  assert.equal(t1.userAudioDuration, 5);
  assert.ok(t1.userAudioUrl);
  assert.equal(t1.botEnContent, "That sounds rough. How did you treat it?");
  assert.equal(t1.botAudioDuration, 7.5);
  assert.ok(t1.botAudioUrl);
  // D2: seconds since create, increasing; D9: ≥60 s between saves.
  const d = s.map((b) => b.duration);
  for (let i = 1; i < d.length; i++) assert.ok(d[i] - d[i - 1] >= 59, `durations ${d}`);
  assert.ok((r.duration_sec ?? 0) >= d[3]);
  // D5: only user turns are synthesised; AI audio comes from the server.
  assert.equal(synthCount(), 3);
  // D3: speakers → stop → close, close only after stop.
  const last = (e: string) => events.lastIndexOf(e);
  assert.ok(last("speakers") < last("stop") && last("stop") < last("close"), events.join(","));
  assert.equal(events.indexOf("close"), last("close"), "socket closed once, after stop");
  const users = (r.turns ?? []).filter((t) => t.type === "cos");
  assert.equal(users.length, 3);
  assert.equal(users[0]!.text, "I had a bad flu.");
  void reply;
});

test("AI dialog: WS closes on turn0 send → reconnect drops the re-sent opener, opener saved once, turns stay aligned (#92)", async () => {
  const { ports, http } = appLikePorts([
    [{ asr: "", text: "I heard you got sick. What happened?", audio: pcm(8) }, new Error("oral WS closed")],
    [
      { asr: "", text: "I heard you got sick. What happened?", audio: pcm(8) },
      { asr: "I had a bad flu.", text: "How did you treat it?", audio: pcm(7) },
    ],
  ], { UNIPUS_AI_TURN_MIN_MS: "0" });
  const r = await runFlow(ports as never, { ...input, userTurns: 1 });
  assert.equal(r.isError, false, r.message);
  const s = saves(http);
  assert.equal(s.length, 2);
  assert.equal(s[0].speakAddTaskRecord.botEnContent, "I heard you got sick. What happened?");
  assert.equal(s[1].speakAddTaskRecord.botEnContent, "How did you treat it?");
  assert.equal(s[1].speakAddTaskRecord.userEnContent, "I had a bad flu.");
});

test("AI dialog: opener lost on the first socket → reconnect greeting becomes the opener (#92)", async () => {
  const { ports, http } = appLikePorts([
    [new Error("oral WS closed")],
    [
      { asr: "", text: "Hi! Tell me about a time you were sick.", audio: pcm(6) },
      { asr: "I had a flu.", text: "How long did it last?", audio: pcm(5) },
    ],
  ], { UNIPUS_AI_TURN_MIN_MS: "0" });
  const r = await runFlow(ports as never, { ...input, userTurns: 1 });
  assert.equal(r.isError, false, r.message);
  assert.equal(saves(http)[0].speakAddTaskRecord.botEnContent, "Hi! Tell me about a time you were sick.");
});

test("AI dialog: reply without server audio falls back to local TTS for the AI line only", async () => {
  const { ports, synthCount } = appLikePorts([[
    { asr: "", text: "What happened?" },
    { asr: "I had a flu.", text: "How long?", audio: pcm(4) },
  ]], { UNIPUS_AI_TURN_MIN_MS: "0" });
  const r = await runFlow(ports as never, { ...input, userTurns: 1 });
  assert.equal(r.isError, false, r.message);
  assert.equal(synthCount(), 2);
});

test("AI dialog: local TTS fallback for the AI line retries with backoff and logs the failure (#98)", async () => {
  const { ports, events } = appLikePorts([[
    { asr: "", text: "What happened?" },
    { asr: "I had a flu.", text: "How long?", audio: pcm(4) },
  ]], { UNIPUS_AI_TURN_MIN_MS: "0" });
  let calls = 0;
  const synth = ports.synthesizeLocalWav;
  ports.synthesizeLocalWav = async (t: string, wav: string) => {
    if (++calls <= 2) throw new Error("kokoro crashed");
    return synth(t, wav);
  };
  const r = await runFlow(ports as never, { ...input, userTurns: 1 });
  assert.equal(r.isError, false, r.message);
  const backoff = events.filter((e) => e === "sleep:3000" || e === "sleep:6000");
  assert.deepEqual(backoff, ["sleep:3000", "sleep:6000"], events.join(","));
});

test("AI dialog: deadline passed between turns → error, no stop, socket closed", async () => {
  const { ports, http, events } = appLikePorts([[
    { asr: "", text: "What happened?", audio: pcm(4) },
    { asr: "I had a flu.", text: "How long?", audio: pcm(4) },
    { asr: "A week.", text: "Ok.", audio: pcm(4) },
  ]], { UNIPUS_AI_TURN_MIN_MS: "60000" });
  const r = await runFlow(ports as never, { ...input, userTurns: 3, deadlineAt: 1_000_000 + 90_000 });
  assert.equal(r.isError, true);
  assert.match(r.message, /上限/);
  assert.equal(calledStop(http), false);
  assert.ok(events.includes("close"));
});

test("oral WS: binary PCM frames of a reply are returned as its audio", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (c) => {
    c.send("[+]ASR: hi");
    c.send("Hello there.");
    c.send(Buffer.from([1, 2, 3, 4]));
    c.send(Buffer.from([5, 6]));
    c.send("[end]");
  });
  try {
    const s = openOralDialogSocket({ conversationId: "c", sceneId: "s", token: "t", url: `ws://127.0.0.1:${port}/x` }, 2000);
    const r = await s.nextReply();
    assert.equal(r.text, "Hello there.");
    assert.deepEqual([...(r.audio ?? [])], [1, 2, 3, 4, 5, 6]);
    s.close();
  } finally {
    wss.close();
  }
});

test("createReplyParser: AI audio streamed after [end] belongs to that reply, not the next (#92)", async () => {
  const { createReplyParser } = await import("../src/ai-dialog-flow.js");
  const p = createReplyParser();
  p.push("Hi, what movie do you like?");
  const opener = p.push("[end]")!;
  assert.equal(opener.audio, undefined);
  p.pushAudio(Buffer.from([1, 2]));
  p.pushAudio(Buffer.from([3]));
  assert.deepEqual([...(opener.audio ?? [])], [1, 2, 3]);
  p.push("[+]ASR: I like Coco.");
  p.push("Nice choice!");
  p.pushAudio(Buffer.from([9]));
  const next = p.push("[end]")!;
  assert.deepEqual([...(next.audio ?? [])], [9]);
  assert.deepEqual([...(opener.audio ?? [])], [1, 2, 3]);
});

test("oral WS: a reply is delivered once its trailing audio has gone quiet (#92)", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (c) => {
    c.send("Hello there.");
    c.send("[end]");
    setTimeout(() => c.send(Buffer.from([1, 2])), 20);
    setTimeout(() => c.send(Buffer.from([3])), 60);
  });
  try {
    const s = openOralDialogSocket({ conversationId: "c", sceneId: "s", token: "t", url: `ws://127.0.0.1:${port}/x` }, 2000, 150);
    const r = await s.nextReply();
    assert.equal(r.text, "Hello there.");
    assert.deepEqual([...(r.audio ?? [])], [1, 2, 3]);
    s.close();
  } finally {
    wss.close();
  }
});

test("pcmToWav: 16 kHz mono s16 RIFF header", async () => {
  const { pcmToWav } = await import("../src/ai-dialog-flow.js");
  const w = pcmToWav(Buffer.alloc(32000));
  assert.equal(w.length, 44 + 32000);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 32000);
});
