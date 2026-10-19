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

const FREE_TALK = Array.from({ length: 220 }, (_, i) => (i % 10 === 9 ? "music." : "music")).join(" ");
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
    assert.equal(results.lines.length, 1);
    const { parts, flags, ...line } = results.lines[0]!;
    assert.deepEqual(line, { skill: "说", taskId: "555", ansVersion: 1, score: 90, scoreIsOut: true, status: "ok", error: null });
    assert.deepEqual(Object.keys(parts as object).sort(), ["自由表达", "范例学习"]);
    assert.deepEqual(flags, []);
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

  test("ledger hit but App history lacks the paper → answered, not skipped (#100)", async () => {
    let historyCalls = 0;
    const http = scenario({ history: () => (historyCalls++ === 0 ? null : { taskId: "555", scoreIsOut: true, score: 90, ansVersion: 1 }) });
    const results = recorder(["说|555|1"]);
    const r = await grindSpeakGaps(ports(http, { results }) as never, 1, 1);
    assert.equal(r.completed, 1);
    assert.equal(results.lines[0]!.status, "ok");
  });

  test("every answer step runs inside its part budget: LLM / TTS / Clio / upload see ≤ UNIPUS_PART_MAX_MS left (#100)", async () => {
    const { remainingBudgetMs } = await import("../src/watchdog.js");
    const left: number[] = [];
    const speechRecord = async (t: string, g: string, type: SpeechRecordType) => (left.push(remainingBudgetMs()), okSpeech(t, g, type));
    const llmAsk = async () => (left.push(remainingBudgetMs()), okAsk());
    await grindSpeakGaps(ports(scenario({}), { env: { UNIPUS_PART_MAX_MS: "60000" }, speechRecord, llmAsk }) as never, 1, 1);
    assert.ok(left.length > 0);
    for (const ms of left) assert.ok(ms > 0 && ms <= 60_000, String(ms));
  });

  test("taskId+ansVersion already in the ledger and App history → skipped_existing, nothing loaded or submitted", async () => {
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

// ---- #92: AI part like the App, part-report scores in JSONL, free-talk duration, wall caps ----
import { writeFile as writeFileGs } from "node:fs/promises";
import { SpeechTooShortError } from "../src/scored-speech.js";

const aiPaper = {
  token: "paper-tok",
  paperJson: JSON.stringify({
    chr: [
      ...JSON.parse(paper.paperJson).chr,
      { q_qinstid: "333", q_template_name: "ai-dialog", nm: "ai", data: { contents: [{ text: "<p>Talk with AI about the music you like.</p>" }] } },
    ],
  }),
};
const threeParts = (): PartRow[] => [
  ...twoParts(),
  { partId: "p3", partName: "AI口语对话", questionInstanceIds: ["333"], reportStatus: null, submitted: null },
];
const reportBody = (partId: string, aiOut: boolean) =>
  partId === "p1" ? { code: 200, data: { "oral-sentence-scoop_subjective": { totalScore: 97 } } }
  : partId === "p2" ? { code: 200, data: { "oral-personal-state_subjective": { totalScore: 88, userResponse: { fullText: "I like music a lot" } } } }
  : aiOut ? { code: 200, data: { "ai-spoken_subjective": { totalScore: 91 } } }
  : { code: 500, message: "报告尚未生成完成", data: null };
/** scenario() + paper with an AI part + conversation/ebcp/upload + part-report endpoints. */
function aiScenario(opts: { aiReportOut?: boolean; submit?: (b: { action: string; partId: string }) => { code: number; msg?: string } } = {}) {
  const inner = scenario({ parts: threeParts, submit: opts.submit });
  return mockHttp(async (call) => {
    if (call.url.includes("loadPaper")) return { statusCode: 200, body: JSON.stringify({ code: 1, value: aiPaper }) };
    const pr = /part-report\?.*partId=(\w+)/.exec(call.url);
    if (pr) return { statusCode: 200, body: JSON.stringify(reportBody(pr[1]!, opts.aiReportOut === true)) };
    if (/conversation|ebcp|query-upload|upload-url/.test(call.url)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ code: 200, data: { conversationId: "9001", sceneId: "1", token: "t", record: { list: [] } }, value: { token: "qt", path: "p.wav", url: "https://cdn.example/p.wav" } }),
      };
    }
    return inner.request(call);
  });
}
const dialogReply = "I like pop music the most because the melodies are catchy and they help me relax after a long day of classes.";
const aiRun = (http: ReturnType<typeof mockHttp>, extra: Record<string, unknown> = {}) =>
  completeOneSpeak({
    credentials: { getJwt: async () => JWT }, http, env: { UNIPUS_AI_TURN_MIN_MS: "0" },
    llmAsk: async (p: string) => (/AI just said/.test(p) ? dialogReply : FREE_TALK), speechRecord: okSpeech,
    sleep: async () => {}, appReadyPollTries: 2,
    uploadFetch: async () => new Response("{}", { status: 200 }),
    synthesizeLocalWav: async (_t: string, wav: string) => writeFileGs(wav, Buffer.alloc(44 + 32000 * 5)),
    openDialogSocket: () => ({
      nextReply: async () => ({ asr: "I like pop.", text: "Nice! Why?", audio: Buffer.alloc(32000 * 3) }),
      sendAudio() {}, close() {},
    }),
    ...extra,
  } as never);

