import { query } from '../../../database/connection.js';
import { ValidationError } from '../../../utils/errors.js';
import { getPolicy } from '../../policy/policy-service.js';
import type { PolicyContext } from '../../policy/policy-service.js';
import { serializar, type NodoXml } from './xml.js';
import {
  validarCatalogo,
  bloquean,
  NS_CATALOGO,
  NS_XSI,
  PREFIJO_CATALOGO,
  UBICACION_XSD_CATALOGO,
  VERSION_CATALOGO,
  type CabeceraCatalogo,
  type FilaCtas,
  type Hallazgo,
} from './validador.js';
import { archivarArtefacto, hashDelXml, type ArtefactoArchivado } from './artefactos.js';

// ============================================================
// F07b · EL CATÁLOGO DE CUENTAS — CtaCatalogo 1.3
//
// `e-accounting catalog generate` · `contabilidad-electronica catalogo generar`.
//
// El módulo está partido en dos a propósito:
//
//   · `construirCatalogoCuentas` es PURO: recibe las cuentas ya leídas y las
//     tres políticas ya resueltas, y devuelve el XML con su hash y sus
//     hallazgos. No toca la base ni el reloj. Es lo que permite fijar un XML
//     esperado CARÁCTER A CARÁCTER en una prueba unitaria, que es la única
//     forma de defender de verdad la promesa de «bytes idénticos para entradas
//     idénticas».
//   · `generarCatalogoCuentas` es la envoltura de E/S: lee políticas, lee
//     cuentas con la entidad DENTRO del SQL, llama a la función pura y archiva.
//
// LAS TRES POLÍTICAS SE LEEN AQUÍ, con su clave literal dentro de la llamada:
//   · anexo24_niveles_a_presentar              (defecto: jerarquia_completa)
//   · anexo24_cuenta_sin_agrupador             (defecto: bloquear)
//   · efirma_sellado_contabilidad_electronica  (defecto: nunca_sellar_en_el_sistema)
//
// LA REGLA DE LA CASA SOBRE LA e.firma GOBIERNA ESTE ARCHIVO. No hay, en
// ninguna rama, una lectura de llave privada, una llamada al almacén de
// credenciales ni un campo `Sello`. Construir el archivo y firmarlo son actos
// distintos y de manos distintas: éste construye, y lo dice en su salida.
// ============================================================

export type PoliticaNiveles = 'jerarquia_completa' | 'hasta_nivel_2' | 'las_que_se_mueven';
export type PoliticaSinAgrupador = 'bloquear' | 'omitir_y_avisar';

/**
 * Veredicto del agrupador contra el c_CodAgrup. Los tres primeros son los
 * mismos que `validarCodigoAgrupador` de F07a; `sin_agrupador` se añade aquí
 * porque una cuenta sin código no tiene nada que validar y confundir los dos
 * casos produciría el aviso equivocado («no hay catálogo» cuando lo que no hay
 * es código).
 */
export type EstadoAgrupador = 'valido' | 'fuera_de_catalogo' | 'sin_catalogo' | 'sin_agrupador';

/** Una cuenta tal como sale de la consulta, sin decidir nada todavía. */
export interface CuentaParaCatalogo {
  code: string;
  name: string;
  account_level: number;
  /** El `code` del padre, no su id: es lo que va en SubCtaDe. */
  parent_code: string | null;
  codigo_agrupador_sat: string | null;
  normal_balance: string;
  account_type: string;
  lineas_posteadas: number;
  /** La naturaleza que el SAT espera para ese agrupador. NULL hoy: ver abajo. */
  naturaleza_agrupador: string | null;
  estado_agrupador: EstadoAgrupador;
}

export interface PoliticasDelCatalogo {
  niveles: string;
  sinAgrupador: string;
  sellado: string;
}

export interface EntradaCatalogo {
  rfc: string;
  anio: number;
  /** 1–12. */
  mes: number;
  cuentas: readonly CuentaParaCatalogo[];
  politicas: PoliticasDelCatalogo;
}

export interface CuentaOmitida {
  code: string;
  name: string;
  motivo: 'sin_agrupador' | 'fuera_del_alcance_de_niveles';
}

