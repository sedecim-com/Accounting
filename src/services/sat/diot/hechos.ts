import Decimal from 'decimal.js';
import type pg from 'pg';
import {
  ivaStillParked,
  reclassRoles,
  resolveBillMetodoPago,
  type MetodoPagoDecision,
} from '../../accounting/iva-cash-basis.js';
import {
  acumuladoDelDocumento,
  porcionDelDocumento,
  DECIMALES_DIOT,
  type PorcionPagada,
  type RenglonDeGasto,
  type TipoFactor,
} from './desglose.js';
import { linesToSplit, type CfdiTaxSummary } from './cfdi-split.js';
import type { Hallazgo } from './hallazgos.js';

// ============================================================
// F07c · EL HECHO QUE LA DIOT DECLARA: EL IVA EFECTIVAMENTE PAGADO
//
// La DIOT informa de operaciones PAGADAS, no devengadas. El generador que
// este repositorio tuvo y borró fallaba justo ahí —agregaba sobre `bills` por
// `bill_date`— y la nota de deuda lo dejó escrito para que no se repitiera.
//
// LOS DOS SUCESOS SON LOS DEL MAYOR, Y ESO ES LA TESIS DEL MÓDULO. La
// maquinaria de flujo (iva-cash-basis) ya decide cuándo el IVA de una compra
// es acreditable, y sólo hay dos momentos. Cuál le toca a un gasto lo decide
// DÓNDE ESTÁ SU IVA, no su método (MNE-001-491):
//
//   · el gasto  → un PUE cuyo IVA fue directo a 1130 al contabilizarlo.
//   · el pago   → todo lo demás: el IVA aparcado sale de 1135 y entra a 1130,
//                 en proporción a lo pagado, sea el gasto PPD o PUE.
//
// Construir la DIOT a partir de EXACTAMENTE esos dos sucesos hace que el
// amarre contra el movimiento de 1130 del mes —el paso 6 de la lista de
// comprobación, el que dice «nunca "casi cuadra"»— sea verdadero por
// construcción y no por coincidencia. Cualquier otra definición del hecho
// obliga a explicar la diferencia todos los meses.
//
// POR QUÉ NO SE LLAMA A `ivaReclassificationsFor` PAGO POR PAGO
//
// Era lo natural: recorrer los pagos del mes y sumar lo que cada uno libera.
// La primera versión de este comentario decía que eso inflaba la cifra,
// porque aquella función calcula el previo como «todo lo aplicado al
// documento MENOS lo de este pago» (iva-cash-basis:634) —correcto al
// CONTABILIZAR el pago, cuando los posteriores aún no existen, y sospechoso
// al preguntar en retrospectiva—. SE MIDIÓ CONTRA POSTGRES Y NO INFLA: el
// repartidor es lineal, así que Σᵢ [objetivo(A) − objetivo(A − pᵢ)] se
// telescopa solo y da objetivo(A) exacto. Dos parcialidades de 580 sobre un
// gasto de 1 160 dan 160 por las dos rutas y por el mayor.
//
// Las razones por las que aun así no se usa son otras tres, y ésas sí se
// sostienen:
//
//   1. DEJA FUERA LO QUE NO TIENE IVA. Descarta todo documento cuya
//      liberación sea cero (iva-cash-basis:644), así que un gasto EXENTO o
//      todo al 0 % pagado en el mes no aparecería nunca — y la DIOT declara
//      el VALOR DE LOS ACTOS, no sólo el impuesto. Sería un agujero
//      silencioso justo en el renglón que la migración 063 vino a rescatar.
//   2. LA PREGUNTA ES OTRA. La suya es «qué libera ESTE pago»; la de la DIOT
//      es «cuánto se liberó DURANTE el mes». Cuando coinciden es por la
//      linealidad, no por diseño, y apoyarse en eso es apoyarse en algo que
//      nadie prometió mantener.
//   3. UNA CONSULTA POR PAGO, y cada una vuelve a resolver el método y a leer
//      el mayor para el tope.
//
// Así que lo que se reusa es la pieza que sí responde a la segunda pregunta:
// el repartidor por diferencia de acumulados (`ivaToReclassify`, vía
// `acumuladoDelDocumento`) y el tope real contra lo aparcado
// (`ivaStillParked`). El mes se calcula como acumulado al cierre menos
// acumulado al cierre del mes anterior — que telescopa, y por tanto la suma
// de los doce meses reproduce exactamente el IVA del documento.
//
// THE SPLIT BY RATE OF A BILL BORN FROM A CFDI (MNE-001-563)
//
// The lines of a fact are the bill's own, with one exception. A bill approved
// from an AI draft under `lineas_factura_desde = poliza` holds the debits of
// the entry: no VAT on them, and no rate when the CFDI mixes regimes. Such
// lines cannot say the split, so the fact carries the lines of its CFDI's
// summary instead (`linesToSplit`, cfdi-split.ts). The CFDI is found by
// provenance, `pre_registrations.bill_id`, never by UUID: a bill captured by
// hand has no pre-registration and is always read from its own lines. The
// event, the share and the VAT paid of the fact do not change, and nothing is
// written: the DIOT and the VAT workpaper read the same fact.
//
// THE DAY OF A VENDOR CHEQUE (MNE-001-559, #700)
//
// A payment counts on its own date, except a cheque: its price is paid the day
// the bank cashes it (the rule of #700), and since MNE-001-508 the ledger
// credits its IVA on that day. The facts follow the ledger, so the tie-out
// against 1130 still holds: a cheque whose own entries credited the IVA before
// the cashing (every cheque recorded before MNE-001-508, and a foreign-currency
// one still) keeps its payment date, and any other cheque counts on
// `check_cleared_date`. With no cashing that date is NULL and the share enters
// no month.
//
// THE DAY OF AN APPLICATION (MNE-001-679, #787)
//
// Creditable VAT is credited in the month it is effectively paid (LIVA art.
// 5o. fr. III), and cash on account pays a bill the day it is applied to it,
// when the vendor's claim is extinguished (art. 1o.-B, first paragraph); the
// DIOT reports that month (art. 32 fr. VIII). `payment apply --date` stores
// that day (`applied_on`, migration 344) and dates its entry by it
// (MNE-001-678), so each application counts on its own day
// (`APPLICATION_CREDIT_DATE`): the later of the day it was applied and its
// payment's day above. A transfer of March applied in May counts in May, where
// the ledger debited the creditable account; cash applied before its cashing
// still waits for the bank. A row with no stored day, written before the day
// was kept, reads its payment's date as it always did, so no month already
// shown moves.
//
// ============================================================

