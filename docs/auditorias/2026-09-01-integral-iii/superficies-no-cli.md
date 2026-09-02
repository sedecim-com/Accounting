# Lente 9 · Las superficies que no son el CLI

**Árbol:** `61379d0` (origin/main `cfe40c6` + los dos commits de documentación del PR 19).
**Superficies medidas:** REST (17 routers, 6 647 líneas de `src/api` + `src/index.ts`), GraphQL (918 líneas, apagado por bandera), webhooks entrantes (`/v1/ai/webhooks`), webhooks salientes (`/v1/webhooks`), verificación pública (`/public/v1`), `/metrics`, `/live`, `/ready`, `/health`.
**Método:** lectura con `archivo:línea` + cuatro comprobaciones ejecutadas (dos sondas de Express contra `node_modules`, dos consultas contra Postgres local). Lo que no ejecuté lo digo.

---

## LO QUE RESISTE

Auditar a favor también:

1. **La frontera de entidad SÍ se cerró donde la serie TEN pasó.** `journal-entries.ts:29-33` (`assertEntryAccess` → `requireByIdInScope`), `xml-ingestion.ts:35` (`alcance`), `customers.ts`, `vendors.ts` y el resolutor `journalEntry` de GraphQL (`resolvers/index.ts:86-88`) meten el filtro DENTRO del SQL y salen por 404 en los dos casos. Verificado leyendo `src/database/scope.ts` consumido en 5 sitios de `journal-entries.ts` y 11 de `xml-ingestion.ts`.

2. **`resolverEntidadActiva` (auth.ts:80-104) es correcto y el arreglo es del tipo bueno**: la cabecera `x-entity-id` elige entre las entidades del token, no las amplía; la cabecera repetida se rechaza en vez de adivinarse; y `requireEntityAccess` (auth.ts:192-239) rechaza una petición que nombra dos entidades distintas aunque ambas sean del usuario — el argumento de atribución falsa en la bitácora es correcto.

3. **`assertEntityAccess` ya no trata el comodín de permisos como comodín de filas** (auth.ts:264-266). El razonamiento del comentario es exacto: permiso y pertenencia son ejes distintos.

4. **`consultaPublica` (src/database/consulta-publica.ts:16-31) asume `mnemosine_verifier` con `SET LOCAL ROLE`**, y las políticas exigen `current_user = 'mnemosine_verifier'` — el rol ASUMIDO, no el heredado (`src/database/rls-policies.sql:317-337`). Es la corrección fina de «una política `TO rol` aplica a todo MIEMBRO». **Verificado contra la base real**: `SET LOCAL ROLE mnemosine_verifier; SELECT count(*) FROM legal_entities` devuelve 3; el GRANT es por columnas enumeradas y el RFC no está (rls-policies.sql:298-299). Mi hipótesis de que faltaba el GRANT sobre `legal_entities` era **falsa** y la retiro.

5. **Los webhooks entrantes de R2 siguen en pie.** `ai-webhooks.ts`: token dedicado con verificación en tiempo constante, misma respuesta 401 para nombre desconocido / token deshabilitado / secreto malo (líneas 76-80), `express.raw` con tope duro de 1 MB y 413/400 propios (57-67), `withTenant` en vez de `enterTenant`, y duplicado idempotente por `documentKey` que **no despierta al agente** (105-108). Es la única ruta de escritura de todo el árbol con idempotencia real.

6. **Los webhooks salientes tienen SSRF cerrado y el secreto no viaja en los listados** (`webhook-service.ts:31`, `56-64`, `115-118`: `assertUrlDeWebhook` al crear + `assertDestinoPublico` antes de conectar, con la ventana de re-binding anotada y no fingida). La firma cubre `timestamp.body` estilo Stripe. `deleteWebhook`, `retryDelivery` y `getDeliveries` acotan por inquilino DENTRO del SQL.

7. **`/v1/reports/*` converge con el CLI**: delega en `report-service.ts` y el comentario de cabecera (`reports.ts:18-29`) explica que lo que queda en la ruta es el contrato HTTP y nada más. Es el modelo correcto y contrasta con lo que sigue.

8. **La verificación pública está APAGADA por omisión** (`index.ts:151`) y cuando se enciende rechaza atestaciones y compromisos simulados con 501 y un mensaje que explica la diferencia (`public-verification.ts:46-57`). El razonamiento —«una prueba fabricada es peor que ninguna»— es el correcto. El hallazgo 5 es precisamente que esa doctrina no se aplicó en dos de sus cinco endpoints.

9. **`errorHandler` sí mapea los errores de dominio.** Mi hipótesis de que `PERIOD_CLOSED` salía como 500 era **falsa**: `AccountingError extends AppError` con 422 (`utils/errors.ts:69-74`). Lo retiro.

---

## HALLAZGOS

### 1 · [NUEVA] · ALTA · El auto-posteo por REST salta el maker-checker del panel

`POST /v1/journal-entries` acepta `auto_post` en el cuerpo (`journal-entries.ts:63`, pasado en `:196`) y lo entrega a `createJournalEntry(..., { autoPost })`. La rama de auto-posteo (`posting.ts:174-231`) valida, bloquea el periodo, hace el `UPDATE ... status='posted'`, escribe balances y atesta — **sin llamar a `getPolicy`**. El candado F01 vive sólo en `postJournalEntry` (`posting.ts:317-333`).

