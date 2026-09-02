import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { findByIdInScope, requireByIdInScope, type Scope } from '../../database/scope.js';
import { floorMaxAutoAmount, FLOOR_MAX_AUTO_POST } from '../../ai/floor.js';
import { getPolicy } from '../policy/policy-service.js';
import { NotFoundError } from '../../utils/errors.js';
import type { BankTransaction } from '../../types/index.js';

// ============================================================
// MATCHING ALGORITHM (4-Tier Rule System from Spec)
//
// LO QUE UNA REGLA PROPONE Y LO QUE EL MOTOR APLICA SON DOS COSAS.
//
// Las cuatro reglas siempre devolvieron lo mismo —un id y un número— y el
// motor aplicaba en firme todo lo que pasara de 0.85. Eso metía en el mismo
// saco dos hechos que no se parecen: «el importe y la fecha coinciden
// exactamente y no hay otro candidato» y «la descripción se parece bastante».
// El catálogo prohíbe literalmente el segundo (fila 1225: nunca aplica un
// cotejo cuya única señal sea similitud de descripción), así que el resultado
// lleva ahora `auto_applicable`: la regla dice si su hallazgo es un hecho o
// una sugerencia, y el aplicador obedece.
// ============================================================

export interface Matchable {
  id: string;
  type: 'invoice' | 'bill' | 'customer_payment' | 'vendor_payment' | 'journal_entry_line';
  amount: string;
  date: Date;
  description: string;
  customer_name?: string;
  vendor_name?: string;
}

export interface MatchResult {
  match_id: string;
  match_type: string;
  confidence: number;
  matched_amount: string;
  /** Qué regla decidió. Antes se perdía, y con ella el porqué del cotejo. */
  rule: string;
  /**
   * Si este hallazgo puede aplicarse SIN un humano. Falso no significa
   * «malo»: significa que la señal que lo sostiene es blanda —parecido de
   * texto— y que por eso el cotejo se propone, se muestra y se espera.
   */
  auto_applicable: boolean;
}

/**
 * Lo único que las reglas miran de un movimiento. Se escribe así, y no como
 * `BankTransaction` entera, para que una prueba de la regla no tenga que
 * inventar quince columnas que la regla no lee.
 */
export type MovimientoCotejable = Pick<
  BankTransaction,
  'amount' | 'transaction_date' | 'description' | 'merchant_name'
>;

interface MatchRule {
  priority: number;
  name: string;
  match: (tx: MovimientoCotejable, candidates: Matchable[]) => MatchResult | null;
}

// ============================================================
// STRING SIMILARITY UTILITIES
// ============================================================

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function normalizeDescription(desc: string): string {
  return (desc || '').toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
}

function extractKeywords(desc: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'payment', 'transfer', 'deposit', 'debit', 'credit', 'ref', 'no',
  ]);

  const normalized = normalizeDescription(desc);
  const words = normalized.split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function descriptionSimilarity(desc1: string, desc2: string): number {
  const norm1 = normalizeDescription(desc1);
  const norm2 = normalizeDescription(desc2);

  if (norm1 === norm2) return 1.0;
  if (!norm1 || !norm2) return 0;

  // Levenshtein-based similarity
  const maxLen = Math.max(norm1.length, norm2.length);
  const levSimilarity = 1 - levenshteinDistance(norm1, norm2) / maxLen;

  // Jaccard keyword similarity
  const keywords1 = extractKeywords(desc1);
  const keywords2 = extractKeywords(desc2);
  const jaccard = jaccardSimilarity(keywords1, keywords2);

  // Weighted combination
  return levSimilarity * 0.4 + jaccard * 0.6;
}

// ============================================================
// MATCHING RULES
// ============================================================

// Rule 1: Exact Amount + Exact Date (Confidence: 1.0)
const exactAmountDateRule: MatchRule = {
  priority: 1,
  name: 'exact_amount_date',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const txDate = new Date(tx.transaction_date).toISOString().split('T')[0];

    const matches = candidates.filter((c) => {
      const cAmount = new Decimal(c.amount).abs();
      const cDate = new Date(c.date).toISOString().split('T')[0];
      return cAmount.equals(txAmount) && cDate === txDate;
    });

    if (matches.length === 1) {
      return {
        match_id: matches[0].id,
        match_type: matches[0].type,
        confidence: 1.0,
        matched_amount: txAmount.toFixed(4),
        rule: 'exact_amount_date',
        // Dos señales duras e independientes del texto —el importe idéntico
        // al centavo y el mismo día— sobre un candidato único.
        auto_applicable: true,
      };
    }
    return null;
  },
};

