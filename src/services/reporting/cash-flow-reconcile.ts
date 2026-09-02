import Decimal from 'decimal.js';
import { query, currentTenant } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { getPolicy } from '../policy/policy-service.js';
import { LEDGER_SCALE } from './report-service.js';

// ============================================================
// G1b · EL AMARRE DEL FLUJO DE EFECTIVO CONTRA EL EFECTIVO REAL
//
// El estado de flujos es el ÚNICO estado financiero cuyo error es
// comprobable desde fuera: cualquiera lo compara contra su banco. Y hasta
// hoy nada lo comparaba — la ruta REST publicaba un neto derivado que
// podía no tener ninguna relación con la variación de caja y bancos, y
// nadie lo decía.
//
// Este módulo contesta una sola pregunta y la contesta con dos cifras
// independientes:
//
//   DERIVADO — el neto del estado (operación + inversión + financiamiento),
//   que llega como parámetro. Este módulo NO lo construye: duplicar la
//   construcción daría dos estados de flujos, que es exactamente lo que
//   `report-service` existe para evitar.
//
//   REAL — la variación de caja y bancos entre el inicio y el fin del
//   periodo, tomada del MAYOR. No de `bank_accounts`, no de los extractos
//   bancarios, no de las conciliaciones: del libro. El extracto es lo que
//   el banco dice; el estado de flujos afirma algo sobre los LIBROS, y
//   contrastarlo contra el extracto mezclaría dos discrepancias distintas
//   (la del estado contra sus propios libros, y la de los libros contra el
//   banco — que es lo que concilia `bank reconcile`).
//
// La diferencia es EL RESIDUO, y el residuo se imprime. Jamás se mete
// dentro de un renglón: absorberlo esconde justo lo que el lector habría
// cazado comparando contra su banco, y deja el documento con aspecto de
// cuadrado. Un estado que no amarra y lo dice sigue siendo utilizable; uno
// que no amarra y se calla es el que alguien firma.
// ============================================================

/**
 * Los roles de `account_roles` que significan «esto es efectivo».
 *
 * Hoy la taxonomía sólo tiene `banco`, que el catálogo base apunta a 1110
 * «Caja y Bancos». Se declara como lista y no como constante suelta porque
 * el día que la taxonomía separe caja de bancos —o añada inversiones
 * temporales— el conjunto crece aquí y en ningún otro sitio.
 */
export const ROLES_DE_EFECTIVO = ['banco'] as const;

/**
 * Subtipos que se aceptan como efectivo cuando la política pide `subtipo`.
 *
 * `current_asset` NO está y no puede estar: es el subtipo de clientes,
 * inventarios e IVA acreditable en el catálogo que este producto siembra, y
 * meterlo declararía como efectivo medio activo circulante.
 */
const SUBTIPOS_DE_EFECTIVO = ['cash', 'cash_equivalent', 'bank'] as const;

export type CriterioDeEfectivo = 'rol' | 'subtipo' | 'lista';

export type PoliticaDeDescuadre = 'avisar' | 'bloquear' | 'silencio';

/** Cómo entró una cuenta al conjunto de efectivo. */
export type ViaDeEfectivo = 'rol' | 'cuenta_bancaria' | 'descendiente' | 'subtipo';

export interface CuentaDeEfectivo {
  account_id: string;
  code: string;
  name: string;
  via: ViaDeEfectivo;
}

export interface MovimientoRealDeEfectivo {
  criterio: CriterioDeEfectivo;
  /** true cuando el criterio salió del panel y no del defecto del catálogo. */
  criterio_definido: boolean;
  cuentas: CuentaDeEfectivo[];
  /** Saldo acumulado del mayor ANTES del primer día del periodo. */
  saldo_inicial: string;
  /** Saldo acumulado al último día del periodo. */
  saldo_final: string;
  /** final − inicial. Positivo = entró efectivo. */
  variacion: string;
}

