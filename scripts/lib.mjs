// NOTE: this file is duplicated from vrchat-asset-importer/scripts/lib.mjs.
// Source of truth: https://github.com/jayhormes/vrchat-asset-importer
// When updating, edit both repos and keep them byte-identical.
//
// Shared utilities for vrchat-asset-importer & vrchat-sales-sync.
//
// Booth fetch + sale-related parsing + Notion client. Importer-only logic
// (avatar matching, type detection, doujin/VN3) stays in import.mjs.
//
// LLM may add strings to KEYWORD TABLES below; do not modify the logic.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const NOTION_VERSION = '2022-06-28';
export const NOTION_DB_ID = '1e86282d-955a-8052-99e4-d25fd6b6e49e';

// ─── KEYWORD TABLES (shared) ──────────────────────────────────────

export const FULL_PACK_KEYWORDS = [
  'FULL PACK', 'FULLPACK', 'FULL_PACK',
  'フルパック', 'フルセット', 'フル パック',
  'Full Set', 'FullSet',
];

// Substring sale keywords. NOT including bare 'SALE' — the English word "sale"
// appears in legal text like "Prohibition of unauthorized sale" / "for sale" and
// causes false positives. SALE-in-promo-context is handled by SALE_STRUCTURAL_RE
// in parseSaleInfo (bracketed forms, suffix variants, ON SALE, etc.).
export const SALE_KEYWORDS = [
  '半額', 'セール', '割引', '特価', '特價',
  '大感謝', 'キャンペーン',
];

// Structural promo patterns. Match BEFORE keyword substring check so the regex
// can express "SALE in promo context" without firing on legal text like
// "Prohibition of unauthorized sale" / "for sale".
//
// Patterns:
//   \d+%OFF                                ← always promo
//   [...SALE...] / 【...SALE...】          ← bracketed (allows emoji decorators inside)
//   SALE! / SALE！ / SALE中                ← suffix
//   ON SALE / BIG SALE / FLASH SALE / OPEN SALE / RELEASE SALE
export const SALE_STRUCTURAL_RE = /\d+\s*[%％]\s*off|\[[^\]]{0,20}SALE[^\]]{0,20}\]|【[^】]{0,20}SALE[^】]{0,20}】|\bSALE\s*[!！中]|\b(?:ON|BIG|FLASH|OPEN|RELEASE)\s+SALE\b/i;

// ─── URL helpers ──────────────────────────────────────────────────

export function isBoothUrl(s) {
  try {
    const u = new URL(s);
    return /(^|\.)booth\.pm$/.test(u.hostname) && /\/items\/\d+/.test(u.pathname);
  } catch { return false; }
}

export function toJsonUrl(s) {
  const u = new URL(s);
  u.search = ''; u.hash = '';
  let p = u.pathname.replace(/\/+$/, '');
  if (!p.endsWith('.json')) p += '.json';
  u.pathname = p;
  return u.toString();
}

// ─── HTTP ─────────────────────────────────────────────────────────

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': 'Mozilla/5.0 vrchat-asset-skills',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`HTTP ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': 'Mozilla/5.0 vrchat-asset-skills',
      'Accept': 'text/html,application/xhtml+xml',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

// ─── booth field extractors (sale-related, shared) ────────────────

export function pickPrice(data) {
  const vars = Array.isArray(data.variations) ? data.variations : [];
  if (vars.length === 0) {
    const m = String(data.price ?? '').match(/(\d[\d,]*)/);
    return { price: m ? parseInt(m[1].replace(/,/g, ''), 10) : null, isFullPack: false };
  }
  const fullPack = vars.find(v => {
    const n = (v.name || '').toUpperCase();
    return FULL_PACK_KEYWORDS.some(k => n.includes(k.toUpperCase()));
  });
  if (fullPack && typeof fullPack.price === 'number') {
    return { price: fullPack.price, isFullPack: true };
  }
  const prices = vars.map(v => v.price).filter(p => typeof p === 'number');
  return { price: prices.length ? Math.max(...prices) : null, isFullPack: false };
}

