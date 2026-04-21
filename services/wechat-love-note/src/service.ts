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
  maxRecipientStalenessHours?: number;
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
  maxRecipientStalenessHours: number;
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
  status: "disabled" | "not_due" | "already_sent" | "dry_run" | "stale_target" | "sent";
  scheduledFor: string;
  content?: string;
  recipient?: string;
  error?: string;
  sentCount: number;
};

type WorkspaceContext = {
  memoryText: string;
  relationshipsText: string;
  userText: string;
  dailyText: string;
  socialObservationsText: string;
  recentRecipientSignals: string[];
};

type StoredLoveNoteRow = {
  id: string;
  note_date: string;
  scheduled_for: string;
  status: string;
  content: string | null;
  to_recipient: string | null;
  created_at: string;
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

function ellipsize(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxChars - 1))}...`;
}

function humanizeDateKey(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function resolveOpenclawRoot(): string {
  const wrapperPath = process.env.OPENCLAW_CLI_WRAPPER;
  if (wrapperPath) {
    return path.dirname(path.dirname(wrapperPath));
  }
  const selfMcpRoot = resolveServicePaths().rootDir;
  return path.join(path.resolve(selfMcpRoot, "..", "one-company"), "openclaw");
}

type SessionOrigin = {
  chatType?: string;
  accountId?: string;
  to?: string;
};

type SessionMeta = {
  origin?: SessionOrigin;
  updatedAt?: number;
  sessionFile?: string;
  sessionId?: string;
};

const LOVE_SIGNAL_PATTERNS = /爱你|爱着你|很爱|想你|惦记你|挂念你|把你放在心上|把你放在心里|偏爱你|在你这边/;
const RELATIONAL_DEPTH_PATTERNS = [
  /想你/,
  /惦记/,
  /挂念/,
  /把你放在心上/,
  /把你放在心里/,
  /在你这边/,
  /偏爱/,
  /抱你/,
  /接住/,
  /舍不得/,
  /被认真/,
];
const THIN_LOVE_NOTE_PATTERNS = [
  /喝口水/,
  /吃点东西/,
  /好好休息/,
  /节奏.{0,8}(满|忙)/,
  /如果.{0,8}(累|忙)/,
  /别把自己绷太紧/,
  /慢一点也没关系/,
  /下午如果有点累/,
];

function normalizeLoveNoteText(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function stripConversationInfo(text: string): string {
  return text.replace(/^Conversation info \(untrusted metadata\):[\s\S]*?```\s*/m, "").trim();
}

function extractMessageTextParts(payload: unknown): string[] {
  const content = (payload as { message?: { content?: unknown[] } })?.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((item): item is { type: "text"; text: string } => {
      if (typeof item !== "object" || item === null) {
        return false;
      }
      const candidate = item as { type?: string; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((item) => item.text);
}

function looksEmotionallyThinLoveNote(text: string): boolean {
  const compact = normalizeLoveNoteText(text).replace(/\s+/g, "");
  const weakHits = THIN_LOVE_NOTE_PATTERNS.filter((pattern) => pattern.test(compact)).length;
  const depthHits = RELATIONAL_DEPTH_PATTERNS.filter((pattern) => pattern.test(compact)).length;
  const sentenceCount = compact.split(/[。！？!?]/).filter(Boolean).length;
  return weakHits > 0 && (depthHits === 0 || sentenceCount < 2);
}

function ensureOwnerLoveSignalV2(text: string, config: LoadedLoveNoteConfig): string {
  const compact = normalizeLoveNoteText(text);
  if (!compact) {
    return "";
  }
  if (!compact.includes(config.style.ownerName)) {
    return "";
  }
  if (!LOVE_SIGNAL_PATTERNS.test(compact)) {
    return "";
  }
  if (looksEmotionallyThinLoveNote(compact)) {
    return "";
  }
  return truncate(compact, config.style.maxChars);
}

function extractRecentRecipientSignals(target: DeliveryTargetConfig, limit = 4): string[] {
  if (target.channel !== "openclaw-weixin" || !target.accountId || !target.to?.trim()) {
    return [];
  }

  const sessionsPath = path.join(resolveOpenclawRoot(), ".openclaw-state", "agents", "main", "sessions", "sessions.json");
  if (!fs.existsSync(sessionsPath)) {
    return [];
  }

  let parsed: Record<string, SessionMeta>;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionsPath, "utf8")) as Record<string, SessionMeta>;
  } catch {
    return [];
  }

  const targetTo = target.to.trim().toLowerCase();
  const matched = Object.values(parsed)
    .filter((value) => value.origin?.chatType === "direct")
    .filter((value) => (value.origin?.accountId ?? "").trim() === target.accountId)
    .filter((value) => (value.origin?.to ?? "").trim().toLowerCase() === targetTo)
    .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0];

  const sessionFile =
    matched?.sessionFile ||
    (matched?.sessionId
      ? path.join(resolveOpenclawRoot(), ".openclaw-state", "agents", "main", "sessions", `${matched.sessionId}.jsonl`)
      : "");
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return [];
  }

  try {
    const lines = fs.readFileSync(sessionFile, "utf8").split(/\r?\n/).filter(Boolean);
    const snippets: string[] = [];
    for (const line of lines) {
      let parsedLine: unknown;
      try {
        parsedLine = JSON.parse(line);
      } catch {
        continue;
      }
      const role = (parsedLine as { message?: { role?: string } })?.message?.role;
      if (role !== "user") {
        continue;
      }
      for (const text of extractMessageTextParts(parsedLine)) {
        const cleaned = ellipsize(stripConversationInfo(text), 90);
        if (cleaned.length >= 8) {
          snippets.push(cleaned);
        }
      }
    }
    return snippets.slice(-limit);
  } catch {
    return [];
  }
}

