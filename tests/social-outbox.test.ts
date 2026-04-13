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

- Target channel: Aaron WeChat DM / Bluesky
- Source: social observation / weekly review
- Why it matters: first public review item

### Draft A

Plain English draft.

### Draft B

如果一个 AI 说“我发出去了”，对方却没收到，那不是小 bug，而是信任断点。

### Draft C

Alternate draft.
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

  it("publishes a chosen draft variant through the deterministic UTF-8 path", async () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const mockBluesky = {
      async previewPost() {
        throw new Error("previewPost should not be called here");
      },
      async publishPost() {
        return {
          text: "如果一个 AI 说“我发出去了”，对方却没收到，那不是小 bug，而是信任断点。",
          graphemeLength: 36,
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
        };
      },
    };
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, mockBluesky);

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

    const result = await service.publishBluesky({
      id: "OX-20260410-01",
      variant: "B",
      approval: "approved by Aaron",
      dryRun: false,
    });

    expect(result.chosenVariant).toBe("B");
    expect(result.publish.published).toBe(true);
    expect(result.outboxItem.status).toBe("sent");
    expect(result.outboxItem.delivery).toContain("at://example/app.bsky.feed.post/test");
    expect(fs.readFileSync(outboxPath, "utf8")).toContain("### Recently Sent");
    const posts = service.listRecentPublished(5);
    expect(posts.items).toHaveLength(1);
    expect(posts.items[0]?.id).toBe("OX-20260410-01");
    expect(posts.items[0]?.text).toContain("信任断点");
  });

  it("plans autonomous Bluesky publishing from scheduled items while respecting cooldown", () => {
    const { outboxPath, draftsPath, postsPath } = createTempPaths();
    writeDrafts(draftsPath);
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath);

    service.upsertItem({
      id: "OX-20260410-01",
      targetChannel: "Bluesky",
      audience: "public",
      intent: "publish autonomously",
      source: "watchlist",
      relatedDraft: "OX-20260410-01 - Reliability before noise",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "publish when cadence allows",
    });

    const plan = service.planNextAutonomousBluesky({
      defaultVariant: "B",
      minHoursBetweenPosts: 20,
      startHour: 0,
      endHour: 24,
    });
    expect(plan.status).toBe("ready");
    if (plan.status === "ready") {
      expect(plan.item.id).toBe("OX-20260410-01");
      expect(plan.chosenVariant).toBe("B");
    }
  });
});
