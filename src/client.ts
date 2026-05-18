/**
 * Bluesky AT Protocol client factory with session caching.
 *
 * Sessions are cached per handle to avoid hitting the createSession
 * rate limit (30/5min, 300/day). Cached sessions are reused for 90 minutes
 * (Bluesky sessions last ~2 hours).
 */

import { createHash } from "node:crypto";
import { AtpAgent } from "@atproto/api";
import { waitForRateLimit, withRetry } from "./rate-limiter.js";

const SESSION_TTL_MS = 90 * 60 * 1000; // 90 minutes

interface CachedSession {
  agent: AtpAgent;
  readonly createdAt: number;
}

const sessionCache = new Map<string, CachedSession>();

/** Cache key includes a password hash so rotated credentials don't reuse stale sessions. */
function cacheKey(handle: string, appPassword: string): string {
  const hash = createHash("sha256")
    .update(appPassword)
    .digest("hex")
    .slice(0, 8);
  return `${handle}:${hash}`;
}

/**
 * Get or create an authenticated agent. Reuses cached sessions when possible.
 * Waits for rate limit to clear (up to 60s) before creating a new session.
 * Retries on HTTP 429 with exponential backoff.
 */
export async function createAgent(
  handle: string,
  appPassword: string,
): Promise<AtpAgent> {
  const key = cacheKey(handle, appPassword);
  const cached = sessionCache.get(key);
  if (cached && Date.now() - cached.createdAt < SESSION_TTL_MS) {
    return cached.agent;
  }

  // Wait for session creation rate limit (up to 60s)
  const limit = await waitForRateLimit("session");
  if (!limit.allowed) {
    throw new Error(
      `Session rate limited. Retry after ${Math.ceil(limit.retryAfterMs / 1000)}s. ` +
        `Bluesky allows 30 logins per 5 minutes.`,
    );
  }

  // Login with retry on 429
  const agent = await withRetry(async () => {
    const a = new AtpAgent({ service: "https://bsky.social" });
    await a.login({ identifier: handle, password: appPassword });
    return a;
  });

  // Evict stale sessions before inserting
  const now = Date.now();
  for (const [key, val] of sessionCache) {
    if (now - val.createdAt >= SESSION_TTL_MS) sessionCache.delete(key);
  }

  sessionCache.set(key, { agent, createdAt: now });
  return agent;
}
