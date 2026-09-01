import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, postJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  updateDraftEntry,
  previewEntryPosting,
  listEntriesWithLines,
} from '../../src/services/accounting/journal-entry-service.js';
import {
  setAccountGovernance,
  getAccountBalanceByPeriod,
  setAccountMapping,
  checkMappingCoverage,
  resolveAccount,
} from '../../src/services/accounting/account-service.js';
import { setAccountRole, listAccountRoles } from '../../src/services/accounting/account-roles-service.js';
import { runLedgerChecks, listStaleDrafts } from '../../src/services/accounting/ledger-checks.js';
import { parseImportFile, stageEntryImport } from '../../src/services/accounting/entry-import-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * F01 · CATÁLOGO Y ASIENTO MANUAL, contra la base real: las banderas de
 * gobierno respetando el CHECK, el rol reapuntado por sus dos ramas, el
 * mapeo estatutario con su cobertura, la edición de borrador con rastro,
 * el preview sin escritura, el lote de importación (045), las
 * verificaciones del mayor cazando una deriva sembrada — y el
 * maker-checker de punta a punta con la política resuelta y dos usuarios.
 */

let f: Fixture;
let segundoUsuario: string;

const ctxDe = (fx: Fixture) => ({ tenantId: fx.tenantId, entityId: fx.entityId });

