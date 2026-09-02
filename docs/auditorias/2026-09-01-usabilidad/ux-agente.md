> Auditoría del lente **la experiencia de trabajar con el agente**: ingesta → borradores → revisión → posteo, más confianza, preguntas, panel de políticas, conversación y costo. Todo lo que sigue trae salida reproducida o `archivo:línea` del árbol `/private/tmp/claude-501/-Users-victor-projects-Accounting/d48ca5a0-ac05-4c38-a2d6-62373f8f-aud`.

## LO QUE ESTÁ BIEN

**El remedio accionable SÍ existe, y es bueno. Vive en un solo comando.** El orquestador reportó que ningún error remite a `doctor`. Lo refuto parcialmente: la entrada por omisión (chat) tiene una preflight excelente.

```
$ npx tsx src/cli/mnemosine.ts --continue
Something needs attention before we can chat:
  · database unreachable: role "mnemo" does not exist
      → mnemosine doctor   (and check DATABASE_URL in .env)
```

Y `doctor` mismo cumple el patrón completo — estado, causa, remedio, orden:

```
$ npx tsx src/cli/mnemosine.ts doctor
Mnemosine health check

  ✘ Database        no connection: role "mnemo" does not exist
      → Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)
  ✘ Model provider  anthropic requires ANTHROPIC_API_KEY and it is not set
      → Set ANTHROPIC_API_KEY in .env, or use --provider ollama
  ⚠ Encryption key  ENCRYPTION_KEY not set (the code default is used)
      → openssl rand -hex 32  → ENCRYPTION_KEY in .env

  There are failures that prevent operation. Resolve them in the order shown.
```

El mapeo razón→remedio está factorizado en `repairCommandFor()` (`src/cli/mnemosine.ts:396-408`). Es reutilizable. Simplemente nadie más lo llama (ver Brecha 8).

**El contenido del panel de políticas está escrito por alguien que sabe contabilidad mexicana.** `src/services/policy/pending-catalog.ts` declara 17 decisiones con `question`, `impact`, `options`, `defaultValue`, `defaultRationale`, y además tres campos explicativos —`whyAsking`, `whatIDo`, `ifSkipped`. Ejemplo literal (líneas 42-60):

> "When an equipment invoice arrives I must decide whether it is this month's expense or an asset that depreciates over years. That line is your company's policy, not a SAT rule — the law sets depreciation rates, not the threshold for capitalizing."

Eso es exactamente lo que hay que decirle a un contador. Distingue política interna de regla legal, algo que CONTPAQi no hace: ahí el umbral es un campo de configuración sin explicación.

**La vista previa contra los datos propios del cliente.** `src/services/policy/policy-preview.ts:6-15` documenta el principio y lo implementa:

> "A policy question asked in the abstract ('what threshold do you want?') is hard to answer well. The same question asked against the company's own data ('with $20,000 I would have interrupted you 8 times last year; with $50,000, twice') is a decision the accountant can actually make. Every preview degrades to silence: with no history there is nothing useful to say, and inventing an example would be worse than saying nothing."

Ningún sistema contable del mercado hace esto. Es el mejor pedazo de diseño de producto del repositorio.

**El veredicto de la sombra.** `src/database/migrations/047_el_veredicto_de_la_sombra.sql` agrega el modo `shadow` al auto-posteo: las compuertas corren completas, el veredicto se registra con los umbrales vigentes (`thresholds JSONB`), y nada toca el mayor. El cruce veredicto-vs-decisión humana es la evidencia para encender `on`. Es la respuesta correcta a "¿cuándo confío en el agente?" y `mnemosine ai stats` la calcula (`src/ai/stats-service.ts`).

**El hash canónico ata la aprobación al contenido revisado.** `src/ai/draft-service.ts:48-56`: el revisor aprueba *ese* contenido; `approveDraft` recalcula el hash bajo lock de fila y aborta si cambió. Cierra la ventana TOCTOU entre lo que el humano vio y lo que se postea. Es una preocupación que no aparece en ningún producto contable comercial y aquí está resuelta y documentada.

**Honestidad en el costo.** `mnemosine usage` etiqueta lo que es: `"Usage by model (costs are local estimates, not billing)"` y arrastra la fecha de la tabla de precios (`src/cli/usage-command.ts:88-91`), y las filas cuyo modelo no conoce se muestran como `unpriced` en lugar de descartarse en silencio.