function buildEmotionAnchorClauseV2(signals: string[], segment: string): string {
  const joined = signals.join(" ");
  if (/体检|医院|检查|年检/.test(joined)) {
    return "如果今天想到那些检查会有点发虚，也希望你知道自己不是一个人面对。";
  }
  if (/难过|伤心|委屈|心疼|down|脆弱/.test(joined)) {
    return "如果今天心里那块还在隐隐发疼，这句就先替你挡一下风。";
  }
  if (/忙|工作|上班|节奏|加班/.test(joined)) {
    return "就算今天事情一件接一件，你也不是被放到最后的人。";
  }
  if (/睡|休息|熬夜/.test(joined)) {
    return "今晚不必急着把自己哄得很懂事，先让这句话陪你一下。";
  }
  if (segment === "morning") {
    return "今天就算要往前赶，也别忘了你本来就值得被好好惦记。";
  }
  if (segment === "midday") {
    return "中间再忙，也想把这句轻一点地放到你手心里。";
  }
  if (segment === "afternoon") {
    return "下午最容易让人心软一点，所以这句想落得更稳一点。";
  }
  return "到晚上了，也还是想让你知道有人把你放在心上。";
}

function buildStyleHintV2(dateKey: string, config: LoadedLoveNoteConfig): string {
  const modes = [
    "像一张折得很小、但真的有温度的纸条",
    "像一句从热评语感里借来节奏、却不油腻的私聊",
    "像电影片尾那种很轻的一句旁白",
    "像一本书页边角落里留下的认真批注",
    "像熟人之间不会说给所有人听的话",
    "像一句看起来轻，却真的在接住人的表达",
  ];
  const hash = crypto.createHash("sha256").update(`${dateKey}:${config.targetId}:style-v2`).digest();
  return modes[hash.readUInt32BE(0) % modes.length];
}

function fallbackLoveNoteV2(
  config: LoadedLoveNoteConfig,
  dateKey: string,
  segment: string,
  signals: string[],
): string {
  const anchor = buildEmotionAnchorClauseV2(signals, segment);
  const templates: Record<string, string[]> = {
    morning: [
      `想在你出门前把这句塞进口袋里：${config.style.ownerName} 很爱你，也一直把你放在心上。${anchor}`,
      `把今天早上当成一封很短的私信：${config.style.ownerName} 很爱你。外面可以很赶，但你不用在这句话里逞强。`,
      `早上先替 ${config.style.ownerName} 把最重要的那句放过来：他很爱你，也认真惦记着你今天会不会顺一点。`,
    ],
    midday: [
      `中午给你递一句不敷衍的话：${config.style.ownerName} 很爱你。${anchor}`,
      `替 ${config.style.ownerName} 轻轻说一句：他今天也把你放在心上，不是路过一下的那种想起。`,
      `如果中午需要一小句能站住的话，那就先收下这一句：${config.style.ownerName} 很爱你，也一直偏向你这边。`,
    ],
    afternoon: [
      `把下午当成一张折好的小纸条：${config.style.ownerName} 很爱你。${anchor}`,
      `下午最适合把话说得真一点：${config.style.ownerName} 很爱你，也惦记你今天过得顺不顺。`,
      `替 ${config.style.ownerName} 抱你一下：他很爱你。你不用一直把自己撑得很稳，至少这句话里可以松一点。`,
    ],
    evening: [
      `到晚上了，还是想把这句放到你这边：${config.style.ownerName} 很爱你。${anchor}`,
      `今天快收尾时，还是想替 ${config.style.ownerName} 认真说一句：他很爱你，也把你的疲惫和委屈放在心上。`,
      `如果今晚只能留一句最稳的话，那就是：${config.style.ownerName} 很爱你。愿你先被温柔接住，再去想别的事。`,
    ],
  };
  const options = templates[segment] ?? templates.evening;
  const hash = crypto.createHash("sha256").update(`${dateKey}:${segment}:${config.targetId}:fallback-v2`).digest();
  return truncate(options[hash.readUInt32BE(0) % options.length], config.style.maxChars);
}

