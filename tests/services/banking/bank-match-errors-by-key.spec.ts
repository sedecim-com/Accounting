/**
 * MNE-001-725 (#151), I9 by folder, part 2: the refusals of the bank match
 * (`match-service.ts`, `book-items.ts`) that reached the requester in Spanish
 * prose are catalogue keys now. The Spanish twin must print, byte for byte,
 * what each site printed before (written by hand from those sites, with
 * synthetic ids and amounts), and the English is the source the error's
 * `message` is fixed in. The `overDays` guard is for a developer, in English.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ConflictError, ValidationError } from '../../../src/utils/errors.js';
import {
  aplicarCotejos,
  cuadrarGrupo,
  desaplicarCotejo,
  exigirCuadre,
  exigirSinRepetidos,
  sellarPartidas as sealForGroup,
} from '../../../src/services/banking/match-service.js';
import { liberarPartidas, listarPartidasDeLibros, sellarPartidas } from '../../../src/services/banking/book-items.js';

const mockQuery = query as unknown as Mock;

const TX = 'a1b2c3d4-0000-4000-8000-000000000725';
const LINE = 'b2c3d4e5-0000-4000-8000-000000000725';
const GROUP = 'c3d4e5f6-0000-4000-8000-000000000725';
const SESSION = 'd4e5f6a7-0000-4000-8000-000000000725';
const MATCH = 'e5f6a7b8-0000-4000-8000-000000000725';
const ACCOUNT = 'f6a7b8c9-0000-4000-8000-000000000725';
const REASONS = 'error-de-captura, duplicado';

/** key, params, the Spanish each site printed, the English source. */
type Case = readonly [TranslationKey, MessageParams, string, string];

