# Cobrar y pagar

Esta página cubre los dos ciclos que llenan el día de un despacho: lo que se le factura y se le cobra a un cliente, y lo que se le captura, aprueba y paga a un proveedor. En medio de los dos está el REP, que en México no es papeleo: es la pieza que decide en qué mes se acredita el IVA.

Cada paso trae el comando exacto, verificado contra su propia ayuda. Los pasos que **hoy no se pueden dar desde aquí** van marcados con ❌ y traen el sustituto.

El binario no se instala como comando global. Todo lo que aquí aparece como `mnemosine <algo>` se teclea así:

```bash
npm run mnemosine -- <comando>
```

El `--` es obligatorio: sin él, npm se queda las banderas. Ver [[Puesta-en-marcha]].

---

## Tres cosas antes de la primera factura

**1. Fija la entidad.** Casi todo lo que sigue opera sobre la entidad activa. Si el despacho lleva varios clientes, los comandos que escriben se niegan a adivinar.

```bash
mnemosine entity use ACO850101AB1
```

```bash
mnemosine entity show
```

`entity show` dice además **por qué** está seleccionada esa entidad: si la nombraste en la línea de comandos, si viene de `MNEMOSINE_ENTITY`, si la fijaste con `entity use`, o si es la única activa. Es la comprobación de treinta segundos que evita capturar el mes de un cliente en los libros de otro.

**2. Que exista un periodo abierto.** Ningún asiento se contabiliza sin él, y el error que da cuando falta no te dice qué hacer: `No open fiscal period found for the entry date` ([`posting.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/posting.ts), líneas 101-105). El remedio:

```bash
mnemosine year create 2026
```

```bash
mnemosine period list
```

`year create` crea el ejercicio y sus doce periodos. El mes en curso y los ya vencidos nacen `open`; los futuros nacen `future` y se abren a propósito con `mnemosine period open 2026-09`.

Un detalle que ahorra un rato de desconcierto: los periodos se **acuñan con nombre en inglés** —`August 2026`, no `agosto 2026`— porque el nombre se guarda, no se traduce al mostrarlo ([`fiscal-calendar-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/fiscal-calendar-service.ts), línea 505). `period show 2026-08` sí acepta la forma `YYYY-MM`; `close --period` no (ver [[Manual-El-cierre-de-mes]]).

**3. Que los roles semánticos apunten a alguna cuenta.** El posteo automático no conoce códigos de cuenta: conoce *roles* (`cxc`, `cxp`, `banco`, `ingreso`, `gasto`, `iva_acreditable`, `iva_pendiente_acreditar`, `iva_trasladado`, `iva_trasladado_no_cobrado`). Esa indirección es la que permite que el mismo motor sirva para el catálogo del despacho y para el catálogo propio de un cliente importado.

```bash
mnemosine account role list
```

```bash
mnemosine account role seed
```

`seed` crea las cuentas base que falten y mapea los roles sin mapear; nunca pisa una decisión manual. Si un rol se queda sin cuenta, el primer posteo que lo necesite falla con `MISSING_ROLE_ACCOUNT` y el nombre del rol que falta. Para repuntar uno a mano:

```bash
mnemosine account role set banco 1111
```

---

## Aviso de sintaxis: `--line` no se escribe igual en los tres lugares

Esto es la fuente de error más cara de toda la página, así que va antes que nada. Los tres comandos que reciben renglones usan **tres separadores distintos**, y `tax` significa **dos cosas opuestas**:

| Comando | Separador | `tax` es |
|---|---|---|
| `invoice create` | punto y coma `;` | una **tasa** en por ciento (`tax=16` → 16 %) |
| `bill create` | coma `,` | un **monto** en pesos (`tax=160` → $160.00) |
| `entry create` | dos puntos `:` | no existe: el IVA es un renglón más |

No es un capricho de esta guía: en la factura de cliente el importe se calcula como `renglón × tasa / 100` ([`invoice-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/ar/invoice-service.ts), líneas 316-317), y en la factura de proveedor el valor entra tal cual a `tax_amount` ([`bill-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/bill-command.ts), línea 414). La ayuda de `bill create` ni siquiera menciona `tax` entre sus claves, aunque la acepta.

