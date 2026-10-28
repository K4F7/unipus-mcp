import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  STUDY_DURATION_NAMESPACE,
  STUDY_DURATION_PING_MS,
  STUDY_DURATION_REFRESH_MS,
  STUDY_DURATION_TTL_SEC,
  buildKickPayload,
  buildStopPayload,
  buildUnipusioUrl,
  encodeNamespaceEvent,
  encodeNamespaceJoin,
  listenStudyTarget,
  resolveEdxJwt,
  softStartStudyDuration,
  speakStudyTarget,
  startStudyDuration,
  type StudyDurationWebSocketLike,
} from "../src/study-duration.js";

/** Minimal JWT with openId claim (unsigned). */
function jwtWithOpenId(openId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ openId })).toString("base64url");
  return `${header}.${payload}.x`;
}

class MockWebSocket extends EventEmitter implements StudyDurationWebSocketLike {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  sent: string[] = [];
  closed = false;
  /** Auto-drive Engine.IO open → namespace ack after client join. */
  autoHandshake: boolean;

  constructor(url: string, opts?: { autoHandshake?: boolean }) {
    super();
    this.url = url;
    this.autoHandshake = opts?.autoHandshake !== false;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.emit("open");
      if (this.autoHandshake) {
        // Engine.IO OPEN then default CONNECT (as seen / inferred from App).
        this.emit("message", Buffer.from('0{"sid":"test","pingInterval":25000}', "utf8"));
      }
    });
  }

  send(data: string | Buffer | Uint8Array): void {
    const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
    this.sent.push(text);
    if (
      this.autoHandshake &&
      text.startsWith(`40${STUDY_DURATION_NAMESPACE}?`)
    ) {
      queueMicrotask(() => {
        this.emit("message", Buffer.from(`40${STUDY_DURATION_NAMESPACE},`, "utf8"));
      });
    }
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  respond(text: string): void {
    this.emit("message", Buffer.from(text, "utf8"));
  }
}

describe("listenStudyTarget / speakStudyTarget", () => {
  test("prefer uls_* when qiId present, else utingli hub", () => {
    assert.deepEqual(listenStudyTarget({ taskId: "t1" }), { kind: "hub", module: "utingli" });
    const task = listenStudyTarget({
      taskId: "102935496962712245",
      questionInstanceId: "1986612581352873984",
      ansVersion: 1,
    });
    assert.equal(task.kind, "listenTask");
    if (task.kind === "listenTask") {
      assert.equal(task.taskId, "102935496962712245");
      assert.equal(task.questionInstanceId, "1986612581352873984");
    }
    assert.deepEqual(speakStudyTarget(), { kind: "hub", module: "ukouyu" });
  });
});

describe("payload builders", () => {
  test("hub kick-v2 / stop fields match capture", () => {
    const kick = buildKickPayload({ kind: "hub", module: "utingli" }, "oid", 1_793_192_719_893);
    assert.equal(kick.client, "ucloud");
    assert.equal(kick.module, "utingli");
    assert.equal(kick.moduleGroup, "app");
    assert.equal(kick.openId, "oid");
    assert.equal(kick.TTL, STUDY_DURATION_TTL_SEC);
    assert.equal(kick.sendTimestamp, 1_793_192_719_893);
    assert.deepEqual(JSON.parse(kick.tag3), {
      role: "student",
      status: "train",
      OS: "Android",
    });

    const stop = buildStopPayload({ kind: "hub", module: "ukouyu" }, "oid", 99);
    assert.equal(stop.module, "ukouyu");
    assert.deepEqual(JSON.parse(stop.tag3), { role: "student", OS: "Android" });
    assert.equal(stop.TTL, STUDY_DURATION_TTL_SEC);
  });

  test("listenTask kick includes uls moduleGroup, url, appId, serviceId", () => {
    const kick = buildKickPayload(
      {
        kind: "listenTask",
        taskId: "102935496962712245",
        questionInstanceId: "1986612581352873984",
        ansVersion: 1,
      },
      "oid",
      100,
    );
    assert.equal(kick.module, "uls_1986612581352873984");
    assert.equal(kick.moduleGroup, "uls:102935496962712245_1");
    assert.equal(kick.appId, 116);
    assert.equal(kick.serviceId, "uls");
    assert.match(kick.url!, /questionInstanceId=1986612581352873984/);
    assert.equal(kick.TTL, undefined);
    const tag = JSON.parse(kick.tag3);
    assert.equal(tag.apptype, "listen");
    assert.equal(tag.questionInstanceId, "1986612581352873984");
  });

  test("encode frames", () => {
    const join = encodeNamespaceJoin("oid", "tok");
    assert.equal(join, "40/userActivities?uuid=oid&token=tok");
    const payload = buildKickPayload({ kind: "hub", module: "ukouyu" }, "oid", 1);
    const frame = encodeNamespaceEvent(2, "kick-v2", payload);
    assert.ok(frame.startsWith("42/userActivities,2[\"kick-v2\","));
    assert.ok(frame.includes("\"module\":\"ukouyu\""));
  });

  test("buildUnipusioUrl", () => {
    const url = buildUnipusioUrl("oid", "Bearer abc.def.ghi");
    assert.match(url, /^wss:\/\/ucontent\.unipus\.cn\/unipusio\/\?/);
    assert.match(url, /EIO=3/);
    assert.match(url, /uuid=oid/);
    assert.match(url, /token=abc\.def\.ghi/);
    assert.doesNotMatch(url, /Bearer/);
  });
});

