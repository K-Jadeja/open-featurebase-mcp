// Deterministic server-level lazy-enrichment regression suite.
//
// Each case builds a server with an injected mock fetcher, drives
// the public MCP tool surface via InMemoryTransport, and asserts
// both the network-fetch shape and the response semantics.
//
// What this proves (per the audit gates):
//   * list_featurebase_posts without hasAdminReply performs ZERO
//     comment fetches.
//   * list_featurebase_posts with hasAdminReply triggers the
//     enrichment path and filters correctly.
//   * No-team configuration surfaces `role: "unknown"` and the
//     stalled-promises warning, not silent false classifications.
//   * A partial comment-fetch failure does not silently produce
//     incorrect filtering.

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

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

async function withServer(mock) {
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "lazy-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  return mcp;
}

function postFixture(overrides) {
  return buildMockPost(overrides);
}

function boardWithComments() {
  return [
    postFixture({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
    postFixture({
      id: "p2", slug: "p2", title: "P2", commentCount: 1,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
    postFixture({
      id: "p3", slug: "p3", title: "P3", commentCount: 1,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
  ];
}

function standardComments() {
  return {
    p2: [buildMockComment({
      id: "c2", userId: FIXTURE_USER_IDS.krAuthor, name: "Kr",
      createdAt: "2026-04-01T00:00:00Z",
    })],
    p3: [buildMockComment({
      id: "c3", userId: FIXTURE_USER_IDS.otherUser, name: "Other",
      createdAt: "2026-04-02T00:00:00Z",
    })],
  };
}

// ============================================================
// CASE A: normal list = no comment fetches
// ============================================================
console.log("=== CASE A: normal list = no comment fetches ===\n");
{
  const board = [
    postFixture({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
    postFixture({
      id: "p2", slug: "p2", title: "P2", commentCount: 5,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
    postFixture({
      id: "p3", slug: "p3", title: "P3", commentCount: 2,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
  ];
  const mock = buildMockFetcher({ listingPages: [board] });
  const mcp = await withServer(mock);
  try {
    const result = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    check("list returned cleanly", !result.isError);
    const body = parseText(result);
    check("all 3 posts returned", body.returned === 3, `got ${body.returned}`);
    check(
      `0 comment fetches (got ${mock.commentCount()})`,
      mock.commentCount() === 0,
    );
    check(
      "posts have no hasAdminReply field (no engagement populated)",
      body.posts.every((p) => p.hasAdminReply === undefined),
    );
  } finally {
    await mcp.close();
  }
}

// ============================================================
// CASE B: hasAdminReply:true triggers enrichment
// ============================================================
console.log("\n=== CASE B: hasAdminReply:true triggers enrichment ===\n");
{
  // 4 posts: p1 (no comments), p2 (kr-comment = admin match),
  // p3 (other-comment only = no admin), p4 (other + kr).
  const board = [
    postFixture({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
    postFixture({
      id: "p2", slug: "p2", title: "P2", commentCount: 1,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
    postFixture({
      id: "p3", slug: "p3", title: "P3", commentCount: 1,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
    postFixture({
      id: "p4", slug: "p4", title: "P4", commentCount: 2,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
  ];
  const commentPages = {
    p2: [buildMockComment({
      id: "c2-1", userId: FIXTURE_USER_IDS.krAuthor, name: "Kr",
      createdAt: "2026-04-01T00:00:00Z",
    })],
    p3: [buildMockComment({
      id: "c3-1", userId: FIXTURE_USER_IDS.otherUser, name: "Other",
      createdAt: "2026-04-02T00:00:00Z",
    })],
    p4: [
      buildMockComment({
        id: "c4-1", userId: FIXTURE_USER_IDS.otherUser, name: "Other",
        createdAt: "2026-04-03T00:00:00Z",
      }),
      buildMockComment({
        id: "c4-2", userId: FIXTURE_USER_IDS.krAuthor, name: "Kr",
        createdAt: "2026-04-04T00:00:00Z",
      }),
    ],
  };
  const mock = buildMockFetcher({ listingPages: [board], commentPages });

  // We pass teamUserIds as an explicit override (cleaner than mutating
  // the env var, which is hoisted in ESM and gets snapshotted at module
  // load — too late to influence test setup).
  const mcp = await withServer(mock);
  try {
    const result = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    check("hasAdminReply list returned cleanly", !result.isError);
    const body = parseText(result);
    const slugs = body.posts.map((p) => p.slug).sort();
    check(
      `filter returned p2+p4 only (got ${slugs.join(",")})`,
      slugs.length === 2 && slugs.includes("p2") && slugs.includes("p4"),
    );
    check(
      `comment fetches happened (got ${mock.commentCount()})`,
      mock.commentCount() >= 2,
    );
    check(
      "all returned posts have hasAdminReply=true",
      body.posts.every((p) => p.hasAdminReply === true),
    );
  } finally {
    await mcp.close();
  }
}

// ============================================================
// CASE C: hasAdminReply:false filters correctly
// ============================================================
console.log("\n=== CASE C: hasAdminReply:false filters correctly ===\n");
{
  const mock = buildMockFetcher({
    listingPages: [boardWithComments()],
    commentPages: standardComments(),
  });
  const mcp = await withServer(mock);
  try {
    const result = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: false,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    const body = parseText(result);
    const slugs = body.posts.map((p) => p.slug).sort();
    check(
      `hasAdminReply:false returned p3 only (got ${slugs.join(",")})`,
      slugs.length === 1 && slugs[0] === "p3",
    );
    check(
      "no false-positives: no returned post has hasAdminReply=true",
      body.posts.every((p) => p.hasAdminReply === false),
    );
  } finally {
    await mcp.close();
  }
}

// ============================================================
// CASE D: no-team config surfaces role=unknown + warning
// ============================================================
console.log("\n=== CASE D: no-team config surfaces loud failure ===\n");
{
  delete process.env.FEATUREBASE_TEAM_USER_IDS;
  const mock = buildMockFetcher({
    listingPages: [[
      postFixture({
        id: "p1", slug: "p1", title: "P1", commentCount: 0,
        author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
      }),
    ]],
  });
  const mcp = await withServer(mock);
  try {
    const listResult = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    const listBody = parseText(listResult);
    check(
      "no-team list: post.author.role === 'unknown'",
      listBody.posts.every((p) => p.author.role === "unknown"),
      listBody.posts.map((p) => p.author.role).join(","),
    );

    const stalled = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 7, limit: 10 },
    });
    check("stalled-promises returned cleanly", !stalled.isError);
    const stalledBody = parseText(stalled);
    check(
      "stalled-promises: warning field is present and non-empty",
      typeof stalledBody.warning === "string" && stalledBody.warning.length > 0,
    );
    check(
      "warning mentions team / user IDs",
      stalledBody.warning.toLowerCase().includes("team") ||
        stalledBody.warning.toLowerCase().includes("user"),
    );
  } finally {
    await mcp.close();
  }
}

// ============================================================
// CASE E: partial comment-fetch failure does NOT silently
// misfilter the hasAdminReply list.
// ============================================================
// CASE E: partial-fetch surfaces engagementComplete=false + warning +
// failedPostSlugs at the response top level — caller can observe the
// failure even when the affected post is absent from posts[].
// ============================================================
console.log("\n=== CASE E: partial-fetch surfaces loudly ===\n");
{
  const baseMock = buildMockFetcher({
    listingPages: [boardWithComments()],
    commentPages: standardComments(),
  });
  // Make p3's comment fetch throw. p2 still returns cleanly.
  const failingFetcher = {
    async fetch(url, init) {
      if (url.includes("/api/v1/comment") && url.includes("submissionId=p3")) {
        baseMock.calls.push(url);
        throw new Error(`injected failure for ${url}`);
      }
      return baseMock.fetch(url, init);
    },
  };

  const client = createClient({ fetcher: failingFetcher });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "partial-fetch-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  try {
    const result = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: [FIXTURE_USER_IDS.krAuthor],
      },
    });
    check("callTool returned cleanly", !result.isError);
    const body = parseText(result);

    // p2 had a successful kr-comment → must be included.
    const slugs = body.posts.map((p) => p.slug);
    check(`p2 included (got ${slugs.join(",")})`, slugs.includes("p2"));

    // Top-level engagementComplete must be false.
    check(
      "engagementComplete === false at response top level",
      body.engagementComplete === false,
      `got: ${body.engagementComplete}`,
    );
    check(
      "failedCommentPostCount === 1",
      body.failedCommentPostCount === 1,
      `got: ${body.failedCommentPostCount}`,
    );
    check(
      "failedPostSlugs includes 'p3'",
      Array.isArray(body.failedPostSlugs) && body.failedPostSlugs.includes("p3"),
      `got: ${JSON.stringify(body.failedPostSlugs)}`,
    );
    check(
      "response has non-empty warning that mentions the failure",
      typeof body.warning === "string" &&
        body.warning.length > 0 &&
        body.warning.toLowerCase().includes("comment"),
    );
    // The failure MUST be observable even if the affected post is
    // absent from posts[] (which is the case here, since hasAdminReply:true
    // excludes posts without admin replies and p3 had only customer
    // comments anyway).
    check(
      "caller can observe failure from engagementComplete alone",
      body.engagementComplete === false && body.failedPostSlugs?.length > 0,
    );
  } finally {
    await mcp.close();
  }
}

// ============================================================
// CASE F: no-team hasAdminReply request throws InvalidParams — never
// silently manufactures false classifications.
// ============================================================
console.log("\n=== CASE F: no-team hasAdminReply throws InvalidParams ===\n");
{
  const mock = buildMockFetcher({
    listingPages: [boardWithComments()],
    commentPages: standardComments(),
  });
  const mcp = await withServer(mock);
  try {
    for (const value of [true, false]) {
      const result = await mcp.callTool({
        name: "list_featurebase_posts",
        arguments: {
          status: "all", sortBy: "date:desc", limit: 50,
          hasAdminReply: value,
          // no teamUserIds override
        },
      });
      check(
        `hasAdminReply=${value} with no team → result.isError=true`,
        result.isError === true,
      );
      const errText = (result.content?.[0]?.text ?? "")
        .replace(/^MCP error -\d+:\s*/, "");
      check(
        `error mentions team / find_featurebase_user (got: "${errText.slice(0, 80)}…")`,
        errText.toLowerCase().includes("team") ||
          errText.toLowerCase().includes("find_featurebase_user"),
      );
      check(
        `error mentions teamUserIds or FEATUREBASE_TEAM_USER_IDS`,
        errText.includes("teamUserIds") ||
          errText.includes("FEATUREBASE_TEAM_USER_IDS"),
      );
      // The error must NOT return a posts[] array that looks authoritative.
      // No posts returned when the request was rejected.
      check(
        `rejected request did NOT fabricate posts[] (returned as error)`,
        result.isError,
      );
    }
  } finally {
    await mcp.close();
  }
}

// ============================================================
// CASE G: same cached comments, two different team overrides in
// sequence — each result must reflect its own team, no role leakage
// from one call to the next.
// ============================================================
console.log("\n=== CASE G: cached comments classify per-request ===\n");
{
  const board = [
    postFixture({
      id: "p1", slug: "p1", title: "P1", commentCount: 1,
      author: { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
    }),
  ];
  const commentPages = {
    p1: [buildMockComment({
      id: "c1", userId: "alice-id", name: "Alice",
      createdAt: "2026-05-01T00:00:00Z",
    })],
  };
  const mock = buildMockFetcher({ listingPages: [board], commentPages });
  const mcp = await withServer(mock);
  try {
    // First call: team = "alice-id". Alice's role should be "admin".
    const r1 = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: ["alice-id"],
      },
    });
    check("first call (team=alice) returned cleanly", !r1.isError);
    const b1 = parseText(r1);
    check(
      "first call: p1 has hasAdminReply=true (alice is admin)",
      b1.posts.some((p) => p.slug === "p1" && p.hasAdminReply === true),
      JSON.stringify(b1.posts[0]),
    );
    // Network state — only one comment fetch should have happened so far.
    const afterFirst = mock.commentCount();
    check(
      `first call made exactly 1 comment fetch (got ${afterFirst})`,
      afterFirst === 1,
    );

    // Second call: team = "bob-id" (Alice is NOT in the team). Alice's
    // role should now be "customer" → hasAdminReply=false.
    const r2 = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: ["bob-id"],
      },
    });
    check("second call (team=bob) returned cleanly", !r2.isError);
    const b2 = parseText(r2);
    check(
      "second call: p1 has hasAdminReply=false (alice is customer now)",
      b2.posts.every((p) => p.slug !== "p1" || p.hasAdminReply === false),
      JSON.stringify(b2.posts),
    );
    // Cache reuse: second call should NOT re-fetch the comments.
    check(
      `second call made 0 new comment fetches (got ${mock.commentCount() - afterFirst})`,
      mock.commentCount() - afterFirst === 0,
    );

    // Reverse order: third call back to team=alice. Now Alice should
    // be admin again, proving the cache didn't leak the bob-classification.
    const r3 = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: ["alice-id"],
      },
    });
    const b3 = parseText(r3);
    check(
      "third call (back to team=alice): hasAdminReply=true restored",
      b3.posts.some((p) => p.slug === "p1" && p.hasAdminReply === true),
      JSON.stringify(b3.posts[0]),
    );
    check(
      "third call made 0 new comment fetches (cache fully reused)",
      mock.commentCount() - afterFirst === 0,
    );
  } finally {
    await mcp.close();
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);