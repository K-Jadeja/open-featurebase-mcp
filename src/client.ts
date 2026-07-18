/**
 * FeaturebaseClient
 *
 * Reverse-engineered scraper for public Featurebase boards.
 *
 * Strategy: the public board is a Next.js SPA. Every page embeds its data
 * inside `<script id="__NEXT_DATA__" type="application/json">...</script>`.
 * We regex the script tag, JSON.parse, and normalize. No DOM scraping, no
 * cheerio — the data is already JSON.
 *
 * Requires a desktop User-Agent. Raw `curl` without one gets 404 on
 * `/posts/<slug>` pages (verified).
 *
 * Public boards only. Auth-gated content is unreachable.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type {
  CommentRole,
  NormalizedAuthor,
  NormalizedComment,
  NormalizedPost,
  NormalizedPostDetail,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (
  process.env.FEATUREBASE_BOARD_URL ?? "https://itsremalt.featurebase.app"
).replace(/\/+$/, "");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 15_000;

const TTL = {
  listing: 300, // 5 min — covers all metadata reads
  comments: 300, // 5 min — matches listing so engagement views stay consistent
  org: 3600, // 1 hour — org membership rarely changes
} as const;

/**
 * Comma-separated Featurebase user IDs considered team/admin for role tagging.
 *
 * Falls back to empty when unset. Note: `/api/v1/organization.admins[]`
 * is the org OWNER, not necessarily the team that comments on the board.
 * Set this env var to the user IDs of your team so the comment author
 * `role` field lights up correctly. IDs are visible in any post's author
 * `.userId` or any comment's author `.userId`.
 */
const TEAM_USER_IDS: Set<string> = new Set(
  (process.env.FEATUREBASE_TEAM_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// ---------------------------------------------------------------------------
// Cache (Map + timestamps; 2 keys total so no class needed)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: unknown;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function cacheGet<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e || Date.now() > e.expires) {
    cache.delete(key);
    return null;
  }
  return e.data as T;
}

