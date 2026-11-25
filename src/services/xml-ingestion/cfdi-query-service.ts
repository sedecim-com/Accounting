import { query } from '../../database/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

// ============================================================
// F02 · EL ESPEJO SE CONSULTA — lecturas de xml_documents para la CLI
//
// El espejo (los CFDI tal como llegaron, con su estatus SAT y su
// clasificación) existía solo como rutas REST. Estas lecturas son las
// mismas del REST pero con la DIRECCIÓN derivada — emitido/recibido/
// ajeno comparando los RFC del comprobante contra el tax_id de la
// entidad, que es la única pregunta que el despacho hace de verdad:
// «¿es mío este CFDI, y de qué lado?». La columna no existe a propósito:
// derivarla no cuesta nada y materializarla sería un segundo reloj.
// ============================================================

export type DireccionCfdi = 'emitido' | 'recibido' | 'ajeno';

export interface FilaCfdi {
  cfdi_uuid: string;
  document_type: string;
  direction: DireccionCfdi;
  cfdi_fecha: string;
  emisor_rfc: string;
  emisor_nombre: string;
  receptor_rfc: string;
  total: string;
  moneda: string;
  metodo_pago: string | null;
  processing_status: string;
  sat_validation_status: string | null;
  sat_estado: string | null;
}

const DIRECCION_SQL = `CASE
  WHEN xd.emisor_rfc = le.tax_id THEN 'emitido'
  WHEN xd.receptor_rfc = le.tax_id THEN 'recibido'
  ELSE 'ajeno' END`;

