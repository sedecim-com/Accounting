# Trabajar con el agente

Esta es la parte del producto que no tiene equivalente en CONTPAQi ni en Aspel: hay un modelo de lenguaje leyendo tu contabilidad, que propone pólizas y hace preguntas cuando no sabe. Esta página enseña a trabajar con él: cómo preguntarle, cómo entender lo que propone, cómo revisar sin firmar a ciegas, cómo corregirlo para que no repita el error, y cómo saber cuánto te está costando.

La frase que gobierna todo lo demás: **el agente propone y una persona dispone.** No es una política que alguien pueda cambiar desde un menú. El modelo no tiene ninguna herramienta que escriba en el mayor, ni que timbre, ni que mueva dinero. Lo que hace es dejar propuestas en una bandeja. El mecanismo por el que eso se garantiza está en [[El-agente-y-sus-limites]]; aquí sólo lo vas a usar.

> Si al teclear `mnemosine` tu terminal responde «command not found», todo lo de esta página se escribe `npm run mnemosine -- <comando>`, con los dos guiones. Ver [[Puesta-en-marcha]].

---

## Antes de nada: la interfaz está en inglés

Décelo aquí para que no lo descubras a mitad de un cierre. Los nombres de comando tienen alias en español —`revisar`, `borradores`, `pendientes`, `memoria`, `duda`— y funcionan siempre. Pero la **ayuda** de los comandos y casi todos los mensajes salen en inglés. Lo que sí habla español es el agente:

```bash
mnemosine lang
```

```text
Agent response language: es
Change it with: mnemosine lang en|es (or MNEMOSINE_LANG env var)
```

`es` es el valor por omisión. Esa opción gobierna el idioma de las **respuestas del agente**, no el de la interfaz. Es una brecha conocida y está registrada en [[Auditorias]].

---

## Preguntarle: `ask` y `chat`

Dos formas, misma capacidad.

**Una pregunta suelta, sin abrir sesión:**

```bash
mnemosine ask "¿cómo va la balanza de agosto?"
mnemosine ask "¿qué clientes me deben y desde cuándo?"
```

**Una conversación:**

```bash
mnemosine chat
```

`chat` es además el comando por omisión: `mnemosine` a secas abre la conversación. Dentro de ella hay seis órdenes que empiezan con diagonal:

| Orden | Qué hace |
|---|---|
| `/help`, `/ayuda` | Ejemplos de qué preguntar (hoy salen en inglés) |
| `/pending [-v]` | El panel de decisiones sin salir del chat |
| `/compact` | Resume los turnos viejos para liberar contexto |
| `/provider <nombre>` | Cambia de modelo a media sesión (arranca conversación nueva) |
| `/new`, `/nueva` | Reinicia la conversación |
| `/exit`, `/salir` | Sale |

El agente lee tu contabilidad de verdad: catálogo, pólizas, mayor, balanza, estados financieros, antigüedad de saldos, terceros, documentación normativa. Lo que **no** puede es escribir. Cuando le pides «registra la renta de agosto», lo que hace es dejar un borrador en la bandeja: la póliza no existe hasta que tú la apruebas.

**Las sesiones se guardan y se pueden retomar:**

```bash
mnemosine sessions
mnemosine chat --resume <id>
mnemosine chat --continue
```

Aquí hay una honestidad que ahorra frustración: **`--continue` te devuelve la transcripción, no la memoria del modelo.** Vuelves a ver los últimos intercambios en pantalla, y la fila de auditoría sigue siendo la misma sesión, pero el modelo arranca en blanco. La propia salida lo dice. Si en la sesión de ayer le explicaste un criterio, hoy hay que volver a dárselo —o mejor, sembrarlo como precedente, que es la sección de más abajo.

---

## De dónde salen los borradores: la ingesta

La mayoría del trabajo del agente no nace de una conversación sino de un lote de CFDI:

```bash
mnemosine ingest ./cfdis/*.xml --dry-run
mnemosine ingest ./cfdis/*.xml
```

Corre en tres capas, en ese orden:

1. **Reglas deterministas** — deduplicación, amarre con el proveedor, motor de reglas. Si una regla cubre el documento, gana y el modelo ni se entera.
2. **Clasificación del modelo** — para lo que las reglas no cubrieron. Produce un borrador con su confianza y su razonamiento.
3. **Umbrales de auto-posteo** — apagados por omisión. Ver la escalera de autonomía, más abajo.

