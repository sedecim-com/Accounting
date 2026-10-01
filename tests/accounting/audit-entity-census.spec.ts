import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MNE-001-287 (#103): every `registrarAuditoria(...)` call names the legal
 * entity of the fact (an id, or an explicit `null` for tenant-level facts).
 * The type already makes the field required; this census also catches calls
 * that bypass the type (casts, spreads) and raw `INSERT INTO audit_log`.
 */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** The text of the argument list that opens at `open` (the index of "("). */
function callBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i);
  }
  return src.slice(open);
}

describe('audit_log legal entity census', () => {
  const files = sources('src');

  it('every registrarAuditoria call states legalEntityId', () => {
    const missing: string[] = [];
    let calls = 0;
    for (const f of files) {
      if (f.endsWith('audit-log.ts')) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/registrarAuditoria\(/g)) {
        calls++;
        if (!/\blegalEntityId\b/.test(callBody(src, (m.index ?? 0) + m[0].length - 1))) {
          const line = src.slice(0, m.index).split('\n').length;
          missing.push(`${f}:${line}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it('every raw INSERT INTO audit_log names legal_entity_id, except the HTTP middleware row', () => {
    const missing = files.filter((f) => {
      if (f.endsWith(join('middleware', 'audit.ts'))) return false; // request-level: no entity yet
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(/INSERT INTO audit_log\s*\(([^)]*)\)/g)].some(
        (m) => !m[1].includes('legal_entity_id')
      );
    });
    expect(missing).toEqual([]);
  });
});
