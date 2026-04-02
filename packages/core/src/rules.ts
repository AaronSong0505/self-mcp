import fs from "node:fs";
import YAML from "yaml";
import type {
  ContentLabelRule,
  DigestRulesConfig,
  LearningCandidateType,
  RuleCandidate,
} from "./types.js";

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function mergeStringArrays(base?: string[], overlay?: string[]): string[] | undefined {
  const merged = dedupeStrings([...(base ?? []), ...(overlay ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

function mergeContentLabels(
  base?: ContentLabelRule[],
  overlay?: ContentLabelRule[],
): ContentLabelRule[] | undefined {
  const merged = new Map<string, ContentLabelRule>();
  for (const rule of base ?? []) {
    merged.set(rule.label, {
      label: rule.label,
      keywords: dedupeStrings(rule.keywords),
      ...(rule.weight != null ? { weight: rule.weight } : {}),
    });
  }
  for (const rule of overlay ?? []) {
    const existing = merged.get(rule.label);
    merged.set(rule.label, {
      label: rule.label,
      keywords: dedupeStrings([...(existing?.keywords ?? []), ...rule.keywords]),
      weight: rule.weight ?? existing?.weight,
    });
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

export function mergeDigestRules(
  base: DigestRulesConfig = {},
  overlay: DigestRulesConfig = {},
): DigestRulesConfig {
  return {
    analysis: {
      ...base.analysis,
      ...overlay.analysis,
    },
    interests: {
      ...base.interests,
      ...overlay.interests,
      includeKeywords: mergeStringArrays(
        base.interests?.includeKeywords,
        overlay.interests?.includeKeywords,
      ),
      priorityKeywords: mergeStringArrays(
        base.interests?.priorityKeywords,
        overlay.interests?.priorityKeywords,
      ),
      companyWatchlist: mergeStringArrays(
        base.interests?.companyWatchlist,
        overlay.interests?.companyWatchlist,
      ),
      deprioritizeKeywords: mergeStringArrays(
        base.interests?.deprioritizeKeywords,
        overlay.interests?.deprioritizeKeywords,
      ),
      excludeKeywords: mergeStringArrays(
        base.interests?.excludeKeywords,
        overlay.interests?.excludeKeywords,
      ),
    },
    labels: {
      ...base.labels,
      ...overlay.labels,
      list: mergeStringArrays(base.labels?.list, overlay.labels?.list),
      content: mergeContentLabels(base.labels?.content, overlay.labels?.content),
    },
    deliveryTargets: {
      ...(base.deliveryTargets ?? {}),
      ...(overlay.deliveryTargets ?? {}),
    },
  };
}

export function readOverlayRules(filePath: string): DigestRulesConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return (YAML.parse(raw) ?? {}) as DigestRulesConfig;
}

export function writeOverlayRules(filePath: string, rules: DigestRulesConfig): void {
  const serialized = YAML.stringify(rules);
  fs.writeFileSync(filePath, serialized, "utf8");
}

export function normalizeLearningValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function ruleContainsKeyword(values: string[] | undefined, candidate: RuleCandidate): boolean {
  const normalized = normalizeLearningValue(candidate.displayValue);
  const aliases = (candidate.aliases ?? []).map((entry) => normalizeLearningValue(entry));
  return (values ?? []).some((value) => {
    const target = normalizeLearningValue(value);
    return target === normalized || aliases.includes(target);
  });
}

export function ruleCandidateAlreadyCovered(
  rules: DigestRulesConfig,
  candidate: RuleCandidate,
): boolean {
  switch (candidate.targetBucket) {
    case "companyWatchlist":
      return ruleContainsKeyword(rules.interests?.companyWatchlist, candidate);
    case "priorityKeywords":
      return ruleContainsKeyword(rules.interests?.priorityKeywords, candidate);
    case "includeKeywords":
      return ruleContainsKeyword(rules.interests?.includeKeywords, candidate);
    case "labelKeyword": {
      const label = candidate.targetLabel?.trim();
      if (!label) {
        return false;
      }
      const match = (rules.labels?.content ?? []).find((entry) => entry.label === label);
      return ruleContainsKeyword(match?.keywords, candidate);
    }
    case "newLabel": {
      const label = candidate.targetLabel?.trim();
      if (!label) {
        return false;
      }
      return (rules.labels?.content ?? []).some((entry) => entry.label === label);
    }
    default:
      return false;
  }
}

function ensureLabel(
  rules: DigestRulesConfig,
  label: string,
  weight = 1,
): ContentLabelRule {
  const existing =
    rules.labels?.content?.find((entry) => entry.label === label) ??
    ({ label, keywords: [], weight } satisfies ContentLabelRule);
  if (!rules.labels) {
    rules.labels = {};
  }
  if (!rules.labels.content) {
    rules.labels.content = [];
  }
  const found = rules.labels.content.find((entry) => entry.label === label);
  if (found) {
    return found;
  }
  rules.labels.content.push(existing);
  return existing;
}

export function applyCandidateToOverlayRules(
  overlay: DigestRulesConfig,
  candidate: RuleCandidate,
): DigestRulesConfig {
  const next = mergeDigestRules({}, overlay);
  const values = dedupeStrings([candidate.displayValue, ...(candidate.aliases ?? [])]);

  switch (candidate.targetBucket) {
    case "companyWatchlist":
      next.interests = next.interests ?? {};
      next.interests.companyWatchlist = dedupeStrings([
        ...(next.interests.companyWatchlist ?? []),
        ...values,
      ]);
      break;
    case "priorityKeywords":
      next.interests = next.interests ?? {};
      next.interests.priorityKeywords = dedupeStrings([
        ...(next.interests.priorityKeywords ?? []),
        ...values,
      ]);
      break;
    case "includeKeywords":
      next.interests = next.interests ?? {};
      next.interests.includeKeywords = dedupeStrings([
        ...(next.interests.includeKeywords ?? []),
        ...values,
      ]);
      break;
    case "labelKeyword": {
      const label =
        candidate.targetLabel?.trim() ||
        (candidate.candidateType === "theme" ? candidate.displayValue.trim() : undefined);
      if (!label) {
        break;
      }
      const rule = ensureLabel(next, label, candidate.candidateType === "theme" ? 1.5 : 1);
      rule.keywords = dedupeStrings([...(rule.keywords ?? []), ...values]);
      break;
    }
    case "newLabel": {
      const label = candidate.targetLabel?.trim() || candidate.displayValue.trim();
      if (!label) {
        break;
      }
      const rule = ensureLabel(next, label, 1.5);
      rule.keywords = dedupeStrings([...(rule.keywords ?? []), ...values]);
      break;
    }
  }

  return next;
}

export function defaultBucketForCandidateType(
  candidateType: LearningCandidateType,
): RuleCandidate["targetBucket"] {
  switch (candidateType) {
    case "company":
      return "companyWatchlist";
    case "technology":
      return "includeKeywords";
    case "theme":
      return "labelKeyword";
  }
}
