import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { saveAccountTokens, setActiveAccountId } from "../src/accounts.js";
import {
  buildObjectiveAnswer,
  walkPaperLeaves,
} from "../src/grind-paper.js";
import {
  ensureAccountAuth,
  grindOneAccount,
  parseWeeklyGrindArgs,
  resolveTargetAccounts,
  runWeeklyGrind,
  sanitizeSummaryForStdout,
  type WeeklyGrindPorts,
} from "../src/weekly-grind.js";
import { mockHttp } from "./mock-http.js";

describe("parseWeeklyGrindArgs", () => {
  test("defaults to active; --all; multiple --account", () => {
    assert.deepEqual(parseWeeklyGrindArgs([]).mode, { kind: "active" });
    assert.deepEqual(parseWeeklyGrindArgs(["--all"]).mode, { kind: "all" });
    assert.deepEqual(parseWeeklyGrindArgs(["--account", "a", "-a", "b"]).mode, {
      kind: "ids",
      ids: ["a", "b"],
    });
  });
});

describe("resolveTargetAccounts", () => {
  test("--all picks jwt|rt archives; active-only respects pointer", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-sel-"));
    const env = {};
    await saveAccountTokens(
      { accountId: "aaa", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.a", refreshToken: "rt-a" },
      { home, env },
    );
    await saveAccountTokens(
      {
        accountId: "bbb",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoyfQ.b",
        makeActive: false,
        syncLegacy: false,
        metaPatch: { note: "室友", alias: "room" },
      },
      { home, env },
    );
    await setActiveAccountId("bbb", { home, env });

    const all = await resolveTargetAccounts({ kind: "all" }, { home, env });
    assert.equal(all.length, 2);

    const active = await resolveTargetAccounts({ kind: "active" }, { home, env });
    assert.equal(active.length, 1);
    assert.equal(active[0]!.account_id, "bbb");
    assert.equal(active[0]!.note, "室友");

    const ids = await resolveTargetAccounts(
      { kind: "ids", ids: ["bbb", "ghost"] },
      { home, env },
    );
    assert.equal(ids.length, 2);
    assert.equal(ids[1]!.account_id, "ghost");
    assert.equal(ids[1]!.has_jwt, false);
  });
});

describe("grind-paper helpers", () => {
  test("walkPaperLeaves + objective answer", () => {
    const paper = {
      chr: [
        {
          q_qinstid: "111",
          q_template_name: "single-choice",
          is_objective: true,
          nm: "q1",
          data: {
            children: [
              {
                options: [
                  { value: "A", text: "alpha" },
                  { value: "B", text: "beta" },
                ],
              },
            ],
            contents: [{ text: "choose <b>beta</b>" }],
          },
        },
      ],
    };
    const leaves = walkPaperLeaves(paper);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0]!.expectedChildren, 1);
    const ans = JSON.parse(buildObjectiveAnswer(leaves[0]!));
    assert.equal(ans.children[0].value[0], "B");
  });
});

