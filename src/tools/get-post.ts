import { z } from "zod";
import type { Client } from "../client.js";

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
        "author (name, userId, role='admin'|'customer'|'unknown'), bodyHtml, " +
        "bodyText, createdAt, updatedAt, upvotes, parentId, and replies[]. " +
        "On fetch failure the post is still returned with `commentsError` " +
        "set. Default: false.",
    ),
  teamUserIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional override for the team-user-id set. When provided, comments " +
        "(and engagement fields on the post) are re-classified using these " +
        "IDs as the team — useful for drilling into a single thread after " +
        "calling find_featurebase_user. With no env var configured AND no " +
        "teamUserIds passed, comment authors will show role='unknown' and " +
        "engagement fields will be omitted.",
    ),
};

export type GetPostArgs = {
  slug: string;
  include_comments: boolean;
  teamUserIds?: string[];
};

/**
 * Factory: bind the get-post MCP handler to a specific Client instance.
 */
export function createGetPostHandler(client: Client) {
  return async function getPost(args: GetPostArgs) {
    const post = await client.getPost(args.slug, args.include_comments, args.teamUserIds);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(post, null, 2),
        },
      ],
    };
  };
}
