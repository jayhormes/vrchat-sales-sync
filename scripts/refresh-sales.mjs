#!/usr/bin/env node
//
// vrchat-sales-sync — refresh 特價 / 特價至 / 價格 for every page in the
// "模型資源整理" Notion DB by re-fetching the booth.pm item JSON.
//
// Only touches sale-related fields. Never modifies 適用於, 類型, Name,
// Files & media, 可用於同人製作, Full Set, or the user's manual fields
// (已購買 / 購買日期 / 購買價格 / 購物車).
//
// 404 on booth → reported as error, **page is NOT modified**.

import {
  NOTION_DB_ID,
  isBoothUrl,
  toJsonUrl,
  fetchJson,
  pickPrice,
  parseSaleInfo,
  readToken,
  Notion,
} from './lib.mjs';

function parseArgs(argv) {
  const args = { dryRun: false, onlyFlagged: false, concurrency: 3, skipShops: [] };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--only-flagged') args.onlyFlagged = true;
    else if (a === '--concurrency') args.concurrency = parseInt(rest[++i], 10) || 5;
    else if (a === '--skip-shop') args.skipShops.push(rest[++i]);
    else if (a === '-h' || a === '--help') args.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function usage() {
  console.log(`usage: refresh-sales.mjs [--dry-run] [--only-flagged] [--concurrency N] [--skip-shop SHOP]...

  --dry-run         print diff summary, don't write Notion
  --only-flagged    only check pages where 特價=true (fast: ~10s for ~100 items)
  --concurrency N   parallel booth fetches (default 3; raise carefully — booth 429s easily)
  --skip-shop SHOP  shop subdomain to skip (repeatable, e.g. --skip-shop qrochairo)

env:
  NOTION_API_KEY  Notion integration token (fallback: ~/.openclaw/openclaw.json)
`);
}

function die(msg, code = 1) { console.error(`ERROR: ${msg}`); process.exit(code); }

// Simple promise pool — N workers pull indices off a shared counter.
async function pool(items, concurrency, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function extractCurrent(page) {
  const p = page.properties;
  return {
    name:        p['Name']?.title?.[0]?.plain_text || '(no name)',
    url:         p['URL']?.url || null,
    onSale:      p['特價']?.checkbox ?? false,
    saleEndDate: p['特價至']?.date?.start ?? null,
    price:       p['價格']?.number ?? null,
  };
}

async function fetchWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      lastErr = e;
      if (e.status === 429 && i < attempts - 1) {
        // Exponential backoff with jitter: ~2s, 5s, 11s
        const wait = (2 ** i) * 2000 + Math.random() * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function checkOne(page, opts) {
  const cur = extractCurrent(page);
  if (!cur.url)              return { page, cur, status: 'skipped-no-url' };
  if (!isBoothUrl(cur.url))  return { page, cur, status: 'skipped-non-booth' };

  const shop = new URL(cur.url).hostname.replace('.booth.pm', '');
  if (opts.skipShops.includes(shop)) return { page, cur, status: 'skipped-shop' };

  let data;
  try {
    data = await fetchWithRetry(toJsonUrl(cur.url));
  } catch (e) {
    return {
      page, cur,
      status: 'error',
      error: e.status ? `HTTP ${e.status}` : e.message.split('\n')[0].slice(0, 100),
    };
  }

  const { onSale, saleEndDate } = parseSaleInfo(data);
  const { price } = pickPrice(data);
  const next = { onSale, saleEndDate, price };

  const diffs = {};
  if (cur.onSale !== next.onSale)             diffs.onSale = [cur.onSale, next.onSale];
  if (cur.saleEndDate !== next.saleEndDate)   diffs.saleEndDate = [cur.saleEndDate, next.saleEndDate];
  if (typeof next.price === 'number' && cur.price !== next.price) {
    diffs.price = [cur.price, next.price];
  }

  return {
    page, cur, next,
    diffs,
    status: Object.keys(diffs).length ? 'changed' : 'unchanged',
  };
}

function classifyChange(diffs) {
  if (diffs.onSale && diffs.onSale[0] === false && diffs.onSale[1] === true)  return 'went-on-sale';
  if (diffs.onSale && diffs.onSale[0] === true  && diffs.onSale[1] === false) return 'came-off-sale';
  if (diffs.price)        return 'price-changed';
  if (diffs.saleEndDate)  return 'sale-end-date-changed';
  return 'changed';
}

function fmtDiff(d) {
  const parts = [];
  if (d.onSale)      parts.push(`特價 ${d.onSale[0]}→${d.onSale[1]}`);
  if (d.saleEndDate) parts.push(`特價至 ${d.saleEndDate[0] ?? 'null'}→${d.saleEndDate[1] ?? 'null'}`);
  if (d.price)       parts.push(`價格 ${d.price[0] ?? 'null'}→${d.price[1]}`);
  return parts.join('  ');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }

  const token = readToken();
  if (!token) die('NOTION_API_KEY not set (env or openclaw.json)', 2);
  const notion = new Notion(token);

  const queryBody = args.onlyFlagged
    ? { filter: { property: '特價', checkbox: { equals: true } } }
    : {};

  console.log(`querying Notion DB (${args.onlyFlagged ? 'only-flagged' : 'all'})...`);
  const pages = [];
  for await (const p of notion.iterateDatabase(NOTION_DB_ID, queryBody)) {
    pages.push(p);
  }
  console.log(`got ${pages.length} pages, fetching booth (concurrency=${args.concurrency})...`);

  const t0 = Date.now();
  const results = await pool(pages, args.concurrency, p => checkOne(p, args));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const tally = {
    'went-on-sale': 0, 'came-off-sale': 0,
    'price-changed': 0, 'sale-end-date-changed': 0,
    unchanged: 0,
    'skipped-no-url': 0, 'skipped-non-booth': 0, 'skipped-shop': 0,
    error: 0,
  };
  const changes = [];
  const errors  = [];
  for (const r of results) {
    if (r.status === 'changed') {
      const kind = classifyChange(r.diffs);
      tally[kind]++;
      changes.push({ ...r, kind });
    } else if (r.status === 'error') {
      tally.error++;
      errors.push(r);
    } else {
      tally[r.status]++;
    }
  }

  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`checked:              ${results.length}`);
  console.log(`went on sale:         ${tally['went-on-sale']}`);
  console.log(`came off sale:        ${tally['came-off-sale']}`);
  console.log(`price changed:        ${tally['price-changed']}`);
  console.log(`sale-end-date diff:   ${tally['sale-end-date-changed']}`);
  console.log(`unchanged:            ${tally.unchanged}`);
  console.log(`errors (no write):    ${tally.error}`);
  console.log(`skipped (no URL):     ${tally['skipped-no-url']}`);
  console.log(`skipped (non-booth):  ${tally['skipped-non-booth']}`);
  console.log(`skipped (--skip-shop):${tally['skipped-shop']}`);

  if (changes.length) {
    console.log(`\n=== changes ===`);
    // Sort: came-off-sale first (highest signal), then went-on-sale, then price, then date.
    const order = { 'came-off-sale': 0, 'went-on-sale': 1, 'price-changed': 2, 'sale-end-date-changed': 3, changed: 4 };
    changes.sort((a, b) => order[a.kind] - order[b.kind]);
    for (const c of changes.slice(0, 50)) {
      console.log(`  [${c.kind}] ${c.cur.name.slice(0, 60)}`);
      console.log(`      ${c.cur.url}`);
      console.log(`      ${fmtDiff(c.diffs)}`);
    }
    if (changes.length > 50) console.log(`  ...and ${changes.length - 50} more`);
  }

  if (errors.length) {
    console.log(`\n=== errors (page NOT modified) ===`);
    for (const e of errors.slice(0, 20)) {
      console.log(`  ${e.cur.name.slice(0, 50)}`);
      console.log(`    ${e.cur.url}  →  ${e.error}`);
    }
    if (errors.length > 20) console.log(`  ...and ${errors.length - 20} more`);
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] no Notion writes performed`);
    return;
  }
  if (changes.length === 0) {
    console.log(`\nnothing to update.`);
    return;
  }

  console.log(`\nupdating Notion (${changes.length} pages)...`);
  let written = 0, writeErrors = 0;
  for (const c of changes) {
    const props = {
      '特價':   { checkbox: c.next.onSale },
      '特價至': { date: c.next.saleEndDate ? { start: c.next.saleEndDate } : null },
    };
    if (typeof c.next.price === 'number') props['價格'] = { number: c.next.price };
    try {
      await notion.updatePage(c.page.id, props);
      written++;
    } catch (e) {
      writeErrors++;
      console.error(`  ✗ ${c.cur.url}  ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`✓ updated ${written}/${changes.length}` + (writeErrors ? `, ${writeErrors} write errors` : ''));
}

main().catch(e => { console.error(e?.stack || e); process.exit(1); });
