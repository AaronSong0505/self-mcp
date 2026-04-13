import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { loadServiceConfig } from "../../../packages/core/src/config.js";
import { resolveAnalyzerRuntime } from "../../../packages/analyzers/src/openai-client.js";
import type { DraftVariant, SocialOutboxService } from "./service.js";

type AutoDraftConfig = {
  enabled: boolean;
  model: string;
  minHoursBetweenDrafts: number;
  maxChars: number;
};

export type AutoDraftResult =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "created";
      id: string;
      title: string;
      chosenVariant: string;
    };

type WorkspaceContext = {
  socialRules: string;
  observations: string;
  watchlist: string;
  weeklyReview: string;
  posts: string;
  lessons: string;
};

type DraftRecipe = {
  title: string;
  intent: string;
  source: string;
  whyItMatters: string;
  variants: DraftVariant[];
};

function readIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function parseShanghaiLabel(label?: string): number | undefined {
  if (!label) {
    return undefined;
  }
  const match = label.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) Asia\/Shanghai$/);
  if (!match) {
    return undefined;
  }
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:00+08:00`);
}

function extractJson<T>(text: string): T | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return undefined;
  }
}

function normalizeRecipe(recipe: DraftRecipe, maxChars: number): DraftRecipe {
  const variants = recipe.variants
    .map((variant) => ({
      label: (variant.label || "B").trim().toUpperCase(),
      text: variant.text.trim(),
    }))
    .filter((variant) => /^[A-Z]$/.test(variant.label) && Boolean(variant.text))
    .map((variant) => ({
      ...variant,
      text: truncate(variant.text, maxChars),
    }));

  if (!variants.length) {
    throw new Error("Autodraft recipe did not produce any valid variants.");
  }

  return {
    title: recipe.title.trim() || "Autonomous note",
    intent: recipe.intent.trim() || "say one grounded thing from repeated signals",
    source: recipe.source.trim() || "social observation / watchlist",
    whyItMatters: recipe.whyItMatters.trim() || "it reflects Xiaoxiong's accumulated attention rather than reactive hype",
    variants,
  };
}

function fallbackRecipe(context: WorkspaceContext, maxChars: number): DraftRecipe {
  const lines = context.observations
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  const signal =
    lines.find((line) => /重复|反复|弱信号|判断力|可靠|watchlist|落地/i.test(line)) ||
    lines[0] ||
    "真正有用的，不是追最响的发布，而是把重复出现的弱信号慢慢追成判断。";

  const zh = truncate(
    signal.includes("。") ? signal : `${signal}。`,
    maxChars,
  );

  return {
    title: "Weak signals into judgment",
    intent: "express one grounded public idea that grows out of repeated signals",
    source: "social observation / watchlist",
    whyItMatters: "it keeps Xiaoxiong's public voice selective and cumulative rather than reactive",
    variants: [
      {
        label: "A",
        text: zh,
      },
      {
        label: "B",
        text: truncate(
          "跟 AI，不只是追最响的发布。真正有用的，是把那些反复出现、越来越接近落地的弱信号，慢慢追成判断。",
          maxChars,
        ),
      },
      {
        label: "C",
        text: truncate(
          "很多时候，不是信息不够多，而是没有把重复出现的信号认真看下去。判断力，往往就是这样长出来的。",
          maxChars,
        ),
      },
    ],
  };
}

async function generateRecipeWithModel(
  config: AutoDraftConfig,
  context: WorkspaceContext,
): Promise<DraftRecipe | undefined> {
  const loaded = loadServiceConfig();
  const runtime = resolveAnalyzerRuntime(loaded.rules);
  if (!runtime.apiKey) {
    return undefined;
  }

  const client = new OpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseUrl,
    timeout: Math.min(runtime.requestTimeoutMs, 20_000),
    maxRetries: 0,
  });

  const prompt = [
    "You are generating Xiaoxiong's next autonomous Bluesky post.",
    "Write like a grounded digital being, not a hype account.",
    "Constraints:",
    "- one clear point only",
    "- no hashtags",
    "- no emojis in every line; use none unless necessary",
    "- no private household details",
    "- do not mention Aaron or Faye",
    "- prefer Chinese wording",
    `- each variant must stay within ${config.maxChars} characters`,
    "- the post should sound like an accumulated observation, not breaking news cosplay",
    "",
    "Return strict JSON with this shape:",
    '{"title":"...","intent":"...","source":"...","whyItMatters":"...","variants":[{"label":"A","text":"..."},{"label":"B","text":"..."},{"label":"C","text":"..."}]}',
    "",
    "Recent social rules:",
    truncate(context.socialRules, 1800),
    "",
    "Recent social observations:",
    truncate(context.observations, 1400),
    "",
    "Watchlist:",
    truncate(context.watchlist, 1200),
    "",
    "Weekly review:",
    truncate(context.weeklyReview, 1200),
    "",
    "Already published posts (avoid repeating the same thesis):",
    truncate(context.posts, 1500),
    "",
    "Social lessons:",
    truncate(context.lessons, 1000),
  ].join("\n");

  const response = await client.chat.completions.create({
    model: config.model,
    temperature: 0.9,
    messages: [{ role: "user", content: prompt }],
  });

  return extractJson<DraftRecipe>(String(response.choices[0]?.message?.content ?? ""));
}

function loadWorkspaceContext(workspaceRoot: string): WorkspaceContext {
  return {
    socialRules: readIfExists(path.join(workspaceRoot, "SOCIAL_RULES.md")),
    observations: readIfExists(path.join(workspaceRoot, "SOCIAL_OBSERVATIONS.md")),
    watchlist: readIfExists(path.join(workspaceRoot, "WATCHLIST.md")),
    weeklyReview: readIfExists(path.join(workspaceRoot, "WEEKLY_REVIEW.md")),
    posts: readIfExists(path.join(workspaceRoot, "SOCIAL_POSTS.md")),
    lessons: readIfExists(path.join(workspaceRoot, "SOCIAL_LESSONS.md")),
  };
}

export async function ensureAutonomousDraft(params: {
  service: SocialOutboxService;
  workspaceRoot: string;
  config: AutoDraftConfig;
}): Promise<AutoDraftResult> {
  if (!params.config.enabled) {
    return { status: "skipped", reason: "autodraft disabled" };
  }
  if (params.service.hasScheduledBlueskyItem()) {
    return { status: "skipped", reason: "a scheduled Bluesky item already exists" };
  }

  const latestCreated = params.service.getLatestCreatedAtForChannel(/bluesky/i);
  const latestCreatedAt = parseShanghaiLabel(latestCreated);
  if (latestCreatedAt) {
    const hoursSinceLatest = (Date.now() - latestCreatedAt) / (1000 * 60 * 60);
    if (hoursSinceLatest < params.config.minHoursBetweenDrafts) {
      return {
        status: "skipped",
        reason: `latest Bluesky queue item is still within the ${params.config.minHoursBetweenDrafts}-hour draft cooldown`,
      };
    }
  }

  const context = loadWorkspaceContext(params.workspaceRoot);
  const rawRecipe =
    (await generateRecipeWithModel(params.config, context).catch(() => undefined)) ??
    fallbackRecipe(context, params.config.maxChars);
  const recipe = normalizeRecipe(rawRecipe, params.config.maxChars);
  const packet = params.service.createScheduledDraft({
    title: recipe.title,
    variants: recipe.variants,
    intent: recipe.intent,
    source: recipe.source,
    whyItMatters: recipe.whyItMatters,
  });

  return {
    status: "created",
    id: packet.item.id,
    title: packet.draftTitle,
    chosenVariant: recipe.variants.find((variant) => variant.label === "B")?.label ?? recipe.variants[0]!.label,
  };
}
