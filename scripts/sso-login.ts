#!/usr/bin/env node
/**
 * CLI: Unipus SSO login → save JWT+RT under accounts/<id>/ (+ legacy).
 *
 *   UNIPUS_USERNAME=… UNIPUS_PASSWORD=… npx tsx scripts/sso-login.ts [--account <id>]
 *   npx tsx scripts/sso-login.ts --refresh [--account <id>]
 *
 * Never prints jwt/rt/password values.
 * CAPTCHA_REQUIRED → exit 3 + clear Chinese message (headed browser + import).
 */
import {
  EXIT_CAPTCHA_REQUIRED,
  loginWithPassword,
  refreshWithRt,
  saveLoginTokens,
} from "../src/sso-login.js";
import {
  readAccountRt,
  readActiveAccountId,
  readLegacyRt,
} from "../src/accounts.js";

function parseArgs(argv: string[]): {
  account?: string;
  refresh: boolean;
  help: boolean;
} {
  let account: string | undefined;
  let refresh = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--account" || a === "-a") {
      account = argv[++i]?.trim();
    } else if (a.startsWith("--account=")) {
      account = a.slice("--account=".length).trim();
    }
  }
  return { account, refresh, help };
}

function printHelp(): void {
  console.log(`Usage:
  UNIPUS_USERNAME=… UNIPUS_PASSWORD=… npx tsx scripts/sso-login.ts [--account <id>]
  npx tsx scripts/sso-login.ts --refresh [--account <id>]

Options:
  --account <id>   Account archive id (default: username/phone, or active)
  --refresh        Prefer refresh_jwt via stored rt; fall back to password login
  --help           Show this help

Exit codes: 0 ok, 1 fail, 2 missing args, 3 CAPTCHA_REQUIRED
Never prints jwt / rt / password.`);
}

function exitCaptcha(message: string): never {
  console.error(message);
  console.error(
    "请用有头浏览器打开 https://sso.unipus.cn/sso/login 完成极验后，将 jwt 与 rt 写入 ~/.config/unipus-mcp/accounts/<id>/（或先登录再导入）。勿把秘密作为 MCP 工具参数。",
  );
  process.exit(EXIT_CAPTCHA_REQUIRED);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const username =
    process.env.UNIPUS_USERNAME?.trim() ||
    process.env.UNIPUS_PHONE?.trim() ||
    "";
  const password = process.env.UNIPUS_PASSWORD ?? "";
  const accountId =
    args.account ||
    username ||
    (await readActiveAccountId()) ||
    "";

  if (args.refresh) {
    await runRefresh({ accountId, username, password });
    return;
  }

  if (!username || !password) {
    console.error(
      "需要环境变量 UNIPUS_USERNAME（或 UNIPUS_PHONE）与 UNIPUS_PASSWORD",
    );
    process.exit(2);
  }
  if (!accountId) {
    console.error("无法确定 --account；请传 --account 或设置用户名");
    process.exit(2);
  }

  const result = await loginWithPassword({ username, password });
  if (!result.ok) {
    if (result.code === "CAPTCHA_REQUIRED") {
      exitCaptcha(`登录失败 [${result.code}]: ${result.message}`);
    }
    console.error(`登录失败 [${result.code}]: ${result.message}`);
    process.exit(1);
  }

  const saved = await saveLoginTokens({
    accountId,
    jwt: result.jwt,
    refreshToken: result.refreshToken,
    jwtExpire: result.jwtExpire,
    source: "login",
  });
  const hasRt = result.refreshToken != null && result.refreshToken.length > 0;
  console.log(
    `登录成功，凭据已写入 ${saved.accountDir}（jwt len=${result.jwt.length}，rt=${hasRt ? "已保存" : "无"}；active + legacy 已同步）`,
  );
}

async function runRefresh(opts: {
  accountId: string;
  username: string;
  password: string;
}): Promise<void> {
  let accountId = opts.accountId;
  if (!accountId) {
    accountId = (await readActiveAccountId()) ?? "";
  }
  if (!accountId) {
    console.error("续期需要 --account 或 active-account.txt");
    process.exit(2);
  }

  const rt =
    (await readAccountRt(accountId)) ?? (await readLegacyRt()) ?? "";

  if (rt.length > 0) {
    const refreshed = await refreshWithRt(rt);
    if (refreshed.ok) {
      const saved = await saveLoginTokens({
        accountId,
        jwt: refreshed.jwt,
        refreshToken: refreshed.refreshToken,
        jwtExpire: refreshed.jwtExpire,
        source: "refresh",
      });
      const hasRt =
        refreshed.refreshToken != null && refreshed.refreshToken.length > 0;
      console.log(
        `续期成功，凭据已写入 ${saved.accountDir}（jwt len=${refreshed.jwt.length}，rt=${hasRt ? "已轮换保存" : "无"}）`,
      );
      return;
    }
    console.error(
      `refresh_jwt 失败 [${refreshed.code}]: ${refreshed.message}；尝试账密回退…`,
    );
    if (refreshed.code === "CAPTCHA_REQUIRED") {
      // Fall through to password; if that also captcha, exit 3 below.
    }
  } else {
    console.error("未找到 rt，尝试账密登录…");
  }

  if (!opts.username || !opts.password) {
    console.error(
      "续期失败且无账密可回退：请设置 UNIPUS_USERNAME / UNIPUS_PASSWORD，或有头浏览器登录后导入 jwt/rt",
    );
    process.exit(1);
  }

  const result = await loginWithPassword({
    username: opts.username,
    password: opts.password,
  });
  if (!result.ok) {
    if (result.code === "CAPTCHA_REQUIRED") {
      exitCaptcha(`账密回退失败 [${result.code}]: ${result.message}`);
    }
    console.error(`账密回退失败 [${result.code}]: ${result.message}`);
    process.exit(1);
  }

  const saved = await saveLoginTokens({
    accountId,
    jwt: result.jwt,
    refreshToken: result.refreshToken,
    jwtExpire: result.jwtExpire,
    source: "login",
  });
  console.log(
    `账密回退登录成功，凭据已写入 ${saved.accountDir}（jwt len=${result.jwt.length}）`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
