import type { AuthPorts } from "./auth.js";
import {
  resolveConversationChatInfoUrl,
  resolveConversationCreateUrl,
  resolveConversationMaxCountUrl,
  resolveConversationSaveUrl,
  resolveConversationStopUrl,
  resolveUAppId,
} from "./config.js";
import {
  toolError,
  type ToolResult,
} from "./result.js";
import { asExactIdString } from "./safe-json.js";
import {
  asRecord,
  numericCode,
  parseBusinessBody,
  ulsAuthedJsonRequest,
  ulsCloudHeaders,
} from "./uls-business.js";

/**
 * AI口语对话 (ucloud conversation/*).
 * Business success is code=200 (not uls user code=1).
 * Headers: sourceid (lowercase) + x-requested-with: cn.unipus.cloud + raw JWT.
 * Do NOT invent /api/uls/oral/train — WS oral.unipus.cn is transport only.
 *
 * Agent notes:
 * - save/stop `speakTaskId` === create’s `conversation_id` (alias `conversationId` accepted).
 * - create’s `token` is a dialog token, NOT the loadPaper / part_submit paper token.
 */

export type ConversationPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  conversationCreateUrl?: string;
  conversationSaveUrl?: string;
  conversationStopUrl?: string;
  conversationChatInfoUrl?: string;
  conversationMaxCountUrl?: string;
};

export type ConversationCreateInput = {
  taskId: string;
  questionId: string;
  title: string;
  role: string;
  ansVersion?: number;
  /** Defaults to UNIPUS_U_APP_ID / 116. Sent as body sourceId. */
  sourceId?: number | string;
  openId?: string;
};

export type ConversationSaveInput = {
  /** Same value as create’s conversation_id. */
  speakTaskId?: string;
  /** Alias for speakTaskId (create’s conversation_id). */
  conversationId?: string;
  duration: number;
  speakAddTaskRecord: Record<string, unknown>;
  openId?: string;
};

export type ConversationStopInput = {
  /** Same value as create’s conversation_id. */
  speakTaskId?: string;
  /** Alias for speakTaskId (create’s conversation_id). */
  conversationId?: string;
  evaluation: number | string;
  evaluationContent?: string;
  voiceToneId?: string;
  openId?: string;
};

export type ConversationChatInfoInput = {
  conversationId: string;
  openId?: string;
};

export type ConversationMaxCountInput = {
  openId?: string;
};

export type ConversationResult = ToolResult & {
  raw_code?: number | null;
  data?: unknown;
  conversation_id?: string;
  scene_id?: string;
  token?: string | null;
  level?: number | null;
  record_id?: string;
  max_count?: number | null;
};

/** Exported for unit tests. */
export function isConversationSuccessCode(value: unknown): boolean {
  return numericCode(value) === 200;
}

/** Exported for unit tests — thin wrapper over single-parse helper. */
export function parseConversationDataBody(
  body: string,
): { data: unknown; raw_code: number | null } | null {
  const parsed = parseBusinessBody(body, {
    successCode: 200,
    dataKeys: ["data", "value"],
  });
  if (!parsed.ok) {
    return null;
  }
  return { data: parsed.data, raw_code: parsed.raw_code };
}

/** @deprecated Prefer ulsCloudHeaders from uls-business; kept for callers/tests. */
export function cloudConversationHeaders(
  jwt: string,
  env?: NodeJS.ProcessEnv,
  openId?: string,
): Record<string, string> {
  return ulsCloudHeaders(jwt, env, openId);
}

export async function conversationCreate(
  ports: ConversationPorts,
  input: ConversationCreateInput,
): Promise<ConversationResult> {
  const taskId = asExactIdString(input.taskId);
  if (taskId == null) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空或无法安全解析为精确 id");
  }
  const questionId = asExactIdString(input.questionId);
  if (questionId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "questionId 不能为空或无法安全解析为精确 id",
    );
  }
  const title = input.title.trim();
  const role = input.role.trim();
  if (title.length === 0) {
    return toolError("INVALID_ARGUMENT", "title 不能为空");
  }
  if (role.length === 0) {
    return toolError("INVALID_ARGUMENT", "role 不能为空");
  }
  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  if (!(ansVersion > 0)) {
    return toolError("INVALID_ARGUMENT", "ansVersion 必须是正数");
  }
  const sourceId = resolveSourceId(ports.env, input.sourceId);

  return conversationRequest(ports, {
    label: "conversation/create",
    url: ports.conversationCreateUrl ?? resolveConversationCreateUrl(ports.env),
    method: "POST",
    openId: input.openId,
    body: {
      ansVersion,
      questionId,
      role,
      sourceId,
      taskId,
      title,
    },
    mapOk(parsed) {
      const data = asRecord(parsed.data) ?? {};
      const conversationId =
        asExactIdString(data.conversationId) ??
        asExactIdString(data.conversation_id) ??
        (typeof data.conversationId === "string"
          ? data.conversationId
          : undefined);
      const sceneId =
        asExactIdString(data.sceneId) ??
        (typeof data.sceneId === "string" ? data.sceneId : undefined);
      const token =
        typeof data.token === "string" && data.token.length > 0
          ? data.token
          : null;
      const level =
        typeof data.level === "number" && Number.isFinite(data.level)
          ? data.level
          : null;
      return {
        message: conversationId
          ? `已创建口语对话 conversationId=${conversationId}`
          : "已创建口语对话",
        conversation_id: conversationId,
        scene_id: sceneId,
        token,
        level,
      };
    },
  });
}

