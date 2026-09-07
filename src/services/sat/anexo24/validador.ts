// ============================================================
// F07b · EL VALIDADOR DE REGLAS DEL ANEXO 24
//
// ESTO NO ES UN XSD, Y EL NOMBRE DEL ARCHIVO NO DEBE DEJAR CREERLO.
//
// El encargo decía: o se traen los XSD oficiales, o se escribe un validador de
// reglas — y si no se puede fundamentar el XSD, NO SE INVENTA. No se puede
// fundamentar. En este repositorio no hay ni un `.xsd`, no hay ninguna
// librería capaz de validar contra esquema (se comprobó: nada de libxmljs,
// xmllint ni equivalente en node_modules), y el contenido exacto de
// `CatalogoCuentas_1_3.xsd` —sus `pattern`, sus `maxLength`, sus
// `minInclusive`— no se puede reconstruir de memoria con la certeza que exige
// firmar una declaración. Un XSD inventado valida contra las suposiciones de
// quien lo escribió y devuelve un «válido» que no vale nada: es peor que no
// validar, porque además tranquiliza.
//
// Lo que sí se puede hacer con honestidad es comprobar las reglas, y decir de
// CADA UNA de dónde sale. Por eso cada hallazgo lleva `procedencia`:
//
//   · `estructura_publicada` — nombres de nodo y de atributo, cuáles son
//     obligatorios, el espacio de nombres, `Version` fija en 1.3, `Natur` con
//     dos valores. Es la forma del documento tal como el Anexo 24 la publica y
//     tal como la implementa cualquier herramienta que hoy presente el archivo.
//     Bloquea.
//   · `xml_1_0` — la recomendación XML, no el SAT. Bloquea.
//   · `coherencia_interna` — lo que el documento se debe a sí mismo: un
//     `SubCtaDe` que apunta a un `NumCta` que no está, dos cuentas con el mismo
//     número, un nivel que no encaja con el del padre. No hace falta el XSD
//     para saberlo y es lo que la autoridad revisa en el fondo. Bloquea.
//   · `faceta_no_verificada` — longitudes máximas, patrones exactos, si un
//     importe admite negativo, el rango de `Anio`. Son las que SÓLO el XSD
//     real puede zanjar. Salen como AVISO, nunca bloquean, y dicen que son
//     conjeturas. Un aviso que resulte falso cuesta una lectura; un bloqueo
//     falso impide presentar.
//
// QUÉ HARÍA FALTA PARA TENER EL XSD DE VERDAD, en concreto:
//   1. Descargar el paquete de esquemas del portal del SAT
//      (`.../esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd`
//      y su hermano de BalanzaComprobacion), versionarlos en el repositorio
//      con su fecha y su suma de comprobación, igual que se hizo con el
//      c_CodAgrup en F07a — la procedencia se escribe junto al dato.
//   2. Añadir una dependencia que valide contra esquema. Ninguna de las que
//      hay hoy lo hace.
//   3. Convertir entonces cada regla `faceta_no_verificada` de este archivo en
//      lo que el XSD diga, y las que sobrevivan pasan a bloquear.
// Mientras tanto, este validador cubre lo comprobable y NO PRESUME de más.
// ============================================================

export type Severidad = 'bloquea' | 'aviso';

export type ProcedenciaDeRegla =
  | 'estructura_publicada'
  | 'xml_1_0'
  | 'coherencia_interna'
  | 'faceta_no_verificada';

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
 * El RFC de una persona moral (12) o física (13). Este patrón sí se puede
 * fundamentar: es el mismo que el SAT publica en todos sus esquemas y el que
 * ya vive en este repositorio para el NIF mexicano.
 */
const PATRON_RFC = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{2}[0-9A]$/;

/**
 * La forma del código agrupador: rubro (`100`) o subcuenta (`100.01`). NO sale
 * de un XSD: sale de la lista oficial que F07a sembró en este repositorio
 * (src/services/accounting/sat-agrupadores-catalogo.ts, 1060 códigos, todos de
 * una de las dos formas). Por eso es un aviso y no un bloqueo: la comprobación
 * FUERTE es la existencia en `sat_codigos_agrupadores`, y ésa la hace el
 * generador, que tiene base de datos. Esto es sólo la red de abajo.
 */
const FORMA_CODAGRUP = /^[0-9]{3}(\.[0-9]{2})?$/;

/**
 * Longitud máxima conjeturada para NumCta y Desc. NO verificada contra el XSD:
 * ver la cabecera. Sale como aviso.
 */
const LONGITUD_CONJETURADA = 100;

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
    // La contabilidad electrónica arranca en 2015. El límite superior es
    // conjetura: el XSD lo fija y no lo tenemos.
    if (anio < 2015 || anio > 2099) {
      hs.push(
        hallazgo(
          'CAT-ANIO-RANGO',
          'aviso',
          'faceta_no_verificada',
          `Anio ${cabecera.Anio} cae fuera de 2015–2099. La obligación de contabilidad electrónica ` +
            `empieza en 2015; el rango exacto que acepta el esquema no se ha podido verificar.`
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

    if (f.CodAgrup.length > 0 && !FORMA_CODAGRUP.test(f.CodAgrup)) {
      hs.push(
        hallazgo(
          'CAT-CODAGRUP-FORMA',
          'aviso',
          'faceta_no_verificada',
          `CodAgrup "${f.CodAgrup}" en "${f.NumCta}" no tiene la forma NNN ni NNN.NN, que es la de los ` +
            `1060 códigos del c_CodAgrup sembrado. El patrón exacto lo fija el XSD, que no tenemos.`,
          f.NumCta
        )
      );
    }

    for (const [nombre, valor] of [
      ['NumCta', f.NumCta],
      ['Desc', f.Desc],
    ] as const) {
      if (valor.length > LONGITUD_CONJETURADA) {
        hs.push(
          hallazgo(
            'CAT-LONGITUD',
            'aviso',
            'faceta_no_verificada',
            `${nombre} de "${f.NumCta}" mide ${valor.length} caracteres. Se conjetura un máximo de ` +
              `${LONGITUD_CONJETURADA}; el real lo fija el XSD, que no tenemos.`,
            f.NumCta
          )
        );
      }
      if (valor !== valor.trim()) {
        hs.push(
          hallazgo(
            'CAT-ESPACIOS',
            'aviso',
            'faceta_no_verificada',
            `${nombre} de "${f.NumCta}" empieza o acaba en espacio. La normalización de XML no lo ` +
              `quita, pero los tipos de cadena del SAT suelen prohibirlo; no se ha podido verificar.`,
            f.NumCta
          )
        );
      }
    }
  }

  return hs;
}
