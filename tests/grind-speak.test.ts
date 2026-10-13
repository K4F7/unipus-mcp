import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyAppReadiness,
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
      sleep: async () => {},
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
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.detail, /未交/);
  });
});

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t";
const okSpeech = async (_t: string, _g: string, type: "EN_SENT_SCORE" | "EN_PRED_SCORE") => ({
  type, url: "u", recordDetail: { score: 90 },
});
type PartRow = { partId: string; partName: string; questionInstanceIds: string[]; reportStatus?: string | null; submitted?: boolean | null };
const twoParts = (): PartRow[] => [
  { partId: "p1", partName: "范例学习", questionInstanceIds: ["111"], reportStatus: null, submitted: null },
  { partId: "p2", partName: "自由表达", questionInstanceIds: ["222"], reportStatus: null, submitted: null },
];
function scenario(opts: {
  parts?: () => PartRow[];
  afterParts?: () => PartRow[];
  submit?: (body: { action: string; partId: string }) => { code: number; msg?: string };
}) {
  let submitted = false;
  return mockHttp(async (call) => {
    if (call.url.includes("getUserStatus")) return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: "555", ansVersion: 1, status: 1 } }) };
    if (call.url.includes("loadPaper")) return { statusCode: 200, body: JSON.stringify({ code: 1, value: paper }) };
    if (call.url.includes("part/get")) {
      const list = submitted && opts.afterParts ? opts.afterParts() : (opts.parts ?? twoParts)();
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { partList: list } }) };
    }
    if (call.url.includes("part/submit")) {
      submitted = true;
      const b = JSON.parse(String(call.body));
      const r = opts.submit ? opts.submit(b) : { code: 1 };
      return { statusCode: 200, body: JSON.stringify({ code: r.code, msg: r.msg ?? "x", value: {} }) };
    }
    return { statusCode: 404, body: "{}" };
  });
}
const run = (http: ReturnType<typeof mockHttp>, speechRecord = okSpeech) =>
  completeOneSpeak({ credentials: { getJwt: async () => JWT }, http, env: {}, speechRecord, sleep: async () => {}, appReadyPollTries: 3 });
const submitCalls = (h: ReturnType<typeof mockHttp>) => h.calls.filter((c) => c.url.includes("part/submit"));

describe("completeOneSpeak review (#62)", () => {
  test("partSubmit isError → fail with part/submit detail, no further parts", async () => {
    const http = scenario({ submit: () => ({ code: 200, msg: "业务错误" }) });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /part\/submit snapshot/);
      assert.match(r.detail, /BUSINESS_ERROR|业务错误|200/);
      assert.match(r.detail, /未交任何 part/);
    }
    // snapshot fails on first part → only one part/submit call
    assert.equal(submitCalls(http).length, 1);
  });

  test("snapshot 4113 → fail and stop", async () => {
    const http = scenario({ submit: () => ({ code: 4113, msg: "提交作答失败" }) });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /snapshot.*4113|4113/);
    assert.equal(submitCalls(http).length, 1);
  });

  test("submit 4113 on 2nd part → fail, stop, lists done parts", async () => {
    const http = scenario({ submit: (b) => (b.partId === "p2" && b.action === "submit" ? { code: 4113, msg: "提交作答失败" } : { code: 1 }) });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /4113/);
      assert.match(r.detail, /已交 part: 范例学习/);
    }
    assert.equal(submitCalls(http).length, 4);
  });

  test("Clio/upload throw → part/submit never called", async () => {
    const http = scenario({});
    const r = await run(http, async () => { throw new Error("upload fail: qiniu down"); });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /qiniu down/);
    assert.equal(submitCalls(http).length, 0);
  });

  test("empty partList → fail, no submit", async () => {
    const http = scenario({ parts: () => [] });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /no parts/);
    assert.equal(submitCalls(http).length, 0);
  });

  test("instance id mismatch → fail, no submit", async () => {
    const http = scenario({ parts: () => [
      { partId: "p1", partName: "范例学习", questionInstanceIds: ["111"] },
      { partId: "p2", partName: "自由表达", questionInstanceIds: ["999"] },
    ] });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /mismatch.*999.*222/);
    assert.equal(submitCalls(http).length, 0);
  });

  test("submitted but processing after polls → 已交但 App 未就绪", async () => {
    const http = scenario({ afterParts: () => twoParts().map((p) => ({ ...p, submitted: true, reportStatus: "processing" })) });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /已交但 App 未就绪/);
    assert.equal(http.calls.filter((c) => c.url.includes("part/get")).length, 1 + 3);
  });

  test("becomes ready on a later poll → ok", async () => {
    let n = 0;
    const http = scenario({ afterParts: () => {
      n += 1;
      return twoParts().map((p) => ({ ...p, submitted: true, reportStatus: n >= 2 ? "completed" : "processing" }));
    } });
    const r = await run(http);
    assert.equal(r.ok, true);
  });

  test("classifyAppReadiness", () => {
    assert.equal(classifyAppReadiness({ partList: [{ partId: "p", submitted: true, reportStatus: "completed" }] }), "ready");
    assert.equal(classifyAppReadiness({ partList: [{ partId: "p", submitted: true, reportStatus: "processing" }] }), "submitted_not_ready");
    assert.equal(classifyAppReadiness({ partList: [{ partId: "p", submitted: null, reportStatus: null }] }), "not_submitted");
  });
});
