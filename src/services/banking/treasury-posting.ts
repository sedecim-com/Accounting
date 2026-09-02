import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { attestEntryAsync, createJournalEntry } from '../accounting/posting.js';
import { entityUsesCashBasisIva, ivaReclassificationsFor } from '../accounting/iva-cash-basis.js';
import { JournalEntryType } from '../../types/index.js';
import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';
import { resolverCuentaBancaria } from './bank-statement-service.js';
import { rangoDelPeriodo } from './reconciliation-service.js';

// ============================================================
// LOS TRES ASIENTOS DE TESORERÍA (F05d · 055)
//
// ÉSTE ES EL PRIMER ARCHIVO DE F05 QUE TOCA EL MAYOR. F05a construyó el
// documento, F05b el cotejo y F05c la aritmética, y ninguno posteó un asiento:
// `reconciliation-adjustments.ts` llega hasta el borrador y se detiene ahí a
// propósito. Aquí se contabiliza, y por eso todo lo de abajo se mide contra esa
// vara: lo que se escribe en el mayor no se puede corregir después mutándolo
// —la 041 lo impide con disparadores—, sólo por reversa (NIF B-1).
//
// LAS TRES DECISIONES CONTABLES QUE ESTE ARCHIVO EXISTE PARA NO EQUIVOCAR:
//
// 1. EL IVA DE LA COMISIÓN VA A 1135, NO A 1130. El cargo está en el extracto y
//    el dinero ya salió, pero el CFDI del banco no ha llegado, y sin
//    comprobante fiscal no hay acreditamiento (LIVA art. 5, frac. II): quien
//    acredita contra un cargo del estado de cuenta acredita contra un documento
//    que el SAT no reconoce. Se libera cuando el CFDI se ingiere, por el camino
//    que ya existe.
//
//    ESTO CONTRADICE EN APARIENCIA a `ROL_DE_AJUSTE['iva-comision']` de F05c,
//    que manda el IVA de un ajuste manual a `iva_acreditable`, y la diferencia
//    es real y vale nombrarla: allí el operador CAPTURA el importe porque está
//    mirando un comprobante, aquí el importe se deduce de un cargo del extracto
//    y nadie ha visto papel ninguno. El eje no es PUE/PPD —el flujo de efectivo
//    del art. 1-B—, que en una comisión se cumple en el instante del cargo: el
//    eje es el REQUISITO DE COMPROBANTE, y por eso el destino es distinto.
//
// 2. LA RETENCIÓN DE ISR SOBRE INTERESES NO ES GASTO. Es un pago provisional a
//    favor (1145). Tratarla como gasto la pierde —nadie la acredita en la
//    declaración anual— y además subestima el ingreso, porque entonces el
//    producto financiero se reconocería por el NETO que entró a la cuenta. El
//    catálogo se compromete a BRUTO: el interés se abona entero a 4310 y la
//    retención se carga aparte.
//
// 3. EL COBRO DEL CHEQUE SE FECHA EL DÍA QUE EL BANCO LO PAGÓ. Bajo la LIVA el
//    pago con cheque se entiende efectuado cuando el cheque SE COBRA, así que
//    la reclasificación de 1135 a 1130 pertenece al mes del cobro y a ningún
//    otro. Postearla hoy —o el día en que se firmó el cheque— es exactamente el
//    error que la fila 1271 existe para impedir, y es un error que CUADRA: el
//    asiento balancea igual de bien en el mes equivocado, y quien lo descubre
//    es el módulo fiscal tres meses después.
//
// LA FRONTERA VA DENTRO DEL SQL, COMO EN TODO EL MÓDULO. `bank_transactions` no
// tiene `entity_id`: cuelga de `bank_account_id` → `bank_accounts.entity_id`, y
// se acota por JOIN siempre, nunca filtrando en JS después. `vendor_payments`
// sí trae `entity_id` y aun así se exige en cada lectura Y en cada escritura:
// van tres fugas cerradas en este módulo y la última entró por un id que se dio
// por validado porque «la foránea ya lo comprobaba».
//
// CADA VERBO TIENE SU `source_type`. Sin ellos, los tres asientos aparecerían
// como pólizas manuales ante cualquier informe que separe «lo que vino de un
// subdiario» de «lo que alguien tecleó» —`ap-controls.ts` y `ar-controls.ts` lo
// hacen sobre 2110 y 1120—. Hoy ninguno de los tres toca esas dos cuentas de
// control, así que no ensucian el informe de F04; los `source_type` propios
// están igualmente porque el día que uno de ellos las toque, la protección ya
// estará puesta, y porque son lo que vuelve la contabilización IDEMPOTENTE: un
// cargo del extracto sólo se contabiliza una vez porque su asiento se puede
// buscar por (source_type, source_id).
// ============================================================

/** Comisión bancaria contabilizada desde el extracto. `source_id` = el movimiento. */
export const ORIGEN_COMISION = 'bank_fee';
/** Interés ganado contabilizado desde el extracto. `source_id` = el movimiento. */
export const ORIGEN_INTERES = 'bank_interest';
/** Reclasificación de IVA por cobro de cheque. `source_id` = el pago a proveedor. */
export const ORIGEN_COBRO_DE_CHEQUE = 'bank_check_clearing';

/**
 * Los tres, juntos y exportados, porque quien escriba un informe que separe
 * asientos de subdiario de pólizas manuales los va a necesitar enteros. Una
 * lista que hay que reconstruir leyendo tres constantes sueltas es una lista
 * que alguien va a reconstruir incompleta.
 */
export const ORIGENES_DE_TESORERIA = [
  ORIGEN_COMISION,
  ORIGEN_INTERES,
  ORIGEN_COBRO_DE_CHEQUE,
] as const;

/**
 * Cuatro decimales, los de la columna. NUNCA dos.
 *
 * `bank_transactions.amount` y `journal_entry_lines.debit_amount` son los dos
 * DECIMAL(19,4). Recortar a dos aquí fue el defecto que F05a cazó TRES veces:
 * convierte un descuadre de medio centavo en un cuadre perfecto, y el medio
 * centavo reaparece meses después sin nadie que sepa de dónde salió.
 */
const ESCALA = 4;

// ============================================================
// LA ARITMÉTICA, SIN BASE DE DATOS DETRÁS
//
// Todo lo de esta sección es puro a propósito: son las restas que, si salen
// mal, salen mal en silencio —un asiento descuadrado lo caza `validation.ts`,
// pero un asiento CUADRADO con la base y el IVA cambiados de sitio no lo caza
// nadie—. Escritas aquí se prueban con cuatro llamadas en vez de con cuatro
// escenarios de integración.
// ============================================================

/**
 * NINGUNA COMPARACIÓN DE SIGNO DE ESTE ARCHIVO USA `isPositive()`.
 *
 * En decimal.js el cero es POSITIVO —`new Decimal(0).isPositive()` es `true`,
 * porque el signo de +0 es 1—, así que `if (!x.isPositive())` deja pasar el
 * cero por el camino de los importes válidos. Aquí eso no es un detalle: una
 * comisión de cero habría emitido un cargo de `0.0000` contra 6310, y
 * `journal_entry_lines` lo rechaza con `CHECK (debit_amount > 0)` — el asiento
 * entero se caería en el INSERT, lejos de su causa, como ya pasó en F04 con la
 * línea de anticipo. Se compara siempre contra cero de forma explícita.
 */

/** Un importe a Decimal, en español y sin dejar pasar un NaN. */
function dec(valor: string, campo: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(valor);
  } catch {
    throw new ValidationError(`Importe ilegible en ${campo}: "${valor}".`);
  }
  if (!d.isFinite()) throw new ValidationError(`Importe no finito en ${campo}: "${valor}".`);
  return d;
}

/**
 * Una tasa como cadena, entre 0 y 1 sin llegar a 1.
 *
 * El tope no es una manía: con tasa 1 el despeje de la base divide entre cero
 * (IVA) o el del bruto divide entre cero (retención), y lo que sale de ahí es
 * Infinity, que decimal.js sí representa y que llegaría al asiento como un
 * importe. Se rechaza aquí, con el nombre del campo, en vez de allá.
 */
function tasaDe(valor: string, campo: string): Decimal {
  const d = dec(valor, campo);
  if (d.lessThan(0) || d.greaterThanOrEqualTo(1)) {
    throw new ValidationError(
      `La tasa de ${campo} tiene que ir entre 0 y 1 (0.16 para el 16%); llegó "${valor}".`
    );
  }
  return d;
}

/** Comisión partida en su costo y su impuesto. Suman EXACTAMENTE el total. */
export interface DesgloseDeComision {
  /** Lo que va a 6310. */
  base: string;
  /** Lo que se aparca en 1135. */
  iva: string;
  /** Lo que salió de la cuenta: base + iva, sin residuo. */
  total: string;
}

/**
 * El IVA CONTENIDO en un importe que ya lo trae dentro.
 *
 * El banco carga el total y no publica el desglose, así que se despeja: la base
 * es `total / (1 + tasa)` y el IVA es lo que sobra. NO al revés —`total × tasa`
 * calcularía el IVA sobre una base que ya incluye IVA y saldría de más—, que es
 * el error clásico de esta cuenta.
 *
 * El IVA se obtiene RESTANDO en vez de multiplicando para que base + IVA dé el
 * total exacto siempre. Calcular los dos por separado y redondear cada uno deja
 * un residuo de un diezmilésimo que descuadraría el asiento contra el abono a
 * banco, y `validateJournalEntry` exige igualdad EXACTA.
 */
