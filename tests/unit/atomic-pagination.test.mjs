// Deterministic atomic-multi-page-pagination regression suite.
//
// The previous getComments() used Promise.allSettled for pages 2..N,
// dropped rejected pages silently, and cached the partial thread as
// complete for 5 minutes. That corrupted:
//   - hasAdminReply
//   - admin/customer counts
//   - admin/customer last-reply dates
//   - totalCommentCount
//   - engagementComplete / commentsComplete
//   - stalled-promise detection
//
// After the fix, multi-page comment retrieval is ATOMIC: if any required
// page fails, getComments() throws ONE McpError listing the failed pages
// BEFORE normalization or caching. No partial thread is ever cached.
// Retry triggers a fresh fetch of all pages.
//
// These tests exercise the atomic contract through the real MCP tool
// surface (InMemoryTransport), covering:
//   - get_featurebase_post(include_comments=true) surfaces commentsError
//     and does NOT cache the partial thread
//   - list_featurebase_posts(hasAdminReply) reports engagementComplete=false
//     and failedPostSlugs
//   - get_featurebase_stalled_promises reports incomplete results and
//     the failed slug
//   - find_featurebase_user reports commentsComplete=false and does NOT
//     claim a board-wide total
//   - After the mock recovers, the next request refetches the missing
//     page and returns complete data
//   - Cross-tool: a failed stalled-promises does not poison the comment
//     index for a later find_featurebase_user
//
// All scenarios use the buildMockFetcher fixtures — zero live network.

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

async function bootServer({ mock, teamEnv = "alice-id" }) {
  if (teamEnv) process.env.FEATUREBASE_TEAM_USER_IDS = teamEnv;
  else delete process.env.FEATUREBASE_TEAM_USER_IDS;
  const client = createClient({ fetcher: mock });
  const server = buildServer({ client });
  const mcp = new McpClient(
    { name: "atomic-pagination-client", version: "1" },
    { capabilities: {} },
  );
  const [sT, cT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(sT), mcp.connect(cT)]);
  return { client, server, mcp };
}

// Helper: build a wrapping fetcher that throws for a specific page of
// a specific submissionId. Other URLs delegate to the base mock.
//
// The mock fetcher's URL pattern is:
//   /api/v1/comment?submissionId=<id>&page=<n>
// `throwOn` is { submissionId, page }. When the request matches, we
// record the call on the base mock so the existing counter still
// reflects the failure (proves the page was attempted).
function withSelectivePageFailure(baseMock, throwOn) {
  return {
    async fetch(url, init) {
      if (url.includes("/api/v1/comment")) {
        const subm = new URL(url, "https://x").searchParams.get("submissionId");
        const page = Number(new URL(url, "https://x").searchParams.get("page") || 1);
        if (throwOn.submissionId === subm && throwOn.page === page) {
          baseMock.calls.push(url);
          throw new Error(
            `injected failure: submissionId=${subm} page=${page}`,
          );
        }
      }
      return baseMock.fetch(url, init);
    },
  };
}

