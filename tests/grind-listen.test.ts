import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { completeOneListen, grindListenGaps } from "../src/grind-listen.js";
import { mockHttp } from "./mock-http.js";

const paper = [{
  q_qinstid: "1985995334422880257",
  q_template_name: "single-choice_objective",
  is_objective: true,
  nm: "听力_单选_客观题",
  q_qinst_struct: JSON.stringify({
    replyType: "singlechoice",
    contents: [{ text: "<p>Greater <strong>flexibility</strong>.</p>" }],
    options: [{ value: "A", text: "capability" }, { value: "B", text: "flexibility" }],
  }),
}];

function http() {
  let n = 0;
  return mockHttp(async (call) => {
    if (call.url.includes("getUserStatus")) {
      n++;
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: `10000000000000000${n}`, ansVersion: 1 } }) };
    }
    if (call.url.includes("loadPaper")) {
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { token: "tok", paperJson: JSON.stringify(paper) } }) };
    }
    return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
  });
}

const submits = (h: ReturnType<typeof http>) => h.calls.filter((c) => c.url.includes("submitAnswer"));

describe("grind-listen solver paths", () => {
  test("LLM failure after retries → paper not submitted", async () => {
    const h = http();
    const r = await completeOneListen({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => { throw new Error("HTTP 503"); },
    } as never);
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /not submitted[\s\S]*HTTP 503/);
    assert.equal(submits(h).length, 0);
  });

  test("no UNIPUS_LLM_* config (SiliconFlow key only) → refused, nothing submitted, loop stops", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h,
      env: { SILICONFLOW_API_KEY: "k" },
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 3, 3);
    assert.equal(r.completed, 0);
    assert.equal(r.refused, true);
    assert.match(r.stoppedReason!, /ANSWER_REFUSED[\s\S]*UNIPUS_LLM_BASE_URL/);
    assert.equal(submits(h).length, 0);
    assert.equal(h.calls.filter((c) => c.url.includes("loadPaper")).length, 0);
  });

  test("invalid LLM letter → refused, nothing submitted, no heuristic", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => '{"answers":["Z"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 3, 3);
    assert.equal(r.completed, 0);
    assert.equal(r.refused, true);
    assert.match(r.stoppedReason!, /not submitted[\s\S]*ANSWER_REFUSED/);
    assert.equal(submits(h).length, 0);
  });

  test("valid LLM letter → submitted with that letter", async () => {
    const h = http();
    const r = await completeOneListen({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {},
      llmAsk: async () => '{"answers":["A"]}',
    } as never);
    assert.equal(r.ok, true);
    assert.equal(submits(h).length, 1);
    assert.match(submits(h)[0]!.body!, /\\"A\\"/);
  });
});

