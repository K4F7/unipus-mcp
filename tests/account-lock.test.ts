import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountLockedError, acquireAccountLocks } from "../src/account-lock.js";

const resultsFile = async () => join(await mkdtemp(join(tmpdir(), "lock-")), "results.jsonl");
const PHONE = "13900001111";

test("second acquire for same account is refused; lock name has no phone", async () => {
  const file = await resultsFile();
  const held = await acquireAccountLocks([PHONE], { resultsFile: file });
  const names = await readdir(join(file, "..", "locks"));
  assert.equal(names.length, 1);
  assert.ok(!names[0]!.includes(PHONE));
  // Holder pid is alive (this process) → refused.
  await assert.rejects(acquireAccountLocks([PHONE], { resultsFile: file }), (e) => {
    assert.ok(e instanceof AccountLockedError);
    assert.equal(e.holderPid, process.pid);
    assert.ok(!e.message.includes(PHONE));
    return true;
  });
  held.release();
  const again = await acquireAccountLocks([PHONE], { resultsFile: file });
  again.release();
});

test("different accounts lock independently", async () => {
  const file = await resultsFile();
  const a = await acquireAccountLocks(["13900001111"], { resultsFile: file });
  const b = await acquireAccountLocks(["13900002222"], { resultsFile: file });
  a.release();
  b.release();
});

test("stale lock (dead pid) is taken over", async () => {
  const file = await resultsFile();
  const first = await acquireAccountLocks([PHONE], { resultsFile: file });
  const [name] = await readdir(join(file, "..", "locks"));
  first.release();
  await mkdir(join(file, "..", "locks"), { recursive: true });
  await writeFile(join(file, "..", "locks", name!), "999999999\n");
  const taken = await acquireAccountLocks([PHONE], { resultsFile: file });
  assert.equal((await readFile(join(file, "..", "locks", name!), "utf8")).trim(), String(process.pid));
  taken.release();
});

test("partial failure releases locks already taken", async () => {
  const file = await resultsFile();
  const held = await acquireAccountLocks(["B"], { resultsFile: file });
  await assert.rejects(acquireAccountLocks(["A", "B"], { resultsFile: file }), AccountLockedError);
  const a = await acquireAccountLocks(["A"], { resultsFile: file });
  a.release();
  held.release();
});

const holder = (file: string) =>
  spawn(process.execPath, ["--import", "tsx", "-e", `
    const { acquireAccountLocks } = await import(${JSON.stringify(new URL("../src/account-lock.ts", import.meta.url).pathname)});
    await acquireAccountLocks(["${PHONE}"], { resultsFile: ${JSON.stringify(file)}, releaseOnExit: true });
    console.log("held"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });

test("lock released on SIGTERM", async () => {
  const file = await resultsFile();
  const child = holder(file);
  await new Promise<void>((r) => child.stdout!.on("data", (d) => String(d).includes("held") && r()));
  await assert.rejects(acquireAccountLocks([PHONE], { resultsFile: file }), AccountLockedError);
  child.kill("SIGTERM");
  await new Promise((r) => child.on("exit", r));
  assert.deepEqual(await readdir(join(file, "..", "locks")), []);
});

const racer = (file: string) =>
  spawn(process.execPath, ["--import", "tsx", "-e", `
    const { acquireAccountLocks } = await import(${JSON.stringify(new URL("../src/account-lock.ts", import.meta.url).pathname)});
    try { await acquireAccountLocks(["${PHONE}"], { resultsFile: ${JSON.stringify(file)} }); console.log("WON"); setTimeout(() => {}, 1500); }
    catch { console.log("LOST"); }`], { stdio: ["ignore", "pipe", "ignore"] });

async function race(file: string, n: number): Promise<number> {
  const outs = await Promise.all(Array.from({ length: n }, () => new Promise<string>((r) => {
    const c = racer(file); let o = ""; c.stdout!.on("data", (d) => (o += d)); c.on("exit", () => r(o));
  })));
  return outs.filter((o) => o.includes("WON")).length;
}

test("concurrent first-time racers (fresh salt): exactly one wins", async () => {
  assert.equal(await race(await resultsFile(), 6), 1);
});

test("concurrent stale-lock takers: exactly one wins", async () => {
  const file = await resultsFile();
  const first = await acquireAccountLocks([PHONE], { resultsFile: file });
  const [name] = await readdir(join(file, "..", "locks"));
  first.release();
  await writeFile(join(file, "..", "locks", name!), "999999999\n");
  assert.equal(await race(file, 6), 1);
});
