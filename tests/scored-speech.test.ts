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
