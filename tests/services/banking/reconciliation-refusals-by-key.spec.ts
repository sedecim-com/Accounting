/**
 * MNE-001-825 (#151), I9 by folder, part 2c, part 1: the refusals of the
 * reconciliation adjustments (`reconciliation-adjustments.ts`) and of the
 * arithmetic (`reconciliation-math.ts`) that reached the requester in Spanish
 * prose are catalogue keys now. Each site is driven here with synthetic ids: it
 * throws its class, its code, its key and params, and the English `message`;
 * `localized('es')` is, byte for byte, what the site printed before, written by
 * hand from it. The draft's description and reasoning are book data and keep
 * their Spanish.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/ai/draft-service.js', () => ({ createDraft: vi.fn() }));
vi.mock('../../../src/ai/context.js', () => ({ resolveEntity: vi.fn() }));

import { query } from '../../../src/database/connection.js';
import { createDraft } from '../../../src/ai/draft-service.js';
import { resolveEntity } from '../../../src/ai/context.js';
import type { MessageParams, TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ConflictError, ValidationError } from '../../../src/utils/errors.js';
import { crearAjuste, direccionDeAjuste, lineasDelAjuste } from '../../../src/services/banking/reconciliation-adjustments.js';
import { calcularAritmetica } from '../../../src/services/banking/reconciliation-math.js';

const mockQuery = query as unknown as Mock;
const ADJUSTMENT_TYPES = 'comision, iva-comision, interes, isr-retenido, error';
const ITEM_TYPES =
  'cheque-en-circulacion, deposito-en-transito, cargo-del-banco, abono-del-banco, error-del-banco, error-de-libros';
const SES = 'ses-825';
const ITEM = 'ri-825';

/** The error a call throws or rejects with. */
async function caught(act: () => unknown): Promise<AppError> {
  try {
    await act();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('it did not throw');
}

/** The site throws `key` with `params`, keeps its class and code, and reads `english` and `spanish`. */
async function expectKeyed(
  act: () => unknown, cls: typeof ValidationError | typeof ConflictError,
  key: TranslationKey, params: MessageParams, english: string, spanish: string
): Promise<void> {
  const err = await caught(act);
  expect(err).toBeInstanceOf(cls);
  expect(err.code).toBe(cls === ValidationError ? 'VALIDATION_ERROR' : 'RESOURCE_ALREADY_EXISTS');
  expect(err.messageKey).toEqual(Object.keys(params).length > 0 ? { key, params } : { key });
  expect(err.message).toBe(english);
  expect(err.localized('es')).toBe(spanish);
}

describe('reconciliation-adjustments.ts: bank adjustment create', () => {
  const session = {
    id: SES, bank_account_id: 'ba-1', end_date: '2026-03-31', status: 'in_progress', closed_at: null,
    cuenta_de_banco: '1110', nombre_de_cuenta: 'Operating 0001',
  };
  /** One answer per read: the session, the role, and the INSERT of the row. */
  function base(over: { session?: Record<string, unknown>; role?: string | null; insert?: Error } = {}): void {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM reconciliation_sessions')) return Promise.resolve({ rows: [over.session ?? session] });
      if (sql.includes('FROM account_roles')) return Promise.resolve({ rows: over.role === null ? [] : [{ code: over.role ?? '1130' }] });
      if (sql.includes('INSERT INTO reconciliation_adjustments')) {
        return over.insert ? Promise.reject(over.insert) : Promise.resolve({ rowCount: 1 });
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  }
  const create = (type: string, amount: string, account?: string, opts: { ctx?: unknown } = {}) =>
    () => crearAjuste('E1', SES, { tipo: type as never, importe: amount, ...(account ? { cuenta: account } : {}) }, 'u1', opts as never);

  beforeEach(() => {
    mockQuery.mockReset();
    (createDraft as unknown as Mock).mockReset().mockResolvedValue({ id: 'draft-825' });
    (resolveEntity as unknown as Mock).mockReset().mockResolvedValue({ entityId: 'E1', tenantId: 'T1' });
    base();
  });

  it('the type, the amount and its sign', async () => {
    await expectKeyed(() => direccionDeAjuste('nsf' as never, '-1'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.type_unknown', { value: 'nsf', known: ADJUSTMENT_TYPES },
      `Unknown adjustment type "nsf". The accepted ones are: ${ADJUSTMENT_TYPES}.`,
      `Tipo de ajuste desconocido "nsf". Los admitidos son: ${ADJUSTMENT_TYPES}.`);
    await expectKeyed(() => direccionDeAjuste('comision', 'abc'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.amount_unreadable', { value: 'abc' },
      'Unreadable amount for the adjustment: "abc".', 'Importe ilegible para el ajuste: "abc".');
    await expectKeyed(() => direccionDeAjuste('comision', 'Infinity'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.amount_not_finite', { value: 'Infinity' },
      'Non-finite amount for the adjustment: "Infinity".', 'Importe no finito para el ajuste: "Infinity".');
    await expectKeyed(() => direccionDeAjuste('error', '0'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.amount_zero', {},
      'The amount of a reconciliation adjustment cannot be zero: a zero entry corrects no difference and the ' +
        'engine would not accept it.',
      'El importe de un ajuste de conciliación no puede ser cero: un asiento de cero no corrige ninguna ' +
        'diferencia y el motor no lo admitiría.');
    await expectKeyed(() => direccionDeAjuste('comision', '350'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.sign_contradicts_type', { type: 'comision', direction: 'out', amount: '350.00' },
      'Adjustment "comision" takes money out of the account, so its amount must be negative; got 350.00. The sign ' +
        'is NOT flipped here: if the transaction really goes the other way, it is not a "comision" (it is probably "error").',
      'El ajuste "comision" saca dinero de la cuenta, así que su importe tiene que ser negativo; llegó 350.00. El ' +
        'signo NO se voltea aquí: si de verdad el movimiento va al revés, no es un "comision" —probablemente sea "error"—.');
    await expectKeyed(() => direccionDeAjuste('interes', '-120'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.sign_contradicts_type', { type: 'interes', direction: 'in', amount: '-120.00' },
      'Adjustment "interes" puts money into the account, so its amount must be positive; got -120.00. The sign is ' +
        'NOT flipped here: if the transaction really goes the other way, it is not a "interes" (it is probably "error").',
      'El ajuste "interes" mete dinero de la cuenta, así que su importe tiene que ser positivo; llegó -120.00. El ' +
        'signo NO se voltea aquí: si de verdad el movimiento va al revés, no es un "interes" —probablemente sea "error"—.');
  });

  it('a four-decimal amount does not fit a two-decimal entry', async () => {
    // 19.7520 rounds to 19.75 at two places, so the row and its entry would disagree.
    await expectKeyed(() => lineasDelAjuste({ bancoDebita: false, magnitud: '19.7520' }, '1130', '1110', 'iva-comision', 'x'),
      ValidationError, 'error.VALIDATION_ERROR.bank_adjustment.not_postable',
      { type: 'iva-comision', amount: '19.7520', rounded: '19.75' },
      'Adjustment "iva-comision" carries 19.7520, which does not fit in a two-decimal entry: it would post 19.75 and ' +
        'the reconciliation row would still say 19.7520. It is not rounded on its own (the two figures would end up ' +
        'contradicting each other): enter the amount it is going to be posted with.',
      'El ajuste "iva-comision" trae 19.7520, que no cabe en un asiento de dos decimales: postearía 19.75 y la fila ' +
        'de la conciliación seguiría diciendo 19.7520. No se redondea por su cuenta —las dos cifras acabarían ' +
        'contradiciéndose—: captura el importe con el que se va a contabilizar.');
  });

  it('the counterparty account: a missing role, no role at all, an unmapped role', async () => {
    await expectKeyed(create('comision', '-350'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.role_missing.comision', { type: 'comision', role: 'comision_bancaria' },
      'Adjustment "comision" has no account role to resolve: "comision_bancaria" still has to be seeded. The role ' +
        '`comision_bancaria` (6310) already exists and `treasury-posting` consumes it, but this adjustment path does ' +
        'not resolve it by itself yet: until ROL_DE_AJUSTE maps it, the account is given by hand. The neighbour NOT ' +
        'to use is `gasto` (6100), where the fee mixes with everything else and can no longer be counted. Give the ' +
        'account you want to propose it with.',
      'El ajuste "comision" no tiene rol contable que resolver: falta sembrar "comision_bancaria". el rol ' +
        '`comision_bancaria` (6310) ya existe y `treasury-posting` lo consume, pero esta ruta de ajuste todavía no lo ' +
        'resuelve sola: hasta que ROL_DE_AJUSTE lo mapee, la cuenta se indica a mano. El vecino que hay que NO usar es ' +
        '`gasto` (6100), donde la comisión se mezcla con todo lo demás y deja de poder contarse. Indica la cuenta con ' +
        'la que quieres proponerlo.');
    await expectKeyed(create('interes', '120'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.role_missing.interes', { type: 'interes', role: 'producto_financiero' },
      'Adjustment "interes" has no account role to resolve: "producto_financiero" still has to be seeded. The role ' +
        '`producto_financiero` (4310) already exists and `treasury-posting` consumes it, but this adjustment path ' +
        'does not resolve it by itself yet: until ROL_DE_AJUSTE maps it, the account is given by hand. The neighbour ' +
        'NOT to use is `otros_ingresos` (4200), deliberately reserved for the remainder of a short payment. Give the ' +
        'account you want to propose it with.',
      'El ajuste "interes" no tiene rol contable que resolver: falta sembrar "producto_financiero". el rol ' +
        '`producto_financiero` (4310) ya existe y `treasury-posting` lo consume, pero esta ruta de ajuste todavía no ' +
        'lo resuelve sola: hasta que ROL_DE_AJUSTE lo mapee, la cuenta se indica a mano. El vecino que hay que NO usar ' +
        'es `otros_ingresos` (4200), reservado a propósito al remanente de un pago corto. Indica la cuenta con la que ' +
        'quieres proponerlo.');
    await expectKeyed(create('error', '-8'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.account_not_deducible', { type: 'error' },
      'Adjustment "error" has no account that can be deduced (it depends on what was recorded wrongly). Give the account.',
      'El ajuste "error" no tiene una cuenta que se pueda deducir —depende de qué se registró mal—. Indica la cuenta.');
    base({ role: null });
    await expectKeyed(create('isr-retenido', '-24'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.role_unmapped', { type: 'isr-retenido', role: 'isr_retenido_a_favor' },
      'Adjustment "isr-retenido" relies on account role "isr_retenido_a_favor", which this entity has not mapped. Map ' +
        'it with `mnemosine account role set isr_retenido_a_favor <account>` or give the account here.',
      'El ajuste "isr-retenido" se apoya en el rol contable "isr_retenido_a_favor", que esta entidad no tiene ' +
        'mapeado. Apúntalo con `mnemosine account role set isr_retenido_a_favor <cuenta>` o indica la cuenta aquí.');
  });

  it('the session, the bank GL account, the counterparty and the context', async () => {
    base({ session: { ...session, status: 'balanced' } });
    await expectKeyed(create('iva-comision', '-8'), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_adjustment.session_not_open', { session: SES, status: 'balanced' },
      `Session ${SES} is in status "balanced": it takes no new adjustments. Its figures are the summary frozen at ` +
        'close, and a later adjustment would contradict them.',
      `La sesión ${SES} está en estado "balanced": no admite ajustes nuevos. Sus cifras son el resumen congelado ` +
        'al cerrar, y un ajuste posterior las contradiría.');
    base({ session: { ...session, cuenta_de_banco: null } });
    await expectKeyed(create('iva-comision', '-8'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.bank_gl_foreign', { account: 'Operating 0001' },
      'Bank account "Operating 0001" points to a GL account that does not belong to this entity. No entry is ' +
        'proposed against it.',
      'La cuenta bancaria "Operating 0001" apunta a una cuenta de mayor que no pertenece a esta entidad. No se ' +
        'propone ningún asiento contra ella.');
    base();
    await expectKeyed(create('error', '-8', '1110'), ValidationError,
      'error.VALIDATION_ERROR.bank_adjustment.counterparty_is_bank', { account: '1110' },
      'The counterparty of the adjustment cannot be the bank account itself (1110): the entry would debit and ' +
        'credit itself and move no balance.',
      'La contrapartida del ajuste no puede ser la propia cuenta de banco (1110): el asiento se cargaría y se ' +
        'abonaría a sí mismo y no movería ningún saldo.');
    await expectKeyed(create('iva-comision', '-8', undefined, { ctx: { entityId: 'E2', tenantId: 'T1' } }),
      ValidationError, 'error.VALIDATION_ERROR.bank_adjustment.context_other_entity', { context: 'E2', entity: 'E1' },
      'The context received is of entity E2 and the adjustment is of E1. They are not crossed: the draft would end ' +
        'up in the books of another.',
      'El contexto recibido es de la entidad E2 y el ajuste es de E1. No se cruza: el borrador acabaría en los ' +
        'libros de otro.');
  });

  it('a draft whose row was not recorded names it, with the database reason as it came', async () => {
    base({ insert: new Error('insert or update violates foreign key constraint') });
    await expectKeyed(create('iva-comision', '-8'), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_adjustment.row_not_recorded',
      { draft: 'draft-825', session: SES, reason: 'insert or update violates foreign key constraint' },
      `Draft draft-825 was created but the adjustment could not be recorded in session ${SES}: insert or update ` +
        'violates foreign key constraint. Reject it in `mnemosine review` (option [r]eject) so it does not stay ' +
        'pending with no owner.',
      `El borrador draft-825 se creó pero el ajuste no pudo registrarse en la sesión ${SES}: insert or update ` +
        'violates foreign key constraint. Recházalo en `mnemosine review` (opción [r]eject) para que no quede ' +
        'pendiente sin dueño.');
  });

  it('the draft keeps its Spanish description and reasoning: they are book data (Anexo 24 Concepto)', async () => {
    await crearAjuste('E1', SES, { tipo: 'iva-comision', importe: '-8' }, 'u1');
    const draft = (createDraft as unknown as Mock).mock.calls[0][1] as { payload: { description: string }; reasoning: string };
    expect(draft.payload.description).toBe('Conciliación bancaria 2026-03-31 · Operating 0001 · iva-comision');
    expect(draft.reasoning).toMatch(/^Ajuste de conciliación bancaria \(iva-comision\) detectado en la sesión/);
  });
});

describe('reconciliation-math.ts: the arithmetic refuses what it cannot add', () => {
  const sides = { saldoBanco: '100', saldoLibros: '100' };

  it('an unreadable or non-finite amount names its field, and an item by id or position', async () => {
    await expectKeyed(() => calcularAritmetica({ ...sides, partidas: [], tolerancia: 'x' }), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciliation_math.amount_unreadable', { item: 'none', field: 'tolerancia', value: 'x' },
      'Unreadable amount in tolerancia: "x".', 'Importe ilegible en tolerancia: "x".');
    await expectKeyed(() => calcularAritmetica({ ...sides, partidas: [{ id: ITEM, tipo: 'cargo-del-banco', importe: '' }] }),
      ValidationError, 'error.VALIDATION_ERROR.bank_reconciliation_math.amount_unreadable',
      { item: ITEM, field: 'importe', value: '' },
      `Unreadable amount in item ${ITEM}.importe: "".`, `Importe ilegible en partida ${ITEM}.importe: "".`);
    await expectKeyed(() => calcularAritmetica({ ...sides, saldoLibros: 'Infinity', partidas: [] }), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciliation_math.amount_not_finite',
      { item: 'none', field: 'saldoLibros', value: 'Infinity' },
      'Non-finite amount in saldoLibros: "Infinity".', 'Importe no finito en saldoLibros: "Infinity".');
    await expectKeyed(() => calcularAritmetica({ ...sides, partidas: [{ tipo: 'abono-del-banco', importe: '-Infinity' }] }),
      ValidationError, 'error.VALIDATION_ERROR.bank_reconciliation_math.amount_not_finite',
      { item: '#1', field: 'importe', value: '-Infinity' },
      'Non-finite amount in item #1.importe: "-Infinity".', 'Importe no finito en partida #1.importe: "-Infinity".');
  });

  it('a type the 053 CHECK does not admit', async () => {
    await expectKeyed(() => calcularAritmetica({ ...sides, partidas: [{ id: ITEM, tipo: 'cheque' as never, importe: '1' }] }),
      ValidationError, 'error.VALIDATION_ERROR.bank_reconciliation_math.item_type_unknown',
      { item: ITEM, value: 'cheque', known: ITEM_TYPES },
      `Unknown reconciling item type in item ${ITEM}: "cheque". The accepted ones are: ${ITEM_TYPES}.`,
      `Tipo de partida conciliatoria desconocido en partida ${ITEM}: "cheque". Los admitidos son: ${ITEM_TYPES}.`);
  });
});
