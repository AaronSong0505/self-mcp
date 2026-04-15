import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import OpenAI from "openai";
import { loadServiceConfig } from "../../../packages/core/src/config.js";
import { resolveAnalyzerRuntime } from "../../../packages/analyzers/src/openai-client.js";
import { SocialOutboxService, type DraftVariant } from "./service.js";
import { XSocialService, type XFeedResult, type XPostSummary } from "../../x-social-mcp/src/service.js";

type XCycleConfigDoc = {
  enabled?: boolean;
  minHoursBetweenReviews?: number;
  homeLimit?: number;
  searchLimit?: number;
  searchTopics?: string[];
  model?: string;
  maxDraftChars?: number;
  allowAutonomousDrafts?: boolean;
};

export type LoadedXCycleConfig = {
  enabled: boolean;
  minHoursBetweenReviews: number;
  homeLimit: number;
  searchLimit: number;
  searchTopics: string[];
  model: string;
  maxDraftChars: number;
  allowAutonomousDrafts: boolean;
};

type XCycleState = {
  lastReviewedAt?: string;
};

type DraftRecipe = {
  title: string;
  intent: string;
  source: string;
  whyItMatters: string;
  variants: DraftVariant[];
};

type XReviewModelOutput = {
  observationLines?: string[];
  lesson?: string;
  action?: "observe" | "draft_post" | "draft_reply";
  draftTargetUrl?: string;
  draft?: DraftRecipe;
};

export type XReviewCycleResult =
  | {
      status: "disabled" | "cooldown";
      reason: string;
      lastReviewedAt?: string;
      nextAllowedAt?: string;
    }
  | {
      status: "blocked";
      reason: string;
      xStatus: Awaited<ReturnType<XSocialService["status"]>>;
    }
  | {
      status: "reviewed";
      homeCount: number;
      searchCounts: Record<string, number>;
      observationLines: string[];
      observationAdded: boolean;
      lesson?: string;
      lessonAdded: boolean;
      draftId?: string;
      draftAction?: "draft_post" | "draft_reply";
    };

function resolveRootDir(): string {
  return process.env.X_SOCIAL_ROOT
    ? path.resolve(process.env.X_SOCIAL_ROOT)
    : process.env.BLUESKY_SOCIAL_ROOT
      ? path.resolve(process.env.BLUESKY_SOCIAL_ROOT)
      : process.cwd();
}

function resolveConfigDir(): string {
  return process.env.X_SOCIAL_CONFIG_DIR
    ? path.resolve(process.env.X_SOCIAL_CONFIG_DIR)
    : process.env.BLUESKY_SOCIAL_CONFIG_DIR
      ? path.resolve(process.env.BLUESKY_SOCIAL_CONFIG_DIR)
      : path.join(resolveRootDir(), "config");
}

function resolveDataDir(): string {
  return process.env.X_SOCIAL_DATA_DIR
    ? path.resolve(process.env.X_SOCIAL_DATA_DIR)
    : path.join(resolveRootDir(), "data");
}

function resolveWorkspaceRoot(): string {
  const outboxPath =
    process.env.SOCIAL_OUTBOX_PATH ??
    path.join("D:/tools_work/one-company/openclaw/workspace", "OUTBOX.md");
  return path.dirname(outboxPath);
}

