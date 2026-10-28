/**
 * App study-time presence for learning-report kpi.durationHours (#121).
 *
 * Source of truth (mitm 2026-10-28): Socket.IO on
 *   wss://ucontent.unipus.cn/unipusio/?EIO=3&transport=websocket&uuid=<openId>&token=<JWT>
 * namespace /userActivities — client emit kick-v2 (TTL 60s) / stop; server r_set.delta credits seconds.
 * NOT submitAnswer durationSec, saveSnapshot.duration, or datasink analytics.
 *
 * Soft-fail: connection / protocol errors are logged and never throw into grind scoring.
 */
import WebSocket from "ws";

import { DEFAULT_U_APP_ID, resolveUAppId } from "./config.js";
import { openIdFromJwt } from "./uls-business.js";

export const DEFAULT_UNIPUSIO_WSS_URL = "wss://ucontent.unipus.cn/unipusio/";
export const STUDY_DURATION_TTL_SEC = 60;
/** Refresh kick-v2 before TTL expires (App TTL=60). */
export const STUDY_DURATION_REFRESH_MS = 45_000;
/** App client-initiated Engine.IO ping interval (~25s). */
export const STUDY_DURATION_PING_MS = 25_000;
export const STUDY_DURATION_NAMESPACE = "/userActivities";

/** Minimal WebSocket surface for injection / unit mocks (mirrors clio-speech). */
export type StudyDurationWebSocketLike = {
  on(
    event: "open" | "message" | "error" | "close",
    listener: (...args: unknown[]) => void,
  ): void;
  send(data: string | Buffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
};

export type StudyDurationHubModule = "utingli" | "ukouyu";

export type StudyDurationTarget =
  | { kind: "hub"; module: StudyDurationHubModule }
  | {
      kind: "listenTask";
      taskId: string;
      questionInstanceId: string;
      ansVersion?: number;
      /** Default /listen/guide. */
      appMiddle?: string;
      adaptiveOrigin?: string;
      appId?: number | string;
    };

export type StudyDurationSession = {
  /** Emit stop (best-effort) and close the socket. Safe to call more than once. */
  dispose: () => Promise<void>;
  /** True once the first kick-v2 was sent (tests). */
  get kicked(): boolean;
  /** True when this handle is a soft-fail no-op. */
  get inert(): boolean;
};

export type StudyDurationPorts = {
  createWebSocket?: (url: string) => StudyDurationWebSocketLike;
  nowMs?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  log?: (msg: string) => void;
  /** Wait for namespace join + first kick; default 8s. Soft-fail if exceeded. */
  readyTimeoutMs?: number;
};

export function resolveUnipusioWssUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.UNIPUS_UNIPUSIO_WSS_URL?.trim() || DEFAULT_UNIPUSIO_WSS_URL;
  return raw.replace(/\?+$/, "");
}

export function buildUnipusioUrl(openId: string, jwt: string, env?: NodeJS.ProcessEnv): string {
  const token = jwt.replace(/^Bearer\s+/i, "").trim();
  const base = resolveUnipusioWssUrl(env);
  const sep = base.includes("?") ? "&" : "?";
  return (
    `${base}${sep}EIO=3&transport=websocket` +
    `&uuid=${encodeURIComponent(openId)}&token=${encodeURIComponent(token)}`
  );
}

/** Prefer listen adaptive H5 module when qiId is known; else U听力 hub. */
export function listenStudyTarget(input: {
  taskId: string;
  questionInstanceId?: string | null;
  ansVersion?: number;
  env?: NodeJS.ProcessEnv;
}): StudyDurationTarget {
  const qi = input.questionInstanceId?.trim();
  if (qi != null && qi.length > 0 && input.taskId.trim().length > 0) {
    const origin =
      input.env?.UNIPUS_ULS_ADAPTIVE_ORIGIN?.trim() || "https://uadaptive.unipus.cn";
    return {
      kind: "listenTask",
      taskId: input.taskId.trim(),
      questionInstanceId: qi,
      ansVersion: input.ansVersion ?? 1,
      adaptiveOrigin: origin.replace(/\/+$/, ""),
      appId: resolveUAppId(input.env),
    };
  }
  return { kind: "hub", module: "utingli" };
}

