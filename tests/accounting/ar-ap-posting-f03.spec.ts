import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
}));

import type pg from 'pg';
import {
  postCreditNoteEntry,
  postReceiptApplicationEntry,
  postReceiptUnapplicationEntry,
  postCustomerPaymentEntry,
  type AplicacionPosterior,
} from '../../src/services/accounting/ar-ap-posting.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';

const mockCreate = createJournalEntry as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'e0000000-0000-0000-0000-000000000001';
const USER = 'u0000000-0000-0000-0000-000000000001';
/** MNE-001-460: the day an application or an unapply is dated, never the process clock. */
const EVENT_DAY = '2026-05-20';

// ============================================================
// F03 · LOS ASIENTOS QUE LA FASE ESTRENA
//
// La nota de crédito, la aplicación posterior y su desaplicación son los
// tres asientos nuevos de F03, y los tres deciden lo mismo: EN QUÉ CUENTA
// de IVA cae el movimiento. Esa decisión no se puede leer del código sin
// ejecutarlo —depende del MetodoPago del documento ligado y de cuánto IVA
// sigue aparcado—, así que se prueba aquí, con un cliente falso que
// responde por FORMA de SQL y devuelve las cuentas como `acct:<rol>`:
// afirmar sobre un account_id es afirmar sobre el ROL que el motor eligió.
//
// El espejo de la casa: estas rutas ya existían sin prueba unitaria y la
// cobertura por archivo de ar-ap-posting.ts —96 %— las reclamaba.
// ============================================================

interface FakeState {
  country: string;
  standard: string;
  /** metodo_pago que el CFDI ingerido declara, por cfdi_uuid. */
  cfdiMetodo: Record<string, string | null>;
  /** Facturas que `SELECT ... FROM invoices WHERE id = $1` encuentra. */
  invoices: Record<string, Record<string, unknown>>;
  /** IVA que cada documento tiene TODAVÍA aparcado, por id. */
  parked: Record<string, string>;
  /** gl_account_id de la cuenta bancaria ligada, si la hay. */
  bankGl: string | null;
  /** Rows the credit note's guarded write finds: 1 on the real path. */
  noteRows: number;
  /** MNE-001-462: what the receipt's live allocations applied, when a test says so. */
  applied?: string;
}

let state: FakeState;
let escrituras: Array<{ sql: string; params: unknown[] }>;

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    const p = params ?? [];
    if (/^(UPDATE|INSERT|DELETE)/.test(sql)) escrituras.push({ sql, params: p });

    // The collection's two guarded UPDATEs (invariant 3) find their one row.
    if (/^UPDATE (customer_payments|payment_allocations)/.test(sql.trim())) return { rows: [], rowCount: 1 };
    if (/^UPDATE credit_notes/.test(sql.trim())) return { rows: [], rowCount: state.noteRows };
    if (state.applied !== undefined && sql.includes('AS aplicado')) return { rows: [{ aplicado: state.applied }] };
    if (sql.includes('FROM legal_entities')) {
      return { rows: [{ incorporation_country: state.country, accounting_standard: state.standard }] };
    }
    if (sql.includes('FROM xml_documents WHERE cfdi_uuid')) {
      const metodo = state.cfdiMetodo[String(p[0])];
      return { rows: metodo === undefined ? [] : [{ metodo_pago: metodo }] };
    }
    if (sql.includes('FROM invoices WHERE id')) {
      const inv = state.invoices[String(p[0])];
      return { rows: inv ? [inv] : [] };
    }
    // El tope de liberación: cuánto aparcó de verdad este documento. Va
    // ANTES de account_roles porque la consulta hace JOIN con esa tabla.
    if (sql.includes('AS parked')) {
      return { rows: [{ parked: state.parked[String(p[2])] ?? '0' }] };
    }
    if (sql.includes('FROM account_roles')) {
      const roles = (p[1] ?? []) as string[];
      return { rows: roles.map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    if (sql.includes('FROM bank_accounts')) {
      return { rows: state.bankGl === null ? [] : [{ gl_account_id: state.bankGl }] };
    }
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

beforeEach(() => {
  mockCreate.mockClear();
  escrituras = [];
  state = { country: 'MX', standard: 'mx_nif', cfdiMetodo: {}, invoices: {}, parked: {}, bankGl: null, noteRows: 1 };
});

function lines(): Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }> {
  return mockCreate.mock.calls[0][4] as ReturnType<typeof lines>;
}
function entryDescription(): string {
  return mockCreate.mock.calls[0][3] as string;
}
function lineFor(accountId: string) {
  return lines().find((l) => l.account_id === accountId);
}

type NotaCredito = Parameters<typeof postCreditNoteEntry>[1];

const nota = (over: Partial<NotaCredito> = {}): NotaCredito =>
  ({
    id: 'cn-1',
    entity_id: ENTITY,
    credit_note_number: 'CN-001',
    type: 'devolucion',
    invoice_id: null,
    subtotal: '1000.0000',
    tax_amount: '160.0000',
    total_amount: '1160.0000',
    credit_date: new Date('2026-09-10'),
    journal_entry_id: null,
    ...over,
  }) as NotaCredito;

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  entity_id: ENTITY,
  payment_number: 'PMT-001',
  payment_amount: '1160.0000',
  payment_date: new Date('2026-09-10'),
  bank_account_id: null,
  journal_entry_id: null,
  ...over,
});

