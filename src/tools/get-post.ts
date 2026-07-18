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
      "If true, fetch and inline the full comment thread as a `comments` " +
        "array on the response (nested with `replies`). Each comment carries " +
        "author (name, userId, role='admin'|'customer'), bodyHtml, bodyText, " +
        "createdAt, updatedAt, upvotes, parentId, and replies[]. On fetch " +
        "failure the post is still returned with `commentsError` set. " +
        "Default: false.",
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
