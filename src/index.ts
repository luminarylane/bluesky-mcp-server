#!/usr/bin/env node
/**
 * Standalone Bluesky MCP Server
 *
 * Pure AT Protocol wrapper over stdio. No database, no auth layer.
 * Credentials (handle + appPassword) are passed directly per tool call.
 *
 * Usage:
 *   BLUESKY_HANDLE=user.bsky.social BLUESKY_APP_PASSWORD=xxxx npx bluesky-mcp-server
 *
 * Or pass handle/appPassword as tool arguments for multi-account use.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AppBskyEmbedVideo,
  AppBskyVideoDefs,
  BlobRef,
  RichText,
} from "@atproto/api";
import { z } from "zod";
import { createAgent } from "./client.js";
import { textResult, errorResult, senseResult } from "./response.js";
import {
  waitForRateLimit,
  withRetry,
  WRITE_TOOL_NAMES,
} from "./rate-limiter.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Env-based defaults (can be overridden per tool call)
const DEFAULT_HANDLE = process.env.BLUESKY_HANDLE;
const DEFAULT_APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD;

/**
 * Resolve credentials: tool args override env vars.
 */
function resolveCredentials(args: { handle?: string; appPassword?: string }) {
  const handle = args.handle || DEFAULT_HANDLE;
  const appPassword = args.appPassword || DEFAULT_APP_PASSWORD;
  if (!handle || !appPassword) {
    return null;
  }
  return { handle, appPassword };
}

/**
 * Get an authenticated agent, returning an error response if credentials are missing.
 * Uses discriminated union with `ok` flag for clean TypeScript narrowing.
 * Checks global rate limit before making any API call.
 */
type AgentResult =
  | { ok: true; agent: Awaited<ReturnType<typeof createAgent>> }
  | { ok: false; error: ReturnType<typeof errorResult> };

async function getAgent(
  args: { handle?: string; appPassword?: string },
  toolName?: string,
): Promise<AgentResult> {
  // Validate credentials before consuming rate limit tokens
  const creds = resolveCredentials(args);
  if (!creds) {
    return {
      ok: false,
      error: errorResult(
        "Missing credentials",
        "Provide handle + appPassword as arguments, or set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD env vars.",
      ),
    };
  }

  // Check rate limit — waits up to 60s if bucket is near-empty
  const category =
    toolName && WRITE_TOOL_NAMES.has(toolName)
      ? ("write" as const)
      : ("read" as const);

  const limit = await waitForRateLimit(category, toolName);
  if (!limit.allowed) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
    return {
      ok: false,
      error: errorResult(
        "Rate limited",
        `Bluesky API rate limit reached (${category} bucket). Wait ${retryAfterSeconds}s then retry this exact tool call with the same arguments.`,
        {
          retryAfterSeconds,
          action:
            retryAfterSeconds <= 120
              ? `RETRY_AFTER_WAIT: Sleep ${retryAfterSeconds}s then retry this tool call.`
              : `DEFER: Rate limit cooldown is ${retryAfterSeconds}s. Queue this operation for later or switch to a different task.`,
        },
      ),
    };
  }

  try {
    const agent = await createAgent(creds.handle, creds.appPassword);
    return { ok: true, agent };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return {
      ok: false,
      error: errorResult("Auth failed", `Bluesky login failed: ${msg}`),
    };
  }
}

/**
 * Wrap a tool handler with try/catch so unhandled API errors
 * (network failures, unexpected response shapes) return structured
 * errorResult instead of crashing the server.
 */
function safeHandler<T>(
  toolName: string,
  handler: (
    args: T,
  ) => Promise<ReturnType<typeof textResult | typeof senseResult>>,
): (
  args: T,
) => Promise<
  ReturnType<typeof textResult | typeof senseResult | typeof errorResult>
> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (e) {
      try {
        const msg = e instanceof Error ? e.message : String(e);
        const detail = extractXrpcDetail(e);
        const statusCode =
          typeof e === "object" && e !== null && "status" in e
            ? (e as { status: number }).status
            : undefined;
        const action = suggestAction(toolName, statusCode, detail, msg);
        console.error(
          `[${toolName}] Error: ${msg}${detail ? ` — ${detail}` : ""}`,
        );
        return errorResult(
          "API error",
          `${toolName} failed: ${detail || msg}`,
          {
            ...(statusCode !== undefined && { statusCode }),
            ...(detail && detail !== msg && { rawError: msg }),
            ...(action && { action }),
          },
        );
      } catch {
        const fallback = e instanceof Error ? e.message : "Unknown error";
        console.error(`[${toolName}] Error (fallback): ${fallback}`);
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "API error",
                message: `${toolName} failed: ${fallback}`,
              }),
            },
          ],
        };
      }
    }
  };
}

export function extractXrpcDetail(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const err = e as Record<string, unknown>;
  if (typeof err.error === "string") {
    return typeof err.message === "string" && err.message
      ? `${err.error}: ${err.message}`
      : err.error;
  }
  return undefined;
}

