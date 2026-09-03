import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import {
  exigirSegregacion, createJournalEntry, reverseWithinTransaction } from './posting.js';
import {
  checkDraftDocument,
  resolveDraftLines,
  type DraftEntryInput,
  type DraftLineInput,
} from './journal-entry-service.js';
import type { JournalEntry, JournalEntryType } from '../../types/index.js';

// ============================================================
// EL LOTE IMPORTADO POR FIN SE PUEDE APLICAR (F06c · 045)
//
// `entry import` deposita pólizas en el staging de la 045 desde F01, y hasta
// hoy nadie podía verificarlas, aplicarlas ni reversarlas: una puerta de
// entrada a un almacén sin salida. Este servicio es la salida, y respeta la
// máquina de estados que la 045 talló en su CHECK:
//
//     staged ──check──► checked ──post──► posted
//        ▲                                  │
//        └──── (--partial deja aquí ────────┘ reverse: espejos, el estado
//               lo que no pasó)               se queda en 'posted')
//
// CUATRO DECISIONES SOSTIENEN EL ARCHIVO:
//
// 1. EL PAYLOAD ES INPUT NO CONFIABLE aunque lo haya escrito nuestro propio
//    parser: entre el stage y el post pudo pasar cualquier cosa (otra versión
//    del parser, una fila tocada a mano en la base). Cada fila se normaliza
//    con tipos vigilados y los importes viajan SIEMPRE como cadenas — un
//    número JSON se rescata con String(), que no hace aritmética flotante,
//    y el formato lo juzga la misma regla que juzga un asiento manual.
//
// 2. LAS REGLAS SON LAS DEL ASIENTO MANUAL, REUSADAS Y NO COPIADAS: cada
//    fila pasa por checkDraftDocument (forma → periodo → cuentas →
//    validateJournalEntry con sus siete reglas). Reimplementarlas aquí
//    garantizaría que check y post diverjan el día que una regla cambie.
//
// 3. EL VÍNCULO fila↔póliza VIVE EN LA PÓLIZA, no en la fila: la 045 no dio
//    columna para él y no hay migraciones nuevas. source_type =
//    ORIGEN_LOTE_IMPORTADO distingue estas pólizas de las manuales (para
//    `ap reconcile` y los informes), y source_id = EL ID DE LA FILA — no el
//    del lote— porque así el mapeo es exacto en ambas direcciones y el campo
//    `reference` queda libre para la referencia que el archivo trajo. Las
//    pólizas de un lote se encuentran TODAS con un JOIN a sus filas, acotado
//    dentro del SQL.
//
// 4. PROPONER FUERA, APLICAR DENTRO (el patrón de match-service): la
//    validación por fila lee por el pool; la escritura va en UNA transacción
//    que recomprueba el estado bajo FOR UPDATE. El ensayo (--dry-run) recorre
//    el camino real y revierte lanzando, jamás simulando.
//
// LA FRONTERA. `journal_entry_import_batches` trae tenant_id Y entity_id:
// toda lectura y escritura del encabezado lleva los dos en el WHERE. Las
// filas sólo traen tenant_id: se acotan por (tenant_id, batch_id) con el
// lote ya acotado, y los JOIN hacia journal_entries exigen entity_id además.
// Van cuatro fugas cerradas en este proyecto; ninguna entra por aquí.
// ============================================================

/**
 * El origen de toda póliza nacida de un lote importado. Mismo criterio que
 * ORIGENES_DE_TESORERIA (treasury-posting.ts): sin él, quinientas pólizas
 * importadas serían indistinguibles de quinientas pólizas tecleadas a mano
 * para cualquier informe que separe subdiario de captura.
 */
export const ORIGEN_LOTE_IMPORTADO = 'import_batch';

export interface ContextoLote {
  tenantId: string;
  entityId: string;
}

/** El flujo de la 045, literal. 'discarded' existe en el CHECK pero no tiene
 *  comando en fase 1: este servicio no lo escribe nunca. */
export const ESTADOS_LOTE = ['staged', 'checked', 'posted', 'discarded'] as const;
export type EstadoLote = (typeof ESTADOS_LOTE)[number];

/** Hoy el único productor de lotes es `entry import`; las clases futuras
 *  (recurrentes, revaluaciones, cierres) llegarán con su productor. */
export const CLASES_DE_LOTE = ['import'] as const;

/** Por qué una fila no pasa, en vocabulario cerrado: contable, no grepeable. */
export const CATEGORIAS_DE_HALLAZGO = ['parse', 'forma', 'cuenta', 'periodo', 'validacion'] as const;
export type CategoriaDeHallazgo = (typeof CATEGORIAS_DE_HALLAZGO)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface EncabezadoLote {
  id: string;
  tenant_id: string;
  entity_id: string;
  layout: string;
  file_name: string | null;
  file_hash: string;
  rows_total: number;
  rows_invalid: number;
  status: EstadoLote;
  created_by: string;
  created_at: Date;
}

