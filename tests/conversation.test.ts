import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  DEFAULT_ULS_CONVERSATION_CREATE_PATH,
  DEFAULT_ULS_CONVERSATION_SAVE_PATH,
  DEFAULT_ULS_CONVERSATION_STOP_PATH,
  resolveConversationCreateUrl,
  resolveConversationSaveUrl,
  resolveConversationStopUrl,
  resolveEbcpAuthUrl,
  resolveEbcpSpeakersUrl,
  resolveConversationChatInfoUrl,
  resolveConversationMaxCountUrl,
} from "../src/config.js";
import {
  conversationCreate,
  conversationSave,
  conversationStop,
  conversationChatInfo,
  conversationMaxCount,
  isConversationSuccessCode,
  parseConversationDataBody,
} from "../src/conversation.js";
import { ebcpAuth, ebcpSpeakers } from "../src/ebcp.js";

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & {
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  return {
    calls,
    async request(input) {
      const call = {
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        body: input.body,
      };
      calls.push(call);
      return handler(call);
    },
  };
}

describe("conversation URL resolvers", () => {
  test("default to ucloud conversation/* and ebcp/* (never oral/train)", () => {
    assert.equal(
      resolveConversationCreateUrl({}),
      `https://ucloud.unipus.cn${DEFAULT_ULS_CONVERSATION_CREATE_PATH}`,
    );
    assert.equal(
      resolveConversationSaveUrl({}),
      `https://ucloud.unipus.cn${DEFAULT_ULS_CONVERSATION_SAVE_PATH}`,
    );
    assert.equal(
      resolveConversationStopUrl({}),
      `https://ucloud.unipus.cn${DEFAULT_ULS_CONVERSATION_STOP_PATH}`,
    );
    assert.match(resolveEbcpAuthUrl({}), /\/api\/uls\/ebcp\/auth$/);
    assert.match(resolveEbcpSpeakersUrl({}), /\/api\/uls\/ebcp\/speakers$/);
    assert.match(
      resolveConversationChatInfoUrl({}, "cid-1"),
      /\/api\/uls\/conversation\/chat\/info\?conversationId=cid-1$/,
    );
    assert.match(
      resolveConversationMaxCountUrl({}),
      /\/api\/uls\/conversation\/max-count$/,
    );
    for (const url of [
      resolveConversationCreateUrl({}),
      resolveConversationSaveUrl({}),
      resolveConversationStopUrl({}),
      resolveEbcpAuthUrl({}),
      resolveEbcpSpeakersUrl({}),
      resolveConversationChatInfoUrl({}, "x"),
      resolveConversationMaxCountUrl({}),
    ]) {
      assert.doesNotMatch(url, /oral\/train/);
    }
  });
});

describe("isConversationSuccessCode / parseConversationDataBody", () => {
  test("only business code=200 is success (not code=1)", () => {
    assert.equal(isConversationSuccessCode(200), true);
    assert.equal(isConversationSuccessCode("200"), true);
    assert.equal(isConversationSuccessCode(1), false);
    assert.equal(isConversationSuccessCode(0), false);
    assert.equal(isConversationSuccessCode(500), false);
  });

  test("parse accepts code=200 data object", () => {
    const parsed = parseConversationDataBody(
      JSON.stringify({
        code: 200,
        data: { conversationId: "1984905701219868673", sceneId: "s1", token: "tok", level: 1 },
      }),
    );
    assert.ok(parsed != null);
    assert.equal(parsed.raw_code, 200);
    assert.equal(
      (parsed.data as Record<string, unknown>).conversationId,
      "1984905701219868673",
    );
  });

  test("parse rejects code=1 (uls user success, wrong for conversation)", () => {
    assert.equal(
      parseConversationDataBody(JSON.stringify({ code: 1, data: { conversationId: "x" } })),
      null,
    );
  });
});

describe("conversationCreate", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await conversationCreate(
      { credentials: { getJwt: async () => null }, http },
      {
        taskId: "t1",
        questionId: "q1",
        title: "AI dialog",
        role: "student",
      },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.deepEqual(http.calls, []);
  });

  test("POSTs create with cloud headers and treats code=200 as success", async () => {
    const jwt = "jwt-raw";
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 200,
        data: {
          conversationId: "1984905701219868673",
          sceneId: "scene-1",
          token: "conv-tok",
          level: 2,
        },
      }),
    }));
    const result = await conversationCreate(
      { credentials: { getJwt: async () => jwt }, http },
      {
        taskId: "task-1",
        questionId: "1984905701219868673",
        title: "Unit 1",
        role: "buddy",
        ansVersion: 1,
      },
    );
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.code, "OK");
    assert.equal(result.conversation_id, "1984905701219868673");
    assert.equal(result.scene_id, "scene-1");
    assert.equal(result.token, "conv-tok");
    assert.equal(result.level, 2);
    assert.equal(result.raw_code, 200);
    assert.equal(http.calls.length, 1);
    const call = http.calls[0]!;
    assert.equal(call.url, resolveConversationCreateUrl({}));
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, jwt);
    assert.doesNotMatch(call.headers.authorization ?? "", /^Bearer /);
    assert.equal(call.headers.sourceid, "116");
    assert.equal(call.headers["x-requested-with"], "cn.unipus.cloud");
    assert.doesNotMatch(call.url, /oral\/train/);
    const body = JSON.parse(call.body ?? "{}");
    assert.equal(body.taskId, "task-1");
    assert.equal(body.questionId, "1984905701219868673");
    assert.equal(body.sourceId, 116);
    assert.equal(body.ansVersion, 1);
    assert.equal(body.title, "Unit 1");
    assert.equal(body.role, "buddy");
  });

  test("business code=1 is BUSINESS_ERROR for conversation", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, data: { conversationId: "x" }, msg: "wrong family" }),
    }));
    const result = await conversationCreate(
      { credentials: { getJwt: async () => "jwt" }, http },
      { taskId: "t", questionId: "q", title: "t", role: "r" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "BUSINESS_ERROR");
  });
});

