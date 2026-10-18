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

test("speed / sentence pause reach the local engine: kokoro argv, say rate + [[slnc]] (#92)", async () => {
  const { mkdtemp, writeFile, chmod, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localSynthesizeWav, sayRateArgs, withSayPauses } = await import("../src/tts.js");
  const dir = await mkdtemp(join(tmpdir(), "tts-args-"));
  const bin = join(dir, "synth.sh");
  await writeFile(bin, `#!/bin/sh\necho "$@" > ${dir}/argv\ncat > /dev/null\n: > "$3"\n`);
  await chmod(bin, 0o755);
  try {
    await localSynthesizeWav("kokoro", { UNIPUS_LOCAL_TTS_BIN: bin })("Hi. Bye.", join(dir, "o.wav"), { speed: 0.85, pauseSec: 0.6 });
    assert.equal((await readFile(join(dir, "argv"), "utf8")).trim().split(" ").slice(3).join(" "), "0.85 0.6");
    await localSynthesizeWav("kokoro", { UNIPUS_LOCAL_TTS_BIN: bin })("Hi.", join(dir, "o2.wav"));
    assert.equal((await readFile(join(dir, "argv"), "utf8")).trim().split(" ").length, 3, "old 3-arg call stays compatible");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(sayRateArgs(0.85), ["-r", "149"]);
  assert.deepEqual(sayRateArgs(undefined), []);
  assert.equal(withSayPauses("I was sick. I rested! Then?", 0.6), "I was sick. [[slnc 600]] I rested! [[slnc 600]] Then?");
  assert.equal(withSayPauses("One. Two.", 0), "One. Two.");
});

test("synthesizeSpeechWav passes speed/pause options to the local engine", async () => {
  let got: unknown;
  const r = await synthesizeSpeechWav({ text: "hello", speed: 0.8, pauseSec: 0.5 }, {
    env: {},
    synthesizeLocalWav: async (_t, _p, o) => { got = o; },
  });
  await r.cleanup();
  assert.deepEqual(got, { speed: 0.8, pauseSec: 0.5 });
});