interface FilaAlmacenada {
  id: string;
  row_number: number;
  payload: unknown;
  parse_error: string | null;
}

// ── Normalización del payload: la aduana de tipos ──

function importeComoCadena(v: unknown, lado: string, linea: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v.trim();
  // Un número JSON se rescata: String() reproduce el literal más corto sin
  // hacer aritmética. El FORMATO (positivo, ≤4 decimales, sin exponente) lo
  // juzga después validateDraftShape con la misma vara que un asiento manual.
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new ValidationError(
    `línea ${linea}: el ${lado} debe ser una cadena decimal (o número JSON finito), no ${typeof v}`
  );
}

function textoOpcional(v: unknown, campo: string, linea?: number): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  const donde = linea === undefined ? '' : `línea ${linea}: `;
  throw new ValidationError(`${donde}el campo ${campo} debe ser texto, no ${typeof v}`);
}

/**
 * Del JSONB crudo a un DraftEntryInput con tipos garantizados. Sólo vigila
 * TIPOS (¿es objeto?, ¿los importes son cadena o número?); las reglas
 * contables de forma (fecha válida, dos líneas, un solo lado, importe
 * positivo) las aplica checkDraftDocument, que es la MISMA puerta por la que
 * pasa un asiento tecleado a mano.
 */
export function normalizarPayload(
  entityId: string,
  createdBy: string,
  payload: unknown
): DraftEntryInput {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ValidationError('el payload de la fila no es un objeto de póliza');
  }
  const p = payload as Record<string, unknown>;

  if (typeof p.date !== 'string') {
    throw new ValidationError('la fecha de la póliza debe ser texto YYYY-MM-DD');
  }
  if (!Array.isArray(p.lines)) {
    throw new ValidationError('el campo lines debe ser una lista de líneas');
  }

  const crudas = p.lines as unknown[];
  const lines: DraftLineInput[] = crudas.map((cruda, i) => {
    const n = i + 1;
    if (typeof cruda !== 'object' || cruda === null || Array.isArray(cruda)) {
      throw new ValidationError(`línea ${n}: no es un objeto de línea`);
    }
    const l = cruda as Record<string, unknown>;
    let account: string;
    if (typeof l.account === 'string') {
      account = l.account;
    } else if (typeof l.account === 'number' && Number.isFinite(l.account)) {
      // Un código numérico en JSON ("account": 6100) es un descuido del
      // archivo, no un ataque: se acepta como texto.
      account = String(l.account);
    } else {
      throw new ValidationError(`línea ${n}: el código de cuenta debe ser texto`);
    }
    return {
      account,
      debit: importeComoCadena(l.debit, 'debit', n),
      credit: importeComoCadena(l.credit, 'credit', n),
      description: textoOpcional(l.description, 'description', n) ?? '',
    };
  });

  return {
    entityId,
    createdBy,
    date: p.date,
    description: textoOpcional(p.description, 'description'),
    reference: textoOpcional(p.reference, 'reference'),
    lines,
  };
}

// ── El veredicto por fila ──

export interface HallazgoDeFila {
  row_number: number;
  ok: boolean;
  categoria: CategoriaDeHallazgo | null;
  errores: string[];
  advertencias: string[];
}

interface FilaJuzgada {
  hallazgo: HallazgoDeFila;
  /** Sólo cuando ok: lo que postBatch convierte en póliza. */
  borrador: DraftEntryInput | null;
  filaId: string;
}

/**
 * Una fila que no valida NO tumba a las demás: aquí toda falla esperada se
 * vuelve hallazgo con su número de fila y su porqué, y sólo lo inesperado
 * (un fallo de infraestructura) sigue lanzando.
 */
