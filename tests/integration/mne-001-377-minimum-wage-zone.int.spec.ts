import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerEntityCommand } from '../../src/cli/entity-command.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createEmployee } from '../../src/services/payroll/common/employee-service.js';
import { calculateFiniquito } from '../../src/services/payroll/mx/finiquito-calculator.js';
import {
  minimumWageZoneOf,
  setEntityMinimumWageZone,
} from '../../src/services/payroll/mx/minimum-wage-zone.js';

/**
 * MNE-001-377 (#196), against the real database. Migration 336 gives the
 * entity its minimum-wage zone (NOT NULL, default general, with the date it
 * was declared) and the employee an optional override, and the finiquito caps
 * the seniority premium with that zone's minimum (LFT art. 486): fifteen years
 * at 1 000 a day are 113 414.40 in the general zone and 158 713.20 at the
 * northern border in 2026.
 */

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('MNE-377 minimum wage zone');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function employee(number: string, zone?: 'general' | 'northern_border'): Promise<string> {
  return createEmployee({
    tenant_id: f.tenantId,
    entity_id: f.entityId,
    employee_number: number,
    first_name: 'Ana',
    last_name: 'Prueba',
    hire_date: '2011-03-01',
    country_code: 'MX',
    rfc: 'PRAA800101AB1',
    curp: 'PRAA800101MDFZNN09',
    nss: '12345678901',
    annual_salary: 365000,
    created_by: f.userId,
    ...(zone ? { minimum_wage_zone: zone } : {}),
  });
}

const termination = (employeeId: string) => ({
  employee_id: employeeId,
  termination_date: '2026-06-30',
  last_paid_through: '2026-06-15',
  termination_reason: 'renuncia' as const,
});

describe('migration 336', () => {
  it('the entity column is NOT NULL with default general; the declaration date and the employee override are nullable', async () => {
    const cols = await query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE column_name IN ('minimum_wage_zone', 'minimum_wage_zone_declared_at')
        ORDER BY table_name, column_name`
    );
    expect(cols.rows.map((c) => [c.table_name, c.column_name, c.is_nullable])).toEqual([
      ['employees', 'minimum_wage_zone', 'YES'],
      ['legal_entities', 'minimum_wage_zone', 'NO'],
      ['legal_entities', 'minimum_wage_zone_declared_at', 'YES'],
    ]);
    expect(cols.rows[1].column_default).toMatch(/'general'/);
  });

  it('an entity nobody declared reads general, undeclared', async () => {
    expect(await minimumWageZoneOf({ tenantId: f.tenantId, entityId: f.entityId })).toEqual({
      zone: 'general', declaredBy: null,
    });
  });

  it('the CHECK refuses anything but the two zones', async () => {
    await expect(
      query(`UPDATE legal_entities SET minimum_wage_zone = 'frontera' WHERE id = $1`, [f.entityId])
    ).rejects.toThrow(/check constraint/);
  });
});

describe('the finiquito reads the zone', () => {
  it('undeclared: the general minimum, and the result says nobody declared it', async () => {
    const r = await calculateFiniquito(termination(await employee('M377-001')), { tenantId: f.tenantId, entityId: f.entityId });
    expect(r.seniority_premium_amount).toBe('113414.4000');
    expect(r.seniority_premium_minimum_wage.declared_by).toBeNull();
  });

  it('an employee override at the border: 2 × 440.87', async () => {
    const r = await calculateFiniquito(termination(await employee('M377-002', 'northern_border')), {
      tenantId: f.tenantId, entityId: f.entityId,
    });
    expect(r.seniority_premium_amount).toBe('158713.2000');
    expect(r.seniority_premium_minimum_wage).toMatchObject({ zone: 'northern_border', declared_by: 'employee' });
  });

  it('the entity declared at the border, stamped and audited', async () => {
    const audit = { userId: f.userId, tenantId: f.tenantId, reason: 'registro patronal en la frontera' };
    const set = await setEntityMinimumWageZone(f.entityId, f.tenantId, 'northern_border', audit);
    expect(set.minimum_wage_zone_declared_at).not.toBeNull();
    const r = await calculateFiniquito(termination(await employee('M377-003')), { tenantId: f.tenantId, entityId: f.entityId });
    expect(r.seniority_premium_amount).toBe('158713.2000');
    expect(r.seniority_premium_minimum_wage.declared_by).toBe('entity');
    const logged = await query(
      `SELECT 1 FROM audit_log WHERE entity_type = 'legal_entities' AND entity_id = $1 AND tenant_id = $2`,
      [f.entityId, f.tenantId]
    );
    expect(logged.rows.length).toBeGreaterThan(0);
  });

  it('another tenant cannot declare it', async () => {
    await expect(
      setEntityMinimumWageZone(f.entityId, randomUUID(), 'general', { userId: f.userId, tenantId: f.tenantId })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('from the terminal', () => {
  const plain = {
    dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
    red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mne377-'));
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

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

  it('entity create --minimum-wage-zone declares it; entity show prints it; edit changes it; a bad value is refused', async () => {
    const created = await cli(['entity', 'create', 'Zona Norte SA', '--tax-id', 'ZNO010101AB1', '--minimum-wage-zone', 'northern_border']);
    expect(created.exitCode, created.err).toBe(0);
    const shown = await cli(['entity', 'show', 'ZNO010101AB1', '--json']);
    expect((JSON.parse(shown.out) as { rows: Array<Record<string, unknown>> }).rows[0]).toMatchObject({
      minimum_wage_zone: 'northern_border',
    });

    const edited = await cli(['entity', 'edit', 'ZNO010101AB1', '--minimum-wage-zone', 'general', '--reason', 'cambio de registro']);
    expect(edited.exitCode, edited.err).toBe(0);
    const zone = await query<{ minimum_wage_zone: string; declared: boolean }>(
      `SELECT minimum_wage_zone, minimum_wage_zone_declared_at IS NOT NULL AS declared
         FROM legal_entities WHERE tax_id = 'ZNO010101AB1' AND tenant_id = $1`,
      [f.tenantId]
    );
    expect(zone.rows[0]).toEqual({ minimum_wage_zone: 'general', declared: true });

    const bad = await cli(['entity', 'edit', 'ZNO010101AB1', '--minimum-wage-zone', 'frontera']);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.err).toMatch(/general, northern_border/);
  }, 120_000);
});
