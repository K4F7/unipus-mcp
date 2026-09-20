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