async function juzgarFila(
  ctx: ContextoLote,
  userId: string,
  fila: FilaAlmacenada
): Promise<FilaJuzgada> {
  const veredicto = (
    ok: boolean,
    categoria: CategoriaDeHallazgo | null,
    errores: string[],
    advertencias: string[] = [],
    borrador: DraftEntryInput | null = null
  ): FilaJuzgada => ({
    hallazgo: { row_number: fila.row_number, ok, categoria, errores, advertencias },
    borrador,
    filaId: fila.id,
  });

  // La fila que el parser no pudo leer llega con su parse_error de la 045:
  // no hay nada que revalidar, sólo repetir el porqué original.
  if (fila.parse_error) return veredicto(false, 'parse', [fila.parse_error]);

  let borrador: DraftEntryInput;
  try {
    borrador = normalizarPayload(ctx.entityId, userId, fila.payload);
  } catch (e) {
    if (e instanceof ValidationError) return veredicto(false, 'forma', [e.message]);
    throw e;
  }

  try {
    const r = await checkDraftDocument(borrador);
    if (r.errors.length > 0) return veredicto(false, 'validacion', [...r.errors], [...r.warnings]);
    return veredicto(true, null, [], [...r.warnings], borrador);
  } catch (e) {
    // checkDraftDocument distingue sus fallas por clase: NotFoundError es la
    // cuenta que la entidad no tiene; ValidationError es o la forma del
    // borrador o el periodo sin abrir — el mensaje del periodo es el único
    // que nombra "fiscal period".
    if (e instanceof NotFoundError) return veredicto(false, 'cuenta', [e.message]);
    if (e instanceof ValidationError) {
      return veredicto(false, /fiscal period/i.test(e.message) ? 'periodo' : 'forma', [e.message]);
    }
    throw e;
  }
}

// ── Lecturas acotadas ──

async function loteAcotado(
  ctx: ContextoLote,
  batchId: string,
  client?: pg.PoolClient,
  forUpdate = false
): Promise<EncabezadoLote> {
  // tenant_id Y entity_id en el mismo WHERE que el id: cero filas significa a
  // la vez «no existe» y «no es tuyo», y el programa no puede distinguirlos.
  const sql = `SELECT * FROM journal_entry_import_batches
                WHERE id = $1 AND tenant_id = $2 AND entity_id = $3${forUpdate ? ' FOR UPDATE' : ''}`;
  const params = [batchId, ctx.tenantId, ctx.entityId];
  const r = client
    ? await client.query<EncabezadoLote>(sql, params)
    : await query<EncabezadoLote>(sql, params);
  if (r.rows.length === 0) throw new NotFoundError('Import batch', batchId);
  return r.rows[0];
}

async function filasDelLote(ctx: ContextoLote, batchId: string): Promise<FilaAlmacenada[]> {
  const r = await query<FilaAlmacenada>(
    `SELECT id, row_number, payload, parse_error
       FROM journal_entry_import_rows
      WHERE tenant_id = $1 AND batch_id = $2
      ORDER BY row_number`,
    [ctx.tenantId, batchId]
  );
  return r.rows;
}

function exigirEstado(lote: EncabezadoLote, permitidos: EstadoLote[], porQue: string): void {
  if (permitidos.includes(lote.status)) return;
  throw new ConflictError(
    `El lote ${lote.id} está '${lote.status}' y este acto exige ` +
      `'${permitidos.join("' o '")}': ${porQue} ` +
      `El flujo del lote es staged → checked → posted.`
  );
}

// ── El ensayo (patrón EnsayoEvento de payment-service) ──

/**
 * La vista previa corre EL MISMO camino y revierte al final. Lanzar es lo que
 * garantiza el ROLLBACK: si devolviera normalmente, la transacción se
 * confirmaría y el «ensayo» habría escrito.
 */
class EnsayoLote extends Error {
  constructor(public readonly resultado: unknown) {
    super('dry-run');
  }
}

async function enTransaccion<T>(correr: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoLote) return e.resultado as T;
    throw e;
  }
}

// ── batch list · lote listar ──

export interface FiltrosDeLote {
  /** Uno de ESTADOS_LOTE. */
  status?: string;
  /** Una de CLASES_DE_LOTE (hoy sólo 'import'). */
  kind?: string;
  /** created_at >= since (YYYY-MM-DD). */
  since?: string;
  limit?: number;
}

export interface ResumenDeLote {
  id: string;
  kind: (typeof CLASES_DE_LOTE)[number];
  layout: string;
  file_name: string | null;
  file_hash: string;
  status: EstadoLote;
  rows_total: number;
  rows_invalid: number;
  /** Pólizas ya en el mayor nacidas de este lote. */
  entries_posted: number;
  created_by: string;
  created_at: Date;
}

