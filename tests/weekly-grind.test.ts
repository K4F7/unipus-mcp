import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { assistMonths, assistUntil, selfUsage } from "../src/account-usage.js";
import {
  accountDir,
  listAccounts,
  saveAccountTokens,
  setAccountGrind,
  setAccountUsage,
  setActiveAccountId,
} from "../src/accounts.js";
import { walkPaperLeaves } from "../src/grind-paper.js";
import {
  ensureAccountAuth,
  grindOneAccount,
  parseWeeklyGrindArgs,
  resolveEffectiveGrind,
  resolveTargetAccounts,
  runWeeklyGrind,
  maskAccountId,
  sanitizeSummaryForStdout,
} from "../src/weekly-grind.js";
import { mockHttp } from "./mock-http.js";

const okLlm = async () => "OK";
const LLM_ENV = { UNIPUS_LLM_BASE_URL: "https://llm.example/v1", UNIPUS_LLM_MODEL: "m", UNIPUS_LLM_API_KEY: "k" };

describe("parseWeeklyGrindArgs", () => {
  test("defaults to active; --all; multiple --account", () => {
    assert.deepEqual(parseWeeklyGrindArgs([]).mode, { kind: "active" });
    assert.equal(parseWeeklyGrindArgs([]).grindOverride, null);
    assert.deepEqual(parseWeeklyGrindArgs(["--all"]).mode, { kind: "all" });
    assert.deepEqual(parseWeeklyGrindArgs(["--account", "a", "-a", "b"]).mode, {
      kind: "ids",
      ids: ["a", "b"],
    });
  });

  test("--listen-only / --speak-only set grindOverride; mutual exclusion errors", () => {
    assert.equal(parseWeeklyGrindArgs(["--speak-only"]).grindOverride, "speak");
    assert.equal(parseWeeklyGrindArgs(["--all", "--listen-only"]).grindOverride, "listen");
    const bad = parseWeeklyGrindArgs(["--listen-only", "--speak-only"]);
    assert.ok(bad.error);
    assert.match(bad.error!, /互斥/);
  });
});

