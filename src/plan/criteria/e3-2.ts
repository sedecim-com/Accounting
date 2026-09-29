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

  // ---- MNE-001-076 (#313) · the e.firma consent and the SAT cancellation ----
  {
    paquete: 'E3.2',
    id: 'efirma-consent-states-actual-uses',
    enunciado: 'El consentimiento de la e.firma dice lo que el sistema hace con ella, sube de versión y no reescribe los anteriores',
    mutantes: [
      {
        archivo: 'src/services/fiscal-credentials/service.ts',
        de: "export const CONSENT_VERSION = '2026-09-1';",
        a: "export const CONSENT_VERSION = '2026-08-1';",
        porque: 'the text changes and the version does not: a consent recorded as 2026-08-1 could mean either text',
      },
      {
        archivo: 'src/services/fiscal-credentials/service.ts',
        de: 'efirma_sellado_contabilidad_electronica = sellar_con_custodia',
        a: 'efirma_sellado_contabilidad_electronica = anything',
        porque: 'the text stops tying the sealing to sellar_con_custodia: the taxpayer is told the system seals whatever the firm declared',
      },
      {
        archivo: 'src/services/fiscal-credentials/service.ts',
        de: 'vault_version = EXCLUDED.vault_version,',
        a: 'vault_version = EXCLUDED.vault_version, consent_version = EXCLUDED.consent_version,',
        porque: 'storing again rewrites the version an earlier consent was given under',
      },
    ],
    evaluar: () => {
      // The owner's scope decision MNE-001-140 (#312): the e.firma downloads
      // CFDI and metadata from the SAT and seals the Anexo 24 files only under
      // sellar_con_custodia; filing stays manual. Version 2026-08-1 promised
      // «nothing else, we will not sign», which stopped being true.
      const s = codigoDe('src/services/fiscal-credentials/service.ts');
      const version = /export const CONSENT_VERSION = '([^']+)'/.exec(s)?.[1];
      if (!version || version <= '2026-08-1') {
        return falla(`CONSENT_VERSION es ${version ?? 'inexistente'}: el texto cambió y la versión no, así que un consentimiento guardado no dice qué texto se aceptó`);
      }
      const i = s.indexOf('export const CONSENT_TEXT');
      const text = i >= 0 ? s.slice(i, s.indexOf('`.trim()', i)) : '';
      if (!/metadata/.test(text) || !/download/.test(text)) {
        return falla('el consentimiento no nombra la descarga de CFDI y metadatos, que es el uso para el que se entrega la e.firma');
      }
      if (!/Anexo 24/.test(text) || !/efirma_sellado_contabilidad_electronica = sellar_con_custodia/.test(text)) {
        return falla('el consentimiento no ata el sellado del Anexo 24 a sellar_con_custodia: el contribuyente no sabe cuándo se firma con su e.firma');
      }
      if (!/SAT portal/.test(text) || /We will not sign/i.test(text)) {
        return falla('el consentimiento no dice que la presentación queda manual en el portal del SAT, o sigue prometiendo que nunca se firma');
      }
      return /consent_version\s*=/.test(s)
        ? falla('el servicio reescribe consent_version: un consentimiento anterior perdería la versión con la que se dio')
        : ok(`consentimiento ${version}: descarga, sellado sólo con sellar_con_custodia y presentación manual; los anteriores conservan su versión`);
    },
  },
  {
    paquete: 'E3.2',
    id: 'sat-cancellation-reaches-invoice',
    enunciado: 'Un CFDI que el SAT reporta cancelado marca la factura como cancelada, con UPDATE guardado, y enciende el control de CxC',
    mutantes: [
      {
        archivo: 'src/services/sat/cfdi-status.ts',
        de: 'resumen.invoices_cancelled += await markInvoiceCfdiCancelled(ctx.entityId, fila.cfdi_uuid);',
        a: 'resumen.invoices_cancelled += 0;',
        porque: 'the sweep writes sat_estado and never tells the invoice: the control stays quiet over a cancelled CFDI',
      },
      {
        archivo: 'src/services/xml-ingestion/sat-validation.ts',
        de: 'await markInvoiceCfdiCancelled(d.entity_id, d.cfdi_uuid);',
        a: 'void d;',
        porque: 'the single-document path writes sat_estado and forgets the invoice',
      },
      {
        archivo: 'src/services/sat/cfdi-status.ts',
        de: 'WHERE entity_id = $1',
        a: 'WHERE $1::uuid IS NOT NULL',
        porque: 'the bridge loses its entity scope: another entity carrying the same UUID is marked cancelled',
      },
      {
        archivo: 'src/services/sat/cfdi-status.ts',
        de: "AND cfdi_status = 'stamped'",
        a: '',
        porque: 'the bridge loses its state predicate: a draft or failed CFDI could be marked cancelled',
      },
      {
        archivo: 'src/services/ar/ar-controls.ts',
        de: "cfdi_status = 'cancelled' AND amount_due > 0",
        a: "cfdi_status = 'voided' AND amount_due > 0",
        porque: 'the control reads a value the bridge never writes: it never fires',
      },
    ],
    evaluar: () => {
      // Before MNE-001-076 only xml_documents.sat_estado learned the SAT's
      // «Cancelado»; ar-controls reads invoices.cfdi_status and never fired.
      // EFIRMA-3 (#441) reuses this bridge instead of writing a second one.
      const status = codigoDe('src/services/sat/cfdi-status.ts');
      const i = status.indexOf('export async function markInvoiceCfdiCancelled');
      const bridge = i >= 0 ? status.slice(i, status.indexOf('\n}', i)) : '';
      if (!bridge) return falla('no existe markInvoiceCfdiCancelled: el estado del SAT no llega a la factura');
      if (!/SET cfdi_status = 'cancelled'/.test(bridge) ||
          !/WHERE entity_id = \$1\s+AND UPPER\(cfdi_uuid\) = UPPER\(\$2\)\s+AND cfdi_status = 'stamped'/.test(bridge) ||
          !/rowCount/.test(bridge)) {
        return falla('el puente perdió su guarda (estado stamped, alcance de entidad o rowCount): invariante 3');
      }
      const j = status.indexOf('export async function revalidateEntityCfdis');
      const sweep = j >= 0 ? status.slice(j) : '';
      if (!/if \(vs === 'cancelled'\) \{\s+resumen\.invoices_cancelled \+= await markInvoiceCfdiCancelled\(ctx\.entityId, fila\.cfdi_uuid\)/.test(sweep)) {
        return falla('el barrido escribe sat_estado y no llama al puente: el control nunca se enciende');
      }
      const single = codigoDe('src/services/xml-ingestion/sat-validation.ts');
      if (!/if \(result\.status === 'cancelled'\) \{\s+await markInvoiceCfdiCancelled\(d\.entity_id, d\.cfdi_uuid\)/.test(single)) {
        return falla('la consulta de un solo CFDI escribe sat_estado y no llama al puente');
      }
      return /cfdi_status = 'cancelled' AND amount_due > 0/.test(codigoDe('src/services/ar/ar-controls.ts'))
        ? ok('el SAT cancelado llega a invoices.cfdi_status por un UPDATE guardado desde los dos escritores, y el control de CxC lo lee')
        : falla('el control de CxC dejó de leer cfdi_status = cancelled: el puente escribe algo que nadie mira');
    },
  },
];
