import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  openingPayableIvaPolicy,
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
  ivaRate: '0',
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

const CTX: OpeningBillsContext = {
  payableRoleCode: '201-001', pendingIvaCode: null, functionalCurrency: 'MXN', ivaPolicy: 'require_rate',
  existing: [], stale: [],
};
const rules = (r: OpeningBillsPlan) => r.findings.map((f) => f.regla);
const bill = (p: Partial<ExistingBill>): ExistingBill => ({
  id: 'bill-1', vendor_invoice_number: 'F-77', vendor_name: 'Papelera del Centro', vendor_rfc: null, cfdi_uuid: null,
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
        accountCode: '201-001', accountId: 'id-201-001', vendorInvoiceNumber: 'F-77', vendorName: 'Papelera del Centro',
        vendorRfc: 'PCE010101AAA', date: '2025-12-01', dueDate: '2026-01-15', amount: '9000.0000', subtotal: '9000.0000',
        tax: '0.0000', taxRatePct: '0.00', factorType: 'tasa', currency: 'MXN', cfdiUuid: 'U-1', replacesId: null,
      },
      // Without a due date the document date stands in: `due_date` is NOT NULL.
      expect.objectContaining({ vendorInvoiceNumber: 'F-88', vendorName: 'Tornillos', vendorRfc: null, dueDate: '2025-12-01', cfdiUuid: null }),
    ]);
  });

  it('with no payable document there is nothing to plan', () => {
    expect(planOpeningBills(plan([doc({ cuenta: '105-001', documento: 'A-1' })], { '105-001': 'cxc' }), CTX)).toEqual({
      drafts: [],
      findings: [],
      voids: [],
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

  it('only the account the cxp role points at becomes bills; another payable account stays opening lines, with a warning', () => {
    const r = planOpeningBills(
      plan(
        [doc({ documento: 'F-1' }), doc({ cuenta: '205-001', documento: 'AD-1', contraparte: 'Socio' })],
        { '201-001': 'cxp', '205-001': 'cxp' }
      ),
      CTX
    );
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-FUERA-DEL-ROL', severidad: 'aviso', numCta: '205-001' }),
    ]);
    expect(r.drafts.map((d) => d.vendorInvoiceNumber)).toEqual(['F-1']);

    const elsewhere = planOpeningBills(plan([doc({ documento: 'F-1' })]), { ...CTX, payableRoleCode: '2110' });
    expect(rules(elsewhere)).toEqual(['APE-CXP-FUERA-DEL-ROL']);
    expect(elsewhere.findings[0].mensaje).toContain('"2110"');
    expect(elsewhere.drafts).toEqual([]);
  });

  it('a document with its IVA rate splits into base and pending IVA; exempt carries no IVA', () => {
    const r = planOpeningBills(
      plan([
        doc({ documento: 'F-16', importe: '11600.00', ivaRate: '0.160000' }),
        doc({ documento: 'F-8', importe: '1080.00', ivaRate: '0.08' }),
        doc({ documento: 'F-EX', importe: '500.00', ivaRate: 'Exento' }),
      ]),
      { ...CTX, pendingIvaCode: '118-001' }
    ).drafts;
    expect(r).toEqual([
      expect.objectContaining({ subtotal: '10000.0000', tax: '1600.0000', taxRatePct: '16.00', factorType: 'tasa' }),
      expect.objectContaining({ subtotal: '1000.0000', tax: '80.0000', taxRatePct: '8.00', factorType: 'tasa' }),
      expect.objectContaining({ subtotal: '500.0000', tax: '0.0000', taxRatePct: null, factorType: 'exento' }),
    ]);
  });

  it('the IVA of the bills must be parked in the opening, on the iva_pendiente_acreditar account', () => {
    const withIva = (debit: string | null) => {
      const p = plan([doc({ documento: 'F-16', importe: '11600.00', ivaRate: '0.16' })]);
      if (debit !== null) p.lines.push({ code: '118-001', accountId: 'id-118', debit, credit: null, description: 'iva' });
      return p;
    };
    const ctx = { ...CTX, pendingIvaCode: '118-001' };
    expect(planOpeningBills(withIva('1600.0000'), ctx).findings).toEqual([]);
    const short = planOpeningBills(withIva('1000.0000'), ctx);
    expect(short.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-IVA-SIN-SALDO', severidad: 'bloquea', numCta: '118-001' }),
    ]);
    expect(short.findings[0].mensaje).toContain('1600.00');
    expect(short.findings[0].mensaje).toContain('1000.00');
    const noRole = planOpeningBills(withIva(null), CTX);
    expect(noRole.findings).toEqual([expect.objectContaining({ regla: 'APE-CXP-IVA-SIN-SALDO', numCta: '201-001' })]);
    expect(noRole.findings[0].mensaje).toContain('ninguna cuenta tiene el rol "iva_pendiente_acreditar"');
  });

  it('a rate that is not a CFDI TasaOCuota is refused', () => {
    for (const ivaRate of ['16', 'abc', '-0.16']) {
      expect(rules(planOpeningBills(plan([doc({ documento: 'F-1', ivaRate })]), CTX))).toEqual(['APE-CXP-TASA-INVALIDA']);
    }
  });

  it('without a rate, opening_payable_iva decides: require_rate blocks, assume_zero_rate loads at 0 % and warns', () => {
    const missing = plan([doc({ documento: 'F-1', ivaRate: undefined }), doc({ documento: 'F-2', ivaRate: ' ' })]);
    const required = planOpeningBills(missing, CTX);
    expect(rules(required)).toEqual(['APE-CXP-SIN-TASA', 'APE-CXP-SIN-TASA']);
    expect(required.findings[0].mensaje).toContain('LIVA art. 5 fr. III');
    expect(required.drafts).toEqual([]);

    const assumed = planOpeningBills(missing, { ...CTX, ivaPolicy: 'assume_zero_rate' });
    expect(assumed.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-TASA-SUPUESTA', severidad: 'aviso', numCta: '201-001' }),
    ]);
    expect(assumed.findings[0].mensaje).toContain('F-1, F-2');
    expect(assumed.drafts.map((d) => [d.tax, d.taxRatePct])).toEqual([['0.0000', '0.00'], ['0.0000', '0.00']]);
  });

  it('openingPayableIvaPolicy falls to require_rate for anything but assume_zero_rate', () => {
    expect(openingPayableIvaPolicy('assume_zero_rate')).toBe('assume_zero_rate');
    for (const v of ['require_rate', 'otra', undefined, null]) expect(openingPayableIvaPolicy(v)).toBe('require_rate');
  });

  it('a generic RFC identifies nobody: two foreign vendors under XEXX010101000 are two vendors, told apart by name', () => {
    const r = planOpeningBills(
      plan([
        doc({ documento: '100', contraparte: 'Acme Inc', rfc: 'XEXX010101000' }),
        doc({ documento: '100', contraparte: 'Globex GmbH', rfc: 'xexx010101000' }),
      ]),
      { ...CTX, existing: [bill({ vendor_invoice_number: '100', vendor_name: 'Initech LLC', vendor_rfc: 'XEXX010101000' })] }
    );
    expect(r.findings).toEqual([]);
    expect(r.drafts.map((d) => [d.vendorName, d.vendorRfc])).toEqual([
      ['Acme Inc', 'XEXX010101000'],
      ['Globex GmbH', 'XEXX010101000'],
    ]);
  });

  it('the same folio of the same vendor, once with its RFC and once without, is one document twice', () => {
    const r = planOpeningBills(
      plan([doc({ documento: 'F-1', rfc: 'PCE010101AAA' }), doc({ documento: 'F-1' })]),
      CTX
    );
    expect(rules(r)).toEqual(['APE-CXP-FOLIO-TOMADO']);
    expect(r.drafts).toHaveLength(1);
  });

  it('a CFDI UUID already on a bill, or twice in the file, is the same liability twice', () => {
    const uuid = 'a1b2c3d4-0000-4000-8000-000000000077';
    const onBill = bill({ vendor_invoice_number: 'OTRO', cfdi_uuid: uuid.toUpperCase() });
    const r = planOpeningBills(plan([doc({ documento: 'F-1', uuid })]), { ...CTX, existing: [onBill] });
    expect(rules(r)).toEqual(['APE-CXP-FOLIO-TOMADO']);
    expect(r.findings[0].mensaje).toContain(uuid);
    // The untouched bill of a reversed opening does not count: it is taken over or voided.
    const stale = { ...onBill, from_reversed_opening: true };
    expect(planOpeningBills(plan([doc({ documento: 'F-1', uuid })]), { ...CTX, existing: [stale] }).findings).toEqual([]);
    const twice = planOpeningBills(plan([doc({ documento: 'F-1', uuid }), doc({ documento: 'F-2', uuid })]), CTX);
    expect(rules(twice)).toEqual(['APE-CXP-FOLIO-TOMADO']);
  });

  it('on reload, the untouched bills of the reversed opening that the file no longer brings are voided', () => {
    const r = planOpeningBills(
      plan([doc({ documento: 'F-77' }), doc({ documento: 'F-88', contraparte: 'Tornillos Industriales SA de CV' })]),
      {
        ...CTX,
        existing: [
          bill({ from_reversed_opening: true }),
          bill({ id: 'bill-2', vendor_invoice_number: 'F-88', vendor_name: 'Tornillos Industriales', from_reversed_opening: true }),
        ],
        stale: [
          { id: 'bill-1', vendor_invoice_number: 'F-77', vendor_name: 'Papelera del Centro' },
          { id: 'bill-2', vendor_invoice_number: 'F-88', vendor_name: 'Tornillos Industriales' },
        ],
      }
    );
    expect(r.drafts.map((d) => d.replacesId)).toEqual(['bill-1', null]);
    expect(r.voids).toEqual(['bill-2']);
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXP-ANULA-HUERFANAS', severidad: 'aviso', numCta: '201-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('F-88 de Tornillos Industriales');
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
    expect(payablesSkippedUnderDraftMode(plan([]))).toEqual({ drafts: [], findings: [], voids: [] });
  });
});