describe("resolveTargetAccounts", () => {
  test("--all picks jwt|rt archives; active-only respects pointer", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-sel-"));
    const env = { ...LLM_ENV };
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
  test("walkPaperLeaves", () => {
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
    assert.equal(leaves[0]!.isObjective, true);
  });
});

describe("ensureAccountAuth + grind orchestration (mocked)", () => {
  test("CAPTCHA_REQUIRED skips and continues others", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-cap-"));
    // No password env: refresh captcha ⇒ skip cap; ok uses existing jwt only
    const env = { ...LLM_ENV };
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
        llmAsk: okLlm,
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
    const env = { ...LLM_ENV };
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
      llmAsk: okLlm,
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
    const env = { ...LLM_ENV };
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
      llmAsk: okLlm,
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

  test("self and assist weekly quotas cap gaps and count as done below platform totals", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-quota-"));
    const env = { ...LLM_ENV };
    const cases = [
      ["self-q", { ...selfUsage(), listen_per_week: 2, speak_per_week: 1 }],
      ["assist-q", { ...assistMonths(2, "2026-10-19"), listen_per_week: 2, speak_per_week: 1 }],
    ] as const;
    for (const [id, usage] of cases) {
      await saveAccountTokens(
        {
          accountId: id,
          jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.q",
          makeActive: false,
          syncLegacy: false,
        },
        { home, env },
      );
      await setAccountUsage(id, usage, { home, env });
      let phase = 0;
      const needs: number[] = [];
      const row = (await resolveTargetAccounts({ kind: "ids", ids: [id] }, { home, env }))[0]!;
      const result = await grindOneAccount(row, {
        home,
        env,
        llmAsk: okLlm,
        now: () => new Date("2026-10-19T04:00:00Z"),
        listProgress: async () => {
          phase += 1;
          if (phase === 1) {
            return { listen_done: 0, listen_total: 5, speak_done: 0, speak_total: 3 };
          }
          return { listen_done: 2, listen_total: 5, speak_done: 1, speak_total: 3 };
        },
        grindListen: async (_p, need) => {
          needs.push(need);
          return { completed: need, taskIds: ["l"] };
        },
        grindSpeak: async (_p, need) => {
          needs.push(need);
          return { completed: need, taskIds: ["s"] };
        },
      });
      assert.equal(result.status, "done", id);
      assert.deepEqual(needs, [2, 1], id);
      assert.equal(result.before?.listen_total, 5, id);
      assert.equal(result.usage.listen_per_week, 2, id);
      assert.equal(result.usage.speak_per_week, 1, id);
    }
  });

  test("a side already at its weekly quota is not ground even if the platform total is higher", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-quota-done-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "capped", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.c" },
      { home, env },
    );
    await setAccountUsage(
      "capped",
      { ...selfUsage(), listen_per_week: 2, speak_per_week: 0 },
      { home, env },
    );
    let grindCalls = 0;
    const row = (await resolveTargetAccounts({ kind: "ids", ids: ["capped"] }, { home, env }))[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      listProgress: async () => ({
        listen_done: 2,
        listen_total: 5,
        speak_done: 0,
        speak_total: 3,
      }),
      grindListen: async () => {
        grindCalls += 1;
        return { completed: 1, taskIds: ["l"] };
      },
      grindSpeak: async () => {
        grindCalls += 1;
        return { completed: 1, taskIds: ["s"] };
      },
    });
    assert.equal(result.status, "skipped_done");
    assert.equal(grindCalls, 0);
    assert.equal(result.before?.speak_total, 3);
  });

  test("sanitizeSummaryForStdout: summary line carries note + masked id, never the phone", () => {
    const row = {
      account_id: "13912345678",
      alias: null,
      note: "一学期（5）",
      grind: "both" as const,
      status: "error" as const,
      before: null,
      after: null,
      listen_completed: 0,
      speak_completed: 0,
      listen_skipped: null,
      speak_skipped: null,
      usage: selfUsage(),
      usage_skip: null,
      errors: ["AUTH_FAILED: 13912345678 登录失败"],
      warnings: ["note 13912345678"],
    };
    const cleaned = sanitizeSummaryForStdout({ accounts: [row], started_at: "a", finished_at: "b" });
    const line = JSON.stringify({ event: "summary", ...cleaned });
    assert.doesNotMatch(line, /13912345678/);
    assert.equal(cleaned.accounts[0]!.account_id, "139****5678");
    assert.equal(cleaned.accounts[0]!.note, "一学期（5）");
    assert.match(cleaned.accounts[0]!.errors[0]!, /139\*\*\*\*5678 登录失败/);
    assert.equal(maskAccountId("me-local-id"), "***l-id");
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
          grind: "both",
          status: "error",
          before: null,
          after: null,
          listen_completed: 0,
          speak_completed: 0,
          listen_skipped: null,
          speak_skipped: null,
          usage: selfUsage(),
          usage_skip: null,
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
      env: { ...LLM_ENV },
      llmAsk: okLlm,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.taskId, "555");
    assert.ok(http.calls.some((c) => c.url.includes("submitAnswer")));
  });

  test("completeOneListen polls train_profile until type=train", async () => {
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
    let statusCalls = 0;
    const sleeps: number[] = [];
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        statusCalls += 1;
        if (statusCalls <= 2) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: {
                type: "train_profile",
                taskId: null,
                ansVersion: null,
                status: 0,
                flowId: "flow-1",
                tsId: "ts-1",
              },
            }),
          };
        }
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { type: "train", taskId: "777", ansVersion: 1, status: 0 },
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
      env: { ...LLM_ENV },
      llmAsk: okLlm,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      trainProfilePollMs: 10,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.taskId, "777");
    assert.ok(statusCalls >= 3);
    assert.ok(sleeps.length >= 1);
    assert.ok(http.calls.some((c) => c.url.includes("submitAnswer")));
  });

  test("completeOneListen train_profile timeout → train_profile_pending", async () => {
    const { completeOneListen } = await import("../src/grind-listen.js");
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              type: "train_profile",
              taskId: null,
              status: 0,
              flowId: "flow-x",
              tsId: "ts-x",
            },
          }),
        };
      }
      return { statusCode: 404, body: "{}" };
    });
    const result = await completeOneListen({
      credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t" },
      http,
      env: { ...LLM_ENV },
      llmAsk: okLlm,
      sleep: async () => {},
      trainProfileMaxPolls: 3,
      trainProfilePollMs: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.detail, /train_profile_pending/);
      assert.match(result.detail, /flow-x/);
      assert.match(result.detail, /ts-x/);
      assert.equal(result.detail.includes("eyJ"), false);
    }
  });

  test("grindListenGaps continues across post-submit train_profile", async () => {
    const { grindListenGaps } = await import("../src/grind-listen.js");
    const paper = {
      token: "paper-tok",
      paperJson: JSON.stringify({
        chr: [
          {
            q_qinstid: "1",
            q_template_name: "content-learn",
            nm: "learn",
            data: { children: [] },
          },
        ],
      }),
    };
    // Sequence of getUserStatus responses (shared counter).
    // Round1 before (grind) + completeOne first + after-wait polls + round2...
    const statuses: unknown[] = [
      { type: "train", taskId: "t1", ansVersion: 1, status: 0 }, // grind before r1
      { type: "train", taskId: "t1", ansVersion: 1, status: 0 }, // completeOne first
      { type: "train_profile", taskId: null, status: 0, flowId: "f", tsId: "s" }, // after submit wait
      { type: "train", taskId: "t2", ansVersion: 1, status: 0 }, // flipped
      { type: "train", taskId: "t2", ansVersion: 1, status: 0 }, // grind before r2
      { type: "train", taskId: "t2", ansVersion: 1, status: 0 }, // completeOne r2
      { type: "train", taskId: "t3", ansVersion: 1, status: 0 }, // after r2
    ];
    let si = 0;
    const http = mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        const value = statuses[Math.min(si, statuses.length - 1)];
        si += 1;
        return { statusCode: 200, body: JSON.stringify({ code: 1, value }) };
      }
      if (call.url.includes("loadPaper")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: paper }) };
      }
      if (call.url.includes("submitAnswer")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { ok: true } }) };
      }
      return { statusCode: 404, body: "{}" };
    });
    const result = await grindListenGaps(
      {
        credentials: { getJwt: async () => "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t" },
        http,
        env: { ...LLM_ENV },
        llmAsk: okLlm,
        sleep: async () => {},
        trainProfilePollMs: 1,
      },
      2,
    );
    assert.equal(result.completed, 2);
    assert.deepEqual(result.taskIds, ["t1", "t2"]);
    assert.equal(result.stoppedReason, undefined);
  });


});