/**
 * Lo que este módulo necesita del estado de flujos, y nada más.
 *
 * Tipado ESTRUCTURAL a propósito: es la forma que la ruta REST ya publica
 * (`operating_activities.total`, …), así que el motor que construya el
 * estado la satisface sin que este archivo dependa de él. La conciliación
 * no debe poder quedarse atrás de un cambio en la CARA del estado; sólo le
 * importan sus tres totales.
 */
export interface FlujoDerivado {
  method?: string;
  operating_activities: { total: string };
  investing_activities: { total: string };
  financing_activities: { total: string };
}

export interface Residuo {
  /** Neto del estado: operación + inversión + financiamiento. */
  derivado: string;
  /** Variación real de caja y bancos en el mayor. */
  real: string;
  /** derivado − real. Positivo = el estado afirma más efectivo del que entró. */
  importe: string;
  cuadra: boolean;
}

/** A qué sección del estado pertenecería la contrapartida de un movimiento. */
export type CategoriaProbable = 'operacion' | 'inversion' | 'financiamiento' | 'sin_clasificar';

/** Por qué una línea entra a la lista de sospechosos. */
export type MotivoDeSospecha = 'sin_reclamar' | 'doble_conteo';

export interface Sospechoso {
  entry_number: string;
  entry_date: string;
  description: string | null;
  /** Efecto de la póliza sobre el efectivo. Positivo = entró. */
  efecto_en_efectivo: string;
  counterpart_code: string;
  counterpart_name: string;
  counterpart_type: string;
  categoria_probable: CategoriaProbable;
  motivo: MotivoDeSospecha;
}

/** Qué hizo la política con el residuo. */
export type TratoDelResiduo = 'sin_residuo' | 'nombrado' | 'bloqueado' | 'silenciado';

/**
 * CUÁNTO DEL RESIDUO EXPLICAN LOS SOSPECHOSOS.
 *
 * Es lo que convierte una lista en una pista. Un residuo de 65 000 con un
 * sospechoso de 50 000 deja 15 000 que NADIE de la lista explica, y esa
 * segunda cifra es la que dice si hay que seguir buscando o no.
 *
 * La aritmética vale bajo un supuesto que hay que decir en voz alta: que
 * cada sospechoso «sin reclamar» falta ENTERO del estado. Si el estado sí lo
 * contaba en alguna sección —la clasificación de aquí y la que usó el motor
 * al armarse no están garantizadas iguales—, la cobertura sobreestima. Por
 * eso viaja junto a la lista y con el mismo rótulo: son sospechosos.
 */
export interface CoberturaDeSospechosos {
  /** Cuánto del residuo explican los listados, en unidades del residuo. */
  explicado: string;
  /** Lo que ninguno explica: residuo − explicado. */
  sin_explicar: string;
}

export interface Conciliacion {
  entity_id: string;
  start_date: string;
  end_date: string;
  /** El método que el estado dice haber usado. */
  method: string;
  efectivo: MovimientoRealDeEfectivo;
  residuo: Residuo;
  politica_descuadre: PoliticaDeDescuadre;
  politica_descuadre_definida: boolean;
  trato: TratoDelResiduo;
  /** La frase que tiene que viajar con el estado. null cuando cuadra. */
  aviso: string | null;
  /**
   * Cuenta de hallazgos, en el vocabulario del contrato de códigos de salida
   * (`checkExitCode`). El residuo es SIEMPRE al menos advertencia: la
   * política decide si además bloquea.
   */
  hallazgos: { blocking: number; warning: number };
  /** Sólo cuando se pidieron. Lista de SOSPECHOSOS, nunca un veredicto. */
  candidatos?: Sospechoso[];
  /** Acompaña a `candidatos`: cuánto del residuo cubren y cuánto queda. */
  cobertura?: CoberturaDeSospechosos;
}

export interface OpcionesDeConciliacion {
  startDate: string;
  endDate: string;
  /** Los tres totales del estado ya construido. */
  derivado: FlujoDerivado;
  /** Cuántos sospechosos ofrecer. Sin esto no se calculan. */
  candidatos?: number;
}

