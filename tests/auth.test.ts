import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AUTH_PROBE_URL, probeAuthStatus } from "../src/auth.js";
import type { UnipusHttp } from "../src/http.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    async request(input) {
      calls.push({ url: input.url, headers: input.headers ?? {} });
      return handler({
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
      });
    },
  };
}

describe("probeAuthStatus", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "no" }));
    const result = await probeAuthStatus({
      credentials: { getJwt: async () => null },
      http,
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.match(result.message, /JWT|登录|环境变量/);
    assert.equal(result.authenticated, false);
    assert.deepEqual(http.calls, []);
  });

  test("JWT present and probe non-401 is ok", async () => {
    const jwt = makeJwt({
      openId: "oid-safe",
      exp: 4_000_000_000,
    });
    const http = mockHttp(async () => ({
      statusCode: 404,
      body: JSON.stringify({ message: "Route Not Found" }),
    }));
    const result = await probeAuthStatus({
      credentials: { getJwt: async () => jwt },
      http,
      now: () => new Date(1_700_000_000_000),
    });
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.equal(result.authenticated, true);
    assert.equal(result.expired, false);
    assert.equal(result.userId, "oid-safe");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, AUTH_PROBE_URL);
    assert.match(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    assert.doesNotMatch(JSON.stringify(result), /eyJhbGci/);
  });

  test("HTTP 401 yields clear auth_required shape", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT token in request" }),
    }));
    const result = await probeAuthStatus({
      credentials: { getJwt: async () => jwt },
      http,
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.equal(result.authenticated, false);
    assert.match(result.message, /401|无效|过期|JWT/);
  });

  test("locally expired JWT reports expired coarse flag", async () => {
    const jwt = makeJwt({ openId: "oid-old", exp: 1_000 });
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "token expired" }),
    }));
    const result = await probeAuthStatus({
      credentials: { getJwt: async () => jwt },
      http,
      now: () => new Date(1_700_000_000_000),
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.expired, true);
    assert.equal(result.userId, "oid-old");
  });
});
