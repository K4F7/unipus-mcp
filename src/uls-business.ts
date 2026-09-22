import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import { resolveUAppId } from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  toolError,
  type ToolResult,
} from "./result.js";
import { parseJsonPreservingLargeInts } from "./safe-json.js";

/**
 * Shared ULS business-body parse + authed JSON request for conversation/ebcp
 * (success code=200) and part/submit (success code=1).
 */

export function numericCode(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type ParseBusinessBodyOk = {
  ok: true;
  data: unknown;
  raw_code: number | null;
};

export type ParseBusinessBodyErr = {
  ok: false;
  kind: "parse" | "business";
  raw_code: number | null;
  msg?: string;
};

/**
 * Single JSON.parse per success path. Returns ok/data when `code === successCode`,
 * business error when JSON is valid but code mismatches, parse error otherwise.
 */
export function parseBusinessBody(
  body: string,
  opts: {
    successCode: number;
    /** Prefer these keys in order for the payload (default data then value). */
    dataKeys?: Array<"data" | "value">;
  },
): ParseBusinessBodyOk | ParseBusinessBodyErr {
  let value: unknown;
  try {
    value = parseJsonPreservingLargeInts(body);
  } catch {
    return { ok: false, kind: "parse", raw_code: null };
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, kind: "parse", raw_code: null };
  }
  const root = value as Record<string, unknown>;
  const code = numericCode(root.code);
  const msg =
    typeof root.msg === "string"
      ? root.msg
      : typeof root.message === "string"
        ? root.message
        : undefined;
  if (code == null) {
    return { ok: false, kind: "parse", raw_code: null, msg };
  }
  if (code !== opts.successCode) {
    return { ok: false, kind: "business", raw_code: code, msg };
  }
  const keys = opts.dataKeys ?? ["data", "value"];
  const primary = root[keys[0] ?? "data"];
  const secondary = keys[1] != null ? root[keys[1]] : undefined;
  const data = primary ?? secondary ?? null;
  return { ok: true, data, raw_code: code };
}

/** App WebView headers for conversation / ebcp on ucloud. */
export function ulsCloudHeaders(
  jwt: string,
  env?: NodeJS.ProcessEnv,
  openId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: jwt,
    "content-type": "application/json",
    sourceid: resolveUAppId(env),
    "x-requested-with": "cn.unipus.cloud",
  };
  const oid = openId?.trim();
  if (oid != null && oid.length > 0) {
    headers.openId = oid;
  }
  return headers;
}

export type UlsAuthedJsonOk = {
  ok: true;
  data: unknown;
  raw_code: number | null;
};

export type UlsAuthedJsonErr = {
  ok: false;
  result: ToolResult;
};

/**
 * Shared authed JSON request used by conversation/ebcp and part/submit.
 * One business-body parse on the success path.
 */
export async function ulsAuthedJsonRequest(
  ports: AuthPorts,
  opts: {
    label: string;
    url: string;
    method: "GET" | "POST";
    headers: (jwt: string) => Record<string, string>;
    jsonBody?: Record<string, unknown>;
    successCode: number;
    dataKeys?: Array<"data" | "value">;
  },
): Promise<UlsAuthedJsonOk | UlsAuthedJsonErr> {
  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return { ok: false, result: loaded.result };
  }

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url: opts.url,
      method: opts.method,
      headers: opts.headers(loaded.jwt),
      body:
        opts.method === "POST" && opts.jsonBody != null
          ? JSON.stringify(opts.jsonBody)
          : undefined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      result: toolError("NETWORK_ERROR", `${opts.label} 网络失败：${detail}`),
    };
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return {
      ok: false,
      result: authRequired(
        hint != null
          ? `${opts.label} 401：${hint}`
          : `${opts.label} 401：JWT 无效或已过期`,
      ),
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return {
      ok: false,
      result: toolError(
        "HTTP_ERROR",
        hint != null
          ? `${opts.label} HTTP ${response.statusCode}：${hint}`
          : `${opts.label} HTTP ${response.statusCode}`,
      ),
    };
  }

  const parsed = parseBusinessBody(response.body, {
    successCode: opts.successCode,
    dataKeys: opts.dataKeys,
  });
  if (!parsed.ok) {
    if (parsed.kind === "business") {
      return {
        ok: false,
        result: toolError(
          "BUSINESS_ERROR",
          `${opts.label} 业务码 ${parsed.raw_code}${
            parsed.msg != null
              ? `：${parsed.msg}`
              : `（需 code=${opts.successCode}）`
          }`,
        ),
      };
    }
    return {
      ok: false,
      result: toolError(
        "PARSE_ERROR",
        `${opts.label} 响应无法解析（需业务成功码 code=${opts.successCode}）`,
      ),
    };
  }

  return {
    ok: true,
    data: parsed.data,
    raw_code: parsed.raw_code,
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