describe("grind side policy", () => {
  test("resolveEffectiveGrind: CLI overrides meta; missing/invalid → both", () => {
    assert.equal(resolveEffectiveGrind(null, undefined), "both");
    assert.equal(resolveEffectiveGrind(undefined, "nope"), "both");
    assert.equal(resolveEffectiveGrind(null, "speak"), "speak");
    assert.equal(resolveEffectiveGrind("listen", "speak"), "listen");
    assert.equal(resolveEffectiveGrind("speak", "both"), "speak");
  });

  test("--speak-only only speaks even if meta=both", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-cli-speak-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "cli-s", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.cs" },
      { home, env },
    );
    let listenCalls = 0;
    let speakCalls = 0;
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["cli-s"] }, { home, env })
    )[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      grindOverride: "speak",
      listProgress: async () => ({
        listen_done: 0,
        listen_total: 5,
        speak_done: 1,
        speak_total: 3,
      }),
      grindListen: async () => {
        listenCalls += 1;
        return { completed: 1, taskIds: ["l"] };
      },
      grindSpeak: async (_p, need) => {
        speakCalls += 1;
        assert.equal(need, 2);
        return { completed: 2, taskIds: ["s1", "s2"] };
      },
    });
    assert.equal(listenCalls, 0);
    assert.equal(speakCalls, 1);
    assert.equal(result.grind, "speak");
    assert.equal(result.listen_completed, 0);
    assert.equal(result.speak_completed, 2);
    assert.match(result.listen_skipped ?? "", /CLI --speak-only/);
    assert.equal(result.speak_skipped, null);
  });

  test("--listen-only only listens even if meta=both", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-cli-listen-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "cli-l", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.cl" },
      { home, env },
    );
    let listenCalls = 0;
    let speakCalls = 0;
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["cli-l"] }, { home, env })
    )[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      grindOverride: "listen",
      listProgress: async () => ({
        listen_done: 1,
        listen_total: 3,
        speak_done: 0,
        speak_total: 5,
      }),
      grindListen: async (_p, need) => {
        listenCalls += 1;
        assert.equal(need, 2);
        return { completed: 2, taskIds: ["l1", "l2"] };
      },
      grindSpeak: async () => {
        speakCalls += 1;
        return { completed: 1, taskIds: ["s"] };
      },
    });
    assert.equal(listenCalls, 1);
    assert.equal(speakCalls, 0);
    assert.equal(result.grind, "listen");
    assert.match(result.speak_skipped ?? "", /CLI --listen-only/);
  });

  test("meta.grind=speak skips listen under --all (summary marks skip)", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-meta-speak-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      {
        accountId: "meta-s",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.ms",
        metaPatch: { note: "一学期，单刷口语（1）" },
      },
      { home, env },
    );
    await setAccountGrind("meta-s", "speak", { home, env });

    let listenCalls = 0;
    let speakCalls = 0;
    const summary = await runWeeklyGrind(
      { kind: "all" },
      {
        home,
        env,
        llmAsk: okLlm,
        listProgress: async () => ({
          listen_done: 0,
          listen_total: 5,
          speak_done: 0,
          speak_total: 3,
        }),
        grindListen: async () => {
          listenCalls += 1;
          return { completed: 1, taskIds: ["l"] };
        },
        grindSpeak: async (_p, need) => {
          speakCalls += 1;
          assert.equal(need, 3);
          return { completed: 3, taskIds: ["s1", "s2", "s3"] };
        },
      },
    );
    assert.equal(listenCalls, 0);
    assert.equal(speakCalls, 1);
    const row = summary.accounts[0]!;
    assert.equal(row.grind, "speak");
    assert.match(row.listen_skipped ?? "", /meta\.grind=speak/);
    assert.equal(row.speak_skipped, null);
    assert.equal(row.listen_completed, 0);
    assert.equal(row.speak_completed, 3);
  });

  test("expired assist skips before progress; a later window still runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-usage-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "assist-old", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.old" },
      { home, env },
    );
    await setAccountUsage("assist-old", assistMonths(1, "2020-01-01"), { home, env });
    const listed = await listAccounts({ home, env });
    let progressCalls = 0;
    const expired = await grindOneAccount(listed[0]!, {
      home,
      env,
      llmAsk: okLlm,
      now: () => new Date("2026-10-19T04:00:00Z"),
      listProgress: async () => {
        progressCalls += 1;
        return { listen_done: 5, listen_total: 5, speak_done: 3, speak_total: 3 };
      },
    });
    assert.equal(progressCalls, 0);
    assert.equal(expired.status, "skipped_expired");
    assert.match(expired.usage_skip ?? "", /2020-01-15/);
    assert.equal(expired.listen_completed, 0);

    await setAccountUsage("assist-old", assistMonths(4, "2026-10-19"), { home, env });
    const again = (await listAccounts({ home, env }))[0]!;
    const open = await grindOneAccount(again, {
      home,
      env,
      llmAsk: okLlm,
      now: () => new Date("2026-10-19T04:00:00Z"),
      listProgress: async () => {
        progressCalls += 1;
        return { listen_done: 5, listen_total: 5, speak_done: 3, speak_total: 3 };
      },
    });
    assert.equal(progressCalls, 1);
    assert.equal(open.status, "skipped_done");
    assert.equal(open.usage_skip, null);
    assert.equal(open.usage.expires_at, "2027-01-15");
  });

  test("a zero-quota side with null platform counters still counts as done", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-zero-null-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "zn", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.n" },
      { home, env },
    );
    await setAccountUsage("zn", { ...selfUsage(), speak_per_week: 0 }, { home, env });
    let grindCalls = 0;
    const row = (await listAccounts({ home, env }))[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      listProgress: async () => ({ listen_done: 5, listen_total: 5, speak_done: null, speak_total: null }),
      grindListen: async () => { grindCalls += 1; return { completed: 1, taskIds: [] }; },
      grindSpeak: async () => { grindCalls += 1; return { completed: 1, taskIds: [] }; },
    });
    assert.equal(result.status, "skipped_done");
    assert.equal(grindCalls, 0);
  });

  test("a zero-quota side is never auto-placed", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-zero-place-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "zp", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zp" },
      { home, env },
    );
    await setAccountUsage("zp", { ...selfUsage(), listen_per_week: 0, speak_per_week: 3 }, { home, env });
    const statusFlows: string[] = [];
    let submits = 0;
    const row = (await listAccounts({ home, env }))[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      skipPlacement: false,
      listProgress: async () => ({ error: "NEEDS_PLACEMENT: 听力仍在定级", code: "NEEDS_PLACEMENT" }),
      http: mockHttp(async (call) => {
        if (call.url.includes("getUserStatus")) {
          statusFlows.push(call.url.includes("flowType=listen") ? "listen" : "speak");
          return {
            statusCode: 200,
            body: JSON.stringify({ code: 1, value: { type: "train", taskId: "t1", ansVersion: 1, status: 1 } }),
          };
        }
        if (call.url.includes("submitAnswer")) submits += 1;
        return { statusCode: 404, body: "{}" };
      }),
    });
    assert.deepEqual(statusFlows, ["speak"]);
    assert.equal(submits, 0);
    assert.equal(result.status, "needs_placement");
    assert.match(result.errors.join(" "), /配额为 0 的一侧（listen）不自动定级/);
  });

  test("assist with a future --from skips before progress", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-usage-future-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "assist-future", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.f" },
      { home, env },
    );
    await setAccountUsage("assist-future", assistUntil("2027-06-30", "2027-01-01"), { home, env });
    let progressCalls = 0;
    const row = (await listAccounts({ home, env }))[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      now: () => new Date("2026-10-19T04:00:00Z"),
      listProgress: async () => {
        progressCalls += 1;
        return { listen_done: 0, listen_total: 5, speak_done: 0, speak_total: 3 };
      },
    });
    assert.equal(progressCalls, 0);
    assert.equal(result.status, "skipped_not_started");
    assert.match(result.usage_skip ?? "", /2027-01-01/);
  });

  test("all enabled quotas 0 skip before auth, progress, and placement", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-usage-zero-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "zero", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.z" },
      { home, env },
    );
    await setAccountUsage(
      "zero",
      { ...selfUsage(), listen_per_week: 0, speak_per_week: 0 },
      { home, env },
    );
    let progressCalls = 0;
    const row = (await listAccounts({ home, env }))[0]!;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      listProgress: async () => {
        progressCalls += 1;
        return { error: "NEEDS_PLACEMENT: grade", code: "NEEDS_PLACEMENT" };
      },
    });
    assert.equal(progressCalls, 0);
    assert.equal(result.status, "skipped_done");
    assert.match(result.usage_skip ?? "", /0/);
    assert.equal(result.listen_completed + result.speak_completed, 0);

    // speak-only policy with speak=0 also counts as all-zero even if listen is configured.
    await setAccountUsage(
      "zero",
      { ...selfUsage(), listen_per_week: 3, speak_per_week: 0 },
      { home, env },
    );
    const speakOnly = await grindOneAccount((await listAccounts({ home, env }))[0]!, {
      home,
      env,
      llmAsk: okLlm,
      grindOverride: "speak",
      listProgress: async () => {
        progressCalls += 1;
        return { listen_done: 0, listen_total: 5, speak_done: 0, speak_total: 3 };
      },
    });
    assert.equal(progressCalls, 0);
    assert.equal(speakOnly.status, "skipped_done");
  });

  test("CLI override beats meta.grind", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-cli-vs-meta-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "ov", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.ov" },
      { home, env },
    );
    await setAccountGrind("ov", "speak", { home, env });
    let listenCalls = 0;
    let speakCalls = 0;
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["ov"] }, { home, env })
    )[0]!;
    assert.equal(row.grind, "speak");
    await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      grindOverride: "listen",
      listProgress: async () => ({
        listen_done: 0,
        listen_total: 2,
        speak_done: 0,
        speak_total: 2,
      }),
      grindListen: async () => {
        listenCalls += 1;
        return { completed: 2, taskIds: ["l1", "l2"] };
      },
      grindSpeak: async () => {
        speakCalls += 1;
        return { completed: 2, taskIds: ["s1", "s2"] };
      },
    });
    assert.equal(listenCalls, 1);
    assert.equal(speakCalls, 0);
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
      llmAsk: okLlm,
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

