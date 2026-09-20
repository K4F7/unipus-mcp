import {
  requireConfiguredJwt,
  type AuthPorts,
} from "./auth.js";
import {
  resolveSpeakWeekProgressUrl,
  resolveWeekProgressUrl,
} from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  okWeekProgress,
  toolError,
  type WeekProgressResult,
} from "./result.js";

/** Product weekly targets (UI 2026-09-21); not claimed as API capture. */
export const PRODUCT_LISTEN_WEEK_TOTAL = 5;
export const PRODUCT_SPEAK_WEEK_TOTAL = 3;

export type WeekProgressPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  weekProgressUrl?: string;
  /** Override; when unset, uses resolveSpeakWeekProgressUrl(env) (null if env unset). */
  speakWeekProgressUrl?: string | null;
};

export async function listWeekProgress(
  ports: WeekProgressPorts,
): Promise<WeekProgressResult> {
  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const listenUrl = ports.weekProgressUrl ?? resolveWeekProgressUrl(ports.env);
  const speakUrl =
    ports.speakWeekProgressUrl !== undefined
      ? ports.speakWeekProgressUrl
      : resolveSpeakWeekProgressUrl(ports.env);

  const authHeader = { authorization: `Bearer ${loaded.jwt}` };

  let listenResponse: { statusCode: number; body: string };
  try {
    listenResponse = await ports.http.request({
      url: listenUrl,
      method: "GET",
      headers: authHeader,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `拉取本周进度失败（网络）：${detail}`);
  }

  const listenHttpError = mapHttpError(listenResponse, "本周听力进度");
  if (listenHttpError != null) {
    return listenHttpError;
  }

  const listenParsed = parseWeekProgressBody(listenResponse.body);
  if (listenParsed == null || listenParsed.listen_done == null || listenParsed.listen_total == null) {
    return toolError(
      "PARSE_ERROR",
      "本周进度响应无法解析为 listen/progress done/total（及可选 speak_*）",
    );
  }

  let speakDone = listenParsed.speak_done;
  let speakTotal = listenParsed.speak_total;

  if (speakUrl != null && speakUrl.length > 0) {
    let speakResponse: { statusCode: number; body: string };
    try {
      speakResponse = await ports.http.request({
        url: speakUrl,
        method: "GET",
        headers: authHeader,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return toolError("NETWORK_ERROR", `拉取本周口语进度失败（网络）：${detail}`);
    }
    const speakHttpError = mapHttpError(speakResponse, "本周口语进度");
    if (speakHttpError != null) {
      return speakHttpError;
    }
    const speakParsed = parseWeekProgressBody(speakResponse.body);
    if (speakParsed?.speak_done != null && speakParsed.speak_total != null) {
      speakDone = speakParsed.speak_done;
      speakTotal = speakParsed.speak_total;
    } else if (
      speakParsed?.listen_done != null &&
      speakParsed.listen_total != null &&
      speakDone == null
    ) {
      // Speak-only endpoint may reuse generic done/total keys
      speakDone = speakParsed.listen_done;
      speakTotal = speakParsed.listen_total;
    } else if (speakDone == null) {
      return toolError(
        "PARSE_ERROR",
        "口语周进度响应无法解析为 speak_done / speak_total",
      );
    }
  }

  const listenDone = listenParsed.listen_done;
  const listenTotal = listenParsed.listen_total;
  const level = listenParsed.level;

  const speakSuffix =
    speakDone != null && speakTotal != null
      ? `；口语 ${speakDone}/${speakTotal}`
      : "；口语进度未知（未配置 UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH 且响应无 speak_*）";
  const levelSuffix = level != null ? `，级别 ${level}` : "";

  return okWeekProgress({
    message: `本周听力 ${listenDone}/${listenTotal}${speakSuffix}${levelSuffix}`,
    progress_done: listenDone,
    progress_total: listenTotal,
    level,
    listen_done: listenDone,
    listen_total: listenTotal,
    speak_done: speakDone,
    speak_total: speakTotal,
  });
}

function mapHttpError(
  response: { statusCode: number; body: string },
  label: string,
): WeekProgressResult | null {
  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null ? `${label} 401：${hint}` : `${label} 401：JWT 无效或已过期`,
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `${label} HTTP ${response.statusCode}：${hint}`
        : `${label} HTTP ${response.statusCode}`,
    );
  }
  return null;
}

type ParsedProgress = {
  listen_done: number | null;
  listen_total: number | null;
  speak_done: number | null;
  speak_total: number | null;
  level: string | null;
};

const LISTEN_DONE_KEYS = [
  "listen_done",
  "listenDone",
  "listeningDone",
  "progress_done",
  "progressDone",
  "done",
  "completed",
  "finished",
] as const;
const LISTEN_TOTAL_KEYS = [
  "listen_total",
  "listenTotal",
  "listeningTotal",
  "progress_total",
  "progressTotal",
  "total",
  "target",
  "goal",
] as const;
const SPEAK_DONE_KEYS = [
  "speak_done",
  "speakDone",
  "oralDone",
  "oral_done",
  "speakingDone",
] as const;
const SPEAK_TOTAL_KEYS = [
  "speak_total",
  "speakTotal",
  "oralTotal",
  "oral_total",
  "speakingTotal",
] as const;
const LEVEL_KEYS = ["level", "levelName", "grade", "band"] as const;
const RATIO_KEYS = ["progress", "weekProgress", "ratio"] as const;
const SPEAK_RATIO_KEYS = ["speakProgress", "oralProgress", "speak_ratio"] as const;
const NEST_KEYS = ["data", "result", "payload", "listen", "speak", "oral"] as const;

/**
 * Map stable MCP fields from known aliases until the real uls schema is captured.
 * `progress_*` aliases map into listen_*; speak_* only from speak-specific keys
 * (or ratio) so a legacy single-progress body does not invent speak counts.
 */
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

  const candidates: Record<string, unknown>[] = [record];
  for (const nestKey of NEST_KEYS) {
    const nested = asRecord(record[nestKey]);
    if (nested != null) {
      candidates.push(nested);
    }
  }

  let listenDone: number | null = null;
  let listenTotal: number | null = null;
  let speakDone: number | null = null;
  let speakTotal: number | null = null;
  let level: string | null = null;

  for (const candidate of candidates) {
    level ??= firstString(candidate, LEVEL_KEYS);

    // Prefer speak-specific keys before generic done/total on the same object
    speakDone ??= firstNumber(candidate, SPEAK_DONE_KEYS);
    speakTotal ??= firstNumber(candidate, SPEAK_TOTAL_KEYS);

    const speakRatio = firstString(candidate, SPEAK_RATIO_KEYS);
    if (speakRatio != null && (speakDone == null || speakTotal == null)) {
      const match = speakRatio.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (match?.[1] != null && match[2] != null) {
        speakDone ??= Number(match[1]);
        speakTotal ??= Number(match[2]);
      }
    }
  }

  for (const candidate of candidates) {
    // Explicit listen_* first
    const explicitListenDone = firstNumber(candidate, [
      "listen_done",
      "listenDone",
      "listeningDone",
    ]);
    const explicitListenTotal = firstNumber(candidate, [
      "listen_total",
      "listenTotal",
      "listeningTotal",
    ]);
    if (explicitListenDone != null && explicitListenTotal != null) {
      listenDone ??= explicitListenDone;
      listenTotal ??= explicitListenTotal;
      continue;
    }

    // Legacy progress / generic done+total (listen alias)
    const done = firstNumber(candidate, LISTEN_DONE_KEYS);
    const total = firstNumber(candidate, LISTEN_TOTAL_KEYS);
    // Avoid treating speak-only objects as listen when they only have speak keys
    const onlySpeak =
      firstNumber(candidate, SPEAK_DONE_KEYS) != null &&
      firstNumber(candidate, [
        "listen_done",
        "listenDone",
        "progress_done",
        "progressDone",
        "done",
      ]) == null;
    if (done != null && total != null && !onlySpeak) {
      listenDone ??= done;
      listenTotal ??= total;
      continue;
    }

    const ratio = firstString(candidate, RATIO_KEYS);
    if (ratio != null && listenDone == null) {
      const match = ratio.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (match?.[1] != null && match[2] != null) {
        listenDone = Number(match[1]);
        listenTotal = Number(match[2]);
      }
    }
  }

  if (listenDone == null || listenTotal == null) {
    // Allow speak-only parse results (used when merging a dedicated speak response)
    if (speakDone != null && speakTotal != null) {
      return {
        listen_done: null,
        listen_total: null,
        speak_done: speakDone,
        speak_total: speakTotal,
        level,
      };
    }
    return null;
  }

  return {
    listen_done: listenDone,
    listen_total: listenTotal,
    speak_done: speakDone,
    speak_total: speakTotal,
    level,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
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
  keys: readonly string[],
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