describe("#92 speak paper", () => {
  test("AI part: ONE part/submit (no snapshot), no instStatus, no u-app-id; other parts keep snapshot→submit+instStatus", async () => {
    const http = aiScenario({ aiReportOut: true });
    const r = await aiRun(http);
    assert.equal(r.ok, true, (r as { detail?: string }).detail);
    const subs = submitCalls(http).map((c) => ({ c, b: JSON.parse(String(c.body)) }));
    const ai = subs.filter((x) => x.b.partId === "p3");
    assert.deepEqual(ai.map((x) => x.b.action), ["submit"]);
    assert.equal(ai[0]!.b.userData[0].instStatus, undefined);
    assert.equal(ai[0]!.b.userData[0].context, JSON.stringify({ state: "done" }));
    assert.equal(ai[0]!.c.headers?.["u-app-id"], undefined);
    assert.match(ai[0]!.c.url, /ucloud/);
    assert.ok(ai[0]!.b.duration >= 1);
    const p1 = subs.filter((x) => x.b.partId === "p1");
    assert.deepEqual(p1.map((x) => x.b.action), ["snapshot", "submit"]);
    assert.equal(p1[1]!.b.userData[0].instStatus, 1);
  });

  test("AI dialog LLM calls run inside the part budget (#100)", async () => {
    const { remainingBudgetMs } = await import("../src/watchdog.js");
    const dialogLeft: number[] = [];
    const r = await aiRun(aiScenario({ aiReportOut: true }), {
      env: { UNIPUS_AI_TURN_MIN_MS: "0", UNIPUS_PART_MAX_MS: "60000" },
      llmAsk: async (p: string) => {
        if (!/AI just said/.test(p)) return FREE_TALK;
        dialogLeft.push(remainingBudgetMs());
        return dialogReply;
      },
    });
    assert.equal(r.ok, true, (r as { detail?: string }).detail);
    assert.ok(dialogLeft.length > 0);
    for (const ms of dialogLeft) assert.ok(ms > 0 && ms <= 60_000, String(ms));
  });

  test("part-report scores of all three parts land in the result; AI report never out → ai_report_missing", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const results = { report: async (l: Record<string, unknown>) => void lines.push(l), isSubmitted: () => false };
    const r = await grindSpeakGaps({
      credentials: { getJwt: async () => JWT }, http: aiScenario({ aiReportOut: false }), env: { UNIPUS_AI_TURN_MIN_MS: "0", UNIPUS_AI_REPORT_MAX_MS: "60000" },
      llmAsk: async (p: string) => (/AI just said/.test(p) ? dialogReply : FREE_TALK), speechRecord: okSpeech, sleep: async () => {}, appReadyPollTries: 2,
      uploadFetch: async () => new Response("{}", { status: 200 }),
      synthesizeLocalWav: async (_t: string, wav: string) => writeFileGs(wav, Buffer.alloc(44 + 32000 * 5)),
      openDialogSocket: () => ({ nextReply: async () => ({ asr: "I like pop.", text: "Nice! Why?", audio: Buffer.alloc(32000) }), sendAudio() {}, close() {} }),
      results,
    } as never, 1, 1);
    assert.equal(r.completed, 1);
    const line = lines[0]!;
    assert.equal(line.status, "ok");
    const parts = line.parts as Record<string, { score: number | null; status: string; asrWords?: number }>;
    assert.equal(parts["范例学习"]!.score, 97);
    assert.equal(parts["自由表达"]!.score, 88);
    assert.equal(parts["自由表达"]!.asrWords, 5);
    assert.equal(parts["AI口语对话"]!.status, "pending");
    assert.deepEqual(line.flags, ["ai_report_missing"]);
  });

  test("AI report generated → AI score recorded, no flag", async () => {
    const lines: Array<Record<string, unknown>> = [];
    await grindSpeakGaps({
      credentials: { getJwt: async () => JWT }, http: aiScenario({ aiReportOut: true }), env: { UNIPUS_AI_TURN_MIN_MS: "0" },
      llmAsk: async (p: string) => (/AI just said/.test(p) ? dialogReply : FREE_TALK), speechRecord: okSpeech, sleep: async () => {}, appReadyPollTries: 2,
      uploadFetch: async () => new Response("{}", { status: 200 }),
      synthesizeLocalWav: async (_t: string, wav: string) => writeFileGs(wav, Buffer.alloc(44 + 32000 * 5)),
      openDialogSocket: () => ({ nextReply: async () => ({ asr: "I like pop.", text: "Nice! Why?", audio: Buffer.alloc(32000) }), sendAudio() {}, close() {} }),
      results: { report: async (l: Record<string, unknown>) => void lines.push(l), isSubmitted: () => false },
    } as never, 1, 1);
    assert.equal((lines[0]!.parts as Record<string, { score: number }>)["AI口语对话"]!.score, 91);
    assert.deepEqual(lines[0]!.flags, []);
  });

  test("free talk is voiced slower with a ≥90 s gate; words + seconds reach the result", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const speech = async (_t: string, _g: string, type: SpeechRecordType, o?: { minSec?: number; speed?: number; onAudio?: (s: number) => void }) => {
      seen.push(o as never);
      if (type === "EN_PRED_SCORE") o?.onAudio?.(95.5);
      return { type, url: "u", recordDetail: { score: 90 } };
    };
    const lines: Array<Record<string, unknown>> = [];
    await grindSpeakGaps({
      credentials: { getJwt: async () => JWT }, http: scenario({}), env: {}, llmAsk: okAsk, speechRecord: speech, sleep: async () => {}, appReadyPollTries: 1,
      results: { report: async (l: Record<string, unknown>) => void lines.push(l), isSubmitted: () => false },
    } as never, 1, 1);
    const free = seen.find((o) => o?.minSec != null)!;
    assert.equal(free.minSec, 90);
    assert.equal(free.speed, 0.85);
    const p = (lines[0]!.parts as Record<string, { words?: number; sec?: number }>)["自由表达"]!;
    assert.equal(p.words, 220);
    assert.equal(p.sec, 95.5);
  });

  test("free talk audio too short → regenerated (bounded), then refused with no part/submit", async () => {
    const http = scenario({});
    let asks = 0;
    const r = await run(http, (async (_t: string, _g: string, type: SpeechRecordType) => {
      if (type === "EN_PRED_SCORE") throw new SpeechTooShortError(70, 90);
      return { type, url: "u", recordDetail: { score: 90 } };
    }) as never, async () => { asks++; return FREE_TALK; });
    assert.equal(r.ok, false);
    assert.equal((r as { refused?: boolean }).refused, true);
    assert.match((r as { detail: string }).detail, /70\.0s < 90s/);
    assert.equal(asks, 3);
    assert.equal(submitCalls(http).length, 0);
  });

  test("paper wall cap passed before a part → stop before submitting it", async () => {
    const http = scenario({});
    let t = 0;
    const r = await completeOneSpeak({
      credentials: { getJwt: async () => JWT }, http, env: { UNIPUS_PAPER_MAX_MS: "60000" }, llmAsk: okAsk,
      speechRecord: (async (_x: string, _g: string, type: SpeechRecordType) => { t += 70_000; return { type, url: "u", recordDetail: { score: 90 } }; }) as never,
      sleep: async () => {}, appReadyPollTries: 1, clockMs: () => t,
    } as never);
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /整卷.*上限/);
    assert.equal(submitCalls(http).length, 0);
  });
});

