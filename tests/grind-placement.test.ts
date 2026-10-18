import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { completeOnePlacement } from "../src/grind-placement.js";
import { mockHttp } from "./mock-http.js";

const objectiveLeaf = {
  q_qinstid: "11",
  q_template_name: "single-choice",
  is_objective: true,
  nm: "定级单选",
  data: {
    contents: [{ text: "choose <b>beta</b>" }],
    children: [{ quesText: "Which?", options: [{ value: "A", text: "alpha" }, { value: "B", text: "beta" }] }],
  },
};

function http(leaves: unknown[]) {
  return mockHttp(async (call) => {
    if (call.url.includes("getUserStatus")) {
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "grade", taskId: "g1", ansVersion: 1 } }) };
    }
    if (call.url.includes("loadPaper")) {
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { token: "tok", paperJson: JSON.stringify({ chr: leaves }) } }) };
    }
    return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
  });
}

const base = { credentials: { getJwt: async () => "jwt" }, sleep: async () => {}, maxPolls: 1, env: {} };
const submits = (h: ReturnType<typeof http>) => h.calls.filter((c) => c.url.includes("submitAnswer"));

describe("placement answers come only from the LLM", () => {
  test("no LLM config → refused, nothing submitted (no heuristic)", async () => {
    const h = http([objectiveLeaf]);
    const r = await completeOnePlacement({ ...base, http: h } as never, "listen");
    assert.equal(r.ok, false);
    assert.equal((r as { refused?: boolean }).refused, true);
    assert.match((r as { detail: string }).detail, /not submitted[\s\S]*ANSWER_REFUSED/);
    assert.equal(submits(h).length, 0);
  });

  test("LLM failure → refused, nothing submitted", async () => {
    const h = http([objectiveLeaf]);
    const r = await completeOnePlacement(
      { ...base, http: h, llmAsk: async () => { throw new Error("HTTP 500"); } } as never,
      "listen",
    );
    assert.equal(r.ok, false);
    assert.equal((r as { refused?: boolean }).refused, true);
    assert.equal(submits(h).length, 0);
  });

  test("answer-bearing leaf the LLM can't answer (record) → refused, not marked done", async () => {
    const h = http([{ q_qinstid: "12", q_template_name: "oral-sentence", nm: "跟读", data: { replyType: "record" } }]);
    const r = await completeOnePlacement({ ...base, http: h, llmAsk: async () => '{"answers":["B"]}' } as never, "speak");
    assert.equal(r.ok, false);
    assert.equal((r as { refused?: boolean }).refused, true);
    assert.equal(submits(h).length, 0);
  });

  test("LLM letter is what gets submitted", async () => {
    const h = http([objectiveLeaf, { q_qinstid: "13", q_template_name: "content-learn", nm: "导读", data: {} }]);
    const r = await completeOnePlacement({ ...base, http: h, llmAsk: async () => '{"answers":["A"]}' } as never, "listen");
    assert.equal(r.ok, true);
    assert.equal(submits(h).length, 1);
    assert.match(submits(h)[0]!.body!, /\\"A\\"/);
  });
});
