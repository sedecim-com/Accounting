/**
 * MNE-001-825 and MNE-001-857 (#151), I9 by folder, part 2c, parts 1 and 2: the
 * refusals of the reconciliation adjustments (`reconciliation-adjustments.ts`),
 * of the arithmetic (`reconciliation-math.ts`) and, in part 2 (MNE-001-857), of
 * the reconciling items (`reconciling-items.ts`) that reached the requester in
 * Spanish prose are catalogue keys now; the `overDays` and `limite` guards of
 * the items are for a developer, in English. Each site is driven here with synthetic ids: it
 * throws its class, its code, its key and params, and the English `message`;
 * `localized('es')` is, byte for byte, what the site printed before, written by
 * hand from it. The draft's description and reasoning are book data and keep
 * their Spanish.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../../../src/ai/draft-service.js', () => ({ createDraft: vi.fn() }));
vi.mock('../../../src/ai/context.js', () => ({ resolveEntity: vi.fn() }));

import { query, withTransaction } from '../../../src/database/connection.js';
import { createDraft } from '../../../src/ai/draft-service.js';
import { resolveEntity } from '../../../src/ai/context.js';
import type { MessageParams, TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ConflictError, ValidationError } from '../../../src/utils/errors.js';
import { crearAjuste, direccionDeAjuste, lineasDelAjuste } from '../../../src/services/banking/reconciliation-adjustments.js';
import {
  asignarPartida,
  clasificarPartidas,
  listarPartidas,
  proponerPartida,
  reclasificarPartida,
} from '../../../src/services/banking/reconciling-items.js';
import { calcularAritmetica } from '../../../src/services/banking/reconciliation-math.js';
import { clienteFalso } from '../../helpers/fake-pg.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
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

describe('reconciling-items.ts (MNE-001-857): classify, reclassify, assign', () => {
  const item = {
    id: ITEM, tipo: 'cargo-del-banco', importe: '-50.0000', fecha: '2026-03-01', antiguedad_dias: 30,
    responsable: null, fecha_esperada: null, escalamiento: 'ninguno', bank_transaction_id: 'bt-1',
    journal_entry_line_id: null, notas: null, resuelta_at: null, hoy: '2026-03-31',
  };
  /** The session lock, the item read and the UPDATE, under one fake transaction. */
  function underTx(row: Record<string, unknown> = item, session = { status: 'in_progress', closed_at: null }, updated = 1) {
    const f = clienteFalso([
      { cuando: /SELECT status, to_char\(closed_at/, responde: { rows: [session] } },
      { cuando: /FROM reconciling_items ri/, responde: { rows: [row] } },
      { cuando: /UPDATE reconciling_items/, responde: { rowCount: updated } },
    ]);
    mockTx.mockReset().mockImplementation((fn: (c: unknown) => unknown) => Promise.resolve(fn(f.client)));
  }
  const closed = { status: 'balanced', closed_at: '2026-04-02' };
  const reclassify = (type: string, amount?: string) =>
    () => reclasificarPartida('E1', SES, ITEM, { tipo: type, ...(amount !== undefined ? { importe: amount } : {}) });

  it('the amount and the type of a proposed item', async () => {
    await expectKeyed(() => proponerPartida('extracto', 'x1'), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.classify_amount_unreadable', { value: 'x1' },
      'Unreadable amount when classifying the item: "x1".', 'Importe ilegible al clasificar la partida: "x1".');
    await expectKeyed(() => proponerPartida('libros', 'NaN'), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.classify_amount_not_finite', { value: 'NaN' },
      'Non-finite amount when classifying the item: "NaN".', 'Importe no finito al clasificar la partida: "NaN".');
    await expectKeyed(() => listarPartidas('E1', SES, { tipo: 'cheque' }), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.type_unknown', { value: 'cheque', known: ITEM_TYPES },
      `Unknown reconciling item type "cheque". The accepted ones are: ${ITEM_TYPES}.`,
      `Tipo de partida conciliatoria desconocido "cheque". Los admitidos son: ${ITEM_TYPES}.`);
  });

  it('the overDays and limite guards speak to a developer, in English', async () => {
    await expect(listarPartidas('E1', SES, { overDays: -1 })).rejects.toThrow(
      '`overDays` must be a non-negative whole number of days; got -1.');
    await expect(clasificarPartidas(clienteFalso([]).client, 'E1', SES, 'u1', { limite: 0 })).rejects.toThrow(
      '`limite` must be a positive integer; got 0.');
  });

  it('a session that is no longer open, with and without its closing date', async () => {
    const f = clienteFalso([{ cuando: /FROM reconciliation_sessions/, responde: { rows: [{ id: SES, ...closed }] } }]);
    await expectKeyed(() => clasificarPartidas(f.client, 'E1', SES, 'u1'), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.classify_session_not_open',
      { session: SES, status: 'balanced', closedAt: '2026-04-02' },
      `Session ${SES} is in status "balanced" and closed on 2026-04-02: it takes no new items. Its figures are the ` +
        'summary frozen at close; to classify again it has to be reopened.',
      `La sesión ${SES} está en estado "balanced" y cerrada el 2026-04-02: no admite partidas nuevas. Sus cifras ` +
        'son el resumen congelado al cerrar; para volver a clasificar hay que reabrirla.');
    underTx(item, { status: 'approved', closed_at: null });
    await expectKeyed(reclassify('error-de-libros'), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.session_not_open',
      { session: SES, status: 'approved', closedAt: 'none' },
      `Session ${SES} is in status "approved": its items are no longer touched. Its figures are the summary frozen ` +
        'at close, and moving an item afterwards would contradict them without anyone having reopened anything.',
      `La sesión ${SES} está en estado "approved": sus partidas ya no se tocan. Sus cifras son el resumen congelado ` +
        'al cerrar, y mover una partida después las contradiría sin que nadie haya reabierto nada.');
  });

  it('bank reconciling-item correct', async () => {
    underTx({ ...item, resuelta_at: '2026-03-20' });
    await expectKeyed(reclassify('error-de-libros'), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.already_resolved', { item: ITEM },
      `Item ${ITEM} is already resolved: it stopped explaining a difference, and reclassifying it would change a ` +
        'closed history.',
      `La partida ${ITEM} ya está resuelta: dejó de explicar una diferencia y reclasificarla cambiaría una historia ` +
        'cerrada.');
    underTx();
    await expectKeyed(reclassify('error-del-banco'), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.side_change_needs_amount',
      { item: ITEM, type: 'cargo-del-banco', side: 'libros', newType: 'error-del-banco', newSide: 'banco', amount: '-50.00' },
      `Moving item ${ITEM} from "cargo-del-banco" (side libros) to "error-del-banco" (side banco) changes which of ` +
        'the two balances it corrects, and its contribution of -50.00 would stop meaning the same. Give the new ' +
        'amount, SIGNED by its contribution to the banco side.',
      `Pasar la partida ${ITEM} de "cargo-del-banco" (lado libros) a "error-del-banco" (lado banco) cambia a cuál ` +
        'de los dos saldos corrige, y su aportación de -50.00 dejaría de significar lo mismo. Indica el importe ' +
        'nuevo, FIRMADO por su aportación al lado de banco.');
    await expectKeyed(reclassify('error-de-libros', 'abc'), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.reclassify_amount_unreadable', { value: 'abc' },
      'Unreadable amount when reclassifying: "abc".', 'Importe ilegible al reclasificar: "abc".');
    await expectKeyed(reclassify('error-de-libros', '0'), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.reclassify_amount_zero', { value: '0' },
      'The amount of an item cannot be zero or unreadable; got "0". An item that contributes zero explains no ' +
        'difference: resolve it instead of leaving it at zero.',
      'El importe de una partida no puede ser cero ni ilegible; llegó "0". Una partida que aporta cero no explica ' +
        'ninguna diferencia: resuélvela en vez de dejarla en cero.');
    underTx(item, undefined, 0);
    await expectKeyed(reclassify('error-de-libros'), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.reclassify_race', { item: ITEM },
      `Item ${ITEM} was not reclassified: either its session is no longer in progress, or the item was resolved ` +
        'meanwhile. Nothing was changed.',
      `No se reclasificó la partida ${ITEM}: o su sesión ya no está en curso, o la partida se resolvió mientras ` +
        'tanto. Nada se cambió.');
  });

  it('bank reconciling-item assign refuses before its transaction', async () => {
    const assign = (s: Record<string, unknown>) => () => asignarPartida('E1', SES, ITEM, s);
    await expectKeyed(assign({ fechaEsperada: '31/03/2026' }), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.expected_date_format', { value: '31/03/2026' },
      '`fechaEsperada` must come as YYYY-MM-DD; got "31/03/2026".',
      '`fechaEsperada` tiene que venir como YYYY-MM-DD; llegó "31/03/2026".');
    await expectKeyed(assign({ escalamiento: 'vencido' }), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.overdue_by_hand', {},
      '"vencido" is not set by hand: the expected date against today decides it. If the item is already overdue, ' +
        'adjust its `fechaEsperada`; if it was only chased, mark it "avisado".',
      '"vencido" no se marca a mano: lo decide la fecha esperada contra el día de hoy. Si la partida ya venció, ' +
        'ajusta su `fechaEsperada`; si sólo se persiguió, márcala "avisado".');
    await expectKeyed(assign({ escalamiento: 'urgente' }), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.escalation_unknown', { value: 'urgente', known: 'ninguno, avisado' },
      'Unknown escalation "urgente". Accepted here: ninguno, avisado.',
      'Escalamiento desconocido "urgente". Admitidos aquí: ninguno, avisado.');
    await expectKeyed(assign({}), ValidationError,
      'error.VALIDATION_ERROR.bank_reconciling_item.nothing_to_assign', {},
      'Nothing to assign was given: responsable, fechaEsperada, escalamiento or notas.',
      'No se indicó nada que asignar: responsable, fechaEsperada, escalamiento o notas.');
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