/** Un documento y el tramo suyo que este mes declaró como pagado. */
export interface HechoPagado {
  billId: string;
  billNumber: string;
  vendorId: string;
  metodo: MetodoPagoDecision;
  /**
   * Which event declares the bill: its own entry (`bill`, declared whole in
   * its month) or its payments (`payment`, the month's increment).
   */
  event: 'bill' | 'payment';
  /** `bills.tax_amount` en moneda del documento: la cabecera. */
  ivaCabecera: string;
  /** El IVA acreditable que el mes reconoció, en moneda funcional. */
  ivaPagado: string;
  /** El IVA retenido a este tercero en el tramo, en moneda funcional. */
  ivaRetenido: string;
  porcion: PorcionPagada;
  renglones: RenglonDeGasto[];
}

export interface RangoDelMes {
  /** 'AAAA-MM-01'. */
  desde: string;
  /** Último día del mes, 'AAAA-MM-DD'. */
  hasta: string;
}

interface FilaGasto {
  id: string;
  bill_number: string;
  vendor_id: string;
  tax_amount: string;
  total_amount: string;
  exchange_rate: string;
  amount_paid: string;
  terms: string | null;
  memo: string | null;
  cfdi_uuid: string | null;
  aplicado_hasta_fin?: string;
  aplicado_hasta_inicio?: string;
}

const q = (d: Decimal): string => d.toDecimalPlaces(DECIMALES_DIOT).toFixed(DECIMALES_DIOT);

/** Primer y último día del mes, como los espera Postgres. */
export function rangoDelMes(anio: number, mes: number): RangoDelMes {
  const dosDigitos = String(mes).padStart(2, '0');
  const ultimo = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
  return { desde: `${anio}-${dosDigitos}-01`, hasta: ultimo };
}

