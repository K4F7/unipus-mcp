#!/usr/bin/env node
/**
 * CLI: list / use multi-account archives (no secrets printed).
 *
 *   npx tsx scripts/accounts.ts list
 *   npx tsx scripts/accounts.ts use <account_id>
 */
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  accountDir,
  defaultConfigDir,
  listAccounts,
  readActiveAccountId,
  sanitizeAccountId,
  setActiveAccountId,
} from "../src/accounts.js";

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/accounts.ts list
  npx tsx scripts/accounts.ts use <account_id>

Only prints redacted meta (account_id, active, has_jwt/has_rt, timestamps).
Never prints jwt / rt / password. Switching is CLI-only (no MCP use_account).`);
}

async function cmdList(): Promise<void> {
  const active = await readActiveAccountId();
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    console.log(
      active
        ? `无 accounts/ 目录条目；active-account.txt=${active}（可能仅 legacy jwt）`
        : "无多账户档案；将使用 legacy ~/.config/unipus-mcp/jwt（若存在）",
    );
    return;
  }
  console.log(`active: ${active ?? "(none)"}`);
  for (const a of accounts) {
    const mark = a.active ? "*" : " ";
    const alias = a.alias ? ` alias=${a.alias}` : "";
    const login = a.last_login_at ? ` login=${a.last_login_at}` : "";
    const refresh = a.last_refresh_at ? ` refresh=${a.last_refresh_at}` : "";
    console.log(
      `${mark} ${a.account_id}  jwt=${a.has_jwt ? "yes" : "no"} rt=${a.has_rt ? "yes" : "no"}${alias}${login}${refresh}`,
    );
  }
}

async function cmdUse(accountIdRaw: string): Promise<void> {
  const accountId = sanitizeAccountId(accountIdRaw);
  const dir = accountDir(accountId);
  try {
    await access(join(dir, "jwt"));
  } catch {
    console.error(
      `账户 ${accountId} 不存在或缺少 jwt（期望目录 ${dir}）`,
    );
    process.exit(1);
  }
  await setActiveAccountId(accountId);
  const configDir = defaultConfigDir();
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const jwt = await readFile(join(dir, "jwt"), "utf8");
  await writeFile(join(configDir, "jwt"), jwt.endsWith("\n") ? jwt : `${jwt}\n`, {
    mode: 0o600,
  });
  await chmod(join(configDir, "jwt"), 0o600);
  try {
    const rt = await readFile(join(dir, "rt"), "utf8");
    await writeFile(join(configDir, "rt"), rt.endsWith("\n") ? rt : `${rt}\n`, {
      mode: 0o600,
    });
    await chmod(join(configDir, "rt"), 0o600);
  } catch {
    // rt optional
  }
  console.log(`已切换 active → ${accountId}（legacy jwt/rt 已同步，秘密未打印）`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === "list") {
    await cmdList();
    return;
  }
  if (cmd === "use") {
    const id = rest[0]?.trim();
    if (!id) {
      console.error("usage: accounts.ts use <account_id>");
      process.exit(2);
    }
    await cmdUse(id);
    return;
  }
  console.error(`未知子命令: ${cmd}`);
  printHelp();
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
