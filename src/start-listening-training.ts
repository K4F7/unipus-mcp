import {
  requireConfiguredJwt,
  type AuthPorts,
} from "./auth.js";
import { resolveLoadPaperUrl } from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  okStartListening,
  toolError,
  type StartListeningResult,
} from "./result.js";
import {
  asExactIdString,
  collectQuestionInstanceIds,
  extractParsedPaperJson,
  parseJsonPreservingLargeInts,
} from "./safe-json.js";

export type StartListeningInput = {
  taskId: string;
  /** Paper/answer version from H5 query `ansVersion` (SPA). Default 1. */
  ansVersion?: number;
  openId?: string;
};

export type StartListeningPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadPaperUrl?: string;
};

/**
 * Start U听力「开始训练」via SPA-confirmed
 * POST /api/uls/user/loadPaper { taskId, ansVersion }.
 * Authorization is a raw JWT (no "Bearer " prefix) per uadaptive gateway.
 */
export async function startListeningTraining(
  ports: StartListeningPorts,
  input: StartListeningInput,
): Promise<StartListeningResult> {
  const taskId = (asExactIdString(input.taskId) ?? input.taskId).trim();
  if (taskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
  }

  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  if (!(ansVersion > 0)) {
    return toolError("INVALID_ARGUMENT", "ansVersion 必须是正数");
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const url = ports.loadPaperUrl ?? resolveLoadPaperUrl(ports.env);
  const headers: Record<string, string> = {
    // uadaptive gateway rejects "Bearer " prefix
    authorization: loaded.jwt,
    "content-type": "application/json",
  };
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
  }

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "POST",
      headers,
      body: JSON.stringify({ taskId, ansVersion }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `开始训练失败（网络）：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null ? `loadPaper 401：${hint}` : "loadPaper 401：JWT 无效或已过期",
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `loadPaper HTTP ${response.statusCode}：${hint}`
        : `loadPaper HTTP ${response.statusCode}`,
    );
  }

  const parsed = parseLoadPaperBody(response.body, taskId);
  if (parsed == null) {
    return toolError(
      "PARSE_ERROR",
      "loadPaper 响应无法解析（需含业务成功码与可观察 id）",
    );
  }

  return okStartListening({
    message: `已开始听力训练 taskId=${parsed.task_id}`,
    task_id: parsed.task_id,
    paper_token: parsed.paper_token,
    raw_code: parsed.raw_code,
    instance_ids: parsed.instance_ids,
  });
}

type ParsedLoadPaper = {
  task_id: string;
  paper_token: string | null;
  raw_code: number | null;
  instance_ids: string[];
};

/** Accept common uls envelopes until live schema is pinned. */
export function parseLoadPaperBody(
  body: string,
  fallbackTaskId: string,
): ParsedLoadPaper | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let value: unknown;
  try {
    // Preserve snowflake ids in paperJson / q_qinstid (see safe-json.ts).
    value = parseJsonPreservingLargeInts(trimmed);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const root = value as Record<string, unknown>;
  const code = numericCode(root.code);
  // SPA notes: some endpoints use code 0, others 1/200
  if (code != null && code !== 0 && code !== 1 && code !== 200) {
    return null;
  }

  const data = nestedRecord(root, "data") ?? nestedRecord(root, "value") ?? root;

  const taskId =
    asExactIdString(data.taskId) ??
    asExactIdString(data.task_id) ??
    asExactIdString(data.id) ??
    fallbackTaskId;
  const paperToken = firstString(data, [
    "token",
    "paperToken",
    "paper_token",
    "ansToken",
  ]);

  const paper = extractParsedPaperJson(data);
  // collectQuestionInstanceIds already de-dupes; pass both roots in one walk.
  const instance_ids = collectQuestionInstanceIds(
    paper != null ? [data, paper] : data,
  );

  return {
    task_id: taskId,
    paper_token: paperToken,
    raw_code: code,
    instance_ids,
  };
}

function nestedRecord(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = root[key];
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return String(value);
    }
  }
  return null;
}
