import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { resolvePeriod } from './fiscal-calendar-service.js';
import { resolveAccount } from './account-service.js';

// ============================================================
// F01 · LEDGER CHECKS — verificaciones nombradas y enumerables
//
// El modelo es `hledger check`: un solo comando, un registro de
// verificaciones con nombre, `--check a,b` corre exactamente ésas y
// sin bandera corren las bloqueantes. Hasta ahora el único checklist
// del mayor era el del cierre (fijo, dentro de getPeriodCloseStatus)
// y la integridad global vivía en doctor (checkLedgerIntegrity, sin
// alcance por entidad ni detalle por cuenta). Aquí las verificaciones
// son POR ENTIDAD y devuelven filas señalables, no un conteo.
//
//   balance      (bloqueante)  account_balances ≠ Σ líneas posteadas
//   audit-trail  (bloqueante)  posteados sin fila 'post' en audit_log
//   continuity   (advertencia) huecos en la serie anual del folio —
//                desde R3 el contador solo se consume si la transacción
//                comete, así que un hueco es un hecho raro que merece
//                mirada, no una alarma
// ============================================================

export interface LedgerFinding {
  check: string;
  severity: 'blocking' | 'warning';
  referencia: string;
  detalle: string;
}

export const LEDGER_CHECK_NAMES = ['balance', 'audit-trail', 'continuity'] as const;
export type LedgerCheckName = (typeof LEDGER_CHECK_NAMES)[number];
const BLOQUEANTES: LedgerCheckName[] = ['balance', 'audit-trail'];

export interface LedgerCheckFilters {
  /** Código de cuenta: acota `balance` a una sola cuenta. */
  account?: string;
  /** Nombre (o fragmento) del periodo fiscal: acota `balance`. */
  period?: string;
}

/**
 * Los filtros se RESUELVEN, no se interpolan.
 *
 * `balance` devuelve sólo los renglones descuadrados, así que un filtro que no
 * casa nada y un mayor sano dan exactamente lo mismo —cero filas—, y arriba eso
 * se imprime como «✔ el mayor pasa las verificaciones bloqueantes» con salida 0.
 * Un `ILIKE '%lo que sea%'` convertía cualquier forma no prevista en un visto
 * bueno silencioso: con `account_balances` corrompido a propósito, `--period
 * 2026-08` salía con 0 y daba el visto bueno mientras la misma corrida sin
 * bandera salía con 4 y nombraba el descuadre. Quien copiara esa línea antes de
 * cerrar el mes cerraba creyendo que había comprobado la integridad.
 *
 * `resolvePeriod` es el resolvedor que la casa ya tiene para esto —acepta uuid,
 * «2026-08» y cualquier parte inequívoca del nombre, y rehúsa el match ambiguo
 * en vez de tomar el primero—, y nació justamente porque `close -p` podía
 * cerrar en silencio un mes distinto del que se quería. Es el mismo fallo, así
 * que se usa el mismo remedio: aquí ya no se compara texto, se filtra por id.
 * Un filtro que no existe lanza NotFoundError —igual que en el resto del
 * sistema— en vez de estrenar un universo vacío y llamarlo limpio.
 */
async function checkBalance(entityId: string, f: LedgerCheckFilters): Promise<LedgerFinding[]> {
  const cond: string[] = [];
  const params: unknown[] = [entityId];
  let i = 2;
  if (f.account) {
    const cuenta = await resolveAccount(entityId, f.account);
    cond.push(`a.id = $${i++}`);
    params.push(cuenta.id);
  }
  if (f.period) {
    const periodo = await resolvePeriod(entityId, f.period);
    cond.push(`fp.id = $${i++}`);
    params.push(periodo.id);
  }
  const extra = cond.length > 0 ? ` AND ${cond.join(' AND ')}` : '';
  const result = await query<{
    code: string; period_name: string; ab_d: string; ab_c: string; l_d: string; l_c: string;
  }>(
    `SELECT a.code, fp.period_name,
            COALESCE(ab.debit_total, 0)::text AS ab_d, COALESCE(ab.credit_total, 0)::text AS ab_c,
            COALESCE(l.d, 0)::text AS l_d, COALESCE(l.c, 0)::text AS l_c
       FROM accounts a
       JOIN fiscal_periods fp ON fp.entity_id = a.entity_id
       LEFT JOIN account_balances ab
         ON ab.account_id = a.id AND ab.fiscal_period_id = fp.id
       LEFT JOIN (
         SELECT jel.account_id, je.fiscal_period_id,
                SUM(jel.debit_amount) AS d, SUM(jel.credit_amount) AS c
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
          WHERE je.status = 'posted' AND je.entity_id = $1
          GROUP BY jel.account_id, je.fiscal_period_id
       ) l ON l.account_id = a.id AND l.fiscal_period_id = fp.id
      WHERE a.entity_id = $1${extra}
        AND (COALESCE(ab.debit_total, 0)  IS DISTINCT FROM COALESCE(l.d, 0)
          OR COALESCE(ab.credit_total, 0) IS DISTINCT FROM COALESCE(l.c, 0))
      ORDER BY a.code, fp.start_date
      LIMIT 100`,
    params
  );
  return result.rows.map((r) => ({
    check: 'balance',
    severity: 'blocking' as const,
    referencia: `${r.code} · ${r.period_name}`,
    detalle: `account_balances dice ${r.ab_d}/${r.ab_c}; las líneas posteadas suman ${r.l_d}/${r.l_c}`,
  }));
}

