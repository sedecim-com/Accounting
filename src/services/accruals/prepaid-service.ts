import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import Decimal from 'decimal.js';
import { query, currentTenant, withTransaction } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import { ValidationError } from '../../utils/errors.js';
import {
  CONVENCIONES_AMORTIZACION,
  calcularAmortizacion,
  esConvencionDeAmortizacion,
  type AmortizationResult,
  type ConvencionAmortizacion,
} from './amortization-math.js';

// ============================================================
// EL ALTA DEL PAGO ANTICIPADO, Y EL HUECO QUE YA EXISTE (D1a)
//
// Este archivo hace TRES cosas y ninguna de ellas es postear el cargo a la
// 1160. Conviene decirlo primero porque es la decisión de diseño que explica
// todo lo demás:
//
//   **ESTE MÓDULO NUNCA CARGA LA 1160. SIEMPRE ADOPTA UN SALDO QUE YA ESTÁ EN
//   EL MAYOR.**
//
// El cargo lo hace el camino del CFDI —el clasificador manda el importe al rol
// `gasto_anticipado`, que es la 1160— o un asiento manual. Ese camino LLEVA
// AÑOS VIVO y no tenía contrapartida: la opción «Prepaid expenses (accrued
// month by month)» existe en `cfdi-decisions.ts:121-142` desde antes que este
// tramo, citando la NIF A-2. Si el alta del calendario volviera a postear el
// cargo, un anticipo dado de alta sobre una factura ya contabilizada cargaría
// la 1160 DOS VECES. Adoptar es la única operación que compone bien con lo
// que ya corre.
//
// De ahí las tres:
//   1. `registrarPagoAnticipado` — da de alta el calendario sobre un saldo ya
//      posteado, con el umbral y la convención del panel.
//   2. `huecoDeAnticipados` — mide lo que NO tiene calendario: la deuda
//      heredada, con su tamaño y con los asientos que la componen.
//   3. `revisionDeAmortizacionAlCierre` — la casilla del cierre: qué
//      calendarios no se han corrido en el periodo que se va a cerrar, y si
//      eso avisa o bloquea.
//
// LAS TRES POLÍTICAS QUE SE LEEN AQUÍ, con su clave literal:
//   · `amortizacion_anticipados_convencion` — en el alta, y se CONGELA.
//   · `umbral_anticipado_mxn` — en el alta, para no partir en doce una
//     suscripción de 900 pesos.
//   · `amortizacion_faltante_al_cierre` — en la revisión del cierre.
// ============================================================

export interface PrepaidExpenseRow {
  id: string;
  entity_id: string;
  description: string;
  vendor_name: string | null;
  reference: string | null;
  total_amount: string;
  coverage_start_date: Date;
  coverage_end_date: Date;
  prepaid_account_id: string;
  expense_account_id: string;
  /**
   * VARCHAR con CHECK en la base, `string` aquí a propósito. Declararlo como
   * la unión sería afirmar que Postgres no puede devolver otra cosa, y
   * entonces la comprobación que la corrida hace antes de calcular quedaría
   * como rama muerta — justo la comprobación que existe para el día en que
   * alguien escriba la fila por SQL a mano.
   */
  amortization_convention: string;
  origin: 'cfdi' | 'manual' | 'saldo_preexistente';
  source_journal_entry_id: string | null;
  cfdi_uuid: string | null;
  amortized_to_date: string;
  remaining_amount: string;
  last_amortization_date: Date | null;
  status: 'active' | 'fully_amortized' | 'cancelled';
  notes: string | null;
}

const COLUMNAS = `id, entity_id, description, vendor_name, reference, total_amount,
  coverage_start_date, coverage_end_date, prepaid_account_id, expense_account_id,
  amortization_convention, origin, source_journal_entry_id, cfdi_uuid,
  amortized_to_date, remaining_amount, last_amortization_date, status, notes`;

/**
 * UN RENGLÓN VALE MIENTRAS EL MAYOR LO RESPALDE. Predicado para el alias `s`.
 *
 * `is_posted` sola no basta, y esto no es teórico: el ataque adversarial de
 * D1a revirtió el asiento de una amortización y encontró CUATRO instrumentos
 * mintiendo a la vez. El renglón seguía diciendo `is_posted = true` —el CHECK
 * de la 059 aguanta, porque su `journal_entry_id` sigue apuntando a un asiento
 * que existe— pero ese asiento ya tenía espejo: el gasto había salido del
 * resultado y los 9.000 habían vuelto enteros a la 1160. Con el renglón
 * contando igual,
 *
 *   · la ficha afirmaba 3.100 devengados que el mayor no tenía,
 *   · `respaldoDisponible` ofrecía esos 3.100 como saldo libre, e invitaba a
 *     adoptar DOS VECES el mismo cargo,
 *   · la casilla del cierre daba enero por corrido, y
 *   · el freno de doble corrida impedía volver a correrlo: el gasto de enero
 *     no volvía al resultado NUNCA.
 *
 * La reversa es la única corrección que el mayor admite (041). Un módulo que
 * la ignora convierte «corregir» en «perder el gasto para siempre».
 *
 * Se comprueba el espejo Y el estado: un asiento anulado por la vía de
 * `voidJournalEntryInTx` sin llegar a postear queda 'void', y tampoco respalda
 * nada.
 */
