import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_PART_SUBMIT_PATH,
  resolvePartSubmitUrl,
} from "../src/config.js";
import {
  buildPartSubmitBody,
  isPartSubmitSuccessCode,
  parsePartSubmitBody,
  partSubmit,
} from "../src/part-submit.js";
import {
  buildEnPredScoreQuestionContent,
  buildEnPredScoreRecord,
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

describe("resolvePartSubmitUrl", () => {
  test("defaults to ucloud part/submit (not oral/train)", () => {
    const url = resolvePartSubmitUrl({});
    assert.equal(url, `https://ucloud.unipus.cn${DEFAULT_ULS_PART_SUBMIT_PATH}`);
    assert.doesNotMatch(url, /oral\/train/);
  });
});

describe("isPartSubmitSuccessCode / parsePartSubmitBody", () => {
  test("only business code=1 is success (not conversation 200)", () => {
    assert.equal(isPartSubmitSuccessCode(1), true);
    assert.equal(isPartSubmitSuccessCode("1"), true);
    assert.equal(isPartSubmitSuccessCode(200), false);
    assert.equal(isPartSubmitSuccessCode(0), false);
  });

  test("parse accepts code=1", () => {
    const parsed = parsePartSubmitBody(JSON.stringify({ code: 1, value: true }));
    assert.ok(parsed != null);
    assert.equal(parsed.raw_code, 1);
  });

  test("parse rejects code=200", () => {
    assert.equal(
      parsePartSubmitBody(JSON.stringify({ code: 200, data: {} })),
      null,
    );
  });
});

describe("buildEnPredScore*", () => {
  test("record.type is EN_PRED_SCORE (not EN_SENT_SCORE)", () => {
    const record = buildEnPredScoreRecord({
      text: "I like speaking freely.",
      url: "https://birdflock.unipus.cn/ans-prod/u/a.wav",
      reviewScores: { score: 88 },
    });
    assert.equal(record.type, "EN_PRED_SCORE");
    assert.notEqual(record.type, "EN_SENT_SCORE");
    assert.equal(
      (record.recordDetail as Record<string, unknown>).score,
      88,
    );
    assert.equal(
      (record.specific_scores as Record<string, unknown>).total,
      0.88,
    );

    const content = JSON.parse(
      buildEnPredScoreQuestionContent({
        text: "I like speaking freely.",
        url: "https://birdflock.unipus.cn/ans-prod/u/a.wav",
      }),
    );
    assert.equal(content.children[0].isDone, true);
    assert.equal(content.children[0].record.type, "EN_PRED_SCORE");
  });
});

describe("buildPartSubmitBody", () => {
  test("builds snapshot then submit shaped bodies", () => {
    const snap = buildPartSubmitBody({
      action: "snapshot",
      taskId: "t1",
      partId: "p1",
      token: "paper-tok",
      ansVersion: 1,
      duration: 5,
      userData: [
        {
          instanceId: "1984905701219868673",
          answer: buildEnPredScoreQuestionContent({
            text: "hi",
            url: "https://birdflock.unipus.cn/a.wav",
          }),
          context: { state: "doing" },
        },
      ],
    });
    assert.equal(snap.action, "snapshot");
    assert.equal(snap.token, "paper-tok");
    const ud = (snap.userData as Array<Record<string, unknown>>)[0]!;
    assert.equal(ud.instanceId, "1984905701219868673");
    assert.equal(ud.context, '{"state":"doing"}');
    assert.equal(typeof ud.answer, "string");
    assert.match(String(ud.answer), /EN_PRED_SCORE/);

    const submit = buildPartSubmitBody({
      action: "submit",
      taskId: "t1",
      partId: "p1",
      token: "paper-tok",
      userData: [
        {
          instanceId: "1984905701219868673",
          answer: '{"children":[]}',
          context: '{"state":"done"}',
        },
      ],
    });
    assert.equal(submit.action, "submit");
  });
});

describe("partSubmit", () => {
  test("missing JWT is auth_required", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await partSubmit(
      { credentials: { getJwt: async () => null }, http },
      {
        action: "submit",
        taskId: "t",
        partId: "p",
        token: "tok",
        userData: [{ instanceId: "1", answer: "{}" }],
      },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.deepEqual(http.calls, []);
  });

  test("snapshot then submit with code=1 success", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: null }),
    }));
    const ports = { credentials: { getJwt: async () => "jwt" }, http };
    const snap = await partSubmit(ports, {
      action: "snapshot",
      taskId: "t1",
      partId: "p1",
      token: "tok",
      duration: 3,
      userData: [
        {
          instanceId: "i1",
          answer: buildEnPredScoreQuestionContent({
            text: "free",
            url: "https://birdflock.unipus.cn/a.wav",
          }),
          context: { state: "doing" },
        },
      ],
    });
    assert.equal(snap.isError, false);
    assert.equal(snap.raw_code, 1);
    assert.equal(snap.action, "snapshot");

    const submit = await partSubmit(ports, {
      action: "submit",
      taskId: "t1",
      partId: "p1",
      token: "tok",
      userData: [{ instanceId: "i1", answer: "{}" }],
    });
    assert.equal(submit.isError, false);
    assert.equal(submit.raw_code, 1);
    assert.equal(submit.action, "submit");
    assert.equal(http.calls.length, 2);
    assert.equal(http.calls[0]?.url, resolvePartSubmitUrl({}));
    assert.doesNotMatch(http.calls[0]?.url ?? "", /oral\/train/);
    assert.equal(JSON.parse(http.calls[0]?.body ?? "{}").action, "snapshot");
    assert.equal(JSON.parse(http.calls[1]?.body ?? "{}").action, "submit");
    // Cloud-style headers optional; raw JWT required
    assert.equal(http.calls[0]?.headers.authorization, "jwt");
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
  });

  test("business code=200 is BUSINESS_ERROR for part/submit", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: {} }),
    }));
    const result = await partSubmit(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        action: "submit",
        taskId: "t",
        partId: "p",
        token: "tok",
        userData: [{ instanceId: "1", answer: "{}" }],
      },
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "BUSINESS_ERROR");
  });
});
