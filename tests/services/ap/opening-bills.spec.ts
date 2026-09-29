import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  planOpeningBills,
  prepareOpeningBills,
  payablesSkippedUnderDraftMode,
  writeOpeningBills,
  type ExistingBill,
  type OpeningBillDraft,
  type OpeningBillsContext,
  type OpeningBillsPlan,
} from '../../../src/services/ap/opening-bills.js';
import type { OpeningDocument, OpeningPlan } from '../../../src/services/accounting/opening-balance.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

// ============================================================
// MNE-001-023 · the payable documents of the opening become bills
// ============================================================

const doc = (p: Partial<OpeningDocument> & Pick<OpeningDocument, 'documento'>): OpeningDocument => ({
  cuenta: '201-001',
  contraparte: 'Papelera del Centro',
  fecha: '2025-12-01',
  vencimiento: '2026-01-15',
  importe: '9000.00',
  ...p,
});

function plan(docs: OpeningDocument[], kinds: Record<string, 'cxc' | 'cxp'> = { '201-001': 'cxp' }) {
  return {
    lines: [
      { code: '102-001', accountId: 'a', debit: '1.0000', credit: null, description: 'bank' },
      ...docs.map((d) => ({ code: d.cuenta, accountId: `id-${d.cuenta}`, debit: null, credit: d.importe, description: d.documento, documento: d })),
    ],
    control: Object.entries(kinds).map(([code, kind]) => ({
      code, name: code, kind, residual: '0', detalle: '0', documentos: 0, cubierto: true,
    })),
  } satisfies Pick<OpeningPlan, 'lines' | 'control'>;
}

const CTX: OpeningBillsContext = { payableRoleCode: '201-001', functionalCurrency: 'MXN', existing: [] };
const rules = (r: OpeningBillsPlan) => r.findings.map((f) => f.regla);
const bill = (p: Partial<ExistingBill>): ExistingBill => ({
  id: 'bill-1', vendor_invoice_number: 'F-77', vendor_name: 'Papelera del Centro', vendor_rfc: null,
  status: 'approved', amount_paid: '0.0000', from_reversed_opening: false, ...p,
});

