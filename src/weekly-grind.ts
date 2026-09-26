/**
 * Stateless weekly listen/speak grind orchestrator for harness routines.
 * Never prints jwt/rt/password. Does not thrash active-account by default
 * (refresh/login saves with makeActive:false, syncLegacy:false).
 */
import {
  listAccounts,
  readAccountMeta,
  readAccountRt,
  readActiveAccountId,
  type AccountFs,
  type ListedAccount,
} from "./accounts.js";
import { createFetchUnipusHttp, type UnipusHttp } from "./http.js";
import {
  createStaticJwtStore,
  type JwtCredentialStore,
} from "./credentials.js";
import { grindListenGaps, type GrindListenPorts } from "./grind-listen.js";
import { grindSpeakGaps, type GrindSpeakPorts } from "./grind-speak.js";
import {
  loginWithPassword,
  refreshWithRt,
  saveLoginTokens,
} from "./sso-login.js";
import { listWeekProgress, type WeekProgressPorts } from "./week-progress.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountDir } from "./accounts.js";

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
  status:
    | "done"
    | "ground"
    | "skipped_done"
    | "skipped_captcha"
    | "error";
  before: ProgressSnap | null;
  after: ProgressSnap | null;
  listen_completed: number;
  speak_completed: number;
  errors: string[];
};

export type WeeklyGrindSummary = {
  accounts: AccountGrindSummary[];
  started_at: string;
  finished_at: string;
};

export type WeeklyGrindPorts = AccountFs & {
  http?: UnipusHttp;
  env?: NodeJS.ProcessEnv;
  /** Override progress listing (tests). */
  listProgress?: (
    credentials: JwtCredentialStore,
  ) => Promise<ProgressSnap | { error: string }>;
  grindListen?: (
    ports: GrindListenPorts,
    need: number,
  ) => Promise<{ completed: number; taskIds: string[]; stoppedReason?: string }>;
  grindSpeak?: (
    ports: GrindSpeakPorts,
    need: number,
  ) => Promise<{ completed: number; taskIds: string[]; stoppedReason?: string }>;
  refreshRt?: typeof refreshWithRt;
  loginPassword?: typeof loginWithPassword;
  /** When false (default), never call makeActive/syncLegacy on token save. */
  touchActive?: boolean;
};

export type SelectAccountsMode =
  | { kind: "all" }
  | { kind: "active" }
  | { kind: "ids"; ids: string[] };