**Kernel de salida moderno donde llegó.** `mnemosine ai stats --help` expone `--format table|json|ndjson|csv|tsv|md`, `-o`, `--fields`, `-q`. Eso es nivel `gh`/`stripe`.

**La marcha seca de la ingesta dice lo que NO calculó** (`src/cli/mnemosine.ts:1214-1217`): "Firm rules, AI classification and the journal-entry plan are decided on the real run." Un `--dry-run` que confiesa su alcance es raro y correcto.

**EOF y SIGINT en la cola de revisión.** `if (raw === null) break;` (`src/cli/mnemosine.ts:1099`) y el abort del prompt de motivo (`:1123`) evitan colgarse o confirmar en silencio con stdin cerrado. Salida 130 en SIGINT.

---

## BRECHAS

### 1. Toda la capa explicativa del panel se gasta el día uno, cuando el contador todavía no tiene datos. ALTA / esfuerzo S

**Evidencia.** Los tres campos que explican una decisión a un humano y la vista previa contra datos propios tienen **un solo consumidor en todo el repositorio**, y es el asistente de alta:

```
$ grep -rn "whyAsking\|whatIDo\|ifSkipped" src/ | grep -v pending-catalog.ts
src/cli/init/s4-policies.ts:135:    const why = spec?.whyAsking ?? spec?.impact ?? row.impact;
src/cli/init/s4-policies.ts:136:    const what = spec?.whatIDo;
src/cli/init/s4-policies.ts:168:      if (spec?.ifSkipped) ctx.print(`     Left open: ${spec.ifSkipped}`);

$ grep -rn "previewFor" src/ | grep -v "policy-preview.ts:"
src/cli/init/s4-policies.ts:9:import { previewFor } from '../../services/policy/policy-preview.js';
src/cli/init/s4-policies.ts:92:        preview: await previewFor(row.key, {
```

`renderPolicies` (`src/cli/pending-command.ts:99-116`) —el panel donde el contador vive el resto de la relación— muestra `key`, valor en uso, `question`, y con `-v` agrega `impact`, `default_rationale` y `options`. Nunca `whyAsking`, `whatIDo`, `ifSkipped` ni el preview.

**Práctica que incumple.** Nielsen #6, *recognition rather than recall*, y #10, *help and documentation*: la ayuda debe estar disponible en el momento de la tarea, no solo en un tutorial inicial. Es también el error clásico del onboarding de una sola pasada que las CLI de referencia evitan (`git` explica en `git status`, no solo en `git init`).

**El escenario.** El asistente `init` corre en el orden `s0-infra → s1-identity → s2-users → s3-ai → s4-policies → s5-import` (`src/cli/init/index.ts`). En `s4` la tabla `xml_documents` está vacía —`s5` importa catálogo y saldos iniciales, no CFDI. `receivedInvoices` (`policy-preview.ts:31-39`) consulta `xml_documents` y devuelve cero filas, así que **por diseño el preview degrada a silencio exactamente en el único momento en que se muestra**. El contador contesta 17 decisiones a ciegas el día uno. Tres meses después, con 600 CFDI ingeridos —cuando el preview por fin diría "con $20,000 te habría interrumpido 43 veces este trimestre"— la superficie que lo muestra ya no existe. Corre `mnemosine pending -v`, ve `umbral_capitalizacion_mxn — operating with: 20000` y tres opciones sin dato propio, y deja el default.

### 2. La pantalla de revisión no le da al revisor con qué decidir. ALTA / esfuerzo M

**Evidencia.** Todo lo que ve el revisor está en `renderDraft` (`src/cli/mnemosine.ts:985-1010`):

```
console.log(`${c.dim('date:')} ${p.entry_date}   ${c.dim('AI confidence:')} ${draft.ai_confidence}`);
console.log(`${c.dim('description:')} ${p.description}`);
if (p.reference) console.log(`${c.dim('reference:')} ${p.reference}`);
console.log(`${c.dim('reasoning:')} ${c.dim(draft.ai_reasoning)}`);
```

Es decir: fecha, un número de confianza, descripción, referencia en texto libre, un párrafo de prosa del modelo, y las líneas. No hay CFDI. **Y no puede haberlo: el modelo de datos no guarda el vínculo.** `ai_drafts` (`src/database/migrations/011_ai_drafts.sql:9-40`) no tiene `xml_document_id`, ni `cfdi_uuid`, ni FK a nada; `DraftRow` (`src/ai/draft-service.ts:33-46`) tampoco. El único hilo al documento es texto libre dentro del JSONB: la ingesta le pide al modelo `Create the draft with reference "${referenceSerieFolio} · ${d.cfdi_uuid}"` (`src/ai/ingest-service.ts:597`).

