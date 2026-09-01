# El catálogo es el plan, no el inventario

[`docs/cli-command-catalog.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/cli-command-catalog.md) es un documento de diseño de más de tres mil líneas. Describe **la superficie de comandos completa que el CLI debe llegar a tener**, fila por fila, con cada renglón contrastado contra el backend real del repositorio.

No es documentación de uso. Lo que existe hoy y se puede teclear vive en otro archivo, generado del binario, y se explica más abajo. Confundir los dos es el error que este documento existe para no permitir.

---

## Por qué hay un catálogo y no una lista de deseos

El sistema tiene dos mitades de tamaño muy distinto. El backend contable —servicios de cuentas por cobrar, por pagar, bancos, activos, inventario, nómina de México y de Estados Unidos, CFDI, reportes— es grande y es alcanzable por HTTP. La superficie de terminal es mucho más chica.

Un contador no podía emitir una factura, registrar un pago, conciliar un banco, correr la nómina, depreciar un activo, timbrar un CFDI ni sacar un estado financiero desde la terminal. Toda esa capacidad existía y solo la alcanzaba una petición HTTP. El catálogo es el plan para cerrar esa brecha **sin que la superficie se vuelva incoherente en el camino**, que es el modo normal en que un CLI grande se arruina.

Cada fila se escribió contra investigación del proceso contable real —cómo lo resuelven SAP, NetSuite, Dynamics, Sage Intacct, QuickBooks, Xero, Odoo, CONTPAQi, Aspel, Contalink— y después se verificó **abriendo el archivo del repositorio que decía implementarla**. Esa etapa de verificación adversarial produjo 507 correcciones, la mayoría backends reclamados que no existían: un `bill schedule` que solo agregaba texto a un memo, un `cfdi status pull` cuyo servicio devolvía un «Vigente» fijo, un `1099 submit` cuyo adaptador lanzaba excepción fuera de los formularios 941/940/944/945.

La razón de tanto rigor está escrita en el documento: **un visto bueno falso es el peor defecto posible aquí**, porque hace que un comando imposible parezca trabajo de una hora.

---

## Cómo se lee una fila

Cada familia se organiza en subgrupos con una tabla de siete columnas:

| Columna | Significado |
|---|---|
| **Comando** | La invocación canónica en inglés y, tras un separador, su alias en español. `<arg>` obligatorio, `[arg]` opcional |
| **Qué hace** | El efecto concreto, en una línea |
| **Flags clave** | Los que deciden el comportamiento, no todos |
| **Backend** | Un símbolo: palomita si ya está implementado (con la ruta y la línea), círculo amarillo si es parcial, tache si hay que construirlo |
| **Riesgo** | `lectura`, `escritura` reversible, `irreversible`, o `externo` |
| **IA** | Si el agente puede invocarlo solo, o si exige un humano |
| **Fase** | 1, 2 o 3 |

La columna **IA** no es estilo, es una propiedad de seguridad, y su regla es la más importante del documento:

> Un comando exige humano si su backend postea al mayor, mueve dinero, timbra, cancela, presenta ante una autoridad, borra datos, envía algo al exterior o consume una credencial del cliente contra un tercero — **aunque una bandera pudiera volverlo inofensivo**.

Esa última cláusula es la clave. **El permiso del agente nunca puede depender del valor de una bandera**, porque entonces la seguridad deja de ser una propiedad del código y pasa a ser una propiedad de cómo se invocó el comando. Donde el diseño original hacía eso, el comando se parte en dos comandos distintos, uno permitido y otro prohibido, sin excepciones. Ver [[El-agente-y-sus-limites]].

### Las tres fases

| Fase | Criterio de corte |
|---|---|
| 1 | Sin esto no se puede llevar una contabilidad completa desde el CLI |
| 2 | Lo que un despacho serio necesita para operar clientes reales |
| 3 | Consolidación, analítica y automatización avanzada |

La fase es un dato de la fila, no una opinión de la portada, y el medidor la usa para publicar el avance de lo indispensable por separado del resto.

---

## El bloque generado, y la portada que duró 42 commits

Dentro del documento hay un bloque delimitado por dos marcadores HTML, `ESTADO-GENERADO:INICIO` y `ESTADO-GENERADO:FIN`. Ese bloque **no se edita a mano**. Lo escribe [`scripts/catalogo-estado.ts`](https://github.com/sedecim-com/Accounting/blob/main/scripts/catalogo-estado.ts):

```bash
npm run catalogo:estado
```

Existe porque el dato más útil del documento —cuánto de esa superficie existe ya— estaba escrito a mano y decía «~30 comandos, casi todos de plomería del agente» cuando el binario ya respondía más de cien, doce familias de ellas contables. Duró 42 commits. Es la misma lección que dejó la tabla de estado del plan de cierre, y por eso la casa tiene **dos marcadores y cero copias**: `npm run plan:status` decide los paquetes (ver [[El-tablero-y-los-criterios]]), `npm run catalogo:estado` decide las filas.

Lo que el bloque publica hoy, y que se vuelve a preguntar con ese comando:

- **134 comandos** en **45 familias** de primer nivel es lo que el binario ejecuta.
- De las **1 624 filas** del catálogo, **119** ya se pueden invocar: **7,3 %**.
- Del motor que cada fila necesita, **191** filas lo declaran completo, **426** a medias y **1 007** inexistente.
- **Fase 1** son **379** filas, de las que **108** ya se teclean.

Lo que el script genera es **solo lo que se puede derivar**: qué rutas del catálogo responde el binario, cuántas filas hay, cómo se reparten por fase y por familia, y si las citas `archivo:línea` resuelven. El juicio de cada fila —si el motor existe, está a medias o no existe— sigue siendo humano y sigue escrito a mano, porque no es mecánico. Lo que se pretende es que nadie tenga que volver a **contar**.

---

## Cómo se cuenta, que no es obvio

Un documento de referencia que se equivoca por uno se lee igual de mal que uno que se equivoca por cien. Cada regla de conteo del script arregla un error medido.

**Una fila no es un comando.** La ruta de comando son los tokens hasta el primer argumento o bandera: `entry post <id> --force` es el comando `entry post`. Sin ese recorte, cada fila con un argumento distinto contaría como un comando distinto.

**Las 1 624 filas son 1 603 rutas únicas.** Hay **16 rutas catalogadas en más de una sección**, que suman **21 filas repetidas** — `close` aparece seis veces, `statement show` tres, y catorce rutas más dos veces cada una. El plan estimaba a mano «5 solapamientos»; contados por el instrumento son estos. Ninguna fila se borra: cada sección describe el comando desde su dominio y el registro reparte la propiedad. Pero **el total de filas no es un total de comandos**, y presupuestar por fila contaría dos veces esas rutas.

**Dos filas no son comandos en absoluto.** El documento tiene filas-contrato —del tipo `mnemosine <noun> <verb> --format <fmt>`— cuya propia celda dice «no es un comando». El medidor las contaba como comandos, y peor, como **invocables de fase 1**, porque su ruta colapsa a la cadena vacía y la vacía cuenta como la invocación desnuda. Hoy quedan fuera del conteo por una firma precisa: la ruta colapsa a vacía sin ser la invocación desnuda. Un `<noun>` como argumento de un comando real, como `schema show <noun>`, no cae ahí — la primera versión del filtro se lo comía y el total salía 1 623 en vez de 1 624.

**El objetivo comprometible son 1 380 filas.** Las **244** de fase 3 cuyo motor no existe quedan declaradas fuera: analítica y consolidación sobre motores inexistentes no es deuda, es aspiración. No se borran, se conservan como respaldo. El corte es **mecánico** —fase 3 más tache—, así que una fila de fase 3 que gane motor vuelve a contarse sola, sin que nadie edite una lista.

**Los menús no son comandos, pero sí pueden tener fila.** `mnemosine report` no ejecuta nada: imprime su ayuda. El árbol del binario separa hojas de grupos porque contar los menús como comandos inflaba la cifra de portada y, peor, hacía aparecer treinta menús como «comandos vivos sin fila», convirtiendo 39 desajustes reales en 69. Aun así, el conteo de *invocables* incluye los grupos a propósito: el catálogo tiene filas para algunos de ellos —`sat cred` es un grupo con fila propia— y marcarlas como no invocables sería falso.

**Las tuberías dentro de las celdas.** Partir una fila de markdown con `split('|')` rompía 133 filas: las celdas llevan tuberías dentro de comillas invertidas, como `--status <active|dormant>`, y escapadas. El parser cuenta solo las tuberías reales.

---

## El suelo: `catalogo-minimos.json`

Que el bloque esté regenerado **no impide un retroceso**: quien borre un comando y regenere pasa el chequeo con un número más bajo y una portada impecable.

Por eso el suelo vive aparte, en [`docs/catalogo-minimos.json`](https://github.com/sedecim-com/Accounting/blob/main/docs/catalogo-minimos.json):

```json
{
  "invocables": 119,
  "fase1Invocables": 108
}
```

Dos números y nada más. La regla es idéntica a la de la lista `--exigir` de `plan:status`: **solo sube, y sube en el mismo commit que gana el terreno**. El archivo lleva su propia bitácora de por qué subió cada vez, en claves con guion bajo que el comparador ignora — el flujo F01 lo subió de 92 a 110 cuando diecisiete filas de `account`, `entry` y `ledger` ganaron comando; F02 lo subió a 119 cuando el espejo del CFDI ganó familia.

Bajarlo es legítimo, y ha pasado, pero es un acto que viaja en el diff con su razón. La corrección S0.7 lo bajó de 94 a 92 **sin ceder terreno**: el medidor contaba las dos filas-contrato como comandos invocables de fase 1. Cuando el instrumento se corrige, la cifra baja y el suelo baja con ella; el mensaje del commit lo dice.

---

## Las cinco compuertas de `--check`

El trabajo `plan` de la CI corre, además del estado del plan, esto:

```bash
npx tsx scripts/catalogo-estado.ts --check
```

Falla, en este orden:

1. **Filas sin fase legible.** Toda fila de comando declara fase 1, 2 o 3. El comando `pac create` vivió meses con la fase ilegible —una tubería sin escapar partía su celda de Backend y corría las columnas— y escapaba a **todo** conteo por fase sin que nada lo acusara. El mensaje de error nombra la causa habitual.
2. **Filas perdidas en el parseo.** Se cuentan las líneas de comando en crudo y se comparan con las parseadas. Filas con celdas de menos —el modo exacto en que S0.7 rompió 25 filas— dejan de ser invisibles.
3. **Retroceso contra el suelo.** Si los invocables o los de fase 1 caen por debajo de `catalogo-minimos.json`, rojo, con la instrucción de bajar el suelo en el mismo commit si el terreno se cedió a propósito.
4. **Comandos vivos sin fila.** Toda hoja que el binario ejecuta tiene que tener fila, salvo la plomería declarada en `FUERA_DEL_CATALOGO`. Reconciliar los nombres hizo saltar los invocables de 80 a 90 **sin escribir una línea de producto**: eran diez comandos ya entregados que el medidor no veía. Mientras exista ese desajuste, un sprint puede entregar ocho comandos y cerrar cero filas — le pasó a `report`, con 2 741 líneas invertidas.
5. **El bloque desfasado.** Si el bloque generado no coincide con lo que el código dice hoy, rojo, con el comando para regenerarlo.

Sobre la cuarta: `FUERA_DEL_CATALOGO` es una **ceguera deliberada**, y por eso se poda. S0.7 sacó de esa lista quince familias que ya estaban catalogadas por completo, más una que ni existía como familia; dejarlas dentro habría escondido cualquier hoja futura suya que naciera sin fila. `memory` se queda a medias, porque `memory teach` y `memory retire` siguen sin fila.

---

## Catálogo contra referencia: dos documentos, dos preguntas

Esto es la distinción que más confusión causa.

| | `docs/cli-command-catalog.md` | `src/ai/docs/cli-reference.md` |
|---|---|---|
| Responde | A qué se aspira | Qué existe hoy |
| Lo escribe | Personas, contra investigación y contra el backend | [`scripts/generate-cli-reference.ts`](https://github.com/sedecim-com/Accounting/blob/main/scripts/generate-cli-reference.ts), del objeto `program` |
| Lo lee | Quien planea el trabajo | **El agente**, en tiempo de ejecución |
| Contenido | Filas con motor, riesgo, permiso de IA y fase | La ayuda literal de cada comando, byte por byte |

La referencia se regenera con:

```bash
npx tsx scripts/generate-cli-reference.ts
```

Se genera recorriendo el objeto `program` y emitiendo el `helpInformation()` de cada comando —idéntico a lo que imprime `mnemosine <cmd> --help`— sin lanzar un proceso por comando y sin parsear texto de ayuda; los dos fueron modos de fallo del generador anterior.

Su cabecera le ordena al agente **«never invent a flag that is not listed here»**, y ese contrato la vuelve peligrosa cuando se desfasa. Se desfasó: llegó a tener 49 secciones contra 137 reales, y entre las 88 ausentes estaban **catorce familias contables enteras** — `entry`, `invoice`, `payment`, `receipt`, `report`, `account`, `period`, `year`, `vendor`, `bill`, `customer`, `entity`, `skills`, `webhooks`. Con ese contrato y ese contenido, el agente no podía guiar a nadie hacia `entry post`: para él no existía. Y ninguna prueba lo veía, porque la que parecía cubrirlo solo comprobaba que el archivo existiera y no fuera trivial — un alcance que excluye por construcción el defecto presente.

Hoy lo vigila [`tests/ai/cli-reference.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/ai/cli-reference.spec.ts), que compara el documento contra el `program` real y exige que **toda hoja del binario aparezca**.