function cacheSet(key: string, data: unknown, ttlSec: number): void {
  cache.set(key, { data, expires: Date.now() + ttlSec * 1000 });
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

/**
 * Convert HTML to plain text. Cheap, no parser — strips tags + decodes
 * common entities. Good enough for excerpts and full-body text.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeStatus(raw: any): NormalizedPost["status"] {
  return {
    name: raw?.name ?? "Unknown",
    type: raw?.type ?? "unknown",
    color: raw?.color ?? "",
  };
}

/**
 * Build the basic author shape (no role yet). Role is assigned separately
 * by `enrichAuthor` once the team-user-id set is available.
 */
function normalizeAuthorBasic(raw: any): Omit<NormalizedAuthor, "role"> {
  return {
    name: raw?.name ?? "Anonymous",
    picture: raw?.picture,
    userId: raw?._id ?? raw?.createdBy ?? "",
  };
}

/**
 * Effective team set for this MCP run. Defaults to ONLY the
 * `FEATUREBASE_TEAM_USER_IDS` env var.
 *
 * We deliberately do NOT include `/api/v1/organization.admins` — that field
 * holds the org OWNER, not the team that comments on the board. Including
 * it would make the team set look "configured" (non-empty) while classifying
 * actual team comments as `role: "customer"`. Use the env var for correct
 * role tagging, or pass `teamUserIds` per-call to engagement-bearing tools
 * after calling `find_featurebase_user`.
 *
 * `configured: false` ⇒ role tagging skipped, engagement fields omitted.
 */
async function getEffectiveTeamSet(): Promise<{
  set: ReadonlySet<string>;
  configured: boolean;
}> {
  return { set: TEAM_USER_IDS, configured: TEAM_USER_IDS.size > 0 };
}

/**
 * Decide role for an author by user ID.
 * - "admin" if team is configured AND userId is in the set
 * - "customer" if team is configured but userId is not in the set
 * - "unknown" if no team is configured at all (we cannot tell)
 *
 * The "unknown" path is the loud-failure contract: rather than lie with
 * "customer" when we have no basis for classification, we expose the gap.
 */
function enrichAuthor(
  base: Omit<NormalizedAuthor, "role">,
  team: { set: ReadonlySet<string>; configured: boolean },
): NormalizedAuthor {
  let role: CommentRole;
  if (!team.configured) {
    role = "unknown";
  } else if (team.set.has(base.userId)) {
    role = "admin";
  } else {
    role = "customer";
  }
  return { ...base, role };
}

function normalizeCategory(raw: any): string {
  if (!raw) return "Uncategorized";
  if (typeof raw === "string") return raw;
  if (typeof raw.name === "string") return raw.name;
  if (raw.name && typeof raw.name.en === "string") return raw.name.en;
  return "Uncategorized";
}

function normalizePost(
  raw: any,
  team: { set: ReadonlySet<string>; configured: boolean },
): NormalizedPost {
  const fullText = htmlToText(raw.content ?? "");
  const EXCERPT_LIMIT = 800;
  const truncated = fullText.length > EXCERPT_LIMIT;
  return {
    slug: raw.slug,
    id: raw.id ?? "",
    title: raw.title,
    excerpt: truncated
      ? fullText.slice(0, EXCERPT_LIMIT).trimEnd() + "…"
      : fullText,
    url: `${BASE_URL}/posts/${raw.slug}`,
    status: normalizeStatus(raw.postStatus),
    upvotes: raw.upvotes ?? 0,
    commentCount: raw.commentCount ?? 0,
    author: enrichAuthor(normalizeAuthorBasic(raw.user), team),
    date: raw.date ?? "",
    category: normalizeCategory(raw.postCategory),
    // Engagement fields are NOT initialized here — getAllPosts merges them
    // in only when (a) the team is configured and (b) comments fetch
    // succeeds. Omission is the loud-failure contract for "no team IDs."
  };
}

function normalizeComment(
  raw: any,
  team: { set: ReadonlySet<string>; configured: boolean },
): NormalizedComment {
  return {
    id: raw.id,
    author: enrichAuthor(normalizeAuthorBasic(raw.user), team),
    bodyHtml: raw.content ?? "",
    bodyText: htmlToText(raw.content ?? ""),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
    upvotes: raw.upvotes ?? 0,
    parentId: raw.parentComment ?? null,
    replies: Array.isArray(raw.replies)
      ? raw.replies.map((r: any) => normalizeComment(r, team))
      : [],
  };
}

// ---------------------------------------------------------------------------
// Listing fetch (cached, single source of truth for all 4 tools' metadata)
//
// Strategy: hit the internal paginated API at `/api/v1/submission?page=N`
// directly. The SPA's axios baseURL is `/api` (relative). Endpoint is public
// — no auth, no CSRF required for read.
//
// Response shape per page: { results, page, limit, totalPages, totalResults }
// - Default page size: 10 (set by Featurebase)
// - We always request `sortBy=date:desc` to match what the SSR bundles; sort/
//   filter happen client-side so cache stays valid across all sort orders.
// - We use Promise.allSettled so a partial failure doesn't kill the whole
//   request — degraded responses still surface via `truncated: true`.
// ---------------------------------------------------------------------------

interface ListingPayload {
  raw: any[];
  normalized: NormalizedPost[];
  totalResults: number;
  availableResults: number;
  /**
   * userId → total number of comments authored across all threads on the
   * board. Computed once during the engagement enrichment loop so
   * find_featurebase_user can return board-wide `totalCommentCount`
   * without an extra pass.
   */
  commentCountByUserId: Map<string, number>;
}

interface ApiPage {
  results: any[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

async function fetchApiPage(page: number): Promise<ApiPage> {
  const url = `${BASE_URL}/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=${page}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: `${BASE_URL}/`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `HTTP ${res.status} fetching page ${page} from /api/v1/submission`,
      );
    }
    const data = (await res.json()) as ApiPage;
    if (!Array.isArray(data.results)) {
      throw new McpError(
        ErrorCode.InternalError,
        `Unexpected /api/v1/submission response shape on page ${page}: missing results array`,
      );
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getAllPosts(): Promise<ListingPayload> {
  const cacheKey = "list:all";
  const cached = cacheGet<ListingPayload>(cacheKey);
  if (cached) return cached;

  // Fetch page 1 + org admin set in parallel. Both are needed to build the
  // listing payload: page 1 discovers totalPages, the org set combines
  // with FEATUREBASE_TEAM_USER_IDS to form the team set for role tagging.
  const [first, team] = await Promise.all([
    fetchApiPage(1),
    getEffectiveTeamSet(),
  ]);
  const totalPages = first.totalPages;
  const totalResults = first.totalResults;

  // Fetch remaining pages in parallel. allSettled so a failure on one page
  // doesn't take down the whole listing.
  const rest = await Promise.allSettled(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      fetchApiPage(i + 2),
    ),
  );
  const successfulPages: ApiPage[] = [first];
  for (const r of rest) {
    if (r.status === "fulfilled") successfulPages.push(r.value);
  }

  const raw = successfulPages.flatMap((p) => p.results);
  const normalized = raw.map((r) => normalizePost(r, team));

  // Engagement enrichment ONLY when (a) team is configured and (b) the
  // post has comments. Per-post failures set commentFetchFailed rather
  // than failing the whole listing. When team is not configured we
  // deliberately skip this so the response loudly omits engagement fields
  // instead of computing them against an empty team (which would mark
  // every comment as "customer" — silent corruption).
  // Always fetch comments for posts that have any — needed for both the
  // board-wide per-user comment count (used by find_featurebase_user)
  // AND the engagement-enrichment pass. Engagement CLASSIFICATION only
  // happens when team is configured, but comment COUNTING happens always.
  const commentCountByUserId = new Map<string, number>();
  const engagementByPostId = new Map<string, EngagementFields>();
  const failedPostIds = new Set<string>();
  const rawWithComments = raw.filter((r) => (r.commentCount ?? 0) > 0);
  if (rawWithComments.length > 0) {
    const fetched = await mapWithConcurrency(
      rawWithComments,
      COMMENTS_CONCURRENCY,
      async (r) => {
        try {
          const comments = await getComments(r.id);
          const engagement = team.configured
            ? computeEngagement(comments)
            : null;
          return { id: r.id, engagement, comments };
        } catch (err) {
          console.error(
            `[featurebase-mcp] comments fetch failed for ${r.slug}:`,
            err,
          );
          return { id: r.id, engagement: null, comments: [] as NormalizedComment[] };
        }
      },
    );
    for (const { id, engagement, comments } of fetched) {
      if (engagement) engagementByPostId.set(id, engagement);
      else failedPostIds.add(id);
      // Build board-wide per-author comment count while comments are
      // already loaded — used by find_featurebase_user.totalCommentCount.
      walkComments(comments, (c) => {
        commentCountByUserId.set(
          c.author.userId,
          (commentCountByUserId.get(c.author.userId) ?? 0) + 1,
        );
      });
    }
    for (const post of normalized) {
      const eng = engagementByPostId.get(post.id);
      if (eng) Object.assign(post, eng);
      else if (failedPostIds.has(post.id)) post.commentFetchFailed = true;
    }
  }

  const out: ListingPayload = {
    raw,
    normalized,
    totalResults,
    availableResults: raw.length,
    commentCountByUserId,
  };
  cacheSet(cacheKey, out, TTL.listing);
  return out;
}

// ---------------------------------------------------------------------------
// Organization + comments fetchers
//
// The Featurebase SPA exposes the JSON endpoints the client components call:
//
//   GET /api/v1/organization
//     → { admins: string[], owner: string, members: [...], ... }
//     admins[] holds user IDs of org admins (typically the org OWNER only).
//     Cached 1h; membership rarely changes.
//
//   GET /api/v1/comment?submissionId=<id>
//     → { results: [Comment], page, limit, totalPages, totalResults }
//     Top-level comments only; nested replies live on each comment's
//     `replies` array. Threading is preserved server-side, so we don't have
//     to rebuild the tree from a flat list.
//
//   Submission IDs are NOT the same as slugs. The slug is the URL path
//   segment (`/posts/<slug>`); the submission ID is the DB `_id` (or `id`
//   in listing payloads — they're equal here). To fetch comments for a
//   post by slug, look up the slug in the listing payload first.
// ---------------------------------------------------------------------------

interface OrgPayload {
  admins: string[];
  owner: string | null;
}

async function fetchOrg(): Promise<OrgPayload> {
  const url = `${BASE_URL}/api/v1/organization`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: `${BASE_URL}/`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `HTTP ${res.status} fetching ${url}`,
      );
    }
    const data = (await res.json()) as any;
    return {
      admins: Array.isArray(data?.admins) ? data.admins : [],
      owner: typeof data?.owner === "string" ? data.owner : null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getOrgAdminIds(): Promise<Set<string>> {
  const cacheKey = "org:admins";
  const cached = cacheGet<Set<string>>(cacheKey);
  if (cached) return cached;
  try {
    const org = await fetchOrg();
    const set = new Set<string>(org.admins);
    cacheSet(cacheKey, set, TTL.org);
    return set;
  } catch (err) {
    // Don't break the whole listing because the org endpoint hiccupped.
    // Role tagging will degrade to "customer" for everyone.
    console.error(
      "[featurebase-mcp] failed to fetch /api/v1/organization; " +
        "falling back to empty admin set. Set FEATUREBASE_TEAM_USER_IDS " +
        "to override. Error:",
      err,
    );
    const empty: Set<string> = new Set();
    cacheSet(cacheKey, empty, TTL.org);
    return empty;
  }
}

interface CommentsApiResponse {
  results: any[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

async function fetchCommentsPage(
  submissionId: string,
  page: number,
): Promise<CommentsApiResponse> {
  const url =
    `${BASE_URL}/api/v1/comment?submissionId=${encodeURIComponent(submissionId)}` +
    `&page=${page}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
        Referer: `${BASE_URL}/posts/`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `HTTP ${res.status} fetching comments for submission ${submissionId}`,
      );
    }
    const data = (await res.json()) as CommentsApiResponse;
    if (!Array.isArray(data.results)) {
      throw new McpError(
        ErrorCode.InternalError,
        `Unexpected /api/v1/comment response shape: missing results array`,
      );
    }
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch all pages of the comment thread for a submission, normalized to a
 * tree (top-level comments + nested replies). Returns [] if the post has no
 * comments.
 */
async function getComments(submissionId: string): Promise<NormalizedComment[]> {
  if (!submissionId) return [];
  const cacheKey = `comments:${submissionId}`;
  const cached = cacheGet<NormalizedComment[]>(cacheKey);
  if (cached) return cached;

  const team = await getEffectiveTeamSet();

  const first = await fetchCommentsPage(submissionId, 1);
  const totalPages = first.totalPages;
  const rest = await Promise.allSettled(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      fetchCommentsPage(submissionId, i + 2),
    ),
  );
  const allRaw = [
    ...first.results,
    ...rest
      .filter((r): r is PromiseFulfilledResult<CommentsApiResponse> => r.status === "fulfilled")
      .flatMap((r) => r.value.results),
  ];

  // The server nests replies inside each top-level comment's `replies`
  // array; the flat `results` array contains only top-level comments when
  // pagination > 1. We pass the team set into the recursive normalizer so
  // every nested reply's author gets a role tag (or "unknown" when no
  // team is configured).
  const tree = allRaw.map((r) => normalizeComment(r, team));

  // Sort replies within each node by createdAt asc, and roots too.
  function sortReplies(node: NormalizedComment): void {
    node.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of node.replies) sortReplies(r);
  }
  for (const root of tree) sortReplies(root);
  tree.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  cacheSet(cacheKey, tree, TTL.comments);
  return tree;
}