describe("needs_placement", () => {
  test("--skip-placement marks needs_placement without auto", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-place-skip-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "place1", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.p1" },
      { home, env },
    );
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["place1"] }, { home, env })
    )[0]!;
    let autoCalls = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      skipPlacement: true,
      listProgress: async () => ({
        error: "NEEDS_PLACEMENT: 听力仍在定级",
        code: "NEEDS_PLACEMENT",
      }),
      grindListen: async () => {
        autoCalls += 1;
        return { completed: 0, taskIds: [] };
      },
      grindSpeak: async () => {
        autoCalls += 1;
        return { completed: 0, taskIds: [] };
      },
    });
    assert.equal(result.status, "needs_placement");
    assert.equal(autoCalls, 0);
    assert.match(result.errors.join(" "), /needs_placement|NEEDS_PLACEMENT/);
  });

  test("auto placement then continues when progress recovers", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-place-auto-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "place2", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.p2" },
      { home, env },
    );
    const row = (
      await resolveTargetAccounts({ kind: "ids", ids: ["place2"] }, { home, env })
    )[0]!;
    let progressCalls = 0;
    let listenCalls = 0;
    let submitted = false;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      skipPlacement: false,
      listProgress: async () => {
        progressCalls += 1;
        if (progressCalls === 1) {
          return {
            error: "NEEDS_PLACEMENT: 听力仍在定级",
            code: "NEEDS_PLACEMENT",
          };
        }
        return {
          listen_done: 0,
          listen_total: 5,
          speak_done: 3,
          speak_total: 3,
        };
      },
      // Inject placement via grind ports by stubbing http at runAutoPlacement level:
      // runAutoPlacement will hit real http unless we short-circuit: use skip is false
      // and provide http that answers grade→train for getUserStatus + loadPaper + submit.
      http: mockHttp(async (call) => {
        if (call.url.includes("getUserStatus")) {
          // first few grade, then train so runAutoPlacement completes
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: {
                type: submitted ? "train" : "grade",
                taskId: "g1",
                ansVersion: 1,
                status: 1,
              },
            }),
          };
        }
        if (call.url.includes("loadPaper")) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: {
                token: "tok",
                paperJson: JSON.stringify({
                  chr: [
                    {
                      q_qinstid: "1",
                      q_template_name: "content-learn",
                      nm: "learn",
                      data: { children: [] },
                    },
                  ],
                }),
              },
            }),
          };
        }
        if (call.url.includes("submitAnswer")) {
          submitted = true;
          return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
        }
        return { statusCode: 404, body: "{}" };
      }),
      grindListen: async (_p, need) => {
        listenCalls += 1;
        assert.equal(need, 5);
        return { completed: 5, taskIds: ["a", "b", "c", "d", "e"] };
      },
      grindSpeak: async () => ({ completed: 0, taskIds: [] }),
    });
    assert.ok(progressCalls >= 2);
    assert.equal(listenCalls, 1);
    assert.ok(submitted);
    assert.ok(["done", "ground"].includes(result.status));
    assert.equal(result.listen_completed, 5);
  });

  test("parseWeeklyGrindArgs accepts --skip-placement", () => {
    const parsed = parseWeeklyGrindArgs(["--all", "--skip-placement"]);
    assert.equal(parsed.skipPlacement, true);
    assert.equal(parsed.mode.kind, "all");
  });
});