// ============================================================
// LA NOTA DE CRÉDITO
// ============================================================

describe('la nota de crédito deshace el IVA en la cuenta donde la factura lo dejó', () => {
  it('sin factura ligada asume PUE y lo DICE en la línea', async () => {
    const entry = await postCreditNoteEntry(fakeClient(), nota(), USER);

    expect(entry).not.toBeNull();
    expect(lineFor('acct:devolucion_ventas')!.debit_amount).toBe('1000.0000');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('1160.0000');
    const iva = lineFor('acct:iva_trasladado');
    expect(iva!.debit_amount).toBe('160.0000');
    expect(iva!.description).toMatch(/no linked invoice: PUE assumed/);
    expect(lineFor('acct:iva_trasladado_no_cobrado')).toBeUndefined();
  });

  it('sobre factura PPD el IVA vuelve del aparcado, no del causado', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.invoices = {
      'inv-9': { id: 'inv-9', invoice_number: 'INV-009', cfdi_uuid: 'UUID-PPD', terms: null, memo: null },
    };
    await postCreditNoteEntry(fakeClient(), nota({ invoice_id: 'inv-9' }), USER);

    const iva = lineFor('acct:iva_trasladado_no_cobrado');
    expect(iva!.debit_amount).toBe('160.0000');
    expect(iva!.description).toMatch(/IVA reversed/);
    expect(lineFor('acct:iva_trasladado')).toBeUndefined();
  });

  it('sobre factura PUE el IVA vuelve de la cuenta causada', async () => {
    state.cfdiMetodo = { 'UUID-PUE': 'PUE' };
    state.invoices = {
      'inv-8': { id: 'inv-8', invoice_number: 'INV-008', cfdi_uuid: 'UUID-PUE', terms: null, memo: null },
    };
    await postCreditNoteEntry(fakeClient(), nota({ invoice_id: 'inv-8' }), USER);

    expect(lineFor('acct:iva_trasladado')!.debit_amount).toBe('160.0000');
    expect(lineFor('acct:iva_trasladado_no_cobrado')).toBeUndefined();
  });

  it('fuera de México no consulta el MetodoPago: el IVA sale de la cuenta única', async () => {
    state.country = 'US';
    state.standard = 'us_gaap';
    await postCreditNoteEntry(fakeClient(), nota({ invoice_id: 'inv-8' }), USER);

    expect(lineFor('acct:iva_trasladado')!.debit_amount).toBe('160.0000');
  });

  it('una nota sin IVA no inventa la línea', async () => {
    await postCreditNoteEntry(
      fakeClient(),
      nota({ subtotal: '1000.0000', tax_amount: '0.0000', total_amount: '1000.0000' }),
      USER
    );

    expect(lines()).toHaveLength(2);
    expect(lineFor('acct:iva_trasladado')).toBeUndefined();
  });

  it('sella el asiento en la nota, que es lo que la vuelve idempotente', async () => {
    await postCreditNoteEntry(fakeClient(), nota(), USER);

    expect(escrituras.some((e) => /UPDATE credit_notes SET journal_entry_id/.test(e.sql))).toBe(true);
  });

  // MNE-001-515: applying an advance moves it out of the liability, not out
  // of revenue. The type of the note says which fact happened.
  it('an anticipo note on a PUE invoice debits the advance, not sales returns', async () => {
    state.cfdiMetodo = { 'UUID-PUE': 'PUE' };
    state.invoices = {
      'inv-8': { id: 'inv-8', invoice_number: 'INV-008', cfdi_uuid: 'UUID-PUE', terms: null, memo: null },
    };
    await postCreditNoteEntry(fakeClient(), nota({ type: 'anticipo', invoice_id: 'inv-8' }), USER);

    expect(lineFor('acct:anticipo_clientes')!.debit_amount).toBe('1000.0000');
    expect(lineFor('acct:iva_trasladado')!.debit_amount).toBe('160.0000');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('1160.0000');
    expect(lineFor('acct:devolucion_ventas')).toBeUndefined();
  });

  it('an anticipo note on a PPD invoice takes its IVA back from the parked account', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.invoices = {
      'inv-9': { id: 'inv-9', invoice_number: 'INV-009', cfdi_uuid: 'UUID-PPD', terms: null, memo: null },
    };
    await postCreditNoteEntry(fakeClient(), nota({ type: 'anticipo', invoice_id: 'inv-9' }), USER);

    expect(lineFor('acct:anticipo_clientes')!.debit_amount).toBe('1000.0000');
    expect(lineFor('acct:iva_trasladado_no_cobrado')!.debit_amount).toBe('160.0000');
    expect(lineFor('acct:iva_trasladado')).toBeUndefined();
  });

  it('an anticipo note with no IVA posts two lines', async () => {
    await postCreditNoteEntry(
      fakeClient(),
      nota({ type: 'anticipo', tax_amount: '0.0000', total_amount: '1000.0000' }),
      USER
    );

    expect(lines()).toHaveLength(2);
    expect(lineFor('acct:anticipo_clientes')!.debit_amount).toBe('1000.0000');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('1000.0000');
  });

  it.each(['devolucion', 'descuento', 'correccion'])('a %s note still debits sales returns', async (type) => {
    await postCreditNoteEntry(fakeClient(), nota({ type }), USER);

    expect(lineFor('acct:devolucion_ventas')!.debit_amount).toBe('1000.0000');
    expect(lineFor('acct:anticipo_clientes')).toBeUndefined();
  });

  it('links the entry only to a note of the entity that has none, and a write of no row throws', async () => {
    await postCreditNoteEntry(fakeClient(), nota(), USER);
    const write = escrituras.find((e) => /UPDATE credit_notes SET journal_entry_id/.test(e.sql))!;
    expect(write.sql).toMatch(/WHERE id = \$2 AND entity_id = \$3 AND journal_entry_id IS NULL/);
    expect(write.params).toEqual(['je-1', 'cn-1', ENTITY]);

    state.noteRows = 0;
    await expect(postCreditNoteEntry(fakeClient(), nota(), USER)).rejects.toThrow(/CN-001/);
  });

  it('una nota ya posteada, o de importe cero, no vuelve a postear', async () => {
    expect(await postCreditNoteEntry(fakeClient(), nota({ journal_entry_id: 'je-viejo' }), USER)).toBeNull();
    expect(await postCreditNoteEntry(fakeClient(), nota({ total_amount: '0.0000' }), USER)).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ============================================================
// APLICAR SALDO A CUENTA
// ============================================================

const aplicacion = (over: Partial<AplicacionPosterior> = {}): AplicacionPosterior => ({
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-001',
  amount: '580.0000',
  priorApplied: '0',
  taxAmount: '160.0000',
  totalAmount: '1160.0000',
  cfdiUuid: 'UUID-PPD',
  terms: null,
  memo: null,
  ...over,
});

describe('aplicar saldo a cuenta mueve el crédito, no el efectivo', () => {
  it('DR anticipo_clientes · CR cxc, y ninguna línea toca el banco', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '160.0000' };
    const { entry, ivaPorFactura } = await postReceiptApplicationEntry(
      fakeClient(),
      payment(),
      [aplicacion()],
      USER,
      EVENT_DAY
    );

    expect(entry.id).toBe('je-1');
    // MNE-001-460: dated the day of the application, not the run.
    expect(mockCreate.mock.calls[0][1]).toBe(EVENT_DAY);
    expect(lineFor('acct:anticipo_clientes')!.debit_amount).toBe('580.0000');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('580.0000');
    expect(lineFor('acct:banco')).toBeUndefined();
    // Medio total aplicado ⇒ medio IVA liberado, y devuelto para que el
    // llamador lo persista en la fila de aplicación.
    expect(ivaPorFactura.get('inv-1')).toBe('80.0000');
    expect(lineFor('acct:iva_trasladado_no_cobrado')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_trasladado')!.credit_amount).toBe('80.0000');
    expect(entryDescription()).toMatch(/IVA caused on collection: INV-001/);
  });

  it('el aparcado real es el tope: no se libera IVA que la factura nunca aparcó', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '20.0000' };
    const { ivaPorFactura } = await postReceiptApplicationEntry(fakeClient(), payment(), [aplicacion()], USER, EVENT_DAY);

    expect(ivaPorFactura.get('inv-1')).toBe('20.0000');
  });

  it('nada aparcado ⇒ sólo el traspaso del crédito, sin líneas de IVA', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '0' };
    const { ivaPorFactura } = await postReceiptApplicationEntry(fakeClient(), payment(), [aplicacion()], USER, EVENT_DAY);

    expect(ivaPorFactura.size).toBe(0);
    expect(lines()).toHaveLength(2);
    expect(entryDescription()).toBe('Application of PMT-001');
  });

  it('una factura PUE no libera nada: su IVA se causó al emitirla', async () => {
    state.cfdiMetodo = { 'UUID-PUE': 'PUE' };
    state.parked = { 'inv-1': '160.0000' };
    const { ivaPorFactura } = await postReceiptApplicationEntry(
      fakeClient(),
      payment(),
      [aplicacion({ cfdiUuid: 'UUID-PUE' })],
      USER,
      EVENT_DAY
    );

    expect(ivaPorFactura.size).toBe(0);
    expect(lines()).toHaveLength(2);
  });

  it('fuera de México no hay reclasificación que hacer', async () => {
    state.country = 'US';
    state.standard = 'us_gaap';
    state.parked = { 'inv-1': '160.0000' };
    const { ivaPorFactura } = await postReceiptApplicationEntry(fakeClient(), payment(), [aplicacion()], USER, EVENT_DAY);

    expect(ivaPorFactura.size).toBe(0);
    expect(lines()).toHaveLength(2);
  });
});