`grep -rn "segregacion_de_funciones" src --include="*.ts"` da un solo sitio de ejecución: `posting.ts:320`.

El propio panel lo dice en su texto: *«with "exigir", `entry post` refuses when the poster created the draft»* (`src/services/policy/pending-catalog.ts:457`). Nombra el comando del CLI y sólo ese.

Y el CLI lo declara por escrito: *«`entry create` ALWAYS produces a draft. There is no --post, no --auto-post... the REST surface's auto_post (journal-entries.ts:194) is deliberately not exposed»* (`src/cli/entry-command.ts:68-73`). La API expone exactamente lo que ese comentario dice que no se expone.

**Escenario de fallo.** Despacho con dos usuarios y la política en `exigir`. El contador redacta un asiento manual de ajuste y corre `mnemosine entry post` → `SOD_QUIEN_CREA_NO_POSTEA`, exit 5. El mismo contador manda el mismo asiento por `POST /v1/journal-entries` con `"auto_post": true` → 201, `status: 'posted'`, saldos movidos, y en `audit_log` dos filas (`create` y `post`) **con el mismo `user_id`** y sin nota de SoD. El control de cuatro ojos que el despacho declaró en el panel no existe en la mitad de las puertas.

**Matiz honesto sobre el permiso.** La ruta sólo exige `journal_entries:create` (`journal-entries.ts:176`), de modo que en teoría alguien con permiso de crear y no de postear postearía. Revisé los siete roles de `src/auth/roles.ts:88-151`: **ninguno tiene `create` sin `post`** hoy (`revisor` tiene `post` sin `create`, que es lo contrario). Esa mitad es **latente**, no explotable con el catálogo actual. La mitad viva es la de la política.

### 2 · [NUEVA] · ALTA · La API no tiene registro de riesgo: cero de las cuatro compuertas del CLI

`src/cli/kernel/risk.ts` es la arquitectura de seguridad del CLI: cada hoja que muta declara su clase (`lectura`/`escritura`/`irreversible`/`externo`) y la declaración **inyecta y exige** cuatro cosas (`risk.ts:112-147`):

| Compuerta | CLI | REST | GraphQL |
|---|---|---|---|
| clase de riesgo declarada, `gateMutation` falla cerrado sin ella (`risk.ts:190-198`) | 17 declaraciones graves | ninguna | ninguna |
| `--dry-run` obligatorio en irreversible/externo | sí (`risk.ts:135`) | no existe | no existe |
| `--live` para el efecto externo, sandbox por omisión (`risk.ts:143-145`) | sí | no existe | no existe |
| `--idempotency-key` en irreversible/externo (`risk.ts:137-140`) | sí | **no existe en ninguna ruta** | no existe |
| `--reason` en verbos de deshacer (`risk.ts:76-78`, `146-148`) | 9 verbos | sólo `void` y `cfdi/cancel` |  |

Las 17 declaraciones graves del CLI (`entry post/reverse/void`, `bill approve`, `invoice ...×2`, `close`, `payment ×2`, `ingest`, `sat ×2`, `jobs`, `cfdi status sync`) tienen su gemelo REST **sin una sola de las cuatro**.

**Escenario de fallo (idempotencia).** El cliente HTTP reintenta un `POST /v1/journal-entries {auto_post:true}` tras un timeout de 30 s en el que el servidor sí escribió. Resultado: **dos asientos posteados** con dos folios distintos, saldos duplicados y ninguna forma de deshacerlo salvo una reversa manual — el mayor es físicamente inmutable desde la 041. El mismo acto por CLI con `--idempotency-key` devuelve el resultado grabado. `grep -rln "idempotency-store\|conLlave" src` da 6 archivos: `plan/criterios.ts`, 4 de `src/cli/` y el propio almacén. **Ninguno en `src/api`.** No hay cabecera `Idempotency-Key` leída en ningún sitio del árbol.

Y el criterio del plan que vigila esto (`src/plan/criterios.ts:1853-1861`) cuenta escritores de `idempotency_keys` y consumidores de `conLlave` — se satisface con el CLI solo y nunca pregunta si la superficie HTTP tiene alguno. El instrumento da verde sobre media verdad.

### 3 · [NUEVA] · ALTA · La bitácora HTTP no escribe fila para los POST de colección, y cuando escribe pone basura en `entity_type` (probado)

`auditLogMiddleware` (`src/api/rest/middleware/audit.ts:41-77`) parchea `res.json` y deriva `entity_type` de `req.path`. Pero `res.json` se llama DENTRO del router montado, cuando Express ya recortó `req.url` dos veces.

Ejecuté la sonda (Express real, mismo montaje que `index.ts:180-201`):

```
POST /v1/journal-entries
  path visto por audit: "/"        entity_type: null   → NO SE ESCRIBE FILA
POST /v1/journal-entries/<uuid>/post
  path visto por audit: "/<uuid>/post"  entity_type: "11111111-2222-3333-4444-555555555555"
DELETE /v1/webhooks/<uuid>  → 204 vía res.send(): res.json nunca corre → NO SE ESCRIBE FILA
```

Tres defectos en un archivo de 110 líneas:

