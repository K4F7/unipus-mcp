/**
 * Headless AI口语对话: ebcp/auth → create → save(N) → stop → answer JSON for part/submit.
 * Harness drives oral.unipus.cn WS; bot/user audio is persisted through TTS upload.
 * openid WebView headers come from ulsCloudHeaders (JWT claim).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { DEFAULT_AI_SPEAK_SCRIPT } from "./grind-paper.js";
import { generateDialogReply } from "./speak-content.js";
import { openIdFromJwt } from "./uls-business.js";
import { synthesizeSpeechWav, type SynthesizeSpeechPorts } from "./tts.js";
import {
  uploadAnswerAudio,
  type UploadAnswerAudioPorts,
} from "./upload-answer-audio.js";
import { toolError, type ToolResult } from "./result.js";
import type { LlmAsk } from "./choice-solver.js";
import { AgentAnswerRequiredError, type AgentAnswerAction } from "./agent-answers.js";

const BOT_AVATAR =
  "https://unicloud-1313083974.cos.ap-beijing.myqcloud.com/ai-icon/ai-spoken-avatar.png";

const DEFAULT_BOT_OPENERS = [
  "I've noticed a lot of people really enjoy this topic these days. What do you think about it?",
  "That's interesting. Could you tell me more about your own experience?",
  "I see. How does that affect your daily life?",
  "Thanks for sharing. What would you recommend to someone new to this?",
  "One last question — what is the most important takeaway for you?",
];

export type DialogReply = { asr: string; text: string };

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
    llmAsk?: LlmAsk | null;
    /** Injected for tests; default opens wss://oral.unipus.cn/oral_api/ws//{cid}. */
    openDialogSocket?: (o: { conversationId: string; sceneId: string; token: string }) => DialogSocket;
  };

/** Box egress drops TLS intermittently; retry NETWORK_ERROR tool results. */
async function retryNet<T extends ToolResult>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let r = await fn();
  for (let i = 1; i < tries && r.isError && /NETWORK/.test(String(r.code)); i++) {
    await new Promise((res) => setTimeout(res, 3000));
    r = await fn();
  }
  return r;
}

class SaveError extends Error {
  constructor(readonly result: ToolResult) {
    super(result.message);
  }
}

/** Accumulate oral WS text frames: "[+]ASR: …" = user ASR, "[end]" closes a bot reply. */
export function createReplyParser() {
  let asr = "";
  let text = "";
  return {
    push(frame: string): DialogReply | null {
      const f = frame.replace(/\s+$/, "");
      if (f.startsWith("[+]ASR:")) {
        asr = f.slice(7).trim();
        return null;
      }
      if (f === "[end]") {
        const out = { asr, text: text.trim().replace(/\s+/g, " ") };
        asr = "";
        text = "";
        return out;
      }
      text += frame;
      return null;
    },
  };
}

/**
 * App WS: text frames (bot reply chunks, "[+]ASR: …", "[end]") + binary TTS audio.
 * Client sends one whole 16k WAV per user utterance (raw PCM / small chunks → "didn't catch").
 */
export function resolveOralWsTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.UNIPUS_ORAL_WS_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 60_000;
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
}, timeoutMs = resolveOralWsTimeoutMs()): DialogSocket {
  const url = o.url ??
    `wss://oral.unipus.cn/oral_api/ws//${encodeURIComponent(o.conversationId)}` +
    `?scene_id=${encodeURIComponent(o.sceneId)}&language=en-uspeak&tts_gender=female&tts_speed=normal&token=${encodeURIComponent(o.token)}`;
  const ws = new WebSocket(url, { headers: { origin: "https://uadaptive.unipus.cn" } });
  const parser = createReplyParser();
  const queue: DialogReply[] = [];
  const waiters: Array<{
    ok: (r: DialogReply) => void;
    fail: (e: Error) => void;
    touch: () => void;
  }> = [];
  let failed: Error | null = null;
  const fail = (e: Error) => {
    failed = e;
    while (waiters.length) waiters.shift()!.fail(e);
  };
  ws.on("message", (data, isBinary) => {
    // Text and TTS audio can stream for minutes before the final [end].
    for (const waiter of waiters) waiter.touch();
    if (isBinary) return;
    const r = parser.push(String(data));
    if (r == null) return;
    const w = waiters.shift();
    if (w) w.ok(r);
    else queue.push(r);
  });
  ws.on("error", (e) => fail(e));
  ws.on("close", () => fail(new Error("oral WS closed")));
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
        let timer: ReturnType<typeof setTimeout>;
        const waiter = {
          ok: (r: DialogReply) => { clearTimeout(timer); ok(r); },
          fail: (e: Error) => { clearTimeout(timer); rej(e); },
          touch: () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              waiter.fail(new Error("oral WS reply timeout"));
            }, timeoutMs);
          },
        };
        waiters.push(waiter);
        waiter.touch();
      });
    },
    sendAudio(wav) {
      // Handshake failure (e.g. HTTP 500) surfaces via nextReply; never leave this rejection unhandled (#80).
      opened.then(() => ws.send(wav)).catch(() => {});
    },
    close() {
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
  /** Number of user turns to save (default 4; App max ~10). */
  userTurns?: number;
  openId?: string;
  role?: string;
  /** Task prompt (stripped) so user turns answer on-topic (#63). */
  taskText?: string;
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
  next_action?: AgentAnswerAction;
};

function nowCurTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function splitUserScripts(turns: number): string[] {
  const parts = DEFAULT_AI_SPEAK_SCRIPT.split(/(?<=[.!?])\s+/).filter(
    (s) => s.trim().length > 0,
  );
  const out: string[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(parts[i % parts.length] ?? DEFAULT_AI_SPEAK_SCRIPT);
  }
  return out;
}

async function ttsUpload(
  ports: AiDialogFlowPorts,
  text: string,
  tag: string,
  openId?: string,
): Promise<{ url: string; dur: number }> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await ttsUploadOnce(ports, text, tag, openId);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw last;
}

async function ttsUploadOnce(
  ports: AiDialogFlowPorts,
  text: string,
  tag: string,
  openId?: string,
): Promise<{ url: string; dur: number }> {
  const spoken = await synthesizeSpeechWav({ text }, ports);
  try {
    const up = await uploadAnswerAudio(ports, {
      filePath: spoken.wavPath,
      fileName: `ai-dialog-${tag}.wav`,
      openId,
    });
    if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
      throw new Error(up.message || "upload_answer_audio failed");
    }
    return { url: String(up.cdn_url), dur: Math.max(2, Math.min(12, text.length / 12)) };
  } finally {
    await spoken.cleanup?.();
  }
}

/** chat/info records with audio+text → turns (skips empty WS bot placeholders). */
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
  const loaded = await ports.credentials.getJwt();
  if (loaded == null || loaded.length === 0) {
    return toolError("AUTH_REQUIRED", "未配置 JWT");
  }
  const openId = input.openId?.trim() || openIdFromJwt(loaded);
  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  let userTurns = Math.max(1, Math.min(10, input.userTurns ?? 4));
  const role = (input.role ?? "B").trim() || "B";

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

  // App order: create → chat/info → ebcp/speakers → WS → save. Best-effort.
  const info = (await conversationChatInfo(ports, { conversationId: cid, openId })) as { data?: unknown };
  // create returns the same conversation per task; turns accumulate across attempts (#74).
  const prior = existingTurnsFromChatInfo(info?.data);
  const priorUser = prior.filter((t) => t.type === "cos").length;
  const reusePrior = priorUser >= 2;
  await ebcpSpeakers(ports, { scene: "ai-cosplay", bizExt, openId });

  if (!reusePrior && priorUser > 0) {
    userTurns = Math.max(1, Math.min(userTurns, 10 - priorUser));
  }
  const userScripts = splitUserScripts(userTurns);
  const turns: AiDialogTurn[] = reusePrior ? [...prior] : [];
  const cur = nowCurTime();
  let duration = reusePrior ? prior.reduce((a, t) => a + t.audioDuration, 0) : 0;
  let sort = 0;

  const saveTurn = async (
    kind: "bot" | "cos",
    text: string,
    media: { url: string; dur: number },
  ) => {
    duration += media.dur;
    const isBot = kind === "bot";
    const res = await retryNet(() => conversationSave(ports, {
      speakTaskId: cid,
      duration: Math.round(duration),
      openId,
      speakAddTaskRecord: {
        aiType: 1,
        botAudioDuration: isBot ? media.dur : 0,
        botAudioUrl: isBot ? media.url : "",
        botChContent: "",
        botEnContent: isBot ? text : "",
        digitalPersonId: 0,
        sort: sort++,
        // App: 1 = bot turn, 2 = user turn.
        speakType: isBot ? 1 : 2,
        speed: 1,
        userAudioDuration: isBot ? 0 : Math.round(media.dur),
        userAudioUrl: isBot ? "" : media.url,
        userChContent: "",
        userEnContent: isBot ? "" : text,
        voiceToneId: 3,
      },
    }));
    if (res.isError) throw new SaveError(res);
    turns.push({
      type: kind,
      text,
      url: media.url,
      audioDuration: media.dur,
      id: randomUUID(),
      curTime: cur,
    });
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
  let ws = openSock();
  const wsRetries = Math.max(0, Number(ports.env?.UNIPUS_ORAL_WS_RETRIES ?? 4) || 0);
  /** Await one bot reply; on timeout/close reopen WS (same cid/token) and resend `wav`. */
  const replyWithRetry = async (label: string, wav: Buffer | null): Promise<DialogReply> => {
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      try {
        if (wav != null) ws.sendAudio(wav);
        const r = await ws.nextReply();
        console.error(`[oral-ws] ${label} ok ${Date.now() - t0}ms${wav ? ` wav=${wav.length}B` : ""}${attempt ? ` retry=${attempt}` : ""}`);
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[oral-ws] ${label} fail ${Date.now() - t0}ms${wav ? ` wav=${wav.length}B` : ""} attempt=${attempt}: ${msg}`);
        if (attempt >= wsRetries || !isRetryableWsError(e)) throw e;
        ws.close();
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        ws = openSock();
        if (wav != null) {
          // A reopened socket greets first ("welcome back."); drop it so replies stay aligned (#76).
          try {
            const g = await ws.nextReply();
            console.error(`[oral-ws] ${label} reconnect greeting dropped: ${g.text.slice(0, 40)}`);
          } catch (ge) {
            console.error(`[oral-ws] ${label} reconnect greeting missing: ${ge instanceof Error ? ge.message : String(ge)}`);
          }
        }
      }
    }
  };
  try {
    const opener = (await replyWithRetry("opener", null)).text || DEFAULT_BOT_OPENERS[0]!;
    await saveTurn("bot", opener, await ttsUpload(ports, opener, `${Date.now()}-b0`, openId));
    let lastBot = opener;
    for (let i = 0; i < userTurns; i++) {
      const userText = input.taskText
        ? await generateDialogReply(input.taskText, lastBot, i, { env: ports.env, ask: ports.llmAsk })
        : userScripts[i]!;
      const spoken = await synthesizeSpeechWav({ text: userText }, ports);
      let reply: DialogReply;
      let media: { url: string; dur: number };
      try {
        const wav = await readFile(spoken.wavPath);
        const up = await retryNet(() => uploadAnswerAudio(ports, {
          filePath: spoken.wavPath,
          fileName: `ai-dialog-${Date.now()}-u${i}.wav`,
          openId,
        }));
        if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
          throw new Error(up.message || "upload_answer_audio failed");
        }
        media = { url: String(up.cdn_url), dur: Math.max(1, Math.round(wav.length / 32000)) };
        reply = await replyWithRetry(`turn${i}`, wav);
      } finally {
        await spoken.cleanup?.();
      }
      await saveTurn("cos", reply.asr || userText, media);
      const botText = reply.text || DEFAULT_BOT_OPENERS[(i + 1) % DEFAULT_BOT_OPENERS.length]!;
      lastBot = botText;
      await saveTurn("bot", botText, await ttsUpload(ports, botText, `${Date.now()}-b${i + 1}`, openId));
    }
  } catch (error) {
    if (error instanceof SaveError) return error.result;
    if (error instanceof AgentAnswerRequiredError) {
      return { ...toolError(error.code, error.message), next_action: error.action };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("TTS_ERROR", `AI对话 WS/TTS/上传失败：${detail}`);
  } finally {
    ws.close();
  }
  }

  const stop = await conversationStop(ports, {
    speakTaskId: cid,
    evaluation: "",
    evaluationContent: "",
    voiceToneId: "3",
    openId,
  });
  if (stop.isError) return stop;

  const answer = buildAiDialogAnswer(turns);
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `AI对话完成 conversationId=${cid} turns=${turns.length}`,
    conversation_id: cid,
    answer,
    duration_sec: Math.max(1, Math.round(duration)),
    turns,
  };
}
