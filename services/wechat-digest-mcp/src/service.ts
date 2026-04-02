import crypto from "node:crypto";
import type {
  AnalyzeOutput,
  ArticleCandidate,
  BuildDigestOutput,
  DeliveryTargetConfig,
  DigestMessage,
  ExtractedArticle,
  StatusOutput,
} from "../../../packages/core/src/types.js";
import { canonicalizeUrl, nowIso, toDateKey } from "../../../packages/core/src/canonical.js";
import { loadServiceConfig } from "../../../packages/core/src/config.js";
import { SqliteStateStore } from "../../../packages/core/src/db.js";
import { sendDigestMessages } from "../../../packages/core/src/delivery.js";
import { expandDigestMessages } from "../../../packages/core/src/message-split.js";
import { scanSource } from "../../../packages/extractors/src/discovery.js";
import { extractArticle } from "../../../packages/extractors/src/wechat-article.js";
import { analyzeArticle } from "../../../packages/analyzers/src/article-analysis.js";

type ScanParams = {
  sourceIds?: string[];
  since?: string;
};

type AnalyzeParams = {
  articleIds?: string[];
  urls?: string[];
};

type BuildParams = {
  date?: string;
  targetId?: string;
  dryRun?: boolean;
};

type StatusParams = {
  date?: string;
};

type DbArticleRow = {
  id: string;
  source_id: string | null;
  discovery_id: string | null;
  canonical_url: string;
  article_url: string;
  title: string;
  blurb: string | null;
  author: string | null;
  published_at: string | null;
  discovered_date: string | null;
  content_text: string | null;
  content_html: string | null;
  summary: string | null;
  why_relevant: string | null;
  key_takeaways_json: string | null;
  content_labels_json: string | null;
  list_label: string | null;
  relevance_score: number | null;
  digest_eligible: number;
  analysis_status: string;
  analyzed_at: string | null;
  updated_at: string;
};

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown[];
    return parsed.map((entry) => String(entry)).filter(Boolean);
  } catch {
    return [];
  }
}

export class WechatDigestService {
  private readonly loaded = loadServiceConfig();
  private constructor(private readonly store: SqliteStateStore) {
    this.syncSources();
  }

  static async create(): Promise<WechatDigestService> {
    const loaded = loadServiceConfig();
    const store = await SqliteStateStore.open(loaded.paths.stateFile);
    return new WechatDigestService(store);
  }

  private syncSources() {
    const timestamp = nowIso();
    for (const source of this.loaded.sources) {
      this.store.run(
        `
        INSERT INTO sources (id, display_name, discovery_type, discovery_url, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          discovery_type = excluded.discovery_type,
          discovery_url = excluded.discovery_url,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        `,
        [
          source.id,
          source.displayName,
          source.discovery.type,
          source.discovery.url,
          source.enabled === false ? 0 : 1,
          timestamp,
        ],
      );
    }
  }

  private resolveSources(sourceIds?: string[]) {
    const allowed = new Set(sourceIds ?? []);
    return this.loaded.sources.filter(
      (source) => source.enabled !== false && (allowed.size === 0 || allowed.has(source.id)),
    );
  }

  private resolveTarget(targetId?: string): DeliveryTargetConfig | undefined {
    if (!targetId) {
      return undefined;
    }
    return this.loaded.rules.deliveryTargets?.[targetId];
  }

  private ensureArticleStub(candidate: Omit<ArticleCandidate, "articleId" | "status">): string {
    const existing = this.store.get<{ id: string }>(
      "SELECT id FROM articles WHERE canonical_url = ?",
      [candidate.canonicalUrl],
    );
    if (existing?.id) {
      this.store.run(
        `
        UPDATE articles SET
          source_id = ?,
          article_url = ?,
          title = ?,
          blurb = COALESCE(?, blurb),
          published_at = COALESCE(?, published_at),
          discovered_date = COALESCE(?, discovered_date),
          updated_at = ?
        WHERE id = ?
        `,
        [
          candidate.sourceId,
          candidate.articleUrl,
          candidate.title,
          candidate.blurb ?? null,
          candidate.publishedAt ?? null,
          candidate.discoveredDate,
          candidate.discoveredAt,
          existing.id,
        ],
      );
      return existing.id;
    }

    const articleId = crypto.randomUUID();
    this.store.run(
      `
      INSERT INTO articles (
        id, source_id, discovery_id, canonical_url, article_url, title, blurb,
        published_at, discovered_date, analysis_status, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `,
      [
        articleId,
        candidate.sourceId,
        candidate.canonicalUrl,
        candidate.articleUrl,
        candidate.title,
        candidate.blurb ?? null,
        candidate.publishedAt ?? null,
        candidate.discoveredDate,
        candidate.discoveredAt,
      ],
    );
    return articleId;
  }

