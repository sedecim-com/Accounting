# LENTE 6 — AGENTIC AI: el estado del agente y lo que le falta para ser AI-first de verdad

**Medido contra el árbol de trabajo vivo, no contra HEAD.** HEAD real es `6e280dd` (no `a149e62` como decía el contexto), y lo esencial de A3/A4 —`src/ai/budget.ts`, `src/ai/shadow-verdicts.ts`, `src/ai/untrusted.ts`, la migración `047`— está **sin commitear** (`git status`: untracked). Todo lo que dictamino como CERRADO vive hoy en un árbol sucio: si ese árbol se pierde, se pierden 7 cierres.

**Nota de método:** durante la auditoría, tres sitios mutaron y volvieron bajo mis pies (`budget.ts:44` perdió `opts.unattended ? 'block' : 'warn'`; `shadow-verdicts.ts:28` perdió `ON CONFLICT (draft_id) DO NOTHING`; y algo del camino de sombra). Corría una pasada de mutación en paralelo. Lo aprovecho como dato: con la mutación de sombra viva, `npm run plan:status` marcó rojo *«la sombra dejó de excluir autoPost encendido»* — **ese criterio muerde**. Árbol limpio: `E5.1 13/15`, `10 de 15 paquetes verdes`. `npx tsc --noEmit` limpio; `npm test` 2185/2185 en 142 archivos.

---

## FORTALEZAS (verificadas, no recordadas)

1. **La sombra es una compuerta de verdad, no un adorno.** `ingest_auto_post = 'shadow'` corre TODAS las compuertas con el **mismo evaluador puro** que el modo real (`evaluarAutoPost`, `src/ai/ingest-service.ts:343-410`), registra el veredicto y no postea (`ingest-service.ts:242-266`). No hay copia privada de las compuertas: la sombra no puede medir un clasificador que no existe.

2. **Y encender exige historial.** `resolvePolicy` bloquea `ingest_auto_post='on'` sin 7 días de veredictos, 10 decididos por humano y acuerdo ≥0.9 (`src/services/policy/policy-service.ts:167-186`, pisos en `src/ai/floor.ts:69-71`). El guard vive en `resolvePolicy` y no en el CLI **a propósito**, porque hay dos llamadores (pending define y el wizard de init) — un guard en uno solo habría sido puerta trasera. Es la pieza de diseño más madura de esta capa.

3. **La sospecha de inyección ya es integridad no negociable.** `evaluarAutoPost` devuelve `integridad: true` ante `suspicion.length > 0` (`ingest-service.ts:353-359`), y la clase `integridad` es la que **ninguna política puede saltar** (`ingest-service.ts:268-272`). S1 cerrado con un `if`, como se recomendó.

4. **El UNTRUSTED de segundo orden tiene una sola implementación.** `envolverDatosDeTerceros` (`src/ai/untrusted.ts:33-40`) con neutralización de marcadores, consumida por seis superficies de herramientas (`draft-tools`, `external-tools`, `ledger-tools`, `report-tools`, `search-tools`, más `tools/index.ts:2`). Se acabaron las tres copias privadas.

5. **El presupuesto corta en el único punto donde nacen las sesiones.** `assertWithinBudget` en `createLlmSession` (`src/ai/providers/index.ts:76-77`), guard que muerde **al entrar a cada turno** (`providers/index.ts:117-124`), fallo de medición **cerrado** en block (`budget.ts:182-187`), y turnos sin precio contados para decir que el estimado va por debajo (`budget.ts:59, 88-91`). E5.1-e rescatado.

6. **Un solo sistema de autorización, y la política ya no es huérfana.** `autoApproveDraftByPolicy` tiene llamador de producción (`ingest-service.ts:281`), con `configuredMaxAmount` **obligatorio** para que ninguna política autorice por encima del tope del operador, y las políticas nunca saltan integridad.

7. **La calibración se lee del rastro, no de una columna inventada.** `estadisticasDelAgente` reconstruye el destino de cada borrador de la atribución que los caminos dejan a propósito (nota `auto-post by threshold%` vs `reviewed_by LIKE 'policy:%'`) y publica el **delta confianza-vs-realidad** por bucket (`src/ai/stats-service.ts:80-125`). El criterio del tablero lo verifica **por conteo** (≥3 notas, ≥2 prefijos), no por presencia — la lección de R1 aplicada.

