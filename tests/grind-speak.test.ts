import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  completeOneSpeak,
  partsAppHistoryReady,
} from "../src/grind-speak.js";
import type { HttpRequestCall, UnipusHttp } from "../src/http.js";

function mockHttp(
  handler: (call: HttpRequestCall) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: HttpRequestCall[] } {
  const calls: HttpRequestCall[] = [];
  return {
    calls,
    async request(call) {
      calls.push(call);
      return handler(call);
    },
  };
}

const paper = {
  token: "paper-tok",
  paperJson: JSON.stringify({
    chr: [
      {
        q_qinstid: "111",
        q_template_name: "audio-learn",
        nm: "learn",
        data: { children: [] },
      },
      {
        q_qinstid: "222",
        q_template_name: "oral-personal-state",
        nm: "free",
        data: { children: [{}] },
      },
    ],
  }),
};

describe("partsAppHistoryReady", () => {
  test("false when reportStatus null (submitAnswer shape)", () => {
    assert.equal(
      partsAppHistoryReady({
        partList: [
          { partId: "1", partName: "范例学习", reportStatus: null, submitted: null },
        ],
      }),
      false,
    );
  });

  test("true when every part completed+submitted", () => {
    assert.equal(
      partsAppHistoryReady({
        partList: [
          { partId: "1", reportStatus: "completed", submitted: true },
          { partId: "2", reportStatus: "completed", submitted: 1 },
        ],
      }),
      true,
    );
  });
});

describe("completeOneSpeak", () => {
  test("uses part/submit snapshot→submit, not submitAnswer", async () => {
    let partGetAfterSubmit = false;
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { type: "train", taskId: "555", ansVersion: 1, status: 1 },
          }),
        };
      }
      if (call.url.includes("loadPaper")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: paper }),
        };
      }
      if (call.url.includes("part/get")) {
        if (partGetAfterSubmit) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: {
                partList: [
                  {
                    partId: "p1",
                    partName: "范例学习",
                    questionInstanceIds: ["111"],
                    reportStatus: "completed",
                    submitted: true,
                  },
                  {
                    partId: "p2",
                    partName: "自由表达",
                    questionInstanceIds: ["222"],
                    reportStatus: "completed",
                    submitted: true,
                  },
                ],
              },
            }),
          };
        }
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              partList: [
                {
                  partId: "p1",
                  partName: "范例学习",
                  questionInstanceIds: ["111"],
                  reportStatus: null,
                  submitted: null,
                },
                {
                  partId: "p2",
                  partName: "自由表达",
                  questionInstanceIds: ["222"],
                  reportStatus: null,
                  submitted: null,
                },
              ],
            },
          }),
        };
      }
      if (call.url.includes("part/submit")) {
        partGetAfterSubmit = true;
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: { ok: true } }),
        };
      }
      return { statusCode: 404, body: "{}" };
    });

    const speechRecord = async (
      _text: string,
      _tag: string,
      type: "EN_SENT_SCORE" | "EN_PRED_SCORE",
    ) => ({
      type,
      url: "https://cdn.example/a.wav",
      recordDetail: { score: 90 },
      specific_scores: { total: 0.9 },
    });

    const result = await completeOneSpeak({
      credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t" },
      http,
      env: {},
      speechRecord,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.taskId, "555");
    assert.equal(http.calls.some((c) => c.url.includes("submitAnswer")), false);
    const submits = http.calls.filter((c) => c.url.includes("part/submit"));
    assert.ok(submits.length >= 4); // 2 parts × snapshot+submit
    const actions = submits.map((c) => JSON.parse(String(c.body)).action);
    assert.deepEqual(actions.filter((a) => a === "snapshot").length >= 2, true);
    assert.deepEqual(actions.filter((a) => a === "submit").length >= 2, true);
  });

  test("fails when part/get still missing completed after submit", async () => {
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { type: "train", taskId: "555", ansVersion: 1, status: 1 },
          }),
        };
      }
      if (call.url.includes("loadPaper")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: paper }),
        };
      }
      if (call.url.includes("part/get")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              partList: [
                {
                  partId: "p1",
                  questionInstanceIds: ["111"],
                  reportStatus: null,
                  submitted: null,
                },
                {
                  partId: "p2",
                  questionInstanceIds: ["222"],
                  reportStatus: null,
                  submitted: null,
                },
              ],
            },
          }),
        };
      }
      if (call.url.includes("part/submit")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: { ok: true } }),
        };
      }
      return { statusCode: 404, body: "{}" };
    });
    const result = await completeOneSpeak({
      credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t" },
      http,
      env: {},
      speechRecord: async () => ({
        type: "EN_SENT_SCORE",
        url: "https://cdn.example/a.wav",
        recordDetail: { score: 90 },
      }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.detail, /评分中|reportStatus/);
  });
});
