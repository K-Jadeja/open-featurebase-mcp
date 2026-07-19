// Deterministic server-level test for the private validateToolInput
// override.
//
// Why this test exists: the production MCP server installs an
// instance-level override of McpServer.validateToolInput (a
// @private-typed method in @modelcontextprotocol/sdk) so that
// validation errors come out as clean one-line messages
// ("minDaysSinceAdminReply: must be at most 365") instead of the
// SDK's default `Input validation error: Invalid arguments for tool
// X: [{"code":"too_big",...}]` dump.
//
// Pinning the SDK version does NOT prove the override is wired
// correctly — a future SDK could change the method signature and the
// pin alone wouldn't catch it. This test exercises the override path
// directly through MCP plumbing, with no network access.
//
// Strategy:
//   1. Build a server with a client whose fetcher is a no-op (so any
//      escape past validation does not hit the network).
//   2. Confirm server.validateToolInput is a function (instance
//      override installed).
//   3. Call server.validateToolInput directly with bad args for each
//      tool — assert clean McpError, no Zod internals in the message.
//   4. ALSO drive a real InMemoryTransport round-trip (the same path
//      an MCP client would use) to confirm CallToolRequest goes
//      through the override and surfaces the clean error.
//   5. Confirm no global Zod state was mutated — the override must
//      use a request-scoped formatter, NOT a global Zod patch.

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { buildServer } from "../../dist/server.js";
import { createClient } from "../../dist/client.js";
import { createFetcher } from "../../dist/fetcher.js";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

const noopClient = createClient({ fetcher: createFetcher() });
const server = buildServer({ client: noopClient });

check(
  "server.validateToolInput is a function (instance override installed)",
  typeof server.validateToolInput === "function",
);

const handlers = server._registeredTools ?? {};
const toolsByName = Object.fromEntries(
  Object.entries(handlers).map(([n, t]) => [n, t]),
);

console.log("=== Direct validateToolInput: bad args per tool ===\n");

// 3a. minDaysSinceAdminReply out of bounds (366 > 365)
{
  const tool = toolsByName["get_featurebase_stalled_promises"];
  let thrown;
  try {
    await server.validateToolInput(tool, { minDaysSinceAdminReply: 366 }, "get_featurebase_stalled_promises");
  } catch (e) { thrown = e; }
  check(
    "minDaysSinceAdminReply=366 → McpError InvalidParams",
    thrown instanceof McpError && thrown.code === ErrorCode.InvalidParams,
  );
  // McpError prepends "MCP error -32602: "; the actual JSON-RPC
  // payload still gets just our clean suffix. Strip the prefix for
  // the equality check on our override's own formatting.
  const cleanMsg = (thrown?.message ?? "").replace(/^MCP error -\d+:\s*/, "");
  check(
    `override produced clean message: "${cleanMsg}"`,
    cleanMsg === "minDaysSinceAdminReply: must be at most 365",
    `full: ${thrown?.message}`,
  );
  check(
    "no Zod internals (no 'code:', no 'inclusive:')",
    !cleanMsg.includes("code:") && !cleanMsg.includes("inclusive:"),
  );
}

// 3b. find_featurebase_user name too short (1 char)
{
  const tool = toolsByName["find_featurebase_user"];
  let thrown;
  try {
    await server.validateToolInput(tool, { name: "k" }, "find_featurebase_user");
  } catch (e) { thrown = e; }
  const cleanMsg = (thrown?.message ?? "").replace(/^MCP error -\d+:\s*/, "");
  check(
    "find_user name='k' → InvalidParams",
    thrown instanceof McpError && thrown.code === ErrorCode.InvalidParams,
  );
  check(
    `clean: "${cleanMsg}"`,
    cleanMsg === "name: must be at least 2",
    thrown?.message,
  );
}