beforeAll(async () => {
  f = await crearInquilino('F01 catálogo y mayor');
  segundoUsuario = uuidv4();
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
      roles, permissions, accessible_entities, is_active)
     VALUES ($1, $2, $3, 'x', 'Segundo', 'Revisor',
      '["accountant"]'::jsonb, '["journal_entries:post"]'::jsonb, $4::jsonb, true)`,
    [segundoUsuario, f.tenantId, `revisor-${segundoUsuario.slice(0, 8)}@example.test`,
     JSON.stringify([f.entityId])]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('gobierno del catálogo', () => {
  it('las banderas se escriben y el CHECK de la 001 se traduce antes de morir crudo', async () => {
    const cuenta = await resolveAccount(f.entityId, '6100');
    const con = await setAccountGovernance(cuenta.id, { is_control_account: true }, f.userId);
    expect(con.is_control_account).toBe(true);
    await expect(
      setAccountGovernance(cuenta.id, { is_header: true }, f.userId)
    ).rejects.toThrow(/agrupadora/);
  });

  it('role set reapunta el default y crea la variante calificada — sin duplicar el caso común', async () => {
    const banco2 = await resolveAccount(f.entityId, '1111');
    const r1 = await setAccountRole(f.entityId, f.tenantId, 'banco', banco2.id, {});
    expect(r1.accion).toBe('reapuntado'); // la siembra ya lo tenía
    const r2 = await setAccountRole(f.entityId, f.tenantId, 'banco', banco2.id, { qualifier: 'usd' });
    expect(r2.accion).toBe('creado');
    const roles = await listAccountRoles(f.entityId, { role: 'banco' });
    expect(roles).toHaveLength(2);
    expect(roles[0].account_code).toBe('1111');
  });

  it('el mapeo estatutario se fija y la cobertura lo ve encogerse', async () => {
    const antes = await checkMappingCoverage(f.entityId, 'sat-agrupador', 2);
    const cuenta = await resolveAccount(f.entityId, '6100');
    await setAccountMapping(cuenta.id, 'sat-agrupador', '601.84', f.userId);
    const despues = await checkMappingCoverage(f.entityId, 'sat-agrupador', 2);
    expect(despues.length).toBe(antes.length - 1);
    expect(despues.some((h) => h.code === '6100')).toBe(false);
  });
});

describe('el asiento manual: editar, previsualizar, exportar, importar', () => {
  it('editar un borrador reemplaza líneas, el trigger recalcula y el rastro queda en la MISMA transacción', async () => {
    const borrador = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'para editar',
      [
        { account_id: f.roles.banco, debit_amount: '10.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '10.00', description: 'a' },
      ],
      f.userId
    );
    const editada = await updateDraftEntry(
      f.entityId, borrador.entry_number,
      {
        description: 'editada por F01',
        lines: [
          { account: '1110', debit: '25.00' },
          { account: '1120', credit: '25.00' },
        ],
      },
      f.userId
    );
    expect(editada.description).toBe('editada por F01');
    expect(editada.total_debits).toBe('25.0000');

    const rastro = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log
        WHERE entity_type = 'journal_entries' AND entity_id = $1 AND action = 'update'`,
      [borrador.id]
    );
    expect(Number(rastro.rows[0].n)).toBe(1);

    // El preview refleja lo editado, sin escribir nada.
    const p = await previewEntryPosting(f.entityId, borrador.entry_number);
    expect(p.deltas.find((d) => d.account_code === '1110')?.cargo).toBe('25.0000');
    expect(p.advertencias).toEqual([]);
  });

  it('exportar trae pólizas CON líneas en un solo viaje', async () => {
    const filas = await listEntriesWithLines(f.entityId, {});
    expect(filas.length).toBeGreaterThanOrEqual(2);
    expect(filas[0]).toHaveProperty('account_code');
    expect(filas[0]).toHaveProperty('debit_amount');
  });

  it('importar prepara el lote (045) sin tocar journal_entries', async () => {
    const antes = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId]
    );
    const lote = parseImportFile(
      'ndjson',
      '{"date":"2026-08-15","description":"importada","lines":[{"account":"6100","debit":"30"},{"account":"1110","credit":"30"}]}\n' +
        'basura\n'
    );
    const r = await stageEntryImport(
      ctxDe(f), { layout: 'ndjson', fileName: 'lote.ndjson', fileHash: 'abc', lote }, 'victor@test'
    );
    expect(r.validas).toBe(1);
    expect(r.invalidas).toBe(1);
    const filas = await query<{ parse_error: string | null }>(
      `SELECT parse_error FROM journal_entry_import_rows WHERE batch_id = $1 ORDER BY row_number`,
      [r.batchId]
    );
    expect(filas.rows).toHaveLength(2);
    const despues = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`, [f.entityId]
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n); // el mayor ni se enteró
  });
});

describe('el mayor se verifica', () => {
  it('ledger check caza una deriva sembrada en account_balances y sale limpio al repararla', async () => {
    const limpio = await runLedgerChecks(f.entityId, ['balance'], {});
    expect(limpio).toEqual([]);

    // Sembrar deriva: una fila de saldos que las líneas no respaldan.
    const cuenta = await resolveAccount(f.entityId, '6100');
    await query(
      `INSERT INTO account_balances (account_id, fiscal_period_id, entity_id, debit_total, credit_total, ending_balance)
       VALUES ($1, $2, $3, 999, 0, 999)
       ON CONFLICT (account_id, fiscal_period_id)
       DO UPDATE SET debit_total = account_balances.debit_total + 999, ending_balance = account_balances.ending_balance + 999`,
      [cuenta.id, f.periodos[8], f.entityId]
    );
    const conDeriva = await runLedgerChecks(f.entityId, ['balance'], { account: '6100' });
    expect(conDeriva.length).toBeGreaterThan(0);
    expect(conDeriva[0].severity).toBe('blocking');

    await query(
      `DELETE FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`,
      [cuenta.id, f.periodos[8]]
    );
  });

  it('stale-draft list ve el borrador viejo y respeta el corte de días', async () => {
    const viejo = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'borrador olvidado',
      [
        { account_id: f.roles.banco, debit_amount: '5.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '5.00', description: 'a' },
      ],
      f.userId
    );
    await query(`UPDATE journal_entries SET created_at = NOW() - INTERVAL '45 days' WHERE id = $1`, [viejo.id]);
    const lista = await listStaleDrafts(f.entityId, { days: 30 });
    expect(lista.some((b) => b.entry_number === viejo.entry_number)).toBe(true);
    const corta = await listStaleDrafts(f.entityId, { days: 60 });
    expect(corta.some((b) => b.entry_number === viejo.entry_number)).toBe(false);
  });

  it('el saldo por periodo descompone y dice el estado del periodo', async () => {
    // account_balances nace al POSTEAR: un asiento aplicado da la fila.
    await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'para el saldo',
      [
        { account_id: f.roles.banco, debit_amount: '12.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '12.00', description: 'a' },
      ],
      f.userId, { autoPost: true }
    );
    const cuenta = await resolveAccount(f.entityId, '1110');
    const filas = await getAccountBalanceByPeriod(f.entityId, cuenta.id, {});
    expect(filas.length).toBeGreaterThan(0);
    expect(filas[0].debit_total).toBe('12.0000');
    expect(filas[0].period_status).toBeTruthy();
  });
});

describe('maker-checker de punta a punta', () => {
  it("con la política en 'exigir': el creador rebota, el segundo usuario postea", async () => {
    await seedPolicies(ctxDe(f));
    await resolvePolicy(ctxDe(f), 'segregacion_de_funciones', 'exigir', 'victor@test');

    const borrador = await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'manual bajo SoD',
      [
        { account_id: f.roles.banco, debit_amount: '40.00', credit_amount: null, description: 'c' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '40.00', description: 'a' },
      ],
      f.userId
    );

    await expect(postJournalEntry(borrador.id, f.userId)).rejects.toThrow(/segregación de funciones/);

    const posteada = await postJournalEntry(borrador.id, segundoUsuario);
    expect(posteada.status).toBe('posted');
    expect(posteada.posted_by).toBe(segundoUsuario);
    expect(posteada.created_by).toBe(f.userId);
  });
});
