/**
 * Stable JSON payload for MCP tool responses.
 * Passwords / tokens never appear here or in tool arguments.
 */
export type ToolStatus =
  | "ok"
  | "not_implemented"
  | "auth_required"
  | "error";

export type ToolResult = {
  isError: boolean;
  status: ToolStatus;
  code: string;
  message: string;
};

export type AuthStatusResult = ToolResult & {
  authenticated: boolean;
  expired?: boolean | null;
  expiresAt?: string | null;
  userId?: string | null;
  probeStatusCode?: number;
};

export type WeekProgressResult = ToolResult & {
  /** @deprecated alias of listen_*; kept for backward compatibility */
  progress_done?: number;
  progress_total?: number;
  level?: string | null;
  listen_done?: number | null;
  listen_total?: number | null;
  speak_done?: number | null;
  speak_total?: number | null;
};

export type StartListeningResult = ToolResult & {
  task_id?: string;
  paper_token?: string | null;
  raw_code?: number | null;
};

export function notImplemented(feature: string): ToolResult {
  return {
    isError: true,
    status: "not_implemented",
    code: "NOT_IMPLEMENTED",
    message: `未实现：${feature}（需后续 issue 接入 uls HTTP；登录仅走环境变量 / CLI，不作为工具参数）`,
  };
}

export function authRequired(detail?: string): AuthStatusResult {
  const hint = "密码永不作为 MCP 工具参数。";
  const message =
    detail != null && detail.trim().length > 0
      ? `需登录：${detail.trim()}（${hint}）`
      : `需登录：尚未配置可用 JWT / SSO session。请用环境变量或 CLI 登录（${hint}）`;
  return {
    isError: true,
    status: "auth_required",
    code: "AUTH_REQUIRED",
    message,
    authenticated: false,
  };
}

export function toolError(code: string, message: string): ToolResult {
  return {
    isError: true,
    status: "error",
    code,
    message,
  };
}

export function okAuthStatus(input: {
  message: string;
  expired?: boolean | null;
  expiresAt?: string | null;
  userId?: string | null;
  probeStatusCode?: number;
}): AuthStatusResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    authenticated: true,
    expired: input.expired ?? false,
    expiresAt: input.expiresAt ?? null,
    userId: input.userId ?? null,
    probeStatusCode: input.probeStatusCode,
  };
}

export function okWeekProgress(input: {
  message: string;
  progress_done: number;
  progress_total: number;
  level: string | null;
  listen_done: number;
  listen_total: number;
  speak_done: number | null;
  speak_total: number | null;
}): WeekProgressResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    progress_done: input.progress_done,
    progress_total: input.progress_total,
    level: input.level,
    listen_done: input.listen_done,
    listen_total: input.listen_total,
    speak_done: input.speak_done,
    speak_total: input.speak_total,
  };
}

export function okStartListening(input: {
  message: string;
  task_id: string;
  paper_token: string | null;
  raw_code: number | null;
}): StartListeningResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    task_id: input.task_id,
    paper_token: input.paper_token,
    raw_code: input.raw_code,
  };
}

export function toMcpToolResponse(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { ...result },
    isError: result.isError,
  };
}
