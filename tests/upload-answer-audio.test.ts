import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import {
  parseQueryUploadBody,
  uploadAnswerAudio,
} from "../src/upload-answer-audio.js";

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = [];
  return {
    calls,
    async request(input) {
      const call = {
        url: input.url,
        method: input.method ?? "GET",
        headers: input.headers ?? {},
        body: input.body,
      };
      calls.push({ url: call.url, body: call.body });
      return handler(call);
    },
  };
}

describe("parseQueryUploadBody", () => {
  test("parses success envelope with token/path/url", () => {
    const parsed = parseQueryUploadBody(
      JSON.stringify({
        code: 1,
        value: {
          token: "tok",
          path: "ans-prod/a.wav",
          url: "https://birdflock.unipus.cn/ans-prod/a.wav",
        },
      }),
    );
    assert.deepEqual(parsed, {
      token: "tok",
      path: "ans-prod/a.wav",
      url: "https://birdflock.unipus.cn/ans-prod/a.wav",
    });
  });

  test("rejects business failure", () => {
    assert.equal(
      parseQueryUploadBody(JSON.stringify({ code: 500, msg: "x" })),
      null,
    );
  });
});

describe("uploadAnswerAudio", () => {
  test("missing JWT is auth_required without HTTP", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    const result = await uploadAnswerAudio(
      { credentials: { getJwt: async () => null }, http },
      { filePath: "/tmp/x.wav" },
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "auth_required");
    assert.deepEqual(http.calls, []);
  });

  test("query + qiniu upload happy path", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        value: {
          token: "tok",
          path: "ans-prod/t.wav",
          url: "https://birdflock.unipus.cn/ans-prod/t.wav",
        },
      }),
    }));

    let uploaded = false;
    const result = await uploadAnswerAudio(
      {
        credentials: { getJwt: async () => "hdr.pay.sig" },
        http,
        readFile: async () => Buffer.from("RIFF"),
        uploadFetch: async () => {
          uploaded = true;
          return new Response(JSON.stringify({ hash: "h1" }), { status: 200 });
        },
      },
      { filePath: "/tmp/t.wav" },
    );

    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.storage_key, "ans-prod/t.wav");
    assert.equal(result.cdn_url, "https://birdflock.unipus.cn/ans-prod/t.wav");
    assert.equal(result.upload_hash, "h1");
    assert.equal(uploaded, true);
    assert.equal(http.calls.length, 1);
    assert.match(http.calls[0]!.body ?? "", /fileName/);
  });
});
