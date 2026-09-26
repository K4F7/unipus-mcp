import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  listAccounts,
  readActiveAccountId,
  saveAccountTokens,
  setActiveAccountId,
  sanitizeAccountId,
} from "../src/accounts.js";

describe("sanitizeAccountId", () => {
  test("rejects empty and path traversal", () => {
    assert.throws(() => sanitizeAccountId(" "), /不能为空/);
    assert.throws(() => sanitizeAccountId("../x"), /非法/);
    assert.throws(() => sanitizeAccountId("a/b"), /非法/);
    assert.equal(sanitizeAccountId("13479253898"), "13479253898");
  });
});

describe("account token store", () => {
  test("saves jwt+rt under accounts/<id> with 0600 and syncs legacy + active", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-acct-"));
    const env = {};
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig";
    const rt = "refresh-token-value";

    const saved = await saveAccountTokens(
      {
        accountId: "13479253898",
        jwt,
        refreshToken: rt,
        metaPatch: { last_login_at: "2026-09-26T01:00:00.000Z" },
      },
      { home, env },
    );

    assert.match(saved.accountDir, /accounts\/13479253898$/);
    const accountJwt = (await readFile(join(saved.accountDir, "jwt"), "utf8")).trim();
    const accountRt = (await readFile(join(saved.accountDir, "rt"), "utf8")).trim();
    assert.equal(accountJwt, jwt);
    assert.equal(accountRt, rt);
    assert.equal((await stat(join(saved.accountDir, "jwt"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(saved.accountDir, "rt"))).mode & 0o777, 0o600);

    const legacyJwt = (await readFile(join(home, ".config", "unipus-mcp", "jwt"), "utf8")).trim();
    const legacyRt = (await readFile(join(home, ".config", "unipus-mcp", "rt"), "utf8")).trim();
    assert.equal(legacyJwt, jwt);
    assert.equal(legacyRt, rt);

    assert.equal(await readActiveAccountId({ home, env }), "13479253898");

    const metaRaw = await readFile(join(saved.accountDir, "meta.json"), "utf8");
    assert.equal(metaRaw.includes(rt), false);
    assert.equal(metaRaw.includes(jwt), false);
    assert.match(metaRaw, /last_login_at/);
  });

  test("listAccounts is redacted and marks active", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-list-"));
    const env = {};
    await saveAccountTokens(
      { accountId: "aaa", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.a", refreshToken: "rt-a" },
      { home, env },
    );
    await saveAccountTokens(
      {
        accountId: "bbb",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoyfQ.b",
        refreshToken: "rt-b",
        makeActive: false,
        syncLegacy: false,
      },
      { home, env },
    );
    await setActiveAccountId("bbb", { home, env });

    const listed = await listAccounts({ home, env });
    assert.equal(listed.length, 2);
    const b = listed.find((x) => x.account_id === "bbb");
    assert.ok(b);
    assert.equal(b!.active, true);
    assert.equal(b!.has_jwt, true);
    assert.equal(b!.has_rt, true);
    // Ensure list payload has no secret-looking fields
    assert.equal("jwt" in b!, false);
    assert.equal("rt" in b!, false);
  });
});
