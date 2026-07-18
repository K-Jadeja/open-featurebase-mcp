#!/usr/bin/env node
/**
 * featurebase-mcp — MCP server entry point.
 *
 * Reverse-engineered scraper for public Featurebase feedback boards.
 * See README.md for tool reference and architecture notes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { listPosts, ListPostsArgsSchema } from "./tools/list-posts.js";
import { getPost, GetPostArgsSchema } from "./tools/get-post.js";
import { getPosts, GetPostsArgsSchema } from "./tools/get-posts.js";
import { searchPosts, SearchPostsArgsSchema } from "./tools/search-posts.js";
import { getStats, GetStatsArgsSchema } from "./tools/get-stats.js";
import { getStalledPromises, GetStalledPromisesArgsSchema } from "./tools/get-stalled-promises.js";

const server = new McpServer({
  name: "featurebase-mcp",
  version: "1.0.0",
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
    "follow-ups you promised in comments but never came back to.",
  GetStalledPromisesArgsSchema,
  getStalledPromises,
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