describe("grind-listen per-paper results (#88)", () => {
  const withHistory = (item: Record<string, unknown> | null) => {
    return mockHttp(async (call) => {
      if (call.url.includes("getUserStatus")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { type: "train", taskId: "100000000000000001", ansVersion: 2 } }) };
      }
      if (call.url.includes("loadPaper")) {
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { token: "tok", paperJson: JSON.stringify(paper) } }) };
      }
      if (call.url.includes("getHistoryTrainingTasks")) {
        const list = item ? [{ ...item, taskId: "100000000000000001" }] : [];
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { page: 1, pageSize: 20, total: list.length, totalPages: 1, list } }) };
      }
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: {} }) };
    });
  };
  const run = (h: ReturnType<typeof mockHttp>, submittedKeys: string[] = []) => {
    const lines: Array<Record<string, unknown>> = [];
    const results = {
      report: async (r: Record<string, unknown>) => void lines.push(r),
      isSubmitted: (s: string, t: string, v: number) => submittedKeys.includes(`${s}|${t}|${v}`),
    };
    return grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1, scorePollTries: 2, results,
    } as never, 1, 1).then((r) => ({ r, lines }));
  };

  test("submitted paper → line with App history score", async () => {
    const { lines } = await run(withHistory({ ansVersion: 2, score: 98, scoreIsOut: true }));
    assert.deepEqual(lines, [{
      skill: "听", taskId: "100000000000000001", ansVersion: 2, score: 98, scoreIsOut: true, status: "ok", error: null,
    }]);
  });

  test("score comes out after a while → final App score written (polls UNIPUS_SCORE_* budget, not 5 tries) (#92)", async () => {
    let n = 0;
    const base = withHistory(null);
    const h = mockHttp(async (c) => {
      if (c.url.includes("getHistoryTrainingTasks")) {
        n++;
        const item = n >= 8 ? { taskId: "100000000000000001", ansVersion: 2, score: 100, scoreIsOut: true } : { taskId: "100000000000000001", ansVersion: 2, score: 0, scoreIsOut: false };
        return { statusCode: 200, body: JSON.stringify({ code: 1, value: { page: 1, pageSize: 20, total: 1, totalPages: 1, list: [item] } }) };
      }
      return base.request(c as never);
    });
    const sleeps: number[] = [];
    const lines: Array<Record<string, unknown>> = [];
    await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: { UNIPUS_SCORE_POLL_MS: "5000", UNIPUS_SCORE_MAX_MS: "60000" },
      llmAsk: async () => '{"answers":["B"]}', sleep: async (ms: number) => void sleeps.push(ms), trainProfileMaxPolls: 1,
      results: { report: async (r: Record<string, unknown>) => void lines.push(r), isSubmitted: () => false },
    } as never, 1, 1);
    assert.equal(lines[0]!.score, 100);
    assert.equal(lines[0]!.status, "ok");
    assert.equal(sleeps.filter((ms) => ms === 5000).length, 7);
  });

  test("score not out yet → grading line (grind itself still succeeds)", async () => {
    const { r, lines } = await run(withHistory(null));
    assert.equal(r.completed, 1);
    assert.equal(lines[0]!.status, "grading");
    assert.match(String(lines[0]!.error), /未出分/);
  });

  test("history lookup throwing after submit → grading line, paper still counted", async () => {
    const base = withHistory(null);
    const h = { calls: base.calls, request: async (c: never) => {
      if (String((c as { url: string }).url).includes("getHistoryTrainingTasks")) throw new Error("The operation was aborted due to timeout");
      return base.request(c);
    } };
    const { r, lines } = await run(h as never);
    assert.equal(r.completed, 1);
    assert.equal(lines[0]!.status, "grading");
    assert.match(String(lines[0]!.error), /timeout/);
  });

  test("ledger hit → skipped_existing, no submitAnswer", async () => {
    const h = withHistory(null);
    const { r, lines } = await run(h, ["听|100000000000000001|2"]);
    assert.equal(r.completed, 0);
    assert.equal(lines[0]!.status, "skipped_existing");
    assert.equal(h.calls.filter((c) => c.url.includes("submitAnswer")).length, 0);
  });
});

describe("grind-listen rounds (#88)", () => {
  test("maxRounds defaults to max(8, need): a 12-paper week finishes all 12", async () => {
    const h = http();
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1,
    } as never, 12);
    assert.equal(r.completed, 12);
    assert.equal(submits(h).length, 12);
  });

  test("a throw mid-round skips only that paper: later papers still run, errorClass kept (#98)", async () => {
    let calls = 0;
    const base = http();
    const h = { calls: base.calls, request: async (c: never) => {
      if (String((c as { url: string }).url).includes("loadPaper") && ++calls === 2) throw new Error("fetch failed ECONNRESET");
      return base.request(c);
    } };
    const lines: Array<Record<string, unknown>> = [];
    const r = await grindListenGaps({
      credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
      sleep: async () => {}, trainProfileMaxPolls: 1, scorePollTries: 1,
      results: { report: async (l: Record<string, unknown>) => void lines.push(l), isSubmitted: () => false },
    } as never, 3);
    assert.equal(r.completed, 3);
    assert.equal(r.errorClass, "NETWORK");
    assert.equal(r.stoppedReason, undefined);
    assert.match(String(r.warnings), /NETWORK: .*ECONNRESET/);
    assert.match(String(lines.find((l) => l.status === "failed")?.error), /^NETWORK: .*ECONNRESET/);
  });
});

