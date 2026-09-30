import { codigoDe, type Criterio, existe, falla, ok } from './shared.js';

// ============================================================
// THE E3.2 CRITERIA
//
// Moved verbatim from `src/plan/criterios.ts` (#294), in the board's order.
// The index concatenates the packages back into `CRITERIOS`.
// ============================================================
export const E3_2: Criterio[] = [

  // ---- E3.2 · Descarga del SAT ----
  // sat-bulk-cfdi-download is a behaviour criterion now: it runs the engine
  // against a simulated SAT on an ephemeral database (src/plan/conducta.ts).

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

  // ---- EFIRMA-1 · MNE-001-141 (#439) · the SAT authentication signs through withCredential ----
  {
    paquete: 'E3.2',
    id: 'sat-auth-signs-through-withcredential',
    enunciado: 'La autenticación con el SAT firma con la e.firma sólo dentro de withCredential, con purpose sat_auth, y cada uso deja su fila en la bitácora',
    mutantes: [
      {
        archivo: 'src/services/sat-download/authentication.ts',
        de: "import { withCredential } from '../fiscal-credentials/service.js';",
        a: "import { withCredential } from '../fiscal-credentials/service.js';\nimport { getVault } from '../vault/index.js';",
        porque: 'the client reaches the vault itself: the key is decrypted outside withCredential, with no log row and no daily cap',
      },
      {
        archivo: 'src/services/sat-download/authentication.ts',
        de: 'await withCredential(',
        a: 'await signWithoutCredential(',
        porque: 'the signing runs through another path: the cap, the anomaly policy and the log are skipped',
      },
      {
        archivo: 'src/services/sat-download/authentication.ts',
        de: "purpose: 'sat_auth'",
        a: "purpose: 'healthcheck'",
        porque: 'the log row calls an authentication with the SAT a healthcheck: the use is not auditable as what it was',
      },
      {
        archivo: 'src/services/fiscal-credentials/service.ts',
        de: "await logAccess(row, opts, 'success');",
        a: 'void row;',
        porque: 'a successful use of the e.firma leaves no row in the log',
      },
      {
        archivo: 'src/services/fiscal-credentials/service.ts',
        de: "await logAccess(row, opts, 'error',",
        a: 'void (',
        porque: 'a refusal from the SAT leaves no error row in the log',
      },
    ],
    evaluar: () => {
      // The owner's decision MNE-001-140 (#312) makes this the first
      // production caller of the vault. The key may be decrypted only inside
      // withCredential, which is what logs, caps and applies
      // efirma_accion_anomalia before the network is touched.
      const file = 'src/services/sat-download/authentication.ts';
      if (!existe(file)) return falla('no existe el cliente de autenticación con el SAT');
      const auth = codigoDe(file);
      const signer = codigoDe('src/services/sat-download/ws-security.ts');
      const direct = /\b(getVault|deserializeMaterial|privateKeyToPem)\b|vault\/index/;
      if (direct.test(auth) || direct.test(signer)) {
        return falla('el cliente del SAT toca la bóveda o descifra por su cuenta: la llave sale sin bitácora ni tope diario');
      }
      const i = auth.indexOf('await withCredential(');
      if (i < 0 || auth.slice(0, i).includes('buildSignedAutentica(')) {
        return falla('la firma del Autentica no corre dentro de withCredential');
      }
      if (!/purpose: 'sat_auth'/.test(auth.slice(i)) || !/buildSignedAutentica\(material/.test(auth.slice(i))) {
        return falla('withCredential no se llama con purpose sat_auth, o la firma no usa el material que entrega');
      }
      const svc = codigoDe('src/services/fiscal-credentials/service.ts');
      const j = svc.indexOf('export async function withCredential');
      const body = j >= 0 ? svc.slice(j, svc.indexOf('\nasync function logAccess', j)) : '';
      return body.includes("await logAccess(row, opts, 'success');") && body.includes("await logAccess(row, opts, 'error',")
        ? ok('el Autentica se firma sólo dentro de withCredential con purpose sat_auth, y el éxito y el error dejan su fila')
        : falla('withCredential dejó de escribir la bitácora en el éxito o en el error: un uso de la e.firma queda sin rastro');
    },
  },
  // ---- MNE-001-119 (#312) · the SAT census against the books ----
  {
    paquete: 'E3.2',
    id: 'sat-census-reconcile-weighs-by-direction',
    enunciado: 'El censo del SAT se lee contra lo contabilizado, lista lo que falta y lo que sobra, y un emitido faltante pesa distinto al cierre que un recibido',
    mutantes: [
      {
        archivo: 'src/services/sat-census/reconcile.ts',
        de: "if (policyValue === 'issued_blocks' && direction === 'issued') return 'blocking';",
        a: "if (policyValue === 'issued_blocks' && direction === 'received') return 'blocking';",
        porque: 'the weights are swapped: a missing received CFDI stops the close and a missing issued one only warns',
      },
      {
        archivo: 'src/services/sat-census/reconcile.ts',
        de: 'out.surplus = surplus.rows.filter((s) => covered[s.direction]);',
        a: 'out.surplus = surplus.rows;',
        porque: 'a direction nobody loaded reads as «everything the books carry is surplus»',
      },
      {
        archivo: 'src/services/sat-census/reconcile.ts',
        de: 'else (fetched ? out.toPost : out.toFetch).push(item);',
        a: 'else out.toFetch.push(item);',
        porque: 'a CFDI already brought in but not posted is asked for again instead of being posted',
      },
      {
        archivo: 'src/services/sat-census/reconcile.ts',
        de: "AND i.cfdi_uuid IS NOT NULL AND i.status NOT IN ('void', 'cancelled')",
        a: 'AND i.cfdi_uuid IS NOT NULL',
        porque: 'a voided invoice still counts as the CFDI being in the books',
      },
      {
        archivo: 'src/services/accounting/period-close.ts',
        de: 'if (census.hasLoads) {',
        a: 'if (false) {',
        porque: 'the close never asks for the census: a month closes with CFDI the SAT lists and the books lack',
      },
    ],
    evaluar: () => {
      const r = codigoDe('src/services/sat-census/reconcile.ts');
      if (!/issued_blocks' && direction === 'issued'\) return 'blocking'/.test(r) || !/both_block/.test(r)) {
        return falla('el peso de un faltante ya no depende de la dirección: un emitido y un recibido pesan igual al cierre');
      }
      if (!/covered\[s\.direction\]/.test(r) || !/l\.first_issued_at < /.test(r)) {
        return falla('el sobrante no mira la cobertura de las cargas: «no se cargó» se lee como «sobra todo»');
      }
      if (!/fetched \? out\.toPost : out\.toFetch/.test(r) || !/je\.status = 'posted'/.test(r)) {
        return falla('la conciliación no distingue lo que falta traer de lo que falta contabilizar, o cuenta asientos no posteados');
      }
      const close = codigoDe('src/services/accounting/period-close.ts');
      if (!/if \(census\.hasLoads\) \{[\s\S]*?censusBox\(census, await censusGapPolicy/.test(close)) {
        return falla('el cierre no lee el censo contra lo contabilizado');
      }
      const cli = codigoDe('src/cli/sat-census-command.ts');
      return /ExitCode\.VALIDATION/.test(cli) && /reconcileCensus\(/.test(cli)
        ? ok('sat download reconcile lista lo que falta traer, contabilizar, cancelar y lo que sobra; el cierre pesa emitido y recibido por la política census_missing_at_close')
        : falla('sat download reconcile no sale con 4 cuando el mes no está completo');
    },
  },

];
