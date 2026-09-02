import Decimal from 'decimal.js';
import { query, currentTenant } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { getPolicy } from '../policy/policy-service.js';
import {
  avisoDeCierreEnRango,
  criterioDeCierreEnInformes,
  predicadoSinCierre,
  type AvisoDeCierre,
} from './criterio-cierre.js';
import { LEDGER_SCALE } from './report-service.js';

// ============================================================
// G1b · EL ESTADO DE FLUJOS DE EFECTIVO (NIF B-2 / ASC 230)
//
// Era el único informe que NO había salido de la ruta REST: vivía entero
// dentro de src/api/rest/routes/reports.ts, así que el CLI no lo tenía y el
// agente tampoco. Sale aquí por la misma razón que salió el criterio del
// cierre: un estado financiero que se calcula en un solo sitio se arregla
// una vez.
//
// Lo que había dentro no era un estado de flujos; era su silueta:
//
//   · `method` se aceptaba, se devolvía en la respuesta y NUNCA cambiaba el
//     cálculo. Quien pidió el método directo recibió el indirecto, rotulado
//     como directo.
//   · El financiamiento era la cadena '0.0000'. No salía de ningún lado: se
//     afirmaba.
//   · Las cuentas por cobrar y por pagar se detectaban con
//     `name ILIKE '%receivable%'` y `'%payable%'` —en INGLÉS— contra el
//     catálogo que este producto siembra en ESPAÑOL («Clientes»,
//     «Proveedores»). No casaba nada: el capital de trabajo salía en cero
//     siempre, y en cero se ve igual que «no cambió».
//   · La inversión salía de la tabla `fixed_assets`, no del mayor: un activo
//     comprado a crédito aparecía como salida de efectivo que nunca ocurrió.
//   · Y nada lo amarraba contra el efectivo real, que es lo peculiar de este
//     documento: es el único estado financiero cuyo error es comprobable
//     desde fuera. Cualquiera lo compara contra el banco.
//
// ── DE DÓNDE SALE QUE ESTO CUADRE ────────────────────────────
//
// La construcción no persigue el efectivo movimiento por movimiento: lo
// DEDUCE de la partida doble. Para cualquier conjunto de asientos
// balanceados, la suma de los movimientos netos de TODAS las cuentas es
// cero, así que
//
//     Δefectivo = − Σ (movimiento neto de las cuentas que NO son efectivo)
//
// De ahí sale la regla que gobierna todo este archivo: el APORTE de una
// cuenta al efectivo es MENOS su movimiento neto en cargo-positivo. Sirve
// igual para un activo (crece la cartera, baja el efectivo), para un pasivo
// (crece el proveedor, sube el efectivo) y para el resultado (el ingreso es
// de saldo acreedor y aporta en positivo). Una sola regla de signo, aplicada
// a cada renglón, en vez de un signo distinto por sección.
//
// Que los asientos estén balanceados no es una esperanza: la 001 lo tiene
// como CHECK de tabla —`status != 'posted' OR total_debits = total_credits`—,
// de modo que la identidad de arriba se apoya en una restricción de la base
// y no en una convención.
//
// La consecuencia útil es que el residuo deja de ser un misterio: si cada
// cuenta que se movió cae en una sección, el estado cuadra por construcción,
// y lo que no cuadra es EXACTAMENTE el movimiento de las cuentas que el motor
// no supo clasificar. Por eso el residuo se imprime con nombre y apellido de
// las cuentas que lo causaron en vez de absorberse en un renglón.
//
// MONEY IS A STRING, como en report-service.ts: Decimal para la aritmética y
// .toFixed(scale) al salir. Ningún importe es un número de JS en ningún punto.
// ============================================================

// ------------------------------------------------------------
// LAS TRES POLÍTICAS
// ------------------------------------------------------------

export type MetodoDeFlujo = 'indirecto' | 'directo';
export type CriterioDeEfectivo = 'rol' | 'subtipo' | 'lista';
export type CriterioDeDescuadre = 'avisar' | 'bloquear' | 'silencio';

export interface PoliticasDeFlujo {
  metodo: MetodoDeFlujo;
  cuentasDeEfectivo: CriterioDeEfectivo;
  descuadre: CriterioDeDescuadre;
}

/**
 * Los valores por omisión se repiten aquí, igual que en criterio-cierre.ts y
 * por el mismo motivo: un informe NO debe morir por no poder leer una
 * política. Si la entidad no resuelve inquilino —una entidad que no existe no
 * tiene flujos que informar— se aplica lo que el panel declara.
 */
const POLITICAS_POR_OMISION: PoliticasDeFlujo = {
  metodo: 'indirecto',
  cuentasDeEfectivo: 'rol',
  descuadre: 'avisar',
};

function comoMetodo(v: string): MetodoDeFlujo {
  return v === 'directo' ? 'directo' : 'indirecto';
}

function comoCriterioDeEfectivo(v: string): CriterioDeEfectivo {
  return v === 'subtipo' || v === 'lista' ? v : 'rol';
}

function comoCriterioDeDescuadre(v: string): CriterioDeDescuadre {
  return v === 'bloquear' || v === 'silencio' ? v : 'avisar';
}