export async function listBatches(
  ctx: ContextoLote,
  filtros: FiltrosDeLote = {}
): Promise<ResumenDeLote[]> {
  if (filtros.kind && !(CLASES_DE_LOTE as readonly string[]).includes(filtros.kind)) {
    throw new ValidationError(
      `Clase de lote desconocida "${filtros.kind}". Hoy sólo existe: ${CLASES_DE_LOTE.join(', ')} ` +
        '(las corridas recurrentes, revaluaciones y cierres llegarán con su propio productor).'
    );
  }
  if (filtros.status && !(ESTADOS_LOTE as readonly string[]).includes(filtros.status)) {
    throw new ValidationError(
      `Estado de lote desconocido "${filtros.status}". El flujo de la 045: ${ESTADOS_LOTE.join(', ')}.`
    );
  }
  if (filtros.since && !DATE_RE.test(filtros.since)) {
    throw new ValidationError(`"${filtros.since}" no es una fecha YYYY-MM-DD.`);
  }

  const where: string[] = ['b.tenant_id = $1', 'b.entity_id = $2'];
  const params: unknown[] = [ctx.tenantId, ctx.entityId, ORIGEN_LOTE_IMPORTADO];
  let i = 4;
  if (filtros.status) {
    where.push(`b.status = $${i++}`);
    params.push(filtros.status);
  }
  if (filtros.since) {
    where.push(`b.created_at >= $${i++}`);
    params.push(filtros.since);
  }
  params.push(filtros.limit ?? 50);

  // entries_posted cuenta por el vínculo fila→póliza (source_id = fila): los
  // espejos de una reversa no cuentan porque nacen sin source_type.
  const r = await query<ResumenDeLote>(
    `SELECT b.id, 'import' AS kind, b.layout, b.file_name, b.file_hash, b.status,
            b.rows_total, b.rows_invalid, b.created_by, b.created_at,
            (SELECT COUNT(*)::int
               FROM journal_entries je
               JOIN journal_entry_import_rows r
                 ON r.id = je.source_id AND r.tenant_id = b.tenant_id AND r.batch_id = b.id
              WHERE je.entity_id = b.entity_id AND je.source_type = $3
            ) AS entries_posted
       FROM journal_entry_import_batches b
      WHERE ${where.join(' AND ')}
      ORDER BY b.created_at DESC
      LIMIT $${i}`,
    params
  );
  return r.rows;
}

// ── batch show · lote ver ──

export interface FilaDetallada {
  row_number: number;
  parse_error: string | null;
  /** Categoría del parse_error almacenado; null si la fila parseó bien. */
  categoria: string | null;
  date: string | null;
  description: string | null;
  lineas: number | null;
  /** Suma de cargos del payload (Decimal sobre cadenas); null si es basura. */
  total_debe: string | null;
  entry_id: string | null;
  entry_number: string | null;
  entry_reversed: boolean;
}

export interface DetalleDeLote {
  lote: ResumenDeLote;
  filas: FilaDetallada[];
  errores_por_categoria: Record<string, number>;
}

/** El vocabulario del parser de F01, agrupado para contarse. */
function categoriaDeParseError(msg: string): string {
  if (/^JSON ilegible/.test(msg)) return 'json';
  if (/fecha/i.test(msg)) return 'fecha';
  if (/dos líneas/.test(msg)) return 'lineas';
  if (/sin código de cuenta/.test(msg)) return 'cuenta';
  if (/exactamente un lado/.test(msg)) return 'importe';
  return 'otro';
}

/** Resumen legible del payload, tolerante a basura: aquí nada lanza. */
function resumenDePayload(payload: unknown): { date: string | null; description: string | null; lineas: number | null; total_debe: string | null } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { date: null, description: null, lineas: null, total_debe: null };
  }
  const p = payload as Record<string, unknown>;
  const date = typeof p.date === 'string' ? p.date : null;
  const description = typeof p.description === 'string' ? p.description : null;
  if (!Array.isArray(p.lines)) return { date, description, lineas: null, total_debe: null };
  const lineas = p.lines as unknown[];
  let total: Decimal | null = new Decimal(0);
  for (const cruda of lineas) {
    if (typeof cruda !== 'object' || cruda === null) {
      total = null;
      break;
    }
    const l = cruda as Record<string, unknown>;
    try {
      const debe = importeComoCadena(l.debit, 'debit', 0);
      if (debe !== null) total = total.plus(new Decimal(debe));
    } catch {
      total = null;
      break;
    }
  }
  return { date, description, lineas: lineas.length, total_debe: total ? total.toFixed(4) : null };
}

