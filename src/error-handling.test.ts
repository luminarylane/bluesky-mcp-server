import { describe, it, expect } from "vitest";
import { extractXrpcDetail, suggestAction } from "./index.js";

describe("extractXrpcDetail", () => {
  it("extracts error + message from XRPC-shaped errors", () => {
    const err = { error: "InvalidRequest", message: "Post too long" };
    expect(extractXrpcDetail(err)).toBe("InvalidRequest: Post too long");
  });

  it("returns just error when message is absent", () => {
    const err = { error: "AuthenticationRequired", status: 401 };
    expect(extractXrpcDetail(err)).toBe("AuthenticationRequired");
  });

  it("returns just error when message is empty string", () => {
    const err = { error: "NotFound", message: "" };
    expect(extractXrpcDetail(err)).toBe("NotFound");
  });

  it("returns undefined for non-XRPC errors", () => {
    expect(extractXrpcDetail(new Error("generic"))).toBeUndefined();
  });

  it("returns undefined for null/undefined", () => {
    expect(extractXrpcDetail(null)).toBeUndefined();
    expect(extractXrpcDetail(undefined)).toBeUndefined();
  });

  it("returns undefined when error field is not a string", () => {
    expect(extractXrpcDetail({ error: 42, message: "bad" })).toBeUndefined();
  });
});

