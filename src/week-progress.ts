import {
  requireConfiguredJwt,
  type AuthPorts,
} from "./auth.js";
import {
  hasExplicitWeekProgressPath,
  resolveSpeakWeekProgressUrl,
  resolveUserStatusForAppUrl,
  resolveWeekProgressUrl,
} from "./config.js";
import { summarizeHttpErrorBody, type UnipusHttpResponse } from "./http.js";
import {
  authRequired,
  okWeekProgress,
  toolError,
  type WeekProgressResult,
} from "./result.js";

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

  // uadaptive rejects "Bearer " prefix (same as loadPaper).
  const authHeader = { authorization: loaded.jwt };
  const speakUrl =
    ports.speakWeekProgressUrl !== undefined
      ? ports.speakWeekProgressUrl
      : resolveSpeakWeekProgressUrl(ports.env);

  const useLegacy =
    ports.weekProgressUrl != null || hasExplicitWeekProgressPath(ports.env);

  if (useLegacy) {
    return listWeekProgressLegacy(ports, authHeader, speakUrl);
  }

  return listWeekProgressPaid(ports, authHeader);
}

/** Legacy single-GET (trial / explicit UNIPUS_ULS_WEEK_PROGRESS_PATH / weekProgressUrl). */
async function listWeekProgressLegacy(
  ports: WeekProgressPorts,
  authHeader: Record<string, string>,
  speakUrl: string | null,
): Promise<WeekProgressResult> {
  const listenUrl = ports.weekProgressUrl ?? resolveWeekProgressUrl(ports.env);
  const listenFetch = await fetchProgress(ports, listenUrl, authHeader, "进度");
  if (!listenFetch.ok) {
    return listenFetch.error;
  }

  const listenParsed = parseWeekProgressBody(listenFetch.body);
  if (listenParsed?.listen_done == null || listenParsed.listen_total == null) {
    return toolError(
      "PARSE_ERROR",
      "进度响应无法解析为 listen/progress done/total（及可选 speak_*）",
    );
  }

  let speakDone = listenParsed.speak_done;
  let speakTotal = listenParsed.speak_total;

  if (speakUrl != null && speakUrl.length > 0) {
    const speakFetch = await fetchProgress(
      ports,
      speakUrl,
      authHeader,
      "口语进度",
    );
    if (!speakFetch.ok) {
      // Optional speak path: soft-fail → leave speak null (do not invent 3).
      speakDone = null;
      speakTotal = null;
    } else {
      const merged = mergeSpeakCounts(
        speakDone,
        speakTotal,
        parseWeekProgressBody(speakFetch.body),
      );
      if (merged == null) {
        speakDone = null;
        speakTotal = null;
      } else {
        speakDone = merged.done;
        speakTotal = merged.total;
      }
    }
  }

  return buildWeekProgressResult({
    listenDone: listenParsed.listen_done,
    listenTotal: listenParsed.listen_total,
    speakDone,
    speakTotal,
    level: listenParsed.level,
    source: detectProgressSource(listenFetch.body, listenParsed),
  });
}

/**
 * Paid default: GET getUserStatusForApp for listen and speak.
 * 本周计数 = weekDoneTaskCount. 达标数 = weekFrequency.
 */
async function listWeekProgressPaid(
  ports: WeekProgressPorts,
  authHeader: Record<string, string>,
): Promise<WeekProgressResult> {
  const listenUrl = resolveUserStatusForAppUrl(ports.env, "listen");
  const speakUrl = resolveUserStatusForAppUrl(ports.env, "speak");

  const listenFetch = await fetchProgress(ports, listenUrl, authHeader, "听力本周");
  if (!listenFetch.ok) {
    return listenFetch.error;
  }
  const listenWeek = weekCountsFromStatusForApp(listenFetch.body);
  if (listenWeek == null) {
    return toolError(
      "PARSE_ERROR",
      "听力 getUserStatusForApp 无法解析 weekDoneTaskCount / weekFrequency",
    );
  }

  const speakFetch = await fetchProgress(ports, speakUrl, authHeader, "口语本周");
  if (!speakFetch.ok) {
    return speakFetch.error;
  }
  const speakWeek = weekCountsFromStatusForApp(speakFetch.body);
  if (speakWeek == null) {
    return toolError(
      "PARSE_ERROR",
      "口语 getUserStatusForApp 无法解析 weekDoneTaskCount / weekFrequency",
    );
  }

  return buildWeekProgressResult({
    listenDone: listenWeek.done,
    listenTotal: listenWeek.total,
    speakDone: speakWeek.done,
    speakTotal: speakWeek.total,
    level: listenWeek.level ?? speakWeek.level,
    source: "paid",
  });
}

