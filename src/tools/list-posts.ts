import { z } from "zod";
import { createClient } from "../client.js";
const client = createClient();

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
        "where the team has NOT commented. Requires FEATUREBASE_TEAM_USER_IDS " +
        "to be set or the request will return empty (engagement classification " +
        "is skipped when no team IDs are configured — see known limitations).",
    ),
};

export async function listPosts(args: {
  status: "all" | "open" | "in_review" | "planned" | "in_progress" | "completed";
  sortBy: "date:desc" | "date:asc" | "upvotes:desc";
  limit: number;
  hasAdminReply?: boolean;
}) {
  const result = await client.listPosts(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
