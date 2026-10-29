/**
 * Headless speak weekly grind: silent TTS → Clio score → upload → scored
 * EN_SENT/EN_PRED children → part/submit (snapshot→submit) per part.
 *
 * AI口语对话: ebcp/auth → conversation/create → save → stop → part/submit
 * (answer = bot/cos 话轮 list；缺 openid WebView 头会业务码 500).
 *
 * App 「U口语 → 历史训练」 shows a number iff getHistoryTrainingTasks
 * scoreIsOut===true (false → 「评分中」). trainingScoreReport / answerStatus
 * do NOT count. scoreIsOut=true ↔ report/checkStatus===3 ↔ all parts
 * submitted+completed (incl. AI口语对话). submitAnswer alone leaves App 评分中 (#61).
 *
 * No speakers/afplay; no /oral/train; WS oral.unipus.cn not driven.
 */
import type { NetworkWaiter } from "./net-wait.js";
import type { AuthPorts } from "./auth.js";
import { resolveLoadPaperUrl } from "./config.js";
import {
  buildLearnDoneAnswer,
  finalizeUserData,
  isOkApiCode,
  walkPaperLeaves,
  type GrindLeaf,
} from "./grind-paper.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  checkReportStatus,
  findHistoryTrainingTask,
} from "./history-training-tasks.js";
import { partSubmit, type PartSubmitUserItem } from "./part-submit.js";
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";
import {
  buildVoicedAnswer,
  cachedSpeechRecord,
  createScoredSpeechRecordBuilder,
  voicedChild,
  type SpeechRecordBuilder,
} from "./scored-speech.js";
import {
  isAiDialogPartName,
  runAiDialogFlow,
} from "./ai-dialog-flow.js";
import { openIdFromJwt } from "./uls-business.js";
import {
  resolveEdxJwt,
  softStartStudyDuration,
  speakStudyTarget,
  type StudyDurationWebSocketLike,
} from "./study-duration.js";
import { defaultMaxRounds, ledgerSkipReason, retryOnConcurrent, runPaperLoop, type PaperLoopResult } from "./paper-loop.js";
import { generateFreeTalk, leafTaskText, shortenFreeTalk, wordCount } from "./speak-content.js";
import type { PaperReporter, PaperResult } from "./paper-result.js";
import { activeNow, markProgress, remainingBudgetMs, withDeadline, withWallTimeout } from "./watchdog.js";
import {
  budgetFromTries,
  pollWithin,
  resolveAiReportPoll,
  resolveFreeTalkMinSec,
  resolveFreeTalkTtsSpeed,
  resolvePaperMaxMs,
  resolvePartMaxMs,
  resolveScorePoll,
  type PollBudget,
} from "./limits.js";
import { pollPartReports, type PartScore } from "./part-report.js";
import { ClioOverflowError, SpeechTooShortError } from "./scored-speech.js";
import { AnswerRefusedError, resolveLlmAsk, type LlmAsk } from "./choice-solver.js";

/** App 范例学习 / 自由表达 part/submit go to uadaptive (same-origin WebView). */
function resolveAdaptivePartSubmitUrl(env?: NodeJS.ProcessEnv): string {
  const o = env?.UNIPUS_ULS_ADAPTIVE_ORIGIN?.trim() || "https://uadaptive.unipus.cn";
  return `${o}/api/uls/part/submit`;
}

function resolveUcloudPartSubmitUrl(env?: NodeJS.ProcessEnv): string {
  const o = env?.UNIPUS_ULS_CLOUD_ORIGIN?.trim() || "https://ucloud.unipus.cn";
  return `${o}/api/uls/part/submit`;
}

export type GrindSpeakPorts = AuthPorts & {
  /** Minimum App history score counted as success (default 80). */
  minAppScore?: number;
  env?: NodeJS.ProcessEnv;
  /** LLM for 自由表达 / AI对话; default from UNIPUS_LLM_* (required — no template). */
  llmAsk?: LlmAsk;
  /** Network-outage wait between papers (#102); unset → network failures count as failures. */
  waitNetwork?: NetworkWaiter;
  loadPaperUrl?: string;
  /** Inject voiced record builder; default TTS → Clio score → Qiniu upload. */
  speechRecord?: SpeechRecordBuilder;
  /**
   * Voiced leaf answers keyed by taskId:ansVersion:instanceId, kept across attempts at the same paper so a
   * retry after a submit/network failure does not redo LLM + TTS + Clio + upload (#119). grindSpeakGaps owns one.
   */
  answerCache?: Map<string, { answer: string; meta?: FreeTalkMeta }>;
  /** Voiced records per sentence (tag+type+text), same lifetime as answerCache (#119). */
  speechCache?: Map<string, Record<string, unknown>>;
  /** Test seam; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the paper cap; default activeNow (freezes excluded, #100). */
  clockMs?: () => number;
  /** History scoreIsOut poll after submit; default UNIPUS_SCORE_POLL_MS / UNIPUS_SCORE_MAX_MS. */
  appReadyPollMs?: number;
  appReadyPollTries?: number;
  /** Override getHistoryTrainingTasks URL (tests). */
  historyTrainingTasksUrl?: string;
  /** Override report/checkStatus URL (tests). */
  reportCheckStatusUrl?: string;
  /**
   * When true (default), after scoreIsOut===true also require
   * report/checkStatus===3 before success.
   */
  requireCheckStatusOut?: boolean;
  /** Per-paper JSONL result lines + idempotency ledger (#88); CLI-only. */
  results?: PaperReporter;
  /** Inject unipusio WebSocket for study-duration presence (#121); default real `ws`. */
  createStudyDurationWebSocket?: (url: string) => StudyDurationWebSocketLike;
  /** Prefer accounts/<id>/edx-jwt when resolving study-duration edx JWT (#121). */
  accountId?: string;
};

