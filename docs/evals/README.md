# Evals del clasificador

`clasificador.jsonl` lo escribe `scripts/eval-clasificador.ts`: una línea por
corrida (fecha, proveedor, modelo, condiciones de medición, exactitud por
clase). El arnés compara cada corrida contra la anterior del mismo
proveedor+modelo — el archivo ES la memoria del «mejoró/empeoró». No se edita a
mano.

    npm run eval -- --provider anthropic
    npm run eval -- --provider anthropic --umbral 0.8   # exit 4 si no da la talla
    npm run eval -- --casos pue-recibido                # un caso suelto

Necesita `TEST_ADMIN_DATABASE_URL` (un rol con CREATE DATABASE; la base es
efímera y se destruye al terminar) y la credencial del proveedor elegido.

## Lo que mide: la superficie de la INGESTA, no la del chat

El arnés clasifica por el camino real (`ingestCfdiFiles`) y con la **misma
lista de herramientas** que embarca la hoja de `mnemosine ingest`:
`SUPERFICIE_INGESTA` (`src/ai/tools/superficie.ts`), once herramientas,
**importada y no copiada**.

Durante un tiempo no la pasaba, y `buildTools` sin lista devuelve **todas**:
veinticinco. El arnés medía a un agente con catorce herramientas de más —el
brazo externo entero (`external_pull`, `external_push`,
`external_diff_trial_balance`, `list_external_ops`), los seis estados
financieros, el mayor, `session_search`, `list_drafts`, `get_entity_status` y
`search_customers`— es decir, a un clasificador que nadie embarca. La cabecera
del propio guion lo prohibía por escrito («si el arnés reconstruyera las
compuertas por su cuenta, divergiría del producto y mediría un clasificador que
no existe») y hacía exactamente eso.

`tests/ai/eval/arnes-cableado.spec.ts` lo vigila leyendo el ÁRBOL de los dos
archivos: si alguna sesión del arnés deja de pasar `herramientas`, o si la pasa
con una lista copiada en vez de la constante, o si la hoja de la ingesta cambia
a otra superficie, se pone rojo.

## Códigos de salida: «medí y salió mal» no es «no pude medir»

El arnés salía con código **0 aunque el proveedor fallara el cien por ciento de
los casos**: el único camino a otro código era `--umbral`, y el paso de CI corre
a propósito sin él. Se comprobó ejecutándolo —`--provider ollama` con un id de
modelo inexistente— y devolvió «Model failure: 404», las ocho clases en 0.000 y
salida 0. Una credencial caducada o una caída del proveedor producían casilla
verde en el PR.

