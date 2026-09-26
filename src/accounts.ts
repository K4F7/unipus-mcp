/**
 * Multi-account JWT/RT store under ~/.config/unipus-mcp/.
 * Passwords never land on disk; logs never print jwt/rt.
 */
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AccountFs = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  writeFile?: (
    path: string,
    data: string,
    options?: { mode?: number },
  ) => Promise<void>;
  mkdir?: (
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ) => Promise<string | undefined>;
  chmod?: (path: string, mode: number) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
};

/** Max length for account note (用途标记); reject longer with clear error. */
export const NOTE_MAX_LENGTH = 500;

export type AccountMeta = {
  account_id: string;
  alias?: string | null;
  /** Free-text usage tag; never secrets. */
  note?: string | null;
  last_login_at?: string | null;
  last_refresh_at?: string | null;
  jwt_expire?: unknown;
};

export type ListedAccount = {
  account_id: string;
  active: boolean;
  has_jwt: boolean;
  has_rt: boolean;
  alias: string | null;
  note: string | null;
  last_login_at: string | null;
  last_refresh_at: string | null;
};

function ports(options: AccountFs = {}) {
  return {
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    readFile: options.readFile ?? ((p, enc) => readFile(p, enc)),
    writeFile:
      options.writeFile ??
      ((p, data, opts) => writeFile(p, data, opts)),
    mkdir: options.mkdir ?? ((p, opts) => mkdir(p, opts)),
    chmod: options.chmod ?? ((p, mode) => chmod(p, mode)),
    rename: options.rename ?? ((f, t) => rename(f, t)),
    readdir: options.readdir ?? ((p) => readdir(p)),
  };
}

export function defaultConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg != null && xdg.length > 0) {
    return join(xdg, "unipus-mcp");
  }
  return join(home, ".config", "unipus-mcp");
}

export function activeAccountFilePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(defaultConfigDir(env, home), "active-account.txt");
}

export function accountDir(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(defaultConfigDir(env, home), "accounts", sanitizeAccountId(accountId));
}

export function sanitizeAccountId(accountId: string): string {
  const id = accountId.trim();
  if (id.length === 0) {
    throw new Error("account_id 不能为空");
  }
  // Prevent path traversal; allow phone / email-ish ids.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error("account_id 非法");
  }
  return id;
}

