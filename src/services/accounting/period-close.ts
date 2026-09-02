import Decimal from 'decimal.js';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { createJournalEntry, attestEntryAsync, reverseWithinTransaction } from './posting.js';
import { runLedgerChecks } from './ledger-checks.js';
import { AccountingError, NotFoundError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { FiscalPeriodStatus } from '../../types/index.js';
import type { FiscalPeriod, JournalEntry, JournalEntryType } from '../../types/index.js';

// ============================================================
// EL CHECKLIST DEL CIERRE — casillas con NOMBRE ESTABLE
//
// Cada casilla lleva un `codigo` kebab-case además de su `item` en prosa:
// `closing check --check <codigo>`, `closing explain <codigo>` y cualquier
// script filtran por el código sin parsear inglés. La prosa puede afinarse;
// el código, una vez publicado, no cambia — es el contrato.
//
// La lista es también el REGISTRO de verificaciones que el catálogo pide
// para `closing check` (sin valor, `--check` imprime estos nombres).
// ============================================================

export const CLOSE_CHECK_CODES = [
  'previous-period-closed',
  'entries-posted',
  'bank-reconciled',
  'bank-variance-frozen',
  'bank-items-overdue',
  'bank-lines-unexplained',
  'invoices-reviewed',
  'depreciation-posted',
  'trial-balance',
  'ledger-integrity',
  'rep-parked',
  'rep-missing',
] as const;
export type CloseCheckCode = (typeof CLOSE_CHECK_CODES)[number];

/**
 * La prosa de cada casilla, UNA vez. Los textos existentes se conservan
 * literales: hay pruebas y renderizadores que los buscan por `item`.
 */
export const CLOSE_CHECK_ITEMS: Readonly<Record<CloseCheckCode, string>> = {
  'previous-period-closed': 'Previous period closed',
  'entries-posted': 'All journal entries posted',
  'bank-reconciled': 'Bank reconciliations complete',
  'bank-variance-frozen': 'Reconciliation variance frozen at zero',
  'bank-items-overdue': 'Reconciling items within their expected dates',
  'bank-lines-unexplained': 'Bank statement lines explained',
  'invoices-reviewed': 'All invoices reviewed',
  'depreciation-posted': 'Depreciation calculated and posted',
  'trial-balance': 'Trial balance balanced',
  'ledger-integrity': 'Ledger passes its blocking checks',
  'rep-parked': 'Parked payment receipts (REP) resolved',
  'rep-missing': 'Payments in period have their REP',
};

export type CloseCheckSeverity = 'blocking' | 'warning';

/**
 * Qué peso tiene una línea de banco sin explicar al cierre, según el panel.
 *
 * SOLO el literal 'bloquear_cierre' bloquea: 'partida_conciliatoria' y
 * 'suspenso' dicen «arrástrala» o «apárcala», así que si al cierre sigue sin
 * explicar es trabajo incompleto que se AVISA con su remedio — y un valor
 * desconocido del panel también avisa, por el mismo criterio defensivo de
 * rep_faltante_*: un valor raro no puede congelar el cierre de un despacho.
 */
export function severidadDeLineaSinPartida(valorDelPanel: string): CloseCheckSeverity {
  return valorDelPanel === 'bloquear_cierre' ? 'blocking' : 'warning';
}

export interface PeriodCloseChecklistItem {
  /** Nombre estable kebab-case; el contrato de `closing check|explain`. */
  codigo: CloseCheckCode;
  item: string;
  is_complete: boolean;
  /**
   * El peso de la casilla EN SU ESTADO ACTUAL: las gobernadas por política se
   * resuelven contra el panel al evaluar. Incompleta y 'blocking' detiene el
   * cierre; incompleta y 'warning' sólo avisa. En una casilla completa el
   * campo dice qué pasaría si dejara de estarlo.
   */
  severity: CloseCheckSeverity;
  details?: string;
}

export interface PeriodCloseStatus {
  can_close: boolean;
  blocking_issues: string[];
  warnings: string[];
  checklist: PeriodCloseChecklistItem[];
}

export async function getPeriodCloseStatus(
  periodId: string,
  entityId: string,
  client?: pg.PoolClient
): Promise<PeriodCloseStatus> {
  // Con `client`, el checklist corre DENTRO de la transacción del cierre,
  // con la fila del periodo ya bajo FOR UPDATE (R1): la foto y el acto son
  // el mismo instante. Sin él, es la consulta informativa de siempre.
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
    client ? client.query<T>(sql, params) : query<T>(sql, params);
  const blocking_issues: string[] = [];
  const warnings: string[] = [];
  const checklist: PeriodCloseChecklistItem[] = [];

  // LA PERTENENCIA SE COMPRUEBA ANTES DE CONTAR NADA. Cada detector filtra
  // por entidad, así que sobre un periodo ajeno (o inexistente) todos
  // contarían cero y el resultado sería un «todo limpio» FABRICADO — la ruta
  // REST lo servía como can_close: true incluso sobre un UUID inventado. 404
  // por pertenencia, como toda la serie TEN. La misma consulta resuelve el
  // inquilino, que varias casillas leen del panel de políticas (línea de
  // banco sin explicar, REP) y todas comparten.
  const dueno = await q<{ tenant_id: string }>(
    `SELECT le.tenant_id
       FROM fiscal_periods fp
       JOIN legal_entities le ON le.id = fp.entity_id
      WHERE fp.id = $2 AND fp.entity_id = $1`,
    [entityId, periodId]
  );
  if (dueno.rows.length === 0) {
    throw new NotFoundError('Fiscal period', periodId);
  }
  const ctxPanel = { tenantId: dueno.rows[0].tenant_id, entityId };

  // 0. NINGÚN PERIODO ANTERIOR SIGUE SIN CERRAR.
  //
  // Nada lo comprobaba: cerrar octubre antes que septiembre deja huecos — el
  // arrastre de saldos siembra el periodo siguiente con finales que después
  // cambian, y el checklist de septiembre se evalúa cuando octubre ya congeló
  // su verdad. `close` sin `--period` ya elige el más viejo, pero `--period`
  // permitía saltárselo sin que ninguna casilla lo dijera.
  //
  // SE BUSCA EL MÁS VIEJO SIN CERRAR, no el inmediato anterior. Mirar sólo al
  // inmediato descansa en una inducción —«si el anterior cerró, los de antes
  // también»— que `period reopen` rompe a propósito: un enero reabierto
  // detrás de un febrero cerrado sería invisible al cerrar marzo, y los
  // huecos que la reapertura deja son exactamente lo que esta casilla
  // persigue. 'future' tampoco cuenta como cerrado: un mes que nunca se abrió
  // no es un mes revisado, y el posteo no lo rechaza (sólo hard_close/locked).
  //
  // ¿BLOQUEA O AVISA? Es una bifurcación de criterio contable (hay despachos
  // que cierran estrictamente en orden y despachos que adelantan un mes con
  // ajuste posterior) y NINGUNA política del panel la gobierna hoy: este
  // código no la decide. Avisa —lo único que no congela a nadie— y la
  // bifurcación queda reportada para añadirse al panel, que es donde un
  // criterio contable se elige (no aquí, no con una bandera).
  const periodoAnterior = await q<{ period_name: string; status: string }>(
    `SELECT period_name, status FROM fiscal_periods
      WHERE entity_id = $1
        AND start_date < (SELECT start_date FROM fiscal_periods WHERE id = $2 AND entity_id = $1)
        AND status NOT IN ('soft_close', 'hard_close', 'locked')
      ORDER BY start_date ASC LIMIT 1`,
    [entityId, periodId]
  );
  const anterior = periodoAnterior.rows[0];
  const anteriorCerrado = !anterior;
  checklist.push({
    codigo: 'previous-period-closed',
    item: CLOSE_CHECK_ITEMS['previous-period-closed'],
    is_complete: anteriorCerrado,
    severity: 'warning',
    details: anteriorCerrado
      ? undefined
      : `${anterior.period_name} sigue '${anterior.status}': cerrar fuera de orden deja huecos`,
  });
  if (!anteriorCerrado) {
    warnings.push(
      `hay un periodo anterior sin cerrar (${anterior.period_name}, '${anterior.status}'): ` +
        `cerrarlo primero evita huecos en el arrastre de saldos`
    );
  }

  // 1. Check all journal entries are posted
  const draftEntries = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries
     WHERE fiscal_period_id = $1 AND entity_id = $2 AND status IN ('draft', 'pending_approval')`,
    [periodId, entityId]
  );
  const draftCount = parseInt(draftEntries.rows[0].count, 10);
  checklist.push({
    codigo: 'entries-posted',
    item: CLOSE_CHECK_ITEMS['entries-posted'],
    is_complete: draftCount === 0,
    severity: 'blocking',
    details: draftCount > 0 ? `${draftCount} entries still in draft/pending` : undefined,
  });
  if (draftCount > 0) blocking_issues.push(`${draftCount} unposted journal entries`);

  // 2. Check bank reconciliations complete
  //
  // LA SESIÓN TIENE QUE CUBRIR EL PERIODO, no simplemente terminar después —
  // Y EL CONTEO TIENE QUE TRAER SU UNIVERSO. Las dos mitades de este predicado
  // vienen de arreglos distintos y las dos hacían falta:
  //
  // 1. El predicado era `rs.end_date >= periodo.end_date`, y con eso la sesión
  //    de SEPTIEMBRE tildaba la casilla de AGOSTO —30/09 es posterior a 31/08—
  //    aunque agosto no se hubiera conciliado nunca. «Cubrir» es empezar no
  //    después del periodo y acabar no antes: para la conciliación mensual
  //    normal es exactamente la sesión de ese mes.
  // 2. El COUNT daba 0 también cuando no había NI UNA cuenta bancaria, y el
  //    checklist firmaba «complete»: verde por vacuidad, nadie miró nada. Por
  //    eso el conteo trae también el total.
  //
  // Importa más desde F05c: hasta este tramo `balanced` se ponía sin aritmética
  // y la casilla mentía por su origen; ahora `balanced` se gana, así que lo
  // único que puede hacerla mentir es leerlo mal.
  const unreconciledAccounts = await q<{ total: string; sin_conciliar: string }>(
    `SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM reconciliation_sessions rs
              WHERE rs.bank_account_id = ba.id
              AND rs.status IN ('balanced', 'approved', 'posted')
              AND rs.start_date <= (SELECT start_date FROM fiscal_periods WHERE id = $2)
              AND rs.end_date   >= (SELECT end_date   FROM fiscal_periods WHERE id = $2)
            )) as sin_conciliar
     FROM bank_accounts ba
     WHERE ba.entity_id = $1 AND ba.is_active = true`,
    [entityId, periodId]
  );
  const totalBancos = parseInt(unreconciledAccounts.rows[0].total, 10);
  const unreconCount = parseInt(unreconciledAccounts.rows[0].sin_conciliar, 10);
  checklist.push({
    codigo: 'bank-reconciled',
    item: CLOSE_CHECK_ITEMS['bank-reconciled'],
    // `totalBancos > 0` no es adorno: sin él, cero cuentas bancarias firmaba
    // «completo» por vacuidad. Revisado-y-bien y nada-que-revisar no son
    // lo mismo, y en un checklist de cierre esa diferencia es el punto.
    is_complete: totalBancos > 0 && unreconCount === 0,
    severity: 'warning',
    details:
      totalBancos === 0
        ? '0 cuentas bancarias registradas: no se pudo comprobar'
        : unreconCount > 0
          ? `${unreconCount} accounts not reconciled`
          : undefined,
  });
  if (unreconCount > 0) warnings.push(`${unreconCount} bank accounts not reconciled`);

  // 2b. LA VARIACIÓN CONGELADA (054). La casilla anterior mira el ESTADO de
  // la sesión; ésta mira el DATO que ese estado afirma: `variance` con su
  // `arithmetic_computed_at`. Una sesión balanceada SIN aritmética es el
  // defecto histórico de F05c en persona —un cero por DEFAULT leído como
  // cuadre— y el CHECK de la 054 lo impide hacia adelante, pero el cierre no
  // puede citar como evidencia una fila que lo viole: eso BLOQUEA. Una
  // variación congelada distinta de cero es legal (la política de tolerancia
  // la admitió y mandó arrastrar el residual como partida nombrada), así que
  // sólo AVISA — y la casilla de partidas vencidas es la que persigue ese
  // residual si envejece.
  //
  // LAS DOS ENTIDADES, la de la cuenta y la de la sesión, como en
  // `listarPartidas` y por lo mismo: una sesión bien sellada colgada de una
  // cuenta ajena no puede tildar nada aquí.
  //
  // El predicado de cobertura va como JOIN a fiscal_periods y NO con la
  // grafía `(SELECT start_date FROM ...)` de la casilla anterior, adrede: el
  // espejo de mutación de E1.2 ancla en ESA línea literal y la exige única —
  // una segunda copia idéntica dejaría vivo al mutante que ablanda la
  // primera. Mismo significado, otra letra.
  const sesionesSospechosas = await q<{
    account_name: string;
    variance: string;
    sin_aritmetica: boolean;
  }>(
    `SELECT ba.account_name, rs.variance::text AS variance,
            (rs.arithmetic_computed_at IS NULL) AS sin_aritmetica
       FROM reconciliation_sessions rs
       JOIN bank_accounts ba ON ba.id = rs.bank_account_id
       JOIN fiscal_periods fp ON fp.id = $2 AND fp.entity_id = $1
      WHERE ba.entity_id = $1 AND rs.entity_id = $1 AND ba.is_active = true
        AND rs.status IN ('balanced', 'approved', 'posted')
        AND rs.start_date <= fp.start_date
        AND rs.end_date >= fp.end_date
        AND (rs.variance <> 0 OR rs.arithmetic_computed_at IS NULL)
      ORDER BY ba.account_name`,
    [entityId, periodId]
  );
  const sinAritmetica = sesionesSospechosas.rows.filter((r) => r.sin_aritmetica);
  const conResidual = sesionesSospechosas.rows.filter((r) => !r.sin_aritmetica);
  checklist.push({
    codigo: 'bank-variance-frozen',
    item: CLOSE_CHECK_ITEMS['bank-variance-frozen'],
    is_complete: sesionesSospechosas.rows.length === 0,
    severity: sinAritmetica.length > 0 ? 'blocking' : 'warning',
    details:
      sesionesSospechosas.rows.length > 0
        ? sesionesSospechosas.rows
            // La variación viaja como CADENA tal cual la guarda la columna
            // (DECIMAL 19,4): recortarla a dos decimales al mostrarla es el
            // defecto que F05a cazó tres veces.
            .map((r) => `${r.account_name}: ${r.sin_aritmetica ? 'sin aritmética' : `variance ${r.variance}`}`)
            .join('; ')
        : undefined,
  });
  if (sinAritmetica.length > 0) {
    blocking_issues.push(
      `${sinAritmetica.length} sesión(es) de conciliación en 'balanced' sin aritmética calculada: ` +
        `su cuadre es un cero por omisión, no una verificación (054)`
    );
  }
  if (conResidual.length > 0) {
    warnings.push(
      `${conResidual.length} sesión(es) cerraron con variación congelada distinta de cero: ` +
        `el residual debe vivir como partida conciliatoria con responsable y fecha`
    );
  }

  // 2c. LAS PARTIDAS CONCILIATORIAS VENCIDAS. El criterio es el de
  // `derivarEscalamiento` (reconciling-items.ts), literal: 'vencido' lo dice
  // EL CALENDARIO —el día después de `fecha_esperada`— y lo derivado gana a
  // lo guardado; sin fecha esperada se respeta lo escrito en la columna. Se
  // mide contra CURRENT_DATE y no contra el fin del periodo porque el
  // escalamiento es del reloj de quien persigue, no del mes que se cierra:
  // una partida vencida se persigue HOY, la cierre quien la cierre.
  //
  // SUM(ABS(...)) y no la suma firmada: el signo de `importe` es su
  // aportación a la conciliación, y sumar firmado dejaría que un cheque en
  // circulación tape a un depósito en tránsito — la magnitud perseguida es
  // la suma de magnitudes.
  const partidasVencidas = await q<{ count: string; importe: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(ABS(ri.importe)), 0)::text AS importe
       FROM reconciling_items ri
      WHERE ri.entity_id = $1
        AND ri.resuelta_at IS NULL
        AND ((ri.fecha_esperada IS NOT NULL AND ri.fecha_esperada < CURRENT_DATE)
          OR (ri.fecha_esperada IS NULL AND ri.escalamiento = 'vencido'))`,
    [entityId]
  );
  const vencidas = parseInt(partidasVencidas.rows[0].count, 10);
  checklist.push({
    codigo: 'bank-items-overdue',
    item: CLOSE_CHECK_ITEMS['bank-items-overdue'],
    is_complete: vencidas === 0,
    severity: 'warning',
    details:
      vencidas > 0
        ? `${vencidas} partida(s) vencida(s) por ${partidasVencidas.rows[0].importe} en total (bank reconciling-item list)`
        : undefined,
  });
  if (vencidas > 0) {
    warnings.push(
      `${vencidas} partida(s) conciliatoria(s) pasaron su fecha esperada sin resolverse: ` +
        `una partida que envejece es donde una diferencia se esconde`
    );
  }

  // 2d. LOS MOVIMIENTOS QUE NADIE EXPLICA. Mismo criterio literal que
  // `movimientosSinExplicar` (reconciliation-service.ts): el cotejo VIVO se
  // le pregunta a `reconciliation_matches` (unapplied_at IS NULL), nunca a la
  // caché `is_matched`, y una partida conciliatoria que cite el movimiento
  // también lo explica. ACUMULADO hasta el fin del periodo y no acotado a él,
  // porque los saldos que la conciliación compara son acumulados: un cargo de
  // marzo sin registrar en agosto sigue dentro del saldo que el banco publica
  // en agosto. `bank_transactions` no tiene entity_id: la frontera es el JOIN
  // a `bank_accounts`, DENTRO del SQL.
  const sinExplicar = await q<{ count: string; importe: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(ABS(bt.amount)), 0)::text AS importe
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE ba.entity_id = $1 AND ba.is_active = true
        AND bt.transaction_date <= (SELECT end_date FROM fiscal_periods WHERE id = $2)
        AND NOT EXISTS (
              SELECT 1 FROM reconciliation_matches rm
               WHERE rm.bank_transaction_id = bt.id AND rm.unapplied_at IS NULL)
        AND NOT EXISTS (
              SELECT 1 FROM reconciling_items ri
               WHERE ri.bank_transaction_id = bt.id AND ri.entity_id = ba.entity_id)`,
    [entityId, periodId]
  );
  const lineasSinExplicar = parseInt(sinExplicar.rows[0].count, 10);
  // La política que F05c dejó en el panel decide si esto avisa o bloquea.
  const polLinea = await getPolicy(ctxPanel, 'linea_banco_sin_partida_al_cierre');
  const severidadLinea = severidadDeLineaSinPartida(polLinea.value);
  checklist.push({
    codigo: 'bank-lines-unexplained',
    item: CLOSE_CHECK_ITEMS['bank-lines-unexplained'],
    is_complete: lineasSinExplicar === 0,
    severity: severidadLinea,
    details:
      lineasSinExplicar > 0
        ? `${lineasSinExplicar} movimiento(s) por ${sinExplicar.rows[0].importe} sin cotejo ni partida (bank reconciliation run)`
        : undefined,
  });
  if (lineasSinExplicar > 0) {
    (severidadLinea === 'blocking' ? blocking_issues : warnings).push(
      `${lineasSinExplicar} movimiento(s) del extracto sin explicar al cierre: ` +
        `ni cotejo vivo ni partida conciliatoria los reclama`
    );
  }

  // 3. Check invoices reviewed
  const draftInvoices = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM invoices
     WHERE entity_id = $1
     AND invoice_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                           AND (SELECT end_date FROM fiscal_periods WHERE id = $2)
     AND status = 'draft'`,
    [entityId, periodId]
  );
  const draftInvCount = parseInt(draftInvoices.rows[0].count, 10);
  checklist.push({
    codigo: 'invoices-reviewed',
    item: CLOSE_CHECK_ITEMS['invoices-reviewed'],
    is_complete: draftInvCount === 0,
    severity: 'warning',
    details: draftInvCount > 0 ? `${draftInvCount} draft invoices` : undefined,
  });
  if (draftInvCount > 0) warnings.push(`${draftInvCount} draft invoices in period`);

  // 4. Check depreciation calculated
  //
  // El gemelo del item bancario, con la misma mentira por vacuidad: cero
  // activos daba «Depreciation calculated and posted» sin que existiera
  // depreciación alguna que calcular. Mismo remedio: el universo viaja en el
  // conteo y con cero activos el item confiesa que no comprobó nada.
  const undepreciatedAssets = await q<{ total: string; sin_depreciar: string }>(
    `SELECT COUNT(*) as total,
            COUNT(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM depreciation_schedules ds
              WHERE ds.asset_id = fa.id AND ds.fiscal_period_id = $2 AND ds.is_posted = true
            )) as sin_depreciar
     FROM fixed_assets fa
     WHERE fa.entity_id = $1 AND fa.status = 'active'`,
    [entityId, periodId]
  );
  const totalActivos = parseInt(undepreciatedAssets.rows[0].total, 10);
  const undepCount = parseInt(undepreciatedAssets.rows[0].sin_depreciar, 10);
  checklist.push({
    codigo: 'depreciation-posted',
    item: CLOSE_CHECK_ITEMS['depreciation-posted'],
    // `totalActivos > 0` no es adorno: sin él, cero activos fijos firmaba
    // «completo» por vacuidad. Revisado-y-bien y nada-que-revisar no son
    // lo mismo, y en un checklist de cierre esa diferencia es el punto.
    is_complete: totalActivos > 0 && undepCount === 0,
    severity: 'warning',
    details:
      totalActivos === 0
        ? '0 activos fijos registrados: no se pudo comprobar'
        : undepCount > 0
          ? `${undepCount} assets without depreciation`
          : undefined,
  });
  if (undepCount > 0) warnings.push(`${undepCount} assets without depreciation posted`);

  // 5. Trial balance check
  const trialBalance = await q<{ diff: string }>(
    `SELECT ABS(SUM(COALESCE(debit_total, 0)) - SUM(COALESCE(credit_total, 0))) as diff
     FROM account_balances
     WHERE fiscal_period_id = $1 AND entity_id = $2`,
    [periodId, entityId]
  );
  const tbDiff = new Decimal(trialBalance.rows[0]?.diff || '0');
  checklist.push({
    codigo: 'trial-balance',
    item: CLOSE_CHECK_ITEMS['trial-balance'],
    is_complete: tbDiff.lessThanOrEqualTo('0.01'),
    severity: 'blocking',
    details: tbDiff.greaterThan('0.01') ? `Out of balance by ${tbDiff.toFixed(4)}` : undefined,
  });
  if (tbDiff.greaterThan('0.01')) blocking_issues.push(`Trial balance out of balance by ${tbDiff.toFixed(4)}`);

  // 5b. EL MAYOR PASA SUS VERIFICACIONES BLOQUEANTES. `runLedgerChecks`
  // existía desde F01 y el cierre NO lo consumía: sólo lo llamaban
  // `ledger check` y el verificador de respaldo, así que un periodo podía
  // cerrarse con `account_balances` desviado de las líneas posteadas o con
  // posteos sin autor en la bitácora. La balanza de arriba no lo cubre: suma
  // débitos contra créditos y un descuadre SIMÉTRICO (la caché mintiendo
  // igual en los dos lados) le pasa de largo.
  //
  // Va por el POOL y no por `client`, y es deliberado: `runLedgerChecks` no
  // acepta cliente y son lecturas de datos confirmados. Dentro del cierre
  // (R1) la fila del periodo ya está bajo FOR UPDATE, que se cruza con el
  // FOR SHARE de todo posteo, así que ningún posteo en vuelo puede colarse
  // entre esta foto y el UPDATE — la segunda conexión es el mismo costo que
  // ya paga getPolicy aquí mismo. Sin nombres corre las BLOQUEANTES
  // (balance, audit-trail), que es el contrato del catálogo; `balance` se
  // acota a este periodo, `audit-trail` es del mayor entero a propósito: un
  // posteo sin autor es un hecho sin autor, esté en el mes que esté.
  const hallazgosMayor = await runLedgerChecks(entityId, undefined, { period: periodId });
  const bloqueantesMayor = hallazgosMayor.filter((h) => h.severity === 'blocking');
  checklist.push({
    codigo: 'ledger-integrity',
    item: CLOSE_CHECK_ITEMS['ledger-integrity'],
    is_complete: bloqueantesMayor.length === 0,
    severity: 'blocking',
    details:
      bloqueantesMayor.length > 0
        ? bloqueantesMayor
            .slice(0, 3)
            .map((h) => `${h.check}: ${h.referencia}`)
            .join('; ') + (bloqueantesMayor.length > 3 ? ` (+${bloqueantesMayor.length - 3})` : '')
        : undefined,
  });
  if (bloqueantesMayor.length > 0) {
    blocking_issues.push(
      `el mayor no pasa ${bloqueantesMayor.length} verificación(es) bloqueante(s): ` +
        `ledger check las lista renglón por renglón`
    );
  }

  // 6. F02 · REP-2: el checklist del IVA aparcado. Dos conteos que el cierre
  // no miraba: los REP que llegaron y quedaron aparcados (needs_review), y
  // los pagos del periodo sin REP — recibidos (el IVA sigue en 1135, no es
  // acreditable) y emitidos (obligación fiscal PROPIA con plazo). Si cada
  // uno bloquea o solo avisa lo deciden rep_faltante_recibido y
  // rep_faltante_emitido: SOLO el literal 'bloquear' bloquea (cerrado al
  // declarar); 'avisar' o un valor desconocido avisan — un valor raro del
  // panel no puede congelar el cierre de un despacho.
  //
  // ACOTADO POR `document_date` DENTRO DEL PERIODO. Esta casilla tenía el
  // vicio de F05c en su forma pura: contaba pre_registrations SIN ningún
  // filtro de periodo, así que un REP de noviembre aparcado avisaba sobre el
  // cierre de AGOSTO — la casilla hablaba de otro mes, igual que la sesión
  // de septiembre tildaba la conciliación de agosto. Lo que el cierre
  // pregunta es si EL PERIODO tiene pendientes, no si el buzón está vacío:
  // un REP fechado después del periodo se atiende en el cierre de SU mes, y
  // uno fechado antes era asunto del cierre anterior (la casilla 0 es la que
  // vigila que ese cierre haya ocurrido).
  const repAparcados = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM pre_registrations
      WHERE entity_id = $1 AND document_type = 'payment'
        AND validation_status = 'needs_review'
        AND status NOT IN ('completed', 'rejected', 'duplicate')
        AND document_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                              AND (SELECT end_date   FROM fiscal_periods WHERE id = $2)`,
    [entityId, periodId]
  );
  const aparcados = parseInt(repAparcados.rows[0].count, 10);
  checklist.push({
    codigo: 'rep-parked',
    item: CLOSE_CHECK_ITEMS['rep-parked'],
    is_complete: aparcados === 0,
    severity: 'warning',
    details: aparcados > 0 ? `${aparcados} REP(s) esperando decisión: rep reconcile los reintenta` : undefined,
  });
  if (aparcados > 0) warnings.push(`${aparcados} REP(s) aparcados en needs_review`);

  const sinRep = await q<{ recibidos: string; emitidos: string }>(
    `SELECT
       (SELECT COUNT(*) FROM vendor_payments vp
         WHERE vp.entity_id = $1 AND vp.cfdi_uuid IS NULL AND vp.status <> 'void'
           AND vp.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                   AND (SELECT end_date FROM fiscal_periods WHERE id = $2))::text AS recibidos,
       (SELECT COUNT(*) FROM customer_payments cp
         WHERE cp.entity_id = $1 AND cp.cfdi_uuid IS NULL AND cp.status <> 'void'
           AND cp.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                   AND (SELECT end_date FROM fiscal_periods WHERE id = $2))::text AS emitidos`,
    [entityId, periodId]
  );
  const pagosSinRepRecibidos = parseInt(sinRep.rows[0].recibidos, 10);
  const pagosSinRepEmitidos = parseInt(sinRep.rows[0].emitidos, 10);
  // Las dos políticas se leen SIEMPRE (no sólo con conteo > 0): la casilla
  // publica su `severity` también cuando está completa, para que
  // `closing check` pueda decir con qué peso vigila cada verificación.
  const [polRecibido, polEmitido] = await Promise.all([
    getPolicy(ctxPanel, 'rep_faltante_recibido'),
    getPolicy(ctxPanel, 'rep_faltante_emitido'),
  ]);
  // Con pendientes, la severidad es la del pendiente que HAY (un cobro sin
  // REP bajo 'avisar' no puede volverse bloqueante porque la otra política
  // sea estricta); completa, es la más grave de las dos configuradas.
  const repFaltanteBloquea =
    pagosSinRepRecibidos + pagosSinRepEmitidos > 0
      ? (pagosSinRepRecibidos > 0 && polRecibido.value === 'bloquear') ||
        (pagosSinRepEmitidos > 0 && polEmitido.value === 'bloquear')
      : polRecibido.value === 'bloquear' || polEmitido.value === 'bloquear';
  checklist.push({
    codigo: 'rep-missing',
    item: CLOSE_CHECK_ITEMS['rep-missing'],
    is_complete: pagosSinRepRecibidos + pagosSinRepEmitidos === 0,
    severity: repFaltanteBloquea ? 'blocking' : 'warning',
    details:
      pagosSinRepRecibidos + pagosSinRepEmitidos > 0
        ? `${pagosSinRepRecibidos} pago(s) sin REP del proveedor, ${pagosSinRepEmitidos} cobro(s) sin REP emitido (rep missing list)`
        : undefined,
  });
  if (pagosSinRepRecibidos > 0) {
    (polRecibido.value === 'bloquear' ? blocking_issues : warnings).push(
      `${pagosSinRepRecibidos} pago(s) a proveedor sin REP: el IVA sigue aparcado en 1135`
    );
  }
  if (pagosSinRepEmitidos > 0) {
    (polEmitido.value === 'bloquear' ? blocking_issues : warnings).push(
      `${pagosSinRepEmitidos} cobro(s) sin REP emitido: obligación fiscal propia con plazo`
    );
  }

  return {
    can_close: blocking_issues.length === 0,
    blocking_issues,
    warnings,
    checklist,
  };
}

export async function softClosePeriod(
  periodId: string,
  entityId: string,
  userId: string,
  reason?: string
): Promise<FiscalPeriod> {
  // Cierre y rastro en la MISMA transacción. Antes eran dos query()
  // independientes: si el renglón de auditoría fallaba, el periodo quedaba
  // cerrado sin constancia de quién lo cerró. Y desde R1 el CHECKLIST también
  // vive dentro: se evaluaba fuera, así que un posteo en vuelo podía
  // confirmar entre la foto y el UPDATE — el periodo cerraba con un checklist
  // que no lo contaba. El FOR UPDATE de la fila se cruza con el FOR SHARE que
  // todo posteo toma (posting.ts): la foto y el acto son el mismo instante.
  return withTransaction(async (client) => {
    const candado = await client.query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [periodId, entityId]
    );
    if (candado.rows.length === 0) {
      throw new AccountingError('PERIOD_NOT_FOUND', 'Fiscal period not found');
    }
    if (candado.rows[0].status !== 'open') {
      throw new AccountingError('PERIOD_NOT_OPEN', 'Period is not in open status');
    }

    const status = await getPeriodCloseStatus(periodId, entityId, client);
    if (!status.can_close) {
      throw new AccountingError(
        'CANNOT_CLOSE_PERIOD',
        `Cannot close period: ${status.blocking_issues.join('; ')}`
      );
    }

    const result = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods
       SET status = 'soft_close', soft_close_date = NOW(), closed_by = $1,
           close_checklist = $2
       WHERE id = $3 AND entity_id = $4 AND status = 'open'
       RETURNING *`,
      [userId, JSON.stringify(status.checklist), periodId, entityId]
    );

    if (result.rows.length === 0) {
      throw new AccountingError('PERIOD_NOT_OPEN', 'Period is not in open status');
    }

    await registrarAuditoria(client, {
      tenantId: await inquilinoDe(client, entityId),
      userId,
      action: 'close',
      entityType: 'fiscal_period',
      entityId: periodId,
      newValues: { status: 'soft_close' },
      reason,
    });

    return result.rows[0];
  });
}