8. **El agente deja rastro medible.** Migración `044`: `ai_usage.duration_ms`, `ai_ingest_runs` (counts + consumo por corrida) y `ai_agent_events` (sospecha/nudge/failover como filas). El delito menor deja rastro antes de discutir la autonomía mayor.

---

## BRECHAS

### 1. El piso de evidencia guarda UNA de las TRES puertas al auto-posteo — SIGUE-ABIERTA (NUEVA, y es la mayor)

Todo el aparato A4 existe para que encender el auto-posteo sea una decisión con historial. Pero el piso vive **solo** en `resolvePolicy`. Las otras dos puertas no lo tocan:

- **La bandera.** `--auto-post` (`src/cli/mnemosine.ts:1159`) entra como `overrides.autoPost` y pisa todo **incondicionalmente** (`src/ai/ingest-thresholds.ts:64-67`). `gateMutation` (`src/cli/kernel/risk.ts:173-217`) **no pide confirmación ni `--yes`** para riesgo `irreversible`: sólo exige `--reason` a verbos que deshacen. Verificado: no hay prompt en toda la acción de ingest (`mnemosine.ts:1170-1420`). Es decir, **`mnemosine ingest --auto-post *.xml` en un crontab postea al mayor sin humano y sin un solo día de sombra.**
- **El archivo.** `if (archivo.autoPost !== undefined) { autoPost = archivo.autoPost; }` (`ingest-thresholds.ts:59-62`), también incondicional: un `mnemosine.config.json` con `ingest.auto_post: true` enciende aunque el panel diga `shadow`.
- **La política de aprobación.** `grantApproval` (`src/ai/approval-policy.ts:105-133`) crea una política que auto-aprueba borradores y **no consulta `concordanciaSombra` en ninguna línea**. Es una tercera vía al mayor sin humano, sin ningún requisito de evidencia.

Lo que convierte esto en brecha y no en decisión de diseño es la **inconsistencia interna**: el propio archivo argumenta *«apagar siempre puede ser más local que encender»* (`ingest-thresholds.ts:78-82`), y esa asimetría **está implementada para `maxAmount`** —el archivo sólo gana si es más estricto (`ingest-thresholds.ts:83-90`)— y **no está implementada para `autoPost`**. El principio está escrito y aplicado a la variable menos peligrosa de las dos.

### 2. La sombra nunca simula la puerta de la política, así que su concordancia miente a la baja — SIGUE-ABIERTA (NUEVA)

En modo sombra el código **retorna antes** de llegar a la vía de política (`ingest-service.ts:242-266` retorna; la vía de política vive en `:268-295`). Un borrador que falla una compuerta discrecional pero casa una política otorgada se registra como `would_auto_post = false`; en modo real, **ese mismo borrador postea**. Como `concordanciaSombra` (`src/ai/shadow-verdicts.ts:50-73`) es la evidencia que desbloquea `'on'`, **la evidencia se mide contra un sistema más débil que el que desbloquea**. Cuanto más políticas tenga el despacho, más optimista es el número que autoriza soltar.

### 3. El golden set existe y NUNCA se ha corrido — MUTÓ (era «no existe harness»)

A1 entregó el instrumento y es bueno: 9 pares xml+esperado (`tests/golden/cfdi/`, incluidos `ask-*` que miden la humildad de preguntar y `sospechoso-inyeccion`), arnés por el camino real (`ingestCfdiFiles`) con proveedor **fijado** y base efímera (`scripts/eval-clasificador.ts:1-30`), puntuación **por clase** sin promedios que escondan, con la clase `abstencion` (`src/ai/eval/puntuacion.ts:1-21`). Pero:

- **`docs/evals/clasificador.jsonl` no existe.** El directorio contiene sólo `README.md`. Cero corridas registradas.
- **No hay script npm** (`package.json` tiene 18 scripts; ninguno es `eval`).
- **No hay CI**: `.github/workflows/ci.yml` no menciona `eval-clasificador`.
- Y el criterio del tablero (`src/plan/criterios.ts:2009-2046`) verifica **la forma del arnés** —que exista el corpus, que fije proveedor, que llame a `ingestCfdiFiles`, que puntúe abstención— y **nunca que exista una medición**. Es verde por instrumento, no por medida: exactamente el patrón que este repositorio persigue.

