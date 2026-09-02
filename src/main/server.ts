import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

// Production renderer serving.
//
// The SPEC suggests a custom app:// scheme, but YouTube's embedded player now
// rejects pages that are not on a real http(s) origin (errors 152/153): the
// embed page is served with the error baked in based on the request Referer,
// and the player JS also inspects location.ancestorOrigins, which cannot be
// spoofed. Tried and failed: app:// + forged Referer (153→152; YouTube
// refuses referer-less requests AND youtube.com itself as the embedder),
// stripping the origin= param (still 152), and intercepting https:// for a
// fake host (net.fetch pass-through drops the browser's computed Referer).
//
// What demonstrably works — identically to the dev server — is a plain
// localhost http origin, so production serves the built renderer from a tiny
// HTTP server bound to 127.0.0.1 on an ephemeral port. Nothing renderer-side
// persists per-origin (all state lives in SQLite via IPC), so the changing
// port is harmless.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "img-src 'self' https://i.ytimg.com data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

/** Serve the built renderer directory; resolves with the http origin. */
export function startRendererServer(rendererName: string): Promise<string> {
  const root = path.join(__dirname, `../renderer/${rendererName}`);

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(
      new URL(req.url ?? '/', 'http://localhost').pathname,
    );
    const target = path.normalize(
      path.join(root, pathname === '/' ? 'index.html' : pathname),
    );
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
        'Content-Security-Policy': CSP,
      });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      // Load via the localhost hostname: YouTube accepts "localhost" as an
      // embedding origin but rejects the literal "127.0.0.1" (error 150).
      resolve(`http://localhost:${port}`);
    });
  });
}
