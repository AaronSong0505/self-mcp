import fs from "node:fs";
import path from "node:path";
import {
  BlueskySocialService,
  type BlueskyPreviewResult,
  type BlueskyPublishResult,
} from "../../bluesky-social-mcp/src/service.js";
import {
  XSocialService,
  type XPostPreviewResult,
  type XPublishResult,
  type XReplyResult,
} from "../../x-social-mcp/src/service.js";

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
  targetUrl: string;
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

export type DraftSection = {
  id: string;
  title: string;
  variants: DraftVariant[];
};

export type ReviewPacket = {
  item: OutboxItem;
  draftTitle: string;
  variants: DraftVariant[];
};

export type PublishedPostRecord = {
  id: string;
  channel: string;
  variant: string;
  publishedAt: string;
  publishedAtIso?: string;
  uri: string;
  targetUrl?: string;
  cid?: string;
  text: string;
};

export type AutopublishPlanResult =
  | {
      status: "out_of_window";
      reason: string;
    }
  | {
      status: "cooldown";
      reason: string;
      latestPublishedAt?: string;
      nextAllowedAt?: string;
    }
  | {
      status: "idle";
      reason: string;
    }
  | {
      status: "ready";
      item: OutboxItem;
      chosenVariant: string;
    };

export type ListOutboxParams = {
  status?: OutboxStatus | "all";
};

export type UpsertOutboxParams = {
  id: string;
  created?: string;
  targetChannel?: string;
  targetUrl?: string;
  audience?: string;
  intent?: string;
  source?: string;
  relatedDraft?: string;
  status?: OutboxStatus;
  approval?: string;
  delivery?: string;
  nextStep?: string;
};

export type CreateDraftItemParams = {
  id?: string;
  title: string;
  variants: DraftVariant[];
  intent: string;
  source: string;
  whyItMatters: string;
  audience?: string;
  targetChannel?: string;
  targetUrl?: string;
  approval?: string;
  nextStep?: string;
  status?: OutboxStatus;
  delivery?: string;
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
  "targetUrl",
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
  targetUrl: "Target URL",
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
    "- Target channel: X / Twitter / Bluesky / Aaron WeChat DM",
    "- Target URL: none / https://x.com/.../status/...",
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
  const pattern = new RegExp(`^- ${label}:[ \\t]*(.*)$`, "m");
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
      targetUrl: parseItemField(block, "Target URL"),
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
  const sections = new Map<string, DraftSection>();
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
    sections.set(id, { id, title, variants });
  }
  return sections;
}

function defaultDraftPreamble() {
  return [
    "# SOCIAL_DRAFTS.md",
    "",
    "Use this file for draft text only.",
    "",
    "Do not use this file as the send queue.",
    "",
    "Queue truth belongs in `OUTBOX.md`.",
    "",
    "## Rules",
    "",
    "- Keep drafts short, concrete, and easy to refine.",
    "- Prefer one complete draft over multiple fragments.",
    "- A draft should usually correspond to exactly one `OUTBOX.md` item ID.",
    "- If the same idea has multiple variants, keep them grouped under one draft section.",
    "- If a draft comes from digest or web research, note the source and why it matters.",
    "- If the wording is not yet clear enough to draft, keep the signal in `SOCIAL_OBSERVATIONS.md` instead.",
    "",
    "## Canonical Draft Format",
    "",
    "```md",
    "## OX-YYYYMMDD-01 - Short title",
    "",
    "- Target channel: X / Twitter",
    "- Source: digest / watchlist / social observation / direct request",
    "- Why it matters: one sentence",
    "",
    "### Draft A",
    "",
    "Actual wording here.",
    "",
    "### Draft B",
    "",
    "Optional alternate wording here.",
    "```",
    "",
    "## Current Draft Queue",
    "",
  ].join("\n");
}

function renderDraftSection(section: DraftSection) {
  const lines = [`## ${section.id} - ${section.title}`, ""];
  for (const variant of section.variants) {
    lines.push(`### Draft ${variant.label}`, "", variant.text, "");
  }
  return lines.join("\n").trimEnd();
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
    "- Primary public destination: `X / Twitter`",
    "- Secondary public destination: `Bluesky`",
    "- Current state: X is the preferred autonomous posting lane; Bluesky remains available as a secondary lane when the proxied path is healthy",
    "- Public-facing items should normally move through `scheduled`, then `sending`, then `sent` when the strongest healthy lane is available",
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

function nowIso() {
  return new Date().toISOString();
}

function parsePublishedAtLabelToIso(label: string) {
  const match = label.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) Asia\/Shanghai$/);
  if (!match) {
    return undefined;
  }
  return `${match[1]}T${match[2]}:${match[3]}:00+08:00`;
}

