# featurebase-mcp

A reverse-engineered Model Context Protocol (MCP) server for the [itsremalt Featurebase feedback board](https://itsremalt.featurebase.app). Lets Claude Code, Cursor, and any MCP-compatible agent **read** feature requests, comments, and board stats — no API key, no auth, no cookies required.

> The public Featurebase board is a Next.js SPA that embeds all post data as JSON inside `<script id="__NEXT_DATA__">`. This server extracts and normalizes that JSON into MCP tools. The free Featurebase tier doesn't include the official REST API or MCP — those are gated to the $59/seat/mo Professional plan. This server gives you 100% read access at 0% of the cost.

## What it does

Five read-only tools:

| Tool | Purpose |
|---|---|
| `list_featurebase_posts` | List posts, filterable by status, sortable by date/upvotes |
| `get_featurebase_post` | Get one post by slug + full body |
| `get_featurebase_posts` | **Batch fetch** multiple posts in one call (no round-trip overhead) |
| `search_featurebase_posts` | Keyword search over titles + bodies, ranked by relevance |
| `get_featurebase_stats` | Board-wide aggregates: counts by status, top-voted, most recent |

All results are normalized to clean JSON shapes (no HTML in the agent-facing output, just structured data + plain-text excerpts).

## Known limitations (be honest with your agent)

- **Admin role tagging is best-effort.** Featurebase's `/api/v1/organization.admins` field holds the **org owner**, not the full team that comments on the board. To get accurate `role: "admin"` tagging on comment and post authors, set `FEATUREBASE_TEAM_USER_IDS=id1,id2` (comma-separated user IDs) in the env. Without it, comment authors will usually show `role: "customer"` even if they're your team.
- **No writes.** Reading only — posting comments, voting, changing status all require authenticated API access, gated to Featurebase's $59/seat/mo Professional plan. Out of scope for a reverse-engineered scraper.

## What changed: comments + engagement ship

Two earlier limitations are now closed:

1. **Comment threads are accessible.** The post-detail pages render as Next.js 404 shells, but the SPA's client components call `/api/v1/comment?submissionId=<id>` directly — no auth required. `get_featurebase_post(include_comments=true)` returns the full threaded tree.
2. **Engagement metadata is enriched on listing.** Each post in `list`/`search`/`get_batch` now carries `hasAdminReply`, `adminReplyCount`, `customerCommentCount`, `lastCommentDate`, `adminLastReplyDate`, `customerLastReplyDate`, plus a `commentFetchFailed` flag for partial failures. Costs one comment fetch per post-with-comments on first listing miss, then zero until the 5-min cache expires.

## What changed: pagination ships

Earlier versions of this MCP were limited to the ~20 posts the SSR `__NEXT_DATA__` payload bundled. Reverse-engineering the SPA's axios config revealed the baseURL is `/api`, exposing the public listing endpoint at `/api/v1/submission?page=N` — no auth, no CSRF, returns JSON directly. The MCP now fetches all pages in parallel and merges them into a single cached snapshot. For itsremalt that's all **56 of 56 posts** across **6 pages**, with the full snapshot window (e.g. 2025-12-13 → 2026-07-14) visible in `get_stats`.

## Tool reference

### `list_featurebase_posts`
**Args:** `status?` (`open`/`planned`/`in_progress`/`complete`/`all`, default `all`), `sortBy?` (`date:desc`/`date:asc`/`upvotes:desc`, default `date:desc`), `limit?` (1–200, default 50)

**Returns:** `{ totalResults, availableResults, truncated, returned, posts: NormalizedPost[] }`

The `truncated` flag tells you when the SSR snapshot doesn't cover the full board.

Each post in `posts[]` carries engagement metadata: `hasAdminReply`, `adminReplyCount`, `customerCommentCount`, `lastCommentDate`, `adminLastReplyDate`, `customerLastReplyDate`, and `commentFetchFailed` (only set when the comments fetch failed for that post). The enrichment is eager — every post with `commentCount > 0` has its comment thread fetched once during listing, with concurrency capped at 8 to avoid hammering the API. On a 56-post board with 33 having comments, this costs ~33 comment fetches on first listing miss and zero on cache hits.

### `get_featurebase_post`
**Args:** `slug` (required), `include_comments?` (default `false`)

**Returns:** `{ ...NormalizedPost, contentHtml, contentText, comments?: NormalizedComment[], commentsError?: string }`

**Always returns the full body** (contentHtml + contentText inlined on the post object) — there is no content switch on this endpoint. When `include_comments=true`, the full comment thread is inlined as a nested `comments` array (top-level comments with `replies[]` for replies). Each comment carries author (name, userId, role), bodyHtml, bodyText, createdAt, updatedAt, upvotes, parentId. If the comments fetch fails, the post is still returned with `commentsError` set — no silent degradation.

To surface "team replied" vs "customer replied", set `FEATUREBASE_TEAM_USER_IDS` in the env (comma-separated user IDs). See "Admin role tagging" under Known limitations.

### `get_featurebase_posts` (batch)
**Args:** `slugs` (required, 1–20), `include_content?` (default `false`)

**Returns:** `{ requested, found, notFound?, posts: (NormalizedPost | NormalizedPostDetail)[] }`

Returns posts in the order requested. Missing slugs go into `notFound` instead of throwing. Set `include_content=true` to inline `contentHtml` + `contentText` on each post in `posts[]` (same shape as singular `get_featurebase_post`, just per element); off by default returns only the 800-char excerpt.

**When to use which:**
- `get_featurebase_post` (singular) — for 1–3 posts. Always returns full body. Errors loudly if slug not found.
- `get_featurebase_posts` (batch) — for 4+ posts. Lighter default, opt-in full body, partial-miss tolerant (notFound).

### `search_featurebase_posts`
**Args:** `query` (required), `limit?` (1–50, default 10)

**Returns:** `{ query, totalMatches, returned, posts: NormalizedPost[] }` ordered by relevance (title hit = 3 pts, body hit = 1 pt, per-token matches also weighted).

### `get_featurebase_stats`
**Args:** `topVotedLimit?` (1–50, default 5), `recentLimit?` (1–50, default 5)

**Returns:** `{ totalResults, snapshotSize, truncated, snapshotWindow, statusCountsInSnapshot, categoryCountsInSnapshot, topVoted[N], recent[N] }`

`snapshotWindow` is `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", ordering: "date desc" }` — the actual date range the SSR snapshot covers. Makes `truncated` actionable: with the window, you know whether the snapshot is "everything recent" or just a thin slice.

Counts are labeled `*InSnapshot` to make it explicit they're computed over the SSR-bundled subset, not the full board.

## Install

```bash
cd D:/Workspace/Github-Projects/featurebase-mcp
npm install
npm run build
```

## Run

### Standalone (stdio)
```bash
npm start
```

### With Claude Code / Cursor

Add to your project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "featurebase-mcp": {
      "command": "node",
      "args": ["D:/Workspace/Github-Projects/featurebase-mcp/dist/index.js"]
    }
  }
}
```

Reload the window. The server appears in the MCP servers list.

### Dev mode (live reload)
```bash
npm run dev
```

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `FEATUREBASE_BOARD_URL` | `https://itsremalt.featurebase.app` | Point at a different public Featurebase board |
| `FEATUREBASE_TEAM_USER_IDS` | (unset) | Comma-separated Featurebase user IDs considered team/admins. Combined with `/api/v1/organization.admins` for role tagging on comment + post authors. |

