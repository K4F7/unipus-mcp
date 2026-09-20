#!/usr/bin/env node
/**
 * unipus-mcp — documented bin / package entry (dist/index.js).
 * Starts the stdio MCP server (same as src/stdio.ts).
 */
import { runStdioMain } from "./boot.js";

runStdioMain();
