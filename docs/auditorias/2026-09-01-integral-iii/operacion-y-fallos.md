## LO QUE RESISTE

Auditado a favor, con la misma vara. Estas piezas aguantaron el escrutinio de modos de fallo:

1. **El reclamo atómico de trabajos es correcto de verdad.** `src/ai/jobs/job-store.ts:253-263`: el UPDATE guardado exige `enabled = true AND next_run_at <= NOW() AND next_run_at = $4` (reclamo por valor esperado), y `:256` fija el reemplazo con `GREATEST($1, date_trunc('minute', NOW()) + interval '1 minute')` — el clamp al reloj de la BASE, no al del proceso. Dos `jobs run-due` simultáneos no pueden correr el mismo trabajo ni aunque uno tenga el reloj atrasado.
2. **`recordRun` no deja que un `skipped_no_work` limpie el contador de fallos** (`src/ai/jobs/job-store.ts:334-344`): una alternancia error/vacío no evade `max_failures`. Es la clase de detalle que casi todos se comen.
3. **`safeRecord` en el tick** (`src/ai/jobs/runner.ts:103-115`): un fallo al anotar en `ai_job_runs` no tumba los trabajos restantes y viaja como `recordError` al operador.
4. **La ejecución externa ya tiene el patrón «murió a media escritura»**: reclamo atómico a `'executing'` (`src/ai/external-service.ts:278-288`) y recuperación humana explícita (`recoverExecutingOp`, `:232-247`) con las dos resoluciones bien nombradas («pudo haber aterrizado» vs «no aterrizó»). El proyecto sabe hacer esto — lo cual hace más punzante que no lo haya hecho en los otros dos sitios (H1, H2).
5. **El cortacircuitos de PAC vive en Postgres**, no en RAM (`src/services/integrations/base/circuit-breaker.ts:113-130`, tabla `provider_health`): es lo correcto para un producto de procesos cortos, y contrasta con el de IA a propósito.
6. **No hay failover de un «ya timbrado»** (`src/services/integrations/mexico/pac/pac-router.ts:167-180`) y el cerrojo antisimulación se comprueba **fuera** del `try` (`:157`), así que un adaptador simulado no entra al failover. Las dos decisiones son correctas y están argumentadas.
7. **Las migraciones son un solo acto**: el `.sql` y su anotación en `public.migrations` comparten transacción (`src/database/migrate.ts:83-94`) y el endurecimiento RLS corre en `finally` (`:102-118`).
8. **`recordDelivery` es idempotente y falla cerrado** (`src/ai/webhooks/intake.ts:236-283`): `ON CONFLICT DO NOTHING`, y si la fila previa no es visible lanza en vez de inventar un id. Además registra SIEMPRE la supresión con `logger.warn` (`:274-282`) porque la clave la controla un tercero. Es el mejor código de idempotencia del árbol — y por eso duele H1.
9. **`runWithFailover` no compra refusals ni cancelaciones** (`src/ai/providers/failover.ts:43-49`): `overflow`, `refusal`, `aborted` y `unknown` nunca hacen failover, con el razonamiento escrito. El cooldown en memoria (`:178-183`) es una decisión **declarada** y defendible para un CLI, no un descuido.
10. **Sí hay correlación de petición en la superficie HTTP**, y la auditoría II no lo dijo: `src/api/rest/middleware/correlation.ts:20-42` honra `x-request-id` de entrada, lo devuelve en la respuesta y lo mete en un `AsyncLocalStorage` que `src/utils/logger.ts:23-29` inyecta en toda línea; `enrichLogContextMiddleware` (`correlation.ts:48-56`) añade tenant/usuario/entidad tras autenticar. En producción sale JSON (`logger.ts:37-38`). Eso es observabilidad de verdad — sobre la mitad del producto que casi nadie usa (ver H2).
11. **La migración 046 cerró una carrera real con verdad de base**: `src/database/migrations/046_el_espejo_del_cfdi.sql:25-31` cambió el `UNIQUE` global de `cfdi_uuid` por `(entity_id, cfdi_uuid)` y añadió `(entity_id, xml_hash)`. Dos `ingest` concurrentes del mismo XML ya no pueden ambos registrar: el segundo choca contra el índice. La deduplicación dejó de ser sólo el `OR` del SELECT en `src/services/xml-ingestion/pre-registration-service.ts:96`.
12. **La guarda de rol que ignora RLS falla cerrado en producción** (`src/database/rls-guard.ts:63-65`), con válvula de break-glass explícita y escrita en el entorno. Excelente — hasta donde llega (H10).

---

## HALLAZGOS

### 1. [NUEVA] · **ALTA** · El canal de webhooks de entrada es una cola sin consumidor, y la clave de idempotencia se quema al recibir

Tres hechos verificados que sólo son graves juntos:

