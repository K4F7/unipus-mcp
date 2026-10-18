/**
 * Topic-relevant spoken content for 自由表达 / AI口语对话 (#63).
 * App history score for a speak paper follows the server's grading of the free
 * talk (open-speak: appropriateness/coherence/content vs the task points), so a
 * generic off-topic script caps the paper around 40–67. Uses the same
 * answer source as the listening solver (agent queue / OpenAI-compatible LLM).
 * Legacy template is only used when no answer source is configured.
 */
import { resolveConfiguredAsk, type LlmAsk } from "./choice-solver.js";
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

export function templateFreeTalk(task: string): string {
  const topic = (task.match(/about ([^.;:]+)/i)?.[1] ?? "this topic").trim();
  return cleanSpoken(
    `I'd like to talk about ${topic}. First of all, this topic really matters to me in my daily life as a college student. ` +
      `To begin with, I think the most important point is that it helps me learn more about myself and the people around me. ` +
      `For example, last semester I spent a lot of time on it, and I found it both interesting and useful. ` +
      `Besides, it also brings me a lot of fun and makes me feel more confident. ` +
      `In addition, I usually share my experience with my friends, and we often learn from each other. ` +
      `In short, ${topic} is meaningful to me, and I will keep paying attention to it in the future.`,
  );
}

export type SpeakContentPorts = { env?: NodeJS.ProcessEnv; ask?: LlmAsk | null };

function resolveAsk(ports: SpeakContentPorts): LlmAsk | null {
  if (ports.ask !== undefined) return ports.ask;
  return resolveConfiguredAsk(ports.env ?? process.env);
}

async function askWithRetry(ask: LlmAsk, prompt: string, minWords: number): Promise<string> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const out = cleanSpoken(await ask(prompt));
      if (out.split(/\s+/).length >= minWords) return out;
      last = `answer needs at least ${minWords} words`;
    } catch (error) {
      if (error instanceof AgentAnswerRequiredError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`SPEAK_CONTENT_FAILED: ${last}`);
}

/** ~60 s monologue (≈130–160 words) covering every bullet of the task. */
export async function generateFreeTalk(task: string, ports: SpeakContentPorts = {}): Promise<string> {
  const ask = resolveAsk(ports);
  if (ask) {
    const out = await askWithRetry(
      ask,
      `You are a Chinese college student taking an English speaking test.\nTask: ${task}\n\n` +
        `Write what you would SAY: a natural first-person spoken answer of 140-160 words that clearly covers EVERY point in the task, in order, ` +
        `with a short opening sentence, linking words (first, besides, for example, as a result, in short) and a short conclusion. ` +
        `Use simple, correct, natural English. Output only the spoken text, no title, no bullet points, no quotes.`,
      90,
    );
    return out;
  }
  return templateFreeTalk(task);
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
    );
    return out;
  }
  return templateFreeTalk(task).split(/(?<=[.!?])\s+/).slice(turn * 2, turn * 2 + 2).join(" ") ||
    "That's a good question. I think it is really important to me, and I enjoy it a lot.";
}