export function desglosarComision(totalConIva: string, tasaIva: string): DesgloseDeComision {
  const total = dec(totalConIva, 'el importe de la comisión');
  if (total.lessThanOrEqualTo(0)) {
    throw new ValidationError(
      `Una comisión bancaria tiene que ser un importe positivo; llegó ${total.toFixed(ESCALA)}. ` +
        `El signo del extracto se quita antes de llamar aquí: lo que se desglosa es la magnitud.`
    );
  }
  const tasa = tasaDe(tasaIva, 'IVA');
  const base = total.dividedBy(tasa.plus(1)).toDecimalPlaces(ESCALA);
  return {
    base: base.toFixed(ESCALA),
    iva: total.minus(base).toFixed(ESCALA),
    total: total.toFixed(ESCALA),
  };
}

/**
 * El mismo desglose cuando el IVA lo dice el extracto (o el operador) en vez de
 * deducirse de una tasa.
 *
 * Un IVA mayor que el cargo no es un redondeo mal puesto, es un dato al revés
 * —casi siempre la base capturada donde iba el impuesto—, así que se rechaza
 * nombrando los dos números en vez de postear una base negativa que
 * `journal_entry_lines` acabaría rechazando lejos de su causa.
 */
export function desglosarComisionConIvaDeclarado(
  totalConIva: string,
  ivaDeclarado: string
): DesgloseDeComision {
  const total = dec(totalConIva, 'el importe de la comisión');
  if (total.lessThanOrEqualTo(0)) {
    throw new ValidationError(
      `Una comisión bancaria tiene que ser un importe positivo; llegó ${total.toFixed(ESCALA)}.`
    );
  }
  const iva = dec(ivaDeclarado, 'el IVA de la comisión');
  if (iva.lessThan(0)) {
    throw new ValidationError(`El IVA de una comisión no puede ser negativo; llegó ${iva.toFixed(ESCALA)}.`);
  }
  if (iva.greaterThan(total)) {
    throw new ValidationError(
      `El IVA declarado (${iva.toFixed(ESCALA)}) es mayor que el cargo entero ` +
        `(${total.toFixed(ESCALA)}). No se ajusta por su cuenta: revisa si se capturó la base ` +
        `donde iba el impuesto.`
    );
  }
  return {
    base: total.minus(iva).toFixed(ESCALA),
    iva: iva.toFixed(ESCALA),
    total: total.toFixed(ESCALA),
  };
}

/** Interés partido en lo que el banco reconoció y lo que retuvo. */
export interface DesgloseDeInteres {
  /** Lo que se abona a 4310: el interés ENTERO, antes de la retención. */
  bruto: string;
  /** Lo que se carga a 1145: el ISR que el banco enteró por la entidad. */
  retencion: string;
  /** Lo que de verdad entró a la cuenta. bruto − retencion, sin residuo. */
  neto: string;
}

/**
 * El interés bruto despejado desde lo que entró a la cuenta y la tasa de
 * retención.
 *
 * `--rate` es el flag del catálogo, y lo que nombra es la tasa de RETENCIÓN de
 * ISR, no la tasa de interés: el interés no se calcula aquí —lo calculó el
 * banco y lo dice el extracto—, lo que se despeja es cuánto se quedó por el
 * camino. Bruto = neto / (1 − tasa), y la retención se obtiene RESTANDO por la
 * misma razón que el IVA de arriba: neto + retención tiene que dar el bruto
 * exacto o el asiento no cuadra contra el abono a 4310.
 */
export function desglosarInteres(netoRecibido: string, tasaRetencion: string): DesgloseDeInteres {
  const neto = dec(netoRecibido, 'el interés recibido');
  if (neto.lessThanOrEqualTo(0)) {
    throw new ValidationError(
      `Un interés ganado tiene que ser un importe positivo; llegó ${neto.toFixed(ESCALA)}. ` +
        `Un abono que no entra a la cuenta no es un interés.`
    );
  }
  const tasa = tasaDe(tasaRetencion, 'retención de ISR');
  const bruto = neto.dividedBy(new Decimal(1).minus(tasa)).toDecimalPlaces(ESCALA);
  return {
    bruto: bruto.toFixed(ESCALA),
    retencion: bruto.minus(neto).toFixed(ESCALA),
    neto: neto.toFixed(ESCALA),
  };
}

/** El mismo desglose cuando el extracto publica la retención en pesos. */
export function desglosarInteresConRetencionDeclarada(
  netoRecibido: string,
  retencionDeclarada: string
): DesgloseDeInteres {
  const neto = dec(netoRecibido, 'el interés recibido');
  if (neto.lessThanOrEqualTo(0)) {
    throw new ValidationError(
      `Un interés ganado tiene que ser un importe positivo; llegó ${neto.toFixed(ESCALA)}.`
    );
  }
  const retencion = dec(retencionDeclarada, 'la retención de ISR');
  if (retencion.lessThan(0)) {
    throw new ValidationError(
      `La retención de ISR no puede ser negativa; llegó ${retencion.toFixed(ESCALA)}. ` +
        `Es un impuesto que el banco retiene, no uno que devuelve.`
    );
  }
  return {
    bruto: neto.plus(retencion).toFixed(ESCALA),
    retencion: retencion.toFixed(ESCALA),
    neto: neto.toFixed(ESCALA),
  };
}

/**
 * CÓMO SE OBTIENE EL IMPUESTO DE CADA CARGO, y por qué no hay valor por
 * omisión.
 *
 * En México la comisión bancaria casi siempre lleva IVA al 16%, y aun así
 * escribir ese 16% como constante sería una política contable disfrazada de
 * número: hubo un 15%, hay una tasa de frontera del 8%, y hay comisiones
 * exentas. Un valor por omisión aquí es una decisión fiscal que nadie tomó y
 * que nadie ve, tomada sobre TODOS los cargos del periodo a la vez.
 *
 * Así que el tratamiento es OBLIGATORIO y explícito. Los tres modos cubren lo
 * que de verdad pasa: el banco publica una tasa, el banco publica el impuesto
 * en pesos, o el cargo no lleva impuesto.
 */
export type TratamientoDeIva =
  /** El cargo no lleva IVA. El asiento sale sin línea de 1135. */
  | { modo: 'sin-iva' }
  /** El cargo lo trae DENTRO, a esta tasa. Se despeja. */
  | { modo: 'tasa'; tasa: string }
  /** El impuesto de cada movimiento, en pesos, por id. Lo que no aparece va sin IVA. */
  | { modo: 'importes'; porMovimiento: Readonly<Record<string, string>> };

/** El espejo del anterior para la retención de ISR sobre intereses. */
export type TratamientoDeRetencion =
  /** El abono entró íntegro. El asiento sale sin línea de 1145. */
  | { modo: 'sin-retencion' }
  /** El banco retuvo a esta tasa y depositó el neto. Se despeja el bruto. */
  | { modo: 'tasa'; tasa: string }
  /** La retención de cada movimiento, en pesos, por id. */
  | { modo: 'importes'; porMovimiento: Readonly<Record<string, string>> };

function aplicarTratamientoDeIva(
  tratamiento: TratamientoDeIva,
  transactionId: string,
  total: string
): DesgloseDeComision {
  switch (tratamiento.modo) {
    case 'sin-iva':
      return desglosarComisionConIvaDeclarado(total, '0');
    case 'tasa':
      return desglosarComision(total, tratamiento.tasa);
    case 'importes':
      return desglosarComisionConIvaDeclarado(
        total,
        tratamiento.porMovimiento[transactionId] ?? '0'
      );
  }
}

function aplicarTratamientoDeRetencion(
  tratamiento: TratamientoDeRetencion,
  transactionId: string,
  neto: string
): DesgloseDeInteres {
  switch (tratamiento.modo) {
    case 'sin-retencion':
      return desglosarInteresConRetencionDeclarada(neto, '0');
    case 'tasa':
      return desglosarInteres(neto, tratamiento.tasa);
    case 'importes':
      return desglosarInteresConRetencionDeclarada(
        neto,
        tratamiento.porMovimiento[transactionId] ?? '0'
      );
  }
}

// ============================================================
// EL ENSAYO, Y LA FRONTERA
// ============================================================

/** Centinela: la única salida de una transacción con el trabajo hecho y deshecho. */
class EnsayoDeTesoreria extends Error {
  constructor(readonly resultado: unknown) {
    super('dry run');
    this.name = 'EnsayoDeTesoreria';
  }
}

/**
 * Una línea del asiento, con la forma que `createJournalEntry` espera.
 *
 * Se declara aquí porque `posting.ts` no exporta la suya, y sin un tipo
 * explícito un arreglo que empieza con una línea de cargo se infiere como «sólo
 * cargos» y rechaza el abono que viene después.
 */
interface LineaDeAsiento {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
}

/**
 * Un acto de tesorería completo.
 *
 * `--dry-run` RECORRE EL CAMINO REAL y lo revierte, como el resto de F03/F04/
 * F05. Un ensayo que simula por otra rama prueba la rama que simula, no la que
 * escribe; el disparador de la 041, el CHECK de la 055 y el periodo cerrado
 * sólo se pronuncian sobre el camino de verdad.
 *
 * La atestación se dispara DESPUÉS del commit —el orquestador vuelve a leer el
 * asiento de la base, así que lanzarla antes es una carrera— y NUNCA en un
 * ensayo, porque en un ensayo el asiento no existe cuando el commit no ocurre.
 */
