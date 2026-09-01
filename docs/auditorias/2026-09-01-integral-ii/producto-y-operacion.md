> **Nota sobre el HEAD.** El contexto de la tarea fijaba HEAD = `a149e62`. Durante esta auditoría el árbol se movió por trabajo concurrente (`6e280dd`, luego `1ff9ca8` "A3-A4"). Toda la evidencia de abajo se leyó del árbol de trabajo durante la sesión; las afirmaciones sensibles se contrastaron además con `git show HEAD:` y se indica cuando así fue. Las ausencias estructurales (respaldo, despliegue, alertas) son estables: se verificaron por búsqueda exhaustiva, no por lectura de un commit.

---

## FORTALEZAS

**F1. El contrato de códigos de salida es de calidad de producto.** `src/cli/kernel/exit.ts:19-46` publica 13 códigos con semántica operativa real: `4` = "encontré algo" separado de "no pude mirar" (comentario en `:14-16`), `11 NEEDS_HUMAN` = "no falló, está esperando", `8 EXTERNAL_FAILED` (reintentable) separado de `9 EXTERNAL_REJECTED` (SAT 5002 — "reintentar quema el presupuesto de solicitudes de ese periodo para siempre", `:36-39`). Eso es lo que permite meter mnemosine en un runner de tareas sin envolverlo en heurística de texto. Muy pocos productos maduros tienen esto.

**F2. Las migraciones son transaccionales y numeradas con guarda.** `src/database/migrate.ts:83-94` envuelve el `.sql` y su anotación en `public.migrations` en **una** transacción (el comentario `:77-82` explica la fuga que eso cerró: migración aplicada y sin registrar). `assertNumeracionUnica` (`:21-41`) impide duplicados nuevos y tolera los cuatro históricos declarados (`:19`). El endurecimiento RLS corre en `finally` (`:102-118`) — un fallo a mitad no deja tablas sin política.

**F3. CI real con cinco puertas, incluida una que corre como `mnemosine_app`.** `.github/workflows/ci.yml`: tipos (`:33`), unitarias + cobertura (`:46`), trinquete del plan y del catálogo (`:61-102`), integración contra Postgres (`:104`) y **aislamiento por inquilino conectando con el rol sin BYPASSRLS** (`:135-184`, con `provision-roles.sql` como paso previo porque los roles son de clúster). El job de aislamiento es el que casi nadie tiene.

**F4. El presupuesto del agente existe, es opt-in y corta donde nace toda sesión.** `src/ai/budget.ts:168-196` (`assertWithinBudget`) invocado desde el único punto de creación de sesión, `src/ai/providers/index.ts:77`, con guardián que recalcula a mitad de sesión (`budget.ts:129-162`). Fallo al medir con `on_exceed=block` → no arranca (`:182-187`): un tope que no puede medirse no finge que midió. Un criterio del tablero vigila el cableado (`src/plan/criterios.ts:2193`).

**F5. `ai stats` ya responde el costo por borrador y la tasa de intervención humana.** `src/ai/stats-service.ts:140-200`: `costo_por_borrador_usd`, `tasa_intervencion_humana`, `duracion_promedio_ms` / `duracion_p95_ms`, y los eventos `sospecha|nudge|failover`. La 044 (`src/database/migrations/044_el_agente_medible.sql:26-68`) le dio tabla a lo que antes moría en stderr.

**F6. La bitácora ya no guarda en claro lo que las tablas cifran.** `src/api/rest/middleware/audit.ts:20-40`: lista de 20 campos sensibles redactados a cualquier profundidad antes del `JSON.stringify`, con criterio E0.3 vigilando que el crudo no vuelva.

**F7. El doctor es un diagnóstico serio, no un `ping`.** `src/ai/doctor-service.ts` (902 líneas, ~16 comprobaciones): base, migraciones pendientes contra el directorio (`:88-112`), roles de cuenta, transporte de conexión, aislamiento, credenciales fiscales por vencer, proveedor de modelo, llave de cifrado, integridad del mayor (`:777`), periodos reabiertos (`:833`), segregación de funciones (`:875`), capacidad huérfana (`:689`). Y sale 1 sólo con `fail`, nunca con `warn` (`src/cli/doctor-command.ts:53-54`) — un `warn` no rompe un pipeline.

**F8. El costo de construcción dejó de ser una medición de una sola vez.** `scripts/costo-por-fila.ts:1-30` recalcula líneas/fila y cola correctiva desde el historial de git y los deltas del suelo del catálogo, y declara sus propios límites en el encabezado.

**F9. El refresco de las vistas materializadas salió del camino de posteo.** `src/database/migrations/042_el_refresco_sale_del_posteo.sql:25-26` elimina el trigger que hacía que **cada posteo pagara un refresco proporcional a la instalación entera** y serializaba posteos de inquilinos distintos. Es la corrección de escala más importante que se ha hecho.

**F10. Redis caído ya no es fail-open silencioso.** `src/services/cache/redis.ts:154-185`: contador local en memoria como degradación cuando Redis se cae (peor que Redis, pero límite de verdad); "sin Redis configurado" sigue siendo pasar todo, y se dice en el aviso operativo de `src/api/rest/middleware/rate-limiter.ts:26-30`.

**F11. La gobernanza del repositorio existe.** `SECURITY.md` (reporte, prioridad, alcance, divulgación), `CONTRIBUTING.md:20-74` (las puertas en el orden en que fallan más barato), `LICENSE` Apache 2.0, `.github/CODEOWNERS`, `dependabot.yml`, plantillas de issue y PR.

---

## BRECHAS

### 1. (CRÍTICA · NUEVA) No existe ni un solo camino de respaldo o restauración en todo el árbol

`grep -rn "pg_dump|pg_restore|pgbackrest|wal-g|barman" src/ scripts/ docker/ .github/ docs/*.md` → **0 resultados**. No hay volcado lógico, ni manifiesto, ni verificador, ni restauración, ni PITR, ni documento que diga cómo hacerlo a mano.

