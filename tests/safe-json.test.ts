import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  asExactIdString,
  collectQuestionInstanceIds,
  parseJsonPreservingLargeInts,
  parsePaperJson,
} from "../src/safe-json.js";
import { parseLoadPaperBody } from "../src/start-listening-training.js";

const SNOWFLAKE = "1984905701219868673";
const CORRUPTED = String(Number(SNOWFLAKE)); // precision-loss form

describe("parseJsonPreservingLargeInts", () => {
  test("keeps 16+ digit integers as exact strings", () => {
    const parsed = parseJsonPreservingLargeInts(
      `{"q_qinstid":${SNOWFLAKE},"nested":{"instanceId":${SNOWFLAKE}}}`,
    ) as {
      q_qinstid: string;
      nested: { instanceId: string };
    };
    assert.equal(parsed.q_qinstid, SNOWFLAKE);
    assert.equal(parsed.nested.instanceId, SNOWFLAKE);
    assert.notEqual(SNOWFLAKE, CORRUPTED);
  });

  test("does not rewrite digits inside JSON strings", () => {
    const parsed = parseJsonPreservingLargeInts(
      `{"note":"id=${SNOWFLAKE}"}`,
    ) as { note: string };
    assert.equal(parsed.note, `id=${SNOWFLAKE}`);
  });
});

describe("asExactIdString", () => {
  test("accepts strings and safe integers", () => {
    assert.equal(asExactIdString(`  ${SNOWFLAKE}  `), SNOWFLAKE);
    assert.equal(asExactIdString(42), "42");
    assert.equal(asExactIdString(BigInt(SNOWFLAKE)), SNOWFLAKE);
  });

  test("rejects unsafe Number (already corrupted)", () => {
    assert.equal(asExactIdString(Number(SNOWFLAKE)), null);
  });
});

describe("collectQuestionInstanceIds + loadPaper", () => {
  test("extracts exact ids from nested paperJson string", () => {
    // Nested paperJson string containing a bare snowflake integer.
    const nestedPaper =
      '{"questions":[{"q_qinstid":' + SNOWFLAKE + '},{"instanceId":"1001"}]}';
    const rawBody = JSON.stringify({
      code: 0,
      data: { taskId: "task-1", token: "tok", paperJson: nestedPaper },
    });

    const parsed = parseLoadPaperBody(rawBody, "fallback");
    assert.ok(parsed);
    assert.equal(parsed!.paper_token, "tok");
    assert.ok(parsed!.instance_ids.includes(SNOWFLAKE));
    assert.ok(parsed!.instance_ids.includes("1001"));
    assert.equal(parsed!.instance_ids.includes(CORRUPTED), false);
  });

  test("collectQuestionInstanceIds walks tree", () => {
    const ids = collectQuestionInstanceIds({
      questions: [
        { q_qinstid: SNOWFLAKE },
        { questionInstanceId: "2222" },
        { otherId: SNOWFLAKE },
      ],
      taskId: SNOWFLAKE,
    });
    assert.deepEqual(ids, [SNOWFLAKE, "2222"]);
  });

  test("parsePaperJson null on empty", () => {
    assert.equal(parsePaperJson("  "), null);
    assert.equal(parsePaperJson(null), null);
  });
});