describe("startStudyDuration (mocked WSS)", () => {
  test("join → kick-v2 → refresh → stop on dispose", async () => {
    MockWebSocket.instances = [];
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const intervals: Array<{ ms: number; fn: () => void; cleared?: boolean }> = [];
    let now = 1_000_000;

    const session = await startStudyDuration(
      {
        jwt: jwtWithOpenId("oid-1"),
        target: { kind: "hub", module: "utingli" },
      },
      {
        nowMs: () => now,
        createWebSocket: (url) => new MockWebSocket(url),
        setTimeoutFn: ((fn: () => void, ms: number) => {
          timers.push({ ms, fn });
          return timers.length as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimeoutFn: () => {},
        setIntervalFn: ((fn: () => void, ms: number) => {
          intervals.push({ ms, fn });
          return intervals.length as unknown as NodeJS.Timeout;
        }) as typeof setInterval,
        clearIntervalFn: ((id: NodeJS.Timeout) => {
          const i = intervals[(id as unknown as number) - 1];
          if (i) i.cleared = true;
        }) as typeof clearInterval,
        readyTimeoutMs: 5_000,
      },
    );

    assert.equal(session.inert, false);
    assert.equal(session.kicked, true);
    const ws = MockWebSocket.instances[0]!;
    assert.match(ws.url, /uuid=oid-1/);
    assert.ok(ws.sent.some((s) => s.startsWith("40/userActivities?")));
    const kicks = ws.sent.filter((s) => s.includes('["kick-v2",'));
    assert.equal(kicks.length, 1);
    assert.match(kicks[0]!, /"module":"utingli"/);
    assert.match(kicks[0]!, /"TTL":60/);
    const kickPayload = JSON.parse(kicks[0]!.replace(/^42\/userActivities,\d+/, "")) as [string, { tag3: string }];
    assert.equal(kickPayload[0], "kick-v2");
    assert.deepEqual(JSON.parse(kickPayload[1].tag3), {
      role: "student",
      status: "train",
      OS: "Android",
    });

    const refresh = intervals.find((i) => i.ms === STUDY_DURATION_REFRESH_MS);
    const ping = intervals.find((i) => i.ms === STUDY_DURATION_PING_MS);
    assert.ok(refresh);
    assert.ok(ping);

    now = 1_045_000;
    refresh!.fn();
    assert.equal(ws.sent.filter((s) => s.includes('["kick-v2",')).length, 2);

    ping!.fn();
    assert.ok(ws.sent.includes("2"));

    // Server ping → client pong
    ws.respond("2");
    assert.ok(ws.sent.includes("3"));

    await session.dispose();
    const stops = ws.sent.filter((s) => s.includes('["stop",'));
    assert.equal(stops.length, 1);
    assert.match(stops[0]!, /"module":"utingli"/);
    assert.doesNotMatch(stops[0]!, /"status":"train"/);
    assert.equal(ws.closed, true);
    assert.equal(refresh!.cleared, true);
    assert.equal(ping!.cleared, true);

    // Second dispose is no-op
    await session.dispose();
    assert.equal(ws.sent.filter((s) => s.includes('["stop",')).length, 1);
  });

  test("listenTask kick uses uls_* module", async () => {
    MockWebSocket.instances = [];
    const session = await startStudyDuration(
      {
        jwt: jwtWithOpenId("oid-2"),
        target: listenStudyTarget({
          taskId: "102935496962712245",
          questionInstanceId: "1986612581352873984",
        }),
      },
      {
        createWebSocket: (url) => new MockWebSocket(url),
        readyTimeoutMs: 5_000,
      },
    );
    const ws = MockWebSocket.instances[0]!;
    const kick = ws.sent.find((s) => s.includes('["kick-v2",'))!;
    assert.match(kick, /"module":"uls_1986612581352873984"/);
    assert.match(kick, /"moduleGroup":"uls:102935496962712245_1"/);
    assert.match(kick, /"serviceId":"uls"/);
    await session.dispose();
  });

  test("softStart returns inert when openId missing (does not throw)", async () => {
    const logs: string[] = [];
    const session = await softStartStudyDuration(
      { jwt: "not-a-jwt", target: speakStudyTarget() },
      { log: (m) => logs.push(m), createWebSocket: () => { throw new Error("should not connect"); } },
    );
    assert.equal(session.inert, true);
    assert.equal(session.kicked, false);
    assert.equal(logs.length, 0);
    await session.dispose();
  });

  test("softStart enabled:false is inert without socket", async () => {
    MockWebSocket.instances = [];
    const session = await softStartStudyDuration(
      { jwt: jwtWithOpenId("oid"), target: speakStudyTarget(), enabled: false },
      { createWebSocket: (url) => new MockWebSocket(url) },
    );
    assert.equal(session.inert, true);
    assert.equal(MockWebSocket.instances.length, 0);
  });

  test("ready timeout: disposed so late namespace join does not start timers", async () => {
    MockWebSocket.instances = [];
    const intervals: Array<{ ms: number; fn: () => void }> = [];
    const timers: Array<{ ms: number; fn: () => void }> = [];

    const promise = startStudyDuration(
      { jwt: jwtWithOpenId("oid-fail"), target: speakStudyTarget() },
      {
        createWebSocket: (url) => new MockWebSocket(url, { autoHandshake: false }),
        setTimeoutFn: ((fn: () => void, ms: number) => {
          timers.push({ ms, fn });
          return timers.length as unknown as NodeJS.Timeout;
        }) as typeof setTimeout,
        clearTimeoutFn: () => {},
        setIntervalFn: ((fn: () => void, ms: number) => {
          intervals.push({ ms, fn });
          return intervals.length as unknown as NodeJS.Timeout;
        }) as typeof setInterval,
        clearIntervalFn: () => {},
        readyTimeoutMs: 100,
      },
    );

    // Allow open microtask; do not complete handshake.
    await new Promise<void>((r) => queueMicrotask(r));
    const ws = MockWebSocket.instances[0]!;
    // Fire the ready-timeout timer (last registered with readyTimeoutMs).
    const readyT = timers.find((t) => t.ms === 100);
    assert.ok(readyT);
    readyT!.fn();
    await assert.rejects(promise, /ready timeout/);

    // Late namespace ack must not start refresh/ping timers.
    ws.respond(`40${STUDY_DURATION_NAMESPACE},`);
    assert.equal(intervals.length, 0);
    assert.equal(ws.sent.filter((s) => s.includes('["kick-v2",')).length, 0);
  });

  test("softStart does not await handshake before returning", async () => {
    MockWebSocket.instances = [];
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((r) => {
      resolveOpen = r;
    });

    // Manual socket: no auto open until we say so.
    class GateWs extends EventEmitter implements StudyDurationWebSocketLike {
      url: string;
      sent: string[] = [];
      closed = false;
      constructor(url: string) {
        super();
        this.url = url;
        MockWebSocket.instances.push(this as unknown as MockWebSocket);
        void openGate.then(() => {
          this.emit("open");
          this.emit("message", Buffer.from('0{"sid":"x"}', "utf8"));
        });
      }
      send(data: string | Buffer | Uint8Array): void {
        const text = typeof data === "string" ? data : Buffer.from(data as Buffer).toString("utf8");
        this.sent.push(text);
        if (text.startsWith(`40${STUDY_DURATION_NAMESPACE}?`)) {
          queueMicrotask(() => this.emit("message", Buffer.from(`40${STUDY_DURATION_NAMESPACE},`, "utf8")));
        }
      }
      close(): void {
        this.closed = true;
        this.emit("close");
      }
    }

    const t0 = Date.now();
    const session = await softStartStudyDuration(
      { jwt: jwtWithOpenId("oid-bg"), target: speakStudyTarget() },
      { createWebSocket: (url) => new GateWs(url), readyTimeoutMs: 5_000 },
    );
    assert.ok(Date.now() - t0 < 200, "softStart must return without waiting for handshake");
    assert.equal(session.kicked, false);
    resolveOpen();
    // Let handshake complete
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(session.kicked, true);
    await session.dispose();
  });

});

describe("resolveEdxJwt", () => {
  const inlineJwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuX2lkIjoiaW5saW5lIn0.sig";
  const fileJwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuX2lkIjoiZmlsZSJ9.sig";
  const accountJwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuX2lkIjoiYWNjdCJ9.sig";
  const activeJwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJvcGVuX2lkIjoiYWN0aXZlIn0.sig";

  test("prefers UNIPUS_EDX_JWT over file and account", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-edx-"));
    const config = join(home, ".config", "unipus-mcp");
    const acct = join(config, "accounts", "acct1");
    await mkdir(acct, { recursive: true, mode: 0o700 });
    const filePath = join(home, "edx.env");
    await writeFile(filePath, `${fileJwt}\n`, { mode: 0o600 });
    await writeFile(join(acct, "edx-jwt"), `${accountJwt}\n`, { mode: 0o600 });
    await writeFile(join(config, "active-account.txt"), "acct1\n", { mode: 0o600 });

    const got = await resolveEdxJwt(
      {
        UNIPUS_EDX_JWT: `Bearer ${inlineJwt}`,
        UNIPUS_EDX_JWT_FILE: filePath,
      },
      { accountId: "acct1", homedir: home },
    );
    assert.equal(got, inlineJwt);
  });

  test("uses UNIPUS_EDX_JWT_FILE when inline missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-edx-file-"));
    const filePath = join(home, "edx.jwt");
    await writeFile(filePath, `${fileJwt}\n`, { mode: 0o600 });
    const got = await resolveEdxJwt(
      { UNIPUS_EDX_JWT_FILE: filePath },
      { homedir: home },
    );
    assert.equal(got, fileJwt);
  });

  test("uses accounts/<id>/edx-jwt when env unset", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-edx-acct-"));
    const config = join(home, ".config", "unipus-mcp");
    const acct = join(config, "accounts", "acct1");
    await mkdir(acct, { recursive: true, mode: 0o700 });
    await writeFile(join(acct, "edx-jwt"), `${accountJwt}\n`, { mode: 0o600 });

    const got = await resolveEdxJwt({}, { accountId: "acct1", homedir: home });
    assert.equal(got, accountJwt);
  });

  test("falls back to active-account edx-jwt", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-edx-active-"));
    const config = join(home, ".config", "unipus-mcp");
    const acct = join(config, "accounts", "acct-active");
    await mkdir(acct, { recursive: true, mode: 0o700 });
    await writeFile(join(acct, "edx-jwt"), `${activeJwt}\n`, { mode: 0o600 });
    await writeFile(join(config, "active-account.txt"), "acct-active\n", { mode: 0o600 });

    const got = await resolveEdxJwt({}, { homedir: home });
    assert.equal(got, activeJwt);
  });

  test("missing sources yield undefined (soft)", async () => {
    const got = await resolveEdxJwt(
      {},
      { accountId: "nope", homedir: "/tmp/no-such-unipus-edx-home" },
    );
    assert.equal(got, undefined);
  });
});
