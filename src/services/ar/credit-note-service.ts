import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { postCreditNoteEntry } from '../accounting/ar-ap-posting.js';
import { resolveInvoiceMetodoPago, entityUsesCashBasisIva } from '../accounting/iva-cash-basis.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import type { JournalEntry } from '../../types/index.js';
import { CREDIT_NOTE_TYPES } from '../../database/enums.js';

// ============================================================
// NOTAS DE CRÉDITO (049 · F03)
//
// La nota es un documento propio con folio (CN), no una factura negativa:
// nace en borrador, se POSTEA AL EMITIR (DR devoluciones + DR IVA / CR CxC
// — el plan de póliza que la taxonomía CFDI ya tenía escrito para el tipo
// E) y se APLICA sin asiento adicional: el mayor se movió al emitir, la
// aplicación reparte ese crédito entre facturas en el auxiliar. Una nota
// emitida y no aplicada ES el saldo a favor del cliente, y `ar reconcile`
// la resta del auxiliar por eso.
//
// LA LIGA FISCAL GOBIERNA EL IVA. El rol de IVA del asiento sale del
// MetodoPago de la factura LIGADA (PUE → iva_trasladado; PPD no cobrada →
// iva_trasladado_no_cobrado, de donde se des-aparca). Por eso la aplicación
// se restringe: una nota ligada sólo se aplica a SU factura, y una nota
// suelta (PUE asumido) no se aplica a una factura PPD — cruzarlas dejaría
// IVA aparcado para siempre o lo sacaría de la cuenta equivocada. El caso
// normal —devolución sobre su factura— cierra redondo: la nota des-aparca
// su parte al emitir y los cobros la suya al cobrar, y las dos proporciones
// son complementarias.
//
// La entidad va DENTRO de cada SQL (frontera TEN) y el ensayo recorre el
// camino real y revierte.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Facturas a las que se puede aplicar una nota: abiertas y en el mayor. */
const APLICABLES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;

