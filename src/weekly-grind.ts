/**
 * Stateless weekly listen/speak grind orchestrator for harness routines.
 * Never prints jwt/rt/password. Does not thrash active-account by default
 * (refresh/login saves with makeActive:false, syncLegacy:false).
 */
import {
  effectiveWeekTotal,
  isUsageExpired,
  isUsageNotStarted,
  normalizeUsage,
  selfUsage,
  shanghaiDate,
  type AccountUsage,
} from "./account-usage.js";
import {
  listAccounts,
  normalizeGrind,
  readAccountMeta,
  readAccountRt,
  readActiveAccountId,
  resolveAccountPassword,
  resolveAccountUsername,
  type AccountFs,
  type GrindMode,
  type ListedAccount,
} from "./accounts.js";
import { createFetchUnipusHttp, type UnipusHttp } from "./http.js";
import {
  createStaticJwtStore,
  type JwtCredentialStore,
} from "./credentials.js";
import { grindListenGaps, type GrindListenPorts } from "./grind-listen.js";
import { runAutoPlacement, type GrindPlacementPorts } from "./grind-placement.js";
import { grindSpeakGaps, type GrindSpeakPorts } from "./grind-speak.js";
import { probeLlm, resolveLlmAsk, type LlmAsk } from "./choice-solver.js";
import {
  loginWithPassword,
  refreshWithRt,
  saveLoginTokens,
} from "./sso-login.js";
import { listWeekProgress, type WeekProgressPorts } from "./week-progress.js";
import { classifyError, toError, type ErrorClass } from "./retry.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountDir } from "./accounts.js";
import type { PaperReporter } from "./paper-result.js";
import { markProgress } from "./watchdog.js";
import { resolveNetWait } from "./limits.js";
import { defaultNetworkWaiter, isNetworkFailure, networkDownReason, type NetworkWaiter } from "./net-wait.js";

export type ProgressSnap = {
  listen_done: number | null;
  listen_total: number | null;
  speak_done: number | null;
  speak_total: number | null;
};

export type AccountGrindSummary = {
  account_id: string;
  alias: string | null;
  note: string | null;
  /** Effective grind policy after CLI override ?? meta.grind ?? both. */
  grind: GrindMode;
  status:
    | "done"
    | "ground"
    | "skipped_done"
    | "skipped_captcha"
    | "skipped_expired"
    | "skipped_not_started"
    | "needs_placement"
    | "error";
  before: ProgressSnap | null;
  after: ProgressSnap | null;
  listen_completed: number;
  speak_completed: number;
  /** Non-null when listen side skipped by CLI/meta policy. */
  listen_skipped: string | null;
  /** Non-null when speak side skipped by CLI/meta policy. */
  speak_skipped: string | null;
  /** self 不过期；assist 带到期日。两边都可以带每周听力/口语篇数。缺省档案按 self。 */
  usage: AccountUsage;
  /** Non-null when usage stopped this run (assist expired / not started / all quotas 0). */
  usage_skip: string | null;
  errors: string[];
  /** Non-fatal notes (e.g. no LLM configured, unanswered listen questions). */
  warnings?: string[];
  /** Network stayed down past UNIPUS_NET_WAIT_MAX_MS (#102): resumable by re-running. */
  network_down?: boolean;
  /** Set when the account run threw unexpectedly (TIMEOUT/NETWORK/FORBIDDEN/…). */
  error_class?: ErrorClass;
};

export type WeeklyGrindSummary = {
  accounts: AccountGrindSummary[];
  /** Counts by status, for quick routine triage. */
  totals?: Record<string, number>;
  started_at: string;
  finished_at: string;
};