async function ejecutarActo<T>(
  correr: (client: pg.PoolClient, atestar: (tenantId: string, entityId: string, entryId: string) => void) => Promise<T>
): Promise<T> {
  const pendientes: { tenantId: string; entityId: string; entryId: string }[] = [];
  try {
    const resultado = await withTransaction((client) =>
      correr(client, (tenantId, entityId, entryId) =>
        pendientes.push({ tenantId, entityId, entryId })
      )
    );
    for (const p of pendientes) attestEntryAsync(p.tenantId, p.entityId, p.entryId);
    return resultado;
  } catch (e) {
    if (e instanceof EnsayoDeTesoreria) return e.resultado as T;
    throw e;
  }
}

interface FilaDeRol {
  role: string;
  account_id: string;
}

/**
 * Las cuentas de los roles pedidos, acotadas por entidad DENTRO del SQL.
 *
 * Mismo molde que `ar-ap-posting.ts`. `qualifier IS NULL` es el mapeo genérico:
 * los cualificados existen para desgloses por tercero y no se quieren aquí.
 */
async function roleAccounts(
  client: pg.PoolClient,
  entityId: string,
  roles: readonly AccountRole[]
): Promise<Map<string, string>> {
  const r = await client.query<FilaDeRol>(
    `SELECT role, account_id FROM account_roles
      WHERE entity_id = $1 AND role = ANY($2::text[]) AND qualifier IS NULL`,
    [entityId, roles]
  );
  return new Map(r.rows.map((f) => [f.role, f.account_id]));
}

/**
 * La cuenta de un rol, o el error que dice CUÁL falta y cómo se pone.
 *
 * Un rol sin mapear no se sustituye por la cuenta vecina: `comision_bancaria`
 * (6310) tiene por vecina `gasto` (6100), donde la comisión se mezclaría con
 * todo lo demás y dejaría de poder contarse, que es justo lo que una
 * conciliación existe para descubrir.
 */
function requireRole(map: Map<string, string>, role: AccountRole): string {
  const id = map.get(role);
  if (!id) {
    throw new ValidationError(
      `No hay cuenta mapeada al rol "${role}" en esta entidad, y no se elige una parecida: ` +
        `apúntala con \`mnemosine account role set ${role} <cuenta>\` o siembra la capa ` +
        `semántica con \`mnemosine init --section identity\`.`
    );
  }
  return id;
}

interface FilaCuentaDeTesoreria {
  id: string;
  account_name: string;
  account_type: string;
  currency_code: string;
  /** null cuando la cuenta de mayor NO pertenece al catálogo de esta entidad. */
  gl_de_la_entidad: string | null;
  moneda_funcional: string;
}

/**
 * La cuenta bancaria, su cuenta de mayor y la moneda funcional de la entidad,
 * en una sola lectura acotada por entidad en los DOS extremos del JOIN.
 *
 * El `LEFT JOIN ... AND a.entity_id = b.entity_id` no es decorativo: un renglón
 * heredado puede apuntar al catálogo de otra entidad, y sin la condición el
 * asiento se postearía contra una cuenta de mayor ajena —una fuga por el eje
 * que RLS no defiende, porque dentro de un inquilino con varias entidades RLS
 * no acota nada—.
 */
interface CuentaConMayor extends Omit<FilaCuentaDeTesoreria, 'gl_de_la_entidad'> {
  /**
   * Garantizado no nulo: `cuentaDeTesoreria` rechaza antes de devolver la
   * cuenta cuyo mapeo apunta al catálogo de otra entidad. El tipo lo dice para
   * que ningún llamador tenga que acordarse de comprobarlo otra vez.
   */
  gl_de_la_entidad: string;
}

