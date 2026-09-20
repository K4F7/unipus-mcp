import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_GRADE_QUESTION_PATH,
  resolveGradeQuestionUrl,
} from "../src/config.js";
import {
  buildEnSentScoreQuestionContent,
  buildEnSentScoreRecord,
  gradeQuestion,
  parseGradeQuestionBody,
} from "../src/grade-question.js";

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

const SNOWFLAKE = "1984905701219868673";

describe("resolveGradeQuestionUrl", () => {
  test("defaults to uadaptive gradeQuestion", () => {
    assert.equal(
      resolveGradeQuestionUrl({}),
      `https://uadaptive.unipus.cn${DEFAULT_ULS_GRADE_QUESTION_PATH}`,
    );
  });
});

describe("buildEnSentScore*", () => {
  test("builds rich EN_SENT_SCORE record", () => {
    const record = buildEnSentScoreRecord({
      text: "hello world",
      url: "https://birdflock.unipus.cn/a.wav",
      path: "/clio/proxy/x",
      replayUrl: "https://birdflock.unipus.cn/a.wav",
    });
    assert.deepEqual(record, {
      type: "EN_SENT_SCORE",
      text: "hello world",
      url: "https://birdflock.unipus.cn/a.wav",
      path: "/clio/proxy/x",
      replayUrl: "https://birdflock.unipus.cn/a.wav",
      isDone: true,
    });
    const content = JSON.parse(
      buildEnSentScoreQuestionContent({
        text: "hello world",
        url: "https://birdflock.unipus.cn/a.wav",
      }),
    );
    assert.equal(content.record.type, "EN_SENT_SCORE");
    assert.equal(content.record.isDone, true);
    assert.equal(content.record.path, undefined);
  });
});

describe("parseGradeQuestionBody", () => {
  test("extracts score from value", () => {
    assert.deepEqual(
      parseGradeQuestionBody(
        JSON.stringify({ code: 1, value: { score: 76 } }),
      ),
      { raw_code: 1, score: 76, raw_value: { score: 76 } },
    );
  });

  test("rejects failure code", () => {
    assert.equal(
      parseGradeQuestionBody(JSON.stringify({ code: 500, msg: "fail" })),
      null,
    );
  });
});

describe("gradeQuestion", () => {
  test("missing JWT is auth_required", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const r = await gradeQuestion(
      { credentials: { getJwt: async () => null }, http },
      {
        taskId: "t1",
        questionInstanceId: SNOWFLAKE,
        questionContent: '{"record":{"url":"https://x/a.wav"}}',
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.status, "auth_required");
    assert.deepEqual(http.calls, []);
  });

  test("posts string snowflake ids and optional isObjective", async () => {
    const jwt = "raw-jwt";
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: { score: 0 } }),
    }));
    const content = buildEnSentScoreQuestionContent({
      text: "hi",
      url: "https://birdflock.unipus.cn/a.wav",
    });
    const r = await gradeQuestion(
      { credentials: { getJwt: async () => jwt }, http },
      {
        taskId: "101",
        questionInstanceId: SNOWFLAKE,
        questionContent: content,
        isObjective: false,
      },
    );
    assert.equal(r.isError, false);
    assert.equal(r.status, "ok");
    assert.equal(r.score, 0);
    assert.equal(r.question_instance_id, SNOWFLAKE);
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveGradeQuestionUrl({}));
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    const body = JSON.parse(http.calls[0]?.body ?? "{}");
    assert.equal(body.taskId, "101");
    assert.equal(body.questionInstanceId, SNOWFLAKE);
    assert.equal(typeof body.questionInstanceId, "string");
    assert.equal(body.ansVersion, 1);
    assert.equal(body.isObjective, false);
    assert.equal(body.questionContent, content);
  });

  test("empty questionInstanceId is INVALID_ARGUMENT", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const r = await gradeQuestion(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "t1",
        questionInstanceId: "  ",
        questionContent: "{}",
      },
    );
    assert.equal(r.code, "INVALID_ARGUMENT");
    assert.deepEqual(http.calls, []);
  });

  test("HTTP 401 is auth_required", async () => {
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT" }),
    }));
    const r = await gradeQuestion(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "t1",
        questionInstanceId: "1",
        questionContent: "{}",
      },
    );
    assert.equal(r.status, "auth_required");
  });
});
