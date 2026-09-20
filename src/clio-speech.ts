import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";

import WebSocket from "ws";

import {
  DEFAULT_CLIO_APPLICATION_ID,
  DEFAULT_CLIO_SECRET,
  DEFAULT_CLIO_WSS_URL,
  resolveClioCredentials,
  resolveClioWssUrl,
} from "./config.js";
import {
  buildEnSentScoreQuestionContent,
  buildEnSentScoreRecord,
  type EnSentScoreRecordInput,
} from "./grade-question.js";
import {
  okScoreSpeech,
  toolError,
  type ScoreSpeechResult,
} from "./result.js";

export type ClioCredentials = {
  applicationId: string;
  secret: string;
};

export type ScoreEnSentInput = {
  transcript: string;
  /** Raw WAV/PCM bytes (preferred when already in memory). */
  audioBytes?: Uint8Array | Buffer;
  /** Local wav path; read when audioBytes omitted. */
  wavPath?: string;
  userId?: string;
  credentials?: ClioCredentials;
  wssUrl?: string;
  /** Default 30s. */
  timeoutMs?: number;
};

export type ClioScorePayload = {
  overall: number | null;
  total: number | null;
  result: Record<string, unknown>;
  audioUrl: string | null;
  raw: unknown;
};

/** Minimal WebSocket surface for injection / unit mocks. */
export type ClioWebSocketLike = {
  on(
    event: "open" | "message" | "error" | "close",
    listener: (...args: unknown[]) => void,
  ): void;
  send(data: string | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
};

export type ScoreEnSentPorts = {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<Buffer>;
  createWebSocket?: (url: string) => ClioWebSocketLike;
  nowMs?: () => number;
  randomUUID?: () => string;
};

/**
 * Clio / speech.unipus.cn SHA1 hex sig:
 * SHA1(applicationId + secret + timestamp) where
 * timestamp = Math.floor(Date.now()/1000).toString()
 * (== String(Date.now()).slice(0, -3)).
 */
export function createClioSig(
  applicationId: string,
  secret: string,
  timestamp: string,
): string {
  return createHash("sha1")
    .update(`${applicationId}${secret}${timestamp}`, "utf8")
    .digest("hex");
}

export function clioTimestampFromNowMs(nowMs: number): string {
  return Math.floor(nowMs / 1000).toString();
}

/**
 * Headless `en.sent.score` over WSS prod path
 * `wss://speech.unipus.cn/speech/proxy/wss`.
 * Frame order: sdk/app JSON → token/request JSON → binary audio → {"stop":true}.
 */
export async function scoreEnSent(
  input: ScoreEnSentInput,
  ports: ScoreEnSentPorts = {},
): Promise<ClioScorePayload> {
  const transcript = input.transcript.trim();
  if (transcript.length === 0) {
    throw new Error("transcript 不能为空");
  }

  const audio = await resolveAudioBytes(input, ports);
  if (audio.byteLength === 0) {
    throw new Error("audio 不能为空");
  }

  const env = ports.env ?? process.env;
  const creds =
    input.credentials ??
    resolveClioCredentials(env) ?? {
      applicationId: DEFAULT_CLIO_APPLICATION_ID,
      secret: DEFAULT_CLIO_SECRET,
    };
  const wssUrl = input.wssUrl?.trim() || resolveClioWssUrl(env);
  const userId = input.userId?.trim() || "unipus-mcp";
  const timeoutMs =
    input.timeoutMs != null && Number.isFinite(input.timeoutMs)
      ? Math.max(1_000, Number(input.timeoutMs))
      : 30_000;

  const nowMs = (ports.nowMs ?? Date.now)();
  const timestamp = clioTimestampFromNowMs(nowMs);
  const sig = createClioSig(creds.applicationId, creds.secret, timestamp);
  const tokenId = (ports.randomUUID ?? nodeRandomUUID)();

  const createWs =
    ports.createWebSocket ??
    ((url: string) => new WebSocket(url) as unknown as ClioWebSocketLike);

  return await new Promise<ClioScorePayload>((resolve, reject) => {
    let settled = false;
    let socket: ClioWebSocketLike;
    try {
      socket = createWs(wssUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const timer = setTimeout(() => {
      fail(new Error(`Clio WSS 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      fn();
    };

    const fail = (error: Error) => finish(() => reject(error));
    const ok = (payload: ClioScorePayload) => finish(() => resolve(payload));

    socket.on("error", (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      fail(new Error(`Clio WSS 错误：${detail}`));
    });

    socket.on("close", () => {
      if (!settled) {
        fail(new Error("Clio WSS 在收到评分前关闭"));
      }
    });

    socket.on("message", (data: unknown) => {
      try {
        const parsed = parseClioScoreMessage(data);
        if (parsed == null) return;
        if (parsed.kind === "error") {
          fail(new Error(parsed.message));
          return;
        }
        ok(parsed.payload);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on("open", () => {
      try {
        const sdkFrame = {
          sdk: { version: 16777216, source: 4, protocol: "websocket" },
          app: {
            applicationId: creds.applicationId,
            sig,
            timestamp,
            userId,
            alg: "sha1",
          },
        };
        const requestFrame = {
          tokenId,
          audio: {
            audioType: "wav",
            channel: 1,
            sampleRate: 16000,
            sampleBytes: 2,
          },
          request: {
            apiName: "en.sent.score",
            transcript,
            userId,
            sig,
            parameters: { details: { adjust: 0 } },
          },
        };
        socket.send(JSON.stringify(sdkFrame));
        socket.send(JSON.stringify(requestFrame));
        socket.send(Buffer.from(audio));
        socket.send(JSON.stringify({ stop: true }));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/**
 * MCP-facing wrapper: validates args, scores, returns ToolResult.
 * Credentials / WSS URL from env only (never tool args).
 */
export async function scoreSpeechTool(
  ports: ScoreEnSentPorts,
  input: {
    transcript: string;
    wavPath: string;
    userId?: string;
    timeoutMs?: number;
  },
): Promise<ScoreSpeechResult> {
  const transcript = input.transcript?.trim() ?? "";
  if (transcript.length === 0) {
    return toolError("INVALID_ARGUMENT", "transcript 不能为空");
  }
  const wavPath = input.wavPath?.trim() ?? "";
  if (wavPath.length === 0) {
    return toolError("INVALID_ARGUMENT", "wavPath 不能为空");
  }

  try {
    const scored = await scoreEnSent(
      {
        transcript,
        wavPath,
        userId: input.userId,
        timeoutMs: input.timeoutMs,
      },
      ports,
    );
    const enSent = clioToEnSentScoreFields(transcript, scored);
    return okScoreSpeech({
      message: `Clio en.sent.score 完成 overall=${scored.overall ?? "null"}`,
      overall: scored.overall,
      total: scored.total,
      audio_url: scored.audioUrl,
      result: scored.result,
      en_sent_score_content: enSent.questionContent,
      en_sent_score_record: enSent.record,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("CLIO_SCORE_ERROR", `Clio 评分失败：${detail}`);
  }
}

/** Map Clio finalResult → buildEnSentScore* fields for grade/submit. */
export function clioToEnSentScoreFields(
  transcript: string,
  scored: Pick<ClioScorePayload, "audioUrl" | "result">,
): {
  record: Record<string, unknown>;
  questionContent: string;
  input: EnSentScoreRecordInput;
} {
  const url = scored.audioUrl?.trim() || "";
  const input: EnSentScoreRecordInput = {
    text: transcript,
    url,
  };
  // Preserve clio CDN path hint when url is clio-audios.
  if (url.includes("clio-audios.unipus.cn")) {
    input.path = url;
  }
  return {
    input,
    record: buildEnSentScoreRecord(input),
    questionContent: buildEnSentScoreQuestionContent(input),
  };
}

async function resolveAudioBytes(
  input: ScoreEnSentInput,
  ports: ScoreEnSentPorts,
): Promise<Buffer> {
  if (input.audioBytes != null) {
    return Buffer.from(input.audioBytes);
  }
  const wavPath = input.wavPath?.trim();
  if (wavPath == null || wavPath.length === 0) {
    throw new Error("需要 audioBytes 或 wavPath");
  }
  const read = ports.readFile ?? fsReadFile;
  return read(wavPath);
}


type ParsedClioMessage =
  | { kind: "score"; payload: ClioScorePayload }
  | { kind: "error"; message: string };

/** null = ignore (empty / intermediate). */
export function parseClioScoreMessage(data: unknown): ParsedClioMessage | null {
  const text = messageToString(data);
  if (text == null || text.length === 0) return null;
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const code = parsed.code;
  if (code !== 0 && code !== "0") {
    if (
      parsed.finalResult == null &&
      parsed.message == null &&
      parsed.info == null
    ) {
      return null;
    }
    const hint =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.info === "string"
          ? parsed.info
          : `code=${String(code)}`;
    return { kind: "error", message: `Clio 评分失败：${hint}` };
  }
  const finalResult = parsed.finalResult;
  if (finalResult == null || typeof finalResult !== "object") {
    return null;
  }
  const fr = finalResult as Record<string, unknown>;
  const resultRaw = fr.result;
  const result =
    resultRaw != null &&
    typeof resultRaw === "object" &&
    !Array.isArray(resultRaw)
      ? (resultRaw as Record<string, unknown>)
      : {};
  const total = pickFiniteNumber(result.total ?? result.overall);
  const overall = pickFiniteNumber(result.overall ?? result.total);
  const audioUrl =
    typeof fr.url === "string" && fr.url.trim().length > 0
      ? fr.url.trim()
      : null;
  return {
    kind: "score",
    payload: { overall, total, result, audioUrl, raw: parsed },
  };
}

function messageToString(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  // ws may pass (data, isBinary)
  if (Array.isArray(data) && data.length > 0) {
    return messageToString(data[0]);
  }
  return null;
}

function pickFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Re-export defaults for docs/tests. */
export { DEFAULT_CLIO_WSS_URL };
