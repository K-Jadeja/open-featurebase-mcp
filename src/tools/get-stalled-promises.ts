import { z } from "zod";
import type { Client } from "../client.js";

export const GetStalledPromisesArgsSchema = {
  minDaysSinceAdminReply: z
    .number()
    .int()
    .min(0)
    .max(365)
    .default(7)
    .describe(
      "Minimum number of days since the admin's last reply for a post to " +
        "qualify as a stalled promise. Default: 7. Set to 0 to surface every " +
        "post where the customer spoke last, regardless of age.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum number of stalled promises to return (1-50). Default: 20."),
  teamUserIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional override for the team-user-id set. When provided as a NON-EMPTY " +
        "array, these IDs REPLACE the FEATUREBASE_TEAM_USER_IDS env var for " +
        "this call only — the env var is ignored. Use this together with " +
        "find_featurebase_user to run a stalled-promise query without " +
        "env-var configuration. An EMPTY array ([]) is treated as ABSENT — " +
        "the env var team is used if configured; otherwise stalled-promises " +
        "returns immediately with teamSource='none' and a warning. Engagement " +
        "fields are re-computed on the fly from cached comments using this set.",
    ),
  status: z
    .array(z.enum(["open", "in_review", "planned", "in_progress", "completed"]))
    .optional()
    .describe(
      "Restrict candidates to posts with these statuses (e.g. " +
        "['in_progress', 'in_review'] to exclude Completed and Planned). " +
        "When omitted, all statuses are eligible.",
    ),
  sortBy: z
    .enum(["staleness", "freshness", "upvotes"])
    .default("staleness")
    .describe(
      "Sort order for returned stalled promises. " +
        "'staleness' (default): customerLastReplyDate desc — most-recent " +
        "stalled promises first. " +
        "'freshness': adminLastReplyDate desc — most-recent admin replies " +
        "first (catch up on what you just said). " +
        "'upvotes': upvotes desc — focus on high-impact items regardless of staleness.",
    ),
};

export type GetStalledPromisesArgs = {
  minDaysSinceAdminReply: number;
  limit: number;
  teamUserIds?: string[];
  status?: Array<"open" | "in_review" | "planned" | "in_progress" | "completed">;
  sortBy: "staleness" | "freshness" | "upvotes";
};

/**
 * Factory: bind the stalled-promises MCP handler to a specific Client instance.
 */
export function createGetStalledPromisesHandler(client: Client) {
  return async function getStalledPromises(args: GetStalledPromisesArgs) {
    const result = await client.getStalledPromises(args);
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
