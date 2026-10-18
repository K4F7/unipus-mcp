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
    }));
    await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), /upload fail: qiniu down/);
  });
});

test("clioTimeoutMs scales with audio length (#78)", async () => {
  const { clioTimeoutMs } = await import("../src/scored-speech.js");
  assert.equal(clioTimeoutMs("x", {}, () => 44 + 32000 * 10), 120_000);
  assert.equal(clioTimeoutMs("x", {}, () => 44 + 32000 * 60), 300_000);
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
  const b = createScoredSpeechRecordBuilder(
    { ...(ports as object), env: { UNIPUS_TTS_RETRY_MAX_MS: "10000" } } as never,
    deps({ retryDelayMs: 0, now: (() => { let t = 0; return () => (t += 6000); })(), synthesize: async () => { n++; throw new Error("kokoro boom"); } }),
  );
  await assert.rejects(b("hi", "t", "EN_SENT_SCORE"), /kokoro boom/);
  assert.ok(n < 4, `attempts ${n}`);
});