// Rule 2: Exact Amount + Near Date (±3 days, Confidence: 0.90)
const exactAmountNearDateRule: MatchRule = {
  priority: 2,
  name: 'exact_amount_near_date',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const txDate = new Date(tx.transaction_date).getTime();
    const threeDays = 3 * 24 * 60 * 60 * 1000;

    const matches = candidates.filter((c) => {
      const cAmount = new Decimal(c.amount).abs();
      const cDate = new Date(c.date).getTime();
      return cAmount.equals(txAmount) && Math.abs(txDate - cDate) <= threeDays;
    });

    if (matches.length === 1) {
      return {
        match_id: matches[0].id,
        match_type: matches[0].type,
        confidence: 0.90,
        matched_amount: txAmount.toFixed(4),
        rule: 'exact_amount_near_date',
        // El importe idéntico sigue siendo una señal dura y la ventana de tres
        // días es la segunda; ninguna de las dos es texto.
        auto_applicable: true,
      };
    }
    return null; // Ambiguous if multiple
  },
};

// Rule 3: Fuzzy Description Matching (Confidence: variable, >0.70)
const fuzzyDescriptionRule: MatchRule = {
  priority: 3,
  name: 'fuzzy_description',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const amountTolerance = txAmount.times(0.05); // 5% tolerance

    const scored = candidates
      .filter((c) => {
        const cAmount = new Decimal(c.amount).abs();
        return cAmount.minus(txAmount).abs().lessThanOrEqualTo(amountTolerance);
      })
      .map((c) => {
        let similarity = 0;

        // Description similarity
        if (tx.description && c.description) {
          similarity = descriptionSimilarity(tx.description, c.description);
        }

        // Merchant name vs customer/vendor name boost
        if (tx.merchant_name) {
          if (c.customer_name) {
            const nameSim = descriptionSimilarity(tx.merchant_name, c.customer_name);
            similarity = Math.max(similarity, nameSim);
          }
          if (c.vendor_name) {
            const nameSim = descriptionSimilarity(tx.merchant_name, c.vendor_name);
            similarity = Math.max(similarity, nameSim);
          }
        }

        return { candidate: c, similarity };
      })
      .filter((s) => s.similarity > 0.70)
      .sort((a, b) => b.similarity - a.similarity);

    if (scored.length === 1 && scored[0].similarity > 0.85) {
      // LA BANDA DEL 5 % NO ES UNA SEÑAL DURA. Que el importe caiga dentro de
      // una tolerancia dice que el candidato es plausible, no que sea ÉSTE;
      // quien decide dentro de la banda es la descripción, y ésa no aplica
      // sola. Cuando el importe coincide al centavo sí hay una segunda señal
      // independiente del texto, y entonces el hallazgo se sostiene por sí.
      const importeExacto = new Decimal(scored[0].candidate.amount).abs().equals(txAmount);

      // Y EL IMPORTE EXACTO SÓLO VALE SI DISTINGUE. Con dos candidatos del
      // mismo importe al centavo y del mismo día, las reglas 1 y 2 ya se
      // habían rehusado por ambiguas; si aquí uno de los dos pasa el 0.70 de
      // parecido y el otro no, lo que los separa vuelve a ser la descripción y
      // el cotejo se aplicaría por la señal que el catálogo prohíbe — sólo que
      // con el sello de una regla anterior. El empate se cuenta sobre TODOS los
      // candidatos, no sobre los que sobrevivieron al filtro de texto.
      const empatanEnImporte = candidates.filter((c) =>
        new Decimal(c.amount).abs().equals(txAmount)
      ).length;
      return {
        match_id: scored[0].candidate.id,
        match_type: scored[0].candidate.type,
        confidence: Math.round(scored[0].similarity * 100) / 100,
        matched_amount: txAmount.toFixed(4),
        rule: 'fuzzy_description',
        auto_applicable: importeExacto && empatanEnImporte === 1,
      };
    }
    return null;
  },
};

/** Puntaje mínimo para que la regla 4 se moleste en nombrar un candidato. */
const UMBRAL_PONDERADO = 0.75;

/**
 * Distancia mínima entre el primero y el segundo para que el primero se pueda
 * llamar ganador. Por debajo de esto los dos candidatos valen prácticamente lo
 * mismo y lo que los separa es ruido.
 */