async function checkAuditTrail(entityId: string): Promise<LedgerFinding[]> {
  const result = await query<{ entry_number: string; posted_date: string | null }>(
    `SELECT je.entry_number, je.posted_date::text AS posted_date
       FROM journal_entries je
      WHERE je.entity_id = $1 AND je.status = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM audit_log a
           WHERE a.entity_type = 'journal_entries' AND a.entity_id = je.id AND a.action = 'post'
        )
      ORDER BY je.posted_date
      LIMIT 100`,
    [entityId]
  );
  return result.rows.map((r) => ({
    check: 'audit-trail',
    severity: 'blocking' as const,
    referencia: r.entry_number,
    detalle: `posteada${r.posted_date ? ` el ${r.posted_date}` : ''} sin fila 'post' en audit_log — un hecho sin autor`,
  }));
}

async function checkContinuity(entityId: string): Promise<LedgerFinding[]> {
  // Por serie anual (JE-AAAA): #distintos vs (máx − mín + 1). Barato y sin
  // materializar la serie completa; el detalle fino es trabajo del auditor.
  const result = await query<{ serie: string; n: string; esperados: string }>(
    `SELECT substring(entry_number from '^JE-\\d{4}') AS serie,
            COUNT(DISTINCT split_part(entry_number, '-', 3)::bigint)::text AS n,
            (MAX(split_part(entry_number, '-', 3)::bigint)
             - MIN(split_part(entry_number, '-', 3)::bigint) + 1)::text AS esperados
       FROM journal_entries
      WHERE entity_id = $1 AND entry_number ~ '^JE-\\d{4}-\\d+$'
      GROUP BY 1
     HAVING COUNT(DISTINCT split_part(entry_number, '-', 3)::bigint)
          < MAX(split_part(entry_number, '-', 3)::bigint)
          - MIN(split_part(entry_number, '-', 3)::bigint) + 1
      ORDER BY 1`,
    [entityId]
  );
  return result.rows.map((r) => ({
    check: 'continuity',
    severity: 'warning' as const,
    referencia: r.serie,
    detalle: `la serie tiene ${r.n} folios de ${r.esperados} esperados: hay huecos`,
  }));
}

const RUNNERS: Record<LedgerCheckName, (entityId: string, f: LedgerCheckFilters) => Promise<LedgerFinding[]>> = {
  balance: checkBalance,
  'audit-trail': (e) => checkAuditTrail(e),
  continuity: (e) => checkContinuity(e),
};

/** Sin nombres corre las BLOQUEANTES (el contrato del catálogo). */
export async function runLedgerChecks(
  entityId: string,
  nombres: string[] | undefined,
  filtros: LedgerCheckFilters = {}
): Promise<LedgerFinding[]> {
  const pedidos = nombres?.length ? nombres : BLOQUEANTES;
  const desconocidos = pedidos.filter((n) => !(LEDGER_CHECK_NAMES as readonly string[]).includes(n));
  if (desconocidos.length > 0) {
    throw new ValidationError(
      `Verificación desconocida: ${desconocidos.join(', ')}. Disponibles: ${LEDGER_CHECK_NAMES.join(', ')}.`
    );
  }
  const resultados: LedgerFinding[] = [];
  for (const nombre of pedidos as LedgerCheckName[]) {
    resultados.push(...(await RUNNERS[nombre](entityId, filtros)));
  }
  return resultados;
}

// ============================================================
// F01 · BORRADORES VIEJOS — el bloqueo número uno del cierre
//
// getPeriodCloseStatus los CUENTA; aquí se LISTAN con edad, que es lo
// que un cierre necesita para repartir trabajo. Población: pólizas
// (journal_entries en draft/pending_approval) — NO ai_drafts, que es
// otra cola con otro ciclo y ya tiene superficie propia.
// ============================================================

export interface BorradorViejo {
  entry_number: string;
  description: string;
  status: string;
  created_at: string;
  edad_dias: number;
  period_name: string | null;
}

export async function listStaleDrafts(
  entityId: string,
  opts: { days?: number; period?: string } = {}
): Promise<BorradorViejo[]> {
  const dias = opts.days ?? 30;
  if (!Number.isFinite(dias) || dias < 0) {
    throw new ValidationError(`--days ilegible: "${opts.days}".`);
  }
  const cond: string[] = [
    'je.entity_id = $1',
    "je.status IN ('draft', 'pending_approval')",
    `je.created_at < NOW() - ($2 || ' days')::interval`,
  ];
  const params: unknown[] = [entityId, String(dias)];
  if (opts.period) {
    // Por id, como en `balance` y por lo mismo: una lista vacía y «no hay
    // borradores viejos» se imprimen igual, así que un filtro que no casaba
    // ningún periodo tranquilizaba en vez de avisar.
    const periodo = await resolvePeriod(entityId, opts.period);
    cond.push('fp.id = $3');
    params.push(periodo.id);
  }
  const result = await query<BorradorViejo>(
    `SELECT je.entry_number, je.description, je.status,
            je.created_at::text AS created_at,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - je.created_at)) / 86400)::int AS edad_dias,
            fp.period_name
       FROM journal_entries je
       LEFT JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE ${cond.join(' AND ')}
      ORDER BY je.created_at
      LIMIT 500`,
    params
  );
  return result.rows;
}
