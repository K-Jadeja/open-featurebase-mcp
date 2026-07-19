// Deterministic schema-discovery test.
//
// We don't need a live board to verify that listTools advertises
// real schemas. We invoke the SAME path the SDK uses to serialize
// inputSchema in listTools:
//
//   1. buildServer() registers 7 tools, each holding a ZodObject
//      inputSchema.
//   2. We import the SDK's `toJsonSchemaCompat` (and a `ZodObject`
//      inputSchema, unaltered) to produce the same JSON Schema that
//      a connected MCP client would see via listTools.
//   3. We assert the same properties the live test asserted:
//      real properties, enum arrays, default values, numeric bounds,
//      additionalProperties:false, required list.
//
// No network, no McpServer transport. Replaces the prior LIVE=1
// version in tests/live/inspect-schemas.test.mjs (now deleted).

import { buildServer } from "../../dist/server.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

const server = buildServer();
const handlers = server._registeredTools ?? {};
const toolsByName = {};
for (const [name, t] of Object.entries(handlers)) {
  toolsByName[name] = toJsonSchemaCompat(t.inputSchema, {
    strictUnions: true,
    pipeStrategy: "input",
  });
}

console.log("=== ADVERTISED TOOL SCHEMAS (deterministic; mirrors listTools) ===\n");

const post = toolsByName["get_featurebase_post"];
const stalled = toolsByName["get_featurebase_stalled_promises"];
const user = toolsByName["find_featurebase_user"];
const list = toolsByName["list_featurebase_posts"];
const stats = toolsByName["get_featurebase_stats"];

// 7 tools registered
check(
  "all 7 tools registered with inputSchema",
  Object.keys(toolsByName).length === 7,
  `names=${Object.keys(toolsByName).sort().join(",")}`,
);

// --- get_featurebase_post ---
check(
  "get_featurebase_post.inputSchema has slug (string, minLength 1)",
  post?.properties?.slug?.type === "string" &&
    post.properties.slug.minLength === 1,
);
check(
  "get_featurebase_post.inputSchema has include_comments (boolean, default false)",
  post?.properties?.include_comments?.type === "boolean" &&
    post.properties.include_comments.default === false,
);
check(
  "get_featurebase_post.inputSchema has teamUserIds (array of strings, optional)",
  post?.properties?.teamUserIds?.type === "array" &&
    post.properties.teamUserIds.items?.type === "string" &&
    !post.required?.includes("teamUserIds"),
);
check(
  "get_featurebase_post.inputSchema requires 'slug'",
  post?.required?.includes("slug") === true,
);
check(
  "get_featurebase_post.inputSchema has additionalProperties: false",
  post?.additionalProperties === false,
);

// --- get_featurebase_stalled_promises ---
check(
  "get_featurebase_stalled_promises has minDaysSinceAdminReply (integer, 0-365, default 7)",
  stalled?.properties?.minDaysSinceAdminReply?.type === "integer" &&
    stalled.properties.minDaysSinceAdminReply.minimum === 0 &&
    stalled.properties.minDaysSinceAdminReply.maximum === 365 &&
    stalled.properties.minDaysSinceAdminReply.default === 7,
);
check(
  "get_featurebase_stalled_promises has limit (1-50, default 20)",
  stalled?.properties?.limit?.minimum === 1 &&
    stalled.properties.limit?.maximum === 50 &&
    stalled.properties.limit?.default === 20,
);
check(
  "get_featurebase_stalled_promises has status enum (open, in_review, planned, in_progress, completed)",
  Array.isArray(stalled?.properties?.status?.items?.enum) &&
    stalled.properties.status.items.enum.length === 5,
);
check(
  "get_featurebase_stalled_promises has sortBy enum (staleness, freshness, upvotes, default staleness)",
  stalled?.properties?.sortBy?.default === "staleness" &&
    Array.isArray(stalled.properties.sortBy.enum) &&
    stalled.properties.sortBy.enum.length === 3,
);
check(
  "get_featurebase_stalled_promises has additionalProperties:false",
  stalled?.additionalProperties === false,
);

// --- find_featurebase_user ---
check(
  "find_featurebase_user has name (string, minLength 2)",
  user?.properties?.name?.type === "string" &&
    user.properties.name.minLength === 2,
);
check(
  "find_featurebase_user has sampleSize (integer, 0-20, default 5)",
  user?.properties?.sampleSize?.type === "integer" &&
    user.properties.sampleSize.minimum === 0 &&
    user.properties.sampleSize.maximum === 20 &&
    user.properties.sampleSize.default === 5,
);
check(
  "find_featurebase_user requires name",
  user?.required?.includes("name") === true,
);
check(
  "find_featurebase_user has additionalProperties:false",
  user?.additionalProperties === false,
);

// --- list_featurebase_posts ---
check(
  "list_featurebase_posts has status enum (all, open, in_review, planned, in_progress, completed)",
  Array.isArray(list?.properties?.status?.enum) &&
    list.properties.status.enum.length === 6,
);
check(
  "list_featurebase_posts has sortBy enum (date:desc, date:asc, upvotes:desc)",
  Array.isArray(list?.properties?.sortBy?.enum) &&
    list.properties.sortBy.enum.length === 3,
);
check(
  "list_featurebase_posts has limit (1-200, default 50)",
  list?.properties?.limit?.minimum === 1 &&
    list.properties.limit.maximum === 200 &&
    list.properties.limit.default === 50,
);
check(
  "list_featurebase_posts has additionalProperties:false",
  list?.additionalProperties === false,
);

// --- get_featurebase_stats ---
check(
  "get_featurebase_stats has topVotedLimit + recentLimit (1-50, default 5)",
  stats?.properties?.topVotedLimit?.default === 5 &&
    stats.properties.topVotedLimit.maximum === 50 &&
    stats.properties.recentLimit?.default === 5,
);
check(
  "get_featurebase_stats has additionalProperties:false",
  stats?.additionalProperties === false,
);

// Pass-through schema would have either additionalProperties:true OR no
// properties at all; we reject it.
check(
  "no tool uses passthrough schema (all have ≥2 properties)",
  Object.values(toolsByName).every(
    (s) => s && s.properties && Object.keys(s.properties).length >= 2,
  ),
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
