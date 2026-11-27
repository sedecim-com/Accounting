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

/** Runs `fn` on a PATH with no xmllint, and puts the PATH back. */
async function withoutXmllint<T>(fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  process.env.PATH = '/mne-001-666-no-such-directory';
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

describe('balance generate and the official XSD', () => {
  // Since MNE-001-775 the builder's own rules refuse everything this schema
  // refuses, naming the datum: no data reaches the gate and fails it. The gate
  // stays wired, and the case that still reaches it is an xmllint that did not run.
  it('refuses the balance of an entity whose RFC the schema rejects, naming the RFC, and archives nothing', async () => {
    await setRfc('AAA019901AAA');
    try {
      const refused = generarBalanza(f.entityId, { periodo: f.periodos[1], generadoPor: f.userId });
      await expect(refused).rejects.toMatchObject({
        statusCode: 422,
        messageKey: { key: 'anexo24.balance.rfc', params: { rfc: 'AAA019901AAA' } },
      });
      expect(await archived()).toBe(0);
    } finally {
      await setRfc('XAXX010101000');
    }
  });

  it('refuses a file it could not validate, and archives nothing', async () => {
    const refused = withoutXmllint(() => generarBalanza(f.entityId, { periodo: f.periodos[1], generadoPor: f.userId }));
    await expect(refused).rejects.toMatchObject({
      statusCode: 422,
      reason: 'not_validated',
      messageKey: { key: 'anexo24.xsd.not_validated' },
    });
    expect(await archived()).toBe(0);
  });

  it('refuses an amended balance whose FechaModBal the schema rejects, in a dry run too', async () => {
    // The schema's minInclusive is 2015-01-01.
    const refused = generarBalanza(f.entityId, {
      periodo: f.periodos[1],
      tipo: 'C',
      fechaModBal: '2014-12-31',
      generadoPor: f.userId,
      dryRun: true,
    });
    await expect(refused).rejects.toMatchObject({
      messageKey: { key: 'anexo24.balance.modified_date', params: { date: '2014-12-31' } },
    });
  });

  it('generates and archives the balance the schema accepts', async () => {
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[1], generadoPor: f.userId });
    expect(b.xml).toContain('RFC="XAXX010101000"');
    expect(b.artefacto).not.toBeNull();
    expect(await archived()).toBe(1);
  });
});