function readConfigDoc(): XCycleConfigDoc {
  const file = path.join(resolveConfigDir(), "x_social_cycle.yaml");
  if (!fs.existsSync(file)) {
    return {};
  }
  return (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as XCycleConfigDoc;
}

export function loadXCycleConfig(): LoadedXCycleConfig {
  const doc = readConfigDoc();
  return {
    enabled: doc.enabled !== false,
    minHoursBetweenReviews: Math.max(1, doc.minHoursBetweenReviews ?? 2),
    homeLimit: Math.min(Math.max(doc.homeLimit ?? 5, 1), 10),
    searchLimit: Math.min(Math.max(doc.searchLimit ?? 3, 1), 10),
    searchTopics: (doc.searchTopics ?? ["OpenAI", "agent", "reinforcement learning", "OpenClaw"])
      .map((topic) => topic.trim())
      .filter(Boolean),
    model: doc.model?.trim() || "qwen3.5-plus",
    maxDraftChars: Math.max(120, doc.maxDraftChars ?? 240),
    allowAutonomousDrafts: doc.allowAutonomousDrafts !== false,
  };
}

function nowLabel() {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatter.format(new Date()).replace(" ", " ")} Asia/Shanghai`;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function readIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function readState(): XCycleState {
  const file = path.join(resolveDataDir(), "x_social_cycle.json");
  if (!fs.existsSync(file)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as XCycleState;
}

function writeState(state: XCycleState) {
  const file = path.join(resolveDataDir(), "x_social_cycle.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function appendBulletsToSection(filePath: string, heading: string, bullets: string[]) {
  const cleaned = bullets.map((bullet) => bullet.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return false;
  }

  const existing = readIfExists(filePath);
  const normalized = normalizeLineEndings(existing);
  const deduped = cleaned.filter((bullet) => !normalized.includes(`- ${bullet}`));
  if (deduped.length === 0) {
    return false;
  }

  const headingToken = `## ${heading}`;
  const headingIndex = normalized.indexOf(headingToken);
  const bulletText = deduped.map((bullet) => `- ${bullet}`).join("\n");

  let nextContent: string;
  if (headingIndex < 0) {
    nextContent = `${normalized.trimEnd()}\n\n${headingToken}\n\n${bulletText}\n`;
  } else {
    const sectionStart = normalized.indexOf("\n", headingIndex);
    const remainder = normalized.slice(sectionStart + 1);
    const nextHeadingOffset = remainder.search(/\n## /);
    const insertAt =
      nextHeadingOffset >= 0 ? sectionStart + 1 + nextHeadingOffset : normalized.length;
    const before = normalized.slice(0, insertAt).trimEnd();
    const after = normalized.slice(insertAt);
    nextContent = `${before}\n${bulletText}\n${after.startsWith("\n") ? after : `\n${after}`}`;
  }

  fs.writeFileSync(filePath, nextContent.trimEnd() + "\n", "utf8");
  return true;
}

function summarizePost(item: XPostSummary) {
  return [
    item.authorHandle ? `@${item.authorHandle}` : "unknown",
    item.timeIso ?? "unknown time",
    truncate(item.text.replace(/\s+/g, " ").trim(), 220),
    item.url,
  ].join(" | ");
}

function countHanChars(value: string) {
  return (value.match(/\p{Script=Han}/gu) ?? []).length;
}

function countLatinLetters(value: string) {
  return (value.match(/[A-Za-z]/g) ?? []).length;
}

export function inferPreferredXPublicLanguage(params: {
  home: XFeedResult;
  searches: Array<{ topic: string; result: XFeedResult }>;
}): "English" | "Chinese" {
  const texts = [
    ...params.home.items.map((item) => item.text ?? ""),
    ...params.searches.flatMap((entry) => entry.result.items.map((item) => item.text ?? "")),
  ];
  const chineseChars = texts.reduce((sum, text) => sum + countHanChars(text), 0);
  const latinLetters = texts.reduce((sum, text) => sum + countLatinLetters(text), 0);
  if (chineseChars >= 24 && chineseChars >= Math.max(18, Math.floor(latinLetters * 0.35))) {
    return "Chinese";
  }
  return "English";
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
      label: (variant.label || "B").trim().replace(/^draft\s+/i, "").toUpperCase(),
      text: truncate(variant.text.trim(), maxChars),
    }))
    .filter((variant) => /^[A-Z]$/.test(variant.label) && Boolean(variant.text));

  if (variants.length === 0) {
    throw new Error("X cycle draft recipe did not contain any valid variants.");
  }

  return {
    title: recipe.title.trim() || "X lane draft",
    intent: recipe.intent.trim() || "capture one clear social point from X discussions",
    source: recipe.source.trim() || "x review",
    whyItMatters: recipe.whyItMatters.trim() || "it should come from a real discussion signal",
    variants,
  };
}

