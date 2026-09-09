import Decimal from 'decimal.js';
import { query, withTransaction } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { JournalEntryType } from '../../types/index.js';
import type { PolicyContext } from '../policy/policy-service.js';
import { createJournalEntry, attestEntryAsync } from './posting.js';
import { rubroDe } from './sat-agrupadores-catalogo.js';
import { readAgrupador } from './sat-agrupador-account-type.js';
import {
  readBalanzaComprobacion,
  type BalanceFileRead,
  type BalanceFileRow,
  type BalanceReadFinding,
  ESCALA_DEL_MAYOR,
  ENTEROS_DEL_MAYOR,
} from '../sat/anexo24/balance-reader.js';
import { naturDe, saldoDelMayor } from '../sat/anexo24/balanza-invariantes.js';

// ============================================================
// O1 · LA BALANZA DE APERTURA — LA SEGUNDA CAPA DEL ONBOARDING
//
// La capa 1 creó las cuentas desde el CtaCatalogo. Ésta les posa encima el
// saldo con el que arrancan, leído de la BalanzaComprobacion del sistema
// viejo. Es UN asiento, de tipo ajuste, con `source_type = 'opening_balance'`
// para que se pueda encontrar y deshacer, y cuadrado.
//
// La tarjeta fija la doctrina en tres frases y cada una es una regla que este
// archivo IMPLEMENTA, no que comenta:
//
// ── 1. «INICIO DE EJERCICIO» ────────────────────────────────────────────
//
// La apertura se carga al PRIMER DÍA DEL EJERCICIO, y aquí eso no es una
// convención: es un candado. La fecha del asiento no se elige ni se pasa por
// parámetro — se BUSCA. Del corte que el archivo declara (Anio/Mes) sale el
// día siguiente, y ese día tiene que ser el `start_date` de un ejercicio de
// esta entidad o no hay asiento. Si alguien trae la balanza de junio, el día
// siguiente es el 1 de julio, no existe ningún ejercicio que empiece ahí, y la
// carga se niega nombrando el archivo que sí hace falta.
//
// El defecto que eso evita es el que la tarjeta describe: una apertura cargada
// a mitad de año deja sin representar los movimientos del ejercicio ya
// transcurrido, y la balanza de diciembre no cuadra con la del sistema viejo
// por una diferencia que nadie sabe de dónde sale.
//
// LO QUE SÍ HAY QUE DECIR, porque es una diferencia real y no un detalle: el
// asiento cae DENTRO del primer periodo, así que en la balanza de ese primer
// mes la apertura sale como MOVIMIENTO (Debe/Haber) y su SaldoIni es cero. El
// sistema viejo, que venía de antes, la trae como SaldoIni. Las dos declaran
// el mismo SaldoFin —que es lo que se cuadra al peso— y a partir del segundo
// periodo las dos coinciden también en SaldoIni. Cargarla el 31 de diciembre
// anterior habría igualado también la primera columna, y exige que el
// ejercicio VIEJO exista en este sistema, que es justo lo que no ocurre en una
// migración. Se elige el candado; se declara la consecuencia.
//
// ── 2. «CxC/CxP DOCUMENTO A DOCUMENTO, JAMÁS AGREGADOS» ─────────────────
//
// La balanza trae UN saldo por cuenta. Para clientes y proveedores eso es un
// agregado, y un agregado es inservible: no se cobra «12 000 de clientes», se
// cobra la A-123 de 4 000 y la A-456 de 8 000.
//
// AQUÍ NO ES UNA OPINIÓN, ES MEDIBLE, y por eso la negativa no lleva puerta
// trasera. `arReconcile` (services/ar/ar-controls.ts) compara el saldo de la
// cuenta de control contra el auxiliar —facturas abiertas menos notas de
// crédito por aplicar— y LISTA APARTE los asientos manuales que tocaron el
// control sin un documento detrás, «la causa número uno de un descuadre que
// nadie encuentra». Un saldo agregado de apertura es exactamente eso: deja
// `ar reconcile` descuadrado por el importe entero de la apertura, para
// siempre, y sale en `runArChecks` como `subledger-delta`. La prueba de
// integración de este tramo lo MIDE en vez de afirmarlo.
//
// Así que: una cuenta de control con saldo de apertura o entra documento a
// documento o NO ENTRA, y como el asiento tiene que cuadrar, que no entre
// significa que no se carga nada. No hay bandera que lo salte. Un `--parcial`
// aquí sería una manera educada de escribir el defecto que este archivo
// existe para impedir.
//
// QUÉ CUENTA CUENTA COMO DE CONTROL. Primero el ROL —`cxc` y `cxp` de
// `account_roles`, que es la fuente cuando existe—, y si no hay rol, el RUBRO
// del código agrupador del SAT, que el catálogo importado sí trae. No se
// adivina por el número de cuenta: el número es del cliente y no significa
// nada fuera de su casa.
//
// ── 3. «IGUALES AL PESO» ────────────────────────────────────────────────
//
// Dos candados, los dos sin tolerancia:
//
//   · EL ASIENTO CUADRA SOLO. No hay cuenta puente, ni «capital de apertura»,
//     ni plug. La balanza de un sistema que funciona ya suma cero en el eje
//     del mayor, así que el asiento de apertura es esa misma balanza
//     transpuesta y no necesita contrapartida. Si no suma cero, el libro de
//     origen no cuadraba: se dice la diferencia y no se escribe nada. Un plug
//     habría escondido exactamente el defecto que hay que enseñar.
//
//   · NO SE CUENTA EL DINERO DOS VECES. El Anexo 24 declara el saldo de una
//     cuenta de mayor INCLUYENDO el de sus subcuentas. Posar las dos cifras
//     duplicaría el importe. Lo que se postea es el RESIDUO —lo que la cuenta
//     declara menos lo que declaran sus hijas dentro del mismo archivo—, de
//     modo que, sumado el árbol, cada cuenta vuelve a dar exactamente lo que
//     el archivo decía, en todos los niveles. Y el residuo respeta el caso que
//     un «postear sólo las hojas» rompe: la cuenta de mayor que en el sistema
//     viejo llevaba movimiento PROPIO además del de sus hijas.
//
// ── LO QUE NO ENTRA, Y POR QUÉ ──────────────────────────────────────────
//
// LAS CUENTAS DE RESULTADO. Una apertura de ejercicio no arrastra ingresos ni
// gastos: el resultado del ejercicio anterior ya vive en el capital, y volver
// a cargarlo lo contaría dos veces y estrenaría el estado de resultados del
// año nuevo con las cifras del viejo. Si el archivo trae resultado abierto es
// que el ejercicio no se cerró en el origen — se dice, con las cuentas y el
// importe, y se pide la balanza de cierre (Mes 13), que es un archivo que el
// contribuyente tiene que presentar de todas formas.
// ============================================================

/** Un auxiliar con subledger propio en este sistema. */
export type SubledgerKind = 'cxc' | 'cxp';

/**
 * Un documento abierto del auxiliar: la factura que falta por cobrar, el
 * pasivo que falta por pagar.
 *
 * Es lo que la BALANZA no puede traer y el AUXILIAR sí. Este tramo lo recibe
 * ya estructurado en vez de leer el XML del auxiliar: la lectura de ese
 * archivo es la capa 3 del onboarding, y lo que aquí hace falta fijar es el
 * CONTRATO —qué se exige para dejar entrar un saldo de control— y el candado
 * de que la suma cuadre al peso contra la balanza.
 */