El catálogo **ya diseñó las cuatro filas** y las marca todas ❌:
- `docs/cli-command-catalog.md:2948` — `backup create`: "❌ no existe ningún camino de respaldo lógico ni manifiesto de versión" · **fase 2**
- `:2949` — `backup list`: "❌ no hay inventario de respaldos ni registro del manifiesto" · fase 2
- `:2950` — `backup verify`: "❌ no existe manifiesto ni verificador" · fase 2
- `:2951` — `backup restore`: ❌ · `irreversible [4]` · **fase 3**

Es decir: **la fase 1 comprometida del plan maestro no incluye respaldo.** Un despacho que ponga los libros de 50 clientes aquí, en la fase que el plan sí compromete, está a un fallo de disco de perder contabilidad con obligación legal de conservación de cinco años. Y agrava: `033_audit_log_append_only.sql` y `041_el_mayor_inviolable.sql` hacen la bitácora y el mayor no reescribibles ni por el dueño del esquema — inmutabilidad sin respaldo es un solo punto de fallo endurecido.

### 2. (CRÍTICA · NUEVA) No hay despliegue de producción: sólo un compose de desarrollo, y ese compose migra mal

- No hay CD: `.github/workflows/ci.yml` tiene cinco jobs y ninguno despliega. No hay otro workflow (`ls .github/workflows/` → un archivo).
- No hay manifiestos: búsqueda de `*k8s*`, `*helm*`, `*terraform*`, `*.tf` fuera de `node_modules` → 0 resultados.
- `docker/docker-compose.yml` es explícitamente de desarrollo: `NODE_ENV=development` (`:11`), `JWT_SECRET=dev-secret-change-in-production` (`:15`), `ENCRYPTION_KEY` de 64 ceros (`:16`), `command: npm run dev` (`:24`) y monta `../src` como volumen (`:23`).
- **El defecto concreto:** `docker-compose.yml:36` monta `../src/database/migrations:/docker-entrypoint-initdb.d`. Eso ejecuta los `.sql` **alfabéticamente, una sola vez, en el primer arranque del volumen**, sin la tabla `public.migrations`, sin la transacción por migración de `migrate.ts:83-94`, y **sin aplicar `rls-policies.sql`** — que es justo lo que `migrate.ts:109-118` corre siempre. Una base levantada por este compose queda sin políticas de aislamiento y sin registro de qué se aplicó.
- `Dockerfile:22` hace `npm install --omit=dev` en vez de `npm ci`: la imagen de producción no está fijada al lockfile.
- Nada dice **quién** corre `npm run migrate` en producción, ni con qué credencial, ni con qué ventana. `MIGRATION_DATABASE_URL` existe y está bien separada (`.env.example`), pero no hay procedimiento.

### 3. (ALTA · NUEVA) Cero rollback de esquema: 47 migraciones, ninguna reversible

`ls src/database/migrations/` → 47 archivos, **cero** con `down`/`revert`/`rollback` (`ls | grep -ci down` → 0). `migrate.ts` sólo avanza: no hay `runMigrationsDown`, no hay `--to <n>`. Una migración que resulte mala en producción no tiene camino de vuelta salvo restaurar un respaldo — que no existe (brecha 1). Las dos se multiplican.

### 4. (ALTA · NUEVA) La migración de un cliente real está cortada en tres sitios distintos

**(a) Un solo proveedor externo.** `src/services/integrations/accounting/registry.ts:10-20`: `FACTORIES` tiene exactamente una entrada, `contalink`. Ni CONTPAQi ni Aspel tienen adaptador.

**(b) Los layouts propietarios se rechazan por diseño.** `src/services/accounting/entry-import-service.ts:24-25`: `IMPORT_LAYOUTS = ['csv','ndjson']`, `LAYOUTS_PENDIENTES = ['contpaqi','aspel','iif','sat-polizas']`, y `:41-45` los rechaza con mensaje. La razón declarada (`:14-17`) es correcta y honesta —"un parser de formato propietario sin fixtures reales es un generador de pólizas plausibles y falsas"— pero el efecto operativo es que **el 100 % del mercado real (CONTPAQi/Aspel) sólo puede entrar por CSV manual.**

**(c) Ni siquiera con Contalink llega la historia.** `src/services/integrations/accounting/accounting-adapter.interface.ts:33-49`: la interfaz tiene `getTrialBalance`, `getAccountBalance`, `listFiscalDocuments`, y escrituras — **no hay un solo método que traiga pólizas históricas**. `onboard` (`src/cli/mnemosine.ts:1368-1487`) trae catálogo + saldo de apertura al corte y nada más. Un cliente migrado no tiene su ejercicio en curso, sólo su saldo inicial.

### 5. (ALTA · NUEVA) `entry import` es un callejón sin salida: nada lee lo que escribe, y doctor no puede verlo

`src/cli/entry-command.ts:698-757` prepara el lote en `journal_entry_import_batches` + `journal_entry_import_rows` y lo dice él mismo en `:753`: *"se valida y aplica con la familia batch (check/post) **cuando llegue**"*. Verificado: `grep -rn "journal_entry_import_rows" src/` da **dos** resultados — la declaración de riesgo (`entry-command.ts:715`) y el `INSERT` (`entry-import-service.ts:153`). **Nadie lee la tabla.** No existe `command('batch')`.

Y lo grave para el gobierno del proyecto: **el escáner de huérfanos no puede detectarlo.** `src/ai/orphan-scan.ts:19-20` define: *"Una TABLA está huérfana si el código de la aplicación la LEE y NADIE la escribe."* El caso inverso —escrita y jamás leída— está fuera de la definición. La 045 creó dos tablas que sólo acumulan, y el instrumento construido para cazar exactamente esta enfermedad es ciego a esta mitad de ella.

**Defecto de parseo dentro de la misma ruta.** `entry-import-service.ts:88` parte cada renglón con `cruda.split(',')` y luego quita comillas por regex: un `"Gastos de venta, generales"` en la descripción o el nombre de cuenta rompe el alineamiento de columnas silenciosamente. Y `:90`, `if (celdas.length < 6) continue;`, **descarta la fila sin dejar rastro** — contradiciendo la promesa del propio encabezado (`:19-21`: *"nada se descarta en silencio y el resumen dice cuántas no pasaron"*). Ambos son fatales en un CSV exportado de CONTPAQi, donde las descripciones llevan comas.