async function inquilinoDe(entityId: string): Promise<string | undefined> {
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return r.rows[0]?.tenant_id;
}

/**
 * El valor efectivo de una política, o el defecto declarado arriba.
 *
 * EL `catch` NO ES DECORATIVO Y NO SOBRA. `getPolicy` no devuelve un defecto
 * cuando la clave no está en `pending-catalog.ts`: LANZA («Policy "x" does
 * not exist in the catalog or in the database»). Las tres claves de este
 * estado todavía no están declaradas en el catálogo, así que sin esto
 * `getCashFlowStatement` revienta para TODA entidad de TODA instalación —el
 * informe entero queda inalcanzable— y encima con un error que habla de
 * catálogos de políticas a quien pidió un estado de flujos.
 *
 * Es además la forma que ya tenía la otra mitad de esta familia:
 * `cash-flow-reconcile.ts` envuelve su lectura en el mismo `try`. Que las dos
 * mitades de un mismo informe fallaran distinto ante la misma fila ausente
 * —una devolviendo su defecto y la otra muriendo— es precisamente cómo se
 * acaba con dos estados de flujos del mismo periodo.
 *
 * Lo que este catch NO hace es tapar la ausencia: la fila sigue faltando en
 * el panel y `mnemosine pending` no puede preguntarla. Lo que hace es que la
 * falta de una decisión no borre el informe.
 */
/**
 * La clave literal viaja DENTRO de la llamada a getPolicy, no como parámetro
 * de este envoltorio: el criterio E1.3 comprueba que toda política del panel
 * tenga un lector REAL, y lo comprueba viendo la clave junto a su lectura. Un
 * envoltorio que recibe `key: string` lee igual de bien y es INVISIBLE para
 * ese criterio — y una política que el instrumento no ve leída es, para el
 * tablero, una que nadie lee. Pasando el thunk se conserva el try/catch
 * compartido y la clave queda donde el criterio la busca.
 */
async function conDefecto(
  leer: () => Promise<{ value: string }>,
  porOmision: string
): Promise<string> {
  try {
    return (await leer()).value;
  } catch {
    return porOmision;
  }
}

/** Las tres decisiones del panel que gobiernan este estado, ya resueltas. */
export async function politicasDeFlujo(entityId: string): Promise<PoliticasDeFlujo> {
  const tenantId = currentTenant() ?? (await inquilinoDe(entityId));
  if (!tenantId) return POLITICAS_POR_OMISION;
  const ctx = { tenantId, entityId };
  const [metodo, efectivo, descuadre] = await Promise.all([
    conDefecto(() => getPolicy(ctx, 'flujo_efectivo_metodo'), POLITICAS_POR_OMISION.metodo),
    conDefecto(() => getPolicy(ctx, 'flujo_efectivo_cuentas_de_efectivo'), POLITICAS_POR_OMISION.cuentasDeEfectivo),
    conDefecto(() => getPolicy(ctx, 'flujo_efectivo_descuadre'), POLITICAS_POR_OMISION.descuadre),
  ]);
  return {
    metodo: comoMetodo(metodo),
    cuentasDeEfectivo: comoCriterioDeEfectivo(efectivo),
    descuadre: comoCriterioDeDescuadre(descuadre),
  };
}

// ------------------------------------------------------------
// QUÉ CUENTAS SON EFECTIVO
// ------------------------------------------------------------

export interface CuentaDeEfectivo {
  id: string;
  code: string;
  name: string;
}

/**
 * Subtipos que declaran efectivo de manera explícita. La siembra de esta casa
 * no usa ninguno —todo el circulante nace como 'current_asset'—, así que el
 * criterio 'subtipo' sólo sirve sobre un catálogo importado que sí los traiga.
 * Cuando no encuentra nada, el motor FALLA en vez de devolver un estado sin
 * efectivo, que es la manera elegante de mentir.
 */
const SUBTIPOS_DE_EFECTIVO = [
  'cash',
  'cash_equivalent',
  'cash_and_equivalents',
  'bank',
  'efectivo',
  'equivalentes_de_efectivo',
];

/**
 * EL ARREGLO DEL DEFECTO DE LOS NOMBRES.
 *
 * El motor viejo preguntaba `name ILIKE '%receivable%'`. Aquí se pregunta por
 * el MAPA DE ROLES, que es la capa semántica que esta casa ya usa en todo el
 * posteo automático y que sobrevive a renombres, traducciones y catálogos
 * importados — que es exactamente lo que un nombre no hace.
 *
 * Dos fuentes, unidas, porque el efectivo entra al mayor por dos puertas y
 * `ar-ap-posting.ts` lo dice en su propia firma («the linked bank account's
 * gl_account_id, else the banco role»):
 *
 *   · el rol `banco`, y
 *   · toda cuenta de mayor atada a una `bank_accounts` de la entidad.
 *
 * Y el ÁRBOL, no la cuenta suelta: el rol `banco` apunta a 1110 «Caja y
 * Bancos», que en el catálogo base es la MADRE de 1111, 1112 y 1115, donde de
 * verdad caen los cargos y abonos. Resolver sólo la cuenta del rol dejaba el
 * conjunto de efectivo vacío de movimiento y mandaba el estado entero al
 * residuo.
 */