La marcha seca es honesta sobre su propio alcance: dice que sólo corrió la capa determinista, y que las reglas del despacho, la clasificación y el plan de la póliza se deciden en la corrida de verdad. Sirve para ver cuántos archivos hay, cuáles ya estaban y cuáles son nuevos; no para ver el asiento que se va a proponer.

Una advertencia de forma: `ingest` espera rutas a archivos XML sueltos. Un `.zip` recién bajado del portal del SAT hay que expandirlo primero.

---

## Revisar bien

El día a día del agente pasa por dos comandos.

### Ver la cola

```bash
mnemosine drafts
mnemosine drafts -s pending_review
mnemosine drafts -s rejected
```

Cada renglón trae fecha, descripción, número de renglones, confianza, estatus e identificador. **No trae el importe**, y no hay filtros ni `--json`: es una lista, no una herramienta de triaje. Si la cola trae 200 borradores y quieres atacar primero los grandes, hoy no se puede desde aquí. Es la brecha más señalada de esta familia en [[Auditorias]].

### Trabajar la cola

```bash
mnemosine review
```

Recorre uno por uno los borradores pendientes. De cada uno ves: identificador, fecha, **confianza de la IA**, descripción, referencia (serie, folio y UUID del CFDI cuando viene de una ingesta), el **razonamiento** del modelo, y la póliza completa renglón por renglón con cargos, abonos y su suma al pie.

Al final de cada borrador, cuatro teclas:

```text
[a]pprove and post  [r]eject  [s]kip  [q]uit >
```

Cuatro cosas que hay que saber antes de tocarlas:

- **`a` aprueba Y postea.** No hay un paso intermedio: la póliza se crea y entra al mayor en el mismo acto. Deshacerla después es `entry reverse`, que deja el espejo y su rastro; no hay borrado.
- **`s` es *skip*, no «sí».** Y cualquier otra tecla —incluido Enter en blanco, incluido escribir `si`— hace exactamente lo mismo que `s`: pasa al siguiente **sin decir nada**. Si tecleaste algo esperando aprobar y no viste el mensaje `✔ Journal entry … created and posted.`, no aprobaste.
- **`r` pide el motivo.** Escríbelo bien: queda guardado y es lo que vas a leer dentro de tres meses cuando alguien pregunte por qué ese CFDI no está en el mayor.
- **Apruebas lo que viste, no una fila.** El sistema calcula la huella del contenido que se te mostró y la vuelve a comprobar al aprobar. Si el borrador cambió entremedias, la aprobación se aborta en vez de postear algo distinto de lo que juzgaste.

Si el catálogo de cuentas cambió desde que se creó el borrador y ya no valida, `review` te lo dice con la lista de errores y lo deja pendiente en vez de tirarlo.

### Lo que conviene mirar antes de aprobar

La pantalla de revisión no trae el CFDI al lado —eso está pendiente—, así que para un borrador que no te cuadre, la referencia trae el UUID y con él, en otra terminal:

```bash
mnemosine cfdi show <uuid>
mnemosine cfdi explain <uuid>
```

`cfdi explain` es la mejor herramienta del producto para esto: reconstruye **por qué** el documento se registró como se registró —el caso, los hechos y las decisiones que el clasificador dejó anotadas—. Es material de papel de trabajo: es lo que enseñas cuando alguien pregunta por qué una cuenta quedó donde quedó.

Y para una póliza ya posteada, las siete reglas NIF sin escribir nada:

```bash
mnemosine entry check --entry <numero>
```

### Sobre las compuertas de confirmación

Cuando salgas de `review` y trabajes con `entry post`, `invoice issue`, `payment create` o `bill approve`, vas a ver un `[y/N]`. **Ahí sólo se acepta `y` o `yes`.** Escribir `s`, `si` o `sí` **cancela** la operación, y el mensaje que recibes es un escueto `Aborted.` que no explica que la respuesta no se entendió. Es un defecto conocido y está en [[Auditorias]]; mientras se arregla, la costumbre segura es `y` para sí y `n` para no, siempre, en todo el producto.

---

## Corregirlo y enseñarle

Aquí está la parte que más cambia la relación con el agente, y la que menos se descubre sola.

