import pg from 'pg';
import type { LedgerFinding } from '../accounting/ledger-checks.js';

// ============================================================
// LOS CHEQUEOS DEL MAYOR, CONTRA OTRA BASE (S3)
//
// `runLedgerChecks` consulta por el pool de la aplicación, que apunta a la
// base viva. Para verificar un respaldo hace falta correr las MISMAS
// preguntas contra la base RESTAURADA, sin tocar la de producción y sin
// reconfigurar el proceso entero.
//
// Se reimplementan aquí las dos comprobaciones que un volcado restaurado
// puede desmentir —el cuadre de cada asiento y el de los saldos
// materializados contra las líneas— con su propio cliente. No es duplicación
// gratuita: la firma de allá recibe una entidad y usa el pool global; aquí lo
// que cambia es la BASE, que es justo lo que no se puede parametrizar allá
// sin arrastrar el pool a todos sus llamadores.
//
// Lo que NO se replica es `audit-trail` y `continuity`: dependen de rastro
// acumulado y de la secuencia de folios, que un volcado conserva por
// construcción. Lo que un respaldo roto rompe es la ARITMÉTICA, y eso es lo
// que se mide.
// ============================================================

export async function runLedgerChecksEn(
  urlBase: string,
  entityId: string
): Promise<LedgerFinding[]> {
  const client = new pg.Client({ connectionString: urlBase });
  await client.connect();
  const hallazgos: LedgerFinding[] = [];
  try {
    // 1. Todo asiento posteado cuadra: Σ débitos = Σ créditos.
    const descuadres = await client.query<{ entry_number: string; debitos: string; creditos: string }>(
      `SELECT je.entry_number,
              COALESCE(SUM(jel.debit_amount), 0)::text  AS debitos,
              COALESCE(SUM(jel.credit_amount), 0)::text AS creditos
         FROM journal_entries je
         JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.entity_id = $1 AND je.status = 'posted'
        GROUP BY je.id, je.entry_number
       HAVING COALESCE(SUM(jel.debit_amount), 0) <> COALESCE(SUM(jel.credit_amount), 0)
        LIMIT 20`,
      [entityId]
    );
    for (const d of descuadres.rows) {
      hallazgos.push({
        check: 'balance',
        severity: 'blocking',
        referencia: d.entry_number,
        detalle: `débitos ${d.debitos} ≠ créditos ${d.creditos} en un asiento POSTEADO`,
      });
    }

    // 2. Los saldos materializados coinciden con la suma de las líneas: es
    //    lo primero que se desincroniza en una restauración a medias.
    // La suma va como SUBCONSULTA CORRELACIONADA, y no como LEFT JOIN.
    //
    // La primera versión unía journal_entry_lines por account_id y colgaba
    // el filtro de periodo del LEFT JOIN a journal_entries: las líneas de
    // OTROS periodos seguían entrando en el SUM (su `je` salía NULL, pero su
    // importe no). El síntoma, que se vio al correr esto contra datos
    // reales: la misma cuenta reportada dos veces, con dos saldos
    // materializados distintos y una única suma idéntica — la de todos los
    // periodos juntos. Ocho «hallazgos» que eran del instrumento, no del
    // respaldo. Correlacionada, cada saldo se compara contra SU periodo.
    const deriva = await client.query<{ code: string; periodo: string; guardado: string; real: string }>(
      `SELECT a.code,
              ab.fiscal_period_id::text AS periodo,
              ab.debit_total::text AS guardado,
              (SELECT COALESCE(SUM(jel.debit_amount), 0)
                 FROM journal_entry_lines jel
                 JOIN journal_entries je ON je.id = jel.journal_entry_id
                WHERE jel.account_id = ab.account_id
                  AND je.status = 'posted'
                  AND je.fiscal_period_id = ab.fiscal_period_id)::text AS real
         FROM account_balances ab
         JOIN accounts a ON a.id = ab.account_id
        WHERE a.entity_id = $1
          AND ab.debit_total <> (SELECT COALESCE(SUM(jel.debit_amount), 0)
                                   FROM journal_entry_lines jel
                                   JOIN journal_entries je ON je.id = jel.journal_entry_id
                                  WHERE jel.account_id = ab.account_id
                                    AND je.status = 'posted'
                                    AND je.fiscal_period_id = ab.fiscal_period_id)
        LIMIT 20`,
      [entityId]
    );
    for (const d of deriva.rows) {
      hallazgos.push({
        check: 'balance',
        severity: 'blocking',
        referencia: d.code,
        detalle:
          `saldo materializado ${d.guardado} ≠ suma de líneas posteadas ${d.real} ` +
          `(periodo ${d.periodo.slice(0, 8)})`,
      });
    }
  } finally {
    await client.end();
  }
  return hallazgos;
}

/** Simetría con el pool de la app: aquí no hay pool que cerrar, y se dice. */
export async function cerrarPoolPorRespaldo(): Promise<void> {
  // Cada comprobación abre y cierra su propio cliente: no queda nada vivo.
  return Promise.resolve();
}
