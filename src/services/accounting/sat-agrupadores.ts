import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { getPolicy } from '../policy/policy-service.js';
import type { PolicyContext } from '../policy/policy-service.js';
import { C_CODAGRUP, VIGENCIA_C_CODAGRUP, rubroDe } from './sat-agrupadores-catalogo.js';

// ============================================================
// F07a · EL CATÁLOGO c_CodAgrup: LECTOR Y ESCRITOR
//
// `sat_codigos_agrupadores` la creó la 060 y nació huérfana: una tabla sin
// escritor es una promesa, y sin lector es decoración. Este módulo es las dos
// cosas, y con eso el agrupador deja de validarse contra nada.
//
// La tabla es GLOBAL a propósito (lo dice el COMMENT de la 060): el catálogo
// del SAT es un hecho publicado por la autoridad, no un dato del inquilino.
// Por eso aquí NO hay entity_id ni tenant_id en ningún WHERE — y es la única
// excepción de la casa, sostenida por la migración, no por descuido.
// ============================================================

/** Una fila del catálogo tal como vive en la base. */
export interface FilaAgrupador {
  codigo: string;
  nombre: string;
  nivel: number;
  codigo_padre: string | null;
  naturaleza: string | null;
  vigente_desde: string;
  vigente_hasta: string | null;
}

export interface ResultadoSiembraAgrupadores {
  /** Cuántos códigos trae la lista oficial que se intentó sembrar. */
  ofrecidos: number;
  /** Cuántos se insertaron de verdad en esta corrida. */
  insertados: number;
  /** Los que ya estaban con esa misma vigencia: la siembra es idempotente. */
  yaEstaban: number;
  vigencia: string;
}

/**
 * Siembra el c_CodAgrup oficial. Idempotente por (codigo, vigente_desde), que
 * es la llave primaria de la 060: correrla dos veces no duplica ni pisa.
 *
 * No borra lo que ya hubiera: si alguien cargó el catálogo de otro ejercicio,
 * ese sigue ahí con su propia vigencia, que es justo para lo que la 060 puso
 * la vigencia en la llave.
 */
export async function sembrarCatalogoAgrupadores(
  opts: { vigencia?: string; client?: pg.PoolClient } = {}
): Promise<ResultadoSiembraAgrupadores> {
  const vigencia = opts.vigencia ?? VIGENCIA_C_CODAGRUP;
  const ejecutar = opts.client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => opts.client!.query<T>(sql, params)
    : query;

  // En un solo INSERT con UNNEST y no mil doscientos round-trips: es una
  // siembra de arranque, pero también corre en cada `db:seed` y en cada
  // suite de integración que necesite el catálogo.
  const codigos = C_CODAGRUP.map((a) => a.codigo);
  const nombres = C_CODAGRUP.map((a) => a.nombre);
  const niveles = C_CODAGRUP.map((a) => a.nivel);
  const padres = C_CODAGRUP.map((a) => rubroDe(a.codigo));

  const r = await ejecutar(
    `INSERT INTO sat_codigos_agrupadores
       (codigo, nombre, nivel, codigo_padre, naturaleza, vigente_desde, vigente_hasta)
     SELECT * FROM UNNEST(
       $1::varchar[], $2::varchar[], $3::smallint[], $4::varchar[]
     ) AS t(codigo, nombre, nivel, codigo_padre)
     -- naturaleza NULL: la tabla publicada por el SAT no la trae, y deducirla
     -- del rango del rubro es falso (108 «Estimación de cuentas incobrables»
     -- es 1xx y acreedora). Ver la cabecera del módulo de datos.
     CROSS JOIN (SELECT NULL::char(1) AS naturaleza,
                        $5::date AS vigente_desde,
                        NULL::date AS vigente_hasta) v
     ON CONFLICT (codigo, vigente_desde) DO NOTHING`,
    [codigos, nombres, niveles, padres, vigencia]
  );

  const insertados = r.rowCount ?? 0;
  return {
    ofrecidos: C_CODAGRUP.length,
    insertados,
    yaEstaban: C_CODAGRUP.length - insertados,
    vigencia,
  };
}

