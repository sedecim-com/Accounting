import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RequestHandler } from 'express';

// ============================================================
// STATIC FILES, AS A CLOSED TABLE
//
// The gateway serves exactly the files listed here, preloaded into memory at
// startup, for GET and HEAD. There is no directory serving and no fallback,
// so path traversal has nothing to traverse and a source map, a .ts file or a
// dotfile that lands in the public folder by accident is never served.
//
// If a listed file is missing the gateway refuses to start and says which
// build step produces it: a broken copy is a deploy failure, not a blank page.
//
// Criterion web-gateway-own-routes-are-plumbing parses this table: a published
// path may be '/' or end in .html, .js, .css or .woff2, and none may sit under
// /v1, /auth or /healthz, where it would shadow the proxy or the session routes.
// ============================================================

export type StaticAsset = readonly [publishedPath: string, file: string, contentType: string];

export const STATIC_ASSETS: readonly StaticAsset[] = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
];

/** `<repo>/dist/gateway/public`, from src/gateway under tsx and from dist/gateway once built. */
export const DEFAULT_STATIC_ROOT = path.resolve(__dirname, '..', '..', 'dist', 'gateway', 'public');

export interface LoadedAsset {
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

export class MissingStaticAssets extends Error {
  constructor(readonly missing: string[], root: string) {
    super(
      `the gateway cannot start: ${missing.length} static file(s) missing under ${root} (${missing.join(', ')}). Run npm run build:web.`
    );
    this.name = 'MissingStaticAssets';
  }
}

export function loadStaticAssets(root: string, assets: readonly StaticAsset[] = STATIC_ASSETS): Map<string, LoadedAsset> {
  const missing = assets.map(([, file]) => file).filter((file) => !fs.existsSync(path.join(root, file)));
  if (missing.length > 0) throw new MissingStaticAssets(missing, root);
  const loaded = new Map<string, LoadedAsset>();
  for (const [publishedPath, file, contentType] of assets) {
    loaded.set(publishedPath, {
      body: fs.readFileSync(path.join(root, file)),
      contentType,
      // The shell is never cached, so a deploy is picked up on the next load;
      // the rest revalidates.
      cacheControl: publishedPath === '/' ? 'no-store' : 'no-cache',
    });
  }
  return loaded;
}

export function createStaticAssets(loaded: Map<string, LoadedAsset>): RequestHandler {
  return function staticAssets(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const asset = loaded.get(req.path);
    if (!asset) return next();
    res.status(200);
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Cache-Control', asset.cacheControl);
    res.setHeader('Content-Length', String(asset.body.length));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(asset.body);
  };
}