Escribir `tax=16` en una factura de proveedor de $1,000 registra **16 pesos** de IVA acreditable en vez de 160. La factura cuadra a 1,016, el pago de 1,160 no casa, y el faltante aparece hasta la declaración. Cuando dudes, corre el comando con `--dry-run` y lee el total antes de aprobar.

---

## El ciclo del cliente

### 1. Dar de alta al cliente

```bash
mnemosine customer create \
  --name "Comercializadora del Norte SA de CV" \
  --tax-id CNO120315QX8 --tax-id-type rfc \
  --terms "Net 30" --currency MXN
```

El cliente se da de alta con `--name`; el proveedor, más abajo, con un argumento posicional. Es una asimetría real del binario, no una errata de esta página.

`--tax-id-type` se infiere del país de la entidad, así que en una entidad mexicana puedes omitirlo. El RFC sí se valida con un patrón que acepta `Ñ` y `&`, los dos caracteres legales que rompen las validaciones ingenuas.

Para ver la cartera:

```bash
mnemosine customer list --overdue
```

```bash
mnemosine customer show "Comercializadora del Norte"
```

### 2. Capturar la factura

```bash
mnemosine invoice create \
  --customer "Comercializadora del Norte" \
  --date 2026-08-31 --terms "Net 30" \
  --line "account=4100;qty=1;price=10000;tax=16;description=Servicios de agosto"
```

Punto y coma entre las claves. `tax=16` es la tasa. Si omites `--due-date`, se deriva de los términos del cliente; si los términos no son de una forma que el sistema sepa leer, exige la fecha explícita en vez de inventarla.

Lo que sale es un **borrador local**: no toca el mayor y no es un CFDI. El folio se toma del contador de la entidad; los contadores vigentes se ven con:

```bash
mnemosine invoice series list
```

Si apuntas un renglón a una cuenta que no es de ingreso, el comando lo captura igual pero te avisa por pantalla con el tipo real de la cuenta. Es un aviso, no un bloqueo.

### 3. Revisarla antes de contabilizar

```bash
mnemosine invoice show F-2026-0088
```

### 4. Contabilizarla

```bash
mnemosine invoice issue F-2026-0088
```

Esto sí toca el mayor: cargo a cuentas por cobrar, abono a ingresos por renglón, y abono al rol de IVA que corresponda. La factura pasa a estado `sent`, que es el estado desde el que se puede cobrar.

**Aquí es donde el IVA mexicano decide.** El rol de IVA no es siempre el mismo:

- **PUE** (pago en una sola exhibición): el IVA se causa al emitir → rol `iva_trasladado`, la 2120 del catálogo sembrado.
- **PPD** (pago en parcialidades o diferido): al emitir **no** se causa → rol `iva_trasladado_no_cobrado`, la 2125, y se mueve a la 2120 cuando entra el dinero.

