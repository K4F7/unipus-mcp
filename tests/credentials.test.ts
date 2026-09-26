import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

describe("active-account credential resolution", () => {
  test("prefers accounts/<active>/jwt over legacy", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-cred-"));
    const config = join(home, ".config", "unipus-mcp");
    const accountDir = join(config, "accounts", "acct1");
    await mkdir(accountDir, { recursive: true, mode: 0o700 });
    const accountJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJhY2N0In0.sig";
    const legacyJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJsZWdhY3kifQ.sig";
    await writeFile(join(accountDir, "jwt"), `${accountJwt}\n`, { mode: 0o600 });
    await writeFile(join(config, "jwt"), `${legacyJwt}\n`, { mode: 0o600 });
    await writeFile(join(config, "active-account.txt"), "acct1\n", { mode: 0o600 });

    const store = createEnvCredentialStore({
      env: {},
      homedir: home,
    });
    assert.equal(await store.getJwt(), accountJwt);
  });

  test("falls back to legacy jwt when no active-account", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-cred-leg-"));
    const config = join(home, ".config", "unipus-mcp");
    await mkdir(config, { recursive: true, mode: 0o700 });
    const legacyJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJsZWdhY3kifQ.sig";
    await writeFile(join(config, "jwt"), `${legacyJwt}\n`, { mode: 0o600 });

    const store = createEnvCredentialStore({
      env: {},
      homedir: home,
    });
    assert.equal(await store.getJwt(), legacyJwt);
  });

  test("UNIPUS_JWT still wins over active account", async () => {
    const envJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJlbnYifQ.sig";
    const store = createEnvCredentialStore({
      env: { UNIPUS_JWT: envJwt },
      homedir: "/tmp/no-such-home-for-active",
    });
    assert.equal(await store.getJwt(), envJwt);
  });
});
