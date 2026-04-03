import { loadServiceConfig } from "../../../packages/core/src/config.js";
import { sendDigestMessages } from "../../../packages/core/src/delivery.js";

type ParsedArgs = {
  targetId: string;
  title: string;
  body: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    targetId: "aaron-wechat",
    title: "小熊诊断消息",
    body: "这是一条通过正式 UTF-8 发送链路发出的诊断消息。",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (!next) {
      continue;
    }
    if (current === "--target") {
      parsed.targetId = next;
      index += 1;
    } else if (current === "--title") {
      parsed.title = next;
      index += 1;
    } else if (current === "--body") {
      parsed.body = next;
      index += 1;
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wrapperPath = process.env.OPENCLAW_CLI_WRAPPER ?? "";
  if (!wrapperPath) {
    throw new Error("OPENCLAW_CLI_WRAPPER is not configured.");
  }

  const loaded = loadServiceConfig();
  const target = loaded.rules.deliveryTargets?.[args.targetId];
  if (!target) {
    throw new Error(`Unknown delivery target: ${args.targetId}`);
  }

  const result = await sendDigestMessages({
    wrapperPath,
    target,
    messages: [
      {
        kind: "overview",
        title: args.title,
        body: args.body,
      },
    ],
    wechatConfig: loaded.rules.delivery?.wechat,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        targetId: args.targetId,
        recipient: result.recipient,
        sentCount: result.sentCount,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
