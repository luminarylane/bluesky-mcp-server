/**
 * Pure post-metrics functions for the AT Protocol / Bluesky API.
 *
 * Reused by:
 *   1. The MCP server's tool handlers (future `bsky_get_post_metrics`).
 *   2. The web app's `mcp-router-metrics.ts` orchestrator — imported via
 *      webpack alias `@bluesky-mcp` from compiled `dist/lib/`.
 *
 * AT Protocol exposes engagement counts on the PostView returned by
 * `app.bsky.feed.getPostThread`. Available fields: likeCount, repostCount,
 * replyCount, quoteCount. AT Protocol doesn't track impressions or reach.
 */

import type { AtpAgent } from "@atproto/api";
import { withRetry } from "../rate-limiter.js";

export interface BlueskyPostMetrics {
  likeCount: number | null;
  repostCount: number | null;
  replyCount: number | null;
  quoteCount: number | null;
  /** Raw PostView for debugging / audit. */
  raw: unknown;
}

export interface FetchPostMetricsArgs {
  /** AT URI of the post, e.g. `at://did:plc:.../app.bsky.feed.post/3ml5oy7x7yd2c` */
  uri: string;
}

/**
 * Fetch engagement counts for a single Bluesky post.
 *
 * @throws Error if uri is malformed or the API call exhausts retries.
 */
export async function fetchPostMetrics(
  agent: AtpAgent,
  args: FetchPostMetricsArgs,
): Promise<BlueskyPostMetrics> {
  if (!args.uri.trim() || !args.uri.startsWith("at://")) {
    throw new Error("uri must be a non-empty AT URI (at://...)");
  }

  const response = await withRetry(() =>
    agent.getPostThread({ uri: args.uri, depth: 0 }),
  );

  const thread = response.data.thread as Record<string, unknown> | undefined;
  const post = (thread?.post ?? {}) as Record<string, unknown>;

  return {
    likeCount: typeof post.likeCount === "number" ? post.likeCount : null,
    repostCount: typeof post.repostCount === "number" ? post.repostCount : null,
    replyCount: typeof post.replyCount === "number" ? post.replyCount : null,
    quoteCount: typeof post.quoteCount === "number" ? post.quoteCount : null,
    raw: post,
  };
}
