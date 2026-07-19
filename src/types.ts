/**
 * Normalized shapes returned by the Featurebase client.
 * All HTML is stripped from agent-facing strings; raw HTML kept separately
 * where the agent might want it.
 */

/**
 * Role of an author on this Featurebase board.
 *
 * - "admin" — userId is in the configured team set (FEATUREBASE_TEAM_USER_IDS
 *   env var OR the teamUserIds override for the current call).
 * - "customer" — team set is configured but this user is not in it.
 * - "unknown" — no team set is configured at all (we cannot tell).
 *
 * When role is "unknown", engagement fields (hasAdminReply, etc.) are
 * omitted from `NormalizedPost` rather than set to false/0 — silent
 * false values have been the most dangerous failure mode here.
 */
export type CommentRole = "admin" | "customer" | "unknown";

/**
 * Author identity, enriched with board role. Both post and comment authors
 * share this shape so the agent can use one comparison.
 */
export interface NormalizedAuthor {
  /** Display name as the user has set it on Featurebase. */
  name: string;
  /** Avatar URL when present. */
  picture?: string;
  /** Featurebase's internal user ID. Use for cross-referencing the team set. */
  userId: string;
  /**
   * See `CommentRole`. Set to "unknown" when no team IDs are configured —
   * the agent should treat "unknown" as "data is unreliable, call
   * find_featurebase_user or set FEATUREBASE_TEAM_USER_IDS to fix this."
   */
  role: CommentRole;
}

export interface NormalizedPost {
  slug: string;
  /**
   * Featurebase's internal submission ID. Required for fetching the comment
   * thread via /api/v1/comment?submissionId=<id>.
   */
  id: string;
  title: string;
  excerpt: string; // 800-char plain-text preview (appended … if truncated)
  url: string; // Canonical public URL on the Featurebase board
  status: {
    name: string; // "In Review", "Planned", "Open", "Complete", ...
    type: string; // "reviewing" | "planned" | "open" | "complete" | ...
    color: string; // "Sky", "Green", ...
  };
  upvotes: number;
  commentCount: number;
  author: NormalizedAuthor;
  date: string; // ISO
  category: string; // "Feature Request", "Bug", etc.

  // -----------------------------------------------------------------------
  // Engagement metadata — populated ONLY when (a) the post has comments
  // AND (b) comments were successfully fetched AND (c) team IDs are
  // configured. Otherwise these fields are OMITTED (not set to false/0),
  // which is the loud-failure contract for the "no team IDs available"
  // silent-data-corruption bug.
  //
  // When omitted, the agent should assume engagement is unreliable and
  // either (1) call `find_featurebase_user` to look up team IDs, then
  // pass them via `teamUserIds` to engagement-bearing tools, or (2) read
  // the thread directly via `get_featurebase_post(slug, include_comments=true)`.
  // -----------------------------------------------------------------------

  /** True if any comment in the thread was authored by an admin. Omitted when not classified. */
  hasAdminReply?: boolean;
  /** Number of comments authored by admins (across the whole thread). Omitted when not classified. */
  adminReplyCount?: number;
  /** Number of comments authored by customers (across the whole thread). Omitted when not classified. */
  customerCommentCount?: number;
  /** ISO timestamp of the most recent comment (any author). Omitted when not classified. */
  lastCommentDate?: string;
  /** ISO timestamp of the most recent admin comment. Omitted when not classified or no admin reply. */
  adminLastReplyDate?: string;
  /** ISO timestamp of the most recent customer comment. Omitted when not classified. */
  customerLastReplyDate?: string;
  /**
   * True only when the comments fetch failed. Listing returns the post
   * anyway (with commentCount from the listing payload) so agents can
   * still see it; this flag tells the agent engagement fields aren't
   * reliable for this specific post.
   */
  commentFetchFailed?: boolean;
}

export interface NormalizedComment {
  id: string;
  author: NormalizedAuthor;
  bodyHtml: string;
  bodyText: string;
  createdAt: string;
  updatedAt: string;
  upvotes: number;
  /** Null for top-level comments; parent comment id for replies. */
  parentId: string | null;
  /** Direct child replies (nested). Sorted by createdAt asc. */
  replies: NormalizedComment[];
}

/**
 * Role-neutral comment tree — exactly the shape the in-memory cache holds.
 *
 * This is what `getComments()` returns from the cache and what is reused
 * across requests. The cached tree must NOT carry a derived `role` field,
 * because `role` depends on the team set active at *call time*, not at
 * fetch time. Storing role on the cached tree would let a request using
 * `teamUserIds` override pollute the cache for a later request that uses
 * the default team.
 *
 * To produce a `NormalizedComment[]` with roles for a specific call,
 * pass the cached tree through `reclassifyTree(tree, effectiveTeam)`
 * — which builds a fresh role-bearing tree without mutating the cached one.
 */
export interface RoleNeutralComment {
  id: string;
  author: {
    name: string;
    picture?: string;
    userId: string;
  };
  bodyHtml: string;
  bodyText: string;
  createdAt: string;
  updatedAt: string;
  upvotes: number;
  parentId: string | null;
  replies: RoleNeutralComment[];
}

export interface NormalizedPostDetail extends NormalizedPost {
  contentHtml: string;
  contentText: string;
  /**
   * Threaded comments. Present only when explicitly fetched via
   * get_featurebase_post(include_comments=true). Undefined otherwise.
   */
  comments?: NormalizedComment[];
  /**
   * Set when the comments fetch failed but the rest of the post is still
   * valid. The post itself is returned; only comments are missing.
   */
  commentsError?: string;
}
