import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  createEnvCredentialStore,
  defaultJwtFilePath,
  extractJwtFromText,
} from "../src/credentials.js";

describe("extractJwtFromText", () => {
  test("accepts raw JWT and strips Bearer prefix", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJhIn0.sig";
    assert.equal(extractJwtFromText(jwt), jwt);
    assert.equal(extractJwtFromText(`Bearer ${jwt}`), jwt);
    assert.equal(extractJwtFromText(`  bearer ${jwt}  `), jwt);
  });

  test("parses jwt= cookie and JSON tokenInfo", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJhIn0.sig";
    assert.equal(extractJwtFromText(`foo=1; jwt=${jwt}; bar=2`), jwt);
    assert.equal(
      extractJwtFromText(JSON.stringify({ tokenInfo: { jwt }, Authorization: jwt })),
      jwt,
    );
    assert.equal(extractJwtFromText(JSON.stringify({ jwt })), jwt);
  });

  test("returns null for empty or password-looking blobs", () => {
    assert.equal(extractJwtFromText(""), null);
    assert.equal(extractJwtFromText("   "), null);
    assert.equal(extractJwtFromText("not-a-jwt"), null);
  });
});

describe("env credential store", () => {
  test("reads UNIPUS_JWT first", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJlbnYifQ.sig";
    const store = createEnvCredentialStore({
      env: { UNIPUS_JWT: jwt },
    });
    assert.equal(await store.getJwt(), jwt);
  });

  test("reads UNIPUS_JWT_FILE when env JWT missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unipus-jwt-"));
    const path = join(dir, "jwt");
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJmaWxlIn0.sig";
    await writeFile(path, `jwt=${jwt}\n`, "utf8");
    const store = createEnvCredentialStore({
      env: { UNIPUS_JWT_FILE: path },
    });
    assert.equal(await store.getJwt(), jwt);
  });

  test("missing sources yield null", async () => {
    const store = createEnvCredentialStore({
      env: {},
      homedir: "/tmp/no-such-unipus-home",
    });
    assert.equal(await store.getJwt(), null);
  });

  test("defaultJwtFilePath prefers XDG_CONFIG_HOME", () => {
    assert.equal(
      defaultJwtFilePath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/user"),
      "/tmp/xdg/unipus-mcp/jwt",
    );
    assert.equal(
      defaultJwtFilePath({}, "/home/user"),
      "/home/user/.config/unipus-mcp/jwt",
    );
  });
});
