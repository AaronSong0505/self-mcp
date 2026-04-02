import OpenAI from "openai";
import type { DigestRulesConfig } from "../../core/src/types.js";

export type AnalyzerRuntime = {
  baseUrl: string;
  apiKey?: string;
  articleModel: string;
  visionModel: string;
  maxImages: number;
  summaryMaxChars: number;
};

export function resolveAnalyzerRuntime(rules: DigestRulesConfig): AnalyzerRuntime {
  return {
    baseUrl:
      process.env.WECHAT_DIGEST_OPENAI_BASE_URL ||
      rules.analysis?.baseUrl ||
      "https://coding.dashscope.aliyuncs.com/v1",
    apiKey: process.env.DASHSCOPE_API_KEY,
    articleModel: process.env.WECHAT_DIGEST_ARTICLE_MODEL || rules.analysis?.articleModel || "qwen3.5-plus",
    visionModel: process.env.WECHAT_DIGEST_VISION_MODEL || rules.analysis?.visionModel || "qwen3.5-plus",
    maxImages: Math.max(0, rules.analysis?.maxImages ?? 2),
    summaryMaxChars: Math.max(120, rules.analysis?.summaryMaxChars ?? 220),
  };
}

export function hasModelAccess(runtime: AnalyzerRuntime): boolean {
  return Boolean(runtime.apiKey);
}

function createClient(runtime: AnalyzerRuntime): OpenAI {
  if (!runtime.apiKey) {
    throw new Error("DASHSCOPE_API_KEY is missing.");
  }
  return new OpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseUrl,
  });
}

function extractJson(text: string): Record<string, unknown> | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function runStructuredArticleAnalysis(params: {
  runtime: AnalyzerRuntime;
  prompt: string;
}): Promise<Record<string, unknown> | undefined> {
  const client = createClient(params.runtime);
  const response = await client.chat.completions.create({
    model: params.runtime.articleModel,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: params.prompt,
      },
    ],
  });
  const text = response.choices[0]?.message?.content ?? "";
  return extractJson(text);
}

export async function describeImages(params: {
  runtime: AnalyzerRuntime;
  imageUrls: string[];
  articleTitle: string;
}): Promise<string[]> {
  if (!params.imageUrls.length) {
    return [];
  }
  const client = createClient(params.runtime);
  const response = await client.chat.completions.create({
    model: params.runtime.visionModel,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `请用简洁中文描述这些公众号配图与文章《${params.articleTitle}》的关系。每张图一句话，按数组 JSON 返回，例如 ["图1 ...","图2 ..."]。`,
          },
          ...params.imageUrls.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ],
      },
    ],
  });
  const content = response.choices[0]?.message?.content ?? "";
  const parsed = content.match(/\[[\s\S]*\]/);
  if (!parsed) {
    return [];
  }
  try {
    const arr = JSON.parse(parsed[0]) as unknown[];
    return arr.map((entry) => String(entry)).filter(Boolean);
  } catch {
    return [];
  }
}
