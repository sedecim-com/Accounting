import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { resolverCuentaBancaria } from './bank-statement-service.js';

// ============================================================
// EL MOVIMIENTO COMO OBJETO DE LECTURA (F05b · filas 1198 y 1199)
//
// `bank_transactions` llevaba desde la 003 sin lector propio. Lo único que la
// leía era `GET /bank-accounts/:id/unmatched-transactions`, que devuelve los
// no cotejados de UNA cuenta sin filtro, sin orden estable y sin paginación:
// no sirve para la pregunta que un contador hace de verdad —«¿qué cargos de
// más de diez mil pesos siguen sin explicar en julio?»— y tampoco para la que
// hace un agente, que es la misma con otras palabras.
//
// DOS DECISIONES QUE NO SON DE ESTILO.
//
// LA FRONTERA VA POR JOIN, SIEMPRE. `bank_transactions` no tiene `entity_id`:
// cuelga de `bank_account_id` → `bank_accounts.entity_id`. Por eso NINGUNA
// consulta de este archivo lee la tabla sola; todas entran por
// `JOIN bank_accounts ba ON ba.id = bt.bank_account_id` con `ba.entity_id` en
// el WHERE. Cero filas significa a la vez «no existe» y «no es tuya», y no hay
// ninguna rama donde el programa pueda distinguirlas.
//
// EL IMPORTE SALE CON LOS CUATRO DECIMALES DE LA COLUMNA. `amount` es
// DECIMAL(19,4) y se proyecta `::text` para que Postgres no lo entregue como
// float. Formatearlo a dos aquí fue el defecto que F05a cazó tres veces: el
// recorte convierte un descuadre de medio centavo en un cuadre perfecto, y el
// medio centavo reaparece en la conciliación sin nadie que sepa de dónde salió.
// ============================================================

/** Los cinco que admite el CHECK de la 003. */
export const TIPOS_DE_MOVIMIENTO = ['debit', 'credit', 'fee', 'interest', 'adjustment'] as const;
export type TipoDeMovimiento = (typeof TIPOS_DE_MOVIMIENTO)[number];

/** Entrada o salida de dinero, que es el signo del importe y no una columna. */
export const DIRECCIONES = ['in', 'out'] as const;
export type Direccion = (typeof DIRECCIONES)[number];

export const COMPARADORES = ['=', '>', '>=', '<', '<='] as const;
export type Comparador = (typeof COMPARADORES)[number];

/**
 * Un término `amt:` de la consulta posicional, ya interpretado.
 *
 * `firmado` distingue `amt:250` de `amt:-250`. Sin signo se compara la
 * MAGNITUD, porque quien busca «el cargo de 250» no quiere teclear el signo
 * que el banco eligió; con signo se compara el importe tal cual, que es la
 * única forma de pedir «las salidas de exactamente 250».
 */
export interface CriterioImporte {
  comparador: Comparador;
  /** Money as string. Nunca number: entra al SQL como texto y se castea a numeric. */
  valor: string;
  firmado: boolean;
}

export interface FiltrosMovimientos {
  /** Nombre o id de la cuenta bancaria. */
  account?: string;
  since?: string;
  until?: string;
  /** `true` sólo cotejados, `false` sólo sin cotejar, `undefined` los dos. */
  cotejada?: boolean;
  direccion?: Direccion;
  tipo?: TipoDeMovimiento;
  /** Términos `desc:` — se exigen TODOS (AND), que es lo que hace útil acumularlos. */
  texto?: readonly string[];
  importes?: readonly CriterioImporte[];
  limit?: number;
  offset?: number;
}

