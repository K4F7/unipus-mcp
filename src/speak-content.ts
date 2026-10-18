/**
 * Topic-relevant spoken content for 自由表达 / AI口语对话 (#63).
 * App history score for a speak paper follows the server's grading of the free
 * talk (open-speak: appropriateness/coherence/content vs the task points), so a
 * generic off-topic script caps the paper around 40–67. Uses the same
 * answer source as listening: the agent answer queue.
 * No answer source, or an answer that is too short, throws. Generic templates are not submitted.
 */
import { resolveConfiguredAsk, type AnswerAsk } from "./choice-solver.js";
import { AgentAnswerRequiredError } from "./agent-answers.js";
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

function cleanSpoken(s: string): string {
  return s
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/[*#_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpeakContentPorts = {
  env?: NodeJS.ProcessEnv;
  ask?: AnswerAsk | null;
  /** Reuse this id for later turns of the same question. */
  groupId?: string;
};

const NO_SOURCE = "LOW_SCORE_REFUSED: 未设置 UNIPUS_AGENT_ANSWER_DIR，口语拒绝通用模板交卷";
const FREE_TALK_MIN_WORDS = 90;

function resolveAsk(ports: SpeakContentPorts): AnswerAsk | null {
  if (ports.ask !== undefined) return ports.ask;
  return resolveConfiguredAsk(ports.env ?? process.env);
}

function wordCount(text: string): number {
  return text ? text.split(/\s+/).length : 0;
}

async function askWithRetry(ask: AnswerAsk, prompt: string, minWords: number, groupId?: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const out = cleanSpoken(await ask(prompt, groupId ? { groupId } : undefined));
      if (wordCount(out) >= minWords) return out;
      last = `answer needs at least ${minWords} words`;
    } catch (error) {
      if (error instanceof AgentAnswerRequiredError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`SPEAK_CONTENT_FAILED: ${last}`);
}

/** Prompt for one free-talk leaf. Sub-questions of that leaf stay in this one prompt. */
export function freeTalkPrompt(task: string): string {
  return (
    `You are a Chinese college student taking an English speaking test.\nTask: ${task}\n\n` +
    `Write what you would SAY: a natural first-person spoken answer of 140-160 words that clearly covers EVERY point in the task, in order, ` +
    `with a short opening sentence, linking words (first, besides, for example, as a result, in short) and a short conclusion. ` +
    `Use simple, correct, natural English. Output only the spoken text, no title, no bullet points, no quotes.`
  );
}

/** Accept one queued free-talk reply. A short reply is not spoken or submitted. */
export function acceptFreeTalk(raw: string): string {
  const out = cleanSpoken(raw);
  if (wordCount(out) < FREE_TALK_MIN_WORDS) {
    throw new Error(`SPEAK_CONTENT_FAILED: answer needs at least ${FREE_TALK_MIN_WORDS} words`);
  }
  return out;
}

/** ~60 s monologue (≈130–160 words) covering every bullet of the task. */
export async function generateFreeTalk(task: string, ports: SpeakContentPorts = {}): Promise<string> {
  const ask = resolveAsk(ports);
  if (ask) return askWithRetry(ask, freeTalkPrompt(task), FREE_TALK_MIN_WORDS, ports.groupId);
  throw new Error(NO_SOURCE);
}

/** One spoken reply (2–3 sentences) to the AI partner, staying on the task. */
export async function generateDialogReply(
  task: string,
  botSaid: string,
  turn: number,
  ports: SpeakContentPorts = {},
): Promise<string> {
  const ask = resolveAsk(ports);
  if (ask) {
    const out = await askWithRetry(
      ask,
      `You are a Chinese college student in an English speaking practice with an AI friend.\nTask: ${task}\n` +
        `The AI just said: "${botSaid}"\n` +
        `Reply as the student in 2-3 natural spoken sentences (35-55 words) that directly answer the AI and cover the task points` +
        `${turn === 0 ? "" : " not yet mentioned"}. Output only the spoken reply.`,
      15,
      ports.groupId,
    );
    return out;
  }
  throw new Error(NO_SOURCE);
}
