import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import YAML from "yaml";
import {
  buildXSearchUrl,
  coerceXSearchMode,
  deriveHandleFromXStatusUrl,
  estimateXTextLength,
  normalizeXTextForMatch,
  normalizeXStatusUrl,
  normalizeXActor,
  type XSearchMode,
} from "./helpers.js";

type XSocialConfigDoc = {
  enabled?: boolean;
  cdpUrl?: string;
  activeChannelLabel?: string;
  defaultSearchMode?: XSearchMode;
  bootstrapScript?: string;
  bootstrapTimeoutMs?: number;
  userDataDir?: string;
  chromeExecutablePath?: string;
};

type RuntimeConfig = {
  enabled: boolean;
  cdpUrl: string;
  activeChannelLabel: string;
  defaultSearchMode: XSearchMode;
  bootstrapScript?: string;
  bootstrapTimeoutMs: number;
  userDataDir: string;
  chromeExecutablePath?: string;
};

export type XStatusResult = {
  enabled: boolean;
  reachable: boolean;
  authenticated: boolean;
  cdpUrl: string;
  activeChannelLabel: string;
  currentUrl?: string;
  handle?: string;
  lastError?: string;
};

export type XPostSummary = {
  url: string;
  authorHandle?: string;
  displayName?: string;
  text: string;
  timeIso?: string;
};

export type XFeedResult = {
  source: string;
  items: XPostSummary[];
};

export type XReviewSnapshotResult = {
  status: XStatusResult;
  home: XFeedResult;
  searches: Array<{ topic: string; result: XFeedResult }>;
};

export type XThreadResult = {
  url: string;
  items: XPostSummary[];
};

export type XPostPreviewResult = {
  text: string;
  length: number;
  maxLength: number;
  fitsLimit: boolean;
  activeChannelLabel: string;
};

export type XPublishResult = XPostPreviewResult & {
  dryRun: boolean;
  published: boolean;
  url?: string;
};

export type XReplyResult = XPublishResult & {
  parentUrl: string;
  url?: string;
};

function resolveRootDir(): string {
  return process.env.X_SOCIAL_ROOT ? path.resolve(process.env.X_SOCIAL_ROOT) : process.cwd();
}

function readConfigDoc(): XSocialConfigDoc {
  const configDir = process.env.X_SOCIAL_CONFIG_DIR
    ? path.resolve(process.env.X_SOCIAL_CONFIG_DIR)
    : path.join(resolveRootDir(), "config");
  const configFile = path.join(configDir, "x_social.yaml");
  if (!fs.existsSync(configFile)) {
    return {};
  }
  return (YAML.parse(fs.readFileSync(configFile, "utf8")) ?? {}) as XSocialConfigDoc;
}

