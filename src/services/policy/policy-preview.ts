import { query } from '../../database/connection.js';

// ============================================================
// POLICY IMPACT PREVIEW
// A policy question asked in the abstract ("what threshold do you
// want?") is hard to answer well. The same question asked against
// the company's own data ("with $20,000 I would have interrupted
// you 8 times last year; with $50,000, twice") is a decision the
// accountant can actually make.
//
// Every preview degrades to silence: with no history there is
// nothing useful to say, and inventing an example would be worse
// than saying nothing.
// ============================================================

export interface PreviewContext {
  entityId: string;
  tenantId: string;
  currency: string;
}

/** Lines to show under "In your data:". Empty = nothing to show. */
export type PreviewFn = (ctx: PreviewContext) => Promise<string[]>;

const money = (n: number, currency = 'MXN') =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${currency}`;

/** Received CFDIs, which is the population most policies act on. */
async function receivedInvoices(ctx: PreviewContext): Promise<Array<{ subtotal: number; total: number }>> {
  const r = await query<{ subtotal: string; total: string }>(
    `SELECT subtotal, total FROM xml_documents
     WHERE entity_id = $1 AND document_type != 'cfdi_nomina'
       AND receptor_rfc = (SELECT tax_id FROM legal_entities WHERE id = $1)
     ORDER BY cfdi_fecha DESC LIMIT 500`,
    [ctx.entityId]
  );
  return r.rows.map((x) => ({ subtotal: Number(x.subtotal ?? 0), total: Number(x.total ?? 0) }));
}

export const PREVIEWS: Record<string, PreviewFn> = {
  /** How often each candidate threshold would interrupt the user. */
  async umbral_capitalizacion_mxn(ctx) {
    const invoices = await receivedInvoices(ctx);
    if (invoices.length === 0) return [];
    const lines = [`Of your ${invoices.length} received invoices:`];
    for (const threshold of [5000, 20000, 50000]) {
      const n = invoices.filter((i) => i.subtotal >= threshold).length;
      const pct = Math.round((n / invoices.length) * 100);
      lines.push(
        `  · with ${money(threshold, ctx.currency)} → I would ask you ` +
          `${n} time${n === 1 ? '' : 's'} (${pct}%)`
      );
    }
    return lines;
  },

  /** How much of the ledger would auto-post under the current thresholds. */
  async ingest_auto_post(ctx) {
    const r = await query<{ status: string; n: string }>(
      `SELECT status, count(*)::text n FROM ai_drafts WHERE entity_id = $1 GROUP BY status`,
      [ctx.entityId]
    );
    if (r.rows.length === 0) return [];
    const total = r.rows.reduce((s, x) => s + Number(x.n), 0);
    const approved = Number(r.rows.find((x) => x.status === 'approved')?.n ?? 0);
    const rejected = Number(r.rows.find((x) => x.status === 'rejected')?.n ?? 0);
    const lines = [`Of the ${total} draft${total === 1 ? '' : 's'} I have proposed so far:`];
    lines.push(`  · ${approved} you approved, ${rejected} you rejected`);
    if (rejected > 0) {
      lines.push(
        `  · a rejection rate above zero is a reason to keep this off until it settles`
      );
    } else if (approved >= 10) {
      lines.push(`  · no rejections yet — a track record that supports turning it on`);
    } else {
      lines.push(`  · too few yet to tell how often I would be right`);
    }
    return lines;
  },

  /** Amount distribution, so the cap is not picked blindly. */
  async ingest_auto_post_max_monto(ctx) {
    const invoices = await receivedInvoices(ctx);
    if (invoices.length === 0) return [];
    const totals = invoices.map((i) => i.total).sort((a, b) => a - b);
    const pct = (p: number) => totals[Math.min(totals.length - 1, Math.floor(totals.length * p))];
    const lines = [`Your received invoices, by amount:`];
    lines.push(`  · half are under ${money(pct(0.5), ctx.currency)}`);
    lines.push(`  · 9 out of 10 are under ${money(pct(0.9), ctx.currency)}`);
    lines.push(`  · the largest was ${money(totals[totals.length - 1], ctx.currency)}`);
    for (const cap of [5000, 10000, 50000]) {
      const n = totals.filter((t) => t <= cap).length;
      lines.push(
        `  · a cap of ${money(cap, ctx.currency)} would cover ${Math.round((n / totals.length) * 100)}% of them`
      );
    }
    return lines;
  },

  /** Whether the company actually moves inventory today. */
  async lleva_inventarios(ctx) {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text n
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
       WHERE a.entity_id = $1 AND a.name ILIKE '%inventario%'`,
      [ctx.entityId]
    );
    const n = Number(r.rows[0]?.n ?? 0);
    return n > 0
      ? [`I see ${n} posted movement${n === 1 ? '' : 's'} in inventory accounts — you seem to keep them.`]
      : [`I see no movements in inventory accounts yet.`];
  },

  /** Whether restaurant invoices are frequent enough to matter. */
  async politica_restaurantes(ctx) {
    const r = await query<{ n: string; total: string }>(
      `SELECT count(*)::text n, COALESCE(SUM(subtotal),0)::text total
       FROM xml_documents
       WHERE entity_id = $1
         AND (emisor_nombre ILIKE '%restaurant%' OR emisor_nombre ILIKE '%cafe%'
              OR emisor_nombre ILIKE '%comedor%')`,
      [ctx.entityId]
    );
    const n = Number(r.rows[0]?.n ?? 0);
    if (n === 0) return [`No restaurant invoices in your history yet.`];
    const total = Number(r.rows[0].total);
    return [
      `${n} restaurant invoice${n === 1 ? '' : 's'} for ${money(total, ctx.currency)}:`,
      `  · deductible (8.5%): ${money(total * 0.085, ctx.currency)}`,
      `  · non-deductible: ${money(total * 0.915, ctx.currency)}`,
    ];
  },

  /** Whether any invoice actually carries IEPS. */
  async tratamiento_ieps() {
    // The current schema has no IEPS column in xml_documents; saying
    // nothing is better than implying we checked.
    return [];
  },

  /** Real decryption cadence, so the cap is not arbitrary. */
  async efirma_max_accesos_diarios(ctx) {
    const r = await query<{ n: string; days: string }>(
      `SELECT count(*)::text n,
              GREATEST(1, EXTRACT(DAY FROM (NOW() - MIN(accessed_at))))::text days
       FROM fiscal_credential_access_log
       WHERE entity_id = $1 AND outcome = 'success'`,
      [ctx.entityId]
    );
    const n = Number(r.rows[0]?.n ?? 0);
    if (n === 0) return [`No e.firma accesses recorded yet.`];
    const days = Number(r.rows[0].days ?? 1);
    return [
      `${n} successful access${n === 1 ? '' : 'es'} over ${days} day${days === 1 ? '' : 's'} ` +
        `(~${(n / days).toFixed(1)} per day).`,
    ];
  },

  /** Whether closed-period invoices are a real problem here. */
  async cfdi_periodo_cerrado(ctx) {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text n
       FROM xml_documents x
       WHERE x.entity_id = $1
         AND EXISTS (
           SELECT 1 FROM fiscal_periods fp
           WHERE fp.entity_id = x.entity_id
             AND x.cfdi_fecha::date BETWEEN fp.start_date AND fp.end_date
             AND fp.status IN ('soft_close','hard_close','locked')
         )`,
      [ctx.entityId]
    );
    const n = Number(r.rows[0]?.n ?? 0);
    return n > 0
      ? [`${n} invoice${n === 1 ? '' : 's'} in your history fall in already-closed periods.`]
      : [`No invoices from closed periods so far.`];
  },
};

/**
 * Computes a preview, swallowing errors: a failed preview must never block
 * the wizard — it only removes the extra context.
 */
export async function previewFor(key: string, ctx: PreviewContext): Promise<string[]> {
  const fn = PREVIEWS[key];
  if (!fn) return [];
  try {
    return await fn(ctx);
  } catch {
    return [];
  }
}