describe('prepareOpeningBills', () => {
  beforeEach(() => mockQuery.mockReset());

  it('queries nothing when the opening carries no payable document', async () => {
    expect(await prepareOpeningBills('ent-1', plan([]))).toEqual({ drafts: [], findings: [], voids: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads both roles, the functional currency, the folios and UUIDs already registered and the stale bills, scoped to the entity', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ code: '2110' }] })
      .mockResolvedValueOnce({ rows: [{ code: '118-001' }] })
      .mockResolvedValueOnce({ rows: [{ functional_currency: 'MXN' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'old', vendor_invoice_number: 'F-9', vendor_name: 'Tornillos' }] });
    const r = await prepareOpeningBills('ent-1', plan([doc({ documento: 'F-1', uuid: ' u-1 ' })]));
    expect(rules(r)).toEqual(['APE-CXP-FUERA-DEL-ROL', 'APE-CXP-ANULA-HUERFANAS']);
    expect(r.voids).toEqual(['old']);
    expect(mockQuery.mock.calls[0][0]).toMatch(/r\.role = \$2 AND r\.qualifier IS NULL/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['ent-1', 'cxp']);
    expect(mockQuery.mock.calls[1][1]).toEqual(['ent-1', 'iva_pendiente_acreditar']);
    expect(mockQuery.mock.calls[3][0]).toMatch(/v\.entity_id = b\.entity_id/);
    expect(mockQuery.mock.calls[3][1]).toEqual(['ent-1', ['F-1'], ['U-1']]);
    expect(mockQuery.mock.calls[4][0]).toMatch(/reversed_by_entry_id IS NOT NULL/);
    expect(mockQuery.mock.calls[4][0]).toMatch(/b\.status = 'approved' AND b\.amount_paid = 0/);
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
    accountCode: '201-001', accountId: 'id-201-001', vendorInvoiceNumber: 'F-77', vendorName: 'Papelera del Centro',
    vendorRfc: null, date: '2025-12-01', dueDate: '2026-01-15', amount: '9000.0000', subtotal: '9000.0000',
    tax: '0.0000', taxRatePct: '0.00', factorType: 'tasa', currency: 'MXN', cfdiUuid: null, replacesId: null,
    ...p,
  });
  const client = { query: vi.fn() };
  beforeEach(() => client.query.mockReset());
  const sqls = () => client.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));
  const calls = (re: RegExp) => client.query.mock.calls.filter((c) => re.test(String(c[0])));
  /** A database with no vendor yet: vendors are created, bills inserted. */
  const empty = () =>
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM vendors/.test(text)) return { rows: [] };
      if (/COUNT/.test(text)) return { rows: [{ n: '2' }] };
      if (/INSERT INTO vendors/.test(text)) return { rows: [{ id: `ven-${calls(/INSERT INTO vendors/).length}` }] };
      if (/entity_sequences/.test(text)) return { rows: [{ value: '7' }] };
      if (/INSERT INTO bills/.test(text)) return { rows: [{ id: 'bill-new' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

  it('creates the vendor once, by RFC, and links each approved bill, with its IVA line, to the opening entry', async () => {
    empty();
    const n = await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-1', {
      drafts: [
        draft({ vendorInvoiceNumber: 'F-77', vendorRfc: 'PCE010101AAA' }),
        draft({
          vendorInvoiceNumber: 'F-78', vendorRfc: 'PCE010101AAA', cfdiUuid: 'U-1',
          amount: '11600.0000', subtotal: '10000.0000', tax: '1600.0000', taxRatePct: '16.00',
        }),
      ],
      voids: [],
    });
    expect(n).toBe(2);
    expect(calls(/INSERT INTO vendors/)).toHaveLength(1);
    expect(client.query.mock.calls[0][0]).toMatch(/UPPER\(tax_id\)/);
    const vendor = client.query.mock.calls[2][1] as unknown[];
    expect(vendor).toEqual(['ent-1', expect.stringMatching(/^V-\d{4}-0*3$/), 'Papelera del Centro', 'PCE010101AAA', 'rfc', 'MXN', 'user-1']);
    // The BILL series is drawn from the document's year, inside the transaction.
    expect(calls(/entity_sequences/)[0][1]).toEqual(['ent-1', 'bill_2025']);
    const bills = calls(/INSERT INTO bills/);
    expect(bills).toHaveLength(2);
    expect(bills[0][0]).toMatch(/'approved', \$13, NOW\(\)/);
    expect(bills[1][1]).toEqual(['ven-1', '11600.0000', 'MXN', '2025-12-01', '2026-01-15', 'U-1', 'je-1', 'ent-1',
      '10000.0000', '1600.0000', 'BILL-2025-00007', 'F-78', 'user-1', 'Open at the opening balance · 201-001']);
    // One line per bill, with the rate the DIOT breaks the paid IVA down by.
    const lines = calls(/INSERT INTO bill_lines/);
    expect(lines).toHaveLength(2);
    expect(lines[1][1]).toEqual(['bill-new', 'id-201-001', 'Open at the opening balance · F-78', '10000.0000',
      '1600.0000', '11600.0000', '16.00', 'tasa']);
    expect(sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });

  it('a generic RFC is looked up by name: two foreign vendors are two vendors, both keeping XEXX010101000', async () => {
    empty();
    await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-1', {
      drafts: [
        draft({ vendorName: 'Acme Inc', vendorRfc: 'XEXX010101000' }),
        draft({ vendorName: 'Globex GmbH', vendorRfc: 'XEXX010101000' }),
      ],
      voids: [],
    });
    const lookups = calls(/^SELECT id FROM vendors/);
    expect(lookups.map((c) => c[1] as unknown)).toEqual([['ent-1', 'Acme Inc'], ['ent-1', 'Globex GmbH']]);
    expect(String(lookups[0][0])).toMatch(/LOWER\(company_name\)/);
    const created = calls(/INSERT INTO vendors/).map((c) => (c[1] as unknown[]).slice(2, 5));
    expect(created).toEqual([['Acme Inc', 'XEXX010101000', 'rfc'], ['Globex GmbH', 'XEXX010101000', 'rfc']]);
    expect(calls(/INSERT INTO bills/).map((c) => (c[1] as unknown[])[0])).toEqual(['ven-1', 'ven-2']);
  });

  it('an existing vendor is found by name when there is no RFC', async () => {
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM vendors/.test(text)) return { rows: [{ id: 'ven-9' }] };
      if (/entity_sequences/.test(text)) return { rows: [{ value: '1' }] };
      if (/INSERT INTO bills/.test(text)) return { rows: [{ id: 'bill-new' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-1', { drafts: [draft({})], voids: [] });
    expect(client.query.mock.calls[0][0]).toMatch(/LOWER\(company_name\)/);
    expect(client.query.mock.calls[0][1]).toEqual(['ent-1', 'Papelera del Centro']);
    expect(calls(/INSERT INTO vendors/)).toHaveLength(0);
    expect((calls(/INSERT INTO bills/)[0][1] as unknown[])[0]).toBe('ven-9');
  });

  it('takes over the bill of a reversed opening with a guarded UPDATE, replaces its line, and refuses if it changed', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: 'ven-9' }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', { drafts: [draft({ replacesId: 'bill-1' })], voids: [] });
    const update = sqls()[1];
    expect(update).toMatch(/^UPDATE bills/);
    expect(update).toContain("WHERE id = $11 AND entity_id = $8 AND status = 'approved' AND amount_paid = 0");
    expect(client.query.mock.calls[1][1]).toEqual(['ven-9', '9000.0000', 'MXN', '2025-12-01', '2026-01-15', null, 'je-2', 'ent-1',
      '9000.0000', '0.0000', 'bill-1']);
    expect(sqls()[2]).toBe('DELETE FROM bill_lines WHERE bill_id = $1');
    expect((calls(/INSERT INTO bill_lines/)[0][1] as unknown[])[0]).toBe('bill-1');
    expect(sqls().some((s) => /entity_sequences/.test(s))).toBe(false);

    client.query.mockReset();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'ven-9' }] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', { drafts: [draft({ replacesId: 'bill-1' })], voids: [] })
    ).rejects.toThrow(expect.objectContaining({ name: 'ConflictError' }));
  });

  it('voids the orphaned bills of the reversed opening with a guarded UPDATE, and refuses if one changed', async () => {
    client.query.mockResolvedValue({ rows: [], rowCount: 2 });
    expect(await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', { drafts: [], voids: ['b-1', 'b-2'] })).toBe(0);
    const update = sqls()[0];
    expect(update).toMatch(/^UPDATE bills b SET status = 'void', amount_due = 0/);
    expect(update).toContain("b.status = 'approved' AND b.amount_paid = 0");
    expect(update).toContain('je.reversed_by_entry_id IS NOT NULL');
    expect(client.query.mock.calls[0][1]).toEqual(['ent-1', ['b-1', 'b-2']]);

    client.query.mockReset();
    client.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(
      writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', { drafts: [], voids: ['b-1', 'b-2'] })
    ).rejects.toThrow(expect.objectContaining({ name: 'ConflictError' }));

    client.query.mockReset();
    await writeOpeningBills(client as never, 'ent-1', 'user-1', 'je-2', { drafts: [], voids: [] });
    expect(client.query).not.toHaveBeenCalled();
  });
});
