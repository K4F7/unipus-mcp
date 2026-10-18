import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

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
  /** Local TTS (Kokoro/Piper/macOS say) writing a 16k wav; injected in tests. */
  synthesizeLocalWav?: (text: string, wavPath: string) => Promise<void>;
};

export type LocalTtsEngine = "kokoro" | "piper" | "say";

export function resolveFfmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNIPUS_FFMPEG_BIN?.trim() || env.UNIPUS_FFMPEG?.trim() || "ffmpeg";
}

/**
 * #66: default engine is local Kokoro (no cloud, no flite fallback). Legacy
 * edge/flite/auto only when UNIPUS_TTS_ENGINE asks for them (or tests inject
 * the old mp3/fallback seams).
 */
export function resolveLocalTtsEngine(
  env: NodeJS.ProcessEnv = process.env,
  legacyInjected = false,
): LocalTtsEngine | null {
  const v = env.UNIPUS_TTS_ENGINE?.trim().toLowerCase();
  if (v === "kokoro" || v === "piper" || v === "say") return v;
  if (v === "edge" || v === "flite" || v === "auto") return null;
  return legacyInjected ? null : "kokoro";
}

export function resolveLocalTtsScript(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.UNIPUS_LOCAL_TTS_BIN?.trim() || join(homedir(), "tts-local", "synth.py")
  );
}

function defaultVoice(engine: LocalTtsEngine, env: NodeJS.ProcessEnv): string {
  if (engine === "say") return env.UNIPUS_SAY_VOICE?.trim() || "Samantha";
  return engine === "kokoro"
    ? env.UNIPUS_KOKORO_VOICE?.trim() || "af_heart"
    : env.UNIPUS_PIPER_VOICE?.trim() || "en_US-lessac-high";
}

/** Run scripts/local-tts.py (venv python shebang): text on stdin → 16k mono wav. */
export function localSynthesizeWav(
  engine: LocalTtsEngine,
  env: NodeJS.ProcessEnv,
  ffmpegPath = resolveFfmpegPath(env),
): (text: string, wavPath: string) => Promise<void> {
  if (engine === "say") return (text, wavPath) => synthesizeWithSay(text, wavPath, env, ffmpegPath);
  const script = resolveLocalTtsScript(env);
  const voice = defaultVoice(engine, env);
  return (text, wavPath) =>
    new Promise((resolve, reject) => {
      if (!existsSync(script)) {
        reject(new Error(`本地 TTS 脚本不存在：${script}（见 docs/local-tts.md）`));
        return;
      }
      const child = spawn(script, [engine, voice, wavPath], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.stdin.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(wavPath)) resolve();
        else reject(new Error(`本地 TTS(${engine}) 失败 code=${code}: ${err.slice(-300)}`));
      });
      child.stdin.end(text);
    });
}

/** Per-attempt Edge TTS budget (node-edge-tts' own 10s timer leaks the socket). */
export const EDGE_TTS_ATTEMPT_TIMEOUT_MS = 20_000;
export const EDGE_TTS_ATTEMPTS = 3;

/** Circuit breaker: after Edge returns 403 (endpoint rejects us), skip it for this process. */
let edgeForbidden = false;
export function resetEdgeTtsBreaker(): void {
  edgeForbidden = false;
}

/**
 * Legacy engine selection: auto (Edge, fall back to local flite on failure),
 * edge (Edge only), flite (local only, no network).
 */
export function resolveTtsEngine(env: NodeJS.ProcessEnv = process.env): "auto" | "edge" | "flite" {
  const v = env.UNIPUS_TTS_ENGINE?.trim().toLowerCase();
  return v === "edge" || v === "flite" ? v : "auto";
}

