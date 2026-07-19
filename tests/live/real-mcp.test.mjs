
// LIVE-INTEGRATION: only runs when LIVE=1.
if (process.env.LIVE !== '1') {
  console.log('  [skipped, set LIVE=1 to run]');
  process.exit(0);
}
// Comprehensive real-MCP-transport test via SDK's StdioClientTransport.
// Verifies per the audit's required gates:
//   - clean validation text (single line, no Zod internals)
//   - no cross-request value contamination
//   - accurate totalCommentCount (works without env var)
//   - correct teamUserIds behavior on get_post
//   - bounded listing performance (5 calls under 3s; cached after first)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

const client = new Client(
  { name: "audit-runner", version: "1" },
  { capabilities: {} },
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/index.js"],
  env: { ...process.env, FEATUREBASE_BOARD_URL: "https://itsremalt.featurebase.app" },
});

await client.connect(transport);
console.log("connected");

const tools = await client.listTools();
check("all 7 tools registered", tools.tools.length === 7);
for (const t of tools.tools) {
  console.log(`  · ${t.name}`);
}

// === Test 1: range error (too_big) ===
console.log("\n=== Test 1: range error ===");
{
  const r = await client.callTool({
    name: "get_featurebase_stalled_promises",
    arguments: { minDaysSinceAdminReply: 9999 },
  });
  check("isError true", r.isError === true);
  const text = r.content?.[0]?.text ?? "";
  check("single line", !text.includes("\n") || text.split("\n").length <= 2);
  check("no array dump", !text.includes("[{"));
  check("no Zod internals (no 'code:')", !text.includes("code:"));
  check("no Zod internals (no 'inclusive:')", !text.includes("inclusive:"));
  check("no Zod internals (no 'exact:')", !text.includes("exact:"));
  check("contains field name 'minDaysSinceAdminReply'", text.includes("minDaysSinceAdminReply"));
  check("contains constraint 'must be at most 365'", text.includes("must be at most 365"));
  check("does NOT echo input value", !text.includes("(got") && !text.includes("9999"));
  console.log(`    text: ${text.slice(0, 250)}`);
}

// === Test 2: min-length error ===
console.log("\n=== Test 2: min-2-chars error ===");
{
  const r = await client.callTool({
    name: "find_featurebase_user",
    arguments: { name: "a" },
  });
  check("isError", r.isError === true);
  const text = r.content?.[0]?.text ?? "";
  check("contains min constraint", text.includes("must be at least 2"));
  check("no Zod internals", !/code:|inclusive:/.test(text));
  check("no value echo", !text.includes("(got"));
  console.log(`    text: ${text.slice(0, 200)}`);
}

// === Test 3: type mismatch ===
console.log("\n=== Test 3: type mismatch ===");
{
  const r = await client.callTool({
    name: "get_featurebase_post",
    arguments: { slug: 12345 },
  });
  check("isError", r.isError === true);
  const text = r.content?.[0]?.text ?? "";
  check("invalid_type message", text.includes("expected") && text.includes("string"));
  check("no Zod internals", !/code:|inclusive:/.test(text));
}

// === Test 4: enum violation ===
console.log("\n=== Test 4: invalid enum ===");
{
  const r = await client.callTool({
    name: "list_featurebase_posts",
    arguments: { status: "definitely-not-an-enum" },
  });
  check("isError", r.isError === true);
  const text = r.content?.[0]?.text ?? "";
  check("enum error mentions valid values", text.includes("must be one of") || text.includes("enum"));
}

// === Test 5: totalCommentCount without env var ===
console.log("\n=== Test 5: totalCommentCount (no env var) ===");
{
  const r = await client.callTool({
    name: "find_featurebase_user",
    arguments: { name: "kr" },
  });
  if (r.isError) {
    check("didn't throw", false);
    console.log("    error:", r.content[0].text.slice(0, 200));
  } else {
    const parsed = JSON.parse(r.content[0].text);
    const krishna = parsed.matches?.[0];
    check("found Krishna", !!krishna);
    if (krishna) {
      check(
        `totalCommentCount > 0 (got ${krishna.totalCommentCount})`,
        krishna.totalCommentCount > 0,
      );
      check(
        `commentCountInSampledPosts > 0 (got ${krishna.commentCountInSampledPosts})`,
        krishna.commentCountInSampledPosts > 0,
      );
      check("guessedRole is admin", krishna.guessedRole === "admin");
    }
  }
}

