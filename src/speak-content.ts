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

function cleanSpoken(s: string): string {
  return s
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/[*#_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpeakContentPorts = { env?: NodeJS.ProcessEnv; ask?: LlmAsk };

const ATTEMPTS = 3;

async function askWithRetry(ports: SpeakContentPorts, prompt: string, minWords: number): Promise<string> {
  const ask = ports.ask ?? resolveLlmAsk(ports.env ?? process.env);
  let last = "no attempt";
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const out = cleanSpoken(await ask(prompt));
      if (out.split(/\s+/).length >= minWords) return out;
      last = `reply shorter than ${minWords} words`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new AnswerRefusedError(`口语 LLM 作答失败（${ATTEMPTS} 次），拒绝用模板交卷：${last}`);
}

/** ~60 s monologue (≈130–160 words) covering every bullet of the task. */
export async function generateFreeTalk(task: string, ports: SpeakContentPorts = {}): Promise<string> {
  return askWithRetry(
    ports,
    `You are a Chinese college student taking an English speaking test.\nTask: ${task}\n\n` +
      `Write what you would SAY: a natural first-person spoken answer of 140-160 words that clearly covers EVERY point in the task, in order, ` +
      `with a short opening sentence, linking words (first, besides, for example, as a result, in short) and a short conclusion. ` +
      `Use simple, correct, natural English. Output only the spoken text, no title, no bullet points, no quotes.`,
    90,
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
    15,
  );
}
