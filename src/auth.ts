import type { JwtCredentialStore } from "./credentials.js";
import { UCLOUD_ORIGIN, type UnipusHttp } from "./http.js";
import {
  decodeJwtPayload,
  expiresAtFromPayload,
  isPayloadExpired,
  safeUserIdFromPayload,
} from "./jwt.js";
import { summarizeHttpErrorBody } from "./http-body.js";
import { requireConfiguredJwt } from "./require-jwt.js";
import { authRequired, okAuthStatus, type AuthStatusResult } from "./result.js";

/** Any `/api/uls/*` path hits the JWT gate (401 Missing JWT without token). */
export const AUTH_PROBE_URL = `${UCLOUD_ORIGIN}/api/uls/`;

export type AuthPorts = {
  credentials: JwtCredentialStore;
  http: UnipusHttp;
  now?: () => Date;
};

type AuthMeta = {
  expired: boolean;
  expiresAt: string | null;
  userId: string | null;
};

export async function probeAuthStatus(ports: AuthPorts): Promise<AuthStatusResult> {
  const now = ports.now?.() ?? new Date();

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }
  const { jwt } = loaded;

  const payload = decodeJwtPayload(jwt);
  const meta: AuthMeta = {
    userId: safeUserIdFromPayload(payload),
    expired: isPayloadExpired(payload, now) === true,
    expiresAt: expiresAtFromPayload(payload),
  };

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url: AUTH_PROBE_URL,
      method: "GET",
      headers: {
        authorization: `Bearer ${jwt}`,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return withMeta(authRequired(`探活失败：${detail}`), meta);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return withMeta(
      authRequired(
        hint != null ? `uls 探活 401：${hint}` : "uls 探活 401：JWT 无效或已过期",
      ),
      meta,
    );
  }

  // Non-401 (incl. 404 Route Not Found) means the JWT gate accepted the token.
  return okAuthStatus({
    message: "JWT 可用（uls 网关已接受）。",
    expired: meta.expired,
    expiresAt: meta.expiresAt,
    userId: meta.userId,
    probeStatusCode: response.statusCode,
  });
}

function withMeta(result: AuthStatusResult, meta: AuthMeta): AuthStatusResult {
  return {
    ...result,
    expired: meta.expired,
    expiresAt: meta.expiresAt,
    userId: meta.userId,
  };
}

