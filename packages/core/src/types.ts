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
    selectors?: HtmlListSelectors;
    json?: JsonListSelectors;
  };
};

export type DeliveryTargetConfig = {
  channel: string;
  to: string;
  accountId?: string;
};

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

export type ArticleAnalysisResult = {
  summary: string;
  whyRelevant: string;
  keyTakeaways: string[];
  contentLabels: string[];
  listLabel: string;
  digestEligible: boolean;
  relevanceScore: number;
  heroImages: ImageInsight[];
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
};

export type DigestMessage = {
  kind: "overview" | "detail";
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
};

export type StatusOutput = {
  date: string;
  sourcesEnabled: number;
  discovered: number;
  analyzed: number;
  digestEligible: number;
  delivered: number;
  pendingDelivery: number;
};