### 6. (ALTA · NUEVA) La observabilidad cubre la superficie que el producto no usa

`/metrics` existe y está bien montado (`src/index.ts:113-115`), pero:
- **Sólo hay cuatro métricas de dominio** (`src/api/rest/middleware/metrics.ts`): duración HTTP (`:9`), contador HTTP (`:17`), transiciones de nómina (`:26`), resultados de timbrado (`:34`). Todo lo demás es `collectDefaultMetrics` del proceso (`:5`).
- **El producto es CLI-first y el CLI no expone `/metrics`.** El registro de `prom-client` es por proceso: un `mnemosine ingest` o un `job run` incrementa contadores que mueren con el proceso. La ingesta, el mayor, los borradores, el gasto del agente y los timbres desde CLI son **invisibles para Prometheus**. Todo lo bueno de la 044 vive en SQL, consultable sólo por `ai stats` y por entidad.
- **Winston sólo escribe a consola.** `src/utils/logger.ts:50`: `transports: [new winston.transports.Console()]`. No hay transporte a archivo ni a agregador. Y `grep -rn "logger" src/cli/*.ts` → **0 resultados**: el CLI no usa el logger en absoluto. Un `job run` desatendido que falla a las 3 a.m. no deja bitácora salvo lo que haya alcanzado a escribir en tablas.
- **Cero alertas y cero tableros en el repo:** no hay reglas de Prometheus, ni dashboards de Grafana, ni SLOs. `/metrics` sin nadie que lo mire es telemetría, no observabilidad.
- **`/metrics` sigue sin autenticación** (`index.ts:113-115`), delegando en "un allowlist del LB" que este repositorio no configura en ninguna parte (ver brecha 2: no hay LB).

### 7. (ALTA · NUEVA) Nadie ha medido con volumen, y hay tres razones estructurales para no poder

- **Cero pruebas de carga.** No hay `bench`, ni fixture de volumen, ni EXPLAIN, ni escenario de 200k CFDIs en `tests/`.
- **La ingesta es estrictamente secuencial.** `src/ai/ingest-service.ts:113-117`: `for (const file of files) { results.push(await ingestOne(file, name)); }` — sin concurrencia, sin lotes, sin `Promise.all` acotado. Con una llamada al modelo por CFDI, 200 000 CFDIs es aritmética imposible en una sola corrida. Tampoco hay reanudación por checkpoint; lo único que salva un reintento es el dedupe por hash/UUID.
- **Las vistas materializadas son globales, cruzan todos los inquilinos.** `src/database/migrations/004_partitioning_and_views.sql:27-56`: `mv_trial_balance` hace `accounts CROSS JOIN fiscal_periods` para **toda la instalación**. La 042 la sacó del camino de posteo (bien), pero cada `REFRESH` sigue costando O(instalación entera): con 50 clientes, refrescar por uno recalcula los 50. Y el refresco es **manual** (`mnemosine report view sync`): no hay job ni cron que lo dispare.
- **La partición está declarada y no hecha.** `004:5-13`: *"Convert to partitioned table for high-volume transaction data … Create a partitioned copy (note: in production, migrate data with pg_partman) — For now, create partition-ready indexes"*. El encabezado dice "PARTITIONING"; lo que hay son índices. Hay 217 `CREATE INDEX` en total y están razonablemente compuestos por `entity_id` (p. ej. `004:16-17`), así que el problema no es la falta de índices: es que nadie sabe dónde se rompe.
- `DATABASE_POOL_MAX` por omisión es 20 (`src/config/index.ts:53`), sin dimensionamiento documentado.

### 8. (MEDIA-ALTA · NUEVA) El costo por cliente/mes: los datos están, la respuesta no

La 044 y la 021 sí guardan lo necesario (`ai_usage.tenant_id/entity_id/estimated_cost_usd/created_at`, `ai_ingest_runs.estimated_cost_usd`). Pero:
- **Ningún comando agrega por cliente.** `src/cli/usage-command.ts:18` — `GROUP_CHOICES = ['model','provider','day','session']`: **no existe `--by entity`**. Y `:154` resuelve **una** entidad (`resolveEntity`). Para el costo mensual de 50 clientes hay que invocar el comando 50 veces y sumar a mano. Igual en `ai stats`: `stats-service.ts:148,157,163` filtran `WHERE entity_id = $1`.
- **El presupuesto es global, no por cliente.** `budget.ts:39` lee `budgetFileValues(cwd)` — **un solo** `mnemosine.config.json`. El alcance del gasto es por entidad (`currentSpend`, `:61`) pero **el límite es el mismo para todas**: no se puede poner tope de $20/mes a un cliente pequeño y $200 a uno grande.
- **El costo variable real no se registra en ninguna parte.** `grep -rn "costo_timbre|stamp_cost|precio_timbre" src/` → 0 resultados. El timbre PAC —que es el costo por cliente que un despacho mexicano sí paga— sólo produce un contador de Prometheus por proceso (`pac-router.ts:164-186`), no una fila. Tampoco hay costo de infraestructura por inquilino.
- **En la configuración por omisión, el costo es literalmente NULL.** `mnemosine.config.json` trae `default_provider: "ollama"`, y `src/ai/providers/prices.ts` no tiene entrada para modelos locales: todo turno cae en "unpriced" (`usage-command.ts:105,121-127`). La tabla de precios trae fecha de corte declarada (`prices.ts:52` = `2026-08-24`) y viaja con cada reporte (`usage-command.ts:92`) — eso es una fortaleza — pero no cambia que la respuesta por omisión sea "sin precio".

**Veredicto directo a la pregunta:** hoy **no** se puede responder "cuánto me cuesta el cliente X este mes" con un comando. Se puede responder con SQL a mano, sólo para el costo de modelo, sólo si el proveedor está en la tabla de precios.