export async function resolverCuentasDeEfectivo(
  entityId: string,
  criterio: CriterioDeEfectivo
): Promise<CuentaDeEfectivo[]> {
  if (criterio === 'lista') {
    // FALLA CERRADO: no hay dónde guardar la lista todavía. Declararla exige
    // la columna `cash_flow_category` en accounts, que es migración y es la
    // fase 2 del catálogo (`cashflow category set`). Aceptar 'lista' hoy sería
    // silenciosamente el criterio por rol con otro nombre.
    throw new ValidationError(
      'La política `flujo_efectivo_cuentas_de_efectivo` dice «lista», y esta versión no tiene ' +
        'dónde guardar esa lista: declarar cuentas de efectivo una por una necesita ' +
        '`mnemosine cashflow category set`, que todavía no existe. Resuelve la política como ' +
        '«rol» (el mapa de roles) o «subtipo» mientras tanto — no se emite un estado por rol ' +
        'llamándolo lista.'
    );
  }

  const rows =
    criterio === 'subtipo'
      ? await query<CuentaDeEfectivo>(
          `SELECT a.id, a.code, a.name
             FROM accounts a
            WHERE a.entity_id = $1 AND a.account_subtype = ANY($2::text[])
            ORDER BY a.code`,
          [entityId, SUBTIPOS_DE_EFECTIVO]
        )
      : await query<CuentaDeEfectivo>(
          // El árbol se recorre con una recursiva y la frontera de entidad va
          // DENTRO, en cada brazo: una cuenta hija de otra entidad no entra al
          // conjunto de efectivo de ésta ni por el paso recursivo.
          `WITH RECURSIVE raices AS (
             SELECT a.id
               FROM account_roles ar
               JOIN accounts a ON a.id = ar.account_id AND a.entity_id = $1
              WHERE ar.entity_id = $1 AND ar.role = 'banco'
              UNION
             SELECT a.id
               FROM bank_accounts b
               JOIN accounts a ON a.id = b.gl_account_id AND a.entity_id = $1
              WHERE b.entity_id = $1
           ),
           arbol AS (
             SELECT id FROM raices
              UNION
             SELECT h.id FROM accounts h JOIN arbol t ON h.parent_id = t.id
              WHERE h.entity_id = $1
           )
           SELECT a.id, a.code, a.name
             FROM accounts a JOIN arbol ON arbol.id = a.id
            ORDER BY a.code`,
          [entityId]
        );

  if (rows.rows.length === 0) {
    // También cerrado. Sin cuentas de efectivo no hay contra qué amarrar el
    // estado, y un estado de flujos que no se amarra es justo el defecto que
    // este archivo vino a matar.
    throw new ValidationError(
      criterio === 'subtipo'
        ? 'Ninguna cuenta de esta entidad declara un subtipo de efectivo ' +
          `(${SUBTIPOS_DE_EFECTIVO.join(', ')}), así que no hay contra qué cuadrar el estado de ` +
          'flujos. Cambia `flujo_efectivo_cuentas_de_efectivo` a «rol» o marca el subtipo en el catálogo.'
        : 'Esta entidad no tiene efectivo identificable: el rol `banco` no está mapeado y ninguna ' +
          'cuenta bancaria apunta a una cuenta de mayor. Mapea el rol con ' +
          '`mnemosine account role set banco <código>` (o ata la cuenta bancaria a su cuenta de ' +
          'mayor) — sin eso, el estado de flujos no se puede contrastar contra el banco.'
    );
  }
  return rows.rows;
}

// ------------------------------------------------------------
// EL MOVIMIENTO DEL PERIODO, CUENTA POR CUENTA
// ------------------------------------------------------------

export interface MovimientoDeCuenta {
  account_id: string;
  code: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  fs_category: string | null;
  debit_total: string;
  credit_total: string;
}

/** Movimiento neto en CARGO-POSITIVO: cargos − abonos. */
export function netoDe(m: Pick<MovimientoDeCuenta, 'debit_total' | 'credit_total'>): Decimal {
  return new Decimal(m.debit_total).minus(new Decimal(m.credit_total));
}

/**
 * El movimiento de cada cuenta que NO es efectivo.
 *
 * El par (jel JOIN je) entre paréntesis es el de siempre y es load-bearing:
 * encadenar dos JOIN sueltos deja pasar líneas de asientos en borrador.
 *
 * El filtro del cierre es el MISMO que el estado de resultados —lo resuelve
 * criterio-cierre.ts, no este archivo—, y tiene que serlo: la primera línea
 * del método indirecto es la utilidad neta, y si aquí se contara el asiento
 * de cierre y allá no, el flujo arrancaría de una utilidad que el estado de
 * resultados no publica. Da igual para el amarre contra el banco: el asiento
 * de cierre mueve resultados contra capital y no toca el efectivo, así que
 * contarlo o no contarlo no cambia el Δefectivo del periodo.
 */
