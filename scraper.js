/**
 * scraper.js — HTTP client for comix.to with Persistent Playwright Session & Auto-Refresh.
 */

'use strict';

const axios = require('axios');
const { chromium } = require('playwright-chromium');
const { getSignature, decryptResponse } = require('./crypto');
const db = require('./db');

const BASE = 'https://comix.to';
let cookiesHeader = '';
let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
let isRefreshing = null;

// Initialize session from DB or Browser
async function refreshSession() {
  if (isRefreshing) return isRefreshing;
  isRefreshing = (async () => {
    console.log('[Session] Refreshing Cloudflare Turnstile token via browser...');
    try {
      const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(6000);

      const cookies = await context.cookies();
      cookiesHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      userAgent = await page.evaluate(() => navigator.userAgent);

      await browser.close();
      await db.saveToken(cookiesHeader, userAgent);
      console.log('[Session] Token refreshed and saved successfully!');
    } catch (err) {
      console.warn('[Session] Automatic refresh failed:', err.message);
    } finally {
      isRefreshing = null;
    }
  })();
  return isRefreshing;
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

api.interceptors.request.use(async (cfg) => {
  if (!cookiesHeader) {
    const token = await db.getActiveToken();
    if (token && token.cookie) {
      cookiesHeader = token.cookie;
      if (token.user_agent) userAgent = token.user_agent;
    } else {
      await refreshSession();
    }
  }

  cfg.headers['Cookie'] = cookiesHeader;
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

async function requestWithRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.response?.status === 403) {
      console.log('[scraper] 403 detected! Refreshing session...');
      await refreshSession();
      return await fn();
    }
    throw err;
  }
}

// ─── public helpers ─────────────────────────────────────────────────────────

async function fetchBrowse(page = 1) {
  return requestWithRetry(() => api.get('/manga', { params: { 'order[score]': 'desc', page } }).then(r => r.data));
}

async function searchManga(query, page = 1) {
  return requestWithRetry(() => api.get('/manga', { params: { keyword: query, page } }).then(r => r.data));
}

async function fetchMangaDetail(slug) {
  return requestWithRetry(() => api.get(`/manga/${slug}`).then(r => r.data));
}

async function fetchChapterPages(chapterId) {
  return requestWithRetry(() => api.get(`/chapters/${chapterId}`).then(r => r.data));
}

async function fetchMangaChapters(slug) {
  return requestWithRetry(async () => {
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
  return requestWithRetry(() =>
    axios.get(imageUrl, {
      responseType: 'stream',
      headers: {
        Referer: `${BASE}/`,
        'User-Agent': userAgent,
        ...(cookiesHeader ? { Cookie: cookiesHeader } : {})
      },
      timeout: 30_000,
    })
  );
}

module.exports = {
  setSession: (cookie, ua) => { cookiesHeader = cookie; if (ua) userAgent = ua; },
  fetchBrowse,
  searchManga,
  fetchMangaDetail,
  fetchMangaChapters,
  fetchChapterPages,
  streamImage,
};