// ============================================================
// DESAPLICAR
// ============================================================

describe('desaplicar re-aparca el IVA que aquella aplicación liberó', () => {
  it('DR cxc · CR anticipo_clientes, y el IVA vuelve al aparcado por el importe GUARDADO', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(),
      payment(),
      { invoiceNumber: 'INV-001', amount: '580.0000', ivaReclass: '80.0000', ivaEstimado: '55.0000', date: EVENT_DAY },
      USER
    );

    expect(mockCreate.mock.calls[0][1]).toBe(EVENT_DAY);
    expect(lineFor('acct:cxc')!.debit_amount).toBe('580.0000');
    expect(lineFor('acct:anticipo_clientes')!.credit_amount).toBe('580.0000');
    expect(lineFor('acct:iva_trasladado')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_trasladado_no_cobrado')!.credit_amount).toBe('80.0000');
    // Importe guardado: el asiento NO se disculpa.
    expect(lineFor('acct:iva_trasladado')!.description).not.toMatch(/pro-rata/);
  });

  it('una fila anterior a la 049 no guardó su IVA: se estima y el asiento lo confiesa', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(),
      payment(),
      { invoiceNumber: 'INV-001', amount: '580.0000', ivaReclass: null, ivaEstimado: '80.0000', date: EVENT_DAY },
      USER
    );

    expect(lineFor('acct:iva_trasladado')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_trasladado')!.description).toMatch(/pre-049: pro-rata estimate/);
  });

  it('sin IVA que devolver, la desaplicación es sólo el crédito', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(),
      payment(),
      { invoiceNumber: 'INV-001', amount: '580.0000', ivaReclass: '0', ivaEstimado: '0', date: EVENT_DAY },
      USER
    );

    expect(lines()).toHaveLength(2);
  });
});

