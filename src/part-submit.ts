import type { AuthPorts } from "./auth.js";
import { resolvePartSubmitUrl, resolveUAppId } from "./config.js";
import {
  toolError,
  type ToolResult,
} from "./result.js";
import { asExactIdString } from "./safe-json.js";
import {
  numericCode,
  parseBusinessBody,
  ulsAuthedJsonRequest,
} from "./uls-business.js";

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
  return numericCode(value) === 1;
}

/** Exported for unit tests — thin wrapper over single-parse helper. */
export function parsePartSubmitBody(
  body: string,
): { data: unknown; raw_code: number | null } | null {
  const parsed = parseBusinessBody(body, {
    successCode: 1,
    dataKeys: ["value", "data"],
  });
  if (!parsed.ok) {
    return null;
  }
  return { data: parsed.data, raw_code: parsed.raw_code };
}

/**
 * Build the wire body for part/submit (snapshot or submit).
 * context objects are JSON-stringified; answer objects likewise.
 * Callers must validate IDs first (asExactIdString); never String(number).
 */
export function buildPartSubmitBody(
  input: PartSubmitBodyInput,
): Record<string, unknown> {
  const taskId = asExactIdString(input.taskId) ?? "";
  const partId = asExactIdString(input.partId) ?? "";
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
    const instanceId = asExactIdString(item.instanceId) ?? "";
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
  const taskId = asExactIdString(input.taskId);
  if (taskId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "taskId 不能为空或无法安全解析为精确 id",
    );
  }
  const partId = asExactIdString(input.partId);
  if (partId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "partId 不能为空或无法安全解析为精确 id",
    );
  }
  const token = input.token.trim();
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
    if (asExactIdString(item.instanceId) == null) {
      return toolError(
        "INVALID_ARGUMENT",
        "userData.instanceId 不能为空或无法安全解析为精确 id",
      );
    }
  }

  const url = ports.partSubmitUrl ?? resolvePartSubmitUrl(ports.env);
  const body = buildPartSubmitBody(input);

  const response = await ulsAuthedJsonRequest(ports, {
    label: "part/submit",
    url,
    method: "POST",
    headers: (jwt) => {
      const headers: Record<string, string> = {
        authorization: jwt,
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
      return headers;
    },
    jsonBody: body,
    successCode: 1,
    dataKeys: ["value", "data"],
  });
  if (!response.ok) {
    return response.result;
  }

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `part/submit ${input.action} 成功 taskId=${taskId} partId=${partId}`,
    action: input.action,
    task_id: taskId,
    part_id: partId,
    raw_code: response.raw_code,
    data: response.data,
  };
}
