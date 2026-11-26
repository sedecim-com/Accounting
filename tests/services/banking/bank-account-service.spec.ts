import { describe, it, expect, vi } from 'vitest';

// Sin base de datos: lo que se prueba aquí son funciones puras, y el doble de
// `connection.js` es la garantía de que ninguna de ellas abre el pool por un
// camino que nadie esperaba.
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  currentTenant: vi.fn(() => 'ten-1'),
}));
// MNE-001-620: the book balance and the remap guard's posted lines are read
// through report-service. The real helpers run (their SQL reaches the fake
// pool or client below), wrapped in spies so a test can say which layer was
// asked, with what, and on which connection. The audit writer is faked: what
// is tested is what the guard reads, not the audit row.
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    postedBalanceOnAccountSql: vi.fn(real.postedBalanceOnAccountSql),
    queryPostedLinesOnAccount: vi.fn(real.queryPostedLinesOnAccount),
  };
});
vi.mock('../../../src/services/audit/audit-log.js', () => ({
  registrarAuditoria: vi.fn(async () => undefined),
  tenantDe: vi.fn(async () => 'ten-1'),
}));

import {
  digitoVerificadorClabe,
  clabeValida,
  routingAbaValido,
  exigirClabe,
  exigirRoutingAba,
  refuseNationalIdentifierOnForeignBank,
  foreignBankNameTooLong,
  getBankAccount,
  listBankAccounts,
  setBankGlMapping,
} from '../../../src/services/banking/bank-account-service.js';
import { ConflictError, ValidationError } from '../../../src/utils/errors.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { entityScope } from '../../../src/database/scope.js';
import { postedBalanceOnAccountSql, queryPostedLinesOnAccount } from '../../../src/services/reporting/report-service.js';
import type pg from 'pg';

// ============================================================
// LOS DOS CHECKSUM
//
// Las CLABEs de abajo están CONSTRUIDAS y su dígito verificador calculado a
// mano, no tomadas de ninguna cuenta real. Cada una lleva su aritmética en el
// comentario: si alguien cambia la implementación, la prueba no se limita a
// discrepar, dice contra qué cuenta.
//
// Los literales importan más de lo que parece. Una prueba que dijera
// `clabeValida(p + digitoVerificadorClabe(p))` sería verdad para CUALQUIER
// implementación consistente consigo misma, incluida una equivocada; los
// números escritos a mano son los que fijan el algoritmo. La propiedad va
// después, y prueba otra cosa: que el verificador correcto es ÚNICO.
// ============================================================

/**
 * 002 · 180 · 00000000000
 * Términos (dígito×peso mod 10): 0·3=0, 0·7=0, 2·1=2, 1·3=3, 8·7=56→6, resto 0.
 * Suma 11 → 11 mod 10 = 1 → verificador (10−1) mod 10 = 9.
 */
const CLABE_A = '002180000000000009';

/**
 * 012 · 914 · 12345678901
 * Términos: 0,7,2,7,7,4,3,4,3,2,5,6,1,6,9,0,7 → suma 73 → 73 mod 10 = 3
 * → verificador (10−3) mod 10 = 7.
 */
const CLABE_B = '012914123456789017';

/**
 * 002 · 150 · 00000000000 — el caso que justifica el `mod 10` de AFUERA.
 * Términos: 0, 0, 2, 3, 5·7=35→5 → suma 10 → 10 mod 10 = 0
 * → verificador (10−0) mod 10 = 0, y no 10, que no cabe en un dígito.
 */
const CLABE_CERO = '002150000000000000';

