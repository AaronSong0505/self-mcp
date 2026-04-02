# self-mcp

Private MCP monorepo for Aaron's custom services. The first service is `wechat-digest-mcp`, which:

- discovers new WeChat public-account articles from configured feeds
- extracts article body text and article images
- deduplicates, caches, and persists article state locally
- analyzes relevance, labels, and digest summaries
- delivers morning digests through the existing OpenClaw WeChat bot

## Layout

- `services/wechat-digest-mcp`
  MCP stdio server and the direct morning runner
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

## Development

```powershell
pnpm install
pnpm build
pnpm test
pnpm dev:wechat-digest-mcp
```

## Production runner

```powershell
pnpm build
powershell -ExecutionPolicy Bypass -File .\scripts\run-wechat-digest.ps1
```

Install the daily 08:45 Windows scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-wechat-digest-task.ps1
```

## Config

- `config/wechat_sources.yaml`
  source allowlist
- `config/wechat_digest_rules.yaml`
  interest rules, labels, models, and delivery targets

Relevant environment variables:

- `WECHAT_DIGEST_ROOT`
- `WECHAT_DIGEST_CONFIG_DIR`
- `WECHAT_DIGEST_DATA_DIR`
- `WECHAT_DIGEST_OPENAI_BASE_URL`
- `DASHSCOPE_API_KEY`
- `OPENCLAW_CLI_WRAPPER`

If `DASHSCOPE_API_KEY` is missing, the analyzer falls back to heuristic scoring only.
