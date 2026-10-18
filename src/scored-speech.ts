import { statSync } from "node:fs";
/**
 * Headless voiced answer: TTS → Clio en.sent.score → Qiniu upload → EN_SENT_SCORE /
 * EN_PRED_SCORE record carrying recordDetail + specific_scores (what the app writes
 * after in-app SOE). Without those blocks the server shows 「评分中」 forever.
 */
import { mapClioResultToReviewScores, scoreEnSent } from "./clio-speech.js";
import { buildEnSentScoreRecord } from "./grade-question.js";
import { segmentSpeakText, stripHtml, type GrindLeaf } from "./grind-paper.js";
import { AnswerRefusedError } from "./choice-solver.js";
import { resolveFfmpegPath, spawnFfmpeg, synthesizeSpeechWav } from "./tts.js";
import { uploadAnswerAudio, type UploadAnswerAudioPorts } from "./upload-answer-audio.js";
import { join } from "node:path";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

export type SpeechRecordType = "EN_SENT_SCORE" | "EN_SENT_REC" | "EN_PRED_SCORE";

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
  /** Convert scored wav → mp3 path for birdflock (App SOE uploads mp3). Default ffmpeg. */
  convertToMp3?: (wavPath: string) => Promise<string>;
  retryDelayMs?: number;
};

/** Clio failure is fatal: an unscored record would land as 「评分中」 again. */
/** Clio can be slow (≈real time or worse); scale with audio length (#78). */
export function clioTimeoutMs(wavPath: string, env?: NodeJS.ProcessEnv, sizeOf: (p: string) => number = (p) => statSync(p).size): number {
  const o = Number(env?.UNIPUS_CLIO_TIMEOUT_MS);
  if (Number.isFinite(o) && o >= 5000) return o;
  let sec = 30;
  try { sec = Math.max(1, (sizeOf(wavPath) - 44) / 32000); } catch {}
  return Math.max(120_000, Math.round(60_000 + 4_000 * sec));
}

export function createScoredSpeechRecordBuilder(
  ports: UploadAnswerAudioPorts,
  deps: ScoredSpeechDeps = {},
): SpeechRecordBuilder {
  const synthesize = deps.synthesize ?? synthesizeSpeechWav;
  const score = deps.score ?? scoreEnSent;
  const upload = deps.upload ?? uploadAnswerAudio;
  const convertToMp3 = deps.convertToMp3 ?? ((w) => wavToMp3(w, ports.env));
  const once: SpeechRecordBuilder = async (text, tag, type) => {
    const spoken = await synthesize({ text }, { env: ports.env });
    try {
      const scored = await score({ transcript: text, wavPath: spoken.wavPath, timeoutMs: clioTimeoutMs(spoken.wavPath, ports.env) }, { env: ports.env });
      const reviewScores = mapClioResultToReviewScores(scored.result);
      if (reviewScores?.score == null) throw new Error(`Clio 未返回有效分数 (${tag})`);
      // App 2.8.7 uploads mp3 (SOE/Clio path); wav CDN URLs leave 范例学习 processing.
      const mp3Path = await convertToMp3(spoken.wavPath);
      let url: string;
      try {
        const up = await upload(ports, {
          filePath: mp3Path,
          fileName: `${tag}.mp3`,
        });
        if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
          throw new Error(`upload fail: ${up.message || up.code}`);
        }
        url = String(up.cdn_url);
      } finally {
        if (mp3Path !== spoken.wavPath) await unlink(mp3Path).catch(() => {});
      }
      const record = buildEnSentScoreRecord({
        text,
        url,
        replayUrl: url,
        path: scored.audioUrl ?? undefined,
        reviewScores,
        details: wordDetails(scored.result),
      });
      record.type = type;
      // App 范例学习 records carry relevance 0 in both score blocks.
      const rd = record.recordDetail as Record<string, unknown> | undefined;
      if (rd && rd.relevance == null && type !== "EN_PRED_SCORE") rd.relevance = 0;
      for (const k of ["specific_scores", "specificScores"]) {
        const ss = record[k] as Record<string, unknown> | undefined;
        if (ss && ss.relevance == null && type !== "EN_PRED_SCORE") ss.relevance = 0;
      }
      return record;
    } finally {
      await spoken.cleanup?.();
    }
  };
  // Box egress to Clio/七牛 drops TLS intermittently; retry the whole record.
  return async (text, tag, type) => {
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await once(text, tag, type);
      } catch (e) {
        last = e;
        if (/Clio 未返回有效分数/.test(String((e as Error)?.message))) throw e;
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 3000));
      }
    }
    throw last;
  };
}

export function voicedChild(record: Record<string, unknown>) {
  return { record, value: [], isDone: true };
}

/** Follow-read style leaf (跟读 / 口语填空 / 视频配音): one scored record per child. */
export async function buildVoicedAnswer(
  leaf: GrindLeaf,
  speech: SpeechRecordBuilder,
  /** App 2.8.7: 口语填空 (oral-sentence-scoop / basic-oral oral-fill) records are EN_SENT_REC. */
  type: SpeechRecordType = "EN_SENT_SCORE",
): Promise<string> {
  const children = Array.isArray(leaf.data.children) ? leaf.data.children : [];
  const built = [];
  for (let i = 0; i < Math.max(children.length, 1); i++) {
    const text = segmentSpeakText(children[i] || {}, "");
    if (!text) throw new AnswerRefusedError(`跟读题 ${leaf.name || leaf.instanceId} 第 ${i + 1} 句缺原文，拒绝用占位句交卷`);
    built.push(voicedChild(await speech(text, `speak-${leaf.instanceId}-${i}`, type)));
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
    const word = cards.map(cardWord).filter(Boolean).join(" ");
    if (!word) throw new AnswerRefusedError(`单词跟读 ${leaf.name || leaf.instanceId} 第 ${i + 1} 组缺单词，拒绝用占位词交卷`);
    children.push(voicedChild(await speech(word, `vocab-${leaf.instanceId}-${i}`, "EN_SENT_SCORE")));
  }
  return JSON.stringify({ value: [], children });
}


/** Convert 16k wav → mp3 for birdflock upload (matches App SOE path). */
async function wavToMp3(wavPath: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unipus-mp3-"));
  const out = join(dir, "speech.mp3");
  await spawnFfmpeg(
    resolveFfmpegPath(env),
    ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-q:a", "4", out],
    "ffmpeg mp3",
  );
  return out;
}