describe("ensureAccountAuth + grind orchestration (mocked)", () => {
  test("CAPTCHA_REQUIRED skips and continues others", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-cap-"));
    // No password env: refresh captcha ⇒ skip cap; ok uses existing jwt only
    const env = {};
    await saveAccountTokens(
      {
        accountId: "cap",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.c",
        refreshToken: "bad-rt",
      },
      { home, env },
    );
    await saveAccountTokens(
      {
        accountId: "ok",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoyfQ.o",
        makeActive: false,
        syncLegacy: false,
        metaPatch: { note: "本人" },
      },
      { home, env },
    );

    const summary = await runWeeklyGrind(
      { kind: "ids", ids: ["cap", "ok"] },
      {
        home,
        env,
        refreshRt: async () =>
          ({
            ok: false as const,
            code: "CAPTCHA_REQUIRED" as const,
            message: "极验",
          }) as never,
        listProgress: async () => ({
          listen_done: 5,
          listen_total: 5,
          speak_done: 3,
          speak_total: 3,
        }),
        grindListen: async () => ({ completed: 0, taskIds: [] }),
        grindSpeak: async () => ({ completed: 0, taskIds: [] }),
      },
    );

    const cap = summary.accounts.find((a) => a.account_id === "cap");
    const ok = summary.accounts.find((a) => a.account_id === "ok");
    assert.ok(cap);
    assert.ok(ok);
    assert.equal(cap!.status, "skipped_captcha");
    assert.equal(ok!.status, "skipped_done");
    assert.equal(ok!.note, "本人");
  });

  test("already-done account is not re-ground", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-done-"));
    const env = {};
    await saveAccountTokens(
      {
        accountId: "done1",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.d",
        metaPatch: { alias: "me", note: "本人" },
      },
      { home, env },
    );
    let grindCalls = 0;
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["done1"] }, { home, env })
    )[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      refreshRt: async () => ({ ok: false, code: "X", message: "no" }) as never,
      listProgress: async () => ({
        listen_done: 5,
        listen_total: 5,
        speak_done: 3,
        speak_total: 3,
      }),
      grindListen: async () => {
        grindCalls += 1;
        return { completed: 1, taskIds: ["t"] };
      },
      grindSpeak: async () => {
        grindCalls += 1;
        return { completed: 1, taskIds: ["t"] };
      },
    });
    assert.equal(result.status, "skipped_done");
    assert.equal(result.alias, "me");
    assert.equal(result.note, "本人");
    assert.equal(grindCalls, 0);
    assert.deepEqual(result.before, result.after);
  });

  test("grounds listen/speak gaps via injected grinders", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-gap-"));
    const env = {};
    await saveAccountTokens(
      { accountId: "gap1", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.g" },
      { home, env },
    );
    let phase = 0;
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["gap1"] }, { home, env })
    )[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      listProgress: async () => {
        phase += 1;
        if (phase === 1) {
          return {
            listen_done: 3,
            listen_total: 5,
            speak_done: 1,
            speak_total: 3,
          };
        }
        return {
          listen_done: 5,
          listen_total: 5,
          speak_done: 3,
          speak_total: 3,
        };
      },
      grindListen: async (_p, need) => {
        assert.equal(need, 2);
        return { completed: 2, taskIds: ["l1", "l2"] };
      },
      grindSpeak: async (_p, need) => {
        assert.equal(need, 2);
        return { completed: 2, taskIds: ["s1", "s2"] };
      },
    });
    assert.equal(result.status, "done");
    assert.equal(result.listen_completed, 2);
    assert.equal(result.speak_completed, 2);
    assert.equal(result.after?.listen_done, 5);
  });

  test("sanitizeSummaryForStdout redacts jwt-shaped error text", () => {
    const cleaned = sanitizeSummaryForStdout({
      started_at: "t0",
      finished_at: "t1",
      accounts: [
        {
          account_id: "x",
          alias: null,
          note: null,
          status: "error",
          before: null,
          after: null,
          listen_completed: 0,
          speak_completed: 0,
          errors: ["boom eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig end"],
        },
      ],
    });
    assert.match(cleaned.accounts[0]!.errors[0]!, /\[redacted-jwt\]/);
    assert.equal(cleaned.accounts[0]!.errors[0]!.includes("eyJ"), false);
  });

  test("completeOneListen happy path with mock HTTP", async () => {
    const { completeOneListen } = await import("../src/grind-listen.js");
    const paper = {
      token: "paper-tok",
      paperJson: JSON.stringify({
        chr: [
          {
            q_qinstid: "999",
            q_template_name: "content-learn",
            nm: "learn",
            data: { children: [] },
          },
        ],
      }),
    };
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { type: "train", taskId: "555", ansVersion: 1, status: "answering" },
          }),
        };
      }
      if (call.url.includes("loadPaper")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: paper }),
        };
      }
      if (call.url.includes("submitAnswer")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: { ok: true } }),
        };
      }
      return { statusCode: 404, body: "{}" };
    });
    const result = await completeOneListen({
      credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t" },
      http,
      env: {},
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.taskId, "555");
    assert.ok(http.calls.some((c) => c.url.includes("submitAnswer")));
  });
});

describe("ensureAccountAuth captcha policy", () => {
  test("password CAPTCHA_REQUIRED does not fall back to jwt", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-auth-"));
    const env = {
      UNIPUS_USERNAME: "u1",
      UNIPUS_PASSWORD: "p1",
    };
    await saveAccountTokens(
      {
        accountId: "u1",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.u",
        refreshToken: "rt1",
      },
      { home, env },
    );
    const result = await ensureAccountAuth("u1", {
      home,
      env,
      refreshRt: async () =>
        ({
          ok: false as const,
          code: "CAPTCHA_REQUIRED" as const,
          message: "need captcha",
        }) as never,
      loginPassword: async () =>
        ({
          ok: false as const,
          code: "CAPTCHA_REQUIRED" as const,
          message: "need captcha",
        }) as never,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "CAPTCHA_REQUIRED");
  });
});
