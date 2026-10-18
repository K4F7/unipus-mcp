import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AgentAnswerRequiredError, answerRequestId, createAgentAsk, listAgentAnswerRequests,
  publishAndWaitAnswers, replyToAgentAnswerRequest, resolveAgentAnswerDir,
} from "../src/agent-answers.js";
import { buildSolvedObjectiveAnswer, resolveConfiguredAsk } from "../src/choice-solver.js";
import { completeOneListen } from "../src/grind-listen.js";
import { generateFreeTalk } from "../src/speak-content.js";
import { createUnipusMcpServer } from "../src/server.js";
import { mockHttp } from "./mock-http.js";

test("agent handoff survives exit, preserves exact prompt, replays and repairs replies", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompt = 'Task:\nKeep punctuation, quotes "and newlines".';
  const ask = createAgentAsk(dir, { waitMs: 0, onRequest: () => {} });
  await assert.rejects(ask(prompt), AgentAnswerRequiredError);
  const pending = await listAgentAnswerRequests(dir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.prompt, prompt);
  const id = answerRequestId(prompt);
  assert.equal(pending[0]!.request_id, id);
  assert.equal((await stat(join(dir, `${id}.request.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await replyToAgentAnswerRequest(dir, id, '{"answers":["B"]}');
  assert.equal(await ask(prompt), '{"answers":["B"]}');
  assert.equal((await listAgentAnswerRequests(dir)).length, 0);
  assert.equal((await listAgentAnswerRequests(dir, { includeAnswered: true }))[0]!.status, "answered");
  await replyToAgentAnswerRequest(dir, id, '{"answers":["A"]}');
  assert.equal(await ask(prompt), '{"answers":["A"]}');
  assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false);
});

test("waiting harness resumes on an atomic response without an HTTP server", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-live-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requested!: () => void;
  const ready = new Promise<void>((resolve) => { requested = resolve; });
  const prompt = "A dialogue reply";
  const result = createAgentAsk(dir, { waitMs: 2000, pollMs: 5, onRequest: requested })(prompt);
  await ready;
  await replyToAgentAnswerRequest(dir, answerRequestId(prompt), "Here is my answer.");
  assert.equal(await result, "Here is my answer.");
});

test("queue blocks once instead of spending three solver retries or falling back to a template", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const ask = createAgentAsk(dir, { waitMs: 0, onRequest: () => { requests++; } });
  await assert.rejects(buildSolvedObjectiveAnswer({
    options: [{ value: "A", text: "alpha" }],
  }, ask), AgentAnswerRequiredError);
  assert.equal(requests, 1);
  await assert.rejects(generateFreeTalk("Talk about music", { ask }), AgentAnswerRequiredError);
  assert.equal(requests, 2);
});

test("agent queue is the only answer source and rejects unsafe request paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ask = resolveConfiguredAsk({
    UNIPUS_AGENT_ANSWER_DIR: dir, UNIPUS_AGENT_ANSWER_WAIT_MS: "0",
    UNIPUS_LLM_API_KEY: "unused",
  })!;
  await assert.rejects(ask("Prompt"), AgentAnswerRequiredError);
  await assert.rejects(replyToAgentAnswerRequest(dir, "../../outside", "text"), /Invalid/);
  await assert.rejects(replyToAgentAnswerRequest(dir, "0".repeat(64), "text"), /missing/);
  await assert.rejects(replyToAgentAnswerRequest(dir, answerRequestId("Prompt"), " "), /characters/);
  assert.throws(() => resolveAgentAnswerDir({ UNIPUS_AGENT_ANSWER_DIR: "relative" }), /absolute/);
  assert.throws(() => resolveConfiguredAsk({ UNIPUS_AGENT_ANSWER_DIR: dir, UNIPUS_AGENT_ANSWER_WAIT_MS: "NaN" }), /milliseconds/);
});

test("MCP handoff: pending listening paper → agent response → exact answer submitted once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { UNIPUS_AGENT_ANSWER_DIR: dir, UNIPUS_AGENT_ANSWER_WAIT_MS: "0" };
  const http = mockHttp(async (call) => {
    const value = call.url.includes("getUserStatus")
      ? { type: "train", taskId: "100000000000000001", ansVersion: 1 }
      : call.url.includes("loadPaper")
        ? { token: "paper-token", paperJson: JSON.stringify([{
          q_qinstid: "1985995334422880257", q_template_name: "single-choice", is_objective: true,
          data: { contents: [{ text: "The answer is beta." }], options: [
            { value: "A", text: "alpha" }, { value: "B", text: "beta" },
          ] },
        }]) }
        : {};
    return { statusCode: 200, body: JSON.stringify({ code: 1, value }) };
  });
  const ports = { credentials: { getJwt: async () => "private-jwt" }, http, env };
  const first = await completeOneListen(ports);
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.equal(first.nextAction?.type, "answer_batch");
    if (first.nextAction?.type === "answer_batch") {
      assert.equal(first.nextAction.groups.length, 1);
      assert.equal(first.nextAction.groups[0]!.group_id, "100000000000000001:1985995334422880257");
    }
  }
  assert.equal(http.calls.filter((c) => c.url.includes("submitAnswer")).length, 0);
  const server = createUnipusMcpServer(ports);
  const client = new Client({ name: "agent-handoff-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const listed = await client.callTool({ name: "list_answer_requests", arguments: {} });
    const data = listed.structuredContent as { requests: Array<{ request_id: string; prompt: string }> };
    assert.equal(data.requests.length, 1);
    assert.match(data.requests[0]!.prompt, /answer is beta/);
    assert.equal(JSON.stringify(data).includes("private-jwt"), false);
    assert.equal(JSON.stringify(data).includes("paper-token"), false);
    const saved = await client.callTool({
      name: "answer_request",
      arguments: { request_id: data.requests[0]!.request_id, response: '{"answers":["B"]}' },
    });
    assert.equal(saved.isError, false);
    const second = await completeOneListen(ports);
    assert.equal(second.ok, true);
    const submissions = http.calls.filter((c) => c.url.includes("submitAnswer"));
    assert.equal(submissions.length, 1);
    const body = JSON.parse(submissions[0]!.body!);
    assert.equal(body.userData[0].instanceId, "1985995334422880257");
    assert.equal(JSON.parse(body.userData[0].answer).children[0].value[0], "B");
    const files = await readdir(dir);
    const contents = await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")));
    assert.equal(contents.join("").includes("private-jwt"), false);
    assert.equal(contents.join("").includes("paper-token"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("different questions are published together before any reply", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-batch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pending = publishAndWaitAnswers(dir, [
    { prompt: "leaf one", groupId: "task:a" },
    { prompt: "leaf two", groupId: "task:b" },
  ], {
    waitMs: 2000,
    pollMs: 5,
    onBatch: async (action) => {
      const names = await readdir(dir);
      assert.deepEqual(names.filter((name) => name.endsWith(".request.json")).length, 2);
      assert.equal(names.some((name) => name.includes("response")), false);
      assert.equal(action.groups.length, 2);
      assert.deepEqual(action.groups.map((group) => group.group_id), ["task:a", "task:b"]);
      const stored = JSON.parse(await readFile(join(dir, `${answerRequestId("leaf one")}.request.json`), "utf8")) as { group_id?: string };
      assert.equal(stored.group_id, "task:a");
      await replyToAgentAnswerRequest(dir, answerRequestId("leaf one"), "one");
      await replyToAgentAnswerRequest(dir, answerRequestId("leaf two"), "two");
    },
  });
  assert.deepEqual(await pending, ["one", "two"]);
  await assert.rejects(
    publishAndWaitAnswers(dir, [{ prompt: "x", groupId: "../no" }], { waitMs: 0, onBatch: () => {} }),
    /group_id/,
  );
});

test("waitMs 0 returns the whole unfinished batch, and answered prompts are not reissued", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-batch0-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    publishAndWaitAnswers(dir, [
      { prompt: "pending-a", groupId: "task:a" },
      { prompt: "pending-b", groupId: "task:b" },
    ], { waitMs: 0, onBatch: () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof AgentAnswerRequiredError);
      assert.equal(error.action.type, "answer_batch");
      if (error.action.type === "answer_batch") assert.equal(error.action.groups.length, 2);
      return true;
    },
  );
  await replyToAgentAnswerRequest(dir, answerRequestId("pending-a"), "done");
  let groups = 0;
  await assert.rejects(
    publishAndWaitAnswers(dir, [
      { prompt: "pending-a", groupId: "task:a" },
      { prompt: "pending-b", groupId: "task:b" },
    ], { waitMs: 0, onBatch: (action) => { groups = action.groups.length; } }),
    AgentAnswerRequiredError,
  );
  assert.equal(groups, 1);
});

test("a request written without group_id still replays", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompt = "legacy prompt";
  const id = answerRequestId(prompt);
  await writeFile(join(dir, `${id}.request.json`), `${JSON.stringify({
    version: 1, request_id: id, created_at: "2020-01-01T00:00:00.000Z", prompt,
  })}\n`);
  await replyToAgentAnswerRequest(dir, id, "kept");
  const ask = createAgentAsk(dir, { waitMs: 0, onRequest: () => {} });
  assert.equal(await ask(prompt), "kept");
});

test("dialog turns keep one group_id", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-dialog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ask = createAgentAsk(dir, { waitMs: 0, onRequest: () => {} });
  const groupId = "task:question";
  await assert.rejects(ask("turn one", { groupId }), AgentAnswerRequiredError);
  await assert.rejects(ask("turn two", { groupId }), AgentAnswerRequiredError);
  const files = ["turn one", "turn two"].map((prompt) => answerRequestId(prompt));
  const stored = await Promise.all(files.map(async (id) => JSON.parse(await readFile(join(dir, `${id}.request.json`), "utf8")) as { group_id?: string }));
  assert.deepEqual(stored.map((row) => row.group_id), [groupId, groupId]);
});

test("one listening leaf stays one request; two leaves are two groups", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unipus-answer-leaves-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { UNIPUS_AGENT_ANSWER_DIR: dir, UNIPUS_AGENT_ANSWER_WAIT_MS: "0" };
  const choice = (id: string, text: string, questions: string[]) => ({
    q_qinstid: id,
    q_template_name: "single-choice",
    is_objective: true,
    data: {
      contents: [{ text }],
      children: questions.map((question) => ({
        quesText: question,
        options: [{ value: "A", text: "alpha" }, { value: "B", text: "beta" }],
      })),
    },
  });
  const run = (paper: unknown[]) => completeOneListen({
    credentials: { getJwt: async () => "jwt" },
    env,
    http: mockHttp(async (call) => {
      const value = call.url.includes("getUserStatus")
        ? { type: "train", taskId: "900", ansVersion: 1 }
        : call.url.includes("loadPaper")
          ? { token: "tok", paperJson: JSON.stringify(paper) }
          : {};
      return { statusCode: 200, body: JSON.stringify({ code: 1, value }) };
    }),
  });
  const one = await run([choice("leaf-1", "Shared material.", ["First?", "Second?"])]);
  assert.equal(one.ok, false);
  const requests = (await readdir(dir)).filter((name) => name.endsWith(".request.json"));
  assert.equal(requests.length, 1);
  const prompt = await readFile(join(dir, requests[0]!), "utf8");
  assert.match(prompt, /Q1\. First\?/);
  assert.match(prompt, /Q2\. Second\?/);
  if (!one.ok && one.nextAction?.type === "answer_batch") {
    assert.deepEqual(one.nextAction.groups, [{ group_id: "900:leaf-1", request_ids: [answerRequestId(JSON.parse(prompt).prompt)] }]);
  } else {
    assert.fail("expected one answer_batch");
  }

  const twoDir = await mkdtemp(join(tmpdir(), "unipus-answer-two-"));
  t.after(() => rm(twoDir, { recursive: true, force: true }));
  const two = await completeOneListen({
    credentials: { getJwt: async () => "jwt" },
    env: { UNIPUS_AGENT_ANSWER_DIR: twoDir, UNIPUS_AGENT_ANSWER_WAIT_MS: "0" },
    http: mockHttp(async (call) => {
      const value = call.url.includes("getUserStatus")
        ? { type: "train", taskId: "900", ansVersion: 1 }
        : call.url.includes("loadPaper")
          ? { token: "tok", paperJson: JSON.stringify([
            choice("leaf-a", "Material A.", ["Question A?"]),
            choice("leaf-b", "Material B.", ["Question B?"]),
          ]) }
          : {};
      return { statusCode: 200, body: JSON.stringify({ code: 1, value }) };
    }),
  });
  assert.equal(two.ok, false);
  assert.equal((await readdir(twoDir)).filter((name) => name.endsWith(".response.json")).length, 0);
  assert.equal((await readdir(twoDir)).filter((name) => name.endsWith(".request.json")).length, 2);
  if (!two.ok && two.nextAction?.type === "answer_batch") {
    assert.deepEqual(
      two.nextAction.groups.map((group) => group.group_id).sort(),
      ["900:leaf-a", "900:leaf-b"],
    );
  } else {
    assert.fail("expected two groups");
  }
});
