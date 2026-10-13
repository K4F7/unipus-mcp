/**
 * Headless voiced answer: TTS → Clio en.sent.score → Qiniu upload → EN_SENT_SCORE /
 * EN_PRED_SCORE record carrying recordDetail + specific_scores (what the app writes
 * after in-app SOE). Without those blocks the server shows 「评分中」 forever.
 */
import { mapClioResultToReviewScores, scoreEnSent } from "./clio-speech.js";
import { buildEnSentScoreRecord } from "./grade-question.js";
import { segmentSpeakText, stripHtml, type GrindLeaf } from "./grind-paper.js";
import { synthesizeSpeechWav } from "./tts.js";
import { uploadAnswerAudio, type UploadAnswerAudioPorts } from "./upload-answer-audio.js";

export type SpeechRecordType = "EN_SENT_SCORE" | "EN_PRED_SCORE";

export type SpeechRecordBuilder = (
  text: string,
  tag: string,
  type: SpeechRecordType,
) => Promise<Record<string, unknown>>;

function wordDetails(result: Record<string, unknown>): Array<{ char: string; score: number }> {
  const raw = Array.isArray(result.details) ? result.details : [];
  return raw.flatMap((d) => {
    const r = (d ?? {}) as Record<string, unknown>;
    const char = typeof r.word === "string" ? r.word : typeof r.char === "string" ? r.char : null;
    return char != null && typeof r.score === "number" ? [{ char, score: r.score }] : [];
  });
}

/** Test seams for the three network steps. */
export type ScoredSpeechDeps = {
  synthesize?: typeof synthesizeSpeechWav;
  score?: typeof scoreEnSent;
  upload?: typeof uploadAnswerAudio;
};

/** Clio failure is fatal: an unscored record would land as 「评分中」 again. */
export function createScoredSpeechRecordBuilder(
  ports: UploadAnswerAudioPorts,
  deps: ScoredSpeechDeps = {},
): SpeechRecordBuilder {
  const synthesize = deps.synthesize ?? synthesizeSpeechWav;
  const score = deps.score ?? scoreEnSent;
  const upload = deps.upload ?? uploadAnswerAudio;
  return async (text, tag, type) => {
    const spoken = await synthesize({ text }, { env: ports.env });
    try {
      const scored = await score({ transcript: text, wavPath: spoken.wavPath, timeoutMs: 45_000 }, { env: ports.env });
      const reviewScores = mapClioResultToReviewScores(scored.result);
      if (reviewScores?.score == null) throw new Error(`Clio 未返回有效分数 (${tag})`);
      const up = await upload(ports, { filePath: spoken.wavPath, fileName: `${tag}.wav` });
      if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
        throw new Error(`upload fail: ${up.message || up.code}`);
      }
      const url = String(up.cdn_url);
      const record = buildEnSentScoreRecord({
        text,
        url,
        replayUrl: url,
        path: scored.audioUrl ?? undefined,
        reviewScores,
        details: wordDetails(scored.result),
      });
      record.type = type;
      return record;
    } finally {
      await spoken.cleanup?.();
    }
  };
}

export function voicedChild(record: Record<string, unknown>) {
  return { record, value: [], isDone: true };
}

/** Follow-read style leaf (跟读 / 口语填空 / 视频配音): one scored record per child. */
export async function buildVoicedAnswer(leaf: GrindLeaf, speech: SpeechRecordBuilder): Promise<string> {
  const children = Array.isArray(leaf.data.children) ? leaf.data.children : [];
  const built = [];
  for (let i = 0; i < Math.max(children.length, 1); i++) {
    const text = segmentSpeakText(children[i] || {}, `Speaking practice sentence ${i + 1}.`);
    built.push(voicedChild(await speech(text, `speak-${leaf.instanceId}-${i}`, "EN_SENT_SCORE")));
  }
  return JSON.stringify({ value: [], children: built });
}

/** 单词跟读: word cards live in contents[] (audio papers) or children[].contents[] (video papers). */
export async function buildVocabAnswer(leaf: GrindLeaf, speech: SpeechRecordBuilder): Promise<string> {
  const cardWord = (c: unknown) => stripHtml(String((c as Record<string, unknown> | null)?.name ?? ""));
  const kids = Array.isArray(leaf.data.children) ? leaf.data.children : [];
  const groups = kids.length > 0
    ? kids.map((k) => ((k as Record<string, unknown> | null)?.contents as unknown[] | undefined) ?? [])
    : [Array.isArray(leaf.data.contents) ? leaf.data.contents : []];
  const children = [];
  for (const [i, cards] of groups.entries()) {
    const word = cards.map(cardWord).filter(Boolean).join(" ") || "hello";
    children.push(voicedChild(await speech(word, `vocab-${leaf.instanceId}-${i}`, "EN_SENT_SCORE")));
  }
  return JSON.stringify({ value: [], children });
}