describe('planOpeningBills', () => {
  it('each payable document becomes one payable bill; receivables and plain lines do not', () => {
    const r = planOpeningBills(
      plan(
        [
          doc({ documento: 'F-77', rfc: ' pce010101aaa ', uuid: 'U-1', currency: 'mxn' }),
          doc({ documento: 'F-88', contraparte: ' Tornillos ', vencimiento: undefined, rfc: '' }),
          doc({ cuenta: '105-001', documento: 'A-1' }),
        ],
        { '201-001': 'cxp', '105-001': 'cxc' }
      ),
      CTX
    );
    expect(r.findings).toEqual([]);
    expect(r.drafts).toEqual([
      {
        accountCode: '201-001', vendorInvoiceNumber: 'F-77', vendorName: 'Papelera del Centro', vendorRfc: 'PCE010101AAA',
        date: '2025-12-01', dueDate: '2026-01-15', amount: '9000.0000', currency: 'MXN', cfdiUuid: 'U-1', replacesId: null,
      },
      // Without a due date the document date stands in: `due_date` is NOT NULL.
      expect.objectContaining({ vendorInvoiceNumber: 'F-88', vendorName: 'Tornillos', vendorRfc: null, dueDate: '2025-12-01', cfdiUuid: null }),
    ]);
  });

  it('with no payable document there is nothing to plan', () => {
    expect(planOpeningBills(plan([doc({ cuenta: '105-001', documento: 'A-1' })], { '105-001': 'cxc' }), CTX)).toEqual({
      drafts: [],
      findings: [],
    });
  });

  it('no cxp role at all is a warning, naming the command that sets it', () => {
    const r = planOpeningBills(plan([doc({ documento: 'F-1' })]), { ...CTX, payableRoleCode: null });
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-SIN-ROL', severidad: 'aviso', numCta: '201-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('mnemosine account role set cxp 201-001');
    expect(r.drafts).toHaveLength(1);
  });

  it('a cxp role on ANOTHER account blocks, per account', () => {
    const r = planOpeningBills(plan([doc({ documento: 'F-1' })]), { ...CTX, payableRoleCode: '2110' });
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-OTRA-CUENTA', severidad: 'bloquea', numCta: '201-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('"2110"');
  });

  it('a debit balance against the vendor is not a bill: it blocks instead of leaving the subledger short', () => {
    const r = planOpeningBills(plan([doc({ documento: 'ANT-1', importe: '-500.00' })]), CTX);
    expect(rules(r)).toEqual(['APE-CXP-SALDO-DEUDOR']);
    expect(r.drafts).toEqual([]);
  });

  it('a foreign currency is refused, never converted', () => {
    const r = planOpeningBills(plan([doc({ documento: 'F-1', currency: 'usd' })]), CTX);
    expect(rules(r)).toEqual(['APE-CXP-MONEDA']);
    expect(r.findings[0].mensaje).toContain('USD');
  });

  it('the same folio of two DIFFERENT vendors is two bills; of the same vendor, twice, it blocks', () => {
    const two = planOpeningBills(
      plan([doc({ documento: '100' }), doc({ documento: '100', contraparte: 'Tornillos' })]),
      CTX
    );
    expect(two.findings).toEqual([]);
    expect(two.drafts).toHaveLength(2);

    const repeated = planOpeningBills(plan([doc({ documento: '100' }), doc({ documento: '100' })]), CTX);
    expect(rules(repeated)).toEqual(['APE-CXP-FOLIO-TOMADO']);
    expect(repeated.drafts).toHaveLength(1);
  });

  it('a vendor folio already registered as a live bill of the same vendor blocks: the liability would count twice', () => {
    expect(rules(planOpeningBills(plan([doc({ documento: 'F-77' })]), { ...CTX, existing: [bill({})] }))).toEqual([
      'APE-CXP-FOLIO-TOMADO',
    ]);
    // Matched by RFC when both carry one, whatever the name says.
    const byRfc = bill({ vendor_name: 'Otra razón social', vendor_rfc: 'pce010101aaa ' });
    expect(
      rules(planOpeningBills(plan([doc({ documento: 'F-77', rfc: 'PCE010101AAA' })]), { ...CTX, existing: [byRfc] }))
    ).toEqual(['APE-CXP-FOLIO-TOMADO']);
    // Same folio of another vendor: not a duplicate.
    const other = bill({ vendor_name: 'Tornillos', vendor_rfc: 'TOR010101AAA' });
    expect(planOpeningBills(plan([doc({ documento: 'F-77', rfc: 'PCE010101AAA' })]), { ...CTX, existing: [other] }).findings).toEqual([]);
    expect(planOpeningBills(plan([doc({ documento: 'F-77' })]), { ...CTX, existing: [bill({ vendor_name: 'Tornillos' })] }).findings).toEqual([]);
  });

  it('the untouched bill of a REVERSED opening is taken over on reload (087); a paid or moved one is not', () => {
    const stale = bill({ from_reversed_opening: true });
    const r = planOpeningBills(plan([doc({ documento: 'F-77' })]), { ...CTX, existing: [stale] });
    expect(r.findings).toEqual([]);
    expect(r.drafts[0].replacesId).toBe('bill-1');

    for (const touched of [bill({ from_reversed_opening: true, amount_paid: '10.0000' }), bill({ from_reversed_opening: true, status: 'paid' })]) {
      expect(rules(planOpeningBills(plan([doc({ documento: 'F-77' })]), { ...CTX, existing: [touched] }))).toEqual([
        'APE-CXP-FOLIO-TOMADO',
      ]);
    }
  });
});

describe('payablesSkippedUnderDraftMode', () => {
  it('writes nothing under borrador and says how many payable documents stay out', () => {
    const r = payablesSkippedUnderDraftMode(plan([doc({ documento: 'F-1' }), doc({ documento: 'F-2' })]));
    expect(r.drafts).toEqual([]);
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-BORRADOR', severidad: 'aviso', numCta: '201-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('2 documento(s) de proveedores');
  });

  it('with no payable document there is nothing to say', () => {
    expect(payablesSkippedUnderDraftMode(plan([]))).toEqual({ drafts: [], findings: [] });
  });
});

