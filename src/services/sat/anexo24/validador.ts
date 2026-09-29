import { officialEnumeration, OFFICIAL_ENUMERATIONS_XSD } from './official-enumerations.js';

// ============================================================
// F07b · EL VALIDADOR DE REGLAS DEL ANEXO 24
//
// This is not the XSD, and it does not replace it. It checks the chart of
// accounts BEFORE it is serialized, so a finding can name the account the
// accountant has to fix instead of a line number in a file.
//
// Every rule that stands for a facet refuses what the official schema
// refuses. The SAT's ContabilidadE 1.3 XSDs are vendored in `xsd/` with their
// source and SHA-256 (#397), and
// tests/sat/anexo24/official-xsd.spec.ts checks that the XSD rejects what the
// blocking rules here reject. Each finding carries `procedencia`:
//
//   · `estructura_publicada` — node and attribute names, which are required,
//     `Version` fixed at 1.3, `Natur` with its two values. Blocks.
//   · `xml_1_0` — the XML recommendation, not the SAT. Blocks.
//   · `coherencia_interna` — what the document owes itself: a `SubCtaDe` that
//     points to a `NumCta` that is not there, a duplicated number, a level that
//     does not fit the parent's. No XSD says so, and it is what the authority
//     reviews underneath. Blocks.
//   · `official_xsd` — a facet CatalogoCuentas_1_3.xsd or
//     CatalogosParaEsqContE.xsd pins. Blocks, and the message cites the file.
//
// WHAT #404 SETTLED. Until the XSDs were vendored, four rules were
// `faceta_no_verificada` warnings, guesses that never blocked. Against the
// schema:
//   · CAT-LONGITUD: `NumCta` has maxLength 100, `Desc` 400. The guess was 100
//     for both, so a valid `Desc` of 101-400 characters got a warning. Now it
//     blocks at the schema's limits. `SubCtaDe` (maxLength 100 too) is not
//     measured: one over 100 cannot name a `NumCta` that fits, so
//     CAT-PADRE-AUSENTE or the parent's own CAT-LONGITUD already blocks it.
//   · CAT-RFC: the date digits now follow the schema's pattern (month digit
//     0-1, day digit 0-3). The homoclave stays stricter than the XSD.
//   · CAT-ANIO-RANGO: `Anio` is an xs:int from 2015 to 2099. Now it blocks.
//   · CAT-CODAGRUP-ENUM (was CAT-CODAGRUP-FORMA): `CodAgrup` is `c_CodAgrup`,
//     a closed enumeration, not a pattern. `100.99` has the right shape and is
//     not on the list. Now it blocks on membership in the list the XSD itself
//     declares.
//   · CAT-ESPACIOS: removed. `NumCta` and `Desc` are xs:string restrictions
//     with no pattern and no whiteSpace facet, so the schema admits leading
//     and trailing spaces. Warning about them cited a rule the SAT does not
//     have.
// Nothing is left that the XSD does not pin, so `faceta_no_verificada` is gone.
// ============================================================

export type Severidad = 'bloquea' | 'aviso';

export type ProcedenciaDeRegla =
  | 'estructura_publicada'
  | 'xml_1_0'
  | 'coherencia_interna'
  | 'official_xsd';

export interface Hallazgo {
  /** Identificador estable de la regla, para poder filtrar y silenciar. */
  regla: string;
  severidad: Severidad;
  procedencia: ProcedenciaDeRegla;
  mensaje: string;
  /** La cuenta a la que apunta, cuando el hallazgo es de una fila. */
  numCta?: string;
}

/** El espacio de nombres del catálogo de cuentas 1.3 y su prefijo habitual. */
export const NS_CATALOGO = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas';
export const PREFIJO_CATALOGO = 'catalogocuentas';
export const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';
export const UBICACION_XSD_CATALOGO =
  `${NS_CATALOGO} ${NS_CATALOGO}/CatalogoCuentas_1_3.xsd`;
export const VERSION_CATALOGO = '1.3';

/** Una fila `Ctas` ya resuelta, tal como va a viajar al XML. */
export interface FilaCtas {
  NumCta: string;
  Desc: string;
  SubCtaDe?: string;
  CodAgrup: string;
  Nivel: number;
  Natur: 'D' | 'A';
}

export interface CabeceraCatalogo {
  RFC: string;
  Mes: string;
  Anio: string;
}

/**
 * The RFC of a legal entity (12) or an individual (13). The date digits follow
 * CatalogoCuentas_1_3.xsd, `[0-9]{2}[0-1][0-9][0-3][0-9]`: a month digit above
 * 1 or a day digit above 3 is refused by the schema, so it blocks here too.
 * The homoclave is STRICTER than the XSD's three optional characters: it
 * requires all three, the last a digit or `A`, which is the RFC's own check
 * digit. So an RFC can block here and pass the XSD, never the other way round.
 */
const PATRON_RFC = /^[A-ZÑ&]{3,4}[0-9]{2}[0-1][0-9][0-3][0-9][A-Z0-9]{2}[0-9A]$/;

