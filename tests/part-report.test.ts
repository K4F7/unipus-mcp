import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePartReport, pollPartReports } from "../src/part-report.js";
import { pollWithin, resolveAiReportPoll, resolveScorePoll } from "../src/limits.js";
import { mockHttp } from "./mock-http.js";

const ok = (key: string, totalScore: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ code: 200, message: "操作成功", data: { [key]: { totalScore, ...extra } }, success: true });
const pending = JSON.stringify({ code: 500, message: "报告尚未生成完成", data: null, success: false });

test("parsePartReport: AI / 自由表达 / 范例 scores, 500 pending, other errors", () => {
  assert.deepEqual(parsePartReport("a", ok("ai-spoken_subjective", 99)), { partId: "a", score: 99, status: "ok" });
  assert.deepEqual(
    parsePartReport("f", ok("oral-personal-state_subjective", 88, { userResponse: { fullText: "I got sick last winter." } })),
    { partId: "f", score: 88, status: "ok", asrWords: 5 },
  );
  const sample = JSON.stringify({ code: 200, data: { "oral-sentence-scoop_subjective": { totalScore: 97 }, "oral-sentence_subjective": { totalScore: 96 } } });
  assert.equal(parsePartReport("s", sample).score, 97);
  assert.deepEqual(parsePartReport("a", pending), { partId: "a", score: null, status: "pending", detail: "报告尚未生成完成" });
  assert.equal(parsePartReport("a", "<html>").status, "error");
  // An explicit server answer other than "not generated yet" is final, not worth polling.
  assert.equal(parsePartReport("a", JSON.stringify({ code: 401, message: "未登录" })).status, "failed");
});

test("pollPartReports: GET part-report per part with JWT; stops once every report is out", async () => {
  let aiCalls = 0;
  const http = mockHttp(async (c) => {
    if (c.url.includes("partId=ai")) return { statusCode: 200, body: ++aiCalls >= 3 ? ok("ai-spoken_subjective", 90) : pending };
    return { statusCode: 200, body: ok("oral-personal-state_subjective", 85) };
  });
  const sleeps: number[] = [];
  const r = await pollPartReports(
    { credentials: { getJwt: async () => "jwt" }, http, sleep: async (ms) => void sleeps.push(ms) },
    { taskId: "555", ansVersion: 2, parts: [{ partId: "free", partName: "自由表达" }, { partId: "ai", partName: "AI口语对话" }] },
    { pollMs: 30_000, maxMs: 600_000 },
  );
  assert.equal(r["AI口语对话"]!.score, 90);
  assert.equal(r["自由表达"]!.score, 85);
  assert.equal(http.calls.filter((c) => c.url.includes("partId=free")).length, 1, "a generated report is not re-read");
  assert.deepEqual(sleeps, [30_000, 30_000]);
  const c = http.calls[0]!;
  assert.equal(c.method, "GET");
  assert.match(c.url, /^https:\/\/uadaptive\.unipus\.cn\/api\/uls\/oral\/train\/part-report\?taskId=555&ansVersion=2&partId=free$/);
  assert.equal(c.headers.authorization, "jwt");
});

test("pollPartReports: report never generated → pending after maxMs/pollMs + 1 reads", async () => {
  const http = mockHttp(async () => ({ statusCode: 200, body: pending }));
  const r = await pollPartReports(
    { credentials: { getJwt: async () => "jwt" }, http, sleep: async () => {} },
    { taskId: "1", ansVersion: 1, parts: [{ partId: "ai", partName: "AI口语对话" }] },
    { pollMs: 30_000, maxMs: 120_000 },
  );
  assert.equal(r["AI口语对话"]!.status, "pending");
  assert.equal(http.calls.length, 5);
});

test("pollPartReports: a terminal server error is read once; transport errors keep polling (review #93)", async () => {
  let failedReads = 0;
  let flakyReads = 0;
  const http = mockHttp(async (c) => {
    if (c.url.includes("partId=x")) {
      failedReads++;
      return { statusCode: 200, body: JSON.stringify({ code: 404, message: "part 不存在" }) };
    }
    if (++flakyReads < 3) throw new Error("ECONNRESET");
    return { statusCode: 200, body: ok("ai-spoken_subjective", 91) };
  });
  const out = await pollPartReports(
    { credentials: { getJwt: async () => "jwt" }, http, sleep: async () => {} } as never,
    { taskId: "t", ansVersion: 1, parts: [{ partId: "x", partName: "X" }, { partId: "ai", partName: "AI" }] },
    { pollMs: 1000, maxMs: 10_000 },
  );
  assert.equal(failedReads, 1);
  assert.equal(out.X!.status, "failed");
  assert.equal(out.AI!.score, 91);
});

test("pollWithin stops at the wall-clock budget even when reads are slow", async () => {
  let t = 0;
  let n = 0;
  const out = await pollWithin({ pollMs: 1_000, maxMs: 10_000 }, async () => { n++; t += 4_000; return undefined; }, {
    sleep: async (ms) => void (t += ms),
    now: () => t,
  });
  assert.equal(out, undefined);
  assert.equal(n, 3); // reads at t=0, 5s, 10s; a 4th would start past the 10s budget
});

test("poll budgets: defaults and env overrides", () => {
  assert.deepEqual(resolveAiReportPoll({}), { pollMs: 30_000, maxMs: 600_000 });
  assert.deepEqual(resolveAiReportPoll({ UNIPUS_AI_REPORT_POLL_MS: "5000", UNIPUS_AI_REPORT_MAX_MS: "0" }), { pollMs: 5_000, maxMs: 0 });
  assert.deepEqual(resolveScorePoll({}), { pollMs: 5_000, maxMs: 180_000 });
  assert.deepEqual(resolveScorePoll({ UNIPUS_SCORE_POLL_MS: "1", UNIPUS_SCORE_MAX_MS: "x" }), { pollMs: 5_000, maxMs: 180_000 });
});
