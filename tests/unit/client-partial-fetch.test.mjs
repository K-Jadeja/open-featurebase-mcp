// Partial-fetch test — direct createClient with a controlled fetcher
// that fails for one comment. Verifies:
//   - commentsComplete: false in the response
//   - warning field is non-empty
//   - totalCommentCount is still populated (undercount flagged by warning)

import { createClient } from "../../dist/client.js";
import { createFetcher } from "../../dist/fetcher.js";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// We need real-ish listing data, so use a real underlying fetch but
// inject failures into comment fetches specifically.
let listingCount = 0;
const realFetcher = createFetcher();
const failingFetcher = {
  async fetch(url, init) {
    // Fail any comment fetch that contains a specific submissionId.
    // First, we don't yet know which submissionId — let the listing
    // pass through, find a post with comments, then re-run with the
    // fetcher pointed at it.
    if (url.includes("/api/v1/comment") && process.env.__FAIL_SUBSTR__) {
      if (url.includes(process.env.__FAIL_SUBSTR__)) {
        throw new Error(`injected fetch failure for ${url}`);
      }
    }
    listingCount++;
    return realFetcher.fetch(url, init);
  },
};

const client = createClient({ fetcher: failingFetcher });

console.log("=== Partial-fetch failure test (lazy find_user path) ===\n");

// First, do a plain listing to learn the busiest submissionId
const initial = await client.listPosts({ status: "all", sortBy: "date:desc", limit: 200 });
const postsWithComments = initial.posts
  .filter((p) => p.commentCount > 0)
  .sort((a, b) => b.commentCount - a.commentCount);
const target = postsWithComments[0];
console.log("target post:", target.slug, `(substr: submissionId=${target.id})`);

// Now enable the failure for that post
process.env.__FAIL_SUBSTR__ = `submissionId=${target.id}`;

// find_user triggers comment enrichment; that fetch will fail
const result = await client.findUser({ name: "kr" });

check("response has commentsComplete field", "commentsComplete" in result);
check(`commentsComplete = false (one fetch failed)`, result.commentsComplete === false);
check("response has warning field", "warning" in result);
check("warning is non-empty string", typeof result.warning === "string" && result.warning.length > 0);
check("warning mentions comment counts", result.warning.toLowerCase().includes("comment"));
check("matches still return (undercount, not empty)", Array.isArray(result.matches) && result.matches.length > 0);

const krishna = result.matches[0];
if (krishna) {
  check(
    `krishna.totalCommentCount still populated (undercount = ${krishna.totalCommentCount})`,
    typeof krishna.totalCommentCount === "number",
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
