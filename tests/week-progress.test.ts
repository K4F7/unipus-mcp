import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_WEEK_PROGRESS_PATH,
  resolveSpeakWeekProgressUrl,
  resolveWeekProgressUrl,
} from "../src/config.js";
import { listWeekProgress } from "../src/week-progress.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    async request(input) {
      calls.push({ url: input.url, headers: input.headers ?? {} });
      return handler({
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
      });
    },
  };
}

describe("resolveWeekProgressUrl", () => {
  test("defaults to uadaptive activation/status (raw-JWT host)", () => {
    assert.equal(
      resolveWeekProgressUrl({}),
      `https://uadaptive.unipus.cn${DEFAULT_ULS_WEEK_PROGRESS_PATH}`,
    );
  });

  test("honors UNIPUS_ULS_ADAPTIVE_ORIGIN and UNIPUS_ULS_WEEK_PROGRESS_PATH", () => {
    assert.equal(
      resolveWeekProgressUrl({
        UNIPUS_ULS_ADAPTIVE_ORIGIN: "https://uai.unipus.cn/",
        UNIPUS_ULS_WEEK_PROGRESS_PATH: "/api/uls/home/week",
      }),
      "https://uai.unipus.cn/api/uls/home/week",
    );
  });

  test("UNIPUS_ULS_ORIGIN still overrides host when set", () => {
    assert.equal(
      resolveWeekProgressUrl({
        UNIPUS_ULS_ORIGIN: "https://ucloud.unipus.cn/",
        UNIPUS_ULS_WEEK_PROGRESS_PATH: "/api/uls/user/activation/status",
      }),
      "https://ucloud.unipus.cn/api/uls/user/activation/status",
    );
  });
});

describe("listWeekProgress", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => null },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.deepEqual(http.calls, []);
  });

  test("returns structured progress when JWT ok and body parseable", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        progress_done: 0,
        progress_total: 5,
        level: "S15",
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.equal(result.progress_done, 0);
    assert.equal(result.progress_total, 5);
    assert.equal(result.level, "S15");
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, resolveWeekProgressUrl({}));
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /i);
    assert.doesNotMatch(JSON.stringify(result), /eyJhbGci/);
  });

  test("normalizes nested / alias fields into stable progress_* / level", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        data: { done: 2, total: 5, levelName: "S12" },
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(result.progress_done, 2);
    assert.equal(result.progress_total, 5);
    assert.equal(result.level, "S12");
  });

  test("HTTP 401 is auth_required (distinct from network)", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 401,
      body: JSON.stringify({ message: "Missing JWT token in request" }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.equal(result.code, "AUTH_REQUIRED");
    assert.match(result.message, /401|JWT|登录/);
  });

  test("network failure is error NETWORK_ERROR (distinct from 401)", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http: UnipusHttp = {
      async request() {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    };
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "error");
    assert.equal(result.code, "NETWORK_ERROR");
    assert.match(result.message, /ECONNREFUSED|网络|失败/);
    assert.notEqual(result.status, "auth_required");
  });

  test("unparseable 200 body is error PARSE_ERROR", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ hello: "world" }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, true);
    assert.equal(result.status, "error");
    assert.equal(result.code, "PARSE_ERROR");
  });
});