### 9. (MEDIA-ALTA · NUEVA) No hay vista de despacho: el producto es una entidad a la vez

Todo camino operativo resuelve **una** entidad y filtra por ella. `src/ai/pending-service.ts:60,77,94,115,143` — los cinco tableros de pendientes son `WHERE entity_id = $1`. Igual `usage`, `ai stats`, `report`, `doctor` (por entidad donde aplica). `mnemosine entity list` (`mnemosine.ts:529-556`) lista nombre, RFC, moneda e id — nada más.

Un socio de despacho con 50 clientes no puede preguntar: *¿en cuáles hay borradores esperando? ¿cuáles tienen periodos vencidos sin cerrar? ¿cuáles tienen credencial por vencer? ¿cuánto llevo gastado en cada uno?* Tendría que iterar 50 invocaciones y agregar fuera del producto. Esto no es un comando faltante: es una dimensión ausente del modelo de interacción.

### 10. (MEDIA-ALTA · NUEVA) Retención, privacidad y PII fiscal: diseñado en el catálogo, cero en código, y fuera de la fase comprometida

Las **siete** filas de `data-retention` están escritas y todas ❌ (`docs/cli-command-catalog.md:2686-2692`): `policy set|list`, `status`, `hold create|unlock|list`, `delete`. Las tablas que nombran (`retention_policies`, `legal_holds`) no existen: `grep` en `src/database/migrations/` no las encuentra. Fase declarada: **2 y 3** — igual que el respaldo, fuera de lo comprometido.

Consecuencias concretas para un despacho mexicano:
- **No hay resguardo legal (`legal hold`).** Ante facultades de comprobación del SAT o un juicio, no hay forma de marcar un alcance como no-depurable — ni forma de depurar, tampoco.
- **No hay purga ni anonimización.** `grep -rn "anonimiz|purge|derecho ARCO"` en `src/` → 0. Un ex-empleado que ejerza sus derechos ARCO no tiene ruta.
- **La única base de consentimiento que existe es la de la e.firma** (`014_fiscal_credentials.sql:32-35`: `consent_at`, `consent_by`, `consent_version`, comentado como LFPDPPP). Está bien hecha — y es el **único** dato personal del sistema que la tiene. RFC, CURP, NSS, nombres de empleados y contrapartes viven sin consentimiento registrado ni política de conservación.
- **No hay aviso de privacidad** en ninguna forma: ni plantilla, ni texto, ni referencia. `grep -rn "aviso de privacidad"` en `src/`, `docs/`, `*.md` → 0 fuera del catálogo.
- **No hay contrato de encargado/subcontratación** ni documento que diga qué se envía a un proveedor de modelo. Esto importa: la ingesta manda el contenido de CFDIs de terceros —RFC, razón social, conceptos— a la API de Anthropic/OpenAI/etc. según el perfil. El repositorio no tiene un solo documento que declare ese flujo de datos personales a un tercero, que es exactamente lo que un despacho debe declarar en su aviso.
- El único punto donde la regla de PII está bien pensada es **normativo, no ejecutable**: `docs/cli-command-catalog.md:1598` ("la regla de PII es sobre el DATO, no sobre el formato") gobierna la columna IA del catálogo, no el código.

### 11. (MEDIA · NUEVA) No hay producto instalable: se opera desde el repositorio

`package.json` **no tiene campo `bin`**. El propio README lo dice sin adornos (`README.md:90`): *"El binario no está instalado como comando global: se invoca por npm"*, y todos los ejemplos son `npm run mnemosine -- <cmd>` (`:93-108`). El `build` copia `.md`/`.sql` a `dist/` a mano (`package.json:8`) y el `Dockerfile` empaqueta el servidor HTTP (`CMD ["node","dist/index.js"]`), **no el CLI**. No hay artefacto publicable, ni versionado del producto (la versión es `1.0.0` desde siempre, y `/health` la devuelve quemada: `index.ts:138`), ni CHANGELOG.

Un despacho no "instala mnemosine": clona un repositorio, corre `npm ci`, `createdb`, `npm run migrate`, `npm run seed`, y opera con `tsx` sobre las fuentes. Eso es un entorno de desarrollo, no un despliegue.

### 12. (MEDIA · NUEVA) Documentación: excelente para el agente y para quien contribuye, inexistente para el contador

- **Para el agente:** `src/ai/docs/cli-reference.md` (3 907 líneas) se genera del propio `program` de commander (`scripts/generate-cli-reference.ts:1-9`) y hoy **no tiene deriva** (regenerado en esta auditoría: `git diff` vacío). Es lo correcto.
- **Pero no tiene puerta en CI.** `.github/workflows/ci.yml` corre `plan:status --exigir` y `catalogo-estado --check`, y **no** corre el generador de la referencia. El propio catálogo lo admite (`docs/cli-command-catalog.md:2983`: *"no hay comprobación en CI"*). Está al día por disciplina, no por trinquete.
- **Para el humano operador: nada.** `README.md` (301 líneas) es un readme de proyecto —estado del plan, arquitectura, aislamiento, pruebas, cómo contribuir—; `CONTRIBUTING.md` es para quien aporta código; `src/cli/README.md` (409 líneas) documenta el kernel del CLI, no el oficio. `README_ACCOUNTANT.md` existe (31 KB) pero es del **13 de abril**, anterior a todo mnemosine, y no se cita desde ningún índice. No hay: guía de alta de un cliente, procedimiento de cierre mensual, qué hacer cuando el PAC rechaza, cómo interpretar un borrador, qué significa el código de salida 11.
- Y no hay **runbook de operación**: `ls docs/` no tiene ni un documento de operación, incidentes, restauración o escalamiento.

### 13. (MEDIA · NUEVA) Los mensajes de error sirven al operador hasta que la base habla

