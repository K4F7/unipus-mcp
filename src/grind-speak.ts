/**
 * Headless speak weekly grind: silent TTS → Clio score → upload → scored
 * EN_SENT/EN_PRED children → part/submit (snapshot→submit) per part.
 *
 * App 「U口语 → 历史训练」 only leaves 「评分中」 when part/get has
 * reportStatus=completed + submitted=true. submitAnswer alone fills
 * trainingScoreReport but leaves those fields null → App stays 评分中 (#61).
 *
 * No speakers/afplay; no /oral/train.
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
import { partSubmit } from "./part-submit.js";
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
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
  /** Test seam; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** part/get poll after submit (default 2000ms × 10 ≈ 20s). */
  appReadyPollMs?: number;
  appReadyPollTries?: number;
};

export type GrindSpeakRoundResult =
  | { ok: true; taskId: string }
  | { ok: false; taskId: string | null; detail: string; errorClass?: ErrorClass };

type SpeakPart = {
  partId: string;
  partName: string;
  questionInstanceIds: string[];
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

/** AI对话 / 自由表达: one scripted answer; 自由表达 uses EN_PRED_SCORE. */
async function buildAiOrFree(
  leaf: GrindLeaf,
  speech: SpeechRecordBuilder,
): Promise<string> {
  const type = `${leaf.template} ${leaf.type}`.includes("oral-personal-state")
    ? "EN_PRED_SCORE"
    : "EN_SENT_SCORE";
  const record = await speech(
    DEFAULT_AI_SPEAK_SCRIPT,
    `speak-${leaf.instanceId}-main`,
    type,
  );
  return JSON.stringify({ value: [], children: [voicedChild(record)] });
}

async function buildLeafAnswer(
  leaf: GrindLeaf,
  speech: SpeechRecordBuilder,
): Promise<string> {
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
  const paperToken = String(data.token || "");
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

  const speech = ports.speechRecord ?? createScoredSpeechRecordBuilder(ports);
  const answers = new Map<string, string>();
  try {
    for (const leaf of leaves) {
      answers.set(leaf.instanceId, await buildLeafAnswer(leaf, speech));
    }
  } catch (error) {
    const err = toError(error);
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
    const snap = await partSubmit(ports, {
      action: "snapshot",
      taskId,
      partId: part.partId,
      token: paperToken,
      ansVersion,
      duration: 30,
      userData: userDataSnap,
      cloudHeaders: true,
    });
    if (snap.isError) {
      return {
        ok: false,
        taskId,
        detail: `part/submit snapshot ${part.partName || part.partId}: ${snap.code} ${snap.message}${doneSuffix()}`,
      };
    }
    const sub = await partSubmit(ports, {
      action: "submit",
      taskId,
      partId: part.partId,
      token: paperToken,
      ansVersion,
      duration: 600,
      userData: userDataSnap.map((u) => ({
        ...u,
        context: { state: "done" as const },
      })),
      cloudHeaders: true,
    });
    if (sub.isError) {
      return {
        ok: false,
        taskId,
        detail: `part/submit submit ${part.partName || part.partId}: ${sub.code} ${sub.message}${doneSuffix()}`,
      };
    }
    doneParts.push(part.partName || part.partId);
  }

  const sleep =
    ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Each paper waits ~20s here (default 2000ms × 10) for part/get App readiness.
  const pollMs = ports.appReadyPollMs ?? 2000;
  const tries = Math.max(1, ports.appReadyPollTries ?? 10);
  let readiness: AppReadiness = "not_submitted";
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(pollMs);
    const after = (await adaptiveGet(
      ports,
      `/api/uls/part/get?taskId=${encodeURIComponent(taskId)}&ansVersion=${ansVersion}`,
      jwt,
    )) as Record<string, unknown>;
    readiness = classifyAppReadiness(after?.value ?? after);
    if (readiness === "ready") break;
  }
  if (readiness === "submitted_not_ready") {
    return {
      ok: false,
      taskId,
      detail: `已交但 App 未就绪：part/submit 全部成功，但 part/get 轮询后 reportStatus 仍非 completed（App 仍会显示评分中）${doneSuffix()}`,
    };
  }
  if (readiness === "not_submitted") {
    return {
      ok: false,
      taskId,
      detail: `未交：part/submit 返回成功，但 part/get 仍有 part submitted≠true${doneSuffix()}`,
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