describe("listWeekProgress twin listen/speak fields", () => {
  test("maps listen_* and aliases progress_* from twin body fields", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        listen_done: 2,
        listen_total: 5,
        speak_done: 1,
        speak_total: 3,
        level: "S15",
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 2);
    assert.equal(result.listen_total, 5);
    assert.equal(result.speak_done, 1);
    assert.equal(result.speak_total, 3);
    // backward-compat: progress_* aliases listen
    assert.equal(result.progress_done, 2);
    assert.equal(result.progress_total, 5);
    assert.equal(result.level, "S15");
  });

  test("legacy progress-only body still fills listen_* and leaves speak null", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        progress_done: 0,
        progress_total: 5,
        level: "S15",
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 0);
    assert.equal(result.listen_total, 5);
    assert.equal(result.progress_done, 0);
    assert.equal(result.progress_total, 5);
    assert.equal(result.speak_done, null);
    assert.equal(result.speak_total, null);
  });

  test("optional speak path env triggers second GET without inventing a default URL", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const calls: string[] = [];
    const http = mockHttp(async (input) => {
      calls.push(input.url);
      if (input.url.includes("speak-week")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ speak_done: 0, speak_total: 3 }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ progress_done: 1, progress_total: 5, level: "S12" }),
      };
    });
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {
        UNIPUS_ULS_ORIGIN: "https://ucloud.unipus.cn",
        UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH: "/api/uls/speak-week",
      },
      weekProgressUrl: resolveWeekProgressUrl({
        UNIPUS_ULS_ORIGIN: "https://ucloud.unipus.cn",
      }),
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 1);
    assert.equal(result.listen_total, 5);
    assert.equal(result.speak_done, 0);
    assert.equal(result.speak_total, 3);
    assert.equal(calls.length, 2);
    assert.ok(calls.some((u) => u.endsWith(DEFAULT_ULS_WEEK_PROGRESS_PATH)));
    assert.ok(calls.some((u) => u.endsWith("/api/uls/speak-week")));
  });

  test("without speak path env, only one HTTP call", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ done: 2, total: 5, levelName: "S12" }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {},
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(http.calls.length, 1);
    assert.equal(result.speak_done, null);
    assert.equal(result.speak_total, null);
  });

  test("parses activation/status listenTrialUsed + speakTrialUsed + trialUsageLimit", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        msg: "SUCCESS",
        value: {
          listenTrialUsed: 2,
          speakTrialUsed: 0,
          trialUsageLimit: 3,
          listenTrialExceeded: false,
          speakTrialExceeded: false,
          status: 0,
        },
        success: true,
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {},
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 2);
    assert.equal(result.listen_total, 3);
    assert.equal(result.speak_done, 0);
    assert.equal(result.speak_total, 3);
    assert.equal(result.progress_done, 2);
    assert.equal(result.progress_total, 3);
    assert.match(result.message, /本周试用/);
    assert.match(result.message, /付费周配额 path 未验证|试用账号已对齐/);
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.headers.authorization, jwt);
    assert.doesNotMatch(http.calls[0]?.headers.authorization ?? "", /^Bearer /i);
    assert.ok(http.calls[0]?.url.includes("uadaptive.unipus.cn"));
  });

  test("parses listen trainingReport weeklyCompleted/weeklyTarget", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        value: { weeklyCompleted: 1, weeklyTarget: 5, weeklyProgress: "1/5" },
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {},
      weekProgressUrl: resolveWeekProgressUrl({}),
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 1);
    assert.equal(result.listen_total, 5);
    assert.equal(result.speak_done, null);
    assert.equal(result.speak_total, null);
  });
});

describe("resolveSpeakWeekProgressUrl", () => {
  test("returns null when speak path env unset (no invented default)", () => {
    assert.equal(resolveSpeakWeekProgressUrl({}), null);
  });

  test("builds URL when UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH is set", () => {
    assert.equal(
      resolveSpeakWeekProgressUrl({
        UNIPUS_ULS_ADAPTIVE_ORIGIN: "https://uai.unipus.cn/",
        UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH: "api/uls/oral/week",
      }),
      "https://uai.unipus.cn/api/uls/oral/week",
    );
  });

  test("speak path defaults host to uadaptive when only path set", () => {
    assert.equal(
      resolveSpeakWeekProgressUrl({
        UNIPUS_ULS_SPEAK_WEEK_PROGRESS_PATH: "/api/uls/user/activation/status",
      }),
      "https://uadaptive.unipus.cn/api/uls/user/activation/status",
    );
  });
});

