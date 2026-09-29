import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { crearAjuste } from '../../src/services/banking/reconciliation-adjustments.js';
import {
  abrirSesion,
  aprobarSesion,
  cerrarSesion,
  clasificarPartidasDeSesion,
  contabilizarSesion,
  estadoDeSesion,
  reopenSession,
} from '../../src/services/banking/reconciliation-service.js';

/**
 * MNE-001-130 (#302) · REOPENING A POSTED RECONCILIATION, AGAINST POSTGRES.
 *
 * A posted session carries an adjustment entry in the ledger. Reopening it has
 * to undo `post` without deleting anything: the entry is reversed, the
 * adjustment becomes a pending draft again, the match and the seal `post`
 * wrote are closed, and the item it explained is open again. The proof is the
 * round trip: the SAME range closes, signs and posts again, and the book
 * balance and the variance are the ones the first pass produced.
 */

let f: Fixture;
let account: string;
let glBank: string;
let sessionId: string;
let secondUser: string;
let adjustmentId: string;
let firstDraft: string;
let firstEntry: string;
let firstGroup: string;
let bankTx: string;

const scope = () => entityScope(f.tenantId, f.entityId);

async function entryCount(): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
    [f.entityId]
  );
  return parseInt(r.rows[0].n, 10);
}

async function sessionStatus(): Promise<{ status: string; posted_at: string | null }> {
  const r = await query<{ status: string; posted_at: string | null }>(
    `SELECT status, posted_at::text AS posted_at FROM reconciliation_sessions WHERE id = $1`,
    [sessionId]
  );
  return r.rows[0];
}

