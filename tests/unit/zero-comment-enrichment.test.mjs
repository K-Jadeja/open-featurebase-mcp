// Deterministic zero-comment enrichment regression suite.
//
// The contract under test:
//   * A post with `commentCount === 0` definitively satisfies
//     hasAdminReply:false (the team has had no opportunity to reply).
//   * With a team configured, list_posts and get_post return EXPLICIT
//     zero engagement values for zero-comment posts, so the
//     strict-equality filter `(p.hasAdminReply ?? null) === false`
//     matches them.
//   * With NO team configured, the loud-unknown contract still holds:
//     authors stay role="unknown" and engagement fields are OMITTED.
//   * Zero-comment posts cause ZERO comment API requests.
//   * getPost zero-comment branch is consistent across
//     include_comments=true and include_comments=false.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../../dist/server.js";
import { createClient } from "../../dist/client.js";
import {
  buildMockFetcher,
  buildMockPost,
  FIXTURE_USER_IDS,
} from "./__fixtures__.mjs";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

async function bootServer({ mock, teamEnv = "alice-id" }) {
  if (teamEnv) process.env.FEATUREBASE_TEAM_USER_IDS = teamEnv;
  else delete process.env.FEATUREBASE_TEAM_USER_IDS;
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "zero-comment-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  return { client, server, mcp };
}

