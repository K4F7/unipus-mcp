/**
 * File handoff for the agent already running the harness. No HTTP bridge,
 * credentials, or live WebSocket state in the queue.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AnswerAsk } from "./choice-solver.js";
import type { NextAction } from "./result.js";

export type AgentAnswerRequest = {
  version: 1;
  request_id: string;
  created_at: string;
  prompt: string;
  /** Same question shares one agent. Absent on requests written before grouping. */
  group_id?: string;
};

export type AgentAnswerAction = Extract<NextAction, { type: "answer_request" | "answer_batch" }>;

const GROUP_ID = /^[^\s/\\]{1,200}$/;

export function answerGroupId(taskId: string, instanceId: string): string {
  const groupId = `${taskId}:${instanceId}`;
  if (!GROUP_ID.test(groupId)) throw new Error("Invalid answer group_id");
  return groupId;
}

export class AgentAnswerRequiredError extends Error {
  readonly code = "AGENT_ANSWER_REQUIRED";
  constructor(readonly action: AgentAnswerAction) {
    const what = action.type === "answer_batch"
      ? `${action.groups.length} answer groups`
      : `answer request ${action.request_id}`;
    super(`AGENT_ANSWER_REQUIRED: ${what} in ${action.queue_dir}, then resume`);
  }
}

export function resolveAgentAnswerDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.UNIPUS_AGENT_ANSWER_DIR?.trim();
  if (!dir) return null;
  if (!isAbsolute(dir)) throw new Error("UNIPUS_AGENT_ANSWER_DIR must be an absolute path");
  return dir;
}

export function answerRequestId(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function validateId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid answer request_id (expected SHA-256)");
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(dir: string, name: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, join(dir, name));
  } finally {
    await rm(tmp, { force: true });
  }
}

function optionalGroupId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !GROUP_ID.test(value)) {
    throw new Error("Invalid answer group_id");
  }
  return value;
}

async function readRequest(dir: string, id: string): Promise<AgentAnswerRequest> {
  validateId(id);
  const raw = await readJson(join(dir, `${id}.request.json`)) as Partial<AgentAnswerRequest> | null;
  if (raw?.version !== 1 || raw.request_id !== id || typeof raw.prompt !== "string"
    || answerRequestId(raw.prompt) !== id || typeof raw.created_at !== "string") {
    throw new Error(`Answer request missing or invalid: ${id}`);
  }
  let groupId: string | undefined;
  try {
    groupId = optionalGroupId(raw.group_id);
  } catch {
    throw new Error(`Answer request missing or invalid: ${id}`);
  }
  return {
    version: 1,
    request_id: id,
    created_at: raw.created_at,
    prompt: raw.prompt,
    ...(groupId ? { group_id: groupId } : {}),
  };
}

async function ensureRequest(dir: string, prompt: string, groupId?: string): Promise<string> {
  const id = answerRequestId(prompt);
  const path = join(dir, `${id}.request.json`);
  if (await readJson(path) == null) {
    const group_id = optionalGroupId(groupId);
    await atomicJson(dir, `${id}.request.json`, {
      version: 1,
      request_id: id,
      created_at: new Date().toISOString(),
      prompt,
      ...(group_id ? { group_id } : {}),
    } satisfies AgentAnswerRequest);
  }
  await readRequest(dir, id);
  return id;
}

function groupPending(
  jobs: Array<{ groupId: string }>,
  ids: string[],
  pending: number[],
): Array<{ group_id: string; request_ids: string[] }> {
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const index of pending) {
    const groupId = jobs[index]!.groupId;
    const list = grouped.get(groupId);
    if (list) list.push(ids[index]!);
    else {
      grouped.set(groupId, [ids[index]!]);
      order.push(groupId);
    }
  }
  return order.map((group_id) => ({ group_id, request_ids: grouped.get(group_id)! }));
}

/** Wait settings from UNIPUS_AGENT_ANSWER_WAIT_MS. Omitted env keeps the 10 minute default. */
export function agentAnswerWait(env?: NodeJS.ProcessEnv): { waitMs?: number } {
  const raw = env?.UNIPUS_AGENT_ANSWER_WAIT_MS;
  if (raw == null || raw.trim() === "") return {};
  return { waitMs: Number(raw) };
}

async function readResponse(dir: string, id: string): Promise<string | null> {
  const raw = await readJson(join(dir, `${id}.response.json`)) as {
    request_id?: unknown; response?: unknown;
  } | null;
  if (raw == null) return null;
  if (raw.request_id !== id || typeof raw.response !== "string" || !raw.response.trim()) {
    throw new Error(`Invalid response for answer request ${id}; replace it using answers reply`);
  }
  return raw.response;
}