Y lo irónico: **la mitad que falta existe y es buena**.

```
$ npx tsx src/cli/mnemosine.ts cfdi --help
Commands:
  show|ver [options] <uuid>          One CFDI: header, lines, taxes and SAT
                                     status; --format xml prints the exact bytes
  explain|explicar [options] <uuid>  WHY it was recorded the way it was: case,
                                     facts and decisions the classifier left
```

`cfdi show` y `cfdi explain` son exactamente el otro lado del asiento propuesto. `review` no los menciona nunca, y aunque lo hiciera, el revisor está dentro de un `readline` modal (`src/cli/mnemosine.ts:1094-1098`) y tendría que abrir otra terminal y copiar a mano un UUID de una cadena atenuada.

**Práctica que incumple.** Nielsen #1 (visibilidad del estado del sistema) y #6. En CONTPAQi y en Aspel COI el enganche de un CFDI a una póliza muestra el comprobante y la póliza en la misma vista; es la operación básica del módulo. En QuickBooks y Xero la propuesta de categorización siempre trae la imagen del recibo al lado. Aquí el revisor aprueba a ciegas contra la palabra del modelo.

**El escenario.** Llega un borrador: `description: Servicios profesionales`, `AI confidence: 0.86`, `reference: A-1042 · 3F2A...`, línea a `6110 Honorarios`. El contador quiere saber si el proveedor retuvo ISR e IVA —lo que decide si esto lleva dos líneas más. Esa información está en el XML, a dos comandos de distancia, y él está atrapado en un prompt que solo acepta `a`, `r`, `s`, `q`.

### 3. La confianza es un número sin leyenda, y la calibración que sí existe nunca llega al momento de decidir. ALTA / esfuerzo S

**Evidencia.** `ai_confidence` es autorreporte del modelo. La única definición que existe está en el prompt, no en la interfaz:

```
$ grep -rn "confidence" src/ai/system-prompt.ts src/ai/tools/draft-tools.ts
src/ai/system-prompt.ts:53:Report honest confidence: <0.8 if you guessed the account or the accounting treatment, and explain the doubt.
src/ai/tools/draft-tools.ts:30:      confidence: z.number().min(0).max(1).describe('Your confidence that the entry is correct (0-1)')
```

El revisor ve `AI confidence: 0.86` sin saber que es autorreportado, sin escala, sin punto de corte, y sin su propio historial. Mientras tanto `mnemosine ai stats` calcula precisamente eso —"Aprobación por bucket de confianza, delta confianza-vs-realidad"— y el veredicto de la sombra dice si esa póliza *habría* pasado las compuertas. Nada de eso aparece en `renderDraft`.

**Práctica que incumple.** Nielsen #1 y #2 (correspondencia con el mundo real). Y el principio de calibración: un número de confianza sin evidencia de calibración es decoración. La convención de CLI moderna es que el dato que sostiene la decisión viaje con la decisión (`git status` no te manda a otro comando para saber qué está en stage).

**El escenario.** El contador aprende, sin que nadie se lo diga, que 0.9 "es alto". `ai stats` habría podido decirle que en su despacho el bucket 0.85-0.95 se aprueba el 61% de las veces —que 0.86 no significa lo que él cree. Aprueba en automático todo lo que pasa de 0.85 durante cuatro meses.

### 4. Revisar no escala: uno por uno, sin filtro, sin lote y sin salida de máquina. ALTA / esfuerzo M

**Evidencia.** La única acción por borrador:

```
src/cli/mnemosine.ts:1098:  const raw = await ask(rl, c.cyan('\n[a]pprove and post  [r]eject  [s]kip  [q]uit > '));
```

No hay corregir-y-aprobar. Y no hay forma de triar la cola:

```
$ npx tsx src/cli/mnemosine.ts drafts --help
Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -s, --status <status>    pending_review | approved | rejected

$ npx tsx src/cli/mnemosine.ts drafts --json
error: unknown option '--json'
$ npx tsx src/cli/mnemosine.ts review --json
error: unknown option '--json'
```

Sin `--min-confidence`, sin `--max-amount`, sin `--since`, sin orden, sin `--json`. Y el kernel de salida moderno existe: **46 sitios lo usan**, y llegó a `entry`, `account`, `vendor`, `bill`, `customer`, `period`, `ledger`, `report`, `entity`, `cfdi`, `ai` — a todas las familias contables clásicas y a ninguno de `drafts`, `review`, `ingest`, `pending`. Justo al revés de donde está el diferenciador del producto.

