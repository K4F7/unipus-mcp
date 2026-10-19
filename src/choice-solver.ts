/**
 * Listening objective solver. loadPaper carries no answer key (`answers: []`;
 * paperReport's standardAnswer only appears after submit), but the paper ships the
 * transcript (contents[].text) or WebVTT subtitles for video items, so an
 * OpenAI-compatible LLM answers from the transcript.
 *
 * LLM answers only: no heuristic guess, no empty blank, no template. Missing
 * UNIPUS_LLM_* config, or no valid answer after retries, throws AnswerRefusedError and
 * the caller must not submit (Sein: 没答案不要交).
 */
import { stripHtml } from "./grind-paper.js";
import { wallClockSignal, wallClockTimer } from "./watchdog.js";
import { resolveLlmFirstByteMs, resolveLlmIdleMs, resolveLlmMaxTokens, resolveLlmTimeoutMs } from "./limits.js";

export type LlmAsk = (prompt: string) => Promise<string>;

export type ChoiceSolverConfig = { baseUrl: string; apiKey: string; model: string };
/** Per-request limits; defaults from UNIPUS_LLM_TIMEOUT_MS / _FIRST_BYTE_MS / _IDLE_MS / _MAX_TOKENS. */
export type LlmRequestLimits = { timeoutMs?: number; firstByteMs?: number; idleMs?: number; maxTokens?: number };

export type ChoiceQuestion = {
  question: string;
  options: Array<{ value: string; text: string }>;
};

/** Fetch subtitle text (public birdflock CDN, outside the UnipusHttp allowlist). */
export type FetchText = (url: string) => Promise<string>;

/** No usable LLM answer (config missing, LLM failed, invalid/empty answer): do not submit. */
export class AnswerRefusedError extends Error {
  constructor(message: string) {
    super(message.startsWith("ANSWER_REFUSED") ? message : `ANSWER_REFUSED: ${message}`);
    this.name = "AnswerRefusedError";
  }
}

export const LLM_ENV_VARS = ["UNIPUS_LLM_BASE_URL", "UNIPUS_LLM_MODEL", "UNIPUS_LLM_API_KEY"] as const;

/** Only UNIPUS_LLM_BASE_URL / UNIPUS_LLM_MODEL / UNIPUS_LLM_API_KEY; any missing → throws. */
export function resolveChoiceSolverConfig(env: NodeJS.ProcessEnv = process.env): ChoiceSolverConfig {
  const missing = LLM_ENV_VARS.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new AnswerRefusedError(`未配置 LLM（缺 ${missing.join(" / ")}），拒绝交卷`);
  }
  return {
    baseUrl: env.UNIPUS_LLM_BASE_URL!.trim().replace(/\/+$/, ""),
    model: env.UNIPUS_LLM_MODEL!.trim(),
    apiKey: env.UNIPUS_LLM_API_KEY!.trim(),
  };
}

/** Configured LLM ask, or throws AnswerRefusedError. */
export function resolveLlmAsk(env: NodeJS.ProcessEnv = process.env): LlmAsk {
  return createLlmAsk({
    ...resolveChoiceSolverConfig(env),
    timeoutMs: resolveLlmTimeoutMs(env),
    firstByteMs: resolveLlmFirstByteMs(env),
    idleMs: resolveLlmIdleMs(env),
    maxTokens: resolveLlmMaxTokens(env),
  });
}

/** One tiny request before any paper is touched: an unreachable / misconfigured LLM refuses the account up front. */
export async function probeLlm(ask: LlmAsk, attempts = 2): Promise<void> {
  let last = "empty reply";
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await ask("Reply with the single word OK.")).trim()) return;
      last = "empty reply";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new AnswerRefusedError(`LLM 探活失败（${attempts} 次），本账号不登录、不交卷：${last}`);
}

/**
 * Streamed chat completion with three limits (#100): no body byte within
 * `firstByteMs` (dead gateway), a silent stream for `idleMs` (stalled mid-way),
 * and `timeoutMs` overall. Each error names its stage so logs tell them apart.
 */
export function createLlmAsk(
  config: ChoiceSolverConfig & LlmRequestLimits,
  fetchImpl: typeof fetch = globalThis.fetch,
): LlmAsk {
  return async (prompt) => {
    const totalMs = config.timeoutMs ?? resolveLlmTimeoutMs({});
    const idleMs = config.idleMs ?? resolveLlmIdleMs({});
    const ctl = new AbortController();
    let received = 0;
    const abort = (message: string) => {
      const err = new Error(message);
      err.name = "TimeoutError";
      ctl.abort(err);
    };
    const cancelTotal = wallClockTimer(totalMs, () => abort(`LLM 总时长超时 (${totalMs}ms，已收 ${received} 字节)`));
    const firstByteMs = config.firstByteMs ?? resolveLlmFirstByteMs({});
    let cancelIdle = wallClockTimer(firstByteMs, () => abort(`LLM 首包超时 (${firstByteMs}ms)`));
    const onBytes = (n: number) => {
      received += n;
      cancelIdle();
      cancelIdle = wallClockTimer(idleMs, () => abort(`LLM 流空闲超时 (${idleMs}ms 无数据，已收 ${received} 字节)`));
    };
    try {
      const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: config.maxTokens ?? resolveLlmMaxTokens({}),
          // Streamed so gateways with a ~60s idle cut (grok, #92) keep the connection open.
          stream: true,
          messages: [
            { role: "system", content: "You are an expert English listening exam solver." },
            { role: "user", content: prompt },
          ],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`llm solver HTTP ${res.status}`);
      const text = await readBody(res, ctl.signal, onBytes);
      if (!/event-stream/.test(res.headers.get("content-type") ?? "")) {
        const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        return body.choices?.[0]?.message?.content ?? "";
      }
      return sseContent(text);
    } finally {
      cancelTotal();
      cancelIdle();
    }
  };
}

