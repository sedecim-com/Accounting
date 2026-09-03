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

export {
  archivarArtefacto,
  ultimoArtefacto,
  xmlArchivado,
  hashDelXml,
  type TipoArtefacto,
  type ArtefactoArchivado,
  type DatosArtefacto,
} from './artefactos.js';
