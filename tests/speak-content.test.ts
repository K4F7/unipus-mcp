import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDialogReply, generateFreeTalk, leafTaskText, templateFreeTalk } from "../src/speak-content.js";

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

test("generateFreeTalk uses LLM output when long enough", async () => {
  const words = Array.from({ length: 120 }, () => "music").join(" ");
  const out = await generateFreeTalk("Talk about music", { ask: async () => `"${words}"` });
  assert.equal(out, words);
});

test("generateFreeTalk falls back to on-topic template without LLM", async () => {
  const out = await generateFreeTalk("Talk in 60 seconds about the type of music you like.", { ask: null });
  assert.match(out, /the type of music you like/);
  assert.equal(out, templateFreeTalk("Talk in 60 seconds about the type of music you like."));
});

test("configured answer source failure aborts instead of silently submitting a template", async () => {
  let n = 0;
  await assert.rejects(
    generateDialogReply("Talk about music", "What music?", 0, {
      ask: async () => { n++; return "ok"; },
    }),
    /SPEAK_CONTENT_FAILED/,
  );
  assert.equal(n, 3);
  await assert.rejects(
    generateFreeTalk("Talk about music", { ask: async () => { throw new Error("HTTP 503"); } }),
    /HTTP 503/,
  );
});
