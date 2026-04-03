import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WechatHouseholdRelayService } from "../services/wechat-household-mcp/src/service.js";

const cleanupDirs: string[] = [];

function createTempRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-mcp-household-relay-"));
  cleanupDirs.push(root);
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const openclawRoot = path.join(root, "openclaw");
  const accountsDir = path.join(openclawRoot, ".openclaw-state", "openclaw-weixin", "accounts");
  const extensionsDir = path.join(openclawRoot, ".openclaw-state", "extensions", "openclaw-weixin");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(openclawRoot, "scripts"), { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(openclawRoot, "scripts", "openclaw.ps1"), "# mock", "utf8");
  fs.writeFileSync(
    path.join(accountsDir, "aaron-account.json"),
    JSON.stringify({
      token: "aaron-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(accountsDir, "aaron-account.context-tokens.json"),
    JSON.stringify({
      "o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat": "aaron-context-token",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(accountsDir, "faye-account.json"),
    JSON.stringify({
      token: "faye-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(accountsDir, "faye-account.context-tokens.json"),
    JSON.stringify({
      "o9cq80_VK5NBw2O-cmGI-AcSxxI4@im.wechat": "faye-context-token",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(extensionsDir, "package.json"),
    JSON.stringify({
      version: "2.1.1",
      ilink_appid: "bot",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(configDir, "wechat_digest_rules.yaml"),
    `deliveryTargets:
  aaron-wechat:
    channel: openclaw-weixin
    accountId: aaron-account
    to: o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat
  faye-wechat:
    channel: openclaw-weixin
    accountId: faye-account
    to: o9cq80_VK5NBw2O-cmGI-AcSxxI4@im.wechat
`,
    "utf8",
  );
  fs.writeFileSync(path.join(configDir, "wechat_sources.yaml"), "sources: []\n", "utf8");
  fs.writeFileSync(
    path.join(configDir, "wechat_household.yaml"),
    `enabled: true
title: 小熊帮忙转一句 🐻
people:
  Aaron:
    targetId: aaron-wechat
    aliases: [Aaron, 老公]
  Faye:
    targetId: faye-wechat
    aliases: [Faye, 老婆]
allowedPairs:
  - from: Faye
    to: Aaron
  - from: Aaron
    to: Faye
`,
    "utf8",
  );
  return { root, configDir, dataDir, openclawRoot };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.WECHAT_DIGEST_ROOT;
  delete process.env.WECHAT_DIGEST_CONFIG_DIR;
  delete process.env.WECHAT_DIGEST_DATA_DIR;
  delete process.env.OPENCLAW_CLI_WRAPPER;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("wechat household relay service", () => {
  it("forwards Faye's message to Aaron through the configured WeChat lane", async () => {
    const { root, configDir, dataDir, openclawRoot } = createTempRoots();
    process.env.WECHAT_DIGEST_ROOT = root;
    process.env.WECHAT_DIGEST_CONFIG_DIR = configDir;
    process.env.WECHAT_DIGEST_DATA_DIR = dataDir;
    process.env.OPENCLAW_CLI_WRAPPER = path.join(openclawRoot, "scripts", "openclaw.ps1");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "")) as {
        msg: { to_user_id: string; item_list: Array<{ text_item?: { text?: string } }> };
      };
      expect(parsed.msg.to_user_id).toBe("o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat");
      expect(parsed.msg.item_list[0]?.text_item?.text).toContain("Faye 刚刚请我转告你");
      expect(parsed.msg.item_list[0]?.text_item?.text).toContain("今晚早点回家");
      return new Response('{"ret":0}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = await WechatHouseholdRelayService.create();
    const result = await service.sendRelay({
      fromPerson: "Faye",
      toPerson: "Aaron",
      message: "今晚早点回家。",
    });

    expect(result.status).toBe("sent");
    expect(result.toTargetId).toBe("aaron-wechat");
    expect(result.recipient).toBe("o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat");
    expect(result.sentCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports dry-run relay previews without sending", async () => {
    const { root, configDir, dataDir, openclawRoot } = createTempRoots();
    process.env.WECHAT_DIGEST_ROOT = root;
    process.env.WECHAT_DIGEST_CONFIG_DIR = configDir;
    process.env.WECHAT_DIGEST_DATA_DIR = dataDir;
    process.env.OPENCLAW_CLI_WRAPPER = path.join(openclawRoot, "scripts", "openclaw.ps1");

    const service = await WechatHouseholdRelayService.create();
    const result = await service.sendRelay({
      fromPerson: "Aaron",
      toPerson: "Faye",
      message: "记得下午休息一下。",
      dryRun: true,
    });

    expect(result.status).toBe("dry_run");
    expect(result.forwardedText).toContain("Aaron 刚刚请我转告你");
    expect(result.sentCount).toBe(0);
  });
});
