import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
};

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
    (async (t: string, v: string, out: string) => {
      const { EdgeTTS } = await import("node-edge-tts");
      const tts = new EdgeTTS({ voice: v, lang: v.startsWith("zh") ? "zh-CN" : "en-US" });
      await tts.ttsPromise(t, out);
    });

  try {
    await synthesize(text, voice, mp3Path);
    await runFfmpeg(ports.ffmpegPath ?? "ffmpeg", mp3Path, wavPath);
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
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ["-y", "-i", mp3Path, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 转码失败 (code=${code}): ${err.slice(-400)}`));
    });
  });
}
