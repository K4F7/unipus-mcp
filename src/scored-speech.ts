import { statSync } from "node:fs";
/**
 * Headless voiced answer: TTS → Clio en.sent.score → Qiniu upload → EN_SENT_SCORE /
 * EN_PRED_SCORE record carrying recordDetail + specific_scores (what the app writes
 * after in-app SOE). Without those blocks the server shows 「评分中」 forever.
 */
import { isClioAudioOverflow, mapClioResultToReviewScores, scoreEnSent } from "./clio-speech.js";
import { buildEnSentScoreRecord } from "./grade-question.js";
import { segmentSpeakText, stripHtml, type GrindLeaf } from "./grind-paper.js";
import { AnswerRefusedError } from "./choice-solver.js";
import { resolveFfmpegPath, spawnFfmpeg, synthesizeSpeechWav } from "./tts.js";
import { uploadAnswerAudio, type UploadAnswerAudioPorts } from "./upload-answer-audio.js";
import {
  resolveClioMaxAudioSec,
  resolveClioMaxMs,
  resolveFreeTalkClioMaxMs,
  resolveFreeTalkTtsRetryMaxMs,
  resolveTtsRetryMaxMs,
} from "./limits.js";
import { retryWithinBudget, toError } from "./retry.js";
import { activeNow } from "./watchdog.js";
import { join } from "node:path";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

export type SpeechRecordType = "EN_SENT_SCORE" | "EN_SENT_REC" | "EN_PRED_SCORE";

/** 自由表达 prosody + duration gate (#92). */
export type SpeechOptions = {
  speed?: number;
  /** Silence between sentences (s). */
  pauseSec?: number;
  /**
   * Cap when stretching short recordings (#104). Defaults to MAX_SENTENCE_PAUSE_SEC.
   * After a Clio 1006, set equal to the tightened pause so stretch cannot undo it.
   */
  maxPauseSec?: number;
  /** Minimum recording length (s); shorter audio is never scored or uploaded. */
  minSec?: number;
  /** Final recording length (s) of the voiced answer. */
  onAudio?: (sec: number) => void;
};

export type SpeechRecordBuilder = (
  text: string,
  tag: string,
  type: SpeechRecordType,
  opts?: SpeechOptions,
) => Promise<Record<string, unknown>>;

/** Recording still shorter than minSec with the longest natural sentence pause. */
export class SpeechTooShortError extends Error {
  constructor(readonly sec: number, readonly minSec: number) {
    super(`录音 ${sec.toFixed(1)}s < ${minSec}s（已加长句间停顿仍不够）`);
    this.name = "SpeechTooShortError";
  }
}

/**
 * Clio 1006 on 自由表达 that a tighter pause cannot fix (or audio over UNIPUS_CLIO_MAX_AUDIO_SEC):
 * the caller needs a shorter script (#108). Message keeps "1006 audio overflow" so the paper
 * loop still classifies it as CLIO_CAPACITY.
 */
export class ClioOverflowError extends Error {
  constructor(readonly sec: number, readonly pauseSec: number, detail: string) {
    super(`${detail}（${sec.toFixed(1)}s wav，句间 ${pauseSec.toFixed(2)}s，需缩稿）`);
    this.name = "ClioOverflowError";
  }
}

/**
 * App scores open speech (自由表达, EN_PRED_SCORE) with Clio en.pred.score and streams small frames. On a 93 s
 * clip that answers in ~101 s vs ~168 s for en.sent.score in one frame; the slow path ran into Clio's ~4 min
 * close=1006 (#118).
 */
export const FREE_TALK_CLIO_API = "en.pred.score";

/** Longest silence inserted between sentences when stretching a short recording. */
export const MAX_SENTENCE_PAUSE_SEC = 1.2;

/** How far to shrink the sentence pause after each Clio 1006 (#104). */
export const FREE_TALK_PAUSE_TIGHTEN_STEP_SEC = 0.2;

