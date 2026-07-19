/**
 * Walk a comment tree (top-level + nested replies) and tally each
 * author's comment count. Pure function over the input — exposed so
 * unit tests can drive deterministic aggregation without making HTTP
 * calls.
 *
 * Accepts any tree whose nodes carry `author.userId` and `replies` —
 * both `NormalizedComment` (role-tagged) and `RoleNeutralComment`
 * (cached shape) qualify, so callers don't have to reclassify the
 * cached tree just to compute this.
 */
type AnyCommentNode = {
  author: { userId: string };
  replies: readonly AnyCommentNode[];
};

export function aggregateCommentCounts(
  comments: readonly AnyCommentNode[],
): Map<string, number> {
  const counts = new Map<string, number>();
  function walk(comment: AnyCommentNode): void {
    counts.set(
      comment.author.userId,
      (counts.get(comment.author.userId) ?? 0) + 1,
    );
    for (const reply of comment.replies) walk(reply);
  }
  for (const root of comments) walk(root);
  return counts;
}