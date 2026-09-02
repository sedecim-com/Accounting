# Manual: el día a día

Esta página es el trabajo cotidiano sobre una empresa que ya está dada de alta. Si todavía no lo está, empieza por [[Manual-Primer-cliente]]. Si no has leído las convenciones —cómo se teclea, qué es una entidad, y por qué a las confirmaciones se contesta `y` y jamás `s`—, están en [[Manual-de-usuario]].

Recuerda la forma de invocación: donde dice `mnemosine algo`, tecleas `npm run mnemosine -- algo`. Los bloques ya vienen bien.

---

## Antes de nada: en qué empresa estás

Es el primer comando de cada sesión de trabajo. Cuesta dos segundos y evita el error más caro que se puede cometer en un despacho, que es capturar en los libros del cliente equivocado.

```bash
npm run mnemosine -- entity show
```

```bash
npm run mnemosine -- entity use ACO850101AB1
```

Y para ver qué tienes pendiente en esa empresa:

```bash
npm run mnemosine -- pending
```

**Aviso sobre el trabajo de despacho:** el panel de pendientes es **por entidad**. No hay ninguna vista que te diga de un vistazo, para tus cuarenta clientes, a cuáles les falta revisar borradores y a cuáles cerrar el mes. Si llevas varios, hoy la única forma es recorrerlos uno por uno.

---

## Tarea 1 · Recibir los CFDI del mes y contabilizarlos

### Paso 0: conseguir los XML (esto se hace fuera)

**No existe la descarga masiva de CFDI desde mnemosine.** La familia `sat` sólo tiene `cred`; su ayuda promete «and CFDI download» y esa parte no está construida. El paso es manual:

1. Entra al portal del SAT y descarga el ZIP de CFDI emitidos y recibidos del mes.
2. Descomprímelo en una carpeta, por ejemplo `./cfdis/2026-08/`.

Los XML tienen que quedar **sueltos**: `ingest` recibe rutas de archivos XML, no un ZIP ni una carpeta comprimida.

### Paso 1: la marcha seca

```bash
npm run mnemosine -- ingest ./cfdis/2026-08/*.xml --dry-run
```

**Qué vas a ver.** Cuántos archivos encontró, cuáles ya están en el espejo (duplicados) y cuáles son ilegibles. Y una nota honesta que conviene leer: el simulacro **sólo** corre la capa determinista. Las reglas del despacho, la clasificación de la IA y el plan de póliza se deciden en la corrida de verdad. Es un simulacro que declara su propio alcance, cosa poco común.

**Qué hacer si sale distinto.** Si te contesta `role "postgres" does not exist` cuando lo que está mal es la ruta de los archivos, no te confundas: la validación de los archivos ocurre **después** de conectar a la base, así que un error de tecleo en la ruta puede disfrazarse de error de infraestructura. Comprueba la ruta con `ls ./cfdis/2026-08/` y, si está bien, corre `doctor`.

### Paso 2: la ingesta de verdad

```bash
npm run mnemosine -- ingest ./cfdis/2026-08/*.xml
```

**Qué hace, en tres capas y por orden de confianza:**

1. **Reglas deterministas.** Deduplicación contra el espejo, identificación del proveedor y reglas de procesamiento. Si una regla cubre el documento, gana y no se gasta ni un token. *(Nota: hoy esas reglas sólo se administran por la API REST, no hay comandos para crearlas. Es una limitación conocida.)*
2. **Clasificación por IA.** Lo que las reglas no cubren se clasifica y se propone como **borrador**.
3. **Umbrales de auto-posteo.** Apagados por omisión. Todo se queda en borrador salvo que lo enciendas con `--auto-post`.

**No enciendas `--auto-post` hasta haber revisado a mano varios meses.** El sistema tiene forma de medir si el agente merece esa confianza (`mnemosine ai stats`), y el modo correcto es mirar esos números antes, no después.

**Qué vas a ver.** Una línea de progreso por archivo y, al final, un resumen:

```
Summary: 0 auto-posted, 12 by rules, 143 draft(s), 9 blocked, 4 duplicate(s), 2 with errors
```

