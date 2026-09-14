// ============================================================
// EL CONTRATO DE UN CARRIL (I2 · issue #144)
//
// El metro publica CARRILES: cada uno es un número que hoy vale algo y tiene
// que llegar a cero. Un carril no es una estadística — es una deuda con
// nombre, y por eso lleva tres cosas que una estadística no lleva:
//
//   · `comando`, el que reproduce la cifra fuera del metro. Sin él, un número
//     que a alguien le parece raro no se puede discutir: se cree o no se cree.
//   · `ejemplos`, los primeros de la lista. Un carril que dice «8 343» y no
//     dice cuáles manda a buscarlos a mano, y entonces nadie lo usa.
//   · `informativo`, para lo que se mide y todavía NO se exige. Mezclar lo que
//     se exige con lo que se observa es como se llega a un trinquete que nadie
//     puede poner en verde y que por eso se desactiva entero.
// ============================================================

export interface Lane {
  /** Clave estable en la línea base. Inglés, kebab-case: es identidad. */
  id: string;
  /** Lo que se publica en el bloque, en inglés (fuente). */
  title: string;
  /** El número de hoy. */
  value: number;
  /** A dónde tiene que llegar. Casi siempre 0. */
  target: number;
  /** El comando que reproduce la cifra sin pasar por el metro. */
  command: string;
  /** Los primeros de la lista, para que el número sea accionable. */
  examples?: string[];
  /**
   * Se mide y no se exige todavía. No entra al trinquete y se publica aparte:
   * un carril que nadie puede bajar hoy, mezclado con los que sí, acaba
   * apagando el trinquete entero.
   */
  informational?: boolean;
  /**
   * Cuenta POR ARCHIVO además de en total. Es lo que hace que la deuda se
   * pueda pagar por tramos: sin el desglose, bajar el total exige tocarlo
   * todo a la vez, y con él cada PR cierra los archivos que toca.
   */
  perFile?: Record<string, number>;
}

/** Lo que devuelve un módulo de carriles. */
export type LaneMeter = () => Lane[];