export interface FiltrosCfdi {
  direction?: string;
  type?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export async function listCfdis(
  entityId: string,
  f: FiltrosCfdi = {}
): Promise<{ rows: FilaCfdi[]; total: number }> {
  if (f.direction && !['emitido', 'recibido', 'ajeno'].includes(f.direction)) {
    throw new ValidationError({ key: 'error.VALIDATION_ERROR.cfdi.direction', params: { direction: f.direction } });
  }
  const cond: string[] = ['xd.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;
  if (f.type) { cond.push(`xd.document_type = $${i++}`); params.push(f.type); }
  if (f.status) { cond.push(`xd.processing_status = $${i++}`); params.push(f.status); }
  if (f.since) { cond.push(`xd.cfdi_fecha >= $${i++}`); params.push(f.since); }
  if (f.until) { cond.push(`xd.cfdi_fecha <= $${i++}`); params.push(f.until); }
  if (f.direction) { cond.push(`${DIRECCION_SQL} = $${i++}`); params.push(f.direction); }

  const base = `FROM xml_documents xd JOIN legal_entities le ON le.id = xd.entity_id WHERE ${cond.join(' AND ')}`;
  const contado = await query<{ n: string }>(`SELECT COUNT(*)::text AS n ${base}`, params);
  const total = parseInt(contado.rows[0].n, 10);

  const rows = await query<FilaCfdi>(
    `SELECT xd.cfdi_uuid, xd.document_type, ${DIRECCION_SQL} AS direction,
            xd.cfdi_fecha::text AS cfdi_fecha, xd.emisor_rfc, xd.emisor_nombre,
            xd.receptor_rfc, xd.total::text AS total, xd.moneda, xd.metodo_pago,
            xd.processing_status, xd.sat_validation_status, xd.sat_estado
       ${base}
      ORDER BY xd.cfdi_fecha DESC
      LIMIT $${i} OFFSET $${i + 1}`,
    [...params, f.limit ?? total, f.offset ?? 0]
  );
  return { rows: rows.rows, total };
}

export interface DetalleCfdi extends FilaCfdi {
  id: string;
  subtotal: string;
  total_impuestos_trasladados: string;
  total_impuestos_retenidos: string;
  xml_content: string;
  lineas: Array<{
    line_number: number;
    clave_prod_serv: string;
    descripcion: string;
    cantidad: string;
    importe: string;
  }>;
}

/**
 * «This UUID, in any letter case, inside the entity» (MNE-001-680, MNE-001-724,
 * #853): the one WHERE of every reader that takes a UUID a person typed. `$1`
 * is the entity and `$2` the UUID. The ingestion stores the UUID as the XML
 * carries it, and SAT's portal prints it in the other case.
 *
 * NOTE: `lower()` on the column cannot use the unique index of either table
 * beyond `entity_id` (`uq_xml_documents_entity_cfdi`, and the UNIQUE of
 * `cfdi_classifications`). Migration 345 (MNE-001-723) gives each table an
 * index on (entity_id, lower(cfdi_uuid)), as 340 gave `bills`, so the lookup
 * is one probe and not a read of the entity's rows.
 *
 * The spellings are ordered by byte (`COLLATE "C"`), upper case first, so the
 * refusal names them in the same order on every database: under a linguistic
 * collation (en_US) the lower-case spelling sorts first, under C the upper.
 */
const whereUuidAnyCase = (alias: string): string =>
  `WHERE ${alias}.entity_id = $1 AND lower(${alias}.cfdi_uuid) = lower($2)
      ORDER BY ${alias}.cfdi_uuid COLLATE "C"`;

/**
 * The row that lookup found, or none. Both unique indexes are case-sensitive,
 * so an entity can hold two rows that differ only by case; they are one and the
 * same CFDI, and the reader names both instead of picking one.
 */
function theOnlyRow<T extends { cfdi_uuid: string }>(uuid: string, rows: T[]): T | undefined {
  if (rows.length > 1) {
    throw new ConflictError({
      key: 'cfdi.lookup.same_uuid_twice',
      params: { uuid, count: rows.length, stored: rows.map((row) => row.cfdi_uuid).join(', ') },
    });
  }
  return rows[0];
}

/** The mirror's row of a CFDI of the entity, by its UUID in any letter case; undefined when the entity holds none. */
export async function findCfdiId(entityId: string, uuid: string): Promise<string | undefined> {
  const found = await query<{ id: string; cfdi_uuid: string }>(
    `SELECT xd.id, xd.cfdi_uuid FROM xml_documents xd ${whereUuidAnyCase('xd')}`,
    [entityId, uuid]
  );
  return theOnlyRow(uuid, found.rows)?.id;
}

/** One CFDI of the entity, with its lines, by its UUID in any letter case (MNE-001-680, #853). */
export async function getCfdiByUuid(entityId: string, uuid: string): Promise<DetalleCfdi> {
  const found = await query<DetalleCfdi & { id: string }>(
    `SELECT xd.id, xd.cfdi_uuid, xd.document_type, ${DIRECCION_SQL} AS direction,
            xd.cfdi_fecha::text AS cfdi_fecha, xd.emisor_rfc, xd.emisor_nombre,
            xd.receptor_rfc, xd.subtotal::text AS subtotal, xd.total::text AS total,
            xd.moneda, xd.metodo_pago, xd.processing_status,
            xd.sat_validation_status, xd.sat_estado,
            xd.total_impuestos_trasladados::text AS total_impuestos_trasladados,
            xd.total_impuestos_retenidos::text AS total_impuestos_retenidos,
            xd.xml_content
       FROM xml_documents xd JOIN legal_entities le ON le.id = xd.entity_id
      ${whereUuidAnyCase('xd')}`,
    [entityId, uuid]
  );
  const doc = theOnlyRow(uuid, found.rows);
  if (!doc) throw new NotFoundError('CFDI', uuid);
  const lineas = await query<DetalleCfdi['lineas'][number]>(
    `SELECT line_number, clave_prod_serv, descripcion,
            cantidad::text AS cantidad, importe::text AS importe
       FROM xml_document_lines WHERE xml_document_id = $1 ORDER BY line_number`,
    [doc.id]
  );
  return { ...doc, lineas: lineas.rows };
}

export interface RastroClasificacion {
  cfdi_uuid: string;
  tipo_comprobante: string;
  direction: string;
  case_id: string | null;
  status: string;
  facts: Record<string, unknown>;
  decisions: unknown[];
  journal_entry_id: string | null;
  updated_at: string;
}

/**
 * The trail migration 015 promised and F02 began to write, by the UUID in any
 * letter case. Two trails of the entity that differ only by case are refused,
 * as the mirror's rows are (MNE-001-724).
 */
export async function getClassificationTrail(
  entityId: string,
  uuid: string
): Promise<RastroClasificacion> {
  const r = await query<RastroClasificacion>(
    `SELECT cfdi_uuid, tipo_comprobante, direction, case_id, status,
            facts, decisions, journal_entry_id, updated_at::text AS updated_at
       FROM cfdi_classifications cc
      ${whereUuidAnyCase('cc')}`,
    [entityId, uuid]
  );
  const trail = theOnlyRow(uuid, r.rows);
  if (!trail) {
    throw new NotFoundError({ key: 'error.RESOURCE_NOT_FOUND.classification_trail', params: { uuid } });
  }
  return trail;
}
