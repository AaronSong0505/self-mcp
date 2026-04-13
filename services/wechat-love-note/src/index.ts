import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WechatLoveNoteService } from "./service.js";

async function main() {
  const service = await WechatLoveNoteService.create();
  const server = new McpServer({
    name: "wechat-love-note-mcp",
    version: "0.1.0",
  });

  server.tool(
    "wechat_love_note.run",
    "Run Xiaoxiong's daily love-note cycle deterministically for Faye's lane.",
    {
      date: z.string().optional(),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
    },
    async ({ date, dryRun, force }) => {
      const result = await service.run({ date, dryRun, force });
      return {
        content: [
          {
            type: "text",
            text: `${result.status}: ${result.date} scheduledFor=${result.scheduledFor} sentCount=${result.sentCount}`,
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
  process.stderr.write(
    `wechat-love-note-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
