# Integraciones y verificación pública — inventario verificado de motores

**Método.** El inventario lo escribió un agente de lectura estática (sólo `sed`, `grep` y lectura, sin
ejecutar ningún adaptador) el 6 de septiembre de 2026 sobre la rama `investigacion/normas-y-motores`,
y lo contrastó reclamo por reclamo un segundo agente escéptico contra el HEAD `812a43c`, buscando cada
motor «ausente» bajo otro nombre en `src/cli`, `src/api/rest`, `src/api/graphql`, `src/ai` y
`src/services`, y cada parámetro «quemado» en `tax_tables`/`tax_parameters`, `pac_preferences`,
`disclosure_config`, `bitcoin_anchor_config` y el panel de políticas. Esta fusión se fija contra el HEAD
`4b1d8fe`; entre `812a43c` y `4b1d8fe` ningún archivo del alcance cambió (`git diff --stat` vacío sobre
`src/services/integrations`, `src/services/blockchain`, `src/services/webhooks`, las rutas REST citadas,
`src/database` y los docs de PAC), y donde los dos informes daban líneas distintas se cotejó el archivo y
quedó la correcta.

Alcance: `src/services/integrations/`, `src/services/blockchain/`,
`src/api/rest/routes/public-verification.ts`, `src/services/webhooks/` y las puertas que los invocan.

Vocabulario de estado: **completo** (motor con puerta que escribe lo que el motor produce) · **parcial**
(motor con puerta, pero con partes sin puerta, sin efecto real o con premisas rotas) · **inerte** (motor
sin puerta, o con puerta que no escribe su producto) · **ausente** (no hay código). Vocabulario de
parámetro: **ley** (lo fija una norma o un catálogo oficial y debería venir versionado de una tabla) ·
**panel** (decisión del inquilino que debería vivir en el panel de políticas o en una fila de
configuración con lector) · **casa** (constante de la casa o del proveedor, aceptable en código) ·
**quemado** (valor en código que debería ser ley o panel).

---

## §0 Cómo ve la jurisdicción este subsistema

La jurisdicción es aquí una **etiqueta del adaptador**, no una regla que los motores apliquen.

- El único vocabulario de región vive en la interfaz: `'MX' | 'USA' | 'LATAM' | 'EU' | 'GLOBAL'`
  (`src/services/integrations/base/adapter.interface.ts:28`); el registro sabe filtrar por ella
  (`src/services/integrations/base/registry.ts:15-37`). Los PAC son MX; Conekta es MX; Stripe se declara
  US/GLOBAL; S3 no tiene región. Contalink, que es un sistema mexicano, usa una interfaz que **no declara
  región** (`src/services/integrations/accounting/accounting-adapter.interface.ts:33-53`) y cuyo
  encabezado nombra QuickBooks como siguiente conector (`:4`).
- **Ningún motor de este subsistema consulta el país de la entidad.** `esContabilidadMexicana`
  (`src/services/jurisdiction/jurisdiction.ts:35-44`) sólo se usa en
  `src/services/accounting/entity-accounting.ts:5, 75, 172`; ni la ruta de timbrado
  (`src/api/rest/routes/invoices.ts`) ni el generador de nómina
  (`src/services/payroll/mx/cfdi-nomina-generator.ts`) la importan. La puerta de timbrado puede invocarse
  sobre una entidad que no lleva contabilidad mexicana; se apoya en que el operador no la llame.
- Anclaje, sello, publicación y webhooks no tienen jurisdicción. La única aparición del país en el lado
  público es como **dato servido**, no como regla: `incorporation_country` y `accounting_standard` de la
  entidad en `GET /public/v1/entities/:entityId` (`src/api/rest/routes/public-verification.ts:174-181`).
- Ninguno de los parámetros de este subsistema viene de `tax_tables`/`tax_parameters`
  (`src/database/migrations/008_payroll.sql:354, 375`; `009_tax_tables_2026.sql` sólo siembra nómina;
  grep `stripe|conekta|commission|comision|pasarela` ahí: nada) ni del panel de políticas (39 claves en
  `src/services/policy/pending-catalog.ts:50-1055`, ninguna de integraciones ni de divulgación; grep
  `publica|ancla|divulg|agregad|k-anon|minimum_agg|round_to|webhook|pasarela`: cero).
- Las reglas de la RMF se citan con numeración 2022-2025; la RMF 2026 puede haberlas movido. La nueva
  LFPDPPP (marzo de 2025) se cita sin artículos porque no se comprobó su texto.

Sobre «recibos firmados»: en `src` no existe ningún símbolo con ese nombre (grep de
`recibo firmado|signed receipt|grigg|firmarBalanza`: sólo el comentario «TRPA (Triple-entry Accounting)»
de `src/services/blockchain/bitcoin-anchor.ts:13`). La casa lo define en
`docs/investigacion/2026-09-02-mejores-practicas/experimental.md:125-136` y `:228-236`. Se inventaría como
motor ausente (§1.16).

---

## §1 Motores, uno por uno

### Mapa

| # | Motor | Archivo principal | Estado | Jurisdicción |
|---|---|---|---|---|
| 1 | Registro de adaptadores y bóveda de credenciales | `src/services/integrations/base/registry.ts` | completo | ninguna |
| 2 | Cortacircuitos por (inquilino, proveedor) | `src/services/integrations/base/circuit-breaker.ts` | completo (parámetros quemados) | ninguna |
| 3 | Reintentos con backoff exponencial | `src/services/integrations/base/retry.ts` | completo | ninguna |
| 4 | Enrutador multi-PAC con failover y cerrojo antisimulación | `src/services/integrations/mexico/pac/pac-router.ts` | parcial | MX |
| 5 | Adaptadores PAC simulados (Finkok, SW Sapien, Edicom) | `src/services/integrations/mexico/pac/*-adapter.ts` | inerte | MX |
| 6 | Adaptador Sovos Reachcore (real) | `src/services/integrations/mexico/pac/sovos-reachcore-adapter.ts` | parcial | MX |
| 7 | Pasarelas Stripe y Conekta | `src/services/integrations/payments/*.ts` | inerte | US / MX |
| 8 | Almacenamiento S3/R2 | `src/services/integrations/storage/s3-adapter.ts` | inerte | ninguna |
| 9 | Conector Contalink | `src/services/integrations/accounting/contalink-adapter.ts` | completo | MX |
| 10 | Hash canónico y atestación de asiento | `src/services/blockchain/orchestrator.ts` (`attestJournalEntry`) | parcial | ninguna |
| 11 | Sello de periodo (Merkle) | `src/services/blockchain/orchestrator.ts` (`commitPeriod`) | parcial | ninguna |
| 12 | Publicación de agregados con umbral de privacidad | `src/services/blockchain/orchestrator.ts` (`publishAggregates`) | parcial | ninguna |
| 13 | Anclaje a Bitcoin (OP_RETURN) | `src/services/blockchain/bitcoin-anchor.ts` | parcial | ninguna |
| 14 | Adaptadores de cadena EVM y cliente zkVerify | `src/services/blockchain/chain-adapters.ts`, `zkverify-client.ts` | parcial | ninguna |
| 15 | Verificación pública (router sin autenticación) | `src/api/rest/routes/public-verification.ts` | parcial | ninguna |
| 16 | Recibo firmado de periodo (Grigg) | — | ausente | ninguna |
| 17 | Webhooks salientes firmados con reintentos | `src/services/webhooks/webhook-service.ts` | parcial | ninguna |
| 18 | Guardián de URL saliente (SSRF) | `src/services/webhooks/url-guard.ts` | completo | ninguna |
| 19 | Webhooks entrantes de pasarela (Stripe/Conekta) | — | ausente | ambas |

Cuenta: 5 completos, 9 parciales, 3 inertes, 2 ausentes.

---

### 1.1 Registro de adaptadores y bóveda de credenciales — completo

**Reglas implementadas**

- Registro idempotente por `providerId`; búsqueda por categoría y región
  (`src/services/integrations/base/registry.ts:15-37`).
- Credenciales cifradas antes de persistir (`encrypt(JSON.stringify(credentials))`, `registry.ts:62`) en
  `integration_credentials`; el refresh token se cifra aparte (`:63`).
- Caducidad: una credencial con `expires_at` vencido se trata como inexistente (`registry.ts:105-107`).
  Selección por `priority ASC, is_primary DESC` (`:98`).
- Desactivación lógica, nunca borrado (`registry.ts:171-177`).
- El listado de administración expone `simulado` sólo cuando el adaptador declara la propiedad
  (`src/api/rest/routes/integrations.ts:25-27`) y lo explica: «un `simulado: false` sobre Stripe
  afirmaría algo que nadie ha comprobado» (`:22-23`). `simulado` sólo lo declara `IPacAdapter`
  (`adapter.interface.ts:59`); `IIntegrationAdapter` (`:20-43`), `IPaymentAdapter` (`:86-117`) e
  `IStorageAdapter` (`:181-199`) no lo tienen.

**Reglas por definir (ambas; regla de la casa, no ley)**: que `IIntegrationAdapter` exija `simulado` a
todas las categorías. Hoy Stripe, Conekta y S3 fabrican respuestas (§1.7, §1.8) y el listado no puede
avisarlo.

**Parámetros**: `priority ?? 100` (`registry.ts:86`) — **casa**.

**Puertas**: `GET/PUT/DELETE /v1/admin/integrations/:provider`, `POST /:provider/test`
(`integrations.ts:43-142`), permiso `settings:manage`.

### 1.2 Cortacircuitos — completo, con parámetros quemados que ignoran una fila de configuración

**Reglas implementadas**: estados `closed → open → half_open` por (inquilino, proveedor) persistidos en
`provider_health` (`circuit-breaker.ts:41-57, 62-131`); apertura tras N fallos consecutivos, medio-abierto
tras el timeout, cierre tras M éxitos. El constructor toma los defaults por omisión (`:36`); el singleton
nace sin argumentos (`:190`); no hay otro `new CircuitBreaker` en `src`, y los tres usos son
`pac-router.ts:120, 177, 240` sobre el singleton.

**Parámetros**

- `failureThreshold: 5, successThreshold: 2, timeoutMs: 60_000, halfOpenRequests: 1`
  (`circuit-breaker.ts:21-26`) — **quemado**, debería ser **panel**.
