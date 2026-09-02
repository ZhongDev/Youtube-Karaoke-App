import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_SCHEME = 'app';
export const APP_HOST = 'renderer';

// The YouTube IFrame API misbehaves on file:// pages, so production is served
// from a privileged custom scheme instead (SPEC.md §3). Must run before app ready.
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "img-src 'self' https://i.ytimg.com data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
].join('; ');

/** Serve the built renderer directory at app://renderer/… (production only). */
export function serveRenderer(rendererName: string): void {
  const root = path.join(__dirname, `../renderer/${rendererName}`);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const target = path.normalize(
      path.join(root, pathname === '/' ? 'index.html' : pathname),
    );
    if (!target.startsWith(root + path.sep) && target !== root) {
      return new Response('forbidden', { status: 403 });
    }

    const fileResponse = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Security-Policy', PROD_CSP);
    return new Response(fileResponse.body, {
      status: fileResponse.status,
      headers,
    });
  });
}