  async scan(params: ScanParams = {}): Promise<{ articles: ArticleCandidate[]; sourceCount: number }> {
    const since = params.since ? new Date(params.since) : undefined;
    const results: ArticleCandidate[] = [];
    const sources = this.resolveSources(params.sourceIds);

    for (const source of sources) {
      const candidates = await scanSource(source);
      for (const candidate of candidates) {
        if (since && candidate.publishedAt) {
          const published = new Date(candidate.publishedAt);
          if (!Number.isNaN(published.getTime()) && published < since) {
            results.push({
              articleId: "",
              ...candidate,
              status: "filtered_old",
            });
            continue;
          }
        }

        const known = this.store.get<{ id: string }>(
          "SELECT id FROM discoveries WHERE canonical_url = ?",
          [candidate.canonicalUrl],
        );
        const discoveryId = known?.id ?? crypto.randomUUID();
        const status: ArticleCandidate["status"] = known ? "known" : "new";

        this.store.run(
          `
          INSERT INTO discoveries (
            id, source_id, title, blurb, canonical_url, article_url,
            published_at, discovered_at, discovered_date, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(canonical_url) DO UPDATE SET
            source_id = excluded.source_id,
            title = excluded.title,
            blurb = excluded.blurb,
            article_url = excluded.article_url,
            published_at = COALESCE(excluded.published_at, discoveries.published_at),
            discovered_at = excluded.discovered_at,
            discovered_date = excluded.discovered_date,
            status = excluded.status
          `,
          [
            discoveryId,
            candidate.sourceId,
            candidate.title,
            candidate.blurb ?? null,
            candidate.canonicalUrl,
            candidate.articleUrl,
            candidate.publishedAt ?? null,
            candidate.discoveredAt,
            candidate.discoveredDate,
            status,
          ],
        );

        const articleId = this.ensureArticleStub(candidate);
        this.store.run("UPDATE articles SET discovery_id = ? WHERE id = ?", [discoveryId, articleId]);
        results.push({
          articleId,
          ...candidate,
          status,
        });
      }
    }

    return {
      articles: results,
      sourceCount: sources.length,
    };
  }

  private getArticlesForAnalysis(articleIds?: string[]): DbArticleRow[] {
    if (articleIds && articleIds.length > 0) {
      const placeholders = articleIds.map(() => "?").join(", ");
      return this.store.all<DbArticleRow>(
        `SELECT * FROM articles WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
        articleIds,
      );
    }
    return this.store.all<DbArticleRow>(
      "SELECT * FROM articles WHERE analysis_status != 'done' ORDER BY updated_at DESC LIMIT 50",
    );
  }

  private ensureAdhocUrl(url: string): string {
    const canonicalUrl = canonicalizeUrl(url);
    const existing = this.store.get<{ id: string }>(
      "SELECT id FROM articles WHERE canonical_url = ?",
      [canonicalUrl],
    );
    if (existing?.id) {
      return existing.id;
    }
    const articleId = crypto.randomUUID();
    const timestamp = nowIso();
    this.store.run(
      `
      INSERT INTO articles (
        id, source_id, discovery_id, canonical_url, article_url, title, blurb,
        published_at, discovered_date, analysis_status, updated_at
      ) VALUES (?, NULL, NULL, ?, ?, ?, NULL, NULL, ?, 'pending', ?)
      `,
      [articleId, canonicalUrl, url, canonicalUrl, toDateKey(timestamp), timestamp],
    );
    return articleId;
  }

  async analyze(params: AnalyzeParams = {}): Promise<AnalyzeOutput[]> {
    const ids = [...(params.articleIds ?? [])];
    for (const url of params.urls ?? []) {
      ids.push(this.ensureAdhocUrl(url));
    }

    const rows = this.getArticlesForAnalysis(ids.length > 0 ? ids : undefined);
    const outputs: AnalyzeOutput[] = [];

    for (const row of rows) {
      const extracted: ExtractedArticle = await extractArticle(row.article_url, { browserFallback: true });
      const analysis = await analyzeArticle({
        article: extracted,
        rules: this.loaded.rules,
      });
      const analyzedAt = nowIso();

      this.store.run("DELETE FROM article_images WHERE article_id = ?", [row.id]);
      extracted.images.slice(0, 5).forEach((image, index) => {
        const insight = analysis.heroImages.find((entry) => entry.url === image.url)?.insight;
        this.store.run(
          `
          INSERT INTO article_images (id, article_id, image_url, ordinal, vision_insight, width, height)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [crypto.randomUUID(), row.id, image.url, index, insight ?? null, image.width ?? null, image.height ?? null],
        );
      });

