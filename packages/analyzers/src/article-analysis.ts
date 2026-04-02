import { describeImages, hasModelAccess, resolveAnalyzerRuntime, runStructuredArticleAnalysis } from "./openai-client.js";
import type {
  ArticleAnalysisResult,
  DigestRulesConfig,
  ExtractedArticle,
  ImageInsight,
} from "../../core/src/types.js";

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
  const deprioritizeHits = collectKeywordMatches(joinedText, params.rules.interests?.deprioritizeKeywords ?? []);
  const excludeHits = collectKeywordMatches(joinedText, params.rules.interests?.excludeKeywords ?? []);
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
      : includeHits.length > 0
      ? `命中关注关键词：${includeHits.join("、")}。`
      : contentLabels.length > 0
        ? `属于 ${contentLabels.join(" / ")} 类内容。`
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
    const json = await runStructuredArticleAnalysis({
      runtime,
      prompt: [
        "你在为 Aaron 生成中文公众号晨报。",
        `用户关注目标：${params.rules.interests?.objective ?? "节省时间，优先高信息密度内容。"}`,
        `允许的 listLabel：${listLabels.join("、")}`,
        `建议的 contentLabels：${contentLabels.join("、") || "未分类"}`,
        "请严格返回 JSON：",
        `{\"summary\":\"...\",\"whyRelevant\":\"...\",\"keyTakeaways\":[\"...\"],\"contentLabels\":[\"...\"],\"listLabel\":\"...\",\"digestEligible\":true,\"relevanceScore\":0}`,
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

    const listLabel = String(json.listLabel ?? heuristic.listLabel).trim();
    return {
      summary: truncate(String(json.summary ?? heuristic.summary).trim(), runtime.summaryMaxChars),
      whyRelevant: String(json.whyRelevant ?? heuristic.whyRelevant).trim(),
      keyTakeaways: normalizeStringArray(json.keyTakeaways, heuristic.keyTakeaways).slice(0, 5),
      contentLabels: normalizeStringArray(json.contentLabels, heuristic.contentLabels),
      listLabel: listLabels.includes(listLabel) ? listLabel : heuristic.listLabel,
      digestEligible: Boolean(json.digestEligible ?? heuristic.digestEligible),
      relevanceScore: Number(json.relevanceScore ?? heuristic.relevanceScore),
      heroImages: imageInsights,
    };
  } catch {
    return heuristic;
  }
}
