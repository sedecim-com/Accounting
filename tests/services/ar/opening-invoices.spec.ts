import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import Decimal from 'decimal.js';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  ivaInsideOpenBalance,
  openingReceivableIvaPolicy,
  parseIvaRate,
  planOpeningInvoices,
  prepareOpeningInvoices,
  skippedUnderDraftMode,
  writeOpeningInvoices,
  type OpeningInvoiceDraft,
  type OpeningInvoicesContext,
  type OpeningInvoicesPlan,
} from '../../../src/services/ar/opening-invoices.js';
import type { OpeningDocument, OpeningPlan } from '../../../src/services/accounting/opening-balance.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;

// ============================================================
// MNE-001-022 · the receivable documents of the opening become invoices
// ============================================================

const doc = (p: Partial<OpeningDocument> & Pick<OpeningDocument, 'documento'>): OpeningDocument => ({
  cuenta: '105-001',
  contraparte: 'Aceros del Norte SA',
  fecha: '2025-11-02',
  vencimiento: '2025-12-02',
  importe: '4000.00',
  // MNE-001-946: a receivable says its rate; the cases about a missing one take it off.
  ivaRate: '0',
  ...p,
});

function plan(docs: OpeningDocument[], kinds: Record<string, 'cxc' | 'cxp'> = { '105-001': 'cxc' }) {
  return {
    lines: [
      { code: '102-001', accountId: 'a', debit: '1.0000', credit: null, description: 'bank' },
      ...docs.map((d) => ({ code: d.cuenta, accountId: `id-${d.cuenta}`, debit: d.importe, credit: null, description: d.documento, documento: d })),
    ],
    control: Object.entries(kinds).map(([code, kind]) => ({
      code, name: code, kind, residual: '0', detalle: '0', documentos: 0, cubierto: true,
    })),
  } satisfies Pick<OpeningPlan, 'lines' | 'control'>;
}

const CTX: OpeningInvoicesContext = {
  receivableRoleCode: '105-001', pendingIvaCode: '209-001', cashBasisIva: true, ivaPolicy: 'require_rate',
  functionalCurrency: 'MXN', existing: [],
};
/** What a 4,000.00 balance at 0 % carries: all base, no IVA. */
const ZERO_RATE = { subtotal: '4000.0000', tax: '0.0000', taxRatePct: '0.00', factorType: 'tasa' };
const rules = (r: OpeningInvoicesPlan) => r.findings.map((f) => f.regla);