export const RENGLON_VIGENTE = `s.is_posted = true AND EXISTS (
        SELECT 1 FROM journal_entries je_v
         WHERE je_v.id = s.journal_entry_id
           AND je_v.status = 'posted'
           AND je_v.reversed_by_entry_id IS NULL
      )`;

/** Lo devengado de un anticipo SEGÚN EL MAYOR: la suma de sus renglones vigentes. */
export const DEVENGADO_VIGENTE = `COALESCE((
        SELECT SUM(s.amortization_amount)
          FROM prepaid_amortization_schedules s
         WHERE s.prepaid_expense_id = pe.id
           AND s.entity_id = pe.entity_id
           AND ${RENGLON_VIGENTE}
      ), 0)`;

/**
 * MEDIANOCHE LOCAL, NUNCA UTC.
 *
 * `new Date('2026-12-01T00:00:00Z')` es medianoche UTC, que en México es el 30
 * de noviembre a las 18:00: la cobertura arrancaría un mes antes y el
 * calendario entero se correría un renglón. Mismo criterio y mismo motivo que
 * `medianocheLocal` en depreciation.ts:77-88; se repite aquí en vez de
 * importarse porque aquél vive en el módulo que habla con el mayor de los
 * activos y arrastrarlo entero por una conversión de fecha ataría este tramo
 * al de depreciación por el sitio equivocado.
 */
export function medianocheLocal(valor: Date | string): Date {
  if (typeof valor === 'string') return new Date(`${valor.slice(0, 10)}T00:00:00`);
  return new Date(valor.getFullYear(), valor.getMonth(), valor.getDate());
}

export async function inquilinoDeLaEntidad(entityId: string): Promise<string> {
  const delContexto = currentTenant();
  if (delContexto) return delContexto;
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new ValidationError(`No se pudo determinar el inquilino de la entidad ${entityId}.`);
  }
  return tenantId;
}

// ---- Las cuentas, por ROL y acotadas por entidad -------------------------

export interface CuentasDelAnticipo {
  prepaidAccountId: string;
  expenseAccountId: string;
}

/**
 * El par de cuentas del devengo, resuelto por ROL.
 *
 * `gasto_anticipado` → 1160 y `gasto` → 6100 en el mapa sembrado
 * (account-roles-seed.ts:250 y :243). Se resuelven en el ALTA y se congelan en
 * la cabecera: el mapa de roles se puede reasignar, y un anticipo que empezó
 * devengándose contra una cuenta y termina contra otra parte el gasto en dos
 * sin que nada lo diga.
 *
 * EL ROL DE GASTO ES GENÉRICO, Y HAY QUE DECIRLO. `gasto` apunta a la 6100
 * «Gastos Generales» para todo: un seguro, una renta anticipada y una licencia
 * de software acaban en la misma cuenta. Contablemente no es incorrecto, pero
 * tampoco es lo que un despacho quiere ver en el estado de resultados, y el
 * catálogo de roles NO TIENE hoy un rol de gasto por naturaleza (`seguros`,
 * `rentas`, `suscripciones`). No se inventa aquí —el mapa de roles es de otro
 * frente—: se acepta la cuenta que el llamador pase, y si no pasa ninguna se
 * cae al rol genérico. Queda anotado como hueco en el informe de este tramo.
 */
