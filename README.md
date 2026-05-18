# 🦋 Bluesky MCP Server

[![CI](https://github.com/luminarylane/bluesky-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/luminarylane/bluesky-mcp-server/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/bluesky-mcp-server)](https://www.npmjs.com/package/bluesky-mcp-server)
[![GitHub Release](https://img.shields.io/github/v/release/luminarylane/bluesky-mcp-server)](https://github.com/luminarylane/bluesky-mcp-server/releases)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A Model Context Protocol (MCP) server that enables Claude Desktop (and other MCP clients) to read and post on [Bluesky](https://bsky.app) via the AT Protocol.

## ✨ Features

### ⚡ Built-in Reliability
- **Session Caching** — Authenticated sessions are reused for 90 minutes to avoid login rate limits (30 logins/5min on Bluesky)
- **Rate Limiting** — Token-bucket rate limiting across read, write, and session operation buckets
- **Auto-retry** — Exponential backoff on HTTP 429 responses
- **Actionable Errors** — Every error response includes a structured `action` field with exactly what to do next

### 🔍 SENSE Tools (Read) — 9 Tools

- 📰 **bsky_get_timeline** — Get the home timeline from followed accounts
- 🔔 **bsky_get_notifications** — Likes, reposts, follows, mentions, and replies
- 🔎 **bsky_search_posts** — Search by keyword, phrase, hashtag, or `from:handle`
- 🧵 **bsky_get_post_thread** — Fetch a thread with full parent context and replies
- 👤 **bsky_get_profile** — Get any user's profile by handle or DID
- 👥 **bsky_get_followers** — List followers of an account
- 🕵️ **bsky_search_users** — Find users by name, handle, or keyword
- 📡 **bsky_get_feed** — Get posts from any custom feed generator
- 📐 **bsky_get_media_specs** — Check supported formats, dimensions, and size limits before generating media

### ✍️ ACT Tools (Write) — 6 Tools

- ✏️ **bsky_create_post** — Create posts with text, link preview cards, images (JPEG/PNG), or video (MP4)
- 💬 **bsky_reply** — Reply to any post with optional link preview card
- ❤️ **bsky_like** — Like a post by URI + CID
- 🔁 **bsky_repost** — Repost a post by URI + CID
- ➕ **bsky_follow** — Follow a user by DID
- 🗑️ **bsky_delete_post** — Delete a post by URI

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- A Bluesky account with an **App Password** — [generate one at bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
- Claude Desktop (or any MCP-compatible client)

### Installation

#### Option 1: npx (Zero Install) ⚡

Run directly without installing anything:

```bash
BLUESKY_HANDLE=you.bsky.social BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npx bluesky-mcp-server
```

**Claude Desktop Configuration for npx:**

Add to your Claude Desktop config file:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "npx",
      "args": ["bluesky-mcp-server"],
      "env": {
        "BLUESKY_HANDLE": "you.bsky.social",
        "BLUESKY_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

#### Option 2: Install globally from npm

```bash
npm install -g bluesky-mcp-server
```

**Claude Desktop Configuration:**

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "bluesky-mcp-server",
      "env": {
        "BLUESKY_HANDLE": "you.bsky.social",
        "BLUESKY_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

#### Option 3: Install from source

```bash
git clone https://github.com/luminarylane/bluesky-mcp-server.git
cd bluesky-mcp-server
npm install
npm run build
```

**Claude Desktop Configuration:**

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "node",
      "args": ["/path/to/bluesky-mcp-server/dist/index.js"],
      "env": {
        "BLUESKY_HANDLE": "you.bsky.social",
        "BLUESKY_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

After updating the config, **restart Claude Desktop**.

### Multi-account Usage

Credentials can be overridden per tool call — useful for managing multiple Bluesky accounts:

```
Post as alice.bsky.social using handle "alice.bsky.social" and appPassword "aaaa-aaaa-aaaa-aaaa"
Post as bob.bsky.social using handle "bob.bsky.social" and appPassword "bbbb-bbbb-bbbb-bbbb"
```

## 💬 Usage

Once configured, ask Claude to:

- "What's on my Bluesky timeline?"
- "Search Bluesky for posts about #TypeScript"
- "Post to Bluesky: 'Hello from Claude!'"
- "Reply to that post with a link to example.com"
- "Get the profile for user.bsky.social"
- "Like and repost the top result"
- "What image formats does Bluesky support?"

## 🛠️ Tools Reference

### SENSE Tools (Read)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `bsky_get_timeline` | Home timeline from followed accounts | `limit` (max 50), `cursor` |
| `bsky_get_notifications` | Likes, reposts, follows, mentions, replies | `limit` (max 50), `cursor` |
| `bsky_search_posts` | Search posts by keyword/phrase/hashtag | `query`, `sort` (top/latest), `limit` |
| `bsky_get_post_thread` | Fetch a post and its full thread | `uri` (AT URI), `depth` (max 20) |
| `bsky_get_profile` | Get a user's profile | `actor` (handle or DID) |
| `bsky_get_followers` | List followers of an account | `actor`, `limit` (max 100) |
| `bsky_search_users` | Find users by name or keyword | `query`, `limit` (max 50) |
| `bsky_get_feed` | Posts from a custom feed generator | `feed` (AT URI), `limit` |
| `bsky_get_media_specs` | Platform media format requirements | — |

### ACT Tools (Write)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `bsky_create_post` | Create a post (text, link card, image, or video) | `text`, `linkUrl` / `imageUrl` / `videoUrl` |
| `bsky_reply` | Reply to a post | `text`, `parentUri`, `parentCid` |
| `bsky_like` | Like a post | `uri`, `cid` |
| `bsky_repost` | Repost a post | `uri`, `cid` |
| `bsky_follow` | Follow a user | `did` |
| `bsky_delete_post` | Delete a post | `uri` |

> All tools accept optional `handle` and `appPassword` arguments to override the environment-variable credentials.

## 📎 Media Embeds

`bsky_create_post` supports three embed types (mutually exclusive):

| Type | Parameter | Accepted Formats | Max Size |
|------|-----------|-----------------|----------|
| Link preview card | `linkUrl` | Any URL | — |
| Image | `imageUrl` | JPEG, PNG (`https://` only) | 1 MB |
| Video | `videoUrl` | MP4 (`https://` only) | 50 MB, 60s |

Link preview cards automatically fetch `og:title`, `og:description`, and `og:image` from the target URL.

## 🔧 Troubleshooting

### Common Errors

#### Missing credentials
```
Missing credentials — Provide handle + appPassword as arguments, or set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD env vars.
```
**Solution:** Set the env vars in your Claude Desktop config, or pass `handle` and `appPassword` directly in the tool call.

#### Auth failed
```
Auth failed — Bluesky login failed: Invalid identifier or password
```
**Solution:** Generate a fresh App Password at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords). App passwords are separate from your account password.

#### Rate limited
```
Rate limited — Bluesky API rate limit reached (write bucket). Wait 45s then retry.
```
**Solution:** The server includes built-in rate limiting. Wait the indicated number of seconds and retry the same tool call — the `retryAfterSeconds` field tells you exactly how long.

#### Post too long
```
400 Bad Request — POST_TOO_LONG: Text exceeds 300 graphemes. Shorten the text and retry.
```
**Solution:** Bluesky's limit is 300 graphemes (not bytes). Shorten the post text.

#### Image or video URL rejected
```
URL rejected (not https:// or blocked address)
```
**Solution:** `imageUrl` and `videoUrl` must use `https://` and point to a public internet address. Local or private network URLs are blocked.

#### Post not found (404)
```
POST_NOT_FOUND: This post may have been deleted. Skip it and move on.
```
**Solution:** The post was deleted after you retrieved its URI. Skip this operation.

### Getting AT URIs

Many tools require an AT URI (`at://did:plc:xxx/app.bsky.feed.post/yyy`). You can obtain one by:

1. Using `bsky_search_posts` — each result includes `uri` and `cid`
2. Using `bsky_get_timeline` — same shape
3. Using `bsky_get_post_thread` — the root post's `uri` is in the response

### Reporting Issues

1. **Check existing issues:** [GitHub Issues](https://github.com/luminarylane/bluesky-mcp-server/issues)
2. **Open a new issue** with:
   ```
   Error: [paste full error message]
   Tool: [tool name]
   Steps to reproduce: [what you asked Claude to do]
   Environment: [OS, Node.js version]
   ```

[📝 Open an Issue](https://github.com/luminarylane/bluesky-mcp-server/issues/new)

## 🤝 Contributing

Contributions are welcome! To get started:

```bash
git clone https://github.com/luminarylane/bluesky-mcp-server.git
cd bluesky-mcp-server
npm install
npm test       # Run the test suite
npm run build  # Compile TypeScript
```

## 📝 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [Bluesky](https://bsky.app) and the [AT Protocol](https://atproto.com) team for building an open social network
- [Anthropic](https://anthropic.com) for the MCP specification
