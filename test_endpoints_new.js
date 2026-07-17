const axios = require('axios');
const { getSignature, decryptResponse } = require('./crypto');

const BASE = 'https://comix.to';

const api = axios.create({
  baseURL: `${BASE}/api/v1`,
  headers: {
    Referer: `${BASE}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  },
  timeout: 5000,
});

api.interceptors.request.use((cfg) => {
  const url = cfg.url ?? '';
  const qs = Object.keys(cfg.params || {}).filter(k => k !== '_').sort();
  const qsStr = qs.map(k => `${k}=${cfg.params[k]}`).join('&');
  const fullPath = qsStr ? `${url}?${qsStr}` : url;
  cfg.params = { ...(cfg.params || {}), _: getSignature(fullPath) };
  return cfg;
});

api.interceptors.response.use((res) => {
  if (res.headers?.['x-enc'] === '1') {
    const body = res.data;
    if (body && typeof body === 'object' && typeof body.e === 'string') {
      try {
        res.data = JSON.parse(decryptResponse(body.e));
      } catch {}
    }
  }
  return res;
});

const endpoints = [
  '/home', '/browse', '/search', '/updates', '/mangas', '/comics', 
  '/latest', '/trending', '/discover', '/popular', '/manga/search'
];

async function testAll() {
  for (const ep of endpoints) {
    try {
      console.log(`Testing ${ep}...`);
      const res = await api.get(ep, { params: { page: 1, q: 'naruto' } });
      console.log(`SUCCESS [${ep}]:`, JSON.stringify(res.data).substring(0, 100));
    } catch (e) {
      console.log(`FAILED [${ep}]:`, e.response ? e.response.status : e.message);
    }
  }
}

testAll();
