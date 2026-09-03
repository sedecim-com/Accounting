import Decimal from 'decimal.js';
import type { DescuadreDeCuenta } from '../../reporting/report-service.js';
import { DECIMALES_IMPORTE_ANEXO24, importeAnexo24 } from './xml.js';

// ============================================================
// F07b · LAS INVARIANTES DE LA BALANZA, SIN TOCAR LA BASE
//
// El modelo es el de statement-checks.ts: verificaciones con NOMBRE, cada una
// una función de datos a hallazgos, y NINGUNA consulta. Eso no es aseo: es la
// condición para que el caso raro se escriba. La trampa de este tramo —una
// cuenta ACREEDORA no suma igual que una deudora— cuesta cuatro líneas de
// prueba aquí y una entidad sembrada entera si viviera pegada a Postgres.
//
// LO QUE AQUÍ **NO** SE HACE, y es deliberado:
//
//   · NO se recalcula SaldoIni + Debe − Haber = SaldoFin a la escala del
//     mayor. Eso ya lo hace `getTrialBalance` (F07a) y devuelve la cuenta y su
//     diferencia en `inicial.descuadres`. La lección de F07a fue que esos
//     descuadres se calculaban y se TIRABAN en las tres superficies; la
//     respuesta no es calcularlos una cuarta vez, es publicarlos. `saldos` los
//     consume tal cual y sólo traduce el signo al que el archivo declara.
//
//   · NO se consulta el mayor. Las cuatro columnas llegan ya resueltas.
//
// LO QUE SÍ ES NUEVO AQUÍ, y no lo cubría nadie: el invariante SOBRE LAS
// CIFRAS DEL ARCHIVO. El mayor es DECIMAL(19,4) y el Anexo 24 se declara con
// DOS decimales, así que entre el libro y el XML hay un redondeo, y redondear
// cuatro cifras por separado puede romper la resta que sí cuadraba:
//
//     SaldoIni 0.0050 + Debe 0.0050 − Haber 0 = SaldoFin 0.0100   (cuadra)
//     redondeado:   0.01 +   0.01   −   0     =        0.01       (NO cuadra)
//
// La autoridad rehace la resta sobre las cifras QUE SE PRESENTARON, no sobre
// las del libro. Un importe bien calculado y mal redondeado se rechaza igual.
// ============================================================

/** Escala de almacenamiento del mayor: DECIMAL(19,4). */
export const ESCALA_DEL_MAYOR = 4;

/**
 * Decimales con los que el Anexo 24 declara los importes.
 *
 * NO SE DEFINE AQUÍ: es la constante del constructor (`xml.ts`), y se reexporta
 * con este nombre para que el resto del frente de la balanza no tenga dos
 * fuentes para la misma cifra. Que sean dos y no cuatro no está verificado
 * contra el XSD —no hay ni un `.xsd` en este repositorio, y esta máquina no
 * tiene red—: es la forma en que el SAT publica la balanza.
 */
export const ESCALA_DEL_ARCHIVO = DECIMALES_IMPORTE_ANEXO24;

/** Naturaleza de una cuenta en el Anexo 24: D deudora, A acreedora. */
export type Natur = 'D' | 'A';

/**
 * De `accounts.normal_balance` a la Natur del Anexo 24.
 *
 * La columna es la fuente correcta y no `account_type`: una `contra_asset`
 * —la depreciación acumulada— es de tipo activo y de naturaleza ACREEDORA, y
 * derivar la naturaleza del tipo la publicaría del revés.
 */
export function naturDe(normalBalance: string): Natur {
  return normalBalance === 'credit' ? 'A' : 'D';
}

/** Una cuenta tal y como entra al nodo Ctas, con lo que hace falta para juzgarla. */
export interface CuentaDeBalanza {
  account_id: string;
  /** NumCta: el código de la cuenta, el mismo que declara el catálogo. */
  num_cta: string;
  natur: Natur;
  /** SaldoIni en la convención DEUDOR-POSITIVA del mayor, escala 4. */
  saldo_ini_mayor: string;
  /** Σ cargos del periodo. No lleva signo: es una suma de importes. */
  debe: string;
  /** Σ abonos del periodo. */
  haber: string;
  /** SaldoFin en la convención deudor-positiva del mayor, escala 4. */
  saldo_fin_mayor: string;
  /** El agrupador que la cuenta declara, cuando lo tiene. */
  codigo_agrupador: string | null;
  /** La naturaleza que el c_CodAgrup vigente asigna a ese agrupador. */
  natur_del_agrupador: Natur | null;
  /** Tiene hijas activas: el Anexo 24 espera el agregado y aquí no se agrega. */
  tiene_hijas: boolean;
}

