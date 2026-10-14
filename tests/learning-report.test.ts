import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { currentWeekRange, getLearningReport, parseLearningReport } from "../src/learning-report.js";
import { mockHttp } from "./mock-http.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t";
const creds = { getJwt: async () => JWT };
const VALUE = {
  hasData: true, periodLabel: "9月21日-9月27日", periodStart: "2026-09-21", periodEnd: "2026-09-27",
  kpi: { avgScore: 92, count: 2, durationHours: 2.9 },
  topicScores: [{ name: "家庭与社区", value: 93 }, { name: "自我管理", value: 90 }],
  genreScores: [],
  skillRadar: [{ skillName: "流利度", dimensionCode: 3, value: 88 }],
  reportTime: "2026年10月13日 23:59",
};

describe("learning_report", () => {
  test("currentWeekRange is Mon–Sun in Shanghai", () => {
    // 2026-10-18 Sun 23:30 Shanghai = 15:30Z
    assert.deepEqual(currentWeekRange(new Date("2026-10-18T15:30:00Z")), { start: "2026-10-12", end: "2026-10-18" });
    // 2026-10-19 Mon 00:30 Shanghai = 10-18 16:30Z
    assert.deepEqual(currentWeekRange(new Date("2026-10-18T16:30:00Z")), { start: "2026-10-19", end: "2026-10-25" });
  });

  test("parses captured shape", () => {
    const r = parseLearningReport(VALUE, { start: "x", end: "y" })!;
    assert.equal(r.kpi.avgScore, 92);
    assert.equal(r.topicScores[1]!.name, "自我管理");
    assert.equal(r.skillRadar[0]!.dimensionCode, 3);
    assert.equal(r.reportTime, "2026年10月13日 23:59");
  });

  test("GET with query + headers; periodStart alone → +6", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: JSON.stringify({ code: 1, msg: "SUCCESS", value: VALUE }) }));
    const res: any = await getLearningReport({ credentials: creds, http }, { periodStart: "2026-09-21" });
    assert.equal(res.isError, false);
    assert.equal(res.report.kpi.count, 2);
    const call = http.calls[0]!;
    assert.equal(call.method, "GET");
    const u = new URL(call.url);
    assert.equal(u.pathname, "/api/uls/user/profile/learning-report");
    assert.equal(u.searchParams.get("skillType"), "speak");
    assert.equal(u.searchParams.get("periodType"), "week");
    assert.equal(u.searchParams.get("periodEnd"), "2026-09-27");
    assert.equal(call.headers.authorization, JWT);
    assert.equal(call.headers.sourceid, "116");
  });

  test("hasData false with null kpi", async () => {
    const http = mockHttp(async () => ({ statusCode: 200, body: JSON.stringify({ code: 1, value: { hasData: false, kpi: { avgScore: null, count: 0, durationHours: 0 } } }) }));
    const res: any = await getLearningReport({ credentials: creds, http, now: () => new Date("2026-10-14T04:00:00Z") });
    assert.equal(res.report.hasData, false);
    assert.equal(res.report.kpi.avgScore, null);
    assert.equal(res.report.periodStart, "2026-10-12");
  });

  test("errors: bad date, 401, business code", async () => {
    const ok = mockHttp(async () => ({ statusCode: 200, body: "{}" }));
    assert.equal(((await getLearningReport({ credentials: creds, http: ok }, { periodStart: "10/12" })) as any).code, "INVALID_ARGUMENT");
    const h401 = mockHttp(async () => ({ statusCode: 401, body: "{}" }));
    assert.equal((await getLearningReport({ credentials: creds, http: h401 })).isError, true);
    const biz = mockHttp(async () => ({ statusCode: 200, body: JSON.stringify({ code: 4001, msg: "x" }) }));
    assert.equal(((await getLearningReport({ credentials: creds, http: biz })) as any).code, "BUSINESS_ERROR");
  });
});
