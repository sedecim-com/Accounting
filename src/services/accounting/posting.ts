import { v4 as uuidv4 } from 'uuid';
import { registrarAuditoria } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import type pg from 'pg';
import { withTransaction, currentTenant } from '../../database/connection.js';
import { validateJournalEntry } from './validation.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { AccountingError, ErrorCodes } from '../../utils/errors.js';
import { blockchainOrchestrator } from '../blockchain/orchestrator.js';
import { JournalEntryStatus } from '../../types/index.js';
import type {
  JournalEntry,
  JournalEntryLine,
  JournalEntryType,
} from '../../types/index.js';

// ============================================================
// POSTING ENGINE
// All physical writes to journal_entries / journal_entry_lines /
// account_balances live in this module. Document-driven posting
// (invoices, bills, payments) lives in ar-ap-posting.ts and goes
// through createJournalEntry like every other caller.
// ============================================================

interface JournalEntryLineInput {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
  cost_center_id?: string;
  project_id?: string;
}

// Attestations are fire-and-forget but must survive process shutdown: the
// registry lets short-lived callers (the CLI) drain in-flight attestations
// before closing the pool instead of silently losing them.
const pendingAttestations = new Set<Promise<unknown>>();

/**
 * Launch a blockchain attestation for a posted entry. Call AFTER the
 * transaction that posted the entry has committed — the orchestrator reads
 * the entry back from the database.
 */
export function attestEntryAsync(tenantId: string, entityId: string, journalEntryId: string): void {
  const p = blockchainOrchestrator
    .attestJournalEntry({ tenantId, entityId, journalEntryId })
    .catch((err) => console.warn('Blockchain attestation skipped:', (err as Error).message));
  pendingAttestations.add(p);
  void p.finally(() => pendingAttestations.delete(p));
}

/** Wait (bounded) for in-flight attestations — call before pool.end(). */
export async function drainAttestations(timeoutMs = 10_000): Promise<void> {
  if (pendingAttestations.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingAttestations]),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs).unref();
    }),
  ]);
}

