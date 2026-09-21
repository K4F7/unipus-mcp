import {
  requireConfiguredJwt,
  type AuthPorts,
} from "./auth.js";
import {
  resolveUAppId,
  resolveUserStatusForAppUrl,
} from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  toolError,
  type StartListeningResult,
} from "./result.js";
import {
  asExactIdString,
  parseJsonPreservingLargeInts,
} from "./safe-json.js";
import {
  startListeningTraining,
  type StartListeningPorts,
} from "./start-listening-training.js";

export type StartSpeakingInput = {
  /** Optional override; default from getUserStatusForApp?flowType=speak. */
  taskId?: string;
  ansVersion?: number;
  openId?: string;
};

export type StartSpeakingPorts = StartListeningPorts;

/**
 * Start U口语训练: resolve speak taskId/ansVersion via getUserStatusForApp,
 * then same POST loadPaper as listening.
 *
 * Do not call while an App WebView session is open — part/submit may return 4021.
 */
export async function startSpeakingTraining(
  ports: StartSpeakingPorts,
  input: StartSpeakingInput = {},
): Promise<StartListeningResult> {
  let taskId = (asExactIdString(input.taskId) ?? input.taskId ?? "").trim();
  let ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : undefined;

  if (taskId.length === 0 || ansVersion == null) {
    const resolved = await resolveSpeakTask(ports, input.openId);
    if (!resolved.ok) {
      return resolved.result;
    }
    if (taskId.length === 0) {
      taskId = resolved.taskId;
    }
    if (ansVersion == null) {
      ansVersion = resolved.ansVersion;
    }
  }

  const result = await startListeningTraining(ports, {
    taskId,
    ansVersion,
    openId: input.openId,
  });
  if (!result.isError && result.status === "ok") {
    return {
      ...result,
      message: `已开始口语训练 taskId=${result.task_id}`,
    };
  }
  return result;
}

async function resolveSpeakTask(
  ports: AuthPorts & { env?: NodeJS.ProcessEnv },
  openId?: string,
): Promise<
  | { ok: true; taskId: string; ansVersion: number }
  | { ok: false; result: StartListeningResult }
> {
  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return { ok: false, result: loaded.result };
  }

  const url = resolveUserStatusForAppUrl(ports.env, "speak");
  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "u-app-id": resolveUAppId(ports.env),
  };
  const oid = openId?.trim();
  if (oid != null && oid.length > 0) {
    headers.openId = oid;
  }

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "GET",
      headers,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      result: toolError(
        "NETWORK_ERROR",
        `获取口语 taskId 失败（网络）：${detail}`,
      ),
    };
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return {
      ok: false,
      result: authRequired(
        hint != null
          ? `getUserStatusForApp 401：${hint}`
          : "getUserStatusForApp 401：JWT 无效或已过期",
      ),
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return {
      ok: false,
      result: toolError(
        "HTTP_ERROR",
        hint != null
          ? `getUserStatusForApp HTTP ${response.statusCode}：${hint}`
          : `getUserStatusForApp HTTP ${response.statusCode}`,
      ),
    };
  }

  const parsed = parseSpeakStatusBody(response.body);
  if (parsed == null) {
    return {
      ok: false,
      result: toolError(
        "PARSE_ERROR",
        "getUserStatusForApp(speak) 无法解析 taskId / ansVersion",
      ),
    };
  }
  return { ok: true, taskId: parsed.taskId, ansVersion: parsed.ansVersion };
}

/** Exported for unit tests. */
export function parseSpeakStatusBody(
  body: string,
): { taskId: string; ansVersion: number } | null {
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
  const code = numericCode(root.code);
  // Same success codes as loadPaper / loadGradedQuestions.
  if (code != null && code !== 0 && code !== 1 && code !== 200) {
    return null;
  }
  const data =
    nestedRecord(root, "value") ?? nestedRecord(root, "data") ?? root;
  const taskId =
    asExactIdString(data.taskId) ??
    asExactIdString(data.task_id) ??
    "";
  if (taskId.length === 0) {
    return null;
  }
  const raw = data.ansVersion ?? data.ans_version ?? 1;
  const ansVersion =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : 1;
  if (!Number.isFinite(ansVersion) || !(ansVersion > 0)) {
    return null;
  }
  return { taskId, ansVersion };
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
