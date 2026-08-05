/**
 * Public surface for non-MCP consumers (the web app importing via
 * the `@bluesky-mcp` webpack alias).
 *
 * The MCP server's `index.ts` registers its tool handlers using these same
 * modules — single source of truth for both callers.
 */
export * from "./insights.js";
export { createAgent } from "../client.js";