export interface RenglonMovimiento {
  id: string;
  bankAccountId: string;
  cuenta: string;
  moneda: string;
  fecha: string;
  /** Fecha valor: la que el banco aplicó, distinta de la de operación. */
  fechaValor: string | null;
  /** Firmado como lo trae el extracto: negativo sale, positivo entra. */
  importe: string;
  tipo: string;
  descripcion: string | null;
  contraparte: string | null;
  categoria: string | null;
  /** Id nativo del banco, cuando el archivo publicó uno utilizable. */
  referencia: string | null;
  statementId: string | null;
  cotejada: boolean;
  confianza: string | null;
  importadoEl: string;
}

/**
 * Los campos normalizados que la fila 1199 del catálogo promete y que NADIE
 * extrae todavía.
 *
 * `raw_data` existe desde la 003 y ahí acaba todo: no hay extractores ni
 * columnas donde poner lo extraído. Se nombran aquí, en una constante que la
 * terminal imprime, en vez de devolver cuatro campos vacíos que parecerían
 * «este movimiento no trae clave de rastreo» cuando lo cierto es «nadie la ha
 * buscado nunca». Quien los llenará es `bank transaction apply` (fila 1206).
 */
export const CAMPOS_SIN_EXTRACTOR = [
  'clave-de-rastreo',
  'clabe-de-la-contraparte',
  'rfc-de-la-contraparte',
  'numero-de-cheque',
] as const;

export interface CotejoVivo {
  matchId: string;
  tipo: string;
  entidadId: string;
  importe: string;
  parcial: boolean;
  origen: string;
  confianza: string | null;
  groupId: string | null;
  sesionId: string | null;
  cotejadoEl: string;
}

export interface FichaMovimiento extends RenglonMovimiento {
  entityId: string;
  /** sha256 de (cuenta|fecha|importe|descripción); lo calcula el disparador de la 051. */
  contentHash: string;
  cotejadoEl: string | null;
  cotejadoPor: string | null;
  loteId: string | null;
  estadoDeCuenta: { id: string; numero: string | null; periodo: string } | null;
  /** Los cotejos VIVOS. Un cotejo desaplicado sigue en la tabla y no sale aquí. */
  cotejos: CotejoVivo[];
  /** `raw_data` tal cual llegó. Sólo con `--raw`; ver `obtenerMovimiento`. */
  crudo: Record<string, unknown> | null;
}

