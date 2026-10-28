/**
 * Headless listen weekly grind: getUserStatus → loadPaper → full submitAnswer.
 * No part/submit; no speakers. Objective / gap-fill items are answered from the
 * paper transcript (or video subtitles) via the LLM (choice-solver.ts) only —
 * no LLM config / no valid answer → paper refused, nothing submitted;
 * 单词跟读 / 视频配音 get Clio-scored voiced records (scored-speech.ts).
 *
 * After each submitAnswer the server briefly returns type=train_profile (taskId
 * null, flowId/tsId set) while assigning the next paper; getUserStatus flips
 * back to type=train with a new taskId within ~1s. There is no separate
 * enter-train API in captured SPA/docs — we poll, we do not invent paths.
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
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
import { submitAnswer } from "./submit-answer.js";
import { defaultMaxRounds, ledgerSkipReason, retryOnConcurrent, runPaperLoop, type PaperLoopResult } from "./paper-loop.js";
import {
  buildVocabAnswer,
  buildVoicedAnswer,
  createScoredSpeechRecordBuilder,
  type SpeechRecordBuilder,
} from "./scored-speech.js";
import {
  AnswerRefusedError,
  buildSolvedFillblankAnswer,
  buildSolvedObjectiveAnswer,
  resolveLlmAsk,
  type FetchText,
  type LlmAsk,
} from "./choice-solver.js";
import { toError, type ErrorClass } from "./retry.js";
import { findHistoryTrainingTask } from "./history-training-tasks.js";
import { MIN_APP_SCORE, statusFromScore, type PaperReporter } from "./paper-result.js";
import { markProgress } from "./watchdog.js";
import { budgetFromTries, pollWithin, resolveScorePoll } from "./limits.js";
import {
  listenStudyTarget,
  softStartStudyDuration,
  type StudyDurationWebSocketLike,
} from "./study-duration.js";

const DEFAULT_TRAIN_PROFILE_MAX_POLLS = 15;
const DEFAULT_TRAIN_PROFILE_POLL_MS = 500;

export type GrindListenPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Voiced record builder (单词跟读 / 视频配音); default TTS → Clio score → upload. */
  speechRecord?: SpeechRecordBuilder;
  /** LLM for objective / gap-fill items; default from UNIPUS_LLM_BASE_URL/MODEL/API_KEY (required). */
  llmAsk?: LlmAsk;
  /** Network-outage wait between papers (#102); unset → network failures count as failures. */
  waitNetwork?: NetworkWaiter;
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
  /** App history score polls per paper when `results` is set (default UNIPUS_SCORE_POLL_MS / UNIPUS_SCORE_MAX_MS). */
  scorePollTries?: number;
  scorePollMs?: number;
  /** Inject unipusio WebSocket for study-duration presence (#121); default real `ws`. */
  createStudyDurationWebSocket?: (url: string) => StudyDurationWebSocketLike;
  /** When false, skip study-duration presence (unit tests). Default true. */
  studyDuration?: boolean;
};

export type GrindListenRoundResult =
  | { ok: true; taskId: string; ansVersion: number }
  | {
      ok: false;
      taskId: string | null;
      ansVersion?: number;
      detail: string;
      skippedExisting?: boolean;
      /** No LLM answer → not submitted. */
      refused?: boolean;
      errorClass?: ErrorClass;
    };

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

function resolveAsk(ports: GrindListenPorts): LlmAsk {
  return ports.llmAsk ?? resolveLlmAsk(ports.env ?? process.env);
}

