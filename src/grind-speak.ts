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
import {
  checkReportStatus,
  findHistoryTrainingTask,
} from "./history-training-tasks.js";
import { partSubmit } from "./part-submit.js";
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";
import {
  buildVoicedAnswer,
  createScoredSpeechRecordBuilder,
  voicedChild,
  type SpeechRecordBuilder,
} from "./scored-speech.js";
import {
  isAiDialogPartName,
  runAiDialogFlow,
} from "./ai-dialog-flow.js";
import { openIdFromJwt } from "./uls-business.js";

export type GrindSpeakPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Inject voiced record builder; default TTS → Clio score → Qiniu upload. */
  speechRecord?: SpeechRecordBuilder;
  /** Test seam; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** History scoreIsOut poll after submit (default 2000ms × 10 ≈ 20s). */
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
  const openId = openIdFromJwt(jwt);
  for (const part of parts) {
    // questionInstanceIds already validated against paper leaves above; get is safe.
    const partLeaves = part.questionInstanceIds.map((id) => byId.get(id)!);
    if (partLeaves.length === 0) {
      return { ok: false, taskId, detail: `part ${part.partName || part.partId} 无题目实例${doneSuffix()}` };
    }

    // AI口语对话: real conversation path before part/submit (placeholder EN_SENT → 4113).
    if (isAiDialogPartName(part.partName)) {
      const qi = part.questionInstanceIds[0];
      if (qi == null) {
        return { ok: false, taskId, detail: `AI part ${part.partId} 无 questionInstanceId${doneSuffix()}` };
      }
      const flow = await runAiDialogFlow(ports, {
        taskId,
        questionId: qi,
        partId: part.partId,
        ansVersion,
        openId,
      });
      if (flow.isError || flow.answer == null) {
        return {
          ok: false,
          taskId,
          detail: `AI对话 ${part.partName}: ${flow.code} ${flow.message}${doneSuffix()}`,
        };
      }
      answers.set(qi, flow.answer);
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
      openId,
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
      openId,
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
  // Each paper waits ~20s here (default 2000ms × 10) for App history scoreIsOut.
  const pollMs = ports.appReadyPollMs ?? 2000;
  const tries = Math.max(1, ports.appReadyPollTries ?? 10);
  const requireCheck = ports.requireCheckStatusOut !== false;
  const historyPorts = {
    credentials: ports.credentials,
    http: ports.http,
    env: ports.env,
    historyTrainingTasksUrl: ports.historyTrainingTasksUrl,
    reportCheckStatusUrl: ports.reportCheckStatusUrl,
  };
  let lastHint = "历史未查到该 task";
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(pollMs);
    const found = await findHistoryTrainingTask(historyPorts, {
      taskId,
      flowType: "speak",
      pageSize: 20,
      maxPages: 5,
    });
    if (found.isError) {
      lastHint = found.message;
      continue;
    }
    const task = found.task;
    if (task == null) {
      lastHint = "历史列表未找到该 taskId";
      continue;
    }
    if (task.scoreIsOut !== true) {
      lastHint = `scoreIsOut=false score=${task.score ?? 0}`;
      continue;
    }
    if (requireCheck) {
      const cs = await checkReportStatus(historyPorts, {
        taskId,
        ansVersion: task.ansVersion ?? ansVersion,
      });
      if (cs.isError) {
        lastHint = `scoreIsOut=true 但 checkStatus 失败：${cs.message}`;
        continue;
      }
      if (cs.check_status !== 3) {
        lastHint = `scoreIsOut=true 但 checkStatus=${cs.check_status}（需 3）`;
        continue;
      }
    }
    return { ok: true, taskId };
  }

  return {
    ok: false,
    taskId,
    detail: `已交但 App 评分中：part/submit 全部成功，但 getHistoryTrainingTasks 轮询后 scoreIsOut≠true（${lastHint}）${doneSuffix()}`,
  };
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