/** 16 kHz mono s16 WAV → seconds. */
export function wavSeconds(wavPath: string, sizeOf: (p: string) => number = (p) => statSync(p).size): number {
  return Math.max(0, (sizeOf(wavPath) - 44) / 32000);
}

/** Sentence gaps used for pause stretch / tighten (same split as TTS pause insertion). */
export function sentenceGaps(text: string): number {
  return Math.max(0, text.split(/[.!?]\s+(?=\S)/).length - 1);
}

/**
 * Next sentence pause after Clio `1006 audio overflow` on free-talk (#104).
 * Keeps the speech body fixed and only shortens silence, never below the pause
 * that still yields ≥ minSec (+0.5 s slack). Returns null when it cannot tighten.
 */
export function nextFreeTalkPauseAfterOverflow(
  usedPause: number,
  wavSec: number,
  gaps: number,
  minSec: number,
  stepSec = FREE_TALK_PAUSE_TIGHTEN_STEP_SEC,
): number | null {
  if (gaps <= 0 || stepSec <= 0) return null;
  const speechSec = Math.max(0, wavSec - gaps * usedPause);
  const floor = Math.max(0, (minSec + 0.5 - speechSec) / gaps);
  const next = Math.max(floor, usedPause - stepSec);
  if (next >= usedPause - 0.05) return null;
  if (speechSec + gaps * next < minSec) return null;
  return Math.round(next * 100) / 100;
}

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
  /** First retry backoff (doubles per retry, capped at 30 s); default 3000. */
  retryDelayMs?: number;
  /** Clock for the retry budget and step timings; default activeNow (tests inject). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt failure log; default stderr. */
  log?: (line: string) => void;
};

/**
 * One Clio request. Clio answers in ≈2.2× the audio length (probe #98: 3 s → 3–5 s,
 * 20 s → 41 s, 94 s → 215 s), so allow 30 s + 3× audio, within [45 s, UNIPUS_CLIO_MAX_MS]
 * (自由表达 uses UNIPUS_FREE_TALK_CLIO_MAX_MS, #104).
 * UNIPUS_CLIO_TIMEOUT_MS pins a fixed value. A Clio failure is never skipped: an
 * unscored record would land as 「评分中」 again.
 */
export function clioTimeoutMs(
  wavPath: string,
  env?: NodeJS.ProcessEnv,
  sizeOf: (p: string) => number = (p) => statSync(p).size,
  opts: { freeTalk?: boolean } = {},
): number {
  const o = Number(env?.UNIPUS_CLIO_TIMEOUT_MS);
  if (Number.isFinite(o) && o >= 5000) return o;
  let sec = 30;
  try { sec = Math.max(1, (sizeOf(wavPath) - 44) / 32000); } catch {}
  const cap = opts.freeTalk ? resolveFreeTalkClioMaxMs(env ?? {}) : resolveClioMaxMs(env ?? {});
  return Math.min(cap, Math.max(45_000, Math.round(30_000 + 3_000 * sec)));
}

/** Errors a retry cannot fix: rethrown as-is. */
function isFatalSpeechError(e: Error): boolean {
  return e instanceof SpeechTooShortError || e instanceof ClioOverflowError || e instanceof AnswerRefusedError || /Clio 未返回有效分数/.test(e.message);
}

/** Step name → duration (ms) of one record's latest attempt. */
type StepTimings = Map<string, number>;

/**
 * Prefix the failing step so the log / JSONL says where a record died (#98), and
 * time it so a built record logs where its time went (#100).
 */