/** Server part-report per part name; 自由表达 also carries our script words + recording seconds. */
export type SpeakPartScores = Record<string, PartScore & { words?: number; sec?: number }>;

/** Report-only quality flags (App score decides ok / low_score). */
type SpeakReport = { parts?: SpeakPartScores; flags?: string[] };

export type GrindSpeakRoundResult =
  | ({ ok: true; taskId: string; ansVersion?: number; appScore?: number } & SpeakReport)
  | ({
      ok: false;
      taskId: string | null;
      detail: string;
      errorClass?: ErrorClass;
      ansVersion?: number;
      /** Set when every part was submitted — see paper-result.ts. */
      outcome?: "low_score" | "grading";
      /** Ledger + App history say this paper is already submitted (#100). */
      skippedExisting?: boolean;
      appScore?: number;
      scoreIsOut?: boolean;
      /** No LLM answer for a part → that part (and everything not yet submitted) refused. */
      refused?: boolean;
    } & SpeakReport);

type SpeakPart = {
  partId: string;
  partName: string;
  questionInstanceIds: string[];
  /** part/get says already submitted (resume a half-done paper, #70). */
  submitted?: boolean;
};

async function adaptiveGet(
  ports: GrindSpeakPorts,
  path: string,
  jwt: string,
): Promise<unknown> {
  const origin =
    ports.env?.UNIPUS_ULS_ADAPTIVE_ORIGIN?.trim() ||
    "https://uadaptive.unipus.cn";
  const res = await ports.http.request({
    url: `${origin}${path}`,
    method: "GET",
    headers: { authorization: jwt, accept: "application/json" },
  });
  return parseJsonPreservingLargeInts(res.body);
}

