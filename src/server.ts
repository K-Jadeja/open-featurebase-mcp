/**
 * MCP server factory.
 *
 * Builds and registers all 7 tools on a McpServer instance. The
 * validateToolInput override is instance-scoped — see "Known limitations"
 * below.
 *
 * Importing this module is side-effect-free; it does NOT start the
 * transport. Callers (typically `src/index.ts`) do that explicitly.
 *
 * ## Client lifecycle
 *
 * Each `buildServer()` call constructs exactly ONE `Client` instance
 * (unless one is injected via the `client` option) and threads it into
 * all seven tool handler factories. Tool modules do NOT instantiate
 * clients at import time, so:
 *
 *   - Two `buildServer()` calls produce two independent clients with
 *     two independent caches.
 *   - Tests can inject a fake/mock client to exercise the MCP layer
 *     without network access.
 *   - The production server's request path exactly mirrors a test that
 *     uses the same DI shape, so perf and behavior claims are honest.
 *
 * ## Known limitations
 *
 * McpServer's `validateToolInput` is marked `@private` in the SDK
 * types but is a regular instance method at runtime. We override it on
 * the instance only (no global mutation) so we can produce clean
 * one-line validation errors (`"minDaysSinceAdminReply: must be at most
 * 365"`) instead of the SDK's default `JSON.stringify(issues)` dump.
 *
 * This relies on the SDK's runtime shape — `@modelcontextprotocol/sdk`
 * is pinned to the exact tested version in package.json. If the SDK
 * renames the method (unlikely; it has been stable since v1.x), tests
 * will fail loudly and we'll need to switch to a low-level Server +
 * setRequestHandler approach instead.
 *
 * If you want the cleanest dependency story, the alternative is to
 * use `Server` directly (bypassing McpServer) with a hand-rolled
 * CallToolRequest handler. That removes the override but adds ~50
 * lines of plumbing for capabilities/protocol. The current override
 * is contained to one line and survives SDK patches up to the pinned
 * version.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { formatZodIssue } from "./validation.js";
import { createClient, type Client } from "./client.js";
import { ListPostsArgsSchema } from "./tools/list-posts.js";
import { createListPostsHandler } from "./tools/list-posts.js";
import { GetPostArgsSchema } from "./tools/get-post.js";
import { createGetPostHandler } from "./tools/get-post.js";
import { GetPostsArgsSchema } from "./tools/get-posts.js";
import { createGetPostsHandler } from "./tools/get-posts.js";
import { SearchPostsArgsSchema } from "./tools/search-posts.js";
import { createSearchPostsHandler } from "./tools/search-posts.js";
import { GetStatsArgsSchema } from "./tools/get-stats.js";
import { createGetStatsHandler } from "./tools/get-stats.js";
import { GetStalledPromisesArgsSchema } from "./tools/get-stalled-promises.js";
import { createGetStalledPromisesHandler } from "./tools/get-stalled-promises.js";
import { FindUserArgsSchema } from "./tools/find-user.js";
import { createFindUserHandler } from "./tools/find-user.js";

/**
 * Validate raw input against a strict Zod schema at the MCP tool
 * boundary. Throws a single McpError whose message is the joined clean
 * issue text — never echoes input values, never exposes Zod internals.
 */
function validateArgs<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map(formatZodIssue).join("; ");
    throw new McpError(ErrorCode.InvalidParams, messages);
  }
  return result.data;
}

/**
 * Options for buildServer.
 *
 * `client` is injected primarily for testing — production callers can
 * omit it and a fresh `createClient()` is constructed for this server.
 * Two independent `buildServer()` calls always produce two independent
 * Client instances (whether the caller injects them or lets them be
 * default-constructed).
 */
export interface BuildServerOptions {
  client?: Client;
}

/**
 * Build the FeaturebaseMcpServer — registers all 7 tools with their
 * real ZodObject schemas (preserving descriptions, defaults, bounds,
 * enums), installs the request-scoped validator, returns the server.
 *
 * Call `await server.connect(transport)` after this.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  // One client per server. This is the ONLY client these seven tools
  // share. If a test injects its own, that is its tests' single client;
  // if the caller omits `client`, a fresh one is built now.
  const client = opts.client ?? createClient();
  const server = new McpServer({
    name: "featurebase-mcp",
    version: "1.0.0",
  });

  // Override the (private-typed) instance method. No global mutation;
  // affects only this server instance. See module-level note.
  (server as unknown as {
    validateToolInput: (
      tool: { inputSchema?: z.ZodTypeAny },
      args: unknown,
      _toolName: string,
    ) => Promise<unknown>;
  }).validateToolInput = async function (
    tool,
    args,
    _toolName,
  ): Promise<unknown> {
    if (!tool.inputSchema) return undefined;
    return validateArgs(tool.inputSchema, args);
  };

  // Each tool registered with its REAL ZodObject inputSchema so
  // listTools advertises a full schema (types, defaults, bounds). The
  // handler is a closure returned by a per-tool factory bound to the
  // single shared `client` above.
  server.registerTool(
    "list_featurebase_posts",
    {
      description:
        "List posts on the configured Featurebase feedback board.",
      inputSchema: z.object(ListPostsArgsSchema),
    },
    (args) => createListPostsHandler(client)(args as Parameters<ReturnType<typeof createListPostsHandler>>[0]),
  );

  server.registerTool(
    "get_featurebase_post",
    {
      description:
        "Get a single post by slug, optionally with full comment thread.",
      inputSchema: z.object(GetPostArgsSchema),
    },
    (args) => createGetPostHandler(client)(args as Parameters<ReturnType<typeof createGetPostHandler>>[0]),
  );

  server.registerTool(
    "get_featurebase_posts",
    {
      description: "Batch-fetch multiple posts by slug array.",
      inputSchema: z.object(GetPostsArgsSchema),
    },
    (args) => createGetPostsHandler(client)(args as Parameters<ReturnType<typeof createGetPostsHandler>>[0]),
  );

  server.registerTool(
    "search_featurebase_posts",
    {
      description: "Search posts by keyword over title + body.",
      inputSchema: z.object(SearchPostsArgsSchema),
    },
    (args) => createSearchPostsHandler(client)(args as Parameters<ReturnType<typeof createSearchPostsHandler>>[0]),
  );

  server.registerTool(
    "get_featurebase_stats",
    {
      description: "Board-wide statistics and aggregates.",
      inputSchema: z.object(GetStatsArgsSchema),
    },
    (args) => createGetStatsHandler(client)(args as Parameters<ReturnType<typeof createGetStatsHandler>>[0]),
  );

  server.registerTool(
    "get_featurebase_stalled_promises",
    {
      description:
        "Find posts where admin replied, customer spoke last, admin silent for N+ days.",
      inputSchema: z.object(GetStalledPromisesArgsSchema),
    },
    (args) =>
      createGetStalledPromisesHandler(client)(
        args as Parameters<ReturnType<typeof createGetStalledPromisesHandler>>[0],
      ),
  );

  server.registerTool(
    "find_featurebase_user",
    {
      description: "Look up user IDs by partial name match.",
      inputSchema: z.object(FindUserArgsSchema),
    },
    (args) => createFindUserHandler(client)(args as Parameters<ReturnType<typeof createFindUserHandler>>[0]),
  );

  return server;
}