/**
 * Los gastos contabilizados en el mes: los candidatos al suceso «gasto».
 *
 * `journal_entry_id IS NOT NULL` y no `status`: es la marca que
 * `postBillEntry` escribe y la llave de su idempotencia, así que es la única
 * que responde a la pregunta que importa —si este gasto movió el mayor— sin
 * depender de que alguien mantenga el `status` al día.
 */
async function gastosDelMes(
  client: pg.PoolClient,
  entityId: string,
  rango: RangoDelMes
): Promise<FilaGasto[]> {
  const { rows } = await client.query<FilaGasto>(
    `SELECT b.id, b.bill_number, b.vendor_id,
            b.tax_amount::text, b.total_amount::text, b.exchange_rate::text,
            b.amount_paid::text, b.terms, b.memo, b.cfdi_uuid
       FROM bills b
      WHERE b.entity_id = $1
        AND b.bill_date >= $2::date AND b.bill_date <= $3::date
        AND b.journal_entry_id IS NOT NULL
        AND b.status NOT IN ('void', 'cancelled')
      ORDER BY b.bill_number`,
    [entityId, rango.desde, rango.hasta]
  );
  return rows;
}

/**
 * True for a payment `vp` whose own entries debited the creditable-IVA account
 * before its cashing, or with no cashing recorded: the ledger credited that
 * cheque on its payment day.
 */
const CREDITED_BEFORE_CASHING = `EXISTS (
            SELECT 1
              FROM journal_entries je
              JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
              JOIN account_roles ar ON ar.account_id = jel.account_id AND ar.entity_id = je.entity_id
                                   AND ar.qualifier IS NULL AND ar.role = '${reclassRoles('received').to}'
             WHERE je.entity_id = vp.entity_id AND je.source_id = vp.id AND je.status = 'posted'
               AND je.source_type IN ('vendor_payment', 'vendor_application')
               AND jel.debit_amount > 0
               AND (vp.check_cleared_date IS NULL OR je.entry_date < vp.check_cleared_date))`;

// CONTRACT: the day a vendor payment's cash counts as paid for the DIOT and
// the IVA workpaper (SAT deliverables): its date, or the cashing day of a
// cheque that waited for it, and NULL while it has no cashing: it enters no
// month. Read over a `vendor_payments vp` row. Since MNE-001-679 it is no
// longer the day every application of the payment counts on: that is
// `APPLICATION_CREDIT_DATE`, which is never earlier. The DIOT changes
// compatibly: only an application with a stored day later than this one moves,
// to the month of that day.
const CREDIT_DATE = `CASE WHEN vp.payment_method <> 'check' OR ${CREDITED_BEFORE_CASHING}
                 THEN vp.payment_date ELSE vp.check_cleared_date END`;

/**
 * The day a vendor application was applied to its bill: the one its row stores
 * (`applied_on`, migration 344), or its payment's date for a row written before
 * a writer stored it. Read over `payment_applications pa` and its
 * `vendor_payments vp`.
 */
export const APPLIED_ON = `COALESCE(pa.applied_on, vp.payment_date)`;

/**
 * CONTRACT: the day on which the DIOT and the IVA workpaper (SAT deliverables)
 * count one vendor application, and the VAT over-credit census names its month
 * (MNE-001-562): the later of `APPLIED_ON` and its payment's `CREDIT_DATE`
 * (LIVA art. 5o. fr. III and 1o.-B). NULL while `CREDIT_DATE` is NULL.
 * NOTE: `date_larger`, the function behind `max(date)`, and not GREATEST:
 * GREATEST skips a NULL and would return the application's own day for a
 * payment that still waits for its cashing.
 */
export const APPLICATION_CREDIT_DATE = `date_larger(${APPLIED_ON}, ${CREDIT_DATE})`;

/**
 * Los gastos a los que un pago del mes les aplicó dinero, con lo acumulado al
 * cierre del mes y al cierre del mes ANTERIOR. Each application counts on its
 * own day, `APPLICATION_CREDIT_DATE` (MNE-001-679).
 *
 * LA ENTIDAD SE ACOTA DOS VECES A PROPÓSITO. `payment_applications` no tiene
 * `entity_id` —es la tabla puente—, así que la frontera tiene que venir de
 * sus dos extremos. Fijar sólo `bills` dejaría entrar el pago de otra
 * entidad aplicado al mismo gasto, y fijar sólo `vendor_payments` dejaría
 * entrar el gasto ajeno: es la octava aparición de la frontera de entidad en
 * este proyecto y la primera en la que el cruce no filtra datos, los declara.
 */