/** Read the body chunk by chunk (each chunk feeds the idle timer); an abort ends the read with its reason. */
async function readBody(res: Response, signal: AbortSignal, onBytes: (n: number) => void): Promise<string> {
  if (res.body == null) return "";
  const reader = res.body.getReader();
  const stop = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) return out + decoder.decode();
      onBytes(value.byteLength);
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** Join `choices[0].delta.content` of an OpenAI-style SSE body. */
function sseContent(text: string): string {
  let out = "";
  for (const line of text.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
    out += chunk.choices?.[0]?.delta?.content ?? "";
  }
  return out;
}

export const defaultFetchText: FetchText = async (url) => {
  const deadline = wallClockSignal(20_000);
  try {
    const res = await fetch(url, { signal: deadline.signal });
    if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
    return await res.text();
  } finally {
    deadline.clear();
  }
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

/** Default 3 attempts (1 + 2 retries) on HTTP error / timeout / unparsable or invalid answer, then throw. */
export const LLM_SOLVE_ATTEMPTS = 3;

/**
 * Ask until `accept` maps the parsed answers to a full valid result (null = some
 * answer invalid/empty). Never fills a gap itself; throws after `attempts`.
 */
async function askAnswers<T>(
  ask: LlmAsk,
  prompt: string,
  n: number,
  accept: (answers: string[]) => T | null,
  attempts = LLM_SOLVE_ATTEMPTS,
): Promise<T> {
  let last = "no attempt";
  for (let i = 0; i < attempts; i++) {
    try {
      const parsed = parseAnswers(await ask(prompt), n);
      const accepted = parsed && accept(parsed);
      if (accepted) return accepted;
      last = parsed ? "部分题无合法答案（invalid/empty）" : "unparsable JSON";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new AnswerRefusedError(`LLM 作答失败（${attempts} 次），无合法答案，拒绝交卷：${last}`);
}

export function parseChoiceAnswers(raw: string, questions: ChoiceQuestion[]): Array<string | null> {
  const parsed = parseAnswers(raw, questions.length) ?? questions.map(() => "");
  return parsed.map((a, i) => toChoiceValue(a, questions[i]!));
}

function toChoiceValue(a: string, q: ChoiceQuestion): string | null {
  const v = a.toUpperCase().replace(/[^A-Z]/g, "");
  return q.options.some((o) => o.value === v) ? v : null;
}

function childrenAnswer(values: string[]): string {
  return JSON.stringify({ value: [], children: values.map((v) => ({ value: [v], isDone: true })) });
}

/**
 * Objective single-choice answer JSON. Every question must get a valid option
 * letter from the LLM; otherwise retry, then throw AnswerRefusedError (caller must not submit).
 */
export async function buildSolvedObjectiveAnswer(
  data: Record<string, unknown>,
  ask: LlmAsk,
  fetchText: FetchText = defaultFetchText,
): Promise<string> {
  const kids = asArray(data.children).map(asRecord);
  const nodes = kids.length > 0 ? kids : [data];
  const questions = nodes.map((n) => (n === data ? { ...toChoiceQuestion(n), question: "" } : toChoiceQuestion(n)));
  const context = await contentsContext(asArray(data.contents), fetchText);
  const picks = await askAnswers(ask, buildChoicePrompt(context, questions), questions.length, (raw) => {
    const vals = raw.map((a, i) => toChoiceValue(a, questions[i]!));
    return vals.every((v): v is string => v != null) ? vals : null;
  });
  return childrenAnswer(picks);
}

/**
 * fillblank-scoop: passage in children[0].quesText, one child per blank. Every
 * blank must be non-empty; otherwise retry, then throw AnswerRefusedError.
 */
export async function buildSolvedFillblankAnswer(
  data: Record<string, unknown>,
  ask: LlmAsk,
  fetchText: FetchText = defaultFetchText,
): Promise<string> {
  const kids = asArray(data.children).map(asRecord);
  const n = Math.max(kids.length, 1);
  const contents = [data, ...kids].flatMap((k) => asArray(k.contents));
  const context = await contentsContext(contents, fetchText);
  const passage = kids.map((k) => stripHtml(String(k.quesText || ""))).filter(Boolean).join(" ")
    || stripHtml(String(data.quesText || ""));
  const words = await askAnswers(ask, buildFillblankPrompt(context, passage, n), n, (raw) =>
    raw.every(Boolean) ? raw : null,
  );
  return childrenAnswer(words);
}