export async function cuentasDelAnticipo(
  entityId: string,
  override?: Partial<CuentasDelAnticipo>,
  client?: pg.PoolClient
): Promise<CuentasDelAnticipo> {
  const ejecutar = client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;

  // El alcance por entidad DENTRO del SQL, no por un id que venía de una
  // consulta anterior: van cuatro fugas cerradas en este proyecto por eso.
  const r = await ejecutar<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles
      WHERE entity_id = $1 AND role = ANY($2::text[]) AND qualifier IS NULL`,
    [entityId, ['gasto_anticipado', 'gasto']]
  );
  const mapa = new Map(r.rows.map((f) => [f.role, f.account_id]));

  const prepaidAccountId = override?.prepaidAccountId ?? mapa.get('gasto_anticipado');
  const expenseAccountId = override?.expenseAccountId ?? mapa.get('gasto');

  if (!prepaidAccountId) {
    throw new ValidationError(
      'No hay cuenta mapeada al rol "gasto_anticipado" (1160) en esta entidad. Sin ella no hay ' +
        'de dónde devengar. Siembra los roles con: mnemosine init --section identity ' +
        '(o revisa qué falta con: mnemosine doctor)'
    );
  }
  if (!expenseAccountId) {
    throw new ValidationError(
      'No hay cuenta mapeada al rol "gasto" en esta entidad: el devengo no tiene contra qué ' +
        'cargar. Siembra los roles con: mnemosine init --section identity'
    );
  }
  if (prepaidAccountId === expenseAccountId) {
    throw new ValidationError(
      'Los roles "gasto_anticipado" y "gasto" apuntan a la MISMA cuenta en esta entidad: el ' +
        'asiento de devengo se cargaría y se abonaría a sí mismo y no movería nada.'
    );
  }
  return { prepaidAccountId, expenseAccountId };
}

// ---- Los criterios del panel --------------------------------------------

export interface CriteriosDeAnticipo {
  convencion: ConvencionAmortizacion;
  convencionDefinida: boolean;
  umbral: string;
  umbralDefinido: boolean;
}

/**
 * LAS DOS DECISIONES QUE ESTE CÓDIGO NO TOMA, leídas del panel.
 *
 * Si el primer mes devenga entero o sólo los días que cubre, y desde qué
 * importe vale la pena partir un gasto en doce, son criterio del despacho: las
 * dos respuestas son defendibles y postean importes distintos todos los meses.
 *
 * Un valor fuera del vocabulario DETIENE el alta en vez de caer al defecto: un
 * `amortizacion_anticipados_convencion` mal tecleado elegiría en silencio el
 * otro recorte del calendario, y el silencio es lo que hace que un importe
 * equivocado se descubra un año después. Mismo criterio que
 * `criteriosDeLaCorrida` en depreciation.ts:166-196.
 */
export async function criteriosDeAnticipo(
  tenantId: string,
  entityId: string
): Promise<CriteriosDeAnticipo> {
  const convencion = await getPolicy({ tenantId, entityId }, 'amortizacion_anticipados_convencion');
  const umbral = await getPolicy({ tenantId, entityId }, 'umbral_anticipado_mxn');

  if (!esConvencionDeAmortizacion(convencion.value)) {
    throw new ValidationError(
      `La política \`amortizacion_anticipados_convencion\` vale "${convencion.value}", que no es ` +
        `ninguna de las dos convenciones posibles (${CONVENCIONES_AMORTIZACION.join(', ')}). ` +
        'Corrígela con `mnemosine pending resolve amortizacion_anticipados_convencion` antes de ' +
        'dar de alta el calendario.'
    );
  }

  // El umbral se valida como NÚMERO y se guarda como string: es dinero.
  let umbralDecimal: Decimal;
  try {
    umbralDecimal = new Decimal(umbral.value);
  } catch {
    throw new ValidationError(
      `La política \`umbral_anticipado_mxn\` vale "${umbral.value}", que no es un importe. ` +
        'Corrígela con `mnemosine pending resolve umbral_anticipado_mxn`.'
    );
  }
  if (!umbralDecimal.isFinite() || umbralDecimal.isNegative()) {
    throw new ValidationError(
      `La política \`umbral_anticipado_mxn\` vale "${umbral.value}", que no es un importe válido ` +
        'para un umbral (tiene que ser cero o positivo).'
    );
  }

  return {
    convencion: convencion.value,
    convencionDefinida: convencion.defined,
    umbral: umbralDecimal.toFixed(4),
    umbralDefinido: umbral.defined,
  };
}

// ---- El alta ------------------------------------------------------------

export interface AltaDeAnticipo {
  entityId: string;
  descripcion: string;
  importe: string;
  inicio: Date | string;
  fin: Date | string;
  origen: 'cfdi' | 'manual' | 'saldo_preexistente';
  createdBy: string;
  proveedor?: string;
  referencia?: string;
  cfdiUuid?: string;
  /** El asiento que cargó la 1160. OBLIGATORIO cuando el origen es 'cfdi'. */
  sourceJournalEntryId?: string;
  cuentas?: Partial<CuentasDelAnticipo>;
  notas?: string;
  /**
   * Da de alta el calendario aunque el importe quede por debajo del umbral del
   * panel. Es una decisión humana explícita, y por eso queda escrita en las
   * notas de la fila en vez de pasar en silencio.
   */
  forzarBajoUmbral?: boolean;
}

