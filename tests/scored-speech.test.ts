import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { okUploadAnswerAudio, toolError } from "../src/result.js";
import { createScoredSpeechRecordBuilder, type ScoredSpeechDeps } from "../src/scored-speech.js";

const ports = { credentials: { getJwt: async () => "jwt" }, http: { request: async () => ({ statusCode: 200, body: "{}" }) } } as never;
const CDN = "https://birdflock.unipus.cn/ans-prod/a.wav";
const CLIO = "https://clio-audios.unipus.cn/a.mp3";

function deps(over: Partial<ScoredSpeechDeps> & { cleaned?: string[] } = {}): ScoredSpeechDeps {
  const cleaned = over.cleaned ?? [];
  return {
    convertToMp3: async (w: string) => w,
    synthesize: async () => ({ wavPath: "/tmp/x.wav", cleanup: async () => void cleaned.push("x") }),
    score: async () => ({
      overall: 94, total: 94, audioUrl: CLIO, raw: {},
      result: { total: 94, accuracy: 90, completeness: 100, fluency: { overall: 95 }, details: [{ word: "hi", score: 99 }] },
    }),
    upload: async () => okUploadAnswerAudio({ message: "ok", file_name: "a.wav", storage_key: "k", cdn_url: CDN, upload_hash: null }),
    ...over,
  };
}

describe("scored-speech", () => {
  test("EN_SENT_SCORE record carries recordDetail + specific_scores", async () => {
    const rec = await createScoredSpeechRecordBuilder(ports, deps())("hi", "t", "EN_SENT_SCORE");
    assert.equal(rec.type, "EN_SENT_SCORE");
    assert.equal(rec.url, CDN);
    assert.equal(rec.path, CLIO);
    assert.deepEqual((rec.recordDetail as { details: unknown }).details, [{ char: "hi", score: 99 }]);
    assert.deepEqual(rec.specific_scores, { total: 0.94, fluency: 0.95, integrity: 1, accuracy: 0.9, relevance: 0 });
    assert.deepEqual(rec.specificScores, rec.specific_scores);
  });

  test("a built record logs its TTS / Clio / upload durations (#100)", async () => {
    let t = 0;
    const logs: string[] = [];
    const tick = <T>(ms: number, v: T) => async () => { t += ms; return v; };
    const base = deps();
    const b = createScoredSpeechRecordBuilder(ports, deps({
      now: () => t, log: (l) => logs.push(l),
      synthesize: async (...a) => { t += 1200; return base.synthesize!(...a); },
      score: async (...a) => { t += 3400; return base.score!(...a); },
      upload: async (...a) => { t += 800; return base.upload!(...a); },
      convertToMp3: tick(100, "/tmp/x.mp3"),
    }));
    await b("hi", "vocab-1-0", "EN_SENT_SCORE");
    assert.deepEqual(logs, ["vocab-1-0 用时 TTS 合成 1.2s / Clio 评分 3.4s / mp3 转码 0.1s / 上传 0.8s（共 5.5s）"]);
  });

  test("EN_PRED_SCORE keeps the same score blocks", async () => {
    const rec = await createScoredSpeechRecordBuilder(ports, deps())("hi", "t", "EN_PRED_SCORE");
    assert.equal(rec.type, "EN_PRED_SCORE");
    assert.equal((rec.recordDetail as { score: number }).score, 94);
  });

  test("Clio without a score throws (no unscored record) and cleans up", async () => {
    const cleaned: string[] = [];
    let uploaded = false;
    const b = createScoredSpeechRecordBuilder(ports, deps({
      cleaned,
      score: async () => ({ overall: null, total: null, audioUrl: CLIO, raw: {}, result: { details: [] } }),
      upload: async () => { uploaded = true; throw new Error("unreachable"); },
    }));
    await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), /Clio 未返回有效分数/);
    assert.equal(uploaded, false);
    assert.deepEqual(cleaned, ["x"]);
  });

  test("upload failure throws", async () => {
    const b = createScoredSpeechRecordBuilder(ports, deps({
      upload: async () => toolError("UPSTREAM_ERROR", "qiniu down"),
      retryDelayMs: 1, sleep: async () => {}, log: () => {},
    }));
    await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), /upload fail: qiniu down/);
  });
});

