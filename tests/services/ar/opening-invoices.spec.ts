import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
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

const CTX: OpeningInvoicesContext = { receivableRoleCode: '105-001', functionalCurrency: 'MXN', existing: [] };
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
        accountCode: '105-001', number: 'A-123', customerName: 'Aceros del Norte SA', customerRfc: 'ANO010101AAA',
        date: '2025-11-02', dueDate: '2025-12-02', amount: '4000.0000', currency: 'MXN', cfdiUuid: 'U-1', replacesId: null,
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

  it('reads the default cxc role, the functional currency and the folios already taken, scoped to the entity', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ code: '1120' }] })
      .mockResolvedValueOnce({ rows: [{ functional_currency: 'MXN' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await prepareOpeningInvoices('ent-1', plan([doc({ documento: 'A-1' })]));
    expect(rules(r)).toEqual(['APE-CXC-OTRA-CUENTA']);
    expect(mockQuery.mock.calls[0][0]).toMatch(/qualifier IS NULL/);
    expect(mockQuery.mock.calls[2][1]).toEqual(['ent-1', ['A-1']]);
    for (const call of mockQuery.mock.calls) expect((call[1] as unknown[])[0]).toBe('ent-1');
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
    accountCode: '105-001', number: 'A-1', customerName: 'Aceros del Norte SA', customerRfc: null,
    date: '2025-11-02', dueDate: '2025-12-02', amount: '4000.0000', currency: 'MXN', cfdiUuid: null, replacesId: null,
    ...p,
  });
  const client = { query: vi.fn() };
  beforeEach(() => client.query.mockReset());
  const sqls = () => client.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));

  it('creates the customer once, by RFC, and links each invoice to the opening entry', async () => {
    client.query.mockImplementation(async (text: string) => {
      if (/^SELECT id FROM customers/.test(text)) return { rows: [] };
      if (/COUNT/.test(text)) return { rows: [{ n: '3' }] };
      if (/INSERT INTO customers/.test(text)) return { rows: [{ id: 'cust-1' }] };
      return { rows: [], rowCount: 1 };
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
    expect(invoices[0][1]).toEqual(['cust-1', '4000.0000', 'MXN', '2025-11-02', '2025-12-02', null, 'je-1', 'ent-1', 'A-1',
      'Open at the opening balance · 105-001', 'user-1']);
  });

  it('an existing customer is found by name when there is no RFC', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: 'cust-9' }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-1', [draft({})]);
    expect(client.query.mock.calls[0][0]).toMatch(/LOWER\(company_name\)/);
    expect(client.query.mock.calls[0][1]).toEqual(['ent-1', 'Aceros del Norte SA']);
    expect(sqls().some((s) => s.startsWith('INSERT INTO customers'))).toBe(false);
    expect((client.query.mock.calls[1][1] as unknown[])[0]).toBe('cust-9');
  });

  it('takes over the invoice of a reversed opening with a guarded UPDATE, and refuses if it changed', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ id: 'cust-9' }] }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-2', [draft({ replacesId: 'inv-1' })]);
    const update = sqls()[1];
    expect(update).toMatch(/^UPDATE invoices/);
    expect(update).toContain("WHERE id = $9 AND entity_id = $8 AND status = 'sent' AND amount_paid = 0");
    expect(client.query.mock.calls[1][1]).toEqual(['cust-9', '4000.0000', 'MXN', '2025-11-02', '2025-12-02', null, 'je-2', 'ent-1', 'inv-1']);

    client.query.mockReset();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'cust-9' }] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      writeOpeningInvoices(client as never, 'ent-1', 'user-1', 'je-2', [draft({ replacesId: 'inv-1' })])
    ).rejects.toThrow(expect.objectContaining({ name: 'ConflictError' }));
  });
});
