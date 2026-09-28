/**
 * Optional headless placement (定级) completion before weekly grind.
 * Same loadPaper + full submitAnswer path as train; accepts type=grade.
 * No skip/bypass API — server flips grade→train after successful submit.
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

export type GrindPlacementPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  pollMs?: number;
};

export type PlacementFlow = "listen" | "speak";

export type PlacementRoundResult =
  | { ok: true; flow: PlacementFlow; taskId: string }
  | { ok: false; flow: PlacementFlow; detail: string };

const GRADE_TYPES = new Set(["grade", "grade_profile", "train_plan"]);

async function adaptiveGet(
  ports: GrindPlacementPorts,
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
  ports: GrindPlacementPorts,
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

function statusValue(body: unknown): Record<string, unknown> | null {
  if (body == null || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).value;
  if (value != null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildLeafAnswer(leaf: GrindLeaf): Promise<string> {
  const t = leaf.template || leaf.type || leaf.replyType;
  if (
    leaf.isObjective ||
    leaf.replyType === "singlechoice" ||
    t.includes("single-choice") ||
    t.includes("objective")
  ) {
    return buildObjectiveAnswer(leaf);
  }
  return buildLearnDoneAnswer();
}

/** Complete one grade paper for listen or speak (if currently type=grade + taskId). */
export async function completeOnePlacement(
  ports: GrindPlacementPorts,
  flow: PlacementFlow,
): Promise<PlacementRoundResult> {
  const jwt = await ports.credentials.getJwt();
  if (jwt == null || jwt.length === 0) {
    return { ok: false, flow, detail: "no jwt" };
  }

  const body = await adaptiveGet(
    ports,
    `/api/uls/user/getUserStatus?flowType=${flow}`,
    jwt,
  );
  const status = statusValue(body);
  const type = status?.type != null ? String(status.type) : "";
  if (status == null || !GRADE_TYPES.has(type) || status.taskId == null) {
    if (type === "train" && status?.taskId != null) {
      return {
        ok: true,
        flow,
        taskId: String(status.taskId),
      };
    }
    return {
      ok: false,
      flow,
      detail: `not in grade: ${JSON.stringify({
        type: status?.type ?? null,
        taskId: status?.taskId ?? null,
        status: status?.status ?? null,
      })}`,
    };
  }

  // grade_profile / train_plan: wait for train (or re-enter grade with task)
  if (type !== "grade") {
    const waited = await waitUntilTrainOrGrade(ports, jwt, flow);
    if (waited.ok && waited.kind === "train") {
      return { ok: true, flow, taskId: waited.taskId };
    }
    if (!waited.ok || waited.kind !== "grade") {
      return {
        ok: false,
        flow,
        detail: waited.ok
          ? `stuck after ${type}`
          : waited.detail,
      };
    }
    // fall through with fresh grade status
    return completeGradeSubmit(ports, jwt, flow, waited.status);
  }

  return completeGradeSubmit(ports, jwt, flow, status);
}

