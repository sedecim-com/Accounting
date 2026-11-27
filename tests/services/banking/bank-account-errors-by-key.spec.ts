/**
 * MNE-001-824 (#151), I9 by folder, part 2b, part 1: the identifier and field
 * checks of a bank account (`bank-account-service.ts`) and the refusals of
 * `bank transaction reclassify` (`transactions.ts`) that reached the requester
 * in Spanish prose are catalogue keys now. MNE-001-856, part 2: so are the GL
 * mapping gate, the conflicts, the rest of edit and set, and the warnings of
 * the card. The Spanish twin must print, byte
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

import { query, withTransaction } from '../../../src/database/connection.js';
import { entityScope, tenantScope } from '../../../src/database/scope.js';
import { resetLanguage, t, type MessageParams, type TranslationKey } from '../../../src/i18n/index.js';
import { AppError, ConflictError, ValidationError } from '../../../src/utils/errors.js';
import {
  createBankAccount,
  digitoVerificadorClabe,
  exigirClabe,
  exigirRoutingAba,
  getBankAccount,
  setBankGlMapping,
  updateBankAccount,
  type EntradaCuentaBancaria,
} from '../../../src/services/banking/bank-account-service.js';
import { exigirTipoDeMovimiento, reclassifyTransaction } from '../../../src/services/banking/transactions.js';

const TX = 'a1b2c3d4-0000-4000-8000-000000000824';
const BANK = 'b1c2d3e4-0000-4000-8000-000000000824';
const OTHER = 'c1d2e3f4-0000-4000-8000-000000000824';
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
  // MNE-001-856 (part 2) · bank-account-service.ts: the GL mapping gate
  ['error.VALIDATION_ERROR.bank_account.gl_inactive', { code: '1110' },
    'La cuenta de mayor 1110 está inactiva: una cuenta bancaria mapeada a ella no podría contabilizar nada.',
    'GL account 1110 is inactive: a bank account mapped to it could post nothing.'],
  ['error.VALIDATION_ERROR.bank_account.gl_not_postable', { code: '1110', reason: 'header' },
    '1110 es una cuenta de agrupación: el mapeo bancario tiene que apuntar a una cuenta de movimiento.',
    '1110 is a header account: the bank mapping must point at a posting account.'],
  ['error.VALIDATION_ERROR.bank_account.gl_not_postable', { code: '1110', reason: 'no_entries' },
    '1110 no admite pólizas: el mapeo bancario tiene que apuntar a una cuenta de movimiento.',
    '1110 does not take entries: the bank mapping must point at a posting account.'],
  ['error.VALIDATION_ERROR.bank_account.gl_wrong_class', { type: 'checking', expected: 'asset', code: '1110', glType: 'liability' },
    'Una cuenta de tipo checking es un ACTIVO y 1110 está clasificada como liability. Con el tipo cruzado, el ' +
      'saldo se presenta con el signo invertido.',
    'An account of type checking is an ASSET and 1110 is classified as liability. With the type crossed, the ' +
      'balance is presented with its sign inverted.'],
  ['error.VALIDATION_ERROR.bank_account.gl_wrong_class', { type: 'credit-card', expected: 'liability', code: '1110', glType: 'asset' },
    'Una cuenta de tipo credit-card es un PASIVO y 1110 está clasificada como asset. Con el tipo cruzado, el ' +
      'saldo se presenta con el signo invertido.',
    'An account of type credit-card is a LIABILITY and 1110 is classified as asset. With the type crossed, the ' +
      'balance is presented with its sign inverted.'],
  ['error.VALIDATION_ERROR.bank_account.gl_currency', { currency: 'MXN', code: '1110', glCurrency: 'USD' },
    'La cuenta bancaria está en MXN y la cuenta de mayor 1110 en USD. Un saldo de libros que suma dos monedas no ' +
      'se puede conciliar contra ningún extracto: usa una cuenta de mayor en MXN, o da de alta la cuenta bancaria ' +
      'en USD.',
    'The bank account is in MXN and GL account 1110 in USD. A book balance that adds two currencies cannot be ' +
      'reconciled against any statement: use a GL account in MXN, or create the bank account in USD.'],
  // the conflicts
  ['error.RESOURCE_ALREADY_EXISTS.bank_account.ambiguous_ref', { ref: 'Operating', count: 2 },
    '"Operating" nombra a 2 cuentas bancarias dentro de este alcance. Acota a una entidad o usa el identificador.',
    '"Operating" names 2 bank accounts within this scope. Narrow it to an entity or use the id.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_account.name_taken', { name: 'Operating', id: OTHER },
    `Esta entidad ya tiene una cuenta bancaria llamada "Operating" (${OTHER}). El nombre es con lo que se la ` +
      'nombra en la terminal: repetirlo deja a las dos sin manija.',
    `This entity already has a bank account called "Operating" (${OTHER}). The name is what the terminal calls ` +
      'it by: repeating it leaves both without a handle.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_account.gl_taken', { code: '1110', name: 'Payroll', id: OTHER },
    `La cuenta de mayor 1110 ya está tomada por la cuenta bancaria "Payroll" (${OTHER}). El mapeo es 1:1: dos ` +
      'cuentas bancarias sobre el mismo mayor comparten saldo de libros y cada conciliación ve los movimientos ' +
      'de la otra.',
    `GL account 1110 is already taken by bank account "Payroll" (${OTHER}). The mapping is 1:1: two bank ` +
      "accounts on the same GL account share a book balance and each reconciliation sees the other's " +
      'transactions.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_account.gl_taken_unseen', { code: '1110' },
    'La cuenta de mayor 1110 ya está tomada por una cuenta bancaria que este alcance no alcanza a ver. El mapeo ' +
      'es 1:1.',
    'GL account 1110 is already taken by a bank account this scope cannot see. The mapping is 1:1.'],
  // edit and set
  ['error.VALIDATION_ERROR.bank_account.gl_outside_entity', {},
    'La cuenta apunta a un mayor fuera de esta entidad: arregla el mapeo con `bank account set` antes de mover ' +
      'tipo o moneda.',
    'The account points at a GL account outside this entity: fix the mapping with `bank account set` before ' +
      'moving type or currency.'],
  ['error.VALIDATION_ERROR.bank_account.sensitive_needs_reason', { fields: 'clabe, account_number, routing_number' },
    'Cambiar clabe, account_number, routing_number exige un motivo: es el dato con el que sale el dinero, y un ' +
      'cambio sin motivo en la bitácora es indistinguible de un desvío.',
    'Changing clabe, account_number, routing_number requires a reason: it is the datum the money leaves with, ' +
      'and a change with no reason in the log cannot be told apart from a diversion.'],
  ['error.VALIDATION_ERROR.bank_account.clabe_other_bank', { bank: '012', code: '002' },
    'La CLABE nueva es del banco 012 y la cuenta queda con la clave SAT 002. Cambiar de banco es dar de alta otra ' +
      'cuenta, no editar ésta.',
    'The new CLABE belongs to bank 012 and the account keeps SAT code 002. Changing banks is creating another ' +
      'account, not editing this one.'],
  ['error.VALIDATION_ERROR.bank_account.nothing_to_change', {},
    'No se pidió ningún cambio. Campos editables: nombre, banco, sucursal, SWIFT, IBAN, clave SAT, tipo, moneda, ' +
      'CLABE, número de cuenta, routing y la marca de banco extranjero.',
    'No change was asked for. Editable fields: name, bank, branch, SWIFT, IBAN, SAT code, type, currency, ' +
      'CLABE, account number, routing and the foreign-bank mark.'],
  ['error.RESOURCE_ALREADY_EXISTS.bank_account.remap_has_history', { code: '1110', lines: 1, balance: '750.00' },
    '1110 ya tiene 1 línea contabilizada (saldo 750.00). Remapear dejaría ese saldo huérfano: sin cuenta ' +
      'bancaria que lo concilie y fuera del alcance de la nueva. Si de verdad es lo que quieres, repite con ' +
      '--force y un motivo.',
    "1110 already has 1 posted line (balance 750.00). Remapping would leave that balance orphaned: with no bank " +
      "account to reconcile it and out of the new one's reach. If that is really what you want, repeat with " +
      '--force and a reason.'],
  ['error.VALIDATION_ERROR.bank_account.forced_remap_needs_reason', {},
    'Forzar el remapeo de una cuenta con historia contabilizada exige un motivo.',
    'Forcing the remap of an account with posted history requires a reason.'],
  // the warnings
  ['bank.account.warning.gl_outside_entity', {},
    'La cuenta de mayor mapeada no pertenece a esta entidad: el saldo de libros se lee como cero y la ' +
      'conciliación no tiene contra qué correr. Corrígelo con `bank account set`.',
    'The mapped GL account does not belong to this entity: the book balance reads as zero and the ' +
      'reconciliation has nothing to run against. Fix it with `bank account set`.'],
  ['bank.account.warning.gl_currency', { currency: 'MXN', code: '1110', glCurrency: 'USD' },
    'La cuenta está en MXN y su cuenta de mayor 1110 en USD: el saldo de libros mezcla dos monedas.',
    'The account is in MXN and its GL account 1110 in USD: the book balance mixes two currencies.'],
  ['bank.account.warning.gl_class', { type: 'checking', expected: 'asset', code: '1110', glType: 'liability' },
    'Una cuenta de tipo checking debería mapear a una cuenta de mayor asset y 1110 es liability.',
    'An account of type checking should map to a GL account of type asset, and 1110 is liability.'],
  ['bank.account.warning.single_signature', {},
    'Cambio de identificador aplicado con UNA sola firma. El catálogo exige una segunda aprobación de otro ' +
      'usuario y no existe todavía la tabla que la sostenga; queda el motivo y el actor en la bitácora.',
    'Identifier change applied with ONE signature only. The catalogue requires a second approval by another ' +
      'user and the table to hold it does not exist yet; the reason and the actor stay in the log.'],
  ['bank.account.warning.already_mapped', { code: '1110' },
    'La cuenta ya estaba mapeada a 1110: no había nada que escribir.',
    'The account was already mapped to 1110: there was nothing to write.'],
  ['bank.account.warning.remapped_over_history', { code: '1110', lines: 2, balance: '750.00' },
    'Se remapeó sobre 2 líneas contabilizadas de 1110 (saldo 750.00): ese saldo queda sin cuenta bancaria que ' +
      'lo concilie.',
    'Remapped over 2 posted lines of 1110 (balance 750.00): that balance is left with no bank account to ' +
      'reconcile it.'],
];

/** 20 keys of the MNE-001-824 block and 20 of the MNE-001-856 block. */
const KEYS_OF_THIS_BLOCK = 40;

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