test("clioTimeoutMs ≈ 30s + 3×audio s, clamped to [45s, UNIPUS_CLIO_MAX_MS] (#78, #98)", async () => {
  const { clioTimeoutMs } = await import("../src/scored-speech.js");
  const sec = (s: number) => () => 44 + 32000 * s;
  // Probe: Clio took 3–5s for 3s audio, 41s for 20s, 215s for 94s (≈2.2× audio).
  assert.equal(clioTimeoutMs("x", {}, sec(3)), 45_000);
  assert.equal(clioTimeoutMs("x", {}, sec(20)), 90_000);
  assert.equal(clioTimeoutMs("x", {}, sec(94)), 312_000);
  assert.equal(clioTimeoutMs("x", {}, sec(200)), 360_000);
  assert.equal(clioTimeoutMs("x", { UNIPUS_CLIO_MAX_MS: "200000" }, sec(94)), 200_000);
  assert.equal(clioTimeoutMs("x", { UNIPUS_CLIO_TIMEOUT_MS: "90000" }, () => 0), 90_000);
});

test("voiced / vocab items without source text → refused, never a placeholder sentence", async () => {
  const { buildVoicedAnswer, buildVocabAnswer } = await import("../src/scored-speech.js");
  const { AnswerRefusedError } = await import("../src/choice-solver.js");
  const spoken: string[] = [];
  const speech = async (t: string) => { spoken.push(t); return { url: "u" }; };
  const leaf = (data: Record<string, unknown>) => ({ instanceId: "1", name: "跟读", data }) as never;
  await assert.rejects(buildVoicedAnswer(leaf({ children: [{}] }), speech as never), AnswerRefusedError);
  await assert.rejects(buildVocabAnswer(leaf({ contents: [] }), speech as never), AnswerRefusedError);
  assert.deepEqual(spoken, []);
});

describe("free-talk duration gate (#92)", () => {
  const wavOf = async (sec: number) => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const p = join(await mkdtemp(join(tmpdir(), "ss-")), "a.wav");
    await writeFile(p, Buffer.alloc(44 + Math.round(sec * 32000)));
    return p;
  };
  /** Synth mock: 80 s of speech + (sentences-1) × pause. */
  const synth = (calls: Array<{ speed?: number; pauseSec?: number }>, speechSec = 80) =>
    (async (input: { text: string; speed?: number; pauseSec?: number }) => {
      calls.push({ speed: input.speed, pauseSec: input.pauseSec });
      const gaps = input.text.split(/[.!?]\s+/).length - 1;
      return { wavPath: await wavOf(speechSec + gaps * (input.pauseSec ?? 0)), cleanup: async () => {} };
    }) as never;
  const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(" ");

  test("short audio → re-synthesised once with longer sentence pauses, reports the final seconds", async () => {
    const calls: Array<{ speed?: number; pauseSec?: number }> = [];
    let sec = 0;
    const b = createScoredSpeechRecordBuilder(ports, deps({ synthesize: synth(calls) }));
    await b(text, "t", "EN_PRED_SCORE", { speed: 0.85, pauseSec: 0.3, minSec: 90, onAudio: (s) => (sec = s) });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.speed, 0.85);
    assert.ok(calls[1]!.pauseSec! > 0.3);
    assert.ok(sec >= 90, String(sec));
  });

  test("needed pause just over the cap → retried at the cap instead of giving up (review #93)", async () => {
    const calls: Array<{ speed?: number; pauseSec?: number }> = [];
    let sec = 0;
    const b = createScoredSpeechRecordBuilder(ports, deps({ synthesize: synth(calls, 68) }));
    await b(text, "t", "EN_PRED_SCORE", { pauseSec: 0.3, minSec: 90, onAudio: (s) => (sec = s) });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.pauseSec, 1.2);
    assert.ok(sec >= 90, String(sec));
  });

  test("still short with the max pause → SpeechTooShortError before Clio/upload", async () => {
    const { SpeechTooShortError } = await import("../src/scored-speech.js");
    let scored = false;
    const b = createScoredSpeechRecordBuilder(ports, deps({
      synthesize: synth([], 40),
      score: async () => { scored = true; throw new Error("unreachable"); },
    }));
    await assert.rejects(b(text, "t", "EN_PRED_SCORE", { minSec: 90, pauseSec: 0.3 }), SpeechTooShortError);
    assert.equal(scored, false);
  });
});