export async function queryMovimientosNoEfectivo(
  entityId: string,
  opts: { startDate: string; endDate: string; cashAccountIds: string[] }
): Promise<MovimientoDeCuenta[]> {
  const criterio = await criterioDeCierreEnInformes(entityId);
  const closingFilter = criterio.enEstadoDeResultados ? '' : predicadoSinCierre();

  const r = await query<MovimientoDeCuenta>(
    `SELECT a.id AS account_id, a.code, a.name,
            a.account_type, a.account_subtype, a.fs_category,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0)::text AS debit_total,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0)::text AS credit_total
       FROM accounts a
       JOIN (journal_entry_lines jel
             JOIN journal_entries je
               ON je.id = jel.journal_entry_id
              AND je.status = 'posted'
              AND je.entry_date BETWEEN $2 AND $3
              ${closingFilter})
         ON jel.account_id = a.id
      WHERE a.entity_id = $1
        AND NOT (a.id = ANY($4::uuid[]))
      GROUP BY a.id, a.code, a.name, a.account_type, a.account_subtype, a.fs_category
     HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) <> 0
         OR COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) <> 0
      ORDER BY a.code`,
    [entityId, opts.startDate, opts.endDate, opts.cashAccountIds]
  );
  return r.rows;
}

// ------------------------------------------------------------
// LA CLASIFICACIÓN
// ------------------------------------------------------------

/**
 * Dónde cae el movimiento de una cuenta dentro del estado.
 *
 * `resultado` y `no_monetario` y `capital_de_trabajo` son las tres piezas de
 * la sección de operación por el método indirecto: utilidad, partidas que no
 * movieron dinero, y el cambio en el capital de trabajo.
 */
export type RenglonDeFlujo =
  | 'resultado'
  | 'no_monetario'
  | 'capital_de_trabajo'
  | 'inversion'
  | 'financiamiento'
  | 'sin_clasificar';

/**
 * La clasificación se hace por COLUMNAS ESTRUCTURALES, nunca por el nombre.
 *
 * `account_type` y `fs_category` son dos enumeraciones con CHECK en la 001:
 * su dominio está cerrado por la base y no depende del idioma del catálogo,
 * de quién lo importó ni de cómo se llamen las cuentas hoy. Ése es todo el
 * argumento contra el `ILIKE '%receivable%'` que había aquí: no es que el
 * inglés estuviera mal, es que el nombre no es un dato del que se pueda
 * deducir nada.
 *
 * El orden de las reglas importa:
 *
 *  1. Ingreso y gasto COMPONEN la utilidad neta, que es el primer renglón del
 *     método indirecto.
 *  2. Un contra-activo (depreciación acumulada, estimación de incobrables) es
 *     una valuación: mueve el balance sin mover un peso. Va como partida no
 *     monetaria ANTES de mirar su categoría, porque la depreciación acumulada
 *     vive en `non_current_assets` y por categoría caería en inversión, donde
 *     fingiría una entrada de efectivo por la depreciación del año.
 *  3. Capital y deuda de largo plazo son financiamiento.
 *  4. El activo no circulante es inversión.
 *  5. El circulante —de los dos lados— es capital de trabajo.
 *
 * Lo que no encaja NO se acomoda: cae en `sin_clasificar`, que es el renglón
 * que después aparece con nombre en el residuo. Una cuenta sin `fs_category`
 * (la columna es nullable) es el caso típico, y adivinarle la sección sería
 * volver a inventar.
 */
export function clasificarCuenta(
  c: Pick<MovimientoDeCuenta, 'account_type' | 'fs_category'>
): RenglonDeFlujo {
  if (c.account_type === 'revenue' || c.account_type === 'expense') return 'resultado';
  if (c.account_type === 'contra_asset') return 'no_monetario';
  if (c.account_type === 'equity' || c.account_type === 'contra_equity') return 'financiamiento';
  switch (c.fs_category) {
    case 'long_term_liabilities':
      return 'financiamiento';
    case 'non_current_assets':
      return 'inversion';
    case 'current_assets':
    case 'current_liabilities':
    // `tax` es categoría de impuestos por pagar o a favor: capital de trabajo,
    // no una sección propia. El impuesto que es GASTO ya salió en la regla 1.
    case 'tax':
      return 'capital_de_trabajo';
    default:
      return 'sin_clasificar';
  }
}

// ------------------------------------------------------------
// LAS OPERACIONES QUE NO MOVIERON EFECTIVO
// ------------------------------------------------------------

export interface LineaSinEfectivo {
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  account_id: string;
  code: string;
  name: string;
  debit_total: string;
  credit_total: string;
}

export interface OperacionSinEfectivo {
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  /** Lo que habría entrado a inversión o financiamiento de no excluirse. */
  amount: string;
  accounts: Array<{ code: string; name: string; renglon: RenglonDeFlujo; neto: string }>;
}