**Qué hacer si sale distinto.**

- *«blocked»* significa que el agente levantó una pregunta y no puede seguir sin respuesta: ve a la tarea 2.
- *«with errors»* son XML que no se pudieron leer. Revísalos a mano.
- Con muchos archivos el progreso no dice en cuál va —sólo el nombre del archivo en curso—, así que no hay forma de estimar cuánto falta. Si lo interrumpes con Ctrl-C, lo ya procesado queda hecho y el resto intacto; se puede volver a correr sobre la misma carpeta, porque la detección de duplicados lo cubre.
- El costo de tokens de la corrida se calcula y se guarda, pero **no se imprime**. Para verlo: `npm run mnemosine -- usage`.

---

## Tarea 2 · Contestar las preguntas del agente

**Qué quieres lograr.** Desbloquear los documentos que el agente no supo clasificar, y de paso enseñarle el criterio del despacho: **una pregunta contestada queda como precedente** y entra en el contexto de todas las sesiones futuras. Es el mecanismo de aprendizaje del sistema, y es el que más rinde.

```bash
npm run mnemosine -- question list
```

Para contestar recorriendo la cola de forma interactiva:

```bash
npm run mnemosine -- question answer
```

O una en concreto, por su identificador:

```bash
npm run mnemosine -- question answer <id> "Los servicios de CFE van a 5140 Energía eléctrica"
```

Si la pregunta trae opciones numeradas, puedes contestar con el número.

**Qué hacer si sale distinto.** Si un mensaje del sistema te dice «Answer the questions with: `mnemosine questions`», ignora ese nombre: está deprecado y te va a regañar. Los comandos vigentes son `question list` y `question answer`.

Y si quieres sembrar un criterio sin esperar a que el agente pregunte:

```bash
npm run mnemosine -- memory teach "facturas de Telmex" "van a 6130 Servicios de comunicación"
```

```bash
npm run mnemosine -- memory
```

`memory` lista los precedentes vigentes, que puedes corregir (`memory correct`), retirar (`memory retire`) o reactivar (`memory restore`). Los precedentes son tuyos: el agente los usa, tú los controlas.

---

## Tarea 3 · Revisar los borradores

**Ésta es la sección más importante del manual.** Es el acto central del producto: la IA propuso, tú dispones. Todo lo demás del sistema está construido para proteger este momento, y el momento sólo vale lo que valga tu atención.

### Antes de abrir la cola

Mira cuántos son y de qué estado:

```bash
npm run mnemosine -- drafts -s pending_review
```

**Qué vas a ver.** Una línea por borrador: fecha, descripción, número de renglones, confianza de la IA, estado e identificador.

**Lo que no vas a ver, y hay que saberlo:** `drafts` no muestra el importe, no tiene `--limit`, no tiene filtros por monto ni por confianza, y no tiene salida en JSON. Si tienes 180 borradores no hay forma de ordenarlos por materialidad para revisar primero los grandes. Es la limitación más incómoda del flujo, y no hay rodeo desde la terminal.

Una preparación que sí ayuda mucho: **antes de entrar a la cola, abre una segunda terminal** con el espejo de CFDI. Dentro de la revisión no vas a poder consultar nada.

```bash
npm run mnemosine -- cfdi list --since 2026-08-01 --until 2026-08-31 --direction recibido
```

**`cfdi list --period` no filtra nada, así que aquí va con fechas.** El comando declara la bandera —se la da el juego de banderas de tiempo— pero su acción nunca la lee (`cfdi-command.ts:103-111`: la llamada a `listCfdis` recibe `since` y `until`, jamás `period`). Un CFDI de agosto sale igual con `--period 2026-01` y con `--period no-existe-este-periodo`, y sale con 0: no avisa de que no filtró. `--since`/`--until` sí funcionan.

Atención al idioma de esa bandera: en `cfdi list` los valores de `--direction` son **en español** (`emitido`, `recibido`, `ajeno`), mientras que en `rep missing list` la misma bandera se escribe **en inglés** (`received`, `issued`). No es un error tuyo; el producto es así hoy.

