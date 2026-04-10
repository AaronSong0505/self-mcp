import fs from "node:fs";
import path from "node:path";
import {
  BlueskySocialService,
  type BlueskyPreviewResult,
  type BlueskyPublishResult,
} from "../../bluesky-social-mcp/src/service.js";

export const OUTBOX_STATUSES = [
  "draft",
  "waiting_review",
  "approved",
  "scheduled",
  "sending",
  "sent",
  "failed",
  "stale",
  "archived",
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export type OutboxItem = {
  id: string;
  created: string;
  targetChannel: string;
  audience: string;
  intent: string;
  source: string;
  relatedDraft: string;
  status: OutboxStatus;
  approval: string;
  delivery: string;
  nextStep: string;
};

export type DraftVariant = {
  label: string;
  text: string;
};

export type ReviewPacket = {
  item: OutboxItem;
  draftTitle: string;
  variants: DraftVariant[];
};

export type ListOutboxParams = {
  status?: OutboxStatus | "all";
};

export type UpsertOutboxParams = {
  id: string;
  created?: string;
  targetChannel?: string;
  audience?: string;
  intent?: string;
  source?: string;
  relatedDraft?: string;
  status?: OutboxStatus;
  approval?: string;
  delivery?: string;
  nextStep?: string;
};

export type TransitionOutboxParams = {
  id: string;
  status: OutboxStatus;
  approval?: string;
  delivery?: string;
  nextStep?: string;
};

const SECTION_ORDER: Array<{ title: string; statuses: OutboxStatus[] }> = [
  { title: "Drafts", statuses: ["draft"] },
  { title: "Waiting Review", statuses: ["waiting_review"] },
  { title: "Approved But Not Sent", statuses: ["approved"] },
  { title: "Sending Or Scheduled", statuses: ["scheduled", "sending"] },
  { title: "Recently Sent", statuses: ["sent"] },
  { title: "Failed Or Stale", statuses: ["failed", "stale"] },
  { title: "Archived", statuses: ["archived"] },
];

const FIELD_ORDER: Array<keyof OutboxItem> = [
  "created",
  "targetChannel",
  "audience",
  "intent",
  "source",
  "relatedDraft",
  "status",
  "approval",
  "delivery",
  "nextStep",
];

const FIELD_LABELS: Record<keyof OutboxItem, string> = {
  id: "Id",
  created: "Created",
  targetChannel: "Target channel",
  audience: "Audience",
  intent: "Intent",
  source: "Source",
  relatedDraft: "Related draft",
  status: "Status",
  approval: "Approval",
  delivery: "Delivery",
  nextStep: "Next step",
};

function defaultOutboxPreamble() {
  return [
    "# OUTBOX.md",
    "",
    "This file is the control plane for outward-facing messages that are not household relays.",
    "",
    "If something is meant to be shown to a human outside the current immediate reply, it should usually be represented here.",
    "",
    "Direct household relays between Aaron / Faye / Dad / Mom / Sister do not belong here. They use the deterministic relay tool and its own delivery ledger.",
    "",
    "## Purpose",
    "",
    "Use `OUTBOX.md` to track:",
    "",
    "- ideas waiting for Aaron's review",
    "- approved items waiting to be sent",
    "- items currently being sent through a real channel",
    "- items that were sent",
    "- items that failed, went stale, or were intentionally archived",
    "",
    "`OUTBOX.md` is not draft text storage.",
    "",
    "Draft text belongs in `SOCIAL_DRAFTS.md`.",
    "",
    "## Canonical Statuses",
    "",
    "- `draft`",
    "  - the idea exists, but it is not yet ready for review",
    "- `waiting_review`",
    "  - ready for Aaron to review in the private WeChat lane",
    "- `approved`",
    "  - approved in principle, but not yet sent or published",
    "- `scheduled`",
    "  - approved and waiting for a concrete send window or send command",
    "- `sending`",
    "  - the system has started delivery and is waiting for completion",
    "- `sent`",
    "  - actually delivered through the target channel",
    "- `failed`",
    "  - delivery or publishing failed",
    "- `stale`",
    "  - the content is no longer timely or the target lane became unavailable",
    "- `archived`",
    "  - intentionally closed and no longer active",
    "",
    "## Queue Rules",
    "",
    "- Nothing outward-facing should jump from `draft` to `sent`.",
    "- Public-facing items must be reviewed before they are approved.",
    "- Use `scheduled` only when there is a real expectation of later delivery.",
    "- Use `sending` only during a real send attempt.",
    "- Use `sent` only after actual channel delivery or explicit publish success.",
    "- If an item becomes outdated before it is sent, mark it `stale` instead of pretending it is still live.",
    "- If the send target is blocked by missing credentials or an inactive lane, use `failed` or `stale`, not `sent`.",
    "- Prefer one clear item per outward-facing message. Do not merge unrelated ideas into one queue entry.",
    "",
    "## Item Id Format",
    "",
    "Use stable item IDs:",
    "",
    "- `OX-YYYYMMDD-01`",
    "- `OX-YYYYMMDD-02`",
    "",
    "The ID should stay stable as the item moves through review, approval, sending, and archival.",
    "",
    "## Canonical Item Format",
    "",
    "Use this exact shape for real queue items:",
    "",
    "```md",
    "### OX-YYYYMMDD-01",
    "",
    "- Created: 2026-04-09 14:20 Asia/Shanghai",
    "- Target channel: Aaron WeChat DM / Bluesky",
    "- Audience: owner review / public",
    "- Intent: what this message is trying to do",
    "- Source: digest / watchlist / social observation / direct request",
    "- Related draft: SOCIAL_DRAFTS.md entry title or `none`",
    "- Status: waiting_review / approved / scheduled / sending / sent / failed / stale / archived",
    "- Approval: pending / approved by Aaron at 2026-04-09 14:30 / not needed",
    "- Delivery: not started / scheduled for 2026-04-09 18:40 / sent at 2026-04-09 18:42 / failed at 2026-04-09 18:43",
    "- Next step: what should happen next",
    "```",
    "",
    "## Queue Views",
    "",
  ].join("\n");
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function normalizeVariantLabel(value?: string) {
  return (value ?? "B").trim().replace(/^draft\s+/i, "").toUpperCase();
}

function parseItemField(block: string, label: string) {
  const pattern = new RegExp(`^- ${label}:\\s*(.*)$`, "m");
  return block.match(pattern)?.[1]?.trim() ?? "";
}

function ensureStatus(value: string): OutboxStatus {
  if ((OUTBOX_STATUSES as readonly string[]).includes(value)) {
    return value as OutboxStatus;
  }
  throw new Error(`Unsupported OUTBOX status: ${value}`);
}

function parseItems(content: string): OutboxItem[] {
  const normalized = normalizeLineEndings(content);
  const regex = /^### (OX-\d{8}-\d+)\n([\s\S]*?)(?=^### |(?![\s\S]))/gm;
  const items: OutboxItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized))) {
    const id = match[1];
    const block = match[2] ?? "";
    items.push({
      id,
      created: parseItemField(block, "Created"),
      targetChannel: parseItemField(block, "Target channel"),
      audience: parseItemField(block, "Audience"),
      intent: parseItemField(block, "Intent"),
      source: parseItemField(block, "Source"),
      relatedDraft: parseItemField(block, "Related draft"),
      status: ensureStatus(parseItemField(block, "Status")),
      approval: parseItemField(block, "Approval"),
      delivery: parseItemField(block, "Delivery"),
      nextStep: parseItemField(block, "Next step"),
    });
  }
  return items;
}

