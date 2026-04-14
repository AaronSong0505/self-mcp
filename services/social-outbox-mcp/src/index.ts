import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OUTBOX_STATUSES, SocialOutboxService } from "./service.js";
import { runAutonomousCycle } from "./autonomous-cycle.js";
import { runXReviewCycle } from "./x-cycle.js";

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
    "social_outbox.recent_published",
    "List recent social posts that were actually published, so Aaron can inspect what Xiaoxiong has really posted.",
    {
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ limit }) => {
      const result = service.listRecentPublished(limit ?? 5);
      const lines =
        result.items.length === 0
          ? ["No published social posts found yet."]
          : result.items.map(
              (item) =>
                `${item.id} | ${item.channel} | ${item.publishedAt} | Draft ${item.variant}\n${item.text}`,
            );
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
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
    "social_outbox.x_preview",
    "Preview a specific OUTBOX draft variant for X / Twitter without publishing.",
    {
      id: z.string().min(1),
      variant: z.string().min(1).optional(),
    },
    async ({ id, variant }) => {
      const result = await service.previewX(id, variant);
      return {
        content: [
          {
            type: "text",
            text: `Previewed ${result.item.id} Draft ${result.chosenVariant} for X / Twitter: ${result.preview.length}/${result.preview.maxLength}, fitsLimit=${result.preview.fitsLimit}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.x_publish",
    "Publish a reviewed OUTBOX draft variant to X / Twitter using the logged-in browser lane.",
    {
      id: z.string().min(1),
      variant: z.string().min(1).optional(),
      approval: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ id, variant, approval, dryRun }) => {
      const result = await service.publishX({ id, variant, approval, dryRun });
      return {
        content: [
          {
            type: "text",
            text: result.publish.dryRun
              ? `Dry-ran ${result.item.id} Draft ${result.chosenVariant} for X / Twitter.`
              : `Published ${result.item.id} Draft ${result.chosenVariant} to X / Twitter${result.publish.url ? `: ${result.publish.url}` : ""}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.x_reply_publish",
    "Publish a reviewed OUTBOX draft variant as a reply to a specific X / Twitter post, using the item's Target URL.",
    {
      id: z.string().min(1),
      variant: z.string().min(1).optional(),
      approval: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ id, variant, approval, dryRun }) => {
      const result = await service.publishXReply({ id, variant, approval, dryRun });
      return {
        content: [
          {
            type: "text",
            text: result.publish.dryRun
              ? `Dry-ran X reply for ${result.item.id} Draft ${result.chosenVariant}.`
              : `Published X reply for ${result.item.id} Draft ${result.chosenVariant} to ${result.publish.parentUrl}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.x_reply_prepare",
    "Create a deterministic OUTBOX + SOCIAL_DRAFTS entry for an X / Twitter reply, so replies follow the same tracked state flow as posts.",
    {
      title: z.string().min(1),
      targetUrl: z.string().min(1),
      intent: z.string().min(1),
      source: z.string().min(1),
      whyItMatters: z.string().min(1),
      variantA: z.string().min(1),
      variantB: z.string().min(1).optional(),
      variantC: z.string().min(1).optional(),
      status: z.enum(["draft", "scheduled", "waiting_review"]).optional(),
      approval: z.string().optional(),
      nextStep: z.string().optional(),
    },
    async ({ title, targetUrl, intent, source, whyItMatters, variantA, variantB, variantC, status, approval, nextStep }) => {
      const variants = [
        { label: "A", text: variantA },
        ...(variantB ? [{ label: "B", text: variantB }] : []),
        ...(variantC ? [{ label: "C", text: variantC }] : []),
      ];
      const result = service.createDraftItem({
        title,
        targetChannel: "X Reply",
        targetUrl,
        intent,
        source,
        whyItMatters,
        variants,
        status: status ?? "scheduled",
        approval: approval ?? "not needed",
        delivery: status === "draft" ? "not started" : "scheduled for deterministic X reply flow",
        nextStep: nextStep ?? "publish the strongest reply variant if the thread still deserves an answer",
      });
      return {
        content: [
          {
            type: "text",
            text: `Prepared ${result.item.id} as ${result.item.status} for X reply to ${targetUrl}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.x_review_cycle",
    "Run Xiaoxiong's deterministic X/Twitter review cycle: read, think, store observations, and optionally queue an X draft.",
    {
      dryRun: z.boolean().optional(),
    },
    async ({ dryRun }) => {
      const result = await runXReviewCycle({ dryRun, service });
      const text =
        result.status === "reviewed"
          ? `reviewed X lane: home=${result.homeCount}, drafts=${result.draftId ? 1 : 0}, observations=${result.observationLines.length}`
          : `${result.status}: ${result.reason}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "social_outbox.autonomous_cycle",
    "Run Xiaoxiong's scheduled social cycle deterministically: review X, draft if needed, then publish to the primary public channel when allowed.",
    {
      dryRun: z.boolean().optional(),
    },
    async ({ dryRun }) => {
      const result = await runAutonomousCycle({ dryRun });
      const text =
        result.status === "published" || result.status === "dry_run"
          ? `${result.status} ${result.channel} ${result.id} Draft ${result.chosenVariant}${result.uri ? ` -> ${result.uri}` : ""}`
          : result.status === "blocked" ||
              result.status === "disabled" ||
              result.status === "out_of_window" ||
              result.status === "cooldown" ||
              result.status === "idle"
            ? `${result.status}: ${result.reason}`
            : `${result.status}`;
      return {
        content: [
          {
            type: "text",
            text: result.xReview ? `${text}\nX review: ${result.xReview.status}` : text,
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
      targetUrl: z.string().optional(),
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
