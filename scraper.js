/**
 * scraper.js — HTTP client for comix.to with Playwright Session Manager & Request Signing.
 *
 * Architecture:
 *   Axios (with signature & decryption) -> uses Cookies & UA from Playwright Session Manager
 *   Playwright Session Manager -> solves Cloudflare Turnstile in non-headless mode, updates cookies dynamically
 */

'use strict';

const dns = require('dns');
const axios = require('axios');
const { chromium } = require('playwright-chromium');
const { getSignature, decryptResponse } = require('./crypto');

// ─── Browser Session Manager (Playwright) ────────────────────────────────────

const BASE = 'https://comix.to';
let cookiesHeader = '';
let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let sessionPromise = null;

async function initSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    console.log('[SessionManager] Launching browser to solve Cloudflare Turnstile...');
    try {
      // Cloudflare Turnstile blocks headless chromium. 
      // Running headless: false reliably bypasses the challenge.
      const browser = await chromium.launch({ 
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--window-size=800,600']
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      
      // Basic stealth
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      userAgent = await page.evaluate(() => navigator.userAgent);
      
      // Navigate and wait for challenge to clear (comix.to homepage)
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(6000); // Allow Turnstile to verify

      const cookies = await context.cookies();
      cookiesHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      
      await browser.close();
      
      if (cookiesHeader.includes('cf_clearance')) {
        console.log('[SessionManager] Successfully obtained Cloudflare clearance!');
      } else {
        console.warn('[SessionManager] Warning: cf_clearance cookie not found, request may fail.');
      }
    } catch (err) {
      console.warn('[SessionManager] Playwright challenge solve failed:', err.message);
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

// ─── Axios instance ─────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: `${BASE}/api/v1`,
  headers: {
    Referer: `${BASE}/`,
    Accept: 'application/json, text/plain, */*',
  },
  timeout: 15_000,
});

// Request interceptor — attach session & append signing `_` param
api.interceptors.request.use(async (cfg) => {
  if (cookiesHeader) cfg.headers['Cookie'] = cookiesHeader;
  cfg.headers['User-Agent'] = userAgent;

  if ((cfg.method ?? 'get').toLowerCase() !== 'get') return cfg;
  const params = cfg.params ?? {};
  const url = cfg.url ?? '';
  const qs = Object.keys(params).filter(k => k !== '_').sort();
  const qsStr = qs.map(k => `${k}=${params[k]}`).join('&');
  const fullPath = qsStr ? `${url}?${qsStr}` : url;
  cfg.params = { ...params, _: getSignature(fullPath) };
  return cfg;
});

// Response interceptor — decrypt when x-enc: 1 and unwrap result
api.interceptors.response.use((res) => {
  let body = res.data;
  if (res.headers?.['x-enc'] === '1' && body && typeof body === 'object' && typeof body.e === 'string') {
    try {
      body = JSON.parse(decryptResponse(body.e));
    } catch { /* leave body as-is */ }
  }
  if (body && typeof body === 'object' && body.status === 'ok' && 'result' in body) {
    res.data = body.result;
  } else {
    res.data = body;
  }
  return res;
});

/** Wrapper to retry request after initializing session if 403 occurs */
async function requestWithSession(fn) {
  try {
    return await fn();
  } catch (err) {
    // If 403 Forbidden, session is likely expired or missing
    if (err.response?.status === 403) {
      console.log('[scraper] 403 Forbidden received. Refreshing Cloudflare session...');
      await initSession();
      return await fn(); // Retry once
    }
    throw err;
  }
}

// ─── public helpers ─────────────────────────────────────────────────────────

async function fetchBrowse(page = 1) {
  return requestWithSession(async () => {
    const { data } = await api.get('/manga', { params: { 'order[score]': 'desc', page } });
    return data;
  });
}

async function searchManga(query, page = 1) {
  return requestWithSession(async () => {
    const { data } = await api.get('/manga', { params: { keyword: query, page } });
    return data;
  });
}

async function fetchMangaDetail(slug) {
  return requestWithSession(async () => {
    const { data } = await api.get(`/manga/${slug}`);
    return data;
  });
}

async function fetchChapterPages(chapterId) {
  return requestWithSession(async () => {
    const { data } = await api.get(`/chapters/${chapterId}`);
    return data;
  });
}

async function fetchMangaChapters(slug) {
  return requestWithSession(async () => {
    let allItems = [];
    let page = 1;
    let hasNext = true;
    while (hasNext && page <= 10) {
      const { data } = await api.get(`/manga/${slug}/chapters`, { params: { limit: 100, page } });
      if (data && data.items) {
        allItems = allItems.concat(data.items);
        hasNext = data.meta?.hasNext || false;
        page++;
      } else {
        hasNext = false;
      }
    }
    return { items: allItems };
  });
}

async function streamImage(imageUrl) {
  return requestWithSession(async () => {
    return axios.get(imageUrl, {
      responseType: 'stream',
      headers: {
        Referer: `${BASE}/`,
        'User-Agent': userAgent,
        ...(cookiesHeader ? { Cookie: cookiesHeader } : {})
      },
      timeout: 30_000,
    });
  });
}

module.exports = {
  fetchBrowse,
  searchManga,
  fetchMangaDetail,
  fetchMangaChapters,
  fetchChapterPages,
  streamImage,
};

if (require.main === module) {
  const assert = require('assert');
  fetchBrowse(1).then(data => {
    assert(data, 'fetchBrowse must return data');
    console.log('[self-check] scraper browse OK with Playwright Session Manager!');
  }).catch(err => {
    console.error('[self-check] FAILED:', err.message);
    process.exit(1);
  });
}
