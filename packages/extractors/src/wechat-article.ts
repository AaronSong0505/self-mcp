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
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch article ${url}: ${response.status}`);
  }
  let html = await response.text();
  let extracted = parseArticleHtml(html, url);
  if (extracted.contentText.length >= 80 || opts.browserFallback === false) {
    return extracted;
  }

  const browserHtml = await fetchViaBrowser(url);
  if (!browserHtml) {
    return extracted;
  }
  html = browserHtml;
  extracted = parseArticleHtml(html, url);
  return extracted;
}
