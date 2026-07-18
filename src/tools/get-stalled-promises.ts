import { z } from "zod";
import { client } from "../client.js";

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
};

export async function getStalledPromises(args: {
  minDaysSinceAdminReply: number;
  limit: number;
}) {
  const result = await client.getStalledPromises(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