export interface OpeningDocument {
  /** El NumCta de la cuenta de control, tal como lo declara la balanza. */
  cuenta: string;
  /** El folio: «A-123». Es lo que se cobra, y lo que identifica al renglón. */
  documento: string;
  /** Quién debe, o a quién se debe. */
  contraparte: string;
  /** Fecha del documento, YYYY-MM-DD. */
  fecha: string;
  /** Vencimiento, YYYY-MM-DD. Sin él no hay antigüedad de saldos. */
  vencimiento?: string;
  /**
   * El saldo ABIERTO del documento, EN LA NATURALEZA DE LA CUENTA y como
   * cadena: lo que queda por cobrar o por pagar, no el importe original. Un
   * valor contrario (una nota de crédito, un anticipo sin aplicar) es legítimo
   * y se avisa.
   */
  importe: string;
  /** UUID del CFDI que lo respalda, cuando lo hay. */
  uuid?: string;
}

/** Una cuenta de la entidad tal como está HOY. El plan se calcula contra esto. */
export interface OpeningAccountRow {
  id: string;
  code: string;
  name: string;
  /** El código del padre, o `null` en la raíz. */
  parent_code: string | null;
  account_type: string;
  normal_balance: string;
  codigo_agrupador_sat: string | null;
  is_header: boolean;
  is_active: boolean;
  allow_manual_entries: boolean;
  /** 'cxc' o 'cxp' cuando un `account_roles` la señala; null si ninguno. */
  role: string | null;
}

/** Una línea del asiento de apertura, ya con su lado elegido. */
export interface OpeningLine {
  code: string;
  accountId: string;
  /** Uno de los dos y nunca los dos: es el CHECK de la 001. */
  debit: string | null;
  credit: string | null;
  description: string;
  /** El documento que la origina, cuando la línea viene del auxiliar. */
  documento?: OpeningDocument;
}

/** Qué se encontró para una cuenta de control, y si alcanza. */
export interface ControlAccountPlan {
  code: string;
  name: string;
  kind: SubledgerKind;
  /** El residuo que hay que cubrir, en la naturaleza de la cuenta. */
  residual: string;
  /** La suma de los documentos aportados, en la misma naturaleza. */
  detalle: string;
  documentos: number;
  /** true = el detalle cubre el residuo AL PESO. */
  cubierto: boolean;
}

/** Un defecto de la carga. Es el mismo tipo que usan los dos lectores. */
export type OpeningFinding = BalanceReadFinding;

export interface OpeningPlan {
  /** El primer día del ejercicio que se abre. YYYY-MM-DD. */
  fecha: string;
  /** El ejercicio que se abre. */
  ejercicio: number;
  lines: readonly OpeningLine[];
  totalDebe: string;
  totalHaber: string;
  control: readonly ControlAccountPlan[];
  findings: readonly OpeningFinding[];
  /** false si algo impide escribir. Todo o nada: no hay carga a medias. */
  puedeCargarse: boolean;
}

/** El ejercicio que se abre, ya resuelto contra la base. */
export interface OpeningExercise {
  id: string;
  yearNumber: number;
  /** `fiscal_years.start_date`, YYYY-MM-DD. Es la fecha del asiento. */
  startDate: string;
}

// ------------------------------------------------------------
// QUÉ CUENTAS EXIGEN DETALLE
// ------------------------------------------------------------

/**
 * Los rubros del c_CodAgrup cuyo saldo es, por definición, una suma de
 * documentos que se cobran o se pagan uno a uno.
 *
 * Se enumeran de la lista oficial y no de un rango, por lo mismo que la capa 1
 * no dedujo el tipo de cuenta de un rango: dentro del 1xx conviven Clientes
 * (105), que es un auxiliar, y Estimación de cuentas incobrables (108), que es
 * una ESTIMACIÓN global y no tiene documentos que enumerar — exigirle detalle
 * sería exigir lo que no existe.
 *
 * Tampoco entran los anticipos (120 a proveedores, 206 de clientes) aunque
 * también nazcan de documentos, y la razón es la que sostiene toda esta
 * negativa: la exigencia existe porque un agregado es DEMOSTRABLEMENTE
 * inservible —`arReconcile` lo deja descuadrado para siempre—, y sobre los
 * anticipos no hay en este sistema ninguna conciliación que lo demuestre.
 * Donde no hay daño medible, la exigencia sería dogma.
 */
const RUBROS_CXC = new Set([
  '105', // Clientes
  '106', // Cuentas y documentos por cobrar a corto plazo
  '107', // Deudores diversos
  '186', // Cuentas y documentos por cobrar a largo plazo
]);

const RUBROS_CXP = new Set([
  '201', // Proveedores
  '202', // Cuentas por pagar a corto plazo
  '205', // Acreedores diversos a corto plazo
  '251', // Acreedores diversos a largo plazo
  '252', // Cuentas por pagar a largo plazo
]);

/**
 * ¿Esta cuenta exige detalle documento a documento?
 *
 * EL ROL MANDA cuando existe: `account_roles` es la traducción explícita de
 * «cxc» a una cuenta concreta y es lo que lee todo el posteo automático, así
 * que si alguien apuntó el rol a esta cuenta, ésta ES el control aunque su
 * agrupador diga otra cosa. Sólo cuando no hay rol se mira el agrupador, que
 * es lo que el catálogo importado sí trae desde el primer minuto: en una
 * migración recién empezada los roles todavía apuntan al catálogo base y las
 * cuentas del cliente no tienen ninguno.
 */
export function subledgerKindOf(cuenta: OpeningAccountRow): SubledgerKind | null {
  if (cuenta.role === 'cxc') return 'cxc';
  if (cuenta.role === 'cxp') return 'cxp';
  const codAgrup = cuenta.codigo_agrupador_sat;
  if (codAgrup === null || codAgrup.trim() === '') return null;
  const rubro = rubroDe(codAgrup.trim()) ?? codAgrup.trim();
  if (RUBROS_CXC.has(rubro)) return 'cxc';
  if (RUBROS_CXP.has(rubro)) return 'cxp';
  return null;
}

/**
 * ¿Decide esta cuenta POR SÍ MISMA si es un control, o hay que preguntarle a
 * su jerarquía?
 *
 * La distinción no es cosmética: `subledgerKindOf` devuelve `null` para dos
 * cosas muy distintas —«su agrupador dice que NO es un control» (102 Bancos,
 * 108 Estimación de incobrables) y «no hay agrupador con el que saberlo»—, y
 * confundirlas es lo que abría el boquete de abajo.
 */
function decideSuPropioAuxiliar(cuenta: OpeningAccountRow): boolean {
  if (cuenta.role === 'cxc' || cuenta.role === 'cxp') return true;
  const codAgrup = cuenta.codigo_agrupador_sat;
  if (codAgrup === null || codAgrup.trim() === '') return false;
  const veredicto = readAgrupador(codAgrup).verdict;
  // 'ausente', 'fuera_de_catalogo' y 'sin_regla' NO deciden nada: el
  // agrupador que traen no está en el c_CodAgrup, así que no dice ni que sea
  // ni que no sea una cuenta de control.
  return veredicto === 'oficial' || veredicto === 'oficial_ambiguo' || veredicto === 'cuentas_de_orden';
}

