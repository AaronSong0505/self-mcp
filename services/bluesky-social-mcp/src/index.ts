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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`bluesky-social-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