export async function showBatch(ctx: ContextoLote, batchId: string): Promise<DetalleDeLote> {
  const encabezado = await loteAcotado(ctx, batchId);
  const contadas = await query<{ entries_posted: number }>(
    `SELECT COUNT(*)::int AS entries_posted
       FROM journal_entries je
       JOIN journal_entry_import_rows r
         ON r.id = je.source_id AND r.tenant_id = $1 AND r.batch_id = $2
      WHERE je.entity_id = $3 AND je.source_type = $4`,
    [ctx.tenantId, batchId, ctx.entityId, ORIGEN_LOTE_IMPORTADO]
  );
  const lote: ResumenDeLote = {
    id: encabezado.id,
    kind: 'import',
    layout: encabezado.layout,
    file_name: encabezado.file_name,
    file_hash: encabezado.file_hash,
    status: encabezado.status,
    rows_total: encabezado.rows_total,
    rows_invalid: encabezado.rows_invalid,
    entries_posted: contadas.rows[0]?.entries_posted ?? 0,
    created_by: encabezado.created_by,
    created_at: encabezado.created_at,
  };

  const r = await query<{
    row_number: number;
    payload: unknown;
    parse_error: string | null;
    entry_id: string | null;
    entry_number: string | null;
    reversed_by_entry_id: string | null;
  }>(
    `SELECT r.row_number, r.payload, r.parse_error,
            je.id AS entry_id, je.entry_number, je.reversed_by_entry_id
       FROM journal_entry_import_rows r
       LEFT JOIN journal_entries je
         ON je.source_id = r.id AND je.source_type = $3 AND je.entity_id = $4
      WHERE r.tenant_id = $1 AND r.batch_id = $2
      ORDER BY r.row_number`,
    [ctx.tenantId, batchId, ORIGEN_LOTE_IMPORTADO, ctx.entityId]
  );

  const porCategoria: Record<string, number> = {};
  const filas: FilaDetallada[] = r.rows.map((fila) => {
    const resumen = resumenDePayload(fila.payload);
    let categoria: string | null = null;
    if (fila.parse_error) {
      categoria = categoriaDeParseError(fila.parse_error);
      porCategoria[categoria] = (porCategoria[categoria] ?? 0) + 1;
    }
    return {
      row_number: fila.row_number,
      parse_error: fila.parse_error,
      categoria,
      ...resumen,
      entry_id: fila.entry_id,
      entry_number: fila.entry_number,
      entry_reversed: fila.reversed_by_entry_id !== null,
    };
  });

  return { lote, filas, errores_por_categoria: porCategoria };
}

// ── batch check · lote verificar ──

export interface ResultadoVerificacion {
  batchId: string;
  status: EstadoLote;
  validas: number;
  invalidas: number;
  filas: HallazgoDeFila[];
}

/**
 * Valida CADA fila con las reglas del asiento manual y sólo si todas pasan
 * mueve staged→checked. Una fila mala no tumba el check de las demás: cada
 * una sale con su número y su porqué, y rows_invalid del encabezado queda
 * coherente con lo encontrado.
 */
export async function checkBatch(
  ctx: ContextoLote,
  batchId: string,
  userId: string,
  opts: { strict?: boolean } = {}
): Promise<ResultadoVerificacion> {
  const lote = await loteAcotado(ctx, batchId);
  exigirEstado(lote, ['staged'], 'verificar dos veces no aporta y verificar lo aplicado engaña.');

  // Proponer fuera: validación por el pool, sin candados abiertos mientras
  // se resuelven cuentas y periodos fila por fila.
  const filas = await filasDelLote(ctx, batchId);
  const hallazgos: HallazgoDeFila[] = [];
  for (const fila of filas) {
    const { hallazgo } = await juzgarFila(ctx, userId, fila);
    if (opts.strict && hallazgo.ok && hallazgo.advertencias.length > 0) {
      // --strict: la advertencia bloquea. Se reetiqueta aquí y no dentro de
      // juzgarFila porque post NUNCA es estricto: las advertencias no frenan
      // la aplicación, igual que no frenan entry post.
      hallazgos.push({
        ...hallazgo,
        ok: false,
        categoria: 'validacion',
        errores: hallazgo.advertencias.map((a) => `estricto: ${a}`),
      });
    } else {
      hallazgos.push(hallazgo);
    }
  }
  const invalidas = hallazgos.filter((h) => !h.ok).length;

  // Aplicar dentro: el estado se recomprueba bajo candado — entre la lectura
  // de arriba y este UPDATE pudo correr un post --partial concurrente.
  const status = await withTransaction(async (client) => {
    const bajoCandado = await loteAcotado(ctx, batchId, client, true);
    exigirEstado(bajoCandado, ['staged'], 'otro acto movió el lote mientras se verificaba.');
    const nuevo: EstadoLote = invalidas === 0 ? 'checked' : 'staged';
    await client.query(
      `UPDATE journal_entry_import_batches
          SET rows_invalid = $1, status = $2
        WHERE id = $3 AND tenant_id = $4 AND entity_id = $5`,
      [invalidas, nuevo, batchId, ctx.tenantId, ctx.entityId]
    );
    await registrarAuditoria(client, {
      tenantId: ctx.tenantId,
      userId,
      action: 'update',
      entityType: 'journal_entry_import_batches',
      entityId: batchId,
      oldValues: { status: bajoCandado.status, rows_invalid: bajoCandado.rows_invalid },
      newValues: { evento: 'check', status: nuevo, rows_invalid: invalidas, strict: opts.strict === true },
    });
    return nuevo;
  });

  return {
    batchId,
    status,
    validas: hallazgos.length - invalidas,
    invalidas,
    filas: hallazgos,
  };
}

