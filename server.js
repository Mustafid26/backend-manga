/**
 * server.js — Express API server for the manga reader.
 *
 * Endpoints:
 *   GET /api/manga              — browse trending manga
 *   GET /api/manga/search       — search manga by keyword
 *   GET /api/manga/:slug        — manga details + chapter list
 *   GET /api/chapter/:id/pages  — decrypted page list for a chapter
 *   GET /api/image-proxy        — stream a manga page image (+ relay headers)
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const scraper = require('./scraper');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── middleware ─────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// ─── API routes ─────────────────────────────────────────────────────────────

/** Browse / trending */
app.get('/api/manga', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const data = await scraper.fetchBrowse(page);
    res.json(data);
  } catch (err) {
    console.error('[/api/manga]', err.message);
    res.status(502).json({ 
      error: 'Failed to fetch manga list', 
      message: err.message, 
      code: err.code,
      response: err.response ? { status: err.response.status, data: err.response.data } : null
    });
  }
});

/** Search */
app.get('/api/manga/search', async (req, res) => {
  try {
    const q    = req.query.q || '';
    const page = parseInt(req.query.page, 10) || 1;
    const data = await scraper.searchManga(q, page);
    res.json(data);
  } catch (err) {
    console.error('[/api/manga/search]', err.message);
    res.status(502).json({ error: 'Search failed' });
  }
});

/** Manga detail */
app.get('/api/manga/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    // Extract hid if slug is like "hid-title"
    const hid = slug.includes('-') ? slug.split('-')[0] : slug;
    
    const data = await scraper.fetchMangaDetail(hid);
    res.json(data);
  } catch (err) {
    console.error('[/api/manga/:slug]', err.message);
    res.status(502).json({ error: 'Failed to fetch manga detail' });
  }
});

/** Manga chapters */
app.get('/api/manga/:slug/chapters', async (req, res) => {
  try {
    const slug = req.params.slug;
    const hid = slug.includes('-') ? slug.split('-')[0] : slug;
    
    const data = await scraper.fetchMangaChapters(hid);
    res.json(data);
  } catch (err) {
    console.error('[/api/manga/:slug/chapters]', err.message);
    res.status(502).json({ error: 'Failed to fetch manga chapters' });
  }
});

/** Chapter pages */
app.get('/api/chapter/:id/pages', async (req, res) => {
  try {
    const data = await scraper.fetchChapterPages(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('[/api/chapter/:id/pages]', err.message);
    res.status(502).json({ error: 'Failed to fetch chapter pages' });
  }
});

/** Image proxy — streams the image while relaying scramble/enc headers */
app.get('/api/image-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const upstream = await scraper.streamImage(url);

    // Relay useful headers to the client for descrambling
    const relay = [
      'content-type',
      'content-length',
      'x-scramble-seed',
      'x-scramble-hash',
      'x-scramble-grid',
      'x-scramble-algo',
      'x-enc-seed',
      'x-enc-algo',
      'x-enc-len',
    ];
    for (const h of relay) {
      const val = upstream.headers[h];
      if (val !== undefined) res.setHeader(h, val);
    }

    // Allow the frontend to read these custom headers
    res.setHeader(
      'Access-Control-Expose-Headers',
      relay.join(', ')
    );

    upstream.data.pipe(res);
  } catch (err) {
    console.error('[/api/image-proxy]', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Image proxy failed' });
  }
});

// ─── serve frontend in production ───────────────────────────────────────────

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

// ─── start ──────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀  Manga reader backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
