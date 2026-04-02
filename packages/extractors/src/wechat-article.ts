import fs from "node:fs";
import { chromium } from "playwright-core";
import * as cheerio from "cheerio";
import type { ExtractedArticle, ExtractedImage } from "../../core/src/types.js";

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function uniqueImages(images: ExtractedImage[]): ExtractedImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (!image.url || seen.has(image.url)) {
      return false;
    }
    seen.add(image.url);
    if (/qrcode|code\.png|icon|avatar/i.test(image.url)) {
      return false;
    }
    if ((image.width ?? 999) < 80 && (image.height ?? 999) < 80) {
      return false;
    }
    return true;
  });
}

function normalizeImageUrl(raw: string | undefined, pageUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function cleanContentText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parsePublishedAt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\//g, "-").trim();
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parsePublishedAtFromHtml(html: string, $: cheerio.CheerioAPI): string | undefined {
  const explicit = $("#publish_time").text().trim();
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const ctMatch = html.match(/\bct\s*=\s*"?(?<ts>\d{10})"?/);
  const ts = ctMatch?.groups?.ts;
  if (ts) {
    const parsed = new Date(Number(ts) * 1000);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
}

export function parseArticleHtml(html: string, pageUrl: string): ExtractedArticle {
  const $ = cheerio.load(html);
  const contentRoot = $("#js_content").first().length ? $("#js_content").first() : $("article").first();
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("#activity-name").text().trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim();
  const author =
    $("#js_name").text().trim() ||
    $('meta[name="author"]').attr("content")?.trim() ||
    html.match(/var\s+nickname\s*=\s*htmlDecode\("(?<author>[^"]+)"\)/)?.groups?.author;
  const publishedAt = parsePublishedAtFromHtml(html, $);

  const images = uniqueImages(
    contentRoot
      .find("img")
      .toArray()
      .map((img) => {
        const node = $(img);
        const url = normalizeImageUrl(
          node.attr("data-src") || node.attr("src") || node.attr("data-original"),
          pageUrl,
        );
        return {
          url: url ?? "",
          width: Number(node.attr("data-w") || node.attr("width") || 0) || undefined,
          height: Number(node.attr("data-h") || node.attr("height") || 0) || undefined,
        };
      }),
  );

  const contentHtml = contentRoot.html()?.trim() || "";
  const contentText = cleanContentText(contentRoot.text());
  const blurb = contentText.slice(0, 120).trim() || undefined;

  return {
    title,
    author: author || undefined,
    publishedAt,
    contentText,
    contentHtml,
    blurb,
    images,
    rawUrl: pageUrl,
  };
}

function parseQbitaiArticleHtml(html: string, pageUrl: string): ExtractedArticle {
  const $ = cheerio.load(html);
  const root = $(".article").first().length ? $(".article").first() : $("article").first();
  const contentRoot = root.clone();
  contentRoot.find(".article_info, .zhaiyao, .line_font, .person_box, .tags, .share_pc, .share_box").remove();

  const title = root.find("h1").first().text().trim() || $("title").text().trim();
  const author = root.find(".article_info .author a").last().text().trim() || undefined;
  const publishedAt = parsePublishedAt(
    `${root.find(".article_info .date").first().text().trim()} ${root.find(".article_info .time").first().text().trim()}`.trim(),
  );
  const blurb = cleanContentText(root.find(".zhaiyao").first().text()).slice(0, 160).trim() || undefined;
  const images = uniqueImages(
    contentRoot
      .find("img")
      .toArray()
      .map((img) => ({
        url: normalizeImageUrl($(img).attr("src"), pageUrl) ?? "",
        width: Number($(img).attr("width") || 0) || undefined,
        height: Number($(img).attr("height") || 0) || undefined,
      })),
  );
  const contentHtml = contentRoot.html()?.trim() || "";
  const contentText = cleanContentText(contentRoot.text());

  return {
    title,
    author,
    publishedAt,
    contentText,
    contentHtml,
    blurb,
    images,
    rawUrl: pageUrl,
  };
}

function parseJiqizhixinArticlePayload(raw: string, pageUrl: string): ExtractedArticle {
  const payload = JSON.parse(raw) as {
    title?: string;
    published_at?: string;
    description?: string;
    cover_image_url?: string;
    content?: string;
    author?: { name?: string };
    seo?: { image?: string };
  };
  const contentHtml = payload.content ?? "";
  const $ = cheerio.load(`<article>${contentHtml}</article>`);
  const root = $("article").first();
  const contentText = cleanContentText(root.text());
  const images = uniqueImages(
    [
      payload.cover_image_url,
      payload.seo?.image,
      ...root
        .find("img")
        .toArray()
        .map((img) => $(img).attr("src")),
    ]
      .filter(Boolean)
      .map((src) => ({ url: normalizeImageUrl(src, pageUrl) ?? "" })),
  );

  return {
    title: String(payload.title ?? "").trim(),
    author: payload.author?.name?.trim() || undefined,
    publishedAt: parsePublishedAt(payload.published_at),
    contentText,
    contentHtml,
    blurb: payload.description?.trim() || contentText.slice(0, 160).trim() || undefined,
    images,
    rawUrl: pageUrl,
  };
}

function extractJsonFromBrowserHtml(html: string): string | undefined {
  const $ = cheerio.load(html);
  const pre = $("pre").first().text().trim();
  if (pre.startsWith("{")) {
    return pre;
  }
  const bodyText = $("body").text().trim();
  return bodyText.startsWith("{") ? bodyText : undefined;
}

function detectBrowserExecutable(): string | undefined {
  const envPath = process.env.WECHAT_DIGEST_BROWSER_EXECUTABLE;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function fetchViaBrowser(url: string): Promise<string | undefined> {
  const executablePath = detectBrowserExecutable();
  if (!executablePath) {
    return undefined;
  }
  const browser = await chromium.launch({
    executablePath,
    headless: false,
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2_500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

export async function extractArticle(
  url: string,
  opts: { browserFallback?: boolean } = {},
): Promise<ExtractedArticle> {
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname.endsWith("jiqizhixin.com") && parsedUrl.pathname.startsWith("/articles/")) {
    const slug = parsedUrl.pathname.split("/").filter(Boolean).pop();
    if (slug) {
      const apiUrl = `https://www.jiqizhixin.com/api/article_library/articles/${slug}`;
      const response = await fetch(apiUrl, {
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest",
          referer: url,
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch article API ${apiUrl}: ${response.status}`);
      }
      let payload = await response.text();
      if (payload.trim().startsWith("<")) {
        const browserHtml = await fetchViaBrowser(apiUrl);
        const browserPayload = browserHtml ? extractJsonFromBrowserHtml(browserHtml) : undefined;
        if (browserPayload) {
          payload = browserPayload;
        }
      }
      return parseJiqizhixinArticlePayload(payload, url);
    }
  }

  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch article ${url}: ${response.status}`);
  }
  let html = await response.text();
  let extracted = parsedUrl.hostname.endsWith("qbitai.com")
    ? parseQbitaiArticleHtml(html, url)
    : parseArticleHtml(html, url);
  if (extracted.contentText.length >= 80 || opts.browserFallback === false) {
    return extracted;
  }

  const browserHtml = await fetchViaBrowser(url);
  if (!browserHtml) {
    return extracted;
  }
  html = browserHtml;
  extracted = parsedUrl.hostname.endsWith("qbitai.com")
    ? parseQbitaiArticleHtml(html, url)
    : parseArticleHtml(html, url);
  return extracted;
}
