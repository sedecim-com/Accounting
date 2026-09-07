import { query } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { runLedgerChecks } from './ledger-checks.js';
import {
  CLOSE_CHECK_CODES,
  CLOSE_CHECK_ITEMS,
  type CloseCheckCode,
} from './period-close.js';
import { MAPPING_SCHEMES } from './account-service.js';

// ============================================================
// F06b · `closing explain <codigo>` — LOS RENGLONES OFENSORES
//
// `getPeriodCloseStatus` CUENTA («3 draft invoices»); esta superficie LISTA:
// ids, montos y fechas de lo que cada casilla encontró, más el comando exacto
// que lo corrige. Son los MISMOS detectores —cada consulta de aquí es la de
// su casilla, con SELECT de renglones en lugar de COUNT— y el espejo se
// vigila con una prueba: si un código existe en el checklist, existe aquí.
//
// POR QUÉ NO SE FACTORIZA EL SQL EN FRAGMENTOS COMPARTIDOS: el checklist
// corre a veces DENTRO de la transacción del cierre (R1) y necesita conteos
// baratos; esta superficie corre siempre fuera y pagina. Compartir el texto
// SQL acoplaría las dos formas por la más rígida; compartir el PREDICADO se
// garantiza con el comentario cruzado en cada consulta y con la prueba de
// completitud del registro.
// ============================================================

/** Un renglón ofensor: columnas planas, dinero como CADENA, fechas ISO. */
export type RenglonOfensor = Record<string, string | number | boolean | null>;

export interface ExplicacionDeCierre {
  codigo: CloseCheckCode;
  item: string;
  /** El comando exacto que corrige lo listado. */
  remedio: string;
  /** Cuántos renglones ofensores hay EN TOTAL (renglones puede venir acotado). */
  total: number;
  renglones: RenglonOfensor[];
}

/**
 * El remedio de cada casilla, UNA vez: es lo que `closing explain` promete
 * («y el comando exacto que lo corrige») y lo que la prueba de completitud
 * exige que exista para todo código del registro.
 */
export const REMEDIO_DE: Readonly<Record<CloseCheckCode, string>> = {
  'previous-period-closed': 'mnemosine close  (sin --period cierra siempre el más viejo)',
  'entries-posted': 'mnemosine entry post <entry_number>  (o mnemosine review para los pendientes de aprobación)',
  'bank-reconciled': 'mnemosine bank reconciliation run <account> --period <YYYY-MM>',
  'bank-variance-frozen': 'mnemosine bank reconciliation status <session>',
  'bank-items-overdue': 'mnemosine bank reconciling-item assign <session> <item> --expected <YYYY-MM-DD>',
  'bank-lines-unexplained': 'mnemosine bank reconciliation run <account> --period <YYYY-MM>',
  'invoices-reviewed': 'mnemosine invoice issue <invoice_number>',
  'depreciation-posted': 'mnemosine depreciation run --period <YYYY-MM>',
  'trial-balance': 'mnemosine ledger check --check balance --period <YYYY-MM>',
  'ledger-integrity': 'mnemosine ledger check --period <YYYY-MM>',
  'rep-parked': 'mnemosine rep reconcile',
  'rep-missing': 'mnemosine rep missing list',
  'sat-agrupador-missing': 'mnemosine account map set <code> --scheme sat-agrupador --value <c_CodAgrup>',
};

export interface OpcionesDeExplicacion {
  /** Máximo de renglones a devolver (el total real siempre viaja aparte). */
  limit?: number;
}

const LIMITE_POR_OMISION = 20;

type Runner = (entityId: string, periodId: string, limit: number) => Promise<{
  total: number;
  renglones: RenglonOfensor[];
}>;

/** COUNT(*) OVER() en cada consulta: el total viaja con los renglones. */
async function filas(
  sql: string,
  params: unknown[]
): Promise<{ total: number; renglones: RenglonOfensor[] }> {
  const r = await query<RenglonOfensor & { total_ofensores: string }>(sql, params);
  const total = r.rows.length > 0 ? parseInt(String(r.rows[0].total_ofensores), 10) : 0;
  return {
    total,
    renglones: r.rows.map(({ total_ofensores: _omitido, ...resto }) => resto),
  };
}