// ============================================================
// SCENARIO 1: list_posts(hasAdminReply:false) on a zero-comment post
//   - team configured (via override) → explicit zero engagement values
//   - zero comment fetches
// ============================================================
console.log("=== Scenario 1: list_posts(hasAdminReply:false) on zero-comment post ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 0,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const { mcp } = await bootServer({ mock });
  try {
    const result = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: false,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    check("returned cleanly", !result.isError);
    const body = parseText(result);
    check(
      "zero-comment p1 is INCLUDED in hasAdminReply:false results",
      body.posts.some((p) => p.slug === "p1"),
      `slugs: ${body.posts.map((p) => p.slug).join(",")}`,
    );
    const p1 = body.posts.find((p) => p.slug === "p1");
    check(
      "p1 has hasAdminReply === false (explicit, not undefined)",
      p1?.hasAdminReply === false,
      `got: ${p1?.hasAdminReply}`,
    );
    check(
      "p1 has adminReplyCount === 0",
      p1?.adminReplyCount === 0,
      `got: ${p1?.adminReplyCount}`,
    );
    check(
      "p1 has customerCommentCount === 0",
      p1?.customerCommentCount === 0,
      `got: ${p1?.customerCommentCount}`,
    );
    check(
      "p1 adminLastReplyDate is absent (no comments to date)",
      p1?.adminLastReplyDate === undefined,
      `got: ${p1?.adminLastReplyDate}`,
    );
    check(
      "p1 customerLastReplyDate is absent (no comments to date)",
      p1?.customerLastReplyDate === undefined,
      `got: ${p1?.customerLastReplyDate}`,
    );
    check(
      "p1 lastCommentDate is absent",
      p1?.lastCommentDate === undefined,
      `got: ${p1?.lastCommentDate}`,
    );
    check(
      `ZERO comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 2: list_posts(hasAdminReply:true) on a zero-comment post
//   - team configured → explicit zero engagement values
//   - zero-comment post is EXCLUDED from hasAdminReply:true
// ============================================================
console.log("\n=== Scenario 2: list_posts(hasAdminReply:true) excludes zero-comment ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 0,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const { mcp } = await bootServer({ mock });
  try {
    const result = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    const body = parseText(result);
    check(
      "zero-comment p1 is EXCLUDED from hasAdminReply:true (hasAdminReply=false !== true)",
      !body.posts.some((p) => p.slug === "p1"),
      `slugs: ${body.posts.map((p) => p.slug).join(",")}`,
    );
    check(
      `ZERO comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 3: get_post on a zero-comment post with team configured.
// include_comments=true:
//   - returns comments: []
//   - explicit zero engagement values
//   - ZERO comment fetches
// ============================================================
console.log("\n=== Scenario 3: get_post zero-comment, team configured, include_comments=true ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 0,
      author: { _id: "alice-id", name: "Alice" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const { mcp } = await bootServer({ mock });
  try {
    const result = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1", include_comments: true,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    check("returned cleanly", !result.isError);
    const body = parseText(result);
    check(
      "comments array is empty (zero-comment post)",
      Array.isArray(body.comments) && body.comments.length === 0,
      `got: ${JSON.stringify(body.comments)}`,
    );
    check(
      "commentsError is absent (no failure)",
      body.commentsError === undefined,
      `got: ${body.commentsError}`,
    );
    check(
      "hasAdminReply === false (explicit zero engagement)",
      body.hasAdminReply === false,
      `got: ${body.hasAdminReply}`,
    );
    check(
      "adminReplyCount === 0",
      body.adminReplyCount === 0,
      `got: ${body.adminReplyCount}`,
    );
    check(
      "customerCommentCount === 0",
      body.customerCommentCount === 0,
      `got: ${body.customerCommentCount}`,
    );
    check(
      "adminLastReplyDate absent",
      body.adminLastReplyDate === undefined,
      `got: ${body.adminLastReplyDate}`,
    );
    check(
      "customerLastReplyDate absent",
      body.customerLastReplyDate === undefined,
      `got: ${body.customerLastReplyDate}`,
    );
    check(
      `ZERO comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
    // Author role reflects the team override: alice is NOT in the
    // override (which contains kr-author-uid) → "customer".
    check(
      "post.author.role reflects team override (alice NOT in override → customer)",
      body.author?.role === "customer",
      `got: ${body.author?.role}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 4: get_post on a zero-comment post with team configured.
// include_comments=false:
//   - returns the post without comments[]
//   - explicit zero engagement values (same as include_comments=true)
//   - zero comment fetches
// include_comments controls only whether comments[] is included. It
// must not change already-known engagement metadata. A zero-comment
// post with a configured team definitively satisfies "the team has
// not commented" — populate the zero engagement values via the
// shared helper regardless of include_comments.
// ============================================================
console.log("\n=== Scenario 4: get_post zero-comment, team configured, include_comments=false ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 0,
      author: { _id: "alice-id", name: "Alice" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const { mcp } = await bootServer({ mock });
  try {
    const result = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: {
        slug: "p1", include_comments: false,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    check("returned cleanly", !result.isError);
    const body = parseText(result);
    check(
      "comments field absent (include_comments=false)",
      body.comments === undefined,
      `got: ${JSON.stringify(body.comments)}`,
    );
    check(
      `ZERO comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
    check(
      "post.author.role reflects team override (alice NOT in override → customer)",
      body.author?.role === "customer",
      `got: ${body.author?.role}`,
    );
    // The shared zero-comment helper must produce the same engagement
    // values regardless of include_comments.
    check(
      "hasAdminReply === false (explicit zero engagement, parity with include_comments=true)",
      body.hasAdminReply === false,
      `got: ${body.hasAdminReply}`,
    );
    check(
      "adminReplyCount === 0 (parity with include_comments=true)",
      body.adminReplyCount === 0,
      `got: ${body.adminReplyCount}`,
    );
    check(
      "customerCommentCount === 0 (parity with include_comments=true)",
      body.customerCommentCount === 0,
      `got: ${body.customerCommentCount}`,
    );
    check(
      "adminLastReplyDate absent (no comments to date)",
      body.adminLastReplyDate === undefined,
      `got: ${body.adminLastReplyDate}`,
    );
    check(
      "customerLastReplyDate absent (no comments to date)",
      body.customerLastReplyDate === undefined,
      `got: ${body.customerLastReplyDate}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 6: get_post on a zero-comment post with NO team.
// include_comments=false:
//   - comments field absent (include_comments=false)
//   - engagement fields remain absent (loud-unknown contract)
//   - author role stays 'unknown'
//   - zero comment fetches
// ============================================================
console.log("\n=== Scenario 6: get_post zero-comment, no team, include_comments=false ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 0,
      author: { _id: "alice-id", name: "Alice" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const { mcp } = await bootServer({ mock, teamEnv: "" });
  try {
    const result = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: false },
    });
    check("returned cleanly", !result.isError);
    const body = parseText(result);
    check(
      "no team: comments field absent (include_comments=false)",
      body.comments === undefined,
      `got: ${JSON.stringify(body.comments)}`,
    );
    check(
      `ZERO comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
    check(
      "no team: post.author.role === 'unknown' (loud-unknown contract)",
      body.author?.role === "unknown",
      `got: ${body.author?.role}`,
    );
    check(
      "no team: engagement fields OMITTED (no fabricated zero values)",
      body.hasAdminReply === undefined &&
        body.adminReplyCount === undefined &&
        body.customerCommentCount === undefined,
      `hasAdminReply=${body.hasAdminReply} adminReplyCount=${body.adminReplyCount} customerCommentCount=${body.customerCommentCount}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 5: get_post on a zero-comment post with NO team.
// include_comments=true:
//   - comments: []
//   - role: "unknown" on authors
//   - engagement fields OMITTED (loud-unknown contract preserved)
// ============================================================
console.log("\n=== Scenario 5: get_post zero-comment, no team, include_comments=true ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 0,
      author: { _id: "alice-id", name: "Alice" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const { mcp } = await bootServer({ mock, teamEnv: "" });
  try {
    const result = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    check("returned cleanly", !result.isError);
    const body = parseText(result);
    check(
      "comments array is empty",
      Array.isArray(body.comments) && body.comments.length === 0,
    );
    check(
      "no team: post.author.role === 'unknown' (loud-unknown contract)",
      body.author?.role === "unknown",
      `got: ${body.author?.role}`,
    );
    check(
      "no team: engagement fields OMITTED (no fabricated zero values)",
      body.hasAdminReply === undefined &&
        body.adminReplyCount === undefined &&
        body.customerCommentCount === undefined,
      `hasAdminReply=${body.hasAdminReply} adminReplyCount=${body.adminReplyCount} customerCommentCount=${body.customerCommentCount}`,
    );
    check(
      `ZERO comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
