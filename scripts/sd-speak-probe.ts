/**
 * Speak StudyDuration headless probes on account me.
 * KPI: r_set count + sumDelta. Never prints JWTs/passwords.
 * Restores active → 15346096028.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

import {
  accountDir,
  setActiveAccountId,
} from "/workspace/unipus-mcp/src/accounts.js";
import { createStaticJwtStore } from "/workspace/unipus-mcp/src/credentials.js";
import { createFetchUnipusHttp } from "/workspace/unipus-mcp/src/http.js";
import { startSpeakingTraining } from "/workspace/unipus-mcp/src/start-speaking-training.js";
import {
  buildKickPayload,
  buildStopPayload,
  buildUnipusioUrl,
  encodeNamespaceEvent,
  encodeNamespaceJoin,
  listenStudyTarget,
  resolveEdxJwt,
  softStartStudyDuration,
  startStudyDuration,
  STUDY_DURATION_PING_MS,
  STUDY_DURATION_REFRESH_MS,
  type KickStopPayload,
  type StudyDurationSession,
  type StudyDurationTarget,
  type StudyDurationWebSocketLike,
} from "/workspace/unipus-mcp/src/study-duration.js";
import { openIdFromJwt, ulsCloudHeaders } from "/workspace/unipus-mcp/src/uls-business.js";

delete process.env.SILICONFLOW_API_KEY;

const HOLD_MS = Number(process.env.HOLD_MS ?? 180_000);
const RESTORE_ID = "15346096028";
const RESULT = "/tmp/sd-speak-probe-result.json";
const SUMMARY = "/tmp/sd-speak-summary.md";
const PROGRESS = "/tmp/sd-speak-probe-progress.json";

type CellRow = {
  cell: string;
  kicked: boolean;
  rHi: number;
  rSetCount: number;
  sumDelta: number;
  deltas: number[];
  modules: string[];
  softFail?: string;
  wallSec: number;
  notes: string;
  inert?: boolean;
  success: boolean;
};

function proxyUrl(): string | undefined {
  const raw =
    process.env.UNIPUS_WSS_PROXY?.trim() ||
    process.env.SAND_EGRESS_TUNNEL_PROXY_ADDR?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    "";
  if (!raw) return undefined;
  return raw.includes("://") ? raw : `http://${raw}`;
}

type Counts = {
  rHi: number;
  rSet: number;
  sumDelta: number;
  deltas: number[];
  modules: string[];
  lastAt: number;
};

class CountingWs extends EventEmitter implements StudyDurationWebSocketLike {
  private ws: WebSocket;
  constructor(url: string, counts: Counts) {
    super();
    const proxy = proxyUrl();
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    this.ws = new WebSocket(url, agent ? { agent } : undefined);
    this.ws.on("open", (...a) => this.emit("open", ...a));
    this.ws.on("error", (...a) => this.emit("error", ...a));
    this.ws.on("close", (...a) => this.emit("close", ...a));
    this.ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString();
      if (text.includes('["r_Hi"') || text.includes('"r_Hi"')) counts.rHi += 1;
      const idx = text.indexOf('["r_set"');
      if (idx >= 0) {
        try {
          const arr = JSON.parse(text.slice(idx)) as [
            string,
            { delta?: number; module?: string },
          ];
          const delta = Number(arr[1]?.delta ?? 0) || 0;
          counts.rSet += 1;
          counts.sumDelta += delta;
          counts.deltas.push(delta);
          if (arr[1]?.module) counts.modules.push(String(arr[1].module));
          counts.lastAt = Date.now();
          console.error(
            JSON.stringify({
              t: Date.now(),
              ev: "r_set",
              delta,
              sum: counts.sumDelta,
              n: counts.rSet,
              module: arr[1]?.module,
            }),
          );
        } catch {
          /* ignore */
        }
      }
      this.emit("message", raw);
    });
  }
  send(data: string | Buffer | Uint8Array) {
    this.ws.send(data);
  }
  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
  terminate() {
    this.ws.terminate();
  }
}

async function findAccountByNote(note: string): Promise<string> {
  const base = join(process.env.HOME!, ".config/unipus-mcp/accounts");
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(base)) {
    try {
      const meta = JSON.parse(await readFile(join(base, name, "meta.json"), "utf8"));
      if (meta.note === note) return name;
    } catch {
      /* skip */
    }
  }
  throw new Error(`account note not found: ${note}`);
}

