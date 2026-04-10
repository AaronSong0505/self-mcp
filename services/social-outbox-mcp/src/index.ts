import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OUTBOX_STATUSES, SocialOutboxService } from "./service.js";

async function main() {
  const service = SocialOutboxService.createFromEnv();
  const server = new McpServer({
    name: "social-outbox-mcp",
    version: "0.1.0",
  });

  server.tool(
    "social_outbox.list",
    "List items from OUTBOX.md, optionally filtered by status.",
    {
      status: z.enum(["all", ...OUTBOX_STATUSES]).optional(),
    },
    async ({ status }) => {
      const result = service.listItems({ status });
      const lines =
        result.items.length === 0
          ? ["No outbox items found."]
          : result.items.map(
              (item) =>
                `${item.id} | ${item.status} | ${item.targetChannel} | ${item.intent} | next: ${item.nextStep}`,
            );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.upsert",
    "Create or update a concrete OUTBOX.md item so review and send state are stored deterministically.",
    {
      id: z.string().min(1),
      created: z.string().optional(),
      targetChannel: z.string().optional(),
      audience: z.string().optional(),
      intent: z.string().optional(),
      source: z.string().optional(),
      relatedDraft: z.string().optional(),
      status: z.enum(OUTBOX_STATUSES).optional(),
      approval: z.string().optional(),
      delivery: z.string().optional(),
      nextStep: z.string().optional(),
    },
    async (params) => {
      const item = service.upsertItem(params);
      return {
        content: [{ type: "text", text: `Upserted ${item.id} as ${item.status}.` }],
        structuredContent: item,
      };
    },
  );

  server.tool(
    "social_outbox.transition",
    "Transition an existing OUTBOX item to a new status while preserving its stable queue identity.",
    {
      id: z.string().min(1),
      status: z.enum(OUTBOX_STATUSES),
      approval: z.string().optional(),
      delivery: z.string().optional(),
      nextStep: z.string().optional(),
    },
    async ({ id, status, approval, delivery, nextStep }) => {
      const item = service.transitionItem({ id, status, approval, delivery, nextStep });
      return {
        content: [{ type: "text", text: `Transitioned ${item.id} to ${item.status}.` }],
        structuredContent: item,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(
    `social-outbox-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
