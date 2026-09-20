/**
 * Local JWT payload helpers — decode only, never verify signatures.
 * Used for coarse expiry and safe user-id extraction.
 */

export type JwtPayload = Record<string, unknown>;

export function decodeJwtPayload(token: string): JwtPayload | null {
  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payloadPart = parts[1];
  if (payloadPart == null || payloadPart.length === 0) {
    return null;
  }
  try {
    const json = Buffer.from(payloadPart, "base64url").toString("utf8");
    const value: unknown = JSON.parse(json);
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * @returns true if expired, false if still valid, null if exp missing/unreadable
 */
export function isPayloadExpired(
  payload: JwtPayload | null,
  now: Date = new Date(),
): boolean | null {
  if (payload == null) {
    return null;
  }
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }
  return exp * 1000 <= now.getTime();
}

export function isJwtExpired(token: string, now: Date = new Date()): boolean | null {
  return isPayloadExpired(decodeJwtPayload(token), now);
}

export function expiresAtFromPayload(payload: JwtPayload | null): string | null {
  if (payload == null) {
    return null;
  }
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }
  return new Date(exp * 1000).toISOString();
}

/** Prefer opaque openId-like ids; never return nested objects or secrets. */
export function safeUserIdFromPayload(payload: JwtPayload | null): string | null {
  if (payload == null) {
    return null;
  }
  for (const key of ["openId", "openid", "user", "userId", "uid", "sub"] as const) {
    const value = payload[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0 && trimmed.length <= 128) {
        return trimmed;
      }
    }
  }
  return null;
}
