/** Local configuration preflight; optional synthesis uses the selected engine. */
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { resolveAgentAnswerDir } from "./agent-answers.js";
import { resolveChoiceSolverConfig } from "./choice-solver.js";
import { resolveFfmpegPath, resolveLocalTtsEngine, resolveLocalTtsScript, resolveTtsEngine, synthesizeSpeechWav } from "./tts.js";
import type { ToolResult } from "./result.js";

type Check = {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  next_action?: string;
};

export type DoctorResult = ToolResult & {
  node_path: string;
  platform: string;
  answer_source: "agent_queue" | "llm" | "legacy";
  tts_engine: string;
  checks: Check[];
};

function requireSpeechFormat(wav: Buffer): void {
  if (wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Speech output is not a non-empty WAV file");
  }
  let validFormat = false;
  let audioBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new Error("Speech WAV chunk is truncated");
    if (id === "fmt " && size >= 16) {
      validFormat = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
        && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
    }
    if (id === "data") audioBytes += size;
    offset = start + size + (size % 2);
  }
  if (!validFormat || audioBytes === 0) throw new Error("Speech WAV must be non-empty 16 kHz mono 16-bit PCM");
}

export async function findExecutable(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const paths = isAbsolute(bin) ? [bin] : (env.PATH ?? process.env.PATH ?? "").split(delimiter).map((p) => join(p, bin));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* next PATH entry */ }
  }
  return null;
}

export async function runDoctor(
  options: { env?: NodeJS.ProcessEnv; speechProbe?: boolean } = {},
): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    id: "node", status: major >= 20 ? "ok" : "error",
    message: `Node ${process.versions.node}; ${process.execPath}`,
    ...(major < 20 ? { next_action: "Use Node >=20" } : {}),
  });
  let answerSource: DoctorResult["answer_source"] = "legacy";
  try {
    const dir = resolveAgentAnswerDir(env);
    if (dir) {
      answerSource = "agent_queue";
      const raw = env.UNIPUS_AGENT_ANSWER_WAIT_MS;
      if (raw != null && (!Number.isSafeInteger(Number(raw)) || Number(raw) < 0)) {
        throw new Error("UNIPUS_AGENT_ANSWER_WAIT_MS must be a non-negative integer");
      }
      checks.push({ id: "answers", status: "ok", message: `Agent answer queue: ${dir}` });
    } else if (resolveChoiceSolverConfig(env)) {
      answerSource = "llm";
      checks.push({ id: "answers", status: "ok", message: "OpenAI-compatible LLM configured (network not probed)" });
    } else {
      checks.push({
        id: "answers", status: "warning",
        message: "No answer source: listening uses heuristics/empty blanks; speaking uses a generic template",
        next_action: "Set UNIPUS_AGENT_ANSWER_DIR to an absolute directory, or configure UNIPUS_LLM_API_KEY",
      });
    }
  } catch (error) {
    checks.push({ id: "answers", status: "error", message: (error as Error).message });
  }
  const local = resolveLocalTtsEngine(env);
  const engine = local ?? resolveTtsEngine(env);
  if (env.UNIPUS_TTS_ENGINE && !["kokoro", "piper", "say", "auto", "edge", "flite"].includes(env.UNIPUS_TTS_ENGINE.trim().toLowerCase())) {
    checks.push({ id: "tts_engine", status: "error", message: "Unknown UNIPUS_TTS_ENGINE; choose kokoro|piper|say|edge|flite|auto" });
  }
  const ffmpeg = await findExecutable(resolveFfmpegPath(env), env);
  checks.push({
    id: "ffmpeg", status: ffmpeg ? "ok" : "error",
    message: ffmpeg ?? "ffmpeg executable not found",
    ...(!ffmpeg ? { next_action: "Install ffmpeg or set UNIPUS_FFMPEG_BIN to its absolute path" } : {}),
  });
  if (local === "say") {
    const available = process.platform === "darwin" && await findExecutable("/usr/bin/say", env);
    checks.push({
      id: "tts", status: available ? "ok" : "error",
      message: available ? "macOS say (offline; voice checked by --speech)" : "say requires macOS",
    });
  } else if (local) {
    const script = resolveLocalTtsScript(env);
    const found = await findExecutable(script, env);
    checks.push({
      id: "tts", status: found ? "ok" : "error",
      message: found ? `Local ${local} script: ${script} (model checked by --speech)` : `Local TTS script missing or not executable: ${script}`,
      ...(!found ? { next_action: process.platform === "darwin"
        ? "Set UNIPUS_TTS_ENGINE=say, or install local TTS following docs/local-tts.md"
        : "Install local TTS following docs/local-tts.md" } : {}),
    });
    if (found) {
      const firstLine = (await readFile(script, "utf8")).split(/\r?\n/, 1)[0] ?? "";
      const interpreter = /^#!\s*(\/\S+)/.exec(firstLine)?.[1];
      if (interpreter && !await findExecutable(interpreter, env)) {
        checks.push({
          id: "tts_interpreter", status: "error",
          message: `TTS script interpreter missing: ${interpreter}`,
          next_action: "Update the script shebang to the local virtualenv Python",
        });
      }
    }
  } else {
    checks.push({ id: "tts", status: engine === "edge" || engine === "auto" ? "warning" : "ok",
      message: engine === "flite" ? "Local ffmpeg flite selected" : "Edge depends on network; upstream 403 is possible" });
    if ((engine === "flite" || engine === "auto") && ffmpeg) {
      try {
        const { stdout } = await promisify(execFile)(ffmpeg, ["-hide_banner", "-filters"], { timeout: 5000, maxBuffer: 1024 * 1024 });
        if (!/\bflite\b/.test(stdout)) checks.push({
          id: "flite", status: "error", message: "This ffmpeg build has no flite filter",
          next_action: process.platform === "darwin" ? "Use UNIPUS_TTS_ENGINE=say" : "Install Kokoro/Piper",
        });
      } catch {
        checks.push({ id: "flite", status: "error", message: "Could not inspect ffmpeg filters" });
      }
    }
  }
  if (options.speechProbe && !checks.some((c) => c.status === "error")) {
    try {
      const speech = await synthesizeSpeechWav({ text: "This is a local speech readiness check." }, { env });
      try {
        const wav = await readFile(speech.wavPath);
        requireSpeechFormat(wav);
        checks.push({ id: "speech_probe", status: "ok", message: `Verified 16 kHz mono 16-bit PCM WAV (${wav.length} bytes); temporary audio removed` });
      } finally {
        await speech.cleanup();
      }
    } catch (error) {
      checks.push({ id: "speech_probe", status: "error", message: (error as Error).message });
    }
  }
  const failed = checks.some((c) => c.status === "error");
  return {
    isError: failed, status: failed ? "error" : "ok", code: failed ? "PREFLIGHT_FAILED" : "OK",
    message: failed ? "Local preflight failed; fix error checks before training" : "Local preflight complete; platform login/network not probed",
    node_path: process.execPath, platform: process.platform, answer_source: answerSource, tts_engine: engine, checks,
  };
}