async function step<T>(timings: StepTimings, now: () => number, name: string, run: () => Promise<T>): Promise<T> {
  const start = now();
  try {
    return await run();
  } catch (e) {
    const err = toError(e);
    if (isFatalSpeechError(err)) throw err;
    throw new Error(`${name}失败：${err.message}`, { cause: err });
  } finally {
    timings.set(name, now() - start);
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

type SpokenWav = {
  wavPath: string;
  cleanup?: () => void | Promise<void>;
  pauseSec: number;
  sec: number;
};

export function createScoredSpeechRecordBuilder(
  ports: UploadAnswerAudioPorts,
  deps: ScoredSpeechDeps = {},
): SpeechRecordBuilder {
  const synthesize = deps.synthesize ?? synthesizeSpeechWav;
  const score = deps.score ?? scoreEnSent;
  const upload = deps.upload ?? uploadAnswerAudio;
  const convertToMp3 = deps.convertToMp3 ?? ((w) => wavToMp3(w, ports.env));
  const now = deps.now ?? activeNow;
  const log = deps.log ?? ((line: string) => console.error(`[speech] ${line}`));
  const synthesizeLongEnough = async (text: string, opts: SpeechOptions = {}): Promise<SpokenWav> => {
    let pauseSec = opts.pauseSec ?? 0;
    let spoken = await synthesize({ text, speed: opts.speed, pauseSec: opts.pauseSec }, { env: ports.env });
    if (!opts.minSec) {
      // Short utterances never stretch; avoid stat'ing test mock paths.
      return { wavPath: spoken.wavPath, cleanup: spoken.cleanup, pauseSec, sec: 0 };
    }
    let sec = wavSeconds(spoken.wavPath);
    const gaps = sentenceGaps(text);
    const pauseCap = Math.min(
      MAX_SENTENCE_PAUSE_SEC,
      opts.maxPauseSec ?? MAX_SENTENCE_PAUSE_SEC,
    );
    if (sec < opts.minSec && gaps > 0) {
      // Stretch only the pauses between sentences (speech itself unchanged), within a natural limit.
      const stretched = Math.min(pauseCap, (opts.pauseSec ?? 0) + (opts.minSec + 0.5 - sec) / gaps);
      if (stretched > (opts.pauseSec ?? 0)) {
        await spoken.cleanup?.();
        console.error(`[speech] 录音 ${sec.toFixed(1)}s < ${opts.minSec}s，句间停顿加到 ${stretched.toFixed(2)}s 重合成`);
        pauseSec = stretched;
        spoken = await synthesize({ text, speed: opts.speed, pauseSec }, { env: ports.env });
        sec = wavSeconds(spoken.wavPath);
      }
    }
    if (sec < opts.minSec) {
      await spoken.cleanup?.();
      throw new SpeechTooShortError(sec, opts.minSec);
    }
    const maxSec = resolveClioMaxAudioSec(ports.env);
    if (maxSec > 0 && sec > maxSec) {
      // Over the configured Clio ceiling: shrink silence once (still ≥ minSec), else ask for a shorter script.
      const speechSec = sec - gaps * pauseSec;
      const fit = gaps > 0 ? Math.max((opts.minSec + 0.5 - speechSec) / gaps, (maxSec - 0.5 - speechSec) / gaps) : pauseSec;
      if (fit >= 0 && fit < pauseSec) {
        await spoken.cleanup?.();
        pauseSec = Math.round(fit * 100) / 100;
        spoken = await synthesize({ text, speed: opts.speed, pauseSec }, { env: ports.env });
        sec = wavSeconds(spoken.wavPath);
      }
      if (sec > maxSec || sec < opts.minSec) {
        await spoken.cleanup?.();
        throw new ClioOverflowError(sec, pauseSec, `录音超过 UNIPUS_CLIO_MAX_AUDIO_SEC=${maxSec}s，未送 Clio（1006 audio overflow 预防）`);
      }
    }
    opts.onAudio?.(sec);
    return { wavPath: spoken.wavPath, cleanup: spoken.cleanup, pauseSec, sec };
  };
  /** Clio → mp3 → upload for an already synthesised wav. */
  const scoreAndUpload = async (
    timings: StepTimings,
    spoken: SpokenWav,
    text: string,
    tag: string,
    type: SpeechRecordType,
    remainingMs: number,
    freeTalk: boolean,
  ) => {
    const timeoutMs = Math.min(clioTimeoutMs(spoken.wavPath, ports.env, undefined, { freeTalk }), remainingMs);
    const scored = await step(timings, now, "Clio 评分", () => score({ transcript: text, wavPath: spoken.wavPath, timeoutMs, ...(freeTalk ? { apiName: FREE_TALK_CLIO_API } : {}) }, { env: ports.env }));
    const reviewScores = mapClioResultToReviewScores(scored.result);
    if (reviewScores?.score == null) throw new Error(`Clio 未返回有效分数 (${tag})`);
    // App 2.8.7 uploads mp3 (SOE/Clio path); wav CDN URLs leave 范例学习 processing.
    const mp3Path = await step(timings, now, "mp3 转码", () => convertToMp3(spoken.wavPath));
    let url: string;
    try {
      url = await step(timings, now, "上传", async () => {
        const up = await upload(ports, { filePath: mp3Path, fileName: `${tag}.mp3` });
        if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
          throw new Error(`upload fail: ${up.message || up.code}`);
        }
        return String(up.cdn_url);
      });
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
  };
  // Box egress to Clio/七牛 drops TLS intermittently and Clio is slow on long audio:
  // retry within one wall budget with backoff. Short utterances reuse one wav (#92, #98);
  // free-talk regenerates with tighter pauses after Clio 1006 (#104).
  return async (text, tag, type, opts) => {
    let spoken: SpokenWav | undefined;
    let speechOpts: SpeechOptions = { ...(opts ?? {}) };
    const freeTalk = speechOpts.minSec != null && speechOpts.minSec > 0;
    const timings: StepTimings = new Map();
    const start = now();
    // Free-talk uses its own resolver (default 900s); do not Math.max with the
    // short-utterance cap or a lower UNIPUS_FREE_TALK_TTS_RETRY_MAX_MS is ignored (#105 Codex).
    const budgetMs = freeTalk ? resolveFreeTalkTtsRetryMaxMs(ports.env) : resolveTtsRetryMaxMs(ports.env);
    try {
      const record = await retryWithinBudget(
        async (remainingMs) => {
          try {
            spoken ??= await step(timings, now, "TTS 合成", () => synthesizeLongEnough(text, speechOpts));
            return await scoreAndUpload(timings, spoken, text, tag, type, remainingMs, freeTalk);
          } catch (raw) {
            const err = toError(raw);
            if (freeTalk && spoken && isClioAudioOverflow(err)) {
              const next = nextFreeTalkPauseAfterOverflow(
                spoken.pauseSec,
                spoken.sec,
                sentenceGaps(text),
                speechOpts.minSec!,
              );
              if (next != null) {
                log(
                  `[clio-1006] ${tag} audio overflow（${spoken.sec.toFixed(1)}s wav，句间 ${spoken.pauseSec.toFixed(2)}s）` +
                    `：收紧到 ${next.toFixed(2)}s 重合成（仍 ≥${speechOpts.minSec}s；非网络/freeze）`,
                );
                await spoken.cleanup?.();
                spoken = undefined;
                speechOpts = { ...speechOpts, pauseSec: next, maxPauseSec: next };
              } else {
                // Same wav again just burns ~4 min of Clio per try (#108): hand back for a shorter script.
                log(
                  `[clio-1006] ${tag} audio overflow（${spoken.sec.toFixed(1)}s wav，句间 ${spoken.pauseSec.toFixed(2)}s）` +
                    `：停顿已到下限，交回缩稿（非网络/freeze）`,
                );
                throw new ClioOverflowError(spoken.sec, spoken.pauseSec, err.message);
              }
            }
            throw err;
          }
        },
        {
          label: tag,
          budgetMs,
          baseDelayMs: deps.retryDelayMs ?? 3000,
          isFatal: isFatalSpeechError,
          now,
          sleep: deps.sleep,
          log,
        },
      );
      const parts = [...timings].map(([name, ms]) => `${name} ${seconds(ms)}`).join(" / ");
      log(`${tag} 用时 ${parts}（共 ${seconds(now() - start)}）`);
      return record;
    } finally {
      await spoken?.cleanup?.();
    }
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
