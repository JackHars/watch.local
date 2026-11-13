// VidCore's public player protocol, used by Reelix. Read its current client
// parameters as data; never evaluate downloaded JavaScript or store tickets.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const changed = () => new Error('Reelix player format changed or is unavailable');
const hash = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const rotate = (value, bits) => ((value << bits) | (value >>> (8 - bits))) & 255;

function mask(seed, step) {
  return Uint8Array.from({ length: 256 }, () => {
    let n = seed = (seed + step) >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x85ebca6b) >>> 0;
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35) >>> 0;
    return (n ^ (n >>> 16)) & 255;
  });
}

export function readReelixProtocol(script) {
  if (typeof script !== 'string' || script.length > 3 * 1024 * 1024) throw changed();
  const parts = [...script.matchAll(/\b[\w$]+\s*=\s*[\w$]+\.from\(\s*"([A-Za-z0-9+/=]{1000,})"\s*,\s*[\w$]+\s*\)/g)].slice(0, 3);
  if (parts.length !== 3) throw changed();
  const encoded = Buffer.concat(parts.map((m, i) => Buffer.from(m[1], i ? 'hex' : 'base64')));
  if (encoded.length < 40000 || encoded.length > 100000) throw changed();
  const a = mask(0x395290c, 0x6c62272e), b = mask(0xa6308ca9, 0x9e3779b9);
  const bytes = encoded.map((v, i) => v ^ a[i % 256] ^ b[i % 256]);
  // Only string literal records are needed. The bytecode itself is not run.
  const literals = [];
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] !== 155 || bytes[i + 1] !== 35) continue;
    const length = bytes.readUInt16BE(i + 2);
    if (!length || length > 500 || i + 4 + length > bytes.length) continue;
    const text = bytes.subarray(i + 4, i + 4 + length);
    if (text.every(v => v >= 32 && v < 127)) literals.push(text.toString());
  }
  const hex = literals.filter(v => /^[a-f0-9]{64}$/.test(v));
  const iv = literals.find(v => /^[a-f0-9]{32}$/.test(v));
  const salt = literals.find(v => /^[a-f0-9]{6}$/.test(v));
  const layers = literals.flatMap((v, i) => /^[A-Za-z0-9+/]{43}=$/.test(v) ? [{ key: v, next: literals[i + 1] }] : []);
  const routes = literals.flatMap((v, i) => /^\/gacvejtu\/t\/[a-f0-9]+\/[a-f0-9]+$/.test(v) ? [{ path: v, operation: literals[i + 2] }] : []);
  const counters = literals.filter(v => /^\d{10}$/.test(v));
  const symbols = script.match(/JSON\.parse\(\s*'(\["[A-Za-z0-9_-]"(?:,"[A-Za-z0-9_-]"){63}\])'\s*\)/)?.[1];
  const stream = script.match(/\.concat\("([A-Za-z0-9_-]{11})",\s*"\/"\)\s*\.concat\([\w$]+\.data\)/)?.[1];
  if (hex.length !== 2 || !iv || !salt || layers.length !== 10 || routes.length !== 2 || counters.length !== 2 || !symbols || !stream) throw changed();
  const permutation = JSON.parse(symbols);
  if (new Set(permutation).size !== 64 || permutation.some(v => !alphabet.includes(v)) || routes.some(r => !/^[A-Za-z0-9_-]{11}$/.test(r.operation))) throw changed();
  const transforms = layers.slice(0, 5).map(({ key, next }) => {
    if (!/^[A-Za-z0-9+/]{7,11}={0,2}$/.test(next)) throw changed();
    return { key: Buffer.from(key, 'base64'), prefix: Buffer.from(next, 'base64') };
  });
  const numbers = counters.map(value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes; });
  return {
    key: Buffer.from(hex[0], 'hex'), iv: Buffer.from(iv, 'hex'), salt: Buffer.from(salt, 'hex'),
    responseKey: hash(Buffer.from(hex[1], 'hex'), ...numbers), permutation,
    transforms, rc4: layers.slice(5).map(({ key }) => Buffer.from(key, 'base64')),
    handshakePath: routes[0].path + '/' + routes[0].operation,
    sourcesPath: routes[1].path + '/' + routes[1].operation,
    streamPath: routes[1].path + '/' + stream,
  };
}

function randomSequence(seed) {
  const digest = hash(seed);
  let state = (digest.readUInt32LE(0) ^ digest.readUInt32LE(4) ^ digest.readUInt32LE(8) ^ digest.readUInt32LE(12)) >>> 0;
  if (!state) state = 0x9e3779b9;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}
