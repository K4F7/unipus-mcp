import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { probeAuthStatus, type AuthPorts } from "./auth.js";
import { createEnvCredentialStore } from "./credentials.js";
import { createFetchUnipusHttp } from "./http.js";
import { notImplemented, toMcpToolResponse } from "./result.js";

const AUTH_STATUS_DESCRIPTION = [
  "Report whether a usable U听说 / U听力 (cn.unipus.cloud) JWT or SSO session is configured.",
  "Probes https://ucloud.unipus.cn/api/uls/ with Authorization Bearer.",
  "Does not accept username or password; login is env/CLI only (UNIPUS_JWT / UNIPUS_JWT_FILE).",
].join(" ");

const LIST_WEEK_PROGRESS_DESCRIPTION = [
  "List this week's U听力 listening progress (e.g. x/5) and level.",
  "Product: mobile App U听力 / U听说 — not webpage course 261英语视听说.",
  "Does not accept credentials. Stub until uls HTTP is wired.",
].join(" ");

const START_LISTENING_TRAINING_DESCRIPTION = [
  "Start U听力「开始训练」listening session (exact path TBD from capture).",
  "Does not accept credentials. Stub until uls HTTP is wired.",
].join(" ");

export type UnipusServerPorts = Partial<AuthPorts>;

export function createUnipusMcpServer(ports?: UnipusServerPorts): McpServer {
  const server = new McpServer({
    name: "unipus-mcp",
    version: "0.1.0",
  });

  const authPorts: AuthPorts = {
    credentials: ports?.credentials ?? createEnvCredentialStore(),
    http: ports?.http ?? createFetchUnipusHttp(),
    now: ports?.now,
  };

  server.registerTool(
    "auth_status",
    {
      title: "Auth status",
      description: AUTH_STATUS_DESCRIPTION,
    },
    async () => toMcpToolResponse(await probeAuthStatus(authPorts)),
  );

  server.registerTool(
    "list_week_progress",
    {
      title: "List week progress",
      description: LIST_WEEK_PROGRESS_DESCRIPTION,
    },
    async () => toMcpToolResponse(notImplemented("list_week_progress")),
  );

  server.registerTool(
    "start_listening_training",
    {
      title: "Start listening training",
      description: START_LISTENING_TRAINING_DESCRIPTION,
    },
    async () => toMcpToolResponse(notImplemented("start_listening_training")),
  );

  return server;
}