/** ¿Hay catálogo cargado que cubra esta fecha? Distinto de «el código no está». */
export async function hayCatalogoVigente(fecha: string): Promise<boolean> {
  const r = await query<{ hay: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM sat_codigos_agrupadores
        WHERE vigente_desde <= $1::date
          AND (vigente_hasta IS NULL OR vigente_hasta >= $1::date)
     ) AS hay`,
    [fecha]
  );
  return r.rows[0]?.hay === true;
}

/** El agrupador, si existe con vigencia que cubra la fecha. */
export async function buscarAgrupador(
  codigo: string,
  fecha: string
): Promise<FilaAgrupador | null> {
  const r = await query<FilaAgrupador>(
    `SELECT codigo, nombre, nivel, codigo_padre, naturaleza,
            vigente_desde::text AS vigente_desde,
            vigente_hasta::text AS vigente_hasta
       FROM sat_codigos_agrupadores
      WHERE codigo = $1
        AND vigente_desde <= $2::date
        AND (vigente_hasta IS NULL OR vigente_hasta >= $2::date)
      ORDER BY vigente_desde DESC
      LIMIT 1`,
    [codigo, fecha]
  );
  return r.rows[0] ?? null;
}

export type VeredictoAgrupador = 'valido' | 'fuera_de_catalogo' | 'sin_catalogo';

export interface ResultadoValidacionAgrupador {
  codigo: string;
  veredicto: VeredictoAgrupador;
  /** El nombre oficial cuando el código existe: sirve para confirmar en pantalla. */
  nombre: string | null;
  /** Qué debe hacer el llamador. `sin_catalogo` nunca bloquea. */
  accion: 'aceptar' | 'aceptar_con_aviso' | 'rechazar';
  /** El aviso ya redactado, cuando lo hay. */
  aviso?: string;
}

/**
 * El contexto de una tanda de validaciones: la política y si hay catálogo, que
 * son lo mismo para todas las filas de un import. Resolverlo una vez evita
 * releer la política por cada línea de un CSV de mil cuentas.
 */
export interface ContextoValidacionAgrupador {
  politica: string;
  hayCatalogo: boolean;
  fecha: string;
}

export async function prepararValidacionAgrupador(
  ctx: PolicyContext,
  fecha: string
): Promise<ContextoValidacionAgrupador> {
  const [politica, hayCatalogo] = await Promise.all([
    getPolicy(ctx, 'agrupador_valor_fuera_de_catalogo'),
    hayCatalogoVigente(fecha),
  ]);
  return { politica: politica.value, hayCatalogo, fecha };
}

/**
 * Valida un código agrupador contra el catálogo oficial vigente.
 *
 * LA DECISIÓN QUE HAY QUE ARGUMENTAR — el catálogo VACÍO.
 *
 * Con la tabla sin sembrar hay tres salidas posibles y dos son mentira:
 *   · Aceptar en silencio dice «validado» de algo que nadie miró, y es
 *     exactamente el fallo que F07a vino a arreglar: un instrumento que
 *     contesta que sí porque no sabe contestar que no.
 *   · Rechazar todo obedece la política al pie de la letra y convierte una
 *     base sin sembrar en un sistema que no deja capturar NADA — castiga al
 *     contribuyente por una omisión del despacho, y encima lo hace con el
 *     mensaje equivocado («ese código no existe» cuando el que no existe es
 *     el catálogo).
 *   · Avisar nombrando la causa real es lo único que deja al usuario hacer su
 *     trabajo y saber qué le falta. Es lo que se hace.
 *
 * Por eso `sin_catalogo` NO consulta la política: la política decide qué hacer
 * con un código que el catálogo rechaza, y aquí no hay catálogo que rechace
 * nada. Un ejercicio anterior al que se sembró cae en este mismo caso, y con
 * razón: tampoco tenemos su catálogo.
 */
export async function validarCodigoAgrupador(
  ctxVal: ContextoValidacionAgrupador,
  codigo: string
): Promise<ResultadoValidacionAgrupador> {
  if (!ctxVal.hayCatalogo) {
    return {
      codigo,
      veredicto: 'sin_catalogo',
      nombre: null,
      accion: 'aceptar_con_aviso',
      aviso:
        `El catálogo del SAT no está sembrado para ${ctxVal.fecha}: el código "${codigo}" se guarda ` +
        `SIN VALIDAR. Siembra el c_CodAgrup del Anexo 24 de ese ejercicio para que esta comprobación sirva.`,
    };
  }

  const fila = await buscarAgrupador(codigo, ctxVal.fecha);
  if (fila) {
    return { codigo, veredicto: 'valido', nombre: fila.nombre, accion: 'aceptar' };
  }

  const aviso =
    `El código agrupador "${codigo}" no está en el catálogo c_CodAgrup vigente al ${ctxVal.fecha}. ` +
    `El SAT revisa ese catálogo por ejercicio: un código válido hace unos años puede no serlo hoy.`;
  return {
    codigo,
    veredicto: 'fuera_de_catalogo',
    nombre: null,
    accion: ctxVal.politica === 'avisar' ? 'aceptar_con_aviso' : 'rechazar',
    aviso,
  };
}

/** Valida y revienta si la política dice rechazar. Para el camino de una sola cuenta. */
export async function exigirAgrupadorValido(
  ctxVal: ContextoValidacionAgrupador,
  codigo: string
): Promise<ResultadoValidacionAgrupador> {
  const r = await validarCodigoAgrupador(ctxVal, codigo);
  if (r.accion === 'rechazar') throw new ValidationError(r.aviso ?? `Código agrupador inválido: ${codigo}`);
  return r;
}
