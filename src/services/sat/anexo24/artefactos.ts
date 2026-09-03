import { createHash } from 'node:crypto';
import type pg from 'pg';
import { query } from '../../../database/connection.js';

// ============================================================
// F07b · EL ARCHIVO DE LO QUE SE GENERÓ
//
// La fila del catálogo de comandos lo pide con su razón escrita: «persiste el
// artefacto porque `diff` y `file` dependen de saber qué se generó». Sin esto,
// `catalog diff` compararía el catálogo de hoy contra nada, y `catalog file`
// firmaría un archivo que se reconstruye en el momento —o sea, otro archivo—
// en vez del que el contador revisó.
//
// LA IDEMPOTENCIA ES POR HASH, y eso es una decisión, no un detalle. El
// catálogo de comandos exige que `generate` produzca BYTES IDÉNTICOS PARA
// ENTRADAS IDÉNTICAS. Si eso se cumple, volver a generar sin haber cambiado
// nada no debe crear una fila nueva: crearía un historial de «versiones» que
// no se distinguen entre sí y que convierten el `diff` en ruido. Con la llave
// por hash, regenerar devuelve el artefacto que ya estaba y lo DICE
// (`yaExistia`), que además es la comprobación más barata que existe de que
// el generador es determinista de verdad.
// ============================================================

export type TipoArtefacto =
  | 'catalogo'
  | 'balanza'
  | 'poliza'
  | 'auxiliar_folios'
  | 'auxiliar_cuentas';

export interface ArtefactoArchivado {
  id: string;
  hash_sha256: string;
  bytes: number;
  generado_en: string;
  /** true = estos mismos bytes ya estaban archivados; no se creó fila nueva. */
  yaExistia: boolean;
}

export interface DatosArtefacto {
  tenantId: string;
  entityId: string;
  tipo: TipoArtefacto;
  version: string;
  rfc: string;
  anio: number;
  /** 1–12; 13 en la balanza de cierre. */
  mes: number;
  /** 'N' normal, 'C' complementaria. El catálogo no lo usa: viaja como 'N'. */
  tipoEnvio: 'N' | 'C';
  xml: string;
  /** El valor que tenía `efirma_sellado_contabilidad_electronica` al generar. */
  politicaSellado: string;
  hallazgos: unknown;
  generadoPor: string;
}

/** El hash de los BYTES, no de la cadena: es lo que se va a entregar. */
export function hashDelXml(xml: string): string {
  return createHash('sha256').update(Buffer.from(xml, 'utf8')).digest('hex');
}

/**
 * Archiva el XML. `sellado` se escribe SIEMPRE en false: en F07b no hay
 * ningún camino que cargue una llave privada, y la columna existe para que el
 * día que `catalog file` selle, el sellado sea un hecho registrado y no una
 * suposición del que lee la tabla.
 */
export async function archivarArtefacto(
  datos: DatosArtefacto,
  client?: pg.PoolClient
): Promise<ArtefactoArchivado> {
  const ejecutar = client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;

  const hash = hashDelXml(datos.xml);
  const bytes = Buffer.byteLength(datos.xml, 'utf8');

  const insercion = await ejecutar<{ id: string; generado_en: string }>(
    `INSERT INTO sat_anexo24_artefactos
       (tenant_id, entity_id, tipo, version, rfc, anio, mes, tipo_envio,
        xml, hash_sha256, bytes, sellado, politica_sellado, hallazgos, generado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, $13::jsonb, $14)
     ON CONFLICT (entity_id, tipo, anio, mes, tipo_envio, hash_sha256) DO NOTHING
     RETURNING id, generado_en::text AS generado_en`,
    [
      datos.tenantId, datos.entityId, datos.tipo, datos.version, datos.rfc,
      datos.anio, datos.mes, datos.tipoEnvio, datos.xml, hash, bytes,
      datos.politicaSellado, JSON.stringify(datos.hallazgos), datos.generadoPor,
    ]
  );

  if (insercion.rows.length > 0) {
    const fila = insercion.rows[0];
    return { id: fila.id, hash_sha256: hash, bytes, generado_en: fila.generado_en, yaExistia: false };
  }

  // El ON CONFLICT no devuelve fila: estos bytes ya estaban. Se recupera la
  // que hay, con la entidad DENTRO del SQL como en cualquier otra consulta.
  const existente = await ejecutar<{ id: string; generado_en: string }>(
    `SELECT id, generado_en::text AS generado_en
       FROM sat_anexo24_artefactos
      WHERE entity_id = $1 AND tipo = $2 AND anio = $3 AND mes = $4
        AND tipo_envio = $5 AND hash_sha256 = $6`,
    [datos.entityId, datos.tipo, datos.anio, datos.mes, datos.tipoEnvio, hash]
  );
  const fila = existente.rows[0];
  return {
    id: fila?.id ?? '',
    hash_sha256: hash,
    bytes,
    generado_en: fila?.generado_en ?? '',
    yaExistia: true,
  };
}

export interface ArtefactoResumido {
  id: string;
  tipo: TipoArtefacto;
  version: string;
  anio: number;
  mes: number;
  tipo_envio: string;
  hash_sha256: string;
  bytes: number;
  sellado: boolean;
  generado_en: string;
}

/**
 * El último artefacto de un tipo. Es lo que `catalog diff` necesita para
 * responder «qué cambió desde el último catálogo», y por eso vive aquí y no
 * dentro del generador: el que compara no debería tener que generar.
 */
export async function ultimoArtefacto(
  entityId: string,
  tipo: TipoArtefacto
): Promise<ArtefactoResumido | null> {
  const r = await query<ArtefactoResumido>(
    `SELECT id, tipo, version, anio, mes, tipo_envio, hash_sha256, bytes, sellado,
            generado_en::text AS generado_en
       FROM sat_anexo24_artefactos
      WHERE entity_id = $1 AND tipo = $2
      ORDER BY anio DESC, mes DESC, generado_en DESC
      LIMIT 1`,
    [entityId, tipo]
  );
  return r.rows[0] ?? null;
}

/** El XML archivado, para `diff` y para reimprimir sin regenerar. */
export async function xmlArchivado(entityId: string, id: string): Promise<string | null> {
  const r = await query<{ xml: string }>(
    `SELECT xml FROM sat_anexo24_artefactos WHERE id = $1 AND entity_id = $2`,
    [id, entityId]
  );
  return r.rows[0]?.xml ?? null;
}
