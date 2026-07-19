/**
 * Fetcher factory — dependency injection for HTTP fetching.
 *
 * Production usage:
 *   import { createClient } from "./client.js";
 *   const client = createClient();
 *
 * Test usage:
 *   const client = createClient({
 *     fetcher: createFetcher({ fetchImpl: mockFetch, failOnUrlSubstr: "/comment" }),
 *   });
 *
 * The fetcher object owns:
 *   - the underlying fetch implementation (default: global fetch)
 *   - an optional "test-forced failure" hook (only triggered when
 *     `failOnUrlSubstr` is provided AND the URL contains it)
 *   - an optional "every fetch" callback (used by tests to count requests
 *     or capture them — never used in production)
 *
 * No global state. No shared counter. Production callers get an empty
 * fetch wrapper that's a near no-op over native `fetch`.
 */

export interface Fetcher {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface CreateFetcherOptions {
  /** Override the underlying fetch (tests inject mocks). */
  fetchImpl?: typeof fetch;
  /** Called after each successful fetch with the URL. Tests use for counting. */
  onFetch?: (url: string) => void;
  /**
   * Test-only: throw a synthetic error when the URL contains this substring.
   * Lets tests exercise partial-fetch failure paths without monkey-patching
   * global state. Production never sets this.
   */
  failOnUrlSubstr?: string;
}

export function createFetcher(opts: CreateFetcherOptions = {}): Fetcher {
  const impl = opts.fetchImpl ?? fetch;
  const onFetch = opts.onFetch;
  const failSubstr = opts.failOnUrlSubstr;

  return {
    async fetch(url: string, init: RequestInit): Promise<Response> {
      if (failSubstr && url.includes(failSubstr)) {
        throw new Error(`test-forced fetch failure: ${url}`);
      }
      const res = await impl(url, init);
      onFetch?.(url);
      return res;
    },
  };
}
