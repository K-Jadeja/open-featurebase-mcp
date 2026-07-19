// Deterministic cold-cache perf test — no network, no real board.
// Drives createClient() against a complete canned-response mock
// fetcher. Verifies the LAZY-enrichment contract:
//
//   * A cold list call performs listing pages only (no comment fetches).
//   * The first findUser call that needs totalCommentCount triggers
//     comment-page fetching (one set per post-with-comments).
//   * The second findUser call reuses the cached comment index —
//     zero additional fetches.

import { createClient } from "../../dist/client.js";
import {
  buildMockFetcher,
  buildMockPost,
  buildMockComment,
  FIXTURE_USER_IDS,
} from "./__fixtures__.mjs";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// ---- Canned board ----
// 4 posts: p1 (no comments), p2 (no comments), p3 (1 kr-comment),
// p4 (1 kr-comment). Spread across 2 pages so we exercise pagination.
const listingPage1 = [
  buildMockPost({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
  buildMockPost({ id: "p2", slug: "p2", title: "P2", commentCount: 0 }),
];
const listingPage2 = [
  buildMockPost({
    id: "p3",
    slug: "p3",
    title: "P3",
    commentCount: 1,
    author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
  }),
  buildMockPost({
    id: "p4",
    slug: "p4",
    title: "P4",
    commentCount: 1,
    author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
  }),
];

const commentPage_p3 = [
  buildMockComment({
    id: "c3-1",
    userId: FIXTURE_USER_IDS.krAuthor,
    name: "Kr Author",
    createdAt: "2026-01-05T00:00:00Z",
    body: "kr reply",
  }),
];
const commentPage_p4 = [
  buildMockComment({
    id: "c4-1",
    userId: FIXTURE_USER_IDS.krAuthor,
    name: "Kr Author",
    createdAt: "2026-01-06T00:00:00Z",
    body: "kr reply 2",
  }),
];

const mock = buildMockFetcher({
  listingPages: [listingPage1, listingPage2],
  commentPages: { p3: [commentPage_p3], p4: [commentPage_p4] },
});
const client = createClient({ fetcher: mock });

// ============================================================
// Cold listing
// ============================================================
console.log("=== Cold-cache listing (lazy enrichment) ===\n");

const t0 = Date.now();
const r = await client.listPosts({ status: "all", sortBy: "date:desc", limit: 200 });
const elapsed = Date.now() - t0;

console.log(`  wall time: ${elapsed}ms`);
console.log(`  total fetches: ${mock.totalCount()}`);
console.log(`    /api/v1/submission: ${mock.listingCount()}`);
console.log(`    /api/v1/comment:    ${mock.commentCount()}`);
console.log(`  posts returned: ${r.returned}`);

check("tool returned data", r.returned === 4);
check("listing calls = 2 (2-page canned board)", mock.listingCount() === 2);
check("comment calls = 0 (LAZY: defer until find_user)", mock.commentCount() === 0);
check("total fetches = 2 listing only", mock.totalCount() === 2);
check(`wall time < 2s (took ${elapsed}ms)`, elapsed < 2000);

// ============================================================
// First find_user — triggers comment enrichment
// ============================================================
const beforeUser = mock.totalCount();
const t1 = Date.now();
const userResult = await client.findUser({ name: "kr", sampleSize: 5 });
const userElapsed = Date.now() - t1;

console.log("\n=== Cold find_user (triggers lazy enrichment) ===\n");
console.log(`  fetches added by find_user: ${mock.totalCount() - beforeUser}`);
console.log(`  wall time: ${userElapsed}ms`);
console.log(`  matches[0]:`, userResult.matches?.[0]?.name ?? "(none)");
console.log(`  commentsComplete:`, userResult.commentsComplete);

const match0 = userResult.matches?.[0];
const matched =
  match0 && match0.userId === FIXTURE_USER_IDS.krAuthor;

check("find_user matches 'kr' to the fixture user", matched);
check(
  `totalCommentCount = 2 (p3 + p4)`,
  (match0?.totalCommentCount ?? 0) === 2,
);
check("commentsComplete = true (all posts fetched)", userResult.commentsComplete === true);
check(
  `comment fetches = 2 (one per post-with-comments)`,
  mock.commentCount() === 2,
);

// ============================================================
// Second find_user — must be a cache hit
// ============================================================
const beforeSecond = mock.totalCount();
const t2 = Date.now();
await client.findUser({ name: "kr", sampleSize: 5 });
const secondElapsed = Date.now() - t2;
console.log(`\n  second find_user: ${mock.totalCount() - beforeSecond} fetches (took ${secondElapsed}ms)`);

check(
  `second find_user made 0 extra fetches (was ${beforeSecond}, now ${mock.totalCount()})`,
  mock.totalCount() === beforeSecond,
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