describe("suggestAction", () => {
  describe("401 errors", () => {
    it("returns AUTH_FAILED", () => {
      const action = suggestAction(
        "bsky_create_post",
        401,
        "AuthenticationRequired: bad token",
      );
      expect(action).toContain("AUTH_FAILED");
      expect(action).toContain("App Passwords");
    });
  });

  describe("400 errors", () => {
    it("detects post too long", () => {
      const action = suggestAction(
        "bsky_create_post",
        400,
        "InvalidRequest: Post too long",
      );
      expect(action).toContain("POST_TOO_LONG");
    });

    it("detects text too long variant", () => {
      const action = suggestAction(
        "bsky_create_post",
        400,
        "InvalidRequest: text too long",
      );
      expect(action).toContain("POST_TOO_LONG");
    });

    it("detects invalid URI", () => {
      const action = suggestAction(
        "bsky_reply",
        400,
        "InvalidRequest: invalid uri format",
      );
      expect(action).toContain("INVALID_URI");
    });

    it("detects invalid DID", () => {
      const action = suggestAction(
        "bsky_follow",
        400,
        "InvalidRequest: invalid did",
      );
      expect(action).toContain("INVALID_DID");
    });

    it("detects duplicate post", () => {
      const action = suggestAction(
        "bsky_create_post",
        400,
        "InvalidRequest: duplicate record",
      );
      expect(action).toContain("DUPLICATE_POST");
    });

    it("falls back to INVALID_REQUEST", () => {
      const action = suggestAction(
        "bsky_create_post",
        400,
        "InvalidRequest: something else",
      );
      expect(action).toContain("INVALID_REQUEST");
    });
  });

  describe("403 errors", () => {
    it("detects blocked", () => {
      expect(
        suggestAction("bsky_reply", 403, "Forbidden: blocked by user"),
      ).toContain("BLOCKED");
    });

    it("detects suspended", () => {
      expect(
        suggestAction("bsky_reply", 403, "Forbidden: account suspended"),
      ).toContain("ACCOUNT_SUSPENDED");
    });

    it("detects deactivated", () => {
      expect(
        suggestAction(
          "bsky_get_profile",
          403,
          "Forbidden: account deactivated",
        ),
      ).toContain("ACCOUNT_DEACTIVATED");
    });

    it("detects detached thread", () => {
      expect(
        suggestAction("bsky_reply", 403, "Forbidden: thread detached"),
      ).toContain("THREAD_DETACHED");
    });

    it("detects muted thread", () => {
      expect(
        suggestAction("bsky_reply", 403, "Forbidden: thread muted"),
      ).toContain("THREAD_MUTED");
    });

    it("falls back to FORBIDDEN", () => {
      expect(
        suggestAction("bsky_reply", 403, "Forbidden: something unknown"),
      ).toContain("FORBIDDEN");
    });
  });

  describe("404 errors", () => {
    it("returns POST_NOT_FOUND for post-related tools", () => {
      expect(suggestAction("bsky_like", 404, "NotFound")).toContain(
        "POST_NOT_FOUND",
      );
      expect(suggestAction("bsky_reply", 404, "NotFound")).toContain(
        "POST_NOT_FOUND",
      );
      expect(suggestAction("bsky_repost", 404, "NotFound")).toContain(
        "POST_NOT_FOUND",
      );
    });

    it("returns USER_NOT_FOUND for user-related tools", () => {
      expect(suggestAction("bsky_get_profile", 404, "NotFound")).toContain(
        "USER_NOT_FOUND",
      );
      expect(suggestAction("bsky_follow", 404, "NotFound")).toContain(
        "USER_NOT_FOUND",
      );
      expect(suggestAction("bsky_search_users", 404, "NotFound")).toContain(
        "USER_NOT_FOUND",
      );
    });

    it("returns generic NOT_FOUND for other tools", () => {
      expect(suggestAction("bsky_get_feed", 404, "NotFound")).toContain(
        "NOT_FOUND",
      );
    });
  });

  describe("429 errors", () => {
    it("returns RATE_LIMITED", () => {
      const action = suggestAction(
        "bsky_create_post",
        429,
        "RateLimitExceeded",
      );
      expect(action).toContain("RATE_LIMITED");
      expect(action).toContain("Wait 60s");
    });
  });

  describe("5xx errors", () => {
    it("detects upstream failure on 502", () => {
      const action = suggestAction(
        "bsky_create_post",
        502,
        "UpstreamFailure: relay down",
      );
      expect(action).toContain("UPSTREAM_FAILURE");
    });

    it("returns SERVER_ERROR for generic 502", () => {
      expect(suggestAction("bsky_create_post", 502, "BadGateway")).toContain(
        "SERVER_ERROR",
      );
    });

    it("returns SERVER_ERROR for 500", () => {
      expect(
        suggestAction("bsky_create_post", 500, "InternalServerError"),
      ).toContain("SERVER_ERROR");
    });

    it("returns SERVER_ERROR for 503", () => {
      expect(
        suggestAction("bsky_create_post", 503, "ServiceUnavailable"),
      ).toContain("SERVER_ERROR");
    });
  });

  describe("network errors (no status code)", () => {
    it("detects DNS failure", () => {
      expect(
        suggestAction(
          "bsky_create_post",
          undefined,
          undefined,
          "getaddrinfo ENOTFOUND bsky.social",
        ),
      ).toContain("DNS_FAILURE");
    });

    it("detects timeout", () => {
      expect(
        suggestAction(
          "bsky_create_post",
          undefined,
          undefined,
          "The operation was aborted due to timeout",
        ),
      ).toContain("TIMEOUT");
    });

    it("detects connection refused", () => {
      expect(
        suggestAction(
          "bsky_create_post",
          undefined,
          undefined,
          "connect ECONNREFUSED 127.0.0.1:443",
        ),
      ).toContain("CONNECTION_FAILED");
    });

    it("detects fetch failed", () => {
      expect(
        suggestAction("bsky_create_post", undefined, undefined, "fetch failed"),
      ).toContain("NETWORK_ERROR");
    });

    it("returns undefined for unknown errors without status code", () => {
      expect(
        suggestAction(
          "bsky_create_post",
          undefined,
          undefined,
          "something weird",
        ),
      ).toBeUndefined();
    });
  });

  describe("unknown status codes", () => {
    it("returns undefined for unhandled codes", () => {
      expect(
        suggestAction("bsky_create_post", 418, "I'm a teapot"),
      ).toBeUndefined();
    });
  });
});