const MARGEN_DESEMPATE = 0.05;

// Regla 4: PUNTAJE PONDERADO. Antes se llamaba `ml_prediction`.
//
// EL NOMBRE MENTÍA, y el proyecto ya retiró un endpoint entero por prometer un
// acto que no ejecutaba. Aquí no hay modelo, no hay entrenamiento y no hay
// aprendizaje: hay tres pesos escritos a mano —.45, .25, .30— sumados a mano,
// y el propio comentario del autor lo confesaba («replace with trained model
// in production»). Una fórmula de pesos es una cosa perfectamente respetable;
// lo que no es, es un modelo, y quien lea «ml_prediction» en la bitácora de un
// cotejo creerá que detrás hubo evidencia estadística que nunca existió.
const weightedScoreRule: MatchRule = {
  priority: 4,
  name: 'puntaje_ponderado',
  match(tx, candidates) {
    const txAmount = new Decimal(tx.amount).abs();
    const txDate = new Date(tx.transaction_date).getTime();

    const scored = candidates.map((c) => {
      const cAmount = new Decimal(c.amount).abs();
      const cDate = new Date(c.date).getTime();

      const amountDiff = cAmount.minus(txAmount).abs().dividedBy(Decimal.max(txAmount, '1')).toNumber();
      const dateDiff = Math.abs(txDate - cDate) / (24 * 60 * 60 * 1000); // días
      const descSim = tx.description && c.description
        ? descriptionSimilarity(tx.description, c.description)
        : 0;

      const amountScore = Math.max(0, 1 - amountDiff * 10);
      const dateScore = Math.max(0, 1 - dateDiff / 30);

      const probability = amountScore * 0.45 + dateScore * 0.25 + descSim * 0.30;

      return { candidate: c, probability };
    })
      .filter((s) => s.probability > UMBRAL_PONDERADO)
      .sort((a, b) => b.probability - a.probability);

    if (scored.length === 0) return null;

    // NO DESEMPATA POR TEXTO. Con el importe y la fecha razonablemente
    // parecidos entre dos candidatos, los sumandos de importe y fecha casi se
    // cancelan y quien decide el orden es `descSim` — es decir, el desempate
    // que las reglas 1 y 2 ya habían RECHAZADO por ambiguo lo resolvía esta
    // regla por parecido de descripción, y encima aplicaba en firme. Cuando
    // los dos primeros están dentro del margen, no hay ganador que nombrar.
    if (scored.length > 1 && scored[0].probability - scored[1].probability < MARGEN_DESEMPATE) {
      return null;
    }

    return {
      match_id: scored[0].candidate.id,
      match_type: scored[0].candidate.type,
      confidence: Math.round(scored[0].probability * 100) / 100,
      matched_amount: txAmount.toFixed(4),
      rule: 'puntaje_ponderado',
      // NUNCA se auto-aplica, con ningún umbral. Es la única regla que puede
      // devolver un ganador sin que ni el importe ni la fecha coincidan: con
      // .45 + .25 de sumandos blandos, un 0.76 se alcanza con un importe
      // aproximado, una fecha cercana y una descripción parecida, y ninguna de
      // las tres es una identidad. Propone, muestra su puntaje y espera.
      auto_applicable: false,
    };
  },
};

const MATCH_RULES: MatchRule[] = [
  exactAmountDateRule,
  exactAmountNearDateRule,
  fuzzyDescriptionRule,
  weightedScoreRule,
].sort((a, b) => a.priority - b.priority);

/**
 * Corre las cuatro reglas en orden de prioridad y devuelve el primer hallazgo.
 * Sin base de datos: los candidatos ya vienen dados.
 */
export function evaluarReglas(
  tx: MovimientoCotejable,
  candidates: Matchable[]
): MatchResult | null {
  for (const rule of MATCH_RULES) {
    const result = rule.match(tx, candidates);
    if (result) return result;
  }
  return null;
}

// ============================================================
// CANDIDATE COLLECTION
// ============================================================

