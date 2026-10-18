/**
 * Headless listen weekly grind: getUserStatus → loadPaper → full submitAnswer.
 * No part/submit; no speakers. Objective / gap-fill items are answered from the
 * paper transcript (or video subtitles) via an optional LLM (choice-solver.ts);
 * 单词跟读 / 视频配音 get Clio-scored voiced records (scored-speech.ts).
 *
 * After each submitAnswer the server briefly returns type=train_profile (taskId
 * null, flowId/tsId set) while assigning the next paper; getUserStatus flips
 * back to type=train with a new taskId within ~1s. There is no separate
 * enter-train API in captured SPA/docs — we poll, we do not invent paths.
 */
import type { AuthPorts } from "./auth.js";
import { resolveLoadPaperUrl } from "./config.js";
import {
  buildLearnDoneAnswer,
  buildObjectiveAnswer,
  finalizeUserData,
  isOkApiCode,
  walkPaperLeaves,
  type GrindLeaf,
} from "./grind-paper.js";
import { summarizeHttpErrorBody } from "./http.js";
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
import { submitAnswer } from "./submit-answer.js";
import {
  buildVocabAnswer,
  buildVoicedAnswer,
  createScoredSpeechRecordBuilder,
  type SpeechRecordBuilder,
} from "./scored-speech.js";
import {
  buildSolvedFillblankAnswer,
  buildSolvedObjectiveAnswer,
  createLlmAsk,
  resolveChoiceSolverConfig,
  type FetchText,
  type LlmAsk,
  type SolvedAnswer,
} from "./choice-solver.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";
import { findHistoryTrainingTask } from "./history-training-tasks.js";
import { MIN_APP_SCORE, statusFromScore, type PaperReporter } from "./paper-result.js";
import { markProgress } from "./watchdog.js";

const DEFAULT_TRAIN_PROFILE_MAX_POLLS = 15;
const DEFAULT_TRAIN_PROFILE_POLL_MS = 500;

export type GrindListenPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Voiced record builder (单词跟读 / 视频配音); default TTS → Clio score → upload. */
  speechRecord?: SpeechRecordBuilder;
  /** LLM for objective items; default when UNIPUS_LLM_API_KEY/SILICONFLOW_API_KEY set. null = heuristic only. */
  llmAsk?: LlmAsk | null;
  /** Subtitle (WebVTT) fetch for video items; default public fetch. */
  fetchText?: FetchText;
  /** Test seam between getUserStatus polls while waiting out train_profile. */
  sleep?: (ms: number) => Promise<void>;
  /** Max getUserStatus polls waiting for type=train (default 15). */
  trainProfileMaxPolls?: number;
  /** Delay ms between polls (default 500). */
  trainProfilePollMs?: number;
  /** Per-paper JSONL result lines + idempotency ledger (#88); CLI-only. */
  results?: PaperReporter;
  /** App history score polls per paper when `results` is set (default 5 × 3000ms). */
  scorePollTries?: number;
  scorePollMs?: number;
};

export type GrindListenRoundResult =
  | { ok: true; taskId: string; ansVersion: number; warnings: string[] }
  | { ok: false; taskId: string | null; ansVersion?: number; detail: string; skippedExisting?: boolean };