export interface AnticipoRegistrado {
  anticipo: PrepaidExpenseRow;
  calendario: AmortizationResult[];
  criterios: CriteriosDeAnticipo;
  avisos: string[];
}

/**
 * DA DE ALTA EL CALENDARIO DE UN SALDO QUE YA ESTÁ EN LA 1160.
 *
 * Las dos guardas que trae, y por qué cada una:
 *
 * 1. EL UMBRAL (`umbral_anticipado_mxn`). Materialidad, NIF A-4: una
 *    suscripción de 900 pesos partida en doce asientos de 75 cuesta más en
 *    teneduría que la precisión que compra. Por debajo del umbral el alta se
 *    DETIENE con el motivo, y se puede forzar — pero forzar deja rastro.
 *
 * 2. EL RESPALDO EN LA CUENTA. Es la guarda importante y es propia de adoptar:
 *    nada impide dar de alta dos calendarios sobre el MISMO cargo a la 1160, y
 *    entonces el motor abonaría la cuenta dos veces y la dejaría en negativo
 *    —un activo con saldo acreedor, que el balance sigue cuadrando—. Se
 *    comprueba contra el saldo POSTEADO de la cuenta, no contra el asiento de
 *    origen, porque un asiento puede traer dos pólizas y un saldo puede venir
 *    de varios asientos: lo que no puede pasar es que la suma de lo que queda
 *    por devengar supere lo que hay.
 */
export async function registrarPagoAnticipado(alta: AltaDeAnticipo): Promise<AnticipoRegistrado> {
  const inicio = medianocheLocal(alta.inicio);
  const fin = medianocheLocal(alta.fin);
  const importe = new Decimal(alta.importe);
  const avisos: string[] = [];

  if (alta.origen === 'cfdi' && !alta.sourceJournalEntryId) {
    throw new ValidationError(
      'Un anticipo con origen "cfdi" tiene que decir qué asiento cargó la 1160: si el calendario ' +
        'nace con la factura el vínculo se conoce, y no anotarlo es perderlo para siempre.'
    );
  }

  const tenantId = await inquilinoDeLaEntidad(alta.entityId);
  const criterios = await criteriosDeAnticipo(tenantId, alta.entityId);

  // 1 · EL UMBRAL.
  const umbral = new Decimal(criterios.umbral);
  const bajoUmbral = importe.lessThan(umbral);
  if (bajoUmbral && !alta.forzarBajoUmbral) {
    throw new ValidationError(
      `El importe ${importe.toFixed(2)} queda por debajo del umbral de ${umbral.toFixed(2)} MXN ` +
        `que fija la política \`umbral_anticipado_mxn\`${criterios.umbralDefinido ? '' : ' (por defecto)'}: ` +
        'por materialidad (NIF A-4) este gasto se reconoce completo en el mes en que se pagó, no ' +
        'se parte. Si aun así quiere devengarse, dese de alta con --forzar y quedará anotado.'
    );
  }
  if (bajoUmbral) {
    avisos.push(
      `Alta forzada por debajo del umbral de ${umbral.toFixed(2)} MXN (\`umbral_anticipado_mxn\`).`
    );
  }

  // El calendario se calcula ANTES de escribir: si la aritmética rechaza la
  // ventana o el importe, no queda una cabecera huérfana que nadie devengará.
  const calendario = calcularAmortizacion({
    importe: importe.toFixed(4),
    inicio,
    fin,
    convencion: criterios.convencion,
  });

  const cuentas = await cuentasDelAnticipo(alta.entityId, alta.cuentas);
  const notas = [alta.notas, ...avisos].filter(Boolean).join(' · ') || null;

  // 2 · EL RESPALDO EN LA CUENTA, MEDIDO Y CONSUMIDO EN LA MISMA TRANSACCIÓN.
  //
  // La comprobación y el INSERT corrían en dos conexiones distintas, y entre
  // una y otro no había nada. El ataque de D1a lanzó dos altas del mismo
  // importe sobre el mismo cargo con `Promise.all` y LAS DOS PASARON: los dos
  // `SELECT` vieron los 24.000 libres antes de que ninguno escribiera. Con dos
  // calendarios de 24.000 sobre un cargo de 24.000, la corrida abona 48.000 y
  // deja la 1160 en −24.000 — un activo con saldo acreedor, y el balance
  // cuadrando todos los meses, que es la forma exacta del defecto que este
  // tramo vino a cerrar.
  //
  // EL CANDADO ES LA FILA DE LA CUENTA. No hay una fila «saldo de la 1160» que
  // bloquear —el saldo es una suma sobre el mayor—, así que se toma como
  // testigo la única fila que identifica ese saldo: la cuenta. Serializa las
  // altas que compiten por la MISMA cuenta de la MISMA entidad y no molesta a
  // ninguna otra; y `accounts` no se escribe en el camino de posteo (sólo la
  // mantiene el servicio de catálogo), así que el candado no se cruza con el
  // mayor. El `entity_id` va dentro del SQL: con la cuenta de la entidad
  // hermana no hay fila que bloquear y el alta se detiene aquí, antes de que
  // la foránea compuesta tenga que decirlo.
  const anticipo = await withTransaction(async (client) => {
    const cuenta = await client.query(
      'SELECT id FROM accounts WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [cuentas.prepaidAccountId, alta.entityId]
    );
    if (cuenta.rowCount !== 1) {
      throw new ValidationError(
        `La cuenta de pagos anticipados ${cuentas.prepaidAccountId} no existe o no es de la ` +
          `entidad ${alta.entityId}. Un calendario no se devenga contra la cuenta de otra entidad.`
      );
    }

    const respaldo = await respaldoDisponible(alta.entityId, cuentas.prepaidAccountId, client);
    if (importe.greaterThan(respaldo.disponible)) {
      throw new ValidationError(
        `No hay saldo posteado que respalde este calendario. La cuenta de pagos anticipados tiene ` +
          `${new Decimal(respaldo.saldoPosteado).toFixed(2)} en el mayor, de los cuales ` +
          `${new Decimal(respaldo.yaAdoptado).toFixed(2)} ya tienen calendario: quedan ` +
          `${new Decimal(respaldo.disponible).toFixed(2)} y este anticipo pide ` +
          `${importe.toFixed(2)}. Un calendario sin cargo detrás abonaría la 1160 hasta dejarla en ` +
          'negativo, y el balance seguiría cuadrando. Postea primero el cargo, o revisa si este ' +
          'saldo ya está adoptado por otro calendario.'
      );
    }

    const insercion = await client.query<PrepaidExpenseRow>(
      `INSERT INTO prepaid_expenses (
         id, entity_id, description, vendor_name, reference, total_amount,
         coverage_start_date, coverage_end_date, prepaid_account_id, expense_account_id,
         amortization_convention, origin, source_journal_entry_id, cfdi_uuid, notes, created_by
       )
       SELECT $1, e.id, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13, $14, $15, $16
         FROM legal_entities e
        WHERE e.id = $2
       RETURNING ${COLUMNAS}`,
      [
        uuidv4(),
        alta.entityId,
        alta.descripcion,
        alta.proveedor ?? null,
        alta.referencia ?? null,
        importe.toFixed(4),
        inicio,
        fin,
        cuentas.prepaidAccountId,
        cuentas.expenseAccountId,
        criterios.convencion,
        alta.origen,
        alta.sourceJournalEntryId ?? null,
        alta.cfdiUuid ?? null,
        notas,
        alta.createdBy,
      ]
    );
    const fila = insercion.rows[0];
    if (!fila) {
      throw new ValidationError(
        `La entidad ${alta.entityId} no existe o no es de este inquilino: no se dio de alta el anticipo.`
      );
    }
    return fila;
  });

  return { anticipo, calendario, criterios, avisos };
}

