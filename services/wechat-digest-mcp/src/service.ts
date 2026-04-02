import crypto from "node:crypto";
import type {
  AnalyzeOutput,
  ArticleCandidate,
  BuildDigestOutput,
  DeliveryTargetConfig,
  DigestMessage,
  ExtractedArticle,
  LearningActionOutput,
  LearningCandidateStatus,
  LearningConfidence,
  LearningFollowupOutput,
  LearningPendingItem,
  LearningPendingOutput,
  RuleCandidate,
  StatusOutput,
} from "../../../packages/core/src/types.js";
import { canonicalizeUrl, nowIso, toDateKey } from "../../../packages/core/src/canonical.js";
import { loadServiceConfig } from "../../../packages/core/src/config.js";
import { SqliteStateStore } from "../../../packages/core/src/db.js";
import { sendDigestMessages } from "../../../packages/core/src/delivery.js";
import { expandDigestMessages } from "../../../packages/core/src/message-split.js";
import {
  applyCandidateToOverlayRules,
  readOverlayRules,
  ruleCandidateAlreadyCovered,
  writeOverlayRules,
} from "../../../packages/core/src/rules.js";
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

type FollowupParams = {
  date?: string;
  targetId?: string;
  dryRun?: boolean;
};

type StatusParams = {
  date?: string;
};

type PendingParams = {
  status?: LearningCandidateStatus | "all";
  limit?: number;
};

