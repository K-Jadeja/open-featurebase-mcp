/**
 * FeaturebaseClient — factory function over the Featurebase public API.
 *
 * ## Architecture
 *
 * The client is a closure-bound factory. Each `createClient(opts)` call
 * returns its own client with its own:
 *   - in-memory listing + comment-index caches (TTL-bound)
 *   - fetcher implementation (defaults to global `fetch`; tests inject)
 *
 * No module-level state. No global pollution. Two clients can coexist
 * with different configs in the same process.
 *
 * ## Lazy comment enrichment
 *
 * Previously every listing call fetched comments for every post with
 * comments (33 fetches on the current board). That was wasteful — most
 * listing calls don't consume the per-author comment index. Now:
 *   - `getAllPosts()` returns the listing + paginated, ~6 fetches total.
 *   - `ensureCommentIndex()` builds the per-userId totalCommentCount map
 *     on demand (33 fetches first time, cached after via TTL).
 *   - `findUser()` calls `ensureCommentIndex()` itself before populating
 *     each match's `totalCommentCount`.
 *
 * Net effect: a cold `list_featurebase_posts` is 6 fetches. A cold
 * `find_featurebase_user` is 6+33=39 fetches (one-time, cached). On a
 * typical agent flow (1 listing + 1 find_user) the cost is the same,
 * but pure listing callers pay only 6.
 *
 * ## Public boards only
 *
 * Auth-gated endpoints (writes, private posts) are unreachable.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type {
  CommentRole,
  NormalizedAuthor,
  NormalizedComment,
  NormalizedPost,
  NormalizedPostDetail,
  RoleNeutralComment,
} from "./types.js";
import { aggregateCommentCounts } from "./aggregation.js";
import { createFetcher, type Fetcher } from "./fetcher.js";

// ---------------------------------------------------------------------------
// Config — read once per factory invocation, so tests can override.
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
} as const;

/**
 * Read the team-user-ids env var at factory invocation time (not at
 * module load). Each createClient() call gets its own snapshot of
 * the env, so tests can override FEATUREBASE_TEAM_USER_IDS before
 * constructing a client and that override is honored.
 */
