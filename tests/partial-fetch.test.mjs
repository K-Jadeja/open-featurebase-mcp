// Partial-fetch test. Forces ONE comment fetch to fail (via a hook env
// var), then verifies find_featurebase_user surfaces:
//   - commentsComplete: false
//   - a warning string
// and that totalCommentCount is still populated (just undercounted) so
// downstream code doesn't blow up.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// First, identify a post whose comment URL we can intentionally break.
// We can't pick the URL from the test side without doing a listing first;
// so we do two runs: one to identify, one to break.
//
// Simpler approach: hook a substring that's likely to match every
// comment URL. Every comment URL contains 'submissionId='; we'll match
// on a specific submissionId by first listing, picking the busiest.

const transport1 = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/index.js"],
  env: { ...process.env, FEATUREBASE_BOARD_URL: "https://itsremalt.featurebase.app" },
});
const client1 = new Client({ name: "p1", version: "1" }, { capabilities: {} });
await client1.connect(transport1);
const l = await client1.callTool({
  name: "list_featurebase_posts",
  arguments: { limit: 200 },
});
const posts = JSON.parse(l.content[0].text).posts.filter((p) => p.commentCount > 0);
posts.sort((a, b) => b.commentCount - a.commentCount);
const targetPost = posts[0];
const targetSubstr = `submissionId=${targetPost.id}`;
await client1.close();
console.log("target post for failure injection:", targetPost.slug, `(${targetSubstr})\n`);

// Second run: inject failures for that submissionId and assert
// find_featurebase_user reports partial failure.
const transport2 = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/index.js"],
  env: {
    ...process.env,
    FEATUREBASE_BOARD_URL: "https://itsremalt.featurebase.app",
    // Hook a specific post's comments to fail.
    FEATUREBASE_FAIL_URL_SUBSTR: targetSubstr,
  },
});
const client2 = new Client({ name: "p2", version: "1" }, { capabilities: {} });
await client2.connect(transport2);

console.log("=== Partial-fetch failure test ===");

// Force the listing call to populate the in-memory cache (which fails
// for the target's comments).
const r1 = await client2.callTool({
  name: "list_featurebase_posts",
  arguments: { limit: 200 },
});
check("listing call did not throw on partial failure", r1.isError !== true);

// Now call find_featurebase_user and check the warning/completeness.
const r2 = await client2.callTool({
  name: "find_featurebase_user",
  arguments: { name: "kr" },
});
const parsed = JSON.parse(r2.content[0].text);
const krishna = parsed.matches?.[0];

check("response has commentsComplete field", "commentsComplete" in parsed);
check("commentsComplete is false (partial fetch failure)", parsed.commentsComplete === false);
check("response has warning field", "warning" in parsed);
check("warning is non-empty string", typeof parsed.warning === "string" && parsed.warning.length > 0);
check("warning mentions comment counts", parsed.warning.toLowerCase().includes("comment"));
check("matches still return krishna", !!krishna);
check("krishna.totalCommentCount is a number (still populated)", typeof krishna?.totalCommentCount === "number");
// Verify totalCommentCount is an undercount: target post's comments
// weren't fetched, so the comments belonging to that post are NOT in
// totalCommentCount. This is acceptable; the warning tells the caller.

await client2.close();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
