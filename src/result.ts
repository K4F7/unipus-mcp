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

export function notImplemented(feature: string): ToolResult {
  return {
    isError: true,
    status: "not_implemented",
    code: "NOT_IMPLEMENTED",
    message: `未实现：${feature}（需后续 issue 接入 uls HTTP；登录仅走环境变量 / CLI，不作为工具参数）`,
  };
}

export function authRequired(detail?: string): ToolResult {
  const extra = detail != null && detail.length > 0 ? ` ${detail}` : "";
  return {
    isError: true,
    status: "auth_required",
    code: "AUTH_REQUIRED",
    message: `需登录：尚未配置可用 JWT / SSO session。请用环境变量或 CLI 登录（密码永不作为 MCP 工具参数）。${extra}`.trim(),
  };
}

export function toMcpToolResponse(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { ...result },
    isError: result.isError,
  };
}
