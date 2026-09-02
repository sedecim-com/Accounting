> **Cómo se midió.** Ninguna afirmación de este informe es una estimación de lectura. Levanté una base real: las 52 migraciones del árbol auditado aplicadas sobre PostgreSQL 15.17, `scripts/provision-roles.sql` corrido, `src/database/rls-policies.sql` reaplicado, y carga sintética de **198 000 asientos · 792 000 líneas · 10 000 cuentas · 50 entidades · 200 000 CFDI** (`journal_entry_lines` = 257 MB, `xml_documents` = 138 MB, `audit_log` = 198 000 filas). Toda medición es `EXPLAIN (ANALYZE)` sobre el SQL **literal** del repositorio, ejecutado con dos roles —`mnemosine_app` (RLS **forzada**, que es como corre el producto) y superusuario (RLS no aplica)— sobre tabla vacuumada y analizada, mediana de 3–6 corridas. Los números de CLI son reloj de pared del binario real.
>
> **Límite honesto de la carga:** una entidad con 100 000 asientos y 49 con 2 000 cada una, no 50 × 100 000. Las consultas calientes del mayor están acotadas por entidad, así que el número por informe es el correcto; lo que **no** medí es la contención de 50 despachos concurrentes sobre el mismo pool — eso queda «no verificado» y lo digo en el hallazgo 3.

---

## LO QUE RESISTE

Auditar a favor también es auditar. Cinco cosas que temía y que aguantan:

1. **La búsqueda de CFDI no es el cuello de botella.** Con 200 000 comprobantes, el SQL literal de `src/api/rest/routes/xml-ingestion.ts:721-727` da **2,1–5,3 ms** en la primera página, **16 ms** en la página 79 (`OFFSET 3900`), y **0,33 ms** filtrando por `emisor_rfc`. Los índices de columna única de `005_xml_ingestion.sql:96-101` bastan a esta escala; el planificador combina `idx_xml_docs_entity` con `idx_xml_docs_emisor` por mapa de bits. **No hace falta el índice compuesto que iba a recomendar.** La ruta además pagina de verdad y tapa el `per_page` en 100 (`xml-ingestion.ts:709`).

2. **La paginación del mayor está bien construida y es honesta.** `queryLedgerRows` lleva `LIMIT/OFFSET` **dentro del SQL** (`src/services/reporting/report-service.ts:717`), y el diseño declarado en `src/cli/report-command.ts:52-59` —«el truncamiento nunca es silencioso; los totales se cuadran sobre TODO y después se corta la página»— está implementado tal cual (`report-service.ts:371-377`). La página del auxiliar por cuenta cuesta **10–20 ms** con 400 000 movimientos.

3. **La RLS forzada no encarece las escrituras.** 2 000 `INSERT` en `journal_entries`: **49 ms** sin RLS, **75 ms** con RLS forzada. El problema de la RLS en este sistema es **de lectura**, no de escritura; cualquier recomendación que la debilite «porque frena el posteo» estaría mal fundada.

4. **Las verificaciones de bitácora escalan.** `checkAuditTrail` (`src/services/accounting/ledger-checks.ts:88-98`) sobre un libro **sano** de 100 000 asientos con `audit_log` poblado: **130 ms**. `checkReopenedPeriods` (`src/ai/doctor-service.ts:835-848`), pese a no llevar filtro de entidad ni `LIMIT`: **0,04 ms**. `mnemosine doctor` completo: 4,5 s.

5. **La retención de `audit_log` es una postergación razonada, no un descuido.** `docs/plan-cierre-brechas.md:1625-1631` enumera las tres opciones, elige «retención indefinida, particionar cuando el volumen lo exija» y explica por qué particionar hoy añade máquina sin datos. **No lo reporto como hallazgo.**

Y una corrección de escala que **sí se hizo y se sostiene**: la migración `042_el_refresco_sale_del_posteo.sql:25-26` eliminó el disparador que hacía que cada posteo refrescara las vistas globales. Verificado en el clúster: `pg_trigger` sobre `journal_entries` sólo devuelve `journal_entries_posteado_inmutable` y `journal_entries_sin_truncate`. El disparador está muerto.

---

## HALLAZGOS

### 1 · [NUEVA] · **ALTA** · La política RLS de las tablas hijas se evalúa una vez POR LÍNEA: la balanza cuesta 17×

