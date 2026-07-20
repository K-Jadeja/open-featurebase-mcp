# @kjadeja/open-featurebase-mcp

A reverse-engineered Model Context Protocol (MCP) server for **any public Featurebase feedback board**. Lets Claude Code, Cursor, and any MCP-compatible agent **read** feature requests, comments, and board stats — no API key, no auth, no cookies, no Pro plan required.

> The public Featurebase board is a Next.js SPA that embeds all post data as JSON inside `<script id="__NEXT_DATA__">`. This server extracts and normalizes that JSON into MCP tools. The free Featurebase tier doesn't include the official REST API or MCP — those are gated to the $59/seat/mo Professional plan. This server gives you 100% read access at 0% of the cost.

The default board is the [itsremalt feedback board](https://itsremalt.featurebase.app), but any other public Featurebase board works via the `FEATUREBASE_BOARD_URL` env var.

## Install

### Quick start: `npx` (recommended for users)

```bash
npx -y @kjadeja/open-featurebase-mcp
```

Or install globally:

```bash
npm install -g @kjadeja/open-featurebase-mcp
```

### Wire into Claude Code / Cursor

Add to your project's `.vscode/mcp.json` (or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "featurebase": {
      "command": "npx",
      "args": ["-y", "@kjadeja/open-featurebase-mcp"],
      "env": {
        "FEATUREBASE_BOARD_URL": "https://itsremalt.featurebase.app"
      }
    }
  }
}
```

Reload the MCP server list. The `featurebase` server appears with seven read-only tools.

> The `FEATUREBASE_BOARD_URL` env var is **optional** — when omitted, the server defaults to the itsremalt board. Set it to point at any other public Featurebase board (e.g. `https://acme.featurebase.app`).

### From source (contributors / development)

```bash
git clone https://github.com/K-Jadeja/open-featurebase-mcp
cd open-featurebase-mcp
npm install
npm run build
npm start
```

## What it does

Seven read-only tools:

| Tool | Purpose |
|---|---|
| `list_featurebase_posts` | List posts, filterable by status, sortable by date/upvotes. Posts carry engagement metadata (admin/customer reply counts + dates). |
| `get_featurebase_post` | Get one post by slug + full body + optional comment thread |
| `get_featurebase_posts` | **Batch fetch** multiple posts in one call (no round-trip overhead) |
| `search_featurebase_posts` | Keyword search over titles + bodies, ranked by relevance |
| `get_featurebase_stats` | Board-wide aggregates: counts by status, top-voted, most recent |
| `get_featurebase_stalled_promises` | Find posts where admin replied, customer spoke last, and admin has been silent for N+ days. Surfaces follow-ups you promised but forgot. |
| `find_featurebase_user` | Look up user IDs by partial name match (post authors + comment authors). Use the returned IDs as `teamUserIds` in stalled-promises so the agent doesn't need the `FEATUREBASE_TEAM_USER_IDS` env var. |

All results are normalized to clean JSON shapes (no HTML in the agent-facing output, just structured data + plain-text excerpts).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `FEATUREBASE_BOARD_URL` | `https://itsremalt.featurebase.app` | Point at any public Featurebase board. |
| `FEATUREBASE_TEAM_USER_IDS` | (unset) | Comma-separated Featurebase user IDs considered team. Used only for admin/customer classification on `list_featurebase_posts(hasAdminReply=…)` and `get_featurebase_stalled_promises`. **Optional.** |

### Team IDs — when you need them, when you don't

**Without `FEATUREBASE_TEAM_USER_IDS`** (or `teamUserIds` override) the server still works for everything except team-aware classification:

| Tool | Works without team IDs? | Notes |
|---|---|---|
| `list_featurebase_posts` (no `hasAdminReply`) | ✅ Yes | Listing + filtering + sorting all work. |
| `get_featurebase_post` | ✅ Yes | Post body + comments all work; `author.role` is `"unknown"`. |
| `get_featurebase_posts` | ✅ Yes | Batch fetch works. |
| `search_featurebase_posts` | ✅ Yes | Keyword search works. |
| `get_featurebase_stats` | ✅ Yes | Stats work. |
| `find_featurebase_user` | ✅ Yes | User lookup + `totalCommentCount` work. |
| `list_featurebase_posts(hasAdminReply=…)` | ❌ Errors with `InvalidParams` | Throws rather than silently returning wrong results. |
| `get_featurebase_stalled_promises` | ⚠️ Returns empty with `warning` | Use `find_featurebase_user` to discover user IDs, then pass them as `teamUserIds`. |

This is a **loud-failure contract**: when team classification is required but no team is configured, the tool errors out — never silently fabricates `customer`/`admin` assignments. To enable the team-aware tools, either set `FEATUREBASE_TEAM_USER_IDS=id1,id2,…` in the env, or call `find_featurebase_user` with your name and use the returned IDs as `teamUserIds` per-call.

