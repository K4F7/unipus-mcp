import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  defaultLocalTtsEngine,
  resolveFfmpegPath,
  resolveLocalTtsEngine,
  sayArgs,
  synthesizeSpeechWav,
} from "../src/tts.js";

test("unset engine follows the platform (darwin → say, else kokoro); explicit and legacy win", () => {
  assert.equal(defaultLocalTtsEngine("darwin"), "say");
  assert.equal(defaultLocalTtsEngine("linux"), "kokoro");
  assert.equal(defaultLocalTtsEngine("win32"), "kokoro");
  assert.equal(resolveLocalTtsEngine({}, false, "darwin"), "say");
  assert.equal(resolveLocalTtsEngine({}, false, "linux"), "kokoro");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "kokoro" }, false, "darwin"), "kokoro");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "say" }, false, "linux"), "say");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "piper" }), "piper");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "edge" }, false, "darwin"), null);
  assert.equal(resolveLocalTtsEngine({}, true, "darwin"), null);
});

test("say argv always writes to a file with -o; refuses to build an argv without one", () => {
  const argv = sayArgs("Samantha", "/tmp/x/speech.aiff");
  assert.deepEqual(argv, ["-v", "Samantha", "-o", "/tmp/x/speech.aiff"]);
  assert.equal(argv[argv.indexOf("-o") + 1], "/tmp/x/speech.aiff");
  assert.throws(() => sayArgs("Samantha", ""), /必须带 -o/);
  assert.throws(() => sayArgs("Samantha", "  "), /必须带 -o/);
});

test("src/tts.ts spawns say only through sayArgs (never without -o)", () => {
  const src = readFileSync(new URL("../src/tts.ts", import.meta.url), "utf8");
  const spawns = src.match(/spawn\(\s*(SAY_BIN|["'][^"']*\bsay["'])[^)]*/g) ?? [];
  assert.ok(spawns.length >= 1);
  for (const call of spawns) assert.match(call, /sayArgs\(/);
});

test("resolveFfmpegPath: UNIPUS_FFMPEG_BIN > UNIPUS_FFMPEG > ffmpeg", () => {
  assert.equal(resolveFfmpegPath({}), "ffmpeg");
  assert.equal(resolveFfmpegPath({ UNIPUS_FFMPEG: "/a" }), "/a");
  assert.equal(resolveFfmpegPath({ UNIPUS_FFMPEG: "/a", UNIPUS_FFMPEG_BIN: "/b" }), "/b");
});

test("local synthesis failure throws (no flite/edge fallback)", async () => {
  let fallbackCalled = false;
  await assert.rejects(
    synthesizeSpeechWav({ text: "hello" }, {
      env: {},
      synthesizeLocalWav: async () => { throw new Error("kokoro boom"); },
    }),
    /kokoro boom/,
  );
  assert.equal(fallbackCalled, false);
});

test("local synthesis writes to returned wav path", async () => {
  let got = "";
  const r = await synthesizeSpeechWav({ text: "hello" }, {
    env: {},
    synthesizeLocalWav: async (_t, p) => { got = p; },
  });
  assert.equal(r.wavPath, got);
  await r.cleanup();
});

test("Kokoro script that dies before reading stdin rejects (EPIPE handled, no crash)", async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localSynthesizeWav } = await import("../src/tts.js");
  const dir = await mkdtemp(join(tmpdir(), "tts-epipe-"));
  const bin = join(dir, "synth.sh");
  await writeFile(bin, "#!/bin/sh\nexit 3\n");
  await chmod(bin, 0o755);
  try {
    const run = localSynthesizeWav("kokoro", { UNIPUS_LOCAL_TTS_BIN: bin });
    await assert.rejects(run("word ".repeat(400_000), join(dir, "o.wav")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
