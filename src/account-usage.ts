/**
 * Per-account usage window, stored on meta.json (not parsed from note text).
 *
 * self: 自用，没有到期日。
 * assist: 帮别人刷。到期日是 Asia/Shanghai 的 YYYY-MM-DD，含当天；次日周任务跳过。
 * 学期边界只在配置时用来算出 expires_at。已写入的日期不会随规则重算。
 * 按月的到期日停在起始日所在学期的结束日，不进入下学期。
 *
 * 两种模式都能写每周听力/口语篇数。null 表示用平台 weekFrequency。
 * 写成数字后，周任务目标是 min(配置, 平台达标数)。
 */
export type UsageMode = "self" | "assist";

/** open = 自用。months / semester / until 记录到期日是怎么来的。 */
export type UsageTerm = "open" | "months" | "semester" | "until";

/** 每周篇数。0 表示这一侧本周不做。 */
export const WEEK_QUOTA_MIN = 0;
export const WEEK_QUOTA_MAX = 30;

export type AccountUsage = {
  mode: UsageMode;
  /** 最后有效日（含）。自用为 null。 */
  expires_at: string | null;
  term: UsageTerm;
  /** term=months 时的月数，否则 null。 */
  months: number | null;
  /** 帮刷窗口的起始日。自用为 null。 */
  started_at: string | null;
  /** 每周听力篇数。null = 平台 weekFrequency。 */
  listen_per_week: number | null;
  /** 每周口语篇数。null = 平台 weekFrequency。 */
  speak_per_week: number | null;
};

export const USAGE_MONTHS_MIN = 1;
export const USAGE_MONTHS_MAX = 24;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function selfUsage(): AccountUsage {
  return {
    mode: "self",
    expires_at: null,
    term: "open",
    months: null,
    started_at: null,
    listen_per_week: null,
    speak_per_week: null,
  };
}

export function normalizePerWeek(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < WEEK_QUOTA_MIN || value > WEEK_QUOTA_MAX) return null;
  return value;
}

function readWeekQuota(raw: unknown): Pick<AccountUsage, "listen_per_week" | "speak_per_week"> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { listen_per_week: null, speak_per_week: null };
  }
  const rec = raw as Record<string, unknown>;
  return {
    listen_per_week: normalizePerWeek(rec.listen_per_week),
    speak_per_week: normalizePerWeek(rec.speak_per_week),
  };
}

/**
 * 周任务达标数。未配置篇数时用平台 weekFrequency。
 * 配置后不超过平台达标数。平台总数未知时返回 null。
 */
export function effectiveWeekTotal(
  platformTotal: number | null,
  perWeek: number | null,
): number | null {
  if (platformTotal == null || !Number.isFinite(platformTotal)) return null;
  if (perWeek == null) return platformTotal;
  return Math.min(platformTotal, perWeek);
}

/** Calendar date in Asia/Shanghai, YYYY-MM-DD. */
export function shanghaiDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match == null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

/** Add calendar months. Day clamps to the target month (1月31日 + 1个月 = 2月28/29日). */
export function addCalendarMonths(isoDate: string, months: number): string {
  if (!isIsoDate(isoDate)) {
    throw new Error(`日期非法：${isoDate}`);
  }
  const [yearText, monthText, dayText] = isoDate.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const target = monthIndex + months;
  const nextYear = year + Math.floor(target / 12);
  const nextMonth = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const clamped = Math.min(day, lastDay);
  const mm = String(nextMonth + 1).padStart(2, "0");
  const dd = String(clamped).padStart(2, "0");
  return `${nextYear}-${mm}-${dd}`;
}

/**
 * 起始日所在学期的最后一天。不在学期内则返回 null。
 * 秋：9月1日–次年1月15日。春：2月20日–7月10日。
 * 1月16日–2月19日、7月11日–8月31日是假期，没有本学期。
 */
export function currentSemesterEnd(isoDate: string): string | null {
  if (!isIsoDate(isoDate)) {
    throw new Error(`日期非法：${isoDate}`);
  }
  const [yearText, monthText, dayText] = isoDate.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month >= 9) return `${year + 1}-01-15`;
  if (month === 1 && day <= 15) return `${year}-01-15`;
  if ((month === 2 && day >= 20) || (month >= 3 && month <= 6) || (month === 7 && day <= 10)) {
    return `${year}-07-10`;
  }
  return null;
}

/**
 * `--semester` 用的结束日。学期内等于本学期结束日。
 * 假期落到下一学期结束日：1月16日–2月19日 → 当年7月10日；7月11日–8月31日 → 次年1月15日。
 */
export function semesterEnd(isoDate: string): string {
  const current = currentSemesterEnd(isoDate);
  if (current != null) return current;
  if (!isIsoDate(isoDate)) throw new Error(`日期非法：${isoDate}`);
  const [yearText, monthText, dayText] = isoDate.split("-");
  const year = Number(yearText);
  const key = Number(monthText) * 100 + Number(dayText);
  if (key <= 219) return `${year}-07-10`;
  return `${year + 1}-01-15`;
}