**Práctica que incumple.** clig.dev: *"make it scriptable"* y *"output for humans AND machines"*. `kubectl get -o json`, `gh pr list --json`, `docker ps --format` son la línea base. Y el principio de flujo de trabajo por lotes que Xero y QuickBooks resolvieron con "aceptar todas las coincidencias".

**El escenario.** Un despacho ingiere 200 CFDI de un cliente el día 12. Quedan 140 borradores. El contador quiere hacer lo obvio: revisar primero los 12 de confianza baja, y aprobar en bloque los 90 de proveedores recurrentes con confianza sobre 0.95. No puede hacer ninguna de las dos. Presiona `a` ciento cuarenta veces sin poder volver atrás —no hay `[u]ndo`— y cada `a` postea al mayor irreversiblemente. A la tercera sesión así, enciende `ingest_auto_post = on` sin haber medido nada, que es exactamente el resultado que el modo `shadow` fue diseñado para evitar.

### 5. El rechazo es un callejón sin salida y el lazo de aprendizaje no cierra por ahí. ALTA / esfuerzo M

**Evidencia.** `rejectDraft` (`src/ai/draft-service.ts:553-568`) escribe el motivo en `review_notes` y termina. La CLI imprime `'✘ Draft rejected.'` (`src/cli/mnemosine.ts:1129`) y sigue con el siguiente. Sin sugerencia de qué hacer con ese CFDI, sin oferta de sembrar el criterio.

La asimetría con las preguntas es exacta y verificable. El prompt del sistema inyecta el digest de memoria en cada sesión (`src/ai/system-prompt.ts:153-159`), y ese digest sale **solo** de `ai_questions`:

```
src/ai/memory-service.ts:181:    `SELECT topic, question, answer, answered_by, answered_at
                                FROM ai_questions
                                WHERE entity_id = $1 AND status = 'answered' AND is_precedent = true
```

Es decir:
- pregunta contestada → precedente en `ai_questions` → entra al prompt de **toda** sesión futura, automáticamente, y el humano lo ve y lo controla con `mnemosine memory`;
- borrador rechazado con motivo escrito → `ai_drafts.review_notes` → **no** entra al prompt, **no** aparece en `mnemosine memory`, y solo llega al modelo si este decide llamar `list_drafts(status=rejected)` por su cuenta (`src/ai/tools/draft-tools.ts:111`; los docs del agente se lo piden en `src/ai/docs/mnemosine.md:9`, pero es una petición, no un mecanismo).

Y la ingesta por lote crea **sesión nueva por corrida** (`createLlmSession` en `src/cli/mnemosine.ts:1264`), así que ese aprendizaje intra-sesión no sobrevive a la corrida.

Soy justo: el mecanismo para convertir una corrección en precedente existe (`mnemosine memory teach "<regla>" "<criterio>"`). Pero es un comando aparte, con dos argumentos posicionales, que nadie sugiere en el momento del rechazo.

**Práctica que incumple.** El lazo humano-en-el-ciclo: la señal de corrección más cara de obtener —un humano diciendo "esto está mal, y por esto"— se descarta. Nielsen #3 (control y libertad del usuario): el usuario no tiene forma de corregir, solo de vetar.

**El escenario.** El contador rechaza catorce borradores del mismo proveedor con el motivo "Telmex va a 6130, no a 6110". Al mes siguiente ingiere el nuevo lote y el agente propone 6110 catorce veces más. El contador concluye, razonablemente, que el agente no aprende.

### 6. El panel donde se ejerce el juicio fiscal MEXICANO está en inglés, con las llaves en español. ALTA / esfuerzo M

**Evidencia.** 17 de 17 preguntas del catálogo, en inglés, con llaves en español:

```
$ grep "^    key:" src/services/policy/pending-catalog.ts | head -4
    key: 'umbral_capitalizacion_mxn',
    key: 'politica_restaurantes',
    key: 'tratamiento_ieps',
    key: 'lleva_inventarios',

$ grep "^    question:" src/services/policy/pending-catalog.ts | head -4
    question: 'From what amount is an item capitalized as a fixed asset instead of expensed?',
    question: 'Restaurant meals (8.5% deductible): how are they recorded?',
    question: 'Is the company an IEPS taxpayer that passes it on?',
    question: 'Does the company keep perpetual inventories?',
