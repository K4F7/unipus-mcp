import { UADAPTIVE_ORIGIN, UCLOUD_ORIGIN } from "./http.js";

/**
 * Default progress probe: GET activation/status on uadaptive.
 * Fields listenTrialUsed / speakTrialUsed / trialUsageLimit are **试用次数**
 * (e.g. 2/3 trials) — NOT the App card「当前进度 0/3」(那是本篇三模块 part/get),
 * and NOT the paid weekly quota (听力5 / 口语3; path still unknown).
 * Path override: UNIPUS_ULS_WEEK_PROGRESS_PATH.
 * Host: UNIPUS_ULS_ORIGIN if set, else UNIPUS_ULS_ADAPTIVE_ORIGIN / uadaptive.
 */
export const DEFAULT_ULS_WEEK_PROGRESS_PATH = "/api/uls/user/activation/status";

/**
 * Recommended speak path (same activation/status body already has speakTrialUsed).
 * Optional second fetch via UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH; unset = no 2nd request.
 */
export const RECOMMENDED_ULS_SPEAK_WEEK_PROGRESS_PATH =
  "/api/uls/user/activation/status";

/** Enter-training path from uadaptive SPA preload (2026-09-21). */
export const DEFAULT_ULS_LOAD_PAPER_PATH = "/api/uls/user/loadPaper";

export function resolveUlsOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = envTrim(env.UNIPUS_ULS_ORIGIN);
  return fromEnv != null ? fromEnv.replace(/\/+$/, "") : UCLOUD_ORIGIN;
}

export function resolveWeekProgressPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = envTrim(env.UNIPUS_ULS_WEEK_PROGRESS_PATH) ?? DEFAULT_ULS_WEEK_PROGRESS_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

/** Host for week/trial progress: UNIPUS_ULS_ORIGIN override, else adaptive. */
export function resolveWeekProgressOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = envTrim(env.UNIPUS_ULS_ORIGIN);
  if (fromEnv != null) {
    return fromEnv.replace(/\/+$/, "");
  }
  return resolveAdaptiveOrigin(env);
}

export function resolveWeekProgressUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveWeekProgressOrigin(env)}${resolveWeekProgressPath(env)}`;
}

/**
 * Speak week-progress path: optional second URL.
 * Prefer parsing speakTrialUsed (试用) from the primary activation/status response;
 * set UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH only if you need a dedicated fetch
 * (recommended value: RECOMMENDED_ULS_SPEAK_WEEK_PROGRESS_PATH).
 */
export function resolveSpeakWeekProgressPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const path = envTrim(env.UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH);
  if (path == null) {
    return null;
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveSpeakWeekProgressUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const path = resolveSpeakWeekProgressPath(env);
  if (path == null) {
    return null;
  }
  return `${resolveWeekProgressOrigin(env)}${path}`;
}

/** H5 training APIs live on uadaptive; override with UNIPUS_ULS_ADAPTIVE_ORIGIN. */
export function resolveAdaptiveOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = envTrim(env.UNIPUS_ULS_ADAPTIVE_ORIGIN);
  return fromEnv != null ? fromEnv.replace(/\/+$/, "") : UADAPTIVE_ORIGIN;
}

export function resolveLoadPaperPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_LOAD_PAPER_PATH) ?? DEFAULT_ULS_LOAD_PAPER_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveLoadPaperUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveAdaptiveOrigin(env)}${resolveLoadPaperPath(env)}`;
}

function envTrim(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : null;
}

/** SPA-confirmed silent upload credential endpoint (2026-09-21). */
export const DEFAULT_ULS_QUERY_UPLOAD_URL_PATH =
  "/api/uls/user/answer/query-upload-url";

export function resolveQueryUploadUrlPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_QUERY_UPLOAD_URL_PATH) ??
    DEFAULT_ULS_QUERY_UPLOAD_URL_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveQueryUploadUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveAdaptiveOrigin(env)}${resolveQueryUploadUrlPath(env)}`;
}

/** SPA-confirmed submit path (2026-09-21 live). */
export const DEFAULT_ULS_SUBMIT_ANSWER_PATH = "/api/uls/user/submitAnswer";

export function resolveSubmitAnswerPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_SUBMIT_ANSWER_PATH) ?? DEFAULT_ULS_SUBMIT_ANSWER_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveSubmitAnswerUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveAdaptiveOrigin(env)}${resolveSubmitAnswerPath(env)}`;
}
