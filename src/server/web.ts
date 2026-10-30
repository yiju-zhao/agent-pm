import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Hono } from 'hono';

// Serves the built web UI (`npm run build:web` writes it to dist/web): the page at `/` and its hashed assets under
// `/assets/`. In-page routing uses the hash, so no other path needs the page.

export const WEB_NOT_BUILT = '网页界面还没构建：在仓库里运行 npm run build:web';

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

/**
 * `GET /` answers with `webDir/index.html` (never cached, so a rebuild shows up on reload), or 503 with a build hint when
 * `webDir` is null or holds no page yet. `GET /assets/*` answers with files under `webDir/assets` (cached for good: the
 * build puts a hash in every name); a path that resolves outside that directory is 404.
 */
export function mountWeb(app: Hono, webDir: string | null): void {
  app.get('/', async (c) => {
    const page = webDir === null ? null : await readFileOrNull(join(webDir, 'index.html'));
    if (page === null) return c.text(WEB_NOT_BUILT, 503);
    return c.body(page, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });

  app.get('/assets/*', async (c) => {
    if (webDir === null) return c.notFound();
    const assetsDir = resolve(webDir, 'assets');
    // Decode the raw path ourselves: `%2e%2e` and `%2f` must be checked after decoding, not trusted to the router.
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname.slice('/assets/'.length));
    } catch {
      return c.notFound();
    }
    const file = resolve(assetsDir, rel);
    if (!file.startsWith(assetsDir + sep)) return c.notFound();
    const data = await readFileOrNull(file);
    if (data === null) return c.notFound();
    return c.body(data, 200, {
      'Content-Type': ASSET_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
}

/** The file's bytes, or null when it is missing or not a regular file. */
async function readFileOrNull(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
    throw err;
  }
}
