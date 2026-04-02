import { describe, expect, it } from "vitest";
import {
  applyCandidateToOverlayRules,
  mergeDigestRules,
  removeCandidateFromOverlayRules,
} from "../packages/core/src/rules.js";
import type { DigestRulesConfig, RuleCandidate } from "../packages/core/src/types.js";

describe("rules overlay learning", () => {
  it("adds approved company and technology candidates into the overlay", () => {
    const base: DigestRulesConfig = {
      interests: {
        includeKeywords: ["agent"],
        companyWatchlist: ["OpenAI"],
      },
    };

    const companyCandidate: RuleCandidate = {
      candidateType: "company",
      displayValue: "BlackForest Labs",
      normalizedValue: "blackforest labs",
      targetBucket: "companyWatchlist",
      aliases: ["BFL"],
      confidence: "high",
      rationale: "New breakout model company",
      evidenceSnippet: "Released a notable model update",
      breakoutCandidate: true,
    };

    const technologyCandidate: RuleCandidate = {
      candidateType: "technology",
      displayValue: "GRPO",
      normalizedValue: "grpo",
      targetBucket: "priorityKeywords",
      confidence: "medium",
      rationale: "Relevant RL technique",
      evidenceSnippet: "Article discusses GRPO training",
      breakoutCandidate: false,
    };

    const overlay = applyCandidateToOverlayRules({}, companyCandidate);
    const merged = mergeDigestRules(base, applyCandidateToOverlayRules(overlay, technologyCandidate));

    expect(merged.interests?.companyWatchlist).toContain("BlackForest Labs");
    expect(merged.interests?.companyWatchlist).toContain("BFL");
    expect(merged.interests?.priorityKeywords).toContain("GRPO");
    expect(merged.interests?.includeKeywords).toContain("agent");
  });

  it("creates overlay-only content labels for new theme candidates", () => {
    const themeCandidate: RuleCandidate = {
      candidateType: "theme",
      displayValue: "Embodied AI",
      normalizedValue: "embodied ai",
      targetBucket: "newLabel",
      targetLabel: "Embodied AI",
      aliases: ["robotics foundation model"],
      confidence: "medium",
      rationale: "Emerging theme worth tracking",
      evidenceSnippet: "Multiple new releases focus on embodied AI",
      breakoutCandidate: true,
    };

    const overlay = applyCandidateToOverlayRules({}, themeCandidate);
    const label = overlay.labels?.content?.find((entry) => entry.label === "Embodied AI");

    expect(label).toBeDefined();
    expect(label?.keywords).toContain("Embodied AI");
    expect(label?.keywords).toContain("robotics foundation model");
  });

  it("removes revoked candidates from the overlay without touching base rules", () => {
    const candidate: RuleCandidate = {
      candidateType: "company",
      displayValue: "BlackForest Labs",
      normalizedValue: "blackforest labs",
      targetBucket: "companyWatchlist",
      aliases: ["BFL"],
      confidence: "high",
      rationale: "New breakout model company",
      evidenceSnippet: "Released a notable model update",
      breakoutCandidate: true,
    };

    const overlay = applyCandidateToOverlayRules({}, candidate);
    const revoked = removeCandidateFromOverlayRules(overlay, candidate);

    expect(revoked.interests?.companyWatchlist).toBeUndefined();
  });
});
