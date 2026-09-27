import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import { generarBalanza, verificarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';
import { readBalanzaComprobacion } from '../../src/services/sat/anexo24/balance-reader.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// F07h · #323 — THE BALANZA DECLARES EACH LEDGER ACCOUNT WITH ITS SUBACCOUNTS.
//
// Seeded chart: 1000 Activo › 1100 Activo Circulante › 1110 Caja y Bancos ›
// 1111 (MXN) and 1112 (USD). Money only in the two leaves:
//
//   JANUARY   1111 debit 1 000 · 4100 credit 1 000
//             1112 debit   250 · 4100 credit   250
//   FEBRUARY  1111 debit   300 · 1112 credit   300   (transfer)
//             1112 debit    50 · 4100 credit    50
//
//   February:  1111  ini 1000  debe 300  haber   0  fin 1300
//              1112  ini  250  debe  50  haber 300  fin    0
//              1110  ini 1250  debe 350  haber 300  fin 1300   ← the sum
//
// Before #323, 1110, 1100 and 1000 went out at zero and `balance check` said
// so with `mayor-sin-agregar`.
// ============================================================

let f: Fixture;

async function post(month: number, debit: string, credit: string, amount: string) {
  return createJournalEntry(
    f.entityId,
    fechaEnPeriodo(month, 10),
    JournalEntryType.STANDARD,
    `F07h ${debit}/${credit}`,
    [
      { account_id: f.cuentas[debit], debit_amount: amount, credit_amount: null, description: 'F07h' },
      { account_id: f.cuentas[credit], debit_amount: null, credit_amount: amount, description: 'F07h' },
    ],
    f.userId,
    { autoPost: true }
  );
}

function node(xml: string, accountCode: string): string | undefined {
  return xml
    .split('\n')
    .find((l) => l.includes(`NumCta="${accountCode}"`))
    ?.trim();
}

beforeAll(async () => {
  f = await crearInquilino('F07h balanza agregada');
  enterTenant(f.tenantId);
  await post(1, '1111', '4100', '1000.0000');
  await post(1, '1112', '4100', '250.0000');
  await post(2, '1111', '1112', '300.0000');
  await post(2, '1112', '4100', '50.0000');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('#323 · the ledger account carries its subaccounts', () => {
  it('1110 declares 1111 + 1112 in SaldoIni, Debe, Haber and SaldoFin', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(node(b.xml, '1111')).toBe(
      '<BCE:Ctas NumCta="1111" SaldoIni="1000.00" Debe="300.00" Haber="0.00" SaldoFin="1300.00"/>'
    );
    expect(node(b.xml, '1112')).toBe(
      '<BCE:Ctas NumCta="1112" SaldoIni="250.00" Debe="50.00" Haber="300.00" SaldoFin="0.00"/>'
    );
    expect(node(b.xml, '1110')).toBe(
      '<BCE:Ctas NumCta="1110" SaldoIni="1250.00" Debe="350.00" Haber="300.00" SaldoFin="1300.00"/>'
    );
    // And upwards, to the level-1 account the SAT crosses against the catalog.
    expect(node(b.xml, '1000')).toContain('SaldoFin="1300.00"');
  });

  it('the file validates against the official BalanzaComprobacion XSD', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(validateAgainstOfficialXsd(b.xml, 'trialBalance')).toEqual({ valid: true, errors: [] });
  });

  it('the file re-reads clean: well-formed, Anexo 24 shape, every row passes the SAT recalculation', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const reread = readBalanzaComprobacion(b.xml);
    expect(reread.findings).toEqual([]);
    expect(reread.puedeImportarse).toBe(true);
    expect(reread.rows.find((r) => r.numCta === '1110')?.saldoFin).toBe('1300.00');
  });

  it('balance check has no mayor-sin-agregar left to say, and nothing blocks', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[2] });
    expect(r.checks as readonly string[]).not.toContain('mayor-sin-agregar');
    expect(r.conteo.blocking).toBe(0);
    expect(r.inicial.descuadres).toEqual([]);
  });

  it('with «hasta_nivel_2» the level cut comes AFTER the sum: 1100 carries the deeper money', async () => {
    await seedPolicies({ tenantId: f.tenantId });
    const key = 'anexo24_niveles_a_presentar';
    const setLevels = async (value: string) => {
      const r = await query<{ status: string }>(
        `SELECT status FROM policy_decisions WHERE tenant_id = $1 AND key = $2 AND entity_id IS NULL`,
        [f.tenantId, key]
      );
      if (r.rows[0]?.status !== 'pending') await reopenPolicy({ tenantId: f.tenantId }, key);
      await resolvePolicy({ tenantId: f.tenantId }, key, value, f.userId, 'prueba de integración F07h');
    };
    await setLevels('hasta_nivel_2');
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    await setLevels('jerarquia_completa');
    expect(node(b.xml, '1110')).toBeUndefined();
    expect(node(b.xml, '1100')).toBe(
      '<BCE:Ctas NumCta="1100" SaldoIni="1250.00" Debe="350.00" Haber="300.00" SaldoFin="1300.00"/>'
    );
  });
});