/** El inquilino del contexto, o el de la entidad. */
async function inquilinoDe(client: pg.PoolClient, entityId: string): Promise<string> {
  const delContexto = currentTenant();
  if (delContexto) return delContexto;
  const r = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new AccountingError(
      'TENANT_NO_RESUELTO',
      `No se pudo determinar el inquilino de la entidad ${entityId}: el cierre no se registra sin rastro.`
    );
  }
  return tenantId;
}

export async function hardClosePeriod(
  periodId: string,
  entityId: string,
  userId: string,
  reason?: string
): Promise<FiscalPeriod> {
  // Closing entries are created with the transaction's client (atomic with
  // the hard close), so attestation must fire here, AFTER commit.
  const closingEntryIds: string[] = [];
  let emitidosDelCierre = 0;
  let reversasDelCierre = 0;
  let avisosDelCierre: string[] = [];
  const closed = await withTransaction(async (client) => {
    // Verify soft_close
    const periodResult = await client.query<FiscalPeriod>(
      'SELECT * FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [periodId, entityId]
    );

    if (periodResult.rows.length === 0) {
      throw new AccountingError('PERIOD_NOT_FOUND', 'Fiscal period not found');
    }

    const period = periodResult.rows[0];

    if (period.status !== FiscalPeriodStatus.SOFT_CLOSE) {
      throw new AccountingError(
        'PERIOD_NOT_SOFT_CLOSED',
        'Period must be in soft_close status before hard close'
      );
    }

    // Check if this is a year-end period (last period in fiscal year)
    const isYearEnd = await client.query<{ is_last: boolean }>(
      `SELECT (fp.period_number = MAX(fp2.period_number)) as is_last
       FROM fiscal_periods fp
       JOIN fiscal_periods fp2 ON fp2.fiscal_year_id = fp.fiscal_year_id
       WHERE fp.id = $1
       GROUP BY fp.period_number`,
      [periodId]
    );

    // Generate closing entries for year-end
    if (isYearEnd.rows[0]?.is_last) {
      const cierre = await generateClosingEntries(
        client,
        entityId,
        periodId,
        userId,
        new Date(period.end_date),
        reason
      );
      // Los espejos de la reversa también son asientos nuevos: se atestan
      // igual que los del cierre.
      closingEntryIds.push(...cierre.ids, ...cierre.reversas);
      reversasDelCierre = cierre.reversas.length;
      avisosDelCierre = cierre.avisos;
      emitidosDelCierre = cierre.ids.length;
    }

    // Carry balance-sheet endings into the next period's beginnings.
    // Runs AFTER closing entries so a year-end carry already reflects the
    // P&L swept into retained earnings.
    await carryForwardBalances(client, entityId, periodId);

    // Hard close
    await client.query(
      `UPDATE fiscal_periods
       SET status = 'hard_close', hard_close_date = NOW()
       WHERE id = $1`,
      [periodId]
    );

    // El sello duro deja rastro en la misma transacción, igual que el suave.
    // Antes NO auditaba nada: el único vestigio era hard_close_date, sin
    // quién ni por qué — y es el acto que genera asientos de cierre y
    // arrastra saldos.
    await registrarAuditoria(client, {
      tenantId: await inquilinoDe(client, entityId),
      userId,
      action: 'close',
      entityType: 'fiscal_period',
      entityId: periodId,
      oldValues: { status: 'soft_close' },
      newValues: {
        status: 'hard_close',
        closing_entries: emitidosDelCierre,
        // Sólo cuando hubo: un cierre normal no ensucia el rastro con ceros.
        ...(reversasDelCierre > 0 ? { closing_reversals: reversasDelCierre } : {}),
        ...(avisosDelCierre.length > 0 ? { resultados_sin_barrer: avisosDelCierre } : {}),
      },
      reason,
    });

    // Lock all journal entries in this period
    await client.query(
      `UPDATE journal_entries
       SET status = CASE WHEN status = 'posted' THEN 'posted' ELSE status END
       WHERE fiscal_period_id = $1 AND entity_id = $2`,
      [periodId, entityId]
    );

    const result = await client.query<FiscalPeriod>(
      'SELECT * FROM fiscal_periods WHERE id = $1',
      [periodId]
    );

    return result.rows[0];
  });

  const tenantId = currentTenant();
  if (tenantId) {
    for (const entryId of closingEntryIds) {
      attestEntryAsync(tenantId, entityId, entryId);
    }
  }
  return closed;
}

