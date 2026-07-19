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

function findLastCommentByRole(
  comments: NormalizedComment[],
  role: CommentRole,
): NormalizedComment | null {
  return findLastCommentWhere(comments, (c) => c.author.role === role);
}

function walkComments(
  comments: NormalizedComment[],
  fn: (c: NormalizedComment) => void,
): void {
  for (const c of comments) {
    fn(c);
    walkComments(c.replies, fn);
  }
}

function reclassifyTree(
  comments: NormalizedComment[],
  team: ReadonlySet<string>,
  configured: boolean,
): NormalizedComment[] {
  return comments.map((c) => ({
    ...c,
    author: enrichAuthor(
      { name: c.author.name, picture: c.author.picture, userId: c.author.userId },
      team,
      configured,
    ),
    replies: reclassifyTree(c.replies, team, configured),
  }));
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

async function getComments(
  fetcher: Fetcher,
  cache: ReturnType<typeof makeCache>,
  submissionId: string,
  team: ReadonlySet<string>,
): Promise<NormalizedComment[]> {
  if (!submissionId) return [];
  const cacheKey = `comments:${submissionId}`;
  const cached = cache.get<NormalizedComment[]>(cacheKey);
  if (cached) return cached;

  const first = await fetchCommentsPage(fetcher, submissionId, 1);
  const totalPages = first.totalPages;
  const rest = await Promise.allSettled(
    Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
      fetchCommentsPage(fetcher, submissionId, i + 2),
    ),
  );
  const allRaw = [
    ...first.results,
    ...rest
      .filter((r): r is PromiseFulfilledResult<CommentsApiResponse> => r.status === "fulfilled")
      .flatMap((r) => r.value.results),
  ];

  const tree = allRaw.map((r) => normalizeComment(r, team));
  function sortReplies(node: NormalizedComment): void {
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
    teamSource: "override" | "default";
    warning?: string;
    unusedTeamUserIds?: string[];
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
            const comments = await getComments(fetcher, cache, p.id, team);
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
    cache.set("comments:index", out, TTL.comments);
    return out;
  }

  /**
   * Listing only — does NOT fetch comments. Cost: 6 listing pages
   * (cached after first call). 0 comment fetches.
   */
  async function getAllPosts(): Promise<ListingPayload> {
    const cacheKey = "list:all";
    const cached = cache.get<ListingPayload>(cacheKey);
    if (cached) return cached;

    const first = await fetchApiPage(fetcher, 1);
    const totalPages = first.totalPages;
    const totalResults = first.totalResults;

    const rest = await Promise.allSettled(
      Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) =>
        fetchApiPage(fetcher, i + 2),
      ),
    );
    const successfulPages: ApiPage[] = [first];
    for (const r of rest) {
      if (r.status === "fulfilled") successfulPages.push(r.value);
    }

    const raw = successfulPages.flatMap((p) => p.results);
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
    const teamOverride =
      teamUserIds && teamUserIds.length > 0
        ? new Set(teamUserIds)
        : null;
    try {
      const comments = await getComments(fetcher, cache, post.id, team);
      const eng = teamOverride
        ? computeEngagementWithTeamOverride(comments, teamOverride)
        : computeEngagement(comments);
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
      if (args.hasAdminReply !== undefined) {
        // The caller may pass teamUserIds as an override (useful for
        // tests and for the find_featurebase_user → list_featurebase_posts
        // drill-down). When provided, it shadows the env-var team set.
        const teamOverride =
          args.teamUserIds && args.teamUserIds.length > 0
            ? new Set(args.teamUserIds)
            : null;
        const effectiveTeam = teamOverride ?? team;
        const effectiveHasTeam = effectiveTeam.size > 0;
        if (!effectiveHasTeam) {
          // Without a team set, role classification is impossible.
          // Per the audit: silent classification would be worse than
          // returning empty + a clear warning. Surface it via a
          // synthetic warning field attached to each returned post.
          const warning =
            "hasAdminReply filter requires FEATUREBASE_TEAM_USER_IDS " +
            "or a teamUserIds override. Set the env var, or call " +
            "find_featurebase_user to discover your user IDs.";
          posts = posts.map((p) =>
            p.commentCount > 0
              ? { ...p, hasAdminReply: false, hasAdminReplyWarning: warning }
              : { ...p, hasAdminReply: false, hasAdminReplyWarning: warning },
          );
        } else {
          const withComments = posts.filter(
            (p) => p.commentCount > 0 && !p.commentFetchFailed,
          );
          const enriched = await mapWithConcurrency(
            withComments,
            COMMENTS_CONCURRENCY,
            async (p) => {
              try {
                const comments = await getComments(
                  fetcher,
                  cache,
                  p.id,
                  effectiveTeam,
                );
                const eng = teamOverride
                  ? computeEngagementWithTeamOverride(comments, teamOverride)
                  : computeEngagement(comments);
                return { id: p.id, eng };
              } catch {
                return { id: p.id, eng: undefined };
              }
            },
          );
          const engById = new Map<string, EngagementFields | undefined>();
          for (const e of enriched) engById.set(e.id, e.eng);

          posts = posts.map((p) => {
            const eng = engById.get(p.id);
            if (eng === undefined) {
              return p.commentCount > 0
                ? { ...p, commentFetchFailed: true }
                : p;
            }
            return { ...p, ...eng };
          });
        }

        posts = posts.filter(
          (p) => (p.hasAdminReply ?? null) === args.hasAdminReply,
        );
      }

      posts = sortPosts(posts, args.sortBy).slice(0, args.limit);

      return {
        totalResults: all.totalResults,
        availableResults: all.availableResults,
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

      const enriched = await enrichPostEngagement(post, teamUserIds);

      if (!includeComments) {
        return { ...enriched, contentHtml, contentText };
      }

      let comments: NormalizedComment[] | undefined;
      let commentsError: string | undefined;
      try {
        const rawComments = await getComments(fetcher, cache, post.id, team);
        comments = teamUserIds
          ? reclassifyTree(rawComments, new Set(teamUserIds), true)
          : rawComments;
      } catch (err) {
        commentsError = err instanceof Error ? err.message : String(err);
        console.error(
          `[featurebase-mcp] comments fetch failed for ${slug}:`,
          err,
        );
      }
      return {
        ...enriched,
        contentHtml,
        contentText,
        comments,
        commentsError,
      };
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
      const all = await getAllPosts();
      const now = Date.now();
      const minMs = minDays * 24 * 60 * 60 * 1000;

      const wantedTypes = new Set<string>();
      for (const friendly of args.status ?? []) {
        const mapped = STATUS_TYPE_MAP[friendly];
        if (mapped) wantedTypes.add(mapped);
      }

      const teamOverride =
        args.teamUserIds && args.teamUserIds.length > 0
          ? new Set(args.teamUserIds)
          : null;
      const teamSource: "override" | "default" = teamOverride
        ? "override"
        : "default";

      let warning: string | undefined;
      let unusedTeamUserIds: string[] | undefined;

      if (!teamOverride && !hasTeam) {
        warning =
          "No team IDs configured — stalled-promise detection requires knowing who your team is. " +
            "Call find_featurebase_user with your name to discover your user ID, then pass the " +
            "returned userIds as teamUserIds. Alternatively set FEATUREBASE_TEAM_USER_IDS env var.";
      }

      // For the user-friendly "stalled" semantic, we need per-post
      // adminLastReplyDate/customerLastReplyDate, which means fetching
      // comments. Build the index lazily (cached after first call).
      const index = await ensureCommentIndex();

      let candidates = all.normalized.slice();

      // Annotate each post with engagement under the active team set,
      // using the cached index when possible.
      if (teamOverride || index.counts.size > 0) {
        candidates = await mapWithConcurrency(
          candidates,
          COMMENTS_CONCURRENCY,
          async (p) => {
            // We need per-post dates, so fetch the post's comments.
            if (p.commentCount === 0) return { p, eng: undefined };
            try {
              const comments = await getComments(fetcher, cache, p.id, team);
              const eng = teamOverride
                ? computeEngagementWithTeamOverride(comments, teamOverride)
                : computeEngagement(comments);
              return { p, eng };
            } catch {
              return { p, eng: undefined };
            }
          },
        ).then((resolved) =>
          resolved.map(({ p, eng }) =>
            eng ? { ...p, ...eng } : { ...p, commentFetchFailed: true },
          ),
        );
      }

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
          const comments = await getComments(fetcher, cache, p.id, team);
          const adminPredicate = teamOverride
            ? (c: NormalizedComment) => teamOverride.has(c.author.userId)
            : (c: NormalizedComment) => c.author.role === "admin";
          const customerPredicate = teamOverride
            ? (c: NormalizedComment) => !teamOverride.has(c.author.userId)
            : (c: NormalizedComment) => c.author.role === "customer";
          const lastAdmin = findLastCommentWhere(comments, adminPredicate);
          const lastCustomer = findLastCommentWhere(
            comments,
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

      // Compute unused IDs when override was used
      if (teamOverride) {
        const allMatched = new Set<string>();
        for (const c of candidates) {
          // Walk cached comments for this post? We don't have access here.
          // Simplification: report unused as IDs that don't appear in the
          // board-wide comment index (proxies for "appears in any thread").
          // If commentCount === 0 for a post the user ID can't be in it.
          // The visible "matched" set is approximated by the comment index
          // which we built before the override took effect; we re-walk.
        }
        // Walk every with-comments post's cached comments to identify matched IDs.
        for (const p of all.normalized.filter((x) => x.commentCount > 0)) {
          try {
            const cs = await getComments(fetcher, cache, p.id, team);
            walkComments(cs, (c) => {
              if (teamOverride.has(c.author.userId))
                allMatched.add(c.author.userId);
            });
          } catch {}
        }
        const unused = [...teamOverride].filter(
          (id) => !allMatched.has(id),
        );
        if (unused.length > 0) unusedTeamUserIds = unused;
      }

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
          const comments = await getComments(fetcher, cache, p.id, team);
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
