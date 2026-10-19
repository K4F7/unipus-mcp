import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LLM_SOLVE_ATTEMPTS,
  AnswerRefusedError,
  buildSolvedFillblankAnswer,
  buildSolvedObjectiveAnswer,
  parseChoiceAnswers,
  resolveChoiceSolverConfig,
} from "../src/choice-solver.js";

const opts = [
  { name: "A", value: "A", text: "<p>Friends.</p>" },
  { name: "B", value: "B", text: "<p>Neighbors.</p>" },
];

const LLM_ENV = { UNIPUS_LLM_BASE_URL: "https://llm.example/v1/", UNIPUS_LLM_MODEL: "m", UNIPUS_LLM_API_KEY: "k" };

describe("choice-solver", () => {
  test("config reads only UNIPUS_LLM_BASE_URL / MODEL / API_KEY", () => {
    assert.deepEqual(resolveChoiceSolverConfig(LLM_ENV), {
      baseUrl: "https://llm.example/v1",
      model: "m",
      apiKey: "k",
    });
  });

  test("config missing any UNIPUS_LLM_* var → AnswerRefusedError (no SiliconFlow fallback / defaults)", () => {
    assert.throws(() => resolveChoiceSolverConfig({}), AnswerRefusedError);
    assert.throws(
      () => resolveChoiceSolverConfig({ SILICONFLOW_API_KEY: "k" }),
      (e: unknown) => e instanceof AnswerRefusedError && /UNIPUS_LLM_BASE_URL/.test((e as Error).message),
    );
    for (const drop of Object.keys(LLM_ENV)) {
      const env: Record<string, string> = { ...LLM_ENV };
      delete env[drop];
      assert.throws(() => resolveChoiceSolverConfig(env), (e: unknown) => e instanceof AnswerRefusedError && e.message.includes(drop));
    }
  });

  test("config error never echoes the key", () => {
    try {
      resolveChoiceSolverConfig({ UNIPUS_LLM_API_KEY: "secret-xyz" });
      assert.fail("should throw");
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /secret-xyz/);
    }
  });

  test("parseChoiceAnswers keeps only valid option letters", () => {
    const qs = [{ question: "q", options: [{ value: "A", text: "" }, { value: "B", text: "" }] }];
    assert.deepEqual(parseChoiceAnswers('sure: {"answers":["b"]}', qs), ["B"]);
    assert.deepEqual(parseChoiceAnswers('{"answers":["Z"]}', qs), [null]);
    assert.deepEqual(parseChoiceAnswers("garbage", qs), [null]);
  });

  test("multi-child: every question gets the LLM letter", async () => {
    const data = {
      contents: [{ text: "<p>We are <strong>Neighbors.</strong></p>" }],
      children: [
        { contents: [{ text: "Q1?" }], options: opts },
        { contents: [{ text: "Q2?" }], options: opts },
      ],
    };
    const seen: string[] = [];
    const answer = await buildSolvedObjectiveAnswer(data, async (prompt) => {
      seen.push(prompt);
      return '{"answers":["A","b"]}';
    });
    assert.match(seen[0]!, /We are Neighbors\.[\s\S]*Q1\. Q1\?[\s\S]*Q2\. Q2\?/);
    assert.deepEqual(JSON.parse(answer).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);
  });

  test("invalid letter is retried, never guessed; still invalid → throws", async () => {
    const data = { children: [{ quesText: "Q1?", options: opts }, { quesText: "Q2?", options: opts }] };
    const replies = ['{"answers":["A","?"]}', '{"answers":["A","B"]}'];
    let n = 0;
    const answer = await buildSolvedObjectiveAnswer(data, async () => replies[n++]!);
    assert.equal(n, 2);
    assert.deepEqual(JSON.parse(answer).children.map((c: { value: string[] }) => c.value[0]), ["A", "B"]);

    let m = 0;
    await assert.rejects(
      buildSolvedObjectiveAnswer(data, async () => { m++; return '{"answers":["A","Z"]}'; }),
      (e: unknown) => e instanceof AnswerRefusedError && /无合法答案|invalid/.test((e as Error).message),
    );
    assert.equal(m, LLM_SOLVE_ATTEMPTS);
  });

  test("video item: question from quesText, context from WebVTT subtitles", async () => {
    const data = {
      contents: [{ type: 2, subtitles: [{ path: "https://birdflock.unipus.cn/s.vtt" }] }],
      children: [{ quesText: "Who?", options: opts }],
    };
    let prompt = "";
    await buildSolvedObjectiveAnswer(
      data,
      async (p) => ((prompt = p), '{"answers":["B"]}'),
      async () => "WEBVTT\n\n1\n00:00.000 --> 00:01.000\nWe are neighbors.\n",
    );
    assert.match(prompt, /We are neighbors\.[\s\S]*Q1\. Who\?/);
  });

  test("LLM retries transient failure / bad JSON, then succeeds", async () => {
    const replies = [() => { throw new Error("timeout"); }, () => "not json", () => '{"answers":["B"]}'];
    let n = 0;
    const answer = await buildSolvedObjectiveAnswer({ options: opts }, async () => replies[n++]!());
    assert.equal(n, LLM_SOLVE_ATTEMPTS);
    assert.deepEqual(JSON.parse(answer).children[0].value, ["B"]);
  });

  test("objective: LLM keeps failing → throws AnswerRefusedError (no heuristic fallback)", async () => {
    let n = 0;
    await assert.rejects(
      buildSolvedObjectiveAnswer({ options: opts }, async () => { n++; throw new Error("HTTP 500"); }),
      (e: unknown) => e instanceof AnswerRefusedError && /HTTP 500/.test((e as Error).message),
    );
    assert.equal(n, LLM_SOLVE_ATTEMPTS);
  });

  test("fillblank: every blank filled by the LLM", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    const answer = await buildSolvedFillblankAnswer(data, async () => '{"answers":["marine","life"]}');
    assert.deepEqual(JSON.parse(answer).children, [
      { value: ["marine"], isDone: true },
      { value: ["life"], isDone: true },
    ]);
  });

  test("fillblank: empty blank or garbage → throws, never submitted empty", async () => {
    const data = { children: [{ quesText: "<p>a ____1____ b ____2____</p>" }, { quesText: "" }] };
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => '{"answers":["marine",""]}'), AnswerRefusedError);
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => '{"answers":["marine"]}'), AnswerRefusedError);
    await assert.rejects(buildSolvedFillblankAnswer(data, async () => "garbage"), AnswerRefusedError);
  });
});

