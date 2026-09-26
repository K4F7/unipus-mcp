/**
 * Headless speak weekly grind: silent TTS → upload → EN_SENT_SCORE children → submitAnswer.
 * No speakers/afplay; no /oral/train; no part/submit.
 */
import type { AuthPorts } from "./auth.js";
import { resolveLoadPaperUrl } from "./config.js";
import {
  DEFAULT_AI_SPEAK_SCRIPT,
  buildLearnDoneAnswer,
  enSentChildRecord,
  finalizeUserData,
  isOkApiCode,
  segmentSpeakText,
  walkPaperLeaves,
  type GrindLeaf,
} from "./grind-paper.js";
import { summarizeHttpErrorBody } from "./http.js";
import { extractParsedPaperJson, parseJsonPreservingLargeInts } from "./safe-json.js";
import { submitAnswer } from "./submit-answer.js";
import { synthesizeSpeechWav } from "./tts.js";
import { uploadAnswerAudio } from "./upload-answer-audio.js";

export type GrindSpeakPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
  /** Inject silent TTS+upload; default uses Edge TTS + Qiniu. */
  ttsUpload?: (
    text: string,
    tag: string,
  ) => Promise<{ url: string; text: string }>;
};

export type GrindSpeakRoundResult =
  | { ok: true; taskId: string }
  | { ok: false; taskId: string | null; detail: string };

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

async function defaultTtsUpload(
  ports: GrindSpeakPorts,
  text: string,
  tag: string,
): Promise<{ url: string; text: string }> {
  const spoken = await synthesizeSpeechWav({ text });
  try {
    const up = await uploadAnswerAudio(ports, {
      filePath: spoken.wavPath,
      fileName: `${tag}.wav`,
    });
    if (up.isError || !("cdn_url" in up) || !up.cdn_url) {
      throw new Error(`upload fail: ${up.message || up.code}`);
    }
    return { url: String(up.cdn_url), text };
  } finally {
    await spoken.cleanup?.();
  }
}

async function buildOralMulti(
  leaf: GrindLeaf,
  ttsUpload: (text: string, tag: string) => Promise<{ url: string; text: string }>,
): Promise<string> {
  const children = Array.isArray(leaf.data.children) ? leaf.data.children : [];
  const built = [];
  for (let i = 0; i < Math.max(children.length, 1); i++) {
    const ch = children[i] || {};
    const text = segmentSpeakText(ch, `Speaking practice sentence ${i + 1}.`);
    const { url } = await ttsUpload(text, `speak-${leaf.instanceId}-${i}`);
    built.push(enSentChildRecord(text, url));
  }
  return JSON.stringify({ value: [], children: built });
}

async function buildAiOrFree(
  leaf: GrindLeaf,
  ttsUpload: (text: string, tag: string) => Promise<{ url: string; text: string }>,
): Promise<string> {
  const { url } = await ttsUpload(
    DEFAULT_AI_SPEAK_SCRIPT,
    `speak-${leaf.instanceId}-main`,
  );
  return JSON.stringify({
    value: [],
    children: [enSentChildRecord(DEFAULT_AI_SPEAK_SCRIPT, url)],
  });
}

async function buildLeafAnswer(
  leaf: GrindLeaf,
  ttsUpload: (text: string, tag: string) => Promise<{ url: string; text: string }>,
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
    return buildOralMulti(leaf, ttsUpload);
  }
  return buildAiOrFree(leaf, ttsUpload);
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

  const ttsUpload =
    ports.ttsUpload ??
    ((text: string, tag: string) => defaultTtsUpload(ports, text, tag));

  const leaves = walkPaperLeaves(paper);
  const answers: string[] = [];
  for (const leaf of leaves) {
    answers.push(await buildLeafAnswer(leaf, ttsUpload));
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
};

export async function grindSpeakGaps(
  ports: GrindSpeakPorts,
  need: number,
  maxRounds = 5,
): Promise<GrindSpeakGapsResult> {
  if (need <= 0) return { completed: 0, taskIds: [] };
  const taskIds: string[] = [];
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
