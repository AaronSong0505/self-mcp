import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAutonomousDraft } from "../services/social-outbox-mcp/src/autodraft.js";
import { SocialOutboxService } from "../services/social-outbox-mcp/src/service.js";

function createWorkspaceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-autodraft-"));
  fs.writeFileSync(
    path.join(root, "SOCIAL_OBSERVATIONS.md"),
    `# SOCIAL_OBSERVATIONS.md

- Repeated weak signals are often more useful than one loud launch.
- Reliability is part of social credibility.
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "WATCHLIST.md"),
    `# WATCHLIST.md

- agent systems
- reinforcement learning
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "WEEKLY_REVIEW.md"),
    `# WEEKLY_REVIEW.md

- Reliability matters more than performative aliveness.
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "SOCIAL_RULES.md"),
    `# SOCIAL_RULES.md

- Public posting is autonomous by default.
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "SOCIAL_POSTS.md"),
    `# SOCIAL_POSTS.md
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "SOCIAL_LESSONS.md"),
    `# SOCIAL_LESSONS.md

- One clear point is better than five vague ones.
`,
    "utf8",
  );
  return root;
}

describe("social autodraft", () => {
  it("creates a scheduled autonomous Bluesky draft when none exists", async () => {
    const root = createWorkspaceRoot();
    const outboxPath = path.join(root, "OUTBOX.md");
    const draftsPath = path.join(root, "SOCIAL_DRAFTS.md");
    const postsPath = path.join(root, "SOCIAL_POSTS.md");
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, {
      async previewPost() {
        throw new Error("preview not expected");
      },
      async publishPost() {
        throw new Error("publish not expected");
      },
    });

    const result = await ensureAutonomousDraft({
      service,
      workspaceRoot: root,
      config: {
        enabled: true,
        model: "qwen3.5-plus",
        minHoursBetweenDrafts: 16,
        maxChars: 240,
      },
    });

    expect(result.status).toBe("created");
    expect(fs.readFileSync(draftsPath, "utf8")).toContain("## OX-");
    expect(fs.readFileSync(outboxPath, "utf8")).toContain("Status: scheduled");
    expect(service.hasScheduledBlueskyItem()).toBe(true);
  });

  it("skips autodraft when a scheduled Bluesky item already exists", async () => {
    const root = createWorkspaceRoot();
    const outboxPath = path.join(root, "OUTBOX.md");
    const draftsPath = path.join(root, "SOCIAL_DRAFTS.md");
    const postsPath = path.join(root, "SOCIAL_POSTS.md");
    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, {
      async previewPost() {
        throw new Error("preview not expected");
      },
      async publishPost() {
        throw new Error("publish not expected");
      },
    });

    service.createScheduledDraft({
      id: "OX-20260413-01",
      title: "Existing scheduled item",
      variants: [{ label: "B", text: "Already scheduled." }],
      intent: "hold one scheduled social item",
      source: "watchlist",
      whyItMatters: "avoid queue duplication",
    });

    const result = await ensureAutonomousDraft({
      service,
      workspaceRoot: root,
      config: {
        enabled: true,
        model: "qwen3.5-plus",
        minHoursBetweenDrafts: 16,
        maxChars: 240,
      },
    });

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") {
      throw new Error(`Expected skipped autodraft result, got ${result.status}`);
    }
    expect(result.reason).toContain("scheduled Bluesky item already exists");
  });
});
