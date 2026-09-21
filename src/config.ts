import { UADAPTIVE_ORIGIN, UCLOUD_ORIGIN } from "./http.js";

/**
 * Legacy single-GET progress probe (trial accounts): activation/status.
 * Paid default for list_week_progress is getUserStatusForApp (see
 * resolveUserStatusForAppUrl). Set UNIPUS_ULS_WEEK_PROGRESS_PATH or
 * ports.weekProgressUrl to force this legacy GET.
 * Host: UNIPUS_ULS_ORIGIN if set, else UNIPUS_ULS_ADAPTIVE_ORIGIN / uadaptive.
 */
export const DEFAULT_ULS_WEEK_PROGRESS_PATH = "/api/uls/user/activation/status";

/** Paid listen week: getUserStatus?flowType=listen → taskId for trainingReport. */
export const DEFAULT_ULS_USER_STATUS_PATH = "/api/uls/user/getUserStatus";

/**
 * Homepage 本周计数 / 达标数 for listen and speak.
 * GET on ucloud: weekDoneTaskCount / weekFrequency. flowType=listen|speak.
 */
export const DEFAULT_ULS_USER_STATUS_FOR_APP_PATH =
  "/api/uls/user/getUserStatusForApp";

/** Paid listen week report (verified): weeklyCompleted / weeklyTarget / weeklyProgress. */
export const DEFAULT_ULS_LISTEN_TRAINING_REPORT_PATH =
  "/api/uls/report/listen/trainingReport";

/** Product paid listen weekly quota (used when report returns weeklyTarget<=0). */
export const PAID_LISTEN_WEEK_TARGET = 5;

/**
 * Recommended speak path (activation/status may carry speakTrialUsed on trial).
 * Optional second fetch via UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH; unset = no 2nd request.
 * Paid speak week path is still unverified — leave speak_* null rather than invent 3.
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

/** True when caller set UNIPUS_ULS_WEEK_PROGRESS_PATH (legacy single-GET mode). */
export function hasExplicitWeekProgressPath(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envTrim(env.UNIPUS_ULS_WEEK_PROGRESS_PATH) != null;
}

export function resolveUserStatusPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_USER_STATUS_PATH) ?? DEFAULT_ULS_USER_STATUS_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveUserStatusForAppPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_USER_STATUS_FOR_APP_PATH) ??
    DEFAULT_ULS_USER_STATUS_FOR_APP_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

/** GET getUserStatusForApp?flowType=listen|speak on ucloud (UNIPUS_ULS_ORIGIN). */
export function resolveUserStatusForAppUrl(
  env: NodeJS.ProcessEnv = process.env,
  flowType: "listen" | "speak",
): string {
  const base = `${resolveUlsOrigin(env)}${resolveUserStatusForAppPath(env)}`;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}flowType=${encodeURIComponent(flowType)}`;
}

/** GET getUserStatus?flowType=listen|speak on adaptive host. */
export function resolveUserStatusUrl(
  env: NodeJS.ProcessEnv = process.env,
  flowType: "listen" | "speak" = "listen",
): string {
  const base = `${resolveWeekProgressOrigin(env)}${resolveUserStatusPath(env)}`;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}flowType=${encodeURIComponent(flowType)}`;
}

export function resolveListenTrainingReportPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_LISTEN_TRAINING_REPORT_PATH) ??
    DEFAULT_ULS_LISTEN_TRAINING_REPORT_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveListenTrainingReportUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveWeekProgressOrigin(env)}${resolveListenTrainingReportPath(env)}`;
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

/** SPA grade-before-submit path (2026-09-21). */
export const DEFAULT_ULS_GRADE_QUESTION_PATH = "/api/uls/rate/gradeQuestion";

export function resolveGradeQuestionPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_GRADE_QUESTION_PATH) ??
    DEFAULT_ULS_GRADE_QUESTION_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveGradeQuestionUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveAdaptiveOrigin(env)}${resolveGradeQuestionPath(env)}`;
}

/** Read graded results after submit (2026-09-21 device). Not an MCP tool yet. */
export const DEFAULT_ULS_LOAD_GRADED_QUESTIONS_PATH =
  "/api/uls/user/loadGradedQuestions";

export function resolveLoadGradedQuestionsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    envTrim(env.UNIPUS_ULS_LOAD_GRADED_QUESTIONS_PATH) ??
    DEFAULT_ULS_LOAD_GRADED_QUESTIONS_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveLoadGradedQuestionsUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveAdaptiveOrigin(env)}${resolveLoadGradedQuestionsPath(env)}`;
}

/** Clio / speech.unipus.cn WSS (prod business path — NOT bare /wss). */
export const DEFAULT_CLIO_WSS_URL =
  "wss://speech.unipus.cn/speech/proxy/wss";

/**
 * SPA phoneme-helper defaults hardcoded in mobile/core.js
 * (`applicationId` + `secret` for getSig). Production apps may rotate
 * engineKey/engineSecret via SOE `initialize/v2`; override with env.
 */
export const DEFAULT_CLIO_APPLICATION_ID = "162787294610001";
export const DEFAULT_CLIO_SECRET =
  "8da79f23cff822c84a64d231fa5f7e28c5319896";

export function resolveClioWssUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envTrim(env.UNIPUS_CLIO_WSS_URL) ?? DEFAULT_CLIO_WSS_URL;
}

/**
 * Prefer UNIPUS_CLIO_APP_ID + UNIPUS_CLIO_APP_SECRET when both set;
 * otherwise null (caller falls back to SPA phoneme pair).
 */
export function resolveClioCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { applicationId: string; secret: string } | null {
  const applicationId = envTrim(env.UNIPUS_CLIO_APP_ID);
  const secret = envTrim(env.UNIPUS_CLIO_APP_SECRET);
  if (applicationId == null || secret == null) {
    return null;
  }
  return { applicationId, secret };
}