```

Los conceptos son irreductiblemente mexicanos —IEPS, REP, e.firma, el 8.5% de consumos en restaurantes, LIEPS art. 4— y la oración que los rodea es inglesa. Esto profundiza el hallazgo del orquestador con la superficie donde más duele: no es la ayuda de un comando, es la pregunta cuya respuesta cambia el asiento de todas las compras del cliente.

**Práctica que incumple.** Nielsen #2, *match between the system and the real world*: "speak the users' language". El usuario objetivo declarado no necesariamente sabe inglés.

**El escenario.** El contador corre `mnemosine pending`, ve `⚖ tratamiento_ieps — operating with: costo` seguido de `Is the company an IEPS taxpayer that passes it on?`. Reconoce "IEPS" y "costo", no entiende "passes it on", y deja el default. Si su cliente es gasolinero, acaba de mandar el IEPS acreditable al costo durante todo el ejercicio.

### 7. El nombre que el producto y el propio agente le dicen al usuario está deprecado; y el nombre canónico se advierte a sí mismo. ALTA / esfuerzo S

**Evidencia.** La familia canónica es `question`. Y sin embargo:

```
$ npx tsx src/cli/mnemosine.ts question
  ⚠ deprecated: `mnemosine questions` is split into `question list` and `question answer` — this shortcut will go away.
```

El usuario escribió `question` —el nombre que aparece en `--help`— y el sistema le contesta advirtiéndole sobre `questions`, que no escribió. La causa es que el shim de deprecación está montado como acción por omisión del padre canónico (`src/cli/mnemosine.ts:2001-2003`).

Y el nombre deprecado es el que el producto usa en sus propias recomendaciones, incluido **el tablero "qué tengo que hacer"** y **los documentos que el agente lee**:

```
$ grep -rn "mnemosine questions" src/
src/ai/pending-service.ts:86:    command: 'mnemosine questions',
src/cli/mnemosine.ts:1329:  if (cnt.blocked > 0) console.log(c.dim('Answer the questions with: mnemosine questions'));
src/cli/mnemosine.ts:350:  console.log(c.dim('  (option number or free text; empty = leave pending for `mnemosine questions`)'));
src/cli/memory-command.ts:40:  out.push(c.dim('  They are created by answering questions (mnemosine questions) or directly:'));
src/ai/compaction.ts:370:  'slug — the human confirms inline or reviews it later in `mnemosine questions`. Do NOT invent '
```

**Práctica que incumple.** clig.dev y la práctica de deprecación de `git`/`docker`: la deprecación advierte al que usa el nombre viejo, jamás al que usa el nuevo, y el producto nunca imprime el nombre que él mismo deprecó. El orquestador acreditó (con razón) que la deprecación se anuncia en la ayuda; esto es la otra cara.

**El escenario.** Termina una ingesta con 9 bloqueados. El sistema le dice `Answer the questions with: mnemosine questions`. Obedece. El sistema le regaña por usar un comando deprecado. Ahora tiene que decidir cuál de los dos mensajes del sistema es el correcto.

### 8. El contrato de códigos de salida está escrito, es bueno, y está muerto: todo sale 1. MEDIA / esfuerzo M

**Evidencia.** `src/cli/kernel/exit.ts:1-18` publica una tabla con trece códigos y explica por qué existen los dos que pesan:

> "11 needs human: a question was raised or a draft awaits review. This is the code that makes an agent-driven workflow safe — the work did not fail, it is waiting."

Ninguno de los constructores se usa fuera del kernel:

```
$ for f in needsHuman validationFailed blockedByState externalFailed externalRejected \
           abortedByUser conflict permissionDenied notFound usageError; do
    echo -n "$f: "; grep -rn "$f(" src/ | grep -v "kernel/exit.ts" | grep -v "kernel/index.ts" | wc -l
  done
