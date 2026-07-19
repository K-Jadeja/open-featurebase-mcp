# Internal Dependencies Used By Tests

This document enumerates every dependency the test suite reaches into
that is NOT part of the public API surface. Each carries breakage risk
on the next `@modelcontextprotocol/sdk` upgrade. The package is pinned
to the exact version that was current when these tests were written
(see `package.json` → `"@modelcontextprotocol/sdk": "1.29.0"` and
`tests/unit/sdk-version.test.mjs` which asserts the pin).

## Production code

| Dependency | What | File | Risk |
|---|---|---|---|
| `@modelcontextprotocol/sdk` McpServer instance method `validateToolInput` (typed `@private` but a regular instance method at runtime) | Overridden on the McpServer instance to produce clean one-line validation errors instead of the SDK's default `JSON.stringify(issues)` dump. One-line assignment in `src/server.ts`. | `src/server.ts` | If the SDK renames the method or removes it, validation errors regress to the SDK default format. Fallback plan: switch to a low-level `Server` + `setRequestHandler` setup (~50 LOC). Documented inline in `src/server.ts`. |

`tests/unit/server-validation.test.mjs` exercises this override through
a real `InMemoryTransport` round-trip and asserts the clean format.

## Tests-only internal dependencies

The following are reached ONLY by tests, never by production code.
If the SDK changes any of these, the affected test will fail loudly.

| Dependency | What | Used by | Risk |
|---|---|---|---|
| `McpServer._registeredTools` (private field) | Holds registered tool entries keyed by name. Tests read it to enumerate registered tools and to feed their `inputSchema` through `toJsonSchemaCompat`. | `tests/unit/server-construction.test.mjs`, `tests/unit/inspect-schemas.test.mjs` | If the field name changes, both tests fail loudly. Migration: search for `_registeredTools` and update. |
| `McpServer.validateToolInput` (private-typed instance method) | Tests call it directly with bad-args payloads to assert the clean-message contract. | `tests/unit/server-validation.test.mjs` | Same risk as the production-code override above. |
| `@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js` (`toJsonSchemaCompat`) | Converts a registered tool's ZodObject inputSchema into the same JSON Schema that `listTools` would advertise. The test imports this directly because the public SDK doesn't re-export it. | `tests/unit/inspect-schemas.test.mjs` | The internal path is `dist/esm/server/zod-json-schema-compat.js`. If the SDK reorganizes its dist layout, the import path breaks. Migration: `grep -r toJsonSchemaCompat node_modules/@modelcontextprotocol/sdk/dist` to find the new path. |

## What's NOT an internal dependency

| Public API | Verified by |
|---|---|
| `McpServer.registerTool(name, { inputSchema }, cb)` config-object form (the SDK's documented signature for registering tools) | `src/server.ts` |
| `InMemoryTransport.createLinkedPair()` + `Client.callTool({ name, arguments })` (the SDK's documented transport + client API) | `tests/unit/server-validation.test.mjs`, `tests/unit/server-cache-isolation.test.mjs`, `tests/unit/lazy-enrichment.test.mjs` |
| `McpError` / `ErrorCode.InvalidParams` (the SDK's documented error class) | `src/server.ts`, `src/client.ts` |

## How to verify the pin still holds

```bash
cd open-featurebase-mcp
npm test
# Look for: "SDK version pinned to 1.29.0"
```

If the SDK is upgraded, this test fails immediately:

```bash
grep -r "1.29.0" tests/unit/sdk-version.test.mjs
# Update both the test's expected version AND the package.json pin
```

## Updating the SDK (deliberate procedure)

1. Bump `@modelcontextprotocol/sdk` in `package.json` to the new version.
2. Run `npm test`. If any test listed above fails, follow the migration
   note in the rightmost column.
3. If the production override breaks, fall back to the low-level
   `Server` + `setRequestHandler` architecture documented in `src/server.ts`.
4. Update `tests/unit/sdk-version.test.mjs` to assert the new pin.
5. Run the live suite once (`LIVE=1 npm run test:live`) for sanity.