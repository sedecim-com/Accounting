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
}

let state: FakeState;
let escrituras: Array<{ sql: string; params: unknown[] }>;

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    const p = params ?? [];
    if (/^(UPDATE|INSERT|DELETE)/.test(sql)) escrituras.push({ sql, params: p });

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
  state = { country: 'MX', standard: 'mx_nif', cfdiMetodo: {}, invoices: {}, parked: {}, bankGl: null };
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
      USER
    );

    expect(entry.id).toBe('je-1');
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
    const { ivaPorFactura } = await postReceiptApplicationEntry(fakeClient(), payment(), [aplicacion()], USER);

    expect(ivaPorFactura.get('inv-1')).toBe('20.0000');
  });

  it('nada aparcado ⇒ sólo el traspaso del crédito, sin líneas de IVA', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.parked = { 'inv-1': '0' };
    const { ivaPorFactura } = await postReceiptApplicationEntry(fakeClient(), payment(), [aplicacion()], USER);

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
      USER
    );

    expect(ivaPorFactura.size).toBe(0);
    expect(lines()).toHaveLength(2);
  });

  it('fuera de México no hay reclasificación que hacer', async () => {
    state.country = 'US';
    state.standard = 'us_gaap';
    state.parked = { 'inv-1': '160.0000' };
    const { ivaPorFactura } = await postReceiptApplicationEntry(fakeClient(), payment(), [aplicacion()], USER);

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
      { invoiceNumber: 'INV-001', amount: '580.0000', ivaReclass: '80.0000', ivaEstimado: '55.0000' },
      USER
    );

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
      { invoiceNumber: 'INV-001', amount: '580.0000', ivaReclass: null, ivaEstimado: '80.0000' },
      USER
    );

    expect(lineFor('acct:iva_trasladado')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_trasladado')!.description).toMatch(/pre-049: pro-rata estimate/);
  });

  it('sin IVA que devolver, la desaplicación es sólo el crédito', async () => {
    await postReceiptUnapplicationEntry(
      fakeClient(),
      payment(),
      { invoiceNumber: 'INV-001', amount: '580.0000', ivaReclass: '0', ivaEstimado: '0' },
      USER
    );

    expect(lines()).toHaveLength(2);
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
