import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { XSocialService } from "./service.js";

function renderPosts(result: { source: string; items: Array<{ url: string; authorHandle?: string; timeIso?: string; text: string }> }): string {
  if (result.items.length === 0) {
    return `No X posts found for ${result.source}.`;
  }
  return result.items
    .map((item) => `${item.authorHandle ? `@${item.authorHandle}` : "unknown"} | ${item.timeIso ?? "unknown time"}\n${item.text}\n${item.url}`)
    .join("\n\n");
}

async function main() {
  const service = new XSocialService();
  const server = new McpServer({
    name: "x-social-mcp",
    version: "0.1.0",
  });

  server.tool(
    "x_account.status",
    "Show whether the X browser lane is enabled, reachable, and logged in through the dedicated OpenClaw browser profile.",
    {},
    async () => {
      const result = await service.status();
      const text = result.reachable
        ? `X lane ${result.enabled ? "enabled" : "disabled"}; authenticated=${result.authenticated}; cdp=${result.cdpUrl}${result.handle ? `; handle=${result.handle}` : ""}${result.currentUrl ? `; url=${result.currentUrl}` : ""}.`
        : `X lane unreachable at ${result.cdpUrl}${result.lastError ? `: ${result.lastError}` : ""}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_feed.home",
    "Read the current X home timeline from the logged-in browser session.",
    {
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ limit }) => {
      const result = await service.homeFeed({ limit });
      return {
        content: [{ type: "text", text: renderPosts(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_feed.mentions",
    "Read the current X mentions timeline from the logged-in browser session.",
    {
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ limit }) => {
      const result = await service.mentionsFeed({ limit });
      return {
        content: [{ type: "text", text: renderPosts(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_feed.notifications",
    "Read the current X notifications timeline from the logged-in browser session.",
    {
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ limit }) => {
      const result = await service.notificationsFeed({ limit });
      return {
        content: [{ type: "text", text: renderPosts(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_feed.actor",
    "Read one actor's X feed. Defaults to the authenticated account if actor is omitted.",
    {
      actor: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ actor, limit }) => {
      const result = await service.actorFeed({ actor, limit });
      return {
        content: [{ type: "text", text: renderPosts(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_feed.search",
    "Search X posts by query using the logged-in browser session.",
    {
      q: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      mode: z.enum(["top", "latest"]).optional(),
    },
    async ({ q, limit, mode }) => {
      const result = await service.searchPosts({ q, limit, mode });
      return {
        content: [{ type: "text", text: renderPosts(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_thread.read",
    "Read an X thread before deciding whether Xiaoxiong should reply.",
    {
      url: z.string().min(1),
      limit: z.number().int().min(1).max(30).optional(),
    },
    async ({ url, limit }) => {
      const result = await service.readThread({ url, limit });
      return {
        content: [{ type: "text", text: renderPosts({ source: result.url, items: result.items }) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_post.publish",
    "Publish an original X post through the logged-in browser session. Use dryRun=true for preview-only validation.",
    {
      text: z.string().min(1),
      dryRun: z.boolean().optional(),
    },
    async ({ text, dryRun }) => {
      const result = await service.publishPost({ text, dryRun });
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Previewed X post: ${result.length}/${result.maxLength}, fitsLimit=${result.fitsLimit}.`
              : `Published X post via ${result.activeChannelLabel}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "x_post.reply",
    "Reply to a specific X post after reading the thread. Use dryRun=true to preview without sending.",
    {
      url: z.string().min(1),
      text: z.string().min(1),
      dryRun: z.boolean().optional(),
    },
    async ({ url, text, dryRun }) => {
      const result = await service.replyPost({ url, text, dryRun });
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? `Previewed X reply: ${result.length}/${result.maxLength}, fitsLimit=${result.fitsLimit}.`
              : `Published X reply to ${result.parentUrl}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`x-social-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