// ── batch post · lote contabilizar ──

export interface PolizaDeFila {
  row_number: number;
  entry_id: string;
  entry_number: string;
}

export interface ResultadoAplicacion {
  batchId: string;
  status: EstadoLote;
  /** Pólizas creadas y posteadas en ESTA corrida, fila por fila. */
  posteadas: PolizaDeFila[];
  /** Filas saltadas porque una corrida --partial anterior ya las aplicó. */
  ya_posteadas: number;
  /** Con --partial: lo que quedó en staging, con su porqué. */
  invalidas: HallazgoDeFila[];
  /** Suma de cargos aplicados en esta corrida (cadena, escala de la columna). */
  total_debe: string;
  /** Para que el CLI dispare attestEntryAsync DESPUÉS del commit; vacío en ensayo. */
  attestations: Array<{ entityId: string; entryId: string }>;
  dryRun: boolean;
}

/**
 * Crea y postea las pólizas de las filas válidas EN UNA transacción, con
 * vínculo fila→póliza vía (source_type, source_id = fila). Sin --partial
 * exige 'checked' y aplica todo o nada; con --partial acepta también
 * 'staged', aplica lo válido y DEJA lo inválido en staging diciendo cuánto
 * quedó. Idempotente: la fila que ya tiene póliza se salta, así que postear
 * dos veces no postea dos veces.
 */