async function completeGradeSubmit(
  ports: GrindPlacementPorts,
  jwt: string,
  flow: PlacementFlow,
  status: Record<string, unknown>,
): Promise<PlacementRoundResult> {
  const taskId = String(status.taskId);
  const ansVersion = Number(status.ansVersion || 1);

  const loadUrl = ports.loadPaperUrl ?? resolveLoadPaperUrl(ports.env);
  let loadPath = "/api/uls/user/loadPaper";
  try {
    loadPath = new URL(loadUrl).pathname;
  } catch {
    /* default */
  }

  const loadRes = (await adaptivePost(ports, loadPath, jwt, {
    taskId,
    ansVersion,
  })) as Record<string, unknown>;
  if (!isOkApiCode(loadRes.code)) {
    return {
      ok: false,
      flow,
      detail: `loadPaper failed: ${JSON.stringify(loadRes).slice(0, 400)}`,
    };
  }
  const data = (loadRes.value ?? loadRes.data ?? loadRes) as Record<string, unknown>;
  const paperToken = String(data.token || "");
  const paper = extractParsedPaperJson(data);
  if (!paperToken || paper == null) {
    return { ok: false, flow, detail: "missing token or paperJson" };
  }

  const leaves = walkPaperLeaves(paper);
  const answers: string[] = [];
  for (const leaf of leaves) {
    answers.push(await buildLeafAnswer(leaf));
  }
  const finalized = finalizeUserData(leaves, answers);
  if (!finalized.ok) {
    return { ok: false, flow, detail: finalized.detail };
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
      flow,
      detail: `submit error: ${sub.code} ${sub.message}`,
    };
  }

  const waited = await waitUntilTrainOrGrade(ports, jwt, flow);
  if (waited.ok && waited.kind === "train") {
    return { ok: true, flow, taskId };
  }
  // grade_profile after submit is success enough; weekly needs train
  if (waited.ok && waited.kind === "grade_profile") {
    const again = await waitUntilTrainOrGrade(ports, jwt, flow);
    if (again.ok && again.kind === "train") {
      return { ok: true, flow, taskId };
    }
  }
  return {
    ok: true,
    flow,
    taskId,
  };
}

async function waitUntilTrainOrGrade(
  ports: GrindPlacementPorts,
  jwt: string,
  flow: PlacementFlow,
): Promise<
  | { ok: true; kind: "train"; taskId: string; status: Record<string, unknown> }
  | { ok: true; kind: "grade"; status: Record<string, unknown> }
  | { ok: true; kind: "grade_profile"; status: Record<string, unknown> }
  | { ok: false; detail: string }
> {
  const maxPolls = ports.maxPolls ?? 20;
  const pollMs = ports.pollMs ?? 500;
  const sleep = ports.sleep ?? defaultSleep;
  let status: Record<string, unknown> | null = null;
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await sleep(pollMs);
    const body = await adaptiveGet(
      ports,
      `/api/uls/user/getUserStatus?flowType=${flow}`,
      jwt,
    );
    status = statusValue(body);
    const type = status?.type != null ? String(status.type) : "";
    if (type === "train" && status?.taskId != null) {
      return { ok: true, kind: "train", taskId: String(status.taskId), status };
    }
    if (type === "grade" && status?.taskId != null) {
      return { ok: true, kind: "grade", status };
    }
    if (type === "grade_profile" || type === "train_plan") {
      // keep polling toward train
      if (i === maxPolls - 1) {
        return { ok: true, kind: "grade_profile", status: status! };
      }
    }
  }
  return {
    ok: false,
    detail: `placement wait timeout: ${JSON.stringify({
      type: status?.type ?? null,
      taskId: status?.taskId ?? null,
    })}`,
  };
}

export type AutoPlacementResult = {
  attempted: boolean;
  listen?: PlacementRoundResult;
  speak?: PlacementRoundResult;
};

/**
 * If listen/speak still in grade, attempt one headless placement paper each.
 * Does not invent skip APIs. Caller re-checks week progress afterward.
 */
export async function runAutoPlacement(
  ports: GrindPlacementPorts,
): Promise<AutoPlacementResult> {
  const jwt = await ports.credentials.getJwt();
  if (jwt == null || jwt.length === 0) {
    return {
      attempted: false,
      listen: { ok: false, flow: "listen", detail: "no jwt" },
    };
  }

  const out: AutoPlacementResult = { attempted: false };

  for (const flow of ["listen", "speak"] as const) {
    const body = await adaptiveGet(
      ports,
      `/api/uls/user/getUserStatus?flowType=${flow}`,
      jwt,
    );
    const status = statusValue(body);
    const type = status?.type != null ? String(status.type) : "";
    if (!GRADE_TYPES.has(type)) continue;
    out.attempted = true;
    const result = await completeOnePlacement(ports, flow);
    if (flow === "listen") out.listen = result;
    else out.speak = result;
  }

  return out;
}
