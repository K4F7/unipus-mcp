import type { AuthPorts } from "./auth.js";
import { resolveWeekProgressUrl } from "./config.js";
import {
  authRequired,
  okWeekProgress,
  toolError,
  type WeekProgressResult,
} from "./result.js";

export type WeekProgressPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  weekProgressUrl?: string;
};

export async function listWeekProgress(
  ports: WeekProgressPorts,
): Promise<WeekProgressResult> {
  let jwt: string | null;
  try {
    jwt = await ports.credentials.getJwt();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return authRequired(`读取凭据失败：${detail}`);
  }

  if (jwt == null || jwt.trim().length === 0) {
    return authRequired(
      "未找到 UNIPUS_JWT / UNIPUS_JWT_FILE（或默认 ~/.config/unipus-mcp/jwt）",
    );
  }

  const url = ports.weekProgressUrl ?? resolveWeekProgressUrl(ports.env);

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "GET",
      headers: {
        authorization: `Bearer ${jwt}`,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `拉取本周进度失败（网络）：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeFailureBody(response.body);
    return authRequired(
      hint != null
        ? `本周进度 401：${hint}`
        : "本周进度 401：JWT 无效或已过期",
    );
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeFailureBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `本周进度 HTTP ${response.statusCode}：${hint}`
        : `本周进度 HTTP ${response.statusCode}`,
    );
  }

  const parsed = parseWeekProgressBody(response.body);
  if (parsed == null) {
    return toolError(
      "PARSE_ERROR",
      "本周进度响应无法解析为 progress_done / progress_total / level",
    );
  }

  return okWeekProgress({
    message: `本周听力进度 ${parsed.progress_done}/${parsed.progress_total}${
      parsed.level != null ? `，级别 ${parsed.level}` : ""
    }`,
    progress_done: parsed.progress_done,
    progress_total: parsed.progress_total,
    level: parsed.level,
  });
}

type ParsedProgress = {
  progress_done: number;
  progress_total: number;
  level: string | null;
};

/** Map stable MCP fields from known aliases until the real uls schema is captured. */
export function parseWeekProgressBody(body: string): ParsedProgress | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const record = asRecord(value);
  if (record == null) {
    return null;
  }

  const candidates = [record];
  for (const nestKey of ["data", "result", "payload"] as const) {
    const nested = asRecord(record[nestKey]);
    if (nested != null) {
      candidates.push(nested);
    }
  }

  for (const candidate of candidates) {
    const done = firstNumber(candidate, [
      "progress_done",
      "progressDone",
      "done",
      "completed",
      "finished",
    ]);
    const total = firstNumber(candidate, [
      "progress_total",
      "progressTotal",
      "total",
      "target",
      "goal",
    ]);
    const level = firstString(candidate, [
      "level",
      "levelName",
      "grade",
      "band",
    ]);

    if (done != null && total != null) {
      return { progress_done: done, progress_total: total, level };
    }

    const ratio = firstString(candidate, ["progress", "weekProgress", "ratio"]);
    if (ratio != null) {
      const match = ratio.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (match?.[1] != null && match[2] != null) {
        return {
          progress_done: Number(match[1]),
          progress_total: Number(match[2]),
          level,
        };
      }
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const n = Number(value.trim());
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0 && trimmed.length <= 64) {
        return trimmed;
      }
    }
  }
  return null;
}

function summarizeFailureBody(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    const record = asRecord(value);
    if (record != null) {
      const message = record.message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim().slice(0, 200);
      }
    }
  } catch {
    // fall through
  }
  return trimmed.slice(0, 200);
}
