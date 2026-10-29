/**
 * App study-time presence for learning-report kpi.durationHours (#121).
 *
 * Source of truth (mitm 2026-10-28): Socket.IO on
 *   wss://ucontent.unipus.cn/unipusio/?EIO=3&transport=websocket&uuid=<openId>&token=<JWT>
 * namespace /userActivities — client emit kick-v2 (TTL 60s) / stop; server r_set.delta credits seconds.
 * NOT submitAnswer durationSec, saveSnapshot.duration, or datasink analytics.
 *
 * Soft-start helpers still NOOP for unit fakes (no openId). Live grind requires dual-JWT
 * + r_set credit (#130 hard gate): see missingEdxJwtDetail / waitForStudyDuration*.
 */
import { readFile } from "node:fs/promises";

import WebSocket from "ws";

import { readActiveAccountId } from "./accounts.js";
import { DEFAULT_U_APP_ID, resolveUAppId } from "./config.js";
import { extractJwtFromText, readEdxJwtForAccount } from "./credentials.js";
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

export type StudyDurationHubModule = "utingli" | "ukouyu" | "shouye";

export type StudyDurationTarget =
  | { kind: "hub"; module: StudyDurationHubModule }
  | {
      kind: "listenTask";
      taskId: string;
      questionInstanceId: string;
      ansVersion?: number;
      /** Default /listen/guide (listen) or /speak (speak). */
      appMiddle?: string;
      /** tag3.apptype + URL path; default listen. Speak dual uses "speak" (#126). */
      apptype?: "listen" | "speak";
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
  /** True when edx+SSO dual path was used (only this credits durationHours). */
  get dual(): boolean;
  /** Count of server `r_set` events with delta≥1 observed on presence sockets. */
  get rSetCount(): number;
  /** Sum of those r_set deltas (seconds credited while paper open). */
  get sumDelta(): number;
};

/** Minimum credit for hard gate: at least one r_set with delta≥1 (#130). */
export function studyDurationCreditOk(session: Pick<StudyDurationSession, "rSetCount" | "sumDelta">): boolean {
  return session.rSetCount >= 1 && session.sumDelta >= 1;
}

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


export type ResolveEdxJwtOptions = {
  /** Prefer this account's accounts/<id>/edx-jwt (after env). */
  accountId?: string;
  homedir?: string;
  readFile?: (path: string) => Promise<string>;
};

/**
 * Resolve native App edx.unipus.cn JWT for dual-socket presence (#121).
 * Order: UNIPUS_EDX_JWT → UNIPUS_EDX_JWT_FILE → accounts/<id>/edx-jwt
 * (explicit accountId, else active-account.txt). Soft-missing → undefined.
 * Never logs the token value.
 */
