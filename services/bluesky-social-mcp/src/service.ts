import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import YAML from "yaml";
import { AtpAgent, RichText } from "@atproto/api";

const require = createRequire(import.meta.url);
const nodeFetch = require("node-fetch").default as typeof globalThis.fetch;
const SocksProxyAgent = require("socks-proxy-agent").SocksProxyAgent as new (uri: string) => unknown;

type BlueskyConfigDoc = {
  enabled?: boolean;
  serviceUrl?: string;
  defaultLanguages?: string[];
  reviewRequired?: boolean;
  activeChannelLabel?: string;
};

export type BlueskyStatusResult = {
  enabled: boolean;
  configured: boolean;
  authenticated: boolean;
  serviceUrl: string;
  proxyUrl?: string;
  proxyEnabled?: boolean;
  networkReachable?: boolean;
  handle?: string;
  did?: string;
  displayName?: string;
  reviewRequired: boolean;
  activeChannelLabel: string;
  defaultLanguages: string[];
  lastError?: string;
};

export type BlueskyPreviewResult = {
  text: string;
  graphemeLength: number;
  maxGraphemes: number;
  fitsLimit: boolean;
  overLimitBy: number;
  facetsCount: number;
  langs: string[];
  activeChannelLabel: string;
  reviewRequired: boolean;
  sourceContext?: string;
};

export type BlueskyPublishResult = BlueskyPreviewResult & {
  dryRun: boolean;
  published: boolean;
  handle?: string;
  uri?: string;
  cid?: string;
  verified?: boolean;
  verificationTextMatches?: boolean;
  verificationError?: string;
};

export type BlueskyPostSummary = {
  uri: string;
  cid?: string;
  authorHandle?: string;
  displayName?: string;
  text: string;
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
};

export type BlueskyFeedResult = {
  source: string;
  items: BlueskyPostSummary[];
};

export type BlueskyThreadResult = {
  uri: string;
  depth: number;
  items: BlueskyPostSummary[];
};

export type BlueskyReplyResult = BlueskyPublishResult & {
  parentUri: string;
  parentCid: string;
  rootUri: string;
  rootCid: string;
};

type RuntimeConfig = {
  enabled: boolean;
  serviceUrl: string;
  defaultLanguages: string[];
  reviewRequired: boolean;
  activeChannelLabel: string;
  identifier?: string;
  appPassword?: string;
  proxyUrl?: string;
};

const DEFAULT_MAX_GRAPHEMES = 300;

function resolveRootDir(): string {
  return process.env.BLUESKY_SOCIAL_ROOT
    ? path.resolve(process.env.BLUESKY_SOCIAL_ROOT)
    : process.cwd();
}

function readConfigDoc(): BlueskyConfigDoc {
  const configDir = process.env.BLUESKY_SOCIAL_CONFIG_DIR
    ? path.resolve(process.env.BLUESKY_SOCIAL_CONFIG_DIR)
    : path.join(resolveRootDir(), "config");
  const configFile = path.join(configDir, "bluesky_social.yaml");
  if (!fs.existsSync(configFile)) {
    return {};
  }
  return (YAML.parse(fs.readFileSync(configFile, "utf8")) ?? {}) as BlueskyConfigDoc;
}

function loadRuntimeConfig(): RuntimeConfig {
  const doc = readConfigDoc();
  const defaultLanguages = (doc.defaultLanguages ?? ["zh-Hans"]).filter(Boolean);
  return {
    enabled: doc.enabled !== false,
    serviceUrl: doc.serviceUrl?.trim() || process.env.BLUESKY_SERVICE?.trim() || "https://bsky.social",
    defaultLanguages,
    reviewRequired: doc.reviewRequired !== false,
    activeChannelLabel: doc.activeChannelLabel?.trim() || "Bluesky",
    identifier: process.env.BLUESKY_HANDLE?.trim(),
    appPassword: process.env.BLUESKY_APP_PASSWORD?.trim(),
    proxyUrl: resolveProxyUrlFromEnv(),
  };
}

export function resolveProxyUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.BLUESKY_PROXY_URL,
    env.ALL_PROXY,
    env.all_proxy,
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ];
  for (const value of candidates) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "socks5h://127.0.0.1:40008";
}