describe('digitoVerificadorClabe', () => {
  it('calcula el verificador de una CLABE construida a mano', () => {
    expect(digitoVerificadorClabe('00218000000000000')).toBe(9);
    expect(digitoVerificadorClabe('01291412345678901')).toBe(7);
  });

  it('devuelve 0 —y no 10— cuando la suma ponderada es múltiplo de diez', () => {
    expect(digitoVerificadorClabe('00215000000000000')).toBe(0);
  });

  it('exige exactamente 17 dígitos: no calcula sobre la CLABE entera', () => {
    // El error real que esto atrapa: pasar los 18 y quedarse con un
    // verificador calculado sobre una ventana corrida.
    expect(() => digitoVerificadorClabe(CLABE_A)).toThrow(ValidationError);
    expect(() => digitoVerificadorClabe('0021800000000000')).toThrow(ValidationError);
    expect(() => digitoVerificadorClabe('0021800000000000X')).toThrow(ValidationError);
  });
});

describe('clabeValida', () => {
  it('acepta las CLABEs cuyo dígito 18 es el que exigen los 17 primeros', () => {
    expect(clabeValida(CLABE_A)).toBe(true);
    expect(clabeValida(CLABE_B)).toBe(true);
    expect(clabeValida(CLABE_CERO)).toBe(true);
  });

  it('rechaza los otros nueve dígitos verificadores posibles', () => {
    // La propiedad que el algoritmo promete: el verificador correcto es uno
    // solo. Nueve rechazos por cada aceptación.
    for (const prefijo of ['00218000000000000', '01291412345678901', '00215000000000000']) {
      const correcto = digitoVerificadorClabe(prefijo);
      for (let d = 0; d <= 9; d++) {
        expect(clabeValida(`${prefijo}${d}`)).toBe(d === correcto);
      }
    }
  });

  it('detecta la transposición de dos dígitos contiguos, que es para lo que existe', () => {
    // CLABE_B con el 45 del número de cuenta vuelto 54: el error de tecleo más
    // común, y el que una simple suma sin pesos NO vería.
    expect(clabeValida('012914123546789017')).toBe(false);
  });

  it('rechaza lo que no son 18 dígitos', () => {
    expect(clabeValida('')).toBe(false);
    expect(clabeValida('12345')).toBe(false);
    expect(clabeValida(`${CLABE_A}0`)).toBe(false);
    expect(clabeValida('00218000000000000X')).toBe(false);
    // Con separadores es trabajo de `exigirClabe`, no del predicado.
    expect(clabeValida('002 180 00000000000 9')).toBe(false);
  });
});

describe('routingAbaValido', () => {
  /**
   * 3·(1+4+7) + 7·(2+5+8) + 1·(3+6+0) = 36 + 105 + 9 = 150, múltiplo de 10.
   */
  const ABA_A = '123456780';
  /**
   * 3·(9+6+3) + 7·(8+5+2) + 1·(7+4+0) = 54 + 105 + 11 = 170.
   */
  const ABA_B = '987654320';

  it('acepta nueve dígitos cuya ponderación 3,7,1 es múltiplo de diez', () => {
    expect(routingAbaValido(ABA_A)).toBe(true);
    expect(routingAbaValido(ABA_B)).toBe(true);
  });

  it('rechaza el mismo número con el último dígito movido', () => {
    expect(routingAbaValido('123456781')).toBe(false);
    expect(routingAbaValido('123456789')).toBe(false);
    expect(routingAbaValido('987654321')).toBe(false);
  });

  it('rechaza lo que no son nueve dígitos', () => {
    expect(routingAbaValido('12345678')).toBe(false);
    expect(routingAbaValido('1234567800')).toBe(false);
    expect(routingAbaValido('12345678X')).toBe(false);
    expect(routingAbaValido('')).toBe(false);
  });

  it('acepta nueve ceros, y por eso el checksum no basta', () => {
    // Documentado a propósito: la suma de nueve ceros es cero, así que el
    // checksum lo bendice. Que no exista tal institución lo dice
    // `exigirRoutingAba`, no esta función.
    expect(routingAbaValido('000000000')).toBe(true);
  });
});

