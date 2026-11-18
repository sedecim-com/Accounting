import Decimal from 'decimal.js';
import { naturDe, saldoDelMayor, type Natur } from '../sat/anexo24/balanza-invariantes.js';
import type { BalanceFileRow } from '../sat/anexo24/balance-reader.js';
import { MEMORANDUM_DOCTRINE } from './sat-agrupador-account-type.js';

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
// ── BOTH SIDES ARE ALREADY AGGREGATED ───────────────────────────────────
//
// The Anexo 24 declares a ledger account INCLUDING its subaccounts: «1120
// Clientes» is the sum of 1120-001, 1120-002… Until #323 our balanza declared
// each account's OWN balance and this judge rolled our tree up before
// comparing. Since #323 `generarBalanza` declares the rolled-up figure itself
// (report-service `rollUpTrialBalanceRows`), so each account the source
// declares is compared against the SAME account in ours, figure to figure.
// Rolling up here again would count every level of the tree twice.
//
// The ledger axis (debit-positive) still matters to PRINT a difference in the
// account's own nature, which is where an accountant looks for it; the sum of
// a credit child under a debit parent is now report-service's business.
//
// ── SURPLUS IS AN ACCOUNT'S OWN MONEY (MNE-001-483) ────────────────────
//
// A previous system may export only the accounts that carry a balance of
// their own, with no header above them, and the load accepts that file. On
// rolled-up rows an undeclared header's figure is mostly its subaccounts'
// money, so calling the whole figure surplus made a file that declares every
// peso fail its own check. For an account the source declares neither itself
// nor through an ancestor, surplus is what it holds of its own: its rolled-up
// figure minus its direct subaccounts' rolled-up figures. Those amounts are
// disjoint, so each peso is named once, at the account that carries it.
// CONTRACT: that subtraction needs `nuestra` ROLLED UP, as both production
// callers hand it over; own balances would come out wrong for every header.
//
// ── MEMORANDUM ACCOUNTS STAY OUT OF THE FOOTING (#219) ─────────────────
//
// The 8xx (UFIN, CUFIN, CUCA…) do not migrate in this version: the owner
// decided it on 2026-09-26 and the doctrine is in `MEMORANDUM_DOCTRINE`. The
// source declares them and our chart never has them, so without being told
// the judge would call each one a missing account and never come out equal.
// The caller names them (`memorandum`); they are not compared, and every one
// is REPORTED as excluded with the source's figure: an exclusion that is not
// written down is a difference someone hid.
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
  /**
   * Dinero propio de una cuenta nuestra que el origen no declara, NI BAJO UN
   * ANTEPASADO SUYO ni en una subcuenta declarada.
   */
  sobrantes: readonly { numCta: string; importe: string }[];
  /** Memorandum accounts of the source left out of the footing, with the figure it declares. */
  excluded: readonly { code: string; amount: string }[];
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
 * Both files declare every ledger account with its subaccounts inside (the
 * Anexo 24 convention, and ours since #323), so the comparison is account to
 * account and nothing is summed here.
 *
 * `memorandum` names the source's memorandum accounts (#219): they are left
 * out of the footing and listed in `excluded`, never silently dropped.
 */
export function compareToSource(
  origen: readonly BalanceFileRow[],
  nuestra: readonly BalanceFileRow[],
  shapes: readonly AccountShape[],
  columna: BalanceColumn = 'SaldoFin',
  memorandum: ReadonlySet<string> = new Set()
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

  const diferencias: BalanceDifference[] = [];
  const faltantes: string[] = [];
  const excluded: { code: string; amount: string }[] = [];
  const comparables: BalanceFileRow[] = [];
  for (const f of origen) {
    if (memorandum.has(f.numCta)) {
      excluded.push({ code: f.numCta, amount: new Decimal(columnaDe(f, columna)).toFixed(ESCALA) });
    } else {
      comparables.push(f);
    }
  }
  // An excluded code does not count as declared: money OUR ledger carries on
  // it is money the source keeps off the balance, and it surfaces as surplus.
  const declaradasPorElOrigen = new Set(comparables.map((f) => f.numCta));

  for (const f of comparables) {
    const n = natur.get(f.numCta);
    if (n === undefined) {
      // El origen declara una cuenta que nuestro plan no tiene. No es una
      // diferencia de importe: es una cuenta que falta, y decirlo así evita
      // que alguien busque un asiento que nunca se pudo escribir.
      faltantes.push(f.numCta);
      continue;
    }
    const esperado = alEjeDeLaSuma(columnaDe(f, columna), n, columna);
    const obtenido = propio.get(f.numCta) ?? new Decimal(0);
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

  // MONEY OF OURS THE SOURCE DOES NOT DECLARE, at the account that holds it.
  // Under an account the source declares, any difference was already named
  // there. Elsewhere an account answers for its OWN money alone: what its
  // subaccounts carry is theirs to answer for, declared or not, which is what
  // keeps a leaves-only source from seeing its headers as surplus.
  const children = new Map<string, string[]>();
  for (const s of shapes) {
    // A self-parent, a `parent_id` fixed by hand, must not cancel its own money.
    if (s.parentCode === null || s.parentCode === s.code) continue;
    children.set(s.parentCode, [...(children.get(s.parentCode) ?? []), s.code]);
  }
  const sobrantes: { numCta: string; importe: string }[] = [];
  for (const s of shapes) {
    const valor = propio.get(s.code);
    if (valor === undefined) continue;
    if (declaradasPorElOrigen.has(s.code)) continue;
    let surplus = valor;
    // An excluded code is never covered by an ancestor: the source keeps that
    // money off the balance, so any of it in OUR ledger is its own finding,
    // for its whole figure, not an echo of a difference named further up
    // (WIT-01, PR #415).
    if (!memorandum.has(s.code)) {
      if (tieneAntepasadoEn(s.code, padre, declaradasPorElOrigen)) continue;
      for (const child of children.get(s.code) ?? []) surplus = surplus.minus(propio.get(child) ?? 0);
    }
    if (surplus.isZero()) continue;
    sobrantes.push({
      numCta: s.code,
      importe: alEjeDeLaSuma(surplus.toString(), s.natur, columna).toFixed(ESCALA),
    });
  }

  return {
    columna,
    comparadas: comparables.length - faltantes.length,
    diferencias,
    faltantes,
    sobrantes,
    excluded,
    iguales: diferencias.length === 0 && faltantes.length === 0 && sobrantes.length === 0,
  };
}

/** El cotejo en texto, para quien lo está mirando en una terminal. */
export function renderBalanceComparison(c: BalanceComparison): string {
  const excludedLines = c.excluded.map(
    (e) =>
      `  ${e.code}: cuenta de orden, fuera del cuadre (el origen declara ${e.amount}); ` +
      `no se migra, ver ${MEMORANDUM_DOCTRINE}`
  );
  if (c.iguales) {
    return [`${c.columna}: ${c.comparadas} cuentas cotejadas · IGUALES AL PESO.`, ...excludedLines].join('\n');
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
  const excludedCodes = new Set(c.excluded.map((e) => e.code));
  for (const s of c.sobrantes) {
    l.push(
      excludedCodes.has(s.numCta)
        ? `  ${s.numCta}: aquí lleva ${s.importe} en una cuenta de orden, que no se migra: ese saldo no ` +
            `debería estar en el mayor (ver ${MEMORANDUM_DOCTRINE})`
        : `  ${s.numCta}: aquí lleva ${s.importe} y el origen no la declara ni a ella ni a un padre suyo`
    );
  }
  l.push(...excludedLines);
  return l.join('\n');
}