async function gastosPagadosEnElMes(
  client: pg.PoolClient,
  entityId: string,
  rango: RangoDelMes
): Promise<FilaGasto[]> {
  const { rows } = await client.query<FilaGasto>(
    `SELECT b.id, b.bill_number, b.vendor_id,
            b.tax_amount::text, b.total_amount::text, b.exchange_rate::text,
            b.amount_paid::text, b.terms, b.memo, b.cfdi_uuid,
            COALESCE(SUM(pa.amount_applied)
              FILTER (WHERE cd.credited_on <= $3::date), 0)::text AS aplicado_hasta_fin,
            COALESCE(SUM(pa.amount_applied)
              FILTER (WHERE cd.credited_on < $2::date), 0)::text AS aplicado_hasta_inicio
       FROM bills b
       JOIN payment_applications pa ON pa.bill_id = b.id
       JOIN vendor_payments vp ON vp.id = pa.payment_id
      CROSS JOIN LATERAL (SELECT ${APPLICATION_CREDIT_DATE} AS credited_on) cd
      WHERE b.entity_id = $1
        AND vp.entity_id = $1
        AND vp.journal_entry_id IS NOT NULL
        AND vp.status <> 'void'
        AND cd.credited_on <= $3::date
        AND b.status NOT IN ('void', 'cancelled')
      GROUP BY b.id, b.bill_number, b.vendor_id, b.tax_amount, b.total_amount,
               b.exchange_rate, b.amount_paid, b.terms, b.memo, b.cfdi_uuid
     HAVING COALESCE(SUM(pa.amount_applied) FILTER (WHERE cd.credited_on <= $3::date), 0)
          > COALESCE(SUM(pa.amount_applied) FILTER (WHERE cd.credited_on <  $2::date), 0)
      ORDER BY b.bill_number`,
    [entityId, rango.desde, rango.hasta]
  );
  return rows;
}

interface CheckRow extends FilaGasto {
  label: string;
  signed_on: string;
  cashed_on: string | null;
  applied: string;
}

/**
 * The cheques the month has to speak of, one row per cheque and bill: the one
 * that holds its IVA and has no cashing recorded (signed up to the month's
 * end), and the one credited on its payment day, in this month, that the bank
 * cashed in a later one. Live applications of completed payments only, scoped
 * at both ends of the bridge.
 */
async function checksToFlag(
  client: pg.PoolClient,
  entityId: string,
  range: RangoDelMes
): Promise<CheckRow[]> {
  const { rows } = await client.query<CheckRow>(
    `SELECT b.id, b.bill_number, b.vendor_id,
            b.tax_amount::text, b.total_amount::text, b.exchange_rate::text,
            b.amount_paid::text, b.terms, b.memo, b.cfdi_uuid,
            COALESCE(vp.check_number, vp.payment_number) AS label,
            to_char(vp.payment_date, 'YYYY-MM-DD') AS signed_on,
            to_char(vp.check_cleared_date, 'YYYY-MM-DD') AS cashed_on,
            SUM(pa.amount_applied)::text AS applied
       FROM bills b
       JOIN payment_applications pa ON pa.bill_id = b.id
       JOIN vendor_payments vp ON vp.id = pa.payment_id
      CROSS JOIN LATERAL (SELECT ${CREDITED_BEFORE_CASHING} AS early) e
      WHERE b.entity_id = $1
        AND vp.entity_id = $1
        AND vp.journal_entry_id IS NOT NULL
        AND vp.status = 'completed'
        AND vp.payment_method = 'check'
        AND pa.unapplied_at IS NULL
        AND b.status NOT IN ('void', 'cancelled')
        AND ((NOT e.early AND vp.check_cleared_date IS NULL AND vp.payment_date <= $3::date)
          OR (e.early AND vp.check_cleared_date > $3::date
              AND vp.payment_date >= $2::date AND vp.payment_date <= $3::date))
      GROUP BY b.id, vp.id
      ORDER BY vp.payment_date, vp.payment_number, b.bill_number`,
    [entityId, range.desde, range.hasta]
  );
  return rows;
}

interface FilaRenglon {
  bill_id: string;
  tipo_factor: string;
  tax_rate: string | null;
  valor_actos: string | null;
  line_amount: string;
  tax_amount: string;
}

