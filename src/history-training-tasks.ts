/**
 * App 「历史训练」list + report/checkStatus.
 *
 * Capture (2026-10-14): App shows a number iff getHistoryTrainingTasks item
 * has scoreIsOut===true. answerStatus and trainingScoreReport do NOT decide UI.
 * scoreIsOut=true ↔ report/checkStatus value===3 ↔ all parts submitted+completed.
 */
import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import {
  resolveHistoryTrainingTasksUrl,
  resolveReportCheckStatusUrl,
  resolveUAppId,
} from "./config.js";
import { summarizeHttpErrorBody } from "./http.js";
import {
  authRequired,
  toolError,
  type ToolResult,
} from "./result.js";
import {
  asExactIdString,
  parseJsonPreservingLargeInts,
} from "./safe-json.js";

export type HistoryFlowType = "speak" | "listen";

export type HistoryTrainingTask = {
  taskId: string;
  taskStudentId?: string;
  ansVersion?: number;
  paperTitle?: string;
  score?: number;
  answerStatus?: number;
  scoreIsOut: boolean;
  countScore?: boolean;
};

export type HistoryTrainingPage = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  list: HistoryTrainingTask[];
};

export type HistoryTrainingTasksPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  historyTrainingTasksUrl?: string;
  reportCheckStatusUrl?: string;
};

export type GetHistoryTrainingTasksResult = ToolResult & {
  page?: HistoryTrainingPage;
  raw_code?: number | null;
};

export type FindHistoryTrainingTaskResult = ToolResult & {
  task?: HistoryTrainingTask | null;
  pages_scanned?: number;
  raw_code?: number | null;
};

export type CheckReportStatusResult = ToolResult & {
  /** 2 = 评分中, 3 = 已出分 (App scoreIsOut). */
  check_status?: number | null;
  task_id?: string;
  ans_version?: number;
  raw_code?: number | null;
};

function parseHistoryTask(raw: unknown): HistoryTrainingTask | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const taskId = asExactIdString(rec.taskId) ?? String(rec.taskId ?? "").trim();
  if (taskId.length === 0) return null;
  return {
    taskId,
    taskStudentId:
      asExactIdString(rec.taskStudentId) ??
      (rec.taskStudentId != null ? String(rec.taskStudentId) : undefined),
    ansVersion:
      typeof rec.ansVersion === "number" && Number.isFinite(rec.ansVersion)
        ? rec.ansVersion
        : undefined,
    paperTitle: typeof rec.paperTitle === "string" ? rec.paperTitle : undefined,
    score: typeof rec.score === "number" && Number.isFinite(rec.score) ? rec.score : undefined,
    answerStatus:
      typeof rec.answerStatus === "number" && Number.isFinite(rec.answerStatus)
        ? rec.answerStatus
        : undefined,
    scoreIsOut: rec.scoreIsOut === true,
    countScore: typeof rec.countScore === "boolean" ? rec.countScore : undefined,
  };
}

/** Parse value from getHistoryTrainingTasks (code=1). */
export function parseHistoryTrainingPage(value: unknown): HistoryTrainingPage | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const root = value as Record<string, unknown>;
  const listRaw = Array.isArray(root.list) ? root.list : null;
  if (listRaw == null) return null;
  const list: HistoryTrainingTask[] = [];
  for (const item of listRaw) {
    const parsed = parseHistoryTask(item);
    if (parsed != null) list.push(parsed);
  }
  const page = typeof root.page === "number" && Number.isFinite(root.page) ? root.page : 1;
  const pageSize =
    typeof root.pageSize === "number" && Number.isFinite(root.pageSize)
      ? root.pageSize
      : list.length;
  const total =
    typeof root.total === "number" && Number.isFinite(root.total)
      ? root.total
      : list.length;
  const totalPages =
    typeof root.totalPages === "number" && Number.isFinite(root.totalPages)
      ? root.totalPages
      : Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return { page, pageSize, total, totalPages, list };
}

/**
 * POST /api/uls/user/getHistoryTrainingTasks
 * body { pageSize, page, flowType: "speak"|"listen" } on ucloud.
 */