- `src/index.ts:168` monta `aiWebhooksRouter`, que es `createAiWebhooksRouter()` **sin deps** (`src/api/rest/routes/ai-webhooks.ts:143`). Con `deps.runReaderTurn` indefinido, la ruta toma siempre `return { status: 'received' }` (`:110-112`).
- **`runReaderTurn` no se construye en ningún punto del árbol.** `grep -rn "runReaderTurn" src/` da tres resultados, los tres dentro de `ai-webhooks.ts` (`:42`, `:110`, `:118`). Cero productores. Por tanto `processDelivery` (`src/ai/webhooks/reader-agent.ts:213`) sólo se invoca desde `ai-webhooks.ts:114`, rama inalcanzable en el despliegue real. Compárese con `jobs`, donde `makeRunAgentTurn` **sí** se cablea desde el CLI (`src/cli/jobs-command.ts:210-212`): esto es una omisión, no un diseño.
- **Nadie reprocesa lo recibido.** `grep -rn "'received'" src/` no muestra ningún SELECT de reproceso. `mnemosine webhooks` tiene cuatro verbos —`create`, `list`, `disable`, `deliveries` (`src/cli/webhooks-command.ts:56,91,129,153`)— y ninguno procesa. `runDoctor` (`src/ai/doctor-service.ts:42-64`) no lo mira.

Y el remate: **el reintento del emisor no puede rescatarlo**. `recordDelivery` ya insertó la fila con `UNIQUE(token_id, document_key)`, así que toda re-entrega devuelve `duplicate: true` y la ruta retorna en `:105-107` **antes** de llegar a procesar. Dos comentarios del propio código prometen lo contrario y son literalmente inalcanzables: `reader-agent.ts:240-241` («*The delivery stays 'received': a retry of the same document resumes the same transcript and can finish the job*») y `ai-webhooks.ts:120-122` («*a retry resumes the same session transcript*»). Además `markDeliveryOutcome` exige `status = 'received'` (`intake.ts:298`), así que la fila tampoco puede marcarse rechazada.

**Escenario de fallo:** el banco notifica un cargo al token de un cliente. mnemosine responde HTTP 200 `{"status":"received"}`. Nadie despierta al lector, nunca. El banco reintenta según su política; cada reintento recibe 200 `{"status":"duplicate"}`. El movimiento no llega jamás al mayor, el operador no recibe ninguna señal, y la fila queda en `ai_webhook_deliveries` con `status='received'` sin ruta de salida.

*Nota de instrumento:* `src/ai/orphan-scan.ts:19-20` define huérfana como «*la LEE y NADIE la escribe*». Aquí la tabla se escribe **y se lee** (el listado de `webhooks deliveries`), así que ni la definición actual ni la inversa que la II propuso (escrita y nunca leída) atrapan este caso. El instrumento que faltaría es «tipo exportado con cero productores» / «rama inalcanzable en el cableado por omisión».

---

### 2. [NUEVA] · **ALTA** · Un `ingest` que muere a media corrida no deja ningún rastro — y sus posteos sí quedan

Responde directo a «¿qué pasó con la ingesta de anoche?»: **sólo si la corrida terminó.**

- `src/cli/mnemosine.ts:1275-1279`: `registrarCorridaIngesta` se llama **después** de que `ingestCfdiFiles` retorna. Si el proceso muere antes, no hay fila en `ai_ingest_runs`.
- Los efectos ya ocurrieron por archivo: `src/ai/ingest-service.ts:113-116` es un bucle secuencial y cada `ingestOne` registra, clasifica y, con auto-posteo encendido, **postea** con efecto propio.
- **El CLI no escribe bitácora.** `grep -rn "utils/logger" src/cli/` → 0 resultados (5 imports en todo `src/`). `src/utils/logger.ts:50`: sólo `winston.transports.Console()`, sin transporte a archivo. El resumen de la corrida sale por `console.log` (`mnemosine.ts:1313-1318`).

**Escenario de fallo:** cron de las 03:00, 2 000 CFDI. Al archivo 1 500 el contenedor recibe SIGTERM por un despliegue (o el OOM killer entra). Quedan ~1 500 documentos registrados y sus asientos posteados; cero filas en `ai_ingest_runs`; cero líneas en disco. A la mañana siguiente el contador ve asientos nuevos en el mayor y no existe ningún registro que diga qué corrida los produjo, con qué modelo, con qué umbrales ni cuántos quedaron sin procesar. El diseño correcto ya existe a tres archivos de distancia (`ai_external_ops` abre en `'executing'` antes de actuar); aquí la fila se abre al final o no se abre.

---

### 3. [NUEVA] · **ALTA** · Los reintentos de webhook de salida son cosméticos: `next_retry_at` se escribe y nadie lo lee

- `src/services/webhooks/webhook-service.ts:161-174` calcula backoff exponencial (`retryInterval * 2^(n-1)`), deja `status='pending'` y guarda `next_retry_at`.
- La infraestructura para el consumidor existe: `src/database/migrations/003_banking_assets_inventory.sql:316` crea `idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at) WHERE status = 'pending'`.
- **No hay consumidor.** `grep -rn "next_retry_at" src/` da 6 resultados: dos declaraciones de tabla, una de tipo, el `UPDATE` que lo escribe (`webhook-service.ts:171`) y nada más. Ningún `SELECT`. El único camino de reenvío es `retryDelivery(deliveryId, tenantId)` (`webhook-service.ts:177`): **manual y por id**.
- El fallo se anuncia con `console.error` desde un fire-and-forget (`webhook-service.ts:95-98`), cuyo propio comentario dice «*in production use BullMQ*». `bullmq` está en `package.json:31` y no se importa en `src/`.