export interface CatalogoConstruido {
  /** `null` cuando la política `bloquear` rehusó generar. */
  xml: string | null;
  hash: string | null;
  bytes: number;
  filas: readonly FilaCtas[];
  omitidas: readonly CuentaOmitida[];
  /** Las cuentas del alcance a las que les falta el agrupador, con nombre. */
  sinAgrupador: readonly { code: string; name: string }[];
  hallazgos: readonly Hallazgo[];
  /** false si hay un hallazgo que bloquea o si la política rehusó. */
  puedeEntregarse: boolean;
  /** Siempre false en F07b. No existe camino que selle. */
  sellado: false;
  notaDeSellado: string;
  politicas: PoliticasDelCatalogo;
}

/** Cuántas cuentas se nombran antes de resumir: una lista de 400 no se lee. */
const MAXIMO_NOMBRADAS = 20;

function nombrar(cuentas: readonly { code: string; name: string }[]): string {
  const primeras = cuentas.slice(0, MAXIMO_NOMBRADAS).map((c) => `${c.code} ${c.name}`);
  const resto = cuentas.length - primeras.length;
  return resto > 0 ? `${primeras.join('; ')}; y ${resto} más` : primeras.join('; ');
}

/**
 * La naturaleza que el TIPO de cuenta implica. No es el agrupador: es la
 * coherencia interna del propio catálogo, y a diferencia de la del agrupador
 * ésta SÍ tiene datos hoy (ver la nota de `naturaleza_agrupador`).
 */
function naturalezaSegunTipo(accountType: string): 'D' | 'A' | null {
  switch (accountType) {
    case 'asset':
    case 'expense':
    case 'contra_liability':
    case 'contra_equity':
      return 'D';
    case 'liability':
    case 'equity':
    case 'revenue':
    case 'contra_asset':
      return 'A';
    default:
      return null;
  }
}

/**
 * Limpia el texto que va a un atributo: colapsa las rachas de espacios en uno
 * y recorta los extremos.
 *
 * POR QUÉ NO SE DEJA TAL CUAL: el constructor RECHAZA un salto de línea dentro
 * de un atributo, porque todo analizador conforme lo convierte en un espacio al
 * leerlo y el SAT recibiría un texto distinto del que se firmó. Un nombre de
 * cuenta con un salto pegado desde Excel es un accidente frecuente y no una
 * intención; con esto el archivo sale, y el cambio se DENUNCIA en vez de
 * ocurrir en silencio. Devuelve el texto y si hubo cambio.
 */
function limpiarTexto(valor: string): { texto: string; cambiado: boolean } {
  const texto = valor.replace(/\s+/g, ' ').trim();
  return { texto, cambiado: texto !== valor };
}

/** El subconjunto de cuentas que la política de niveles manda presentar. */
function aplicarAlcanceDeNiveles(
  cuentas: readonly CuentaParaCatalogo[],
  niveles: string
): { dentro: CuentaParaCatalogo[]; fuera: CuentaParaCatalogo[] } {
  if (niveles === 'hasta_nivel_2') {
    return {
      dentro: cuentas.filter((c) => c.account_level <= 2),
      fuera: cuentas.filter((c) => c.account_level > 2),
    };
  }

  if (niveles === 'las_que_se_mueven') {
    // «Sólo las cuentas con movimiento posteado, MÁS SUS PADRES», dice la
    // opción del panel — y el «más sus padres» no es cortesía: sin el padre,
    // el SubCtaDe del hijo apunta a una cuenta que el archivo no declara, que
    // es exactamente lo que la regla CAT-PADRE-AUSENTE caza. Se sube por la
    // cadena entera, no un salto: un nivel 4 movido arrastra a sus tres
    // ascendientes.
    const porCodigo = new Map(cuentas.map((c) => [c.code, c]));
    const elegidos = new Set<string>();
    for (const c of cuentas) {
      if (c.lineas_posteadas <= 0) continue;
      let actual: CuentaParaCatalogo | undefined = c;
      while (actual !== undefined && !elegidos.has(actual.code)) {
        elegidos.add(actual.code);
        actual = actual.parent_code === null ? undefined : porCodigo.get(actual.parent_code);
      }
    }
    return {
      dentro: cuentas.filter((c) => elegidos.has(c.code)),
      fuera: cuentas.filter((c) => !elegidos.has(c.code)),
    };
  }

  // 'jerarquia_completa' y cualquier valor desconocido: el defecto del panel
  // es incluir todo, y ante un valor que no reconocemos se hace lo mismo que
  // el defecto en vez de recortar el archivo por una cadena inesperada.
  return { dentro: [...cuentas], fuera: [] };
}

