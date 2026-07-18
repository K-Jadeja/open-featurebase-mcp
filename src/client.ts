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
} as const;

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

function normalizeAuthor(raw: any): NormalizedPost["author"] {
  return {
    name: raw?.name ?? "Anonymous",
    picture: raw?.picture,
  };
}

function normalizeCategory(raw: any): string {
  if (!raw) return "Uncategorized";
  if (typeof raw === "string") return raw;
  if (typeof raw.name === "string") return raw.name;
  if (raw.name && typeof raw.name.en === "string") return raw.name.en;
  return "Uncategorized";
}

function normalizePost(raw: any): NormalizedPost {
  const fullText = htmlToText(raw.content ?? "");
  const EXCERPT_LIMIT = 800;
  const truncated = fullText.length > EXCERPT_LIMIT;
  return {
    slug: raw.slug,
    title: raw.title,
    excerpt: truncated
      ? fullText.slice(0, EXCERPT_LIMIT).trimEnd() + "…"
      : fullText,
    url: `${BASE_URL}/posts/${raw.slug}`,
    status: normalizeStatus(raw.postStatus),
    upvotes: raw.upvotes ?? 0,
    commentCount: raw.commentCount ?? 0,
    author: normalizeAuthor(raw.user),
    date: raw.date ?? "",
    category: normalizeCategory(raw.postCategory),
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

  // Fetch page 1 to discover totalPages + totalResults.
  const first = await fetchApiPage(1);
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
  const normalized = raw.map(normalizePost);
  const out: ListingPayload = {
    raw,
    normalized,
    totalResults,
    availableResults: raw.length,
  };
  cacheSet(cacheKey, out, TTL.listing);
  return out;
}

// ---------------------------------------------------------------------------
// Comments — UNSUPPORTED
//
// Featurebase post detail pages (`/posts/<slug>`) are statically rendered as
// 404 shells by Next.js; the dynamic post data, including the comment thread,
// is loaded by client-side JavaScript that calls internal API endpoints we
// can't reach from a non-browser fetch. As a result, comment BODIES are not
// scrapable from public HTML.
//
// The `commentCount` field IS still available — it ships with each post in
// the SSR-bundled listing payload.
//
// If a caller asks for comments, we throw loudly rather than silently
// returning null. Silent degradation on data fetches is a footgun.
// ---------------------------------------------------------------------------

function unsupportedCommentsError(): never {
  throw new McpError(
    ErrorCode.InternalError,
    "Comment bodies are not available from the public board HTML — Featurebase " +
      "loads them via client-side JavaScript against internal API endpoints " +
      "we cannot reach. The post's commentCount is included in the metadata " +
      "returned by get_featurebase_post; visit the post URL directly in a " +
      "browser to read the full comment thread.",
  );
}

// ---------------------------------------------------------------------------
// Public client surface
// ---------------------------------------------------------------------------

export interface ListPostsArgs {
  status: "all" | "open" | "in_review" | "planned" | "in_progress" | "completed";
  sortBy: "date:desc" | "date:asc" | "upvotes:desc";
  limit: number;
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
  ): Promise<NormalizedPostDetail> {
    const all = await getAllPosts();
    const raw = all.raw.find((p) => p.slug === slug);
    if (!raw) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Post not found: "${slug}". Use list_featurebase_posts to discover valid slugs.`,
      );
    }

    if (includeComments) {
      // Loud failure — comments are not scrapable. Don't silently degrade.
      unsupportedCommentsError();
    }

    const post = normalizePost(raw);
    const contentHtml = raw.content ?? "";
    const contentText = htmlToText(contentHtml);

    return {
      ...post,
      contentHtml,
      contentText,
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

  async getPosts(args: GetPostsArgs) {
    const all = await getAllPosts();
    const includeContent = args.include_content ?? false;

    const found: Array<NormalizedPost | NormalizedPostDetail> = [];
    const notFound: string[] = [];

    for (const slug of args.slugs) {
      const raw = all.raw.find((p) => p.slug === slug);
      if (!raw) {
        notFound.push(slug);
        continue;
      }
      const post = normalizePost(raw);
      if (includeContent) {
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