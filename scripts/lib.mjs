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

export const SALE_KEYWORDS = [
  '半額', 'セール', 'SALE', '割引', '特価', '特價',
  '大感謝', 'キャンペーン',
];

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

export function parseSaleEndDate(text) {
  const rangeRe = /(20\d{2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})日?\s*[〜～~\-ー至–—]+\s*(?:(20\d{2})[.\-/年]\s*)?(\d{1,2})[.\-/月]\s*(\d{1,2})日?/;
  const r = rangeRe.exec(text);
  if (r) {
    const [, sy, , , ey, em, ed] = r;
    return `${ey || sy}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
  }
  const untilRe = /(20\d{2})[.\-/年]\s*(\d{1,2})[.\-/月]\s*(\d{1,2})日?\s*(?:まで|until)/i;
  const u = untilRe.exec(text);
  if (u) {
    const [, y, m, d] = u;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

export function parseSaleInfo(data) {
  const text = `${data.name || ''}\n${data.description || ''}`;
  const lowered = text.toLowerCase();
  const onSale =
    /\d+\s*[%％]\s*off/i.test(text) ||
    SALE_KEYWORDS.some(k => lowered.includes(k.toLowerCase()));
  const saleEndDate = onSale ? parseSaleEndDate(text) : null;
  return { onSale, saleEndDate };
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
