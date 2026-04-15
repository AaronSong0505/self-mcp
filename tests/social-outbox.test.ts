import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SocialOutboxService } from "../services/social-outbox-mcp/src/service.js";

function createTempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-outbox-"));
  return {
    outboxPath: path.join(root, "OUTBOX.md"),
    draftsPath: path.join(root, "SOCIAL_DRAFTS.md"),
    postsPath: path.join(root, "SOCIAL_POSTS.md"),
  };
}

function writeDrafts(draftsPath: string) {
  fs.writeFileSync(
    draftsPath,
    `# SOCIAL_DRAFTS.md

## Current Draft Queue

## OX-20260410-01 - Reliability before noise

- Target channel: Bluesky
- Source: social observation / weekly review
- Why it matters: first public review item

### Draft A

Plain English draft.

### Draft B

如果一个 AI 说“我发出去了”，对方却没收到，那不是小 bug，而是信任断点。

### Draft C

Alternate draft.

## OX-20260414-01 - X post candidate

- Target channel: X / Twitter
- Source: x review / social observation
- Why it matters: a clean X-first candidate

### Draft A

在公开讨论里，先看清楚再表态，往往比抢第一句更重要。

### Draft B

很多时候，真正有价值的不是最早开口，而是读完整个 thread 之后还能补上一句别人没说到的话。

## OX-20260414-02 - X reply candidate

- Target channel: X Reply
- Source: x thread / reply judgment
- Why it matters: a deterministic reply candidate

### Draft A

这条我同意一半：趋势确实在变，但落地速度还得看真实交付，不只是 demo。

### Draft B

如果只看演示会高估速度，如果只看问题又会错过拐点。先把真实交付链路看清楚，再下判断。
`,
    "utf8",
  );
}