## Known limitations

- **Admin role tagging requires team IDs.** `/api/v1/organization.admins` only holds the org owner (not the team that comments), so this MCP deliberately doesn't use it as a team source. Set `FEATUREBASE_TEAM_USER_IDS=id1,id2,…` in the env, or pass `teamUserIds` per-call to `get_featurebase_stalled_promises` after calling `find_featurebase_user`. Without one of these, `hasAdminReply` and `get_featurebase_stalled_promises` refuse to fabricate classifications.
- **No writes.** Reading only — posting comments, voting, changing status all require authenticated API access, gated to Featurebase's $59/seat/mo Professional plan. Out of scope for a reverse-engineered scraper.
- **No authentication.** The server reads publicly-served data. Boards that require sign-in or have aggressive bot protection will not work.

## Tool reference

### `list_featurebase_posts`
**Args:** `status?` (`open`/`planned`/`in_progress`/`complete`/`all`, default `all`), `sortBy?` (`date:desc`/`date:asc`/`upvotes:desc`, default `date:desc`), `limit?` (1–200, default 50), `hasAdminReply?` (boolean — requires a team identity; see above), `teamUserIds?` (string[] — runtime override)

**Returns:** `{ totalResults, availableResults, truncated, returned, posts: NormalizedPost[] }`

Each post in `posts[]` carries engagement metadata: `hasAdminReply`, `adminReplyCount`, `customerCommentCount`, `lastCommentDate`, `adminLastReplyDate`, `customerLastReplyDate`, and `commentFetchFailed` (only set when the comments fetch failed for that post). The enrichment is lazy — only posts with `commentCount > 0` are fetched, with concurrency capped at 8.

### `get_featurebase_post`
**Args:** `slug` (required), `include_comments?` (default `false`), `teamUserIds?` (string[] — runtime override)

**Returns:** `{ ...NormalizedPost, contentHtml, contentText, comments?: NormalizedComment[], commentsError?: string }`

**Always returns the full body** (contentHtml + contentText inlined on the post object). When `include_comments=true`, the full comment thread is inlined as a nested `comments` array (top-level comments with `replies[]` for replies). Each comment carries author (name, userId, role), bodyHtml, bodyText, createdAt, updatedAt, upvotes, parentId. If the comments fetch fails, the post is still returned with `commentsError` set — no silent degradation.

When `teamUserIds` is passed, comment authors (and engagement fields) are re-classified using these IDs as the team. A non-empty `teamUserIds` array **replaces** `FEATUREBASE_TEAM_USER_IDS` for that call only; an empty array `[]` is treated as absent (the env var is used if configured).

### `get_featurebase_posts` (batch)
**Args:** `slugs` (required, 1–20), `include_content?` (default `false`)

**Returns:** `{ requested, found, notFound?, posts: (NormalizedPost | NormalizedPostDetail)[] }`

Returns posts in the order requested. Missing slugs go into `notFound` instead of throwing. Set `include_content=true` to inline `contentHtml` + `contentText` on each post in `posts[]`.

**When to use which:**
- `get_featurebase_post` (singular) — for 1–3 posts. Always returns full body. Errors loudly if slug not found.
- `get_featurebase_posts` (batch) — for 4+ posts. Lighter default, opt-in full body, partial-miss tolerant (notFound).

### `search_featurebase_posts`
**Args:** `query` (required), `limit?` (1–50, default 10)

**Returns:** `{ query, totalMatches, returned, posts: NormalizedPost[] }` ordered by relevance (title hit = 3 pts, body hit = 1 pt, per-token matches also weighted).

### `get_featurebase_stats`
**Args:** `topVotedLimit?` (1–50, default 5), `recentLimit?` (1–50, default 5)

**Returns:** `{ totalResults, snapshotSize, truncated, snapshotWindow, statusCountsInSnapshot, categoryCountsInSnapshot, topVoted[N], recent[N] }`

`snapshotWindow` is `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD", ordering: "date desc" }` — the actual date range the SSR snapshot covers. Counts are labeled `*InSnapshot` to make explicit they're computed over the SSR-bundled subset, not the full board.

### `get_featurebase_stalled_promises`
**Args:** `minDaysSinceAdminReply?` (0–365, default 7), `limit?` (1–50, default 20), `teamUserIds?` (string[]), `status?` (string[] — restrict to these statuses), `sortBy?` (`staleness`/`freshness`/`upvotes`, default `staleness`)

**Returns:** `{ minDaysSinceAdminReply, teamSource, warning?, unusedTeamUserIds?, unusedTeamUserIdsComplete?, totalCandidates, returned, promises: StalledPromise[] }`

