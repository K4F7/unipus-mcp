import { UADAPTIVE_ORIGIN, UCLOUD_ORIGIN } from "./http.js";

/**
 * Default ULS week-progress path until mitm capture fills the real subpath.
 * Override with UNIPUS_ULS_WEEK_PROGRESS_PATH; base with UNIPUS_ULS_ORIGIN.
 * Capture later should only need to change this constant (or the env).
 */
export const DEFAULT_ULS_WEEK_PROGRESS_PATH = "/api/uls/week-progress";

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

export function resolveWeekProgressUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveUlsOrigin(env)}${resolveWeekProgressPath(env)}`;
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