test("voiced record retries stop at UNIPUS_TTS_RETRY_MAX_MS wall budget", async () => {
  let n = 0;
  let t = 0;
  const b = createScoredSpeechRecordBuilder(
    { ...(ports as object), env: { UNIPUS_TTS_RETRY_MAX_MS: "10000" } } as never,
    deps({ retryDelayMs: 1000, now: () => t, sleep: async (ms) => void (t += ms), log: () => {}, synthesize: async () => { n++; t += 6000; throw new Error("kokoro boom"); } }),
  );
  await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), /kokoro boom/);
  assert.ok(n < 4, `attempts ${n}`);
});

describe("voiced record retries (#98)", () => {
  test("Clio failure → retried with backoff, logged with the stage, audio synthesised once", async () => {
    let synth = 0;
    let scored = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    const b = createScoredSpeechRecordBuilder(ports, deps({
      retryDelayMs: 3000, sleep: async (ms) => void sleeps.push(ms), log: (l) => logs.push(l),
      synthesize: async () => { synth++; return { wavPath: "/tmp/x.wav", cleanup: async () => {} }; },
      score: async () => {
        if (++scored < 3) throw new Error("Clio WSS 超时 (45000ms)");
        return { overall: 90, total: 90, audioUrl: CLIO, raw: {}, result: { total: 90, accuracy: 90, completeness: 100, fluency: { overall: 90 }, details: [] } };
      },
    }));
    const rec = await b("hi", "speak-7-0", "EN_SENT_SCORE");
    assert.equal(rec.url, CDN);
    assert.equal(synth, 1);
    assert.equal(scored, 3);
    assert.deepEqual(sleeps, [3000, 6000]);
    assert.equal(logs.length, 3, "two failures + the success timing line");
    assert.match(logs[0]!, /speak-7-0 第 1\/4 次失败.*Clio 评分失败：Clio WSS 超时/);
    assert.match(logs[2]!, /speak-7-0 用时 TTS 合成 .*Clio 评分 .*上传 /);
  });

  test("Clio gets min(scaled timeout, remaining budget)", async () => {
    const timeouts: number[] = [];
    const b = createScoredSpeechRecordBuilder(
      { ...(ports as object), env: { UNIPUS_TTS_RETRY_MAX_MS: "20000" } } as never,
      deps({ score: async (input) => { timeouts.push(input.timeoutMs!); throw new Error("Clio WSS 超时"); }, retryDelayMs: 1, sleep: async () => {}, log: () => {} }),
    );
    await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), /Clio 评分失败/);
    assert.ok(timeouts.length >= 1);
    assert.ok(timeouts.every((ms) => ms <= 20_000), String(timeouts));
  });

  test("final error names the failed stage and keeps the TIMEOUT class", async () => {
    const { classifyError } = await import("../src/retry.js");
    const b = createScoredSpeechRecordBuilder(ports, deps({
      upload: async () => { throw new Error("The operation was aborted due to timeout (60000ms)"); },
      retryDelayMs: 1, sleep: async () => {}, log: () => {},
    }));
    await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), (e: Error) => /上传失败/.test(e.message) && /4 次均失败/.test(e.message) && classifyError(e) === "TIMEOUT");
  });

  test("synthesis failure is retried, then the record succeeds", async () => {
    let synth = 0;
    const b = createScoredSpeechRecordBuilder(ports, deps({
      retryDelayMs: 1, sleep: async () => {}, log: () => {},
      synthesize: async () => { if (++synth === 1) throw new Error("kokoro crashed"); return { wavPath: "/tmp/x.wav", cleanup: async () => {} }; },
    }));
    assert.equal((await b("hi", "t", "EN_SENT_SCORE")).url, CDN);
    assert.equal(synth, 2);
  });
});
