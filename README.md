# vrchat-sales-sync

> Companion to [vrchat-asset-importer](https://github.com/jayhormes/vrchat-asset-importer). Batch-refresh `特價` / `特價至` / `價格` across the whole **模型資源整理** Notion DB by re-fetching each booth.pm item.

Solves the "sale ended but my Notion still shows 特價=true" problem. Run it weekly (or on-demand) and Notion reflects what booth actually says today.

## Install

### openclaw

```bash
git clone https://github.com/jayhormes/vrchat-sales-sync.git \
  ~/.openclaw/skills/vrchat-sales-sync
# Token auto-read from ~/.openclaw/openclaw.json
```

### hermes

```bash
git clone https://github.com/jayhormes/vrchat-sales-sync.git \
  ~/.hermes/skills/openclaw-imports/vrchat-sales-sync
export NOTION_API_KEY=ntn_...
```

### Anywhere (Claude Code / generic agent)

```bash
git clone https://github.com/jayhormes/vrchat-sales-sync.git
export NOTION_API_KEY=ntn_...
node ./vrchat-sales-sync/scripts/refresh-sales.mjs --dry-run
```

## Usage

```bash
# Preview — no Notion writes (~30s for 200 items)
node <SKILL_DIR>/scripts/refresh-sales.mjs --dry-run

# Actually update Notion
node <SKILL_DIR>/scripts/refresh-sales.mjs

# Fast partial scan — only items currently flagged 特價=true
node <SKILL_DIR>/scripts/refresh-sales.mjs --only-flagged

# Tweak parallelism (default 3; raise carefully — booth 429s easily)
node <SKILL_DIR>/scripts/refresh-sales.mjs --concurrency 5

# Skip a shop entirely (repeatable)
node <SKILL_DIR>/scripts/refresh-sales.mjs --skip-shop qrochairo
```

## What it touches

| Notion 欄位 | Behavior |
|---|---|
| 特價 | overwrite from booth |
| 特價至 | overwrite from booth (parses `2026.05.20〜06.20まで` etc.) |
| 價格 | overwrite if booth's current price differs |
| everything else | **never modified** |

User-managed fields (`已購買 / 購買日期 / 購買價格 / 購物車`) and importer-managed fields (`適用於 / 類型 / Name / Files & media / Full Set / 可用於同人製作`) are **left alone**.

## Edge cases

- **HTTP 404** (item removed from booth) → reported in errors, page NOT modified
- **HTTP 429** → exponential backoff (2s, 5s, 11s, up to 4 tries)
- **Notion write fail** → logged, other pages continue

## Requirements

- **Node 18+** (built-in `fetch`)
- **Notion integration** Connected to the target DB
- **`NOTION_API_KEY`** in env or openclaw.json

No python/pypdf needed.

## How it relates to vrchat-asset-importer

`scripts/lib.mjs` is **duplicated** from the importer repo (source of truth: [vrchat-asset-importer/scripts/lib.mjs](https://github.com/jayhormes/vrchat-asset-importer/tree/main/scripts/lib.mjs)). When keyword tables change there, mirror them here.

The two skills can be installed independently — no shared state at runtime.

## License

Personal tool. Fork freely.
