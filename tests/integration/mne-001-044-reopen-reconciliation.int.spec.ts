import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { reclasificarPartida } from '../../src/services/banking/reconciling-items.js';
import {
  abrirSesion,
  aprobarSesion,
  cerrarSesion,
  clasificarPartidasDeSesion,
  reopenSession,
} from '../../src/services/banking/reconciliation-service.js';

/**
 * MNE-001-044 (#302) · REOPENING AN APPROVED RECONCILIATION, AGAINST POSTGRES.
 *
 * Before this slice a wrong item in an approved session had no way out from
 * the terminal: `close` refuses anything that is not `in_progress`, the item
 * services refuse a closed session, and `open` refuses a second session over
 * the same range. The month stayed trapped. These cases pin the facts that only
 * exist with real rows: the 054/055 CHECKs accept the reopened row, the
 * withdrawn signature survives in the audit trail, a closed fiscal period
 * wins, and the SAME range closes and signs again afterwards.
 */

let f: Fixture;
let account: string;
let sessionId: string;
let itemId: string;
let secondUser: string;
let firstHash: string;

interface SessionRow {
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_hash: string | null;
  approval_snapshot: unknown;
  closed_at: string | null;
  closed_by: string | null;
  arithmetic_computed_at: string | null;
}

async function sessionRow(): Promise<SessionRow> {
  const r = await query<SessionRow>(
    `SELECT status, approved_by, approved_at::text AS approved_at, approval_hash,
            approval_snapshot, closed_at::text AS closed_at, closed_by,
            arithmetic_computed_at::text AS arithmetic_computed_at
       FROM reconciliation_sessions WHERE id = $1`,
    [sessionId]
  );
  return r.rows[0];
}

const scope = () => entityScope(f.tenantId, f.entityId);