// ============================================================
// MNE-001-422 · AN ADVANCE APPLIED TO A PUE INVOICE
// ============================================================

describe('an advance applied to a PUE invoice cancels the IVA it caused', () => {
  it('DR 2150 the base, DR 2120 the IVA / CR 1120 the cash, and no release', async () => {
    state.cfdiMetodo = { 'UUID-PUE': 'PUE' };
    const { ivaPorFactura: released } = await postReceiptApplicationEntry(
      fakeClient(), payment(),
      [aplicacion({ amount: '1160.0000', taxAmount: '800.0000', totalAmount: '5800.0000', cfdiUuid: 'UUID-PUE', advanceIva: '160.0000' })],
      USER, EVENT_DAY
    );
    expect(released.size).toBe(0);
    expect(lines().map((l) => [l.account_id, l.debit_amount, l.credit_amount])).toEqual([
      ['acct:anticipo_clientes', '1000.0000', null],
      ['acct:cxc', null, '1160.0000'],
      ['acct:iva_trasladado', '160.0000', null],
    ]);
    expect(entryDescription()).toBe('Application of PMT-001');
  });

  it('cancelled on an invoice its month also caused, the line and the entry say which month', async () => {
    state.cfdiMetodo = { 'UUID-PUE': 'PUE' };
    await postReceiptApplicationEntry(
      fakeClient(), payment(),
      [aplicacion({ cfdiUuid: 'UUID-PUE', advanceIva: '80.0000', advanceIvaTwiceIn: '2026-04' })],
      USER, EVENT_DAY
    );
    expect(lineFor('acct:iva_trasladado')!.description).toMatch(/2026-04 also caused it/);
    expect(entryDescription()).toMatch(/advance IVA caused twice in 2026-04/);
  });

  it('the unapply credits back exactly what the allocation stored: CR 2150 the base, CR 2120 the IVA', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(), payment(),
      { invoiceNumber: 'INV-001', amount: '1160.0000', ivaReclass: '0.0000', ivaEstimado: '0', advanceIva: '160.0000', date: EVENT_DAY },
      USER
    );
    expect(lines().map((l) => [l.account_id, l.debit_amount, l.credit_amount])).toEqual([
      ['acct:cxc', '1160.0000', null],
      ['acct:anticipo_clientes', null, '1000.0000'],
      ['acct:iva_trasladado', null, '160.0000'],
    ]);
  });
});

