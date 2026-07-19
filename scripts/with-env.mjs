// scripts/with-env.mjs
//
// Portable env-gated launcher for live MCP tests. Replaces
// `LIVE=1 node ...` (which is bash-only and breaks on Windows
// PowerShell + cmd).
//
// Usage:
//   node scripts/with-env.mjs --live node tests/live/real-mcp.test.mjs
// Or equivalently:
//   npm run test:live    ← already wired in package.json
//
// Setting LIVE=1 (or any non-empty value) via the shell is preserved;
// if not set, the child is still invoked but a clear banner indicates
// the live gate is OFF and the child should self-skip. This is how
// the test suite handles the offline default — no shell-specific
// variable forwarding required.
//
// Exit codes: forwards the child's exit code, or 2 on bad usage.

import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const live = process.env.LIVE && process.env.LIVE.length > 0;

if (argv.length < 1) {
  console.error("usage: node scripts/with-env.mjs --live <command...>");
  console.error("   or: node scripts/with-env.mjs <command...>");
  process.exit(2);
}

// Strip the --live marker; we don't pass it to the child.
const childArgv = argv[0] === "--live" ? argv.slice(1) : argv;
if (childArgv.length === 0) {
  console.error("error: --live must be followed by a command");
  process.exit(2);
}

// Surface the gate in the child's env so it can self-skip without
// shell-specific forwarding. Children should look at process.env.LIVE_GATE.
const childEnv = {
  ...process.env,
  LIVE_GATE: live ? "1" : "0",
};

const [cmd, ...cmdArgs] = childArgv;
const child = spawn(cmd, cmdArgs, {
  stdio: "inherit",
  env: childEnv,
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("with-env: failed to spawn child:", err.message);
  process.exit(1);
});
