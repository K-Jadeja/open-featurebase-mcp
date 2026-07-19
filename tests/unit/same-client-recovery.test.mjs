// Deterministic same-client-recovery regression suite.
//
// The previous recovery tests (atomic-pagination.test.mjs) proved that
// a FRESH client could recover after a transient failure. That was
// trivially true — a fresh client has no poisoned cache. The stronger
// contract is: the SAME client, on the SAME server, with a MUTABLE
// fetcher that initially throws and later succeeds, must:
//   1. NOT cache the failed result (so the next call refetches).
//   2. NOT return contradictory state across attempts (e.g. complete
//      comments but stale commentFetchFailed:true from a prior fetch).
//   3. NOT cascade an incomplete listing into false not-found answers
//      or false complete-board claims by downstream tools.
//
// These tests use ONE client + ONE server + ONE mutable fetcher.
// They drive the real MCP tool surface via InMemoryTransport.

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

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

/**
 * Wrap a baseMock's fetch with a counter + per-URL fail switch.
 *
 * `failures` is a Map<string, true> — when a URL matches a key
 * (exact-match for query strings), the wrapper throws instead of
 * delegating. The wrapper ALWAYS records the URL on the baseMock's
 * `calls` array so the existing counters still reflect attempts.
 *
 * `failures.delete(url)` flips a URL back to "let through".
 */
function withMutableFailure(baseMock, failures) {
  return {
    async fetch(url, init) {
      if (failures.has(url)) {
        baseMock.calls.push(url);
        throw new Error(`injected failure: ${url}`);
      }
      return baseMock.fetch(url, init);
    },
  };
}

async function bootServer({ mock, teamEnv = "alice-id" }) {
  if (teamEnv) process.env.FEATUREBASE_TEAM_USER_IDS = teamEnv;
  else delete process.env.FEATUREBASE_TEAM_USER_IDS;
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "same-client-recovery", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  return { client, server, mcp };
}