// ============================================================
// Part 2 (MNE-001-856) · the sites behind the first query, on a client that answers each
// statement by its text: the GL mapping gate, the conflicts, edit, set, and
// the warnings of the card.
// ============================================================

type Row = Record<string, unknown>;

/** The projection's row: a checking account in MXN on 1110, with c_Banco 002. */
const card = (patch: Row = {}): Row => ({
  id: BANK, entity_id: 'E1', account_name: 'Operating', bank_name: 'Banco Ficticio', bank_branch: null,
  account_type: 'checking', currency_code: 'MXN', sat_bank_code: '002', swift_code: null, iban: null,
  clabe_last4: null, account_number_last4: null, routing_en_archivo: false, clabe_en_archivo: false,
  bank_is_foreign: false, is_active: true, saldo_banco: null, last_synced_at: null,
  created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01'),
  gl_id: 'acc-1110', gl_code: '1110', gl_name: 'Bancos', gl_tipo: 'asset', gl_moneda: 'MXN',
  saldo_libro: '0', ultima_conciliacion: null, ...patch,
});

/** The GL account `exigirCuentaDeMayor` reads: 1110, an active asset posting account in MXN. */
const gl = (patch: Row = {}): Row => ({
  id: 'acc-1110', code: '1110', name: 'Bancos', account_type: 'asset', is_active: true, is_header: false,
  allow_manual_entries: true, moneda: 'MXN', ...patch,
});

