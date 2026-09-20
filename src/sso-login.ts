/**
 * Unipus SSO password login (AES-CBC encrypt + cip/login).
 * Username/password stay in env / CLI argv — never MCP tool args.
 */
import { createCipheriv } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { defaultJwtFilePath } from "./credentials.js";

/** Public AES key/IV from sso.unipus.cn helper.js (not a credential secret). */
const SSO_AES_KEY_HEX = "8AD70B641C024C7ADA2ECD082EC0334F";
const SSO_AES_IV_HEX = "0102030405060708090A0B0C0D0E0F10";

export const DEFAULT_SSO_ORIGIN = "https://sso.unipus.cn";
export const DEFAULT_SSO_CIP_LOGIN_PATH = "/sso/0.1/sso/cip/login";
export const DEFAULT_SSO_SERVICE = "https://ucloud.unipus.cn/";

export function encryptSsoField(plain: string): string {
  const key = Buffer.from(SSO_AES_KEY_HEX, "hex");
  const iv = Buffer.from(SSO_AES_IV_HEX, "hex");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return enc.toString("hex").toUpperCase();
}

export type SsoLoginInput = {
  username: string;
  password: string;
  /** CAS service URL; default ucloud portal. */
  service?: string;
};

export type SsoLoginOk = {
  ok: true;
  jwt: string;
  refreshToken: string | null;
  serviceTicket: string | null;
  jwtExpire: unknown;
};

export type SsoLoginErr = {
  ok: false;
  code: string;
  message: string;
  /** SSO business code when present (e.g. 1506 = captcha needed). */
  ssoCode?: string;
};

export type SsoLoginResult = SsoLoginOk | SsoLoginErr;

export type SsoLoginPorts = {
  fetch?: typeof fetch;
  ssoOrigin?: string;
  loginPath?: string;
};

export async function loginWithPassword(
  input: SsoLoginInput,
  ports: SsoLoginPorts = {},
): Promise<SsoLoginResult> {
  const username = input.username.trim();
  const password = input.password;
  if (username.length === 0) {
    return { ok: false, code: "INVALID_ARGUMENT", message: "username 不能为空" };
  }
  if (password.length === 0) {
    return { ok: false, code: "INVALID_ARGUMENT", message: "password 不能为空" };
  }

  const origin = (ports.ssoOrigin ?? DEFAULT_SSO_ORIGIN).replace(/\/+$/, "");
  const path = ports.loginPath ?? DEFAULT_SSO_CIP_LOGIN_PATH;
  const url = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  const service = input.service?.trim() || DEFAULT_SSO_SERVICE;

  const body = JSON.stringify({
    service,
    username: encryptSsoField(username),
    password: encryptSsoField(password),
  });

  const fetchImpl = ports.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        referer: `${origin}/sso/login`,
        "user-agent": "unipus-mcp/0.1 sso-login",
      },
      body,
      redirect: "manual",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: `SSO 登录网络失败：${detail}`,
    };
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `SSO 响应非 JSON（HTTP ${response.status}）`,
    };
  }

  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: "PARSE_ERROR", message: "SSO 响应结构异常" };
  }

  const record = data as Record<string, unknown>;
  const code = record.code != null ? String(record.code) : "";
  if (code === "1506") {
    return {
      ok: false,
      code: "CAPTCHA_REQUIRED",
      ssoCode: "1506",
      message: "SSO 要求极验验证码，请用浏览器登录一次或稍后再试",
    };
  }
  if (code !== "0") {
    const msg =
      typeof record.msg === "string" && record.msg.trim().length > 0
        ? record.msg.trim()
        : typeof record.error === "string"
          ? record.error
          : `SSO 登录失败 code=${code || "?"}`;
    return {
      ok: false,
      code: "SSO_LOGIN_FAILED",
      ssoCode: code || undefined,
      message: msg,
    };
  }

  const rs = record.rs;
  if (rs == null || typeof rs !== "object" || Array.isArray(rs)) {
    return { ok: false, code: "PARSE_ERROR", message: "SSO 成功响应缺少 rs" };
  }
  const rsRec = rs as Record<string, unknown>;
  const jwt = typeof rsRec.jwt === "string" ? rsRec.jwt.trim() : "";
  if (jwt.length === 0) {
    return { ok: false, code: "PARSE_ERROR", message: "SSO 成功响应缺少 jwt" };
  }

  return {
    ok: true,
    jwt,
    refreshToken: typeof rsRec.rt === "string" ? rsRec.rt : null,
    serviceTicket:
      typeof rsRec.serviceTicket === "string" ? rsRec.serviceTicket : null,
    jwtExpire: rsRec.jwtExpire ?? null,
  };
}

export async function saveJwtToDefaultPath(
  jwt: string,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<string> {
  const path = defaultJwtFilePath(options.env, options.home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${jwt}\n`, { mode: 0o600 });
  return path;
}