/** Quién decidió que esta cuenta es (o no es) un auxiliar, y qué decidió. */
export interface SubledgerResolution {
  kind: SubledgerKind | null;
  /** El código de la cuenta que lo decidió. `null` si nadie pudo. */
  decidio: string | null;
}

/**
 * EL BOQUETE QUE ESTO CIERRA, y era alcanzable a través de la capa 1 de este
 * mismo tramo.
 *
 * `subledgerKindOf` mira SÓLO la cuenta: rol, y si no hay rol, el rubro de su
 * agrupador. Pero el importador del catálogo crea a propósito cuentas SIN
 * agrupador utilizable —`IMP-TIPO-HEREDADO`: la fila no trae CodAgrup, o el
 * que trae no está en el c_CodAgrup, y el tipo se hereda del padre—, y esas
 * cuentas quedan en la base con `codigo_agrupador_sat` nulo o irreconocible.
 *
 * Con la mirada corta, «105-001 Clientes nacionales» colgando de «105
 * Clientes» pero sin CodAgrup propio devolvía `null`, su saldo AGREGADO de
 * 12 000 entraba como un solo renglón sin un hallazgo, y la doctrina entera
 * —«o documento a documento, o no entra»— se saltaba en silencio con un
 * archivo perfectamente normal. El padre tampoco protestaba: su residuo era
 * cero porque la hija declaraba todo el importe.
 *
 * Así que cuando la cuenta no decide, decide su ANTEPASADO más cercano que sí
 * pueda — que es el mismo criterio con el que la capa 1 le da tipo a esa
 * misma cuenta: lo que el archivo declara con su jerarquía. La herencia se
 * detiene en el primer antepasado que decida, incluso si decide que NO: una
 * estimación de incobrables (108) bajo Clientes no hereda «cxc» de su padre,
 * porque su propio agrupador ya respondió.
 */
export function resolveSubledgerKind(
  cuenta: OpeningAccountRow,
  porCodigo: ReadonlyMap<string, OpeningAccountRow>
): SubledgerResolution {
  // El testigo de visitados es por el `parent_code` mal apuntado a mano: un
  // ciclo colgaría el proceso, y aquí no hay nada que justifique arriesgarlo.
  const visitados = new Set<string>();
  let actual: OpeningAccountRow | undefined = cuenta;
  while (actual !== undefined && !visitados.has(actual.code)) {
    visitados.add(actual.code);
    if (decideSuPropioAuxiliar(actual)) {
      return { kind: subledgerKindOf(actual), decidio: actual.code };
    }
    actual = actual.parent_code === null ? undefined : porCodigo.get(actual.parent_code);
  }
  return { kind: null, decidio: null };
}

/** Los tipos cuyo saldo NO se arrastra a un ejercicio nuevo. */
const TIPOS_DE_RESULTADO = new Set(['revenue', 'expense']);

function finding(
  regla: string,
  severidad: 'bloquea' | 'aviso',
  numCta: string | undefined,
  mensaje: string,
  fila?: number
): OpeningFinding {
  return {
    regla,
    severidad,
    ...(fila === undefined ? {} : { fila }),
    ...(numCta === undefined ? {} : { numCta }),
    mensaje,
  };
}

/**
 * El primer día DESPUÉS del corte que el archivo declara.
 *
 * Aritmética de calendario sobre las cifras del propio archivo, sin `Date`: un
 * `new Date('2025-12-31')` se interpreta en UTC, se imprime en la zona local y
 * en México devuelve el 30 de diciembre. La fecha del asiento de apertura no
 * puede depender de en qué huso corre el proceso.
 *
 * Mes «13» es la balanza de CIERRE del ejercicio, no un mes: cierra diciembre,
 * así que el día siguiente es el mismo que el de Mes 12.
 */
export function dayAfterCutoff(anio: string, mes: string): string {
  const a = Number(anio);
  const m = mes === '13' ? 12 : Number(mes);
  const siguiente = m === 12 ? { a: a + 1, m: 1 } : { a, m: m + 1 };
  return `${siguiente.a}-${String(siguiente.m).padStart(2, '0')}-01`;
}

/** El antepasado más cercano de `code` que el archivo TAMBIÉN declara. */
function antepasadoDeclarado(
  code: string,
  padre: ReadonlyMap<string, string | null>,
  declaradas: ReadonlySet<string>
): string | null {
  const visitados = new Set<string>([code]);
  let actual = padre.get(code) ?? null;
  while (actual !== null && !visitados.has(actual)) {
    if (declaradas.has(actual)) return actual;
    visitados.add(actual);
    actual = padre.get(actual) ?? null;
  }
  return null;
}

/**
 * Qué asiento se escribiría, y qué lo impide. Función PURA: mismas entradas,
 * mismo plan, sin tocar la base. Es lo que hace que el `--dry-run` sea de
 * verdad y que cada borde se pueda fijar en una prueba unitaria.
 */
