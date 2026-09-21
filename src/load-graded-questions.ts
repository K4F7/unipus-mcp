import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import {
  resolveLoadGradedQuestionsUrl,
  resolveUAppId,
} from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  toolError,
  type ToolResult,
} from "./result.js";
import { asExactIdString } from "./safe-json.js";

export type LoadGradedQuestionsInput = {
  taskId: string;
  ansVersion?: number;
  openId?: string;
};

export type LoadGradedQuestionsPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  loadGradedQuestionsUrl?: string;
};

export type LoadGradedQuestionsResult = ToolResult & {
  task_id?: string;
  ans_version?: number;
  items?: unknown[];
  raw_code?: number | null;
};

/**
 * POST /api/uls/user/loadGradedQuestions { taskId, ansVersion }
 * with raw JWT + u-app-id (default 116). Empty list is OK mid-task.
 */
export async function loadGradedQuestions(
  ports: LoadGradedQuestionsPorts,
  input: LoadGradedQuestionsInput,
): Promise<LoadGradedQuestionsResult> {
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

  const url =
    ports.loadGradedQuestionsUrl ?? resolveLoadGradedQuestionsUrl(ports.env);
  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "content-type": "application/json",
    "u-app-id": resolveUAppId(ports.env),
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
    return toolError("NETWORK_ERROR", `loadGradedQuestions 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `loadGradedQuestions 401：${hint}`
        : "loadGradedQuestions 401：JWT 无效或已过期",
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `loadGradedQuestions HTTP ${response.statusCode}：${hint}`
        : `loadGradedQuestions HTTP ${response.statusCode}`,
    );
  }

  const parsed = parseLoadGradedQuestionsBody(response.body);
  if (parsed == null) {
    return toolError(
      "PARSE_ERROR",
      "loadGradedQuestions 响应无法解析（需业务成功码与 value 数组）",
    );
  }

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `已读取评分题目 ${parsed.items.length} 条 taskId=${taskId}`,
    task_id: taskId,
    ans_version: ansVersion,
    items: parsed.items,
    raw_code: parsed.raw_code,
  };
}

/** Exported for unit tests. */
export function parseLoadGradedQuestionsBody(
  body: string,
): { items: unknown[]; raw_code: number | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const root = value as Record<string, unknown>;
  const code = numericCode(root.code);
  if (code != null && code !== 0 && code !== 1 && code !== 200) {
    return null;
  }
  const data = root.value ?? root.data;
  if (!Array.isArray(data)) {
    return null;
  }
  return { items: data, raw_code: code };
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
