/**
 * Headless AI口语对话, shaped like the App 2.8.7 capture (#92):
 * ebcp/auth → create → chat/info → ebcp/speakers → oral WS →
 * save(opener, speakType 1) → per turn: user WAV over WS → AI reply →
 * ONE save carrying user + AI (speakType 2) → ebcp/speakers → stop → close WS.
 * AI audio is the server's own WS PCM (16 kHz mono s16), save.duration is
 * wall seconds since create, turns are paced like a person (UNIPUS_AI_TURN_MIN_MS).
 * openid WebView headers come from ulsCloudHeaders (JWT claim).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { AuthPorts } from "./auth.js";
import {
  conversationChatInfo,
  conversationCreate,
  conversationSave,
  conversationStop,
  type ConversationPorts,
} from "./conversation.js";
import { ebcpAuth, ebcpSpeakers, type EbcpPorts } from "./ebcp.js";
import { AnswerRefusedError, resolveLlmAsk, type LlmAsk } from "./choice-solver.js";
import { generateDialogReply } from "./speak-content.js";
import { openIdFromJwt } from "./uls-business.js";
import { synthesizeSpeechWav, type SynthesizeSpeechPorts } from "./tts.js";
import {
  uploadAnswerAudio,
  type UploadAnswerAudioPorts,
} from "./upload-answer-audio.js";
import { toolError, type ToolResult } from "./result.js";
import { retryWithinBudget } from "./retry.js";
import { markProgress, wallClockTimer, withWallTimeout } from "./watchdog.js";
import { resolveAiTurnMinMs, resolveTtsRetryMaxMs } from "./limits.js";

const BOT_AVATAR =
  "https://unicloud-1313083974.cos.ap-beijing.myqcloud.com/ai-icon/ai-spoken-avatar.png";

const DEFAULT_BOT_OPENERS = [
  "I've noticed a lot of people really enjoy this topic these days. What do you think about it?",
  "That's interesting. Could you tell me more about your own experience?",
  "I see. How does that affect your daily life?",
  "Thanks for sharing. What would you recommend to someone new to this?",
  "One last question — what is the most important takeaway for you?",
];

/** One AI reply: user ASR, AI text and (when the server streamed it) the AI's 16 kHz s16 PCM. */
export type DialogReply = { asr: string; text: string; audio?: Buffer };

export type DialogSocket = {
  /** Resolve with the next bot utterance (text frames until "[end]"). */
  nextReply(): Promise<DialogReply>;
  sendAudio(wav: Buffer): void;
  close(): void;
};

export type AiDialogFlowPorts = AuthPorts &
  ConversationPorts &
  EbcpPorts &
  UploadAnswerAudioPorts &
  SynthesizeSpeechPorts & {
    /** LLM for user turns; default from UNIPUS_LLM_* (required — no canned script). */
    llmAsk?: LlmAsk;
    /** Injected for tests; default opens wss://oral.unipus.cn/oral_api/ws//{cid}. */
    openDialogSocket?: (o: { conversationId: string; sceneId: string; token: string }) => DialogSocket;
    /** Test seams (pacing / durations); default setTimeout / Date.now. */
    sleep?: (ms: number) => Promise<void>;
    clockMs?: () => number;
  };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Box egress drops TLS intermittently; retry NETWORK_ERROR tool results. */
async function retryNet<T extends ToolResult>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  tries = 4,
): Promise<T> {
  let r = await fn();
  for (let i = 1; i < tries && r.isError && /NETWORK/.test(String(r.code)); i++) {
    await sleep(3000);
    r = await fn();
  }
  return r;
}

class SaveError extends Error {
  constructor(readonly result: ToolResult) {
    super(result.message);
  }
}

/**
 * Accumulate oral WS frames: "[+]ASR: …" = user ASR, text chunks = AI reply,
 * binary = AI TTS PCM, "[end]" closes one reply.
 */
export function createReplyParser() {
  let asr = "";
  let text = "";
  let audio: Buffer[] = [];
  /** Last closed reply: the server streams its TTS audio after "[end]" (#94). */
  let closed: DialogReply | null = null;
  return {
    pushAudio(chunk: Buffer): void {
      if (closed) closed.audio = closed.audio ? Buffer.concat([closed.audio, chunk]) : chunk;
      else audio.push(chunk);
    },
    push(frame: string): DialogReply | null {
      const f = frame.replace(/\s+$/, "");
      if (f === "[end]") {
        const out: DialogReply = { asr, text: text.trim().replace(/\s+/g, " ") };
        if (audio.length) out.audio = Buffer.concat(audio);
        asr = "";
        text = "";
        audio = [];
        closed = out;
        return out;
      }
      closed = null;
      if (f.startsWith("[+]ASR:")) asr = f.slice(7).trim();
      else text += frame;
      return null;
    },
  };
}

