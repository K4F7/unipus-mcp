import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createUnipusMcpServer } from "../src/server.js";
import type { UnipusHttp } from "../src/http.js";

const EXPECTED_TOOLS = [
  "auth_status",
  "list_week_progress",
  "start_listening_training",
] as const;

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("unipus MCP server", () => {
  test("lists tools; stubs and missing JWT keep stable JSON errors", async () => {
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
      assert.equal(progressPayload.status, "not_implemented");
      assert.equal(progressPayload.code, "NOT_IMPLEMENTED");
      assert.match(String(progressPayload.message), /未实现/);

      const train = await client.callTool({
        name: "start_listening_training",
        arguments: {},
      });
      assert.equal("isError" in train && train.isError, true);
      const trainPayload = structuredPayload(train);
      assert.equal(trainPayload.status, "not_implemented");
      assert.equal(trainPayload.code, "NOT_IMPLEMENTED");
      assert.match(String(trainPayload.message), /未实现/);
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
});

function structuredPayload(result: unknown): {
  status: string;
  code: string;
  message: string;
  isError: boolean;
  authenticated?: boolean;
  userId?: string | null;
  expired?: boolean | null;
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
  };
}
