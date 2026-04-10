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
  handle?: string;
  did?: string;
  displayName?: string;
  reviewRequired: boolean;
  activeChannelLabel: string;
  defaultLanguages: string[];
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
  return undefined;
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

async function createAuthenticatedAgent(config: RuntimeConfig): Promise<AtpAgent> {
  if (!config.identifier || !config.appPassword) {
    throw new Error("Bluesky credentials are not configured.");
  }
  const agent = new AtpAgent({
    service: config.serviceUrl,
    ...(config.proxyUrl ? { fetch: buildFetchWithOptionalProxy(config.proxyUrl) } : {}),
  });
  await agent.login({
    identifier: config.identifier,
    password: config.appPassword,
  });
  return agent;
}

function normalizeLanguages(input: string[] | undefined, fallback: string[]): string[] {
  const values = (input ?? fallback).map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : fallback;
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
        reviewRequired: this.config.reviewRequired,
        activeChannelLabel: this.config.activeChannelLabel,
        defaultLanguages: this.config.defaultLanguages,
        ...(this.config.identifier ? { handle: this.config.identifier } : {}),
      };
    }

    const agent = await createAuthenticatedAgent(this.config);
    const profile = await agent.getProfile({ actor: this.config.identifier! });
    return {
      enabled: this.config.enabled,
      configured: true,
      authenticated: true,
      serviceUrl: this.config.serviceUrl,
      handle: profile.data.handle,
      did: profile.data.did,
      ...(profile.data.displayName ? { displayName: profile.data.displayName } : {}),
      reviewRequired: this.config.reviewRequired,
      activeChannelLabel: this.config.activeChannelLabel,
      defaultLanguages: this.config.defaultLanguages,
    };
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

    return {
      ...preview,
      dryRun: false,
      published: true,
      handle: this.config.identifier,
      uri: post.uri,
      cid: post.cid,
    };
  }
}