¿De dónde sale el PUE/PPD de una factura capturada a mano? De la primera de estas fuentes que exista ([`iva-cash-basis.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/iva-cash-basis.ts), líneas 131-146):

1. Un `MetodoPago` en el propio documento — la columna todavía no existe.
2. El `MetodoPago` del CFDI timbrado detrás, cuando lo hay.
3. **El literal `PUE` o `PPD` escrito dentro de `--terms` o `--memo`.**
4. Si nada dijo: el valor conservador, que del lado emitido es **PUE**.

No hay bandera `--metodo-pago`. En una captura manual, la fuente 3 es la única que tienes:

```bash
mnemosine invoice create --customer "..." --terms "Net 30 PPD" --line "..."
```

El token tiene que ir suelto: `PPD-2026-04` no cuenta como PPD, y `Entrega en Cholula, Pue.` no cuenta como PUE. Si el texto nombra los dos, no cuenta ninguno y gana el valor conservador. Cuando el valor se supuso, el asiento lo dice en su propia descripción: `· MetodoPago missing: PUE assumed`. Búscalo en `entry show` cuando algo no cuadre.

### 5. ❌ Timbrar el CFDI

**No se puede desde aquí.** La familia lo declara en su propia ayuda: *«Customer invoices: draft, inspect, issue to the ledger and void (never stamped here)»*, y `invoice issue` remata: *«Does not stamp or send»*.

Cuidado con el alias en español: el comando completo es `mnemosine factura emitir`, y en México «emitir una factura» es exactamente el acto de timbrarla ante el PAC. Este comando **no timbra**. Contabiliza.

**Sustituto:** timbra en el portal de tu PAC con los mismos datos —mismo folio, misma fecha, mismo importe— y guarda el UUID. Si el folio o el importe difieren de lo que quedó en el mayor, la conciliación del mes siguiente no va a cerrar.

### 6. Registrar el cobro

```bash
mnemosine receipt record F-2026-0088 \
  --amount 11600 --date 2026-09-15 --method spei \
  --reference "SPEI 4471129"
```

Esto registra que el dinero **ya entró**: mnemosine no cobra, no habla con ningún banco. Los métodos válidos son `cash`, `check`, `ach`, `wire`, `spei`, `credit_card` y `other`; el valor por omisión es `spei`.

El cobro hace dos cosas a la vez, en la misma póliza:

1. Carga bancos y abona cuentas por cobrar, y baja el saldo de la factura.
2. **Traspasa el IVA** de la 2125 a la 2120, en proporción a lo cobrado.

El prorrateo se calcula como la diferencia entre dos acumulados, no importe por importe, para que los abonos parciales no se desvíen por redondeo y el último libere exactamente el remanente: cuando el documento queda saldado, la razón es exactamente 1 y no queda un centavo varado en la 2125.

Una factura se puede cobrar mientras esté en `sent`, `viewed`, `partially_paid` u `overdue`. Un borrador no: primero hay que contabilizarlo.

Sobre `--bank`: pide el **id de una cuenta bancaria**, y hoy no hay comando que dé de alta una. Sin la bandera se usa el rol `banco` de la entidad, que sí funciona. Ver [[Manual-Bancos-y-conciliacion]].

### 7. ❌ Emitir el REP

**No se puede desde aquí.** El complemento de pago de una factura PPD cobrada es una **obligación fiscal propia, con plazo**. La familia `rep` lo dice: emitir y corregir REP dependen del PAC y siguen fuera.

**Sustituto:** emítelo en el portal del PAC. Y lleva la cuenta de los que faltan:

```bash
mnemosine rep missing list --direction issued
```

Ojo con el idioma de esta bandera: aquí los valores son ingleses (`issued`, `received`), mientras que en `cfdi list --direction` son españoles (`emitido`, `recibido`, `ajeno`). Son dos banderas distintas con el mismo nombre.

---

## La nota de crédito

No hay comando de nota de crédito. Conviene decir con precisión hasta dónde llega el sistema, porque el hueco tiene dos mitades.

**En la ingesta.** Un CFDI tipo `E` se guarda en el espejo como `cfdi_egreso` y se pre-registra como `credit_note`, pero cuando toca contabilizarlo el motor se detiene con `UNSUPPORTED_TYPE`: sólo sabe procesar los tipos `bill` y `payment` ([`pre-registration-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/pre-registration-service.ts), líneas 487-495). El comprobante queda registrado y sin asiento.

Para encontrarlos:

```bash
mnemosine cfdi list --type cfdi_egreso --period 2026-08
```

**En la captura.** Hay dos caminos, y cuál te toca depende de si la factura original ya se timbró o ya se cobró.

### Camino A — la factura no se timbró ni tiene dinero aplicado

```bash
mnemosine invoice void F-2026-0088 --reason "Cancelada a solicitud del cliente"
```

`invoice void` anula el documento local y **reversa su asiento**. Se niega en dos casos, y el mensaje es explícito:

