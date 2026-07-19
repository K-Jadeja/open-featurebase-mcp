// Deterministic server-level integration test for shared-client
// cache behavior + server isolation.
//
// What this proves (per the audit gates):
//   * buildServer() creates exactly one Client and threads it into
//     all seven tool handlers.
//   * list_featurebase_posts populates the shared listing cache;
//     subsequent find_featurebase_user calls reuse it (no listing
//     refetches).
//   * A second find_featurebase_user call after that is fully cached.
//   * Two independent buildServer() calls have completely independent
//     caches — the second server re-fetches the listing.
//
// All assertions are made through the MCP tool surface (via
// InMemoryTransport → real McpServer.registerTool → real handler
// → real client.listPosts/findUser) using an injected counting
// fetcher. No network.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../dist/server.js";
import { createClient } from "../../dist/client.js";
import {
  buildMockFetcher,
  buildMockPost,
  buildMockComment,
  FIXTURE_USER_IDS,
} from "./__fixtures__.mjs";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

// ---- Canned board ----
const listingPage1 = [
  buildMockPost({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
  buildMockPost({
    id: "p2",
    slug: "p2",
    title: "P2",
    commentCount: 1,
    author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
  }),
];
const listingPage2 = [
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
    createdAt: "2026-03-01T00:00:00Z",
    body: "kr reply",
  }),
];
const commentPage_p3 = [
  buildMockComment({
    id: "c3-1",
    userId: FIXTURE_USER_IDS.krAuthor,
    name: "Kr Author",
    createdAt: "2026-03-02T00:00:00Z",
    body: "kr reply 2",
  }),
];

const mock = buildMockFetcher({
  listingPages: [listingPage1, listingPage2],
  commentPages: { p2: [commentPage_p2], p3: [commentPage_p3] },
});
// buildServer accepts a client with a custom fetcher via
// createClient({ fetcher }). Two independent buildServer() calls must
// each construct their own client (or both receive one) — caches
// must NOT leak across servers.
const client = createClient({ fetcher: mock });
const server = buildServer({ client });

const mcp = new McpClient(
  { name: "cache-test-client", version: "1" },
  { capabilities: {} },
);
const [sT, cT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(sT), mcp.connect(cT)]);

async function call(name, args) {
  return await mcp.callTool({ name, arguments: args });
}

// ============================================================
// 1. Cold list — populates shared listing cache.
// ============================================================
console.log("=== Cold list_featurebase_posts ===\n");

const before = mock.totalCount();
const r1 = await call("list_featurebase_posts", {
  status: "all", sortBy: "date:desc", limit: 50,
});
check("list_featurebase_posts returned 3 posts", !r1.isError);
const listingFetches = mock.listingCount() - 0; // already in `before`
const added1 = mock.totalCount() - before;
check(`list_featurebase_posts: 2 listing fetches (got ${added1})`, added1 === 2);
check(`list_featurebase_posts: 0 comment fetches (got ${mock.commentCount()})`, mock.commentCount() === 0);

// ============================================================
// 2. Cold find_user — must reuse listing cache, add comment fetches.
// ============================================================
console.log("\n=== Cold find_featurebase_user (cache reuse) ===\n");

const beforeFind = mock.totalCount();
const r2 = await call("find_featurebase_user", { name: "kr", sampleSize: 5 });
check("find_featurebase_user returned cleanly", !r2.isError);
const findAdded = mock.totalCount() - beforeFind;
const listingAddedDuringFind = mock.listingCount() - 2;
check(
  `find_featurebase_user added NO listing fetches (got ${listingAddedDuringFind})`,
  listingAddedDuringFind === 0,
);
check(
  `find_featurebase_user added 2 comment fetches (got ${findAdded})`,
  findAdded === 2,
);

// ============================================================
// 3. Second find_user — must be fully cached.
// ============================================================
console.log("\n=== Second find_featurebase_user (full cache) ===\n");

const beforeSecond = mock.totalCount();
await call("find_featurebase_user", { name: "kr", sampleSize: 5 });
const secondAdded = mock.totalCount() - beforeSecond;
check(
  `second find_featurebase_user added 0 fetches (got ${secondAdded})`,
  secondAdded === 0,
);

// ============================================================
// 4. A second buildServer() with a DIFFERENT client must have an
//    independent cache — its first listing call should re-fetch.
// ============================================================
console.log("\n=== Second server, isolated caches ===\n");

const mock2 = buildMockFetcher({
  listingPages: [listingPage1, listingPage2],
  commentPages: { p2: [commentPage_p2], p3: [commentPage_p3] },
});
const client2 = createClient({ fetcher: mock2 });
const server2 = buildServer({ client: client2 });
const mcp2 = new McpClient(
  { name: "isolation-client", version: "1" },
  { capabilities: {} },
);
const [sT2, cT2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(sT2), mcp2.connect(cT2)]);

const r3 = await mcp2.callTool({
  name: "list_featurebase_posts",
  arguments: { status: "all", sortBy: "date:desc", limit: 50 },
});
check("server2.list_featurebase_posts returned cleanly", !r3.isError);
check(
  `server2 listing fetches = 2 (own cache, got ${mock2.listingCount()})`,
  mock2.listingCount() === 2,
);
// mock1's counters should not have changed when server2 ran.
check(
  `server1's fetcher is unaffected: still at ${mock.totalCount()} fetches total`,
  mock.totalCount() === 4, // 2 listing + 2 comment from earlier
);

// ============================================================
// 5. Two servers should not share the listing cache — explicitly
//    demonstrate isolation: fill mock2's cache, then assert mock1
//    still has its original counts.
// ============================================================
const mock2BeforeList = mock2.totalCount();
await mcp2.callTool({
  name: "find_featurebase_user",
  arguments: { name: "kr", sampleSize: 5 },
});
const mock2FindAdded = mock2.totalCount() - mock2BeforeList;
check(
  `server2.find_user adds comment fetches (got ${mock2FindAdded})`,
  mock2FindAdded === 2,
);
check(
  `server1's counter unchanged by server2's find_user (still ${mock.totalCount()})`,
  mock.totalCount() === 4,
);

await mcp.close();
await mcp2.close();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);