/**
 * Seeds the NEXT period's account_balances with the closed period's ending
 * balances as beginning_balance — balance-sheet accounts only (P&L accounts
 * reset yearly through closing entries and hold per-period activity).
 * Invariant kept everywhere: ending = beginning + debit_total - credit_total,
 * in the ledger's sign convention (positive = debit nature).
 * Idempotent: recomputes from components on conflict. Returns the number of
 * accounts carried (0 when no next period exists yet).
 */
export async function carryForwardBalances(
  client: pg.PoolClient,
  entityId: string,
  closedPeriodId: string
): Promise<number> {
  const next = await client.query<{ id: string }>(
    `SELECT id FROM fiscal_periods
     WHERE entity_id = $1
       AND start_date > (SELECT end_date FROM fiscal_periods WHERE id = $2)
     ORDER BY start_date ASC LIMIT 1`,
    [entityId, closedPeriodId]
  );
  if (next.rows.length === 0) return 0; // next year not created yet — nothing to seed

  const nextPeriodId = next.rows[0].id;
  const result = await client.query(
    `INSERT INTO account_balances (
        account_id, fiscal_period_id, entity_id,
        beginning_balance, debit_total, credit_total, ending_balance)
     SELECT ab.account_id, $3, ab.entity_id,
            ab.ending_balance, 0, 0, ab.ending_balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     WHERE ab.fiscal_period_id = $2 AND ab.entity_id = $1
       AND a.account_type IN ('asset', 'liability', 'equity',
                              'contra_asset', 'contra_liability', 'contra_equity')
       -- Un final en cero no ESTRENA renglón —no hay acumulado que sembrar—,
       -- pero sí CORRIGE el que ya exista. Con ending_balance <> 0 a secas,
       -- la fila quedaba fuera del origen, el ON CONFLICT no llegaba a correr
       -- y el inicial VIEJO sobrevivía: reabrir junio para cancelar una
       -- cuenta por cobrar de 3 000 dejaba junio cerrando en 0 y julio
       -- abriendo en 3 000. Justo la corrección que se reabre a hacer es la
       -- que no llegaba al mes siguiente.
       AND (ab.ending_balance <> 0
            OR EXISTS (SELECT 1 FROM account_balances nb
                        WHERE nb.account_id = ab.account_id
                          AND nb.fiscal_period_id = $3))
     ON CONFLICT (account_id, fiscal_period_id)
     DO UPDATE SET
       beginning_balance = EXCLUDED.beginning_balance,
       ending_balance = EXCLUDED.beginning_balance
                        + account_balances.debit_total - account_balances.credit_total,
       updated_at = NOW()`,
    [entityId, closedPeriodId, nextPeriodId]
  );
  return result.rowCount ?? 0;
}

