/**
 * File handoff for the agent already running the harness. No HTTP bridge,
 * second LLM key, credentials, or live WebSocket state in the queue.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LlmAsk } from "./choice-solver.js";
import type { NextAction } from "./result.js";

export type AgentAnswerRequest = {
  version: 1;
  request_id: string;
  created_at: string;
  prompt: string;
};

export type AgentAnswerAction = Extract<NextAction, { type: "answer_request" }>;

export class AgentAnswerRequiredError extends Error {
  readonly code = "AGENT_ANSWER_REQUIRED";
  constructor(readonly action: AgentAnswerAction) {
    super(`AGENT_ANSWER_REQUIRED: answer request ${action.request_id} in ${action.queue_dir}, then resume`);
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

async function readRequest(dir: string, id: string): Promise<AgentAnswerRequest> {
  validateId(id);
  const raw = await readJson(join(dir, `${id}.request.json`)) as Partial<AgentAnswerRequest> | null;
  if (raw?.version !== 1 || raw.request_id !== id || typeof raw.prompt !== "string"
    || answerRequestId(raw.prompt) !== id || typeof raw.created_at !== "string") {
    throw new Error(`Answer request missing or invalid: ${id}`);
  }
  return raw as AgentAnswerRequest;
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

/** Same prompt → same id. Replies can be reused after an interrupted run. */
export function createAgentAsk(
  dir: string,
  options: {
    waitMs?: number;
    pollMs?: number;
    onRequest?: (action: AgentAnswerAction) => void;
  } = {},
): LlmAsk {
  const waitMs = options.waitMs ?? 600_000;
  const pollMs = options.pollMs ?? 250;
  if (!isAbsolute(dir)) throw new Error("Agent answer directory must be absolute");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || !Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new Error("Agent answer wait/poll milliseconds must be non-negative/positive integers");
  }
  return async (prompt) => {
    const id = answerRequestId(prompt);
    const path = join(dir, `${id}.request.json`);
    if (await readJson(path) == null) {
      await atomicJson(dir, `${id}.request.json`, {
        version: 1, request_id: id, created_at: new Date().toISOString(), prompt,
      } satisfies AgentAnswerRequest);
    }
    await readRequest(dir, id);
    const action: AgentAnswerAction = { type: "answer_request", request_id: id, queue_dir: dir };
    let response = await readResponse(dir, id);
    if (response != null) return response;
    if (options.onRequest) options.onRequest(action);
    else console.error(JSON.stringify({ event: "answer_required", ...action }));
    const deadline = Date.now() + waitMs;
    while (response == null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
      response = await readResponse(dir, id);
    }
    if (response == null) throw new AgentAnswerRequiredError(action);
    return response;
  };
}
