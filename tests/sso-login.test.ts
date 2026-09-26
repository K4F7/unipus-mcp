import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXIT_CAPTCHA_REQUIRED,
  encryptSsoField,
  loginWithPassword,
  refreshWithRt,
  saveJwtToDefaultPath,
  saveLoginTokens,
} from "../src/sso-login.js";

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

  test("maps 1506 to CAPTCHA_REQUIRED", async () => {
    const r = await loginWithPassword(
      { username: "u", password: "p" },
      {
        fetch: async () =>
          new Response(JSON.stringify({ code: "1506" }), { status: 200 }),
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "CAPTCHA_REQUIRED");
      assert.match(r.message, /有头浏览器|极验/);
    }
  });
});

describe("saveJwtToDefaultPath", () => {
  test("chmod 0o600 even when overwriting a looser file", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-jwt-"));
    const path = join(home, ".config", "unipus-mcp", "jwt");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".config", "unipus-mcp"), { recursive: true, mode: 0o755 });
    await writeFile(path, "old.jwt\n", { mode: 0o644 });
    await chmod(path, 0o644);

    const saved = await saveJwtToDefaultPath("new.jwt.token", {
      home,
      env: {},
    });
    assert.equal(saved, path);
    assert.equal((await readFile(path, "utf8")).trim(), "new.jwt.token");
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("refreshWithRt", () => {
  test("parses rotated jwt+rt from refresh_jwt envelope", async () => {
    const r = await refreshWithRt("old-rt", {
      fetch: async (_url, init) => {
        const body = String((init as RequestInit)?.body ?? "");
        assert.match(body, /"rt":"old-rt"/);
        assert.equal(body.includes("password"), false);
        return new Response(
          JSON.stringify({
            code: "0",
            rs: { jwt: "new.jwt.val", rt: "new-rt" },
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.jwt, "new.jwt.val");
      assert.equal(r.refreshToken, "new-rt");
    }
  });

  test("maps 1506 to CAPTCHA_REQUIRED with headed-browser hint", async () => {
    const r = await refreshWithRt("rt", {
      fetch: async () =>
        new Response(JSON.stringify({ code: "1506", msg: "need captcha" }), {
          status: 200,
        }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "CAPTCHA_REQUIRED");
      assert.match(r.message, /有头浏览器|极验/);
    }
  });

  test("EXIT_CAPTCHA_REQUIRED is distinct", () => {
    assert.equal(EXIT_CAPTCHA_REQUIRED, 3);
  });
});

describe("saveLoginTokens", () => {
  test("password-login path writes jwt and rt", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-save-"));
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.sig";
    const saved = await saveLoginTokens(
      {
        accountId: "phone1",
        jwt,
        refreshToken: "rt-from-login",
        source: "login",
      },
      { home, env: {} },
    );
    assert.equal((await readFile(join(saved.accountDir, "jwt"), "utf8")).trim(), jwt);
    assert.equal(
      (await readFile(join(saved.accountDir, "rt"), "utf8")).trim(),
      "rt-from-login",
    );
    assert.equal((await stat(join(saved.accountDir, "rt"))).mode & 0o777, 0o600);
  });
});