export function suggestAction(
  toolName: string,
  statusCode: number | undefined,
  detail: string | undefined,
  errorMsg?: string,
): string | undefined {
  const d = (detail || errorMsg || "").toLowerCase();

  // Network-level errors (no HTTP status code)
  if (statusCode === undefined) {
    if (d.includes("enotfound") || d.includes("dns"))
      return "DNS_FAILURE: Cannot resolve bsky.social. Check your internet connection.";
    if (d.includes("timeout") || d.includes("abort"))
      return "TIMEOUT: Request to Bluesky timed out. Check your connection and retry.";
    if (d.includes("econnrefused") || d.includes("econnreset"))
      return "CONNECTION_FAILED: Cannot connect to Bluesky. The service may be down. Retry in 30s.";
    if (d.includes("fetch failed"))
      return "NETWORK_ERROR: Network request failed. Check your internet connection and retry.";
    return undefined;
  }

  switch (statusCode) {
    case 401:
      return "AUTH_FAILED: App password is invalid or expired. Generate a new one at bsky.app > Settings > App Passwords, then update BLUESKY_APP_PASSWORD env var.";

    case 400:
      if (d.includes("post too long") || d.includes("text too long"))
        return "POST_TOO_LONG: Text exceeds 300 graphemes. Shorten the text and retry.";
      if (d.includes("invalid") && d.includes("uri"))
        return "INVALID_URI: AT URI format is wrong. Expected at://did:plc:xxx/app.bsky.feed.post/xxx. Use bsky_search_users to find the correct DID.";
      if (d.includes("invalid") && d.includes("did"))
        return "INVALID_DID: DID format is wrong. Use bsky_search_users to find the correct DID.";
      if (d.includes("duplicate"))
        return "DUPLICATE_POST: Bluesky rejected this as a duplicate. Change the text to make it unique before retrying.";
      return "INVALID_REQUEST: Check the error message and fix the input parameters.";

    case 403:
      if (d.includes("blocked"))
        return "BLOCKED: You are blocked by this user. Skip this interaction and move on.";
      if (d.includes("suspended"))
        return "ACCOUNT_SUSPENDED: This account is suspended. Skip this user.";
      if (d.includes("deactivated"))
        return "ACCOUNT_DEACTIVATED: This user's account is deactivated. Skip them.";
      if (d.includes("detached"))
        return "THREAD_DETACHED: This thread has been detached. Use bsky_create_post for a standalone post instead.";
      if (d.includes("muted"))
        return "THREAD_MUTED: This thread is muted. Skip it.";
      return "FORBIDDEN: Bluesky rejected this action. Check the error message for details.";

    case 404: {
      const t = toolName.toLowerCase();
      if (/post|reply|like|repost/.test(t))
        return "POST_NOT_FOUND: This post may have been deleted. Skip it and move on.";
      if (/profile|user|follow/.test(t))
        return "USER_NOT_FOUND: This user does not exist or has been deactivated. Verify the handle and skip if invalid.";
      return "NOT_FOUND: The requested resource does not exist. It may have been deleted.";
    }

    case 429:
      return "RATE_LIMITED: Bluesky rate limit hit after automatic retries. Wait 60s and retry, or switch to a different task and come back later.";

    case 502:
      if (d.includes("upstreamfailure"))
        return "UPSTREAM_FAILURE: Bluesky's backend relay is temporarily down. Wait 60s and retry.";
      return "SERVER_ERROR: Bluesky is having issues. Wait 30s and retry once.";

    case 500:
    case 503:
      return "SERVER_ERROR: Bluesky is having issues. Wait 30s and retry once.";

    default:
      return undefined;
  }
}

// --- OG Tag Helpers for Link Previews ---

const BLUESKY_BLOB_MAX_BYTES = 1_000_000;

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface OgTags {
  title?: string;
  description?: string;
  imageUrl?: string;
}