export async function postBatch(
  ctx: ContextoLote,
  batchId: string,
  userId: string,
  opts: { partial?: boolean; dryRun?: boolean } = {}
): Promise<ResultadoAplicacion> {
  const lote = await loteAcotado(ctx, batchId);
  const permitidos: EstadoLote[] = opts.partial ? ['staged', 'checked'] : ['checked'];
  exigirEstado(
    lote,
    permitidos,
    opts.partial
      ? 'un lote aplicado o descartado ya no tiene nada que aplicar.'
      : 'postear sin verificar es exactamente lo que este flujo existe para impedir — corre `batch check` primero, o usa --partial.'
  );

  // EL SEGUNDO PAR DE OJOS, ANTES DE MOVER NADA (G3).
  //
  // Ésta era la CUARTA puerta al mayor. El candado de `posting.ts` compara el
  // creador del ASIENTO contra quien lo postea, y aquí eso siempre sale
  // falso: los asientos del lote los crea y los postea el mismo acto. Así que
  // la comparación que importa —quien IMPORTÓ contra quien APLICA— sólo puede
  // hacerse aquí, donde consta quién preparó el lote. El candado es el mismo:
  // se le pasa el creador que a esta puerta le consta, en vez de copiarlo.
  //
  // Va antes de proponer para que un lote que no se puede aplicar no gaste
  // una validación de mil filas en decirlo.
  const notaSoD = await exigirSegregacion({
    tenantId: ctx.tenantId,
    entityId: ctx.entityId,
    creador: lote.created_by,
    ejecutor: userId,
    referencia: `El lote ${batchId}`,
  });
  // Con la política en 'alertar' no se bloquea, se anota. La fila de
  // auditoría del posteo la escribe el motor dentro de su transacción con su
  // propia nota; aquí, fuera de ella, lo que queda es el aviso al operador.
  if (notaSoD) logger.warn(`${notaSoD} — lote ${batchId}`);

  // Proponer fuera (patrón de match-service): la validación fila por fila lee
  // por el pool. Lo que asuma se recomprueba dentro: createJournalEntry con
  // autoPost revalida las siete reglas bajo la transacción, así que una
  // carrera entre esta lectura y el commit aborta el acto entero, nunca
  // postea de más.
  const filas = await filasDelLote(ctx, batchId);
  const juzgadas: FilaJuzgada[] = [];
  for (const fila of filas) {
    juzgadas.push(await juzgarFila(ctx, userId, fila));
  }

  return enTransaccion(async (client) => {
    const bajoCandado = await loteAcotado(ctx, batchId, client, true);
    exigirEstado(bajoCandado, permitidos, 'otro acto movió el lote mientras se validaba.');

    // Idempotencia por el vínculo fila→póliza: una corrida --partial anterior
    // (o un reintento tras un crash post-commit) dejó pólizas; esas filas no
    // se aplican de nuevo. El FOR UPDATE del encabezado serializa los post
    // concurrentes, así que esta foto no puede quedarse vieja.
    const ya = await client.query<{ row_number: number }>(
      `SELECT r.row_number
         FROM journal_entry_import_rows r
         JOIN journal_entries je
           ON je.source_id = r.id AND je.source_type = $1 AND je.entity_id = $2
        WHERE r.tenant_id = $3 AND r.batch_id = $4`,
      [ORIGEN_LOTE_IMPORTADO, ctx.entityId, ctx.tenantId, batchId]
    );
    const yaPosteadas = new Set(ya.rows.map((f) => f.row_number));

    const pendientesInvalidas = juzgadas
      .filter((j) => !j.hallazgo.ok && !yaPosteadas.has(j.hallazgo.row_number))
      .map((j) => j.hallazgo);

    if (!opts.partial && pendientesInvalidas.length > 0) {
      // Desde 'checked' esto significa que el mundo cambió después del check
      // (un periodo se cerró, una cuenta se desactivó): se dice cuáles y no
      // se aplica NADA — aplicar a medias sin que nadie pidiera --partial
      // sería decidir por el operador.
      const numeros = pendientesInvalidas.map((h) => h.row_number).join(', ');
      throw new ValidationError(
        `El lote estaba verificado pero ${pendientesInvalidas.length} fila(s) ya no pasan ` +
          `(filas ${numeros}): nada se aplicó. Corre \`batch check\` para el detalle o ` +
          '`batch post --partial` para aplicar sólo lo válido.',
        undefined,
        { filas: pendientesInvalidas.map((h) => ({ fila: h.row_number, errores: h.errores })) }
      );
    }

    const posteadas: PolizaDeFila[] = [];
    const attestations: Array<{ entityId: string; entryId: string }> = [];
    let totalDebe = new Decimal(0);
    let saltadas = 0;

    for (const j of juzgadas) {
      if (!j.hallazgo.ok || j.borrador === null) continue;
      if (yaPosteadas.has(j.hallazgo.row_number)) {
        saltadas += 1;
        continue;
      }
      const lineas = await resolveDraftLines(ctx.entityId, j.borrador.lines);
      const entry = await createJournalEntry(
        ctx.entityId,
        // Medianoche LOCAL, no UTC: la misma razón que createDraftEntry —
        // al oeste de Greenwich la medianoche UTC cae en el día anterior.
        new Date(`${j.borrador.date}T00:00:00`),
        'standard' as JournalEntryType,
        j.borrador.description ?? '',
        lineas,
        userId,
        {
          client,
          autoPost: true,
          sourceType: ORIGEN_LOTE_IMPORTADO,
          sourceId: j.filaId,
          reference: j.borrador.reference,
        }
      );
      posteadas.push({
        row_number: j.hallazgo.row_number,
        entry_id: entry.id,
        entry_number: entry.entry_number,
      });
      attestations.push({ entityId: ctx.entityId, entryId: entry.id });
      for (const linea of lineas) {
        if (linea.debit_amount !== null) totalDebe = totalDebe.plus(new Decimal(linea.debit_amount));
      }
    }

    const quedaron = opts.partial ? pendientesInvalidas : [];
    const nuevoEstado: EstadoLote = quedaron.length === 0 ? 'posted' : 'staged';
    await client.query(
      `UPDATE journal_entry_import_batches
          SET rows_invalid = $1, status = $2
        WHERE id = $3 AND tenant_id = $4 AND entity_id = $5`,
      [quedaron.length, nuevoEstado, batchId, ctx.tenantId, ctx.entityId]
    );

    await registrarAuditoria(client, {
      tenantId: ctx.tenantId,
      userId,
      action: 'post',
      entityType: 'journal_entry_import_batches',
      entityId: batchId,
      oldValues: { status: bajoCandado.status },
      newValues: {
        evento: 'post',
        status: nuevoEstado,
        polizas: posteadas.length,
        ya_posteadas: saltadas,
        quedaron: quedaron.length,
        partial: opts.partial === true,
        total_debe: totalDebe.toFixed(4),
      },
    });

    const salida: ResultadoAplicacion = {
      batchId,
      status: nuevoEstado,
      posteadas,
      ya_posteadas: saltadas,
      invalidas: quedaron,
      // Cuatro decimales, los de la columna: recortar a dos aquí es el
      // defecto que F05a cazó tres veces (treasury-posting.ts).
      total_debe: totalDebe.toFixed(4),
      // En ensayo la transacción se revierte: atestar una póliza que no
      // existe sería peor que no atestar.
      attestations: opts.dryRun ? [] : attestations,
      dryRun: opts.dryRun === true,
    };
    if (opts.dryRun) throw new EnsayoLote(salida);
    return salida;
  });
}

// ── batch reverse · lote reversar ──

export interface EspejoDeLote {
  original: string;
  espejo: string;
  espejo_id: string;
}