async function adaptiveGet(
  ports: GrindListenPorts,
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
  ports: GrindListenPorts,
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

function resolveAsk(ports: GrindListenPorts): LlmAsk | null {
  if (ports.llmAsk !== undefined) return ports.llmAsk;
  const config = resolveChoiceSolverConfig(ports.env ?? process.env);
  return config ? createLlmAsk(config) : null;
}

/** Leaf answer + warning when the solver left questions unanswered. */
async function buildLeafAnswer(
  leaf: GrindLeaf,
  ports: GrindListenPorts,
  ask: LlmAsk | null,
): Promise<{ answer: string; warning?: string }> {
  const t = `${leaf.template} ${leaf.type} ${leaf.replyType}`.toLowerCase();
  const speech = () => ports.speechRecord ?? createScoredSpeechRecordBuilder(ports);
  const solved = (r: SolvedAnswer, what: string) => ({
    answer: r.answer,
    ...(r.unanswered > 0 ? { warning: `${leaf.name || leaf.instanceId}: ${r.unanswered} 道${what}无有效 LLM 答案` } : {}),
  });
  // Spoken items first: oral-fillblank must be read aloud, not gap-filled.
  if (t.includes("video-dub") || t.includes("follow") || t.includes("oral")) {
    return { answer: await buildVoicedAnswer(leaf, speech()) };
  }
  if (t.includes("fillblank")) {
    return solved(await buildSolvedFillblankAnswer(leaf.data, ask, ports.fetchText), "填空");
  }
  if (leaf.isObjective || t.includes("single-choice") || t.includes("singlechoice") || t.includes("objective")) {
    if (!ask) return { answer: buildObjectiveAnswer(leaf) };
    return solved(await buildSolvedObjectiveAnswer(leaf.data, ask, ports.fetchText), "单选（已用启发式补）");
  }
  if (t.includes("vocabulary")) {
    return { answer: await buildVocabAnswer(leaf, speech()) };
  }
  return { answer: buildLearnDoneAnswer(leaf.expectedChildren) };
}

export const NO_LLM_WARNING =
  "未配置 LLM（UNIPUS_LLM_API_KEY / SILICONFLOW_API_KEY）或 UNIPUS_LLM_SOLVER=off：听力单选走旧启发式、填空留空，分数会明显偏低";

async function requireJwt(ports: GrindListenPorts): Promise<string | null> {
  return ports.credentials.getJwt();
}

function statusValue(body: unknown): Record<string, unknown> | null {
  if (body == null || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).value;
  if (value != null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function isTrainReady(status: Record<string, unknown> | null): boolean {
  return status != null && status.type === "train" && status.taskId != null;
}

/** Compact status for skip reasons — never includes jwt. */
export function formatListenStatusDetail(
  status: Record<string, unknown> | null,
): string {
  if (status == null) return "null";
  const keys = ["type", "taskId", "ansVersion", "status", "flowId", "tsId"] as const;
  const slim: Record<string, unknown> = {};
  for (const k of keys) {
    if (status[k] !== undefined) slim[k] = status[k];
  }
  return JSON.stringify(slim);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll getUserStatus until type=train + taskId, or give a recoverable skip.
 * train_profile is the normal post-submit interstitial; no enter-train API known.
 */
export async function waitForListenTrain(
  ports: GrindListenPorts,
  jwt: string,
  initial?: Record<string, unknown> | null,
): Promise<
  | { ok: true; status: Record<string, unknown> }
  | { ok: false; status: Record<string, unknown> | null; detail: string }
> {
  const maxPolls = ports.trainProfileMaxPolls ?? DEFAULT_TRAIN_PROFILE_MAX_POLLS;
  const pollMs = ports.trainProfilePollMs ?? DEFAULT_TRAIN_PROFILE_POLL_MS;
  const sleep = ports.sleep ?? defaultSleep;

  let status = initial ?? null;
  if (isTrainReady(status)) {
    return { ok: true, status: status! };
  }

  for (let i = 0; i < maxPolls; i++) {
    // Sleep before re-fetch when we already observed a non-train status.
    if (status != null) await sleep(pollMs);
    const body = await adaptiveGet(
      ports,
      "/api/uls/user/getUserStatus?flowType=listen",
      jwt,
    );
    status = statusValue(body);
    if (isTrainReady(status)) {
      return { ok: true, status: status! };
    }
  }

  const type = status?.type;
  if (type === "train_profile") {
    return {
      ok: false,
      status,
      detail:
        `train_profile_pending: next listen task not assigned yet after ${maxPolls} polls ` +
        `(${formatListenStatusDetail(status)}); server flips train_profile→train asynchronously — ` +
        `no separate enter-train API in captured docs/SPA`,
    };
  }
  return {
    ok: false,
    status,
    detail: `not in train: ${formatListenStatusDetail(status)}`,
  };
}

/** Complete one listen train paper (loadPaper + full submitAnswer). */
export async function completeOneListen(
  ports: GrindListenPorts,
): Promise<GrindListenRoundResult> {
  const jwt = await requireJwt(ports);
  if (jwt == null || jwt.length === 0) {
    return { ok: false, taskId: null, detail: "no jwt" };
  }

  const firstBody = (await adaptiveGet(
    ports,
    "/api/uls/user/getUserStatus?flowType=listen",
    jwt,
  )) as unknown;
  const first = statusValue(firstBody);
  const waited = await waitForListenTrain(ports, jwt, first);
  if (!waited.ok) {
    return { ok: false, taskId: null, detail: waited.detail };
  }
  const status = waited.status;
  const taskId = String(status.taskId);
  const ansVersion = Number(status.ansVersion || 1);
  if (ports.results?.isSubmitted("听", taskId, ansVersion)) {
    return {
      ok: false,
      taskId,
      ansVersion,
      skippedExisting: true,
      detail: `状态文件已记录 ${taskId} v${ansVersion} 已交，跳过不重复交`,
    };
  }
  markProgress(`listen:load ${taskId}`);

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
      detail: `loadPaper failed: ${JSON.stringify(loadRes).slice(0, 400)}`,
    };
  }
  const data = (loadRes.value ?? loadRes.data ?? loadRes) as Record<string, unknown>;
  const paperToken = String(data.token || "");
  const paper = extractParsedPaperJson(data);
  if (!paperToken || paper == null) {
    return { ok: false, taskId, detail: "missing token or paperJson" };
  }

  const leaves = walkPaperLeaves(paper);
  const ask = resolveAsk(ports);
  const answers: string[] = [];
  const warnings: string[] = [];
  try {
    for (const leaf of leaves) {
      const built = await buildLeafAnswer(leaf, ports, ask);
      answers.push(built.answer);
      if (built.warning) warnings.push(built.warning);
    }
  } catch (error) {
    // LLM / TTS / Clio failure: do not submit a half-guessed paper.
    return { ok: false, taskId, detail: `answer build failed, not submitted: ${toError(error).message}` };
  }
  const finalized = finalizeUserData(leaves, answers);
  if (!finalized.ok) {
    return { ok: false, taskId, detail: finalized.detail };
  }

  const sub = await submitAnswer(ports, {
    taskId,
    paperToken,
    ansVersion,
    durationSec: 300,
    userData: finalized.userData,
    wrapAudioUrl: false,
  });
  if (sub.isError) {
    return {
      ok: false,
      taskId,
      detail: `submit error: ${sub.code} ${sub.message}`,
    };
  }
  return { ok: true, taskId, ansVersion, warnings };
}

/** Poll App listen history for the paper's score (reporting only; never fails the grind). */
async function listenAppScore(
  ports: GrindListenPorts,
  taskId: string,
): Promise<{ score: number | null; scoreIsOut: boolean | null; error: string | null }> {
  const tries = Math.max(1, ports.scorePollTries ?? 5);
  const sleep = ports.sleep ?? defaultSleep;
  let last = "历史列表未找到该 taskId";
  let score: number | null = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(ports.scorePollMs ?? 3000);
    markProgress(`listen:score-poll ${taskId}`);
    let found: Awaited<ReturnType<typeof findHistoryTrainingTask>>;
    try {
      found = await findHistoryTrainingTask(ports, { taskId, flowType: "listen", pageSize: 20, maxPages: 3 });
    } catch (error) {
      // The paper is already submitted: a history timeout must not turn it into a failed round.
      last = toError(error).message;
      continue;
    }
    if (found.isError) {
      last = found.message;
      continue;
    }
    if (found.task == null) continue;
    score = found.task.score ?? null;
    if (found.task.scoreIsOut === true) return { score, scoreIsOut: true, error: null };
    last = `scoreIsOut=false score=${score ?? 0}`;
  }
  return { score, scoreIsOut: false, error: `已交但 App 未出分：${last}` };
}

async function reportListen(ports: GrindListenPorts, r: GrindListenRoundResult): Promise<void> {
  if (!ports.results) return;
  const base = { skill: "听" as const, taskId: r.taskId, ansVersion: r.ansVersion ?? null };
  if (!r.ok) {
    await ports.results.report({
      ...base, score: null, scoreIsOut: null,
      status: r.skippedExisting ? "skipped_existing" : "failed", error: r.detail,
    });
    return;
  }
  const s = await listenAppScore(ports, r.taskId);
  const status = statusFromScore(s.scoreIsOut, s.score);
  await ports.results.report({
    ...base, score: s.score, scoreIsOut: s.scoreIsOut, status,
    error: s.error ?? (status === "low_score" ? `App 分 ${s.score} < ${MIN_APP_SCORE}` : null),
  });
}

export type GrindListenGapsResult = {
  completed: number;
  taskIds: string[];
  stoppedReason?: string;
  /** Non-fatal: missing LLM config, per-question unanswered counts. */
  warnings?: string[];
  errorClass?: ErrorClass;
};

/**
 * Submit listen papers until `need` completions or blocked.
 * Caller decides need from week progress (listen_total - listen_done).
 * Between papers, completeOneListen polls through train_profile.
 */
export async function grindListenGaps(
  ports: GrindListenPorts,
  need: number,
  // Never cap below the week's need (a 12-paper account stopped at 8).
  maxRounds = Math.max(8, need),
): Promise<GrindListenGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  const taskIds: string[] = [];
  const warnings: string[] = [];
  if (resolveAsk(ports) == null) {
    warnings.push(NO_LLM_WARNING);
    console.error(`[listen] ${NO_LLM_WARNING}`);
  }
  const withWarnings = <T extends object>(r: T) => (warnings.length ? { ...r, warnings } : r);
  for (let round = 1; round <= maxRounds && taskIds.length < need; round++) {
    // A throw in one round (e.g. NETWORK) keeps earlier completions and its errorClass.
    try {
      const before = statusValue(
        await (async () => {
          const jwt = await requireJwt(ports);
          if (!jwt) return null;
          return adaptiveGet(
            ports,
            "/api/uls/user/getUserStatus?flowType=listen",
            jwt,
          );
        })(),
      );
      const beforeTask = before?.taskId != null ? String(before.taskId) : null;
      const beforeStatus = before?.status;

      const result = await completeOneListen(ports);
      await reportListen(ports, result);
      if (!result.ok) {
        return withWarnings({
          completed: taskIds.length,
          taskIds,
          stoppedReason: result.detail,
        });
      }
      taskIds.push(result.taskId);
      warnings.push(...result.warnings);

      const jwt = await requireJwt(ports);
      if (!jwt) break;
      // Brief wait so post-submit train_profile can flip before same-task check.
      const after = (await waitForListenTrain(ports, jwt)).status;
      const afterTask = after?.taskId != null ? String(after.taskId) : null;
      if (
        afterTask &&
        beforeTask &&
        afterTask === beforeTask &&
        after?.status === beforeStatus
      ) {
        return withWarnings({
          completed: taskIds.length,
          taskIds,
          stoppedReason: "same taskId+status after submit",
        });
      }
    } catch (error) {
      const err = toError(error);
      const errorClass = classifyError(err);
      await ports.results?.report({
        skill: "听", taskId: null, ansVersion: null, score: null, scoreIsOut: null,
        status: "failed", error: `${errorClass}: ${err.message}`,
      }).catch(() => {});
      return withWarnings({
        completed: taskIds.length,
        taskIds,
        stoppedReason: `${errorClass}: ${err.message}`,
        errorClass,
      });
    }
  }
  return withWarnings({ completed: taskIds.length, taskIds });
}
