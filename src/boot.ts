import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createUnipusMcpServer } from "./server.js";

/** Connect the MCP server to stdio and keep the process alive. */
export async function startStdioServer(): Promise<void> {
  const server = createUnipusMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function runStdioMain(): void {
  startStdioServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