// ---- La deuda heredada: lo que ya está en la 1160 sin calendario --------

export interface RespaldoDeLaCuenta {
  /** Saldo deudor POSTEADO de la cuenta de anticipos, de todos los tiempos. */
  saldoPosteado: string;
  /** Lo que los calendarios vivos todavía tienen que devengar. */
  yaAdoptado: string;
  /** Saldo sin calendario: el hueco. */
  disponible: string;
}

/**
 * Cuánto del saldo de la 1160 NO tiene todavía quién lo devengue.
 *
 * Se pregunta al MAYOR y no a `account_balances`: la tabla de saldos se
 * refresca desde el posteo (042) y es un derivado, mientras que la suma de
 * líneas de asientos posteados es el hecho. Es el mismo criterio con el que
 * F06a rehizo la ficha del activo — la tarjeta se arma de lo posteado.
 *
 * Todo acotado por entidad DENTRO del SQL, en las dos mitades.
 */
export async function respaldoDisponible(
  entityId: string,
  prepaidAccountId: string,
  client?: pg.PoolClient
): Promise<RespaldoDeLaCuenta> {
  const ejecutar = client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
  const r = await ejecutar<{ saldo: string; adoptado: string }>(
    // LAS DOS MITADES SE MIDEN CONTRA EL MAYOR, no una contra el mayor y otra
    // contra una columna guardada.
    //
    // `yaAdoptado` era `SUM(pe.remaining_amount)`, y `remaining_amount` se
    // deriva de `amortized_to_date`, que sólo se reescribe cuando la corrida
    // toca ese anticipo. Revertir un asiento devuelve el importe a la 1160 en
    // el acto —el numerador sube— pero deja la columna donde estaba: la resta
    // inventaba un hueco que no existe y ofrecía adoptar otra vez un cargo que
    // ya tiene calendario. Aquí lo pendiente de devengar se calcula igual que
    // el saldo: preguntándole al mayor.
    `SELECT
       COALESCE((
         SELECT SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))
           FROM journal_entry_lines jel
           JOIN journal_entries je ON je.id = jel.journal_entry_id
          WHERE jel.account_id = $2
            AND je.entity_id = $1
            AND je.status = 'posted'
       ), 0)::text AS saldo,
       COALESCE((
         SELECT SUM(pe.total_amount - ${DEVENGADO_VIGENTE})
           FROM prepaid_expenses pe
          WHERE pe.entity_id = $1
            AND pe.prepaid_account_id = $2
            AND pe.status <> 'cancelled'
       ), 0)::text AS adoptado`,
    [entityId, prepaidAccountId]
  );
  const fila = r.rows[0];
  const saldo = new Decimal(fila?.saldo ?? '0');
  const adoptado = new Decimal(fila?.adoptado ?? '0');
  return {
    saldoPosteado: saldo.toFixed(4),
    yaAdoptado: adoptado.toFixed(4),
    disponible: saldo.minus(adoptado).toFixed(4),
  };
}