La brecha madre no está cerrada; cambió de «no hay con qué medir» a «hay con qué medir y nadie ha medido». Y la exactitud del clasificador sigue siendo, hoy, un número que nadie ha visto.

### 4. `minConfidence` gobierna el mayor y vive fuera del panel — SIGUE-ABIERTA (NUEVA)

`resolverUmbralesConPanel` consulta el panel para `ingest_auto_post` e `ingest_auto_post_max_monto`, pero para `minConfidence` la precedencia es sólo **bandera > archivo > omisión** (`ingest-thresholds.ts:96-105`): no hay `getPolicy`. «Qué tan segura debe estar la máquina antes de postear sin humano» es una bifurcación de criterio contable de manual, y la regla de la casa (a) la manda al panel. Hoy la decide un JSON local sin bitácora — justo el hueco que `ingest_auto_post` ya dejó atrás.

### 5. El presupuesto está apagado por omisión y nada lo dice — SIGUE-ABIERTA (residual del cierre 7)

`assertWithinBudget` retorna sin consultar nada cuando no hay ni `dailyUsd` ni `monthlyUsd` (`budget.ts:174-177`). Es opt-in por diseño, pero el efecto es que **una instalación por defecto no tiene tope**, que es el estado en el que estará todo despacho el día uno. No hay chequeo en `doctor` (`grep budget src/ai/doctor-service.ts` = 0) ni superficie que lo muestre (`mnemosine ai` sólo tiene `stats`). El «desatendido corta» de `budget.ts:44` sólo muerde después de que alguien escribió la sección.

### 6. El feedback de rechazos y correcciones se sigue tirando — SIGUE-ABIERTA

`rejectDraft` escribe `review_notes` y termina (`src/ai/draft-service.ts:554-569`). No hay flujo corregir-y-aprobar en ningún lado. El diff modelo-vs-humano es la señal de entrenamiento más rica que el sistema produce y sigue muriendo en una columna de texto que nada lee.

### 7. Nada liga un borrador a su evidencia — SIGUE-ABIERTA (NUEVA)

`ai_drafts` (`src/database/migrations/011_ai_drafts.sql:9-34`, con una sola alteración posterior en `019`) **no tiene columna de origen**: ni `xml_document_id`, ni `source_type`, ni `ingest_run_id`, ni `session_id`. `ai_reasoning` es prosa libre. Consecuencias concretas: no se puede unir por consulta un asiento posteado al CFDI que lo produjo, ni a la corrida que lo generó, ni a las filas de `ai_usage` que lo pagaron. Por eso `costo_por_borrador_usd` es una división de agregados, no un costo por acto. Y por eso **un paquete de cierre auditable no se puede armar con una consulta** — que es precisamente lo que un despacho necesita entregar.

### 8. La memoria sigue siendo léxica y sin resolución de conflicto — SIGUE-ABIERTA

Recuperación por `ILIKE` de subcadena (`src/ai/question-service.ts:147`, `src/ai/memory-service.ts:49-50`); cero embeddings. Dos precedentes contradictorios activos sobre el mismo tema conviven, y «el más reciente gana» sigue siendo una frase del prompt, no una propiedad. Ni poda, ni validación de precedentes contra cuentas que dejaron de existir.

### 9. Sin proveedor, el lote se cae por archivo — SIGUE-ABIERTA

`ingest-service.ts:206`: `return { file: name, status: 'error', detail: 'Model failure: …' }`. Sigue sin existir el estado «registrado, pendiente de clasificación manual». Y `JOB_KINDS` sigue en tres, los tres con LLM (`src/ai/jobs/job-store.ts:20`): no hay ejecutor determinista de jobs.

### 10. El cierre sigue sin conductor — SIGUE-ABIERTA