/** Las cuatro cifras como van a salir en el XML, ya con su signo y su escala. */
export interface ImportesDeclarados {
  SaldoIni: string;
  Debe: string;
  Haber: string;
  SaldoFin: string;
}

/**
 * Un importe del mayor, a la escala y al redondeo con que se declara.
 *
 * El redondeo lo fija `importeAnexo24` (mitad arriba en valor absoluto) y no
 * se repite aquí: dos criterios de redondeo en el mismo archivo es cómo un
 * centavo aparece en una columna y desaparece de otra.
 *
 * El `-0.00` que un saldo entre −0.005 y 0 podría dejar —normal en una cuenta
 * acreedora casi saldada— no hace falta limpiarlo: se comprobó ejecutando que
 * `toFixed` de decimal.js 10.4 ya devuelve «0.00» para −0.001 y para −0.
 */
export function formatearImporte(valor: Decimal | string): string {
  return importeAnexo24(valor instanceof Decimal ? valor.toString() : valor).texto;
}

/**
 * EL SIGNO, QUE ES DONDE ESTÁ LA TRAMPA.
 *
 * El mayor lleva un solo eje: deudor positivo. Una venta de 7 000 deja la
 * cuenta de ingresos en −7 000, y eso es correcto ahí. El Anexo 24 no usa ese
 * eje: declara cada saldo EN SU PROPIA NATURALEZA, de modo que esa misma
 * cuenta se presenta con SaldoIni 7 000. Un `abs()` daría por casualidad la
 * misma cifra y sería la razón equivocada: convertiría en 5 400 el saldo
 * DEUDOR de una acreedora sobregirada, que es justo el caso que hay que poder
 * declarar en negativo.
 *
 * Debe y Haber no se tocan: son sumas de importes, siempre no negativas, y su
 * columna ya dice de qué lado están.
 */
export function importesDeclarados(c: CuentaDeBalanza): ImportesDeclarados {
  const signo = c.natur === 'A' ? -1 : 1;
  return {
    SaldoIni: formatearImporte(new Decimal(c.saldo_ini_mayor).times(signo)),
    Debe: formatearImporte(c.debe),
    Haber: formatearImporte(c.haber),
    SaldoFin: formatearImporte(new Decimal(c.saldo_fin_mayor).times(signo)),
  };
}

/**
 * El invariante que la autoridad rehace, RESPETANDO NATUR.
 *
 *   deudora:   SaldoIni + Debe − Haber = SaldoFin
 *   acreedora: SaldoIni − Debe + Haber = SaldoFin
 *
 * Las dos son la misma resta vista desde su eje, y por eso `saldos` no la
 * repite a la escala del mayor. Se aplica AQUÍ sobre las cifras del archivo,
 * donde el redondeo puede haberla roto.
 */
export function recalculoDelSat(i: ImportesDeclarados, natur: Natur): Decimal {
  const ini = new Decimal(i.SaldoIni);
  const debe = new Decimal(i.Debe);
  const haber = new Decimal(i.Haber);
  return natur === 'A' ? ini.minus(debe).plus(haber) : ini.plus(debe).minus(haber);
}

// ------------------------------------------------------------
// LAS VERIFICACIONES, CON NOMBRE
// ------------------------------------------------------------

export const BALANZA_CHECK_NAMES = [
  'saldos',
  'redondeo',
  'cuentas-en-catalogo',
  'natur-coherente',
  'mayor-sin-agregar',
  'sin-sello',
] as const;
export type BalanzaCheckName = (typeof BALANZA_CHECK_NAMES)[number];

/**
 * LA SEVERIDAD VIVE EN EL HALLAZGO, NO EN LA PRUEBA — la misma disciplina que
 * statement-checks: una prueba dice «esto está roto» y «esto no lo pude
 * verificar», y aplanarlas obliga a elegir entre callar la limitación o fingir
 * un defecto.
 */
export interface HallazgoBalanza {
  check: BalanzaCheckName;
  severity: 'blocking' | 'warning';
  /** NumCta de la cuenta señalada; vacío cuando el hallazgo es del archivo entero. */
  referencia: string;
  /** El porqué, en español y CON LA CIFRA que falla dentro. */
  detalle: string;
}

