/**
 * Clean ZodIssue formatter — request-scoped, no shared state, no value
 * echo. Exposed as a separate module so unit tests can drive it
 * deterministically without spinning up the MCP server.
 *
 * Output shape: "<path>: <constraint>"
 *   - too_big:        "<path>: must be at most <max>" (or "(exclusive)")
 *   - too_small:      "<path>: must be at least <min>"
 *   - invalid_type:   "<path>: expected <expected>, received <received>"
 *   - invalid_enum:   "<path>: must be one of <options...>"
 *   - invalid_string: "<path>: <validation>"
 *   - unrecognized:   "<path>: unrecognized keys [<keys>]"
 *   - default:        "<path>: <message>"
 *
 * Never echoes the failing value, so secrets or large payloads cannot
 * leak via a validation error.
 */
export function formatZodIssue(issue: import("zod").ZodIssue): string {
  const path = (issue.path ?? []).join(".") || "argument";
  switch (issue.code) {
    case "too_big":
      return `${path}: must be at most ${issue.maximum}${
        issue.inclusive ? "" : " (exclusive)"
      }`;
    case "too_small":
      return `${path}: must be at least ${issue.minimum}${
        issue.inclusive ? "" : " (exclusive)"
      }`;
    case "invalid_type":
      return `${path}: expected ${issue.expected}, received ${issue.received}`;
    case "invalid_enum_value":
      return `${path}: must be one of ${(issue.options ?? []).join(", ")}`;
    case "invalid_string":
      return `${path}: ${issue.validation ?? "invalid string"}`;
    case "unrecognized_keys":
      return `${path}: unrecognized keys ${JSON.stringify(issue.keys ?? [])}`;
    default:
      return `${path}: ${issue.message ?? "invalid"}`;
  }
}