const cero = (valor: string | null | undefined): Decimal =>
  new Decimal(valor === null || valor === undefined || valor === '' ? 0 : valor);

const money = (valor: Decimal): string => valor.toFixed(LEDGER_SCALE);

/**
 * El inquilino del contexto RLS, o el de la entidad cuando no lo hay.
 *
 * Mismo molde que `criterio-cierre.ts`: el CLI y REST fijan el contexto, y
 * una llamada suelta (una prueba, un script) todavía tiene que poder leer
 * la política de la entidad que le pasan.
 */
async function inquilinoDe(entityId: string): Promise<string | null> {
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return r.rows[0]?.tenant_id ?? null;
}

/**
 * El valor efectivo de una política, o su defecto declarado.
 *
 * UN INFORME NO MUERE POR NO PODER LEER UNA POLÍTICA. Es el mismo criterio
 * que `criterio-cierre.ts` fijó y por la misma razón: si la entidad no
 * resuelve inquilino —o si la fila del panel todavía no está sembrada en
 * esta base—, se aplica el defecto en vez de reventar la lectura. Lo que NO
 * se pierde es la distinción: el `defined:false` viaja hasta la salida, así
 * que el lector siempre sabe si la cifra salió de una decisión suya o del
 * defecto de la casa.
 */
async function politicaDe(
  entityId: string,
  key: string,
  porOmision: string
): Promise<{ value: string; defined: boolean }> {
  const tenantId = currentTenant() ?? (await inquilinoDe(entityId));
  if (!tenantId) return { value: porOmision, defined: false };
  try {
    const p = await getPolicy({ tenantId, entityId }, key);
    return { value: p.value, defined: p.defined };
  } catch {
    return { value: porOmision, defined: false };
  }
}

/**
 * LAS CUENTAS QUE SON EFECTIVO, resueltas por el MAPA DE ROLES.
 *
 * Aquí muere el defecto 3. La ruta REST clasificaba con `name ILIKE
 * '%receivable%'` contra un catálogo que este mismo producto siembra en
 * español: no casaba nada, y los cambios en capital de trabajo salían en
 * cero sin que nadie lo notara. El mapa de roles es la capa semántica que
 * esta casa ya usa en todas partes y que sobrevive a renombres,
 * traducciones y catálogos importados — que es exactamente lo que los
 * nombres no hacen.
 *
 * DOS DECISIONES QUE NO SON OBVIAS:
 *
 * 1. Se toman los roles CON CUALQUIER cualificador, al revés que el posteo
 *    (`ar-ap-posting`, `treasury-posting`), que exige `qualifier IS NULL`.
 *    Allí el cualificador desglosa por tercero y se quiere el genérico;
 *    aquí se pregunta «¿cuánto efectivo hay?», y un despacho que mapeó una
 *    variante por banco tiene su dinero repartido entre ellas.
 *
 * 2. Se incluyen los DESCENDIENTES de la cuenta del rol. `banco` apunta a
 *    1110 «Caja y Bancos», que es la cuenta de control; el dinero se
 *    postea en 1111, 1112 y 1115, que cuelgan de ella (y a las que apunta
 *    `bank_accounts.gl_account_id`). Tomar sólo la cuenta del rol daría
 *    variación cero en una entidad con bancos reales, y el residuo saldría
 *    igual al estado completo: un instrumento que siempre grita no dice
 *    nada.
 */
