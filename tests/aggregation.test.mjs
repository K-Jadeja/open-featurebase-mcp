// Deterministic unit tests for comment-count aggregation. Pure function
// over synthetic NormalizedComment trees — no network, no MCP.

import { aggregateCommentCounts } from "../dist/index.js";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
function eq(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// Helper: build a NormalizedComment with optional replies
function c(userId, replies = []) {
  return {
    id: `c-${userId}-${Math.random()}`,
    author: {
      name: `User ${userId}`,
      userId,
      role: "customer",
    },
    bodyHtml: "",
    bodyText: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    upvotes: 0,
    parentId: null,
    replies,
  };
}

// --- empty input ---
{
  const counts = aggregateCommentCounts([]);
  check("empty input → empty map", counts.size === 0);
}

// --- single comment from one user ---
{
  const comments = [c("alice")];
  const counts = aggregateCommentCounts(comments);
  check("single comment counts", eq([...counts], [["alice", 1]]));
}

// --- multiple comments, multiple users ---
{
  const comments = [
    c("alice"),
    c("bob"),
    c("alice"),
    c("carol"),
    c("bob"),
    c("bob"),
  ];
  const counts = aggregateCommentCounts(comments);
  check("multi-author counts", eq([...counts].sort(), [["alice", 2], ["bob", 3], ["carol", 1]]));
}

// --- nested replies count too ---
{
  const inner = [c("alice"), c("alice")];
  const comments = [
    c("bob", [
      c("carol", inner), // alice appears in nested replies
      c("alice"),         // alice in direct reply
    ]),
    c("dave"),
  ];
  const counts = aggregateCommentCounts(comments);
  check(
    "replies counted recursively (alice=3, bob=1, carol=1, dave=1)",
    eq(
      [...counts].sort(),
      [["alice", 3], ["bob", 1], ["carol", 1], ["dave", 1]],
    ),
  );
}

// --- deeply nested ---
{
  const comments = [
    c("a", [c("b", [c("c", [c("d")])])]),
  ];
  const counts = aggregateCommentCounts(comments);
  check(
    "deeply nested (a=b=c=d=1)",
    eq(
      [...counts].sort(),
      [["a", 1], ["b", 1], ["c", 1], ["d", 1]],
    ),
  );
}

// --- realistic stalled-promise scenario ---
{
  // Krishna (admin) → Akhilesh (customer) → Krishna → Akhilesh
  const comments = [
    c("krishna", [c("akhilesh", [c("krishna"), c("akhilesh")])]),
    c("random"),
  ];
  const counts = aggregateCommentCounts(comments);
  check(
    "krishna=2, akhilesh=2, random=1",
    eq(
      [...counts].sort(),
      [["akhilesh", 2], ["krishna", 2], ["random", 1]],
    ),
  );
}

console.log(`\n=== Aggregation tests: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
