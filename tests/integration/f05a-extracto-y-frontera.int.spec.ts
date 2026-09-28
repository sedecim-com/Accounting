import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import {
  importarEstadoDeCuenta,
  listarEstadosDeCuenta,
  obtenerEstadoDeCuenta,
  resolverCuentaBancaria,
  verificarEstadosDeCuenta,
} from '../../src/services/banking/bank-statement-service.js';
import { leerExtracto } from '../../src/services/banking/parsers/index.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import type { LeerExtracto } from '../../src/services/banking/bank-statement-service.js';

const leer: LeerExtracto = ({ contenido, formato, perfil }) =>
  leerExtracto(contenido, { formato, perfil });

let a: Fixture;
let b: Fixture;
let cuentaA: string;
let cuentaB: string;
let dir: string;

const unaCuentaDe = (f: Fixture): string => Object.values(f.cuentas)[0];

async function cuentaBancaria(f: Fixture, nombre: string, gl: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
     VALUES ($1, $2, $3, 'Banco de prueba', $4, 'MXN', true)`,
    [id, f.entityId, nombre, gl]
  );
  return id;
}

function escribir(nombre: string, texto: string): string {
  const p = path.join(dir, nombre);
  writeFileSync(p, texto, 'utf8');
  return p;
}

const CSV_SIMPLE = [
  'fecha,descripcion,importe,saldo',
  '2026-01-05,DEPOSITO INICIAL,1000.00,1000.00',
  '2026-01-10,PAGO PROVEEDOR,-250.00,750.00',
  '',
].join('\n');

beforeAll(async () => {
  olvidarAlcances();
  dir = mkdtempSync(path.join(tmpdir(), 'f05a-aud-'));
  a = await crearInquilino('Auditoria F05a A');
  b = await crearEntidadHermana(a, 'Auditoria F05a B');
  cuentaA = await cuentaBancaria(a, 'Operativa A', a.roles.banco ?? unaCuentaDe(a));
  cuentaB = await cuentaBancaria(b, 'Operativa B', b.roles.banco ?? unaCuentaDe(b));
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('F05a · frontera de entidad', () => {
  it('import: la entidad A no puede escribir en la cuenta de B', async () => {
    const ruta = escribir('cruzado.csv', CSV_SIMPLE);
    await expect(
      importarEstadoDeCuenta(
        { entityId: a.entityId, userId: a.userId, bankAccountId: cuentaB, ruta },
        { leer }
      )
    ).rejects.toThrow(/Bank Account/i);

    const n = await query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM bank_statements WHERE bank_account_id = $1',
      [cuentaB]
    );
    expect(n.rows[0].c).toBe('0');
  });

  it('resolverCuentaBancaria: el uuid ajeno no resuelve', async () => {
    await expect(resolverCuentaBancaria(a.entityId, cuentaB)).rejects.toThrow(/Bank Account/i);
  });

  it('show / list / check: el estado de B no se ve desde A', async () => {
    const ruta = escribir('deB.csv', CSV_SIMPLE);
    const r = await importarEstadoDeCuenta(
      { entityId: b.entityId, userId: b.userId, bankAccountId: cuentaB, ruta },
      { leer }
    );
    expect(r.importadas).toBe(2);

    await expect(obtenerEstadoDeCuenta(a.entityId, r.statementId)).rejects.toThrow(
      /Bank Statement/i
    );
    const desdeA = await listarEstadosDeCuenta(a.entityId, {});
    expect(desdeA.map((x) => x.id)).not.toContain(r.statementId);
    await expect(
      verificarEstadosDeCuenta(a.entityId, r.statementId)
    ).rejects.toThrow(/Bank Statement/i);
  });
});

describe('F05a · dedupe', () => {
  it('el mismo archivo dos veces no duplica', async () => {
    const ruta = escribir('julio.csv', CSV_SIMPLE);
    const uno = await importarEstadoDeCuenta(
      { entityId: a.entityId, userId: a.userId, bankAccountId: cuentaA, ruta },
      { leer }
    );
    expect(uno.importadas).toBe(2);
    await expect(
      importarEstadoDeCuenta(
        { entityId: a.entityId, userId: a.userId, bankAccountId: cuentaA, ruta },
        { leer }
      )
    ).rejects.toThrow(/ya se importó/i);

    const n = await query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM bank_transactions WHERE bank_account_id = $1',
      [cuentaA]
    );
    expect(n.rows[0].c).toBe('2');
  });

  it('dos líneas legítimamente iguales del MISMO archivo entran las dos (#88)', async () => {
    // ESTA PRUEBA AFIRMABA EL DEFECTO. Hasta T1 exigía `importadas: 1` y
    // `duplicadas: 1`, es decir que el sistema se tragara una de las dos
    // comisiones. Y el propio archivo la desmiente: el saldo corrido va
    // 700.00 → 650.00, o sea que el banco cobró −50.00 DOS VECES y las dos
    // son ciertas.
    //
    // Lo que lo causaba: `uq_bank_tx_contenido` era ÚNICO sobre un hash de
    // (cuenta|fecha|importe|descripción), que no distingue dos hechos
    // distintos; e `insertarLineas` inserta con `ON CONFLICT DO NOTHING` sin
    // blanco, así que la segunda se perdía EN SILENCIO y se reportaba como
    // duplicada — acusando al banco de mandar un renglón repetido cuando el
    // renglón era bueno y el descuadre lo producía el sistema.
    //
    // Lo que impide reimportar sigue en pie y lo prueba el caso de arriba
    // («el mismo archivo dos veces no duplica»): la unicidad es del ARCHIVO.
    const ruta = escribir('repetida.csv', [
      'fecha,descripcion,importe,saldo',
      '2026-02-01,COMISION,-50.00,700.00',
      '2026-02-01,COMISION,-50.00,650.00',
      '',
    ].join('\n'));
    const r = await importarEstadoDeCuenta(
      { entityId: a.entityId, userId: a.userId, bankAccountId: cuentaA, ruta },
      { leer }
    );
    expect(r.lineasLeidas).toBe(2);
    expect(r.importadas).toBe(2);
    expect(r.duplicadas).toBe(0);

    // Y los libros suman lo que el banco cobró, que es el punto entero.
    const suma = await query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM bank_transactions
        WHERE bank_account_id = $1 AND description = 'COMISION'`,
      [cuentaA]
    );
    expect(Number(suma.rows[0].total)).toBe(-100);
  });

  it('content_hash lo pone el disparador, no el llamador', async () => {
    const filas = await query<{ content_hash: string; amount: string; description: string }>(
      `SELECT content_hash, amount::text AS amount, description
         FROM bank_transactions WHERE bank_account_id = $1 ORDER BY transaction_date LIMIT 1`,
      [cuentaA]
    );
    expect(filas.rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    const esperado = await query<{ h: string }>(
      `SELECT encode(sha256(($1 || '|' || $2 || '|' || $3 || '|' || $4)::bytea), 'hex') AS h`,
      [cuentaA, '2026-01-05', '1000.0000', filas.rows[0].description]
    );
    expect(filas.rows[0].content_hash).toBe(esperado.rows[0].h);
  });
});