async function buildLeafAnswer(leaf: GrindLeaf, ports: GrindListenPorts, ask: LlmAsk): Promise<string> {
  const t = `${leaf.template} ${leaf.type} ${leaf.replyType}`.toLowerCase();
  const speech = () => ports.speechRecord ?? createScoredSpeechRecordBuilder(ports);
  // Spoken items first: oral-fillblank must be read aloud, not gap-filled.
  if (t.includes("video-dub") || t.includes("follow") || t.includes("oral")) {
    return buildVoicedAnswer(leaf, speech());
  }
  if (t.includes("fillblank")) {
    return buildSolvedFillblankAnswer(leaf.data, ask, ports.fetchText);
  }
  if (leaf.isObjective || t.includes("single-choice") || t.includes("singlechoice") || t.includes("objective")) {
    return buildSolvedObjectiveAnswer(leaf.data, ask, ports.fetchText);
  }
  if (t.includes("vocabulary")) {
    return buildVocabAnswer(leaf, speech());
  }
  return buildLearnDoneAnswer(leaf.expectedChildren);
}

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
    const skip = await ledgerSkipReason(
      () => findHistoryTrainingTask(ports, { taskId, flowType: "listen", pageSize: 20, maxPages: 5 }),
      taskId,
      ansVersion,
    );
    if (skip != null) return { ok: false, taskId, ansVersion, skippedExisting: true, detail: skip };
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

  const loaded = await loadListenPaper(ports, jwt, loadPath, taskId, ansVersion);
  if (!loaded.ok) return { ok: false, taskId, detail: loaded.detail };
  const { paper } = loaded;

  const leaves = walkPaperLeaves(paper);
  // Study-time KPI: unipusio kick-v2 for uls_<qiId> (else utingli hub). Soft-fail — never block 出分 (#121).
  const presence = await softStartStudyDuration(
    {
      jwt,
      target: listenStudyTarget({
        taskId,
        questionInstanceId: leaves[0]?.instanceId,
        ansVersion,
        env: ports.env,
      }),
      env: ports.env,
      enabled: ports.studyDuration,
    },
    { createWebSocket: ports.createStudyDurationWebSocket },
  );
  try {
    const answers: string[] = [];
    try {
      const ask = resolveAsk(ports);
      for (const leaf of leaves) {
        answers.push(await buildLeafAnswer(leaf, ports, ask));
      }
    } catch (error) {
      // LLM / TTS / Clio failure: do not submit a half-guessed paper.
      return {
        ok: false,
        taskId,
        ansVersion,
        detail: `answer build failed, not submitted: ${toError(error).message}`,
        refused: error instanceof AnswerRefusedError,
      };
    }
    const finalized = finalizeUserData(leaves, answers);
    if (!finalized.ok) {
      return { ok: false, taskId, detail: finalized.detail };
    }

    let paperToken = loaded.token;
    const submit = () => submitAnswer(ports, {
      taskId,
      paperToken,
      ansVersion,
      durationSec: 300,
      userData: finalized.userData,
      wrapAudioUrl: false,
    });
    const out = await retryOnConcurrent(await submit(), {
      env: ports.env,
      sleep: ports.sleep ?? defaultSleep,
      label: `听 ${taskId}`,
      reload: async () => {
        const fresh = await reloadForResubmit(ports, jwt, loadPath, taskId, ansVersion, leaves);
        if (fresh.ok) paperToken = fresh.token;
        return fresh;
      },
      resubmit: submit,
    });
    const sub = out.result;
    if (sub.isError) {
      return { ok: false, taskId, ansVersion, detail: `submit error: ${sub.code} ${sub.message}${out.note}` };
    }
    return { ok: true, taskId, ansVersion };
  } finally {
    await presence.dispose();
  }
}

async function loadListenPaper(
  ports: GrindListenPorts,
  jwt: string,
  loadPath: string,
  taskId: string,
  ansVersion: number,
): Promise<{ ok: true; token: string; paper: unknown } | { ok: false; detail: string }> {
  const loadRes = (await adaptivePost(ports, loadPath, jwt, { taskId, ansVersion })) as Record<string, unknown>;
  if (!isOkApiCode(loadRes.code)) {
    return { ok: false, detail: `loadPaper failed: ${JSON.stringify(loadRes).slice(0, 400)}` };
  }
  const data = (loadRes.value ?? loadRes.data ?? loadRes) as Record<string, unknown>;
  const token = String(data.token || "");
  const paper = extractParsedPaperJson(data);
  if (!token || paper == null) return { ok: false, detail: "missing token or paperJson" };
  return { ok: true, token, paper };
}

/**
 * Before resubmitting after 4021 (#98): the 4021 submit was rejected ("请重新加载试卷"),
 * so it stored nothing — but another session may have submitted meanwhile. Resubmit
 * only when getUserStatus and App history both still show this exact paper
 * unsubmitted, then take a fresh token (same questions → same answers). The server
 * decides, not the ledger: a stale ledger row was already overruled (#100).
 */