/**
 * Construye el CtaCatalogo 1.3. Función pura: mismas entradas, mismos bytes.
 */
export function construirCatalogoCuentas(entrada: EntradaCatalogo): CatalogoConstruido {
  const hallazgos: Hallazgo[] = [];
  const omitidas: CuentaOmitida[] = [];

  const notaDeSellado =
    entrada.politicas.sellado === 'sellar_con_custodia'
      ? 'El despacho tiene declarado el sellado con custodia, pero `catalog generate` NO SELLA: ' +
        'construir el archivo y firmarlo son actos distintos. El sellado y la transmisión viven en ' +
        '`catalog file`. Este archivo sale SIN SELLAR.'
      : 'El archivo sale SIN SELLAR: la e.firma no entra en este proceso. Sellarlo y transmitirlo ' +
        'son actos tuyos (política efirma_sellado_contabilidad_electronica = nunca_sellar_en_el_sistema).';

  // ── 1. EL ALCANCE DE NIVELES ──────────────────────────────────────────
  const { dentro, fuera } = aplicarAlcanceDeNiveles(entrada.cuentas, entrada.politicas.niveles);
  for (const c of fuera) {
    omitidas.push({ code: c.code, name: c.name, motivo: 'fuera_del_alcance_de_niveles' });
  }

  // ── 2. EL AGRUPADOR QUE FALTA ─────────────────────────────────────────
  const sinAgrupador = dentro
    .filter((c) => c.codigo_agrupador_sat === null || c.codigo_agrupador_sat.trim() === '')
    .map((c) => ({ code: c.code, name: c.name }));

  let presentables = dentro;

  if (sinAgrupador.length > 0) {
    if (entrada.politicas.sinAgrupador === 'omitir_y_avisar') {
      const excluidos = new Set(sinAgrupador.map((c) => c.code));
      presentables = dentro.filter((c) => !excluidos.has(c.code));
      for (const c of sinAgrupador) {
        omitidas.push({ code: c.code, name: c.name, motivo: 'sin_agrupador' });
      }
      hallazgos.push({
        regla: 'CAT-SIN-AGRUPADOR-OMITIDAS',
        severidad: 'aviso',
        procedencia: 'coherencia_interna',
        mensaje:
          `${sinAgrupador.length} cuenta(s) quedan FUERA del archivo por no tener código agrupador ` +
          `(política anexo24_cuenta_sin_agrupador = omitir_y_avisar): ${nombrar(sinAgrupador)}. ` +
          `La balanza que se presente después no puede referenciarlas.`,
      });
    } else {
      // 'bloquear', el defecto del panel: no se genera y se NOMBRAN.
      hallazgos.push({
        regla: 'CAT-SIN-AGRUPADOR-BLOQUEA',
        severidad: 'bloquea',
        procedencia: 'coherencia_interna',
        mensaje:
          `No se genera el catálogo: ${sinAgrupador.length} cuenta(s) del alcance no tienen código ` +
          `agrupador del SAT. Mapéalas con \`account map set <code> --scheme sat-agrupador --value <c_CodAgrup>\` ` +
          `o cambia la política anexo24_cuenta_sin_agrupador. Son: ${nombrar(sinAgrupador)}.`,
      });
      return {
        xml: null,
        hash: null,
        bytes: 0,
        filas: [],
        omitidas,
        sinAgrupador,
        hallazgos,
        puedeEntregarse: false,
        sellado: false,
        notaDeSellado,
        politicas: entrada.politicas,
      };
    }
  }

  // ── 3. EL ORDEN ───────────────────────────────────────────────────────
  //
  // Se ordena AQUÍ y no en el SQL, y esto no es duplicar trabajo. `ORDER BY
  // code` en Postgres usa la intercalación de la base: con lc_collate en
  // es_MX.UTF-8 y en C, el mismo catálogo sale en orden distinto, y entonces
  // los «bytes idénticos para entradas idénticas» dependen de cómo se
  // instaló el servidor. La comparación por unidad de código no depende de
  // nada. Por lo mismo NO se usa localeCompare, que depende del ICU del host.
  const ordenadas = [...presentables].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  // ── 4. LAS FILAS, Y LA NATURALEZA ─────────────────────────────────────
  const filas: FilaCtas[] = [];
  const presentes = new Set(ordenadas.map((c) => c.code));

  for (const c of ordenadas) {
    const natur: 'D' | 'A' = c.normal_balance === 'debit' ? 'D' : 'A';

    const desc = limpiarTexto(c.name);
    if (desc.cambiado) {
      hallazgos.push({
        regla: 'CAT-DESC-NORMALIZADA',
        severidad: 'aviso',
        procedencia: 'xml_1_0',
        mensaje:
          `La descripción de "${c.code}" llevaba saltos de línea o espacios repetidos y se emite ` +
          `como "${desc.texto}". Un analizador conforme convierte esos caracteres en un espacio al ` +
          `leer el atributo, así que el SAT nunca habría visto el texto original; se dice en vez de callarlo.`,
        numCta: c.code,
      });
    }

    // LA NATURALEZA CONTRA EL AGRUPADOR. Es el hallazgo que el encargo pide:
    // una cuenta deudora mapeada a un agrupador acreedor PASA EL XSD y la
    // rechaza la validación de fondo, que es el peor sitio donde enterarse.
    //
    // HONESTIDAD SOBRE ESTA COMPROBACIÓN: hoy no puede saltar contra el
    // catálogo sembrado, y no por un defecto de aquí. F07a dejó
    // `sat_codigos_agrupadores.naturaleza` en NULL en las 1060 filas, porque
    // la tabla que el SAT publica trae tres columnas —nivel, código, nombre—
    // y ninguna dice si el agrupador es deudor o acreedor; deducirla del
    // rango del rubro es falso (108 «Estimación de cuentas incobrables» vive
    // en el 1xx del activo y es ACREEDORA). La comprobación queda escrita y
    // probada para el día que haya una fuente que publique la naturaleza.
    if (c.naturaleza_agrupador !== null && c.naturaleza_agrupador !== natur) {
      hallazgos.push({
        regla: 'CAT-NATUR-CONTRA-AGRUPADOR',
        severidad: 'bloquea',
        procedencia: 'coherencia_interna',
        mensaje:
          `"${c.code}" se emite con Natur="${natur}" y el agrupador ${c.codigo_agrupador_sat ?? ''} ` +
          `es de naturaleza "${c.naturaleza_agrupador}" según el catálogo del SAT. El XSD lo acepta; ` +
          `la validación de fondo de la autoridad lo rechaza.`,
        numCta: c.code,
      });
    }

    // La segunda coherencia de la naturaleza, la que SÍ tiene datos hoy: el
    // tipo de cuenta del propio esquema. Un `contra_asset` con saldo normal
    // deudor sale al XML como D y contradice lo que la cuenta dice ser.
    const esperada = naturalezaSegunTipo(c.account_type);
    if (esperada !== null && esperada !== natur) {
      hallazgos.push({
        regla: 'CAT-NATUR-CONTRA-TIPO',
        severidad: 'aviso',
        procedencia: 'coherencia_interna',
        mensaje:
          `"${c.code}" es de tipo ${c.account_type}, que implica naturaleza ${esperada}, y su saldo ` +
          `normal dice ${natur}. Al XML va ${natur}: es lo que el esquema sabe de la cuenta. Revisa cuál de los dos está mal.`,
        numCta: c.code,
      });
    }

    if (c.estado_agrupador === 'fuera_de_catalogo') {
      hallazgos.push({
        regla: 'CAT-AGRUPADOR-FUERA-DE-CATALOGO',
        severidad: 'bloquea',
        procedencia: 'coherencia_interna',
        mensaje:
          `El agrupador "${c.codigo_agrupador_sat ?? ''}" de la cuenta "${c.code}" no está en el ` +
          `c_CodAgrup vigente para este periodo. Presentar un catálogo con un agrupador que la ` +
          `autoridad no reconoce es un rechazo seguro.`,
        numCta: c.code,
      });
    } else if (c.estado_agrupador === 'sin_catalogo') {
      // Mismo criterio que `validarCodigoAgrupador` de F07a: sin catálogo
      // sembrado no se rechaza, se avisa nombrando la causa REAL. Rechazar
      // contra un catálogo ausente es inventarse una respuesta.
      hallazgos.push({
        regla: 'CAT-AGRUPADOR-SIN-CATALOGO',
        severidad: 'aviso',
        procedencia: 'coherencia_interna',
        mensaje:
          `El agrupador "${c.codigo_agrupador_sat ?? ''}" de "${c.code}" se emite SIN VALIDAR: no hay ` +
          `c_CodAgrup sembrado que cubra este periodo. Siembra el catálogo del ejercicio para que esta comprobación sirva.`,
        numCta: c.code,
      });
    }

    // SubCtaDe sólo cuando el padre está EN EL ARCHIVO. Si el padre quedó
    // fuera (por la política de niveles o por no tener agrupador), emitir la
    // referencia produciría un archivo que no resuelve contra sí mismo; se
    // deja fuera y la regla CAT-HUERFANA lo denuncia con nombre y nivel, que
    // es información más útil que una referencia rota.
    const subCtaDe =
      c.parent_code !== null && presentes.has(c.parent_code) ? c.parent_code : undefined;

    filas.push({
      NumCta: c.code,
      Desc: desc.texto,
      ...(subCtaDe === undefined ? {} : { SubCtaDe: subCtaDe }),
      CodAgrup: c.codigo_agrupador_sat ?? '',
      Nivel: c.account_level,
      Natur: natur,
    });
  }

  // ── 5. LAS REGLAS ─────────────────────────────────────────────────────
  const cabecera: CabeceraCatalogo = {
    RFC: entrada.rfc,
    Mes: String(entrada.mes).padStart(2, '0'),
    Anio: String(entrada.anio),
  };
  hallazgos.push(...validarCatalogo(cabecera, filas));

  // ── 6. EL XML ─────────────────────────────────────────────────────────
  //
  // El orden de los atributos es el de esta lista, y se escribe una sola vez:
  // es lo que hace que el archivo de este mes se pueda diffear contra el del
  // anterior línea a línea.
  const raiz: NodoXml = {
    nombre: `${PREFIJO_CATALOGO}:Catalogo`,
    atributos: [
      [`xmlns:${PREFIJO_CATALOGO}`, NS_CATALOGO],
      ['xmlns:xsi', NS_XSI],
      ['xsi:schemaLocation', UBICACION_XSD_CATALOGO],
      ['Version', VERSION_CATALOGO],
      ['RFC', cabecera.RFC],
      ['Mes', cabecera.Mes],
      ['Anio', cabecera.Anio],
    ],
    hijos: filas.map((f) => ({
      nombre: `${PREFIJO_CATALOGO}:Ctas`,
      atributos: [
        ['CodAgrup', f.CodAgrup],
        ['NumCta', f.NumCta],
        ['Desc', f.Desc],
        ['SubCtaDe', f.SubCtaDe],
        ['Nivel', String(f.Nivel)],
        ['Natur', f.Natur],
      ] as const,
    })),
  };

  const xml = serializar(raiz);

  return {
    xml,
    hash: hashDelXml(xml),
    bytes: Buffer.byteLength(xml, 'utf8'),
    filas,
    omitidas,
    sinAgrupador,
    hallazgos,
    puedeEntregarse: bloquean(hallazgos).length === 0,
    sellado: false,
    notaDeSellado,
    politicas: entrada.politicas,
  };
}

