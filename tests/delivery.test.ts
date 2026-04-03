import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeliveryRecipient, sendDigestMessages } from "../packages/core/src/delivery.js";

const cleanupDirs: string[] = [];

function createTempOpenClawRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-mcp-delivery-"));
  cleanupDirs.push(root);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, ".openclaw-state", "openclaw-weixin", "accounts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "openclaw.ps1"), "# mock", "utf8");
  return root;
}

function seedWechatRuntime(openclawRoot: string) {
  const accountsDir = path.join(openclawRoot, ".openclaw-state", "openclaw-weixin", "accounts");
  const extensionsDir = path.join(openclawRoot, ".openclaw-state", "extensions", "openclaw-weixin");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(accountsDir, "sample-account.json"),
    JSON.stringify({
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(accountsDir, "sample-account.context-tokens.json"),
    JSON.stringify({
      "o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat": "context-token",
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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("delivery recipient resolution", () => {
  it("reuses the exact-cased WeChat peer id from the stored context tokens", () => {
    const openclawRoot = createTempOpenClawRoot();
    const wrapperPath = path.join(openclawRoot, "scripts", "openclaw.ps1");
    const contextTokensPath = path.join(
      openclawRoot,
      ".openclaw-state",
      "openclaw-weixin",
      "accounts",
      "sample-account.context-tokens.json",
    );
    fs.writeFileSync(
      contextTokensPath,
      JSON.stringify({
        "o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat": "token-value",
      }),
      "utf8",
    );

    const recipient = resolveDeliveryRecipient(wrapperPath, {
      channel: "openclaw-weixin",
      accountId: "sample-account",
      to: "o9cq80whdkdcefzaa0fjfapvjpc4@im.wechat",
    });

    expect(recipient).toBe("o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat");
  });

  it("preserves the configured mixed-case recipient even if the persisted token key is lowercased", () => {
    const openclawRoot = createTempOpenClawRoot();
    const wrapperPath = path.join(openclawRoot, "scripts", "openclaw.ps1");
    const contextTokensPath = path.join(
      openclawRoot,
      ".openclaw-state",
      "openclaw-weixin",
      "accounts",
      "sample-account.context-tokens.json",
    );
    fs.writeFileSync(
      contextTokensPath,
      JSON.stringify({
        "o9cq80whdkdcefzaa0fjfapvjpc4@im.wechat": "token-value",
      }),
      "utf8",
    );

    const recipient = resolveDeliveryRecipient(wrapperPath, {
      channel: "openclaw-weixin",
      accountId: "sample-account",
      to: "o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat",
    });

    expect(recipient).toBe("o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat");
  });

  it("sends openclaw-weixin digest messages directly with UTF-8 headers and the stored context token", async () => {
    const openclawRoot = createTempOpenClawRoot();
    const wrapperPath = path.join(openclawRoot, "scripts", "openclaw.ps1");
    seedWechatRuntime(openclawRoot);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = String(init?.body ?? "");
      const parsed = JSON.parse(rawBody) as {
        msg: { to_user_id: string; context_token: string; item_list: Array<{ text_item?: { text?: string } }> };
      };
      expect(parsed.msg.to_user_id).toBe("o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat");
      expect(parsed.msg.context_token).toBe("context-token");
      expect(parsed.msg.item_list[0]?.text_item?.text).toContain("delivery test title");
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
      });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDigestMessages({
      wrapperPath,
      target: {
        channel: "openclaw-weixin",
        accountId: "sample-account",
        to: "o9cq80whdkdcefzaa0fjfapvjpc4@im.wechat",
      },
      messages: [
        {
          kind: "overview",
          title: "delivery test title",
          body: "delivery test body",
        },
      ],
      wechatConfig: {
        retryDelayMs: 0,
        interMessageDelayMs: 0,
        overviewDetailDelayMs: 0,
      },
    });

    expect(result.sentCount).toBe(1);
    expect(result.recipient).toBe("o9cq80whDkdcEfZaa0FJfapVjpc4@im.wechat");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient WeChat delivery failures before succeeding", async () => {
    const openclawRoot = createTempOpenClawRoot();
    const wrapperPath = path.join(openclawRoot, "scripts", "openclaw.ps1");
    seedWechatRuntime(openclawRoot);

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("temporary network issue");
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendDigestMessages({
      wrapperPath,
      target: {
        channel: "openclaw-weixin",
        accountId: "sample-account",
        to: "o9cq80whdkdcefzaa0fjfapvjpc4@im.wechat",
      },
      messages: [
        {
          kind: "overview",
          title: "retry test title",
          body: "retry test body",
        },
        {
          kind: "detail",
          title: "retry detail title",
          body: "retry detail body",
        },
      ],
      wechatConfig: {
        maxAttempts: 2,
        retryDelayMs: 0,
        interMessageDelayMs: 0,
        overviewDetailDelayMs: 0,
      },
    });

    expect(result.sentCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