async function renglonesDe(
  client: pg.PoolClient,
  entityId: string,
  billIds: readonly string[]
): Promise<Map<string, RenglonDeGasto[]>> {
  const porGasto = new Map<string, RenglonDeGasto[]>();
  if (billIds.length === 0) return porGasto;
  const { rows } = await client.query<FilaRenglon>(
    `SELECT bl.bill_id, bl.tipo_factor, bl.tax_rate::text, bl.valor_actos::text,
            bl.line_amount::text, bl.tax_amount::text
       FROM bill_lines bl
       JOIN bills b ON b.id = bl.bill_id
      WHERE b.entity_id = $1 AND bl.bill_id = ANY($2::uuid[])
      ORDER BY bl.bill_id, bl.line_number`,
    [entityId, [...billIds]]
  );
  for (const r of rows) {
    const lista = porGasto.get(r.bill_id) ?? [];
    lista.push({
      tipoFactor: r.tipo_factor as TipoFactor,
      tasa: r.tax_rate,
      valorActos: r.valor_actos,
      importe: r.line_amount,
      iva: r.tax_amount,
    });
    porGasto.set(r.bill_id, lista);
  }
  return porGasto;
}

/**
 * The tax summary of the CFDI each bill was born from, by provenance: the
 * pre-registration that created the bill keeps it in `bill_id`, at both doors.
 * Scoped by entity in the SQL; a bill with no pre-registration has no row.
 */
async function cfdiSummariesOf(
  client: pg.PoolClient,
  entityId: string,
  billIds: readonly string[]
): Promise<Map<string, CfdiTaxSummary>> {
  const byBill = new Map<string, CfdiTaxSummary>();
  if (billIds.length === 0) return byBill;
  const { rows } = await client.query<{ bill_id: string; tax_breakdown: CfdiTaxSummary }>(
    `SELECT p.bill_id, p.tax_breakdown
       FROM pre_registrations p
      WHERE p.entity_id = $1 AND p.document_type = 'bill' AND p.bill_id = ANY($2::uuid[])
        AND p.tax_breakdown IS NOT NULL`,
    [entityId, [...billIds]]
  );
  for (const r of rows) byBill.set(r.bill_id, r.tax_breakdown);
  return byBill;
}

/**
 * El IVA retenido de cada gasto, del CFDI que lo originó.
 *
 * NO HAY COLUMNA DE RETENCIÓN EN `bill_lines`: la 063 añadió la tasa, el tipo
 * de factor y el valor de los actos, no la retención. El único sitio donde el
 * dato está guardado es `xml_documents.total_iva_retenido`, y se llega por
 * `bills.cfdi_uuid` (la 037). Un gasto capturado a mano sin comprobante no
 * tiene ese puente y declara cero retenido, que es lo correcto: no consta.
 *
 * Se acota también por entidad en el JOIN porque un mismo CFDI puede estar
 * ingerido dos veces dentro del mismo inquilino cuando las dos partes son
 * entidades del grupo — el mismo motivo por el que `cfdiMetodoPagoByUuid` lo
 * hace en iva-cash-basis.
 */
async function retencionesDe(
  client: pg.PoolClient,
  entityId: string,
  billIds: readonly string[]
): Promise<Map<string, string>> {
  const porGasto = new Map<string, string>();
  if (billIds.length === 0) return porGasto;
  const { rows } = await client.query<{ bill_id: string; retenido: string }>(
    `SELECT b.id AS bill_id, COALESCE(x.total_iva_retenido, 0)::text AS retenido
       FROM bills b
       JOIN xml_documents x ON x.cfdi_uuid = b.cfdi_uuid AND x.entity_id = b.entity_id
      WHERE b.entity_id = $1 AND b.id = ANY($2::uuid[]) AND b.cfdi_uuid IS NOT NULL`,
    [entityId, [...billIds]]
  );
  for (const r of rows) porGasto.set(r.bill_id, r.retenido);
  return porGasto;
}

/**
 * What each bill has applied by vendor payments credited up to `hasta`. Both
 * ends of the bridge are scoped, and the applications are the ones
 * `gastosPagadosEnElMes` counts, on the same day (`APPLICATION_CREDIT_DATE`):
 * a cheque that waits for its cashing has paid nothing yet (MNE-001-559), and
 * cash on account pays the day it is applied (MNE-001-679).
 */
