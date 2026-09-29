import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { olvidarAlcances } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  importarEstadoDeCuenta,
  type LeerExtracto,
} from '../../src/services/banking/bank-statement-service.js';
import { leerExtracto } from '../../src/services/banking/parsers/index.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  contabilizarComisiones,
  FEE_VAT_RELEASE_SOURCE,
  ORIGEN_COMISION,
} from '../../src/services/banking/treasury-posting.js';

// ============================================================
// MNE-001-041 (#95): the fee's VAT leaves 1135.
//
// `bank fee post` parked the VAT of every fee in 1135 and told the accountant
// to credit it with `bank fee apply`, a command that does not exist. Nothing
// else reached a `bank_fee` entry, so each 48.00 stayed there for good. Here a
// BBVA CSV is imported, its fee posted, and 1135 must end at 0 with the VAT in
// 1130; a fee posted the old way is freed when its month runs again.
// ============================================================

const read: LeerExtracto = (input) =>
  leerExtracto(input.contenido, { formato: input.formato, perfil: input.perfil });

const BBVA = [
  'BBVA MEXICO - MOVIMIENTOS DE LA CUENTA',
  '',
  'FECHA,DESCRIPCIÓN,REFERENCIA,CARGO,ABONO,SALDO',
  '31/03/2026,COMISION MANEJO DE CUENTA,REF-003,348.00,,"8,536.00"',
  '',
].join('\n');

let a: Fixture;
let account: string;
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

/** Debits minus credits of one account over the entity's posted entries. */
async function balance(accountId: string): Promise<string> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::numeric(19,4)::text AS s
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND l.account_id = $2`,
    [a.entityId, accountId]
  );
  return r.rows[0].s;
}

async function feeLine(): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM bank_transactions WHERE bank_account_id = $1 AND transaction_type = 'fee'`,
    [account]
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0].id;
}

beforeAll(async () => {
  olvidarAlcances();
  dir = mkdtempSync(path.join(tmpdir(), 'mne-001-041-'));
  a = await crearInquilino('MNE-001-041');
  account = await bankAccount(a, 'BBVA Operativa');
  const file = path.join(dir, 'bbva-marzo.csv');
  writeFileSync(file, BBVA, 'latin1');
  await importarEstadoDeCuenta(
    { entityId: a.entityId, userId: a.userId, bankAccountId: account, ruta: file },
    { leer: read }
  );
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-041 · bank fee post releases the fee VAT', () => {
  it('a dry run shows the release and writes nothing', async () => {
    const r = await contabilizarComisiones(a.entityId, account, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: a.userId,
      dryRun: true,
    });
    expect(r.releases.map((v) => [v.iva, v.entryId])).toEqual([['48.0000', null]]);
    expect(await balance(a.roles.iva_acreditable)).toBe('0.0000');
  });

  it('posting a BBVA fee leaves 1135 at 0 and its 48.0000 in 1130', async () => {
    const fee = await feeLine();
    const r = await contabilizarComisiones(a.entityId, account, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: a.userId,
    });
    expect(r.contabilizadas.map((c) => c.iva)).toEqual(['48.0000']);
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0]).toMatchObject({ transactionId: fee, date: '2026-03-31', iva: '48.0000' });
    expect(r.totales.ivaReleased).toBe('48.0000');

    expect(await balance(a.roles.iva_pendiente_acreditar)).toBe('0.0000');
    expect(await balance(a.roles.iva_acreditable)).toBe('48.0000');

    // The release is its own entry, dated the day of the charge.
    const entries = await query<{ source_type: string; entry_date: string }>(
      `SELECT source_type, entry_date::text AS entry_date FROM journal_entries
        WHERE entity_id = $1 AND source_id = $2 ORDER BY source_type`,
      [a.entityId, fee]
    );
    expect(entries.rows).toEqual([
      { source_type: ORIGEN_COMISION, entry_date: '2026-03-31' },
      { source_type: FEE_VAT_RELEASE_SOURCE, entry_date: '2026-03-31' },
    ]);
  });

  it('running the month again releases nothing twice', async () => {
    const r = await contabilizarComisiones(a.entityId, account, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: a.userId,
    });
    expect(r.omitidas.map((o) => o.motivo)).toEqual(['ya-contabilizada']);
    expect(r.releases).toEqual([]);
    expect(await balance(a.roles.iva_pendiente_acreditar)).toBe('0.0000');
    expect(await balance(a.roles.iva_acreditable)).toBe('48.0000');
  });

  it('frees, to the last decimal, the VAT of a fee posted before the release existed', async () => {
    // A fee of 116.1234 posted the old way: its VAT parked in 1135, no release.
    const legacy = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, description, transaction_type)
       VALUES ($1, $2, '2026-03-15', -116.1234, 'COMISION SPEI', 'fee')`,
      [legacy, account]
    );
    await createJournalEntry(
      a.entityId,
      new Date('2026-03-15T00:00:00'),
      JournalEntryType.AUTO_RECONCILIATION,
      'Bank fee 2026-03-15 - COMISION SPEI',
      [
        { account_id: a.roles.comision_bancaria, debit_amount: '100.1064', credit_amount: null, description: 'fee' },
        { account_id: a.roles.iva_pendiente_acreditar, debit_amount: '16.0170', credit_amount: null, description: 'vat' },
        { account_id: a.roles.banco ?? Object.values(a.cuentas)[0], debit_amount: null, credit_amount: '116.1234', description: 'bank' },
      ],
      a.userId,
      { autoPost: true, sourceType: ORIGEN_COMISION, sourceId: legacy, reference: '2026-03-15' }
    );
    expect(await balance(a.roles.iva_pendiente_acreditar)).toBe('16.0170');

    const r = await contabilizarComisiones(a.entityId, account, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: a.userId,
    });
    expect(r.contabilizadas).toEqual([]);
    expect(r.releases.map((v) => [v.transactionId, v.iva])).toEqual([[legacy, '16.0170']]);
    expect(await balance(a.roles.iva_pendiente_acreditar)).toBe('0.0000');
    expect(await balance(a.roles.iva_acreditable)).toBe('64.0170');
  });

  it('does not credit IVA for an entity that does not keep cash-basis VAT', async () => {
    const us = await crearInquilino('MNE-001-041 US', { pais: 'US', norma: 'us_gaap', moneda: 'MXN' });
    const usAccount = await bankAccount(us, 'US Operating');
    // Even with a pending-VAT account mapped, nothing is moved to creditable.
    const parking = us.roles.cxc;
    expect(parking).toBeDefined();
    await query(
      'INSERT INTO account_roles (tenant_id, entity_id, role, account_id) VALUES ($1, $2, $3, $4)',
      [us.tenantId, us.entityId, 'iva_pendiente_acreditar', parking]
    );
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, description, transaction_type)
       VALUES ($1, $2, '2026-03-20', -348, 'SERVICE FEE', 'fee')`,
      [uuidv4(), usAccount]
    );
    const r = await contabilizarComisiones(us.entityId, usAccount, {
      periodo: '2026-03',
      iva: { modo: 'tasa', tasa: '0.16' },
      userId: us.userId,
    });
    expect(r.contabilizadas).toHaveLength(1);
    expect(r.releases).toEqual([]);
  });
});
