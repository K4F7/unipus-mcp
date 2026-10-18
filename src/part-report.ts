/**
 * Read-only App report per speak part (#92), the same request the App report
 * page makes: GET {uadaptive}/api/uls/oral/train/part-report?taskId&ansVersion&partId
 * (JWT only). Scores live in data["<template>_subjective"].totalScore; code 500
 * 「报告尚未生成完成」 means the server has not generated that report (yet).
 * trainingScoreReport / part/get reportStatus are NOT the server's part scores.
 */
import type { AuthPorts } from "./auth.js";
import { pollWithin, type PollBudget } from "./limits.js";
import { ulsCloudHeaders } from "./uls-business.js";
import { markProgress } from "./watchdog.js";

export type PartReportPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  clockMs?: () => number;
};

export type PartScore = {
  partId: string;
  score: number | null;
  /**
   * ok = report generated; pending = 500 报告尚未生成完成; failed = any other explicit server
   * code (final, not polled again); error = transport / unreadable reply (polled again).
   */
  status: "ok" | "pending" | "failed" | "error";
  detail?: string;
  /** 自由表达: words the server ASR heard (userResponse.fullText). */
  asrWords?: number;
};

/** Report blocks in preference order; each part's data holds only its own. */
const SCORE_KEYS = [
  "ai-spoken_subjective",
  "oral-personal-state_subjective",
  "oral-sentence-scoop_subjective",
  "oral-sentence_subjective",
];

type Block = { totalScore?: unknown; userResponse?: { fullText?: unknown } };

/** Parse one part-report body into a PartScore (exported for tests). */
export function parsePartReport(partId: string, body: string): PartScore {
  let j: { code?: unknown; message?: unknown; data?: Record<string, Block> | null };
  try {
    j = JSON.parse(body);
  } catch {
    return { partId, score: null, status: "error", detail: `非 JSON：${body.slice(0, 80)}` };
  }
  const data = j?.data;
  if (Number(j?.code) === 200 && data && typeof data === "object") {
    const keys = [...SCORE_KEYS, ...Object.keys(data).filter((k) => k.endsWith("_subjective"))];
    const key = keys.find((k) => typeof data[k]?.totalScore === "number");
    if (key) {
      const block = data[key]!;
      const text = block.userResponse?.fullText;
      return {
        partId,
        score: block.totalScore as number,
        status: "ok",
        ...(typeof text === "string" ? { asrWords: text.split(/\s+/).filter(Boolean).length } : {}),
      };
    }
  }
  const msg = String(j?.message ?? "");
  if (Number(j?.code) === 500 && /尚未生成/.test(msg)) return { partId, score: null, status: "pending", detail: msg };
  if (j?.code != null) return { partId, score: null, status: "failed", detail: `code=${String(j.code)} ${msg}`.slice(0, 120) };
  return { partId, score: null, status: "error", detail: `无 code：${body.slice(0, 80)}` };
}

const isFinal = (s: PartScore) => s.status === "ok" || s.status === "failed";

export async function readPartReport(
  ports: PartReportPorts,
  input: { taskId: string; ansVersion: number; partId: string },
): Promise<PartScore> {
  const jwt = await ports.credentials.getJwt();
  if (!jwt) return { partId: input.partId, score: null, status: "error", detail: "no jwt" };
  const origin = ports.env?.UNIPUS_ULS_ADAPTIVE_ORIGIN?.trim() || "https://uadaptive.unipus.cn";
  const q = new URLSearchParams({ taskId: input.taskId, ansVersion: String(input.ansVersion), partId: input.partId });
  try {
    const res = await ports.http.request({
      url: `${origin}/api/uls/oral/train/part-report?${q}`,
      method: "GET",
      headers: ulsCloudHeaders(jwt, ports.env),
    });
    return parsePartReport(input.partId, res.body);
  } catch (error) {
    return { partId: input.partId, score: null, status: "error", detail: (error as Error).message?.slice(0, 120) };
  }
}

/**
 * Poll every part's report until all are generated or the budget runs out.
 * Returns partName → last PartScore (a part still pending at the end stays pending).
 */
export async function pollPartReports(
  ports: PartReportPorts,
  input: { taskId: string; ansVersion: number; parts: Array<{ partId: string; partName: string }> },
  budget: PollBudget,
): Promise<Record<string, PartScore>> {
  const out: Record<string, PartScore> = {};
  await pollWithin(
    budget,
    async () => {
      markProgress(`speak:part-report ${input.taskId}`);
      for (const p of input.parts) {
        const name = p.partName || p.partId;
        if (out[name] && isFinal(out[name]!)) continue;
        out[name] = await readPartReport(ports, { taskId: input.taskId, ansVersion: input.ansVersion, partId: p.partId });
      }
      const waiting = Object.entries(out).filter(([, s]) => !isFinal(s)).map(([n, s]) => `${n}:${s.status}`);
      console.error(`[part-report] ${input.taskId} ${waiting.length ? `未出：${waiting.join(" ")}` : "全部结束"}`);
      return waiting.length === 0 ? true : undefined;
    },
    { sleep: ports.sleep, now: ports.clockMs },
  );
  return out;
}