// ---------------------------------------------------------------------------
// Engagement enrichment
//
// For each post with commentCount > 0, walk its comment thread once and
// produce engagement metadata. Used to surface "team has replied", "last
// admin reply is older than last customer comment", etc., on the listing
// without forcing agents to fetch each post in detail.
// ---------------------------------------------------------------------------

interface EngagementFields {
  hasAdminReply: boolean;
  adminReplyCount: number;
  customerCommentCount: number;
  lastCommentDate?: string;
  adminLastReplyDate?: string;
  customerLastReplyDate?: string;
}

function computeEngagement(comments: NormalizedComment[]): EngagementFields {
  let hasAdminReply = false;
  let adminReplyCount = 0;
  let customerCommentCount = 0;
  let lastCommentDate: string | undefined;
  let adminLastReplyDate: string | undefined;
  let customerLastReplyDate: string | undefined;

  function walk(comment: NormalizedComment): void {
    if (!lastCommentDate || comment.createdAt > lastCommentDate) {
      lastCommentDate = comment.createdAt;
    }
    if (comment.author.role === "admin") {
      hasAdminReply = true;
      adminReplyCount++;
      if (!adminLastReplyDate || comment.createdAt > adminLastReplyDate) {
        adminLastReplyDate = comment.createdAt;
      }
    } else {
      customerCommentCount++;
      if (!customerLastReplyDate || comment.createdAt > customerLastReplyDate) {
        customerLastReplyDate = comment.createdAt;
      }
    }
    for (const reply of comment.replies) walk(reply);
  }

  for (const c of comments) walk(c);
  return {
    hasAdminReply,
    adminReplyCount,
    customerCommentCount,
    lastCommentDate,
    adminLastReplyDate,
    customerLastReplyDate,
  };
}

