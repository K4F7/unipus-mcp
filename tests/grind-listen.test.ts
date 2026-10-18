import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { NO_LLM_WARNING, completeOneListen, grindListenGaps } from "../src/grind-listen.js";
import { mockHttp } from "./mock-http.js";

const paper = [{
  q_qinstid: "1985995334422880257",
  q_template_name: "single-choice_objective",
  is_objective: true,
  nm: "听力_单选_客观题",
  q_qinst_struct: JSON.stringify({
    replyType: "singlechoice",
    contents: [{ text: "<p>Greater <strong>flexibility</strong>.</p>" }],
    options: [{ value: "A", text: "capability" }, { value: "B", text: "flexibility" }],
  }),
}];

function http() {
  let n = 0;
  return mockHttp(async (call) => {
    if (call.url.includes("getUserStatus")) {
      n++;
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: `10000000000000000${n}`, ansVersion: 1 } }) };
    }
    if (call.url.includes("loadPaper")) {
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { token: "tok", paperJson: JSON.stringify(paper) } }) };
    }
    return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
  });
}

const submits = (h: ReturnType<typeof http>) => h.calls.filter((c) => c.url.includes("submitAnswer"));

describe("grind-listen solver paths", () => {
  test("LLM failure after retries → paper not submitted", async () => {
    const h = http();
    const r = await completeOneListen({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => { throw new Error("HTTP 503"); },
    } as never);
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /not submitted[\s\S]*HTTP 503/);
    assert.equal(submits(h).length, 0);
  });

  test("UNIPUS_LLM_SOLVER=off → explicit heuristic submit + summary warning", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h,
      env: { SILICONFLOW_API_KEY: "k", UNIPUS_LLM_SOLVER: "off" },
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 1, 1);
    assert.equal(r.completed, 1);
    assert.deepEqual(r.warnings, [NO_LLM_WARNING]);
    const body = JSON.parse(submits(h)[0]!.body!);
    assert.match(JSON.stringify(body), /\\"B\\"/);
  });

  test("invalid LLM letter → submitted with per-question warning", async () => {
    const h = http();
    const r = await completeOneListen({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => '{"answers":["Z"]}',
    } as never);
    assert.equal(r.ok, true);
    assert.deepEqual((r as { warnings: string[] }).warnings, ["听力_单选_客观题: 1 道单选（已用启发式补）无有效 LLM 答案"]);
    assert.equal(submits(h).length, 1);
  });
});

describe("grind-listen per-paper results (#88)", () => {
  const withHistory = (item: Record<string, unknown> | null) => {
    return mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: "100000000000000001", ansVersion: 2 } }) };
      }
      if (call.url.includes("loadPaper")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { token: "tok", paperJson: JSON.stringify(paper) } }) };
      }
      if (call.url.includes("getHistoryTrainingTasks")) {
        const list = item ? [{ ...item, taskId: "100000000000000001" }] : [];
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { page: 1, pageSize: 20, total: list.length, totalPages: 1, list } }) };
      }
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
    });
  };
  const run = (h: ReturnType<typeof mockHttp>, submittedKeys: string[] = []) => {
    const lines: Array<Record<string, unknown>> = [];
    const results = {
      report: async (r: Record<string, unknown>) => void lines.push(r),
      isSubmitted: (s: string, t: string, v: number) => submittedKeys.includes(`${s}|${t}|${v}`),
    };
    return grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1, scorePollTries: 2, results,
    } as never, 1, 1).then((r) => ({ r, lines }));
  };

  test("submitted paper → line with App history score", async () => {
    const { lines } = await run(withHistory({ ansVersion: 2, score: 98, scoreIsOut: true }));
    assert.deepEqual(lines, [{
      skill: "听", taskId: "100000000000000001", ansVersion: 2, score: 98, scoreIsOut: true, status: "ok", error: null,
    }]);
  });

  test("score not out yet → grading line (grind itself still succeeds)", async () => {
    const { r, lines } = await run(withHistory(null));
    assert.equal(r.completed, 1);
    assert.equal(lines[0]!.status, "grading");
    assert.match(String(lines[0]!.error), /未出分/);
  });

  test("history lookup throwing after submit → grading line, paper still counted", async () => {
    const base = withHistory(null);
    const h = { calls: base.calls, request: async (c: never) => {
      if (String((c as { url: string }).url).includes("getHistoryTrainingTasks")) throw new Error("The operation was aborted due to timeout");
      return base.request(c);
    } };
    const { r, lines } = await run(h as never);
    assert.equal(r.completed, 1);
    assert.equal(lines[0]!.status, "grading");
    assert.match(String(lines[0]!.error), /timeout/);
  });

  test("ledger hit → skipped_existing, no submitAnswer", async () => {
    const h = withHistory(null);
    const { r, lines } = await run(h, ["听|100000000000000001|2"]);
    assert.equal(r.completed, 0);
    assert.equal(lines[0]!.status, "skipped_existing");
    assert.equal(h.calls.filter((c) => c.url.includes("submitAnswer")).length, 0);
  });
});

describe("grind-listen rounds (#88)", () => {
  test("maxRounds defaults to max(8, need): a 12-paper week finishes all 12", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 12);
    assert.equal(r.completed, 12);
    assert.equal(submits(h).length, 12);
  });

  test("a throw mid-round keeps earlier completions and reports errorClass", async () => {
    let calls = 0;
    const base = http();
    const h = { calls: base.calls, request: async (c: never) => {
      if (String((c as { url: string }).url).includes("loadPaper") && ++calls === 2) throw new Error("fetch failed ECONNRESET");
      return base.request(c);
    } };
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 3);
    assert.equal(r.completed, 1);
    assert.equal(r.errorClass, "NETWORK");
    assert.match(String(r.stoppedReason), /^NETWORK: .*ECONNRESET/);
  });
});
