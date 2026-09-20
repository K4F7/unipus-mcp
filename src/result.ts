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
  /** Backward-compatible alias of listen_done */
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
  /** Exact q_qinstid / instanceId strings from paperJson (never Number-coerced). */
  instance_ids?: string[];
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
    // progress_* aliases listen_* for callers that predate twin fields
    progress_done: input.listen_done,
    progress_total: input.listen_total,
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
  instance_ids?: string[];
}): StartListeningResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    task_id: input.task_id,
    paper_token: input.paper_token,
    raw_code: input.raw_code,
    instance_ids: input.instance_ids ?? [],
  };
}

export type UploadAnswerAudioResult = ToolResult & {
  file_name?: string;
  storage_key?: string;
  cdn_url?: string;
  upload_hash?: string | null;
};

export function okUploadAnswerAudio(input: {
  message: string;
  file_name: string;
  storage_key: string;
  cdn_url: string;
  upload_hash: string | null;
}): UploadAnswerAudioResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    file_name: input.file_name,
    storage_key: input.storage_key,
    cdn_url: input.cdn_url,
    upload_hash: input.upload_hash,
  };
}

export type SubmitAnswerResult = ToolResult & {
  task_id?: string;
  instance_id?: string;
  raw_code?: number | null;
};

export function okSubmitAnswer(input: {
  message: string;
  task_id: string;
  instance_id: string;
  raw_code: number | null;
}): SubmitAnswerResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    task_id: input.task_id,
    instance_id: input.instance_id,
    raw_code: input.raw_code,
  };
}

export type GradeQuestionResult = ToolResult & {
  task_id?: string;
  question_instance_id?: string;
  score?: number | null;
  raw_code?: number | null;
  raw_value?: unknown;
};

export function okGradeQuestion(input: {
  message: string;
  task_id: string;
  question_instance_id: string;
  score: number | null;
  raw_code: number | null;
  raw_value?: unknown;
}): GradeQuestionResult {
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: input.message,
    task_id: input.task_id,
    question_instance_id: input.question_instance_id,
    score: input.score,
    raw_code: input.raw_code,
    raw_value: input.raw_value,
  };
}

export function toMcpToolResponse(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { ...result },
    isError: result.isError,
  };
}