`src/database/rls-policies.sql:176-180` genera, para las 19 tablas hijas, `USING (EXISTS (SELECT 1 FROM padre p WHERE p.id = hija.fk))`. El comentario que la precede (`:130-138`) razona la **corrección** —el padre filtra al hijo— y no toca el coste. El coste es esto, del plan real de `mnemosine_app` sobre la balanza literal de `src/services/reporting/report-service.ts:300-316`:

```
->  Index Scan using idx_jel_account on journal_entry_lines jel (rows=2000 loops=200)
      Filter: (SubPlan 3)
      SubPlan 3
        ->  Index Scan using journal_entries_pkey on journal_entries p (rows=1 loops=400000)
              Filter: (hashed SubPlan 2)
```

**`loops=400000`.** Postgres no puede aplanar el `EXISTS` en semi-unión porque la cualificación es de barrera de seguridad: se evalúa **antes** que el filtro de periodo, sobre las 400 000 líneas de la entidad, para que sobrevivan 33 436. Y `journal_entries` se sondea **dos veces por línea** —una por la RLS, otra por la unión real— porque son dos rutas distintas del plan. El plan pasa de unión hash paralela a bucle anidado y pierde el paralelismo.

| consulta (SQL literal del repositorio) | superusuario | `mnemosine_app` (RLS forzada) | razón |
|---|---|---|---|
| balanza de un periodo · `report-service.ts:300-316` | **46 ms** | **782 ms** | **17,0×** |
| candidatos de conciliación · `matching.ts:317-326` | **49 ms** | **417 ms** | **8,5×** |
| `countLedgerRows` · `report-service.ts:726-730` | 129 ms | 540 ms | 4,2× |

**El arreglo está probado, no propuesto.** Añadí `tenant_id` a `journal_entry_lines`, lo rellené, y sustituí la política hija por `USING (tenant_id = app_current_tenant())`. **Mismo SQL, misma base, mismo rol: 782 ms → 111 ms.** El plan vuelve a ser unión hash. Siete veces más rápido, y sigue siendo aislamiento por RLS forzada, no menos.

**Escenario de fallo concreto:** un despacho de 50 entidades cierra el mes. Cada contador pide su balanza mensual. Cada una tarda 782 ms de CPU de base en vez de 46 ms; con `DATABASE_POOL_MAX = 20` (`src/config/index.ts:53`), 26 balanzas simultáneas saturan el pool durante ~1 s cada una y la 21ª petición **espera sin límite** (hallazgo 3). A cinco ejercicios de historia (2 M de líneas) el mismo informe pasa de ~230 ms a ~3,9 s, porque el coste es lineal en líneas examinadas, no en filas devueltas.

---

### 2 · [NUEVA] · **ALTA** · `autoMatchUnreconciled` es N+1 puro sobre el mayor completo, sin índice que lo cubra

`src/services/banking/matching.ts:373-376` trae **todas** las transacciones bancarias sin conciliar (`SELECT *`, sin `LIMIT`). El bucle de `:381` llama a `findBestMatch` → `getCandidates`, que por **cada transacción** dispara **cuatro** consultas (`:283` la cuenta, `:295` facturas, `:306` gastos, `:317` líneas del mayor), y luego hasta dos escrituras más (`:390`, `:396`).

La cuarta es la mala. `matching.ts:322-325`:

```sql
FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE je.entity_id = $1 AND je.status = 'posted' AND jel.is_reconciled = false
  AND ABS(COALESCE(jel.debit_amount, jel.credit_amount)) BETWEEN $2 AND $3
```

`ABS(COALESCE(...))` es una expresión no indexable y **no existe índice de importe** en `journal_entry_lines` (censo verificado en el clúster: `pkey`, la UNIQUE `(journal_entry_id, line_number)`, `idx_jel_entry`, `idx_jel_account`, `idx_jel_reconciled`, `idx_jel_entry_date`, `idx_jel_account_date` — ninguno toca `debit_amount`/`credit_amount`). `idx_jel_reconciled` es un booleano sobre una tabla donde casi todo es `false`: inútil. Medí el **coste puro del barrido**, con banda de importe que no casa con nada: **417 ms bajo RLS, 49 ms sin ella, devolviendo cero filas.**

Además, `query()` —no `client.query()`— dentro del bucle: bajo contexto de inquilino cada llamada abre `BEGIN` + `set_config` + consulta + `COMMIT` (`src/database/connection.ts:159-172`), es decir **4 viajes y un préstamo de conexión del pool por consulta**.