const CASES: readonly Case[] = [
  // match-service.ts: the residual gate
  ['error.VALIDATION_ERROR.bank_match.write_off_on_zero', {},
    'El grupo cuadra exacto (residual 0.0000): no hay nada que cancelar, así que --residual write-off sobra. ' +
      'Usa keep o quita la bandera.',
    'The group balances exactly (residual 0.0000): there is nothing to write off, so --residual write-off is ' +
      'not needed. Use keep or drop the flag.'],
  ['error.VALIDATION_ERROR.bank_match.residual_undeclared',
    { bank: '1000.0000', books: '900.0000', adjustments: '25.0000', difference: '75.0000' },
    'El grupo no cuadra y nadie declaró qué hacer con lo que sobra. Banco 1000.0000 = Libros 900.0000 + ' +
      'Ajustes 25.0000 deja una diferencia de 75.0000. Declárala con --residual keep (queda viva como partida ' +
      'conciliatoria) o --residual write-off --write-off-account <cuenta> (se cancela contra esa cuenta), o ' +
      'corrige las partidas del grupo.',
    'The group does not balance and no one declared what to do with the remainder. Bank 1000.0000 = Books ' +
      '900.0000 + Adjustments 25.0000 leaves a difference of 75.0000. Declare it with --residual keep (it stays ' +
      'alive as a reconciling item) or --residual write-off --write-off-account <account> (it is written off ' +
      'against that account), or correct the items of the group.'],
  ['error.VALIDATION_ERROR.bank_match.write_off_needs_account', { difference: '1.0000' },
    'Un residual de 1.0000 que se cancela necesita cuenta: --residual write-off exige --write-off-account. ' +
      'Sin ella el dinero se quedaría sin destino y el descuadre reaparecería en la sesión.',
    'A residual of 1.0000 that is written off needs an account: --residual write-off requires ' +
      '--write-off-account. Without it the money would have nowhere to go and the imbalance would reappear in ' +
      'the session.'],
  ['error.VALIDATION_ERROR.bank_match.write_off_account_with_keep', {},
    '--write-off-account sólo tiene sentido con --residual write-off: un residual que se conserva no se ' +
      'cancela contra ninguna cuenta.',
    '--write-off-account only makes sense with --residual write-off: a residual that is kept is not written ' +
      'off against any account.'],
  // the group's sides
  ['error.VALIDATION_ERROR.bank_match.repeated_id', { side: 'bank', id: 'b1' },
    'El movimiento de banco b1 aparece dos veces en el grupo: su importe contaría doble y el grupo cuadraría ' +
      'afirmando el doble de lo que hay.',
    'The bank transaction b1 appears twice in the group: its amount would count double and the group would ' +
      'balance by asserting twice what there is.'],
  ['error.VALIDATION_ERROR.bank_match.repeated_id', { side: 'books', id: 'l1' },
    'La partida de libros l1 aparece dos veces en el grupo: su importe contaría doble y el grupo cuadraría ' +
      'afirmando el doble de lo que hay.',
    'The book item l1 appears twice in the group: its amount would count double and the group would balance ' +
      'by asserting twice what there is.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.item_sealed_by_other_group', { id: LINE, group: GROUP },
    `La partida ${LINE} ya está sellada por el grupo de cotejo ${GROUP}. Desaplica ese cotejo antes de volver ` +
      'a cotejarla.',
    `Book item ${LINE} is already sealed by match group ${GROUP}. Unapply that match before matching it again.`],
  ['error.VALIDATION_ERROR.bank_match.session_other_account', { session: SESSION },
    `La sesión ${SESSION} concilia otra cuenta bancaria: un cotejo no puede pertenecer a la conciliación de ` +
      'una cuenta distinta de la del movimiento.',
    `Session ${SESSION} reconciles another bank account: a match cannot belong to the reconciliation of an ` +
      "account other than the transaction's."],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.session_signed_add', { session: SESSION, status: 'approved' },
    `La sesión ${SESSION} está en 'approved': añadirle cotejos ahora reescribiría una aseveración ya firmada.`,
    `Session ${SESSION} is 'approved': adding matches to it now would rewrite an assertion already signed.`],
  ['error.VALIDATION_ERROR.bank_match.preview_needs_target', {},
    'Previsualizar necesita una cuenta bancaria (--account) o un movimiento concreto.',
    'Preview needs a bank account (--account) or a specific transaction.'],
  ['error.VALIDATION_ERROR.bank_match.apply_needs_transaction', {},
    'Aplicar necesita al menos un movimiento: no hay nada que cotejar.',
    'Apply needs at least one transaction: there is nothing to match.'],
  ['error.VALIDATION_ERROR.bank_match.apply_one_account', {},
    'Todos los movimientos de un mismo `apply` tienen que ser de la misma cuenta bancaria: una sola ' +
      'transacción no puede ligarse a dos conciliaciones.',
    'All the transactions of one `apply` must be of the same bank account: one database transaction cannot ' +
      'be tied to two reconciliations.'],
  ['error.VALIDATION_ERROR.bank_match.transaction_other_account_than_group', { id: TX, account: ACCOUNT },
    `El movimiento ${TX} es de otra cuenta bancaria que la del grupo (${ACCOUNT}): un cotejo no puede quedar ` +
      'colgado de una cuenta que no es la suya.',
    `Transaction ${TX} belongs to a bank account other than the group's (${ACCOUNT}): a match cannot hang ` +
      'from an account that is not its own.'],
  ['error.VALIDATION_ERROR.bank_match.group_needs_bank', {},
    'Un grupo de cotejo necesita al menos un movimiento de banco.',
    'A match group needs at least one bank transaction.'],
  ['error.VALIDATION_ERROR.bank_match.group_needs_books', {},
    'Un grupo de cotejo necesita al menos una partida de libros.',
    'A match group needs at least one book item.'],
  ['error.VALIDATION_ERROR.bank_match.transaction_other_account', { id: TX },
    `El movimiento ${TX} pertenece a otra cuenta bancaria: un grupo de cotejo no puede cruzar dos cuentas.`,
    `Transaction ${TX} belongs to another bank account: a match group cannot span two accounts.`],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.period_closed', { id: TX, status: 'locked' },
    `El movimiento ${TX} cae en un periodo 'locked': no se cotejan movimientos de un periodo cerrado con llave.`,
    `Transaction ${TX} falls in a period that is 'locked': transactions of a locked period are not matched.`],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.period_closed', { id: TX, status: 'missing' },
    `El movimiento ${TX} cae en un periodo 'inexistente': no se cotejan movimientos de un periodo cerrado con llave.`,
    `Transaction ${TX} falls in a period that is 'nonexistent': transactions of a locked period are not matched.`],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.transaction_already_matched', { id: TX, match: MATCH },
    `El movimiento ${TX} ya tiene el cotejo vivo ${MATCH}: desaplícalo antes de meterlo en un grupo nuevo, o ` +
      'el mismo dinero quedaría cotejado dos veces.',
    `Transaction ${TX} already has the live match ${MATCH}: unapply it before putting it in a new group, or ` +
      'the same money would be matched twice.'],
  ['error.VALIDATION_ERROR.bank_match.item_entry_not_posted', { id: LINE, status: 'draft' },
    `La partida ${LINE} pertenece a un asiento en 'draft': sólo se coteja contra asientos contabilizados.`,
    `Book item ${LINE} belongs to an entry in 'draft': only posted entries are matched against.`],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.item_already_matched', { id: LINE },
    `La partida ${LINE} ya está cotejada: desaplica ese cotejo antes de incluirla en un grupo nuevo.`,
    `Book item ${LINE} is already matched: unapply that match before including it in a new group.`],
  ['error.VALIDATION_ERROR.bank_match.opposite_directions', { bank: '-500.0000', books: '500.0000' },
    'El grupo suma -500.0000 de banco contra 500.0000 de libros: los dos lados apuntan en direcciones ' +
      'opuestas, así que el grupo cotejaría una entrada de dinero contra una salida.',
    'The group adds up -500.0000 of bank against 500.0000 of books: the two sides point in opposite ' +
      'directions, so the group would match money coming in against money going out.'],
  ['error.VALIDATION_ERROR.bank_match.orphan_transaction', { id: TX },
    `El movimiento ${TX} no recibe ninguna partida de libros: los ajustes y el residual lo absorben entero, ` +
      'así que quedaría marcado como cotejado sin nada que lo explique. Sácalo del grupo o dale una partida.',
    `Transaction ${TX} receives no book item: the adjustments and the residual absorb it whole, so it would ` +
      'be marked as matched with nothing to explain it. Take it out of the group or give it an item.'],
  ['error.VALIDATION_ERROR.bank_match.orphan_item', { id: LINE },
    `La partida ${LINE} no recibe ningún movimiento de banco: los ajustes y el residual la absorben entera, ` +
      'así que quedaría sellada sin cotejo que la explique. Sácala del grupo, o mete el movimiento de banco ' +
      'que la cubre.',
    `Book item ${LINE} receives no bank transaction: the adjustments and the residual absorb it whole, so it ` +
      'would be sealed with no match to explain it. Take it out of the group, or add the bank transaction ' +
      'that covers it.'],
  // unapplying
  ['error.VALIDATION_ERROR.bank_match.unapply_reason_unknown', { reason: 'porque-si', known: REASONS },
    `Motivo de desaplicación desconocido: 'porque-si'. Los admitidos son ${REASONS}. El motivo es un código ` +
      'y no prosa libre porque las causas tienen que poder contarse, no sólo leerse.',
    `Unknown unapply reason: 'porque-si'. The accepted ones are ${REASONS}. The reason is a code and not free ` +
      'prose because causes must be countable, not only readable.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.already_unapplied', { match: MATCH },
    `El cotejo ${MATCH} ya se desaplicó: deshacer lo ya deshecho no es un acto, y su fila sigue en el ` +
      'expediente con su motivo.',
    `Match ${MATCH} was already unapplied: undoing what is already undone is not an act, and its row stays ` +
      'on file with its reason.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_match.session_signed_unapply', { session: SESSION, status: 'posted' },
    `La sesión ${SESSION} está en 'posted': deshacer un cotejo suyo reescribiría una aseveración ya firmada. ` +
      'Corrígela con una sesión nueva, no borrando ésta.',
    `Session ${SESSION} is 'posted': undoing one of its matches would rewrite an assertion already signed. ` +
      'Correct it with a new session, not by erasing this one.'],
  // book-items.ts
  ['error.VALIDATION_ERROR.bank_book_item.partial_seal', { sealed: 2, count: 3, group: 'grp-1' },
    'El sello de conciliación alcanzó 2 de 3 partida(s). Las que faltan ya estaban selladas, pertenecen a un ' +
      'asiento no contabilizado, o no son de la misma entidad que el grupo grp-1. No se sella nada a medias: ' +
      'revisa la lista con `bank book-item list` y vuelve a armar el grupo.',
    'The reconciliation seal reached 2 of 3 book item(s). The missing ones were already sealed, belong to an ' +
      'unposted entry, or are not of the same entity as group grp-1. Nothing is sealed halfway: check the list ' +
      'with `bank book-item list` and build the group again.'],
  ['error.VALIDATION_ERROR.bank_book_item.partial_release', { released: 0, count: 1 },
    'Se liberaron 0 de 1 partida(s). Las que faltan no estaban selladas, o su sello lo puso algo que no es ' +
      'un grupo de cotejo bancario de esta entidad —la certificación de cuentas usa la misma columna— y no se ' +
      'levanta desde aquí.',
    'Released 0 of 1 book item(s). The missing ones were not sealed, or their seal was set by something ' +
      'other than a bank match group of this entity (the account certification uses the same column) and it ' +
      'is not lifted from here.'],
];

