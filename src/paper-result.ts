/**
 * Agent-friendly per-paper result lines (#88).
 *
 * After every paper attempt the grind prints one fixed-shape JSON line on stdout
 * (immediately, not at the end) and appends the same line to a JSONL status file
 * (`UNIPUS_RESULTS_FILE`, default ~/.config/unipus-mcp/results.jsonl). Accounts
 * appear only by note (+ an opaque salted `account` key); phone numbers and
 * jwt-shaped strings are redacted. The file doubles as an idempotency ledger:
 * a taskId+ansVersion this account recorded as submitted (ok / low_score /
 * grading) is checked against App history before it is answered again; if the
 * file cannot be written, report() throws and the grind stops.
 */
import { createHmac, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultConfigDir } from "./accounts.js";

export type PaperSkill = "听" | "说";
export type PaperStatus = "ok" | "low_score" | "grading" | "failed" | "skipped_existing";

export type PaperResultLine = {
  event: "paper";
  at: string;
  note: string;
  /** Salted HMAC of the account id (#100): stable ledger identity, not reversible to a phone number. */
  account?: string;
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

export type PaperResult = Omit<PaperResultLine, "event" | "at" | "note" | "account">;

export type PaperReporter = {
  report(result: PaperResult): Promise<void>;
  /** True when the ledger has this paper as submitted by this account (taskIds are shared across accounts, #100). */
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

/**
 * One JSONL holds every account and taskIds are shared papers (#100): rows key by
 * the salted account key; rows written before it existed fall back to the note.
 */
const identity = (r: { account?: string; note: string }) => (r.account ? `a:${r.account}` : `n:${r.note}`);
const ledgerKey = (who: string, skill: PaperSkill, taskId: string, ansVersion: number) =>
  JSON.stringify([who, skill, taskId, ansVersion]);

/** HMAC of the account id with a per-install random salt kept next to the ledger. */
export async function accountKey(accountId: string, file: string): Promise<string> {
  const saltFile = join(dirname(file), "results.salt");
  // Another process may have just created the salt and not written it yet (#106):
  // only a complete 64-hex salt is used, else keys (and lock names) would diverge.
  for (let attempt = 0; attempt < 50; attempt++) {
    const salt = (await readFile(saltFile, "utf8").catch(() => "")).trim();
    if (/^[0-9a-f]{64}$/.test(salt)) return createHmac("sha256", salt).update(accountId).digest("hex").slice(0, 16);
    if (attempt === 0 && !salt) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(saltFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }).catch(() => {});
      continue;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("results.salt 无效或未写完，拒绝派生账号 key");
}

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
  /** Stable account id (never written; only its salted key is). */
  accountId?: string;
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
  const account = opts.accountId ? await accountKey(opts.accountId, file) : undefined;
  // Ours: rows with our account key, plus pre-#100 rows (no key) under our note.
  const mine = [identity({ account, note }), identity({ note })];
  const submitted = new Set<string>();
  const seen = new Set<string>();
  const outcomeKey = (r: PaperResultLine) =>
    JSON.stringify([identity(r), r.skill, r.taskId, r.ansVersion, r.status, r.score, r.scoreIsOut]);
  const remember = (r: PaperResultLine) => {
    if (r.taskId == null || !SUBMITTED.has(r.status)) return;
    seen.add(outcomeKey(r));
    submitted.add(ledgerKey(identity(r), r.skill, r.taskId, r.ansVersion ?? 1));
  };
  for (const r of await readLedger(file)) remember(r);

  return {
    isSubmitted: (skill, taskId, ansVersion) => mine.some((who) => submitted.has(ledgerKey(who, skill, taskId, ansVersion))),
    async report(result) {
      const line: PaperResultLine = {
        event: "paper",
        at: now().toISOString(),
        note,
        ...(account ? { account } : {}),
        ...result,
        error: result.error == null ? null : redactSecrets(result.error).slice(0, 500),
      };
      const json = JSON.stringify(line);
      print(json);
      // A re-run reaching the same submitted outcome reuses its row; every failure is its own event.
      if (seen.has(outcomeKey(line))) return;
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
