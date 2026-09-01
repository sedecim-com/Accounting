import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { AccountingError } from '../../utils/errors.js';

// ============================================================
// LOS CONTROLES DE CxC (F03)
//
// Dos instrumentos de lectura pura:
//
// `arReconcile` — el auxiliar contra la cuenta de control. El auxiliar es
// la suma de saldos abiertos de factura MENOS las notas de crédito emitidas
// por aplicar (su asiento ya acreditó el control al emitir; el auxiliar
// baja al aplicar — entre uno y otro, la nota ES la diferencia legítima).
// Lo que quede después de eso tiene nombre y apellido: los asientos
// manuales que tocaron la cuenta de control se listan, porque son la causa
// número uno de un descuadre que nadie encuentra.
//
// `runArChecks` — la batería nombrada que `close --check` consumirá: cada
// diagnóstico es una sonda SQL con nivel (blocking/warning), conteo y
// muestra. HOY, no as-of: reconstruir el pasado es la limitación declarada
// del aged receivables y mentir aquí con la misma limitación sin decirlo
// sería peor que no ofrecer la fecha.
// ============================================================

/** Facturas cuyo saldo vive en el auxiliar. Espejo de OPEN_INVOICE_STATUSES. */
const ABIERTAS = ['pending', 'sent', 'viewed', 'partially_paid', 'overdue'] as const;

export interface ArReconcileResult {
  control_account: { code: string; name: string } | null;
  control_balance: string;
  open_invoices: string;
  unapplied_credit_notes: string;
  subledger_net: string;
  delta: string;
  balanced: boolean;
  manual_entries: { entry_number: string; entry_date: Date; description: string; amount: string }[];
}

export async function arReconcile(entityId: string): Promise<ArReconcileResult> {
  const rol = await query<{ account_id: string; code: string; name: string }>(
    `SELECT ar.account_id, a.code, a.name
       FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
      WHERE ar.entity_id = $1 AND ar.role = 'cxc' AND ar.qualifier IS NULL`,
    [entityId]
  );
  if (rol.rows.length === 0) {
    throw new AccountingError(
      'MISSING_ROLE_ACCOUNT',
      `No hay cuenta mapeada al rol "cxc" en esta entidad: sin control no hay qué conciliar. ` +
        `Siembra la contabilidad con: mnemosine init --section identity`
    );
  }
  const cuenta = rol.rows[0];

  const control = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS saldo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.account_id = $2`,
    [entityId, cuenta.account_id]
  );

  const abiertas = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_due), 0)::text AS total
       FROM invoices
      WHERE entity_id = $1 AND status = ANY($2) AND amount_due > 0`,
    [entityId, [...ABIERTAS]]
  );

  const notas = await query<{ total: string }>(
    `SELECT COALESCE(SUM(total_amount - amount_applied), 0)::text AS total
       FROM credit_notes
      WHERE entity_id = $1 AND status = 'issued'`,
    [entityId]
  );

  const controlBal = new Decimal(control.rows[0].saldo);
  const auxiliar = new Decimal(abiertas.rows[0].total);
  const porAplicar = new Decimal(notas.rows[0].total);
  const neto = auxiliar.minus(porAplicar);
  const delta = controlBal.minus(neto);

  // Los asientos que tocaron el control SIN venir de un documento: la causa
  // clásica del descuadre. Los tipos de documento del propio motor quedan
  // fuera; todo lo demás —capturas manuales, ajustes, cierres— se lista.
  const manuales = await query<{
    entry_number: string; entry_date: Date; description: string; amount: string;
  }>(
    `SELECT je.entry_number, je.entry_date, je.description,
            SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0))::text AS amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.account_id = $2
        AND (je.source_type IS NULL OR je.source_type NOT IN
             ('invoice', 'customer_payment', 'credit_note',
              'receipt_application', 'receipt_unapplication'))
      GROUP BY je.id, je.entry_number, je.entry_date, je.description
      ORDER BY je.entry_date DESC
      LIMIT 50`,
    [entityId, cuenta.account_id]
  );

  return {
    control_account: { code: cuenta.code, name: cuenta.name },
    control_balance: controlBal.toFixed(2),
    open_invoices: auxiliar.toFixed(2),
    unapplied_credit_notes: porAplicar.toFixed(2),
    subledger_net: neto.toFixed(2),
    delta: delta.toFixed(2),
    balanced: delta.abs().lessThan('0.01'),
    manual_entries: manuales.rows.map((m) => ({
      entry_number: m.entry_number,
      entry_date: m.entry_date,
      description: m.description,
      amount: new Decimal(m.amount).toFixed(2),
    })),
  };
}

export type ArCheckLevel = 'clean' | 'warning' | 'blocking';