describe('prepareOpeningBills', () => {
  beforeEach(() => mockQuery.mockReset());

  it('queries nothing when the opening carries no payable document', async () => {
    expect(await prepareOpeningBills('ent-1', plan([]))).toEqual({ drafts: [], findings: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads the default cxp role, the functional currency and the folios already registered, scoped to the entity', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ code: '2110' }] })
      .mockResolvedValueOnce({ rows: [{ functional_currency: 'MXN' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await prepareOpeningBills('ent-1', plan([doc({ documento: 'F-1' })]));
    expect(rules(r)).toEqual(['APE-CXP-OTRA-CUENTA']);
    expect(mockQuery.mock.calls[0][0]).toMatch(/r\.role = 'cxp' AND r\.qualifier IS NULL/);
    expect(mockQuery.mock.calls[2][0]).toMatch(/v\.entity_id = b\.entity_id/);
    expect(mockQuery.mock.calls[2][1]).toEqual(['ent-1', ['F-1']]);
    for (const call of mockQuery.mock.calls) expect((call[1] as unknown[])[0]).toBe('ent-1');
  });

  it('no role row and no entity row fall back to "no role" and pesos', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await prepareOpeningBills('ent-1', plan([doc({ documento: 'F-1' })]));
    expect(rules(r)).toEqual(['APE-CXP-SIN-ROL']);
    expect(r.drafts[0].currency).toBe('MXN');
  });
});

describe('writeOpeningBills', () => {
  const draft = (p: Partial<OpeningBillDraft>): OpeningBillDraft => ({
    accountCode: '201-001', vendorInvoiceNumber: 'F-77', vendorName: 'Papelera del Centro', vendorRfc: null,
    date: '2025-12-01', dueDate: '2026-01-15', amount: '9000.0000', currency: 'MXN', cfdiUuid: null, replacesId: null,
    ...p,
  });
  const client = { query: vi.fn() };
  beforeEach(() => client.query.mockReset());
  const sqls = () => client.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));

  it('creates the vendor once, by RFC, and links each approved bill to the opening entry with a BILL folio', async () => {
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM vendors/.test(text)) return { rows: [] };
      if (/COUNT/.test(text)) return { rows: [{ n: '2' }] };
      if (/INSERT INTO vendors/.test(text)) return { rows: [{ id: 'ven-1' }] };
      if (/entity_sequences/.test(text)) return { rows: [{ value: '7' }] };
      return { rows: [], rowCount: 1 };
    });
    const n = await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-1', [
      draft({ vendorInvoiceNumber: 'F-77', vendorRfc: 'PCE010101AAA' }),
      draft({ vendorInvoiceNumber: 'F-78', vendorRfc: 'PCE010101AAA', cfdiUuid: 'U-1' }),
    ]);
    expect(n).toBe(2);
    expect(sqls().filter((s) => s.startsWith('INSERT INTO vendors'))).toHaveLength(1);
    expect(client.query.mock.calls[0][0]).toMatch(/UPPER\(tax_id\)/);
    const vendor = client.query.mock.calls[2][1] as unknown[];
    expect(vendor).toEqual(['ent-1', expect.stringMatching(/^V-\d{4}-0*3$/), 'Papelera del Centro', 'PCE010101AAA', 'rfc', 'MXN', 'user-1']);
    // The BILL series is drawn from the document's year, inside the transaction.
    const sequence = client.query.mock.calls.find((c) => /entity_sequences/.test(String(c[0])));
    expect(sequence?.[1]).toEqual(['ent-1', 'bill_2025']);
    const bills = client.query.mock.calls.filter((c) => /INSERT INTO bills/.test(String(c[0])));
    expect(bills).toHaveLength(2);
    expect(bills[0][0]).toMatch(/'approved', \$11, NOW\(\)/);
    expect(bills[1][1]).toEqual(['ven-1', '9000.0000', 'MXN', '2025-12-01', '2026-01-15', 'U-1', 'je-1', 'ent-1',
      'BILL-2025-00007', 'F-78', 'user-1', 'Open at the opening balance · 201-001']);
  });

  it('an existing vendor is found by name when there is no RFC', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ id: 'ven-9' }] })
      .mockResolvedValueOnce({ rows: [{ value: '1' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-1', [draft({})]);
    expect(client.query.mock.calls[0][0]).toMatch(/LOWER\(company_name\)/);
    expect(client.query.mock.calls[0][1]).toEqual(['ent-1', 'Papelera del Centro']);
    expect(sqls().some((s) => s.startsWith('INSERT INTO vendors'))).toBe(false);
    expect((client.query.mock.calls[2][1] as unknown[])[0]).toBe('ven-9');
  });

  it('takes over the bill of a reversed opening with a guarded UPDATE, and refuses if it changed', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: 'ven-9' }] }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', [draft({ replacesId: 'bill-1' })]);
    const update = sqls()[1];
    expect(update).toMatch(/^UPDATE bills/);
    expect(update).toContain("WHERE id = $9 AND entity_id = $8 AND status = 'approved' AND amount_paid = 0");
    expect(client.query.mock.calls[1][1]).toEqual(['ven-9', '9000.0000', 'MXN', '2025-12-01', '2026-01-15', null, 'je-2', 'ent-1', 'bill-1']);
    expect(sqls().some((s) => /entity_sequences/.test(s))).toBe(false);

    client.query.mockReset();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'ven-9' }] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', [draft({ replacesId: 'bill-1' })])
    ).rejects.toThrow(expect.objectContaining({ name: 'ConflictError' }));
  });
});