describe('planOpeningInvoices', () => {
  it('each receivable document becomes one collectable invoice; payables and plain lines do not', () => {
    const r = planOpeningInvoices(
      plan(
        [
          doc({ documento: 'A-123', rfc: ' ano010101aaa ', uuid: 'U-1', currency: 'mxn' }),
          doc({ documento: 'A-456', vencimiento: undefined, rfc: '' }),
          doc({ cuenta: '201-001', documento: 'F-77' }),
        ],
        { '105-001': 'cxc', '201-001': 'cxp' }
      ),
      CTX
    );
    expect(r.findings).toEqual([]);
    expect(r.drafts).toEqual([
      {
        accountCode: '105-001', accountId: 'id-105-001', number: 'A-123', customerName: 'Aceros del Norte SA',
        customerRfc: 'ANO010101AAA', date: '2025-11-02', dueDate: '2025-12-02', amount: '4000.0000', iva: ZERO_RATE,
        currency: 'MXN', cfdiUuid: 'U-1', replacesId: null,
      },
      // Without a due date the document date stands in: `due_date` is NOT NULL.
      expect.objectContaining({ number: 'A-456', customerRfc: null, dueDate: '2025-11-02', cfdiUuid: null }),
    ]);
  });

  it('with no receivable document there is nothing to plan', () => {
    expect(planOpeningInvoices(plan([doc({ cuenta: '201-001', documento: 'F-1' })], { '201-001': 'cxp' }), CTX)).toEqual({
      drafts: [],
      findings: [],
    });
  });

  it('no cxc role at all is a warning, naming the command that sets it', () => {
    const r = planOpeningInvoices(plan([doc({ documento: 'A-1' })]), { ...CTX, receivableRoleCode: null });
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXC-SIN-ROL', severidad: 'aviso', numCta: '105-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('mnemosine account role set cxc 105-001');
    expect(r.drafts).toHaveLength(1);
  });

  it('a cxc role on ANOTHER account blocks, per account', () => {
    const r = planOpeningInvoices(plan([doc({ documento: 'A-1' })]), { ...CTX, receivableRoleCode: '1120' });
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXC-OTRA-CUENTA', severidad: 'bloquea', numCta: '105-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('"1120"');
  });

  it('a credit balance is not an invoice: it blocks instead of leaving the subledger short', () => {
    const r = planOpeningInvoices(plan([doc({ documento: 'NC-1', importe: '-500.00' })]), CTX);
    expect(rules(r)).toEqual(['APE-CXC-SALDO-A-FAVOR']);
    expect(r.drafts).toEqual([]);
  });

  it('a foreign currency is refused, never converted', () => {
    const r = planOpeningInvoices(plan([doc({ documento: 'A-1', currency: 'usd' })]), CTX);
    expect(rules(r)).toEqual(['APE-CXC-MONEDA']);
    expect(r.findings[0].mensaje).toContain('USD');
  });

  it('a folio repeated across accounts, or already taken by a live invoice, blocks', () => {
    const repeated = planOpeningInvoices(
      plan([doc({ documento: 'A-1' }), doc({ cuenta: '105-002', documento: 'A-1' })], { '105-001': 'cxc', '105-002': 'cxc' }),
      { ...CTX, receivableRoleCode: null }
    );
    expect(rules(repeated)).toEqual(['APE-CXC-SIN-ROL', 'APE-CXC-FOLIO-TOMADO']);

    const live = { id: 'inv-1', invoice_number: 'A-1', status: 'sent', amount_paid: '0', from_reversed_opening: false };
    expect(rules(planOpeningInvoices(plan([doc({ documento: 'A-1' })]), { ...CTX, existing: [live] }))).toEqual([
      'APE-CXC-FOLIO-TOMADO',
    ]);
    // Of a reversed opening, but already collected: not taken over either.
    const paid = { ...live, from_reversed_opening: true, amount_paid: '10.0000' };
    expect(rules(planOpeningInvoices(plan([doc({ documento: 'A-1' })]), { ...CTX, existing: [paid] }))).toEqual([
      'APE-CXC-FOLIO-TOMADO',
    ]);
    const voided = { ...live, from_reversed_opening: true, status: 'void' };
    expect(rules(planOpeningInvoices(plan([doc({ documento: 'A-1' })]), { ...CTX, existing: [voided] }))).toEqual([
      'APE-CXC-FOLIO-TOMADO',
    ]);
  });

  it('the untouched invoice of a REVERSED opening is taken over on reload (087)', () => {
    const stale = { id: 'inv-1', invoice_number: 'A-1', status: 'sent', amount_paid: '0.0000', from_reversed_opening: true };
    const r = planOpeningInvoices(plan([doc({ documento: 'A-1' })]), { ...CTX, existing: [stale] });
    expect(r.findings).toEqual([]);
    expect(r.drafts[0].replacesId).toBe('inv-1');
  });
});

describe('skippedUnderDraftMode', () => {
  it('writes nothing under borrador and says how many receivable documents stay out', () => {
    const r = skippedUnderDraftMode(plan([doc({ documento: 'A-1' }), doc({ documento: 'A-2' })]));
    expect(r.drafts).toEqual([]);
    expect(r.findings).toEqual([
      expect.objectContaining({ regla: 'APE-CXC-BORRADOR', severidad: 'aviso', numCta: '105-001' }),
    ]);
    expect(r.findings[0].mensaje).toContain('2 documento(s)');
  });

  it('with no receivable document there is nothing to say', () => {
    expect(skippedUnderDraftMode(plan([]))).toEqual({ drafts: [], findings: [] });
  });
});