/** Trailing AI audio counts as finished after this much silence (never more than half the no-data timeout). */
const AUDIO_QUIET_MS = 1500;

/** Server AI audio is raw 16 kHz mono s16 PCM (App wraps it the same way before upload). */
export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * App WS: text frames (bot reply chunks, "[+]ASR: …", "[end]") + binary TTS audio.
 * Client sends one whole 16k WAV per user utterance (raw PCM / small chunks → "didn't catch").
 */
export function resolveOralWsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UNIPUS_ORAL_WS_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 60_000;
}

/**
 * Wall-clock cap for one dialog turn including reconnects/resends (#88):
 * UNIPUS_ORAL_WS_TURN_MAX_MS, default 240s. Exceeding it fails the AI part.
 */
export function resolveOralWsTurnMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UNIPUS_ORAL_WS_TURN_MAX_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 240_000;
}

/** Reply timeout / socket closed / socket error → worth reopening the WS (#72). */
export function isRetryableWsError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /oral WS (reply timeout|closed)|ECONNRESET|socket|ETIMEDOUT|Unexpected server response|TLS/i.test(m);
}

export function openOralDialogSocket(o: {
  conversationId: string;
  sceneId: string;
  token: string;
  /** Test-only endpoint override. */
  url?: string;
}, timeoutMs = resolveOralWsTimeoutMs(), audioQuietMs = Math.min(AUDIO_QUIET_MS, timeoutMs / 2)): DialogSocket {
  const url = o.url ??
    `wss://oral.unipus.cn/oral_api/ws//${encodeURIComponent(o.conversationId)}` +
    `?scene_id=${encodeURIComponent(o.sceneId)}&language=en-uspeak&tts_gender=female&tts_speed=normal&token=${encodeURIComponent(o.token)}`;
  const ws = new WebSocket(url, {
    headers: { origin: "https://uadaptive.unipus.cn" },
    handshakeTimeout: timeoutMs,
  });
  const parser = createReplyParser();
  const queue: DialogReply[] = [];
  const waiters: Array<{ ok: (r: DialogReply) => void; fail: (e: Error) => void; touch: () => void }> = [];
  let failed: Error | null = null;
  const fail = (e: Error) => {
    deliver(); // a complete reply still counts even if the socket drops during its trailing audio
    failed = e;
    while (waiters.length) waiters.shift()!.fail(e);
  };
  // A closed reply waits until its trailing audio has been quiet for audioQuietMs (or the next reply starts).
  let held: { reply: DialogReply; timer: ReturnType<typeof setTimeout> } | null = null;
  const deliver = () => {
    if (!held) return;
    clearTimeout(held.timer);
    const r = held.reply;
    held = null;
    const w = waiters.shift();
    if (w) w.ok(r);
    else queue.push(r);
  };
  const hold = (reply: DialogReply) => {
    held = { reply, timer: setTimeout(deliver, audioQuietMs) };
  };
  ws.on("message", (data, isBinary) => {
    // Inactivity timeout: any frame (text chunk or TTS audio) proves the reply is streaming.
    for (const w of waiters) w.touch();
    if (isBinary) {
      parser.pushAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      if (held) {
        clearTimeout(held.timer);
        hold(held.reply);
      }
      return;
    }
    deliver();
    const r = parser.push(String(data));
    if (r != null) hold(r);
  });
  // Protocol-level ping while the client "thinks" between turns (paced like the App, #92).
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 20_000);
  keepAlive.unref?.();
  ws.on("error", (e) => fail(e));
  ws.on("close", () => {
    clearInterval(keepAlive);
    fail(new Error("oral WS closed"));
  });
  const opened = new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  opened.catch(() => {});
  return {
    nextReply() {
      const q = queue.shift();
      if (q) return Promise.resolve(q);
      if (failed) return Promise.reject(failed);
      return new Promise((ok, rej) => {
        // No-data timeout on the wall clock: a monotonic setTimeout fired 713s+
        // late across VM suspend (#88). Reset by every incoming frame.
        let cancel = () => {};
        const w = {
          ok: (r: DialogReply) => { cancel(); ok(r); },
          fail: (e: Error) => { cancel(); rej(e); },
          touch: () => {
            cancel();
            cancel = wallClockTimer(timeoutMs, () => {
              const i = waiters.indexOf(w);
              if (i >= 0) waiters.splice(i, 1);
              rej(new Error("oral WS reply timeout"));
            });
          },
        };
        waiters.push(w);
        w.touch();
      });
    },
    sendAudio(wav) {
      // Handshake failure (e.g. HTTP 500) surfaces via nextReply; never leave this rejection unhandled (#80).
      opened.then(() => ws.send(wav)).catch(() => {});
    },
    close() {
      clearInterval(keepAlive);
      // Pending nextReply() must fail now, not wait out its timeout.
      fail(new Error("oral WS closed"));
      ws.removeAllListeners("close");
      ws.on("error", () => {});
      ws.close();
    },
  };
}