interface Answers { lock?: Row[]; card?: Row; gl?: Row; sameName?: Row[]; insert?: unknown; holder?: Row[]; lines?: string }

function answering(a: Answers): { query: Mock } {
  return {
    query: vi.fn(async (text: string) => {
      const sql = String(text);
      if (sql.includes('FOR UPDATE')) return { rows: a.lock ?? [{ id: BANK }] };
      if (sql.includes('libro ON true')) return { rows: [a.card ?? card()] };
      if (sql.includes('FROM accounts a')) return { rows: [a.gl ?? gl()] };
      if (sql.includes('lower(account_name) = lower($1) AND entity_id')) return { rows: a.sameName ?? [] };
      if (sql.startsWith('INSERT INTO bank_accounts')) throw a.insert;
      if (sql.includes('WHERE gl_account_id = $1')) return { rows: a.holder ?? [] };
      if (sql.includes('AS lines')) return { rows: [{ lines: a.lines ?? '0', balance: '750.0000' }] };
      if (sql.startsWith('UPDATE bank_accounts')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
    }),
  };
}

describe('the GL mapping gate, the conflicts, edit and set refuse by key', () => {
  const scope = entityScope('T1', 'E1');
  const input: EntradaCuentaBancaria = { accountName: 'Operating', bankName: 'Banco Ficticio', glAccount: '1110', currencyCode: 'MXN' };
  const on = (a: Answers): void => {
    const c = answering(a);
    (withTransaction as unknown as Mock).mockReset();
    (withTransaction as unknown as Mock).mockImplementation(async (fn: (x: unknown) => unknown) => fn(c));
  };

  it.each([
    [{ is_active: false }, 'checking', 'error.VALIDATION_ERROR.bank_account.gl_inactive', { code: '1110' }, 'gl_account'],
    [{ is_header: true }, 'checking', 'error.VALIDATION_ERROR.bank_account.gl_not_postable', { code: '1110', reason: 'header' }, 'gl_account'],
    [{ allow_manual_entries: false }, 'checking', 'error.VALIDATION_ERROR.bank_account.gl_not_postable', { code: '1110', reason: 'no_entries' }, 'gl_account'],
    [{ account_type: 'liability' }, 'checking', 'error.VALIDATION_ERROR.bank_account.gl_wrong_class',
      { type: 'checking', expected: 'asset', code: '1110', glType: 'liability' }, 'gl_account'],
    [{}, 'credit-card', 'error.VALIDATION_ERROR.bank_account.gl_wrong_class',
      { type: 'credit-card', expected: 'liability', code: '1110', glType: 'asset' }, 'gl_account'],
    [{ moneda: 'USD' }, 'checking', 'error.VALIDATION_ERROR.bank_account.gl_currency',
      { currency: 'MXN', code: '1110', glCurrency: 'USD' }, 'currency_code'],
  ] as const)('create on the GL account %j as %s', async (account, type, key, params, field) => {
    on({ gl: gl(account) });
    expectKeyed(await caught(() => createBankAccount(scope, { ...input, accountType: type }, { userId: 'u1' })),
      ValidationError, key, params, field);
  });

  it('create with a name the entity already uses, or on a GL account another bank account holds', async () => {
    on({ sameName: [{ id: OTHER }] });
    expectKeyed(await caught(() => createBankAccount(scope, input, { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_account.name_taken', { name: 'Operating', id: OTHER });
    const taken = { code: '23505', constraint: 'uq_bank_accounts_gl' };
    on({ insert: taken, holder: [{ id: OTHER, account_name: 'Payroll' }] });
    expectKeyed(await caught(() => createBankAccount(scope, input, { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_account.gl_taken', { code: '1110', name: 'Payroll', id: OTHER });
    on({ insert: taken });
    expectKeyed(await caught(() => createBankAccount(scope, input, { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_account.gl_taken_unseen', { code: '1110' });
  });

  it('a ref that names two accounts', async () => {
    on({ lock: [{ id: BANK }, { id: OTHER }] });
    expectKeyed(await caught(() => updateBankAccount(scope, 'Operating', { bankName: 'Otro' }, { userId: 'u1' })),
      ConflictError, 'error.RESOURCE_ALREADY_EXISTS.bank_account.ambiguous_ref', { ref: 'Operating', count: 2 });
  });

  it.each([
    [{ gl_id: null }, { accountType: 'savings' }, undefined, 'error.VALIDATION_ERROR.bank_account.gl_outside_entity', {}, 'gl_account'],
    [{}, { accountNumber: '12345678' }, undefined, 'error.VALIDATION_ERROR.bank_account.sensitive_needs_reason',
      { fields: 'clabe, account_number, routing_number' }, 'reason'],
    // 012·914·12345678901 asks for 7: a valid CLABE of bank 012 on an account kept on 002
    [{}, { clabe: '012914123456789017' }, 'New CLABE', 'error.VALIDATION_ERROR.bank_account.clabe_other_bank',
      { bank: '012', code: '002' }, 'clabe'],
    [{}, {}, undefined, 'error.VALIDATION_ERROR.bank_account.nothing_to_change', {}, undefined],
  ] as const)('edit on %j with %j', async (row, patch, reason, key, params, field) => {
    on({ card: card(row) });
    expectKeyed(await caught(() => updateBankAccount(scope, BANK, patch, { userId: 'u1', reason })),
      ValidationError, key, params, field);
  });

  it('edit of an identifier warns it was signed once', async () => {
    on({});
    const r = await updateBankAccount(scope, BANK, { accountNumber: '12345678' }, { userId: 'u1', reason: 'New number', dryRun: true });
    expect(r.advertencias).toEqual([{ key: 'bank.account.warning.single_signature' }]);
  });

  it('set over posted history refuses, asks a reason when forced, and warns when it goes ahead', async () => {
    const to1112 = { gl: gl({ id: 'acc-1112', code: '1112' }) };
    on({ ...to1112, lines: '1' });
    expectKeyed(await caught(() => setBankGlMapping(scope, BANK, '1112', { userId: 'u1' })), ConflictError,
      'error.RESOURCE_ALREADY_EXISTS.bank_account.remap_has_history', { code: '1110', lines: 1, balance: '750.00' });
    on({ ...to1112, lines: '1' });
    expectKeyed(await caught(() => setBankGlMapping(scope, BANK, '1112', { userId: 'u1', force: true })), ValidationError,
      'error.VALIDATION_ERROR.bank_account.forced_remap_needs_reason', {}, 'reason');
    on({ ...to1112, lines: '2' });
    const r = await setBankGlMapping(scope, BANK, '1112', { userId: 'u1', force: true, reason: 'Moved', dryRun: true });
    expect(r.advertencias).toEqual([
      { key: 'bank.account.warning.remapped_over_history', params: { code: '1110', lines: 2, balance: '750.00' } },
    ]);
  });

  it('set to the account it already maps warns there was nothing to write', async () => {
    on({});
    const r = await setBankGlMapping(scope, BANK, '1110', { userId: 'u1' });
    expect(r.advertencias).toEqual([{ key: 'bank.account.warning.already_mapped', params: { code: '1110' } }]);
  });

  it('the card warns by key', async () => {
    const pool = query as unknown as Mock;
    pool.mockResolvedValueOnce({ rows: [card({ gl_id: null })] });
    expect((await getBankAccount(scope, BANK)).advertencias).toEqual([{ key: 'bank.account.warning.gl_outside_entity' }]);
    pool.mockResolvedValueOnce({ rows: [card({ gl_moneda: 'USD', gl_tipo: 'liability' })] });
    expect((await getBankAccount(scope, BANK)).advertencias).toEqual([
      { key: 'bank.account.warning.gl_currency', params: { currency: 'MXN', code: '1110', glCurrency: 'USD' } },
      { key: 'bank.account.warning.gl_class', params: { type: 'checking', expected: 'asset', code: '1110', glType: 'liability' } },
    ]);
  });
});
