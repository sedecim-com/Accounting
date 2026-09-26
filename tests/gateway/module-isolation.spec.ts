import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================
// W0 · loading the gateway loads nothing of the engine.
//
// Criterion web-gateway-never-reaches-the-engine walks the import closure in
// the source; this spec asks the runtime. A fresh process (inside this vitest
// run the module cache is shared with every other spec, so the check would
// prove nothing) requires the gateway's server and config modules without
// starting them, with the engine's credentials absent from its environment,
// and reports every module that got loaded.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');

function loadedModules(): string[] {
  const script = [
    "require('./src/gateway/server.ts');",
    "require('./src/gateway/config.ts');",
    'console.log(JSON.stringify(Object.keys(require.cache)));',
  ].join(' ');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const out = execFileSync('npx', ['tsx', '-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const lastLine = out.trim().split('\n').pop() ?? '[]';
  return (JSON.parse(lastLine) as string[]).map((m) => m.split(path.sep).join('/'));
}

describe('the gateway process', () => {
  it('requires no engine module, no engine configuration and no token minting library', () => {
    const modules = loadedModules();
    expect(modules.some((m) => m.endsWith('/src/gateway/server.ts'))).toBe(true);
    expect(modules.some((m) => m.endsWith('/src/gateway/config.ts'))).toBe(true);

    const engine = modules.filter((m) =>
      /\/src\/(config|database|services|ai|cli|api\/rest\/(routes|middleware))\/|\/node_modules\/(jsonwebtoken|pg|dotenv|bullmq|ioredis)\//.test(m)
    );
    expect(engine).toEqual([]);

    const root = `${ROOT.split(path.sep).join('/')}/`;
    const fromSrc = modules
      .map((m) => (m.startsWith(root) ? m.slice(root.length) : m))
      .filter((m) => m.startsWith('src/'));
    expect(fromSrc.length).toBeGreaterThan(10);
    for (const m of fromSrc) {
      expect(
        m.startsWith('src/gateway/') || ['src/auth/oidc.ts', 'src/auth/login-flows.ts', 'src/api/rest/trust-proxy.ts'].includes(m),
        m
      ).toBe(true);
    }
  }, 60_000);
});
