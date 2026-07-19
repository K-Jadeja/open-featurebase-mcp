import { z } from "zod";
import { createClient } from "../client.js";
const client = createClient();

export const SearchPostsArgsSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Keyword or phrase to search for. Matches against post titles (weighted 3x) and bodies (1x). Multi-word queries are tokenized.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of results to return (1-50)."),
};

export async function searchPosts(args: { query: string; limit: number }) {
  const result = await client.searchPosts(args);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}