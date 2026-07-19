import { z } from "zod";
import { createClient } from "../client.js";
const client = createClient();

export const FindUserArgsSchema = {
  name: z
    .string()
    .min(2)
    .describe(
      "Partial name to search for, case-insensitive. Minimum 2 characters " +
        "to avoid matching everything on boards with common one-letter " +
        "fragments (e.g. 'a' would otherwise surface every user with 'A' " +
        "in their name). Scans post authors and the comment threads of " +
        "the N most recent posts with comments. Example: 'Krishna' returns " +
        "'Krishna - Remalt Dev' if they've posted or commented on the board.",
    ),
  sampleSize: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(5)
    .describe(
      "How many recent posts with comments to scan for comment authors. " +
        "Default 5 (cached comments make this cheap). Set to 0 to skip " +
        "comment scanning — only post authors will be returned. Max 20.",
    ),
};

export async function findUser(args: { name: string; sampleSize: number }) {
  const result = await client.findUser(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
