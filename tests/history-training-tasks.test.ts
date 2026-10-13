import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_ULS_HISTORY_TRAINING_TASKS_PATH,
  resolveHistoryTrainingTasksUrl,
  resolveReportCheckStatusUrl,
} from "../src/config.js";
import {
  checkReportStatus,
  findHistoryTrainingTask,
  getHistoryTrainingTasks,
  parseHistoryTrainingPage,
} from "../src/history-training-tasks.js";
import { mockHttp } from "./mock-http.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.t";
const creds = { getJwt: async () => JWT };

describe("parseHistoryTrainingPage", () => {
  test("reads scoreIsOut and large taskId strings", () => {
    const page = parseHistoryTrainingPage({
      page: 1,
      pageSize: 20,
      total: 2,
      totalPages: 1,
      list: [
        {
          taskId: "108840003253300142",
          score: 0,
          scoreIsOut: false,
          answerStatus: 2,
        },
        {
          taskId: "101513020974076720",
          score: 93,
          scoreIsOut: true,
          answerStatus: 2,
        },
      ],
    });
    assert.ok(page);
    assert.equal(page!.list.length, 2);
    assert.equal(page!.list[0]!.scoreIsOut, false);
    assert.equal(page!.list[1]!.scoreIsOut, true);
    assert.equal(page!.list[1]!.score, 93);
    assert.equal(page!.list[0]!.taskId, "108840003253300142");
  });
});

describe("getHistoryTrainingTasks", () => {
  test("posts speak body to ucloud path with u-app-id", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        msg: "SUCCESS",
        value: {
          page: 1,
          pageSize: 20,
          total: 1,
          totalPages: 1,
          list: [
            {
              taskId: "555",
              score: 90,
              scoreIsOut: true,
              answerStatus: 2,
              countScore: true,
            },
          ],
        },
      }),
    }));
    const res = await getHistoryTrainingTasks(
      { credentials: creds, http, env: {} },
      { flowType: "speak", page: 1, pageSize: 20 },
    );
    assert.equal(res.isError, false);
    assert.equal(res.page?.list[0]?.scoreIsOut, true);
    assert.equal(http.calls.length, 1);
    assert.match(http.calls[0]!.url, /getHistoryTrainingTasks/);
    assert.equal(http.calls[0]!.method, "POST");
    assert.equal(http.calls[0]!.headers["u-app-id"], "116");
    assert.deepEqual(JSON.parse(http.calls[0]!.body ?? "{}"), {
      pageSize: 20,
      page: 1,
      flowType: "speak",
    });
    assert.match(resolveHistoryTrainingTasksUrl({}), new RegExp(DEFAULT_ULS_HISTORY_TRAINING_TASKS_PATH));
  });

  test("business error when code≠1", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 500, msg: "fail" }),
    }));
    const res = await getHistoryTrainingTasks({ credentials: creds, http });
    assert.equal(res.isError, true);
    assert.equal(res.code, "BUSINESS_ERROR");
  });
});

describe("findHistoryTrainingTask", () => {
  test("paginates until taskId matches", async () => {
    const http = mockHttp(async (call) => {
      const body = JSON.parse(String(call.body));
      if (body.page === 1) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: {
              page: 1,
              pageSize: 20,
              total: 21,
              totalPages: 2,
              list: [{ taskId: "1", scoreIsOut: false, score: 0 }],
            },
          }),
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          code: 1,
          value: {
            page: 2,
            pageSize: 20,
            total: 21,
            totalPages: 2,
            list: [
              {
                taskId: "108840003253300142",
                scoreIsOut: false,
                score: 0,
                answerStatus: 2,
              },
            ],
          },
        }),
      };
    });
    const res = await findHistoryTrainingTask(
      { credentials: creds, http },
      { taskId: "108840003253300142", flowType: "speak" },
    );
    assert.equal(res.isError, false);
    assert.equal(res.task?.taskId, "108840003253300142");
    assert.equal(res.task?.scoreIsOut, false);
    assert.equal(res.pages_scanned, 2);
  });

  test("returns task null when missing", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        code: 1,
        value: {
          page: 1,
          pageSize: 20,
          total: 0,
          totalPages: 1,
          list: [],
        },
      }),
    }));
    const res = await findHistoryTrainingTask(
      { credentials: creds, http },
      { taskId: "missing" },
    );
    assert.equal(res.isError, false);
    assert.equal(res.task, null);
  });
});

describe("checkReportStatus", () => {
  test("value 3 means 已出分", async () => {
    const http = mockHttp(async (call) => {
      assert.match(call.url, /checkStatus/);
      assert.deepEqual(JSON.parse(String(call.body)), {
        taskId: "555",
        ansVersion: 1,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ code: 1, msg: "SUCCESS", value: 3, success: true }),
      };
    });
    const res = await checkReportStatus(
      { credentials: creds, http, env: {} },
      { taskId: "555", ansVersion: 1 },
    );
    assert.equal(res.isError, false);
    assert.equal(res.check_status, 3);
    assert.match(resolveReportCheckStatusUrl({}), /checkStatus/);
  });

  test("value 2 means 评分中", async () => {
    const http = mockHttp(async () => ({
      statusCode: 200,
      body: JSON.stringify({ code: 1, value: 2 }),
    }));
    const res = await checkReportStatus(
      { credentials: creds, http },
      { taskId: "555" },
    );
    assert.equal(res.check_status, 2);
  });
});