function readTeamUserIds(): ReadonlySet<string> {
  return new Set(
    (process.env.FEATUREBASE_TEAM_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Module-level default for code paths that don't have a Client
 * instance handy (e.g. early static normalizers). Production code
 * always uses the per-factory snapshot — this default exists only
 * so module-level helpers compile.
 */
const TEAM_USER_IDS_DEFAULT: ReadonlySet<string> = readTeamUserIds();

// ---------------------------------------------------------------------------
// Cache (Map + timestamps; one entry per factory instance)
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: unknown;
  expires: number;
}

function makeCache() {
  const cache = new Map<string, CacheEntry>();
  return {
    get<T>(key: string): T | null {
      const e = cache.get(key);
      if (!e || Date.now() > e.expires) {
        cache.delete(key);
        return null;
      }
      return e.data as T;
    },
    set(key: string, data: unknown, ttlSec: number) {
      cache.set(key, { data, expires: Date.now() + ttlSec * 1000 });
    },
  };
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

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

/** Basic author (no role yet). */
function normalizeAuthorBasic(raw: any): Omit<NormalizedAuthor, "role"> {
  return {
    name: raw?.name ?? "Anonymous",
    picture: raw?.picture,
    userId: raw?._id ?? raw?.createdBy ?? "",
  };
}

/** Effective team set. */
function getTeamSet(): ReadonlySet<string> {
  return TEAM_USER_IDS_DEFAULT;
}

/** Decide role for an author. */
function enrichAuthor(
  base: Omit<NormalizedAuthor, "role">,
  team: ReadonlySet<string>,
  configured?: boolean,
): NormalizedAuthor {
  const isConfigured = configured ?? team.size > 0;
  let role: CommentRole;
  if (!isConfigured) {
    role = "unknown";
  } else if (team.has(base.userId)) {
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
  team: ReadonlySet<string>,
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
  };
}

function normalizeComment(
  raw: any,
  team: ReadonlySet<string>,
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
// Per-post engagement computation
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
    const isAdmin = comment.author.role === "admin";
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
      if (
        !customerLastReplyDate ||
        comment.createdAt > customerLastReplyDate
      ) {
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

function computeEngagementWithTeamOverride(
  comments: NormalizedComment[],
  teamSet: ReadonlySet<string>,
): EngagementFields {
  let hasAdminReply = false;
  let adminReplyCount = 0;
  let customerCommentCount = 0;
  let lastCommentDate: string | undefined;
  let adminLastReplyDate: string | undefined;
  let customerLastReplyDate: string | undefined;

  function walk(comment: NormalizedComment): void {
    const isAdmin = teamSet.has(comment.author.userId);
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
      if (
        !customerLastReplyDate ||
        comment.createdAt > customerLastReplyDate
      ) {
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

// ---------------------------------------------------------------------------
// Find last comment by predicate (for team override paths)
// ---------------------------------------------------------------------------

function findLastCommentWhere<T extends { createdAt: string; replies: T[] }>(
  comments: readonly T[],
  predicate: (c: T) => boolean,
): T | null {
  let last: T | null = null;
  function walk(c: T): void {
    if (predicate(c)) {
      if (!last || c.createdAt > last.createdAt) last = c;
    }
    for (const r of c.replies) walk(r);
  }
  for (const c of comments) walk(c);
  return last;
}

function walkComments(
  comments: RoleNeutralComment[],
  fn: (c: RoleNeutralComment) => void,
): void {
  for (const c of comments) {
    fn(c);
    walkComments(c.replies, fn);
  }
}

/**
 * Build a fresh role-tagged tree from a role-neutral cache hit.
 *
 * The cached tree (from `getComments`) has no derived `role` on any
 * author — only identity (userId, name, picture). For each request we
 * rebuild a new tree with `role` assigned against THIS request's team
 * set. The cached tree is never mutated, so two requests with different
 * `teamUserIds` overrides see independent classifications.
 *
 * `configured` controls the loud-failure contract:
 *   - true  → every author is admin iff in `team`, else customer.
 *   - false → every author is "unknown" (team set unavailable; we
 *             refuse to classify). Engagement fields MUST be omitted
 *             when this is returned; the audit forbids manufacturing
 *             customer/admin classification with no team reference.
 */
function reclassifyTree(
  comments: RoleNeutralComment[],
  team: ReadonlySet<string>,
  configured: boolean,
): NormalizedComment[] {
  return comments.map((c) => ({
    id: c.id,
    author: enrichAuthor(
      { name: c.author.name, picture: c.author.picture, userId: c.author.userId },
      team,
      configured,
    ),
    bodyHtml: c.bodyHtml,
    bodyText: c.bodyText,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    upvotes: c.upvotes,
    parentId: c.parentId,
    replies: reclassifyTree(c.replies, team, configured),
  }));
}

/**
 * Re-derive a post's `author.role` against a request-specific team set.
 *
 * `getAllPosts()` builds the post listing once with the factory-time
 * default team, which is correct for cache lifetime but stale for any
 * request that supplies a `teamUserIds` override. Without this helper,
 * a caller could see `post.author.role === "admin"` while the SAME
 * user's comment in `comments[].author.role === "customer"` because
 * the comments were reclassified but the post author wasn't.
 *
 * Apply this in any path that returns a post when a per-call team
 * override (or any non-default effective team) is active. Identity
 * fields (name, picture, userId) are preserved from the cached post.
 */
function reclassifyPostAuthor(
  post: NormalizedPost,
  effectiveTeam: ReadonlySet<string>,
  configured: boolean,
): NormalizedPost {
  return {
    ...post,
    author: enrichAuthor(
      {
        name: post.author.name,
        picture: post.author.picture,
        userId: post.author.userId,
      },
      effectiveTeam,
      configured,
    ),
  };
}

/**
 * Resolve the effective team set + configured flag for a single call,
 * given the per-call override (or null) and the factory-time default
 * team set. Used by every engagement path so the override and the
 * default env-var team share one consistent treatment.
 *
 *   - explicit non-empty override: team wins, configured=true.
 *   - no override, default env-var team present: default wins, configured=true.
 *   - no override, no default team: empty team, configured=false (→ unknown).
 *   - empty override []: treated as absent (see #67 in audit history).
 */
function resolveTeam(
  teamUserIds: string[] | undefined,
  defaultTeam: ReadonlySet<string>,
  defaultHasTeam: boolean,
): { team: ReadonlySet<string>; configured: boolean } {
  const override =
    teamUserIds && teamUserIds.length > 0 ? new Set(teamUserIds) : null;
  const team = override ?? defaultTeam;
  const configured = override !== null || defaultHasTeam;
  return { team, configured };
}

// ---------------------------------------------------------------------------
// Listing API (paginated)
// ---------------------------------------------------------------------------

interface ApiPage {
  results: any[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

async function fetchApiPage(fetcher: Fetcher, page: number): Promise<ApiPage> {
  const url = `${BASE_URL}/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=${page}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher.fetch(url, {
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

// ---------------------------------------------------------------------------
// Comments API (paginated, replies nested server-side)
// ---------------------------------------------------------------------------

interface CommentsApiResponse {
  results: any[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
}

async function fetchCommentsPage(
  fetcher: Fetcher,
  submissionId: string,
  page: number,
): Promise<CommentsApiResponse> {
  const url =
    `${BASE_URL}/api/v1/comment?submissionId=${encodeURIComponent(submissionId)}` +
    `&page=${page}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher.fetch(url, {
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
 * Normalize a comment WITHOUT a team set. The cached tree is role-neutral
 * — see RoleNeutralComment in types.ts. Roles are assigned per request
 * via `reclassifyTree(tree, effectiveTeam)`, never stored.
 */
function normalizeCommentNeutral(raw: any): RoleNeutralComment {
  return {
    id: raw.id,
    author: {
      name: raw?.user?.name ?? "Anonymous",
      picture: raw?.user?.picture,
      userId: raw?.user?._id ?? raw?.createdBy ?? "",
    },
    bodyHtml: raw.content ?? "",
    bodyText: htmlToText(raw.content ?? ""),
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? "",
    upvotes: raw.upvotes ?? 0,
    parentId: raw.parentComment ?? null,
    replies: Array.isArray(raw.replies)
      ? raw.replies.map((r: any) => normalizeCommentNeutral(r))
      : [],
  };
}

/**
 * Fetch a submission's comment thread and cache it in role-neutral form.
 * The returned tree has no derived `role` on any author; callers must
 * classify with `reclassifyTree(tree, effectiveTeam)` against the team
 * set active for the specific request. This guarantees two consecutive
 * requests with different `teamUserIds` overrides cannot contaminate
 * each other's classification — the cache holds only identity + body,
 * never a derived role.
 *
 * ## Atomic multi-page contract
 *
 * Multi-page comment retrieval is ATOMIC. If page 1 fails OR any later
 * required page fails, this function throws ONE `McpError` whose message
 * lists the failed page numbers — and the cache is NOT populated. A
 * partial thread is never cached and never returned to callers as if it
 * were complete. The previous implementation silently kept the fulfilled
 * later pages and cached the partial thread, which corrupted
 * `hasAdminReply`, admin/customer counts and last-reply dates,
 * `totalCommentCount`, `engagementComplete`, and `commentsComplete`.
 */
async function getComments(
  fetcher: Fetcher,
  cache: ReturnType<typeof makeCache>,
  submissionId: string,
): Promise<RoleNeutralComment[]> {
  if (!submissionId) return [];
  const cacheKey = `comments:${submissionId}`;
  const cached = cache.get<RoleNeutralComment[]>(cacheKey);
  if (cached) return cached;

  // Page 1 is fetched eagerly so we can learn totalPages. A failure
  // here is the most catastrophic (no part of the thread is usable),
  // so it bubbles up directly. The fetchCommentsPage helper already
  // throws McpError on non-2xx, so we don't need extra wrapping.
  const first = await fetchCommentsPage(fetcher, submissionId, 1);
  const totalPages = first.totalPages;

  // Pages 2..N fetched concurrently. Promise.allSettled lets us inspect
  // each page's outcome independently — the previous implementation
  // dropped rejected pages silently, which is exactly the bug we're
  // fixing here.
  const rest = await Promise.allSettled(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      fetchCommentsPage(fetcher, submissionId, i + 2),
    ),
  );

  // Collect failed later pages. The page number reported is the
  // 1-indexed pagination index (so the message is "failed pages: 2, 4"
  // not "indices 0, 2").
  const failedPages = rest
    .map((r, i) => ({ r, page: i + 2 }))
    .filter(({ r }) => r.status === "rejected");
  if (failedPages.length > 0) {
    // Use the first rejection's error message as a representative
    // diagnostic. We don't echo the full stack to avoid leaking
    // internal implementation detail; callers can re-fetch and inspect
    // their own logs.
    const firstError =
      failedPages[0]!.r.status === "rejected" ? failedPages[0]!.r.reason : null;
    const diag =
      firstError instanceof Error ? firstError.message : String(firstError ?? "");
    throw new McpError(
      ErrorCode.InternalError,
      `Incomplete comment thread for ${submissionId}: failed pages ` +
        `${failedPages.map((f) => f.page).join(", ")} of ${totalPages}. ` +
        `Thread NOT cached — retrying will refetch all pages. (${diag})`,
    );
  }

  // Every page succeeded — safe to assemble the tree and cache it.
  const allRaw = [
    ...first.results,
    ...rest.flatMap((r) =>
      r.status === "fulfilled" ? r.value.results : [],
    ),
  ];

  const tree: RoleNeutralComment[] = allRaw.map((r) =>
    normalizeCommentNeutral(r),
  );
  function sortReplies(node: RoleNeutralComment): void {
    node.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of node.replies) sortReplies(r);
  }
  for (const root of tree) sortReplies(root);
  tree.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  cache.set(cacheKey, tree, TTL.comments);
  return tree;
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

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

const COMMENTS_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// ListingPayload — what getAllPosts returns. NO comment-fetch dependency.
// ---------------------------------------------------------------------------

export interface ListingPayload {
  raw: any[];
  normalized: NormalizedPost[];
  totalResults: number;
  availableResults: number;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface ClientOptions {
  fetcher?: Fetcher;
}

export interface Client {
  listPosts: (args: ListPostsArgs) => Promise<{
    totalResults: number;
    availableResults: number;
    truncated: boolean;
    returned: number;
    posts: NormalizedPost[];
  }>;
  getPost: (
    slug: string,
    includeComments: boolean,
    teamUserIds?: string[],
  ) => Promise<NormalizedPostDetail>;
  getPosts: (args: GetPostsArgs) => Promise<{
    requested: number;
    found: number;
    notFound?: string[];
    posts: Array<NormalizedPost | NormalizedPostDetail>;
  }>;
  searchPosts: (args: SearchPostsArgs) => Promise<{
    query: string;
    totalMatches: number;
    returned: number;
    posts: NormalizedPost[];
  }>;
  getStats: (args: {
    topVotedLimit?: number;
    recentLimit?: number;
  }) => Promise<{
    totalResults: number;
    snapshotSize: number;
    truncated: boolean;
    snapshotWindow: {
      from: string;
      to: string;
      ordering: "date desc";
    } | null;
    topVotedLimit: number;
    recentLimit: number;
    statusCountsInSnapshot: Record<string, number>;
    categoryCountsInSnapshot: Record<string, number>;
    topVoted: Array<{ slug: string; title: string; upvotes: number }>;
    recent: Array<{ slug: string; title: string; date: string }>;
  }>;
  getStalledPromises: (args: GetStalledPromisesArgs) => Promise<{
    minDaysSinceAdminReply: number;
    teamSource: "override" | "default" | "none";
    warning?: string;
    unusedTeamUserIds?: string[];
    unusedTeamUserIdsComplete?: boolean;
    engagementComplete?: boolean;
    failedCommentPostCount?: number;
    failedPostSlugs?: string[];
    totalCandidates: number;
    returned: number;
    promises: StalledPromise[];
  }>;
  findUser: (args: FindUserArgs) => Promise<{
    query: string;
    samplePostsScanned: number;
    commentsComplete: boolean;
    warning?: string;
    matches: Array<{
      userId: string;
      name: string;
      postCount: number;
      commentCountInSampledPosts: number;
      totalCommentCount: number;
      guessedRole: CommentRole;
    }>;
  }>;
}

export interface ListPostsArgs {
  status: "all" | "open" | "in_review" | "planned" | "in_progress" | "completed";
  sortBy: "date:desc" | "date:asc" | "upvotes:desc";
  limit: number;
  hasAdminReply?: boolean;
  teamUserIds?: string[];
}

export interface SearchPostsArgs {
  query: string;
  limit: number;
}

export interface GetPostsArgs {
  slugs: string[];
  include_content: boolean;
}

export interface GetStalledPromisesArgs {
  minDaysSinceAdminReply?: number;
  limit?: number;
  teamUserIds?: string[];
  status?: Array<
    "open" | "in_review" | "planned" | "in_progress" | "completed"
  >;
  sortBy?: "staleness" | "freshness" | "upvotes";
}

export interface FindUserArgs {
  name: string;
  sampleSize?: number;
}

interface StalledPromise {
  slug: string;
  title: string;
  url: string;
  status: NormalizedPost["status"];
  commentCount: number;
  upvotes: number;
  author: NormalizedAuthor;
  date: string;
  adminLastReplyDate: string;
  customerLastReplyDate: string;
  daysSinceAdminReply: number;
  lastAdminMessage: {
    author: { name: string; userId: string; role: CommentRole };
    date: string;
    excerpt: string;
  } | null;
  lastCustomerMessage: {
    author: { name: string; userId: string; role: CommentRole };
    date: string;
    excerpt: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createClient(opts: ClientOptions = {}): Client {
  const fetcher = opts.fetcher ?? createFetcher();
  const cache = makeCache();
  // Per-factory team snapshot, evaluated once when the client is
  // constructed. Subsequent env-var changes do NOT affect an existing
  // client (intentional — caches depend on team set).
  const team: ReadonlySet<string> = readTeamUserIds();
  const hasTeam = team.size > 0;

  /**
   * Lazy board-wide comment index. Built on first call to a tool that
   * needs totalCommentCount (find_featurebase_user). Costs ~33 fetches
   * for this board on first call; cached for 5 minutes.
   *
   * `commentsComplete === true` when every comment fetch succeeded.
   * `false` signals partial counts — find_featurebase_user surfaces a
   * warning in that case.
   *
   * ## Cache write policy (do NOT cache an incomplete index)
   *
   * When ANY comment fetch fails, the resulting index has under-counted
   * some users — caching it under "comments:index" would let a later
   * `find_featurebase_user` call consume stale incomplete counts. The
   * incomplete result is returned for the CURRENT response only (with
   * `complete: false`), and the next call to `ensureCommentIndex()`
   * refetches every post's comments from scratch.
   */
  async function ensureCommentIndex(): Promise<{
    counts: Map<string, number>;
    complete: boolean;
  }> {
    const cached = cache.get<{ counts: Map<string, number>; complete: boolean }>(
      "comments:index",
    );
    if (cached) return cached;

    const listing = await getAllPosts();
    const withComments = listing.normalized.filter(
      (p) => p.commentCount > 0,
    );
    const counts = new Map<string, number>();
    let fetchFailed = 0;

    if (withComments.length > 0) {
      const results = await mapWithConcurrency(
        withComments,
        COMMENTS_CONCURRENCY,
        async (p) => {
          try {
            const comments = await getComments(fetcher, cache, p.id);
            return { id: p.id, ok: true as const, comments };
          } catch (err) {
            console.error(
              `[featurebase-mcp] comments fetch failed for ${p.slug}:`,
              err,
            );
            return { id: p.id, ok: false as const };
          }
        },
      );
      for (const r of results) {
        if (!r.ok) {
          fetchFailed++;
          continue;
        }
        const c = aggregateCommentCounts(r.comments);
        for (const [userId, count] of c) {
          counts.set(userId, (counts.get(userId) ?? 0) + count);
        }
      }
    }

    const out = { counts, complete: fetchFailed === 0 };

    // Only cache when complete. An incomplete index is returned for
    // the current response only; the next ensureCommentIndex() call
    // will refetch every post's comments.
    if (out.complete) {
      cache.set("comments:index", out, TTL.comments);
    }
    return out;
  }

  /**
   * Listing only — does NOT fetch comments. Cost: 6 listing pages
   * (cached after first call). 0 comment fetches.
   *
   * ## Atomic multi-page contract (listing)
   *
   * Multi-page listing retrieval is ATOMIC — same rule as getComments().
   * If page 1 fails OR any later required page fails, this function
   * throws ONE McpError whose message lists the failed page numbers —
   * and the listing cache is NOT populated. A partial listing must
   * never be cached and never returned to callers as if it were
   * complete. Downstream tools (list-posts, get-post, stalled-promises,
   * find-user) all depend on a complete listing; a partial listing
   * would corrupt `notFound` answers (a post that exists on the failed
   * page would be falsely reported as not-found) and would let
   * find-user claim a complete board-wide total when the listing is
   * in fact incomplete.
   */
  async function getAllPosts(): Promise<ListingPayload> {
    const cacheKey = "list:all";
    const cached = cache.get<ListingPayload>(cacheKey);
    if (cached) return cached;

    // Page 1 fetched eagerly to learn totalPages / totalResults.
    const first = await fetchApiPage(fetcher, 1);
    const totalPages = first.totalPages;
    const totalResults = first.totalResults;

    // Pages 2..N fetched concurrently. Promise.allSettled lets us
    // inspect each page's outcome independently.
    const rest = await Promise.allSettled(
      Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
        fetchApiPage(fetcher, i + 2),
      ),
    );

    // Atomic: if any required listing page failed, throw one McpError
    // listing the failed pages. The cache is NOT populated. Retry on
    // the same client refetches every page from scratch.
    const failedPages = rest
      .map((r, i) => ({ r, page: i + 2 }))
      .filter(({ r }) => r.status === "rejected");
    if (failedPages.length > 0) {
      const firstError =
        failedPages[0]!.r.status === "rejected"
          ? failedPages[0]!.r.reason
          : null;
      const diag =
        firstError instanceof Error
          ? firstError.message
          : String(firstError ?? "");
      throw new McpError(
        ErrorCode.InternalError,
        `Incomplete listing: failed pages ` +
          `${failedPages.map((f) => f.page).join(", ")} of ${totalPages}. ` +
          `Listing NOT cached — retrying will refetch all pages. (${diag})`,
      );
    }

    // Every page succeeded — assemble the listing and cache it.
    const raw = [
      ...first.results,
      ...rest.flatMap((r) =>
        r.status === "fulfilled" ? r.value.results : [],
      ),
    ];
    const normalized = raw.map((r) => normalizePost(r, team));

    const out: ListingPayload = {
      raw,
      normalized,
      totalResults,
      availableResults: raw.length,
    };
    cache.set(cacheKey, out, TTL.listing);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Post-level helpers used by tools
  // ---------------------------------------------------------------------------

  async function enrichPostEngagement(
    post: NormalizedPost,
    teamUserIds?: string[],
  ): Promise<NormalizedPost> {
    if (post.commentCount === 0 || post.commentFetchFailed) return post;
    const { team: effectiveTeam, configured: teamConfigured } = resolveTeam(
      teamUserIds,
      team,
      hasTeam,
    );
    if (!teamConfigured) {
      // No team reference at all — refuse to manufacture classification.
      // Return the post without any engagement fields; the loud-failure
      // contract says unknown must remain unknown.
      return post;
    }
    const teamOverride =
      teamUserIds && teamUserIds.length > 0
        ? new Set(teamUserIds)
        : null;
    try {
      const neutral = await getComments(fetcher, cache, post.id);
      const classified = reclassifyTree(neutral, effectiveTeam, true);
      const eng = teamOverride
        ? computeEngagementWithTeamOverride(classified, teamOverride)
        : computeEngagement(classified);
      return { ...post, ...eng };
    } catch {
      return { ...post, commentFetchFailed: true };
    }
  }

  return {
    async listPosts(args: ListPostsArgs) {
      const all = await getAllPosts();
      let posts = all.normalized;

      if (args.status !== "all") {
        const want = STATUS_TYPE_MAP[args.status];
        posts = posts.filter((p) => p.status.type === want);
      }

      // hasAdminReply requires per-post engagement fields, which means
      // we have to fetch comments for posts that have any. Lazy: only
      // triggered when the caller actually asks for the filter.
      let engagementComplete = true;
      const failedPostSlugs: string[] = [];
      let engagementWarning: string | undefined;
      if (args.hasAdminReply !== undefined) {
        // The caller may pass teamUserIds as an override (useful for
        // tests and for the find_featurebase_user → list_featurebase_posts
        // drill-down). When provided, it shadows the env-var team set.
        const teamOverride =
          args.teamUserIds && args.teamUserIds.length > 0
            ? new Set(args.teamUserIds)
            : null;
        const effectiveTeam = teamOverride ?? team;
        if (effectiveTeam.size === 0) {
          // Loud failure: we cannot classify engagement without a team
          // set. Fabricating hasAdminReply:false would be a silent
          // false-negative for hasAdminReply:true callers (returns
          // empty) AND a silent false-positive for hasAdminReply:false
          // callers (returns every post). Neither is acceptable. Throw
          // so the MCP transport surfaces a clean InvalidParams error
          // and the agent can correct the request.
          throw new McpError(
            ErrorCode.InvalidParams,
            "hasAdminReply requires a team set. Either set " +
              "FEATUREBASE_TEAM_USER_IDS or pass teamUserIds — " +
              "call find_featurebase_user with your name to discover " +
              "your user IDs first.",
          );
        }
        const withComments = posts.filter(
          (p) => p.commentCount > 0 && !p.commentFetchFailed,
        );
        const enriched = await mapWithConcurrency(
          withComments,
          COMMENTS_CONCURRENCY,
          async (p) => {
            try {
              const neutral = await getComments(fetcher, cache, p.id);
              const classified = reclassifyTree(
                neutral,
                effectiveTeam,
                true,
              );
              const eng = teamOverride
                ? computeEngagementWithTeamOverride(classified, teamOverride)
                : computeEngagement(classified);
              return { id: p.id, slug: p.slug, ok: true as const, eng };
            } catch (err) {
              console.error(
                `[featurebase-mcp] list-posts: comments fetch failed for ${p.slug}:`,
                err,
              );
              return {
                id: p.id,
                slug: p.slug,
                ok: false as const,
              };
            }
          },
        );
        const engById = new Map<
          string,
          { ok: true; eng: EngagementFields } | { ok: false }
        >();
        for (const e of enriched) {
          if (e.ok) engById.set(e.id, { ok: true, eng: e.eng });
          else {
            engById.set(e.id, { ok: false });
            failedPostSlugs.push(e.slug);
            engagementComplete = false;
          }
        }

        posts = posts.map((p) => {
          // Zero-comment posts must carry EXPLICIT zero engagement so
          // the strict-equality filter `(p.hasAdminReply ?? null) ===
          // args.hasAdminReply` below matches them correctly. Without
          // this, hasAdminReply stays undefined and `undefined ?? null`
          // equals `null`, never `false` — silently excluding every
          // zero-comment post from hasAdminReply:false (and silently
          // matching them against hasAdminReply:true, since `undefined
          // !== true` is also true). A zero-comment post DEFINITIVELY
          // satisfies "the team has not commented".
          if (p.commentCount === 0) {
            return {
              ...p,
              hasAdminReply: false,
              adminReplyCount: 0,
              customerCommentCount: 0,
            };
          }
          const result = engById.get(p.id);
          if (result === undefined) return p;
          if (!result.ok) {
            return { ...p, commentFetchFailed: true };
          }
          return { ...p, ...result.eng };
        });

        // Re-derive each post's author role against the per-call team
        // so post.author.role matches the engagement fields under the
        // SAME effective team. Without this, a cached post author
        // (classified at factory time with the default team) could
        // disagree with the just-computed engagement that uses the
        // override team.
        posts = posts.map((p) =>
          reclassifyPostAuthor(p, effectiveTeam, true),
        );

        posts = posts.filter(
          (p) => (p.hasAdminReply ?? null) === args.hasAdminReply,
        );

        if (!engagementComplete) {
          engagementWarning =
            `hasAdminReply filter is incomplete — comment fetch failed for ` +
            `${failedPostSlugs.length} post(s) (${failedPostSlugs.slice(0, 5).join(", ")}` +
            (failedPostSlugs.length > 5 ? ", …" : "") +
            `). Their hasAdminReply value is reported as commentFetchFailed=true ` +
            `and they may have been excluded from posts[]. This is a transient ` +
            `API failure (network, rate-limit, or service hiccup). Retry the ` +
            `request after a short delay; check network connectivity and the ` +
            `Featurebase board status if the failure persists. Do NOT delete ` +
            `or modify the affected posts — they are still user-visible content.`;
        }
      }

      posts = sortPosts(posts, args.sortBy).slice(0, args.limit);

      const response: {
        totalResults: number;
        availableResults: number;
        truncated: boolean;
        returned: number;
        posts: typeof posts;
        engagementComplete?: boolean;
        failedCommentPostCount?: number;
        failedPostSlugs?: string[];
        warning?: string;
      } = {
        totalResults: all.totalResults,
        availableResults: all.availableResults,
        truncated: all.availableResults < all.totalResults,
        returned: posts.length,
        posts,
      };
      if (args.hasAdminReply !== undefined) {
        response.engagementComplete = engagementComplete;
        if (failedPostSlugs.length > 0) {
          response.failedCommentPostCount = failedPostSlugs.length;
          response.failedPostSlugs = failedPostSlugs;
        }
        if (engagementWarning) response.warning = engagementWarning;
      }
      return response;
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

      const {
        team: effectiveTeam,
        configured: teamConfigured,
      } = resolveTeam(teamUserIds, team, hasTeam);
      const teamOverride =
        teamUserIds && teamUserIds.length > 0
          ? new Set(teamUserIds)
          : null;

      // Single fetch per request.
      //
      // include_comments=false: use the lazy enrichPostEngagement path
      // (still goes through getComments under the hood). This is the
      // pre-existing behavior and triggers a comment fetch only when
      // a team is configured.
      //
      // include_comments=true: fetch the comment thread EXACTLY ONCE,
      // reclassify once, and derive BOTH engagement fields and the
      // returned comments[] from that same classified tree. This
      // prevents the previous bug where enrichPostEngagement fetched
      // first (and may have set commentFetchFailed:true), then the
      // comments block fetched AGAIN — letting the response end up
      // with complete comments but a stale commentFetchFailed:true
      // and missing engagement fields from the first attempt.
      if (!includeComments) {
        const enriched = await enrichPostEngagement(post, teamUserIds);
        const enrichedWithAuthor = reclassifyPostAuthor(
          enriched,
          effectiveTeam,
          teamConfigured,
        );
        return { ...enrichedWithAuthor, contentHtml, contentText };
      }

      // include_comments=true — single fetch.
      if (post.commentCount === 0) {
        // No comments on this post: skip the fetch entirely, return
        // the post with empty comments[]. When a team is configured,
        // populate explicit zero engagement values so callers can
        // distinguish "no comments yet" from "unclassified". When no
        // team is configured, keep the loud-unknown contract: omit
        // engagement fields and let authors stay as role="unknown".
        const withAuthor = reclassifyPostAuthor(
          post,
          effectiveTeam,
          teamConfigured,
        );
        if (teamConfigured) {
          return {
            ...withAuthor,
            contentHtml,
            contentText,
            comments: [],
            hasAdminReply: false,
            adminReplyCount: 0,
            customerCommentCount: 0,
          };
        }
        return {
          ...withAuthor,
          contentHtml,
          contentText,
          comments: [],
        };
      }

      try {
        const neutral = await getComments(fetcher, cache, post.id);
        const classified = reclassifyTree(
          neutral,
          effectiveTeam,
          teamConfigured,
        );
        // Derive engagement from the SAME classified tree the comments
        // array comes from. No second fetch.
        const engagement =
          teamOverride && teamConfigured
            ? computeEngagementWithTeamOverride(classified, teamOverride)
            : teamConfigured
              ? computeEngagement(classified)
              : null; // no team → omit engagement fields
        const withEngagement: NormalizedPost = engagement
          ? { ...post, ...engagement }
          : { ...post };
        const enrichedWithAuthor = reclassifyPostAuthor(
          withEngagement,
          effectiveTeam,
          teamConfigured,
        );
        return {
          ...enrichedWithAuthor,
          contentHtml,
          contentText,
          comments: classified,
        };
      } catch (err) {
        // Atomic getComments() threw. Return ONE consistent failed
        // state: commentsError set, comments array undefined,
        // engagement fields OMITTED (not commentFetchFailed:true from
        // a separate earlier attempt — there is no earlier attempt).
        const commentsError =
          err instanceof Error ? err.message : String(err);
        console.error(
          `[featurebase-mcp] comments fetch failed for ${slug}:`,
          err,
        );
        // Strip any stale engagement fields that may have come from
        // a previous successful-but-now-invalidated fetch (defensive —
        // should not happen in production since the per-call reclassify
        // is the only source).
        const base: NormalizedPost = { ...post };
        delete base.commentFetchFailed;
        delete base.hasAdminReply;
        delete base.adminReplyCount;
        delete base.customerCommentCount;
        delete base.lastCommentDate;
        delete base.adminLastReplyDate;
        delete base.customerLastReplyDate;
        const withAuthor = reclassifyPostAuthor(
          base,
          effectiveTeam,
          teamConfigured,
        );
        return {
          ...withAuthor,
          contentHtml,
          contentText,
          commentsError,
        };
      }
    },

    async getPosts(args: GetPostsArgs) {
      const all = await getAllPosts();
      const includeContent = args.include_content;
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
          found.push({
            ...post,
            contentHtml: raw.content ?? "",
            contentText: htmlToText(raw.content ?? ""),
          });
        } else {
          found.push(post);
        }
      }
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
        if (titleLower.includes(q)) score += 3;
        if (bodyText.includes(q)) score += 1;
        for (const t of tokens) {
          if (t === q) continue;
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

    async getStats(args: { topVotedLimit?: number; recentLimit?: number }) {
      const all = await getAllPosts();
      const topLimit = Math.max(1, Math.min(args.topVotedLimit ?? 5, 50));
      const recentLimit = Math.max(1, Math.min(args.recentLimit ?? 5, 50));

      const statusCountsInSnapshot: Record<string, number> = {};
      const categoryCountsInSnapshot: Record<string, number> = {};
      for (const post of all.normalized) {
        statusCountsInSnapshot[post.status.name] =
          (statusCountsInSnapshot[post.status.name] ?? 0) + 1;
        categoryCountsInSnapshot[post.category] =
          (categoryCountsInSnapshot[post.category] ?? 0) + 1;
      }

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
        totalResults: all.totalResults,
        snapshotSize: all.availableResults,
        truncated: all.availableResults < all.totalResults,
        snapshotWindow,
        topVotedLimit: topLimit,
        recentLimit,
        statusCountsInSnapshot,
        categoryCountsInSnapshot,
        topVoted,
        recent,
      };
    },

    async getStalledPromises(args: GetStalledPromisesArgs) {
      const minDays = Math.max(
        0,
        Math.floor(args.minDaysSinceAdminReply ?? 7),
      );
      const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
      const sortBy = args.sortBy ?? "staleness";

      const wantedTypes = new Set<string>();
      for (const friendly of args.status ?? []) {
        const mapped = STATUS_TYPE_MAP[friendly];
        if (mapped) wantedTypes.add(mapped);
      }

      const teamOverride =
        args.teamUserIds && args.teamUserIds.length > 0
          ? new Set(args.teamUserIds)
          : null;
      const {
        team: effectiveTeam,
        configured: teamConfigured,
      } = resolveTeam(args.teamUserIds, team, hasTeam);

      let warning: string | undefined;
      let unusedTeamUserIds: string[] | undefined;

      // Short-circuit when no team reference is available. We do this
      // BEFORE getAllPosts() so the no-team path makes zero listing and
      // zero comment requests. Without a team we cannot classify
      // admin vs customer — fabricating customer classifications with
      // an empty team set would be silent corruption.
      if (!teamConfigured) {
        warning =
          "No team IDs configured — stalled-promise detection requires knowing who your team is. " +
            "Call find_featurebase_user with your name to discover your user ID, then pass the " +
            "returned userIds as teamUserIds. Alternatively set FEATUREBASE_TEAM_USER_IDS env var.";
        return {
          minDaysSinceAdminReply: minDays,
          teamSource: "none" as const,
          warning,
          totalCandidates: 0,
          returned: 0,
          promises: [],
        };
      }

      const teamSource: "override" | "default" = teamOverride
        ? "override"
        : "default";

      const all = await getAllPosts();
      const now = Date.now();
      const minMs = minDays * 24 * 60 * 60 * 1000;

      // For the user-friendly "stalled" semantic, we need per-post
      // adminLastReplyDate/customerLastReplyDate, which means fetching
      // comments. The candidate loop below fetches each post's comments
      // directly via getComments() — we intentionally do NOT call
      // ensureCommentIndex() here, because:
      //   (a) The index is unused in this code path (the candidate
      //       loop produces its own engagement per post).
      //   (b) Calling ensureCommentIndex() here would cache a board-wide
      //       user-count map under "comments:index" — and if any
      //       multi-page comment fetch threw ATOMICALLY, the index
      //       would be cached with incomplete counts. A later
      //       find_featurebase_user call would then consume stale
      //       incomplete counts from that cache, polluting
      //       totalCommentCount across requests.
      // Leaving the index alone means find-user builds its own counts
      // (via ensureCommentIndex or per-post getComments) on demand,
      // after the candidate loop has fully populated or rejected each
      // per-post cache entry.

      let candidates = all.normalized.slice();

      // Track failures here so we can surface engagementComplete +
      // failedPostSlugs at the top level, regardless of which posts
      // make it into promises[].
      let engagementComplete = true;
      const failedPostSlugs: string[] = [];

      // Annotate each post with engagement under the active team set.
      // No conditional gate: if teamConfigured is true (the no-team
      // branch above already returned), every comment-bearing post
      // is fetched and classified. Failures must be observable.
      //
      // The CandidateResult is a discriminated union on `kind`:
      //   - "no_comments" : post has zero comments per listing;
      //                     engagement fields stay absent (we cannot
      //                     claim hasAdminReply one way or the other
      //                     when there are no comments).
      //   - "fetched"     : comments were fetched and classified;
      //                     engagement fields are populated.
      //   - "failed"      : atomic getComments() threw; this post is
      //                     marked commentFetchFailed and surfaces in
      //                     failedPostSlugs / engagementComplete=false.
      type CandidateResult =
        | { kind: "no_comments"; p: NormalizedPost; slug: string }
        | {
            kind: "fetched";
            p: NormalizedPost;
            slug: string;
            eng: EngagementFields;
          }
        | { kind: "failed"; p: NormalizedPost; slug: string };
      candidates = await mapWithConcurrency(
        candidates,
        COMMENTS_CONCURRENCY,
        async (p): Promise<CandidateResult> => {
          if (p.commentCount === 0) {
            return { kind: "no_comments", p, slug: p.slug };
          }
          try {
            const neutral = await getComments(fetcher, cache, p.id);
            const classified = reclassifyTree(neutral, effectiveTeam, true);
            const eng = teamOverride
              ? computeEngagementWithTeamOverride(classified, teamOverride)
              : computeEngagement(classified);
            return { kind: "fetched", p, slug: p.slug, eng };
          } catch (err) {
            console.error(
              `[featurebase-mcp] stalled-promises: comments fetch failed for ${p.slug}:`,
              err,
            );
            return { kind: "failed", p, slug: p.slug };
          }
        },
      ).then((resolved) =>
        resolved.map((r) => {
          switch (r.kind) {
            case "no_comments":
              return r.p;
            case "fetched":
              return { ...r.p, ...r.eng };
            case "failed":
              failedPostSlugs.push(r.slug);
              engagementComplete = false;
              return { ...r.p, commentFetchFailed: true };
          }
        }),
      );

      // Re-derive each post's author role against the per-call team so
      // post.author.role matches the engagement fields. Without this,
      // post.author.role could disagree with lastAdminMessage.role
      // when a teamUserIds override is supplied.
      candidates = candidates.map((p) =>
        reclassifyPostAuthor(p, effectiveTeam, true),
      );

      if (teamOverride) {
        const matchedIds = new Set<string>();
        // Track per-team-user-id-match for unused detection
        // (intentionally hoisted into the per-post fetch loop above
        // for accuracy; this set is filled during the candidate filter
        // stage below — see candidate.filter).
      }

      const stalled = candidates.filter((p) => {
        if (!p.adminLastReplyDate || !p.customerLastReplyDate) return false;
        if (p.customerLastReplyDate <= p.adminLastReplyDate) return false;
        if (now - new Date(p.adminLastReplyDate).getTime() < minMs)
          return false;
        if (wantedTypes.size > 0 && !wantedTypes.has(p.status.type))
          return false;
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

      const enriched = await mapWithConcurrency(sliced, COMMENTS_CONCURRENCY, async (p) => {
        let lastAdminMsg: StalledPromise["lastAdminMessage"] = null;
        let lastCustomerMsg: StalledPromise["lastCustomerMessage"] = null;
        try {
          const neutral = await getComments(fetcher, cache, p.id);
          const classified = reclassifyTree(
            neutral,
            effectiveTeam,
            true,
          );
          const adminPredicate = teamOverride
            ? (c: NormalizedComment) => teamOverride.has(c.author.userId)
            : (c: NormalizedComment) => c.author.role === "admin";
          const customerPredicate = teamOverride
            ? (c: NormalizedComment) => !teamOverride.has(c.author.userId)
            : (c: NormalizedComment) => c.author.role === "customer";
          const lastAdmin = findLastCommentWhere(classified, adminPredicate);
          const lastCustomer = findLastCommentWhere(
            classified,
            customerPredicate,
          );
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
      });

      // Compute unused IDs when override was used. A failed comment
      // fetch may have hidden one of the supplied IDs from `allMatched`
      // — in that case we MUST NOT report that ID as unused, because
      // we don't know. Track the failure count; if any required fetch
      // failed, expose `unusedTeamUserIdsComplete: false` and omit the
      // `unusedTeamUserIds` field entirely.
      let unusedTeamUserIdsComplete: boolean | undefined;
      if (teamOverride) {
        const allMatched = new Set<string>();
        let unusedFetchesFailed = 0;
        for (const p of all.normalized.filter((x) => x.commentCount > 0)) {
          try {
            const cs = await getComments(fetcher, cache, p.id);
            walkComments(cs, (c) => {
              if (teamOverride.has(c.author.userId))
                allMatched.add(c.author.userId);
            });
          } catch (err) {
            unusedFetchesFailed++;
            console.error(
              `[featurebase-mcp] stalled-promises: comments fetch failed for ${p.slug} (unusedTeamUserIds):`,
              err,
            );
          }
        }
        unusedTeamUserIdsComplete = unusedFetchesFailed === 0;
        if (unusedTeamUserIdsComplete) {
          const unused = [...teamOverride].filter(
            (id) => !allMatched.has(id),
          );
          if (unused.length > 0) unusedTeamUserIds = unused;
        } else {
          // Refuse to claim any ID is unused based on incomplete threads.
          unusedTeamUserIds = undefined;
        }
      }

      let engagementWarning: string | undefined;
      if (!engagementComplete) {
        engagementWarning =
          `Stalled-promise results are incomplete — comment fetch failed for ` +
          `${failedPostSlugs.length} post(s) (${failedPostSlugs.slice(0, 5).join(", ")}` +
          (failedPostSlugs.length > 5 ? ", …" : "") +
          `). Their admin/customer dates are unknown and they may have been ` +
          `excluded from promises[]. This is a transient API failure (network, ` +
          `rate-limit, or service hiccup). Retry the request after a short ` +
          `delay; check network connectivity and the Featurebase board status ` +
          `if the failure persists. Do NOT delete or modify the affected posts ` +
          `— they are still user-visible content.`;
      }
      // Merge the partial-failure warning with any pre-existing warning
      // (currently only the no-team branch — but that branch has its own
      // short-circuit return, so we never reach this point with both).
      const finalWarning = engagementWarning ?? warning;

      return {
        minDaysSinceAdminReply: minDays,
        teamSource,
        warning: finalWarning,
        unusedTeamUserIds,
        unusedTeamUserIdsComplete,
        engagementComplete,
        failedCommentPostCount: failedPostSlugs.length || undefined,
        failedPostSlugs:
          failedPostSlugs.length > 0 ? failedPostSlugs : undefined,
        totalCandidates: stalled.length,
        returned: enriched.length,
        promises: enriched,
      };
    },

    async findUser(args: FindUserArgs) {
      const all = await getAllPosts();
      const lower = (args.name ?? "").toLowerCase().trim();
      if (!lower) {
        return {
          query: args.name,
          samplePostsScanned: 0,
          commentsComplete: false,
          warning:
            "Comment counts are unavailable until at least one comment has been fetched. " +
            "Call this tool again after the comment index has been built.",
          matches: [],
        };
      }

      const index = await ensureCommentIndex();

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
              totalCommentCount: index.counts.get(p.author.userId) ?? 0,
              guessedRole: "customer",
            });
        }
      }

      // 2. Scan comment authors in a sample of recent posts.
      const sampleSize = Math.max(0, Math.min(args.sampleSize ?? 5, 20));
      const samplePosts = all.normalized
        .filter((p) => p.commentCount > 0)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, sampleSize);

      for (const p of samplePosts) {
        try {
          const comments = await getComments(fetcher, cache, p.id);
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
                totalCommentCount: index.counts.get(c.author.userId) ?? 0,
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

      const out = Array.from(matches.values()).sort((a, b) => {
        if (a.guessedRole !== b.guessedRole) {
          return a.guessedRole === "admin" ? -1 : 1;
        }
        return b.totalCommentCount - a.totalCommentCount;
      });

      return {
        query: args.name,
        samplePostsScanned: samplePosts.length,
        commentsComplete: index.complete,
        warning: index.complete
          ? undefined
          : "Comment counts (totalCommentCount) are partial — at least one post's comments failed to fetch while building the comment index. Re-run after a few minutes to retry.",
        matches: out,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

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
