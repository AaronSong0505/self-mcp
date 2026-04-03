export type DiscoveryType = "rss" | "html_list" | "json_list";

export type HtmlListSelectors = {
  item: string;
  title: string;
  link: string;
  blurb?: string;
  publishedAt?: string;
};

export type JsonListSelectors = {
  listPath: string;
  titleField: string;
  linkField: string;
  linkTemplate?: string;
  blurbField?: string;
  publishedAtField?: string;
};

export type SourceConfig = {
  id: string;
  displayName: string;
  enabled?: boolean;
  discovery: {
    type: DiscoveryType;
    url: string;
    maxItems?: number;
    selectors?: HtmlListSelectors;
    json?: JsonListSelectors;
  };
};

export type DeliveryTargetConfig = {
  channel: string;
  to: string;
  accountId?: string;
};

export type WechatDeliveryConfig = {
  maxAttempts?: number;
  retryDelayMs?: number;
  interMessageDelayMs?: number;
  overviewDetailDelayMs?: number;
};

export type LearningCandidateType = "company" | "technology" | "theme";

export type LearningTargetBucket =
  | "companyWatchlist"
  | "priorityKeywords"
  | "includeKeywords"
  | "labelKeyword"
  | "newLabel";

export type LearningConfidence = "high" | "medium" | "low";

export type LearningCandidateStatus = "pending" | "approved" | "rejected" | "snoozed";
export type LearningDateField = "seen" | "approved" | "prompted" | "followup";

export type ContentLabelRule = {
  label: string;
  keywords: string[];
  weight?: number;
};

export type DigestRulesConfig = {
  analysis?: {
    baseUrl?: string;
    articleModel?: string;
    visionModel?: string;
    maxImages?: number;
    summaryMaxChars?: number;
    requestTimeoutMs?: number;
    maxAnalyzePerRun?: number;
  };
  delivery?: {
    wechat?: WechatDeliveryConfig;
  };
  interests?: {
    objective?: string;
    includeKeywords?: string[];
    priorityKeywords?: string[];
    companyWatchlist?: string[];
    deprioritizeKeywords?: string[];
    excludeKeywords?: string[];
  };
  labels?: {
    list?: string[];
    content?: ContentLabelRule[];
  };
  deliveryTargets?: Record<string, DeliveryTargetConfig>;
};

export type ServicePaths = {
  rootDir: string;
  configDir: string;
  dataDir: string;
  stateFile: string;
  articleCacheDir: string;
  imageCacheDir: string;
  overlayRulesFile: string;
};

export type LoadedServiceConfig = {
  paths: ServicePaths;
  sources: SourceConfig[];
  rules: DigestRulesConfig;
};

export type ArticleCandidate = {
  articleId: string;
  sourceId: string;
  title: string;
  blurb?: string;
  canonicalUrl: string;
  articleUrl: string;
  publishedAt?: string;
  discoveredAt: string;
  discoveredDate: string;
  status: "new" | "known" | "filtered_old";
};

export type ExtractedImage = {
  url: string;
  width?: number;
  height?: number;
};

export type ExtractedArticle = {
  title: string;
  author?: string;
  publishedAt?: string;
  contentText: string;
  contentHtml: string;
  blurb?: string;
  images: ExtractedImage[];
  rawUrl: string;
};

export type ImageInsight = {
  url: string;
  insight?: string;
};

export type RuleCandidate = {
  candidateType: LearningCandidateType;
  displayValue: string;
  normalizedValue: string;
  targetBucket: LearningTargetBucket;
  targetLabel?: string;
  aliases?: string[];
  confidence: LearningConfidence;
  rationale: string;
  evidenceSnippet: string;
  breakoutCandidate: boolean;
};

export type ArticleAnalysisResult = {
  summary: string;
  whyRelevant: string;
  keyTakeaways: string[];
  contentLabels: string[];
  listLabel: string;
  digestEligible: boolean;
  relevanceScore: number;
  heroImages: ImageInsight[];
  ruleCandidates: RuleCandidate[];
};

export type AnalyzeOutput = {
  articleId: string;
  sourceId?: string;
  title: string;
  canonicalUrl: string;
  publishedAt?: string;
  listLabel: string;
  contentLabels: string[];
  summary: string;
  whyRelevant: string;
  keyTakeaways: string[];
  heroImages: ImageInsight[];
  digestEligible: boolean;
  relevanceScore: number;
  ruleCandidates: RuleCandidate[];
};

export type DigestMessage = {
  kind: "overview" | "detail" | "learning";
  title: string;
  body: string;
};

export type BuildDigestOutput = {
  date: string;
  targetId?: string;
  dryRun: boolean;
  messages: DigestMessage[];
  sentCount: number;
  candidateCount: number;
  learningCandidateCount: number;
};

export type StatusOutput = {
  date: string;
  sourcesEnabled: number;
  discovered: number;
  analyzed: number;
  digestEligible: number;
  delivered: number;
  pendingDelivery: number;
  pendingLearning: number;
};

export type LearningPendingItem = {
  code: string;
  status: LearningCandidateStatus;
  candidateType: LearningCandidateType;
  displayValue: string;
  normalizedValue: string;
  targetBucket: LearningTargetBucket;
  targetLabel?: string;
  aliases: string[];
  confidence: LearningConfidence;
  breakoutCandidate: boolean;
  rationale: string;
  evidenceSnippet: string;
  articleCount: number;
  evidenceArticleTitles: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  lastPromptedAt?: string;
  lastFollowupAt?: string;
  snoozedUntil?: string;
  suppressedUntil?: string;
};

export type LearningPendingOutput = {
  items: LearningPendingItem[];
  status: LearningCandidateStatus | "all";
  dateField?: LearningDateField;
  dateFrom?: string;
  dateTo?: string;
};

export type LearningActionOutput = {
  action: "approve" | "reject" | "snooze" | "revoke";
  applied: LearningPendingItem[];
  missingCodes: string[];
};

export type LearningFollowupOutput = {
  date: string;
  targetId: string;
  dryRun: boolean;
  messages: DigestMessage[];
  sentCount: number;
  candidateCount: number;
};
