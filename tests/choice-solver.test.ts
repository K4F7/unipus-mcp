import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LLM_SOLVE_ATTEMPTS,
  LlmSolveError,
  buildSolvedFillblankAnswer,
  buildSolvedObjectiveAnswer,
  parseChoiceAnswers,
  resolveChoiceSolverConfig,
} from "../src/choice-solver.js";

const opts = [
  { name: "A", value: "A", text: "<p>Friends.</p>" },
  { name: "B", value: "B", text: "<p>Neighbors.</p>" },
];

describe("choice-solver", () => {
  test("config off without key or with UNIPUS_LLM_SOLVER=off", () => {
    assert.equal(resolveChoiceSolverConfig({}), null);
    assert.equal(resolveChoiceSolverConfig({ UNIPUS_LLM_API_KEY: "k", UNIPUS_LLM_SOLVER: "off" }), null);
    assert.equal(resolveChoiceSolverConfig({ UNIPUS_LLM_API_KEY: "k" })?.model, "deepseek-ai/DeepSeek-V3");
  });

  test("parseChoiceAnswers keeps only valid option letters", () => {
    const qs = [{ question: "q", options: [{ value: "A", text: "" }, { value: "B", text: "" }] }];
    assert.deepEqual(parseChoiceAnswers('sure: {"answers":["b"]}', qs), ["B"]);
    assert.deepEqual(parseChoiceAnswers('{"answers":["Z"]}', qs), [null]);
    assert.deepEqual(parseChoiceAnswers("garbage", qs), [null]);
  });

  test("multi-child: LLM picks win, invalid letter → heuristic and counted", async () => {
    const data = {
      contents: [{ text: "<p>We are <strong>Neighbors.</strong></p>" }],
      children: [
        { contents: [{ text: "Q1?" }], options: opts },
        { contents: [{ text: "Q2?" }], options: opts },
      ],
    };
    const seen: string[] = [];
    const out = await buildSolvedObjectiveAnswer(data, async (prompt) => {
      seen.push(prompt);
      return '{"answers":["A","?"]}';
    });
    assert.match(seen[0]!, /We are Neighbors\.[\s\S]*Q1\. Q1\?[\s\S]*Q2\. Q2\?/);
    assert.deepEqual(JSON.parse(out.answer).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);
    assert.equal(out.unanswered, 1);
  });

  test("video item: question from quesText, context from WebVTT subtitles", async () => {
    const data = {
      contents: [{ type: 2, subtitles: [{ path: "https://birdflock.unipus.cn/s.vtt" }] }],
      children: [{ quesText: "Who?", options: opts }],
    };
    let prompt = "";
    await buildSolvedObjectiveAnswer(
      data,
      async (p) => ((prompt = p), '{"answers":["B"]}'),
      async () => "WEBVTT\n\n1\n00:00.000 --> 00:01.000\nWe are neighbors.\n",
    );
    assert.match(prompt, /We are neighbors\.[\s\S]*Q1\. Who\?/);
  });

  test("LLM retries transient failure / bad JSON, then succeeds", async () => {
    const replies = [() => { throw new Error("timeout"); }, () => "not json", () => '{"answers":["B"]}'];
    let n = 0;
    const out = await buildSolvedObjectiveAnswer({ options: opts }, async () => replies[n++]!());
    assert.equal(n, LLM_SOLVE_ATTEMPTS);
    assert.deepEqual(JSON.parse(out.answer).children[0].value, ["B"]);
  });

  test("objective: LLM keeps failing → throws LlmSolveError (no heuristic fallback)", async () => {
    let n = 0;
    await assert.rejects(
      buildSolvedObjectiveAnswer({ options: opts }, async () => { n++; throw new Error("HTTP 500"); }),
      (e: unknown) => e instanceof LlmSolveError && /HTTP 500/.test((e as Error).message),
    );
    assert.equal(n, LLM_SOLVE_ATTEMPTS);
  });

  test("fillblank: LLM answers per blank; failure throws; off (null) = empty blanks counted", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    const out = await buildSolvedFillblankAnswer(data, async () => '{"answers":["marine",""]}');
    assert.deepEqual(JSON.parse(out.answer).children, [
      { value: ["marine"], isDone: true },
      { value: [""], isDone: true },
    ]);
    assert.equal(out.unanswered, 1);
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => "garbage"), LlmSolveError);
    const off = await buildSolvedFillblankAnswer(data, null);
    assert.equal(off.unanswered, 2);
  });
});
