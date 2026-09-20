import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import {
  DEFAULT_CLIO_APPLICATION_ID,
  DEFAULT_CLIO_SECRET,
  DEFAULT_CLIO_WSS_URL,
  resolveClioCredentials,
  resolveClioWssUrl,
} from "../src/config.js";
import {
  clioTimestampFromNowMs,
  clioToEnSentScoreFields,
  createClioSig,
  scoreEnSent,
  scoreSpeechTool,
  type ClioWebSocketLike,
} from "../src/clio-speech.js";

class MockWebSocket extends EventEmitter implements ClioWebSocketLike {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  sent: Array<string | Buffer> = [];
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string | Buffer | Uint8Array): void {
    this.sent.push(Buffer.isBuffer(data) || typeof data === "string" ? data : Buffer.from(data));
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  /** Simulate Clio final response after client frames. */
  respondFinal(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload), "utf8"));
  }
}

describe("createClioSig", () => {
  test("SHA1 hex of applicationId+secret+timestamp", () => {
    const ts = "1710000000";
    const sig = createClioSig("app", "secret", ts);
    assert.equal(sig.length, 40);
    assert.match(sig, /^[0-9a-f]+$/);
    // Stable fixture
    assert.equal(
      createClioSig(
        DEFAULT_CLIO_APPLICATION_ID,
        DEFAULT_CLIO_SECRET,
        "1700000000",
      ),
      createClioSig(
        DEFAULT_CLIO_APPLICATION_ID,
        DEFAULT_CLIO_SECRET,
        "1700000000",
      ),
    );
    assert.equal(
      clioTimestampFromNowMs(1_700_000_123_999),
      "1700000123",
    );
    assert.equal(
      clioTimestampFromNowMs(1_700_000_123_999),
      String(1_700_000_123_999).slice(0, -3),
    );
  });
});

describe("resolveClio*", () => {
  test("defaults and env overrides", () => {
    assert.equal(resolveClioWssUrl({}), DEFAULT_CLIO_WSS_URL);
    assert.equal(
      resolveClioWssUrl({ UNIPUS_CLIO_WSS_URL: " wss://example/wss " }),
      "wss://example/wss",
    );
    assert.equal(resolveClioCredentials({}), null);
    assert.deepEqual(
      resolveClioCredentials({
        UNIPUS_CLIO_APP_ID: "id1",
        UNIPUS_CLIO_APP_SECRET: "sec1",
      }),
      { applicationId: "id1", secret: "sec1" },
    );
  });
});

describe("scoreEnSent (mocked WSS)", () => {
  test("sends sdk → request → binary → stop; parses finalResult", async () => {
    MockWebSocket.instances = [];
    const audio = Buffer.from("RIFF....WAVEfmt "); // tiny fake wav header bytes
    const fixedNow = 1_700_000_000_000;

    const promise = scoreEnSent(
      {
        transcript: "hello world",
        audioBytes: audio,
        userId: "u-test",
        credentials: {
          applicationId: DEFAULT_CLIO_APPLICATION_ID,
          secret: DEFAULT_CLIO_SECRET,
        },
      },
      {
        nowMs: () => fixedNow,
        randomUUID: () => "token-uuid-1",
        createWebSocket: (url) => new MockWebSocket(url),
      },
    );

    // Allow open handler to send frames
    await new Promise((r) => setImmediate(r));
    assert.equal(MockWebSocket.instances.length, 1);
    const sock = MockWebSocket.instances[0]!;
    assert.equal(sock.url, DEFAULT_CLIO_WSS_URL);
    assert.equal(sock.sent.length, 4);

    const sdk = JSON.parse(String(sock.sent[0]));
    assert.equal(sdk.sdk.version, 16777216);
    assert.equal(sdk.sdk.source, 4);
    assert.equal(sdk.sdk.protocol, "websocket");
    assert.equal(sdk.app.applicationId, DEFAULT_CLIO_APPLICATION_ID);
    assert.equal(sdk.app.alg, "sha1");
    assert.equal(sdk.app.userId, "u-test");
    const ts = clioTimestampFromNowMs(fixedNow);
    assert.equal(sdk.app.timestamp, ts);
    assert.equal(
      sdk.app.sig,
      createClioSig(DEFAULT_CLIO_APPLICATION_ID, DEFAULT_CLIO_SECRET, ts),
    );

    const req = JSON.parse(String(sock.sent[1]));
    assert.equal(req.tokenId, "token-uuid-1");
    assert.deepEqual(req.audio, {
      audioType: "wav",
      channel: 1,
      sampleRate: 16000,
      sampleBytes: 2,
    });
    assert.equal(req.request.apiName, "en.sent.score");
    assert.equal(req.request.transcript, "hello world");
    assert.deepEqual(req.request.parameters, { details: { adjust: 0 } });

    assert.ok(Buffer.isBuffer(sock.sent[2]));
    assert.deepEqual(sock.sent[2], audio);
    assert.equal(String(sock.sent[3]), JSON.stringify({ stop: true }));

    sock.respondFinal({
      code: 0,
      finalResult: {
        result: { total: 76, overall: 76, pronunciation: 80 },
        url: "https://clio-audios.unipus.cn/abc/hello.wav",
      },
    });

    const scored = await promise;
    assert.equal(scored.total, 76);
    assert.equal(scored.overall, 76);
    assert.equal(
      scored.audioUrl,
      "https://clio-audios.unipus.cn/abc/hello.wav",
    );
    assert.equal(scored.result.pronunciation, 80);
  });

  test("silence-like total=0 is ok", async () => {
    MockWebSocket.instances = [];
    const promise = scoreEnSent(
      { transcript: "hi", audioBytes: Buffer.from([0, 0, 0, 0]) },
      { createWebSocket: (url) => new MockWebSocket(url) },
    );
    await new Promise((r) => setImmediate(r));
    MockWebSocket.instances[0]!.respondFinal({
      code: 0,
      finalResult: {
        result: { total: 0, overall: 0 },
        url: "https://clio-audios.unipus.cn/silence.wav",
      },
    });
    const scored = await promise;
    assert.equal(scored.total, 0);
    assert.equal(scored.overall, 0);
  });

  test("rejects empty transcript", async () => {
    await assert.rejects(
      () => scoreEnSent({ transcript: "  ", audioBytes: Buffer.from([1]) }),
      /transcript/,
    );
  });

  test("scoreSpeechTool maps EN_SENT_SCORE content", async () => {
    MockWebSocket.instances = [];
    const toolPromise = scoreSpeechTool(
      {
        readFile: async () => Buffer.from("wav-bytes"),
        createWebSocket: (url) => new MockWebSocket(url),
      },
      { transcript: "hello world", wavPath: "/tmp/x.wav" },
    );
    await new Promise((r) => setImmediate(r));
    MockWebSocket.instances[0]!.respondFinal({
      code: 0,
      finalResult: {
        result: { total: 55, overall: 55 },
        url: "https://clio-audios.unipus.cn/x.wav",
      },
    });
    const result = await toolPromise;
    assert.equal(result.isError, false);
    assert.equal(result.status, "ok");
    assert.equal(result.overall, 55);
    assert.equal(result.audio_url, "https://clio-audios.unipus.cn/x.wav");
    assert.ok(result.en_sent_score_content);
    const parsed = JSON.parse(String(result.en_sent_score_content));
    assert.equal(parsed.record, undefined);
    assert.equal(parsed.children.length, 1);
    assert.equal(parsed.children[0].isDone, true);
    assert.equal(parsed.children[0].record.type, "EN_SENT_SCORE");
    assert.equal(parsed.children[0].record.text, "hello world");
    assert.equal(parsed.children[0].record.url, "https://clio-audios.unipus.cn/x.wav");
    assert.equal(parsed.children[0].record.path, "https://clio-audios.unipus.cn/x.wav");
    assert.deepEqual(parsed.children[0].record.list, []);
    assert.equal("recordDetail" in parsed.children[0].record, false);
  });
});

