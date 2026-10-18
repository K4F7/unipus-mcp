import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createPaperReporter,
  redactSecrets,
  resolveResultsFile,
  statusFromScore,
  type PaperResult,
} from "../src/paper-result.js";

const tmpFile = async () => join(await mkdtemp(join(tmpdir(), "results-")), "sub", "results.jsonl");
const ok: PaperResult = {
  skill: "说", taskId: "104413317900172796", ansVersion: 1, score: 84, scoreIsOut: true, status: "ok", error: null,
};

test("resolveResultsFile: env override, default under config dir", () => {
  assert.equal(resolveResultsFile({ UNIPUS_RESULTS_FILE: "/tmp/r.jsonl" }), "/tmp/r.jsonl");
  assert.equal(resolveResultsFile({ XDG_CONFIG_HOME: "/x" }), "/x/unipus-mcp/results.jsonl");
});

test("redactSecrets masks phones and jwts, keeps 18-digit taskIds", () => {
  const s = redactSecrets("acct 13133991195 task 104413317900172796 jwt eyJhbGciOi.eyJzdWIi.sig");
  assert.equal(s, "acct [redacted-phone] task 104413317900172796 jwt [redacted-jwt]");
});

test("statusFromScore", () => {
  assert.equal(statusFromScore(true, 80), "ok");
  assert.equal(statusFromScore(true, 79), "low_score");
  assert.equal(statusFromScore(false, 0), "grading");
  assert.equal(statusFromScore(null, null), "grading");
});

test("report prints one fixed-shape line immediately and appends it to the JSONL file", async () => {
  const file = await tmpFile();
  const printed: string[] = [];
  const r = await createPaperReporter({
    note: "一学期（5听3口）", file, print: (l) => printed.push(l), now: () => new Date("2026-10-19T00:00:00Z"),
  });
  await r.report(ok);
  await r.report({ skill: "听", taskId: null, ansVersion: null, score: null, scoreIsOut: null, status: "failed", error: "login 13960109735 failed" });
  assert.equal(printed.length, 2);
  const line = JSON.parse(printed[0]!);
  assert.deepEqual(Object.keys(line), ["event", "at", "note", "skill", "taskId", "ansVersion", "score", "scoreIsOut", "status", "error"]);
  assert.deepEqual(line, { event: "paper", at: "2026-10-19T00:00:00.000Z", note: "一学期（5听3口）", ...ok });
  assert.equal(JSON.parse(printed[1]!).error, "login [redacted-phone] failed");
  const fileLines = (await readFile(file, "utf8")).trim().split("\n");
  assert.deepEqual(fileLines, printed);
});

test("ledger: submitted papers are remembered across runs; identical outcomes are not re-appended", async () => {
  const file = await tmpFile();
  const first = await createPaperReporter({ note: "n", file, print: () => {} });
  assert.equal(first.isSubmitted("说", ok.taskId!, 1), false);
  await first.report(ok);
  await first.report({ ...ok, taskId: "2", status: "failed", score: null, scoreIsOut: null, error: "x" });
  assert.equal(first.isSubmitted("说", ok.taskId!, 1), true);
  assert.equal(first.isSubmitted("听", ok.taskId!, 1), false, "skill is part of the key");
  assert.equal(first.isSubmitted("说", "2", 1), false, "failed papers may be resumed");

  const printed: string[] = [];
  const second = await createPaperReporter({ note: "n", file, print: (l) => printed.push(l) });
  assert.equal(second.isSubmitted("说", ok.taskId!, 1), true);
  await second.report({ ...ok, status: "skipped_existing", score: null, scoreIsOut: null, error: "dup" });
  await second.report(ok); // same outcome again → stdout yes, file no
  assert.equal(printed.length, 2);
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.status), ["ok", "failed", "skipped_existing"]);
});

test("ledger tolerates foreign / partial lines", async () => {
  const file = await tmpFile();
  await createPaperReporter({ note: "n", file, print: () => {} }).then((r) => r.report(ok));
  await writeFile(file, `${await readFile(file, "utf8")}{"event":"summary"}\nnot json\n{"event":"paper","skill":"说","taskId"`);
  const r = await createPaperReporter({ note: "n", file, print: () => {} });
  assert.equal(r.isSubmitted("说", ok.taskId!, 1), true);
});

test("unwritable ledger → report throws (run must stop instead of losing idempotency)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "results-ro-"));
  const blocker = join(dir, "file");
  await writeFile(blocker, "x"); // a file where a directory is expected
  const printed: string[] = [];
  const r = await createPaperReporter({ note: "n", file: join(blocker, "results.jsonl"), print: (l) => printed.push(l) });
  await assert.rejects(r.report(ok), /状态文件写入失败，停止交卷/);
  assert.equal(r.isSubmitted("说", ok.taskId!, 1), false);
  assert.equal(printed.length, 1, "stdout line still printed");
});