describe("grindSpeakGaps per-paper skip + consecutive-failure stop (#98)", () => {
  const recorder = () => {
    const lines: Array<Record<string, unknown>> = [];
    return { lines, report: async (l: Record<string, unknown>) => void lines.push(l), isSubmitted: () => false };
  };
  const gaps = (http: ReturnType<typeof mockHttp>, speechRecord: unknown, need: number, extra: Record<string, unknown> = {}) => {
    const results = recorder();
    return grindSpeakGaps({
      credentials: { getJwt: async () => JWT }, http, env: {}, llmAsk: okAsk, speechRecord, sleep: async () => {}, appReadyPollTries: 1, results, ...extra,
    } as never, need).then((r) => ({ r, lines: results.lines }));
  };
  const loads = (h: ReturnType<typeof mockHttp>) => h.calls.filter((c) => c.url.includes("loadPaper")).length;

  test("TTS timeout on one paper → recorded and skipped, the next round goes on", async () => {
    let n = 0;
    const speech = async (t: string, g: string, type: SpeechRecordType) => {
      if (++n === 1) throw new Error("speak-111-0：4 次均失败（600000ms）：Clio 评分失败：Clio WSS 超时 (45000ms)");
      return okSpeech(t, g, type);
    };
    const { r, lines } = await gaps(scenario({}), speech, 1);
    assert.equal(r.completed, 1);
    assert.deepEqual(lines.map((l) => l.status), ["failed", "ok"]);
    assert.match(String(lines[0]!.error), /tts\/upload TIMEOUT: .*Clio WSS 超时/);
    assert.match(String(r.warnings), /跳过/);
  });

  test("UNIPUS_MAX_CONSECUTIVE_FAILURES papers failing in a row stop the account", async () => {
    const http = scenario({});
    const { r, lines } = await gaps(http, async () => { throw new Error("TTS 重试总时长上限 timed out (599999ms)"); }, 3);
    assert.equal(r.completed, 0);
    assert.match(String(r.stoppedReason), /连续 2 张失败/);
    assert.equal(r.errorClass, "TIMEOUT");
    assert.equal(lines.length, 2);
    assert.equal(loads(http), 2);
  });

  test("low App score is recorded and the grind continues (streak still bounded)", async () => {
    const http = scenario({ history: () => ({ taskId: "555", scoreIsOut: true, score: 74, ansVersion: 1 }) });
    const { r, lines } = await gaps(http, okSpeech, 3);
    assert.deepEqual(lines.map((l) => l.status), ["low_score", "low_score"]);
    assert.match(String(r.stoppedReason), /连续 2 张失败/);
  });

  test("refusal still stops at once (unchanged)", async () => {
    const http = scenario({});
    const { r } = await gaps(http, okSpeech, 3, { llmAsk: async () => { throw new Error("down"); } });
    assert.equal(r.refused, true);
    assert.equal(loads(http), 1);
  });

  test("no jwt → stops at once", async () => {
    const http = scenario({});
    const { r } = await gaps(http, okSpeech, 3, { credentials: { getJwt: async () => null } });
    assert.match(String(r.stoppedReason), /no jwt/);
    assert.equal(loads(http), 0);
  });
});

