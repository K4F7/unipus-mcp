/**
 * Placement (定级) paper helpers — reverse-engineered from SPA
 * `mobile-speak-placement-*.js` ExamContext (submitExam + reconcile k/w).
 *
 * Placement completion is NOT per-question gradeQuestion; it is full-paper
 * submitAnswer with userData covering every leaf, each answer.children length
 * matching the paper's sub-question count. Short/missing → server 4295.
 */

import {
  asExactIdString,
  parseJsonPreservingLargeInts,
  parsePaperJson,
} from "./safe-json.js";

export type PlacementQuestion = {
  instanceId: string;
  /** Paper sub-question count (data.children.length || subQuesNum || 1). */
  expectedChildren: number;
  questionType: string;
  index: number;
};

export type PlacementUserDataItem = {
  instanceId: string;
  answer: string;
  answerVersion?: number;
  context?: string;
  contextVersion?: number;
};

export type ReconcileResult = {
  answer: string;
  repaired: boolean;
  expected: number;
  actualBefore: number;
};

export type PlacementCoverageDiagnosis = {
  ok: boolean;
  missingInstanceIds: string[];
  extraInstanceIds: string[];
  shortChildren: Array<{
    instanceId: string;
    expected: number;
    actual: number;
  }>;
};

type JsonRecord = Record<string, unknown>;

/**
 * List placement/training leaf questions from paperJson (object or string).
 * Mirrors SPA paperParser leaf walk on q_qinstid.
 */
export function listPlacementQuestions(paperJson: unknown): PlacementQuestion[] {
  let tree: unknown;
  if (typeof paperJson === "string") {
    try {
      tree = parseJsonPreservingLargeInts(paperJson);
    } catch {
      tree = parsePaperJson(paperJson);
    }
  } else {
    tree = paperJson;
  }
  if (tree == null) {
    return [];
  }

  const out: PlacementQuestion[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (node == null) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node !== "object") {
      return;
    }
    const rec = node as JsonRecord;
    const id =
      asExactIdString(rec.q_qinstid) ??
      asExactIdString(rec.questionInstanceId) ??
      asExactIdString(rec.instanceId);
    if (id != null && !seen.has(id)) {
      seen.add(id);
      out.push({
        instanceId: id,
        expectedChildren: expectedChildrenOf(rec),
        questionType: String(
          rec.type ?? rec.questionType ?? rec.replyType ?? "",
        ),
        index: out.length,
      });
    }
    const kids = rec.chr ?? rec.children;
    if (Array.isArray(kids)) {
      visit(kids);
    }
  };

  visit(tree);
  return out;
}

function expectedChildrenOf(node: JsonRecord): number {
  const data =
    node.data != null && typeof node.data === "object" && !Array.isArray(node.data)
      ? (node.data as JsonRecord)
      : node;
  const children = data.children;
  if (Array.isArray(children) && children.length > 0) {
    return children.length;
  }
  const sub = data.subQuesNum ?? node.subQuesNum;
  if (typeof sub === "number" && Number.isFinite(sub) && sub > 0) {
    return Math.floor(sub);
  }
  if (typeof sub === "string" && sub.trim() !== "") {
    const n = Number(sub);
    if (Number.isFinite(n) && n > 0) {
      return Math.floor(n);
    }
  }
  return 1;
}

/** SPA oral stub child when padding multi-sub oral answers. */
export function emptyOralChild(): JsonRecord {
  return {
    value: [],
    isDone: false,
    record: {
      url: "",
      specific_scores: {
        total: 0,
        accuracy: 0,
        integrity: 0,
        fluency: 0,
        relevance: 0,
      },
      recordDetail: {
        score: 0,
        smooth: 0,
        completed: 0,
        correctness: 0,
        relevance: 0,
        audioUrl: "",
        details: [],
        detailsWords: [],
        comment: "",
        asrDetail: "",
      },
      list: [],
      type: "",
      replayUrl: "",
      path: "",
      text: "",
    },
  };
}

export function emptyObjectiveChild(): JsonRecord {
  return { value: [], isDone: false };
}

/**
 * Pad answer.children to expected length (SPA ExamContext `k`/`w`).
 * No-op when expected <= 1 or children already long enough.
 */