`close-service.ts` exporta cuatro lecturas (`listClosablePeriods`, `nextPeriodToClose`, `getAiBlockers`, `getCloseReadiness`) y nada más. **No existe tabla ni concepto de corrida de cierre**: `grep -rn "close_run|corrida_cierre|closeRun" src/` = 0 resultados. Hay piezas y no hay orquestador, ni checkpoint humano de soft/hard close, ni paquete de cierre.

### 11. Un solo modelo para todo: no hay enrutamiento por tarea ni por costo — SIGUE-ABIERTA (NUEVA)

`makeRunAgentTurn` llama `createLlmSessionWithFailover(undefined, …)` (`src/cli/mnemosine.ts:278`) — **perfil por omisión para los tres kinds de job**, y la ingesta usa `resolveProfile(opts.provider, opts.model)` (`mnemosine.ts:1256`). Clasificar un CFDI trivial de renta y conducir una investigación de bloqueadores de cierre corren en el mismo modelo al mismo precio. El failover es por **fallo**, nunca por **tarea o costo**. La infraestructura de perfiles ya existe; el enrutamiento no.

### 12. No hay evaluación continua en producción ni detección de deriva — SIGUE-ABIERTA (NUEVA)

`grep -rni "deriva|drift" src/ai/` sólo devuelve el drift de hash de aprobación (`draft-service.ts:334,372`) y el de índice de búsqueda: nada sobre deriva del **modelo o proveedor**. El eval es un script manual contra un corpus fijo; `ai stats` es una foto acumulada sin serie temporal ni corte por `ai_model` (`stats-service.ts:80-105` agrupa sólo por bucket de confianza). Cuando el proveedor cambie el modelo detrás del mismo nombre —lo que ocurre— **nada lo notará**: ni el acuerdo de sombra por semana, ni el delta de calibración por versión de modelo, ni una alarma sobre `ai_agent_events.sospecha`.

### 13. La cabecera de `ingest` no confiesa que la sombra está corriendo — SIGUE-ABIERTA (NUEVA, menor)

`grep -n "sombra|shadow" src/cli/mnemosine.ts` = 0. Con el panel en `shadow`, la cabecera imprime `no auto-post (everything to draft)` (`mnemosine.ts:1266-1270`), sin decir que se están registrando veredictos. Aparece por archivo en el `detail`, pero el encabezado —lo que el operador lee— omite el hecho.

### 14. Los dos rojos honestos vivos de E5.1 siguen rojos — SIGUE-ABIERTA (confirmado por medidor)

`npm run plan:status`: (a) *las herramientas del agente se derivan del registro de riesgo* — `allDeclarations` sin consumidor fuera del núcleo; la superficie desatendida está **nombrada** pero escrita a mano. (b) *`--continue` rehidrata el contexto que promete* — verificado en `src/cli/mnemosine.ts:767-780`: se imprimen los últimos 6 mensajes como recordatorio **para el humano** y se avisa `(reminder only — the model starts with a fresh context)`. `CreateLlmSessionOptions` no acepta historial. Honestidad ejemplar en el mensaje; capacidad ausente.

---

## RECOMENDACIONES