describe("conversationSave / conversationStop", () => {
  test("save POSTs speakAddTaskRecord and accepts code=200", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: { id: "rec-1" } }),
    }));
    const result = await conversationSave(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        speakTaskId: "st-1",
        duration: 12,
        speakAddTaskRecord: {
          aiType: 1,
          botEnContent: "Hello",
          userEnContent: "Hi",
          sort: 1,
          speakType: 1,
        },
      },
    );
    assert.equal(result.isError, false);
    assert.equal(result.raw_code, 200);
    assert.equal(result.record_id, "rec-1");
    const body = JSON.parse(http.calls[0]?.body ?? "{}");
    assert.equal(body.speakTaskId, "st-1");
    assert.equal(body.duration, 12);
    assert.equal(body.speakAddTaskRecord.botEnContent, "Hello");
    assert.equal(http.calls[0]?.headers.sourceid, "116");
    assert.doesNotMatch(http.calls[0]?.url ?? "", /oral\/train/);
  });

  test("stop POSTs evaluation fields and accepts code=200", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: {} }),
    }));
    const result = await conversationStop(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        speakTaskId: "st-1",
        evaluation: 5,
        evaluationContent: "good",
        voiceToneId: "vt-1",
      },
    );
    assert.equal(result.isError, false);
    assert.equal(result.raw_code, 200);
    const body = JSON.parse(http.calls[0]?.body ?? "{}");
    assert.deepEqual(body, {
      speakTaskId: "st-1",
      evaluation: 5,
      evaluationContent: "good",
      voiceToneId: "vt-1",
    });
  });
});

describe("conversation helpers (info / max-count / ebcp)", () => {
  test("chat info GET with conversationId", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 200,
        data: { record: { role: "bot" }, duration: 3 },
      }),
    }));
    const result = await conversationChatInfo(
      { credentials: { getJwt: async () => "jwt" }, http },
      { conversationId: "cid" },
    );
    assert.equal(result.isError, false);
    assert.equal(http.calls[0]?.method, "GET");
    assert.match(http.calls[0]?.url ?? "", /conversationId=cid/);
  });

  test("max-count GET", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: 10 }),
    }));
    const result = await conversationMaxCount(
      { credentials: { getJwt: async () => "jwt" }, http },
      {},
    );
    assert.equal(result.isError, false);
    assert.equal(result.max_count, 10);
  });

  test("ebcp auth/speakers POST with scene + bizExt", async () => {
    const http = mockHttp(async (call) => {
      if (call.url.includes("/ebcp/auth")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 200,
            data: { pAppId: "p", pCipTxt: "c", sourceId: 116 },
          }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          code: 200,
          data: { speakers: [{ id: 1 }], speakVoiceTones: [] },
        }),
      };
    });
    const auth = await ebcpAuth(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        scene: "ai-dialog",
        bizExt: { questionId: "q", taskId: "t", ansVersion: 1, sourceId: 116 },
      },
    );
    assert.equal(auth.isError, false);
    const speakers = await ebcpSpeakers(
      { credentials: { getJwt: async () => "jwt" }, http },
      { scene: "ai-dialog", bizExt: { taskId: "t" } },
    );
    assert.equal(speakers.isError, false);
    assert.ok(Array.isArray(speakers.speakers));
    assert.equal(http.calls.length, 2);
    assert.equal(http.calls[0]?.headers["x-requested-with"], "cn.unipus.cloud");
  });
});

describe("speakTaskId / conversationId alias + ID safety", () => {
  test("save accepts conversationId alias for speakTaskId", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: { id: "rec-2" } }),
    }));
    const result = await conversationSave(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        conversationId: "cid-alias",
        duration: 1,
        speakAddTaskRecord: { sort: 1 },
      },
    );
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(http.calls[0]?.body ?? "{}").speakTaskId, "cid-alias");
  });

  test("unsafe number questionId is INVALID_ARGUMENT (no String(number))", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await conversationCreate(
      { credentials: { getJwt: async () => "jwt" }, http },
      {
        taskId: "t1",
        // Unsafe integer loses precision if String()'d — must reject.
        questionId: Number.MAX_SAFE_INTEGER + 2,
        title: "t",
        role: "r",
      } as unknown as {
        taskId: string;
        questionId: string;
        title: string;
        role: string;
      },
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "INVALID_ARGUMENT");
    assert.deepEqual(http.calls, []);
  });
});

describe("ebcpSpeakers shares validation with ebcpAuth", () => {
  test("empty scene is INVALID_ARGUMENT for speakers", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await ebcpSpeakers(
      { credentials: { getJwt: async () => "jwt" }, http },
      { scene: "   ", bizExt: { taskId: "t" } },
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "INVALID_ARGUMENT");
    assert.deepEqual(http.calls, []);
  });
});
