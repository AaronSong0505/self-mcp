import { describe, expect, it } from "vitest";
import { parseJsonListCandidates } from "../packages/extractors/src/discovery.js";
import type { SourceConfig } from "../packages/core/src/types.js";

describe("parseJsonListCandidates", () => {
  it("extracts candidates from configured JSON paths", () => {
    const source: SourceConfig = {
      id: "jiqizhixin",
      displayName: "机器之心",
      discovery: {
        type: "json_list",
        url: "https://www.jiqizhixin.com/api/article_library/articles.json?page=1&per=20",
        json: {
          listPath: "articles",
          titleField: "title",
          linkField: "slug",
          linkTemplate: "https://www.jiqizhixin.com/articles/{value}",
          blurbField: "content",
          publishedAtField: "publishedAt",
        },
      },
    };

    const raw = JSON.stringify({
      articles: [
        {
          title: "Claude Code 源码泄露了，有人用Python复刻了一个极简版",
          slug: "2026-04-01-11",
          content: "2026 年 3 月，Anthropic 在 npm 发布时不小心把 source map 一起打包进了生产版本。",
          publishedAt: "2026/04/01 22:31",
        },
      ],
    });

    const [candidate] = parseJsonListCandidates(raw, source);
    expect(candidate?.title).toContain("Claude Code");
    expect(candidate?.articleUrl).toBe("https://www.jiqizhixin.com/articles/2026-04-01-11");
    expect(candidate?.blurb).toContain("Anthropic");
    expect(candidate?.publishedAt).toBeTruthy();
  });
});
