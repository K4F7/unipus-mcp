import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { completeOneListen, grindListenGaps } from "../src/grind-listen.js";
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

  test("no UNIPUS_LLM_* config (SiliconFlow key only) → refused, nothing submitted, loop stops", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h,
      env: { SILICONFLOW_API_KEY: "k" },
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 3, 3);
    assert.equal(r.completed, 0);
    assert.equal(r.refused, true);
    assert.match(r.stoppedReason!, /ANSWER_REFUSED[\s\S]*UNIPUS_LLM_BASE_URL/);
    assert.equal(submits(h).length, 0);
    assert.equal(h.calls.filter((c) => c.url.includes("loadPaper")).length, 0);
  });

  test("invalid LLM letter → refused, nothing submitted, no heuristic", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => '{"answers":["Z"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 3, 3);
    assert.equal(r.completed, 0);
    assert.equal(r.refused, true);
    assert.match(r.stoppedReason!, /not submitted[\s\S]*ANSWER_REFUSED/);
    assert.equal(submits(h).length, 0);
  });

  test("valid LLM letter → submitted with that letter", async () => {
    const h = http();
    const r = await completeOneListen({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => '{"answers":["A"]}',
    } as never);
    assert.equal(r.ok, true);
    assert.equal(submits(h).length, 1);
    assert.match(submits(h)[0]!.body!, /\\"A\\"/);
  });
});