describe('prepareOpeningInvoices', () => {
  beforeEach(() => mockQuery.mockReset());

  it('queries nothing when the opening carries no receivable document', async () => {
    expect(await prepareOpeningInvoices('ent-1', plan([]))).toEqual({ drafts: [], findings: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads both role accounts in ONE query, the entity and the folios already taken, scoped to the entity', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'iva_trasladado_no_cobrado', code: '209-001' }, { role: 'cxc', code: '1120' }] })
      .mockResolvedValueOnce({ rows: [{ functional_currency: 'MXN', incorporation_country: 'MX', accounting_standard: 'mx_nif' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await prepareOpeningInvoices('ent-1', plan([doc({ documento: 'A-1' })]));
    expect(rules(r)).toEqual(['APE-CXC-OTRA-CUENTA']);
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[0][0]).toMatch(/qualifier IS NULL/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['ent-1', ['cxc', 'iva_trasladado_no_cobrado']]);
    expect(mockQuery.mock.calls[2][1]).toEqual(['ent-1', ['A-1']]);
    for (const call of mockQuery.mock.calls) expect((call[1] as unknown[])[0]).toBe('ent-1');
  });

  it('hands the answer of the key, the pending-IVA account and the books of the entity to the plan (MNE-001-946)', async () => {
    const answers = (country: string, standard: string) => mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'cxc', code: '105-001' }, { role: 'iva_trasladado_no_cobrado', code: '209-001' }] })
      .mockResolvedValueOnce({ rows: [{ functional_currency: 'MXN', incorporation_country: country, accounting_standard: standard }] })
      .mockResolvedValueOnce({ rows: [] });
    const noRate = plan([doc({ documento: 'A-1', ivaRate: undefined })]);
    answers('MX', 'mx_nif');
    expect(rules(await prepareOpeningInvoices('ent-1', noRate))).toEqual(['APE-CXC-SIN-TASA']);
    answers('MX', 'mx_nif');
    expect(rules(await prepareOpeningInvoices('ent-1', noRate, 'assume_zero_rate'))).toEqual(['APE-CXC-TASA-SUPUESTA']);
    // Off Mexican books there is no cash-basis IVA: the rate is not asked for.
    answers('US', 'us_gaap');
    const foreign = await prepareOpeningInvoices('ent-1', noRate);
    expect(foreign.findings).toEqual([]);
    expect(foreign.drafts[0].iva).toBeNull();
    // 116,000.00 at 16 % carries 16,000.00, and this opening parks none on 209-001.
    answers('MX', 'mx_nif');
    const short = await prepareOpeningInvoices('ent-1', plan([doc({ documento: 'A-1', importe: '116000.00', ivaRate: '0.16' })]));
    expect(short.findings).toEqual([expect.objectContaining({ regla: 'APE-CXC-IVA-SIN-SALDO', numCta: '209-001' })]);
  });

  it('no role row and no entity row fall back to "no role" and pesos', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await prepareOpeningInvoices('ent-1', plan([doc({ documento: 'A-1' })]));
    expect(rules(r)).toEqual(['APE-CXC-SIN-ROL']);
    expect(r.drafts[0].currency).toBe('MXN');
  });
});