async function cuentaDeTesoreria(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string
): Promise<CuentaConMayor> {
  const r = await client.query<FilaCuentaDeTesoreria>(
    `SELECT b.id, b.account_name, b.account_type, b.currency_code,
            a.id AS gl_de_la_entidad,
            e.functional_currency AS moneda_funcional
       FROM bank_accounts b
       JOIN legal_entities e ON e.id = b.entity_id
       LEFT JOIN accounts a ON a.id = b.gl_account_id AND a.entity_id = b.entity_id
      WHERE b.id = $1 AND b.entity_id = $2`,
    [bankAccountId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Bank Account', bankAccountId);
  const cuenta = r.rows[0];

  if (!cuenta.gl_de_la_entidad) {
    throw new ValidationError(
      `La cuenta bancaria "${cuenta.account_name}" apunta a una cuenta de mayor que no pertenece ` +
        `al catálogo de esta entidad. No se postea contra ella: átala a una cuenta propia con ` +
        `\`mnemosine bank account edit\`.`
    );
  }

  // EL ASIENTO SE ESCRIBE EN MONEDA FUNCIONAL Y ESTE ARCHIVO NO CONVIERTE.
  // Postear el importe de una cuenta en dólares como si fueran pesos cuadra
  // perfectamente y deja el mayor mintiendo por el tipo de cambio entero. La
  // conversión pertenece al camino multimoneda —`foreign_debit`,
  // `exchange_rate`—, que hoy `posting.ts` no escribe (fila 554 del catálogo).
  if (cuenta.currency_code !== cuenta.moneda_funcional) {
    throw new ValidationError(
      `La cuenta "${cuenta.account_name}" lleva ${cuenta.currency_code} y la entidad contabiliza ` +
        `en ${cuenta.moneda_funcional}. Aquí no se convierte: un importe posteado sin tipo de ` +
        `cambio cuadra igual y deja el mayor equivocado por la diferencia entera.`
    );
  }
  // LA TARJETA DE CRÉDITO NO PASA POR AQUÍ, y se dice en vez de posteársele
  // algo plausible. Su cuenta de mayor es un PASIVO —la 051 lo distingue en el
  // CHECK de `account_type` y `enMarcoDelMayor` tuvo que normalizar su signo
  // para que la conciliación no diera el doble del saldo—, así que un cargo
  // suyo no «sale» de un activo: aumenta lo que se debe. Y su interés es
  // interés PAGADO, un costo financiero, que abonado a 4310 inflaría el ingreso
  // con un gasto. Las dos cosas cuadran y las dos están mal.
  if (cuenta.account_type === 'credit-card') {
    throw new ValidationError(
      `"${cuenta.account_name}" es una tarjeta de crédito, y su cuenta de mayor es un pasivo: ` +
        `sus cargos no salen de un activo y su interés es interés PAGADO, no un producto ` +
        `financiero. Estos dos verbos son para cuentas de depósito.`
    );
  }
  return { ...cuenta, gl_de_la_entidad: cuenta.gl_de_la_entidad };
}

interface FilaPeriodo {
  id: string;
  period_name: string;
  status: string;
}

/**
 * El periodo fiscal de una fecha, con su estado.
 *
 * Se consulta ANTES de crear el asiento, y no se deja que `createJournalEntry`
 * falle: allí el rechazo es un `AccountingError` en inglés que dice «No open
 * fiscal period found for the entry date» y ABORTA LA TRANSACCIÓN ENTERA, con
 * lo que un solo cargo de un periodo cerrado tumbaría los otros once que sí se
 * podían contabilizar. Preguntando antes, ese cargo se omite con su motivo y el
 * resto se postea.
 */
async function periodoDeLaFecha(
  client: pg.PoolClient,
  entityId: string,
  fecha: string
): Promise<FilaPeriodo | null> {
  const r = await client.query<FilaPeriodo>(
    `SELECT id, period_name, status
       FROM fiscal_periods
      WHERE entity_id = $1 AND start_date <= $2::date AND end_date >= $2::date
      ORDER BY period_number ASC
      LIMIT 1`,
    [entityId, fecha]
  );
  return r.rows[0] ?? null;
}

/**
 * UNA FECHA ISO CONVERTIDA AL `Date` QUE `createJournalEntry` ESPERA, Y POR QUÉ
 * NO LLEVA LA `Z`.
 *
 * `posting.ts` recibe un `Date` y lo usa para TRES cosas —buscar el periodo
 * fiscal, numerar el folio del ejercicio (043) y guardar `entry_date`—, y lo
 * pasa tal cual al driver, que serializa un `Date` en la ZONA HORARIA DEL
 * PROCESO. Con `T00:00:00Z` la medianoche UTC del 1 de junio es, en México
 * (UTC−6), el 31 de mayo a las 18:00: el asiento se guardaba fechado el día
 * ANTERIOR y colgado del periodo fiscal de ese día.
 *
 * En un día cualquiera eso es un renglón con la fecha corrida. EL PRIMERO DE
 * MES ES OTRA COSA: un cheque que el banco cobró el 1 de junio reclasificaba su
 * IVA en MAYO, que es exactamente la declaración mensual equivocada que este
 * módulo existe para impedir —y el asiento CUADRA igual de bien en el mes malo,
 * así que no lo caza nadie hasta que el módulo fiscal cierra el bimestre—. Y el
 * 1 de enero se lleva además el folio al ejercicio anterior.
 *
 * Medianoche LOCAL da la vuelta entera sin moverse, que es lo que hacen los
 * otros tres sitios del sistema que crean asientos desde una fecha ISO
 * (`journal-entry-service.ts`, `draft-service.ts` y el posteo de ajustes de
 * `reconciliation-service.ts`). Este archivo era el único que no.
 */
/**
 * Ata el movimiento del extracto a la línea de banco del asiento que lo
 * explica, para que deje de contar como «sin explicar».
 *
 * Se escribe SIN sesión (`reconciliation_session_id` es nullable) porque
 * contabilizar la comisión o el interés del mes no exige tener una sesión
 * abierta, y atarlo a una que quizá no existe habría dejado sin cotejar
 * justamente el caso en que nadie lo está vigilando.
 *
 * `WHERE NOT EXISTS` sobre los cotejos VIVOS: si alguien ya lo cotejó a mano
 * entre el asiento y esto, no se escribe un segundo que lo explicaría dos
 * veces.
 */
async function cotejarMovimientoConSuLinea(
  client: pg.PoolClient,
  a: {
    transactionId: string;
    entryId: string;
    cuentaGl: string;
    importe: string;
    userId: string;
    nota: string;
  }
): Promise<void> {
  const linea = await client.query<{ id: string }>(
    `SELECT id FROM journal_entry_lines
      WHERE journal_entry_id = $1 AND account_id = $2
      ORDER BY line_number LIMIT 1`,
    [a.entryId, a.cuentaGl]
  );
  if (linea.rows.length === 0) return;

  await client.query(
    `INSERT INTO reconciliation_matches (
       id, bank_transaction_id, match_type, matched_entity_type,
       matched_entity_id, matched_amount, is_partial, matched_by, notes
     )
     SELECT gen_random_uuid(), $1, 'automatic', 'journal_entry_line', $2, $3, false, $4, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM reconciliation_matches rm
         WHERE rm.bank_transaction_id = $1 AND rm.unapplied_at IS NULL
      )`,
    [a.transactionId, linea.rows[0].id, a.importe, a.userId, a.nota]
  );

  await client.query(
    `UPDATE bank_transactions SET is_matched = true, matched_at = NOW(), matched_by = $1
      WHERE id = $2`,
    [a.userId, a.transactionId]
  );
}

function fechaDelAsiento(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

/** `hard_close` y `locked` son los dos que `posting.ts` rechaza al contabilizar. */
function periodoCerrado(periodo: FilaPeriodo | null): boolean {
  return periodo === null || periodo.status === 'hard_close' || periodo.status === 'locked';
}

function motivoDePeriodo(periodo: FilaPeriodo | null, fecha: string): string {
  return periodo === null
    ? `no hay periodo fiscal que contenga el ${fecha}`
    : `el periodo ${periodo.period_name} está en '${periodo.status}'`;
}

/**
 * El asiento que ya contabilizó este hecho, si existe.
 *
 * ES LA IDEMPOTENCIA, y es estructural: no hay bandera en `bank_transactions`
 * que alguien pueda olvidarse de poner: la pregunta se le hace al mayor, que es
 * quien sabe la respuesta. Acotada por entidad porque `journal_entries` la
 * lleva y porque el par (source_type, source_id) NO es único por sí solo:
 * `uq_je_document_source` (025) cubre cuatro orígenes y ninguno es de éstos.
 */
async function asientoPrevio(
  client: pg.PoolClient,
  entityId: string,
  sourceType: string,
  sourceId: string
): Promise<{ id: string; entry_number: string } | null> {
  const r = await client.query<{ id: string; entry_number: string }>(
    `SELECT id, entry_number
       FROM journal_entries
      WHERE entity_id = $1 AND source_type = $2 AND source_id = $3
        AND status <> 'void'
      ORDER BY created_at ASC
      LIMIT 1`,
    [entityId, sourceType, sourceId]
  );
  return r.rows[0] ?? null;
}

// ============================================================
// 1 · LAS COMISIONES DEL PERIODO (fila 1259)
// ============================================================

interface FilaMovimiento {
  id: string;
  fecha: string;
  importe: string;
  descripcion: string | null;
  contraparte: string | null;
}

/** Un cargo por comisión, ya contabilizado. */
export interface ComisionContabilizada {
  transactionId: string;
  fecha: string;
  descripcion: string | null;
  /** Lo que salió de la cuenta, en magnitud y con los cuatro decimales. */
  total: string;
  /** Lo que fue a 6310. */
  base: string;
  /** Lo que quedó aparcado en 1135. */
  iva: string;
  /** null en un ensayo: el asiento se creó y se deshizo. */
  entryId: string | null;
  entryNumber: string | null;
}

/**
 * Por qué un movimiento del periodo no acabó en el mayor.
 *
 * `signo-contrario` es el que menos se espera y el que más importa: un
 * movimiento clasificado como comisión que METE dinero es una devolución de
 * comisión, y uno clasificado como interés que lo SACA es un interés pagado.
 * Los dos se contabilizan al revés si se les quita el signo y se posteán como
 * si fueran lo que dice su etiqueta, y los dos cuadran perfectamente así.
 */
export type MotivoDeOmision =
  | 'ya-contabilizada'
  | 'sobre-el-tope'
  | 'periodo-cerrado'
  | 'signo-contrario';

export interface MovimientoOmitido {
  transactionId: string;
  fecha: string;
  total: string;
  motivo: MotivoDeOmision;
  detalle: string;
}

export interface ResultadoDeComisiones {
  cuenta: { id: string; nombre: string };
  periodo: { desde: string; hasta: string };
  contabilizadas: ComisionContabilizada[];
  /** Lo que NO se contabilizó, con el porqué de cada una. Nunca en silencio. */
  omitidas: MovimientoOmitido[];
  totales: { total: string; base: string; iva: string };
  ensayo: boolean;
}

export interface OpcionesDeComisiones {
  /** `--period YYYY-MM`. */
  periodo: string;
  /** Obligatorio y sin valor por omisión: ver `TratamientoDeIva`. */
  iva: TratamientoDeIva;
  /**
   * `--max-amount`: por encima de este importe el cargo NO se contabiliza solo.
   * No es una validación, es un tope de confianza: un cargo grande casi nunca
   * es una comisión de manejo de cuenta, y contabilizarlo como tal lo entierra
   * en 6310 donde nadie lo va a volver a mirar.
   */
  maxAmount?: string;
  userId: string;
  dryRun?: boolean;
}

/**
 * Contabiliza las comisiones bancarias del periodo, una por cargo.
 *
 * DE DÓNDE SALEN LOS CARGOS. Del extracto: `bank_transactions` con
 * `transaction_type = 'fee'` en el rango. Ésa es la clasificación que ya hizo
 * quien importó el archivo, y es la única «regla» que el esquema tiene hoy —no
 * existe una tabla de reglas de banco; `processing_rules` (005) es de la
 * ingesta de CFDI y no clasifica movimientos bancarios—. Cuando exista, lo que
 * cambia es esta consulta y nada más.
 *
 * UN ASIENTO POR CARGO, y no uno por periodo. Cuesta más filas y compra dos
 * cosas que un asiento resumen no puede dar: la idempotencia por
 * (source_type, source_id) —reejecutar el mes no duplica nada— y la reversa
 * quirúrgica del cargo que salió mal, sin tocar los otros once.
 */
export async function contabilizarComisiones(
  entityId: string,
  cuentaAguja: string,
  opts: OpcionesDeComisiones
): Promise<ResultadoDeComisiones> {
  const { desde, hasta } = rangoDelPeriodo(opts.periodo);
  const tope = opts.maxAmount === undefined ? null : dec(opts.maxAmount, '--max-amount');
  if (tope && tope.lessThanOrEqualTo(0)) {
    throw new ValidationError(`El tope --max-amount tiene que ser positivo; llegó "${opts.maxAmount}".`);
  }
  const aguja = await resolverCuentaBancaria(entityId, cuentaAguja);

  return ejecutarActo(async (client, atestar) => {
    const cuenta = await cuentaDeTesoreria(client, entityId, aguja.id);
    const tenantId = await tenantDe(client, entityId);

    const movs = await client.query<FilaMovimiento>(
      // LA FRONTERA POR JOIN: `bank_transactions` no tiene `entity_id`. Se
      // proyecta `::text` para que el importe llegue con sus cuatro decimales
      // y no como el float en que pg convierte un NUMERIC por omisión.
      `SELECT bt.id,
              bt.transaction_date::text AS fecha,
              bt.amount::text           AS importe,
              bt.description            AS descripcion,
              bt.merchant_name          AS contraparte
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE bt.bank_account_id = $1
          AND ba.entity_id = $2
          AND bt.transaction_type = 'fee'
          AND bt.transaction_date >= $3::date
          AND bt.transaction_date <= $4::date
        ORDER BY bt.transaction_date, bt.id`,
      [cuenta.id, entityId, desde, hasta]
    );

    const contabilizadas: ComisionContabilizada[] = [];
    const omitidas: MovimientoOmitido[] = [];
    let sumaTotal = new Decimal(0);
    let sumaBase = new Decimal(0);
    let sumaIva = new Decimal(0);

    for (const mov of movs.rows) {
      const firmado = dec(mov.importe, `el movimiento ${mov.id}`);
      // Una comisión SALE de la cuenta. Un movimiento clasificado 'fee' con
      // signo de entrada es una devolución de comisión, y contabilizarla como
      // gasto la sumaría al costo en vez de restarla. No se voltea el signo en
      // silencio: se omite y se dice.
      if (firmado.greaterThanOrEqualTo(0)) {
        omitidas.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: firmado.toFixed(ESCALA),
          motivo: 'signo-contrario',
          detalle:
            `el movimiento está clasificado como comisión pero METE dinero en la cuenta ` +
            `(${firmado.toFixed(ESCALA)}): una devolución de comisión no es un gasto y no se ` +
            `contabiliza aquí con el signo volteado`,
        });
        continue;
      }
      const total = firmado.abs();

      const previo = await asientoPrevio(client, entityId, ORIGEN_COMISION, mov.id);
      if (previo) {
        omitidas.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: total.toFixed(ESCALA),
          motivo: 'ya-contabilizada',
          detalle: `ya la contabilizó la póliza ${previo.entry_number}`,
        });
        continue;
      }

      if (tope && total.greaterThan(tope)) {
        omitidas.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: total.toFixed(ESCALA),
          motivo: 'sobre-el-tope',
          detalle: `pasa del tope de ${tope.toFixed(ESCALA)} y quiere ojos humanos`,
        });
        continue;
      }

      const periodo = await periodoDeLaFecha(client, entityId, mov.fecha);
      if (periodoCerrado(periodo)) {
        omitidas.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: total.toFixed(ESCALA),
          motivo: 'periodo-cerrado',
          detalle: `${motivoDePeriodo(periodo, mov.fecha)}; no se postea a la fuerza`,
        });
        continue;
      }

      const desglose = aplicarTratamientoDeIva(opts.iva, mov.id, total.toFixed(ESCALA));
      const roles = await roleAccounts(
        client,
        entityId,
        new Decimal(desglose.iva).greaterThan(0)
          ? (['comision_bancaria', 'iva_pendiente_acreditar'] as const)
          : (['comision_bancaria'] as const)
      );

      const etiqueta = mov.descripcion?.trim() || mov.contraparte?.trim() || 'Bank fee';
      const lineas: LineaDeAsiento[] = [];
      if (new Decimal(desglose.base).greaterThan(0)) {
        lineas.push({
          account_id: requireRole(roles, 'comision_bancaria'),
          debit_amount: desglose.base,
          credit_amount: null,
          description: `Bank fee ${mov.fecha} - ${etiqueta}`,
        });
      }
      if (new Decimal(desglose.iva).greaterThan(0)) {
        lineas.push({
          account_id: requireRole(roles, 'iva_pendiente_acreditar'),
          debit_amount: desglose.iva,
          credit_amount: null,
          // La frase va EN EL ASIENTO y no sólo en este archivo: quien lea el
          // mayor dentro de un año tiene que poder saber por qué este IVA está
          // en 1135 y no en 1130 sin abrir el código.
          description: `VAT on bank fee parked in 1135 - no CFDI from the bank yet - ${etiqueta}`,
        });
      }
      lineas.push({
        account_id: cuenta.gl_de_la_entidad,
        debit_amount: null,
        credit_amount: desglose.total,
        description: `Bank fee charged ${mov.fecha} - ${etiqueta}`,
      });

      const asiento = await createJournalEntry(
        entityId,
        // MEDIANOCHE LOCAL Y NO UTC. `createJournalEntry` recibe un `Date` y lo
        // manda al driver, que lo serializa en la ZONA HORARIA DEL PROCESO: en
        // México (UTC−6) la medianoche UTC de un día es el día ANTERIOR a las
        // 18:00, y el asiento se guardaba fechado un día antes —y colgado del
        // periodo fiscal de ese día anterior—. Ver `fechaDelAsiento`.
        fechaDelAsiento(mov.fecha),
        JournalEntryType.AUTO_RECONCILIATION,
        `Bank fee ${mov.fecha} - ${cuenta.account_name} - ${etiqueta}`,
        lineas,
        opts.userId,
        {
          autoPost: true,
          client,
          sourceType: ORIGEN_COMISION,
          sourceId: mov.id,
          reference: mov.fecha,
        }
      );
      atestar(tenantId, entityId, asiento.id);

      // ── EL COTEJO QUE CIERRA EL CÍRCULO ──
      //
      // SIN ESTO, EL MISMO CARGO SE CONTABILIZA DOS VECES Y LA SESIÓN LO
      // TAPA. `clasificarPartidas` y `movimientosSinExplicar` preguntan por
      // COTEJOS VIVOS, no por la caché `is_matched`. Un cargo contabilizado
      // por aquí y sin cotejo levanta DOS partidas conciliatorias por el mismo
      // hecho —`cargo-del-banco` del lado del banco y su gemela del lado de
      // libros—, que se anulan entre sí: la sesión informa variación cero y
      // «cuadra», y sobre esa base se puede contabilizar la comisión otra vez
      // sin que nada proteste, porque la segunda partida absorbe el desvío.
      //
      // Medido antes de este arreglo: un cargo de −348 daba dos partidas por
      // −696 en total y `cuadra: true`.
      //
      // `contabilizarSesion` ya lo hacía; este camino era el que faltaba. Va
      // SIN sesión a propósito —`reconciliation_session_id` es nullable— porque
      // contabilizar la comisión del mes no exige que haya una sesión abierta,
      // y atarlo a una que quizá no existe habría hecho lo contrario de lo que
      // se quiere: dejarlo sin cotejar justo cuando no hay sesión que lo vigile.
      await cotejarMovimientoConSuLinea(client, {
        transactionId: mov.id,
        entryId: asiento.id,
        cuentaGl: cuenta.gl_de_la_entidad,
        importe: desglose.total,
        userId: opts.userId,
        nota: 'Cotejo automático del cargo que este asiento explica',
      });

      contabilizadas.push({
        transactionId: mov.id,
        fecha: mov.fecha,
        descripcion: mov.descripcion,
        total: desglose.total,
        base: desglose.base,
        iva: desglose.iva,
        entryId: asiento.id,
        entryNumber: asiento.entry_number,
      });
      sumaTotal = sumaTotal.plus(desglose.total);
      sumaBase = sumaBase.plus(desglose.base);
      sumaIva = sumaIva.plus(desglose.iva);
    }

    const resultado: ResultadoDeComisiones = {
      cuenta: { id: cuenta.id, nombre: cuenta.account_name },
      periodo: { desde, hasta },
      contabilizadas,
      omitidas,
      totales: {
        total: sumaTotal.toFixed(ESCALA),
        base: sumaBase.toFixed(ESCALA),
        iva: sumaIva.toFixed(ESCALA),
      },
      ensayo: opts.dryRun === true,
    };
    if (opts.dryRun) {
      // El ensayo devuelve lo que HABRÍA pasado, con los ids en null: un ensayo
      // que devuelve el id de un asiento que se deshizo invita a buscarlo.
      throw new EnsayoDeTesoreria({
        ...resultado,
        contabilizadas: contabilizadas.map((c) => ({ ...c, entryId: null, entryNumber: null })),
      });
    }
    return resultado;
  });
}

