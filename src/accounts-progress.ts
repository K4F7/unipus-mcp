/**
 * Read-only multi-account week progress table for MCP.
 * No grind/scheduling; never returns jwt/rt/password.
 */
import {
  listAccounts,
  readAccountMeta,
  type GrindMode,
  type ListedAccount,
} from "./accounts.js";
import { createAccountJwtStore } from "./credentials.js";
import type { UnipusHttp } from "./http.js";
import { toolError, type ToolResult } from "./result.js";
import { listWeekProgress, type WeekProgressPorts } from "./week-progress.js";

export type PlacementSummary = {
  /** Live status from getUserStatusForApp / progress fetch (not grind policy). */
  status: "ok" | "needs_placement" | "error" | "unknown";
  code?: string | null;
  detail?: string | null;
};

export type AccountProgressRow = {
  account_id: string;
  active: boolean;
  alias: string | null;
  note: string | null;
  grind: GrindMode;
  skip_placement: boolean | null;
  listen_done: number | null;
  listen_total: number | null;
  speak_done: number | null;
  speak_total: number | null;
  level: string | null;
  placement: PlacementSummary;
  /** Per-row failure; whole table still returns ok. */
  error: { code: string; message: string } | null;
};

export type AccountsProgressResult = ToolResult & {
  accounts: AccountProgressRow[];
  active_account: string | null;
};

export type AccountsProgressPorts = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  http: UnipusHttp;
  now?: () => Date;
  weekProgressUrl?: string;
  speakWeekProgressUrl?: string | null;
};

export type ListAccountsProgressInput = {
  /** When set, only this account_id (must exist in archives). */
  account_id?: string;
};

function redactedListedBase(listed: ListedAccount): Pick<
  AccountProgressRow,
  "account_id" | "active" | "alias" | "note" | "grind"
> {
  return {
    account_id: listed.account_id,
    active: listed.active,
    alias: listed.alias,
    note: listed.note,
    grind: listed.grind,
  };
}

function placementFromProgress(
  progress: ToolResult & Record<string, unknown>,
): PlacementSummary {
  if (!progress.isError) {
    return { status: "ok", code: "OK", detail: null };
  }
  const code = typeof progress.code === "string" ? progress.code : "ERROR";
  const detail =
    typeof progress.message === "string" ? progress.message : String(progress.code ?? "");
  if (code === "NEEDS_PLACEMENT") {
    return { status: "needs_placement", code, detail };
  }
  return { status: "error", code, detail };
}

async function rowForAccount(
  listed: ListedAccount,
  ports: AccountsProgressPorts,
): Promise<AccountProgressRow> {
  const base = redactedListedBase(listed);
  const meta = await readAccountMeta(listed.account_id, {
    env: ports.env,
    home: ports.home,
  });
  const skipPlacement =
    meta?.skip_placement === true
      ? true
      : meta?.skip_placement === false
        ? false
        : null;

  if (!listed.has_jwt) {
    return {
      ...base,
      skip_placement: skipPlacement,
      listen_done: null,
      listen_total: null,
      speak_done: null,
      speak_total: null,
      level: null,
      placement: {
        status: "error",
        code: "AUTH_REQUIRED",
        detail: "无 jwt 档案",
      },
      error: { code: "AUTH_REQUIRED", message: "无 jwt 档案" },
    };
  }

  const weekPorts: WeekProgressPorts = {
    credentials: createAccountJwtStore(listed.account_id, {
      env: ports.env,
      homedir: ports.home,
    }),
    http: ports.http,
    now: ports.now,
    env: ports.env,
    weekProgressUrl: ports.weekProgressUrl,
    speakWeekProgressUrl: ports.speakWeekProgressUrl,
  };

  try {
    const progress = await listWeekProgress(weekPorts);
    const placement = placementFromProgress(progress);
    if (progress.isError) {
      return {
        ...base,
        skip_placement: skipPlacement,
        listen_done: null,
        listen_total: null,
        speak_done: null,
        speak_total: null,
        level: null,
        placement,
        error: {
          code: typeof progress.code === "string" ? progress.code : "ERROR",
          message:
            typeof progress.message === "string"
              ? progress.message
              : "进度查询失败",
        },
      };
    }
    return {
      ...base,
      skip_placement: skipPlacement,
      listen_done:
        typeof progress.listen_done === "number" ? progress.listen_done : null,
      listen_total:
        typeof progress.listen_total === "number" ? progress.listen_total : null,
      speak_done:
        typeof progress.speak_done === "number" ? progress.speak_done : null,
      speak_total:
        typeof progress.speak_total === "number" ? progress.speak_total : null,
      level: typeof progress.level === "string" ? progress.level : null,
      placement,
      error: null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      skip_placement: skipPlacement,
      listen_done: null,
      listen_total: null,
      speak_done: null,
      speak_total: null,
      level: null,
      placement: { status: "error", code: "PROGRESS_ERROR", detail },
      error: { code: "PROGRESS_ERROR", message: detail },
    };
  }
}

/**
 * Build a per-account progress table. One account failure never fails the tool.
 * Never includes jwt/rt/password fields or values.
 */
export async function listAccountsProgress(
  ports: AccountsProgressPorts,
  input: ListAccountsProgressInput = {},
): Promise<AccountsProgressResult> {
  const listed = await listAccounts({ env: ports.env, home: ports.home });
  const filterId = input.account_id?.trim() ?? "";
  let targets = listed;
  if (filterId.length > 0) {
    targets = listed.filter((a) => a.account_id === filterId);
    if (targets.length === 0) {
      return {
        ...toolError("INVALID_ARGUMENT", `账户不存在：${filterId}`),
        accounts: [],
        active_account: listed.find((a) => a.active)?.account_id ?? null,
      };
    }
  }

  const rows = await Promise.all(
    targets.map((account) => rowForAccount(account, ports)),
  );
  const active = listed.find((a) => a.active)?.account_id ?? null;
  const failed = rows.filter((r) => r.error != null).length;
  const message =
    rows.length === 0
      ? "无多账户档案"
      : failed === 0
        ? `共 ${rows.length} 个账户进度`
        : `共 ${rows.length} 个账户进度（${failed} 个失败，见各行 error）`;

  return {
    isError: false,
    status: "ok",
    code: "OK",
    message,
    accounts: rows,
    active_account: active,
  };
}
