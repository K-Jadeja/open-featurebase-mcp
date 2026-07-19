// Cold-cache perf test. Spawns a fresh server process via the SDK
// (which has the working MCP handshake), makes ONE cold-cache listing
// call, then reads the per-call HTTP request count from a temp file
// the server emits to (via FEATUREBASE_NET_COUNT_FILE env var).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "dist", "index.js");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

// Each run, use a unique temp file path.
const NET_COUNT_FILE = join(__dirname, `.net-count-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
writeFileSync(NET_COUNT_FILE, ""); // truncate

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    ...process.env,
    FEATUREBASE_BOARD_URL: "https://itsremalt.featurebase.app",
    FEATUREBASE_NET_COUNT_FILE: NET_COUNT_FILE,
  },
});

const client = new Client({ name: "cold-cache", version: "1" }, { capabilities: {} });
await client.connect(transport);

console.log("=== Cold-cache listing test ===");
console.log("(fresh server process; 5-min in-memory cache is empty)\n");

const t0 = Date.now();
const r = await client.callTool({
  name: "list_featurebase_posts",
  arguments: { limit: 200 },
});
const elapsed = Date.now() - t0;

await new Promise((r) => setTimeout(r, 200)); // small drain

// Read net count file. Server appends the count after each getAllPosts.
let content = "";
if (existsSync(NET_COUNT_FILE)) content = readFileSync(NET_COUNT_FILE, "utf-8");
const lines = content.split("\n").filter((l) => l.trim());
const counts = lines.map((l) => parseInt(l.trim(), 10)).filter((n) => !isNaN(n));

const parsed = JSON.parse(r.content[0].text);
const isError = r.isError === true;

console.log(`  wall time: ${elapsed}ms`);
console.log(`  tool calls observed in net-count file: ${counts.length}`);
console.log(`  per-call HTTP counts: ${JSON.stringify(counts)}`);
console.log(`  total HTTP requests (final count): ${counts[counts.length - 1]}`);
console.log(`  posts returned: ${parsed.returned}`);
console.log(`  totalResults: ${parsed.totalResults}`);

// Sanity
check("tool returned data (not error)", !isError && parsed);
check("posts returned > 0", parsed.returned > 0);

// We made ONE listing call, so the file should have ONE entry.
// (A second call would emit a second line — but that's the second call's count.)
check("exactly 1 entry in net-count file (1 listing call)", counts.length === 1);
const totalHttp = counts[0];
// Expected: 6 listing pages + 33 comment fetches = 39
// Allow modest variance: 30..50
check(
  `total HTTP ${totalHttp} in 30..50 range (expected ~39: 6 listing + 33 comments)`,
  totalHttp >= 30 && totalHttp <= 50,
);
check(`wall time < 15s (took ${elapsed}ms)`, elapsed < 15000);

unlinkSync(NET_COUNT_FILE);
await client.close();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