describe('F05a · el dinero con cuatro decimales', () => {
  it('check y list no se contradicen sobre la cadena de saldos', async () => {
    const cuenta = await cuentaBancaria(a, 'Cuatro decimales', a.cuentas['1120'] ?? unaCuentaDe(a));
    const ruta = escribir('cuatro.csv', [
      'fecha,descripcion,importe,saldo',
      '2026-03-01,INTERES A,0.1250,0.1250',
      '2026-03-02,INTERES B,0.1250,0.2500',
      '',
    ].join('\n'));
    const r = await importarEstadoDeCuenta(
      { entityId: a.entityId, userId: a.userId, bankAccountId: cuenta, ruta },
      { leer }
    );
    // La suma exacta en la base: 0 + 0.1250 + 0.1250 = 0.2500 = closing.
    const enBase = await query<{ suma: string; closing: string; opening: string }>(
      `SELECT COALESCE(SUM(bt.amount),0)::text AS suma,
              s.closing_balance::text AS closing, s.opening_balance::text AS opening
         FROM bank_statements s
         LEFT JOIN bank_transactions bt ON bt.statement_id = s.id
        WHERE s.id = $1 GROUP BY s.closing_balance, s.opening_balance`,
      [r.statementId]
    );
    expect(enBase.rows[0].suma).toBe('0.2500');
    expect(enBase.rows[0].closing).toBe('0.2500');

    // `list` suma dentro del SQL y `check` suma en JS lo que le devuelve la
    // lectura: si la lectura redondea a dos decimales, los dos contestan cosas
    // distintas sobre el MISMO documento y el segundo sale 4 sobre aritmética
    // correcta.
    const [enLista] = await listarEstadosDeCuenta(a.entityId, { account: cuenta });
    const verificado = await verificarEstadosDeCuenta(a.entityId, r.statementId, {
      checks: ['cadena-de-saldos'],
    });
    expect(enLista.cadenaDeSaldos.cuadra).toBe(true);
    expect(verificado.hallazgos).toEqual([]);
    expect(verificado.bloqueantes).toBe(0);
  });

  it('la apertura derivada del saldo corrido no tira la fracción de centavo', async () => {
    const cuenta = await cuentaBancaria(a, 'Apertura derivada', a.cuentas['1130'] ?? unaCuentaDe(a));
    const ruta = escribir('derivada.csv', [
      'fecha,descripcion,importe,saldo',
      '2026-04-01,INTERES A,0.0625,0.1250',
      '2026-04-02,INTERES B,0.1250,0.2500',
      '',
    ].join('\n'));
    const r = await importarEstadoDeCuenta(
      { entityId: a.entityId, userId: a.userId, bankAccountId: cuenta, ruta },
      { leer }
    );
    // 0.1250 − 0.0625 = 0.0625, no 0.06.
    expect(r.saldoInicial).toBe('0.0625');
    const verificado = await verificarEstadosDeCuenta(a.entityId, r.statementId, {
      checks: ['cadena-de-saldos'],
    });
    expect(verificado.hallazgos).toEqual([]);
  });
});