beforeAll(async () => {
  f = await crearInquilino('Probe MNE-001-044');
  const glBank = f.roles.banco ?? Object.values(f.cuentas)[0];

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
     VALUES ($1,$2,'Operativa 044','Banco',$3,'MXN','checking')`,
    [account, f.entityId, glBank]
  );

  // One month whose only difference is a bank charge the books do not carry:
  // bank -350, books 0. With the item raised both adjusted sides are -350.
  const statement = uuidv4();
  await query(
    `INSERT INTO bank_statements (id, entity_id, bank_account_id, period_start, period_end,
       opening_balance, closing_balance, currency_code, source_format, file_sha256, imported_by)
     VALUES ($1,$2,$3,'2026-08-01','2026-08-31',0,-350,'MXN','csv',$4,$5)`,
    [statement, f.entityId, account, 'e'.repeat(64), f.userId]
  );
  await query(
    `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type,
       description, is_matched, statement_id)
     VALUES ($1,$2,'2026-08-20',-350,'debit','cargo sin identificar',false,$3)`,
    [uuidv4(), account, statement]
  );

  sessionId = (await abrirSesion(scope(), { cuenta: account, periodo: '2026-08' }, { userId: f.userId }))
    .sesionId;
  await clasificarPartidasDeSesion(scope(), sessionId, { userId: f.userId });
  itemId = (
    await query<{ id: string }>(
      `SELECT id FROM reconciling_items WHERE reconciliation_session_id = $1`,
      [sessionId]
    )
  ).rows[0].id;
  await query(
    `UPDATE reconciling_items SET fecha_esperada = '2026-09-15', responsable = 'tesoreria'
      WHERE id = $1`,
    [itemId]
  );
  const closed = await cerrarSesion(scope(), sessionId, {}, { userId: f.userId });
  expect(closed.estado).toBe('balanced');
  const signed = await aprobarSesion(
    scope(),
    sessionId,
    { motivo: 'reviewed against the August statement' },
    { userId: secondUser }
  );
  firstHash = signed.hash;
  expect(signed.estado).toBe('approved');
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('MNE-001-044 · the fiscal period wins', () => {
  it('refuses while the period is closed, names `period reopen`, and leaves the row signed', async () => {
    await query(`UPDATE fiscal_periods SET status = 'soft_close' WHERE id = $1`, [f.periodos[8]]);
    try {
      await expect(
        reopenSession(scope(), sessionId, { reason: 'wrong item' }, { userId: f.userId })
      ).rejects.toThrow(/mnemosine period reopen "Periodo 8\/2026"/);
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [f.periodos[8]]);
    }
    const row = await sessionRow();
    expect(row.status).toBe('approved');
    expect(row.approval_hash).toBe(firstHash);
  });

  it('a hard-closed period asks for --force as `period reopen` itself does', async () => {
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [f.periodos[8]]);
    try {
      await expect(
        reopenSession(scope(), sessionId, { reason: 'wrong item' }, { userId: f.userId })
      ).rejects.toThrow(/period reopen "Periodo 8\/2026" --force/);
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [f.periodos[8]]);
    }
  });

  it('a locked period never reopens, so neither does its reconciliation', async () => {
    await query(`UPDATE fiscal_periods SET status = 'locked' WHERE id = $1`, [f.periodos[8]]);
    try {
      await expect(
        reopenSession(scope(), sessionId, { reason: 'wrong item' }, { userId: f.userId })
      ).rejects.toThrow(/locked/);
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [f.periodos[8]]);
    }
  });
});

describe('MNE-001-044 · reopen', () => {
  it('another entity reads the session as not found', async () => {
    await expect(
      reopenSession(entityScope(f.tenantId, uuidv4()), sessionId, { reason: 'x' }, { userId: f.userId })
    ).rejects.toThrow(/not found/i);
  });

  it('refuses without a reason: withdrawing a signature is justified or not done', async () => {
    await expect(
      reopenSession(scope(), sessionId, { reason: '  ' }, { userId: f.userId })
    ).rejects.toThrow(/motivo/);
  });

  it('the dry run shows the signature it would withdraw and writes nothing', async () => {
    const r = await reopenSession(
      scope(),
      sessionId,
      { reason: 'wrong item' },
      { userId: f.userId, dryRun: true }
    );
    expect(r.dryRun).toBe(true);
    expect(r.previousStatus).toBe('approved');
    expect(r.status).toBe('in_progress');
    expect(r.withdrawnSignature.hash).toBe(firstHash);
    expect(r.withdrawnSignature.approvedBy).toBe(secondUser);
    const row = await sessionRow();
    expect(row.status).toBe('approved');
    expect(row.approval_hash).toBe(firstHash);
  });

  it('moves the session to in_progress, clears the signature and the close, and audits both', async () => {
    const r = await reopenSession(
      scope(),
      sessionId,
      { reason: 'the charge was a books error' },
      { userId: f.userId }
    );
    expect(r.dryRun).toBe(false);
    expect(r.from).toBe('2026-08-01');
    expect(r.to).toBe('2026-08-31');

    const row = await sessionRow();
    expect(row.status).toBe('in_progress');
    expect(row.approved_by).toBeNull();
    expect(row.approved_at).toBeNull();
    expect(row.approval_hash).toBeNull();
    expect(row.approval_snapshot).toBeNull();
    // The item services read `closed_at` as well as the status: a reopened
    // session that kept it would still refuse every correction.
    expect(row.closed_at).toBeNull();
    expect(row.closed_by).toBeNull();
    expect(row.arithmetic_computed_at).toBeNull();

    // The signature is withdrawn from the row, never from history.
    const audit = await query<{ reason: string; old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
      `SELECT reason, old_values, new_values FROM audit_log
        WHERE entity_type = 'reconciliation_sessions' AND entity_id = $1 AND action = 'reopen'`,
      [sessionId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].reason).toBe('the charge was a books error');
    expect(audit.rows[0].old_values.status).toBe('approved');
    expect(audit.rows[0].old_values.approval_hash).toBe(firstHash);
    expect(audit.rows[0].old_values.approved_by).toBe(secondUser);
    expect(audit.rows[0].old_values.approval_snapshot).toBeTruthy();
    expect(audit.rows[0].new_values.status).toBe('in_progress');
  });

  it('a second reopen is refused by the state guard: in_progress is not approved', async () => {
    await expect(
      reopenSession(scope(), sessionId, { reason: 'again' }, { userId: f.userId })
    ).rejects.toThrow(/in_progress/);
  });

  it('the item is corrected and the SAME range closes and signs again', async () => {
    const corrected = await reclasificarPartida(f.entityId, sessionId, itemId, {
      tipo: 'error-de-libros',
    });
    expect(corrected.tipo).toBe('error-de-libros');

    const closed = await cerrarSesion(scope(), sessionId, {}, { userId: f.userId });
    expect(closed.estado).toBe('balanced');
    expect(closed.congelado.variance).toBe('0.00');

    // A balanced session is not approved: the guard admits exactly one state.
    await expect(
      reopenSession(scope(), sessionId, { reason: 'too early' }, { userId: f.userId })
    ).rejects.toThrow(/balanced/);

    const signed = await aprobarSesion(scope(), sessionId, {}, { userId: secondUser });
    expect(signed.estado).toBe('approved');
    expect(signed.hash).not.toBe(firstHash);
    expect(signed.instantanea.miembros.partidas[0].tipo).toBe('error-de-libros');

    const sessions = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM reconciliation_sessions WHERE bank_account_id = $1`,
      [account]
    );
    expect(sessions.rows[0].n, 'the range was reused, not reopened as a second session').toBe('1');
  });
});