- Si trae CFDI: *«Voiding it here would not cancel it before the SAT; cancel the CFDI with its SAT reason code first.»*
- Si tiene cobros aplicados: *«Unapply the payment before voiding.»*

### Camino B — la factura ya se timbró, o ya tiene cobros

❌ **La cancelación ante el SAT no existe aquí.** Cancela en el portal del PAC o del SAT, guarda el acuse, y después corrige el mayor por reversa, que es lo que pide NIF B-1:

```bash
mnemosine entry reverse JE-2026-0341 --reason "CFDI cancelado ante el SAT, acuse 8f3a..."
```

Si lo que hay es una nota de crédito parcial —una devolución, un descuento posterior— no hay nada que reversar entero, y la ruta es una póliza manual:

```bash
mnemosine entry create \
  --date 2026-09-05 --type correction \
  --description "Nota de crédito NC-0012 s/factura F-2026-0088" \
  --reference "NC-0012" \
  --line "4100:debit:2000.00:Devolución de servicios" \
  --line "2120:debit:320.00:IVA trasladado de la devolución" \
  --line "1120:credit:2320.00:Comercializadora del Norte"
```

Dos puntos como separador aquí, y el orden es `<cuenta>:<debit|credit>:<importe>[:descripción]`.

**Cuidado con la cuenta de IVA.** Si la factura original era PPD y todavía no se cobraba, su IVA no está en la 2120 sino aparcado en la 2125. Compruébalo antes de escribir el renglón:

```bash
mnemosine ledger balance show --account 2125 --as-of 2026-09-05
```

Y valida antes de contabilizar. La póliza nace siempre como borrador:

```bash
mnemosine entry check --entry JE-2026-0402 --strict
```

```bash
mnemosine entry preview JE-2026-0402
```

```bash
mnemosine entry post JE-2026-0402
```

**Una limitación que hay que conocer.** Una póliza manual corrige el **mayor**, no el auxiliar de clientes. `report aged-receivable` lee `invoices.amount_due` directamente, así que la factura seguirá apareciendo con su saldo original en la antigüedad de saldos aunque la contabilidad ya esté corregida. Mientras no exista el comando de nota de crédito, la antigüedad de saldos y el mayor van a discrepar en esos casos, y hay que documentarlo en el papel de trabajo del mes.

---

## El ciclo del proveedor

### 1. Dar de alta al proveedor

```bash
mnemosine vendor create "Papelería del Centro SA de CV" \
  --tax-id PCE010101AB1 --terms "Net 30" \
  --currency MXN --default-account 5100
```

Aquí el nombre va como argumento posicional, no como `--name`.

Y hay una bandera que vale su peso en el mes de la DIOT:

```bash
mnemosine vendor list --no-tax-id
```

Saca los proveedores sin RFC en el expediente, que son exactamente los que van a bloquear la declaración informativa.

### 2. Capturar la factura del proveedor

```bash
mnemosine bill create "Papelería del Centro" \
  --vendor-invoice-number A-1234 \
  --bill-date 2026-08-10 \
  --terms "Net 30 PPD" \
  --line "account=5100,qty=1,price=1000,tax=160,description=Papelería de agosto"
```

Coma como separador, y `tax=160` es el **monto** del IVA, no la tasa. Las claves que acepta el renglón son `account`, `qty`, `quantity`, `price`, `unit-price`, `tax`, `description`, `cost-center` y `project`; cualquier otra la rechaza nombrando la lista completa.

El `PPD` dentro de `--terms` es, otra vez, la única forma de declarar el método de pago en una captura manual. Aquí importa más que del lado del cliente, porque el valor conservador del lado **recibido** es **PPD**: si la factura era PUE y no lo dijiste, su IVA se aparca en la 1135 y no se acredita ese mes. Se corrige solo cuando registres el pago, pero un mes tarde.

### 3. Recodificar antes de aprobar

```bash
mnemosine bill line set A-1234 --line 1 --account 5110
```

Sólo funciona mientras la factura no esté aprobada. Después, no hay `bill edit` ni `bill void`: la única corrección es reversar el asiento.

