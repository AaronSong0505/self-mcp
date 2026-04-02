import { WechatDigestService } from "./service.js";
import { toDateKey } from "../../../packages/core/src/canonical.js";

type CliArgs = {
  date?: string;
  targetId: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  let date: string | undefined;
  let targetId = "aaron-wechat";
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") {
      date = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--target") {
      targetId = argv[index + 1] ?? targetId;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return {
    date,
    targetId,
    dryRun,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const service = await WechatDigestService.create();
  const followup = await service.sendLearningFollowup({
    date: args.date ?? toDateKey(new Date()),
    targetId: args.targetId,
    dryRun: args.dryRun,
  });

  process.stdout.write(
    `${JSON.stringify({
      date: followup.date,
      targetId: followup.targetId,
      dryRun: followup.dryRun,
      candidateCount: followup.candidateCount,
      sentCount: followup.sentCount,
      messageCount: followup.messages.length,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `run-followup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
