import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyAppReadiness,
  completeOneSpeak,
  grindSpeakGaps,
  partsAppHistoryReady,
} from "../src/grind-speak.js";
import type { UnipusHttp, UnipusHttpRequest } from "../src/http.js";
import type { SpeechRecordType } from "../src/scored-speech.js";

const FREE_TALK = Array.from({ length: 120 }, (_, i) => (i % 10 === 9 ? "music." : "music")).join(" ");
const okAsk = async () => FREE_TALK;

function mockHttp(
  handler: (call: UnipusHttpRequest) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: UnipusHttpRequest[] } {
  const calls: UnipusHttpRequest[] = [];
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
        data: { children: [{}], contents: [{ text: "<p>Talk in 60 seconds about the music you like.</p>" }] },
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
      if (call.url.includes("getHistoryTrainingTasks")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            msg: "SUCCESS",
            value: {
              page: 1, pageSize: 20, total: 1, totalPages: 1,
              list: [{ taskId: "555", ansVersion: 1, score: 91, scoreIsOut: true, answerStatus: 2, countScore: true }],
            },
          }),
        };
      }
      if (call.url.includes("checkStatus")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, msg: "SUCCESS", value: 3, success: true }) };
      }
      return { statusCode: 404, body: "{}" };
    });

    const speechRecord = async (
      _text: string,
      _tag: string,
      type: SpeechRecordType,
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
      llmAsk: okAsk,
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

  test("fails when history scoreIsOut stays false after submit", async () => {
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
      if (call.url.includes("getHistoryTrainingTasks")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              page: 1, pageSize: 20, total: 1, totalPages: 1,
              list: [{ taskId: "555", ansVersion: 1, score: 0, scoreIsOut: false, answerStatus: 2 }],
            },
          }),
        };
      }
      return { statusCode: 404, body: "{}" };
    });
    const result = await completeOneSpeak({
      credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t" },
      http,
      env: {},
      llmAsk: okAsk,
      speechRecord: async () => ({
        type: "EN_SENT_SCORE",
        url: "https://cdn.example/a.wav",
        recordDetail: { score: 90 },
      }),
      sleep: async () => {},
      appReadyPollTries: 2,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.detail, /已交但 App 评分中/);
  });
});

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t";
const okSpeech = async (_t: string, _g: string, type: SpeechRecordType) => ({
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
  /** History list item for task 555; default scoreIsOut true. */
  history?: () => { taskId: string; scoreIsOut: boolean; score?: number; ansVersion?: number } | null;
  checkStatus?: () => number;
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
    if (call.url.includes("getHistoryTrainingTasks")) {
      const item = opts.history
        ? opts.history()
        : { taskId: "555", scoreIsOut: true, score: 90, ansVersion: 1 };
      const list = item == null ? [] : [item];
      return {
        statusCode: 200,
        body: JSON.stringify({
          code: 1,
          value: { page: 1, pageSize: 20, total: list.length, totalPages: 1, list },
        }),
      };
    }
    if (call.url.includes("checkStatus")) {
      const v = opts.checkStatus ? opts.checkStatus() : 3;
      return { statusCode: 200, body: JSON.stringify({ code: 1, msg: "SUCCESS", value: v, success: true }) };
    }
    return { statusCode: 404, body: "{}" };
  });
}
const run = (
  http: ReturnType<typeof mockHttp>,
  speechRecord = okSpeech,
  llmAsk: ((p: string) => Promise<string>) | null = okAsk,
  env: Record<string, string> = {},
) =>
  completeOneSpeak({ credentials: { getJwt: async () => JWT }, http, env, llmAsk: llmAsk ?? undefined, speechRecord, sleep: async () => {}, appReadyPollTries: 3 });
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

  test("snapshot 4110 but part/get shows part submitted → skip and continue (#84)", async () => {
    const http = scenario({
      submit: (b) => (b.partId === "p1" ? { code: 4110, msg: "该任务已提交，请重新获取任务" } : { code: 1 }),
      afterParts: () => [
        { partId: "p1", partName: "范例学习", questionInstanceIds: ["111"], reportStatus: "processing", submitted: true },
        { partId: "p2", partName: "自由表达", questionInstanceIds: ["222"], reportStatus: null, submitted: null },
      ],
    });
    const r = await run(http);
    assert.equal(r.ok, true);
    // p1 snapshot (4110, skipped) + p2 snapshot + p2 submit
    assert.deepEqual(
      submitCalls(http).map((c) => { const b = JSON.parse(String(c.body)); return `${b.partId}:${b.action}`; }),
      ["p1:snapshot", "p2:snapshot", "p2:submit"],
    );
  });

  test("submit 4110 after ok snapshot but part/get shows submitted → continue (#84)", async () => {
    const http = scenario({
      submit: (b) => (b.partId === "p1" && b.action === "submit" ? { code: 4110, msg: "该任务已提交，请重新获取任务" } : { code: 1 }),
      afterParts: () => [
        { partId: "p1", partName: "范例学习", questionInstanceIds: ["111"], reportStatus: "processing", submitted: true },
        { partId: "p2", partName: "自由表达", questionInstanceIds: ["222"], reportStatus: null, submitted: null },
      ],
    });
    const r = await run(http);
    assert.equal(r.ok, true);
    assert.deepEqual(
      submitCalls(http).map((c) => { const b = JSON.parse(String(c.body)); return `${b.partId}:${b.action}`; }),
      ["p1:snapshot", "p1:submit", "p2:snapshot", "p2:submit"],
    );
  });

  test("snapshot 4110 and part/get still not submitted → fail (#84)", async () => {
    const http = scenario({ submit: () => ({ code: 4110, msg: "该任务已提交，请重新获取任务" }) });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /4110/);
    assert.equal(submitCalls(http).length, 1);
  });

  test("4110 skip still requires App history scoreIsOut (#84)", async () => {
    const http = scenario({
      submit: (b) => (b.partId === "p1" ? { code: 4110, msg: "该任务已提交" } : { code: 1 }),
      afterParts: () => [
        { partId: "p1", partName: "范例学习", questionInstanceIds: ["111"], reportStatus: "processing", submitted: true },
        { partId: "p2", partName: "自由表达", questionInstanceIds: ["222"], reportStatus: null, submitted: null },
      ],
      history: () => ({ taskId: "555", scoreIsOut: false, score: 0, ansVersion: 1 }),
    });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.detail, /已交但 App 评分中/);
      assert.match(r.detail, /服务端已交,跳过/);
    }
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

  test("scoreIsOut false after polls → 已交但 App 评分中", async () => {
    const http = scenario({
      history: () => ({ taskId: "555", scoreIsOut: false, score: 0, ansVersion: 1 }),
    });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /已交但 App 评分中/);
    assert.ok(http.calls.some((c) => c.url.includes("getHistoryTrainingTasks")));
  });

  test("scoreIsOut becomes true on later poll → ok", async () => {
    let n = 0;
    const http = scenario({
      history: () => {
        n += 1;
        return { taskId: "555", scoreIsOut: n >= 2, score: n >= 2 ? 91 : 0, ansVersion: 1 };
      },
    });
    const r = await run(http);
    assert.equal(r.ok, true);
  });

  test("scoreIsOut true but checkStatus stays 2 → 已交但 App 评分中", async () => {
    const http = scenario({
      history: () => ({ taskId: "555", scoreIsOut: true, score: 91, ansVersion: 1 }),
      checkStatus: () => 2,
    });
    const r = await run(http);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, /已交但 App 评分中/);
  });

  test("paginates history until taskId found with scoreIsOut", async () => {
    let histCalls = 0;
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: "999", ansVersion: 1, status: 1 } }) };
      if (call.url.includes("loadPaper")) return { statusCode: 200, body: JSON.stringify({ code: 1, value: paper }) };
      if (call.url.includes("part/get")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { partList: twoParts().map((p) => ({ ...p, submitted: true, reportStatus: "completed" })) } }) };
      }
      if (call.url.includes("part/submit")) return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
      if (call.url.includes("getHistoryTrainingTasks")) {
        histCalls += 1;
        const body = JSON.parse(String(call.body));
        if (body.page === 1) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: {
                page: 1, pageSize: 20, total: 21, totalPages: 2,
                list: [{ taskId: "111", scoreIsOut: true, score: 80, ansVersion: 1 }],
              },
            }),
          };
        }
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              page: 2, pageSize: 20, total: 21, totalPages: 2,
              list: [{ taskId: "999", scoreIsOut: true, score: 88, ansVersion: 1 }],
            },
          }),
        };
      }
      if (call.url.includes("checkStatus")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: 3 }) };
      }
      return { statusCode: 404, body: "{}" };
    });
    const r = await completeOneSpeak({
      credentials: { getJwt: async () => JWT },
      http,
      env: {},
      llmAsk: okAsk,
      speechRecord: okSpeech,
      sleep: async () => {},
      appReadyPollTries: 2,
    });
    assert.equal(r.ok, true);
    assert.ok(histCalls >= 2);
  });

  test("classifyAppReadiness", () => {
    assert.equal(classifyAppReadiness({ partList: [{ partId: "p", submitted: true, reportStatus: "completed" }] }), "ready");
    assert.equal(classifyAppReadiness({ partList: [{ partId: "p", submitted: true, reportStatus: "processing" }] }), "submitted_not_ready");
    assert.equal(classifyAppReadiness({ partList: [{ partId: "p", submitted: null, reportStatus: null }] }), "not_submitted");
  });
});

