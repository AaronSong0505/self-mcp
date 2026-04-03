import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { nowIso, toDateKey } from "../../../packages/core/src/canonical.js";
import { loadServiceConfig, resolveServicePaths } from "../../../packages/core/src/config.js";
import { SqliteStateStore } from "../../../packages/core/src/db.js";
import { sendDigestMessages } from "../../../packages/core/src/delivery.js";
import type { DeliveryTargetConfig, DigestMessage } from "../../../packages/core/src/types.js";

type HouseholdPersonConfig = {
  targetId?: string;
  aliases?: string[];
};

type HouseholdPairConfig = {
  from?: string;
  to?: string;
};

type HouseholdConfig = {
  enabled?: boolean;
  title?: string;
  maxChars?: number;
  people?: Record<string, HouseholdPersonConfig>;
  allowedPairs?: HouseholdPairConfig[];
};

type LoadedHouseholdConfig = {
  enabled: boolean;
  title: string;
  maxChars: number;
  people: Record<string, { targetId: string; aliases: string[] }>;
  allowedPairs: Array<{ from: string; to: string }>;
};

export type HouseholdRelayResult = {
  date: string;
  fromPerson: string;
  toPerson: string;
  fromTargetId: string;
  toTargetId: string;
  status: "disabled" | "dry_run" | "sent";
  requestedText: string;
  forwardedText: string;
  recipient?: string;
  sentCount: number;
};

type SendRelayParams = {
  fromPerson: string;
  toPerson: string;
  message: string;
  dryRun?: boolean;
};

function readYamlFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return (YAML.parse(raw) ?? fallback) as T;
}

