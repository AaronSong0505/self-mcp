import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WechatDigestService } from "../services/wechat-digest-mcp/src/service.js";

const cleanupDirs: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "self-mcp-test-"));
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

describe("digest build", () => {
  it("does not let overview-only deliveries block article previews", async () => {
    const root = createTempRoot();
    writeConfig(root);
    const service = await createService(root);
    const store = (service as unknown as { store: { run: (sql: string, params?: unknown[]) => void } }).store;

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
        "Sample article",
        "sample blurb",
        "2026-04-02T00:00:00.000Z",
        "2026-04-02",
        "body",
        "<p>body</p>",
        "summary",
        "why",
        JSON.stringify(["takeaway"]),
        JSON.stringify(["AI/LLM"]),
        "必读",
        10,
        1,
        "done",
        "2026-04-02T00:10:00.000Z",
        "2026-04-02T00:10:00.000Z",
      ],
    );

    store.run(
      `
      INSERT INTO deliveries (
        id, digest_id, article_id, target_id, channel, account_id, to_recipient,
        message_index, status, sent_at, error
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      [
        "delivery-overview",
        "digest-1",
        "aaron-wechat",
        "openclaw-weixin",
        "sample-account",
        "sample@im.wechat",
        0,
        "sent",
        "2026-04-02T00:20:00.000Z",
      ],
    );

    const digest = await service.buildDigest({
      date: "2026-04-02",
      targetId: "aaron-wechat",
      dryRun: true,
    });
    const status = await service.status({ date: "2026-04-02" });

    expect(digest.candidateCount).toBe(1);
    expect(digest.messages).toHaveLength(2);
    expect(status.delivered).toBe(0);
    expect(status.pendingDelivery).toBe(1);
  });
});