describe('writeOpeningInvoices', () => {
  const draft = (p: Partial<OpeningInvoiceDraft>): OpeningInvoiceDraft => ({
    accountCode: '105-001', accountId: 'acc-105', number: 'A-1', customerName: 'Aceros del Norte SA', customerRfc: null,
    date: '2025-11-02', dueDate: '2025-12-02', amount: '4000.0000', iva: ZERO_RATE as OpeningInvoiceDraft['iva'],
    currency: 'MXN', cfdiUuid: null, replacesId: null,
    ...p,
  });
  const client = { query: vi.fn() };
  beforeEach(() => client.query.mockReset());
  const sqls = () => client.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));

  it('a generic RFC identifies nobody: two public-at-large customers under XAXX010101000 are two customers, by name', async () => {
    let created = 0;
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM customers/.test(text)) return { rows: [] };
      if (/COUNT/.test(text)) return { rows: [{ n: '0' }] };
      if (/INSERT INTO customers/.test(text)) return { rows: [{ id: `cust-${++created}` }] };
      return { rows: [{ id: 'inv-new' }], rowCount: 1 };
    });
    await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-1', [
      draft({ number: 'A-1', customerName: 'Mostrador Norte', customerRfc: 'XAXX010101000' }),
      draft({ number: 'A-2', customerName: 'Mostrador Sur', customerRfc: 'XAXX010101000' }),
    ]);
    const lookups = client.query.mock.calls.filter((c) => /^SELECT id FROM customers/.test(String(c[0])));
    expect(lookups.map((c) => c[1] as unknown)).toEqual([['ent-1', 'Mostrador Norte'], ['ent-1', 'Mostrador Sur']]);
    expect(String(lookups[0][0])).toMatch(/LOWER\(company_name\)/);
    const invoices = client.query.mock.calls.filter((c) => /INSERT INTO invoices/.test(String(c[0])));
    expect(invoices.map((c) => (c[1] as unknown[])[0])).toEqual(['cust-1', 'cust-2']);
    expect(sqls().filter((s) => s.startsWith('INSERT INTO customers'))).toHaveLength(2);
  });

  it('creates the customer once, by RFC, and links each invoice to the opening entry', async () => {
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM customers/.test(text)) return { rows: [] };
      if (/COUNT/.test(text)) return { rows: [{ n: '3' }] };
      if (/INSERT INTO customers/.test(text)) return { rows: [{ id: 'cust-1' }] };
      return { rows: [{ id: 'inv-new' }], rowCount: 1 };
    });
    const n = await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-1', [
      draft({ number: 'A-1', customerRfc: 'ANO010101AAA' }),
      draft({ number: 'A-2', customerRfc: 'ANO010101AAA' }),
    ]);
    expect(n).toBe(2);
    expect(sqls().filter((s) => s.startsWith('INSERT INTO customers'))).toHaveLength(1);
    expect(client.query.mock.calls[0][0]).toMatch(/UPPER\(tax_id\)/);
    const cust = client.query.mock.calls[2][1] as unknown[];
    expect(cust.slice(0, 6)).toEqual(['ent-1', expect.stringMatching(/^C-\d{4}-0*4$/), 'Aceros del Norte SA', 'ANO010101AAA', 'rfc', 'MXN']);
    const invoices = client.query.mock.calls.filter((c) => /INSERT INTO invoices/.test(String(c[0])));
    expect(invoices).toHaveLength(2);
    expect(invoices[0][0]).toMatch(/'sent'/);
    expect(invoices[0][1]).toEqual(['cust-1', '4000.0000', 'MXN', '2025-11-02', '2025-12-02', null, 'je-1', 'ent-1',
      '4000.0000', '0.0000', 'A-1', 'Open at the opening balance · 105-001', 'user-1']);
  });

  it('an existing customer is found by name when there is no RFC', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: 'cust-9' }] }).mockResolvedValue({ rows: [{ id: 'inv-new' }], rowCount: 1 });
    await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-1', [draft({})]);
    expect(client.query.mock.calls[0][0]).toMatch(/LOWER\(company_name\)/);
    expect(client.query.mock.calls[0][1]).toEqual(['ent-1', 'Aceros del Norte SA']);
    expect(sqls().some((s) => s.startsWith('INSERT INTO customers'))).toBe(false);
    expect((client.query.mock.calls[1][1] as unknown[])[0]).toBe('cust-9');
  });

  it('takes over the invoice of a reversed opening with a guarded UPDATE, and refuses if it changed', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: 'cust-9' }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-2', [draft({ replacesId: 'inv-1' })]);
    const update = sqls()[1];
    expect(update).toMatch(/^UPDATE invoices/);
    expect(update).toContain('subtotal = $9, tax_amount = $10, total_amount = $2, amount_due = $2');
    expect(update).toContain("WHERE id = $11 AND entity_id = $8 AND status = 'sent' AND amount_paid = 0");
    expect(client.query.mock.calls[1][1]).toEqual(['cust-9', '4000.0000', 'MXN', '2025-11-02', '2025-12-02', null, 'je-2', 'ent-1',
      '4000.0000', '0.0000', 'inv-1']);
    // MNE-001-946: the line it had goes, scoped to the entity, before the new one is written.
    expect(sqls()[2]).toMatch(/^DELETE FROM invoice_lines il USING invoices i WHERE i\.id = il\.invoice_id AND i\.entity_id = \$1/);
    expect(client.query.mock.calls[2][1]).toEqual(['ent-1', ['inv-1']]);
    expect(sqls()[3]).toMatch(/^INSERT INTO invoice_lines/);

    client.query.mockReset();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'cust-9' }] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-2', [draft({ replacesId: 'inv-1' })])
    ).rejects.toThrow(expect.objectContaining({ name: 'ConflictError' }));
  });

  it('MNE-001-946: the header carries base and IVA, and ALL the lines go in one statement, scoped to the entity', async () => {
    let n = 0;
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM customers/.test(text)) return { rows: [{ id: 'cust-1' }] };
      return { rows: /INSERT INTO invoices/.test(text) ? [{ id: `inv-${++n}` }] : [], rowCount: 1 };
    });
    const calls = (pattern: RegExp) => client.query.mock.calls.filter((c) => pattern.test(String(c[0])));
    await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-1', [
      draft({ number: 'A-123', amount: '116000.0000', iva: { subtotal: '100000.0000', tax: '16000.0000', taxRatePct: '16.00', factorType: 'tasa' } }),
      draft({ number: 'A-456', iva: { subtotal: '4000.0000', tax: '0.0000', taxRatePct: null, factorType: 'exento' } }),
      // Off Mexican books: the open balance with no tax, and no line.
      draft({ number: 'A-789', iva: null }),
    ]);
    const invoices = calls(/INSERT INTO invoices/);
    expect(String(invoices[0][0]).replace(/\s+/g, ' ')).toContain("VALUES ($1, $9, $10, $2, $2, $3, $4, $5, $6, $7, $8, $11, 'sent', $12, $13) RETURNING id");
    expect(invoices.map((c) => (c[1] as unknown[]).slice(8, 10))).toEqual([
      ['100000.0000', '16000.0000'], ['4000.0000', '0.0000'], ['4000.0000', '0.0000'],
    ]);
    const lines = calls(/INSERT INTO invoice_lines/);
    expect(lines).toHaveLength(1);
    expect(String(lines[0][0])).toMatch(/JOIN invoices i ON i\.id = t\.invoice_id AND i\.entity_id = \$1/);
    expect(lines[0][1]).toEqual([
      'ent-1',
      ['inv-1', 'inv-2'],
      ['Open at the opening balance · A-123', 'Open at the opening balance · A-456'],
      ['acc-105', 'acc-105'],
      [null, 'exento'],
      ['16.00', null],
      ['100000.0000', '4000.0000'],
      ['16000.0000', '0.0000'],
      ['116000.0000', '4000.0000'],
    ]);
    expect(calls(/DELETE FROM invoice_lines/)).toHaveLength(0);
  });
});

