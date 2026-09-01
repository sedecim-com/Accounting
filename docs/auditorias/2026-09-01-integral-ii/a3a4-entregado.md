## VEREDICTO POR AFIRMACIÓN (lente A)

| # | Afirmación de la tarjeta | Dictamen |
|---|---|---|
| 1 | La ingesta cae a `autoApproveDraftByPolicy` como vía secundaria (el huérfano pagó) | **VERDADERA** |
| 2 | La integridad retorna ANTES y jamás negocia | **VERDADERA** |
| 3 | El tope del operador viaja floor-clampeado y **obligatorio** | **PARCIAL** |
| 4 | `NoMatchingApprovalPolicyError` separa «no casó» de «casó y falló» | **VERDADERA** |
| 5 | El presupuesto vive en `budget.ts` y muerde en `createLlmSession`, el único sitio donde nacen sesiones | **VERDADERA (con un desvío)** |
| 6 | Default BLOCK en ruta desatendida | **VERDADERA (matiz: sólo aplica a `on_exceed`)** |
| 7 | Cerrado cuando la base no deja medir | **PARCIAL** |
| 8 | Alcance POR ENTIDAD | **VERDADERA** |
| 9 | Los 12 retornos de datos de terceros viajan entre marcadores UNTRUSTED | **VERDADERA** |
| 10 | El cap de truncado cierra el bloque | **VERDADERA en lo esencial, PARCIAL en el detalle** |
| 11 | `shadow` corre todas las compuertas con el MISMO evaluador del modo real | **PARCIAL** |
| 12 | Registra el veredicto (047, único por borrador) y no postea nada | **VERDADERA** |
| 13 | La concordancia cruza contra decisiones humanas | **VERDADERA** |
| 14 | `resolvePolicy` exige el piso (7 días, 10 decididos, 0.9) antes de aceptar `'on'` | **VERDADERA en la letra, INSUFICIENTE en la garantía** |
| 15 | Tres criterios E5.1 nuevos, 21 mutantes muertos | **PARCIAL (los criterios existen y están verdes; los mutantes: no verificado)** |

---

## FORTALEZAS

**F1 · El evaluador es de verdad uno solo, y la integridad de verdad retorna antes.**
`evaluarAutoPost` (`src/ai/ingest-service.ts:343-411`) es una función **pura** —sin base, sin red— con las cuatro compuertas de integridad primero (sospecha `:354`, multi-draft `:362`, moneda `:371`, cuadre `:377`) y las discrecionales después (`:385`, `:391`, `:401`). No hay copia: el modo real (`:234`) y la sombra (`:242`) llaman a la misma función, y la vía de política sólo se abre bajo `if (veredicto.integridad)` negado (`:270-279`). Busqué duplicación de compuertas y **no la hay**. El monto usa la forma negada `if (!(total <= maxAmount))` (`:393`) para que un `NaN` falle cerrado: eso es artesanía, no adorno.

**F2 · El huérfano pagó y el error tiene nombre.**
`autoApproveDraftByPolicy` ya no está huérfano: se importa (`ingest-service.ts:13`) y se invoca con el default real detrás del seam (`:279`, `opts.deps?.autoApproveByPolicy ?? autoApproveDraftByPolicy`). `NoMatchingApprovalPolicyError` existe con código (`src/ai/draft-service.ts:474-476`) y la ingesta la distingue del fallo de aplicación (`ingest-service.ts:290-296`): «no casó» → borrador; «casó y falló» → borrador **con el motivo del fallo en el detail**. El congelado de E0.2 se actualizó honestamente: el símbolo que salió de la lista fue reemplazado por su gemelo real, `autoExecuteOpByPolicy` (`src/plan/criterios.ts:762`).

**F3 · El chokepoint del presupuesto es real.**
Verifiqué que **no hay otra fábrica de sesiones**: `grep 'new MnemosineAgent|new OpenAiCompatSession'` sólo devuelve `src/ai/providers/index.ts:93,107`, ambos dentro de `createLlmSession`, y `assertWithinBudget` está antes (`:77`). `createLlmSessionWithFailover` no esquiva: su `sessionFactory` (`:182`) cae a `createLlmSession` y el camino de cadena-de-uno también (`:192-193`). El decorador `withBudgetGuard` (`:117-133`) checa **al entrar a cada turno**, así que un cruce a mitad de sesión corta sin volver a la base (`budget.ts:129-162`). El alcance por entidad está en el SQL, no en la prosa: `WHERE entity_id = $1` (`budget.ts:61`).

