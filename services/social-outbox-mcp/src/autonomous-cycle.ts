import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { BlueskySocialService } from "../../bluesky-social-mcp/src/service.js";
import { ensureAutonomousDraft, type AutoDraftResult } from "./autodraft.js";
import { SocialOutboxService } from "./service.js";

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

export type LoadedAutopublishConfig = {
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

export type AutonomousCycleResult =
  | {
      status: "disabled" | "out_of_window" | "cooldown" | "idle";
      reason: string;
      autodraft?: AutoDraftResult;
      latestPublishedAt?: string;
      nextAllowedAt?: string;
    }
  | {
      status: "blocked";
      reason: string;
      bluesky: Awaited<ReturnType<BlueskySocialService["status"]>>;
      autodraft?: AutoDraftResult;
    }
  | {
      status: "dry_run" | "published";
      id: string;
      chosenVariant: string;
      uri: string | null;
      text: string;
      autodraft?: AutoDraftResult;
    };

export function loadAutopublishConfig(): LoadedAutopublishConfig {
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
    minHoursBetweenPosts: doc.minHoursBetweenPosts ?? 8,
    defaultVariant: doc.defaultVariant?.trim() || "B",
    autoDraft: {
      enabled: doc.autoDraft?.enabled !== false,
      model: doc.autoDraft?.model?.trim() || "qwen3.5-plus",
      minHoursBetweenDrafts: Math.max(4, doc.autoDraft?.minHoursBetweenDrafts ?? 8),
      maxChars: Math.max(120, doc.autoDraft?.maxChars ?? 260),
    },
  };
}

export async function runAutonomousCycle(params?: {
  dryRun?: boolean;
  service?: SocialOutboxService;
  bluesky?: BlueskySocialService;
  config?: LoadedAutopublishConfig;
}): Promise<AutonomousCycleResult> {
  const dryRun = params?.dryRun ?? false;
  const config = params?.config ?? loadAutopublishConfig();
  if (!config.enabled) {
    return {
      status: "disabled",
      reason: "social autopublish is disabled",
    };
  }

  const service = params?.service ?? SocialOutboxService.createFromEnv();
  let plan = service.planNextAutonomousBluesky({
    defaultVariant: config.defaultVariant,
    minHoursBetweenPosts: config.minHoursBetweenPosts,
    startHour: config.startHour,
    endHour: config.endHour,
  });

  let autodraft: AutoDraftResult | undefined;
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
    return {
      ...plan,
      ...(autodraft ? { autodraft } : {}),
    };
  }

  const bluesky = params?.bluesky ?? new BlueskySocialService();
  const status = await bluesky.status();
  if (!status.enabled || !status.configured || !status.authenticated) {
    return {
      status: "blocked",
      reason: "Bluesky is not ready for autonomous publishing.",
      bluesky: status,
      ...(autodraft ? { autodraft } : {}),
    };
  }

  const result = await service.publishBluesky({
    id: plan.item.id,
    variant: plan.chosenVariant,
    approval: `autonomously published by Xiaoxiong at ${new Date().toISOString()}`,
    dryRun,
  });

  return {
    status: dryRun ? "dry_run" : "published",
    id: result.item.id,
    chosenVariant: result.chosenVariant,
    uri: result.publish.uri ?? null,
    text: result.publish.text,
    ...(autodraft ? { autodraft } : {}),
  };
}