/** El catálogo contra el que se coteja la balanza. */
export interface CatalogoDeReferencia {
  /**
   * `artefacto_archivado` es el cotejo de verdad: el XML que se generó y se
   * guardó. `plan_de_cuentas` es la reconstrucción de lo que ese XML
   * CONTENDRÍA con los criterios de hoy — sirve, y no es lo mismo, así que se
   * dice en un hallazgo en vez de dejarlo creer.
   */
  origen: 'artefacto_archivado' | 'plan_de_cuentas';
  /** Hash o identificador del artefacto, cuando lo hay. */
  referencia?: string;
  /** Los NumCta que el catálogo declara. */
  cuentas: string[];
  /** Valor efectivo de 'anexo24_niveles_a_presentar' con el que se construyó. */
  criterio_niveles?: string;
  /** Valor efectivo de 'anexo24_cuenta_sin_agrupador'. */
  criterio_sin_agrupador?: string;
  /**
   * Cuentas presentables SIN agrupador. Con el criterio 'bloquear' el catálogo
   * no se puede generar mientras existan; con 'omitir_y_avisar' quedan fuera
   * del archivo y por tanto fuera de esta lista de `cuentas`.
   */
  sin_agrupador?: string[];
}

/** Todo lo que las verificaciones necesitan, ya resuelto. */
export interface ContextoDeVerificacion {
  cuentas: CuentaDeBalanza[];
  /**
   * Los descuadres que `getTrialBalance` YA calculó. Se consumen, no se
   * recalculan: ésa es la lección de F07a.
   */
  descuadres: DescuadreDeCuenta[];
  /** El catálogo contra el que cotejar, o null si no hay ninguno que mirar. */
  catalogo: CatalogoDeReferencia | null;
  /** Valor efectivo de 'efirma_sellado_contabilidad_electronica'. */
  criterio_sellado: string;
  /** El archivo que este tramo produce nunca lleva sello. */
  sellada: boolean;
}

/**
 * `saldos` · SaldoIni + Debe − Haber = SaldoFin respetando Natur.
 *
 * PUBLICA lo que F07a ya señaló, traducido al signo con el que la cuenta se
 * declara: el preparador tiene que poder leer la diferencia en la misma
 * columna en la que la va a buscar en el XML.
 */
export function verificarSaldos(ctx: ContextoDeVerificacion): HallazgoBalanza[] {
  const porId = new Map(ctx.cuentas.map((c) => [c.account_id, c]));
  return ctx.descuadres.map((d) => {
    const cuenta = porId.get(d.account_id);
    // Sin la cuenta a mano no se puede traducir el signo, y una diferencia con
    // el signo del mayor sigue siendo una diferencia: se publica tal cual.
    const signo = cuenta?.natur === 'A' ? -1 : 1;
    const enSuNaturaleza = (v: string) => new Decimal(v).times(signo).toFixed(ESCALA_DEL_MAYOR);
    return {
      check: 'saldos' as const,
      severity: 'blocking' as const,
      referencia: d.account_code,
      detalle:
        `SaldoIni + Debe − Haber da ${enSuNaturaleza(d.esperado)} y el mayor dice ` +
        `${enSuNaturaleza(d.obtenido)} al corte: sobran ${enSuNaturaleza(d.diferencia)} ` +
        `(cuenta ${cuenta ? (cuenta.natur === 'A' ? 'acreedora' : 'deudora') : 'de naturaleza desconocida'}). ` +
        `La autoridad rehace esta resta sobre el archivo presentado.`,
    };
  });
}

/**
 * `redondeo` · el mismo invariante SOBRE LAS CIFRAS DEL ARCHIVO.
 *
 * Sólo mira las cuentas que cuadran en el mayor: si ya fallaban ahí, `saldos`
 * las nombró y repetirlas aquí sería contar dos veces el mismo defecto.
 */
