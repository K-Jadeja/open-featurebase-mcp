/**
 * Normalized shapes returned by the Featurebase client.
 * All HTML is stripped from agent-facing strings; raw HTML kept separately
 * where the agent might want it.
 */

/** Role of an author on this Featurebase board. */
export type CommentRole = "admin" | "customer";

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
   * "admin" if the userId is in the org's admin set or the
   * FEATUREBASE_TEAM_USER_IDS env var; "customer" otherwise.
   *
   * Note: `/api/v1/organization`'s `admins` field is the org OWNER, not the
   * full team that comments on the board. To get the comment-author team
   * tagged correctly, set `FEATUREBASE_TEAM_USER_IDS=id1,id2` in the env.
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