### 4. Aprobar: reconocer el pasivo

```bash
mnemosine bill show A-1234 --no-lines
```

```bash
mnemosine bill approve A-1234 --dry-run
```

```bash
mnemosine bill approve A-1234
```

Aprobar es lo que lleva el gasto al mayor: cargo al gasto, cargo al rol de IVA que toque, abono a proveedores. **PPD** manda el IVA al rol `iva_pendiente_acreditar` (la 1135); **PUE**, a `iva_acreditable` (la 1130).

Corre siempre el `--dry-run` primero. Es la última oportunidad de ver el total antes de que el pasivo quede en los libros, y es donde se descubre un `tax=16` que debía ser `tax=160`.

### 5. Pagar

```bash
mnemosine payment create A-1234 \
  --amount 1160 --date 2026-09-09 --method spei
```

Registra que el dinero **ya salió**. Igual que del lado del cobro, hace dos cosas en la misma póliza: mueve el efectivo y **traspasa el IVA** de la 1135 a la 1130 en proporción a lo pagado.

Una factura sólo se paga si su pasivo está en el mayor. Si intentas pagar un borrador, el mensaje lo dice completo: *«A-1234 está en "draft" y sólo se puede pagar un gasto approved, posted, partially_paid: su pasivo tiene que estar en el mayor primero.»*

**Un pago por factura.** El comando aplica el importe a **un solo documento**. Una transferencia que liquida tres facturas se captura como tres `payment create`, y produce tres números de pago. Tenlo presente al conciliar: en el estado de cuenta hay un movimiento y en el sistema hay tres.

**Si el comando se corta a media escritura, no lo repitas a ciegas.** Comprueba primero:

```bash
mnemosine bill show A-1234 --no-lines
```

Si el saldo ya bajó, el pago se registró y repetirlo lo duplicaría. La bandera `--idempotency-key` existe para esto, pero sólo protege si la usaste desde el principio.

### 6. El REP del proveedor

Si la factura era PPD, su IVA sigue aparcado en la 1135 hasta que llegue el REP del proveedor. Cuando llegue, entra por la ingesta como cualquier otro CFDI:

```bash
mnemosine ingest ./cfdis/rep-septiembre/*.xml
```

Y para saber qué falta:

```bash
mnemosine rep missing list --direction received --min-amount 5000
```

---

## El REP: cuándo hace falta y qué pasa si no llega

La regla en una línea: **el REP sólo hace falta cuando el comprobante es PPD**, y hace falta en los dos sentidos.

| | Quién lo emite | Qué desbloquea | Qué pasa si no llega |
|---|---|---|---|
| **Recibido** | El proveedor | Que su IVA pase de la 1135 a la 1130 | El IVA acreditable de ese mes se queda corto |
| **Emitido** | Tú | Cumplir una obligación propia con plazo del SAT | Incumplimiento tuyo, con multa |

