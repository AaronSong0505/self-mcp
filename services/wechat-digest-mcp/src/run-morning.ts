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
  const scan = await service.scan();
  const newIds = scan.articles.filter((article) => article.status === "new").map((article) => article.articleId);
  const analyzed = newIds.length > 0 ? await service.analyze({ articleIds: newIds }) : [];
  const digest = await service.buildDigest({
    date: args.date ?? toDateKey(new Date()),
    targetId: args.targetId,
    dryRun: args.dryRun,
  });

  const result = {
    date: digest.date,
    targetId: digest.targetId,
    dryRun: digest.dryRun,
    scannedSources: scan.sourceCount,
    discoveredArticles: scan.articles.length,
    newArticles: newIds.length,
    analyzedArticles: analyzed.length,
    candidateCount: digest.candidateCount,
    sentCount: digest.sentCount,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `run-morning failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
