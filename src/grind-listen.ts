/**
 * Headless listen weekly grind: getUserStatus → loadPaper → full submitAnswer.
 * No part/submit; no speakers. Objective / gap-fill items are answered from the
 * paper transcript (or video subtitles). A missing answer source, an invalid
 * choice, or an empty blank throws and the paper is not submitted.
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
  fillblankAnswerFromRaw,
  objectiveAnswerFromRaw,
  prepareFillblankSolve,
  prepareObjectiveSolve,
  resolveConfiguredAsk,
  type FetchText,
  type AnswerAsk,
  type SolvedAnswer,
} from "./choice-solver.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";
import {
  AgentAnswerRequiredError,
  agentAnswerWait,
  answerGroupId,
  publishAndWaitAnswers,
  resolveAgentAnswerDir,
  type AgentAnswerAction,
} from "./agent-answers.js";

const DEFAULT_TRAIN_PROFILE_MAX_POLLS = 15;
const DEFAULT_TRAIN_PROFILE_POLL_MS = 500;

export type GrindListenPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Voiced record builder (单词跟读 / 视频配音); default TTS → Clio score → upload. */
  speechRecord?: SpeechRecordBuilder;
  /** Agent answer callback. Default is UNIPUS_AGENT_ANSWER_DIR. null refuses scored text items. */
  answerAsk?: AnswerAsk | null;
  /** Subtitle (WebVTT) fetch for video items; default public fetch. */
  fetchText?: FetchText;
  /** Test seam between getUserStatus polls while waiting out train_profile. */
  sleep?: (ms: number) => Promise<void>;
  /** Max getUserStatus polls waiting for type=train (default 15). */
  trainProfileMaxPolls?: number;
  /** Delay ms between polls (default 500). */
  trainProfilePollMs?: number;
};

export type GrindListenRoundResult =
  | { ok: true; taskId: string; warnings: string[] }
  | { ok: false; taskId: string | null; detail: string; nextAction?: AgentAnswerAction };

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

function resolveAsk(ports: GrindListenPorts): AnswerAsk | null {
  if (ports.answerAsk !== undefined) return ports.answerAsk;
  return resolveConfiguredAsk(ports.env ?? process.env);
}

/** Text leaves share one batch. Voiced / learn leaves stay in this process. */
function listenTextKind(leaf: GrindLeaf): "fillblank" | "objective" | null {
  const t = `${leaf.template} ${leaf.type} ${leaf.replyType}`.toLowerCase();
  if (t.includes("video-dub") || t.includes("follow") || t.includes("oral")) return null;
  if (t.includes("fillblank")) return "fillblank";
  return leaf.isObjective || t.includes("single-choice") || t.includes("singlechoice") || t.includes("objective")
    ? "objective"
    : null;
}

function missingAnswerSource(kind: "fillblank" | "objective"): Error {
  return new Error(kind === "fillblank"
    ? "LOW_SCORE_REFUSED: 未设置 UNIPUS_AGENT_ANSWER_DIR，听力填空拒绝留空交卷"
    : "LOW_SCORE_REFUSED: 未设置 UNIPUS_AGENT_ANSWER_DIR，听力单选拒绝交卷");
}