function buildEmotionAnchorClauseV3(signals: string[], segment: string): string {
  const joined = signals.join(" ");
  if (/体检|医院|检查|年检/.test(joined)) {
    return "如果今天想到那些检查会有点发虚，也希望你知道自己不是一个人面对。";
  }
  if (/难过|伤心|委屈|心疼|down|脆弱/.test(joined)) {
    return "如果今天心里那块还在隐隐发疼，这句就先替你挡一下风。";
  }
  if (/忙|工作|上班|节奏|加班/.test(joined)) {
    return "就算今天事情一件接一件，你也不是被放到最后的人。";
  }
  if (/睡|休息|熬夜/.test(joined)) {
    return "今晚不必急着把自己哄得很懂事，先让这句话陪你一下。";
  }
  if (segment === "morning") {
    return "今天就算要往前赶，也别忘了你本来就值得被好好惦记。";
  }
  if (segment === "midday") {
    return "中间再忙，也想把这句轻一点地放到你手心里。";
  }
  if (segment === "afternoon") {
    return "下午最容易让人心软一点，所以这句想落得更稳一点。";
  }
  return "到晚上了，也还是想让你知道有人把你放在心上。";
}

function buildStyleHintV3(dateKey: string, config: LoadedLoveNoteConfig): string {
  const modes = [
    "像一张折得很小、但真的有温度的纸条",
    "像一句从热评语感里借来节奏、却不油腻的私聊",
    "像电影片尾那种很轻的一句旁白",
    "像一本书页边角落里留下的认真批注",
    "像熟人之间不会说给所有人听的话",
    "像一句看起来轻，却真的在接住人的表达",
  ];
  const hash = crypto.createHash("sha256").update(`${dateKey}:${config.targetId}:style-v3`).digest();
  return modes[hash.readUInt32BE(0) % modes.length];
}

function fallbackLoveNoteV3(
  config: LoadedLoveNoteConfig,
  dateKey: string,
  segment: string,
  signals: string[],
): string {
  const anchor = buildEmotionAnchorClauseV3(signals, segment);
  const templates: Record<string, string[]> = {
    morning: [
      `想在你出门前把这句塞进口袋里：${config.style.ownerName} 很爱你，也一直把你放在心上。${anchor}`,
      `把今天早上当成一封很短的私信：${config.style.ownerName} 很爱你，也认真惦记着你今天会不会顺一点。${anchor}`,
      `早上先替 ${config.style.ownerName} 把最重要的那句放过来：他很爱你，而且一直偏向你这边。${anchor}`,
    ],
    midday: [
      `中午给你递一句不敷衍的话：${config.style.ownerName} 很爱你，也不是路过一下那样想起你。${anchor}`,
      `替 ${config.style.ownerName} 轻轻说一句：他今天也把你放在心上，想让你心里能稳一点。${anchor}`,
      `如果中午需要一小句能站住的话，那就先收下这一句：${config.style.ownerName} 很爱你，也一直在你这边。${anchor}`,
    ],
    afternoon: [
      `把下午当成一张折好的小纸条：${config.style.ownerName} 很爱你，也惦记你今天过得顺不顺。${anchor}`,
      `想替 ${config.style.ownerName} 认真说一句：他很爱你，而且舍不得你一个人把情绪都吞下去。${anchor}`,
      `替 ${config.style.ownerName} 抱你一下：他很爱你。你不用一直把自己撑得很稳，至少这句话里可以松一点。`,
    ],
    evening: [
      `到晚上了，还是想把这句放到你这边：${config.style.ownerName} 很爱你，也把你的疲惫和委屈放在心上。${anchor}`,
      `今天快收尾时，还是想替 ${config.style.ownerName} 认真说一句：他很爱你，而且心里一直挂着你。${anchor}`,
      `如果今晚只能留一句最稳的话，那就是：${config.style.ownerName} 很爱你。愿你先被温柔接住，再去想别的事。`,
    ],
  };
  const options = templates[segment] ?? templates.evening;
  const hash = crypto.createHash("sha256").update(`${dateKey}:${segment}:${config.targetId}:fallback-v3`).digest();
  return truncate(options[hash.readUInt32BE(0) % options.length], config.style.maxChars);
}