export interface CreditNote {
  id: string;
  tenant_id: string;
  entity_id: string;
  credit_note_number: string;
  customer_id: string;
  invoice_id: string | null;
  relates_to_uuid: string | null;
  type: string;
  credit_date: Date;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  amount_applied: string;
  currency_code: string;
  status: string;
  journal_entry_id: string | null;
  cfdi_uuid: string | null;
  reason: string | null;
  memo: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCreditNoteInput {
  entity_id: string;
  /** Requerido cuando no hay factura ligada; si la hay, se deriva y se coteja. */
  customer_id?: string;
  invoice_id?: string | null;
  relates_to_uuid?: string | null;
  type: string;
  credit_date?: string;
  subtotal: string;
  tax_amount?: string;
  currency_code?: string;
  reason?: string | null;
  memo?: string | null;
}

export async function createCreditNote(
  input: CreateCreditNoteInput,
  userId: string
): Promise<CreditNote> {
  if (!(CREDIT_NOTE_TYPES as readonly string[]).includes(input.type)) {
    throw new ValidationError(
      `El tipo de nota '${input.type}' no existe: usa ${CREDIT_NOTE_TYPES.join(', ')}.`
    );
  }
  const subtotal = new Decimal(input.subtotal);
  const tax = new Decimal(input.tax_amount ?? '0');
  if (subtotal.lessThanOrEqualTo(0)) {
    throw new ValidationError('El subtotal de la nota tiene que ser mayor que cero.');
  }
  if (tax.lessThan(0)) {
    throw new ValidationError('El IVA de la nota no puede ser negativo.');
  }
  const total = subtotal.plus(tax);

  return withTransaction(async (client) => {
    let customerId = input.customer_id ?? null;
    let currency = input.currency_code ?? null;

    if (input.invoice_id) {
      const inv = await client.query<{
        id: string; invoice_number: string; customer_id: string;
        currency_code: string; total_amount: string; status: string;
      }>(
        `SELECT id, invoice_number, customer_id, currency_code, total_amount, status
           FROM invoices WHERE id = $1 AND entity_id = $2`,
        [input.invoice_id, input.entity_id]
      );
      if (inv.rows.length === 0) throw new NotFoundError('Invoice', input.invoice_id);
      const factura = inv.rows[0];
      if (customerId && customerId !== factura.customer_id) {
        throw new ValidationError(
          `${factura.invoice_number} es del cliente ${factura.customer_id}: la nota quedaría en el auxiliar equivocado.`
        );
      }
      customerId = factura.customer_id;
      if (currency && currency !== factura.currency_code) {
        throw new ValidationError(
          `${factura.invoice_number} está en ${factura.currency_code} y la nota en ${currency}: sin tipo de cambio no se pueden mezclar.`
        );
      }
      currency = factura.currency_code;
      if (total.greaterThan(factura.total_amount)) {
        throw new ValidationError(
          `La nota es de ${total.toFixed(2)} y ${factura.invoice_number} es de ` +
            `${new Decimal(factura.total_amount).toFixed(2)}: no se acredita más de lo facturado.`
        );
      }
    }

    if (!customerId) {
      throw new ValidationError(
        'Una nota sin factura ligada necesita el cliente explícito: sin él no hay auxiliar donde vivir.'
      );
    }
    const cliente = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM customers WHERE id = $1 AND entity_id = $2`,
      [customerId, input.entity_id]
    );
    if (cliente.rows.length === 0) throw new NotFoundError('Customer', customerId);
    currency = currency ?? cliente.rows[0].currency_code;

    const fecha = input.credit_date ?? new Date().toISOString().slice(0, 10);
    const folio = await nextEntityNumber(client, input.entity_id, 'credit_note', 'CN', fecha);
    const id = uuidv4();
    const tenantId = await tenantDe(client, input.entity_id);

    await client.query(
      `INSERT INTO credit_notes (
         id, tenant_id, entity_id, credit_note_number, customer_id, invoice_id,
         relates_to_uuid, type, credit_date, subtotal, tax_amount, total_amount,
         currency_code, status, reason, memo, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14,$15,$16)`,
      [id, tenantId, input.entity_id, folio, customerId, input.invoice_id ?? null,
       input.relates_to_uuid ?? null, input.type, fecha,
       subtotal.toFixed(4), tax.toFixed(4), total.toFixed(4),
       currency, input.reason ?? null, input.memo ?? null, userId]
    );

    await registrarAuditoria(client, {
      tenantId,
      userId,
      action: 'create',
      entityType: 'credit_notes',
      entityId: id,
      newValues: { credit_note_number: folio, type: input.type, total_amount: total.toFixed(2) },
      reason: input.reason ?? undefined,
    });

    const creada = await client.query<CreditNote>(`SELECT * FROM credit_notes WHERE id = $1`, [id]);
    return creada.rows[0];
  });
}

/** La nota por folio o id, acotada por entidad. */
export async function resolveCreditNote(entityId: string, ref: string): Promise<CreditNote> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('A credit note reference is required.');
  const r = UUID_RE.test(trimmed)
    ? await query<CreditNote>(
        `SELECT * FROM credit_notes WHERE id = $1 AND entity_id = $2`, [trimmed, entityId])
    : await query<CreditNote>(
        `SELECT * FROM credit_notes WHERE credit_note_number = $1 AND entity_id = $2`,
        [trimmed, entityId]);
  if (r.rows.length === 0) throw new NotFoundError('Credit note', trimmed);
  return r.rows[0];
}

export interface CreditNoteDetail extends CreditNote {
  customer_name: string | null;
  invoice_number: string | null;
  journal_entry_number: string | null;
  amount_available: string;
  aplicaciones: { invoice_number: string; amount_applied: string; created_at: Date }[];
}

export async function getCreditNote(entityId: string, ref: string): Promise<CreditNoteDetail> {
  const nota = await resolveCreditNote(entityId, ref);
  const extra = await query<{ customer_name: string | null; invoice_number: string | null; journal_entry_number: string | null }>(
    `SELECT COALESCE(cu.company_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '')) AS customer_name, i.invoice_number, je.entry_number AS journal_entry_number
       FROM credit_notes cn
       LEFT JOIN customers cu ON cu.id = cn.customer_id
       LEFT JOIN invoices i ON i.id = cn.invoice_id
       LEFT JOIN journal_entries je ON je.id = cn.journal_entry_id
      WHERE cn.id = $1 AND cn.entity_id = $2`,
    [nota.id, entityId]
  );
  const apps = await query<{ invoice_number: string; amount_applied: string; created_at: Date }>(
    `SELECT i.invoice_number, a.amount_applied::text, a.created_at
       FROM credit_note_applications a
       JOIN invoices i ON i.id = a.invoice_id AND i.entity_id = $2
      WHERE a.credit_note_id = $1
      ORDER BY a.created_at`,
    [nota.id, entityId]
  );
  const disponible =
    nota.status === 'issued' || nota.status === 'applied'
      ? new Decimal(nota.total_amount).minus(nota.amount_applied)
      : new Decimal(0);
  return {
    ...nota,
    ...extra.rows[0],
    amount_available: disponible.toFixed(2),
    aplicaciones: apps.rows.map((a) => ({
      invoice_number: a.invoice_number,
      amount_applied: new Decimal(a.amount_applied).toFixed(2),
      created_at: a.created_at,
    })),
  };
}

export interface FiltroNotas {
  customerId?: string;
  status?: string;
  /** Emitidas con saldo por aplicar: el saldo a favor vivo. */
  open?: boolean;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface NotaResumen {
  id: string;
  credit_note_number: string;
  customer_name: string | null;
  invoice_number: string | null;
  type: string;
  credit_date: Date;
  total_amount: string;
  amount_applied: string;
  amount_available: string;
  currency_code: string;
  status: string;
}

export async function listCreditNotes(
  entityId: string,
  filtro: FiltroNotas = {}
): Promise<{ rows: NotaResumen[]; total: number }> {
  const params: unknown[] = [entityId];
  const where: string[] = ['cn.entity_id = $1'];
  if (filtro.customerId) {
    params.push(filtro.customerId);
    where.push(`cn.customer_id = $${params.length}`);
  }
  if (filtro.status) {
    params.push(filtro.status);
    where.push(`cn.status = $${params.length}`);
  }
  if (filtro.type) {
    params.push(filtro.type);
    where.push(`cn.type = $${params.length}`);
  }
  if (filtro.open) {
    where.push(`cn.status = 'issued' AND cn.amount_applied < cn.total_amount`);
  }

  const r = await query<NotaResumen & { total: number }>(
    `SELECT cn.id, cn.credit_note_number, COALESCE(cu.company_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '')) AS customer_name, i.invoice_number,
            cn.type, cn.credit_date, cn.total_amount::text, cn.amount_applied::text,
            (cn.total_amount - cn.amount_applied)::text AS amount_available,
            cn.currency_code, cn.status,
            COUNT(*) OVER()::int AS total
       FROM credit_notes cn
       LEFT JOIN customers cu ON cu.id = cn.customer_id
       LEFT JOIN invoices i ON i.id = cn.invoice_id
      WHERE ${where.join(' AND ')}
      ORDER BY cn.credit_date DESC, cn.credit_note_number DESC
      LIMIT ${Math.max(1, Math.min(filtro.limit ?? 50, 500))} OFFSET ${Math.max(0, filtro.offset ?? 0)}`,
    params
  );
  return {
    total: r.rows[0]?.total ?? 0,
    rows: r.rows.map(({ total: _total, ...row }) => ({
      ...row,
      total_amount: new Decimal(row.total_amount).toFixed(2),
      amount_applied: new Decimal(row.amount_applied).toFixed(2),
      amount_available:
        row.status === 'issued' || row.status === 'applied'
          ? new Decimal(row.amount_available).toFixed(2)
          : '0.00',
    })),
  };
}

class EnsayoNota extends Error {
  constructor(public readonly resultado: unknown) {
    super('dry-run');
  }
}

async function ensayable<T>(
  correr: (client: pg.PoolClient) => Promise<T>,
  opts: { dryRun?: boolean; client?: pg.PoolClient }
): Promise<T> {
  if (opts.client) return correr(opts.client);
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoNota) return e.resultado as T;
    throw e;
  }
}

export interface ResultadoEmision {
  creditNoteNumber: string;
  journalEntry: JournalEntry | null;
  attestation: { entityId: string; entryId: string } | null;
  alreadyPosted: boolean;
  dryRun: boolean;
}

/** Emite la nota: postea DR devoluciones + DR IVA / CR CxC y pasa a 'issued'. */
export async function issueCreditNote(
  entityId: string,
  noteId: string,
  userId: string,
  opts: { dryRun?: boolean; client?: pg.PoolClient } = {}
): Promise<ResultadoEmision> {
  const correr = async (client: pg.PoolClient): Promise<ResultadoEmision> => {
    const r = await client.query<CreditNote>(
      `SELECT * FROM credit_notes WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [noteId, entityId]
    );
    if (r.rows.length === 0) throw new NotFoundError('Credit note', noteId);
    const nota = r.rows[0];
    if (nota.status !== 'draft') {
      if (nota.journal_entry_id) {
        return {
          creditNoteNumber: nota.credit_note_number,
          journalEntry: null, attestation: null, alreadyPosted: true, dryRun: opts.dryRun === true,
        };
      }
      throw new ValidationError(
        `La nota ${nota.credit_note_number} está en '${nota.status}': sólo un borrador se emite.`
      );
    }