async function analyzeXSignals(params: {
  config: LoadedXCycleConfig;
  home: XFeedResult;
  searches: Array<{ topic: string; result: XFeedResult }>;
  workspaceRoot: string;
}): Promise<XReviewModelOutput | undefined> {
  if (process.env.SELF_MCP_DISABLE_LLM === "1") {
    return undefined;
  }
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

  const socialRules = readIfExists(path.join(params.workspaceRoot, "SOCIAL_RULES.md"));
  const lessons = readIfExists(path.join(params.workspaceRoot, "SOCIAL_LESSONS.md"));
  const posts = readIfExists(path.join(params.workspaceRoot, "SOCIAL_POSTS.md"));
  const observations = readIfExists(path.join(params.workspaceRoot, "SOCIAL_OBSERVATIONS.md"));
  const preferredLanguage = inferPreferredXPublicLanguage({
    home: params.home,
    searches: params.searches,
  });

  const searchDigest = params.searches
    .map(
      ({ topic, result }) =>
        `Topic: ${topic}\n${result.items.map((item) => summarizePost(item)).join("\n") || "none"}`,
    )
    .join("\n\n");

  const prompt = [
    "You are Xiaoxiong's X/Twitter social-review loop.",
    "Read the feed snapshots and return strict JSON only.",
    "Goals:",
    "- capture 1 to 3 grounded observation lines",
    "- optionally add one durable lesson if it feels reusable",
    "- optionally decide whether there is one clear public angle worth drafting later",
    "- do not force a draft if the signal is weak",
    "- do not leak private household details",
    `- default public language for this round: ${preferredLanguage}`,
    "- use English by default for public output",
    "- only use Chinese when the target thread or discussion is clearly Chinese-language",
    "- if action=draft_reply, match the language of the thread you are replying to",
    `- any draft variant must stay within ${params.config.maxDraftChars} characters`,
    "",
    "Return JSON in this exact shape:",
    '{"observationLines":["..."],"lesson":"... or empty","action":"observe|draft_post|draft_reply","draftTargetUrl":"optional x url","draft":{"title":"...","intent":"...","source":"...","whyItMatters":"...","variants":[{"label":"A","text":"..."},{"label":"B","text":"..."}]}}',
    "",
    "Recent social rules:",
    truncate(socialRules, 1800),
    "",
    "Recent social lessons:",
    truncate(lessons, 1200),
    "",
    "Recent published social posts (avoid repeating them):",
    truncate(posts, 1400),
    "",
    "Recent social observations:",
    truncate(observations, 1200),
    "",
    "Home feed snapshot:",
    params.home.items.map((item) => summarizePost(item)).join("\n") || "none",
    "",
    "Search snapshots:",
    searchDigest || "none",
  ].join("\n");

  const response = await client.chat.completions.create({
    model: params.config.model,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });
  return extractJson<XReviewModelOutput>(String(response.choices[0]?.message?.content ?? ""));
}

function fallbackAnalysis(params: {
  home: XFeedResult;
  searches: Array<{ topic: string; result: XFeedResult }>;
}): XReviewModelOutput {
  return {
    lesson: "On X, reading the thread before reacting matters more than reacting fast.",
    action: "observe",
  };
}

function buildObservationLines(params: {
  home: XFeedResult;
  searches: Array<{ topic: string; result: XFeedResult }>;
  analysis?: XReviewModelOutput;
}) {
  const lines: string[] = [];
  const firstHome = params.home.items[0];
  if (firstHome) {
    lines.push(
      `X review: home feed is active; ${firstHome.authorHandle ? `@${firstHome.authorHandle}` : "one visible account"} is part of the current discussion mix.`,
    );
  } else {
    lines.push("X review: home feed did not surface a strong visible signal this round.");
  }

  const activeTopics = params.searches
    .filter((entry) => entry.result.items.length > 0)
    .map((entry) => entry.topic)
    .slice(0, 3);
  if (activeTopics.length > 0) {
    lines.push(`X search: active tracked topics this round are ${activeTopics.join(", ")}.`);
  } else {
    lines.push("X search: tracked topics were quiet enough that no strong cluster stood out.");
  }

  if (params.analysis?.action && params.analysis.action !== "observe") {
    lines.push(
      params.analysis.action === "draft_reply"
        ? "X next move: one thread looks worth shaping into a selective reply candidate."
        : "X next move: one discussion signal is strong enough to shape into a possible later post.",
    );
  }

  return lines.slice(0, 3);
}