/**
 * LOS ASIENTOS QUE TOCAN INVERSIÓN O FINANCIAMIENTO SIN TOCAR EFECTIVO.
 *
 * Éste es el arreglo del cuarto defecto, y es la razón de que la inversión
 * salga del MAYOR y no de la tabla `fixed_assets`. Un activo comprado a
 * crédito —DR activo fijo / CR proveedores— no movió un peso: presentarlo
 * como salida de efectivo es inventar una salida, y presentarlo como salida
 * compensada con un aumento de proveedores en operación infla dos secciones a
 * la vez. NIF B-2 y ASC 230 dicen lo mismo: las operaciones de inversión y
 * financiamiento que no movieron efectivo se EXCLUYEN del estado y se
 * REVELAN aparte. Eso es exactamente lo que hace esta consulta.
 *
 * Sacarlas no rompe el amarre: un asiento está balanceado por CHECK de tabla,
 * así que la suma de sus aportes es cero y quitarlo entero deja el Δefectivo
 * intacto. Sólo se quitan los que tocan inversión o financiamiento; los que
 * se quedan dentro de operación —la depreciación del mes, un devengo, una
 * reclasificación— se quedan donde están, porque ahí se cancelan solos: la
 * depreciación baja la utilidad y la partida no monetaria la devuelve.
 *
 * `inversionOFinanciamientoIds` lo calcula el clasificador de arriba y viaja
 * como parámetro: la regla de clasificación existe UNA vez, en TypeScript, y
 * no se reescribe en SQL para que las dos puedan discrepar.
 */
export async function queryOperacionesSinEfectivo(
  entityId: string,
  opts: {
    startDate: string;
    endDate: string;
    cashAccountIds: string[];
    inversionOFinanciamientoIds: string[];
  }
): Promise<LineaSinEfectivo[]> {
  if (opts.inversionOFinanciamientoIds.length === 0) return [];
  const criterio = await criterioDeCierreEnInformes(entityId);
  const closingFilter = criterio.enEstadoDeResultados ? '' : predicadoSinCierre();

  const r = await query<LineaSinEfectivo>(
    `SELECT jel.journal_entry_id AS entry_id, je.entry_number,
            je.entry_date::text AS entry_date, je.description,
            a.id AS account_id, a.code, a.name,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0)::text AS debit_total,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0)::text AS credit_total
       FROM accounts a
       JOIN (journal_entry_lines jel
             JOIN journal_entries je
               ON je.id = jel.journal_entry_id
              AND je.status = 'posted'
              AND je.entry_date BETWEEN $2 AND $3
              ${closingFilter})
         ON jel.account_id = a.id
      WHERE a.entity_id = $1
        AND EXISTS (SELECT 1 FROM journal_entry_lines t
                     WHERE t.journal_entry_id = jel.journal_entry_id
                       AND t.account_id = ANY($4::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM journal_entry_lines c
                         WHERE c.journal_entry_id = jel.journal_entry_id
                           AND c.account_id = ANY($5::uuid[]))
      GROUP BY jel.journal_entry_id, je.entry_number, je.entry_date, je.description,
               a.id, a.code, a.name
      ORDER BY je.entry_date, je.entry_number, a.code`,
    [
      entityId,
      opts.startDate,
      opts.endDate,
      opts.inversionOFinanciamientoIds,
      opts.cashAccountIds,
    ]
  );
  return r.rows;
}

/**
 * Descuenta del movimiento por cuenta lo que aportaron esos asientos, y arma
 * la revelación. Es pura: la aritmética se prueba sin base de datos.
 */
export function descontarOperacionesSinEfectivo(
  movimientos: MovimientoDeCuenta[],
  lineas: LineaSinEfectivo[],
  scale: number = LEDGER_SCALE
): { movimientos: MovimientoDeCuenta[]; operaciones: OperacionSinEfectivo[] } {
  if (lineas.length === 0) return { movimientos, operaciones: [] };

  const porCuenta = new Map<string, Decimal>();
  const porAsiento = new Map<string, OperacionSinEfectivo>();
  const indice = new Map(movimientos.map((m) => [m.account_id, m]));

  for (const l of lineas) {
    const neto = netoDe(l);
    porCuenta.set(l.account_id, (porCuenta.get(l.account_id) ?? new Decimal(0)).plus(neto));

    let op = porAsiento.get(l.entry_id);
    if (!op) {
      op = {
        entry_id: l.entry_id,
        entry_number: l.entry_number,
        entry_date: l.entry_date,
        description: l.description,
        amount: new Decimal(0).toFixed(scale),
        accounts: [],
      };
      porAsiento.set(l.entry_id, op);
    }
    const movimiento = indice.get(l.account_id);
    const renglon = movimiento
      ? clasificarCuenta(movimiento)
      : /* la cuenta no vino en el movimiento del periodo: no se le inventa sección */
        'sin_clasificar';
    op.accounts.push({ code: l.code, name: l.name, renglon, neto: neto.toFixed(scale) });
    if (renglon === 'inversion' || renglon === 'financiamiento') {
      op.amount = new Decimal(op.amount).plus(neto.abs()).toFixed(scale);
    }
  }

  const ajustados = movimientos.map((m) => {
    const quitar = porCuenta.get(m.account_id);
    if (!quitar) return m;
    // Se descuenta sobre el NETO, no sobre cargos y abonos por separado: lo
    // que importa para el flujo es el neto, y repartir el descuento entre las
    // dos columnas exigiría decidir cuál de las dos se toca.
    const neto = netoDe(m).minus(quitar);
    return {
      ...m,
      debit_total: neto.isPositive() ? neto.toFixed(scale) : new Decimal(0).toFixed(scale),
      credit_total: neto.isNegative() ? neto.negated().toFixed(scale) : new Decimal(0).toFixed(scale),
    };
  });

  return { movimientos: ajustados, operaciones: [...porAsiento.values()] };
}