export function planOpeningBalance(
  lectura: BalanceFileRead,
  cuentas: readonly OpeningAccountRow[],
  documentos: readonly OpeningDocument[],
  ejercicio: OpeningExercise
): OpeningPlan {
  const findings: OpeningFinding[] = [...lectura.findings];
  const vacio = (): OpeningPlan => ({
    fecha: ejercicio.startDate,
    ejercicio: ejercicio.yearNumber,
    lines: [],
    totalDebe: '0.0000',
    totalHaber: '0.0000',
    control: [],
    findings,
    puedeCargarse: false,
  });

  if (!lectura.puedeImportarse) return vacio();

  // ── EL CORTE ────────────────────────────────────────────────────────
  //
  // La regla 1 de la doctrina, comprobada aquí además de en la búsqueda del
  // ejercicio: quien nombre el ejercicio a mano tiene que toparse con esto.
  const debidoInicio = dayAfterCutoff(lectura.header.anio, lectura.header.mes);
  if (debidoInicio !== ejercicio.startDate) {
    findings.push(
      finding(
        'APE-CORTE',
        'bloquea',
        undefined,
        `El archivo declara el corte ${lectura.header.anio}-${lectura.header.mes} y el ejercicio que se ` +
          `abre empieza el ${ejercicio.startDate}, no el ${debidoInicio}. La apertura se carga al PRIMER ` +
          `día del ejercicio: entre el corte del archivo y esa fecha hay movimientos que este asiento no ` +
          `representa, y la balanza de cierre no cuadrará contra la del sistema viejo por una diferencia ` +
          `imposible de rastrear. Trae la balanza del cierre del ejercicio anterior (Mes 12 o Mes 13).`
      )
    );
    return vacio();
  }

  const porCodigo = new Map(cuentas.map((c) => [c.code, c]));
  const padre = new Map(cuentas.map((c) => [c.code, c.parent_code]));

  // ── LAS CUENTAS QUE EL ARCHIVO NOMBRA ───────────────────────────────
  const declaradas = new Set<string>();
  /** Cada fila del archivo con la cuenta que ya resolvió. */
  const resueltas: { f: BalanceFileRow; cuenta: OpeningAccountRow }[] = [];
  let faltantes = 0;
  for (const f of lectura.rows) {
    const cuenta = porCodigo.get(f.numCta);
    if (cuenta === undefined) {
      faltantes++;
      findings.push(
        finding(
          'APE-CUENTA-DESCONOCIDA',
          'bloquea',
          f.numCta,
          `La balanza declara un saldo para "${f.numCta}" y esa cuenta no existe en esta entidad. El ` +
            `saldo no tiene dónde posarse: importa primero el catálogo de cuentas (la capa anterior de ` +
            `esta migración), que es de donde salen el código, el nombre y la naturaleza.`,
          f.fila
        )
      );
      continue;
    }
    declaradas.add(f.numCta);
    resueltas.push({ f, cuenta });
  }
  if (faltantes > 0) return vacio();

  // ── EL RESIDUO: LO QUE LA CUENTA LLEVA POR SÍ MISMA ─────────────────
  //
  // El archivo declara agregado; el mayor guarda saldo propio. Se resta lo de
  // las hijas DECLARADAS EN EL MISMO ARCHIVO, que es el conjunto que importa:
  // si el exportador sólo entregó hasta el nivel 2, sus cuentas de nivel 2 son
  // hojas para este cálculo y reciben todo su saldo, que es lo correcto.
  const mayorDe = new Map<string, Decimal>();
  for (const { f, cuenta } of resueltas) {
    mayorDe.set(f.numCta, saldoDelMayor(f.saldoFin, naturDe(cuenta.normal_balance)));
  }
  /** Lo que cada cuenta declara POR SUS HIJAS, que es lo que hay que restarle. */
  const deLasHijas = new Map<string, Decimal>();
  for (const [code, propio] of mayorDe) {
    const ancestro = antepasadoDeclarado(code, padre, declaradas);
    if (ancestro === null) continue;
    deLasHijas.set(ancestro, (deLasHijas.get(ancestro) ?? new Decimal(0)).plus(propio));
  }

  // ── LOS DOCUMENTOS DEL AUXILIAR ─────────────────────────────────────
  const porCuenta = new Map<string, OpeningDocument[]>();
  const vistos = new Set<string>();
  let documentosInvalidos = 0;
  for (const d of documentos) {
    // El separador es un NUL, que no puede aparecer ni en un código de cuenta
    // ni en un folio, así que dos claves distintas nunca colisionan.
    //
    // VA ESCAPADO, NO COMO BYTE CRUDO EN EL FUENTE, y eso no es estilo: un NUL
    // literal dentro del archivo lo convierte en BINARIO para `grep` y para
    // `file`, de modo que `grep -rn "APE-DOCUMENTO-DUPLICADO" src/` no
    // encuentra NADA — este archivo entero, el que escribe el asiento de
    // apertura, desaparece de toda búsqueda de código. Y no hay quien avise:
    // la heurística de binario de git sólo mira los primeros 8 000 bytes y el
    // NUL caía más allá, así que el diff se veía normal en la revisión.
    const clave = `${d.cuenta}\u0000${d.documento}`;
    if (!declaradas.has(d.cuenta)) {
      documentosInvalidos++;
      findings.push(
        finding(
          'APE-DOCUMENTO-HUERFANO',
          'bloquea',
          d.cuenta,
          `El documento "${d.documento}" dice colgar de la cuenta "${d.cuenta}", que esta balanza no ` +
            `declara. O el auxiliar y la balanza son de cortes distintos, o el código está mal escrito: ` +
            `en cualquiera de los dos casos, cargarlo posaría dinero donde el archivo no lo declara.`
        )
      );
      continue;
    }
    if (vistos.has(clave)) {
      documentosInvalidos++;
      findings.push(
        finding(
          'APE-DOCUMENTO-DUPLICADO',
          'bloquea',
          d.cuenta,
          `El documento "${d.documento}" de la cuenta "${d.cuenta}" viene dos veces. Dos renglones con ` +
            `el mismo folio se cobran dos veces y se concilian una: no se elige uno, se corrige el ` +
            `auxiliar.`
        )
      );
      continue;
    }
    vistos.add(clave);
    let importe: Decimal;
    try {
      importe = new Decimal(d.importe);
    } catch {
      documentosInvalidos++;
      findings.push(
        finding(
          'APE-DOCUMENTO-IMPORTE',
          'bloquea',
          d.cuenta,
          `El documento "${d.documento}" trae el importe "${d.importe}", que no es una cifra decimal.`
        )
      );
      continue;
    }
    // LA ESCALA DEL AUXILIAR NO SE REDONDEA EN SILENCIO (WIT-02 de #217).
    //
    // `OpeningDocument.importe` viene del llamador, no del XML, así que NO pasa
    // por `LEC-BAL-ESCALA` —el lector sí bloquea ahí—. Sin esta guarda, un
    // "4000.00005" cuadraba el residuo de su cuenta de control EN MEMORIA con
    // precisión completa y `DECIMAL(19,4)` lo redondeaba AL ESCRIBIR: el
    // auxiliar que la carga dio por cuadrado dejaba de estarlo en el mayor, y
    // por una diferencia que nadie nombró.
    //
    // Es el mismo límite y el mismo argumento que el lector: redondear cada uno
    // de ochocientos documentos es exactamente cómo se pierde el peso que esta
    // carga promete cuadrar.
    if (importe.decimalPlaces() > ESCALA_DEL_MAYOR) {
      documentosInvalidos++;
      findings.push(
        finding(
          'APE-DOCUMENTO-ESCALA',
          'bloquea',
          d.cuenta,
          `El documento "${d.documento}" de "${d.cuenta}" trae el importe "${d.importe}", con ` +
            `${importe.decimalPlaces()} decimales, y el mayor guarda ${ESCALA_DEL_MAYOR} ` +
            `(DECIMAL(19,4)). No se redondea en silencio: el auxiliar dejaría de cuadrar con su ` +
            `cuenta de control por una diferencia que nadie nombró.`
        )
      );
      continue;
    }
    // Y EL RANGO, por el otro extremo. Un importe con más enteros de los que
    // caben no se redondea: revienta al escribir, con un error de Postgres en
    // vez de un hallazgo. Se rehúsa aquí, con el folio a la vista.
    if (importe.abs().gte(new Decimal(10).pow(ENTEROS_DEL_MAYOR))) {
      documentosInvalidos++;
      findings.push(
        finding(
          'APE-DOCUMENTO-FUERA-DE-RANGO',
          'bloquea',
          d.cuenta,
          `El documento "${d.documento}" de "${d.cuenta}" trae "${d.importe}", que no cabe en ` +
            `DECIMAL(19,4): el mayor admite ${ENTEROS_DEL_MAYOR} dígitos enteros. Revisa el ` +
            `auxiliar: casi siempre es un separador de miles leído como parte del número.`
        )
      );
      continue;
    }
    if (importe.isZero()) {
      documentosInvalidos++;
      findings.push(
        finding(
          'APE-DOCUMENTO-SIN-SALDO',
          'bloquea',
          d.cuenta,
          `El documento "${d.documento}" de "${d.cuenta}" viene con saldo cero. Un documento saldado no ` +
            `es un renglón del auxiliar de apertura: si se carga, aparece abierto en la antigüedad de ` +
            `saldos y alguien lo va a intentar cobrar.`
        )
      );
      continue;
    }
    if (importe.isNegative()) {
      findings.push(
        finding(
          'APE-DOCUMENTO-CONTRARIO',
          'aviso',
          d.cuenta,
          `El documento "${d.documento}" de "${d.cuenta}" trae ${d.importe}, contrario a la naturaleza ` +
            `de la cuenta. Es legítimo —una nota de crédito o un cobro sin aplicar—, y se dice porque ` +
            `en la antigüedad de saldos va a salir como un saldo a favor.`
        )
      );
    }
    if (d.vencimiento === undefined || d.vencimiento === '') {
      findings.push(
        finding(
          'APE-SIN-VENCIMIENTO',
          'aviso',
          d.cuenta,
          `El documento "${d.documento}" de "${d.cuenta}" no trae vencimiento. Entra igual, y la ` +
            `antigüedad de saldos no lo podrá clasificar por días: para eso hace falta la fecha en la ` +
            `que se hace exigible.`
        )
      );
    }
    const lista = porCuenta.get(d.cuenta) ?? [];
    lista.push(d);
    porCuenta.set(d.cuenta, lista);
  }

  // ── LAS LÍNEAS ──────────────────────────────────────────────────────
  const lines: OpeningLine[] = [];
  const control: ControlAccountPlan[] = [];
  const resultadoAbierto: { code: string; importe: Decimal }[] = [];
  let bloqueado = documentosInvalidos > 0;

  for (const { f, cuenta } of resueltas) {
    const natur = naturDe(cuenta.normal_balance);
    const declaradoPorLasHijas = deLasHijas.get(f.numCta);
    const residuo = saldoDelMayor(f.saldoFin, natur).minus(declaradoPorLasHijas ?? new Decimal(0));

    // ── LA CUENTA QUE DECLARA MENOS QUE SUS PROPIAS HIJAS ──────────────
    //
    // Bajo la regla del Anexo 24 el saldo de una cuenta de mayor INCLUYE el
    // de sus subcuentas, así que su parte propia no puede correr en contra de
    // su naturaleza: si «105 Clientes» declara 7 000 y su única subcuenta
    // declara 12 000, el residuo son −5 000 de abono sobre una cuenta
    // deudora. El asiento se escribe igual —y sumado el árbol vuelve a dar lo
    // que el archivo decía, así que el cotejo al peso sigue en verde—, y por
    // eso mismo hay que DECIRLO: es la firma de un exportador que entregó los
    // niveles de dos cortes distintos, o que repitió una subcuenta bajo dos
    // padres, y sin este aviso el único rastro sería un abono raro en una
    // cuenta de mayor que nadie vuelve a mirar.
    //
    // Es un AVISO y no un portazo: una cuenta de mayor con movimiento propio
    // contrario a su naturaleza es rara, no imposible, y el archivo se
    // reproduce tal como vino.
    if (declaradoPorLasHijas !== undefined && saldoDelMayor(residuo.toString(), natur).isNegative()) {
      findings.push(
        finding(
          'APE-RESIDUO-CONTRARIO',
          'aviso',
          f.numCta,
          // El SaldoFin va TAL COMO EL ARCHIVO LO DECLARA —en la naturaleza de
          // la cuenta—, que es como quien lee el aviso lo tiene delante.
          `"${f.numCta}" (${cuenta.name}) declara ${f.saldoFin} y sus ` +
            `subcuentas de este mismo archivo declaran ` +
            `${saldoDelMayor(declaradoPorLasHijas.toString(), natur).toFixed(2)}: más que ella. Lo que ` +
            `se le postea es la diferencia, ` +
            `${saldoDelMayor(residuo.toString(), natur).toFixed(2)}, contraria a su naturaleza. Sumado ` +
            `el árbol cuadra con el archivo, pero un mayor que declara menos que sus hijas suele ser ` +
            `un exportador que mezcló dos cortes o que repitió una subcuenta bajo dos padres: ` +
            `compruébalo en el origen antes de dar la migración por buena.`,
          f.fila
        )
      );
    }
    const docs = porCuenta.get(f.numCta) ?? [];
    const { kind, decidio } = resolveSubledgerKind(cuenta, porCodigo);
    /** El antepasado que lo decidió, o `null` si lo decidió ella misma. */
    const heredado = decidio === null || decidio === f.numCta ? null : decidio;

    if (residuo.isZero() && docs.length === 0) {
      // Ni saldo propio ni detalle: la cuenta de mayor cuyo importe está
      // entero en sus hijas. No se postea nada y no es un defecto.
      if (kind !== null) {
        control.push({
          code: f.numCta,
          name: cuenta.name,
          kind,
          residual: '0.0000',
          detalle: '0.0000',
          documentos: 0,
          cubierto: true,
        });
      }
      continue;
    }

    // LAS CUENTAS DE RESULTADO NO SE ARRASTRAN.
    if (TIPOS_DE_RESULTADO.has(cuenta.account_type)) {
      resultadoAbierto.push({ code: f.numCta, importe: residuo });
      bloqueado = true;
      continue;
    }

    // LA CUENTA TIENE QUE PODER RECIBIR EL ASIENTO. `validateJournalEntry` lo
    // rechazaría de todas formas, pero lo haría con el asiento entero y sin
    // decir qué cuenta: aquí se nombra la cuenta y su bandera.
    if (!cuenta.is_active || cuenta.is_header || !cuenta.allow_manual_entries) {
      bloqueado = true;
      findings.push(
        finding(
          'APE-CUENTA-NO-POSTEABLE',
          'bloquea',
          f.numCta,
          `"${f.numCta}" (${cuenta.name}) lleva saldo de apertura y no admite asientos: ` +
            `${!cuenta.is_active ? 'está archivada' : cuenta.is_header ? 'es una cuenta cabecera' : 'tiene los asientos manuales cerrados'}. ` +
            `El saldo existe y hay que posarlo en algún sitio: abre la cuenta, o mueve el saldo a la ` +
            `subcuenta que lo lleve en el origen.`,
          f.fila
        )
      );
      continue;
    }

    if (kind !== null || docs.length > 0) {
      const suma = docs.reduce((a, d) => a.plus(saldoDelMayor(d.importe, natur)), new Decimal(0));
      const cubierto = suma.equals(residuo);

      if (kind !== null) {
        control.push({
          code: f.numCta,
          name: cuenta.name,
          kind,
          residual: saldoDelMayor(residuo.toString(), natur).toFixed(4),
          detalle: saldoDelMayor(suma.toString(), natur).toFixed(4),
          documentos: docs.length,
          cubierto,
        });
      }

      if (kind !== null && docs.length === 0) {
        bloqueado = true;
        findings.push(
          finding(
            kind === 'cxc' ? 'APE-CXC-AGREGADA' : 'APE-CXP-AGREGADA',
            'bloquea',
            f.numCta,
            `"${f.numCta}" (${cuenta.name}) es la cuenta de ${kind === 'cxc' ? 'CLIENTES' : 'PROVEEDORES'} ` +
              `y la balanza sólo trae su TOTAL: ${saldoDelMayor(residuo.toString(), natur).toFixed(2)}. ` +
              `Un total no se cobra ni se paga —se cobra la factura A-123, no «12 000 de clientes»— y ` +
              `cargado como un renglón único deja la conciliación del auxiliar descuadrada por ese ` +
              `importe para siempre: sale en 'ar reconcile' como un asiento manual sobre la cuenta de ` +
              `control, que es la causa número uno de un descuadre que nadie encuentra. Trae el auxiliar ` +
              `documento a documento de esta cuenta y vuelve a correr la carga. No hay bandera que se ` +
              `lo salte: cargar el agregado es escribir el defecto.` +
              // Cuando lo decidió un antepasado hay que DECIRLO: si no, el
              // mensaje afirma que esta cuenta es la de clientes y quien lo
              // lee va a mirar su CodAgrup —que no dice eso— y a pensar que
              // el sistema se equivocó de cuenta.
              (heredado === null
                ? ''
                : ` (Lo es porque cuelga de "${heredado}", que es la que el agrupador identifica como ` +
                  `cuenta de control: ésta no trae un CodAgrup del c_CodAgrup con el que decirlo por ` +
                  `sí misma.)`)
          )
        );
        continue;
      }

      if (!cubierto) {
        bloqueado = true;
        const diferencia = suma.minus(residuo);
        findings.push(
          finding(
            'APE-DETALLE-NO-CUADRA',
            'bloquea',
            f.numCta,
            `Los ${docs.length} documento(s) de "${f.numCta}" suman ` +
              `${saldoDelMayor(suma.toString(), natur).toFixed(2)} y la balanza declara ` +
              `${saldoDelMayor(residuo.toString(), natur).toFixed(2)} para esa cuenta: sobran ` +
              `${saldoDelMayor(diferencia.toString(), natur).toFixed(2)}. El auxiliar y la balanza del ` +
              `mismo corte tienen que decir lo mismo AL PESO; que no lo digan es un descuadre del ` +
              `origen, y cargarlo lo traería aquí convertido en un misterio.`
          )
        );
        continue;
      }

      for (const d of docs) {
        const enElMayor = saldoDelMayor(d.importe, natur);
        lines.push(lineaDe(cuenta, enElMayor, descripcionDeDocumento(ejercicio, cuenta, d), d));
      }
      continue;
    }

    lines.push(lineaDe(cuenta, residuo, descripcionDeSaldo(ejercicio, cuenta)));
  }

  if (resultadoAbierto.length > 0) {
    const total = resultadoAbierto.reduce((a, r) => a.plus(r.importe), new Decimal(0));
    findings.push(
      finding(
        'APE-RESULTADO-ABIERTO',
        'bloquea',
        undefined,
        `La balanza trae ${resultadoAbierto.length} cuenta(s) de resultado con saldo ` +
          `(${resultadoAbierto
            .slice(0, 8)
            .map((r) => `${r.code} ${r.importe.toFixed(2)}`)
            .join(', ')}${resultadoAbierto.length > 8 ? ', …' : ''}; neto ${total.toFixed(2)} en el eje ` +
          `deudor). Un ejercicio nuevo no abre con ingresos ni con gastos: el resultado del anterior ya ` +
          `está en el capital, y volver a cargarlo lo cuenta dos veces y estrena el estado de resultados ` +
          `del año con las cifras del año pasado. Cierra el ejercicio en el sistema de origen y trae su ` +
          `balanza de CIERRE (Mes 13), que es la que ya lleva el resultado llevado a capital.`
      )
    );
  }

  const totalDebe = lines.reduce((a, l) => a.plus(l.debit ?? 0), new Decimal(0));
  const totalHaber = lines.reduce((a, l) => a.plus(l.credit ?? 0), new Decimal(0));

  if (!bloqueado && lines.length === 0) {
    findings.push(
      finding(
        'APE-SIN-IMPORTES',
        'bloquea',
        undefined,
        `La balanza no declara ni un saldo distinto de cero, así que no hay apertura que cargar. Un ` +
          `asiento sin renglones no se puede postear, y decir que la carga tuvo éxito sería informar de ` +
          `un efecto que no existe.`
      )
    );
    bloqueado = true;
  }

  // EL CANDADO DEL «AL PESO»: el asiento cuadra solo o no se escribe.
  if (!bloqueado && !totalDebe.equals(totalHaber)) {
    bloqueado = true;
    findings.push(
      finding(
        'APE-NO-CUADRA',
        'bloquea',
        undefined,
        `El asiento de apertura no cuadra: ${totalDebe.toFixed(2)} al debe contra ` +
          `${totalHaber.toFixed(2)} al haber, ${totalDebe.minus(totalHaber).toFixed(2)} de diferencia. ` +
          `No se pone una cuenta puente: esta diferencia ES la del libro de origen —su activo no iguala ` +
          `a su pasivo más capital— y un plug la escondería dentro de esta contabilidad en vez de ` +
          `enseñarla. Cuádrala allá y vuelve a exportar.`
      )
    );
  }

  return {
    fecha: ejercicio.startDate,
    ejercicio: ejercicio.yearNumber,
    lines,
    totalDebe: totalDebe.toFixed(4),
    totalHaber: totalHaber.toFixed(4),
    control,
    findings,
    puedeCargarse: !bloqueado && findings.every((f) => f.severidad !== 'bloquea'),
  };
}

