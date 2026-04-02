# Wechat Digest Architecture

This repository hosts Aaron's custom MCP services. The first production service is `wechat-digest-mcp`.

## Current tracked sources

- 新智元
- 机器之心
- 量子位
- 开源星探

## Runtime split

- `self-mcp`
  Owns deterministic business logic: source discovery, article extraction, deduplication, image extraction, analysis, labels, digest assembly, learning candidates, overlay rules, and delivery bookkeeping.
- `one-company / OpenClaw`
  Owns the conversational layer: the WeChat bot channel, persona, existing memory, optional interactive MCP use, and owner approvals sent from WeChat chat.
- Windows Scheduled Task
  Owns the production triggers at `08:45 Asia/Shanghai` for the morning digest, `18:40 Asia/Shanghai` for the evening digest, and `19:30 Asia/Shanghai` for learning follow-up reminders.

## Production flow

```mermaid
flowchart TD
    A[08:45 Scheduled Task] --> B[run-wechat-digest.ps1]
    B --> C[wechat-digest-mcp runner]
    A2[18:40 Scheduled Task] --> B
    C --> D[Scan configured sources]
    D --> E[Normalize and dedupe]
    E --> F[Fetch article body and images]
    F --> G[Analyze relevance and labels]
    G --> H[Build morning digest]
    H --> I[Call OpenClaw CLI wrapper]
    I --> J[Existing WeChat bot delivery]
    C --> K[(state.sqlite)]
    F --> L[(article/image cache)]
```

## Why MCP here

- The digest pipeline is stateful and deterministic.
- It needs persistent discovery state, retries, deduplication, and delivery records.
- It should stay decoupled from OpenClaw core updates.
- The same MCP can later expose more services without changing the OpenClaw runtime model.

## Why production scheduling stays outside OpenClaw cron

- OpenClaw can call MCP interactively.
- For production, `cron -> agent -> model decides whether to call tools` is less reliable than a direct deterministic runner.
- The current design keeps OpenClaw as the delivery and interaction layer, while `self-mcp` owns the hard business path.
