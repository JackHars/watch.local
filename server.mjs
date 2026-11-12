import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './api/platform.mjs';
import { handleWeb, recordActivity } from './api/web.mjs';
import { requireSession, sameOrigin, requestOrigin } from './api/sessions.mjs';
import { initializeIPTV, handleIPTV } from './api/iptv.mjs';
import { handleChannelArtwork } from './api/channel-artwork.mjs';

const routes = new Set(['api', 'health', 'providers', 'servers', 'search', 'browse', 'title', 'episodes', 'images', 'resolve', 'master', 'watch', 'proxy']);

export function requestLabel(target) {
  const url = new URL(target, 'http://local');
  const path = url.pathname
    .replace(/^\/(movie|series|live)\/[^/]+\/[^/]+\//, '/$1/[login]/')
    .replace(/^\/iptv\/(media|subtitles)\/[^/]+\//, '/iptv/$1/[signed]/');
  const action = url.searchParams.get('action');
  return action && path === '/player_api.php'
    ? `${path}?action=${action.replace(/[^a-z0-9_]/gi, '').slice(0, 40)}` : path;
}

function json(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createServer({ onRequest, mode = 'combined', network } = {}) {
  return http.createServer(async (req, res) => {
    req.watchlocalNetwork = network;
    {
      const started = Date.now();
      let target = '[invalid path]';
      try { target = requestLabel(req.url); } catch { /* avoid logging untrusted request text */ }
      let recorded = false;
      const record = status => {
        if (recorded) return;
        recorded = true;
        try { const event = { method: req.method, target, status, client: req.socket.remoteAddress, durationMs: Date.now() - started }; recordActivity(event); onRequest?.(event); }
        catch { /* logging must not interrupt a request */ }
      };
      res.once('finish', () => record(res.statusCode));
      res.once('close', () => { if (!res.writableFinished) record('closed'); });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const request = new URL(req.url, 'http://local');
      const listener = typeof mode === 'function' ? mode() : mode;
      if (await handleChannelArtwork(req, res)) return;
      if (listener === 'iptv' && request.pathname === '/' && ['GET','HEAD'].includes(req.method)) {
        const target = new URL(requestOrigin(req)); target.port = String(network.webPort);
        res.writeHead(307, { Location: target.origin + '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (listener !== 'iptv' && await handleWeb(req, res)) return;
      // Browser playback keeps its signed manifests, segments and subtitles on
      // the web origin. Xtream, playlists and credentialed streams stay on IPTV.
      if ((listener !== 'web' || /^\/iptv\/(media|subtitles)\//.test(request.pathname)) && await handleIPTV(req, res)) return;
      if (routes.has(request.pathname.slice(1)) && (listener !== 'web' || request.pathname === '/health')) {
        if (!['/health', '/api', '/providers'].includes(request.pathname)) {
          await initializeIPTV();
          requireSession(req, true);
          if (req.method !== 'GET') sameOrigin(req);
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' });
          return res.end();
        }
        return await handleApiRequest(req, res);
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.message });
      else res.destroy();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  import('./start.mjs').catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