### La cola

```bash
npm run mnemosine -- review
```

**Qué vas a ver.** Un borrador a la vez, así:

```
─── Draft 1/143 ───
id: 8f3a...
date: 2026-08-14   AI confidence: 0.86
description: Servicios profesionales
reference: A-1042 · 3F2A9C7E-...
reasoning: El emisor es un despacho de ingeniería; el concepto describe...

  account     description                                     debit       credit
  6110        Honorarios                                     10000.00
  1190        IVA acreditable                                 1600.00
  2100        Proveedores                                                11600.00
                                                             11600.00    11600.00
```

Y debajo, el prompt:

```
[a]pprove and post  [r]eject  [s]kip  [q]uit >
```

### Qué hace cada tecla

| Tecla | Qué hace |
|---|---|
| `a` | **Crea la póliza y la contabiliza en el mismo acto.** Irreversible por la vía normal: sólo se corrige con `entry reverse` |
| `r` | Rechaza el borrador. Te pide un motivo, que queda escrito |
| `s` | Salta al siguiente y lo deja pendiente |
| `q` | Sale de la cola |
| **cualquier otra cosa** | **Salta el borrador, en silencio, sin avisar** |

Esa última fila es la trampa. Si escribes `aprobar`, o `sí`, o das Enter en vacío, el borrador **se salta** y el sistema no dice nada: pasa al siguiente como si nada. Si al final la línea de resumen dice `Done: 0 approved, 0 rejected` después de que creíste aprobar cincuenta, es esto lo que pasó.

Y nota la colisión de mnemónicos: `s` aquí significa *skip*, saltar. No significa «sí».

### Qué mirar antes de teclear `a`

1. **Las cuentas de los renglones.** Es lo que estás firmando.
2. **Que cuadre.** La última línea trae los totales de cargos y abonos.
3. **Las retenciones.** Si el proveedor retuvo ISR o IVA, el asiento debe traer esos renglones. Ésa es la revisión que más se le escapa a la IA, y el número de confianza no la cubre.
4. **El razonamiento.** Si el modelo dice que adivinó, lo dice ahí.
5. **La confianza, con reservas.** `AI confidence: 0.86` es autorreporte del modelo, no una probabilidad medida. No hay leyenda en pantalla que te diga qué significa 0.86 en tu despacho. Lo que sí lo dice es `mnemosine ai stats`, que calcula la aprobación real por bucket de confianza; vale la pena correrlo una vez al mes y calibrar tu propio umbral.

### Lo que la cola no te deja hacer

Dicho sin adornos, para que no lo descubras a la mitad:

- **No hay corregir-y-aprobar.** Si el asiento está casi bien, la única salida es rechazarlo y capturar la póliza a mano.
- **No hay deshacer.** Una `a` contabiliza. Se corrige con `entry reverse`, que deja los dos asientos visibles.
- **No hay aprobación por lote** ni filtros de entrada.
- **No guarda por dónde ibas.** Si sales con `q` en el borrador 90 de 143, la próxima vez la cola arranca desde el principio. Los ya resueltos no vuelven a salir, pero los saltados sí.
- **No puedes ver el CFDI desde dentro.** De ahí la segunda terminal.

Una cosa sí está resuelta y es la que más importa: **la aprobación está amarrada al contenido que viste**. Si el borrador cambia entre que se dibujó en pantalla y que aprietas `a`, la aprobación se cancela entera y nada queda escrito a medias.

### Cuando algo sale mal en la revisión

- *«The draft no longer passes validation (the chart of accounts may have changed)»*: alguien archivó o cambió una cuenta que el borrador usaba. El borrador se queda pendiente; recházalo si ya no aplica.
- *Un rechazo no enseña nada.* El motivo se guarda, pero **no** se convierte en precedente. Si rechazaste catorce veces al mismo proveedor por la misma razón, el mes que viene el agente va a proponer lo mismo. La forma de que aprenda es la tarea 2: contestar una pregunta o sembrar el criterio con `memory teach`.