export interface ResultadoReversa {
  batchId: string;
  status: EstadoLote;
  espejos: EspejoDeLote[];
  /** Para attestEntryAsync tras el commit; vacío en ensayo. */
  attestations: Array<{ entityId: string; entryId: string }>;
  dryRun: boolean;
}

/**
 * Espejos de TODAS las pólizas del lote como unidad: una transacción, todos
 * los espejos, o nada — los errores de importación son de forma de lote, no
 * de póliza. Se niega si alguna póliza ya fue reversada fuera del lote,
 * diciendo cuál: reversar alrededor de un hueco dejaría el lote medio
 * deshecho sin que nadie lo haya pedido. El lote se queda en 'posted' (la
 * 045 no tiene estado 'reversed'): la verdad vive en reversed_by_entry_id
 * de cada póliza, igual que en una anulación unitaria.
 */
export async function reverseBatch(
  ctx: ContextoLote,
  batchId: string,
  userId: string,
  opts: { reason: string; asOf?: string; dryRun?: boolean }
): Promise<ResultadoReversa> {
  const motivo = opts.reason?.trim();
  if (!motivo) {
    throw new ValidationError('batch reverse exige --reason: una reversa sin motivo no deja rastro utilizable.');
  }
  if (opts.asOf !== undefined && !DATE_RE.test(opts.asOf)) {
    throw new ValidationError(`"${opts.asOf}" no es una fecha YYYY-MM-DD.`);
  }
  const fechaReversa = opts.asOf ? new Date(`${opts.asOf}T00:00:00`) : new Date();

  return enTransaccion(async (client) => {
    const lote = await loteAcotado(ctx, batchId, client, true);
    exigirEstado(lote, ['posted'], 'sólo lo que tocó el mayor tiene algo que reversar.');

    // Todas las pólizas del lote, por el vínculo fila→póliza y bajo candado:
    // reverseWithinTransaction exige que el llamador haya tomado FOR UPDATE.
    const entradas = await client.query<JournalEntry>(
      `SELECT je.*
         FROM journal_entries je
         JOIN journal_entry_import_rows r
           ON r.id = je.source_id AND r.tenant_id = $1 AND r.batch_id = $2
        WHERE je.entity_id = $3 AND je.source_type = $4
        ORDER BY je.entry_number
        FOR UPDATE OF je`,
      [ctx.tenantId, batchId, ctx.entityId, ORIGEN_LOTE_IMPORTADO]
    );
    if (entradas.rows.length === 0) {
      throw new ConflictError(
        `El lote ${batchId} está 'posted' pero no se encontró ninguna póliza suya en el mayor: ` +
          'nada que reversar. Revisa el vínculo source_type/source_id antes de tocar nada.'
      );
    }

    const yaReversadas = entradas.rows.filter((e) => e.reversed_by_entry_id !== null);
    if (yaReversadas.length === entradas.rows.length) {
      throw new ConflictError(
        `El lote ${batchId} ya fue reversado entero: máximo una reversa por póliza (041).`
      );
    }
    if (yaReversadas.length > 0) {
      const numeros = yaReversadas.map((e) => e.entry_number).join(', ');
      throw new ConflictError(
        `No se reversa el lote: ${numeros} ya ${yaReversadas.length === 1 ? 'fue reversada' : 'fueron reversadas'} ` +
          'fuera del lote (entry reverse o entry void). El lote se reversa como unidad o no se ' +
          'reversa: resuelve esas pólizas a mano y reversa las demás una por una.'
      );
    }

    const espejos: EspejoDeLote[] = [];
    const attestations: Array<{ entityId: string; entryId: string }> = [];
    for (const original of entradas.rows) {
      const espejo = await reverseWithinTransaction(
        client,
        original,
        userId,
        `Reversal of ${original.entry_number}: ${motivo}`,
        fechaReversa
      );
      espejos.push({
        original: original.entry_number,
        espejo: espejo.entry_number,
        espejo_id: espejo.id,
      });
      attestations.push({ entityId: ctx.entityId, entryId: espejo.id });
    }

    await registrarAuditoria(client, {
      tenantId: ctx.tenantId,
      userId,
      action: 'update',
      entityType: 'journal_entry_import_batches',
      entityId: batchId,
      newValues: { evento: 'reverse', espejos: espejos.length, as_of: opts.asOf ?? null },
      reason: motivo,
    });

    const salida: ResultadoReversa = {
      batchId,
      status: 'posted',
      espejos,
      attestations: opts.dryRun ? [] : attestations,
      dryRun: opts.dryRun === true,
    };
    if (opts.dryRun) throw new EnsayoLote(salida);
    return salida;
  });
}
