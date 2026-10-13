/** Show recent speak history (scoreIsOut) + part/get for top N. No secrets printed. */
import { ensureAccountAuth } from "../src/weekly-grind.js";
import { createStaticJwtStore } from "../src/credentials.js";
import { createFetchUnipusHttp } from "../src/http.js";
import { getHistoryTrainingTasks, checkReportStatus } from "../src/history-training-tasks.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountDir } from "../src/accounts.js";
const [key, nStr] = process.argv.slice(2);
let id = key!;
if (!/^\d+$/.test(id)) {
  const root = join(accountDir("x"), "..");
  for (const d of await readdir(root)) { try { if (JSON.parse(await readFile(join(root, d, "meta.json"), "utf8")).note === key) id = d; } catch {} }
}
const auth = await ensureAccountAuth(id, {});
if (!auth.ok) { console.log(key, auth.code); process.exit(1); }
const ports: any = { credentials: createStaticJwtStore(auth.jwt), http: createFetchUnipusHttp(), env: process.env };
const h: any = await getHistoryTrainingTasks(ports, { flowType: "speak", pageSize: 10 });
const list = h.page?.list ?? [];
if (!list.length) console.log(Object.keys(h));
for (const t of list.slice(0, Number(nStr ?? 3))) {
  const cs: any = await checkReportStatus(ports, { taskId: t.taskId, ansVersion: t.ansVersion ?? 1 });
  console.log(JSON.stringify({ key, taskId: t.taskId, title: t.paperTitle, score: t.score, scoreIsOut: t.scoreIsOut, check: cs.check_status }));
}
if (process.env.PARTS) {
  for (const t of list.slice(0, Number(nStr ?? 3))) {
    const r = await ports.http.request({ url: `https://uadaptive.unipus.cn/api/uls/part/get?taskId=${t.taskId}&ansVersion=${t.ansVersion ?? 1}`, method: "GET", headers: { authorization: auth.jwt, accept: "application/json" } });
    const v = JSON.parse(r.body.replace(/:(\d{16,})/g, ':"$1"')).value;
    const arr = Array.isArray(v) ? v : v?.parts ?? v?.list ?? v;
    console.log(t.taskId, JSON.stringify(arr).slice(0, 900));
  }
}