/** Un importe del mayor convertido en renglón: el signo elige el lado. */
function lineaDe(
  cuenta: OpeningAccountRow,
  enElMayor: Decimal,
  description: string,
  documento?: OpeningDocument
): OpeningLine {
  const positivo = enElMayor.isPositive();
  return {
    code: cuenta.code,
    accountId: cuenta.id,
    debit: positivo ? enElMayor.toFixed(4) : null,
    credit: positivo ? null : enElMayor.negated().toFixed(4),
    description,
    ...(documento === undefined ? {} : { documento }),
  };
}

function descripcionDeSaldo(ejercicio: OpeningExercise, cuenta: OpeningAccountRow): string {
  return `Apertura ${ejercicio.yearNumber} · ${cuenta.code} ${cuenta.name}`;
}

function descripcionDeDocumento(
  ejercicio: OpeningExercise,
  cuenta: OpeningAccountRow,
  d: OpeningDocument
): string {
  // El folio y la contraparte van EN LA LÍNEA, no en el asiento: el auxiliar
  // de cuenta y subcuenta del Anexo 24 se arma de los renglones, y un renglón
  // que dice «Apertura» y nada más es indistinguible de los otros ochocientos.
  const vence = d.vencimiento === undefined || d.vencimiento === '' ? '' : ` · vence ${d.vencimiento}`;
  const uuid = d.uuid === undefined || d.uuid === '' ? '' : ` · UUID ${d.uuid}`;
  return `Apertura ${ejercicio.yearNumber} · ${cuenta.code} · ${d.documento} · ${d.contraparte} · ${d.fecha}${vence}${uuid}`;
}