- La fila de configuración ya existe y nadie la lee: `pac_preferences.failover_health_threshold DEFAULT 3`
  y `circuit_breaker_timeout_seconds DEFAULT 60` (`src/database/migrations/007_integrations.sql:130-131`).
  Grep de ambos nombres en `src`, `tests` y `scripts`: sólo la 007. `getPreferences` selecciona cuatro
  columnas y ninguna de las dos (`pac-router.ts:61-64`); `savePreferences` no las escribe (`:82-98`); el
  zod de la ruta no las admite (`integrations.ts:31-36`). La 038 no toca `pac_preferences`
  (`038_entierro_s05.sql:38-43`): las columnas siguen ahí, huérfanas.

**Reglas por definir**: ninguna jurisdiccional.

**Puertas**: se ejerce dentro de `pacRouter.stamp/cancel` (`pac-router.ts:177, 240`); lectura en
`GET /v1/admin/integrations/health/all` (`integrations.ts:175-196`).

### 1.3 Reintentos — completo

**Reglas implementadas**: hasta `maxAttempts` con backoff `delay * 2` acotado por `maxDelayMs`
(`retry.ts:30-46`); clasificación de errores reintentables por texto del mensaje (`:51-62`).

**Parámetros**: `maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2`
(`retry.ts:15-20`) — **casa**.

**Puerta**: el único consumidor es `src/services/sat/cfdi-status.ts:5, 98` (el re-export de
`integrations/index.ts:18` no es consumo). Ningún adaptador de este subsistema lo usa. El comentario de
`retry.ts:3` dice que el patrón se copió de `webhook-service.ts`, pero ese archivo no lo importa: el
backoff de webhooks está reimplementado a mano (`webhook-service.ts:164-166`).

**Reglas por definir**: ninguna.

### 1.4 Enrutador multi-PAC con failover y cerrojo antisimulación — parcial

**Reglas implementadas**

- Orden primario → secundario → terciario por inquilino, con `auto_failover`
  (`pac-router.ts:105-142, 159-207`). La lista de PAC enrutables y el registry se alimentan del mismo
  diccionario (`:25-47`; prueba en `tests/integrations/registro-pac.spec.ts:34-52`).
- Cerrojo antisimulación `assertPuedeTimbrar` antes de pedir el timbre y antes de cancelar (`:174, :238`;
  `simulacion.ts:44-57`): un adaptador con `simulado = true` no timbra salvo
  `CFDI_PERMITIR_SIMULACION=true` fuera de producción (`simulacion.ts:35-38`), y un folio simulado se
  persiste como `cfdi_status='failed'` con nota, nunca `'stamped'` (`:63-73`). Con la cadena por omisión
  un inquilino nuevo recibe error de simulación, no un folio falso. El criterio del plan lo vigila
  (`src/plan/criterios.ts:2305-2319`, E3.1).
- **No hay failover ante «ya timbrado»** (`PAC_YA_TIMBRADO`, `pac-router.ts:184-197`), a propósito:
  probar con el siguiente PAC produciría dos UUID para el mismo comprobante. Norma: Anexo 20 de la RMF,
  complemento TimbreFiscalDigital 1.1 (un folio fiscal único por comprobante).
- Motivos de cancelación tipados `'01'|'02'|'03'|'04'` (`adapter.interface.ts:75`; `pac-router.ts:229`;
  catálogo `c_MotivoCancelacion` del Anexo 20 — no hay ninguna tabla ni constante con ese nombre en `src`)
  y el motivo 01 exige folio de sustitución (`sovos-reachcore-adapter.ts:321-326`; también en la ruta,
  `invoices.ts:316-318`).
- Métricas de resultado por proveedor (`cfdiStampOutcomes`, `pac-router.ts:181, 195, 200, 203`).

**Lo que la puerta de timbrado envía.** `POST /v1/invoices/:id/cfdi/stamp` arma un `<cfdi:Comprobante>`
con sólo `Folio, Total, SubTotal, Moneda` y sin Emisor, Receptor, Conceptos, Sello ni Certificado
(`invoices.ts:248-253`); el comentario nombra un `generateCfdiXml` que **no existe** (grep: sólo ese
comentario). Grep `cfdi:Emisor|<cfdi:Receptor|cfdi:Conceptos` en `src`: sólo
`payroll/mx/cfdi-nomina-generator.ts`. Contra el único PAC real ese XML es rechazado por el Anexo 20;
contra los simulados «pasa». La puerta no puede producir un timbre real hoy.

**`cancel` sin puerta, y sin puerta oculta.** `POST /v1/invoices/:id/cfdi/cancel` lanza
`NotImplementedError` (`invoices.ts:330-336`) y el `res.json` que sigue es inalcanzable (`:338-347`).
GraphQL declara `stampCfdi`/`cancelCfdi` (`src/api/graphql/schemas/schema.ts:476-477`) **sin resolutor,
a propósito**: `src/api/graphql/permisos.ts:162-174` («fue RETIRADA porque marcaba la factura como
cancelada en la base sin cancelar ante el SAT»). La CLI lo excluye (`src/cli/cfdi-command.ts:37-38`:
«Timbrar y cancelar NO viven aquí todavía») y los docs del agente también (`src/ai/docs/mexico-cfdi.md:16`:
«CANCELLATION IS WITHDRAWN… Never tell a user the system cancels CFDIs»). `pacRouter.cancel`
(`pac-router.ts:224-241`) no tiene llamador: grep `pacRouter|PacRouter` en `src` da `invoices.ts:243, 256`
(stamp), `integrations.ts:6, 150-166` (preferencias/salud) y `payroll/mx/cfdi-nomina-generator.ts:2, 136`
(stamp). `getRemainingStamps`: cero consumidores fuera de los adaptadores.

**Parámetros**

- Cadena por omisión `finkok / sw_sapien / edicom` (`pac-router.ts:68-72, 93-95`;
  `007_integrations.sql:125-127`) — **quemado**, debería ser **panel** (perfil por inquilino). Los tres
  son simuladores (§1.5), así que un inquilino nuevo no puede timbrar hasta cambiar preferencias; el único
  real, `sovos_reachcore`, no está en la cadena por omisión.
- Catálogo de `reason` `'01'..'04'` como tipo (`adapter.interface.ts:75`) — **ley** hoy expresada como
  **quemado**: correcto en 2026, pero cambia por Anexo 20, no por código.

**Reglas por definir (MX)**

1. Cancelación completa ante el SAT: solicitud, aceptación del receptor cuando procede (tres días
   hábiles), excepciones sin aceptación, plazo máximo (ejercicio de expedición / mes de la declaración
   anual), archivado del acuse por bytes y reversa encadenada del asiento. Norma: CFF art. 29-A párrafos
   cuarto a sexto; RMF reglas 2.7.1.34 (aceptación), 2.7.1.35 (excepciones) y 2.7.1.47 (plazo) —
   numeración 2022-2025, verificar en la RMF 2026. La ruta lo declara pendiente (`invoices.ts:326-329`) y el
   criterio del plan prohíbe fingirlo (`criterios.ts:2320-2331`).
2. Ventana de 72 horas entre `Fecha` del comprobante y `FechaTimbrado` (estándar técnico del Anexo 20).
   Grep `72 h|72h|72 horas|prevalid|validarCfdi|validateCfdi` en `src`: nada.
3. Recuperación de un timbre cuya respuesta se perdió: ante el 311 de Sovos el adaptador lanza y dice por
   dónde recuperar (`sovos-reachcore-adapter.ts:279-289`) pero **ningún código recupera** el folio (grep
   `folioOperacion|Timbre/Get|customId|cfdiPorUUID` en `src`: sólo ese mensaje, `:286-287`). SW ofrece
   `customId` con deduplicación de 72 h y Prodigia `cfdiPorUUID`
   (`docs/investigacion/2026-09-02-mejores-practicas/pacs.md:21, 25`). Norma por consecuencia: unicidad
   del UUID (Anexo 20) y deber de no expedir comprobantes duplicados (CFF 29-A).
4. Prevalidación local del CFDI 4.0 antes de enviarlo (sello, `NoCertificado`, RFC del receptor en LRFC,
   régimen fiscal y uso de CFDI, código postal del receptor): Anexo 20, estándar técnico y matriz de
   errores. Hoy la única validación es el rechazo remoto del PAC.
5. Alta del RFC emisor ante el PAC y presencia en la LCO (RMF 2.7.2.x): `src/services/sat/` sólo contiene
   `cfdi-status.ts`; grep `\bLCO\b|69-B|L_RFC` en `src`: nada. `docs/pac-proveedores.md:175-178` describe
   las dos compuertas manuales de Sovos. No existe paso de onboarding por inquilino.
6. Vigencia del PAC en el padrón del SAT (RMF 2.7.2.x): no verificable por máquina
   (`docs/pac-proveedores.md:30-42`); la casa exige comprobación manual del número de autorización.

**Reglas por definir (US)**: ninguna fiscal. Estados Unidos no tiene certificación fiscal de facturas ni
equivalente del PAC; el intercambio electrónico (DBNAlliance) es voluntario. La única regla que toca este
motor es la guarda de jurisdicción de §0: no debe invocarse para entidades que no llevan contabilidad
mexicana, y hoy nada lo impide.

### 1.5 Adaptadores PAC simulados: Finkok, SW Sapien, Edicom — inerte

Tienen puerta (§1.4), pero su producto nunca llega a la base: el cerrojo los detiene, y cuando se les
permite fuera de producción lo que se persiste es `failed` con nota, no el folio.

**Qué hacen**: fabrican UUID y sello con `crypto.randomBytes`/`randomUUID` y devuelven éxito
(`finkok-adapter.ts:79-107`, `sw-sapien-adapter.ts:69-97`, `edicom-adapter.ts:56-83`); se declaran
`simulado = true` (`finkok:27`, `sw-sapien:27`, `edicom:26`). `cancel` devuelve un acuse inventado
(`finkok:124-129`, `sw-sapien:110-115`, `edicom:90-95`). `healthCheck` devuelve sano sin llamar a nadie
(`finkok:49-52`, `sw-sapien:44-45`, `edicom:43-44`).

**Parámetros** (identidad del PAC que debería venir del proveedor real, no del código) — **quemado**,
a eliminar: `RfcProvCertif="FINK1506162M2"` y `NoCertificadoSAT="00001000000500000000"`
(`finkok:91, 93, 103, 105`); `SWS130301113` / `00001000000600000000` (`sw-sapien:81, 83, 93, 95`);
`EDI1207172X1` / `00001000000700000000` (`edicom:68-69, 79, 81`); saldos ficticios `10000`
(`finkok:134`, `sw-sapien:118`) y `100000` (`edicom:98`). El tipo de `reason` en Edicom es `string`, no el
catálogo (`edicom:90`).