- **`entityType` nulo ⇒ `if (entityType && req.user)` (línea 52) no entra.** Todo POST a la raíz de un recurso —crear asiento, factura, gasto, cliente, proveedor, webhook, `POST /v1/bills/payments`, `POST /v1/xml/upload`, `POST /v1/pre-registrations/bulk`— **no deja fila en `audit_log`**.
- **`entity_type` = el UUID** para toda acción sobre subrecurso. `audit_log` queda con un vocabulario de tipos que son identificadores.
- **`res.status(204).send()` no pasa por `res.json`**: `DELETE /v1/webhooks/:id` (`webhooks.ts:55`), `DELETE /v1/accounts/:id` (`accounts.ts:143`) y `DELETE /v1/admin/integrations/:provider` (`integrations.ts:120`) no dejan rastro. Ese último desactiva credenciales fiscales.

**Cuarto defecto, del mismo archivo:** líneas 43-44 pisan `req.headers['x-request-id']` con un uuid nuevo. `correlationIdMiddleware` (`correlation.ts:20-24`) ya lo había fijado, lo puso en el `AsyncLocalStorage` del logger y lo devolvió en la cabecera `X-Request-Id`. Probado:

```
POST /v1/journal-entries   header X-Request-Id = CORR-abc123   meta.request_id del cuerpo = AUDIT-f4adea
```

**Escenario de fallo.** Un asiento aparece mal. El auditor tiene la fila de `audit_log` con `request_id = AUDIT-f4adea`; busca ese id en los logs y **no existe**, porque `logger.info('http_request', ...)` (correlation.ts:32) los escribió con `CORR-abc123`. Y el cliente que guardó la cabecera `X-Request-Id` de su respuesta tampoco puede cruzar. Las tres piezas que la correlación existe para unir están desconectadas.

**Matiz honesto:** el mayor NO queda sin auditar. `posting.ts:164-172`, `:196-204` y `:351-360` escriben `registrarAuditoria` DENTRO de la transacción del asiento. Lo que está roto es la bitácora de nivel HTTP — la que cubre los actos que no pasan por el motor contable (webhooks, credenciales de integración, reglas de procesamiento, configuración de blockchain).

### 4 · [NUEVA] · ALTA · GraphQL cuenta el balance de comprobación distinto del CLI, y su cifra incluye borradores y anulados (probado en Postgres)

`resolvers/index.ts:127-151` es una quinta copia del SQL de saldos, fuera de `report-service`, y difiere de la buena en la forma del JOIN:

```
GraphQL:        accounts LEFT JOIN jel ON ...  LEFT JOIN je ON je.id=jel.journal_entry_id AND je.status='posted'
report-service: accounts LEFT JOIN (jel JOIN je ON je.id=jel.journal_entry_id AND je.status='posted') ON ...
```
(`resolvers/index.ts:133-141` contra `report-service.ts:308-313`)

Con dos `LEFT JOIN` encadenados, las filas de `journal_entry_lines` sobreviven aunque su asiento no case: `je` sale NULL pero `jel.debit_amount` sigue sumando. Lo ejecuté contra Postgres con una cuenta, un asiento posteado de 100, uno borrador de 777 y uno anulado de 555:

```
GraphQL (dos LEFT JOIN):   debit_total = 1432
report-service (anidado):  debit_total =  100
```

Además, en el mismo resolutor:
- **`fiscalPeriodId`, `asOfDate` y `accountLevel` están declarados en el esquema** (`schema.ts:482`) **y el resolutor no lee ninguno**. Un tercero que pida el balance «al 31-dic-2025» recibe el acumulado de siempre, sin aviso. Es la clase que la II nombró —parámetros que se validan y se tiran— aquí en su variante peor: ni siquiera se validan.
- **`isBalanced: true` está escrito a mano** (`resolvers/index.ts:148`). El balance de comprobación se declara cuadrado sea cual sea la cifra.

**Escenario de fallo.** Se enciende `GRAPHQL_ENABLED=true` para un tablero. El tablero pinta un balance de comprobación con los borradores dentro y el sello «cuadrado». El CLI y `/v1/reports/trial-balance` pintan otro. Nadie sabe cuál mirar, y el que miente es el que se ve más bonito.

### 5 · [NUEVA] · ALTA · La doctrina «una prueba fabricada es peor que ninguna» no se aplica a los anclajes de Bitcoin — y ésos son los que reparten una URL de mempool.space

`public-verification.ts:30-45` declara la regla; `rechazarSimulada` la aplica en `/verify/:entryHash` (línea 104) y en `/entities/:id/periods/:pid` (línea 232, que es lo que E1.4 cerró tras la II). Los agregados se filtran en el SQL y además en la política de RLS (`rls-policies.sql:332`, único `is_simulated = false` del archivo).

**Los dos endpoints de Bitcoin no la aplican en ningún lado:**
- `GET /public/v1/bitcoin/verify/:txid` (`public-verification.ts:319-368`) sirve la fila entera y añade `explorerUrl: https://mempool.space/tx/${txid}` (línea 364).
- `GET /public/v1/bitcoin/proof/:entryHash` (líneas 371-385) devuelve `getBitcoinProof`, que trae su propio `explorerUrl: https://mempool.space/tx/...` (`bitcoin-anchor.ts:257`).

