import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ANSWER_ATTEMPTS,
  AnswerSolveError,
  buildSolvedFillblankAnswer,
  buildSolvedObjectiveAnswer,
  parseChoiceAnswers,
  resolveConfiguredAsk,
} from "../src/choice-solver.js";

const opts = [
  { name: "A", value: "A", text: "<p>Friends.</p>" },
  { name: "B", value: "B", text: "<p>Neighbors.</p>" },
];

describe("choice-solver", () => {
  test("no agent queue means no answer callback, even if an API key is set", () => {
    assert.equal(resolveConfiguredAsk({}), null);
    assert.equal(resolveConfiguredAsk({ UNIPUS_LLM_API_KEY: "k", SILICONFLOW_API_KEY: "k" }), null);
  });

  test("parseChoiceAnswers keeps only valid option letters", () => {
    const qs = [{ question: "q", options: [{ value: "A", text: "" }, { value: "B", text: "" }] }];
    assert.deepEqual(parseChoiceAnswers('sure: {"answers":["b"]}', qs), ["B"]);
    assert.deepEqual(parseChoiceAnswers('{"answers":["Z"]}', qs), [null]);
    assert.deepEqual(parseChoiceAnswers("garbage", qs), [null]);
  });

  test("multi-child: valid picks kept; an invalid letter refuses the paper", async () => {
    const data = {
      contents: [{ text: "<p>We are <strong>Neighbors.</strong></p>" }],
      children: [
        { contents: [{ text: "Q1?" }], options: opts },
        { contents: [{ text: "Q2?" }], options: opts },
      ],
    };
    const seen: string[] = [];
    await assert.rejects(
      buildSolvedObjectiveAnswer(data, async (prompt) => {
        seen.push(prompt);
        return '{"answers":["A","?"]}';
      }),
      /LOW_SCORE_REFUSED/,
    );
    assert.match(seen[0]!, /We are Neighbors\.[\s\S]*Q1\. Q1\?[\s\S]*Q2\. Q2\?/);
    const ok = await buildSolvedObjectiveAnswer(data, async () => '{"answers":["A","B"]}');
    assert.deepEqual(JSON.parse(ok.answer).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);
    assert.equal(ok.unanswered, 0);
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
    assert.equal(n, ANSWER_ATTEMPTS);
    assert.deepEqual(JSON.parse(out.answer).children[0].value, ["B"]);
  });

  test("objective: a failing answer callback throws AnswerSolveError", async () => {
    let n = 0;
    await assert.rejects(
      buildSolvedObjectiveAnswer({ options: opts }, async () => { n++; throw new Error("HTTP 500"); }),
      (e: unknown) => e instanceof AnswerSolveError && /HTTP 500/.test((e as Error).message),
    );
    assert.equal(n, ANSWER_ATTEMPTS);
  });

  test("fillblank: complete answers submit; empty or missing source refuses", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    const out = await buildSolvedFillblankAnswer(data, async () => '{"answers":["marine","life"]}');
    assert.deepEqual(JSON.parse(out.answer).children, [
      { value: ["marine"], isDone: true },
      { value: ["life"], isDone: true },
    ]);
    assert.equal(out.unanswered, 0);
    await assert.rejects(
      buildSolvedFillblankAnswer(data, async () => '{"answers":["marine",""]}'),
      /LOW_SCORE_REFUSED/,
    );
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => "garbage"), AnswerSolveError);
    await assert.rejects(buildSolvedFillblankAnswer(data, null), /LOW_SCORE_REFUSED/);
  });
});
