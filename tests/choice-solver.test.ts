import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
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

  test("multi-child: solver picks win, null falls back to heuristic", async () => {
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
    assert.deepEqual(JSON.parse(out).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);
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

  test("fillblank: one child per blank from LLM; no LLM → empty blanks", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    const out = await buildSolvedFillblankAnswer(data, async () => '{"answers":["marine","take its toll"]}');
    assert.deepEqual(JSON.parse(out).children, [
      { value: ["marine"], isDone: true },
      { value: ["take its toll"], isDone: true },
    ]);
    const empty = await buildSolvedFillblankAnswer(data, null);
    assert.deepEqual(JSON.parse(empty).children.map((c: { value: string[] }) => c.value[0]), ["", ""]);
  });

  test("solver throw → heuristic for single-question leaf", async () => {
    const data = { contents: [{ text: "<p>We are <strong>Neighbors.</strong></p>" }], options: opts };
    const out = await buildSolvedObjectiveAnswer(data, async () => {
      throw new Error("down");
    });
    assert.deepEqual(JSON.parse(out), { value: [], children: [{ value: ["B"], isDone: true }] });
  });
});
