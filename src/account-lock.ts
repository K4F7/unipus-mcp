/**
 * Per-account exclusive lock (#106): two weekly-grind processes on one account
 * make the server answer 4021 (多设备同时作答). Lock files live next to the
 * results ledger and are named by the same salted account key, never the phone.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { accountKey, resolveResultsFile } from "./paper-result.js";

export const ACCOUNT_LOCKED_EXIT_CODE = 5;

export class AccountLockedError extends Error {
  constructor(readonly key: string, readonly holderPid: number) {
    super(`ACCOUNT_LOCKED：账号 ${key} 已有进程 pid=${holderPid} 在跑，本进程退出（同号并发会触发 4021）`);
  }
}

export type AccountLocks = { release(): void };

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const readPid = async (path: string) => Number((await readFile(path, "utf8")).trim());

/** Publish a lock whose pid is already written: link() never replaces, so no reader sees an empty lock. */
async function publish(path: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${process.pid}\n`, { mode: 0o600 });
  try {
    await link(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally {
    await rm(tmp, { force: true });
  }
}

const GUARD_STALE_MS = 30_000;

/** Serialize stale-lock takeover so two takers can't delete each other's fresh lock. */
async function takeOverStale(path: string, key: string, deadPid: number): Promise<boolean> {
  const guard = `${path}.takeover`;
  try {
    await writeFile(guard, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const age = Date.now() - (await stat(guard).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > GUARD_STALE_MS) await rm(guard, { force: true }); // taker crashed mid-takeover
    return false;
  }
  try {
    // Re-check under the guard: only remove the exact dead holder we saw.
    if ((await readPid(path).catch(() => NaN)) !== deadPid) return false;
    console.error(`[lock] 接管陈旧锁 ${key}（pid=${deadPid} 已不在）`);
    await rm(path, { force: true });
    return publish(path);
  } finally {
    await rm(guard, { force: true });
  }
}

async function lockOne(path: string, key: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await publish(path)) return;
    let holder: number;
    try {
      holder = await readPid(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile
      throw e; // fail closed
    }
    if (pidAlive(holder)) throw new AccountLockedError(key, holder);
    if (await takeOverStale(path, key, holder)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new AccountLockedError(key, await readPid(path).catch(() => 0));
}

function unlinkIfOurs(path: string): void {
  try {
    // Sync so it also works from process "exit" handlers.
    if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
  } catch {
    /* already gone */
  }
}

const SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

/**
 * Lock every account up front (all-or-nothing). Throws AccountLockedError if any
 * is held by a live process; stale locks (dead pid) are taken over.
 * releaseOnExit: also release on process exit and SIGINT/SIGTERM/SIGHUP.
 */
export async function acquireAccountLocks(
  accountIds: string[],
  opts: { resultsFile?: string; releaseOnExit?: boolean } = {},
): Promise<AccountLocks> {
  const file = opts.resultsFile ?? resolveResultsFile();
  const dir = join(dirname(file), "locks");
  await mkdir(dir, { recursive: true });
  const held: string[] = [];
  const release = () => {
    for (const p of held.splice(0)) unlinkIfOurs(p);
  };
  try {
    for (const id of new Set(accountIds)) {
      const key = await accountKey(id, file);
      const path = join(dir, `${key}.lock`);
      await lockOne(path, key);
      held.push(path);
    }
  } catch (e) {
    release();
    throw e;
  }
  if (opts.releaseOnExit) {
    process.once("exit", release);
    for (const [sig, n] of Object.entries(SIGNALS)) {
      process.once(sig, () => {
        release();
        process.exit(128 + n);
      });
    }
  }
  return { release };
}