**Reglas por definir (MX)**: convertirlos en adaptadores reales o retirarlos. La casa ya decidió que un
adaptador simulado sin consumidor se retira (criterio E3.1 sobre `sendgrid-adapter`,
`criterios.ts:3231-3240`). Para Edicom además no hay documentación pública verificable
(`docs/pac-proveedores.md:211-216`; `pacs.md:35`).

### 1.6 Adaptador Sovos Reachcore (real) — parcial

**Reglas implementadas**

- `simulado = false`: si no hay UUID en la respuesta, lanza; nunca inventa
  (`sovos-reachcore-adapter.ts:122-128, 297-303`).
- Custodia del CSD: sólo `TimbrarComprobante` (XML ya sellado en CDATA) y `CancelarSolicitudFirmada`
  (petición firmada de nuestro lado); lista `METODOS_PROHIBIDOS` (`:66-71, 224-236, 329-343`; pruebas en
  `tests/integrations/sovos-reachcore-adapter.spec.ts:226-289`). Norma que lo sostiene: CFF art. 17-J
  fr. I (el titular debe evitar el uso no autorizado de los datos de creación de firma); es además regla de
  la casa (`docs/pac-proveedores.md:13-28`).
- Escape del `]]>` dentro del CDATA (`:226`), tope de 10 MB del sobre (`:87, 423-432`).
- Códigos `101` (ApiKey) y `311` (ya timbrado) distinguidos (`:90-91, 276-289`); `311` sale como
  `PAC_YA_TIMBRADO`, que §1.4 no reintenta.
- Motivo 01 exige folio de sustitución (`:321-326`).
- Cancelación asíncrona: devuelve identificador de seguimiento y estado `en_proceso` (`:364-371`).
  **No existe seguimiento**: nadie consulta el estado definitivo ni el acuse, porque nadie llama a
  `cancel` (§1.4).
- `getRemainingStamps` devuelve `-1` porque el endpoint de saldos es un contador histórico (`:384-388`).
- ApiKey por valor o por nombre de variable de entorno (`:41-49, 407-418`).

**Dos discrepancias documentales que el original no señaló**

- La premisa del código «el WSDL no se pudo descargar sin contrato» (`:80-81`) está desfasada según la
  propia casa: `docs/investigacion/2026-09-02-mejores-practicas/pacs.md:27` afirma que «el WSDL de
  producción responde hoy y define exactamente una operación, `TimbrarComprobante`». Si responde, el
  `targetNamespace` es legible hoy sin esperar al UAT.
- `pacs.md:27` dice «`ApiKey` como header SOAP»; el adaptador la manda **en el cuerpo** (`:230-233`) y su
  prueba lo exige (`tests/integrations/sovos-reachcore-adapter.spec.ts:116`). Una de las dos fuentes está
  mal.

**Parámetros**

- Hosts `oat.reachcore.com` / `go.reachcore.com` (`:52-55`) y rutas (`:57-59`) — **casa** (constantes
  del proveedor).
- `NS_CONTRATO` **no confirmado** contra el WSDL (`:79-85`) — **quemado** con premisa rota (ver arriba).
- RFC `ASE0201179X0` y autorización `55267` (`:156, 169-171`) — **casa** (identidad del proveedor), pero
  con vigencia 2026 sin verificar (`docs/pac-proveedores.md:124-132`).

**Reglas por definir (MX)**: máquina de estados de la cancelación asíncrona (RMF 2.7.1.34, acuse);
recuperación del folio por `folioOperacion` o `GET /Timbre/Get` ante 311 (§1.4.3); cotejar `NS_CONTRATO`
contra el WSDL que la casa dice que responde, y resolver dónde viaja la `ApiKey`.

**Puerta**: vía §1.4 (`pacRouter.stamp`) y `PUT /v1/admin/integrations/sovos_reachcore`
(`integrations.ts:103-114`). No está en la cadena de preferencias por omisión.

### 1.7 Pasarelas de pago: Stripe (US/GLOBAL) y Conekta (MX) — inerte

**Qué hacen**: `createCharge` fabrica un id (`ch_`/`ord_` + bytes aleatorios) y responde `succeeded`
sin llamar a nadie (`stripe-adapter.ts:73-96`, `conekta-adapter.ts:62-83`); `refund` igual
(`stripe:107-112`, `conekta:91-95`); `healthCheck` devuelve latencias fijas de 50 y 80 ms (`stripe:42`,
`conekta:36`); `verifyWebhookSignature` **acepta cualquier par no vacío** (`stripe:115-119`,
`conekta:98-100`). Ninguno declara `simulado` (la interfaz no lo exige, `adapter.interface.ts:86-117`).

**Aritmética implementada**: comisión y neto con `Decimal`: Stripe `2.9 % + 0.30` (`stripe:76-77`),
Conekta `2.9 % + 3.00 MXN` (`conekta:65-66`); montos en centavos para `rawResponse` (`stripe:89`,
`conekta:78`).

**Sin puerta**: sólo `PUT /v1/admin/integrations/stripe|conekta` y `POST /:provider/test`
(`integrations.ts:103-132`). Grep `createCharge|verifyWebhookSignature|stripeAdapter|conektaAdapter|
IPaymentAdapter` fuera de `src/services/integrations/`: **cero**. Grep `stripe|conekta` en `src/api`:
sólo el comentario de `integrations.ts:23`. `src/services/payments/payment-service.ts:1278-1286` rechaza
en voz alta la comisión por devolución.

**Lo que sí existe fuera de este subsistema y que el original negó.** El motor que separa comisión e IVA
con la norma correcta ya está escrito para cargos del extracto bancario:
`src/services/banking/treasury-posting.ts:25-38` («EL IVA DE LA COMISIÓN VA A 1135, NO A 1130 … sin
comprobante fiscal no hay acreditamiento (LIVA art. 5, frac. II)»), `contabilizarComisiones` (`:786`),
roles `comision_bancaria` e `iva_pendiente_acreditar` (`:885-889, 905`), leyenda en el asiento (`:911`).
Puerta: `mnemosine bank fee post --iva-rate` (`src/cli/bank-command.ts:301-309`, definición
`:5228-5384`). El flujo de efectivo del art. 1-B también tiene motor:
`src/services/accounting/iva-cash-basis.ts`, importado en `treasury-posting.ts:7`. Hay un tipo de ajuste
manual `iva-comision` (`src/services/banking/reconciliation-adjustments.ts:53`;
`054_la_sesion_que_cuadra.sql:136`). El vocabulario de forma de pago tampoco es nulo: `payment_method`
admite `'stripe'` y `'spei'` (`002_ap_ar_schema.sql:283-286`), y existe un mapa
`c_FormaPago → payment_method` en `src/services/xml-ingestion/rep-linkage.ts:67-79`, pero en sentido
**ingesta** (`'01','02','03','04','28'`), no emisión, y sin OXXO. Lo que falta es **cablear la pasarela a
esos motores**, no inventarlos.

Fuera del alcance, anotado para el escéptico de banca: `bank-command.ts:5370` promete «se acredita con
`bank fee apply`» y ese subcomando no está definido (después de `:5385` sólo `interest post`, `check`,
`reconcile`); la referencia de `:5644` es la reclasificación de cheques, no la liberación del IVA de
comisión.

**Parámetros**

- Tarifas `2.9 % + 0.30` (`stripe:76`) y `2.9 % + 3.00 MXN` (`conekta:65`) — **quemado**, deberían ser
  **panel** (tabla de tarifas por proveedor y país con vigencia; no hay ninguna: grep en migraciones sólo
  da 002/006/007).
- `scopes` de Stripe (`stripe:31`) — **quemado**, aceptable como **casa**.
- Tasa de IVA de la comisión — **ley** (LIVA art. 1 fr. II, 16 %); hoy es bandera obligatoria del comando
  bancario (`bank-command.ts:305-309`), ni panel ni tabla.

**Reglas por definir (MX, Conekta)**

1. La comisión de la pasarela es una prestación de servicios gravada con IVA (LIVA art. 1 fr. II); la
   pasarela emite CFDI por la comisión y el IVA sólo es acreditable con ese CFDI (LIVA art. 5 fr. II; LISR
   art. 27 fr. III). El adaptador calcula la comisión sin IVA (`conekta:65`) y no está cableado a
   `contabilizarComisiones`; la liberación del IVA aparcado en 1135 al ingerir el CFDI del proveedor
   tampoco aparece en `xml-ingestion` (grep `iva_pendiente_acreditar` ahí: cero; `iva-ppd-reclass.ts:67` es
   el camino de PPD, otro).
2. Mapeo inverso del método de cobro (tarjeta, OXXO, SPEI) a `c_FormaPago` del Anexo 20 para la emisión
   del complemento de recepción de pagos (RMF 2.7.1.32, REP). El comentario de cabecera nombra los métodos
   (`conekta:15-16`) y nada los distingue; la emisión del REP está fuera del alcance de la casa hoy
   (`src/cli/rep-command.ts:32-33`).
3. Reconocimiento del cobro cuando la pasarela liquida días después (fecha de cobro frente a fecha de
   depósito; IVA en flujo de efectivo, LIVA art. 1-B): el adaptador devuelve `succeeded` al instante y
   `iva-cash-basis.ts` no recibe liquidaciones de pasarela.

**Reglas por definir (US, Stripe)**

1. Ingreso bruto y comisión por separado, cotejables con el Formulario 1099-K que la pasarela presenta
   como *payment settlement entity* (IRC §6050W): la aritmética existe (`stripe:76-86`) pero no hay motor
   de conciliación anual (grep `1099-K|1099K|6050W` en `src`: nada).
2. Verificación real de la firma del webhook (`Stripe-Signature`, HMAC con tolerancia de tiempo):
   práctica del proveedor, no ley; el stub actual es una vulnerabilidad si alguna vez se cablea una ruta
   entrante (§1.19).
3. Manejo exclusivo de tokens (`source`), nunca PAN: PCI DSS (norma de industria). El contrato ya recibe
   un identificador (`adapter.interface.ts:92`); no hay nada que lo garantice.

### 1.8 Almacenamiento S3/R2 — inerte

