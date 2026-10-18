import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../src/doctor.js";

test("preflight returns actionable missing TTS/ffmpeg checks without reading secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runDoctor({ env: {
    PATH: dir, UNIPUS_LOCAL_TTS_BIN: join(dir, "missing"),
    UNIPUS_LLM_API_KEY: "must-never-appear", UNIPUS_PASSWORD: "private-password",
  } });
  assert.equal(result.code, "PREFLIGHT_FAILED");
  assert.equal(result.answer_source, "llm");
  assert.equal(result.checks.find((c) => c.id === "ffmpeg")?.status, "error");
  assert.equal(result.checks.find((c) => c.id === "tts")?.status, "error");
  assert.ok(result.checks.find((c) => c.id === "tts")?.next_action);
  assert.equal(JSON.stringify(result).includes("must-never-appear"), false);
  assert.equal(JSON.stringify(result).includes("private-password"), false);
});

test("preflight detects the Linux-only Python shebang copied to another machine", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-doctor-shebang-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "synth.py");
  await writeFile(script, "#!/nonexistent-unipus-python/bin/python\n");
  await chmod(script, 0o700);
  const result = await runDoctor({ env: {
    UNIPUS_LOCAL_TTS_BIN: script,
    UNIPUS_AGENT_ANSWER_DIR: join(dir, "answers"),
  } });
  assert.equal(result.checks.find((c) => c.id === "tts_interpreter")?.status, "error");
  assert.equal(result.answer_source, "agent_queue");
  assert.equal(result.isError, true);
});

test("preflight reports invalid queue configuration and warns about legacy answers", async () => {
  const invalid = await runDoctor({ env: { UNIPUS_AGENT_ANSWER_DIR: "relative" } });
  assert.equal(invalid.checks.find((c) => c.id === "answers")?.status, "error");
  const legacy = await runDoctor({ env: {} });
  assert.equal(legacy.answer_source, "legacy");
  assert.equal(legacy.checks.find((c) => c.id === "answers")?.status, "warning");
});

test("speech probe checks the format of a real custom TTS process output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-doctor-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "synth");
  for (const sampleRate of [16000, 44100]) {
    const wav = Buffer.alloc(48);
    wav.write("RIFF");
    wav.writeUInt32LE(40, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(4, 40);
    await writeFile(script, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv[4],Buffer.from('${wav.toString("base64")}','base64'));\n`);
    await chmod(script, 0o700);
    const result = await runDoctor({ speechProbe: true, env: {
      UNIPUS_LOCAL_TTS_BIN: script, UNIPUS_FFMPEG_BIN: process.execPath,
      UNIPUS_AGENT_ANSWER_DIR: join(dir, "answers"),
    } });
    assert.equal(result.checks.find((c) => c.id === "speech_probe")?.status, sampleRate === 16000 ? "ok" : "error");
    assert.equal(result.isError, sampleRate !== 16000);
  }
});
