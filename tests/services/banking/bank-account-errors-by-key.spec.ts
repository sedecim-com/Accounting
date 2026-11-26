/**
 * MNE-001-824 (#151), I9 by folder, part 2b, part 1: the identifier and field
 * checks of a bank account (`bank-account-service.ts`) and the refusals of
 * `bank transaction reclassify` (`transactions.ts`) that reached the requester
 * in Spanish prose are catalogue keys now. The Spanish twin must print, byte
 * for byte, what each site printed before (written by hand from those sites,
 * with synthetic CLABEs and routings whose check digits are worked out below),
 * and the English is the source the error's `message` is fixed in. The
 * 17-digit guard of `digitoVerificadorClabe` is for a developer, in English.
 */
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/services/audit/audit-log.js', () => ({
  registrarAuditoria: vi.fn(async () => undefined),
  tenantDe: vi.fn(async () => 'ten-1'),
}));

import { withTransaction } from '../../../src/database/connection.js';
import { entityScope, tenantScope } from '../../../src/database/scope.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ConflictError, ValidationError } from '../../../src/utils/errors.js';
import {
  createBankAccount,
  digitoVerificadorClabe,
  exigirClabe,
  exigirRoutingAba,
  setBankGlMapping,
  updateBankAccount,
  type EntradaCuentaBancaria,
} from '../../../src/services/banking/bank-account-service.js';
import { exigirTipoDeMovimiento, reclassifyTransaction } from '../../../src/services/banking/transactions.js';

const TX = 'a1b2c3d4-0000-4000-8000-000000000824';
const ACCOUNT_TYPES = 'checking, savings, petty-cash, credit-card, escrow';
const TRANSACTION_TYPES = 'debit, credit, fee, interest, adjustment';

/** key, params, the Spanish each site printed, the English source. */
type Case = readonly [TranslationKey, MessageParams, string, string];