Y esas filas son **enteramente fabricadas**: `bitcoin-anchor.ts:128-140` calcula la comisión con una tabla fija, el precio del BTC con la constante 60000, y el txid con `sha256(opReturnPayload + Date.now())` bajo el comentario *«Simulate broadcast (production: use bitcoinjs-lib + node RPC)»*. La fila se inserta con `status = 'broadcast'` (línea 149).

`bitcoin_anchors` **no tiene columna `is_simulated`**: la 034 se la puso a `blockchain_attestations`, `period_commitments` y `published_aggregates`, a esas tres y no más (`034_atestaciones_simuladas.sql:21-25`). Y su política pública no filtra nada (`rls-policies.sql:334-337`).

**Escenario de fallo.** Un despacho enciende `PUBLIC_VERIFICATION_ENABLED=true` cuando exista el primer adaptador de cadena real. El auditor del cliente pide `/public/v1/bitcoin/proof/<hash>`, recibe un txid, una altura de bloque y un enlace a mempool.space, lo abre y ve «transaction not found». La atestación del asiento le habrá contestado 501 con una explicación honesta; el anclaje de Bitcoin le habrá dado una prueba inventada con un enlace a un explorador de verdad. Es exactamente el acto que el archivo existe para impedir, servido sin credenciales.

### 6 · [NUEVA] · ALTA · GraphQL: el esquema publica 17 mutaciones y hay 5; ninguna comprueba permisos; seis lecturas no comprueban pertenencia de entidad

Si alguien enciende la bandera, el riesgo real es mayor que el que `index.ts:208-232` describe:

- **Ficción de contrato.** `schema.ts:493-512` declara 17 mutaciones; `resolvers/index.ts:166-211` implementa 5. Faltan `createAccount`, `updateAccount`, `deleteAccount`, `reverseJournalEntry`, `createInvoice`, `sendInvoice`, `voidInvoice`, `recordInvoicePayment`, `stampCfdi`, `cancelCfdi`. `type Query` declara 10 y hay 8: faltan `balanceSheet` e `incomeStatement`. Y `type Subscription` (`schema.ts:518-523`) declara 4 y no hay resolutor de suscripciones. Todos son campos **no nulos**, así que la introspección publica un contrato del que ~65 % revienta al invocarse.
- **Cero comprobación de permisos.** No hay un solo `requirePermission` en los 393 renglones de resolutores. Un `viewer` (`accounts:read, journal_entries:read, invoices:read, bills:read, reports:read` — `roles.ts:145-150`) puede llamar `createJournalEntry(autoPost:true)`, `voidJournalEntry` y **`hardClosePeriod`**. La afirmación del comentario de `index.ts:220-223` sigue siendo cierta hoy.
- **Seis lecturas sin comprobar pertenencia.** `accounts` (64), `journalEntries` (90), `invoices` (112), `trialBalance` (127) y `fiscalPeriods` (153) reciben `entityId` del cliente y lo meten en el `WHERE` **sin `ctx` siquiera en la firma**; `invoice(id)` (107-110) hace `SELECT * FROM invoices WHERE id = $1` a secas. `journalEntry` y `account`, en el mismo objeto, sí usan `findByIdInScope`. La frontera de entidad de la serie TEN está cerrada en dos resolutores de ocho.

**Escenario de fallo.** Un despacho con dos clientes en el mismo inquilino y un usuario con acceso sólo a la entidad A: `query { trialBalance(entityId: "<B>") { accounts { accountName endingBalance } } }` devuelve el balance completo de B. RLS aísla el inquilino, no la entidad.

### 7 · [NUEVA] · ALTA · Los webhooks salientes: reintentos que nadie ejecuta, 27 de 31 eventos que nadie emite, y un `/test` que siempre miente

R2 blindó la **seguridad** de esta superficie (ver «lo que resiste»). No miró el ciclo de entrega:

- **Los reintentos son código muerto.** `markFailed` calcula `next_retry_at` con retroceso exponencial y lo guarda (`webhook-service.ts:163-174`). `grep -rn "next_retry_at" src scripts` devuelve: las tres migraciones que crean la columna y el índice `idx_webhook_deliveries_retry`, `types/index.ts:811`, y **el único `UPDATE` que la escribe**. Nadie la lee. No hay trabajador, ni cron, ni comando. `config.webhooks.maxRetries` gobierna un contador que nunca vuelve a correr. La entrega no es «al menos una vez»: es **como mucho una vez**, y el fallo queda como `status='pending'` para siempre.
- **27 de los 31 eventos declarados no se emiten nunca.** `WEBHOOK_EVENTS` (`webhook-service.ts:8-21`) lista 31. `grep -rn "dispatchEvent" src` fuera del servicio da **4 llamadas, las cuatro en `services/payroll/common/pay-run-service.ts:99,125,136`**. `journal_entry.posted`, `invoice.paid`, `cfdi.stamped`, `period.hard_closed`, `bill.approved`... se pueden suscribir y no llegan jamás. Un integrador construye contra un catálogo del que el 87 % es papel.
- **`POST /v1/webhooks/:id/test` miente siempre y por dos motivos independientes.** Ignora `:id` por completo y llama `dispatchEvent(tenant, 'test.ping', ...)` (`webhooks.ts:59-66`); y `'test.ping'` **no está en `WEBHOOK_EVENTS`**, de modo que `createWebhook` lo rechaza (`webhooks.ts:27-30`) y ninguna suscripción puede tenerlo. `dispatchEvent` hace `WHERE ... $2 = ANY(events)` → cero filas, cero entregas, y la ruta responde `{ sent: true }`.
- **Sin orden ni deduplicación en el receptor.** `dispatchEvent` dispara `deliverWebhook(...).catch(console.error)` en bucle (`webhook-service.ts:97-99`): entregas concurrentes, sin orden garantizado. El `X-Webhook-ID` viaja en cabecera y el `id` del payload es `whd_` + los primeros 8 caracteres del uuid — 8 hex, no un identificador de deduplicación serio. `retryDelivery` reenvía con el **mismo** `deliveryId`, incluso sobre una entrega ya `success`.

