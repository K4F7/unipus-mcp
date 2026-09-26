#!/usr/bin/env node
/**
 * CLI shorthand for `sso-login.ts --refresh`.
 * Prefer refresh_jwt via stored rt; fall back to password login.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ssoLogin = join(here, "sso-login.ts");
const child = spawn(
  process.execPath,
  ["--import", "tsx", ssoLogin, "--refresh", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