**F4 · La concordancia no deja que el agente se califique a sí mismo.**
`concordanciaSombra` (`src/ai/shadow-verdicts.ts:49-78`) excluye las decisiones de máquina **en el numerador y en el denominador** (`'auto-post by threshold%'` y `'policy:%'` aparecen dos veces cada uno, `:56-63`), y el criterio lo verifica por conteo, no por presencia (`criterios.ts:2234-2240`). La 047 pone `UNIQUE (draft_id)` (`047_el_veredicto_de_la_sombra.sql:29`) y el INSERT es idempotente (`shadow-verdicts.ts:28`): una sombra no puede opinar dos veces e inflar su propio acuerdo.

**F5 · UNTRUSTED de segundo orden, con fuente única y el corte que cierra.**
12 retornos envueltos, contados uno por uno: `draft-tools.ts:99`, `ledger-tools.ts:73,110`, `external-tools.ts:62,88,107,156`, `search-tools.ts:103,142`, `report-tools.ts:189,219,263`. El cap de truncado balancea marcadores antes de devolver (`tools/index.ts:45-52`), y el conteo es correcto porque `UNTRUSTED_CLOSE` no contiene a `UNTRUSTED_OPEN` como subcadena. Lo que quedó fuera (`search_accounts`, balanza interna, estado de resultados) es catálogo del despacho, no texto de tercero: la línea está bien trazada.

---

## BRECHAS

### 1. El piso de evidencia sólo guarda la puerta del panel: el archivo del operador enciende sin historial — **NUEVA**
`src/ai/ingest-thresholds.ts:60-63`
```ts
if (archivo.autoPost !== undefined) { autoPost = archivo.autoPost; fuenteAuto = 'archivo'; }
```
`resolvePolicy` exige los tres pisos (`policy-service.ts:172-187`) — pero es la única puerta guardada. Lo **probé ejecutando** `resolverUmbralesConPanel` con el panel en `off` y sin un solo veredicto de sombra:

- `{"ingest": {"auto_post": true}}` en `mnemosine.config.json` → `autoPost:true, fuentes.autoPost:'archivo'`
- `--auto-post` → `autoPost:true, fuentes.autoPost:'bandera'`
- **el peor caso**: panel en `'shadow'` + archivo `auto_post:true` → `{sombra:true, autoPost:true}`, y como `modoSombra = thresholds.sombra === true && !thresholds.autoPost` (`ingest-service.ts:229`) es **false**, el despacho postea de verdad **y no se registra ni un veredicto**. Contestó «shadow» en el panel y obtuvo posteo real y cero evidencia, en silencio.

El asimetría que sí implementaron para el monto («el archivo sólo gana si es MÁS estricto», `:78-87`, con prueba en `tests/ai/frontera-desatendida.spec.ts:112-135`) **no existe para el interruptor**. La bandera es defendible (humano presente e invocación explícita); el archivo no: es persistente, es de máquina y gobierna corridas desatendidas.

### 2. La evidencia se mide por entidad y la decisión se escribe por inquilino — **NUEVA**
`src/services/policy/policy-service.ts:173` vs `:194-200`
```ts
const c = await concordanciaSombra({ tenantId: ctx.tenantId, entityId: ctx.entityId ?? null });
...
UPDATE policy_decisions SET status='resolved', resolved_value=$1 ... WHERE tenant_id=$4 AND key=$5 AND status='pending'
```
El peaje se cobra sobre la entidad del contexto; el UPDATE no filtra `entity_id` **ni acota a una fila**. Consecuencia: siete días de sombra en una entidad de prueba resuelven la fila de alcance-inquilino, y `getPolicy` (`:118-124`) se la sirve a **todas** las demás entidades del despacho, que nunca midieron nada. Si además existen filas pendientes por entidad, el UPDATE resuelve varias de un golpe.

### 3. La sombra mide un modo real que ya no existe: le falta el segundo autorizador — **NUEVA**
`src/ai/ingest-service.ts:242-267` vs `:269-297`
La sombra registra `wouldAutoPost: veredicto.procede` (`:249`) — el veredicto del **umbral**. Pero A3 acaba de añadir un segundo autorizador que corre exactamente cuando el umbral dice que no: la vía de política (`:279-288`). Con una política `always` otorgada, el modo real postea casos que la sombra apuntó como «no habría posteado». La concordancia, entonces, valida un clasificador **más conservador** que el que se va a encender. Y el efecto compuesto es más agudo de lo que parece: `matchApproval` casa sólo por `kind` y `max_amount` (`approval-policy.ts:279-284`), así que una política otorgada **hace saltables la confianza mínima y el requisito de proveedor conocido** — dos de las tres discrecionales. La integridad sigue intacta (esa parte de la tarjeta es cierta), pero el umbral de confianza dejó de ser un piso para todo lo que una política cubra.