**Escenario de fallo concreto:** un extracto bancario mensual con 2 000 movimientos sin conciliar. `POST /v1/bank-accounts/:id/auto-match` ejecuta 2 000 × 4 = 8 000 consultas, de las cuales 2 000 barren las 400 000 líneas del mayor: **2 000 × 0,417 s ≈ 14 minutos sólo en esa consulta**, dentro de **una** petición HTTP, reteniendo conexiones del pool todo ese tiempo, y devolviendo un arreglo `results` con una entrada por transacción (`:378`) que crece sin tope. El cliente ve un socket colgado; el servidor sigue trabajando.

---

### 3 · [NUEVA] · **ALTA** · No hay `statement_timeout`, ni `lock_timeout`, ni `connectionTimeoutMillis`: el pool se agota en silencio y espera para siempre

`src/database/connection.ts:54-58` construye el `Pool` con exactamente tres opciones: `connectionString`, `min`, `max`. Grep exhaustivo sobre `src/`, `scripts/`, `docker/` y `.env.example`: **cero apariciones** de `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `connectionTimeoutMillis` o `query_timeout`. El único ajuste es `DATABASE_POOL_MAX = 20` (`src/config/index.ts:53`).

Los valores por omisión de `node-postgres` cierran el círculo: `connectionTimeoutMillis: 0` significa **esperar indefinidamente** por una conexión. Y `src/index.ts` no fija `server.timeout` ni `requestTimeout` (grep: sólo el `setTimeout` de apagado, `:301`).

Compuesto con el hallazgo 1: bajo contexto de inquilino **cada consulta** toma una conexión del pool durante toda su transacción (`connection.ts:159-172`), y `app.use(apiPrefix, tenantContext)` (`src/index.ts:184`) pone a **todas** las peticiones REST bajo ese régimen.

**Escenario de fallo concreto:** veinte peticiones de balanza llegan a la vez. Cada una retiene su conexión ~0,8 s. La vigésimo primera llama a `getPool().connect()` y **no vuelve nunca**: no hay tiempo de espera, no hay error, no hay métrica que lo diga (`prom-client` mide latencia HTTP en `src/api/rest/middleware/metrics.ts:9`, no saturación del pool). Peor: una sola consulta patológica —un `report mayor --all` (hallazgo 6) o un `auto-match` (hallazgo 2)— corre sin tope de sentencia, así que un cliente puede secuestrar una conexión durante horas sin que Postgres la corte. **No verificado:** no reproduje el agotamiento con 21 clientes concurrentes; el razonamiento es sobre los valores por omisión de `pg`, que sí verifiqué en el código.

**Cruce con el plan.** `docs/plan-cierre-brechas.md:4034-4044` decidió esto explícitamente: «¿Se mantiene una transacción por consulta…?» → «_Recomendación:_ A ahora, **con una métrica de duración de consulta por ruta antes y después**». La métrica nunca se instrumentó, y el coste que la decisión sopesó («la latencia extra es de tres viajes contra la base») no es el coste real: los tres viajes son microsegundos; la RLS del hallazgo 1 es 736 ms. **La decisión se tomó contra la magnitud equivocada.**

---

### 4 · [NUEVA] · **ALTA** · El posteo hace dos viajes por línea con el folio bloqueado: 20,8 asientos/s

Medido con el código real (`createJournalEntry` de `src/services/accounting/posting.ts`, invocado desde un arnés bajo `enterTenant`, contra la base de escala):

| asiento | ms/asiento | asientos/s | 100 000 asientos |
|---|---|---|---|
| 2 líneas | 11,8 | 84,5 | ~20 min |
| **16 líneas** | **48,1** | **20,8** | **~80 min** |

Coste marginal: **2,6 ms por línea**, en socket local con latencia de red cero. Es exactamente lo que dicta el código: `posting.ts:132-134` inserta **una línea por viaje**, y `posting.ts:206-207` hace **un `UPSERT` de `account_balances` por línea**. Dos viajes por línea, más el asiento, la auditoría y un `SELECT *` de recuperación.

Y todo eso ocurre **con el candado del folio tomado**. `nextEntityNumber` (`src/utils/sequence.ts:30-37`) hace un `INSERT … ON CONFLICT DO UPDATE` sobre `entity_sequences`, que toma el candado de fila hasta el `COMMIT`; se llama en `posting.ts:113`, **antes** de los ~35 viajes siguientes. El candado es correcto (impide folios colisionados, y su comentario lo dice), pero significa que **el posteo de una entidad-ejercicio es estrictamente serial y su ritmo es 1 / duración-completa-de-la-transacción**, no 1 / duración-del-contador.

**Escenario de fallo concreto:** el arranque de un cliente nuevo con el histórico del ejercicio: 100 000 pólizas de 16 líneas. En local, 80 minutos de un solo hilo que no se puede paralelizar (el candado de folio lo serializa por diseño). Contra un Postgres administrado con 2 ms de ida y vuelta, los ~35 viajes por asiento añaden 70 ms: **~2 h por entidad**. Sin trabajador en segundo plano (hallazgo 7), eso corre en el proceso de la CLI o dentro de una petición HTTP, y un `Ctrl-C` a la hora 1 deja el trabajo a medias sin punto de reanudación.

---

### 5 · [NUEVA] · **ALTA** · `POST /v1/pre-registrations/bulk` acepta ~250 000 identificadores sin tope y postea cada uno en su propia transacción

`src/api/rest/routes/xml-ingestion.ts:78-82`:

```ts
const bulkPreRegSchema = z.object({
  action: z.enum(['process', 'approve', 'reject', 'set_batch']),
  ids: z.array(z.string().uuid()).min(1),      // <- .min(1) y NINGÚN .max()
```

El bucle de `:439` recorre `ids` sin cota; con `action: 'process'` cada iteración hace `requireByIdInScope` + `service.processToAccounting` (`:446-455`), que abre una transacción de posteo completa. Con `approve`/`reject`/`set_batch` son tres `query()` sueltas (`:458`, `:466`, `:474`), cada una con su propio `BEGIN`/`COMMIT` bajo contexto de inquilino.

El único tope efectivo es el tamaño del cuerpo: `express.json({ limit: '10mb' })` (`src/index.ts:101`). Un UUID en JSON ocupa ~39 bytes, así que **caben ~250 000 identificadores**.

**Escenario de fallo concreto:** un operador manda 20 000 pre-registros a `process` en una llamada. A 48 ms por posteo (hallazgo 4) son **16 minutos** en una sola petición HTTP; Node corta el socket a los 300 s (`requestTimeout` por omisión, no configurado aquí), el cliente reintenta creyendo que falló, y el servidor —que sigue trabajando— arranca un **segundo** lote en paralelo sobre los mismos identificadores mientras el primero aún postea. El `results` en memoria (`:437`) acumula 20 000 objetos que nunca se llegan a serializar.

---

### 6 · [NUEVA] · **MEDIA** · `report mayor --all` trae todo a memoria: 526 MB con 400 000 movimientos, y no hay cursor en todo el árbol

`src/cli/report-command.ts:455` traduce `--all` a `limit: limit ?? Number.MAX_SAFE_INTEGER`, es decir `LIMIT 9007199254740991`. Medido con `/usr/bin/time -l` sobre la base de escala:

```
report mayor ver -e <entidad> --all   →  526 434 304 bytes de RSS máximo  ·  4,5 s
```

**526 MB por 400 000 movimientos**, ~1,3 KB por fila entre el resultado de `pg`, el `map` a `Row[]` (`report-command.ts:459-470`) y el renderizado. No hay mitigación disponible: `pg-cursor` y `pg-query-stream` **no están en `package.json`**, y grep sobre `src/` no encuentra un solo uso de `Cursor` o `QueryStream`. `node-postgres` materializa siempre el resultado completo en un arreglo antes de devolverlo.

**Escenario de fallo concreto:** cinco ejercicios de historia (2 M de movimientos) → ~2,6 GB de RSS, contra el límite de espacio viejo de V8. El proceso muere con `JavaScript heap out of memory` **después** de que Postgres ya transfirió los 2 M de filas. La bandera existe, está documentada, y no hay nada entre el usuario y el fallo. Nótese que el aviso de truncamiento es correcto y visible (`Showing 100 of 400000 rows…`): el problema es sólo la salida sin límite.

---

### 7 · [NUEVA] · **MEDIA** · La ingesta masiva de CFDI no tiene ZIP, ni directorio, ni lote, ni transacción por comprobante

El encargo pregunta qué pasa con un ZIP de 10 000 CFDI. La respuesta es: **no hay camino**. Cero dependencias de descompresión en `package.json`; grep insensible a mayúsculas de «zip» sobre `src/`: cero coincidencias. La única puerta es `.argument('<files...>')` (`src/cli/mnemosine.ts:1154`), una lista de rutas por `argv`, que a ~60 bytes por ruta choca con `ARG_MAX` (~1 MB en macOS) alrededor de los **15 000 archivos**. Y `E3.2` ya está en rojo en `plan:status` por la descarga masiva del SAT que no existe, así que tampoco hay origen alterno.

Aguas abajo el bucle es estrictamente serial: `src/ai/ingest-service.ts:113-116` procesa archivo por archivo con `readFileSync` (`:109`), una llamada al modelo por comprobante, y acumula `results` en memoria sin tope. **Sin concurrencia, sin lote, sin reanudación** — atenuado, en honor a la verdad, por la deduplicación por UUID/hash, que hace que reejecutar salte lo ya ingerido (`ingest-service.ts:139-141`).

Peor abajo todavía: `processXMLUpload` (`src/services/xml-ingestion/pre-registration-service.ts:69`) **no abre transacción**. Usa `query()` suelta para el `SELECT` de duplicado (`:94`), el `INSERT` del documento (`:108`), **un `INSERT` por concepto** (`:142-155`) y un `SELECT *` de relectura (`:161`). Bajo contexto de inquilino son 4 viajes por consulta, así que **un CFDI de 20 conceptos cuesta ~100 viajes y 25 préstamos de conexión del pool**. `withTransaction` está importado en `:4` y no se usa en esta ruta.

**Escenario de fallo concreto:** ingesta de 10 000 CFDI de 20 conceptos. La caída del proceso en el comprobante 4 000 deja **ese** documento con 11 de sus 20 conceptos escritos y confirmados: no hay `ROLLBACK` que los recoja, la deduplicación por UUID hará que el reintento lo **salte** por existir, y el CFDI queda permanentemente con líneas de menos. Es una pérdida de datos silenciosa en el camino de ingesta principal.

---

### 8 · [NUEVA] · **MEDIA** · `stageEntryImport` lee el archivo entero a memoria y hace un `INSERT` por fila dentro de una sola transacción abierta

`src/cli/entry-command.ts:722` hace `readFileSync(file, 'utf-8')` —el archivo completo como cadena de JavaScript— y se lo pasa a `parseImportFile`, que construye el lote entero en memoria (`entry-import-service.ts:106-112`). Después, `stageEntryImport` (`:139-158`) abre **una** transacción y, dentro, ejecuta `for (const fila of entrada.lote.filas) { await client.query(INSERT …) }`.

Dos costes en el mismo sitio: el archivo se materializa dos veces (texto crudo + grafo de objetos), y la transacción permanece abierta durante N viajes secuenciales. Sin `idle_in_transaction_session_timeout` (hallazgo 3), esa transacción no tiene quien la corte.

**Escenario de fallo concreto:** un CSV de 100 000 pólizas (~40 MB). El archivo y su grafo de objetos ocupan cientos de MB antes de tocar la base; después, 100 000 viajes secuenciales dentro de una transacción abierta ~4 minutos. Esa transacción sostiene su instantánea todo ese rato, bloqueando el `VACUUM` de `journal_entry_import_rows` y de cuanto toque, y si el proceso muere en la fila 90 000 el `ROLLBACK` desecha las 90 000 y el operador vuelve a empezar de cero. Un `COPY` o un `INSERT` multi-fila haría lo mismo en segundos.

---

### 9 · [NUEVA] · **MEDIA** · Las vistas materializadas son globales y cruzan inquilinos: el `sync` de un despacho reconstruye los de todos

`004_partitioning_and_views.sql:28-53` define `mv_trial_balance` como `accounts CROSS JOIN fiscal_periods LEFT JOIN journal_entry_lines LEFT JOIN journal_entries`, **sin filtro de inquilino ni de entidad**. Es una foto de todo el clúster. Medido:

| operación | tiempo a esta escala |
|---|---|
| `REFRESH MATERIALIZED VIEW` (ambas) | 2,26 s |
| `REFRESH … CONCURRENTLY` (ambas, es el modo por omisión, `materialized-view-service.ts:73`) | **3,10 s** |

`mv_trial_balance` tiene 120 000 filas (10 000 cuentas × 12 periodos) con sólo 198 000 asientos cargados. El `CONCURRENTLY` es más caro porque construye una copia completa y la reconcilia; el índice único que lo permite existe (`004:55`), así que la ruta es correcta — pero es **O(instalación entera)**, no O(lo que cambió), y no hay refresco incremental ni por inquilino.

La 042 quitó el disparador —esa es la mitad resuelta— pero dejó la **granularidad**: su propio comentario nombra el problema («sobre vistas GLOBALES que cruzan TODOS los inquilinos», `042:5-6`) y sólo arregla el *cuándo*, no el *cuánto*.

**Escenario de fallo concreto:** hoy nada lee las vistas (verificado: el único llamador de `refreshReportingViews` es `report-command.ts:635`), así que el daño está latente. El día que un informe las consuma, el inquilino A corre `report view sync` y paga la reconstrucción del mayor del inquilino B: a 50 entidades × 100 000 asientos (≈ 25× mi carga) son **~75 s de un solo `REFRESH`**, imputados a quien lo pidió y bloqueando a quien lo pida después. El detector de deriva, en cambio, sí es por entidad y cuesta lo razonable: `report vista ver` = 1,7 s, de los que 0,91 s son la balanza sin filtro de `getReportingViewStatus` (`materialized-view-service.ts:106`).

---

### 10 · [NUEVA] · **MEDIA** · El disparador de inmutabilidad de la 041 deja sin camino de migración a la corrección del hallazgo 1

`041_el_mayor_inviolable.sql:68-99` instala `BEFORE UPDATE OR DELETE ON journal_entry_lines FOR EACH ROW`, que rechaza cualquier `UPDATE` sobre una línea de asiento posteado salvo las tres columnas de conciliación (`:70`). Lo topé de frente al montar el experimento del hallazgo 1: el `UPDATE journal_entry_lines SET tenant_id = …` murió con

```
ERROR: journal_entry_lines: una línea de asiento POSTEADO no se edita … (NIF B-1).
```

y sólo pasó con `SET session_replication_role = replica`. **Esto es correcto y es lo que la 041 existe para hacer.** El hallazgo es la consecuencia: cualquier migración futura que necesite desnormalizar una columna sobre `journal_entry_lines` —empezando por la que arregla la RLS— tiene que desactivar el disparador, y hacerlo bajo RLS forzada la mete de lleno en el hallazgo 3 de la auditoría II (*«el DML de migración bajo RLS rellena cero filas, en silencio»*). Los dos se componen: **una migración de relleno sobre esta tabla puede fallar ruidosamente por el disparador o, si lo desactiva, rellenar cero filas calladamente por la RLS.**

Nota menor del mismo disparador: no lleva cláusula `WHEN`, así que el único `UPDATE` legítimo —marcar una línea conciliada— paga una función plpgsql con un `SELECT` al padre (`:76`) por cada fila. En una conciliación de 10 000 líneas son 10 000 sondas extra.

---

### 11 · [II-EXAGERADA] · La auditoría II afirma que el sistema particiona `journal_entry_lines`. No particiona — y sus propias dos lentes se contradicen

`docs/auditorias/2026-09-01-integral-ii/instrumento-ii.md:59` dice literalmente: «ni una comprobación de que las **particiones de `journal_entry_lines`** se usan. **El sistema particiona** (`004_partitioning_and_views.sql`) y nada mide que la partición sirva».

**Falso, verificado en el clúster** tras aplicar las 52 migraciones: `SELECT count(*) FROM pg_class WHERE relkind = 'p'` devuelve **0**. Ninguna tabla particionada, ninguna partición. La propia 004 lo dice en su comentario (`004:10-11`): «*Create a partitioned copy (note: in production, migrate data with pg_partman) — For now, create partition-ready indexes on the existing table*». Lo que entregó fueron cinco índices.

Lo notable es que **la misma auditoría II lo tenía bien en otra lente**: `practicas-ledger.md:128` escribe «la 004 sigue **prometiendo** particionado en un comentario … y creando sólo índices». Dos lentes del mismo informe, la misma migración, conclusiones opuestas — y `instrumento-ii` es la que un lector encuentra primero al buscar «rendimiento». El error no nace ahí: `docs/plan-cierre-brechas.md:1623` ya afirmaba «004_partitioning_and_views.sql **solo particiona journal_entry_lines**», y la lente lo heredó sin comprobarlo.

**Escenario de fallo concreto:** alguien planifica el crecimiento de `journal_entry_lines` creyendo que hay particionado por rango del que colgar retención y desprendimiento de particiones frías, y descubre en el despliegue que la tabla es un montón único de 20 M de filas. El plan de retención del CFF art. 30 se apoya en una máquina que no existe.

---

### 12 · [II-SIGUE-VIVA] · Cero criterios de rendimiento en el instrumento — y ahora hay números que meterle

`instrumento.md:315` y `producto-y-operacion.md:85` de la auditoría II lo dijeron: «cero apariciones de `EXPLAIN`, índice o *benchmark* en `src/plan/criterios.ts` y en `tests/`». **Sigue vivo en `cfe40c6`.** Re-medido: el único criterio de los 70 que roza la carga es `criterios.ts:1675-1683` («Postear no dispara el refresco de vistas materializadas»), y es una **regex sobre `posting.ts`** buscando `REFRESH MATERIALIZED` — mide texto, no conducta, y no fija ningún techo. Ni un umbral de latencia, ni una fixture de volumen, ni un `EXPLAIN`.

La diferencia con la auditoría II es que ahora la brecha tiene contenido: los números de los hallazgos 1, 2, 4 y 9 son exactamente el material de un criterio de trinquete —«la balanza de un periodo sobre la base de volumen no supera X ms», «el plan de la balanza no contiene `loops=` mayor que el número de cuentas»— y son verificables por **conducta**, que es justo lo que `instrumento-ii.md` reclama para los 66 criterios de regex.

**Escenario de fallo concreto:** el hallazgo 1 se arregla, y seis semanas después una migración añade una tabla hija nueva a la lista de `rls-policies.sql:148-166`. Vuelve la política `EXISTS`, vuelve el `loops=400000`, y ningún criterio se pone rojo: el instrumento no sabe medir eso.

---

### 13 · [II-CERRADA] · El refresco salió del camino de posteo, y esta vez está comprobado en el clúster

`producto-y-operacion.md:23` de la auditoría II lo llamó «la corrección de escala más importante que se ha hecho». **Confirmado por conducta, no por lectura:** tras aplicar las 52 migraciones, los disparadores de usuario sobre `journal_entries` son sólo `journal_entries_posteado_inmutable` y `journal_entries_sin_truncate`. `trg_refresh_materialized_views` no existe (`042:25-26` lo elimina). Y las 50 corridas de `createJournalEntry` del hallazgo 4 no refrescaron nada: a 11,8 ms por asiento de 2 líneas, un `REFRESH CONCURRENTLY` de 3,1 s sería imposible de esconder.

Queda pendiente su mitad —la granularidad global— en el hallazgo 9.

---

### 14 · [NUEVA] · **BAJA** · Tres índices sobre `journal_entry_id` donde basta uno, y uno que es prefijo de otro

Medido en el clúster (`pg_stat_user_indexes` sobre 792 000 líneas):

| índice | definición | tamaño | veredicto |
|---|---|---|---|
| `journal_entry_lines_..._line_number_key` | UNIQUE `(journal_entry_id, line_number)` | 31 MB | necesario |
| `idx_jel_entry` (`001:296`) | `(journal_entry_id)` | 11 MB | **redundante** (prefijo de la UNIQUE) |
| `idx_jel_entry_date` (`004:12`) | `(journal_entry_id)` | 11 MB | **duplicado exacto** del anterior |
| `idx_jel_account_date` (`004:13`) | `(account_id, journal_entry_id)` | 38 MB | necesario |
| `idx_jel_account` (`001:297`) | `(account_id)` | 5,7 MB | **redundante** (prefijo del anterior) |

**27,7 MB de los 125 MB de índice de la tabla no aportan nada**, y cada `INSERT` de línea —dos por línea en el camino caliente del hallazgo 4— mantiene los cinco. A 20 M de líneas son ~700 MB muertos. Añado que `idx_jel_entry_date` está mal nombrado: la 004 lo creó bajo el rótulo «partition-ready» y no contiene columna de fecha alguna.

**Escenario de fallo concreto:** ninguno catastrófico — es un impuesto de escritura y de memoria, del orden del 20 % del índice de la tabla más grande del sistema. Lo reporto porque es la corrección más barata del informe y porque el nombre `idx_jel_entry_date` induce a error a quien busque por qué el mayor por fechas va lento.

---

## RECOMENDACIONES

### Plan Maestro — tienen que entrar a la secuencia

**R1 · (M) · Tramo E2 (perímetro / aislamiento), inmediatamente después de E2.1.** Sustituir la política hija por comparación directa: añadir `tenant_id NOT NULL` a `journal_entry_lines` (y luego al resto de las 19 hijas de `rls-policies.sql:148-166`) y cambiar el generador de `:176-180` a `USING (tenant_id = app_current_tenant())`. **Efecto medido: 782 ms → 111 ms, mismo SQL, misma RLS forzada.** La migración de relleno tiene que sortear el hallazgo 10 y el hallazgo 3 de la auditoría II: `session_replication_role = replica` **y** contexto de inquilino explícito, con `RAISE` si el `ROW_COUNT` no casa con el `COUNT(*)` previo. Es la corrección de mayor razón coste/beneficio del informe.

**R2 · (S) · Tramo E2, mismo paquete que R1.** `statement_timeout`, `lock_timeout` e `idle_in_transaction_session_timeout` en la cadena de conexión de la aplicación (`options=-c statement_timeout=30s…`), más `connectionTimeoutMillis` y `idleTimeoutMillis` en `connection.ts:54-58`, y `server.requestTimeout` en `index.ts`. Rojos honestos: un informe que tarda demasiado debe **fallar diciéndolo**, no colgar el pool. Sin esto, R1 mejora el caso medio y deja intacto el modo de fallo.

**R3 · (M) · Tramo E4 (reportes) o E1 (ledger), donde caiga el posteo por lote.** `INSERT` multi-fila para las líneas (`posting.ts:132-134`) y un solo `UPSERT` agregado para `account_balances` (`:206-207`): de ~35 viajes por asiento de 16 líneas a ~6. No toca el candado del folio —que es correcto— pero acorta la transacción que lo retiene, que es lo que fija el techo de 20,8 asientos/s.

**R4 · (L) · Tramo posterior, y sólo cuando algo lea las vistas.** Vistas materializadas **por inquilino** (o refresco incremental por entidad). Hoy es latente porque nadie las consume; el día que un informe las lea, el `sync` de uno paga el mayor de todos. Mientras tanto, basta con documentar que `report view sync` es una operación de instalación completa.

**R5 · (M) · Tramo A (instrumento), junto a R10 de la auditoría II.** Una fixture de volumen y dos o tres criterios de conducta con techo: la base de este informe se reconstruye desde cero en ~30 s y los guiones quedan en el directorio de trabajo de esta sesión (`carga.sql`, `cfdi.sql`, `bal2.sql`, `cand0.sql`, `post-bench.ts`). Con eso, el criterio «la balanza de un periodo no supera X ms sobre la base de volumen» es verificable **por mutación en ambas direcciones**: revierte R1 y se pone rojo. Es exactamente el tipo de criterio que `instrumento-ii.md` reclama y que hoy no existe (hallazgo 12).

**R6 · (S) · Donde se archive esta auditoría.** Corregir `instrumento-ii.md:59` y `plan-cierre-brechas.md:1623`: **no hay particionado**. Es una línea en dos archivos y evita que alguien planifique retención sobre una máquina inexistente.

### Afinación — no bloquean la secuencia

**A1 · (M) · Conciliación.** Reescribir `autoMatchUnreconciled` (`matching.ts:369-407`) para traer los candidatos **una vez** por lote en vez de una por transacción, y añadir un índice de expresión `ON journal_entry_lines (ABS(COALESCE(debit_amount, credit_amount))) WHERE is_reconciled = false`. Acotar además el `SELECT` de `:373` y el arreglo `results` de `:378`.

**A2 · (S) · Ruta masiva.** `.max(500)` en `bulkPreRegSchema.ids` (`xml-ingestion.ts:80`) y devolver `413` con el tope dicho. Una línea.

**A3 · (S) · Mayor.** Tapar `--all` en algo como 50 000 movimientos con mensaje explícito, o pedir `--offset` explícito por encima de ese tope (`report-command.ts:455`). El comando ya sabe decir la verdad sobre el truncamiento; sólo hace falta que la diga también aquí.

**A4 · (M) · Importación.** `COPY` o `INSERT` multi-fila en `stageEntryImport` (`entry-import-service.ts:152-157`), y `withTransaction` alrededor de `processXMLUpload` (`pre-registration-service.ts:69-161`) para que un CFDI y sus conceptos entren o no entren juntos. Lo segundo es una corrección de **integridad** disfrazada de rendimiento.

**A5 · (S) · Índices.** `DROP INDEX idx_jel_entry, idx_jel_entry_date, idx_jel_account`. 27,7 MB y tres mantenimientos por `INSERT` menos, sin perder ninguna ruta de acceso.

**A6 · (M) · Ingesta.** `mnemosine ingest --from-dir` (y, si algún día hay descarga del SAT, `--from-zip`) para dejar de depender de `argv`, con lote y reanudación. Hoy la deduplicación por UUID hace las veces de reanudación por accidente; conviene que sea por diseño.