export async function getHistoryTrainingTasks(
  ports: HistoryTrainingTasksPorts,
  input: {
    flowType?: HistoryFlowType;
    page?: number;
    pageSize?: number;
    openId?: string;
  } = {},
): Promise<GetHistoryTrainingTasksResult> {
  const flowType: HistoryFlowType = input.flowType === "listen" ? "listen" : "speak";
  const page = input.page != null && Number.isFinite(input.page) ? Math.max(1, Math.floor(input.page)) : 1;
  const pageSize =
    input.pageSize != null && Number.isFinite(input.pageSize)
      ? Math.max(1, Math.min(50, Math.floor(input.pageSize)))
      : 20;

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) {
    return loaded.result;
  }

  const url =
    ports.historyTrainingTasksUrl ?? resolveHistoryTrainingTasksUrl(ports.env);
  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "content-type": "application/json",
    "u-app-id": resolveUAppId(ports.env),
    "u-app-type": resolveUAppId(ports.env),
  };
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
    headers["u-openid"] = openId;
  }

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "POST",
      headers,
      body: JSON.stringify({ pageSize, page, flowType }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `getHistoryTrainingTasks 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `getHistoryTrainingTasks 401：${hint}`
        : "getHistoryTrainingTasks 401：JWT 无效或已过期",
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `getHistoryTrainingTasks HTTP ${response.statusCode}：${hint}`
        : `getHistoryTrainingTasks HTTP ${response.statusCode}`,
    );
  }

  let root: Record<string, unknown>;
  try {
    const parsed = parseJsonPreservingLargeInts(response.body);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return toolError("PARSE_ERROR", "getHistoryTrainingTasks 响应无法解析");
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return toolError("PARSE_ERROR", "getHistoryTrainingTasks 响应无法解析");
  }

  const code = root.code;
  const rawCode =
    typeof code === "number" && Number.isFinite(code)
      ? code
      : typeof code === "string" && Number.isFinite(Number(code))
        ? Number(code)
        : null;
  if (rawCode !== 1) {
    const msg = typeof root.msg === "string" ? root.msg : undefined;
    return toolError(
      "BUSINESS_ERROR",
      `getHistoryTrainingTasks 业务码 ${rawCode}${msg != null ? `：${msg}` : "（需 code=1）"}`,
    );
  }

  const pageData = parseHistoryTrainingPage(root.value);
  if (pageData == null) {
    return toolError("PARSE_ERROR", "getHistoryTrainingTasks value 无法解析为列表页");
  }

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `getHistoryTrainingTasks ${flowType} page=${pageData.page}/${pageData.totalPages} n=${pageData.list.length}`,
    page: pageData,
    raw_code: rawCode,
  };
}

/**
 * Find one task across pages (newest first). Caps pages scanned.
 */
export async function findHistoryTrainingTask(
  ports: HistoryTrainingTasksPorts,
  input: {
    taskId: string;
    flowType?: HistoryFlowType;
    pageSize?: number;
    /** Max pages to scan (default 5). */
    maxPages?: number;
    openId?: string;
  },
): Promise<FindHistoryTrainingTaskResult> {
  const want =
    asExactIdString(input.taskId) ?? String(input.taskId ?? "").trim();
  if (want.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
  }
  const maxPages = Math.max(1, Math.min(20, input.maxPages ?? 5));
  let pagesScanned = 0;
  let totalPages = 1;
  let lastCode: number | null = null;

  for (let page = 1; page <= Math.min(maxPages, totalPages); page++) {
    const res = await getHistoryTrainingTasks(ports, {
      flowType: input.flowType,
      page,
      pageSize: input.pageSize,
      openId: input.openId,
    });
    pagesScanned += 1;
    if (res.isError || res.page == null) {
      return res;
    }
    lastCode = res.raw_code ?? lastCode;
    totalPages = Math.max(1, res.page.totalPages);
    const hit = res.page.list.find((t) => t.taskId === want);
    if (hit != null) {
      return {
        isError: false,
        status: "ok",
        code: "OK",
        message: `found taskId=${want} scoreIsOut=${hit.scoreIsOut} score=${hit.score ?? "?"}`,
        task: hit,
        pages_scanned: pagesScanned,
        raw_code: lastCode,
      };
    }
  }

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `taskId=${want} 未在前 ${pagesScanned} 页历史中找到`,
    task: null,
    pages_scanned: pagesScanned,
    raw_code: lastCode,
  };
}

/**
 * POST /api/uls/report/checkStatus { taskId, ansVersion } on adaptive.
 * value 2 = 评分中, 3 = 已出分.
 */
export async function checkReportStatus(
  ports: HistoryTrainingTasksPorts,
  input: { taskId: string; ansVersion?: number; openId?: string },
): Promise<CheckReportStatusResult> {
  const taskId =
    asExactIdString(input.taskId) ?? String(input.taskId ?? "").trim();
  if (taskId.length === 0) {
    return toolError("INVALID_ARGUMENT", "taskId 不能为空");
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

  const url =
    ports.reportCheckStatusUrl ?? resolveReportCheckStatusUrl(ports.env);
  const headers: Record<string, string> = {
    authorization: loaded.jwt,
    "content-type": "application/json",
    "u-app-id": resolveUAppId(ports.env),
  };
  const openId = input.openId?.trim();
  if (openId != null && openId.length > 0) {
    headers.openId = openId;
  }

  let response: { statusCode: number; body: string };
  try {
    response = await ports.http.request({
      url,
      method: "POST",
      headers,
      body: JSON.stringify({ taskId, ansVersion }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return toolError("NETWORK_ERROR", `report/checkStatus 网络失败：${detail}`);
  }

  if (response.statusCode === 401) {
    const hint = summarizeHttpErrorBody(response.body);
    return authRequired(
      hint != null
        ? `report/checkStatus 401：${hint}`
        : "report/checkStatus 401：JWT 无效或已过期",
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(response.body);
    return toolError(
      "HTTP_ERROR",
      hint != null
        ? `report/checkStatus HTTP ${response.statusCode}：${hint}`
        : `report/checkStatus HTTP ${response.statusCode}`,
    );
  }

  let root: Record<string, unknown>;
  try {
    const parsed = parseJsonPreservingLargeInts(response.body);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return toolError("PARSE_ERROR", "report/checkStatus 响应无法解析");
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return toolError("PARSE_ERROR", "report/checkStatus 响应无法解析");
  }

  const code = root.code;
  const rawCode =
    typeof code === "number" && Number.isFinite(code)
      ? code
      : typeof code === "string" && Number.isFinite(Number(code))
        ? Number(code)
        : null;
  if (rawCode !== 1) {
    const msg = typeof root.msg === "string" ? root.msg : undefined;
    return toolError(
      "BUSINESS_ERROR",
      `report/checkStatus 业务码 ${rawCode}${msg != null ? `：${msg}` : "（需 code=1）"}`,
    );
  }

  const checkStatus =
    typeof root.value === "number" && Number.isFinite(root.value)
      ? root.value
      : null;

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `report/checkStatus=${checkStatus}`,
    check_status: checkStatus,
    task_id: taskId,
    ans_version: ansVersion,
    raw_code: rawCode,
  };
}

export type TrainingResult = ToolResult & {
  task_id?: string;
  state?: "not_found" | "scoring" | "ready";
  score?: number | null;
  score_is_out?: boolean;
  check_status?: number | null;
  next_action?: "check_training_result";
};

/** Read-only verification. An accepted submission alone never means ready. */
export async function getTrainingResult(
  ports: HistoryTrainingTasksPorts,
  input: { taskId: string; flowType?: HistoryFlowType; ansVersion?: number },
): Promise<TrainingResult> {
  const found = await findHistoryTrainingTask(ports, input);
  if (found.isError) return found;
  if (!found.task) return {
    isError: false, status: "ok", code: "TASK_NOT_FOUND",
    message: "Task not found in the most recent 100 history entries",
    task_id: input.taskId, state: "not_found", score: null,
    next_action: "check_training_result",
  };
  const task = found.task;
  const check = await checkReportStatus(ports, {
    taskId: task.taskId, ansVersion: input.ansVersion ?? task.ansVersion ?? 1,
  });
  if (check.isError) return { ...check, task_id: task.taskId };
  const ready = task.scoreIsOut && check.check_status === 3 && task.score != null;
  return {
    isError: false, status: "ok", code: ready ? "OK" : "GRADING_PENDING",
    message: ready ? "Platform history score and report readiness verified" : "Submitted task is still awaiting a complete platform result; check again",
    task_id: task.taskId, state: ready ? "ready" : "scoring",
    score: ready ? task.score! : null,
    score_is_out: task.scoreIsOut, check_status: check.check_status,
    ...(!ready ? { next_action: "check_training_result" as const } : {}),
  };
}