**Rechazar un borrador no le enseña nada.** El motivo que escribes se guarda junto al borrador y ahí se queda. El modelo *puede* ir a leerlo si en una conversación decide consultar los rechazados, pero eso es una lectura opcional, no un ciclo de aprendizaje. Si rechazas catorce facturas del mismo proveedor por la misma razón, el mes que viene te va a proponer lo mismo catorce veces.

Lo que sí entra al conocimiento permanente del agente son los **precedentes**. Se siembran a mano:

```bash
mnemosine memory teach "facturas de Telmex" "van a 6130 Servicios, no a 6110"
mnemosine memory teach "consumos en restaurante" "8.5% deducible; el resto a gastos no deducibles" --topic gastos
```

Y se administran:

```bash
mnemosine memory                       # los precedentes vigentes del despacho
mnemosine memory --search restaurante
mnemosine memory correct <id> "<respuesta nueva>"   # la anterior queda en el historial
mnemosine memory retire <id>                        # deja de usarse; no se borra
mnemosine memory restore <id>
```

Los precedentes vigentes se inyectan en el contexto de **todas** las sesiones futuras, automáticamente. Por eso son controlables: se corrigen, se retiran y se restauran, y cada cambio deja historial. Es la única palanca de aprendizaje real que tienes hoy, y por eso la regla práctica es corta: **cada vez que rechaces un borrador por un criterio que se va a repetir, siembra el criterio con `memory teach` en el mismo momento.** Son dos comandos en lugar de uno, y es la diferencia entre corregir una vez y corregir cada mes.

---

## Contestar sus preguntas

Cuando el agente no sabe, la respuesta correcta es que pregunte, no que adivine. Esas preguntas se acumulan:

```bash
mnemosine question list
mnemosine question answer            # recorre la cola pendiente, una por una
mnemosine question answer <id> "<respuesta>"
mnemosine question answer <id> 2     # cuando la pregunta trae opciones numeradas
```

**Cada respuesta se guarda como precedente.** Eso es lo que la distingue de contestar por chat: contestar en el chat resuelve el turno; contestar una pregunta resuelve el criterio, y el criterio viaja a todas las sesiones siguientes y se ve en `mnemosine memory`.

`question list` sí tiene el contrato de salida completo (`--format`, `-o`, `--fields`, `-q`), así que la cola de preguntas sí se puede volcar a CSV o a JSON para repartirla en el despacho.

---

## El panel de decisiones: `pending`

Hay bifurcaciones que el sistema no puede resolver por su cuenta porque no son técnicas sino de criterio del despacho: desde qué monto se capitaliza un activo, qué se hace con un CFDI de un periodo ya cerrado, cuánta diferencia entre un REP y el pago registrado sigue siendo redondeo. Son **17** y viven en un solo lugar:

```bash
mnemosine pending          # trabajo por resolver + decisiones por definir
mnemosine pending -v       # con impacto, opciones y por qué esa omisión
mnemosine pending -a       # incluidas las ya resueltas y las descartadas
```

La propiedad importante: **el sistema nunca se bloquea por falta de definición.** Mientras nadie conteste, se opera con la omisión declarada y la pregunta queda visible con la leyenda `operating with: <valor>`. No hay pantallas que se atoren esperando una política.

Definir, descartar y reabrir:

```bash
mnemosine pending define umbral_capitalizacion_mxn 15000 -n "acuerdo con el cliente, junta de marzo"
mnemosine pending define politica_restaurantes        # sin valor: pregunta y muestra las opciones
mnemosine pending dismiss tratamiento_ieps            # no aplica a este despacho
mnemosine pending reopen rep_tolerancia_importe       # la política cambió
```

La nota (`-n`) no es decorativa: es lo que explica, meses después, por qué el umbral es el que es.

**Un truco que vale la pena conocer.** El panel de `pending -v` te da impacto, opciones y la razón de la omisión. Pero hay una capa explicativa más larga —por qué se pregunta, qué hace el sistema con cada respuesta, qué pasa si la dejas abierta— y una **vista previa contra tus propios datos** («con un umbral de 20,000 te habría interrumpido 8 veces el año pasado; con 50,000, dos»). Esa capa hoy sólo la muestra el asistente:

```bash
mnemosine init --section policies
```

