import { afterEach, describe, expect, it } from "vitest";
import { analyzeArticle, mergeModelAnalysis } from "../packages/analyzers/src/article-analysis.js";
import type { DigestRulesConfig, ExtractedArticle } from "../packages/core/src/types.js";
import type { AnalyzerRuntime } from "../packages/analyzers/src/openai-client.js";

const originalKey = process.env.DASHSCOPE_API_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.DASHSCOPE_API_KEY;
    return;
  }
  process.env.DASHSCOPE_API_KEY = originalKey;
});

const rules: DigestRulesConfig = {
  interests: {
    objective: "优先关注 AI 技术、强化学习与算法。",
    includeKeywords: ["AI", "强化学习", "RL", "benchmark", "论文", "编码"],
    priorityKeywords: ["强化学习", "RL", "PPO", "benchmark", "论文"],
    companyWatchlist: ["OpenAI", "Anthropic", "DeepSeek"],
    deprioritizeKeywords: ["融资", "股价", "市值"],
    excludeKeywords: ["广告", "抽奖"],
  },
  labels: {
    list: ["必读", "值得看", "信息备查", "略过"],
    content: [
      {
        label: "RL/Algorithms",
        keywords: ["强化学习", "RL", "PPO", "actor-critic"],
        weight: 3,
      },
      {
        label: "Research/Papers",
        keywords: ["论文", "benchmark", "评测"],
        weight: 2,
      },
      {
        label: "Product/Strategy",
        keywords: ["产品", "商业化", "增长"],
        weight: 0.5,
      },
    ],
  },
};

function article(partial: Partial<ExtractedArticle>): ExtractedArticle {
  return {
    title: partial.title ?? "Untitled",
    author: partial.author,
    publishedAt: partial.publishedAt,
    contentText: partial.contentText ?? "",
    contentHtml: partial.contentHtml ?? "",
    blurb: partial.blurb,
    images: partial.images ?? [],
    rawUrl: partial.rawUrl ?? "https://example.com/article",
  };
}

const runtime: AnalyzerRuntime = {
  baseUrl: "https://example.com/v1",
  articleModel: "test-model",
  visionModel: "test-vision",
  maxImages: 2,
  summaryMaxChars: 220,
};

describe("article analysis preferences", () => {
  it("strongly favors technical RL articles", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    const result = await analyzeArticle({
      rules,
      article: article({
        title: "强化学习新论文：PPO 在长程推理 benchmark 上的改进",
        blurb: "论文聚焦 RL 对齐与 benchmark 结果。",
        contentText:
          "这篇论文讨论强化学习、PPO、actor-critic 和 benchmark 评测，给出训练细节与 ablation。",
        images: [{ url: "https://example.com/figure.png" }],
      }),
    });

    expect(result.listLabel).toBe("必读");
    expect(result.contentLabels).toContain("RL/Algorithms");
    expect(result.relevanceScore).toBeGreaterThanOrEqual(8);
  });

  it("deprioritizes market-style AI news without strong technical depth", async () => {
    delete process.env.DASHSCOPE_API_KEY;
    const result = await analyzeArticle({
      rules,
      article: article({
        title: "某 AI 公司股价再创新高，市值和融资规模双双上涨",
        blurb: "文章聚焦融资、股价、市值表现。",
        contentText: "主要内容围绕融资进展、股价变化、商业化节奏与品牌合作，没有展开技术实现。",
      }),
    });

    expect(result.listLabel).not.toBe("必读");
    expect(result.relevanceScore).toBeLessThan(5);
  });

  it("allows model open-world rescue for breakout companies or techniques", () => {
    const merged = mergeModelAnalysis({
      heuristic: {
        summary: "旧摘要",
        whyRelevant: "默认判断偏弱。",
        keyTakeaways: ["旧要点"],
        contentLabels: ["未分类"],
        listLabel: "信息备查",
        digestEligible: true,
        relevanceScore: 1,
        heroImages: [],
        ruleCandidates: [],
      },
      model: {
        summary: "某黑马团队发布新的训练框架。",
        whyRelevant: "新技术方向值得关注。",
        keyTakeaways: ["提出新训练方法"],
        contentLabels: ["Research/Papers"],
        listLabel: "信息备查",
        digestEligible: false,
        relevanceScore: 2,
        breakoutCandidate: true,
        openWorldReason: "虽未命中既有名单，但文章展示了新的训练路线和实验结果。",
      },
      rules,
      runtime,
      imageInsights: [],
    });

    expect(merged.listLabel).toBe("值得看");
    expect(merged.digestEligible).toBe(true);
    expect(merged.relevanceScore).toBe(4);
    expect(merged.whyRelevant).toContain("黑马信号");
  });
});