### Después de la cola

```bash
npm run mnemosine -- cfdi explain 3F2A9C7E-1234-5678-9ABC-DEF012345678
```

Este comando es el mejor rastro de auditoría del sistema y no tiene equivalente en CONTPAQi ni en Aspel: explica **por qué** un CFDI se registró como se registró —el caso, los hechos y las decisiones que el clasificador dejó anotadas—. Es material de papel de trabajo para cuando alguien pregunte.

```bash
npm run mnemosine -- cfdi show 3F2A9C7E-1234-5678-9ABC-DEF012345678
```

Y para revalidar el estatus de los CFDI contra el SAT, empezando por los más viejos de consultar:

```bash
npm run mnemosine -- cfdi status sync --limit 200
```

---

## Tarea 4 · Capturar lo que no llegó por CFDI

Antes de los comandos, la advertencia que ahorra más tiempo de todo el manual.

### Los tres formatos de renglón

Los tres comandos de captura usan **tres sintaxis distintas** para escribir un renglón, y `tax` significa cosas distintas en dos de ellos. No es un error de este manual: es así.

| Comando | Separador | Forma de un renglón | Qué es `tax` |
|---|---|---|---|
| `entry create` | dos puntos | `1120:debit:11600.00:Cobro` | (no aplica) |
| `bill create` | **coma** | `account=5100,qty=1,price=1000,tax=160` | **el MONTO del IVA** |
| `invoice create` | **punto y coma** | `account=4100;qty=1;price=10000;tax=16` | **la TASA en por ciento** |

Si confundes los dos últimos, la factura de proveedor de 1,000 más IVA se registra con **16 pesos** de IVA acreditable en vez de 160, la factura cuadra a 1,016, el pago de 1,160 no casa, y el faltante no aparece hasta la declaración. La ayuda de `bill create` ni siquiera menciona la clave `tax`. Ténlo apuntado.

### Una factura de proveedor

```bash
npm run mnemosine -- bill create "Papelería del Centro" \
  --vendor-invoice-number A-1234 \
  --bill-date 2026-08-10 \
  --terms "Net 30 PPD" \
  --line "account=5100,qty=1,price=1000,tax=160,description=Papelería agosto"
```

Las claves aceptadas en `--line` son: `account`, `qty` (o `quantity`), `price` (o `unit-price`), `tax`, `description`, `cost-center` y `project`.

**Sobre `--terms` y el PPD/PUE.** Ese `PPD` dentro de las condiciones de pago no es decorativo: **es hoy la única forma de declarar el método de pago en una captura manual**. No existe una bandera `--metodo-pago`. El sistema busca las palabras `PUE` o `PPD` en `--terms` o en el memo; si no las encuentra, aplica el criterio conservador —para una factura recibida, PPD— y **lo escribe en la descripción del asiento** («MetodoPago missing: PPD assumed»), de modo que quede visible en el mayor de dónde salió el criterio. Está bien resuelto, pero depende de que tú escribas la palabra.

Si es PPD, el IVA acreditable se aparca en la cuenta de IVA pendiente de acreditar y se reclasifica cuando registres el pago. Si es PUE, se acredita al aprobar.

Revisa antes de aprobar, y recodifica si hace falta:

```bash
npm run mnemosine -- bill show F-0001 --no-lines
npm run mnemosine -- bill show F-0001
```

```bash
npm run mnemosine -- bill line set F-0001 --line 1 --account 5110
```

Y reconoce el pasivo en el mayor:

```bash
npm run mnemosine -- bill approve F-0001
```

**Qué vas a ver.** Una confirmación con el número de la factura, su importe y su moneda. Contesta `y`.

**Qué hacer si sale distinto.** Una factura ya aprobada **no se puede editar ni anular**: no existen `bill edit` ni `bill void`. Si la aprobaste con el importe mal, la única salida es reversar su asiento (`entry reverse`) y capturar otra factura. Quedan tres asientos y dos facturas para un solo documento; es feo, pero es el rastro correcto.

### Una factura de cliente