El contrato de `exit.ts` es excelente (F1) y `CliError` lleva mensaje y `detail` para `--json`. Pero:
- **La adopción es parcial:** 52 `shutdown(1)` frente a 25 `exitCodeFor(err)` en `src/cli/*.ts`, más 24 `deps.shutdown(1)`. Es decir, **la mayoría de los manejadores colapsan todo a "falló"** en vez de mapear al código específico que el contrato define.
- **No hay traducción de errores de Postgres.** `src/cli/kernel/index.ts:109-114` (`exitCodeFor`): si no es `CliError` y no trae `statusCode`, devuelve `FAILURE`. Y `reportError` (`src/cli/mnemosine.ts:253-255`) imprime `err.message` crudo. Un contador que dispare una violación de RLS o una restricción ve literalmente `new row violates row-level security policy for table "journal_entries"` con salida 1. Sólo tres servicios mapean un código pg (`23505` en `vendor-service.ts:433`, `customer-service.ts:401`, `session-store.ts:146`); el resto no.
- Los mensajes que **sí** están escritos a mano son ejemplares y merecen decirse: `entry post` ante un asiento ya posteado dice *"Correct it with `entry reverse`, which leaves an audit trail"* (`entry-command.ts:781-784`); `onboard` sin terminal explica cómo re-ejecutar (`mnemosine.ts:1428-1431`); `invoice` ante un cliente archivado nombra el comando de rescate (`invoice-command.ts:441`). El problema no es el criterio, es la cobertura.

### 14. (MEDIA · SIGUE-ABIERTA desde auditoría I) `ENCRYPTION_KEY` no se puede rotar

`src/utils/encryption.ts:18` produce `iv:tag:cipher` — **sin versión de llave**. `decrypt` (`:21-23`) parte por `:` y usa `config.encryption.key`, una sola. `src/config/index.ts:214+` y `.env.example` admiten que cambiarla vuelve ilegible lo cifrado. Rotar la llave de cifrado es una operación de producción obligatoria (compromiso, política, salida de personal) y hoy no tiene camino. Nombrada por `seguridad-multitenant` brecha 8; sigue igual.

### 15. (MEDIA · SIGUE-ABIERTA desde auditoría I) Sin proveedor de modelo, un lote de ingesta se degrada mal

`git show HEAD:src/ai/ingest-service.ts` línea **194**: `return { file: name, status: 'error', detail: 'Model failure: …' }`. Un despacho sin conectividad al proveedor obtiene un lote de N errores, no N documentos "registrados, pendientes de clasificación manual". El registro determinista (dedupe, reglas, REP) sí sobrevive; el estado que se reporta al humano no lo refleja. Nombrada por `agentic-ai-first` brecha 11.

### 16. (BAJA · SIGUE-ABIERTA desde auditoría I) `/metrics` sin autenticación y sin el LB que lo justifica

`src/index.ts:113-115`. El comentario delega en un allowlist de balanceador; el repositorio no contiene ninguna configuración de balanceador (brecha 2). Es la parte de `seguridad-multitenant` brecha 10 que no se cerró — la otra parte (CORS) **sí** se cerró (`index.ts:90-94`, origen explícito por entorno).

### 17. (BAJA · SIGUE-ABIERTA desde auditoría I) El criterio "doctor sin huérfanos nuevos" no existe

`git show HEAD:src/plan/criterios.ts | grep "huérfan"` → aparece sólo en comentarios (`:132`, `:512`). `doce-cobertura` brecha 4 lo señaló citando el propio plan maestro ("*doctor sin huérfanos nuevos entra como criterio*"). Sigue sin existir — y la brecha 5 de este informe muestra qué se escapa mientras tanto.

---

## DICTAMEN SOBRE LA AUDITORÍA I (lo que toca a este lente)

| Brecha original | Veredicto | Evidencia |
|---|---|---|
| `agentic-ai-first` B7 — presupuesto E5.1-e "no existe, se cayó del plan" | **CERRADA** | `src/ai/budget.ts:1-196`; cableado en `src/ai/providers/index.ts:77`; vigilado por `src/plan/criterios.ts:2193` |
| `agentic-ai-first` B9 — métricas de agente ausentes (duración, counts, eventos, costo por acto) | **CERRADA** | `044_el_agente_medible.sql:26-68`; `src/ai/stats-service.ts:140-200` da `costo_por_borrador_usd`, `tasa_intervencion_humana`, `duracion_p95_ms`, eventos. *Residuo: por entidad y fuera de Prometheus — ver brecha 6* |
| `doce-cobertura` B1 — modelo de costes sin instrumento | **CERRADA** | `scripts/costo-por-fila.ts:1-40`, con sus límites declarados |
| `seguridad-multitenant` B1 — PII en claro en `audit_log` | **CERRADA** | `src/api/rest/middleware/audit.ts:20-40`, redacción recursiva + criterio E0.3 |
| `seguridad-multitenant` B6 — rate limiting fail-open | **CERRADA** | `src/services/cache/redis.ts:154-185` distingue "Redis caído" (contador local) de "sin Redis" (declarado en `rate-limiter.ts:26-30`) |
| `seguridad-multitenant` B10 (CORS) | **CERRADA** | `src/index.ts:90-94`, origen explícito por entorno |
| `seguridad-multitenant` B10 (`/metrics` sin auth) | **SIGUE-ABIERTA** | `src/index.ts:113-115` — brecha 16 |
| `seguridad-multitenant` B8 (rotación de `ENCRYPTION_KEY`) | **SIGUE-ABIERTA** | `src/utils/encryption.ts:18` — brecha 14 |
| `agentic-ai-first` B11 (degradación sin proveedor) | **SIGUE-ABIERTA** | `ingest-service.ts:194` en HEAD — brecha 15 |
| `doce-cobertura` B4 (criterio "doctor sin huérfanos") | **SIGUE-ABIERTA** | `criterios.ts:132,512` sólo en comentarios — brecha 17 |

Ninguna de las siete lentes de la auditoría I cubrió operación, respaldo, despliegue, escala, costes de negocio ni cumplimiento de datos personales. **Las brechas 1-13 de este informe son todas nuevas**, y esa ausencia de lente es en sí el hallazgo de fondo: el proyecto se ha auditado a sí mismo con rigor extraordinario en corrección contable, seguridad multi-inquilino y disciplina de agente, y nunca se ha preguntado si alguien puede operarlo.