describe('exigirClabe', () => {
  it('normaliza los separadores con que se copia de un estado de cuenta', () => {
    expect(exigirClabe('002 180 00000000000 9')).toEqual({
      clabe: CLABE_A,
      bancoSat: '002',
    });
    expect(exigirClabe('012-914-12345678901-7').clabe).toBe(CLABE_B);
  });

  it('devuelve la clave de banco del SAT, que son los tres primeros dígitos', () => {
    expect(exigirClabe(CLABE_B).bancoSat).toBe('012');
  });

  it('nombra el dígito que esperaba cuando el verificador no cuadra', () => {
    expect(() => exigirClabe('002180000000000000')).toThrow(/the first 17 require 9 and it has 0/);
  });

  it('dice cuántos dígitos llegaron cuando no son 18', () => {
    expect(() => exigirClabe('0021800000')).toThrow(/has 10/);
  });

  it('rechaza la clave de banco 000 aunque el verificador cuadre', () => {
    // 000 · 000 · 00000000000 → suma 0 → verificador 0. Aritméticamente
    // impecable y de ninguna institución.
    expect(clabeValida('000000000000000000')).toBe(true);
    expect(() => exigirClabe('000000000000000000')).toThrow(ValidationError);
    expect(() => exigirClabe('000000000000000000')).toThrow(/Banxico's catalogue/);
  });
});

describe('exigirRoutingAba', () => {
  it('normaliza y devuelve el routing', () => {
    expect(exigirRoutingAba('123-456-780')).toBe('123456780');
    expect(exigirRoutingAba('123 456 780')).toBe('123456780');
  });

  it('rechaza el que no pasa el checksum', () => {
    expect(() => exigirRoutingAba('123456781')).toThrow(ValidationError);
    expect(() => exigirRoutingAba('123456781')).toThrow(/ABA checksum/);
  });

  it('rechaza los nueve ceros que el checksum sí acepta', () => {
    expect(() => exigirRoutingAba('000000000')).toThrow(/belongs to no institution/);
  });

  it('lleva el nombre del campo al error, para que la CLI señale el flag correcto', () => {
    try {
      exigirRoutingAba('12345678', 'routing_wire');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('routing_wire');
    }
  });
});

// MNE-001-502 · a foreign account keeps no national identifier, judged on the row as the edit leaves it.
describe('refuseNationalIdentifierOnForeignBank', () => {
  const F = { bank_is_foreign: false, sat_bank_code: null, clabe_en_archivo: false };
  const refusal = (fn: () => void): { key: string | undefined; field: string | undefined } => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const e = err as ValidationError;
      return { key: e.messageKey?.key, field: e.field };
    }
    throw new Error('expected a refusal');
  };

  it('an unmarked account is never judged, whatever it keeps', () => {
    expect(() => refuseNationalIdentifierOnForeignBank({ ...F, sat_bank_code: '012', clabe_en_archivo: true }, {})).not.toThrow();
    expect(() => refuseNationalIdentifierOnForeignBank({ ...F, bank_is_foreign: true, sat_bank_code: '012' }, { foreignBank: false })).not.toThrow();
  });

  it.each([
    ['marking one with a code', { ...F, sat_bank_code: '012' }, { foreignBank: true }, 'sat_bank_code'],
    ['marking one with 999', { ...F, sat_bank_code: '999' }, { foreignBank: true }, 'sat_bank_code'],
    ['marking one with a CLABE', { ...F, clabe_en_archivo: true }, { foreignBank: true }, 'clabe'],
    ['adding a code to a marked one', { ...F, bank_is_foreign: true }, { satBankCode: '012' }, 'sat_bank_code'],
    ['adding a CLABE to a marked one', { ...F, bank_is_foreign: true }, { clabe: '012180001234567899' }, 'clabe'],
  ] as const)('refuses %s, keyed and naming the field', (_case, current, patch, field) => {
    const r = refusal(() => refuseNationalIdentifierOnForeignBank(current, patch));
    expect(r.field).toBe(field);
    expect(r.key).toBe(field === 'clabe' ? 'bank.account.foreign_bank.keeps_clabe' : 'bank.account.foreign_bank.keeps_sat_bank_code');
  });

  it('accepts one edit that clears the code or the CLABE and sets the mark', () => {
    expect(() => refuseNationalIdentifierOnForeignBank({ ...F, sat_bank_code: '012' }, { foreignBank: true, satBankCode: null })).not.toThrow();
    expect(() => refuseNationalIdentifierOnForeignBank({ ...F, sat_bank_code: '012' }, { foreignBank: true, satBankCode: '  ' })).not.toThrow();
    expect(() => refuseNationalIdentifierOnForeignBank({ ...F, clabe_en_archivo: true }, { foreignBank: true, clabe: null })).not.toThrow();
  });
});

