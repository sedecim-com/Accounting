// ============================================================
// LO QUE UN EXTRACTO ES, ANTES DE QUE TOQUE LA BASE (F05a)
//
// Estos lectores son FUNCIONES PURAS: entra texto o bytes, sale una
// estructura. No abren conexión, no consultan `bank_accounts`, no saben qué
// entidad está mirando. La razón no es purismo: es que el mismo archivo tiene
// que poder leerse dos veces —una en `--dry-run` y otra al importar— y dar
// exactamente lo mismo, y tiene que poder releerse meses después desde los
// bytes archivados cuando `bank statement apply` reaplique otra versión del
// perfil. Un lector que consulta la base no cumple ninguna de las dos.
//
// LA FORMA ES ÚNICA A PROPÓSITO. Nueve formatos prometidos en el catálogo, un
// solo `ExtractoLeido`: el importador no puede tener nueve caminos porque
// entonces las siete pruebas de integridad tendrían nueve implementaciones y
// ocho de ellas estarían sin probar.
//
// LOS DOS SALDOS son el campo que justifica todo el tramo. `bank_statements`
// los declara NOT NULL porque sin ellos `reconciliation_sessions` se queda con
// su `beginning_balance` en cero, y la aritmética de dos lados compara contra
// un número que significa «nadie restó nada». Por eso camt.053 y MT940 los
// traen de verdad (OPBD/CLBD y :60F:/:62F:) y por eso el CSV, que casi nunca
// los publica, los DERIVA del saldo corrido y lo dice en `avisos` en lugar de
// devolver un cero silencioso.
// ============================================================

/** Los tres formatos que este módulo sabe leer hoy. Ver FORMATOS en index.ts. */
export type FormatoLeible = 'csv' | 'camt053' | 'mt940';

/**
 * Una línea del extracto, ya normalizada.
 *
 * `importe` es un STRING DECIMAL CON SIGNO, y el signo tiene una sola lectura
 * en todo el módulo: NEGATIVO = SALE DINERO DE LA CUENTA. Un CSV con columnas
 * cargo/abono, un `CdtDbtInd=DBIT` de camt y una marca `D` de MT940 son el
 * mismo hecho escrito de tres maneras, y aquí los tres llegan como negativo.
 *
 * La convención se fija en el lector y no en el importador porque es donde
 * está la información: sólo aquí se sabe si la columna se llamaba CARGO o
 * RETIRO, y esa palabra es la única evidencia del signo.
 */
export interface LineaLeida {
  /** Fecha de OPERACIÓN (booking), YYYY-MM-DD. Es la que concilia. */
  fecha: string;
  /** Fecha valor, si el formato la distingue de la de operación. */
  fechaValor?: string;
  /** String decimal con signo. Negativo = sale dinero. Nunca un `number`. */
  importe: string;
  descripcion: string;
  /** Id nativo del banco, si lo publica. Es lo que permite deduplicar sin hash. */
  referencia?: string;
  /** Código de tipo de movimiento tal como lo nombra el banco. */
  tipo?: string;
  /** La línea original, para `bank_transactions.raw_data`. */
  crudo: Record<string, unknown>;
}

/**
 * Un estado de cuenta leído, con lo que el archivo trae y nada más.
 *
 * Todo lo opcional es opcional PORQUE HAY FORMATOS QUE NO LO TRAEN, no porque
 * el lector se rinda: un CSV rara vez publica la cuenta y casi nunca la
 * moneda. Devolver `undefined` obliga al importador a decidir qué hacer —
 * pedirlo por bandera, tomarlo del maestro, o negarse—; devolver un valor
 * inventado le quitaría esa decisión sin avisarle.
 */
export interface ExtractoLeido {
  formato: FormatoLeible;
  /** Nombre del perfil aplicado (sólo CSV). La versión vive en PERFILES_CSV. */
  perfil?: string;
  /** CLABE, IBAN o número que declara el propio archivo, para la prueba de identidad. */
  cuentaDeclarada?: string;
  moneda?: string;
  /** Secuencia electrónica del banco. Detecta el estado FALTANTE entre el 7 y el 9. */
  numeroDeEstado?: string;
  periodoInicio?: string;
  periodoFin?: string;
  saldoInicial?: string;
  saldoFinal?: string;
  lineas: LineaLeida[];
  /**
   * TODO lo que se ignoró, se adivinó o se derivó, con número de línea cuando
   * lo tiene. Es la superficie que impide que un lector mienta por omisión: una
   * fila corrupta NO se salta en silencio, aparece aquí y el llamador decide si
   * aborta o importa el resto.
   */
  avisos: string[];
}

// ============================================================
// EL PERFIL DE CSV
//
// «CSV» no es un formato, es la ausencia de uno. Dos bancos mexicanos exportan
// «CSV» y no coinciden en el orden de las columnas, ni en el formato de la
// fecha, ni en si el importe va firmado en una columna o repartido en dos, ni
// en el separador de miles, ni en la codificación. El perfil es la
// DECLARACIÓN de esas diferencias, no un `if` por banco: por eso puede
// versionarse, imprimirse (`bank format show`) y corregirse sin tocar código.
// ============================================================