**Escenario de fallo.** El ERP del cliente se suscribe a `journal_entry.posted` para su conciliación. No recibe nada, nunca, y el sistema no tiene forma de decírselo: `/test` responde `sent: true`.

### 8 · [II-SIGUE-VIVA y peor] · MEDIA · Parámetros que se validan y se tiran: cuatro más

La II encontró el patrón. En esta lente aparecen cuatro casos nuevos, uno de ellos **persistido en una columna**:

1. `processing_batches.auto_post`: `POST /v1/processing-batches` lo escribe con `auto_post !== false` — es decir, **verdadero por omisión** (`xml-ingestion.ts:637`). `grep -rn "auto_post" src` muestra que **nadie lo lee jamás**: `processBatch` (`pre-registration-service.ts:1093-1142`) no lo consulta y llama a `processToAccounting` sin condición, que postea con `autoPost: true` fijo (`pre-registration-service.ts:1076`). Una columna de control que se guarda, se muestra en la respuesta 201, y no gobierna nada.
2. Los tres argumentos de `trialBalance` en GraphQL (hallazgo 4).
3. El `:id` de `POST /v1/webhooks/:id/test` (hallazgo 7).
4. `configureProviderSchema = z.record(z.unknown())` (`integrations.ts:10`): `PUT /v1/admin/integrations/:provider` «valida» cualquier objeto JSON y lo entrega con `adapter.configure(req.body as never, ctx)` (línea 86). El `as never` es la confesión: TypeScript deja de comprobar justo donde entran credenciales de un PAC.

*Nota a favor:* revisé si por ahí entra la e.firma (regla de la casa e). **No.** Los adaptadores de PAC piden usuario/contraseña o token (`finkok-adapter.ts:30-33`), nunca `.cer`/`.key`. Regla respetada.

### 9 · [NUEVA] · MEDIA · `POST /v1/pre-registrations/bulk`: sin tope, y tres de sus cuatro acciones reportan éxito sobre cero filas

En el mismo archivo, `xml_contents` sí lleva tope (`MAX_XML_POR_LOTE = 100`, `xml-ingestion.ts:37,53`) con un comentario de 10 líneas explicando por qué. **`bulkPreRegSchema.ids` lleva `.min(1)` y ningún `.max()`** (`xml-ingestion.ts:79`), y es el arreglo que **postea al mayor**: cada `id` de la acción `process` recorre `processToAccounting`. Con el parser en 10 MB caben ~270 000 UUIDs en un POST.

Y el comentario de las líneas 442-447 celebra que `process` dejó de mentir en las dos direcciones. **`approve`, `reject` y `set_batch` siguen mintiendo**: hacen `UPDATE ... WHERE id = $2 AND entity_id = $3` y hacen `results.push({ id, status: 'success' })` **sin mirar `rowCount`** (líneas 456-479).

**Escenario de fallo.** Un cliente manda `{"action":"approve","ids":[50 uuids ajenos]}` y recibe 50 `success`. Ninguna fila se movió. El operador cree que aprobó 50 pre-registros; el lote sigue pendiente y nadie lo sabrá hasta que alguien cuente a mano.

### 10 · [NUEVA] · MEDIA · Rutas direccionadas por UUID que la serie TEN no alcanzó

Verificadas una a una siguiendo la cadena hasta el SQL:

| Ruta | Evidencia | Alcance real |
|---|---|---|
| `GET/PATCH/DELETE /v1/accounts/:id` | `accounts.ts:99,124,138` → `account-service.ts:114`, `:212-230`, `:264-282` | `WHERE a.id = $1`, sin entidad |
| `POST /v1/invoices/:id/cfdi/stamp` | `invoices.ts:236` | `SELECT * FROM invoices WHERE id = $1` |
| `POST /v1/invoices/:id/cfdi/cancel` | `invoices.ts:288` | `WHERE id = $1 AND cfdi_status='stamped'` |
| `POST /v1/processing-batches/:id/execute` | `xml-ingestion.ts:652` → `pre-registration-service.ts:1097-1107` | `WHERE id = $2` / `scheduled_batch_id = $1` |
| `POST /v1/processing-batches/:id/cancel` · `GET /:id/progress` | `xml-ingestion.ts:687-689`, `662-665` | `WHERE id = $1` |