**Escenario de fallo:** el endpoint del cliente devuelve 502 durante los cinco minutos de un despliegue suyo. mnemosine marca la entrega `pending` con `next_retry_at = ahora+60s`. Nadie la vuelve a mirar. El cliente nunca recibe el evento `invoice.posted`; el operador sólo lo descubre si corre `mnemosine webhooks deliveries --status pending` para cada suscripción, porque no hay alerta ni check.

---

### 4. [NUEVA] · **MEDIA-ALTA** · Nada vigila las tres cosas que se apagan solas de noche

El sistema **tiene** los datos de fallo y **no tiene** ningún camino que los suba a la superficie:

- **Trabajo auto-desactivado.** `src/ai/jobs/job-store.ts:316-326` apaga el job al llegar a `max_failures` (3 por omisión, `:173`). El aviso se imprime al **stdout del proceso de cron** (`src/cli/jobs-command.ts:221-223`), que nadie lee, y —por el hallazgo 2— tampoco queda en disco.
- **Operación varada en `'executing'`.** El propio código documenta que hace falta recuperación humana (`src/ai/external-service.ts:223-231`), pero `checkPendingWork` cuenta sólo `status = 'pending'` (`src/ai/doctor-service.ts:501-506`): una op varada es invisible para el doctor.
- **Entrega de webhook detenida** (`pending` de salida, `received` de entrada): ningún check.

Ninguno de los tres aparece en `runDoctor` (`src/ai/doctor-service.ts:42-64`, las catorce comprobaciones cableadas).

Agrava: **el tick es por entidad.** `claimDueJobs` filtra `WHERE entity_id = $1` (`job-store.ts:238`) y `jobs run-due` resuelve una sola entidad. Un despacho con 50 clientes necesita 50 líneas de crontab y, para saber cuál se apagó, 50 invocaciones de `mnemosine jobs list`.

**Escenario de fallo:** el trabajo `cfdi_reconciliation` de un cliente falla tres noches seguidas porque su credencial fiscal venció. A la cuarta noche el trabajo está desactivado. El único rastro es `enabled = false` en una fila de `ai_jobs` de una entidad entre cincuenta. La conciliación deja de correr y nadie se entera hasta el cierre mensual.

---

### 5. [II-SIGUE-VIVA] · **MEDIA-ALTA** · El DML de migración bajo RLS forzada: sigue sin guarda, y la configuración empuja al rol equivocado

La II probó empíricamente que el mismo `UPDATE` rellena cero filas sin contexto de inquilino. **En `cfe40c6`+2 no se añadió ninguna guarda**, y le aporto el mecanismo que la II no nombró:

- `src/database/migrate.ts` no consulta `pg_roles` ni verifica nada del rol: no hay un solo `assert` sobre quién conecta. La única verificación del árbol (`verificarRolSujetoARls`) no se importa aquí.
- **La configuración empuja al rol equivocado por omisión:** `src/config/index.ts:48-51` resuelve `migrationUrl` como `MIGRATION_DATABASE_URL || DATABASE_URL || postgresql://postgres:postgres@localhost:5432/...`. Omitir esa variable —y `.env.example` la documenta, pero nada la exige— hace que las migraciones corran **como el rol de la aplicación**, que es exactamente el rol con `FORCE ROW LEVEL SECURITY`.
- Siguen vivas dos migraciones con `UPDATE` de relleno sobre tablas de inquilino: `037_etiquetado_que_encarece.sql:48` (`bills`), `:77` (`vendors`), `:86` (`customers`); y `040_el_secreto_que_el_compromiso_revelaba.sql:26,31` (`blockchain_attestations`) — que es una **purga de material de prueba**.

**Escenario de fallo:** despliegue con una sola variable de base de datos. `npm run migrate` sale 0, `public.migrations` anota las 52 y el operador cree tener la purga aplicada. La 040 no purgó nada, y no hay forma de saberlo salvo consultando a mano.

---

### 6. [NUEVA] · **MEDIA-ALTA** · Cero límites de tiempo: ni en el pool, ni en las consultas, ni en el PAC

`grep -rn "statement_timeout\|connectionTimeoutMillis\|idleTimeoutMillis\|lock_timeout\|query_timeout" src/` → **0 resultados**.

- `src/database/connection.ts:54-59` construye el `Pool` con `connectionString`, `min`, `max` y `ssl` — nada más. El valor por omisión de `connectionTimeoutMillis` en `pg` es «esperar indefinidamente».
- `src/services/integrations/mexico/pac/sovos-reachcore-adapter.ts:105`: `await fetch(url, init)` **sin `AbortSignal`**. El único `fetch` con plazo en todo el árbol es `src/services/webhooks/webhook-service.ts:130` (`AbortSignal.timeout(30000)`).
- `src/services/sat/cfdi-status.ts:98` sí envuelve con `withRetry` (lectura, idempotente — correcto), pero tampoco pone plazo a cada intento.