// ------------------------------------------------------------
// EL MÉTODO INDIRECTO
// ------------------------------------------------------------

export interface LineaDeFlujo {
  account_id: string;
  code: string;
  name: string;
  renglon: RenglonDeFlujo;
  /** Movimiento neto de la cuenta, cargo-positivo. */
  neto: string;
  /** Lo que ese movimiento aportó al efectivo: −neto. */
  amount: string;
}

export interface SeccionDeFlujo {
  total: string;
  lines: LineaDeFlujo[];
}

/**
 * LOS NOMBRES DE LAS TRES SECCIONES SON LOS QUE LA RUTA YA PUBLICABA.
 *
 * `operating_activities` / `investing_activities` / `financing_activities` no
 * son una elección estética: son el juego de claves que /v1/reports/cash-flow
 * lleva publicando desde siempre, y también la forma que `cash-flow-reconcile`
 * declara necesitar del estado (`FlujoDerivado`). Conservarlos deja el
 * contrato HTTP intacto y hace que el amarre consuma este estado sin una capa
 * de traducción en medio. Lo que cambia bajo esas claves son los NÚMEROS, que
 * es lo que había que arreglar.
 */
export interface FlujoIndirecto {
  net_income: string;
  operating_activities: {
    net_income: string;
    non_cash: SeccionDeFlujo;
    working_capital: SeccionDeFlujo;
    total: string;
  };
  investing_activities: SeccionDeFlujo;
  financing_activities: SeccionDeFlujo;
  /** Lo que el motor no supo clasificar. NO entra en `net_cash_flow`. */
  unclassified: SeccionDeFlujo;
  /** Operación + inversión + financiamiento. Lo que el estado publica. */
  net_cash_flow: string;
}

function seccion(lineas: LineaDeFlujo[], scale: number): SeccionDeFlujo {
  const total = lineas.reduce((s, l) => s.plus(new Decimal(l.amount)), new Decimal(0));
  return { total: total.toFixed(scale), lines: lineas };
}

/**
 * La aritmética del método indirecto, entera y sin base de datos.
 *
 *   utilidad neta
 *   + partidas que no movieron efectivo
 *   ± cambio en el capital de trabajo
 *   = flujo de operación
 *
 * La utilidad neta es −Σ(neto de las cuentas de resultado): el ingreso es de
 * saldo acreedor —su neto cargo-positivo es negativo— y el gasto de saldo
 * deudor, así que la misma resta produce ingresos − gastos sin un signo
 * especial para cada sección.
 */
export function construirIndirecto(
  movimientos: MovimientoDeCuenta[],
  scale: number = LEDGER_SCALE
): FlujoIndirecto {
  const cubos: Record<RenglonDeFlujo, LineaDeFlujo[]> = {
    resultado: [],
    no_monetario: [],
    capital_de_trabajo: [],
    inversion: [],
    financiamiento: [],
    sin_clasificar: [],
  };

  for (const m of movimientos) {
    const neto = netoDe(m);
    // Una cuenta que se movió y volvió a su sitio no aporta nada al efectivo;
    // imprimirla en cero sólo alarga el estado.
    if (neto.isZero()) continue;
    const renglon = clasificarCuenta(m);
    cubos[renglon].push({
      account_id: m.account_id,
      code: m.code,
      name: m.name,
      renglon,
      neto: neto.toFixed(scale),
      amount: neto.negated().toFixed(scale),
    });
  }

  const netIncome = cubos.resultado
    .reduce((s, l) => s.plus(new Decimal(l.amount)), new Decimal(0))
    .toFixed(scale);
  const nonCash = seccion(cubos.no_monetario, scale);
  const workingCapital = seccion(cubos.capital_de_trabajo, scale);
  const investing = seccion(cubos.inversion, scale);
  const financing = seccion(cubos.financiamiento, scale);
  const unclassified = seccion(cubos.sin_clasificar, scale);

  const operatingTotal = new Decimal(netIncome)
    .plus(new Decimal(nonCash.total))
    .plus(new Decimal(workingCapital.total));

  return {
    net_income: netIncome,
    operating_activities: {
      net_income: netIncome,
      non_cash: nonCash,
      working_capital: workingCapital,
      total: operatingTotal.toFixed(scale),
    },
    investing_activities: investing,
    financing_activities: financing,
    unclassified,
    net_cash_flow: operatingTotal
      .plus(new Decimal(investing.total))
      .plus(new Decimal(financing.total))
      .toFixed(scale),
  };
}