export interface ArCheckResult {
  name: string;
  level: ArCheckLevel;
  count: number;
  detail: string;
  sample: string[];
}

interface Sonda {
  name: string;
  /** El nivel cuando encuentra algo; 'clean' cuando no. */
  severity: 'blocking' | 'warning';
  descripcion: string;
  correr: (entityId: string) => Promise<{ count: number; detail: string; sample: string[] }>;
}

const cuenta = async (
  sql: string,
  params: unknown[],
  formato: (r: Record<string, unknown>) => string
): Promise<{ count: number; sample: string[] }> => {
  const r = await query<Record<string, unknown> & { total: number }>(sql, params);
  return { count: r.rows[0]?.total ?? 0, sample: r.rows.slice(0, 5).map(formato) };
};

const SONDAS: Sonda[] = [
  {
    name: 'subledger-delta',
    severity: 'blocking',
    descripcion: 'auxiliar (facturas abiertas − notas por aplicar) vs cuenta de control',
    correr: async (entityId) => {
      const r = await arReconcile(entityId);
      return r.balanced
        ? { count: 0, detail: `cuadra en ${r.control_balance}`, sample: [] }
        : {
            count: 1,
            detail:
              `control ${r.control_balance} vs auxiliar neto ${r.subledger_net} · delta ${r.delta}` +
              (r.manual_entries.length
                ? ` · ${r.manual_entries.length} asiento(s) manual(es) sobre el control`
                : ''),
            sample: r.manual_entries.slice(0, 5).map((m) => `${m.entry_number} ${m.amount}`),
          };
    },
  },
  {
    name: 'negative-balance',
    severity: 'blocking',
    descripcion: 'facturas con saldo o cobrado negativo',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT invoice_number, amount_due::text, COUNT(*) OVER()::int AS total
           FROM invoices WHERE entity_id = $1 AND (amount_due < 0 OR amount_paid < 0)
          ORDER BY invoice_number LIMIT 5`,
        [entityId],
        (r) => `${r.invoice_number} debe ${r.amount_due}`
      );
      return { count, detail: count ? 'sobre-aplicación o corrección a medias' : 'ninguna', sample };
    },
  },
  {
    name: 'over-application',
    severity: 'blocking',
    descripcion: 'aplicado vivo (cobros + notas) mayor al total de la factura',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT i.invoice_number, i.total_amount::text,
                (COALESCE(pa.s,0) + COALESCE(cna.s,0))::text AS aplicado,
                COUNT(*) OVER()::int AS total
           FROM invoices i
           LEFT JOIN LATERAL (SELECT SUM(amount_applied) AS s FROM payment_allocations
                               WHERE invoice_id = i.id AND unapplied_at IS NULL) pa ON true
           LEFT JOIN LATERAL (SELECT SUM(amount_applied) AS s FROM credit_note_applications
                               WHERE invoice_id = i.id) cna ON true
          WHERE i.entity_id = $1
            AND COALESCE(pa.s,0) + COALESCE(cna.s,0) > i.total_amount + 0.005
          ORDER BY i.invoice_number LIMIT 5`,
        [entityId],
        (r) => `${r.invoice_number}: ${r.aplicado} sobre ${r.total_amount}`
      );
      return { count, detail: count ? 'el auxiliar promete más de lo facturado' : 'ninguna', sample };
    },
  },
  {
    name: 'orphan-application',
    severity: 'blocking',
    descripcion: 'aplicaciones vivas de cobros anulados o reversados',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT cp.payment_number, i.invoice_number, cp.status, COUNT(*) OVER()::int AS total
           FROM payment_allocations pa
           JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
           JOIN invoices i ON i.id = pa.invoice_id
          WHERE pa.unapplied_at IS NULL AND cp.status IN ('void', 'reversed', 'failed')
          ORDER BY cp.payment_number LIMIT 5`,
        [entityId],
        (r) => `${r.payment_number} (${r.status}) → ${r.invoice_number}`
      );
      return {
        count,
        detail: count ? 'un cobro muerto sigue bajando saldo del auxiliar' : 'ninguna',
        sample,
      };
    },
  },
  {
    name: 'duplicate-invoice',
    severity: 'warning',
    descripcion: 'mismo cliente, mismo importe y misma fecha, más de una vez',
    correr: async (entityId) => {
      const r = await query<{ customer_id: string; invoice_date: Date; total_amount: string; folios: string; n: number }>(
        `SELECT customer_id, invoice_date, total_amount::text,
                STRING_AGG(invoice_number, ', ' ORDER BY invoice_number) AS folios,
                COUNT(*)::int AS n
           FROM invoices
          WHERE entity_id = $1 AND status NOT IN ('void', 'cancelled')
          GROUP BY customer_id, invoice_date, total_amount
         HAVING COUNT(*) > 1
          ORDER BY invoice_date DESC LIMIT 5`,
        [entityId]
      );
      return {
        count: r.rows.length,
        detail: r.rows.length ? 'candidatas a captura doble — revisar, no borrar' : 'ninguna',
        sample: r.rows.map((x) => `${x.folios} (${x.total_amount})`),
      };
    },
  },
  {
    name: 'stale-unapplied-cash',
    severity: 'warning',
    descripcion: 'cobros con saldo a cuenta sin aplicar por más de 30 días',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT cp.payment_number, (cp.payment_amount - COALESCE(ap.s,0))::text AS remanente,
                COUNT(*) OVER()::int AS total
           FROM customer_payments cp
           LEFT JOIN LATERAL (SELECT SUM(amount_applied) AS s FROM payment_allocations
                               WHERE payment_id = cp.id AND unapplied_at IS NULL) ap ON true
          WHERE cp.entity_id = $1 AND cp.status = 'completed'
            AND cp.payment_amount - COALESCE(ap.s,0) > 0.005
            AND cp.payment_date < NOW() - INTERVAL '30 days'
          ORDER BY cp.payment_date LIMIT 5`,
        [entityId],
        (r) => `${r.payment_number}: ${r.remanente} a cuenta`
      );
      return {
        count,
        detail: count ? 'dinero del cliente sin encontrar su factura' : 'ninguno',
        sample,
      };
    },
  },
  {
    name: 'missing-uuid',
    severity: 'warning',
    descripcion: 'facturas emitidas sin UUID fiscal (Anexo 24)',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT invoice_number, COUNT(*) OVER()::int AS total
           FROM invoices
          WHERE entity_id = $1 AND status NOT IN ('draft', 'void', 'cancelled')
            AND cfdi_uuid IS NULL
          ORDER BY invoice_number LIMIT 5`,
        [entityId],
        (r) => String(r.invoice_number)
      );
      return {
        count,
        detail: count
          ? 'emitidas sin timbrar: la contabilidad electrónica pide el UUID'
          : 'ninguna',
        sample,
      };
    },
  },
  {
    name: 'cancelled-cfdi-open',
    severity: 'blocking',
    descripcion: 'CFDI cancelado ante el SAT con saldo abierto en el auxiliar',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT invoice_number, amount_due::text, COUNT(*) OVER()::int AS total
           FROM invoices
          WHERE entity_id = $1 AND cfdi_status = 'cancelled' AND amount_due > 0
          ORDER BY invoice_number LIMIT 5`,
        [entityId],
        (r) => `${r.invoice_number} debe ${r.amount_due}`
      );
      return {
        count,
        detail: count ? 'se cobra un comprobante que fiscalmente ya no existe' : 'ninguna',
        sample,
      };
    },
  },
  {
    name: 'stamped-without-entry',
    severity: 'blocking',
    descripcion: 'CFDI timbrado sin asiento en el mayor',
    correr: async (entityId) => {
      const { count, sample } = await cuenta(
        `SELECT invoice_number, COUNT(*) OVER()::int AS total
           FROM invoices
          WHERE entity_id = $1 AND cfdi_status = 'stamped' AND journal_entry_id IS NULL
          ORDER BY invoice_number LIMIT 5`,
        [entityId],
        (r) => String(r.invoice_number)
      );
      return {
        count,
        detail: count ? 'existe ante el SAT y no en el mayor: el peor de los huecos' : 'ninguna',
        sample,
      };
    },
  },
];

