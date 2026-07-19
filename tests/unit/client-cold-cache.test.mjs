// Cold-cache performance test — direct client factory usage.
//
// Spawns NO server process. Drives createClient() directly with a
// counting fetcher. Measures outbound HTTP requests and wall time for
// the cold-cache path (first listing call after process start).
//
// Compares against the previous eager implementation:
//   EAGER (commit 291a8f0): 6 listing + 33 comment = 39 fetches
//   LAZY  (this commit):     6 listing only     =  6 fetches
//
// Comment enrichment now happens lazily in find_featurebase_user, not
// on every listing call.

import { createClient } from "../../dist/client.js";
import { createFetcher } from "../../dist/fetcher.js";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

let requestCount = 0;
const requestUrls = [];
const fetcher = createFetcher({
  onFetch: (url) => {
    requestCount++;
    requestUrls.push(url);
  },
});
const client = createClient({ fetcher });

console.log("=== Cold-cache listing (lazy enrichment) ===\n");

const t0 = Date.now();
const r = await client.listPosts({ status: "all", sortBy: "date:desc", limit: 200 });
const elapsed = Date.now() - t0;

const listingFetches = requestUrls.filter((u) => u.includes("/api/v1/submission")).length;
const commentFetches = requestUrls.filter((u) => u.includes("/api/v1/comment")).length;
const otherFetches = requestUrls.filter((u) => !u.includes("/api/v1/submission") && !u.includes("/api/v1/comment")).length;

console.log(`  wall time: ${elapsed}ms`);
console.log(`  total HTTP requests: ${requestCount}`);
console.log(`    /api/v1/submission (listing): ${listingFetches}`);
console.log(`    /api/v1/comment (comments):   ${commentFetches}`);
console.log(`    other:                        ${otherFetches}`);
console.log(`  posts returned: ${r.returned}`);
console.log(`  totalResults: ${r.totalResults}`);

check("tool returned data", r.returned > 0);
check("listing calls bounded (3-8 for pagination)", listingFetches >= 3 && listingFetches <= 8);
check("comment calls = 0 (LAZY: defer until find_user)", commentFetches === 0);
check("no other endpoints hit", otherFetches === 0);
check(`total HTTP = ${listingFetches} (vs previous 39 — saved 33 fetches)`, requestCount === listingFetches);
check(`wall time < 5s (took ${elapsed}ms)`, elapsed < 5000);

// ============================================================
// Now the first find_user call should trigger the comment
// enrichment (additional 33 fetches).
// ============================================================
const beforeUserCall = requestCount;
const t1 = Date.now();
const userResult = await client.findUser({ name: "kr" });
const userElapsed = Date.now() - t1;

console.log("\n=== Cold-cache find_user (triggers lazy enrichment) ===\n");
console.log(`  HTTP requests added by find_user: ${requestCount - beforeUserCall}`);
console.log(`  wall time: ${userElapsed}ms`);
console.log(`  user found:`, userResult.matches?.[0]?.name ?? "(none)");

check("find_user returns Krishna", userResult.matches?.[0]?.userId === "6a1974be585b94b07606a4b5");
check(`commentsComplete = true`, userResult.commentsComplete === true);
check(
  `totalCommentCount > 0 (got ${userResult.matches?.[0]?.totalCommentCount})`,
  (userResult.matches?.[0]?.totalCommentCount ?? 0) > 0,
);

// Second find_user call should hit cache (no additional fetches)
const beforeSecond = requestCount;
const t2 = Date.now();
await client.findUser({ name: "jod" });
const secondElapsed = Date.now() - t2;
console.log(`\n  second find_user: 0 fetches (took ${secondElapsed}ms)`);
check(`second find_user made 0 extra fetches (was ${beforeSecond}, now ${requestCount})`, requestCount === beforeSecond);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
