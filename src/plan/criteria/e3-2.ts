import { codigoDe, crudoDe, type Criterio, existe, falla, ok, sinProsa } from './shared.js';

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

  // ---- EFIRMA-3 1/3 · MNE-001-144 (#441) · the census's cancellations reach the mirror and the invoice ----
  {
    paquete: 'E3.2',
    id: 'sat-metadata-cancellation-reaches-invoice',
    enunciado: 'Una cancelación que entra al censo del SAT marca el espejo y, por el puente de #313, la factura, con UPDATE guardados',
    mutantes: [
      {
        archivo: 'src/services/sat-census/cancellations.ts',
        de: 'invoices += await markInvoiceCfdiCancelled(scope.entityId, row.u);',
        a: 'invoices += 0;',
        porque: 'the mirror learns the cancellation and the invoice never does: the AR control stays quiet over a cancelled CFDI',
      },
      {
        archivo: 'src/services/sat-census/cancellations.ts',
        de: "AND xd.sat_validation_status IS DISTINCT FROM 'cancelled'",
        a: 'AND TRUE',
        porque: 'the mirror UPDATE loses its state predicate: a row already cancelled is rewritten on every load',
      },
      {
        archivo: 'src/cli/ingest-census.ts',
        de: 'const marked = await markCensusCancellations(opts.scope, ...span);',
        a: 'const marked = { mirror: 0, invoices: 0 };',
        porque: 'runCensus loads the cancellation into the census and never runs the marks: the mirror and the invoice keep saying current',
      },
    ],
    evaluar: () => {
      // Before MNE-001-144 the SAT's metadata status stayed in sat_cfdi_census:
      // only the one-by-one status query told the mirror and, through the
      // #313 bridge, the invoice. The marks reuse that bridge; they never
      // write invoices themselves.
      const file = 'src/services/sat-census/cancellations.ts';
      if (!existe(file)) return falla('no existen las marcas de cancelación sobre el censo');
      const src = codigoDe(file);
      const i = src.indexOf('export async function markCensusCancellations');
      const marks = i >= 0 ? src.slice(i, src.indexOf('\n}', i)) : '';
      if (!marks) return falla('no existe markCensusCancellations: el Estatus 0 del SAT se queda en el censo');
      const u = marks.indexOf('UPDATE xml_documents xd');
      const update = u >= 0 ? marks.slice(u, marks.indexOf('args\n', u)) : '';
      if (!/SET sat_validation_status = 'cancelled', sat_estado = 'Cancelado'/.test(update)) {
        return falla('el espejo no recibe la cancelación del censo');
      }
      if (!/FROM \(\$\{CANCELLED_OF_WINDOW\}\) k/.test(update) || !/JOIN legal_entities le ON le\.id = c\.entity_id AND le\.tenant_id = \$2/.test(src) ||
          !/xd\.entity_id = \$1/.test(update) ||
          !/AND xd\.sat_validation_status IS DISTINCT FROM 'cancelled'/.test(update) ||
          !/if \(marked\.rowCount !== expected\.rows\.length\)/.test(marks)) {
        return falla('el UPDATE del espejo perdió su guarda (entidad y tenant en el SQL, el predicado de estado o el rowCount): invariante 3');
      }
      if (!/invoices \+= await markInvoiceCfdiCancelled\(scope\.entityId, row\.u\)/.test(marks) ||
          !/import \{ markInvoiceCfdiCancelled \} from '\.\.\/sat\/cfdi-status\.js'/.test(src)) {
        return falla('las marcas no llaman al puente de #313: el espejo sabe que el CFDI se canceló y la factura no');
      }
      if (/UPDATE\s+invoices/i.test(src)) {
        return falla('las marcas escriben invoices por su cuenta: un segundo puente que no lleva la guarda del de #313');
      }
      const cli = codigoDe('src/cli/ingest-census.ts');
      const r = cli.indexOf('export async function runCensus');
      const run = r >= 0 ? cli.slice(r, cli.indexOf('\n}\n', r)) : '';
      const load = run.indexOf('await loadCensus(');
      const mark = run.indexOf('await markCensusCancellations(opts.scope, ...span)');
      if (load < 0 || mark < load) {
        return falla('runCensus no corre las marcas tras cada carga: ingest --kind metadata y sat package download --import dejan la cancelación en el censo');
      }
      return /await cancelledCfdiFindings\(opts\.scope/.test(run)
        ? ok('cada carga del censo marca el espejo con un UPDATE guardado y la factura por el puente de #313, y nombra cada documento contabilizado que aún lleva un CFDI cancelado')
        : falla('runCensus marca y no nombra los documentos contabilizados que aún llevan un CFDI cancelado');
    },
  },

  // ---- MNE-001-431 (#643) · a received CFDI the SAT cancelled marks its bill ----
  {
    paquete: 'E3.2',
    id: 'sat-cancellation-reaches-bill',
    enunciado: 'Un CFDI que el SAT reporta cancelado marca el bill de la entidad que lo lleva, con UPDATE guardado, por cada camino que marca el espejo o el censo',
    mutantes: [
      {
        archivo: 'src/services/sat/cfdi-status.ts',
        de: 'resumen.bills_marked += await markBillCfdiCancelled(ctx.entityId, fila.cfdi_uuid);',
        a: 'resumen.bills_marked += 0;',
        porque: 'cfdi status sync marks the mirror and the invoice and never the bill: a cancelled received CFDI stays payable with no mark',
      },
      {
        archivo: 'src/services/xml-ingestion/sat-validation.ts',
        de: 'result.billsMarked = await markBillCfdiCancelled(d.entity_id, d.cfdi_uuid);',
        a: 'result.billsMarked = 0;',
        porque: 'the ingest check and cfdi status show --refresh learn the cancellation and forget the bill',
      },
      {
        archivo: 'src/services/sat-census/cancellations.ts',
        de: 'bills += await markBillCfdiCancelled(scope.entityId, row.u);',
        a: 'bills += 0;',
        porque: 'the census marks skip the bill: one with no mirror row, such as an opening bill, is never reached',
      },
      {
        archivo: 'src/services/ap/bill-cfdi-cancellation.ts',
        de: 'WHERE entity_id = $1',
        a: 'WHERE $1::uuid IS NOT NULL',
        porque: 'the bridge loses its entity scope: another entity carrying the same UUID is marked',
      },
      {
        archivo: 'src/services/ap/bill-cfdi-cancellation.ts',
        de: 'AND cfdi_cancellation_noted_at IS NULL',
        a: '',
        porque: 'the bridge loses its predicate: the same cancellation rewrites the mark and the count reports bills that did not move',
      },
      {
        archivo: 'src/database/migrations/340_a_bill_notes_its_cancelled_cfdi.sql',
        de: 'x.entity_id = b.entity_id',
        a: 'x.entity_id IS NOT NULL',
        porque: 'the backfill matches the mirror across entities: a bill of a sister entity with the same UUID is marked',
      },
    ],
    evaluar: () => {
      // Before MNE-001-431 a received CFDI the SAT cancelled reached the
      // mirror and, as a finding, the screen; the bill itself carried nothing.
      // One bridge writes the mark, called after the #313 invoice bridge by
      // each path that marks the mirror or the census.
      const file = 'src/services/ap/bill-cfdi-cancellation.ts';
      if (!existe(file)) return falla('no existe el puente del bill: el SAT cancelado nunca llega a la factura de proveedor');
      const src = codigoDe(file);
      const i = src.indexOf('export async function markBillCfdiCancelled');
      const bridge = i >= 0 ? src.slice(i, src.indexOf('\n}', i)) : '';
      const set = /SET ([^\n]*)/.exec(bridge)?.[1] ?? '';
      if (!/cfdi_cancellation_noted_at = NOW\(\)/.test(set) || /status|amount_due|amount_paid|journal_entry_id/.test(set) ||
          !/WHERE entity_id = \$1\s+AND lower\(cfdi_uuid\) = lower\(\$2\)\s+AND cfdi_cancellation_noted_at IS NULL/.test(bridge) ||
          !/rowCount/.test(bridge)) {
        return falla('el puente del bill perdió su guarda (sólo la marca, alcance de entidad, predicado o rowCount): invariante 3');
      }
      const status = codigoDe('src/services/sat/cfdi-status.ts');
      const sweep = status.slice(Math.max(0, status.indexOf('export async function revalidateEntityCfdis')));
      if (!/if \(vs === 'cancelled'\) \{\s+resumen\.invoices_cancelled \+= await markInvoiceCfdiCancelled\([^)]*\);\s+resumen\.bills_marked \+= await markBillCfdiCancelled\(ctx\.entityId, fila\.cfdi_uuid\)/.test(sweep)) {
        return falla('cfdi status sync no marca el bill tras la factura');
      }
      const single = codigoDe('src/services/xml-ingestion/sat-validation.ts');
      if (!/if \(result\.status === 'cancelled'\) \{\s+await markInvoiceCfdiCancelled\([^)]*\);\s+result\.billsMarked = await markBillCfdiCancelled\(d\.entity_id, d\.cfdi_uuid\)/.test(single)) {
        return falla('la consulta de un solo CFDI no marca el bill tras la factura');
      }
      const census = codigoDe('src/services/sat-census/cancellations.ts');
      const m = census.indexOf('export async function markCensusCancellations');
      const marks = m >= 0 ? census.slice(m, census.indexOf('\n}', m)) : '';
      if (!/for \(const row of cancelled\.rows\) \{\s+bills \+= await markBillCfdiCancelled\(scope\.entityId, row\.u\)/.test(marks) ||
          !/const cancelled = await query<\{ u: string \}>\(`\$\{CANCELLED_OF_WINDOW\} ORDER BY c\.cfdi_uuid`, args\)/.test(marks)) {
        return falla('las marcas del censo no llevan cada CFDI cancelado de la ventana al bill');
      }
      if ([status, single, census].some((x) => /UPDATE\s+bills/i.test(x))) {
        return falla('un camino escribe bills por su cuenta: un segundo escritor que no lleva la guarda del puente');
      }
      const migration = 'src/database/migrations/340_a_bill_notes_its_cancelled_cfdi.sql';
      if (!existe(migration)) return falla('no existe la migración 340: la columna de la marca no existe');
      const sql = sinProsa(crudoDe(migration));
      const optIn = sql.indexOf('SET LOCAL row_security = on;');
      const loop = sql.indexOf("PERFORM set_config('app.current_tenant', t.id::text, true);");
      return /ADD COLUMN IF NOT EXISTS cfdi_cancellation_noted_at TIMESTAMPTZ/.test(sql) && optIn >= 0 && loop > optIn &&
        /le\.tenant_id = t\.id/.test(sql) && /x\.entity_id = b\.entity_id/.test(sql) && /c\.entity_id = b\.entity_id/.test(sql) &&
        /AND b\.cfdi_cancellation_noted_at IS NULL/.test(sql)
        ? ok('el SAT cancelado llega al bill por un UPDATE guardado desde el censo, el barrido y la consulta de un CFDI, y la 340 rellena bajo RLS los ya cancelados dentro de su entidad')
        : falla('la 340 no rellena bajo RLS, dentro de su entidad y su inquilino, los bills cuyo CFDI ya consta cancelado');
    },
  },

  // ---- MNE-001-432 (#643) · the AP control names the marked open bill ----
  {
    paquete: 'E3.2',
    id: 'cancelled-received-cfdi-open-named',
    enunciado: 'El control de CxP nombra cada bill abierto con saldo cuyo CFDI recibido el SAT canceló, leyendo la marca que escribe su puente',
    mutantes: [
      {
        archivo: 'src/services/ap/ap-checks.ts',
        de: 'AND b.cfdi_cancellation_noted_at IS NOT NULL',
        a: "AND b.status = 'cancelled'",
        porque: 'the control reads a value the mark never writes: every marked bill with a balance goes unnamed',
      },
      {
        archivo: 'src/services/ap/ap-checks.ts',
        de: 'AND b.status = ANY($2::text[])',
        a: 'AND $2::text[] IS NOT NULL',
        porque: 'the control forgets the open set: a void or draft bill is named as owed',
      },
      {
        archivo: 'src/services/ap/ap-checks.ts',
        de: 'AND b.amount_due > 0',
        a: '',
        porque: 'the control forgets the balance: a bill with nothing left to pay is named as owed',
      },
      {
        archivo: 'src/services/ap/ap-checks.ts',
        de: 'WHERE b.entity_id = $1',
        a: 'WHERE $1::uuid IS NOT NULL',
        porque: 'the control loses its entity scope: a sister entity with the same UUID shows its bill here',
      },
    ],
    evaluar: () => {
      // MNE-001-431 wrote the mark and nothing read it. The control must read
      // the very column the bridge writes, so it takes the name from the
      // bridge's SET rather than from a copy here.
      const bridgeFile = 'src/services/ap/bill-cfdi-cancellation.ts';
      const file = 'src/services/ap/ap-checks.ts';
      if (!existe(bridgeFile)) return falla('no existe el puente del bill: no hay marca que el control pueda leer');
      if (!existe(file)) return falla('no existe ap-checks.ts: ningún control de CxP lee la marca del CFDI cancelado');
      const column = /SET (\w+) = NOW\(\)/.exec(codigoDe(bridgeFile))?.[1];
      if (!column) return falla('el puente del bill no escribe una marca con fecha');
      const src = codigoDe(file);
      const i = src.indexOf("name: 'cancelled-cfdi-open'");
      const probe = i >= 0 ? src.slice(i, src.indexOf('\n  },', i)) : '';
      if (!probe) return falla('ap check no tiene la sonda cancelled-cfdi-open');
      if (!probe.includes(`AND b.${column} IS NOT NULL`)) {
        return falla(`la sonda no lee b.${column}, la marca que escribe el puente: lee un valor que la marca nunca escribe`);
      }
      if (!/WHERE b\.entity_id = \$1\b/.test(probe)) return falla('la sonda perdió el alcance de la entidad: invariante 4');
      if (!/AND b\.status = ANY\(\$2::text\[\]\)/.test(probe) || !/\[entityId, \[\.\.\.PAYABLE_OPEN_STATUSES\]\]/.test(probe)) {
        return falla('la sonda no filtra por PAYABLE_OPEN_STATUSES: nombra bills que no están abiertos');
      }
      if (!/AND b\.amount_due > 0/.test(probe)) return falla('la sonda nombra bills sin saldo por pagar');
      return /\bLIMIT\b/.test(probe)
        ? falla('la sonda recorta el listado: la aceptación pide cada bill')
        : ok('ap check nombra cada bill abierto de la entidad con saldo cuyo CFDI recibido el SAT canceló, por la marca que escribe su puente');
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
      if (!/i\.cfdi_uuid IS NOT NULL AND i\.status NOT IN \('void', 'cancelled'\)/.test(r)) {
        return falla('una factura anulada cuenta como el CFDI ya contabilizado: el censo dejaría de pedir el que sí falta');
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