function aud(jwt: string): string | null {
  try {
    return (
      JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).aud ?? null
    );
  } catch {
    return null;
  }
}

/** Speak-shaped uls kick (hypothesis: same uls_* module, speak H5 url/apptype). */
function buildSpeakUlsKick(
  taskId: string,
  qiId: string,
  openId: string,
  sendTimestamp: number,
  appMiddle = "/speak",
): KickStopPayload {
  const module = `uls_${qiId}`;
  const moduleGroup = `uls:${taskId}_1`;
  const origin = "https://uadaptive.unipus.cn";
  const url =
    `${origin}${appMiddle}?taskId=${encodeURIComponent(taskId)}` +
    `&ansVersion=1&mode=train&questionInstanceId=${encodeURIComponent(qiId)}`;
  return {
    client: "ucloud",
    module,
    moduleGroup,
    openId,
    sendTimestamp,
    tag3: JSON.stringify({
      module,
      moduleGroup,
      type: "train",
      enterStatus: "play",
      apptype: "speak",
      anstype: "ans",
      usertype: "active",
      questionInstanceId: qiId,
      appMiddle,
      application: module,
    }),
    url,
    appId: 116,
    serviceId: "uls",
  };
}

function buildSpeakUlsStop(
  taskId: string,
  qiId: string,
  openId: string,
  sendTimestamp: number,
): KickStopPayload {
  const module = `uls_${qiId}`;
  const moduleGroup = `uls:${taskId}_1`;
  return {
    client: "ucloud",
    module,
    moduleGroup,
    openId,
    sendTimestamp,
    TTL: 60,
    tag3: JSON.stringify({ module, moduleGroup, OS: "Android" }),
  };
}

async function speakPrelude(
  ssoJwt: string,
  openId: string,
): Promise<{
  taskId: string;
  qiId: string;
  instanceIds: string[];
  ok: boolean;
  err?: string;
}> {
  const http = createFetchUnipusHttp();
  const credentials = createStaticJwtStore(ssoJwt);
  try {
    const headers = ulsCloudHeaders(ssoJwt, process.env, openId);
    // best-effort loadAnswer after we know taskId
    const paper = await startSpeakingTraining(
      { http, credentials, env: process.env },
      { openId },
    );
    if ((paper as { isError?: boolean }).isError) {
      return {
        taskId: "",
        qiId: "",
        instanceIds: [],
        ok: false,
        err: `train:${(paper as { message?: string }).message ?? "isError"}`,
      };
    }
    const taskId = String((paper as { task_id?: string }).task_id ?? "");
    const ids = ((paper as { instance_ids?: string[] }).instance_ids ?? []).map(String);
    const qiId = ids[0] ?? "";
    if (!taskId || !qiId) {
      return {
        taskId,
        qiId,
        instanceIds: ids,
        ok: false,
        err: "missing taskId/qiId after loadPaper",
      };
    }
    try {
      await http.request({
        url: "https://uadaptive.unipus.cn/api/uls/user/loadAnswer",
        method: "POST",
        headers: { ...headers, "u-openid": openId },
        body: JSON.stringify({ taskId, ansVersion: 1 }),
      });
    } catch {
      /* best-effort */
    }
    return { taskId, qiId, instanceIds: ids, ok: true };
  } catch (e) {
    return {
      taskId: "",
      qiId: "",
      instanceIds: [],
      ok: false,
      err: `trainEx:${String(e)}`,
    };
  }
}

async function holdSession(
  start: () => Promise<StudyDurationSession>,
  counts: Counts,
): Promise<{ kicked: boolean; inert: boolean; softFail?: string; wallSec: number }> {
  const wallStart = Date.now();
  let session: StudyDurationSession;
  try {
    session = await start();
  } catch (e) {
    return {
      kicked: false,
      inert: true,
      softFail: e instanceof Error ? e.message : String(e),
      wallSec: Math.round((Date.now() - wallStart) / 1000),
    };
  }
  const settleDeadline = Date.now() + 15_000;
  while (Date.now() < settleDeadline && session.inert && !session.kicked) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const deadline = wallStart + HOLD_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    await session.dispose();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 500));
  return {
    kicked: session.kicked,
    inert: session.inert,
    softFail: session.inert && !session.kicked ? "inert_no_kick" : undefined,
    wallSec: Math.round((Date.now() - wallStart) / 1000),
  };
}

type RawSock = {
  ws: WebSocket;
  joined: boolean;
};