**Qué hace**: `upload` calcula un `etag` md5 y devuelve una URL sin subir nada (`s3-adapter.ts:69-76`);
`getSignedUrl` fabrica una firma HMAC casera, no SigV4 (`:87-93`); `delete` y `download` son no-op
(`:96-107`); `healthCheck` devuelve `latencyMs: 20` fijo (`:44`). Sin `simulado`.

**Sin consumidor**: sólo configurar/probar por `/v1/admin/integrations/s3`. Grep
`s3Adapter|IStorageAdapter|getSignedUrl|s3Bucket|config\.aws` fuera de `storage/` y `config/`: sólo el
registro (`integrations/index.ts:5, 13`). `config.aws.s3Bucket` con default `'accounting-core-documents'`
(`src/config/index.ts:120`) tampoco tiene lector.

**Marco corregido: qué custodia hoy los documentos y los registros.** Los XML **no van a S3**:
`xml_documents.xml_content TEXT NOT NULL` y `xml_hash` (`005_xml_ingestion.sql:62-63`); `xml_s3_url`
(`:66`) no la escribe nadie (grep en `src`: cero). La conservación de CFDI es hoy asunto de Postgres y
respaldos, y la casa sí tiene motor de respaldo con verificación por restauración
(`src/cli/backup-command.ts:32-40`; `src/services/backup/backup-service.ts:25-29`) y exportación por
inquilino con manifiesto `sha256` (`src/services/backup/exportacion-inquilino.ts:81, 145`). El mayor
posteado es inmutable por disparador (`041_el_mayor_inviolable.sql:42-112`, reforzado `ENABLE ALWAYS` en
`058:60-63`) y la bitácora es sólo-agrega (`033_audit_log_append_only.sql:15-32`): eso cubre parte de CFF
28-III / RCFF 33-B y de Rev. Proc. 97-22 §4 para **registros**. Lo que no tiene ni retención ni WORM son
los **documentos** (XML, acuses, adjuntos), y no hay horizonte: grep
`retention|conservaci|object.lock|worm|legal hold` en `src` sólo da el comentario de la 033:24 que lo
posterga a «una migración explícita».

**Parámetros**: endpoint `https://s3.${region}.amazonaws.com` (`:35, 71, 88`) — **casa**. Los que
faltan son los de retención: horizonte por jurisdicción (**ley**) y retención legal por entidad
(**panel**).

**Reglas por definir (MX)**: conservación de la contabilidad y de los CFDI por cinco años a partir de la
presentación de la declaración (CFF art. 30; RCFF art. 34); integridad e inalterabilidad de los
**documentos** electrónicos (CFF art. 28 fr. III; RCFF art. 33 apartado B — cubierto sólo para el mayor y
la bitácora); constancia de conservación de mensajes de datos (Código de Comercio art. 49;
NOM-151-SCFI-2016).

**Reglas por definir (US)**: conservar registros mientras sean relevantes (IRC §6001; Treas. Reg.
§1.6001-1(e)); requisitos de un sistema de almacenamiento electrónico —integridad, exactitud, indexación,
recuperación y pista de auditoría— (Rev. Proc. 97-22; Rev. Proc. 98-25); plazo práctico de tres a seis
años por el estatuto de revisión (IRC §6501); siete años para papeles de trabajo de auditoría de emisoras
(SOX §802, 18 U.S.C. §1520). Igual que en MX: sin horizonte ni WORM de documentos.

### 1.9 Conector Contalink (lectura directa, escritura por bandeja humana) — completo

**Reglas implementadas**

- API key **cruda** en `Authorization` (no Bearer) y convención invertida `status: 1 = éxito`
  (`contalink-adapter.ts:39-56`; probado en `tests/ai/external/contalink-adapter.spec.ts:9-23`).
- Normalización de la balanza remota (campos en español y montos como cadena → número, `:59-72, 139-143`).
- Lecturas directas: balanza, saldo de cuenta, listado de CFDI por tipo `Nomina|Ingreso|Egreso|Pago`
  (`:59-98`; el enum fiscal vive en `accounting-adapter.interface.ts:24-31`).
- Escrituras **sólo por bandeja**: la IA encola en `ai_external_ops` validando el proveedor antes
  (`src/ai/external-service.ts:160-182`, validación en `:171-173`), y un humano ejecuta con
  `mnemosine outbox run --live --yes` (`src/cli/mnemosine.ts:2470-2513, 2312-2318`). Reclamo atómico
  `pending → executing` (`external-service.ts:278-286`), piso de antigüedad de 30 días (`:290-304`;
  `src/ai/floor.ts:46`), hash canónico del contenido revisado con reversión del reclamo si difiere
  (`:150-158, 306-310`). Migración `014_ai_external_ops.sql:1-33`.
- `uploadXml` (`contalink:116-118`) sí lleva el CFDI entero, así que el UUID llega a Contalink por esa
  vía, pero no atado a la póliza.

**Parámetros**

- `DEFAULT_BASE_URL` apuntando a un API Gateway de AWS (`contalink-adapter.ts:17`), sobrescribible por
  `CONTALINK_BASE_URL` (`accounting/registry.ts:18`) — **casa**.
- La credencial va por `CONTALINK_API_KEY` (`registry.ts:10-18`), **no por la bóveda cifrada de §1.1**, y
  el conector no está en `integrationRegistry` (fábrica aparte; `integrations/index.ts:11-13` registra
  sólo Stripe, Conekta y S3, y los PAC entran por `pac-router.ts:45-47`), así que no aparece en
  `GET /v1/admin/integrations`.

**Reglas por definir (MX)**: la póliza que se sube a un sistema externo debería llevar los UUID de los
CFDI que la soportan (Anexo 24 de la RMF, estructura de pólizas; RMF 2.8.1.x contabilidad electrónica):
`ManualPolicyInput` no tiene campo de UUID (`accounting-adapter.interface.ts:18-22`) y
`createManualPolicy` reenvía sólo `record_date, description, accounting_records`
(`contalink-adapter.ts:100-106`); grep `uuid` en `src/services/integrations/accounting/`: cero.

**Reglas por definir (US)**: ninguna legal. QuickBooks (`accounting-adapter.interface.ts:4`) no existe;
es producto, no norma.

**Puertas**: CLI `mnemosine outbox list` / `outbox run` (`mnemosine.ts:2478-2513`); onboarding de saldos
iniciales (`src/ai/onboarding-service.ts:108-109`); `diffTrialBalance` (`external-service.ts:55-61`).

### 1.10 Hash canónico y atestación de asiento — parcial

**Reglas implementadas**

- `entry_hash = sha256(JSON canónico)` sobre `id, entity_id, fiscal_period_id, entry_date, total_debits,
  total_credits, lines[account_id, debit, credit]` (`crypto-service.ts:36-66`, canónico en `:49-63`); se
  escribe en `journal_entries.entry_hash` (`orchestrator.ts:88-94`). El canónico **excluye**
  `description`, `source_type`, `source_id` y `reference`, que existen en `journal_entries`
  (`001_core_schema.sql:232-234, 242`).
- Una atestación por asiento (`orchestrator.ts:100-106`); `is_simulated` lo escribe el código
  preguntando a zkVerify y a cada cadena enrutable (`:38-47, 115`), no el DEFAULT de la migración 034
  (`034_atestaciones_simuladas.sql:20-25`).
- Compromiso «Pedersen» simulado con HMAC (`crypto-service.ts:73-86`) y prueba de rango placeholder que
  **ya no revela** valor ni factor de cegado (`:117-136`; la migración 040 purgó las filas,
  `040_el_secreto_que_el_compromiso_revelaba.sql:26-34`).
- Sólo se atesta si el inquilino tiene `blockchain_config.is_active` (`orchestrator.ts:59-60`).

**Parámetros**

- Rango máximo `1_000_000_000_000` (`orchestrator.ts:129`) y `proofSystem: 'ultraplonk'` (`:136, 382`) —
  **quemado**; si el anclaje sobrevive, configuración del anclaje.
- Configuración **almacenada y nunca leída**: `verification_layer` se guarda (`blockchain.ts:118`), se
  selecciona (`orchestrator.ts:537, 548`) y no decide nada (zkVerify se llama siempre, `:133, 379`);
  `required_confirmations`, `max_gas_price_gwei`, `max_tx_cost_usd`, `messaging_protocol` se escriben
  (`blockchain.ts:115-121, 140-141`) y `getConfig` trae cinco columnas, ninguna de esas (`:529-551`).

**Reglas por definir (MX)**: el hash no cubre lo que el RCFF art. 33 apartado B exige poder identificar
por operación —el folio fiscal (UUID) del CFDI que la soporta, la descripción y la contraparte—; hoy un
cambio en `description` o en el UUID vinculado no altera `entry_hash`. No hay norma mexicana que exija
anclar; la que reconoce una prueba de integridad con fecha cierta es la constancia NOM-151 (§1.16).

**Reglas por definir (US)**: ninguna legal exige el hash; Rev. Proc. 97-22 §4 pide controles que aseguren
la integridad de los registros electrónicos, y una cadena de hashes es uno de ellos.

**Puerta**: `attestEntryAsync` en `src/services/accounting/posting.ts:53-59` (fuego y olvido con drenado
antes de cerrar el pool, `:61-70`), invocado tras postear desde CLI y REST
(`src/cli/receipt-command.ts:328, 506, 570, 650`, `bill-command.ts:821`, `invoice-command.ts:663, 751`,
`batch-command.ts:701`, `src/api/rest/routes/invoices.ts:236`). Configuración por
`PUT /v1/admin/blockchain/config` (`blockchain.ts:94-152`).

### 1.11 Sello de periodo (Merkle) — parcial

**Reglas implementadas**

- La entidad debe pertenecer al inquilino (`orchestrator.ts:254-256, 266`).
- Idempotencia: leer un sello existente va antes de cualquier comprobación (`:268-285` explica por qué) y
  devuelve **lo almacenado**, no lo recalculado (`:286-298`).
- Todo o nada: si algún asiento posteado carece de `entry_hash`, no se sella y el mensaje dice cuántos
  (`:311-342`, negativa en `:332-342`; pruebas `tests/integration/sello-periodo.int.spec.ts:148-235`).
  Criterio del plan E0.1: «Ningún sello de periodo declara menos asientos de los que su periodo cerrado
  tiene» (`criterios.ts:780`).
- Árbol Merkle sha256 con `sortPairs` (`crypto-service.ts:154-161`); profundidad `ceil(log2(n))`
  (`orchestrator.ts:347`).
