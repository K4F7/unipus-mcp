/**
 * 学习档案 → 学习报告（周/期视图）。只读。
 * GET https://ucloud.unipus.cn/api/uls/user/profile/learning-report
 *   ?skillType=speak|listen&periodType=week&periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 * Captured 2026-10-14 (nixos redroid, App 2.8.8). Headers mirror the App WebView (ulsCloudHeaders).
 */
import { requireConfiguredJwt, type AuthPorts } from "./auth.js";
import { summarizeHttpErrorBody } from "./http.js";
import { authRequired, toolError, type ToolResult } from "./result.js";
import { parseJsonPreservingLargeInts } from "./safe-json.js";
import { ulsCloudHeaders } from "./uls-business.js";

export const DEFAULT_LEARNING_REPORT_URL =
  "https://ucloud.unipus.cn/api/uls/user/profile/learning-report";

export type LearningReportPorts = AuthPorts & {
  env?: NodeJS.ProcessEnv;
  learningReportUrl?: string;
  now?: () => Date;
};

export type NamedScore = { name: string; value: number | null };
export type RadarScore = { skillName: string; dimensionCode: number | string | null; value: number | null };

export type LearningReport = {
  hasData: boolean;
  periodLabel: string | null;
  periodStart: string;
  periodEnd: string;
  kpi: { avgScore: number | null; count: number | null; durationHours: number | null };
  topicScores: NamedScore[];
  genreScores: NamedScore[];
  skillRadar: RadarScore[];
  reportTime: string | null;
};

export type LearningReportResult =
  | (ToolResult & { isError: false; skillType: string; periodType: string; report: LearningReport })
  | ToolResult;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Monday–Sunday week containing `now`, in Asia/Shanghai (UTC+8). */
export function currentWeekRange(now: Date = new Date()): { start: string; end: string } {
  const sh = new Date(now.getTime() + 8 * 3600_000);
  const dow = (sh.getUTCDay() + 6) % 7; // Mon=0
  const mon = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() - dow));
  const sun = new Date(mon.getTime() + 6 * 86400_000);
  return { start: ymd(mon), end: ymd(sun) };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x) => x != null && typeof x === "object") as Record<string, unknown>[] : [];
}

export function parseLearningReport(value: unknown, fallback: { start: string; end: string }): LearningReport | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const kpi = (v.kpi ?? {}) as Record<string, unknown>;
  return {
    hasData: v.hasData === true,
    periodLabel: str(v.periodLabel),
    periodStart: str(v.periodStart) ?? fallback.start,
    periodEnd: str(v.periodEnd) ?? fallback.end,
    kpi: { avgScore: num(kpi.avgScore), count: num(kpi.count), durationHours: num(kpi.durationHours) },
    topicScores: arr(v.topicScores).map((x) => ({ name: String(x.name ?? ""), value: num(x.value) })),
    genreScores: arr(v.genreScores).map((x) => ({ name: String(x.name ?? ""), value: num(x.value) })),
    skillRadar: arr(v.skillRadar).map((x) => ({
      skillName: String(x.skillName ?? ""),
      dimensionCode: (num(x.dimensionCode) ?? str(x.dimensionCode)) as number | string | null,
      value: num(x.value),
    })),
    reportTime: str(v.reportTime),
  };
}

export async function getLearningReport(
  ports: LearningReportPorts,
  input: { skillType?: string; periodType?: string; periodStart?: string; periodEnd?: string } = {},
): Promise<LearningReportResult> {
  const skillType = (input.skillType ?? "speak").trim() || "speak";
  const periodType = (input.periodType ?? "week").trim() || "week";
  const def = currentWeekRange(ports.now?.() ?? new Date());
  const start = input.periodStart ?? def.start;
  const end = input.periodEnd ?? (input.periodStart != null
    ? ymd(new Date(Date.parse(`${input.periodStart}T00:00:00Z`) + 6 * 86400_000))
    : def.end);
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return toolError("INVALID_ARGUMENT", "periodStart/periodEnd 须为 YYYY-MM-DD");
  }

  const loaded = await requireConfiguredJwt(ports.credentials);
  if (!loaded.ok) return loaded.result;

  const base = ports.learningReportUrl ?? ports.env?.UNIPUS_LEARNING_REPORT_URL?.trim() ?? DEFAULT_LEARNING_REPORT_URL;
  const qs = new URLSearchParams({ skillType, periodType, periodStart: start, periodEnd: end });
  const headers = ulsCloudHeaders(loaded.jwt, ports.env);
  headers["u-app-id"] = headers.sourceid ?? "116";
  let res: { statusCode: number; body: string };
  try {
    res = await ports.http.request({ url: `${base || DEFAULT_LEARNING_REPORT_URL}?${qs}`, method: "GET", headers });
  } catch (e) {
    return toolError("NETWORK_ERROR", `learning-report 网络失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.statusCode === 401) {
    return authRequired(`learning-report 401：${summarizeHttpErrorBody(res.body) ?? "JWT 无效或已过期"}`);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const hint = summarizeHttpErrorBody(res.body);
    return toolError("HTTP_ERROR", `learning-report HTTP ${res.statusCode}${hint != null ? `：${hint}` : ""}`);
  }
  let root: Record<string, unknown>;
  try {
    root = parseJsonPreservingLargeInts(res.body) as Record<string, unknown>;
  } catch {
    return toolError("PARSE_ERROR", "learning-report 响应无法解析");
  }
  if (root == null || typeof root !== "object") return toolError("PARSE_ERROR", "learning-report 响应无法解析");
  if (num(root.code) !== 1) {
    return toolError("BUSINESS_ERROR", `learning-report 业务码 ${String(root.code)}${typeof root.msg === "string" ? `：${root.msg}` : ""}`);
  }
  const report = parseLearningReport(root.value, { start, end });
  if (report == null) return toolError("PARSE_ERROR", "learning-report value 无法解析");
  return {
    isError: false,
    status: "ok",
    code: "OK",
    message: `learning-report ${skillType} ${report.periodStart}~${report.periodEnd} hasData=${report.hasData} avg=${report.kpi.avgScore ?? "-"} n=${report.kpi.count ?? 0}`,
    skillType,
    periodType,
    report,
  } as LearningReportResult;
}
