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

test("doctor lists the #92 wall-clock budgets and flags a synth.py without speed/pause support", () => {
  const r = doctorReport({ PATH: "/usr/bin", UNIPUS_AI_REPORT_MAX_MS: "300000" }, "linux", all, () => "#!/py\n# usage: synth.py <engine> <voice> <out.wav> [speed] [sentence_pause_sec]\n");
  const t = r.checks.find((c) => c.name === "timeouts")!.detail;
  for (const s of ["App 分轮询 5000ms/上限 180000ms", "part-report 轮询 30000ms/上限 300000ms", "TTS 重试总 600000ms", "单 part 900000ms", "整卷 2400000ms", "AI 每轮 ≥55000ms", "自由表达 ≥90s 语速 0.85", "LLM 单次 180000ms/max_tokens 1024"]) {
    assert.ok(t.includes(s), `${s} in ${t}`);
  }
  assert.equal(tts(r).ok, true);
  const old = doctorReport({ PATH: "/usr/bin" }, "linux", all, () => "#!/py\neng, voice, out = sys.argv[1:4]\n");
  assert.equal(tts(old).ok, false);
  assert.match(tts(old).detail, /语速|停顿/);
});
