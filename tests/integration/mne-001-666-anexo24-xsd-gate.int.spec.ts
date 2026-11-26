import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { generarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';

// ============================================================
// MNE-001-666 (#608) · `balance generate` hands over only what the SAT's
// official XSD accepts, against Postgres and the real xmllint.
//
// The defect, reproduced first on develop: the builder's own RFC check takes
// any six digits as the date (balanza-xml.ts) and the schema wants a month
// digit of 0 or 1. An entity whose RFC has month 99 got its balance generated
// AND archived, and the SAT rejects that file whole.
//
// One entry in January (1140 debit 7 000 · 4100 credit 7 000) so that there
// is a balance to declare. Synthetic data; runs as superuser like its siblings.
// ============================================================

let f: Fixture;

const archived = async (): Promise<number> =>
  (
    await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sat_anexo24_artefactos
        WHERE entity_id = $1 AND tenant_id = $2 AND tipo = 'balanza'`,
      [f.entityId, f.tenantId]
    )
  ).rows[0].n;

const setRfc = (rfc: string) =>
  query(`UPDATE legal_entities SET tax_id = $1 WHERE id = $2 AND tenant_id = $3`, [rfc, f.entityId, f.tenantId]);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-666 XSD gate');
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

describe('balance generate and the official XSD', () => {
  it('refuses the balance of an entity whose RFC the schema rejects, and archives nothing', async () => {
    await setRfc('AAA019901AAA');
    try {
      const refused = generarBalanza(f.entityId, { periodo: f.periodos[1], generadoPor: f.userId });
      await expect(refused).rejects.toMatchObject({
        statusCode: 422,
        reason: 'rejected',
        messageKey: { key: 'anexo24.xsd.rejected', params: { schema: 'BalanzaComprobacion_1_3.xsd' } },
      });
      await expect(refused).rejects.toThrow(/attribute 'RFC'.*AAA019901AAA/);
      expect(await archived()).toBe(0);
    } finally {
      await setRfc('XAXX010101000');
    }
  });

  it('refuses an amended balance whose FechaModBal the schema rejects, in a dry run too', async () => {
    // The schema's minInclusive is 2015-01-01; the builder only checks the shape.
    const refused = generarBalanza(f.entityId, {
      periodo: f.periodos[1],
      tipo: 'C',
      fechaModBal: '2014-12-31',
      generadoPor: f.userId,
      dryRun: true,
    });
    await expect(refused).rejects.toMatchObject({ reason: 'rejected' });
    await expect(refused).rejects.toThrow(/attribute 'FechaModBal'/);
  });

  it('generates and archives the balance the schema accepts', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[1], generadoPor: f.userId });
    expect(b.xml).toContain('RFC="XAXX010101000"');
    expect(b.artefacto).not.toBeNull();
    expect(await archived()).toBe(1);
  });
});