// ------------------------------------------------------------
// DÓNDE ESTÁ EL AMARRE CONTRA EL EFECTIVO REAL
// ------------------------------------------------------------
//
// NO está aquí, y es deliberado. El contraste contra la variación real de
// caja y bancos vive entero en `cash-flow-reconcile.ts`, que recibe el neto
// derivado como parámetro y no construye estado alguno. Este archivo es la
// simetría de esa decisión: construye el estado y no vuelve a calcular el
// efectivo real. Dos módulos, una implementación de cada cosa — que es la
// regla de la casa que este informe llevaba años incumpliendo.
//
// Lo que sí se queda aquí es lo que este motor sabe de su propio descuadre
// sin preguntarle nada a nadie: las cuentas que NO supo clasificar. Por la
// identidad de la partida doble ése es, peso por peso, el hueco entre el
// estado y el efectivo, y se calcula con los datos que la construcción ya
// tiene en la mano. `unclassified` es esa lista.

export interface AutoComprobacion {
  /** Suma de lo que aportaron las cuentas sin sección. */
  unclassified_total: string;
  /** Las cuentas que lo causan, con nombre. */
  candidates: LineaDeFlujo[];
  /** true cuando toda cuenta que se movió cayó en una sección. */
  ties: boolean;
  note: string;
}

/**
 * Lo que el estado puede afirmar sobre sí mismo sin volver a la base.
 *
 * Si esto dice `ties: true`, el estado cuadra contra el efectivo POR
 * CONSTRUCCIÓN —la identidad de la partida doble no deja otra opción—, y el
 * amarre de `cash-flow-reconcile` lo confirmará contra el mayor. Si dice
 * `false`, ya se sabe el importe del hueco y las cuentas que lo abren, antes
 * de que nadie compare nada contra el banco.
 */
export function autoComprobar(
  flujo: FlujoIndirecto,
  scale: number = LEDGER_SCALE
): AutoComprobacion {
  const total = new Decimal(flujo.unclassified.total);
  const cuadra = total.isZero();
  return {
    unclassified_total: total.toFixed(scale),
    candidates: flujo.unclassified.lines,
    ties: cuadra,
    note: cuadra
      ? 'Every account that moved was classified into a section, so the statement ties to cash by construction.'
      : `${flujo.unclassified.lines.length} account(s) moved ${total.toFixed(scale)} without falling ` +
        'into any section: the statement cannot tie to cash by that amount until they are classified.',
  };
}


// ------------------------------------------------------------
// EL ESTADO, ARMADO
// ------------------------------------------------------------

export interface CashFlowStatement extends FlujoIndirecto {
  entity_id: string;
  start_date: string;
  end_date: string;
  /** Sólo 'indirect': el directo falla cerrado. Ya no se rotula lo que no es. */
  method: 'indirect';
  policies: PoliticasDeFlujo;
  /** Operaciones de inversión o financiamiento que no movieron efectivo. */
  non_cash_transactions: OperacionSinEfectivo[];
  /** Las cuentas de efectivo contra las que este estado se puede amarrar. */
  cash_accounts: CuentaDeEfectivo[];
  /**
   * Lo que el motor sabe de su propio descuadre. Ausente bajo la política
   * «silencio», que es la que pide publicar el neto sin contrastarlo.
   */
  self_check?: AutoComprobacion;
  /** Presente sólo cuando el rango contiene el cierre del ejercicio. */
  closing?: AvisoDeCierre;
}

export interface CashFlowOptions {
  startDate: string;
  endDate: string;
  scale?: number;
  /**
   * Fuerza el método por encima de la política, para el `--method` del CLI.
   * No cambia el hecho de que el directo no es construible: lo hace fallar
   * antes y con el mismo argumento.
   */
  metodo?: MetodoDeFlujo;
}

/**
 * POR QUÉ EL MÉTODO DIRECTO FALLA CERRADO Y NO SE APROXIMA.
 *
 * El método directo presenta cobros y pagos BRUTOS por concepto: cobrado a
 * clientes, pagado a proveedores, pagado a empleados, impuestos pagados. Ese
 * dato no está en estos libros, y no por un hueco que se pueda rellenar con
 * una consulta más lista:
 *
 *  · El concepto es de la OPERACIÓN, no de la cuenta. Al pagar una factura
 *    —DR proveedores, DR IVA acreditable, CR banco— todo el dinero se fue al
 *    proveedor; repartir el pago entre sus contrapartidas reportaría la parte
 *    del IVA como «impuestos pagados al fisco», que es falso: ese IVA se le
 *    pagó al proveedor.
 *  · Un asiento con una línea de efectivo y varias contrapartidas no trae
 *    ninguna regla de reparto. Prorratear sería inventarla.
 *  · Nada clasifica un movimiento de efectivo por concepto en el momento de
 *    registrarlo, que es cuando se sabe. La fase 2 del catálogo
 *    (`cashflow category set`, columna `cash_flow_category`) clasifica
 *    CUENTAS, no movimientos, así que ni siquiera eso alcanzaría solo.
 *
 * Devolver el indirecto rotulado como directo es lo que hacía el motor viejo,
 * y es peor que no tenerlo: un estado equivocado que nadie sospecha. Así que
 * se falla, diciendo qué falta.
 */