async function appliedThrough(
  client: pg.PoolClient,
  entityId: string,
  billIds: readonly string[],
  hasta: string
): Promise<Map<string, string>> {
  const byBill = new Map<string, string>();
  if (billIds.length === 0) return byBill;
  const { rows } = await client.query<{ bill_id: string; applied: string }>(
    `SELECT pa.bill_id, SUM(pa.amount_applied)::text AS applied
       FROM payment_applications pa
       JOIN bills b ON b.id = pa.bill_id
       JOIN vendor_payments vp ON vp.id = pa.payment_id
      WHERE b.entity_id = $1 AND vp.entity_id = $1 AND pa.bill_id = ANY($2::uuid[])
        AND vp.journal_entry_id IS NOT NULL AND vp.status <> 'void'
        AND ${APPLICATION_CREDIT_DATE} <= $3::date
      GROUP BY pa.bill_id`,
    [entityId, [...billIds], hasta]
  );
  for (const r of rows) byBill.set(r.bill_id, r.applied);
  return byBill;
}

/**
 * Todo lo que el mes declara, documento por documento.
 * The two notices about cheques (MNE-001-559) are at the end, from `checksToFlag`.
 *
 * Los avisos que salen de aquí son los que sólo se ven con la base delante:
 * el PUE acreditado al contabilizarse y sin un peso aplicado, el PUE cuyo IVA
 * espera su pago en 1135 al cierre del mes y el gasto cuyo tope aparcado deja
 * el IVA por debajo de lo que la proporción pedía.
 */
