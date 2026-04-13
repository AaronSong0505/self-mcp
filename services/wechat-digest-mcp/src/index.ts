import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WechatDigestService } from "./service.js";

function renderPendingItems(result: {
  status: string;
  dateField?: string;
  dateFrom?: string;
  dateTo?: string;
  items: Array<{
    code: string;
    candidateType: string;
    displayValue: string;
    targetBucket: string;
    targetLabel?: string;
    aliases: string[];
    confidence: string;
    rationale: string;
    evidenceSnippet: string;
    breakoutCandidate: boolean;
    articleCount: number;
    evidenceArticleTitles: string[];
    approvedAt?: string;
  }>;
}): string {
  if (result.items.length === 0) {
    const emptyFilter =
      result.dateFrom || result.dateTo
        ? ` with ${result.dateField ?? "seen"} in ${result.dateFrom ?? "..." }..${result.dateTo ?? "..."}`
        : "";
    return `No learning candidates found for status=${result.status}${emptyFilter}.`;
  }

  const lines = result.items.map((item) => {
    const bucket =
      item.targetBucket === "labelKeyword" || item.targetBucket === "newLabel"
        ? `${item.targetBucket}${item.targetLabel ? `:${item.targetLabel}` : ""}`
        : item.targetBucket;
    const evidenceTitle = item.evidenceArticleTitles[0] ? `Source: ${item.evidenceArticleTitles[0]}` : "";
    const aliases = item.aliases.length > 0 ? `Aliases: ${item.aliases.join(" / ")}` : "";
    const breakout = item.breakoutCandidate ? "Breakout: yes" : "";
    const approvedAt = item.approvedAt ? `ApprovedAt: ${item.approvedAt}` : "";
    return [
      `- ${item.code} | ${item.candidateType} | ${item.displayValue}`,
      `  Target: ${bucket} | Confidence: ${item.confidence} | EvidenceCount: ${item.articleCount}`,
      `  Why: ${item.rationale}`,
      `  EvidenceSnippet: ${item.evidenceSnippet}`,
      evidenceTitle ? `  ${evidenceTitle}` : "",
      aliases ? `  ${aliases}` : "",
      approvedAt ? `  ${approvedAt}` : "",
      breakout ? `  ${breakout}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const headerFilter =
    result.dateFrom || result.dateTo
      ? `, ${result.dateField ?? "seen"}=${result.dateFrom ?? "..."}..${result.dateTo ?? "..."}`
      : "";
  return [`Learning candidates (status=${result.status}${headerFilter}, count=${result.items.length}):`, ...lines].join("\n");
}

function renderMutationResult(action: string, result: {
  applied: Array<{ code: string; candidateType: string; displayValue: string; status: string }>;
  missingCodes: string[];
}): string {
  const lines = [`${action} ${result.applied.length} candidate(s).`];
  if (result.applied.length > 0) {
    lines.push(
      ...result.applied.map((item) => `- ${item.code} | ${item.candidateType} | ${item.displayValue} | ${item.status}`),
    );
  }
  if (result.missingCodes.length > 0) {
    lines.push(`Missing: ${result.missingCodes.join(", ")}`);
  }
  return lines.join("\n");
}

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
    "Fetch full article content, extract images, and produce structured labels, summaries, and learning candidates.",
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
    "wechat_digest.run",
    "Run one full digest cycle deterministically: scan sources, analyze newly discovered articles, then build/send the digest for one target.",
    {
      date: z.string().optional(),
      targetId: z.string().optional(),
      dryRun: z.boolean().optional(),
      sourceIds: z.array(z.string()).optional(),
    },
    async ({ date, targetId, dryRun, sourceIds }) => {
      const scan = await service.scan({ sourceIds });
      const newArticleIds = scan.articles
        .filter((article) => article.status === "new")
        .map((article) => article.articleId);
      const analyzed = newArticleIds.length > 0 ? await service.analyze({ articleIds: newArticleIds }) : [];
      const digest = await service.buildDigest({ date, targetId, dryRun });
      const text =
        dryRun === false
          ? `Digest cycle complete: scanned=${scan.articles.length}, analyzed=${analyzed.length}, sent=${digest.sentCount}.`
          : `Digest cycle dry-run: scanned=${scan.articles.length}, analyzed=${analyzed.length}, messages=${digest.messages.length}.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          scan,
          analyzed,
          digest,
        },
      };
    },
  );

  server.tool(
    "wechat_digest.status",
    "Show today's scan/analyze/delivery status for the digest pipeline.",
    {
      date: z.string().optional(),
      targetId: z.string().optional(),
    },
    async ({ date, targetId }) => {
      const result = await service.status({ date, targetId });
      return {
        content: [
          {
            type: "text",
            text:
              `Status ${result.date}/${result.targetId}: discovered=${result.discovered}, ` +
              `analyzed=${result.analyzed}, delivered=${result.delivered}, ` +
              `queuedCandidates=${result.queuedCandidates}, pendingDelivery=${result.pendingDelivery}, ` +
              `latestDigestStatus=${result.latestDigestStatus}, pendingLearning=${result.pendingLearning}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_learning.followup",
    "Send the evening follow-up reminder for still-pending learning candidates.",
    {
      date: z.string().optional(),
      targetId: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async ({ date, targetId, dryRun }) => {
      const result = await service.sendLearningFollowup({ date, targetId, dryRun });
      return {
        content: [
          {
            type: "text",
            text:
              dryRun === false
                ? `Sent ${result.sentCount} learning follow-up message(s) for ${result.date}.`
                : `Prepared ${result.messages.length} learning follow-up message(s) for ${result.date}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_learning.pending",
    "Show pending or historical learning candidates that can be approved into the dynamic digest rules overlay.",
    {
      status: z.enum(["pending", "approved", "rejected", "snoozed", "all"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      date: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      dateField: z.enum(["seen", "approved", "prompted", "followup"]).optional(),
    },
    async ({ status, limit, date, dateFrom, dateTo, dateField }) => {
      const result = await service.pendingLearning({ status, limit, date, dateFrom, dateTo, dateField });
      return {
        content: [
          {
            type: "text",
            text: renderPendingItems(result),
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_learning.approve",
    "Approve one or more learning candidates and apply them into the dynamic rules overlay immediately.",
    {
      codes: z.array(z.string()).min(1),
    },
    async ({ codes }) => {
      const result = await service.approveLearning({ codes });
      return {
        content: [
          {
            type: "text",
            text: renderMutationResult("Approved", result),
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_learning.reject",
    "Reject one or more learning candidates and suppress repeated reminders for a while.",
    {
      codes: z.array(z.string()).min(1),
    },
    async ({ codes }) => {
      const result = await service.rejectLearning({ codes });
      return {
        content: [
          {
            type: "text",
            text: renderMutationResult("Rejected", result),
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_learning.snooze",
    "Snooze one or more learning candidates so the assistant can remind again later.",
    {
      codes: z.array(z.string()).min(1),
    },
    async ({ codes }) => {
      const result = await service.snoozeLearning({ codes });
      return {
        content: [
          {
            type: "text",
            text: renderMutationResult("Snoozed", result),
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "wechat_learning.revoke",
    "Revoke one or more previously approved learning candidates and remove them from the dynamic rules overlay.",
    {
      codes: z.array(z.string()).min(1),
    },
    async ({ codes }) => {
      const result = await service.revokeLearning({ codes });
      return {
        content: [
          {
            type: "text",
            text: renderMutationResult("Revoked", result),
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