export async function cuentasDeEfectivo(
  entityId: string,
  criterio: CriterioDeEfectivo
): Promise<CuentaDeEfectivo[]> {
  if (criterio === 'lista') {
    // La lista de códigos que declara el despacho todavía no tiene dónde
    // guardarse: eso es `cashflow category set`, que necesita columna nueva
    // en `accounts` y por tanto migración. Se rehúsa nombrando la salida en
    // vez de caer en silencio al criterio por omisión, que es como alguien
    // acaba creyendo que su lista se está aplicando.
    throw new ValidationError(
      'La política `flujo_efectivo_cuentas_de_efectivo` está en «lista», y todavía no hay ' +
        'dónde declarar esa lista (necesita `cashflow category set`, que no existe). ' +
        'Cámbiala a «rol» o «subtipo» con `mnemosine pending define ' +
        'flujo_efectivo_cuentas_de_efectivo`.'
    );
  }

  if (criterio === 'subtipo') {
    const r = await query<{ account_id: string; code: string; name: string }>(
      // SIN filtro por `is_active`, igual que la rama del rol. Una cuenta de
      // efectivo archivada A MEDIO PERIODO movió dinero de verdad antes de
      // archivarse, y ese movimiento está en el mayor: dejarla fuera no
      // quita el movimiento, sólo quita el lado del amarre que lo explica y
      // fabrica un residuo que nadie podrá encontrar. El archivado es un
      // hecho del catálogo de HOY; el estado de flujos habla de lo que pasó.
      `SELECT a.id AS account_id, a.code, a.name
         FROM accounts a
        WHERE a.entity_id = $1
          AND a.account_subtype = ANY($2::text[])
        ORDER BY a.code`,
      [entityId, SUBTIPOS_DE_EFECTIVO]
    );
    return r.rows.map((f) => ({ ...f, via: 'subtipo' as const }));
  }

  // EL EFECTIVO ENTRA AL MAYOR POR DOS PUERTAS, y hay que abrir las dos.
  //
  // Una es el rol `banco`. La otra es `bank_accounts.gl_account_id`, que es
  // donde `ar-ap-posting` deposita cuando la cuenta bancaria tiene su cuenta
  // de mayor atada. Y `gl_account_id` lo fija el usuario con `bank account
  // set`: NADA obliga a que cuelgue del árbol del rol. Con una sola puerta,
  // una entidad que apuntó su banco a una cuenta fuera de ese árbol tendría
  // ese dinero invisible para el amarre, y el residuo saldría inventado.
  //
  // Importa además que coincida con el conjunto que usa `cash-flow-service`
  // para su auto-comprobación: si las dos mitades no llaman «efectivo» a lo
  // mismo, `generate` y `reconcile` publican residuos distintos del mismo
  // periodo — que es el defecto de los dos estados, otra vez.
  //
  // La frontera de entidad vive DENTRO del SQL, en las cuatro ramas del
  // recursivo: los dos orígenes, la cuenta raíz y cada descendiente.
  const r = await query<{ account_id: string; code: string; name: string; via: string }>(
    `WITH RECURSIVE raiz AS (
       SELECT a.id, a.code, a.name, a.parent_id, 'rol'::text AS via
         FROM account_roles ar
         JOIN accounts a ON a.id = ar.account_id AND a.entity_id = $1
        WHERE ar.entity_id = $1 AND ar.role = ANY($2::text[])
       UNION
       SELECT a.id, a.code, a.name, a.parent_id, 'cuenta_bancaria'::text AS via
         FROM bank_accounts b
         JOIN accounts a ON a.id = b.gl_account_id AND a.entity_id = $1
        WHERE b.entity_id = $1
     ),
     arbol AS (
       SELECT id, code, name, via FROM raiz
       UNION
       SELECT h.id, h.code, h.name, 'descendiente'::text
         FROM accounts h
         JOIN arbol p ON h.parent_id = p.id
        WHERE h.entity_id = $1
     )
     SELECT account_id, code, name, via FROM (
       SELECT DISTINCT ON (id) id AS account_id, code, name, via
         FROM arbol
        -- La prioridad se ESCRIBE, no se hereda del alfabeto. Una cuenta
        -- puede llegar por varias vías a la vez (un rol apuntado a una
        -- subcuenta que además cuelga de otra cuenta con rol, o una cuenta
        -- bancaria atada dentro del árbol del rol) y se informa la más
        -- directa. Confiarlo al orden alfabético daba justo lo contrario:
        -- 'descendiente' < 'rol', así que el desempate se quedaba con
        -- 'descendiente' pese a que el comentario afirmaba lo opuesto.
        ORDER BY id, CASE via
                       WHEN 'rol' THEN 1
                       WHEN 'cuenta_bancaria' THEN 2
                       ELSE 3
                     END
     ) d
     -- El orden final es por CÓDIGO y no por id: el id es un uuid, y una
     -- lista de cuentas de efectivo impresa en orden aleatorio no se puede
     -- comparar de una corrida a la siguiente.
     ORDER BY code`,
    [entityId, ROLES_DE_EFECTIVO]
  );
  return r.rows.map((f) => ({
    account_id: f.account_id,
    code: f.code,
    name: f.name,
    via:
      f.via === 'rol' || f.via === 'cuenta_bancaria' || f.via === 'descendiente'
        ? f.via
        : 'descendiente',
  }));
}