/**
 * Promise.all with a concurrency cap. `fn` is invoked sequentially within
 * each worker; workers run in parallel. Used to fetch comment threads for
 * every post that has any comments without hammering the API.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Max parallel comment fetches during listing enrichment. */
const COMMENTS_CONCURRENCY = 8;

/**
 * Walk a comment tree and return the chronologically last comment by an
 * author with the given role. Returns null if no comment matches.
 */
function findLastCommentByRole(
  comments: NormalizedComment[],
  role: CommentRole,
): NormalizedComment | null {
  let last: NormalizedComment | null = null;
  function walk(c: NormalizedComment): void {
    if (c.author.role === role) {
      if (!last || c.createdAt > last.createdAt) last = c;
    }
    for (const r of c.replies) walk(r);
  }
  for (const c of comments) walk(c);
  return last;
}

/**
 * Walk a comment tree and return the chronologically last comment for
 * which `predicate` returns true. Used when the team set is overridden at
 * call time — we can't use `author.role` (it's stale relative to the
 * override), so we ask the caller to provide the membership test.
 */
function findLastCommentWhere(
  comments: NormalizedComment[],
  predicate: (c: NormalizedComment) => boolean,
): NormalizedComment | null {
  let last: NormalizedComment | null = null;
  function walk(c: NormalizedComment): void {
    if (predicate(c)) {
      if (!last || c.createdAt > last.createdAt) last = c;
    }
    for (const r of c.replies) walk(r);
  }
  for (const c of comments) walk(c);
  return last;
}

/**
 * Apply a per-call team-user-id override to a comment tree. The cached
 * `author.role` was computed using the server's default team set (env var
 * + /api/v1/organization admins); when the caller passes a runtime
 * override we re-classify each comment's author on the fly. Used by
 * getStalledPromises so a single call can re-tag engagement.
 *
 * When `trackMatchedIds` is provided, every userId that the override set
 * matched against is recorded — used to surface unusedTeamUserIds.
 */
function computeEngagementWithTeamOverride(
  comments: NormalizedComment[],
  teamSet: ReadonlySet<string>,
  trackMatchedIds?: Set<string>,
): EngagementFields {
  let hasAdminReply = false;
  let adminReplyCount = 0;
  let customerCommentCount = 0;
  let lastCommentDate: string | undefined;
  let adminLastReplyDate: string | undefined;
  let customerLastReplyDate: string | undefined;

  function walk(comment: NormalizedComment): void {
    const isAdmin = teamSet.has(comment.author.userId);
    if (isAdmin && trackMatchedIds) trackMatchedIds.add(comment.author.userId);
    if (!lastCommentDate || comment.createdAt > lastCommentDate) {
      lastCommentDate = comment.createdAt;
    }
    if (isAdmin) {
      hasAdminReply = true;
      adminReplyCount++;
      if (!adminLastReplyDate || comment.createdAt > adminLastReplyDate) {
        adminLastReplyDate = comment.createdAt;
      }
    } else {
      customerCommentCount++;
      if (!customerLastReplyDate || comment.createdAt > customerLastReplyDate) {
        customerLastReplyDate = comment.createdAt;
      }
    }
    for (const reply of comment.replies) walk(reply);
  }

  for (const c of comments) walk(c);
  return {
    hasAdminReply,
    adminReplyCount,
    customerCommentCount,
    lastCommentDate,
    adminLastReplyDate,
    customerLastReplyDate,
  };
}

/**
 * Visit every comment in a tree (top-level + nested replies). Used by
 * find_featurebase_user to scan authors across all threads.
 */
function walkComments(
  comments: NormalizedComment[],
  fn: (c: NormalizedComment) => void,
): void {
  for (const c of comments) {
    fn(c);
    walkComments(c.replies, fn);
  }
}

/**
 * Return a new comment tree with each author's role re-classified using
 * the provided team set. Used by get_featurebase_post when teamUserIds
 * is passed at call time to override the default team.
 */
