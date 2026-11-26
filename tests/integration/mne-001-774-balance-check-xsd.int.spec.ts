import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { generarBalanza, verificarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';

// ============================================================
// MNE-001-774 (#608) · `balance check` runs the SAT's official XSD over the
// bytes `balance generate` would build, against Postgres and the real xmllint.
//
// The defect, reproduced first on develop: for an entity whose RFC has month
// 99, `check` came out with zero findings while `generate` refused the same
// balance with `anexo24.xsd.rejected` (#982's risks).
//
// One entry in January (1140 debit 7 000 · 4100 credit 7 000) so that there
// is a balance to declare. Synthetic data; runs as superuser like its siblings.
// ============================================================

let f: Fixture;

const setRfc = (rfc: string) =>
  query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [rfc, f.entityId, f.tenantId]);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-774 balance check XSD');
  enterTenant(f.tenantId);
  await createJournalEntry(
    f.entityId,
    fechaEnPeriodo(1, 10),
    JournalEntryType.STANDARD,
    'Venta de enero',
    [
      { account_id: f.cuentas['1140'], debit_amount: '7000.0000', credit_amount: null, description: 'Venta' },
      { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: '7000.0000', description: 'Venta' },
    ],
    f.userId,
    { autoPost: true }
  );
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// Without an archived catalog `cuentas-en-catalogo` warns that it matched the
// chart as it stands today; that warning is the same before and after this task.
const blocking = (r: Awaited<ReturnType<typeof verificarBalanza>>) => r.hallazgos.filter((h) => h.severity === 'blocking');

describe('balance check and the official XSD', () => {
  it('is not clean for an entity whose RFC the schema rejects, the balance generate refuses', async () => {
    await setRfc('AAA019901AAA');
    try {
      await expect(generarBalanza(f.entityId, { periodo: f.periodos[1], dryRun: true })).rejects.toMatchObject({
        reason: 'rejected',
      });
      // The same verdict from check: the two surfaces agree.
      const r = await verificarBalanza(f.entityId, { periodo: f.periodos[1] });
      expect(r.conteo.blocking).toBe(1);
      expect(blocking(r).map((h) => [h.check, h.referencia, h.messageKey?.key])).toEqual([
        ['xsd', '', 'anexo24.xsd.rejected'],
      ]);
      expect(r.hallazgos.at(-1)?.check, 'after the hand-written findings').toBe('xsd');
      expect(r.hallazgos.at(-1)?.detalle).toMatch(/BalanzaComprobacion_1_3\.xsd.*attribute 'RFC'.*AAA019901AAA/);

      // Asking only for a data check runs no schema.
      const one = await verificarBalanza(f.entityId, { periodo: f.periodos[1], checks: ['saldos'] });
      expect(one.hallazgos).toEqual([]);
    } finally {
      await setRfc('XAXX010101000');
    }
  });

  it('is not clean for an amended balance whose FechaModBal is before the schema minimum', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[1], tipo: 'C', fechaModBal: '2014-12-31' });
    expect(blocking(r).map((h) => h.check)).toEqual(['xsd']);
    expect(blocking(r)[0].detalle).toMatch(/attribute 'FechaModBal'/);
  });

  it('says why when no file can be built, instead of coming out clean', async () => {
    // An amended balance with no FechaModBal: the builder refuses it, and so does generate.
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[1], tipo: 'C' });
    expect(blocking(r).map((h) => [h.check, h.messageKey?.key])).toEqual([['xsd', 'anexo24.xsd.not_built']]);
    expect(blocking(r)[0].detalle).toMatch(/^No file was built to check against the SAT XSD .*FechaModBal/);
  });

  it('has no blocking finding for the balance the schema accepts, with the six checks run', async () => {
    const r = await verificarBalanza(f.entityId, { periodo: f.periodos[1] });
    expect(r.checks).toEqual(['saldos', 'redondeo', 'cuentas-en-catalogo', 'natur-coherente', 'sin-sello', 'xsd']);
    expect(r.conteo.blocking).toBe(0);
  });
});