export async function createJournalEntry(
  entityId: string,
  entryDate: Date,
  entryType: JournalEntryType,
  description: string,
  lines: JournalEntryLineInput[],
  createdBy: string,
  options?: {
    sourceType?: string;
    sourceId?: string;
    reference?: string;
    autoPost?: boolean;
    /** Marks this entry as the mirror of reversesEntryId (set by reverseJournalEntry). */
    isReversal?: boolean;
    reversesEntryId?: string;
    /**
     * Run inside this caller-owned transaction client instead of opening a
     * new transaction. The caller commits — and is then responsible for
     * calling attestEntryAsync(tenantId, entityId, entry.id) after commit
     * when autoPost is set (attestation must see committed data).
     */
    client?: pg.PoolClient;
  }
): Promise<JournalEntry> {
  // Holder object: TS cannot track assignments made inside the closure, so a
  // plain `let` would narrow to null at the post-transaction check.
  const attest: { info: { tenantId: string; entityId: string; entryId: string } | null } = { info: null };

  const run = async (client: pg.PoolClient): Promise<JournalEntry> => {
    // Find the fiscal period for the entry date
    const periodResult = await client.query<{ id: string }>(
      `SELECT id FROM fiscal_periods
       WHERE entity_id = $1
       AND start_date <= $2 AND end_date >= $2
       AND status NOT IN ('hard_close', 'locked')
       ORDER BY period_number ASC LIMIT 1`,
      [entityId, entryDate]
    );

    if (periodResult.rows.length === 0) {
      throw new AccountingError(
        ErrorCodes.PERIOD_CLOSED,
        'No open fiscal period found for the entry date'
      );
    }

    const fiscalPeriodId = periodResult.rows[0].id;

    // Generate entry number (atomic per-entity counter; the row lock it
    // takes lives until this transaction commits, so concurrent posts can
    // never draw the same number — COUNT(*) here used to collide).
    const entryNumber = await nextEntityNumber(client, entityId, 'journal_entry', 'JE', entryDate);

    // Create journal entry
    const entryId = uuidv4();
    await client.query(
      `INSERT INTO journal_entries (
        id, entry_number, entry_type, entity_id, fiscal_period_id,
        source_type, source_id, reference, entry_date, status,
        description, created_by, is_reversal, reverses_entry_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12, $13)`,
      [
        entryId, entryNumber, entryType, entityId, fiscalPeriodId,
        options?.sourceType || null, options?.sourceId || null,
        options?.reference || null, entryDate, description, createdBy,
        options?.isReversal ?? false, options?.reversesEntryId || null,
      ]
    );

    // Create lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await client.query(
        `INSERT INTO journal_entry_lines (
          id, journal_entry_id, line_number, account_id,
          debit_amount, credit_amount, description,
          cost_center_id, project_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv4(), entryId, i + 1, line.account_id,
          line.debit_amount, line.credit_amount, line.description,
          line.cost_center_id || null, line.project_id || null,
        ]
      );
    }

    // Fetch the created entry with lines
    const entryResult = await client.query<JournalEntry>(
      'SELECT * FROM journal_entries WHERE id = $1',
      [entryId]
    );
    const linesResult = await client.query<JournalEntryLine>(
      'SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
      [entryId]
    );

    const entry = entryResult.rows[0];
    const entryLines = linesResult.rows;

    // El rastro se escribe en ESTA transacción, no aparte: si el asiento
    // no llega a confirmarse, su registro de auditoría tampoco.
    const tenantId = await tenantParaAuditoria(client, entityId);
    await registrarAuditoria(client, {
      tenantId,
      userId: createdBy,
      action: 'create',
      entityType: 'journal_entries',
      entityId: entryId,
      newValues: resumenAsiento(entry, entryLines),
      reason: options?.isReversal ? `Reversión de ${options?.reference ?? 'un asiento'}` : null,
    });

    // Auto-post if configured (inline within same transaction)
    if (options?.autoPost) {
      // Validate
      const validation = await validateJournalEntry(entry, entryLines);
      if (!validation.isValid) {
        throw new AccountingError(
          'VALIDATION_FAILED',
          `Validation failed: ${validation.errors.join('; ')}`
        );
      }

      // Mismo candado que postJournalEntry (R1): el autoPost también postea.
      await bloquearPeriodoParaPostear(client, entry.fiscal_period_id);

      const now = new Date();
      await client.query(
        `UPDATE journal_entries SET status = 'posted', posted_date = $1, posted_by = $2 WHERE id = $3`,
        [now, createdBy, entryId]
      );

      // Crear y contabilizar son dos hechos distintos aunque ocurran en el
      // mismo instante: el libro los distingue y el rastro también.
      await registrarAuditoria(client, {
        tenantId,
        userId: createdBy,
        action: 'post',
        entityType: 'journal_entries',
        entityId: entryId,
        oldValues: { status: 'draft' },
        newValues: { status: 'posted', posted_by: createdBy },
      });

      for (const line of entryLines) {
        await client.query(
          `INSERT INTO account_balances (account_id, fiscal_period_id, entity_id, debit_total, credit_total, ending_balance)
           VALUES ($1, $2, $3, COALESCE($4::NUMERIC, 0), COALESCE($5::NUMERIC, 0), COALESCE($4::NUMERIC, 0) - COALESCE($5::NUMERIC, 0))
           ON CONFLICT (account_id, fiscal_period_id)
           DO UPDATE SET
             debit_total = account_balances.debit_total + COALESCE($4::NUMERIC, 0),
             credit_total = account_balances.credit_total + COALESCE($5::NUMERIC, 0),
             ending_balance = account_balances.ending_balance + COALESCE($4::NUMERIC, 0) - COALESCE($5::NUMERIC, 0),
             updated_at = NOW()`,
          [line.account_id, entry.fiscal_period_id, entry.entity_id, line.debit_amount, line.credit_amount]
        );
      }

      const finalEntry = await client.query<JournalEntry>(
        'SELECT * FROM journal_entries WHERE id = $1',
        [entryId]
      );

      // Attestation launches AFTER commit (see below) — the orchestrator
      // reads the entry back from the DB, so launching pre-commit races.
      // El inquilino ya se resolvió arriba para la auditoría.
      attest.info = { tenantId, entityId, entryId };

      return { ...finalEntry.rows[0], lines: entryLines };
    }

    return { ...entry, lines: entryLines };
  };

  if (options?.client) {
    // Caller owns the transaction (and post-commit attestation).
    return run(options.client);
  }

  const result = await withTransaction(run);
  if (attest.info) {
    attestEntryAsync(attest.info.tenantId, attest.info.entityId, attest.info.entryId);
  }
  return result;
}

export async function postJournalEntry(
  entryId: string,
  userId: string
): Promise<JournalEntry> {
  // EL AGUJERO QUE ESTA FUNCIÓN TENÍA EN LA CADENA DE INTEGRIDAD.
  //
  // `attestEntryAsync` se disparaba al crear con autoPost, al revertir y al
  // anular — nunca al postear un borrador. Y postear un borrador es el camino
  // normal: lo usa `entry post`, las dos superficies HTTP y el posteo de
  // nómina, que crea sin autoPost y postea aparte. Todo asiento nacido
  // borrador quedaba fuera de la cadena, sin `entry_hash`, y por tanto fuera
  // del sello del periodo, que sólo abarcaba lo que tuviera hash.
  //
  // Mismo molde que las otras tres: titular fuera, relleno dentro de la
  // transacción, disparo DESPUÉS del commit — el orquestador vuelve a leer el
  // asiento de la base, así que dispararlo antes es una carrera.
  const attest: { info: { tenantId: string; entityId: string; entryId: string } | null } = {
    info: null,
  };

  const result = await withTransaction(async (client) => {
    const entryResult = await client.query<JournalEntry>(
      'SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE',
      [entryId]
    );

    if (entryResult.rows.length === 0) {
      throw new AccountingError('ENTRY_NOT_FOUND', 'Journal entry not found');
    }

    const entry = entryResult.rows[0];

    if (entry.status === JournalEntryStatus.POSTED) {
      throw new AccountingError('ALREADY_POSTED', 'Journal entry is already posted');
    }

    if (entry.status === JournalEntryStatus.VOID) {
      throw new AccountingError('ENTRY_VOID', 'Cannot post a voided entry');
    }

    const linesResult = await client.query<JournalEntryLine>(
      'SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
      [entryId]
    );

    // Validate
    const validation = await validateJournalEntry(entry, linesResult.rows);
    if (!validation.isValid) {
      throw new AccountingError(
        'VALIDATION_FAILED',
        `Validation failed: ${validation.errors.join('; ')}`
      );
    }

    // Se resuelve una sola vez y sirve para tres cosas: la política de
    // segregación, la auditoría y la atestación. Es la variante ESTRICTA
    // —lanza si no resuelve—, así que no hace falta condicionar el titular
    // como hacen reverse y void, que usan la blanda.
    const tenantId = await tenantParaAuditoria(client, entry.entity_id);

    // F01 · MAKER-CHECKER HUMANO (decisión §5, resuelta como panel).
    //
    // Solo pólizas MANUALES (source_type nulo): en los flujos del sistema —
    // nómina, aprobación de borradores de IA, reversas — creador=posteador es
    // intencional y el maker real queda trazado por source_type/source_id.
    // Cerrado al declarar, abierto al escribir: solo el literal 'exigir'
    // bloquea y solo 'alertar' anota; un valor desconocido cae al lado que no
    // congela la operación (off), igual que ingest_auto_post con 'on'.
    let notaSoD: string | null = null;
    if (!entry.source_type && entry.created_by === userId) {
      const politica = await getPolicy(
        { tenantId, entityId: entry.entity_id },
        'segregacion_de_funciones'
      );
      if (politica.value === 'exigir') {
        throw new AccountingError(
          'SOD_QUIEN_CREA_NO_POSTEA',
          `${entry.entry_number}: la política de segregación de funciones exige que quien postea ` +
            'no sea quien creó el borrador. Que otro usuario corra entry post, o ajusta la ' +
            'política segregacion_de_funciones en mnemosine pending.'
        );
      }
      if (politica.value === 'alertar') {
        notaSoD = 'SoD: quien postea es quien creó el borrador (política en alertar)';
      }
    }

    // Candado compartido sobre el periodo (R1): la validación de arriba lee
    // el estado FUERA de esta transacción, así que un cierre concurrente
    // podía colarse entre la lectura y el UPDATE. El FOR SHARE se cruza con
    // el FOR UPDATE del cierre: o el posteo entra antes de que el cierre
    // tome su foto del checklist, o espera a que el cierre decida.
    await bloquearPeriodoParaPostear(client, entry.fiscal_period_id);

    // Post the entry
    const now = new Date();
    await client.query(
      `UPDATE journal_entries
       SET status = 'posted', posted_date = $1, posted_by = $2
       WHERE id = $3`,
      [now, userId, entryId]
    );

    await registrarAuditoria(client, {
      tenantId,
      userId,
      action: 'post',
      entityType: 'journal_entries',
      entityId: entryId,
      oldValues: { status: entry.status },
      newValues: { status: 'posted', posted_by: userId },
      reason: notaSoD,
    });

    // Update account balances
    for (const line of linesResult.rows) {
      await client.query(
        `INSERT INTO account_balances (account_id, fiscal_period_id, entity_id, debit_total, credit_total, ending_balance)
         VALUES ($1, $2, $3, COALESCE($4::NUMERIC, 0), COALESCE($5::NUMERIC, 0), COALESCE($4::NUMERIC, 0) - COALESCE($5::NUMERIC, 0))
         ON CONFLICT (account_id, fiscal_period_id)
         DO UPDATE SET
           debit_total = account_balances.debit_total + COALESCE($4::NUMERIC, 0),
           credit_total = account_balances.credit_total + COALESCE($5::NUMERIC, 0),
           ending_balance = account_balances.ending_balance + COALESCE($4::NUMERIC, 0) - COALESCE($5::NUMERIC, 0),
           updated_at = NOW()`,
        [line.account_id, entry.fiscal_period_id, entry.entity_id, line.debit_amount, line.credit_amount]
      );
    }

    const updatedEntry = await client.query<JournalEntry>(
      'SELECT * FROM journal_entries WHERE id = $1',
      [entryId]
    );

    attest.info = { tenantId, entityId: entry.entity_id, entryId };

    return { ...updatedEntry.rows[0], lines: linesResult.rows };
  });

  // Sin guardas: las cuatro salidas alternativas de arriba son excepciones y
  // abortan la transacción, así que llegar aquí significa que el asiento
  // quedó posteado. Y como ALREADY_POSTED lanza, este camino no puede atestar
  // dos veces el mismo asiento.
  if (attest.info) {
    attestEntryAsync(attest.info.tenantId, attest.info.entityId, attest.info.entryId);
  }
  return result;
}

/**
 * El inquilino del asiento, o un error. Un movimiento del libro mayor sin
 * rastro no debe existir: si no se puede determinar a quién pertenece, no
 * se escribe. En la práctica siempre resuelve —la clave foránea garantiza
 * que la entidad existe— y el error señala un fallo de contexto, no un
 * dato faltante.
 */
/**
 * Candado compartido del periodo dentro de la transacción de posteo (R1).
 *
 * La regla 4 de validación lee el estado del periodo con una consulta de
 * POOL, fuera de la transacción: entre esa lectura y el UPDATE que postea,
 * un cierre concurrente podía confirmar — y el asiento aterrizaba en un
 * periodo cuyo checklist ya se había fotografiado sin él. El FOR SHARE se
 * cruza con el FOR UPDATE que el cierre toma sobre su fila: los posteos
 * concurren entre sí (SHARE no bloquea SHARE) y el cierre serializa contra
 * todos. La re-verificación usa la MISMA regla que la validación
 * (hard_close/locked rechazan; future/soft_close son compuerta de política,
 * no barrera) para no cambiar comportamiento, sólo cerrar la carrera.
 */
async function bloquearPeriodoParaPostear(
  client: pg.PoolClient,
  fiscalPeriodId: string
): Promise<void> {
  const r = await client.query<{ status: string; period_name: string }>(
    'SELECT status, period_name FROM fiscal_periods WHERE id = $1 FOR SHARE',
    [fiscalPeriodId]
  );
  const p = r.rows[0];
  if (!p) {
    throw new AccountingError('PERIOD_NOT_FOUND', 'Fiscal period not found while posting');
  }
  if (p.status === 'hard_close' || p.status === 'locked') {
    throw new AccountingError(
      'PERIOD_CLOSED',
      `${p.period_name} is '${p.status}': it closed while this entry was in flight; nothing was posted`
    );
  }
}

async function tenantParaAuditoria(client: pg.PoolClient, entityId: string): Promise<string> {
  const tenantId = await resolveTenantId(client, entityId);
  if (!tenantId) {
    throw new AccountingError(
      'TENANT_NO_RESUELTO',
      `No se pudo determinar el inquilino de la entidad ${entityId}: el asiento no se escribe sin rastro de auditoría.`
    );
  }
  return tenantId;
}

/** Resumen del asiento para el rastro: un renglón de auditoría es un
 *  extracto, no una copia de la tabla. */
function resumenAsiento(
  entry: JournalEntry,
  lines: JournalEntryLine[]
): Record<string, unknown> {
  const suma = (campo: 'debit_amount' | 'credit_amount'): string =>
    lines.reduce((acc, l) => acc + Number(l[campo] ?? 0), 0).toFixed(2);
  return {
    entry_number: entry.entry_number,
    entry_type: entry.entry_type,
    entry_date: entry.entry_date,
    description: entry.description,
    fiscal_period_id: entry.fiscal_period_id,
    source_type: entry.source_type ?? null,
    source_id: entry.source_id ?? null,
    line_count: lines.length,
    total_debit: suma('debit_amount'),
    total_credit: suma('credit_amount'),
  };
}

/** currentTenant() when set; otherwise a lookup (same pattern as createJournalEntry). */
async function resolveTenantId(
  client: pg.PoolClient,
  entityId: string
): Promise<string | undefined> {
  const fromContext = currentTenant();
  if (fromContext) return fromContext;
  const lookup = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return lookup.rows[0]?.tenant_id;
}

/**
 * Shared reversal core. Creates the posted mirror of a POSTED entry inside
 * the caller's transaction and links both directions. The caller must have
 * locked the entry (FOR UPDATE) and must fire attestation AFTER commit.
 *
 * Guards (both were missing from the REST route and corrupted balances):
 * - only posted entries reverse — a draft never touched account_balances,
 *   so its mirror would inject a one-sided movement into the ledger;
 * - one reversal per entry — each extra mirror would hit balances again.
 */
async function reverseWithinTransaction(
  client: pg.PoolClient,
  entry: JournalEntry,
  userId: string,
  description: string,
  reversalDate: Date
): Promise<JournalEntry> {
  if (entry.status !== JournalEntryStatus.POSTED) {
    throw new AccountingError(
      'ENTRY_NOT_POSTED',
      `Only posted entries can be reversed; ${entry.entry_number} is '${entry.status}' and never touched the ledger — reject or void it instead`
    );
  }
  if (entry.reversed_by_entry_id) {
    throw new AccountingError(
      'ALREADY_REVERSED',
      `Entry ${entry.entry_number} already has a reversal — reversing again would corrupt balances`
    );
  }

  const linesResult = await client.query<JournalEntryLine>(
    'SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number',
    [entry.id]
  );

  const reversalLines: JournalEntryLineInput[] = linesResult.rows.map((line) => ({
    account_id: line.account_id,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    description: `Reversal: ${line.description || ''}`,
    cost_center_id: line.cost_center_id || undefined,
    project_id: line.project_id || undefined,
  }));

  const reversal = await createJournalEntry(
    entry.entity_id,
    reversalDate,
    'reversing' as JournalEntryType,
    description,
    reversalLines,
    userId,
    {
      autoPost: true,
      client,
      reference: entry.entry_number,
      isReversal: true,
      reversesEntryId: entry.id,
    }
  );

  await client.query('UPDATE journal_entries SET reversed_by_entry_id = $1 WHERE id = $2', [
    reversal.id,
    entry.id,
  ]);

  // El asiento original NO se anula (NIF B-1: se corrige por reversión, no
  // por edición): sigue contabilizado. Lo que cambia es que ya tiene
  // espejo, y eso es lo que registra el rastro.
  await registrarAuditoria(client, {
    tenantId: await tenantParaAuditoria(client, entry.entity_id),
    userId,
    action: 'update',
    entityType: 'journal_entries',
    entityId: entry.id,
    oldValues: { reversed_by_entry_id: null },
    newValues: { reversed_by_entry_id: reversal.id, reversal_entry_number: reversal.entry_number },
    reason: description,
  });

  return reversal;
}

/**
 * Reverse a posted entry (NIF B-1: corrections by reversal, never by edit).
 * Atomic: mirror + linkage commit together; attestation fires after commit.
 */
export async function reverseJournalEntry(
  entryId: string,
  userId: string,
  options?: { reason?: string; reversalDate?: Date }
): Promise<JournalEntry> {
  const attest: { info: { tenantId: string; entityId: string; entryId: string } | null } = {
    info: null,
  };

  const reversal = await withTransaction(async (client) => {
    const entryResult = await client.query<JournalEntry>(
      'SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE',
      [entryId]
    );
    if (entryResult.rows.length === 0) {
      throw new AccountingError('ENTRY_NOT_FOUND', 'Journal entry not found');
    }
    const entry = entryResult.rows[0];

    const description = options?.reason
      ? `Reversal of ${entry.entry_number}: ${options.reason}`
      : `Reversal of ${entry.entry_number}`;
    const created = await reverseWithinTransaction(
      client,
      entry,
      userId,
      description,
      options?.reversalDate ?? new Date()
    );

    const tenantId = await resolveTenantId(client, entry.entity_id);
    if (tenantId) attest.info = { tenantId, entityId: entry.entity_id, entryId: created.id };
    return created;
  });

  if (attest.info) {
    attestEntryAsync(attest.info.tenantId, attest.info.entityId, attest.info.entryId);
  }
  return reversal;
}

/**
 * Core of the annulment, running on the CALLER's transaction client.
 * Returns the updated entry and the reversal (if one was created); the
 * caller must fire attestEntryAsync for the reversal AFTER commit.
 * Semantics (NIF B-1: corrections by reversal, never by edit):
 * - draft/pending entries never touched the ledger: simply marked 'void';
 * - posted entries STAY 'posted' and get a linked posted mirror. Flipping
 *   a posted entry to 'void' (the old behavior) made mv_trial_balance /
 *   mv_account_balance_summary — which filter status='posted' — diverge
 *   from account_balances. "Annulled" is expressed by reversed_by_entry_id.
 */
export async function voidJournalEntryInTx(
  client: pg.PoolClient,
  entryId: string,
  userId: string,
  reason: string
): Promise<{ entry: JournalEntry; reversal: JournalEntry | null }> {
  const entryResult = await client.query<JournalEntry>(
    'SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE',
    [entryId]
  );

  if (entryResult.rows.length === 0) {
    throw new AccountingError('ENTRY_NOT_FOUND', 'Journal entry not found');
  }

  const entry = entryResult.rows[0];

  if (entry.status === JournalEntryStatus.VOID) {
    throw new AccountingError('ALREADY_VOID', 'Journal entry is already voided');
  }

  let reversal: JournalEntry | null = null;
  if (entry.status === JournalEntryStatus.POSTED) {
    // reverseWithinTransaction rejects a second void via ALREADY_REVERSED.
    reversal = await reverseWithinTransaction(
      client,
      entry,
      userId,
      `Reversal of ${entry.entry_number}: ${reason}`,
      new Date()
    );
    await client.query(
      `UPDATE journal_entries SET notes = COALESCE(notes, '') || $1 WHERE id = $2`,
      [`\nVoided: ${reason}`, entryId]
    );
  } else {
    await client.query(
      `UPDATE journal_entries SET status = 'void', notes = COALESCE(notes, '') || $1 WHERE id = $2`,
      [`\nVoided: ${reason}`, entryId]
    );
  }

  const updatedEntry = await client.query<JournalEntry>(
    'SELECT * FROM journal_entries WHERE id = $1',
    [entryId]
  );

  await registrarAuditoria(client, {
    tenantId: await tenantParaAuditoria(client, entry.entity_id),
    userId,
    action: 'void',
    entityType: 'journal_entries',
    entityId: entryId,
    oldValues: { status: entry.status },
    // Un asiento contabilizado sigue 'posted' y se anula por reversión: el
    // rastro dice cuál de los dos caminos se tomó.
    newValues: reversal
      ? { status: updatedEntry.rows[0].status, reversed_by_entry_id: reversal.id }
      : { status: 'void' },
    reason,
  });

  return { entry: updatedEntry.rows[0], reversal };
}

export async function voidJournalEntry(
  entryId: string,
  userId: string,
  reason: string
): Promise<JournalEntry> {
  const attest: { info: { tenantId: string; entityId: string; entryId: string } | null } = {
    info: null,
  };

  const result = await withTransaction(async (client) => {
    const { entry, reversal } = await voidJournalEntryInTx(client, entryId, userId, reason);
    if (reversal) {
      const tenantId = await resolveTenantId(client, entry.entity_id);
      if (tenantId) {
        attest.info = { tenantId, entityId: entry.entity_id, entryId: reversal.id };
      }
    }
    return entry;
  });

  if (attest.info) {
    attestEntryAsync(attest.info.tenantId, attest.info.entityId, attest.info.entryId);
  }
  return result;
}

