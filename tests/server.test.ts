import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveLoadPaperUrl, resolveWeekProgressUrl } from "../src/config.js";
import { createUnipusMcpServer } from "../src/server.js";
import type { UnipusHttp } from "../src/http.js";

const EXPECTED_TOOLS = [
  "auth_status",
  "list_week_progress",
  "start_listening_training",
  "upload_answer_audio",
  "submit_answer",
] as const;

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("unipus MCP server", () => {
  test("lists tools; missing JWT keeps stable JSON errors", async () => {
    const server = createUnipusMcpServer({
      credentials: { getJwt: async () => null },
      http: {
        async request() {
          throw new Error("http must not run without jwt");
        },
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...EXPECTED_TOOLS].sort());

      for (const name of EXPECTED_TOOLS) {
        const tool = listed.tools.find((t) => t.name === name);
        assert.ok(tool, `missing tool ${name}`);
        const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
        const props = schema?.properties ?? {};
        assert.equal(
          "password" in props || "passwd" in props || "cookie" in props || "jwt" in props,
          false,
          `${name} must not accept password/cookie/jwt params`,
        );
      }

      const auth = await client.callTool({ name: "auth_status", arguments: {} });
      assert.equal("isError" in auth && auth.isError, true);
      const authPayload = structuredPayload(auth);
      assert.equal(authPayload.status, "auth_required");
      assert.equal(authPayload.code, "AUTH_REQUIRED");
      assert.equal(authPayload.isError, true);
      assert.match(String(authPayload.message), /需登录|登录/);

      const progress = await client.callTool({ name: "list_week_progress", arguments: {} });
      assert.equal("isError" in progress && progress.isError, true);
      const progressPayload = structuredPayload(progress);
      assert.equal(progressPayload.status, "auth_required");
      assert.equal(progressPayload.code, "AUTH_REQUIRED");
      assert.match(String(progressPayload.message), /需登录|登录|JWT/);

      const train = await client.callTool({
        name: "start_listening_training",
        arguments: { taskId: "t1" },
      });
      assert.equal("isError" in train && train.isError, true);
      const trainPayload = structuredPayload(train);
      assert.equal(trainPayload.status, "auth_required");
      assert.equal(trainPayload.code, "AUTH_REQUIRED");
      assert.match(String(trainPayload.message), /需登录|登录|JWT/);

      const upload = await client.callTool({
        name: "upload_answer_audio",
        arguments: { filePath: "/tmp/x.wav" },
      });
      assert.equal("isError" in upload && upload.isError, true);
      const uploadPayload = structuredPayload(upload);
      assert.equal(uploadPayload.status, "auth_required");
      assert.equal(uploadPayload.code, "AUTH_REQUIRED");
      assert.match(String(uploadPayload.message), /需登录|登录|JWT/);

      const uploadTool = listed.tools.find((tool) => tool.name === "upload_answer_audio");
      assert.ok(uploadTool);
      const uploadProps =
        ((uploadTool.inputSchema as { properties?: Record<string, unknown> } | undefined)
          ?.properties ?? {});
      assert.ok("filePath" in uploadProps);
      assert.equal(
        "password" in uploadProps ||
          "passwd" in uploadProps ||
          "cookie" in uploadProps ||
          "jwt" in uploadProps,
        false,
      );


      const submit = await client.callTool({
        name: "submit_answer",
        arguments: {
          taskId: "t1",
          paperToken: "tok",
          instanceId: "1",
          answer: "https://example.com/a.wav",
        },
      });
      assert.equal("isError" in submit && submit.isError, true);
      const submitPayload = structuredPayload(submit);
      assert.equal(submitPayload.status, "auth_required");
      assert.equal(submitPayload.code, "AUTH_REQUIRED");

      const trainingTool = listed.tools.find(
        (tool) => tool.name === "start_listening_training",
      );
      assert.ok(trainingTool);
      const trainingProps = (
        (trainingTool.inputSchema as { properties?: Record<string, unknown> } | undefined)
          ?.properties ?? {}
      );
      assert.ok("taskId" in trainingProps);
      assert.equal(
        "password" in trainingProps ||
          "passwd" in trainingProps ||
          "cookie" in trainingProps ||
          "jwt" in trainingProps,
        false,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("start_listening_training loads a paper through the MCP server", async () => {
    const jwt = "raw-jwt-value";
    const calls: Array<{
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }> = [];
    const server = createUnipusMcpServer({
      credentials: { getJwt: async () => jwt },
      http: {
        async request(input) {
          calls.push(input);
          return {
            statusCode: 200,
            body: JSON.stringify({ code: 0, data: { taskId: "abc", token: "tok" } }),
          };
        },
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const train = await client.callTool({
        name: "start_listening_training",
        arguments: { taskId: "abc", ansVersion: 2 },
      });
      assert.equal("isError" in train && train.isError, false);
      const payload = structuredPayload(train);
      assert.equal(payload.status, "ok");
      assert.equal(payload.code, "OK");
      assert.equal(payload.task_id, "abc");
      assert.equal(payload.paper_token, "tok");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, resolveLoadPaperUrl({}));
      assert.equal(calls[0]?.method, "POST");
      assert.equal(calls[0]?.headers?.authorization, jwt);
      assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
        taskId: "abc",
        ansVersion: 2,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("auth_status ok when JWT present and probe accepts", async () => {
    const jwt = makeJwt({ openId: "oid-ok", exp: 4_000_000_000 });
    const http: UnipusHttp = {
      async request() {
        return { statusCode: 404, body: '{"message":"Route Not Found"}' };
      },
    };
    const server = createUnipusMcpServer({
      credentials: { getJwt: async () => jwt },
      http,
      now: () => new Date(1_700_000_000_000),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const auth = await client.callTool({ name: "auth_status", arguments: {} });
      assert.equal("isError" in auth && auth.isError, false);
      const payload = structuredPayload(auth);
      assert.equal(payload.status, "ok");
      assert.equal(payload.code, "OK");
      assert.equal(payload.authenticated, true);
      assert.equal(payload.userId, "oid-ok");
      assert.equal(payload.expired, false);
      assert.doesNotMatch(JSON.stringify(payload), /eyJhbGci/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("list_week_progress returns structured fields when JWT ok", async () => {
    const jwt = makeJwt({ openId: "oid-ok", exp: 4_000_000_000 });
    const calls: string[] = [];
    const http: UnipusHttp = {
      async request(input) {
        calls.push(input.url);
        return {
          statusCode: 200,
          body: JSON.stringify({
            progress_done: 1,
            progress_total: 5,
            level: "S15",
          }),
        };
      },
    };
    const server = createUnipusMcpServer({
      credentials: { getJwt: async () => jwt },
      http,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const progress = await client.callTool({ name: "list_week_progress", arguments: {} });
      assert.equal("isError" in progress && progress.isError, false);
      const payload = structuredPayload(progress);
      assert.equal(payload.status, "ok");
      assert.equal(payload.code, "OK");
      assert.equal(payload.progress_done, 1);
      assert.equal(payload.progress_total, 5);
      assert.equal(payload.listen_done, 1);
      assert.equal(payload.listen_total, 5);
      assert.equal(payload.speak_done, null);
      assert.equal(payload.speak_total, null);
      assert.equal(payload.level, "S15");
      assert.deepEqual(calls, [resolveWeekProgressUrl({})]);
      assert.doesNotMatch(JSON.stringify(payload), /eyJhbGci/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function structuredPayload(result: unknown): {
  status: string;
  code: string;
  message: string;
  isError: boolean;
  authenticated?: boolean;
  userId?: string | null;
  expired?: boolean | null;
  progress_done?: number;
  progress_total?: number;
  level?: string | null;
  listen_done?: number | null;
  listen_total?: number | null;
  speak_done?: number | null;
  speak_total?: number | null;
  task_id?: string;
  paper_token?: string | null;
} {
  assert.ok(result !== null && typeof result === "object");
  const record = result as Record<string, unknown>;

  if (
    record.structuredContent !== null &&
    typeof record.structuredContent === "object" &&
    record.structuredContent !== undefined &&
    "status" in record.structuredContent
  ) {
    return record.structuredContent as {
      status: string;
      code: string;
      message: string;
      isError: boolean;
      authenticated?: boolean;
      userId?: string | null;
      expired?: boolean | null;
      progress_done?: number;
      progress_total?: number;
      level?: string | null;
      listen_done?: number | null;
      listen_total?: number | null;
      speak_done?: number | null;
      speak_total?: number | null;
      task_id?: string;
      paper_token?: string | null;
    };
  }

  assert.ok(Array.isArray(record.content) && record.content.length > 0);
  const first = record.content[0];
  assert.ok(first !== null && typeof first === "object");
  const item = first as { type?: unknown; text?: unknown };
  assert.equal(item.type, "text");
  assert.equal(typeof item.text, "string");
  return JSON.parse(item.text as string) as {
    status: string;
    code: string;
    message: string;
    isError: boolean;
    authenticated?: boolean;
    userId?: string | null;
    expired?: boolean | null;
    progress_done?: number;
    progress_total?: number;
    level?: string | null;
    listen_done?: number | null;
    listen_total?: number | null;
    speak_done?: number | null;
    speak_total?: number | null;
    task_id?: string;
    paper_token?: string | null;
  };
}
