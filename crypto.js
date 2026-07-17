/**
 * crypto.js — Request signing & API response decryption for comix.to
 *
 * comix.to signs every GET request with a `_` query parameter derived from
 * the URL path.  API responses come back with header `x-enc: 1` and a JSON
 * body `{ "e": "<base64url-encoded ciphertext>" }`.  This module ports both
 * the signing (encrypt) and the response decryption algorithms from the
 * site's `secure-ti76j3-*.js` bundle.
 *
 * Both directions use the same three S-box / autokey layers, just applied
 * forward (signing) or in reverse (decryption).
 */

'use strict';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Decode a standard base-64 string into a Uint8Array. */
function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a byte-like array to URL-safe base-64 (no padding). */
function b64UrlEncode(bytes) {
  let b = btoa(String.fromCharCode.apply(null, bytes));
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a URL-safe base-64 string (with optional missing padding). */
function b64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = 4 - (s.length % 4);
  if (pad < 4) s += '='.repeat(pad);
  return atob(s);
}

// ─── S-box tables & keys (extracted from secure-*.js) ───────────────────────

const SBOX_1  = b64Decode('gbicCvAMzfcXEtGAyjvvhmb2yCWzWhjqcxXZ7ZhpzANOzoQLo3nuPZ2vK9dkb9hJExC0Vni/hdQBceI+mw611gkhQFjBuf4bJg1TxYqM+SL4YDqtwjxiGSdeH7so7Fn1HiRo37Z+RNvl44twXWVhomtMjw+8bemfmv9XEXr7mS82MxaCOJZRR0oHd9PLI5O+gyBGT6hcLoduNa7yCObVVCk3bFWsoD+xcqTrBcP6dNJN/NB1Br2QGhSN2snHAqeRNKVFQiyeAFLPSKGwY8aq9EPgsi17qd4ywPMxiH8w6N1qX1tLKtzhOeemHWeJQfFQ5H23q7qSlJUcjgTEl3x2/Q==');
const KEY_1   = b64Decode('rafYl4oSAKQX+GYoic9oW4iGwiYpZzs0');
const SEED_1  = 189;

const SBOX_2  = b64Decode('2lQehmgyYFAoWUi0haazZqHy5zZ34NN+VzlfsoB2Y1yY0IuMLjgVcV2xt8t4moH+AP0NMJ5qekW7DFIHEWKkOgIBIMhDdA8lbM6iHKjDlq6IChpb3CnA9NmsvQW/afdt1SfJjTdwcvpKqunCJLxBFmXX9hecm6tGb+HRxD7BC3njoxPxgnX5pdKP1IMSkd4/O3NRfZSE6DVLG2s9uexaipA05cpJzE8Qkv/z5jzHAwlEWOLd3yxA+0cvVbpOoJPFGc8f1lb4vu2HUxjuuEwEQk0GsPCVnyKvfOoh9TG2YYmZLV4I67UU2NsrrakqZ47k/O+ne25/DjPGZCMdnZcmzQ==');
const KEY_2   = b64Decode('2USAq+VTo5ht4bQn+K9DUcpUQRTtrB56');
const SEED_2  = 133;

const SBOX_3  = b64Decode('+mhJSFwzaV+PQPDyKp2scO/S9SdFsy/7e56UWT8XHbK3E2+19nEPwfwOgE9uVCaDtOAWTobCZX+cBCXlIbBqyDyQB1beKLspW6kGPhBCV9x0jf0KUeFhHjmlMf7qMFIB41PfDFprZ3bJiK4YxrZDv+K6dcwJmggVO8f5ktrXTM0cZL4fer0SpnkbvNajPbHxfuTz5lVEBarOI4rdc+2V6zTsjpfQYjgN1MMr6EvA6eehN6dQ1bgUogt9rZOBbQBeNnLYY00uZqSoJBnFi5gthCJsWF33ykosn9v/9KB8udMCz0YRYImrA4VHr5mMgpH4xDXLeEHRd5vZOiAalofuMg==');
const KEY_3   = b64Decode('yNHlokVEnuecesDrB/lDhVuUNiheWc3a47VtkwZ2ENg=');
const SEED_3  = 32;

// ─── forward autokey (used during signing) ──────────────────────────────────

function autokeyForward(sbox, key, seed, input) {
  const kLen = key.length;
  const len  = input.length;
  const out  = new Uint8Array(len);
  let prev   = seed;
  for (let i = 0; i < len; i++) {
    const v = sbox[255 & (input[i] ^ key[i % kLen] ^ prev)];
    out[i] = v;
    prev = v;
  }
  return out;
}

// ─── inverse autokey (used during decryption) ───────────────────────────────

function buildInverse(sbox) {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[sbox[i]] = i;
  return inv;
}

const INV_SBOX_1 = buildInverse(SBOX_1);
const INV_SBOX_2 = buildInverse(SBOX_2);
const INV_SBOX_3 = buildInverse(SBOX_3);

function autokeyReverse(invSbox, key, seed, input) {
  const kLen = key.length;
  const len  = input.length;
  const out  = new Uint8Array(len);
  let prev   = seed;
  for (let i = 0; i < len; i++) {
    const ct = input[i];
    out[i] = 255 & (invSbox[ct] ^ key[i % kLen] ^ prev);
    prev = ct;
  }
  return out;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Sign a URL path.
 * @param {string} path  — e.g. "/chapters/2282804"
 * @returns {string}       URL-safe base-64 signature (no padding)
 */
function getSignature(path) {
  let bytes = new TextEncoder().encode(path);
  bytes = autokeyForward(SBOX_1, KEY_1, SEED_1, bytes);
  bytes = autokeyForward(SBOX_2, KEY_2, SEED_2, bytes);
  bytes = autokeyForward(SBOX_3, KEY_3, SEED_3, bytes);
  return b64UrlEncode(bytes);
}

/**
 * Decrypt an encrypted API response body.
 * @param {string} ciphertext — the `e` field from `{ "e": "..." }`
 * @returns {string}            decrypted JSON string
 */
function decryptResponse(ciphertext) {
  const decoded = b64UrlDecode(ciphertext);
  let bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);

  bytes = autokeyReverse(INV_SBOX_3, KEY_3, SEED_3, bytes);
  bytes = autokeyReverse(INV_SBOX_2, KEY_2, SEED_2, bytes);
  bytes = autokeyReverse(INV_SBOX_1, KEY_1, SEED_1, bytes);

  return new TextDecoder().decode(bytes);
}

module.exports = { getSignature, decryptResponse };