- `balance_commitment = sha256("balance:{periodId}:{merkleRoot}")` (`:350`): **no compromete ningún
  saldo**; es un re-hash de la raíz con nombre de compromiso de balanza.
- `is_simulated` escrito por el código (`:360-364`); atestación a zkVerify y cadenas si el inquilino está
  activo (`:378-399`).

**Parámetros**: ninguno jurisdiccional.

**Reglas por definir (ambas; regla de la casa)**: relación con el cierre duro (`period.hard_closed`) y con
el ejercicio (CFF art. 11). La consulta de asientos (`:311-316`) no filtra por estado del periodo: se puede
sellar un periodo abierto y volver a postear después; la prueba lo reconoce («un periodo ABIERTO con sello
viejo … es una foto con fecha», `sello-periodo.int.spec.ts:417`). Ningún disparador ni CHECK en
`period_commitments` lo impide (en migraciones sólo un índice, `006:274`). El cierre de periodo **no** lo
llama (`orchestrator.ts:326-329`; grep `commitPeriod|blockchainOrchestrator\.` en `src` → sólo
`routes/blockchain.ts:340, 427, 446` y `criterios.ts`).

**Puerta**: `POST /v1/admin/blockchain/commit-period` con permiso `periods:close` y comprobación explícita
de la entidad del cuerpo (`blockchain.ts:416-435`). Lectura pública:
`GET /public/v1/entities/:entityId/periods/:periodId` (`public-verification.ts:205-272`).

### 1.12 Publicación de agregados con umbral de privacidad — parcial

**Reglas implementadas**

- Agrega por `account_type` los asientos posteados del periodo (`orchestrator.ts:414-424`); es la única
  dimensión (`:416, 456`).
- Umbral de k-anonimato y redondeo: omite dimensiones con menos de `minimum_aggregation_count`
  transacciones y redondea al múltiplo de `round_to_nearest` (`:427-446`).
- Compromiso por dimensión y UPSERT por (inquilino, entidad, periodo, dimensión, valor) (`:448-467`).
  `is_simulated` heredado del anclaje (`:465-466`).

**Lo que hoy llega al público (marco corregido).** Las filas **se escriben** con el umbral por omisión,
pero nacen `is_simulated = true` mientras `zkVerifyClient.simulado` sea `true` (`orchestrator.ts:39-47,
466`; `zkverify-client.ts:44`), y **no llegan al público**: la política RLS del verificador exige
`is_simulated = false` (`src/database/rls-policies.sql:362-365`) y `GET /public/v1/entities/:entityId/aggregates`
lo filtra además en SQL (`public-verification.ts:370`); el endpoint de periodo rechaza compromisos
simulados (`:232-235`). Lo que **sí** es consultable hoy por UUID, con `PUBLIC_VERIFICATION_ENABLED=true`,
es la **identidad** de cualquier entidad activa de cualquier inquilino: `name, entity_type,
incorporation_country, accounting_standard` (`public-verification.ts:174-181`) y dos contadores
(`:185-189`), aunque nunca haya publicado nada. Ahí está la exposición LFPDPPP real de hoy; la de los
agregados se activará sin opt-in el día que llegue un adaptador real.

**Parámetros**

- Umbral `5` y redondeo `1000` cuando no hay fila en `disclosure_config` (`orchestrator.ts:433-434`;
  repetidos en `006_blockchain_integration.sql:68-69` y en la ruta, `blockchain.ts:238`) — **quemado**,
  debería ser **panel** con omisión «nada es público» (`experimental.md:224-226`). La decisión «qué se
  publica» es un criterio de divulgación y la regla de la casa dice que una bifurcación así se declara en
  el panel de políticas con su lector; hoy vive en una tabla propia sin clave alguna del panel (§0).
- Configuración **almacenada y nunca leída**: `category_disclosure`, `publish_geography`,
  `publish_line_of_business`, `publish_customer_segment`, `publish_channel`, `publication_delay_minutes`,
  `aggregation_period` (`006:56-67`; `blockchain.ts:209-246` las escribe; el motor sólo lee
  `minimum_aggregation_count` y `round_to_nearest`, `orchestrator.ts:427-431`).

**Reglas por definir (MX)**: cuando la entidad es persona física con actividad empresarial, su
información contable es dato personal y la publicación exige consentimiento y aviso de privacidad
(LFPDPPP, nueva ley de marzo de 2025 — verificar artículos). No hay opt-in por entidad: `legal_entities`
sólo tiene `is_active` (`001:76-93`; la única `ALTER TABLE legal_entities`, `032:20-28`, añade domicilio e
IMSS); la RLS del verificador se apoya en ese `is_active` (`rls-policies.sql:350-353`); el único
consentimiento LFPDPPP del sistema es el de credenciales fiscales (`014_fiscal_credentials.sql:32-35`).

**Reglas por definir (US)**: ninguna ley obliga ni prohíbe a una empresa privada publicar agregados; Reg
FD (17 CFR 243) sólo aplica a emisoras. La misma observación de opt-in aplica a propietarios únicos
(*sole proprietors*) bajo leyes estatales de privacidad.

**Puertas**: `POST /v1/admin/blockchain/publish-aggregates` (`blockchain.ts:437-454`);
`PUT /v1/admin/disclosure-config` (`:209`); lectura pública `GET /public/v1/entities/:entityId/aggregates`
(`public-verification.ts:364-371`).

### 1.13 Anclaje a Bitcoin (OP_RETURN) — parcial

**Reglas implementadas**: formato de carga de 80 bytes `TRPA | versión | tipo | raíz 32 B | conteo uint64
| reservado` y su parser (`bitcoin-anchor.ts:39-102`; `PROTOCOL_ID 'TRPA'` y versión en `:39-40`); Merkle de
los hashes con prueba por hoja persistida (`:118-124, 158-173`); selección de asientos posteados con hash
posteriores al último anclaje (`orchestrator.ts:486-503`); anclaje condicionado a
`bitcoin_anchor_config.is_enabled` (`:478-483`).

**Lo que fabrica**: `bitcoinTxid = sha256(payload + Date.now())` sin transmitir nada
(`bitcoin-anchor.ts:136-140`), y la fila nace con `status = 'broadcast'` (`:149`). **No declara `simulado`**
(grep en el archivo: cero) y `bitcoin_anchors` no tiene columna `is_simulated` (la 034 sólo la añade a tres
tablas, `034:20-25`; ninguna migración altera `bitcoin_anchors`). Consecuencia: `GET /public/v1/bitcoin/verify/:txid`
y `GET /public/v1/bitcoin/proof/:entryHash` sirven txids fabricados con `explorerUrl` a mempool.space
**sin el rechazo 501** que sí aplican `/verify/:entryHash` y `/periods/:periodId`
(`public-verification.ts:383-449` frente a `:104-107, 232-235`); la política RLS de `bitcoin_anchors`
tampoco filtra (`rls-policies.sql:366-369`). Mitigante: el router está apagado por omisión (`src/index.ts:184`).

**Parámetros**

- Tarifas `economy 5 / standard 20 / priority 50` sat/vB, `txSize 250` vB, `btcUsdPrice 60000`
  (`bitcoin-anchor.ts:129-134`; duplicados en `blockchain.ts:314-318`) — **quemado**; fuente externa o
  retirar con el anclaje simulado.
- Configuración **almacenada y no honrada**: `anchor_method` se lee (`orchestrator.ts:478-479`) pero no
  se pasa al servicio (`:516-520` sólo pasa `feeStrategy`); `max_fee_usd`, `anchor_frequency`,
  `ots_calendars`, `use_own_wallet`, `notify_*` sólo se escriben (`blockchain.ts:266-302`). No hay
  planificador para `anchor_frequency`: `JOB_KINDS = close_verification | cfdi_reconciliation | ar_reminders`
  (`src/ai/jobs/job-store.ts:18-20`); `anchorToBitcoin` sólo lo llama la ruta manual (`blockchain.ts:340`).

**Reglas por definir (MX)**: la prueba de integridad con fecha cierta que reconocen el Código de Comercio
(art. 49) y la NOM-151-SCFI-2016 es la constancia de un prestador de servicios de certificación, no un
OP_RETURN (grep `nom-151|nom151|constancia de conservaci|prestador de servicios de certificaci` en `src` y
`docs`: nada). **(US)**: ninguna ley exige ni reconoce específicamente el anclaje (ESIGN, 15 U.S.C. §7001,
da efecto legal al registro electrónico sin prescribir mecanismo). La casa ya propone retirar el anclaje
simulado a favor del recibo firmado (§1.16; `experimental.md:133-136, 274-279`).

**Puertas**: `POST /v1/admin/bitcoin/anchor-now` (`blockchain.ts:339-354`), `PUT /v1/admin/bitcoin/config`,
`POST /v1/admin/bitcoin/estimate`, `GET /v1/admin/bitcoin/anchors` (`:253-336, 461-475`). **`confirmAnchor`
(`bitcoin-anchor.ts:189-201`) no tiene ningún llamador** (grep).

### 1.14 Adaptadores de cadena EVM y cliente zkVerify — parcial

**Qué hacen**: `EvmChainAdapter.simulado = true` (`chain-adapters.ts:143`); fabrican hash de transacción,
número de bloque, `status: 'confirmed'`, `gasUsed: '150000'` y costo en USD desde una tabla
(`:105-131, 145-173`). `solana` se enruta al adaptador EVM (`:195-198`). zkVerify `simulado = true`
(`zkverify-client.ts:44`), inventa `attestationId` y `merkleRoot` (`:54-68`); la rama de producción está
vacía (`:50-52`).

**Parámetros**: `CHAIN_CONFIGS` con RPC públicos (`chain-adapters.ts:42-73`), tabla de gas (`:107-113`),
bloques base (`:123-129`), `ZKVERIFY_RPC_URL` default (`zkverify-client.ts:28`) — **quemado**, sin
sustituto legal; si sobreviven, **casa**.

**Reglas por definir**: ninguna; es infraestructura sin exigencia legal en MX ni en US.

**Puertas**: vía §1.10-§1.11; `GET /v1/admin/blockchain/chains` y `POST /config/validate` (que no hace
ping, `blockchain.ts:154-186`).

### 1.15 Verificación pública (router sin autenticación) — parcial

**Reglas implementadas**

- Apagado por omisión; sólo se monta con `PUBLIC_VERIFICATION_ENABLED=true` (`src/index.ts:174-193`, la
  bandera en `:184`; prueba `tests/integration/atestacion-simulada.int.spec.ts:73`).