interface FilaMovimiento {
  id: string;
  bank_account_id: string;
  account_name: string;
  currency_code: string;
  fecha: string;
  fecha_valor: string | null;
  importe: string;
  tipo: string;
  description: string | null;
  merchant_name: string | null;
  category: string | null;
  referencia: string | null;
  statement_id: string | null;
  is_matched: boolean;
  confianza: string | null;
  importado_el: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNAS = `
         bt.id, bt.bank_account_id, ba.account_name, ba.currency_code,
         bt.transaction_date::text            AS fecha,
         bt.posted_date::text                 AS fecha_valor,
         bt.amount::text                      AS importe,
         bt.transaction_type                  AS tipo,
         bt.description, bt.merchant_name, bt.category,
         bt.bank_transaction_id               AS referencia,
         bt.statement_id, bt.is_matched,
         bt.confidence_score::text            AS confianza,
         bt.imported_at::text                 AS importado_el`;

function aRenglon(f: FilaMovimiento): RenglonMovimiento {
  return {
    id: f.id,
    bankAccountId: f.bank_account_id,
    cuenta: f.account_name,
    moneda: f.currency_code,
    fecha: f.fecha,
    fechaValor: f.fecha_valor,
    // Se normaliza a los cuatro decimales de la columna y no se recorta: el
    // mismo número que sumará la conciliación.
    importe: new Decimal(f.importe).toFixed(4),
    tipo: f.tipo,
    descripcion: f.description,
    contraparte: f.merchant_name,
    categoria: f.category,
    referencia: f.referencia,
    statementId: f.statement_id,
    cotejada: f.is_matched,
    confianza: f.confianza,
    importadoEl: f.importado_el,
  };
}

/**
 * Los movimientos de la entidad, filtrados y paginados DENTRO del SQL.
 *
 * El orden es por fecha DESCENDENTE con el id de desempate: lo último que hizo
 * el banco es lo que se mira primero, y el desempate hace que `--offset`
 * signifique algo —sin él, dos páginas de un mismo día podrían repetir una
 * fila y saltarse otra sin que nada lo delatara—.
 */
export async function listarMovimientos(
  entityId: string,
  filtros: FiltrosMovimientos = {}
): Promise<RenglonMovimiento[]> {
  const cond = ['ba.entity_id = $1'];
  const params: unknown[] = [entityId];
  const siguiente = (valor: unknown): string => {
    params.push(valor);
    return `$${params.length}`;
  };

  if (filtros.account) {
    const cuenta = await resolverCuentaBancaria(entityId, filtros.account);
    cond.push(`bt.bank_account_id = ${siguiente(cuenta.id)}`);
  }
  if (filtros.since) cond.push(`bt.transaction_date >= ${siguiente(filtros.since)}::date`);
  if (filtros.until) cond.push(`bt.transaction_date <= ${siguiente(filtros.until)}::date`);
  if (filtros.cotejada !== undefined) cond.push(`bt.is_matched = ${siguiente(filtros.cotejada)}`);
  if (filtros.tipo) cond.push(`bt.transaction_type = ${siguiente(filtros.tipo)}`);
  // La dirección es el SIGNO, no una columna: `transaction_type` dice qué clase
  // de movimiento es (comisión, interés), no hacia dónde fue el dinero.
  if (filtros.direccion === 'in') cond.push('bt.amount > 0');
  if (filtros.direccion === 'out') cond.push('bt.amount < 0');

  for (const t of filtros.texto ?? []) {
    // El texto busca en la descripción Y en la contraparte: los bancos reparten
    // el mismo dato entre las dos columnas según el formato, y buscar sólo en
    // una convierte «no aparece» en una respuesta que depende del importador.
    const p = siguiente(`%${t}%`);
    cond.push(`(bt.description ILIKE ${p} OR bt.merchant_name ILIKE ${p})`);
  }
  for (const c of filtros.importes ?? []) {
    const lado = c.firmado ? 'bt.amount' : 'ABS(bt.amount)';
    cond.push(`${lado} ${c.comparador} ${siguiente(c.valor)}::numeric`);
  }

  const limite = Math.min(Math.max(filtros.limit ?? 50, 1), 1000);
  const desplazamiento = Math.max(filtros.offset ?? 0, 0);

  const r = await query<FilaMovimiento>(
    `SELECT ${COLUMNAS}
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE ${cond.join(' AND ')}
      ORDER BY bt.transaction_date DESC, bt.id
      LIMIT ${siguiente(limite)} OFFSET ${siguiente(desplazamiento)}`,
    params
  );
  return r.rows.map(aRenglon);
}

interface FilaFicha extends FilaMovimiento {
  entity_id: string;
  content_hash: string;
  matched_at: string | null;
  matched_by: string | null;
  import_batch_id: string | null;
  raw_data: Record<string, unknown> | null;
  statement_number: string | null;
  period_start: string | null;
  period_end: string | null;
}

interface FilaCotejo {
  id: string;
  matched_entity_type: string;
  matched_entity_id: string;
  matched_amount: string;
  is_partial: boolean;
  match_type: string;
  confidence_score: string | null;
  group_id: string | null;
  reconciliation_session_id: string | null;
  matched_at: string;
}

/**
 * Un movimiento con su expediente: de qué estado de cuenta vino y qué cotejos
 * vivos lo explican.
 *
 * `crudo` NO se trae por omisión aunque cueste lo mismo. `raw_data` es la línea
 * entera como la publicó el banco y suele traer nombre y cuenta de la
 * contraparte; una ficha que la imprime siempre convierte cada `show` en una
 * fuga por pantalla compartida. Se pide con `--raw`, que es una decisión de
 * quien mira.
 */
export async function obtenerMovimiento(
  entityId: string,
  id: string,
  opts: { crudo?: boolean } = {}
): Promise<FichaMovimiento> {
  // Un id que no es un uuid no se manda a Postgres: el `22P02` que devolvería
  // es un error de sintaxis de tipo, no un «no existe», y sale con otro código.
  if (!UUID_RE.test(id)) throw new NotFoundError('Bank Transaction', id);

  const r = await query<FilaFicha>(
    `SELECT ${COLUMNAS},
            ba.entity_id, bt.content_hash,
            bt.matched_at::text AS matched_at, bt.matched_by::text AS matched_by,
            bt.import_batch_id::text AS import_batch_id,
            ${opts.crudo ? 'bt.raw_data' : 'NULL::jsonb AS raw_data'},
            s.statement_number,
            s.period_start::text AS period_start, s.period_end::text AS period_end
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       LEFT JOIN bank_statements s ON s.id = bt.statement_id AND s.entity_id = ba.entity_id
      WHERE bt.id = $1 AND ba.entity_id = $2`,
    [id, entityId]
  );
  const f = r.rows[0];
  if (!f) throw new NotFoundError('Bank Transaction', id);

  const c = await query<FilaCotejo>(
    // La frontera otra vez por JOIN: `reconciliation_matches` tampoco tiene
    // entity_id. Y sólo los VIVOS: la 052 clausura en vez de borrar, así que
    // sin `unapplied_at IS NULL` la ficha mostraría como explicación un cotejo
    // que alguien deshizo.
    `SELECT rm.id, rm.matched_entity_type, rm.matched_entity_id,
            rm.matched_amount::text AS matched_amount, rm.is_partial, rm.match_type,
            rm.confidence_score::text AS confidence_score, rm.group_id,
            rm.reconciliation_session_id, rm.matched_at::text AS matched_at
       FROM reconciliation_matches rm
       JOIN bank_transactions bt ON bt.id = rm.bank_transaction_id
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE rm.bank_transaction_id = $1 AND ba.entity_id = $2
        AND rm.unapplied_at IS NULL
      ORDER BY rm.matched_at`,
    [id, entityId]
  );

  return {
    ...aRenglon(f),
    entityId: f.entity_id,
    contentHash: f.content_hash,
    cotejadoEl: f.matched_at,
    cotejadoPor: f.matched_by,
    loteId: f.import_batch_id,
    estadoDeCuenta: f.statement_id
      ? {
        id: f.statement_id,
        numero: f.statement_number,
        periodo: `${f.period_start ?? ''}..${f.period_end ?? ''}`,
      }
      : null,
    cotejos: c.rows.map((x) => ({
      matchId: x.id,
      tipo: x.matched_entity_type,
      entidadId: x.matched_entity_id,
      importe: new Decimal(x.matched_amount).toFixed(4),
      parcial: x.is_partial,
      origen: x.match_type,
      confianza: x.confidence_score,
      groupId: x.group_id,
      sesionId: x.reconciliation_session_id,
      cotejadoEl: x.matched_at,
    })),
    crudo: f.raw_data,
  };
}

/**
 * Comprueba que un tipo llegado de la línea de órdenes es uno de los cinco.
 *
 * Vive aquí y no en la terminal porque la lista es del esquema: el día que la
 * 0NN añada un sexto tipo, el CHECK y esta constante cambian juntos.
 */
export function exigirTipoDeMovimiento(valor: string): TipoDeMovimiento {
  const tipo = valor.trim().toLowerCase();
  if (!(TIPOS_DE_MOVIMIENTO as readonly string[]).includes(tipo)) {
    throw new ValidationError(
      `"${valor}" no es un tipo de movimiento bancario. Los cinco son: ${TIPOS_DE_MOVIMIENTO.join(', ')}.`
    );
  }
  return tipo as TipoDeMovimiento;
}
