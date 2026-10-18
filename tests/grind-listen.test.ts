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
  test("default round budget fills a twelve-paper target", async () => {
    const h = http();
    const result = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {},
    }, 12);
    assert.equal(result.completed, 12);
    assert.equal(submits(h).length, 12);
  });

  test("network failure after a submission retains task ids and completion count", async () => {
    const h = http();
    const result = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" },
      http: {
        request: async (call) => {
          if (submits(h).length > 0 && call.url.includes("getUserStatus")) throw new Error("ECONNRESET");
          return h.request(call);
        },
      },
      env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {},
    }, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.taskIds.length, 1);
    assert.match(result.stoppedReason!, /ECONNRESET/);
    assert.equal(result.errorClass, "NETWORK");
    assert.equal(submits(h).length, 1);
  });

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
