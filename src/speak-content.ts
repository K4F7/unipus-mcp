/**
 * Topic-relevant spoken content for 自由表达 / AI口语对话 (#63).
 * App history score for a speak paper follows the server's grading of the free
 * talk (open-speak: appropriateness/coherence/content vs the task points), so a
 * generic off-topic script caps the paper around 40–67. Uses the same
 * OpenAI-compatible LLM config as the listening solver. No template fallback:
 * no config or no usable LLM reply throws AnswerRefusedError and the caller must not submit.
 */
import { AnswerRefusedError, resolveLlmAsk, type LlmAsk } from "./choice-solver.js";
import { stripHtml, type GrindLeaf } from "./grind-paper.js";

export function leafTaskText(leaf: GrindLeaf): string {
  const contents = Array.isArray(leaf.data.contents) ? leaf.data.contents : [];
  const parts: string[] = [];
  for (const c of contents) {
    const t = (c as Record<string, unknown> | null)?.text;
    if (typeof t === "string") {
      // keep list items separated
      const s = stripHtml(t.replace(/<\/li>/g, "; ").replace(/<\/p>/g, " "));
      if (s) parts.push(s);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** A first line/sentence that only introduces the answer ("Sure, here's your spoken response:"). */
const LEAD_IN = new RegExp(
  String.raw`^(?:(?:sure|certainly|of course|absolutely|okay|ok|alright|great)\b[,!.]?\s*)?` +
    String.raw`(?:here(?:'s| is| are)\b[^.!?:\n]{0,100}\b(?:response|answer|speech|monologue|version|talk|text|script|reply|draft)\b[^.!?:\n]{0,60}(?:[.!?:]|\n|$)|here goes[.!:])\s*`,
  "i",
);
const BARE_LEAD_IN = /^(?:sure|certainly|of course|absolutely)\s*[!.,]\s+/i;
/** Meta lines: markdown headings, bold titles, "Title:", word-count notes. */
const META_LINE = /^(?:#{1,6}\s.*|\*\*[^*]{1,80}\*\*|(?:title|topic|spoken (?:response|answer))\s*[:：].{0,80}|\(?\s*(?:word count\s*[:：]?\s*)?(?:about |approximately |around )?\d{2,3}\s*words?\s*\)?\.?|word count\s*[:：]?\s*\d+.*)$/i;
/** An inline label in front of the real answer ("**My answer:** First, …", "Title: Music. First, …"): drop only the label. */
const INLINE_LABEL = /^(?:\*\*[^*\n]{1,40}?[:：]?\*\*\s*[:：]?|(?:title|topic)\s*[:：][^.!?\n]{1,60}[.!?])\s+(?=\S)/i;
/** Left-over assistant talk means the reply is not a clean spoken answer. */
const META_TALK = /\b(?:as an ai|language model|spoken response|word count|i hope this helps|feel free to)\b/i;

/** Strip LLM lead-ins / titles / markdown / quotes so only the words to speak remain (#92). */
export function cleanSpoken(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim().replace(INLINE_LABEL, ""))
    .filter((l) => l && !META_LINE.test(l));
  let s = lines.join(" ");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^["'“”‘’\s]+/, "").replace(LEAD_IN, "").replace(BARE_LEAD_IN, "");
  }
  return s
    .replace(/\(\s*\d{2,3}\s*words?\s*\)\s*$/i, "")
    .replace(/[*#_`>]/g, "")
    .replace(/["“”]/g, "")
    .replace(/^['‘’\s]+|['‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export type SpeakContentPorts = { env?: NodeJS.ProcessEnv; ask?: LlmAsk };

const ATTEMPTS = 3;

/** Ask until `check` accepts the cleaned reply (null = ok, else the reason); refuse after ATTEMPTS. */
async function askWithRetry(ports: SpeakContentPorts, prompt: string, check: (s: string) => string | null): Promise<string> {
  const ask = ports.ask ?? resolveLlmAsk(ports.env ?? process.env);
  let last = "no attempt";
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const out = cleanSpoken(await ask(prompt));
      const bad = META_TALK.test(out) ? "reply still contains assistant meta talk" : check(out);
      if (bad == null) return out;
      last = bad;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    console.error(`[speak-content] LLM 回答不合格（第 ${i + 1}/${ATTEMPTS} 次）：${last}`);
  }
  throw new AnswerRefusedError(`口语 LLM 作答失败（${ATTEMPTS} 次），拒绝用模板交卷：${last}`);
}

/**
 * Accepted free-talk length: the prompt asks 210-240 words; outside 205-250 the script is regenerated
 * before any TTS. ~205 words is what reaches 90 s at speed 0.85 with the max sentence pause (#96).
 */
export const FREE_TALK_WORDS = { min: 205, max: 250 } as const;

/** ≥90 s monologue (210–240 words) covering every bullet of the task (#92, #96). */
export async function generateFreeTalk(task: string, ports: SpeakContentPorts = {}): Promise<string> {
  return askWithRetry(
    ports,
    `You are a Chinese college student taking an English speaking test.\nTask: ${task}\n\n` +
      `Write what you would SAY: a natural first-person spoken answer of 210-240 words (it must take at least 90 seconds to say) ` +
      `that clearly covers EVERY point in the task, in order, with a short opening sentence, linking words ` +
      `(first, besides, for example, as a result, in short) and a short conclusion. ` +
      `Use short, simple, correct sentences of 8-18 words and common words that are easy to pronounce. ` +
      `Write numbers as words; no abbreviations, symbols, lists or parentheses. ` +
      `Output only the words to speak: no greeting to me, no "Sure" or "Here is", no title, no quotes, no word count.`,
    (s) => {
      const n = wordCount(s);
      return n < FREE_TALK_WORDS.min || n > FREE_TALK_WORDS.max
        ? `reply has ${n} words (need ${FREE_TALK_WORDS.min}-${FREE_TALK_WORDS.max})`
        : null;
    },
  );
}

/**
 * Shorter rewrite of a free-talk script whose audio overflowed Clio (#108): same task and content,
 * about `targetWords` words, never under the 210-word floor of the user requirement.
 */
export async function shortenFreeTalk(
  task: string,
  script: string,
  targetWords: number,
  ports: SpeakContentPorts = {},
): Promise<string> {
  const target = Math.max(210, Math.min(240, Math.round(targetWords)));
  const max = Math.min(FREE_TALK_WORDS.max, target + 5);
  return askWithRetry(
    ports,
    `Shorten this spoken English answer to about ${target} words (between 210 and ${max} words), ` +
      `keeping every point of the task, the same plain spoken style, short simple sentences and numbers written as words.\n` +
      `Task: ${task}\n\nAnswer to shorten:\n${script}\n\n` +
      `Output only the words to speak: no greeting to me, no "Sure" or "Here is", no title, no quotes, no word count.`,
    (s) => {
      const n = wordCount(s);
      return n < FREE_TALK_WORDS.min || n > max ? `reply has ${n} words (need ${FREE_TALK_WORDS.min}-${max})` : null;
    },
  );
}

/** One spoken reply (2–3 sentences) to the AI partner, staying on the task. */
export async function generateDialogReply(
  task: string,
  botSaid: string,
  turn: number,
  ports: SpeakContentPorts = {},
): Promise<string> {
  return askWithRetry(
    ports,
    `You are a Chinese college student in an English speaking practice with an AI friend.\nTask: ${task}\n` +
      `The AI just said: "${botSaid}"\n` +
      `Reply as the student in 2-3 natural spoken sentences (35-55 words) that directly answer the AI and cover the task points` +
      `${turn === 0 ? "" : " not yet mentioned"}. Output only the spoken reply.`,
    (s) => (wordCount(s) < 15 ? "reply shorter than 15 words" : null),
  );
}
