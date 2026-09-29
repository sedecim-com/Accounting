import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import {
  createEntity,
  getEntityTaxProfile,
  updateEntityTaxProfile,
} from '../../src/services/entity/entity-service.js';
import { registerEntityCommand } from '../../src/cli/entity-command.js';

/**
 * MNE-001-017 (#321), against the real database.
 *
 * legal_entities had the RFC and nothing else of its fiscal identity, while
 * customers carry the regime and the fiscal postal code since 049. Migration
 * 120 gives the entity both, nullable and without a hard CHECK; the service
 * validates them against sat-catalogs.ts on create and on edit alike.
 */

let f: Fixture;
let other: Fixture;
let home: string;

beforeAll(async () => {
  f = await crearInquilino('MNE-017 entity tax profile');
  other = await crearInquilino('MNE-017 other tenant');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mne017-'));
}, 120_000);

afterAll(async () => {
  fs.rmSync(home, { recursive: true, force: true });
  await drainAttestations(2000);
  await closeDatabase();
});

async function row(entityId: string): Promise<{ tax_regime: string | null; tax_postal_code: string | null }> {
  const r = await query<{ tax_regime: string | null; tax_postal_code: string | null }>(
    'SELECT tax_regime, tax_postal_code FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return r.rows[0];
}

describe('migration 120', () => {
  it('adds both columns, nullable, with no CHECK on them', async () => {
    const cols = await query<{ column_name: string; is_nullable: string; character_maximum_length: number }>(
      `SELECT column_name, is_nullable, character_maximum_length
         FROM information_schema.columns
        WHERE table_name = 'legal_entities' AND column_name IN ('tax_regime', 'tax_postal_code')
        ORDER BY column_name`
    );
    expect(cols.rows).toEqual([
      { column_name: 'tax_postal_code', is_nullable: 'YES', character_maximum_length: 5 },
      { column_name: 'tax_regime', is_nullable: 'YES', character_maximum_length: 3 },
    ]);
    const checks = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'legal_entities'::regclass AND contype = 'c'`
    );
    expect(checks.rows.filter((c) => /tax_regime|tax_postal_code/.test(c.def))).toEqual([]);
    // The entities that existed before 120 simply lack it.
    expect(await row(f.entityId)).toEqual({ tax_regime: null, tax_postal_code: null });
  });
});

describe('the service', () => {
  it('creates with regime and postal code, validated and stored', async () => {
    const r = await createEntity({
      name: 'Regimen General SA', taxId: 'RGE010101AB1', country: 'MX',
      tenantId: f.tenantId, createdBy: f.userId, taxRegime: '601', taxPostalCode: '01000',
    });
    expect(r.warnings).toEqual([]);
    expect(await row(r.entityId)).toEqual({ tax_regime: '601', tax_postal_code: '01000' });
    expect(await getEntityTaxProfile(r.entityId, f.tenantId)).toEqual({
      tax_regime: '601', tax_regime_name: 'General de Ley Personas Morales', tax_postal_code: '01000',
    });
  }, 120_000);

  it('creates a Mexican entity without a regime, and warns', async () => {
    const r = await createEntity({
      name: 'Sin Regimen SA', taxId: 'SRE010101AB1', country: 'MX', tenantId: f.tenantId, createdBy: f.userId,
    });
    expect(await row(r.entityId)).toEqual({ tax_regime: null, tax_postal_code: null });
    expect(r.warnings.join('\n')).toMatch(/tax regime/);
  }, 120_000);

  it('refuses a regime outside c_RegimenFiscal and creates nothing', async () => {
    await expect(
      createEntity({
        name: 'Regimen Falso SA', taxId: 'RFA010101AB1', country: 'MX',
        tenantId: f.tenantId, createdBy: f.userId, taxRegime: '999',
      })
    ).rejects.toThrow(/c_RegimenFiscal/);
    const r = await query('SELECT 1 FROM legal_entities WHERE tax_id = $1', ['RFA010101AB1']);
    expect(r.rows).toHaveLength(0);
  });

  it('edits with the same validation, audited, and never across tenants', async () => {
    await updateEntityTaxProfile(f.entityId, f.tenantId, { taxRegime: '626', taxPostalCode: '64000' },
      { userId: f.userId, tenantId: f.tenantId, reason: 'constancia de situacion fiscal' });
    expect(await row(f.entityId)).toEqual({ tax_regime: '626', tax_postal_code: '64000' });

    await expect(
      updateEntityTaxProfile(f.entityId, f.tenantId, { taxPostalCode: '640' },
        { userId: f.userId, tenantId: f.tenantId })
    ).rejects.toThrow(/5 digits/);
    await expect(
      updateEntityTaxProfile(f.entityId, other.tenantId, { taxRegime: '601' },
        { userId: other.userId, tenantId: other.tenantId })
    ).rejects.toThrow(/not found/i);
    expect(await row(f.entityId)).toEqual({ tax_regime: '626', tax_postal_code: '64000' });

    const audit = await query<{ reason: string; new_values: Record<string, string> }>(
      `SELECT reason, new_values FROM audit_log
        WHERE entity_type = 'legal_entities' AND entity_id = $1`,
      [f.entityId]
    );
    expect(audit.rows).toEqual([
      { reason: 'constancia de situacion fiscal', new_values: { tax_regime: '626', tax_postal_code: '64000' } },
    ]);
  });
});

describe('from the terminal', () => {
  const plain = {
    dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
    red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
  };

  async function cli(argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
    let exitCode: number | undefined;
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const p = new Command('mnemosine');
      registerEntityCommand(p, {
        palette: plain as never,
        shutdown: (c: number) => { exitCode = c; },
        reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
        home,
      });
      await p.parseAsync(['node', 'mnemosine', ...argv, '-t', f.tenantId]);
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
    return { exitCode, out: out.join(''), err: err.join('') };
  }

  it('entity create --tax-regime --tax-postal-code stores them, and entity show prints them', async () => {
    const created = await cli([
      'entity', 'create', 'Terminal SA', '--tax-id', 'TER010101AB1', '--tax-regime', '601', '--tax-postal-code', '01000',
    ]);
    expect(created.exitCode, created.err).toBe(0);
    expect(created.err).not.toMatch(/Created without/);

    const shown = await cli(['entity', 'show', 'TER010101AB1', '--json']);
    expect(shown.exitCode, shown.err).toBe(0);
    expect((JSON.parse(shown.out) as { rows: unknown[] }).rows).toMatchObject([
      { tax_id: 'TER010101AB1', tax_regime: '601', tax_postal_code: '01000' },
    ]);
  }, 120_000);

  it('entity create without a regime succeeds and warns on stderr', async () => {
    const r = await cli(['entity', 'create', 'Terminal Sin Regimen SA', '--tax-id', 'TSR010101AB1']);
    expect(r.exitCode, r.err).toBe(0);
    expect(r.err).toMatch(/Created without tax regime and fiscal postal code/);
    expect(r.err).toContain('mnemosine entity edit TSR010101AB1 --tax-regime');
  }, 120_000);

  it('entity edit persists the regime, and refuses an invalid one without writing', async () => {
    const ok = await cli(['entity', 'edit', 'TSR010101AB1', '--tax-regime', '612', '--reason', 'alta en el RFC']);
    expect(ok.exitCode, ok.err).toBe(0);
    const id = await query<{ id: string }>('SELECT id FROM legal_entities WHERE tax_id = $1', ['TSR010101AB1']);
    expect(await row(id.rows[0].id)).toEqual({ tax_regime: '612', tax_postal_code: null });

    const bad = await cli(['entity', 'edit', 'TSR010101AB1', '--tax-regime', '999']);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.err).toMatch(/c_RegimenFiscal/);
    expect(await row(id.rows[0].id)).toEqual({ tax_regime: '612', tax_postal_code: null });
  }, 120_000);
});