export type WeeklyGrindPorts = AccountFs & {
  http?: UnipusHttp;
  /** LLM for every answer (listen / speak / placement); default from UNIPUS_LLM_* (required). */
  llmAsk?: LlmAsk;
  /**
   * When true, do not auto-run placement on NEEDS_PLACEMENT.
   * CLI --skip-placement or meta.skip_placement.
   */
  skipPlacement?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Network-outage wait (#102); default probes ucloud + LLM gateway with backoff up to UNIPUS_NET_WAIT_MAX_MS. */
  waitNetwork?: NetworkWaiter;
  /** Override progress listing (tests). */
  listProgress?: (
    credentials: JwtCredentialStore,
  ) => Promise<ProgressSnap | { error: string; code?: string }>;
  grindListen?: (
    ports: GrindListenPorts,
    need: number,
  ) => Promise<SideResult>;
  grindSpeak?: (
    ports: GrindSpeakPorts,
    need: number,
  ) => Promise<SideResult>;
  refreshRt?: typeof refreshWithRt;
  loginPassword?: typeof loginWithPassword;
  /** When false (default), never call makeActive/syncLegacy on token save. */
  touchActive?: boolean;
  /** Clock for assist expiry (Asia/Shanghai date). */
  now?: () => Date;
  /**
   * CLI grind override (--listen-only / --speak-only).
   * null/undefined → use meta.grind (default both).
   */
  grindOverride?: GrindMode | null;
  /**
   * Per-account result reporter (#88): one JSON line per paper on stdout + JSONL
   * status file. CLI passes createPaperReporter; omitted → no per-paper lines.
   */
  resultsFor?: (note: string | null, accountId: string) => Promise<PaperReporter>;
};

type SideResult = {
  completed: number;
  taskIds: string[];
  stoppedReason?: string;
  errorClass?: ErrorClass;
  warnings?: string[];
  /** A paper was refused (no valid LLM answer): account stops, counts as failure. */
  refused?: boolean;
  /** Network stayed down past the wait cap (#102). */
  networkDown?: boolean;
};

export type SelectAccountsMode =
  | { kind: "all" }
  | { kind: "active" }
  | { kind: "ids"; ids: string[] };

export type ParsedWeeklyGrindArgs = {
  mode: SelectAccountsMode;
  help: boolean;
  /** CLI --listen-only / --speak-only; null = no override (use meta). */
  grindOverride: GrindMode | null;
  /** CLI --skip-placement: never auto-run 定级. */
  skipPlacement: boolean;
  /** Set when --listen-only and --speak-only both present. */
  error?: string;
};

/** Parse CLI argv into account selection + optional grind side override. */
export function parseWeeklyGrindArgs(argv: string[]): ParsedWeeklyGrindArgs {
  let help = false;
  let all = false;
  let listenOnly = false;
  let speakOnly = false;
  let skipPlacement = false;
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--all") all = true;
    else if (a === "--listen-only") listenOnly = true;
    else if (a === "--speak-only") speakOnly = true;
    else if (a === "--skip-placement") skipPlacement = true;
    else if (a === "--account" || a === "-a") {
      const id = argv[++i]?.trim();
      if (id) ids.push(id);
    } else if (a.startsWith("--account=")) {
      const id = a.slice("--account=".length).trim();
      if (id) ids.push(id);
    }
  }
  if (listenOnly && speakOnly) {
    return {
      mode: { kind: "active" },
      help,
      grindOverride: null,
      skipPlacement,
      error: "--listen-only 与 --speak-only 互斥",
    };
  }
  const grindOverride: GrindMode | null = listenOnly
    ? "listen"
    : speakOnly
      ? "speak"
      : null;
  if (help) return { mode: { kind: "active" }, help: true, grindOverride, skipPlacement };
  if (all) return { mode: { kind: "all" }, help: false, grindOverride, skipPlacement };
  if (ids.length > 0) return { mode: { kind: "ids", ids }, help: false, grindOverride, skipPlacement };
  return { mode: { kind: "active" }, help: false, grindOverride, skipPlacement };
}

/** effective = CLI override ?? meta.grind ?? both */
export function resolveEffectiveGrind(
  cliOverride: GrindMode | null | undefined,
  metaGrind: unknown,
): GrindMode {
  if (cliOverride != null) return cliOverride;
  return normalizeGrind(metaGrind);
}

export function grindSides(mode: GrindMode): { listen: boolean; speak: boolean } {
  return {
    listen: mode === "both" || mode === "listen",
    speak: mode === "both" || mode === "speak",
  };
}

function policySkipReason(
  side: "listen" | "speak",
  effective: GrindMode,
  cliOverride: GrindMode | null | undefined,
): string {
  if (cliOverride != null) {
    return side === "listen"
      ? "CLI --speak-only"
      : "CLI --listen-only";
  }
  return `meta.grind=${effective}`;
}

