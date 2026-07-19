// tests/unit/__fixtures__.mjs
//
// Shared in-memory mock fetcher + canned responses for deterministic
// tests. No live network — these fixtures are the canonical
// representation of "a Featurebase board" used by the deterministic
// unit tests, and must stay under tests/unit/ so they ship with CI.
//
// Conventions:
//   * Listing pages: feed `feedListing({ ..., totalPages: N })` and
//     pages 1..N are served with `results[]` populated, page N+1
//     returns empty `results: []`.
//   * Comment endpoints: feed `feedComments({ submissionId: "X",
//     comments: [...] })` and pages 1..N for that submissionId are
//     served.
//   * Counters (`listingCount`, `commentCount`) let tests assert the
//     number of underlying fetch calls, exactly as the old
//     `createFetcher({ onFetch })` counter did.
//
// The fake user "kr-author" appears in both a listing-author role and
// in one comment thread, so findUser({ name: "kr" }) returns it with a
// populated totalCommentCount.

const BASE_URL = "https://itsremalt.featurebase.app";

export const FIXTURE_USER_IDS = {
  krAuthor: "kr-author-uid",
  otherUser: "other-user-uid",
};

export function buildListingPage(pageNumber, items) {
  return {
    results: items,
    page: pageNumber,
    limit: 50,
    totalPages: 1,
    totalResults: items.length,
  };
}

export function buildMockPost({
  id = "post-1",
  slug = "post-1",
  title = "Post 1",
  commentCount = 0,
  author = { _id: FIXTURE_USER_IDS.otherUser, name: "Other User" },
}) {
  return {
    id,
    slug,
    title,
    content: `<p>body of ${slug}</p>`,
    upvotes: 0,
    commentCount,
    date: "2026-01-01T00:00:00Z",
    user: author,
    postStatus: { name: "Open", type: "open", color: "#000" },
    postCategory: { name: { en: "General" } },
  };
}

export function buildMockComment({
  id,
  userId = FIXTURE_USER_IDS.otherUser,
  name = "Other User",
  createdAt = "2026-01-02T00:00:00Z",
  body = "a comment",
  parentComment = null,
  replies = [],
}) {
  return {
    id,
    user: { _id: userId, name },
    content: `<p>${body}</p>`,
    createdAt,
    updatedAt: createdAt,
    upvotes: 0,
    parentComment,
    replies: replies.map((r) =>
      buildMockComment({ ...r, parentComment: id }),
    ),
  };
}

/**
 * Build a mock fetcher + a tracking counter. Feed canned responses
 * for any URL pattern used by the production client. By default,
 * unknown URLs throw (so a test that fails to provide a fixture fails
 * loudly rather than silently returning junk).
 */
export function buildMockFetcher({
  listingPages = [],
  commentPages = {},
} = {}) {
  const calls = [];
  function record(url) { calls.push(url); }

  function jsonResponse(body) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/json" },
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  }

  async function fetchImpl(url, init) {
    record(url);
    // ---- /api/v1/submission?page=N ----
    const submissionMatch = url.match(/[?&]page=(\d+)/);
    if (url.includes("/api/v1/submission")) {
      const page = submissionMatch ? Number(submissionMatch[1]) : 1;
      // listingPages is expected to be an array of PAGES where each
      // page is an array of post objects: [[post1, post2], [post3]].
      const items = listingPages[page - 1] ?? [];
      const totalPages = listingPages.length || 0;
      // If client over-fetches (requests a page beyond totalPages),
      // return an empty page so the client's pagination-loop ends cleanly.
      return jsonResponse({
        results: items,
        page,
        limit: 50,
        totalPages,
        totalResults: items.length, // realistic for our canned boards
      });
    }
    // ---- /api/v1/comment?submissionId=X&page=N ----
    if (url.includes("/api/v1/comment")) {
      const subm = new URL(url, BASE_URL).searchParams.get("submissionId");
      const page = Number(new URL(url, BASE_URL).searchParams.get("page") || 1);
      const pages = commentPages[subm] ?? [];
      if (pages.length === 0) {
        return jsonResponse({
          results: [],
          page,
          limit: 50,
          totalPages: 0,
          totalResults: 0,
        });
      }
      // Accept either shape:
      //   { p2: [[comment1, comment2]] } — array of pages (mirrors the
      //     live /api/v1/comment pagination shape).
      //   { p2: [comment1, comment2] } — single-page shortcut (most
      //     fixtures only have a few comments).
      const rawPage = pages[page - 1] ?? [];
      const items = Array.isArray(rawPage) && rawPage.length > 0 && Array.isArray(rawPage[0])
        ? rawPage[0]
        : Array.isArray(rawPage)
          ? rawPage
          : [rawPage];
      const totalPages = pages.length;
      return jsonResponse({
        results: items,
        page,
        limit: 50,
        totalPages,
        totalResults: items.length,
      });
    }
    throw new Error(`mock fetcher: unhandled url ${url}`);
  }

  return {
    fetch: fetchImpl,
    calls,
    listingCount() {
      return calls.filter((u) => u.includes("/api/v1/submission")).length;
    },
    commentCount() {
      return calls.filter((u) => u.includes("/api/v1/comment")).length;
    },
    totalCount() { return calls.length; },
  };
}