function buildWeekProgressResult(input: {
  listenDone: number;
  listenTotal: number;
  speakDone: number | null;
  speakTotal: number | null;
  level: string | null;
  source: "trial" | "paid" | "generic";
  speakIsTrial?: boolean;
}): WeekProgressResult {
  const trialLike = input.source === "trial";
  const listenLabel = trialLike ? "本周试用听力" : "听力";
  const speakTrial = input.speakIsTrial === true || trialLike;
  const speakLabel = speakTrial ? "本周试用口语" : "口语";
  const speakSuffix =
    input.speakDone != null && input.speakTotal != null
      ? `；${speakLabel} ${input.speakDone}/${input.speakTotal}`
      : input.source === "paid"
        ? "；口语进度未知（付费口语周 path 未验证）"
        : trialLike
          ? "；本周试用口语未知（activation/status 无 speakTrialUsed 且未配置 SPEAK 路径）"
          : "；口语进度未知（响应无 speak_* 且未配置 SPEAK 路径）";
  const levelSuffix = input.level != null ? `，级别 ${input.level}` : "";
  const sourceNote =
    input.source === "paid"
      ? "（本周计数 weekDoneTaskCount / 达标数 weekFrequency）"
      : input.source === "trial"
        ? "（试用账号已对齐 tvWeekProgress）"
        : "";

  return okWeekProgress({
    message: `${listenLabel} ${input.listenDone}/${input.listenTotal}${speakSuffix}${levelSuffix}${sourceNote}`,
    level: input.level,
    listen_done: input.listenDone,
    listen_total: input.listenTotal,
    speak_done: input.speakDone,
    speak_total: input.speakTotal,
  });
}

function detectProgressSource(
  body: string,
  parsed: ParsedProgress,
): "trial" | "paid" | "generic" {
  const hasTrialValues =
    parsed.speak_done != null ||
    (parsed.listen_done != null &&
      /"listenTrialUsed"\s*:\s*\d/.test(body));
  if (hasTrialValues || /"listenTrialUsed"\s*:\s*\d/.test(body)) {
    return "trial";
  }
  if (/weeklyCompleted|weeklyTarget|weeklyProgress/.test(body)) {
    return "paid";
  }
  return "generic";
}

/** Homepage week pair. Ignores weekTotalTaskCount so it cannot be mistaken for 达标数. */
function weekCountsFromStatusForApp(body: string): {
  done: number;
  total: number;
  level: string | null;
} | null {
  const record = parseJsonRecord(body);
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
  for (const candidate of candidates) {
    const done = firstNumber(candidate, ["weekDoneTaskCount"]);
    const total = firstNumber(candidate, ["weekFrequency"]);
    if (done == null || total == null || done < 0 || total < 0) {
      continue;
    }
    const level =
      firstString(candidate, ["currentLevel", "level", "levelName"]) ?? null;
    return { done, total, level };
  }
  return null;
}

