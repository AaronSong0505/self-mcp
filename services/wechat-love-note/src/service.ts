import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import YAML from "yaml";
import { nowIso, toDateKey } from "../../../packages/core/src/canonical.js";
import { loadServiceConfig, resolveServicePaths } from "../../../packages/core/src/config.js";
import { SqliteStateStore } from "../../../packages/core/src/db.js";
import { sendDigestMessages } from "../../../packages/core/src/delivery.js";
import type { DeliveryTargetConfig, DigestMessage } from "../../../packages/core/src/types.js";
import { resolveAnalyzerRuntime } from "../../../packages/analyzers/src/openai-client.js";

type LoveNoteConfig = {
  enabled?: boolean;
  targetId?: string;
  model?: string;
  randomWindow?: {
    start?: string;
    end?: string;
  };
  style?: {
    senderName?: string;
    ownerName?: string;
    recipientName?: string;
    maxChars?: number;
    tone?: string;
    creativity?: string;
    references?: string[];
    maxDirectQuoteChars?: number;
  };
};

type LoadedLoveNoteConfig = {
  enabled: boolean;
  targetId: string;
  model: string;
  randomWindow: {
    start: string;
    end: string;
  };
  style: {
    senderName: string;
    ownerName: string;
    recipientName: string;
    maxChars: number;
    tone: string;
    creativity: string;
    references: string[];
    maxDirectQuoteChars: number;
  };
};

type RunParams = {
  date?: string;
  dryRun?: boolean;
  force?: boolean;
};

export type LoveNoteRunResult = {
  date: string;
  targetId: string;
  status: "disabled" | "not_due" | "already_sent" | "dry_run" | "sent";
  scheduledFor: string;
  content?: string;
  recipient?: string;
  sentCount: number;
};

type WorkspaceContext = {
  memoryText: string;
  relationshipsText: string;
  userText: string;
  dailyText: string;
  socialObservationsText: string;
};

function readYamlFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return (YAML.parse(raw) ?? fallback) as T;
}

function readIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parseTimeToMinutes(value: string): number {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return 7 * 60;
  }
  const hours = Math.max(0, Math.min(23, Number(match[1])));
  const minutes = Math.max(0, Math.min(59, Number(match[2])));
  return hours * 60 + minutes;
}

