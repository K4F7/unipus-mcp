import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encryptSsoField, loginWithPassword, saveJwtToDefaultPath } from "../src/sso-login.js";

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

describe("saveJwtToDefaultPath", () => {
  test("chmod 0o600 even when overwriting a looser file", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-jwt-"));
    const path = join(home, ".config", "unipus-mcp", "jwt");
    // create with loose perms first
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".config", "unipus-mcp"), { recursive: true, mode: 0o755 });
    await writeFile(path, "old.jwt\n", { mode: 0o644 });
    await chmod(path, 0o644);

    // Clear XDG so home override wins (CI often sets XDG_CONFIG_HOME).
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
