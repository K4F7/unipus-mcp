import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addCalendarMonths,
  assistMonths,
  assistSemester,
  assistUntil,
  effectiveWeekTotal,
  formatUsage,
  isUsageExpired,
  isUsageNotStarted,
  normalizeUsage,
  parseUsageArgs,
  selfUsage,
  semesterEnd,
  shanghaiDate,
  usageFromCommand,
} from "../src/account-usage.js";

describe("account usage window", () => {
  test("months started in a vacation cap at the next semester end", () => {
    assert.equal(assistMonths(12, "2026-08-01").expires_at, "2027-01-15");
    assert.equal(assistMonths(1, "2026-08-01").expires_at, "2026-09-01");
    assert.equal(assistMonths(12, "2026-02-01").expires_at, "2026-07-10");
  });

  test("a future started_at is not started yet, then active", () => {
    const usage = assistUntil("2027-06-30", "2027-01-01");
    assert.equal(isUsageNotStarted(usage, "2026-12-31"), true);
    assert.equal(isUsageExpired(usage, "2026-12-31"), false);
    assert.match(formatUsage(usage, "2026-12-31"), /not_started/);
    assert.equal(isUsageNotStarted(usage, "2027-01-01"), false);
    assert.equal(isUsageNotStarted(selfUsage(), "2000-01-01"), false);
  });

  test("calendar months clamp the day", () => {
    assert.equal(addCalendarMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addCalendarMonths("2024-01-31", 1), "2024-02-29");
    assert.equal(addCalendarMonths("2026-10-19", 4), "2027-02-19");
  });

  test("semester end follows the fixed school calendar", () => {
    assert.equal(semesterEnd("2026-10-19"), "2027-01-15");
    assert.equal(semesterEnd("2026-01-15"), "2026-01-15");
    assert.equal(semesterEnd("2026-01-20"), "2026-07-10");
    assert.equal(semesterEnd("2026-03-01"), "2026-07-10");
    assert.equal(semesterEnd("2026-07-10"), "2026-07-10");
    assert.equal(semesterEnd("2026-08-01"), "2027-01-15");
  });

  test("expires_at is inclusive; the next Shanghai day is expired", () => {
    const usage = assistMonths(1, "2026-10-19");
    assert.equal(usage.expires_at, "2026-11-19");
    assert.equal(isUsageExpired(usage, "2026-11-19"), false);
    assert.equal(isUsageExpired(usage, "2026-11-20"), true);
    assert.equal(isUsageExpired(normalizeUsage(undefined), "2099-01-01"), false);
  });

  test("assist without a date stays expired instead of becoming self", () => {
    const broken = normalizeUsage({ mode: "assist", term: "until" });
    assert.equal(broken.mode, "assist");
    assert.equal(broken.expires_at, null);
    assert.equal(isUsageExpired(broken, "2026-10-19"), true);
  });

  test("parse and build self, months, semester, and until", () => {
    const now = new Date("2026-10-19T02:00:00Z");
    assert.equal(shanghaiDate(now), "2026-10-19");
    const self = parseUsageArgs(["self"]);
    assert.equal(self.ok, true);
    if (!self.ok) return;
    assert.equal(usageFromCommand(self.command, now).mode, "self");

    const monthsParsed = parseUsageArgs(["assist", "--months", "4", "--from", "2026-10-19"]);
    assert.equal(monthsParsed.ok, true);
    if (!monthsParsed.ok) return;
    const months = usageFromCommand(monthsParsed.command, now);
    assert.equal(months.term, "months");
    assert.equal(months.months, 4);
    assert.equal(months.expires_at, "2027-01-15");
    assert.equal(assistMonths(2, "2026-10-19").expires_at, "2026-12-19");
    assert.equal(assistMonths(3, "2026-06-01").expires_at, "2026-07-10");

    const semesterParsed = parseUsageArgs(["assist", "--semester"]);
    assert.equal(semesterParsed.ok, true);
    if (!semesterParsed.ok) return;
    const semester = usageFromCommand(semesterParsed.command, now);
    assert.equal(semester.expires_at, "2027-01-15");
    assert.equal(semester.started_at, "2026-10-19");

    const untilParsed = parseUsageArgs(["assist", "--until", "2027-06-30"]);
    assert.equal(untilParsed.ok, true);
    if (!untilParsed.ok) return;
    const until = usageFromCommand(untilParsed.command, now);
    assert.deepEqual(until, assistUntil("2027-06-30", "2026-10-19"));
    assert.match(formatUsage(semester, "2026-10-19"), /usage=assist term=semester/);
    assert.match(formatUsage(semester, "2027-01-16"), /expired/);
  });

  test("rejects mixed assist selectors and a until before from", () => {
    assert.equal(parseUsageArgs(["assist", "--months", "2", "--semester"]).ok, false);
    assert.equal(parseUsageArgs(["assist"]).ok, false);
    assert.throws(() => assistUntil("2026-01-01", "2026-02-01"), /不能早于/);
    assert.throws(() => assistSemester("nope"), /非法/);
  });

  test("self and assist both store weekly listen and speak counts", () => {
    const now = new Date("2026-10-19T02:00:00Z");
    const selfParsed = parseUsageArgs(["self", "--listen", "2", "--speak", "1"]);
    assert.equal(selfParsed.ok, true);
    if (!selfParsed.ok) return;
    const self = usageFromCommand(selfParsed.command, now);
    assert.equal(self.mode, "self");
    assert.equal(self.listen_per_week, 2);
    assert.equal(self.speak_per_week, 1);
    assert.match(formatUsage(self), /usage=self listen=2\/wk speak=1\/wk/);

    const assistParsed = parseUsageArgs([
      "assist",
      "--semester",
      "--speak", "3",
      "--listen", "4",
    ]);
    assert.equal(assistParsed.ok, true);
    if (!assistParsed.ok) return;
    const assist = usageFromCommand(assistParsed.command, now);
    assert.equal(assist.mode, "assist");
    assert.equal(assist.listen_per_week, 4);
    assert.equal(assist.speak_per_week, 3);
    assert.equal(assist.expires_at, "2027-01-15");
    assert.match(formatUsage(assist, "2026-10-19"), /listen=4\/wk speak=3\/wk/);
  });

  test("omitted weekly flags keep the saved counts; platform clears one side", () => {
    const now = new Date("2026-10-19T02:00:00Z");
    const previous = {
      ...assistMonths(1, "2026-10-19"),
      listen_per_week: 2,
      speak_per_week: 1,
    };
    const extend = parseUsageArgs(["assist", "--months", "2", "--from", "2026-10-19"]);
    assert.equal(extend.ok, true);
    if (!extend.ok) return;
    const kept = usageFromCommand(extend.command, now, previous);
    assert.equal(kept.months, 2);
    assert.equal(kept.listen_per_week, 2);
    assert.equal(kept.speak_per_week, 1);

    const cleared = parseUsageArgs(["self", "--listen", "platform"]);
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    const self = usageFromCommand(cleared.command, now, previous);
    assert.equal(self.mode, "self");
    assert.equal(self.listen_per_week, null);
    assert.equal(self.speak_per_week, 1);
    assert.match(formatUsage(self), /listen=platform\/wk speak=1\/wk/);
  });

  test("weekly counts accept 0, reject out of range, and survive normalize on both modes", () => {
    const zero = parseUsageArgs(["self", "--listen", "0", "--speak", "30"]);
    assert.equal(zero.ok, true);
    if (!zero.ok) return;
    assert.deepEqual(usageFromCommand(zero.command).listen_per_week, 0);
    assert.equal(parseUsageArgs(["self", "--listen", "31"]).ok, false);
    assert.equal(parseUsageArgs(["assist", "--semester", "--speak", "-1"]).ok, false);
    assert.equal(parseUsageArgs(["self", "--listen"]).ok, false);
    assert.equal(parseUsageArgs(["self", "--note", "x"]).ok, false);

    const self = normalizeUsage({ mode: "self", listen_per_week: 2, speak_per_week: 1 });
    assert.equal(self.mode, "self");
    assert.equal(self.listen_per_week, 2);
    assert.equal(self.speak_per_week, 1);
    const assist = normalizeUsage({
      mode: "assist",
      term: "until",
      expires_at: "2027-01-15",
      listen_per_week: 5,
      speak_per_week: 1.5,
    });
    assert.equal(assist.mode, "assist");
    assert.equal(assist.listen_per_week, 5);
    assert.equal(assist.speak_per_week, null);
    assert.equal(normalizeUsage({ mode: "self", listen_per_week: 31 }).listen_per_week, null);
  });

  test("effective week total caps a configured count at the platform total", () => {
    assert.equal(effectiveWeekTotal(5, null), 5);
    assert.equal(effectiveWeekTotal(5, 2), 2);
    assert.equal(effectiveWeekTotal(3, 9), 3);
    assert.equal(effectiveWeekTotal(5, 0), 0);
    assert.equal(effectiveWeekTotal(null, 2), null);
  });
});
