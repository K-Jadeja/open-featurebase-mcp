// Deterministic role-classification regression suite.
//
// Covers every path through engagement that classifies comments and
// posts by role, with explicit attention to the "no team configured"
// path that previously fabricated customer classifications.
//
// Tests are wired through the real MCP tool surface via InMemoryTransport
// so the input validation, schema advertisement, handler routing, and
// client interaction all run together — not just the client methods in
// isolation.
//
// Each scenario builds its own server with its own env-controlled
// client so the FEATUREBASE_TEAM_USER_IDS env var is read at factory
// time as the production code expects (see readTeamUserIds in
// client.ts). Tests run sequentially to avoid cross-test env leakage.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../dist/server.js";
import { createClient } from "../../dist/client.js";
import {
  buildMockFetcher,
  buildMockPost,
  buildMockComment,
} from "./__fixtures__.mjs";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

async function bootServer({ teamEnv = "", commentPages = {} } = {}) {
  // Env must be set BEFORE createClient() so readTeamUserIds() captures
  // it at factory invocation time.
  if (teamEnv) process.env.FEATUREBASE_TEAM_USER_IDS = teamEnv;
  else delete process.env.FEATUREBASE_TEAM_USER_IDS;

  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other Person" },
    }),
  ];
  // Default fixture: alice (admin) replies, then customer (bob) replies
  // later — qualifies as a stalled promise when team includes alice.
  // Override tests reclassify against whichever team they pass.
  const finalComments = commentPages.p1 ?? [[
    buildMockComment({
      id: "c1", userId: "alice-id", name: "Alice",
      createdAt: "2026-05-01T00:00:00Z",
    }),
    buildMockComment({
      id: "c2", userId: "bob-id", name: "Bob",
      createdAt: "2026-06-15T00:00:00Z",
    }),
  ]];
  const mock = buildMockFetcher({
    listingPages: [board],
    commentPages: { p1: finalComments },
  });
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "role-classification-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  return { mock, mcp, server, client };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

