/**
 * Headless listen weekly grind: getUserStatus → loadPaper → full submitAnswer.
 * No part/submit; no speakers.
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

export type GrindListenPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Optional vocab oral builder; default marks learn-done (no TTS). */
  buildVocabAnswer?: (leaf: GrindLeaf) => Promise<string>;
};

export type GrindListenRoundResult =
  | { ok: true; taskId: string }
  | { ok: false; taskId: string | null; detail: string };

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

async function buildLeafAnswer(
  leaf: GrindLeaf,
  ports: GrindListenPorts,
): Promise<string> {
  const t = leaf.template || leaf.type || leaf.replyType;
  if (
    leaf.isObjective ||
    leaf.replyType === "singlechoice" ||
    t.includes("single-choice") ||
    t.includes("objective")
  ) {
    return buildObjectiveAnswer(leaf);
  }
  if ((t.includes("vocabulary") || leaf.type === "vocabulary") && ports.buildVocabAnswer) {
    return ports.buildVocabAnswer(leaf);
  }
  return buildLearnDoneAnswer();
}

async function requireJwt(ports: GrindListenPorts): Promise<string | null> {
  return ports.credentials.getJwt();
}

/** Complete one listen train paper (loadPaper + full submitAnswer). */
export async function completeOneListen(
  ports: GrindListenPorts,
): Promise<GrindListenRoundResult> {
  const jwt = await requireJwt(ports);
  if (jwt == null || jwt.length === 0) {
    return { ok: false, taskId: null, detail: "no jwt" };
  }

  const statusBody = (await adaptiveGet(
    ports,
    "/api/uls/user/getUserStatus?flowType=listen",
    jwt,
  )) as Record<string, unknown> | null;
  const status =
    statusBody != null && typeof statusBody === "object"
      ? ((statusBody.value as Record<string, unknown> | undefined) ?? null)
      : null;
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
  const answers: string[] = [];
  for (const leaf of leaves) {
    answers.push(await buildLeafAnswer(leaf, ports));
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
  return { ok: true, taskId };
}

export type GrindListenGapsResult = {
  completed: number;
  taskIds: string[];
  stoppedReason?: string;
};

/**
 * Submit listen papers until `need` completions or blocked.
 * Caller decides need from week progress (listen_total - listen_done).
 */
export async function grindListenGaps(
  ports: GrindListenPorts,
  need: number,
  maxRounds = 8,
): Promise<GrindListenGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  const taskIds: string[] = [];
  for (let round = 1; round <= maxRounds && taskIds.length < need; round++) {
    const before = (await (async () => {
      const jwt = await requireJwt(ports);
      if (!jwt) return null;
      const body = (await adaptiveGet(
        ports,
        "/api/uls/user/getUserStatus?flowType=listen",
        jwt,
      )) as Record<string, unknown>;
      return (body?.value as Record<string, unknown> | undefined) ?? null;
    })());
    const beforeTask = before?.taskId != null ? String(before.taskId) : null;
    const beforeStatus = before?.status;

    const result = await completeOneListen(ports);
    if (!result.ok) {
      return {
        completed: taskIds.length,
        taskIds,
        stoppedReason: result.detail,
      };
    }
    taskIds.push(result.taskId);

    const jwt = await requireJwt(ports);
    if (!jwt) break;
    const afterBody = (await adaptiveGet(
      ports,
      "/api/uls/user/getUserStatus?flowType=listen",
      jwt,
    )) as Record<string, unknown>;
    const after = (afterBody?.value as Record<string, unknown> | undefined) ?? null;
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