describe("per-paper results + no silent LLM fallback (#88)", () => {
  const recorder = (submittedKeys: string[] = []) => {
    const lines: Array<Record<string, unknown>> = [];
    return {
      lines,
      report: async (r: Record<string, unknown>) => void lines.push(r),
      isSubmitted: (skill: string, taskId: string, v: number) => submittedKeys.includes(`${skill}|${taskId}|${v}`),
    };
  };
  const ports = (http: ReturnType<typeof mockHttp>, extra: Record<string, unknown> = {}) => ({
    credentials: { getJwt: async () => JWT }, http, env: {}, llmAsk: okAsk, speechRecord: okSpeech,
    sleep: async () => {}, appReadyPollTries: 2, ...extra,
  });

  test("ok paper → status ok with App score + ansVersion", async () => {
    const results = recorder();
    const r = await grindSpeakGaps(ports(scenario({}), { results }) as never, 1, 1);
    assert.equal(r.completed, 1);
    assert.deepEqual(results.lines, [{
      skill: "说", taskId: "555", ansVersion: 1, score: 90, scoreIsOut: true, status: "ok", error: null,
    }]);
  });

  test("low App score → low_score line; still grading → grading line", async () => {
    const low = recorder();
    await grindSpeakGaps(ports(scenario({ history: () => ({ taskId: "555", scoreIsOut: true, score: 74, ansVersion: 1 }) }), { results: low }) as never, 1, 1);
    assert.equal(low.lines[0]!.status, "low_score");
    assert.equal(low.lines[0]!.score, 74);
    assert.equal(low.lines[0]!.scoreIsOut, true);
    const grading = recorder();
    await grindSpeakGaps(ports(scenario({ history: () => ({ taskId: "555", scoreIsOut: false, score: 0, ansVersion: 1 }) }), { results: grading }) as never, 1, 1);
    assert.equal(grading.lines[0]!.status, "grading");
    assert.equal(grading.lines[0]!.scoreIsOut, false);
  });

  test("taskId+ansVersion already in the ledger → skipped_existing, nothing loaded or submitted", async () => {
    const http = scenario({});
    const results = recorder(["说|555|1"]);
    const r = await grindSpeakGaps(ports(http, { results }) as never, 1, 1);
    assert.equal(r.completed, 0);
    assert.equal(results.lines[0]!.status, "skipped_existing");
    assert.equal(http.calls.filter((c) => c.url.includes("loadPaper")).length, 0);
    assert.equal(submitCalls(http).length, 0);
  });
});

