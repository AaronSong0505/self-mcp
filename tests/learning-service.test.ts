import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WechatDigestService } from "../services/wechat-digest-mcp/src/service.js";

const cleanupDirs: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-mcp-learning-"));
  cleanupDirs.push(root);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

function writeConfig(root: string) {
  fs.writeFileSync(
    path.join(root, "config", "wechat_sources.yaml"),
    `sources:
  - id: sample
    displayName: Sample
    enabled: true
    discovery:
      type: html_list
      url: https://example.com
      selectors:
        item: article
        title: a
        link: a
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(root, "config", "wechat_digest_rules.yaml"),
    `deliveryTargets:
  aaron-wechat:
    channel: openclaw-weixin
    accountId: sample-account
    to: sample@im.wechat
interests:
  companyWatchlist:
    - OpenAI
`,
    "utf8",
  );
}

async function createService(root: string) {
  process.env.WECHAT_DIGEST_ROOT = root;
  process.env.WECHAT_DIGEST_CONFIG_DIR = path.join(root, "config");
  process.env.WECHAT_DIGEST_DATA_DIR = path.join(root, "data");
  return WechatDigestService.create();
}

function getStore(service: WechatDigestService) {
  return (service as unknown as { store: { run: (sql: string, params?: unknown[]) => void } }).store;
}

afterEach(() => {
  delete process.env.WECHAT_DIGEST_ROOT;
  delete process.env.WECHAT_DIGEST_CONFIG_DIR;
  delete process.env.WECHAT_DIGEST_DATA_DIR;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("learning candidate workflow", () => {
  it("lists pending candidates, builds followup reminders, and approves into overlay rules", async () => {
    const root = createTempRoot();
    writeConfig(root);
    const service = await createService(root);
    const store = getStore(service);

    store.run(
      `
      INSERT INTO articles (
        id, source_id, discovery_id, canonical_url, article_url, title, blurb,
        published_at, discovered_date, content_text, content_html, summary, why_relevant,
        key_takeaways_json, content_labels_json, list_label, relevance_score,
        digest_eligible, analysis_status, analyzed_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "article-1",
        "sample",
        "https://example.com/article-1",
        "https://example.com/article-1",
        "BlackForest Labs released a new model",
        "sample blurb",
        "2026-04-02T08:00:00.000Z",
        "2026-04-02",
        "body",
        "<p>body</p>",
        "summary",
        "why",
        JSON.stringify(["takeaway"]),
        JSON.stringify(["AI/LLM"]),
        "必读",
        9,
        1,
        "done",
        "2026-04-02T08:10:00.000Z",
        "2026-04-02T08:10:00.000Z",
      ],
    );

    store.run(
      `
      INSERT INTO rule_candidates (
        id, short_code, candidate_type, display_value, normalized_value, target_bucket, target_label,
        aliases_json, confidence, rationale, evidence_snippet, breakout_candidate, status,
        first_seen_at, last_seen_at, last_prompted_at, last_prompted_date,
        last_followup_at, last_followup_date, approved_at, rejected_at,
        snoozed_until, suppressed_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)
      `,
      [
        "candidate-1",
        "L12",
        "company",
        "BlackForest Labs",
        "blackforest labs",
        "companyWatchlist",
        null,
        JSON.stringify(["BFL"]),
        "high",
        "New breakout AI company to watch",
        "BlackForest Labs shipped a notable model release",
        1,
        "pending",
        "2026-04-02T08:15:00.000Z",
        "2026-04-02T08:15:00.000Z",
        "2026-04-02T08:45:00.000Z",
        "2026-04-02",
        "2026-04-02T08:15:00.000Z",
      ],
    );

    store.run(
      `
      INSERT INTO rule_candidate_evidence (
        id, candidate_id, article_id, evidence_snippet, rationale, seen_count, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "evidence-1",
        "candidate-1",
        "article-1",
        "BlackForest Labs shipped a notable model release",
        "New breakout AI company to watch",
        1,
        "2026-04-02T08:15:00.000Z",
        "2026-04-02T08:15:00.000Z",
      ],
    );

    const pending = await service.pendingLearning({ status: "pending", limit: 10 });
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]?.code).toBe("L12");
    expect(pending.items[0]?.evidenceArticleTitles).toContain("BlackForest Labs released a new model");

    const followup = await service.sendLearningFollowup({
      date: "2026-04-02",
      targetId: "aaron-wechat",
      dryRun: true,
    });
    expect(followup.candidateCount).toBe(1);
    expect(followup.messages).toHaveLength(1);
    expect(followup.messages[0]?.body).toContain("L12");

    const approved = await service.approveLearning({ codes: ["L12"] });
    expect(approved.applied).toHaveLength(1);
    expect(approved.missingCodes).toEqual([]);
    expect(approved.applied[0]?.status).toBe("approved");

    const overlayPath = path.join(root, "data", "rules.overlay.yaml");
    const overlayText = fs.readFileSync(overlayPath, "utf8");
    expect(overlayText).toContain("BlackForest Labs");
    expect(overlayText).toContain("BFL");
  });
});
