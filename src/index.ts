#!/usr/bin/env node
/**
 * featurebase-mcp — MCP server entry point.
 *
 * Reverse-engineered scraper for public Featurebase feedback boards.
 * See README.md for tool reference and architecture notes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { listPosts, ListPostsArgsSchema } from "./tools/list-posts.js";
import { getPost, GetPostArgsSchema } from "./tools/get-post.js";
import { getPosts, GetPostsArgsSchema } from "./tools/get-posts.js";
import { searchPosts, SearchPostsArgsSchema } from "./tools/search-posts.js";
import { getStats, GetStatsArgsSchema } from "./tools/get-stats.js";
import { getStalledPromises, GetStalledPromisesArgsSchema } from "./tools/get-stalled-promises.js";
import { findUser, FindUserArgsSchema } from "./tools/find-user.js";

// ---------------------------------------------------------------------------
// Per-tool validation wrapper.
//
// Why we don't use the SDK's built-in Zod validation: it formats errors
// by JSON.stringify-ing the issues array, exposing Zod's internal shape
// (code, path, inclusive, exact, etc.) alongside any custom message. A
// previous fix (ZodError.prototype.message override) was hacky and
// unsafe — global state, leaks across requests, breaks Zod in isolation.
//
// This helper runs at the MCP tool boundary, request-scoped (no shared
// state). It does NOT mutate Zod globally. It does NOT echo arbitrary
// input values into the response — only field names + constraints, so
// secrets or large payloads cannot leak via a validation error.
//
// We register tools via registerTool(name, config, cb) (config-object
// form) so the SDK accepts a passthrough ZodObject as inputSchema
// without re-introducing the JSON.stringify error format. The position-
// arg form rejects ZodObject via its arg-shape check.
// ---------------------------------------------------------------------------

/**
 * Permissive tool-args schema. `.passthrough()` accepts any object and
 * preserves unknown keys in the parsed output. Real validation happens
 * inside our wrapper (clean text, request-scoped, no Zod internals, no
 * echoed values). The as-any cast bypasses TypeScript's ZodRawShape
 * union constraint; the runtime value is unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ANY_ARGS = z.object({}).passthrough() as any;

/**
 * Format a Zod issue into a clean human-readable string. Bounds and
 * expected types only — never the failing value.
 */
function formatZodIssue(issue: z.ZodIssue): string {
  const path = (issue.path ?? []).join(".") || "argument";
  switch (issue.code) {
    case "too_big":
      return `${path}: must be at most ${issue.maximum}${
        issue.inclusive ? "" : " (exclusive)"
      }`;
    case "too_small":
      return `${path}: must be at least ${issue.minimum}${
        issue.inclusive ? "" : " (exclusive)"
      }`;
    case "invalid_type":
      return `${path}: expected ${issue.expected}, received ${issue.received}`;
    case "invalid_enum_value":
      return `${path}: must be one of ${(issue.options ?? []).join(", ")}`;
    case "invalid_string":
      return `${path}: ${issue.validation ?? "invalid string"}`;
    case "unrecognized_keys":
      return `${path}: unrecognized keys ${JSON.stringify(issue.keys ?? [])}`;
    default:
      return `${path}: ${issue.message ?? "invalid"}`;
  }
}

/**
 * Validate raw input against a strict Zod schema at the MCP boundary.
 * Throws a single McpError whose message is the joined clean issue text.
 * No module-level caches — concurrent requests cannot contaminate each
 * other.
 */
function validateArgs<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map(formatZodIssue).join("; ");
    throw new McpError(ErrorCode.InvalidParams, messages);
  }
  return result.data;
}

/**
 * Build a tool handler that validates its arguments against `shape` and
 * then calls `handler(validated)`. The closure holds no state; safe under
 * concurrency.
 */
function withValidation<S extends z.ZodRawShape>(
  shape: S,
  handler: (args: z.output<z.ZodObject<S>>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>,
) {
  const schema = z.object(shape);
  return async (raw: unknown) => handler(validateArgs(schema, raw));
}

const server = new McpServer({
  name: "featurebase-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool registrations via registerTool() (config-object form).
// Position-arg form (server.tool) rejected ZodObject via isZodRawShapeCompat
// and dropped args via executeToolHandler's no-inputSchema branch; config-
// object form accepts a ZodObject directly via getZodSchemaObject.
// ---------------------------------------------------------------------------

server.registerTool(
  "list_featurebase_posts",
  {
    description:
      "List posts on the configured Featurebase feedback board. " +
      "Optionally filter by status, sort by date/upvotes, restrict to " +
      "posts where the team has commented via hasAdminReply.",
    inputSchema: ANY_ARGS,
  },
  withValidation(ListPostsArgsSchema, listPosts),
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
    inputSchema: ANY_ARGS,
  },
  withValidation(GetPostArgsSchema, getPost),
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
    inputSchema: ANY_ARGS,
  },
  withValidation(GetPostsArgsSchema, getPosts),
);

server.registerTool(
  "search_featurebase_posts",
  {
    description:
      "Search the Featurebase board by keyword. Matches against post " +
      "titles (weighted 3x) and bodies (1x), with per-token matching " +
      "for multi-word queries. Returns up to N posts ordered by " +
      "relevance score.",
    inputSchema: ANY_ARGS,
  },
  withValidation(SearchPostsArgsSchema, searchPosts),
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
    inputSchema: ANY_ARGS,
  },
  withValidation(GetStatsArgsSchema, getStats),
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
    inputSchema: ANY_ARGS,
  },
  withValidation(GetStalledPromisesArgsSchema, getStalledPromises),
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
      "totalCommentCount desc.",
    inputSchema: ANY_ARGS,
  },
  withValidation(FindUserArgsSchema, findUser),
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