function loadRuntimeConfig(): RuntimeConfig {
  const doc = readConfigDoc();
  const defaultUserDataDir = path.join(
    process.env.LOCALAPPDATA || "C:/Users/Public/AppData/Local",
    "openclaw",
    "browser",
    "openclaw-profile",
  );
  return {
    enabled: doc.enabled !== false,
    cdpUrl: doc.cdpUrl?.trim() || process.env.X_SOCIAL_CDP_URL?.trim() || "http://127.0.0.1:18800",
    activeChannelLabel: doc.activeChannelLabel?.trim() || "X / Twitter",
    defaultSearchMode: coerceXSearchMode(doc.defaultSearchMode),
    bootstrapScript:
      doc.bootstrapScript?.trim() ||
      process.env.X_SOCIAL_BOOTSTRAP_SCRIPT?.trim() ||
      "D:/tools_work/one-company/openclaw/scripts/open-x-social.ps1",
    bootstrapTimeoutMs: Math.max(15000, doc.bootstrapTimeoutMs ?? 45000),
    userDataDir:
      doc.userDataDir?.trim() ||
      process.env.X_SOCIAL_USER_DATA_DIR?.trim() ||
      defaultUserDataDir,
    chromeExecutablePath:
      doc.chromeExecutablePath?.trim() ||
      process.env.X_SOCIAL_CHROME_EXECUTABLE?.trim() ||
      undefined,
  };
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForXPageReady(page: Page) {
  await page.waitForSelector('[data-testid="primaryColumn"], input[name="text"], article', {
    timeout: 30000,
  });
  await page.waitForTimeout(2500);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (/\/i\/flow\/login/i.test(url)) {
    return false;
  }
  return !(await page.locator('input[name="text"]').first().isVisible().catch(() => false));
}

async function extractStatus(page: Page): Promise<Pick<XStatusResult, "authenticated" | "currentUrl" | "handle">> {
  const authenticated = await isLoggedIn(page);
  const snapshot = await page.evaluate(() => {
    const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') as HTMLAnchorElement | null;
    const avatarWithHandle = Array.from(document.querySelectorAll("[data-testid]"))
      .map((node) => node.getAttribute("data-testid") || "")
      .find((value) => value.startsWith("UserAvatar-Container-"));
    const handleFromAvatar = avatarWithHandle?.replace("UserAvatar-Container-", "");
    const handleFromProfileHref = profileLink?.getAttribute("href")?.split("/").filter(Boolean)?.[0];
    return {
      currentUrl: location.href,
      handle: handleFromProfileHref || handleFromAvatar || undefined,
    };
  });
  return {
    authenticated,
    currentUrl: snapshot.currentUrl,
    ...(snapshot.handle ? { handle: snapshot.handle } : {}),
  };
}

async function extractPosts(page: Page, limit: number): Promise<XPostSummary[]> {
  const rawItems = await page.evaluate((requestedLimit) => {
    const items: Array<{
      url: string;
      authorHandle?: string;
      displayName?: string;
      text: string;
      timeIso?: string;
    }> = [];
    const seen = new Set<string>();

    for (const article of Array.from(document.querySelectorAll("article"))) {
      const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
        .map((node) => (node instanceof HTMLAnchorElement ? node.href : ""))
        .filter(Boolean);
      const canonicalUrl = links
        .map((href) => /^https:\/\/x\.com\/[^/]+\/status\/\d+/i.test(href) ? href : "")
        .map((href) => href ? href.replace(/\/(photo|video)\/\d+.*$/i, "") : "")
        .find(Boolean);
      if (!canonicalUrl || seen.has(canonicalUrl)) {
        continue;
      }
      seen.add(canonicalUrl);

      const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
        .map((node) => node.textContent || "")
        .join("\n")
        .trim();
      const timeIso =
        (article.querySelector("time") as HTMLTimeElement | null)?.getAttribute("datetime") || undefined;
      const displayName =
        Array.from(article.querySelectorAll('[data-testid="User-Name"]'))
          .map((node) => node.textContent?.trim() || "")
          .find(Boolean) || undefined;
      const authorHandle =
        /^https:\/\/x\.com\/([^/?#]+)\/status\//i.exec(canonicalUrl)?.[1] || undefined;

      items.push({
        url: canonicalUrl,
        ...(authorHandle ? { authorHandle } : {}),
        ...(displayName ? { displayName } : {}),
        text,
        ...(timeIso ? { timeIso } : {}),
      });

      if (items.length >= requestedLimit) {
        break;
      }
    }

    return items;
  }, limit);
  return rawItems.map((item) => ({
    ...item,
    url: normalizeXStatusUrl(item.url) ?? item.url,
    ...(item.authorHandle
      ? { authorHandle: item.authorHandle }
      : deriveHandleFromXStatusUrl(normalizeXStatusUrl(item.url) ?? item.url)
        ? { authorHandle: deriveHandleFromXStatusUrl(normalizeXStatusUrl(item.url) ?? item.url) }
        : {}),
  }));
}

async function ensureHomePage(page: Page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForXPageReady(page);
  if (!(await isLoggedIn(page))) {
    throw new Error("X browser lane is not logged in.");
  }
}

async function findPublishedPostOnProfile(params: {
  page: Page;
  handle: string;
  text: string;
  includeReplies?: boolean;
  attempts?: number;
}) {
  const target = normalizeXTextForMatch(params.text);
  const attempts = Math.max(1, params.attempts ?? 5);
  const profileUrls = [
    `https://x.com/${params.handle}`,
    ...(params.includeReplies ? [`https://x.com/${params.handle}/with_replies`] : []),
  ];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const profileUrl of profileUrls) {
      await params.page.goto(profileUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await waitForXPageReady(params.page);
      const items = await extractPosts(params.page, 20);
      const exact = items.find((item) => normalizeXTextForMatch(item.text) === target);
      if (exact) {
        return exact;
      }
      const fuzzy = items.find((item) => {
        const normalized = normalizeXTextForMatch(item.text);
        return normalized.startsWith(target) || target.startsWith(normalized);
      });
      if (fuzzy) {
        return fuzzy;
      }
    }
    await params.page.waitForTimeout(2000);
  }

  return undefined;
}

const execFileAsync = promisify(execFile);

function resolveChromeExecutablePath(explicitPath?: string) {
  const candidates = [
    explicitPath,
    process.env.CHROME_BIN,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
      : undefined,
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function maybeBootstrapXBrowser(config: RuntimeConfig) {
  const script = config.bootstrapScript?.trim();
  if (!script || !fs.existsSync(script)) {
    return false;
  }
  try {
    await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ],
      {
        timeout: config.bootstrapTimeoutMs,
        windowsHide: true,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function toPowerShellSingleQuoted(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function extractPortFromCdpUrl(cdpUrl: string) {
  const match = cdpUrl.match(/:(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : undefined;
}

async function stopStaleChromeProcesses(config: RuntimeConfig) {
  const port = extractPortFromCdpUrl(config.cdpUrl);
  const profileDir = toPowerShellSingleQuoted(config.userDataDir);
  const command = [
    `$profileDir = ${profileDir}`,
    ...(port ? [`$port = ${port}`] : []),
    "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" |",
    "Where-Object {",
    "  $_.CommandLine -and (",
    ...(port
      ? [
          `    $_.CommandLine -like "*--remote-debugging-port=$port*" -or`,
        ]
      : []),
    "    $_.CommandLine -like (\"*\" + $profileDir + \"*\")",
    "  )",
    "} |",
    "ForEach-Object {",
    "  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}",
    "}",
  ].join("\n");
  await execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      timeout: 15000,
      windowsHide: true,
    },
  ).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

async function launchPersistentWithRetry(config: RuntimeConfig, originalError: unknown) {
  const executablePath = resolveChromeExecutablePath(config.chromeExecutablePath);
  if (!executablePath) {
    throw originalError;
  }
  fs.mkdirSync(config.userDataDir, { recursive: true });
  let lastError: unknown = originalError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(config.userDataDir, {
        executablePath,
        headless: false,
        args: [
          "--new-window",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await stopStaleChromeProcesses(config);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

async function withBrowserPage<T>(cdpUrl: string, fn: (page: Page, context: BrowserContext) => Promise<T>) {
  const config = loadRuntimeConfig();
  let browser;
  let context: BrowserContext | undefined;
  let launchedPersistent = false;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    try {
      context = await launchPersistentWithRetry(config, error);
      launchedPersistent = true;
    } catch (fallbackError) {
      const bootstrapped = await maybeBootstrapXBrowser(config);
      if (bootstrapped) {
        browser = await chromium.connectOverCDP(cdpUrl);
      } else {
        throw fallbackError;
      }
    }
  }
  try {
    context = context ?? browser!.contexts()[0] ?? (await browser!.newContext());
    const page = await context.newPage();
    try {
      return await fn(page, context);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    if (launchedPersistent) {
      await context?.close().catch(() => undefined);
    } else {
      await browser?.close().catch(() => undefined);
    }
  }
}

export class XSocialService {
  private readonly config = loadRuntimeConfig();

  async status(): Promise<XStatusResult> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        reachable: false,
        authenticated: false,
        cdpUrl: this.config.cdpUrl,
        activeChannelLabel: this.config.activeChannelLabel,
      };
    }
    try {
      return await withBrowserPage(this.config.cdpUrl, async (page) => {
        await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
        await waitForXPageReady(page);
        const snapshot = await extractStatus(page);
        return {
          enabled: true,
          reachable: true,
          authenticated: snapshot.authenticated,
          cdpUrl: this.config.cdpUrl,
          activeChannelLabel: this.config.activeChannelLabel,
          ...(snapshot.currentUrl ? { currentUrl: snapshot.currentUrl } : {}),
          ...(snapshot.handle ? { handle: snapshot.handle } : {}),
        };
      });
    } catch (error) {
      return {
        enabled: true,
        reachable: false,
        authenticated: false,
        cdpUrl: this.config.cdpUrl,
        activeChannelLabel: this.config.activeChannelLabel,
        lastError: summarizeError(error),
      };
    }
  }

  async homeFeed(params: { limit?: number } = {}): Promise<XFeedResult> {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 20);
    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      const items = await extractPosts(page, limit);
      return {
        source: "home",
        items,
      };
    });
  }

  async actorFeed(params: { actor?: string; limit?: number } = {}): Promise<XFeedResult> {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 20);
    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      const status = await extractStatus(page);
      const actor = normalizeXActor(params.actor) || status.handle;
      if (!actor) {
        throw new Error("X actor handle is unavailable.");
      }
      await page.goto(`https://x.com/${actor}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForXPageReady(page);
      const items = await extractPosts(page, limit);
      return {
        source: actor,
        items,
      };
    });
  }

  async searchPosts(params: { q: string; limit?: number; mode?: string }): Promise<XFeedResult> {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 20);
    const mode = coerceXSearchMode(params.mode || this.config.defaultSearchMode);
    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      await page.goto(buildXSearchUrl(params.q, mode), {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await waitForXPageReady(page);
      const items = await extractPosts(page, limit);
      return {
        source: `search:${params.q.trim()}`,
        items,
      };
    });
  }

  async reviewSnapshot(params: {
    homeLimit?: number;
    searchLimit?: number;
    searchTopics?: string[];
    mode?: string;
  }): Promise<XReviewSnapshotResult> {
    const homeLimit = Math.min(Math.max(params.homeLimit ?? 5, 1), 20);
    const searchLimit = Math.min(Math.max(params.searchLimit ?? 3, 1), 20);
    const mode = coerceXSearchMode(params.mode || this.config.defaultSearchMode);
    const topics = (params.searchTopics ?? []).map((topic) => topic.trim()).filter(Boolean);

    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      const snapshot = await extractStatus(page);
      const home: XFeedResult = {
        source: "home",
        items: await extractPosts(page, homeLimit),
      };
      const searches: Array<{ topic: string; result: XFeedResult }> = [];
      for (const topic of topics) {
        await page.goto(buildXSearchUrl(topic, mode), {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await waitForXPageReady(page);
        searches.push({
          topic,
          result: {
            source: `search:${topic}`,
            items: await extractPosts(page, searchLimit),
          },
        });
      }
      return {
        status: {
          enabled: true,
          reachable: true,
          authenticated: snapshot.authenticated,
          cdpUrl: this.config.cdpUrl,
          activeChannelLabel: this.config.activeChannelLabel,
          ...(snapshot.currentUrl ? { currentUrl: snapshot.currentUrl } : {}),
          ...(snapshot.handle ? { handle: snapshot.handle } : {}),
        },
        home,
        searches,
      };
    });
  }

  async readThread(params: { url: string; limit?: number }): Promise<XThreadResult> {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 30);
    const targetUrl = params.url.trim();
    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForXPageReady(page);
      const items = await extractPosts(page, limit);
      return {
        url: targetUrl,
        items,
      };
    });
  }

  previewPost(params: { text: string }): XPostPreviewResult {
    const text = params.text.trim();
    const length = estimateXTextLength(text);
    const maxLength = 280;
    return {
      text,
      length,
      maxLength,
      fitsLimit: length <= maxLength,
      activeChannelLabel: this.config.activeChannelLabel,
    };
  }

  async publishPost(params: { text: string; dryRun?: boolean }): Promise<XPublishResult> {
    const preview = this.previewPost({ text: params.text });
    if (params.dryRun) {
      return {
        ...preview,
        dryRun: true,
        published: false,
      };
    }
    if (!preview.fitsLimit) {
      throw new Error(`X post exceeds ${preview.maxLength} characters.`);
    }
    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      const status = await extractStatus(page);
      const handle = normalizeXActor(status.handle);
      if (!handle) {
        throw new Error("X browser lane is authenticated but the current handle is unavailable.");
      }
      const composer = page.locator('[data-testid="tweetTextarea_0"]').first();
      await composer.waitFor({ state: "visible", timeout: 15000 });
      await composer.click();
      await page.keyboard.insertText(preview.text);
      const button = page.locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]').first();
      await button.waitFor({ state: "visible", timeout: 15000 });
      await button.click();
      await page.waitForTimeout(3000);
      const publishedPost = await findPublishedPostOnProfile({
        page,
        handle,
        text: preview.text,
        includeReplies: false,
      });
      if (!publishedPost?.url) {
        throw new Error("Could not verify a real X status URL after publishing.");
      }
      return {
        ...preview,
        dryRun: false,
        published: true,
        url: publishedPost.url,
      };
    });
  }

  async replyPost(params: { url: string; text: string; dryRun?: boolean }): Promise<XReplyResult> {
    const preview = this.previewPost({ text: params.text });
    const parentUrl = params.url.trim();
    if (params.dryRun) {
      return {
        ...preview,
        dryRun: true,
        published: false,
        parentUrl,
      };
    }
    if (!preview.fitsLimit) {
      throw new Error(`X reply exceeds ${preview.maxLength} characters.`);
    }
    return withBrowserPage(this.config.cdpUrl, async (page) => {
      await ensureHomePage(page);
      const status = await extractStatus(page);
      const handle = normalizeXActor(status.handle);
      if (!handle) {
        throw new Error("X browser lane is authenticated but the current handle is unavailable.");
      }
      await page.goto(parentUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await waitForXPageReady(page);
      const replyButton = page.locator('[data-testid="reply"]').first();
      await replyButton.waitFor({ state: "visible", timeout: 15000 });
      await replyButton.click();
      const composer = page.locator('[data-testid="tweetTextarea_0"]').first();
      await composer.waitFor({ state: "visible", timeout: 15000 });
      await composer.click();
      await page.keyboard.insertText(preview.text);
      const button = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
      await button.waitFor({ state: "visible", timeout: 15000 });
      await button.click();
      await page.waitForTimeout(3000);
      const publishedReply = await findPublishedPostOnProfile({
        page,
        handle,
        text: preview.text,
        includeReplies: true,
      });
      if (!publishedReply?.url) {
        throw new Error("Could not verify a real X reply URL after publishing.");
      }
      return {
        ...preview,
        dryRun: false,
        published: true,
        parentUrl,
        url: publishedReply.url,
      };
    });
  }

  static describePost(item: XPostSummary): string {
    const author = item.authorHandle ? `@${item.authorHandle}` : "unknown";
    const time = item.timeIso ?? "unknown time";
    return `${author} | ${time}\n${item.text}\n${item.url}`;
  }
}

export {
  buildXSearchUrl,
  coerceXSearchMode,
  deriveHandleFromXStatusUrl,
  estimateXTextLength,
  normalizeXStatusUrl,
  normalizeXTextForMatch,
  normalizeXActor,
};
