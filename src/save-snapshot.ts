import type { AuthPorts } from "./auth.js";
import { resolveSaveSnapshotUrl, resolveUAppId } from "./config.js";
import {
  okSaveSnapshot,
  toolError,
  type SaveSnapshotResult,
} from "./result.js";
import { asExactIdString } from "./safe-json.js";
import {
  numericCode,
  parseBusinessBody,
  ulsAuthedJsonRequest,
  ulsCloudHeaders,
} from "./uls-business.js";

/**
 * POST /api/uls/user/saveSnapshot — 听力卷内口语位落快照（#28 / #27 S5）.
 *
 * Listening Post-listening oral fill / read-aloud does **not** use submitAnswer
 * or part/submit. After query-upload-url + in-app SOE, the app posts saveSnapshot
 * then gradeQuestion. Business success code=1.
 *
 * Body: { ansVersion, duration, taskId, token, userData }.
 * Headers: raw JWT + sourceid/u-app-id 116 + x-requested-with: cn.unipus.cloud.
 * Keep large ids as strings (never Number() snowflakes).
 */

export type SaveSnapshotUserItem = {
  instanceId: string;
  /** Answer JSON string or object (stringified). Often contains EN_PRED_SCORE / EN_SENT_REC. */
  answer: string | Record<string, unknown>;
  answerVersion?: number;
  context?: string | Record<string, unknown>;
  contextVersion?: number;
};

export type SaveSnapshotInput = {
  taskId: string;
  /** loadPaper / start_listening_training paper token. */
  paperToken: string;
  ansVersion?: number;
  durationSec?: number;
  userData: SaveSnapshotUserItem[];
  openId?: string;
};

export type SaveSnapshotPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  saveSnapshotUrl?: string;
};

/** Exported for unit tests. */
export function isSaveSnapshotSuccessCode(value: unknown): boolean {
  return numericCode(value) === 1;
}

/** Exported for unit tests — thin wrapper over shared parse helper. */
export function parseSaveSnapshotBody(
  body: string,
): { data: unknown; raw_code: number | null } | null {
  const parsed = parseBusinessBody(body, {
    successCode: 1,
    dataKeys: ["value", "data"],
  });
  if (!parsed.ok) {
    return null;
  }
  return { data: parsed.data, raw_code: parsed.raw_code };
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? Number(value) : fallback;
}

function asJsonOrString(value: string | Record<string, unknown>): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normalizeContext(
  context: string | Record<string, unknown> | undefined,
): string {
  if (context == null) {
    return JSON.stringify({ state: "done" });
  }
  return asJsonOrString(context);
}

/**
 * Build the wire body for saveSnapshot.
 * Callers must validate IDs first (asExactIdString); never String(number).
 */
export function buildSaveSnapshotBody(input: {
  taskId: string;
  paperToken: string;
  ansVersion?: number;
  durationSec?: number;
  userData: SaveSnapshotUserItem[];
}): Record<string, unknown> {
  const taskId = asExactIdString(input.taskId) ?? "";
  const token = input.paperToken.trim();
  const ansVersion = finiteOrDefault(input.ansVersion, 1);
  const duration = Math.max(0, finiteOrDefault(input.durationSec, 1));

  const userData = input.userData.map((item) => ({
    instanceId: asExactIdString(item.instanceId) ?? "",
    answer: asJsonOrString(item.answer),
    answerVersion: finiteOrDefault(item.answerVersion, 1),
    context: normalizeContext(item.context),
    contextVersion: finiteOrDefault(item.contextVersion, 1),
  }));

  return {
    taskId,
    ansVersion,
    token,
    duration,
    userData,
  };
}

export async function saveSnapshot(
  ports: SaveSnapshotPorts,
  input: SaveSnapshotInput,
): Promise<SaveSnapshotResult> {
  const taskId = asExactIdString(input.taskId);
  if (taskId == null) {
    return toolError(
      "INVALID_ARGUMENT",
      "taskId 不能为空或无法安全解析为精确 id",
    );
  }
  const paperToken = input.paperToken.trim();
  if (paperToken.length === 0) {
    return toolError(
      "INVALID_ARGUMENT",
      "paperToken 不能为空（来自 loadPaper / start_listening_training）",
    );
  }
  if (!Array.isArray(input.userData) || input.userData.length === 0) {
    return toolError("INVALID_ARGUMENT", "userData 不能为空");
  }

  const ansVersion = finiteOrDefault(input.ansVersion, 1);
  if (!(ansVersion > 0)) {
    return toolError("INVALID_ARGUMENT", "ansVersion 必须是正数");
  }

  const instanceIds: string[] = [];
  for (const item of input.userData) {
    const instanceId = asExactIdString(item.instanceId);
    if (instanceId == null) {
      return toolError(
        "INVALID_ARGUMENT",
        "userData.instanceId 不能为空或无法安全解析为精确 id",
      );
    }
    instanceIds.push(instanceId);
  }

  const url = ports.saveSnapshotUrl ?? resolveSaveSnapshotUrl(ports.env);
  const body = buildSaveSnapshotBody({
    taskId,
    paperToken,
    ansVersion: input.ansVersion,
    durationSec: input.durationSec,
    userData: input.userData,
  });

  const response = await ulsAuthedJsonRequest(ports, {
    label: "saveSnapshot",
    url,
    method: "POST",
    headers: (jwt) => {
      const headers = ulsCloudHeaders(jwt, ports.env, input.openId);
      headers["u-app-id"] = resolveUAppId(ports.env);
      return headers;
    },
    jsonBody: body,
    successCode: 1,
    dataKeys: ["value", "data"],
  });
  if (!response.ok) {
    return response.result;
  }

  return okSaveSnapshot({
    message: `已保存快照 taskId=${taskId} instances=${instanceIds.length}`,
    task_id: taskId,
    instance_id: instanceIds.join(","),
    raw_code: response.raw_code,
  });
}