describe("LLM request budget (#92: reasoning models think ~60s, a 230-word script needs >300 tokens)", () => {
  test("defaults: 180s wall timeout, 1024 max_tokens; env overrides", async () => {
    const { resolveLlmAsk } = await import("../src/choice-solver.js");
    const { resolveLlmTimeoutMs, resolveLlmMaxTokens } = await import("../src/limits.js");
    assert.equal(resolveLlmTimeoutMs({}), 180_000);
    assert.equal(resolveLlmMaxTokens({}), 1024);
    assert.equal(resolveLlmTimeoutMs({ UNIPUS_LLM_TIMEOUT_MS: "90000" }), 90_000);
    assert.equal(resolveLlmMaxTokens({ UNIPUS_LLM_MAX_TOKENS: "2048" }), 2048);
    const { resolveLlmFirstByteMs, resolveLlmIdleMs } = await import("../src/limits.js");
    assert.equal(resolveLlmFirstByteMs({}), 30_000);
    assert.equal(resolveLlmIdleMs({}), 60_000);
    assert.equal(resolveLlmFirstByteMs({ UNIPUS_LLM_FIRST_BYTE_MS: "45000" }), 45_000);
    assert.equal(resolveLlmIdleMs({ UNIPUS_LLM_IDLE_MS: "junk" }), 60_000);
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as never;
    try {
      assert.equal(await resolveLlmAsk({ ...LLM_ENV, UNIPUS_LLM_MAX_TOKENS: "777" })("hi"), "ok");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(seen[0]!.max_tokens, 777);
  });

  test("a call slower than UNIPUS_LLM_TIMEOUT_MS is aborted", async () => {
    const { createLlmAsk } = await import("../src/choice-solver.js");
    const hang = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))) as never;
    const ask = createLlmAsk({ baseUrl: "https://x/v1", model: "m", apiKey: "k", timeoutMs: 50 }, hang);
    await assert.rejects(ask("hi"), /timeout/i);
  });
});

describe("LLM streaming (#92: the grok gateway 504s a non-streamed reply after 60s)", () => {
  const capture = async (respond: () => Response) => {
    const { createLlmAsk } = await import("../src/choice-solver.js");
    const bodies: Array<Record<string, unknown>> = [];
    const f = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return respond();
    }) as never;
    return { ask: createLlmAsk({ baseUrl: "https://x/v1", model: "m", apiKey: "k" }, f), bodies };
  };

  test("requests a stream and joins SSE deltas (split across chunks)", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choi',
      'ces":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { ask, bodies } = await capture(() => new Response(new ReadableStream({
      start(c) { for (const s of sse) c.enqueue(new TextEncoder().encode(s)); c.close(); },
    }), { headers: { "content-type": "text/event-stream" } }));
    assert.equal(await ask("hi"), "Hello world");
    assert.equal(bodies[0]!.stream, true);
  });

  test("a provider that ignores stream and returns JSON still works", async () => {
    const { ask } = await capture(() => new Response(JSON.stringify({ choices: [{ message: { content: "B" } }] }), { headers: { "content-type": "application/json" } }));
    assert.equal(await ask("hi"), "B");
  });
});

