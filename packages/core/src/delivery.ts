import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DeliveryTargetConfig, DigestMessage } from "./types.js";

function resolveWrapperWorkdir(wrapperPath: string): string {
  return path.dirname(path.dirname(wrapperPath));
}

export function sendDigestMessages(params: {
  wrapperPath: string;
  target: DeliveryTargetConfig;
  messages: DigestMessage[];
}): { sentCount: number } {
  const { wrapperPath, target, messages } = params;
  if (!wrapperPath) {
    throw new Error("OPENCLAW_CLI_WRAPPER is not configured.");
  }

  let sentCount = 0;
  for (const message of messages) {
    const text = `${message.title}\n\n${message.body}`.trim();
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      wrapperPath,
      "message",
      "send",
      "--channel",
      target.channel,
      "--target",
      target.to,
      "--message",
      text,
    ];
    if (target.accountId) {
      args.push("--account", target.accountId);
    }

    const result = spawnSync("powershell.exe", args, {
      cwd: resolveWrapperWorkdir(wrapperPath),
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `OpenClaw message send failed: ${result.stderr?.trim() || result.stdout?.trim() || result.status}`,
      );
    }
    sentCount += 1;
  }

  return { sentCount };
}
