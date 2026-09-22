import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import { resolveGradeQuestionUrl } from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  okGradeQuestion,
  toolError,
  type GradeQuestionResult,
} from "./result.js";
import { asExactIdString } from "./safe-json.js";

export type GradeQuestionInput = {
  taskId: string;
  /** Exact q_qinstid string — never Number()-coerce snowflakes. */
  questionInstanceId: string;
  /** Answer JSON string (questionContent). */
  questionContent: string;
  ansVersion?: number;
  /**
   * SPA optional flag. Pass false for subjective / oral items when known.
   * Omitted by default (server default applies).
   */
  isObjective?: boolean;
  openId?: string;
};

export type GradeQuestionPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  gradeQuestionUrl?: string;
};

/**
 * 0–100 review numbers. Same mapping as the in-app snapshot:
 * score←overall, smooth←fluency, completed←integrity,
 * correctness←pronunciation, relevance←relevance.
 * Absent fields stay omitted — do not invent 0.
 */
export type EnSentReviewScores = {
  score?: number;
  smooth?: number;
  completed?: number;
  correctness?: number;
  relevance?: number;
};

export type EnSentScoreRecordInput = {
  text: string;
  /** Birdflock ans-prod (or Clio CDN when upload skipped). */
  url: string;
  /** Clio speech-proxy / clio-audios URL (device sample). */
  path?: string;
  /** Usually same as url (birdflock). */
  replayUrl?: string;
  list?: unknown[];
  /**
   * When any finite score is present, the record also gets `recordDetail`
   * and `specific_scores` (app part/submit snapshot). Ratios are score/100.
   */
  reviewScores?: EnSentReviewScores;
  /** recordDetail.details items. Default [] when scores are attached. */
  details?: Array<{ char: string; score: number }>;
};

function finiteScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * App snapshot blocks. `specific_scores.*` are the 0–100 fields divided by 100
 * (98 → total 0.98, 100 → integrity 1). Structural strings stay empty.
 */
export function enSentScoreDetail(
  scores: EnSentReviewScores | undefined,
  audioUrl: string,
  details: Array<{ char: string; score: number }> = [],
): { recordDetail: Record<string, unknown>; specific_scores: Record<string, unknown> } | null {
  const score = finiteScore(scores?.score);
  const smooth = finiteScore(scores?.smooth);
  const completed = finiteScore(scores?.completed);
  const correctness = finiteScore(scores?.correctness);
  const relevance = finiteScore(scores?.relevance);
  if (
    score == null &&
    smooth == null &&
    completed == null &&
    correctness == null &&
    relevance == null
  ) {
    return null;
  }

  const recordDetail: Record<string, unknown> = {
    asrDetail: "",
    audioUrl,
    comment: "",
    details,
    detailsWords: [],
  };
  const specific: Record<string, unknown> = {};
  if (score != null) {
    recordDetail.score = score;
    specific.total = score / 100;
  }
  if (smooth != null) {
    recordDetail.smooth = smooth;
    specific.fluency = smooth / 100;
  }
  if (completed != null) {
    recordDetail.completed = completed;
    specific.integrity = completed / 100;
  }
  if (correctness != null) {
    recordDetail.correctness = correctness;
    specific.accuracy = correctness / 100;
  }
  if (relevance != null) {
    recordDetail.relevance = relevance;
    specific.relevance = relevance / 100;
  }
  return { recordDetail, specific_scores: specific };
}

/**
 * Oral `record` for part/submit and grade questionContent.
 *
 * Always: type / text / url / path? / replayUrl? / list.
 * When `reviewScores` has a finite number, also `recordDetail` / `specific_scores`
 * (in-app voiced snapshot). URL-only records omit those blocks.
 *
 * CDN-url-only `{ record: { url } }` may grade but score stays 0; prefer this
 * EN_SENT_SCORE shape after Clio score + (optional) Qiniu upload.
 */
export function buildEnSentScoreRecord(
  input: EnSentScoreRecordInput,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: "EN_SENT_SCORE",
    text: input.text,
    url: input.url,
    list: Array.isArray(input.list) ? input.list : [],
  };
  const path = input.path?.trim();
  if (path != null && path.length > 0) {
    record.path = path;
  }
  const replayUrl = input.replayUrl?.trim();
  if (replayUrl != null && replayUrl.length > 0) {
    record.replayUrl = replayUrl;
  }
  const detail = enSentScoreDetail(
    input.reviewScores,
    input.url,
    Array.isArray(input.details) ? input.details : [],
  );
  if (detail != null) {
    record.recordDetail = detail.recordDetail;
    record.specific_scores = detail.specific_scores;
  }
  return record;
}

