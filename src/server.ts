import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { authRequired, notImplemented, toMcpToolResponse } from "./result.js";

const AUTH_STATUS_DESCRIPTION = [
  "Report whether a usable U听说 / U听力 (cn.unipus.cloud) JWT or SSO session is configured.",
  "Does not accept username or password; login is env/CLI only.",
  "Stub until SSO / uls auth lands — currently returns auth_required.",
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

export function createUnipusMcpServer(): McpServer {
  const server = new McpServer({
    name: "unipus-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "auth_status",
    {
      title: "Auth status",
      description: AUTH_STATUS_DESCRIPTION,
    },
    async () => toMcpToolResponse(authRequired("SSO / JWT 尚未接入（issue #2）。")),
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