function reclassifyTree(
  comments: NormalizedComment[],
  team: { set: ReadonlySet<string>; configured: boolean },
): NormalizedComment[] {
  return comments.map((c) => ({
    ...c,
    author: enrichAuthor(
      { name: c.author.name, picture: c.author.picture, userId: c.author.userId },
      team,
    ),
    replies: reclassifyTree(c.replies, team),
  }));
}

// ---------------------------------------------------------------------------
// Public client surface
// ---------------------------------------------------------------------------

export interface ListPostsArgs {
  status: "all" | "open" | "in_review" | "planned" | "in_progress" | "completed";
  sortBy: "date:desc" | "date:asc" | "upvotes:desc";
  limit: number;
  hasAdminReply?: boolean;
}

export interface SearchPostsArgs {
  query: string;
  limit: number;
}

export interface GetPostsArgs {
  slugs: string[];
  include_content?: boolean;
}

// Featurebase postStatus.type values mapped from user-friendly enum names.
// Verified against all 56 posts on 2026-07-16:
//   "In Review"   → "reviewing"
//   "Planned"     → "unstarted"
//   "In Progress" → "active"
//   "Completed"   → "completed"
// "Open" exists in some boards as the default state for newly-created posts;
// we map it to "open" defensively even though this board has no such posts.
const STATUS_TYPE_MAP: Record<
  Exclude<ListPostsArgs["status"], "all">,
  string
> = {
  open: "open",
  in_review: "reviewing",
  planned: "unstarted",
  in_progress: "active",
  completed: "completed",
};

function sortPosts(
  posts: NormalizedPost[],
  sortBy: ListPostsArgs["sortBy"],
): NormalizedPost[] {
  const sorted = [...posts];
  switch (sortBy) {
    case "date:desc":
      sorted.sort((a, b) => b.date.localeCompare(a.date));
      break;
    case "date:asc":
      sorted.sort((a, b) => a.date.localeCompare(b.date));
      break;
    case "upvotes:desc":
      sorted.sort((a, b) => b.upvotes - a.upvotes);
      break;
  }
  return sorted;
}