export function verificarRedondeo(ctx: ContextoDeVerificacion): HallazgoBalanza[] {
  const yaSenaladas = new Set(ctx.descuadres.map((d) => d.account_id));
  const hallazgos: HallazgoBalanza[] = [];
  for (const c of ctx.cuentas) {
    if (yaSenaladas.has(c.account_id)) continue;
    const i = importesDeclarados(c);
    const recalculo = recalculoDelSat(i, c.natur);
    const declarado = new Decimal(i.SaldoFin);
    if (recalculo.equals(declarado)) continue;
    hallazgos.push({
      check: 'redondeo',
      severity: 'blocking',
      referencia: c.num_cta,
      detalle:
        `las cuatro columnas cuadran en el mayor y NO cuadran ya redondeadas a ` +
        `${ESCALA_DEL_ARCHIVO} decimales: ${i.SaldoIni} ${c.natur === 'A' ? '−' : '+'} ${i.Debe} ` +
        `${c.natur === 'A' ? '+' : '−'} ${i.Haber} da ${recalculo.toFixed(ESCALA_DEL_ARCHIVO)} ` +
        `y el archivo declararía SaldoFin ${i.SaldoFin}. ` +
        `El importe está bien calculado y mal presentado, y se rechaza igual.`,
    });
  }
  return hallazgos;
}

/**
 * `cuentas-en-catalogo` · la comprobación CRUZADA entre las dos entregas.
 *
 * Es la que caza el error más caro del Anexo 24: una balanza que referencia
 * una cuenta que el catálogo nunca declaró. No se puede hacer mirando un solo
 * archivo, y por eso no la hace nadie hasta que alguien la escribe.
 */
export function verificarCuentasEnCatalogo(ctx: ContextoDeVerificacion): HallazgoBalanza[] {
  if (!ctx.catalogo) {
    // NO PASA EN LIMPIO. Una comprobación que no pudo mirar no es una
    // comprobación limpia, y ésta es la que decide si el envío se acepta.
    return [
      {
        check: 'cuentas-en-catalogo',
        severity: 'blocking',
        referencia: '',
        detalle:
          'no hay catálogo contra el que cotejar: sin un CtaCatalogo generado, ' +
          'ninguna cuenta de esta balanza está declarada ante la autoridad. ' +
          'Genere el catálogo antes de presentar la balanza.',
      },
    ];
  }

  const hallazgos: HallazgoBalanza[] = [];
  const declaradas = new Set(ctx.catalogo.cuentas);
  for (const c of ctx.cuentas) {
    if (declaradas.has(c.num_cta)) continue;
    hallazgos.push({
      check: 'cuentas-en-catalogo',
      severity: 'blocking',
      referencia: c.num_cta,
      detalle:
        `la balanza declara la cuenta ${c.num_cta} y el catálogo ` +
        `(${ctx.catalogo.origen}${ctx.catalogo.referencia ? ` ${ctx.catalogo.referencia}` : ''}) ` +
        `no la contiene` +
        (ctx.catalogo.sin_agrupador?.includes(c.num_cta)
          ? `: no lleva código agrupador y el criterio 'anexo24_cuenta_sin_agrupador' está en ` +
            `'${ctx.catalogo.criterio_sin_agrupador ?? 'desconocido'}'.`
          : '.'),
    });
  }

  // Cotejar contra el plan de cuentas de HOY no es cotejar contra lo que se
  // entregó: los criterios pueden haber cambiado desde entonces.
  if (ctx.catalogo.origen === 'plan_de_cuentas') {
    hallazgos.push({
      check: 'cuentas-en-catalogo',
      severity: 'warning',
      referencia: '',
      detalle:
        'el cotejo se hizo contra el plan de cuentas vigente reconstruido con los criterios de hoy ' +
        `(niveles '${ctx.catalogo.criterio_niveles ?? 'desconocido'}'), no contra un catálogo ` +
        'archivado. Dice si la balanza es coherente con el catálogo que se generaría AHORA; no si ' +
        'lo es con el que ya se presentó.',
    });
  }
  return hallazgos;
}

/**
 * `natur-coherente` · la cuenta y su agrupador dicen la misma naturaleza.
 *
 * Es la incoherencia que la migración 060 dejó cazable al guardar `naturaleza`
 * en `sat_codigos_agrupadores`: una cuenta deudora mapeada a un agrupador
 * acreedor PASA el XSD y la rechaza la validación de fondo. La balanza en sí
 * sigue cuadrando —por eso es advertencia y no bloqueo—: lo que está mal es el
 * mapeo, y quien lo arregla es el catálogo.
 */