const CASES: readonly Case[] = [
  // bank-account-service.ts: the scope of a write
  ['error.VALIDATION_ERROR.bank_account.needs_entity', { act: 'create' },
    'Dar de alta una cuenta bancaria necesita una entidad concreta: un alcance de inquilino no dice en cuál ' +
      'de sus entidades vive la cuenta.',
    'Creating a bank account needs a specific entity: a tenant scope does not say in which of its entities ' +
      'the account lives.'],
  ['error.VALIDATION_ERROR.bank_account.needs_entity', { act: 'edit' },
    'Editar una cuenta bancaria necesita una entidad concreta: un alcance de inquilino no dice en cuál de sus ' +
      'entidades vive la cuenta.',
    'Editing a bank account needs a specific entity: a tenant scope does not say in which of its entities the ' +
      'account lives.'],
  ['error.VALIDATION_ERROR.bank_account.needs_entity', { act: 'set' },
    'Fijar el mapeo contable de una cuenta bancaria necesita una entidad concreta: un alcance de inquilino no ' +
      'dice en cuál de sus entidades vive la cuenta.',
    'Setting the GL mapping of a bank account needs a specific entity: a tenant scope does not say in which ' +
      'of its entities the account lives.'],
  // the CLABE: 002·180·00000000000 asks for 9 (0,0,2,3,56→6: 11 → 10−1), and 000… passes with 0
  ['error.VALIDATION_ERROR.bank_account.clabe_length', { value: '0021800000', length: 10 },
    'La CLABE son 18 dígitos (3 de banco, 3 de plaza, 11 de cuenta y 1 verificador); "0021800000" tiene 10.',
    'A CLABE is 18 digits (3 for the bank, 3 for the city, 11 for the account and 1 check digit); ' +
      '"0021800000" has 10.'],
  ['error.VALIDATION_ERROR.bank_account.clabe_check_digit', { last4: '0000', expected: 9, got: '0' },
    'La CLABE terminada en 0000 no pasa su dígito verificador: los 17 primeros exigen 9 y trae 0. Casi ' +
      'siempre son dos dígitos transpuestos al copiarla.',
    'The CLABE ending in 0000 fails its check digit: the first 17 require 9 and it has 0. It is almost always ' +
      'two digits transposed when copying it.'],
  ['error.VALIDATION_ERROR.bank_account.clabe_bank_000', {},
    'La CLABE empieza con 000, que no es clave de ninguna institución del catálogo de Banxico ni del c_Banco ' +
      'del SAT.',
    "The CLABE starts with 000, which is the code of no institution in Banxico's catalogue or in the SAT's " +
      'c_Banco.'],
  // the ABA routing: 1·3+2·7+3·1+4·3+5·7+6·1+7·3+8·7+1·1 = 151, not a multiple of 10
  ['error.VALIDATION_ERROR.bank_account.aba_length', { value: '12345', length: 5 },
    'El routing ABA son 9 dígitos; "12345" tiene 5.',
    'An ABA routing number is 9 digits; "12345" has 5.'],
  ['error.VALIDATION_ERROR.bank_account.aba_checksum', { routing: '123456781' },
    'El routing 123456781 no pasa su checksum ABA (ponderación 3,7,1 múltiplo de 10).',
    'Routing number 123456781 fails its ABA checksum (weights 3,7,1, a multiple of 10).'],
  ['error.VALIDATION_ERROR.bank_account.aba_zero', {},
    'El routing 000000000 cumple el checksum por aritmética y no corresponde a ninguna institución.',
    'Routing number 000000000 passes the checksum by arithmetic and belongs to no institution.'],
  // the other fields of create and edit
  ['error.VALIDATION_ERROR.bank_account.type_unknown', { value: 'wire', known: ACCOUNT_TYPES },
    `"wire" no es un tipo de cuenta. Los cinco son: ${ACCOUNT_TYPES}.`,
    `"wire" is not an account type. The five are: ${ACCOUNT_TYPES}.`],
  ['error.VALIDATION_ERROR.bank_account.currency_invalid', { value: 'pesos' },
    '"pesos" no es un código ISO de moneda de tres letras.',
    '"pesos" is not a three-letter ISO currency code.'],
  ['error.VALIDATION_ERROR.bank_account.sat_bank_code_invalid', { value: '12' },
    'La clave de banco del SAT (c_Banco) son 3 dígitos; llegó "12".',
    'The SAT bank code (c_Banco) is 3 digits; got "12".'],
  ['error.VALIDATION_ERROR.bank_account.field_empty', { field: 'account_name' },
    'El nombre de la cuenta no puede ir vacío.',
    'The account name cannot be empty.'],
  ['error.VALIDATION_ERROR.bank_account.field_empty', { field: 'bank_name' },
    'El nombre del banco no puede ir vacío.',
    'The bank name cannot be empty.'],
  ['error.VALIDATION_ERROR.bank_account.swift_invalid', { value: 'BANK' },
    '"BANK" no tiene forma de código SWIFT/BIC (8 u 11 caracteres: 4 de banco, 2 de país, 2 de plaza y 3 ' +
      'opcionales de sucursal).',
    '"BANK" does not have the shape of a SWIFT/BIC code (8 or 11 characters: 4 for the bank, 2 for the ' +
      'country, 2 for the location and an optional 3 for the branch).'],
  ['error.VALIDATION_ERROR.bank_account.iban_invalid', { value: 'MX12' },
    '"MX12" no tiene forma de IBAN (2 letras de país, 2 dígitos de control y hasta 30 alfanuméricos).',
    '"MX12" does not have the shape of an IBAN (2 country letters, 2 check digits and up to 30 ' +
      'alphanumerics).'],
  ['error.VALIDATION_ERROR.bank_account.routings_differ', {},
    'El routing ACH y el de transferencia son distintos y la tabla sólo tiene una columna para los dos ' +
      '(`routing_number_encrypted`, migración 003): guardar uno perdería el otro sin avisar. Da de alta la ' +
      'cuenta con uno y abre la falta de columna como trabajo de F05b.',
    'The ACH routing number and the wire one differ, and the table has only one column for both ' +
      '(`routing_number_encrypted`, migration 003): keeping one would lose the other without a word. Create ' +
      'the account with one and open the missing column as F05b work.'],
  ['error.VALIDATION_ERROR.bank_account.sat_bank_code_not_clabe', { declared: '002', clabe: '012' },
    'La clave de banco declarada (002) no es la que trae la CLABE (012). Son el mismo catálogo: una de las ' +
      'dos está mal.',
    'The declared bank code (002) is not the one the CLABE carries (012). They are the same catalogue: one ' +
      'of the two is wrong.'],
  // transactions.ts
  ['error.VALIDATION_ERROR.bank_transaction.type_unknown', { value: 'wire', known: TRANSACTION_TYPES },
    `"wire" no es un tipo de movimiento bancario. Los cinco son: ${TRANSACTION_TYPES}.`,
    `"wire" is not a bank transaction type. The five are: ${TRANSACTION_TYPES}.`],
  ['error.VALIDATION_ERROR.bank_transaction.reclassify_sign', { id: TX, amount: '-15.0000', type: 'interest', sign: 'in' },
    `El movimiento ${TX} es de -15.0000 y "interest" exige un importe que ENTRE a la cuenta (positivo). Una ` +
      'devolución de comisión o una retención no cambian de signo por reclasificarlas.',
    `Transaction ${TX} is for -15.0000 and "interest" requires an amount coming INTO the account (positive). ` +
      'A fee refund or a withholding does not change sign by being reclassified.'],
  ['error.VALIDATION_ERROR.bank_transaction.reclassify_sign', { id: TX, amount: '15.0000', type: 'fee', sign: 'out' },
    `El movimiento ${TX} es de 15.0000 y "fee" exige un importe que SALGA de la cuenta (negativo). Una ` +
      'devolución de comisión o una retención no cambian de signo por reclasificarlas.',
    `Transaction ${TX} is for 15.0000 and "fee" requires an amount going OUT of the account (negative). ` +
      'A fee refund or a withholding does not change sign by being reclassified.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_matched', { id: TX },
    `El movimiento ${TX} está cotejado: algo en libros ya lo explica. Deshaz el cotejo con ` +
      '`bank match unapply` antes de cambiar qué es.',
    `Transaction ${TX} is matched: something in the books already explains it. Undo the match with ` +
      '`bank match unapply` before changing what it is.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_posted', { id: TX, entry: 'P-0007' },
    `El movimiento ${TX} ya lo contabilizó la póliza P-0007. Revierte esa póliza antes de reclasificarlo.`,
    `Transaction ${TX} was already posted by entry P-0007. Reverse that entry before reclassifying it.`],
  ['error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_race', { id: TX },
    `El movimiento ${TX} cambió mientras se reclasificaba; vuelve a intentarlo.`,
    `Transaction ${TX} changed while it was being reclassified; try again.`],
];

