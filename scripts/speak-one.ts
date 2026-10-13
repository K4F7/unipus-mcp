#!/usr/bin/env node
/** Redo N speak trainings for one account (by id or note); prints taskIds + result. Never prints secrets. */
import { ensureAccountAuth } from "../src/weekly-grind.js";
import { createStaticJwtStore } from "../src/credentials.js";
import { createFetchUnipusHttp } from "../src/http.js";
import { grindSpeakGaps } from "../src/grind-speak.js";
import { getHistoryTrainingTasks } from "../src/history-training-tasks.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountDir } from "../src/accounts.js";

async function resolve(key: string): Promise<string> {
  if (/^\d+$/.test(key)) return key;
  const root = join(accountDir("x"), "..");
  for (const id of await readdir(root)) {
    try {
      const m = JSON.parse(await readFile(join(root, id, "meta.json"), "utf8"));
      if (m.note === key) return id;
    } catch {}
  }
  throw new Error(`no account note=${key}`);
}
const [key, nStr] = process.argv.slice(2);
const id = await resolve(key!);
const auth = await ensureAccountAuth(id, {});
if (!auth.ok) { console.log(JSON.stringify({ key, error: auth.code })); process.exit(1); }
const ports = { credentials: createStaticJwtStore(auth.jwt), http: createFetchUnipusHttp(), env: process.env };
const r = await grindSpeakGaps(ports as never, Number(nStr ?? 1), Number(nStr ?? 1) + 1);
const h = await getHistoryTrainingTasks(ports as never, { flowType: "speak", pageSize: 10 } as never);
const tasks = (h as any).page?.list ?? [];
console.log(JSON.stringify({ key, result: r, history: tasks.slice(0, 5).map((t: any) => ({ taskId: t.taskId, title: t.paperTitle, score: t.score, scoreIsOut: t.scoreIsOut })) }, null, 2));