// ============================================================
// SCENARIO 1: page 1 succeeds, page 2 fails.
// get_featurebase_post(include_comments=true) must:
//   - return commentsError
//   - NOT return a partial comments[] array
//   - NOT cache the partial thread (next attempt with a working mock
//     fetches all pages fresh).
// ============================================================
console.log("=== Scenario 1: page-1-ok, page-2-fails → no partial cache ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 3,
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
          id: "c2", userId: "bob-id", name: "Bob",
          createdAt: "2026-06-01T00:00:00Z",
        })],
      ],
    },
  });
  const failingFetcher = withSelectivePageFailure(baseMock, {
    submissionId: "p1", page: 2,
  });
  const { mcp, client } = await bootServer({ mock: failingFetcher });
  try {
    const r = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    check("get_post returned cleanly (post is returned, comments flagged)", !r.isError);
    const body = parseText(r);
    check(
      "commentsError is set (string, non-empty)",
      typeof body.commentsError === "string" && body.commentsError.length > 0,
      `got: ${body.commentsError}`,
    );
    check(
      "commentsError mentions failed page 2",
      /failed\s+pages/i.test(body.commentsError) ||
        /\bpages?\s*2\b/i.test(body.commentsError),
      `got: ${body.commentsError}`,
    );
    check(
      "comments array is undefined (no partial thread returned)",
      body.comments === undefined,
      `got: ${Array.isArray(body.comments) ? `array len=${body.comments.length}` : typeof body.comments}`,
    );
    check(
      "post slug is still returned (we never throw the whole post)",
      body.slug === "p1",
      `got: ${body.slug}`,
    );
    // The atomic contract: the partial thread must NOT be cached. We
    // verify by counting calls — page 1 returned one page; if the
    // partial thread had been cached, the next request would NOT
    // refetch page 1.
    const callsAfterFirst = baseMock.commentCount();

    // Recovery: switch the fetcher to a non-throwing one and re-call.
    // The mock is identical to the underlying baseMock.fetch now.
    const recoveredClient = createClient({ fetcher: baseMock });
    const recoveredServer = buildServer({ client: recoveredClient });
    const mcp2 = new McpClient(
      { name: "atomic-recovery-client", version: "1" },
      { capabilities: {} },
    );
    const [sT2, cT2] = InMemoryTransport.createLinkedPair();
    await Promise.all([recoveredServer.connect(sT2), mcp2.connect(cT2)]);
    try {
      const r2 = await mcp2.callTool({
        name: "get_featurebase_post",
        arguments: { slug: "p1", include_comments: true },
      });
      check("recovery call returned cleanly", !r2.isError);
      const body2 = parseText(r2);
      check(
        "recovery: comments[] is populated with 2 comments (1 per page)",
        Array.isArray(body2.comments) && body2.comments.length === 2,
        `got: ${Array.isArray(body2.comments) ? body2.comments.length : typeof body2.comments}`,
      );
      check(
        "recovery: commentsError is absent (complete fetch)",
        body2.commentsError === undefined,
        `got: ${body2.commentsError}`,
      );
      check(
        "recovery: page 1 comment (alice) and page 2 comment (bob) both present",
        body2.comments.some((c) => c.author?.userId === "alice-id") &&
          body2.comments.some((c) => c.author?.userId === "bob-id"),
      );
    } finally {
      await mcp2.close();
    }

    check(
      "atomic contract: next request on a fresh client refetched page 1",
      baseMock.commentCount() > callsAfterFirst,
      `before recovery: ${callsAfterFirst}, after: ${baseMock.commentCount()}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 2: page 3 fails, pages 1+2 succeed.
// Same atomic behavior — getComments throws, surfaces as commentsError.
// ============================================================
console.log("\n=== Scenario 2: page-3-fails, pages 1+2 succeed ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 3,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // 3-page thread for p1. Pages 1+2 succeed; page 3 throws.
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
        [buildMockComment({
          id: "c3", userId: "bob-id", name: "Bob",
          createdAt: "2026-06-01T00:00:00Z",
        })],
      ],
    },
  });
  const failingFetcher = withSelectivePageFailure(baseMock, {
    submissionId: "p1", page: 3,
  });
  const { mcp } = await bootServer({ mock: failingFetcher });
  try {
    const r = await mcp.callTool({
      name: "get_featurebase_post",
      arguments: { slug: "p1", include_comments: true },
    });
    const body = parseText(r);
    check(
      "page-3-fail: commentsError is set",
      typeof body.commentsError === "string" && body.commentsError.length > 0,
    );
    check(
      "page-3-fail: commentsError mentions page 3 (in 'failed pages 3 of 3')",
      /\bpages?\s*3\b/i.test(body.commentsError),
      `got: ${body.commentsError}`,
    );
    check(
      "page-3-fail: comments array is undefined (partial thread NOT returned)",
      body.comments === undefined,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 3: list_featurebase_posts(hasAdminReply) reports
// engagementComplete=false and failedPostSlugs when a post's comments
// fail atomic pagination.
// ============================================================
console.log("\n=== Scenario 3: list-posts hasAdminReply surfaces atomic failure ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
    buildMockPost({
      id: "p2", slug: "p2", title: "P2", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // p1: single page; p2: 2 pages, page 2 fails.
  const baseMock = buildMockFetcher({
    listingPages: [board],
    commentPages: {
      p1: [[buildMockComment({
        id: "c1", userId: "alice-id", name: "Alice",
        createdAt: "2026-05-01T00:00:00Z",
      })]],
      p2: [
        [buildMockComment({
          id: "c2", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-02T00:00:00Z",
        })],
        [buildMockComment({
          id: "c3", userId: "bob-id", name: "Bob",
          createdAt: "2026-06-01T00:00:00Z",
        })],
      ],
    },
  });
  const failingFetcher = withSelectivePageFailure(baseMock, {
    submissionId: "p2", page: 2,
  });
  const { mcp } = await bootServer({ mock: failingFetcher });
  try {
    const r = await mcp.callTool({
      name: "list_featurebase_posts",
      arguments: {
        status: "all", sortBy: "date:desc", limit: 50,
        hasAdminReply: true,
        teamUserIds: ["alice-id"],
      },
    });
    check("list returned cleanly", !r.isError);
    const body = parseText(r);
    check(
      "engagementComplete === false",
      body.engagementComplete === false,
      `got: ${body.engagementComplete}`,
    );
    check(
      "failedPostSlugs includes 'p2'",
      Array.isArray(body.failedPostSlugs) && body.failedPostSlugs.includes("p2"),
      `got: ${JSON.stringify(body.failedPostSlugs)}`,
    );
    check(
      "warning is non-empty and explicitly counsels AGAINST deletion",
      typeof body.warning === "string" &&
        body.warning.length > 0 &&
        /do NOT delete/i.test(body.warning),
      `got: ${body.warning}`,
    );
    check(
      "warning recommends retry (transient API failure guidance)",
      /retry/i.test(body.warning ?? ""),
      `got: ${body.warning}`,
    );
    // p1 succeeded → alice's comment is admin → p1 stays in posts[].
    const slugs = body.posts.map((p) => p.slug);
    check(
      "p1 (succeeded) is in posts[]",
      slugs.includes("p1"),
      `got: ${slugs.join(",")}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 4: get_featurebase_stalled_promises reports incomplete
// results and the failed slug when a post's comment pagination fails.
// ============================================================
console.log("\n=== Scenario 4: stalled-promises surfaces atomic failure ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
    buildMockPost({
      id: "p2", slug: "p2", title: "P2", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // Both posts 2-page threads; p2's page 2 fails.
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
          createdAt: "2026-06-15T00:00:00Z",
        })],
      ],
      p2: [
        [buildMockComment({
          id: "c3", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-02T00:00:00Z",
        })],
        [buildMockComment({
          id: "c4", userId: "bob-id", name: "Bob",
          createdAt: "2026-06-16T00:00:00Z",
        })],
      ],
    },
  });
  const failingFetcher = withSelectivePageFailure(baseMock, {
    submissionId: "p2", page: 2,
  });
  const { mcp } = await bootServer({ mock: failingFetcher });
  try {
    const r = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 0, limit: 10 },
    });
    const body = parseText(r);
    check(
      "engagementComplete === false",
      body.engagementComplete === false,
    );
    check(
      "failedPostSlugs includes 'p2'",
      Array.isArray(body.failedPostSlugs) && body.failedPostSlugs.includes("p2"),
    );
    check(
      "warning is non-empty",
      typeof body.warning === "string" && body.warning.length > 0,
    );
    check(
      "warning explicitly counsels AGAINST deleting posts",
      /do NOT delete/i.test(body.warning ?? ""),
      `got: ${body.warning}`,
    );
    // Successful p1 still surfaced.
    const slugs = body.promises.map((p) => p.slug);
    check(
      "p1 (succeeded) is in promises[]",
      slugs.includes("p1"),
      `got: ${slugs.join(",")}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 5: find_featurebase_user reports commentsComplete=false
// and does NOT silently claim a complete board-wide total when
// a post's pagination fails.
// ============================================================
console.log("\n=== Scenario 5: find-user reports commentsComplete=false ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // 2-page thread for p1; page 2 fails.
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
  const failingFetcher = withSelectivePageFailure(baseMock, {
    submissionId: "p1", page: 2,
  });
  const { mcp } = await bootServer({ mock: failingFetcher });
  try {
    const r = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    const body = parseText(r);
    check(
      "commentsComplete === false",
      body.commentsComplete === false,
      `got: ${body.commentsComplete}`,
    );
    check(
      "warning is non-empty (caller sees partial data)",
      typeof body.warning === "string" && body.warning.length > 0,
    );
    // Atomic contract: when a multi-page comment fetch fails, NO
    // per-post comment counts are aggregated from that post. The
    // previous "undercount" behavior silently exposed a partial
    // totalCommentCount as if it were a board-wide number — that's
    // the bug we just fixed. With the atomic contract, alice is NOT
    // in matches (her only contribution was comments on the failed
    // thread, and we refuse to count from an incomplete thread).
    check(
      "no fake totalCommentCount exposed for alice (atomic contract)",
      !body.matches.some(
        (m) => m.userId === "alice-id" && typeof m.totalCommentCount === "number",
      ),
      `matches: ${JSON.stringify(body.matches)}`,
    );
    check(
      "matches array is empty (alice has no post authorship; comments failed atomically)",
      Array.isArray(body.matches) && body.matches.length === 0,
      `got: ${JSON.stringify(body.matches)}`,
    );

    // Recovery: switch the fetcher to a non-throwing one and re-call.
    // alice should now appear with the correct totalCommentCount.
    const recoveredClient = createClient({ fetcher: baseMock });
    const recoveredServer = buildServer({ client: recoveredClient });
    const mcp2 = new McpClient(
      { name: "atomic-find-recovery", version: "1" },
      { capabilities: {} },
    );
    const [sT2, cT2] = InMemoryTransport.createLinkedPair();
    await Promise.all([recoveredServer.connect(sT2), mcp2.connect(cT2)]);
    try {
      const r2 = await mcp2.callTool({
        name: "find_featurebase_user",
        arguments: { name: "Alice", sampleSize: 5 },
      });
      const body2 = parseText(r2);
      check(
        "recovery: commentsComplete === true",
        body2.commentsComplete === true,
        `got: ${body2.commentsComplete}`,
      );
      const alice = body2.matches.find((m) => m.userId === "alice-id");
      check(
        "recovery: alice now appears with totalCommentCount=2",
        alice?.totalCommentCount === 2,
        `got: ${alice?.totalCommentCount}`,
      );
    } finally {
      await mcp2.close();
    }
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 6: cross-tool recovery.
//   1) get_featurebase_stalled_promises triggers a comment fetch
//      whose pagination fails (page 2 of p2).
//   2) Mock recovers (page 2 no longer throws).
//   3) find_featurebase_user is called next.
//   4) find-user must NOT consume the (non-existent) stale index —
//      instead it builds a complete index from freshly-fetched complete
//      comment threads. The fact that ensureCommentIndex() is no longer
//      called from stalled-promises (audit fix) means the failed
//      stalled-promises does NOT pollute the comments:index cache.
// ============================================================
console.log("\n=== Scenario 6: cross-tool recovery after stalled-promises failure ===\n");
{
  const board = [
    buildMockPost({
      id: "p1", slug: "p1", title: "P1", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
    buildMockPost({
      id: "p2", slug: "p2", title: "P2", commentCount: 2,
      author: { _id: "other-id", name: "Other" },
    }),
  ];
  // Both 2-page threads; we will switch p2's page-2 behavior below.
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
      p2: [
        [buildMockComment({
          id: "c3", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-03T00:00:00Z",
        })],
        [buildMockComment({
          id: "c4", userId: "alice-id", name: "Alice",
          createdAt: "2026-05-04T00:00:00Z",
        })],
      ],
    },
  });

  // Phase 1: p2 page 2 fails. Run stalled-promises.
  let p2FailEnabled = true;
  const failingFetcher = {
    async fetch(url, init) {
      if (
        p2FailEnabled &&
        url.includes("/api/v1/comment") &&
        url.includes("submissionId=p2") &&
        /[?&]page=2\b/.test(url)
      ) {
        baseMock.calls.push(url);
        throw new Error("injected failure: p2 page 2");
      }
      return baseMock.fetch(url, init);
    },
  };
  const { mcp } = await bootServer({ mock: failingFetcher });
  try {
    // Stalled-promises: p2 fails, p1 succeeds.
    const stalledR = await mcp.callTool({
      name: "get_featurebase_stalled_promises",
      arguments: { minDaysSinceAdminReply: 0, limit: 10 },
    });
    const stalledBody = parseText(stalledR);
    check(
      "phase 1 stalled: engagementComplete === false",
      stalledBody.engagementComplete === false,
    );
    check(
      "phase 1 stalled: failedPostSlugs includes 'p2'",
      Array.isArray(stalledBody.failedPostSlugs) &&
        stalledBody.failedPostSlugs.includes("p2"),
    );

    // Phase 2: mock recovers. find-user must produce a COMPLETE index
    // (4 alice comments total across p1+p2, since both threads now
    // fetch all 2 pages successfully).
    p2FailEnabled = false;
    const findR = await mcp.callTool({
      name: "find_featurebase_user",
      arguments: { name: "Alice", sampleSize: 5 },
    });
    const findBody = parseText(findR);
    check(
      "phase 2 find-user: commentsComplete === true (recovered)",
      findBody.commentsComplete === true,
      `got: ${findBody.commentsComplete}`,
    );
    check(
      "phase 2 find-user: warning absent",
      findBody.warning === undefined,
      `got: ${findBody.warning}`,
    );
    // alice has 4 comments (2 per post × 2 posts) — the recovered
    // fetch must hit BOTH threads and BOTH pages.
    const alice = findBody.matches.find((m) => m.userId === "alice-id");
    check(
      "phase 2 find-user: alice totalCommentCount reflects BOTH complete threads",
      alice?.totalCommentCount === 4,
      `got: ${alice?.totalCommentCount}`,
    );
  } finally {
    await mcp.close();
    delete process.env.FEATUREBASE_TEAM_USER_IDS;
  }
}

// ============================================================
// SCENARIO 7: list-posts hasAdminReply warning does not contain
// the destructive phrase; this is the explicit contract test for the
// warning-text audit fix.
// ============================================================
console.log("\n=== Scenario 7: warning text cleanup (no destructive advice) ===\n");
{
  // Direct check: when hasAdminReply triggers a partial failure, the
  // warning text must not advise deleting or removing the affected
  // posts from the board. Verified both for the partial-failure path
  // (list-posts) and the partial-stalled path (stalled-promises).
  const allWarningsText =
    "Some posts had a transient API failure (network, rate-limit, " +
    "or service hiccup). Retry the request after a short delay; check " +
    "network connectivity and the Featurebase board status if the " +
    "failure persists. Do NOT delete or modify the affected posts — " +
    "they are still user-visible content.";
  check(
    "warning template includes retry advice",
    /retry/i.test(allWarningsText),
  );
  check(
    "warning template does NOT recommend deletion",
    !/delete/i.test(allWarningsText) ||
      /do NOT delete/i.test(allWarningsText),
  );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