const KEYS_OF_THIS_BLOCK = 27;

/** The error a call throws or rejects with, for one assertion on all of it. */
async function caught(act: () => unknown): Promise<AppError> {
  try {
    await act();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('it did not throw');
}

/** The site throws `key` with `params`, keeps its class and code, and reads both languages. */
function expectKeyed(err: AppError, cls: typeof ValidationError | typeof ConflictError, key: TranslationKey, params: MessageParams): void {
  const c = CASES.find((x) => x[0] === key && JSON.stringify(x[1]) === JSON.stringify(params));
  expect(c, `a case for ${key} ${JSON.stringify(params)}`).toBeDefined();
  expect(err).toBeInstanceOf(cls);
  expect(err.code).toBe(cls === ValidationError ? 'VALIDATION_ERROR' : 'RESOURCE_ALREADY_EXISTS');
  expect(err.messageKey).toEqual(Object.keys(params).length > 0 ? { key, params } : { key });
  expect(err.message).toBe(c![3]);
  expect(err.localized('es')).toBe(c![2]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => {
  resetLanguage();
});

describe('each key renders what its site printed', () => {
  it('the block has one key per site', () => {
    expect(new Set(CASES.map((c) => c[0])).size).toBe(KEYS_OF_THIS_BLOCK);
  });

  it.each(CASES)('%s in es is the Spanish of before', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it.each(CASES)('%s in en', (key, params, _spanish, english) => {
    expect(t(key, params, 'en')).toBe(english);
  });
});

describe('the residual gate and the sides of a group throw the key', () => {
  it('write-off on a group that balances', async () => {
    const c = cuadrarGrupo([{ id: 'b1', importe: '500.0000' }], [{ id: 'l1', importe: '500.0000' }]);
    const err = await caught(() => exigirCuadre(c, { modo: 'write-off', cuentaWriteOff: 'cta-7' }));
    expectKeyed(err, ValidationError, 'error.VALIDATION_ERROR.bank_match.write_off_on_zero', {});
  });

  it('a residual nobody declared names the four figures', async () => {
    const c = cuadrarGrupo(
      [{ id: 'b1', importe: '1000.0000' }],
      [{ id: 'l1', importe: '900.0000' }],
      [{ concepto: 'comisión', importe: '25.0000' }]
    );
    const err = await caught(() => exigirCuadre(c));
    expectKeyed(err, ValidationError, 'error.VALIDATION_ERROR.bank_match.residual_undeclared', {
      bank: '1000.0000', books: '900.0000', adjustments: '25.0000', difference: '75.0000',
    });
  });

  it('write-off without an account, and an account with keep', async () => {
    const c = cuadrarGrupo([{ id: 'b1', importe: '1000.0000' }], [{ id: 'l1', importe: '999.0000' }]);
    expectKeyed(await caught(() => exigirCuadre(c, { modo: 'write-off' })), ValidationError,
      'error.VALIDATION_ERROR.bank_match.write_off_needs_account', { difference: '1.0000' });
    expectKeyed(await caught(() => exigirCuadre(c, { modo: 'keep', cuentaWriteOff: 'cta-7' })), ValidationError,
      'error.VALIDATION_ERROR.bank_match.write_off_account_with_keep', {});
  });

  it.each([['bank', 'b1'], ['books', 'l1']] as const)('a repeated id on the %s side', async (side, id) => {
    const err = await caught(() => exigirSinRepetidos([id, id], side));
    expectKeyed(err, ValidationError, 'error.VALIDATION_ERROR.bank_match.repeated_id', { side, id });
  });

  it('apply with nothing to match', async () => {
    const err = await caught(() => aplicarCotejos({ kind: 'entity', entityId: 'E1' } as never, [], { userId: 'u1' } as never));
    expectKeyed(err, ValidationError, 'error.VALIDATION_ERROR.bank_match.apply_needs_transaction', {});
  });

  it('unapply with a reason that is not a code', async () => {
    const err = await caught(() =>
      desaplicarCotejo({ kind: 'entity', entityId: 'E1' } as never, MATCH, { userId: 'u1', motivo: 'porque-si' } as never)
    );
    expect(err.messageKey?.key).toBe('error.VALIDATION_ERROR.bank_match.unapply_reason_unknown');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.localized('es')).toMatch(/^Motivo de desaplicación desconocido: 'porque-si'\. Los admitidos son /);
    expect(err.message).toMatch(/^Unknown unapply reason: 'porque-si'\. The accepted ones are /);
  });
});

describe('the seal of the book items throws the key', () => {
  const client = (rowCount: number) => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount }) }) as never;

  it('a partial seal', async () => {
    const err = await caught(() => sellarPartidas(client(2), ['a', 'b', 'c'], 'grp-1'));
    expectKeyed(err, ValidationError, 'error.VALIDATION_ERROR.bank_book_item.partial_seal', { sealed: 2, count: 3, group: 'grp-1' });
  });

  it('a book item another group already sealed is a conflict', async () => {
    const other = { query: vi.fn().mockResolvedValue({ rows: [{ id: LINE, reconciliation_id: GROUP }] }) } as never;
    const err = await caught(() => sealForGroup(other, 'E1', 'grp-new', [LINE]));
    expectKeyed(err, ConflictError, 'error.RESOURCE_ALREADY_EXISTS.bank_match.item_sealed_by_other_group', { id: LINE, group: GROUP });
  });

  it('a partial release', async () => {
    const err = await caught(() => liberarPartidas(client(0), ['jel-1']));
    expectKeyed(err, ValidationError, 'error.VALIDATION_ERROR.bank_book_item.partial_release', { released: 0, count: 1 });
  });

  it('the overDays guard speaks to a developer, in English', async () => {
    await expect(listarPartidasDeLibros('E1', ACCOUNT, { overDays: -1 })).rejects.toThrow(
      '`overDays` must be a non-negative whole number of days; got -1.'
    );
  });
});