/** One server-side current paper per account: getUserStatus keeps returning it until submitAnswer succeeds. */
function serverHttp(opts: {
  submit?: () => { code: number; msg?: string };
  load?: (n: number) => { code: number; value?: unknown } | undefined;
  history?: () => Array<Record<string, unknown>>;
  status?: (n: number, current: string) => Record<string, unknown>;
} = {}) {
  let current = 1;
  let statusN = 0;
  let loadN = 0;
  const taskId = () => `20000000000000000${current}`;
  return mockHttp(async (call) => {
    const ok = (value: unknown) => ({ statusCode: 200, body: JSON.stringify({ code: 1, value }) });
    if (call.url.includes("getUserStatus")) {
      statusN++;
      return ok(opts.status?.(statusN, taskId()) ?? { type: "train", taskId: taskId(), ansVersion: 1 });
    }
    if (call.url.includes("loadPaper")) {
      loadN++;
      const r = opts.load?.(loadN);
      if (r) return { statusCode: 200, body: JSON.stringify(r) };
      return ok({ token: `tok${loadN}`, paperJson: JSON.stringify(paper) });
    }
    if (call.url.includes("submitAnswer")) {
      const r = opts.submit?.() ?? { code: 1 };
      if (r.code === 1) current++;
      return { statusCode: 200, body: JSON.stringify({ ...r, value: {} }) };
    }
    if (call.url.includes("getHistoryTrainingTasks")) {
      const list = opts.history?.() ?? [];
      return { statusCode: 200, body: JSON.stringify({ code: 1, value: { page: 1, pageSize: 20, total: list.length, totalPages: 1, list } }) };
    }
    return ok({});
  });
}

const grind = (h: ReturnType<typeof mockHttp>, need: number, extra: Record<string, unknown> = {}) => {
  const lines: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  return grindListenGaps({
    credentials: { getJwt: async () => "jwt" }, http: h, env: {}, llmAsk: async () => '{"answers":["B"]}',
    sleep: async (ms: number) => void sleeps.push(ms), trainProfileMaxPolls: 1, scorePollTries: 1,
    results: { report: async (l: Record<string, unknown>) => void lines.push(l), isSubmitted: () => false },
    ...extra,
  } as never, need).then((r) => ({ r, lines, sleeps }));
};
const calls = (h: ReturnType<typeof mockHttp>, part: string) => h.calls.filter((c) => c.url.includes(part)).length;

describe("grind-listen per-paper skip + consecutive-failure stop (#98)", () => {
  test("one failed paper is recorded and skipped; the grind goes on", async () => {
    const h = serverHttp({ load: (n) => (n === 1 ? { code: 500, value: "boom" } : undefined) });
    const { r, lines } = await grind(h, 2);
    assert.equal(r.completed, 2);
    assert.equal(r.stoppedReason, undefined);
    assert.equal(lines[0]!.status, "failed");
    assert.match(String(lines[0]!.error), /loadPaper failed/);
    assert.match(String(r.warnings), /跳过.*loadPaper failed/);
  });

  test("UNIPUS_MAX_CONSECUTIVE_FAILURES (default 2) papers failing in a row stop the account", async () => {
    const h = serverHttp({ load: () => ({ code: 500, value: "boom" }) });
    const { r } = await grind(h, 5);
    assert.equal(r.completed, 0);
    assert.match(String(r.stoppedReason), /连续 2 张失败/);
    assert.equal(calls(h, "loadPaper"), 2);

    const h3 = serverHttp({ load: () => ({ code: 500, value: "boom" }) });
    const { r: r3 } = await grind(h3, 5, { env: { UNIPUS_MAX_CONSECUTIVE_FAILURES: "3" } });
    assert.match(String(r3.stoppedReason), /连续 3 张失败/);
    assert.equal(calls(h3, "loadPaper"), 3);
  });

  test("a success resets the streak", async () => {
    const h = serverHttp({ load: (n) => (n === 1 || n === 3 ? { code: 500, value: "boom" } : undefined) });
    const { r } = await grind(h, 2);
    assert.equal(r.completed, 2);
    assert.equal(r.stoppedReason, undefined);
  });

  test("auth failure (no jwt) stops the account at once", async () => {
    const h = serverHttp();
    const { r } = await grind(h, 3, { credentials: { getJwt: async () => null } });
    assert.equal(r.completed, 0);
    assert.match(String(r.stoppedReason), /no jwt/);
    assert.equal(calls(h, "loadPaper"), 0);
  });

  test("submitAnswer 401 (JWT expired) stops the account at once", async () => {
    const h = mockHttp(async (call) => {
      if (call.url.includes("submitAnswer")) return { statusCode: 401, body: "{}" };
      return serverHttp().request(call as never);
    });
    const { r } = await grind(h, 3);
    assert.match(String(r.stoppedReason), /401/);
    assert.equal(calls(h, "submitAnswer"), 1);
  });
});

