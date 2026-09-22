import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import { resolvePartSubmitUrl, resolveUAppId } from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  toolError,
  type ToolResult,
} from "./result.js";
import {
  asExactIdString,
  parseJsonPreservingLargeInts,
} from "./safe-json.js";

/**
 * POST /api/uls/part/submit — 范例学习 / AI对话退出 / 自由表达.
 * Same URL for action=snapshot and action=submit. Business success code=1.
 * Do not invent /oral/train or a separate submit path.
 */

export type PartSubmitAction = "snapshot" | "submit";

export type PartSubmitUserItem = {
  instanceId: string;
  /** Answer JSON string or object (stringified). */
  answer: string | Record<string, unknown>;
  answerVersion?: number;
  context?: string | Record<string, unknown>;
  contextVersion?: number;
  instStatus?: number | string;
};

export type PartSubmitBodyInput = {
  action: PartSubmitAction;
  taskId: string;
  partId: string;
  /** loadPaper token. */
  token: string;
  ansVersion?: number;
  duration?: number;
  userData: PartSubmitUserItem[];
};

export type PartSubmitInput = PartSubmitBodyInput & {
  openId?: string;
  /** When true, also send cloud WebView headers (sourceid + x-requested-with). */
  cloudHeaders?: boolean;
};

export type PartSubmitPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  partSubmitUrl?: string;
};

export type PartSubmitResult = ToolResult & {
  action?: PartSubmitAction;
  task_id?: string;
  part_id?: string;
  raw_code?: number | null;
  data?: unknown;
};

/** Exported for unit tests. */
export function isPartSubmitSuccessCode(value: unknown): boolean {
  const code = numericCode(value);
  return code === 1;
}

/** Exported for unit tests. */
export function parsePartSubmitBody(
  body: string,
): { data: unknown; raw_code: number | null } | null {
  let value: unknown;
  try {
    value = parseJsonPreservingLargeInts(body);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const root = value as Record<string, unknown>;
  if (!isPartSubmitSuccessCode(root.code)) {
    return null;
  }
  return {
    data: root.value ?? root.data ?? null,
    raw_code: numericCode(root.code),
  };
}

/**
 * Build the wire body for part/submit (snapshot or submit).
 * context objects are JSON-stringified; answer objects likewise.
 */
export function buildPartSubmitBody(
  input: PartSubmitBodyInput,
): Record<string, unknown> {
  const taskId = (asExactIdString(input.taskId) ?? input.taskId).trim();
  const partId = (asExactIdString(input.partId) ?? input.partId).trim();
  const token = input.token.trim();
  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  const duration =
    input.duration != null && Number.isFinite(input.duration)
      ? Math.max(0, Number(input.duration))
      : 0;

  const userData = input.userData.map((item) => {
    const instanceId =
      asExactIdString(item.instanceId) ??
      String(item.instanceId ?? "").trim();
    const answer =
      typeof item.answer === "string"
        ? item.answer
        : JSON.stringify(item.answer);
    const context =
      item.context == null
        ? undefined
        : typeof item.context === "string"
          ? item.context
          : JSON.stringify(item.context);
    const row: Record<string, unknown> = {
      instanceId,
      answer,
      answerVersion:
        item.answerVersion != null && Number.isFinite(item.answerVersion)
          ? Number(item.answerVersion)
          : 1,
      contextVersion:
        item.contextVersion != null && Number.isFinite(item.contextVersion)
          ? Number(item.contextVersion)
          : 1,
    };
    if (context != null) {
      row.context = context;
    }
    if (item.instStatus != null) {
      row.instStatus = item.instStatus;
    }
    return row;
  });

  return {
    action: input.action,
    ansVersion,
    duration,
    partId,
    taskId,
    token,
    userData,
  };
}

export async function partSubmit(
  ports: PartSubmitPorts,
  input: PartSubmitInput,
): Promise<PartSubmitResult> {
  if (input.action !== "snapshot" && input.action !== "submit") {
    return toolError(
      "INVALID_ARGUMENT",
      'action 必须是 "snapshot" 或 "submit"',
    );
  }
  const taskId = (asExactIdString(input.taskId) ?? input.taskId).trim();
  const partId = (asExactIdString(input.partId) ?? input.partId).trim();
  const token = input.token.trim();
  if (taskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
  }
  if (partId.length === 0) {
    return toolError("INVALID_ARGUMENT", "partId 不能为空");
  }
  if (token.length === 0) {
    return toolError(
      "INVALID_ARGUMENT",
      "token 不能为空（来自 loadPaper / start_speaking_training）",
    );
  }
  if (!Array.isArray(input.userData) || input.userData.length === 0) {
    return toolError("INVALID_ARGUMENT", "userData 不能为空");
  }
  for (const item of input.userData) {
    const instanceId =
      asExactIdString(item.instanceId) ??
      String(item.instanceId ?? "").trim();
    if (instanceId.length === 0) {
      return toolError("INVALID_ARGUMENT", "userData.instanceId 不能为空");
    }
  }

  const url = ports.partSubmitUrl ?? resolvePartSubmitUrl(ports.env);
  if (url.includes("/oral/train")) {
    return toolError(
      "INVALID_ARGUMENT",
      "禁止使用 /oral/train（抓包未出现；请用 part/submit）",
    );
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "content-type": "application/json",
  };
  // AI dialog exit used ucloud with sourceid; 范例学习 also accepted u-app-id.
  if (input.cloudHeaders !== false) {
    headers.sourceid = resolveUAppId(ports.env);
    headers["x-requested-with"] = "cn.unipus.cloud";
    headers["u-app-id"] = resolveUAppId(ports.env);
  }
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
  }

  const body = buildPartSubmitBody(input);

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `part/submit 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `part/submit 401：${hint}`
        : "part/submit 401：JWT 无效或已过期",
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `part/submit HTTP ${response.statusCode}：${hint}`
        : `part/submit HTTP ${response.statusCode}`,
    );
  }

  const business = peekBusinessCode(response.body);
  if (business != null && !isPartSubmitSuccessCode(business.code)) {
    return toolError(
      "BUSINESS_ERROR",
      `part/submit 业务码 ${business.code}${
        business.msg != null ? `：${business.msg}` : "（需 code=1）"
      }`,
    );
  }

  const parsed = parsePartSubmitBody(response.body);
  if (parsed == null) {
    return toolError(
      "PARSE_ERROR",
      "part/submit 响应无法解析（需业务成功码 code=1）",
    );
  }

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `part/submit ${input.action} 成功 taskId=${taskId} partId=${partId}`,
    action: input.action,
    task_id: taskId,
    part_id: partId,
    raw_code: parsed.raw_code,
    data: parsed.data,
  };
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

function peekBusinessCode(
  body: string,
): { code: number; msg?: string } | null {
  try {
    const value = parseJsonPreservingLargeInts(body);
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const root = value as Record<string, unknown>;
    const code = numericCode(root.code);
    if (code == null) {
      return null;
    }
    const msg =
      typeof root.msg === "string"
        ? root.msg
        : typeof root.message === "string"
          ? root.message
          : undefined;
    return { code, msg };
  } catch {
    return null;
  }
}