// ============================================================
// LA ENVOLTURA DE E/S
// ============================================================

export interface ImportOpeningBalanceOptions {
  entityId: string;
  /** El texto de la BalanzaComprobacion, tal como salió del sistema de origen. */
  xml: string;
  userId: string;
  /** El auxiliar abierto de las cuentas de control, documento a documento. */
  documentos?: readonly OpeningDocument[];
  /**
   * El ejercicio que se abre. Por omisión se BUSCA: el que empieza el día
   * siguiente al corte del archivo. Nombrarlo a mano no salta el candado —el
   * plan compara las dos fechas y bloquea si no coinciden—; sirve para que el
   * mensaje diga qué ejercicio se pidió.
   */
  fiscalYearId?: string;
  /** Corre todo y NO escribe. */
  dryRun?: boolean;
  /** Por qué se carga. Va a `audit_log.reason`. */
  reason?: string | null;
}

export interface OpeningBalanceReport extends OpeningPlan {
  entityId: string;
  /** El RFC de la entidad, que es el que el archivo tuvo que traer. */
  rfc: string;
  /** Ejercicio y mes que declara el archivo de origen. */
  origenAnio: string;
  origenMes: string;
  dryRun: boolean;
  /** Cuántos nodos `Ctas` traía el archivo, defectuosos incluidos. */
  filasLeidas: number;
  /** El asiento que quedó posteado, o `null`. */
  asiento: { id: string; entry_number: string } | null;
  escrito: boolean;
}