describe("runWeeklyGrind resilience", () => {
  test("a throwing account still yields JSON summary; --all continues", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-throw-"));
    const env = { ...LLM_ENV };
    for (const id of ["boom", "fine"]) {
      await saveAccountTokens(
        { accountId: id, jwt: `eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.${id}`, makeActive: false, syncLegacy: false },
        { home, env },
      );
      await setAccountGrind(id, "speak", { home, env });
    }
    let calls = 0;
    const summary = await runWeeklyGrind(
      { kind: "all" },
      {
        home,
        env,
        llmAsk: okLlm,
        listProgress: async () => {
          calls += 1;
          if (calls === 1) throw new Error("Unexpected server response: 403");
          return { listen_done: 5, listen_total: 5, speak_done: 3, speak_total: 3 };
        },
      },
    );
    const boom = summary.accounts.find((a) => a.account_id === "boom");
    assert.equal(boom?.status, "error");
    assert.equal(boom?.error_class, "FORBIDDEN");
    assert.equal(summary.accounts.length, 2);
    assert.equal(summary.totals?.error, 1);
  });
});

describe("grindOneAccount side isolation", () => {
  test("speak throw keeps listen completions; caught class propagates", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-side-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "both", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.b", makeActive: false, syncLegacy: false },
      { home, env },
    );
    const summary = await runWeeklyGrind(
      { kind: "ids", ids: ["both"] },
      {
        home,
        env,
        llmAsk: okLlm,
        listProgress: async () => ({ listen_done: 0, listen_total: 2, speak_done: 0, speak_total: 1 }),
        grindListen: async () => ({ completed: 2, taskIds: ["a", "b"] }),
        grindSpeak: async () => ({ completed: 0, taskIds: [], stoppedReason: "tts/upload TIMEOUT: Timed out", errorClass: "TIMEOUT" as const }),
      },
    );
    const a = summary.accounts[0];
    assert.equal(a.listen_completed, 2);
    assert.equal(a.error_class, "TIMEOUT");
    assert.equal(a.status, "ground");
  });
});

