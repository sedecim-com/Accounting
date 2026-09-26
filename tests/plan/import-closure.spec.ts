import { describe, expect, it } from 'vitest';
import {
  GATEWAY_APP_CLOSURE,
  GATEWAY_SERVER_CLOSURE,
  importClosure,
  importClosureViolations,
  isNodeBuiltin,
} from '../../src/plan/criterios.js';

// ============================================================
// W0 · the import-closure walk behind web-gateway-never-reaches-the-engine,
// on in-memory trees.
//
// The criterion's disk mutants cover edits to files that exist. They cannot
// cover the laundering that needs a NEW file (a mutant replaces or deletes,
// it never creates, and `fuentes()` lists the disk), so those cases live here,
// against the same pure function and the same rules the criterion uses.
// ============================================================

function tree(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  return { get: (rel: string) => map.get(rel) };
}

const clean = {
  'src/gateway/server.ts': "import express from 'express';\nimport { a } from './a.js';\nimport { readFileSync } from 'node:fs';\nimport http from 'http';",
  'src/gateway/a.ts': "import { discover } from '../auth/oidc.js';\nimport { createPkcePair } from '../auth/login-flows.js';\nexport const a = 1;",
  'src/auth/oidc.ts': "import { jwtVerify } from 'jose';",
  'src/auth/login-flows.ts': "import crypto from 'node:crypto';\nimport type { StoredToken } from './token-store.js';",
  'src/auth/token-store.ts': "import fs from 'node:fs';\nimport { execFile } from 'node:child_process';",
  'src/database/connection.ts': "import pg from 'pg';",
  'src/services/portfolio/portfolio-service.ts': "import { query } from '../../database/connection.js';",
  'src/ai/tools.ts': 'export const tools = [];',
};

function violations(extra: Record<string, string>, roots: string[] = ['src/gateway/server.ts']): string[] {
  return importClosureViolations(tree({ ...clean, ...extra }), roots, GATEWAY_SERVER_CLOSURE);
}