El día del alta esa vista previa sale vacía, porque todavía no hay historia que mirar. **Vuelve a correrla a los dos o tres meses**, cuando ya ingeriste un par de cierres: ahí es cuando de verdad sirve, y ahí es cuando las decisiones que tomaste a ciegas el primer día se pueden revisar con datos.

---

## La escalera de autonomía: apagado, sombra, encendido

La decisión `ingest_auto_post` es la que responde a «¿puede este sistema contabilizar una factura sin que yo la vea?». Tiene tres peldaños, y el de en medio es el que hace que la pregunta tenga respuesta seria.

| Valor | Qué pasa |
|---|---|
| `off` (omisión) | Todo queda en borrador. Nada llega al mayor sin que alguien apruebe. |
| `shadow` (sombra) | Las compuertas corren **completas**, el veredicto se anota, y **nada se postea**. |
| `on` | Postea solo cuando la confianza, el importe y el proveedor pasan los umbrales. |

### Qué es la sombra, en términos de despacho

La sombra es un **período de prueba con expediente**. Por cada CFDI que entra, el sistema decide, en silencio, si lo habría contabilizado solo y con qué umbrales; anota esa opinión; y después deja que tú decidas como siempre. Al cabo de unas semanas tienes lo único que permite responder la pregunta con honestidad: **la lista de veces en que la máquina y la persona coincidieron, y las veces en que no.**

No es una simulación aparte. El modo real y el modo sombra usan el mismo evaluador, precisamente para que la sombra no acabe midiendo un clasificador que no existe. Y la opinión se escribe una sola vez por documento, con los umbrales que estaban vigentes ese día: un veredicto sin sus supuestos no se puede auditar seis meses después.

Encenderla:

```bash
mnemosine pending define ingest_auto_post shadow -n "medimos un trimestre antes de decidir"
```

### Por qué encender no es un interruptor

Contestar `on` no basta con teclearlo. El sistema comprueba la evidencia acumulada y **rechaza la respuesta** si no llega. El piso está en código y dice cuánto falta:

- al menos **7 días distintos** con veredictos,
- al menos **10 veredictos** que una persona haya decidido después,
- al menos **90 % de acuerdo** entre lo que la sombra habría hecho y lo que la persona hizo.

Son piso, no configuración: un despacho puede medir más tiempo, nunca menos. Y el acuerdo se mide contra el **juicio humano**: lo que se aprobó por umbral o por política no cuenta en el denominador, porque comparar la máquina contra sí misma no prueba nada.

Hay un segundo piso, de importe: aunque el despacho configure un tope más alto, **ningún asiento por encima de 50,000 en la moneda funcional se postea sin humano**. La configuración se combina con el piso tomando siempre el menor de los dos.

### Ver la evidencia antes de decidir

```bash
mnemosine ai stats
```

Es el comando que existe exactamente para esta decisión. Da la aprobación por **bucket de confianza** y el **delta** entre lo que el modelo creyó y lo que la persona confirmó. Un delta positivo grande significa que el modelo se cree más de lo que acierta, y es la señal de no encender todavía. También trae cuánto de la cola sigue pasando por un humano, el costo de la ingesta y el costo por borrador, la duración de las llamadas, y el conteo de eventos —documentos marcados como sospechosos, correcciones de fundamentación, cambios de proveedor por fallo—.

Admite el contrato de salida completo, así que se puede archivar:

```bash
mnemosine ai stats --format csv -o evidencia/2026-08-calibracion.csv
```

### Cuando ya está encendido

Los umbrales se resuelven en este orden: **bandera de la corrida > archivo del operador > política del despacho > omisión del código**.

```bash
mnemosine ingest ./cfdis/*.xml --auto-post --min-confidence 0.95 --max-amount 8000
mnemosine ingest ./cfdis/*.xml --no-auto-post     # apaga el auto-posteo para esta corrida
```

Y cada póliza que llegó al mayor sin humano lo dice en sus notas de revisión, con la **fuente** del umbral que la dejó pasar. «Lo encendió la política del despacho» y «lo encendió un archivo local de esta máquina» son responsabilidades distintas, y meses después la diferencia importa.

El modo sombra, en cambio, sólo lo enciende el panel: no hay bandera ni archivo que lo active. Medir es una decisión del despacho, no un ajuste de corrida.

---

## Cuánto cuesta

