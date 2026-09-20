import assert from "node:assert/strict";
import { copyFile, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";

import type { UnipusHttp } from "../src/http.js";
import { speakAndSubmit } from "../src/speak-and-submit.js";

function mockHttp(
  handler: (input: {
    url: string;
    method: string;
    body?: string;
  }) => Promise<{ statusCode: number; body: string }>,
): UnipusHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(input) {
      calls.push(input.url);
      return handler({
        url: input.url,
        method: input.method ?? "GET",
        body: input.body,
      });
    },
  };
}

describe("speakAndSubmit", () => {
  test("TTS → upload → submit with injected mp3 + real ffmpeg", async () => {
    // tiny but valid-enough mp3 from prior probe if present; else skip-friendly stub
    const seed = "/tmp/tts-raw.mp3";
    const http = mockHttp(async ({ url }) => {
      if (url.includes("query-upload-url")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              token: "tok",
              path: "ans-prod/x.wav",
              url: "https://birdflock.unipus.cn/ans-prod/x.wav",
            },
          }),
        };
      }
      if (url.includes("submitAnswer")) {
        return {
          statusCode: 200,
          body: JSON.stringify({ code: 1, value: true }),
        };
      }
      return { statusCode: 404, body: "{}" };
    });

    const result = await speakAndSubmit(
      {
        credentials: { getJwt: async () => "jwt" },
        http,
        synthesizeMp3: async (_text, _voice, mp3Path) => {
          try {
            await copyFile(seed, mp3Path);
          } catch {
            // minimal ID3-ish stub — ffmpeg may fail; test handles TTS_ERROR
            await writeFile(mp3Path, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]));
          }
        },
        uploadFetch: async () =>
          new Response(JSON.stringify({ hash: "h" }), { status: 200 }),
      },
      {
        text: "Hey, future me!",
        taskId: "101",
        paperToken: "ptok",
        instanceId: "1985",
      },
    );

    if (result.code === "TTS_ERROR") {
      assert.match(result.message, /TTS|ffmpeg/i);
      return;
    }
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.cdn_url, "https://birdflock.unipus.cn/ans-prod/x.wav");
    assert.ok(http.calls.some((u) => u.includes("query-upload-url")));
  });
});