async function adaptivePost(
  ports: GrindSpeakPorts,
  path: string,
  jwt: string,
  body: unknown,
): Promise<unknown> {
  const origin =
    ports.env?.UNIPUS_ULS_ADAPTIVE_ORIGIN?.trim() ||
    "https://uadaptive.unipus.cn";
  const res = await ports.http.request({
    url: `${origin}${path}`,
    method: "POST",
    headers: {
      authorization: jwt,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  try {
    return parseJsonPreservingLargeInts(res.body);
  } catch {
    return { raw: summarizeHttpErrorBody(res.body) };
  }
}

function parsePartList(value: unknown): SpeakPart[] {
  const root =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const list = Array.isArray(root.partList) ? root.partList : [];
  const out: SpeakPart[] = [];
  for (const raw of list) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.partId == null) continue;
    const ids = Array.isArray(rec.questionInstanceIds)
      ? rec.questionInstanceIds.map((id) => String(id))
      : [];
    out.push({
      partId: String(rec.partId),
      partName: typeof rec.partName === "string" ? rec.partName : "",
      questionInstanceIds: ids,
      submitted: rec.submitted === true || rec.submitted === 1,
    });
  }
  return out;
}

/** True when every part is App-history ready (not 「评分中」). */
export function partsAppHistoryReady(value: unknown): boolean {
  const parts = parsePartList(value);
  if (parts.length === 0) return false;
  const root = value as Record<string, unknown>;
  const list = Array.isArray(root.partList) ? root.partList : [];
  return list.every((raw) => {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const rec = raw as Record<string, unknown>;
    const submitted = rec.submitted === true || rec.submitted === 1;
    return rec.reportStatus === "completed" && submitted;
  });
}

export type AppReadiness = "ready" | "submitted_not_ready" | "not_submitted";

/**
 * ready: every part completed+submitted (App shows a number).
 * submitted_not_ready: all parts submitted but some reportStatus≠completed (已交但 App 未就绪).
 * not_submitted: at least one part not submitted (未交).
 */
export function classifyAppReadiness(value: unknown): AppReadiness {
  if (partsAppHistoryReady(value)) return "ready";
  const root = (value ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.partList) ? root.partList : [];
  const allSubmitted =
    list.length > 0 &&
    list.every((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return r.submitted === true || r.submitted === 1;
    });
  return allSubmitted ? "submitted_not_ready" : "not_submitted";
}

/** part/submit 业务码 4110「该任务已提交，请重新获取任务」(#84). */
export function isAlreadySubmittedError(message: string | undefined): boolean {
  return /4110|该任务已提交/.test(String(message ?? ""));
}

/**
 * Re-read part/get after 4110: the server may have closed the part itself
 * (e.g. AI口语对话 auto-submitted after the box stalled ~18min mid-dialog, #84).
 */
async function partSubmittedOnServer(
  ports: GrindSpeakPorts,
  jwt: string,
  taskId: string,
  ansVersion: number,
  partId: string,
): Promise<boolean> {
  try {
    return (await readPartSubmitted(ports, jwt, taskId, ansVersion, partId)) === true;
  } catch {
    return false;
  }
}

/** part/get: is this part submitted? null when the check is inconclusive (request failed / part missing). */
async function readPartSubmitted(
  ports: GrindSpeakPorts,
  jwt: string,
  taskId: string,
  ansVersion: number,
  partId: string,
): Promise<boolean | null> {
  const body = (await adaptiveGet(
    ports,
    `/api/uls/part/get?taskId=${encodeURIComponent(taskId)}&ansVersion=${ansVersion}`,
    jwt,
  )) as Record<string, unknown>;
  const part = parsePartList(body?.value ?? body).find((p) => p.partId === partId);
  return part == null ? null : part.submitted === true;
}

/**
 * Before re-sending a part after 4021 (#98): the rejected request stored nothing
 * ("请重新加载试卷"), but another session may have moved on. Re-send only while
 * getUserStatus still shows this exact paper and part/get conclusively
 * shows the part unsubmitted; only then take a fresh loadPaper token (taking one
 * earlier would knock out the other session for nothing).
 */
async function reloadForResubmit(
  ports: GrindSpeakPorts,
  jwt: string,
  loadPath: string,
  taskId: string,
  ansVersion: number,
  partId: string,
): Promise<{ ok: true; partSubmitted: true } | { ok: true; partSubmitted: false; token: string } | { ok: false; detail: string }> {
  try {
    const statusBody = (await adaptiveGet(ports, "/api/uls/user/getUserStatus?flowType=speak", jwt)) as Record<string, unknown>;
    const now = (statusBody?.value as Record<string, unknown> | undefined) ?? null;
    if (now?.type !== "train" || String(now.taskId) !== taskId || Number(now.ansVersion || 1) !== ansVersion) {
      return { ok: false, detail: `当前卷已变为 ${JSON.stringify(now)}（可能已被另一会话交卷）` };
    }
    const submitted = await readPartSubmitted(ports, jwt, taskId, ansVersion, partId);
    if (submitted == null) return { ok: false, detail: "part/get 无法确认该 part 状态，保守不重交" };
    if (submitted) return { ok: true, partSubmitted: true };
    const loadRes = (await adaptivePost(ports, loadPath, jwt, { taskId, ansVersion })) as Record<string, unknown>;
    const data = (loadRes.value ?? loadRes.data ?? loadRes) as Record<string, unknown>;
    const token = isOkApiCode(loadRes.code) ? String(data.token || "") : "";
    if (!token) return { ok: false, detail: `重新 loadPaper 失败：${JSON.stringify(loadRes).slice(0, 200)}` };
    return { ok: true, partSubmitted: false, token };
  } catch (error) {
    return { ok: false, detail: `复核失败，保守不重交：${toError(error).message}` };
  }
}

/** Silence between 自由表达 sentences (s); stretched up to MAX_SENTENCE_PAUSE_SEC when the recording is short. */
const FREE_TALK_PAUSE_SEC = 0.5;
/** Scripts tried when the recording stays under the minimum length. */
const FREE_TALK_ATTEMPTS = 3;
/** Shorter rewrites after Clio 1006 at the pause floor (#108). */
const FREE_TALK_OVERFLOW_REWRITES = 2;
/** Part budget one more LLM + TTS + Clio (≈2.2× audio) + upload round needs (logs: 150–280 s, #108). */
const FREE_TALK_ROUND_MIN_MS = 300_000;

type FreeTalkMeta = { words: number; sec?: number };

/**
 * 自由表达: LLM monologue on the task (EN_PRED_SCORE), voiced slower with sentence pauses and
 * a ≥UNIPUS_FREE_TALK_MIN_SEC gate (#92). On a Clio 1006 the pause cannot fix, the LLM shortens
 * the script (still 210–240 words) and it is re-voiced, while the part budget allows (#108).
 * Anything else here has no answer source → refuse.
 */
async function buildFreeTalk(
  leaf: GrindLeaf,
  speech: SpeechRecordBuilder,
  ask: LlmAsk,
  env: NodeJS.ProcessEnv | undefined,
  meta: Map<string, FreeTalkMeta>,
): Promise<string> {
  if (!`${leaf.template} ${leaf.type}`.includes("oral-personal-state")) {
    throw new AnswerRefusedError(`口语题型 ${leaf.template || leaf.type || "?"}（${leaf.name || leaf.instanceId}）无 LLM 作答路径，拒绝用固定稿交卷`);
  }
  const task = leafTaskText(leaf);
  if (!task) throw new AnswerRefusedError(`自由表达 ${leaf.name || leaf.instanceId} 缺题目文本，拒绝交卷`);
  const minSec = resolveFreeTalkMinSec(env);
  let last = "";
  let next: string | undefined;
  let rewrites = 0;
  for (let i = 0; i < FREE_TALK_ATTEMPTS; ) {
    // #63: free talk must address the task points (server grades appropriateness).
    const text = next ?? (await generateFreeTalk(task, { ask }));
    next = undefined;
    const m: FreeTalkMeta = { words: wordCount(text) };
    try {
      const record = await speech(text, `speak-${leaf.instanceId}-main`, "EN_PRED_SCORE", {
        speed: resolveFreeTalkTtsSpeed(env),
        pauseSec: FREE_TALK_PAUSE_SEC,
        minSec,
        onAudio: (sec) => (m.sec = Math.round(sec * 10) / 10),
      });
      meta.set(leaf.instanceId, m);
      console.error(`[free-talk] ${leaf.instanceId} ${m.words} 词 ${m.sec ?? "?"}s`);
      return JSON.stringify({ value: [], children: [voicedChild(record)] });
    } catch (error) {
      if (error instanceof ClioOverflowError) {
        if (rewrites >= FREE_TALK_OVERFLOW_REWRITES || remainingBudgetMs() < FREE_TALK_ROUND_MIN_MS) throw error;
        rewrites++;
        // Aim just above the floor: scale words by (minSec + 1.5) / overflowing seconds; shortenFreeTalk clamps to 210–240.
        const target = Math.min(m.words - 5, Math.floor((m.words * (minSec + 1.5)) / error.sec));
        console.error(`[free-talk] [clio-1006] ${m.words} 词 ${error.sec.toFixed(1)}s 溢出，第 ${rewrites}/${FREE_TALK_OVERFLOW_REWRITES} 次缩稿到 ≈${Math.max(210, target)} 词`);
        try {
          next = await shortenFreeTalk(task, text, target, { ask });
        } catch (shortenError) {
          // Keep the 1006 (CLIO_CAPACITY soft skip) rather than turning it into a refusal.
          console.error(`[free-talk] [clio-1006] 缩稿失败：${toError(shortenError).message}`);
          throw error;
        }
        continue;
      }
      if (!(error instanceof SpeechTooShortError)) throw error;
      i++;
      last = `${m.words} 词，${error.message}`;
      console.error(`[free-talk] 第 ${i}/${FREE_TALK_ATTEMPTS} 稿录音太短：${last}`);
    }
  }
  throw new AnswerRefusedError(`自由表达录音始终不足 ${minSec}s（${FREE_TALK_ATTEMPTS} 稿），拒绝交卷：${last}`);
}

async function buildLeafAnswer(
  leaf: GrindLeaf,
  speech: SpeechRecordBuilder,
  ask: LlmAsk,
  env: NodeJS.ProcessEnv | undefined,
  meta: Map<string, FreeTalkMeta>,
): Promise<string> {
  const t = `${leaf.template} ${leaf.type} ${leaf.replyType}`.toLowerCase();
  // App 2.8.7: 视频学习 (video-point-read, no children) submits an empty answer.
  if (t.includes("video-point-read")) {
    return JSON.stringify({ value: [], children: [] });
  }
  if (
    t.includes("audio-learn") ||
    t.includes("outline") ||
    t.includes("content-learn")
  ) {
    return buildLearnDoneAnswer();
  }
  if (
    t.includes("oral-sentence") ||
    t.includes("oral-aloud") ||
    t.includes("scoop") ||
    t.includes("basic-oral") ||
    leaf.replyType === "record" ||
    leaf.replyType === "sentence-scoop-record"
  ) {
    const scoop = t.includes("scoop") || t.includes("basic-oral");
    return buildVoicedAnswer(leaf, speech, scoop ? "EN_SENT_REC" : "EN_SENT_SCORE");
  }
  return buildFreeTalk(leaf, speech, ask, env, meta);
}

/** Complete one speak train paper via part/submit (App 历史训练 path). */
export async function completeOneSpeak(
  ports: GrindSpeakPorts,
): Promise<GrindSpeakRoundResult> {
  const jwt = await ports.credentials.getJwt();
  if (jwt == null || jwt.length === 0) {
    return { ok: false, taskId: null, detail: "no jwt" };
  }

  const statusBody = (await adaptiveGet(
    ports,
    "/api/uls/user/getUserStatus?flowType=speak",
    jwt,
  )) as Record<string, unknown>;
  const status =
    (statusBody?.value as Record<string, unknown> | undefined) ?? null;
  if (status == null || status.type !== "train" || status.taskId == null) {
    return {
      ok: false,
      taskId: null,
      detail: `not in train: ${JSON.stringify(status)}`,
    };
  }
  const taskId = String(status.taskId);
  const ansVersion = Number(status.ansVersion || 1);
  if (ports.results?.isSubmitted("说", taskId, ansVersion)) {
    const skip = await ledgerSkipReason(
      () => findHistoryTrainingTask(ports, { taskId, flowType: "speak", pageSize: 20, maxPages: 5 }),
      taskId,
      ansVersion,
    );
    if (skip != null) {
      return { ok: false, taskId, ansVersion, skippedExisting: true, detail: skip };
    }
  }
  markProgress(`speak:load ${taskId}`);
  const clock = ports.clockMs ?? activeNow;
  const paperMaxMs = resolvePaperMaxMs(ports.env);
  const partMaxMs = resolvePartMaxMs(ports.env);
  const paperDeadline = clock() + paperMaxMs;

  const loadUrl = ports.loadPaperUrl ?? resolveLoadPaperUrl(ports.env);
  const loadPath = (() => {
    try {
      return new URL(loadUrl).pathname;
    } catch {
      return "/api/uls/user/loadPaper";
    }
  })();

  const loadRes = (await adaptivePost(ports, loadPath, jwt, {
    taskId,
    ansVersion,
  })) as Record<string, unknown>;
  if (!isOkApiCode(loadRes.code)) {
    return {
      ok: false,
      taskId,
      detail: `loadPaper failed: ${JSON.stringify(loadRes).slice(0, 300)}`,
    };
  }
  const data = (loadRes.value ?? loadRes.data ?? loadRes) as Record<
    string,
    unknown
  >;
  let paperToken = String(data.token || "");
  const paper = extractParsedPaperJson(data);
  if (!paperToken || paper == null) {
    return { ok: false, taskId, detail: "missing token/paper" };
  }

  const partBody = (await adaptiveGet(
    ports,
    `/api/uls/part/get?taskId=${encodeURIComponent(taskId)}&ansVersion=${ansVersion}`,
    jwt,
  )) as Record<string, unknown>;
  const parts = parsePartList(partBody?.value ?? partBody);
  if (parts.length === 0) {
    return { ok: false, taskId, detail: "part/get returned no parts" };
  }

  const leaves = walkPaperLeaves(paper);
  const byId = new Map(leaves.map((l) => [l.instanceId, l]));

  // Paper instance ids must exactly match the union of part questionInstanceIds.
  const partIds = parts.flatMap((p) => p.questionInstanceIds);
  const partSet = new Set(partIds);
  const missingInPaper = partIds.filter((id) => !byId.has(id));
  const missingInParts = leaves
    .map((l) => l.instanceId)
    .filter((id) => !partSet.has(id));
  if (
    missingInPaper.length > 0 ||
    missingInParts.length > 0 ||
    partSet.size !== partIds.length
  ) {
    return {
      ok: false,
      taskId,
      detail:
        `instance id mismatch paper vs part/get: notInPaper=[${missingInPaper.join(",")}] ` +
        `notInParts=[${missingInParts.join(",")}] dupInParts=${partIds.length - partSet.size}`,
    };
  }

  const openId = openIdFromJwt(jwt);
  // Study-time KPI: dual-JWT uls_* speak (else ukouyu hub). Soft-fail — never block 出分 (#121 / #126).
  const presence = await softStartStudyDuration(
    {
      jwt,
      openId,
      edxJwt: await resolveEdxJwt(ports.env ?? process.env, {
        accountId: ports.accountId,
      }),
      accountId: ports.accountId,
      target: speakStudyTarget({
        taskId,
        questionInstanceId: leaves[0]?.instanceId,
        ansVersion,
        env: ports.env,
      }),
      env: ports.env,
    },
    { createWebSocket: ports.createStudyDurationWebSocket },
  );
  try {
  // AI对话 answers come from runAiDialogFlow in the part loop; never pre-voice a script for them.
  // Already-submitted parts are skipped below, so don't spend LLM/TTS on them either.
  const skipIds = new Set(
    parts.filter((p) => p.submitted === true || isAiDialogPartName(p.partName)).flatMap((p) => p.questionInstanceIds),
  );
  const answers = new Map<string, string>();
  const freeTalkMeta = new Map<string, FreeTalkMeta>();
  let ask: LlmAsk;
  try {
    ask = ports.llmAsk ?? resolveLlmAsk(ports.env ?? process.env);
    const built = ports.speechRecord ?? createScoredSpeechRecordBuilder(ports);
    const speech = ports.speechCache ? cachedSpeechRecord(built, ports.speechCache) : built;
    /** One UNIPUS_PART_MAX_MS budget per part, shared by its leaves, never past the paper deadline. */
    const partDeadlines = new Map<SpeakPart | undefined, number>();
    for (const leaf of leaves) {
      if (skipIds.has(leaf.instanceId)) continue;
      const cacheKey = `${taskId}:${ansVersion}:${leaf.instanceId}`;
      const cached = ports.answerCache?.get(cacheKey);
      if (cached) {
        answers.set(leaf.instanceId, cached.answer);
        if (cached.meta) freeTalkMeta.set(leaf.instanceId, cached.meta);
        continue;
      }
      const part = parts.find((p) => p.questionInstanceIds.includes(leaf.instanceId));
      if (!partDeadlines.has(part)) partDeadlines.set(part, Math.min(clock() + partMaxMs, paperDeadline));
      answers.set(
        leaf.instanceId,
        await withWallTimeout(
          // Every step below (LLM, TTS, Clio, upload) is capped by this part's remaining budget (#100).
          withDeadline(partDeadlines.get(part)!, () => buildLeafAnswer(leaf, speech, ask, ports.env, freeTalkMeta)),
          Math.max(1, partDeadlines.get(part)! - clock()),
          `口语答案 ${leaf.name || leaf.instanceId} 单 part / 整卷上限`,
        ),
      );
      ports.answerCache?.set(cacheKey, { answer: answers.get(leaf.instanceId)!, meta: freeTalkMeta.get(leaf.instanceId) });
    }
  } catch (error) {
    const err = toError(error);
    if (err instanceof AnswerRefusedError) {
      return { ok: false, taskId, detail: `答案生成失败，未交任何 part：${err.message}`, refused: true };
    }
    const errorClass = classifyError(err);
    return {
      ok: false,
      taskId,
      detail: `tts/upload ${errorClass}: ${err.message}`,
      errorClass,
    };
  }

  const doneParts: string[] = [];
  const doneSuffix = () =>
    doneParts.length ? ` (已交 part: ${doneParts.join("、")})` : " (未交任何 part)";
  for (const part of parts) {
    // questionInstanceIds already validated against paper leaves above; get is safe.
    const partLeaves = part.questionInstanceIds.map((id) => byId.get(id)!);
    if (partLeaves.length === 0) {
      return { ok: false, taskId, detail: `part ${part.partName || part.partId} 无题目实例${doneSuffix()}` };
    }

    if (part.submitted === true) {
      doneParts.push(`${part.partName || part.partId}(已交,跳过)`);
      continue;
    }
    if (clock() > paperDeadline) {
      return { ok: false, taskId, detail: `整卷超过墙钟上限 ${paperMaxMs}ms（UNIPUS_PAPER_MAX_MS），停在 ${part.partName || part.partId} 之前${doneSuffix()}` };
    }
    markProgress(`speak:part ${part.partName || part.partId}`);
    let isAi = false;
    let aiDuration = 0;
    // AI口语对话: real conversation path before part/submit (placeholder EN_SENT → 4113).
    if (isAiDialogPartName(part.partName)) {
      const qi = part.questionInstanceIds[0];
      if (qi == null) {
        return { ok: false, taskId, detail: `AI part ${part.partId} 无 questionInstanceId${doneSuffix()}` };
      }
      const deadlineAt = clock() + Math.min(partMaxMs, paperDeadline - clock());
      // Same hard cap as the other parts: every LLM / TTS / upload / save step inside sees this budget (#100).
      const flow = await withWallTimeout(
        withDeadline(deadlineAt, () =>
          runAiDialogFlow({ ...ports, llmAsk: ask }, {
            taskId,
            questionId: qi,
            partId: part.partId,
            ansVersion,
            openId,
            taskText: leafTaskText(byId.get(qi)!),
            deadlineAt,
          }),
        ),
        Math.max(1, deadlineAt - clock()),
        `AI对话 ${part.partName} 单 part / 整卷上限`,
      ).catch((error: unknown) => {
        const err = toError(error);
        return { isError: true, code: classifyError(err), message: err.message, answer: null } as const;
      });
      if (flow.isError || flow.answer == null) {
        return {
          ok: false,
          taskId,
          detail: `AI对话 ${part.partName}: ${flow.code} ${flow.message}${doneSuffix()}`,
          refused: flow.code === "ANSWER_REFUSED",
        };
      }
      answers.set(qi, flow.answer);
      aiDuration = flow.duration_sec ?? 60;
      isAi = true;
    }

    const finalized = finalizeUserData(
      partLeaves,
      partLeaves.map((l) => answers.get(l.instanceId)!),
    );
    if (!finalized.ok) {
      return { ok: false, taskId, detail: `${finalized.detail}${doneSuffix()}` };
    }
    const userDataSnap = finalized.userData.map((u) => ({
      instanceId: u.instanceId,
      answer: u.answer,
      answerVersion: u.answerVersion,
      context: { state: "doing" as const },
      contextVersion: 1,
    }));
    const label = part.partName || part.partId;
    const submitPart = (action: "snapshot" | "submit", userData: PartSubmitUserItem[]) =>
      partSubmit(ports, {
        action,
        taskId,
        partId: part.partId,
        token: paperToken,
        ansVersion,
        // App 2.8.7: 范例/自由 duration=0, AI = conversation seconds (ucloud).
        duration: isAi ? aiDuration : 0,
        url: isAi ? resolveUcloudPartSubmitUrl(ports.env) : resolveAdaptivePartSubmitUrl(ports.env),
        userData,
        cloudHeaders: true,
        appIdHeader: !isAi,
        openId,
      });
    /** 4110 + part/get shows the part submitted → the server already closed it (#84). */
    const serverClosed = async (r: { message?: string }) =>
      isAlreadySubmittedError(r.message) && (await partSubmittedOnServer(ports, jwt, taskId, ansVersion, part.partId));
    type PartSend = { isError: false; note: string } | { isError: true; message?: string; detail: string };
    const sendPart = async (): Promise<PartSend> => {
      // D4: the App submits AI口语对话 once (no snapshot, no instStatus).
      if (!isAi) {
        const snap = await submitPart("snapshot", userDataSnap);
        if (snap.isError) {
          if (await serverClosed(snap)) {
            console.error(`[part/submit] ${label} 4110 服务端已交，跳过本 part 续交后续 part`);
            return { isError: false, note: `${label}(服务端已交,跳过)` };
          }
          return { isError: true, message: snap.message, detail: `part/submit snapshot ${label}: ${snap.code} ${snap.message}` };
        }
      }
      const sub = await submitPart(
        "submit",
        // instStatus=1 marks each instance finished; without it 范例学习 stays processing.
        userDataSnap.map((u) => ({ ...u, context: { state: "done" as const }, ...(isAi ? {} : { instStatus: 1 }) })),
      );
      if (sub.isError) {
        if (await serverClosed(sub)) {
          console.error(`[part/submit] ${label} submit 4110 但 part/get 已交，视为已交`);
          return { isError: false, note: `${label}(服务端已交)` };
        }
        return { isError: true, message: sub.message, detail: `part/submit submit ${label}: ${sub.code} ${sub.message}` };
      }
      return { isError: false, note: label };
    };
    let serverHasPart = false;
    const out = await retryOnConcurrent(await sendPart(), {
      env: ports.env,
      sleep: ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
      label: `说 ${taskId} ${label}`,
      reload: async () => {
        const fresh = await reloadForResubmit(ports, jwt, loadPath, taskId, ansVersion, part.partId);
        if (fresh.ok && fresh.partSubmitted) serverHasPart = true;
        else if (fresh.ok) paperToken = fresh.token;
        return fresh;
      },
      // The part landed meanwhile (part/get) → never send it twice.
      resubmit: async (): Promise<PartSend> => (serverHasPart ? { isError: false, note: `${label}(4021 后服务端已交)` } : sendPart()),
    });
    const sent = out.result;
    if (sent.isError) return { ok: false, taskId, detail: `${sent.detail}${out.note}${doneSuffix()}` };
    doneParts.push(sent.note);
  }

  const sleep =
    ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const scoreBudget: PollBudget =
    ports.appReadyPollTries != null
      ? budgetFromTries(ports.appReadyPollTries, ports.appReadyPollMs ?? 3000)
      : resolveScorePoll(ports.env);
  const requireCheck = ports.requireCheckStatusOut !== false;
  // #63: App 显示分 <80 视为失败（UNIPUS_SPEAK_MIN_SCORE 可调，0 关闭）。
  const minAppScore = ports.minAppScore ?? Number(ports.env?.UNIPUS_SPEAK_MIN_SCORE ?? 80);
  const historyPorts = {
    credentials: ports.credentials,
    http: ports.http,
    env: ports.env,
    historyTrainingTasksUrl: ports.historyTrainingTasksUrl,
    reportCheckStatusUrl: ports.reportCheckStatusUrl,
  };
  let lastHint = "历史未查到该 task";
  let lastScore: number | undefined;
  const appScore = await pollWithin(
    scoreBudget,
    async () => {
      markProgress(`speak:score-poll ${taskId}`);
      const found = await findHistoryTrainingTask(historyPorts, {
        taskId,
        flowType: "speak",
        pageSize: 20,
        maxPages: 5,
      });
      if (found.isError) {
        lastHint = found.message;
        return undefined;
      }
      const task = found.task;
      if (task == null) {
        lastHint = "历史列表未找到该 taskId";
        return undefined;
      }
      lastScore = task.score;
      if (task.scoreIsOut !== true) {
        lastHint = `scoreIsOut=false score=${task.score ?? 0}`;
        return undefined;
      }
      if (requireCheck) {
        const cs = await checkReportStatus(historyPorts, {
          taskId,
          ansVersion: task.ansVersion ?? ansVersion,
        });
        if (cs.isError) {
          lastHint = `scoreIsOut=true 但 checkStatus 失败：${cs.message}`;
          return undefined;
        }
        if (cs.check_status !== 3) {
          lastHint = `scoreIsOut=true 但 checkStatus=${cs.check_status}（需 3）`;
          return undefined;
        }
      }
      return task.score ?? 0;
    },
    { sleep },
  );

  const report = await speakPartReport(ports, taskId, ansVersion, parts, freeTalkMeta);
  if (appScore == null) {
    return {
      ok: false,
      taskId,
      ansVersion,
      outcome: "grading",
      appScore: lastScore,
      scoreIsOut: false,
      detail: `已交但 App 评分中：part/submit 全部成功，但 getHistoryTrainingTasks 轮询后 scoreIsOut≠true（${lastHint}）${doneSuffix()}`,
      ...report,
    };
  }
  if (appScore < minAppScore) {
    return {
      ok: false,
      taskId,
      ansVersion,
      outcome: "low_score",
      appScore,
      scoreIsOut: true,
      detail: `App 历史已出分但 score=${appScore} < ${minAppScore}（scoreIsOut=true）${doneSuffix()}`,
      ...report,
    };
  }
  return { ok: true, taskId, ansVersion, appScore, ...report };
  } finally {
    await presence.dispose();
  }
}

/**
 * After submit: the server's own score per part (part-report) + free-talk script stats.
 * ai_report_missing = the AI口语对话 report never generated within UNIPUS_AI_REPORT_MAX_MS.
 */
async function speakPartReport(
  ports: GrindSpeakPorts,
  taskId: string,
  ansVersion: number,
  parts: SpeakPart[],
  freeTalkMeta: Map<string, FreeTalkMeta>,
): Promise<Required<SpeakReport>> {
  const scores: SpeakPartScores = await pollPartReports(
    ports,
    { taskId, ansVersion, parts },
    resolveAiReportPoll(ports.env),
  );
  const flags: string[] = [];
  const minSec = resolveFreeTalkMinSec(ports.env);
  for (const part of parts) {
    const name = part.partName || part.partId;
    const s = scores[name];
    if (s == null) continue;
    const meta = part.questionInstanceIds.map((id) => freeTalkMeta.get(id)).find((m) => m != null);
    if (meta) Object.assign(s, meta);
    if (isAiDialogPartName(part.partName) && s.status !== "ok") flags.push("ai_report_missing");
    if (meta && s.score != null && s.score < 80) flags.push("free_talk_below_80");
    if (meta?.sec != null && meta.sec < minSec) flags.push("free_talk_short");
  }
  return { parts: scores, flags };
}

/** Round result → fixed-shape result line (#88). */
export function speakPaperResult(r: GrindSpeakRoundResult): PaperResult {
  const base = { skill: "说" as const, taskId: r.taskId, ansVersion: r.ansVersion ?? null };
  const report = r.parts ? { parts: r.parts, flags: r.flags ?? [] } : {};
  if (r.ok) return { ...base, score: r.appScore ?? null, scoreIsOut: true, status: "ok", error: null, ...report };
  return {
    ...base,
    score: r.appScore ?? null,
    scoreIsOut: r.scoreIsOut ?? null,
    status: r.skippedExisting ? "skipped_existing" : (r.outcome ?? "failed"),
    error: r.detail,
    ...report,
  };
}

export type GrindSpeakGapsResult = PaperLoopResult & {
  /** App 历史显示分，与 taskIds 对齐 (#63). */
  appScores?: number[];
};

/**
 * Submit speak papers until `need` completions or the account must stop (see runPaperLoop):
 * a failed, timed-out, low-score or still-grading paper is reported and skipped (#98).
 */
export async function grindSpeakGaps(
  ports: GrindSpeakPorts,
  need: number,
  maxRounds = defaultMaxRounds(need, ports.env),
): Promise<GrindSpeakGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  try {
    if (!ports.llmAsk) resolveLlmAsk(ports.env ?? process.env);
  } catch (error) {
    // No LLM config: refuse before loading any paper.
    return { completed: 0, taskIds: [], stoppedReason: toError(error).message, refused: true };
  }
  const appScores: number[] = [];
  const speakPorts = { ...ports, answerCache: ports.answerCache ?? new Map(), speechCache: ports.speechCache ?? new Map() };
  const r = await runPaperLoop({
    skill: "说",
    need,
    maxRounds,
    env: ports.env,
    status: async () => {
      const jwt = await ports.credentials.getJwt();
      if (!jwt) return null;
      const body = (await adaptiveGet(ports, "/api/uls/user/getUserStatus?flowType=speak", jwt)) as Record<string, unknown>;
      return (body?.value as Record<string, unknown> | undefined) ?? null;
    },
    completeOne: () => completeOneSpeak(speakPorts),
    report: async (round) => { await ports.results?.report(speakPaperResult(round)); },
    onSubmitted: (round) => appScores.push(round.appScore ?? 0),
    waitNetwork: ports.waitNetwork,
  });
  return { ...r, appScores };
}
