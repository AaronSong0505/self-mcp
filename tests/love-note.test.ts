import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "../packages/core/src/db.js";
import { WechatLoveNoteService } from "../services/wechat-love-note/src/service.js";

const cleanupDirs: string[] = [];

function createTempRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-mcp-love-note-"));
  cleanupDirs.push(root);
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const openclawRoot = path.join(root, "openclaw");
  const workspaceRoot = path.join(openclawRoot, "workspace");
  const sessionsRoot = path.join(openclawRoot, ".openclaw-state", "agents", "main", "sessions");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(openclawRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "memory"), { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(path.join(openclawRoot, "scripts", "openclaw.ps1"), "# mock", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "MEMORY.md"), "Aaron and Faye are a warm household.", "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "RELATIONSHIPS.md"),
    "Faye is the family co-owner. When she is vulnerable, use gentleness over analysis and avoid generic comfort.",
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "USER.md"), "Aaron and Faye live in Shanghai.", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "memory", "2026-04-03.md"), "- Aaron and Faye are having a busy day.\n", "utf8");
  fs.writeFileSync(
    path.join(sessionsRoot, "sessions.json"),
    JSON.stringify(
      {
        "agent:main:openclaw-weixin:sample-account:direct:sample-faye@im.wechat": {
          origin: {
            provider: "openclaw-weixin",
            chatType: "direct",
            accountId: "sample-account",
            to: "sample-faye@im.wechat",
          },
          updatedAt: Date.now() - 60 * 60 * 1000,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "wechat_digest_rules.yaml"),
    `deliveryTargets:
  faye-wechat:
    channel: openclaw-weixin
    accountId: sample-account
    to: sample-faye@im.wechat
`,
    "utf8",
  );
  fs.writeFileSync(path.join(configDir, "wechat_sources.yaml"), "sources: []\n", "utf8");
  fs.writeFileSync(
    path.join(configDir, "wechat_love_note.yaml"),
    `enabled: true
targetId: faye-wechat
model: qwen3.5-plus
randomWindow:
  start: "10:00"
  end: "21:00"
style:
  senderName: Xiaoxiong
  ownerName: Aaron
  recipientName: Faye
  maxChars: 140
maxRecipientStalenessHours: 48
`,
    "utf8",
  );
  return { root, configDir, dataDir, openclawRoot };
}

afterEach(() => {
  delete process.env.WECHAT_DIGEST_ROOT;
  delete process.env.WECHAT_DIGEST_CONFIG_DIR;
  delete process.env.WECHAT_DIGEST_DATA_DIR;
  delete process.env.OPENCLAW_CLI_WRAPPER;
  delete process.env.DASHSCOPE_API_KEY;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("wechat love note service", () => {
  it("builds a dry-run love note preview for Faye", async () => {
    const { root, configDir, dataDir, openclawRoot } = createTempRoots();
    process.env.WECHAT_DIGEST_ROOT = root;
    process.env.WECHAT_DIGEST_CONFIG_DIR = configDir;
    process.env.WECHAT_DIGEST_DATA_DIR = dataDir;
    process.env.OPENCLAW_CLI_WRAPPER = path.join(openclawRoot, "scripts", "openclaw.ps1");

    const service = await WechatLoveNoteService.create();
    const result = await service.run({
      date: "2026-04-03",
      dryRun: true,
      force: true,
    });

    expect(result.status).toBe("dry_run");
    expect(result.targetId).toBe("faye-wechat");
    expect(result.content).toContain("Aaron");
    expect(result.content).not.toMatch(/喝口水|吃点东西|好好休息/);
    expect(result.content).toMatch(/惦记|放在心上|在你这边|抱你|偏向你/);
  });

  it("does not send twice once a note for the same day is already marked sent", async () => {
    const { root, configDir, dataDir, openclawRoot } = createTempRoots();
    process.env.WECHAT_DIGEST_ROOT = root;
    process.env.WECHAT_DIGEST_CONFIG_DIR = configDir;
    process.env.WECHAT_DIGEST_DATA_DIR = dataDir;
    process.env.OPENCLAW_CLI_WRAPPER = path.join(openclawRoot, "scripts", "openclaw.ps1");

    const store = await SqliteStateStore.open(path.join(dataDir, "state.sqlite"));
    store.run(
      `
      INSERT INTO love_note_deliveries (
        id, note_date, target_id, scheduled_for, status, content, to_recipient, created_at, sent_at, error
      ) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, NULL)
      `,
      [
        "note-1",
        "2026-04-03",
        "faye-wechat",
        "12:00",
        "existing note",
        "sample-faye@im.wechat",
        "2026-04-03T04:00:00.000Z",
        "2026-04-03T04:00:05.000Z",
      ],
    );

    const service = await WechatLoveNoteService.create();
    const result = await service.run({
      date: "2026-04-03",
    });

    expect(result.status).toBe("already_sent");
    expect(result.sentCount).toBe(0);
  });

  it("marks the target stale when the direct lane has not been active recently", async () => {
    const { root, configDir, dataDir, openclawRoot } = createTempRoots();
    process.env.WECHAT_DIGEST_ROOT = root;
    process.env.WECHAT_DIGEST_CONFIG_DIR = configDir;
    process.env.WECHAT_DIGEST_DATA_DIR = dataDir;
    process.env.OPENCLAW_CLI_WRAPPER = path.join(openclawRoot, "scripts", "openclaw.ps1");
    fs.writeFileSync(
      path.join(openclawRoot, ".openclaw-state", "agents", "main", "sessions", "sessions.json"),
      JSON.stringify(
        {
          "agent:main:openclaw-weixin:sample-account:direct:sample-faye@im.wechat": {
            origin: {
              provider: "openclaw-weixin",
              chatType: "direct",
              accountId: "sample-account",
              to: "sample-faye@im.wechat",
            },
            updatedAt: Date.parse("2026-04-03T08:00:00.000Z"),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = await WechatLoveNoteService.create();
    const result = await service.run({
      date: "2026-04-07",
      force: true,
    });

    expect(result.status).toBe("stale_target");
    expect(result.sentCount).toBe(0);
    expect(result.error).toContain("Last direct activity was 2026-04-03T08:00:00.000Z");
  });

  it("uses recent direct-lane context instead of generic reminders when available", async () => {
    const { root, configDir, dataDir, openclawRoot } = createTempRoots();
    process.env.WECHAT_DIGEST_ROOT = root;
    process.env.WECHAT_DIGEST_CONFIG_DIR = configDir;
    process.env.WECHAT_DIGEST_DATA_DIR = dataDir;
    process.env.OPENCLAW_CLI_WRAPPER = path.join(openclawRoot, "scripts", "openclaw.ps1");
    fs.writeFileSync(
      path.join(openclawRoot, "workspace", "memory", "2026-04-03.md"),
      "- Faye has a company physical exam today.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(openclawRoot, ".openclaw-state", "agents", "main", "sessions", "07b64d82-7181-4157-bd76-25ebcb20050a.jsonl"),
      [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "Conversation info (untrusted metadata):\n```json\n{}\n```\n\n我今天有点担心公司年检。"}],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(openclawRoot, ".openclaw-state", "agents", "main", "sessions", "sessions.json"),
      JSON.stringify(
        {
          "agent:main:openclaw-weixin:sample-account:direct:sample-faye@im.wechat": {
            origin: {
              provider: "openclaw-weixin",
              chatType: "direct",
              accountId: "sample-account",
              to: "sample-faye@im.wechat",
            },
            sessionId: "07b64d82-7181-4157-bd76-25ebcb20050a",
            updatedAt: Date.now() - 30 * 60 * 1000,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = await WechatLoveNoteService.create();
    const result = await service.run({
      date: "2026-04-03",
      dryRun: true,
      force: true,
    });

    expect(result.status).toBe("dry_run");
    expect(result.content).toContain("Aaron");
    expect(result.content).toMatch(/体检|检查|不是一个人面对|发虚/);
    expect(result.content).not.toMatch(/喝口水|吃点东西/);
  });
});