async function getCandidates(
  bankAccountId: string,
  tx: BankTransaction,
  scope: Scope
): Promise<Matchable[]> {
  const txAmount = new Decimal(tx.amount).abs();
  const amountLow = txAmount.times(0.90).toFixed(4);
  const amountHigh = txAmount.times(1.10).toFixed(4);

  // LA CUENTA BANCARIA ES LA FRONTERA de todo este archivo.
  //
  // Ni bank_transactions ni reconciliation_matches tienen entity_id: cuelgan
  // de bank_account_id (migración 003). Así que el único punto donde se puede
  // acotar es aquí, y de aquí sale el entityId con el que se buscan los
  // candidatos. Antes esta lectura era `WHERE id = $1` a secas, de modo que
  // con el UUID de una cuenta ajena la función devolvía candidatos de la
  // víctima: SUS facturas, SUS gastos y SUS líneas de asiento.
  //
  // Cero filas significa a la vez «no existe» y «no es tuya», y las dos
  // devuelven la misma lista vacía.
  const cuenta = await findByIdInScope<{ entity_id: string; gl_account_id: string }>(
    'bank_accounts',
    bankAccountId,
    scope,
    { columns: 'entity_id, gl_account_id' }
  );
  if (!cuenta) return [];
  const entityId = cuenta.entity_id;

  const candidates: Matchable[] = [];

  // LO QUE SE FILTRA Y LO QUE SE COMPARA TIENEN QUE SER LA MISMA COLUMNA.
  //
  // El WHERE seleccionaba por `amount_due` —el SALDO— y el SELECT proyectaba
  // `total_amount` —el TOTAL—, así que el motor recibía un candidato elegido
  // por una cifra y lo comparaba contra otra. Sobre una factura íntegra las dos
  // valen lo mismo y no se notaba nada; sobre una PARCIALMENTE COBRADA no:
  // saldo 500 de un total 1160 entraba en el rango del depósito de 500 y
  // después ninguna regla podía casar 500 contra 1160. Una factura pagada a
  // medias no podía cotejar JAMÁS, que es justo el caso más común de una
  // conciliación de verdad —y el estado 'partially_paid' está aquí mismo, en
  // la lista de estados que esta consulta busca a propósito.
  //
  // Se proyecta el SALDO, que es lo que el banco puede venir a cubrir.
  const invoices = await query<Matchable>(
    `SELECT id, 'invoice' as type, amount_due as amount, invoice_date as date,
            COALESCE(description, invoice_number) as description
     FROM invoices
     WHERE entity_id = $1 AND status IN ('sent', 'partially_paid', 'overdue')
       AND ABS(amount_due) BETWEEN $2 AND $3`,
    [entityId, amountLow, amountHigh]
  );
  candidates.push(...invoices.rows);

  // Mismo defecto y mismo arreglo del lado del gasto: 'partially_paid' también
  // está en la lista de estados, y un pago parcial a proveedor es tan común
  // como un cobro parcial de cliente.
  const bills = await query<Matchable>(
    `SELECT id, 'bill' as type, amount_due as amount, bill_date as date,
            COALESCE(description, bill_number) as description
     FROM bills
     WHERE entity_id = $1 AND status IN ('approved', 'posted', 'partially_paid')
       AND ABS(amount_due) BETWEEN $2 AND $3`,
    [entityId, amountLow, amountHigh]
  );
  candidates.push(...bills.rows);

  // LA PARTIDA DE LIBROS ES LA DE LA CUENTA DE MAYOR DEL BANCO, Y NINGUNA OTRA.
  //
  // Faltaba el filtro por `account_id` y la consulta devolvía CUALQUIER línea
  // posteada sin sellar de la entidad que cayera en la banda de importe: una
  // renta, un sueldo, una línea de CxP. El motor las proponía y F05b —que ya
  // sabe sellar— las sellaba: un depósito de 300 quedaba «explicado» por la
  // renta de oficina de 300 del mismo día, y esa línea se marcaba conciliada
  // contra un banco que nunca la vio. `bank book-item list` nunca la enseña
  // (book-items.ts:136 sí une por `ba.gl_account_id`), así que los dos lados de
  // F05b discrepaban sobre qué es una partida de libros.
  //
  // La 051 le puso índice único a `gl_account_id`: la correspondencia cuenta
  // bancaria ↔ cuenta de mayor es 1:1, así que este filtro es exacto y no una
  // heurística.
  const jelEntries = await query<Matchable>(
    `SELECT jel.id, 'journal_entry_line' as type,
            COALESCE(jel.debit_amount, jel.credit_amount) as amount,
            je.entry_date as date,
            COALESCE(jel.description, je.description) as description
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.is_reconciled = false
       AND jel.account_id = $4
       AND ABS(COALESCE(jel.debit_amount, jel.credit_amount)) BETWEEN $2 AND $3`,
    [entityId, amountLow, amountHigh, cuenta.gl_account_id]
  );
  candidates.push(...jelEntries.rows);

  return candidates;
}

