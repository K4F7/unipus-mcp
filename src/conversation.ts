import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import {
  resolveConversationChatInfoUrl,
  resolveConversationCreateUrl,
  resolveConversationMaxCountUrl,
  resolveConversationSaveUrl,
  resolveConversationStopUrl,
  resolveEbcpAuthUrl,
  resolveEbcpSpeakersUrl,
  resolveUAppId,
} from "./config.js";
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
 * AI口语对话 (ucloud conversation/* + ebcp/*).
 * Business success is code=200 (not uls user code=1).
 * Headers: sourceid (lowercase) + x-requested-with: cn.unipus.cloud + raw JWT.
 * Do NOT invent /api/uls/oral/train — WS oral.unipus.cn is transport only.
 */

export type ConversationPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  conversationCreateUrl?: string;
  conversationSaveUrl?: string;
  conversationStopUrl?: string;
  conversationChatInfoUrl?: string;
  conversationMaxCountUrl?: string;
  ebcpAuthUrl?: string;
  ebcpSpeakersUrl?: string;
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
  speakTaskId: string;
  duration: number;
  speakAddTaskRecord: Record<string, unknown>;
  openId?: string;
};

export type ConversationStopInput = {
  speakTaskId: string;
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

export type EbcpInput = {
  scene: string;
  bizExt: Record<string, unknown>;
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
  speakers?: unknown[];
  speak_voice_tones?: unknown[];
};

/** Exported for unit tests. */
export function isConversationSuccessCode(value: unknown): boolean {
  const code = numericCode(value);
  return code === 200;
}

/** Exported for unit tests. */
export function parseConversationDataBody(
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
  if (!isConversationSuccessCode(root.code)) {
    return null;
  }
  return {
    data: root.data ?? root.value ?? null,
    raw_code: numericCode(root.code),
  };
}

export async function conversationCreate(
  ports: ConversationPorts,
  input: ConversationCreateInput,
): Promise<ConversationResult> {
  const taskId = (asExactIdString(input.taskId) ?? input.taskId).trim();
  const questionId =
    asExactIdString(input.questionId) ?? String(input.questionId ?? "").trim();
  const title = input.title.trim();
  const role = input.role.trim();
  if (taskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
  }
  if (questionId.length === 0) {
    return toolError("INVALID_ARGUMENT", "questionId 不能为空");
  }
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
  const speakTaskId =
    asExactIdString(input.speakTaskId) ?? input.speakTaskId.trim();
  if (speakTaskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "speakTaskId 不能为空");
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
  const speakTaskId =
    asExactIdString(input.speakTaskId) ?? input.speakTaskId.trim();
  if (speakTaskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "speakTaskId 不能为空");
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
  const conversationId =
    asExactIdString(input.conversationId) ?? input.conversationId.trim();
  if (conversationId.length === 0) {
    return toolError("INVALID_ARGUMENT", "conversationId 不能为空");
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

export async function ebcpAuth(
  ports: ConversationPorts,
  input: EbcpInput,
): Promise<ConversationResult> {
  return ebcpPost(ports, input, "ebcp/auth", ports.ebcpAuthUrl ?? resolveEbcpAuthUrl(ports.env));
}

export async function ebcpSpeakers(
  ports: ConversationPorts,
  input: EbcpInput,
): Promise<ConversationResult> {
  return conversationRequest(ports, {
    label: "ebcp/speakers",
    url: ports.ebcpSpeakersUrl ?? resolveEbcpSpeakersUrl(ports.env),
    method: "POST",
    openId: input.openId,
    body: { scene: input.scene, bizExt: input.bizExt },
    mapOk(parsed) {
      const data = asRecord(parsed.data) ?? {};
      const speakers = Array.isArray(data.speakers) ? data.speakers : [];
      const tones = Array.isArray(data.speakVoiceTones)
        ? data.speakVoiceTones
        : [];
      return {
        message: `已读取 speakers ${speakers.length} 条`,
        speakers,
        speak_voice_tones: tones,
        data: parsed.data,
      };
    },
  });
}

async function ebcpPost(
  ports: ConversationPorts,
  input: EbcpInput,
  label: string,
  url: string,
): Promise<ConversationResult> {
  const scene = input.scene.trim();
  if (scene.length === 0) {
    return toolError("INVALID_ARGUMENT", "scene 不能为空");
  }
  if (
    input.bizExt == null ||
    typeof input.bizExt !== "object" ||
    Array.isArray(input.bizExt)
  ) {
    return toolError("INVALID_ARGUMENT", "bizExt 必须是对象");
  }
  return conversationRequest(ports, {
    label,
    url,
    method: "POST",
    openId: input.openId,
    body: { scene, bizExt: input.bizExt },
    mapOk(parsed) {
      return {
        message: `已完成 ${label}`,
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
  if (opts.url.includes("/oral/train")) {
    return toolError(
      "INVALID_ARGUMENT",
      "禁止使用 /oral/train（抓包未出现；请用 conversation/*）",
    );
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const headers = cloudConversationHeaders(loaded.jwt, ports.env, opts.openId);
  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url: opts.url,
      method: opts.method,
      headers,
      body:
        opts.method === "POST" && opts.body != null
          ? JSON.stringify(opts.body)
          : undefined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `${opts.label} 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `${opts.label} 401：${hint}`
        : `${opts.label} 401：JWT 无效或已过期`,
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `${opts.label} HTTP ${response.statusCode}：${hint}`
        : `${opts.label} HTTP ${response.statusCode}`,
    );
  }

  const business = peekBusinessCode(response.body);
  if (business != null && !isConversationSuccessCode(business.code)) {
    return toolError(
      "BUSINESS_ERROR",
      `${opts.label} 业务码 ${business.code}${
        business.msg != null ? `：${business.msg}` : "（需 code=200）"
      }`,
    );
  }

  const parsed = parseConversationDataBody(response.body);
  if (parsed == null) {
    return toolError(
      "PARSE_ERROR",
      `${opts.label} 响应无法解析（需业务成功码 code=200）`,
    );
  }

  const mapped = opts.mapOk(parsed);
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: mapped.message,
    raw_code: parsed.raw_code,
    data: mapped.data ?? parsed.data,
    conversation_id: mapped.conversation_id,
    scene_id: mapped.scene_id,
    token: mapped.token,
    level: mapped.level,
    record_id: mapped.record_id,
    max_count: mapped.max_count,
    speakers: mapped.speakers,
    speak_voice_tones: mapped.speak_voice_tones,
  };
}

/** App WebView headers for conversation / ebcp on ucloud. */
export function cloudConversationHeaders(
  jwt: string,
  env?: NodeJS.ProcessEnv,
  openId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: jwt,
    "content-type": "application/json",
    sourceid: resolveUAppId(env),
    "x-requested-with": "cn.unipus.cloud",
  };
  const oid = openId?.trim();
  if (oid != null && oid.length > 0) {
    headers.openId = oid;
  }
  return headers;
}

function resolveSourceId(
  env: NodeJS.ProcessEnv | undefined,
  override?: number | string,
): number {
  if (override != null) {
    const n = typeof override === "number" ? override : Number(String(override).trim());
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const fromEnv = Number(resolveUAppId(env));
  return Number.isFinite(fromEnv) ? fromEnv : 116;
}

function asRecord(value: unknown): Record<string, unknown> | null {
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