---

## El artefacto navegable

Hay una tercera vista, en HTML, para recorrer las filas sin leer tres mil líneas de markdown:

```bash
npx tsx scripts/artefacto-catalogo.ts
```

Su historia es la advertencia de siempre. El artefacto anterior llevaba las filas **copiadas dentro de su HTML**: veinte citas a un archivo ya borrado, un conteo equivocado por uno, y ninguna noción de qué comandos se pueden teclear. Era el tercer espejo del repositorio mantenido a mano, después de la tabla del plan y de la portada del propio catálogo, y se rompió igual que los otros dos. Hoy la plantilla lleva el argumento y el diseño; los datos salen de la misma función que la CI verifica.

Para consumir los datos desde otra herramienta, el medidor emite JSON:

```bash
npx tsx scripts/catalogo-estado.ts --json
```

---

## Lo que el catálogo no prueba

**Que una cita resuelva no prueba que apunte a lo mismo.** El medidor comprueba que las **643** citas `archivo:línea` del documento apunten a un archivo que existe y a una línea dentro de su rango. Nada más. Un refactor que mueva código treinta líneas deja todas las citas resolviendo y todas apuntando a otra cosa. El propio bloque generado lo dice al pie, y está bien que lo diga.

**El juicio del motor es humano.** El símbolo de la columna Backend —completo, parcial o inexistente— lo pone una persona y se revisa a mano. El script no verifica ninguno. Lo único mecánico es si el binario responde a esa ruta.