    const entry = await postCreditNoteEntry(client, nota, userId);
    await client.query(
      `UPDATE credit_notes SET status = 'issued', updated_at = NOW() WHERE id = $1`,
      [noteId]
    );
    await registrarAuditoria(client, {
      tenantId: nota.tenant_id,
      userId,
      action: 'post',
      entityType: 'credit_notes',
      entityId: noteId,
      oldValues: { status: 'draft' },
      newValues: { status: 'issued', journal_entry_id: entry?.id ?? null },
    });

    const salida: ResultadoEmision = {
      creditNoteNumber: nota.credit_note_number,
      journalEntry: entry,
      attestation: entry ? { entityId, entryId: entry.id } : null,
      alreadyPosted: false,
      dryRun: opts.dryRun === true,
    };
    if (opts.dryRun) throw new EnsayoNota(salida);
    return salida;
  };
  return ensayable(correr, opts);
}

export interface AplicacionNota {
  invoiceId: string;
  amount: string;
}

export interface ResultadoAplicacionNota {
  creditNoteNumber: string;
  documentos: { numero: string; saldoAnterior: string; saldoNuevo: string; estado: string }[];
  disponibleAnterior: string;
  disponibleNuevo: string;
  notaStatus: string;
}

/**
 * Aplica la nota emitida a una o varias facturas. Sin asiento: el mayor se
 * movió al emitir; esto reparte el crédito en el auxiliar. La restricción de
 * liga fiscal (ver cabecera) se impone aquí.
 */
