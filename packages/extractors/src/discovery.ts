import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import { canonicalizeUrl, nowIso, toDateKey } from "../../core/src/canonical.js";
import type { ArticleCandidate, SourceConfig } from "../../core/src/types.js";

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return await response.text();
}

function normalizePublishedAt(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function parseRssCandidates(xml: string, source: SourceConfig): Omit<ArticleCandidate, "articleId" | "status">[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const rssItems = (((parsed.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined)
    ?.item ?? []) as Array<Record<string, unknown>> | Record<string, unknown>;
  const atomEntries = (((parsed.feed as Record<string, unknown> | undefined)?.entry ?? []) as
    | Array<Record<string, unknown>>
    | Record<string, unknown>);

  const items = Array.isArray(rssItems)
    ? rssItems
    : rssItems
      ? [rssItems]
      : Array.isArray(atomEntries)
        ? atomEntries
        : atomEntries
          ? [atomEntries]
          : [];
  const now = nowIso();
  const discoveredDate = toDateKey(now);

  return items
    .map((item) => {
      const linkValue = item.link;
      const articleUrl =
        typeof linkValue === "string"
          ? linkValue
          : typeof linkValue === "object" && linkValue
            ? String((linkValue as Record<string, unknown>).href ?? "")
            : "";
      if (!articleUrl) {
        return null;
      }
      const title = String(item.title ?? "").trim();
      const blurb = String(item.description ?? item.summary ?? "").replace(/<[^>]+>/g, " ").trim();
      const publishedAt = normalizePublishedAt(
        String(item.pubDate ?? item.updated ?? item.published ?? "").trim() || undefined,
      );
      return {
        sourceId: source.id,
        title,
        blurb: blurb || undefined,
        canonicalUrl: canonicalizeUrl(articleUrl),
        articleUrl,
        publishedAt,
        discoveredAt: now,
        discoveredDate,
      };
    })
    .filter(Boolean) as Omit<ArticleCandidate, "articleId" | "status">[];
}

export function parseHtmlListCandidates(
  html: string,
  source: SourceConfig,
): Omit<ArticleCandidate, "articleId" | "status">[] {
  if (!source.discovery.selectors) {
    throw new Error(`html_list source ${source.id} is missing selectors`);
  }
  const $ = cheerio.load(html);
  const selectors = source.discovery.selectors;
  const now = nowIso();
  const discoveredDate = toDateKey(now);

  return $(selectors.item)
    .toArray()
    .map((entry) => {
      const root = $(entry);
      const titleNode = root.find(selectors.title).first();
      const linkNode = root.find(selectors.link).first();
      const linkValue = linkNode.attr("href");
      if (!linkValue) {
        return null;
      }
      const articleUrl = new URL(linkValue, source.discovery.url).toString();
      const blurb = selectors.blurb ? root.find(selectors.blurb).first().text().trim() : undefined;
      const publishedRaw = selectors.publishedAt
        ? root.find(selectors.publishedAt).first().attr("datetime") ??
          root.find(selectors.publishedAt).first().text().trim()
        : undefined;
      return {
        sourceId: source.id,
        title: titleNode.text().trim(),
        blurb: blurb || undefined,
        canonicalUrl: canonicalizeUrl(articleUrl),
        articleUrl,
        publishedAt: normalizePublishedAt(publishedRaw),
        discoveredAt: now,
        discoveredDate,
      };
    })
    .filter(Boolean) as Omit<ArticleCandidate, "articleId" | "status">[];
}

function getByPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, input);
}

export function parseJsonListCandidates(
  raw: string,
  source: SourceConfig,
): Omit<ArticleCandidate, "articleId" | "status">[] {
  if (!source.discovery.json) {
    throw new Error(`json_list source ${source.id} is missing json selectors`);
  }

  const json = JSON.parse(raw) as unknown;
  const selectors = source.discovery.json;
  const list = getByPath(json, selectors.listPath);
  const items = Array.isArray(list) ? list : [];
  const now = nowIso();
  const discoveredDate = toDateKey(now);

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const title = String(getByPath(item, selectors.titleField) ?? "").trim();
      const linkValue = String(getByPath(item, selectors.linkField) ?? "").trim();
      if (!title || !linkValue) {
        return null;
      }

      const articleUrl = selectors.linkTemplate
        ? selectors.linkTemplate.replace("{value}", encodeURIComponent(linkValue))
        : new URL(linkValue, source.discovery.url).toString();
      const blurb = selectors.blurbField
        ? String(getByPath(item, selectors.blurbField) ?? "").trim()
        : undefined;
      const publishedRaw = selectors.publishedAtField
        ? String(getByPath(item, selectors.publishedAtField) ?? "").trim()
        : undefined;

      return {
        sourceId: source.id,
        title,
        blurb: blurb || undefined,
        canonicalUrl: canonicalizeUrl(articleUrl),
        articleUrl,
        publishedAt: normalizePublishedAt(publishedRaw),
        discoveredAt: now,
        discoveredDate,
      };
    })
    .filter(Boolean) as Omit<ArticleCandidate, "articleId" | "status">[];
}

export async function scanSource(source: SourceConfig): Promise<Omit<ArticleCandidate, "articleId" | "status">[]> {
  const body = await fetchText(source.discovery.url);
  if (source.discovery.type === "rss") {
    return parseRssCandidates(body, source);
  }
  if (source.discovery.type === "html_list") {
    return parseHtmlListCandidates(body, source);
  }
  if (source.discovery.type === "json_list") {
    return parseJsonListCandidates(body, source);
  }
  throw new Error(`Unsupported discovery type: ${source.discovery.type}`);
}
