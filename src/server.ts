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
import { listPosts, ListPostsArgsSchema } from "./tools/list-posts.js";
import { getPost, GetPostArgsSchema } from "./tools/get-post.js";
import { getPosts, GetPostsArgsSchema } from "./tools/get-posts.js";
import { searchPosts, SearchPostsArgsSchema } from "./tools/search-posts.js";
import { getStats, GetStatsArgsSchema } from "./tools/get-stats.js";
import { getStalledPromises, GetStalledPromisesArgsSchema } from "./tools/get-stalled-promises.js";
import { findUser, FindUserArgsSchema } from "./tools/find-user.js";

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
 * Build the FeaturebaseMcpServer — registers all 7 tools with their
 * real ZodObject schemas (preserving descriptions, defaults, bounds,
 * enums), installs the request-scoped validator, returns the server.
 *
 * Call `await server.connect(transport)` after this.
 */
export function buildServer(): McpServer {
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
  // listTools advertises a full schema (types, defaults, bounds).
  server.registerTool(
    "list_featurebase_posts",
    {
      description:
        "List posts on the configured Featurebase feedback board.",
      inputSchema: z.object(ListPostsArgsSchema),
    },
    (args) => listPosts(args as Parameters<typeof listPosts>[0]),
  );

  server.registerTool(
    "get_featurebase_post",
    {
      description:
        "Get a single post by slug, optionally with full comment thread.",
      inputSchema: z.object(GetPostArgsSchema),
    },
    (args) => getPost(args as Parameters<typeof getPost>[0]),
  );

  server.registerTool(
    "get_featurebase_posts",
    {
      description: "Batch-fetch multiple posts by slug array.",
      inputSchema: z.object(GetPostsArgsSchema),
    },
    (args) => getPosts(args as Parameters<typeof getPosts>[0]),
  );

  server.registerTool(
    "search_featurebase_posts",
    {
      description: "Search posts by keyword over title + body.",
      inputSchema: z.object(SearchPostsArgsSchema),
    },
    (args) => searchPosts(args as Parameters<typeof searchPosts>[0]),
  );

  server.registerTool(
    "get_featurebase_stats",
    {
      description: "Board-wide statistics and aggregates.",
      inputSchema: z.object(GetStatsArgsSchema),
    },
    (args) => getStats(args as Parameters<typeof getStats>[0]),
  );

  server.registerTool(
    "get_featurebase_stalled_promises",
    {
      description:
        "Find posts where admin replied, customer spoke last, admin silent for N+ days.",
      inputSchema: z.object(GetStalledPromisesArgsSchema),
    },
    (args) =>
      getStalledPromises(args as Parameters<typeof getStalledPromises>[0]),
  );

  server.registerTool(
    "find_featurebase_user",
    {
      description: "Look up user IDs by partial name match.",
      inputSchema: z.object(FindUserArgsSchema),
    },
    (args) => findUser(args as Parameters<typeof findUser>[0]),
  );

  return server;
}