Hoy la salida usa la tabla de `src/cli/kernel/exit.ts`, que es donde esta
doctrina ya estaba escrita («conflating "I found problems" with "I could not
look" is how a green pipeline lies»):

| código | significa | qué haces |
|---|---|---|
| `0` OK | midió el corpus entero, y con `--umbral` da la talla | nada |
| `4` VALIDATION | **midió**, y el clasificador está por debajo del umbral | mira el clasificador |
| `8` EXTERNAL_FAILED | **no pudo medir**: el proveedor falló en uno o más casos, o la sesión no abrió | reintenta |
| `2` USAGE | bandera o argumento inválido | corrige la línea |
| `1` FAILURE | **no pudo medir** por el repositorio: un caso declara un panel que no se puede montar, el golden set no entregó casos, el corpus se desalineó del catálogo sembrado, o el arnés reventó | arréglalo; reintentar no cambia nada |

La precedencia va por lo que hay que hacer después: primero lo que se **arregla**
(1), luego lo que se **reintenta** (8), y sólo al final el juicio sobre el
clasificador (4).

**Una corrida que no midió el corpus completo no deja línea en la bitácora.** El
archivo existe para comparar; una media lectura escrita ahí es un número que la
corrida de mañana leería como entero, y la flecha diría del modelo lo que fue
del proveedor.

## El panel que el corpus declara se siembra ANTES de medir

`tests/golden/cfdi/` trae dos gemelos exactos —mismo emisor, mismo importe,
mismo concepto— que sólo se distinguen por el panel de políticas:

- `capitaliza-equipo-computo` declara `umbral_capitalizacion_mxn: "5000"` y
  espera un borrador capitalizado;
- `ask-equipo-computo` declara la **misma clave en `null`** («nadie la ha
  contestado») y espera que el agente **pregunte**.

El arnés no leía `precondicion` en absoluto: puntuaba los dos bajo el panel por
omisión (20 000) sin decir una palabra. O sea que el corpus embarcaba un caso
que el clasificador no podía pasar, y la comparación «contra la corrida
anterior» habría exhibido una regresión que no es del modelo.

Ahora, antes de cada caso, el arnés lee `politicasRequeridas(caso)`
(`src/ai/eval/golden.ts` — el corpus es quien sabe de qué panel depende cada
caso), siembra el panel con `seedPolicies` y contesta lo declarado con
`resolvePolicy`, en el alcance `{tenantId, entityId}` que es el que
`pre-registration-service` lee. Un `null` **no es un no-op**: se garantiza que
la clave queda sin contestar, porque el caso anterior pudo haberla contestado.
Al terminar cada caso el panel vuelve a pendiente.

**Si una precondición no se puede montar, el caso NO se puntúa** y la corrida
sale por `1`. Puntuar bajo un panel distinto del declarado es medir con una vara
chueca, y un cero así no sería del clasificador.

## Lo que hace comparables dos corridas

El arnés compara corridas. Esa comparación presupone que entre una y otra
cambió el **clasificador** y no el azar del muestreo — y esa premisa no se
sostenía sola: durante un año no hubo un solo `temperature` en los perfiles.

No es un temor teórico. Las tres primeras veces que este arnés se ejecutó
(2026-09-02, `ollama · gemma4:26b`, el **mismo** caso `pue-recibido`) el global
salió **0.750, 0.750 y 0.000**: las dos primeras clasificaron con confianza 0.70
y 0.80, y la tercera ni siquiera clasificó — preguntó. No oscila el tercer
decimal de la calibración: cambia el resultado de clase entre corridas
idénticas. Sobre eso el arnés estaba dispuesto a imprimir una flecha.

Por eso cada perfil de fábrica declara su postura en
`src/ai/providers/config.ts` (`Reproducibilidad`), y el arnés la **lee**:

| campo | qué dice |
|---|---|
| `muestreo: 'fijado'` | el proveedor admite clavar el muestreo; `temperature` dice en cuánto (0, porque esto es un clasificador) |
| `muestreo: 'no-admite'` | el proveedor lo **rechaza**, o el perfil no es evaluable en absoluto; `razon` dice cuál de las dos |
| `instantanea` | id fechado del modelo, para no pedir un alias que el proveedor repunta cuando quiera; `null` = ninguna fijada |
| `razon` | obligatoria. Una postura sin motivo es una opinión |

Un perfil definido por el usuario en `mnemosine.config.json` no declara nada, y
el arnés lo trata como «sin garantía de comparabilidad» en vez de suponerle la
postura del perfil de fábrica que reemplaza.

**Cuando la corrida no es comparable, el arnés no dibuja ninguna flecha.**
Registra la lectura marcada `comparable: false` y lo dice: un `▲` sobre dos
corridas irreproducibles afirma una mejora que nadie midió.

### Dos verdades incómodas que la tabla deja a la vista

- **El perfil por defecto es el que menos puede fijarse.** `claude-opus-5` es
  posterior a Claude Opus 4.6, y el SDK instalado lo dice en su propia
  deprecación de `temperature`: sólo se acepta 1.0, cualquier otro valor vuelve
  como 400. Tampoco hay instantánea que fijar — el id ya es exacto. Dos corridas
  del perfil que se embarca **no son comparables por construcción**, y el arnés
  lo anuncia en cada una en vez de fingir tendencia.
- **Lo declarado todavía no viaja por el cable.** `src/ai/agent.ts` y
  `src/ai/providers/openai-compat.ts` arman el cuerpo de la petición sin
  `temperature`. La constante `MUESTREO_CABLEADO` lo dice, el arnés lo repite en
  voz alta en cada corrida, y `tests/ai/eval/arnes-cableado.spec.ts` la contrasta
  contra esos dos archivos: si alguien cablea el muestreo y no sube la bandera,
  rojo; si la sube sin cablearlo, rojo. Una nota que se invalida sola en vez de
  envejecer.

## En CI

El job `Eval del clasificador` de `.github/workflows/ci.yml` levanta su Postgres
y corre el golden set. Necesita el secreto `ANTHROPIC_API_KEY`.

**Sin ese secreto el job se salta y lo anuncia** —un `::warning` en la corrida y
una nota en el resumen del PR— en vez de pasar en verde fingiendo que midió. Un
job que pasa por no haber mirado es exactamente el «green pipeline lies» que
`kernel/exit.ts` denuncia en su cabecera.

El paso corre **sin `--umbral`, a propósito**: la casa siembra sus trinquetes en
lo medido, y aquí no hay nada medido todavía contra el proveedor que se embarca.
`--umbral` entra en el mismo commit que registre la primera corrida real y pueda
sembrarlo en lo observado. El paso **es puerta igual**, porque un fallo del
proveedor ya sale por `8` en vez de por verde (ver la tabla de arriba).

La prueba que vigila este job **parsea el YAML**: encuentra el paso por su `run`,
**ejecuta** el guion de la puerta (`id: credencial`) con la credencial puesta y
sin ella, y evalúa el `if:` del paso contra esas dos salidas reales. Antes
buscaba subcadenas, y un adversario cambió el `if:` del eval a `if: false` sin
producir un solo rojo: la línea del `run` seguía en el archivo y `id: credencial`
seguía en los otros pasos. Invertir el `[ -n … ]` de la puerta a `[ -z … ]`
pasaba igual. Comprobar que un paso **existe** no es comprobar que sea
**alcanzable**.

## Lo que este arnés todavía NO ha hecho

La §7 del plan maestro pide, antes de ampliar la autonomía del agente, «una
lectura comprometida del arnés». **Esa lectura no existe.** El eval nunca ha
corrido contra el proveedor que se embarca, porque hacerlo requiere una
credencial del dueño.

Lo que sí quedó verificado, ejecutándolo, es que el arnés funciona de punta a
punta: carga el golden set, clasifica por el camino real de `mnemosine ingest`,
puntúa por clase, escribe la bitácora y compara contra la corrida anterior. Se
comprobó contra un modelo **local** (`ollama`, un modelo con herramientas), que
es un camino honesto para ejercitar el instrumento y **no** una lectura del
producto: mide otro clasificador. La condición de §7 la cumple el dueño con una
credencial suya, y hasta entonces se queda escrita aquí sin maquillar.

## Ruido conocido en el registro

Al terminar, una corrida imprime `SAT validation error: … database "…" does not
exist`. **No es un fallo del eval.** `PreRegistrationService` lanza la validación
del SAT sin esperarla (`this.satValidator.validateAndUpdate(xmlDocId).catch(…)`,
`src/services/xml-ingestion/pre-registration-service.ts`), y esa tarea sobrevive
al `teardown()` que destruye la base efímera. Se deja escrito aquí en vez de
taparlo con una espera en el arnés: la clase se arregla donde nace —esa llamada
no debería quedar suelta— y taparla desde aquí sólo movería el ruido de sitio.
