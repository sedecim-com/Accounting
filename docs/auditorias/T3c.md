# Auditoría adversarial de T3c «La salida que miente» (#90)

**Objeto:** `-o/--output` que no escribe el archivo (y que borra cuando escribe),
y los códigos de salida 8 y 9 publicados sin productor.
**Fecha:** 2026-09-07.
**Método:** censo propio → dos motores → un verificador adversarial por pieza,
que **tumbó las dos**. Cierra el quinto y último defecto de T3.

## Lo que el issue no decía, y era peor

El issue nombra una rama que ignora `--output`. Son **dos** —`--fields` a secas y
la tabla sin filas—, las dos salen con código 0 sin crear el archivo. Pero
`emit` hace `writeFileSync`, que **trunca**, y `cfdi show` rinde dos veces (la
cabecera del comprobante y luego los conceptos), así que el segundo borraba al
primero:

```
$ cfdi show <uuid> -o archivo ; echo $?
0
$ cat archivo
line_number  clave_prod_serv  descripcion  …        ← sólo los conceptos
```

El UUID fiscal, el emisor, el subtotal, el total y los impuestos: fuera. En
silencio, con código 0, en el archivo que alguien adjunta o archiva.

Y el issue se equivoca en el otro extremo: afirma que `STATUS_TO_EXIT` no mapea
502/503/504, y **hoy sí los mapea**. Lo que faltaba era lo contrario — que
ninguna clase de error del árbol llevara esos estados, de modo que el mapa nunca
se activaba. El 8 tenía productor fuera del CLI (`eval-clasificador.ts`); el
**9 no tenía ninguno en todo el árbol**.

## La regla, no los parches

`render` se parte: `compose` produce el TEXTO y `emit` es la única escritura de
datos. `-o` **acumula dentro de la invocación y trunca entre invocaciones**,
como `>`: la primera escritura crea, las siguientes añaden, y un conjunto de
rutas que nace vacío con el proceso impide que un cron duplique su extracto cada
noche. La rama de cero filas escribe el archivo vacío —cero filas es un
resultado— sin borrar lo que otra rama del mismo comando ya puso.

Del lado de los enteros: el adaptador clasifica sus cuatro desenlaces, la clase
de error sobrevive al re-envoltorio (`external-service.ts` la re-lanzaba como
`Error` pelado, deshaciendo en el último paso lo que el adaptador había
clasificado), y el veredicto de un lote es **8 si alguna se puede reintentar** y
9 sólo si todas fueron rechazadas: condenar el lote entero dejaría sin reintento
a la operación que sí podía salir bien.

## Lo que el adversarial tumbó, y cómo quedó

**Tres guardas, no una.** El motor de (A) afirmó que `entry show` era «la ÚNICA
guarda de modo humano que no consultaba `opts.output`». Son **tres**:
`period show` y `year show` (`period-command.ts:279` y `:605`) tenían la misma
omisión, y arregló una. Medido después del parche: `period show -o F` **seguía
saliendo 0 sin crear F** — la frase exacta con la que se abre el tramo. Las tres
preguntan ahora al predicado canónico del kernel en vez de copiar a mano tres de
sus cinco cláusulas.

**La garantía estructural no era estructural.** El diseño decía que quien compone
«no tiene a dónde escribir». `process.stdout` es global: `compose` podía escribir
por ahí y devolver la cadena vacía sin que el compilador, el tipo ni ningún
criterio lo vieran. Es la fuga que este tramo existe para cerrar, cometida por su
propio instrumento. Se sustituyó la afirmación por una **prueba que espía
stdout** mientras compone cada formato y cada rama con `-o`, y exige cero
escrituras de dato. Verificada rota metiendo la fuga a mano.

**El JSON dejaba de ser JSON.** Al acumular, `cfdi show --json -o` concatenaba
dos sobres `{schema,count,rows}` y el archivo dejaba de parsearse. Antes era JSON
válido **por accidente** —sólo sobrevivía el último—, y el accidente se acabó al
arreglar el truncado. Ahora, en modo máquina, `cfdi show` compone UN documento
con los conceptos anidados, que es lo que `entry show` ya hacía.

**Dos contadores paralelos podían salir 0 con el lote entero fallado.** `failed++`
y `veredictos.push(...)` había que sincronizarlos a mano, y `batchExitCode([])`
devuelve OK. Antes del tramo eso era imposible porque el número y el código
salían de la MISMA variable. Se conserva esa propiedad: el conteo **es**
`veredictos.length`.

**El criterio de (B) era 100 % texto** y sobrevivía a la neutralización que
convierte un rechazo definitivo en «reintentable» — el daño que describe su
propio primer espejo. Ahora **ejecuta el reparto** (`exitCodeFor` sobre las dos
clases y `batchExitCode` sobre un lote mixto) antes de leer el fuente. Es la
misma lección de T3b: el seam del arnés gobierna la lectura de texto, así que un
criterio que sólo importa módulos es inmune a su propio espejo, y uno que sólo
lee texto sobrevive a la conducta rota. Hacen falta las dos mitades.

**Y un espejo era un no-op medido.** Reescribía `response.json()` como
`Promise.resolve(response).then(...)` — lo mismo, dentro del mismo `try`—, así
que mataba al criterio por su expresión regular y no por la conducta. Se cambió
por el que sí neutraliza: sacar la decodificación **fuera** del `try`, que es el
defecto literal.

**Dos artefactos acompañantes faltaban y CI se ponía rojo** en dos puertas que
salen 0 en `main` limpio: el criterio nuevo no estaba en el piso, y el corpus no
estaba resellado. Releí los dos manuales afectados antes de sellar —
`external-integrations.md` (64 líneas) y `accounting.md` (29)—: la prosa de los
dos sigue siendo fiel, porque el cambio es de clasificación de errores y de
modos de render, no de las herramientas ni los flujos que describen. Al primero
se le **añadió** lo que ahora sí existe y el agente necesita: qué debe decirle al
humano cuando `outbox run --live` muere con 8 o con 9.

## Del lado de (B), lo que resistió

El verificador de (B) no encontró **ni una sola afirmación falsa**: reprodujo los
seis desenlaces de `onboard --provider contalink` (1/1/1/1/1/1 → 8/8/9/8/9/8),
los tres de `outbox run --live`, que `sync` no existe, que el 424 estaba libre, y
que los cinco espejos mueren. Su veredicto fue «la ingeniería resiste; la entrega
no», y lo que no entregaba eran los dos artefactos de arriba.

## Batería

248 archivos y 5 385 pruebas unitarias · 87 y 1 188 de integración · 128
mutantes, todos muertos · piso y `--exigir` en verde · lint 1117/1161 sin
errores · `ux:status`, `catalogo-estado` y `corpus-manifiesto` sin deriva.

Con esto T3 (#90) queda cerrado en sus cinco defectos: #170 la frontera de
inquilino, #171 la regla R11 y la llave, y éste la salida.