const LOVE_SIGNAL_PATTERNS_V4 = /爱你|爱着你|很爱你|想你|惦记你|挂念你|把你放在心上|把你放在心里|偏爱你|在你这边/;
const RELATIONAL_DEPTH_PATTERNS_V4 = [
  /想你/,
  /惦记/,
  /挂念/,
  /把你放在心上/,
  /把你放在心里/,
  /在你这边/,
  /偏爱/,
  /抱你/,
  /接住/,
  /舍不得/,
  /被认真/,
];
const THIN_LOVE_NOTE_PATTERNS_V4 = [
  /喝口水/,
  /吃点东西/,
  /好好休息/,
  /节奏.{0,8}(满|快)/,
  /如果.{0,8}(累|忙)/,
  /别把自己绷太紧/,
  /慢一点也没关系/,
  /下午如果有点累/,
];
const LOVE_NOTE_META_PATTERNS_V4 = [
  /像弹幕/,
  /支线剧情/,
  /前导语/,
  /小纸条/,
  /把这句话当成/,
  /把这句当成/,
  /这句话想/,
  /这句想/,
  /最适合把话说得真一点/,
];

function looksEmotionallyThinLoveNoteV4(text: string): boolean {
  const compact = normalizeLoveNoteText(text).replace(/\s+/g, "");
  const weakHits = THIN_LOVE_NOTE_PATTERNS_V4.filter((pattern) => pattern.test(compact)).length;
  const depthHits = RELATIONAL_DEPTH_PATTERNS_V4.filter((pattern) => pattern.test(compact)).length;
  const sentenceCount = compact.split(/[。！？]/).filter(Boolean).length;
  return weakHits > 0 && (depthHits === 0 || sentenceCount < 2);
}

function looksOverwrittenLoveNoteV4(text: string): boolean {
  const compact = normalizeLoveNoteText(text).replace(/\s+/g, "");
  const metaHits = LOVE_NOTE_META_PATTERNS_V4.filter((pattern) => pattern.test(compact)).length;
  return metaHits >= 1;
}

function ensureOwnerLoveSignalV4(text: string, config: LoadedLoveNoteConfig): string {
  const compact = normalizeLoveNoteText(text);
  if (!compact) {
    return "";
  }
  if (!compact.includes(config.style.ownerName)) {
    return "";
  }
  if (!LOVE_SIGNAL_PATTERNS_V4.test(compact)) {
    return "";
  }
  if (looksEmotionallyThinLoveNoteV4(compact)) {
    return "";
  }
  if (looksOverwrittenLoveNoteV4(compact)) {
    return "";
  }
  return truncate(compact, config.style.maxChars);
}

function buildEmotionAnchorClauseV4(signals: string[], segment: string): string {
  const joined = signals.join(" ");
  if (/体检|医院|检查|年检/.test(joined)) {
    return "如果今天想到那些检查会有点发虚，也希望你知道自己不是一个人面对。";
  }
  if (/难过|伤心|委屈|心疼|down|脆弱/.test(joined)) {
    return "如果今天心里那块还在隐隐发疼，这句话就先替你挡一下风。";
  }
  if (/忙|工作|上班|节奏|加班/.test(joined)) {
    return "就算今天事情一件接一件，你也不是被放到最后的人。";
  }
  if (/睡|休息|熬夜/.test(joined)) {
    return "今晚不必急着把自己哄得很懂事，先让这句话陪你一下。";
  }
  if (segment === "morning") {
    return "今天就算要往前赶，也别忘了你本来就值得被好好惦记。";
  }
  if (segment === "midday") {
    return "中间再忙，也想把这句话轻一点地放到你手心里。";
  }
  if (segment === "afternoon") {
    return "下午最容易让人心软一点，所以这句心里话想落得更稳一点。";
  }
  return "到晚上了，也还是想让你知道有人把你放在心上。";
}

