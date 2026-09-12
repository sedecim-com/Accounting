import { C_CODAGRUP, rubroDe } from './sat-agrupadores-catalogo.js';
import type { AccountType } from './account-service.js';

// ============================================================
// O1 · EL TIPO DE CUENTA QUE EL XML NO TRAE
//
// El nodo `Ctas` del Anexo 24 declara número, nombre, agrupador, nivel y
// naturaleza. NO declara si la cuenta es activo, pasivo, capital, ingreso o
// gasto, y `accounts.account_type` es NOT NULL: hay que deducirlo o no hay
// cuenta que crear.
//
// LA DEDUCCIÓN NO SE HACE A OJO NI DEL CÓDIGO DEL CLIENTE. El código de
// cuenta es del cliente y no significa nada fuera de su casa: hay catálogos
// que empiezan el activo en 1, en 100 y en 1000, y `entry-import-service` ya
// vivió lo que cuesta suponerlo. Lo que sí es un hecho publicado por la
// autoridad es el AGRUPADOR: el c_CodAgrup está organizado por rubros y el
// rubro dice de qué es la cuenta.
//
// ── DÓNDE SALE CADA COSA ────────────────────────────────────────────────
//
// La PERTENENCIA la decide `sat-agrupadores-catalogo.ts`, que es la tabla
// oficial extraída del Anexo 24 publicado en el DOF, ya versionada en el
// árbol. Aquí NO se reescribe esa lista: se importa. Lo único que este
// archivo añade es la correspondencia rubro → tipo, que la publicación del
// SAT no trae porque a la autoridad no le hace falta.
//
// Se deduce del RUBRO y no del código completo, y eso importa: `105.99` no
// está en el c_CodAgrup, pero su rubro `105` (Clientes) sí, y con eso basta
// para saber que es activo. Un catálogo ajeno trae subcuentas que la lista
// oficial no enumera; rechazarlas por eso sería rechazar la migración entera.
//
// ── LOS DOS SITIOS DONDE EL RANGO NO BASTA, Y NO SON TEORÍA ─────────────
//
// El encargo describía los rangos como «1xx activo, 2xx pasivo, 3xx capital,
// 4xx ingresos, 5xx-7xx costos y gastos». Los tres primeros y el cuarto se
// sostienen; el resto no, y se comprueba leyendo los nombres que la propia
// lista oficial trae:
//
//   · 7xx NO es todo gasto. El rubro 700 es «Resultado integral de
//     financiamiento», y debajo cuelgan 701 «Gastos financieros» y 703 «Otros
//     gastos» —que sí son gasto— junto a 702 «Productos financieros» y 704
//     «Otros productos», que son INGRESO. Meter los productos financieros en
//     gastos invertiría el signo de un renglón del estado de resultados.
//   · 8xx no aparecía en el encargo y existe: son las CUENTAS DE ORDEN (800
//     a 811 — UFIN, CUFIN, CUCA, ajuste anual por inflación). No son activo
//     ni pasivo ni capital ni resultado: son de memoria, viven fuera del
//     balance y van siempre en pareja con su contracuenta. Este esquema NO
//     tiene un `account_type` para ellas, y las cinco casillas que hay son
//     todas del balance o del resultado. Se declaran IRRESOLUBLES en vez de
//     empujarlas a la casilla menos mala: una cuenta de orden metida en
//     activo suma al balance dinero que no existe.
//
// El rubro 700 a secas es la sombrilla de los dos signos, así que ahí —y
// SÓLO ahí— se recurre a la naturaleza declarada en el archivo. No es
// adivinar: es la única información que la fila trae sobre sí misma, y la
// escribió quien lleva esa contabilidad.
//
// ── LA CONTRACUENTA, QUE SÍ CABE EN ESTE ESQUEMA ────────────────────────
//
// `accounts.account_type` admite `contra_asset`, `contra_liability` y
// `contra_equity`, y el generador del catálogo ya sabe que un `contra_asset`
// es de naturaleza acreedora (`naturalezaSegunTipo` de catalogo-cuentas.ts).
// Así que un rubro de activo con Natur="A" no es una contradicción que haya
// que denunciar: es una contracuenta, y el esquema tiene la casilla exacta.
// 108 «Estimación de cuentas incobrables», 171 «Depreciación acumulada de
// activos fijos» y 189 «Estimación por deterioro» son 1xx y acreedoras las
// tres. Reconocerlas cierra el círculo: el catálogo que se importe vuelve a
// salir por el generador SIN el aviso CAT-NATUR-CONTRA-TIPO, que es la
// prueba de que la ida y la vuelta dicen lo mismo.
//
// Para ingresos y gastos NO hay contracuenta en el esquema (no existe
// `contra_revenue`), así que 402 «Devoluciones, descuentos o bonificaciones
// sobre ingresos» entra como `revenue` con saldo normal deudor. La naturaleza
// del archivo se respeta —es lo que hace que la balanza cuadre— y la
// divergencia contra el tipo se NOMBRA en el informe, que es exactamente lo
// que el generador hace con ella al salir.
// ============================================================