// ============================================================
// EL BARRIDO DEL EJERCICIO — POR SIGNO, NO POR abs()
//
// El saldo llega en la convención del mayor: DEUDOR POSITIVO
// (SUM(debit_total - credit_total)). Barrer una cuenta es asentarla del lado
// CONTRARIO a su saldo, y eso lo decide el signo — nada más.
//
// Por qué abs() parecía funcionar: en la cuenta de naturaleza normal el signo
// es siempre el mismo (un ingreso tiene saldo acreedor, o sea negativo; un
// gasto, deudor, positivo), así que «cargar siempre los ingresos y abonar
// siempre los gastos» acierta por casualidad — el signo era constante y el
// código no lo miraba.
//
// Por qué falla en la contra-natural: la 4400 «Devoluciones sobre Ventas» es
// revenue de naturaleza DEUDORA y la 5200 «Devoluciones sobre Compras» es
// expense de naturaleza ACREEDORA. Ahí abs() borra el signo que contradice al
// tipo de cuenta y asienta del MISMO lado que el saldo: en vez de barrer,
// DUPLICA —la cuenta queda al doble en lugar de en cero— y el total se infla
// con lo que debía restar. Con ventas 10 000 y devoluciones 2 000 el ingreso
// se acumulaba como 12 000.
//
// El asiento seguía cuadrando —la línea puente cancelaba el exceso— así que
// ninguna verificación de cuadre lo veía. La que lo ve es la del residuo:
// verificarQueElEjercicioBarrio.
// ============================================================