/** Parse CLI argv into account selection. */
export function parseWeeklyGrindArgs(argv: string[]): {
  mode: SelectAccountsMode;
  help: boolean;
} {
  let help = false;
  let all = false;
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--all") all = true;
    else if (a === "--account" || a === "-a") {
      const id = argv[++i]?.trim();
      if (id) ids.push(id);
    } else if (a.startsWith("--account=")) {
      const id = a.slice("--account=".length).trim();
      if (id) ids.push(id);
    }
  }
  if (help) return { mode: { kind: "active" }, help: true };
  if (all) return { mode: { kind: "all" }, help: false };
  if (ids.length > 0) return { mode: { kind: "ids", ids }, help: false };
  return { mode: { kind: "active" }, help: false };
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
          alias: null,
          note: null,
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
  if (rt.length > 0) {
    const refreshed = await refresh(rt);
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

  const username =
    env.UNIPUS_USERNAME?.trim() || env.UNIPUS_PHONE?.trim() || "";
  const password = env.UNIPUS_PASSWORD ?? "";
  if (username && password) {
    const result = await login({ username, password });
    if (!result.ok) {
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
      rt.length > 0
        ? "refresh 失败且无可用账密/jwt"
        : "无 rt；无账密可回退；无本地 jwt",
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

function isAlreadyDone(snap: ProgressSnap): boolean {
  const ld = snap.listen_done;
  const lt = snap.listen_total;
  const sd = snap.speak_done;
  const st = snap.speak_total;
  if (ld == null || lt == null || sd == null || st == null) return false;
  return ld >= lt && sd >= st;
}

function needCount(done: number | null, total: number | null): number {
  if (done == null || total == null) return 0;
  return Math.max(0, total - done);
}

async function defaultListProgress(
  credentials: JwtCredentialStore,
  ports: WeeklyGrindPorts,
): Promise<ProgressSnap | { error: string }> {
  const http = ports.http ?? createFetchUnipusHttp();
  const wp: WeekProgressPorts = {
    credentials,
    http,
    env: ports.env,
  };
  const result = await listWeekProgress(wp);
  if (result.isError) {
    return { error: `${result.code}: ${result.message}` };
  }
  return snapFromProgress(result);
}

/** Grind one account: auth → progress → gaps → re-check. */
export async function grindOneAccount(
  account: ListedAccount,
  ports: WeeklyGrindPorts = {},
): Promise<AccountGrindSummary> {
  const errors: string[] = [];
  const meta = await readAccountMeta(account.account_id, ports);
  const base: AccountGrindSummary = {
    account_id: account.account_id,
    alias: meta?.alias ?? account.alias ?? null,
    note: meta?.note ?? account.note ?? null,
    status: "error",
    before: null,
    after: null,
    listen_completed: 0,
    speak_completed: 0,
    errors,
  };

  const auth = await ensureAccountAuth(account.account_id, ports);
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
  const listProgress = ports.listProgress ?? ((c) => defaultListProgress(c, ports));

  const beforeRaw = await listProgress(credentials);
  if ("error" in beforeRaw) {
    return {
      ...base,
      status: "error",
      errors: [`progress: ${beforeRaw.error}`],
    };
  }
  base.before = beforeRaw;

  if (isAlreadyDone(beforeRaw)) {
    return {
      ...base,
      status: "skipped_done",
      after: beforeRaw,
    };
  }

  const listenNeed = needCount(beforeRaw.listen_done, beforeRaw.listen_total);
  const speakNeed = needCount(beforeRaw.speak_done, beforeRaw.speak_total);

  const grindPorts: GrindListenPorts & GrindSpeakPorts = {
    credentials,
    http,
    env: ports.env,
  };

  const grindListen = ports.grindListen ?? grindListenGaps;
  const grindSpeak = ports.grindSpeak ?? grindSpeakGaps;

  if (listenNeed > 0) {
    const r = await grindListen(grindPorts, listenNeed);
    base.listen_completed = r.completed;
    if (r.stoppedReason) errors.push(`listen: ${r.stoppedReason}`);
  }
  if (speakNeed > 0) {
    const r = await grindSpeak(grindPorts, speakNeed);
    base.speak_completed = r.completed;
    if (r.stoppedReason) errors.push(`speak: ${r.stoppedReason}`);
  }

  const afterRaw = await listProgress(credentials);
  if ("error" in afterRaw) {
    errors.push(`progress_after: ${afterRaw.error}`);
    return {
      ...base,
      status: errors.length && base.listen_completed + base.speak_completed === 0
        ? "error"
        : "ground",
      errors,
    };
  }
  base.after = afterRaw;

  if (isAlreadyDone(afterRaw)) {
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
        status: "error",
        before: null,
        after: null,
        listen_completed: 0,
        speak_completed: 0,
        errors: ["账户不存在或缺少 jwt|rt"],
      });
      continue;
    }
    accounts.push(await grindOneAccount(account, ports));
  }
  return {
    accounts,
    started_at,
    finished_at: new Date().toISOString(),
  };
}

/** Redact any accidental secret-looking fields before stdout. */
export function sanitizeSummaryForStdout(summary: WeeklyGrindSummary): WeeklyGrindSummary {
  const json = JSON.stringify(summary);
  // Soft guard: never echo jwt-shaped tokens in summary strings
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(json)) {
    return {
      ...summary,
      accounts: summary.accounts.map((a) => ({
        ...a,
        errors: a.errors.map((e) =>
          e.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"),
        ),
      })),
    };
  }
  return summary;
}
