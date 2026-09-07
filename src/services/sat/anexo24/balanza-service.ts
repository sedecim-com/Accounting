import Decimal from 'decimal.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { query, currentTenant } from '../../../database/connection.js';
import { ValidationError, NotFoundError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import {
  getTrialBalance,
  resolvePeriodRange,
  type AvisoDeSaldoInicial,
  type TrialBalanceOptions,
  type TrialBalanceReport,
} from '../../reporting/report-service.js';
import {
  BALANZA_CHECK_NAMES,
  contarHallazgos,
  correrVerificaciones,
  naturDe,
  type BalanzaCheckName,
  type CatalogoDeReferencia,
  type ContextoDeVerificacion,
  type CuentaDeBalanza,
  type HallazgoBalanza,
  type Natur,
} from './balanza-invariantes.js';
import {
  archivarArtefacto,
  hashDelXml,
  ultimoArtefacto,
  xmlArchivado,
  type ArtefactoArchivado,
} from './artefactos.js';
import {
  construirBalanzaXml,
  MES_DE_CIERRE,
  nombreDelArchivo,
  type TipoEnvio,
} from './balanza-xml.js';

// ============================================================
// F07b · LA BALANZA QUE SE ENTREGA
//
// Las dos filas de Fase 1 que este archivo sirve:
//   `e-accounting balance generate`  → el XML del periodo, con su hash.
//   `e-accounting balance check`     → las invariantes que el SAT revisa.
//
// LAS CUATRO COLUMNAS NO SE VUELVEN A CONSULTAR. `getTrialBalance` (F07a) ya
// publica SaldoIni derivado del mayor, Debe, Haber, SaldoFin —pedido aparte, y
// por eso capaz de acusar— y los DESCUADRES con la cuenta y su diferencia.
// Reescribir ese SQL aquí sería la sexta copia de la resta de saldos, que es
// exactamente lo que un criterio del plan cuenta para que ningún mutante pueda
// invertir una y esconderse entre las demás. Aquí se consume.
//
// TRES CRITERIOS DEL PANEL SE LEEN DE VERDAD, y cada uno cambia algo:
//   · anexo24_niveles_a_presentar        → QUÉ CUENTAS entran en el archivo.
//   · anexo24_cuenta_sin_agrupador       → qué cuentas declara el catálogo, y
//                                          por tanto contra qué se coteja.
//   · efirma_sellado_contabilidad_...    → si salir sin sello es el producto
//                                          o es un hallazgo.
// El tercero merece decirse entero: con el valor por omisión el generador
// produce el XML SIN SELLAR y se detiene ahí. No hay en este módulo ningún
// camino que cargue una llave privada, y no debe haberlo.
// ============================================================

/** Lo que identifica al contribuyente en el archivo. */
interface Contribuyente {
  tenant_id: string;
  rfc: string;
  tax_id_type: string;
  name: string;
}

/** El periodo que la balanza declara, ya reducido a Mes y Anio. */
export interface PeriodoDeBalanza {
  fiscal_period_id?: string;
  period_name: string;
  desde: string;
  hasta: string;
  /** '01'..'12', o '13' si es la balanza de cierre. */
  mes: string;
  anio: number;
  cierre: boolean;
}

export interface OpcionesDeBalanza {
  /** `--period`: nombre del periodo, 2026-02, o el id de un periodo fiscal. */
  periodo?: string;
  /** `--type N|C`. Por omisión N. */
  tipo?: TipoEnvio;
  /** `--closing`: la balanza del EJERCICIO, que va en Mes 13. */
  cierre?: boolean;
  /** Obligatoria con `--type C`. */
  fechaModBal?: string;
  /**
   * Contra qué catálogo cotejar. Por omisión, el último CtaCatalogo archivado
   * de la entidad; y si no hay ninguno, el plan de cuentas reconstruido, que
   * `cuentas-en-catalogo` advierte. `null` explícito = no mirar nada, que
   * bloquea.
   */
  catalogo?: CatalogoDeReferencia | null;
  /**
   * Quién genera. Sin él el artefacto NO se archiva: `generado_por` es NOT
   * NULL en la tabla, y un archivo que se entrega a la autoridad sin constar
   * quién lo produjo no es un archivo, es un rumor.
   */
  generadoPor?: string;
  /** `--dry-run`: recorre el camino entero, produce el XML y NO archiva. */
  dryRun?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function contribuyente(entityId: string): Promise<Contribuyente> {
  // EL INQUILINO VA DENTRO DEL SQL, igual que en `generarCatalogoCuentas`.
  // Acotar sólo por entidad deja la frontera en manos de RLS, y RLS no está
  // siempre puesto —la suite de integración corre como superusuario a
  // propósito—: sin esto, una entidad de OTRO inquilino resolvía, `check`
  // publicaba su plan de cuentas entero y `generate` archivaba un artefacto
  // fiscal con el `tenant_id` ajeno y el usuario de esta sesión.
  //
  // Sin contexto de sesión no hay a qué acotar y se conserva el
  // comportamiento anterior, que es el mismo criterio que `contextoDePolitica`
  // aplica dos funciones más abajo.
  const inquilino = currentTenant() ?? null;
  const r = await query<Contribuyente>(
    `SELECT tenant_id, tax_id AS rfc, tax_id_type, name
       FROM legal_entities
      WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
    [entityId, inquilino]
  );
  const e = r.rows[0];
  if (!e) throw new NotFoundError('Legal entity', entityId);
  if (e.tax_id_type !== 'rfc') {
    throw new ValidationError(
      `${e.name} se identifica con «${e.tax_id_type}», no con RFC. La contabilidad electrónica ` +
        `del Anexo 24 la presentan contribuyentes mexicanos ante el SAT.`
    );
  }
  // EL RFC SE NORMALIZA AQUÍ, con el mismo criterio que el catálogo
  // (catalogo-cuentas.ts). `legal_entities.tax_id` no tiene CHECK ni
  // normalización de escritura, así que un RFC guardado con espacios o en
  // minúsculas es un dato posible; con el catálogo normalizando y la balanza
  // no, las dos entregas del mismo mes iban con RFC distinto —y la balanza ni
  // siquiera salía, rechazada por «no tiene forma de RFC», que además culpa al
  // dato equivocado—. El acuse se cotea contra el RFC del archivo.
  return { ...e, rfc: e.rfc.trim().toUpperCase() };
}

/**
 * Contexto de política: el inquilino de la SESIÓN si lo hay, y si no el de la
 * entidad. Y siempre con `entityId`, porque el alcance por entidad se acota y
 * no sólo se ordena: dos sociedades del mismo despacho pueden haber contestado
 * distinto sobre su e.firma.
 */
function contextoDePolitica(entityId: string, tenantId: string): { tenantId: string; entityId: string } {
  return { tenantId: currentTenant() ?? tenantId, entityId };
}

interface FilaDePeriodo {
  id: string;
  period_name: string;
  start_date: string;
  end_date: string;
  period_number: number;
  period_type: string;
}

/** El periodo pedido, SIEMPRE acotado por entidad DENTRO del SQL. */
async function periodoPorReferencia(entityId: string, ref: string): Promise<FilaDePeriodo | null> {
  if (!UUID_RE.test(ref)) return null;
  const r = await query<FilaDePeriodo>(
    `SELECT id, period_name, start_date::text AS start_date, end_date::text AS end_date,
            period_number, period_type
       FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
    [ref, entityId]
  );
  return r.rows[0] ?? null;
}

/**
 * El periodo de CIERRE del ejercicio.
 *
 * Lo que la distingue en el archivo es Mes 13, y lo que la distingue en los
 * libros es que NO es un mes: es donde caen los ajustes con los que se cierra
 * el ejercicio. En este esquema eso es un `fiscal_periods` con
 * `period_number = 13` y `period_type` 'adjustment' o 'closing'.
 *
 * Si la entidad no lo tiene, se NIEGA. La alternativa —presentar diciembre con
 * Mes 13— entrega como balanza de cierre una que no contiene los ajustes de
 * cierre, y el archivo se acepta: nadie se entera hasta la revisión.
 */
async function periodoDeCierre(entityId: string, anio?: number): Promise<FilaDePeriodo> {
  const params: unknown[] = [entityId];
  let filtroAnio = '';
  if (anio !== undefined) {
    params.push(String(anio));
    filtroAnio = `AND EXTRACT(YEAR FROM fp.end_date)::text = $2`;
  }
  const r = await query<FilaDePeriodo>(
    `SELECT fp.id, fp.period_name, fp.start_date::text AS start_date, fp.end_date::text AS end_date,
            fp.period_number, fp.period_type
       FROM fiscal_periods fp
      WHERE fp.entity_id = $1
        AND fp.period_number = 13
        AND fp.period_type IN ('adjustment', 'closing')
        ${filtroAnio}
      ORDER BY fp.end_date DESC
      LIMIT 1`,
    params
  );
  const p = r.rows[0];
  if (!p) {
    throw new ValidationError(
      `Esta entidad no tiene periodo de cierre (period_number 13 de tipo 'adjustment' o 'closing')` +
        (anio !== undefined ? ` para ${anio}` : '') +
        `. La balanza de cierre declara los AJUSTES del ejercicio, no diciembre otra vez: ` +
        `presentar diciembre con Mes 13 entrega un archivo que se acepta y no contiene el cierre.`
    );
  }
  return p;
}

function mesYAnioDe(desde: string, hasta: string, periodName: string): { mes: string; anio: number } {
  const [aIni, mIni] = desde.split('-');
  const [aFin, mFin] = hasta.split('-');
  if (aIni !== aFin || mIni !== mFin) {
    throw new ValidationError(
      `«${periodName}» abarca de ${desde} a ${hasta}, que no es un mes natural. La balanza del ` +
        `Anexo 24 declara UN mes (Mes) de UN ejercicio (Anio): un trimestre o un ejercicio ` +
        `completo no tienen dónde ponerse en el archivo.`
    );
  }
  return { mes: mIni, anio: Number(aIni) };
}

/** Traduce `--period` / `--closing` al periodo que el archivo declara. */
export async function resolverPeriodoDeBalanza(
  entityId: string,
  opts: OpcionesDeBalanza
): Promise<PeriodoDeBalanza> {
  if (opts.cierre) {
    // Con `--closing` el `--period`, si viene, sólo dice DE QUÉ EJERCICIO.
    const anio = opts.periodo ? anioDe(opts.periodo) : undefined;
    const p = await periodoDeCierre(entityId, anio);
    return {
      fiscal_period_id: p.id,
      period_name: p.period_name,
      desde: p.start_date,
      hasta: p.end_date,
      mes: MES_DE_CIERRE,
      anio: Number(p.end_date.slice(0, 4)),
      cierre: true,
    };
  }
  if (!opts.periodo) {
    throw new ValidationError(
      `La balanza es la de UN periodo: indique --period (nombre, 2026-02 o el id del periodo ` +
        `fiscal) o --closing para la del ejercicio. Sin él no hay mes que declarar.`
    );
  }

  const porId = await periodoPorReferencia(entityId, opts.periodo);
  if (porId) {
    const { mes, anio } = mesYAnioDe(porId.start_date, porId.end_date, porId.period_name);
    return {
      fiscal_period_id: porId.id,
      period_name: porId.period_name,
      desde: porId.start_date,
      hasta: porId.end_date,
      mes,
      anio,
      cierre: false,
    };
  }

  const rango = await resolvePeriodRange(entityId, opts.periodo);
  const { mes, anio } = mesYAnioDe(rango.start_date, rango.end_date, rango.period_name);
  return {
    ...(rango.fiscal_period_id ? { fiscal_period_id: rango.fiscal_period_id } : {}),
    period_name: rango.period_name,
    desde: rango.start_date,
    hasta: rango.end_date,
    mes,
    anio,
    cierre: false,
  };
}

/** El año de una expresión de periodo, cuando lo lleva delante. */
function anioDe(expr: string): number | undefined {
  const m = /(\d{4})/.exec(expr.trim());
  return m ? Number(m[1]) : undefined;
}

// ------------------------------------------------------------
// LA POBLACIÓN DEL ARCHIVO, QUE LA FIJA EL PANEL
// ------------------------------------------------------------

/** La población del archivo, tal y como la fija el criterio del panel. */
export interface PoblacionDelArchivo {
  /** Tope de `accounts.account_level`, cuando el criterio lo pone. */
  maxLevel?: number;
  /** Sólo las cuentas que llevan alguna cifra distinta de cero. */
  soloConCifras: boolean;
}

/**
 * `anexo24_niveles_a_presentar` decide qué cuentas entran, y tiene que decidir
 * lo MISMO en la balanza y en el catálogo. Si no, el generador produce una
 * balanza que suspende su propia comprobación cruzada: cuentas declaradas aquí
 * que el catálogo, hecho con otro criterio, no contiene.
 *
 * `las_que_se_mueven` NO se traduce a `excludeZero` de `getTrialBalance`: ese
 * filtro mira el saldo y una cuenta con 100 al debe y 100 al haber tiene saldo
 * cero y SÍ se movió. Se filtra por las cuatro columnas, que es lo que la
 * frase dice — y una cuenta sin movimiento en el mes pero con saldo
 * arrastrado también entra, porque el SAT recalcula sobre su SaldoIni.
 */
export function poblacionPorNiveles(criterio: string): PoblacionDelArchivo {
  switch (criterio) {
    case 'hasta_nivel_2':
      return { maxLevel: 2, soloConCifras: false };
    case 'las_que_se_mueven':
      return { soloConCifras: true };
    default:
      return { soloConCifras: false };
  }
}

/** true = la cuenta lleva alguna cifra que declarar. */
function llevaCifras(c: CuentaDeBalanza): boolean {
  return [c.saldo_ini_mayor, c.debe, c.haber, c.saldo_fin_mayor].some(
    (v) => !new Decimal(v).isZero()
  );
}

interface FilaDeCuenta {
  account_id: string;
  code: string;
  normal_balance: string;
  codigo_agrupador_sat: string | null;
  natur_agrupador: Natur | null;
  tiene_hijas: boolean;
}

/**
 * La naturaleza, el agrupador y su vigencia, para cada cuenta de la entidad.
 *
 * La vigencia se resuelve AL CORTE de la balanza y no a la fecha de hoy: el
 * c_CodAgrup se revisa, y una balanza de 2018 se entrega contra el catálogo
 * que estaba vigente en 2018.
 */
async function metadatosDeCuentas(entityId: string, alCorte: string): Promise<FilaDeCuenta[]> {
  const r = await query<FilaDeCuenta>(
    `SELECT a.id AS account_id,
            a.code,
            a.normal_balance,
            a.codigo_agrupador_sat,
            ag.naturaleza AS natur_agrupador,
            EXISTS (
              SELECT 1 FROM accounts h
               WHERE h.parent_id = a.id AND h.entity_id = a.entity_id AND h.is_active = true
            ) AS tiene_hijas
       FROM accounts a
       LEFT JOIN LATERAL (
         SELECT s.naturaleza
           FROM sat_codigos_agrupadores s
          WHERE s.codigo = a.codigo_agrupador_sat
            AND s.vigente_desde <= $2::date
            AND (s.vigente_hasta IS NULL OR s.vigente_hasta >= $2::date)
          ORDER BY s.vigente_desde DESC
          LIMIT 1
       ) ag ON true
      WHERE a.entity_id = $1 AND a.is_active = true`,
    [entityId, alCorte]
  );
  return r.rows;
}

/** La balanza de F07a, ya con lo que el Anexo 24 necesita por cuenta. */
async function cuentasDeLaBalanza(
  entityId: string,
  periodo: PeriodoDeBalanza,
  criterioNiveles: string
): Promise<{ cuentas: CuentaDeBalanza[]; tb: TrialBalanceReport; inicial: AvisoDeSaldoInicial }> {
  const poblacion = poblacionPorNiveles(criterioNiveles);
  const filtros: TrialBalanceOptions = {
    ...(poblacion.maxLevel !== undefined ? { maxLevel: poblacion.maxLevel } : {}),
    ...(periodo.fiscal_period_id
      ? { fiscalPeriodId: periodo.fiscal_period_id }
      : { sinceDate: periodo.desde, untilDate: periodo.hasta }),
  };
  const tb = await getTrialBalance(entityId, filtros);
  if (!tb.inicial) {
    // `getTrialBalance` sólo omite el sobre `inicial` cuando la balanza no
    // tiene un ANTES, y una balanza de periodo siempre lo tiene. Llegar aquí
    // significa que el periodo no es de esta entidad.
    throw new ValidationError(
      `La balanza de «${periodo.period_name}» salió sin saldo inicial. El periodo no pertenece a ` +
        `esta entidad o no acota un rango: sin SaldoIni no hay nodo Ctas que declarar.`
    );
  }

  const meta = new Map(
    (await metadatosDeCuentas(entityId, periodo.hasta)).map((m) => [m.account_id, m])
  );
  const todas: CuentaDeBalanza[] = tb.rows.map((r) => {
    const m = meta.get(r.account_id);
    return {
      account_id: r.account_id,
      num_cta: r.account_code,
      natur: naturDe(m?.normal_balance ?? 'debit'),
      saldo_ini_mayor: r.beginning_balance ?? '0',
      debe: r.debit_total,
      haber: r.credit_total,
      saldo_fin_mayor: r.final_balance ?? r.ending_balance,
      codigo_agrupador: m?.codigo_agrupador_sat ?? null,
      natur_del_agrupador: m?.natur_agrupador ?? null,
      tiene_hijas: m?.tiene_hijas ?? false,
    };
  });
  const cuentas = poblacion.soloConCifras ? todas.filter(llevaCifras) : todas;
  return { cuentas, tb, inicial: tb.inicial };
}

// ------------------------------------------------------------
// EL CATÁLOGO CONTRA EL QUE SE COTEJA
// ------------------------------------------------------------

/**
 * Reconstruye QUÉ CUENTAS declararía el CtaCatalogo de hoy.
 *
 * No es el artefacto archivado y no pretende serlo: `origen` lo dice y
 * `cuentas-en-catalogo` emite una advertencia por ello. Existe porque la
 * alternativa era que el cotejo cruzado no corriera hasta que el frente del
 * catálogo aterrizara, y entonces la comprobación más cara del Anexo 24 se
 * quedaría sin escribir una vez más.
 *
 * Aplica los DOS criterios que deciden el contenido del catálogo, porque los
 * dos cambian el resultado del cotejo:
 *   · niveles: qué parte del plan entra.
 *   · cuenta sin agrupador: con 'omitir_y_avisar' esas cuentas NO entran, y
 *     entonces la balanza que las declara referencia cuentas no declaradas.
 */
export async function catalogoSegunElPlanDeCuentas(
  entityId: string
): Promise<CatalogoDeReferencia> {
  const e = await contribuyente(entityId);
  const ctx = contextoDePolitica(entityId, e.tenant_id);
  const niveles = (await getPolicy(ctx, 'anexo24_niveles_a_presentar')).value;
  const sinAgrupador = (await getPolicy(ctx, 'anexo24_cuenta_sin_agrupador')).value;

  // Con `las_que_se_mueven` esta reconstrucción declara TODO el plan a
  // propósito: el catálogo real lleva las movidas MÁS SUS PADRES, y saber
  // cuáles se movieron exige las cifras del periodo, que aquí no hay. Un
  // superconjunto no puede acusar de más, que es la única equivocación cara
  // que puede cometer un cotejo.
  const poblacion = poblacionPorNiveles(niveles);
  const params: unknown[] = [entityId];
  let where = 'WHERE a.entity_id = $1 AND a.is_active = true';
  if (poblacion.maxLevel !== undefined) {
    params.push(poblacion.maxLevel);
    where += ` AND a.account_level <= $2`;
  }
  const r = await query<{ code: string; codigo_agrupador_sat: string | null }>(
    `SELECT a.code, a.codigo_agrupador_sat FROM accounts a ${where} ORDER BY a.code`,
    params
  );

  const huerfanas = r.rows.filter((x) => !x.codigo_agrupador_sat).map((x) => x.code);
  const declaradas =
    sinAgrupador === 'omitir_y_avisar'
      ? r.rows.filter((x) => x.codigo_agrupador_sat).map((x) => x.code)
      : r.rows.map((x) => x.code);

  return {
    origen: 'plan_de_cuentas',
    cuentas: declaradas,
    criterio_niveles: niveles,
    criterio_sin_agrupador: sinAgrupador,
    sin_agrupador: huerfanas,
  };
}

/**
 * Los NumCta que declara un CtaCatalogo ya generado.
 *
 * Es la mitad honesta del cotejo cruzado: leer el ARCHIVO que se entregó en
 * vez de reconstruir lo que hoy se entregaría. Está separada de la consulta a
 * propósito —recibe la cadena, no un id— para que se pueda probar sin base y
 * para que no dependa de dónde se archive el artefacto.
 *
 * `removeNSPrefix` porque el prefijo del catálogo lo elige quien lo generó
 * (`catalogocuentas:` es el habitual, no el obligatorio), y preguntar por un
 * prefijo concreto es cómo un cotejo devuelve cero cuentas en silencio — que
 * aquí se leería como «ninguna cuenta está declarada».
 */
export function catalogoDesdeXml(xml: string, referencia?: string): CatalogoDeReferencia {
  if (XMLValidator.validate(xml) !== true) {
    throw new ValidationError(
      `El catálogo archivado no es XML bien formado, así que no se puede cotejar la balanza ` +
        `contra él. Regenere el catálogo antes de presentar.`
    );
  }
  const analizador = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (nombre) => nombre === 'Ctas',
  });
  const crudo: unknown = analizador.parse(xml) as unknown;
  const catalogo = esObjeto(crudo) ? crudo['Catalogo'] : undefined;
  const filas = esObjeto(catalogo) ? catalogo['Ctas'] : undefined;
  const cuentas = Array.isArray(filas)
    ? filas
        .map((f) => (esObjeto(f) ? f['@_NumCta'] : undefined))
        .filter((n): n is string => typeof n === 'string')
    : [];
  if (cuentas.length === 0) {
    throw new ValidationError(
      `El catálogo archivado no declara ningún NumCta. Cotejar contra él daría por no declarada ` +
        `toda cuenta de la balanza, que es un veredicto sobre el catálogo, no sobre la balanza.`
    );
  }
  return {
    origen: 'artefacto_archivado',
    ...(referencia !== undefined ? { referencia } : {}),
    cuentas,
  };
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * El último CtaCatalogo archivado de la entidad, si lo hay.
 *
 * Devuelve `null` —y no lanza— cuando no se ha generado ninguno: eso NO es un
 * error del sistema, es el estado de una entidad que todavía no presentó su
 * catálogo, y `cuentas-en-catalogo` ya sabe que un cotejo sin catálogo es un
 * hallazgo bloqueante y no un aprobado.
 */
export async function catalogoArchivado(entityId: string): Promise<CatalogoDeReferencia | null> {
  const artefacto = await ultimoArtefacto(entityId, 'catalogo');
  if (!artefacto) return null;
  const xml = await xmlArchivado(entityId, artefacto.id);
  if (xml === null) return null;
  return catalogoDesdeXml(xml, artefacto.hash_sha256);
}

// ------------------------------------------------------------
// LAS DOS SUPERFICIES
// ------------------------------------------------------------

export interface MetaDeBalanza {
  tenant_id: string;
  entity_id: string;
  rfc: string;
  anio: number;
  mes: string;
  tipo_envio: TipoEnvio;
  fecha_mod_bal?: string;
  cierre: boolean;
  period_name: string;
  desde: string;
  hasta: string;
  cuentas: number;
  /** Valor efectivo de 'anexo24_niveles_a_presentar'. */
  criterio_niveles: string;
  /** Valor efectivo de 'efirma_sellado_contabilidad_electronica'. */
  criterio_sellado: string;
  /** SIEMPRE false en este tramo, y por decisión, no por falta de tiempo. */
  sellada: boolean;
}

export interface ResultadoDeVerificacion {
  checks: BalanzaCheckName[];
  meta: MetaDeBalanza;
  hallazgos: HallazgoBalanza[];
  /** En el vocabulario de `checkExitCode`: bloqueante → código 4. */
  conteo: { blocking: number; warning: number };
  /** El sobre de F07a, con su procedencia, su `firme` y sus descuadres. */
  inicial: AvisoDeSaldoInicial;
  catalogo: CatalogoDeReferencia | null;
}

/** Todo lo común a generar y a verificar, resuelto una sola vez. */
async function prepararBalanza(
  entityId: string,
  opts: OpcionesDeBalanza
): Promise<{
  meta: MetaDeBalanza;
  cuentas: CuentaDeBalanza[];
  contexto: ContextoDeVerificacion;
  inicial: AvisoDeSaldoInicial;
}> {
  const e = await contribuyente(entityId);
  const ctxPol = contextoDePolitica(entityId, e.tenant_id);
  const criterioNiveles = (await getPolicy(ctxPol, 'anexo24_niveles_a_presentar')).value;
  const criterioSellado = (await getPolicy(ctxPol, 'efirma_sellado_contabilidad_electronica')).value;

  const periodo = await resolverPeriodoDeBalanza(entityId, opts);
  const { cuentas, inicial } = await cuentasDeLaBalanza(entityId, periodo, criterioNiveles);

  // EL COTEJO PREFIERE EL ARTEFACTO ARCHIVADO, que es el catálogo que
  // realmente se entregó. Sólo cuando no hay ninguno se reconstruye del plan
  // de cuentas, y entonces `cuentas-en-catalogo` emite la advertencia que dice
  // que se cotejó contra lo que HOY se generaría, no contra lo presentado.
  // `catalogo: null` explícito conserva el otro camino: no mirar nada, que
  // bloquea.
  const catalogo =
    opts.catalogo !== undefined
      ? opts.catalogo
      : (await catalogoArchivado(entityId)) ?? (await catalogoSegunElPlanDeCuentas(entityId));

  const tipo: TipoEnvio = opts.tipo ?? 'N';
  return {
    meta: {
      tenant_id: e.tenant_id,
      entity_id: entityId,
      rfc: e.rfc,
      anio: periodo.anio,
      mes: periodo.mes,
      tipo_envio: tipo,
      ...(opts.fechaModBal ? { fecha_mod_bal: opts.fechaModBal } : {}),
      cierre: periodo.cierre,
      period_name: periodo.period_name,
      desde: periodo.desde,
      hasta: periodo.hasta,
      cuentas: cuentas.length,
      criterio_niveles: criterioNiveles,
      criterio_sellado: criterioSellado,
      sellada: false,
    },
    cuentas,
    contexto: {
      cuentas,
      descuadres: inicial.descuadres,
      catalogo,
      criterio_sellado: criterioSellado,
      sellada: false,
    },
    inicial,
  };
}

/**
 * `e-accounting balance check` · las invariantes que el SAT revisa.
 *
 * No escribe, no genera y no se detiene en el primer hallazgo: la lista
 * completa es el producto. Quien la llama traduce `conteo` con `checkExitCode`
 * —bloqueante → 4—; el código no se inventa aquí.
 */
export async function verificarBalanza(
  entityId: string,
  opts: OpcionesDeBalanza & { checks?: readonly BalanzaCheckName[] } = {}
): Promise<ResultadoDeVerificacion> {
  const { meta, contexto, inicial } = await prepararBalanza(entityId, opts);
  const checks = [...(opts.checks ?? BALANZA_CHECK_NAMES)];
  const hallazgos = correrVerificaciones(contexto, checks);
  return {
    checks,
    meta,
    hallazgos,
    conteo: contarHallazgos(hallazgos),
    inicial,
    catalogo: contexto.catalogo,
  };
}

export interface BalanzaGenerada {
  xml: string;
  /** sha256 de los bytes. Es lo que `diff` y `file` comparan. */
  hash: string;
  bytes: number;
  /** Nombre sugerido del archivo. */
  nombre: string;
  meta: MetaDeBalanza;
  inicial: AvisoDeSaldoInicial;
  /** Las advertencias que sobreviven a la generación. Las bloqueantes la impiden. */
  hallazgos: HallazgoBalanza[];
  /**
   * El artefacto archivado. `null` en ensayo o sin autor: en los dos casos el
   * XML es exactamente el mismo, y por eso el hash también.
   */
  artefacto: ArtefactoArchivado | null;
}

/**
 * `e-accounting balance generate` · el XML del periodo.
 *
 * SE NIEGA ANTE UN HALLAZGO BLOQUEANTE. La alternativa es entregar un archivo
 * que la autoridad rechaza al rehacer la resta, con el plazo ya gastado; y la
 * superficie para MIRAR una balanza rota existe y es `check`, que no escribe
 * nada y las nombra todas.
 *
 * No sella. Con el criterio por omisión eso es el producto entero; con el otro
 * se dice en un hallazgo. Ninguna rama de este archivo abre una llave privada.
 */
export async function generarBalanza(
  entityId: string,
  opts: OpcionesDeBalanza = {}
): Promise<BalanzaGenerada> {
  const { meta, cuentas, contexto, inicial } = await prepararBalanza(entityId, opts);
  const hallazgos = correrVerificaciones(contexto);
  const conteo = contarHallazgos(hallazgos);
  if (conteo.blocking > 0) {
    throw new ValidationError(
      `La balanza de ${meta.mes}/${meta.anio} no se genera: ${conteo.blocking} hallazgo(s) ` +
        `bloqueante(s). ` +
        hallazgos
          .filter((h) => h.severity === 'blocking')
          .slice(0, 5)
          .map((h) => `[${h.check}${h.referencia ? ` ${h.referencia}` : ''}] ${h.detalle}`)
          .join(' ') +
        (conteo.blocking > 5 ? ` …y ${conteo.blocking - 5} más. ` : ' ') +
        `Corra 'balance check' para verlos todos.`
    );
  }

  const xml = construirBalanzaXml({
    rfc: meta.rfc,
    anio: meta.anio,
    mes: meta.mes,
    tipoEnvio: meta.tipo_envio,
    ...(meta.fecha_mod_bal ? { fechaModBal: meta.fecha_mod_bal } : {}),
    cuentas,
  });

  // SE ARCHIVA porque `diff` y `file` dependen de saber qué se generó, y
  // porque firmar «el catálogo de hoy» reconstruido en el momento es firmar
  // otro archivo que el que el contador revisó. La idempotencia es por hash
  // (artefactos.ts): regenerar sin cambios devuelve la fila que ya estaba, lo
  // que además comprueba gratis que el generador es determinista.
  const generadoPor = opts.dryRun === true ? undefined : opts.generadoPor;
  const artefacto = generadoPor !== undefined
    ? await archivarArtefacto({
        tenantId: meta.tenant_id,
        entityId,
        tipo: 'balanza',
        version: '1.3',
        rfc: meta.rfc,
        anio: meta.anio,
        mes: Number(meta.mes),
        tipoEnvio: meta.tipo_envio,
        xml,
        politicaSellado: meta.criterio_sellado,
        hallazgos,
        generadoPor,
      })
    : null;

  return {
    xml,
    hash: hashDelXml(xml),
    bytes: Buffer.byteLength(xml, 'utf8'),
    nombre: nombreDelArchivo({
      rfc: meta.rfc,
      anio: meta.anio,
      mes: meta.mes,
      tipoEnvio: meta.tipo_envio,
    }),
    meta,
    inicial,
    hallazgos,
    artefacto,
  };
}

/** Suma de control de las cuatro columnas, para quien imprime la balanza. */
export function totalesDeclarados(cuentas: CuentaDeBalanza[]): {
  debe: string;
  haber: string;
} {
  const cero = new Decimal(0);
  return {
    debe: cuentas.reduce((a, c) => a.plus(c.debe), cero).toFixed(2),
    haber: cuentas.reduce((a, c) => a.plus(c.haber), cero).toFixed(2),
  };
}