---

## RECOMENDACIONES

### Lo que ES trabajo de plan maestro (tiene fila de catálogo, o debería tenerla)

1. **(M · promover de fase 2/3 a inmediato) La familia `backup` completa.** `backup create|list|verify|restore` ya está especificada en `docs/cli-command-catalog.md:2948-2951` con manifiesto de versión de esquema y verificación criptográfica. Está en fase 2/3; **debe subir a fase 1**. Un producto de contabilidad sin restauración no es entregable a ningún cliente, y la fase 1 es lo único comprometido. Criterio ejecutable propuesto: existe un camino que produce volcado + manifiesto, y una prueba de integración que **restaura sobre base vacía y verifica que el mayor cuadra**. (Brecha 1.)

2. **(S) `entry batch check` y `entry batch post`, o retirar `entry import`.** Hoy `journal_entry_import_rows` se escribe y nadie la lee (`entry-command.ts:753` lo confiesa). Es trabajo directo de continuación de F01. Si no va a llegar pronto, `entry import` debería salir del binario: una puerta que no lleva a ninguna parte es peor que su ausencia. (Brecha 5.)

3. **(S, y urgente) Arreglar el parser CSV antes de que alguien importe algo.** `entry-import-service.ts:88` necesita un lector de CSV que respete comillas; `:90` debe **reportar** la fila corta con `parse_error` en vez de `continue`, porque el encabezado del propio archivo lo promete (`:19-21`). Son dos cambios pequeños y hoy el archivo miente sobre sí mismo. (Brecha 5.)

4. **(S) `usage --by entity` y `ai stats --all-entities`.** La columna y el índice ya existen (`021_ai_usage.sql:24,46`). Es añadir una entrada a `GROUPINGS` en `usage-ledger.ts:149-152` y levantar el filtro de entidad única. Convierte "costo por cliente/mes" de una conjetura en una consulta. (Brecha 8.)

5. **(M) Presupuesto por entidad, no global.** Mover los límites de `mnemosine.config.json` a una tabla por entidad (o a `policy_decisions`, si se considera decisión del despacho y no del operador — **según la regla de la casa, un tope de gasto es decisión de operador, no bifurcación de criterio contable, así que va al archivo/tabla del operador, no al panel**). Hoy `budget.ts:39` lee un solo archivo para 50 clientes. (Brecha 8.)

6. **(M) La vista de despacho: `mnemosine portfolio` (`cartera`).** Una fila por entidad con: borradores pendientes, preguntas abiertas, periodos vencidos sin cerrar, credenciales por vencer, gasto del mes, última ingesta. Es una consulta que agrega lo que `pending-service.ts:60-145` ya calcula, sin el `WHERE entity_id = $1`. Es la fila que convierte un sistema contable en un producto de despacho. (Brecha 9.)

7. **(M) La familia `data-retention` completa, con el resguardo legal primero.** `docs/cli-command-catalog.md:2686-2692`, siete filas ❌. **`hold create|list` debe ir antes que `delete`**: poder marcar un alcance como no-depurable es lo que un despacho necesita ante facultades de comprobación, y es inofensivo; el borrado puede esperar. Su disposición por omisión ya está bien decidida en el catálogo ("archivar por omisión, nunca borrar"). (Brecha 10.)

8. **(M) Registro del costo del timbre.** Una columna de costo (o una tabla `stamp_costs` por proveedor y periodo) alimentada donde hoy sólo se incrementa el contador de Prometheus (`pac-router.ts:164-186`). Sin esto, el costo por cliente que el despacho realmente paga no existe en ningún lado. (Brecha 8.)

9. **(S) Mapear los errores de Postgres al contrato de salida.** Una función en `src/cli/kernel/exit.ts` que traduzca los códigos pg relevantes (`23505`→`CONFLICT`, `23503`→`VALIDATION`, `42501`/RLS→`PERMISSION`, `40001`→reintentable) antes de caer en `FAILURE` (`kernel/index.ts:113`), y migrar los 52 `shutdown(1)` a `shutdown(exitCodeFor(err))`. El contrato ya existe y está bien; falta que lo alcance el 70 % del binario. (Brecha 13.)

10. **(S) Un criterio ejecutable de "tabla escrita y nunca leída"** en `orphan-scan.ts`, con línea base congelada. La definición actual (`:19-20`) cubre sólo la mitad de la enfermedad, y la 045 produjo la otra mitad en el mismo tramo. Esto cierra además `doce-cobertura` B4. (Brechas 5 y 17.)

11. **(S) Puerta en CI para `generate-cli-reference.ts`.** Un paso que regenere y falle si `git diff` no queda vacío — el mismo trinquete que ya tiene `catalogo-estado --check` (`ci.yml:102`). Hoy la referencia está al día por disciplina. (Brecha 12.)

12. **(M) Rotación de `ENCRYPTION_KEY` con versión de llave.** Cambiar el formato a `v<n>:iv:tag:cipher` en `encryption.ts:18`, admitir varias llaves en descifrado, y un comando de re-cifrado por lotes. Es prerequisito de cualquier despliegue con obligación de rotar secretos. (Brecha 14.)

13. **(S) Estado explícito "registrado, sin clasificar"** en `ingest-service.ts:194`, en vez de `status: 'error'` por archivo. Lo determinista sobrevivió; el reporte debe decirlo. (Brecha 15.)

### Lo que NO es trabajo de plan maestro (infraestructura, operación y contratos — no hay fila de catálogo que los cubra)

14. **(M · infraestructura) Respaldo continuo a nivel de motor, aparte del comando.** `mnemosine backup` (rec. 1) es el respaldo lógico *del producto*; lo que evita perder los libros es PITR del motor: archivado de WAL (`pgBackRest` / `wal-g` / el respaldo gestionado del proveedor), retención declarada, y **una prueba de restauración periódica que alguien ejecute de verdad**. Un respaldo no probado no es un respaldo. Esto no lleva fila de catálogo: es un runbook y una configuración.