export async function applyCreditNote(
  entityId: string,
  noteId: string,
  aplicaciones: AplicacionNota[],
  userId: string,
  opts: { dryRun?: boolean; client?: pg.PoolClient } = {}
): Promise<ResultadoAplicacionNota> {
  if (aplicaciones.length === 0) {
    throw new ValidationError('Indica a qué factura(s) se aplica la nota.');
  }
  const vistos = new Set<string>();
  for (const a of aplicaciones) {
    if (vistos.has(a.invoiceId)) {
      throw new ValidationError(
        `La factura ${a.invoiceId} aparece dos veces en la misma aplicación: súmalas en una.`
      );
    }
    vistos.add(a.invoiceId);
  }

  const correr = async (client: pg.PoolClient): Promise<ResultadoAplicacionNota> => {
    const r = await client.query<CreditNote>(
      `SELECT * FROM credit_notes WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [noteId, entityId]
    );
    if (r.rows.length === 0) throw new NotFoundError('Credit note', noteId);
    const nota = r.rows[0];
    if (nota.status !== 'issued') {
      throw new ValidationError(
        `La nota ${nota.credit_note_number} está en '${nota.status}': sólo una nota emitida ` +
          `con saldo por aplicar se aplica (un borrador se emite primero).`
      );
    }
    const disponible = new Decimal(nota.total_amount).minus(nota.amount_applied);
    const total = aplicaciones.reduce((s, a) => s.plus(a.amount), new Decimal(0));
    if (total.greaterThan(disponible)) {
      throw new ValidationError(
        `La nota ${nota.credit_note_number} tiene ${disponible.toFixed(2)} por aplicar y se ` +
          `intentan aplicar ${total.toFixed(2)}.`
      );
    }

    const cashBasis = await entityUsesCashBasisIva(client, entityId);
    const documentos: ResultadoAplicacionNota['documentos'] = [];

    for (const app of aplicaciones) {
      const inv = await client.query<{
        id: string; invoice_number: string; amount_due: string; status: string;
        customer_id: string; currency_code: string; cfdi_uuid: string | null;
        terms: string | null; memo: string | null;
      }>(
        `SELECT id, invoice_number, amount_due, status, customer_id, currency_code,
                cfdi_uuid, terms, memo
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.invoiceId, entityId]
      );
      if (inv.rows.length === 0) throw new NotFoundError('Invoice', app.invoiceId);
      const factura = inv.rows[0];

      if (factura.customer_id !== nota.customer_id) {
        throw new ValidationError(
          `${factura.invoice_number} es de otro cliente: una nota sólo se aplica dentro de su auxiliar.`
        );
      }
      if (!APLICABLES.includes(factura.status as (typeof APLICABLES)[number])) {
        throw new ValidationError(
          `${factura.invoice_number} está en "${factura.status}" y una nota sólo se aplica a una ` +
            `factura ${APLICABLES.join(', ')}.`
        );
      }
      if (factura.currency_code !== nota.currency_code) {
        throw new ValidationError(
          `${factura.invoice_number} está en ${factura.currency_code} y la nota en ` +
            `${nota.currency_code}: sin tipo de cambio no se pueden mezclar.`
        );
      }
      // La liga fiscal (ver cabecera): ligada → sólo su factura; suelta →
      // sólo facturas PUE, porque el asiento de la nota sacó el IVA de
      // iva_trasladado y aplicarla a una PPD dejaría el aparcado varado.
      if (nota.invoice_id && nota.invoice_id !== factura.id) {
        throw new ValidationError(
          `La nota ${nota.credit_note_number} está ligada a otra factura: se aplica a ella o se ` +
            'emite una nota nueva ligada a ésta. Cruzarlas descuadraría el IVA por método de pago.'
        );
      }
      if (!nota.invoice_id && cashBasis) {
        const metodo = await resolveInvoiceMetodoPago(client, {
          id: factura.id,
          entity_id: entityId,
          invoice_number: factura.invoice_number,
          cfdi_uuid: factura.cfdi_uuid,
          terms: factura.terms,
          memo: factura.memo,
        });
        if (metodo.metodo === 'PPD') {
          throw new ValidationError(
            `${factura.invoice_number} es PPD y la nota ${nota.credit_note_number} se emitió sin ` +
              'liga (IVA tratado como PUE): aplicarla aquí dejaría IVA aparcado para siempre. ' +
              'Crea la nota ligada a la factura (--invoice) para que su IVA salga de la cuenta correcta.'
          );
        }
      }

      const aplicado = new Decimal(app.amount);
      if (aplicado.lessThanOrEqualTo(0)) {
        throw new ValidationError('El importe a aplicar tiene que ser mayor que cero.');
      }
      const saldo = new Decimal(factura.amount_due);
      if (aplicado.greaterThan(saldo)) {
        throw new ValidationError(
          `${factura.invoice_number} debe ${saldo.toFixed(2)} y se intentan aplicar ${aplicado.toFixed(2)}.`
        );
      }

      await client.query(
        `INSERT INTO credit_note_applications (id, credit_note_id, invoice_id, amount_applied, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), noteId, app.invoiceId, aplicado.toFixed(4), userId]
      );
      // amount_paid NO se toca: una nota no es efectivo. El saldo baja y el
      // estado refleja «saldado», que es lo que 'paid' significa aquí.
      await client.query(
        `UPDATE invoices SET
           amount_due = amount_due - $1,
           status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE status END
         WHERE id = $2 AND entity_id = $3`,
        [aplicado.toFixed(4), app.invoiceId, entityId]
      );

      const nuevo = saldo.minus(aplicado);
      documentos.push({
        numero: factura.invoice_number,
        saldoAnterior: saldo.toFixed(2),
        saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : factura.status,
      });
    }

    const aplicadoTotal = new Decimal(nota.amount_applied).plus(total);
    const statusNota = aplicadoTotal.greaterThanOrEqualTo(nota.total_amount) ? 'applied' : 'issued';
    await client.query(
      `UPDATE credit_notes SET amount_applied = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [aplicadoTotal.toFixed(4), statusNota, noteId]
    );

    await registrarAuditoria(client, {
      tenantId: nota.tenant_id,
      userId,
      action: 'update',
      entityType: 'credit_notes',
      entityId: noteId,
      newValues: {
        evento: 'apply',
        aplicado: total.toFixed(2),
        documentos: documentos.length,
        status: statusNota,
      },
    });

    const salida: ResultadoAplicacionNota = {
      creditNoteNumber: nota.credit_note_number,
      documentos,
      disponibleAnterior: disponible.toFixed(2),
      disponibleNuevo: disponible.minus(total).toFixed(2),
      notaStatus: statusNota,
    };
    if (opts.dryRun) throw new EnsayoNota(salida);
    return salida;
  };
  return ensayable(correr, opts);
}