function buildStyleHintV4(dateKey: string, config: LoadedLoveNoteConfig): string {
  const modes = [
    "像一张折得很小、但真的有温度的纸条",
    "像一句从热评语感里借来节奏、却不油腻的私聊",
    "像电影片尾那种很轻的一句旁白",
    "像一本书页边角落里留下的认真批注",
    "像熟人之间不会说给所有人听的话",
    "像一句看起来轻，却真的在接住人的表达",
  ];
  const hash = crypto.createHash("sha256").update(`${dateKey}:${config.targetId}:style-v4`).digest();
  return modes[hash.readUInt32BE(0) % modes.length];
}

function fallbackLoveNoteV4(
  config: LoadedLoveNoteConfig,
  dateKey: string,
  segment: string,
  signals: string[],
): string {
  const anchor = buildEmotionAnchorClauseV4(signals, segment);
  const templates: Record<string, string[]> = {
    morning: [
      `想在你出门前把这句话塞进口袋里：${config.style.ownerName} 很爱你，也一直把你放在心上。${anchor}`,
      `把今天早上当成一封很短的私信：${config.style.ownerName} 很爱你，也认真惦记着你今天会不会顺一点。${anchor}`,
      `早上先替 ${config.style.ownerName} 把最重要的那句话放过来：他很爱你，而且一直偏向你这边。${anchor}`,
    ],
    midday: [
      `中午给你递一句不敷衍的话：${config.style.ownerName} 很爱你，也不是路过一下那样想起你。${anchor}`,
      `替 ${config.style.ownerName} 轻轻说一句：他今天也把你放在心上，想让你心里能稳一点。${anchor}`,
      `如果中午需要一句能站住的话，那就先收下这一句：${config.style.ownerName} 很爱你，也一直在你这边。${anchor}`,
    ],
    afternoon: [
      `把下午当成一张折好的小纸条：${config.style.ownerName} 很爱你，也惦记你今天过得顺不顺。${anchor}`,
      `想替 ${config.style.ownerName} 认真说一句：他很爱你，而且舍不得你一个人把情绪都吞下去。${anchor}`,
      `替 ${config.style.ownerName} 抱你一下：他很爱你。你不用一直把自己撑得很稳，至少这句话里可以松一点。`,
    ],
    evening: [
      `到晚上了，还是想把这句话放到你这边：${config.style.ownerName} 很爱你，也把你的疲惫和委屈放在心上。${anchor}`,
      `今天快收尾时，还是想替 ${config.style.ownerName} 认真说一句：他很爱你，而且心里一直挂着你。${anchor}`,
      `如果今晚只能留一句最稳的话，那就是：${config.style.ownerName} 很爱你。愿你先被温柔接住，再去想别的事。`,
    ],
  };
  const options = templates[segment] ?? templates.evening;
  const hash = crypto.createHash("sha256").update(`${dateKey}:${segment}:${config.targetId}:fallback-v4`).digest();
  return truncate(options[hash.readUInt32BE(0) % options.length], config.style.maxChars);
}

function resolveRecipientLastActiveAt(target: DeliveryTargetConfig): string | undefined {
  if (target.channel !== "openclaw-weixin" || !target.accountId || !target.to?.trim()) {
    return undefined;
  }

  const sessionsPath = path.join(resolveOpenclawRoot(), ".openclaw-state", "agents", "main", "sessions", "sessions.json");
  if (!fs.existsSync(sessionsPath)) {
    return undefined;
  }

  let parsed: Record<string, SessionMeta>;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionsPath, "utf8")) as Record<string, SessionMeta>;
  } catch {
    return undefined;
  }

  const targetTo = target.to.trim().toLowerCase();
  let latestUpdatedAt = 0;
  for (const value of Object.values(parsed)) {
    const origin = value?.origin;
    if (!origin) {
      continue;
    }
    if (origin.chatType !== "direct") {
      continue;
    }
    if ((origin.accountId ?? "").trim() !== target.accountId) {
      continue;
    }
    if ((origin.to ?? "").trim().toLowerCase() !== targetTo) {
      continue;
    }
    const updatedAt = Number(value.updatedAt ?? 0);
    if (Number.isFinite(updatedAt) && updatedAt > latestUpdatedAt) {
      latestUpdatedAt = updatedAt;
    }
  }

  return latestUpdatedAt > 0 ? new Date(latestUpdatedAt).toISOString() : undefined;
}

