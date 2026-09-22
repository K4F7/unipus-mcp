import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_SAVE_SNAPSHOT_PATH,
  resolveSaveSnapshotUrl,
} from "../src/config.js";
import {
  isSaveSnapshotSuccessCode,
  parseSaveSnapshotBody,
  saveSnapshot,
} from "../src/save-snapshot.js";

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & {
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  return {
    calls,
    async request(input) {
      const call = {
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        body: input.body,
      };
      calls.push(call);
      return handler(call);
    },
  };
}

const SNOWFLAKE = "1984905701219868673";

describe("resolveSaveSnapshotUrl", () => {
  test("defaults to uadaptive user/saveSnapshot", () => {
    assert.equal(
      resolveSaveSnapshotUrl({}),
      `https://uadaptive.unipus.cn${DEFAULT_ULS_SAVE_SNAPSHOT_PATH}`,
    );
    assert.match(resolveSaveSnapshotUrl({}), /\/api\/uls\/user\/saveSnapshot$/);
  });
});

describe("isSaveSnapshotSuccessCode / parseSaveSnapshotBody", () => {
  test("only business code=1 is success", () => {
    assert.equal(isSaveSnapshotSuccessCode(1), true);
    assert.equal(isSaveSnapshotSuccessCode("1"), true);
    assert.equal(isSaveSnapshotSuccessCode(0), false);
    assert.equal(isSaveSnapshotSuccessCode(200), false);
  });

  test("parse accepts code=1", () => {
    const parsed = parseSaveSnapshotBody(
      JSON.stringify({ code: 1, value: true }),
    );
    assert.ok(parsed != null);
    assert.equal(parsed.raw_code, 1);
  });

  test("parse rejects failure code", () => {
    assert.equal(
      parseSaveSnapshotBody(JSON.stringify({ code: 500, msg: "fail" })),
      null,
    );
  });
});

describe("saveSnapshot", () => {
  test("missing JWT is auth_required", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const r = await saveSnapshot(
      { credentials: { getJwt: async () => null }, http },
      {
        taskId: "t1",
        paperToken: "tok",
        userData: [{ instanceId: SNOWFLAKE, answer: "{}" }],
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.status, "auth_required");
    assert.deepEqual(http.calls, []);
  });

  test("empty paperToken is INVALID_ARGUMENT", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const r = await saveSnapshot(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "t1",
        paperToken: "  ",
        userData: [{ instanceId: "1", answer: "{}" }],
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.code, "INVALID_ARGUMENT");
    assert.deepEqual(http.calls, []);
  });

  test("posts string snowflake ids with cloud headers; success code=1", async () => {
    const jwt = "raw-jwt";
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: true }),
    }));
    const answer = JSON.stringify({
      children: [
        {
          record: { type: "EN_PRED_SCORE", text: "hi", url: "https://x/a.wav" },
          value: [],
          isDone: true,
        },
      ],
      value: [],
    });
    const r = await saveSnapshot(
      { credentials: { getJwt: async () => jwt }, http },
      {
        taskId: "101",
        paperToken: "paper-tok",
        durationSec: 12,
        userData: [{ instanceId: SNOWFLAKE, answer }],
      },
    );
    assert.equal(r.isError, false);
    assert.equal(r.status, "ok");
    assert.equal(r.raw_code, 1);
    assert.equal(r.task_id, "101");
    assert.equal(r.instance_id, SNOWFLAKE);
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveSaveSnapshotUrl({}));
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /);
    assert.equal(http.calls[0]?.headers["x-requested-with"], "cn.unipus.cloud");
    assert.equal(http.calls[0]?.headers.sourceid, "116");
    assert.equal(http.calls[0]?.headers["u-app-id"], "116");
    const body = JSON.parse(http.calls[0]?.body ?? "{}");
    assert.equal(body.taskId, "101");
    assert.equal(body.token, "paper-tok");
    assert.equal(body.ansVersion, 1);
    assert.equal(body.duration, 12);
    assert.equal(body.userData[0].instanceId, SNOWFLAKE);
    assert.equal(typeof body.userData[0].instanceId, "string");
    assert.match(body.userData[0].answer, /EN_PRED_SCORE/);
  });

  test("rejects unsafe numeric instanceId (no String() coercion)", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const unsafe = Number(SNOWFLAKE); // past MAX_SAFE_INTEGER — precision already lost
    const r = await saveSnapshot(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "t1",
        paperToken: "tok",
        userData: [
          {
            instanceId: unsafe as unknown as string,
            answer: "{}",
          },
        ],
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.code, "INVALID_ARGUMENT");
    assert.match(r.message ?? "", /instanceId/);
    assert.deepEqual(http.calls, []);
  });

  test("business error code is surfaced", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 4021, msg: "multi-device" }),
    }));
    const r = await saveSnapshot(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "t1",
        paperToken: "tok",
        userData: [{ instanceId: "1", answer: "{}" }],
      },
    );
    assert.equal(r.isError, true);
    assert.equal(r.status, "error");
    assert.equal(r.code, "BUSINESS_ERROR");
    assert.match(r.message, /4021/);
    assert.match(r.message, /multi-device/);
  });
});