/** The schema that pins the attributes of `Ctas` and the header, relative to `xsd/`. */
export const CHART_XSD = 'ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd';

/**
 * maxLength of each free-text attribute of `Ctas`, as CatalogoCuentas_1_3.xsd
 * declares it. minLength 1 is CAT-OBLIGATORIO's job. `SubCtaDe` is left out
 * on purpose: see CAT-LONGITUD in the header.
 */
const CTAS_MAX_LENGTH = { NumCta: 100, Desc: 400 } as const;

/** `Anio` is an xs:int with these inclusive bounds in CatalogoCuentas_1_3.xsd. */
const YEAR_MIN = 2015;
const YEAR_MAX = 2099;

function hallazgo(
  regla: string,
  severidad: Severidad,
  procedencia: ProcedenciaDeRegla,
  mensaje: string,
  numCta?: string
): Hallazgo {
  return numCta === undefined
    ? { regla, severidad, procedencia, mensaje }
    : { regla, severidad, procedencia, mensaje, numCta };
}

/** ¿Hay algo que impida entregar? */
export function bloquean(hallazgos: readonly Hallazgo[]): Hallazgo[] {
  return hallazgos.filter((h) => h.severidad === 'bloquea');
}

/**
 * Valida la cabecera y las filas del CtaCatalogo 1.3 ANTES de serializarlas.
 *
 * Se valida el modelo y no el texto del XML a propósito: sobre el texto habría
 * que volver a analizarlo para decir «la cuenta 105-01 tiene el nivel mal», y
 * el mensaje que sirve al contador es el que nombra la cuenta.
 */
