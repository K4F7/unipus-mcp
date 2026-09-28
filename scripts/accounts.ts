#!/usr/bin/env node
/**
 * CLI: list / use / note multi-account archives (no secrets printed).
 *
 *   npx tsx scripts/accounts.ts list
 *   npx tsx scripts/accounts.ts use <account_id>
 *   npx tsx scripts/accounts.ts note <account_id> <text…>
 *   npx tsx scripts/accounts.ts note <account_id> --clear
 *   npx tsx scripts/accounts.ts set-note <account_id> --text '…'
 *   npx tsx scripts/accounts.ts grind <account_id> both|listen|speak
 *   npx tsx scripts/accounts.ts set-grind <account_id> both|listen|speak
 *   npx tsx scripts/accounts.ts set-password <account_id>
 */
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  accountDir,
  defaultConfigDir,
  isGrindMode,
  listAccounts,
  readActiveAccountId,
  sanitizeAccountId,
  setAccountGrind,
  setAccountNote,
  setActiveAccountId,
  writeAccountPassword,
} from "../src/accounts.js";

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/accounts.ts list
  npx tsx scripts/accounts.ts use <account_id>
  npx tsx scripts/accounts.ts note <account_id> <text…>
  npx tsx scripts/accounts.ts note <account_id> --clear
  npx tsx scripts/accounts.ts set-note <account_id> --text '…'
  npx tsx scripts/accounts.ts grind <account_id> both|listen|speak
  npx tsx scripts/accounts.ts set-grind <account_id> both|listen|speak
  npx tsx scripts/accounts.ts set-password <account_id>

Only prints redacted meta (account_id, active, has_jwt/has_rt/has_password, alias, note, grind, timestamps).
Never prints jwt / rt / password. Switching is CLI-only (no MCP use_account).
grind 写入 meta.json（听/口策略）；勿从 note 文本解析。
set-password：从 stdin 或 env UNIPUS_PASSWORD / UNIPUS_PASSWORD_<id> 写入 accounts/<id>/password（0600）；永不回显。
本仓自管密码，不强制 SecretSpec；禁止把密码作 MCP 工具参数。`);
}

/** Single-line escape for list display; truncate long notes. */
function formatNoteForList(note: string | null, max = 80): string {
  if (note == null || note.length === 0) return "";
  const oneLine = note.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  const shown =
    oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return ` note=${JSON.stringify(shown)}`;
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
    const note = formatNoteForList(a.note);
    const grind = ` grind=${a.grind}`;
    const login = a.last_login_at ? ` login=${a.last_login_at}` : "";
    const refresh = a.last_refresh_at ? ` refresh=${a.last_refresh_at}` : "";
    console.log(
      `${mark} ${a.account_id}  jwt=${a.has_jwt ? "yes" : "no"} rt=${a.has_rt ? "yes" : "no"} pw=${a.has_password ? "yes" : "no"}${alias}${note}${grind}${login}${refresh}`,
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

async function cmdNote(accountIdRaw: string, rest: string[]): Promise<void> {
  const accountId = sanitizeAccountId(accountIdRaw);
  if (rest.includes("--clear")) {
    await setAccountNote(accountId, null);
    console.log(`已清空 ${accountId} 的 note`);
    return;
  }
  const textIdx = rest.indexOf("--text");
  let text: string;
  if (textIdx >= 0) {
    text = rest.slice(textIdx + 1).join(" ").trim();
    if (!text) {
      console.error("usage: accounts.ts note|set-note <account_id> --text '…'");
      process.exit(2);
    }
  } else {
    text = rest.join(" ").trim();
    if (!text) {
      console.error(
        "usage: accounts.ts note <account_id> <text…> | note <id> --clear | set-note <id> --text '…'",
      );
      process.exit(2);
    }
  }
  await setAccountNote(accountId, text);
  console.log(`已设置 ${accountId} 的 note（长度 ${text.trim().length}，秘密未打印）`);
}

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // Prompt without echo is hard portably; prefer env when TTY.
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/**
 * Write accounts/<id>/password from env or stdin. Never prints the secret.
 * Preference: UNIPUS_PASSWORD_<id> → UNIPUS_PASSWORD → stdin.
 */
async function cmdSetPassword(accountIdRaw: string): Promise<void> {
  const accountId = sanitizeAccountId(accountIdRaw);
  const env = process.env;
  const fromEnv =
    env[`UNIPUS_PASSWORD_${accountId}`] ||
    env.UNIPUS_PASSWORD ||
    "";
  let password = fromEnv;
  if (!password) {
    password = await readPasswordFromStdin();
  }
  if (!password) {
    console.error(
      "缺少密码：请设置 UNIPUS_PASSWORD 或 UNIPUS_PASSWORD_<id>，或通过 stdin 传入（勿 echo 到日志）",
    );
    process.exit(2);
  }
  const path = await writeAccountPassword(accountId, password);
  console.log(`已写入 accounts/${accountId}/password（0600）；路径已保存，不打印密文。`);
  // mention path without secret — path is fine
  void path;
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
  if (cmd === "note" || cmd === "set-note") {
    const id = rest[0]?.trim();
    if (!id) {
      console.error("usage: accounts.ts note <account_id> <text…>");
      process.exit(2);
    }
    await cmdNote(id, rest.slice(1));
    return;
  }
  if (cmd === "grind" || cmd === "set-grind") {
    const id = rest[0]?.trim();
    const mode = rest[1]?.trim();
    if (!id || !mode) {
      console.error("usage: accounts.ts grind|set-grind <account_id> both|listen|speak");
      process.exit(2);
    }
    if (!isGrindMode(mode)) {
      console.error(`grind 非法：期望 both|listen|speak（收到 ${mode}）`);
      process.exit(2);
    }
    await setAccountGrind(id, mode);
    console.log(`已设置 ${id} 的 grind=${mode}（秘密未打印）`);
    return;
  }
  if (cmd === "set-password") {
    const id = rest[0]?.trim();
    if (!id) {
      console.error("usage: accounts.ts set-password <account_id>");
      process.exit(2);
    }
    await cmdSetPassword(id);
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
