#!/usr/bin/env node
/**
 * featurebase-mcp — executable entry point.
 *
 * This file should do ONE thing: connect the MCP server transport to
 * stdin/stdout. Building the server (registration of all 7 tools) lives
 * in `src/server.ts`; pure helpers (formatter, aggregation) live in
 * `src/validation.ts` and `src/aggregation.ts`. Importing this file as
 * a module triggers `main()` immediately — don't import it from tests.
 *
 * Process lifecycle handlers (uncaughtException / unhandledRejection)
 * log to stderr so they don't pollute the MCP stdout stream.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./server.js";

process.on("uncaughtException", (err) => {
  process.stderr.write(`[featurebase-mcp] Uncaught exception: ${err}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[featurebase-mcp] Unhandled rejection: ${reason}\n`);
});

async function main(): Promise<void> {
  const server: McpServer = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    "[featurebase-mcp] started — board: " +
      (process.env.FEATUREBASE_BOARD_URL ?? "https://itsremalt.featurebase.app") +
      "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`[featurebase-mcp] failed to start: ${err}\n`);
  process.exit(1);
});