/** True when a saved months window was shortened so it stays inside its semester. */
export function monthWindowCapped(usage: AccountUsage): boolean {
  if (
    usage.term !== "months" ||
    usage.months == null ||
    usage.started_at == null ||
    usage.expires_at == null
  ) {
    return false;
  }
  return usage.expires_at !== addCalendarMonths(usage.started_at, usage.months);
}

export function assistMonths(months: number, startedAt: string): AccountUsage {
  if (!Number.isInteger(months) || months < USAGE_MONTHS_MIN || months > USAGE_MONTHS_MAX) {
    throw new Error(`months 须为 ${USAGE_MONTHS_MIN}–${USAGE_MONTHS_MAX} 的整数`);
  }
  if (!isIsoDate(startedAt)) throw new Error(`起始日非法：${startedAt}`);
  const added = addCalendarMonths(startedAt, months);
  // 学期内：截到本学期结束日。假期起算：截到下一学期结束日（与 --semester 一致），不跨多个学期。
  const semester = semesterEnd(startedAt);
  return {
    mode: "assist",
    expires_at: added > semester ? semester : added,
    term: "months",
    months,
    started_at: startedAt,
    listen_per_week: null,
    speak_per_week: null,
  };
}

export function assistSemester(startedAt: string): AccountUsage {
  if (!isIsoDate(startedAt)) throw new Error(`起始日非法：${startedAt}`);
  return {
    mode: "assist",
    expires_at: semesterEnd(startedAt),
    term: "semester",
    months: null,
    started_at: startedAt,
    listen_per_week: null,
    speak_per_week: null,
  };
}

export function assistUntil(until: string, startedAt: string): AccountUsage {
  if (!isIsoDate(until)) throw new Error(`到期日非法：${until}`);
  if (!isIsoDate(startedAt)) throw new Error(`起始日非法：${startedAt}`);
  if (until < startedAt) throw new Error("到期日不能早于起始日");
  return {
    mode: "assist",
    expires_at: until,
    term: "until",
    months: null,
    started_at: startedAt,
    listen_per_week: null,
    speak_per_week: null,
  };
}

/** Missing or non-assist values are self. A broken assist record stays assist so it cannot keep grinding. */
export function normalizeUsage(raw: unknown): AccountUsage {
  const quota = readWeekQuota(raw);
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return selfUsage();
  }
  const rec = raw as Record<string, unknown>;
  if (rec.mode !== "assist") return { ...selfUsage(), ...quota };
  const expires =
    typeof rec.expires_at === "string" && isIsoDate(rec.expires_at)
      ? rec.expires_at
      : null;
  const started =
    typeof rec.started_at === "string" && isIsoDate(rec.started_at)
      ? rec.started_at
      : null;
  const term: UsageTerm =
    rec.term === "months" || rec.term === "semester" || rec.term === "until"
      ? rec.term
      : "until";
  const months =
    term === "months" &&
    typeof rec.months === "number" &&
    Number.isInteger(rec.months) &&
    rec.months >= USAGE_MONTHS_MIN &&
    rec.months <= USAGE_MONTHS_MAX
      ? rec.months
      : null;
  return {
    mode: "assist",
    expires_at: expires,
    term,
    months,
    started_at: started,
    ...quota,
  };
}

/** Assist with no date, or a date before today, is expired. expires_at itself is still valid. */
export function isUsageExpired(usage: AccountUsage, today = shanghaiDate()): boolean {
  if (usage.mode !== "assist") return false;
  if (usage.expires_at == null) return true;
  return today > usage.expires_at;
}

/** Assist whose started_at is still in the future (Asia/Shanghai date): not active yet. */
export function isUsageNotStarted(usage: AccountUsage, today = shanghaiDate()): boolean {
  if (usage.mode !== "assist") return false;
  return usage.started_at != null && today < usage.started_at;
}

function formatPerWeek(value: number | null): string {
  return value == null ? "platform" : String(value);
}

function formatWeekQuota(usage: AccountUsage): string {
  return ` listen=${formatPerWeek(usage.listen_per_week)}/wk speak=${formatPerWeek(usage.speak_per_week)}/wk`;
}

export function formatUsage(usage: AccountUsage, today = shanghaiDate()): string {
  const quota = formatWeekQuota(usage);
  if (usage.mode === "self") return `usage=self${quota}`;
  const months = usage.months != null ? ` months=${usage.months}` : "";
  const started = usage.started_at != null ? ` from=${usage.started_at}` : "";
  const until = usage.expires_at ?? "?";
  const expired = isUsageExpired(usage, today)
    ? " expired"
    : isUsageNotStarted(usage, today)
      ? " not_started"
      : "";
  return `usage=assist term=${usage.term}${months}${started} until=${until}${expired}${quota}`;
}

/** undefined = 这次不改，沿用已保存的篇数。null = 改回平台 weekFrequency。 */
export type WeekQuotaPatch = {
  listen_per_week?: number | null;
  speak_per_week?: number | null;
};