describe('F05a · an overlapping statement does not duplicate movements (T25, #138)', () => {
  // The monthly statement, and the quarterly that contains it. The bytes
  // differ, so UNIQUE(bank_account_id, file_sha256) does not see them, and the
  // four January lines come twice. The two fees on the 20th are two real
  // charges (#88): the overlap is counted by multiplicity, not by presence.
  const MONTHLY = [
    'fecha,descripcion,importe,saldo',
    '2026-01-05,DEPOSITO,1000.00,1000.00',
    '2026-01-10,PAGO PROVEEDOR,-250.00,750.00',
    '2026-01-20,COMISION,-50.00,700.00',
    '2026-01-20,COMISION,-50.00,650.00',
    '',
  ].join('\n');
  const QUARTERLY = [
    'fecha,descripcion,importe,saldo',
    '2026-01-05,DEPOSITO,1000.00,1000.00',
    '2026-01-10,PAGO PROVEEDOR,-250.00,750.00',
    '2026-01-20,COMISION,-50.00,700.00',
    '2026-01-20,COMISION,-50.00,650.00',
    '2026-02-03,DEPOSITO,500.00,1150.00',
    '2026-03-15,PAGO PROVEEDOR,-100.00,1050.00',
    '',
  ].join('\n');

  /** Each case gets its own entity: its own bank GL account and its own panel. */
  async function freshAccount(label: string): Promise<{ f: Fixture; account: string }> {
    const f = await crearEntidadHermana(a, `Traslape ${label}`);
    const account = await cuentaBancaria(f, `Operativa ${label}`, f.roles.banco ?? unaCuentaDe(f));
    return { f, account };
  }

  function importInto(f: Fixture, account: string, file: string, text: string) {
    return importarEstadoDeCuenta(
      { entityId: f.entityId, userId: f.userId, bankAccountId: account, ruta: escribir(file, text) },
      { leer }
    );
  }

  async function monthlyThenQuarterly(label: string, policy?: string) {
    const { f, account } = await freshAccount(label);
    if (policy !== undefined) {
      const ctx = { tenantId: f.tenantId, entityId: f.entityId };
      await seedPolicies(ctx);
      await resolvePolicy(ctx, 'bank_statement_overlap', policy, f.userId);
    }
    const monthly = await importInto(f, account, `enero-${label}.csv`, MONTHLY);
    expect(monthly.importadas).toBe(4);
    expect(monthly.overlaps).toEqual([]);
    return {
      f,
      account,
      monthlyId: monthly.statementId,
      quarterly: () => importInto(f, account, `t1-${label}.csv`, QUARTERLY),
    };
  }

  async function linesIn(account: string): Promise<number> {
    const n = await query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM bank_transactions WHERE bank_account_id = $1',
      [account]
    );
    return Number(n.rows[0].c);
  }

  it('a line skipped by its native bank id is named with that cause, not counted by subtraction', async () => {
    const { f, account } = await freshAccount('id-nativo');
    const header = 'fecha,descripcion,importe,saldo,referencia';
    const first = await importInto(f, account, 'ref-1.csv', [header, '2026-05-02,SPEI,300.00,300.00,R-001', ''].join('\n'));
    const second = await importInto(f, account, 'ref-2.csv', [
      header,
      '2026-05-02,SPEI,300.00,300.00,R-001',
      '2026-05-09,SPEI,40.00,340.00,R-002',
      '',
    ].join('\n'));
    expect(second.importadas).toBe(1);
    expect(second.skipped).toEqual([
      expect.objectContaining({
        line: 1,
        date: '2026-05-02',
        amount: '300.00',
        reference: 'R-001',
        cause: 'native-id-already-in-account',
        existingStatementId: first.statementId,
      }),
    ]);
    expect(second.duplicadas).toBe(1);
    expect(second.avisos.join('\n')).toMatch(/línea 1 .*R-001/);
  });

  it('by default the quarterly over the monthly is refused, naming each line already there', async () => {
    const { account, quarterly } = await monthlyThenQuarterly('bloquear');
    await expect(quarterly()).rejects.toThrow(
      /4 línea\(s\).*enero-bloquear\.csv[\s\S]*línea 1 · 2026-01-05 · 1000\.00 · DEPOSITO[\s\S]*línea 4 · 2026-01-20 · -50\.00 · COMISION/
    );
    // Nothing of the quarterly entered: not the overlap, not the new lines.
    expect(await linesIn(account)).toBe(4);
    const stmts = await query<{ c: string }>(
      'SELECT COUNT(*)::text AS c FROM bank_statements WHERE bank_account_id = $1',
      [account]
    );
    expect(stmts.rows[0].c).toBe('1');
  });

  it('with "mark" the quarterly enters and each overlapping line carries the statement it overlaps', async () => {
    const { f, account, monthlyId, quarterly } = await monthlyThenQuarterly('marcar', 'mark');
    const r = await quarterly();
    expect(r.importadas).toBe(6);
    expect(r.overlaps.map((o) => [o.line, o.existingStatementId])).toEqual([
      [1, monthlyId], [2, monthlyId], [3, monthlyId], [4, monthlyId],
    ]);
    expect(await linesIn(account)).toBe(10);

    // The mark is durable: `show --lines` reads it back from the line.
    const shown = await obtenerEstadoDeCuenta(f.entityId, r.statementId, { lineas: true });
    const marked = (shown.lineas ?? []).filter((l) => l.overlap !== null);
    expect(marked).toHaveLength(4);
    expect(new Set(marked.map((l) => l.overlap))).toEqual(new Set([monthlyId]));
    expect((shown.lineas ?? []).filter((l) => l.overlap === null).map((l) => l.fecha)).toEqual([
      '2026-02-03', '2026-03-15',
    ]);
  });

  it('with "warn" the quarterly enters, the import names the overlap, and no line is marked', async () => {
    const { f, monthlyId, quarterly } = await monthlyThenQuarterly('avisar', 'warn');
    const r = await quarterly();
    expect(r.importadas).toBe(6);
    expect(r.overlaps).toHaveLength(4);
    expect(r.overlaps.every((o) => o.existingStatementId === monthlyId)).toBe(true);
    expect(r.avisos.join('\n')).toMatch(/4 línea\(s\).*enero-avisar\.csv/);
    const shown = await obtenerEstadoDeCuenta(f.entityId, r.statementId, { lineas: true });
    expect((shown.lineas ?? []).every((l) => l.overlap === null)).toBe(true);
  });

  it('the overlap is counted by multiplicity: a reissue that adds a second identical fee overlaps only once', async () => {
    const { f, account } = await freshAccount('reemitido');
    await importInto(f, account, 'feb.csv', [
      'fecha,descripcion,importe,saldo',
      '2026-02-01,COMISION,-50.00,-50.00',
      '',
    ].join('\n'));
    // Under the default "block" this refuses; what is under test is WHICH
    // lines it names: one of the two fees is already there, the other is new.
    await expect(
      importInto(f, account, 'feb-corregido.csv', [
        'fecha,descripcion,importe,saldo',
        '2026-02-01,COMISION,-50.00,-50.00',
        '2026-02-01,COMISION,-50.00,-100.00',
        '',
      ].join('\n'))
    ).rejects.toThrow(/^1 línea\(s\).*: línea 1 · 2026-02-01 · -50\.00 · COMISION \(en feb\.csv\)\. /);
  });
});