### 4. «Obligatorio» es una convención de un solo call-site, no una firma — **SIGUE-ABIERTA**
`src/ai/approval-policy.ts:223` (`configuredMaxAmount?: number`) y `src/ai/draft-service.ts:500-503` (`opts?: MatchApprovalOpts`)
La ingesta sí lo pasa floor-clampeado (`ingest-service.ts:282`, `configuredMaxAmount: floorMaxAutoAmount(thresholds.maxAmount)`), y ahí la tarjeta acierta. Pero nada en el tipo lo exige: el segundo llamador que aparezca (`autoExecuteOpByPolicy` está congelado esperando al ejecutor desatendido del outbox, `criterios.ts:762`) compila sin pasarlo y hereda como tope sólo `FLOOR_MAX_AUTO_POST` = 50 000. Lo que hoy sostiene la afirmación es un regex sobre el texto del archivo (`criterios.ts:2143`), no el compilador.

### 5. El presupuesto es opt-in: sin sección `budget` no hay tope, ni desatendido — **SIGUE-ABIERTA**
`src/ai/budget.ts:174-177`
```ts
if (limits.dailyUsd === undefined && limits.monthlyUsd === undefined) { ...return guard vacío }
```
El «default BLOCK en ruta desatendida» gobierna `on_exceed` **cuando ya hay límites**; una instalación sin la sección corre sin techo, igual que antes. La brecha (7) de la Auditoría I («presupuesto caído») queda cerrada como mecanismo y abierta como configuración por omisión. Añado dos matices verificados: `unattended` se **infiere** de `opts.grounding?.enabled === false` (`providers/index.ts:76`) —señal indirecta: una futura ruta desatendida que olvide apagar el grounding hereda `warn`— y existe **una** llamada al modelo fuera del chokepoint, la sonda de init (`src/cli/init/s3-ai.ts:308,326`, 64 tokens, tampoco registrada en `ai_usage`, así que es invisible para `currentSpend`).

### 6. «Cerrado cuando la base no deja medir» sólo vale en `block` — **SIGUE-ABIERTA**
`src/ai/budget.ts:179-192`
En `block` la excepción es correcta y ejemplar (`:182-186`). En `warn` —el default interactivo— el fallo de medición devuelve gasto cero y la sesión corre a ciegas con un aviso (`:188-191`). Es coherente con el diseño («warn no corta nunca»), pero la afirmación de la tarjeta es incondicional y no lo es.

### 7. El marcador de truncación queda DENTRO del bloque que el propio comentario dice proteger — **SIGUE-ABIERTA**
`src/ai/tools/index.ts:45-52`
```ts
let cortado = result.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATION_MARKER;
// ... «incluido el marcador de truncación, que es del sistema»
if (opens > closes) cortado += `\n${UNTRUSTED_CLOSE}`;
```
El bloque cierra (eso es cierto y es lo importante), pero el marcador del sistema se concatena **antes** del cierre, es decir, dentro de la región de datos de tercero — exactamente lo que el comentario declara evitar. El orden correcto es `slice + CLOSE + TRUNCATION_MARKER`. Nota menor asociada: `ingest-service.ts:499-501` conserva su copia privada de `neutralizeMarkerDelimiters` pese a que `untrusted.ts` nació para ser la fuente única.

### 8. Uno de los tres criterios nuevos mide prosa — **SIGUE-ABIERTA**
`src/plan/criterios.ts:2184`
```ts
if (!/sin medición/.test(b)) return falla('block dejó de ser cerrado ante una base que no responde...');
```
La propiedad que se quiere fijar (fallo cerrado sin medición) se verifica por la presencia de una cadena en castellano dentro del mensaje de error. Borra todo el `try/catch` de `budget.ts:179-192`, deja un comentario que diga «sin medición», y el criterio sigue verde. Es **falsable** (una mutación del texto lo mata) pero no mide comportamiento — es el mismo defecto que E3.2 castigó en `pending-catalog.ts`. Los otros dos ganchos del mismo criterio (`opts.unattended ? 'block' : 'warn'`, el conteo ×2 de `BUDGET_WARN_RATIO`) sí son estructurales y sí resisten. Los tres criterios están verdes: `npm run plan:status` → **E5.1 13/15** (los dos rojos son los viejos: superficie derivada del registro de riesgo y `--continue`). Los «21 mutantes muertos» no son verificables desde el árbol: **no verificado**.