/** Leaf answer + warning when the solver left questions unanswered. */
async function buildLeafAnswer(
  leaf: GrindLeaf,
  ports: GrindListenPorts,
  ask: AnswerAsk | null,
): Promise<{ answer: string; warning?: string }> {
  const t = `${leaf.template} ${leaf.type} ${leaf.replyType}`.toLowerCase();
  const speech = () => ports.speechRecord ?? createScoredSpeechRecordBuilder(ports);
  const solved = (r: SolvedAnswer) => {
    if (r.unanswered > 0) {
      throw new Error(`LOW_SCORE_REFUSED: ${leaf.name || leaf.instanceId} 有 ${r.unanswered} 题没有有效答案`);
    }
    return { answer: r.answer };
  };
  // Spoken items first: oral-fillblank must be read aloud, not gap-filled.
  if (t.includes("video-dub") || t.includes("follow") || t.includes("oral")) {
    return { answer: await buildVoicedAnswer(leaf, speech()) };
  }
  if (t.includes("fillblank")) {
    if (!ask) throw new Error("LOW_SCORE_REFUSED: 未设置 UNIPUS_AGENT_ANSWER_DIR，听力填空拒绝留空交卷");
    return solved(await buildSolvedFillblankAnswer(leaf.data, ask, ports.fetchText));
  }
  if (leaf.isObjective || t.includes("single-choice") || t.includes("singlechoice") || t.includes("objective")) {
    if (!ask) throw new Error("LOW_SCORE_REFUSED: 未设置 UNIPUS_AGENT_ANSWER_DIR，听力单选拒绝交卷");
    return solved(await buildSolvedObjectiveAnswer(leaf.data, ask, ports.fetchText));
  }
  if (t.includes("vocabulary")) {
    return { answer: await buildVocabAnswer(leaf, speech()) };
  }
  return { answer: buildLearnDoneAnswer(leaf.expectedChildren) };
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
    const byId = new Map<string, { answer: string; warning?: string }>();
    const queued = leaves.filter((leaf) => listenTextKind(leaf) != null);
    if (queued.length > 0) {
      if (ports.answerAsk !== undefined) {
        if (ask == null) throw missingAnswerSource(listenTextKind(queued[0]!)!);
        const built = await Promise.all(queued.map(async (leaf) => {
          const row = await buildLeafAnswer(leaf, ports, ask);
          return [leaf.instanceId, row] as const;
        }));
        for (const [id, row] of built) byId.set(id, row);
      } else {
        const dir = resolveAgentAnswerDir(ports.env ?? process.env);
        if (!dir) throw missingAnswerSource(listenTextKind(queued[0]!)!);
        const prepared = await Promise.all(queued.map(async (leaf) => {
          if (listenTextKind(leaf) === "fillblank") {
            const spec = await prepareFillblankSolve(leaf.data, ports.fetchText);
            return { kind: "fillblank" as const, leaf, ...spec };
          }
          const spec = await prepareObjectiveSolve(leaf.data, ports.fetchText);
          return { kind: "objective" as const, leaf, prompt: spec.prompt, questions: spec.questions };
        }));
        const raws = await publishAndWaitAnswers(
          dir,
          prepared.map((item) => ({
            prompt: item.prompt,
            groupId: answerGroupId(taskId, item.leaf.instanceId),
          })),
          agentAnswerWait(ports.env ?? process.env),
        );
        prepared.forEach((item, index) => {
          const solved = item.kind === "objective"
            ? objectiveAnswerFromRaw(raws[index]!, item.questions)
            : fillblankAnswerFromRaw(raws[index]!, item.blanks);
          if (solved.unanswered > 0) {
            throw new Error(`LOW_SCORE_REFUSED: ${item.leaf.name || item.leaf.instanceId} 有 ${solved.unanswered} 题没有有效答案`);
          }
          byId.set(item.leaf.instanceId, { answer: solved.answer });
        });
      }
    }
    for (const leaf of leaves) {
      const built = byId.get(leaf.instanceId) ?? await buildLeafAnswer(leaf, ports, null);
      answers.push(built.answer);
      if (built.warning) warnings.push(built.warning);
    }
  } catch (error) {
    // Answer / TTS / Clio failure: do not submit a half-built paper.
    return {
      ok: false, taskId, detail: `answer build failed, not submitted: ${toError(error).message}`,
      ...(error instanceof AgentAnswerRequiredError ? { nextAction: error.action } : {}),
    };
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
  return { ok: true, taskId, warnings };
}

export type GrindListenGapsResult = {
  completed: number;
  taskIds: string[];
  stoppedReason?: string;
  /** Non-fatal notes from a completed paper. */
  warnings?: string[];
  nextAction?: AgentAnswerAction;
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
  maxRounds = Math.max(8, need),
): Promise<GrindListenGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  const taskIds: string[] = [];
  const warnings: string[] = [];
  const withWarnings = <T extends object>(r: T) => (warnings.length ? { ...r, warnings } : r);
  for (let round = 1; round <= maxRounds && taskIds.length < need; round++) {
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
      if (!result.ok) {
        return withWarnings({
          completed: taskIds.length,
          taskIds,
          stoppedReason: result.detail,
          nextAction: result.nextAction,
        });
      }
      taskIds.push(result.taskId);
      warnings.push(...result.warnings);

      const jwt = await requireJwt(ports);
      if (!jwt) break;
      // Brief wait so post-submit train_profile can flip before same-task check.
      const afterWait = await waitForListenTrain(ports, jwt);
      const after = afterWait.status;
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
      return withWarnings({
        completed: taskIds.length,
        taskIds,
        stoppedReason: err.message,
        errorClass: classifyError(err),
      });
    }
  }
  return withWarnings({ completed: taskIds.length, taskIds });
}