Todas dentro del mismo archivo o el mismo router donde las hermanas sí están acotadas. `execute` postea al mayor.

**Escenario de fallo.** Despacho con dos entidades y un usuario de la entidad A. Con el UUID de un lote de la entidad B (que sale en el 201 de `POST /v1/processing-batches`, en `GET /v1/processing-batches`, o de un correo reenviado), `POST /v1/processing-batches/<id>/execute` contabiliza los gastos de B en los libros de B — el asiento nace bien formado porque el pre-registro trae su propio `entity_id`. Es literalmente el escenario que el comentario de `xml-ingestion.ts:21-25` describe para `/pre-registrations/:id/process`, y que allí se cerró.

*Honestidad:* revisé `invoices/:id/send`, `/:id/void`, `/:id/payments` y `fiscal-periods/:id/*-close`: **sí están acotadas**, pasando `req.entityId` al servicio (`invoices.ts:141-144`; `fiscal-periods.ts:52-53,63-64`). El barrido grueso por archivo sobreestimaba.

### 11 · [NUEVA] · ALTA · `POST /v1/invoices/:id/cfdi/stamp` timbra de verdad al primer intento, sin marcha seca, sin llave y con un XML de juguete

Cuatro defectos que se agravan entre sí (`invoices.ts:233-278`):

1. **Sin compuerta `--live`.** En el CLI, todo efecto externo se declara `externo` y sale al sandbox salvo que se escriba `--live` (`risk.ts:117,143-145`; el patrón, ejecutado, en `cfdi-command.ts:194-207`). La ruta llama `pacRouter.stamp` en el primer intento.
2. **Sin idempotencia y sin comprobar si ya está timbrada.** Un reintento vuelve a timbrar y el `UPDATE` (líneas 259-268) **pisa `cfdi_uuid`**. Resultado: dos CFDI emitidos ante el PAC para una factura y el primero **huérfano** — el sistema ya no guarda su UUID, así que no puede cancelarlo. Consecuencia fiscal real, irreparable desde el sistema.
3. **Sin acotar por entidad** (hallazgo 10).
4. **El XML es un maniquí.** Líneas 240-245: un `cfdi:Comprobante` con Folio, Total, SubTotal y Moneda, sin Emisor, sin Receptor, sin Conceptos, sin Impuestos, sin sello, bajo el comentario *«real implementation would use cfdi.ts generateCfdiXml»*. La ruta manda eso a un PAC real.

**Escenario de fallo.** Cliente HTTP con reintento automático, red lenta. Dos timbres, uno inválido y no cancelable, en el mes que el SAT audita.

### 12 · [NUEVA] · MEDIA · `/metrics` acepta etiquetas de un anónimo y las devuelve a otro anónimo (probado)

`metricsMiddleware` está montado para toda la aplicación (`index.ts:114`) y usa `req.route?.path ?? req.path` como etiqueta (`metrics.ts:52-54`). En un 401 no hay `req.route`, así que la etiqueta es el camino literal. `GET /metrics` se sirve **sin autenticar** (`index.ts:115`, con la nota «gate by IP allowlist at the LB»).

Sonda ejecutada:
```
accounting_http_requests_total{method="GET",route="/aaaa-cardinalidad-1",status="401"} 1
accounting_http_requests_total{method="GET",route="/aaaa-cardinalidad-2",status="401"} 1
accounting_http_requests_total{method="GET",route="/%3Cscript%3Ealerta%3C/script%3E",status="401"} 1
```

**Escenario de fallo.** Un anónimo pide un millón de URLs distintas bajo `/v1/`. `prom-client` guarda cada combinación de etiquetas para siempre: un millón de series en el histograma (11 cubos cada una) más el contador. El proceso se come la memoria y el scraper de Prometheus se cae con la respuesta. Y como `/metrics` no autentica, el atacante lee de vuelta lo que escribió. *No es inyección de formato*: `prom-client` escapa las etiquetas (las llaves salieron percent-encoded). Es cardinalidad y canal de eco.

**Agravante montado encima:** `app.set('trust proxy')` **no aparece en ningún sitio del árbol** (`grep -rn "trust proxy\|x-forwarded" src` → cero). Con el valor por omisión (`false`), `req.ip` es la dirección del socket. Detrás de un balanceador —el despliegue que el propio comentario de `index.ts:113` supone— **todas** las peticiones comparten `req.ip`, así que `preAuthRateLimiter` (`rate-limiter.ts:31-33`), que es el único freno de `/public/v1` y de `/v1/ai/webhooks`, colapsa en un cubo global: un cliente ruidoso agota la cuota de todos, y el estrangulamiento por atacante desaparece.

### 13 · [NUEVA] · MEDIA · No hay contrato publicado, y la versión es una cadena repetida a mano

