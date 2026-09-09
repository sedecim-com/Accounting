import Decimal from 'decimal.js';
import { naturDe, saldoDelMayor, type Natur } from '../sat/anexo24/balanza-invariantes.js';
import type { BalanceFileRow } from '../sat/anexo24/balance-reader.js';

// ============================================================
// O1 · EL COTEJO AL PESO — EL CRITERIO DE ACEPTACIÓN, ESCRITO
//
// La tarjeta de este tramo tiene un solo criterio y es literal: «la balanza
// del sistema viejo y la nuestra, IGUALES AL PESO». Todo lo demás —el lector,
// el asiento, la negativa a agregar CxC— es medio. Este archivo es el juez, y
// existe aparte por eso: para que el criterio se pueda correr contra cualquier
// par de balanzas, en una prueba, en la terminal o en la revisión de una
// migración de verdad, sin arrastrar la carga entera.
//
// ── POR QUÉ HAY QUE AGREGAR ANTES DE COMPARAR ───────────────────────────
//
// El Anexo 24 declara el saldo de una cuenta de mayor INCLUYENDO el de sus
// subcuentas: «1120 Clientes» vale la suma de 1120-001, 1120-002… Este sistema
// no hace eso, y no es un descuido de este tramo: `verificarMayorSinAgregar`
// (F07b) lo declara por escrito y emite una advertencia cuando una cuenta con
// hijas sale en ceros. El mayor guarda el saldo PROPIO de cada cuenta.
//
// Comparar las dos cosas cuenta por cuenta sin agregar daría un falso
// descuadre en cada cuenta de mayor del catálogo —cientos de ellos— y ni uno
// solo sería un peso perdido. Así que el cotejo suma nuestro árbol hacia
// arriba y compara CADA cuenta declarada por el origen contra la suma de su
// subárbol en nuestro mayor. Es la lectura que hace la autoridad, y es la
// única que puede decir «al peso» sin mentir.
//
// ── Y POR QUÉ SE AGREGA EN EL EJE DEL MAYOR, NO EN EL DECLARADO ─────────
//
// Ésta es la trampa fina, y cuesta una cuenta de balance entera. Bajo «1200
// Activo fijo» (deudora) cuelga «1290 Depreciación acumulada» (ACREEDORA). En
// el archivo, la depreciación se declara POSITIVA —cada saldo va en su propia
// naturaleza—, así que sumar las cifras declaradas de las hijas daría
// «costo + depreciación» cuando el activo fijo neto es «costo − depreciación».
// La suma sólo es correcta en el eje único del mayor —deudor positivo—, y por
// eso las dos partes se traducen ahí con `saldoDelMayor` antes de sumar y sólo
// se vuelve a la naturaleza de la cuenta para IMPRIMIR la diferencia, que es
// donde un contador la va a buscar.
// ============================================================

/** La forma del árbol y la naturaleza de cada cuenta: lo que el cotejo necesita. */
export interface AccountShape {
  code: string;
  /** El código del padre, o `null` en la raíz. */
  parentCode: string | null;
  /** 'D' deudora, 'A' acreedora. Sale de `accounts.normal_balance`. */
  natur: Natur;
}

/** Cuál de las cuatro columnas se compara. */
export type BalanceColumn = 'SaldoIni' | 'Debe' | 'Haber' | 'SaldoFin';

export interface BalanceDifference {
  numCta: string;
  /** Lo que declara el archivo de origen, en la naturaleza de la cuenta. */
  esperado: string;
  /** Lo que declara nuestra balanza, ya agregado. */
  obtenido: string;
  /** obtenido − esperado. Distinto de cero es el fallo. */
  diferencia: string;
}

export interface BalanceComparison {
  columna: BalanceColumn;
  /** Cuántas cuentas del origen se pudieron cotejar. */
  comparadas: number;
  /** Vacío = iguales al peso. */
  diferencias: readonly BalanceDifference[];
  /** Cuentas que el origen declara y que no existen en nuestro plan. */
  faltantes: readonly string[];
  /** Dinero nuestro que el origen no declara NI BAJO UN ANTEPASADO SUYO. */
  sobrantes: readonly { numCta: string; importe: string }[];
  /** El veredicto. */
  iguales: boolean;
}

/** Escala a la que se imprimen las diferencias: la del mayor, DECIMAL(19,4). */
const ESCALA = 4;

/**
 * La naturaleza de cada cuenta, indexada. Se acepta `normal_balance` crudo
 * para que quien venga de una consulta no tenga que traducir dos veces.
 */
export function shapesFromRows(
  filas: readonly { code: string; parent_code: string | null; normal_balance: string }[]
): AccountShape[] {
  return filas.map((f) => ({
    code: f.code,
    parentCode: f.parent_code,
    natur: naturDe(f.normal_balance),
  }));
}

