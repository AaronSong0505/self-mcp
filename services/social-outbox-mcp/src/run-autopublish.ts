import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { BlueskySocialService } from "../../bluesky-social-mcp/src/service.js";
import { SocialOutboxService } from "./service.js";
import { ensureAutonomousDraft } from "./autodraft.js";

type AutopublishConfig = {
  enabled?: boolean;
  startHour?: number;
  endHour?: number;
  minHoursBetweenPosts?: number;
  defaultVariant?: string;
  autoDraft?: {
    enabled?: boolean;
    model?: string;
    minHoursBetweenDrafts?: number;
    maxChars?: number;
  };
};

type LoadedAutopublishConfig = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  minHoursBetweenPosts: number;
  defaultVariant: string;
  autoDraft: {
    enabled: boolean;
    model: string;
    minHoursBetweenDrafts: number;
    maxChars: number;
  };
};

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function loadConfig(): LoadedAutopublishConfig {
  const root =
    process.env.BLUESKY_SOCIAL_ROOT?.trim() ||
    process.env.WECHAT_DIGEST_ROOT?.trim() ||
    process.cwd();
  const configDir =
    process.env.BLUESKY_SOCIAL_CONFIG_DIR?.trim() ||
    process.env.WECHAT_DIGEST_CONFIG_DIR?.trim() ||
    path.join(root, "config");
  const file = path.join(configDir, "social_autopublish.yaml");
  const doc = fs.existsSync(file)
    ? ((YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as AutopublishConfig)
    : {};
  return {
    enabled: doc.enabled !== false,
    startHour: doc.startHour ?? 10,
    endHour: doc.endHour ?? 21,
    minHoursBetweenPosts: doc.minHoursBetweenPosts ?? 20,
    defaultVariant: doc.defaultVariant?.trim() || "B",
    autoDraft: {
      enabled: doc.autoDraft?.enabled !== false,
      model: doc.autoDraft?.model?.trim() || "qwen3.5-plus",
      minHoursBetweenDrafts: Math.max(6, doc.autoDraft?.minHoursBetweenDrafts ?? 16),
      maxChars: Math.max(120, doc.autoDraft?.maxChars ?? 260),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.enabled) {
    process.stdout.write(
      `${JSON.stringify({ status: "disabled", reason: "social autopublish is disabled" })}\n`,
    );
    return;
  }

  const service = SocialOutboxService.createFromEnv();
  let plan = service.planNextAutonomousBluesky({
    defaultVariant: config.defaultVariant,
    minHoursBetweenPosts: config.minHoursBetweenPosts,
    startHour: config.startHour,
    endHour: config.endHour,
  });

  let autodraft:
    | {
        status: "skipped";
        reason: string;
      }
    | {
        status: "created";
        id: string;
        title: string;
        chosenVariant: string;
      }
    | undefined;

  if ((plan.status === "idle" || plan.status === "cooldown") && !service.hasScheduledBlueskyItem()) {
    const workspaceRoot = path.dirname(
      process.env.SOCIAL_OUTBOX_PATH ??
        path.join("D:/tools_work/one-company/openclaw/workspace", "OUTBOX.md"),
    );
    autodraft = await ensureAutonomousDraft({
      service,
      workspaceRoot,
      config: config.autoDraft,
    });

    if (autodraft.status === "created") {
      plan = service.planNextAutonomousBluesky({
        defaultVariant: config.defaultVariant,
        minHoursBetweenPosts: config.minHoursBetweenPosts,
        startHour: config.startHour,
        endHour: config.endHour,
      });
    }
  }

  if (plan.status !== "ready") {
    process.stdout.write(`${JSON.stringify({ ...plan, autodraft })}\n`);
    return;
  }

  const bluesky = new BlueskySocialService();
  const status = await bluesky.status();
  if (!status.enabled || !status.configured || !status.authenticated) {
    process.stdout.write(
      `${JSON.stringify({
        status: "blocked",
        reason: "Bluesky is not ready for autonomous publishing.",
        bluesky: status,
      })}\n`,
    );
    return;
  }

  const result = await service.publishBluesky({
    id: plan.item.id,
    variant: plan.chosenVariant,
    approval: `autonomously published by Xiaoxiong at ${new Date().toISOString()}`,
    dryRun: args.dryRun,
  });

  process.stdout.write(
    `${JSON.stringify({
      status: args.dryRun ? "dry_run" : "published",
      id: result.item.id,
      chosenVariant: result.chosenVariant,
      uri: result.publish.uri ?? null,
      text: result.publish.text,
      autodraft,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `social-outbox-autopublish: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