Changes require a server restart.

## How it works

1. `GET {BASE_URL}/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=N` returns JSON directly (the SPA's axios baseURL is `/api`).
2. First call to page 1 discovers `totalPages` + `totalResults`. Remaining pages are fetched in parallel via `Promise.allSettled` so a single failed page doesn't take down the whole listing.
3. `/api/v1/organization` is fetched in parallel with the listing to enrich each post's author with a `role` tag. Cached 1 hour.
4. All pages are concatenated into a single in-memory snapshot, normalized (HTML stripped, fields flattened), and cached for 5 minutes.
5. Filter/sort happen client-side so the cache stays valid across all sort orders and filter combinations.
6. When `get_featurebase_post(include_comments=true)` is called, `/api/v1/comment?submissionId=<id>` fetches the comment thread (top-level comments only — nested replies ship inside each comment's `replies` array). Tree is preserved server-side; we just normalize authors + sort by `createdAt`. Cached 5 min per submission.
7. During listing enrichment, comments are fetched once per post that has any (concurrency capped at 8, allSettled inside) and engagement metadata is computed and merged onto each post in `posts[]`. Per-post failures set `commentFetchFailed: true` rather than failing the whole listing.
8. No DOM scraping, no cheerio, no HTML parsing — JSON throughout.

## Troubleshooting

**`HTTP 404` from `/api/v1/submission`**
The board's API host may have changed (unlikely — has been stable for months). Try the alternate path `/v1/submission` (without the `/api` prefix) — some boards expose the endpoint there instead. If both fail, the board has likely been migrated or taken private.

**`HTTP 403 Forbidden`**
The board's Cloudflare or bot protection is blocking the request. The MCP doesn't retry on the API (would multiply cost without much benefit). Try again after a short delay, or fall back to opening the board in a browser.

**Stale data**
In-memory cache, TTL-based (5 min for listing + comments, 1 hour for org). Restart the server to flush.

**`truncated: true` in responses**
Means one or more pages failed to fetch — partial snapshot. Use `snapshotSize` vs `totalResults` to see the gap. Restart the server to retry.

**Comments fetch fails**
`get_featurebase_post` will still return the post; check `commentsError` for the reason. Common causes: `submissionId` missing on the post (shouldn't happen with current listing payloads), network error, or the comment endpoint returning an unexpected shape. Restart retries.

**All comment authors show `role: "customer"`**
The team's user IDs aren't in `/api/v1/organization.admins` (Featurebase stores the org owner there, not your comment-reply team). Set `FEATUREBASE_TEAM_USER_IDS=id1,id2` in the env to override. IDs are visible in any comment's `author.userId`.

## License

MIT