import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { drainAttestations, voidJournalEntry } from '../../src/services/accounting/posting.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { recordCustomerPayment } from '../../src/services/payments/payment-service.js';
import { importSatChart } from '../../src/services/accounting/sat-chart-import.js';
import { importOpeningBalance, type OpeningDocument } from '../../src/services/accounting/opening-balance.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';

// ============================================================
// MNE-001-946 · #1078 · AN OPEN RECEIVABLE OF THE MIGRATION CARRIES ITS IVA
//
// The failing case of the review of 27 Nov 2026 (report 06, G1), by hand. A
// firm arrives with ONE open customer invoice, A-123, for 116,000.00: a sale
// of 100,000.00 at 16 %, not collected, so its 16,000.00 of IVA is not caused
// yet (LIVA art. 1-B) and the previous system holds it on 209-001, IVA
// trasladado no cobrado.
//
//   ASSETS      102-001 Bank                    100 000 D
//               105-001 Customers               116 000 D   ← A-123
//               → 100 Assets                    216 000 D
//   LIABILITIES 209-001 IVA not yet collected    16 000 A   ← the IVA of A-123
//               → 200 Liabilities                16 000 A
//   EQUITY      301     Share capital           200 000 A
//
// 216 000 = 16 000 + 200 000: the entry foots with no plug.
//
// Part 1 of 2: what the load writes. The collection that moves the 16,000.00
// to the account of IVA due is part 2, and the second case measures it as it
// stands today.
// ============================================================

const RFC = 'XAXX010101000';
const NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3';

/** [NumCta, Desc, SubCtaDe, CodAgrup, Nivel, Natur, SaldoFin at 2025-12-31]. */
const CHART: readonly (readonly [string, string, string | null, string, number, 'D' | 'A', string])[] = [
  ['100', 'Activo', null, '100', 1, 'D', '216000.00'],
  ['102', 'Bancos', '100', '102', 2, 'D', '100000.00'],
  ['102-001', 'Banco del Bajio', '102', '102.01', 3, 'D', '100000.00'],
  ['105', 'Clientes', '100', '105', 2, 'D', '116000.00'],
  ['105-001', 'Clientes nacionales', '105', '105.01', 3, 'D', '116000.00'],
  ['200', 'Pasivo', null, '200', 1, 'A', '16000.00'],
  ['209', 'IVA trasladado no cobrado', '200', '209', 2, 'A', '16000.00'],
  ['209-001', 'IVA trasladado no cobrado', '209', '209.01', 3, 'A', '16000.00'],
  ['300', 'Capital contable', null, '300', 1, 'A', '200000.00'],
  ['301', 'Capital social', '300', '301', 2, 'A', '200000.00'],
];
const CHART_XML =
  `<?xml version="1.0" encoding="UTF-8"?><catalogocuentas:Catalogo xmlns:catalogocuentas="${NS}/CatalogoCuentas" ` +
  `Version="1.3" RFC="${RFC}" Mes="12" Anio="2025">` +
  CHART.map(([num, desc, parent, group, level, nature]) =>
    `<catalogocuentas:Ctas CodAgrup="${group}" NumCta="${num}" Desc="${desc}"` +
    `${parent === null ? '' : ` SubCtaDe="${parent}"`} Nivel="${level}" Natur="${nature}"/>`).join('') +
  '</catalogocuentas:Catalogo>';
/** The trial balance of the previous system; `balances` overrides a SaldoFin by account. */
const trialBalance = (balances: Record<string, string> = {}): string =>
  `<?xml version="1.0" encoding="UTF-8"?><BCE:Balanza xmlns:BCE="${NS}/BalanzaComprobacion" ` +
  `Version="1.3" RFC="${RFC}" Mes="12" Anio="2025" TipoEnvio="N">` +
  CHART.map(([num, , , , , , balance]) => {
    const s = balances[num] ?? balance;
    return `<BCE:Ctas NumCta="${num}" SaldoIni="${s}" Debe="0.00" Haber="0.00" SaldoFin="${s}"/>`;
  }).join('') +
  '</BCE:Balanza>';

const A123_WITHOUT_RATE: OpeningDocument = {
  cuenta: '105-001', documento: 'A-123', contraparte: 'Aceros del Norte SA', rfc: 'ANO010101AAA',
  fecha: '2025-11-02', vencimiento: '2025-12-02', importe: '116000.00',
};
const A123: OpeningDocument = { ...A123_WITHOUT_RATE, ivaRate: '0.16' };

let f: Fixture;
const ctxOf = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

