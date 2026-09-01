import { query } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

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
    throw new ValidationError(`--direction ilegible "${f.direction}": emitido, recibido o ajeno.`);
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

export async function getCfdiByUuid(entityId: string, uuid: string): Promise<DetalleCfdi> {
  const doc = await query<DetalleCfdi & { id: string }>(
    `SELECT xd.id, xd.cfdi_uuid, xd.document_type, ${DIRECCION_SQL} AS direction,
            xd.cfdi_fecha::text AS cfdi_fecha, xd.emisor_rfc, xd.emisor_nombre,
            xd.receptor_rfc, xd.subtotal::text AS subtotal, xd.total::text AS total,
            xd.moneda, xd.metodo_pago, xd.processing_status,
            xd.sat_validation_status, xd.sat_estado,
            xd.total_impuestos_trasladados::text AS total_impuestos_trasladados,
            xd.total_impuestos_retenidos::text AS total_impuestos_retenidos,
            xd.xml_content
       FROM xml_documents xd JOIN legal_entities le ON le.id = xd.entity_id
      WHERE xd.entity_id = $1 AND xd.cfdi_uuid = $2`,
    [entityId, uuid]
  );
  if (doc.rows.length === 0) throw new NotFoundError('CFDI', uuid);
  const lineas = await query<DetalleCfdi['lineas'][number]>(
    `SELECT line_number, clave_prod_serv, descripcion,
            cantidad::text AS cantidad, importe::text AS importe
       FROM xml_document_lines WHERE xml_document_id = $1 ORDER BY line_number`,
    [doc.rows[0].id]
  );
  return { ...doc.rows[0], lineas: lineas.rows };
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

/** El rastro que la 015 prometió y F02 empezó a escribir. */
export async function getClassificationTrail(
  entityId: string,
  uuid: string
): Promise<RastroClasificacion> {
  const r = await query<RastroClasificacion>(
    `SELECT cfdi_uuid, tipo_comprobante, direction, case_id, status,
            facts, decisions, journal_entry_id, updated_at::text AS updated_at
       FROM cfdi_classifications
      WHERE entity_id = $1 AND cfdi_uuid = $2`,
    [entityId, uuid]
  );
  if (r.rows.length === 0) {
    throw new NotFoundError(
      'Clasificación',
      `${uuid} (el rastro existe para lo ingerido desde F02; lo anterior se clasificó y se tiró)`
    );
  }
  return r.rows[0];
}
