import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  NOTE_MAX_LENGTH,
  listAccounts,
  readAccountMeta,
  readActiveAccountId,
  saveAccountTokens,
  setAccountNote,
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

describe("account note", () => {
  test("setAccountNote writes note; listAccounts returns it; clear sets null", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-note-"));
    const env = {};
    await saveAccountTokens(
      { accountId: "note-user", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.n" },
      { home, env },
    );

    await setAccountNote("note-user", "临时号 / 室友", { home, env });
    const meta = await readAccountMeta("note-user", { home, env });
    assert.equal(meta?.note, "临时号 / 室友");

    const listed = await listAccounts({ home, env });
    const row = listed.find((x) => x.account_id === "note-user");
    assert.ok(row);
    assert.equal(row!.note, "临时号 / 室友");
    assert.equal(row!.alias, null);
    assert.equal("jwt" in row!, false);
    assert.equal("rt" in row!, false);

    await setAccountNote("note-user", null, { home, env });
    const cleared = await readAccountMeta("note-user", { home, env });
    assert.equal(cleared?.note ?? null, null);
    const listed2 = await listAccounts({ home, env });
    assert.equal(listed2.find((x) => x.account_id === "note-user")?.note ?? null, null);
  });

  test("setAccountNote rejects missing account and overlong note", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-note-err-"));
    const env = {};

    await assert.rejects(
      () => setAccountNote("ghost", "x", { home, env }),
      /不存在|找不到|无此/,
    );

    await saveAccountTokens(
      { accountId: "long-user", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.l" },
      { home, env },
    );
    const tooLong = "a".repeat(NOTE_MAX_LENGTH + 1);
    await assert.rejects(
      () => setAccountNote("long-user", tooLong, { home, env }),
      /500|过长|太长|上限/,
    );
  });

  test("saveAccountTokens preserves existing note via metaPatch", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-note-preserve-"));
    const env = {};

    await saveAccountTokens(
      {
        accountId: "keep",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.k",
        metaPatch: { note: "本人", alias: "me" },
      },
      { home, env },
    );
    let meta = await readAccountMeta("keep", { home, env });
    assert.equal(meta?.note, "本人");
    assert.equal(meta?.alias, "me");

    await saveAccountTokens(
      {
        accountId: "keep",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.k2",
        makeActive: false,
        syncLegacy: false,
      },
      { home, env },
    );
    meta = await readAccountMeta("keep", { home, env });
    assert.equal(meta?.note, "本人");
    assert.equal(meta?.alias, "me");

    await setAccountNote("keep", "更新备注", { home, env });
    meta = await readAccountMeta("keep", { home, env });
    assert.equal(meta?.note, "更新备注");
    assert.equal(meta?.alias, "me");
  });
});