export function speakStudyTarget(): StudyDurationTarget {
  return { kind: "hub", module: "ukouyu" };
}

export type KickStopPayload = {
  client: "ucloud";
  module: string;
  moduleGroup: string;
  openId: string;
  sendTimestamp: number;
  TTL?: number;
  tag3: string;
  url?: string;
  appId?: number;
  serviceId?: string;
};

export function buildKickPayload(
  target: StudyDurationTarget,
  openId: string,
  sendTimestamp: number,
): KickStopPayload {
  if (target.kind === "hub") {
    return {
      client: "ucloud",
      module: target.module,
      moduleGroup: "app",
      openId,
      sendTimestamp,
      TTL: STUDY_DURATION_TTL_SEC,
      tag3: JSON.stringify({ role: "student", status: "train", OS: "Android" }),
    };
  }
  const module = `uls_${target.questionInstanceId}`;
  const moduleGroup = `uls:${target.taskId}_1`;
  const appMiddle = target.appMiddle?.trim() || "/listen/guide";
  const ansVersion = target.ansVersion ?? 1;
  const origin = (target.adaptiveOrigin ?? "https://uadaptive.unipus.cn").replace(/\/+$/, "");
  const appIdRaw = target.appId ?? DEFAULT_U_APP_ID;
  const appId = typeof appIdRaw === "number" ? appIdRaw : Number(appIdRaw) || 116;
  const url =
    `${origin}${appMiddle}?taskId=${encodeURIComponent(target.taskId)}` +
    `&ansVersion=${ansVersion}&mode=train&questionInstanceId=${encodeURIComponent(target.questionInstanceId)}`;
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
      apptype: "listen",
      anstype: "ans",
      usertype: "active",
      questionInstanceId: target.questionInstanceId,
      appMiddle,
      application: module,
    }),
    url,
    appId,
    serviceId: "uls",
  };
}

export function buildStopPayload(
  target: StudyDurationTarget,
  openId: string,
  sendTimestamp: number,
): KickStopPayload {
  if (target.kind === "hub") {
    return {
      client: "ucloud",
      module: target.module,
      moduleGroup: "app",
      openId,
      sendTimestamp,
      TTL: STUDY_DURATION_TTL_SEC,
      tag3: JSON.stringify({ role: "student", OS: "Android" }),
    };
  }
  // Listen-task stop mirrors kick module ids (hub stop shape without train status).
  const kick = buildKickPayload(target, openId, sendTimestamp);
  const { url: _url, appId: _appId, serviceId: _svc, ...rest } = kick;
  return {
    ...rest,
    TTL: STUDY_DURATION_TTL_SEC,
    tag3: JSON.stringify({
      module: kick.module,
      moduleGroup: kick.moduleGroup,
      OS: "Android",
    }),
  };
}

export function encodeNamespaceEvent(
  ackId: number,
  event: "kick-v2" | "stop",
  payload: KickStopPayload,
): string {
  return `42${STUDY_DURATION_NAMESPACE},${ackId}${JSON.stringify([event, payload])}`;
}

export function encodeNamespaceJoin(openId: string, jwt: string): string {
  const token = jwt.replace(/^Bearer\s+/i, "").trim();
  return (
    `40${STUDY_DURATION_NAMESPACE}?uuid=${encodeURIComponent(openId)}` +
    `&token=${encodeURIComponent(token)}`
  );
}

const NOOP_SESSION: StudyDurationSession = {
  async dispose() {},
  get kicked() {
    return false;
  },
  get inert() {
    return true;
  },
};