export type UsageCommand =
  | { kind: "self"; quota: WeekQuotaPatch }
  | {
      kind: "assist";
      quota: WeekQuotaPatch;
      spec:
        | { term: "months"; months: number; from?: string }
        | { term: "semester"; from?: string }
        | { term: "until"; until: string; from?: string };
    };

const USAGE_SYNTAX =
  "usage: accounts.ts usage <id> self [--listen N|platform] [--speak N|platform] | assist --months N | assist --semester | assist --until YYYY-MM-DD [--from YYYY-MM-DD] [--listen N|platform] [--speak N|platform]";

function parsePerWeekToken(flag: string, value: string): number | null | string {
  if (value === "platform") return null;
  if (!/^\d+$/.test(value)) {
    return `${flag} 需要 ${WEEK_QUOTA_MIN}–${WEEK_QUOTA_MAX} 的整数，或 platform`;
  }
  const parsed = Number(value);
  if (parsed > WEEK_QUOTA_MAX) {
    return `${flag} 需要 ${WEEK_QUOTA_MIN}–${WEEK_QUOTA_MAX} 的整数，或 platform`;
  }
  return parsed;
}

/** Returns an error string, or null after writing the flag into quota. */
function assignQuotaFlag(
  quota: WeekQuotaPatch,
  flag: "--listen" | "--speak",
  value: string | undefined,
): string | null {
  const key = flag === "--listen" ? "listen_per_week" : "speak_per_week";
  if (quota[key] !== undefined) return `${flag} 重复`;
  if (value == null || value.startsWith("--")) return `${flag} 需要一个值`;
  const parsed = parsePerWeekToken(flag, value);
  if (typeof parsed === "string") return parsed;
  quota[key] = parsed;
  return null;
}

function parseQuotaFlags(
  rest: string[],
): { ok: true; quota: WeekQuotaPatch } | { ok: false; error: string } {
  const quota: WeekQuotaPatch = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag !== "--listen" && flag !== "--speak") {
      return { ok: false, error: `未知参数 ${flag}` };
    }
    const error = assignQuotaFlag(quota, flag, rest[i + 1]);
    if (error != null) return { ok: false, error };
    i++;
  }
  return { ok: true, quota };
}

export function parseUsageArgs(
  argv: string[],
): { ok: true; command: UsageCommand } | { ok: false; error: string } {
  const [head, ...rest] = argv;
  if (head === "self") {
    const quota = parseQuotaFlags(rest);
    if (!quota.ok) return quota;
    return { ok: true, command: { kind: "self", quota: quota.quota } };
  }
  if (head !== "assist") {
    return { ok: false, error: USAGE_SYNTAX };
  }
  let months: number | null = null;
  let semester = false;
  let until: string | null = null;
  let from: string | undefined;
  const quota: WeekQuotaPatch = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--semester") {
      semester = true;
      continue;
    }
    if (flag === "--listen" || flag === "--speak") {
      const error = assignQuotaFlag(quota, flag, rest[i + 1]);
      if (error != null) return { ok: false, error };
      i++;
      continue;
    }
    const value = rest[i + 1];
    if (value == null || value.startsWith("--")) {
      return { ok: false, error: `${flag} 需要一个值` };
    }
    if (flag === "--months") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) return { ok: false, error: "--months 需要整数" };
      months = parsed;
      i++;
      continue;
    }
    if (flag === "--until") {
      until = value;
      i++;
      continue;
    }
    if (flag === "--from") {
      from = value;
      i++;
      continue;
    }
    return { ok: false, error: `未知参数 ${flag}` };
  }
  const chosen = [months != null, semester, until != null].filter(Boolean).length;
  if (chosen !== 1) {
    return { ok: false, error: "assist 需要且只能指定 --months、--semester、--until 之一" };
  }
  if (from != null && !isIsoDate(from)) return { ok: false, error: "--from 须为 YYYY-MM-DD" };
  if (months != null) {
    return { ok: true, command: { kind: "assist", quota, spec: { term: "months", months, from } } };
  }
  if (semester) {
    return { ok: true, command: { kind: "assist", quota, spec: { term: "semester", from } } };
  }
  if (until == null || !isIsoDate(until)) return { ok: false, error: "--until 须为 YYYY-MM-DD" };
  return { ok: true, command: { kind: "assist", quota, spec: { term: "until", until, from } } };
}

export function usageFromCommand(
  command: UsageCommand,
  now: Date = new Date(),
  previous?: AccountUsage | null,
): AccountUsage {
  const base =
    command.kind === "self"
      ? selfUsage()
      : command.spec.term === "months"
        ? assistMonths(command.spec.months, command.spec.from ?? shanghaiDate(now))
        : command.spec.term === "semester"
          ? assistSemester(command.spec.from ?? shanghaiDate(now))
          : assistUntil(command.spec.until, command.spec.from ?? shanghaiDate(now));
  return {
    ...base,
    listen_per_week:
      command.quota.listen_per_week !== undefined
        ? command.quota.listen_per_week
        : previous?.listen_per_week ?? null,
    speak_per_week:
      command.quota.speak_per_week !== undefined
        ? command.quota.speak_per_week
        : previous?.speak_per_week ?? null,
  };
}
