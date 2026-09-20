#!/usr/bin/env node
/**
 * CLI: Unipus SSO login → save JWT to ~/.config/unipus-mcp/jwt
 *
 *   UNIPUS_USERNAME=… UNIPUS_PASSWORD=… npx tsx scripts/sso-login.ts
 *
 * Never prints the JWT value.
 */
import {
  loginWithPassword,
  saveJwtToDefaultPath,
} from "../src/sso-login.js";

async function main(): Promise<void> {
  const username =
    process.env.UNIPUS_USERNAME?.trim() ||
    process.env.UNIPUS_PHONE?.trim() ||
    "";
  const password = process.env.UNIPUS_PASSWORD ?? "";
  if (!username || !password) {
    console.error(
      "需要环境变量 UNIPUS_USERNAME（或 UNIPUS_PHONE）与 UNIPUS_PASSWORD",
    );
    process.exit(2);
  }

  const result = await loginWithPassword({ username, password });
  if (!result.ok) {
    console.error(`登录失败 [${result.code}]: ${result.message}`);
    process.exit(1);
  }

  const path = await saveJwtToDefaultPath(result.jwt);
  console.log(`登录成功，JWT 已写入 ${path}（len=${result.jwt.length}）`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