describe("grindSpeakGaps rounds (#88)", () => {
  test("maxRounds defaults to max(5, need): need=7 submits 7 papers", async () => {
    let n = 0;
    const inner = scenario({});
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        n++;
        // per round: before + completeOneSpeak see the same task, after sees the next one
        const taskId = n % 3 === 0 ? `9${n}` : `${Math.ceil(n / 3)}`;
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId, ansVersion: 1, status: 1 } }) };
      }
      if (call.url.includes("getHistoryTrainingTasks")) {
        const list = Array.from({ length: 10 }, (_, i) => ({ taskId: String(i + 1), ansVersion: 1, score: 90, scoreIsOut: true }));
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { page: 1, pageSize: 20, total: 10, totalPages: 1, list } }) };
      }
      return inner.request(call);
    });
    const r = await grindSpeakGaps({
      credentials: { getJwt: async () => JWT }, http, env: {}, llmAsk: okAsk, speechRecord: okSpeech, sleep: async () => {}, appReadyPollTries: 1,
    } as never, 7);
    assert.equal(r.completed, 7, String(r.stoppedReason));
  });
});

describe("no template submit (Sein: 没答案不要用模板交)", () => {
  const recording = () => {
    const texts: string[] = [];
    const speech = async (t: string, _g: string, type: SpeechRecordType) => {
      texts.push(t);
      return { type, url: "u", recordDetail: { score: 90 } };
    };
    return { texts, speech };
  };

  test("no UNIPUS_LLM_* config (SiliconFlow key only) → refused: no TTS/upload, no part/submit", async () => {
    const http = scenario({});
    const { texts, speech } = recording();
    const r = await run(http, speech, null, { SILICONFLOW_API_KEY: "k" });
    assert.equal(r.ok, false);
    assert.equal((r as { refused?: boolean }).refused, true);
    assert.match((r as { detail: string }).detail, /ANSWER_REFUSED/);
    assert.equal(texts.length, 0);
    assert.equal(submitCalls(http).length, 0);
  });

  test("LLM keeps failing → refused: free talk never voiced, no part/submit", async () => {
    const http = scenario({});
    const { texts, speech } = recording();
    let n = 0;
    const r = await run(http, speech, async () => { n++; throw new Error("HTTP 502"); });
    assert.equal(r.ok, false);
    assert.equal((r as { refused?: boolean }).refused, true);
    assert.ok(n >= 3);
    assert.equal(texts.length, 0);
    assert.equal(submitCalls(http).length, 0);
  });

  test("free talk voiced from the LLM text", async () => {
    const http = scenario({});
    const { texts, speech } = recording();
    const r = await run(http, speech);
    assert.equal(r.ok, true);
    assert.deepEqual(texts, [FREE_TALK]);
  });

  test("resume: free talk already submitted → not regenerated; LLM down does not block pending parts", async () => {
    const http = scenario({
      parts: () => [
        { partId: "p1", partName: "范例学习", questionInstanceIds: ["111"], reportStatus: null, submitted: null },
        { partId: "p2", partName: "自由表达", questionInstanceIds: ["222"], reportStatus: "completed", submitted: true },
      ],
    });
    const { texts, speech } = recording();
    let n = 0;
    const r = await run(http, speech, async () => { n++; throw new Error("HTTP 502"); });
    assert.equal(n, 0);
    assert.equal(texts.length, 0);
    assert.equal((r as { refused?: boolean }).refused, undefined);
    assert.deepEqual([...new Set(submitCalls(http).map((c) => JSON.parse(String(c.body)).partId))], ["p1"]);
  });

  test("grindSpeakGaps: refusal counts as failure and stops (no next paper)", async () => {
    const http = scenario({});
    const r = await grindSpeakGaps(
      { credentials: { getJwt: async () => JWT }, http, env: {}, llmAsk: async () => { throw new Error("down"); }, speechRecord: okSpeech, sleep: async () => {} },
      3,
      5,
    );
    assert.equal(r.completed, 0);
    assert.equal(r.refused, true);
    assert.equal(http.calls.filter((c) => c.url.includes("loadPaper")).length, 1);
    assert.equal(submitCalls(http).length, 0);
  });

  test("grindSpeakGaps without LLM config → refused before loading any paper", async () => {
    const http = scenario({});
    const r = await grindSpeakGaps({ credentials: { getJwt: async () => JWT }, http, env: {}, speechRecord: okSpeech }, 2);
    assert.equal(r.refused, true);
    assert.equal(http.calls.filter((c) => c.url.includes("loadPaper")).length, 0);
  });
});