/** A sibling entity with the migrated chart and the roles the load and a collection read. */
async function migrated(name: string) {
  const own = await crearEntidadHermana(f, name);
  await importSatChart(ctxOf(own), { entityId: own.entityId, xml: CHART_XML, userId: own.userId });
  const ids = Object.fromEntries(
    (await query<{ code: string; id: string }>(`SELECT code, id FROM accounts WHERE entity_id = $1`, [own.entityId]))
      .rows.map((x) => [x.code, x.id])
  );
  for (const [role, code] of [['cxc', '105-001'], ['banco', '102-001'], ['iva_trasladado_no_cobrado', '209-001']]) {
    await setAccountRole(own.entityId, own.tenantId, role, ids[code], { userId: own.userId });
  }
  return { own, ids };
}
/** Answers the key for THIS entity; its row is seeded first, as `pending define` finds it. */
async function assumeZeroRate(own: Fixture): Promise<void> {
  await seedPolicies(ctxOf(own));
  await resolvePolicy(ctxOf(own), 'opening_receivable_iva', 'assume_zero_rate', own.userId, 'test');
}
const load = (own: Fixture, documents: OpeningDocument[] = [A123], xml = trialBalance()) =>
  importOpeningBalance(ctxOf(own), { entityId: own.entityId, xml, userId: own.userId, documentos: documents });

interface InvoiceRow {
  id: string; customer_id: string; subtotal: string; tax_amount: string; total_amount: string; amount_due: string;
  je: string | null; lines: string | null;
}
/** The invoices of the entity, each with its lines as «rate/code/base/IVA/total». */
const invoicesOf = async (entityId: string) =>
  (await query<InvoiceRow>(
    `SELECT i.id, i.customer_id, i.subtotal::text, i.tax_amount::text, i.total_amount::text, i.amount_due::text,
            i.journal_entry_id::text AS je,
            (SELECT string_agg(concat_ws('/', COALESCE(il.tax_rate::text, '-'), COALESCE(il.tax_code, '-'),
                                         il.line_amount::text, il.tax_amount::text, il.total_amount::text), ' | '
                               ORDER BY il.line_number)
               FROM invoice_lines il WHERE il.invoice_id = i.id) AS lines
       FROM invoices i WHERE i.entity_id = $1 ORDER BY i.invoice_number`,
    [entityId]
  )).rows;
const written = async (entityId: string) =>
  (await query<{ entries: string; invoices: string; customers: string }>(
    `SELECT (SELECT COUNT(*) FROM journal_entries WHERE entity_id = $1)::text AS entries,
            (SELECT COUNT(*) FROM invoices WHERE entity_id = $1)::text AS invoices,
            (SELECT COUNT(*) FROM customers WHERE entity_id = $1)::text AS customers`,
    [entityId]
  )).rows[0];
const NOTHING = { entries: '0', invoices: '0', customers: '0' };