**Invocable no es completo.** Que una fila cuente como invocable significa que el binario responde a su ruta de comando, no que el comando haga todo lo que la fila describe ni que respete sus banderas. El 7,3 % mide superficie, no funcionalidad.

**El descubrimiento que define el trabajo restante**, y que explica por qué tantas filas son parciales y no completas: la lógica de negocio vive **en línea dentro de los manejadores de Express**, sin capa de servicio. Implementar una familia significa extraer el servicio, refactorizar la ruta para que lo llame preservando su contrato HTTP, y recién entonces construir los comandos. Ver [[Arquitectura]].

**La sección de reportes no se normalizó.** `report.md` conserva las correcciones de su verificador pero no las del registro de nomenclatura. Es una sección grande y el documento lo declara abiertamente en su cierre.

---

## El registro, que manda sobre el catálogo

Una superficie de este tamaño escrita por muchas manos se vuelve inaprendible sin un diccionario vinculante. Ése es [`docs/cli-command-registry.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/cli-command-registry.md), y **supera en autoridad a las once secciones del catálogo**: donde una sección lo contradiga, la sección está equivocada.

Garantiza tres invariantes: la **forma** (`mnemosine <sustantivo> <verbo> [calificador] [args] [--flags]`, profundidad máxima 3, y el último token antes de los argumentos es siempre un verbo de la lista cerrada de 76); la **biyección** inglés–español, un verbo inglés con exactamente una palabra española y ninguna palabra española usada por dos verbos; y **un dueño por sustantivo**, definido en un solo archivo.

Lo que hace verificable todo eso es una prueba, no una convención: `auditProgram` recorre el árbol de comandos real y rechaza verbos fuera de la lista, sustantivos en plural, profundidad mayor a 3, el uso de `-f` —que jamás se asigna, porque se lee como `--file` y como `--force` a la vez— y listas sin `--limit` o `--format`. Ver [[Pruebas-y-CI]].

---

## Para seguir

- [[El-tablero-y-los-criterios]] — el otro marcador, y la disciplina de mutación que sostiene a los dos
- [[El-agente-y-sus-limites]] — la frontera que la columna IA codifica fila por fila
- [[Arquitectura]] — por qué la lógica vive dentro de los manejadores y qué implica
- [[Hoja-de-ruta]] — qué familias vienen y en qué orden
- [[Puesta-en-marcha]] — cómo tener el binario corriendo para probar cualquiera de estos comandos
