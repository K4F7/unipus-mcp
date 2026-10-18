import assert from "node:assert/strict";
import { test } from "node:test";
import * as speakContent from "../src/speak-content.js";
import { AnswerRefusedError } from "../src/choice-solver.js";

const { generateDialogReply, generateFreeTalk, leafTaskText } = speakContent;

const leaf = {
  instanceId: "1",
  data: { contents: [{ text: "<p>It's your show time! Talk in 60 seconds about the type of music you like.</p><ul><li>what type;</li><li>why.</li></ul>" }] },
} as never;

test("leafTaskText strips html and keeps bullets", () => {
  const t = leafTaskText(leaf);
  assert.match(t, /type of music you like/);
  assert.match(t, /what type;/);
  assert.doesNotMatch(t, /</);
});

test("no template script is exported", () => {
  assert.equal("templateFreeTalk" in speakContent, false);
});

test("generateFreeTalk uses LLM output when long enough", async () => {
  const words = Array.from({ length: 120 }, () => "music").join(" ");
  const out = await generateFreeTalk("Talk about music", { ask: async () => `"${words}"` });
  assert.equal(out, words);
});

test("generateFreeTalk without LLM config → AnswerRefusedError, no template", async () => {
  await assert.rejects(generateFreeTalk("Talk about music", { env: {} }), AnswerRefusedError);
});

test("generateFreeTalk: LLM keeps failing / too short → AnswerRefusedError after 3 tries", async () => {
  let n = 0;
  await assert.rejects(
    generateFreeTalk("Talk about music", { ask: async () => { n++; throw new Error("HTTP 502"); } }),
    (e: unknown) => e instanceof AnswerRefusedError && /HTTP 502/.test((e as Error).message),
  );
  assert.equal(n, 3);
  await assert.rejects(generateFreeTalk("Talk about music", { ask: async () => "too short" }), AnswerRefusedError);
});

test("generateDialogReply: short LLM answers retried then AnswerRefusedError (no canned line)", async () => {
  let n = 0;
  await assert.rejects(
    generateDialogReply("Talk about music", "What music?", 0, { ask: async () => { n++; return "ok"; } }),
    AnswerRefusedError,
  );
  assert.equal(n, 3);
});

test("generateDialogReply returns the LLM reply", async () => {
  const reply = "I really like pop music because the songs are catchy and they help me relax after a long day of classes.";
  assert.equal(await generateDialogReply("Talk about music", "What music?", 0, { ask: async () => reply }), reply);
});
