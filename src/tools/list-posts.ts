import { z } from "zod";
import { client } from "../client.js";

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
};

export async function listPosts(args: {
  status: "all" | "open" | "in_review" | "planned" | "in_progress" | "completed";
  sortBy: "date:desc" | "date:asc" | "upvotes:desc";
  limit: number;
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