describe("listWeekProgress paid trainingReport path", () => {
  function paidHttp(handlers: {
    status?: Record<string, unknown>;
    report?: Record<string, unknown>;
    activation?: Record<string, unknown>;
  }): UnipusHttp & { calls: Array<{ url: string; method: string; body?: string }> } {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    return {
      calls,
      async request(input) {
        const method = input.method ?? "GET";
        calls.push({ url: input.url, method, body: input.body });
        if (input.url.includes("getUserStatus")) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: handlers.status ?? {
                type: "train",
                taskId: "104413919195601795",
                ansVersion: 1,
                status: 0,
                currentLevel: "S15",
              },
            }),
          };
        }
        if (input.url.includes("trainingReport")) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              msg: "SUCCESS",
              value: handlers.report ?? {
                weeklyCompleted: 5,
                weeklyTarget: 5,
                weeklyProgress: "5/5",
              },
            }),
          };
        }
        if (input.url.includes("activation/status")) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              code: 1,
              value: handlers.activation ?? {
                status: 1,
                isPurchased: 0,
                listenTrialUsed: null,
                speakTrialUsed: null,
                trialUsageLimit: null,
              },
            }),
          };
        }
        return { statusCode: 404, body: "{}" };
      },
    };
  }

  test("null trial fields do not PARSE_ERROR when trainingReport has week", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = paidHttp({});
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {},
    });
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.listen_done, 5);
    assert.equal(result.listen_total, 5);
    assert.equal(result.speak_done, null);
    assert.equal(result.speak_total, null);
    assert.equal(result.level, "S15");
    assert.doesNotMatch(result.message, /试用/);
    assert.match(result.message, /听力\s*5\/5/);
    assert.ok(http.calls.some((c) => c.url.includes("getUserStatus")));
    assert.ok(http.calls.some((c) => c.url.includes("trainingReport") && c.method === "POST"));
  });

  test("legacy forced URL with only null trials still PARSE_ERROR (no invented speak 3)", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        value: {
          listenTrialUsed: null,
          speakTrialUsed: null,
          trialUsageLimit: null,
          status: 1,
        },
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl:
        "https://uadaptive.unipus.cn/api/uls/user/activation/status",
    });
    assert.equal(result.isError, true);
    assert.equal(result.code, "PARSE_ERROR");
    assert.doesNotMatch(JSON.stringify(result), /"speak_done":\s*3/);
  });

  test("maps trainingReport weeklyCompleted/weeklyTarget and POSTs taskId", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = paidHttp({
      status: {
        type: "train",
        taskId: "99",
        ansVersion: 1,
        currentLevel: "S12",
      },
      report: {
        weeklyCompleted: 2,
        weeklyTarget: 5,
        weeklyProgress: "2/5",
      },
    });
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {},
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 2);
    assert.equal(result.listen_total, 5);
    assert.equal(result.speak_done, null);
    assert.equal(result.speak_total, null);
    assert.equal(result.level, "S12");
    const reportCall = http.calls.find((c) => c.url.includes("trainingReport"));
    assert.ok(reportCall);
    assert.equal(reportCall?.method, "POST");
    assert.deepEqual(JSON.parse(reportCall?.body ?? "{}"), {
      taskId: "99",
      ansVersion: 1,
    });
  });

  test("weeklyTarget=0 still yields listen 5/5 via paid fallback (no speak invent)", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = paidHttp({
      status: {
        type: "train",
        taskId: "42",
        ansVersion: 1,
        currentLevel: "S15",
      },
      report: {
        weeklyCompleted: 5,
        weeklyTarget: 0,
        weeklyProgress: "5/0",
      },
      activation: {
        listenTrialUsed: null,
        speakTrialUsed: null,
        trialUsageLimit: null,
      },
    });
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      env: {},
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 5);
    assert.equal(result.listen_total, 5);
    assert.equal(result.speak_done, null);
    assert.equal(result.speak_total, null);
  });

  test("trial activation fields still work via legacy weekProgressUrl override", async () => {
    const jwt = makeJwt({ openId: "oid", exp: 4_000_000_000 });
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        value: {
          listenTrialUsed: 2,
          speakTrialUsed: 1,
          trialUsageLimit: 3,
        },
      }),
    }));
    const result = await listWeekProgress({
      credentials: { getJwt: async () => jwt },
      http,
      weekProgressUrl:
        "https://uadaptive.unipus.cn/api/uls/user/activation/status",
    });
    assert.equal(result.isError, false);
    assert.equal(result.listen_done, 2);
    assert.equal(result.listen_total, 3);
    assert.equal(result.speak_done, 1);
    assert.equal(result.speak_total, 3);
    assert.match(result.message, /本周试用/);
  });
});
