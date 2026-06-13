#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(process.env.SIGNAL_FRONTEND_DIST ?? path.join(rootDir, 'dist'));
const host = process.env.SIGNAL_FRONTEND_HOST ?? '0.0.0.0';
const port = Number(process.env.SIGNAL_FRONTEND_PORT ?? 8080);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function safePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  return path.join(distDir, normalized === '/' ? 'index.html' : normalized);
}

async function assetForRequest(urlPathname) {
  const requested = safePath(urlPathname);
  if (!requested.startsWith(distDir)) {
    return path.join(distDir, 'index.html');
  }
  try {
    const stat = await fs.stat(requested);
    return stat.isDirectory() ? path.join(requested, 'index.html') : requested;
  } catch {
    return path.join(distDir, 'index.html');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  const assetPath = await assetForRequest(url.pathname);
  try {
    const body = await fs.readFile(assetPath);
    res.writeHead(200, {
      'Cache-Control': assetPath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Content-Type': contentTypes.get(path.extname(assetPath)) ?? 'application/octet-stream',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(body);
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found\n');
  }
});

server.listen(port, host, () => {
  console.log(`Signal frontend listening on http://${host}:${port}`);
});