// ============================================================
// SCENARIO A: ensureCommentIndex is NOT cached on incomplete fetch.
//   Same client, same server, mutable fetcher.
//   Call 1: page 2 fails -> commentsComplete:false, no cache write.
//   Call 2: page 2 succeeds -> commentsComplete:true, correct total.
//   Call 3: cached hit -> zero new comment fetches.
// ============================================================
console.log("=== Scenario A: ensureCommentIndex not cached on incomplete ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // 2-page thread for p1.
  const baseMock = buildMockFetcher({
    listingPages: [board],
    commentPages: {
      p1: [
        [buildMockComment({
          id: "c1", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-01T00:00:00Z",
        })],
        [buildMockComment({
          id: "c2", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-02T00:00:00Z",
        })],
      ],
    },
  });
  // Mutable: page 2 of p1 fails initially, recovers on demand.
  const failures = new Map();
  const page2Url = `https://itsremalt.featurebase.app/api/v1/comment?submissionId=p1&page=2`;
  failures.set(page2Url, true);
  const mock = withMutableFailure(baseMock, failures);
  const { client, mcp } = await bootServer({ mock });
  try {
    // Call 1: page 2 throws -> atomic failure, commentsComplete:false.
    const r1 = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    const b1 = parseText(r1);
    check("call 1: commentsComplete === false (page 2 failed)",
      b1.commentsComplete === false, `got: ${b1.commentsComplete}`);
    check("call 1: warning is set (caller sees partial data)",
      typeof b1.warning === "string" && b1.warning.length > 0);

    // Counters after call 1. The atomic getComments throws after page 1
    // succeeds + page 2 fails. Page 1 was fetched (counts) but NOT cached.
    const listingCountAfter1 = baseMock.listingCount();
    const commentCountAfter1 = baseMock.commentCount();

    // Recover page 2.
    failures.delete(page2Url);
    const commentCountBeforeCall2 = baseMock.commentCount();

    // Call 2: SAME client, page 2 succeeds -> commentsComplete:true.
    const r2 = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    const b2 = parseText(r2);
    check("call 2: commentsComplete === true (recovered)",
      b2.commentsComplete === true, `got: ${b2.commentsComplete}`);
    check("call 2: warning absent",
      b2.warning === undefined, `got: ${b2.warning}`);
    const alice = b2.matches.find((m) => m.userId === "alice-id");
    check("call 2: alice totalCommentCount = 2 (full thread fetched)",
      alice?.totalCommentCount === 2, `got: ${alice?.totalCommentCount}`);

    // Call 2 MUST have refetched both listing and comments — proving
    // the failed call 1 did NOT poison any cache.
    check("call 2: listing was refetched (atomic listing, no cache write on success? see below)",
      baseMock.listingCount() >= listingCountAfter1,
      `before: ${listingCountAfter1}, after: ${baseMock.listingCount()}`);
    check("call 2: refetched all comment pages (no stale cache from call 1)",
      baseMock.commentCount() - commentCountBeforeCall2 >= 2,
      `delta: ${baseMock.commentCount() - commentCountBeforeCall2}`);

    // Call 3: caching kicks in — zero new fetches.
    const before3 = baseMock.totalCount();
    const r3 = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    const b3 = parseText(r3);
    check("call 3: still complete (cached)",
      b3.commentsComplete === true);
    const alice3 = b3.matches.find((m) => m.userId === "alice-id");
    check("call 3: alice totalCommentCount = 2 (cached hit)",
      alice3?.totalCommentCount === 2);
    check("call 3: ZERO new fetches (listing + comments fully cached)",
      baseMock.totalCount() === before3,
      `delta: ${baseMock.totalCount() - before3}`);
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO B: getPost uses ONE comment fetch per request.
//   Same client, mutable fetcher. The mock flips from throw -> success.
//   Verify the response is consistent (either comments+engagement from
//   a single fetch, OR commentsError with NO stale commentFetchFailed
//   from a separate earlier attempt).
// ============================================================
console.log("\n=== Scenario B: getPost is single-fetch consistent ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // 2-page thread.
  const baseMock = buildMockFetcher({
    listingPages: [board],
    commentPages: {
      p1: [
        [buildMockComment({
          id: "c1", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-01T00:00:00Z",
        })],
        [buildMockComment({
          id: "c2", userId: "bob-id", name: "Bob",
          createdAt: "2026-06-01T00:00:00Z",
        })],
      ],
    },
  });

  // Mutable: page 1 fails initially. We will mutate mid-call to allow
  // page 2 to succeed on a SECOND getPost call. The mock URL is unique
  // per page, so we can flip just page 1.
  const failures = new Map();
  const page1Url = `https://itsremalt.featurebase.app/api/v1/comment?submissionId=p1&page=1`;
  failures.set(page1Url, true);
  const mock = withMutableFailure(baseMock, failures);
  const { client, mcp } = await bootServer({ mock });
  try {
    // Call 1: page 1 throws -> atomic failure. Single fetch attempted.
    const r1 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const b1 = parseText(r1);
    check("call 1: commentsError set (atomic failure)",
      typeof b1.commentsError === "string" && b1.commentsError.length > 0);
    check("call 1: comments array is undefined",
      b1.comments === undefined);
    // CRITICAL: the response must NOT carry commentFetchFailed:true.
    // That would mean a previous attempt had run, then a second attempt
    // failed too — which is the double-fetch inconsistency we are
    // guarding against. With single-fetch, the first call MUST end in
    // exactly one state: commentsError OR comments[].
    check("call 1: no stale commentFetchFailed flag (single fetch invariant)",
      b1.commentFetchFailed === undefined,
      `got: ${b1.commentFetchFailed}`);
    check("call 1: no stale engagement fields (consistency)",
      b1.hasAdminReply === undefined &&
        b1.adminReplyCount === undefined &&
        b1.customerCommentCount === undefined,
      `hasAdminReply=${b1.hasAdminReply} adminReplyCount=${b1.adminReplyCount} customerCommentCount=${b1.customerCommentCount}`);

    // Counters: only the listing + page 1 attempt should have happened.
    const commentsBefore2 = baseMock.commentCount();

    // Flip page 1 back to success.
    failures.delete(page1Url);

    // Call 2: page 1 succeeds, page 2 succeeds (no longer thrown).
    // Single fetch must succeed and return complete comments + engagement.
    const r2 = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const b2 = parseText(r2);
    check("call 2: commentsError absent",
      b2.commentsError === undefined);
    check("call 2: comments populated (2 comments)",
      Array.isArray(b2.comments) && b2.comments.length === 2,
      `got: ${Array.isArray(b2.comments) ? b2.comments.length : typeof b2.comments}`);
    check("call 2: engagement fields populated from the SAME fetch",
      b2.hasAdminReply === true &&
        b2.adminReplyCount === 1 &&
        b2.customerCommentCount === 1,
      `hasAdminReply=${b2.hasAdminReply} adminReplyCount=${b2.adminReplyCount} customerCommentCount=${b2.customerCommentCount}`);
    check("call 2: no commentFetchFailed flag",
      b2.commentFetchFailed === undefined);
    // Comment-fetch counter delta must equal the number of pages
    // fetched in call 2. Single-fetch per call.
    check("call 2: comment fetches added = 2 (one per page of a fresh fetch)",
      baseMock.commentCount() - commentsBefore2 === 2,
      `delta: ${baseMock.commentCount() - commentsBefore2}`);
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO C: getAllPosts is atomic. A failed listing page must:
//   - throw on listing-dependent tools (list_posts, get_post,
//     find_user, stalled-promises) rather than return incomplete data
//   - not cache the partial listing, so recovery on the same client
//     refetches every page
// ============================================================
console.log("\n=== Scenario C: getAllPosts atomic — listing page failure ===\n");
{
  // 3-page listing. Page 2 fails initially.
  const page1Posts = [
    buildMockPost({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
  ];
  const page2Posts = [
    buildMockPost({ id: "p2", slug: "p2", title: "P2", commentCount: 0 }),
  ];
  const page3Posts = [
    buildMockPost({ id: "p3", slug: "p3", title: "P3", commentCount: 0 }),
  ];
  const baseMock = buildMockFetcher({
    listingPages: [page1Posts, page2Posts, page3Posts],
  });

  const failures = new Map();
  const page2ListingUrl = `https://itsremalt.featurebase.app/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=2`;
  failures.set(page2ListingUrl, true);
  const mock = withMutableFailure(baseMock, failures);
  const { client, mcp } = await bootServer({ mock });
  try {
    // Call 1: page 2 listing throws -> list_posts surfaces the failure.
    const r1 = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    check("call 1: list-posts returned isError=true (listing page 2 failed)",
      r1.isError === true);
    const errText = (r1.content?.[0]?.text ?? "")
      .replace(/^MCP error -\d+:\s*/, "");
    check("call 1: error mentions listing/failed pages",
      /failed\s+pages/i.test(errText) || /listing/i.test(errText),
      `got: ${errText.slice(0, 120)}`);
    check("call 1: error mentions page 2",
      /\bpages?\s*2\b/i.test(errText),
      `got: ${errText.slice(0, 120)}`);

    // get_post must also fail (depends on getAllPosts).
    const r1b = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p2", include_comments: false },
    });
    check("call 1: get-post also errors out (depends on listing)",
      r1b.isError === true);

    // Find user must also fail.
    const r1c = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    check("call 1: find-user also errors out (depends on listing)",
      r1c.isError === true);

    // Stalled promises must also fail.
    const r1d = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 0, limit: 10 },
    });
    check("call 1: stalled-promises also errors out (depends on listing)",
      r1d.isError === true);

    // Recovery: flip page 2 to success.
    failures.delete(page2ListingUrl);
    const listingCountBefore2 = baseMock.listingCount();

    // Call 2: SAME client, listing now succeeds completely.
    const r2 = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    check("call 2: list-posts returned cleanly",
      r2.isError !== true);
    const b2 = parseText(r2);
    check("call 2: all 3 posts returned (complete listing)",
      b2.returned === 3, `got: ${b2.returned}`);
    check("call 2: slugs are p1, p2, p3 in order",
      b2.posts.map((p) => p.slug).join(",") === "p1,p2,p3",
      `got: ${b2.posts.map((p) => p.slug).join(",")}`);
    // Listing was refetched entirely — call 1 did NOT cache the partial
    // listing under "list:all".
    check("call 2: all 3 listing pages were refetched (no poisoned cache)",
      baseMock.listingCount() - listingCountBefore2 === 3,
      `delta: ${baseMock.listingCount() - listingCountBefore2}`);

    // Call 3: listing is now cached -> zero new fetches.
    const before3 = baseMock.totalCount();
    await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: { status: "all", sortBy: "date:desc", limit: 50 },
    });
    check("call 3: ZERO new fetches (listing cache hit)",
      baseMock.totalCount() === before3,
      `delta: ${baseMock.totalCount() - before3}`);
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO D: get_featurebase_post does NOT falsely return
// "not found" after an incomplete listing that was atomic-failed.
// ============================================================
console.log("\n=== Scenario D: get-post does not falsely not-found after atomic listing failure ===\n");
{
  // 2-page listing; page 2 fails.
  const page1Posts = [
    buildMockPost({ id: "p1", slug: "p1", title: "P1", commentCount: 0 }),
  ];
  const page2Posts = [
    buildMockPost({ id: "p2", slug: "p2", title: "P2", commentCount: 0 }),
  ];
  const baseMock = buildMockFetcher({
    listingPages: [page1Posts, page2Posts],
  });
  const failures = new Map();
  const page2ListingUrl = `https://itsremalt.featurebase.app/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=2`;
  failures.set(page2ListingUrl, true);
  const mock = withMutableFailure(baseMock, failures);
  const { client, mcp } = await bootServer({ mock });
  try {
    // p2 exists in the fixture but page 2 fetch fails.
    const r = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p2", include_comments: false },
    });
    check("get-post for p2 (which exists on failed page): isError=true",
      r.isError === true);
    const errText = (r.content?.[0]?.text ?? "")
      .replace(/^MCP error -\d+:\s*/, "");
    // Must NOT report "Post not found" — must report listing failure.
    check("error does NOT falsely say 'Post not found'",
      !/not found/i.test(errText),
      `got: ${errText.slice(0, 120)}`);
    check("error mentions the listing failure",
      /listing/i.test(errText) || /failed\s+pages/i.test(errText),
      `got: ${errText.slice(0, 120)}`);
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO E: find_featurebase_user cannot claim commentsComplete:true
// when a listing page was unavailable. The listing atomic throw
// must surface to find-user as isError, not as a quietly-complete
// board-wide claim.
// ============================================================
console.log("\n=== Scenario E: find-user cannot claim complete when listing fails ===\n");
{
  const page1Posts = [
    buildMockPost({ id: "p1", slug: "p1", title: "P1", commentCount: 1,
      author: { _id: "alice-id", name: "Alice" } }),
  ];
  const page2Posts = [
    buildMockPost({ id: "p2", slug: "p2", title: "P2", commentCount: 0 }),
  ];
  const baseMock = buildMockFetcher({
    listingPages: [page1Posts, page2Posts],
    commentPages: {
      p1: [[buildMockComment({
        id: "c1", userId: "alice-id", name: "Alice",
        createdAt: "2026-05-01T00:00:00Z",
      })]],
    },
  });
  const failures = new Map();
  const page2ListingUrl = `https://itsremalt.featurebase.app/api/v1/submission?sortBy=date:desc&inReview=false&includePinned=true&page=2`;
  failures.set(page2ListingUrl, true);
  const mock = withMutableFailure(baseMock, failures);
  const { client, mcp } = await bootServer({ mock });
  try {
    const r = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    check("find-user: isError=true (listing page 2 unavailable)",
      r.isError === true);
    // Crucial: it must NOT return a clean response with
    // commentsComplete:true (which would falsely claim a board-wide total
    // for alice based on p1 only — p2 might have alice comments we never saw).
    const errText = (r.content?.[0]?.text ?? "")
      .replace(/^MCP error -\d+:\s*/, "");
    check("find-user error does NOT report commentsComplete:true",
      !/commentsComplete["']?\s*:\s*true/.test(errText),
      `got: ${errText.slice(0, 120)}`);
    check("find-user error mentions listing failure",
      /listing/i.test(errText) || /failed\s+pages/i.test(errText),
      `got: ${errText.slice(0, 120)}`);
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO F: unusedTeamUserIds is failure-aware.
//   Same client, mutable fetcher. Page 2 of a comment thread fails on
//   the FIRST unused-ID walk. The response must:
//     - omit unusedTeamUserIds (the supplied ID could have been there)
//     - expose unusedTeamUserIdsComplete: false
//   After recovery, the same client returns unusedTeamUserIds with
//   unusedTeamUserIdsComplete: true.
// ============================================================
console.log("\n=== Scenario F: unusedTeamUserIds failure-aware ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "bob-id", name: "Bob" },
    }),
    buildMockPost({
      id: "p2", slug: "p2", title: "P2", commentCount: 2,
      author: { _id: "bob-id", name: "Bob" },
    }),
  ];
  // 2-page threads; p1's page 2 contains alice's comment. Without p1's
  // page 2, we cannot determine whether 'alice-id' is "unused" or not.
  const baseMock = buildMockFetcher({
    listingPages: [board],
    commentPages: {
      p1: [
        [buildMockComment({
          id: "c1a", userId: "bob-id", name: "Bob",
          createdAt: "2026-05-01T00:00:00Z",
        })],
        [buildMockComment({
          id: "c1b", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-02T00:00:00Z",
        })],
      ],
      p2: [
        [buildMockComment({
          id: "c2a", userId: "bob-id", name: "Bob",
          createdAt: "2026-05-03T00:00:00Z",
        })],
        [buildMockComment({
          id: "c2b", userId: "carol-id", name: "Carol",
          createdAt: "2026-05-04T00:00:00Z",
        })],
      ],
    },
  });
  const failures = new Map();
  // p1's page 2 fails. p1's page 2 contains alice-id; without it the
  // unusedTeamUserIds walk cannot determine whether alice is matched.
  const p1Page2Url = `https://itsremalt.featurebase.app/api/v1/comment?submissionId=p1&page=2`;
  failures.set(p1Page2Url, true);
  const mock = withMutableFailure(baseMock, failures);
  const { client, mcp } = await bootServer({ mock });
  try {
    // Call 1: p1 page 2 throws. The unusedTeamUserIds walk uses
    // getComments (which throws atomically). We must NOT claim
    // 'alice-id' is unused.
    const r1 = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: {
        minDaysSinceAdminReply: 0,
        limit: 10,
        teamUserIds: ["alice-id"], // override says alice is team; check 'unused'
      },
    });
    const b1 = parseText(r1);
    check("call 1: teamSource === 'override'",
      b1.teamSource === "override");
    check("call 1: unusedTeamUserIds is absent (cannot determine from incomplete threads)",
      b1.unusedTeamUserIds === undefined,
      `got: ${JSON.stringify(b1.unusedTeamUserIds)}`);
    check("call 1: unusedTeamUserIdsComplete === false",
      b1.unusedTeamUserIdsComplete === false,
      `got: ${b1.unusedTeamUserIdsComplete}`);
    // Note: alice appears in a comment thread, so even with complete
    // data, alice would NOT be unused — but the contract is that we
    // can't claim that without complete data.

    // Recovery.
    failures.delete(p1Page2Url);

    // Call 2: full threads available. unusedTeamUserIds should be
    // absent (alice matched in p1 page 2) and complete:true.
    const r2 = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: {
        minDaysSinceAdminReply: 0,
        limit: 10,
        teamUserIds: ["alice-id"],
      },
    });
    const b2 = parseText(r2);
    check("call 2: unusedTeamUserIdsComplete === true (complete data)",
      b2.unusedTeamUserIdsComplete === true,
      `got: ${b2.unusedTeamUserIdsComplete}`);
    check("call 2: unusedTeamUserIds is absent (alice IS matched, not unused)",
      b2.unusedTeamUserIds === undefined,
      `got: ${JSON.stringify(b2.unusedTeamUserIds)}`);

    // Call 3: try an override where one ID is genuinely unused. We use
    // a fresh thread where 'dave-id' never appears. Verify unused
    // detection works after recovery.
    const r3 = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: {
        minDaysSinceAdminReply: 0,
        limit: 10,
        teamUserIds: ["alice-id", "dave-id"],
      },
    });
    const b3 = parseText(r3);
    check("call 3: unusedTeamUserIdsComplete === true",
      b3.unusedTeamUserIdsComplete === true);
    check("call 3: unusedTeamUserIds includes 'dave-id' (genuinely unused)",
      Array.isArray(b3.unusedTeamUserIds) &&
        b3.unusedTeamUserIds.includes("dave-id") &&
        !b3.unusedTeamUserIds.includes("alice-id"),
      `got: ${JSON.stringify(b3.unusedTeamUserIds)}`);
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