15. **(M · operación) Un documento de despliegue de producción y quién corre las migraciones.** Hoy no existe. Debe decir, como mínimo: qué imagen, qué variables, quién posee `MIGRATION_DATABASE_URL`, en qué ventana corre `npm run migrate`, qué se hace si falla a mitad (hoy la respuesta es "restaurar", ver brecha 3), y cómo se verifica después (`mnemosine doctor` ya sirve para esto). Y **arreglar `docker-compose.yml:36`**: quitar el montaje a `docker-entrypoint-initdb.d` y hacer que el arranque invoque `npm run migrate`, o marcar el compose como exclusivamente de desarrollo en su primera línea. (Brecha 2.)

16. **(M · operación) Reglas de alerta y un tablero mínimo.** Cuatro alertas cubren el 90 %: `/ready` en 503, tasa de error 5xx, fallos de timbrado por proveedor (la métrica `accounting_cfdi_stamp_total` ya existe y su comentario en `metrics.ts:32-33` ya nombra el runbook de cambiar de PAC), y presupuesto de agente al 80 %. Van en el repositorio como YAML, no en la cabeza de alguien. (Brecha 6.)

17. **(S · operación) Un transporte de archivo en winston y bitácora del CLI.** `logger.ts:50` sólo tiene consola, y `src/cli/*.ts` no usa el logger. Un `job run` desatendido debe dejar rastro en disco con su id de corrida. (Brecha 6.)

18. **(M · ingeniería, no producto) Un banco de pruebas de volumen.** Generar 50 entidades × 4 000 CFDIs sintéticos, medir: tiempo de ingesta por CFDI, `REFRESH MATERIALIZED VIEW` con las 50 entidades cargadas, `report trial-balance` p95, y el tamaño al que el `CROSS JOIN` de `004:27-56` deja de ser aceptable. Sólo con ese número se puede decidir si hace falta particionar de verdad (`004:5-13` lo declara y no lo hace) o hacer la vista por entidad. **Y concurrencia acotada en `ingest-service.ts:113-117`**, que hoy es un bucle secuencial. (Brecha 7.)

19. **(S · producto, no plan) Empaquetado.** Campo `bin` en `package.json`, versión que salga de ahí en vez de estar quemada en `index.ts:138`, y un CHANGELOG. Mientras se opere con `npm run mnemosine --` desde un clon, esto es un proyecto, no un producto. (Brecha 11.)

20. **(M · legal, no código) Aviso de privacidad, contrato de encargado y declaración del flujo de datos al proveedor de modelo.** Lo más urgente y lo que menos código lleva: **un documento que declare qué datos personales de terceros salen hacia la API del proveedor de modelo durante la ingesta** (RFC, razón social, conceptos de CFDIs de clientes y proveedores del cliente del despacho). El despacho no puede redactar su aviso de privacidad sin eso, y hoy el repositorio no lo dice en ninguna parte. Va acompañado de: plantilla de aviso, cláusula de encargado/subencargado, y política de conservación por clase de registro que después alimente la rec. 7. (Brecha 10.)

21. **(M · documentación, no plan) Un manual de despacho.** Distinto de `README.md` (proyecto) y de `cli-reference.md` (agente). Cinco capítulos: dar de alta un cliente, el ciclo mensual, qué hacer cuando el PAC rechaza, cómo leer y decidir un borrador, y qué significa cada código de salida. `README_ACCOUNTANT.md` es de abril y precede a mnemosine: o se reescribe o se retira, porque hoy es documentación caducada sin índice que la referencie. (Brecha 12.)

---

## LA FRASE QUE RESUME EL LENTE

mnemosine ha construido, con disciplina poco común, **el motor**: un mayor inviolable, aislamiento verificado por un job de CI que conecta sin BYPASSRLS, un agente que propone y nunca dispone, un contrato de salida que un runner entiende, y medidores que se preguntan en vez de recordarse. Lo que no ha construido es **el vehículo**: no hay forma de recuperar los libros si se pierden, no hay forma de desplegar sin ser quien lo escribió, no hay forma de ver los 50 clientes a la vez, no hay forma de decir cuánto cuesta uno, y no hay forma de decirle a un cliente qué se hace con sus datos. Ninguna de esas cinco cosas es difícil comparada con lo que ya está hecho — pero cuatro de las cinco están en fase 2 o 3 del plan, o fuera de él, y ese es el hallazgo: **la fase comprometida produce un motor que nadie puede conducir.**

---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** No existe ni un solo camino de respaldo o restauración en todo el árbol (grep de pg_dump/pg_restore/pgbackrest/wal-g sobre src/, scripts/, docker/, .github/, docs/ = 0 resultados), y el propio catálogo ya diseñó las cuatro filas marcándolas todas ❌ y en FASE 2/3 — docs/cli-command-catalog.md:2948-2951 — de modo que la fase 1 comprometida del plan maestro entrega un sistema donde un despacho no puede recuperar los libros de sus clientes, agravado porque 033_audit_log_append_only.sql y 041_el_mayor_inviolable.sql los hacen no reescribibles ni por el dueño del esquema.

**¿Refutado?** No: se sostiene

SE SOSTIENE en su núcleo, con una cláusula falsa y una absolutización que hay que corregir.

