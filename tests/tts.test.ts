import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, test } from "node:test";

import { resetEdgeTtsBreaker, synthesizeSpeechWav } from "../src/tts.js";

const noSleep = async () => {};

describe("synthesizeSpeechWav fallback", () => {
  beforeEach(() => resetEdgeTtsBreaker());

  test("Edge 403 → one retry → flite fallback; breaker skips Edge next time", async () => {
    let edgeCalls = 0;
    let fliteCalls = 0;
    const ports = {
      env: {},
      sleep: noSleep,
      synthesizeMp3: async () => {
        edgeCalls += 1;
        throw new Error("Unexpected server response: 403");
      },
      synthesizeFallbackWav: async (_t: string, out: string) => {
        fliteCalls += 1;
        await writeFile(out, "wav");
      },
    };
    const a = await synthesizeSpeechWav({ text: "hello" }, ports);
    await a.cleanup();
    assert.equal(edgeCalls, 2);
    assert.equal(fliteCalls, 1);
    const b = await synthesizeSpeechWav({ text: "again" }, ports);
    await b.cleanup();
    assert.equal(edgeCalls, 2, "breaker open: Edge not called again");
    assert.equal(fliteCalls, 2);
  });

  test("bare-string 'Timed out' rejections are retried then surfaced when engine=edge", async () => {
    let edgeCalls = 0;
    await assert.rejects(
      synthesizeSpeechWav(
        { text: "hello" },
        {
          env: { UNIPUS_TTS_ENGINE: "edge" },
          sleep: noSleep,
          synthesizeMp3: async () => {
            edgeCalls += 1;
            throw "Timed out";
          },
        },
      ),
      /Timed out/,
    );
    assert.equal(edgeCalls, 3);
  });

  test("engine=flite never touches Edge", async () => {
    const r = await synthesizeSpeechWav(
      { text: "hi" },
      {
        env: { UNIPUS_TTS_ENGINE: "flite" },
        synthesizeMp3: async () => assert.fail("edge called"),
        synthesizeFallbackWav: async (_t, out) => writeFile(out, "wav"),
      },
    );
    await r.cleanup();
  });
});