**Sin evidencia adicional (no verificado):** las brechas (10) memoria léxica sin conflicto, (11) degradación sin proveedor y (12) cierre sin conductor no entraban en el alcance de A3-A4 y no las revisé.

---

## RECOMENDACIONES

**R1 · Que el archivo sólo pueda APAGAR el interruptor. [S — brecha 1]**
En `ingest-thresholds.ts:60-63`, la misma asimetría que ya existe para el monto: `if (archivo.autoPost === false) { autoPost = false; fuenteAuto = 'archivo'; }`. Encender queda como facultad exclusiva del panel, que es la puerta con peaje. Regla de la casa (a) aplicada al pie de la letra. **Fase: A5 (o parche inmediato en la rama viva).**

**R2 · Que `shadow` + `autoPost` sea un error, no una precedencia silenciosa. [S — brecha 1]**
Hoy `modoSombra` se apaga sin decir nada (`ingest-service.ts:229`) y la corrida postea de verdad. Debe abortar con un mensaje explícito («el panel dice shadow y el archivo dice auto_post: decide») o, como mínimo, gritar en el banner. De paso: el banner (`mnemosine.ts:1265-1271`) y `ai_ingest_runs.autoPostEnabled` (`:1296`) no distinguen la sombra — una corrida sombra se registra como «sin auto-post», indistinguible de una corrida apagada. **Fase: A5.**

**R3 · Acotar `resolvePolicy` a la fila que midió. [S — brecha 2]**
Añadir `AND (entity_id IS NULL OR entity_id = $6::uuid)` al UPDATE (`policy-service.ts:198`) y, cuando la evidencia se midió por entidad, resolver **la fila de esa entidad**; si el destino es la fila de inquilino, exigir el piso a nivel inquilino (`entityId: null`). Un `LIMIT`/`rowCount === 1` guardado cierra además la resolución múltiple accidental. **Fase: A5.**

**R4 · Que la sombra simule también la vía de política. [M — brecha 3]**
Cuando `veredicto.procede === false && !veredicto.integridad`, la sombra debería consultar `matchApproval` en **modo lectura** (sin consumir `once`, sin tocar `last_used_at`) y registrar `wouldAutoPost` incluyendo esa segunda vía, más un campo `via: 'umbral' | 'politica'` en `thresholds` de la 047. Sin eso, la concordancia certifica un clasificador que no es el que se enciende. Requiere partir `matchApproval` en un `evaluarMatch` puro y un `consumirMatch`. **Fase: A5-A6.**

**R5 · Hacer obligatorio el tope en la firma. [S — brecha 4]**
`configuredMaxAmount: number` (sin `?`) en `MatchApprovalOpts` para el scope `draft`, y `opts: MatchApprovalOpts` (sin `?`) en `autoApproveDraftByPolicy`. Que lo garantice el compilador, no un regex. **Fase: A5.**

**R6 · Reemplazar el criterio de prosa por uno de comportamiento. [S — brecha 8]**
Sustituir `/sin medición/` por una prueba que inyecte un `query` que lanza y afirme que `assertWithinBudget` **rechaza** con `block` y **resuelve** con `warn` — la prueba ya es trivial de escribir sobre `budget.ts` y mata mutantes en ambas direcciones (regla de la casa (c)). Mientras tanto, el criterio puede exigir la forma estructural `if (limits.onExceed === 'block')` dentro del `catch`. **Fase: A5.**

**R7 · Ordenar el cierre del bloque truncado y matar la copia privada. [S — brecha 7]**
`tools/index.ts:45-52`: cerrar el bloque **antes** de concatenar `TRUNCATION_MARKER`. Y hacer que `ingest-service.ts:499` use `neutralizarMarcadores` de `untrusted.ts` en vez de su copia. **Fase: A5.**

**R8 · Decidir en el panel si el presupuesto desatendido es opt-in. [M — brecha 5]**
Que una corrida desatendida sin sección `budget` corra sin techo es una bifurcación de criterio, no un detalle de implementación: va al panel (`ingest_presupuesto_obligatorio`, o un `budget.required` con default que el wizard de init pregunte). Y registrar la sonda de `s3-ai.ts` en `ai_usage`, o documentar por qué no cuenta. **Fase: A6.**