describe("per-paper result reporter wiring (#88)", () => {
  test("resultsFor gets the note to print + the account id for the ledger key; its reporter reaches both grind sides", async () => {
    const { setAccountNote } = await import("../src/accounts.js");
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-results-"));
    const env = { ...LLM_ENV };
    await saveAccountTokens(
      { accountId: "13900000000", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.b", makeActive: false, syncLegacy: false },
      { home, env },
    );
    await setAccountNote("13900000000", "一学期（5听3口）", { home, env });
    const notes: Array<string | null> = [];
    const ids: string[] = [];
    const reporter = { report: async () => {}, isSubmitted: () => false };
    const seen: unknown[] = [];
    await runWeeklyGrind(
      { kind: "ids", ids: ["13900000000"] },
      {
        home,
        env,
        llmAsk: okLlm,
        resultsFor: async (note, accountId) => (notes.push(note), ids.push(accountId), reporter),
        listProgress: async () => ({ listen_done: 0, listen_total: 1, speak_done: 0, speak_total: 1 }),
        grindListen: async (p) => (seen.push((p as { results?: unknown }).results), { completed: 1, taskIds: ["a"] }),
        grindSpeak: async (p) => (seen.push((p as { results?: unknown }).results), { completed: 1, taskIds: ["b"] }),
      },
    );
    assert.deepEqual(notes, ["一学期（5听3口）"]);
    assert.deepEqual(ids, ["13900000000"]);
    assert.deepEqual(seen, [reporter, reporter]);
  });
});

describe("answer refusal (no LLM answer → no submit, account stops)", () => {
  const progress = async () => ({ listen_done: 0, listen_total: 3, speak_done: 0, speak_total: 3 });
  async function oneRow(id: string, env: Record<string, string>) {
    const home = await mkdtemp(join(tmpdir(), `unipus-wg-refuse-${id}-`));
    await saveAccountTokens({ accountId: id, jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.r" }, { home, env });
    const row = (await resolveTargetAccounts({ kind: "ids", ids: [id] }, { home, env }))[0]!;
    return { home, row };
  }

  test("no UNIPUS_LLM_* config (SiliconFlow only) → error before login/progress/grind", async () => {
    const env = { SILICONFLOW_API_KEY: "k" };
    const { home, row } = await oneRow("nollm", env);
    let progressCalls = 0;
    let grindCalls = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      listProgress: async () => { progressCalls++; return progress(); },
      grindListen: async () => { grindCalls++; return { completed: 1, taskIds: ["l"] }; },
      grindSpeak: async () => { grindCalls++; return { completed: 1, taskIds: ["s"] }; },
    });
    assert.equal(result.status, "error");
    assert.match(result.errors.join("\n"), /ANSWER_REFUSED[\s\S]*UNIPUS_LLM_BASE_URL/);
    assert.equal(progressCalls, 0);
    assert.equal(grindCalls, 0);
  });

  test("LLM unreachable and network never recovers → NETWORK_DOWN before login/progress/grind (#102)", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("probe", env);
    let progressCalls = 0;
    let grindCalls = 0;
    let waits = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      waitNetwork: async () => { waits++; return false; },
      llmAsk: async () => { throw new Error("fetch failed"); },
      listProgress: async () => { progressCalls++; return progress(); },
      grindListen: async () => { grindCalls++; return { completed: 1, taskIds: ["l"] }; },
      grindSpeak: async () => { grindCalls++; return { completed: 1, taskIds: ["s"] }; },
    });
    assert.equal(result.status, "error");
    assert.match(result.errors.join("\n"), /NETWORK_DOWN[\s\S]*重跑[\s\S]*探活失败[\s\S]*fetch failed/);
    assert.equal(result.network_down, true);
    assert.equal(result.error_class, "NETWORK");
    assert.equal(waits, 1);
    assert.equal(progressCalls, 0);
    assert.equal(grindCalls, 0);
  });

  test("LLM probe network failure waits, then the account runs once the network is back (#102)", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("probe-back", env);
    let asks = 0;
    let waits = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      waitNetwork: async () => { waits++; return true; },
      llmAsk: async () => { if (++asks <= 2) throw new Error("fetch failed"); return "OK"; },
      listProgress: progress,
      grindListen: async () => ({ completed: 3, taskIds: ["a", "b", "c"] }),
      grindSpeak: async () => ({ completed: 3, taskIds: ["d", "e", "f"] }),
    });
    assert.equal(waits, 1, "probeLlm tries twice, then one wait, then succeeds");
    assert.notEqual(result.status, "error");
    assert.equal(result.network_down, undefined);
  });

  test("probe passes but the LLM host stays unreachable → bounded by UNIPUS_NET_RETRIES (#102)", async () => {
    const env = { ...LLM_ENV, UNIPUS_NET_RETRIES: "2" };
    const { home, row } = await oneRow("probe-loop", env);
    let waits = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      waitNetwork: async () => { waits++; return true; },
      llmAsk: async () => { throw new Error("fetch failed"); },
      listProgress: progress,
    });
    assert.equal(waits, 2);
    assert.equal(result.status, "error");
    assert.match(result.errors.join("\n"), /探活失败[\s\S]*fetch failed/);
  });

  test("RT+JWT account: refresh network failure does not trust stale JWT; auth waits (#102)", async () => {
    const env = { ...LLM_ENV };
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-rtnet-"));
    // Normal saved-token shape: both rt and jwt present; jwt may be expired.
    await saveAccountTokens({ accountId: "rtnet", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.r", refreshToken: "rt", makeActive: false, syncLegacy: false }, { home, env });
    const row = (await resolveTargetAccounts({ kind: "ids", ids: ["rtnet"] }, { home, env }))[0]!;
    let refreshes = 0;
    let progressCalls = 0;
    const waits: string[] = [];
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async (why: string) => { waits.push(why); return false; },
      refreshRt: async () => { refreshes++; return { ok: false, code: "NETWORK_ERROR", message: "fetch failed" }; },
      listProgress: async () => { progressCalls++; return progress(); },
    });
    assert.equal(refreshes, 1);
    assert.equal(progressCalls, 0, "must not proceed with stale JWT");
    assert.match(waits[0]!, /登录.*refresh: fetch failed/);
    assert.equal(result.network_down, true);
  });

  test("RT+JWT account: after network recovers, refresh is re-tried and the account runs (#102)", async () => {
    const env = { ...LLM_ENV };
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-rtback-"));
    await saveAccountTokens({ accountId: "rtback", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.old", refreshToken: "rt", makeActive: false, syncLegacy: false }, { home, env });
    const row = (await resolveTargetAccounts({ kind: "ids", ids: ["rtback"] }, { home, env }))[0]!;
    let refreshes = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async () => true,
      refreshRt: async () => {
        refreshes++;
        if (refreshes === 1) return { ok: false, code: "NETWORK_ERROR", message: "fetch failed" };
        return { ok: true, jwt: "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.new", refreshToken: "rt2", jwtExpire: 9999999999, serviceTicket: "st" } as never;
      },
      listProgress: progress,
      grindListen: async () => ({ completed: 3, taskIds: ["a", "b", "c"] }),
      grindSpeak: async () => ({ completed: 3, taskIds: ["d", "e", "f"] }),
    });
    assert.equal(refreshes, 2);
    assert.notEqual(result.status, "error");
    assert.equal(result.network_down, undefined);
  });

  test("UNIPUS_NET_WAIT_MAX_MS=0 keeps the old behaviour: no wait, no NETWORK_DOWN", async () => {
    const env = { ...LLM_ENV, UNIPUS_NET_WAIT_MAX_MS: "0" };
    const { home, row } = await oneRow("netoff", env);
    const result = await grindOneAccount(row, { home, env, llmAsk: async () => { throw new Error("fetch failed"); } });
    assert.equal(result.status, "error");
    assert.equal(result.network_down, undefined);
    assert.match(result.errors.join("\n"), /ANSWER_REFUSED[\s\S]*fetch failed/);
  });

  test("side NETWORK_DOWN returns at once, without another progress wait (#102)", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("sidedown", env);
    let progressCalls = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async () => false,
      listProgress: async () => { progressCalls++; return progress(); },
      grindListen: async () => ({ completed: 1, taskIds: ["a"], stoppedReason: "NETWORK_DOWN: x", networkDown: true }),
    });
    assert.equal(progressCalls, 1, "only the before-progress call");
    assert.equal(result.network_down, true);
    assert.equal(result.listen_completed, 1);
  });

  test("post-placement / post-grind progress outage surfaces NETWORK_DOWN (#102)", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("afterdown", env);
    let n = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async () => false,
      listProgress: async () => (++n === 1 ? progress() : { error: "NETWORK_ERROR: 拉取听力本周失败（网络）：fetch failed" }),
      grindListen: async () => ({ completed: 3, taskIds: ["a", "b", "c"] }),
      grindSpeak: async () => ({ completed: 3, taskIds: ["d", "e", "f"] }),
    });
    assert.equal(result.network_down, true);
    assert.match(result.errors.join("\n"), /NETWORK_DOWN/);
    assert.equal(result.speak_completed, 3);
  });

  test("placement network failure: waits, never re-submits placement, NETWORK_DOWN when still down (#102)", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("placedown", env);
    let placements = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async () => false,
      listProgress: async () => ({ error: "NEEDS_PLACEMENT: 听力仍在定级", code: "NEEDS_PLACEMENT" }),
      http: new Proxy({}, { get: () => async () => { placements++; throw new TypeError("fetch failed"); } }) as never,
    });
    assert.ok(placements >= 1, "placement reached the network");
    assert.equal(result.network_down, true);
    assert.match(result.errors.join("\n"), /NETWORK_DOWN[\s\S]*定级/);
  });

  test("placement network failure that recovers → needs_placement (resumable), not ordinary refusal (#102)", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("placerecover", env);
    let waits = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async () => { waits++; return true; },
      listProgress: async () => ({ error: "NEEDS_PLACEMENT: 听力仍在定级", code: "NEEDS_PLACEMENT" }),
      http: new Proxy({}, { get: () => async () => { throw new TypeError("fetch failed"); } }) as never,
    });
    assert.equal(waits, 1);
    assert.equal(result.status, "needs_placement");
    assert.match(result.errors.join("\n"), /网络已恢复.*重跑续上/);
  });

  test("real LLM refusal (empty reply) never waits for the network", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("probe-empty", env);
    let waits = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      waitNetwork: async () => { waits++; return true; },
      llmAsk: async () => "",
      listProgress: progress,
    });
    assert.equal(result.status, "error");
    assert.match(result.errors.join("\n"), /ANSWER_REFUSED[\s\S]*empty reply/);
    assert.equal(waits, 0);
  });

  test("listen side NETWORK_DOWN → speak skipped, run stops before the next account (#102)", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-wg-netdown-"));
    const env = { ...LLM_ENV };
    for (const id of ["n1", "n2"]) {
      await saveAccountTokens(
        { accountId: id, jwt: `eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.${id}`, makeActive: false, syncLegacy: false },
        { home, env },
      );
    }
    let speakCalls = 0;
    let listenCalls = 0;
    const summary = await runWeeklyGrind({ kind: "all" }, {
      home,
      env,
      llmAsk: okLlm,
      waitNetwork: async () => false,
      listProgress: progress,
      grindListen: async () => { listenCalls++; return { completed: 0, taskIds: [], stoppedReason: "NETWORK_DOWN: x", networkDown: true, errorClass: "NETWORK" }; },
      grindSpeak: async () => { speakCalls++; return { completed: 0, taskIds: [] }; },
    });
    assert.equal(summary.accounts.length, 1, "second account is left for the resumed run");
    assert.equal(summary.accounts[0]!.network_down, true);
    assert.equal(listenCalls, 1);
    assert.equal(speakCalls, 0);
  });

  test("listen refused → speak not run, account status error", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("lref", env);
    let speakCalls = 0;
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      listProgress: progress,
      grindListen: async () => ({ completed: 1, taskIds: ["l1"], stoppedReason: "ANSWER_REFUSED: x", refused: true }),
      grindSpeak: async () => { speakCalls++; return { completed: 1, taskIds: ["s"] }; },
    });
    assert.equal(speakCalls, 0);
    assert.equal(result.status, "error");
    assert.equal(result.listen_completed, 1);
    assert.match(result.errors.join("\n"), /listen: ANSWER_REFUSED/);
    assert.match(result.errors.join("\n"), /speak: 跳过/);
  });

  test("speak refused → status error even with listen done", async () => {
    const env = { ...LLM_ENV };
    const { home, row } = await oneRow("sref", env);
    const result = await grindOneAccount(row, {
      home,
      env,
      llmAsk: okLlm,
      listProgress: progress,
      grindListen: async () => ({ completed: 3, taskIds: ["a", "b", "c"] }),
      grindSpeak: async () => ({ completed: 0, taskIds: [], stoppedReason: "ANSWER_REFUSED: y", refused: true }),
    });
    assert.equal(result.status, "error");
    assert.equal(result.listen_completed, 3);
  });
});
