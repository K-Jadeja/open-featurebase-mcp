#!/usr/bin/env node
/**
 * featurebase-mcp — MCP server entry point.
 *
 * Reverse-engineered scraper for public Featurebase feedback boards.
 * See README.md for tool reference and architecture notes.
 *
 * ## Validation strategy
 *
 * We need two properties together:
 *   1. **Detailed public schemas** — agents calling the MCP need to know
 *      each tool's argument shape (types, required fields, enums, defaults,
 *      descriptions). Otherwise they have to guess.
 *   2. **Clean validation errors** — when the agent's input fails validation,
 *      we surface a single readable line like
 *      `minDaysSinceAdminReply: must be at most 365` — not Zod's raw
 *      JSON-stringified issues array.
 *
 * The MCP SDK's default `validateToolInput` only does (1) by passing args
 * through `safeParse` and JSON.stringify-ing the resulting issues on failure
 * (ugly). We achieve both by *subclassing* `McpServer` and overriding
 * `validateToolInput` to throw a single `McpError` with our clean formatter
 * while leaving the SDK's `inputSchema` registration untouched (so
 * `listTools` returns the real schemas).
 *
 * No global Zod mutation, no module-level caches, no value echo —
 * everything is local to the validate call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { formatZodIssue } from "./validation.js";

// Re-export formatZodIssue so unit tests can import it without reaching
// into a private module path. Production code only uses it inside
// validateToolInput.
export { formatZodIssue };
export { aggregateCommentCounts } from "./aggregation.js";

import { listPosts, ListPostsArgsSchema } from "./tools/list-posts.js";
import { getPost, GetPostArgsSchema } from "./tools/get-post.js";
import { getPosts, GetPostsArgsSchema } from "./tools/get-posts.js";
import { searchPosts, SearchPostsArgsSchema } from "./tools/search-posts.js";
import { getStats, GetStatsArgsSchema } from "./tools/get-stats.js";
import { getStalledPromises, GetStalledPromisesArgsSchema } from "./tools/get-stalled-promises.js";
import { findUser, FindUserArgsSchema } from "./tools/find-user.js";

// ---------------------------------------------------------------------------
// Tool registration helpers.
// ---------------------------------------------------------------------------

function toZodObject<S extends z.ZodRawShape>(shape: S) {
  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Subclassed McpServer — overrides validateToolInput to throw a clean
// McpError instead of letting the SDK JSON.stringify the issues array.
//
// Listing-tools discovery is unchanged: `listTools` calls
// `toJsonSchemaCompat(inputSchema)` which descends into the real ZodObject
// and produces a complete JSON Schema (types, enums, defaults, descriptions,
// `additionalProperties: false`). Agents see real argument shapes.
// ---------------------------------------------------------------------------

// Validate-with-clean-format approach.
//
// The MCP SDK's McpServer.validateToolInput is marked private in its
// public types but it's a regular method at runtime. We instantiate
// McpServer normally, then override the method on the instance to
// produce a single McpError with our formatter (request-scoped, no
// shared state). Tools are registered with their REAL ZodObject schemas
// — listTools advertises the full shape (types, required fields, enums,
// defaults, descriptions, `additionalProperties: false`).
function cleanValidateToolInput(
  tool: { inputSchema?: z.ZodTypeAny },
  args: unknown,
  _toolName: string,
): Promise<unknown> {
  if (!tool.inputSchema) return Promise.resolve(undefined);
  return tool.inputSchema.safeParseAsync(args).then((result) => {
    if (!result.success) {
      const messages = result.error.issues.map(formatZodIssue).join("; ");
      throw new McpError(ErrorCode.InvalidParams, messages);
    }
    return result.data;
  });
}

const server = new McpServer({
  name: "featurebase-mcp",
  version: "1.0.0",
});

// Override the instance method. This shadows the parent's validator for
// every tools/call on this server. No global mutation — single instance,
// single assignment at startup. Function-scoped; safe under concurrency
// since each invocation constructs its own messages string.
(server as unknown as {
  validateToolInput: (
    tool: { inputSchema?: z.ZodTypeAny },
    args: unknown,
    toolName: string,
  ) => Promise<unknown>;
}).validateToolInput = cleanValidateToolInput;

// ---------------------------------------------------------------------------
// Tool registrations — every tool advertises its REAL input schema (built
// from the raw shape exported by the tool file). Defaults and constraints
// are preserved through the ZodObject. Validation runs through our clean
// formatter via FeaturebaseMcpServer above.
// ---------------------------------------------------------------------------

server.registerTool(
  "list_featurebase_posts",
  {
    description:
      "List posts on the configured Featurebase feedback board. " +
      "Optionally filter by status, sort by date/upvotes, restrict to " +
      "posts where the team has commented via hasAdminReply.",
    inputSchema: toZodObject(ListPostsArgsSchema),
  },
  (args) => listPosts(args as Parameters<typeof listPosts>[0]),
);

server.registerTool(
  "get_featurebase_post",
  {
    description:
      "Get a single post by its slug. ALWAYS returns the full body " +
      "(contentHtml + contentText inlined on the post object). Set " +
      "include_comments=true to also inline the full comment thread as " +
      "a nested comments array; each comment carries author.role so the " +
      "agent can distinguish team replies from customer messages. " +
      "Optional teamUserIds overrides the configured team set for role " +
      "tagging.",
    inputSchema: toZodObject(GetPostArgsSchema),
  },
  (args) => getPost(args as Parameters<typeof getPost>[0]),
);

server.registerTool(
  "get_featurebase_posts",
  {
    description:
      "Batch fetch multiple posts in one call. Pass an array of slugs; " +
      "returns matching posts in the order requested. Posts not in the " +
      "snapshot are listed in a notFound field rather than throwing. " +
      "Set include_content=true to inline full contentHtml + " +
      "contentText on each post (otherwise only the 800-char excerpt " +
      "is returned).",
    inputSchema: toZodObject(GetPostsArgsSchema),
  },
  (args) => getPosts(args as Parameters<typeof getPosts>[0]),
);

server.registerTool(
  "search_featurebase_posts",
  {
    description:
      "Search the Featurebase board by keyword. Matches against post " +
      "titles (weighted 3x) and bodies (1x), with per-token matching for " +
      "multi-word queries. Returns up to N posts ordered by relevance score.",
    inputSchema: toZodObject(SearchPostsArgsSchema),
  },
  (args) => searchPosts(args as Parameters<typeof searchPosts>[0]),
);

server.registerTool(
  "get_featurebase_stats",
  {
    description:
      "Aggregate statistics for the Featurebase board: total post " +
      "count, counts grouped by status and category, the N most-" +
      "upvoted posts, and the N most recent posts. Also returns " +
      "snapshotWindow describing the date range the SSR snapshot " +
      "actually covers.",
    inputSchema: toZodObject(GetStatsArgsSchema),
  },
  (args) => getStats(args as Parameters<typeof getStats>[0]),
);

server.registerTool(
  "get_featurebase_stalled_promises",
  {
    description:
      "Find posts where an admin (team) replied in a comment and the " +
      "customer spoke last, and the admin has been silent for at least " +
      "minDaysSinceAdminReply days (default 7). Returns each stalled " +
      "post's slug, title, status, daysSinceAdminReply, and 200-char " +
      "excerpts of both the last admin message and the last customer " +
      "message. Optional status[] restricts candidates; optional sortBy " +
      "changes ordering. If you don't have admin user IDs configured, " +
      "ask the user for their name, call find_featurebase_user to look " +
      "up the IDs, then pass them via teamUserIds.",
    inputSchema: toZodObject(GetStalledPromisesArgsSchema),
  },
  (args) =>
    getStalledPromises(args as Parameters<typeof getStalledPromises>[0]),
);

server.registerTool(
  "find_featurebase_user",
  {
    description:
      "Look up Featurebase user IDs by partial name match (min 2 " +
      "chars). Scans post authors from the listing plus the comment " +
      "threads of the N most recent posts with comments. Returns " +
      "matching users with postCount, commentCountInSampledPosts, " +
      "totalCommentCount, and guessedRole. Sort: admin first, then by " +
      "totalCommentCount desc. totalCommentCount is board-wide; check " +
      "commentsComplete in the response to confirm no post's comments " +
      "fetch failed.",
    inputSchema: toZodObject(FindUserArgsSchema),
  },
  (args) => findUser(args as Parameters<typeof findUser>[0]),
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  console.error("[featurebase-mcp] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[featurebase-mcp] Unhandled rejection:", reason);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    "[featurebase-mcp] started — board:",
    process.env.FEATUREBASE_BOARD_URL ?? "https://itsremalt.featurebase.app",
  );
}

main().catch((err) => {
  console.error("[featurebase-mcp] failed to start:", err);
  process.exit(1);
});
