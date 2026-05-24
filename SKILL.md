---
name: vrchat-sales-sync
description: >
  Batch-refresh sale status (特價 / 特價至 / 價格) for every page in the
  "模型資源整理" Notion database by re-fetching each booth.pm item.
  Only sale-related fields are touched; user-managed columns and
  fields owned by vrchat-asset-importer (適用於 / 類型 / 可用於同人製作 /
  Files & media / Full Set) are preserved.
  Trigger when user says:
  "更新特價狀態", "重新同步 booth 價格", "看哪些 asset 還在特價",
  "refresh sales", "sync sale prices", "check which items are still on sale".
---

# vrchat-sales-sync

Companion skill to [vrchat-asset-importer](https://github.com/jayhormes/vrchat-asset-importer).
The importer adds **one** booth item at a time; this skill re-checks **all** items.

## TL;DR for agents

```bash
# Preview — no Notion writes. ~30s for 200 items.
node <SKILL_DIR>/scripts/refresh-sales.mjs --dry-run

# Actually update Notion
node <SKILL_DIR>/scripts/refresh-sales.mjs

# Quick sanity check (only items currently flagged 特價=true)
node <SKILL_DIR>/scripts/refresh-sales.mjs --only-flagged

# Single-page override for ambiguous cases (LLM intervention — see below)
node <SKILL_DIR>/scripts/refresh-sales.mjs --mark-off <booth_url>
node <SKILL_DIR>/scripts/refresh-sales.mjs --mark-on  <booth_url> --until 2026-06-30
```

Output is a summary + per-item diff + an `=== ambiguous ===` block for cases the script can't auto-decide. **Always run `--dry-run` first**, show the user the summary, then proceed.

## What it modifies

| Notion 欄位 | 動作 |
|---|---|
| 特價 | overwritten on every run (booth is source of truth) |
| 特價至 | overwritten (re-parses description date pattern) |
| 價格 | overwritten if booth's current price differs |
| **Name** | overwritten if booth's title differs (sellers add/remove promo prefixes like `😇4周年50%OFF😇` with each sale) |
| **all other fields** | **untouched** (適用於 / 類型 / URL / Files & media / Full Set / 可用於同人製作 / 已購買 / 購買日期 / 購買價格 / 購物車) |

## How it works

1. Query all pages in DB `1e86282d-955a-8052-99e4-d25fd6b6e49e` (paginated)
2. For each page with a booth.pm URL:
   - Fetch `https://<shop>.booth.pm/items/<id>.json`
   - Re-compute `特價 / 特價至 / 價格` via `lib.mjs` (same logic as importer)
   - Compare to current Notion state
3. Print diff summary
4. PATCH only the pages that changed (or just print, with `--dry-run`)

Concurrency 3 with **exponential backoff on HTTP 429** (booth rate-limits easily). Default scan completes in ~30s for 200 items.

## Edge cases

| 狀況 | 行為 |
|---|---|
| **HTTP 404** (item removed from booth) | report in errors, **do not modify** the page (preserves history) |
| **HTTP 429** (rate limited) | auto-retry with backoff (2s → 5s → 11s, up to 4 attempts) |
| **Notion URL not booth.pm** | skip, not counted as error |
| **No URL** | skip, not counted as error |
| **Notion PATCH fails** | log and continue with remaining pages |

## Flags

### Bulk scan (default mode)
```
--dry-run         show diff, no writes
--only-flagged    filter pages to 特價=true (fast partial-scan)
--concurrency N   parallel booth fetches (default 3, raise carefully)
--skip-shop SHOP  exclude a shop subdomain (e.g. --skip-shop qrochairo)
```

### Single-page override (LLM intervention)
```
--mark-off URL                set 特價=false, 特價至=null for the page matching that booth URL
--mark-on  URL [--until DATE] set 特價=true, optionally with 特價至=DATE (YYYY-MM-DD)
                              omit --until for open-ended sale (特價至=null)
```

Override mode short-circuits the bulk scan — only the one page is touched.

## LLM intervention workflow for ambiguous cases

After a bulk dry-run, the `=== ambiguous ===` block lists items where the script detected sale keywords but couldn't parse an end date. Each row shows the URL + a 160-char description excerpt around the matched keyword.

The LLM should:

1. **Read each excerpt** in the dry-run output. Look for non-structured date hints (e.g. "release date 5/14 + 2週間" → sale ends ~5/28).
2. **Optionally `WebFetch` the booth URL** if the excerpt is insufficient (rare).
3. **Compare to today** to decide: still on sale OR stale promo text.
4. **Commit the decision** via the override flags:
   - Sale ended → `--mark-off <url>`
   - Still on, with deducible end date → `--mark-on <url> --until 2026-MM-DD`
   - Still on, open-ended → `--mark-on <url>` (no `--until`)
5. **Process in batches**, the script returns immediately for each call (no scanning).

When in doubt about whether a sale is still active, **default to `--mark-off`** (the conservative call — user can re-import if they were wrong).

## Requirements

- **Node 18+** (built-in `fetch`)
- **Notion integration** Connected to the target DB
- **`$NOTION_API_KEY`** in env, or `~/.openclaw/openclaw.json` `skills.entries.notion.env.NOTION_API_KEY`

No python/pypdf needed — this skill never touches VN3 PDFs.

## Output example

```
querying Notion DB (all)...
got 204 pages, fetching booth (concurrency=3)...

=== summary (30.0s) ===
checked:              204
went on sale:         15
came off sale:        83
price changed:         0
sale-end-date diff:    0
unchanged:           105
errors (no write):     1
...

=== changes ===
  [came-off-sale] 🌊【11アバター対応】 シャーキーサマー
      https://kouklaspizzas.booth.pm/items/8402097
      特價 true→false
  ...

=== errors (page NOT modified) ===
  Summer_chic
    https://hb1975.booth.pm/items/4976229  →  HTTP 404
```

## Sibling skill

For **adding** a new booth item to the database (single URL), use [vrchat-asset-importer](https://github.com/jayhormes/vrchat-asset-importer).

`lib.mjs` is shared between the two skills (duplicated, source of truth lives in `vrchat-asset-importer`). If you edit keyword tables in `lib.mjs` here, mirror the change in the importer repo.

## Known limits

- Only operates on items whose URL is a booth.pm URL
- 價格 is set from `pickPrice` (FULL PACK or max variation); if you want the regular non-sale price specifically, this skill won't compute it
- No incremental optimization based on last-checked timestamp (full scan every run; fast enough at this scale)
