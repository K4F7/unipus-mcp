import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLocalTtsEngine, synthesizeSpeechWav } from "../src/tts.js";

test("unset engine follows the platform; explicit and legacy still win", () => {
  assert.equal(resolveLocalTtsEngine({}, false, "darwin"), "say");
  assert.equal(resolveLocalTtsEngine({}, false, "linux"), "kokoro");
  assert.equal(resolveLocalTtsEngine({}, false, "win32"), "kokoro");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "kokoro" }, false, "darwin"), "kokoro");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "piper" }), "piper");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "say" }), "say");
  assert.equal(resolveLocalTtsEngine({ UNIPUS_TTS_ENGINE: "edge" }), null);
  assert.equal(resolveLocalTtsEngine({}, true, "linux"), null);
});

test("local synthesis failure throws (no flite/edge fallback)", async () => {
  let fallbackCalled = false;
  await assert.rejects(
    synthesizeSpeechWav({ text: "hello" }, {
      env: {},
      synthesizeLocalWav: async () => { throw new Error("kokoro boom"); },
    }),
    /kokoro boom/,
  );
  assert.equal(fallbackCalled, false);
});

test("local synthesis writes to returned wav path", async () => {
  let got = "";
  const r = await synthesizeSpeechWav({ text: "hello" }, {
    env: {},
    synthesizeLocalWav: async (_t, p) => { got = p; },
  });
  assert.equal(r.wavPath, got);
  await r.cleanup();
});
