import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LLM_SOLVE_ATTEMPTS,
  AnswerRefusedError,
  buildSolvedFillblankAnswer,
  buildSolvedObjectiveAnswer,
  parseChoiceAnswers,
  resolveChoiceSolverConfig,
} from "../src/choice-solver.js";

const opts = [
  { name: "A", value: "A", text: "<p>Friends.</p>" },
  { name: "B", value: "B", text: "<p>Neighbors.</p>" },
];

const LLM_ENV = { UNIPUS_LLM_BASE_URL: "https://llm.example/v1/", UNIPUS_LLM_MODEL: "m", UNIPUS_LLM_API_KEY: "k" };

describe("choice-solver", () => {
  test("config reads only UNIPUS_LLM_BASE_URL / MODEL / API_KEY", () => {
    assert.deepEqual(resolveChoiceSolverConfig(LLM_ENV), {
      baseUrl: "https://llm.example/v1",
      model: "m",
      apiKey: "k",
    });
  });

  test("config missing any UNIPUS_LLM_* var → AnswerRefusedError (no SiliconFlow fallback / defaults)", () => {
    assert.throws(() => resolveChoiceSolverConfig({}), AnswerRefusedError);
    assert.throws(
      () => resolveChoiceSolverConfig({ SILICONFLOW_API_KEY: "k" }),
      (e: unknown) => e instanceof AnswerRefusedError && /UNIPUS_LLM_BASE_URL/.test((e as Error).message),
    );
    for (const drop of Object.keys(LLM_ENV)) {
      const env: Record<string, string> = { ...LLM_ENV };
      delete env[drop];
      assert.throws(() => resolveChoiceSolverConfig(env), (e: unknown) => e instanceof AnswerRefusedError && e.message.includes(drop));
    }
  });

  test("config error never echoes the key", () => {
    try {
      resolveChoiceSolverConfig({ UNIPUS_LLM_API_KEY: "secret-xyz" });
      assert.fail("should throw");
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /secret-xyz/);
    }
  });

  test("parseChoiceAnswers keeps only valid option letters", () => {
    const qs = [{ question: "q", options: [{ value: "A", text: "" }, { value: "B", text: "" }] }];
    assert.deepEqual(parseChoiceAnswers('sure: {"answers":["b"]}', qs), ["B"]);
    assert.deepEqual(parseChoiceAnswers('{"answers":["Z"]}', qs), [null]);
    assert.deepEqual(parseChoiceAnswers("garbage", qs), [null]);
  });

  test("multi-child: every question gets the LLM letter", async () => {
    const data = {
      contents: [{ text: "<p>We are <strong>Neighbors.</strong></p>" }],
      children: [
        { contents: [{ text: "Q1?" }], options: opts },
        { contents: [{ text: "Q2?" }], options: opts },
      ],
    };
    const seen: string[] = [];
    const answer = await buildSolvedObjectiveAnswer(data, async (prompt) => {
      seen.push(prompt);
      return '{"answers":["A","b"]}';
    });
    assert.match(seen[0]!, /We are Neighbors\.[\s\S]*Q1\. Q1\?[\s\S]*Q2\. Q2\?/);
    assert.deepEqual(JSON.parse(answer).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);
  });

  test("invalid letter is retried, never guessed; still invalid → throws", async () => {
    const data = { children: [{ quesText: "Q1?", options: opts }, { quesText: "Q2?", options: opts }] };
    const replies = ['{"answers":["A","?"]}', '{"answers":["A","B"]}'];
    let n = 0;
    const answer = await buildSolvedObjectiveAnswer(data, async () => replies[n++]!);
    assert.equal(n, 2);
    assert.deepEqual(JSON.parse(answer).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);

    let m = 0;
    await assert.rejects(
      buildSolvedObjectiveAnswer(data, async () => { m++; return '{"answers":["A","Z"]}'; }),
      (e: unknown) => e instanceof AnswerRefusedError && /无合法答案|invalid/.test((e as Error).message),
    );
    assert.equal(m, LLM_SOLVE_ATTEMPTS);
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
    const answer = await buildSolvedObjectiveAnswer({ options: opts }, async () => replies[n++]!());
    assert.equal(n, LLM_SOLVE_ATTEMPTS);
    assert.deepEqual(JSON.parse(answer).children[0].value, ["B"]);
  });

  test("objective: LLM keeps failing → throws AnswerRefusedError (no heuristic fallback)", async () => {
    let n = 0;
    await assert.rejects(
      buildSolvedObjectiveAnswer({ options: opts }, async () => { n++; throw new Error("HTTP 500"); }),
      (e: unknown) => e instanceof AnswerRefusedError && /HTTP 500/.test((e as Error).message),
    );
    assert.equal(n, LLM_SOLVE_ATTEMPTS);
  });

  test("fillblank: every blank filled by the LLM", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    const answer = await buildSolvedFillblankAnswer(data, async () => '{"answers":["marine","life"]}');
    assert.deepEqual(JSON.parse(answer).children, [
      { value: ["marine"], isDone: true },
      { value: ["life"], isDone: true },
    ]);
  });

  test("fillblank: empty blank or garbage → throws, never submitted empty", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => '{"answers":["marine",""]}'), AnswerRefusedError);
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => '{"answers":["marine"]}'), AnswerRefusedError);
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => "garbage"), AnswerRefusedError);
  });
});
