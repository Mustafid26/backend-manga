'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://qcoeeqbhlogskynczdeb.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_duIoj9oWAzqWSmLqkzCJhQ_PJUiA1H5';
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

const localFile = path.join(__dirname, 'tokens.json');

async function getActiveToken() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('tokens')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (!error && data) return data;
    } catch (e) {
      console.error('[Supabase] Failed to fetch token:', e.message);
    }
  }

  // Fallback local file
  try {
    if (fs.existsSync(localFile)) {
      const content = fs.readFileSync(localFile, 'utf8');
      return JSON.parse(content);
    }
  } catch {}

  return { cookie: '', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
}

async function saveToken(cookie, userAgent) {
  const payload = {
    cookie,
    user_agent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    created_at: new Date().toISOString()
  };

  if (supabase) {
    try {
      await supabase.from('tokens').insert([payload]);
    } catch (e) {
      console.error('[Supabase] Failed to save token:', e.message);
    }
  }

  // Always save local fallback
  try {
    fs.writeFileSync(localFile, JSON.stringify(payload, null, 2));
  } catch {}

  return payload;
}

module.exports = {
  getActiveToken,
  saveToken
};