/**
 * Soft-start presence for a grind paper. Never throws.
 * Handshake runs in the background so a slow/unreachable unipusio cannot delay scoring (#121 / Codex).
 * `dispose` awaits settle then stop; failures become an inert session.
 */
export async function softStartStudyDuration(
  input: {
    jwt: string;
    openId?: string;
    target: StudyDurationTarget;
    env?: NodeJS.ProcessEnv;
    /** When false, skip entirely (tests). Default true. */
    enabled?: boolean;
  },
  ports: StudyDurationPorts = {},
): Promise<StudyDurationSession> {
  if (input.enabled === false) return NOOP_SESSION;
  const log = ports.log ?? ((msg: string) => console.error(`[study-duration] ${msg}`));
  const jwt = input.jwt?.trim() ?? "";
  const openId = (input.openId?.trim() || (jwt ? openIdFromJwt(jwt) : undefined) || "").trim();
  // Fake JWTs in unit tests have no openId claim — skip quietly; live App JWTs always carry it.
  if (jwt.length === 0 || openId.length === 0) return NOOP_SESSION;

  let session: StudyDurationSession = NOOP_SESSION;
  const settled = startStudyDuration({ ...input, jwt, openId }, ports).then(
    (s) => {
      session = s;
      return s;
    },
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      log(`soft-fail start: ${msg}`);
      session = NOOP_SESSION;
      return NOOP_SESSION;
    },
  );

  return {
    get kicked() {
      return session.kicked;
    },
    get inert() {
      return session.inert;
    },
    async dispose() {
      await (await settled).dispose();
    },
  };
}

/**
 * Connect unipusio, join /userActivities, emit kick-v2, refresh within TTL, stop on dispose.
 * Throws only for missing openId / immediate constructor failure — prefer softStartStudyDuration in grind.
 */