/** Los cinco tipos del esquema que no son contracuenta. */
export type BaseAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type AgrupadorVerdict =
  /** El rubro está en el c_CodAgrup y este módulo sabe de qué es. */
  | 'oficial'
  /** El rubro está, y por sí solo admite los dos signos (hoy: 700). */
  | 'oficial_ambiguo'
  /** El rubro está y es cuenta de orden: no hay casilla en este esquema. */
  | 'cuentas_de_orden'
  /** El rubro no está en el c_CodAgrup del árbol. */
  | 'fuera_de_catalogo'
  /** El archivo no trae CodAgrup en esa fila. */
  | 'ausente'
  /**
   * El rubro está en el catálogo y este módulo no tiene regla para él. Hoy no
   * ocurre —la prueba lo verifica rubro por rubro— y existe porque el día que
   * se cargue el Anexo 24 de otro ejercicio con un rango nuevo, el sistema
   * tiene que decir «no sé» en vez de caer en el último `else` de alguien.
   */
  | 'sin_regla';

export interface AgrupadorReading {
  codAgrup: string;
  /** `105` para `105.02`; el código entero cuando no lleva punto. */
  rubro: string | null;
  /** El nombre oficial del rubro, para que el informe enseñe con qué casó. */
  rubroNombre: string | null;
  verdict: AgrupadorVerdict;
  /** Sólo cuando el veredicto es `oficial`. */
  base: BaseAccountType | null;
}

/** Un tramo de rubros y lo que significa. `null` = admite los dos signos. */
interface RangoDeRubro {
  desde: number;
  hasta: number;
  base: BaseAccountType | null;
  cuentasDeOrden?: true;
}

/**
 * Los tramos, en el orden en que se consultan. Los cuatro primeros son el
 * rango limpio; los cinco del 7xx están fila por fila porque el rango miente
 * ahí (ver la cabecera); el 8xx es la puerta cerrada de las cuentas de orden.
 */
const RANGOS: readonly RangoDeRubro[] = [
  { desde: 100, hasta: 199, base: 'asset' },
  { desde: 200, hasta: 299, base: 'liability' },
  { desde: 300, hasta: 399, base: 'equity' },
  { desde: 400, hasta: 499, base: 'revenue' },
  // Costos (5xx) y gastos (6xx) son la misma casilla en este esquema: no hay
  // un `cost_of_sales` aparte de `expense`, y `fs_category` es quien
  // distingue cogs de operating_expenses cuando alguien decida poblarla.
  { desde: 500, hasta: 599, base: 'expense' },
  { desde: 600, hasta: 699, base: 'expense' },
  { desde: 700, hasta: 700, base: null },
  { desde: 701, hasta: 701, base: 'expense' },
  { desde: 702, hasta: 702, base: 'revenue' },
  { desde: 703, hasta: 703, base: 'expense' },
  { desde: 704, hasta: 704, base: 'revenue' },
  { desde: 800, hasta: 899, base: null, cuentasDeOrden: true },
];