// ============================================================
// MNE-001-946 · the IVA inside the open balance of a receivable
// ============================================================

describe('the IVA rate of an open document (one reader for receivables and payables)', () => {
  it('reads the TasaOCuota or "exento", and refuses anything else', () => {
    expect(parseIvaRate(undefined)).toEqual({ kind: 'missing' });
    expect(parseIvaRate('  ')).toEqual({ kind: 'missing' });
    expect(parseIvaRate(' Exento ')).toEqual({ kind: 'exempt' });
    expect(parseIvaRate('0.160000')).toMatchObject({ kind: 'rate' });
    // A percent is not a TasaOCuota: 16 would be 1,600 %.
    for (const bad of ['16', '1', 'dieciseis', '-0.16', '0,16']) expect(parseIvaRate(bad)).toEqual({ kind: 'invalid' });
  });

  it('the base is the balance over (1 + rate) to the cent, and the IVA is the rest', () => {
    const at = (amount: string, rate: string) => {
      const parsed = parseIvaRate(rate);
      if (parsed.kind === 'missing' || parsed.kind === 'invalid') throw new Error(`unexpected ${parsed.kind}`);
      return ivaInsideOpenBalance(new Decimal(amount), parsed);
    };
    // 116,000 / 1.16 = 100,000.
    expect(at('116000.00', '0.16')).toEqual({ subtotal: '100000.0000', tax: '16000.0000', taxRatePct: '16.00', factorType: 'tasa' });
    // 108 / 1.08 = 100.
    expect(at('108.00', '0.08')).toEqual({ subtotal: '100.0000', tax: '8.0000', taxRatePct: '8.00', factorType: 'tasa' });
    // 4,000 / 1.16 = 3,448.2758…: the base rounds to 3,448.28 and the IVA takes the cent, 551.72.
    expect(at('4000.00', '0.16')).toEqual({ subtotal: '3448.2800', tax: '551.7200', taxRatePct: '16.00', factorType: 'tasa' });
    expect(at('4000.00', '0')).toEqual(ZERO_RATE);
    expect(at('4000.00', 'exento')).toEqual({ subtotal: '4000.0000', tax: '0.0000', taxRatePct: null, factorType: 'exento' });
  });

  it('opening_receivable_iva: require_rate unless the key says exactly assume_zero_rate', () => {
    expect(openingReceivableIvaPolicy('assume_zero_rate')).toBe('assume_zero_rate');
    for (const v of ['require_rate', 'ASSUME_ZERO_RATE', '', null, undefined]) expect(openingReceivableIvaPolicy(v)).toBe('require_rate');
  });
});