export async function readActiveAccountId(
  options: AccountFs = {},
): Promise<string | null> {
  const p = ports(options);
  const path = activeAccountFilePath(p.env, p.home);
  try {
    const raw = (await p.readFile(path, "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function setActiveAccountId(
  accountId: string,
  options: AccountFs = {},
): Promise<void> {
  const p = ports(options);
  const id = sanitizeAccountId(accountId);
  const dir = defaultConfigDir(p.env, p.home);
  await p.mkdir(dir, { recursive: true, mode: 0o700 });
  await p.chmod(dir, 0o700).catch(() => undefined);
  const path = activeAccountFilePath(p.env, p.home);
  await atomicWriteText(path, `${id}\n`, p);
}

export async function readAccountMeta(
  accountId: string,
  options: AccountFs = {},
): Promise<AccountMeta | null> {
  const p = ports(options);
  const path = join(accountDir(accountId, p.env, p.home), "meta.json");
  try {
    const raw = await p.readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    return {
      account_id: sanitizeAccountId(accountId),
      alias: typeof rec.alias === "string" ? rec.alias : null,
      note: typeof rec.note === "string" ? rec.note : null,
      last_login_at: typeof rec.last_login_at === "string" ? rec.last_login_at : null,
      last_refresh_at:
        typeof rec.last_refresh_at === "string" ? rec.last_refresh_at : null,
      jwt_expire: rec.jwt_expire ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeAccountMeta(
  accountId: string,
  meta: AccountMeta,
  options: AccountFs = {},
): Promise<void> {
  const p = ports(options);
  const dir = accountDir(accountId, p.env, p.home);
  await p.mkdir(dir, { recursive: true, mode: 0o700 });
  await p.chmod(dir, 0o700).catch(() => undefined);
  const safe: AccountMeta = {
    account_id: sanitizeAccountId(accountId),
    alias: meta.alias ?? null,
    note: meta.note ?? null,
    last_login_at: meta.last_login_at ?? null,
    last_refresh_at: meta.last_refresh_at ?? null,
    jwt_expire: meta.jwt_expire ?? null,
  };
  const path = join(dir, "meta.json");
  await atomicWriteText(path, `${JSON.stringify(safe, null, 2)}\n`, p);
}

async function fileExists(
  path: string,
  read: (path: string, encoding: "utf8") => Promise<string>,
): Promise<boolean> {
  try {
    await read(path, "utf8");
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function listAccounts(
  options: AccountFs = {},
): Promise<ListedAccount[]> {
  const p = ports(options);
  const root = join(defaultConfigDir(p.env, p.home), "accounts");
  const active = await readActiveAccountId(options);
  let names: string[];
  try {
    names = await p.readdir(root);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const out: ListedAccount[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    const meta = await readAccountMeta(name, options);
    out.push({
      account_id: name,
      active: active === name,
      has_jwt: await fileExists(join(dir, "jwt"), p.readFile),
      has_rt: await fileExists(join(dir, "rt"), p.readFile),
      alias: meta?.alias ?? null,
      note: meta?.note ?? null,
      last_login_at: meta?.last_login_at ?? null,
      last_refresh_at: meta?.last_refresh_at ?? null,
    });
  }
  return out;
}

export type SaveTokensInput = {
  accountId: string;
  jwt: string;
  refreshToken?: string | null;
  /** When true (default), also write legacy jwt/rt at config root. */
  syncLegacy?: boolean;
  /** When true (default), set active-account.txt to this account. */
  makeActive?: boolean;
  metaPatch?: Partial<AccountMeta>;
};

/** Atomically persist jwt (+ optional rt) under accounts/<id>/ and optionally legacy. */
export async function saveAccountTokens(
  input: SaveTokensInput,
  options: AccountFs = {},
): Promise<{ accountDir: string; legacyJwtPath: string }> {
  const p = ports(options);
  const id = sanitizeAccountId(input.accountId);
  const jwt = input.jwt.trim();
  if (jwt.length === 0) {
    throw new Error("jwt 不能为空");
  }
  const dir = accountDir(id, p.env, p.home);
  await p.mkdir(dir, { recursive: true, mode: 0o700 });
  await p.chmod(dir, 0o700).catch(() => undefined);

  const jwtPath = join(dir, "jwt");
  const rtPath = join(dir, "rt");
  await atomicWriteText(jwtPath, `${jwt}\n`, p);

  const rt = input.refreshToken?.trim() ?? "";
  if (rt.length > 0) {
    await atomicWriteText(rtPath, `${rt}\n`, p);
  }

  const existing = (await readAccountMeta(id, options)) ?? {
    account_id: id,
  };
  const patch = input.metaPatch ?? {};
  await writeAccountMeta(
    id,
    {
      account_id: id,
      alias: patch.alias !== undefined ? patch.alias : existing.alias ?? null,
      note: patch.note !== undefined ? patch.note : existing.note ?? null,
      last_login_at:
        patch.last_login_at !== undefined
          ? patch.last_login_at
          : existing.last_login_at ?? null,
      last_refresh_at:
        patch.last_refresh_at !== undefined
          ? patch.last_refresh_at
          : existing.last_refresh_at ?? null,
      jwt_expire:
        patch.jwt_expire !== undefined
          ? patch.jwt_expire
          : existing.jwt_expire ?? null,
    },
    options,
  );

  if (input.makeActive !== false) {
    await setActiveAccountId(id, options);
  }

  const configDir = defaultConfigDir(p.env, p.home);
  const legacyJwtPath = join(configDir, "jwt");
  const syncLegacy = input.syncLegacy !== false;
  if (syncLegacy) {
    await p.mkdir(configDir, { recursive: true, mode: 0o700 });
    await p.chmod(configDir, 0o700).catch(() => undefined);
    await atomicWriteText(legacyJwtPath, `${jwt}\n`, p);
    if (rt.length > 0) {
      await atomicWriteText(join(configDir, "rt"), `${rt}\n`, p);
    }
  }

  return { accountDir: dir, legacyJwtPath };
}

export async function readAccountRt(
  accountId: string,
  options: AccountFs = {},
): Promise<string | null> {
  const p = ports(options);
  const path = join(accountDir(accountId, p.env, p.home), "rt");
  try {
    const raw = (await p.readFile(path, "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function readLegacyRt(
  options: AccountFs = {},
): Promise<string | null> {
  const p = ports(options);
  const path = join(defaultConfigDir(p.env, p.home), "rt");
  try {
    const raw = (await p.readFile(path, "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}


/** Normalize / validate note text. null/empty → null; reject if > NOTE_MAX_LENGTH. */
export function normalizeAccountNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new Error(`note 过长：上限 ${NOTE_MAX_LENGTH} 字符（当前 ${trimmed.length}）`);
  }
  return trimmed;
}

/**
 * Set or clear account note (用途标记). Requires existing account dir with jwt.
 * Pass null to clear.
 */
export async function setAccountNote(
  accountId: string,
  note: string | null,
  options: AccountFs = {},
): Promise<void> {
  const p = ports(options);
  const id = sanitizeAccountId(accountId);
  const dir = accountDir(id, p.env, p.home);
  const hasJwt = await fileExists(join(dir, "jwt"), p.readFile);
  if (!hasJwt) {
    throw new Error(`账户 ${id} 不存在或缺少 jwt（期望目录 ${dir}）`);
  }
  const normalized = normalizeAccountNote(note);
  const existing = (await readAccountMeta(id, options)) ?? { account_id: id };
  await writeAccountMeta(
    id,
    {
      ...existing,
      account_id: id,
      note: normalized,
    },
    options,
  );
}


async function atomicWriteText(
  path: string,
  data: string,
  p: ReturnType<typeof ports>,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await p.writeFile(tmp, data, { mode: 0o600 });
  await p.chmod(tmp, 0o600).catch(() => undefined);
  await p.rename(tmp, path);
  await p.chmod(path, 0o600).catch(() => undefined);
  // Ensure parent stays private when on real fs.
  await p.chmod(dirname(path), 0o700).catch(() => undefined);
}

function isNotFound(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