function getShanghaiHour(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false,
  });
  return Number(formatter.format(date));
}

export class SocialOutboxService {
  private readonly postsPath: string;
  private readonly blueskyService: Pick<BlueskySocialService, "previewPost" | "publishPost">;
  private readonly xService: Pick<XSocialService, "previewPost" | "publishPost" | "replyPost">;

  constructor(
    private readonly outboxPath: string,
    private readonly draftsPath: string,
    postsPathOrBlueskyService?: string | Pick<BlueskySocialService, "previewPost" | "publishPost">,
    maybeBlueskyService?: Pick<BlueskySocialService, "previewPost" | "publishPost">,
    maybeXService?: Pick<XSocialService, "previewPost" | "publishPost" | "replyPost">,
  ) {
    if (typeof postsPathOrBlueskyService === "string") {
      this.postsPath = postsPathOrBlueskyService;
      this.blueskyService = maybeBlueskyService ?? new BlueskySocialService();
      this.xService = maybeXService ?? new XSocialService();
    } else {
      this.postsPath = path.join(path.dirname(outboxPath), "SOCIAL_POSTS.md");
      this.blueskyService = postsPathOrBlueskyService ?? new BlueskySocialService();
      this.xService = new XSocialService();
    }
  }

  static createFromEnv() {
    const outboxPath =
      process.env.SOCIAL_OUTBOX_PATH ??
      path.join("D:/tools_work/one-company/openclaw/workspace", "OUTBOX.md");
    const draftsPath =
      process.env.SOCIAL_DRAFTS_PATH ??
      path.join("D:/tools_work/one-company/openclaw/workspace", "SOCIAL_DRAFTS.md");
    const postsPath =
      process.env.SOCIAL_POSTS_PATH ??
      path.join(path.dirname(outboxPath), "SOCIAL_POSTS.md");
    return new SocialOutboxService(outboxPath, draftsPath, postsPath);
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
      return new Map<string, DraftSection>();
    }
    return parseDraftSections(fs.readFileSync(this.draftsPath, "utf8"));
  }

  private writeDraftSections(sections: DraftSection[]) {
    fs.mkdirSync(path.dirname(this.draftsPath), { recursive: true });
    const ordered = [...sections].sort((a, b) => a.id.localeCompare(b.id));
    const body = ordered.map((section) => renderDraftSection(section)).join("\n\n");
    fs.writeFileSync(
      this.draftsPath,
      `${[defaultDraftPreamble(), body].filter(Boolean).join("\n").trimEnd()}\n`,
      "utf8",
    );
  }

  private readPublishedPosts(): PublishedPostRecord[] {
    if (!fs.existsSync(this.postsPath)) {
      return [];
    }
    const normalized = normalizeLineEndings(fs.readFileSync(this.postsPath, "utf8"));
    const regex = /^### (OX-\d{8}-\d+)\n([\s\S]*?)(?=^### |(?:\n)?(?![\s\S]))/gm;
    const records: PublishedPostRecord[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(normalized))) {
      const id = match[1]!;
      const block = match[2] ?? "";
      const textMarker = "- Text:\n";
      const textIndex = block.indexOf(textMarker);
      const text =
        textIndex >= 0
          ? block.slice(textIndex + textMarker.length).trim()
          : "";
      records.push({
        id,
        channel: parseItemField(block, "Channel"),
        variant: parseItemField(block, "Variant"),
        publishedAt: parseItemField(block, "Published at"),
        publishedAtIso:
          parseItemField(block, "Published at ISO") ||
          parsePublishedAtLabelToIso(parseItemField(block, "Published at")) ||
          undefined,
        uri: parseItemField(block, "URI"),
        targetUrl: parseItemField(block, "Target URL") || undefined,
        cid: parseItemField(block, "CID") || undefined,
        text,
      });
    }
    return records;
  }

  private writePublishedPosts(records: PublishedPostRecord[]) {
    fs.mkdirSync(path.dirname(this.postsPath), { recursive: true });
    const lines = [
      "# SOCIAL_POSTS.md",
      "",
      "This file is the append-only log of social posts that actually went out.",
      "",
      "Use it when Aaron asks what Xiaoxiong has already posted, not what is still in draft.",
      "",
    ];
    const ordered = [...records].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    for (const record of ordered) {
      lines.push(`### ${record.id}`, "");
      lines.push(`- Channel: ${record.channel}`);
      lines.push(`- Variant: ${record.variant}`);
      lines.push(`- Published at: ${record.publishedAt}`);
      lines.push(`- Published at ISO: ${record.publishedAtIso ?? parsePublishedAtLabelToIso(record.publishedAt) ?? ""}`);
      lines.push(`- URI: ${record.uri}`);
      lines.push(`- Target URL: ${record.targetUrl ?? ""}`);
      lines.push(`- CID: ${record.cid ?? ""}`);
      lines.push(`- Text:`);
      lines.push(record.text);
      lines.push("");
    }
    fs.writeFileSync(this.postsPath, `${lines.join("\n").trimEnd()}\n`, "utf8");
  }

  private appendPublishedPost(record: PublishedPostRecord) {
    const records = this.readPublishedPosts().filter((candidate) => candidate.id !== record.id);
    records.push(record);
    this.writePublishedPosts(records);
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

  listRecentPublished(limit = 5) {
    const records = this.readPublishedPosts()
      .sort((a, b) =>
        (b.publishedAtIso ?? b.publishedAt).localeCompare(a.publishedAtIso ?? a.publishedAt),
      )
      .slice(0, limit);
    return {
      postsPath: this.postsPath,
      items: records,
    };
  }

  hasScheduledItem(channelPattern: RegExp): boolean {
    return this.readItems().some((item) => item.status === "scheduled" && channelPattern.test(item.targetChannel));
  }

  hasScheduledBlueskyItem(): boolean {
    return this.hasScheduledItem(/bluesky/i);
  }

  getLatestCreatedAtForChannel(channelPattern: RegExp): string | undefined {
    return this.readItems()
      .filter((item) => channelPattern.test(item.targetChannel))
      .sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id))[0]?.created;
  }

  nextOutboxId(date = new Date()): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const datePart = formatter.format(date).replaceAll("-", "");
    const ids = [
      ...this.readItems().map((item) => item.id),
      ...this.readPublishedPosts().map((item) => item.id),
      ...this.readDraftSections().keys(),
    ];
    const used = ids
      .filter((id) => id.startsWith(`OX-${datePart}-`))
      .map((id) => Number(id.slice(-2)))
      .filter((value) => Number.isFinite(value));
    const next = (used.length ? Math.max(...used) : 0) + 1;
    return `OX-${datePart}-${String(next).padStart(2, "0")}`;
  }

  createDraftItem(params: CreateDraftItemParams): ReviewPacket {
    const id = params.id ?? this.nextOutboxId();
    const variants = params.variants
      .map((variant) => ({
        label: normalizeVariantLabel(variant.label),
        text: variant.text.trim(),
      }))
      .filter((variant) => Boolean(variant.text));
    if (!variants.length) {
      throw new Error("Cannot create an outbox draft item without at least one variant.");
    }

    const title = params.title.trim();
    const sections = this.readDraftSections();
    sections.set(id, {
      id,
      title,
      variants,
    });
    this.writeDraftSections([...sections.values()]);

    const item = this.upsertItem({
      id,
      targetChannel: params.targetChannel ?? "X / Twitter",
      targetUrl: params.targetUrl ?? "",
      audience: params.audience ?? "public",
      intent: params.intent.trim(),
      source: params.source.trim(),
      relatedDraft: `${id} - ${title}`,
      status: params.status ?? "draft",
      approval: params.approval ?? "not needed",
      delivery: params.delivery ?? "not started",
      nextStep:
        params.nextStep ??
        `decide whether ${title} should advance toward a real outbound action`,
    });

    return {
      item,
      draftTitle: title,
      variants,
    };
  }

  createScheduledDraft(params: {
    id?: string;
    title: string;
    variants: DraftVariant[];
    intent: string;
    source: string;
    whyItMatters: string;
      audience?: string;
      targetChannel?: string;
      targetUrl?: string;
      approval?: string;
      nextStep?: string;
  }): ReviewPacket {
    const packet = this.createDraftItem({
      id: params.id,
      title: params.title,
      variants: params.variants,
      intent: params.intent,
      source: params.source,
      whyItMatters: params.whyItMatters,
      audience: params.audience,
      targetChannel: params.targetChannel ?? "X / Twitter",
      targetUrl: params.targetUrl,
      status: "scheduled",
      approval: params.approval ?? "not needed",
      delivery: "scheduled for autonomous publish when cadence and network allow",
      nextStep:
        params.nextStep ??
        "publish the strongest variant automatically when the target lane is healthy and the cooldown window is clear",
    });

    return packet;
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

  async previewX(
    id: string,
    variant = "B",
  ): Promise<ReviewPacket & { chosenVariant: string; preview: XPostPreviewResult }> {
    const packet = this.getReviewPacket(id);
    const targetVariant = normalizeVariantLabel(variant);
    const chosen =
      packet.variants.find((candidate) => candidate.label === targetVariant) ?? packet.variants[0];
    if (!chosen) {
      throw new Error(`No draft variants found for ${id}.`);
    }
    const preview = this.xService.previewPost({
      text: chosen.text,
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
            delivery: `sent at ${nowLabel()} via Bluesky, uri \`${publish.uri}\`${publish.verified === true ? ", verified" : publish.verificationError ? `, verification failed: ${publish.verificationError}` : ""}`,
            nextStep:
              publish.verified === true
                ? "observe reception and let later posts build on verified delivery"
                : "observe reception carefully and re-check the public lane because post verification did not complete cleanly",
          });

      if (!params.dryRun) {
        this.appendPublishedPost({
          id: params.id,
          channel: "Bluesky",
          variant: chosen.label,
          publishedAt: nowLabel(),
          publishedAtIso: nowIso(),
          uri: publish.uri ?? "",
          cid: publish.cid,
          text: publish.text,
        });
      }

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

  async publishX(params: {
    id: string;
    variant?: string;
    approval?: string;
    dryRun?: boolean;
  }): Promise<ReviewPacket & { chosenVariant: string; publish: XPublishResult; outboxItem: OutboxItem }> {
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
        delivery: `publishing started at ${nowLabel()} via X / Twitter`,
        nextStep: `wait for publish result for Draft ${chosen.label}`,
      });
    }

    try {
      const publish = await this.xService.publishPost({
        text: chosen.text,
        dryRun: params.dryRun,
      });
      if (!params.dryRun && !publish.url) {
        throw new Error("X publish completed without a verifiable status URL.");
      }

      const outboxItem = params.dryRun
        ? this.readItems().find((candidate) => candidate.id === params.id)!
        : this.transitionItem({
            id: params.id,
            status: "sent",
            approval,
            delivery: `sent at ${nowLabel()} via X / Twitter, url \`${publish.url}\``,
            nextStep: "observe reception on X and let later posts build on actual discussion signals",
          });

      if (!params.dryRun) {
        this.appendPublishedPost({
          id: params.id,
          channel: "X / Twitter",
          variant: chosen.label,
          publishedAt: nowLabel(),
          publishedAtIso: nowIso(),
          uri: publish.url ?? "",
          targetUrl: publish.url,
          text: publish.text,
        });
      }

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
          delivery: `failed at ${nowLabel()} via X / Twitter: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "fix the X publish path, then retry from a reviewed or scheduled draft",
        });
      }
      throw error;
    }
  }

  async publishXReply(params: {
    id: string;
    variant?: string;
    approval?: string;
    dryRun?: boolean;
  }): Promise<ReviewPacket & { chosenVariant: string; publish: XReplyResult; outboxItem: OutboxItem }> {
    const packet = this.getReviewPacket(params.id);
    const targetVariant = normalizeVariantLabel(params.variant);
    const chosen =
      packet.variants.find((candidate) => candidate.label === targetVariant) ??
      packet.variants[0];
    if (!chosen) {
      throw new Error(`No draft variants found for ${params.id}.`);
    }
    if (!packet.item.targetUrl) {
      throw new Error(`OUTBOX item ${params.id} is missing Target URL for X reply publishing.`);
    }

    const approval = params.approval ?? `approved by Aaron at ${nowLabel()}`;

    if (!params.dryRun) {
      this.transitionItem({
        id: params.id,
        status: "sending",
        approval,
        delivery: `reply started at ${nowLabel()} via X / Twitter`,
        nextStep: `wait for reply result for Draft ${chosen.label}`,
      });
    }

    try {
      const publish = await this.xService.replyPost({
        url: packet.item.targetUrl,
        text: chosen.text,
        dryRun: params.dryRun,
      });
      if (!params.dryRun && !publish.url) {
        throw new Error("X reply completed without a verifiable reply URL.");
      }
      const verifiedReplyUrl = publish.url ?? "";

      const outboxItem = params.dryRun
        ? this.readItems().find((candidate) => candidate.id === params.id)!
        : this.transitionItem({
            id: params.id,
            status: "sent",
            approval,
            delivery: `sent at ${nowLabel()} via X / Twitter reply, url \`${verifiedReplyUrl}\`, parent \`${publish.parentUrl}\``,
            nextStep: "observe whether the reply actually contributes to the thread",
          });

      if (!params.dryRun) {
        this.appendPublishedPost({
          id: params.id,
          channel: "X Reply",
          variant: chosen.label,
          publishedAt: nowLabel(),
          publishedAtIso: nowIso(),
          uri: verifiedReplyUrl,
          targetUrl: publish.parentUrl,
          text: publish.text,
        });
      }

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
          delivery: `failed at ${nowLabel()} via X / Twitter reply: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "re-read the thread, fix the reply path, then retry if the reply still matters",
        });
      }
      throw error;
    }
  }

  private planNextAutonomousChannel(params: {
    channelPattern: RegExp;
    defaultVariant?: string;
    minHoursBetweenPosts?: number;
    startHour?: number;
    endHour?: number;
  }): AutopublishPlanResult {
    const defaultVariant = normalizeVariantLabel(params.defaultVariant);
    const minHoursBetweenPosts = params.minHoursBetweenPosts ?? 20;
    const startHour = params.startHour ?? 10;
    const endHour = params.endHour ?? 21;
    const currentHour = getShanghaiHour();

    if (currentHour < startHour || currentHour >= endHour) {
      return {
        status: "out_of_window",
        reason: `Current Asia/Shanghai hour ${currentHour} is outside the publish window ${startHour}:00-${endHour}:00.`,
      };
    }

    const latestPublished = this.readPublishedPosts()
      .filter((item) => params.channelPattern.test(item.channel))
      .sort((a, b) => (b.publishedAtIso ?? b.publishedAt).localeCompare(a.publishedAtIso ?? a.publishedAt))[0];
    if (latestPublished?.publishedAtIso) {
      const latestTimestamp = Date.parse(latestPublished.publishedAtIso);
      if (Number.isFinite(latestTimestamp)) {
        const hoursSinceLatest = (Date.now() - latestTimestamp) / (1000 * 60 * 60);
        if (hoursSinceLatest < minHoursBetweenPosts) {
          const nextAllowed = new Date(latestTimestamp + minHoursBetweenPosts * 60 * 60 * 1000);
          return {
            status: "cooldown",
            reason: `Latest post for this channel is still within the ${minHoursBetweenPosts}-hour cooldown.`,
            latestPublishedAt: latestPublished.publishedAt,
            nextAllowedAt: nextAllowed.toISOString(),
          };
        }
      }
    }

    const item = this.readItems()
      .filter(
        (candidate) =>
          candidate.status === "scheduled" &&
          params.channelPattern.test(candidate.targetChannel),
      )
      .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))[0];

    if (!item) {
      return {
        status: "idle",
        reason: "No scheduled items are ready for this channel.",
      };
    }

    return {
      status: "ready",
      item,
      chosenVariant: defaultVariant || "B",
    };
  }

  planNextAutonomousBluesky(params: {
    defaultVariant?: string;
    minHoursBetweenPosts?: number;
    startHour?: number;
    endHour?: number;
  } = {}): AutopublishPlanResult {
    return this.planNextAutonomousChannel({
      channelPattern: /bluesky/i,
      defaultVariant: params.defaultVariant,
      minHoursBetweenPosts: params.minHoursBetweenPosts,
      startHour: params.startHour,
      endHour: params.endHour,
    });
  }

  planNextAutonomousX(params: {
    defaultVariant?: string;
    minHoursBetweenPosts?: number;
    startHour?: number;
    endHour?: number;
  } = {}): AutopublishPlanResult {
    return this.planNextAutonomousChannel({
      channelPattern: /^X \/ Twitter$/i,
      defaultVariant: params.defaultVariant,
      minHoursBetweenPosts: params.minHoursBetweenPosts,
      startHour: params.startHour,
      endHour: params.endHour,
    });
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
      targetUrl: params.targetUrl ?? existing?.targetUrl ?? "",
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
