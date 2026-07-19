import { z } from "zod";
import type { Client } from "../client.js";

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
    .describe("How many posts to return in recent. Default 5, max 50."),
};

export type GetStatsArgs = { topVotedLimit: number; recentLimit: number };

/**
 * Factory: bind the get-stats MCP handler to a specific Client instance.
 */
export function createGetStatsHandler(client: Client) {
  return async function getStats(args: GetStatsArgs) {
    const stats = await client.getStats(args);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  };
}
