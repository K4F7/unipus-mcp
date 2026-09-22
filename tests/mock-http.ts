import type { UnipusHttp } from "../src/http.js";

export type MockHttpCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

export type MockHttp = UnipusHttp & { calls: MockHttpCall[] };

/** Shared request recorder for conversation / part-submit unit tests. */
export function mockHttp(
  handler: (input: MockHttpCall) => Promise<{ statusCode: number; body: string }>,
): MockHttp {
  const calls: MockHttpCall[] = [];
  return {
    calls,
    async request(input) {
      const call: MockHttpCall = {
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        body: input.body,
      };
      calls.push(call);
      return handler(call);
    },
  };
}
