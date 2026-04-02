import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WechatDigestService } from "./service.js";

async function main() {
  const service = await WechatDigestService.create();
  const server = new McpServer({
    name: "wechat-digest-mcp",
    version: "0.1.0",
  });

  server.tool(
    "wechat_sources.scan",
    "Scan configured RSS or HTML list sources and record newly discovered articles.",
    {
      sourceIds: z.array(z.string()).optional(),
      since: z.string().optional(),
    },
    async ({ sourceIds, since }) => {
      const result = await service.scan({ sourceIds, since });
      return {
        content: [
          {
            type: "text",
            text: `Scanned ${result.sourceCount} source(s), found ${result.articles.length} article candidate(s).`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_articles.analyze",
    "Fetch full article content, extract images, and produce structured labels and summaries.",
    {
      articleIds: z.array(z.string()).optional(),
      urls: z.array(z.string().url()).optional(),
    },
    async ({ articleIds, urls }) => {
      const result = await service.analyze({ articleIds, urls });
      return {
        content: [
          {
            type: "text",
            text: `Analyzed ${result.length} article(s).`,
          },
        ],
        structuredContent: { articles: result },
      };
    },
  );

  server.tool(
    "wechat_digest.build",
    "Build the morning digest for one delivery target. When dryRun=false, it also sends the digest through OpenClaw.",
    {
      date: z.string().optional(),
      targetId: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ date, targetId, dryRun }) => {
      const result = await service.buildDigest({ date, targetId, dryRun });
      return {
        content: [
          {
            type: "text",
            text: dryRun === false
              ? `Built and sent ${result.sentCount} digest message(s) for ${result.date}.`
              : `Built ${result.messages.length} digest message(s) for ${result.date}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_digest.status",
    "Show today's scan/analyze/delivery status for the digest pipeline.",
    {
      date: z.string().optional(),
    },
    async ({ date }) => {
      const result = await service.status({ date });
      return {
        content: [
          {
            type: "text",
            text: `Status ${result.date}: discovered=${result.discovered}, analyzed=${result.analyzed}, delivered=${result.delivered}.`,
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
  process.stderr.write(`wechat-digest-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