- **Cero esquema.** No existe OpenAPI, Swagger, JSON Schema ni `.yaml` de API en el árbol (`find . -iname "*openapi*" -o -iname "*swagger*"` → sólo `docker-compose.yml`, `dependabot.yml`, `ci.yml`, `ISSUE_TEMPLATE/config.yml`). El único contrato legible por máquina de todo el sistema es el esquema de GraphQL, que está apagado y del que 12 mutaciones son ficción (hallazgo 6).
- **El versionado es tipográfico.** `version: 'v1'` está escrito literal en cada `meta` de cada ruta (~60 apariciones) y `const apiPrefix = '/v1'` en `index.ts:173`. No hay negociación, ni deprecación, ni forma de servir dos versiones.
- **Dos formas de error conviviendo.** `errorHandler` produce `{ errors: [{code, message, field, details}], meta }` (`error-handler.ts:13-27`). `ai-webhooks.ts` produce `{ error: "texto" }` sin `meta` en cuatro sitios (líneas 46, 64-66, 84, 91). `/ready` produce una tercera forma (`index.ts:129-134`).
- **422 para dos cosas distintas.** `ValidationError` («tu entrada está mal») y `AccountingError` («el estado del mayor lo prohíbe») comparten el 422 (`utils/errors.ts:15,69`). El CLI **sí** los separa: `entry-command.ts:127-136` mantiene `BLOCKED_CODES` y `translateDomainError` los manda al código de salida 5 (BLOCKED) en vez del 2 (USAGE). Un cliente HTTP no puede distinguir «corrige y reintenta» de «no lo intentes más».
- **Doble montaje del mismo router.** `index.ts:200-201` monta `xmlIngestionRouter` en `/v1/xml` **y** en `/v1`; `index.ts:202-203` monta `blockchainRouter` en `/v1/admin/blockchain` **y** en `/v1/admin`. Cada acto tiene dos URL, y el `entity_type` de la bitácora (hallazgo 3) sale distinto según cuál se use.

### 14 · [NUEVA] · BAJA · El mensaje de error de la verificación pública manda al operador a una migración que no existe

`consulta-publica.ts:5,25-26` dice que `mnemosine_verifier` lo crea «la migración 042» y que «el GRANT viaja ahí»; el error que lanza instruye: *«corre las migraciones (el GRANT viaja ahí)»*. Comprobado: **la 042 es `042_el_refresco_sale_del_posteo.sql` y no menciona el rol** (`grep -rn "mnemosine_verifier" src/database/migrations/*.sql` → cero). El rol vive en `scripts/provision-roles.sql:37-41` (correcto, regla de la casa g: los roles son objetos de clúster) y los GRANT en `src/database/rls-policies.sql:298-303`, que `migrate.ts:109` sí aplica, y que se **saltan con `RAISE NOTICE`** si el rol no existe (`rls-policies.sql:291-294`).

**Escenario de fallo.** Clúster nuevo, se enciende `PUBLIC_VERIFICATION_ENABLED=true`, `SET LOCAL ROLE` falla, el operador lee el error, corre las migraciones como se le indica, la 042 no hace nada, el aviso de `rls-policies.sql` se pierde en la salida, y vuelve al mismo error. El remedio correcto —`scripts/provision-roles.sql`— sólo aparece en un `RAISE NOTICE` que nadie está mirando.

---

## VERIFICACIÓN DE LA AUDITORÍA II (lo que toca esta lente)

| Afirmación de la II | Veredicto | Evidencia |
|---|---|---|
| GraphQL se saltaba `tenantContext` y viajaba al pool sin inquilino | **[II-CERRADA]** | `index.ts:251-254`: `tenantContext` va montado justo tras `authenticate` en `/graphql`. El comentario lo documenta («Ya va montado») |
| GraphQL «se salta la auditoría y el limitador que llevan las rutas REST» | **[II-EXAGERADA en un tercio]** | El limitador **pre-auth** sí está (`index.ts:249`). Lo que falta es `rateLimiter` por inquilino (`index.ts:186`) y `auditLogMiddleware` (`:187`). Dicho eso, el hallazgo 3 muestra que `auditLogMiddleware` tampoco escribe fila para los POST de colección de REST, así que la ventaja de la puerta auditada es menor de lo que la II supuso |
| «`createJournalEntry` y `postJournalEntry` llegan al motor con `authenticate` sólo; no hay comprobación de permisos en los resolutores» | **[II-SIGUE-VIVA]** | Cero `requirePermission` en los 393 renglones de `resolvers/index.ts`. Se añadió pertenencia de entidad (`assertEntityAccess`, `alcanceDe`) pero no permisos. Ver hallazgo 6 |
| «Parámetros que se validaban y se tiraban» | **[II-SIGUE-VIVA]** | Cuatro casos nuevos, uno persistido en columna. Ver hallazgo 8 |
| E1.4 puso el cerrojo de simulación en `/verify/:entryHash` y no en los periodos | **[II-CERRADA]**, con secuela | Los periodos ya lo tienen (`public-verification.ts:232`). Los dos endpoints de Bitcoin nunca se miraron. Ver hallazgo 5 |
| «918 líneas apagadas por bandera» | correcto (525 + 393 = 918); el comentario de `index.ts:229` dice «891» — desfase menor del propio fuente | — |

**Aritmética de la lente: 14 nuevas · 2 de la II siguen vivas · 2 cerradas · 1 exagerada.**

---

## RECOMENDACIONES

**El principio, en una frase:** la API no es un adaptador del motor, es un segundo motor con menos reglas. Las cuatro compuertas del CLI viven en `src/cli/kernel/`; mientras vivan ahí, la API no las tiene y no puede tenerlas.