1. **(S) Cerrar las tres puertas con el mismo piso.** Mover el chequeo de `concordanciaSombra` a un solo lugar por el que pasen las tres: que `resolverUmbralesConPanel` degrade `autoPost=true` a sombra cuando el piso no se cumple, sea cual sea la fuente, y que `grantApproval` con `scope:'draft'` exija la misma evidencia. Y aplicar a `autoPost` la asimetría que `maxAmount` ya tiene: archivo y bandera pueden **apagar**, nunca encender. Fase: A4-bis, antes que cualquier cosa de F06.
2. **(S) Que la sombra simule la puerta completa.** Extraer un `simularPolitica` que, en modo sombra, consulte `matchApproval` sin aplicar, y registrar `would_auto_post` con esa vía incluida más `via: 'umbral'|'politica'` en `thresholds`. Sin esto, el número que autoriza soltar está sesgado a la baja.
3. **(S) Correr el eval y hacer que el criterio exija la medición.** `npm run eval:clasificador`, una corrida registrada en `docs/evals/clasificador.jsonl`, y endurecer el criterio de `criterios.ts:2009` para que **falle si la bitácora está vacía o su última corrida es más vieja que el último cambio de `system-prompt.ts`/`draft-tools.ts`**. Un criterio que sólo mira la forma del arnés es el verde falso que este repo persigue.
4. **(S) `ingest_auto_post_min_confianza` al panel.** Una clave más en `pending-catalog.ts`, un `getPolicy` más en `ingest-thresholds.ts`, con la misma asimetría del punto 1. Cumple la regla (a) para la última compuerta que la incumple.
5. **(S) El presupuesto visible.** `mnemosine ai budget` (límites, gasto del día y del mes, turnos sin precio) y un chequeo en `doctor` que avise —nunca `fail`— cuando una entidad con jobs habilitados no tiene sección `budget`.
6. **(M) Ligar el borrador a su evidencia.** Migración: `ai_drafts.source_document_id`, `source_type`, `ingest_run_id`, `session_id`. Desbloquea de golpe el costo por acto real, la trazabilidad hasta el CFDI, y el paquete de cierre por consulta. Es el habilitador barato de la recomendación 9.
7. **(M) Cerrar el lazo de feedback.** Corregir-y-aprobar que guarde el payload editado junto al propuesto; el diff se vuelve precedente automático con el emisor como topic. Hoy se tira la mejor señal que el sistema produce.
8. **(M) Enrutamiento por tarea.** `KIND_PROFILES: Record<JobKind, string|undefined>` y un perfil por defecto para ingesta distinto del de chat. La infraestructura de perfiles y el ledger de costo ya existen; falta la tabla de ruteo y que `makeRunAgentTurn` deje de pasar `undefined`.
9. **(M) Vigilancia continua, no sólo golden set.** Serie semanal de acuerdo de sombra y de delta de calibración, **cortada por `ai_model`**, colgada de `ai stats --serie`; alarma en `doctor` cuando el acuerdo cae bajo el piso o cuando aparece un `ai_model` nuevo sin corrida de eval. Es la detección de deriva de proveedor, y hoy no existe en ninguna forma.
10. **(M) Memoria con higiene.** Detección de conflicto al enseñar (mismo topic, respuesta contradictoria → pedir resolución humana en vez de coexistir) y validación de precedentes contra el catálogo colgada de `doctor`. Los embeddings pueden esperar; la resolución de conflicto no.
11. **(M) Degradación explícita.** Estado `pendiente_clasificacion` en vez de `error` cuando no hay proveedor, y al menos un `JobKind` determinista sin LLM. El sistema determinista sobrevive entero; el reporte no lo refleja.
12. **(L) El conductor del cierre — y no antes que 1-3.** `close_runs` con plan determinista de pasos, cada paso produciendo borradores staged, checkpoints humanos en soft y hard close, y un paquete de cierre auditable (que la recomendación 6 hace posible). Va al final a propósito: un agente que conduce el cierre sin el eval corrido, sin la sombra honesta y con tres puertas abiertas al mayor es precisamente el verde-por-no-mirar que este repositorio aprendió a perseguir.

---

## ¿Le confiaría un despacho el cierre de mes sin mirar?

**No, y falta menos de lo que parece.** Lo que separa a mnemosine de sus pares no es defensa ni gobierno —ahí va por delante: el mayor es inalcanzable para el agente por construcción, la sombra es real, el piso es inquebrantable, la sospecha ya es integridad—. Lo que falta es **tres cosas concretas**: que el piso de evidencia cubra las tres puertas y no una (brecha 1), que la evidencia mida el sistema que desbloquea (brecha 2), y que alguien **corra el eval que ya está escrito** (brecha 3). Ninguna es un proyecto: dos son `if`s en el lugar correcto y la tercera es un comando.

Después de eso, lo que impide el cierre desatendido es una ausencia, no un defecto: **no hay conductor de cierre y no hay hilo del asiento a su evidencia**. Un despacho no delega lo que no puede auditar después, y hoy no existe la consulta que reconstruya «este asiento salió de este CFDI, en esta corrida, con este precedente, y costó esto».


