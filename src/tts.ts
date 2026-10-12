import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyError, isRetryableClass, toError, withRetry, withTimeout } from "./retry.js";

export type SynthesizeSpeechInput = {
  text: string;
  /** edge voice id; default en-US-JennyNeural */
  voice?: string;
  /** Output wav path; default under os.tmpdir() */
  outPath?: string;
};

export type SynthesizeSpeechPorts = {
  /** Injected for tests. */
  synthesizeMp3?: (text: string, voice: string, mp3Path: string) => Promise<void>;
  ffmpegPath?: string;
  /** Local fallback: write 16 kHz wav directly (default ffmpeg lavfi flite). */
  synthesizeFallbackWav?: (text: string, wavPath: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
};

/** Per-attempt Edge TTS budget (node-edge-tts' own 10s timer leaks the socket). */
export const EDGE_TTS_ATTEMPT_TIMEOUT_MS = 20_000;
export const EDGE_TTS_ATTEMPTS = 3;

/** Circuit breaker: after Edge returns 403 (endpoint rejects us), skip it for this process. */
let edgeForbidden = false;
export function resetEdgeTtsBreaker(): void {
  edgeForbidden = false;
}

/**
 * UNIPUS_TTS_ENGINE: auto (default: Edge, fall back to local flite on failure),
 * edge (Edge only), flite (local only, no network).
 */
export function resolveTtsEngine(env: NodeJS.ProcessEnv = process.env): "auto" | "edge" | "flite" {
  const v = env.UNIPUS_TTS_ENGINE?.trim().toLowerCase();
  return v === "edge" || v === "flite" ? v : "auto";
}

/**
 * TTS via node-edge-tts → ffmpeg 16 kHz mono PCM WAV (matches U听力 mic format).
 */
export async function synthesizeSpeechWav(
  input: SynthesizeSpeechInput,
  ports: SynthesizeSpeechPorts = {},
): Promise<{ wavPath: string; cleanup: () => Promise<void> }> {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new Error("TTS text 不能为空");
  }
  const voice = input.voice?.trim() || "en-US-JennyNeural";
  const dir = await mkdtemp(join(tmpdir(), "unipus-tts-"));
  const mp3Path = join(dir, "speech.mp3");
  const wavPath = input.outPath?.trim() || join(dir, "speech-16k.wav");

  const synthesize =
    ports.synthesizeMp3 ??
    ((t: string, v: string, out: string) => edgeSynthesizeMp3(t, v, out));

  const ffmpeg = ports.ffmpegPath ?? "ffmpeg";
  const fallback =
    ports.synthesizeFallbackWav ?? ((t: string, out: string) => runFlite(ffmpeg, t, out));
  const engine = resolveTtsEngine(ports.env);

  try {
    if (engine === "flite" || (engine === "auto" && edgeForbidden)) {
      await fallback(text, wavPath);
    } else {
      try {
        await synthesizeViaEdge(() => synthesize(text, voice, mp3Path), ports.sleep);
        await runFfmpeg(ffmpeg, mp3Path, wavPath);
      } catch (edgeError) {
        if (engine === "edge") throw edgeError;
        const cls = classifyError(edgeError);
        if (cls === "FORBIDDEN") edgeForbidden = true;
        console.error(`[tts] Edge TTS 失败 (${cls}: ${toError(edgeError).message})，改用本地 flite`);
        await fallback(text, wavPath);
      }
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    wavPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function runFfmpeg(
  ffmpegPath: string,
  mp3Path: string,
  wavPath: string,
): Promise<void> {
  return spawnFfmpeg(
    ffmpegPath,
    ["-y", "-i", mp3Path, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
    "ffmpeg 转码失败",
  );
}

function spawnFfmpeg(ffmpegPath: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} (code=${code}): ${err.slice(-400)}`));
    });
  });
}

type ClosableSocket = { terminate?: () => void; close?: () => void };

/**
 * One Edge attempt. node-edge-tts never closes its socket on timeout/error, so
 * capture it and terminate on failure — otherwise retries leak live sockets
 * that keep the CLI process alive after it prints its summary.
 */
async function edgeSynthesizeMp3(text: string, voice: string, out: string): Promise<void> {
  const { EdgeTTS } = await import("node-edge-tts");
  const tts = new EdgeTTS({
    voice,
    lang: voice.startsWith("zh") ? "zh-CN" : "en-US",
    timeout: EDGE_TTS_ATTEMPT_TIMEOUT_MS,
  });
  const internal = tts as unknown as { _connectWebSocket: () => Promise<ClosableSocket> };
  const connect = internal._connectWebSocket.bind(tts);
  let socket: ClosableSocket | undefined;
  internal._connectWebSocket = async () => (socket = await connect());
  try {
    await withTimeout(
      tts.ttsPromise(text, out).catch((e: unknown) => Promise.reject(toError(e))),
      EDGE_TTS_ATTEMPT_TIMEOUT_MS + 1_000,
      "Edge TTS",
    );
  } catch (error) {
    try {
      socket?.terminate ? socket.terminate() : socket?.close?.();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * Edge with retries: transient (timeout/network/5xx) up to EDGE_TTS_ATTEMPTS with
 * backoff; 403 retried once only (each attempt mints a fresh Sec-MS-GEC token).
 */
function synthesizeViaEdge(
  attempt: () => Promise<void>,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  return withRetry(
    () => withTimeout(attempt().catch((e) => Promise.reject(toError(e))), EDGE_TTS_ATTEMPT_TIMEOUT_MS, "Edge TTS"),
    {
      attempts: EDGE_TTS_ATTEMPTS,
      sleep,
      shouldRetry: (_e, cls, n) => isRetryableClass(cls) || (cls === "FORBIDDEN" && n === 1),
    },
  );
}

/** Offline TTS via ffmpeg's lavfi flite source → 16 kHz mono PCM WAV. */
function runFlite(ffmpegPath: string, text: string, wavPath: string): Promise<void> {
  // lavfi option escaping: keep plain words/punctuation only.
  const safe = text.replace(/[^A-Za-z0-9 ,.?!-]/g, " ").replace(/\s+/g, " ").trim() || "Hello.";
  return spawnFfmpeg(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", `flite=text='${safe}':voice=slt`,
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath,
  ], "flite 合成失败");
}
