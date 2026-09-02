import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.integration.config.ts';
import { readFileSync } from 'node:fs';

const orden = readFileSync(
  '/private/tmp/claude-501/-Users-victor-projects-Accounting/0b0768fc-533a-43b6-8b8c-48c0127de0df/scratchpad/orden-ci.txt',
  'utf-8'
).trim().split('\n');

class OrdenCi {
  sort(files: any[]) {
    const pos = (f: any) => {
      const p = typeof f === 'string' ? f : f.moduleId ?? f.filepath ?? '';
      const i = orden.findIndex((o) => p.endsWith(o));
      return i === -1 ? 999 : i;
    };
    return [...files].sort((a, b) => pos(a) - pos(b));
  }
  shard(files: any[]) { return files; }
}

export default mergeConfig(base as any, defineConfig({
  test: { sequence: { sequencer: OrdenCi as any } },
}));
