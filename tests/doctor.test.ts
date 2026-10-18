import assert from "node:assert/strict";
import { test } from "node:test";
import { doctorReport } from "../src/doctor.js";

const tts = (r: ReturnType<typeof doctorReport>) => r.checks.find((c) => c.name === "tts")!;
const all = () => true;

test("doctor shows say on macOS and kokoro elsewhere", () => {
  const mac = doctorReport({ PATH: "/usr/bin" }, "darwin", all);
  assert.match(tts(mac).detail, /^say/);
  assert.equal(tts(mac).ok, true);
  const linux = doctorReport({ PATH: "/usr/bin" }, "linux", all);
  assert.match(tts(linux).detail, /^kokoro/);
  const explicit = doctorReport({ PATH: "/usr/bin", UNIPUS_TTS_ENGINE: "kokoro" }, "darwin", all);
  assert.match(tts(explicit).detail, /^kokoro/);
});

test("doctor flags missing ffmpeg / tts script and never echoes the LLM key", () => {
  const r = doctorReport({ PATH: "/nowhere", UNIPUS_LLM_API_KEY: "sk-secret" }, "linux", () => false);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "ffmpeg")!.ok, false);
  assert.equal(tts(r).ok, false);
  assert.doesNotMatch(JSON.stringify(r), /sk-secret/);
  const llm = r.checks.find((c) => c.name === "llm")!;
  assert.equal(llm.ok, false);
  assert.match(llm.detail, /缺 UNIPUS_LLM_BASE_URL \/ UNIPUS_LLM_MODEL/);
  const full = doctorReport({ PATH: "/usr/bin", UNIPUS_LLM_BASE_URL: "https://x/v1", UNIPUS_LLM_MODEL: "m", UNIPUS_LLM_API_KEY: "sk-secret" }, "linux", all);
  assert.equal(full.checks.find((c) => c.name === "llm")!.ok, true);
  assert.doesNotMatch(JSON.stringify(full), /sk-secret|https:\/\/x/);
});
