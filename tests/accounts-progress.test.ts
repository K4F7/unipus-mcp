import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { listAccountsProgress } from "../src/accounts-progress.js";
import {
  saveAccountTokens,
  setAccountGrind,
} from "../src/accounts.js";
import { mockHttp } from "./mock-http.js";

const JWT_A = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYSJ9.sigA";
const JWT_B = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.sigB";
const JWT_C = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYyJ9.sigC";

function paidBody(done: number, total: number, level: string) {
  return JSON.stringify({
    code: 1,
    value: {
      weekDoneTaskCount: done,
      weekFrequency: total,
      currentLevel: level,
      type: "train",
    },
  });
}

function placementBody(type: string) {
  return JSON.stringify({
    code: 1,
    value: { type },
  });
}

describe("listAccountsProgress", () => {
  test("aggregates listen/speak/level/grind; isolates per-account errors", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "unipus-ap-"));
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg };
    await saveAccountTokens(
      { accountId: "aaa", jwt: JWT_A, makeActive: true, syncLegacy: true },
      { env },
    );
    await saveAccountTokens(
      { accountId: "bbb", jwt: JWT_B, makeActive: false, syncLegacy: false },
      { env },
    );
    await saveAccountTokens(
      {
        accountId: "ccc",
        jwt: JWT_C,
        makeActive: false,
        syncLegacy: false,
        metaPatch: { skip_placement: true },
      },
      { env },
    );
    await setAccountGrind("bbb", "speak", { env });

    const http = mockHttp(async (call) => {
      const auth = call.headers.authorization ?? "";
      if (auth === JWT_B) {
        return { statusCode: 500, body: "boom" };
      }
      if (auth === JWT_C && call.url.includes("flowType=listen")) {
        return { statusCode: 200, body: placementBody("grade") };
      }
      if (auth === JWT_C) {
        return { statusCode: 200, body: paidBody(0, 5, "S0") };
      }
      // aaa
      if (call.url.includes("flowType=speak")) {
        return { statusCode: 200, body: paidBody(2, 3, "S2") };
      }
      return { statusCode: 200, body: paidBody(4, 5, "S1") };
    });

    const result = await listAccountsProgress({ env, http });
    assert.equal(result.isError, false);
    assert.equal(result.code, "OK");
    assert.equal(result.accounts.length, 3);
    assert.equal(result.active_account, "aaa");

    const aaa = result.accounts.find((r) => r.account_id === "aaa");
    assert.ok(aaa);
    assert.equal(aaa!.error, null);
    assert.equal(aaa!.listen_done, 4);
    assert.equal(aaa!.listen_total, 5);
    assert.equal(aaa!.speak_done, 2);
    assert.equal(aaa!.speak_total, 3);
    assert.equal(aaa!.level, "S1");
    assert.equal(aaa!.grind, "both");
    assert.equal(aaa!.placement.status, "ok");

    const bbb = result.accounts.find((r) => r.account_id === "bbb");
    assert.ok(bbb);
    assert.equal(bbb!.grind, "speak");
    assert.ok(bbb!.error);
    assert.equal(bbb!.listen_done, null);
    assert.equal(bbb!.placement.status, "error");

    const ccc = result.accounts.find((r) => r.account_id === "ccc");
    assert.ok(ccc);
    assert.equal(ccc!.skip_placement, true);
    assert.equal(ccc!.placement.status, "needs_placement");
    assert.equal(ccc!.error?.code, "NEEDS_PLACEMENT");

    const blob = JSON.stringify(result);
    assert.equal(blob.includes(JWT_A), false);
    assert.equal(blob.includes(JWT_B), false);
    assert.equal(blob.includes(JWT_C), false);
    assert.equal(blob.includes('"jwt"'), false);
    assert.equal(blob.includes('"rt"'), false);
    assert.equal(blob.includes('"password"'), false);
  });

  test("account_id filter; unknown id is INVALID_ARGUMENT", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "unipus-ap-f-"));
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg };
    await saveAccountTokens(
      { accountId: "only", jwt: JWT_A, makeActive: true },
      { env },
    );
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: paidBody(1, 5, "L1"),
    }));

    const one = await listAccountsProgress(
      { env, http },
      { account_id: "only" },
    );
    assert.equal(one.isError, false);
    assert.equal(one.accounts.length, 1);
    assert.equal(one.accounts[0]!.account_id, "only");
    assert.equal(one.accounts[0]!.listen_done, 1);

    const missing = await listAccountsProgress(
      { env, http },
      { account_id: "nope" },
    );
    assert.equal(missing.isError, true);
    assert.equal(missing.code, "INVALID_ARGUMENT");
    assert.equal(missing.accounts.length, 0);
  });
});
