import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_LOAD_PAPER_PATH,
  resolveLoadPaperUrl,
} from "../src/config.js";
import {
  parseLoadPaperBody,
  startListeningTraining,
} from "../src/start-listening-training.js";

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

describe("resolveLoadPaperUrl", () => {
  test("defaults to the uadaptive loadPaper endpoint", () => {
    assert.equal(
      resolveLoadPaperUrl({}),
      `https://uadaptive.unipus.cn${DEFAULT_ULS_LOAD_PAPER_PATH}`,
    );
  });

  test("honors adaptive origin and loadPaper path overrides", () => {
    assert.equal(
      resolveLoadPaperUrl({
        UNIPUS_ULS_ADAPTIVE_ORIGIN: "https://adaptive.example/",
        UNIPUS_ULS_LOAD_PAPER_PATH: "api/custom/load-paper",
      }),
      "https://adaptive.example/api/custom/load-paper",
    );
  });
});

describe("startListeningTraining", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await startListeningTraining(
      { credentials: { getJwt: async () => null }, http },
      { taskId: "t1" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.deepEqual(http.calls, []);
  });

  test("parses successful loadPaper response and sends raw Authorization", async () => {
    const jwt = "jwt-without-bearer";
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 0, data: { taskId: "abc", token: "tok" } }),
    }));
    const result = await startListeningTraining(
      { credentials: { getJwt: async () => jwt }, http },
      { taskId: "abc", ansVersion: 2 },
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.equal(result.task_id, "abc");
    assert.equal(result.paper_token, "tok");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveLoadPaperUrl({}));
    assert.equal(http.calls[0]?.method, "POST");
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    assert.deepEqual(JSON.parse(http.calls[0]?.body ?? "{}"), {
      taskId: "abc",
      ansVersion: 2,
    });
  });

  test("empty taskId is INVALID_ARGUMENT without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await startListeningTraining(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "  " },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "error");
    assert.equal(result.code, "INVALID_ARGUMENT");
    assert.deepEqual(http.calls, []);
  });

  test("HTTP 401 is auth_required", async () => {
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT token in request" }),
    }));
    const result = await startListeningTraining(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "t1" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.match(result.message, /401|JWT|登录/);
  });
});

describe("parseLoadPaperBody", () => {
  test("rejects nonzero business codes other than 0, 1, and 200", () => {
    for (const code of [2, 400, 500, -1]) {
      assert.equal(
        parseLoadPaperBody(JSON.stringify({ code, data: { taskId: "t1", token: "tok" } }), "t1"),
        null,
        `code ${code} should be rejected`,
      );
    }

    assert.equal(
      parseLoadPaperBody(
        JSON.stringify({ code: "500", data: { taskId: "t1", token: "tok" } }),
        "t1",
      ),
      null,
      "string code 500 should be rejected",
    );

    for (const code of [0, 1, 200]) {
      assert.notEqual(
        parseLoadPaperBody(JSON.stringify({ code, data: { taskId: "t1", token: "tok" } }), "t1"),
        null,
        `code ${code} should be accepted`,
      );
    }
  });
});
