// scripts/clean.mjs
//
// Portable replacement for `rm -rf dist`. Works on Windows + POSIX.
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const targets = ["dist"].map((p) => resolve(p));
for (const t of targets) {
  try {
    rmSync(t, { recursive: true, force: true });
    console.log(`removed: ${t}`);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error(`failed to remove ${t}:`, e.message);
      process.exitCode = 1;
    }
  }
}
