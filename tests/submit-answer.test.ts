import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  buildOralRecordAnswer,
  parseSubmitAnswerBody,
  submitAnswer,
} from "../src/submit-answer.js";

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = [];
  return {
    calls,
    async request(input) {
      const call = {
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        body: input.body,
      };
      calls.push({ url: call.url, body: call.body });
      return handler(call);
    },
  };
}

describe("buildOralRecordAnswer", () => {
  test("wraps CDN url into record.url JSON", () => {
    const raw = buildOralRecordAnswer("https://birdflock.unipus.cn/a.wav");
    assert.deepEqual(JSON.parse(raw), {
      value: [],
      children: [],
      record: { url: "https://birdflock.unipus.cn/a.wav" },
    });
  });
});

describe("parseSubmitAnswerBody", () => {
  test("accepts code 1 / value true", () => {
    assert.deepEqual(
      parseSubmitAnswerBody(JSON.stringify({ code: 1, value: true })),
      { raw_code: 1 },
    );
  });

  test("rejects failure code", () => {
    assert.equal(
      parseSubmitAnswerBody(JSON.stringify({ code: 4021, msg: "lock" })),
      null,
    );
  });
});

describe("submitAnswer", () => {
  test("missing JWT is auth_required", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const r = await submitAnswer(
      { credentials: { getJwt: async () => null }, http },
      {
        taskId: "t1",
        paperToken: "tok",
        userData: [{ instanceId: "1", answer: "https://x/a.wav" }],
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.status, "auth_required");
    assert.deepEqual(http.calls, []);
  });

  test("posts wrapped oral answer with paper token", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, msg: "SUCCESS", value: true }),
    }));
    const r = await submitAnswer(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "101",
        paperToken: "paper-tok",
        durationSec: 3,
        userData: [
          { instanceId: "1985", answer: "https://birdflock.unipus.cn/a.wav" },
        ],
      },
    );
    assert.equal(r.isError, false);
    assert.equal(r.status, "ok");
    assert.equal(http.calls.length, 1);
    const body = JSON.parse(http.calls[0]!.body!);
    assert.equal(body.taskId, "101");
    assert.equal(body.token, "paper-tok");
    assert.equal(body.ansVersion, 1);
    assert.equal(body.userData[0].instanceId, "1985");
    const answer = JSON.parse(body.userData[0].answer);
    assert.equal(answer.record.url, "https://birdflock.unipus.cn/a.wav");
  });

  test("surfaces business code 4295 with placement hint", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 4295,
        msg: "作答小题数存在问题",
      }),
    }));
    const r = await submitAnswer(
      {
        credentials: { getJwt: async () => "jwt-x" },
        http,
        submitAnswerUrl: "https://example.test/submitAnswer",
      },
      {
        taskId: "t1",
        paperToken: "tok",
        userData: [{ instanceId: "1", answer: '{"value":[],"children":[]}' }],
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.code, "BUSINESS_ERROR");
    assert.match(r.message, /4295/);
    assert.match(r.message, /作答小题数存在问题/);
    assert.match(r.message, /placement-paper/);
  });
});