const RUNNERS: Record<CloseCheckCode, Runner> = {
  // Espejo de la casilla 0: TODOS los periodos anteriores sin cerrar, el más
  // viejo primero. No sólo el inmediato: el hueco que `period reopen` deja
  // detrás de un mes ya cerrado es un renglón ofensor igual que los demás, y
  // era invisible cuando esta lista se conformaba con mirar un paso atrás.
  'previous-period-closed': (entityId, periodId, limit) =>
    filas(
      `SELECT fp.period_name, fp.status,
              to_char(fp.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(fp.end_date, 'YYYY-MM-DD') AS end_date,
              COUNT(*) OVER()::text AS total_ofensores
         FROM fiscal_periods fp
        WHERE fp.entity_id = $1
          AND fp.start_date < (SELECT start_date FROM fiscal_periods WHERE id = $2 AND entity_id = $1)
          AND fp.status NOT IN ('soft_close', 'hard_close', 'locked')
        ORDER BY fp.start_date ASC
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  'entries-posted': (entityId, periodId, limit) =>
    filas(
      `SELECT je.entry_number, je.status,
              to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date,
              je.description,
              COUNT(*) OVER()::text AS total_ofensores
         FROM journal_entries je
        WHERE je.fiscal_period_id = $2 AND je.entity_id = $1
          AND je.status IN ('draft', 'pending_approval')
        ORDER BY je.entry_date, je.entry_number
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  // Espejo de la casilla 2: cuentas activas SIN sesión que CUBRA el periodo.
  'bank-reconciled': (entityId, periodId, limit) =>
    filas(
      `SELECT ba.account_name, ba.bank_name, ba.id,
              COUNT(*) OVER()::text AS total_ofensores
         FROM bank_accounts ba
        WHERE ba.entity_id = $1 AND ba.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM reconciliation_sessions rs
             WHERE rs.bank_account_id = ba.id
               AND rs.status IN ('balanced', 'approved', 'posted')
               AND rs.start_date <= (SELECT start_date FROM fiscal_periods WHERE id = $2)
               AND rs.end_date   >= (SELECT end_date   FROM fiscal_periods WHERE id = $2))
        ORDER BY ba.account_name
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  // Espejo de la casilla 2b: la variación congelada que no es cero, o la
  // sesión balanceada sin aritmética (054). El monto sale ::text tal cual lo
  // guarda la columna DECIMAL(19,4): recortar a la salida es el defecto que
  // F05a cazó tres veces.
  'bank-variance-frozen': (entityId, periodId, limit) =>
    filas(
      `SELECT ba.account_name, rs.id AS session_id, rs.status,
              rs.variance::text AS variance,
              (rs.arithmetic_computed_at IS NULL) AS sin_aritmetica,
              to_char(rs.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(rs.end_date, 'YYYY-MM-DD') AS end_date,
              COUNT(*) OVER()::text AS total_ofensores
         FROM reconciliation_sessions rs
         JOIN bank_accounts ba ON ba.id = rs.bank_account_id
        WHERE ba.entity_id = $1 AND rs.entity_id = $1 AND ba.is_active = true
          AND rs.status IN ('balanced', 'approved', 'posted')
          AND rs.start_date <= (SELECT start_date FROM fiscal_periods WHERE id = $2)
          AND rs.end_date   >= (SELECT end_date   FROM fiscal_periods WHERE id = $2)
          AND (rs.variance <> 0 OR rs.arithmetic_computed_at IS NULL)
        ORDER BY ba.account_name
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  // Espejo de la casilla 2c, con el criterio de derivarEscalamiento: vencido
  // lo dice el calendario y lo derivado gana a lo guardado.
  'bank-items-overdue': (entityId, _periodId, limit) =>
    filas(
      `SELECT ri.id, ri.reconciliation_session_id AS session_id, ri.tipo,
              ri.importe::text AS importe,
              to_char(ri.fecha, 'YYYY-MM-DD') AS fecha,
              to_char(ri.fecha_esperada, 'YYYY-MM-DD') AS fecha_esperada,
              ri.responsable,
              (CURRENT_DATE - ri.fecha)::int AS antiguedad_dias,
              COUNT(*) OVER()::text AS total_ofensores
         FROM reconciling_items ri
        WHERE ri.entity_id = $1
          AND ri.resuelta_at IS NULL
          AND ((ri.fecha_esperada IS NOT NULL AND ri.fecha_esperada < CURRENT_DATE)
            OR (ri.fecha_esperada IS NULL AND ri.escalamiento = 'vencido'))
        ORDER BY ri.fecha
        LIMIT $2`,
      [entityId, limit]
    ),

  // Espejo de la casilla 2d: cotejo VIVO en reconciliation_matches, nunca la
  // caché is_matched; acumulado hasta el fin del periodo; la frontera de
  // entidad es el JOIN a bank_accounts, dentro del SQL.
  'bank-lines-unexplained': (entityId, periodId, limit) =>
    filas(
      `SELECT bt.id, ba.account_name,
              to_char(bt.transaction_date, 'YYYY-MM-DD') AS transaction_date,
              bt.amount::text AS amount,
              bt.description,
              COUNT(*) OVER()::text AS total_ofensores
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE ba.entity_id = $1 AND ba.is_active = true
          AND bt.transaction_date <= (SELECT end_date FROM fiscal_periods WHERE id = $2)
          AND NOT EXISTS (
                SELECT 1 FROM reconciliation_matches rm
                 WHERE rm.bank_transaction_id = bt.id AND rm.unapplied_at IS NULL)
          AND NOT EXISTS (
                SELECT 1 FROM reconciling_items ri
                 WHERE ri.bank_transaction_id = bt.id AND ri.entity_id = ba.entity_id)
        ORDER BY bt.transaction_date, bt.id
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  'invoices-reviewed': (entityId, periodId, limit) =>
    filas(
      `SELECT i.invoice_number,
              to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
              i.total_amount::text AS total_amount,
              i.currency_code,
              COUNT(*) OVER()::text AS total_ofensores
         FROM invoices i
        WHERE i.entity_id = $1 AND i.status = 'draft'
          AND i.invoice_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                 AND (SELECT end_date   FROM fiscal_periods WHERE id = $2)
        ORDER BY i.invoice_date, i.invoice_number
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  'depreciation-posted': (entityId, periodId, limit) =>
    filas(
      `SELECT fa.asset_number, fa.asset_name,
              to_char(fa.acquisition_date, 'YYYY-MM-DD') AS acquisition_date,
              fa.acquisition_cost::text AS acquisition_cost,
              COUNT(*) OVER()::text AS total_ofensores
         FROM fixed_assets fa
        WHERE fa.entity_id = $1 AND fa.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM depreciation_schedules ds
             WHERE ds.asset_id = fa.id AND ds.fiscal_period_id = $2 AND ds.is_posted = true)
        ORDER BY fa.asset_number
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  // La balanza es un AGREGADO: su renglón ofensor es la diferencia misma.
  // El detalle cuenta por cuenta es de `ledger check --check balance`, que
  // ya lista renglones señalables — el remedio apunta ahí.
  'trial-balance': async (entityId, periodId) => {
    const r = await query<{ d: string; c: string; diff: string }>(
      `SELECT COALESCE(SUM(COALESCE(debit_total, 0)), 0)::text AS d,
              COALESCE(SUM(COALESCE(credit_total, 0)), 0)::text AS c,
              ABS(COALESCE(SUM(COALESCE(debit_total, 0)) - SUM(COALESCE(credit_total, 0)), 0))::text AS diff
         FROM account_balances
        WHERE fiscal_period_id = $2 AND entity_id = $1`,
      [entityId, periodId]
    );
    const fila = r.rows[0];
    const descuadrada = Number(fila.diff) > 0.01;
    return descuadrada
      ? {
          total: 1,
          renglones: [{ debit_total: fila.d, credit_total: fila.c, difference: fila.diff }],
        }
      : { total: 0, renglones: [] };
  },

  // Espejo de la casilla 5b: los hallazgos BLOQUEANTES de runLedgerChecks,
  // que ya vienen como renglones señalables.
  'ledger-integrity': async (entityId, periodId, limit) => {
    const hallazgos = await runLedgerChecks(entityId, undefined, { period: periodId });
    const bloqueantes = hallazgos.filter((h) => h.severity === 'blocking');
    return {
      total: bloqueantes.length,
      renglones: bloqueantes.slice(0, limit).map((h) => ({
        check: h.check,
        referencia: h.referencia,
        detalle: h.detalle,
      })),
    };
  },

  // Espejo de la casilla 6, CON el filtro por document_date del periodo: el
  // REP de noviembre no es un renglón ofensor del cierre de agosto.
  'rep-parked': (entityId, periodId, limit) =>
    filas(
      `SELECT pr.id, pr.external_reference,
              to_char(pr.document_date, 'YYYY-MM-DD') AS document_date,
              pr.total_amount::text AS total_amount,
              pr.currency_code,
              COUNT(*) OVER()::text AS total_ofensores
         FROM pre_registrations pr
        WHERE pr.entity_id = $1 AND pr.document_type = 'payment'
          AND pr.validation_status = 'needs_review'
          AND pr.status NOT IN ('completed', 'rejected', 'duplicate')
          AND pr.document_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                   AND (SELECT end_date   FROM fiscal_periods WHERE id = $2)
        ORDER BY pr.document_date, pr.id
        LIMIT $3`,
      [entityId, periodId, limit]
    ),

  // Los dos lados en una sola lista, marcados por dirección: recibido = el
  // pago al proveedor cuyo REP no llegó; emitido = el cobro cuyo REP debemos.
  'rep-missing': (entityId, periodId, limit) =>
    filas(
      `SELECT pagos.*, COUNT(*) OVER()::text AS total_ofensores
       FROM (
         SELECT 'recibido' AS direction, vp.payment_number,
                to_char(vp.payment_date, 'YYYY-MM-DD') AS payment_date,
                vp.payment_amount::text AS payment_amount, vp.currency_code
           FROM vendor_payments vp
          WHERE vp.entity_id = $1 AND vp.cfdi_uuid IS NULL AND vp.status <> 'void'
            AND vp.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                    AND (SELECT end_date   FROM fiscal_periods WHERE id = $2)
         UNION ALL
         SELECT 'emitido' AS direction, cp.payment_number,
                to_char(cp.payment_date, 'YYYY-MM-DD') AS payment_date,
                cp.payment_amount::text AS payment_amount, cp.currency_code
           FROM customer_payments cp
          WHERE cp.entity_id = $1 AND cp.cfdi_uuid IS NULL AND cp.status <> 'void'
            AND cp.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                    AND (SELECT end_date   FROM fiscal_periods WHERE id = $2)
       ) pagos
       ORDER BY pagos.payment_date, pagos.payment_number
       LIMIT $3`,
      [entityId, periodId, limit]
    ),

  // Espejo de la casilla 7 (F07a): las cuentas CON MOVIMIENTO POSTEADO hasta
  // el corte del periodo a las que les falta el agrupador del Anexo 24. Mismo
  // predicado que `checkMappingCoverageDetallada` con alcance
  // 'cuentas_con_movimientos' y `hasta` = fin del periodo, y por lo mismo
  // acumulado y no acotado al mes: una cuenta movida en enero lleva SaldoIni
  // en la balanza de marzo.
  //
  // La COLUMNA sale de MAPPING_SCHEMES y no escrita a mano: el agrupador ya
  // cambió de casilla una vez (mx_nif_code → codigo_agrupador_sat, migración
  // 063) y una copia literal aquí habría quedado apuntando al sitio viejo sin
  // que nada lo dijera. Es una constante del módulo, no entrada del usuario.
  //
  // La entidad va en las DOS tablas —la cuenta y el asiento— igual que en la
  // compuerta: un asiento de otra entidad no puede ser el que obligue a
  // mapear ésta.
  'sat-agrupador-missing': (entityId, periodId, limit) =>
    filas(
      `SELECT a.code, a.name, a.account_level, m.lineas AS lineas_posteadas,
              COUNT(*) OVER()::text AS total_ofensores
         FROM accounts a
         JOIN (
           SELECT jel.account_id, COUNT(*)::int AS lineas
             FROM journal_entry_lines jel
             JOIN journal_entries je
               ON je.id = jel.journal_entry_id
              AND je.status = 'posted'
              AND je.entity_id = $1
              AND je.entry_date <= (SELECT end_date FROM fiscal_periods WHERE id = $2)
            GROUP BY jel.account_id
         ) m ON m.account_id = a.id
        WHERE a.entity_id = $1 AND a.is_active = true
          AND a.${MAPPING_SCHEMES['sat-agrupador']} IS NULL
        ORDER BY a.code
        LIMIT $3`,
      [entityId, periodId, limit]
    ),
};

/** ¿Es un código del registro? (para validar entrada de CLI sin lanzar). */
export function esCodigoDeCierre(valor: string): valor is CloseCheckCode {
  return (CLOSE_CHECK_CODES as readonly string[]).includes(valor);
}

/**
 * Los renglones ofensores de UNA casilla del cierre, con su remedio.
 *
 * `codigo` se valida contra el registro ANTES de tocar la base: un código
 * desconocido es un error de uso que lista los disponibles, no un universo
 * vacío que tranquiliza (la lección de los filtros de ledger-checks).
 */
export async function explainCloseCheck(
  entityId: string,
  periodId: string,
  codigo: string,
  opts: OpcionesDeExplicacion = {}
): Promise<ExplicacionDeCierre> {
  if (!esCodigoDeCierre(codigo)) {
    throw new ValidationError(
      `Verificación de cierre desconocida "${codigo}". Las disponibles son: ${CLOSE_CHECK_CODES.join(', ')}.`
    );
  }
  const limit = opts.limit ?? LIMITE_POR_OMISION;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ValidationError(`--limit tiene que ser un entero positivo; llegó ${String(opts.limit)}.`);
  }
  // La misma pertenencia que getPeriodCloseStatus y por lo mismo: cada
  // consulta filtra por entidad, así que sobre un periodo ajeno (o
  // inexistente) todas devolverían cero renglones — un «limpio» fabricado
  // donde corresponde un 404 por pertenencia (serie TEN).
  const dueno = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
    [periodId, entityId]
  );
  if (dueno.rows.length === 0) {
    throw new NotFoundError('Fiscal period', periodId);
  }
  const { total, renglones } = await RUNNERS[codigo](entityId, periodId, limit);
  return {
    codigo,
    item: CLOSE_CHECK_ITEMS[codigo],
    remedio: REMEDIO_DE[codigo],
    total,
    renglones,
  };
}