export interface AsientoSinCalendario {
  journal_entry_id: string;
  entry_number: string;
  entry_date: Date;
  description: string | null;
  cargo: string;
}

export interface HuecoDeAnticipados {
  prepaidAccountId: string;
  saldoPosteado: string;
  yaAdoptado: string;
  /** Lo que nadie va a devengar nunca si esto se queda como está. */
  hueco: string;
  hayHueco: boolean;
  /** Los asientos que cargaron la 1160 y que ningún calendario reclama. */
  asientos: AsientoSinCalendario[];
}

/**
 * EL HUECO: dinero en la 1160 que ningún calendario va a sacar de ahí.
 *
 * Existe porque el camino de ESCRITURA llevaba años vivo sin el de lectura.
 * Cualquiera que haya contestado «Prepaid expenses» a la decisión
 * `gasto_vs_anticipado` del clasificador tiene un importe parado en un activo
 * del que nada lo iba a mover: el gasto no llegó nunca al resultado y el
 * balance cuadró todos los meses.
 *
 * Esta función lo MIDE y lo DESGLOSA por asiento, que es lo que hace falta
 * para repararlo: cada asiento de la lista se adopta con
 * `registrarPagoAnticipado({ origen: 'saldo_preexistente', ... })` diciendo la
 * ventana de cobertura que el documento tenga. No se adopta automáticamente
 * —la ventana no está en ninguna parte del sistema: vive en la póliza de
 * seguro, no en el CFDI— y adivinarla sería inventar la fecha en la que el
 * gasto entra al resultado.
 */
export async function huecoDeAnticipados(
  entityId: string,
  prepaidAccountIdOverride?: string
): Promise<HuecoDeAnticipados> {
  const prepaidAccountId =
    prepaidAccountIdOverride ?? (await cuentasDelAnticipo(entityId)).prepaidAccountId;

  const respaldo = await respaldoDisponible(entityId, prepaidAccountId);

  // Los asientos que cargaron la cuenta y que NINGUNA cabecera reclama. El
  // NOT EXISTS mira también la entidad: un anticipo de otra entidad no puede
  // "explicar" un cargo de ésta.
  const r = await query<AsientoSinCalendario>(
    `SELECT je.id            AS journal_entry_id,
            je.entry_number  AS entry_number,
            je.entry_date    AS entry_date,
            je.description   AS description,
            SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))::text AS cargo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $2
        AND je.entity_id = $1
        AND je.status = 'posted'
        AND NOT EXISTS (
              SELECT 1 FROM prepaid_expenses pe
               WHERE pe.source_journal_entry_id = je.id
                 AND pe.entity_id = $1
                 AND pe.status <> 'cancelled'
            )
      GROUP BY je.id, je.entry_number, je.entry_date, je.description
     HAVING SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) > 0
      ORDER BY je.entry_date ASC, je.entry_number ASC`,
    [entityId, prepaidAccountId]
  );

  const hueco = new Decimal(respaldo.disponible);
  return {
    prepaidAccountId,
    saldoPosteado: respaldo.saldoPosteado,
    yaAdoptado: respaldo.yaAdoptado,
    hueco: hueco.toFixed(4),
    hayHueco: hueco.greaterThan(0),
    asientos: r.rows,
  };
}

// ---- La casilla del cierre ----------------------------------------------

export interface AnticipoSinCorrer {
  id: string;
  description: string;
  remaining_amount: string;
}

