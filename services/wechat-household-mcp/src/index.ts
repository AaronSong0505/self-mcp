import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WechatHouseholdRelayService } from "./service.js";

async function main() {
  const service = await WechatHouseholdRelayService.create();
  const server = new McpServer({
    name: "wechat-household-mcp",
    version: "0.1.0",
  });

  server.tool(
    "wechat_household.send_relay",
    "Forward one family member's explicit message to another whitelisted family member through the active household WeChat lane.",
    {
      fromPerson: z.string().min(1),
      toPerson: z.string().min(1),
      message: z.string().min(1),
      dryRun: z.boolean().optional(),
    },
    async ({ fromPerson, toPerson, message, dryRun }) => {
      const result = await service.sendRelay({ fromPerson, toPerson, message, dryRun });
      return {
        content: [
          {
            type: "text",
            text:
              result.status === "sent"
                ? `Forwarded ${result.fromPerson}'s message to ${result.toPerson}.`
                : `Prepared relay from ${result.fromPerson} to ${result.toPerson} (${result.status}).`,
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
    `wechat-household-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