// ============================================================
// MASTER MATCHING ENGINE
// ============================================================

export async function findBestMatch(
  bankAccountId: string,
  transaction: BankTransaction,
  scope: Scope
): Promise<MatchResult | null> {
  const candidates = await getCandidates(bankAccountId, transaction, scope);
  if (candidates.length === 0) return null;

  return evaluarReglas(transaction, candidates);
}

export interface AutoMatchOptions {
  /**
   * El alcance del llamador. OBLIGATORIO, y por eso está en el tipo: el único
   * llamador —POST /v1/bank-accounts/:account_id/auto-match— pasaba
   * `req.params.account_id` crudo y su ruta no lleva `requireEntityAccess`.
   * Con el campo en el tipo, un llamador sin alcance no compila.
   */
  scope: Scope;
  /**
   * La sesión de conciliación a la que pertenecen los cotejos, cuando la hay.
   *
   * Se dejaba en NULL siempre mientras su único lector —GET
   * /reconciliations/:id— filtra por esta columna, así que la sesión mostraba
   * `matches: []` aunque el motor hubiera cotejado el extracto entero. El dato
   * existía y no llegaba a la única pantalla que lo pide.
   */
  sessionId?: string;
}

/**
 * El techo de importe VIGENTE: lo configurado en el panel, apretado por el
 * piso irrompible.
 *
 * La combinación es `Math.min` y vive en `floorMaxAutoAmount` (src/ai/floor.ts),
 * que es la compuerta que ya existía para el auto-posteo. Engancharse a ella en
 * vez de escribir una comparación paralela es la diferencia entre un piso y una
 * costumbre: una compuerta nueva se olvida de subir cuando el piso baja.
 *
 * El '0' del catálogo dice «sin compuerta por importe: decide la confianza», y
 * eso NO es «cero pesos». Sin techo propio, el único techo que queda es el
 * piso, que sigue sin poder subirse. Un valor negativo o ilegible sí cierra
 * la puerta —`floorMaxAutoAmount` devuelve 0 y no se aplica nada—, que es
 * como debe fallar una compuerta que no se entiende.
 */
export function techoDeMontoAuto(configurado: string | number): number {
  const n = typeof configurado === 'number' ? configurado : Number(configurado);
  if (n === 0) return floorMaxAutoAmount(FLOOR_MAX_AUTO_POST);
  return floorMaxAutoAmount(n);
}

/**
 * Las dos compuertas del auto-cotejo, juntas y sin base de datos detrás.
 *
 * Son independientes a propósito: la confianza mide cuánto se parecen dos
 * registros, y el importe mide cuánto cuesta equivocarse. Una transferencia de
 * medio millón que se parece perfectamente a una factura sigue siendo la que
 * cualquiera querría ver con sus propios ojos.
 */
export function puedeAutoAplicarse(
  result: MatchResult,
  txAmount: string,
  umbralConfianza: number,
  techoMonto: number
): boolean {
  // La regla lo dijo primero: sin segunda señal dura, esto se propone y no se
  // aplica. Ningún umbral configurado levanta este veto.
  if (!result.auto_applicable) return false;

  // La confianza NO es dinero —es un DECIMAL(3,2) de dos decimales fijos— y
  // por eso se compara como número. El importe de abajo sí lo es.
  if (!Number.isFinite(umbralConfianza) || result.confidence < umbralConfianza) return false;

  return new Decimal(txAmount).abs().lessThanOrEqualTo(new Decimal(techoMonto.toString()));
}