```bash
npm run mnemosine -- invoice create \
  --customer "Comercializadora del Norte" \
  --date 2026-08-31 \
  --terms "Net 30" \
  --line "account=4100;qty=1;price=10000;tax=16;description=Servicios agosto"
```

```bash
npm run mnemosine -- invoice show F-2026-0088
```

```bash
npm run mnemosine -- invoice issue F-2026-0088
```

**Qué hace `issue`.** Contabiliza: cargo a clientes, abono a ingresos y abono al IVA que corresponda según el método de pago (si es PPD, al IVA trasladado no cobrado; si es PUE, al trasladado). **No timbra y no manda nada.**

**El alias español de este comando es `emitir`, y eso es engañoso.** En México «emitir una factura» quiere decir timbrarla ante el PAC. `mnemosine factura emitir` no timbra. Si le dices al cliente que ya se le facturó porque este comando terminó bien, el cliente no va a poder deducir: el CFDI nunca se generó.

**Lo que hay que hacer fuera:** timbrar en el portal del PAC, con los mismos datos, y verificar que el folio, la fecha y el importe coincidan con lo que quedó en el mayor. No hay amarre automático entre el documento de mnemosine y el CFDI timbrado fuera.

Para anular una factura local:

```bash
npm run mnemosine -- invoice void F-2026-0088 --reason "error en el importe"
```

Se niega si ya está timbrada o pagada. Si el CFDI ya se timbró, el camino correcto es cancelarlo en el PAC y después reversar su asiento:

```bash
npm run mnemosine -- entry reverse JE-2026-00188 --reason "CFDI cancelado, acuse 0000123456"
```

### Una póliza manual

Para todo lo que no viene de un documento: comisiones bancarias, depreciación, ajustes, provisiones.

```bash
npm run mnemosine -- entry create \
  --date 2026-08-31 \
  --type adjusting \
  --description "Comisiones bancarias agosto" \
  --line "5910:debit:850.00:Comisión manejo de cuenta" \
  --line "1120:credit:850.00:Cargo BBVA 31/08"
```

Sepárador de dos puntos, lado en inglés (`debit`/`credit`), importe con punto decimal y sin comas de millares.

Los tipos disponibles en `--type` son `standard`, `adjusting` y `correction`. **No existe la clasificación mexicana de póliza** —ingresos, egresos, diario—: no hay campo donde guardarla, y no se puede reconstruir después. Si tu despacho la necesita para archivar, ponla en la descripción o en `--reference`.

Después, siempre los mismos tres pasos:

```bash
npm run mnemosine -- entry check --entry P-2026-0107 --strict
npm run mnemosine -- entry preview P-2026-0107
npm run mnemosine -- entry post P-2026-0107
```

**Ojo con `--dry-run` de `entry create`:** la ayuda dice que valida y muestra la póliza sin escribir, y es cierto, pero **no funciona sin base de datos**. No sirve para ensayar la sintaxis en frío.

---

## Tarea 5 · Registrar cobros y pagos

**Qué quieres lograr.** Registrar dinero que **ya se movió** —mnemosine no paga ni cobra, no habla con ningún banco— y, con eso, reclasificar el IVA que estaba aparcado por ser PPD.

### Un pago a proveedor

```bash
npm run mnemosine -- payment create F-0001 \
  --amount 1160.00 \
  --date 2026-09-09 \
  --method spei \
  --memo "transferencia BBVA ref 88213"
```

Los métodos son `cash`, `check`, `ach`, `wire`, `spei`, `credit_card` y `other`.

**Sobre `--bank`:** pide el identificador de una cuenta bancaria dada de alta, y **no hay comando para dar de alta cuentas bancarias**. En la práctica, omítela: sin ella el sistema usa la cuenta del rol `banco` de la entidad, que fijaste en el alta.

### Un cobro de cliente

```bash
npm run mnemosine -- receipt record F-2026-0088 \
  --amount 11600.00 \
  --date 2026-09-15 \
  --method spei \
  --reference "SPEI 0123456789"
```

Registra el cobro y reconoce el IVA trasladado que estaba en la cuenta de no cobrado.