beforeAll(async () => {
  f = await crearInquilino('Probe MNE-001-130');
  glBank = f.roles.banco ?? Object.values(f.cuentas)[0];
  const feeAccount = (
    await query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [
      f.roles.comision_bancaria,
    ])
  ).rows[0].code;

  secondUser = uuidv4();
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name,
       roles, permissions, accessible_entities, is_active)
     VALUES ($1,$2,$3,'x','Second','Signer','["owner"]'::jsonb,'["*"]'::jsonb,$4::jsonb,true)`,
    [secondUser, f.tenantId, `it2-${secondUser.slice(0, 8)}@example.test`,
     JSON.stringify([f.entityId])]
  );

  account = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_type)
     VALUES ($1,$2,'Operativa 130','Banco',$3,'MXN','checking')`,
    [account, f.entityId, glBank]
  );

  // A month whose only difference is a bank fee the books do not carry:
  // bank -350, books 0. The adjustment books it at post.
  const statement = uuidv4();
  await query(
    `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
       opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
     VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,-350,'MXN','csv',$4,$5)`,
    [statement, f.entityId, account, 'f'.repeat(64), f.userId]
  );
  bankTx = uuidv4();
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched, statement_id)
     VALUES ($1,$2,'2026-08-20',-350,'debit','comision de manejo de cuenta',false,$3)`,
    [bankTx, account, statement]
  );

  sessionId = (await abrirSesion(scope(), { cuenta: account, periodo: '2026-08' }, { userId: f.userId }))
    .sesionId;
  await clasificarPartidasDeSesion(scope(), sessionId, { userId: f.userId });
  const item = (
    await query<{ id: string }>(
      `SELECT id FROM reconciling_items WHERE reconciliation_session_id = $1`,
      [sessionId]
    )
  ).rows[0].id;
  await query(
    `UPDATE reconciling_items SET fecha_esperada = '2026-09-15', responsable = 'tesoreria'
      WHERE id = $1`,
    [item]
  );
  const adj = await crearAjuste(
    f.entityId,
    sessionId,
    { tipo: 'comision', cuenta: feeAccount, importe: '-350.00' },
    f.userId,
    { reconcilingItemId: item }
  );
  adjustmentId = adj.id;
  firstDraft = adj.draftId;

  expect((await cerrarSesion(scope(), sessionId, {}, { userId: f.userId })).estado).toBe('balanced');
  await aprobarSesion(scope(), sessionId, { motivo: 'August statement' }, { userId: secondUser });
  const posted = await contabilizarSesion(scope(), sessionId, {}, { userId: secondUser });
  expect(posted.posteados).toBe(1);
  firstEntry = posted.asientos[0].journalEntryId;
  firstGroup = posted.grupoDelSello as string;

  const e = await estadoDeSesion(scope(), { sesionId: sessionId });
  expect(e.aritmetica.libros.saldo).toBe('-350.00');
  expect(e.aritmetica.variacion).toBe('0.00');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-130 · a posted session still answers to the fiscal period', () => {
  it('refuses while the period is closed and reverses nothing', async () => {
    const before = await entryCount();
    await query(`UPDATE fiscal_periods SET status = 'soft_close' WHERE id = $1`, [f.periodos[8]]);
    try {
      await expect(
        reopenSession(scope(), sessionId, { reason: 'wrong fee' }, { userId: f.userId })
      ).rejects.toThrow(/mnemosine period reopen "Periodo 8\/2026"/);
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [f.periodos[8]]);
    }
    expect((await sessionStatus()).status).toBe('posted');
    expect(await entryCount()).toBe(before);
  });
});

describe('MNE-001-130 · reopening a posted session reverses its entries', () => {
  it('the dry run announces the entry it would reverse and writes nothing', async () => {
    const before = await entryCount();
    const r = await reopenSession(
      scope(),
      sessionId,
      { reason: 'wrong fee' },
      { userId: f.userId, dryRun: true }
    );
    expect(r.dryRun).toBe(true);
    expect(r.previousStatus).toBe('posted');
    expect(r.reversals).toHaveLength(1);
    expect(r.reversals[0].entryId).toBe(firstEntry);
    expect(r.reversals[0].adjustmentId).toBe(adjustmentId);
    expect(r.reversals[0].reversalNumber).toBeTruthy();

    expect(await entryCount()).toBe(before);
    expect((await sessionStatus()).status).toBe('posted');
    const entry = await query<{ reversed_by_entry_id: string | null }>(
      `SELECT reversed_by_entry_id FROM journal_entries WHERE id = $1`,
      [firstEntry]
    );
    expect(entry.rows[0].reversed_by_entry_id).toBeNull();
  });

  it('reverses the entry, never deletes it, and leaves the session as it was before post', async () => {
    const before = await entryCount();
    const r = await reopenSession(
      scope(),
      sessionId,
      { reason: 'the fee was charged twice by the bank' },
      { userId: f.userId }
    );
    expect(r.dryRun).toBe(false);
    expect(r.status).toBe('in_progress');
    const [rev] = r.reversals;

    const row = await sessionStatus();
    expect(row.status).toBe('in_progress');
    expect(row.posted_at).toBeNull();

    // The ledger: one entry more, none less. The original stays posted and
    // points at its mirror, dated on its own date inside the reopened range.
    expect(await entryCount()).toBe(before + 1);
    const entries = await query<{ id: string; status: string; entry_type: string; entry_date: string; reversed_by_entry_id: string | null }>(
      `SELECT id, status, entry_type, entry_date::text AS entry_date, reversed_by_entry_id
         FROM journal_entries WHERE id = ANY($1::uuid[])`,
      [[firstEntry, rev.reversalId]]
    );
    const original = entries.rows.find((e) => e.id === firstEntry);
    const mirror = entries.rows.find((e) => e.id === rev.reversalId);
    expect(original?.status).toBe('posted');
    expect(original?.reversed_by_entry_id).toBe(rev.reversalId);
    expect(mirror?.status).toBe('posted');
    expect(mirror?.entry_type).toBe('reversing');
    expect(mirror?.entry_date).toBe(original?.entry_date);

    // The adjustment is a promise again, on a NEW pending draft; the old
    // draft keeps its approval and its entry.
    const adj = await query<{ journal_entry_id: string | null; draft_id: string }>(
      `SELECT journal_entry_id, draft_id FROM reconciliation_adjustments WHERE id = $1`,
      [adjustmentId]
    );
    expect(adj.rows[0].journal_entry_id).toBeNull();
    expect(adj.rows[0].draft_id).toBe(rev.newDraftId);
    const drafts = await query<{ id: string; status: string; journal_entry_id: string | null; payload: unknown }>(
      `SELECT id, status, journal_entry_id, payload FROM ai_drafts WHERE id = ANY($1::uuid[])`,
      [[firstDraft, rev.newDraftId]]
    );
    const oldDraft = drafts.rows.find((d) => d.id === firstDraft);
    const newDraft = drafts.rows.find((d) => d.id === rev.newDraftId);
    expect(oldDraft?.status).toBe('approved');
    expect(oldDraft?.journal_entry_id).toBe(firstEntry);
    expect(newDraft?.status).toBe('pending_review');
    expect(newDraft?.payload).toEqual(oldDraft?.payload);

    // The match post wrote is closed, not deleted, and the movement is free.
    const matches = await query<{ unapplied_at: string | null; unapply_reason: string | null }>(
      `SELECT unapplied_at::text AS unapplied_at, unapply_reason
         FROM reconciliation_matches WHERE group_id = $1`,
      [firstGroup]
    );
    expect(matches.rows).toHaveLength(1);
    expect(matches.rows[0].unapplied_at).not.toBeNull();
    expect(matches.rows[0].unapply_reason).toBe('session-reopened');
    const tx = await query<{ is_matched: boolean }>(
      `SELECT is_matched FROM bank_transactions WHERE id = $1`,
      [bankTx]
    );
    expect(tx.rows[0].is_matched).toBe(false);

    // The entry's bank line and its mirror's are sealed together, away from
    // the old group: they cancel, and must not come back as two items.
    const bankLines = await query<{ is_reconciled: boolean; reconciliation_id: string | null }>(
      `SELECT is_reconciled, reconciliation_id FROM journal_entry_lines
        WHERE journal_entry_id = ANY($1::uuid[]) AND account_id = $2`,
      [[firstEntry, rev.reversalId], glBank]
    );
    expect(bankLines.rows).toHaveLength(2);
    expect(bankLines.rows.every((l) => l.is_reconciled)).toBe(true);
    expect(new Set(bankLines.rows.map((l) => l.reconciliation_id)).size).toBe(1);
    expect(bankLines.rows[0].reconciliation_id).not.toBe(firstGroup);

    // The item the adjustment explained is open again.
    const items = await query<{ resuelta_at: string | null }>(
      `SELECT resuelta_at::text AS resuelta_at FROM reconciling_items WHERE reconciliation_session_id = $1`,
      [sessionId]
    );
    expect(items.rows.map((i) => i.resuelta_at)).toEqual([null]);

    const audit = await query<{ old_values: Record<string, unknown>; new_values: { reversals: unknown[] } }>(
      `SELECT old_values, new_values FROM audit_log
        WHERE entity_type = 'reconciliation_sessions' AND entity_id = $1 AND action = 'reopen'`,
      [sessionId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].old_values.status).toBe('posted');
    expect(audit.rows[0].old_values.posted_by).toBe(secondUser);
    expect(audit.rows[0].new_values.reversals).toHaveLength(1);
  });

  it('a second reopen is refused by the state guard and reverses nothing more', async () => {
    const before = await entryCount();
    await expect(
      reopenSession(scope(), sessionId, { reason: 'again' }, { userId: f.userId })
    ).rejects.toThrow(/in_progress/);
    expect(await entryCount()).toBe(before);
  });

  it('the SAME range closes, signs and posts again with the right balance', async () => {
    // Reopened, the books are back to what they were before post: the entry
    // and its mirror cancel, and the fee is a reconciling item again.
    const reopened = await estadoDeSesion(scope(), { sesionId: sessionId });
    expect(reopened.aritmetica.libros.saldo).toBe('0.00');
    expect(reopened.aritmetica.variacion).toBe('0.00');

    // Nothing new to classify: the pair is sealed and the item still exists.
    const classified = await clasificarPartidasDeSesion(scope(), sessionId, { userId: f.userId });
    expect(classified.levantadas).toHaveLength(0);

    const closed = await cerrarSesion(scope(), sessionId, {}, { userId: f.userId });
    expect(closed.estado).toBe('balanced');
    expect(closed.congelado.variance).toBe('0.00');
    await aprobarSesion(scope(), sessionId, { motivo: 'reviewed again' }, { userId: secondUser });

    const before = await entryCount();
    const posted = await contabilizarSesion(scope(), sessionId, {}, { userId: secondUser });
    expect(posted.posteados).toBe(1);
    expect(posted.adoptados).toBe(0);
    expect(posted.asientos[0].journalEntryId).not.toBe(firstEntry);
    expect(await entryCount()).toBe(before + 1);

    const after = await estadoDeSesion(scope(), { sesionId: sessionId });
    expect(after.aritmetica.libros.saldo).toBe('-350.00');
    expect(after.aritmetica.variacion).toBe('0.00');
    expect(after.aritmetica.cuadra).toBe(true);

    const sessions = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM reconciliation_sessions WHERE bank_account_id = $1`,
      [account]
    );
    expect(sessions.rows[0].n, 'the range was reused, not opened as a second session').toBe('1');
  });
});