function parseDraftSections(content: string) {
  const normalized = normalizeLineEndings(content);
  const regex = /^## (OX-\d{8}-\d+) - (.+)\n([\s\S]*?)(?=^## OX-|(?:\n)?(?![\s\S]))/gm;
  const sections = new Map<string, { title: string; variants: DraftVariant[] }>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized))) {
    const id = match[1]!;
    const title = match[2]!.trim();
    const block = match[3] ?? "";
    const variants: DraftVariant[] = [];
    const variantRegex = /^### Draft ([A-Z])\n([\s\S]*?)(?=^### Draft [A-Z]|(?:\n)?(?![\s\S]))/gm;
    let variantMatch: RegExpExecArray | null;
    while ((variantMatch = variantRegex.exec(block))) {
      const label = variantMatch[1]!.trim();
      const text = (variantMatch[2] ?? "").trim();
      if (text) {
        variants.push({ label, text });
      }
    }
    sections.set(id, { title, variants });
  }
  return sections;
}

function renderItem(item: OutboxItem) {
  const lines = [`### ${item.id}`, ""];
  for (const field of FIELD_ORDER) {
    lines.push(`- ${FIELD_LABELS[field]}: ${item[field]}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSection(title: string, items: OutboxItem[]) {
  const lines = [`### ${title}`, ""];
  if (items.length === 0) {
    lines.push("- None yet.", "");
    return lines.join("\n");
  }
  for (const item of items) {
    lines.push(renderItem(item));
  }
  return lines.join("\n");
}

function renderOutbox(items: OutboxItem[]) {
  const sections = SECTION_ORDER.map(({ title, statuses }) =>
    renderSection(
      title,
      items
        .filter((item) => statuses.includes(item.status))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );

  return [
    defaultOutboxPreamble(),
    ...sections,
    "## Operational Discipline",
    "",
    "- `SOCIAL_OBSERVATIONS.md` is for raw or early-stage signals.",
    "- `SOCIAL_DRAFTS.md` is for actual message wording.",
    "- `OUTBOX.md` is for queue state and delivery truth.",
    "- If asked \"what is ready to review?\" check `Waiting Review`.",
    "- If asked \"what is approved but not live?\" check `Approved But Not Sent`.",
    "- If asked \"what already went out?\" check `Recently Sent`.",
    "- If asked \"what is blocked?\" check `Failed Or Stale`.",
    "",
    "## Current Public Social Path",
    "",
    "- First public destination: `Bluesky`",
    "- Current state: active in review-gated mode; live publishing depends on Aaron approval and an active Kylin proxy path",
    "- Public-facing items should still stop at `waiting_review` or `approved` unless they are explicitly approved for live publish",
    "",
  ].join("\n");
}

function nowLabel() {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatter.format(new Date()).replace(" ", " ")} Asia/Shanghai`;
}

export class SocialOutboxService {
  constructor(
    private readonly outboxPath: string,
    private readonly draftsPath: string,
    private readonly blueskyService: Pick<BlueskySocialService, "previewPost" | "publishPost"> = new BlueskySocialService(),
  ) {}

  static createFromEnv() {
    const outboxPath =
      process.env.SOCIAL_OUTBOX_PATH ??
      path.join("D:/tools_work/one-company/openclaw/workspace", "OUTBOX.md");
    const draftsPath =
      process.env.SOCIAL_DRAFTS_PATH ??
      path.join("D:/tools_work/one-company/openclaw/workspace", "SOCIAL_DRAFTS.md");
    return new SocialOutboxService(outboxPath, draftsPath);
  }

  private readItems() {
    if (!fs.existsSync(this.outboxPath)) {
      return [] as OutboxItem[];
    }
    return parseItems(fs.readFileSync(this.outboxPath, "utf8"));
  }

  private writeItems(items: OutboxItem[]) {
    fs.mkdirSync(path.dirname(this.outboxPath), { recursive: true });
    fs.writeFileSync(this.outboxPath, renderOutbox(items), "utf8");
  }

  private readDraftSections() {
    if (!fs.existsSync(this.draftsPath)) {
      return new Map<string, { title: string; variants: DraftVariant[] }>();
    }
    return parseDraftSections(fs.readFileSync(this.draftsPath, "utf8"));
  }

  listItems(params: ListOutboxParams = {}) {
    const status = params.status ?? "all";
    const items = this.readItems();
    return {
      outboxPath: this.outboxPath,
      items:
        status === "all"
          ? items
          : items.filter((item) => item.status === status),
    };
  }

  getReviewPacket(id: string): ReviewPacket {
    const item = this.readItems().find((candidate) => candidate.id === id);
    if (!item) {
      throw new Error(`OUTBOX item not found: ${id}`);
    }
    const section = this.readDraftSections().get(id);
    if (!section) {
      throw new Error(`Draft section not found for OUTBOX item: ${id}`);
    }
    return {
      item,
      draftTitle: section.title,
      variants: section.variants,
    };
  }

  async previewBluesky(
    id: string,
    variant = "B",
  ): Promise<ReviewPacket & { chosenVariant: string; preview: BlueskyPreviewResult }> {
    const packet = this.getReviewPacket(id);
    const targetVariant = normalizeVariantLabel(variant);
    const chosen =
      packet.variants.find((candidate) => candidate.label === targetVariant) ?? packet.variants[0];
    if (!chosen) {
      throw new Error(`No draft variants found for ${id}.`);
    }
    const preview = await this.blueskyService.previewPost({
      text: chosen.text,
      langs: ["zh-Hans", "en"],
      sourceContext: `${id}:Draft${chosen.label}`,
    });
    return {
      ...packet,
      chosenVariant: chosen.label,
      preview,
    };
  }

  async publishBluesky(params: {
    id: string;
    variant?: string;
    approval?: string;
    dryRun?: boolean;
  }): Promise<ReviewPacket & { chosenVariant: string; publish: BlueskyPublishResult; outboxItem: OutboxItem }> {
    const packet = this.getReviewPacket(params.id);
    const targetVariant = normalizeVariantLabel(params.variant);
    const chosen =
      packet.variants.find((candidate) => candidate.label === targetVariant) ??
      packet.variants[0];
    if (!chosen) {
      throw new Error(`No draft variants found for ${params.id}.`);
    }

    const approval = params.approval ?? `approved by Aaron at ${nowLabel()}`;

    if (!params.dryRun) {
      this.transitionItem({
        id: params.id,
        status: "sending",
        approval,
        delivery: `publishing started at ${nowLabel()} via Bluesky`,
        nextStep: `wait for publish result for Draft ${chosen.label}`,
      });
    }

    try {
      const publish = await this.blueskyService.publishPost({
        text: chosen.text,
        langs: ["zh-Hans", "en"],
        sourceContext: `${params.id}:Draft${chosen.label}`,
        dryRun: params.dryRun,
      });

      const outboxItem = params.dryRun
        ? this.readItems().find((candidate) => candidate.id === params.id)!
        : this.transitionItem({
            id: params.id,
            status: "sent",
            approval,
            delivery: `sent at ${nowLabel()} via Bluesky, uri \`${publish.uri}\``,
            nextStep: "observe reception and draft the next review item when a stronger signal appears",
          });

      return {
        ...packet,
        chosenVariant: chosen.label,
        publish,
        outboxItem,
      };
    } catch (error) {
      if (!params.dryRun) {
        this.transitionItem({
          id: params.id,
          status: "failed",
          approval,
          delivery: `failed at ${nowLabel()} via Bluesky: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "fix the publish path, then retry from a reviewed draft",
        });
      }
      throw error;
    }
  }

  upsertItem(params: UpsertOutboxParams) {
    const items = this.readItems();
    const index = items.findIndex((item) => item.id === params.id);
    const existing = index >= 0 ? items[index] : undefined;
    const created = params.created ?? existing?.created ?? nowLabel();
    const merged: OutboxItem = {
      id: params.id,
      created,
      targetChannel: params.targetChannel ?? existing?.targetChannel ?? "",
      audience: params.audience ?? existing?.audience ?? "",
      intent: params.intent ?? existing?.intent ?? "",
      source: params.source ?? existing?.source ?? "",
      relatedDraft: params.relatedDraft ?? existing?.relatedDraft ?? "none",
      status: params.status ?? existing?.status ?? "draft",
      approval: params.approval ?? existing?.approval ?? "pending",
      delivery: params.delivery ?? existing?.delivery ?? "not started",
      nextStep: params.nextStep ?? existing?.nextStep ?? "",
    };
    if (!merged.targetChannel || !merged.audience || !merged.intent || !merged.source || !merged.nextStep) {
      throw new Error("OUTBOX item is missing one or more required fields.");
    }
    if (index >= 0) {
      items[index] = merged;
    } else {
      items.push(merged);
    }
    this.writeItems(items);
    return merged;
  }

  transitionItem(params: TransitionOutboxParams) {
    const items = this.readItems();
    const index = items.findIndex((item) => item.id === params.id);
    if (index < 0) {
      throw new Error(`OUTBOX item not found: ${params.id}`);
    }
    const updated: OutboxItem = {
      ...items[index]!,
      status: params.status,
      approval: params.approval ?? items[index]!.approval,
      delivery: params.delivery ?? items[index]!.delivery,
      nextStep: params.nextStep ?? items[index]!.nextStep,
    };
    items[index] = updated;
    this.writeItems(items);
    return updated;
  }
}