// ============================================================
// 2 · LOS INTERESES DEL PERIODO (fila 1260)
// ============================================================

export interface InteresContabilizado {
  transactionId: string;
  fecha: string;
  descripcion: string | null;
  /** El interés ENTERO, que es lo que se reconoce como ingreso. */
  bruto: string;
  /** El ISR que retuvo el banco: pago provisional a favor, jamás gasto. */
  retencion: string;
  /** Lo que de verdad entró a la cuenta. */
  neto: string;
  entryId: string | null;
  entryNumber: string | null;
}

export interface ResultadoDeIntereses {
  cuenta: { id: string; nombre: string };
  periodo: { desde: string; hasta: string };
  contabilizados: InteresContabilizado[];
  omitidos: MovimientoOmitido[];
  totales: { bruto: string; retencion: string; neto: string };
  ensayo: boolean;
}

export interface OpcionesDeIntereses {
  periodo: string;
  /** Obligatorio y sin valor por omisión: ver `TratamientoDeRetencion`. */
  retencion: TratamientoDeRetencion;
  maxAmount?: string;
  userId: string;
  dryRun?: boolean;
}

/**
 * Contabiliza los intereses ganados del periodo, uno por abono.
 *
 * EL ASIENTO, Y LA RAZÓN DE QUE TENGA TRES LÍNEAS Y NO DOS:
 *
 *   DR banco                  el neto que de verdad entró
 *   DR isr_retenido_a_favor   lo que el banco enteró por la entidad (1145)
 *   CR producto_financiero    el interés BRUTO (4310)
 *
 * La versión de dos líneas —DR banco / CR 4310 por el neto— cuadra igual de
 * bien y es la que se escribe sola cuando nadie piensa. Cuesta dos cosas: PIERDE
 * la retención, porque un ISR que nunca se registró como saldo a favor no lo
 * acredita nadie en la declaración anual y se regala al fisco; y SUBESTIMA el
 * ingreso, porque el producto financiero del ejercicio queda corto por la
 * retención de todo el año. Por eso el catálogo se compromete a BRUTO.
 *
 * Y la retención NO va a una cuenta de gasto. `isr_retenido_a_favor` es un
 * ACTIVO (1145): es dinero de la entidad que está en poder del SAT. Mandarlo a
 * 6310 o a un «impuestos» de resultados lo convierte en costo del ejercicio y
 * lo borra del balance, que es la forma cara del mismo error.
 */
