// Deterministic unit tests for the clean ZodIssue formatter. No network.
// Imports the compiled module directly so behavior is exercised exactly
// as production code sees it.

import { z } from "zod";
import { formatZodIssue } from "../../dist/validation.js";

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
function eq(actual, expected) {
  return actual === expected;
}

// --- too_big (range too high) ---
{
  const schema = z.number().int().min(0).max(365);
  const r = schema.safeParse(9999);
  check("9999 → too_big", !r.success && r.error.issues[0].code === "too_big");
  const msg = formatZodIssue(r.error.issues[0]);
  check(`9999 → "${msg}" is clean (no array)`, eq(msg, "argument: must be at most 365"));
  check("9999 message doesn't echo value", !msg.includes("9999"));
  check("9999 message doesn't include 'code:'", !msg.includes("code:"));
  check("9999 message doesn't include 'inclusive:'", !msg.includes("inclusive:"));
}

// --- too_small ---
{
  const schema = z.number().int().min(0);
  const r = schema.safeParse(-5);
  check("-5 → too_small", !r.success && r.error.issues[0].code === "too_small");
  const msg = formatZodIssue(r.error.issues[0]);
  check(`too_small message is "${msg}"`, eq(msg, "argument: must be at least 0"));
}

// --- min(2) chars ---
{
  const schema = z.string().min(2);
  const r = schema.safeParse("a");
  check("'a' → too_small on string", !r.success);
  const msg = formatZodIssue(r.error.issues[0]);
  check(`min-length message is "${msg}"`, eq(msg, "argument: must be at least 2"));
}

// --- type mismatch ---
{
  const schema = z.object({ x: z.number() });
  const r = schema.safeParse({ x: "oops" });
  check("string-for-number → invalid_type", r.success === false && r.error.issues[0].code === "invalid_type");
  const msg = formatZodIssue(r.error.issues[0]);
  check(`type mismatch msg is "${msg}"`, eq(msg, "x: expected number, received string"));
}

// --- invalid_enum ---
{
  const schema = z.object({ s: z.enum(["a", "b"]) });
  const r = schema.safeParse({ s: "c" });
  check("'c' → invalid_enum_value", !r.success && r.error.issues[0].code === "invalid_enum_value");
  const msg = formatZodIssue(r.error.issues[0]);
  check(`enum msg is "${msg}"`, eq(msg, "s: must be one of a, b"));
}

// --- multiple issues joined ---
{
  const schema = z.object({
    a: z.number().max(10),
    b: z.string().min(2),
  });
  const r = schema.safeParse({ a: 100, b: "x" });
  check("multi-issue fails", !r.success);
  check("2 issues", r.error.issues.length === 2);
  const messages = r.error.issues.map(formatZodIssue).join("; ");
  check(
    `joined messages are "${messages}"`,
    eq(messages, "a: must be at most 10; b: must be at least 2"),
  );
}

// --- unrecognized_keys ---
{
  const schema = z.object({ known: z.string() }).strict();
  const r = schema.safeParse({ known: "x", extra: 1 });
  check("extra key → unrecognized_keys", !r.success && r.error.issues[0].code === "unrecognized_keys");
  const msg = formatZodIssue(r.error.issues[0]);
  // Zod's strict() reports top-level (empty path); "argument" fallback.
  check(`unrecognized_keys msg is "${msg}"`, eq(msg, 'argument: unrecognized keys ["extra"]'));
}

// --- empty path falls back to "argument" ---
{
  const schema = z.string();
  const r = schema.safeParse(123);
  check("root-level type error", !r.success);
  const msg = formatZodIssue(r.error.issues[0]);
  check(`empty path → "argument": ${msg}`, msg.startsWith("argument:"));
}

console.log(`\n=== Unit results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