/**
 * Suma cada subárbol: para cada cuenta, lo suyo MÁS lo de toda su descendencia.
 *
 * Se recorre de las hojas hacia arriba acumulando en los antepasados en vez de
 * recursar hacia abajo: así una jerarquía con un ciclo —que la base no debería
 * permitir, pero que un `parent_id` mal apuntado a mano sí produce— no cuelga
 * el proceso, porque el ascenso lleva su propio testigo de visitados y se
 * detiene en cuanto se repite.
 *
 * UNA CUENTA AUSENTE DEL RESULTADO VALE CERO. No se siembra el árbol entero
 * con ceros: en un plan de ochocientas cuentas con veinte movidas, sembrarlo
 * sería fabricar setecientas ochenta filas para decir «nada», y el llamador
 * tiene que escribir el cero de todas formas para la cuenta que ni siquiera
 * está en el plan.
 */
export function rollUp(
  shapes: readonly AccountShape[],
  propio: ReadonlyMap<string, Decimal>
): Map<string, Decimal> {
  const padre = new Map(shapes.map((s) => [s.code, s.parentCode]));
  const total = new Map<string, Decimal>();

  for (const s of shapes) {
    const valor = propio.get(s.code);
    if (valor === undefined || valor.isZero()) continue;
    let actual: string | null = s.code;
    const visitados = new Set<string>();
    while (actual !== null && !visitados.has(actual)) {
      visitados.add(actual);
      // Un padre que no está entre las cuentas conocidas no acumula nada: no
      // se inventa una fila para él. Su ausencia ya la denuncia `faltantes`.
      if (padre.has(actual)) total.set(actual, (total.get(actual) ?? new Decimal(0)).plus(valor));
      actual = padre.get(actual) ?? null;
    }
  }
  return total;
}

/** ¿Tiene esta cuenta algún antepasado entre los códigos dados? */
function tieneAntepasadoEn(
  code: string,
  padre: ReadonlyMap<string, string | null>,
  codigos: ReadonlySet<string>
): boolean {
  const visitados = new Set<string>([code]);
  let actual = padre.get(code) ?? null;
  while (actual !== null && !visitados.has(actual)) {
    if (codigos.has(actual)) return true;
    visitados.add(actual);
    actual = padre.get(actual) ?? null;
  }
  return false;
}

function columnaDe(fila: BalanceFileRow, columna: BalanceColumn): string {
  switch (columna) {
    case 'SaldoIni':
      return fila.saldoIni;
    case 'Debe':
      return fila.debe;
    case 'Haber':
      return fila.haber;
    default:
      return fila.saldoFin;
  }
}

/**
 * AL EJE EN EL QUE ESA COLUMNA SE PUEDE SUMAR — Y NO ES EL MISMO PARA LAS
 * CUATRO.
 *
 * Un SALDO lleva la naturaleza dentro: el archivo declara 30 000 tanto para
 * un activo como para la depreciación que lo minora, y sólo el eje único del
 * mayor —deudor positivo— permite sumarlos sin inventar dinero. Ésa es la
 * traducción que hace `saldoDelMayor`.
 *
 * DEBE Y HABER NO. Son sumas de importes, no saldos: el Debe de una cuenta de
 * mayor del Anexo 24 es la SUMA LLANA de los cargos de sus subcuentas, y un
 * cargo sobre una cuenta acreedora sigue siendo un cargo. Pasarlos por
 * `saldoDelMayor` les cambia el signo a las hijas acreedoras y el padre sale
 * con la RESTA de los movimientos en vez de con su suma: en el árbol de la
 * prueba de integración —«171 Depreciación» colgando de «100 Activo»— eso
 * inventa un descuadre de exactamente el doble del Debe de la contracuenta,
 * en un cotejo cuyo trabajo entero es distinguir el peso que falta del que
 * nunca faltó.
 *
 * El defecto estaba escrito y probado del revés: la prueba que lo cubría
 * usaba un árbol con TODAS las cuentas deudoras, donde la multiplicación por
 * −1 nunca llega a ocurrir, así que pasaba en verde sin poder fallar nunca.
 */
function alEjeDeLaSuma(valor: string, natur: Natur, columna: BalanceColumn): Decimal {
  return columna === 'Debe' || columna === 'Haber'
    ? new Decimal(valor)
    : saldoDelMayor(valor, natur);
}

/**
 * EL COTEJO. Cuenta por cuenta, iguales al peso o se nombra cuál y en cuánto.
 *
 * `origen` son las filas del archivo del sistema viejo; `nuestra`, las de la
 * balanza que este sistema genera —leídas con el MISMO lector, que es lo que
 * hace que la comparación no dependa de dos maneras de interpretar el archivo—.
 *
 * Debe y Haber NO se agregan a la ligera y por eso la columna se elige: sumar
 * los cargos de las hijas en el padre es correcto (son sumas de importes), y
 * comparar los saldos exige el eje del mayor. Las dos cosas se hacen igual
 * aquí porque `saldoDelMayor` sobre un Debe —que nunca es negativo— sólo
 * cambiaría el signo de una columna que el archivo declara sin él; por eso el
 * uso normal, y el que la prueba de aceptación corre, es sobre los SALDOS.
 */