describe("LLM first-byte / idle / total timeouts (#100)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const delta = (t: string) => enc(`data: {"choices":[{"delta":{"content":"${t}"}}]}\n\n`);
  const sseResponse = (pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) =>
    new Response(new ReadableStream({ pull }), { headers: { "content-type": "text/event-stream" } });
  const make = async (respond: () => Response, limits: Record<string, number>) => {
    const { createLlmAsk } = await import("../src/choice-solver.js");
    return createLlmAsk({ baseUrl: "https://x/v1", model: "m", apiKey: "k", ...limits }, (async () => respond()) as never);
  };
  const never = () => new Promise<void>(() => {});

  test("headers but no body byte → 首包超时", async () => {
    const ask = await make(() => sseResponse(never), { firstByteMs: 30, idleMs: 1000, timeoutMs: 5000 });
    await assert.rejects(ask("hi"), /LLM 首包超时 \(30ms\)/);
  });

  test("stream stalls mid-way → 空闲超时 with bytes received", async () => {
    let n = 0;
    const ask = await make(() => sseResponse(async (c) => {
      if (n++ < 2) c.enqueue(delta("a"));
      else await never();
    }), { firstByteMs: 1000, idleMs: 40, timeoutMs: 5000 });
    await assert.rejects(ask("hi"), /LLM 流空闲超时 \(40ms 无数据，已收 \d+ 字节\)/);
  });

  test("a slow but steady stream is not cut by the idle timer; the total cap still applies", async () => {
    let n = 0;
    const steady = await make(() => sseResponse(async (c) => {
      await new Promise((r) => setTimeout(r, 15));
      if (n++ < 6) c.enqueue(delta("x"));
      else c.close();
    }), { firstByteMs: 1000, idleMs: 60, timeoutMs: 5000 });
    assert.equal(await steady("hi"), "xxxxxx");
    const endless = await make(() => sseResponse(async (c) => {
      await new Promise((r) => setTimeout(r, 10));
      c.enqueue(delta("y"));
    }), { firstByteMs: 1000, idleMs: 1000, timeoutMs: 80 });
    await assert.rejects(endless("hi"), /LLM 总时长超时 \(80ms/);
  });
});

describe("LLM limits are hard-capped by the remaining budget (#100)", () => {
  const enc = (t: string) => new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${t}"}}]}\n\n`);
  const sse = (pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) =>
    new Response(new ReadableStream({ pull }), { headers: { "content-type": "text/event-stream" } });
  const never = () => new Promise<void>(() => {});
  /** Configured limits (60s / 60s / 180s) all far beyond the 100ms budget. */
  const runInBudget = async (budgetMs: number, respond: () => Response) => {
    const { createLlmAsk } = await import("../src/choice-solver.js");
    const { withDeadline, activeNow } = await import("../src/watchdog.js");
    const ask = createLlmAsk(
      { baseUrl: "https://x/v1", model: "m", apiKey: "k", firstByteMs: 60_000, idleMs: 60_000, timeoutMs: 180_000 },
      (async () => respond()) as never,
    );
    const t0 = Date.now();
    const err = (await withDeadline(activeNow() + budgetMs, () => ask("hi")).then(() => null, (e: Error) => e))!;
    const limit = Number(/超时 \((\d+)ms/.exec(err?.message ?? "")?.[1]);
    return { err, limit, took: Date.now() - t0 };
  };
  const cases: Array<[string, () => Response]> = [
    ["no first byte", () => sse(never)],
    ["stalls after the first chunk (idle)", () => { let n = 0; return sse(async (c) => { if (n++ === 0) c.enqueue(enc("a")); else await never(); }); }],
    ["steady endless stream (total)", () => sse(async (c) => { await new Promise((r) => setTimeout(r, 10)); c.enqueue(enc("y")); })],
  ];
  for (const [name, respond] of cases) {
    test(`${name}: aborted within the budget, reported limit ≤ budget`, async () => {
      const { err, limit, took } = await runInBudget(100, respond);
      assert.match(String(err?.message), /^LLM (首包|流空闲|总时长)超时/);
      assert.ok(limit > 0 && limit <= 100, `limit ${limit}`);
      assert.ok(took < 3_000, `took ${took}ms`);
    });
  }
});
