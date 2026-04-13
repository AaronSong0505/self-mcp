import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BlueskySocialService } from "./service.js";

function renderStatusText(result: {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  serviceUrl: string;
  handle?: string;
  activeChannelLabel: string;
  reviewRequired: boolean;
}): string {
  const handle = result.handle ? ` handle=${result.handle}` : "";
  return `Bluesky lane ${result.enabled ? "enabled" : "disabled"}; configured=${result.configured}; authenticated=${result.authenticated}; service=${result.serviceUrl}; channel=${result.activeChannelLabel}; reviewRequired=${result.reviewRequired}.${handle}`;
}

function renderPreviewText(result: {
  graphemeLength: number;
  maxGraphemes: number;
  fitsLimit: boolean;
  facetsCount: number;
  activeChannelLabel: string;
  reviewRequired: boolean;
}): string {
  return `Previewed Bluesky post for ${result.activeChannelLabel}: ${result.graphemeLength}/${result.maxGraphemes} graphemes, fitsLimit=${result.fitsLimit}, facets=${result.facetsCount}, reviewRequired=${result.reviewRequired}.`;
}

function renderFeedText(result: {
  source: string;
  items: Array<{
    uri: string;
    authorHandle?: string;
    text: string;
    indexedAt?: string;
  }>;
}): string {
  if (result.items.length === 0) {
    return `No Bluesky posts found for ${result.source}.`;
  }
  return result.items
    .map(
      (item) =>
        `${item.authorHandle ?? "unknown"} | ${item.indexedAt ?? "unknown time"}\n${item.text}\n${item.uri}`,
    )
    .join("\n\n");
}

async function main() {
  const service = new BlueskySocialService();
  const server = new McpServer({
    name: "bluesky-social-mcp",
    version: "0.1.0",
  });

  server.tool(
    "bluesky_account.status",
    "Show whether the Bluesky social lane is configured and authenticated.",
    {},
    async () => {
      const result = await service.status();
      return {
        content: [{ type: "text", text: renderStatusText(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_post.preview",
    "Preview a Bluesky post, including grapheme length and whether it fits the current limit.",
    {
      text: z.string().min(1),
      langs: z.array(z.string()).optional(),
      sourceContext: z.string().optional(),
    },
    async ({ text, langs, sourceContext }) => {
      const result = await service.previewPost({ text, langs, sourceContext });
      return {
        content: [{ type: "text", text: renderPreviewText(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_post.publish",
    "Publish a post to Bluesky. Use dryRun=true to validate and preview without posting.",
    {
      text: z.string().min(1),
      langs: z.array(z.string()).optional(),
      sourceContext: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ text, langs, sourceContext, dryRun }) => {
      const result = await service.publishPost({ text, langs, sourceContext, dryRun });
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? renderPreviewText(result)
              : `Published Bluesky post for ${result.activeChannelLabel}: ${result.uri}`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_feed.home",
    "Read the authenticated account's home feed for browsing and social awareness.",
    {
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ limit }) => {
      const result = await service.homeFeed({ limit });
      return {
        content: [{ type: "text", text: renderFeedText(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_feed.actor",
    "Read one actor's feed, defaulting to Xiaoxiong's own Bluesky account.",
    {
      actor: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ actor, limit }) => {
      const result = await service.actorFeed({ actor, limit });
      return {
        content: [{ type: "text", text: renderFeedText(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_feed.search",
    "Search public Bluesky posts by query so Xiaoxiong can browse topics before speaking.",
    {
      q: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ q, limit }) => {
      const result = await service.searchPosts({ q, limit });
      return {
        content: [{ type: "text", text: renderFeedText(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_thread.read",
    "Read a Bluesky thread so Xiaoxiong can inspect context before replying.",
    {
      uri: z.string().min(1),
      depth: z.number().int().min(0).max(20).optional(),
    },
    async ({ uri, depth }) => {
      const result = await service.readThread({ uri, depth });
      return {
        content: [{ type: "text", text: renderFeedText({ source: result.uri, items: result.items }) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "bluesky_post.reply",
    "Reply to a specific Bluesky post or thread once Xiaoxiong has decided to comment.",
    {
      text: z.string().min(1),
      parentUri: z.string().min(1),
      parentCid: z.string().min(1),
      rootUri: z.string().optional(),
      rootCid: z.string().optional(),
      langs: z.array(z.string()).optional(),
      sourceContext: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ text, parentUri, parentCid, rootUri, rootCid, langs, sourceContext, dryRun }) => {
      const result = await service.replyPost({
        text,
        parentUri,
        parentCid,
        rootUri,
        rootCid,
        langs,
        sourceContext,
        dryRun,
      });
      return {
        content: [
          {
            type: "text",
            text: result.dryRun
              ? renderPreviewText(result)
              : `Published Bluesky reply for ${result.activeChannelLabel}: ${result.uri}`,
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
  process.stderr.write(`bluesky-social-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
