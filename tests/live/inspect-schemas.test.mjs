
// LIVE-INTEGRATION: only runs when LIVE=1.
if (process.env.LIVE !== '1') {
  console.log('  [skipped, set LIVE=1 to run]');
  process.exit(0);
}
// Inspect what MCP clients see via listTools — must show REAL schemas.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client(
  { name: "schema-inspector", version: "1" },
  { capabilities: {} },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["./dist/index.js"],
});

await client.connect(transport);
const tools = await client.listTools();

console.log("=== ADVERTISED TOOL SCHEMAS (what agents see) ===\n");
for (const tool of tools.tools) {
  console.log(`\n--- ${tool.name} ---`);
  console.log(`description: ${tool.description.slice(0, 100)}…`);
  console.log("inputSchema:");
  console.log(JSON.stringify(tool.inputSchema, null, 2));
}

// Critical checks
function assert(name, cond, info = "") {
  if (cond) console.log(`✓ ${name}${info ? " (" + info + ")" : ""}`);
  else {
    console.log(`✗ ${name}${info ? " (" + info + ")" : ""}`);
    process.exitCode = 1;
  }
}

console.log("\n=== ASSERTIONS ===");
const post = tools.tools.find((t) => t.name === "get_featurebase_post");
const stalled = tools.tools.find((t) => t.name === "get_featurebase_stalled_promises");
const user = tools.tools.find((t) => t.name === "find_featurebase_user");

// 1. Has real properties (not just empty object)
assert(
  "get_featurebase_post inputSchema has 'slug' property (string, minLength 1)",
  post?.inputSchema?.properties?.slug?.type === "string" &&
    post.inputSchema.properties.slug.minLength === 1,
);
assert(
  "get_featurebase_post inputSchema has 'include_comments' (boolean, default false)",
  post?.inputSchema?.properties?.include_comments?.type === "boolean" &&
    post.inputSchema.properties.include_comments.default === false,
);
assert(
  "get_featurebase_post inputSchema has 'teamUserIds' (array of strings, optional)",
  post?.inputSchema?.properties?.teamUserIds?.type === "array" &&
    post.inputSchema.properties.teamUserIds.items?.type === "string" &&
    !post.inputSchema.required?.includes("teamUserIds"),
);
assert(
  "get_featurebase_post inputSchema requires 'slug'",
  post?.inputSchema?.required?.includes("slug") === true,
);
assert(
  "get_featurebase_post inputSchema has additionalProperties: false",
  post?.inputSchema?.additionalProperties === false,
);

// get_featurebase_stalled_promises
assert(
  "get_featurebase_stalled_promises inputSchema has minDaysSinceAdminReply (integer, 0-365, default 7)",
  stalled?.inputSchema?.properties?.minDaysSinceAdminReply?.type === "integer" &&
    stalled.inputSchema.properties.minDaysSinceAdminReply.minimum === 0 &&
    stalled.inputSchema.properties.minDaysSinceAdminReply.maximum === 365 &&
    stalled.inputSchema.properties.minDaysSinceAdminReply.default === 7,
);
assert(
  "get_featurebase_stalled_promises has limit (1-50, default 20)",
  stalled?.inputSchema?.properties?.limit?.minimum === 1 &&
    stalled.inputSchema.properties.limit?.maximum === 50 &&
    stalled.inputSchema.properties.limit?.default === 20,
);
assert(
  "get_featurebase_stalled_promises has status enum array (open, in_review, planned, in_progress, completed)",
  Array.isArray(stalled?.inputSchema?.properties?.status?.items?.enum) &&
    stalled.inputSchema.properties.status.items.enum.length === 5,
);
assert(
  "get_featurebase_stalled_promises has sortBy enum (staleness, freshness, upvotes, default staleness)",
  stalled?.inputSchema?.properties?.sortBy?.default === "staleness" &&
    stalled.inputSchema.properties.sortBy.enum?.length === 3,
);

// find_featurebase_user
assert(
  "find_featurebase_user inputSchema has 'name' (string, minLength 2)",
  user?.inputSchema?.properties?.name?.type === "string" &&
    user.inputSchema.properties.name.minLength === 2,
);
assert(
  "find_featurebase_user inputSchema has 'sampleSize' (integer, 0-20, default 5)",
  user?.inputSchema?.properties?.sampleSize?.type === "integer" &&
    user.inputSchema.properties.sampleSample?.default === undefined &&
    user.inputSchema.properties.sampleSize.minimum === 0 &&
    user.inputSchema.properties.sampleSize.maximum === 20 &&
    user.inputSchema.properties.sampleSize.default === 5,
);
assert(
  "find_featurebase_user inputSchema requires 'name'",
  user?.inputSchema?.required?.includes("name") === true,
);
assert(
  "find_featurebase_user inputSchema has additionalProperties: false",
  user?.inputSchema?.additionalProperties === false,
);

// Make sure NOT passthrough (would have additionalProperties: true OR no properties)
assert(
  "get_featurebase_post is NOT passthrough (has properties object)",
  !!post?.inputSchema?.properties &&
    Object.keys(post.inputSchema.properties).length >= 3,
);
assert(
  "get_featurebase_stalled_promises is NOT passthrough (has properties object)",
  !!stalled?.inputSchema?.properties &&
    Object.keys(stalled.inputSchema.properties).length >= 4,
);

await client.close();
console.log(process.exitCode ? "\nFAIL" : "\nALL CHECKS PASS");