export const client = {
  async listPosts(args: ListPostsArgs) {
    const all = await getAllPosts();
    let posts = all.normalized;

    if (args.status !== "all") {
      const want = STATUS_TYPE_MAP[args.status];
      posts = posts.filter((p) => p.status.type === want);
    }

    if (args.hasAdminReply !== undefined) {
      // hasAdminReply is only present when (team configured + comments
      // fetched); absent otherwise. The filter compares against the literal
      // boolean — a post with hasAdminReply undefined never matches when
      // args.hasAdminReply is true, which is the loud-failure contract
      // (filtering on data we don't have should return nothing).
      posts = posts.filter(
        (p) => (p.hasAdminReply ?? null) === args.hasAdminReply,
      );
    }

    posts = sortPosts(posts, args.sortBy).slice(0, args.limit);

    return {
      totalResults: all.totalResults,
      /** Posts available in this snapshot (≤ totalResults due to SSR bundling). */
      availableResults: all.availableResults,
      /** Whether the SSR snapshot is missing some posts from the full board. */
      truncated: all.availableResults < all.totalResults,
      returned: posts.length,
      posts,
    };
  },

  async getPost(
    slug: string,
    includeComments: boolean,
    teamUserIds?: string[],
  ): Promise<NormalizedPostDetail> {
    const all = await getAllPosts();
    const post = all.normalized.find((p) => p.slug === slug);
    if (!post) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Post not found: "${slug}". Use list_featurebase_posts to discover valid slugs.`,
      );
    }
    const raw = all.raw.find((p) => p.slug === slug)!;
    const contentHtml = raw.content ?? "";
    const contentText = htmlToText(contentHtml);

    const teamOverride =
      teamUserIds && teamUserIds.length > 0
        ? { set: new Set(teamUserIds), configured: true }
        : null;

    // Re-classify engagement fields on the post under the override team, if
    // the post has comments and comments are available (cached after first
    // listing miss). Always best-effort — if comments are missing or fetch
    // fails, fall back to the listing's pre-computed engagement.
    let postWithOverride: NormalizedPost = post;
    if (
      teamOverride &&
      post.commentCount > 0 &&
      !post.commentFetchFailed
    ) {
      try {
        const comments = await getComments(post.id);
        const eng = computeEngagementWithTeamOverride(
          comments,
          teamOverride.set,
        );
        postWithOverride = { ...post, ...eng };
      } catch (err) {
        console.error(
          `[featurebase-mcp] getPost: engagement re-classify failed for ${slug}:`,
          err,
        );
      }
    }

    if (!includeComments) {
      return { ...postWithOverride, contentHtml, contentText };
    }

    let comments: NormalizedComment[] | undefined;
    let commentsError: string | undefined;
    try {
      const rawComments = await getComments(post.id);
      comments = teamOverride
        ? reclassifyTree(rawComments, teamOverride)
        : rawComments;
    } catch (err) {
      // Don't fail the post fetch because comments broke. Surface the error
      // so the agent can decide what to do, but keep the post intact.
      commentsError = err instanceof Error ? err.message : String(err);
      console.error(
        `[featurebase-mcp] comments fetch failed for ${slug}:`,
        err,
      );
    }
    return {
      ...postWithOverride,
      contentHtml,
      contentText,
      comments,
      commentsError,
    };
  },

  async searchPosts(args: SearchPostsArgs) {
    const all = await getAllPosts();
    const q = args.query.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);

    type Hit = { post: NormalizedPost; score: number };
    const hits: Hit[] = [];

    for (let i = 0; i < all.normalized.length; i++) {
      const post = all.normalized[i];
      const raw = all.raw[i];
      const titleLower = post.title.toLowerCase();
      const bodyText = htmlToText(raw.content ?? "").toLowerCase();

      let score = 0;
      // Title hit (full query)
      if (titleLower.includes(q)) score += 3;
      // Body hit (full query)
      if (bodyText.includes(q)) score += 1;
      // Per-token scoring (any token hit contributes)
      for (const t of tokens) {
        if (t === q) continue; // already counted
        if (titleLower.includes(t)) score += 2;
        if (bodyText.includes(t)) score += 1;
      }

      if (score > 0) hits.push({ post, score });
    }

    hits.sort((a, b) => b.score - a.score);
    const sliced = hits.slice(0, args.limit).map((h) => h.post);

    return {
      query: args.query,
      totalMatches: hits.length,
      returned: sliced.length,
      posts: sliced,
    };
  },

  async getStats(args: {
    topVotedLimit?: number;
    recentLimit?: number;
  } = {}) {
    const all = await getAllPosts();
    const topLimit = Math.max(1, Math.min(args.topVotedLimit ?? 5, 50));
    const recentLimit = Math.max(1, Math.min(args.recentLimit ?? 5, 50));

    // Counts are computed over the SSR-bundled snapshot (snapshotSize),
    // NOT the full board (totalResults). When truncated is true, the snapshot
    // is missing posts — counts reflect only what we have.
    const statusCountsInSnapshot: Record<string, number> = {};
    const categoryCountsInSnapshot: Record<string, number> = {};

    for (const post of all.normalized) {
      statusCountsInSnapshot[post.status.name] =
        (statusCountsInSnapshot[post.status.name] ?? 0) + 1;
      categoryCountsInSnapshot[post.category] =
        (categoryCountsInSnapshot[post.category] ?? 0) + 1;
    }

    // Snapshot window: the actual date range the SSR snapshot covers, plus the
    // ordering it was bundled in (currently "date desc" per Featurebase).
    const dates = all.normalized
      .map((p) => p.date)
      .filter((d) => d)
      .sort();
    const snapshotWindow =
      dates.length > 0
        ? {
            from: dates[0].slice(0, 10),
            to: dates[dates.length - 1].slice(0, 10),
            ordering: "date desc" as const,
          }
        : null;

    const topVoted = [...all.normalized]
      .sort((a, b) => b.upvotes - a.upvotes)
      .slice(0, topLimit)
      .map((p) => ({ slug: p.slug, title: p.title, upvotes: p.upvotes }));

    const recent = [...all.normalized]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, recentLimit)
      .map((p) => ({ slug: p.slug, title: p.title, date: p.date }));

    return {
      /** Total posts on the board per Featurebase (may exceed snapshot). */
      totalResults: all.totalResults,
      /** Posts in the SSR snapshot we actually have. Counts reflect this. */
      snapshotSize: all.availableResults,
      /** Whether snapshotSize < totalResults. When true, counts are partial. */
      truncated: all.availableResults < all.totalResults,
      /** Date range the snapshot covers. Null if snapshot is empty. */
      snapshotWindow,
      /** Echoed params so callers can confirm what they got (defensive if ignored). */
      topVotedLimit: topLimit,
      recentLimit,
      statusCountsInSnapshot,
      categoryCountsInSnapshot,
      topVoted,
      recent,
    };
  },

  /**
   * Find posts where an admin replied and the customer spoke last, and the
   * admin has been silent for at least `minDaysSinceAdminReply` days.
   *
   * This is the "I promised something in a comment and forgot to follow up"
   * view. Sorted by customerLastReplyDate desc (most recent first).
   *
   * Requires the engagement metadata populated by getAllPosts — both
   * adminLastReplyDate and customerLastReplyDate must be set (i.e. comment
   * fetch succeeded for the post). When `teamUserIds` is passed, those
   * IDs override the server's default team set (env var +
   * /api/v1/organization admins) and engagement is re-classified on the
   * fly from cached comments. Use this in tandem with
   * `find_featurebase_user` to skip env-var configuration entirely.
   */
  async getStalledPromises(args: {
    minDaysSinceAdminReply?: number;
    limit?: number;
    teamUserIds?: string[];
    status?: Array<
      "open" | "in_review" | "planned" | "in_progress" | "completed"
    >;
    sortBy?: "staleness" | "freshness" | "upvotes";
  } = {}) {
    const minDays = Math.max(0, Math.floor(args.minDaysSinceAdminReply ?? 7));
    const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
    const sortBy = args.sortBy ?? "staleness";
    const all = await getAllPosts();
    const now = Date.now();
    const minMs = minDays * 24 * 60 * 60 * 1000;

    // Map user-friendly status enum → internal postStatus.type. Same mapping
    // as STATUS_TYPE_MAP but built locally so this tool doesn't depend on
    // listing internals.
    const wantedTypes = new Set<string>();
    for (const friendly of args.status ?? []) {
      const mapped = STATUS_TYPE_MAP[friendly];
      if (mapped) wantedTypes.add(mapped);
    }

    const teamOverride =
      args.teamUserIds && args.teamUserIds.length > 0
        ? new Set(args.teamUserIds)
        : null;
    const teamSource: "override" | "default" = teamOverride ? "override" : "default";

    // When using the default team set, check that the server actually has
    // team IDs configured. If not (env var empty AND no team IDs known),
    // engagement fields are absent from the listing and we would silently
    // return totalCandidates: 0. Surface the gap so the agent knows to
    // call find_featurebase_user.
    let warning: string | undefined;
    let unusedTeamUserIds: string[] | undefined;
    if (!teamOverride) {
      const team = await getEffectiveTeamSet();
      if (!team.configured) {
        warning =
          "No team IDs configured — stalled-promise detection requires knowing who your team is. " +
          "Call find_featurebase_user with your name to discover your user ID, then pass the " +
          "returned userIds as teamUserIds. Alternatively set FEATUREBASE_TEAM_USER_IDS env var.";
      }
    }

    // If a team override is in play, re-classify engagement from cached
    // comments using the override set; otherwise use the pre-computed
    // engagement on each post (from the listing enrichment).
    let candidates: Array<NormalizedPost & Partial<EngagementFields>>;
    if (teamOverride) {
      const withComments = all.normalized.filter(
        (p) => !p.commentFetchFailed && p.commentCount > 0,
      );
      // Track which override IDs actually appeared in any comment walk so
      // we can flag unused ones (the "fake-id" silent-filter bug).
      const matchedIds = new Set<string>();
      const recomputed = await mapWithConcurrency(
        withComments,
        COMMENTS_CONCURRENCY,
        async (p) => {
          try {
            const comments = await getComments(p.id);
            const eng = computeEngagementWithTeamOverride(
              comments,
              teamOverride,
              matchedIds,
            );
            return { p, eng };
          } catch (err) {
            console.error(
              `[featurebase-mcp] stalled-promises: re-classify failed for ${p.slug}:`,
              err,
            );
            return null;
          }
        },
      );
      candidates = recomputed
        .filter((x): x is { p: NormalizedPost; eng: EngagementFields } => !!x)
        .map(({ p, eng }) => ({ ...p, ...eng }));

      // Any override ID that didn't show up in any comment is "unused".
      // Could be a fake ID, or a real user who just never commented.
      const unused = [...teamOverride].filter((id) => !matchedIds.has(id));
      if (unused.length > 0) unusedTeamUserIds = unused;
    } else {
      candidates = all.normalized.filter((p) => !p.commentFetchFailed);
    }

    const stalled = candidates.filter((p) => {
      if (!p.adminLastReplyDate || !p.customerLastReplyDate) return false;
      if (p.customerLastReplyDate <= p.adminLastReplyDate) return false;
      if (now - new Date(p.adminLastReplyDate).getTime() < minMs) return false;
      if (wantedTypes.size > 0 && !wantedTypes.has(p.status.type)) return false;
      return true;
    });
    stalled.sort((a, b) => {
      switch (sortBy) {
        case "freshness":
          return (b.adminLastReplyDate ?? "").localeCompare(
            a.adminLastReplyDate ?? "",
          );
        case "upvotes":
          return b.upvotes - a.upvotes;
        case "staleness":
        default:
          return (b.customerLastReplyDate ?? "").localeCompare(
            a.customerLastReplyDate ?? "",
          );
      }
    });

    const sliced = stalled.slice(0, limit);

    // For each candidate, fetch the full comment thread (cache hit if
    // already loaded during listing enrichment) to extract the actual
    // messages. If a team override is in play, also re-find the last
    // admin/customer messages under the override team.
    const enriched = await mapWithConcurrency(
      sliced,
      COMMENTS_CONCURRENCY,
      async (p) => {
        let lastAdminMsg: {
          author: { name: string; userId: string; role: CommentRole };
          date: string;
          excerpt: string;
        } | null = null;
        let lastCustomerMsg: {
          author: { name: string; userId: string; role: CommentRole };
          date: string;
          excerpt: string;
        } | null = null;
        try {
          const comments = await getComments(p.id);
          const lastAdmin =
            teamOverride
              ? findLastCommentWhere(comments, (c) => teamOverride.has(c.author.userId))
              : findLastCommentByRole(comments, "admin");
          const lastCustomer =
            teamOverride
              ? findLastCommentWhere(comments, (c) => !teamOverride.has(c.author.userId))
              : findLastCommentByRole(comments, "customer");
          if (lastAdmin) {
            lastAdminMsg = {
              author: {
                name: lastAdmin.author.name,
                userId: lastAdmin.author.userId,
                role: teamOverride
                  ? teamOverride.has(lastAdmin.author.userId)
                    ? "admin"
                    : "customer"
                  : lastAdmin.author.role,
              },
              date: lastAdmin.createdAt,
              excerpt: lastAdmin.bodyText.slice(0, 200),
            };
          }
          if (lastCustomer) {
            lastCustomerMsg = {
              author: {
                name: lastCustomer.author.name,
                userId: lastCustomer.author.userId,
                role: teamOverride
                  ? teamOverride.has(lastCustomer.author.userId)
                    ? "admin"
                    : "customer"
                  : lastCustomer.author.role,
              },
              date: lastCustomer.createdAt,
              excerpt: lastCustomer.bodyText.slice(0, 200),
            };
          }
        } catch (err) {
          console.error(
            `[featurebase-mcp] stalled-promises: comments fetch failed for ${p.slug}:`,
            err,
          );
        }
        return {
          slug: p.slug,
          title: p.title,
          url: p.url,
          status: p.status,
          commentCount: p.commentCount,
          upvotes: p.upvotes,
          author: p.author,
          date: p.date,
          adminLastReplyDate: p.adminLastReplyDate!,
          customerLastReplyDate: p.customerLastReplyDate!,
          daysSinceAdminReply: Math.floor(
            (now - new Date(p.adminLastReplyDate!).getTime()) /
              (24 * 60 * 60 * 1000),
          ),
          lastAdminMessage: lastAdminMsg,
          lastCustomerMessage: lastCustomerMsg,
        };
      },
    );

    return {
      minDaysSinceAdminReply: minDays,
      teamSource,
      warning,
      unusedTeamUserIds,
      totalCandidates: stalled.length,
      returned: enriched.length,
      promises: enriched,
    };
  },

  /**
   * Look up user IDs by partial name match. Scans post authors (always
   * available from the listing) plus the comment threads of the N most
   * recent posts that have any comments (default 5). Each match includes
   * a `guessedRole`:
   *   - "admin" if the user never posts but does comment (likely team)
   *   - "customer" otherwise
   *
   * Returns sorted by commentCount desc (the most active commenters
   * surface first — that's usually your team). Use the returned userIds
   * as the `teamUserIds` arg to `get_featurebase_stalled_promises` (and
   * other team-aware tools) so you don't have to set
   * FEATUREBASE_TEAM_USER_IDS in the env.
   */
  async findUser(args: { name: string; sampleSize?: number }) {
    const all = await getAllPosts();
    const lower = (args.name ?? "").toLowerCase().trim();
    if (!lower) {
      return { query: args.name, samplePostsScanned: 0, matches: [] };
    }

    type Match = {
      userId: string;
      name: string;
      postCount: number;
      commentCountInSampledPosts: number;
      totalCommentCount: number;
      guessedRole: CommentRole;
    };
    const matches = new Map<string, Match>();

    // 1. Scan post authors (always available).
    for (const p of all.normalized) {
      if (p.author.name.toLowerCase().includes(lower)) {
        const existing = matches.get(p.author.userId);
        if (existing) existing.postCount++;
        else
          matches.set(p.author.userId, {
            userId: p.author.userId,
            name: p.author.name,
            postCount: 1,
            commentCountInSampledPosts: 0,
            totalCommentCount: all.commentCountByUserId.get(p.author.userId) ?? 0,
            guessedRole: "customer",
          });
      }
    }

    // 2. Scan comment authors in a sample of recent posts. Cached comments
    //    make this cheap after first listing miss. totalCommentCount is
    //    filled from the board-wide index maintained by getAllPosts.
    const sampleSize = Math.max(0, Math.min(args.sampleSize ?? 5, 20));
    const samplePosts = all.normalized
      .filter((p) => p.commentCount > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, sampleSize);

    for (const p of samplePosts) {
      try {
        const comments = await getComments(p.id);
        walkComments(comments, (c) => {
          if (!c.author.name.toLowerCase().includes(lower)) return;
          const existing = matches.get(c.author.userId);
          if (existing) existing.commentCountInSampledPosts++;
          else
            matches.set(c.author.userId, {
              userId: c.author.userId,
              name: c.author.name,
              postCount: 0,
              commentCountInSampledPosts: 1,
              totalCommentCount:
                all.commentCountByUserId.get(c.author.userId) ?? 0,
              // Never posted = likely team. (Customer lurkers are rare.)
              guessedRole: "admin",
            });
        });
      } catch (err) {
        console.error(
          `[featurebase-mcp] find-user: comments fetch failed for ${p.slug}:`,
          err,
        );
      }
    }

    // Sort: guessedRole='admin' first (most likely team), then by
    // totalCommentCount desc (most active commenters surface first).
    const out = Array.from(matches.values()).sort((a, b) => {
      if (a.guessedRole !== b.guessedRole) {
        return a.guessedRole === "admin" ? -1 : 1;
      }
      return b.totalCommentCount - a.totalCommentCount;
    });
    return {
      query: args.name,
      samplePostsScanned: samplePosts.length,
      matches: out,
    };
  },

  async getPosts(args: GetPostsArgs) {
    const all = await getAllPosts();
    const includeContent = args.include_content ?? false;

    const found: Array<NormalizedPost | NormalizedPostDetail> = [];
    const notFound: string[] = [];

    for (const slug of args.slugs) {
      const post = all.normalized.find((p) => p.slug === slug);
      if (!post) {
        notFound.push(slug);
        continue;
      }
      if (includeContent) {
        const raw = all.raw.find((p) => p.slug === slug)!;
        const contentHtml = raw.content ?? "";
        found.push({
          ...post,
          contentHtml,
          contentText: htmlToText(contentHtml),
        });
      } else {
        found.push(post);
      }
    }

    // Order results to match the requested slug order.
    const ordered = args.slugs
      .map((s) => found.find((p) => p.slug === s))
      .filter((p): p is NormalizedPost | NormalizedPostDetail => !!p);

    return {
      requested: args.slugs.length,
      found: ordered.length,
      notFound: notFound.length > 0 ? notFound : undefined,
      posts: ordered,
    };
  },
};