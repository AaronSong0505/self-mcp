import { toDateKey } from "../../../packages/core/src/canonical.js";
import { WechatLoveNoteService } from "./service.js";

type CliArgs = {
  date?: string;
  dryRun: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  let date: string | undefined;
  let dryRun = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") {
      date = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
    }
  }

  return {
    date,
    dryRun,
    force,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const service = await WechatLoveNoteService.create();
  const result = await service.run({
    date: args.date ?? toDateKey(new Date()),
    dryRun: args.dryRun,
    force: args.force,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `run-love-note failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
