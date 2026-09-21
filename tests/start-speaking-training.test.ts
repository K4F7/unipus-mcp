import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  resolveLoadPaperUrl,
  resolveUserStatusForAppUrl,
} from "../src/config.js";
import {
  parseSpeakStatusBody,
  startSpeakingTraining,
} from "../src/start-speaking-training.js";

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & {
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  return {
    calls,
    async request(input) {
      const call = {
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

describe("startSpeakingTraining", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await startSpeakingTraining(
      { credentials: { getJwt: async () => null }, http },
      {},
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.deepEqual(http.calls, []);
  });

  test("resolves speak status then loadPaper with raw JWT and u-app-id", async () => {
    const jwt = "jwt-without-bearer";
    const statusUrl = resolveUserStatusForAppUrl({}, "speak");
    const loadUrl = resolveLoadPaperUrl({});
    const http = mockHttp(async (call) => {
      if (call.url === statusUrl) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { taskId: "speak-task", ansVersion: 2 },
          }),
        };
      }
      if (call.url === loadUrl) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { taskId: "speak-task", token: "tok-speak" },
          }),
        };
      }
      return { statusCode: 500, body: "unexpected" };
    });

    const result = await startSpeakingTraining(
      { credentials: { getJwt: async () => jwt }, http },
      {},
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.equal(result.task_id, "speak-task");
    assert.equal(result.paper_token, "tok-speak");
    assert.match(result.message, /口语/);
    assert.equal(http.calls.length, 2);
    assert.equal(http.calls[0]?.method, "GET");
    assert.equal(http.calls[0]?.url, statusUrl);
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.equal(http.calls[0]?.headers["u-app-id"], "116");
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    assert.equal(http.calls[1]?.method, "POST");
    assert.equal(http.calls[1]?.url, loadUrl);
    assert.equal(http.calls[1]?.headers.authorization, jwt);
    assert.deepEqual(JSON.parse(http.calls[1]?.body ?? "{}"), {
      taskId: "speak-task",
      ansVersion: 2,
    });
  });

  test("explicit taskId and ansVersion skip status GET", async () => {
    const jwt = "jwt";
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 0, data: { taskId: "t1", token: "tok" } }),
    }));
    const result = await startSpeakingTraining(
      { credentials: { getJwt: async () => jwt }, http },
      { taskId: "t1", ansVersion: 3 },
    );
    assert.equal(result.isError, false);
    assert.equal(result.task_id, "t1");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveLoadPaperUrl({}));
    assert.deepEqual(JSON.parse(http.calls[0]?.body ?? "{}"), {
      taskId: "t1",
      ansVersion: 3,
    });
  });

  test("HTTP 401 on status is auth_required", async () => {
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT token in request" }),
    }));
    const result = await startSpeakingTraining(
      { credentials: { getJwt: async () => "jwt" }, http },
      {},
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.match(result.message, /401|JWT|登录/);
  });

  test("bad status body is PARSE_ERROR", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: { noTask: true } }),
    }));
    const result = await startSpeakingTraining(
      { credentials: { getJwt: async () => "jwt" }, http },
      {},
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "error");
    assert.equal(result.code, "PARSE_ERROR");
  });
});

describe("parseSpeakStatusBody", () => {
  test("parses value.taskId and ansVersion", () => {
    assert.deepEqual(
      parseSpeakStatusBody(
        JSON.stringify({ code: 1, value: { taskId: "abc", ansVersion: 2 } }),
      ),
      { taskId: "abc", ansVersion: 2 },
    );
  });

  test("rejects bad business codes and missing taskId", () => {
    assert.equal(
      parseSpeakStatusBody(JSON.stringify({ code: 500, value: { taskId: "t" } })),
      null,
    );
    assert.equal(
      parseSpeakStatusBody(JSON.stringify({ code: 1, value: {} })),
      null,
    );
    assert.equal(parseSpeakStatusBody("not-json"), null);
  });
});