function permutation(length, seed) {
  const next = randomSequence(seed), indices = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) { const j = next() % (i + 1); [indices[i], indices[j]] = [indices[j], indices[i]]; }
  return indices;
}

export function reelixHandshake(session, protocol, { nonce = randomBytes(16), now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(session) || nonce.length !== 16) throw changed();
  const { key, iv, salt } = protocol, stamp = Buffer.alloc(8);
  stamp.writeBigUInt64LE(BigInt(now));
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let bytes = Buffer.concat([cipher.update(Buffer.concat([nonce, stamp, Buffer.from(session)])), cipher.final()]);
  let blockKey = hash(salt, nonce);
  for (let i = 0; i < bytes.length; i++) {
    if (i && i % 32 === 0) blockKey = hash(blockKey);
    bytes[i] ^= blockKey[i % 32];
  }
  const rotationKey = hash(key, nonce);
  bytes = bytes.map((v, i) => (rotate(v, rotationKey[i % 32] & 7) + (rotationKey[i % 32] ^ 165)) & 255);
  const substitution = permutation(256, Buffer.concat([nonce, salt, iv]));
  bytes = bytes.map(v => substitution[v]);
  const blocks = permutation(Math.ceil(bytes.length / 16), Buffer.concat([salt, nonce]));
  bytes = Buffer.concat(blocks.map(i => bytes.subarray(i * 16, (i + 1) * 16)));
  const order = permutation(bytes.length, Buffer.concat([key, nonce, Buffer.from([bytes.length & 255])]));
  bytes = Buffer.from(order.map(i => bytes[i]));
  const blockOrder = Buffer.alloc(blocks.length * 4), count = Buffer.alloc(2);
  blocks.forEach((value, i) => blockOrder.writeUInt32LE(value, i * 4)); count.writeUInt16LE(blocks.length);
  const check = hash(blockOrder, bytes).subarray(0, 8);
  return Buffer.concat([Buffer.from([1]), nonce, count, blockOrder, bytes, check]).toString('base64url')
    .split('').map(c => protocol.permutation[alphabet.indexOf(c)]).join('');
}

function rc4(bytes, key) {
  const state = Array.from({ length: 256 }, (_, i) => i); let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0; j = 0;
  return bytes.map(v => { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; return v ^ state[(state[i] + state[j]) & 255]; });
}
const byteOperations = [
  v => v ^ 59, v => (v - 76) & 255, v => (v - 200) & 255, v => (v - 216) & 255,
  v => (v - 218) & 255, v => (v - 226) & 255, v => (v + 230) & 255,
  v => rotate(v, 1), v => rotate(v, 2), v => rotate(v, 6), v => rotate(v, 7),
];
const transformOrder = [0, 4, 1, 2, 3];
const operations = [
  [5, 1, 8, 2, 0, 1, 0, 2, 0, 5],
  [4, 8, 0, 7, 8, 9, 0, 4, 7, 6],
  [8, 2, 9, 2, 7, 7, 5, 9, 7, 10],
  [2, 8, 5, 6, 1, 6, 2, 4, 8, 7],
  [3, 7, 10, 0, 3, 0, 5, 10, 7, 8],
];
export function reelixChallenge(response, protocol) {
  if (typeof response !== 'string' || !response.length || response.length > 8192) throw changed();
  let bytes = Buffer.from(Buffer.from([...response].reverse().join('')).toString('hex'));
  for (let stage = 0; stage < 5; stage++) {
    const index = transformOrder[stage], { key, prefix } = protocol.transforms[index], output = [];
    for (let i = 0; i < bytes.length; i++) {
      if (i < prefix.length) output.push(prefix[i]);
      output.push(byteOperations[operations[index][i % 10]](bytes[i] ^ key[i % 32]));
    }
    bytes = rc4(Buffer.from(output), protocol.rc4[stage]);
  }
  return bytes.toString('base64url');
}

export function decryptReelixResponse(response, protocol) {
  if (typeof response !== 'string' || response.length > 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(response)) throw changed();
  const bytes = Buffer.from(response, 'base64');
  if (bytes.length < 52) throw changed();
  const key = hash(protocol.responseKey, bytes.subarray(0, 16));
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(16, 28));
  cipher.setAuthTag(bytes.subarray(-16));
  try { return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28, -16)), cipher.final()]).subarray(8).toString('utf8')); }
  catch { throw new Error('Reelix returned an invalid playback response'); }
}