/** Un saldo de cuenta de resultados, en la convención del mayor. */
export interface SaldoDeResultados {
  account_id: string;
  /** Código de la cuenta; sirve para nombrarla si el barrido la deja con saldo. */
  code?: string;
  /** SUM(debit_total - credit_total) del ejercicio: positivo = deudor. */
  balance: string;
}

export interface LineaDeCierre {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
}

export interface BarridoDeCierre {
  lineas: LineaDeCierre[];
  /**
   * Suma de los saldos barridos CON SIGNO (deudor positivo), cuatro decimales.
   * Con abs() esto era la suma de valores absolutos, y una devolución INFLABA
   * el ingreso en vez de restarlo.
   */
  total: string;
}

/** El asiento que BARRE: el lado contrario al saldo. */
function lineaQueBarre(accountId: string, balance: Decimal, description: string): LineaDeCierre {
  return balance.greaterThan(0)
    ? { account_id: accountId, debit_amount: null, credit_amount: balance.toFixed(4), description }
    : { account_id: accountId, debit_amount: balance.abs().toFixed(4), credit_amount: null, description };
}

/**
 * La línea puente contra la cuenta de enlace: el MISMO lado que el total,
 * porque es la contrapartida de todo lo que se barrió del lado contrario.
 */
function lineaPuente(accountId: string, total: Decimal, description: string): LineaDeCierre {
  return total.greaterThan(0)
    ? { account_id: accountId, debit_amount: total.toFixed(4), credit_amount: null, description }
    : { account_id: accountId, debit_amount: null, credit_amount: total.abs().toFixed(4), description };
}

