import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  accountDir,
  defaultConfigDir,
  readActiveAccountId,
} from "./accounts.js";

export type JwtCredentialStore = {
  getJwt(): Promise<string | null>;
};

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function defaultJwtFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(defaultConfigDir(env, home), "jwt");
}

export function defaultRtFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(defaultConfigDir(env, home), "rt");
}

/** Pull a JWT out of raw text, Cookie header, or portal JSON — never passwords. */
export function extractJwtFromText(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  const bearer = text.match(/^Bearer\s+(\S+)/i);
  if (bearer?.[1]) {
    return normalizeJwtCandidate(bearer[1]);
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    const fromJson = extractJwtFromJson(text);
    if (fromJson != null) {
      return fromJson;
    }
  }

  const cookieMatch = text.match(/(?:^|[;\s])jwt=([^;\s]+)/i);
  if (cookieMatch?.[1]) {
    try {
      return normalizeJwtCandidate(decodeURIComponent(cookieMatch[1]));
    } catch {
      return normalizeJwtCandidate(cookieMatch[1]);
    }
  }

  return normalizeJwtCandidate(text);
}

function extractJwtFromJson(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const tokenInfo = record.tokenInfo;
    if (tokenInfo != null && typeof tokenInfo === "object" && !Array.isArray(tokenInfo)) {
      const jwt = (tokenInfo as Record<string, unknown>).jwt;
      if (typeof jwt === "string") {
        return normalizeJwtCandidate(jwt);
      }
    }
    for (const key of ["jwt", "Authorization", "authorization"] as const) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        const extracted = extractJwtFromText(candidate);
        if (extracted != null) {
          return extracted;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeJwtCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/^Bearer\s+/i, "");
  if (trimmed.length === 0) {
    return null;
  }
  if (!JWT_SHAPE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Fixed JWT store for multi-account grind without touching active-account.txt. */
export function createStaticJwtStore(jwt: string): JwtCredentialStore {
  const token = jwt.trim();
  return {
    async getJwt() {
      return token.length > 0 ? token : null;
    },
  };
}

export function createEnvCredentialStore(options: {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  readFile?: (path: string) => Promise<string>;
} = {}): JwtCredentialStore {
  const env = options.env ?? process.env;
  const home = options.homedir ?? homedir();
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));

  return {
    async getJwt() {
      const fromEnv = env.UNIPUS_JWT?.trim();
      if (fromEnv != null && fromEnv.length > 0) {
        const jwt = extractJwtFromText(fromEnv);
        if (jwt != null) {
          return jwt;
        }
      }

      const explicitPaths = [
        env.UNIPUS_JWT_FILE?.trim(),
        env.UNIPUS_COOKIE_FILE?.trim(),
      ].filter((p): p is string => p != null && p.length > 0);

      for (const path of explicitPaths) {
        const jwt = await readJwtFile(path, read);
        if (jwt != null) {
          return jwt;
        }
      }

      const fromCookieEnv = env.UNIPUS_COOKIE?.trim();
      if (fromCookieEnv != null && fromCookieEnv.length > 0) {
        const jwt = extractJwtFromText(fromCookieEnv);
        if (jwt != null) {
          return jwt;
        }
      }

      // Multi-account: active-account.txt → accounts/<id>/jwt
      const activeId = await readActiveAccountId({
        env,
        home,
        readFile: async (path) => read(path),
      });
      if (activeId != null) {
        const accountJwt = await readJwtFile(
          join(accountDir(activeId, env, home), "jwt"),
          read,
        );
        if (accountJwt != null) {
          return accountJwt;
        }
      }

      // Legacy single-account file
      return readJwtFile(defaultJwtFilePath(env, home), read);
    },
  };
}

async function readJwtFile(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    const raw = await read(path);
    return extractJwtFromText(raw);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
