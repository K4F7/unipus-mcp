import { UCLOUD_ORIGIN } from "./http.js";

/**
 * Default ULS week-progress path until mitm capture fills the real subpath.
 * Override with UNIPUS_ULS_WEEK_PROGRESS_PATH; base with UNIPUS_ULS_ORIGIN.
 * Capture later should only need to change this constant (or the env).
 */
export const DEFAULT_ULS_WEEK_PROGRESS_PATH = "/api/uls/week-progress";

export function resolveUlsOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.UNIPUS_ULS_ORIGIN?.trim();
  if (fromEnv != null && fromEnv.length > 0) {
    return fromEnv.replace(/\/+$/, "");
  }
  return UCLOUD_ORIGIN;
}

export function resolveWeekProgressPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.UNIPUS_ULS_WEEK_PROGRESS_PATH?.trim();
  const path =
    fromEnv != null && fromEnv.length > 0
      ? fromEnv
      : DEFAULT_ULS_WEEK_PROGRESS_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

export function resolveWeekProgressUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveUlsOrigin(env)}${resolveWeekProgressPath(env)}`;
}