| # | Acción | Tamaño | Tramo destino |
|---|---|---|---|
| R1 | Mover el candado de `segregacion_de_funciones` de `postJournalEntry` a un punto que **ambas** ramas atraviesen (una función `autorizarPosteo(client, entry, userId)` invocada desde `posting.ts:186` y `:340`). Con su espejo por mutación en las dos direcciones. Cierra el hallazgo 1 | **S** | inmediato — es la regla (a) de la casa aplicada a media puerta |
| R2 | Arreglar `auditLogMiddleware`: derivar el recurso de `req.baseUrl` (no de `req.path`), envolver también `res.send`/`res.end`, y **no** pisar `x-request-id`. Añadir un criterio de conducta que dispare un `POST /v1/journal-entries` y afirme que aparece una fila con `entity_type='journal_entries'` y el `request_id` de la correlación. Cierra el hallazgo 3 | **S** | inmediato — hoy la bitácora HTTP está peor que ausente: está presente y equivocada |
| R3 | Borrar el resolutor `trialBalance` de GraphQL y delegar en `getTrialBalance`, con sus tres argumentos. Borrar `isBalanced: true`. Cierra el hallazgo 4 y baja de 5 a 4 las copias que E4.2 cuenta | **S** | E4.2, que ya está en rojo por esto |
| R4 | Poner `is_simulated` en `bitcoin_anchors` (migración, `DEFAULT true` como la 034) y llamar `rechazarSimulada` en los dos endpoints de Bitcoin. Añadir el predicado a la política del verificador. Cierra el hallazgo 5 | **M** | antes de que `PUBLIC_VERIFICATION_ENABLED` se encienda por primera vez — después es tarde por definición |
| R5 | Una llave de idempotencia HTTP: leer `Idempotency-Key`, reutilizar `services/idempotency/idempotency-store.ts` (ya existe y ya persiste), y **exigirla** en las rutas cuyo gemelo CLI declara `irreversible`/`externo`. Cierra la fila más grave del hallazgo 2 | **M** | E5.1 o tramo propio |
| R6 | Llevar `declareRisk` a la capa HTTP: un `declararRiesgoRuta(router, path, {risk})` que falle **al arrancar** si una ruta de escritura no declaró, que exija `?dry_run=` para lo irreversible y `?live=true` para lo externo, y que rechace un verbo de deshacer sin `reason`. Es la única forma de que las dos superficies no vuelvan a divergir. Cierra el resto del hallazgo 2 y el 11 | **L** | tramo nuevo — es infraestructura, no parche |
| R7 | Webhooks salientes: (a) un trabajador que lea `next_retry_at` (el índice ya existe desde la 003); (b) emitir de verdad los eventos declarados o recortar `WEBHOOK_EVENTS` a los cuatro que existen — rojos honestos > verdes falsos; (c) que `/test` use su `:id` o desaparezca. Cierra el hallazgo 7 | **M** | E-integraciones |
| R8 | Acotar por entidad las cinco rutas del hallazgo 10 con `requireByIdInScope` (el helper ya existe y ya se usa en 16 sitios) y añadir `.max()` a `bulkPreRegSchema.ids` + comprobar `rowCount` en las tres acciones del lote. Cierra los hallazgos 9 y 10 | **S** | continuación natural de la serie TEN |
| R9 | Publicar un OpenAPI **generado desde los esquemas Zod que ya existen** (no escrito a mano: uno escrito a mano se desincroniza y vuelve el problema). Unificar la forma de error de `ai-webhooks.ts`. Separar 422-entrada de 409/423-estado usando el `BLOCKED_CODES` que el CLI ya mantiene. Cierra el hallazgo 13 | **M** | E-contrato |
| R10 | `app.set('trust proxy', ...)` explícito por entorno, y acotar la etiqueta `route` de las métricas a un conjunto cerrado (o `'unmatched'` cuando no hay `req.route`). Cierra el hallazgo 12 | **S** | inmediato — dos líneas, y hoy el único freno del perímetro no autenticado es ficticio detrás de un balanceador |
| R11 | Corregir el texto de `consulta-publica.ts:5,25-26`: el rol lo crea `scripts/provision-roles.sql`, no una migración. Cierra el hallazgo 14 | **S** | con cualquiera de las anteriores |
| R12 | Decidir GraphQL de una vez. Con control de versiones ya existente (`cfe40c6` y siguientes), el argumento de «891 líneas no recuperables» de `index.ts:227-229` **ya no aplica**. O se borra, o entra bajo `/v1` con permisos, límite de profundidad y los 12 huecos del esquema tapados. Mientras siga como está, la bandera es una trampa con forma de interruptor | **S** (borrar) / **L** (arreglar) | decisión humana, no del agente |

---

**No verificado** (lo digo en vez de suponerlo): no ejecuté el servidor contra Postgres, así que los escenarios de los hallazgos 1, 5, 6, 9, 10 y 11 están razonados desde el fuente y no reproducidos de punta a punta. Los hallazgos 3, 4 y 12 **sí** están reproducidos (dos sondas de Express contra el `node_modules` del árbol y una consulta contra Postgres local). No revisé `payroll.ts` (480 líneas, 20 rutas) más allá de enumerar sus permisos, ni `blockchain.ts` (477), ni `bank-reconciliation.ts` (314): entran en la lente y quedan fuera de esta pasada.
