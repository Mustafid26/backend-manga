/**
 * scraper.js — Persistent Playwright Browser for comix.to scraping (VPS / RDP Mode).
 *
 * Architecture:
 *   1 Playwright browser stays alive in background.
 *   All API calls run inside browser via page.evaluate(fetch(...)).
 *   Cloudflare sees real Chrome TLS + cookies -> 0% chance of 403.
 */

'use strict';

const dns = require('dns');
const { chromium } = require('playwright-chromium');
const { getSignature, decryptResponse } = require('./crypto');

// DNS Override for ISP filters (e.g. Internet Positif)
const origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (hostname === 'comix.to' || hostname.endsWith('.comix.to')) {
    if (options && options.all) return callback(null, [{ address: '172.67.152.235', family: 4 }]);
    return callback(null, '172.67.152.235', 4);
  }
  return origLookup(hostname, options, callback);
};

const BASE = 'https://comix.to';
let browser = null;
let page = null;
let browserReady = null;

async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  page = null;
  if (browserReady) return browserReady;
  browserReady = (async () => {
    const isHeadless = process.env.RENDER || process.env.NODE_ENV === 'production' || process.platform === 'linux';
    console.log(`[scraper] Launching Playwright browser (headless: ${isHeadless})...`);
    browser = await chromium.launch({
      headless: isHeadless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(6000);
    console.log('[scraper] Browser ready.');
    browserReady = null;
  })();
  return browserReady;
}

async function browserFetch(apiPath, params = {}) {
  await ensureBrowser();

  const qs = Object.keys(params).filter(k => k !== '_').sort();
  const qsStr = qs.map(k => `${k}=${params[k]}`).join('&');
  const sigPath = qsStr ? `${apiPath}?${qsStr}` : apiPath;
  const sig = getSignature(sigPath);
  const allParams = { ...params, _: sig };
  const paramStr = new URLSearchParams(allParams).toString();
  const targetUrl = `${BASE}/api/v1${apiPath}?${paramStr}`;

  const result = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } });
    return { status: r.status, enc: r.headers.get('x-enc'), text: await r.text() };
  }, targetUrl);

  if (result.status === 403) {
    console.log('[scraper] 403 detected. Re-solving Turnstile...');
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(6000);
    const retry = await page.evaluate(async (url) => {
      const r = await fetch(url, { headers: { 'Accept': 'application/json, text/plain, */*' } });
      return { status: r.status, enc: r.headers.get('x-enc'), text: await r.text() };
    }, targetUrl);
    if (retry.status !== 200) throw new Error(`comix.to returned ${retry.status}`);
    return parseBody(retry);
  }

  if (result.status !== 200) throw new Error(`comix.to returned ${result.status}`);
  return parseBody(result);
}

function parseBody(result) {
  let body = JSON.parse(result.text);
  if (result.enc === '1' && body && typeof body.e === 'string') {
    try { body = JSON.parse(decryptResponse(body.e)); } catch {}
  }
  if (body && body.status === 'ok' && 'result' in body) return body.result;
  return body;
}

// ─── public helpers ─────────────────────────────────────────────────────────

async function fetchBrowse(p = 1) {
  return browserFetch('/manga', { 'order[score]': 'desc', page: p });
}

async function searchManga(query, p = 1) {
  return browserFetch('/manga', { keyword: query, page: p });
}

async function fetchMangaDetail(slug) {
  return browserFetch(`/manga/${slug}`);
}

async function fetchChapterPages(chapterId) {
  return browserFetch(`/chapters/${chapterId}`);
}

async function fetchMangaChapters(slug) {
  let allItems = [];
  let p = 1;
  let hasNext = true;
  while (hasNext && p <= 10) {
    const data = await browserFetch(`/manga/${slug}/chapters`, { limit: 100, page: p });
    if (data && data.items) {
      allItems = allItems.concat(data.items);
      hasNext = data.meta?.hasNext || false;
      p++;
    } else {
      hasNext = false;
    }
  }
  return { items: allItems };
}

async function streamImage(imageUrl) {
  await ensureBrowser();

  const response = await page.context().request.get(imageUrl, {
    headers: {
      'Referer': `${BASE}/`
    },
    timeout: 30000
  });

  if (!response.ok()) {
    throw new Error(`streamImage failed with status ${response.status()}`);
  }

  // Convert Playwright APIResponse to Node.js Readable stream wrapper
  const buffer = await response.body();
  const headers = response.headers();
  const { Readable } = require('stream');

  return {
    headers: headers,
    data: Readable.from(buffer)
  };
}

module.exports = {
  fetchBrowse,
  searchManga,
  fetchMangaDetail,
  fetchMangaChapters,
  fetchChapterPages,
  streamImage,
};
