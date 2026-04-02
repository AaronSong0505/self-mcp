import fs from "node:fs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { DeliveryTargetConfig, DigestMessage } from "./types.js";

function resolveWrapperWorkdir(wrapperPath: string): string {
  return path.dirname(path.dirname(wrapperPath));
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildClientVersion(version: string): number {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function resolveWechatContextTokensPath(wrapperPath: string, accountId: string): string {
  return path.join(
    resolveWrapperWorkdir(wrapperPath),
    ".openclaw-state",
    "openclaw-weixin",
    "accounts",
    `${accountId}.context-tokens.json`,
  );
}

function resolveWechatAccountPath(wrapperPath: string, accountId: string): string {
  return path.join(
    resolveWrapperWorkdir(wrapperPath),
    ".openclaw-state",
    "openclaw-weixin",
    "accounts",
    `${accountId}.json`,
  );
}

function resolveWechatPackagePath(wrapperPath: string): string {
  return path.join(
    resolveWrapperWorkdir(wrapperPath),
    ".openclaw-state",
    "extensions",
    "openclaw-weixin",
    "package.json",
  );
}

type WeixinAccountConfig = {
  token: string;
  baseUrl: string;
};

type WeixinPackageConfig = {
  version?: string;
  ilink_appid?: string;
};

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function loadWechatAccountConfig(wrapperPath: string, accountId: string): WeixinAccountConfig {
  const accountPath = resolveWechatAccountPath(wrapperPath, accountId);
  if (!fs.existsSync(accountPath)) {
    throw new Error(`Weixin account file not found: ${accountPath}`);
  }
  const parsed = readJsonFile<Partial<WeixinAccountConfig>>(accountPath);
  if (!parsed.token?.trim() || !parsed.baseUrl?.trim()) {
    throw new Error(`Weixin account config is incomplete: ${accountPath}`);
  }
  return {
    token: parsed.token.trim(),
    baseUrl: parsed.baseUrl.trim(),
  };
}

function loadWechatPackageConfig(wrapperPath: string): WeixinPackageConfig {
  const packagePath = resolveWechatPackagePath(wrapperPath);
  if (!fs.existsSync(packagePath)) {
    return {
      version: "2.1.1",
      ilink_appid: "bot",
    };
  }
  return readJsonFile<WeixinPackageConfig>(packagePath);
}

export function resolveDeliveryRecipient(wrapperPath: string, target: DeliveryTargetConfig): string {
  if (target.channel !== "openclaw-weixin" || !target.accountId) {
    return target.to;
  }

  const contextTokensPath = resolveWechatContextTokensPath(wrapperPath, target.accountId);
  if (!fs.existsSync(contextTokensPath)) {
    return target.to;
  }

  try {
    const raw = fs.readFileSync(contextTokensPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed[target.to]) {
      return target.to;
    }
    const normalizedTarget = target.to.toLowerCase();
    const matched = Object.keys(parsed).find((key) => key.toLowerCase() === normalizedTarget);
    return matched ?? target.to;
  } catch {
    return target.to;
  }
}

function resolveWechatContextToken(
  wrapperPath: string,
  target: DeliveryTargetConfig,
  recipient: string,
): string {
  if (target.channel !== "openclaw-weixin" || !target.accountId) {
    throw new Error("resolveWechatContextToken only supports openclaw-weixin targets with an accountId.");
  }

  const contextTokensPath = resolveWechatContextTokensPath(wrapperPath, target.accountId);
  if (!fs.existsSync(contextTokensPath)) {
    throw new Error(`Weixin context token file not found: ${contextTokensPath}`);
  }
  const parsed = readJsonFile<Record<string, string>>(contextTokensPath);
  const exactMatch = parsed[recipient];
  if (exactMatch?.trim()) {
    return exactMatch.trim();
  }
  const normalizedRecipient = recipient.toLowerCase();
  const matchedKey = Object.keys(parsed).find((key) => key.toLowerCase() === normalizedRecipient);
  const matchedValue = matchedKey ? parsed[matchedKey] : undefined;
  if (!matchedValue?.trim()) {
    throw new Error(`Weixin context token not found for recipient: ${recipient}`);
  }
  return matchedValue.trim();
}

function buildWechatTextBody(recipient: string, text: string, contextToken: string): string {
  return JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: recipient,
      client_id: `self-mcp-${Date.now()}-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken,
    },
    base_info: {
      channel_version: "2.1.1",
    },
  });
}

async function sendWechatDigestMessagesDirect(params: {
  wrapperPath: string;
  target: DeliveryTargetConfig;
  messages: DigestMessage[];
}): Promise<{ sentCount: number; recipient: string }> {
  const { wrapperPath, target, messages } = params;
  if (!target.accountId) {
    throw new Error("openclaw-weixin delivery requires accountId.");
  }

  const recipient = resolveDeliveryRecipient(wrapperPath, target);
  const contextToken = resolveWechatContextToken(wrapperPath, target, recipient);
  const account = loadWechatAccountConfig(wrapperPath, target.accountId);
  const pkg = loadWechatPackageConfig(wrapperPath);
  const bodyBaseInfo = {
    channel_version: pkg.version?.trim() || "2.1.1",
  };
  const headersBase: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${account.token}`,
    "iLink-App-Id": pkg.ilink_appid?.trim() || "bot",
    "iLink-App-ClientVersion": String(buildClientVersion(pkg.version?.trim() || "2.1.1")),
  };

  let sentCount = 0;
  for (const message of messages) {
    const text = `${message.title}\n\n${message.body}`.trim();
    const body = JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: recipient,
        client_id: `self-mcp-${Date.now()}-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: bodyBaseInfo,
    });
    const response = await fetch(new URL("ilink/bot/sendmessage", ensureTrailingSlash(account.baseUrl)), {
      method: "POST",
      headers: {
        ...headersBase,
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
        "X-WECHAT-UIN": randomWechatUin(),
      },
      body,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Direct Weixin send failed (${response.status}): ${rawText}`);
    }
    sentCount += 1;
  }

  return { sentCount, recipient };
}

export async function sendDigestMessages(params: {
  wrapperPath: string;
  target: DeliveryTargetConfig;
  messages: DigestMessage[];
}): Promise<{ sentCount: number; recipient: string }> {
  const { wrapperPath, target, messages } = params;
  if (!wrapperPath) {
    throw new Error("OPENCLAW_CLI_WRAPPER is not configured.");
  }

  const recipient = resolveDeliveryRecipient(wrapperPath, target);
  if (target.channel === "openclaw-weixin" && target.accountId) {
    return sendWechatDigestMessagesDirect({
      wrapperPath,
      target: {
        ...target,
        to: recipient,
      },
      messages,
    });
  }

  let sentCount = 0;
  for (const message of messages) {
    const text = `${message.title}\n\n${message.body}`.trim();
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wrapperPath,
      "message",
      "send",
      "--channel",
      target.channel,
      "--target",
      recipient,
      "--message",
      text,
    ];
    if (target.accountId) {
      args.push("--account", target.accountId);
    }

    const result = spawnSync("powershell.exe", args, {
      cwd: resolveWrapperWorkdir(wrapperPath),
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `OpenClaw message send failed: ${result.stderr?.trim() || result.stdout?.trim() || result.status}`,
      );
    }
    sentCount += 1;
  }

  return { sentCount, recipient };
}