export function compareToSource(
  origen: readonly BalanceFileRow[],
  nuestra: readonly BalanceFileRow[],
  shapes: readonly AccountShape[],
  columna: BalanceColumn = 'SaldoFin'
): BalanceComparison {
  const natur = new Map(shapes.map((s) => [s.code, s.natur]));
  const padre = new Map(shapes.map((s) => [s.code, s.parentCode]));

  // Lo NUESTRO, cuenta a cuenta, en el eje del mayor.
  const propio = new Map<string, Decimal>();
  for (const f of nuestra) {
    const n = natur.get(f.numCta);
    if (n === undefined) continue;
    propio.set(f.numCta, alEjeDeLaSuma(columnaDe(f, columna), n, columna));
  }
  const agregado = rollUp(shapes, propio);

  const diferencias: BalanceDifference[] = [];
  const faltantes: string[] = [];
  const declaradasPorElOrigen = new Set(origen.map((f) => f.numCta));

  for (const f of origen) {
    const n = natur.get(f.numCta);
    if (n === undefined) {
      // El origen declara una cuenta que nuestro plan no tiene. No es una
      // diferencia de importe: es una cuenta que falta, y decirlo así evita
      // que alguien busque un asiento que nunca se pudo escribir.
      faltantes.push(f.numCta);
      continue;
    }
    const esperado = alEjeDeLaSuma(columnaDe(f, columna), n, columna);
    const obtenido = agregado.get(f.numCta) ?? new Decimal(0);
    const diferencia = obtenido.minus(esperado);
    if (diferencia.isZero()) continue;
    // De vuelta a la naturaleza de la cuenta para imprimir: el contador
    // compara contra su propia balanza, donde el saldo va en su naturaleza.
    // `alEjeDeLaSuma` es su propia inversa: la vuelta es la misma multiplicación.
    const aSuEje = (v: Decimal) => alEjeDeLaSuma(v.toString(), n, columna).toFixed(ESCALA);
    diferencias.push({
      numCta: f.numCta,
      esperado: aSuEje(esperado),
      obtenido: aSuEje(obtenido),
      diferencia: aSuEje(diferencia),
    });
  }

  // DINERO NUESTRO QUE EL ORIGEN NO DECLARA. Sólo cuenta si NO cuelga de una
  // cuenta que el origen sí declare: si cuelga, su importe ya está dentro del
  // agregado del antepasado y la diferencia —si la hay— se nombró allí.
  // Enumerarlo también aquí llenaría el informe de ecos de un único defecto.
  const sobrantes: { numCta: string; importe: string }[] = [];
  for (const s of shapes) {
    const valor = propio.get(s.code);
    if (valor === undefined || valor.isZero()) continue;
    if (declaradasPorElOrigen.has(s.code)) continue;
    if (tieneAntepasadoEn(s.code, padre, declaradasPorElOrigen)) continue;
    sobrantes.push({
      numCta: s.code,
      importe: alEjeDeLaSuma(valor.toString(), s.natur, columna).toFixed(ESCALA),
    });
  }

  return {
    columna,
    comparadas: origen.length - faltantes.length,
    diferencias,
    faltantes,
    sobrantes,
    iguales: diferencias.length === 0 && faltantes.length === 0 && sobrantes.length === 0,
  };
}

/** El cotejo en texto, para quien lo está mirando en una terminal. */
export function renderBalanceComparison(c: BalanceComparison): string {
  if (c.iguales) {
    return `${c.columna}: ${c.comparadas} cuentas cotejadas · IGUALES AL PESO.`;
  }
  const l: string[] = [
    `${c.columna}: ${c.comparadas} cuentas cotejadas · ${c.diferencias.length} con diferencia · ` +
      `${c.faltantes.length} sin cuenta en el plan · ${c.sobrantes.length} con saldo que el origen no declara`,
  ];
  for (const d of c.diferencias) {
    l.push(`  ${d.numCta}: el origen dice ${d.esperado} y aquí hay ${d.obtenido} (${d.diferencia})`);
  }
  for (const f of c.faltantes) {
    l.push(`  ${f}: el origen la declara y no existe en el plan de cuentas`);
  }
  for (const s of c.sobrantes) {
    l.push(`  ${s.numCta}: aquí lleva ${s.importe} y el origen no la declara ni a ella ni a un padre suyo`);
  }
  return l.join('\n');
}