// ============================================================
// LA ENVOLTURA DE E/S
// ============================================================

export interface OpcionesGenerarCatalogo {
  entityId: string;
  /** Ejercicio del catálogo. */
  anio: number;
  /** 1–12. */
  mes: number;
  userId: string;
  /** true = construye, valida y NO archiva. */
  dryRun?: boolean;
}

export interface ResultadoGeneracionCatalogo extends CatalogoConstruido {
  entityId: string;
  rfc: string;
  anio: number;
  mes: number;
  /** null en dry-run o cuando no se pudo entregar. */
  artefacto: ArtefactoArchivado | null;
}

/**
 * El veredicto de una cuenta, con los tres casos separados. `sin_catalogo`
 * NUNCA bloquea (lección de F07a: rechazar contra un catálogo ausente es
 * inventarse una respuesta), y `sin_agrupador` no es asunto de esta función:
 * lo resuelve la política `anexo24_cuenta_sin_agrupador`.
 */
export function estadoDelAgrupador(
  codigo: string | null,
  enCatalogo: boolean,
  hayCatalogo: boolean
): EstadoAgrupador {
  if (codigo === null || codigo.trim() === '') return 'sin_agrupador';
  if (!hayCatalogo) return 'sin_catalogo';
  return enCatalogo ? 'valido' : 'fuera_de_catalogo';
}