describe('importClosureViolations', () => {
  it('accepts the clean tree: borrowed auth modules, the type-only token-store import, express, jose and builtins', () => {
    expect(violations({})).toEqual([]);
  });

  it('rejects a NEW gateway file that imports the database pool', () => {
    const found = violations(
      {
        'src/gateway/server.ts': `${clean['src/gateway/server.ts']}\nimport './new-cache.js';`,
        'src/gateway/new-cache.ts': "import { query } from '../database/connection.js';",
      },
      ['src/gateway/server.ts', 'src/gateway/new-cache.ts']
    );
    expect(found.join('\n')).toMatch(/src\/gateway\/new-cache\.ts → src\/database\/connection\.ts: outside the allowed closure/);
  });

  it('rejects export * from a service', () => {
    const found = violations({ 'src/gateway/a.ts': "export * from '../services/portfolio/portfolio-service.js';" });
    expect(found.join('\n')).toMatch(/src\/gateway\/server\.ts → src\/gateway\/a\.ts → src\/services\/portfolio\/portfolio-service\.ts/);
  });

  it('rejects require of an engine package', () => {
    expect(violations({ 'src/gateway/a.ts': "const pg = require('pg');" }).join('\n')).toMatch(/→ pg: package not allowed/);
  });

  it('rejects a literal dynamic import that climbs out of src/gateway', () => {
    expect(violations({ 'src/gateway/a.ts': "export const load = () => import('../ai/tools.js');" }).join('\n')).toMatch(
      /src\/ai\/tools\.ts: outside the allowed closure/
    );
  });

  it('rejects a computed specifier, for import() and for require()', () => {
    const found = violations({
      'src/gateway/a.ts': "const name = 'pg';\nvoid import(name);\nconst other = require(`${name}-pool`);",
    });
    expect(found.filter((f) => f.includes('computed specifier'))).toHaveLength(2);
  });

  it('rejects laundering through an allowed file, and prints the chain', () => {
    const found = violations({ 'src/auth/token-store.ts': "import '../database/connection.js';" });
    expect(found).toEqual([
      'src/gateway/server.ts → src/gateway/a.ts → src/auth/login-flows.ts → src/auth/token-store.ts → src/database/connection.ts: outside the allowed closure',
    ]);
  });

  it('rejects require used as a value: aliased, called through .call, or handed along', () => {
    const found = violations({
      'src/gateway/a.ts':
        "const load = require;\nexport const driver = () => load('pg');\nexport const viaCall = () => require.call(null, 'pg');\nexport const loaders = [require];",
    });
    expect(found.filter((f) => f.includes('require used as a value'))).toHaveLength(3);
  });

  it('rejects createRequire: node:module is not a builtin the gateway may load', () => {
    const found = violations({
      'src/gateway/a.ts': "import { createRequire } from 'node:module';\nexport const driver = () => createRequire(__filename)('pg');",
    });
    expect(found.join('\n')).toMatch(/src\/gateway\/a\.ts → node:module: package not allowed/);
  });

  it('rejects eval, the module object and globalThis, which reach the loader by another name', () => {
    const found = violations({
      'src/gateway/a.ts':
        "export const a = () => eval('1');\nexport const b = () => module.constructor;\nexport const c = () => globalThis.process;",
    });
    for (const name of ['eval', 'module', 'globalThis']) {
      expect(found.filter((f) => f.includes(`loader reached through ${name}`)), name).toHaveLength(1);
    }
  });

  it('allows child_process only where it already lives, the token store', () => {
    expect(violations({})).toEqual([]);
    expect(violations({ 'src/gateway/a.ts': "import { execFile } from 'node:child_process';" }).join('\n')).toMatch(
      /src\/gateway\/a\.ts → node:child_process: package not allowed/
    );
  });

  it('lets jose in only through the verification exports, however a signer is named', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['a signer by name', "import { CompactSign } from 'jose';", /→ jose: binds CompactSign, outside the allowed exports/],
      ['a signer under another name', "import { SignJWT as TokenWriter } from 'jose';", /→ jose: binds SignJWT, outside the allowed exports/],
      ['the namespace', "import * as jose from 'jose';", /→ jose: binds the whole module/],
      ['a default import', "import jose from 'jose';", /→ jose: binds default, outside the allowed exports/],
      ['export * from', "export * from 'jose';", /→ jose: binds the whole module/],
      ['a require', "const jose = require('jose');", /→ jose: binds the whole module/],
      ['a dynamic import', "export const load = () => import('jose');", /→ jose: binds the whole module/],
    ];
    for (const [label, text, expected] of cases) {
      expect(violations({ 'src/gateway/a.ts': `${text}\nexport const a = 1;` }).join('\n'), label).toMatch(expected);
    }
    expect(violations({ 'src/gateway/a.ts': "import { jwtVerify, type JWTPayload } from 'jose';\nexport const a = 1;" })).toEqual([]);
  });

  it('judges jose in a borrowed file too: a signer re-exported from src/auth/oidc.ts', () => {
    const found = violations({ 'src/auth/oidc.ts': "import { jwtVerify } from 'jose';\nexport { SignJWT as TokenWriter } from 'jose';" });
    expect(found).toEqual([
      'src/gateway/server.ts → src/gateway/a.ts → src/auth/oidc.ts → jose: binds SignJWT, outside the allowed exports',
    ]);
  });

  it('returns the files it visited, borrowed ones included, so a caller can read what the process loads', () => {
    const { files, violations: found } = importClosure(tree(clean), ['src/gateway/server.ts'], GATEWAY_SERVER_CLOSURE);
    expect(found).toEqual([]);
    expect([...files].sort()).toEqual([
      'src/auth/login-flows.ts',
      'src/auth/oidc.ts',
      'src/auth/token-store.ts',
      'src/gateway/a.ts',
      'src/gateway/server.ts',
    ]);
  });

  it('rejects a relative import that resolves to no file', () => {
    expect(violations({ 'src/gateway/a.ts': "import './ghost.js';" }).join('\n')).toMatch(/→ \.\/ghost\.js: resolves to no file/);
  });

  it('rejects a package the gateway has no business loading, even a harmless one', () => {
    expect(violations({ 'src/gateway/a.ts': "import helmet from 'helmet';" }).join('\n')).toMatch(/→ helmet: package not allowed/);
  });

  it('rejects the browser program reaching server code or any package', () => {
    const found = importClosureViolations(
      tree({
        'src/gateway/app/main.ts': "import '../config.js';\nimport { EN } from '../../i18n/en.js';\nimport 'lit';",
        'src/gateway/config.ts': 'export {};',
        'src/i18n/en.ts': 'export const EN = {};',
      }),
      ['src/gateway/app/main.ts'],
      GATEWAY_APP_CLOSURE
    );
    expect(found.join('\n')).toMatch(/src\/gateway\/config\.ts: outside the allowed closure/);
    expect(found.join('\n')).toMatch(/→ lit: package not allowed/);
    expect(found.join('\n')).not.toMatch(/i18n\/en\.ts/);
  });
});

describe('isNodeBuiltin', () => {
  it('knows builtins with and without the node: prefix, subpaths included', () => {
    for (const b of ['fs', 'node:fs', 'node:stream/web', 'crypto', 'http']) expect(isNodeBuiltin(b), b).toBe(true);
    for (const p of ['pg', 'express', 'node:pg', 'jsonwebtoken']) expect(isNodeBuiltin(p), p).toBe(false);
  });
});