/** Los rubros (nivel 1) del c_CodAgrup del árbol, con su nombre oficial. */
const RUBROS_OFICIALES: ReadonlyMap<string, string> = new Map(
  C_CODAGRUP.filter((a) => a.nivel === 1).map((a) => [a.codigo, a.nombre])
);

/** Se exporta para que la prueba pueda recorrerlos todos y no una muestra. */
export function rubrosOficiales(): readonly string[] {
  return [...RUBROS_OFICIALES.keys()];
}

/**
 * Qué dice el agrupador de una fila sobre el tipo de su cuenta.
 *
 * No lanza nunca: un agrupador ilegible es un HALLAZGO del informe, no una
 * excepción que detenga la lectura de las otras setecientas filas.
 */
export function readAgrupador(codAgrup: string): AgrupadorReading {
  const limpio = codAgrup.trim();
  if (limpio === '') {
    return { codAgrup: limpio, rubro: null, rubroNombre: null, verdict: 'ausente', base: null };
  }

  const rubro = rubroDe(limpio) ?? limpio;
  const nombre = RUBROS_OFICIALES.get(rubro);
  if (nombre === undefined) {
    return { codAgrup: limpio, rubro, rubroNombre: null, verdict: 'fuera_de_catalogo', base: null };
  }

  const n = Number(rubro);
  const rango = RANGOS.find((r) => n >= r.desde && n <= r.hasta);
  if (rango === undefined) {
    return { codAgrup: limpio, rubro, rubroNombre: nombre, verdict: 'sin_regla', base: null };
  }
  if (rango.cuentasDeOrden === true) {
    return { codAgrup: limpio, rubro, rubroNombre: nombre, verdict: 'cuentas_de_orden', base: null };
  }
  if (rango.base === null) {
    return { codAgrup: limpio, rubro, rubroNombre: nombre, verdict: 'oficial_ambiguo', base: null };
  }
  return { codAgrup: limpio, rubro, rubroNombre: nombre, verdict: 'oficial', base: rango.base };
}

/**
 * El desempate del rubro 700, y de nadie más. Es la sombrilla del resultado
 * integral de financiamiento, donde el gasto y el producto conviven: lo único
 * que separa a los dos en esa fila es la naturaleza que el archivo declara.
 */
export function baseDesdeNaturaleza(natur: 'D' | 'A'): BaseAccountType {
  return natur === 'D' ? 'expense' : 'revenue';
}

/**
 * El tipo final, ya con la naturaleza. Donde el esquema tiene contracuenta la
 * usa; donde no la tiene devuelve el tipo base y deja que sea el informe quien
 * nombre la divergencia.
 */
export function accountTypeFrom(base: BaseAccountType, natur: 'D' | 'A'): AccountType {
  switch (base) {
    case 'asset':
      return natur === 'A' ? 'contra_asset' : 'asset';
    case 'liability':
      return natur === 'D' ? 'contra_liability' : 'liability';
    case 'equity':
      return natur === 'D' ? 'contra_equity' : 'equity';
    default:
      // revenue y expense: el esquema no tiene contra_revenue ni
      // contra_expense, así que 402 «Devoluciones sobre ingresos» sale
      // `revenue` con saldo normal deudor. La naturaleza manda sobre el
      // saldo; el tipo dice de qué familia es el renglón.
      return base;
  }
}

/** El tipo base de una cuenta que YA existe, para que sus hijos lo hereden. */
export function baseOfAccountType(tipo: string): BaseAccountType | null {
  switch (tipo) {
    case 'asset':
    case 'contra_asset':
      return 'asset';
    case 'liability':
    case 'contra_liability':
      return 'liability';
    case 'equity':
    case 'contra_equity':
      return 'equity';
    case 'revenue':
      return 'revenue';
    case 'expense':
      return 'expense';
    default:
      return null;
  }
}

/** ¿El tipo y la naturaleza se contradicen? Es la regla del generador, al revés. */
export function naturalezaDelTipo(tipo: AccountType): 'D' | 'A' {
  switch (tipo) {
    case 'asset':
    case 'expense':
    case 'contra_liability':
    case 'contra_equity':
      return 'D';
    default:
      return 'A';
  }
}