/**
 * Cómo se nombra una columna: por índice 0-based, por encabezado, o por una
 * lista de encabezados alternativos (el primero que aparezca gana).
 *
 * Las alternativas existen porque un mismo banco cambia el encabezado entre
 * versiones del exportador —«DESCRIPCIÓN» y «CONCEPTO» son la misma columna—,
 * y porque obligar a un perfil nuevo por cada sinónimo multiplicaría perfiles
 * que sólo difieren en una palabra.
 */
export type SelectorColumna = number | string | string[];

export interface MapaColumnas {
  fecha: SelectorColumna;
  fechaValor?: SelectorColumna;
  descripcion: SelectorColumna;
  referencia?: SelectorColumna;
  tipo?: SelectorColumna;
  /** Columna única con el importe ya firmado (modo `firmado`). */
  importe?: SelectorColumna;
  /** Columnas separadas (modo `cargo-abono`). Cargo SIEMPRE sale como negativo. */
  cargo?: SelectorColumna;
  abono?: SelectorColumna;
  /**
   * Saldo corrido. No es un campo de la línea: es lo único que permite DERIVAR
   * los dos saldos del estado en un formato que no los publica.
   */
  saldo?: SelectorColumna;
}

export type SeparadorDecimal = '.' | ',' | 'auto';

export interface LecturaImporte {
  /**
   * `firmado`: una columna que ya trae el signo.
   * `cargo-abono`: dos columnas; se combinan en un solo importe firmado.
   * `firmado-por-tipo`: una columna de importe sin signo y otra que dice si
   *   fue cargo o abono (la exportación que reparte el signo en dos celdas).
   */
  modo: 'firmado' | 'cargo-abono' | 'firmado-por-tipo';
  /**
   * Fijarlo evita la única ambigüedad real del dinero en texto: «1.234» son
   * mil doscientos treinta y cuatro en México y uno con doscientos treinta y
   * cuatro milésimos en un exportador con locale inglés. Con `auto` el lector
   * adivina y lo confiesa en `avisos`; con el separador fijo no adivina.
   */
  separadorDecimal: SeparadorDecimal;
  /** `(1,234.56)` como negativo contable. */
  parentesisNegativo?: boolean;
  /** Para exportaciones que publican el extracto desde la óptica del banco. */
  invertirSigno?: boolean;
  /** Sólo en `firmado-por-tipo`. */
  columnaSigno?: SelectorColumna;
  /** Valores de esa columna que significan «sale dinero». Comparación normalizada. */
  valoresCargo?: string[];
  valoresAbono?: string[];
}

/**
 * Cuánto vale la palabra de este perfil.
 *
 * · `verificado` — se contrastó contra un archivo real del banco.
 * · `derivado`   — se construyó desde documentación publicada por el banco.
 * · `conjetura`  — se reconstruyó de la forma que suelen tener estas
 *                  exportaciones, SIN un archivo delante. Sirve de punto de
 *                  partida y hay que corregirlo con una muestra.
 *
 * El campo existe para que la diferencia sea visible en `bank format list` en
 * vez de vivir en la cabeza de quien escribió el perfil.
 */
export type ConfianzaPerfil = 'verificado' | 'derivado' | 'conjetura';

export interface PerfilCsv {
  /** Id estable. Es lo que se guarda en `bank_statements.profile`. */
  nombre: string;
  version: string;
  confianza: ConfianzaPerfil;
  banco?: string;
  pais?: string;
  /** Qué se sabe y qué no de este perfil. Se imprime junto al perfil. */
  notas?: string;

  delimitador: string;
  codificacion: 'utf8' | 'latin1' | 'auto';
  /** Fila 1-based donde se ESPERA el encabezado. */
  filaEncabezado: number;
  /**
   * Cuántas filas más abajo se sigue buscando el encabezado. Los exportadores
   * de banco anteponen filas de membrete cuyo número cambia entre versiones;
   * exigir una posición exacta rompe el perfil por una fila de más.
   */
  maxDesplazamientoEncabezado: number;
  columnas: MapaColumnas;
  formatoFecha: string;
  importe: LecturaImporte;
  /**
   * Moneda que se ASUME cuando el archivo no la trae. Siempre genera aviso:
   * asumir MXN en un extracto en dólares descuadra la conciliación entera.
   */
  monedaAsumida?: string;
  /** Qué sacar del membrete que va encima del encabezado. */
  preambulo?: {
    cuenta?: RegExp;
    moneda?: RegExp;
    numeroDeEstado?: RegExp;
  };
  /**
   * Sólo gana cuando NINGÚN otro perfil reconoce el archivo. Es la marca del
   * perfil genérico, que por definición casa con demasiadas cosas.
   */
  ultimoRecurso?: boolean;
}

// ============================================================
// RESULTADOS DE LOS NORMALIZADORES
//
// Ni `analizarImporte` ni `analizarFecha` lanzan: una celda ilegible es un
// hecho de UNA FILA, y el archivo entero sigue siendo importable sin ella. Lo
// que lanza es lo estructural —no hay encabezado, el XML no es un camt.053—,
// porque ahí no queda nada que importar.
// ============================================================

export type ResultadoValor =
  | { ok: true; valor: string; aviso?: string }
  | { ok: false; motivo: string };