async function reloadForResubmit(
  ports: GrindListenPorts,
  jwt: string,
  loadPath: string,
  taskId: string,
  ansVersion: number,
  leaves: GrindLeaf[],
): Promise<{ ok: true; token: string } | { ok: false; detail: string }> {
  try {
    const now = statusValue(await adaptiveGet(ports, "/api/uls/user/getUserStatus?flowType=listen", jwt));
    if (!isTrainReady(now) || String(now!.taskId) !== taskId || Number(now!.ansVersion || 1) !== ansVersion) {
      return { ok: false, detail: `当前卷已变为 ${formatListenStatusDetail(now)}（可能已被另一会话交卷）` };
    }
    const hist = await findHistoryTrainingTask(ports, { taskId, flowType: "listen", pageSize: 20, maxPages: 3 });
    if (hist.isError) return { ok: false, detail: `历史查询失败，保守不重交：${hist.message}` };
    if (hist.task != null && (hist.task.ansVersion == null || hist.task.ansVersion === ansVersion)) {
      return { ok: false, detail: `历史已有 ${taskId} v${hist.task.ansVersion ?? "?"}（已被交过）` };
    }
    const loaded = await loadListenPaper(ports, jwt, loadPath, taskId, ansVersion);
    if (!loaded.ok) return loaded;
    const ids = (ls: GrindLeaf[]) => ls.map((l) => l.instanceId).join(",");
    if (ids(walkPaperLeaves(loaded.paper)) !== ids(leaves)) {
      return { ok: false, detail: "重新加载的试卷题目与已作答的不一致" };
    }
    return { ok: true, token: loaded.token };
  } catch (error) {
    return { ok: false, detail: `复核失败，保守不重交：${toError(error).message}` };
  }
}

/**
 * Poll App listen history for the paper's score (reporting only; never fails the grind).
 * Budget: UNIPUS_SCORE_POLL_MS / UNIPUS_SCORE_MAX_MS (#92); ports.scorePollTries overrides (tests).
 */
async function listenAppScore(
  ports: GrindListenPorts,
  taskId: string,
): Promise<{ score: number | null; scoreIsOut: boolean | null; error: string | null }> {
  const budget = ports.scorePollTries != null
    ? budgetFromTries(ports.scorePollTries, ports.scorePollMs ?? 3000)
    : resolveScorePoll(ports.env);
  let last = "历史列表未找到该 taskId";
  let score: number | null = null;
  const out = await pollWithin(
    budget,
    async () => {
      markProgress(`listen:score-poll ${taskId}`);
      let found: Awaited<ReturnType<typeof findHistoryTrainingTask>>;
      try {
        found = await findHistoryTrainingTask(ports, { taskId, flowType: "listen", pageSize: 20, maxPages: 3 });
      } catch (error) {
        // The paper is already submitted: a history timeout must not turn it into a failed round.
        last = toError(error).message;
        return undefined;
      }
      if (found.isError) {
        last = found.message;
        return undefined;
      }
      if (found.task == null) return undefined;
      score = found.task.score ?? null;
      if (found.task.scoreIsOut === true) return { score, scoreIsOut: true, error: null };
      last = `scoreIsOut=false score=${score ?? 0}`;
      return undefined;
    },
    { sleep: ports.sleep ?? defaultSleep },
  );
  return out ?? { score, scoreIsOut: false, error: `已交但 App 未出分：${last}` };
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

export type GrindListenGapsResult = PaperLoopResult;

/**
 * Submit listen papers until `need` completions or the account must stop (see runPaperLoop).
 * Caller decides need from week progress (listen_total - listen_done).
 */
export async function grindListenGaps(
  ports: GrindListenPorts,
  need: number,
  maxRounds = defaultMaxRounds(need, ports.env),
): Promise<GrindListenGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  try {
    resolveAsk(ports);
  } catch (error) {
    // No LLM config: refuse before loading any paper.
    return { completed: 0, taskIds: [], stoppedReason: toError(error).message, refused: true };
  }
  const status = async () => {
    const jwt = await requireJwt(ports);
    return jwt ? statusValue(await adaptiveGet(ports, "/api/uls/user/getUserStatus?flowType=listen", jwt)) : null;
  };
  return runPaperLoop({
    skill: "听",
    need,
    maxRounds,
    env: ports.env,
    status,
    // Brief wait so post-submit train_profile can flip before the same-task check.
    statusAfter: async () => {
      const jwt = await requireJwt(ports);
      return jwt ? (await waitForListenTrain(ports, jwt)).status : null;
    },
    completeOne: () => completeOneListen(ports),
    report: (r) => reportListen(ports, r),
    waitNetwork: ports.waitNetwork,
  });
}