**Lo que falta hacer fuera:** si la factura era PPD, **hay que emitir el REP** (complemento de pago) en el portal del PAC. Es una obligación fiscal con su propio plazo, y mnemosine no lo emite.

### Los REP

```bash
npm run mnemosine -- rep missing list --direction received
```
Pagos PPD a proveedores cuyo REP no ha llegado. El IVA de esos pagos sigue aparcado sin acreditar.

```bash
npm run mnemosine -- rep missing list --direction issued
```
Cobros nuestros sin REP emitido. Ésta es tu lista de pendientes con el PAC.

```bash
npm run mnemosine -- rep reconcile
```
Reintenta los REP que llegaron y se quedaron apartados para revisión. Es seguro repetirlo: lo ya resuelto se salta.

Acuérdate del cambio de idioma: aquí `--direction` es `received`/`issued`, y en `cfdi list` es `recibido`/`emitido`.

---

## Tarea 6 · Consultar cómo va el mes

### La balanza

```bash
npm run mnemosine -- report trial-balance show --period 2026-08
```

Con menos detalle y sin cuentas en ceros:

```bash
npm run mnemosine -- report trial-balance show --period 2026-08 --level 4 --exclude-zero
```

`--period` acepta varias formas: `2026-08`, `2026-Q3`, `FY2026`, `2026`, y rangos como `2026-01..2026-06`. **No** acepta `last-month`, aunque la ayuda de la bandera lo anuncie: no hay código que resuelva expresiones relativas y la corrida sale con 4 (ver [[Manual-Reportes-y-entregables]]).

**Qué vas a ver, y cómo leerlo.** Las columnas salen con nombres técnicos en inglés (`account_code`, `account_name`, `debit_total`, `credit_total`, `ending_balance`) sobre nombres de cuenta en español, y los importes salen **sin separador de miles y con cuatro decimales**: `12458930.5500`, no `12,458,930.55`. Hay que contar dígitos con el dedo. Está reconocido como una brecha; hoy es así, y es una razón más para exportar a CSV cuando el reporte es para alguien más.

Una cosa que sí está bien y conviene saber: **los totales del pie se calculan sobre todo, no sobre la página que ves**. Un `--limit` cambia lo que aparece, nunca lo que la balanza dice. Y si la lista se truncó, te lo avisa con los tres remedios: subir `--limit`, paginar con `--offset`, o pedir `--all`.

### Los otros cinco reportes

```bash
npm run mnemosine -- report balance-sheet show --as-of 2026-08-31
npm run mnemosine -- report income-statement show --period 2026-08
npm run mnemosine -- report general-ledger show --account 1120 --period 2026-08
npm run mnemosine -- report aged-receivable show --as-of 2026-08-31
npm run mnemosine -- report aged-payable show --as-of 2026-08-31
```

**Lo que no hay:** estado de flujos de efectivo (NIF B-2), estado de variaciones en el capital contable (NIF B-4), ni columna comparativa contra el mes o el ejercicio anterior. Cada reporte es de un corte; si quieres agosto contra julio, corres dos veces y comparas fuera.

### El auxiliar de una cuenta

Saldo inicial, cada movimiento y saldo final. Es la forma que pide el SAT:

```bash
npm run mnemosine -- ledger auxiliary show --account 1120 --period August
```

**El periodo va por nombre, no por fecha.** Aquí `--period 2026-08` no sirve —sale con 3 y `Fiscal period with id 2026-08 not found`—, aunque en los reportes de arriba sí sirva. Es una de las dos banderas `--period` que buscan por fragmento del nombre; la tabla de las tres familias está en [[Manual-El-cierre-de-mes]].

**Cuidado con el volumen:** este comando **no tiene límite por omisión**. Sobre la chequera de un cliente con cuatro mil movimientos vuelca cuatro mil renglones a la terminal. Ponle `-n`:

```bash
npm run mnemosine -- ledger auxiliary show --account 1120 --period August -n 100
```

### El saldo de una cuenta por periodo

```bash
npm run mnemosine -- account balance show 1120
```

