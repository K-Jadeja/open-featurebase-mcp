import type { NormalizedComment } from "./types.js";

/**
 * Walk a comment tree (top-level + nested replies) and tally each
 * author's comment count. Pure function over the input — exposed so
 * unit tests can drive deterministic aggregation without making HTTP
 * calls.
 */
export function aggregateCommentCounts(
  comments: NormalizedComment[],
): Map<string, number> {
  const counts = new Map<string, number>();
  function walk(comment: NormalizedComment): void {
    counts.set(
      comment.author.userId,
      (counts.get(comment.author.userId) ?? 0) + 1,
    );
    for (const reply of comment.replies) walk(reply);
  }
  for (const root of comments) walk(root);
  return counts;
}
