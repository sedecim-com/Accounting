import { codigoDe, type Criterio, existe, falla, ok } from './shared.js';

// ============================================================
// THE E3.2 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E3_2: Criterio[] = [

  // ---- E3.2 · Descarga del SAT ----
  {
    paquete: 'E3.2',
    id: 'sat-bulk-cfdi-download',
    enunciado: 'El despacho puede traer del SAT los CFDI que no le llegaron',
    evaluar: () => {
      // ROJO HONESTO (S1). La versión anterior de este criterio pasó VERDE
      // durante semanas porque su regex matcheaba dos cadenas de PROSA en una
      // pregunta de política (pending-catalog.ts: «direct SAT download …») —
      // la clase exacta de falso verde que AUD-6 purgó, cometida por el
      // propio instrumento. La descarga masiva NO existe: ni cliente SOAP
      // (SolicitaDescarga/VerificaSolicitud), ni lector de paquetes ZIP, ni
      // comando `sat download`, ni la reversa de facturas contabilizadas
      // cuyo CFDI el emisor canceló. Son ~11 tareas de motor (plan de
      // cierre E3.2), no «cargar una credencial».
      //
      // Verde exige el SERVICIO con transporte: un módulo bajo
      // src/services/sat-download/ que el camino de políticas no pueda
      // imitar con una cadena.
      if (!existe('src/services/sat-download')) {
        return falla(
          'la descarga masiva del SAT no existe (ni SOAP, ni ZIP, ni comando): el despacho no ' +
            'puede afirmar completitud, que es lo que vende. El criterio anterior pasaba por dos ' +
            'cadenas de prosa en pending-catalog.ts — este rojo es la corrección'
        );
      }
      if (!existe('src/services/sat-download/descarga-masiva.ts')) {
        return falla('src/services/sat-download existe pero sin descarga-masiva.ts (el motor)');
      }
      const motor = codigoDe('src/services/sat-download/descarga-masiva.ts');
      return /SolicitaDescarga/i.test(motor) && /Verifica/i.test(motor)
        ? ok('el motor de descarga masiva existe con su transporte')
        : falla('src/services/sat-download existe pero sin el ciclo solicitar/verificar/descargar');
    },
  },
];