/**
 * Convierte saldos de resultados en las líneas que los dejan en cero, más la
 * línea puente contra la cuenta de enlace.
 *
 * Sirve para los tres tramos del cierre —ingresos contra 3900, gastos contra
 * 3900 y 3900 contra la cuenta de destino— porque los tres son la misma
 * operación: asentar lo contrario al saldo y enlazar por el neto.
 *
 * Total cero con líneas: legítimo (ventas 10 000 y devoluciones 10 000 se
 * barren entre sí). No lleva puente y el asiento cuadra igual. El guarda
 * viejo `greaterThan(0)` acertaba en ese caso por accidente y se volvía un
 * fallo duro con total NEGATIVO —un ejercicio de sólo devoluciones, o gastos
 * netos acreedores—: omitía la contrapartida y el asiento salía descuadrado.
 */
export function barrerCuentasDeResultados(
  saldos: ReadonlyArray<SaldoDeResultados>,
  puente: { account_id: string; descripcionCuenta: string; descripcionPuente: string }
): BarridoDeCierre {
  const lineas: LineaDeCierre[] = [];
  let total = new Decimal(0);

  for (const saldo of saldos) {
    const balance = new Decimal(saldo.balance);
    if (balance.isZero()) continue; // una cuenta sin saldo no se barre ni ensucia el asiento
    lineas.push(lineaQueBarre(saldo.account_id, balance, puente.descripcionCuenta));
    total = total.plus(balance);
  }

  if (!total.isZero()) {
    lineas.push(lineaPuente(puente.account_id, total, puente.descripcionPuente));
  }

  return { lineas, total: total.toFixed(4) };
}

/**
 * Dónde aterriza el resultado del ejercicio, según el panel.
 *
 * SOLO el literal 'directo_a_acumulados' funde el año con los anteriores. El
 * defecto y cualquier valor desconocido van por los dos pasos: la 3300
 * conserva identificable lo que ESTE ejercicio ganó hasta que la asamblea
 * resuelva, que es el único camino reversible de los dos.
 */
export function codigoDestinoDelResultado(valorDelPanel: string): '3200' | '3300' {
  return valorDelPanel === 'directo_a_acumulados' ? '3200' : '3300';
}

export type AccionDeRecierre = 'reversar' | 'incremental' | 'prohibir';

/**
 * Qué hacer con el cierre YA emitido cuando el periodo se reabrió y se cierra
 * otra vez.
 *
 * Un valor desconocido cae en 'incremental' —barrer lo que quede— y no en
 * 'reversar': es el único de los tres que no escribe nada por su cuenta, y
 * partiendo de los saldos vigentes no puede duplicar el resultado. Si el
 * cierre anterior barrió bien, no queda nada que barrer y no emite líneas.
 */
export function accionDeRecierre(valorDelPanel: string): AccionDeRecierre {
  if (valorDelPanel === 'reversar_y_reemitir') return 'reversar';
  if (valorDelPanel === 'prohibir') return 'prohibir';
  return 'incremental';
}