async function openCountingRaw(
  url: string,
  counts: Counts,
  label: string,
): Promise<RawSock> {
  const proxy = proxyUrl();
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  const ws = new WebSocket(url, agent ? { agent } : undefined);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} open timeout`)), 20_000);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  const sock: RawSock = { ws, joined: false };
  ws.on("message", (raw) => {
    const text = typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString();
    if (text === "2") {
      try {
        ws.send("3");
      } catch {
        /* */
      }
      return;
    }
    if (text.includes('["r_Hi"') || text.includes('"r_Hi"')) counts.rHi += 1;
    const idx = text.indexOf('["r_set"');
    if (idx >= 0) {
      try {
        const arr = JSON.parse(text.slice(idx)) as [
          string,
          { delta?: number; module?: string },
        ];
        const delta = Number(arr[1]?.delta ?? 0) || 0;
        counts.rSet += 1;
        counts.sumDelta += delta;
        counts.deltas.push(delta);
        if (arr[1]?.module) counts.modules.push(String(arr[1].module));
        counts.lastAt = Date.now();
        console.error(
          JSON.stringify({
            t: Date.now(),
            which: label,
            ev: "r_set",
            delta,
            sum: counts.sumDelta,
            n: counts.rSet,
            module: arr[1]?.module,
          }),
        );
      } catch {
        /* */
      }
    }
  });
  return sock;
}

async function joinRaw(sock: RawSock, jwt: string, openId: string, label: string) {
  const onMsg = (raw: WebSocket.RawData) => {
    const s = typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString();
    if (s === "2") {
      try {
        sock.ws.send("3");
      } catch {
        /* */
      }
      return;
    }
    if (s.startsWith("0") || s === "40" || s.startsWith("40,")) {
      sock.ws.send(encodeNamespaceJoin(openId, jwt));
      return;
    }
    if (s.startsWith("40/userActivities")) sock.joined = true;
  };
  sock.ws.on("message", onMsg);
  setTimeout(() => {
    if (!sock.joined) sock.ws.send(encodeNamespaceJoin(openId, jwt));
  }, 80);
  const start = Date.now();
  while (!sock.joined && Date.now() - start < 12_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!sock.joined) throw new Error(`${label} join timeout`);
  console.error(JSON.stringify({ ev: "joined", label, aud: aud(jwt) }));
}

async function holdRawDual(opts: {
  ssoJwt: string;
  edxJwt: string;
  openId: string;
  counts: Counts;
  onReady: (ctx: {
    edx: WebSocket;
    sso: WebSocket;
    nextAck: () => number;
    kickHub: (module: "shouye" | "ukouyu" | "utingli", event: "kick-v2" | "stop") => void;
    kickUlsSpeak: () => void;
    kickUlsListenShape: () => void;
    stopUlsSpeak: () => void;
    kickSsoHub: (module: "ukouyu") => void;
  }) => Promise<void> | void;
  taskId: string;
  qiId: string;
}): Promise<{ kicked: boolean; softFail?: string; wallSec: number }> {
  const wallStart = Date.now();
  let kicked = false;
  let ack = 0;
  const nextAck = () => ack++;
  try {
    const edxUrl = buildUnipusioUrl(opts.openId, opts.edxJwt);
    const ssoUrl = buildUnipusioUrl(opts.openId, opts.ssoJwt);
    const edx = await openCountingRaw(edxUrl, opts.counts, "edx");
    const sso = await openCountingRaw(ssoUrl, opts.counts, "sso");
    await joinRaw(edx, opts.edxJwt, opts.openId, "edx");
    await joinRaw(sso, opts.ssoJwt, opts.openId, "sso");

    const ping = setInterval(() => {
      try {
        edx.ws.send("2");
        sso.ws.send("2");
      } catch {
        /* */
      }
    }, STUDY_DURATION_PING_MS);

    const kickHub = (
      module: "shouye" | "ukouyu" | "utingli",
      event: "kick-v2" | "stop",
    ) => {
      const hub: StudyDurationTarget = { kind: "hub", module };
      const payload =
        event === "kick-v2"
          ? buildKickPayload(hub, opts.openId, Date.now())
          : buildStopPayload(hub, opts.openId, Date.now());
      edx.ws.send(encodeNamespaceEvent(nextAck(), event, payload));
      console.error(JSON.stringify({ ev: event, which: "edx", module }));
    };

    const kickUlsSpeak = () => {
      const payload = buildSpeakUlsKick(opts.taskId, opts.qiId, opts.openId, Date.now());
      sso.ws.send(encodeNamespaceEvent(nextAck(), "kick-v2", payload));
      kicked = true;
      console.error(
        JSON.stringify({
          ev: "kick-v2",
          which: "sso",
          module: payload.module,
          shape: "speak-uls",
        }),
      );
    };
    const kickUlsListenShape = () => {
      const target = listenStudyTarget({
        taskId: opts.taskId,
        questionInstanceId: opts.qiId,
      });
      const payload = buildKickPayload(target, opts.openId, Date.now());
      sso.ws.send(encodeNamespaceEvent(nextAck(), "kick-v2", payload));
      kicked = true;
      console.error(
        JSON.stringify({
          ev: "kick-v2",
          which: "sso",
          module: payload.module,
          shape: "listenTask-reuse",
        }),
      );
    };
    const stopUlsSpeak = () => {
      const payload = buildSpeakUlsStop(opts.taskId, opts.qiId, opts.openId, Date.now());
      sso.ws.send(encodeNamespaceEvent(nextAck(), "stop", payload));
    };
    const kickSsoHub = (module: "ukouyu") => {
      const hub: StudyDurationTarget = { kind: "hub", module };
      const payload = buildKickPayload(hub, opts.openId, Date.now());
      sso.ws.send(encodeNamespaceEvent(nextAck(), "kick-v2", payload));
      kicked = true;
      console.error(JSON.stringify({ ev: "kick-v2", which: "sso", module }));
    };

    await opts.onReady({
      edx: edx.ws,
      sso: sso.ws,
      nextAck,
      kickHub,
      kickUlsSpeak,
      kickUlsListenShape,
      stopUlsSpeak,
      kickSsoHub,
    });

    const refresh = setInterval(() => {
      /* cell-specific refresh is re-done inside onReady via returned disposer; default: re-kick speak uls if kicked */
    }, STUDY_DURATION_REFRESH_MS);

    const deadline = wallStart + HOLD_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    clearInterval(ping);
    clearInterval(refresh);
    try {
      if (kicked) stopUlsSpeak();
    } catch {
      /* */
    }
    try {
      edx.ws.close();
    } catch {
      /* */
    }
    try {
      sso.ws.close();
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 500));
    return {
      kicked,
      wallSec: Math.round((Date.now() - wallStart) / 1000),
    };
  } catch (e) {
    return {
      kicked,
      softFail: e instanceof Error ? e.message : String(e),
      wallSec: Math.round((Date.now() - wallStart) / 1000),
    };
  }
}

function rowFrom(
  cell: string,
  counts: Counts,
  hold: { kicked: boolean; inert?: boolean; softFail?: string; wallSec: number },
  notes: string,
): CellRow {
  const success = counts.rSet > 0 && counts.sumDelta > 0;
  return {
    cell,
    kicked: hold.kicked,
    rHi: counts.rHi,
    rSetCount: counts.rSet,
    sumDelta: counts.sumDelta,
    deltas: counts.deltas,
    modules: counts.modules,
    softFail: hold.softFail,
    wallSec: hold.wallSec,
    notes,
    inert: hold.inert,
    success,
  };
}

async function main() {
  const meId = await findAccountByNote("me");
  await setActiveAccountId(meId);
  const ssoJwt = (await readFile(join(accountDir(meId), "jwt"), "utf8")).trim();
  const edxJwt =
    (await resolveEdxJwt(process.env, { accountId: meId })) ||
    (await readFile(join(accountDir(meId), "edx-jwt"), "utf8")).trim();
  const openId =
    openIdFromJwt(ssoJwt) || openIdFromJwt(edxJwt) || "";
  if (!openId) throw new Error("openId missing");
  if (!edxJwt) throw new Error("edx-jwt missing for me");

  console.error(
    JSON.stringify({
      phase: "start",
      meSuffix4: meId.slice(-4),
      ssoAud: aud(ssoJwt),
      edxAud: aud(edxJwt),
      holdMs: HOLD_MS,
    }),
  );

  const prelude = await speakPrelude(ssoJwt, openId);
  console.error(
    JSON.stringify({
      phase: "prelude",
      ok: prelude.ok,
      taskIdSuffix: prelude.taskId.slice(-6),
      qiIdSuffix: prelude.qiId.slice(-6),
      nInstances: prelude.instanceIds.length,
      err: prelude.err,
    }),
  );
  if (!prelude.ok) {
    const out = {
      ok: false,
      prelude,
      cells: [] as CellRow[],
      activeRestored: false,
      holdMs: HOLD_MS,
    };
    await writeFile(RESULT, JSON.stringify(out, null, 2));
    await setActiveAccountId(RESTORE_ID);
    out.activeRestored = true;
    await writeFile(RESULT, JSON.stringify(out, null, 2));
    throw new Error(`speak prelude failed: ${prelude.err}`);
  }

  const { taskId, qiId } = prelude;
  const cells: CellRow[] = [];

  const saveProgress = async () => {
    await writeFile(
      PROGRESS,
      JSON.stringify({ taskIdSuffix: taskId.slice(-6), cells }, null, 2),
    );
  };

  // Cell A: dual + uls via startDual (listenTask shape, speak ids)
  {
    const cell = "dual+uls-listenShape";
    console.error(JSON.stringify({ phase: "cell", cell }));
    const counts: Counts = {
      rHi: 0,
      rSet: 0,
      sumDelta: 0,
      deltas: [],
      modules: [],
      lastAt: 0,
    };
    const ports = {
      createWebSocket: (url: string) =>
        new CountingWs(url, counts) as unknown as StudyDurationWebSocketLike,
      log: (msg: string) => console.error(`[speak-probe ${cell}] ${msg}`),
      readyTimeoutMs: 15_000,
    };
    const target = listenStudyTarget({ taskId, questionInstanceId: qiId });
    const hold = await holdSession(
      () =>
        softStartStudyDuration(
          {
            jwt: ssoJwt,
            edxJwt,
            openId,
            accountId: meId,
            target,
            env: process.env,
          },
          ports,
        ),
      counts,
    );
    cells.push(
      rowFrom(
        cell,
        counts,
        hold,
        `startDual listenTask shape with speak ids; kicked=${hold.kicked}`,
      ),
    );
    await saveProgress();
  }

  // Cell B: App-mirror speak: edx shouye→ukouyu→stop ukouyu, SSO speak-uls kick
  {
    const cell = "dual-appseq-ukouyu-then-speak-uls";
    console.error(JSON.stringify({ phase: "cell", cell }));
    const counts: Counts = {
      rHi: 0,
      rSet: 0,
      sumDelta: 0,
      deltas: [],
      modules: [],
      lastAt: 0,
    };
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    const hold = await holdRawDual({
      ssoJwt,
      edxJwt,
      openId,
      counts,
      taskId,
      qiId,
      onReady: async (ctx) => {
        ctx.kickHub("shouye", "kick-v2");
        await new Promise((r) => setTimeout(r, 300));
        ctx.kickHub("ukouyu", "kick-v2");
        await new Promise((r) => setTimeout(r, 500));
        ctx.kickHub("ukouyu", "stop");
        await new Promise((r) => setTimeout(r, 300));
        ctx.kickUlsSpeak();
        refreshTimer = setInterval(() => ctx.kickUlsSpeak(), STUDY_DURATION_REFRESH_MS);
      },
    });
    if (refreshTimer) clearInterval(refreshTimer);
    cells.push(
      rowFrom(
        cell,
        counts,
        hold,
        "edx hub shouye→ukouyu→stop; SSO kick speak-uls (/speak apptype=speak)",
      ),
    );
    await saveProgress();
  }

  // Cell C: edx stays joined + SSO kicks ukouyu hub
  {
    const cell = "edx-joined+sso-ukouyu";
    console.error(JSON.stringify({ phase: "cell", cell }));
    const counts: Counts = {
      rHi: 0,
      rSet: 0,
      sumDelta: 0,
      deltas: [],
      modules: [],
      lastAt: 0,
    };
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    const hold = await holdRawDual({
      ssoJwt,
      edxJwt,
      openId,
      counts,
      taskId,
      qiId,
      onReady: async (ctx) => {
        // edx just stays joined (optional soft hub kick then leave it)
        ctx.kickHub("shouye", "kick-v2");
        await new Promise((r) => setTimeout(r, 200));
        ctx.kickSsoHub("ukouyu");
        refreshTimer = setInterval(() => ctx.kickSsoHub("ukouyu"), STUDY_DURATION_REFRESH_MS);
      },
    });
    if (refreshTimer) clearInterval(refreshTimer);
    cells.push(
      rowFrom(cell, counts, hold, "edx presence online; SSO kicks ukouyu hub"),
    );
    await saveProgress();
  }

  // Cell D: edx kicks ukouyu alone (control)
  {
    const cell = "edx-hub-ukouyu-alone";
    console.error(JSON.stringify({ phase: "cell", cell }));
    const counts: Counts = {
      rHi: 0,
      rSet: 0,
      sumDelta: 0,
      deltas: [],
      modules: [],
      lastAt: 0,
    };
    const ports = {
      createWebSocket: (url: string) =>
        new CountingWs(url, counts) as unknown as StudyDurationWebSocketLike,
      log: (msg: string) => console.error(`[speak-probe ${cell}] ${msg}`),
      readyTimeoutMs: 15_000,
    };
    const hold = await holdSession(
      () =>
        startStudyDuration(
          {
            jwt: edxJwt,
            openId,
            target: { kind: "hub", module: "ukouyu" },
            env: process.env,
          },
          ports,
        ),
      counts,
    );
    cells.push(rowFrom(cell, counts, hold, "control: edx alone kicks ukouyu"));
    await saveProgress();
  }

  // Extra cell E if A/B failed: dual with speak-uls but listen-shape kick already tried;
  // try dual-appseq with listenShape uls after ukouyu stop
  if (!cells.some((c) => c.success)) {
    const cell = "dual-appseq-ukouyu-then-listenShape-uls";
    console.error(JSON.stringify({ phase: "cell", cell }));
    const counts: Counts = {
      rHi: 0,
      rSet: 0,
      sumDelta: 0,
      deltas: [],
      modules: [],
      lastAt: 0,
    };
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    const hold = await holdRawDual({
      ssoJwt,
      edxJwt,
      openId,
      counts,
      taskId,
      qiId,
      onReady: async (ctx) => {
        ctx.kickHub("shouye", "kick-v2");
        await new Promise((r) => setTimeout(r, 300));
        ctx.kickHub("ukouyu", "kick-v2");
        await new Promise((r) => setTimeout(r, 500));
        ctx.kickHub("ukouyu", "stop");
        await new Promise((r) => setTimeout(r, 300));
        ctx.kickUlsListenShape();
        refreshTimer = setInterval(
          () => ctx.kickUlsListenShape(),
          STUDY_DURATION_REFRESH_MS,
        );
      },
    });
    if (refreshTimer) clearInterval(refreshTimer);
    cells.push(
      rowFrom(
        cell,
        counts,
        hold,
        "fallback: ukouyu stop then SSO listenShape uls with speak ids",
      ),
    );
    await saveProgress();
  }

  await setActiveAccountId(RESTORE_ID);
  const activeNow = (await readFile(
    join(process.env.HOME!, ".config/unipus-mcp/active-account.txt"),
    "utf8",
  )).trim();

  const winners = cells.filter((c) => c.success).map((c) => c.cell);
  const out = {
    ok: winners.length > 0,
    holdMs: HOLD_MS,
    accountNote: "me",
    accountSuffix4: meId.slice(-4),
    prelude: {
      ok: prelude.ok,
      taskIdSuffix: taskId.slice(-6),
      qiIdSuffix: qiId.slice(-6),
      nInstances: prelude.instanceIds.length,
    },
    cells,
    winners,
    activeRestored: activeNow === RESTORE_ID,
    hypothesis:
      "speak H5 uses same uls_<qiId>/uls:<taskId>_1 dual pattern after stop ukouyu",
    timestamp: new Date().toISOString(),
  };
  await writeFile(RESULT, JSON.stringify(out, null, 2));

  const md = [
    "# Speak StudyDuration probe",
    "",
    `HOLD_MS=${HOLD_MS} account=me winners=${winners.join(",") || "(none)"}`,
    "",
    "| cell | kicked | r_set | sumΔ | success | notes |",
    "|---|---|---|---|---|---|",
    ...cells.map(
      (c) =>
        `| ${c.cell} | ${c.kicked} | ${c.rSetCount} | ${c.sumDelta} | ${c.success} | ${c.notes}${c.softFail ? ` softFail=${c.softFail}` : ""} |`,
    ),
    "",
    `activeRestored=${out.activeRestored}`,
  ].join("\n");
  await writeFile(SUMMARY, md);
  console.log(JSON.stringify({ done: true, winners, activeRestored: out.activeRestored }));
}

main().catch(async (e) => {
  console.error(String(e));
  try {
    await setActiveAccountId(RESTORE_ID);
  } catch {
    /* */
  }
  process.exit(1);
});