export function validarCatalogo(
  cabecera: CabeceraCatalogo,
  filas: readonly FilaCtas[]
): Hallazgo[] {
  const hs: Hallazgo[] = [];

  // ── CABECERA ──────────────────────────────────────────────────────────
  if (!PATRON_RFC.test(cabecera.RFC)) {
    hs.push(
      hallazgo(
        'CAT-RFC',
        'bloquea',
        'estructura_publicada',
        `RFC "${cabecera.RFC}" no tiene la forma de un RFC mexicano. El atributo RFC del ` +
          `CtaCatalogo identifica al contribuyente que presenta: si está mal, el archivo se rechaza entero.`
      )
    );
  }

  if (!/^(0[1-9]|1[0-2])$/.test(cabecera.Mes)) {
    hs.push(
      hallazgo(
        'CAT-MES',
        'bloquea',
        'estructura_publicada',
        `Mes "${cabecera.Mes}" no es un mes de dos dígitos entre 01 y 12. ` +
          `El 13 de la balanza de cierre NO existe en el catálogo de cuentas.`
      )
    );
  }

  if (!/^[0-9]{4}$/.test(cabecera.Anio)) {
    hs.push(
      hallazgo('CAT-ANIO', 'bloquea', 'estructura_publicada', `Anio "${cabecera.Anio}" no son cuatro dígitos.`)
    );
  } else {
    const anio = Number(cabecera.Anio);
    if (anio < YEAR_MIN || anio > YEAR_MAX) {
      hs.push(
        hallazgo(
          'CAT-ANIO-RANGO',
          'bloquea',
          'official_xsd',
          `Anio ${cabecera.Anio} cae fuera de ${YEAR_MIN}–${YEAR_MAX}, el rango que ${CHART_XSD} ` +
            `admite: el SAT rechaza el archivo entero.`
        )
      );
    }
  }

  // ── AL MENOS UNA CUENTA ───────────────────────────────────────────────
  if (filas.length === 0) {
    hs.push(
      hallazgo(
        'CAT-VACIO',
        'bloquea',
        'coherencia_interna',
        `El catálogo no declara ni una cuenta. La balanza que se presente después referenciará ` +
          `cuentas que este archivo no declara, que es el rechazo más común del Anexo 24.`
      )
    );
    return hs;
  }

  // ── FILAS ─────────────────────────────────────────────────────────────
  const numeros = new Set<string>();
  const duplicados = new Set<string>();
  const nivelPorNumero = new Map<string, number>();

  for (const f of filas) {
    if (numeros.has(f.NumCta)) duplicados.add(f.NumCta);
    numeros.add(f.NumCta);
    nivelPorNumero.set(f.NumCta, f.Nivel);
  }

  for (const numCta of duplicados) {
    hs.push(
      hallazgo(
        'CAT-NUMCTA-DUPLICADO',
        'bloquea',
        'coherencia_interna',
        `NumCta "${numCta}" aparece más de una vez. El número de cuenta es la llave con la que la ` +
          `balanza y las pólizas apuntan aquí: duplicarlo hace ambigua toda referencia posterior.`,
        numCta
      )
    );
  }

  for (const f of filas) {
    const obligatorios: Array<[string, string]> = [
      ['NumCta', f.NumCta],
      ['Desc', f.Desc],
      ['CodAgrup', f.CodAgrup],
    ];
    for (const [nombre, valor] of obligatorios) {
      if (valor.length === 0) {
        hs.push(
          hallazgo(
            'CAT-OBLIGATORIO',
            'bloquea',
            'estructura_publicada',
            `${nombre} vacío en la cuenta "${f.NumCta || '(sin número)'}": es obligatorio en el nodo Ctas.`,
            f.NumCta
          )
        );
      }
    }

    if (f.Natur !== 'D' && f.Natur !== 'A') {
      hs.push(
        hallazgo(
          'CAT-NATUR',
          'bloquea',
          'estructura_publicada',
          `Natur "${String(f.Natur)}" en "${f.NumCta}": sólo admite D (deudora) o A (acreedora).`,
          f.NumCta
        )
      );
    }

    if (!Number.isInteger(f.Nivel) || f.Nivel < 1) {
      hs.push(
        hallazgo(
          'CAT-NIVEL',
          'bloquea',
          'estructura_publicada',
          `Nivel ${String(f.Nivel)} en "${f.NumCta}": ha de ser un entero mayor o igual que 1.`,
          f.NumCta
        )
      );
    }

    // SubCtaDe y Nivel se contradicen entre sí más a menudo de lo que parece:
    // el catálogo de una entidad crece por copiar filas, y la copia arrastra
    // el padre de la fila de origen.
    if (f.Nivel === 1 && f.SubCtaDe !== undefined) {
      hs.push(
        hallazgo(
          'CAT-RAIZ-CON-PADRE',
          'bloquea',
          'coherencia_interna',
          `"${f.NumCta}" es de nivel 1 y declara SubCtaDe="${f.SubCtaDe}". Una cuenta de primer nivel no cuelga de nada.`,
          f.NumCta
        )
      );
    }
    if (f.Nivel > 1 && f.SubCtaDe === undefined) {
      hs.push(
        hallazgo(
          'CAT-HUERFANA',
          'bloquea',
          'coherencia_interna',
          `"${f.NumCta}" es de nivel ${f.Nivel} y no declara SubCtaDe. El nivel dice que cuelga de ` +
            `alguien y el archivo no dice de quién: la jerarquía que el SAT lee es justo ésa.`,
          f.NumCta
        )
      );
    }

    if (f.SubCtaDe !== undefined) {
      if (!numeros.has(f.SubCtaDe)) {
        hs.push(
          hallazgo(
            'CAT-PADRE-AUSENTE',
            'bloquea',
            'coherencia_interna',
            `"${f.NumCta}" cuelga de SubCtaDe="${f.SubCtaDe}", que NO está declarada en este catálogo. ` +
              `La referencia no resuelve dentro del propio archivo.`,
            f.NumCta
          )
        );
      } else {
        const nivelPadre = nivelPorNumero.get(f.SubCtaDe);
        if (nivelPadre !== undefined && f.Nivel !== nivelPadre + 1) {
          hs.push(
            hallazgo(
              'CAT-NIVEL-DEL-PADRE',
              'bloquea',
              'coherencia_interna',
              `"${f.NumCta}" declara Nivel ${f.Nivel} y su padre "${f.SubCtaDe}" declara ${nivelPadre}: ` +
                `el nivel de una subcuenta es el del padre más uno.`,
              f.NumCta
            )
          );
        }
      }
      if (f.SubCtaDe === f.NumCta) {
        hs.push(
          hallazgo(
            'CAT-PADRE-DE-SI-MISMA',
            'bloquea',
            'coherencia_interna',
            `"${f.NumCta}" se declara padre de sí misma.`,
            f.NumCta
          )
        );
      }
    }

    if (f.CodAgrup.length > 0 && !officialEnumeration('c_CodAgrup').has(f.CodAgrup)) {
      hs.push(
        hallazgo(
          'CAT-CODAGRUP-ENUM',
          'bloquea',
          'official_xsd',
          `CodAgrup "${f.CodAgrup}" en "${f.NumCta}" no está en la enumeración c_CodAgrup de ` +
            `${OFFICIAL_ENUMERATIONS_XSD}: el SAT rechaza el archivo entero.`,
          f.NumCta
        )
      );
    }

    // Lengths are counted in characters, as XML Schema counts them, not in
    // UTF-16 code units: an emoji is one character to the SAT and two to
    // `String.length`.
    for (const [nombre, valor] of [
      ['NumCta', f.NumCta],
      ['Desc', f.Desc],
    ] as const) {
      const length = [...valor].length;
      if (length > CTAS_MAX_LENGTH[nombre]) {
        hs.push(
          hallazgo(
            'CAT-LONGITUD',
            'bloquea',
            'official_xsd',
            `${nombre} de "${f.NumCta}" mide ${length} caracteres y ${CHART_XSD} admite ` +
              `${CTAS_MAX_LENGTH[nombre]} como máximo: el SAT rechaza el archivo entero.`,
            f.NumCta
          )
        );
      }
    }
  }

  return hs;
}