export function parseSaleEndDate(text, now = new Date()) {
  const pad = n => String(n).padStart(2, '0');

  // ── full-year patterns (highest precision, try first) ──

  // YYYY.MM.DD〜(YYYY.)MM.DD  (end year optional → inherit start year)
  // Separators include common Unicode "dash" decorators sellers use:
  //   〜 ～ ~ - ー 至 – — → ─ ━ ═
  const rangeRe = /(20\d{2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})日?\s*[〜～~\-ー至–—→─━═]+\s*(?:(20\d{2})[.\-/年]\s*)?(\d{1,2})[.\-/月]\s*(\d{1,2})日?/;
  const r = rangeRe.exec(text);
  if (r) {
    const [, sy, , , ey, em, ed] = r;
    return `${ey || sy}-${pad(em)}-${pad(ed)}`;
  }

  // YYYY.MM.DD まで | until
  // Allow up to 20 non-月 chars between 日 and まで|until to catch
  // "2025年9月30日24時まで" / "9月11日 23：59まで" etc.
  // (excluding 月 prevents the gap from crossing into another date)
  const untilRe = /(20\d{2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})日?[^月]{0,20}?(?:まで|until)/i;
  const u = untilRe.exec(text);
  if (u) return `${u[1]}-${pad(u[2])}-${pad(u[3])}`;

  // Until YYYY.MM.DD  (English "Until" prefix)
  const untilPrefixRe = /Until\s+(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/i;
  const up = untilPrefixRe.exec(text);
  if (up) return `${up[1]}-${pad(up[2])}-${pad(up[3])}`;

  // YYYY.M.D から N日間  (Japanese: start date + duration in days; inclusive)
  // Example: "2024.2.27日から3日間" → end = 2024-02-29
  const fromDurationRe = /(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})日?\s*から\s*(\d+)\s*日間/;
  const fd = fromDurationRe.exec(text);
  if (fd) {
    const start = new Date(+fd[1], +fd[2] - 1, +fd[3]);
    start.setDate(start.getDate() + (+fd[4]) - 1);
    return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  }

  // ── short patterns, year inferred from `now` ──
  // Sellers often write "5/24" or "5月24日" without year — assume current.
  // If we guess wrong and the date is past, the expired-cutoff in
  // parseSaleInfo flips onSale=false (conservative).
  const year = now.getFullYear();

  // M月D日 まで  (Japanese, year inferred from current)
  // Same gap-allowance as untilRe — 日 and まで can be separated by time/parens.
  const jpUntilRe = /(\d{1,2})月(\d{1,2})日[^月]{0,20}?まで/;
  const ju = jpUntilRe.exec(text);
  if (ju) return `${year}-${pad(+ju[1])}-${pad(+ju[2])}`;

  // M月D日 〜 M月D日  (Japanese date range)
  const jpRangeRe = /(\d{1,2})月(\d{1,2})日?\s*[〜～~\-ー至–—→─━═]+\s*(\d{1,2})月(\d{1,2})日?/;
  const jr = jpRangeRe.exec(text);
  if (jr) return `${year}-${pad(+jr[3])}-${pad(+jr[4])}`;

  // M/D 〜 M/D  (short range with explicit separator, including → arrow)
  const shortRangeRe = /(?<![\d/])(\d{1,2})\/(\d{1,2})\s*[〜～~\-ー至–—→─━═]+\s*(\d{1,2})\/(\d{1,2})(?![\d/])/;
  const sr = shortRangeRe.exec(text);
  if (sr) return `${year}-${pad(+sr[3])}-${pad(+sr[4])}`;

  // M/D ... まで  (短 M/D 後接 まで，中間最多 20 個非數字字元，避免吃到無關內容)
  const shortUntilRe = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:[^\d\n]{0,20})?まで/;
  const su = shortUntilRe.exec(text);
  if (su) return `${year}-${pad(+su[1])}-${pad(+su[2])}`;

  return null;
}

