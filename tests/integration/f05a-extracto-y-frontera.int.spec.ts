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

  it('una línea repetida dentro del MISMO archivo entra una sola vez', async () => {
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
    expect(r.importadas).toBe(1);
    expect(r.duplicadas).toBe(1);
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
