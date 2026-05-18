import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, withRetry, WRITE_TOOL_NAMES } from "./rate-limiter.js";

describe("checkRateLimit", () => {
  it("allows read requests under the global limit", () => {
    const result = checkRateLimit("read");
    expect(result.allowed).toBe(true);
  });

  it("allows write requests and consumes write bucket tokens", () => {
    const result = checkRateLimit("write", "bsky_create_post");
    expect(result.allowed).toBe(true);
  });

  it("allows session requests", () => {
    const result = checkRateLimit("session");
    expect(result.allowed).toBe(true);
  });
});

describe("WRITE_TOOL_NAMES", () => {
  it("contains all expected write tools", () => {
    expect(WRITE_TOOL_NAMES.has("bsky_create_post")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("bsky_reply")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("bsky_like")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("bsky_repost")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("bsky_follow")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("bsky_delete_post")).toBe(true);
  });

  it("does not contain read tools", () => {
    expect(WRITE_TOOL_NAMES.has("bsky_get_timeline")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("bsky_search_posts")).toBe(false);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("throws non-429 errors immediately", async () => {
    await expect(
      withRetry(() => Promise.reject(new Error("Bad Request"))),
    ).rejects.toThrow("Bad Request");
  });

  it("retries on 429 status errors", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        return Promise.reject(err);
      }
      return Promise.resolve("success");
    };

    const promise = withRetry(fn);
    // Advance past the 2s backoff
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    expect(result).toBe("success");
    expect(attempt).toBe(2);
  });
});