// Find "<old> → <new>" promo price pairs in description text.
// Requires a currency marker (円 / ¥ / JPY / 엔) after the OLD number to avoid
// false positives on version numbers / IDs / etc. Returns pairs where old > new.
export function parsePriceArrows(text) {
  const re = /(\d{1,3}(?:[,，]\d{3})*|\d{4,6})\s*(?:円|¥|JPY|엔)\s*(?:[→➡➜⇒]|->|=>)\s*(\d{1,3}(?:[,，]\d{3})*|\d{4,6})\s*(?:円|¥|JPY|엔)?/g;
  const pairs = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const oldP = parseInt(m[1].replace(/[,，]/g, ''), 10);
    const newP = parseInt(m[2].replace(/[,，]/g, ''), 10);
    if (oldP > newP && oldP > 0 && newP > 0) {
      pairs.push({ old: oldP, new: newP });
    }
  }
  return pairs;
}

export function parseSaleInfo(data, now = new Date()) {
  const text = `${data.name || ''}\n${data.description || ''}`;
  const lowered = text.toLowerCase();
  let onSale =
    SALE_STRUCTURAL_RE.test(text) ||
    SALE_KEYWORDS.some(k => lowered.includes(k.toLowerCase()));
  let saleEndDate = onSale ? parseSaleEndDate(text) : null;
  let expired = false;

  // (1) End-date cutoff: if the parsed end date is in the past, override.
  if (saleEndDate) {
    const end = new Date(saleEndDate + 'T23:59:59');
    if (!Number.isNaN(end.getTime()) && end < now) {
      onSale = false;
      saleEndDate = null;
      expired = true;
    }
  }

  // (2) Price-revert cross-check: if description has "<old>→<new>" promo pricing
  // AND the current booth variation price matches an "old" (regular) figure but
  // does NOT match any "new" (discount) figure, the sale has ended and the price
  // reverted. This catches the case where the seller left the promo text but
  // the actual price is back to normal — booth prices are authoritative.
  if (onSale) {
    const pairs = parsePriceArrows(text);
    if (pairs.length > 0) {
      const { price } = pickPrice(data);
      if (typeof price === 'number') {
        const matchesNew = pairs.some(p => p.new === price);
        const matchesOld = pairs.some(p => p.old === price);
        if (matchesOld && !matchesNew) {
          onSale = false;
          saleEndDate = null;
          expired = true;
        }
      }
    }
  }

  return { onSale, saleEndDate, expired };
}

// ─── Notion token + client ────────────────────────────────────────

export function readToken() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY;
  try {
    const p = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return cfg?.skills?.entries?.notion?.env?.NOTION_API_KEY || null;
  } catch { return null; }
}

export class Notion {
  constructor(token) { this.token = token; }

  async req(p, opts = {}) {
    return fetchJson(`https://api.notion.com/v1${p}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  }

  async queryDatabase(dbId, body = {}) {
    return this.req(`/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async findByUrl(dbId, url) {
    const r = await this.queryDatabase(dbId, {
      filter: { property: 'URL', url: { equals: url } },
      page_size: 1,
    });
    return r.results?.[0] || null;
  }

  async createPage(dbId, properties) {
    return this.req('/pages', {
      method: 'POST',
      body: JSON.stringify({ parent: { database_id: dbId }, properties }),
    });
  }

  async updatePage(pageId, properties) {
    return this.req(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
  }

  // Async generator over all pages in a DB (handles cursor pagination).
  async *iterateDatabase(dbId, body = {}) {
    let cursor;
    while (true) {
      const r = await this.queryDatabase(dbId, { ...body, start_cursor: cursor, page_size: 100 });
      for (const page of r.results) yield page;
      if (!r.has_more) break;
      cursor = r.next_cursor;
    }
  }
}