export async function autoMatchUnreconciled(
  bankAccountId: string,
  opts: AutoMatchOptions
): Promise<{ matched: number; unmatched: number; results: Array<{ transaction_id: string; match: MatchResult | null }> }> {
  // Se exige la cuenta ANTES de tocar nada. getCandidates ya no cruzaría la
  // frontera —devolvería lista vacía—, pero eso daría un 200 con «0 conciliadas»
  // sobre una cuenta ajena, que sigue siendo un oráculo: distingue «no existe»
  // de «existe y está toda conciliada». Aquí las dos dan 404.
  const cuenta = await requireByIdInScope<{ id: string; entity_id: string }>(
    'bank_accounts',
    bankAccountId,
    opts.scope,
    { columns: 'id, entity_id' }
  );

  // LA SESIÓN SE COMPRUEBA ANTES DE ESCRIBIRLA, y se comprueba contra la
  // cuenta y contra la entidad. `reconciliation_sessions` sí tiene entity_id,
  // así que colgar cotejos de una sesión ajena sería meter movimientos de esta
  // cuenta en la conciliación de otro despacho — y la fila no delata de quién
  // era: cero filas significa a la vez «no existe» y «no es tuya».
  if (opts.sessionId) {
    const sesion = await query<{ id: string }>(
      `SELECT id FROM reconciliation_sessions
        WHERE id = $1 AND bank_account_id = $2 AND entity_id = $3`,
      [opts.sessionId, bankAccountId, cuenta.entity_id]
    );
    if (sesion.rows.length === 0) {
      throw new NotFoundError('Reconciliation Session', opts.sessionId);
    }
  }

  // LAS DOS COMPUERTAS SE LEEN UNA VEZ Y ANTES DEL BUCLE. El 0.85 estaba
  // escrito a mano en la comparación de abajo: nadie lo había elegido, no
  // aparecía en ninguna bandera y no se podía cambiar sin recompilar. Ahora es
  // una decisión del panel con su defecto declarado, y el techo por importe es
  // la segunda —independiente de la confianza y sujeta al piso.
  //
  // Las dos fallan CERRADAS ante un valor ilegible —el panel admite respuesta
  // libre— y no vuelven al defecto del catálogo: un umbral que no se entiende
  // deja el extracto entero en manos de un humano, que es el desenlace caro
  // pero no el peligroso.
  const politicaCtx = { tenantId: opts.scope.tenantId, entityId: cuenta.entity_id };
  const umbral = Number((await getPolicy(politicaCtx, 'cotejo_umbral_confianza')).value);
  const techo = techoDeMontoAuto((await getPolicy(politicaCtx, 'cotejo_monto_maximo_auto')).value);

  const unmatched = await query<BankTransaction>(
    `SELECT * FROM bank_transactions WHERE bank_account_id = $1 AND is_matched = false ORDER BY transaction_date`,
    [bankAccountId]
  );

  let matched = 0;
  const results: Array<{ transaction_id: string; match: MatchResult | null }> = [];

  for (const tx of unmatched.rows) {
    const result = await findBestMatch(bankAccountId, tx, opts.scope);
    results.push({ transaction_id: tx.id, match: result });

    if (result && puedeAutoAplicarse(result, tx.amount, umbral, techo)) {
      // LAS DOS ESCRITURAS SON UN SOLO HECHO, Y AHORA CAEN JUNTAS.
      //
      // Eran dos `query()` sueltas, cada una con su propia conexión y su
      // propio COMMIT implícito. Si el INSERT fallaba —un CHECK del enum de
      // tipos, la caída del pool entre una y otra— el UPDATE ya estaba
      // confirmado y el movimiento quedaba `is_matched = true` SIN fila de
      // cotejo: invisible para «no cotejados» porque dice estar cotejado, e
      // invisible para «cotejados» porque no hay match que mostrar. Un
      // movimiento que desaparece de las dos listas no lo encuentra nadie, y
      // period-close.ts lee ese estado como evidencia de cierre.
      await withTransaction(async (client) => {
        // El UPDATE lleva bank_account_id además del id de la fila: la
        // pertenencia de la cuenta ya está probada, así que atarlo a ella deja
        // la escritura acotada por construcción y no por que el SELECT de
        // arriba haya filtrado bien.
        await client.query(
          `UPDATE bank_transactions SET is_matched = true, matched_at = NOW(), confidence_score = $1
            WHERE id = $2 AND bank_account_id = $3`,
          [result.confidence, tx.id, bankAccountId]
        );

        await client.query(
          `INSERT INTO reconciliation_matches (
            id, reconciliation_session_id, bank_transaction_id, match_type,
            matched_entity_type, matched_entity_id, matched_amount, confidence_score
          ) VALUES (uuid_generate_v4(), $1, $2, 'automatic', $3, $4, $5, $6)`,
          [
            opts.sessionId ?? null,
            tx.id,
            result.match_type,
            result.match_id,
            result.matched_amount,
            result.confidence,
          ]
        );
      });

      matched++;
    }
  }

  return { matched, unmatched: unmatched.rows.length - matched, results };
}

export { descriptionSimilarity, jaccardSimilarity, extractKeywords, levenshteinDistance };