/** El último día del mes, que es la fecha contra la que se mide la vigencia. */
export function finDeMes(anio: number, mes: number): string {
  const d = new Date(Date.UTC(anio, mes, 0));
  return d.toISOString().slice(0, 10);
}

interface FilaCuentaConsultada {
  code: string;
  name: string;
  account_level: number;
  parent_code: string | null;
  codigo_agrupador_sat: string | null;
  normal_balance: string;
  account_type: string;
  lineas_posteadas: number;
  naturaleza_agrupador: string | null;
  agrupador_en_catalogo: boolean;
}

/**
 * Lee, construye y archiva.
 *
 * NO LANZA cuando la política rehúsa generar ni cuando hay hallazgos que
 * bloquean: devuelve el resultado con `puedeEntregarse: false` y los hallazgos
 * nombrados. Quien decide el código de salida 4 es el CLI, que además tiene que
 * poder imprimirlos en JSON — una excepción convertiría la lista de cuentas en
 * una cadena de texto y perdería la estructura por el camino.
 *
 * Sí lanza cuando la petición es imposible: la entidad no existe, no es del
 * inquilino, o no tiene RFC. Eso no es un hallazgo del catálogo, es un error de uso.
 */
export async function generarCatalogoCuentas(
  ctx: PolicyContext,
  opts: OpcionesGenerarCatalogo
): Promise<ResultadoGeneracionCatalogo> {
  if (!Number.isInteger(opts.mes) || opts.mes < 1 || opts.mes > 12) {
    throw new ValidationError(
      `Mes ${String(opts.mes)} fuera de rango: el catálogo de cuentas se presenta por mes de 1 a 12. ` +
        `El 13 es de la balanza de cierre, no de éste.`
    );
  }
  // El mismo rango que el CHECK de la 062. Se comprueba AQUÍ y no sólo allí
  // porque un año imposible saldría del validador como un simple aviso —el
  // límite superior no se ha podido verificar contra el XSD— y luego reventaría
  // al archivar con una violación de restricción en crudo. Un error de uso se
  // dice en el idioma del que lo cometió, no en el del motor.
  if (!Number.isInteger(opts.anio) || opts.anio < 2015 || opts.anio > 2099) {
    throw new ValidationError(
      `Ejercicio ${String(opts.anio)} fuera de rango: la contabilidad electrónica arranca en 2015 y ` +
        `este sistema archiva hasta 2099.`
    );
  }

  // El RFC y la frontera de entidad, en el mismo SQL: el inquilino ACOTA, no
  // ordena. Un id de entidad de otro inquilino no devuelve fila.
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
      `"${fila.name}" está identificada con ${fila.tax_id_type.toUpperCase()} y no con RFC: ` +
        `la contabilidad electrónica del Anexo 24 es una obligación mexicana y el archivo exige RFC.`
    );
  }
  const rfc = fila.tax_id.trim().toUpperCase();

  const [niveles, sinAgrupador, sellado] = await Promise.all([
    getPolicy(ctx, 'anexo24_niveles_a_presentar'),
    getPolicy(ctx, 'anexo24_cuenta_sin_agrupador'),
    getPolicy(ctx, 'efirma_sellado_contabilidad_electronica'),
  ]);

  const hasta = finDeMes(opts.anio, opts.mes);

  // Una sola consulta: cuentas, padre, movimiento y vigencia del agrupador.
  // La ENTIDAD va en las tres tablas —la cuenta, el padre y el asiento—,
  // porque un asiento de otra entidad no puede ser el que meta una cuenta de
  // ésta en el archivo (misma lección que la compuerta de F07a).
  const cuentas = await query<FilaCuentaConsultada>(
    `WITH mov AS (
       SELECT jel.account_id, COUNT(*)::int AS lineas
         FROM journal_entry_lines jel
         JOIN journal_entries je
           ON je.id = jel.journal_entry_id
          AND je.status = 'posted'
          AND je.entity_id = $1
          AND je.entry_date <= $2::date
        GROUP BY jel.account_id
     )
     SELECT a.code, a.name, a.account_level,
            p.code AS parent_code,
            a.codigo_agrupador_sat, a.normal_balance, a.account_type,
            COALESCE(m.lineas, 0)::int AS lineas_posteadas,
            g.naturaleza AS naturaleza_agrupador,
            (g.codigo IS NOT NULL) AS agrupador_en_catalogo
       FROM accounts a
       LEFT JOIN accounts p ON p.id = a.parent_id AND p.entity_id = $1
       LEFT JOIN mov m ON m.account_id = a.id
       LEFT JOIN LATERAL (
         SELECT s.codigo, s.naturaleza
           FROM sat_codigos_agrupadores s
          WHERE s.codigo = a.codigo_agrupador_sat
            AND s.vigente_desde <= $2::date
            AND (s.vigente_hasta IS NULL OR s.vigente_hasta >= $2::date)
          ORDER BY s.vigente_desde DESC
          LIMIT 1
       ) g ON true
      WHERE a.entity_id = $1 AND a.is_active = true`,
    [opts.entityId, hasta]
  );

  // ¿Hay catálogo que cubra la fecha? Distinto de «ese código no está», y la
  // distinción decide si un agrupador desconocido bloquea o sólo avisa.
  const cobertura = await query<{ hay: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM sat_codigos_agrupadores
        WHERE vigente_desde <= $1::date
          AND (vigente_hasta IS NULL OR vigente_hasta >= $1::date)
     ) AS hay`,
    [hasta]
  );
  const hayCatalogo = cobertura.rows[0]?.hay === true;

  const entrada: EntradaCatalogo = {
    rfc,
    anio: opts.anio,
    mes: opts.mes,
    politicas: { niveles: niveles.value, sinAgrupador: sinAgrupador.value, sellado: sellado.value },
    cuentas: cuentas.rows.map((r) => ({
      code: r.code,
      name: r.name,
      account_level: r.account_level,
      parent_code: r.parent_code,
      codigo_agrupador_sat: r.codigo_agrupador_sat,
      normal_balance: r.normal_balance,
      account_type: r.account_type,
      lineas_posteadas: r.lineas_posteadas,
      naturaleza_agrupador: r.naturaleza_agrupador,
      estado_agrupador: estadoDelAgrupador(r.codigo_agrupador_sat, r.agrupador_en_catalogo, hayCatalogo),
    })),
  };

  const construido = construirCatalogoCuentas(entrada);

  let artefacto: ArtefactoArchivado | null = null;
  if (construido.xml !== null && construido.puedeEntregarse && opts.dryRun !== true) {
    artefacto = await archivarArtefacto({
      tenantId: ctx.tenantId,
      entityId: opts.entityId,
      tipo: 'catalogo',
      version: VERSION_CATALOGO,
      rfc,
      anio: opts.anio,
      mes: opts.mes,
      tipoEnvio: 'N',
      xml: construido.xml,
      politicaSellado: sellado.value,
      hallazgos: construido.hallazgos,
      generadoPor: opts.userId,
    });
  }

  return { ...construido, entityId: opts.entityId, rfc, anio: opts.anio, mes: opts.mes, artefacto };
}