export const AR_CHECK_NAMES = SONDAS.map((s) => s.name);

export interface ArChecksResult {
  results: ArCheckResult[];
  blocking: number;
  warnings: number;
}

export async function runArChecks(
  entityId: string,
  opts: { checks?: string[] } = {}
): Promise<ArChecksResult> {
  const pedidos = opts.checks?.length ? opts.checks : AR_CHECK_NAMES;
  const desconocidos = pedidos.filter((p) => !AR_CHECK_NAMES.includes(p));
  if (desconocidos.length > 0) {
    throw new AccountingError(
      'UNKNOWN_CHECK',
      `Diagnóstico(s) desconocido(s): ${desconocidos.join(', ')}. Los que existen: ${AR_CHECK_NAMES.join(', ')}.`
    );
  }

  const results: ArCheckResult[] = [];
  for (const sonda of SONDAS) {
    if (!pedidos.includes(sonda.name)) continue;
    const r = await sonda.correr(entityId);
    results.push({
      name: sonda.name,
      level: r.count > 0 ? sonda.severity : 'clean',
      count: r.count,
      detail: r.detail,
      sample: r.sample,
    });
  }
  return {
    results,
    blocking: results.filter((r) => r.level === 'blocking').length,
    warnings: results.filter((r) => r.level === 'warning').length,
  };
}