describe("grind-listen 4021 (#98)", () => {
  const busy = { code: 4021, msg: "请勿多设备同时作答，作答数据可能丢失，请重新加载试卷" };

  test("4021 → wait, confirm still the same unsubmitted paper, reload a fresh token, resubmit once", async () => {
    let n = 0;
    const h = serverHttp({ submit: () => (++n === 1 ? busy : { code: 1 }) });
    const { r, sleeps } = await grind(h, 1);
    assert.equal(r.completed, 1);
    assert.equal(calls(h, "submitAnswer"), 2);
    assert.equal(calls(h, "loadPaper"), 2);
    assert.ok(sleeps.includes(60_000), String(sleeps));
    const tokens = h.calls.filter((c) => c.url.includes("submitAnswer")).map((c) => JSON.parse(c.body!).token);
    assert.deepEqual(tokens, ["tok1", "tok2"]);
  });

  test("4021 every time → UNIPUS_CONCURRENT_RETRIES retries, then only this paper is skipped", async () => {
    const h = serverHttp({ submit: () => busy });
    const { r, lines } = await grind(h, 1, { env: { UNIPUS_CONCURRENT_RETRIES: "1", UNIPUS_CONCURRENT_RETRY_MS: "5000" } });
    assert.equal(r.completed, 0);
    assert.equal(calls(h, "submitAnswer"), 2 * 2, "two rounds (streak of 2), each 1 + 1 retry");
    assert.match(String(lines[0]!.error), /4021[\s\S]*已重试 1 次/);
  });

  test("4021 then the paper changed on the server → never resubmitted", async () => {
    const h = serverHttp({
      submit: () => busy,
      status: (n, current) => ({ type: "train", taskId: n >= 3 ? "29999999999999999" : current, ansVersion: 1 }),
    });
    const { lines } = await grind(h, 1, { env: { UNIPUS_MAX_CONSECUTIVE_FAILURES: "1" } });
    assert.equal(calls(h, "submitAnswer"), 1);
    assert.match(String(lines[0]!.error), /4021.*不重交.*已变/);
  });

  test("4021 then history already has this paper → never resubmitted", async () => {
    const h = serverHttp({ submit: () => busy, history: () => [{ taskId: "200000000000000001", ansVersion: 1, scoreIsOut: false }] });
    const { lines } = await grind(h, 1, { env: { UNIPUS_MAX_CONSECUTIVE_FAILURES: "1" } });
    assert.equal(calls(h, "submitAnswer"), 1);
    assert.match(String(lines[0]!.error), /不重交.*历史已有/);
  });

  test("4021 then history lookup fails → conservatively not resubmitted", async () => {
    const base = serverHttp({ submit: () => busy });
    const h = { calls: base.calls, request: async (c: never) => {
      if (String((c as { url: string }).url).includes("getHistoryTrainingTasks")) return { statusCode: 500, body: "{}" };
      return base.request(c);
    } };
    const { lines } = await grind(h as never, 1, { env: { UNIPUS_MAX_CONSECUTIVE_FAILURES: "1" } });
    assert.equal(calls(h as never, "submitAnswer"), 1);
    assert.match(String(lines[0]!.error), /不重交/);
  });
});