### Las pólizas del mes

```bash
npm run mnemosine -- entry list --period 2026-08
npm run mnemosine -- entry list --account 5100 --period 2026-08
npm run mnemosine -- entry list --min-amount 100000 --period 2026-08
npm run mnemosine -- entry list "renta" --period 2026-08
```

### Lo que está atorado

```bash
npm run mnemosine -- ledger stale-draft list --days 7 --period 2026-08
```

Pólizas en borrador que llevan demasiado tiempo sin contabilizar. Es el bloqueador número uno de cualquier cierre.

**Un aviso de precisión:** este comando tiene un tope interno de 500 renglones y **no avisa cuando corta**. Si ves exactamente 500 y sospechas que hay más, resuélvelos y vuelve a correrlo.

### Exportar para el cliente

```bash
npm run mnemosine -- report trial-balance show --period 2026-08 --format csv -o balanza-2026-08.csv
npm run mnemosine -- report income-statement show --period 2026-08 --format csv -o resultados-2026-08.csv
npm run mnemosine -- entry export --period 2026-08 --format csv -o polizas-2026-08.csv
```

Los formatos son `table`, `json`, `ndjson`, `csv`, `tsv` y `md`. `entry export` saca las pólizas **con sus renglones** y sin tope de página, que es lo que quiere un auditor.

En CSV los importes salen sin separador de miles y con punto decimal, que es lo correcto para importar a Excel. Los encabezados siguen en inglés: cámbialos en la hoja antes de entregar.

**No hay PDF, no hay XLSX, y no hay un comando que arme el paquete completo.** Son seis comandos y seis archivos.

### Qué le falta al mes para cerrar

```bash
npm run mnemosine -- close --period August --check
```

**Fíjate en el `August`, no es un descuido.** `close --period` es una de las dos banderas de periodo que buscan por fragmento del nombre guardado —y los nombres se acuñan en inglés—, así que `--period 2026-08` no encuentra nada y el comando te enumera los disponibles. Las tres familias de `--period`, con lo que acepta cada una, están en [[Manual-El-cierre-de-mes]].

Sólo revisa; nunca cierra. Evalúa siete partidas: pólizas en borrador o pendientes de aprobación (bloquea), conciliaciones bancarias (avisa), facturas de cliente en borrador (avisa), depreciación del periodo (avisa), balanza cuadrada (bloquea), REP apartados para revisión (avisa), y pagos y cobros sin REP (bloquea o avisa según lo que hayas definido en el panel).

**Dos partidas dan verde por vacío y hay que verificarlas fuera del sistema:**

- **Conciliaciones bancarias.** Como no se pueden dar de alta cuentas bancarias, el conteo de cuentas sin conciliar da cero y la partida sale cumplida. No significa que esté conciliado.
- **Depreciación.** No hay alta de activos fijos, así que la partida tampoco comprueba nada real.

Y antes de cerrar, dos comprobaciones que sí valen:

```bash
npm run mnemosine -- ledger check --period 2026-08
npm run mnemosine -- report view show
```

La primera corre las verificaciones de integridad del mayor. La segunda dice si las vistas de reportes siguen de acuerdo con el mayor; si no, se reconstruyen con `report view sync`.

**Si vas a cerrar**, hazlo con la vista previa primero y con un motivo escrito:

```bash
npm run mnemosine -- close --period August --dry-run
npm run mnemosine -- close --period August --reason "cierre mensual agosto"
```

**Y aquí, más que en ningún otro sitio, cuida la respuesta.** La compuerta de `close` es laxa: cualquier respuesta que empiece con `s` —incluida `salir`— se toma como **sí**. Para cancelar escribe `n`. Y recuerda que **no hay comando para reabrir un periodo cerrado**.

El cierre normal es reversible por diseño (`soft close`); el `--hard` es irreversible y sólo se hace al final del ejercicio.

---

## Tarea 7 · Corregir un error

La regla del sistema, que es la regla del oficio: **una póliza contabilizada no se edita ni se borra.** Se corrige con su espejo, y los dos quedan visibles (NIF B-1).