describe("social outbox service", () => {
  it("creates and lists a waiting review item", () => {
    const { outboxPath, draftsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const service = new SocialOutboxService(outboxPath, draftsPath);

    const item = service.upsertItem({
      id: "OX-20260410-01",
      targetChannel: "Aaron WeChat DM / Bluesky",
      audience: "owner review / public",
      intent: "review a short editorial take",
      source: "digest",
      relatedDraft: "OX-20260410-01 - Reliability before noise",
      status: "waiting_review",
      approval: "pending",
      delivery: "not started",
      nextStep: "show Aaron for review",
    });

    expect(item.status).toBe("waiting_review");

    const listed = service.listItems({ status: "waiting_review" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe("OX-20260410-01");
    expect(fs.readFileSync(outboxPath, "utf8")).toContain("### Waiting Review");
  });

  it("loads review packet variants from SOCIAL_DRAFTS.md", () => {
    const { outboxPath, draftsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const service = new SocialOutboxService(outboxPath, draftsPath);

    service.upsertItem({
      id: "OX-20260410-01",
      targetChannel: "Aaron WeChat DM / Bluesky",
      audience: "owner review / public",
      intent: "review a short editorial take",
      source: "digest",
      relatedDraft: "OX-20260410-01 - Reliability before noise",
      status: "waiting_review",
      approval: "pending",
      delivery: "not started",
      nextStep: "show Aaron for review",
    });

    const packet = service.getReviewPacket("OX-20260410-01");
    expect(packet.draftTitle).toBe("Reliability before noise");
    expect(packet.variants.map((variant) => variant.label)).toEqual(["A", "B", "C"]);
    expect(packet.variants[1]?.text).toContain("信任断点");
  });

  it("publishes a chosen draft variant through the deterministic Bluesky path", async () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const mockBluesky = {
      async previewPost() {
        throw new Error("previewPost should not be called here");
      },
      async publishPost() {
        return {
          text: "如果一个 AI 说“我发出去了”，对方却没收到，那不是小 bug，而是信任断点。",
          graphemeLength: 38,
          maxGraphemes: 300,
          fitsLimit: true,
          overLimitBy: 0,
          facetsCount: 0,
          langs: ["zh-Hans", "en"],
          activeChannelLabel: "Bluesky",
          reviewRequired: true,
          dryRun: false,
          published: true,
          handle: "qisongcareer.bsky.social",
          uri: "at://example/app.bsky.feed.post/test",
          cid: "cid123",
          verified: true,
          verificationTextMatches: true,
        };
      },
    };
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, mockBluesky);

    service.upsertItem({
      id: "OX-20260410-01",
      targetChannel: "Bluesky",
      audience: "public",
      intent: "review a short editorial take",
      source: "digest",
      relatedDraft: "OX-20260410-01 - Reliability before noise",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "publish when cadence allows",
    });

    const result = await service.publishBluesky({
      id: "OX-20260410-01",
      variant: "B",
      approval: "approved by Aaron",
      dryRun: false,
    });

    expect(result.chosenVariant).toBe("B");
    expect(result.publish.published).toBe(true);
    expect(result.outboxItem.status).toBe("sent");
    expect(result.outboxItem.delivery).toContain("verified");
    const posts = service.listRecentPublished(5);
    expect(posts.items).toHaveLength(1);
    expect(posts.items[0]?.channel).toBe("Bluesky");
    expect(posts.items[0]?.text).toContain("信任断点");
  });

  it("publishes an X draft through the deterministic X path", async () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const mockBluesky = {
      async previewPost() {
        throw new Error("previewPost should not be called here");
      },
      async publishPost() {
        throw new Error("publishPost should not be called here");
      },
    };
    const mockX = {
      previewPost({ text }: { text: string }) {
        return {
          text,
          length: text.length,
          maxLength: 280,
          fitsLimit: true,
          activeChannelLabel: "X / Twitter",
        };
      },
      async publishPost({ text }: { text: string }) {
        return {
          text,
          length: text.length,
          maxLength: 280,
          fitsLimit: true,
          activeChannelLabel: "X / Twitter",
          dryRun: false,
          published: true,
          url: "https://x.com/test/status/123",
        };
      },
      async replyPost() {
        throw new Error("replyPost should not be called here");
      },
    };
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, mockBluesky, mockX as any);

    service.upsertItem({
      id: "OX-20260414-01",
      targetChannel: "X / Twitter",
      audience: "public",
      intent: "publish an X-first observation",
      source: "x review",
      relatedDraft: "OX-20260414-01 - X post candidate",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "publish when cadence allows",
    });

    const result = await service.publishX({
      id: "OX-20260414-01",
      variant: "B",
      approval: "approved by Aaron",
      dryRun: false,
    });

    expect(result.publish.published).toBe(true);
    expect(result.publish.url).toBe("https://x.com/test/status/123");
    expect(result.outboxItem.status).toBe("sent");
    const posts = service.listRecentPublished(5);
    expect(posts.items[0]?.channel).toBe("X / Twitter");
    expect(posts.items[0]?.uri).toBe("https://x.com/test/status/123");
  });

  it("publishes an X reply through deterministic outbox flow", async () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const mockBluesky = {
      async previewPost() {
        throw new Error("previewPost should not be called here");
      },
      async publishPost() {
        throw new Error("publishPost should not be called here");
      },
    };
    const mockX = {
      previewPost({ text }: { text: string }) {
        return {
          text,
          length: text.length,
          maxLength: 280,
          fitsLimit: true,
          activeChannelLabel: "X / Twitter",
        };
      },
      async publishPost() {
        throw new Error("publishPost should not be called here");
      },
      async replyPost({ url, text }: { url: string; text: string }) {
        return {
          text,
          length: text.length,
          maxLength: 280,
          fitsLimit: true,
          activeChannelLabel: "X / Twitter",
          dryRun: false,
          published: true,
          url: "https://x.com/test/status/789",
          parentUrl: url,
        };
      },
    };
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, mockBluesky, mockX as any);

    service.upsertItem({
      id: "OX-20260414-02",
      targetChannel: "X Reply",
      targetUrl: "https://x.com/example/status/456",
      audience: "public thread",
      intent: "reply after reading the thread",
      source: "x thread",
      relatedDraft: "OX-20260414-02 - X reply candidate",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "reply if the thread still deserves an answer",
    });

    const result = await service.publishXReply({
      id: "OX-20260414-02",
      variant: "B",
      approval: "approved by Aaron",
      dryRun: false,
    });

    expect(result.publish.published).toBe(true);
    expect(result.publish.parentUrl).toBe("https://x.com/example/status/456");
    expect(result.publish.url).toBe("https://x.com/test/status/789");
    expect(result.outboxItem.status).toBe("sent");
    const posts = service.listRecentPublished(5);
    expect(posts.items[0]?.channel).toBe("X Reply");
    expect(posts.items[0]?.uri).toBe("https://x.com/test/status/789");
    expect(posts.items[0]?.targetUrl).toBe("https://x.com/example/status/456");
  });

  it("plans autonomous X publishing from scheduled items while respecting cooldown", () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath);

    service.upsertItem({
      id: "OX-20260414-01",
      targetChannel: "X / Twitter",
      audience: "public",
      intent: "publish autonomously to X",
      source: "watchlist",
      relatedDraft: "OX-20260414-01 - X post candidate",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "publish when cadence allows",
    });

    const plan = service.planNextAutonomousX({
      defaultVariant: "B",
      minHoursBetweenPosts: 8,
      startHour: 0,
      endHour: 24,
    });

    expect(plan.status).toBe("ready");
    if (plan.status === "ready") {
      expect(plan.item.id).toBe("OX-20260414-01");
      expect(plan.chosenVariant).toBe("B");
    }
  });

  it("plans autonomous X reply publishing from scheduled reply items", () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath);

    service.upsertItem({
      id: "OX-20260414-02",
      targetChannel: "X Reply",
      targetUrl: "https://x.com/example/status/456",
      audience: "public thread",
      intent: "reply autonomously to a thread",
      source: "x review",
      relatedDraft: "OX-20260414-02 - X reply candidate",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "reply when lane health and reply cadence allow",
    });

    const plan = service.planNextAutonomousXReply({
      defaultVariant: "B",
      minHoursBetweenReplies: 2,
      startHour: 0,
      endHour: 24,
    });

    expect(plan.status).toBe("ready");
    if (plan.status === "ready") {
      expect(plan.item.id).toBe("OX-20260414-02");
      expect(plan.item.targetChannel).toBe("X Reply");
      expect(plan.chosenVariant).toBe("B");
    }
  });
});