needsHuman: 0
validationFailed: 0
blockedByState: 0
externalFailed: 0
externalRejected: 0
abortedByUser: 0
conflict: 0
permissionDenied: 0
```

(`notFound` y `usageError` sí se usan, en `question answer` y en `entry`/`period`.) `exitCodeFor` (`src/cli/kernel/index.ts:109-114`) devuelve `FAILURE` para cualquier cosa que no sea `CliError`, y los comandos del lazo llevan `shutdown(1)` a mano —14 veces solo en `mnemosine.ts`. La ingesta que dejó 140 borradores termina con `shutdown(cnt.error + cnt.invalid > 0 ? 1 : 0)` (`:1332`): cero. El código 11, que existe literalmente para eso, no se emite nunca.

Reproducido:

```
$ npx tsx src/cli/mnemosine.ts drafts   ; echo "EXIT=$?"
role "mnemo" does not exist
EXIT=1
$ npx tsx src/cli/mnemosine.ts review   ; echo "EXIT=$?"
role "mnemo" does not exist
EXIT=1
$ npx tsx src/cli/mnemosine.ts pending  ; echo "EXIT=$?"
role "mnemo" does not exist
EXIT=1
```

Y `--json` no salva a nadie: en la falla no sale nada por stdout.

```
$ npx tsx src/cli/mnemosine.ts question list --json 2>/dev/null ; echo "STDOUT_EXIT=$?"
STDOUT_EXIT=1
```

**Práctica que incumple.** El propio contrato del repositorio, que es el que cita la práctica establecida (el truco de `git diff --exit-code`). Y clig.dev: *"return zero on success, non-zero on failure — and use distinct codes"*.

**El escenario.** El despacho programa la ingesta nocturna en `cron`. El script no puede distinguir "Postgres estaba caído, reintenta" de "hay 140 pólizas esperando revisión" de "un CFDI venía roto": los tres son 1 o 0 sin matiz. El día que la base no levanta, el `cron` reporta éxito con cero pólizas y nadie se entera hasta el cierre.

### 9. El aviso de que hay preguntas pendientes existe en un solo lugar: el banner del chat, en TTY, de una entidad. MEDIA / esfuerzo M

**Evidencia.** La consulta que cuenta borradores, preguntas y operaciones pendientes tiene exactamente un llamador:

```
$ grep -rn "fetchPendingCounts" src/
src/cli/mnemosine.ts:427:async function fetchPendingCounts(entityId: string): Promise<BannerInfo['pending']> {
src/cli/mnemosine.ts:730:          pending: await fetchPendingCounts(ctx.entityId),
```

La línea 730 está dentro del bloque `if (shouldShowBanner(opts, process.env, stdout.isTTY === true))` (`:723`), y `shouldShowBanner` (`:412-421`) exige TTY, ausencia de `--no-banner` y de `MNEMOSINE_NO_BANNER=1`. Además cuenta **una** entidad: `getPendingBoard(ctx)` y `pending -e` son por entidad, y no existe vista agregada por despacho en ningún comando.

**Práctica que incumple.** Nielsen #1: el estado del sistema debe ser visible, no consultable a petición. El patrón establecido es el de `git status`/`gh pr status`: el trabajo pendiente aparece en la superficie que ya estás mirando.

**El escenario.** Un despacho con 40 clientes. El agente levanta preguntas en siete de ellos. El contador trabaja por lote —`ingest`, `drafts`, `review`— y nunca abre el chat. Para enterarse tendría que correr `mnemosine pending -e <cliente>` cuarenta veces, una por cliente, sabiendo de antemano que existe el comando. Mientras tanto el agente opera con defaults en las siete bifurcaciones que preguntó.

### 10. La envoltura de contexto de entidad diagnostica mal la caída de conexión, y el autor lo sabía. MEDIA / esfuerzo S

**Evidencia.** El orquestador lo reprodujo en `entry post`. Confirmo que el defecto es de la capa compartida, no de un comando: sale idéntico en `ai stats`.

```
$ npx tsx src/cli/mnemosine.ts ai stats
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "mnemo" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "mnemo" does not exist
```

Lo notable es el comentario que precede al mensaje (`src/cli/kernel/entity-context.ts:103-108`):

> "This catch fires for 'the entity was archived', but it fires just as readily on a dropped connection or on a query that ran before the tenant context was entered — and one mistimed command must not destroy the bookkeeper's selection."

La decisión de **no** borrar el pin es correcta y está bien argumentada. Lo que no siguió es que el mensaje distinga los dos casos que el propio comentario distingue: una rama por clase de error bastaría, y el remedio ya está escrito en `repairCommandFor()` a 300 líneas de distancia. El segundo eco crudo viene de `reportError` (`src/cli/mnemosine.ts:241-256`), cuya rama `else` —la que atrapa **todo** error de base de datos, RLS, validación y dominio en 75 sitios— imprime `err.message` pelado. Las ramas de proveedor de IA, en cambio, sí traen remedio.

**Práctica que incumple.** clig.dev, *"catch errors and rewrite them for humans"*: causa, contexto y siguiente paso. Nielsen #9: los mensajes deben expresar el problema en lenguaje llano y sugerir una solución — no una solución equivocada.

**El escenario.** Al contador se le cayó el túnel a Postgres. Lee que su selección de entidad no se pudo resolver, corre `mnemosine entity use ACME`, que falla igual; corre `mnemosine entity unset`, y ahora perdió su selección además de seguir sin base. `mnemosine doctor` se lo habría dicho en una línea, y nadie se lo nombró.

### 11. Para definir una política hay que transcribir una llave `snake_case`; el recorredor de cola que sí existe se lo llevó la otra familia. MEDIA / esfuerzo S

**Evidencia.** `pending define` exige la llave (`src/cli/pending-command.ts:187-190`: `.argument('<key>', ...)`), y el panel la imprime como identificador (`renderPolicies`, `:107`: `${icon} ${c.bold(p.key)}${using}`). No hay selector numérico ni recorredor interactivo: los subcomandos son `define`, `dismiss`, `reopen`, los tres con `<key>` obligatoria. La familia hermana sí lo tiene:

```
$ npx tsx src/cli/mnemosine.ts question --help
  answer|responder [options] [id] [answer...]  Answer a question (the answer is saved as a
                                               precedent), or work the pending queue
```

`question answer` sin `id` recorre la cola. `pending` no tiene equivalente. Además `pending` quedó fuera del kernel de salida: `npx tsx src/cli/mnemosine.ts pending --json` → `error: unknown option '--json'`.

**Práctica que incumple.** Nielsen #6, *recognition rather than recall*. El patrón establecido es el de `git rebase -i` o `gh pr checkout`: se elige de una lista, no se transcribe un identificador.

**El escenario.** El contador quiere subir el umbral de capitalización. Lee el panel, teclea `mnemosine pending define umbral_capitalizacion_mxn 50000` —26 caracteres con dos guiones bajos y una abreviatura— y se equivoca. Obtiene `There is no pending decision with key "umbral_capitalizacion_mx"` y `List the open ones with: mnemosine pending`, que es de donde venía.

### 12. El costo se calcula, se guarda en la base, y no se le enseña a quien lo paga. MEDIA / esfuerzo S

**Evidencia.** La ingesta acumula el costo de la corrida con pinzas contra `NaN` (`src/cli/mnemosine.ts:1246-1258`) y lo escribe a `ai_ingest_runs` como `estimatedCostUsd` (`:1298`). El resumen que ve el humano al terminar (`:1322-1327`) es:

```
Summary: N auto-posted, N by rules, N draft(s), N blocked, N duplicate(s), N with errors
```

Sin una línea de costo. El chat tampoco imprime costo por turno. Y el presupuesto —que sí existe, bien razonado, aplicado en `createLlmSession` para que jobs, ingesta, chat e init lo hereden (`src/ai/budget.ts:6-24`)— **no tiene comando**:

```
$ npx tsx src/cli/mnemosine.ts --help | grep -i "budget\|presupuesto"
(sin resultados)
```

Vive solo en la sección `budget` de `mnemosine.config.json`, y `mnemosine usage` reporta lo gastado sin decir nunca contra qué tope ni a qué distancia de él. Además los importes son USD a cuatro decimales (`fmtUsd`, `src/cli/usage-command.ts:70`) para un despacho que factura en pesos.

**Práctica que incumple.** clig.dev, *"show progress"* y el principio de que una operación costosa reporta su costo cuando ocurre. La comparación válida es el consumo medido de Stripe o AWS: el gasto se ve en el momento y contra el límite.

**El escenario.** El despacho corre la ingesta de 900 CFDI de fin de mes en ocho clientes. Cada corrida imprime conteos y nada más. El tope diario `on_exceed: 'warn'` (default interactivo) deja pasar todo con un aviso. El costo aparece por primera vez cuando alguien piensa en correr `mnemosine usage`, o cuando llega el estado de cuenta del proveedor.

### 13. La conversación no tiene por dónde corregir al agente. MEDIA / esfuerzo S

**Evidencia.** Los comandos del chat son, completos: `/exit`, `/quit`, `/salir`, `/new`, `/nueva`, `/provider`, `/proveedor`, `/pending`, `/pendientes`, `/compact`, `/help`, `/ayuda` (`src/cli/mnemosine.ts:846-916`). No hay `/teach`, `/memory`, `/corrige`, ni forma de marcar un turno como equivocado. Y el `/help` del chat (`:909-916`) enumera como herramientas externas `mnemosine usage · status · jobs` — no menciona `review`, `drafts`, `question` ni `memory`, que son el lazo del producto.

**Práctica que incumple.** Nielsen #3 (control y libertad del usuario) y #7 (aceleradores): la corrección debe estar donde ocurre el error.

**El escenario.** El agente clasifica mal en el chat. El contador escribe "no, eso va a 6130". El modelo lo acepta dentro de la sesión y lo olvida al cerrarla, porque el digest de memoria solo se alimenta de `ai_questions` (ver Brecha 5). Para que quede, tenía que salirse del chat y correr `mnemosine memory teach "facturas de Telmex" "van a 6130 Servicios"`, un comando que ninguna superficie del chat le nombró jamás.

---

## RECOMENDACIONES

**Lo barato que mueve más (esfuerzo S, semanas, no meses):**

1. **Mover la capa explicativa al panel.** Que `pending -v` imprima `whyAsking`, `whatIDo`, `ifSkipped` y llame a `previewFor()`. Es reusar dos módulos ya escritos en `renderPolicies` (`src/cli/pending-command.ts:99-116`). Deja el preview inútil el día uno —está vacío por construcción— y útil el día 90, que es cuando el contador tiene con qué decidir. Es la mejor relación esfuerzo/impacto del repositorio.

2. **Traducir `pending-catalog.ts` al español de México.** 17 entradas. Es el texto de mayor densidad de juicio contable del producto, y el que un contador mexicano no debería tener que leer en inglés.

3. **Quitar el shim de deprecación de la acción por omisión del padre `question`** y hacer que dispare solo cuando el token invocado fue `questions`/`dudas`; y reemplazar las cinco referencias literales a `mnemosine questions` por `mnemosine question list`, incluyendo `src/ai/pending-service.ts:86` y `src/ai/compaction.ts:370` (esta última es lo que el agente le repite al usuario).

4. **Emitir el contrato de códigos que ya está escrito.** Al mínimo: `NEEDS_HUMAN` (11) cuando la ingesta deja borradores o preguntas —es el caso que el propio comentario de `exit.ts` describe— y un código de conexión distinguible de un error de datos. Mapear la clase de error de `pg` en `exitCodeFor` cubre los 75 sitios de una vez.

5. **Rutear la rama `else` de `reportError` por `repairCommandFor()`** (`src/cli/mnemosine.ts:253-255`). La función existe, es pura, y ya sabe mandar a `doctor`. Y ramificar el aviso de `entity-context.ts:110` por clase de error, como el comentario de arriba ya reconoce que hace falta.

6. **Imprimir el costo de la corrida** en el `Summary` de la ingesta —el número ya está calculado en `consumo.costo`— y mostrar en `usage` el tope vigente y la distancia a él.

**Lo que cambia el producto (esfuerzo M):**

7. **Darle al borrador un vínculo duro con su documento.** Una columna `xml_document_id UUID REFERENCES xml_documents(id)` en `ai_drafts` y su campo en `DraftRow`. Sin eso, la brecha 2 no se puede cerrar de ninguna manera.

8. **Reconstruir la pantalla de revisión sobre ese vínculo.** El CFDI —emisor, RFC, conceptos, impuestos, estatus SAT— junto al asiento propuesto; el precedente que el agente citó; el veredicto de la sombra; y la confianza acompañada del histórico de su bucket, que `ai stats` ya calcula. Y ampliar el prompt a `[a] [e]ditar [r] [s] [q]`, para que corregir-y-aprobar sea un acto.

9. **Convertir el rechazo en aprendizaje.** Tras un rechazo, ofrecer sembrar el criterio como precedente en un paso —el motivo ya está escrito, solo falta `teachMemory` con él— para que entre al digest del prompt como entra una pregunta contestada.

10. **Poner a `drafts` y `review` en el kernel de salida** (`withOutput`) y agregar `--min-confidence`, `--max-amount`, `--since` y orden. Con `--json` y filtros, un despacho puede construir su propio flujo de lote mientras llega la aprobación en bloque nativa.

11. **Un `pending answer` que recorra la cola** con selección numérica, calcado de `question answer` sin `id`, y un `pending` cross-entidad para el despacho de 40 clientes.

12. **Un `/teach` en el chat** y un `/help` que nombre el lazo real: `review`, `drafts`, `question`, `memory`.
