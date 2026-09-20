import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decodeJwtPayload,
  isJwtExpired,
  safeUserIdFromPayload,
} from "../src/jwt.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("jwt helpers", () => {
  test("decodes payload without verifying signature", () => {
    const jwt = makeJwt({ openId: "oid-1", exp: 1_900_000_000 });
    const payload = decodeJwtPayload(jwt);
    assert.ok(payload);
    assert.equal(payload.openId, "oid-1");
    assert.equal(payload.exp, 1_900_000_000);
  });

  test("rejects malformed tokens", () => {
    assert.equal(decodeJwtPayload("not.jwt"), null);
    assert.equal(decodeJwtPayload("a.b"), null);
    assert.equal(decodeJwtPayload(""), null);
  });

  test("coarse expiry uses exp claim", () => {
    const past = makeJwt({ exp: 1_000 });
    const future = makeJwt({ exp: 4_000_000_000 });
    const now = new Date(1_700_000_000_000);
    assert.equal(isJwtExpired(past, now), true);
    assert.equal(isJwtExpired(future, now), false);
    assert.equal(isJwtExpired(makeJwt({ openId: "x" }), now), null);
  });

  test("safe user id prefers openId / user string / sub", () => {
    assert.equal(safeUserIdFromPayload({ openId: "oid" }), "oid");
    assert.equal(safeUserIdFromPayload({ openid: "oid2" }), "oid2");
    assert.equal(safeUserIdFromPayload({ user: "u-1" }), "u-1");
    assert.equal(safeUserIdFromPayload({ sub: "sub-1" }), "sub-1");
    assert.equal(safeUserIdFromPayload({ user: { id: "nested" } }), null);
    assert.equal(safeUserIdFromPayload(null), null);
  });
});
