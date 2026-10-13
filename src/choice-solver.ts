/**
 * Listening objective solver. loadPaper carries no answer key (`answers: []`;
 * paperReport's standardAnswer only appears after submit), but the paper ships the
 * transcript (contents[].text) or WebVTT subtitles for video items, so an
 * OpenAI-compatible LLM can answer from the transcript. Off unless an API key is
 * configured; callers then fall back to the bold/literal heuristic.
 */
import { pickSingleChoice, stripHtml } from "./grind-paper.js";

export type LlmAsk = (prompt: string) => Promise<string>;

export type ChoiceSolverConfig = { baseUrl: string; apiKey: string; model: string };

export type ChoiceQuestion = {
  question: string;
  options: Array<{ value: string; text: string }>;
};

/** Fetch subtitle text (public birdflock CDN, outside the UnipusHttp allowlist). */
export type FetchText = (url: string) => Promise<string>;

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3";

export function resolveChoiceSolverConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChoiceSolverConfig | null {
  const apiKey = env.UNIPUS_LLM_API_KEY?.trim() || env.SILICONFLOW_API_KEY?.trim();
  if (!apiKey || env.UNIPUS_LLM_SOLVER === "off") return null;
  return {
    apiKey,
    baseUrl: (env.UNIPUS_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.UNIPUS_LLM_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export function createLlmAsk(config: ChoiceSolverConfig, fetchImpl: typeof fetch = globalThis.fetch): LlmAsk {
  return async (prompt) => {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: "You are an expert English listening exam solver." },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`llm solver HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? "";
  };
}

export const defaultFetchText: FetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
  return res.text();
};

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** WebVTT → plain cue text. */
export function vttToText(vtt: string): string {
  return vtt
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^WEBVTT|-->|^\d+$|^NOTE/.test(l.trim()))
    .map((l) => stripHtml(l))
    .join(" ");
}

/** Transcript text + subtitles from a contents[] array. */
export async function contentsContext(contents: unknown, fetchText: FetchText): Promise<string> {
  const parts: string[] = [];
  for (const c of asArray(contents)) {
    const r = asRecord(c);
    const t = stripHtml(String(r.text || ""));
    if (t) parts.push(t);
    for (const s of asArray(r.subtitles)) {
      const path = String(asRecord(s).path || "");
      if (!path) continue;
      try {
        parts.push(vttToText(await fetchText(path)));
      } catch {
        // missing subtitle → solve with what we have
      }
    }
  }
  return parts.join("\n");
}

function questionOf(node: Record<string, unknown>): string {
  const fromContents = asArray(node.contents)
    .map((c) => stripHtml(String(asRecord(c).text || "")))
    .filter(Boolean)
    .join(" ");
  return fromContents || stripHtml(String(node.quesText || ""));
}

export function toChoiceQuestion(node: Record<string, unknown>): ChoiceQuestion {
  const options = asArray(node.options).map((o) => {
    const r = asRecord(o);
    return { value: String(r.value || r.name || ""), text: stripHtml(String(r.text || "")) };
  });
  return { question: questionOf(node), options };
}

export function buildChoicePrompt(context: string, questions: ChoiceQuestion[]): string {
  const qs = questions
    .map((q, i) => {
      const opts = q.options.map((o) => `${o.value}. ${o.text}`).join("\n");
      return `Q${i + 1}. ${q.question || "(choose the option matching the material)"}\n${opts}`;
    })
    .join("\n\n");
  return (
    `Material (listening transcript / sentence; bold words are the tested word):\n${context}\n\n` +
    `${qs}\n\nAnswer every question using the material. If the options are word meanings, pick the ` +
    `meaning of the bold word exactly as used in that sentence (not its general sense). Reply with JSON only: ` +
    `{"answers":["A", ...]} in question order.`
  );
}

export function buildFillblankPrompt(context: string, passage: string, blanks: number): string {
  return (
    `Transcript:\n${context}\n\nGap-fill passage (${blanks} blanks marked ____n____):\n${passage}\n\n` +
    `Fill each blank with the exact word(s) the speaker uses in the transcript, keeping the transcript's ` +
    `word form. Reply with JSON only: {"answers":["word", ...]} with ${blanks} items in blank order.`
  );
}

function parseAnswers(raw: string, n: number): string[] {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(m ? m[0] : raw) as { answers?: unknown };
    const arr = Array.isArray(parsed.answers) ? parsed.answers : [];
    return Array.from({ length: n }, (_, i) => String(arr[i] ?? "").trim());
  } catch {
    return Array.from({ length: n }, () => "");
  }
}

export function parseChoiceAnswers(raw: string, questions: ChoiceQuestion[]): Array<string | null> {
  return parseAnswers(raw, questions.length).map((a, i) => {
    const v = a.toUpperCase().replace(/[^A-Z]/g, "");
    return questions[i]!.options.some((o) => o.value === v) ? v : null;
  });
}

/**
 * Objective single-choice answer (same shape as buildObjectiveAnswer). LLM picks win;
 * any null / LLM failure falls back to the bold/literal heuristic per question.
 */
export async function buildSolvedObjectiveAnswer(
  data: Record<string, unknown>,
  ask: LlmAsk,
  fetchText: FetchText = defaultFetchText,
): Promise<string> {
  const parentContents = asArray(data.contents);
  const kids = asArray(data.children).map(asRecord);
  const nodes = kids.length > 0 ? kids : [data];
  const questions = nodes.map((n) => (n === data ? { ...toChoiceQuestion(n), question: "" } : toChoiceQuestion(n)));
  let picks: Array<string | null> = questions.map(() => null);
  try {
    const context = await contentsContext(parentContents, fetchText);
    picks = parseChoiceAnswers(await ask(buildChoicePrompt(context, questions)), questions);
  } catch {
    // heuristic fallback below
  }
  const children = nodes.map((n, i) => {
    const ctx = n === data ? parentContents : [...parentContents, ...asArray(n.contents)];
    return { value: [picks[i] ?? pickSingleChoice(n, ctx)], isDone: true };
  });
  return JSON.stringify({ value: [], children });
}

/** fillblank-scoop: passage in children[0].quesText, one child per blank. */
export async function buildSolvedFillblankAnswer(
  data: Record<string, unknown>,
  ask: LlmAsk | null,
  fetchText: FetchText = defaultFetchText,
): Promise<string> {
  const kids = asArray(data.children).map(asRecord);
  const n = Math.max(kids.length, 1);
  let words: string[] = Array.from({ length: n }, () => "");
  if (ask) {
    try {
      const contexts = [data, ...kids].map((k) => asArray(k.contents)).flat();
      const context = await contentsContext(contexts, fetchText);
      const passage = kids.map((k) => stripHtml(String(k.quesText || ""))).filter(Boolean).join(" ")
        || stripHtml(String(data.quesText || ""));
      words = parseAnswers(await ask(buildFillblankPrompt(context, passage, n)), n);
    } catch {
      // leave blanks empty
    }
  }
  return JSON.stringify({ value: [], children: words.map((w) => ({ value: [w], isDone: true })) });
}