describe("speak part/submit 4021 (#98)", () => {
  const busy = { code: 4021, msg: "请勿多设备同时作答，作答数据可能丢失，请重新加载试卷" };
  const runWith = (http: ReturnType<typeof mockHttp>, env: Record<string, string> = {}) => {
    const sleeps: number[] = [];
    return completeOneSpeak({
      credentials: { getJwt: async () => JWT }, http, env, llmAsk: okAsk, speechRecord: okSpeech,
      sleep: async (ms: number) => void sleeps.push(ms), appReadyPollTries: 1,
    }).then((r) => ({ r, sleeps }));
  };

  test("4021 → wait, same paper still current, fresh loadPaper token, part re-sent", async () => {
    let n = 0;
    const http = scenario({ submit: () => (++n === 1 ? busy : { code: 1 }) });
    const { r, sleeps } = await runWith(http);
    assert.equal(r.ok, true, (r as { detail?: string }).detail);
    assert.ok(sleeps.includes(60_000), String(sleeps));
    assert.equal(http.calls.filter((c) => c.url.includes("loadPaper")).length, 2);
    const p1 = submitCalls(http).map((c) => JSON.parse(String(c.body))).filter((b) => b.partId === "p1");
    assert.deepEqual(p1.map((b) => b.action), ["snapshot", "snapshot", "submit"]);
  });

  test("4021 but part/get now shows the part submitted → not re-sent, next part continues", async () => {
    let n = 0;
    let p1Done = false;
    const http = scenario({
      submit: (b) => { if (b.partId === "p1" && ++n === 1) { p1Done = true; return busy; } return { code: 1 }; },
      parts: () => twoParts().map((p) => (p.partId === "p1" && p1Done ? { ...p, submitted: true } : p)),
    });
    const { r } = await runWith(http);
    assert.equal(r.ok, true, (r as { detail?: string }).detail);
    const p1 = submitCalls(http).map((c) => JSON.parse(String(c.body))).filter((b) => b.partId === "p1");
    assert.equal(p1.length, 1);
    assert.equal(http.calls.filter((c) => c.url.includes("loadPaper")).length, 1, "no fresh token taken when nothing is re-sent");
  });

  test("4021 and part/get inconclusive → conservatively not re-sent, no fresh token", async () => {
    let gets = 0;
    const inner = scenario({ submit: () => busy });
    const http = mockHttp(async (call) => {
      if (call.url.includes("part/get") && ++gets > 1) return { statusCode: 500, body: "oops" };
      return inner.request(call);
    });
    const { r } = await runWith(http);
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /4021 后不重交/);
    assert.equal(submitCalls(http).length, 1);
    assert.equal(http.calls.filter((c) => c.url.includes("loadPaper")).length, 1);
  });

  test("4021 and the server moved to another paper → nothing re-sent, paper fails with the reason", async () => {
    let status = 0;
    const inner = scenario({ submit: () => busy });
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus") && ++status > 1) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: "777", ansVersion: 1, status: 1 } }) };
      }
      return inner.request(call);
    });
    const { r } = await runWith(http);
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /4021.*不重交.*已变/);
    assert.equal(submitCalls(http).length, 1);
  });

  test("4021 every time → bounded retries, then the paper fails", async () => {
    const http = scenario({ submit: () => busy });
    const { r } = await runWith(http, { UNIPUS_CONCURRENT_RETRIES: "2" });
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /4021.*已重试 2 次/);
    assert.equal(submitCalls(http).length, 3);
  });
});
