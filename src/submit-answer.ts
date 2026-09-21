import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import { resolveSubmitAnswerUrl } from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  okSubmitAnswer,
  toolError,
  type SubmitAnswerResult,
} from "./result.js";
import { asExactIdString } from "./safe-json.js";

export type SubmitAnswerUserItem = {
  instanceId: string;
  /** JSON string or object; objects are stringified. */
  answer: string | Record<string, unknown>;
  answerVersion?: number;
  context?: string | Record<string, unknown>;
  contextVersion?: number;
};

export type SubmitAnswerInput = {
  taskId: string;
  /** Paper token from loadPaper — required to avoid multi-device lock. */
  paperToken: string;
  ansVersion?: number;
  durationSec?: number;
  /** One or more question answers. */
  userData: SubmitAnswerUserItem[];
  openId?: string;
  /**
   * When true (default), wrap a bare audio CDN URL into the oral
   * `{ value:[], children:[], record:{ url } }` answer JSON.
   */
  wrapAudioUrl?: boolean;
};

export type SubmitAnswerPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  submitAnswerUrl?: string;
};

/**
 * Submit answers via POST /api/uls/user/submitAnswer.
 * Body: { taskId, ansVersion, token, duration, userData[] }.
 * Live-confirmed 2026-09-21 with raw JWT + loadPaper token.
 */
export async function submitAnswer(
  ports: SubmitAnswerPorts,
  input: SubmitAnswerInput,
): Promise<SubmitAnswerResult> {
  const taskId = (asExactIdString(input.taskId) ?? input.taskId).trim();
  if (taskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
  }
  const paperToken = input.paperToken.trim();
  if (paperToken.length === 0) {
    return toolError(
      "INVALID_ARGUMENT",
      "paperToken 不能为空（来自 loadPaper / start_listening_training）",
    );
  }
  if (!Array.isArray(input.userData) || input.userData.length === 0) {
    return toolError("INVALID_ARGUMENT", "userData 不能为空");
  }

  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  if (!(ansVersion > 0)) {
    return toolError("INVALID_ARGUMENT", "ansVersion 必须是正数");
  }

  const duration =
    input.durationSec != null && Number.isFinite(input.durationSec)
      ? Math.max(0, Number(input.durationSec))
      : 1;

  const wrapAudioUrl = input.wrapAudioUrl !== false;
  const userData = [];
  for (const item of input.userData) {
    const instanceId =
      asExactIdString(item.instanceId) ??
      String(item.instanceId ?? "").trim();
    if (instanceId.length === 0) {
      return toolError("INVALID_ARGUMENT", "userData.instanceId 不能为空");
    }
    const answer = normalizeAnswer(item.answer, wrapAudioUrl);
    if (answer == null) {
      return toolError(
        "INVALID_ARGUMENT",
        `userData[${instanceId}].answer 无效`,
      );
    }
    userData.push({
      instanceId,
      answer,
      answerVersion:
        item.answerVersion != null && Number.isFinite(item.answerVersion)
          ? Number(item.answerVersion)
          : 1,
      context: normalizeContext(item.context),
      contextVersion:
        item.contextVersion != null && Number.isFinite(item.contextVersion)
          ? Number(item.contextVersion)
          : 1,
    });
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const url = ports.submitAnswerUrl ?? resolveSubmitAnswerUrl(ports.env);
  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "content-type": "application/json",
  };
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
  }

  const body = JSON.stringify({
    taskId,
    ansVersion,
    token: paperToken,
    duration,
    userData,
  });

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "POST",
      headers,
      body,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `submitAnswer 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `submitAnswer 401：${hint}`
        : "submitAnswer 401：JWT 无效或已过期",
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `submitAnswer HTTP ${response.statusCode}：${hint}`
        : `submitAnswer HTTP ${response.statusCode}`,
    );
  }

  const parsed = parseSubmitAnswerBody(response.body);
  if (parsed == null) {
    const biz = readSubmitBusinessFailure(response.body);
    if (biz != null) {
      const hint =
        biz.code === 4295
          ? "（定级卷需全卷 userData，且每题 answer.children 长度对齐小题数；见 placement-paper helpers）"
          : "";
      return toolError(
        "BUSINESS_ERROR",
        `submitAnswer 业务失败 code=${biz.code}${biz.msg != null ? `：${biz.msg}` : ""}${hint}`,
      );
    }
    return toolError(
      "PARSE_ERROR",
      "submitAnswer 响应无法解析为业务成功",
    );
  }

  return okSubmitAnswer({
    message: `已提交答题 taskId=${taskId} instances=${userData.length}`,
    task_id: taskId,
    instance_id: userData.map((u) => u.instanceId).join(","),
    raw_code: parsed.raw_code,
  });
}

export function buildOralRecordAnswer(audioUrl: string): string {
  return JSON.stringify({
    value: [],
    children: [],
    record: { url: audioUrl },
  });
}

function normalizeAnswer(
  answer: string | Record<string, unknown>,
  wrapAudioUrl: boolean,
): string | null {
  if (typeof answer === "object" && answer != null) {
    return JSON.stringify(answer);
  }
  if (typeof answer !== "string") {
    return null;
  }
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (
    wrapAudioUrl &&
    /^https?:\/\//i.test(trimmed) &&
    !trimmed.startsWith("{")
  ) {
    return buildOralRecordAnswer(trimmed);
  }
  return trimmed;
}

function normalizeContext(
  context: string | Record<string, unknown> | undefined,
): string {
  if (context == null) {
    return JSON.stringify({ state: "done" });
  }
  if (typeof context === "object") {
    return JSON.stringify(context);
  }
  const trimmed = context.trim();
  return trimmed.length > 0 ? trimmed : JSON.stringify({ state: "done" });
}


export function readSubmitBusinessFailure(
  body: string,
): { code: number; msg: string | null } | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const code = record.code;
  const n =
    typeof code === "number"
      ? code
      : typeof code === "string" &&
          code.trim() !== "" &&
          !Number.isNaN(Number(code))
        ? Number(code)
        : null;
  if (n == null || n === 0 || n === 1 || n === 200) {
    return null;
  }
  const msg =
    typeof record.msg === "string"
      ? record.msg
      : typeof record.message === "string"
        ? record.message
        : null;
  return { code: n, msg };
}

export function parseSubmitAnswerBody(
  body: string,
): { raw_code: number | null } | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const code = record.code;
  const ok =
    code === 0 ||
    code === 1 ||
    code === 200 ||
    code === "0" ||
    code === "1" ||
    code === "200" ||
    record.success === true ||
    record.value === true;
  if (!ok) {
    return null;
  }
  const raw =
    typeof code === "number"
      ? code
      : typeof code === "string" && code.trim() !== "" && !Number.isNaN(Number(code))
        ? Number(code)
        : null;
  return { raw_code: raw };
}
