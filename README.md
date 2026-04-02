# self-mcp

Private MCP monorepo for Aaron's custom services. The first service is `wechat-digest-mcp`, which:

- discovers new WeChat public-account articles from configured feeds
- extracts article body text and article images
- deduplicates, caches, and persists article state locally
- analyzes relevance, labels, and digest summaries
- generates learning candidates for new companies, technologies, and themes
- supports manual approval into a dynamic rules overlay
- delivers morning digests through the existing OpenClaw WeChat bot

The second service is `bluesky-social-mcp`, which:

- checks whether the Bluesky lane is configured
- previews post length/facets before publishing
- publishes reviewed posts to Bluesky through the official AT Protocol SDK

## Layout

- `services/wechat-digest-mcp`
  MCP stdio server and the direct morning runner
- `services/bluesky-social-mcp`
  MCP stdio server for the public Bluesky social lane
- `packages/core`
  config loading, sqlite state, canonical URLs, delivery helpers, message splitting
- `packages/extractors`
  RSS / HTML list discovery and WeChat article extraction
- `packages/analyzers`
  heuristic + model-backed article analysis
- `config`
  sources and digest rules
- `data`
  local runtime state and caches, not committed
- `scripts`
  deterministic runners and Windows scheduled-task install helpers

## Learning loop

- `wechat_articles.analyze` can emit `ruleCandidates[]`
- candidates are stored in sqlite and surfaced back through digest reminders
- approvals write into `data/rules.overlay.yaml`
- the tracked base rules stay unchanged
- a 19:30 follow-up reminder can nudge pending approvals once per day
- production digest delivery now runs twice daily at 08:45 and 18:40 Asia/Shanghai

## Development

```powershell
pnpm install
pnpm build
pnpm test
pnpm dev:wechat-digest-mcp
pnpm dev:bluesky-social-mcp
```

## Production runner

```powershell
pnpm build
powershell -ExecutionPolicy Bypass -File .\scripts\run-wechat-digest.ps1 -Mode morning
powershell -ExecutionPolicy Bypass -File .\scripts\run-wechat-digest.ps1 -Mode followup -DryRun
```

Install the daily 08:45 morning digest task, the 18:40 evening digest task, and the 19:30 learning follow-up task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-wechat-digest-task.ps1
```

## Config

- `config/wechat_sources.yaml`
  source allowlist
- `config/wechat_digest_rules.yaml`
  interest rules, labels, models, and delivery targets
- `config/bluesky_social.yaml`
  public-lane defaults for Bluesky

Relevant environment variables:

- `WECHAT_DIGEST_ROOT`
- `WECHAT_DIGEST_CONFIG_DIR`
- `WECHAT_DIGEST_DATA_DIR`
- `WECHAT_DIGEST_OPENAI_BASE_URL`
- `DASHSCOPE_API_KEY`
- `OPENCLAW_CLI_WRAPPER`
- `BLUESKY_HANDLE`
- `BLUESKY_APP_PASSWORD`
- `BLUESKY_SERVICE`

If `DASHSCOPE_API_KEY` is missing, the analyzer falls back to heuristic scoring only.

If `BLUESKY_HANDLE` or `BLUESKY_APP_PASSWORD` is missing, the Bluesky lane stays in preview-only/unconfigured mode.

## Current configured sources

- 新智元
- 机器之心
- 量子位
- 开源星探

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the production split between `self-mcp`, OpenClaw, and the Windows scheduled task.

The first configured morning-digest sources are:

- 新智元
- 机器之心
- 量子位
- 开源星探