// MNE-001-615 · the same rule at creation, keyed by the flag to drop; and the over-150 warning.
describe('the mark at creation, and a foreign name over 150', () => {
  it.each([
    [{ satBankCode: '999' }, 'bank.account.create.foreign_bank.sat_bank_code', 'sat_bank_code'],
    [{ clabe: '012180001234567899' }, 'bank.account.create.foreign_bank.clabe', 'clabe'],
  ] as const)('create refuses %j with its own key', (patch, key, field) => {
    try {
      refuseNationalIdentifierOnForeignBank({ sat_bank_code: null }, { foreignBank: true, ...patch }, 'create');
    } catch (err) {
      expect((err as ValidationError).messageKey?.key).toBe(key);
      expect((err as ValidationError).field).toBe(field);
      return;
    }
    throw new Error('expected a refusal');
  });

  it('counts code points of the sanitized name, warns only past 150, and only on a marked account', () => {
    const astral = '\u{1D505}';
    expect(foreignBankNameTooLong(true, 'B'.repeat(149) + astral)).toBeUndefined();
    expect(foreignBankNameTooLong(true, `  ${'B'.repeat(75)}\n\n${'B'.repeat(74)}  `)).toBeUndefined();
    expect(foreignBankNameTooLong(true, 'B'.repeat(150) + astral)).toEqual({
      key: 'bank.account.foreign_bank.name_too_long', params: { length: 151, max: 150 },
    });
    expect(foreignBankNameTooLong(false, 'B'.repeat(300))).toBeUndefined();
  });
});

// ============================================================
// MNE-001-620 (#101) · THE BOOK BALANCE AND THE REMAP GUARD READ REPORT-SERVICE
//
// A bank account on 1111 with two posted entries, Dr 1 000.00 and Cr 250.00:
// the books say 1 000.00 − 250.00 = 750.00, and the bank said 700.00, so the
// difference is 50.00. Remapping it to 1112 meets those 2 posted lines. The
// fake pool and client answer what Postgres would; the figures the surfaces
// print are checked by hand.
// ============================================================

