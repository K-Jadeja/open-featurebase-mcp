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

- **Comment bodies are not supported (and the API fails loudly if you ask).** Post detail pages (`/posts/<slug>`) are statically rendered as Next.js 404 shells — the dynamic post data, including the comment thread, is loaded by client-side JS. `get_featurebase_post` accepts an `include_comments` parameter for API stability, but if you set it to `true` the tool throws an `McpError` with a clear explanation rather than silently returning null. The `commentCount` field IS available because it's in the listing payload with each post.
- **What you CAN reliably read:** post titles, slugs, 800-char plain-text excerpts (with `…` when truncated), full HTML body (stripped in `contentText`), canonical `url` for each post, upvote counts, statuses, authors, dates, categories, and comment counts.

## What changed: pagination ships

Earlier versions of this MCP were limited to the ~20 posts the SSR `__NEXT_DATA__` payload bundled. Reverse-engineering the SPA's axios config revealed the baseURL is `/api`, exposing the public listing endpoint at `/api/v1/submission?page=N` — no auth, no CSRF, returns JSON directly. The MCP now fetches all pages in parallel and merges them into a single cached snapshot. For itsremalt that's all **56 of 56 posts** across **6 pages**, with the full snapshot window (e.g. 2025-12-13 → 2026-07-14) visible in `get_stats`.

## Tool reference

### `list_featurebase_posts`
**Args:** `status?` (`open`/`planned`/`in_progress`/`complete`/`all`, default `all`), `sortBy?` (`date:desc`/`date:asc`/`upvotes:desc`, default `date:desc`), `limit?` (1–200, default 50)

**Returns:** `{ totalResults, availableResults, truncated, returned, posts: NormalizedPost[] }`

The `truncated` flag tells you when the SSR snapshot doesn't cover the full board.

### `get_featurebase_post`
**Args:** `slug` (required), `include_comments?` (default `false` — setting to `true` throws)

**Returns:** `{ ...NormalizedPost, contentHtml, contentText }`

**Always returns the full body** (contentHtml + contentText inlined on the post object) — there is no content switch on this endpoint. Comments throw loudly if requested (no silent degradation).

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

Changes require a server restart.

## How it works

1. `GET {BASE_URL}/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=N` returns JSON directly (the SPA's axios baseURL is `/api`).
2. First call to page 1 discovers `totalPages` + `totalResults`. Remaining pages are fetched in parallel via `Promise.allSettled` so a single failed page doesn't take down the whole listing.
3. All pages are concatenated into a single in-memory snapshot, normalized (HTML stripped, fields flattened), and cached for 5 minutes.
4. Filter/sort happen client-side so the cache stays valid across all sort orders and filter combinations.
5. No DOM scraping, no cheerio, no HTML parsing — JSON throughout. Comment bodies are NOT scraped (Featurebase loads them via client-side JS against internal endpoints we can't reach from a non-browser fetch). The `commentCount` field IS available because it ships with each post.

## Troubleshooting

**`HTTP 404` from `/api/v1/submission`**
The board's API host may have changed (unlikely — has been stable for months). Try the alternate path `/v1/submission` (without the `/api` prefix) — some boards expose the endpoint there instead. If both fail, the board has likely been migrated or taken private.

**`HTTP 403 Forbidden`**
The board's Cloudflare or bot protection is blocking the request. The MCP doesn't retry on the API (would multiply cost without much benefit). Try again after a short delay, or fall back to opening the board in a browser.

**Stale data**
In-memory cache, TTL-based (5 min). Restart the server to flush.

**`truncated: true` in responses**
Means one or more pages failed to fetch — partial snapshot. Use `snapshotSize` vs `totalResults` to see the gap. Restart the server to retry.

**Comments always return `null`**
Expected behavior. Post detail pages are static 404 shells; comment threads load via client-side JS we can't execute. The `commentCount` field is always available from the listing payload.

## License

MIT