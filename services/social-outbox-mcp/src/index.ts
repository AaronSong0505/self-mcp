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
    "social_outbox.review_packet",
    "Load one OUTBOX item together with its UTF-8 draft variants from SOCIAL_DRAFTS.md so review can happen deterministically.",
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const result = service.getReviewPacket(id);
      const variants =
        result.variants.length === 0
          ? "No draft variants found."
          : result.variants.map((variant) => `Draft ${variant.label}: ${variant.text}`).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `${result.item.id} | ${result.item.status} | ${result.item.targetChannel}\n${result.draftTitle}\n\n${variants}`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.bluesky_preview",
    "Preview a specific OUTBOX draft variant for Bluesky without publishing.",
    {
      id: z.string().min(1),
      variant: z.string().min(1).optional(),
    },
    async ({ id, variant }) => {
      const result = await service.previewBluesky(id, variant);
      return {
        content: [
          {
            type: "text",
            text: `Previewed ${result.item.id} Draft ${result.chosenVariant} for Bluesky: ${result.preview.graphemeLength}/${result.preview.maxGraphemes}, fitsLimit=${result.preview.fitsLimit}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.bluesky_publish",
    "Publish a reviewed OUTBOX draft variant to Bluesky using UTF-8 draft content loaded from SOCIAL_DRAFTS.md.",
    {
      id: z.string().min(1),
      variant: z.string().min(1).optional(),
      approval: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ id, variant, approval, dryRun }) => {
      const result = await service.publishBluesky({ id, variant, approval, dryRun });
      return {
        content: [
          {
            type: "text",
            text: result.publish.dryRun
              ? `Dry-ran ${result.item.id} Draft ${result.chosenVariant} for Bluesky.`
              : `Published ${result.item.id} Draft ${result.chosenVariant} to Bluesky: ${result.publish.uri}`,
          },
        ],
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
