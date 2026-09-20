export const UCLOUD_ORIGIN = "https://ucloud.unipus.cn";
export const UAI_ORIGIN = "https://uai.unipus.cn";

export const UNIPUS_USER_AGENT =
  "unipus-mcp/0.1 (+https://github.com/K4F7/unipus-mcp; local stdio)";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "status" | "headers" | "text">>;

export type UnipusHttpRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

export type UnipusHttpResponse = {
  statusCode: number;
  body: string;
};

export type UnipusHttp = {
  request(input: UnipusHttpRequest): Promise<UnipusHttpResponse>;
};

export function isTrustedUnipusUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return false;
    }
    return (
      url.hostname === "ucloud.unipus.cn" ||
      url.hostname === "uai.unipus.cn" ||
      url.hostname === "sso.unipus.cn"
    );
  } catch {
    return false;
  }
}

export function createFetchUnipusHttp(fetchImpl: FetchLike = globalThis.fetch): UnipusHttp {
  return {
    async request(input) {
      if (!isTrustedUnipusUrl(input.url)) {
        throw new Error("untrusted_unipus_request_target");
      }
      const headers = new Headers(input.headers);
      if (!headers.has("user-agent")) {
        headers.set("user-agent", UNIPUS_USER_AGENT);
      }
      if (!headers.has("accept")) {
        headers.set("accept", "application/json, text/plain, */*");
      }
      const response = await fetchImpl(input.url, {
        method: input.method ?? "GET",
        headers,
        body: input.body,
        redirect: "manual",
      });
      return {
        statusCode: response.status,
        body: await response.text(),
      };
    },
  };
}

/** Short, safe snippet from an HTTP error body (JSON message or raw text). */
export function summarizeHttpErrorBody(body: string): string | null {
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