**Escenario de fallo:** el proveedor gestionado de Postgres hace failover; el socket se acepta y no responde. `mnemosine jobs run-due` de las 04:00 se queda colgado en `pool.connect()`. No termina, no devuelve código de salida, no escribe log (hallazgo 2). El tick de las 05:00 arranca otro proceso que hace lo mismo. El contrato de trece códigos de salida de `src/cli/kernel/exit.ts:19-46` —la mejor pieza operativa del repositorio— nunca llega a usarse porque el proceso no termina. Lo mismo con un PAC que acepta la conexión SOAP y no contesta: el timbrado se cuelga y arrastra una conexión del pool con él.

---

### 7. [NUEVA] · **MEDIA** · `getRedis()` nunca devuelve `null`: con Redis caído construye un cliente nuevo en cada llamada

`src/services/cache/redis.ts:6-27`. La firma es `getRedis(): Redis` y la última línea es `return redis!` (`:26`). La anulación `redis = null` (`:23`) ocurre dentro del `.catch()` **asíncrono** de `connect()`, es decir después del `return`.

Consecuencia: cuando Redis está caído, la siguiente llamada vuelve a entrar en `if (!redis)` (`:7`) y construye **otro** `new Redis(...)` con su `retryStrategy` de hasta 3 intentos (`:9-13`), sin cerrar el anterior. Eso pasa en cada `getCachedAccounts`, cada `getCachedReport`, cada `checkRateLimit` — es decir, en cada petición HTTP y en cada reporte.

Y las **doce** guardas `if (!r) return ...` del archivo (`:42`, `:51`, `:60`, `:72`, `:82`, `:94`, `:104`, `:118`, `:139`, `:148`, y `:217`) son código muerto por la misma razón. El archivo lo admite explícitamente para **una** de ellas (`:206-210`); las otras once no lo dicen y se leen como defensas activas.

**Escenario de fallo:** Redis se cae a las 02:00. La API sigue sirviendo (bien, el degradado a contador local funciona), pero cada petición paga la construcción de un cliente ioredis y su ciclo de reintentos antes de que el `catch` lo trague. La latencia sube sin que ninguna métrica lo explique, porque los `catch { }` no cuentan nada (`:45`, `:54`, `:62`…).

---

### 8. [II-EXAGERADA] · **MEDIA** · El aviso operativo del limitador contradice el código que cita — y la auditoría II lo repitió como hecho

- `src/api/rest/middleware/rate-limiter.ts:26-30` dice: «*sin Redis configurado, checkRateLimit deja pasar todo por decisión explícita (ver services/cache/redis.ts)*».
- `src/services/cache/redis.ts:217` hace lo contrario: `if (!r) return limiteEnMemoria(key, windowMs, maxRequests);`, y `:197-216` declara en mayúsculas «SIN REDIS TAMPOCO HAY BARRA LIBRE».

La II tomó ese aviso al pie de la letra en su fortaleza F10 (`docs/auditorias/2026-09-01-integral-ii/producto-y-operacion.md:25`: «*"sin Redis configurado" sigue siendo pasar todo, y se dice en el aviso operativo de src/api/rest/middleware/rate-limiter.ts:26-30*»). **Es prosa caducada, no conducta**: midió un comentario, no el código. El núcleo de F10 (Redis caído ya no es fail-open) sigue siendo cierto; la mitad que cita el aviso es falsa.

Lo que **sí** queda abierto en esa ruta: `rate-limiter.ts:60`, `.catch(() => next())`. Cualquier excepción inesperada del limitador —por ejemplo un `REDIS_URL` malformado que haga lanzar al constructor de ioredis dentro de `getRedis()`, antes del `try` de `checkRateLimit`— **concede la petición**. Es el único fail-open que queda en la ruta, y pesa más desde que `/public/v1` sirve sin credenciales.

---

### 9. [NUEVA] · **MEDIA** · El failover del proveedor de modelo puede duplicar el efecto de la primera vuelta

`src/ai/providers/index.ts:207-226`: `firstTurn` mete **construcción de sesión + `session.runTurn(userInput)`** en un solo `attemptFn` de `runWithFailover`. Un error elegible (`rate_limit`, `timeout`, `server`) que llegue en la segunda vuelta del turno —cuando una herramienta con efecto ya corrió— construye una sesión nueva contra otro proveedor y **re-ejecuta el mismo prompt**.

`ai_drafts` no tiene unicidad por origen: la única guarda es `src/database/migrations/012_ai_drafts_unique_source.sql:8`, un índice sobre `journal_entries(source_id) WHERE source_type = 'ai_draft'` — impide que **un** borrador produzca dos asientos, no que un CFDI produzca **dos** borradores.

**Alcance, y hay que decirlo honestamente:** sólo el primer turno de una sesión (`index.ts:233-236` no vuelve a caminar la cadena una vez viva), y en `ingest` la sesión es una para toda la corrida, así que el riesgo se acota al **primer archivo**. Además el auto-posteo toma `drafts[drafts.length - 1]` (`src/ai/ingest-service.ts:224`), así que se postea uno solo.