/**
 * Qué peso tiene una cuenta de resultados que sobrevive al barrido.
 *
 * 'tolerancia' bloquea igual que 'bloquear_cierre': la opción del panel
 * promete «hasta la tolerancia de cierre de la entidad» y esa cifra NO existe
 * —`closing_tolerance` es de las sesiones de conciliación, otro dominio—, así
 * que la tolerancia efectiva es cero. Un valor desconocido AVISA, por el mismo
 * criterio defensivo de severidadDeLineaSinPartida: un valor raro no congela
 * el cierre de un despacho.
 */
export function severidadDeResultadoSinBarrer(valorDelPanel: string): 'bloquear' | 'avisar' {
  return valorDelPanel === 'bloquear_cierre' || valorDelPanel === 'tolerancia'
    ? 'bloquear'
    : 'avisar';
}

/** Lo que el cierre anual dejó, para atestar y para el rastro. */
export interface AsientosDeCierreAnual {
  /** Los asientos de cierre emitidos. */
  ids: string[];
  /** Espejos del cierre anterior, cuando el periodo se reabrió y se recerró. */
  reversas: string[];
  /** Cuentas que no barrieron, cuando el panel manda avisar en vez de bloquear. */
  avisos: string[];
}

async function generateClosingEntries(
  client: pg.PoolClient,
  entityId: string,
  periodId: string,
  userId: string,
  periodEndDate: Date,
  reason?: string
): Promise<AsientosDeCierreAnual> {
  const resultado: AsientosDeCierreAnual = { ids: [], reversas: [], avisos: [] };

  // Income Summary (3900 "Resumen de Ingresos y Gastos"), Retained
  // Earnings (3200 "Resultado de Ejercicios Anteriores") y Resultado del
  // Ejercicio (3300, el destino de dos pasos).
  // Resolution is by CODE: both are equity, so matching on account_type
  // picked the SAME account twice and the Income Summary → Retained
  // Earnings entry debited and credited itself. The code must be 3200, not
  // 3100: 3100 is "Capital Social", and sweeping the year's result into
  // share capital both misstates equity and violates NIF C-11 (capital
  // social only moves by formal corporate acts).
  // Por CÓDIGO y no por ROL a propósito: la taxonomía de roles (AccountRole)
  // no tiene ninguno de capital —ni resultado, ni acumulados, ni resumen—, y
  // añadirlo es tocar cfdi-taxonomy, fuera de este alcance.
  // La 3300 se siembra SIN is_system_account, así que su rama del OR no puede
  // exigirlo; las otras dos lo conservan.
  const systemAccounts = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts
     WHERE entity_id = $1
     AND ((is_system_account = true AND code IN ('3900', '3200'))
          OR code = '3300')`,
    [entityId]
  );

  const incomeSummaryId = systemAccounts.rows.find((a) => a.code === '3900')?.id;
  const retainedEarningsId = systemAccounts.rows.find((a) => a.code === '3200')?.id;
  const resultadoDelEjercicioId = systemAccounts.rows.find((a) => a.code === '3300')?.id;

  // Las tres políticas se leen DENTRO de la transacción del cierre (el
  // cliente del llamador): getPolicy sin cliente toma una segunda conexión
  // del pool y el cierre ya tiene la suya tomada y en transacción.
  //
  // Se leen ANTES de decidir si hay cuentas puente porque la del residuo
  // gobierna también el camino en que NO las hay (ver justo debajo).
  const ctxPanel = { tenantId: await inquilinoDe(client, entityId), entityId };
  const polDestino = await getPolicy(ctxPanel, 'destino_del_resultado_del_ejercicio', client);
  const polRecierre = await getPolicy(ctxPanel, 'cierre_recierre_de_periodo_reabierto', client);
  const polResiduo = await getPolicy(ctxPanel, 'severidad_resultado_sin_barrer', client);

  // SIN CUENTAS PUENTE NO HAY BARRIDO, Y ESO NO ES UN CIERRE.
  //
  // Este `return` estaba ANTES de la comprobación de residuo, así que un
  // catálogo sin la marca de sistema en la 3900 —uno tocado a mano, o
  // migrado desde otro sistema— hacía que el cierre no emitiera una sola
  // línea y el periodo pasara igualmente a 'hard_close': el ejercicio entero
  // sin barrer, sin error y sin aviso, con `closing_entries: 0` como único
  // vestigio en el rastro. Es exactamente el caso para el que se escribió
  // severidad_resultado_sin_barrer, y quedaba detrás de la puerta.
  //
  // Ahora el residuo decide: un ejercicio sin actividad de resultados cierra
  // sin ruido, y uno con actividad se detiene nombrando lo que no barrió.
  if (!incomeSummaryId || !retainedEarningsId) {
    logger.warn(
      'Cierre anual: la entidad no tiene resueltas sus cuentas puente (3900 «Resumen de Ingresos y Gastos» y 3200 «Resultado de Ejercicios Anteriores», ambas con is_system_account); no se emite barrido.',
      { entity_id: entityId, fiscal_period_id: periodId }
    );
    await verificarQueElEjercicioBarrio(
      client,
      entityId,
      periodId,
      polResiduo.value,
      resultado.avisos
    );
    return resultado;
  }

  // El destino pedido puede no existir en un catálogo antiguo; entonces se
  // cae a 3200 y se dice, en vez de dejar el cierre sin contrapartida.
  const codigoPedido = codigoDestinoDelResultado(polDestino.value);
  if (codigoPedido === '3300' && !resultadoDelEjercicioId) {
    logger.warn(
      'Cierre anual: la política pide barrer a 3300 «Resultado del Ejercicio» y la entidad no la tiene en su catálogo; se usa 3200.',
      { entity_id: entityId, fiscal_period_id: periodId }
    );
  }
  const destinoId =
    codigoPedido === '3300' ? (resultadoDelEjercicioId ?? retainedEarningsId) : retainedEarningsId;
  const codigoDestino = destinoId === resultadoDelEjercicioId ? '3300' : '3200';
  const nombreDestino = codigoDestino === '3300' ? 'Result of the Period' : 'Retained Earnings';

  // 0. EL CIERRE ANTERIOR, SI LO HAY.
  //
  // `period reopen` (F06b) hizo alcanzable volver a cerrar un periodo que ya
  // emitió su cierre. Sin este tramo, el segundo cierre emitía un juego
  // COMPLETO de asientos y nada retiraba el primero: el resultado entraba dos
  // veces a capital. Se reconocen por entry_type='closing' + el periodo —el
  // esquema sí lo permite—, ya posteados y sin espejo previo; el espejo nace
  // con entry_type='reversing', así que una reversa nunca se toma por cierre.
  // FOR UPDATE porque reverseWithinTransaction lo exige del llamador.
  //
  // El discriminante es el que hay: la ruta REST de pólizas acepta
  // entry_type='closing' a mano, así que una póliza tecleada como «de cierre»
  // en el periodo de cierre entra en esta reversa. Se declaró de cierre; se
  // trata como de cierre. Distinguirlas exigiría marcar el origen del asiento,
  // que es esquema nuevo y no entra aquí.
  const cierresPrevios = await client.query<JournalEntry>(
    `SELECT * FROM journal_entries
      WHERE entity_id = $1 AND fiscal_period_id = $2
        AND entry_type = 'closing' AND status = 'posted'
        AND reversed_by_entry_id IS NULL
      ORDER BY entry_number
      FOR UPDATE`,
    [entityId, periodId]
  );

  if (cierresPrevios.rows.length > 0) {
    const accion = accionDeRecierre(polRecierre.value);
    const numeros = cierresPrevios.rows.map((e) => e.entry_number).join(', ');

    if (accion === 'prohibir') {
      throw new AccountingError(
        'CIERRE_YA_EMITIDO',
        `El periodo ya emitió su cierre (${numeros}) y la política ` +
          'cierre_recierre_de_periodo_reabierto lo prohíbe volver a cerrar: corrígelo por ' +
          'reclasificación explícita, o cambia la política en mnemosine pending.'
      );
    }

    if (accion === 'reversar') {
      // Por el camino de la 041: espejo posteado con folio propio y motivo
      // auditado, jamás una edición del asiento original (NIF B-1).
      const motivo =
        `Recierre de periodo reabierto: se reversa el cierre anterior antes de volver a emitirlo` +
        (reason ? ` · ${reason}` : '');
      for (const previo of cierresPrevios.rows) {
        const espejo = await reverseWithinTransaction(
          client,
          previo,
          userId,
          `Reversal of ${previo.entry_number}: ${motivo}`,
          periodEndDate
        );
        resultado.reversas.push(espejo.id);
      }
    }
    // 'incremental': el cierre anterior se queda en pie y el barrido de abajo
    // parte de los saldos VIGENTES, así que sólo emite lo que quede.
  }

  // 1. Close Revenue accounts. Balances aggregate over EVERY period of the
  // fiscal year being closed: per-period rows hold activity only (P&L
  // accounts do not carry forward), so closing just the last period (the
  // old query) left the earlier months' P&L unclosed.
  const revenueAccounts = await client.query<SaldoDeResultados>(
    `SELECT ab.account_id as account_id, a.code,
            SUM(ab.debit_total - ab.credit_total) as balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
     WHERE a.entity_id = $1 AND ab.entity_id = $1 AND a.account_type = 'revenue'
     AND fp.fiscal_year_id = (SELECT fiscal_year_id FROM fiscal_periods WHERE id = $2)
     GROUP BY ab.account_id, a.code`,
    [entityId, periodId]
  );

  // 2. Close Expense accounts (same full-fiscal-year aggregation)
  const expenseAccounts = await client.query<SaldoDeResultados>(
    `SELECT ab.account_id as account_id, a.code,
            SUM(ab.debit_total - ab.credit_total) as balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
     WHERE a.entity_id = $1 AND ab.entity_id = $1 AND a.account_type = 'expense'
     AND fp.fiscal_year_id = (SELECT fiscal_year_id FROM fiscal_periods WHERE id = $2)
     GROUP BY ab.account_id, a.code`,
    [entityId, periodId]
  );

  const barridoIngresos = barrerCuentasDeResultados(revenueAccounts.rows, {
    account_id: incomeSummaryId,
    descripcionCuenta: 'Close revenue to Income Summary',
    descripcionPuente: 'Revenue closed to Income Summary',
  });
  const barridoGastos = barrerCuentasDeResultados(expenseAccounts.rows, {
    account_id: incomeSummaryId,
    descripcionCuenta: 'Close expense to Income Summary',
    descripcionPuente: 'Expenses closed to Income Summary',
  });
  const closingLines = [...barridoIngresos.lineas, ...barridoGastos.lineas];

  // Create closing journal entry (revenue + expenses). Dated at the END of
  // the period being closed — new Date() (the old code) landed them in the
  // CURRENT open period, so the closed year's P&L never zeroed out in its
  // own period. Same client: atomic with the hard close.
  if (closingLines.length > 0) {
    const entry = await createJournalEntry(
      entityId,
      periodEndDate,
      'closing' as JournalEntryType,
      'Year-end closing entries',
      closingLines,
      userId,
      { autoPost: true, client }
    );
    resultado.ids.push(entry.id);
  }

  // 3. Close Income Summary to the destination the panel chose.
  //
  // Lo que queda en 3900 tras los dos puentes es la suma de los dos totales
  // CON SIGNO, en la misma convención deudor-positivo: negativo = saldo
  // acreedor = UTILIDAD. Barrerlo es el mismo acto que barrer cualquier otra
  // cuenta, así que va por la misma función — el abs() aparece una sola vez,
  // DESPUÉS de que el signo eligió el lado, que es donde siempre estuvo bien.
  const saldoResumen = new Decimal(barridoIngresos.total).plus(barridoGastos.total);
  if (!saldoResumen.isZero()) {
    const esUtilidad = saldoResumen.isNegative();
    const barridoResumen = barrerCuentasDeResultados(
      [{ account_id: incomeSummaryId, balance: saldoResumen.toFixed(4) }],
      {
        account_id: destinoId,
        descripcionCuenta: 'Close Income Summary',
        descripcionPuente: `Net ${esUtilidad ? 'income' : 'loss'} to ${nombreDestino}`,
      }
    );
    const entry = await createJournalEntry(
      entityId,
      periodEndDate,
      'closing' as JournalEntryType,
      `Close Income Summary to ${nombreDestino}`,
      barridoResumen.lineas,
      userId,
      { autoPost: true, client }
    );
    resultado.ids.push(entry.id);
  }

  // 4. LA COMPROBACIÓN QUE NO EXISTÍA.
  //
  // Nada verificaba que el ejercicio quedara en cero, y por eso el abs()
  // sobrevivió: el asiento cuadraba, `is_balanced` decía true y las cuentas
  // quedaban al DOBLE. Esta consulta es la única que lo ve.
  await verificarQueElEjercicioBarrio(
    client,
    entityId,
    periodId,
    polResiduo.value,
    resultado.avisos
  );

  return resultado;
}

/**
 * Tras emitir, ninguna cuenta de resultados del ejercicio puede conservar
 * saldo. Con 'bloquear_cierre' (el defecto) la excepción revierte la
 * transacción ENTERA del cierre duro y nombra las cuentas con su saldo.
 */
export async function verificarQueElEjercicioBarrio(
  client: pg.PoolClient,
  entityId: string,
  periodId: string,
  valorDelPanel: string,
  avisos: string[]
): Promise<void> {
  const residuos = await client.query<{ code: string; name: string; balance: string }>(
    `SELECT a.code, a.name, SUM(ab.debit_total - ab.credit_total)::text as balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
     WHERE a.entity_id = $1 AND ab.entity_id = $1
     AND a.account_type IN ('revenue', 'expense')
     AND fp.fiscal_year_id = (SELECT fiscal_year_id FROM fiscal_periods WHERE id = $2)
     GROUP BY a.id, a.code, a.name
     HAVING SUM(ab.debit_total - ab.credit_total) <> 0
     ORDER BY a.code`,
    [entityId, periodId]
  );
  if (residuos.rows.length === 0) return;

  const detalle = residuos.rows
    .map((r) => `${r.code} ${r.name}: ${new Decimal(r.balance).toFixed(4)}`)
    .join('; ');

  if (severidadDeResultadoSinBarrer(valorDelPanel) === 'bloquear') {
    throw new AccountingError(
      'RESULTADO_SIN_BARRER',
      `El cierre no dejó el ejercicio en cero: ${residuos.rows.length} cuenta(s) de resultados ` +
        `conservan saldo (${detalle}). El cierre se revirtió entero y el periodo sigue abierto: ` +
        'un saldo que sobrevive al cierre siembra mal el ejercicio siguiente. Si el despacho ' +
        'prefiere que esto sólo avise, la política es severidad_resultado_sin_barrer.'
    );
  }

  const aviso =
    `El cierre dejó ${residuos.rows.length} cuenta(s) de resultados con saldo (${detalle}): ` +
    'revisa el barrido antes de firmar los estados del ejercicio.';
  avisos.push(aviso);
  logger.warn(aviso, { entity_id: entityId, fiscal_period_id: periodId });
}

// Need to import pg for the client type
import pg from 'pg';