describe('planOpeningInvoices · the IVA of each receivable document (MNE-001-946)', () => {
  /** The opening line of the pending-IVA account, credit-normal. */
  const withPending = (docs: OpeningDocument[], credit: string | null, debit: string | null = null) => {
    const p = plan(docs);
    return { ...p, lines: [...p.lines, { code: '209-001', accountId: 'id-209', debit, credit, description: 'pending IVA' }] };
  };
  const A123 = doc({ documento: 'A-123', importe: '116000.00', ivaRate: '0.16' });

  it('the case: 116,000.00 at 16 % with 16,000.00 parked is 100,000.00 + 16,000.00 and nothing stops it', () => {
    const r = planOpeningInvoices(withPending([A123], '16000.0000'), CTX);
    expect(r.findings).toEqual([]);
    expect(r.drafts).toEqual([
      expect.objectContaining({
        number: 'A-123', accountId: 'id-105-001', amount: '116000.0000',
        iva: { subtotal: '100000.0000', tax: '16000.0000', taxRatePct: '16.00', factorType: 'tasa' },
      }),
    ]);
  });

  it('without a rate, the key decides: require_rate blocks naming each document, assume_zero_rate loads at 0 % and warns', () => {
    const docs = [doc({ documento: 'A-1', ivaRate: undefined }), doc({ documento: 'A-2', ivaRate: ' ' }), doc({ documento: 'A-3', ivaRate: 'exento' })];
    const required = planOpeningInvoices(plan(docs), CTX);
    expect(required.findings).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-SIN-TASA', severidad: 'bloquea', numCta: '105-001',
        messageKey: { key: 'migration.opening.receivable_rate_missing', params: { document: 'A-1', counterparty: 'Aceros del Norte SA' } },
      }),
      expect.objectContaining({
        regla: 'APE-CXC-SIN-TASA',
        messageKey: { key: 'migration.opening.receivable_rate_missing', params: { document: 'A-2', counterparty: 'Aceros del Norte SA' } },
      }),
    ]);
    expect(required.drafts.map((x) => x.number)).toEqual(['A-3']);

    const assumed = planOpeningInvoices(plan(docs), { ...CTX, ivaPolicy: 'assume_zero_rate' });
    expect(assumed.findings).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-TASA-SUPUESTA', severidad: 'aviso', numCta: '105-001',
        messageKey: { key: 'migration.opening.receivable_rate_assumed', params: { count: 2, documents: 'A-1, A-2' } },
      }),
    ]);
    expect(assumed.drafts.map((x) => x.iva)).toEqual([ZERO_RATE, ZERO_RATE, expect.objectContaining({ factorType: 'exento', taxRatePct: null })]);
  });

  it('a rate that is not a TasaOCuota blocks under either answer', () => {
    for (const ivaPolicy of ['require_rate', 'assume_zero_rate'] as const) {
      const r = planOpeningInvoices(plan([doc({ documento: 'A-1', ivaRate: '16' })]), { ...CTX, ivaPolicy });
      expect(r.findings).toEqual([
        expect.objectContaining({
          regla: 'APE-CXC-TASA-INVALIDA', severidad: 'bloquea',
          messageKey: { key: 'migration.opening.receivable_rate_invalid', params: { document: 'A-1', rate: '16' } },
        }),
      ]);
      expect(r.drafts).toEqual([]);
    }
  });

  it('IVA the opening does not park blocks, naming the account and both figures; a debit on it counts against', () => {
    const parked = (credit: string | null, debit: string | null = null) =>
      planOpeningInvoices(withPending([A123], credit, debit), CTX).findings;
    expect(parked('15999.9900')).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-IVA-SIN-SALDO', severidad: 'bloquea', numCta: '209-001',
        messageKey: {
          key: 'migration.opening.receivable_iva_not_parked',
          params: { tax: '16000.00', parked: '15999.99', account: '209-001', role: 'iva_trasladado_no_cobrado' },
        },
      }),
    ]);
    // The account against its nature holds nothing to release: -500.00.
    expect(parked(null, '500.0000')[0].messageKey?.params).toMatchObject({ parked: '-500.00' });
    expect(parked('16000.0000')).toEqual([]);
    // More parked than the documents carry is the firm's other uncollected IVA: fine.
    expect(parked('20000.0000')).toEqual([]);
  });

  it('with no account under the pending-IVA role, the block names the role instead', () => {
    const r = planOpeningInvoices(withPending([A123], '16000.0000'), { ...CTX, pendingIvaCode: null });
    expect(r.findings).toEqual([
      expect.objectContaining({
        regla: 'APE-CXC-IVA-SIN-SALDO', numCta: '105-001',
        messageKey: { key: 'migration.opening.receivable_iva_no_role', params: { tax: '16000.00', role: 'iva_trasladado_no_cobrado' } },
      }),
    ]);
    // Documents at 0 % or exempt carry no IVA, so nothing has to be parked anywhere.
    const untaxed = plan([doc({ documento: 'A-1' }), doc({ documento: 'A-2', ivaRate: 'exento' })]);
    expect(planOpeningInvoices(untaxed, { ...CTX, pendingIvaCode: null }).findings).toEqual([]);
  });

  it('off Mexican books nothing changes: no rate is asked for or read, and no line is planned', () => {
    const r = planOpeningInvoices(
      plan([doc({ documento: 'A-1', ivaRate: undefined }), doc({ documento: 'A-2', ivaRate: '0.16' }), doc({ documento: 'A-3', ivaRate: 'sixteen' })]),
      { ...CTX, cashBasisIva: false, pendingIvaCode: null }
    );
    expect(r.findings).toEqual([]);
    expect(r.drafts.map((x) => [x.amount, x.iva])).toEqual([['4000.0000', null], ['4000.0000', null], ['4000.0000', null]]);
  });
});