function normalizeText(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function truncate(text: string, maxChars: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function loadHouseholdConfig(): LoadedHouseholdConfig {
  const paths = resolveServicePaths();
  const raw = readYamlFile<HouseholdConfig>(path.join(paths.configDir, "wechat_household.yaml"), {});
  const peopleEntries = Object.entries(raw.people ?? {}).filter(
    ([name, config]) => Boolean(name?.trim()) && Boolean(config?.targetId?.trim()),
  );
  const people = Object.fromEntries(
    peopleEntries.map(([name, config]) => [
      name.trim(),
      {
        targetId: config.targetId!.trim(),
        aliases: [name, ...(config.aliases ?? []).map((entry) => String(entry).trim())].filter(Boolean),
      },
    ]),
  );

  const fallbackPairNames = Object.keys(people);
  const allowedPairs = (raw.allowedPairs ?? [])
    .map((pair) => ({
      from: String(pair.from ?? "").trim(),
      to: String(pair.to ?? "").trim(),
    }))
    .filter((pair) => pair.from && pair.to);

  return {
    enabled: raw.enabled !== false,
    title: raw.title?.trim() || "小熊帮忙转一句 🐻",
    maxChars: Math.max(80, raw.maxChars ?? 600),
    people,
    allowedPairs:
      allowedPairs.length > 0
        ? allowedPairs
        : fallbackPairNames.length >= 2
          ? [
              { from: fallbackPairNames[0]!, to: fallbackPairNames[1]! },
              { from: fallbackPairNames[1]!, to: fallbackPairNames[0]! },
            ]
          : [],
  };
}

function matchesPerson(input: string, candidateName: string, aliases: string[]): boolean {
  const normalizedInput = normalizeText(input).toLowerCase();
  if (!normalizedInput) {
    return false;
  }
  if (candidateName.toLowerCase() === normalizedInput) {
    return true;
  }
  return aliases.some((alias) => alias.toLowerCase() === normalizedInput);
}

function formatRelayBody(fromPerson: string, message: string): string {
  const cleanedMessage = normalizeText(message);
  return `${fromPerson} 刚刚请我转告你：\n\n${cleanedMessage}\n\n这是我替她原样带到的话。`;
}

export class WechatHouseholdRelayService {
  private readonly loaded = loadServiceConfig();
  private readonly config = loadHouseholdConfig();

  private constructor(private readonly store: SqliteStateStore) {}

  static async create(): Promise<WechatHouseholdRelayService> {
    const loaded = loadServiceConfig();
    const store = await SqliteStateStore.open(loaded.paths.stateFile);
    return new WechatHouseholdRelayService(store);
  }

  private resolveConfiguredPerson(input: string): { name: string; targetId: string } {
    const match = Object.entries(this.config.people).find(([name, config]) =>
      matchesPerson(input, name, config.aliases),
    );
    if (!match) {
      throw new Error(`Unknown household person: ${input}`);
    }
    return {
      name: match[0],
      targetId: match[1].targetId,
    };
  }

  private assertAllowedPair(fromPerson: string, toPerson: string): void {
    const allowed = this.config.allowedPairs.some((pair) => pair.from === fromPerson && pair.to === toPerson);
    if (!allowed) {
      throw new Error(`Relay from ${fromPerson} to ${toPerson} is not enabled.`);
    }
  }

  private resolveTarget(targetId: string): DeliveryTargetConfig {
    const target = this.loaded.rules.deliveryTargets?.[targetId];
    if (!target) {
      throw new Error(`Unknown delivery target: ${targetId}`);
    }
    return target;
  }

  async sendRelay(params: SendRelayParams): Promise<HouseholdRelayResult> {
    const requestedText = truncate(params.message, this.config.maxChars);
    if (!requestedText) {
      throw new Error("Relay message is empty.");
    }

    const fromPerson = this.resolveConfiguredPerson(params.fromPerson);
    const toPerson = this.resolveConfiguredPerson(params.toPerson);
    if (fromPerson.name === toPerson.name) {
      throw new Error("Relay sender and recipient must be different people.");
    }
    this.assertAllowedPair(fromPerson.name, toPerson.name);

    const date = toDateKey(new Date());
    const forwardedText = formatRelayBody(fromPerson.name, requestedText);
    if (!this.config.enabled) {
      return {
        date,
        fromPerson: fromPerson.name,
        toPerson: toPerson.name,
        fromTargetId: fromPerson.targetId,
        toTargetId: toPerson.targetId,
        status: "disabled",
        requestedText,
        forwardedText,
        sentCount: 0,
      };
    }

    if (params.dryRun) {
      return {
        date,
        fromPerson: fromPerson.name,
        toPerson: toPerson.name,
        fromTargetId: fromPerson.targetId,
        toTargetId: toPerson.targetId,
        status: "dry_run",
        requestedText,
        forwardedText,
        sentCount: 0,
      };
    }

    const relayId = crypto.randomUUID();
    this.store.run(
      `
      INSERT INTO household_relays (
        id, relay_date, from_person, from_target_id, to_person, to_target_id,
        request_text, forwarded_text, status, source_recipient, destination_recipient,
        created_at, sent_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)
      `,
      [
        relayId,
        date,
        fromPerson.name,
        fromPerson.targetId,
        toPerson.name,
        toPerson.targetId,
        requestedText,
        forwardedText,
        nowIso(),
      ],
    );

    try {
      const delivery = await sendDigestMessages({
        wrapperPath: process.env.OPENCLAW_CLI_WRAPPER ?? "",
        target: this.resolveTarget(toPerson.targetId),
        messages: [
          {
            kind: "overview",
            title: this.config.title,
            body: forwardedText,
          } satisfies DigestMessage,
        ],
        wechatConfig: this.loaded.rules.delivery?.wechat,
      });

      this.store.run(
        `
        UPDATE household_relays
        SET status = 'sent',
            destination_recipient = ?,
            sent_at = ?,
            error = NULL
        WHERE id = ?
        `,
        [delivery.recipient, nowIso(), relayId],
      );

      return {
        date,
        fromPerson: fromPerson.name,
        toPerson: toPerson.name,
        fromTargetId: fromPerson.targetId,
        toTargetId: toPerson.targetId,
        status: "sent",
        requestedText,
        forwardedText,
        recipient: delivery.recipient,
        sentCount: delivery.sentCount,
      };
    } catch (error) {
      this.store.run(
        `
        UPDATE household_relays
        SET status = 'failed',
            error = ?
        WHERE id = ?
        `,
        [String(error), relayId],
      );
      throw error;
    }
  }
}
