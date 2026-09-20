import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encryptSsoField, loginWithPassword } from "../src/sso-login.js";

describe("encryptSsoField", () => {
  test("returns stable uppercase hex for known plaintext", () => {
    const a = encryptSsoField("13557125634");
    const b = encryptSsoField("13557125634");
    assert.equal(a, b);
    assert.match(a, /^[0-9A-F]+$/);
    assert.equal(a.length % 32, 0);
  });
});

describe("loginWithPassword", () => {
  test("rejects empty username", async () => {
    const r = await loginWithPassword({ username: " ", password: "x" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "INVALID_ARGUMENT");
  });

  test("parses success jwt from SSO envelope", async () => {
    const r = await loginWithPassword(
      { username: "u", password: "p" },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              code: "0",
              rs: { jwt: "aaa.bbb.ccc", rt: "refresh" },
            }),
            { status: 200 },
          ),
      },
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.jwt, "aaa.bbb.ccc");
      assert.equal(r.refreshToken, "refresh");
    }
  });
});