export async function resolveEdxJwt(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveEdxJwtOptions = {},
): Promise<string | undefined> {
  const inline = env.UNIPUS_EDX_JWT?.trim();
  if (inline) {
    const token = inline.replace(/^Bearer\s+/i, "").trim();
    if (token) return token;
  }

  const filePath = env.UNIPUS_EDX_JWT_FILE?.trim();
  if (filePath) {
    const read = options.readFile ?? ((p: string) => readFile(p, "utf8"));
    try {
      const raw = await read(filePath);
      const token = extractJwtFromText(raw);
      if (token != null) return token;
    } catch (error) {
      if (
        error == null ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  let accountId = options.accountId?.trim() || "";
  if (!accountId) {
    const active = await readActiveAccountId({
      env,
      home: options.homedir,
      readFile:
        options.readFile != null
          ? async (p) => options.readFile!(p)
          : undefined,
    });
    accountId = active?.trim() ?? "";
  }
  if (accountId) {
    const fromAccount = await readEdxJwtForAccount(accountId, {
      env,
      homedir: options.homedir,
      readFile: options.readFile,
    });
    if (fromAccount != null && fromAccount.length > 0) return fromAccount;
  }
  return undefined;
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

/** Prefer speak adaptive H5 uls_* when qiId is known; else U口语 hub. */
export function speakStudyTarget(input?: {
  taskId?: string;
  questionInstanceId?: string | null;
  ansVersion?: number;
  env?: NodeJS.ProcessEnv;
}): StudyDurationTarget {
  const taskId = input?.taskId?.trim() ?? "";
  const qi = input?.questionInstanceId?.trim();
  if (qi != null && qi.length > 0 && taskId.length > 0) {
    const origin =
      input?.env?.UNIPUS_ULS_ADAPTIVE_ORIGIN?.trim() || "https://uadaptive.unipus.cn";
    return {
      kind: "listenTask",
      taskId,
      questionInstanceId: qi,
      ansVersion: input?.ansVersion ?? 1,
      appMiddle: "/speak",
      apptype: "speak",
      adaptiveOrigin: origin.replace(/\/+$/, ""),
      appId: resolveUAppId(input?.env),
    };
  }
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
  const apptype = target.apptype === "speak" ? "speak" : "listen";
  const appMiddle =
    target.appMiddle?.trim() || (apptype === "speak" ? "/speak" : "/listen/guide");
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
      apptype,
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
  get dual() {
    return false;
  },
  get rSetCount() {
    return 0;
  },
  get sumDelta() {
    return 0;
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
    /**
     * Native App edx.unipus.cn JWT. When set with listenTask (listen or speak
     * apptype), opens a second unipusio socket that receives r_set while SSO
     * jwt emits uls kick-v2 (#121 / #126).
     */
    edxJwt?: string;
    /** Prefer accounts/<id>/edx-jwt when edxJwt / env unset. */
    accountId?: string;
  },
  ports: StudyDurationPorts = {},
): Promise<StudyDurationSession> {
  const log = ports.log ?? ((msg: string) => console.error(`[study-duration] ${msg}`));
  const jwt = input.jwt?.trim() ?? "";
  const edxRaw =
    input.edxJwt?.trim() ||
    (await resolveEdxJwt(input.env ?? process.env, { accountId: input.accountId }));
  const edxJwt = edxRaw && edxRaw.length > 0 ? edxRaw : undefined;
  const openId = (input.openId?.trim() || (jwt ? openIdFromJwt(jwt) : undefined) || "").trim();
  // Fake JWTs in unit tests have no openId claim — skip quietly; live App JWTs always carry it.
  if (jwt.length === 0 || openId.length === 0) return NOOP_SESSION;

  let session: StudyDurationSession = NOOP_SESSION;
  const starter =
    edxJwt != null && input.target.kind === "listenTask"
      ? startDualStudyDuration({ jwt, edxJwt, openId, target: input.target, env: input.env }, ports)
      : startStudyDuration({ ...input, jwt, openId }, ports);
  const settled = starter.then(
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
    get dual() {
      return session.dual;
    },
    get rSetCount() {
      return session.rSetCount;
    },
    get sumDelta() {
      return session.sumDelta;
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
  let rSetCount = 0;
  let sumDelta = 0;
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

    // ACK / server events — track r_set for hard-gate credit (#130).
    noteRSet(text, (delta) => {
      rSetCount += 1;
      sumDelta += delta;
    });
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
    get dual() {
      return false;
    },
    get rSetCount() {
      return rSetCount;
    },
    get sumDelta() {
      return sumDelta;
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


/**
 * App dual-socket presence for listenTask (#121 / speak #126):
 * - edxJwt native socket stays joined (receives r_set)
 * - SSO jwt socket emits uls_* kick-v2 / refresh / stop
 * Hub kick/stop on edx mirrors App before H5 enter (utingli for listen,
 * ukouyu for speak apptype; best-effort).
 */
export async function startDualStudyDuration(
  input: {
    jwt: string;
    edxJwt: string;
    openId: string;
    target: Extract<StudyDurationTarget, { kind: "listenTask" }>;
    env?: NodeJS.ProcessEnv;
  },
  ports: StudyDurationPorts = {},
): Promise<StudyDurationSession> {
  const ssoJwt = input.jwt.trim();
  const edxJwt = input.edxJwt.trim();
  const openId = input.openId.trim();
  if (!ssoJwt || !edxJwt || !openId) {
    throw new Error("study-duration dual: jwt, edxJwt, openId required");
  }

  const nowMs = ports.nowMs ?? Date.now;
  const setIntervalFn = ports.setIntervalFn ?? setInterval;
  const clearIntervalFn = ports.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = ports.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = ports.clearTimeoutFn ?? clearTimeout;
  const log = ports.log ?? ((msg: string) => console.error(`[study-duration] ${msg}`));
  const readyTimeoutMs = ports.readyTimeoutMs ?? 12_000;
  const createWs =
    ports.createWebSocket ??
    ((u: string) => new WebSocket(u) as unknown as StudyDurationWebSocketLike);

  const edxUrl = buildUnipusioUrl(openId, edxJwt, input.env);
  const ssoUrl = buildUnipusioUrl(openId, ssoJwt, input.env);
  const edxSocket = createWs(edxUrl);
  const ssoSocket = createWs(ssoUrl);

  let disposed = false;
  let edxJoined = false;
  let ssoJoined = false;
  let kicked = false;
  let rSetCount = 0;
  let sumDelta = 0;
  let ackId = 0;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const nextAck = () => {
    const id = ackId;
    ackId = (ackId + 1) % 1_000_000;
    return id;
  };
  const safeSend = (sock: StudyDurationWebSocketLike, data: string) => {
    if (disposed) return;
    try {
      sock.send(data);
    } catch (error) {
      log(`dual send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const emitKick = () => {
    const payload = buildKickPayload(input.target, openId, nowMs());
    safeSend(ssoSocket, encodeNamespaceEvent(nextAck(), "kick-v2", payload));
    kicked = true;
  };
  const emitStop = () => {
    const payload = buildStopPayload(input.target, openId, nowMs());
    safeSend(ssoSocket, encodeNamespaceEvent(nextAck(), "stop", payload));
  };
  const emitHub = (module: StudyDurationHubModule, event: "kick-v2" | "stop") => {
    const hub: StudyDurationTarget = { kind: "hub", module };
    const payload =
      event === "kick-v2"
        ? buildKickPayload(hub, openId, nowMs())
        : buildStopPayload(hub, openId, nowMs());
    safeSend(edxSocket, encodeNamespaceEvent(nextAck(), event, payload));
  };

  let settleReady: () => void = () => {};
  let rejectReady: (err: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });

  const maybeReady = () => {
    if (disposed || !edxJoined || !ssoJoined || kicked) return;
    // App: hub on edx then stop side hub, then H5 uls kick on SSO.
    // Speak dual (#126): ukouyu; listen (#121): utingli.
    const sideHub: StudyDurationHubModule =
      input.target.apptype === "speak" ? "ukouyu" : "utingli";
    emitHub("shouye", "kick-v2");
    emitHub(sideHub, "kick-v2");
    emitHub(sideHub, "stop");
    emitKick();
    if (refreshTimer == null) {
      refreshTimer = setIntervalFn(() => {
        if (!disposed) emitKick();
      }, STUDY_DURATION_REFRESH_MS);
    }
    if (pingTimer == null) {
      pingTimer = setIntervalFn(() => {
        if (disposed) return;
        safeSend(edxSocket, "2");
        safeSend(ssoSocket, "2");
      }, STUDY_DURATION_PING_MS);
    }
    if (readyTimer != null) {
      clearTimeoutFn(readyTimer);
      readyTimer = null;
    }
    settleReady();
  };

  const onSockMessage = (which: "edx" | "sso", raw: unknown) => {
    if (disposed) return;
    const text = messageText(raw);
    if (text == null) return;
    const sock = which === "edx" ? edxSocket : ssoSocket;
    const jwt = which === "edx" ? edxJwt : ssoJwt;
    if (text === "2") {
      safeSend(sock, "3");
      return;
    }
    if (text === "3") return;
    if (text.startsWith("0") || text === "40" || text.startsWith("40,")) {
      safeSend(sock, encodeNamespaceJoin(openId, jwt));
      return;
    }
    if (text.startsWith(`40${STUDY_DURATION_NAMESPACE}`)) {
      if (which === "edx") edxJoined = true;
      else ssoJoined = true;
      maybeReady();
      return;
    }
    // edx receives r_set in App dual; count either socket if server emits there.
    noteRSet(text, (delta) => {
      rSetCount += 1;
      sumDelta += delta;
    });
  };

  for (const [which, sock] of [
    ["edx", edxSocket],
    ["sso", ssoSocket],
  ] as const) {
    sock.on("message", (...args: unknown[]) => {
      try {
        onSockMessage(which, args[0]);
      } catch (error) {
        log(`dual ${which} message: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    sock.on("error", (...args: unknown[]) => {
      const err = args[0];
      const msg = err instanceof Error ? err.message : String(err ?? "ws error");
      log(`dual ${which}: ${msg}`);
      if (!kicked) rejectReady(new Error(msg));
    });
    sock.on("close", () => {
      if (!disposed && !kicked) {
        rejectReady(new Error(`study-duration dual: ${which} closed before kick`));
      }
    });
    sock.on("open", () => {
      setTimeoutFn(() => {
        if (disposed) return;
        if (which === "edx" && !edxJoined) safeSend(edxSocket, encodeNamespaceJoin(openId, edxJwt));
        if (which === "sso" && !ssoJoined) safeSend(ssoSocket, encodeNamespaceJoin(openId, ssoJwt));
      }, 50);
    });
  }

  readyTimer = setTimeoutFn(() => {
    if (!kicked) {
      rejectReady(new Error(`study-duration dual: ready timeout (${readyTimeoutMs}ms)`));
    }
  }, readyTimeoutMs);

  try {
    await ready;
  } catch (error) {
    disposed = true;
    if (readyTimer != null) clearTimeoutFn(readyTimer);
    if (refreshTimer != null) clearIntervalFn(refreshTimer);
    if (pingTimer != null) clearIntervalFn(pingTimer);
    await destroySocket(ssoSocket);
    await destroySocket(edxSocket);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return {
    get kicked() {
      return kicked;
    },
    get inert() {
      return false;
    },
    get dual() {
      return true;
    },
    get rSetCount() {
      return rSetCount;
    },
    get sumDelta() {
      return sumDelta;
    },
    async dispose() {
      if (disposed) return;
      if (readyTimer != null) clearTimeoutFn(readyTimer);
      if (refreshTimer != null) clearIntervalFn(refreshTimer);
      if (pingTimer != null) clearIntervalFn(pingTimer);
      refreshTimer = null;
      pingTimer = null;
      try {
        if (kicked) emitStop();
      } catch (error) {
        log(`dual stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      disposed = true;
      await destroySocket(ssoSocket);
      await destroySocket(edxSocket);
    },
  };
}


/** Parse Socket.IO /userActivities payload for r_set with delta≥1. */
export function parseUnipusioRSet(text: string): { delta: number } | null {
  const idx = text.indexOf('["r_set"');
  if (idx < 0) return null;
  try {
    const arr = JSON.parse(text.slice(idx)) as unknown;
    if (!Array.isArray(arr) || arr[0] !== "r_set") return null;
    const body = arr[1];
    const delta =
      body != null && typeof body === "object" && "delta" in body
        ? Number((body as { delta: unknown }).delta)
        : NaN;
    if (!Number.isFinite(delta) || delta < 1) return null;
    return { delta };
  } catch {
    return null;
  }
}

function noteRSet(text: string, onDelta: (delta: number) => void): void {
  const parsed = parseUnipusioRSet(text);
  if (parsed != null) onDelta(parsed.delta);
}

/** Error detail when edx-jwt is missing — never includes the token (#130). */
export function missingEdxJwtDetail(accountId?: string | null, note?: string | null): string {
  const id = accountId?.trim() || "(unknown)";
  const notePart = note?.trim() ? ` note=${note.trim()}` : "";
  return (
    `study-duration: missing edx-jwt for account ${id}${notePart}; ` +
    "install accounts/<id>/edx-jwt (native App edx.unipus.cn token)"
  );
}

export type StudyDurationWaitPorts = {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until presence kicked and not inert (dual handshake finished). */
export async function waitForStudyDurationReady(
  session: StudyDurationSession,
  ports: StudyDurationWaitPorts = {},
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const timeoutMs = ports.timeoutMs ?? 15_000;
  const pollMs = ports.pollMs ?? 50;
  const sleep = ports.sleep ?? defaultSleep;
  const nowMs = ports.nowMs ?? Date.now;
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    if (session.dual && session.kicked && !session.inert) return { ok: true };
    await sleep(pollMs);
  }
  if (session.dual && session.kicked && !session.inert) return { ok: true };
  if (session.inert) {
    return { ok: false, detail: "study-duration: presence inert (dual failed or never started)" };
  }
  if (!session.dual) {
    return {
      ok: false,
      detail: "study-duration: dual-JWT required (SSO-only / hub-only does not credit durationHours)",
    };
  }
  return { ok: false, detail: "study-duration: presence not ready (no kick-v2)" };
}

/**
 * Hard gate (#130): dual path required and at least one r_set with delta≥1
 * while the paper is open. Short papers may only get delta=1 — that counts.
 */
export async function waitForStudyDurationCredit(
  session: StudyDurationSession,
  ports: StudyDurationWaitPorts = {},
): Promise<
  | { ok: true; rSetCount: number; sumDelta: number }
  | { ok: false; detail: string }
> {
  if (!session.dual) {
    return {
      ok: false,
      detail:
        "study-duration: dual-JWT required (SSO-only / hub-only does not credit durationHours)",
    };
  }
  const timeoutMs = ports.timeoutMs ?? 90_000;
  const pollMs = ports.pollMs ?? 200;
  const sleep = ports.sleep ?? defaultSleep;
  const nowMs = ports.nowMs ?? Date.now;
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    if (studyDurationCreditOk(session)) {
      return { ok: true, rSetCount: session.rSetCount, sumDelta: session.sumDelta };
    }
    await sleep(pollMs);
  }
  if (studyDurationCreditOk(session)) {
    return { ok: true, rSetCount: session.rSetCount, sumDelta: session.sumDelta };
  }
  return {
    ok: false,
    detail:
      `study-duration: no r_set credit (rSetCount=${session.rSetCount} sumDelta=${session.sumDelta}); ` +
      "dual ran but server never credited while paper open",
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