- Limitador de tasa dentro del router (`public-verification.ts:15-22`).
- Toda consulta corre con `SET LOCAL ROLE mnemosine_verifier` en su transacción
  (`src/database/consulta-publica.ts:15-32`, el `SET LOCAL ROLE` en `:21`), rol NOLOGIN con SELECT de
  columnas enumeradas y políticas propias con `current_user = 'mnemosine_verifier'`
  (`rls-policies.sql:290-378`; `scripts/provision-roles.sql:37-41`). Criterio E2.1 «camino sancionado, no un
  empujón al rol que ignora RLS» (`criterios.ts:2230`).
- Rechazo `501 ATTESTATION_SIMULATED` —no 404— ante atestación o compromiso simulados
  (`public-verification.ts:46-57, 104-107, 232-235`).
- Rango de agregados por fechas del periodo (no por UUID), extremos validados con 422 y sin oráculo de
  existencia (`:291-324, 341-350`); `LIMIT 100` con `truncated` declarado (`:364-379`).
- Verificación de prueba Merkle acotada a 64 elementos (`MAX_ELEMENTOS_PRUEBA`, `:25`) y digests validados
  por forma (`:25-27, 471-492`).

**Lo que sirve fabricado o incompleto**: `confirmations: c.status === 'confirmed' ? 12 : 0` (`:131`) es una
constante, no una lectura de la cadena; los dos endpoints de Bitcoin no rechazan lo simulado (§1.13); la
identidad de la entidad se sirve con sólo `is_active` (`:174-181`; §1.12). El `codeSnippet` de
verificación independiente (`:151-158`) no documenta el JSON canónico de `hashJournalEntry`
(`crypto-service.ts:49-63`), así que los pasos 1-3 que promete (`:144-146`) no son reproducibles por un
tercero sin leer el código fuente.

**Parámetros**: `12` confirmaciones (`:131`) — **quemado**, a eliminar (debe leerse de la cadena);
`LIMIT 100`, `64` elementos — **casa**.

**Reglas por definir (ambas)**: opt-in por entidad (§1.12); marcar y rechazar anclajes Bitcoin simulados
(§1.13); publicar la especificación del hash canónico junto con la prueba.

**Puertas**: `GET /public/v1/verify/:entryHash`, `/entities/:entityId`,
`/entities/:entityId/periods/:periodId`, `/entities/:entityId/aggregates`, `/bitcoin/verify/:txid`,
`/bitcoin/proof/:entryHash`, `POST /verify/merkle-proof`.

### 1.16 Recibo firmado de periodo (Grigg) — ausente

No hay ninguna firma de servidor sobre una balanza ni sobre un sello. Lo que existe son hashes sin firma
(`entry_hash`, `merkle_root`, `balance_commitment`) y una cadena de anclaje simulada. No existe ninguna
primitiva de firma asimétrica en `src`: grep
`createSign|crypto\.sign\(|ed25519|generateKeyPair|RSA-SHA256|createPrivateKey` sólo da un comentario
(`src/services/fiscal-credentials/certificate.ts:12`); `hashWebhookSignature` es HMAC
(`src/utils/encryption.ts:36-41`). El material RSA de la e.firma se sabe leer
(`certificate.ts:56, 112, 125, 137`), pero no hay función que firme una balanza, y la casa prohíbe usar
e.firma/CSD para el recibo (`experimental.md:231-233`). `tests/integration/f05d-firma-y-sello.int.spec.ts`
no es esto: su «firma» es `hashDeInstantanea` de una sesión de conciliación (`:21-22`).

La casa lo definió (`experimental.md:125-136, 228-236, 274-279`): hash de la balanza pública del periodo,
encadenado a los `entry_hash`, firmado con una llave de servidor cuyo perfil sólo nombra la fuente
(`api_key_env`/`api_key_cmd`), jamás la e.firma ni el CSD; entregado como archivo re-verificable.

**Norma que lo sostiene** — MX: Código de Comercio arts. 89-95 (mensaje de datos y firma electrónica;
fiabilidad de la firma) y art. 49 con NOM-151-SCFI-2016 (constancia de conservación, la forma con
reconocimiento legal de fijar fecha cierta a un documento electrónico); el CSD/e.firma no se usan por CFF
art. 17-J fr. I. US: ESIGN Act (15 U.S.C. §7001) y UETA dan efecto legal a la firma electrónica sin
prescribir esquema. Ni MX ni US lo **exigen** para una empresa privada; lo exige la promesa del producto
(«el auditor puede re-verificar»), que hoy no se cumple.

**Parámetros**: ninguno todavía; cuando exista, la fuente de la llave es **panel** (perfil) y el esquema
**casa**.

**Puerta**: ninguna.

### 1.17 Webhooks salientes: suscripciones, entrega firmada y reintentos — parcial

**Reglas implementadas**

- Catálogo cerrado de 31 eventos (`webhook-service.ts:8-21`); la ruta de alta rechaza eventos fuera del
  catálogo (`src/api/rest/routes/webhooks.ts:27-30`).
- URL validada sintácticamente al crear (`webhook-service.ts:30`) y resuelta por DNS al entregar
  (`:119`) — ver §1.18.
- Secreto de 64 hex mostrado una sola vez en el 201; los listados lo omiten con columnas enumeradas
  (`:31-33, 55-64`).
- Firma HMAC-SHA256 sobre `timestamp.body`, cabecera `X-Webhook-Signature: t=…,v1=…` al estilo Stripe,
  que permite rechazar replays (`:109-113, 122-128`; `src/utils/encryption.ts:36-41`).
- Timeout de 30 s (`:130`); registro de entrega con estado y código HTTP (`:133-146`).
- Reintentos: `attempt_count`, `next_retry_at` exponencial calculado a mano (`:164-166`),
  `status='failed'` al agotar (`:149-175`).
- Frontera de inquilino dentro del SQL para borrar, re-disparar y listar entregas
  (`:45-53, 177-191, 193-217`; criterio E2.1, `criterios.ts:2166-2197`).

**Lo que falta en el propio motor**

- **Nadie lee `next_retry_at`**: sólo se escribe (`webhook-service.ts:171`) y se tipa
  (`src/types/index.ts:810`); el índice para un trabajador existe (`003_banking_assets_inventory.sql:316`) y el trabajador
  no (`JOB_KINDS` no lo cubre, `job-store.ts:18-20`). La entrega es fuego y olvido (`:96-99`, «in production
  use BullMQ») y el único reintento es manual (`retryDelivery`, `:177-191`). El backoff calculado no ejecuta.
- `POST /v1/webhooks/:id/test` despacha `'test.ping'` (`webhooks.ts:60`), que **no está en
  `WEBHOOK_EVENTS`**; como toda suscripción se valida contra ese catálogo, ninguna casa con
  `$2 = ANY(events)` (`webhook-service.ts:73-77`) y no se envía nada, pero la ruta responde `sent: true`
  (`webhooks.ts:62-65`). Es la clase que el criterio E1.4 persigue («Ninguna función reporta éxito de un
  acto externo que no realiza», `criterios.ts:1899-1900`).
- De los 31 eventos sólo se despachan tres (`payroll.run.calculated|approved|paid`,
  `src/services/payroll/common/pay-run-service.ts:99, 125, 136`). `cfdi.stamped`, `invoice.paid`,
  `period.hard_closed`, etc., no tienen emisor (grep `dispatchEvent` en `src`).
- `webhook_deliveries.payload JSONB NOT NULL` guarda el cuerpo completo sin política de retención
  (`003_banking_assets_inventory.sql:302`; `webhook-service.ts:90-94`). Contraste interno: la entrada del agente decidió **no** guardar
  el payload (`src/api/rest/routes/ai-webhooks.ts:47-53`).

**Parámetros**

- Timeout `30000` ms (`webhook-service.ts:130`) y esquema de firma (`:113`) — **casa**.
- `maxRetries` y `retryInterval` **no están quemados**: vienen de `WEBHOOK_MAX_RETRIES` /
  `WEBHOOK_RETRY_INTERVAL` (`src/config/index.ts:140-143`, defaults 5 y 60 s) — configuración por entorno
  (**casa**), aunque hoy sin trabajador que los use.

**Reglas por definir (ambas)**: ninguna ley MX ni US regula webhooks. Si el payload lleva datos personales
(nómina, CFDI de persona física), la entrega a un tercero es una transferencia (LFPDPPP; leyes estatales
US) y el aviso de privacidad debe contemplarla; y la retención del payload almacenado necesita política.

**Puertas**: REST `/v1/webhooks` y `/v1/webhooks/deliveries/:id/retry` (`webhooks.ts:24-92`), permiso
`settings:manage`. **Sin CLI**: `mnemosine webhooks` administra tokens de webhooks *entrantes* del agente
(`src/cli/webhooks-command.ts:13-22`), no estas suscripciones.

### 1.18 Guardián de URL saliente (SSRF) — completo

**Reglas implementadas**: sólo `http:`/`https:` (`url-guard.ts:23, 66-68`); sin credenciales en la URL
(`:69-71`); rechazo de IPv4 privadas, loopback, CGNAT, link-local/metadata (`:25-36`), IPv6
loopback/ULA/link-local y mapeadas IPv4 en ambas grafías (`:37-53`); nombres internos (`:56, 78-80`); en la
entrega, resolución DNS y rechazo si **alguna** dirección es privada (`:89-106`). Ventana TOCTOU de
re-binding declarada como límite (`:17-20`). Pruebas en `tests/services/webhooks/url-guard.spec.ts` y
`tests/integration/perimetro-r2.int.spec.ts:59-73`; criterio E2.1 `criterios.ts:2199-2232`.

**Parámetros**: rangos privados y lista de nombres internos — **casa** (constantes de red).

**Reglas por definir**: ninguna.

**Puerta**: vía §1.17.

### 1.19 Webhooks entrantes de pasarela (Stripe/Conekta) — ausente

No hay ruta de pasarela (grep `webhooks/stripe|webhooks/conekta|Stripe-Signature` en `src`: nada) y los
`verifyWebhookSignature` de §1.7 aceptan cualquier par no vacío. No existe ingesta verificada con
deduplicación por `event.id`. Sin este motor, un cobro liquidado por la pasarela no llega al mayor sin
intervención manual.

**Dos correcciones al marco original**