function buildFetchWithOptionalProxy(proxyUrl?: string): typeof globalThis.fetch | undefined {
  if (!proxyUrl) {
    return undefined;
  }
  if (!proxyUrl.startsWith("socks")) {
    throw new Error(`Unsupported Bluesky proxy protocol: ${proxyUrl}`);
  }
  const agent = new SocksProxyAgent(proxyUrl);
  const proxiedFetch: typeof globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string | URL = input as any;
    let nextInit: Record<string, unknown> = { ...(init as any) };

    if (typeof Request !== "undefined" && input instanceof Request) {
      const method = init?.method ?? input.method;
      const headers = Object.fromEntries(input.headers.entries());
      const body =
        method === "GET" || method === "HEAD" ? undefined : Buffer.from(await input.arrayBuffer());
      url = input.url;
      nextInit = {
        method,
        headers,
        body,
        redirect: init?.redirect ?? input.redirect,
        signal: init?.signal ?? input.signal,
        ...(init as any),
      };
    }

    return (await nodeFetch(url as any, {
      ...nextInit,
      agent,
    } as any)) as any;
  };
  return proxiedFetch;
}

function isProxyConnectionRefused(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /ECONNREFUSED\s+127\.0\.0\.1:\d+/i.test(message);
}

function isReachabilityError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /(fetch failed|Connect Timeout|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNRESET|socket hang up)/i.test(message);
}