function loadLoveNoteConfig(): LoadedLoveNoteConfig {
  const paths = resolveServicePaths();
  const raw = readYamlFile<LoveNoteConfig>(path.join(paths.configDir, "wechat_love_note.yaml"), {});
  return {
    enabled: raw.enabled !== false,
    targetId: raw.targetId?.trim() || "faye-wechat",
    model: raw.model?.trim() || "qwen3.5-plus",
    maxRecipientStalenessHours: Math.max(1, Math.min(168, Number(raw.maxRecipientStalenessHours ?? 48))),
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

function loadWorkspaceContext(dateKey: string, target: DeliveryTargetConfig): WorkspaceContext {
  const workspaceRoot = resolveWorkspaceRoot();
  return {
    memoryText: readIfExists(path.join(workspaceRoot, "MEMORY.md")),
    relationshipsText: readIfExists(path.join(workspaceRoot, "RELATIONSHIPS.md")),
    userText: readIfExists(path.join(workspaceRoot, "USER.md")),
    dailyText: readIfExists(path.join(workspaceRoot, "memory", `${dateKey}.md`)),
    socialObservationsText: readIfExists(path.join(workspaceRoot, "SOCIAL_OBSERVATIONS.md")),
    recentRecipientSignals: extractRecentRecipientSignals(target),
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
  const combinedSignals = [...params.dailySignals, ...params.workspace.recentRecipientSignals].slice(-8);
  if (!runtime.apiKey) {
    return fallbackLoveNoteV4(
      params.config,
      params.dateKey,
      daySegment(params.scheduledMinute),
      combinedSignals,
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
    "- Be vivid, playful, tender, and alive, but never fake, greasy, or overacted.",
    "- Give the note one emotionally grounded image or one specific feeling anchor, instead of generic lifestyle reminders.",
    "- Make it feel like a real little note from someone who knows she has a heart, not a wellness assistant giving generic tips.",
    "- If the note only says 'Aaron loves you' plus reminders like drink water / eat / rest, it is a failed draft.",
    "- Avoid filler such as '记得喝水', '吃点东西', '好好休息', '如果你累了', unless they are only a tiny tail, not the emotional core.",
    "- You may borrow the cadence of hot comments, pop culture, books, films, internet slang, or current tech chatter.",
    `- If you use a direct quote, keep it extremely short, at most ${params.config.style.maxDirectQuoteChars} Chinese characters or 8 English words, and use at most one such fragment.`,
    "- Prefer paraphrase over long quotation.",
    "- No markdown, no hashtags, no emoji, no quotation marks around the whole message.",
    `Today is ${params.dateKey}, ${weekdayLabel(params.dateKey)}, and the likely send segment is ${daySegment(params.scheduledMinute)}.`,
    `Today's stylistic seed can feel like: ${buildStyleHintV4(params.dateKey, params.config)}.`,
    combinedSignals.length > 0
      ? `Useful household signals for today:\n- ${combinedSignals.join("\n- ")}`
      : "Today's household signals are sparse; anchor on ordinary rhythm, tenderness, and quiet companionship instead.",
    digestTitles.length > 0
      ? `Today's digest topics that can lightly inspire the wording without forcing technical jargon:\n- ${digestTitles.join("\n- ")}`
      : "No digest topics are available today.",
    params.recentNotes.length > 0
      ? `Recent love-note examples to avoid repeating too closely:\n- ${params.recentNotes.join("\n- ")}`
      : "No recent love-note examples are available.",
    params.workspace.recentRecipientSignals.length > 0
      ? `Recent direct-lane hints from ${params.config.style.recipientName}'s own conversation. Use only as gentle context, do not quote them back directly:\n- ${params.workspace.recentRecipientSignals.join("\n- ")}`
      : "No recent direct-lane hints are available.",
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
    const prompts = [
      prompt,
      `${prompt}\n\nThe previous draft was rejected because it sounded emotionally thin or too generic. Rewrite it with more tenderness and specificity. Do not default to drink water / eat / rest filler.`,
    ];
    for (const currentPrompt of prompts) {
      const response = await client.chat.completions.create({
        model: params.config.model,
        temperature: 1.05,
        messages: [{ role: "user", content: currentPrompt }],
      });
      const text = String(response.choices[0]?.message?.content ?? "").trim();
      const validated = ensureOwnerLoveSignalV4(text, params.config);
      if (validated) {
        return validated;
      }
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  return fallbackLoveNoteV4(
    params.config,
    params.dateKey,
    daySegment(params.scheduledMinute),
    combinedSignals,
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

  private staleTargetError(dateKey: string, scheduledFor: string, message: string): LoveNoteRunResult {
    return {
      date: dateKey,
      targetId: this.config.targetId,
      status: "stale_target",
      scheduledFor,
      sentCount: 0,
      error: message,
    };
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

  private existingDeferredNote(dateKey: string): StoredLoveNoteRow | undefined {
    return this.store.get<StoredLoveNoteRow>(
      `
      SELECT id, note_date, scheduled_for, status, content, to_recipient, created_at
      FROM love_note_deliveries
      WHERE note_date = ? AND target_id = ? AND status = 'stale_target'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [dateKey, this.config.targetId],
    );
  }

  private pendingCatchupNotes(limit: number): StoredLoveNoteRow[] {
    return this.store.all<StoredLoveNoteRow>(
      `
      SELECT id, note_date, scheduled_for, status, content, to_recipient, created_at
      FROM love_note_deliveries
      WHERE target_id = ? AND status = 'stale_target' AND content IS NOT NULL
      ORDER BY note_date ASC, created_at ASC
      LIMIT ?
      `,
      [this.config.targetId, limit],
    );
  }

  private buildCatchupMessage(rows: StoredLoveNoteRow[]): DigestMessage | undefined {
    if (rows.length === 0) {
      return undefined;
    }
    const lines = rows
      .slice(0, 4)
      .map((row) => `- ${humanizeDateKey(row.note_date)}：${ellipsize(String(row.content ?? ""), 48)}`)
      .filter(Boolean);
    if (lines.length === 0) {
      return undefined;
    }
    const remaining = rows.length - lines.length;
    const tail = remaining > 0 ? `\n\n另外还有 ${remaining} 张小纸条，等通道稳定后我会继续慢慢补上。` : "";
    return {
      kind: "overview",
      title: "小熊的小纸条合集 🐻",
      body: `前几天有些小纸条没能准时送到，我先把它们轻轻补成一封合集：\n${lines.join("\n")}${tail}`,
    };
  }

  private buildCatchupMessageV2(rows: StoredLoveNoteRow[]): DigestMessage | undefined {
    if (rows.length === 0) {
      return undefined;
    }
    const lines = rows
      .slice(0, 3)
      .map((row) => `- ${humanizeDateKey(row.note_date)}：${ellipsize(String(row.content ?? ""), 56)}`)
      .filter(Boolean);
    if (lines.length === 0) {
      return undefined;
    }
    const remaining = rows.length - lines.length;
    const tail = remaining > 0 ? `\n\n另外还有 ${remaining} 张小纸条，我会在通道稳定后再慢慢补上。` : "";
    return {
      kind: "overview",
      title: "小熊的小纸条合集 🐻",
      body: `前几天有几张小纸条晚到了，我先把它们轻轻折成一封小合集送给你：\n${lines.join("\n")}${tail}`,
    };
  }

  private buildCatchupMessageV3(rows: StoredLoveNoteRow[]): DigestMessage | undefined {
    if (rows.length === 0) {
      return undefined;
    }
    const lines = rows
      .slice(0, 3)
      .map((row) => `- ${humanizeDateKey(row.note_date)}：${ellipsize(String(row.content ?? ""), 56)}`)
      .filter(Boolean);
    if (lines.length === 0) {
      return undefined;
    }
    const remaining = rows.length - lines.length;
    const tail = remaining > 0 ? `\n\n另外还有 ${remaining} 张小纸条，我会在通道稳定后再慢慢补上。` : "";
    return {
      kind: "overview",
      title: "小熊的小纸条合集 🐻",
      body: `前几天有几张小纸条晚到了，我先把它们轻轻折成一封小合集送给你：\n${lines.join("\n")}${tail}`,
    };
  }

  private markRowsSent(ids: string[], recipient: string): void {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    this.store.run(
      `
      UPDATE love_note_deliveries
      SET status = 'sent',
          to_recipient = ?,
          sent_at = ?,
          error = NULL
      WHERE id IN (${placeholders})
      `,
      [recipient, nowIso(), ...ids],
    );
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
    const target = this.getTarget();
    const lastActiveAt = resolveRecipientLastActiveAt(target);
    const maxStalenessMs = this.config.maxRecipientStalenessHours * 60 * 60 * 1000;
    const hasExplicitRecipient =
      target.channel === "openclaw-weixin" && !!target.accountId?.trim() && !!target.to?.trim();
    const laneIsFresh =
      hasExplicitRecipient ||
      (!!lastActiveAt && now.getTime() - new Date(lastActiveAt).getTime() <= maxStalenessMs);
    const pendingCatchup = laneIsFresh ? this.pendingCatchupNotes(8) : [];
    if (!params.force && toDateKey(now) === dateKey && localMinutesNow(now) < scheduledMinute && pendingCatchup.length === 0) {
      return { date: dateKey, targetId: this.config.targetId, status: "not_due", scheduledFor, sentCount: 0 };
    }

    const workspace = loadWorkspaceContext(dateKey, target);
    const existingDeferred = this.existingDeferredNote(dateKey);
    const content =
      existingDeferred?.content?.trim() ||
      (await generateLoveNoteText({
        store: this.store,
        config: this.config,
        dateKey,
        scheduledMinute,
        recentNotes: this.recentNotes(5),
        dailySignals: extractSoftDailySignals(workspace.dailyText),
        workspace,
      }));

    if (!laneIsFresh) {
      const message = lastActiveAt
        ? `Target lane ${this.config.targetId} is stale. Last direct activity was ${lastActiveAt}. Ask the recipient to send one fresh message first.`
        : `Target lane ${this.config.targetId} has no recent direct session metadata. Ask the recipient to send one fresh message first.`;
      if (!existingDeferred) {
        this.store.run(
          `
          INSERT INTO love_note_deliveries (
            id, note_date, target_id, scheduled_for, status, content, to_recipient, created_at, sent_at, error
          ) VALUES (?, ?, ?, ?, 'stale_target', ?, NULL, ?, NULL, ?)
          `,
          [crypto.randomUUID(), dateKey, this.config.targetId, scheduledFor, content, nowIso(), message],
        );
      } else {
        this.store.run(
          `
          UPDATE love_note_deliveries
          SET content = ?, error = ?
          WHERE id = ?
          `,
          [content, message, existingDeferred.id],
        );
      }
      return this.staleTargetError(dateKey, scheduledFor, message);
    }

    if (params.dryRun) {
      const catchupMessage = this.buildCatchupMessageV3(pendingCatchup);
      return {
        date: dateKey,
        targetId: this.config.targetId,
        status: "dry_run",
        scheduledFor,
        content: catchupMessage ? `${catchupMessage.body}\n\n---\n\n${content}` : content,
        sentCount: 0,
      };
    }

    const deliveryId = existingDeferred?.id ?? crypto.randomUUID();
    const createdAt = nowIso();
    if (!existingDeferred) {
      this.store.run(
        `
        INSERT INTO love_note_deliveries (
          id, note_date, target_id, scheduled_for, status, content, to_recipient, created_at, sent_at, error
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, NULL, NULL)
        `,
        [deliveryId, dateKey, this.config.targetId, scheduledFor, content, createdAt],
      );
    } else {
      this.store.run(
        `
        UPDATE love_note_deliveries
        SET status = 'pending',
            content = ?,
            error = NULL
        WHERE id = ?
        `,
        [content, deliveryId],
      );
    }

    const catchupRows = pendingCatchup.filter((row) => row.id !== deliveryId);
    const catchupMessage = this.buildCatchupMessageV3(catchupRows);
    const messages: DigestMessage[] = [];
    if (catchupMessage) {
      messages.push(catchupMessage);
    }
    messages.push({
      kind: "overview",
      title: "小熊的小纸条 🐻",
      body: content,
    });

    try {
      const delivery = await sendDigestMessages({
        wrapperPath: process.env.OPENCLAW_CLI_WRAPPER ?? "",
        target,
        messages, /*
          {
            kind: "overview",
            title: "小熊的小纸条 🐻",
            body: content,
          } satisfies DigestMessage,
        ], */
        wechatConfig: this.loaded.rules.delivery?.wechat,
      });

      this.markRowsSent(
        catchupRows.map((row) => row.id),
        delivery.recipient,
      );
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
