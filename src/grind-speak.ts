/**
 * Headless speak weekly grind: silent TTS → Clio score → upload → scored EN_SENT/EN_PRED children → submitAnswer.
 * No speakers/afplay; no /oral/train; no part/submit.
 */
import type { AuthPorts } from "./auth.js";
import { resolveLoadPaperUrl } from "./config.js";
import {
  DEFAULT_AI_SPEAK_SCRIPT,
  buildLearnDoneAnswer,
  finalizeUserData,
  isOkApiCode,
  walkPaperLeaves,
  type GrindLeaf,
} from "./grind-paper.js";
import { summarizeHttpErrorBody } from "./http.js";
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
import { submitAnswer } from "./submit-answer.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";
import {
  buildVoicedAnswer,
  createScoredSpeechRecordBuilder,
  voicedChild,
  type SpeechRecordBuilder,
} from "./scored-speech.js";

export type GrindSpeakPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Inject voiced record builder; default TTS → Clio score → Qiniu upload. */
  speechRecord?: SpeechRecordBuilder;
};

export type GrindSpeakRoundResult =
  | { ok: true; taskId: string }
  | { ok: false; taskId: string | null; detail: string; errorClass?: ErrorClass };

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

/** AI对话 / 自由表达: one scripted answer; 自由表达 uses EN_PRED_SCORE (docs/api-notes.md). */
async function buildAiOrFree(leaf: GrindLeaf, speech: SpeechRecordBuilder): Promise<string> {
  const type = `${leaf.template} ${leaf.type}`.includes("oral-personal-state")
    ? "EN_PRED_SCORE"
    : "EN_SENT_SCORE";
  const record = await speech(DEFAULT_AI_SPEAK_SCRIPT, `speak-${leaf.instanceId}-main`, type);
  return JSON.stringify({ value: [], children: [voicedChild(record)] });
}

async function buildLeafAnswer(leaf: GrindLeaf, speech: SpeechRecordBuilder): Promise<string> {
  const t = `${leaf.template} ${leaf.type} ${leaf.replyType}`.toLowerCase();
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
    return buildVoicedAnswer(leaf, speech);
  }
  return buildAiOrFree(leaf, speech);
}

/** Complete one speak train paper. */
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
  const data = (loadRes.value ?? loadRes.data ?? loadRes) as Record<string, unknown>;
  const paperToken = String(data.token || "");
  const paper = extractParsedPaperJson(data);
  if (!paperToken || paper == null) {
    return { ok: false, taskId, detail: "missing token/paper" };
  }

  const speech = ports.speechRecord ?? createScoredSpeechRecordBuilder(ports);

  const leaves = walkPaperLeaves(paper);
  const answers: string[] = [];
  try {
    for (const leaf of leaves) {
      answers.push(await buildLeafAnswer(leaf, speech));
    }
  } catch (error) {
    const err = toError(error);
    const errorClass = classifyError(err);
    return { ok: false, taskId, detail: `tts/upload ${errorClass}: ${err.message}`, errorClass };
  }
  const finalized = finalizeUserData(leaves, answers);
  if (!finalized.ok) {
    return { ok: false, taskId, detail: finalized.detail };
  }

  const sub = await submitAnswer(ports, {
    taskId,
    paperToken,
    ansVersion,
    durationSec: 600,
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
  return { ok: true, taskId };
}

export type GrindSpeakGapsResult = {
  completed: number;
  taskIds: string[];
  stoppedReason?: string;
  errorClass?: ErrorClass;
};

export async function grindSpeakGaps(
  ports: GrindSpeakPorts,
  need: number,
  maxRounds = 5,
): Promise<GrindSpeakGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  const taskIds: string[] = [];
  try {
    return await grindSpeakLoop(ports, need, maxRounds, taskIds);
  } catch (error) {
    // Keep already-submitted tasks in the count even if a later call throws.
    const err = toError(error);
    const errorClass = classifyError(err);
    return {
      completed: taskIds.length,
      taskIds,
      stoppedReason: `${errorClass}: ${err.message}`,
      errorClass,
    };
  }
}

async function grindSpeakLoop(
  ports: GrindSpeakPorts,
  need: number,
  maxRounds: number,
  taskIds: string[],
): Promise<GrindSpeakGapsResult> {
  for (let round = 1; round <= maxRounds && taskIds.length < need; round++) {
    const jwt = await ports.credentials.getJwt();
    if (!jwt) {
      return { completed: taskIds.length, taskIds, stoppedReason: "no jwt" };
    }
    const beforeBody = (await adaptiveGet(
      ports,
      "/api/uls/user/getUserStatus?flowType=speak",
      jwt,
    )) as Record<string, unknown>;
    const before =
      (beforeBody?.value as Record<string, unknown> | undefined) ?? null;
    const beforeTask = before?.taskId != null ? String(before.taskId) : null;
    const beforeStatus = before?.status;

    const result = await completeOneSpeak(ports);
    if (!result.ok) {
      return {
        completed: taskIds.length,
        taskIds,
        stoppedReason: result.detail,
        errorClass: result.errorClass,
      };
    }
    taskIds.push(result.taskId);

    const afterBody = (await adaptiveGet(
      ports,
      "/api/uls/user/getUserStatus?flowType=speak",
      jwt,
    )) as Record<string, unknown>;
    const after =
      (afterBody?.value as Record<string, unknown> | undefined) ?? null;
    const afterTask = after?.taskId != null ? String(after.taskId) : null;
    if (
      afterTask &&
      beforeTask &&
      afterTask === beforeTask &&
      after?.status === beforeStatus
    ) {
      return {
        completed: taskIds.length,
        taskIds,
        stoppedReason: "same taskId+status after submit",
      };
    }
  }
  return { completed: taskIds.length, taskIds };
}