**Escenario de fallo:** primer CFDI de la corrida nocturna. El proveedor primario devuelve 429 tras la ronda en que el modelo ya llamó a `draft_journal_entry`. Failover a Ollama; el turno se repite; el mismo CFDI queda con dos borradores pendientes. Uno se postea, el otro se queda en `mnemosine review` como trabajo fantasma, y el contador no tiene forma de saber cuál es cuál.

---

### 10. [NUEVA] · **MEDIA** · La guarda de rol que ignora RLS sólo cubre el servidor HTTP; el CLI —que es el producto— no la llama

`grep -rn "verificarRolSujetoARls" src/` da cuatro resultados: la definición (`src/database/rls-guard.ts:40`), el import y la llamada en `src/index.ts:9,51`, y `src/plan/criterios.ts:1415`. **Ningún archivo de `src/cli/`.**

Y el criterio del tablero comprueba exactamente esa línea: `/verificarRolSujetoARls/.test(codigoDe('src/index.ts'))` (`criterios.ts:1415`). Verde mientras el CLI siga sin la guarda — un ejemplar nuevo y concreto del vicio que la II diagnosticó en general.

La cobertura del CLI es `doctor` → `checkTenantIsolation` (`src/ai/doctor-service.ts:486-493`), que devuelve **`warn`**, y `doctor` sale 1 sólo con `fail` (`src/cli/doctor-command.ts:53-54`). Es decir: en el servidor **no arranca**; en el CLI **ni siquiera rompe un pipeline**.

**Escenario de fallo:** el cron corre `mnemosine ingest` con `DATABASE_URL` apuntando al rol `postgres` (que es el valor por omisión de `src/config/index.ts:43`). RLS queda inerte para toda la corrida: cualquier consulta que olvide filtrar por entidad devuelve las filas de los 50 clientes en vez de ninguna, y nada lo dice. El mismo despliegue, por HTTP, no habría arrancado.

---

### 11. [NUEVA] · **MEDIA** · 63 variables de entorno en el código, 15 en `.env.example` — y las que faltan son las que cambian la postura

Medido: `grep -rho "process\.env\.[A-Z_][A-Z0-9_]*" src/ scripts/ | sort -u` → **69**; menos seis ambientales (`USER`, `USERNAME`, `HOSTNAME`, `TERM_SESSION_ID`, `TMUX_PANE`, `NO_COLOR`) → **63 del producto**. `.env.example` documenta **15**.

Entre las 48 sin documentar:
- `ALLOW_RLS_BYPASS_ROLE` — apaga la guarda del hallazgo 10 (`src/database/rls-guard.ts:62`).
- `CFDI_PERMITIR_SIMULACION` — permite persistir folios fabricados fuera de producción (`src/services/integrations/mexico/pac/simulacion.ts:37`).
- `PUBLIC_VERIFICATION_ENABLED` — monta un router **sin credenciales** (`src/index.ts:152`).
- `ALLOWED_ORIGINS` — única forma de que CORS funcione en producción (`src/index.ts:92`); sin ella, ningún origen cruzado.
- `GRAPHQL_ENABLED`, `DATABASE_SSL_MODE`, `DATABASE_SSL_CA`, `WEBHOOK_MAX_RETRIES`, `RATE_LIMIT_*`, `SAT_STATUS_MODE`, `PAC_*`.
- `VAULT_BACKEND`, `VAULT_PREFIX`, `VAULT_KMS_KEY_ID`, `VAULT_DIR` (`src/services/vault/index.ts:33-54`) — es decir, **dónde vive el material que una restauración necesitaría**, indocumentado justo en el producto que la II probó que no tiene restauración.

Y el único arranque que se niega —el de secretos publicados, `src/config/index.ts:225-234`— se dispara con `config.env !== 'production'` → `return []` (`:204`). Es decir, la puerta cuelga de `NODE_ENV`, **la variable que un despliegue olvida**. Sin `NODE_ENV=production`, `JWT_SECRET = 'dev-secret-change-me'` y `ENCRYPTION_KEY` de 64 ceros arrancan en silencio, y `verificarRolSujetoARls` degrada a `warn` por la misma razón (`rls-guard.ts:63`).

**Escenario de fallo:** el operador despliega con `DATABASE_URL`, `JWT_SECRET` y `ENCRYPTION_KEY` puestos, tal como dice `.env.example`, y olvida `NODE_ENV`. Arranca con CORS abierto a todo origen (`index.ts:94`, rama `: true`), con el vault local en disco en vez de Secrets Manager (`vault/index.ts:33`, el fallback a `'local-dev'`), y sin ninguna de las dos negativas de arranque. Ningún mensaje lo advierte.

---

### 12. [NUEVA] · **MEDIA** · Un fallo del PAC primario se reporta con el mensaje equivocado

En producción **sólo Sovos puede timbrar**: `simulado = false` (`src/services/integrations/mexico/pac/sovos-reachcore-adapter.ts:128`) frente a `simulado = true` en `finkok-adapter.ts:27`, `sw-sapien-adapter.ts:27` y `edicom-adapter.ts:26`.