export async function startStudyDuration(
  input: {
    jwt: string;
    openId?: string;
    target: StudyDurationTarget;
    env?: NodeJS.ProcessEnv;
  },
  ports: StudyDurationPorts = {},
): Promise<StudyDurationSession> {
  const jwt = input.jwt?.trim() ?? "";
  if (jwt.length === 0) {
    throw new Error("study-duration: jwt required");
  }
  const openId = (input.openId?.trim() || openIdFromJwt(jwt) || "").trim();
  if (openId.length === 0) {
    throw new Error("study-duration: openId missing (JWT openId claim)");
  }

  const nowMs = ports.nowMs ?? Date.now;
  const setIntervalFn = ports.setIntervalFn ?? setInterval;
  const clearIntervalFn = ports.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = ports.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = ports.clearTimeoutFn ?? clearTimeout;
  const log = ports.log ?? ((msg: string) => console.error(`[study-duration] ${msg}`));
  const readyTimeoutMs = ports.readyTimeoutMs ?? 8_000;

  const url = buildUnipusioUrl(openId, jwt, input.env);
  const createWs =
    ports.createWebSocket ??
    ((u: string) => new WebSocket(u) as unknown as StudyDurationWebSocketLike);

  let socket: StudyDurationWebSocketLike;
  try {
    socket = createWs(url);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  let disposed = false;
  let joined = false;
  let kicked = false;
  let ackId = 0;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const nextAck = () => {
    const id = ackId;
    ackId = (ackId + 1) % 1_000_000;
    return id;
  };

  const safeSend = (data: string) => {
    if (disposed) return;
    try {
      socket.send(data);
    } catch (error) {
      log(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const emitKick = () => {
    const payload = buildKickPayload(input.target, openId, nowMs());
    safeSend(encodeNamespaceEvent(nextAck(), "kick-v2", payload));
    kicked = true;
  };

  const emitStop = () => {
    const payload = buildStopPayload(input.target, openId, nowMs());
    safeSend(encodeNamespaceEvent(nextAck(), "stop", payload));
  };

  const startHeartbeat = () => {
    if (refreshTimer != null || disposed) return;
    refreshTimer = setIntervalFn(() => {
      if (disposed) return;
      emitKick();
    }, STUDY_DURATION_REFRESH_MS);
    // App sends Engine.IO ping `2` (~25s); server replies `3`.
    pingTimer = setIntervalFn(() => {
      if (disposed) return;
      safeSend("2");
    }, STUDY_DURATION_PING_MS);
  };

  const joinNamespace = () => {
    if (joined || disposed) return;
    joined = true;
    safeSend(encodeNamespaceJoin(openId, jwt));
  };

  const onJoined = () => {
    if (disposed) return;
    if (readyTimer != null) {
      clearTimeoutFn(readyTimer);
      readyTimer = null;
    }
    if (!kicked) emitKick();
    startHeartbeat();
    settleReady();
  };

  let settleReady: () => void = () => {};
  let rejectReady: (err: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });

  const onMessage = (raw: unknown) => {
    if (disposed) return;
    const text = messageText(raw);
    if (text == null) return;

    // Engine.IO ping from server (rare here; App usually client-pings).
    if (text === "2") {
      safeSend("3");
      return;
    }
    if (text === "3") return;

    // Engine.IO OPEN or default-namespace CONNECT → join /userActivities.
    if (text.startsWith("0") || text === "40" || text.startsWith("40,")) {
      joinNamespace();
      return;
    }

    // Namespace connected: 40/userActivities or 40/userActivities,
    if (text.startsWith(`40${STUDY_DURATION_NAMESPACE}`)) {
      onJoined();
      return;
    }

    // ACK / server events — ignore (r_set credits are server-side).
  };

  socket.on("message", (...args: unknown[]) => {
    try {
      onMessage(args[0]);
    } catch (error) {
      log(`message handler: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  socket.on("error", (...args: unknown[]) => {
    const err = args[0];
    const msg = err instanceof Error ? err.message : String(err ?? "ws error");
    log(msg);
    if (!kicked) rejectReady(new Error(msg));
  });
  socket.on("close", () => {
    if (!disposed && !kicked) {
      rejectReady(new Error("study-duration: socket closed before kick"));
    }
  });
  socket.on("open", () => {
    // If the server never sends OPEN/`40`, still attempt join shortly after open.
    setTimeoutFn(() => {
      if (!joined && !disposed) joinNamespace();
    }, 50);
  });

  readyTimer = setTimeoutFn(() => {
    if (!kicked) {
      rejectReady(new Error(`study-duration: ready timeout (${readyTimeoutMs}ms)`));
    }
  }, readyTimeoutMs);

  try {
    await ready;
  } catch (error) {
    // Mark disposed before close so a late 40/userActivities cannot startHeartbeat (#CodeRabbit).
    disposed = true;
    if (readyTimer != null) clearTimeoutFn(readyTimer);
    readyTimer = null;
    if (refreshTimer != null) clearIntervalFn(refreshTimer);
    if (pingTimer != null) clearIntervalFn(pingTimer);
    refreshTimer = null;
    pingTimer = null;
    await destroySocket(socket);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return {
    get kicked() {
      return kicked;
    },
    get inert() {
      return false;
    },
    async dispose() {
      if (disposed) return;
      // Stop timers first, then emit stop while the socket is still allowed to send,
      // then mark disposed and close (safeSend guards on disposed).
      if (readyTimer != null) clearTimeoutFn(readyTimer);
      if (refreshTimer != null) clearIntervalFn(refreshTimer);
      if (pingTimer != null) clearIntervalFn(pingTimer);
      refreshTimer = null;
      pingTimer = null;
      try {
        if (kicked) emitStop();
      } catch (error) {
        log(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      disposed = true;
      await destroySocket(socket);
    },
  };
}

function messageText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return null;
}

async function destroySocket(socket: StudyDurationWebSocketLike): Promise<void> {
  try {
    socket.close();
  } catch {
    try {
      socket.terminate?.();
    } catch {
      /* ignore */
    }
  }
}