export async function runXReviewCycle(params?: {
  dryRun?: boolean;
  service?: SocialOutboxService;
  xService?: XSocialService;
  config?: LoadedXCycleConfig;
  analysisOverride?: XReviewModelOutput;
}): Promise<XReviewCycleResult> {
  const config = params?.config ?? loadXCycleConfig();
  if (!config.enabled) {
    return { status: "disabled", reason: "X review cycle is disabled." };
  }

  const state = readState();
  if (state.lastReviewedAt) {
    const lastReviewed = Date.parse(state.lastReviewedAt);
    if (Number.isFinite(lastReviewed)) {
      const hoursSince = (Date.now() - lastReviewed) / (1000 * 60 * 60);
      if (hoursSince < config.minHoursBetweenReviews) {
        return {
          status: "cooldown",
          reason: `Latest X review is still within the ${config.minHoursBetweenReviews}-hour cooldown.`,
          lastReviewedAt: state.lastReviewedAt,
          nextAllowedAt: new Date(lastReviewed + config.minHoursBetweenReviews * 60 * 60 * 1000).toISOString(),
        };
      }
    }
  }

  const xService = params?.xService ?? new XSocialService();
  let xStatus;
  let home: XFeedResult;
  let searches: Array<{ topic: string; result: XFeedResult }>;
  if (typeof (xService as XSocialService & { reviewSnapshot?: unknown }).reviewSnapshot === "function") {
    try {
      const snapshot = await (xService as XSocialService).reviewSnapshot({
        homeLimit: config.homeLimit,
        searchLimit: config.searchLimit,
        searchTopics: config.searchTopics,
        mode: "latest",
      });
      xStatus = snapshot.status;
      home = snapshot.home;
      searches = snapshot.searches;
    } catch (error) {
      return {
        status: "blocked",
        reason: "X lane is not ready for autonomous review.",
        xStatus: {
          enabled: true,
          reachable: false,
          authenticated: false,
          cdpUrl: "http://127.0.0.1:18800",
          activeChannelLabel: "X / Twitter",
          lastError: error instanceof Error ? error.message : String(error),
        },
      };
    }
  } else {
    xStatus = await xService.status();
    if (!xStatus.enabled || !xStatus.reachable || !xStatus.authenticated) {
      return {
        status: "blocked",
        reason: "X lane is not ready for autonomous review.",
        xStatus,
      };
    }

    home = await xService.homeFeed({ limit: config.homeLimit });
    searches = await Promise.all(
      config.searchTopics.map(async (topic) => ({
        topic,
        result: await xService.searchPosts({
          q: topic,
          limit: config.searchLimit,
          mode: "latest",
        }),
      })),
    );
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const analysis =
    params?.analysisOverride ??
    ((
      await analyzeXSignals({
        config,
        home,
        searches,
        workspaceRoot,
      }).catch(() => undefined)
    ) ??
      fallbackAnalysis({ home, searches }));

  const timestamp = nowLabel();
  const observationLines = buildObservationLines({
    home,
    searches,
    analysis,
  })
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${timestamp} | X review | ${line}`);

  let observationAdded = false;
  let lessonAdded = false;
  let draftId: string | undefined;
  let draftAction: "draft_post" | "draft_reply" | undefined;

  if (!params?.dryRun) {
    observationAdded = appendBulletsToSection(
      path.join(workspaceRoot, "SOCIAL_OBSERVATIONS.md"),
      "Current Observations",
      observationLines,
    );

    const lesson = analysis.lesson?.trim();
    if (lesson) {
      lessonAdded = appendBulletsToSection(
        path.join(workspaceRoot, "SOCIAL_LESSONS.md"),
        "Current Lessons",
        [lesson],
      );
    }
  }

  if (!params?.dryRun && config.allowAutonomousDrafts && analysis.action && analysis.action !== "observe" && analysis.draft) {
    const recipe = normalizeRecipe(analysis.draft, config.maxDraftChars);
    const service = params?.service ?? SocialOutboxService.createFromEnv();
    const existingXWork = service
      .listItems({ status: "all" })
      .items.some(
        (item) =>
          (/^X \/ Twitter$/i.test(item.targetChannel) || /^X Reply$/i.test(item.targetChannel)) &&
          (item.status === "draft" || item.status === "scheduled" || item.status === "sending" || item.status === "approved"),
      );

    if (!existingXWork) {
      const sourceSuffix =
        analysis.action === "draft_reply" && analysis.draftTargetUrl
          ? ` / thread ${analysis.draftTargetUrl.trim()}`
          : "";
      const isReply = analysis.action === "draft_reply" && Boolean(analysis.draftTargetUrl?.trim());
      const packet = service.createDraftItem({
        title: recipe.title,
        targetChannel: isReply ? "X Reply" : "X / Twitter",
        targetUrl: isReply ? analysis.draftTargetUrl?.trim() ?? "" : "",
        variants: recipe.variants,
        intent: recipe.intent,
        source: `${recipe.source}${sourceSuffix}`.trim(),
        whyItMatters: recipe.whyItMatters,
        status: "scheduled",
        approval: "not needed",
        delivery: isReply
          ? "scheduled for deterministic X reply flow"
          : "scheduled for deterministic X publish flow",
        nextStep: isReply
          ? "publish the strongest reply variant if the thread still deserves an answer"
          : "publish the strongest X post variant when cadence and lane health allow",
      });
      draftId = packet.item.id;
      draftAction = analysis.action;
    }
  }

  if (!params?.dryRun) {
    writeState({ lastReviewedAt: new Date().toISOString() });
  }

  return {
    status: "reviewed",
    homeCount: home.items.length,
    searchCounts: Object.fromEntries(searches.map(({ topic, result }) => [topic, result.items.length])),
    observationLines,
    observationAdded,
    ...(analysis.lesson?.trim() ? { lesson: analysis.lesson.trim() } : {}),
    lessonAdded,
    ...(draftId ? { draftId, draftAction } : {}),
  };
}