      this.store.run(
        `
        UPDATE articles SET
          title = ?,
          blurb = COALESCE(?, blurb),
          author = ?,
          published_at = COALESCE(?, published_at),
          content_text = ?,
          content_html = ?,
          summary = ?,
          why_relevant = ?,
          key_takeaways_json = ?,
          content_labels_json = ?,
          list_label = ?,
          relevance_score = ?,
          digest_eligible = ?,
          analysis_status = 'done',
          analyzed_at = ?,
          updated_at = ?
        WHERE id = ?
        `,
        [
          extracted.title,
          extracted.blurb ?? row.blurb,
          extracted.author ?? null,
          extracted.publishedAt ?? row.published_at,
          extracted.contentText,
          extracted.contentHtml,
          analysis.summary,
          analysis.whyRelevant,
          toJson(analysis.keyTakeaways),
          toJson(analysis.contentLabels),
          analysis.listLabel,
          analysis.relevanceScore,
          analysis.digestEligible ? 1 : 0,
          analyzedAt,
          analyzedAt,
          row.id,
        ],
      );

      outputs.push({
        articleId: row.id,
        sourceId: row.source_id ?? undefined,
        title: extracted.title,
        canonicalUrl: row.canonical_url,
        publishedAt: extracted.publishedAt ?? row.published_at ?? undefined,
        listLabel: analysis.listLabel,
        contentLabels: analysis.contentLabels,
        summary: analysis.summary,
        whyRelevant: analysis.whyRelevant,
        keyTakeaways: analysis.keyTakeaways,
        heroImages: analysis.heroImages,
        digestEligible: analysis.digestEligible,
        relevanceScore: analysis.relevanceScore,
      });
    }

    return outputs;
  }

  private buildOverview(date: string, rows: DbArticleRow[]): DigestMessage {
    const grouped = new Map<string, DbArticleRow[]>();
    for (const row of rows) {
      const list = row.list_label ?? "信息备查";
      if (!grouped.has(list)) {
        grouped.set(list, []);
      }
      grouped.get(list)?.push(row);
    }
    const sections = [...grouped.entries()].map(([label, items]) => {
      const lines = items.map((item, index) => `${index + 1}. ${item.title}`).join("\n");
      return `【${label}】\n${lines}`;
    });
    return {
      kind: "overview",
      title: `小熊公众号晨报 ${date}`,
      body: [`今天共整理 ${rows.length} 篇命中内容。`, ...sections].join("\n\n"),
    };
  }

  private buildDetailMessage(row: DbArticleRow): DigestMessage {
    const labels = parseJsonArray(row.content_labels_json).join(" / ");
    const takeaways = parseJsonArray(row.key_takeaways_json)
      .map((entry, index) => `${index + 1}. ${entry}`)
      .join("\n");
    return {
      kind: "detail",
      title: row.title,
      body: [
        row.list_label ? `标签：${row.list_label}${labels ? ` | ${labels}` : ""}` : labels ? `标签：${labels}` : "",
        row.summary ? `摘要：${row.summary}` : "",
        row.why_relevant ? `为什么值得看：${row.why_relevant}` : "",
        takeaways ? `要点：\n${takeaways}` : "",
        `链接：${row.article_url}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  async buildDigest(params: BuildParams = {}): Promise<BuildDigestOutput> {
    const date = params.date ?? toDateKey(new Date());
    const targetId = params.targetId ?? "aaron-wechat";
    const dryRun = params.dryRun ?? false;

    const rows = this.store.all<DbArticleRow>(
      `
      SELECT * FROM articles
      WHERE discovered_date = ?
        AND analysis_status = 'done'
        AND digest_eligible = 1
        AND id NOT IN (
          SELECT article_id FROM deliveries
          WHERE target_id = ?
            AND status = 'sent'
        )
      ORDER BY COALESCE(relevance_score, 0) DESC, COALESCE(published_at, updated_at) DESC
      `,
      [date, targetId],
    );

    const messages =
      rows.length > 0
        ? expandDigestMessages([this.buildOverview(date, rows), ...rows.map((row) => this.buildDetailMessage(row))])
        : [
            {
              kind: "overview" as const,
              title: `小熊公众号晨报 ${date}`,
              body: "今天没有命中规则的新文章，或者来源列表尚未配置。",
            },
          ];

    let sentCount = 0;
    if (!dryRun) {
      const target = this.resolveTarget(targetId);
      if (!target) {
        throw new Error(`Unknown delivery target: ${targetId}`);
      }
      const digestId = crypto.randomUUID();
      const createdAt = nowIso();
      this.store.run(
        `
        INSERT INTO digests (id, digest_date, target_id, overview_text, detail_count, status, created_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `,
        [
          digestId,
          date,
          targetId,
          `${messages[0]?.title}\n\n${messages[0]?.body}`.trim(),
          Math.max(messages.length - 1, 0),
          "pending",
          createdAt,
        ],
      );

      const delivery = sendDigestMessages({
        wrapperPath: process.env.OPENCLAW_CLI_WRAPPER ?? "",
        target,
        messages,
      });
      sentCount = delivery.sentCount;

      messages.forEach((message, index) => {
        const relatedArticleId =
          message.kind === "detail"
            ? rows.find((row) => row.title === message.title || message.title.startsWith(`${row.title} (`))?.id ?? null
            : null;
        this.store.run(
          `
          INSERT INTO deliveries (
            id, digest_id, article_id, target_id, channel, account_id, to_recipient,
            message_index, status, sent_at, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, NULL)
          `,
          [
            crypto.randomUUID(),
            digestId,
            relatedArticleId,
            targetId,
            target.channel,
            target.accountId ?? null,
            target.to,
            index,
            nowIso(),
          ],
        );
      });

      this.store.run("UPDATE digests SET status = 'sent', sent_at = ? WHERE id = ?", [nowIso(), digestId]);
    }

    return {
      date,
      targetId,
      dryRun,
      messages,
      sentCount,
      candidateCount: rows.length,
    };
  }

  async status(params: StatusParams = {}): Promise<StatusOutput> {
    const date = params.date ?? toDateKey(new Date());
    const sourcesEnabled = this.resolveSources().length;
    const discovered = Number(
      this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM discoveries WHERE discovered_date = ?", [date])
        ?.count ?? 0,
    );
    const analyzed = Number(
      this.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM articles WHERE discovered_date = ? AND analysis_status = 'done'",
        [date],
      )?.count ?? 0,
    );
    const digestEligible = Number(
      this.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM articles WHERE discovered_date = ? AND digest_eligible = 1",
        [date],
      )?.count ?? 0,
    );
    const delivered = Number(
      this.store.get<{ count: number }>(
        `
        SELECT COUNT(*) AS count FROM deliveries
        WHERE target_id = 'aaron-wechat'
          AND status = 'sent'
          AND sent_at LIKE ?
        `,
        [`${date}%`],
      )?.count ?? 0,
    );
    return {
      date,
      sourcesEnabled,
      discovered,
      analyzed,
      digestEligible,
      delivered,
      pendingDelivery: Math.max(digestEligible - delivered, 0),
    };
  }
}
