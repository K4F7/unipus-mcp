/**
 * Agent-friendly per-paper result lines (#88).
 *
 * After every paper attempt the grind prints one fixed-shape JSON line on stdout
 * (immediately, not at the end) and appends the same line to a JSONL status file
 * (`UNIPUS_RESULTS_FILE`, default ~/.config/unipus-mcp/results.jsonl). Accounts
 * appear only by note; phone numbers and jwt-shaped strings are redacted.
 * The file doubles as an idempotency ledger: a taskId+ansVersion recorded as
 * submitted (ok / low_score / grading) is never submitted again; if the
 * file cannot be written, report() throws and the grind stops.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultConfigDir } from "./accounts.js";

export type PaperSkill = "听" | "说";
export type PaperStatus = "ok" | "low_score" | "grading" | "failed" | "skipped_existing";

export type PaperResultLine = {
  event: "paper";
  at: string;
  note: string;
  skill: PaperSkill;
  taskId: string | null;
  ansVersion: number | null;
  score: number | null;
  scoreIsOut: boolean | null;
  status: PaperStatus;
  error: string | null;
  /** 说 only (#92): server part-report score per part (+ free-talk words / seconds). */
  parts?: Record<string, { partId: string; score: number | null; status: string; [k: string]: unknown }>;
  /** 说 only: report flags such as ai_report_missing / free_talk_below_80. */
  flags?: string[];
};

export type PaperResult = Omit<PaperResultLine, "event" | "at" | "note">;

export type PaperReporter = {
  report(result: PaperResult): Promise<void>;
  /** True when the ledger already has this paper as fully submitted. */
  isSubmitted(skill: PaperSkill, taskId: string, ansVersion: number): boolean;
};

const SUBMITTED: ReadonlySet<PaperStatus> = new Set(["ok", "low_score", "grading"]);
export const MIN_APP_SCORE = 80;

export function resolveResultsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNIPUS_RESULTS_FILE?.trim() || join(defaultConfigDir(env), "results.jsonl");
}

/** Strip jwt-shaped tokens and mainland mobile numbers (taskIds are 18+ digits, untouched). */
export function redactSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[redacted-phone]");
}

/** ok when the App shows ≥ min, low_score below it, grading while scoreIsOut≠true. */
export function statusFromScore(scoreIsOut: boolean | null, score: number | null, min = MIN_APP_SCORE): PaperStatus {
  if (scoreIsOut !== true) return "grading";
  return (score ?? 0) >= min ? "ok" : "low_score";
}

const ledgerKey = (skill: PaperSkill, taskId: string, ansVersion: number) => `${skill}|${taskId}|${ansVersion}`;

async function readLedger(file: string): Promise<PaperResultLine[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: PaperResultLine[] = [];
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line) as PaperResultLine;
      if (r?.event === "paper") out.push(r);
    } catch {
      /* skip partial / foreign lines */
    }
  }
  return out;
}

export async function createPaperReporter(opts: {
  note: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  /** Default resolveResultsFile(env). */
  file?: string;
  /** Default process.stdout line write. */
  print?: (line: string) => void;
  now?: () => Date;
}): Promise<PaperReporter> {
  const file = opts.file ?? resolveResultsFile(opts.env);
  const note = redactSecrets(opts.note?.trim() || "(无备注)");
  const print = opts.print ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  const submitted = new Set<string>();
  const seen = new Set<string>();
  const remember = (r: PaperResultLine) => {
    seen.add(JSON.stringify([r.note, r.skill, r.taskId, r.ansVersion, r.status, r.score, r.scoreIsOut]));
    if (r.taskId != null && SUBMITTED.has(r.status)) submitted.add(ledgerKey(r.skill, r.taskId, r.ansVersion ?? 1));
  };
  for (const r of await readLedger(file)) remember(r);

  return {
    isSubmitted: (skill, taskId, ansVersion) => submitted.has(ledgerKey(skill, taskId, ansVersion)),
    async report(result) {
      const line: PaperResultLine = {
        event: "paper",
        at: now().toISOString(),
        note,
        ...result,
        error: result.error == null ? null : redactSecrets(result.error).slice(0, 500),
      };
      const json = JSON.stringify(line);
      print(json);
      const dupKey = JSON.stringify([line.note, line.skill, line.taskId, line.ansVersion, line.status, line.score, line.scoreIsOut]);
      // Re-runs that reach the same outcome reuse the existing ledger row.
      if (seen.has(dupKey) && line.taskId != null) return;
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `${json}\n`);
      } catch (error) {
        // The file is the idempotency ledger: without it a re-run could resubmit, so stop the run.
        throw new Error(`状态文件写入失败，停止交卷 ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      remember(line);
    },
  };
}