describe("clioToEnSentScoreFields", () => {
  test("defaults url/replayUrl/path to Clio audioUrl", () => {
    const mapped = clioToEnSentScoreFields("hello", {
      audioUrl: "https://clio-audios.unipus.cn/a.wav",
      result: { overall: 76, fluency: 80, integrity: 70, pronunciation: 75, relevance: 90 },
    });
    assert.equal(mapped.record.type, "EN_SENT_SCORE");
    assert.equal(mapped.record.url, "https://clio-audios.unipus.cn/a.wav");
    assert.equal(mapped.record.replayUrl, "https://clio-audios.unipus.cn/a.wav");
    assert.equal(mapped.record.path, "https://clio-audios.unipus.cn/a.wav");
    assert.deepEqual(mapped.record.list, []);
    assert.equal("recordDetail" in mapped.record, false);
    assert.equal("specific_scores" in mapped.record, false);
    assert.equal("isDone" in mapped.record, false);

    const content = JSON.parse(mapped.questionContent);
    assert.equal(content.children[0].isDone, true);
    assert.deepEqual(content.children[0].record, mapped.record);

    // Review-side mapping only — not in answer JSON
    assert.deepEqual(mapped.reviewScores, {
      score: 76,
      smooth: 80,
      completed: 70,
      correctness: 75,
      relevance: 90,
    });
  });

  test("qiniuUrl sets url/replayUrl; path stays Clio", () => {
    const mapped = clioToEnSentScoreFields(
      "Hey, future me!",
      {
        audioUrl: "https://clio-audios.unipus.cn/clio/speech-proxy/uls-x/y.mp3",
        result: { overall: 76 },
      },
      { qiniuUrl: "https://birdflock.unipus.cn/ans-prod/u/a.mp3" },
    );
    assert.deepEqual(mapped.record, {
      type: "EN_SENT_SCORE",
      text: "Hey, future me!",
      url: "https://birdflock.unipus.cn/ans-prod/u/a.mp3",
      replayUrl: "https://birdflock.unipus.cn/ans-prod/u/a.mp3",
      path: "https://clio-audios.unipus.cn/clio/speech-proxy/uls-x/y.mp3",
      list: [],
    });
    assert.equal(mapped.reviewScores?.score, 76);
    assert.equal(mapped.reviewScores?.smooth, undefined);
  });

  test("does not invent missing Clio score fields", () => {
    const mapped = clioToEnSentScoreFields("x", {
      audioUrl: "https://clio-audios.unipus.cn/z.wav",
      result: { total: 10 },
    });
    // overall absent → no invented score; total alone is not mapped as overall
    assert.equal(mapped.reviewScores, undefined);
  });
});