describe('the book balance and the remap guard read through report-service (MNE-001-620)', () => {
  const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const BANK = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const scope = entityScope('ten-1', ENTITY);
  const pool = vi.mocked(query);
  const postedLines = vi.mocked(queryPostedLinesOnAccount);
  // The projection is a module constant: the helper is asked once, when the
  // module loads, and costs nothing per statement. Its call is read here, at
  // collection, because the runner clears spies before each test.
  const lateralCalls = [...vi.mocked(postedBalanceOnAccountSql).mock.calls];
  const lateralText = vi.mocked(postedBalanceOnAccountSql).mock.results[0]?.value as string | undefined;

  /** The projection's row, as Postgres hands it back: money as strings. */
  const row = (gl: { id: string; code: string }, bookBalance: string) => ({
    id: BANK, entity_id: ENTITY, account_name: 'Cuenta de cheques', bank_name: 'Banco de Prueba', bank_branch: null,
    account_type: 'checking', currency_code: 'MXN', sat_bank_code: null, swift_code: null, iban: null,
    clabe_last4: null, account_number_last4: null, routing_en_archivo: false, clabe_en_archivo: false,
    bank_is_foreign: false, is_active: true, saldo_banco: '700.0000', last_synced_at: null,
    created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01'),
    gl_id: gl.id, gl_code: gl.code, gl_name: `Bancos ${gl.code}`, gl_tipo: 'asset', gl_moneda: 'MXN',
    saldo_libro: bookBalance, ultima_conciliacion: null,
  });
  const GL_1111 = { id: 'acc-1111', code: '1111' };
  const GL_1112 = { id: 'acc-1112', code: '1112' };

  /** The statement a surface sent contains the helper's text once, as the lateral of the projection. */
  function readsTheLateral(text: unknown): void {
    expect(lateralCalls).toEqual([['b.gl_account_id', 'b.entity_id']]);
    const fragment = String(lateralText);
    expect(String(text).split(fragment)).toHaveLength(2);
    expect(String(text)).toContain(`LEFT JOIN LATERAL (\n      ${fragment}\n    ) libro ON true`);
  }

  /** A transaction client for `set`: answers each statement by its text, and refuses any other. */
  function client() {
    let mapped = GL_1111;
    const q = vi.fn(async (text: string) => {
      const s = String(text);
      if (s.includes('FOR UPDATE')) return { rows: [{ id: BANK }], rowCount: 1 };
      if (s.includes('libro ON true')) return { rows: [row(mapped, mapped === GL_1111 ? '750.0000' : '0')], rowCount: 1 };
      if (s.includes('FROM accounts a')) {
        return { rows: [{ ...GL_1112, name: 'Bancos 1112', account_type: 'asset', is_active: true, is_header: false, allow_manual_entries: true, moneda: 'MXN' }], rowCount: 1 };
      }
      if (s.includes('AS lines')) return { rows: [{ lines: '2', balance: '750.0000' }], rowCount: 1 };
      if (s.startsWith('UPDATE bank_accounts')) {
        mapped = GL_1112;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
    });
    return { c: { query: q } as unknown as pg.PoolClient, q };
  }

  it('show reads 750.00 from the books and 750.00 − 700.00 = 50.00 against the bank, through the report layer\'s lateral', async () => {
    pool.mockReset();
    pool.mockResolvedValueOnce({ rows: [row(GL_1111, '750.0000')] } as never);
    const shown = await getBankAccount(scope, BANK);
    expect([shown.saldoLibro, shown.saldoBanco, shown.diferencia]).toEqual(['750.00', '700.00', '50.00']);
    expect(pool).toHaveBeenCalledTimes(1);
    readsTheLateral(pool.mock.calls[0][0]);
  });

  it('list reads the same 750.00, in one statement through the same lateral', async () => {
    pool.mockReset();
    pool.mockResolvedValueOnce({ rows: [row(GL_1111, '750.0000')] } as never);
    const listed = await listBankAccounts(scope);
    expect(listed.map((r) => r.saldoLibro)).toEqual(['750.00']);
    expect(pool).toHaveBeenCalledTimes(1);
    readsTheLateral(pool.mock.calls[0][0]);
  });

  it('set asks queryPostedLinesOnAccount once, on its transaction client, and refuses naming 2 lines and 750.00', async () => {
    postedLines.mockClear();
    pool.mockReset();
    const { c, q } = client();
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(c) as never);
    const e = await setBankGlMapping(scope, BANK, '1112', { userId: 'user-1' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as Error).message).toContain('1111 ya tiene 2 líneas contabilizadas (saldo 750.00)');
    expect(postedLines.mock.calls).toEqual([[ENTITY, 'acc-1111', c]]);
    expect(q.mock.calls.filter(([s]) => String(s).includes('AS lines'))).toHaveLength(1);
    expect(pool).not.toHaveBeenCalled();
  });

  it('forced as a dry run, set reports the same 2 lines and 750.00 it read', async () => {
    postedLines.mockClear();
    const { c } = client();
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(c) as never);
    const r = await setBankGlMapping(scope, BANK, '1112', { userId: 'user-1', force: true, reason: 'Prueba', dryRun: true });
    expect([r.dryRun, r.movimientosPosteados, r.forzado]).toEqual([true, 2, true]);
    expect(r.advertencias.join(' ')).toContain('2 líneas contabilizadas de 1111 (saldo 750.00)');
    expect(r.cuenta.saldoLibro).toBe('0.00');
    expect(postedLines).toHaveBeenCalledTimes(1);
  });
});
