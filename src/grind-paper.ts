/**
 * Shared paper walk + answer builders for headless weekly grind
 * (extracted from tmp-complete-*.ts scratch; no speakers/afplay, no /oral/train).
 */
import { asExactIdString } from "./safe-json.js";
import {
  reconcileAnswerChildren,
  diagnosePlacementSubmitCoverage,
} from "./placement-paper.js";

export type GrindLeaf = {
  instanceId: string;
  expectedChildren: number;
  template: string;
  replyType: string;
  type: string;
  isObjective: boolean;
  name: string;
  data: Record<string, unknown>;
};

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBold(html: string): string[] {
  const out: string[] = [];
  const re = /<(?:strong|b|em)[^>]*>([\s\S]*?)<\/(?:strong|b|em)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = stripHtml(m[1] ?? "");
    if (t) out.push(t);
  }
  return out;
}

export function walkPaperLeaves(paper: unknown): GrindLeaf[] {
  const out: GrindLeaf[] = [];
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (rec.q_qinstid != null) {
      const data0 =
        rec.data != null && typeof rec.data === "object" && !Array.isArray(rec.data)
          ? (rec.data as Record<string, unknown>)
          : {};
      let struct: Record<string, unknown> | null = null;
      if (typeof rec.q_qinst_struct === "string") {
        try {
          const parsed: unknown = JSON.parse(rec.q_qinst_struct);
          if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
            struct = parsed as Record<string, unknown>;
          }
        } catch {
          /* ignore */
        }
      } else if (
        rec.q_qinst_struct != null &&
        typeof rec.q_qinst_struct === "object" &&
        !Array.isArray(rec.q_qinst_struct)
      ) {
        struct = rec.q_qinst_struct as Record<string, unknown>;
      }
      let children = Array.isArray(data0.children) ? data0.children : [];
      if (
        children.length === 0 &&
        struct != null &&
        Array.isArray(struct.children)
      ) {
        children = struct.children;
      }
      const data: Record<string, unknown> = {
        ...(struct ?? {}),
        ...data0,
        children,
      };
      const id = asExactIdString(rec.q_qinstid);
      if (id != null) {
        out.push({
          instanceId: id,
          expectedChildren: children.length > 0 ? children.length : 1,
          template: String(rec.q_template_name || ""),
          replyType: String(data.replyType || ""),
          type: String(data.type || ""),
          isObjective: Boolean(rec.is_objective),
          name: String(rec.nm || ""),
          data,
        });
      }
    }
    const kids = rec.chr ?? rec.children;
    if (Array.isArray(kids)) visit(kids);
  };
  visit(paper);
  return out;
}

function pickSingleChoice(
  childOrQ: Record<string, unknown>,
  parentContents: unknown[],
): string {
  const options = Array.isArray(childOrQ.options) ? childOrQ.options : [];
  if (options.length === 0) return "A";
  const blob = parentContents
    .map((c) =>
      c != null && typeof c === "object" && !Array.isArray(c)
        ? String((c as Record<string, unknown>).text || "")
        : "",
    )
    .join(" ");
  const bolds = extractBold(blob).map((b) => b.toLowerCase());
  for (const opt of options) {
    if (opt == null || typeof opt !== "object") continue;
    const o = opt as Record<string, unknown>;
    const t = stripHtml(String(o.text || "")).toLowerCase();
    const v = String(o.value || o.name || "");
    if (t && bolds.some((b) => b.includes(t) || t.includes(b))) return v || "A";
  }
  const plain = stripHtml(blob).toLowerCase();
  for (const opt of options) {
    if (opt == null || typeof opt !== "object") continue;
    const o = opt as Record<string, unknown>;
    const t = stripHtml(String(o.text || "")).toLowerCase();
    const v = String(o.value || o.name || "");
    if (t && plain.includes(t)) return v || "A";
  }
  const first = options[0] as Record<string, unknown>;
  return String(first.value || first.name || "A");
}

