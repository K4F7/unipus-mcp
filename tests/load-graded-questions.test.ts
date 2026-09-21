import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_LOAD_GRADED_QUESTIONS_PATH,
  resolveLoadGradedQuestionsUrl,
} from "../src/config.js";
import {
  loadGradedQuestions,
  parseLoadGradedQuestionsBody,
} from "../src/load-graded-questions.js";

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

describe("resolveLoadGradedQuestionsUrl", () => {
  test("defaults to adaptive loadGradedQuestions", () => {
    assert.equal(
      resolveLoadGradedQuestionsUrl({}),
      `https://uadaptive.unipus.cn${DEFAULT_ULS_LOAD_GRADED_QUESTIONS_PATH}`,
    );
  });
});

describe("loadGradedQuestions", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await loadGradedQuestions(
      { credentials: { getJwt: async () => null }, http },
      { taskId: "t1" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.deepEqual(http.calls, []);
  });

  test("empty list is OK", async () => {
    const jwt = "jwt-raw";
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: [] }),
    }));
    const result = await loadGradedQuestions(
      { credentials: { getJwt: async () => jwt }, http },
      { taskId: "t1", ansVersion: 1 },
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.deepEqual(result.items, []);
    assert.equal(result.task_id, "t1");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveLoadGradedQuestionsUrl({}));
    assert.equal(http.calls[0]?.method, "POST");
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.equal(http.calls[0]?.headers["u-app-id"], "116");
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    assert.deepEqual(JSON.parse(http.calls[0]?.body ?? "{}"), {
      taskId: "t1",
      ansVersion: 1,
    });
  });

  test("returns items when present", async () => {
    const items = [{ questionInstanceId: "1", score: 80 }];
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: items }),
    }));
    const result = await loadGradedQuestions(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "t2" },
    );
    assert.equal(result.isError, false);
    assert.deepEqual(result.items, items);
    assert.match(result.message ?? "", /1 条/);
  });

  test("HTTP 401 is auth_required", async () => {
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT token in request" }),
    }));
    const result = await loadGradedQuestions(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "t1" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
  });

  test("empty taskId is INVALID_ARGUMENT", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await loadGradedQuestions(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "  " },
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "INVALID_ARGUMENT");
    assert.deepEqual(http.calls, []);
  });

  test("bad parse is PARSE_ERROR", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: { not: "array" } }),
    }));
    const result = await loadGradedQuestions(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "t1" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "PARSE_ERROR");
  });
});

describe("parseLoadGradedQuestionsBody", () => {
  test("accepts empty and populated value arrays", () => {
    assert.deepEqual(parseLoadGradedQuestionsBody(JSON.stringify({ code: 1, value: [] })), {
      items: [],
      raw_code: 1,
    });
    assert.deepEqual(
      parseLoadGradedQuestionsBody(
        JSON.stringify({ code: 0, data: [{ score: 1 }] }),
      ),
      { items: [{ score: 1 }], raw_code: 0 },
    );
  });

  test("rejects bad codes and non-array payloads", () => {
    assert.equal(
      parseLoadGradedQuestionsBody(JSON.stringify({ code: 500, value: [] })),
      null,
    );
    assert.equal(
      parseLoadGradedQuestionsBody(JSON.stringify({ code: 1, value: {} })),
      null,
    );
    assert.equal(parseLoadGradedQuestionsBody("nope"), null);
  });

  test("preserves snowflake questionInstanceId in items", () => {
    const snowflake = "1984905701219868673";
    const parsed = parseLoadGradedQuestionsBody(
      `{"code":1,"value":[{"questionInstanceId":${snowflake},"score":80}]}`,
    );
    assert.deepEqual(parsed, {
      items: [{ questionInstanceId: snowflake, score: 80 }],
      raw_code: 1,
    });
  });
});