beforeAll(async () => {
  f = await crearInquilino('MNE-001-946 opening receivable IVA');
  enterTenant(f.tenantId);
  await seedPolicies({ tenantId: f.tenantId });
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('MNE-001-946: an open receivable of the migration carries its IVA', () => {
  it('A-123 for 116,000.00 at 16 % is born 100,000.00 + 16,000.00, its rate on one line, hanging from the opening', async () => {
    const { own } = await migrated('MNE-001-946 the case');
    const r = await load(own);
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([]);
    expect(r.escrito).toBe(true);
    expect(r.arInvoices).toBe(1);
    // 116,000 / 1.16 = 100,000 exactly; the IVA is the rest.
    expect(await invoicesOf(own.entityId)).toEqual([
      expect.objectContaining({
        subtotal: '100000.0000', tax_amount: '16000.0000', total_amount: '116000.0000', amount_due: '116000.0000',
        je: r.asiento?.id, lines: '16.00/-/100000.0000/16000.0000/116000.0000',
      }),
    ]);
    // No money of its own: the opening line is the only debit on the control account.
    const reconciliation = await arReconcile(own.entityId);
    expect(reconciliation.control_balance).toBe('116000.00');
    expect(reconciliation.delta).toBe('0.00');
  });

  it('THE DAMAGE, MEASURED (part 2 turns this case around): collecting it in full still moves nothing out of 209-001', async () => {
    const { own, ids } = await migrated('MNE-001-946 the collection as it stands');
    await load(own);
    const [invoice] = await invoicesOf(own.entityId);
    const receipt = await recordCustomerPayment(
      {
        entityId: own.entityId, counterpartyId: invoice.customer_id, paymentAmount: '116000.00',
        paymentDate: '2026-01-15', paymentMethod: 'spei',
        applications: [{ documentId: invoice.id, amountApplied: '116000.00' }],
      },
      own.userId
    );
    expect(receipt.documentos).toEqual([expect.objectContaining({ numero: 'A-123', saldoNuevo: '0.00', estado: 'paid' })]);
    const pending = await query<{ balance: string }>(
      `SELECT COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0)::numeric(19,2)::text AS balance
         FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.account_id = $2`,
      [own.entityId, ids['209-001']]
    );
    const stored = await query<{ iva: string | null }>(
      `SELECT pa.iva_reclass_amount::text AS iva
         FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE i.entity_id = $1 AND pa.invoice_id = $2`,
      [own.entityId, invoice.id]
    );
    // What LIVA art. 1-B asks is 0.00 left and 16000.0000 stored: part 2 of this task.
    expect(pending.rows[0].balance).toBe('16000.00');
    expect(stored.rows).toEqual([{ iva: '0.0000' }]);
  });

  it('a document with no rate: require_rate stops the load, names it and writes nothing; assume_zero_rate loads it at 0 % and warns', async () => {
    const { own } = await migrated('MNE-001-946 no rate');
    const stopped = await load(own, [A123_WITHOUT_RATE]);
    expect(stopped.escrito).toBe(false);
    expect(stopped.findings.filter((x) => x.regla.startsWith('APE-CXC-'))).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-SIN-TASA', severidad: 'bloquea', numCta: '105-001',
        messageKey: {
          key: 'migration.opening.receivable_rate_missing',
          params: { document: 'A-123', counterparty: 'Aceros del Norte SA' },
        },
      }),
    ]);
    expect(await written(own.entityId)).toEqual(NOTHING);

    await assumeZeroRate(own);
    const assumed = await load(own, [A123_WITHOUT_RATE]);
    expect(assumed.escrito).toBe(true);
    expect(assumed.findings.filter((x) => x.regla.startsWith('APE-CXC-'))).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-TASA-SUPUESTA', severidad: 'aviso',
        messageKey: { key: 'migration.opening.receivable_rate_assumed', params: { count: 1, documents: 'A-123' } },
      }),
    ]);
    expect(await invoicesOf(own.entityId)).toEqual([
      expect.objectContaining({
        subtotal: '116000.0000', tax_amount: '0.0000', total_amount: '116000.0000',
        lines: '0.00/-/116000.0000/0.0000/116000.0000',
      }),
    ]);
  });

  it('IVA above what the opening holds on the pending account blocks, naming the account and both figures', async () => {
    const { own } = await migrated('MNE-001-946 pending account short');
    // The source parks 15,000.00 only; the other 1,000.00 sits in capital so that it still foots.
    const short = trialBalance({
      '209-001': '15000.00', '209': '15000.00', '200': '15000.00', '301': '201000.00', '300': '201000.00',
    });
    const r = await load(own, [A123], short);
    expect(r.escrito).toBe(false);
    expect(r.findings.filter((x) => x.severidad === 'bloquea')).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-IVA-SIN-SALDO', numCta: '209-001',
        messageKey: {
          key: 'migration.opening.receivable_iva_not_parked',
          params: { tax: '16000.00', parked: '15000.00', account: '209-001', role: 'iva_trasladado_no_cobrado' },
        },
      }),
    ]);
    expect(await written(own.entityId)).toEqual(NOTHING);
  });

  it('a reload after voiding the opening (087) takes the invoice over with its rate: one invoice, one line', async () => {
    const { own } = await migrated('MNE-001-946 reload');
    await assumeZeroRate(own);
    const first = await load(own, [A123_WITHOUT_RATE]);
    const [before] = await invoicesOf(own.entityId);
    expect(before).toMatchObject({ tax_amount: '0.0000', lines: '0.00/-/116000.0000/0.0000/116000.0000' });

    await voidJournalEntry(first.asiento?.id ?? '', own.userId, 'the file did not say the rate');
    const second = await load(own);
    expect(second.escrito).toBe(true);
    expect(await invoicesOf(own.entityId)).toEqual([
      expect.objectContaining({
        id: before.id, subtotal: '100000.0000', tax_amount: '16000.0000', total_amount: '116000.0000',
        je: second.asiento?.id, lines: '16.00/-/100000.0000/16000.0000/116000.0000',
      }),
    ]);
    expect((await arReconcile(own.entityId)).delta).toBe('0.00');
  });
});