export function buildObjectiveAnswer(leaf: GrindLeaf): string {
  const data = leaf.data;
  const children = Array.isArray(data.children) ? data.children : [];
  const parentContents = Array.isArray(data.contents) ? data.contents : [];
  if (children.length === 0) {
    const v = pickSingleChoice(data, parentContents);
    return JSON.stringify({
      value: [],
      children: [{ value: [v], isDone: true }],
    });
  }
  const built = children.map((ch) => {
    const child =
      ch != null && typeof ch === "object" && !Array.isArray(ch)
        ? (ch as Record<string, unknown>)
        : {};
    const extra = Array.isArray(child.contents) ? child.contents : [];
    const v = pickSingleChoice(child, [...parentContents, ...extra]);
    return { value: [v], isDone: true };
  });
  return JSON.stringify({ value: [], children: built });
}

export function buildLearnDoneAnswer(): string {
  return JSON.stringify({ value: [], children: [], isDone: true });
}

export function enSentChildRecord(text: string, url: string) {
  return {
    record: {
      type: "EN_SENT_SCORE",
      text,
      url,
      replayUrl: url,
      list: [],
    },
    value: [],
    isDone: true,
  };
}

export function segmentSpeakText(ch: unknown, fallback: string): string {
  if (ch == null || typeof ch !== "object" || Array.isArray(ch)) return fallback;
  const rec = ch as Record<string, unknown>;
  const rule =
    rec.rule != null && typeof rec.rule === "object" && !Array.isArray(rec.rule)
      ? (rec.rule as Record<string, unknown>)
      : null;
  const fromRule = rule?.text;
  if (typeof fromRule === "string" && fromRule.trim()) return fromRule.trim();
  const contents = Array.isArray(rec.contents) ? rec.contents : [];
  for (const c of contents) {
    if (c != null && typeof c === "object" && !Array.isArray(c)) {
      const text = (c as Record<string, unknown>).text;
      if (typeof text === "string" && text.includes("<")) {
        const t = stripHtml(text);
        if (t) return t;
      }
    }
  }
  const words = rule?.words;
  if (Array.isArray(words) && words[0] != null) {
    const w0 = words[0];
    const w = Array.isArray(w0) ? w0[0] : w0;
    if (typeof w === "string" && w.trim()) {
      const tmpl = contents.find(
        (c) =>
          c != null &&
          typeof c === "object" &&
          !Array.isArray(c) &&
          typeof (c as Record<string, unknown>).text === "string",
      ) as Record<string, unknown> | undefined;
      if (tmpl && typeof tmpl.text === "string") {
        const filled = String(tmpl.text).replace(/_{2,}\d*_{0,}|____\d*____/g, w);
        return stripHtml(filled) || w;
      }
      return w;
    }
  }
  return fallback;
}

export type BuiltUserItem = {
  instanceId: string;
  answer: string;
  answerVersion: number;
  context: string;
  contextVersion: number;
};

export function finalizeUserData(
  leaves: GrindLeaf[],
  answers: string[],
): { ok: true; userData: BuiltUserItem[] } | { ok: false; detail: string } {
  const userData: BuiltUserItem[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]!;
    const rec = reconcileAnswerChildren(answers[i] ?? "", leaf.expectedChildren);
    userData.push({
      instanceId: leaf.instanceId,
      answer: rec.answer,
      answerVersion: 1,
      context: JSON.stringify({ state: "done" }),
      contextVersion: 1,
    });
  }
  const diag = diagnosePlacementSubmitCoverage(
    leaves.map((l) => ({
      instanceId: l.instanceId,
      expectedChildren: l.expectedChildren,
      questionType: l.template || l.type,
      index: 0,
    })),
    userData.map((u) => ({ instanceId: u.instanceId, answer: u.answer })),
  );
  if (!diag.ok) {
    return { ok: false, detail: `coverage fail: ${JSON.stringify(diag)}` };
  }
  return { ok: true, userData };
}

export function isOkApiCode(code: unknown): boolean {
  return code === 1 || code === 0 || code === 200;
}

export const DEFAULT_AI_SPEAK_SCRIPT = [
  "Last term, I had some trouble with math.",
  "After class, I went to the teacher's office and asked for help.",
  "She explained the formula again with a simple example and showed me how to use it step by step.",
  "That experience made me realize how much a patient and caring teacher can help.",
].join(" ");
