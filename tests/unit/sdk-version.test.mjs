// Pinning assertion — verifies the installed SDK version matches what
// package.json declares. Catches caret-style drift immediately.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
const sdk = pkg.dependencies?.["@modelcontextprotocol/sdk"] ?? "";
console.log("declared:", sdk);
if (/[\^~]/.test(sdk)) {
  console.error("✗ @modelcontextprotocol/sdk uses caret/tilde — must be pinned exactly");
  process.exit(1);
}
if (sdk !== "1.29.0") {
  console.error("✗ expected '1.29.0', got '" + sdk + "'");
  process.exit(1);
}

// Also verify the installed version matches
const installed = JSON.parse(readFileSync("./node_modules/@modelcontextprotocol/sdk/package.json", "utf-8")).version;
console.log("installed:", installed);
if (installed !== "1.29.0") {
  console.error("✗ installed " + installed + " != declared 1.29.0");
  process.exit(1);
}

console.log("✓ SDK version pinned to", sdk);
process.exit(0);