export async function contabilizarIntereses(
  entityId: string,
  cuentaAguja: string,
  opts: OpcionesDeIntereses
): Promise<ResultadoDeIntereses> {
  const { desde, hasta } = rangoDelPeriodo(opts.periodo);
  const tope = opts.maxAmount === undefined ? null : dec(opts.maxAmount, '--max-amount');
  if (tope && tope.lessThanOrEqualTo(0)) {
    throw new ValidationError(`El tope --max-amount tiene que ser positivo; llegó "${opts.maxAmount}".`);
  }
  const aguja = await resolverCuentaBancaria(entityId, cuentaAguja);

  return ejecutarActo(async (client, atestar) => {
    const cuenta = await cuentaDeTesoreria(client, entityId, aguja.id);
    const tenantId = await tenantDe(client, entityId);

    const movs = await client.query<FilaMovimiento>(
      `SELECT bt.id,
              bt.transaction_date::text AS fecha,
              bt.amount::text           AS importe,
              bt.description            AS descripcion,
              bt.merchant_name          AS contraparte
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE bt.bank_account_id = $1
          AND ba.entity_id = $2
          AND bt.transaction_type = 'interest'
          AND bt.transaction_date >= $3::date
          AND bt.transaction_date <= $4::date
        ORDER BY bt.transaction_date, bt.id`,
      [cuenta.id, entityId, desde, hasta]
    );

    const contabilizados: InteresContabilizado[] = [];
    const omitidos: MovimientoOmitido[] = [];
    let sumaBruto = new Decimal(0);
    let sumaRet = new Decimal(0);
    let sumaNeto = new Decimal(0);

    for (const mov of movs.rows) {
      const firmado = dec(mov.importe, `el movimiento ${mov.id}`);
      // Un interés ENTRA. Uno clasificado 'interest' que saca dinero es un
      // interés PAGADO —un costo financiero, no un producto—, y abonarlo a 4310
      // inflaría el ingreso con un gasto.
      if (firmado.lessThanOrEqualTo(0)) {
        omitidos.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: firmado.toFixed(ESCALA),
          motivo: 'signo-contrario',
          detalle:
            `el movimiento está clasificado como interés pero SACA dinero de la cuenta ` +
            `(${firmado.toFixed(ESCALA)}): un interés pagado es un costo financiero y no un ` +
            `producto, y no se abona a 4310`,
        });
        continue;
      }

      const previo = await asientoPrevio(client, entityId, ORIGEN_INTERES, mov.id);
      if (previo) {
        omitidos.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: firmado.toFixed(ESCALA),
          motivo: 'ya-contabilizada',
          detalle: `ya lo contabilizó la póliza ${previo.entry_number}`,
        });
        continue;
      }

      if (tope && firmado.greaterThan(tope)) {
        omitidos.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: firmado.toFixed(ESCALA),
          motivo: 'sobre-el-tope',
          detalle: `pasa del tope de ${tope.toFixed(ESCALA)} y quiere ojos humanos`,
        });
        continue;
      }

      const periodo = await periodoDeLaFecha(client, entityId, mov.fecha);
      if (periodoCerrado(periodo)) {
        omitidos.push({
          transactionId: mov.id,
          fecha: mov.fecha,
          total: firmado.toFixed(ESCALA),
          motivo: 'periodo-cerrado',
          detalle: `${motivoDePeriodo(periodo, mov.fecha)}; no se postea a la fuerza`,
        });
        continue;
      }

      const desglose = aplicarTratamientoDeRetencion(
        opts.retencion,
        mov.id,
        firmado.toFixed(ESCALA)
      );
      const roles = await roleAccounts(
        client,
        entityId,
        new Decimal(desglose.retencion).greaterThan(0)
          ? (['producto_financiero', 'isr_retenido_a_favor'] as const)
          : (['producto_financiero'] as const)
      );

      const etiqueta = mov.descripcion?.trim() || mov.contraparte?.trim() || 'Interest earned';
      const lineas: LineaDeAsiento[] = [
        {
          account_id: cuenta.gl_de_la_entidad,
          debit_amount: desglose.neto,
          credit_amount: null,
          description: `Interest credited ${mov.fecha} (net) - ${etiqueta}`,
        },
      ];
      if (new Decimal(desglose.retencion).greaterThan(0)) {
        lineas.push({
          account_id: requireRole(roles, 'isr_retenido_a_favor'),
          debit_amount: desglose.retencion,
          credit_amount: null,
          // Igual que el IVA de la comisión: la razón viaja en el asiento.
          description: `ISR withheld by the bank - prepayment in our favour, NOT an expense - ${etiqueta}`,
        });
      }
      lineas.push({
        account_id: requireRole(roles, 'producto_financiero'),
        debit_amount: null,
        credit_amount: desglose.bruto,
        description: `Interest earned ${mov.fecha} (gross) - ${etiqueta}`,
      });

      const asiento = await createJournalEntry(
        entityId,
        fechaDelAsiento(mov.fecha),
        JournalEntryType.AUTO_RECONCILIATION,
        `Interest earned ${mov.fecha} - ${cuenta.account_name} - ${etiqueta}`,
        lineas,
        opts.userId,
        {
          autoPost: true,
          client,
          sourceType: ORIGEN_INTERES,
          sourceId: mov.id,
          reference: mov.fecha,
        }
      );
      atestar(tenantId, entityId, asiento.id);

      // El mismo cotejo que cierra el círculo del cargo, por la misma razón:
      // un abono contabilizado y sin cotejo levanta dos partidas que se anulan,
      // la sesión dice que cuadra, y el interés se puede contabilizar otra vez.
      // El importe que explica el movimiento es el NETO —lo que de verdad
      // entró al banco—, no el bruto: el bruto incluye una retención que nunca
      // pasó por la cuenta.
      await cotejarMovimientoConSuLinea(client, {
        transactionId: mov.id,
        entryId: asiento.id,
        cuentaGl: cuenta.gl_de_la_entidad,
        importe: desglose.neto,
        userId: opts.userId,
        nota: 'Cotejo automático del abono que este asiento explica',
      });

      contabilizados.push({
        transactionId: mov.id,
        fecha: mov.fecha,
        descripcion: mov.descripcion,
        bruto: desglose.bruto,
        retencion: desglose.retencion,
        neto: desglose.neto,
        entryId: asiento.id,
        entryNumber: asiento.entry_number,
      });
      sumaBruto = sumaBruto.plus(desglose.bruto);
      sumaRet = sumaRet.plus(desglose.retencion);
      sumaNeto = sumaNeto.plus(desglose.neto);
    }

    const resultado: ResultadoDeIntereses = {
      cuenta: { id: cuenta.id, nombre: cuenta.account_name },
      periodo: { desde, hasta },
      contabilizados,
      omitidos,
      totales: {
        bruto: sumaBruto.toFixed(ESCALA),
        retencion: sumaRet.toFixed(ESCALA),
        neto: sumaNeto.toFixed(ESCALA),
      },
      ensayo: opts.dryRun === true,
    };
    if (opts.dryRun) {
      throw new EnsayoDeTesoreria({
        ...resultado,
        contabilizados: contabilizados.map((c) => ({ ...c, entryId: null, entryNumber: null })),
      });
    }
    return resultado;
  });
}

// ============================================================
// 3 · EL CHEQUE COBRADO (fila 1271)
//
// «El comando más transversal del catálogo», y lo es porque cruza tres cosas
// que en el sistema vivían separadas: un pago a proveedor de CxP, un movimiento
// del extracto y el IVA acreditable del módulo fiscal.
//
// UN CHEQUE NO ES UNA ENTIDAD AQUÍ, Y NO SE INVENTA. Un cheque YA ES un
// `vendor_payments` con `payment_method = 'check'` y su `check_number`
// (002:122-124). El registro como sustantivo propio —`bank check list|issue|
// void`, con folio, beneficiario, máquina de estados y el reloj del art. 181
// LGTOC— es de fase 2, y adelantarlo a medias aquí sería peor que no tenerlo:
// media máquina de estados es una que miente sobre los estados que no modela.
// ============================================================

interface FilaPagoConCheque {
  id: string;
  payment_number: string;
  check_number: string | null;
  payment_method: string;
  payment_amount: string;
  payment_date: string;
  currency_code: string;
  status: string;
  bank_account_id: string | null;
  check_cleared_date: string | null;
  check_cleared_tx_id: string | null;
}

interface FilaMovimientoDeCobro {
  id: string;
  fecha: string;
  importe: string;
  descripcion: string | null;
  bank_account_id: string;
  /** La de la CUENTA, que es en la que el banco expresa el cargo. */
  moneda: string;
  ya_usado_por: string | null;
}

/** El IVA que este cobro libera, gasto por gasto. */
export interface IvaLiberadoPorGasto {
  billId: string;
  billNumber: string;
  importe: string;
}

export interface ResultadoDeCobroDeCheque {
  paymentId: string;
  paymentNumber: string;
  checkNumber: string | null;
  movimiento: { id: string; fecha: string; importe: string; descripcion: string | null };
  /** EL DÍA DEL COBRO: lo dice el banco, no el operador ni el reloj. */
  fechaDeCobro: string;
  periodo: { nombre: string; status: string } | null;
  /** Total reclasificado de 1135 a 1130. Cero es un resultado legítimo. */
  reclasificado: string;
  porGasto: IvaLiberadoPorGasto[];
  entryId: string | null;
  entryNumber: string | null;
  /** Por qué no se reclasificó nada, cuando no se reclasificó nada. */
  nota: string | null;
  ensayo: boolean;
}

