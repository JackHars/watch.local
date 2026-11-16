// Cinema (BZ) (https://cinema.army) bundle-derived key material. Both keys are
// published by the site's own client bundle (assets/index-*.js): it ships both
// 64-hex literals in plaintext to every browser, so these are published key
// material, not credentials (self-coded class — cf. bb-crypto.mjs).
// Extracted 2026-11-16 (evidence artifact 07552f4c27ae); re-verified live on
// 2026-11-24 (bundle index-Kgag5SQH.js). If the API starts answering 401 on
// every server, the site has rotated them: re-extract the two 64-hex literals
// from the live bundle (one feeds streamToken, the other decodeStreamUrl) and
// update the constants below — the focused fix the vod reference expects.
//
// streamToken(id): the X-Stream-Token gate value — hex HMAC-SHA256 of
// "<tmdbId>:<floor(unixSeconds/60)>" (minute bucket, so it rotates every
// minute); the API rejects a missing or foreign token with HTTP 401.
// decodeStreamUrl(value): the site's jxe() decode — http(s) values pass
// through untouched; otherwise the value is base64 whose bytes are XORed with
// STREAM_XOR_KEY.charCodeAt(i % 64), and the result is the real playlist URL.
import crypto from 'node:crypto';

export const STREAM_TOKEN_KEY = 'a2cfc9eaa2a3690b' +
  '5d4f6b5f958dbdea' +
  'e52a097283d375bd' +
  '253ee7c7062524f5';
export const STREAM_XOR_KEY = 'f16a6b92fcd6eed3' +
  'e9476297f893f250' +
  '5c32f79bc6efef9b' +
  '6c95496aa5914548';

export function streamToken(id, key = STREAM_TOKEN_KEY, minute = Math.floor(Date.now() / 1000 / 60)) {
  return crypto.createHmac('sha256', key).update(`${id}:${minute}`).digest('hex');
}

export function decodeStreamUrl(value) {
  value = String(value);
  if (/^https?:\/\//i.test(value)) return value;
  const raw = Buffer.from(value, 'base64');
  let out = '';
  for (let index = 0; index < raw.length; index++) out += String.fromCharCode(raw[index] ^ STREAM_XOR_KEY.charCodeAt(index % STREAM_XOR_KEY.length));
  return out;
}