---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** El piso de evidencia de sombra que A4 construyó guarda UNA de las tres puertas al auto-posteo: `resolvePolicy` exige 7 días y acuerdo ≥0.9 para encender (src/services/policy/policy-service.ts:167-186), pero `--auto-post` (src/cli/mnemosine.ts:1159 → src/ai/ingest-thresholds.ts:64-67), el archivo del operador (ingest-thresholds.ts:59-62) y `grantApproval` (src/ai/approval-policy.ts:105-133) encienden sin tocarlo — y `gateMutation` no pide confirmación (src/cli/kernel/risk.ts:173-217), así que `mnemosine ingest --auto-post` en un crontab postea al mayor sin humano y sin un solo día de sombra.

**¿Refutado?** No: se sostiene

SE SOSTIENE en su núcleo, con una pata exagerada (grantApproval) y el reparto de puertas mal contado.

CONFIRMADO — la compuerta de evidencia es de UNA sola puerta. `resolvePolicy` cobra el peaje solo cuando `key === 'ingest_auto_post' && value === 'on'` (src/services/policy/policy-service.ts:167-186), y ese es el único punto del repo donde se llama a `concordanciaSombra` con FLOOR (grep: los únicos usos de FLOOR_SOMBRA_* fuera de floor.ts/criterios están en policy-service.ts:173-183 y en policy-preview.ts:80, que solo PREVISUALIZA). El propio criterio del plan (src/plan/criterios.ts:2244-2253, paquete E5.1) solo exige el guard en resolvePolicy: el hueco no está cubierto ni por la vara de aceptación.

CONFIRMADO — la bandera y el archivo encienden sin tocar el piso. En src/ai/ingest-thresholds.ts la política se lee (53-59) y luego el archivo (60-62) y la bandera (64-67) reescriben `autoPost` incondicionalmente, sin releer sombra. Y hay un test que lo AFIRMA como conducta deseada: tests/ai/frontera-desatendida.spec.ts:90-99 («la bandera explícita gana a todos») pone panel `'off'` + archivo `false` + `{autoPost:true}` y espera `autoPost === true`, fuente `'bandera'`. Peor: la asimetría con `maxAmount` es explícita — el tope del archivo SOLO gana si es más estricto (ingest-thresholds.ts:78-87, test 125-137), mientras que `autoPost` del archivo gana en las dos direcciones, contradiciendo su propio comentario justificante («apagar siempre puede ser más local que encender», líneas 25-28): un `auto_post: true` en mnemosine.config.json enciende aunque el panel diga 'off' o 'shadow'.

CONFIRMADO — no hay confirmación. `declareRisk` inyecta `-y, --yes` («skip the confirmation prompt») a toda clase irreversible (src/cli/kernel/risk.ts:135-138), y el auditor la exige (src/cli/kernel/audit.ts:127-136), pero `gateMutation` (risk.ts:173-217) solo devuelve `{dryRun, live, reason}` — no existe prompt en el kernel. El handler de `ingest` (src/cli/mnemosine.ts:1174-1335) declara `yes?: boolean` en su tipo de opts y NUNCA lo lee: no hay `opts.yes` ni `stdin.isTTY` en ese rango. Los únicos dos sitios que confirman de verdad son mnemosine.ts:1426-1431 y 1621-1626, y ambos implementan justo el patrón que faltaría aquí («no hay terminal para preguntar» → abortedByUser). Es decir, el escenario del crontab está resuelto en los hermanos y no en ingest.

Resultado: `mnemosine ingest --auto-post` (o un `auto_post: true` en el json del operador) con `ingest_auto_post` en 'off', 'shadow' o sin contestar, ejecutado sin TTY, llega a `approveDraft` y postea al mayor (src/ai/ingest-service.ts:309-313) sin humano y con cero veredictos de sombra. Además el flag apaga la propia medición: `modoSombra = thresholds.sombra === true && !thresholds.autoPost` (ingest-service.ts:229), así que la bandera no solo saltea el piso, cancela la sombra que lo alimentaría.

