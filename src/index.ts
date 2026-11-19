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
 * Process and stdio lifecycle:
 *   - Log diagnostics only to stderr (never stdout, which carries MCP
 *     JSON-RPC frames), and attach an error listener to stderr so a
 *     broken pipe never turns into an uncaughtException feedback loop.
 *   - Exit cleanly (code 0) when stdin ends/closes, stdout breaks, or a
 *     termination signal arrives so the server never outlives its client.
 *   - Always exit on uncaughtException / unhandledRejection instead of
 *     leaving a damaged process alive in the background.
 */
import { writeSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildServer } from "./server.js";

const DISCONNECT_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "EOF",
]);

function isDisconnectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && DISCONNECT_ERROR_CODES.has(code);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  try {
    return String(err);
  } catch {
    return "[unprintable error]";
  }
}

/**
 * Best-effort stderr logging during normal execution. Broken-pipe errors
 * are ignored so logging never crashes or triggers uncaughtException.
 */
function safeLog(message: string): void {
  if (!process.stderr.writable || process.stderr.destroyed) return;
  try {
    process.stderr.write(message);
  } catch {
    // Broken stderr must never recurse into uncaughtException.
  }
}

/**
 * Synchronous stderr write for fatal exit paths: flushes immediately before
 * `process.exit()` when stderr is open, and catches EPIPE/EBADF synchronously
 * when the pipe is already gone.
 */
function safeFatalLog(message: string): void {
  try {
    writeSync(2, message);
  } catch {
    // Ignore closed/broken stderr fd during shutdown.
  }
}

let activeServer: McpServer | undefined;
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Never hang on close() or lingering keep-alive handles during teardown.
  const forceExit = setTimeout(() => process.exit(exitCode), 500);
  forceExit.unref();

  try {
    await activeServer?.close();
  } catch {
    // Ignore close errors while shutting down.
  }
  process.exit(exitCode);
}

function exitFatal(label: string, err: unknown): never {
  const code = isDisconnectError(err) ? 0 : 1;
  if (!shuttingDown) {
    shuttingDown = true;
    if (code !== 0) {
      safeFatalLog(`[featurebase-mcp] ${label}: ${formatError(err)}\n`);
    }
  }
  process.exit(code);
}

function onStreamError(streamName: string, err: unknown): void {
  if (isDisconnectError(err)) {
    void shutdown(0);
    return;
  }
  safeLog(`[featurebase-mcp] ${streamName} error: ${formatError(err)}\n`);
  void shutdown(1);
}

// Install stream error handlers before anything writes to stdout/stderr;
// an unhandled stream 'error' event becomes an uncaughtException in Node.
process.stderr.on("error", () => {});
process.stdout.on("error", (err) => onStreamError("stdout", err));

process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));
process.stdin.on("error", (err) => onStreamError("stdin", err));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown(0));
}

process.on("uncaughtException", (err) => exitFatal("Uncaught exception", err));
process.on("unhandledRejection", (reason) => exitFatal("Unhandled rejection", reason));

async function main(): Promise<void> {
  const server: McpServer = buildServer();
  activeServer = server;
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Recoverable protocol/parse errors (e.g. malformed JSON lines) log to
  // stderr without tearing down the session; broken pipes are handled above.
  server.server.onerror = (err) => {
    safeLog(`[featurebase-mcp] transport error: ${formatError(err)}\n`);
  };
  server.server.onclose = () => {
    void shutdown(0);
  };

  if (process.stdin.readableEnded || process.stdin.destroyed) {
    void shutdown(0);
    return;
  }

  safeLog(
    "[featurebase-mcp] started — board: " +
      (process.env.FEATUREBASE_BOARD_URL ?? "https://itsremalt.featurebase.app") +
      "\n",
  );
}

main().catch((err) => exitFatal("failed to start", err));
