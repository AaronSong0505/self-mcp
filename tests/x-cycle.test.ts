import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SocialOutboxService } from "../services/social-outbox-mcp/src/service.js";
import {
  inferPreferredXPublicLanguage,
  runXReviewCycle,
} from "../services/social-outbox-mcp/src/x-cycle.js";

const cleanupDirs: string[] = [];
const originalEnv = { ...process.env };

function createWorkspaceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-cycle-"));
  cleanupDirs.push(root);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "SOCIAL_OBSERVATIONS.md"),
    `# SOCIAL_OBSERVATIONS.md

## Current Observations

- Existing observation.
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "SOCIAL_LESSONS.md"),
    `# SOCIAL_LESSONS.md

## Current Lessons

- Existing lesson.
`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "SOCIAL_RULES.md"), "# SOCIAL_RULES.md\n", "utf8");
  fs.writeFileSync(path.join(root, "SOCIAL_POSTS.md"), "# SOCIAL_POSTS.md\n", "utf8");
  fs.writeFileSync(path.join(root, "WATCHLIST.md"), "# WATCHLIST.md\n", "utf8");
  return root;
}

afterEach(() => {
  process.env = { ...originalEnv };
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("x review cycle", () => {
  it("defaults X public language to English unless the discussion is clearly Chinese", () => {
    const english = inferPreferredXPublicLanguage({
      home: {
        source: "home",
        items: [
          {
            url: "https://x.com/test/status/1",
            authorHandle: "test",
            timeIso: "2026-04-14T08:00:00.000Z",
            text: "OpenAI keeps talking about agents and practical deployment.",
          },
        ],
      },
      mentions: { source: "mentions", items: [] },
      notifications: { source: "notifications", items: [] },
      searches: [
        {
          topic: "agent",
          result: {
            source: "search:agent",
            items: [
              {
                url: "https://x.com/test/status/2",
                authorHandle: "searcher",
                timeIso: "2026-04-14T08:05:00.000Z",
                text: "Reliable agent systems are still harder than demos.",
              },
            ],
          },
        },
      ],
    });

    const chinese = inferPreferredXPublicLanguage({
      home: {
        source: "home",
        items: [
          {
            url: "https://x.com/test/status/3",
            authorHandle: "test",
            timeIso: "2026-04-14T09:00:00.000Z",
            text: "这条讨论主要在聊智能体真实落地，而不是演示效果。",
          },
        ],
      },
      mentions: {
        source: "mentions",
        items: [
          {
            url: "https://x.com/test/status/4",
            authorHandle: "mentioner",
            timeIso: "2026-04-14T09:02:00.000Z",
            text: "@BlueBear 你怎么看这种强化学习落地路径？",
          },
        ],
      },
      notifications: { source: "notifications", items: [] },
      searches: [
        {
          topic: "强化学习",
          result: {
            source: "search:强化学习",
            items: [
              {
                url: "https://x.com/test/status/5",
                authorHandle: "searcher",
                timeIso: "2026-04-14T09:05:00.000Z",
                text: "如果没有真实交付链路，再漂亮的 demo 也不够。",
              },
            ],
          },
        },
      ],
    });

    expect(english).toBe("English");
    expect(chinese).toBe("Chinese");
  });

  it("records observations and lessons from a deterministic X review pass", async () => {
    const root = createWorkspaceRoot();
    const outboxPath = path.join(root, "OUTBOX.md");
    const draftsPath = path.join(root, "SOCIAL_DRAFTS.md");
    const postsPath = path.join(root, "SOCIAL_POSTS.md");
    process.env.X_SOCIAL_ROOT = root;
    process.env.X_SOCIAL_CONFIG_DIR = path.join(root, "config");
    process.env.X_SOCIAL_DATA_DIR = path.join(root, "data");
    process.env.SOCIAL_OUTBOX_PATH = outboxPath;
    process.env.SELF_MCP_DISABLE_LLM = "1";

    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, {
      async previewPost() {
        throw new Error("preview not expected");
      },
      async publishPost() {
        throw new Error("publish not expected");
      },
    });

    const xService = {
      async status() {
        return {
          enabled: true,
          reachable: true,
          authenticated: true,
          cdpUrl: "http://127.0.0.1:18800",
          activeChannelLabel: "X / Twitter",
          handle: "AaronSong98",
        };
      },
      async homeFeed() {
        return {
          source: "home",
          items: [
            {
              url: "https://x.com/test/status/1",
              authorHandle: "test",
              timeIso: "2026-04-14T08:00:00.000Z",
              text: "OpenAI keeps talking about agents and practical deployment.",
            },
          ],
        };
      },
      async mentionsFeed() {
        return {
          source: "mentions",
          items: [],
        };
      },
      async notificationsFeed() {
        return {
          source: "notifications",
          items: [],
        };
      },
      async searchPosts({ q }: { q: string }) {
        return {
          source: `search:${q}`,
          items: [
            {
              url: `https://x.com/test/status/${q.length}`,
              authorHandle: "searcher",
              timeIso: "2026-04-14T08:05:00.000Z",
              text: `${q} discussion keeps recurring in the feed.`,
            },
          ],
        };
      },
    };

    const result = await runXReviewCycle({
      dryRun: false,
      service,
      xService: xService as any,
    });

    expect(result.status).toBe("reviewed");
    if (result.status !== "reviewed") {
      throw new Error(`Expected reviewed result, got ${result.status}`);
    }
    expect(result.observationLines.length).toBeGreaterThan(0);
    expect(result.mentionsCount).toBe(0);
    expect(result.notificationsCount).toBe(0);
    expect(fs.readFileSync(path.join(root, "SOCIAL_OBSERVATIONS.md"), "utf8")).toContain("X review");
    expect(fs.readFileSync(path.join(root, "SOCIAL_LESSONS.md"), "utf8")).toContain(
      "reading the thread before reacting matters",
    );
  });

  it("creates a scheduled X reply item when the review loop decides a thread deserves an answer", async () => {
    const root = createWorkspaceRoot();
    const outboxPath = path.join(root, "OUTBOX.md");
    const draftsPath = path.join(root, "SOCIAL_DRAFTS.md");
    const postsPath = path.join(root, "SOCIAL_POSTS.md");
    process.env.X_SOCIAL_ROOT = root;
    process.env.X_SOCIAL_CONFIG_DIR = path.join(root, "config");
    process.env.X_SOCIAL_DATA_DIR = path.join(root, "data");
    process.env.SOCIAL_OUTBOX_PATH = outboxPath;
    process.env.SELF_MCP_DISABLE_LLM = "1";

    const service = new SocialOutboxService(outboxPath, draftsPath, postsPath, {
      async previewPost() {
        throw new Error("preview not expected");
      },
      async publishPost() {
        throw new Error("publish not expected");
      },
    });

    const xService = {
      async status() {
        return {
          enabled: true,
          reachable: true,
          authenticated: true,
          cdpUrl: "http://127.0.0.1:18800",
          activeChannelLabel: "X / Twitter",
          handle: "AaronSong98",
        };
      },
      async homeFeed() {
        return { source: "home", items: [] };
      },
      async mentionsFeed() {
        return {
          source: "mentions",
          items: [
            {
              url: "https://x.com/someone/status/1234567890",
              authorHandle: "someone",
              timeIso: "2026-04-14T08:09:00.000Z",
              text: "@BlueBear this agent reliability take needs a clearer answer.",
            },
          ],
        };
      },
      async notificationsFeed() {
        return { source: "notifications", items: [] };
      },
      async searchPosts() {
        return { source: "search:test", items: [] };
      },
    };

    const result = await runXReviewCycle({
      dryRun: false,
      service,
      xService: xService as any,
      analysisOverride: {
        observationLines: ["A thread deserves a careful answer."],
        lesson: "A good reply should narrow the argument, not widen it.",
        action: "draft_reply",
        draftTargetUrl: "https://x.com/someone/status/1234567890",
        draft: {
          title: "Thread reply candidate",
          intent: "answer one thread with a grounded clarification",
          source: "x review",
          whyItMatters: "the thread is close to something useful but still fuzzy",
          variants: [
            { label: "A", text: "I agree with half of this; the missing piece is still the delivery chain." },
            {
              label: "B",
              text: "The missing sentence here is simple: inspect the real delivery chain before calling the system reliable.",
            },
          ],
        },
      },
    });

    expect(result.status).toBe("reviewed");
    if (result.status !== "reviewed") {
      throw new Error(`Expected reviewed result, got ${result.status}`);
    }
    expect(result.draftAction).toBe("draft_reply");
    expect(result.mentionsCount).toBe(1);
    const outbox = fs.readFileSync(outboxPath, "utf8");
    expect(outbox).toContain("Target channel: X Reply");
    expect(outbox).toContain("Target URL: https://x.com/someone/status/1234567890");
    expect(outbox).toContain("Status: scheduled");
  });
});