export async function resolveTargetAccounts(
  mode: SelectAccountsMode,
  options: AccountFs = {},
): Promise<ListedAccount[]> {
  const listed = await listAccounts(options);
  const withCreds = listed.filter((a) => a.has_jwt || a.has_rt);
  if (mode.kind === "all") return withCreds;
  if (mode.kind === "ids") {
    const out: ListedAccount[] = [];
    for (const id of mode.ids) {
      const row = listed.find((a) => a.account_id === id);
      if (row) out.push(row);
      else {
        out.push({
          account_id: id,
          active: false,
          has_jwt: false,
          has_rt: false,
          has_password: false,
          alias: null,
          note: null,
          grind: "both",
          usage: selfUsage(),
          last_login_at: null,
          last_refresh_at: null,
        });
      }
    }
    return out;
  }
  // active only
  const activeId = await readActiveAccountId(options);
  if (activeId == null) return [];
  const row = withCreds.find((a) => a.account_id === activeId);
  if (row) return [row];
  // active pointer exists but no jwt|rt in archive — still try if listed
  const any = listed.find((a) => a.account_id === activeId);
  return any ? [any] : [];
}

async function readAccountJwt(
  accountId: string,
  options: AccountFs,
): Promise<string | null> {
  const p = {
    env: options.env ?? process.env,
    home: options.home,
    readFile:
      options.readFile ??
      (async (path: string) => readFile(path, "utf8")),
  };
  const path = join(accountDir(accountId, p.env, p.home ?? undefined), "jwt");
  try {
    const raw = (await p.readFile(path, "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export type EnsureAuthResult =
  | { ok: true; jwt: string }
  | { ok: false; code: "CAPTCHA_REQUIRED" | "AUTH_FAILED"; message: string };

/**
 * Refresh via rt when present; else/fail password from env.
 * Saves tokens without changing active/legacy unless touchActive.
 */
export async function ensureAccountAuth(
  accountId: string,
  ports: WeeklyGrindPorts,
): Promise<EnsureAuthResult> {
  const env = ports.env ?? process.env;
  const fsOpts: AccountFs = {
    env,
    home: ports.home,
    readFile: ports.readFile,
    writeFile: ports.writeFile,
    mkdir: ports.mkdir,
    chmod: ports.chmod,
    rename: ports.rename,
    readdir: ports.readdir,
  };
  const refresh = ports.refreshRt ?? refreshWithRt;
  const login = ports.loginPassword ?? loginWithPassword;
  const touch = ports.touchActive === true;

  const rt = (await readAccountRt(accountId, fsOpts)) ?? "";
  let refreshCaptcha = false;
  // Last refresh / login failure text, kept so a network outage stays recognisable (#102).
  const failures: string[] = [];
  if (rt.length > 0) {
    const refreshed = await refresh(rt);
    if (!refreshed.ok) failures.push(`refresh: ${refreshed.message}`);
    if (refreshed.ok) {
      await saveLoginTokens(
        {
          accountId,
          jwt: refreshed.jwt,
          refreshToken: refreshed.refreshToken,
          jwtExpire: refreshed.jwtExpire,
          source: "refresh",
          makeActive: touch,
          syncLegacy: touch,
        },
        fsOpts,
      );
      return { ok: true, jwt: refreshed.jwt };
    }
    if (refreshed.code === "CAPTCHA_REQUIRED") {
      refreshCaptcha = true;
    }
  }

  const username = resolveAccountUsername(accountId, env);
  const password = (await resolveAccountPassword(accountId, fsOpts)) ?? "";
  if (username && password) {
    const result = await login({ username, password });
    if (!result.ok) {
      failures.push(`login: ${result.message}`);
      if (result.code === "CAPTCHA_REQUIRED") {
        return {
          ok: false,
          code: "CAPTCHA_REQUIRED",
          message: result.message,
        };
      }
      // non-captcha login fail → try existing jwt below
    } else {
      await saveLoginTokens(
        {
          accountId,
          jwt: result.jwt,
          refreshToken: result.refreshToken,
          jwtExpire: result.jwtExpire,
          source: "login",
          makeActive: touch,
          syncLegacy: touch,
        },
        fsOpts,
      );
      return { ok: true, jwt: result.jwt };
    }
  } else if (refreshCaptcha) {
    // 极验且无账密可回退 → 跳过该账户（不回退旧 jwt）
    return {
      ok: false,
      code: "CAPTCHA_REQUIRED",
      message: "refresh 触发极验且无 UNIPUS_USERNAME/PASSWORD 可回退",
    };
  }

  const existing = await readAccountJwt(accountId, fsOpts);
  if (existing != null) {
    return { ok: true, jwt: existing };
  }

  return {
    ok: false,
    code: "AUTH_FAILED",
    message:
      (rt.length > 0 ? "refresh 失败且无可用账密/jwt" : "无 rt；无账密可回退；无本地 jwt") +
      (failures.length ? `（${failures.join("；")}）` : ""),
  };
}

function snapFromProgress(p: {
  listen_done?: number | null;
  listen_total?: number | null;
  speak_done?: number | null;
  speak_total?: number | null;
}): ProgressSnap {
  return {
    listen_done: p.listen_done ?? null,
    listen_total: p.listen_total ?? null,
    speak_done: p.speak_done ?? null,
    speak_total: p.speak_total ?? null,
  };
}

function isAlreadyDone(
  snap: ProgressSnap,
  sides: { listen: boolean; speak: boolean },
  usage: AccountUsage,
): boolean {
  if (sides.listen) {
    const total = effectiveWeekTotal(snap.listen_total, usage.listen_per_week);
    if (total !== 0 && (snap.listen_done == null || total == null || snap.listen_done < total)) return false;
  }
  if (sides.speak) {
    const total = effectiveWeekTotal(snap.speak_total, usage.speak_per_week);
    if (total !== 0 && (snap.speak_done == null || total == null || snap.speak_done < total)) return false;
  }
  return sides.listen || sides.speak;
}

function needCount(
  done: number | null,
  platformTotal: number | null,
  perWeek: number | null,
): number {
  const total = effectiveWeekTotal(platformTotal, perWeek);
  if (done == null || total == null) return 0;
  return Math.max(0, total - done);
}

async function defaultListProgress(
  credentials: JwtCredentialStore,
  ports: WeeklyGrindPorts,
): Promise<ProgressSnap | { error: string; code?: string }> {
  const http = ports.http ?? createFetchUnipusHttp();
  const wp: WeekProgressPorts = {
    credentials,
    http,
    env: ports.env,
  };
  const result = await listWeekProgress(wp);
  if (result.isError) {
    return { error: `${result.code}: ${result.message}`, code: result.code };
  }
  return snapFromProgress(result);
}


/**
 * Re-run `step` while it fails for network reasons and the outage wait says the
 * network is back (#102). Returns the last result plus whether the wait gave up.
 */
async function untilNetworkUp<T>(
  step: () => Promise<T>,
  failure: (r: T) => string | null,
  wait: NetworkWaiter | undefined,
  label: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ result: T; down: boolean }> {
  // Bounded: a probe can pass while this step's own host stays unreachable.
  for (let left = resolveNetWait(env).retries; ; left--) {
    const result = await step();
    const detail = failure(result);
    if (detail == null || !wait || left <= 0 || !isNetworkFailure(detail)) return { result, down: false };
    if (!(await wait(`${label}：${detail}`))) return { result, down: true };
  }
}

/** Grind one account: auth → progress → gaps → re-check. */
export async function grindOneAccount(
  account: ListedAccount,
  ports: WeeklyGrindPorts = {},
): Promise<AccountGrindSummary> {
  const errors: string[] = [];
  const meta = await readAccountMeta(account.account_id, ports);
  const effective = resolveEffectiveGrind(ports.grindOverride, meta?.grind);
  const sides = grindSides(effective);
  const listen_skipped = sides.listen
    ? null
    : policySkipReason("listen", effective, ports.grindOverride);
  const speak_skipped = sides.speak
    ? null
    : policySkipReason("speak", effective, ports.grindOverride);
  const usage = normalizeUsage(meta?.usage ?? account.usage);
  const today = shanghaiDate(ports.now?.() ?? new Date());
  const base: AccountGrindSummary = {
    account_id: account.account_id,
    alias: meta?.alias ?? account.alias ?? null,
    note: meta?.note ?? account.note ?? null,
    grind: effective,
    status: "error",
    before: null,
    after: null,
    listen_completed: 0,
    speak_completed: 0,
    listen_skipped,
    speak_skipped,
    usage,
    usage_skip: null,
    errors,
  };

  if (isUsageExpired(usage, today)) {
    const until = usage.expires_at ?? "未写到期日";
    return {
      ...base,
      status: "skipped_expired",
      usage_skip: `帮刷已到期 ${until}（term=${usage.term}），周任务已跳过`,
    };
  }

  if (isUsageNotStarted(usage, today)) {
    return {
      ...base,
      status: "skipped_not_started",
      usage_skip: `帮刷尚未开始（from=${usage.started_at}），周任务已跳过`,
    };
  }

  // 0 = 这一侧本周不做。所有启用侧都是 0 时，在登录 / 定级之前就跳过，避免定级交卷。
  const listenZero = !sides.listen || usage.listen_per_week === 0;
  const speakZero = !sides.speak || usage.speak_per_week === 0;
  if ((sides.listen || sides.speak) && listenZero && speakZero) {
    return {
      ...base,
      status: "skipped_done",
      usage_skip: "本周配置篇数为 0（usage listen/speak），不登录、不定级、不交卷",
    };
  }

  // Answers come only from the LLM: missing config or a failed probe refuses before login / placement / any submit.
  let llmAsk: LlmAsk;
  try {
    llmAsk = ports.llmAsk ?? resolveLlmAsk(ports.env ?? process.env);
  } catch (error) {
    return { ...base, status: "error", errors: [toError(error).message] };
  }
  const netEnv = ports.env ?? process.env;
  // UNIPUS_NET_WAIT_MAX_MS=0 disables the wait: network failures count as before.
  const waitNetwork = ports.waitNetwork ?? (resolveNetWait(netEnv).maxMs > 0 ? defaultNetworkWaiter(netEnv) : undefined);
  const networkDown = (detail: string): AccountGrindSummary => ({
    ...base,
    status: "error",
    errors: [...errors, networkDownReason(detail)],
    error_class: "NETWORK",
    network_down: true,
  });
  const probe = await untilNetworkUp(
    () => probeLlm(llmAsk).then(() => null, (error: unknown) => toError(error).message),
    (r) => r,
    waitNetwork,
    "LLM 探活",
    ports.env,
  );
  if (probe.down) return networkDown(probe.result!);
  if (probe.result != null) return { ...base, status: "error", errors: [probe.result] };

  markProgress(`account:auth ${base.note ?? "(无备注)"}`);
  const authRun = await untilNetworkUp(
    () => ensureAccountAuth(account.account_id, ports),
    (a) => (a.ok ? null : a.message),
    waitNetwork,
    "登录",
    ports.env,
  );
  const auth = authRun.result;
  if (authRun.down && !auth.ok) return networkDown(auth.message);
  if (!auth.ok) {
    if (auth.code === "CAPTCHA_REQUIRED") {
      return {
        ...base,
        status: "skipped_captcha",
        errors: [`CAPTCHA_REQUIRED: ${auth.message}`],
      };
    }
    return {
      ...base,
      status: "error",
      errors: [`${auth.code}: ${auth.message}`],
    };
  }

  const credentials = createStaticJwtStore(auth.jwt);
  const http = ports.http ?? createFetchUnipusHttp();
  const rawListProgress = ports.listProgress ?? ((c) => defaultListProgress(c, ports));
  let progressDown = false;
  const listProgress = async (c: JwtCredentialStore) => {
    const r = await untilNetworkUp(() => rawListProgress(c), (p) => ("error" in p ? p.error : null), waitNetwork, "拉取进度", ports.env);
    progressDown ||= r.down;
    return r.result;
  };

  const beforeRaw = await listProgress(credentials);
  if (progressDown && "error" in beforeRaw) return networkDown(beforeRaw.error);
  if ("error" in beforeRaw) {
    const isPlacement =
      beforeRaw.code === "NEEDS_PLACEMENT" ||
      /NEEDS_PLACEMENT/.test(beforeRaw.error);
    if (!isPlacement) {
      return {
        ...base,
        status: "error",
        errors: [`progress: ${beforeRaw.error}`],
      };
    }

    const skip =
      ports.skipPlacement === true || meta?.skip_placement === true;
    if (skip) {
      return {
        ...base,
        status: "needs_placement",
        errors: [`needs_placement: ${beforeRaw.error}`],
      };
    }

    // usage 配额为 0 的一侧不自动定级（不交那一侧的定级卷）。
    const placeFlows = (["listen", "speak"] as const).filter((flow) =>
      flow === "listen" ? usage.listen_per_week !== 0 : usage.speak_per_week !== 0,
    );
    const placePorts: GrindPlacementPorts = {
      credentials,
      http,
      env: ports.env,
      llmAsk,
      flows: placeFlows,
    };
    const zeroQuotaNote =
      placeFlows.length < 2
        ? `usage 配额为 0 的一侧（${(["listen", "speak"] as const)
            .filter((f) => !placeFlows.includes(f))
            .join("/")}）不自动定级；若它仍在定级，平台进度拿不到另一侧计数，本周需先手动完成该侧定级或改配额`
        : null;
    const placed = await runAutoPlacement(placePorts);
    if (!placed.attempted) {
      return {
        ...base,
        status: "needs_placement",
        errors: [
          `needs_placement: ${beforeRaw.error}`,
          ...(zeroQuotaNote ? [zeroQuotaNote] : []),
        ],
      };
    }
    for (const side of [placed.listen, placed.speak]) {
      if (side && !side.ok) {
        errors.push(`placement_${side.flow}: ${side.detail}`);
      }
    }
    if ([placed.listen, placed.speak].some((side) => side && !side.ok && side.refused)) {
      return { ...base, status: "error", errors };
    }

    const afterPlace = await listProgress(credentials);
    if (progressDown && "error" in afterPlace) return networkDown(afterPlace.error);
    if ("error" in afterPlace) {
      return {
        ...base,
        status: "needs_placement",
        errors: [
          ...errors,
          `progress_after_placement: ${afterPlace.error}`,
          ...(zeroQuotaNote ? [zeroQuotaNote] : []),
        ],
      };
    }
    // fall through with fresh progress
    base.before = afterPlace;
  } else {
    base.before = beforeRaw;
  }

  if (base.before == null) {
    return {
      ...base,
      status: "error",
      errors: [...errors, "progress missing after placement handling"],
    };
  }

  if (isAlreadyDone(base.before, sides, usage)) {
    return {
      ...base,
      status: "skipped_done",
      after: base.before,
    };
  }

  const listenNeed = sides.listen
    ? needCount(base.before.listen_done, base.before.listen_total, usage.listen_per_week)
    : 0;
  const speakNeed = sides.speak
    ? needCount(base.before.speak_done, base.before.speak_total, usage.speak_per_week)
    : 0;

  const grindPorts: GrindListenPorts & GrindSpeakPorts = {
    credentials,
    http,
    env: ports.env,
    results: ports.resultsFor ? await ports.resultsFor(base.note, base.account_id) : undefined,
    llmAsk,
    waitNetwork,
  };

  const grindListen = ports.grindListen ?? grindListenGaps;
  const grindSpeak = ports.grindSpeak ?? grindSpeakGaps;

  // Each side isolated: a throw on one side keeps the other side's completions.
  // A refusal (no valid LLM answer) stops the whole account: no retry, no next side.
  let refused = false;
  const runSide = async (side: "listen" | "speak", run: () => Promise<SideResult>) => {
    try {
      const r = await run();
      base[`${side}_completed`] = r.completed;
      if (r.warnings?.length) base.warnings = [...(base.warnings ?? []), ...r.warnings.map((w) => `${side}: ${w}`)];
      if (r.stoppedReason) errors.push(`${side}: ${r.stoppedReason}`);
      if (r.errorClass) base.error_class ??= r.errorClass;
      if (r.refused) refused = true;
      if (r.networkDown) base.network_down = true;
    } catch (error) {
      const err = toError(error);
      errors.push(`${side}: ${err.message}`);
      base.error_class ??= classifyError(err);
    }
  };
  if (listenNeed > 0) await runSide("listen", () => grindListen(grindPorts, listenNeed));
  if (speakNeed > 0) {
    if (refused) errors.push("speak: 跳过（听力拒交，本账号停止）");
    else if (base.network_down) errors.push("speak: 跳过（网络未恢复，重跑续上）");
    else await runSide("speak", () => grindSpeak(grindPorts, speakNeed));
  }

  if (base.network_down) {
    // A side already waited out the cap: stop now, no second full wait on progress_after.
    return { ...base, status: "error", errors, error_class: "NETWORK" };
  }
  const afterRaw = await listProgress(credentials);
  if (progressDown && "error" in afterRaw) return networkDown(afterRaw.error);
  if ("error" in afterRaw) {
    errors.push(`progress_after: ${afterRaw.error}`);
    return {
      ...base,
      status: refused || (errors.length && base.listen_completed + base.speak_completed === 0)
        ? "error"
        : "ground",
      errors,
    };
  }
  base.after = afterRaw;

  if (refused) {
    base.status = "error";
  } else if (isAlreadyDone(afterRaw, sides, usage)) {
    base.status = base.listen_completed + base.speak_completed > 0 ? "done" : "skipped_done";
  } else if (base.listen_completed + base.speak_completed > 0) {
    base.status = "ground";
  } else {
    base.status = "error";
    if (errors.length === 0) errors.push("未完成且无交卷次数");
  }
  return base;
}

/** Run weekly grind for selected accounts (sequential). */
export async function runWeeklyGrind(
  mode: SelectAccountsMode,
  ports: WeeklyGrindPorts = {},
): Promise<WeeklyGrindSummary> {
  const started_at = new Date().toISOString();
  const targets = await resolveTargetAccounts(mode, ports);
  const accounts: AccountGrindSummary[] = [];
  for (const account of targets) {
    if (!account.has_jwt && !account.has_rt) {
      accounts.push({
        account_id: account.account_id,
        alias: account.alias,
        note: account.note,
        grind: normalizeGrind(account.grind),
        status: "error",
        before: null,
        after: null,
        listen_completed: 0,
        speak_completed: 0,
        listen_skipped: null,
        speak_skipped: null,
        usage: normalizeUsage(account.usage),
        usage_skip: null,
        errors: ["账户不存在或缺少 jwt|rt"],
      });
      continue;
    }
    try {
      const one = await grindOneAccount(account, ports);
      accounts.push(one);
      if (one.network_down) {
        console.error(`[net] ${one.note ?? "(无备注)"} 网络未恢复，本轮停止，剩余 ${targets.length - accounts.length} 个号未跑；网络恢复后重跑同一命令即可续上`);
        break;
      }
    } catch (error) {
      // One account blowing up must not lose the JSON summary for the rest.
      const err = toError(error);
      accounts.push({
        account_id: account.account_id,
        alias: account.alias,
        note: account.note,
        grind: normalizeGrind(account.grind),
        status: "error",
        before: null,
        after: null,
        listen_completed: 0,
        speak_completed: 0,
        listen_skipped: null,
        speak_skipped: null,
        usage: normalizeUsage(account.usage),
        usage_skip: null,
        errors: [err.message],
        error_class: classifyError(err),
      });
    }
  }
  const totals: Record<string, number> = {};
  for (const a of accounts) totals[a.status] = (totals[a.status] ?? 0) + 1;
  return {
    accounts,
    totals,
    started_at,
    finished_at: new Date().toISOString(),
  };
}

/** Phone-shaped account id → 139****0000; other ids keep only the last 4 chars. */
export function maskAccountId(id: string): string {
  if (/^1\d{10}$/.test(id)) return `${id.slice(0, 3)}****${id.slice(-4)}`;
  return id.length > 4 ? `***${id.slice(-4)}` : "***";
}

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const PHONE_RE = /(?<!\d)1\d{10}(?!\d)/g;

/**
 * stdout summary: accounts by note + masked id only (same as per-paper lines),
 * never a full phone number or a jwt-shaped token.
 */
export function sanitizeSummaryForStdout(summary: WeeklyGrindSummary): WeeklyGrindSummary {
  const clean = (e: string) => e.replace(JWT_RE, "[redacted-jwt]").replace(PHONE_RE, maskAccountId);
  return {
    ...summary,
    accounts: summary.accounts.map((a) => ({
      ...a,
      account_id: maskAccountId(a.account_id),
      errors: a.errors.map(clean),
      ...(a.warnings ? { warnings: a.warnings.map(clean) } : {}),
    })),
  };
}
