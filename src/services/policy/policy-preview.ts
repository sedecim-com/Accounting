import { query } from '../../database/connection.js';
import { concordanciaSombra } from '../../ai/shadow-verdicts.js';
import { FLOOR_SOMBRA_ACUERDO, FLOOR_SOMBRA_DIAS, FLOOR_SOMBRA_VEREDICTOS } from '../../ai/floor.js';

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

/**
 * What a preview needs to speak: wording by key and figures by the formatter,
 * both already bound to the reader's language by the EDGE (CLI, API, agent).
 * NOTE: no file under `src/services` imports the language catalog, because a
 * service can only resolve the language of the PROCESS and the API negotiates
 * it per request (plan criterion `report-labels-come-from-the-catalog`).
 */
export interface PreviewText {
  /** The message under `key` (a `policy_preview.*` key), params filled in. */
  t(key: string, params?: Readonly<Record<string, string | number>>): string;
  /** A whole-unit amount of money in `currency`. */
  money(amount: number, currency: string): string;
  /** A number with the reader's separators. */
  number(value: number, options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }): string;
}

export interface PreviewContext {
  entityId: string;
  tenantId: string;
  currency: string;
  text: PreviewText;
}

/** Lines to show under "In your data:". Empty = nothing to show. */
export type PreviewFn = (ctx: PreviewContext) => Promise<string[]>;

// Wording by key (`policy_preview.*`) and figures by the formatter: no plural
// by ternary, no hand-written `$`, no pinned `en-US`. Both come from
// `ctx.text`, which the edge binds to the reader's language.
const money = (ctx: PreviewContext, n: number): string => ctx.text.money(n, ctx.currency);
const pct = (ctx: PreviewContext, part: number, whole: number): string =>
  ctx.text.number(Math.round((part / whole) * 100));

/**
 * Restaurant spend is deductible at 8.5 % (LISR art. 28 fr. XX). Still wired
 * here: serving it from `legal_parameters` is a separate change.
 */
const RESTAURANT_DEDUCTIBLE_RATE = 0.085;

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
    const lines = [ctx.text.t('policy_preview.threshold.intro', { count: invoices.length })];
    for (const threshold of [5000, 20000, 50000]) {
      const asked = invoices.filter((i) => i.subtotal >= threshold).length;
      lines.push(
        ctx.text.t('policy_preview.threshold.line', {
          threshold: money(ctx, threshold),
          asked,
          pct: pct(ctx, asked, invoices.length),
        })
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
    const lines = [ctx.text.t('policy_preview.auto_post.intro', { total })];
    lines.push(ctx.text.t('policy_preview.auto_post.counts', { approved, rejected }));
    if (rejected > 0) {
      lines.push(ctx.text.t('policy_preview.auto_post.rejected'));
    } else if (approved >= 10) {
      lines.push(ctx.text.t('policy_preview.auto_post.track_record'));
    } else {
      lines.push(ctx.text.t('policy_preview.auto_post.too_few'));
    }
    // A4: la evidencia de SOMBRA — la que resolvePolicy exige para 'on'. The
    // floors are read from the code's constants, not retyped in the text.
    const sombra = await concordanciaSombra({ tenantId: ctx.tenantId, entityId: ctx.entityId });
    if (sombra.veredictos > 0) {
      lines.push(
        ctx.text.t('policy_preview.auto_post.shadow_some', {
          verdicts: sombra.veredictos,
          days: sombra.dias_con_veredictos,
          decided: sombra.decididos,
          agreement: sombra.tasa_acuerdo ?? '—',
          minDays: FLOOR_SOMBRA_DIAS,
          minDecided: FLOOR_SOMBRA_VEREDICTOS,
          minAgreement: FLOOR_SOMBRA_ACUERDO.toFixed(2),
        })
      );
    } else {
      lines.push(ctx.text.t('policy_preview.auto_post.shadow_none'));
    }
    return lines;
  },

  /** Amount distribution, so the cap is not picked blindly. */
  async ingest_auto_post_max_monto(ctx) {
    const invoices = await receivedInvoices(ctx);
    if (invoices.length === 0) return [];
    const totals = invoices.map((i) => i.total).sort((a, b) => a - b);
    const at = (p: number) => totals[Math.min(totals.length - 1, Math.floor(totals.length * p))];
    const lines = [ctx.text.t('policy_preview.amounts.intro')];
    lines.push(ctx.text.t('policy_preview.amounts.half', { amount: money(ctx, at(0.5)) }));
    lines.push(ctx.text.t('policy_preview.amounts.nine_of_ten', { amount: money(ctx, at(0.9)) }));
    lines.push(
      ctx.text.t('policy_preview.amounts.largest', { amount: money(ctx, totals[totals.length - 1]) })
    );
    for (const cap of [5000, 10000, 50000]) {
      const covered = totals.filter((total) => total <= cap).length;
      lines.push(
        ctx.text.t('policy_preview.amounts.cap', {
          cap: money(ctx, cap),
          pct: pct(ctx, covered, totals.length),
        })
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
      ? [ctx.text.t('policy_preview.inventory.some', { count: n })]
      : [ctx.text.t('policy_preview.inventory.none')];
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
    if (n === 0) return [ctx.text.t('policy_preview.restaurants.none')];
    const total = Number(r.rows[0].total);
    return [
      ctx.text.t('policy_preview.restaurants.intro', { count: n, total: money(ctx, total) }),
      ctx.text.t('policy_preview.restaurants.deductible', {
        rate: ctx.text.number(RESTAURANT_DEDUCTIBLE_RATE * 100, { maximumFractionDigits: 1 }),
        amount: money(ctx, total * RESTAURANT_DEDUCTIBLE_RATE),
      }),
      ctx.text.t('policy_preview.restaurants.non_deductible', {
        amount: money(ctx, total * (1 - RESTAURANT_DEDUCTIBLE_RATE)),
      }),
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
       WHERE entity_id = $1 AND outcome IN ('success', 'error')`,
      [ctx.entityId]
    );
    const n = Number(r.rows[0]?.n ?? 0);
    if (n === 0) return [ctx.text.t('policy_preview.efirma.none')];
    const days = Number(r.rows[0].days ?? 1);
    return [
      ctx.text.t('policy_preview.efirma.summary', {
        count: n,
        days,
        perDay: ctx.text.number(n / days, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      }),
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
      ? [ctx.text.t('policy_preview.closed_period.some', { count: n })]
      : [ctx.text.t('policy_preview.closed_period.none')];
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