/**
 * Lee la balanza, planea la apertura y la postea.
 *
 * LANZA cuando la petición es imposible —la entidad no existe o no es de este
 * inquilino, el archivo no es una balanza, el RFC es de otro contribuyente, o
 * no hay ejercicio que empiece el día siguiente al corte—. Eso no es un
 * hallazgo de la carga: es el acto equivocado.
 *
 * NO lanza por lo demás: devuelve el informe con `escrito: false` y todo
 * nombrado, para que quien lo llame pueda imprimirlo entero y elegir el código
 * de salida.
 */
export async function importOpeningBalance(
  ctx: PolicyContext,
  opts: ImportOpeningBalanceOptions
): Promise<OpeningBalanceReport> {
  // EL INQUILINO ACOTA DENTRO DEL SQL, no ordena. Un id de entidad de otro
  // inquilino no devuelve fila, y no hay rama donde eso se confunda con «no
  // existe».
  const entidad = await query<{ tax_id: string; tax_id_type: string; name: string }>(
    `SELECT tax_id, tax_id_type, name
       FROM legal_entities
      WHERE id = $1 AND tenant_id = $2`,
    [opts.entityId, ctx.tenantId]
  );
  const fila = entidad.rows[0];
  if (fila === undefined) {
    throw new ValidationError(`La entidad ${opts.entityId} no existe en este inquilino.`);
  }
  if (fila.tax_id_type !== 'rfc') {
    throw new ValidationError(
      `"${fila.name}" está identificada con ${fila.tax_id_type.toUpperCase()} y no con RFC: la ` +
        `BalanzaComprobacion del Anexo 24 es un archivo mexicano y sólo se puede cotejar contra un RFC.`
    );
  }
  const rfc = fila.tax_id.trim().toUpperCase();

  const lectura = readBalanzaComprobacion(opts.xml);
  if (lectura.header.rfc !== rfc) {
    throw new ValidationError(
      `La balanza es del RFC ${lectura.header.rfc} y "${fila.name}" es ${rfc}. No se carga: posar los ` +
        `saldos de otro contribuyente mezcla dos contabilidades en una entidad, y separarlas después ` +
        `exige saber cuál era cuál cuenta por cuenta.`
    );
  }

  const ejercicio = await ejercicioDeApertura(opts.entityId, lectura, opts.fiscalYearId);

  const cuentas = await query<OpeningAccountRow>(
    `SELECT a.id, a.code, a.name, p.code AS parent_code, a.account_type, a.normal_balance,
            a.codigo_agrupador_sat, a.is_header, a.is_active, a.allow_manual_entries,
            (SELECT r.role
               FROM account_roles r
              WHERE r.account_id = a.id AND r.entity_id = a.entity_id
                AND r.role IN ('cxc', 'cxp')
              ORDER BY r.role
              LIMIT 1) AS role
       FROM accounts a
       LEFT JOIN accounts p ON p.id = a.parent_id AND p.entity_id = a.entity_id
      WHERE a.entity_id = $1`,
    [opts.entityId]
  );

  const plan = planOpeningBalance(
    lectura,
    cuentas.rows,
    opts.documentos ?? [],
    ejercicio
  );

  // LA IDEMPOTENCIA VA POR EL ASIENTO QUE YA EXISTE, no por una bandera: dos
  // corridas de la apertura duplicarían todos los saldos de golpe, que es el
  // accidente más caro que esta superficie puede tener.
  const yaCargada = await query<{ entry_number: string }>(
    `SELECT entry_number
       FROM journal_entries
      WHERE entity_id = $1 AND source_type = 'opening_balance'
        AND entry_date = $2::date AND status <> 'void'
      LIMIT 1`,
    [opts.entityId, ejercicio.startDate]
  );
  const findings: OpeningFinding[] = [...plan.findings];
  let puedeCargarse = plan.puedeCargarse;
  const anterior = yaCargada.rows[0];
  if (anterior !== undefined) {
    puedeCargarse = false;
    findings.push(
      finding(
        'APE-YA-CARGADA',
        'bloquea',
        undefined,
        `Esta entidad ya tiene una apertura posteada el ${ejercicio.startDate}: el asiento ` +
          `${anterior.entry_number}. Cargarla otra vez DUPLICARÍA todos los saldos de una sola vez. Si ` +
          `aquélla estaba mal, anúlala primero —queda el rastro de quién y por qué— y vuelve a correr ` +
          `ésta.`
      )
    );
  }

  const base: OpeningBalanceReport = {
    ...plan,
    findings,
    puedeCargarse,
    entityId: opts.entityId,
    rfc,
    origenAnio: lectura.header.anio,
    origenMes: lectura.header.mes,
    dryRun: opts.dryRun === true,
    filasLeidas: lectura.rowsLeidas,
    asiento: null,
    escrito: false,
  };

  if (!puedeCargarse || opts.dryRun === true) return base;

  const fechaDelAsiento = new Date(`${ejercicio.startDate}T00:00:00`);
  // EL `SELECT` DE ARRIBA ES EL DIAGNÓSTICO; LA GARANTÍA ES EL ÍNDICE (WIT-01
  // de #217). Aquella consulta vive FUERA de esta transacción, así que entre
  // ella y el INSERT cabe otra corrida entera: las dos verían cero filas, las
  // dos postearían, y los saldos de apertura quedarían duplicados de una sola
  // vez. La 081 pone `uq_je_apertura_por_entidad_y_fecha` detrás; aquí se
  // traduce su rechazo a la MISMA respuesta que habría dado el diagnóstico,
  // para que quien pierda la carrera reciba un informe y no una excepción de
  // Postgres.
  let asiento: { id: string; entry_number: string };
  try {
    asiento = await withTransaction(async (client) => {
    const tenantId = await tenantDe(client, opts.entityId);
    const entry = await createJournalEntry(
      opts.entityId,
      fechaDelAsiento,
      // AJUSTE, no 'standard': la apertura no es una operación del negocio,
      // es el arrastre de un libro anterior, y el tipo tiene que decirlo para
      // quien lea el diario dentro de dos años.
      JournalEntryType.ADJUSTING,
      `Saldos de apertura del ejercicio ${ejercicio.yearNumber} · BalanzaComprobacion ` +
        `${lectura.header.anio}-${lectura.header.mes} del sistema anterior`,
      plan.lines.map((l) => ({
        account_id: l.accountId,
        debit_amount: l.debit,
        credit_amount: l.credit,
        description: l.description,
      })),
      opts.userId,
      {
        // `source_type` propio: es lo que permite encontrar la apertura entre
        // veinte mil asientos, y lo que hace idempotente esta superficie.
        sourceType: 'opening_balance',
        reference: `${rfc}${lectura.header.anio}${lectura.header.mes}B`,
        autoPost: true,
        client,
      }
    );

    // El rastro de la CARGA, distinto del rastro del asiento: aquél dice qué
    // se posteó, éste de qué archivo salió y con cuánto detalle de auxiliar.
    await registrarAuditoria(client, {
      tenantId,
      userId: opts.userId,
      action: 'create',
      entityType: 'opening_balance',
      entityId: entry.id,
      oldValues: null,
      newValues: {
        entity_id: opts.entityId,
        fiscal_year: ejercicio.yearNumber,
        entry_date: ejercicio.startDate,
        origen: `xml-sat:BalanzaComprobacion:${lectura.header.anio}-${lectura.header.mes}`,
        rfc,
        cuentas: plan.lines.length,
        documentos_de_auxiliar: plan.lines.filter((l) => l.documento !== undefined).length,
        total_debe: plan.totalDebe,
        total_haber: plan.totalHaber,
      },
      reason: opts.reason ?? null,
    });

    return entry;
    });
  } catch (e) {
    if (!esAperturaDuplicada(e)) throw e;
    // Perdimos la carrera: otra corrida posteó la apertura de esta entidad y
    // esta fecha mientras ésta calculaba. No es un error del operador ni un
    // fallo del sistema —es la defensa funcionando—, así que se contesta con
    // el mismo hallazgo que el diagnóstico habría dado y NADA queda escrito:
    // la transacción entera se deshizo sola.
    return {
      ...base,
      puedeCargarse: false,
      findings: [
        ...base.findings,
        finding(
          'APE-YA-CARGADA',
          'bloquea',
          undefined,
          `Otra carga posteó la apertura de esta entidad el ${ejercicio.startDate} mientras ésta ` +
            `calculaba, así que ésta no escribió nada. Vuelve a consultarla: si aquélla estaba mal, ` +
            `anúlala —queda el rastro de quién y por qué— y corre ésta otra vez.`
        ),
      ],
    };
  }

  // La atestación mira el asiento YA confirmado, así que se lanza después del
  // commit: dentro de la transacción leería una fila que todavía no existe.
  attestEntryAsync(ctx.tenantId, opts.entityId, asiento.id);

  return {
    ...base,
    asiento: { id: asiento.id, entry_number: asiento.entry_number },
    escrito: true,
  };
}

