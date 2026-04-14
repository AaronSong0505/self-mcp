import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SocialOutboxService } from "../services/social-outbox-mcp/src/service.js";
import { runXReviewCycle } from "../services/social-outbox-mcp/src/x-cycle.js";

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
    expect(fs.readFileSync(path.join(root, "SOCIAL_OBSERVATIONS.md"), "utf8")).toContain("X review");
    expect(fs.readFileSync(path.join(root, "SOCIAL_LESSONS.md"), "utf8")).toContain("reading the thread before reacting matters");
  });
});
