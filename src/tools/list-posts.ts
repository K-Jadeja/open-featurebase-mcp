import { z } from "zod";
import type { Client } from "../client.js";

export const ListPostsArgsSchema = {
  status: z
    .enum(["all", "open", "in_review", "planned", "in_progress", "completed"])
    .default("all")
    .describe(
      "Filter by Featurebase status. Values map to underlying postStatus.type as: " +
        "in_review → 'reviewing', planned → 'unstarted', in_progress → 'active', " +
        "completed → 'completed', open → 'open'.",
    ),
  sortBy: z
    .enum(["date:desc", "date:asc", "upvotes:desc"])
    .default("date:desc")
    .describe("Sort order for results."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum number of posts to return (1-200)."),
  hasAdminReply: z
    .boolean()
    .optional()
    .describe(
      "When true, restrict to posts where the team has authored at least " +
        "one comment (hasAdminReply === true). When false, restrict to posts " +
        "where the team has NOT commented. REQUIRES a team identity — if no " +
        "team is available (FEATUREBASE_TEAM_USER_IDS unset AND no teamUserIds " +
        "override supplied), the request FAILS with InvalidParams rather than " +
        "silently returning an empty list. Fabricating hasAdminReply=false " +
        "for every post would be a silent false-positive for callers asking " +
        "for hasAdminReply:false, and a silent false-negative for callers " +
        "asking for hasAdminReply:true. Call find_featurebase_user first to " +
        "discover user IDs, then pass them as teamUserIds.",
    ),
  teamUserIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional override for the team-user-id set. When provided as a NON-EMPTY " +
        "array, this list of IDs is treated as the team for hasAdminReply " +
        "classification, REPLACING the FEATUREBASE_TEAM_USER_IDS env var for " +
        "this call only. An EMPTY array ([]) is treated as ABSENT — the env " +
        "var is used if configured, otherwise the request still fails with " +
        "InvalidParams for hasAdminReply. Useful after a " +
        "find_featurebase_user drill-down — pass the returned userIds here to " +
        "filter the listing by team engagement without re-reading the env.",
    ),
};

export type ListPostsArgs = {
  status: "all" | "open" | "in_review" | "planned" | "in_progress" | "completed";
  sortBy: "date:desc" | "date:asc" | "upvotes:desc";
  limit: number;
  hasAdminReply?: boolean;
  teamUserIds?: string[];
};

/**
 * Factory: bind the list-posts MCP handler to a specific Client instance.
 * Tool modules must NOT instantiate clients at import time; the client
 * is provided per-server by `buildServer()`. Two independent servers
 * therefore get two independent clients + caches.
 */
export function createListPostsHandler(client: Client) {
  return async function listPosts(args: ListPostsArgs) {
    const result = await client.listPosts(args);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  };
}