export async function hechosDelMes(
  client: pg.PoolClient,
  entityId: string,
  anio: number,
  mes: number
): Promise<{ hechos: HechoPagado[]; hallazgos: Hallazgo[] }> {
  const rango = rangoDelMes(anio, mes);
  const hallazgos: Hallazgo[] = [];
  const hechos: HechoPagado[] = [];

  const datedInMonth = await gastosDelMes(client, entityId, rango);
  const paidInMonth = await gastosPagadosEnElMes(client, entityId, rango);

  const byBill: FilaGasto[] = [];
  const byPayment: FilaGasto[] = [];
  const clasificado = new Map<string, MetodoPagoDecision>();

  const metodoDe = async (g: FilaGasto): Promise<MetodoPagoDecision> => {
    const ya = clasificado.get(g.id);
    if (ya) return ya;
    const d = await resolveBillMetodoPago(client, {
      id: g.id,
      entity_id: entityId,
      bill_number: g.bill_number,
      terms: g.terms,
      memo: g.memo,
    });
    clasificado.set(g.id, d);
    return d;
  };

  // What each bill parked in 1135, read once: the cap of a payment-month fact
  // and, for a PUE, what decides its event.
  const parked = new Map<string, Decimal>();
  const parkedOf = async (g: FilaGasto): Promise<Decimal> => {
    const known = parked.get(g.id);
    if (known) return known;
    const cap = new Decimal(await ivaStillParked(client, 'received', entityId, g.id));
    parked.set(g.id, cap);
    return cap;
  };

  // ONE EVENT PER BILL (MNE-001-491). A PUE that parked nothing (its IVA went
  // to 1130, it was paid in its own entry, or it has no IVA) is declared whole
  // in its bill month; every other bill by its payments, cap included. Both
  // lists ask this one predicate, so a bill can never be declared twice.
  // NOTE: the question is what the bill PARKED, not what is left (MNE-001-492).
  // A release does not lower the cap (its entry carries the payment as
  // source), but a credit note's entry does: read net, a parked PUE credited
  // in full by a note would fall back to its bill month and be declared whole
  // there, with IVA that never reached 1130. So a zero cap is asked again
  // without the notes.
  const events = new Map<string, HechoPagado['event']>();
  const eventOf = async (g: FilaGasto): Promise<HechoPagado['event']> => {
    const known = events.get(g.id);
    if (known) return known;
    const parkedNothing =
      (await parkedOf(g)).isZero() &&
      new Decimal(
        await ivaStillParked(client, 'received', entityId, g.id, { beforeCreditNotes: true })
      ).isZero();
    const event = (await metodoDe(g)).metodo === 'PUE' && parkedNothing ? 'bill' : 'payment';
    events.set(g.id, event);
    return event;
  };

  const waiting: FilaGasto[] = [];
  for (const g of datedInMonth) {
    if ((await eventOf(g)) === 'bill') byBill.push(g);
    else if (clasificado.get(g.id)!.metodo === 'PUE') waiting.push(g);
  }
  for (const g of paidInMonth) {
    if ((await eventOf(g)) === 'payment') byPayment.push(g);
  }

  // ── El PUE que espera: su IVA sigue en 1135 al cierre de su mes ────────
  // Nada se retiene por él: la DIOT ya declara sólo lo pagado. El aviso dice
  // por qué el gasto no está, o no está entero, y qué le toca a su emisor.
  const applied = await appliedThrough(client, entityId, waiting.map((g) => g.id), rango.hasta);
  for (const g of waiting) {
    const paid = new Decimal(applied.get(g.id) ?? '0');
    if (paid.greaterThanOrEqualTo(g.total_amount)) continue;
    hallazgos.push({
      codigo: 'DIOT-PUE-ESPERA-PAGO',
      severidad: 'aviso',
      documentId: g.id,
      documentNumber: g.bill_number,
      mensaje:
        `El gasto ${g.bill_number} es PUE (método leído de: ${clasificado.get(g.id)!.origin}) y su IVA ` +
        `espera el pago en la 1135: al cierre del mes tiene aplicado ${q(paid)} de ` +
        `${q(new Decimal(g.total_amount))}, y la DIOT sólo declara lo pagado. Sin pagar pasado su mes de ` +
        `emisión (el 17 del mes siguiente si el emisor es del sector financiero), la regla 2.7.1.39 ` +
        `hace que su emisor lo sustituya por un CFDI PPD.`,
    });
  }

  const ids = [...byBill.map((g) => g.id), ...byPayment.map((g) => g.id)];
  const renglones = await renglonesDe(client, entityId, ids);
  const summaries = await cfdiSummariesOf(client, entityId, ids);
  const retenciones = await retencionesDe(client, entityId, ids);

  const arma = (
    g: FilaGasto,
    event: HechoPagado['event'],
    porcion: PorcionPagada,
    ivaPagado: string
  ): HechoPagado => ({
    billId: g.id,
    billNumber: g.bill_number,
    vendorId: g.vendor_id,
    metodo: clasificado.get(g.id)!,
    event,
    ivaCabecera: g.tax_amount,
    ivaPagado,
    ivaRetenido: porcionDelDocumento(retenciones.get(g.id) ?? '0', porcion),
    porcion,
    renglones: linesToSplit(renglones.get(g.id) ?? [], g.tax_amount, summaries.get(g.id)),
  });

  // ── El gasto: un PUE sin IVA aparcado, entero en su mes ────────────────
  for (const g of byBill) {
    const metodo = clasificado.get(g.id)!;
    const porcion: PorcionPagada = {
      aplicadoPrevio: '0',
      aplicadoAhora: g.total_amount,
      totalDocumento: g.total_amount,
      tasaCambio: g.exchange_rate,
    };
    const ivaPagado = acumuladoDelDocumento(
      g.tax_amount,
      g.total_amount,
      g.total_amount,
      g.exchange_rate
    );

    // El PUE declara «pagado en una sola exhibición», y el mayor le creyó:
    // el IVA fue directo a 1130 al contabilizar. Si además resulta que no se
    // le ha aplicado un peso, el IVA se acredita antes de pagarse, y quien
    // firma tiene derecho a saberlo antes de firmar. El aviso dice lo que
    // pasó; no supone que el método esté mal (MNE-001-491).
    if (new Decimal(g.amount_paid || '0').lessThanOrEqualTo(0)) {
      hallazgos.push({
        codigo: 'DIOT-PUE-SIN-PAGO',
        severidad: 'aviso',
        documentId: g.id,
        documentNumber: g.bill_number,
        mensaje:
          `El gasto ${g.bill_number} es PUE (método leído de: ${metodo.origin}) y su IVA fue a la ` +
          `1130 al contabilizarlo, así que entra completo en la DIOT de este mes; pero no tiene ` +
          `ningún pago aplicado: su IVA se está acreditando antes de pagarse.`,
      });
    }
    hechos.push(arma(g, 'bill', porcion, ivaPagado));
  }

  // ── El pago: el incremento del mes, con el tope de lo aparcado ─────────
  for (const g of byPayment) {
    const hastaFin = g.aplicado_hasta_fin ?? '0';
    const hastaInicio = g.aplicado_hasta_inicio ?? '0';
    const porcion: PorcionPagada = {
      aplicadoPrevio: hastaInicio,
      aplicadoAhora: q(new Decimal(hastaFin).minus(hastaInicio)),
      totalDocumento: g.total_amount,
      tasaCambio: g.exchange_rate,
    };

    // El tope de lo que este documento APARCÓ. Un gasto contabilizado antes
    // de que existiera el IVA en flujo mandó su IVA directo a 1130 y no
    // aparcó nada: su tope es cero y su pago no acredita nada por segunda vez.
    const aparcado = await parkedOf(g);

    // Se topan los ACUMULADOS y se restan después, no al revés: topar el
    // tramo dejaría que la suma de los meses superase lo aparcado.
    const acumFin = Decimal.min(
      new Decimal(acumuladoDelDocumento(g.tax_amount, hastaFin, g.total_amount, g.exchange_rate)),
      aparcado
    );
    const acumInicio = Decimal.min(
      new Decimal(
        acumuladoDelDocumento(g.tax_amount, hastaInicio, g.total_amount, g.exchange_rate)
      ),
      aparcado
    );
    const ivaPagado = Decimal.max(acumFin.minus(acumInicio), new Decimal(0));

    const sinTope = new Decimal(porcionDelDocumento(g.tax_amount, porcion));
    if (sinTope.greaterThan(ivaPagado)) {
      hallazgos.push({
        codigo: 'DIOT-TOPE-APARCADO',
        severidad: 'aviso',
        documentId: g.id,
        documentNumber: g.bill_number,
        mensaje:
          `El gasto ${g.bill_number} pagó una proporción que valdría ${q(sinTope)} de IVA ` +
          `acreditable, pero sólo tiene ${q(aparcado)} aparcado en 1135 y el mes declara ` +
          `${q(ivaPagado)}. Suele significar que el gasto se contabilizó antes de que el IVA ` +
          `en flujo existiera: su IVA ya se acreditó cuando llegó la factura.`,
      });
    }

    hechos.push(arma(g, 'payment', porcion, q(ivaPagado)));
  }

  // ── The cheque: what the month does not credit yet, or credited early ──
  // Notices only. Waiting for the cashing never underpays, and a cheque
  // credited on its payment day keeps that month: the past is not rewritten.
  // A bill declared by its own entry is not dated by its payments at all.
  for (const c of await checksToFlag(client, entityId, rango)) {
    if ((await eventOf(c)) !== 'payment') continue;
    const iva = acumuladoDelDocumento(c.tax_amount, c.applied, c.total_amount, c.exchange_rate);
    hallazgos.push(
      c.cashed_on === null
        ? {
            codigo: 'DIOT-CHEQUE-NOT-CASHED',
            severidad: 'aviso',
            documentId: c.id,
            documentNumber: c.bill_number,
            mensaje:
              `El cheque ${c.label} del ${c.signed_on} pagó ${q(new Decimal(c.applied))} del gasto ` +
              `${c.bill_number} y no tiene cobro registrado: su IVA (${iva}) sigue en la 1135 y ningún mes ` +
              `lo acredita hasta que el banco lo cobre. Registra el cobro con \`bank check reconcile\`.`,
          }
        : {
            codigo: 'DIOT-CHEQUE-CREDITED-BEFORE-CASHING',
            severidad: 'aviso',
            documentId: c.id,
            documentNumber: c.bill_number,
            mensaje:
              `El cheque ${c.label} del ${c.signed_on} pagó el gasto ${c.bill_number} y su póliza acreditó ` +
              `el IVA ese día, pero el banco lo cobró el ${c.cashed_on}: el pago con cheque se da por hecho ` +
              `el día del cobro, así que ese IVA (${iva}) corresponde al mes ${c.cashed_on.slice(0, 7)}. Este ` +
              `mes lo conserva, como lo hizo el mayor; si su declaración ya se presentó con él, puede ` +
              `requerir una complementaria.`,
          }
    );
  }

  return { hechos, hallazgos };
}
