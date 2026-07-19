import { z } from "zod";
import { createClient } from "../client.js";
const client = createClient();

export const GetStatsArgsSchema = {
  topVotedLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe(
      "How many posts to return in topVoted. Default 5, max 50. Increase to break ties at the cutoff.",
    ),
  recentLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe(
      "How many posts to return in recent. Default 5, max 50.",
    ),
};

export async function getStats(args: {
  topVotedLimit: number;
  recentLimit: number;
}) {
  const stats = await client.getStats(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(stats, null, 2),
      },
    ],
  };
}