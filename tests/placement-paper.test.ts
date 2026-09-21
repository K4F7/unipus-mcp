import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildPlacementUserData,
  diagnosePlacementSubmitCoverage,
  emptyOralChild,
  listPlacementQuestions,
  reconcileAnswerChildren,
  type PlacementQuestion,
} from "../src/placement-paper.js";

describe("listPlacementQuestions", () => {
  test("extracts leaf q_qinstid and children length", () => {
    const paper = {
      dtp: "h1",
      chr: [
        {
          dtp: "h2",
          chr: [
            {
              q_qinstid: "97036694388861891",
              dtp: "ques",
              type: "EN_SENT_SCORE",
              children: [{ id: "c0" }, { id: "c1" }],
            },
            {
              q_qinstid: "97036694388861892",
              dtp: "ques",
              children: [{ id: "only" }],
            },
          ],
        },
      ],
    };
    const qs = listPlacementQuestions(paper);
    assert.equal(qs.length, 2);
    assert.equal(qs[0]?.instanceId, "97036694388861891");
    assert.equal(qs[0]?.expectedChildren, 2);
    assert.equal(qs[0]?.questionType, "EN_SENT_SCORE");
    assert.equal(qs[1]?.instanceId, "97036694388861892");
    assert.equal(qs[1]?.expectedChildren, 1);
  });

  test("falls back to subQuesNum when children missing", () => {
    const paper = {
      children: [
        {
          q_qinstid: "111111111111111111",
          subQuesNum: 3,
          type: "fillblank",
        },
      ],
    };
    const qs = listPlacementQuestions(paper);
    assert.equal(qs.length, 1);
    assert.equal(qs[0]?.expectedChildren, 3);
  });

  test("preserves large snowflake ids from JSON string", () => {
    // Keep digits in source text — JS number literal would already corrupt.
    const raw =
      '{"chr":[{"q_qinstid":97036694388861891,"children":[{},{}]}]}';
    const qs = listPlacementQuestions(raw);
    assert.equal(qs[0]?.instanceId, "97036694388861891");
    assert.equal(qs[0]?.expectedChildren, 2);
  });
});

describe("reconcileAnswerChildren", () => {
  test("no-op when expectedChildren <= 1", () => {
    const answer = {
      value: [],
      children: [{ record: { url: "https://x/a.wav" }, value: [], isDone: true }],
    };
    const r = reconcileAnswerChildren(JSON.stringify(answer), 1);
    assert.equal(r.repaired, false);
    assert.deepEqual(JSON.parse(r.answer), answer);
  });

  test("pads oral children to expected count (SPA k/w)", () => {
    const answer = {
      value: [],
      children: [
        {
          record: {
            type: "EN_SENT_SCORE",
            text: "hello",
            url: "https://birdflock/a.wav",
            path: "https://clio/a.wav",
            replayUrl: "https://birdflock/a.wav",
            list: [],
          },
          value: [],
          isDone: true,
        },
      ],
    };
    const r = reconcileAnswerChildren(JSON.stringify(answer), 3);
    assert.equal(r.repaired, true);
    assert.equal(r.expected, 3);
    assert.equal(r.actualBefore, 1);
    const parsed = JSON.parse(r.answer) as {
      children: Array<{ record?: unknown; isDone?: boolean }>;
    };
    assert.equal(parsed.children.length, 3);
    assert.equal(parsed.children[0]?.isDone, true);
    assert.ok(parsed.children[1]?.record);
    assert.equal(parsed.children[1]?.isDone, false);
  });

  test("pads objective children without record", () => {
    const answer = { value: [], children: [{ value: ["A"], isDone: true }] };
    const r = reconcileAnswerChildren(JSON.stringify(answer), 2);
    assert.equal(r.repaired, true);
    const parsed = JSON.parse(r.answer) as { children: unknown[] };
    assert.equal(parsed.children.length, 2);
    assert.deepEqual(parsed.children[1], { value: [], isDone: false });
  });
});

describe("buildPlacementUserData + diagnosePlacementSubmitCoverage", () => {
  const questions: PlacementQuestion[] = [
    {
      instanceId: "aaa",
      expectedChildren: 2,
      questionType: "EN_SENT_SCORE",
      index: 0,
    },
    {
      instanceId: "bbb",
      expectedChildren: 1,
      questionType: "oral",
      index: 1,
    },
  ];

  test("builds multi-item userData covering every leaf", () => {
    const userData = buildPlacementUserData({
      questions,
      answersByInstanceId: {
        aaa: {
          value: [],
          children: [
            {
              record: { type: "EN_SENT_SCORE", url: "https://x/a.wav", text: "hi", list: [] },
              value: [],
              isDone: true,
            },
          ],
        },
        bbb: {
          value: [],
          children: [
            {
              record: { type: "EN_SENT_SCORE", url: "https://x/b.wav", text: "yo", list: [] },
              value: [],
              isDone: true,
            },
          ],
        },
      },
    });
    assert.equal(userData.length, 2);
    const aaa = JSON.parse(userData[0]!.answer) as { children: unknown[] };
    assert.equal(aaa.children.length, 2); // reconciled
    assert.equal(userData[0]!.instanceId, "aaa");
    assert.equal(userData[1]!.instanceId, "bbb");
  });

  test("diagnose flags missing instances and short children (4295 cause)", () => {
    const diag = diagnosePlacementSubmitCoverage(questions, [
      {
        instanceId: "aaa",
        answer: JSON.stringify({
          value: [],
          children: [{ value: [], isDone: true }], // expected 2
        }),
      },
      // bbb missing
    ]);
    assert.equal(diag.ok, false);
    assert.ok(diag.missingInstanceIds.includes("bbb"));
    assert.ok(
      diag.shortChildren.some(
        (s) => s.instanceId === "aaa" && s.expected === 2 && s.actual === 1,
      ),
    );
  });

  test("emptyOralChild matches SPA oral stub shape keys", () => {
    const c = emptyOralChild();
    assert.equal(c.isDone, false);
    assert.ok(c.record && typeof c.record === "object");
    assert.equal((c.record as { url: string }).url, "");
  });
});