`teamSource` is `"override"` when `teamUserIds` was passed (and `FEATUREBASE_TEAM_USER_IDS` env var was bypassed), `"default"` when env-var-driven, or `"none"` when no team is available (returns empty with `warning`).

`unusedTeamUserIds` is set when `teamUserIds` was passed with at least one ID that didn't appear in any comment thread. `unusedTeamUserIdsComplete: false` signals that some comment fetches failed and we couldn't fully determine unused IDs.

`status` accepts any of `["open", "in_review", "planned", "in_progress", "completed"]` and restricts candidates.

`sortBy` controls response order:
- `"staleness"` (default): `customerLastReplyDate` desc — most-recent stalled promises first
- `"freshness"`: `adminLastReplyDate` desc — most-recent admin replies first (catch up on what you just said)
- `"upvotes"`: `upvotes` desc — focus on high-impact items regardless of staleness

This is the "I said I'd look into it in a comment and forgot to follow up" view. Two ways to identify admins:
1. **Auto**: set `FEATUREBASE_TEAM_USER_IDS` env var (recommended for production)
2. **Self-service**: ask the user for their name, call `find_featurebase_user` to look up the IDs, then pass them as `teamUserIds`

### `find_featurebase_user`
**Args:** `name` (required, partial match, case-insensitive, min 2 chars), `sampleSize?` (0–20, default 5)

**Returns:** `{ query, samplePostsScanned, commentsComplete, warning?, matches: UserMatch[] }`

Each `UserMatch` carries: `userId`, `name`, `postCount`, `commentCountInSampledPosts` (within `sampleSize` recent threads), `totalCommentCount` (board-wide — main signal), `guessedRole` (`"admin"` if user never posts but does comment, `"customer"` otherwise).

`commentsComplete` is `true` only when every comment fetch succeeded; `false` means at least one fetch failed and totals may undercount.

**Sort order**: `guessedRole === "admin"` first (most likely team), then by `totalCommentCount` desc.

## How it works

1. `GET {BASE_URL}/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=N` returns JSON directly (the SPA's axios baseURL is `/api`).
2. First call to page 1 discovers `totalPages` + `totalResults`. Remaining pages are fetched in parallel via `Promise.allSettled`. **Multi-page listing retrieval is atomic**: if any required page fails, the entire tool call surfaces the failure (no partial listing is cached or returned). Retry on the same client refetches every page from scratch.
3. Role tagging uses ONLY `FEATUREBASE_TEAM_USER_IDS` env var (or per-call `teamUserIds` override) — `/api/v1/organization.admins` is deliberately ignored because it holds the org owner, not the team. When neither is set, every author is `role: "unknown"` and engagement fields are omitted from listing responses.
4. All listing pages are concatenated into a single in-memory snapshot, normalized (HTML stripped, fields flattened), and cached for 5 minutes.
5. Filter/sort happen client-side so the cache stays valid across all sort orders and filter combinations.
6. When `get_featurebase_post(include_comments=true)` is called, `/api/v1/comment?submissionId=<id>` fetches the comment thread (top-level comments + nested replies). **Multi-page comment retrieval is also atomic**: a single failed page throws and is never cached as a partial thread.
7. No DOM scraping, no cheerio, no HTML parsing — JSON throughout.

## Troubleshooting

**`HTTP 404` from `/api/v1/submission`**
The board's API host may have changed (unlikely — has been stable for months). Try the alternate path `/v1/submission` (without the `/api` prefix) — some boards expose the endpoint there instead. If both fail, the board has likely been migrated or taken private.

**`HTTP 403 Forbidden`**
The board's Cloudflare or bot protection is blocking the request. Try again after a short delay, or fall back to opening the board in a browser.

**Stale data**
In-memory cache, TTL-based (5 min for listing + comments). Restart the server to flush.

**`truncated: true` or `engagementComplete: false` in responses**
Means one or more pages failed to fetch — partial snapshot. Use `snapshotSize` vs `totalResults` to see the gap, or `failedPostSlugs` to identify which posts couldn't be enriched. Restart the server to retry.

**Comments fetch fails (`commentsError` is set)**
The post is still returned; check `commentsError` for the reason. Common causes: network error, rate limit, or the comment endpoint returning an unexpected shape. Restart retries.

**All comment authors show `role: "unknown"` and engagement fields are missing**
The MCP deliberately doesn't trust `/api/v1/organization.admins` (it holds the org owner, not your comment-reply team). To activate role tagging, either set `FEATUREBASE_TEAM_USER_IDS=id1,id2` in the env, or call `find_featurebase_user` to discover IDs and pass them via `teamUserIds` to `get_featurebase_stalled_promises`.

## License

MIT