export type AiDialogFlowInput = {
  taskId: string;
  questionId: string;
  partId: string;
  ansVersion?: number;
  /** Number of user turns (default 3 like the App capture; App max ~10). */
  userTurns?: number;
  /** Wall-clock deadline (epoch ms) for the whole dialog (UNIPUS_PART_MAX_MS / paper cap). */
  deadlineAt?: number;
  openId?: string;
  role?: string;
  /** Task prompt (stripped); required — user turns are LLM replies to it (#63). */
  taskText: string;
};

export type AiDialogTurn = {
  type: "bot" | "cos";
  text: string;
  url: string;
  audioDuration: number;
  id: string;
  curTime: string;
};

export type AiDialogFlowResult = ToolResult & {
  conversation_id?: string;
  answer?: string;
  /** Conversation seconds (App part/submit duration). */
  duration_sec?: number;
  turns?: AiDialogTurn[];
};

function nowCurTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function uploadWav(
  ports: AiDialogFlowPorts,
  wavPath: string,
  fileName: string,
  openId: string | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  const up = await retryNet(() => uploadAnswerAudio(ports, { filePath: wavPath, fileName, openId }), sleep);
  if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
    throw new Error(up.message || "upload_answer_audio failed");
  }
  return String(up.cdn_url);
}