function formatMinutes(value: number): string {
  const normalized = ((value % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

function localMinutesNow(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

function weekdayLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00`);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()] ?? "Day";
}

function daySegment(minutes: number): "morning" | "midday" | "afternoon" | "evening" {
  if (minutes < 11 * 60) return "morning";
  if (minutes < 14 * 60) return "midday";
  if (minutes < 18 * 60) return "afternoon";
  return "evening";
}

function truncate(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

function resolveWorkspaceRoot(): string {
  const wrapperPath = process.env.OPENCLAW_CLI_WRAPPER;
  if (wrapperPath) {
    return path.join(path.dirname(path.dirname(wrapperPath)), "workspace");
  }
  const selfMcpRoot = resolveServicePaths().rootDir;
  return path.join(path.resolve(selfMcpRoot, "..", "one-company"), "openclaw", "workspace");
}

function loadLoveNoteConfig(): LoadedLoveNoteConfig {
  const paths = resolveServicePaths();
  const raw = readYamlFile<LoveNoteConfig>(path.join(paths.configDir, "wechat_love_note.yaml"), {});
  return {
    enabled: raw.enabled !== false,
    targetId: raw.targetId?.trim() || "faye-wechat",
    model: raw.model?.trim() || "qwen3.5-plus",
    randomWindow: {
      start: raw.randomWindow?.start?.trim() || "07:00",
      end: raw.randomWindow?.end?.trim() || "21:00",
    },
    style: {
      senderName: raw.style?.senderName?.trim() || "Xiaoxiong",
      ownerName: raw.style?.ownerName?.trim() || "Aaron",
      recipientName: raw.style?.recipientName?.trim() || "Faye",
      maxChars: Math.max(60, raw.style?.maxChars ?? 160),
      tone: raw.style?.tone?.trim() || "warm, imaginative, sincere, playful, and grounded in ordinary daily life",
      creativity:
        raw.style?.creativity?.trim() ||
        "Feel free to borrow the cadence of hot comments, pop culture, books, films, internet slang, or current tech chatter, but stay emotionally sincere and never sound fake.",
      references:
        raw.style?.references?.length && raw.style.references.length > 0
          ? raw.style.references.map((entry) => String(entry).trim()).filter(Boolean)
          : ["social chatter", "pop music phrasing", "book lines", "film dialogue", "internet slang", "today's digest topics"],
      maxDirectQuoteChars: Math.max(6, Math.min(20, raw.style?.maxDirectQuoteChars ?? 12)),
    },
  };
}

function computeDailyScheduledMinute(dateKey: string, config: LoadedLoveNoteConfig): number {
  const start = parseTimeToMinutes(config.randomWindow.start);
  const end = parseTimeToMinutes(config.randomWindow.end);
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const span = Math.max(0, max - min);
  const hash = crypto.createHash("sha256").update(`${dateKey}:${config.targetId}:love-note`).digest();
  const sample = hash.readUInt32BE(0);
  return min + (span === 0 ? 0 : sample % (span + 1));
}

function extractSoftDailySignals(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => /Aaron|Faye|household|love|care|rest|together|digest|dinner|meal|lunch|dishes|busy|work|gym|sweet|Shanghai/i.test(line))
    .slice(0, 8);
}

function ensureOwnerLoveSignal(text: string, config: LoadedLoveNoteConfig): string {
  const compact = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const hasOwner = compact.includes(config.style.ownerName);
  const hasLove = /爱你|爱她|很爱|喜欢你|惦记你|把你放在心上|想你/.test(compact);
  if (compact && hasOwner && hasLove) {
    return truncate(compact, config.style.maxChars);
  }
  return "";
}

function buildContextClause(dailySignals: string[], segment: string): string {
  const joined = dailySignals.join(" ");
  if (/busy|work|忙|节奏|赶|累/.test(joined)) {
    return "知道你今天节奏可能有点满，也别把自己绷太紧。";
  }
  if (/休息|sleep|晚|累/.test(joined)) {
    return "别忘了给自己留一点休息和放松的空隙。";
  }
  if (/吃|饭|菜|meal|lunch|dinner/.test(joined)) {
    return "忙归忙，也记得好好吃饭。";
  }
  if (/gym|fitness|糖|sweet/.test(joined)) {
    return "今天也要温柔地照顾身体和心情。";
  }
  if (segment === "morning") {
    return "新的一天别太赶，先把自己照顾好。";
  }
  if (segment === "midday") {
    return "中间再忙，也记得喝口水、吃点东西。";
  }
  if (segment === "afternoon") {
    return "下午如果有点累，就把这句话当成一个小小的抱抱。";
  }
  return "晚上慢一点也没关系，记得好好休息。";
}

function buildStyleHint(dateKey: string, config: LoadedLoveNoteConfig): string {
  const modes = [
    "像一条今天路过你时顺手放下的小纸条",
    "像一句借了热评节奏但不油腻的话",
    "像一句很短的电影旁白",
    "像一本小说页边空白处的轻轻一句",
    "像朋友间才会说出口的俏皮安慰",
    "像一条带一点流行语感、但内核很真诚的私聊",
  ];
  const hash = crypto.createHash("sha256").update(`${dateKey}:${config.targetId}:style`).digest();
  return modes[hash.readUInt32BE(0) % modes.length];
}

function buildFlavorLead(dateKey: string, config: LoadedLoveNoteConfig, segment: string): string {
  const leads = [
    `${config.style.senderName} 想走一点轻轻的热评口吻`,
    `${config.style.senderName} 想借一点电影旁白的感觉`,
    `${config.style.senderName} 想把这句写得像一小段歌前导语`,
    `${config.style.senderName} 想把这句写得像页边空白处的批注`,
    `${config.style.senderName} 想用一点今天会让人会心一笑的语气`,
    `${config.style.senderName} 想让这句像一条刚刚好的私聊弹幕`,
  ];
  const hash = crypto.createHash("sha256").update(`${dateKey}:${segment}:${config.targetId}:lead`).digest();
  return leads[hash.readUInt32BE(0) % leads.length];
}

function fallbackLoveNote(
  config: LoadedLoveNoteConfig,
  dateKey: string,
  segment: string,
  dailySignals: string[],
): string {
  const contextClause = buildContextClause(dailySignals, segment);
  const flavorLead = buildFlavorLead(dateKey, config, segment);
  const templates: Record<string, string[]> = {
    morning: [
      `${flavorLead}：${config.style.ownerName} 今天也很爱你。${contextClause}`,
      `这条像清晨的小纸条：${config.style.ownerName} 今天也把爱放在你这边。${contextClause}`,
      `如果早上需要一句很稳的小句子，那就是：${config.style.ownerName} 很爱你。${contextClause}`,
    ],
    midday: [
      `${config.style.senderName} 替 ${config.style.ownerName} 送来一句中场提醒：他今天也很爱你。${contextClause}`,
      `给 ${config.style.recipientName} 的小纸条：${config.style.ownerName} 今天也把爱放在你这边。${contextClause}`,
      `如果今天像弹幕有点密，那我替 ${config.style.ownerName} 插一句：他很爱你。${contextClause}`,
    ],
    afternoon: [
      `${flavorLead}：${config.style.ownerName} 今天也很爱你。${contextClause}`,
      `${config.style.ownerName} 让我转告你，他今天也一直在爱你。${contextClause}`,
      `把下午当成一小段支线剧情的话，这句是主线：${config.style.ownerName} 很爱你。${contextClause}`,
    ],
    evening: [
      `${flavorLead}：${config.style.ownerName} 今天也很爱你。${contextClause}`,
      `今天快收尾了，${config.style.ownerName} 还是想让我告诉你：他很爱你。${contextClause}`,
      `如果今天要配一句片尾字幕，那就是：${config.style.ownerName} 今天也很爱你。${contextClause}`,
    ],
  };
  const options = templates[segment] ?? templates.evening;
  const hash = crypto.createHash("sha256").update(`${dateKey}:${segment}:${config.targetId}`).digest();
  return truncate(options[hash.readUInt32BE(0) % options.length], config.style.maxChars);
}

function loadWorkspaceContext(dateKey: string): WorkspaceContext {
  const workspaceRoot = resolveWorkspaceRoot();
  return {
    memoryText: readIfExists(path.join(workspaceRoot, "MEMORY.md")),
    relationshipsText: readIfExists(path.join(workspaceRoot, "RELATIONSHIPS.md")),
    userText: readIfExists(path.join(workspaceRoot, "USER.md")),
    dailyText: readIfExists(path.join(workspaceRoot, "memory", `${dateKey}.md`)),
    socialObservationsText: readIfExists(path.join(workspaceRoot, "SOCIAL_OBSERVATIONS.md")),
  };
}

function recentDigestTitles(store: SqliteStateStore, dateKey: string, limit: number): string[] {
  return store
    .all<{ title: string | null }>(
      `
      SELECT title
      FROM articles
      WHERE discovered_date = ?
        AND digest_eligible = 1
      ORDER BY COALESCE(published_at, analyzed_at, updated_at) DESC
      LIMIT ?
      `,
      [dateKey, limit],
    )
    .map((row) => String(row.title ?? "").trim())
    .filter(Boolean);
}

async function generateLoveNoteText(params: {
  store: SqliteStateStore;
  config: LoadedLoveNoteConfig;
  dateKey: string;
  scheduledMinute: number;
  recentNotes: string[];
  dailySignals: string[];
  workspace: WorkspaceContext;
}): Promise<string> {
  const runtime = resolveAnalyzerRuntime(loadServiceConfig().rules);
  const digestTitles = recentDigestTitles(params.store, params.dateKey, 5);
  if (!runtime.apiKey) {
    return fallbackLoveNote(
      params.config,
      params.dateKey,
      daySegment(params.scheduledMinute),
      params.dailySignals,
    );
  }

  const prompt = [
    `You are ${params.config.style.senderName}, a warm digital household companion.`,
    `Write one short WeChat DM in Chinese to ${params.config.style.recipientName}.`,
    `The message must clearly convey that ${params.config.style.ownerName} loves her today, while sounding like Xiaoxiong is gently passing it along.`,
    "Core requirements:",
    "- 2 to 4 short Chinese sentences.",
    `- Keep the final text under ${params.config.style.maxChars} Chinese characters.`,
    `- Tone: ${params.config.style.tone}.`,
    `- Creativity guidance: ${params.config.style.creativity}.`,
    "- Mention Aaron by name at least once.",
    "- Mention love clearly but naturally.",
    "- Be vivid, playful, and alive, but never fake, greasy, or overacted.",
    "- You may borrow the cadence of hot comments, pop culture, books, films, internet slang, or current tech chatter.",
    `- If you use a direct quote, keep it extremely short, at most ${params.config.style.maxDirectQuoteChars} Chinese characters or 8 English words, and use at most one such fragment.`,
    "- Prefer paraphrase over long quotation.",
    "- No markdown, no hashtags, no emoji, no quotation marks around the whole message.",
    `Today is ${params.dateKey}, ${weekdayLabel(params.dateKey)}, and the likely send segment is ${daySegment(params.scheduledMinute)}.`,
    `Today's stylistic seed can feel like: ${buildStyleHint(params.dateKey, params.config)}.`,
    params.dailySignals.length > 0
      ? `Useful household signals for today:\n- ${params.dailySignals.join("\n- ")}`
      : "Today's household signals are sparse; anchor on ordinary rhythm and care instead.",
    digestTitles.length > 0
      ? `Today's digest topics that can lightly inspire the wording without forcing technical jargon:\n- ${digestTitles.join("\n- ")}`
      : "No digest topics are available today.",
    params.recentNotes.length > 0
      ? `Recent love-note examples to avoid repeating too closely:\n- ${params.recentNotes.join("\n- ")}`
      : "No recent love-note examples are available.",
    "Relevant household memory:",
    truncate(params.workspace.memoryText, 1600),
    "Relevant relationship context:",
    truncate(params.workspace.relationshipsText, 1000),
    "User context:",
    truncate(params.workspace.userText, 1000),
    "Social observations context:",
    truncate(params.workspace.socialObservationsText, 900),
    "Today's note context:",
    truncate(params.workspace.dailyText, 1000),
    "Return plain Chinese text only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const client = new OpenAI({
      apiKey: runtime.apiKey,
      baseURL: runtime.baseUrl,
      timeout: Math.min(runtime.requestTimeoutMs, 15_000),
      maxRetries: 0,
    });
    const response = await client.chat.completions.create({
      model: params.config.model,
      temperature: 1.05,
      messages: [{ role: "user", content: prompt }],
    });
    const text = String(response.choices[0]?.message?.content ?? "").trim();
    const validated = ensureOwnerLoveSignal(text, params.config);
    if (validated) {
      return validated;
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  return fallbackLoveNote(
    params.config,
    params.dateKey,
    daySegment(params.scheduledMinute),
    params.dailySignals,
  );
}

export class WechatLoveNoteService {
  private readonly loaded = loadServiceConfig();
  private readonly config = loadLoveNoteConfig();

  private constructor(private readonly store: SqliteStateStore) {}

  static async create(): Promise<WechatLoveNoteService> {
    const loaded = loadServiceConfig();
    const store = await SqliteStateStore.open(loaded.paths.stateFile);
    return new WechatLoveNoteService(store);
  }

  private getTarget(): DeliveryTargetConfig {
    const target = this.loaded.rules.deliveryTargets?.[this.config.targetId];
    if (!target) {
      throw new Error(`Unknown delivery target: ${this.config.targetId}`);
    }
    return target;
  }

  private alreadySent(dateKey: string): boolean {
    const row = this.store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM love_note_deliveries WHERE note_date = ? AND target_id = ? AND status = 'sent'",
      [dateKey, this.config.targetId],
    );
    return Number(row?.count ?? 0) > 0;
  }

  private recentNotes(limit: number): string[] {
    return this.store
      .all<{ content: string | null }>(
        `
        SELECT content
        FROM love_note_deliveries
        WHERE target_id = ? AND status = 'sent' AND content IS NOT NULL
        ORDER BY sent_at DESC
        LIMIT ?
        `,
        [this.config.targetId, limit],
      )
      .map((row) => String(row.content ?? "").trim())
      .filter(Boolean);
  }

  async run(params: RunParams = {}): Promise<LoveNoteRunResult> {
    const dateKey = params.date ?? toDateKey(new Date());
    const scheduledMinute = computeDailyScheduledMinute(dateKey, this.config);
    const scheduledFor = formatMinutes(scheduledMinute);

    if (!this.config.enabled) {
      return { date: dateKey, targetId: this.config.targetId, status: "disabled", scheduledFor, sentCount: 0 };
    }

    if (!params.force && this.alreadySent(dateKey)) {
      return { date: dateKey, targetId: this.config.targetId, status: "already_sent", scheduledFor, sentCount: 0 };
    }

    const now = new Date();
    if (!params.force && toDateKey(now) === dateKey && localMinutesNow(now) < scheduledMinute) {
      return { date: dateKey, targetId: this.config.targetId, status: "not_due", scheduledFor, sentCount: 0 };
    }

    const workspace = loadWorkspaceContext(dateKey);
    const content = await generateLoveNoteText({
      store: this.store,
      config: this.config,
      dateKey,
      scheduledMinute,
      recentNotes: this.recentNotes(5),
      dailySignals: extractSoftDailySignals(workspace.dailyText),
      workspace,
    });

    if (params.dryRun) {
      return {
        date: dateKey,
        targetId: this.config.targetId,
        status: "dry_run",
        scheduledFor,
        content,
        sentCount: 0,
      };
    }

    const target = this.getTarget();
    const deliveryId = crypto.randomUUID();
    const createdAt = nowIso();
    this.store.run(
      `
      INSERT INTO love_note_deliveries (
        id, note_date, target_id, scheduled_for, status, content, to_recipient, created_at, sent_at, error
      ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, NULL, NULL)
      `,
      [deliveryId, dateKey, this.config.targetId, scheduledFor, content, createdAt],
    );

    try {
      const delivery = await sendDigestMessages({
        wrapperPath: process.env.OPENCLAW_CLI_WRAPPER ?? "",
        target,
        messages: [
          {
            kind: "overview",
            title: "小熊的小纸条 🐻",
            body: content,
          } satisfies DigestMessage,
        ],
        wechatConfig: this.loaded.rules.delivery?.wechat,
      });

      this.store.run(
        `
        UPDATE love_note_deliveries
        SET status = 'sent',
            to_recipient = ?,
            sent_at = ?,
            error = NULL
        WHERE id = ?
        `,
        [delivery.recipient, nowIso(), deliveryId],
      );

      return {
        date: dateKey,
        targetId: this.config.targetId,
        status: "sent",
        scheduledFor,
        content,
        recipient: delivery.recipient,
        sentCount: delivery.sentCount,
      };
    } catch (error) {
      this.store.run(
        `
        UPDATE love_note_deliveries
        SET status = 'failed',
            error = ?
        WHERE id = ?
        `,
        [String(error), deliveryId],
      );
      throw error;
    }
  }
}