1. **La tabla `integration_events` no existe.** El original la daba como existente y sin escritor
   (`007_integrations.sql:171-200`); `038_entierro_s05.sql:40` la elimina, con la decisión escrita en
   `:18-23` («un diseño paralelo de sincronización que nunca se cableó… Las filas fase 1 de la familia
   `integration` se construyen sobre ESO [`ai_external_ops` y el registro], no sobre estas tres»). Grep en
   `src`: sólo la 007, la 038 y un comentario en `rls-policies.sql:86`. Un motor nuevo no debe «cablear»
   esa tabla.
2. **Existe una entrada de webhooks que el original no inventarió.** `POST /v1/ai/webhooks/:tokenName`
   (`src/index.ts:195-201`; `src/api/rest/routes/ai-webhooks.ts:17-32`), montada antes de `authenticate`,
   con token dedicado hasheado y comparación en tiempo constante, idempotencia por
   `(token_id, document_key)` (`src/ai/webhooks/intake.ts:6-26`; `028_ai_webhooks.sql:73-75`), limitador
   por IP, y tipos `bank_notification | sat_mailbox | generic` (`intake.ts:28-34`). Le falta para ser el
   motor de este reclamo: HMAC del proveedor (grep `hmac|signature|firma` en `ai-webhooks.ts` e
   `intake.ts`: nada), un tipo `stripe`/`conekta`, conservar el payload (`ai-webhooks.ts:47-53`) y un
   destino contable (despierta a un agente lector, no postea). El sitio natural es extender esta entrada.

**Norma**: ninguna ley; práctica del proveedor (firma HMAC con tolerancia temporal, idempotencia por
`event.id`). Es la condición para que los faltantes US 1099-K y MX IVA-de-comisión funcionen.

**Parámetros**: ninguno todavía; la tolerancia temporal de la firma sería **casa**.

**Puerta**: ninguna para pasarelas.

---

## §2 Parámetros quemados consolidados

Comprobado uno por uno: ninguno viene de `tax_tables`/`tax_parameters` ni del panel de políticas (§0).
Los únicos que tienen una fila de configuración que el código ignora son los del cortacircuitos y las
columnas de `disclosure_config` y `bitcoin_anchor_config` que el orquestador no consume.

| Parámetro | Dónde está quemado | Hoy | Debería ser | Jurisdicción |
|---|---|---|---|---|
| Umbrales del cortacircuitos (5 fallos, 2 éxitos, 60 s, 1 half-open) | `circuit-breaker.ts:21-26` | quemado | panel — `pac_preferences.failover_health_threshold` y `circuit_breaker_timeout_seconds` ya existen (`007:130-131`) y nadie los lee | ninguna |
| Cadena de PAC por omisión (`finkok/sw_sapien/edicom`) | `pac-router.ts:68-72, 93-95`; `007:125-127` | quemado | panel (perfil por inquilino); nunca apuntar a simuladores | MX |
| Catálogo de motivos de cancelación `01..04` | `adapter.interface.ts:75`; `pac-router.ts:229` | quemado (tipo) | ley — catálogo `c_MotivoCancelacion` del Anexo 20 versionado | MX |
| Identidad de PAC ficticia (RFC, `NoCertificadoSAT`, saldos) | `finkok:91-105, 134`; `sw-sapien:81-95, 118`; `edicom:68-81, 98` | quemado | eliminar: viene del proveedor real | MX |
| `NS_CONTRATO` de Sovos | `sovos-reachcore-adapter.ts:79-85` | quemado, no confirmado | casa, una vez cotejado contra el WSDL que `pacs.md:27` dice que responde | MX |
| RFC y autorización de Sovos (`ASE0201179X0`, `55267`) | `sovos:156, 169-171` | casa | casa, con vigencia verificada (`pac-proveedores.md:124-132`) | MX |
| Comisión Stripe 2.9 % + 0.30; Conekta 2.9 % + 3 MXN | `stripe-adapter.ts:76`; `conekta-adapter.ts:65` | quemado | panel — tabla de tarifas por proveedor y país con vigencia (no existe ninguna) | US / MX |
| Tasa de IVA de la comisión de pasarela/banco | bandera obligatoria `--iva-rate` (`bank-command.ts:305-309`) | quemado por comando | ley (LIVA art. 1 fr. II) desde `tax_tables` | MX |
| `scopes` de Stripe | `stripe-adapter.ts:31` | quemado | casa | US |
| Umbral de agregación 5 y redondeo 1000 | `orchestrator.ts:433-434`; `blockchain.ts:238`; `006:68-69` | quemado | panel de políticas con lector; omisión «nada es público» (`experimental.md:224-226`) | ambas |
| Tarifas sat/vB (5/20/50), `txSize 250`, precio BTC 60 000 USD | `bitcoin-anchor.ts:129-134`; `blockchain.ts:314-318` | quemado | fuente externa, o retirar con el anclaje simulado | ninguna |
| Rango máximo 1e12 y `proofSystem: 'ultraplonk'` | `orchestrator.ts:129, 136, 382` | quemado | configuración del anclaje, si el anclaje sobrevive | ninguna |
| `confirmations: 12` | `public-verification.ts:131` | quemado | eliminar: leerse de la cadena | ninguna |
| RPC públicos, tabla de gas, bloques base, `ZKVERIFY_RPC_URL` | `chain-adapters.ts:42-73, 107-113, 123-129`; `zkverify-client.ts:28` | quemado | casa, si sobreviven | ninguna |
| Horizonte de retención de documentos (5 años MX; 3-7 años US) y WORM | no existe | ausente | ley (CFF 30 / RCFF 34; IRC §6501; SOX §802) + panel (retención legal por entidad) | ambas |
| Timeout de entrega de webhook 30 s | `webhook-service.ts:130` | casa | casa | ninguna |
| `maxRetries` / `retryInterval` de webhooks | `config/index.ts:140-143` (variables de entorno) | casa | casa, con un trabajador que los lea | ninguna |

---

## §3 Lo que Estados Unidos exige y no existe en este subsistema

Estados Unidos no tiene equivalente del PAC ni certificación fiscal de facturas: la mayor parte del
subsistema no tiene contraparte legal. Lo que sí exige la ley federal y aquí falta:

1. **Horizonte de retención y WORM de documentos electrónicos** (IRC §6001; Treas. Reg. §1.6001-1(e);
   Rev. Proc. 97-22 y 98-25; IRC §6501 para el horizonte; SOX §802 / 18 U.S.C. §1520 si la entidad es
   emisora o su auditor). Corrección al original: el mayor inmutable (`041`, `058`) y la bitácora
   sólo-agrega (`033`) **ya son** controles de integridad de registros en el sentido de Rev. Proc. 97-22
   §4; lo que falta es el horizonte y la inmutabilidad de los **documentos** (XML, acuses, adjuntos), y el
   almacenamiento de §1.8 es huérfano.
2. **Conciliación de ingresos brutos con el Formulario 1099-K** (IRC §6050W): la pasarela informa el
   bruto; el mayor debe separar bruto, comisión y neto por procesador y cotejarlos al cierre del año. La
   aritmética existe en un adaptador sin puerta (`stripe-adapter.ts:76-86`); grep `1099-K|1099K|6050W`:
   nada.
3. **Ingesta verificada de eventos de la pasarela** (§1.19): sin ella los cobros US no entran al mayor.
   No es ley; es la condición para que 1 y 2 funcionen. `integration_events` está enterrada (`038:40`);
   `/v1/ai/webhooks` existe sin HMAC ni tipo de pasarela.

No exigido por ley en US pero prometido por el producto: recibo firmado re-verificable (§1.16; ESIGN/UETA
le dan efecto legal sin exigirlo).

---

## §4 Lo que México exige y no existe en este subsistema

1. **Cancelación de CFDI ante el SAT con acuse archivado** (CFF art. 29-A párrafos 4-6; RMF 2.7.1.34,
   2.7.1.35, 2.7.1.47 — verificar numeración 2026): aceptación del receptor, excepciones, plazo, archivado
   del acuse, seguimiento del estado asíncrono, reversa encadenada. `pacRouter.cancel` existe sin llamador;
   la ruta REST lanza `NotImplementedError` (`invoices.ts:330-336`); GraphQL la retiró a propósito
   (`permisos.ts:162-174`); CLI (`cfdi-command.ts:37-38`) y docs del agente (`mexico-cfdi.md:16`) lo
   declaran (§1.4, §1.6).
2. **Recuperación del timbre ante respuesta perdida / error 311** (unicidad del UUID, Anexo 20):
   `sovos:279-289` sólo lanza; grep `folioOperacion|Timbre/Get|customId|cfdiPorUUID`: sólo ese mensaje.
3. **Prevalidación local del CFDI 4.0** antes de gastar el timbre (Anexo 20, estándar técnico y matriz
   de errores; ventana de 72 h del atributo `Fecha`): no hay generador de CFDI de facturas; la puerta manda
   un XML sin Emisor, Receptor, Conceptos ni Sello (`invoices.ts:248-253`) (§1.4).
4. **Alta del RFC emisor ante el PAC y verificación en la LCO** por inquilino (RMF 2.7.2.x):
   `src/services/sat/` sólo tiene `cfdi-status.ts`; grep `LCO|69-B`: nada; las compuertas manuales de
   Sovos están documentadas en `docs/pac-proveedores.md:175-178`.
5. **Constancia de conservación NOM-151** (Código de Comercio art. 49; NOM-151-SCFI-2016) como prueba de
   integridad con fecha cierta de sellos y balanzas: es lo que México reconoce en lugar de un OP_RETURN
   simulado (§1.13, §1.16). Grep en `src` y `docs`: nada.
6. **Conservación de contabilidad, CFDI y acuses por cinco años con integridad** (CFF arts. 28 fr. III y
   30; RCFF arts. 33-B y 34). Corrección al original: los XML viven en `xml_documents.xml_content`
   (`005:62`), hay respaldo verificado y manifiesto `sha256`, y el mayor y la bitácora son inmutables; lo
   que falta es el horizonte y el WORM de documentos (§1.8).
7. **IVA de la comisión de la pasarela y su CFDI** (LIVA arts. 1-II y 5-II; LISR 27-III). Corrección al
   original: `contabilizarComisiones` (`treasury-posting.ts:786-911`) ya separa comisión e IVA y lo aparca
   en 1135, con puerta `mnemosine bank fee post`; `iva-cash-basis.ts` cubre el flujo de efectivo. Falta
   cablear la pasarela a ese motor y liberar el IVA aparcado al ingerir el CFDI (§1.7).