async function fetchProgress(
  ports: WeekProgressPorts,
  url: string,
  headers: Record<string, string>,
  label: string,
  init?: { method?: "GET" | "POST"; body?: string },
): Promise<{ ok: true; body: string } | { ok: false; error: WeekProgressResult }> {
  let response: UnipusHttpResponse;
  try {
    response = await ports.http.request({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: toolError("NETWORK_ERROR", `拉取${label}失败（网络）：${detail}`),
    };
  }
  const mapped = mapHttpError(response, label);
  if (mapped != null) {
    return { ok: false, error: mapped };
  }
  return { ok: true, body: response.body };
}

function mergeSpeakCounts(
  existingDone: number | null,
  existingTotal: number | null,
  speakParsed: ParsedProgress | null,
): { done: number; total: number } | null {
  if (speakParsed?.speak_done != null && speakParsed.speak_total != null) {
    return { done: speakParsed.speak_done, total: speakParsed.speak_total };
  }
  // Speak-only endpoint may reuse generic done/total keys (parsed as listen_*).
  if (
    existingDone == null &&
    speakParsed?.listen_done != null &&
    speakParsed.listen_total != null
  ) {
    return { done: speakParsed.listen_done, total: speakParsed.listen_total };
  }
  if (existingDone != null && existingTotal != null) {
    return { done: existingDone, total: existingTotal };
  }
  return null;
}

function mapHttpError(
  response: UnipusHttpResponse,
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

const EXPLICIT_LISTEN_DONE = [
  "listen_done",
  "listenDone",
  "listeningDone",
  "listenTrialUsed",
] as const;
const EXPLICIT_LISTEN_TOTAL = [
  "listen_total",
  "listenTotal",
  "listeningTotal",
  "listenTrialLimit",
] as const;
const LEGACY_DONE = [
  "progress_done",
  "progressDone",
  "done",
  "completed",
  "finished",
  "weeklyCompleted",
] as const;
const LEGACY_TOTAL = [
  "progress_total",
  "progressTotal",
  "total",
  "target",
  "goal",
  "weeklyTarget",
  "trialUsageLimit",
] as const;
const SPEAK_DONE_KEYS = [
  "speak_done",
  "speakDone",
  "oralDone",
  "oral_done",
  "speakingDone",
  "speakTrialUsed",
] as const;
const SPEAK_TOTAL_KEYS = [
  "speak_total",
  "speakTotal",
  "oralTotal",
  "oral_total",
  "speakingTotal",
  "speakTrialLimit",
] as const;
/** Shared trial cap from activation/status (applies to both listen + speak). */
const TRIAL_LIMIT_KEYS = ["trialUsageLimit"] as const;
const LEVEL_KEYS = ["level", "levelName", "grade", "band"] as const;
const RATIO_KEYS = ["progress", "weekProgress", "ratio"] as const;
const SPEAK_RATIO_KEYS = ["speakProgress", "oralProgress", "speak_ratio"] as const;
const NEST_KEYS = ["data", "result", "payload", "value", "listen", "speak", "oral"] as const;

/**
 * Map stable MCP fields from known aliases.
 * - Paid default path uses getUserStatusForApp weekDoneTaskCount / weekFrequency.
 * - activation/status trial counters (listenTrialUsed / speakTrialUsed / trialUsageLimit) are
 *   optional (trial accounts only); null values must not alone cause PARSE_ERROR on paid path.
 * - Legacy progress_* / generic done+total map to listen_*; speak_* only from
 *   speak-specific keys so a single-progress body does not invent speak counts.
 */
export function parseWeekProgressBody(body: string): ParsedProgress | null {
  const record = parseJsonRecord(body);
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
    speakDone ??= firstNumber(candidate, SPEAK_DONE_KEYS);
    speakTotal ??= firstNumber(candidate, SPEAK_TOTAL_KEYS);

    const speakRatio = parseRatio(firstString(candidate, SPEAK_RATIO_KEYS));
    if (speakRatio != null) {
      speakDone ??= speakRatio.done;
      speakTotal ??= speakRatio.total;
    }

    const trialLimit = firstNumber(candidate, TRIAL_LIMIT_KEYS);
    if (trialLimit != null) {
      // activation/status: one cap for both trial flows
      if (speakDone != null) {
        speakTotal ??= trialLimit;
      }
      // also available as listen total when listenTrialUsed present
    }

    const explicitDone = firstNumber(candidate, EXPLICIT_LISTEN_DONE);
    const explicitTotal =
      firstNumber(candidate, EXPLICIT_LISTEN_TOTAL) ?? trialLimit;
    if (explicitDone != null && explicitTotal != null) {
      listenDone ??= explicitDone;
      listenTotal ??= explicitTotal;
      if (speakDone != null) {
        speakTotal ??= trialLimit ?? speakTotal;
      }
      continue;
    }

    const legacyDone = firstNumber(candidate, LEGACY_DONE);
    const legacyTotal = firstNumber(candidate, LEGACY_TOTAL);
    const speakOnly =
      firstNumber(candidate, SPEAK_DONE_KEYS) != null &&
      firstNumber(candidate, [...EXPLICIT_LISTEN_DONE, ...LEGACY_DONE]) == null;
    if (legacyDone != null && legacyTotal != null && !speakOnly) {
      listenDone ??= legacyDone;
      listenTotal ??= legacyTotal;
      continue;
    }

    const ratio = parseRatio(firstString(candidate, RATIO_KEYS));
    if (ratio != null && listenDone == null) {
      listenDone = ratio.done;
      listenTotal = ratio.total;
    }
  }

  if (listenDone != null && listenTotal != null) {
    return {
      listen_done: listenDone,
      listen_total: listenTotal,
      speak_done: speakDone,
      speak_total: speakTotal,
      level,
    };
  }
  // Speak-only parse (dedicated speak response merge).
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

function parseJsonRecord(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function parseRatio(value: string | null): { done: number; total: number } | null {
  if (value == null) {
    return null;
  }
  const match = value.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (match?.[1] == null || match[2] == null) {
    return null;
  }
  return { done: Number(match[1]), total: Number(match[2]) };
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