const KEYS_OF_THIS_BLOCK = 20;

/** The error a call throws or rejects with, for one assertion on all of it. */
async function caught(act: () => unknown): Promise<AppError> {
  try {
    await act();
  } catch (e) {
    return e as AppError;
  }
  throw new Error('it did not throw');
}

/** The site throws `key` with `params` on `field`, keeps its class and code, and reads both languages. */
function expectKeyed(
  err: AppError, cls: typeof ValidationError | typeof ConflictError, key: TranslationKey, params: MessageParams, field?: string
): void {
  const c = CASES.find((x) => x[0] === key && JSON.stringify(x[1]) === JSON.stringify(params));
  expect(c, `a case for ${key} ${JSON.stringify(params)}`).toBeDefined();
  expect(err).toBeInstanceOf(cls);
  expect(err.code).toBe(cls === ValidationError ? 'VALIDATION_ERROR' : 'RESOURCE_ALREADY_EXISTS');
  expect(err.messageKey).toEqual(Object.keys(params).length > 0 ? { key, params } : { key });
  expect(err.field).toBe(field);
  expect(err.message).toBe(c![3]);
  expect(err.localized('es')).toBe(c![2]);
}

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

describe('the identifier checks throw the key', () => {
  it.each([
    ['0021800000', 'error.VALIDATION_ERROR.bank_account.clabe_length', { value: '0021800000', length: 10 }],
    ['002180000000000000', 'error.VALIDATION_ERROR.bank_account.clabe_check_digit', { last4: '0000', expected: 9, got: '0' }],
    ['000000000000000000', 'error.VALIDATION_ERROR.bank_account.clabe_bank_000', {}],
  ] as const)('the CLABE %s', async (clabe, key, params) => {
    expectKeyed(await caught(() => exigirClabe(clabe)), ValidationError, key, params, 'clabe');
  });

  it.each([
    ['12345', 'error.VALIDATION_ERROR.bank_account.aba_length', { value: '12345', length: 5 }],
    ['123456781', 'error.VALIDATION_ERROR.bank_account.aba_checksum', { routing: '123456781' }],
    ['000000000', 'error.VALIDATION_ERROR.bank_account.aba_zero', {}],
  ] as const)('the routing %s', async (routing, key, params) => {
    expectKeyed(await caught(() => exigirRoutingAba(routing)), ValidationError, key, params, 'routing');
  });

  it('the 17-digit guard of the check digit speaks to a developer, in English', () => {
    expect(() => digitoVerificadorClabe('0021800000')).toThrow(
      'The check digit is computed over the first 17 digits of a CLABE; got 10 characters.'
    );
  });
});

