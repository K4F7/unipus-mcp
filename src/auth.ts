import type { JwtCredentialStore } from "./credentials.js";
import { UCLOUD_ORIGIN, type UnipusHttp } from "./http.js";
import {
  decodeJwtPayload,
  expiresAtFromPayload,
  isPayloadExpired,
  safeUserIdFromPayload,
} from "./jwt.js";
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
    const hint = summarizeAuthFailureBody(response.body);
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

function summarizeAuthFailureBody(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim().slice(0, 200);
      }
    }
  } catch {
    // fall through to raw body snippet
  }
  return trimmed.slice(0, 200);
}