/**
 * Selected TTS → 16 kHz mono PCM WAV (matches U听力 mic format).
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
  const wavPath = input.outPath?.trim() || join(dir, "speech-16k.wav");

  // node-edge-tts lacks Sec-MS-GEC → 403; prefer the maintained edge-tts CLI when present.
  const cli = ports.synthesizeMp3 ? null : resolveEdgeTtsCli(ports.env);
  const legacyInjected = !!(ports.synthesizeMp3 || ports.synthesizeFallbackWav);
  const local = resolveLocalTtsEngine(ports.env ?? process.env, legacyInjected);
  if (local) {
    const run = ports.synthesizeLocalWav ?? localSynthesizeWav(local, ports.env ?? process.env, ports.ffmpegPath);
    try {
      // No silent fallback (#66): a failed synthesis aborts the paper.
      await run(text, wavPath);
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

  const synthesize =
    ports.synthesizeMp3 ??
    (cli
      ? (t: string, v: string, out: string) => edgeCliSynthesizeMp3(cli, t, v, out)
      : (t: string, v: string, out: string) => edgeSynthesizeMp3(t, v, out));

  const ffmpeg = ports.ffmpegPath ?? resolveFfmpegPath(ports.env);
  const fallback =
    ports.synthesizeFallbackWav ?? ((t: string, out: string) => runFlite(ffmpeg, t, out));
  const engine = resolveTtsEngine(ports.env);

  try {
    if (engine === "flite" || (engine === "auto" && edgeForbidden && !cli)) {
      await fallback(text, wavPath);
    } else {
      try {
        // Fresh mp3 per attempt so an abandoned attempt can't write into the next one's file.
        const mp3 = await synthesizeViaEdge(
          async (n) => {
            const path = join(dir, `speech-${n}.mp3`);
            await synthesize(text, voice, path);
            return path;
          },
          ports.sleep,
        );
        await runFfmpeg(ffmpeg, mp3, wavPath);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} (code=${code}): ${err.slice(-400)}`));
    });
  });
}

/** macOS built-in voice: no Python/model download, still a silent 16k mono WAV. */
async function synthesizeWithSay(text: string, wavPath: string, env: NodeJS.ProcessEnv, ffmpegPath: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("UNIPUS_TTS_ENGINE=say requires macOS");
  const dir = await mkdtemp(join(tmpdir(), "unipus-say-"));
  const aiff = join(dir, "speech.aiff");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/say", ["-v", defaultVoice("say", env), "-o", aiff], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString("utf8")).slice(-4000); });
      child.stdin.on("error", reject);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`macOS say failed (code=${code}): ${err.slice(-400)}`));
      });
      child.stdin.end(text);
    });
    await runFfmpeg(ffmpegPath, aiff, wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * One Edge attempt. node-edge-tts neither times out the handshake nor closes its
 * socket on timeout/error, so we open the socket ourselves (same URL/headers as
 * node-edge-tts, plus handshakeTimeout) and terminate it on any failure —
 * otherwise retries leak live sockets that keep the CLI alive.
 */
async function edgeSynthesizeMp3(text: string, voice: string, out: string): Promise<void> {
  const { EdgeTTS } = await import("node-edge-tts");
  const drm = (await import("node-edge-tts/dist/drm.js")) as unknown as {
    TRUSTED_CLIENT_TOKEN: string;
    CHROMIUM_FULL_VERSION: string;
    generateSecMsGecToken: () => string;
  };
  const tts = new EdgeTTS({
    voice,
    lang: voice.startsWith("zh") ? "zh-CN" : "en-US",
    timeout: EDGE_TTS_ATTEMPT_TIMEOUT_MS,
  });
  let socket: WebSocket | undefined;
  const internal = tts as unknown as {
    _connectWebSocket: () => Promise<WebSocket>;
    outputFormat: string;
  };
  internal._connectWebSocket = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const major = drm.CHROMIUM_FULL_VERSION.split(".")[0];
      const ws = new WebSocket(
        `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${drm.TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${drm.generateSecMsGecToken()}&Sec-MS-GEC-Version=1-${drm.CHROMIUM_FULL_VERSION}`,
        {
          host: "speech.platform.bing.com",
          origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          handshakeTimeout: EDGE_TTS_ATTEMPT_TIMEOUT_MS,
          headers: {
            Pragma: "no-cache",
            "Cache-Control": "no-cache",
            "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "en-US,en;q=0.9",
          },
        },
      );
      socket = ws;
      ws.on("open", () => {
        ws.send(
          `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"${internal.outputFormat}"}}}}`,
        );
        resolve(ws);
      });
      ws.on("error", reject);
    });
  try {
    await withTimeout(
      tts.ttsPromise(text, out).catch((e: unknown) => Promise.reject(toError(e))),
      EDGE_TTS_ATTEMPT_TIMEOUT_MS + 1_000,
      "Edge TTS",
    );
  } catch (error) {
    socket?.terminate();
    throw error;
  }
}

/**
 * Edge with retries: transient (timeout/network/5xx) up to EDGE_TTS_ATTEMPTS with
 * backoff; 403 retried once only (each attempt mints a fresh Sec-MS-GEC token).
 */
function synthesizeViaEdge(
  attempt: (n: number) => Promise<string>,
  sleep?: (ms: number) => Promise<void>,
): Promise<string> {
  return withRetry(
    (n) => withTimeout(attempt(n).catch((e) => Promise.reject(toError(e))), EDGE_TTS_ATTEMPT_TIMEOUT_MS + 2_000, "Edge TTS"),
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


/** Path to python `edge-tts` CLI (UNIPUS_EDGE_TTS_BIN, ~/.local/bin, PATH), or null. */
export function resolveEdgeTtsCli(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.UNIPUS_EDGE_TTS_BIN === "off") return null;
  const cands = [
    env.UNIPUS_EDGE_TTS_BIN?.trim(),
    join(homedir(), ".local", "bin", "edge-tts"),
    "/usr/local/bin/edge-tts",
    "/usr/bin/edge-tts",
  ].filter((x): x is string => !!x);
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

function edgeCliSynthesizeMp3(bin: string, text: string, voice: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--voice", voice, "--text", text, "--write-media", out], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`edge-tts CLI 失败 (code=${code}): ${err.slice(-300)}`));
    });
  });
}