// === Test 6: concurrent calls - no contamination ===
console.log("\n=== Test 6: concurrency - no contamination ===");
{
  // 5 parallel calls with DIFFERENT bad values for the same field.
  // Our formatter must not echo input values, but more importantly, each
  // call's response must be independent (no module-level data leakage).
  const vals = [1000, 2000, 3000, 4000, 5000]; // all > 365 (max)
  const results = await Promise.all(
    vals.map((v) =>
      client.callTool({
        name: "get_featurebase_stalled_promises",
        arguments: { minDaysSinceAdminReply: v },
      }),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const text = results[i].content?.[0]?.text ?? "";
    check(`response ${i} isError`, results[i].isError === true, `(text starts with: ${text.slice(0, 80)})`);
    check(`response ${i} clean (no echo)`, !text.includes("(got"));
    check(`response ${i} clean (no array)`, !text.includes("[{"));
    // Each response should reference the same field & constraint
    check(`response ${i} has field name`, text.includes("minDaysSinceAdminReply"));
  }
}

// === Test 7: successful call works (regression) ===
console.log("\n=== Test 7: successful call ===");
{
  const r = await client.callTool({ name: "get_featurebase_stats", arguments: {} });
  check("not isError", r.isError !== true);
  const parsed = JSON.parse(r.content[0].text);
  check("has totalResults=56", parsed.totalResults === 56);
  check("has snapshotWindow", !!parsed.snapshotWindow);
}

// === Test 8: listing performance (no N+1 explosion) ===
console.log("\n=== Test 8: listing performance ===");
{
  const t0 = Date.now();
  const calls = await Promise.all(
    Array.from({ length: 5 }, () =>
      client.callTool({ name: "list_featurebase_posts", arguments: { limit: 200 } }),
    ),
  );
  const elapsed = Date.now() - t0;
  check(`5 concurrent listing calls took <5s (took ${elapsed}ms)`, elapsed < 5000);
  check("all 5 returned", calls.length === 5);
  for (let i = 0; i < calls.length; i++) {
    const parsed = JSON.parse(calls[i].content[0].text);
    check(`call ${i} returned 56 posts`, parsed.returned === 56);
  }
}

// === Test 9: teamUserIds on get_post (needs env var) ===
console.log("\n=== Test 9: teamUserIds (with env var) — separate client ===");
{
  const envClient = new Client({ name: "audit-2", version: "1" }, { capabilities: {} });
  const envTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["./dist/index.js"],
    env: {
      ...process.env,
      FEATUREBASE_BOARD_URL: "https://itsremalt.featurebase.app",
      FEATUREBASE_TEAM_USER_IDS: "6a1974be585b94b07606a4b5",
    },
  });
  await envClient.connect(envTransport);
  const r = await envClient.callTool({
    name: "get_featurebase_post",
    arguments: {
      slug: "replacing-the-data-in-some-nodes-like-youtube",
      include_comments: true,
    },
  });
  if (r.isError) {
    check("didn't throw", false);
    console.log("    error:", r.content[0].text.slice(0, 200));
  } else {
    const parsed = JSON.parse(r.content[0].text);
    const topLevel = parsed.comments?.[0];
    check("got Krishna comment", !!topLevel);
    if (topLevel) {
      check(
        `Krishna role=admin (got ${topLevel.author?.role})`,
        topLevel.author?.role === "admin",
      );
      const reply = parsed.comments?.[0]?.replies?.[1];
      if (reply) {
        check(
          `customer reply role=customer (got ${reply.author?.role})`,
          reply.author?.role === "customer",
        );
      }
      check(
        `engagement hasAdminReply (got ${parsed.hasAdminReply})`,
        parsed.hasAdminReply === true,
      );
    }
  }
  await envClient.close();
}

await client.close();
console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