export function reconcileAnswerChildren(
  answerJson: string | JsonRecord,
  expectedChildren: number,
): ReconcileResult {
  const expected =
    Number.isFinite(expectedChildren) && expectedChildren > 0
      ? Math.floor(expectedChildren)
      : 1;

  let parsed: JsonRecord;
  if (typeof answerJson === "string") {
    try {
      const v = JSON.parse(answerJson) as unknown;
      if (v == null || typeof v !== "object" || Array.isArray(v)) {
        return {
          answer: answerJson,
          repaired: false,
          expected,
          actualBefore: 0,
        };
      }
      parsed = v as JsonRecord;
    } catch {
      return {
        answer: answerJson,
        repaired: false,
        expected,
        actualBefore: 0,
      };
    }
  } else {
    parsed = { ...answerJson };
  }

  if (expected <= 1) {
    return {
      answer: JSON.stringify(parsed),
      repaired: false,
      expected,
      actualBefore: Array.isArray(parsed.children) ? parsed.children.length : 0,
    };
  }

  const children = Array.isArray(parsed.children)
    ? ([...parsed.children] as unknown[])
    : [];
  const actualBefore = children.length;
  if (actualBefore >= expected) {
    return {
      answer: JSON.stringify(parsed),
      repaired: false,
      expected,
      actualBefore,
    };
  }

  const oral = children.some(
    (c) =>
      c != null &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      (c as JsonRecord).record !== undefined,
  );
  while (children.length < expected) {
    children.push(oral ? emptyOralChild() : emptyObjectiveChild());
  }
  parsed.children = children;
  return {
    answer: JSON.stringify(parsed),
    repaired: true,
    expected,
    actualBefore,
  };
}

/**
 * Build full-paper userData for placement submitAnswer.
 * Every leaf must appear; children are reconciled to paper expected counts.
 */
export function buildPlacementUserData(input: {
  questions: PlacementQuestion[];
  answersByInstanceId: Record<string, string | JsonRecord>;
  context?: string | JsonRecord;
}): PlacementUserDataItem[] {
  const context =
    input.context == null
      ? JSON.stringify({ state: "done" })
      : typeof input.context === "string"
        ? input.context
        : JSON.stringify(input.context);

  return input.questions.map((q) => {
    const raw = input.answersByInstanceId[q.instanceId];
    if (raw == null) {
      throw new Error(
        `buildPlacementUserData: missing answer for instanceId=${q.instanceId}`,
      );
    }
    const reconciled = reconcileAnswerChildren(raw, q.expectedChildren);
    return {
      instanceId: q.instanceId,
      answer: reconciled.answer,
      answerVersion: 1,
      context,
      contextVersion: 1,
    };
  });
}

/**
 * Diagnose why placement submitAnswer may return 4295
 * 「作答小题数存在问题」: missing leaves and/or short children[].
 */
export function diagnosePlacementSubmitCoverage(
  questions: PlacementQuestion[],
  userData: Array<{ instanceId: string; answer: string }>,
): PlacementCoverageDiagnosis {
  const byId = new Map(
    userData.map((u) => [String(u.instanceId), u] as const),
  );
  const qIds = new Set(questions.map((q) => q.instanceId));
  const missingInstanceIds: string[] = [];
  const shortChildren: PlacementCoverageDiagnosis["shortChildren"] = [];

  for (const q of questions) {
    const item = byId.get(q.instanceId);
    if (item == null) {
      missingInstanceIds.push(q.instanceId);
      continue;
    }
    let actual = 0;
    try {
      const parsed = JSON.parse(item.answer) as JsonRecord;
      actual = Array.isArray(parsed.children) ? parsed.children.length : 0;
    } catch {
      actual = 0;
    }
    if (q.expectedChildren > 1 && actual < q.expectedChildren) {
      shortChildren.push({
        instanceId: q.instanceId,
        expected: q.expectedChildren,
        actual,
      });
    }
  }

  const extraInstanceIds = userData
    .map((u) => String(u.instanceId))
    .filter((id) => !qIds.has(id));

  return {
    ok: missingInstanceIds.length === 0 && shortChildren.length === 0,
    missingInstanceIds,
    extraInstanceIds,
    shortChildren,
  };
}
