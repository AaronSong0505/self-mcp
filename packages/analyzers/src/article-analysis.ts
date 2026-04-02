import { describeImages, hasModelAccess, resolveAnalyzerRuntime, runStructuredArticleAnalysis } from "./openai-client.js";
import type {
  ArticleAnalysisResult,
  DigestRulesConfig,
  ExtractedArticle,
  ImageInsight,
} from "../../core/src/types.js";
import type { AnalyzerRuntime } from "./openai-client.js";

const GENERIC_NOVELTY_SIGNALS = [
  "发布",
  "开源",
  "推出",
  "上线",
  "首发",
  "首次",
  "新模型",
  "新架构",
  "新算法",
  "论文",
  "paper",
  "benchmark",
  "评测",
  "sota",
  "训练",
  "推理",
  "reasoning",
  "agent",
  "mcp",
];

function pickParagraphs(text: string, limit: number): string[] {
  return text
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

function collectKeywordMatches(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((keyword) => lower.includes(keyword.toLowerCase()));
}

function heuristicAnalysis(params: {
  article: ExtractedArticle;
  rules: DigestRulesConfig;
  imageInsights: ImageInsight[];
}): ArticleAnalysisResult {
  const runtime = resolveAnalyzerRuntime(params.rules);
  const title = params.article.title;
  const joinedText = `${title}\n${params.article.blurb ?? ""}\n${params.article.contentText}`;
  const includeHits = collectKeywordMatches(joinedText, params.rules.interests?.includeKeywords ?? []);
  const priorityHits = collectKeywordMatches(joinedText, params.rules.interests?.priorityKeywords ?? []);
  const companyHits = collectKeywordMatches(joinedText, params.rules.interests?.companyWatchlist ?? []);
  const deprioritizeHits = collectKeywordMatches(joinedText, params.rules.interests?.deprioritizeKeywords ?? []);
  const excludeHits = collectKeywordMatches(joinedText, params.rules.interests?.excludeKeywords ?? []);
  const noveltyHits = collectKeywordMatches(joinedText, GENERIC_NOVELTY_SIGNALS);
  const matchedRules =
    params.rules.labels?.content
      ?.filter((rule) => collectKeywordMatches(joinedText, rule.keywords).length > 0)
      ?? [];
  const contentLabels = matchedRules.map((rule) => rule.label);
  const weightedLabelScore = matchedRules.reduce((sum, rule) => sum + (rule.weight ?? 1), 0);

  const paragraphs = pickParagraphs(params.article.contentText, 3);
  const keyTakeaways = paragraphs.length > 0 ? paragraphs.map((entry) => truncate(entry, 90)) : [truncate(title, 90)];
  const summarySource = paragraphs.slice(0, 2).join(" ");
  const summary = truncate(summarySource || params.article.blurb || title, runtime.summaryMaxChars);

  const score =
    includeHits.length * 2 +
    priorityHits.length * 3 +
    Math.min(companyHits.length, 3) * 1.5 +
    Math.min(noveltyHits.length, 3) * 0.5 +
    weightedLabelScore +
    (params.imageInsights.length > 0 ? 1 : 0) -
    deprioritizeHits.length * 1.5 -
    excludeHits.length * 3;
  const listLabel =
    excludeHits.length > 0 && includeHits.length === 0
      ? "略过"
      : score >= 5
        ? "必读"
        : score >= 2
          ? "值得看"
          : score >= 0
            ? "信息备查"
            : "略过";
  const whyRelevant =
    priorityHits.length > 0
      ? `命中高优先级技术关键词：${priorityHits.join("、")}。`
      : companyHits.length > 0
        ? `涉及重点关注 AI 公司或模型生态：${companyHits.join("、")}。`
      : includeHits.length > 0
        ? `命中关注关键词：${includeHits.join("、")}。`
        : contentLabels.length > 0
          ? `属于 ${contentLabels.join(" / ")} 类内容。`
          : noveltyHits.length > 0
            ? `存在值得二次判断的新发布/新技术信号：${noveltyHits.join("、")}。`
            : "信息密度一般，保留作备查。";

  return {
    summary,
    whyRelevant,
    keyTakeaways,
    contentLabels: contentLabels.length > 0 ? contentLabels : ["未分类"],
    listLabel,
    digestEligible: listLabel !== "略过",
    relevanceScore: score,
    heroImages: params.imageInsights,
  };
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

export function mergeModelAnalysis(params: {
  heuristic: ArticleAnalysisResult;
  model: Record<string, unknown>;
  rules: DigestRulesConfig;
  runtime: AnalyzerRuntime;
  imageInsights: ImageInsight[];
}): ArticleAnalysisResult {
  const listLabels = params.rules.labels?.list ?? ["必读", "值得看", "信息备查", "略过"];
  const requestedLabel = String(params.model.listLabel ?? params.heuristic.listLabel).trim();
  const breakoutCandidate = Boolean(params.model.breakoutCandidate ?? false);
  const openWorldReason = String(params.model.openWorldReason ?? "").trim();

  let listLabel = listLabels.includes(requestedLabel) ? requestedLabel : params.heuristic.listLabel;
  if (breakoutCandidate && (listLabel === "略过" || listLabel === "信息备查")) {
    listLabel = "值得看";
  }

  let relevanceScore = Number(params.model.relevanceScore ?? params.heuristic.relevanceScore);
  if (!Number.isFinite(relevanceScore)) {
    relevanceScore = params.heuristic.relevanceScore;
  }
  if (breakoutCandidate) {
    relevanceScore += 2;
  }

  const whyRelevantBase = String(params.model.whyRelevant ?? params.heuristic.whyRelevant).trim();
  const whyRelevant =
    breakoutCandidate && openWorldReason
      ? `${whyRelevantBase} 黑马信号：${openWorldReason}`
      : whyRelevantBase;

  return {
    summary: truncate(String(params.model.summary ?? params.heuristic.summary).trim(), params.runtime.summaryMaxChars),
    whyRelevant,
    keyTakeaways: normalizeStringArray(params.model.keyTakeaways, params.heuristic.keyTakeaways).slice(0, 5),
    contentLabels: normalizeStringArray(params.model.contentLabels, params.heuristic.contentLabels),
    listLabel,
    digestEligible: breakoutCandidate ? true : Boolean(params.model.digestEligible ?? params.heuristic.digestEligible),
    relevanceScore,
    heroImages: params.imageInsights,
  };
}

export async function analyzeArticle(params: {
  article: ExtractedArticle;
  rules: DigestRulesConfig;
}): Promise<ArticleAnalysisResult> {
  const runtime = resolveAnalyzerRuntime(params.rules);
  let imageInsights: ImageInsight[] = params.article.images
    .slice(0, runtime.maxImages)
    .map((image) => ({ url: image.url }));

  if (hasModelAccess(runtime) && imageInsights.length > 0) {
    try {
      const descriptions = await describeImages({
        runtime,
        imageUrls: imageInsights.map((image) => image.url),
        articleTitle: params.article.title,
      });
      imageInsights = imageInsights.map((image, index) => ({
        ...image,
        insight: descriptions[index],
      }));
    } catch {
      // Keep raw hero image URLs when vision analysis fails.
    }
  }

  const heuristic = heuristicAnalysis({
    article: params.article,
    rules: params.rules,
    imageInsights,
  });

  if (!hasModelAccess(runtime)) {
    return heuristic;
  }

  try {
    const listLabels = params.rules.labels?.list ?? ["必读", "值得看", "信息备查", "略过"];
    const contentLabels = (params.rules.labels?.content ?? []).map((entry) => entry.label);
    const companyWatchlist = params.rules.interests?.companyWatchlist ?? [];
    const json = await runStructuredArticleAnalysis({
      runtime,
      prompt: [
        "你在为 Aaron 生成中文公众号晨报。",
        `用户关注目标：${params.rules.interests?.objective ?? "节省时间，优先高信息密度内容。"}`,
        `允许的 listLabel：${listLabels.join("、")}`,
        `建议的 contentLabels：${contentLabels.join("、") || "未分类"}`,
        `重点关注的 AI 公司/生态：${companyWatchlist.join("、") || "无固定名单"}`,
        "不要机械依赖既有关键词。如果文章提到新的黑马公司、黑马模型、黑马技术路线、重要论文、重要评测突破，哪怕它不在既有名单里，也要按开放世界判断提升优先级。",
        "如果你判断它属于值得持续关注的新公司/新技术/重要发布，请把 breakoutCandidate 设为 true，并在 openWorldReason 里说明原因。",
        "请严格返回 JSON：",
        `{\"summary\":\"...\",\"whyRelevant\":\"...\",\"keyTakeaways\":[\"...\"],\"contentLabels\":[\"...\"],\"listLabel\":\"...\",\"digestEligible\":true,\"relevanceScore\":0,\"breakoutCandidate\":false,\"openWorldReason\":\"...\"}`,
        "文章标题：",
        params.article.title,
        "文章摘要候选：",
        params.article.blurb ?? "",
        "正文：",
        truncate(params.article.contentText, 5000),
        "配图信息：",
        JSON.stringify(imageInsights, null, 2),
      ].join("\n\n"),
    });

    if (!json) {
      return heuristic;
    }

    return mergeModelAnalysis({
      heuristic,
      model: json,
      rules: params.rules,
      runtime,
      imageInsights,
    });
  } catch {
    return heuristic;
  }
}