// 3c. minDaysSinceAdminReply non-integer
{
  const tool = toolsByName["get_featurebase_stalled_promises"];
  let thrown;
  try {
    await server.validateToolInput(tool, { minDaysSinceAdminReply: 7.5 }, "get_featurebase_stalled_promises");
  } catch (e) { thrown = e; }
  const cleanMsg = (thrown?.message ?? "").replace(/^MCP error -\d+:\s*/, "");
  check(
    "minDaysSinceAdminReply=7.5 (not integer) → InvalidParams",
    thrown instanceof McpError && thrown.code === ErrorCode.InvalidParams,
  );
  check(
    `clean: "${cleanMsg}"`,
    cleanMsg === "minDaysSinceAdminReply: expected integer, received float",
    thrown?.message,
  );
}

// 3d. Invalid enum on sortBy
{
  const tool = toolsByName["get_featurebase_stalled_promises"];
  let thrown;
  try {
    await server.validateToolInput(tool, { sortBy: "wrong" }, "get_featurebase_stalled_promises");
  } catch (e) { thrown = e; }
  const cleanMsg = (thrown?.message ?? "").replace(/^MCP error -\d+:\s*/, "");
  check(
    "sortBy='wrong' → InvalidParams",
    thrown instanceof McpError && thrown.code === ErrorCode.InvalidParams,
  );
  check(
    "enum error message lists valid options",
    cleanMsg.includes("staleness") &&
      cleanMsg.includes("freshness") &&
      cleanMsg.includes("upvotes"),
  );
}

// 3e. Multiple issues joined with semicolons
{
  const tool = toolsByName["get_featurebase_stalled_promises"];
  let thrown;
  try {
    await server.validateToolInput(
      tool,
      { minDaysSinceAdminReply: 999, sortBy: "wrong" },
      "get_featurebase_stalled_promises",
    );
  } catch (e) { thrown = e; }
  const cleanMsg = (thrown?.message ?? "").replace(/^MCP error -\d+:\s*/, "");
  check(
    "two-issue input → joined message with ';'",
    typeof cleanMsg === "string" && cleanMsg.includes(";"),
  );
  check(
    "joined message contains both issue texts",
    cleanMsg.includes("must be at most 365") && cleanMsg.includes("staleness"),
  );
}

// 3f. Valid args parse cleanly (no throw)
{
  const tool = toolsByName["find_featurebase_user"];
  let thrown;
  let data;
  try {
    data = await server.validateToolInput(tool, { name: "krishna" }, "find_featurebase_user");
  } catch (e) { thrown = e; }
  check(
    "valid find_user args parse cleanly (no throw)",
    !thrown && data && data.name === "krishna" && data.sampleSize === 5,
    `data=${JSON.stringify(data)}`,
  );
}

// 3g. Don't echo the bad value (defense against secret leaks).
//
// The previous version passed a valid `name` value and asserted no
// echo — vacuous, since the validation succeeded and no error message
// was generated. This version uses a slot that DOES trigger a
// validation error (sortBy enum with a secret-looking value), and
// asserts the value is not in the error message.
//
// Zod's `invalid_enum_value` issue includes the offending value in its
// default message ("Invalid enum value. Expected 'a' | 'b', received 'X'"),
// so a sloppy formatter would echo it. Our formatter must NOT.
{
  const tool = toolsByName["get_featurebase_stalled_promises"];
  const secret = "sk-live-THIS-COULD-BE-A-SECRET-1234567890";
  let thrown;
  try {
    await server.validateToolInput(
      tool,
      { sortBy: secret }, // enum mismatch — Zod's default echoes the value
      "get_featurebase_stalled_promises",
    );
  } catch (e) {
    thrown = e;
  }
  check(
    "validation REJECTED the secret value (precondition for echo test)",
    thrown instanceof McpError,
    `thrown: ${thrown}`,
  );
  const cleanMsg = (thrown?.message ?? "").replace(/^MCP error -\d+:\s*/, "");
  check(
    `no echo of secret value in error message (msg: "${cleanMsg}")`,
    !cleanMsg.includes(secret),
  );
  check(
    "no echo of arbitrary 'sk-live-' prefix",
    !cleanMsg.includes("sk-live-"),
  );
  check(
    "no echo of arbitrary input that includes 'secret' substring",
    !/secret/i.test(cleanMsg),
  );
}