Un REP **nunca escribe su propio asiento**, y esa decisión está tomada a propósito ([`rep-linkage.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/rep-linkage.ts), líneas 11-34). Si lo hiciera y el pago también se capturó por la puerta de pagos, el banco quedaría abonado dos veces y el IVA se traspasaría dos veces; y lo segundo es peor porque el tope de lo aparcado absorbe el exceso sin avisar, así que la póliza cuadra y la declaración sale mal. Lo que hace el REP al llegar es **ligarse** al pago que documenta, y si ese pago no existe, crearlo por la puerta de pagos, que ya libera el IVA por su cuenta.

El resultado de esa ligadura es uno de cuatro: `ya_ligado`, `casado`, `creado` o `revision`. Los que caen en `revision` quedan aparcados, esperando una decisión humana, y se reintentan cuando cambia lo que les faltaba:

```bash
mnemosine rep reconcile --dry-run
```

```bash
mnemosine rep reconcile
```

Es seguro repetirlo: los que ya se resolvieron se saltan.

Cinco criterios del despacho gobiernan ese casado, y viven en el panel de decisiones. Se ven con `mnemosine pending -v` y se fijan con `pending define`:

| Clave | Qué decide | Valor por omisión |
|---|---|---|
| `rep_pago_no_registrado` | Si el REP crea el pago o lo deja para revisión | `crear_pago` |
| `rep_tolerancia_importe` | Cuánta diferencia sigue siendo redondeo | `0.01` |
| `rep_ventana_dias` | Cuántos días de separación siguen siendo el mismo evento | `3` |
| `rep_documento_desconocido` | Qué hacer con el IVA de una factura que no tenemos | `esperar` |
| `rep_moneda_extranjera` | Qué hacer con la diferencia cambiaria | `no_casar` |

```bash
mnemosine pending define rep_ventana_dias 15 -n "Capturamos por lote mensual"
```

Otras dos claves —`rep_faltante_recibido` y `rep_faltante_emitido`— deciden si un REP faltante **bloquea el cierre** o sólo avisa. Se explican en [[Manual-El-cierre-de-mes]], que es donde se pagan.

---

## Las compuertas de confirmación

Todo acto que toque el mayor pregunta antes, y el aviso dice el importe y la irreversibilidad: `Post P-0042 (18,500.00) to the ledger? This cannot be undone.`

**Responde `y`.** En `entry post`, `entry reverse`, `entry void`, `invoice issue`, `invoice void`, `payment create`, `receipt record` y `bill approve`, las únicas respuestas afirmativas son `y` y `yes`. Escribir `s` o `sí` **cancela**, y el mensaje que recibes es `Aborted.` sin explicar que no te entendió — es fácil concluir que el sistema rechazó el asiento por una razón contable.

Sin terminal (dentro de un `cron`, por ejemplo) el comando no asume tu consentimiento: se niega y te dice que vuelvas a correrlo con `--yes` o con `--dry-run`. Eso es lo correcto, y significa que un guion desatendido tiene que llevar `--yes` explícito.

---

## Lo que hoy no se puede hacer desde aquí

| Paso | Estado | Sustituto |
|---|---|---|
| Descargar los CFDI del portal del SAT | ❌ No existe. `mnemosine sat` sólo tiene `cred`, pese a que su ayuda dice «CFDI download» | Bajar el ZIP del portal a mano y descomprimirlo antes de `ingest` |
| Timbrar una factura de cliente | ❌ No existe | Timbrar en el portal del PAC con los mismos datos |
| Cancelar un CFDI ante el SAT | ❌ No existe | Cancelar en el PAC, después `entry reverse --reason` con el acuse |
| Emitir el REP de un cobro | ❌ No existe | Emitirlo en el PAC; llevar la cuenta con `rep missing list --direction issued` |
| Contabilizar una nota de crédito | ❌ No existe como comando | `invoice void` si no se timbró ni se cobró; si no, póliza manual con `entry create` |
| Corregir una factura de proveedor ya aprobada | ❌ No hay `bill edit` ni `bill void` | `entry reverse` del asiento y volver a capturar |
| Programar un pago | ❌ No existe, y el sistema lo dice: no tiene programador de pagos ni conexión con ningún banco | Pagar en el banco y registrar el hecho con `payment create` |
| Alta masiva de clientes o proveedores | ❌ No hay `customer import` ni `vendor import` | Capturar uno a uno |
| Declarar PUE/PPD con una bandera | ❌ No hay `--metodo-pago` | Escribir el literal `PUE` o `PPD` dentro de `--terms` |

---

## Ver también

- [[Manual-Bancos-y-conciliacion]] — qué pasa con el efectivo que estos comandos mueven, y por qué la conciliación se acaba a medio camino.
- [[Manual-El-cierre-de-mes]] — la lista de verificación, el barrido del IVA de los REP y los dos cierres.
- [[Fiscal-mexicano]] — el porqué de la base de flujo, la taxonomía del CFDI y los límites del timbrado.
- [[Glosario]] — póliza, auxiliar, balanza, REP y el resto del vocabulario, con el comando de cada uno.