export interface OpcionesDeCobroDeCheque {
  /** `--transaction`: el movimiento del banco que lo pagó, nombrado a mano. */
  transactionId?: string;
  /**
   * `--as-of`: la fecha de cobro que el operador AFIRMA. No la impone —el cobro
   * lo fecha el banco— pero sí se contrasta: si no coincide con la del
   * movimiento, se rechaza nombrando las dos, porque la discrepancia casi
   * siempre significa que el movimiento elegido no es el que cobró el cheque.
   */
  asOf?: string;
  userId: string;
  dryRun?: boolean;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Prueba el cheque contra el movimiento del banco que lo cobró, escribe el
 * cobro en el pago y contabiliza la reclasificación de IVA EN EL MES DEL COBRO.
 *
 * EL IMPORTE A RECLASIFICAR NO SE CALCULA AQUÍ. Sale de
 * `ivaReclassificationsFor`, que ya compone `ivaToReclassify` (el prorrateo por
 * pagos parciales, que se calcula como diferencia de acumulados para que la
 * última aplicación libere el resto exacto) con `ivaStillParked` (el tope: lo
 * que ese gasto TIENE de verdad aparcado en 1135, leído del mayor). Reescribir
 * esa aritmética aquí habría dado un segundo sitio donde el IVA de un pago se
 * calcula, y el día que los dos discrepen nadie sabría cuál manda.
 *
 * EL TOPE ES TAMBIÉN LA PROTECCIÓN CONTRA EL DOBLE ACREDITAMIENTO, y hace falta
 * decirlo: hoy `postVendorPaymentEntry` ya libera el IVA en la fecha del PAGO,
 * así que para un cheque cuyo pago se contabilizó de esa manera `ivaStillParked`
 * devuelve cero y este comando reclasifica cero, informándolo. Eso NO es un
 * fallo de aquí: es la señal de que ese IVA se acreditó en el mes de la firma
 * del cheque y no en el del cobro, que es precisamente lo que la fila 1271
 * existe para corregir. Cerrarlo del todo pide que el asiento del pago con
 * cheque DEJE el IVA aparcado y espere a este comando, y eso se decide en
 * `ar-ap-posting.ts`, no aquí.
 */
export async function conciliarCheque(
  entityId: string,
  paymentId: string,
  opts: OpcionesDeCobroDeCheque
): Promise<ResultadoDeCobroDeCheque> {
  if (opts.asOf !== undefined && !FECHA_RE.test(opts.asOf)) {
    throw new ValidationError(`Fecha ilegible en --as-of: "${opts.asOf}". Se espera YYYY-MM-DD.`);
  }

  return ejecutarActo(async (client, atestar) => {
    const tenantId = await tenantDe(client, entityId);

    // EL PAGO, ACOTADO POR ENTIDAD Y BLOQUEADO. El `FOR UPDATE` cierra la
    // ventana entre comprobar que el cheque no está cobrado y escribir que lo
    // está: sin él, dos sesiones simultáneas pasan las dos la comprobación y
    // la segunda pisa el cobro de la primera.
    const pagos = await client.query<FilaPagoConCheque>(
      `SELECT id, payment_number, check_number, payment_method,
              payment_amount::text          AS payment_amount,
              payment_date::text            AS payment_date,
              currency_code, status, bank_account_id,
              check_cleared_date::text      AS check_cleared_date,
              check_cleared_tx_id
         FROM vendor_payments
        WHERE id = $1 AND entity_id = $2
        FOR UPDATE`,
      [paymentId, entityId]
    );
    if (pagos.rows.length === 0) throw new NotFoundError('Vendor Payment', paymentId);
    const pago = pagos.rows[0];

    if (pago.payment_method !== 'check') {
      throw new ValidationError(
        `El pago ${pago.payment_number} se hizo por "${pago.payment_method}", no con cheque. ` +
          `El cobro del cheque es un hecho que sólo existe cuando hay cheque: en una ` +
          `transferencia el pago se entiende efectuado el día que salió el dinero.`
      );
    }
    // Un cheque que el banco cobró contra un pago ANULADO o FALLIDO no es una
    // conciliación: es un incidente —un cheque que se dio por cancelado y que
    // se presentó igual—, y darlo por conciliado lo taparía escribiendo el
    // cobro como si todo estuviera en orden.
    if (pago.status === 'void' || pago.status === 'failed') {
      throw new ValidationError(
        `El pago ${pago.payment_number} está en '${pago.status}': un cheque anulado o fallido que ` +
          `el banco cobra es un incidente, no una conciliación. Resuelve el pago antes de ` +
          `registrar el cobro.`
      );
    }
    if (pago.check_cleared_tx_id) {
      // Idempotencia con nombre: se dice CUÁNDO y CON QUÉ se cobró, en vez de
      // volver a escribir lo mismo o de fingir que no había pasado nada.
      throw new ValidationError(
        `El cheque del pago ${pago.payment_number} ya consta cobrado el ${pago.check_cleared_date} ` +
          `contra el movimiento ${pago.check_cleared_tx_id}. Un cheque se cobra una vez.`
      );
    }

    const movimiento = await movimientoDelCobro(client, entityId, pago, opts.transactionId);
    const fechaDeCobro = movimiento.fecha;

    if (opts.asOf !== undefined && opts.asOf !== fechaDeCobro) {
      throw new ValidationError(
        `--as-of dice ${opts.asOf} y el banco fecha el cobro el ${fechaDeCobro}. La fecha del ` +
          `cobro la pone el movimiento, no la declaración: si el ${opts.asOf} es el día correcto, ` +
          `el movimiento elegido no es el que pagó este cheque.`
      );
    }
    // Un cheque no se puede cobrar antes de existir. Un movimiento anterior a
    // la fecha del pago es otro cargo por el mismo importe, y aceptarlo ataría
    // el cheque al movimiento equivocado y fecharía el IVA en un mes anterior.
    if (fechaDeCobro < pago.payment_date) {
      throw new ValidationError(
        `El movimiento ${movimiento.id} es del ${fechaDeCobro} y el cheque se expidió el ` +
          `${pago.payment_date}: un cheque no se cobra antes de existir.`
      );
    }

    // EL PERIODO DEL COBRO, ANTES DE ESCRIBIR NADA. Aquí no se omite y se sigue
    // —como en las comisiones— porque el acto es UNO: si el asiento no se puede
    // fechar en el mes del cobro, escribir sólo `check_cleared_date` dejaría el
    // pago diciendo que el cheque se cobró y el mayor sin el IVA reclasificado,
    // que es el descuadre que este comando existe para no producir.
    const periodo = await periodoDeLaFecha(client, entityId, fechaDeCobro);

    // LA REGLA DEL COBRO ES LIVA, NO NIF. Una entidad no mexicana no acredita
    // IVA: el impuesto de su factura no es IVA acreditable y no hay nada
    // aparcado en 1135 que liberar. Preguntar antes evita recorrer la máquina
    // de reclasificación para que devuelva cero por el motivo equivocado.
    const flujoDeEfectivo = await entityUsesCashBasisIva(client, entityId);
    const items = flujoDeEfectivo
      ? await ivaReclassificationsFor(client, 'received', entityId, pago.id)
      : [];
    const totalIva = items.reduce((s, i) => s.plus(i.amount), new Decimal(0));

    if (totalIva.greaterThan(0) && periodoCerrado(periodo)) {
      throw new ValidationError(
        `El cobro es del ${fechaDeCobro} y ${motivoDePeriodo(periodo, fechaDeCobro)}. La ` +
          `reclasificación de IVA de un cheque PERTENECE al mes del cobro —bajo la LIVA el pago ` +
          `se entiende efectuado al cobrarse—, así que no se postea con otra fecha: reabre el ` +
          `periodo con \`mnemosine close --reopen\` o deja constancia del cobro cuando se pueda ` +
          `contabilizar.`
      );
    }

    let entryId: string | null = null;
    let entryNumber: string | null = null;
    let nota: string | null = null;

    if (totalIva.greaterThan(0)) {
      const roles = await roleAccounts(client, entityId, [
        'iva_acreditable',
        'iva_pendiente_acreditar',
      ] as const);
      const acreditable = requireRole(roles, 'iva_acreditable');
      const pendiente = requireRole(roles, 'iva_pendiente_acreditar');

      // Los dos son ACTIVOS y por eso el sentido es éste: 1135 se vacía con un
      // ABONO y 1130 se llena con un CARGO. Invertirlo cuadra igual de bien y
      // deja las dos cuentas del revés, que es el error que
      // `ar-ap-posting.ts` documenta en el mismo par.
      const lineas: LineaDeAsiento[] = items.flatMap((item) => [
        {
          account_id: acreditable,
          debit_amount: item.amount,
          credit_amount: null,
          description: `IVA now creditable - cheque ${pago.check_number ?? pago.payment_number} cleared ${fechaDeCobro} - Bill ${item.documentNumber}`,
        },
        {
          account_id: pendiente,
          debit_amount: null,
          credit_amount: item.amount,
          description: `IVA released from 1135 on cheque clearing (LIVA: payment made when the cheque clears) - Bill ${item.documentNumber}`,
        },
      ]);

      const asiento = await createJournalEntry(
        entityId,
        // LA FECHA DEL ASIENTO ES LA DEL COBRO. Ni hoy, ni la del cheque, ni
        // —por medianoche UTC— la víspera del cobro: ver `fechaDelAsiento`.
        fechaDelAsiento(fechaDeCobro),
        JournalEntryType.AUTO_RECONCILIATION,
        `Cheque ${pago.check_number ?? pago.payment_number} cleared ${fechaDeCobro} - IVA reclassified 1135 to 1130`,
        lineas,
        opts.userId,
        {
          autoPost: true,
          client,
          sourceType: ORIGEN_COBRO_DE_CHEQUE,
          sourceId: pago.id,
          reference: pago.check_number ?? pago.payment_number,
        }
      );
      atestar(tenantId, entityId, asiento.id);
      entryId = asiento.id;
      entryNumber = asiento.entry_number;
    } else {
      nota = periodoCerrado(periodo)
        ? `No había IVA que reclasificar, así que el cobro se registra sin asiento; ` +
          `${motivoDePeriodo(periodo, fechaDeCobro)}, y con IVA que mover esto se habría ` +
          `rechazado en vez de postearse con otra fecha.`
        : flujoDeEfectivo
        ? `No quedaba IVA aparcado en 1135 para este pago, así que no hay nada que reclasificar. ` +
          `Casi siempre significa una de dos cosas: los gastos que pagó eran PUE —su IVA ya era ` +
          `acreditable desde la factura— o el asiento del pago ya lo liberó en la fecha del ` +
          `cheque en vez de esperar al cobro.`
        : `La entidad no contabiliza el IVA por flujo de efectivo (no es mexicana), así que el ` +
          `cobro del cheque se registra pero no reclasifica impuesto ninguno.`;
    }

    // LAS DOS COLUMNAS VAN JUNTAS o el CHECK `pago_cheque_cobro_coherente` de
    // la 055 rechaza la fila: la fecha sin el movimiento es una afirmación sin
    // prueba y el movimiento sin la fecha, una prueba que no dice de cuándo. Y
    // la entidad va OTRA VEZ en el WHERE aunque el SELECT de arriba ya la
    // exigió: la última fuga de este módulo entró justo por un id que se dio
    // por comprobado antes de escribir.
    await client.query(
      `UPDATE vendor_payments
          SET check_cleared_date = $1::date,
              check_cleared_tx_id = $2,
              updated_at = NOW()
        WHERE id = $3 AND entity_id = $4`,
      [fechaDeCobro, movimiento.id, pago.id, entityId]
    );

    await registrarAuditoria(client, {
      tenantId,
      userId: opts.userId,
      action: 'update',
      entityType: 'vendor_payments',
      entityId: pago.id,
      oldValues: { check_cleared_date: null, check_cleared_tx_id: null },
      newValues: {
        check_cleared_date: fechaDeCobro,
        check_cleared_tx_id: movimiento.id,
        iva_reclasificado: totalIva.toFixed(ESCALA),
        journal_entry_id: entryId,
      },
      reason: `Cobro del cheque ${pago.check_number ?? pago.payment_number}`,
    });

    const resultado: ResultadoDeCobroDeCheque = {
      paymentId: pago.id,
      paymentNumber: pago.payment_number,
      checkNumber: pago.check_number,
      movimiento: {
        id: movimiento.id,
        fecha: movimiento.fecha,
        importe: movimiento.importe,
        descripcion: movimiento.descripcion,
      },
      fechaDeCobro,
      periodo: periodo ? { nombre: periodo.period_name, status: periodo.status } : null,
      reclasificado: totalIva.toFixed(ESCALA),
      porGasto: items.map((i) => ({
        billId: i.documentId,
        billNumber: i.documentNumber,
        importe: i.amount,
      })),
      entryId,
      entryNumber,
      nota,
      ensayo: opts.dryRun === true,
    };
    if (opts.dryRun) {
      throw new EnsayoDeTesoreria({ ...resultado, entryId: null, entryNumber: null });
    }
    return resultado;
  });
}

/**
 * El movimiento del banco que pagó el cheque: el que se nombró, o el que se
 * encuentra por importe y fecha.
 *
 * CUANDO HAY VARIOS CANDIDATOS NO SE ELIGE UNO. Dos cargos del mismo importe
 * después de la fecha del cheque son dos cheques distintos con la misma cifra,
 * que es de lo más común en una nómina de proveedores, y quedarse con el
 * primero ata el pago al movimiento equivocado y fecha el IVA en el mes
 * equivocado —en silencio, y cuadrando—. Se listan y se pide `--transaction`.
 */
async function movimientoDelCobro(
  client: pg.PoolClient,
  entityId: string,
  pago: FilaPagoConCheque,
  transactionId?: string
): Promise<FilaMovimientoDeCobro> {
  // La frontera, otra vez por JOIN: `bank_transactions` no tiene entidad. Y
  // `ya_usado_por` sale de la misma consulta para que «este movimiento ya cobró
  // otro cheque» no dependa de una segunda lectura que alguien pueda saltarse.
  // `$1` es SIEMPRE la entidad en las dos formas de abajo, para que ningún
  // parámetro quede sin referenciar según por qué rama se entre.
  const SELECT = `
    SELECT bt.id,
           bt.transaction_date::text AS fecha,
           bt.amount::text           AS importe,
           bt.description            AS descripcion,
           bt.bank_account_id,
           ba.currency_code          AS moneda,
           (SELECT vp.payment_number
              FROM vendor_payments vp
             WHERE vp.check_cleared_tx_id = bt.id AND vp.entity_id = $1
             LIMIT 1)               AS ya_usado_por
      FROM bank_transactions bt
      JOIN bank_accounts ba ON ba.id = bt.bank_account_id`;

  if (transactionId) {
    const r = await client.query<FilaMovimientoDeCobro>(
      `${SELECT} WHERE bt.id = $2 AND ba.entity_id = $1`,
      [entityId, transactionId]
    );
    if (r.rows.length === 0) throw new NotFoundError('Bank Transaction', transactionId);
    const mov = r.rows[0];
    exigirMovimientoCompatible(mov, pago);
    return mov;
  }

  if (!pago.bank_account_id) {
    throw new ValidationError(
      `El pago ${pago.payment_number} no dice de qué cuenta bancaria salió, así que no hay dónde ` +
        `buscar el cargo. Nombra el movimiento con \`--transaction\`.`
    );
  }

  // La ventana empieza en la fecha del cheque y no tiene final: un umbral de
  // días aquí sería una política contable disfrazada de constante, y además el
  // caso que importa —el cheque que aparece cobrado seis meses después, el del
  // art. 181 LGTOC— es justo el que un umbral se comería.
  const r = await client.query<FilaMovimientoDeCobro>(
    `${SELECT}
      WHERE ba.entity_id = $1
        AND bt.bank_account_id = $2
        AND ba.currency_code = $5
        AND bt.transaction_date >= $3::date
        AND bt.amount = ($4::numeric * -1)
        AND NOT EXISTS (
              SELECT 1 FROM vendor_payments vp
               WHERE vp.check_cleared_tx_id = bt.id AND vp.entity_id = $1)
      ORDER BY bt.transaction_date, bt.id
      LIMIT 6`,
    [entityId, pago.bank_account_id, pago.payment_date, pago.payment_amount, pago.currency_code]
  );

  if (r.rows.length === 0) {
    throw new ValidationError(
      `No hay en "${pago.payment_number}" ningún cargo sin usar de ${pago.payment_amount} a ` +
        `partir del ${pago.payment_date} en esa cuenta. O el cheque sigue en circulación, o el ` +
        `banco lo cobró por otro importe: nombra el movimiento con \`--transaction\`.`
    );
  }
  if (r.rows.length > 1) {
    const lista = r.rows.map((m) => `${m.id} (${m.fecha})`).join(', ');
    throw new ValidationError(
      `Hay ${r.rows.length} cargos de ${pago.payment_amount} que podrían ser este cheque: ` +
        `${lista}. No se elige uno: dos cheques del mismo importe son lo más normal del mundo y ` +
        `atar el pago al equivocado fecha su IVA en el mes equivocado. Nombra el bueno con ` +
        `\`--transaction\`.`
    );
  }
  return r.rows[0];
}

/** Las comprobaciones que un movimiento nombrado a mano no trae hechas. */
function exigirMovimientoCompatible(mov: FilaMovimientoDeCobro, pago: FilaPagoConCheque): void {
  if (mov.ya_usado_por) {
    throw new ValidationError(
      `El movimiento ${mov.id} ya consta como el cobro del cheque del pago ${mov.ya_usado_por}. ` +
        `Un cargo del banco paga un cheque, no dos.`
    );
  }
  if (pago.bank_account_id && mov.bank_account_id !== pago.bank_account_id) {
    throw new ValidationError(
      `El movimiento ${mov.id} es de otra cuenta bancaria que la del pago ${pago.payment_number}. ` +
        `Un cheque lo paga el banco contra el que se giró.`
    );
  }
  // SIN ESTA COMPROBACIÓN LA DE ABAJO NO SIGNIFICA NADA. Comparar 1 160.00 de
  // una cuenta en dólares contra 1 160.00 de un cheque en pesos da un cotejo
  // perfecto entre dos cantidades que no tienen nada que ver, y ata el cheque
  // al cargo equivocado con toda la apariencia de haber cuadrado.
  if (mov.moneda !== pago.currency_code) {
    throw new ValidationError(
      `El movimiento ${mov.id} está en ${mov.moneda} y el cheque del pago ${pago.payment_number} ` +
        `en ${pago.currency_code}. Dos importes iguales en monedas distintas no son el mismo ` +
        `importe, y aquí no se convierte.`
    );
  }
  const importe = new Decimal(mov.importe);
  const esperado = new Decimal(pago.payment_amount);
  // La comparación es EXACTA y sobre los cuatro decimales de la columna. Un
  // cobro por importe distinto no es este cheque —o es un cheque alterado, que
  // es un incidente y no una conciliación—, y tolerar la diferencia dejaría el
  // pago probado contra un cargo que no lo paga.
  if (importe.greaterThanOrEqualTo(0) || !importe.abs().equals(esperado)) {
    throw new ValidationError(
      `El movimiento ${mov.id} vale ${importe.toFixed(ESCALA)} y el cheque del pago ` +
        `${pago.payment_number} es de ${esperado.toFixed(ESCALA)} saliendo de la cuenta. No ` +
        `casan, y aquí no se admite diferencia: un cheque cobrado por otro importe es un ` +
        `incidente, no una conciliación.`
    );
  }
}