/**
 * questionContent / submit answer JSON.
 * Device sample: `{ children:[{ record, value:[], isDone:true }], value:[] }`
 * — record is under children[0], isDone on the child (not inside record).
 */
export function buildEnSentScoreQuestionContent(
  input: EnSentScoreRecordInput,
): string {
  return JSON.stringify({
    children: [
      {
        record: buildEnSentScoreRecord(input),
        value: [],
        isDone: true,
      },
    ],
    value: [],
  });
}

/**
 * Free-speak (`oral-personal-state`) record — same children shape as EN_SENT_SCORE
 * but `record.type` = **EN_PRED_SCORE** (docs/api-notes.md 自由表达).
 */
export function buildEnPredScoreRecord(
  input: EnSentScoreRecordInput,
): Record<string, unknown> {
  const record = buildEnSentScoreRecord(input);
  record.type = "EN_PRED_SCORE";
  return record;
}

/** questionContent / part/submit answer JSON for 自由表达. */
export function buildEnPredScoreQuestionContent(
  input: EnSentScoreRecordInput,
): string {
  return JSON.stringify({
    children: [
      {
        record: buildEnPredScoreRecord(input),
        value: [],
        isDone: true,
      },
    ],
    value: [],
  });
}

/**
 * Grade one answer via POST /api/uls/rate/gradeQuestion
 * { taskId, questionInstanceId, ansVersion, questionContent, isObjective? }.
 * Auth: raw JWT (no Bearer). questionInstanceId must stay a string end-to-end.
 */
export async function gradeQuestion(
  ports: GradeQuestionPorts,
  input: GradeQuestionInput,
): Promise<GradeQuestionResult> {
  const taskId = asExactIdString(input.taskId) ?? input.taskId.trim();
  if (taskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
  }
  const questionInstanceId =
    asExactIdString(input.questionInstanceId) ??
    String(input.questionInstanceId ?? "").trim();
  if (questionInstanceId.length === 0) {
    return toolError("INVALID_ARGUMENT", "questionInstanceId 不能为空");
  }

  const questionContent =
    typeof input.questionContent === "string"
      ? input.questionContent.trim()
      : "";
  if (questionContent.length === 0) {
    return toolError("INVALID_ARGUMENT", "questionContent 不能为空");
  }

  const ansVersion =
    input.ansVersion != null && Number.isFinite(input.ansVersion)
      ? Number(input.ansVersion)
      : 1;
  if (!(ansVersion > 0)) {
    return toolError("INVALID_ARGUMENT", "ansVersion 必须是正数");
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const url = ports.gradeQuestionUrl ?? resolveGradeQuestionUrl(ports.env);
  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "content-type": "application/json",
  };
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
  }

  const payload: Record<string, unknown> = {
    taskId,
    questionInstanceId,
    ansVersion,
    questionContent,
  };
  if (input.isObjective !== undefined) {
    payload.isObjective = Boolean(input.isObjective);
  }

  const body = JSON.stringify(payload);

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "POST",
      headers,
      body,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `gradeQuestion 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `gradeQuestion 401：${hint}`
        : "gradeQuestion 401：JWT 无效或已过期",
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `gradeQuestion HTTP ${response.statusCode}：${hint}`
        : `gradeQuestion HTTP ${response.statusCode}`,
    );
  }

  const parsed = parseGradeQuestionBody(response.body);
  if (parsed == null) {
    return toolError(
      "PARSE_ERROR",
      "gradeQuestion 响应无法解析为业务成功",
    );
  }

  return okGradeQuestion({
    message: `已评分 taskId=${taskId} instance=${questionInstanceId}`,
    task_id: taskId,
    question_instance_id: questionInstanceId,
    score: parsed.score,
    raw_code: parsed.raw_code,
    raw_value: parsed.raw_value,
  });
}

export function parseGradeQuestionBody(body: string): {
  raw_code: number | null;
  score: number | null;
  raw_value: unknown;
} | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const code = record.code;
  const ok =
    code === 0 ||
    code === 1 ||
    code === 200 ||
    code === "0" ||
    code === "1" ||
    code === "200" ||
    record.success === true;
  if (!ok) {
    return null;
  }
  const raw =
    typeof code === "number"
      ? code
      : typeof code === "string" &&
          code.trim() !== "" &&
          !Number.isNaN(Number(code))
        ? Number(code)
        : null;

  const value = record.value ?? record.data ?? null;
  let score: number | null = null;
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    score = pickScore(v.score ?? v.totalScore ?? v.grade ?? v.point);
  } else {
    score = pickScore(value);
  }

  return { raw_code: raw, score, raw_value: value };
}

function pickScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