describe('create, edit and set refuse by key before any query', () => {
  const input: EntradaCuentaBancaria = { accountName: 'Operating', bankName: 'Banco Ficticio', glAccount: '1110', currencyCode: 'MXN' };
  const create = (patch: Partial<EntradaCuentaBancaria>) =>
    caught(() => createBankAccount(entityScope('T1', 'E1'), { ...input, ...patch }, { userId: 'u1' }));

  it.each([
    ['create', () => createBankAccount(tenantScope('T1'), input, { userId: 'u1' })],
    ['edit', () => updateBankAccount(tenantScope('T1'), 'Operating', {}, { userId: 'u1' })],
    ['set', () => setBankGlMapping(tenantScope('T1'), 'Operating', '1110', { userId: 'u1' })],
  ] as const)('%s on a tenant scope names its act', async (act, call) => {
    expectKeyed(await caught(call), ValidationError, 'error.VALIDATION_ERROR.bank_account.needs_entity', { act });
  });

  it.each([
    [{ accountName: '  ' }, 'error.VALIDATION_ERROR.bank_account.field_empty', { field: 'account_name' }, 'account_name'],
    [{ bankName: '' }, 'error.VALIDATION_ERROR.bank_account.field_empty', { field: 'bank_name' }, 'bank_name'],
    [{ accountType: 'wire' as never }, 'error.VALIDATION_ERROR.bank_account.type_unknown', { value: 'wire', known: ACCOUNT_TYPES }, 'account_type'],
    [{ currencyCode: 'pesos' }, 'error.VALIDATION_ERROR.bank_account.currency_invalid', { value: 'pesos' }, 'currency_code'],
    [{ swiftCode: 'BANK' }, 'error.VALIDATION_ERROR.bank_account.swift_invalid', { value: 'BANK' }, 'swift_code'],
    [{ iban: 'MX12' }, 'error.VALIDATION_ERROR.bank_account.iban_invalid', { value: 'MX12' }, 'iban'],
    // 300000001: 3·3 + 1·1 = 10, a second valid routing that is not 123456780 (150)
    [{ routingAch: '123456780', routingWire: '300000001' }, 'error.VALIDATION_ERROR.bank_account.routings_differ', {}, 'routing_wire'],
    [{ satBankCode: '12' }, 'error.VALIDATION_ERROR.bank_account.sat_bank_code_invalid', { value: '12' }, 'sat_bank_code'],
    // 012·914·12345678901 asks for 7 (sum 73), so the CLABE carries bank 012
    [{ clabe: '012914123456789017', satBankCode: '002' }, 'error.VALIDATION_ERROR.bank_account.sat_bank_code_not_clabe',
      { declared: '002', clabe: '012' }, 'sat_bank_code'],
  ] as const)('create with %j', async (patch, key, params, field) => {
    expectKeyed(await create(patch), ValidationError, key, params, field);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe('bank transaction reclassify refuses by key', () => {
  const debit = { transaction_type: 'debit', amount: '-15.0000', is_matched: false };
  let client: { query: Mock };

  beforeEach(() => {
    client = { query: vi.fn() };
    (withTransaction as unknown as Mock).mockReset();
    (withTransaction as unknown as Mock).mockImplementation(async (fn: (c: unknown) => unknown) => fn(client));
  });

  it('a type that is not one of the five', async () => {
    expectKeyed(await caught(() => exigirTipoDeMovimiento('wire')), ValidationError,
      'error.VALIDATION_ERROR.bank_transaction.type_unknown', { value: 'wire', known: TRANSACTION_TYPES });
  });

  it.each([
    [debit, 'interest', { id: TX, amount: '-15.0000', type: 'interest', sign: 'in' }],
    [{ ...debit, transaction_type: 'credit', amount: '15.0000' }, 'fee', { id: TX, amount: '15.0000', type: 'fee', sign: 'out' }],
  ] as const)('a sign the type contradicts (%j to %s)', async (row, type, params) => {
    client.query.mockResolvedValueOnce({ rows: [row] });
    expectKeyed(await caught(() => reclassifyTransaction('E1', TX, type, { userId: 'u1' })), ValidationError,
      'error.VALIDATION_ERROR.bank_transaction.reclassify_sign', params);
  });

  it('a matched line', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ ...debit, is_matched: true }] });
    expectKeyed(await caught(() => reclassifyTransaction('E1', TX, 'fee', { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_matched', { id: TX });
  });

  it('a line a treasury entry posted', async () => {
    client.query.mockResolvedValueOnce({ rows: [debit] }).mockResolvedValueOnce({ rows: [{ entry_number: 'P-0007' }] });
    expectKeyed(await caught(() => reclassifyTransaction('E1', TX, 'fee', { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_posted', { id: TX, entry: 'P-0007' });
  });

  it('a lost race', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [debit] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expectKeyed(await caught(() => reclassifyTransaction('E1', TX, 'fee', { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_race', { id: TX });
  });
});
