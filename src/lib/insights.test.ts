/**
 * fetchPostMetrics tests.
 *
 * Mocks the `@atproto/api` AtpAgent's `getPostThread` method.
 */

import { describe, it, expect, vi } from "vitest";
import type { AtpAgent } from "@atproto/api";
import { fetchPostMetrics } from "./insights.js";

const URI = "at://did:plc:fake/app.bsky.feed.post/3ml5oy7x7yd2c";

function makeAgent(response: unknown): AtpAgent {
  const getPostThread = vi.fn(async () => response);
  return { getPostThread } as unknown as AtpAgent;
}

describe("fetchPostMetrics", () => {
  it("parses counts from the PostView", async () => {
    const agent = makeAgent({
      data: {
        thread: {
          post: {
            likeCount: 12,
            repostCount: 4,
            replyCount: 2,
            quoteCount: 1,
          },
        },
      },
    });

    const result = await fetchPostMetrics(agent, { uri: URI });

    expect(result.likeCount).toBe(12);
    expect(result.repostCount).toBe(4);
    expect(result.replyCount).toBe(2);
    expect(result.quoteCount).toBe(1);
  });

  it("returns null fields when counts missing", async () => {
    const agent = makeAgent({ data: { thread: { post: {} } } });
    const result = await fetchPostMetrics(agent, { uri: URI });

    expect(result.likeCount).toBeNull();
    expect(result.repostCount).toBeNull();
  });

  it("rejects non-AT-URI inputs without hitting the network", async () => {
    const fn = vi.fn();
    const agent = { getPostThread: fn } as unknown as AtpAgent;

    await expect(
      fetchPostMetrics(agent, { uri: "not-at-uri" }),
    ).rejects.toThrow(/AT URI/);
    expect(fn).not.toHaveBeenCalled();
  });
});