El agente consume tokens y los tokens se pagan. Hay dos miradas.

```bash
mnemosine usage
mnemosine usage --since 30d --by day
mnemosine usage --by model
mnemosine usage --by session
```

Sale del registro local: no hace llamadas a la API. El propio comando lo etiqueta como **estimación local, no facturación**, y arrastra la fecha de la tabla de precios con la que calculó; los modelos cuyo precio no conoce salen marcados en vez de descartarse en silencio. Los importes son en dólares.

Y un tope, si lo quieres, en la sección `budget` de `mnemosine.config.json` (`daily_usd`, `monthly_usd`, `on_exceed`). Se aplica en el punto donde nace toda sesión, así que lo heredan el chat, la ingesta, los trabajos programados y el asistente sin código propio. Dos detalles que conviene conocer: en una corrida **desatendida** el comportamiento por omisión al excederse es **bloquear** —en una corrida sin nadie mirando, «sólo avisa» significa que no hay tope—, y si el gasto no se puede consultar, en modo aviso se abre diciéndolo y en modo bloqueo la sesión no arranca. Un tope que no puede medirse no finge que midió.

Lo que **no** hay hoy: el resumen que imprime `ingest` al terminar no incluye el costo de la corrida, aunque el número se calculó y se guardó. Para verlo hay que ir a `usage` o a `ai stats`.

---

## Lo que el agente no hace hoy

Esta lista existe para que no la descubras en un cierre.

- **No conduce el cierre de mes.** Sabe qué periodo toca y qué le falta —incluidos los bloqueadores que el motor no ve: borradores esperando revisión, preguntas sin contestar, operaciones encoladas— y te lo puede decir. Pero `mnemosine close` está declarado irreversible y por construcción no puede ser una herramienta suya. El cierre lo teclea una persona. Ver [[Manual-El-cierre-de-mes]].
- **No aprende de tus rechazos.** Ya está dicho arriba: el ciclo de aprendizaje pasa por `question answer` y `memory teach`, no por el motivo del rechazo.
- **`--continue` no le devuelve la memoria**, sólo te devuelve la transcripción a ti.
- **`review` no filtra ni aprueba en lote.** Es una cola primero-en-entrar, completa y sin cota. Con 200 borradores son 200 decisiones a mano.
- **La pantalla de revisión no trae el comprobante al lado.** Hay que copiar el UUID y consultarlo aparte.
- **`drafts` no muestra importes ni tiene salida de máquina.** No se puede triar por materialidad desde la terminal.
- **No timbra, no cancela ante el SAT, no presenta declaraciones y no mueve dinero.** Nada de eso es una herramienta suya, ni puede serlo.

Cada uno de estos huecos está registrado con su evidencia en [[Auditorias]] y priorizado en [[Hoja-de-ruta]].

---

## Una rutina que funciona

**Cada día que llegan comprobantes**

```bash
mnemosine entity use <RFC del cliente>
mnemosine ingest ./cfdis/*.xml
mnemosine question answer      # primero las preguntas: sus respuestas son criterio
mnemosine review               # después la cola de borradores
```

Contestar antes de revisar no es capricho: la respuesta se vuelve precedente y mejora lo que el agente proponga en las siguientes corridas.

**Cada semana**

```bash
mnemosine pending              # qué hay por resolver y qué decisiones siguen abiertas
mnemosine memory               # ¿los precedentes vigentes siguen siendo el criterio del despacho?
mnemosine usage --since 7d
```

**Cada mes, antes de cerrar**

```bash
mnemosine drafts -s pending_review    # que la cola quede en cero
mnemosine ledger stale-draft list --days 7
mnemosine ai stats                    # la evidencia, si estás midiendo en sombra
```

---

## Para seguir

- [[Manual-El-dia-a-dia]] — la captura y el posteo manual, que es lo que rodea a todo esto.
- [[Manual-El-cierre-de-mes]] — el cierre, que el agente prepara y una persona firma.
- [[Manual-Reportes-y-entregables]] — lo que sale hacia el cliente.
- [[El-agente-y-sus-limites]] — el mecanismo: las dos bandejas, el suelo inamovible, cómo se mide el clasificador.
- [[Proveedores-de-modelo]] — qué modelo responde y dónde vive la llave.
- [[El-tablero-y-los-criterios]] — cómo se verifica cada afirmación de esta página.
