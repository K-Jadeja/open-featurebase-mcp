import { z } from "zod";
import { createClient } from "../client.js";
const client = createClient();

export const GetPostsArgsSchema = {
  slugs: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
      "Array of post slugs to fetch. Returns posts in the order requested. " +
        "Slugs not in the snapshot are returned in the `notFound` field rather than throwing.",
    ),
  include_content: z
    .boolean()
    .default(false)
    .describe(
      "If true, attach full contentHtml + contentText to each post INLINE on posts[i] " +
        "(mirrors the singular get_featurebase_post shape — same fields, just on each element). " +
        "Off by default — the 800-char excerpt is usually enough for clustering/dedup work. " +
        "Turn on only when you need the full body.",
    ),
};

export async function getPosts(args: { slugs: string[]; include_content: boolean }) {
  const result = await client.getPosts({
    slugs: args.slugs,
    include_content: args.include_content,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}