function rechazarMetodoDirecto(): never {
  throw new ValidationError(
    'El método directo no se puede construir con estos datos, y no se devuelve el indirecto ' +
      'rotulado como directo —que es justo el defecto que este motor vino a corregir—. ' +
      'El directo exige cobros y pagos brutos POR CONCEPTO (clientes, proveedores, empleados, ' +
      'impuestos), y el concepto es de la operación, no de la cuenta: al pagar una factura con ' +
      'IVA, todo el efectivo se fue al proveedor, y repartir el pago entre sus contrapartidas ' +
      'reportaría el IVA como impuesto pagado al fisco. Falta una clasificación por concepto de ' +
      'cada movimiento de efectivo en el momento de registrarlo. Mientras no exista, resuelve ' +
      '`flujo_efectivo_metodo` como «indirecto».'
  );
}

/**
 * El estado de flujos de efectivo del periodo.
 *
 * Es la única implementación: la ruta REST, el CLI y el agente entran por
 * aquí. Ésa es la mitad del arreglo — la otra mitad es que los números sean
 * ciertos. Su forma satisface `FlujoDerivado`, así que
 * `conciliarFlujoDeEfectivo` lo amarra contra el mayor sin traducción.
 */
export async function getCashFlowStatement(
  entityId: string,
  opts: CashFlowOptions
): Promise<CashFlowStatement> {
  const scale = opts.scale ?? LEDGER_SCALE;
  const policies = await politicasDeFlujo(entityId);
  const metodo = opts.metodo ?? policies.metodo;
  if (metodo === 'directo') rechazarMetodoDirecto();

  const cuentas = await resolverCuentasDeEfectivo(entityId, policies.cuentasDeEfectivo);
  const cashAccountIds = cuentas.map((c) => c.id);

  const brutos = await queryMovimientosNoEfectivo(entityId, {
    startDate: opts.startDate,
    endDate: opts.endDate,
    cashAccountIds,
  });

  // Los ids que el clasificador —no el SQL— considera inversión o
  // financiamiento. Van como parámetro a la consulta siguiente para que la
  // regla siga viviendo en un solo sitio.
  const inversionOFinanciamientoIds = brutos
    .filter((m) => {
      const r = clasificarCuenta(m);
      return r === 'inversion' || r === 'financiamiento';
    })
    .map((m) => m.account_id);

  const lineasSinEfectivo = await queryOperacionesSinEfectivo(entityId, {
    startDate: opts.startDate,
    endDate: opts.endDate,
    cashAccountIds,
    inversionOFinanciamientoIds,
  });

  const { movimientos, operaciones } = descontarOperacionesSinEfectivo(
    brutos,
    lineasSinEfectivo,
    scale
  );

  const flujo = construirIndirecto(movimientos, scale);
  const autoComprobacion = autoComprobar(flujo, scale);

  const closing = await avisoDeCierreEnRango(
    entityId,
    { sinceDate: opts.startDate, untilDate: opts.endDate },
    // El flujo hereda el criterio del ESTADO DE RESULTADOS y no el de la
    // balanza: su primer renglón es la utilidad neta, y las dos cifras tienen
    // que salir del mismo conjunto de asientos.
    'income-statement'
  );

  // «bloquear»: el estado NO se emite si el motor no pudo clasificar todo lo
  // que se movió. Es la opción del panel para quien prefiere no tener
  // documento a tener uno que no ata. Se comprueba con lo que este motor sabe
  // por sí solo —las cuentas sin sección—, no con una segunda lectura del
  // efectivo: el contraste contra el mayor lo hace `cash-flow-reconcile`, y
  // duplicarlo aquí daría dos respuestas a la misma pregunta.
  if (!autoComprobacion.ties && policies.descuadre === 'bloquear') {
    const culpables = autoComprobacion.candidates
      .map((c) => `${c.code} ${c.name} (${c.amount})`)
      .join('; ');
    throw new ValidationError(
      `El estado de flujos no puede cuadrar: ${autoComprobacion.candidates.length} cuenta(s) se ` +
        `movieron ${autoComprobacion.unclassified_total} sin caer en ninguna sección, y la ` +
        'política `flujo_efectivo_descuadre` dice «bloquear». Las cuentas: ' +
        `${culpables || '—'}. Dales una fs_category en el catálogo, o cambia la política a ` +
        '«avisar» para emitirlo con la diferencia declarada.'
    );
  }

  return {
    entity_id: entityId,
    start_date: opts.startDate,
    end_date: opts.endDate,
    method: 'indirect',
    policies,
    ...flujo,
    non_cash_transactions: operaciones,
    cash_accounts: cuentas,
    // «silencio» publica el neto calculado sin contrastarlo. Se omite la
    // auto-comprobación entera en vez de publicarla con el hueco escondido:
    // un cero que no se calculó es peor que un dato ausente.
    ...(policies.descuadre === 'silencio' ? {} : { self_check: autoComprobacion }),
    ...(closing ? { closing } : {}),
  };
}