| Qué pasó | Qué hacer |
|---|---|
| Póliza **en borrador** con un renglón mal | `entry edit`, o anúlala con `entry void <folio> --reason "..."` |
| Póliza **contabilizada** mal | `entry reverse <folio> --reason "..."` y captura la correcta |
| Factura de cliente local, sin timbrar ni cobrar | `invoice void <folio> --reason "..."` |
| Factura de cliente **ya timbrada** | Cancelar en el PAC, después `entry reverse` con el acuse en el motivo |
| Factura de proveedor **ya aprobada** | No hay `bill void`: `entry reverse` de su asiento y captura otra factura |
| Renglón mal codificado en una factura **no aprobada** | `bill line set <factura> --line <n> --account <cuenta>` |

```bash
npm run mnemosine -- entry reverse P-2026-0107 --reason "la comisión correspondía a la cuenta 5920"
```

`--reason` es obligatorio en todas las correcciones y queda en la bitácora de auditoría. Escríbelo pensando en quien lo va a leer dentro de dos años, no en salir del paso.

Un detalle que el sistema resuelve bien: si intentas reversar una póliza que ya tiene reversa, se niega y te explica por qué —«a second mirror would double the correction»—. No te está estorbando: te está evitando duplicar la corrección.

---

## Tarea 8 · Cuánto está costando el agente

```bash
npm run mnemosine -- usage
```

**Qué vas a ver.** El consumo de tokens y el costo estimado por modelo, con dos honestidades bien puestas: dice explícitamente que son **estimaciones locales, no facturación**, y arrastra la fecha de la tabla de precios que usó. Los modelos cuyo precio no conoce salen marcados como `unpriced` en vez de descartarse en silencio.

Los importes están en dólares y con cuatro decimales. El presupuesto máximo, si lo hay, vive en el archivo de configuración y no tiene comando: `usage` te dice lo gastado, no cuánto te falta para el tope.

---

## El ritmo del mes

Puesto junto, así se ve un mes de trabajo sobre un cliente:

**Cuando llegan los CFDI (una o dos veces al mes)**

```bash
npm run mnemosine -- entity use ACO850101AB1
npm run mnemosine -- ingest ./cfdis/2026-08/*.xml --dry-run
npm run mnemosine -- ingest ./cfdis/2026-08/*.xml
npm run mnemosine -- question answer
npm run mnemosine -- review
```

**Conforme pasan las cosas**

```bash
npm run mnemosine -- bill create ...      # lo que no llegó por CFDI
npm run mnemosine -- bill approve ...
npm run mnemosine -- payment create ...   # dinero que ya salió
npm run mnemosine -- receipt record ...   # dinero que ya entró
npm run mnemosine -- entry create ...     # comisiones, ajustes, depreciación
npm run mnemosine -- entry post ...
```

**Antes de cerrar**

```bash
npm run mnemosine -- ledger stale-draft list --days 7 --period 2026-08
npm run mnemosine -- rep missing list --direction received
npm run mnemosine -- rep reconcile
npm run mnemosine -- ledger check --period 2026-08
npm run mnemosine -- close --period August --check
```

**Para entregar**

```bash
npm run mnemosine -- report trial-balance show --period 2026-08 --format csv -o balanza.csv
npm run mnemosine -- report balance-sheet show --as-of 2026-08-31 --format csv -o balance.csv
npm run mnemosine -- report income-statement show --period 2026-08 --format csv -o resultados.csv
```

Y lo que sigue haciéndose fuera de mnemosine, sin excepción: bajar los CFDI del portal del SAT, timbrar, cancelar, emitir los REP, conciliar el banco y generar la contabilidad electrónica y la DIOT.

---

Si un comando falla y el mensaje no se entiende, la respuesta casi siempre es la misma línea:

```bash
npm run mnemosine -- doctor
```

Y si el mensaje menciona `role`, `connection` o `postgres`, es la base de datos, aunque el texto te hable de la entidad activa. Los fallos frecuentes y su remedio están en [[Solucion-de-problemas]].
