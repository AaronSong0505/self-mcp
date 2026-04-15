import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAutonomousCycle } from "../services/social-outbox-mcp/src/autonomous-cycle.js";
import { SocialOutboxService } from "../services/social-outbox-mcp/src/service.js";
import { XSocialService } from "../services/x-social-mcp/src/service.js";

const cleanupDirs: string[] = [];

function createTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-autonomous-"));
  cleanupDirs.push(root);
  fs.writeFileSync(
    path.join(root, "SOCIAL_OBSERVATIONS.md"),
    "# SOCIAL_OBSERVATIONS.md\n\n## Current Observations\n\n- One thread is worth a careful reply.\n",
    "utf8",
  );
  fs.writeFileSync(path.join(root, "SOCIAL_RULES.md"), "# SOCIAL_RULES.md\n", "utf8");
  fs.writeFileSync(path.join(root, "SOCIAL_POSTS.md"), "# SOCIAL_POSTS.md\n", "utf8");
  fs.writeFileSync(path.join(root, "SOCIAL_LESSONS.md"), "# SOCIAL_LESSONS.md\n", "utf8");
  fs.writeFileSync(path.join(root, "WATCHLIST.md"), "# WATCHLIST.md\n", "utf8");
  fs.writeFileSync(path.join(root, "WEEKLY_REVIEW.md"), "# WEEKLY_REVIEW.md\n", "utf8");
  return root;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("social autonomous cycle", () => {
  it("prioritizes a scheduled X reply before a scheduled X post", async () => {
    const root = createTempRoot();
    const outboxPath = path.join(root, "OUTBOX.md");
    const draftsPath = path.join(root, "SOCIAL_DRAFTS.md");
    const postsPath = path.join(root, "SOCIAL_POSTS.md");
    process.env.SOCIAL_OUTBOX_PATH = outboxPath;
    process.env.SELF_MCP_DISABLE_LLM = "1";

    fs.writeFileSync(
      draftsPath,
      `# SOCIAL_DRAFTS.md

## Current Draft Queue

## OX-20260415-01 - X reply

### Draft A

Reply A

### Draft B

Reply B

## OX-20260415-02 - X post

### Draft A

Post A

### Draft B

Post B
`,
      "utf8",
    );

    const mockBluesky = {
      async previewPost() {
        throw new Error("preview not expected");
      },
      async publishPost() {
        throw new Error("publish not expected");
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
          url: "https://x.com/test/status/post",
        };
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
          url: "https://x.com/test/status/reply",
          parentUrl: url,
        };
      },
    };

    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, mockBluesky, mockX as any);
    service.upsertItem({
      id: "OX-20260415-01",
      targetChannel: "X Reply",
      targetUrl: "https://x.com/example/status/123",
      audience: "public thread",
      intent: "reply to a thread",
      source: "x review",
      relatedDraft: "OX-20260415-01 - X reply",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "reply when cadence allows",
    });
    service.upsertItem({
      id: "OX-20260415-02",
      targetChannel: "X / Twitter",
      targetUrl: "",
      audience: "public",
      intent: "post a new thought",
      source: "watchlist",
      relatedDraft: "OX-20260415-02 - X post",
      status: "scheduled",
      approval: "not needed",
      delivery: "not started",
      nextStep: "post when cadence allows",
    });

    const originalStatus = XSocialService.prototype.status;
    const originalHomeFeed = XSocialService.prototype.homeFeed;
    const originalSearchPosts = XSocialService.prototype.searchPosts;
    XSocialService.prototype.status = async function () {
      return {
        enabled: true,
        reachable: true,
        authenticated: true,
        cdpUrl: "http://127.0.0.1:18800",
        activeChannelLabel: "X / Twitter",
        handle: "AaronSong98",
      };
    };
    XSocialService.prototype.homeFeed = async function () {
      return { source: "home", items: [] };
    };
    XSocialService.prototype.searchPosts = async function ({ q }: { q: string }) {
      return { source: `search:${q}`, items: [] };
    };

    try {
      const result = await runAutonomousCycle({
        dryRun: false,
        service,
        config: {
          enabled: true,
          startHour: 0,
          endHour: 24,
          minHoursBetweenPosts: 0,
          minHoursBetweenReplies: 0,
          defaultVariant: "B",
          primaryChannel: "X / Twitter",
          secondaryChannel: "Bluesky",
          autoDraft: {
            enabled: false,
            model: "qwen3.5-plus",
            minHoursBetweenDrafts: 8,
            maxChars: 240,
          },
        },
      });

      expect(result.status).toBe("published");
      if (result.status !== "published") {
        throw new Error(`Expected published result, got ${result.status}`);
      }
      expect(result.channel).toBe("X Reply");
      expect(result.id).toBe("OX-20260415-01");
      expect(service.listRecentPublished(1).items[0]?.channel).toBe("X Reply");
    } finally {
      XSocialService.prototype.status = originalStatus;
      XSocialService.prototype.homeFeed = originalHomeFeed;
      XSocialService.prototype.searchPosts = originalSearchPosts;
    }
  });
});