export interface RevisionDeCierre {
  periodo: string;
  /** 'avisar' | 'bloquear', tal como lo dice el panel. */
  reaccion: string;
  reaccionDefinida: boolean;
  pendientes: AnticipoSinCorrer[];
  /** true = el cierre no debe continuar hasta correr la amortización. */
  bloquea: boolean;
  mensaje: string | null;
}

/**
 * LA CASILLA DEL CIERRE: qué calendarios no se corrieron en este periodo.
 *
 * Un calendario sin correr significa que el gasto de ese mes NO ESTÁ y que el
 * activo está sobrevaluado por el mismo importe — la forma exacta del defecto
 * que este tramo vino a cerrar, sólo que un mes cada vez. Si eso avisa o
 * detiene el cierre lo dice el despacho en `amortizacion_faltante_al_cierre`,
 * y el defecto declarado es 'avisar' porque es lo que ya contesta la casilla
 * hermana de la depreciación: dos situaciones idénticas donde una bloquea y la
 * otra avisa no enseñan nada a nadie.
 *
 * Devuelve el veredicto en vez de lanzarlo: quien cierra el periodo es otro
 * módulo y le toca a él decidir cómo lo presenta. Aquí sólo se responde qué
 * falta y qué dijo el panel.
 */
export async function revisionDeAmortizacionAlCierre(
  entityId: string,
  fiscalPeriodId: string
): Promise<RevisionDeCierre> {
  const tenantId = await inquilinoDeLaEntidad(entityId);
  const politica = await getPolicy({ tenantId, entityId }, 'amortizacion_faltante_al_cierre');

  const periodo = await query<{ period_name: string; start_date: Date; end_date: Date }>(
    `SELECT period_name, start_date, end_date
       FROM fiscal_periods
      WHERE id = $1 AND entity_id = $2`,
    [fiscalPeriodId, entityId]
  );
  const p = periodo.rows[0];
  if (!p) {
    throw new ValidationError(
      `El periodo fiscal ${fiscalPeriodId} no existe o no es de esta entidad. La revisión de ` +
        'amortizaciones no cruza entidades.'
    );
  }

  // Un anticipo cuenta como pendiente si su cobertura TOCA el periodo y no
  // tiene en él un renglón VIGENTE. Lo segundo es lo que importa; lo primero
  // evita el falso rojo del anticipo que empieza el mes que viene o que
  // terminó el año pasado.
  //
  // DOS COSAS QUE EL ATAQUE DE D1a OBLIGÓ A CORREGIR:
  //
  //   · el renglón tiene que estar VIGENTE. Con `NOT EXISTS (renglón)` a
  //     secas, revertir el asiento de enero apagaba la casilla igual: el
  //     gasto no estaba en el resultado, la 1160 lo seguía mostrando como
  //     activo, y el cierre pasaba en verde. Es exactamente lo que esta
  //     revisión existe para no dejar pasar.
  //   · el filtro no puede ser `status = 'active'`. Revertir el ÚLTIMO mes de
  //     un anticipo ya marcado `fully_amortized` lo dejaba fuera de la
  //     consulta, y ese es justo el caso en que hay un mes sin devengar.
  const r = await query<AnticipoSinCorrer>(
    `SELECT pe.id, pe.description,
            (pe.total_amount - ${DEVENGADO_VIGENTE})::text AS remaining_amount
       FROM prepaid_expenses pe
      WHERE pe.entity_id = $1
        AND pe.status <> 'cancelled'
        AND pe.coverage_start_date <= $3::date
        AND pe.coverage_end_date   >= $2::date
        AND pe.total_amount > ${DEVENGADO_VIGENTE}
        AND NOT EXISTS (
              SELECT 1 FROM prepaid_amortization_schedules s
               WHERE s.prepaid_expense_id = pe.id
                 AND s.fiscal_period_id = $4
                 AND s.entity_id = $1
                 AND ${RENGLON_VIGENTE}
            )
      ORDER BY pe.coverage_start_date ASC`,
    [entityId, p.start_date, p.end_date, fiscalPeriodId]
  );

  const bloquea = politica.value === 'bloquear' && r.rows.length > 0;
  const mensaje =
    r.rows.length === 0
      ? null
      : `${r.rows.length} pago(s) anticipado(s) sin amortizar en ${p.period_name}: el gasto de ` +
        'ese mes no está en el resultado y la 1160 lo sigue mostrando como activo. Corre ' +
        '`accruals run` antes de cerrar.';

  return {
    periodo: p.period_name,
    reaccion: politica.value,
    reaccionDefinida: politica.defined,
    pendientes: r.rows,
    bloquea,
    mensaje,
  };
}

// ---- Lecturas sueltas ----------------------------------------------------