REFUTADO — la tercera puerta. `grantApproval` (src/ai/approval-policy.ts:105-133) NO es una vía independiente de encendido: su único consumidor para postear al mayor es `autoApproveDraftByPolicy` (src/ai/draft-service.ts:499-549), llamado en un solo sitio (src/ai/ingest-service.ts:279), y ese sitio está aguas abajo de `if (!thresholds.autoPost && !modoSombra) return {status:'draft'}` (ingest-service.ts:229-231) y del `return` del modo sombra (252-267). Con auto-post apagado, ninguna política otorga nada. Es un ENSANCHADOR de las compuertas discrecionales una vez encendido —y encima requiere una concesión humana registrada, no salta las compuertas de integridad (ingest-service.ts:294-297) y va topado por `configuredMaxAmount: floorMaxAutoAmount(...)` y FLOOR_MAX_AUTO_POST (approval-policy.ts:70-82).

MATIZ de calibre: aun por la puerta abierta, el daño va acotado — minConfidence 0.95 y maxAmount 10000 por omisión (src/ai/providers/config.ts:462-466), clamp duro a FLOOR_MAX_AUTO_POST=50000 (src/ai/floor.ts:30, aplicado en ingest-service.ts:282 y 391), compuertas de integridad, período abierto revalidado bajo lock en approveDraft, y atribución en review_notes con la fuente del umbral (ingest-service.ts:305-312). No es «cualquier importe sin rastro»; es «hasta 50 000 por CFDI, sin humano presente y sin un día de sombra».

Nota de contexto: el HEAD real del repo es 1ff9ca8 (A3-A4), no a149e62; la revisión se hizo sobre el código vigente, que ya incluye A4.

**Formulación corregida:** El piso de evidencia de sombra de A4 guarda UNA sola puerta al encendido del auto-posteo: `resolvePolicy` exige 7 días, 10 veredictos decididos por humano y acuerdo ≥0.9 solo para `ingest_auto_post = 'on'` (src/services/policy/policy-service.ts:167-186; único uso de FLOOR_SOMBRA_* fuera de la previsualización). Las otras DOS vías de encendido —la bandera `--auto-post` (src/cli/mnemosine.ts:1159 → src/ai/ingest-thresholds.ts:64-67) y `ingest.auto_post: true` en el archivo del operador (ingest-thresholds.ts:60-62 ← src/ai/providers/config.ts:503)— reescriben `autoPost` sin consultar el piso, y así lo fija un test vigente (tests/ai/frontera-desatendida.spec.ts:90-99: panel 'off' + archivo false + bandera → encendido). La asimetría es delatora: para `maxAmount` el archivo solo gana si es MÁS estricto (ingest-thresholds.ts:78-87), pero para `autoPost` gana en ambas direcciones, contra su propio comentario justificante.

Encima, `ingest` está declarado `irreversible` (src/cli/mnemosine.ts:1170-1174) y por eso recibe `-y, --yes` (src/cli/kernel/risk.ts:135-138), pero nadie la honra: `gateMutation` (risk.ts:173-217) no confirma nada y el handler (mnemosine.ts:1174-1335) jamás lee `opts.yes` ni `stdin.isTTY` — mientras dos comandos hermanos sí abortan sin terminal (mnemosine.ts:1426-1431, 1621-1626). Consecuencia literal: `mnemosine ingest --auto-post` en un crontab postea al mayor sin humano y sin un solo día de sombra, y de paso apaga la medición que alimentaría el piso (`modoSombra` exige `!autoPost`, ingest-service.ts:229). Acotado, eso sí, por confianza ≥0.95, tope por omisión 10 000, el clamp duro FLOOR_MAX_AUTO_POST=50 000 y las compuertas de integridad.

CORRECCIÓN al hallazgo: `grantApproval` (src/ai/approval-policy.ts:105-133) NO es una tercera puerta de encendido. Su único camino al mayor —`autoApproveDraftByPolicy`, llamado solo en src/ai/ingest-service.ts:279— vive aguas abajo del corte `if (!thresholds.autoPost && !modoSombra) return draft` (ingest-service.ts:229-231): con el auto-posteo apagado no autoriza nada. Es un ensanchador de las compuertas DISCRECIONALES una vez encendido, con concesión humana registrada, integridad intacta y tope por Math.min contra el FLOOR. La formulación correcta es «dos puertas sin peaje (bandera y archivo) más un ensanchador subordinado», no tres puertas.

