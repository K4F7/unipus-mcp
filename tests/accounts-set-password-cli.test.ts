import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../scripts/accounts.ts");

function runAccounts(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    if (stdin != null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

describe("accounts set-password CLI", () => {
  test("stdin wins over global UNIPUS_PASSWORD; never prints secrets", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-setpw-"));
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      UNIPUS_PASSWORD: "global-should-not-be-written",
    };
    // Clear any per-id that might leak from parent process
    delete env.UNIPUS_PASSWORD_19900003333;

    const r = await runAccounts(
      ["set-password", "19900003333"],
      env,
      "stdin-per-account-secret\n",
    );
    assert.equal(r.code, 0, r.err || r.out);
    assert.equal(r.out.includes("stdin-per-account-secret"), false);
    assert.equal(r.out.includes("global-should-not-be-written"), false);
    assert.equal(r.err.includes("stdin-per-account-secret"), false);
    assert.equal(r.err.includes("global-should-not-be-written"), false);
    assert.match(r.out, /已写入/);

    const saved = await readFile(
      join(home, ".config/unipus-mcp/accounts/19900003333/password"),
      "utf8",
    );
    assert.equal(saved.trim(), "stdin-per-account-secret");
  });

  test("global UNIPUS_PASSWORD alone is not enough for set-password", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-setpw-noglob-"));
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      UNIPUS_PASSWORD: "global-only",
    };
    delete env.UNIPUS_PASSWORD_19900004444;
    const r = await runAccounts(["set-password", "19900004444"], env, "");
    assert.equal(r.code, 2);
    assert.match(r.err, /不读全局 UNIPUS_PASSWORD|缺少密码/);
  });

  test("per-id env is used even when global is set; does not need stdin body", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-setpw-id-"));
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      UNIPUS_PASSWORD: "global-should-not-be-written",
      UNIPUS_PASSWORD_19900005555: "env-id-secret",
    };
    const r = await runAccounts(["set-password", "19900005555"], env, "");
    assert.equal(r.code, 0, r.err || r.out);
    assert.equal(r.out.includes("env-id-secret"), false);
    assert.equal(r.out.includes("global-should-not-be-written"), false);
    const saved = await readFile(
      join(home, ".config/unipus-mcp/accounts/19900005555/password"),
      "utf8",
    );
    assert.equal(saved.trim(), "env-id-secret");
  });
});