export function verificarNaturCoherente(ctx: ContextoDeVerificacion): HallazgoBalanza[] {
  const hallazgos: HallazgoBalanza[] = [];
  for (const c of ctx.cuentas) {
    if (c.natur_del_agrupador === null || c.natur_del_agrupador === c.natur) continue;
    hallazgos.push({
      check: 'natur-coherente',
      severity: 'warning',
      referencia: c.num_cta,
      detalle:
        `la cuenta es ${c.natur === 'A' ? 'ACREEDORA' : 'DEUDORA'} y su agrupador ` +
        `${c.codigo_agrupador ?? '—'} es ${c.natur_del_agrupador === 'A' ? 'ACREEDOR' : 'DEUDOR'}. ` +
        `El signo con el que esta cuenta se declara depende de cuál de los dos tenga razón.`,
    });
  }
  return hallazgos;
}

/**
 * `mayor-sin-agregar` · las cuentas con hijas van SIN el agregado.
 *
 * Este generador declara el saldo PROPIO de cada cuenta. Una cuenta de mayor
 * cuyas subcuentas llevan el movimiento sale por tanto en ceros, y un cero en
 * la balanza se lee como «no se movió», no como «no se sumó». Se dice en vez
 * de dejarlo pasar; agregar la jerarquía es trabajo del catálogo, que es quien
 * conoce SubCtaDe y Nivel.
 */
export function verificarMayorSinAgregar(ctx: ContextoDeVerificacion): HallazgoBalanza[] {
  const enCeros = ctx.cuentas.filter((c) => {
    if (!c.tiene_hijas) return false;
    const i = importesDeclarados(c);
    return (
      new Decimal(i.SaldoIni).isZero() &&
      new Decimal(i.Debe).isZero() &&
      new Decimal(i.Haber).isZero() &&
      new Decimal(i.SaldoFin).isZero()
    );
  });
  if (enCeros.length === 0) return [];
  return [
    {
      check: 'mayor-sin-agregar',
      severity: 'warning',
      referencia: '',
      detalle:
        `${enCeros.length} cuenta(s) con subcuentas van en ceros porque este generador declara el ` +
        `saldo propio de cada cuenta y no agrega la jerarquía (${enCeros
          .map((c) => c.num_cta)
          .join(', ')}). Compruebe si su catálogo espera el agregado en la cuenta de mayor.`,
    },
  ];
}

/**
 * `sin-sello` · el archivo sale sin e.firma, y a veces eso NO es lo pactado.
 *
 * Con el criterio por omisión —`nunca_sellar_en_el_sistema`— un archivo sin
 * sello es exactamente el producto: construir el XML y firmarlo son actos
 * distintos y de manos distintas, y aquí no se emite hallazgo ninguno. El
 * despacho que eligió `sellar_con_custodia` pidió otra cosa, y este tramo no
 * la da: se le dice, en vez de entregarle un archivo que no puede presentar.
 */
export function verificarSello(ctx: ContextoDeVerificacion): HallazgoBalanza[] {
  if (ctx.sellada) return [];
  if (ctx.criterio_sellado === 'nunca_sellar_en_el_sistema') return [];
  return [
    {
      check: 'sin-sello',
      severity: 'warning',
      referencia: '',
      detalle:
        `el criterio 'efirma_sellado_contabilidad_electronica' está en '${ctx.criterio_sellado}' y ` +
        `este archivo sale SIN Sello, noCertificado ni Certificado: la generación no carga ninguna ` +
        `llave privada. Séllelo y transmítalo aparte.`,
    },
  ];
}

const REGISTRO: Record<BalanzaCheckName, (ctx: ContextoDeVerificacion) => HallazgoBalanza[]> = {
  saldos: verificarSaldos,
  redondeo: verificarRedondeo,
  'cuentas-en-catalogo': verificarCuentasEnCatalogo,
  'natur-coherente': verificarNaturCoherente,
  'mayor-sin-agregar': verificarMayorSinAgregar,
  'sin-sello': verificarSello,
};

/** Corre la batería, o exactamente las que se nombren, en el orden publicado. */
export function correrVerificaciones(
  ctx: ContextoDeVerificacion,
  cuales: readonly BalanzaCheckName[] = BALANZA_CHECK_NAMES
): HallazgoBalanza[] {
  const pedidas = new Set(cuales);
  return BALANZA_CHECK_NAMES.filter((n) => pedidas.has(n)).flatMap((n) => REGISTRO[n](ctx));
}

/** Cuenta de hallazgos en el vocabulario del contrato de códigos de salida. */
export function contarHallazgos(hallazgos: HallazgoBalanza[]): {
  blocking: number;
  warning: number;
} {
  return {
    blocking: hallazgos.filter((h) => h.severity === 'blocking').length,
    warning: hallazgos.filter((h) => h.severity === 'warning').length,
  };
}