Pero `savePreferences` rellena secundario y terciario con `sw_sapien`/`edicom` **aunque el operador sólo fije el primario** (`pac-router.ts:76-78`), y `auto_failover` es `true` por omisión (`:79`). Y `assertPuedeTimbrar` está **fuera** del `try` (`:157`), así que lanza y sale del bucle sin pasar por el `catch`.

**Escenario de fallo:** Sovos devuelve un 503. El bucle anota el fallo en `errors` (`:185`), incrementa el contador de Prometheus (`:186`) y pasa al segundo candidato. En `sw_sapien`, `assertPuedeTimbrar` lanza `PAC_SIMULADO` y esa excepción sale de `stamp()`. El contador lee «*El proveedor de timbrado "sw_sapien" es una simulación*» y va a revisar una configuración que está bien. La causa real —Sovos caído— murió en un array local (`:146`) que nunca se lanza porque la ruta a `ALL_PACS_FAILED` (`:192-196`) no se alcanza.

---

### 13. [NUEVA] · **BAJA-MEDIA** · La guarda de «ya timbrado» la implementa uno de cuatro adaptadores

`pac-router.ts:167-180` argumenta, con razón y por extenso, que no hay que hacer failover de un «ya timbrado», y afirma que «*esa respuesta es idéntica en todos los proveedores, no una peculiaridad de uno*». Verificado: `PAC_YA_TIMBRADO` aparece **dos veces** en todo el árbol — la comprobación (`:177`) y su **único** emisor, `sovos-reachcore-adapter.ts:284` (código `311`, declarado en `:91`). Ni `finkok`, ni `sw_sapien`, ni `edicom` lo producen.

Hoy no es explotable, y hay que decirlo: los otros tres son simulados y el hallazgo 12 muestra que el failover muere antes de llegar a timbrar. **Es una defensa que hoy depende de una coincidencia, no del diseño.** El día que entre un segundo adaptador real —que es justamente lo que el plan quiere— un timeout del primario hace failover y el mismo comprobante puede salir con dos folios fiscales, y el segundo no se cancela sin dejar huérfano al primero.

**Falsable:** si `finkok-adapter.ts`, `sw-sapien-adapter.ts` o `edicom-adapter.ts` mapearan su código de duplicado a `PAC_YA_TIMBRADO`, este hallazgo cae.

---

### 14. [NUEVA] · **BAJA** · `/ready` publica el mensaje de error de Postgres sin autenticación

`src/index.ts:127-133`: ante un fallo de conexión responde 503 con `error: err instanceof Error ? err.message : String(err)`. Un fallo de autenticación devuelve el nombre del rol (`password authentication failed for user "mnemosine_app"`); uno de resolución devuelve el host de la base. La ruta va antes de `authenticate` a propósito, como sonda de k8s — y el 503 solo ya es todo lo que una sonda necesita.

---

### 15. [NUEVA] · **BAJA** · `withTransaction` puede reemplazar la causa real por el error del ROLLBACK

`src/database/connection.ts:191`: `await client.query('ROLLBACK');` **sin guarda**, mientras que la función hermana `query()` sí la lleva dos bloques más arriba (`:168`, `.catch(() => undefined)`).

**Escenario de fallo:** la conexión se corta a media transacción de posteo. `fn` lanza el error real; el `catch` intenta el ROLLBACK sobre un socket muerto, ése lanza, y es **el error del ROLLBACK** el que se propaga. El contador ve `Connection terminated unexpectedly` y el fallo original se pierde. La asimetría entre las dos funciones parece un olvido: `query()` ya aprendió la lección.

---

### 16. [NUEVA] · **BAJA** · El Dockerfile de producción corre como root y sin comprobación de salud

`docker/Dockerfile:17-29`: la etapa de producción no declara `USER` (corre como root), no declara `HEALTHCHECK`, y usa `npm install --omit=dev` (`:22`) en vez de `npm ci` — esto último ya lo dijo la II. El contraste está en el mismo directorio: `docker/docker-compose.yml:34-38` y `:46-49` sí declaran healthcheck para postgres y redis; el servicio `app` no tiene ninguno, aunque `/live` y `/ready` existen y están bien hechos (`src/index.ts:121-134`).

---

## DICTAMEN SOBRE LA AUDITORÍA II (lo que toca a este lente)

