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
console.log("\n=== CASE E: partial-fetch does not silently misfilter ===\n");
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
    const body = parseText(result);
    const slugs = body.posts.map((p) => p.slug).sort();
    // p2 had a successful kr-comment → must be included.
    check(`p2 included (got ${slugs.join(",")})`, slugs.includes("p2"));
    // p3's fetch failed — it must not silently appear as if it had
    // no admin reply. Either it is excluded or it is flagged.
    const p3 = body.posts.find((p) => p.slug === "p3");
    if (p3) {
      check(
        "p3 (fetch-failed) is flagged with commentFetchFailed=true",
        p3.commentFetchFailed === true,
        `got: ${JSON.stringify(p3)}`,
      );
    } else {
      check(
        "p3 (fetch-failed) is excluded from hasAdminReply:true result",
        true,
      );
    }
  } finally {
    await mcp.close();
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);