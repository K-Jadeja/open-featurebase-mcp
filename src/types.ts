/**
 * Normalized shapes returned by the Featurebase client.
 * All HTML is stripped from agent-facing strings; raw HTML kept separately
 * where the agent might want it.
 */

export interface NormalizedPost {
  slug: string;
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
  author: {
    name: string;
    picture?: string;
  };
  date: string; // ISO
  category: string; // "Feature Request", "Bug", etc.
}

export interface NormalizedPostDetail extends NormalizedPost {
  contentHtml: string;
  contentText: string;
}