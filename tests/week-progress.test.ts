import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_WEEK_PROGRESS_PATH,
  resolveWeekProgressUrl,
} from "../src/config.js";
import { listWeekProgress } from "../src/week-progress.js";

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

describe("resolveWeekProgressUrl", () => {
  test("defaults to documented uls placeholder path", () => {
    assert.equal(
      resolveWeekProgressUrl({}),
      `https://ucloud.unipus.cn${DEFAULT_ULS_WEEK_PROGRESS_PATH}`,
    );
  });

  test("honors UNIPUS_ULS_ORIGIN and UNIPUS_ULS_WEEK_PROGRESS_PATH", () => {
    assert.equal(
      resolveWeekProgressUrl({
        UNIPUS_ULS_ORIGIN: "https://uai.unipus.cn/",
        UNIPUS_ULS_WEEK_PROGRESS_PATH: "/api/uls/home/week",
      }),
      "https://uai.unipus.cn/api/uls/home/week",
    );
  });
});

describe("listWeekProgress", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => null },
      http,
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.deepEqual(http.calls, []);
  });

  test("returns structured progress when JWT ok and body parseable", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        progress_done: 0,
        progress_total: 5,
        level: "S15",
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
    });
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.equal(result.progress_done, 0);
    assert.equal(result.progress_total, 5);
    assert.equal(result.level, "S15");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveWeekProgressUrl({}));
    assert.match(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    assert.doesNotMatch(JSON.stringify(result), /eyJhbGci/);
  });

  test("normalizes nested / alias fields into stable progress_* / level", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: { done: 2, total: 5, levelName: "S12" },
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
    });
    assert.equal(result.isError, false);
    assert.equal(result.progress_done, 2);
    assert.equal(result.progress_total, 5);
    assert.equal(result.level, "S12");
  });

  test("HTTP 401 is auth_required (distinct from network)", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT token in request" }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.match(result.message, /401|JWT|登录/);
  });

  test("network failure is error NETWORK_ERROR (distinct from 401)", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http: UnipusHttp = {
      async request() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    };
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "error");
    assert.equal(result.code, "NETWORK_ERROR");
    assert.match(result.message, /ECONNREFUSED|网络|失败/);
    assert.notEqual(result.status, "auth_required");
  });

  test("unparseable 200 body is error PARSE_ERROR", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ hello: "world" }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "error");
    assert.equal(result.code, "PARSE_ERROR");
  });
});
