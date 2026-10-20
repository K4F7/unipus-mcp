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

const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 12 === 11 ? "music." : "music")).join(" ");

test("generateFreeTalk asks for 210-240 words and >=90s (#96)", async () => {
  const prompts: string[] = [];
  const out = await generateFreeTalk("Talk about music", { ask: async (p) => { prompts.push(p); return `"${words(225)}"`; } });
  assert.equal(out, words(225));
  assert.match(prompts[0]!, /210-240 words/);
  assert.match(prompts[0]!, /90 seconds/);
});

test("generateFreeTalk strips LLM lead-ins, titles, markdown and word-count notes (#92)", async () => {
  const body = words(215);
  for (const raw of [
    `Sure, here's your spoken response:\n\n${body}`,
    `Sure! Here is a natural spoken answer of about 215 words.\n\n**My Favourite Music**\n\n${body}\n\n(215 words)`,
    `# Talking About Music\n"${body}"\nWord count: 215`,
    `Sure, here's your spoken response. ${body}`,
    `Certainly! ${body}`,
  ]) {
    const out = await generateFreeTalk("Talk about music", { ask: async () => raw });
    assert.equal(out, body, raw.slice(0, 40));
  }
});

test("generateFreeTalk: 205-250 words accepted; 204 or 251 regenerated before any TTS (#96)", async () => {
  for (const ok of [205, 250]) {
    assert.equal(await generateFreeTalk("Talk about music", { ask: async () => words(ok) }), words(ok));
  }
  const replies = [words(204), words(251), words(207)];
  let n = 0;
  assert.equal(await generateFreeTalk("Talk about music", { ask: async () => replies[n++]! }), words(207));
  assert.equal(n, 3);
});

test("generateFreeTalk: too short / too long replies are regenerated, then refused (#92)", async () => {
  const replies = [words(140), words(300), words(212)];
  let n = 0;
  assert.equal(await generateFreeTalk("Talk about music", { ask: async () => replies[n++]! }), words(212));
  assert.equal(n, 3);
  await assert.rejects(
    generateFreeTalk("Talk about music", { ask: async () => words(140) }),
    (e: unknown) => e instanceof AnswerRefusedError && /140/.test((e as Error).message),
  );
});

test("generateFreeTalk: a reply that is still meta talk after cleaning is refused, never voiced", async () => {
  const meta = `Here is a spoken response you can use. ${words(210)} As an AI language model, I hope this helps.`;
  await assert.rejects(generateFreeTalk("Talk about music", { ask: async () => meta }), AnswerRefusedError);
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

test("generateDialogReply strips a lead-in too", async () => {
  const reply = "I really like pop music because the songs are catchy and they help me relax after a long day of classes.";
  assert.equal(await generateDialogReply("Talk about music", "What music?", 0, { ask: async () => `Sure, here's my reply: "${reply}"` }), reply);
});

test("generateDialogReply returns the LLM reply", async () => {
  const reply = "I really like pop music because the songs are catchy and they help me relax after a long day of classes.";
  assert.equal(await generateDialogReply("Talk about music", "What music?", 0, { ask: async () => reply }), reply);
});

test("cleanSpoken keeps a real first sentence that merely starts with 'Here is'", () => {
  const s = "Here is what happened when I got sick last winter. I had a high fever.";
  assert.equal(speakContent.cleanSpoken(s), s);
});

test("cleanSpoken keeps the answer that follows an inline title/label (review #93)", async () => {
  const { cleanSpoken } = await import("../src/speak-content.js");
  assert.equal(cleanSpoken("**My answer:** First, I love jazz. It relaxes me."), "First, I love jazz. It relaxes me.");
  assert.equal(cleanSpoken("Title: Music I Like. First, I love jazz."), "First, I love jazz.");
  assert.equal(cleanSpoken("**Music I Like**\nFirst, I love jazz."), "First, I love jazz.");
});

test("shortenFreeTalk asks for a shorter rewrite inside 210-240 words (#108)", async () => {
  const prompts: string[] = [];
  const out = await speakContent.shortenFreeTalk("Talk about music", words(238), 215, {
    ask: async (p) => { prompts.push(p); return prompts.length === 1 ? words(236) : words(214); },
  });
  assert.equal(out, words(214));
  assert.equal(prompts.length, 2); // 236 > target → rejected and re-asked
  assert.match(prompts[0]!, /215 words/);
  assert.match(prompts[0]!, /Talk about music/);
  assert.match(prompts[0]!, /music music/);
});

test("shortenFreeTalk never goes under 210 words", async () => {
  const prompts: string[] = [];
  await speakContent.shortenFreeTalk("t", words(212), 150, { ask: async (p) => { prompts.push(p); return words(210); } });
  assert.match(prompts[0]!, /210 words/);
});
