/**
 * Listening objective solver. loadPaper carries no answer key (`answers: []`;
 * paperReport's standardAnswer only appears after submit). The paper ships the
 * transcript (contents[].text) or WebVTT subtitles. The driving agent writes
 * the answer through UNIPUS_AGENT_ANSWER_DIR. A missing queue, an invalid
 * option, or an empty blank throws AnswerSolveError and the paper is not submitted.
 */
import { stripHtml } from "./grind-paper.js";
import { AgentAnswerRequiredError, createAgentAsk, resolveAgentAnswerDir } from "./agent-answers.js";

export type AnswerAsk = (prompt: string, context?: { groupId?: string }) => Promise<string>;

export type ChoiceQuestion = {
  question: string;
  options: Array<{ value: string; text: string }>;
};

/** Fetch subtitle text (public birdflock CDN, outside the UnipusHttp allowlist). */
export type FetchText = (url: string) => Promise<string>;

/** Only the agent answer queue. No remote model client. */
export function resolveConfiguredAsk(env: NodeJS.ProcessEnv = process.env): AnswerAsk | null {
  const dir = resolveAgentAnswerDir(env);
  if (!dir) return null;
  const raw = env.UNIPUS_AGENT_ANSWER_WAIT_MS;
  return createAgentAsk(dir, { waitMs: raw == null ? undefined : Number(raw) });
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

export async function prepareObjectiveSolve(
  data: Record<string, unknown>,
  fetchText: FetchText = defaultFetchText,
): Promise<{ prompt: string; questions: ChoiceQuestion[] }> {
  const parentContents = asArray(data.contents);
  const kids = asArray(data.children).map(asRecord);
  const nodes = kids.length > 0 ? kids : [data];
  const questions = nodes.map((n) => (n === data ? { ...toChoiceQuestion(n), question: "" } : toChoiceQuestion(n)));
  const context = await contentsContext(parentContents, fetchText);
  return { prompt: buildChoicePrompt(context, questions), questions };
}

export async function prepareFillblankSolve(
  data: Record<string, unknown>,
  fetchText: FetchText = defaultFetchText,
): Promise<{ prompt: string; blanks: number }> {
  const kids = asArray(data.children).map(asRecord);
  const blanks = Math.max(kids.length, 1);
  const contents = [data, ...kids].flatMap((k) => asArray(k.contents));
  const context = await contentsContext(contents, fetchText);
  const passage = kids.map((k) => stripHtml(String(k.quesText || ""))).filter(Boolean).join(" ")
    || stripHtml(String(data.quesText || ""));
  return { prompt: buildFillblankPrompt(context, passage, blanks), blanks };
}

export function buildFillblankPrompt(context: string, passage: string, blanks: number): string {
  return (
    `Transcript:\n${context}\n\nGap-fill passage (${blanks} blanks marked ____n____):\n${passage}\n\n` +
    `Fill each blank with the exact word(s) the speaker uses in the transcript, keeping the transcript's ` +
    `word form. Reply with JSON only: {"answers":["word", ...]} with ${blanks} items in blank order.`
  );
}

/** One string per question, or null when unparsable. */
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

export class AnswerSolveError extends Error {}

/** Default 3 attempts (1 + 2 retries) on a bad answer, then throw. */
export const ANSWER_ATTEMPTS = 3;

async function askAnswers(ask: AnswerAsk, prompt: string, n: number, attempts = ANSWER_ATTEMPTS): Promise<string[]> {
  let last = "no attempt";
  for (let i = 0; i < attempts; i++) {
    try {
      const parsed = parseAnswers(await ask(prompt), n);
      if (parsed) return parsed;
      last = "unparsable JSON";
    } catch (error) {
      if (error instanceof AgentAnswerRequiredError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new AnswerSolveError(`作答失败（${attempts} 次）：${last}`);
}

export function parseChoiceAnswers(raw: string, questions: ChoiceQuestion[]): Array<string | null> {
  const parsed = parseAnswers(raw, questions.length) ?? questions.map(() => "");
  return parsed.map((a, i) => toChoiceValue(a, questions[i]!));
}

function toChoiceValue(a: string, q: ChoiceQuestion): string | null {
  const v = a.toUpperCase().replace(/[^A-Z]/g, "");
  return q.options.some((o) => o.value === v) ? v : null;
}

/** Answer JSON plus how many questions were left without a usable answer. */
export type SolvedAnswer = { answer: string; unanswered: number };

/** One raw agent reply → objective answer JSON. Invalid options are not guessed. */
export function objectiveAnswerFromRaw(raw: string, questions: ChoiceQuestion[]): SolvedAnswer {
  const parsed = parseAnswers(raw, questions.length);
  if (!parsed) throw new AnswerSolveError("LOW_SCORE_REFUSED: 单选答案不是 {\"answers\":[...]}");
  const picks = parsed.map((a, i) => toChoiceValue(a, questions[i]!));
  const missing = picks.filter((p) => p == null).length;
  if (missing > 0) {
    throw new AnswerSolveError(`LOW_SCORE_REFUSED: ${missing} 道单选没有有效选项，拒绝启发式补答`);
  }
  return {
    answer: JSON.stringify({ value: [], children: picks.map((pick) => ({ value: [pick!], isDone: true })) }),
    unanswered: 0,
  };
}

/** One raw agent reply → fill-blank answer JSON. Empty blanks are not submitted. */
export function fillblankAnswerFromRaw(raw: string, blanks: number): SolvedAnswer {
  const words = parseAnswers(raw, blanks);
  if (!words) throw new AnswerSolveError("LOW_SCORE_REFUSED: 填空答案不是 {\"answers\":[...]}");
  const missing = words.filter((word) => !word).length;
  if (missing > 0) {
    throw new AnswerSolveError(`LOW_SCORE_REFUSED: ${missing} 个填空没有答案，拒绝留空交卷`);
  }
  return {
    answer: JSON.stringify({ value: [], children: words.map((word) => ({ value: [word], isDone: true })) }),
    unanswered: 0,
  };
}

/**
 * Objective single-choice answer (same shape as buildObjectiveAnswer).
 * A bad answer and any question without a valid option throw AnswerSolveError.
 * The caller must not submit that paper.
 */
export async function buildSolvedObjectiveAnswer(
  data: Record<string, unknown>,
  ask: AnswerAsk,
  fetchText: FetchText = defaultFetchText,
): Promise<SolvedAnswer> {
  const { prompt, questions } = await prepareObjectiveSolve(data, fetchText);
  const raw = await askAnswers(ask, prompt, questions.length);
  const picks = raw.map((a, i) => toChoiceValue(a, questions[i]!));
  const missing = picks.filter((p) => p == null).length;
  if (missing > 0) {
    throw new AnswerSolveError(`LOW_SCORE_REFUSED: ${missing} 道单选没有有效选项，拒绝启发式补答`);
  }
  return {
    answer: JSON.stringify({ value: [], children: picks.map((pick) => ({ value: [pick!], isDone: true })) }),
    unanswered: 0,
  };
}

/**
 * fillblank-scoop: passage in children[0].quesText, one child per blank.
 * No answer source, or any blank left empty, throws. Empty blanks are not submitted.
 */
export async function buildSolvedFillblankAnswer(
  data: Record<string, unknown>,
  ask: AnswerAsk | null,
  fetchText: FetchText = defaultFetchText,
): Promise<SolvedAnswer> {
  if (ask == null) {
    throw new AnswerSolveError("LOW_SCORE_REFUSED: 未设置 UNIPUS_AGENT_ANSWER_DIR，听力填空拒绝留空交卷");
  }
  const { prompt, blanks } = await prepareFillblankSolve(data, fetchText);
  const words = await askAnswers(ask, prompt, blanks);
  return fillblankAnswerFromRaw(JSON.stringify({ answers: words }), blanks);
}
