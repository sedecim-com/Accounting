import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STATIC_ASSETS } from '../../../src/gateway/static-assets.js';

// ============================================================
// A temporary public root laid out like dist/gateway/public: one file per
// STATIC_ASSETS entry, so the gateway's startup preload finds everything it
// lists without a build.
// ============================================================

export interface StaticRoot {
  dir: string;
  remove(): void;
}

export function createStaticRoot(contents: Record<string, string> = {}): StaticRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-gateway-public-'));
  for (const [, file] of STATIC_ASSETS) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents[file] ?? `<!-- ${file} -->\n`);
  }
  return {
    dir,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
