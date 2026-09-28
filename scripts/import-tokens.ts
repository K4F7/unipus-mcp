#!/usr/bin/env node
/**
 * Import jwt (+ optional rt) into accounts/<id>/ from file or stdin.
 *
 *   npx tsx scripts/import-tokens.ts --account <id> --jwt-file path [--rt-file path]
 *   npx tsx scripts/import-tokens.ts --account <id>   # JSON {jwt,rt?} on stdin
 *
 * Validates JWT shape. Writes mode 0600. Never prints secrets.
 * For headed-browser CAPTCHA recovery (SSO code=1506) — no headless captcha, no MCP login.
 */
import { readFile } from "node:fs/promises";

import { saveAccountTokens, sanitizeAccountId } from "../src/accounts.js";
import { extractJwtFromText } from "../src/credentials.js";

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/import-tokens.ts --account <id> --jwt-file <path> [--rt-file <path>]
  npx tsx scripts/import-tokens.ts --account <id> --jwt-env [--rt-env]
  npx tsx scripts/import-tokens.ts --account <id>   # stdin JSON: {"jwt":"...","rt":"..."}

After headed SSO (极验 CAPTCHA):
  1. Open https://sso.unipus.cn/sso/login in a headed browser; complete captcha.
  2. Copy jwt (and rt if available) from DevTools / cookie / portal JSON.
  3. Import here — never paste secrets into MCP tool args.

Flags:
  --account <id>   Required archive id
  --jwt-file path  Read jwt from file (or Cookie/portal JSON text)
  --rt-file path   Optional refresh token file
  --jwt-env        Read jwt from UNIPUS_JWT / UNIPUS_JWT_FILE env (not printed)
  --rt-env         Read rt from UNIPUS_RT env
  --no-active      Do not change active-account.txt / legacy jwt
  --help

Exit: 0 ok, 2 bad args / invalid jwt shape. Never prints jwt/rt/password.`);
}

function parseArgs(argv: string[]) {
  let account = "";
  let jwtFile = "";
  let rtFile = "";
  let jwtEnv = false;
  let rtEnv = false;
  let makeActive = true;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--account" || a === "-a") account = argv[++i]?.trim() ?? "";
    else if (a.startsWith("--account=")) account = a.slice(10).trim();
    else if (a === "--jwt-file") jwtFile = argv[++i]?.trim() ?? "";
    else if (a === "--rt-file") rtFile = argv[++i]?.trim() ?? "";
    else if (a === "--jwt-env") jwtEnv = true;
    else if (a === "--rt-env") rtEnv = true;
    else if (a === "--no-active") makeActive = false;
  }
  return { account, jwtFile, rtFile, jwtEnv, rtEnv, makeActive, help };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.account) {
    console.error("需要 --account <id>");
    printHelp();
    process.exit(2);
  }
  let accountId: string;
  try {
    accountId = sanitizeAccountId(args.account);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }

  let jwtRaw = "";
  let rtRaw = "";

  if (args.jwtFile) {
    jwtRaw = await readFile(args.jwtFile, "utf8");
  } else if (args.jwtEnv) {
    jwtRaw =
      process.env.UNIPUS_JWT?.trim() ||
      (process.env.UNIPUS_JWT_FILE
        ? await readFile(process.env.UNIPUS_JWT_FILE, "utf8")
        : "");
  }

  if (args.rtFile) {
    rtRaw = await readFile(args.rtFile, "utf8");
  } else if (args.rtEnv) {
    rtRaw = process.env.UNIPUS_RT?.trim() ?? "";
  }

  if (!jwtRaw) {
    const stdin = await readStdin();
    if (stdin.trim().startsWith("{")) {
      try {
        const obj = JSON.parse(stdin) as Record<string, unknown>;
        if (typeof obj.jwt === "string") jwtRaw = obj.jwt;
        if (typeof obj.rt === "string" && !rtRaw) rtRaw = obj.rt;
        if (typeof obj.refreshToken === "string" && !rtRaw) {
          rtRaw = obj.refreshToken;
        }
        if (
          obj.tokenInfo != null &&
          typeof obj.tokenInfo === "object" &&
          !Array.isArray(obj.tokenInfo)
        ) {
          const ti = obj.tokenInfo as Record<string, unknown>;
          if (typeof ti.jwt === "string" && !jwtRaw) jwtRaw = ti.jwt;
          if (typeof ti.rt === "string" && !rtRaw) rtRaw = ti.rt;
        }
      } catch {
        console.error("stdin JSON 无法解析");
        process.exit(2);
      }
    } else if (stdin.trim()) {
      jwtRaw = stdin;
    }
  }

  const jwt = extractJwtFromText(jwtRaw);
  if (jwt == null) {
    console.error("JWT shape 校验失败（期望 header.payload.sig；可用 Cookie/portal JSON）");
    process.exit(2);
  }
  const rt = rtRaw.trim();

  await saveAccountTokens(
    {
      accountId,
      jwt,
      refreshToken: rt.length > 0 ? rt : null,
      makeActive: args.makeActive,
      syncLegacy: args.makeActive,
      metaPatch: { last_login_at: new Date().toISOString() },
    },
  );

  console.log(
    `已导入 accounts/${accountId}/{jwt${rt ? ",rt" : ""}}（0600）；秘密未打印。` +
      (args.makeActive ? " 已设为 active。" : " 未改 active（--no-active）。"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