/** Los anticipos vivos de una entidad. Acotado por entidad DENTRO del SQL. */
export async function anticiposActivos(entityId: string): Promise<PrepaidExpenseRow[]> {
  const r = await query<PrepaidExpenseRow>(
    `SELECT ${COLUMNAS} FROM prepaid_expenses
      WHERE entity_id = $1 AND status = 'active'
      ORDER BY coverage_start_date ASC`,
    [entityId]
  );
  return r.rows;
}

/**
 * LOS ANTICIPOS A LOS QUE EL MAYOR TODAVÍA LES DEBE GASTO. La lista de la corrida.
 *
 * No es `anticiposActivos`, y la diferencia es una reversa. La corrida se
 * gobernaba por la columna `status`, y `status` sólo cambia cuando la corrida
 * escribe: revertir el asiento del ÚLTIMO mes de un anticipo ya marcado
 * `fully_amortized` lo sacaba de la lista para siempre. El importe volvía a la
 * 1160 en el acto y nadie iba a devengarlo nunca — la promesa que este tramo
 * vino a cerrar, reabierta por la única corrección que el mayor admite.
 *
 * Aquí el criterio es el hecho, no la etiqueta: entra todo anticipo no
 * cancelado cuyo total supere lo que el mayor respalda. Un anticipo terminado
 * de verdad no entra porque la resta da cero, no porque una columna lo diga.
 */
export async function anticiposPorDevengar(entityId: string): Promise<PrepaidExpenseRow[]> {
  const r = await query<PrepaidExpenseRow>(
    `SELECT ${COLUMNAS} FROM prepaid_expenses pe
      WHERE pe.entity_id = $1
        AND pe.status <> 'cancelled'
        AND pe.total_amount > ${DEVENGADO_VIGENTE}
      ORDER BY pe.coverage_start_date ASC`,
    [entityId]
  );
  return r.rows;
}

/**
 * PONE LAS FICHAS DE LA ENTIDAD AL DÍA CON EL MAYOR. Idempotente.
 *
 * `amortized_to_date` es una CACHÉ de una suma sobre el mayor, y una caché que
 * sólo se refresca cuando su propio anticipo postea se queda atrás en cuanto
 * el mayor cambia por otra vía. La vía es la reversa, que no pasa por este
 * módulo: quien anula el asiento de un devengo lo hace desde `entry reverse`,
 * y la ficha se quedaba afirmando un importe que el resultado ya no tenía.
 *
 * Las tres lecturas que GUARDAN DINERO —`respaldoDisponible`,
 * `huecoDeAnticipados` y la casilla del cierre— se calculan en vivo contra el
 * mayor y no dependen de esto. Esta función es para que la columna que se
 * enseña en pantalla converja también, y por eso la corrida la llama antes de
 * mirar nada: es el momento en que este módulo vuelve a tener la palabra.
 *
 * El `IS DISTINCT FROM` del final la deja en cero escrituras cuando no hay
 * nada que corregir, que es el caso normal.
 */
export async function refrescarFichasDeAnticipos(entityId: string): Promise<number> {
  const r = await query(
    `UPDATE prepaid_expenses pe SET
       amortized_to_date = ${DEVENGADO_VIGENTE},
       last_amortization_date = (
         SELECT MAX(s.amortization_date)
           FROM prepaid_amortization_schedules s
          WHERE s.prepaid_expense_id = pe.id
            AND s.entity_id = pe.entity_id
            AND ${RENGLON_VIGENTE}
       ),
       status = CASE
                  WHEN ${DEVENGADO_VIGENTE} >= pe.total_amount THEN 'fully_amortized'
                  WHEN pe.status = 'fully_amortized'           THEN 'active'
                  ELSE pe.status
                END,
       updated_at = NOW()
     WHERE pe.entity_id = $1
       AND pe.status <> 'cancelled'
       AND pe.amortized_to_date IS DISTINCT FROM ${DEVENGADO_VIGENTE}`,
    [entityId]
  );
  return r.rowCount ?? 0;
}

/** Lo que el MAYOR respalda como devengado de un anticipo. Acotado por entidad. */
export async function devengadoEnElMayor(
  prepaidId: string,
  entityId: string,
  client?: pg.PoolClient
): Promise<string> {
  const ejecutar = client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
  const r = await ejecutar<{ devengado: string }>(
    `SELECT COALESCE(SUM(s.amortization_amount), 0)::text AS devengado
       FROM prepaid_amortization_schedules s
      WHERE s.prepaid_expense_id = $1 AND s.entity_id = $2 AND ${RENGLON_VIGENTE}`,
    [prepaidId, entityId]
  );
  return r.rows[0]?.devengado ?? '0';
}
