import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArticleHtml } from "../packages/extractors/src/wechat-article.js";
import { parseRssCandidates } from "../packages/extractors/src/discovery.js";
import type { SourceConfig } from "../packages/core/src/types.js";

describe("wechat article extraction", () => {
  it("extracts title, text, author and non-trivial images", () => {
    const html = fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "wechat-article.fixture.html"),
      "utf8",
    );
    const article = parseArticleHtml(html, "https://mp.weixin.qq.com/s/sample");

    expect(article.title).toBe("一个真实结构的公众号文章样例");
    expect(article.author).toBe("测试公众号");
    expect(article.contentText).toContain("这是第一段");
    expect(article.images).toHaveLength(2);
  });

  it("parses rss candidates", () => {
    const xml = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-rss.xml"), "utf8");
    const source: SourceConfig = {
      id: "sample-rss",
      displayName: "Sample RSS",
      discovery: {
        type: "rss",
        url: "https://example.com/feed.xml",
      },
    };
    const items = parseRssCandidates(xml, source);

    expect(items).toHaveLength(2);
    expect(items[0]?.canonicalUrl).toBe("https://mp.weixin.qq.com/s/sample-1");
  });
});