| Hallazgo II | Veredicto | Evidencia en `cfe40c6`+2 |
|---|---|---|
| Brecha 1 — cero respaldo/restauración | **SIGUE VIVA** | `grep -rn "pg_dump\|pg_restore\|pgbackrest\|wal-g" src/ scripts/ docker/ .github/` → **0**. No lo re-reporto. |
| Brecha 2 — sin despliegue; el compose migra mal | **SIGUE VIVA** | `docker/docker-compose.yml:36` sigue montando `../src/database/migrations:/docker-entrypoint-initdb.d`. Añado el 16. |
| Brecha 3 — cero rollback de esquema | **SIGUE VIVA** | 52 migraciones, `ls | grep -ci "down\|revert\|rollback"` → 0; `runMigrationsDown`/`--to` → 0 en `migrate.ts`. |
| Brecha 6 — observabilidad | **SIGUE VIVA, parcialmente EXAGERADA** | Ciertos: winston sólo a consola (`logger.ts:50`) y CLI sin logger (0 imports en `src/cli/`). **Omitió que sí hay correlación completa de petición** por ALS (`correlation.ts:20-42`, `logger.ts:16-29`) con JSON en producción. La brecha no es «no hay observabilidad»: es que **toda está en la mitad HTTP y el producto es CLI** (hallazgo 2). |
| Brecha 16 — `/metrics` sin auth | **SIGUE VIVA** | `src/index.ts:114-115`. Añado el 14: `/ready` filtra además el mensaje de la base. |
| Tema 3 — DML de migración bajo RLS | **SIGUE VIVA** | Hallazgo 5: sin guarda en `migrate.ts`, con el mecanismo de `config/index.ts:48-51` que la II no nombró. |
| PAC real inalcanzable (`practicas-fiscal-mx`) | **SIGUE VIVA, con matiz** | `integrationRegistry.register` cubre `finkok`/`sw_sapien`/`edicom` (`pac-router.ts:21-23`) y **no** a Sovos. Matiz: el bloqueo es en `configure()`/`selectPac` (que pasan por el registro), **no** en `stamp()`, que resuelve por `PAC_ADAPTERS` (`:25-30`, Sovos incluido) y carga credenciales por consulta directa (`registry.ts:94-110`). Con una fila en `integration_credentials`, Sovos timbra hoy. |
| Fortaleza F10 — «sin Redis se pasa todo, y se dice en el aviso» | **EXAGERADA / mal medida** | Hallazgo 8: `redis.ts:217` hace lo contrario de lo que el aviso citado afirma. |

**Ninguna de las brechas de la II que toca este lente se cerró con los PRs fusionados.**

---

## RECOMENDACIONES

### Trabajo de plan (tiene o debería tener fila de catálogo)

1. **(S · urgente) Cablear o retirar el lector de webhooks de entrada.** Hoy `createAiWebhooksRouter()` se monta sin `runReaderTurn` (`src/index.ts:168`, `ai-webhooks.ts:143`) y ese tipo no tiene ni un productor. Dos salidas honestas: (a) construir el `makeRunReaderTurn` como ya se hace para `jobs` (`jobs-command.ts:210`), o (b) **desmontar la ruta** hasta que exista. Un endpoint que devuelve 200 y quema la clave de idempotencia es peor que un 501. *Tramo: E5.1 / continuación de F02.* (Hallazgo 1.)
2. **(S) `mnemosine webhooks process` — y separar «recibida» de «pendiente de proceso».** Mientras (a) no llegue, hace falta un verbo que lea `ai_webhook_deliveries` en `status='received'` y la corra; y `recordDelivery` debe devolver la fila previa **sin** marcarla `duplicate` cuando siga en `'received'`, para que el reintento del emisor pueda terminar el trabajo que los comentarios de `reader-agent.ts:240` y `ai-webhooks.ts:120` ya prometen. *Tramo: mismo.* (Hallazgo 1.)
3. **(S) Abrir la fila de `ai_ingest_runs` ANTES del bucle, no después.** El patrón correcto ya está en el repositorio: `ai_external_ops` abre en `'executing'` y `recoverExecutingOp` cierra a mano (`external-service.ts:232-247`). `mnemosine.ts:1275` debe insertar en `'running'` antes de `ingestCfdiFiles` y cerrar al terminar; una corrida que quede en `'running'` es la señal de que alguien murió a media noche. *Tramo: E1.2.* (Hallazgo 2.)
4. **(S) Un worker de reenvío para `webhook_deliveries`, o quitar el backoff que no existe.** El índice parcial ya está (`003:316`). El sitio natural es un `JobKind` determinista más en `runDueJobs`, sin LLM — exactamente lo que `docs/plan-cierre-brechas.md:6003-6007` propone para las descargas del SAT. Alternativa honesta: borrar el cálculo de `next_retry_at` (`webhook-service.ts:167-170`) y decir en la CLI que el reenvío es manual. *Tramo: E4.2.* (Hallazgo 3.)
5. **(S) Cuatro checks nuevos en `doctor`:** trabajos con `enabled = false` y `consecutive_failures >= max_failures`; ops en `'executing'` más viejas que N minutos; entregas de salida en `'pending'` con `next_retry_at` vencido; entregas de entrada en `'received'` más viejas que N minutos. Los cuatro son `warn`, no `fail`, salvo el segundo. *Tramo: E0.1.* (Hallazgo 4.)
6. **(M) `mnemosine jobs run-due --all-entities`.** Levantar el `WHERE entity_id = $1` de `claimDueJobs` (`job-store.ts:238`) y ciclar por entidad dentro de una sola invocación. Es la misma dimensión ausente que la II nombró como «vista de despacho», aquí en la superficie desatendida: 50 líneas de crontab no son un producto. *Tramo: E4.2.* (Hallazgo 4.)
7. **(S) Guarda de rol en `migrate.ts`.** Antes del bucle: `SELECT current_user, rolsuper OR rolbypassrls` y, si el rol **está sujeto a RLS**, negarse con el mensaje que nombre `MIGRATION_DATABASE_URL`. Es la simétrica exacta de `verificarRolSujetoARls` y cierra el tema 3 de la II en una función. *Tramo: E0.1.* (Hallazgo 5.)
8. **(S) Llamar `verificarRolSujetoARls` desde el arranque del CLI**, y cambiar el criterio `criterios.ts:1415` para que exija el cableado en **ambas** entradas — o mejor, verificarlo por mutación en vez de por regex sobre `src/index.ts`. *Tramo: E0.1 / E5.1.* (Hallazgo 10.)
9. **(S) Plazos en todo lo que sale del proceso.** `connectionTimeoutMillis` e `idleTimeoutMillis` en el `Pool` (`connection.ts:54`), `statement_timeout` por sesión, y `AbortSignal.timeout(...)` en `transporteFetch` (`sovos-reachcore-adapter.ts:105`) copiando lo que `webhook-service.ts:130` ya hace bien. Sin esto el contrato de `exit.ts` no se puede cumplir. *Tramo: E0.1.* (Hallazgo 6.)
10. **(S) Arreglar `getRedis()`**: devolver `Redis | null` de verdad (marcar el cliente como inservible en el `.catch()` y no reconstruirlo en cada llamada, con reintento espaciado), y **borrar o activar** las once guardas muertas. De paso, sustituir `.catch(() => next())` (`rate-limiter.ts:60`) por una degradación explícita a `limiteEnMemoria`, para que no quede ni un fail-open. Y **actualizar el aviso de `rate-limiter.ts:26-30`, que hoy miente**. (Hallazgos 7 y 8.)
11. **(M) Idempotencia del primer turno con failover.** O bien acotar `runWithFailover` a la **construcción** de la sesión y la primera llamada de red, no al turno completo (`providers/index.ts:220-221`), o bien darle a `ai_drafts` unicidad por origen `(entity_id, source_type, source_id)` para que la repetición choque contra la base en vez de duplicar. *Tramo: E5.1.* (Hallazgo 9.)
12. **(S) Que el failover de PAC no se coma la causa.** Mover `assertPuedeTimbrar` **dentro** del `try` de `pac-router.ts:159` para que un proveedor simulado sea un candidato descartado más y el `ALL_PACS_FAILED` (`:192`) llegue con los errores reales; y que `savePreferences` (`:76-78`) no rellene secundario/terciario con simulados por omisión. (Hallazgo 12.)
13. **(S) `PAC_YA_TIMBRADO` en los cuatro adaptadores**, o un comentario en `pac-router.ts:167-180` que diga la verdad: hoy la defensa la implementa uno. (Hallazgo 13.)
14. **(S) `/ready` devuelve 503 y nada más** (`index.ts:130-133`); el detalle va al `logger`, que ya lleva `request_id`. Y guardar `.catch(() => undefined)` en el ROLLBACK de `withTransaction` (`connection.ts:191`), como ya hace `query()` (`:168`). (Hallazgos 14 y 15.)

