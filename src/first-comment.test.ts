/**
 * Regression tests for the #1995 first-comment partial-success contract (#1931).
 *
 * postBskyFirstComment is the isolated post-then-comment step bsky_create_post
 * delegates to for all embed types. If the post is live but the self-reply
 * fails, it must return { error } so the handler surfaces a partial failure —
 * never a clean success.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { postBskyFirstComment } from "./index.js";
import type { createAgent } from "./client.js";

type Agent = Awaited<ReturnType<typeof createAgent>>;

const PARENT = { uri: "at://did:plc:x/app.bsky.feed.post/1", cid: "cid-1" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function runWithTimers<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

function agentWithPost(post: ReturnType<typeof vi.fn>): Agent {
  // detectFacets only touches resolveHandle for @mentions; plain text needs none.
  return { post, resolveHandle: vi.fn() } as unknown as Agent;
}

describe("postBskyFirstComment — partial-success contract", () => {
  it("returns the reply AT URI as id and replies to the just-created post", async () => {
    vi.useFakeTimers();
    const post = vi
      .fn()
      .mockResolvedValue({ uri: "at://did:plc:x/.../reply", cid: "cid-2" });

    const result = await runWithTimers(
      postBskyFirstComment(agentWithPost(post), PARENT, "More context"),
    );

    expect(result).toEqual({ id: "at://did:plc:x/.../reply" });
    // Self-reply: root === parent === the just-created post.
    const arg = post.mock.calls[0][0] as {
      reply: { root: typeof PARENT; parent: typeof PARENT };
    };
    expect(arg.reply.root).toEqual(PARENT);
    expect(arg.reply.parent).toEqual(PARENT);
  });

  it("returns { error } (NOT a clean success) when the reply throws", async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockRejectedValue(new Error("atproto boom"));

    const result = await runWithTimers(
      postBskyFirstComment(agentWithPost(post), PARENT, "hi"),
    );

    expect(result.error).toContain("atproto boom");
    expect(result.id).toBeUndefined();
  });

  it("is a no-op (no API call) when firstComment is blank", async () => {
    const post = vi.fn();

    expect(
      await postBskyFirstComment(agentWithPost(post), PARENT, " "),
    ).toEqual({});
    expect(
      await postBskyFirstComment(agentWithPost(post), PARENT, undefined),
    ).toEqual({});
    expect(post).not.toHaveBeenCalled();
  });

  it("caps the reply at 300 graphemes", async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockResolvedValue({ uri: "at://r", cid: "c" });

    await runWithTimers(
      postBskyFirstComment(agentWithPost(post), PARENT, "y".repeat(400)),
    );

    const sentText = (post.mock.calls[0][0] as { text: string }).text;
    expect([...sentText]).toHaveLength(300);
  });
});