/**
 * ¿Es este error el índice de apertura diciendo que ya hay una?
 *
 * Se mira el NOMBRE del índice y no sólo el código 23505: en la misma
 * transacción se insertan también las líneas y la cabecera, y confundir
 * cualquier choque de unicidad con «ya estaba cargada» convertiría un defecto
 * distinto en un mensaje tranquilizador.
 */
function esAperturaDuplicada(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string; message?: string };
  return (
    err?.code === '23505' &&
    (err.constraint === 'uq_je_apertura_por_entidad_y_fecha' ||
      (err.message ?? '').includes('uq_je_apertura_por_entidad_y_fecha'))
  );
}

/**
 * El ejercicio que empieza el día SIGUIENTE al corte del archivo.
 *
 * Aquí es donde la regla «inicio de ejercicio» deja de ser un comentario: la
 * fecha no se elige, se busca, y si no existe un ejercicio que empiece ese día
 * no hay asiento que escribir. Se nombran los ejercicios que la entidad SÍ
 * tiene, porque el error real casi siempre es que falta crear el nuevo.
 */
async function ejercicioDeApertura(
  entityId: string,
  lectura: BalanceFileRead,
  fiscalYearId?: string
): Promise<OpeningExercise> {
  if (fiscalYearId !== undefined) {
    const r = await query<{ id: string; year_number: number; start_date: string }>(
      `SELECT id, year_number, start_date::text AS start_date
         FROM fiscal_years WHERE id = $1 AND entity_id = $2`,
      [fiscalYearId, entityId]
    );
    const e = r.rows[0];
    if (!e) {
      throw new ValidationError(
        `El ejercicio ${fiscalYearId} no existe o no es de esta entidad. La apertura no cruza entidades.`
      );
    }
    return { id: e.id, yearNumber: e.year_number, startDate: e.start_date };
  }

  const inicio = dayAfterCutoff(lectura.header.anio, lectura.header.mes);
  const r = await query<{ id: string; year_number: number; start_date: string }>(
    `SELECT id, year_number, start_date::text AS start_date
       FROM fiscal_years WHERE entity_id = $1 AND start_date = $2::date`,
    [entityId, inicio]
  );
  const e = r.rows[0];
  if (e) return { id: e.id, yearNumber: e.year_number, startDate: e.start_date };

  const todos = await query<{ year_number: number; start_date: string }>(
    `SELECT year_number, start_date::text AS start_date
       FROM fiscal_years WHERE entity_id = $1 ORDER BY start_date`,
    [entityId]
  );
  throw new ValidationError(
    `La balanza cierra el corte ${lectura.header.anio}-${lectura.header.mes}, así que la apertura va ` +
      `al ${inicio}, y esta entidad no tiene ningún ejercicio que empiece ese día` +
      (todos.rows.length === 0
        ? ` (no tiene ninguno). Crea el ejercicio y sus periodos antes de cargar la apertura: sin ` +
          `periodo abierto no hay dónde postear.`
        : ` (tiene: ${todos.rows.map((t) => `${t.year_number} desde ${t.start_date}`).join(', ')}). ` +
          `Crea el ejercicio que arranca ese día, o trae la balanza del cierre del ejercicio anterior ` +
          `al que quieres abrir.`)
  );
}

/**
 * El informe en texto. Quien migra necesita ver QUÉ entró y qué no antes de
 * confiar en el sistema, y lo está mirando en una terminal.
 */
export function renderOpeningBalanceReport(r: OpeningBalanceReport): string {
  const l: string[] = [];
  l.push(
    `Apertura del ejercicio ${r.ejercicio} · RFC ${r.rfc} · desde la balanza ${r.origenAnio}-${r.origenMes}`
  );
  l.push(`  Asiento al ${r.fecha} · ${r.filasLeidas} filas leídas · ${r.lines.length} renglones`);
  l.push(`  Debe ${r.totalDebe} · Haber ${r.totalHaber}`);
  const conDocumento = r.lines.filter((x) => x.documento !== undefined).length;
  if (conDocumento > 0) {
    l.push(`  ${conDocumento} renglón(es) vienen del auxiliar, documento a documento.`);
  }
  if (r.control.length > 0) {
    l.push('  Cuentas de control:');
    for (const c of r.control) {
      l.push(
        `    ${c.code} (${c.kind}) · balanza ${c.residual} · auxiliar ${c.detalle} · ` +
          `${c.documentos} documento(s) · ${c.cubierto ? 'cuadra' : 'NO CUADRA'}`
      );
    }
  }
  if (r.asiento !== null) {
    l.push(`  POSTEADO: asiento ${r.asiento.entry_number}.`);
  } else {
    l.push(r.dryRun ? '  NADA ESCRITO: es un ensayo (--dry-run).' : '  NADA ESCRITO: ver los hallazgos.');
  }
  if (r.findings.length > 0) {
    l.push('  Hallazgos:');
    for (const f of r.findings) {
      const donde = f.fila === undefined ? '' : ` fila ${f.fila}`;
      const cuenta = f.numCta === undefined ? '' : ` ${f.numCta}`;
      l.push(`    [${f.severidad}] ${f.regla}${donde}${cuenta}: ${f.mensaje}`);
    }
  }
  return l.join('\n');
}
