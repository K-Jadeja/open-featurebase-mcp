// Deterministic server-reported-version test.
//
// The MCP server's reported `version` field (advertised during the
// handshake and surfaced via `serverInfo`) must equal the `version`
// field of the published package.json. This proves:
//   1. The server reads the version from package.json at runtime
//      (not a hard-coded string that can drift from the published
//      version).
//   2. The createRequire(import.meta.url) implementation correctly
//      resolves `../package.json` relative to dist/server.js (i.e.
//      the package root).
//
// No network. No fixtures. Reads only dist/ and ../package.json.

import { buildServer } from "../../dist/server.js";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name, cond, info = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${info ? " (" + info + ")" : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${info ? " (" + info + ")" : ""}`); }
}

console.log("=== MCP server-reported version ===\n");

// 1. The version in package.json is the source of truth.
const packageJsonPath = new URL("../../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
check(
  "package.json has a non-empty version field",
  typeof pkg.version === "string" && pkg.version.length > 0,
  `version: ${pkg.version}`,
);

// 2. The MCP server advertises that exact version.
const server = buildServer();
// The McpServer's inner Server stores serverInfo as a private field
// (`_serverInfo`). It's not on the public TypeScript surface, but it
// IS present on the runtime object — this test reads it directly,
// the same way server-construction.test.mjs reads _registeredTools.
const innerServer = server.server;
const serverInfo = innerServer && innerServer._serverInfo;

check(
  "McpServer exposes serverInfo at runtime",
  typeof serverInfo === "object" && serverInfo !== null,
  `serverInfo: ${JSON.stringify(serverInfo)}`,
);
check(
  "McpServer.serverInfo.name === 'featurebase-mcp'",
  serverInfo?.name === "featurebase-mcp",
  `got: ${serverInfo?.name}`,
);
check(
  "McpServer.serverInfo.version === package.json version",
  serverInfo?.version === pkg.version,
  `reported: ${serverInfo?.version}, package.json: ${pkg.version}`,
);
check(
  "version matches the documented semver shape (X.Y.Z)",
  /^\d+\.\d+\.\d+/.test(serverInfo?.version ?? ""),
  `got: ${serverInfo?.version}`,
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
