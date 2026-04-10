import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SocialOutboxService } from "../services/social-outbox-mcp/src/service.js";

function createTempOutboxPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-outbox-"));
  return path.join(root, "OUTBOX.md");
}

describe("social outbox service", () => {
  it("creates and lists a waiting review item", () => {
    const outboxPath = createTempOutboxPath();
    const service = new SocialOutboxService(outboxPath);

    const item = service.upsertItem({
      id: "OX-20260410-01",
      targetChannel: "Aaron WeChat DM",
      audience: "owner review",
      intent: "review a short editorial take",
      source: "digest",
      relatedDraft: "OX-20260410-01 - Qwen note",
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

  it("transitions an item to sent", () => {
    const outboxPath = createTempOutboxPath();
    const service = new SocialOutboxService(outboxPath);

    service.upsertItem({
      id: "OX-20260410-02",
      targetChannel: "Bluesky",
      audience: "public",
      intent: "publish a short post",
      source: "watchlist",
      relatedDraft: "OX-20260410-02 - Bluesky post",
      status: "approved",
      approval: "approved by Aaron",
      delivery: "not started",
      nextStep: "publish when channel is active",
    });

    const item = service.transitionItem({
      id: "OX-20260410-02",
      status: "sent",
      delivery: "sent at 2026-04-10 10:30 Asia/Shanghai",
      nextStep: "archive later",
    });

    expect(item.status).toBe("sent");
    expect(item.delivery).toContain("sent at");
    const content = fs.readFileSync(outboxPath, "utf8");
    expect(content).toContain("### Recently Sent");
    expect(content).toContain("OX-20260410-02");
  });
});
