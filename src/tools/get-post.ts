import { z } from "zod";
import { client } from "../client.js";

export const GetPostArgsSchema = {
  slug: z
    .string()
    .min(1)
    .describe(
      "The post slug (the URL path segment after /posts/). Example: 'more-byok-options'",
    ),
  include_comments: z
    .boolean()
    .default(false)
    .describe(
      "NOT SUPPORTED — Featurebase post detail pages load comments via client-side JS we cannot reach. " +
        "Setting this to true will throw an error. Use commentCount from the post metadata instead, " +
        "or open the post URL in a browser to read the full thread. Default: false.",
    ),
};

export async function getPost(args: { slug: string; include_comments: boolean }) {
  const post = await client.getPost(args.slug, args.include_comments);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(post, null, 2),
      },
    ],
  };
}
