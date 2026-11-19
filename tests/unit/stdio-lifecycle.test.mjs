// Deterministic regression tests for dist/index.js stdio + process lifecycle.
//
// Verifies that the CLI entry point exits promptly (never hangs or busy-loops)
// when its parent MCP client disconnects, closes stdin, destroys stdio pipes,
// or triggers an uncaught error / unhandled rejection while stderr is broken.
// No network calls.

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const INDEX_PATH = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const INDEX_URL = pathToFileURL(INDEX_PATH).href;
const TIMEOUT_MS = 5000;

let passed = 0;
let failed = 0;

function check(name, cond, info = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${info ? ` (${info})` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${info ? ` (${info})` : ""}`);
  }
}

function waitForExit(child, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore if already dead.
      }
      resolve({ timedOut: true, code: null, signal: null });
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal });
    });
  });
}

function waitForStderrMatch(child, substring, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stderr containing ${JSON.stringify(substring)}; got: ${buffer}`));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString();
      if (buffer.includes(substring)) {
        cleanup();
        resolve(buffer);
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Child exited early (${code}/${signal}) before stderr ${JSON.stringify(substring)}; got: ${buffer}`));
    }

    function cleanup() {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    }

    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

console.log("=== Stdio lifecycle & broken-pipe regression tests ===\n");

// Test 1: Graceful stdin EOF after startup exits cleanly with code 0.
{
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForStderrMatch(child, "started");
  child.stdin.end();
  const res = await waitForExit(child);
  check("stdin EOF exits promptly without timeout", !res.timedOut);
  check("stdin EOF exits with code 0", res.code === 0, `got ${res.code}`);
}

// Test 2: Abrupt pipe teardown immediately after spawn (reproduces prior EPIPE loop).
{
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  const res = await waitForExit(child);
  check("immediate pipe destroy exits promptly without spinning", !res.timedOut);
  check("immediate pipe destroy exits with code 0", res.code === 0, `got ${res.code}`);
}

// Test 2b: Abrupt pipe teardown while idle after startup exits cleanly with code 0.
{
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForStderrMatch(child, "started");
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  const res = await waitForExit(child);
  check("post-startup pipe destroy exits promptly", !res.timedOut);
  check("post-startup pipe destroy exits with code 0", res.code === 0, `got ${res.code}`);
}

// Test 3: Broken stdout during response write exits cleanly with code 0.
{
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForStderrMatch(child, "started");
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "1" },
      },
    }) + "\n",
  );
  const res = await waitForExit(child);
  check("broken stdout on response write exits promptly", !res.timedOut);
  check("broken stdout on response write exits with code 0", res.code === 0, `got ${res.code}`);
}

// Test 4: Malformed JSON line logs transport error without crashing, then exits on stdin EOF.
{
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForStderrMatch(child, "started");
  const transportErrPromise = waitForStderrMatch(child, "transport error");
  child.stdin.write("not valid json\n");
  await transportErrPromise;
  check("malformed JSON logs transport error without exiting", child.exitCode === null);
  child.stdin.end();
  const res = await waitForExit(child);
  check("after transport error, stdin EOF still exits 0", !res.timedOut && res.code === 0, `got ${res.code}`);
}

// Test 5: Uncaught exception while stderr pipe is broken exits 1 cleanly (no loop).
{
  const harness = `
    process.stdin.on("data", (d) => {
      if (d.toString().includes("__THROW__")) {
        setTimeout(() => { throw new Error("boom"); }, 20);
      }
    });
    await import(${JSON.stringify(INDEX_URL)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", harness], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForStderrMatch(child, "started");
  child.stderr.destroy();
  child.stdin.write("__THROW__\n");
  const res = await waitForExit(child);
  check("uncaughtException with broken stderr exits promptly", !res.timedOut);
  check("uncaughtException with broken stderr exits with code 1", res.code === 1, `got ${res.code}`);
}

// Test 6: Unhandled rejection while stderr pipe is broken exits 1 cleanly (no loop).
{
  const harness = `
    process.stdin.on("data", (d) => {
      if (d.toString().includes("__REJECT__")) {
        setTimeout(() => { Promise.reject(new Error("boom-reject")); }, 20);
      }
    });
    await import(${JSON.stringify(INDEX_URL)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", harness], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForStderrMatch(child, "started");
  child.stderr.destroy();
  child.stdin.write("__REJECT__\n");
  const res = await waitForExit(child);
  check("unhandledRejection with broken stderr exits promptly", !res.timedOut);
  check("unhandledRejection with broken stderr exits with code 1", res.code === 1, `got ${res.code}`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