// ============================================================
// MNE-001-461 · AN ADVANCE APPLIED TO A PPD INVOICE
// ============================================================

describe('an advance applied to a PPD invoice nets its IVA against the share the invoice releases', () => {
  const ppd = (over: Partial<AplicacionPosterior> = {}) =>
    aplicacion({ amount: '1160.0000', taxAmount: '800.0000', totalAmount: '5800.0000', advanceIva: '160.0000', ...over });
  const shape = () => lines().map((l) => [l.account_id, l.debit_amount, l.credit_amount]);

  it('g = c: DR 2150 a − c, DR 2125 g / CR 1120 a, and no 2120 line', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '800.0000' };
    const { ivaPorFactura: released } = await postReceiptApplicationEntry(fakeClient(), payment(), [ppd()], USER, EVENT_DAY);
    // 800 × 1,160 / 5,800 = 160.0000 leaves 2125, and the advance's own 160.00 takes its place in 2120.
    expect(released.get('inv-1')).toBe('160.0000');
    expect(shape()).toEqual([
      ['acct:anticipo_clientes', '1000.0000', null],
      ['acct:cxc', null, '1160.0000'],
      ['acct:iva_trasladado_no_cobrado', '160.0000', null],
    ]);
  });

  it('g > c: the rest of the share is caused, CR 2120 g − c', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '800.0000' };
    // An advance of 1,080.00 at 8 % on a sale at 16 %: 800 × 1,080 / 5,800 = 148.9655 against 80.00.
    await postReceiptApplicationEntry(
      fakeClient(), payment(), [ppd({ amount: '1080.0000', advanceIva: '80.0000' })], USER, EVENT_DAY
    );
    expect(shape()).toEqual([
      ['acct:anticipo_clientes', '1000.0000', null],
      ['acct:cxc', null, '1080.0000'],
      ['acct:iva_trasladado_no_cobrado', '148.9655', null],
      ['acct:iva_trasladado', null, '68.9655'],
    ]);
  });

  it('g < c: the rest of the advance\'s IVA is cancelled, DR 2120 c − g', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    // Only 100.00 is still parked, the cap of what leaves 2125.
    state.parked = { 'inv-1': '100.0000' };
    await postReceiptApplicationEntry(fakeClient(), payment(), [ppd()], USER, EVENT_DAY);
    expect(shape()).toEqual([
      ['acct:anticipo_clientes', '1000.0000', null],
      ['acct:cxc', null, '1160.0000'],
      ['acct:iva_trasladado_no_cobrado', '100.0000', null],
      ['acct:iva_trasladado', '60.0000', null],
    ]);
  });

  it('the unapply gives back what the row stored and re-parks nothing out of 2120: CR 2150 a − c, CR 2125 g', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(), payment(),
      { invoiceNumber: 'INV-001', amount: '1160.0000', ivaReclass: '160.0000', ivaEstimado: '160.0000', advanceIva: '160.0000', date: EVENT_DAY },
      USER
    );
    expect(shape()).toEqual([
      ['acct:cxc', '1160.0000', null],
      ['acct:anticipo_clientes', null, '1000.0000'],
      ['acct:iva_trasladado_no_cobrado', null, '160.0000'],
    ]);
  });

  it('the unapply of rows whose g and c differ moves 2120 by c − g only', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(), payment(),
      { invoiceNumber: 'INV-001', amount: '1160.0000', ivaReclass: '100.0000', ivaEstimado: '100.0000', advanceIva: '160.0000', date: EVENT_DAY },
      USER
    );
    expect(shape()).toEqual([
      ['acct:cxc', '1160.0000', null],
      ['acct:anticipo_clientes', null, '1000.0000'],
      ['acct:iva_trasladado_no_cobrado', null, '100.0000'],
      ['acct:iva_trasladado', null, '60.0000'],
    ]);
  });
});

