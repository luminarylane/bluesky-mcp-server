/**
 * Token-bucket rate limiter for Bluesky API.
 *
 * Bluesky limits:
 *   - Global: 3,000 requests per 5 minutes (per IP)
 *   - createSession: 30 per 5 minutes, 300 per day (per account)
 *   - Writes: 5,000 points/hour (create=3, update=2, delete=1)
 *
 * This is a simple in-memory implementation — no external dependencies.
 */

interface BucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per millisecond
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(config: BucketConfig) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  msUntilAvailable(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil(deficit / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const globalBucket = new TokenBucket({
  maxTokens: 3000,
  refillRate: 3000 / FIVE_MINUTES_MS,
});
const sessionBucket = new TokenBucket({
  maxTokens: 30,
  refillRate: 30 / FIVE_MINUTES_MS,
});
const sessionDailyBucket = new TokenBucket({
  maxTokens: 300,
  refillRate: 300 / ONE_DAY_MS,
});
const writeBucket = new TokenBucket({
  maxTokens: 5000,
  refillRate: 5000 / ONE_HOUR_MS,
});

export type RateLimitCategory = "read" | "write" | "session";

// Point costs for write operations (per Bluesky docs)
const WRITE_COSTS: Record<string, number> = {
  bsky_create_post: 3,
  bsky_reply: 3,
  bsky_like: 3,
  bsky_repost: 3,
  bsky_follow: 3,
  bsky_delete_post: 1,
};

/** Set of tool names classified as write operations. Derived from WRITE_COSTS. */
export const WRITE_TOOL_NAMES = new Set(Object.keys(WRITE_COSTS));

const MAX_WAIT_MS = 60_000;
const MAX_429_RETRIES = 3;

/**
 * Check if a request is allowed under rate limits.
 * Uses peek-then-consume: checks all required buckets first, only consumes
 * tokens when all buckets have capacity. Prevents token waste on partial failures.
 */
export function checkRateLimit(
  category: RateLimitCategory,
  toolName?: string,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  // Peek phase — no tokens consumed
  const globalWait = globalBucket.msUntilAvailable();
  if (globalWait > 0) {
    return { allowed: false, retryAfterMs: globalWait };
  }

  if (category === "session") {
    const sessionWait = Math.max(
      sessionBucket.msUntilAvailable(),
      sessionDailyBucket.msUntilAvailable(),
    );
    if (sessionWait > 0) return { allowed: false, retryAfterMs: sessionWait };
  }

  if (category === "write" && toolName) {
    const cost = WRITE_COSTS[toolName] ?? 3;
    const writeWait = writeBucket.msUntilAvailable(cost);
    if (writeWait > 0) return { allowed: false, retryAfterMs: writeWait };
  }

  // Consume phase — all buckets have capacity
  globalBucket.tryConsume();
  if (category === "session") {
    sessionBucket.tryConsume();
    sessionDailyBucket.tryConsume();
  }
  if (category === "write" && toolName) {
    writeBucket.tryConsume(WRITE_COSTS[toolName] ?? 3);
  }

  return { allowed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for rate limit to clear (up to 60s), then consume the token.
 * Returns { allowed: false, retryAfterMs } if the wait would exceed MAX_WAIT_MS.
 */
export async function waitForRateLimit(
  category: RateLimitCategory,
  toolName?: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const result = checkRateLimit(category, toolName);
  if (result.allowed) return result;

  if (result.retryAfterMs > MAX_WAIT_MS) {
    return result;
  }

  console.error(
    `[rate-limit] Waiting ${Math.ceil(result.retryAfterMs / 1000)}s for ${category} bucket...`,
  );
  await sleep(result.retryAfterMs);
  return checkRateLimit(category, toolName);
}

/**
 * Execute an API call with automatic retry on HTTP 429 from Bluesky.
 * Checks XRPCError.status first, falls back to string matching.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const is429 =
        (typeof e === "object" &&
          e !== null &&
          "status" in e &&
          (e as { status: number }).status === 429) ||
        (e instanceof Error &&
          (e.message.includes("429") ||
            e.message.toLowerCase().includes("rate limit")));

      if (!is429 || attempt === MAX_429_RETRIES) throw e;

      const backoffMs = 2000 * Math.pow(2, attempt);
      console.error(
        `[rate-limit] Bluesky 429 — backing off ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_429_RETRIES})...`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Unreachable");
}
