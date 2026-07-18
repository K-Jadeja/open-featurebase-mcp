#!/usr/bin/env node
/**
 * featurebase-mcp — MCP server entry point.
 *
 * Reverse-engineered scraper for public Featurebase feedback boards.
 * See README.md for tool reference and architecture notes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { listPosts, ListPostsArgsSchema } from "./tools/list-posts.js";
import { getPost, GetPostArgsSchema } from "./tools/get-post.js";
import { getPosts, GetPostsArgsSchema } from "./tools/get-posts.js";
import { searchPosts, SearchPostsArgsSchema } from "./tools/search-posts.js";
import { getStats, GetStatsArgsSchema } from "./tools/get-stats.js";
import { getStalledPromises, GetStalledPromisesArgsSchema } from "./tools/get-stalled-promises.js";
import { findUser, FindUserArgsSchema } from "./tools/find-user.js";

const server = new McpServer({
  name: "featurebase-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Clean Zod validation errors via prototype override + path-keyed input cache.
//
// Background: when validation fails, Zod throws a ZodError whose `.message`
// is `JSON.stringify(issues, null, 2)`. The MCP SDK then surfaces that
// message back to the agent, leaking the entire issues array
// ([{code, path, inclusive, exact, message, ...}]) along with the useful
// string. Earlier rounds tried to fix this via a custom global errorMap
// (formatted each issue's `message` field), but Zod ignores the message
// reformat for the SDK path because ZodError wraps everything in JSON
// before the SDK reads it.
//
// This patch has two pieces:
//
// 1. A global errorMap that captures the failing value (`ctx.data`) into
//    a path-keyed Map. We can't mutate the issue directly — Zod's
//    `makeIssue` builds a fresh issue object AFTER errorMap returns and
//    discards any properties we set. Path is unique enough for our
//    flat argument shapes; collisions only matter if the same field
//    triggers multiple error codes, which doesn't happen in practice.
//
// 2. A `ZodError.prototype.message` getter override that joins
//    pre-formatted per-issue messages into one clean line:
//      "minDaysSinceAdminReply: must be at most 365 (got 9999)"
//    instead of:
//      "[ { code: 'too_big', maximum: 365, ... } ]"
//    `configurable: true` lets us re-define the property; the setter on
//    the prototype absorbs ZodError's constructor's
//    `this.message = JSON.stringify(...)` call and discards it.
// ---------------------------------------------------------------------------

const OrigZodError = z.ZodError;

// Per-issue data captured during validation. Keyed by JSON-stringified path.
// Cleared on a per-validation basis would be cleaner but adds bookkeeping
// for negligible benefit — the captured values are only read in the
// prototype getter that fires when the same process is throwing the same
// error to the same agent.
const dataByPath = new Map<string, unknown>();

z.setErrorMap((issue, ctx) => {
  const path = (issue.path ?? []).join(".") || "(root)";
  dataByPath.set(path, ctx.data);
  return { message: issue.message ?? "" };
});

const formatIssue = (issue: z.ZodIssue): string => {
  const path = (issue.path ?? []).join(".") || "argument";
  const inputVal = dataByPath.get(path);
  const got =
    inputVal === undefined ? "" : ` (got ${JSON.stringify(inputVal)})`;

  switch (issue.code) {
    case "too_big":
      return `${path}: must be at most ${issue.maximum}${
        issue.inclusive ? "" : " (exclusive)"
      }${got}`;
    case "too_small":
      return `${path}: must be at least ${issue.minimum}${
        issue.inclusive ? "" : " (exclusive)"
      }${got}`;
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
};

Object.defineProperty(OrigZodError.prototype, "message", {
  get(this: z.ZodError) {
    if (!this.issues || this.issues.length === 0) return "";
    return this.issues.map(formatIssue).join("; ");
  },
  set(_value: unknown) {
    // Absorb constructor's `this.message = JSON.stringify(...)` and let our
    // getter do all formatting.
  },
  configurable: true,
});

server.tool(
  "list_featurebase_posts",
  "List posts on the configured Featurebase feedback board. " +
    "Optionally filter by status (open/planned/in_progress/complete/all) " +
    "and sort by date or upvotes. Returns slug, title, status, vote count, " +
    "comment count, author, date, and a plain-text excerpt of the body.",
  ListPostsArgsSchema,
  listPosts,
);

server.tool(
  "get_featurebase_post",
  "Get a single post by its slug. ALWAYS returns the full body " +
    "(contentHtml + contentText inlined on the post object) — there is no " +
    "content switch on this endpoint. Set include_comments=true to also " +
    "inline the full comment thread as a nested `comments` array; each " +
    "comment carries author.role='admin'|'customer' so the agent can " +
    "distinguish team replies from customer messages. The post's " +
    "commentCount is always returned in the metadata.",
  GetPostArgsSchema,
  getPost,
);

server.tool(
  "get_featurebase_posts",
  "Batch fetch multiple posts in one call. Pass an array of slugs; returns " +
    "matching posts in the order requested. Posts not in the snapshot are " +
    "listed in a `notFound` field rather than throwing. Set include_content=true " +
    "to inline full contentHtml + contentText on each post (otherwise only the " +
    "800-char excerpt is returned). When to use: singular get_featurebase_post " +
    "for 1–3 posts (always returns full body), this batch tool for 4+ posts " +
    "(lighter, opt-in full body, partial-miss tolerant).",
  GetPostsArgsSchema,
  getPosts,
);

server.tool(
  "search_featurebase_posts",
  "Search the Featurebase board by keyword. Matches against post titles " +
    "(weighted 3x) and bodies (1x), with per-token matching for multi-word " +
    "queries. Returns up to N posts ordered by relevance score.",
  SearchPostsArgsSchema,
  searchPosts,
);

server.tool(
  "get_featurebase_stats",
  "Aggregate statistics for the Featurebase board: total post count, " +
    "counts grouped by status and category, the N most-upvoted posts " +
    "(topVotedLimit, default 5), and the N most recent posts " +
    "(recentLimit, default 5). Also returns snapshotWindow describing " +
    "the date range the SSR snapshot actually covers.",
  GetStatsArgsSchema,
  getStats,
);

server.tool(
  "get_featurebase_stalled_promises",
  "Find posts where an admin (team) replied in a comment and the customer " +
    "spoke last, and the admin has been silent for at least " +
    "minDaysSinceAdminReply days (default 7). Returns each stalled post's " +
    "slug, title, status, daysSinceAdminReply, and 200-char excerpts of " +
    "both the last admin message and the last customer message. Sorted " +
    "by customerLastReplyDate desc (most recent first). Use this to find " +
    "follow-ups you promised in comments but never came back to. " +
    "If you don't have admin user IDs configured, ask the user for their " +
    "name, call find_featurebase_user to look up the IDs, then pass them " +
    "via teamUserIds.",
  GetStalledPromisesArgsSchema,
  getStalledPromises,
);

server.tool(
  "find_featurebase_user",
  "Look up Featurebase user IDs by partial name match. Scans post authors " +
    "from the listing plus the comment threads of the N most recent posts " +
    "with comments (sampleSize, default 5). Returns matching users with " +
    "postCount, commentCount, and a guessedRole ('admin' if the user " +
    "never posts but does comment, 'customer' otherwise). Use the returned " +
    "userIds as teamUserIds in get_featurebase_stalled_promises — lets the " +
    "agent run a stalled-promise query without setting FEATUREBASE_TEAM_USER_IDS " +
    "in the env.",
  FindUserArgsSchema,
  findUser,
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