// ============================================================
// MNE-001-462 · THE EXCESS OF A COLLECTION IS AN ADVANCE
// ============================================================

describe('the excess a collection leaves on account posts as an advance: its base to 2150, its IVA to 2120', () => {
  it('1,500.00 on 1,160.00 at 16 %: CR cxc 1,160.00, CR anticipo 293.10, CR iva_trasladado 46.90, and the entry names its source', async () => {
    state.applied = '1160.0000';
    const note = ' · excess on account is an advance at 16 %, from INV-001';
    await postCustomerPaymentEntry(fakeClient(), payment({
      payment_amount: '1500.0000', advance_base_amount: '293.10', advance_iva_amount: '46.90', advance_note: note,
    }), USER);

    expect(lineFor('acct:banco')!.debit_amount).toBe('1500.0000');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('1160.0000');
    expect(lineFor('acct:anticipo_clientes')!.credit_amount).toBe('293.1000');
    expect(lineFor('acct:iva_trasladado')!.credit_amount).toBe('46.9000');
    expect(entryDescription()).toBe(`Customer payment PMT-001${note}`);
  });

  it('a split that is not the cash left on account is refused, not posted', async () => {
    state.applied = '1160.0000';
    await expect(postCustomerPaymentEntry(fakeClient(), payment({
      payment_amount: '1500.0000', advance_base_amount: '1293.10', advance_iva_amount: '206.90',
    }), USER)).rejects.toMatchObject({ code: 'ADVANCE_SPLIT_MISMATCH' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ============================================================
// LA CUENTA DEL BANCO
// ============================================================

describe('el cobro aterriza en la cuenta contable de SU banco', () => {
  it('con cuenta bancaria ligada usa su gl_account_id, no el rol genérico', async () => {
    state.bankGl = 'acct:banco-santander';
    await postCustomerPaymentEntry(fakeClient(), payment({ bank_account_id: 'ba-1' }), USER);

    expect(lineFor('acct:banco-santander')!.debit_amount).toBe('1160.0000');
    expect(lineFor('acct:banco')).toBeUndefined();
  });

  it('cuenta bancaria sin mapeo contable cae al rol banco', async () => {
    state.bankGl = null;
    await postCustomerPaymentEntry(fakeClient(), payment({ bank_account_id: 'ba-1' }), USER);

    expect(lineFor('acct:banco')!.debit_amount).toBe('1160.0000');
  });
});

// ============================================================
// MNE-001-113 · THE CUSTOMER'S WITHHOLDING
// ============================================================

describe('the customer withholding closes the receivable on its own role accounts', () => {
  it('application: DR the two withholding roles, CR cxc for cash plus withholding, VAT caused on all of it', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '160.0000' };
    const { ivaPorFactura: released } = await postReceiptApplicationEntry(
      fakeClient(),
      payment(),
      [aplicacion({ amount: '953.3333', withholdingIsr: '100.0000', withholdingIva: '106.6667' })],
      USER,
      EVENT_DAY
    );

    expect(lineFor('acct:anticipo_clientes')!.debit_amount).toBe('953.3333');
    expect(lineFor('acct:isr_retenido_a_favor')!.debit_amount).toBe('100.0000');
    expect(lineFor('acct:iva_retenido_a_favor')!.debit_amount).toBe('106.6667');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('1160.0000');
    // The whole invoice is settled, so the whole parked VAT is caused.
    expect(released.get('inv-1')).toBe('160.0000');
  });

  it('only the tax that was withheld gets a line', async () => {
    await postReceiptApplicationEntry(
      fakeClient(),
      payment(),
      [aplicacion({ cfdiUuid: null, withholdingIsr: '0', withholdingIva: '50.0000' })],
      USER,
      EVENT_DAY
    );

    expect(lineFor('acct:isr_retenido_a_favor')).toBeUndefined();
    expect(lineFor('acct:iva_retenido_a_favor')!.debit_amount).toBe('50.0000');
    expect(lineFor('acct:cxc')!.credit_amount).toBe('630.0000');
  });

  it('unapplication: DR cxc for cash plus withholding, CR anticipo and the two withholding roles', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(),
      payment(),
      {
        invoiceNumber: 'INV-001', amount: '953.3333', ivaReclass: '0', ivaEstimado: '0',
        withholdingIsr: '100.0000', withholdingIva: '106.6667', date: EVENT_DAY,
      },
      USER
    );

    expect(lineFor('acct:cxc')!.debit_amount).toBe('1160.0000');
    expect(lineFor('acct:anticipo_clientes')!.credit_amount).toBe('953.3333');
    expect(lineFor('acct:isr_retenido_a_favor')!.credit_amount).toBe('100.0000');
    expect(lineFor('acct:iva_retenido_a_favor')!.credit_amount).toBe('106.6667');
    expect(lineFor('acct:iva_retenido_a_favor')!.description).toMatch(/unapply/);
  });
});