function summarizeConnectionError(error: unknown, config: RuntimeConfig): Error {
  if (error instanceof Error && error.message === "Bluesky credentials are not configured.") {
    return error;
  }
  if (config.proxyUrl && isProxyConnectionRefused(error)) {
    return new Error(`Bluesky proxy is unreachable at ${config.proxyUrl}.`);
  }
  if (isReachabilityError(error)) {
    return new Error("Cannot reach Bluesky right now (network unavailable).");
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function attemptAuthenticatedAgent(
  serviceUrl: string,
  identifier: string,
  appPassword: string,
  proxyUrl?: string,
): Promise<AtpAgent> {
  const agent = new AtpAgent({
    service: serviceUrl,
    ...(proxyUrl ? { fetch: buildFetchWithOptionalProxy(proxyUrl) } : {}),
  });
  await agent.login({
    identifier,
    password: appPassword,
  });
  return agent;
}

async function createAuthenticatedAgent(config: RuntimeConfig): Promise<AtpAgent> {
  if (!config.identifier || !config.appPassword) {
    throw new Error("Bluesky credentials are not configured.");
  }
  try {
    return await attemptAuthenticatedAgent(
      config.serviceUrl,
      config.identifier,
      config.appPassword,
      config.proxyUrl,
    );
  } catch (error) {
    if (config.proxyUrl && isProxyConnectionRefused(error)) {
      try {
        return await attemptAuthenticatedAgent(
          config.serviceUrl,
          config.identifier,
          config.appPassword,
          undefined,
        );
      } catch (directError) {
        throw summarizeConnectionError(directError, config);
      }
    }
    throw summarizeConnectionError(error, config);
  }
}

async function verifyPublishedPost(
  agent: AtpAgent,
  uri: string,
  expectedText: string,
): Promise<Pick<BlueskyPublishResult, "verified" | "verificationTextMatches" | "verificationError">> {
  try {
    const response = await agent.app.bsky.feed.getPosts({
      uris: [uri],
    });
    const post = response.data.posts?.[0];
    const actualText = extractPostText(post?.record);
    return {
      verified: true,
      verificationTextMatches: actualText === expectedText,
    };
  } catch (error) {
    return {
      verified: false,
      verificationTextMatches: false,
      verificationError: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeLanguages(input: string[] | undefined, fallback: string[]): string[] {
  const values = (input ?? fallback).map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : fallback;
}

function extractPostText(record: unknown): string {
  if (!record || typeof record !== "object") {
    return "";
  }
  const candidate = record as { text?: unknown };
  return typeof candidate.text === "string" ? candidate.text : "";
}

function summarizePostView(view: any): BlueskyPostSummary {
  const post = view?.post ?? view;
  return {
    uri: String(post?.uri ?? ""),
    ...(post?.cid ? { cid: String(post.cid) } : {}),
    ...(post?.author?.handle ? { authorHandle: String(post.author.handle) } : {}),
    ...(post?.author?.displayName ? { displayName: String(post.author.displayName) } : {}),
    text: extractPostText(post?.record),
    ...(post?.indexedAt ? { indexedAt: String(post.indexedAt) } : {}),
    ...(typeof post?.likeCount === "number" ? { likeCount: post.likeCount } : {}),
    ...(typeof post?.repostCount === "number" ? { repostCount: post.repostCount } : {}),
    ...(typeof post?.replyCount === "number" ? { replyCount: post.replyCount } : {}),
  };
}

function flattenThread(node: any, acc: BlueskyPostSummary[] = []): BlueskyPostSummary[] {
  if (!node) {
    return acc;
  }
  if (node?.post || node?.uri) {
    acc.push(summarizePostView(node));
  }
  if (Array.isArray(node?.replies)) {
    for (const reply of node.replies) {
      flattenThread(reply, acc);
    }
  }
  return acc;
}

async function buildPreview(params: {
  text: string;
  langs?: string[];
  sourceContext?: string;
  config: RuntimeConfig;
  detectWithAgent?: AtpAgent;
}): Promise<BlueskyPreviewResult> {
  const langs = normalizeLanguages(params.langs, params.config.defaultLanguages);
  const richText = new RichText({ text: params.text.trim() });
  if (params.detectWithAgent) {
    await richText.detectFacets(params.detectWithAgent);
  } else {
    richText.detectFacetsWithoutResolution();
  }
  const graphemeLength = richText.graphemeLength;
  const overLimitBy = Math.max(graphemeLength - DEFAULT_MAX_GRAPHEMES, 0);
  return {
    text: richText.text,
    graphemeLength,
    maxGraphemes: DEFAULT_MAX_GRAPHEMES,
    fitsLimit: overLimitBy === 0,
    overLimitBy,
    facetsCount: richText.facets?.length ?? 0,
    langs,
    activeChannelLabel: params.config.activeChannelLabel,
    reviewRequired: params.config.reviewRequired,
    ...(params.sourceContext ? { sourceContext: params.sourceContext } : {}),
  };
}

export class BlueskySocialService {
  private readonly config = loadRuntimeConfig();

  async status(): Promise<BlueskyStatusResult> {
    const configured = Boolean(this.config.identifier && this.config.appPassword);
    if (!configured || !this.config.enabled) {
      return {
        enabled: this.config.enabled,
        configured,
        authenticated: false,
        serviceUrl: this.config.serviceUrl,
        ...(this.config.proxyUrl
          ? {
              proxyUrl: this.config.proxyUrl,
              proxyEnabled: true,
              networkReachable: false,
            }
          : {}),
        reviewRequired: this.config.reviewRequired,
        activeChannelLabel: this.config.activeChannelLabel,
        defaultLanguages: this.config.defaultLanguages,
        ...(this.config.identifier ? { handle: this.config.identifier } : {}),
      };
    }

    try {
      const agent = await createAuthenticatedAgent(this.config);
      const profile = await agent.getProfile({ actor: this.config.identifier! });
      return {
        enabled: this.config.enabled,
        configured: true,
        authenticated: true,
        serviceUrl: this.config.serviceUrl,
        ...(this.config.proxyUrl
          ? {
              proxyUrl: this.config.proxyUrl,
              proxyEnabled: true,
            }
          : {}),
        networkReachable: true,
        handle: profile.data.handle,
        did: profile.data.did,
        ...(profile.data.displayName ? { displayName: profile.data.displayName } : {}),
        reviewRequired: this.config.reviewRequired,
        activeChannelLabel: this.config.activeChannelLabel,
        defaultLanguages: this.config.defaultLanguages,
      };
    } catch (error) {
      return {
        enabled: this.config.enabled,
        configured: true,
        authenticated: false,
        serviceUrl: this.config.serviceUrl,
        ...(this.config.proxyUrl
          ? {
              proxyUrl: this.config.proxyUrl,
              proxyEnabled: true,
            }
          : {}),
        networkReachable: false,
        reviewRequired: this.config.reviewRequired,
        activeChannelLabel: this.config.activeChannelLabel,
        defaultLanguages: this.config.defaultLanguages,
        lastError: error instanceof Error ? error.message : String(error),
        ...(this.config.identifier ? { handle: this.config.identifier } : {}),
      };
    }
  }

  async previewPost(params: {
    text: string;
    langs?: string[];
    sourceContext?: string;
  }): Promise<BlueskyPreviewResult> {
    return buildPreview({
      text: params.text,
      langs: params.langs,
      sourceContext: params.sourceContext,
      config: this.config,
    });
  }

  async publishPost(params: {
    text: string;
    langs?: string[];
    sourceContext?: string;
    dryRun?: boolean;
  }): Promise<BlueskyPublishResult> {
    if (!this.config.enabled) {
      throw new Error("Bluesky social lane is disabled.");
    }

    if (params.dryRun) {
      const preview = await this.previewPost(params);
    return {
      ...preview,
      dryRun: true,
      published: false,
      verified: false,
      verificationTextMatches: false,
    };
  }

    const agent = await createAuthenticatedAgent(this.config);
    const preview = await buildPreview({
      text: params.text,
      langs: params.langs,
      sourceContext: params.sourceContext,
      config: this.config,
      detectWithAgent: agent,
    });
    if (!preview.fitsLimit) {
      throw new Error(`Bluesky post exceeds ${preview.maxGraphemes} graphemes by ${preview.overLimitBy}.`);
    }

    const richText = new RichText({ text: preview.text });
    await richText.detectFacets(agent);
    const post = await agent.post({
      text: richText.text,
      facets: richText.facets,
      langs: preview.langs,
      createdAt: new Date().toISOString(),
    });

    const verification = await verifyPublishedPost(agent, post.uri, preview.text);

    return {
      ...preview,
      dryRun: false,
      published: true,
      handle: this.config.identifier,
      uri: post.uri,
      cid: post.cid,
      ...verification,
    };
  }

  async homeFeed(params: { limit?: number } = {}): Promise<BlueskyFeedResult> {
    const agent = await createAuthenticatedAgent(this.config);
    const result = await agent.getTimeline({ limit: Math.min(Math.max(params.limit ?? 10, 1), 50) });
    return {
      source: "home",
      items: (result.data.feed ?? []).map((entry: any) => summarizePostView(entry)),
    };
  }

  async actorFeed(params: { actor?: string; limit?: number } = {}): Promise<BlueskyFeedResult> {
    const agent = await createAuthenticatedAgent(this.config);
    const actor = params.actor?.trim() || this.config.identifier;
    if (!actor) {
      throw new Error("Bluesky actor handle is not configured.");
    }
    const result = await agent.getAuthorFeed({
      actor,
      limit: Math.min(Math.max(params.limit ?? 10, 1), 50),
    });
    return {
      source: actor,
      items: (result.data.feed ?? []).map((entry: any) => summarizePostView(entry)),
    };
  }

  async searchPosts(params: { q: string; limit?: number }): Promise<BlueskyFeedResult> {
    const agent = await createAuthenticatedAgent(this.config);
    const result = await agent.app.bsky.feed.searchPosts({
      q: params.q.trim(),
      limit: Math.min(Math.max(params.limit ?? 10, 1), 50),
    });
    return {
      source: `search:${params.q.trim()}`,
      items: (result.data.posts ?? []).map((entry: any) => summarizePostView(entry)),
    };
  }

  async readThread(params: { uri: string; depth?: number }): Promise<BlueskyThreadResult> {
    const agent = await createAuthenticatedAgent(this.config);
    const depth = Math.min(Math.max(params.depth ?? 6, 0), 20);
    const result = await agent.getPostThread({
      uri: params.uri.trim(),
      depth,
    });
    return {
      uri: params.uri.trim(),
      depth,
      items: flattenThread(result.data.thread ?? null),
    };
  }

  async replyPost(params: {
    text: string;
    parentUri: string;
    parentCid: string;
    rootUri?: string;
    rootCid?: string;
    langs?: string[];
    sourceContext?: string;
    dryRun?: boolean;
  }): Promise<BlueskyReplyResult> {
    if (!this.config.enabled) {
      throw new Error("Bluesky social lane is disabled.");
    }

    const parentUri = params.parentUri.trim();
    const parentCid = params.parentCid.trim();
    const rootUri = params.rootUri?.trim() || parentUri;
    const rootCid = params.rootCid?.trim() || parentCid;

    if (!parentUri || !parentCid) {
      throw new Error("Bluesky reply requires both parentUri and parentCid.");
    }

    if (params.dryRun) {
      const preview = await this.previewPost(params);
      return {
        ...preview,
        dryRun: true,
        published: false,
        parentUri,
        parentCid,
        rootUri,
        rootCid,
      };
    }

    const agent = await createAuthenticatedAgent(this.config);
    const preview = await buildPreview({
      text: params.text,
      langs: params.langs,
      sourceContext: params.sourceContext,
      config: this.config,
      detectWithAgent: agent,
    });
    if (!preview.fitsLimit) {
      throw new Error(`Bluesky reply exceeds ${preview.maxGraphemes} graphemes by ${preview.overLimitBy}.`);
    }

    const richText = new RichText({ text: preview.text });
    await richText.detectFacets(agent);
    const post = await agent.post({
      text: richText.text,
      facets: richText.facets,
      langs: preview.langs,
      createdAt: new Date().toISOString(),
      reply: {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: parentUri, cid: parentCid },
      },
    });

    return {
      ...preview,
      dryRun: false,
      published: true,
      handle: this.config.identifier,
      uri: post.uri,
      cid: post.cid,
      parentUri,
      parentCid,
      rootUri,
      rootCid,
    };
  }
}