async function fetchOgTags(url: string): Promise<OgTags> {
  if (!isAllowedUrl(url)) {
    console.error(
      `[fetchOgTags] URL rejected (not http/https or malformed): ${url}`,
    );
    return {};
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Bluesky-MCP-Server/1.0 (link-preview)" },
    });
    if (!res.ok) {
      console.error(`[fetchOgTags] HTTP ${res.status} fetching ${url}`);
      return {};
    }
    // Read approximately the first 50K characters to avoid downloading huge pages
    const reader = res.body?.getReader();
    if (!reader) return {};
    let html = "";
    const decoder = new TextDecoder();
    while (html.length < 50_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode(); // flush remaining bytes from incomplete multibyte sequences
    reader.cancel().catch((e) => {
      console.error(
        `[fetchOgTags] Stream cancel failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

    const extract = (property: string): string | undefined => {
      // Handle both attribute orders:
      //   <meta property="og:title" content="...">
      //   <meta content="..." property="og:title">
      const pattern1 = new RegExp(
        `<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`,
        "i",
      );
      const pattern2 = new RegExp(
        `<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`,
        "i",
      );
      return pattern1.exec(html)?.[1] || pattern2.exec(html)?.[1];
    };

    let imageUrl = extract("og:image");
    // Resolve relative image URLs against the page URL
    if (imageUrl && !imageUrl.startsWith("http")) {
      try {
        imageUrl = new URL(imageUrl, url).href;
      } catch {
        imageUrl = undefined;
      }
    }
    // Validate resolved image URL scheme (prevent SSRF via malicious og:image)
    if (imageUrl && !isAllowedUrl(imageUrl)) {
      imageUrl = undefined;
    }

    return {
      title: extract("og:title"),
      description: extract("og:description"),
      imageUrl,
    };
  } catch (e) {
    console.error(
      `[fetchOgTags] Failed for ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}

async function fetchAndUploadThumb(
  imageUrl: string,
  agent: Awaited<ReturnType<typeof createAgent>>,
): Promise<unknown> {
  if (!isAllowedUrl(imageUrl)) {
    console.error(
      `[fetchAndUploadThumb] URL rejected (not http/https or malformed): ${imageUrl}`,
    );
    return undefined;
  }
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(
        `[fetchAndUploadThumb] HTTP ${res.status} fetching ${imageUrl}`,
      );
      return undefined;
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > BLUESKY_BLOB_MAX_BYTES) {
      console.error(
        `[fetchAndUploadThumb] Image too large (${contentLength} bytes, max ${BLUESKY_BLOB_MAX_BYTES}): ${imageUrl}`,
      );
      return undefined;
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > BLUESKY_BLOB_MAX_BYTES) {
      console.error(
        `[fetchAndUploadThumb] Image too large after download (${buffer.byteLength} bytes, max ${BLUESKY_BLOB_MAX_BYTES}): ${imageUrl}`,
      );
      return undefined;
    }

    const data = new Uint8Array(buffer);
    const encoding = res.headers.get("content-type") || "image/jpeg";
    const uploadRes = await agent.uploadBlob(data, { encoding });
    return uploadRes.data.blob;
  } catch (e) {
    console.error(
      `[fetchAndUploadThumb] Failed for ${imageUrl}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

const PRIVATE_IP_RE = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

function isAllowedMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "169.254.169.254" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return false;
    }
    // Block IPv6 private ranges (fc00::/7, fe80::/10, IPv4-mapped ::ffff:)
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (
      bare.startsWith("fc") ||
      bare.startsWith("fd") ||
      bare.startsWith("fe80") ||
      bare.startsWith("::ffff:")
    ) {
      return false;
    }
    // Block RFC1918 and link-local IPv4 ranges
    const ipMatch = hostname.match(PRIVATE_IP_RE);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[isAllowedMediaUrl] Failed to parse URL: ${url} — ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

const BLUESKY_VIDEO_MAX_BYTES = 50 * 1024 * 1024; // 50MB

interface DownloadedMedia {
  buffer: ArrayBuffer;
  mimeType: string;
}

async function downloadMedia(
  url: string,
  opts: {
    maxBytes: number;
    allowedMimeTypes: ReadonlySet<string>;
    timeoutMs: number;
    label: string;
  },
): Promise<DownloadedMedia> {
  if (!isAllowedMediaUrl(url)) {
    throw new Error(`URL rejected (not https:// or blocked address): ${url}`);
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${opts.label}: ${url}`);
  }

  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "";
  if (!mimeType) {
    throw new Error(
      `Server returned no Content-Type header for ${opts.label}: ${url}`,
    );
  }
  if (!opts.allowedMimeTypes.has(mimeType)) {
    throw new Error(
      `Unsupported ${opts.label} type "${mimeType}". Bluesky accepts: ${[...opts.allowedMimeTypes].join(", ")}`,
    );
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > opts.maxBytes) {
    throw new Error(
      `${opts.label} too large (${contentLength} bytes, max ${opts.maxBytes}): ${url}`,
    );
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > opts.maxBytes) {
    throw new Error(
      `${opts.label} too large after download (${buffer.byteLength} bytes, max ${opts.maxBytes}): ${url}`,
    );
  }

  return { buffer, mimeType };
}

async function downloadAndUploadImage(
  imageUrl: string,
  agent: Awaited<ReturnType<typeof createAgent>>,
): Promise<{ blob: BlobRef; mimeType: string }> {
  const { buffer, mimeType } = await downloadMedia(imageUrl, {
    maxBytes: BLUESKY_BLOB_MAX_BYTES,
    allowedMimeTypes: ALLOWED_IMAGE_MIME_TYPES,
    timeoutMs: 15_000,
    label: "image",
  });

  const data = new Uint8Array(buffer);
  const uploadRes = await agent.uploadBlob(data, { encoding: mimeType });
  return { blob: uploadRes.data.blob, mimeType };
}

async function downloadAndUploadVideo(
  videoUrl: string,
  agent: Awaited<ReturnType<typeof createAgent>>,
): Promise<BlobRef> {
  const ALLOWED_VIDEO_MIME_TYPES = new Set(["video/mp4"]);
  const { buffer } = await downloadMedia(videoUrl, {
    maxBytes: BLUESKY_VIDEO_MAX_BYTES,
    allowedMimeTypes: ALLOWED_VIDEO_MIME_TYPES,
    timeoutMs: 60_000,
    label: "video",
  });

  // Get service auth token for the video upload endpoint
  const did = agent.session?.did;
  if (!did) {
    throw new Error("Agent session has no DID — cannot upload video");
  }
  if (!agent.dispatchUrl?.host) {
    throw new Error(
      "Agent has no dispatchUrl configured — cannot request service auth for video upload",
    );
  }

  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${agent.dispatchUrl.host}`,
    lxm: "com.atproto.repo.uploadBlob",
    exp: Math.floor(Date.now() / 1000) + 60 * 30,
  });

  // Upload video to Bluesky's video processing service
  const uploadRes = await fetch(
    `https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(did)}&name=video.mp4`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceAuth.token}`,
        "Content-Type": "video/mp4",
        "Content-Length": String(buffer.byteLength),
      },
      body: new Uint8Array(buffer),
    },
  );

  // 409 = "already_exists" — video was already uploaded/processed, parse the
  // response body to get the jobId and proceed to polling for the blob.
  if (!uploadRes.ok && uploadRes.status !== 409) {
    const errText = await uploadRes.text().catch((textErr) => {
      console.error(
        `[downloadAndUploadVideo] Failed to read error body: ${textErr instanceof Error ? textErr.message : String(textErr)}`,
      );
      return "(could not read response body)";
    });
    throw new Error(
      `Video upload failed (HTTP ${uploadRes.status}): ${errText}`,
    );
  }

  const uploadData = (await uploadRes.json()) as AppBskyVideoDefs.JobStatus;
  if (!uploadData.jobId) {
    throw new Error(
      `Video upload returned no jobId. Response: ${JSON.stringify(uploadData).slice(0, 500)}`,
    );
  }
  const jobId = uploadData.jobId;

  // Poll for processing completion
  const pollStart = Date.now();
  const POLL_TIMEOUT_MS = 120_000;
  const POLL_INTERVAL_MS = 1_000;
  const MAX_POLL_ERRORS = 3;
  let consecutiveErrors = 0;

  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let job: AppBskyVideoDefs.JobStatus;
    try {
      // Poll the video service directly (not the PDS — it doesn't support this XRPC)
      const statusUrl = `https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(jobId)}`;
      const statusRes = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${serviceAuth.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!statusRes.ok) {
        throw new Error(`HTTP ${statusRes.status} from video status endpoint`);
      }
      const statusData = (await statusRes.json()) as {
        jobStatus: AppBskyVideoDefs.JobStatus;
      };
      job = statusData.jobStatus;
      consecutiveErrors = 0;
    } catch (pollErr) {
      consecutiveErrors++;
      console.error(
        `[downloadAndUploadVideo] Poll error ${consecutiveErrors}/${MAX_POLL_ERRORS} for jobId ${jobId}: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`,
      );
      if (consecutiveErrors >= MAX_POLL_ERRORS) {
        throw new Error(
          `Video processing status check failed ${MAX_POLL_ERRORS} times consecutively (jobId: ${jobId})`,
        );
      }
      continue;
    }

    if (job.blob) {
      return job.blob;
    }
    if (
      job.state === "JOB_STATE_FAILED" ||
      job.state === "JOB_STATE_COMPLETED"
    ) {
      // COMPLETED without a blob means something went wrong server-side
      throw new Error(
        `Video processing failed (state: ${job.state}): ${job.error || "no blob returned"}`,
      );
    }
  }

  throw new Error(
    `Video processing timed out after ${POLL_TIMEOUT_MS / 1000}s (jobId: ${jobId})`,
  );
}

interface LinkEmbedResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  embed: any;
  status: {
    ogTags: boolean;
    thumbnail: boolean;
    details?: string;
  };
}

/**
 * Build a link preview embed for Bluesky posts.
 * Returns undefined only if linkUrl is not provided.
 * On fetch errors, returns a minimal embed using the URL as the title.
 * Includes status so the calling agent knows what succeeded/failed.
 */
async function buildLinkEmbed(
  linkUrl: string | undefined,
  agent: Awaited<ReturnType<typeof createAgent>>,
): Promise<LinkEmbedResult | undefined> {
  if (!linkUrl) return undefined;
  const og = await fetchOgTags(linkUrl);
  const hasOgTags = !!(og.title || og.description);
  let thumb: unknown;
  let hasThumbnail = false;
  if (og.imageUrl) {
    thumb = await fetchAndUploadThumb(og.imageUrl, agent);
    hasThumbnail = !!thumb;
  }

  const details: string[] = [];
  if (!hasOgTags)
    details.push("no OG tags found — card will show raw URL as title");
  if (og.imageUrl && !hasThumbnail)
    details.push(
      "og:image found but thumbnail upload failed — card will have no image",
    );
  if (!og.imageUrl)
    details.push("no og:image found — card will have no thumbnail");

  return {
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: linkUrl,
        title: og.title || linkUrl,
        description: og.description || "",
        ...(thumb ? { thumb } : {}),
      },
    },
    status: {
      ogTags: hasOgTags,
      thumbnail: hasThumbnail,
      ...(details.length > 0 && { details: details.join("; ") }),
    },
  };
}

// --- Tool Definitions (Zod schemas for MCP SDK) ---

const credentialFields = {
  handle: z
    .string()
    .optional()
    .describe(
      'Bluesky handle (e.g., "user.bsky.social"). Falls back to BLUESKY_HANDLE env var.',
    ),
  appPassword: z
    .string()
    .optional()
    .describe(
      "Bluesky App Password. Falls back to BLUESKY_APP_PASSWORD env var.",
    ),
};

// --- Server Setup ---

const server = new McpServer({
  name: "bluesky-mcp-server",
  version,
});

// =====================
// SENSE Tools (read)
// =====================

server.registerTool(
  "bsky_get_timeline",
  {
    description:
      "Get the Bluesky home timeline. Returns recent posts from followed accounts.",
    inputSchema: {
      ...credentialFields,
      limit: z
        .number()
        .optional()
        .describe("Number of posts (default: 20, max: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
  },
  safeHandler("bsky_get_timeline", async (args) => {
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.getTimeline({
        limit: Math.min(args.limit || 20, 50),
        cursor: args.cursor,
      }),
    );

    const posts = response.data.feed.map((item) => ({
      uri: item.post.uri,
      cid: item.post.cid,
      author: {
        handle: item.post.author.handle,
        displayName: item.post.author.displayName,
      },
      text: (item.post.record as { text?: string }).text,
      likeCount: item.post.likeCount,
      repostCount: item.post.repostCount,
      replyCount: item.post.replyCount,
      indexedAt: item.post.indexedAt,
    }));

    return senseResult(
      {
        posts,
        cursor: response.data.cursor,
        count: posts.length,
      },
      "Bluesky",
    );
  }),
);

server.registerTool(
  "bsky_get_notifications",
  {
    description:
      "Get Bluesky notifications (likes, reposts, follows, mentions, replies).",
    inputSchema: {
      ...credentialFields,
      limit: z
        .number()
        .optional()
        .describe("Number of notifications (default: 20, max: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
  },
  safeHandler("bsky_get_notifications", async (args) => {
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.listNotifications({
        limit: Math.min(args.limit || 20, 50),
        cursor: args.cursor,
      }),
    );

    const notifications = response.data.notifications.map((n) => ({
      uri: n.uri,
      cid: n.cid,
      reason: n.reason,
      author: { handle: n.author.handle, displayName: n.author.displayName },
      isRead: n.isRead,
      indexedAt: n.indexedAt,
    }));

    return senseResult(
      {
        notifications,
        cursor: response.data.cursor,
        count: notifications.length,
      },
      "Bluesky",
    );
  }),
);

server.registerTool(
  "bsky_search_posts",
  {
    description:
      "Search Bluesky posts by keyword or phrase. Useful for brand monitoring and trend discovery.",
    inputSchema: {
      ...credentialFields,
      query: z
        .string()
        .describe("Search query (keywords, phrases, hashtags, or from:handle)"),
      limit: z
        .number()
        .optional()
        .describe("Number of results (default: 20, max: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
      sort: z
        .enum(["top", "latest"])
        .optional()
        .describe('Sort order (default: "latest")'),
    },
  },
  safeHandler("bsky_search_posts", async (args) => {
    if (!args.query.trim())
      return errorResult("Invalid input", "Query cannot be empty");
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.app.bsky.feed.searchPosts({
        q: args.query,
        limit: Math.min(args.limit || 20, 50),
        cursor: args.cursor,
        sort: args.sort,
      }),
    );

    const posts = response.data.posts.map((post) => ({
      uri: post.uri,
      cid: post.cid,
      author: {
        handle: post.author.handle,
        displayName: post.author.displayName,
      },
      text: (post.record as { text?: string }).text,
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
      indexedAt: post.indexedAt,
    }));

    return senseResult(
      {
        posts,
        cursor: response.data.cursor,
        count: posts.length,
        query: args.query,
      },
      "Bluesky",
    );
  }),
);

server.registerTool(
  "bsky_get_post_thread",
  {
    description:
      "Get a Bluesky post thread including parent context and replies.",
    inputSchema: {
      ...credentialFields,
      uri: z
        .string()
        .describe(
          "AT URI of the post (at://did:plc:xxx/app.bsky.feed.post/yyy)",
        ),
      depth: z
        .number()
        .optional()
        .describe("Reply depth (default: 6, max: 20)"),
    },
  },
  safeHandler("bsky_get_post_thread", async (args) => {
    if (!args.uri.startsWith("at://"))
      return errorResult("Invalid URI", 'Must start with "at://"');
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.getPostThread({
        uri: args.uri,
        depth: Math.min(args.depth || 6, 20),
      }),
    );

    // Map thread to bounded DTO instead of returning raw SDK object
    const thread = response.data.thread;
    function mapPost(node: unknown): unknown {
      if (!node || typeof node !== "object") return node;
      const n = node as Record<string, unknown>;
      if (n.$type === "app.bsky.feed.defs#threadViewPost") {
        const post = n.post as Record<string, unknown>;
        const author = post?.author as Record<string, unknown>;
        return {
          post: {
            uri: post?.uri,
            cid: post?.cid,
            author: {
              handle: author?.handle,
              displayName: author?.displayName,
            },
            text: (post?.record as { text?: string })?.text,
            likeCount: post?.likeCount,
            repostCount: post?.repostCount,
            replyCount: post?.replyCount,
            indexedAt: post?.indexedAt,
          },
          parent: n.parent ? mapPost(n.parent) : undefined,
          replies: Array.isArray(n.replies)
            ? n.replies.map(mapPost)
            : undefined,
        };
      }
      return { $type: n.$type, uri: n.uri };
    }

    return senseResult(mapPost(thread), "Bluesky");
  }),
);

server.registerTool(
  "bsky_get_profile",
  {
    description: "Get a Bluesky user profile by handle or DID.",
    inputSchema: {
      ...credentialFields,
      actor: z
        .string()
        .describe('Bluesky handle (e.g., "user.bsky.social") or DID'),
    },
  },
  safeHandler("bsky_get_profile", async (args) => {
    if (!args.actor.trim())
      return errorResult("Invalid input", "Actor cannot be empty");
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.getProfile({ actor: args.actor }),
    );
    const p = response.data;
    return senseResult(
      {
        did: p.did,
        handle: p.handle,
        displayName: p.displayName,
        description: p.description,
        avatar: p.avatar,
        followersCount: p.followersCount,
        followsCount: p.followsCount,
        postsCount: p.postsCount,
        indexedAt: p.indexedAt,
      },
      "Bluesky",
    );
  }),
);

server.registerTool(
  "bsky_get_followers",
  {
    description: "Get followers of a Bluesky account.",
    inputSchema: {
      ...credentialFields,
      actor: z.string().describe("Bluesky handle or DID"),
      limit: z
        .number()
        .optional()
        .describe("Number of followers (default: 50, max: 100)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
  },
  safeHandler("bsky_get_followers", async (args) => {
    if (!args.actor.trim())
      return errorResult("Invalid input", "Actor cannot be empty");
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.getFollowers({
        actor: args.actor,
        limit: Math.min(args.limit || 50, 100),
        cursor: args.cursor,
      }),
    );

    const followers = response.data.followers.map((f) => ({
      did: f.did,
      handle: f.handle,
      displayName: f.displayName,
      description: f.description,
      avatar: f.avatar,
      indexedAt: f.indexedAt,
    }));

    return senseResult(
      {
        subject: response.data.subject.handle,
        followers,
        cursor: response.data.cursor,
        count: followers.length,
      },
      "Bluesky",
    );
  }),
);

server.registerTool(
  "bsky_search_users",
  {
    description: "Search for Bluesky users by name, handle, or keyword.",
    inputSchema: {
      ...credentialFields,
      query: z.string().describe("Search query"),
      limit: z
        .number()
        .optional()
        .describe("Number of results (default: 20, max: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
  },
  safeHandler("bsky_search_users", async (args) => {
    if (!args.query.trim())
      return errorResult("Invalid input", "Query cannot be empty");
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.searchActors({
        term: args.query,
        limit: Math.min(args.limit || 20, 50),
        cursor: args.cursor,
      }),
    );

    const users = response.data.actors.map((a) => ({
      did: a.did,
      handle: a.handle,
      displayName: a.displayName,
      description: a.description,
      avatar: a.avatar,
      indexedAt: a.indexedAt,
    }));

    return senseResult(
      {
        users,
        cursor: response.data.cursor,
        count: users.length,
        query: args.query,
      },
      "Bluesky",
    );
  }),
);

server.registerTool(
  "bsky_get_feed",
  {
    description: "Get posts from a custom Bluesky feed generator.",
    inputSchema: {
      ...credentialFields,
      feed: z.string().describe("AT URI of the feed generator"),
      limit: z
        .number()
        .optional()
        .describe("Number of posts (default: 20, max: 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
  },
  safeHandler("bsky_get_feed", async (args) => {
    if (!args.feed.startsWith("at://"))
      return errorResult("Invalid URI", 'Must start with "at://"');
    const result = await getAgent(args);
    if (!result.ok) return result.error;
    const { agent } = result;

    const response = await withRetry(() =>
      agent.app.bsky.feed.getFeed({
        feed: args.feed,
        limit: Math.min(args.limit || 20, 50),
        cursor: args.cursor,
      }),
    );

    const posts = response.data.feed.map((item) => ({
      uri: item.post.uri,
      cid: item.post.cid,
      author: {
        handle: item.post.author.handle,
        displayName: item.post.author.displayName,
      },
      text: (item.post.record as { text?: string }).text,
      likeCount: item.post.likeCount,
      repostCount: item.post.repostCount,
      replyCount: item.post.replyCount,
      indexedAt: item.post.indexedAt,
    }));

    return senseResult(
      {
        posts,
        cursor: response.data.cursor,
        count: posts.length,
      },
      "Bluesky",
    );
  }),
);

// =====================
// Media Specs
// =====================

server.registerTool(
  "bsky_get_media_specs",
  {
    description:
      "Get Bluesky platform media specifications — supported formats, dimensions, " +
      "file size limits, and duration caps. Call this BEFORE generating media assets " +
      "to ensure they conform to AT Protocol requirements.",
    inputSchema: {},
  },
  safeHandler("bsky_get_media_specs", async () => {
    return textResult({
      platform: "Bluesky (AT Protocol)",
      mediaFormats: [
        {
          type: "image",
          formats: ["JPG", "PNG", "GIF"],
          maxFileSize: "1MB per blob",
          maxDimensions: "2000x2000",
          recommendedDimensions: "1200x675 (landscape), 1080x1080 (square)",
          notes: "Up to 4 images per post (carousel). GIFs are static only.",
        },
        {
          type: "video",
          formats: ["MP4"],
          maxFileSize: "50MB",
          maxDuration: "60 seconds",
          maxDimensions: "1920x1080",
          recommendedDimensions: "1280x720 (16:9)",
          notes: "H.264 codec recommended. Vertical video supported.",
        },
      ],
      unsupportedFormats: [
        {
          type: "document",
          reason: "AT Protocol does not support document attachments",
        },
        {
          type: "audio",
          reason: "AT Protocol does not support audio attachments",
        },
      ],
      tip: "Images are limited to 1MB per blob — optimize/compress before uploading. Use 2000x2000 as the absolute max.",
    });
  }),
);

// =====================
// ACT Tools (write)
// =====================

server.registerTool(
  "bsky_create_post",
  {
    description:
      "Create a Bluesky post. Auto-detects @mentions, links, #hashtags. Max 300 chars. Supports link preview cards via linkUrl, image embeds via imageUrl, or video embeds via videoUrl (mutually exclusive).",
    inputSchema: {
      ...credentialFields,
      text: z.string().describe("Post text (max 300 characters)"),
      linkUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "URL to attach as a link preview card. Fetches OG tags (title, description, image) and displays as a rich card below the post. The URL does NOT need to appear in the post text.",
        ),
      imageUrl: z
        .string()
        .min(1)
        .optional()
        .refine((u) => !u || u.startsWith("https://"), {
          message: "imageUrl must use https://",
        })
        .describe(
          "URL of an image to embed in the post (JPEG or PNG, max 1MB). Must be https://. Mutually exclusive with linkUrl and videoUrl.",
        ),
      videoUrl: z
        .string()
        .min(1)
        .optional()
        .refine((u) => !u || u.startsWith("https://"), {
          message: "videoUrl must use https://",
        })
        .describe(
          "URL of a video to embed in the post (MP4 only, max 50MB). Must be https://. Mutually exclusive with linkUrl and imageUrl.",
        ),
    },
  },
  safeHandler("bsky_create_post", async (args) => {
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");
    const rt = new RichText({ text: args.text });
    if (rt.graphemeLength > 300)
      return errorResult(
        "Invalid input",
        `${rt.graphemeLength} chars exceeds 300 limit`,
      );
    const embedCount = [args.imageUrl, args.videoUrl, args.linkUrl].filter(
      Boolean,
    ).length;
    if (embedCount > 1) {
      return errorResult(
        "Invalid input",
        "Only one of imageUrl, videoUrl, or linkUrl can be provided.",
      );
    }
    const result = await getAgent(args, "bsky_create_post");
    if (!result.ok) return result.error;
    const { agent } = result;

    // If videoUrl: download+upload video in parallel with facet detection
    if (args.videoUrl) {
      const [, videoBlob] = await Promise.all([
        rt.detectFacets(agent),
        downloadAndUploadVideo(args.videoUrl, agent),
      ]);

      const response = await withRetry(() =>
        agent.post({
          text: rt.text,
          facets: rt.facets,
          embed: {
            $type: "app.bsky.embed.video",
            video: videoBlob,
            alt: args.text.slice(0, 300),
          } satisfies AppBskyEmbedVideo.Main,
        }),
      );

      return textResult({
        uri: response.uri,
        cid: response.cid,
        message: "Post created successfully with video",
        videoEmbed: true,
      });
    }

    // If imageUrl: download+upload image in parallel with facet detection
    if (args.imageUrl) {
      const [, imageResult] = await Promise.all([
        rt.detectFacets(agent),
        downloadAndUploadImage(args.imageUrl, agent),
      ]);

      const response = await withRetry(() =>
        agent.post({
          text: rt.text,
          facets: rt.facets,
          embed: {
            $type: "app.bsky.embed.images",
            images: [
              {
                alt: args.text.slice(0, 300),
                image: imageResult.blob,
              },
            ],
          },
        }),
      );

      return textResult({
        uri: response.uri,
        cid: response.cid,
        message: "Post created successfully with image",
        imageEmbed: { mimeType: imageResult.mimeType },
      });
    }

    // Existing linkUrl / text-only flow
    const [, linkResult] = await Promise.all([
      rt.detectFacets(agent),
      buildLinkEmbed(args.linkUrl, agent),
    ]);

    const response = await withRetry(() =>
      agent.post({
        text: rt.text,
        facets: rt.facets,
        embed: linkResult?.embed,
      }),
    );

    return textResult({
      uri: response.uri,
      cid: response.cid,
      message: "Post created successfully",
      ...(linkResult && { linkPreview: linkResult.status }),
    });
  }),
);

server.registerTool(
  "bsky_reply",
  {
    description:
      "Reply to a Bluesky post. Auto-detects mentions, links, hashtags. Supports link preview cards via linkUrl.",
    inputSchema: {
      ...credentialFields,
      text: z.string().describe("Reply text (max 300 characters)"),
      parentUri: z.string().describe("AT URI of the post to reply to"),
      parentCid: z.string().describe("CID of the post to reply to"),
      rootUri: z
        .string()
        .optional()
        .describe("AT URI of thread root (defaults to parent)"),
      rootCid: z
        .string()
        .optional()
        .describe("CID of thread root (defaults to parent)"),
      linkUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "URL to attach as a link preview card. Fetches OG tags (title, description, image) and displays as a rich card below the reply.",
        ),
    },
  },
  safeHandler("bsky_reply", async (args) => {
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");
    const rt = new RichText({ text: args.text });
    if (rt.graphemeLength > 300)
      return errorResult(
        "Invalid input",
        `${rt.graphemeLength} chars exceeds 300 limit`,
      );
    if (!args.parentUri.startsWith("at://"))
      return errorResult("Invalid URI", 'parentUri must start with "at://"');
    const result = await getAgent(args, "bsky_reply");
    if (!result.ok) return result.error;
    const { agent } = result;

    const [, linkResult] = await Promise.all([
      rt.detectFacets(agent),
      buildLinkEmbed(args.linkUrl, agent),
    ]);

    const response = await withRetry(() =>
      agent.post({
        text: rt.text,
        facets: rt.facets,
        embed: linkResult?.embed,
        reply: {
          root: {
            uri: args.rootUri || args.parentUri,
            cid: args.rootCid || args.parentCid,
          },
          parent: { uri: args.parentUri, cid: args.parentCid },
        },
      }),
    );

    return textResult({
      uri: response.uri,
      cid: response.cid,
      message: "Reply posted successfully",
      ...(linkResult && { linkPreview: linkResult.status }),
    });
  }),
);

server.registerTool(
  "bsky_like",
  {
    description: "Like a Bluesky post.",
    inputSchema: {
      ...credentialFields,
      uri: z.string().describe("AT URI of the post"),
      cid: z.string().describe("CID of the post"),
    },
  },
  safeHandler("bsky_like", async (args) => {
    if (!args.uri.startsWith("at://"))
      return errorResult("Invalid URI", 'Must start with "at://"');
    const result = await getAgent(args, "bsky_like");
    if (!result.ok) return result.error;
    const response = await withRetry(() =>
      result.agent.like(args.uri, args.cid),
    );
    return textResult({
      uri: response.uri,
      message: "Post liked successfully",
    });
  }),
);

server.registerTool(
  "bsky_repost",
  {
    description: "Repost a Bluesky post.",
    inputSchema: {
      ...credentialFields,
      uri: z.string().describe("AT URI of the post"),
      cid: z.string().describe("CID of the post"),
    },
  },
  safeHandler("bsky_repost", async (args) => {
    if (!args.uri.startsWith("at://"))
      return errorResult("Invalid URI", 'Must start with "at://"');
    const result = await getAgent(args, "bsky_repost");
    if (!result.ok) return result.error;
    const response = await withRetry(() =>
      result.agent.repost(args.uri, args.cid),
    );
    return textResult({
      uri: response.uri,
      message: "Post reposted successfully",
    });
  }),
);

server.registerTool(
  "bsky_follow",
  {
    description: "Follow a Bluesky user by DID.",
    inputSchema: {
      ...credentialFields,
      did: z.string().describe('DID of the user (e.g., "did:plc:xxx")'),
    },
  },
  safeHandler("bsky_follow", async (args) => {
    if (!args.did.startsWith("did:"))
      return errorResult("Invalid DID", 'Must start with "did:"');
    const result = await getAgent(args, "bsky_follow");
    if (!result.ok) return result.error;
    const response = await withRetry(() => result.agent.follow(args.did));
    return textResult({
      uri: response.uri,
      message: "User followed successfully",
    });
  }),
);

server.registerTool(
  "bsky_delete_post",
  {
    description: "Delete a Bluesky post.",
    inputSchema: {
      ...credentialFields,
      uri: z.string().describe("AT URI of the post to delete"),
    },
  },
  safeHandler("bsky_delete_post", async (args) => {
    if (!args.uri.startsWith("at://"))
      return errorResult("Invalid URI", 'Must start with "at://"');
    const result = await getAgent(args, "bsky_delete_post");
    if (!result.ok) return result.error;
    await withRetry(() => result.agent.deletePost(args.uri));
    return textResult({ message: "Post deleted successfully", uri: args.uri });
  }),
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Bluesky MCP Server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
