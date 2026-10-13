/**
 * Listening objective solver. loadPaper carries no answer key (`answers: []`;
 * paperReport's standardAnswer only appears after submit), but the paper ships the
 * transcript (contents[].text) or WebVTT subtitles for video items, so an
 * OpenAI-compatible LLM can answer from the transcript. Off unless an API key is
 * configured. Off mode (no key, or UNIPUS_LLM_SOLVER=off) is the explicit legacy
 * path: single-choice uses the bold/literal heuristic, gap-fill blanks stay empty,
 * and the grind summary warns. With the LLM on, failures throw (no silent fallback).
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

/** Answer the LLM produced: one string per question, or null when unparsable. */
function parseAnswers(raw: string, n: number): string[] | null {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(m ? m[0] : raw) as { answers?: unknown };
    if (!Array.isArray(parsed.answers)) return null;
    const arr = parsed.answers;
    return Array.from({ length: n }, (_, i) => String(arr[i] ?? "").trim());
  } catch {
    return null;
  }
}

export class LlmSolveError extends Error {}

/** Default 3 attempts (1 + 2 retries) on HTTP error / timeout / unparsable JSON, then throw. */
export const LLM_SOLVE_ATTEMPTS = 3;

async function askAnswers(ask: LlmAsk, prompt: string, n: number, attempts = LLM_SOLVE_ATTEMPTS): Promise<string[]> {
  let last = "no attempt";
  for (let i = 0; i < attempts; i++) {
    try {
      const parsed = parseAnswers(await ask(prompt), n);
      if (parsed) return parsed;
      last = "unparsable JSON";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new LlmSolveError(`LLM 作答失败（${attempts} 次）：${last}`);
}

export function parseChoiceAnswers(raw: string, questions: ChoiceQuestion[]): Array<string | null> {
  const parsed = parseAnswers(raw, questions.length) ?? questions.map(() => "");
  return parsed.map((a, i) => toChoiceValue(a, questions[i]!));
}

function toChoiceValue(a: string, q: ChoiceQuestion): string | null {
  const v = a.toUpperCase().replace(/[^A-Z]/g, "");
  return q.options.some((o) => o.value === v) ? v : null;
}

/** Answer JSON plus how many questions the LLM left without a usable answer. */
export type SolvedAnswer = { answer: string; unanswered: number };

/**
 * Objective single-choice answer (same shape as buildObjectiveAnswer).
 * LLM/transport/JSON failure after retries throws LlmSolveError — the caller must
 * not submit the paper. Per-question invalid letters fall back to the heuristic
 * and are counted in `unanswered` so the run summary can warn.
 */
export async function buildSolvedObjectiveAnswer(
  data: Record<string, unknown>,
  ask: LlmAsk,
  fetchText: FetchText = defaultFetchText,
): Promise<SolvedAnswer> {
  const parentContents = asArray(data.contents);
  const kids = asArray(data.children).map(asRecord);
  const nodes = kids.length > 0 ? kids : [data];
  const questions = nodes.map((n) => (n === data ? { ...toChoiceQuestion(n), question: "" } : toChoiceQuestion(n)));
  const context = await contentsContext(parentContents, fetchText);
  const raw = await askAnswers(ask, buildChoicePrompt(context, questions), questions.length);
  const picks = raw.map((a, i) => toChoiceValue(a, questions[i]!));
  const children = nodes.map((n, i) => {
    const ctx = n === data ? parentContents : [...parentContents, ...asArray(n.contents)];
    return { value: [picks[i] ?? pickSingleChoice(n, ctx)], isDone: true };
  });
  return {
    answer: JSON.stringify({ value: [], children }),
    unanswered: picks.filter((p) => p == null).length,
  };
}

/**
 * fillblank-scoop: passage in children[0].quesText, one child per blank.
 * `ask === null` (LLM off) is the explicit legacy path: blanks submitted empty and
 * all counted as unanswered. LLM failure after retries throws LlmSolveError.
 */
export async function buildSolvedFillblankAnswer(
  data: Record<string, unknown>,
  ask: LlmAsk | null,
  fetchText: FetchText = defaultFetchText,
): Promise<SolvedAnswer> {
  const kids = asArray(data.children).map(asRecord);
  const n = Math.max(kids.length, 1);
  let words: string[] = Array.from({ length: n }, () => "");
  if (ask) {
    const contents = [data, ...kids].flatMap((k) => asArray(k.contents));
    const context = await contentsContext(contents, fetchText);
    const passage = kids.map((k) => stripHtml(String(k.quesText || ""))).filter(Boolean).join(" ")
      || stripHtml(String(data.quesText || ""));
    words = await askAnswers(ask, buildFillblankPrompt(context, passage, n), n);
  }
  return {
    answer: JSON.stringify({ value: [], children: words.map((w) => ({ value: [w], isDone: true })) }),
    unanswered: words.filter((w) => !w).length,
  };
}
