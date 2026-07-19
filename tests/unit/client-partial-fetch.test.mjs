// Deterministic partial-fetch failure test — no live network.
//
// Drives createClient() against a mock fetcher that fails ONE
// comment fetch out of two. Verifies the loud-failure contract:
//   - commentsComplete: false in the response
//   - warning field is non-empty
//   - matches still return (undercount, not empty)
//   - totalCommentCount is still populated (undercount flagged by warning)

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
// 3 posts: p1 (no comments), p2 (1 kr-comment), p3 (1 kr-comment).
const listingPage1 = [
  buildMockPost({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
  buildMockPost({
    id: "p2",
    slug: "p2",
    title: "P2",
    commentCount: 1,
    author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
  }),
  buildMockPost({
    id: "p3",
    slug: "p3",
    title: "P3",
    commentCount: 1,
    author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
  }),
];

const commentPage_p2 = [
  buildMockComment({
    id: "c2-1",
    userId: FIXTURE_USER_IDS.krAuthor,
    name: "Kr Author",
    createdAt: "2026-02-01T00:00:00Z",
    body: "kr reply p2",
  }),
];
const commentPage_p3 = [
  buildMockComment({
    id: "c3-1",
    userId: FIXTURE_USER_IDS.krAuthor,
    name: "Kr Author",
    createdAt: "2026-02-02T00:00:00Z",
    body: "kr reply p3",
  }),
];

// Wrap buildMockFetcher's fetch so we can selectively throw on the
// p2 comment page request. The fetch must increment the call
// counter consistently with the mock's own bookkeeping, so we
// delegate to the underlying mock.fetch after our check.
const baseMock = buildMockFetcher({
  listingPages: [listingPage1],
  commentPages: { p2: [commentPage_p2], p3: [commentPage_p3] },
});

const failingFetcher = {
  async fetch(url, init) {
    if (url.includes("/api/v1/comment") && url.includes("submissionId=p2")) {
      // Record the attempt so the test's counters still see it.
      baseMock.calls.push(url);
      throw new Error(`injected fetch failure for ${url}`);
    }
    return baseMock.fetch(url, init);
  },
};

const client = createClient({ fetcher: failingFetcher });
console.log("=== Partial-fetch failure test (lazy find_user path) ===\n");

// Trigger find_user — p2's comment fetch throws, p3's succeeds.
const result = await client.findUser({ name: "kr", sampleSize: 5 });

check("response has commentsComplete field", "commentsComplete" in result);
check("commentsComplete = false (one fetch failed)", result.commentsComplete === false);
check("response has warning field", "warning" in result);
check(
  "warning is non-empty string",
  typeof result.warning === "string" && result.warning.length > 0,
);
check("warning mentions comment counts", result.warning.toLowerCase().includes("comment"));
check(
  "matches still return (undercount, not empty)",
  Array.isArray(result.matches) && result.matches.length > 0,
);

const match0 = result.matches[0];
check(
  `match0 is the kr user`,
  match0?.userId === FIXTURE_USER_IDS.krAuthor,
);
check(
  `totalCommentCount still populated (undercount = ${match0?.totalCommentCount})`,
  typeof match0?.totalCommentCount === "number",
);
check(
  "undercount (1) < real count (2) — partial fetch flagged",
  match0.totalCommentCount < 2,
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
