// ============================================================
// F07b · ANEXO 24 — LA PUERTA DEL MÓDULO
//
// Lo que sale por aquí es lo que los demás frentes de F07b consumen: el CLI
// que registra `catalog generate`, y el generador de la balanza, que comparte
// el constructor, el formateador de importes y el archivo de artefactos.
//
// NO se exporta XMLBuilder ni ninguna forma de construir un nodo saltándose
// `exigirValorDeAtributo`. Esa puerta es única a propósito: es la que impide
// que un salto de línea o un carácter de control llegue al archivo que se
// firma. Ver la cabecera de xml.ts, que trae la evidencia medida.
// ============================================================

export {
  serializar,
  exigirValorDeAtributo,
  importeAnexo24,
  bytesDe,
  DECIMALES_IMPORTE_ANEXO24,
  type NodoXml,
  type Atributo,
  type ImporteAnexo24,
} from './xml.js';

export {
  validarCatalogo,
  bloquean,
  NS_CATALOGO,
  NS_XSI,
  PREFIJO_CATALOGO,
  UBICACION_XSD_CATALOGO,
  VERSION_CATALOGO,
  type Hallazgo,
  type Severidad,
  type ProcedenciaDeRegla,
  type FilaCtas,
  type CabeceraCatalogo,
} from './validador.js';

export {
  construirCatalogoCuentas,
  generarCatalogoCuentas,
  estadoDelAgrupador,
  finDeMes,
  type CuentaParaCatalogo,
  type EntradaCatalogo,
  type CatalogoConstruido,
  type ResultadoGeneracionCatalogo,
  type OpcionesGenerarCatalogo,
  type PoliticasDelCatalogo,
  type EstadoAgrupador,
} from './catalogo-cuentas.js';

// O1 · el lector, que es el espejo de `catalogo-cuentas.ts`. Sale por aquí
// porque la puerta de entrada del onboarding —`sat-chart-import.ts`— lo
// consume desde `services/accounting`, y porque leer el propio archivo que
// este módulo escribe es la comprobación que cualquiera va a querer hacer.
export {
  readCtaCatalogo,
  normalizarAtributo,
  type CatalogFileRead,
  type CatalogFileRow,
  type CatalogFileHeader,
  type CatalogReadFinding,
  type ReadSeverity,
} from './catalog-reader.js';

// O1 · capa 2 · el lector de la BalanzaComprobacion, espejo de `balanza-xml.ts`.
// Sale por aquí porque la carga de la apertura vive en `services/accounting` y
// porque releer con él la balanza que este módulo GENERA es exactamente cómo
// se comprueba, al peso, que la migración quedó bien.
export {
  readBalanzaComprobacion,
  cuadraEnAlgunaNaturaleza,
  type BalanceFileRead,
  type BalanceFileRow,
  type BalanceFileHeader,
  type BalanceReadFinding,
} from './balance-reader.js';

export {
  archivarArtefacto,
  ultimoArtefacto,
  xmlArchivado,
  hashDelXml,
  type TipoArtefacto,
  type ArtefactoArchivado,
  type DatosArtefacto,
} from './artefactos.js';
