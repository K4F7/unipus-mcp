import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { listAccounts, readActiveAccountId } from "../src/accounts.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../scripts/import-tokens.ts");
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuSWQiOiJ0ZXN0In0.signaturehere";

function runImport(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    if (stdin != null) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

describe("import-tokens CLI", () => {
  test("imports jwt+rt from files with 0600; validates shape", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-import-"));
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const jwtFile = join(home, "jwt.txt");
    const rtFile = join(home, "rt.txt");
    await writeFile(jwtFile, JWT + "\n");
    await writeFile(rtFile, "refresh-token-value\n");

    const r = await runImport(
      ["--account", "19900001111", "--jwt-file", jwtFile, "--rt-file", rtFile],
      env,
    );
    assert.equal(r.code, 0, r.err || r.out);
    assert.equal(r.out.includes(JWT), false);
    assert.equal(r.err.includes(JWT), false);
    assert.match(r.out, /已导入/);

    const listed = await listAccounts({ home, env });
    assert.equal(listed[0]?.has_jwt, true);
    assert.equal(listed[0]?.has_rt, true);
    assert.equal(await readActiveAccountId({ home, env }), "19900001111");

    const saved = await readFile(
      join(home, ".config/unipus-mcp/accounts/19900001111/jwt"),
      "utf8",
    );
    assert.match(saved, /^eyJ/);
  });

  test("rejects invalid jwt shape", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-import-bad-"));
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
    const jwtFile = join(home, "bad.txt");
    await writeFile(jwtFile, "not-a-jwt\n");
    const r = await runImport(
      ["--account", "19900002222", "--jwt-file", jwtFile, "--no-active"],
      env,
    );
    assert.equal(r.code, 2);
    assert.match(r.err, /JWT shape/);
  });
});