### Trabajo de operación (no lleva fila de catálogo)

15. **(S · el más barato de todos) Completar `.env.example`.** 63 variables en el código, 15 documentadas. Empezar por las cinco que cambian la postura de seguridad —`ALLOW_RLS_BYPASS_ROLE`, `CFDI_PERMITIR_SIMULACION`, `PUBLIC_VERIFICATION_ENABLED`, `ALLOWED_ORIGINS`, `GRAPHQL_ENABLED`— y las cuatro del vault, que son las que una restauración necesita. Media hora de trabajo. (Hallazgo 11.)
16. **(S) No colgar la seguridad de `NODE_ENV`.** `insecureProductionSecrets` (`config/index.ts:199-223`) y `verificarRolSujetoARls` (`rls-guard.ts:63`) dependen ambas de una variable que un despliegue olvida. Mínimo: si `NODE_ENV` no está fijada **y** `DATABASE_URL` no apunta a `localhost`, tratarlo como producción o negarse a arrancar sin una declaración explícita. (Hallazgo 11.)
17. **(S) Transporte de archivo en winston y logger en el CLI.** `logger.ts:50` sólo tiene consola y `src/cli/` no importa el logger. Un `ingest`/`jobs run-due` desatendido debe dejar en disco su id de corrida, su entidad y su desenlace — hoy el `request_id` que `correlation.ts` construye tan bien no existe para el 100 % de las corridas nocturnas. (Hallazgo 2.)
18. **(S) `USER node` y `HEALTHCHECK` en `docker/Dockerfile`**, apuntando a `/ready`, que ya existe y hace lo correcto. (Hallazgo 16.)
19. **(M) Reglas de alerta que existan como YAML en el repositorio**, sobre las señales que este lente encontró huérfanas: trabajos auto-desactivados, ops en `'executing'`, entregas detenidas, y —lo primero— **`ai_ingest_runs` sin fila en las últimas 24 h cuando hay un cron declarado**. Hoy `/metrics` sólo conoce lo que pasa por HTTP y el producto es CLI.
