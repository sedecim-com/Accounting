import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import {
  importarEstadoDeCuenta,
  type LeerExtracto,
} from '../../src/services/banking/bank-statement-service.js';
import { leerExtracto } from '../../src/services/banking/parsers/index.js';
import { reclassifyTransaction } from '../../src/services/banking/transactions.js';
import { contabilizarComisiones } from '../../src/services/banking/treasury-posting.js';

// ============================================================
// MNE-001-040 (#95): the bank fee reaches `bank fee post`.
//
// Before this slice «COMISION MANEJO DE CUENTA -348.00» from a BBVA CSV came
// in as 'debit', `bank fee post` selected zero rows and exited 0. Here the
// whole path runs against Postgres: import the file, read the type the
// importer wrote, see the fee engine find it, and correct a line the
// classifier missed with `reclassifyTransaction`, including its refusals.
// ============================================================

const read: LeerExtracto = (input) =>
  leerExtracto(input.contenido, { formato: input.formato, perfil: input.perfil });

const BBVA = [
  'BBVA MEXICO - MOVIMIENTOS DE LA CUENTA',
  '',
  'FECHA,DESCRIPCIÓN,REFERENCIA,CARGO,ABONO,SALDO',
  '05/03/2026,PAGO PROVEEDOR ACME,REF-001,"1,000.00",,"9,000.00"',
  '10/03/2026,CARGO DOMICILIADO SERVICIO BANCA,REF-002,116.00,,"8,884.00"',
  '31/03/2026,COMISION MANEJO DE CUENTA,REF-003,348.00,,"8,536.00"',
  '31/03/2026,INTERESES GANADOS,REF-004,,12.34,"8,548.34"',
  '',
].join('\n');

let a: Fixture;
let b: Fixture;
let accountA: string;
let dir: string;

async function bankAccount(f: Fixture, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
     VALUES ($1, $2, $3, 'BBVA', $4, 'MXN', true)`,
    [id, f.entityId, name, f.roles.banco ?? Object.values(f.cuentas)[0]]
  );
  return id;
}

async function lineByDescription(description: string): Promise<{ id: string; transaction_type: string }> {
  const r = await query<{ id: string; transaction_type: string }>(
    'SELECT id, transaction_type FROM bank_transactions WHERE bank_account_id = $1 AND description = $2',
    [accountA, description]
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0];
}

beforeAll(async () => {
  olvidarAlcances();
  dir = mkdtempSync(path.join(tmpdir(), 'mne-001-040-'));
  a = await crearInquilino('MNE-001-040 A');
  b = await crearEntidadHermana(a, 'MNE-001-040 B');
  accountA = await bankAccount(a, 'BBVA Operativa');
  const file = path.join(dir, 'bbva-marzo.csv');
  writeFileSync(file, BBVA, 'latin1');
  await importarEstadoDeCuenta(
    { entityId: a.entityId, userId: a.userId, bankAccountId: accountA, ruta: file },
    { leer: read }
  );
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-040 · import classifies the fee and the interest', () => {
  it('«COMISION MANEJO DE CUENTA -348.00» from a BBVA CSV comes in as fee', async () => {
    expect((await lineByDescription('COMISION MANEJO DE CUENTA')).transaction_type).toBe('fee');
    expect((await lineByDescription('INTERESES GANADOS')).transaction_type).toBe('interest');
    expect((await lineByDescription('PAGO PROVEEDOR ACME')).transaction_type).toBe('debit');
  });

  it('`bank fee post` finds it instead of selecting zero rows', async () => {
    const r = await contabilizarComisiones(a.entityId, accountA, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: a.userId,
      dryRun: true,
    });
    expect(r.contabilizadas.map((c) => c.total)).toEqual(['348.0000']);
  });
});

describe('MNE-001-040 · bank transaction reclassify', () => {
  it('turns a charge the classifier missed into a fee, with an audit row', async () => {
    const line = await lineByDescription('CARGO DOMICILIADO SERVICIO BANCA');
    expect(line.transaction_type).toBe('debit');

    const dry = await reclassifyTransaction(a.entityId, line.id, 'fee', { userId: a.userId, dryRun: true });
    expect(dry).toMatchObject({ previousType: 'debit', type: 'fee', changed: true, dryRun: true });
    expect((await lineByDescription('CARGO DOMICILIADO SERVICIO BANCA')).transaction_type).toBe('debit');

    const r = await reclassifyTransaction(a.entityId, line.id, 'FEE', {
      userId: a.userId,
      reason: 'Monthly banking service',
    });
    expect(r).toMatchObject({ previousType: 'debit', type: 'fee', changed: true, amount: '-116.0000' });
    expect((await lineByDescription('CARGO DOMICILIADO SERVICIO BANCA')).transaction_type).toBe('fee');

    const audit = await query<{ old_values: unknown; new_values: unknown; reason: string }>(
      `SELECT old_values, new_values, reason FROM audit_log
        WHERE entity_type = 'bank_transactions' AND entity_id = $1`,
      [line.id]
    );
    expect(audit.rows).toEqual([
      {
        old_values: { transaction_type: 'debit' },
        new_values: { transaction_type: 'fee' },
        reason: 'Monthly banking service',
      },
    ]);

    const again = await reclassifyTransaction(a.entityId, line.id, 'fee', { userId: a.userId });
    expect(again.changed).toBe(false);
  });

  it('refuses a type whose sign contradicts the amount', async () => {
    const line = await lineByDescription('PAGO PROVEEDOR ACME');
    await expect(reclassifyTransaction(a.entityId, line.id, 'interest', { userId: a.userId })).rejects.toThrow(
      /exige un importe/
    );
    await expect(reclassifyTransaction(a.entityId, line.id, 'bogus', { userId: a.userId })).rejects.toThrow(
      /no es un tipo de movimiento/
    );
  });

  it('does not see a line of another entity', async () => {
    const line = await lineByDescription('PAGO PROVEEDOR ACME');
    await expect(reclassifyTransaction(b.entityId, line.id, 'fee', { userId: b.userId })).rejects.toThrow(
      /Bank Transaction/
    );
    await expect(reclassifyTransaction(a.entityId, 'not-a-uuid', 'fee', { userId: a.userId })).rejects.toThrow(
      /Bank Transaction/
    );
  });

  it('refuses a matched line, and a line a treasury entry already posted', async () => {
    const fee = await lineByDescription('COMISION MANEJO DE CUENTA');
    const posted = await contabilizarComisiones(a.entityId, accountA, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: a.userId,
    });
    expect(posted.contabilizadas.map((c) => c.transactionId)).toContain(fee.id);

    // `bank fee post` ties the line to the entry it creates.
    await expect(reclassifyTransaction(a.entityId, fee.id, 'debit', { userId: a.userId })).rejects.toThrow(
      /está cotejado/
    );

    // Even with the flag cleared, the entry in 6310 still says it is a fee.
    await query('UPDATE bank_transactions SET is_matched = false WHERE id = $1', [fee.id]);
    await expect(reclassifyTransaction(a.entityId, fee.id, 'debit', { userId: a.userId })).rejects.toThrow(
      /ya lo contabilizó la póliza/
    );
    expect((await lineByDescription('COMISION MANEJO DE CUENTA')).transaction_type).toBe('fee');
  });
});