type ActionParams = {
  codes: string[];
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

type DbCandidateRow = {
  id: string;
  short_code: string;
  candidate_type: RuleCandidate["candidateType"];
  display_value: string;
  normalized_value: string;
  target_bucket: RuleCandidate["targetBucket"];
  target_label: string | null;
  aliases_json: string | null;
  confidence: LearningConfidence;
  rationale: string;
  evidence_snippet: string;
  breakout_candidate: number;
  status: LearningCandidateStatus;
  first_seen_at: string;
  last_seen_at: string;
  last_prompted_at: string | null;
  last_prompted_date: string | null;
  last_followup_at: string | null;
  last_followup_date: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  snoozed_until: string | null;
  suppressed_until: string | null;
  updated_at: string;
};

type DbCandidateEvidenceRow = {
  candidate_id: string;
  article_id: string;
  evidence_snippet: string | null;
  rationale: string | null;
  seen_count: number;
  title: string | null;
  discovered_date: string | null;
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

function addDaysIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function confidenceRank(value: LearningConfidence): number {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}…`;
}

export class WechatDigestService {
  private loaded = loadServiceConfig();
  private constructor(private readonly store: SqliteStateStore) {
    this.syncSources();
  }

  static async create(): Promise<WechatDigestService> {
    const loaded = loadServiceConfig();
    const store = await SqliteStateStore.open(loaded.paths.stateFile);
    return new WechatDigestService(store);
  }

  private reloadConfig() {
    this.loaded = loadServiceConfig();
    this.syncSources();
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

  private ensureLearningStatusesCurrent() {
    const now = nowIso();
    this.store.run(
      `
      UPDATE rule_candidates
      SET status = 'pending',
          snoozed_until = NULL,
          updated_at = ?
      WHERE status = 'snoozed'
        AND snoozed_until IS NOT NULL
        AND snoozed_until <= ?
      `,
      [now, now],
    );
  }

  private allocateLearningCode(): string {
    const rows = this.store.all<{ short_code: string | null }>(
      "SELECT short_code FROM rule_candidates WHERE short_code LIKE 'L%'",
    );
    const max = rows.reduce((current, row) => {
      const match = String(row.short_code ?? "").match(/^L(\d+)$/);
      const next = match ? Number(match[1]) : 0;
      return next > current ? next : current;
    }, 0);
    return `L${max + 1}`;
  }

  private getCandidateRowByCode(code: string): DbCandidateRow | undefined {
    return this.store.get<DbCandidateRow>(
      "SELECT * FROM rule_candidates WHERE short_code = ?",
      [code.trim().toUpperCase()],
    );
  }

  private candidateArticles(candidateId: string): DbCandidateEvidenceRow[] {
    return this.store.all<DbCandidateEvidenceRow>(
      `
      SELECT e.candidate_id, e.article_id, e.evidence_snippet, e.rationale, e.seen_count, a.title, a.discovered_date
      FROM rule_candidate_evidence e
      LEFT JOIN articles a ON a.id = e.article_id
      WHERE e.candidate_id = ?
      ORDER BY e.last_seen_at DESC
      `,
      [candidateId],
    );
  }

  private toPendingItem(row: DbCandidateRow): LearningPendingItem {
    const evidence = this.candidateArticles(row.id);
    return {
      code: row.short_code,
      status: row.status,
      candidateType: row.candidate_type,
      displayValue: row.display_value,
      normalizedValue: row.normalized_value,
      targetBucket: row.target_bucket,
      ...(row.target_label ? { targetLabel: row.target_label } : {}),
      aliases: parseJsonArray(row.aliases_json),
      confidence: row.confidence,
      breakoutCandidate: row.breakout_candidate === 1,
      rationale: row.rationale,
      evidenceSnippet: row.evidence_snippet,
      articleCount: evidence.length,
      evidenceArticleTitles: evidence.map((entry) => entry.title ?? entry.article_id).slice(0, 3),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      ...(row.last_prompted_at ? { lastPromptedAt: row.last_prompted_at } : {}),
      ...(row.last_followup_at ? { lastFollowupAt: row.last_followup_at } : {}),
      ...(row.snoozed_until ? { snoozedUntil: row.snoozed_until } : {}),
      ...(row.suppressed_until ? { suppressedUntil: row.suppressed_until } : {}),
    };
  }

  private shouldPromptCandidate(row: DbCandidateRow, articleCount: number): boolean {
    return row.breakout_candidate === 1 || row.confidence !== "low" || articleCount >= 2;
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

  private collectDigestLearningCandidates(params: {
    date: string;
    dryRun: boolean;
    limit?: number;
  }): DbCandidateRow[] {
    this.ensureLearningStatusesCurrent();
    const now = nowIso();
    const rows = this.store.all<DbCandidateRow>(
      `
      SELECT DISTINCT c.*
      FROM rule_candidates c
      INNER JOIN rule_candidate_evidence e ON e.candidate_id = c.id
      INNER JOIN articles a ON a.id = e.article_id
      WHERE c.status = 'pending'
        AND a.discovered_date = ?
        AND (c.snoozed_until IS NULL OR c.snoozed_until <= ?)
        AND (c.suppressed_until IS NULL OR c.suppressed_until <= ?)
        ${params.dryRun ? "" : "AND (c.last_prompted_date IS NULL OR c.last_prompted_date != ?)"}
      `,
      params.dryRun ? [params.date, now, now] : [params.date, now, now, params.date],
    );

    return rows
      .map((row) => ({ row, articleCount: this.candidateArticles(row.id).length }))
      .filter(({ row, articleCount }) => this.shouldPromptCandidate(row, articleCount))
      .sort((left, right) => {
        if (left.row.breakout_candidate !== right.row.breakout_candidate) {
          return right.row.breakout_candidate - left.row.breakout_candidate;
        }
        if (confidenceRank(left.row.confidence) !== confidenceRank(right.row.confidence)) {
          return confidenceRank(right.row.confidence) - confidenceRank(left.row.confidence);
        }
        if (left.articleCount !== right.articleCount) {
          return right.articleCount - left.articleCount;
        }
        return right.row.last_seen_at.localeCompare(left.row.last_seen_at);
      })
      .slice(0, params.limit ?? 3)
      .map(({ row }) => row);
  }

  private buildLearningReminderMessage(params: {
    date: string;
    rows: DbCandidateRow[];
    mode: "digest" | "followup";
  }): DigestMessage | null {
    if (params.rows.length === 0) {
      return null;
    }

    const reminderLines = params.rows.map((row) => {
      const item = this.toPendingItem(row);
      const reminderBucket =
        item.targetBucket === "labelKeyword" || item.targetBucket === "newLabel"
          ? `${item.targetBucket}${item.targetLabel ? `:${item.targetLabel}` : ""}`
          : item.targetBucket;
      const reminderEvidence = item.evidenceArticleTitles[0] ? `；证据：${item.evidenceArticleTitles[0]}` : "";
      return `- ${item.code} [${item.candidateType}/${item.confidence}] ${item.displayValue} -> ${reminderBucket}\n  理由：${item.rationale}${reminderEvidence}`;
    });
    const reminderIntro =
      params.mode === "digest"
        ? `以下是今天值得你审核的学习候选（最多展示 ${params.rows.length} 条）。`
        : "今天还有这些学习候选没有处理，我再提醒一次。";
    const reminderTitle =
      params.mode === "digest"
        ? `小熊学习候选 ${params.date}`
        : `小熊学习候选补提醒 ${params.date}`;
    return {
      kind: "learning",
      title: reminderTitle,
      body: [
        reminderIntro,
        ...reminderLines,
        "",
        "直接回复：",
        "- 批准 L12",
        "- 忽略 L12",
        "- 稍后 L12",
        "- 查看候选",
      ].join("\n"),
    };

    const lines = params.rows.map((row) => {
      const item = this.toPendingItem(row);
      const bucket =
        item.targetBucket === "labelKeyword" || item.targetBucket === "newLabel"
          ? `${item.targetBucket}${item.targetLabel ? `:${item.targetLabel}` : ""}`
          : item.targetBucket;
      const evidence = item.evidenceArticleTitles[0] ? `；证据：${item.evidenceArticleTitles[0]}` : "";
      return `- ${item.code} [${item.candidateType}/${item.confidence}] ${item.displayValue} -> ${bucket}；${item.rationale}${evidence}`;
    });

    const intro =
      params.mode === "digest"
        ? `以下是今天值得你审批的学习候选（最多展示 ${params.rows.length} 条）：`
        : "你今天还有这些学习候选没处理：";

    return {
      kind: "learning",
      title:
        params.mode === "digest"
          ? `小熊学习候选 ${params.date}`
          : `小熊学习候选补提醒 ${params.date}`,
      body: [
        intro,
        ...lines,
        "",
        "直接回复：",
        "- 批准 L12",
        "- 忽略 L12",
        "- 稍后 L12",
        "- 查看候选",
      ].join("\n"),
    };
  }

  private markCandidatesPrompted(rows: DbCandidateRow[], date: string, field: "prompt" | "followup") {
    const timestamp = nowIso();
    for (const row of rows) {
      if (field === "prompt") {
        this.store.run(
          `
          UPDATE rule_candidates
          SET last_prompted_at = ?, last_prompted_date = ?, updated_at = ?
          WHERE id = ?
          `,
          [timestamp, date, timestamp, row.id],
        );
        continue;
      }
      this.store.run(
        `
        UPDATE rule_candidates
        SET last_followup_at = ?, last_followup_date = ?, updated_at = ?
        WHERE id = ?
        `,
        [timestamp, date, timestamp, row.id],
      );
    }
  }

  private upsertLearningCandidate(params: {
    articleId: string;
    candidate: RuleCandidate;
    analyzedAt: string;
  }) {
    if (ruleCandidateAlreadyCovered(this.loaded.rules, params.candidate)) {
      return;
    }

    const now = params.analyzedAt;
    const existing = this.store.get<DbCandidateRow>(
      `
      SELECT * FROM rule_candidates
      WHERE candidate_type = ?
        AND normalized_value = ?
        AND target_bucket = ?
        AND COALESCE(target_label, '') = ?
      `,
      [
        params.candidate.candidateType,
        params.candidate.normalizedValue,
        params.candidate.targetBucket,
        params.candidate.targetLabel ?? "",
      ],
    );

    let candidateId = existing?.id ?? crypto.randomUUID();
    let status: LearningCandidateStatus = existing?.status ?? "pending";
    let rejectedAt = existing?.rejected_at ?? null;
    let suppressedUntil = existing?.suppressed_until ?? null;
    let snoozedUntil = existing?.snoozed_until ?? null;
    let approvedAt = existing?.approved_at ?? null;

    if (existing?.status === "rejected" && existing.suppressed_until && existing.suppressed_until <= now) {
      status = "pending";
      rejectedAt = null;
      suppressedUntil = null;
    }
    if (existing?.status === "snoozed" && existing.snoozed_until && existing.snoozed_until <= now) {
      status = "pending";
      snoozedUntil = null;
    }

    if (!existing) {
      this.store.run(
        `
        INSERT INTO rule_candidates (
          id, short_code, candidate_type, display_value, normalized_value, target_bucket, target_label,
          aliases_json, confidence, rationale, evidence_snippet, breakout_candidate, status,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          candidateId,
          this.allocateLearningCode(),
          params.candidate.candidateType,
          params.candidate.displayValue,
          params.candidate.normalizedValue,
          params.candidate.targetBucket,
          params.candidate.targetLabel ?? null,
          toJson(params.candidate.aliases ?? []),
          params.candidate.confidence,
          params.candidate.rationale,
          params.candidate.evidenceSnippet,
          params.candidate.breakoutCandidate ? 1 : 0,
          status,
          now,
          now,
          now,
        ],
      );
    } else {
      this.store.run(
        `
        UPDATE rule_candidates SET
          display_value = ?,
          aliases_json = ?,
          confidence = ?,
          rationale = ?,
          evidence_snippet = ?,
          breakout_candidate = ?,
          status = ?,
          approved_at = ?,
          rejected_at = ?,
          snoozed_until = ?,
          suppressed_until = ?,
          last_seen_at = ?,
          updated_at = ?
        WHERE id = ?
        `,
        [
          params.candidate.displayValue,
          toJson(params.candidate.aliases ?? []),
          params.candidate.confidence,
          params.candidate.rationale,
          params.candidate.evidenceSnippet,
          params.candidate.breakoutCandidate ? 1 : 0,
          status,
          approvedAt,
          rejectedAt,
          snoozedUntil,
          suppressedUntil,
          now,
          now,
          candidateId,
        ],
      );
    }

    const existingEvidence = this.store.get<{ seen_count: number }>(
      "SELECT seen_count FROM rule_candidate_evidence WHERE candidate_id = ? AND article_id = ?",
      [candidateId, params.articleId],
    );
    if (!existingEvidence) {
      this.store.run(
        `
        INSERT INTO rule_candidate_evidence (
          id, candidate_id, article_id, evidence_snippet, rationale, seen_count, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          crypto.randomUUID(),
          candidateId,
          params.articleId,
          params.candidate.evidenceSnippet,
          params.candidate.rationale,
          1,
          now,
          now,
        ],
      );
      return;
    }

    this.store.run(
      `
      UPDATE rule_candidate_evidence
      SET evidence_snippet = ?,
          rationale = ?,
          seen_count = ?,
          last_seen_at = ?
      WHERE candidate_id = ? AND article_id = ?
      `,
      [
        params.candidate.evidenceSnippet,
        params.candidate.rationale,
        existingEvidence.seen_count + 1,
        now,
        candidateId,
        params.articleId,
      ],
    );
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

      for (const candidate of analysis.ruleCandidates) {
        this.upsertLearningCandidate({
          articleId: row.id,
          candidate,
          analyzedAt,
        });
      }

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
        ruleCandidates: analysis.ruleCandidates,
      });
    }

    return outputs;
  }

  private buildOverview(date: string, rows: DbArticleRow[]): DigestMessage {
    const groupedRows = new Map<string, DbArticleRow[]>();
    for (const row of rows) {
      const groupLabel = row.list_label ?? "信息备查";
      if (!groupedRows.has(groupLabel)) {
        groupedRows.set(groupLabel, []);
      }
      groupedRows.get(groupLabel)?.push(row);
    }
    const overviewSections = [...groupedRows.entries()].map(([groupLabel, items]) => {
      const lines = items.map((item, index) => `${index + 1}. ${item.title}`).join("\n");
      return `【${groupLabel}】\n${lines}`;
    });
    return {
      kind: "overview",
      title: `小熊公众号晨报 ${date}`,
      body: [`今天共整理 ${rows.length} 篇命中内容。`, ...overviewSections].join("\n\n"),
    };

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
    const detailLabels = parseJsonArray(row.content_labels_json);
    const detailTakeaways = parseJsonArray(row.key_takeaways_json)
      .slice(0, 5)
      .map((entry, index) => `${index + 1}. ${entry}`)
      .join("\n");
    const detailBody = [
      row.list_label
        ? `分组：${row.list_label}${detailLabels.length > 0 ? ` | 标签：${detailLabels.join(" / ")}` : ""}`
        : detailLabels.length > 0
          ? `标签：${detailLabels.join(" / ")}`
          : "",
      row.summary ? `摘要：${truncate(row.summary, 280)}` : "",
      row.why_relevant ? `为什么值得看：${truncate(row.why_relevant, 280)}` : "",
      detailTakeaways ? `要点：\n${detailTakeaways}` : "",
      `链接：${row.article_url}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "detail",
      title: row.title,
      body: detailBody,
    };

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

  private createDigestRecord(params: {
    date: string;
    targetId: string;
    messages: DigestMessage[];
  }): string {
    const digestId = crypto.randomUUID();
    const createdAt = nowIso();
    this.store.run(
      `
      INSERT INTO digests (id, digest_date, target_id, overview_text, detail_count, status, created_at, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      [
        digestId,
        params.date,
        params.targetId,
        `${params.messages[0]?.title ?? ""}\n\n${params.messages[0]?.body ?? ""}`.trim(),
        Math.max(params.messages.length - 1, 0),
        "pending",
        createdAt,
      ],
    );
    return digestId;
  }

  private persistSentMessages(params: {
    digestId: string;
    targetId: string;
    target: DeliveryTargetConfig;
    messages: DigestMessage[];
    resolveArticleId: (message: DigestMessage) => string | null;
  }): number {
    const delivery = sendDigestMessages({
      wrapperPath: process.env.OPENCLAW_CLI_WRAPPER ?? "",
      target: params.target,
      messages: params.messages,
    });

    params.messages.forEach((message, index) => {
      this.store.run(
        `
        INSERT INTO deliveries (
          id, digest_id, article_id, target_id, channel, account_id, to_recipient,
          message_index, status, sent_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, NULL)
        `,
        [
          crypto.randomUUID(),
          params.digestId,
          params.resolveArticleId(message),
          params.targetId,
          params.target.channel,
          params.target.accountId ?? null,
          params.target.to,
          index,
          nowIso(),
        ],
      );
    });

    this.store.run("UPDATE digests SET status = 'sent', sent_at = ? WHERE id = ?", [nowIso(), params.digestId]);
    return delivery.sentCount;
  }

  async buildDigest(params: BuildParams = {}): Promise<BuildDigestOutput> {
    const digestDate = params.date ?? toDateKey(new Date());
    const digestTargetId = params.targetId ?? "aaron-wechat";
    const digestDryRun = params.dryRun ?? false;

    const digestRows = this.store.all<DbArticleRow>(
      `
      SELECT * FROM articles
      WHERE discovered_date = ?
        AND analysis_status = 'done'
        AND digest_eligible = 1
        AND id NOT IN (
          SELECT article_id FROM deliveries
          WHERE target_id = ?
            AND status = 'sent'
            AND article_id IS NOT NULL
        )
      ORDER BY COALESCE(relevance_score, 0) DESC, COALESCE(published_at, updated_at) DESC
      `,
      [digestDate, digestTargetId],
    );

    const learningRows = this.collectDigestLearningCandidates({
      date: digestDate,
      dryRun: digestDryRun,
      limit: 3,
    });
    const learningMessage = this.buildLearningReminderMessage({
      date: digestDate,
      rows: learningRows,
      mode: "digest",
    });

    const digestBaseMessages =
      digestRows.length > 0
        ? [this.buildOverview(digestDate, digestRows), ...digestRows.map((row) => this.buildDetailMessage(row))]
        : [
            {
              kind: "overview" as const,
              title: `小熊公众号晨报 ${digestDate}`,
              body: "今天没有命中规则的新文章，或者来源列表尚未配置。",
            },
          ];
    const digestMessages = learningMessage ? [...digestBaseMessages, learningMessage] : digestBaseMessages;
    const expandedMessages = expandDigestMessages(digestMessages);

    let digestSentCount = 0;
    if (!digestDryRun) {
      const resolvedDigestTarget = this.resolveTarget(digestTargetId);
      if (!resolvedDigestTarget) {
        throw new Error(`Unknown delivery target: ${digestTargetId}`);
      }
      const digestTarget: DeliveryTargetConfig = resolvedDigestTarget;
      const digestId = this.createDigestRecord({
        date: digestDate,
        targetId: digestTargetId,
        messages: expandedMessages,
      });
      digestSentCount = this.persistSentMessages({
        digestId,
        targetId: digestTargetId,
        target: digestTarget,
        messages: expandedMessages,
        resolveArticleId: (message) => {
          if (message.kind !== "detail") {
            return null;
          }
          return (
            digestRows.find(
              (row) => row.title === message.title || message.title.startsWith(`${row.title} (`),
            )?.id ?? null
          );
        },
      });
      if (learningRows.length > 0) {
        this.markCandidatesPrompted(learningRows, digestDate, "prompt");
      }
    }

    return {
      date: digestDate,
      targetId: digestTargetId,
      dryRun: digestDryRun,
      messages: expandedMessages,
      sentCount: digestSentCount,
      candidateCount: digestRows.length,
      learningCandidateCount: learningRows.length,
    };

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
            AND article_id IS NOT NULL
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
      const confirmedTarget = target!;
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
        target: confirmedTarget,
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
            confirmedTarget.channel,
            confirmedTarget.accountId ?? null,
            confirmedTarget.to,
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
      learningCandidateCount: 0,
    };
  }

  async sendLearningFollowup(params: FollowupParams = {}): Promise<LearningFollowupOutput> {
    this.ensureLearningStatusesCurrent();
    const followupDate = params.date ?? toDateKey(new Date());
    const followupTargetId = params.targetId ?? "aaron-wechat";
    const followupDryRun = params.dryRun ?? false;
    const now = nowIso();

    const followupRows = this.store.all<DbCandidateRow>(
      `
      SELECT * FROM rule_candidates
      WHERE status = 'pending'
        AND last_prompted_date = ?
        AND (last_followup_date IS NULL OR last_followup_date != ?)
        AND (snoozed_until IS NULL OR snoozed_until <= ?)
        AND (suppressed_until IS NULL OR suppressed_until <= ?)
      `,
      [followupDate, followupDate, now, now],
    )
      .map((row) => ({ row, articleCount: this.candidateArticles(row.id).length }))
      .filter(({ row, articleCount }) => this.shouldPromptCandidate(row, articleCount))
      .sort((left, right) => {
        if (left.row.breakout_candidate !== right.row.breakout_candidate) {
          return right.row.breakout_candidate - left.row.breakout_candidate;
        }
        if (confidenceRank(left.row.confidence) !== confidenceRank(right.row.confidence)) {
          return confidenceRank(right.row.confidence) - confidenceRank(left.row.confidence);
        }
        if (left.articleCount !== right.articleCount) {
          return right.articleCount - left.articleCount;
        }
        return right.row.last_seen_at.localeCompare(left.row.last_seen_at);
      })
      .slice(0, 3)
      .map(({ row }) => row);

    const followupReminder = this.buildLearningReminderMessage({
      date: followupDate,
      rows: followupRows,
      mode: "followup",
    });
    const followupMessages = followupReminder ? expandDigestMessages([followupReminder]) : [];

    let followupSentCount = 0;
    if (!followupDryRun && followupMessages.length > 0) {
      const followupTarget = this.resolveTarget(followupTargetId);
      if (!followupTarget) {
        throw new Error(`Unknown delivery target: ${followupTargetId}`);
      }
      const followupDigestId = this.createDigestRecord({
        date: followupDate,
        targetId: followupTargetId,
        messages: followupMessages,
      });
      followupSentCount = this.persistSentMessages({
        digestId: followupDigestId,
        targetId: followupTargetId,
        target: followupTarget,
        messages: followupMessages,
        resolveArticleId: () => null,
      });
      this.markCandidatesPrompted(followupRows, followupDate, "followup");
    }

    return {
      date: followupDate,
      targetId: followupTargetId,
      dryRun: followupDryRun,
      messages: followupMessages,
      sentCount: followupSentCount,
      candidateCount: followupRows.length,
    };
  }

  async pendingLearning(params: PendingParams = {}): Promise<LearningPendingOutput> {
    this.ensureLearningStatusesCurrent();
    const pendingStatus = params.status ?? "pending";
    const pendingLimit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const pendingRows =
      pendingStatus === "all"
        ? this.store.all<DbCandidateRow>(
            "SELECT * FROM rule_candidates ORDER BY last_seen_at DESC LIMIT ?",
            [pendingLimit],
          )
        : this.store.all<DbCandidateRow>(
            "SELECT * FROM rule_candidates WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?",
            [pendingStatus, pendingLimit],
          );

    return {
      items: pendingRows.map((row) => this.toPendingItem(row)),
      status: pendingStatus,
    };
  }

  private async mutateLearningCandidates(
    action: LearningActionOutput["action"],
    params: ActionParams,
  ): Promise<LearningActionOutput> {
    this.ensureLearningStatusesCurrent();
    const requestedCodes = [...new Set(params.codes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
    const applied: LearningPendingItem[] = [];
    const missingCodes: string[] = [];
    const updatedAt = nowIso();
    let overlayRules =
      action === "approve" ? readOverlayRules(this.loaded.paths.overlayRulesFile) : undefined;

    for (const code of requestedCodes) {
      const candidateRow = this.getCandidateRowByCode(code);
      if (!candidateRow) {
        missingCodes.push(code);
        continue;
      }

      if (action === "approve") {
        const approvedCandidate: RuleCandidate = {
          candidateType: candidateRow.candidate_type,
          displayValue: candidateRow.display_value,
          normalizedValue: candidateRow.normalized_value,
          targetBucket: candidateRow.target_bucket,
          ...(candidateRow.target_label ? { targetLabel: candidateRow.target_label } : {}),
          aliases: parseJsonArray(candidateRow.aliases_json),
          confidence: candidateRow.confidence,
          rationale: candidateRow.rationale,
          evidenceSnippet: candidateRow.evidence_snippet,
          breakoutCandidate: candidateRow.breakout_candidate === 1,
        };
        overlayRules = applyCandidateToOverlayRules(overlayRules ?? {}, approvedCandidate);
        this.store.run(
          `
          UPDATE rule_candidates
          SET status = 'approved',
              approved_at = ?,
              rejected_at = NULL,
              snoozed_until = NULL,
              suppressed_until = NULL,
              updated_at = ?
          WHERE id = ?
          `,
          [updatedAt, updatedAt, candidateRow.id],
        );
      } else if (action === "reject") {
        this.store.run(
          `
          UPDATE rule_candidates
          SET status = 'rejected',
              rejected_at = ?,
              snoozed_until = NULL,
              suppressed_until = ?,
              updated_at = ?
          WHERE id = ?
          `,
          [updatedAt, addDaysIso(30), updatedAt, candidateRow.id],
        );
      } else {
        this.store.run(
          `
          UPDATE rule_candidates
          SET status = 'snoozed',
              snoozed_until = ?,
              suppressed_until = NULL,
              updated_at = ?
          WHERE id = ?
          `,
          [addDaysIso(1), updatedAt, candidateRow.id],
        );
      }

      const updatedRow = this.getCandidateRowByCode(code);
      if (updatedRow) {
        applied.push(this.toPendingItem(updatedRow));
      }
    }

    if (action === "approve" && overlayRules) {
      writeOverlayRules(this.loaded.paths.overlayRulesFile, overlayRules);
      this.reloadConfig();
    }

    return {
      action,
      applied,
      missingCodes,
    };
  }

  async approveLearning(params: ActionParams): Promise<LearningActionOutput> {
    return this.mutateLearningCandidates("approve", params);
  }

  async rejectLearning(params: ActionParams): Promise<LearningActionOutput> {
    return this.mutateLearningCandidates("reject", params);
  }

  async snoozeLearning(params: ActionParams): Promise<LearningActionOutput> {
    return this.mutateLearningCandidates("snooze", params);
  }

  async status(params: StatusParams = {}): Promise<StatusOutput> {
    this.ensureLearningStatusesCurrent();
    const statusDate = params.date ?? toDateKey(new Date());
    const statusSourcesEnabled = this.resolveSources().length;
    const statusDiscovered = Number(
      this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM discoveries WHERE discovered_date = ?", [statusDate])
        ?.count ?? 0,
    );
    const statusAnalyzed = Number(
      this.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM articles WHERE discovered_date = ? AND analysis_status = 'done'",
        [statusDate],
      )?.count ?? 0,
    );
    const statusDigestEligible = Number(
      this.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM articles WHERE discovered_date = ? AND digest_eligible = 1",
        [statusDate],
      )?.count ?? 0,
    );
    const statusDelivered = Number(
      this.store.get<{ count: number }>(
        `
        SELECT COUNT(DISTINCT article_id) AS count FROM deliveries
        WHERE target_id = 'aaron-wechat'
          AND status = 'sent'
          AND article_id IS NOT NULL
          AND sent_at LIKE ?
        `,
        [`${statusDate}%`],
      )?.count ?? 0,
    );
    const statusPendingLearning = Number(
      this.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rule_candidates WHERE status = 'pending'",
      )?.count ?? 0,
    );
    return {
      date: statusDate,
      sourcesEnabled: statusSourcesEnabled,
      discovered: statusDiscovered,
      analyzed: statusAnalyzed,
      digestEligible: statusDigestEligible,
      delivered: statusDelivered,
      pendingDelivery: Math.max(statusDigestEligible - statusDelivered, 0),
      pendingLearning: statusPendingLearning,
    };

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
        SELECT COUNT(DISTINCT article_id) AS count FROM deliveries
        WHERE target_id = 'aaron-wechat'
          AND status = 'sent'
          AND article_id IS NOT NULL
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
      pendingLearning: 0,
    };
  }
}