VERIFICADO POR MÍ:
1. Grep propio sobre todo el repo (excluyendo node_modules/, .git/, dist/, coverage/) de `pg_dump|pg_restore|pgbackrest|wal-g|pg_basebackup`: CERO coincidencias. Todos los `restore` de src/ son otra cosa (src/cli/memory-command.ts:173, src/cli/customer-command.ts:476, src/cli/account-command.ts:637, src/services/accounting/fiscal-calendar-service.ts:280). Tampoco hay script npm de respaldo (package.json:7-25) ni nada en docker/docker-compose.yml (postgres:15-alpine con volumen `postgres_data`, sin política de respaldo) ni en .github/workflows.
2. Las líneas citadas son EXACTAS: docs/cli-command-catalog.md:2948 `backup create` ❌ fase 2 — su columna de backend dice literalmente «no existe ningún camino de respaldo lógico ni manifiesto de versión»; :2949 `backup list` ❌ fase 2; :2950 `backup verify` ❌ fase 2; :2951 `backup restore` ❌ fase 3. (Matiz menor: son 2/2/2/3, no «FASE 2/3» indistinto.)
3. Fuera de compromiso: docs/plan-catalogo.md:44 «este plan compromete la fase 1 y deja el resto como respaldo, no como promesa». Las cuatro filas caen fuera.
4. Las migraciones son como se describen: 033_audit_log_append_only.sql:44-58 (trigger BEFORE UPDATE OR DELETE + BEFORE TRUNCATE, con REVOKE como primera capa) y 041_el_mayor_inviolable.sql:64-66, 97-99, 111-117 (posteados inmutables salvo lista blanca de metadatos; TRUNCATE bloqueado sin condición). Ambas alcanzan al dueño del esquema, tal como afirma el hallazgo.

DOS EVIDENCIAS QUE EL HALLAZGO NO USÓ Y QUE PESAN MÁS QUE LA SUYA:
5. docs/cli-command-catalog.md:2697 — `continuity status` (RPO/RTO objetivo, último respaldo, última verificación, último simulacro) también ❌ fase 2: no falta sólo el respaldo, falta cualquier instrumento de continuidad.
6. docs/plan-cierre-brechas.md:8241 — la mitigación que el propio plan escribe para sus tres remediaciones destructivas (E1.2-h, E1.4-a, E3.2-i, que «corrompe el mayor de una entidad viva») dice textualmente que cada una «exige respaldo verificado». Ese control depende de `backup create`/`backup verify`, diferidos a fase 2 por el mismo plan. Es una contradicción interna del compromiso, no una omisión externa.

DONDE EL HALLAZGO SE PASA:
7. La cláusula «agravado porque 033 y 041 los hacen no reescribibles» está al revés respecto de la restauración. 033_audit_log_append_only.sql:27 dice verbatim «Nota sobre INSERT: sigue permitido, obviamente, y es lo único», y ambos triggers disparan sólo en UPDATE/DELETE/TRUNCATE. Una restauración lógica sobre base vacía es sólo INSERT y NO la bloquea ninguna de las dos migraciones. Más aún, 041:106 prescribe la salida: «Si esto es una base de pruebas, bórrala entera y vuelve a migrar». La inmutabilidad no estorba al restore: elimina la reparación en sitio, lo que sube el VALOR del respaldo sin encarecer la restauración.
8. «un despacho no puede recuperar los libros» es absoluto de más: es Postgres autoalojado y cualquier operador con psql puede volcar y restaurar; nada del esquema se lo impide.
9. No está cerrado ni previamente señalado: ningún documento de docs/auditorias/2026-08-31-integral/ levanta esta brecha.

**Formulación corregida:** El producto no tiene camino propio de respaldo ni de restauración, y el plan comprometido no lo va a tener: grep de `pg_dump|pg_restore|pgbackrest|wal-g|pg_basebackup` sobre todo el repo (sin node_modules/, dist/) da cero, no hay script npm (package.json:7-25) ni nada en docker/docker-compose.yml ni en .github/workflows, y el catálogo ya declaró las cuatro filas ❌ — `backup create` fase 2 (docs/cli-command-catalog.md:2948, «no existe ningún camino de respaldo lógico ni manifiesto de versión»), `backup list` fase 2 (:2949), `backup verify` fase 2 (:2950), `backup restore` fase 3 (:2951) — más `continuity status` (RPO, RTO, último respaldo, último simulacro) ❌ fase 2 (:2697). Como docs/plan-catalogo.md:44 compromete sólo la fase 1, las cinco quedan fuera de la promesa.

Lo grave no es que un despacho quede sin recuperación posible —es Postgres autoalojado y un operador con psql puede volcar y restaurar—, sino tres cosas concretas:

(a) CONTRADICCIÓN DENTRO DEL PROPIO COMPROMISO. docs/plan-cierre-brechas.md:8241 exige «respaldo verificado» como condición de ejecución de las tres remediaciones destructivas del plan (E1.2-h, E1.4-a, E3.2-i, que «corrompe el mayor de una entidad viva»). Ese control se apoya en `backup create`/`backup verify`, que el mismo plan difiere a fase 2. El control existe en el papel y no tiene con qué ejecutarse.

(b) UN VOLCADO GENÉRICO NO BASTA, y eso sí es específico del producto. Falta el manifiesto de versión de esquema que el propio catálogo pide (:2948), y falta el material criptográfico que vive FUERA de la base: `.mnemosine-vault/vault.key` (src/services/vault/local-dev.ts:42) o AWS Secrets Manager (src/services/vault/index.ts:32-48) y `ENCRYPTION_KEY` (src/config/index.ts:113). Sin ellos un `pg_dump` restaurado deja cuentas bancarias, CLABEs y credenciales fiscales como texto cifrado ilegible — el riesgo que el propio config nombra en src/config/index.ts:214-216. Ningún documento del repo (README.md, SECURITY.md, CONTRIBUTING.md, docs/) describe procedimiento alguno de respaldo, restauración o continuidad.

(c) LA INMUTABILIDAD SUBE EL PRECIO DE NO TENER RESPALDO, pero NO estorba la restauración — corrección al enunciado original. 033_audit_log_append_only.sql:27 dice que el INSERT «sigue permitido, obviamente, y es lo único», y los triggers de 033 (:44-58) y 041 (:64-66, :97-99, :111-117) disparan sólo en UPDATE/DELETE/TRUNCATE: restaurar sobre base vacía es sólo INSERT y pasa. Lo que 033 y 041 eliminan es la reparación en sitio; 041:106 llega a prescribir «bórrala entera y vuelve a migrar» como única salida ante un mayor inservible — es decir, la vía de recuperación que el esquema mismo nombra es exactamente la capacidad que el plan difiere a fase 3.