// 3h. formatZodIssue direct test — synthetic issue with a secret-shaped
// payload must produce a clean message that does NOT echo it. This is
// the unit-level proof that the formatter itself does not leak values,
// independent of any schema behavior.
//
// Important: formatZodIssue reads `issue.options` (not `issue.expected`)
// for invalid_enum_value. The previous version of this test passed
// `expected: ["a", "b"]` which the formatter silently ignored, then
// the assertion "includes 'a'" happened to pass because the path
// "apiKey" contains an 'a' and the prefix "must be one of" contains a
// 'b' in 'one'. That was accidental. The fixed version uses
// `options: ["a", "b"]` and asserts the exact expected output.
{
  const { formatZodIssue } = await import("../../dist/validation.js");
  const secret = "AKIA-FakeAWSKey-AAAABBBBCCCCDDDD";
  const syntheticIssue = {
    code: "invalid_enum_value",
    options: ["a", "b"],
    received: secret,
    path: ["apiKey"],
  };
  const formatted = formatZodIssue(syntheticIssue);
  check(
    `formatZodIssue produces exact expected output`,
    formatted === "apiKey: must be one of a, b",
    `got: ${formatted}`,
  );
  check(
    "formatZodIssue does NOT echo the offending secret value",
    !formatted.includes(secret),
    `formatted: ${formatted}`,
  );
  // Belt-and-braces: the formatter must not see the secret via any
  // field on the issue object, including the default-fallback path.
  check(
    "formatZodIssue never echoes received (no 'received:' substring)",
    !formatted.includes("received"),
  );
}

// ============================================================
// 4. End-to-end round-trip via InMemoryTransport.
// ============================================================
console.log("\n=== InMemoryTransport round-trip ===\n");

const server2 = buildServer({ client: noopClient });
const client2 = new McpClient(
  { name: "validation-test-client", version: "1" },
  { capabilities: {} },
);
const [t1, t2] = InMemoryTransport.createLinkedPair();
await Promise.all([server2.connect(t1), client2.connect(t2)]);

let result;
try {
  result = await client2.callTool({
    name: "get_featurebase_stalled_promises",
    arguments: { minDaysSinceAdminReply: 999 },
  });
} catch { /* callTool surfaces isError on result, not thrown */ }

check(
  "callTool(invalid args) → result.isError true",
  result && result.isError === true,
);
const errText = (result?.content?.[0]?.text ?? "").replace(/^MCP error -\d+:\s*/, "");
check(
  `error text clean: "${errText}"`,
  errText === "minDaysSinceAdminReply: must be at most 365",
  `got: ${result?.content?.[0]?.text}`,
);
check(
  "no SDK 'Input validation error:' prefix in user-facing text",
  !errText.includes("Input validation error:"),
);
check(
  "no Zod internals in user-facing text",
  !errText.includes("code:") &&
    !errText.includes("inclusive:") &&
    !errText.includes("expected:") &&
    !errText.includes("received:"),
);

// ============================================================
// 5. Confirm no global Zod state was mutated.
// ============================================================
// If our override had monkey-patched ZodError.prototype.message
// globally, then a fresh safeParse below would also show a clean
// message. It doesn't — Zod still emits its default shape.
console.log("\n=== Global Zod state intact ===\n");

const freshSchema = z.number().int().max(365);
const freshParse = freshSchema.safeParse(999);
// Zod's default message for too_big is "Number must be less than or
// equal to N" — it's the prefix-less default shape. Our override's
// output is "argument: must be at most N" or "minDaysSinceAdminReply:
// must be at most 365". If the global were patched, fresh schemas
// would also produce clean output. They don't.
check(
  "fresh Zod parse keeps default 'Number must be less than or equal to' shape",
  !freshParse.success &&
    freshParse.error.issues[0].message === "Number must be less than or equal to 365",
  `default message: ${freshParse.error.issues[0].message}`,
);
check(
  "fresh Zod issue still carries code field",
  freshParse.error.issues[0].code === "too_big",
);

await client2.close();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);