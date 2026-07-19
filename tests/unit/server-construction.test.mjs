// Smoke test — verify buildServer() constructs and lists tools
// without making any HTTP calls. Used as a fast CI gate.

import { buildServer } from "../../dist/server.js";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("=== Server construction smoke test ===\n");

const server = buildServer();
check("buildServer() returns a McpServer instance", !!server);

// Pull the underlying MCP tool list directly (no transport connect).
const handlers = server._registeredTools ?? {};
const toolCount = Object.keys(handlers).length;
console.log(`  Registered tool names: ${Object.keys(handlers).sort().join(", ")}`);
check("registered tool count is 7", toolCount === 7);

const expectedNames = [
  "list_featurebase_posts",
  "get_featurebase_post",
  "get_featurebase_posts",
  "search_featurebase_posts",
  "get_featurebase_stats",
  "get_featurebase_stalled_promises",
  "find_featurebase_user",
];
for (const name of expectedNames) {
  check(`tool "${name}" registered`, handlers[name] !== undefined);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
