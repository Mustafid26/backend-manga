/**
 * scraper.js — HTTP client for comix.to with DNS override & request signing.
 *
 * Every outbound request is:
 *   1. Routed to a hard-coded Cloudflare IP (bypasses local DNS blocks).
 *   2. Signed with the `_` query parameter via crypto.getSignature().
 *   3. Decrypted on response when the `x-enc: 1` header is present.
 */

'use strict';

const dns   = require('dns');
const axios = require('axios');
const { getSignature, decryptResponse } = require('./crypto');

// ─── DNS override ───────────────────────────────────────────────────────────
// comix.to is blocked by some ISP-level DNS filters (e.g. Internet Positif).
// We resolve it directly to its Cloudflare edge IP.

const COMIX_IP = '104.21.49.220';
const origLookup = dns.lookup;

if (!process.env.VERCEL) {
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (hostname === 'comix.to' || hostname.endsWith('.comix.to')) {
      if (options && options.all) return callback(null, [{ address: COMIX_IP, family: 4 }]);
      return callback(null, COMIX_IP, 4);
    }
    return origLookup(hostname, options, callback);
  };
}

// ─── Axios instance ─────────────────────────────────────────────────────────

const BASE = 'https://comix.to';

const api = axios.create({
  baseURL: `${BASE}/api/v1`,
  headers: {
    Referer: `${BASE}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  },
  timeout: 15_000,
});

// Request interceptor — append signing `_` param
api.interceptors.request.use((cfg) => {
  if ((cfg.method ?? 'get').toLowerCase() !== 'get') return cfg;
  const params  = cfg.params ?? {};
  // Build the path comix.to expects to sign
  const url     = cfg.url ?? '';
  const qs      = Object.keys(params).filter(k => k !== '_').sort();
  const qsStr   = qs.map(k => `${k}=${params[k]}`).join('&');
  const fullPath = qsStr ? `${url}?${qsStr}` : url;
  const sig = getSignature(fullPath);
  cfg.params = { ...params, _: sig };
  return cfg;
});

// Response interceptor — decrypt when x-enc: 1 and unwrap result
api.interceptors.response.use((res) => {
  let body = res.data;
  
  // Decrypt if encrypted
  if (res.headers?.['x-enc'] === '1' && body && typeof body === 'object' && typeof body.e === 'string') {
    try {
      body = JSON.parse(decryptResponse(body.e));
    } catch { /* leave body as-is if decryption fails */ }
  }

  // Consistent unwrapping of "result"
  if (body && typeof body === 'object' && body.status === 'ok' && 'result' in body) {
    res.data = body.result;
  } else {
    res.data = body;
  }
  
  return res;
});

// ─── public helpers ─────────────────────────────────────────────────────────

/**
 * Fetch trending / browse manga list.
 * @param {number} page
 * @returns {Promise<object>}
 */
async function fetchBrowse(page = 1) {
  const { data } = await api.get('/manga', { params: { 'order[score]': 'desc', page } });
  return data;
}

/**
 * Search manga by keyword.
 * @param {string} query
 * @param {number} page
 */
async function searchManga(query, page = 1) {
  const { data } = await api.get('/manga', { params: { keyword: query, page } });
  return data;
}

/**
 * Fetch manga details (synopsis, chapters, etc.).
 * @param {string} slug — e.g. "nr83-the-sword-bearing-flower"
 */
async function fetchMangaDetail(slug) {
  const { data } = await api.get(`/manga/${slug}`);
  return data;
}

/**
 * Fetch the page list for a chapter.
 * @param {number|string} chapterId
 */
async function fetchChapterPages(chapterId) {
  const { data } = await api.get(`/chapters/${chapterId}`);
  return data;
}

/**
 * Fetch chapters for a manga
 * @param {string} slug
 */
async function fetchMangaChapters(slug) {
  let allItems = [];
  let page = 1;
  let hasNext = true;

  while (hasNext && page <= 10) { // Limit to 1000 chapters for safety
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
}

/**
 * Stream a manga page image back to the caller.
 * Returns the Axios response (stream) so the caller can pipe headers + body.
 * @param {string} imageUrl — full URL from the pages list
 */
async function streamImage(imageUrl) {
  return axios.get(imageUrl, {
    responseType: 'stream',
    headers: {
      Referer: `${BASE}/`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    timeout: 30_000,
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
