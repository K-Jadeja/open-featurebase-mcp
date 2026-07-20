# @kjadeja/open-featurebase-mcp

A Model Context Protocol (MCP) server I built for reading public Featurebase feedback boards from any MCP-compatible agent — Claude Code, Cursor, VS Code, others.

I built this for [Remalt](https://itsremalt.featurebase.app) because I wanted my coding agent to be able to answer questions like *"what have users been asking for that we haven't replied to?"*, *"which promised fixes are stalled?"*, and *"what's the most-upvoted unaddressed feedback this week?"* without me copy-pasting from a browser tab.

The default board is the Remalt one, but it works against any public Featurebase board that exposes the same public listing + comment endpoints.

## Install

### Quickest path — `npx`

```bash
npx -y @kjadeja/open-featurebase-mcp
```

This runs the server directly without installing anything. Use this for one-off testing or to confirm the package works on your machine.

To install globally:

```bash
npm install -g @kjadeja/open-featurebase-mcp
```

Then point any MCP client at the binary it adds to your `PATH`:

```bash
which open-featurebase-mcp
# /usr/local/bin/open-featurebase-mcp   (macOS/Linux)
// or on Windows:
where open-featurebase-mcp
```

## Connecting an MCP client

The setup file format differs across clients — pick the one that matches yours.

### Claude Code

The simplest setup is the CLI:

```bash
# Use the default Remalt board
claude mcp add --transport stdio --scope user featurebase -- npx -y @kjadeja/open-featurebase-mcp

# Or point at a different board
claude mcp add --transport stdio --scope user --env FEATUREBASE_BOARD_URL=https://example.featurebase.app featurebase -- npx -y @kjadeja/open-featurebase-mcp
```

If you prefer to keep it in a file, use `.mcp.json` in the project root with the `mcpServers` (note the camelCase) key:

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

### Cursor

Cursor uses `.cursor/mcp.json` in the project root, with the `mcpServers` key:

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

### VS Code (GitHub Copilot Chat or other MCP-aware extensions)

VS Code uses `.vscode/mcp.json`, with a top-level `servers` (not `mcpServers`) key:

```json
{
  "servers": {
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

> **Note**: The three file formats are NOT interchangeable. `.vscode/mcp.json` uses `servers`; Claude Code and Cursor use `mcpServers`. Copy the exact form above for your editor.

After editing the file, reload the editor so it picks up the new server. The seven tools below will appear in the MCP tools list.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `FEATUREBASE_BOARD_URL` | `https://itsremalt.featurebase.app` | The public Featurebase board to read from. Optional — set this only if you want a different board. |
| `FEATUREBASE_TEAM_USER_IDS` | (unset) | Comma-separated Featurebase user IDs considered team. Used for admin/customer classification. **Optional.** |

### When team IDs matter

Most tools work without any team configuration — they read posts, comments, search, stats, batch-fetch, and user lookup without knowing who's on the team. Team IDs are only needed when you want to classify authors or detect stalled follow-ups:

| Tool | Without team IDs | With team IDs |
|---|---|---|
| `list_featurebase_posts` (no `hasAdminReply`) | ✅ Works | ✅ Same result |
| `get_featurebase_post` | ✅ Works; `author.role === "unknown"` | ✅ Authors classified; engagement fields populated |
| `get_featurebase_posts` | ✅ Works | ✅ Authors classified |
| `search_featurebase_posts` | ✅ Works | ✅ Authors classified |
| `get_featurebase_stats` | ✅ Works | ✅ Same result |
| `find_featurebase_user` | ✅ Works; `totalCommentCount` still accurate | ✅ Same result |
| `list_featurebase_posts(hasAdminReply=…)` | ❌ Throws `InvalidParams` | ✅ Filters posts |
| `get_featurebase_stalled_promises` | ⚠️ Returns empty with a `warning` | ✅ Returns stalled promises |

When a tool requires a team identity and none is configured, it errors out rather than silently fabricate `customer` / `admin` assignments. To enable the team-aware tools, either set `FEATUREBASE_TEAM_USER_IDS=id1,id2,…` in the env, or call `find_featurebase_user` with your name to discover IDs and pass them as `teamUserIds` per-call.

## Practical prompts

These are the workflows I actually run. Paste them into Claude Code / Cursor after the MCP server is connected.

### Daily triage

> Show me the top 10 most-upvoted open posts that don't yet have an admin reply. For each one, summarize the request and quote the highest-voted customer comment.

This uses `list_featurebase_posts(hasAdminReply=false, status="open", sortBy="upvotes:desc", teamUserIds=[…])` followed by `get_featurebase_post` for the top entries.

### Find stalled follow-ups

> Which posts have I (the team) replied to, the customer replied after me, and I haven't said anything in over a week? Show the last 5 by staleness, with the customer's last message quoted.

This is exactly `get_featurebase_stalled_promises({ minDaysSinceAdminReply: 7 })`.

### Detect duplicates

> Search the board for "export to CSV" and "download as spreadsheet". Cluster the matches by similarity and tell me which ones look like duplicates I should merge.

This uses `search_featurebase_posts` for both queries and then a similarity grouping.

### Create a GitHub issue from a feature request

> Take post `more-byok-options`, summarize it as a single-paragraph problem statement, and produce a GitHub-issue-formatted markdown block (title + body) that I can paste into our repo.

The agent reads the post body, formats it, and you paste the result into GitHub.

### Voice-of-customer report

> Read the 20 most-recent open posts. Group them by theme. For each theme, give me: how many users mentioned it, the total upvotes, and one representative quote.

This uses `list_featurebase_posts(status="open", sortBy="date:desc", limit=20)` plus per-post comment reads.

### Find unanswered posts

> List all open posts with the `in_progress` status that have zero admin replies. These are the ones we should respond to first.

This is `list_featurebase_posts(hasAdminReply=false, status="in_progress")`.

### Discover your team IDs

> Find my user ID on this board. My name is "Krishna".

This uses `find_featurebase_user({ name: "Krishna" })`. Use the returned IDs as `teamUserIds` in subsequent calls — no env-var setup needed.

## Tools

Seven read-only tools. Each one is designed to be cheap enough to chain — most listing calls don't fetch comments at all unless you ask for engagement.

### `list_featurebase_posts`

**Args:**

- `status` — one of the friendly names below; the server maps them to the underlying `postStatus.type` values returned by the public board:

  | Friendly name | `postStatus.type` |
  |---|---|
  | `open` | `open` |
  | `in_review` | `reviewing` |
  | `planned` | `unstarted` |
  | `in_progress` | `active` |
  | `completed` | `completed` |

  The default `all` skips the filter and returns every status.
- `sortBy` — `date:desc` (default), `date:asc`, or `upvotes:desc`.
- `limit` — 1–200, default 50.
- `hasAdminReply` — optional boolean. **Requires** a team identity (env var or `teamUserIds` override). If neither is set, the call throws `InvalidParams`.
- `teamUserIds` — optional string[] override for the team.

**Returns:** `{ totalResults, availableResults, truncated, returned, posts: NormalizedPost[] }`

**Behavior:**

- A normal listing call (no `hasAdminReply`) does **not** fetch comments and does **not** populate engagement metadata. It returns posts with `author.role === "unknown"` when no team is configured.
- When `hasAdminReply` is provided, comments are fetched for posts with `commentCount > 0` and engagement is computed under the team. Posts with `commentCount === 0` are treated as `hasAdminReply: false` (the team definitively has not replied) without a comment API request.

### `get_featurebase_post`

**Args:**

- `slug` — required (e.g. `more-byok-options`).
- `include_comments` — default `false`. When `true`, inlines the full comment thread as `comments: NormalizedComment[]`.
- `teamUserIds` — optional string[] override.

**Returns:** `{ ...NormalizedPost, contentHtml, contentText, comments?, commentsError? }`

`contentHtml` and `contentText` are always inlined. If the comments fetch fails, `commentsError` is set and the post is still returned.

When `teamUserIds` is supplied, both comment-author roles and engagement fields are reclassified against that team. A non-empty `teamUserIds` array **replaces** `FEATUREBASE_TEAM_USER_IDS` for that call only; an empty array `[]` is treated as absent (the env var is used if configured).

### `get_featurebase_posts` (batch)

**Args:** `slugs` (1–20), `include_content` (default `false`).

Returns posts in the order requested; missing slugs go into `notFound` rather than throwing. Set `include_content=true` to inline full body on each entry.

### `search_featurebase_posts`

**Args:** `query` (required), `limit` (1–50, default 10).

Returns posts ordered by relevance (title hit = 3 pts, body hit = 1 pt, per-token matches also weighted).

### `get_featurebase_stats`

**Args:** `topVotedLimit` (1–50, default 5), `recentLimit` (1–50, default 5).

**Returns:** `{ totalResults, snapshotSize, truncated, snapshotWindow, statusCountsInSnapshot, categoryCountsInSnapshot, topVoted[N], recent[N] }`

`snapshotWindow` is the actual date range currently in the in-memory snapshot — labels like `*InSnapshot` are explicit that these counts are over the snapshot, not over a complete board snapshot from a single source. The snapshot is built on demand from the public listing endpoint and is fresh as of the first fetch in the current process.

### `get_featurebase_stalled_promises`

**Args:**

- `minDaysSinceAdminReply` — 0–365, default 7.
- `limit` — 1–50, default 20.
- `teamUserIds` — optional string[] override.
- `status` — restrict candidates to one of these statuses.
- `sortBy` — `staleness` (default), `freshness`, or `upvotes`.

**Returns:** `{ minDaysSinceAdminReply, teamSource, warning?, unusedTeamUserIds?, unusedTeamUserIdsComplete?, totalCandidates, returned, promises: StalledPromise[] }`

`teamSource` is `"override"` (per-call team), `"default"` (env-var team), or `"none"` (no team — returns empty with a warning).

`unusedTeamUserIds` lists IDs you supplied that didn't appear in any comment thread. `unusedTeamUserIdsComplete: false` signals that some comment fetches failed and we couldn't fully determine unused IDs.

### `find_featurebase_user`

**Args:** `name` (≥2 chars, partial match), `sampleSize` (0–20, default 5).

**Returns:** `{ query, samplePostsScanned, commentsComplete, warning?, matches: UserMatch[] }`

`commentsComplete` is `true` only when every comment fetch for the index build succeeded; `false` means totals may undercount.

Each `UserMatch` carries `userId`, `name`, `postCount`, `commentCountInSampledPosts`, `totalCommentCount` (board-wide), and `guessedRole`.

## Known limitations

- **Reads only.** Posting comments, voting, changing status all require authenticated access to Featurebase — out of scope.
- **Designed for public boards.** Works on Remalt and on other public boards that expose the same public listing + comment endpoints. Boards with aggressive bot protection, sign-in walls, or non-standard layouts may not work.
- **No real-time updates.** The in-memory snapshot is fresh on first fetch in a given process and cached for 5 minutes. Restart the server to flush.
- **Admin role tagging requires team IDs.** Without `FEATUREBASE_TEAM_USER_IDS` (or a per-call `teamUserIds`), author roles are `"unknown"` and `hasAdminReply` filtering is refused.

## How it works (briefly)

1. The public board exposes `/api/v1/submission?…&page=N` (the SPA's axios `baseURL` is `/api`). The server calls page 1 to learn `totalPages` and `totalResults`, then fetches pages 2..N concurrently. **Listing pagination is atomic** — if any required page fails, the entire tool call surfaces the failure and no partial listing is cached or returned.
2. `/api/v1/comment?submissionId=<id>&page=N` returns the comment thread. **Comment pagination is also atomic** — a single failed page throws and is never cached as a partial thread.
3. Engagement fields (`hasAdminReply`, counts, dates) are computed from the classified comment tree. The cache is role-neutral: roles are derived per request against the active team set, never stored on the cached tree.

## Troubleshooting

**Listing fails with `Incomplete listing: failed pages N of M`**
The listing endpoint returned an error on one or more pages. The tool call surfaces this failure — no partial listing is returned or cached. Retry on the same client will refetch every listing page from scratch. This is by design (atomic contract).

**`engagementComplete: false` in a `list_featurebase_posts(hasAdminReply=…)` response**
Means one or more specific comment-thread fetches failed during engagement enrichment. The response includes `failedPostSlugs` listing which posts couldn't be classified. Posts that did succeed are still filtered correctly; only the affected posts get `commentFetchFailed: true` and are excluded from the filter result. Retry the request after a short delay.

**`commentsComplete: false` in `find_featurebase_user`**
At least one post's comments failed to fetch while building the board-wide user-count index. `totalCommentCount` for users who only appeared in failed threads may undercount. Retry after a short delay.

**All author roles show `"unknown"`**
No team is configured. Either set `FEATUREBASE_TEAM_USER_IDS` in the env, or use `find_featurebase_user` to discover IDs and pass them as `teamUserIds` per-call.

**`hasAdminReply` filter throws `InvalidParams`**
You asked for a team-based filter without providing a team. Set `FEATUREBASE_TEAM_USER_IDS` or pass `teamUserIds` to the call.

**`commentsError` is set on a `get_featurebase_post` response**
The post is still returned with its body and metadata; only the comments array is missing. Common causes: network error, rate limit, or the comment endpoint returning an unexpected shape.

## For contributors

If you want to develop on this:

```bash
git clone https://github.com/K-Jadeja/open-featurebase-mcp
cd open-featurebase-mcp
npm ci
npm run build
npm test         # 339 deterministic checks; no live network
npm start        # launches the stdio server
```

The default `npm test` is fully offline (mock fetcher fixtures). A separate `npm run test:live` runs against a live Featurebase endpoint and is opt-in.

## License

MIT