8. **Mapeo del método de cobro a `c_FormaPago` y disparo del REP** (Anexo 20; RMF 2.7.1.32) para cobros
   por tarjeta, OXXO y SPEI. Matiz: el mapa existe sólo en sentido ingesta (`rep-linkage.ts:67-79`);
   `FormaPago="99"` fijo en nómina (`cfdi-nomina-generator.ts:102`); el REP está fuera
   (`rep-command.ts:32-33`) (§1.7).
9. **Vinculación UUID ↔ póliza al exportar a un sistema externo** (Anexo 24; RMF 2.8.1.x):
   `ManualPolicyInput` no lleva UUID (`accounting-adapter.interface.ts:18-22`; `contalink:100-106`) (§1.9).
10. **Opt-in y aviso de privacidad para publicar datos de personas físicas** (LFPDPPP 2025). Corrección
    al original: hoy los agregados **no** salen al público porque nacen simulados y la RLS (`:362-365`) y el
    SQL (`:370`) los filtran; lo que sí se expone por UUID, con el router encendido, es la identidad de
    cualquier entidad activa (`public-verification.ts:174-189`), y no hay columna de consentimiento en
    `legal_entities` (`001:76-93`; `032:20-28`) (§1.12, §1.15).

Observado en una puerta vecina, fuera del subsistema: `RegistroPatronal="B0000000000"`, CURP por omisión
`XAXX010101HDFNNN00`, `PeriodicidadPago="04"` y `ClaveEntFed="MEX"` quemados en el generador de nómina
(`src/services/payroll/mx/cfdi-nomina-generator.ts:117-123`).

---

## §5 Puertas (CLI / REST / GraphQL / agente)

| Motor | CLI | REST | GraphQL | Agente |
|---|---|---|---|---|
| 1.1 Registro y bóveda | — | `GET/PUT/DELETE /v1/admin/integrations/:provider`, `POST /:provider/test` (`integrations.ts:43-142`) | — | — |
| 1.2 Cortacircuitos | — | lectura `GET /v1/admin/integrations/health/all` (`:175-196`); ejercicio indirecto vía stamp | — | — |
| 1.3 Reintentos | `mnemosine cfdi …` (estatus, `src/cli/cfdi-command.ts:9` → `cfdi-status.ts:98`) | — | — | — |
| 1.4 Enrutador PAC · stamp | — (`cfdi-command.ts:37-38` lo excluye) | `POST /v1/invoices/:id/cfdi/stamp` (`invoices.ts:242-287`); `POST /v1/payroll/paychecks/:id/cfdi-nomina` (`payroll.ts:256-257`); `GET/PUT /v1/admin/integrations/pac/preferences/all` (`integrations.ts:149-171`) | `stampCfdi` declarado **sin resolutor** (`schema.ts:476-477`) | — |
| 1.4 Enrutador PAC · cancel | — | `POST /v1/invoices/:id/cfdi/cancel` lanza `NotImplementedError` (`invoices.ts:330-336`) | `cancelCfdi` declarado **sin resolutor, a propósito** (`permisos.ts:162-174`) | prohibido en `mexico-cfdi.md:16` |
| 1.5 PAC simulados | — | vía stamp; `PUT /v1/admin/integrations/:provider` | — | — |
| 1.6 Sovos Reachcore | — | vía stamp; `PUT /v1/admin/integrations/sovos_reachcore` (`integrations.ts:103-114`) | — | — |
| 1.7 Stripe / Conekta | — (`bank fee post` es del motor bancario, no de la pasarela) | sólo `PUT` y `POST /:provider/test` (`:103-132`); `createCharge`/`refund`/`verifyWebhookSignature` sin puerta | — | — |
| 1.8 S3/R2 | — | sólo configurar/probar; `upload`/`download` sin puerta | — | — |
| 1.9 Contalink | `mnemosine outbox list` / `outbox run --live --yes` (`mnemosine.ts:2478-2513`) | — | — | encola en `ai_external_ops` (`external-service.ts:160-182`); onboarding (`onboarding-service.ts:108-109`); `diffTrialBalance` (`:55-61`) |
| 1.10 Hash y atestación | tras postear: `receipt-command.ts:328, 506, 570, 650`, `bill-command.ts:821`, `invoice-command.ts:663, 751`, `batch-command.ts:701` | tras postear `invoices.ts:236`; `PUT /v1/admin/blockchain/config` (`blockchain.ts:94-152`) | — | — |
| 1.11 Sello de periodo | — | `POST /v1/admin/blockchain/commit-period` (`blockchain.ts:416-435`); pública `GET /public/v1/entities/:entityId/periods/:periodId` | — | — |
| 1.12 Publicación de agregados | — | `POST /v1/admin/blockchain/publish-aggregates` (`:437-454`); `PUT /v1/admin/disclosure-config` (`:209`); pública `/entities/:entityId/aggregates` | — | — |
| 1.13 Anclaje Bitcoin | — | `POST /v1/admin/bitcoin/anchor-now` (`:339-354`), `PUT /bitcoin/config`, `POST /bitcoin/estimate`, `GET /bitcoin/anchors` (`:253-336, 461-475`); `confirmAnchor` sin llamador | — | — |
| 1.14 EVM / zkVerify | — | `GET /v1/admin/blockchain/chains`, `POST /config/validate` (`:154-186`) | — | — |
| 1.15 Verificación pública | — | `/public/v1/*` sólo con `PUBLIC_VERIFICATION_ENABLED=true` (`index.ts:184`) | — | — |
| 1.16 Recibo firmado | — | — | — | — |
| 1.17 Webhooks salientes | — (`mnemosine webhooks` es de tokens entrantes, `webhooks-command.ts:13-22`) | `/v1/webhooks`, `/v1/webhooks/:id/test`, `/v1/webhooks/deliveries/:id/retry` (`webhooks.ts:24-92`) | — | emisor único: `pay-run-service.ts:99, 125, 136` |
| 1.18 Guardián SSRF | — | vía 1.17 | — | — |
| 1.19 Entrantes de pasarela | — | ninguna de pasarela; existe `POST /v1/ai/webhooks/:tokenName` (`index.ts:201`; `ai-webhooks.ts:17-32`) sin HMAC ni tipo `stripe`/`conekta` | — | despierta a un agente lector (`intake.ts:28-34`), no postea |

---

## §6 Lo que el escéptico refutó o corrigió del original

Ningún reclamo cayó en el fondo; cinco cambiaron de marco o de premisa y uno de matiz. Lo que **no** hay
que creerse del inventario original:

1. **§1.6 Sovos — «el WSDL no se pudo descargar sin contrato».** Se creía porque el código lo dice
   (`sovos-reachcore-adapter.ts:80-81`); es falso según la propia casa, `pacs.md:27` afirma que el WSDL de
   producción responde. Hallazgo añadido: `pacs.md:27` y el adaptador (`:230-233`) discrepan sobre si la
   `ApiKey` viaja como header SOAP o en el cuerpo.
2. **§1.7 Stripe/Conekta — «no existe motor que reciba el CFDI de comisión ni que separe comisión e IVA
   en el asiento».** Falso: `contabilizarComisiones` (`treasury-posting.ts:786-911`) separa y aparca el IVA
   en 1135 con puerta `mnemosine bank fee post`; `iva-cash-basis.ts` cubre el art. 1-B. Lo que falta es
   cablear la pasarela. También era demasiado amplio «mapeo a `c_FormaPago` ausente»: existe en sentido
   ingesta (`rep-linkage.ts:67-79`). Hallazgo fuera de alcance: `bank-command.ts:5370` promete un
   `bank fee apply` que no existe.
3. **§1.8 S3 — «ni inmutabilidad ni pista de auditoría» y el marco implícito de que los documentos van
   a S3.** Los XML viven en Postgres (`005:62-63`; `xml_s3_url` sin escritor), el mayor posteado es
   inmutable por disparador (`041`, `058`), la bitácora es sólo-agrega (`033`) y hay respaldo verificado
   con manifiesto. Lo ausente es el horizonte de retención y el WORM de **documentos**.
4. **§1.12 Publicación — «sin fila de configuración, se publica con 5/1000».** Las filas se escriben
   pero nacen `is_simulated = true` y la RLS (`rls-policies.sql:362-365`) y el SQL
   (`public-verification.ts:370`) impiden que lleguen al público. La exposición real de hoy es la identidad
   de la entidad por UUID (`:174-189`), no los agregados.
5. **§1.19 Entrantes — «la tabla `integration_events` existe con `signature_valid` y deduplicación, y
   nadie la escribe».** La tabla **no existe**: `038_entierro_s05.sql:40` la eliminó a propósito
   (`:18-23`). Y sí existe una entrada de webhooks, `POST /v1/ai/webhooks/:tokenName`, que el original no
   inventarió y que es el sitio natural para extender.
6. **§1.17 Webhooks — `maxRetries`/`retryInterval` como parámetros quemados.** Vienen de variables de
   entorno (`config/index.ts:140-143`); lo que falta es el trabajador que los lea.
7. **Citas corregidas** (se conservan las del escéptico, cotejadas contra `4b1d8fe`): `invoices.ts:330-336`
   (no 330-335); `docs/pac-proveedores.md:211-216` para Edicom (no 215-219), `:175-178` para la LCO (no
   176-180), `:124-132` para la identidad de Sovos (no 128-132); `criterios.ts:3231-3240` para el retiro
   de sendgrid (no 3233); `rls-policies.sql:350-353` (entidades), `:362-365` (agregados) y `:366-369`
   (Bitcoin), no 351-353 / 369-372 / 373-376; `config/index.ts:120` para `s3Bucket` y `:140-143` para
   webhooks; `external-service.ts:150-158` y `:306-310` para el hash del contenido revisado (el original
   citaba `:320-331`, que es el `switch` de ejecución); `sovos:279-289` para el 311 (no 283-288).
8. **Estados renombrados al vocabulario obligatorio**: los «parcial (simulado)» del original para PAC
   simulados, Stripe/Conekta y S3 pasan a **inerte**, porque sus motores no tienen puerta o su puerta no
   escribe el producto del motor.

**Lo que ni el original ni el escéptico verificaron**: ningún adaptador se ejecutó contra un proveedor;
la numeración de la RMF es 2022-2025; la LFPDPPP de 2025 se cita sin artículos; `src/services/sat/cfdi-status.ts`
se leyó sólo para confirmar que es el cliente real de consulta de estatus (con puerta en
`src/cli/cfdi-command.ts:9`): la consulta de estatus **no** falta; falta la cancelación.
