import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  createAccountJwtStore,
  createEnvCredentialStore,
} from "../src/credentials.js";
import {
  readActiveAccountId,
  saveAccountTokens,
} from "../src/accounts.js";
import { listWeekProgress } from "../src/week-progress.js";
import { mockHttp } from "./mock-http.js";

const JWT_A = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYSJ9.sigA";
const JWT_B = "eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.sigB";

describe("optional MCP account_id", () => {
  test("createAccountJwtStore reads archive jwt without touching active", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-aid-"));
    const env = {};
    await saveAccountTokens(
      { accountId: "111", jwt: JWT_A, makeActive: true, syncLegacy: true },
      { home, env },
    );
    await saveAccountTokens(
      { accountId: "222", jwt: JWT_B, makeActive: false, syncLegacy: false },
      { home, env },
    );
    assert.equal(await readActiveAccountId({ home, env }), "111");

    const storeB = createAccountJwtStore("222", { env, homedir: home });
    assert.equal(await storeB.getJwt(), JWT_B);
    assert.equal(await readActiveAccountId({ home, env }), "111");

    const defaultStore = createEnvCredentialStore({ env, homedir: home });
    assert.equal(await defaultStore.getJwt(), JWT_A);
  });

  test("list_week_progress default vs explicit account_id uses matching jwt", async () => {
    const home = await mkdtemp(join(tmpdir(), "unipus-aid-mcp-"));
    const env: NodeJS.ProcessEnv = {};
    await saveAccountTokens(
      { accountId: "aaa", jwt: JWT_A, makeActive: true, syncLegacy: true },
      { home, env },
    );
    await saveAccountTokens(
      { accountId: "bbb", jwt: JWT_B, makeActive: false, syncLegacy: false },
      { home, env },
    );

    const auths: string[] = [];
    const http = mockHttp(async (call) => {
      auths.push(call.headers.authorization ?? "");
      if (call.url.includes("getUserStatusForApp")) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            code: 1,
            value: { weekDoneTaskCount: 1, weekFrequency: 5, currentLevel: "S1" },
          }),
        };
      }
      return { statusCode: 200, body: "{}" };
    });

    await listWeekProgress({
      credentials: createAccountJwtStore("bbb", { env, homedir: home }),
      http,
      env,
    });
    assert.ok(auths.includes(JWT_B));

    await listWeekProgress({
      credentials: createEnvCredentialStore({ env, homedir: home }),
      http,
      env,
    });
    assert.ok(auths.includes(JWT_A));
    assert.equal(await readActiveAccountId({ home, env }), "aaa");
  });
});
