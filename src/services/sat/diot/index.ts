// ============================================================
// F07c · LA DIOT — LA PUERTA DEL MÓDULO
//
// Lo que sale por aquí es lo que consumirán el CLI y las superficies. Dos
// cosas NO se exportan a propósito:
//
//   · Ningún constructor de archivo que no sea un `SerializadorDiot`. La
//     interfaz es la que obliga a declarar `esArchivoDeclarable`, y ése es el
//     campo que impide que un papel de trabajo se suba al portal.
//   · Las consultas de `hechos.ts`. El hecho que la DIOT declara son los dos
//     sucesos del mayor, y una tercera consulta «parecida» escrita en otro
//     frente sería la cuarta definición de «IVA pagado» en este proyecto.
// ============================================================

export { construirDiot, esEntregable, type OpcionesDiot } from './diot-service.js';

export {
  bloquean,
  contarHallazgos,
  type Hallazgo,
  type Severidad,
} from './hallazgos.js';

export {
  clasificarRfc,
  normalizarRfc,
  rfcIdentificaAlTercero,
  RFC_GENERICO_NACIONAL,
  RFC_GENERICO_EXTRANJERO,
  type DiagnosticoRfc,
  type EstadoRfc,
} from './rfc.js';

export {
  resolverTercero,
  type PoliticasDelTercero,
  type TerceroCrudo,
  type TerceroDiot,
  type TipoOperacion,
  type TipoTercero,
} from './tercero.js';

export {
  acumuladoDelDocumento,
  baseDelDesglose,
  clasificarRenglon,
  desglosarDocumento,
  desgloseCero,
  ivaDelDesglose,
  porcionDelDocumento,
  repartirProporcional,
  sumarDesgloses,
  DECIMALES_DIOT,
  type Casilla,
  type ClaveTasa,
  type Desglose,
  type OtraTasa,
  type PoliticaBaseExenta,
  type PorcionPagada,
  type RenglonDeGasto,
  type TipoFactor,
} from './desglose.js';

export { hechosDelMes, rangoDelMes, type HechoPagado, type RangoDelMes } from './hechos.js';

export {
  exigirEntregable,
  DiotFormatoNoFundamentado,
  DiotNoEntregable,
  LO_QUE_FALTA_CONFIRMAR,
  PAPEL_DE_TRABAJO,
  SERIALIZADOR_SAT,
  type SerializadorDiot,
} from './serializador.js';

export type {
  DiotConstruida,
  DocumentoDelRenglon,
  PeriodoDiot,
  PoliticaAplicada,
  RenglonDiot,
  TotalesDiot,
} from './modelo.js';