/** List prompts only. An answered request remains available for repair/replay. */
export async function listAgentAnswerRequests(
  dir: string,
  options: { includeAnswered?: boolean; limit?: number } = {},
): Promise<Array<AgentAnswerRequest & { status: "pending" | "answered" }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: Array<AgentAnswerRequest & { status: "pending" | "answered" }> = [];
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.request\.json$/.exec(name);
    if (!match) continue;
    const request = await readRequest(dir, match[1]!);
    const answered = await readResponse(dir, request.request_id) != null;
    if (answered && !options.includeAnswered) continue;
    results.push({ ...request, status: answered ? "answered" : "pending" });
  }
  return results.sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, Math.max(1, Math.min(100, options.limit ?? 20)));
}

/** Atomic reply publication: a running harness never reads half-written text. */
export async function replyToAgentAnswerRequest(dir: string, id: string, response: string): Promise<void> {
  await readRequest(dir, id);
  if (!response.trim() || response.length > 100_000) {
    throw new Error("Answer response must contain 1–100000 characters");
  }
  await atomicJson(dir, `${id}.response.json`, {
    request_id: id, response, answered_at: new Date().toISOString(),
  });
}

function assertWait(waitMs: number, pollMs: number): void {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new Error("Agent answer wait/poll milliseconds must be non-negative/positive integers");
  }
}

async function pollResponses(
  dir: string,
  ids: string[],
  pending: number[],
  responses: Array<string | null>,
  waitMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  await Promise.all(pending.map(async (index) => {
    let response = responses[index] ?? null;
    while (response == null && Date.now() < deadline) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
      response = await readResponse(dir, ids[index]!);
    }
    responses[index] = response;
  }));
}

/**
 * Write every request, then emit one answer_batch for the groups that still
 * need an answer, then poll those requests together. Already-answered prompts
 * replay and are left out of the event.
 */
export async function publishAndWaitAnswers(
  dir: string,
  jobs: Array<{ prompt: string; groupId: string }>,
  options: {
    waitMs?: number;
    pollMs?: number;
    onBatch?: (action: Extract<AgentAnswerAction, { type: "answer_batch" }>) => void | Promise<void>;
  } = {},
): Promise<string[]> {
  const waitMs = options.waitMs ?? 600_000;
  const pollMs = options.pollMs ?? 250;
  if (!isAbsolute(dir)) throw new Error("Agent answer directory must be absolute");
  assertWait(waitMs, pollMs);
  if (jobs.length === 0) return [];
  for (const job of jobs) optionalGroupId(job.groupId);
  const ids: string[] = [];
  for (const job of jobs) ids.push(await ensureRequest(dir, job.prompt, job.groupId));
  const responses: Array<string | null> = [];
  const pending: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const response = await readResponse(dir, ids[i]!);
    responses.push(response);
    if (response == null) pending.push(i);
  }
  if (pending.length === 0) return responses as string[];
  const action = {
    type: "answer_batch" as const,
    queue_dir: dir,
    groups: groupPending(jobs, ids, pending),
  };
  if (options.onBatch) await options.onBatch(action);
  else console.error(JSON.stringify({ event: "answer_batch", ...action }));
  if (waitMs === 0) throw new AgentAnswerRequiredError(action);
  await pollResponses(dir, ids, pending, responses, waitMs, pollMs);
  if (responses.some((response) => response == null)) {
    throw new AgentAnswerRequiredError({
      type: "answer_batch",
      queue_dir: dir,
      groups: groupPending(jobs, ids, pending.filter((index) => responses[index] == null)),
    });
  }
  return responses as string[];
}

/** Same prompt → same id. One prompt emits answer_required. Replies replay after an interrupted run. */
export function createAgentAsk(
  dir: string,
  options: {
    waitMs?: number;
    pollMs?: number;
    onRequest?: (action: Extract<AgentAnswerAction, { type: "answer_request" }>) => void;
  } = {},
): AnswerAsk {
  const waitMs = options.waitMs ?? 600_000;
  const pollMs = options.pollMs ?? 250;
  if (!isAbsolute(dir)) throw new Error("Agent answer directory must be absolute");
  assertWait(waitMs, pollMs);
  return async (prompt, context) => {
    const groupId = optionalGroupId(context?.groupId);
    const id = await ensureRequest(dir, prompt, groupId);
    const action = {
      type: "answer_request" as const,
      request_id: id,
      queue_dir: dir,
      ...(groupId ? { group_id: groupId } : {}),
    };
    let response = await readResponse(dir, id);
    if (response != null) return response;
    if (options.onRequest) options.onRequest(action);
    else console.error(JSON.stringify({ event: "answer_required", ...action }));
    const responses = [response];
    if (waitMs === 0) throw new AgentAnswerRequiredError(action);
    await pollResponses(dir, [id], [0], responses, waitMs, pollMs);
    response = responses[0] ?? null;
    if (response == null) throw new AgentAnswerRequiredError(action);
    return response;
  };
}