// ============================================================
// Scenario 1: default env team, no override.
// alice is in the team → role "admin" everywhere.
// ============================================================
console.log("\n=== Scenario 1: default env team, no override ===\n");
{
  const { mcp, mock, server, client } = await bootServer({
    teamEnv: "alice-id",
  });
  try {
    // list_featurebase_posts (no hasAdminReply) — author role only.
    const listResult = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    const listBody = parseText(listResult);
    const p1 = listBody.posts[0];
    check(
      "list: p1.author.role === 'customer' (post author 'other-id' is NOT in env team)",
      p1?.author?.role === "customer",
      `got: ${p1?.author?.role}`,
    );
    check(
      "list: post author userId is preserved",
      p1?.author?.userId === "other-id",
      `got: ${p1?.author?.userId}`,
    );
    // Note: list without hasAdminReply does NOT fetch comments, so the
    // comment author's role is not exposed here. That's correct lazy.

    // get_featurebase_post with comments — comment author role should be admin.
    const postResult = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const postBody = parseText(postResult);
    const c1 = postBody.comments?.[0];
    check(
      "get_post: comment author role === 'admin' (alice is in env team)",
      c1?.author?.role === "admin",
      `got: ${c1?.author?.role}`,
    );

    // get_featurebase_stalled_promises — adminLastReplyDate must be set.
    const stalled = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 0, limit: 10 },
    });
    const stalledBody = parseText(stalled);
    check(
      "stalled: returned non-empty (post qualifies with admin reply)",
      Array.isArray(stalledBody.promises) && stalledBody.promises.length > 0,
      `got ${stalledBody.promises?.length ?? 0}`,
    );
    check(
      "stalled: warning is absent (team is configured via env)",
      stalledBody.warning === undefined,
      `got: ${stalledBody.warning}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 2: no team at all (no env, no override).
// Roles must be 'unknown'; engagement fields absent.
// ============================================================
console.log("\n=== Scenario 2: no team — unknown + absent fields ===\n");
{
  const { mcp, mock, server, client } = await bootServer({ teamEnv: "" });
  try {
    // list_featurebase_posts (no hasAdminReply) — author role should be unknown.
    const listResult = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    const listBody = parseText(listResult);
    const p1 = listBody.posts[0];
    check(
      "list: post author role === 'unknown'",
      p1?.author?.role === "unknown",
      `got: ${p1?.author?.role}`,
    );
    check(
      "list: no engagement fields (hasAdminReply absent)",
      p1?.hasAdminReply === undefined,
    );

    // get_featurebase_post with comments — comment role should be unknown.
    const postResult = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const postBody = parseText(postResult);
    const c1 = postBody.comments?.[0];
    check(
      "get_post: comment author role === 'unknown'",
      c1?.author?.role === "unknown",
      `got: ${c1?.author?.role}`,
    );
    check(
      "get_post: post has NO engagement fields (no team configured)",
      postBody.hasAdminReply === undefined &&
        postBody.adminReplyCount === undefined,
      `got: hasAdminReply=${postBody.hasAdminReply}, adminReplyCount=${postBody.adminReplyCount}`,
    );

    // stalled-promises must short-circuit: warning + empty + zero comment fetches.
    const beforeStalled = mock.commentCount();
    const stalled = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 7, limit: 10 },
    });
    const stalledBody = parseText(stalled);
    check(
      "stalled: warning is set (no team configured)",
      typeof stalledBody.warning === "string" && stalledBody.warning.length > 0,
    );
    check(
      "stalled: returned promises is empty",
      Array.isArray(stalledBody.promises) && stalledBody.promises.length === 0,
      `got: ${JSON.stringify(stalledBody.promises)}`,
    );
    check(
      "stalled: zero new comment fetches on no-team path",
      mock.commentCount() === beforeStalled,
      `before=${beforeStalled}, after=${mock.commentCount()}`,
    );
    check(
      "stalled: no fabricated customer/admin classifications in response",
      // Even though promises[] is empty, sanity-check: no key like
      // "lastAdminMsg" or "lastCustomerMsg" anywhere in the body that
      // would imply a classification was made.
      !("lastAdminMessage" in stalledBody),
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 3: explicit override wins over default.
// Env says alice; override says bob. Bob → admin, alice → customer.
// ============================================================
console.log("\n=== Scenario 3: explicit override wins over env team ===\n");
{
  const { mcp, mock, server, client } = await bootServer({
    teamEnv: "alice-id",
  });
  try {
    const postResult = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["bob-id"],
      },
    });
    const c1 = parseText(postResult).comments?.[0];
    check(
      "override='bob-id': comment author role === 'customer' (alice not in override)",
      c1?.author?.role === "customer",
      `got: ${c1?.author?.role}`,
    );

    // Now flip the override to include alice → alice should be admin.
    const postResult2 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["alice-id"],
      },
    });
    const c1b = parseText(postResult2).comments?.[0];
    check(
      "override='alice-id': comment author role === 'admin'",
      c1b?.author?.role === "admin",
      `got: ${c1b?.author?.role}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 4: empty override is consistently treated as absent.
// (env has alice; override=[]; alice should remain admin — i.e.
// empty override does NOT override the env team to empty).
// ============================================================
console.log("\n=== Scenario 4: empty override = absent (does not null env team) ===\n");
{
  const { mcp, mock, server, client } = await bootServer({
    teamEnv: "alice-id",
  });
  try {
    const postResult = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: [], // empty array
      },
    });
    const c1 = parseText(postResult).comments?.[0];
    check(
      "empty override does NOT demote alice: comment role === 'admin'",
      c1?.author?.role === "admin",
      `got: ${c1?.author?.role}`,
    );

    // Same call with NO override field at all → same outcome.
    const postResult2 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const c1b = parseText(postResult2).comments?.[0];
    check(
      "no override field behaves identically to empty override",
      c1b?.author?.role === c1?.author?.role,
      `empty=${c1?.author?.role}, missing=${c1b?.author?.role}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 5: cached comments classify per-request, in any order.
// Same client + cached comments; override A → env team → override B;
// reverse order; verify each result reflects its own team without
// cross-call contamination.
// ============================================================
console.log("\n=== Scenario 5: per-request classification, any order ===\n");
{
  const { mcp, mock, server, client } = await bootServer({
    teamEnv: "alice-id",
  });
  try {
    // First call: override = ["bob-id"]. Alice is NOT in bob → customer.
    const r1 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["bob-id"],
      },
    });
    const c1 = parseText(r1).comments?.[0];
    check(
      "override=bob: comment role === 'customer'",
      c1?.author?.role === "customer",
      `got: ${c1?.author?.role}`,
    );
    const afterFirst = mock.commentCount();
    // First call: get_featurebase_post makes 1 comment fetch (no
    // engagement enrichment runs in this path because include_comments
    // already pulls the cached tree — getPost's `comments` block hits
    // the cache directly).
    check(
      "first call made exactly 1 comment fetch",
      afterFirst === 1,
      `got: ${afterFirst}`,
    );

    // Second call: no override (env team = alice). Alice should be admin.
    const r2 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const c2 = parseText(r2).comments?.[0];
    check(
      "default env team: comment role === 'admin'",
      c2?.author?.role === "admin",
      `got: ${c2?.author?.role}`,
    );
    check(
      "second call made 0 new comment fetches (cache hit)",
      mock.commentCount() - afterFirst === 0,
      `new fetches: ${mock.commentCount() - afterFirst}`,
    );

    // Third call: override = ["alice-id"]. Alice should still be admin.
    const r3 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["alice-id"],
      },
    });
    const c3 = parseText(r3).comments?.[0];
    check(
      "override=alice: comment role === 'admin'",
      c3?.author?.role === "admin",
      `got: ${c3?.author?.role}`,
    );
    check(
      "third call made 0 new comment fetches",
      mock.commentCount() - afterFirst === 0,
    );

    // Reverse the order to prove no directional contamination.
    const r4 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["alice-id"],
      },
    });
    const c4 = parseText(r4).comments?.[0];
    check(
      "reverse order, override=alice: comment role === 'admin'",
      c4?.author?.role === "admin",
      `got: ${c4?.author?.role}`,
    );

    const r5 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["bob-id"],
      },
    });
    const c5 = parseText(r5).comments?.[0];
    check(
      "reverse order, override=bob: comment role === 'customer'",
      c5?.author?.role === "customer",
      `got: ${c5?.author?.role}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 6: stalled-promises no-team short-circuit, real MCP path.
// ============================================================
console.log("\n=== Scenario 6: stalled-promises no-team short-circuits ===\n");
{
  const { mcp, mock, server, client } = await bootServer({ teamEnv: "" });
  try {
    const before = mock.totalCount();
    const result = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 7, limit: 10 },
    });
    check("callTool returned cleanly", !result.isError);
    const body = parseText(result);
    check(
      "teamSource === 'none' for no-team response",
      body.teamSource === "none",
      `got: ${body.teamSource}`,
    );
    check(
      "warning is present",
      typeof body.warning === "string" && body.warning.length > 0,
    );
    check(
      "promises is empty",
      Array.isArray(body.promises) && body.promises.length === 0,
      `got: ${JSON.stringify(body.promises)}`,
    );
    check(
      "ZERO comment fetches happened (no-team short-circuit before listing)",
      mock.commentCount() === 0,
      `commentCount: ${mock.commentCount()}`,
    );
    check(
      "ZERO listing fetches happened (no-team short-circuit before getAllPosts)",
      mock.listingCount() === 0,
      `listingCount: ${mock.listingCount()}`,
    );
    check(
      "zero total fetches",
      mock.totalCount() - before === 0,
      `delta: ${mock.totalCount() - before}`,
    );
    check(
      "no fabricated customer classifications in response (no per-post fields)",
      !("promises" in body) || body.promises.length === 0,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 7: stalled-promises override wins — deep assertions.
// Env says alice is team, override is bob. Alice's comments become
// customer; alice's post author also becomes customer. The returned
// stalled promises[] must reflect the override (alice is no admin).
// Then flip the override to alice and verify the SAME post returns.
// ============================================================
console.log("\n=== Scenario 7: stalled-promises override wins (deep) ===\n");
{
  const { mcp, mock, server, client } = await bootServer({
    teamEnv: "alice-id",
  });
  try {
    // Override=bob. Alice is NOT in the override → customer.
    const r1 = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: {
        minDaysSinceAdminReply: 0,
        limit: 10,
        teamUserIds: ["bob-id"],
      },
    });
    const b1 = parseText(r1);
    check(
      "override=bob (env=alice): teamSource === 'override'",
      b1.teamSource === "override",
      `got: ${b1.teamSource}`,
    );
    // Alice is now customer → her comments don't count as admin replies,
    // so p1's "alice replied then bob replied" pattern is no longer a
    // stalled promise (alice is customer, bob is customer too, no admin).
    check(
      "override=bob: no stalled promises (alice demoted to customer)",
      Array.isArray(b1.promises) && b1.promises.length === 0,
      `got: ${JSON.stringify(b1.promises)}`,
    );

    // Now flip override=alice. Alice is admin again. p1 should be
    // returned as stalled (alice admin-replied then bob customer-replied).
    const r2 = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: {
        minDaysSinceAdminReply: 0,
        limit: 10,
        teamUserIds: ["alice-id"],
      },
    });
    const b2 = parseText(r2);
    check(
      "override=alice: teamSource === 'override'",
      b2.teamSource === "override",
      `got: ${b2.teamSource}`,
    );
    check(
      "override=alice: one stalled promise (alice is admin, bob is customer)",
      Array.isArray(b2.promises) && b2.promises.length === 1,
      `got: ${b2.promises?.length}`,
    );
    const promise = b2.promises?.[0];
    check(
      "returned promise has slug 'p1'",
      promise?.slug === "p1",
      `got: ${promise?.slug}`,
    );
    // Post author is "other-id" (NOT in override alice → customer).
    check(
      "post.author.userId === 'other-id'",
      promise?.author?.userId === "other-id",
      `got: ${promise?.author?.userId}`,
    );
    check(
      "post.author.role === 'customer' (other-id not in override)",
      promise?.author?.role === "customer",
      `got: ${promise?.author?.role}`,
    );
    // lastAdminMessage was alice's comment.
    check(
      "lastAdminMessage.author.userId === 'alice-id'",
      promise?.lastAdminMessage?.author?.userId === "alice-id",
      `got: ${promise?.lastAdminMessage?.author?.userId}`,
    );
    check(
      "lastAdminMessage.author.role === 'admin' (alice in override)",
      promise?.lastAdminMessage?.author?.role === "admin",
      `got: ${promise?.lastAdminMessage?.author?.role}`,
    );
    // lastCustomerMessage was bob's comment.
    check(
      "lastCustomerMessage.author.userId === 'bob-id'",
      promise?.lastCustomerMessage?.author?.userId === "bob-id",
      `got: ${promise?.lastCustomerMessage?.author?.userId}`,
    );
    check(
      "lastCustomerMessage.author.role === 'customer' (bob not in override)",
      promise?.lastCustomerMessage?.author?.role === "customer",
      `got: ${promise?.lastCustomerMessage?.author?.role}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 8: post author IS also a commenter. The post-author role
// and the comment-author role must agree under every team resolution.
// ============================================================
console.log("\n=== Scenario 8: post author = commenter (agreement) ===\n");
{
  // Custom board: post author is Alice. Comment author is also Alice.
  // Two comments: alice (admin role under env team), then bob.
  process.env.FEATUREBASE_TEAM_USER_IDS = "alice-id";
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "alice-id", name: "Alice" },
    }),
  ];
  const comments = [[
    buildMockComment({
      id: "c1", userId: "alice-id", name: "Alice",
      createdAt: "2026-05-01T00:00:00Z",
    }),
    buildMockComment({
      id: "c2", userId: "bob-id", name: "Bob",
      createdAt: "2026-06-15T00:00:00Z",
    }),
  ]];
  const mock = buildMockFetcher({
    listingPages: [board],
    commentPages: { p1: comments },
  });
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "agreement-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  try {
    // Default team (alice is in env team): post.author.role = admin
    // AND comment by alice has role = admin.
    const r1 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const b1 = parseText(r1);
    check(
      "default team: post.author.role === 'admin' (alice is post author)",
      b1.author?.role === "admin",
      `got: ${b1.author?.role}`,
    );
    check(
      "default team: alice's comment role === 'admin'",
      b1.comments?.[0]?.author?.role === "admin",
      `got: ${b1.comments?.[0]?.author?.role}`,
    );

    // Override = bob. Alice is no longer in team. Post author AND
    // comment author for alice must BOTH become customer.
    const r2 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1",
        include_comments: true,
        teamUserIds: ["bob-id"],
      },
    });
    const b2 = parseText(r2);
    check(
      "override=bob: post.author.role === 'customer' (alice demoted)",
      b2.author?.role === "customer",
      `got: ${b2.author?.role}`,
    );
    check(
      "override=bob: alice's comment role === 'customer'",
      b2.comments?.[0]?.author?.role === "customer",
      `got: ${b2.comments?.[0]?.author?.role}`,
    );

    // No team at all: BOTH roles must be 'unknown' (no fabricated
    // classifications).
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
    // New server to refresh env snapshot.
    await mcp.close();
    const client2 = createClient({ fetcher: mock });
    const server2 = buildServer({ client: client2 });
    const mcp2 = new McpClient(
      { name: "agreement-client-2", version: "1" },
      { capabilities: {} },
    );
    const [sT2, cT2] = InMemoryTransport.createLinkedPair();
    await Promise.all([server2.connect(sT2), mcp2.connect(cT2)]);
    const r3 = await mcp2.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const b3 = parseText(r3);
    check(
      "no team: post.author.role === 'unknown'",
      b3.author?.role === "unknown",
      `got: ${b3.author?.role}`,
    );
    check(
      "no team: alice's comment role === 'unknown'",
      b3.comments?.[0]?.author?.role === "unknown",
      `got: ${b3.comments?.[0]?.author?.role}`,
    );
    await mcp2.close();
  } finally {
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 9: stalled-promises partial fetch failure surfaces
// engagementComplete=false and the failed post slug.
// One post succeeds, one post's comments fetch fails.
// ============================================================
console.log("\n=== Scenario 9: stalled-promises partial-fetch surfaces loudly ===\n");
{
  // Two posts: p1 (comments fetchable), p2 (comments throw).
  process.env.FEATUREBASE_TEAM_USER_IDS = "alice-id";
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
    buildMockPost({
      id: "p2", slug: "p2", title: "P2", commentCount: 1,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  const mock = buildMockFetcher({
    listingPages: [board],
    commentPages: {
      p1: [[
        buildMockComment({
          id: "c1", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-01T00:00:00Z",
        }),
        buildMockComment({
          id: "c2", userId: "bob-id", name: "Bob",
          createdAt: "2026-06-15T00:00:00Z",
        }),
      ]],
      // p2 intentionally absent + failOnMissingComments: true below
      // means the fetcher throws for p2 — exercises the partial-fetch
      // failure path in production code.
    },
    failOnMissingComments: true,
  });
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "partial-stalled-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  try {
    const r = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 0, limit: 10 },
    });
    const body = parseText(r);
    check(
      "engagementComplete === false (p2 fetch failed)",
      body.engagementComplete === false,
      `got: ${body.engagementComplete}`,
    );
    check(
      "failedPostSlugs includes 'p2'",
      Array.isArray(body.failedPostSlugs) && body.failedPostSlugs.includes("p2"),
      `got: ${JSON.stringify(body.failedPostSlugs)}`,
    );
    check(
      "failedCommentPostCount === 1",
      body.failedCommentPostCount === 1,
      `got: ${body.failedCommentPostCount}`,
    );
    check(
      "warning mentions comment failure",
      typeof body.warning === "string" &&
        body.warning.toLowerCase().includes("comment"),
    );
    // The successful stalled promise is still in promises[].
    const slugs = (body.promises ?? []).map((p) => p.slug);
    check(
      "successful stalled promise (p1) is still returned alongside the failure",
      slugs.includes("p1"),
      `got: ${slugs.join(",")}`,
    );
    check(
      "p2 is NOT in promises[] (no engagement fields available)",
      !slugs.includes("p2"),
      `got: ${slugs.join(",")}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// Scenario 10: all comment fetches fail → response still reports
// incompleteness, not a silent empty result.
// ============================================================
console.log("\n=== Scenario 10: all comment fetches fail ===\n");
{
  process.env.FEATUREBASE_TEAM_USER_IDS = "alice-id";
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 1,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // Empty commentPages + failOnMissingComments → fetcher throws on
  // every comment URL.
  const mock = buildMockFetcher({
    listingPages: [board],
    commentPages: {},
    failOnMissingComments: true,
  });
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "all-fail-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  try {
    const r = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 0, limit: 10 },
    });
    const body = parseText(r);
    check(
      "engagementComplete === false (all fetches failed)",
      body.engagementComplete === false,
    );
    check(
      "failedPostSlugs includes 'p1'",
      Array.isArray(body.failedPostSlugs) && body.failedPostSlugs.includes("p1"),
    );
    check(
      "warning is non-empty (caller observes failure)",
      typeof body.warning === "string" && body.warning.length > 0,
    );
    check(
      "promises[] may be empty but is not the only signal — failedPostSlugs carries the failure",
      Array.isArray(body.promises) &&
        body.promises.length === 0 &&
        (body.failedPostSlugs?.length ?? 0) > 0,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);