export async function conversationSave(
  ports: ConversationPorts,
  input: ConversationSaveInput,
): Promise<ConversationResult> {
  const speakTaskId = resolveSpeakTaskId(input);
  if (speakTaskId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "speakTaskId（或 conversationId）不能为空或无法安全解析为精确 id",
    );
  }
  if (!Number.isFinite(input.duration) || input.duration < 0) {
    return toolError("INVALID_ARGUMENT", "duration 必须是非负数字");
  }
  if (
    input.speakAddTaskRecord == null ||
    typeof input.speakAddTaskRecord !== "object" ||
    Array.isArray(input.speakAddTaskRecord)
  ) {
    return toolError("INVALID_ARGUMENT", "speakAddTaskRecord 必须是对象");
  }

  return conversationRequest(ports, {
    label: "conversation/save",
    url: ports.conversationSaveUrl ?? resolveConversationSaveUrl(ports.env),
    method: "POST",
    openId: input.openId,
    body: {
      duration: Number(input.duration),
      speakTaskId,
      speakAddTaskRecord: input.speakAddTaskRecord,
    },
    mapOk(parsed) {
      const data = asRecord(parsed.data) ?? {};
      const recordId =
        asExactIdString(data.id) ??
        (typeof data.id === "string" ? data.id : undefined);
      return {
        message: recordId
          ? `已保存对话轮次 id=${recordId}`
          : "已保存对话轮次",
        record_id: recordId,
      };
    },
  });
}

export async function conversationStop(
  ports: ConversationPorts,
  input: ConversationStopInput,
): Promise<ConversationResult> {
  const speakTaskId = resolveSpeakTaskId(input);
  if (speakTaskId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "speakTaskId（或 conversationId）不能为空或无法安全解析为精确 id",
    );
  }
  const body: Record<string, unknown> = {
    speakTaskId,
    evaluation: input.evaluation,
  };
  if (input.evaluationContent != null) {
    body.evaluationContent = input.evaluationContent;
  }
  if (input.voiceToneId != null && String(input.voiceToneId).trim().length > 0) {
    body.voiceToneId = String(input.voiceToneId).trim();
  }

  return conversationRequest(ports, {
    label: "conversation/stop",
    url: ports.conversationStopUrl ?? resolveConversationStopUrl(ports.env),
    method: "POST",
    openId: input.openId,
    body,
    mapOk() {
      return { message: `已结束口语对话 speakTaskId=${speakTaskId}` };
    },
  });
}

export async function conversationChatInfo(
  ports: ConversationPorts,
  input: ConversationChatInfoInput,
): Promise<ConversationResult> {
  const conversationId = asExactIdString(input.conversationId);
  if (conversationId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "conversationId 不能为空或无法安全解析为精确 id",
    );
  }
  const url =
    ports.conversationChatInfoUrl ??
    resolveConversationChatInfoUrl(ports.env, conversationId);
  return conversationRequest(ports, {
    label: "conversation/chat/info",
    url,
    method: "GET",
    openId: input.openId,
    mapOk(parsed) {
      return {
        message: `已读取对话记录 conversationId=${conversationId}`,
        data: parsed.data,
      };
    },
  });
}

export async function conversationMaxCount(
  ports: ConversationPorts,
  input: ConversationMaxCountInput = {},
): Promise<ConversationResult> {
  return conversationRequest(ports, {
    label: "conversation/max-count",
    url:
      ports.conversationMaxCountUrl ??
      resolveConversationMaxCountUrl(ports.env),
    method: "GET",
    openId: input.openId,
    mapOk(parsed) {
      const max =
        typeof parsed.data === "number" && Number.isFinite(parsed.data)
          ? parsed.data
          : null;
      return {
        message:
          max != null ? `对话话轮上限 ${max}` : "已读取对话话轮上限",
        max_count: max,
        data: parsed.data,
      };
    },
  });
}

type MapOk = (parsed: {
  data: unknown;
  raw_code: number | null;
}) => Partial<ConversationResult> & { message: string };

async function conversationRequest(
  ports: ConversationPorts,
  opts: {
    label: string;
    url: string;
    method: "GET" | "POST";
    openId?: string;
    body?: Record<string, unknown>;
    mapOk: MapOk;
  },
): Promise<ConversationResult> {
  const response = await ulsAuthedJsonRequest(ports, {
    label: opts.label,
    url: opts.url,
    method: opts.method,
    headers: (jwt) => ulsCloudHeaders(jwt, ports.env, opts.openId),
    jsonBody: opts.body,
    successCode: 200,
    dataKeys: ["data", "value"],
  });
  if (!response.ok) {
    return response.result;
  }

  const mapped = opts.mapOk({
    data: response.data,
    raw_code: response.raw_code,
  });
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: mapped.message,
    raw_code: response.raw_code,
    data: mapped.data ?? response.data,
    conversation_id: mapped.conversation_id,
    scene_id: mapped.scene_id,
    token: mapped.token,
    level: mapped.level,
    record_id: mapped.record_id,
    max_count: mapped.max_count,
  };
}

/**
 * Prefer speakTaskId; accept conversationId as alias (create’s conversation_id).
 * Never String(number) after asExactIdString fails.
 */
function resolveSpeakTaskId(input: {
  speakTaskId?: string;
  conversationId?: string;
}): string | null {
  const raw = input.speakTaskId ?? input.conversationId;
  if (raw == null) {
    return null;
  }
  return asExactIdString(raw);
}

function resolveSourceId(
  env: NodeJS.ProcessEnv | undefined,
  override?: number | string,
): number {
  if (override != null) {
    const n =
      typeof override === "number" ? override : Number(String(override).trim());
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const fromEnv = Number(resolveUAppId(env));
  return Number.isFinite(fromEnv) ? fromEnv : 116;
}
