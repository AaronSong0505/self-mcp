import fs from "node:fs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { DeliveryTargetConfig, DigestMessage, WechatDeliveryConfig } from "./types.js";

const DEFAULT_WECHAT_DELIVERY_CONFIG: Required<WechatDeliveryConfig> = {
  maxAttempts: 3,
  retryDelayMs: 1200,
  interMessageDelayMs: 350,
  overviewDetailDelayMs: 1500,
};

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

function normalizeWechatDeliveryConfig(config?: WechatDeliveryConfig): Required<WechatDeliveryConfig> {
  return {
    maxAttempts: Math.max(1, Math.min(5, Math.trunc(config?.maxAttempts ?? DEFAULT_WECHAT_DELIVERY_CONFIG.maxAttempts))),
    retryDelayMs: Math.max(0, Math.trunc(config?.retryDelayMs ?? DEFAULT_WECHAT_DELIVERY_CONFIG.retryDelayMs)),
    interMessageDelayMs: Math.max(
      0,
      Math.trunc(config?.interMessageDelayMs ?? DEFAULT_WECHAT_DELIVERY_CONFIG.interMessageDelayMs),
    ),
    overviewDetailDelayMs: Math.max(
      0,
      Math.trunc(config?.overviewDetailDelayMs ?? DEFAULT_WECHAT_DELIVERY_CONFIG.overviewDetailDelayMs),
    ),
  };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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

  const configuredRecipient = target.to.trim();
  const contextTokensPath = resolveWechatContextTokensPath(wrapperPath, target.accountId);
  if (!fs.existsSync(contextTokensPath)) {
    return configuredRecipient;
  }

  try {
    const raw = fs.readFileSync(contextTokensPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    if (parsed[configuredRecipient]) {
      return configuredRecipient;
    }
    const normalizedTarget = configuredRecipient.toLowerCase();
    const matched = Object.keys(parsed).find((key) => key.toLowerCase() === normalizedTarget);
    if (matched) {
      // The plugin persists context-token keys in lowercase, but active Weixin delivery
      // can still require the exact mixed-case recipient that the user configured.
      if (matched !== matched.toLowerCase()) {
        return matched;
      }
      return configuredRecipient;
    }
    return configuredRecipient;
  } catch {
    return configuredRecipient;
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

function buildWechatTextBody(recipient: string, text: string, contextToken: string, channelVersion: string): string {
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
      channel_version: channelVersion,
    },
  });
}

function formatDigestMessage(message: DigestMessage): string {
  return `${message.title}\n\n${message.body}`.trim();
}

function assertWechatBusinessSuccess(rawText: string): void {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== "object" || !("ret" in parsed)) {
    return;
  }

  const ret = Number((parsed as { ret?: unknown }).ret);
  if (!Number.isFinite(ret) || ret === 0) {
    return;
  }

  const errmsg = String((parsed as { errmsg?: unknown }).errmsg ?? "").trim();
  throw new Error(
    `Direct Weixin send business failure (ret=${ret}${errmsg ? `, errmsg=${errmsg}` : ""}): ${trimmed}`,
  );
}

function delayBeforeMessage(index: number, messages: DigestMessage[], config: Required<WechatDeliveryConfig>): number {
  if (index <= 0) {
    return 0;
  }
  const previous = messages[index - 1];
  const current = messages[index];
  if (index === 1 && previous?.kind === "overview" && current?.kind !== "overview") {
    return config.overviewDetailDelayMs;
  }
  return config.interMessageDelayMs;
}

class DirectWechatDeliveryError extends Error {
  constructor(
    message: string,
    readonly sentCount: number,
    readonly recipient: string,
  ) {
    super(message);
    this.name = "DirectWechatDeliveryError";
  }
}

async function postWechatText(params: {
  account: WeixinAccountConfig;
  headersBase: Record<string, string>;
  recipient: string;
  text: string;
  contextToken: string;
  channelVersion: string;
  config: Required<WechatDeliveryConfig>;
}): Promise<void> {
  const { account, headersBase, recipient, text, contextToken, channelVersion, config } = params;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const body = buildWechatTextBody(recipient, text, contextToken, channelVersion);
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
      assertWechatBusinessSuccess(rawText);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < config.maxAttempts) {
        await sleep(config.retryDelayMs * attempt);
      }
    }
  }

  throw lastError ?? new Error("Direct Weixin send failed.");
}

async function sendWechatDigestMessagesDirect(params: {
  wrapperPath: string;
  target: DeliveryTargetConfig;
  messages: DigestMessage[];
  config?: WechatDeliveryConfig;
}): Promise<{ sentCount: number; recipient: string }> {
  const { wrapperPath, target, messages } = params;
  if (!target.accountId) {
    throw new Error("openclaw-weixin delivery requires accountId.");
  }

  const config = normalizeWechatDeliveryConfig(params.config);
  const recipient = resolveDeliveryRecipient(wrapperPath, target);
  const contextToken = resolveWechatContextToken(wrapperPath, target, recipient);
  const account = loadWechatAccountConfig(wrapperPath, target.accountId);
  const pkg = loadWechatPackageConfig(wrapperPath);
  const channelVersion = pkg.version?.trim() || "2.1.1";
  const headersBase: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    Accept: "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${account.token}`,
    "iLink-App-Id": pkg.ilink_appid?.trim() || "bot",
    "iLink-App-ClientVersion": String(buildClientVersion(channelVersion)),
  };

  let sentCount = 0;
  for (const [index, message] of messages.entries()) {
    await sleep(delayBeforeMessage(index, messages, config));
    const text = formatDigestMessage(message);
    try {
      await postWechatText({
        account,
        headersBase,
        recipient,
        text,
        contextToken,
        channelVersion,
        config,
      });
    } catch (error) {
      throw new DirectWechatDeliveryError(
        error instanceof Error ? error.message : String(error),
        sentCount,
        recipient,
      );
    }
    sentCount += 1;
  }

  return { sentCount, recipient };
}

function sendMessagesViaWrapper(params: {
  wrapperPath: string;
  target: DeliveryTargetConfig;
  messages: DigestMessage[];
  recipient: string;
}): { sentCount: number; recipient: string } {
  const { wrapperPath, target, messages, recipient } = params;
  let sentCount = 0;
  for (const message of messages) {
    const text = formatDigestMessage(message);
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

export async function sendDigestMessages(params: {
  wrapperPath: string;
  target: DeliveryTargetConfig;
  messages: DigestMessage[];
  wechatConfig?: WechatDeliveryConfig;
}): Promise<{ sentCount: number; recipient: string }> {
  const { wrapperPath, target, messages } = params;
  if (!wrapperPath) {
    throw new Error("OPENCLAW_CLI_WRAPPER is not configured.");
  }

  const recipient = resolveDeliveryRecipient(wrapperPath, target);
  if (target.channel === "openclaw-weixin" && target.accountId) {
    try {
      return await sendWechatDigestMessagesDirect({
        wrapperPath,
        target: {
          ...target,
          to: recipient,
        },
        messages,
        config: params.wechatConfig,
      });
    } catch (error) {
      const alreadySent = error instanceof DirectWechatDeliveryError ? error.sentCount : 0;
      const remaining = messages.slice(alreadySent);
      if (remaining.length === 0) {
        return { sentCount: alreadySent, recipient };
      }
      const fallback = sendMessagesViaWrapper({
        wrapperPath,
        target,
        messages: remaining,
        recipient,
      });
      return {
        sentCount: alreadySent + fallback.sentCount,
        recipient,
      };
    }
  }

  return sendMessagesViaWrapper({
    wrapperPath,
    target,
    messages,
    recipient,
  });
}