/**
 * LA VARIACIÓN REAL DE CAJA Y BANCOS, del mayor.
 *
 * El saldo inicial es el acumulado de TODO lo posteado antes del primer día
 * del periodo, no `account_balances.beginning_balance`: esa columna sólo la
 * siembra el cierre duro, y una entidad que nunca corrió `close --hard` la
 * tiene en cero — el amarre saldría perfecto por no tener contra qué fallar.
 *
 * Los asientos de cierre entran sin filtrar y eso es correcto: el cierre
 * barre resultados contra capital y no toca una sola cuenta de efectivo, así
 * que excluirlos no cambiaría una cifra y sí introduciría un criterio de
 * presentación donde aquí sólo hay hechos del libro.
 */
export async function movimientoRealDeEfectivo(
  entityId: string,
  opts: { startDate: string; endDate: string; criterio?: CriterioDeEfectivo }
): Promise<MovimientoRealDeEfectivo> {
  const politica = opts.criterio
    ? { value: opts.criterio, defined: true }
    : await politicaDe(entityId, 'flujo_efectivo_cuentas_de_efectivo', 'rol');
  const criterio = politica.value as CriterioDeEfectivo;

  const cuentas = await cuentasDeEfectivo(entityId, criterio);
  if (cuentas.length === 0) {
    throw new ValidationError(
      `Ninguna cuenta de esta entidad califica como efectivo con el criterio «${criterio}». ` +
        (criterio === 'rol'
          ? `Apunta el rol con \`mnemosine account role set banco <cuenta>\` o siembra la capa ` +
            `semántica con \`mnemosine init --section identity\`.`
          : `Marca las cuentas de efectivo con account_subtype en (${SUBTIPOS_DE_EFECTIVO.join(', ')}).`)
    );
  }
  const ids = cuentas.map((c) => c.account_id);

  // El par (jel JOIN je) va entre paréntesis y con el predicado de fecha
  // DENTRO del JOIN, igual que en report-service: encadenar dos JOIN sueltos
  // deja pasar líneas de asientos en borrador o anulados.
  const r = await query<{ inicial: string; variacion: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN je.entry_date < $2
                    THEN COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
                    ELSE 0 END), 0)::text AS inicial,
       COALESCE(SUM(CASE WHEN je.entry_date BETWEEN $2 AND $3
                    THEN COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
                    ELSE 0 END), 0)::text AS variacion
       FROM (journal_entry_lines jel
        JOIN journal_entries je
          ON je.id = jel.journal_entry_id
         AND je.status = 'posted'
         AND je.entity_id = $1
         AND je.entry_date <= $3)
       JOIN accounts a ON a.id = jel.account_id AND a.entity_id = $1
      WHERE jel.account_id = ANY($4::uuid[])`,
    [entityId, opts.startDate, opts.endDate, ids]
  );

  const inicial = cero(r.rows[0]?.inicial);
  const variacion = cero(r.rows[0]?.variacion);
  return {
    criterio,
    criterio_definido: politica.defined,
    cuentas,
    saldo_inicial: money(inicial),
    saldo_final: money(inicial.plus(variacion)),
    variacion: money(variacion),
  };
}

interface FilaDeSospechoso {
  entry_number: string;
  /**
   * Ya en texto desde Postgres (`::text`), no como Date.
   *
   * `pg` entrega una columna DATE como un Date en medianoche LOCAL, y
   * volverla a ISO en una zona con desplazamiento negativo la retrasa un
   * día: una póliza del 25 se imprimía como del 24. Casteando en el SQL no
   * llega a existir ningún Date que pueda desplazarse.
   */
  entry_date: string;
  description: string | null;
  efecto: string;
  counterpart_code: string;
  counterpart_name: string;
  counterpart_type: string;
  counterpart_subtype: string | null;
  counterpart_fs: string | null;
  counterpart_role: string | null;
  activo_en_tabla: boolean;
}

/**
 * A qué sección del estado pertenecería una contrapartida — por TIPO y por
 * ROL, nunca por nombre.
 *
 * Es la misma decisión que el estado toma para armarse, hecha aquí desde
 * fuera. Que las dos coincidan no está garantizado, y por eso lo que sale de
 * aquí es una lista de sospechosos y no un veredicto.
 */
function categoriaDe(f: FilaDeSospechoso): CategoriaProbable {
  const tipo = f.counterpart_type;
  if (tipo === 'revenue' || tipo === 'expense') return 'operacion';
  if (f.counterpart_role === 'cxc' || f.counterpart_role === 'cxp') return 'operacion';
  if (f.counterpart_role === 'activo_fijo' || f.counterpart_role === 'depreciacion_acumulada') {
    return 'inversion';
  }
  if (f.counterpart_subtype === 'fixed_asset' || f.counterpart_fs === 'non_current_assets') {
    return 'inversion';
  }
  if (tipo === 'equity' || tipo === 'contra_equity') return 'financiamiento';
  if (f.counterpart_subtype === 'long_term_liability' || f.counterpart_fs === 'long_term_liabilities') {
    return 'financiamiento';
  }
  return 'sin_clasificar';
}

/**
 * LOS SOSPECHOSOS: movimientos de efectivo que probablemente expliquen el
 * residuo. No son un veredicto y la salida lo dice.
 *
 * Dos motivos, y los dos nombran defectos que este tramo encontró vivos:
 *
 *   `sin_reclamar` — la contrapartida cae en financiamiento o no cae en
 *   ninguna sección. Con el financiamiento clavado en '0.0000' (defecto 2),
 *   TODA aportación de capital, TODO préstamo dispuesto o amortizado y TODO
 *   dividendo pagado es invisible por construcción: el efectivo se movió y
 *   el estado no lo cuenta.
 *
 *   `doble_conteo` — la contrapartida es una cuenta de activo fijo y el
 *   periodo además tiene altas o bajas en la tabla `fixed_assets`, de donde
 *   la sección de inversión saca sus cifras (defecto 4). El mismo hecho
 *   económico puede entrar dos veces, por el mayor y por la tabla.
 */
export async function sospechososDelResiduo(
  entityId: string,
  opts: { startDate: string; endDate: string; cuentas: string[]; limite: number }
): Promise<Sospechoso[]> {
  const r = await query<FilaDeSospechoso>(
    `WITH efectivo AS (
       SELECT jel.journal_entry_id AS je_id,
              SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) AS efecto
         FROM (journal_entry_lines jel
          JOIN journal_entries je
            ON je.id = jel.journal_entry_id
           AND je.status = 'posted'
           AND je.entity_id = $1
           AND je.entry_date BETWEEN $2 AND $3)
        WHERE jel.account_id = ANY($4::uuid[])
        GROUP BY jel.journal_entry_id
       HAVING SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) <> 0
     ),
     contrapartes AS (
       SELECT e.je_id,
              jel.account_id,
              -- El efecto sobre el efectivo se reparte entre las
              -- contrapartidas en proporción a su importe: una póliza con
              -- una salida de banco y tres cargos distintos no puede
              -- atribuirle la salida entera a cada uno.
              e.efecto * (COALESCE(jel.debit_amount, 0) + COALESCE(jel.credit_amount, 0))
                / NULLIF(SUM(COALESCE(jel.debit_amount, 0) + COALESCE(jel.credit_amount, 0))
                         OVER (PARTITION BY e.je_id), 0) AS efecto
         FROM efectivo e
         JOIN journal_entry_lines jel ON jel.journal_entry_id = e.je_id
        WHERE NOT (jel.account_id = ANY($4::uuid[]))
     )
     SELECT je.entry_number,
            je.entry_date::text AS entry_date,
            je.description,
            SUM(c.efecto)::text AS efecto,
            a.code AS counterpart_code,
            a.name AS counterpart_name,
            a.account_type AS counterpart_type,
            a.account_subtype AS counterpart_subtype,
            a.fs_category AS counterpart_fs,
            MIN(ar.role) AS counterpart_role,
            EXISTS (
              SELECT 1 FROM fixed_assets fa
               WHERE fa.entity_id = $1
                 AND (fa.acquisition_date BETWEEN $2 AND $3
                      OR fa.disposal_date BETWEEN $2 AND $3)
            ) AS activo_en_tabla
       FROM contrapartes c
       JOIN journal_entries je ON je.id = c.je_id AND je.entity_id = $1
       JOIN accounts a ON a.id = c.account_id AND a.entity_id = $1
       LEFT JOIN account_roles ar ON ar.account_id = a.id AND ar.entity_id = $1
      GROUP BY je.entry_number, je.entry_date::text, je.description,
               a.code, a.name, a.account_type, a.account_subtype, a.fs_category
      -- El desempate va sobre entry_date::text, la MISMA expresión que
      -- agrupa. Postgres no reconoce entry_date a secas como agrupada cuando
      -- lo que está en el GROUP BY es el casteo, y rechaza la consulta
      -- entera. (Sin comillas invertidas aquí dentro: esto vive en un
      -- template literal y una sola lo cerraría.)
      ORDER BY ABS(SUM(c.efecto)) DESC, je.entry_date::text, je.entry_number
      LIMIT $5`,
    [entityId, opts.startDate, opts.endDate, opts.cuentas, opts.limite * 4]
  );

  const salida: Sospechoso[] = [];
  for (const f of r.rows) {
    const categoria = categoriaDe(f);
    const dobleConteo = categoria === 'inversion' && f.activo_en_tabla;
    const sinReclamar = categoria === 'financiamiento' || categoria === 'sin_clasificar';
    if (!dobleConteo && !sinReclamar) continue;
    salida.push({
      entry_number: f.entry_number,
      entry_date: f.entry_date,
      description: f.description,
      efecto_en_efectivo: money(cero(f.efecto)),
      counterpart_code: f.counterpart_code,
      counterpart_name: f.counterpart_name,
      counterpart_type: f.counterpart_type,
      categoria_probable: categoria,
      motivo: dobleConteo ? 'doble_conteo' : 'sin_reclamar',
    });
    if (salida.length >= opts.limite) break;
  }
  return salida;
}

/**
 * LA CONCILIACIÓN. Contrasta el neto derivado contra la variación real y
 * nombra el residuo.
 *
 * SOBRE LA POLÍTICA `flujo_efectivo_descuadre` Y POR QUÉ «silencio» NO
 * SILENCIA ESTO. La política gobierna qué pasa cuando el estado SE PUBLICA:
 * con «avisar» viaja con la diferencia dicha, con «bloquear» no se emite y
 * con «silencio» se emite el neto sin contrastar. `cashflow reconcile` es el
 * acto de PREGUNTAR por la diferencia; callarla aquí sería apagar el único
 * instrumento que la caza, y este módulo existe justamente porque nada la
 * cazaba. Lo que «silencio» cambia es la GRAVEDAD y el aviso: el residuo
 * deja de ser bloqueante y la salida dice, con todas sus letras, que el
 * estado publicado no lo va a mencionar.
 */
export async function conciliarFlujoDeEfectivo(
  entityId: string,
  opts: OpcionesDeConciliacion
): Promise<Conciliacion> {
  if (opts.startDate > opts.endDate) {
    throw new ValidationError(
      `El periodo termina (${opts.endDate}) antes de empezar (${opts.startDate}).`
    );
  }

  const efectivo = await movimientoRealDeEfectivo(entityId, {
    startDate: opts.startDate,
    endDate: opts.endDate,
  });

  const derivado = cero(opts.derivado.operating_activities.total)
    .plus(cero(opts.derivado.investing_activities.total))
    .plus(cero(opts.derivado.financing_activities.total));
  const real = new Decimal(efectivo.variacion);
  const importe = derivado.minus(real);
  const cuadra = importe.isZero();

  const politica = await politicaDe(entityId, 'flujo_efectivo_descuadre', 'avisar');
  const regla = politica.value as PoliticaDeDescuadre;

  let trato: TratoDelResiduo = 'sin_residuo';
  let aviso: string | null = null;
  const hallazgos = { blocking: 0, warning: 0 };

  if (!cuadra) {
    const frase =
      `El estado de flujos no amarra con el efectivo: afirma un neto de ${money(derivado)} ` +
      `y caja y bancos se movió ${money(real)} en el mayor. Residuo de ${money(importe)}, ` +
      `sin absorber en ningún renglón.`;
    switch (regla) {
      case 'bloquear':
        trato = 'bloqueado';
        hallazgos.blocking = 1;
        aviso = `${frase} La política \`flujo_efectivo_descuadre\` está en «bloquear»: el estado no se emite hasta que amarre.`;
        break;
      case 'silencio':
        trato = 'silenciado';
        hallazgos.warning = 1;
        aviso = `${frase} La política \`flujo_efectivo_descuadre\` está en «silencio»: el estado se publicará SIN mencionar este residuo.`;
        break;
      default:
        trato = 'nombrado';
        hallazgos.warning = 1;
        aviso = frase;
        break;
    }
  }

  const conciliacion: Conciliacion = {
    entity_id: entityId,
    start_date: opts.startDate,
    end_date: opts.endDate,
    method: opts.derivado.method ?? 'indirecto',
    efectivo,
    residuo: {
      derivado: money(derivado),
      real: money(real),
      importe: money(importe),
      cuadra,
    },
    politica_descuadre: regla,
    politica_descuadre_definida: politica.defined,
    trato,
    aviso,
    hallazgos,
  };

  // Los sospechosos sólo tienen sentido cuando hay algo que explicar; con
  // residuo cero la lista sería un catálogo de pólizas normales presentadas
  // como si algo pasara con ellas.
  if (opts.candidatos && opts.candidatos > 0 && !cuadra) {
    const sospechosos = await sospechososDelResiduo(entityId, {
      startDate: opts.startDate,
      endDate: opts.endDate,
      cuentas: efectivo.cuentas.map((c) => c.account_id),
      limite: opts.candidatos,
    });
    conciliacion.candidatos = sospechosos;

    // El residuo es `derivado − real`, así que un movimiento de efectivo que
    // el estado no contó entra al residuo CON EL SIGNO CAMBIADO: 50 000 que
    // entraron al banco sin que ninguna sección los reclame empujan el
    // residuo 50 000 hacia abajo. Por eso lo explicado es la suma negada.
    const suma = sospechosos.reduce((acc, s) => acc.plus(s.efecto_en_efectivo), new Decimal(0));
    const explicado = suma.negated();
    conciliacion.cobertura = {
      explicado: money(explicado),
      sin_explicar: money(importe.minus(explicado)),
    };
  }

  return conciliacion;
}