/** D5: upload the server's own AI audio; local TTS only when the reply carried none. */
async function botAudioUpload(
  ports: AiDialogFlowPorts,
  reply: DialogReply,
  text: string,
  openId: string | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<{ url: string; dur: number }> {
  if (reply.audio?.length) {
    const dir = await mkdtemp(join(tmpdir(), "unipus-aibot-"));
    try {
      const wavPath = join(dir, "bot.wav");
      await writeFile(wavPath, pcmToWav(reply.audio));
      const url = await uploadWav(ports, wavPath, `ai-dialog-${Date.now()}.wav`, openId, sleep);
      return { url, dur: reply.audio.length / 32000 };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.error(`[ai-dialog] AI 回复没有服务端音频，改用本地 TTS：${text.slice(0, 40)}`);
  return ttsUpload(ports, text, openId, sleep);
}

/** AI line via local TTS, retried with backoff within UNIPUS_TTS_RETRY_MAX_MS (#98). */
async function ttsUpload(
  ports: AiDialogFlowPorts,
  text: string,
  openId: string | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<{ url: string; dur: number }> {
  return retryWithinBudget(async () => {
    const spoken = await synthesizeSpeechWav({ text }, ports);
    try {
      const wav = await readFile(spoken.wavPath);
      const url = await uploadWav(ports, spoken.wavPath, `ai-dialog-${Date.now()}.wav`, openId, sleep);
      return { url, dur: Math.max(1, (wav.length - 44) / 32000) };
    } finally {
      await spoken.cleanup?.();
    }
  }, {
    label: "AI对话 TTS",
    budgetMs: resolveTtsRetryMaxMs(ports.env),
    now: ports.clockMs,
    sleep,
    log: (line) => console.error(`[ai-dialog] ${line}`),
  });
}

/** chat/info records with audio+text → turns (skips empty WS bot placeholders). */
/**
 * Fragments of the canned scripts older versions voiced when the LLM failed
 * (DEFAULT_AI_SPEAK_SCRIPT, templateFreeTalk, the dialog fallback line).
 * Stored server-side turns containing any of them must never be reused.
 */
const LEGACY_CANNED_FRAGMENTS = [
  "last term i had some trouble with math",
  "went to the teachers office and asked for help",
  "explained the formula again with a simple example",
  "how much a patient and caring teacher can help",
  "thats a good question i think it is really important to me",
  "this topic really matters to me in my daily life as a college student",
  "the most important point is that it helps me learn more about myself",
  "last semester i spent a lot of time on it",
  "it also brings me a lot of fun and makes me feel more confident",
  "i usually share my experience with my friends",
  "i will keep paying attention to it in the future",
];
const normalizeTurn = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

export function isLegacyCannedTurn(text: string): boolean {
  const t = normalizeTurn(text);
  return LEGACY_CANNED_FRAGMENTS.some((f) => t.includes(f));
}

export function existingTurnsFromChatInfo(data: unknown): AiDialogTurn[] {
  const rec = (data as { record?: { list?: unknown } } | null)?.record;
  const list = Array.isArray(rec?.list) ? (rec!.list as Record<string, unknown>[]) : [];
  const out: AiDialogTurn[] = [];
  for (const r of list) {
    const type = r?.type === "bot" ? "bot" : r?.type === "cos" ? "cos" : null;
    const url = typeof r?.audioUrl === "string" ? r.audioUrl : "";
    const text = typeof r?.text === "string" ? r.text.trim() : "";
    if (type == null || !url || !text) continue;
    out.push({
      type,
      text,
      url,
      audioDuration: typeof r.audioDuration === "number" && r.audioDuration > 0 ? r.audioDuration : 3,
      id: String(r.id ?? randomUUID()),
      curTime: typeof r.curTime === "string" ? r.curTime.slice(0, 16) : nowCurTime(),
    });
  }
  return out;
}

/** Build part/submit answer JSON matching App loadAnswer shape for AI口语对话. */
export function buildAiDialogAnswer(turns: AiDialogTurn[]): string {
  const list = turns.map((t) => ({
    url: t.url,
    recordDetail: {
      audioUrl: t.url,
      text: t.text,
      type: t.type,
      curTime: t.curTime,
      id: t.id,
      audioDuration: t.audioDuration,
      audioUrls: [] as string[],
      ...(t.type === "bot" ? { avator: BOT_AVATAR } : {}),
    },
  }));
  return JSON.stringify({
    value: [],
    children: [{ value: [], record: { url: "", list } }],
    record: { url: "", list },
  });
}

export function isAiDialogPartName(partName: string): boolean {
  const n = partName.trim();
  return /AI|ai-?dialog|口语对话/i.test(n) && !/自由/.test(n);
}

/**
 * Run conversation create/save/stop and return the answer string for part/submit.
 */
export async function runAiDialogFlow(
  ports: AiDialogFlowPorts,
  input: AiDialogFlowInput,
): Promise<AiDialogFlowResult> {
  // No task text or no LLM → refuse before touching the server (no canned user script).
  const taskText = input.taskText?.trim();
  if (!taskText) return toolError("ANSWER_REFUSED", "AI对话缺题目文本，拒绝用固定稿作答");
  let ask: LlmAsk;
  try {
    ask = ports.llmAsk ?? resolveLlmAsk(ports.env ?? process.env);
  } catch (error) {
    return toolError("ANSWER_REFUSED", (error as Error).message);
  }
  const loaded = await ports.credentials.getJwt();
  if (loaded == null || loaded.length === 0) {
    return toolError("AUTH_REQUIRED", "未配置 JWT");
  }
  const openId = input.openId?.trim() || openIdFromJwt(loaded);
  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  let userTurns = Math.max(1, Math.min(10, input.userTurns ?? 3));
  const role = (input.role ?? "B").trim() || "B";
  const sleep = ports.sleep ?? defaultSleep;
  const now = ports.clockMs ?? Date.now;
  const deadlineAt = input.deadlineAt ?? Infinity;

  const bizExt = {
    questionId: input.questionId,
    taskId: input.taskId,
    ansVersion,
    openId: openId ?? "",
    sourceId: 116,
    partId: input.partId,
  };

  const auth = await ebcpAuth(ports, {
    scene: "ai-cosplay",
    bizExt,
    openId,
  });
  if (auth.isError) {
    return auth;
  }

  const created = await conversationCreate(ports, {
    taskId: input.taskId,
    questionId: input.questionId,
    title: randomUUID(),
    role,
    ansVersion,
    sourceId: 116,
    openId,
  });
  if (created.isError || created.conversation_id == null) {
    return created.isError
      ? created
      : toolError("BUSINESS_ERROR", "conversation/create 未返回 conversationId");
  }
  const cid = created.conversation_id;
  const t0 = now();
  /** D2: App save/submit duration = wall seconds since the conversation was created. */
  const elapsedSec = () => Math.max(1, Math.round((now() - t0) / 1000));

  // App order: create → chat/info → ebcp/speakers → WS → save. Best-effort.
  const info = (await conversationChatInfo(ports, { conversationId: cid, openId })) as { data?: unknown };
  // create returns the same conversation per task; turns accumulate across attempts (#74).
  const prior = existingTurnsFromChatInfo(info?.data);
  const priorUser = prior.filter((t) => t.type === "cos").length;
  const reusePrior = priorUser >= 2;
  if (reusePrior && prior.some((t) => t.type === "cos" && isLegacyCannedTurn(t.text))) {
    return toolError("ANSWER_REFUSED", "AI对话 已有会话含旧版模板话轮，拒绝复用交卷");
  }
  await ebcpSpeakers(ports, { scene: "ai-cosplay", bizExt, openId });

  if (!reusePrior && priorUser > 0) {
    userTurns = Math.max(1, Math.min(userTurns, 10 - priorUser));
  }
  const turns: AiDialogTurn[] = reusePrior ? [...prior] : [];
  const cur = nowCurTime();
  let durationSec = reusePrior ? Math.round(prior.reduce((a, t) => a + t.audioDuration, 0)) : 0;
  let sort = 0;
  const pushTurn = (type: "bot" | "cos", text: string, media: { url: string; dur: number }) =>
    turns.push({ type, text, url: media.url, audioDuration: media.dur, id: randomUUID(), curTime: cur });

  /** One conversation/save; user/bot halves empty when absent (opener = bot only, speakType 1). */
  const save = async (bot: { text: string; url: string; dur: number }, user?: { text: string; url: string; dur: number }) => {
    durationSec = elapsedSec();
    const res = await retryNet(() => conversationSave(ports, {
      speakTaskId: cid,
      duration: durationSec,
      openId,
      speakAddTaskRecord: {
        aiType: 1,
        botAudioDuration: bot.dur,
        botAudioUrl: bot.url,
        botChContent: "",
        botEnContent: bot.text,
        digitalPersonId: 0,
        sort: sort++,
        // App: 1 = AI opener, 2 = a user turn together with the AI reply to it (D1).
        speakType: user ? 2 : 1,
        speed: 1,
        userAudioDuration: user ? Math.round(user.dur) : 0,
        userAudioUrl: user?.url ?? "",
        userChContent: "",
        userEnContent: user?.text ?? "",
        voiceToneId: 3,
      },
    }), sleep);
    if (res.isError) throw new SaveError(res);
  };

  if (reusePrior) {
    console.error(`[ai-dialog] 复用已有会话记录 user=${priorUser} total=${prior.length}（话轮累计上限，#74）`);
  } else {
  const sockArgs = {
    conversationId: cid,
    sceneId: String(created.scene_id ?? ""),
    token: String(created.token ?? ""),
  };
  const openSock = () => ports.openDialogSocket
    ? ports.openDialogSocket(sockArgs)
    : openOralDialogSocket(sockArgs, resolveOralWsTimeoutMs(ports.env));
  const turnMaxMs = resolveOralWsTurnMaxMs(ports.env);
  const turnMinMs = resolveAiTurnMinMs(ports.env);
  const checkDeadline = (label: string, extraMs = 0) => {
    if (now() + extraMs > deadlineAt) throw new Error(`AI对话 ${label} 超过单 part 墙钟上限`);
  };
  let ws = openSock();
  const wsRetries = Math.max(0, Number(ports.env?.UNIPUS_ORAL_WS_RETRIES ?? 4) || 0);
  /** Await one bot reply; on timeout/close reopen WS (same cid/token) and resend `wav`. */
  const replyWithRetry = async (label: string, wav: Buffer | null): Promise<DialogReply> => {
    const turnStart = now();
    for (let attempt = 0; ; attempt++) {
      const t1 = now();
      const remaining = Math.min(turnMaxMs - (t1 - turnStart), deadlineAt - t1);
      if (remaining <= 0) {
        throw new Error(`oral WS ${label} 超过每轮总时长上限 ${turnMaxMs}ms（attempt=${attempt}）`);
      }
      try {
        if (wav != null) ws.sendAudio(wav);
        const r = await withWallTimeout(ws.nextReply(), remaining, `oral WS ${label} 每轮总时长上限`);
        console.error(`[oral-ws] ${label} ok ${now() - t1}ms${wav ? ` wav=${wav.length}B` : ""} audio=${r.audio?.length ?? 0}B${attempt ? ` retry=${attempt}` : ""}`);
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[oral-ws] ${label} fail ${now() - t1}ms${wav ? ` wav=${wav.length}B` : ""} attempt=${attempt}: ${msg}`);
        if (attempt >= wsRetries || !isRetryableWsError(e)) throw e;
        ws.close();
        await sleep(2000 * (attempt + 1));
        ws = openSock();
        if (wav != null) {
          // A reopened socket greets first (the opener again, or "welcome back."); the opener
          // is already saved, so drop the greeting to keep replies aligned (#76, #92).
          try {
            const g = await ws.nextReply();
            console.error(`[oral-ws] ${label} reconnect greeting dropped: ${g.text.slice(0, 40)}`);
          } catch (ge) {
            console.error(`[oral-ws] ${label} reconnect greeting missing: ${ge instanceof Error ? ge.message : String(ge)}`);
          }
        }
        // wav == null (opener): the reopened socket's greeting IS the opener — keep it.
      }
    }
  };
  try {
    const openerReply = await replyWithRetry("opener", null);
    const opener = openerReply.text || DEFAULT_BOT_OPENERS[0]!;
    const openerMedia = await botAudioUpload(ports, openerReply, opener, openId, sleep);
    await save({ text: opener, ...openerMedia });
    pushTurn("bot", opener, openerMedia);
    let lastSaveAt = now();
    let lastBot = opener;
    for (let i = 0; i < userTurns; i++) {
      checkDeadline(`turn${i}`);
      markProgress(`speak:ai-dialog turn${i}`);
      const userText = await generateDialogReply(taskText, lastBot, i, { ask });
      const spoken = await synthesizeSpeechWav({ text: userText }, ports);
      let reply: DialogReply;
      let user: { text: string; url: string; dur: number };
      try {
        const wav = await readFile(spoken.wavPath);
        const url = await uploadWav(ports, spoken.wavPath, `ai-dialog-${Date.now()}.wav`, openId, sleep);
        // D9: a person listens, thinks and holds-to-talk; App saves land 58–72 s apart.
        const wait = turnMinMs - (now() - lastSaveAt);
        if (wait > 0) {
          checkDeadline(`turn${i} 节奏等待`, wait);
          await sleep(wait);
        }
        reply = await replyWithRetry(`turn${i}`, wav);
        user = { text: reply.asr || userText, url, dur: Math.max(1, (wav.length - 44) / 32000) };
      } finally {
        await spoken.cleanup?.();
      }
      const botText = reply.text || DEFAULT_BOT_OPENERS[(i + 1) % DEFAULT_BOT_OPENERS.length]!;
      const botMedia = await botAudioUpload(ports, reply, botText, openId, sleep);
      await save({ text: botText, ...botMedia }, user);
      lastSaveAt = now();
      pushTurn("cos", user.text, user);
      pushTurn("bot", botText, botMedia);
      lastBot = botText;
    }
    // D3: App leaves the dialog with ebcp/speakers, then conversation/stop, then closes the WS.
    await ebcpSpeakers(ports, { scene: "ai-cosplay", bizExt, openId });
  } catch (error) {
    ws.close();
    if (error instanceof SaveError) return error.result;
    if (error instanceof AnswerRefusedError) return toolError("ANSWER_REFUSED", `AI对话 ${error.message}`);
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("TTS_ERROR", `AI对话 WS/TTS/上传失败：${detail}`);
  }
  const stop = await stopConversation(ports, cid, openId);
  ws.close();
  if (stop.isError) return stop;
  return finishDialog(cid, turns, Math.max(durationSec, elapsedSec()));
  }

  const stop = await stopConversation(ports, cid, openId);
  if (stop.isError) return stop;
  return finishDialog(cid, turns, Math.max(1, durationSec));
}

function stopConversation(ports: AiDialogFlowPorts, cid: string, openId: string | undefined) {
  return conversationStop(ports, {
    speakTaskId: cid,
    evaluation: "",
    evaluationContent: "",
    voiceToneId: 3,
    openId,
  });
}

function finishDialog(cid: string, turns: AiDialogTurn[], durationSec: number): AiDialogFlowResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `AI对话完成 conversationId=${cid} turns=${turns.length}`,
    conversation_id: cid,
    answer: buildAiDialogAnswer(turns),
    duration_sec: durationSec,
    turns,
  };
}
