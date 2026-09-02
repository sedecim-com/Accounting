# El IVA mexicano no se traduce: se implementa

Un sistema contable genérico registra el impuesto cuando emite la factura. En México eso está mal la mitad de las veces, y la mitad equivocada es la cara: la LIVA causa y acredita el impuesto **cuando el dinero se mueve**, no cuando el comprobante se emite. Esa sola regla obliga a cuentas de control propias, a un clasificador que lea el `MetodoPago` antes de decidir, y a un módulo que libere el impuesto cuando llega el comprobante de pago. Es la razón de que el motor sea propio y no una capa de traducción sobre uno importado.

Esta página explica cómo está construido eso por dentro. El «qué es esto y cómo arranco» vive en el [README](https://github.com/sedecim-com/Accounting/blob/main/README.md); aquí se explica el porqué.

## Antes de las virtudes: cuatro huecos que hay que conocer

Este proyecto presume de rojos honestos, y esta página traiciona su propósito si los esconde detrás de la maquinaria que sí funciona.

**1. La descarga masiva del SAT no existe.** Ni cliente SOAP (`SolicitaDescarga` / `VerificaSolicitud`), ni lector de paquetes ZIP, ni comando `sat download`, ni la reversa de facturas contabilizadas cuyo CFDI el emisor canceló. El criterio ejecutable E3.2 lo declara en rojo y explica por qué: la versión anterior de ese criterio pasó verde durante semanas porque su expresión regular casaba con dos cadenas de **prosa** en una pregunta de política. La consecuencia práctica es directa: **un despacho no puede afirmar completitud de CFDI recibidos desde aquí**. Sólo sabe de los comprobantes que alguien le entregó. Se comprueba con `npm run plan:status`.

Ojo con la ayuda del binario: `mnemosine sat` se describe a sí mismo como «SAT services (credentials and CFDI download)», pero lo único que cuelga de él es `sat cred` — alta, estado, bitácora y revocación de la e.firma. La descarga no está.

**2. El timbrado real depende de contratar un PAC, y de cuatro adaptadores sólo uno no es simulado.** `finkok`, `sw_sapien` y `edicom` declaran `simulado = true`: fabrican el UUID y el sello con `crypto.randomBytes` y devuelven éxito. El único que declara `simulado = false` es `sovos_reachcore` (RC Timbre 6.0), y no fabrica nada: si no puede hablar con el proveedor, o si la respuesta no trae UUID, lanza.

Lo que impide el daño es un cerrojo de dos capas en [`simulacion.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/integrations/mexico/pac/simulacion.ts): un adaptador simulado no puede timbrar salvo que `CFDI_PERMITIR_SIMULACION=true` **y** el entorno no sea producción; y cuando sí se permite, el folio se persiste con `cfdi_status='failed'` más una nota, jamás como `'stamped'`. El vocabulario de la columna no tiene un valor para «simulado» a propósito: añadirlo haría creer que es un estado fiscal legítimo.

**3. No hay sellado propio del XML.** El adaptador de Sovos se eligió justamente porque recibe el XML **ya sellado** por nosotros y sólo agrega el timbre, de modo que el `.key` nunca sale de la bóveda — las otras dos pilas del mismo proveedor exigen entregarle el CSD, y por eso sus nombres de método viven en una lista `METODOS_PROHIBIDOS` en el código y no sólo en el expediente. Pero el módulo que calcula la cadena original y firma con el CSD **no está escrito**. Y el XML que arma hoy `POST /v1/invoices/:id/cfdi/stamp` es un `Comprobante` mínimo: versión, folio, total, subtotal y moneda, sin `Emisor`, sin `Receptor`, sin `Conceptos`, sin `Sello`. La emisión de CFDI de venta no es funcionalidad terminada.

**4. El XML del Anexo 24 no se genera.** Lo que existe es la materia prima: la columna del agrupador por cuenta, la compuerta de cobertura y el auxiliar con la forma que pide el XC. El armado del catálogo y de la balanza en XML sigue pendiente. Se detalla más abajo.

Con eso dicho, lo que sí está construido.

## Del XML a los hechos: el CFDI entra como dato hostil

El analizador ([`cfdi-parser.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/cfdi-parser.ts)) acepta CFDI 4.0 y 3.3 y rechaza cualquier otra versión por nombre. Dos detalles que costaron encontrarse:

- `fast-xml-parser` con `parseAttributeValue` convierte `Version="4.0"` en el número `4`; la normalización lo devuelve a `"4.0"` antes de comparar.
- `CfdiRelacionados` es **hermano** de `Comprobante`, no vive dentro de `<cfdi:Complemento>`. Buscarlo entre los complementos no lo encuentra nunca, y sin el `TipoRelacion` un egreso que aplica un anticipo (07) es indistinguible de una devolución (03). Son dos asientos completamente distintos.

De ahí sale un objeto de **hechos** ([`cfdi-facts.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/cfdi-facts.ts)): dirección (`emitido` / `recibido` / `ajeno`, comparando contra el RFC de la entidad), método de pago, IVA trasladado al 16 y al 8, importe exento —que no es lo mismo que tasa cero y por eso se cuenta aparte—, IEPS, retenciones de ISR e IVA, impuestos locales, complementos, documentos relacionados y si el comprobante es un anticipo (clave `84111506`).

Los [catálogos del SAT](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/sat-catalogs.ts) —régimen fiscal, uso de CFDI, forma de pago, motivos de cancelación— son tablas de códigos y **no una lista blanca de validación**: el SAT los publica y los revisa, así que un código que falte aquí es un código que no hemos copiado, no un código que el SAT rechace. Las tasas de IVA viven como cadenas decimales (`'0.160000'`), no como números de JavaScript: una tasa es un factor de un cálculo de dinero, y `0.16` en punto flotante es exactamente cómo se pierde un centavo en un traslado.

Antes de que el modelo vea una sola letra, el texto de terceros se envuelve. La descripción de un concepto, el nombre del emisor y cualquier campo que venga en el XML pasan por `scanImportedText` —frases de inyección en inglés y en español, Unicode invisible, URLs de exfiltración con `curl`/`wget`, delimitadores de marcador incrustados— y viajan sanitizados entre `<<<UNTRUSTED_CFDI_DATA>>>` y su cierre. Los `<<<` y `>>>` que traiga el propio texto se sustituyen por comillas angulares parecidas, de modo que un campo del CFDI no pueda cerrar el bloque que lo contiene. La factura de un tercero es entrada de un atacante potencial; se trata como tal. Ver [`untrusted.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/untrusted.ts) y [`ingest-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/ingest-service.ts), y [[Seguridad-y-credenciales]].

## La taxonomía: una matriz declarativa, no un `if` gigante

[`cfdi-taxonomy.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/cfdi-taxonomy.ts) es la fuente única del tratamiento contable de un comprobante. Cada caso declara los tipos y direcciones a los que aplica, una condición opcional, las líneas del asiento con **roles abstractos** en vez de cuentas, las decisiones que hay que resolver antes de postear y una prioridad: gana el más específico.

Los roles (`gasto`, `cxp`, `iva_acreditable`, `iva_pendiente_acreditar`, `banco`…) se resuelven a cuentas concretas por entidad, en la tabla `account_roles`. Ésa es la indirección que permite que la misma taxonomía sirva para el catálogo del despacho y para el del cliente importado. La siembra de referencia mapea `iva_acreditable → 1130`, `iva_pendiente_acreditar → 1135`, `iva_trasladado → 2120`, `iva_trasladado_no_cobrado → 2125`; en una entidad con catálogo propio los códigos son otros y el rol sigue siendo el mismo.

Un `posting: null` es una decisión explícita, no una omisión: un traslado (tipo T) no genera asiento porque no hay transacción económica, y un CFDI `ajeno` —donde ni el emisor ni el receptor son la entidad— no se registra porque probablemente se cargó en la entidad equivocada.

Hay una advertencia importante que el propio archivo lleva escrita: los casos `pago_recibido` y `pago_emitido` **no son la ruta de posteo en producción**. Existen como descripción del hecho económico. Un REP se contabiliza por la puerta de pagos, por las razones que se explican más abajo; postear esas dos líneas *además* del pago abonaría el banco dos veces.

## Del veredicto al asiento

El clasificador ([`cfdi-classifier.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/cfdi-classifier.ts)) une hechos, caso y decisiones y devuelve un veredicto: `ready`, `needs_input`, `no_posting` o `blocked`. No escribe nada; quien lo llama decide.

Antes de proponer nada comprueba que el comprobante cuadre consigo mismo: subtotal − descuento + traslados − retenciones contra el total, con tolerancia de cinco centavos. Si no cuadra, se detiene ahí con el motivo — es señal de que hay un complemento de impuestos sin leer, y un asiento nacido de un CFDI descuadrado tampoco va a cuadrar.

El [plan de posteo](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/cfdi-posting-plan.ts) es la costura entre dos cosas que ya sabían hacer su trabajo: el clasificador decide la **estructura fiscal** (qué caso es, si el IVA va a acreditable o a pendiente, qué retenciones hay), y el mapeo por renglón decide **a qué cuenta de gasto** va cada concepto. La línea de gasto se «abre» en los renglones del documento sólo si la suma coincide dentro de un centavo y todos los renglones tienen cuenta; si no, se usa la cuenta genérica del rol y queda constancia del aviso. Preferimos una cuenta genérica correcta a un desglose que descuadra.

La razón de que esta costura exista es un error real: el clasificador declarativo estaba completo y probado, y **no lo llamaba nadie**. La ruta viva de ingesta armaba el asiento a mano y mandaba todo el IVA a la 1130, sin mirar el método de pago. Cada factura a crédito adelantaba así un acreditamiento que todavía no existía.

Para ver el rastro de un comprobante ya registrado:

```bash
mnemosine cfdi explain <uuid>
```

## El estatus ante el SAT: apagado significa apagado

`ConsultaCFDIService` es un servicio **público y anónimo** del SAT: no usa la e.firma, no pasa por la bóveda de credenciales y no consume cupo. El bloqueo de la descarga masiva nunca le aplicó, así que el cliente real existe ([`cfdi-status.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/sat/cfdi-status.ts)). El sobre SOAP se arma a mano: una dependencia de cliente SOAP entera para una operación de un solo parámetro es superficie sin renta.

El stub anterior respondía «Vigente» **siempre** en sandbox. Un CFDI cancelado por el emisor se clasificaba como vigente y el asiento se planeaba encima. Hoy, `SAT_STATUS_MODE=off` devuelve un resultado que dice que está apagado, nunca un vigente falso.

```bash
mnemosine cfdi status sync
```

## El IVA sobre base de flujo: LIVA art. 1-B y art. 5 fr. III

Aquí está la diferencia entre un sistema contable mexicano y uno traducido.

El `MetodoPago` del CFDI es el hecho que decide:

- **PUE** (pago en una sola exhibición): el impuesto se causa —si emitimos— o se acredita —si recibimos— al emitir el comprobante.
- **PPD** (pago en parcialidades o diferido): al emitir **no** se causa ni se acredita. Se estaciona en `2125 IVA Trasladado No Cobrado` (emitido) o `1135 IVA Pendiente de Acreditar` (recibido), y se mueve a `2120` / `1130` cuando llega el pago.

Qué rol recibe el impuesto **no se decide** en el módulo de flujo: se lee de la taxonomía, que ya modela los cuatro casos. [`iva-cash-basis.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/iva-cash-basis.ts) sólo le hace la pregunta y hace la aritmética.

### Una factura PPD de 10 000 + IVA, en sus dos momentos

Gasto recibido, PPD, subtotal 10 000.00, IVA al 16 % = 1 600.00, total 11 600.00. Caso `ingreso_recibido_ppd`.

**Momento 1 — llega el CFDI.** El dinero no se ha movido.

| Cuenta | Rol | Cargo | Abono |
|---|---|---:|---:|
| 6100 Gastos | `gasto` | 10 000.00 | |
| 1135 IVA Pendiente de Acreditar | `iva_pendiente_acreditar` | 1 600.00 | |
| 2110 Proveedores | `cxp` | | 11 600.00 |

Dos cosas que no son obvias. Primera: se abona a **proveedores**, no a bancos, incluso cuando la factura ya se pagó; el desembolso aparece al conciliar el estado de cuenta, y abonar el banco aquí duplicaría la salida cuando llegue el movimiento bancario. Segunda: esos 1 600.00 **no son acreditables todavía**. Mandarlos a la 1130 infla el acreditamiento del mes y es exactamente el hallazgo que la autoridad escribe.

**Momento 2 — se paga la factura completa y llega el REP.**

| Cuenta | Rol | Cargo | Abono |
|---|---|---:|---:|
| 2110 Proveedores | `cxp` | 11 600.00 | |
| 1110 Bancos | `banco` | | 11 600.00 |
| 1130 IVA Acreditable | `iva_acreditable` | 1 600.00 | |
| 1135 IVA Pendiente de Acreditar | `iva_pendiente_acreditar` | | 1 600.00 |

Las cuatro líneas van en **un solo asiento**, el del pago. La alternativa obvia —un asiento separado de reclasificación— es la equivocada: el movimiento de efectivo y el impuesto que dispara son un mismo hecho, y sólo un asiento por pago sobrevive intacto a una reversión. Cancelar el pago con dos asientos desharía el efectivo y dejaría el impuesto movido.

Los dos pares están en lados opuestos del balance, así que se vacían con asientos opuestos: la 2125 es pasivo y se vacía con **cargo**; la 1135 es activo y se vacía con **abono**. Invertirlo cuadra igual de bien y deja las dos cuentas al revés, que es por qué está escrito con todas sus letras en [`ar-ap-posting.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/ar-ap-posting.ts).

La misma factura en **PUE** habría cargado la 1130 desde el momento 1, y el pago no habría movido un peso de impuesto.

### Pagos parciales: objetivos acumulados, no redondeos por pago

Si de esos 11 600.00 se pagan primero 5 800.00, el impuesto liberado no se calcula sobre esa parcialidad aislada sino como la **diferencia entre dos objetivos acumulados**: `objetivo(5 800) = 1 600 × 5 800 / 11 600 = 800.0000`, menos `objetivo(0) = 0`. El segundo pago libera `objetivo(11 600) − objetivo(5 800) = 1 600 − 800 = 800.0000`. Cuando el documento queda totalmente aplicado la razón es exactamente 1, el objetivo es el IVA íntegro y **no queda nada varado** en la 1135. Con redondeo por parcialidad, sí quedaría. El dinero viaja a cuatro decimales por esta ruta, como en toda la base.

### El tope: no se libera lo que nunca se aparcó

`ivaStillParked` lee el mayor —no una bandera— y devuelve cuánto impuesto tiene realmente aparcado ese documento. Es el techo de lo que un pago puede liberar, y existe porque la liberación tiene que componer con la historia: toda factura registrada antes de que existiera el IVA en flujo mandó su impuesto directo a la cuenta efectiva y no aparcó nada. Liberar contra una así abonaría dos veces la cuenta y dejaría la pendiente en negativo, que es la señal de que una declaración mensual está a punto de salir mal.

Un tope de cero significa dos cosas muy distintas —que el documento no aparcó nada, o que la entidad no tiene sembrada la capa semántica y la consulta por rol no encuentra cuenta— y el código las distingue: en el segundo caso lanza `MISSING_ROLE_ACCOUNT` con el comando de siembra, en vez de liberar cero en silencio.

El histórico mal acreditado se corrige con una **reclasificación**, no con una reversión: los importes eran correctos y la cuenta no. Se mueve el saldo de la 1130 a la 1135 con asiento propio, fechado en el periodo del hecho —reclasificar un IVA de marzo no es un movimiento de agosto—, marcado con `source_type='iva_reclass'` para que correrlo dos veces no duplique nada.

```bash
npm run reclass:iva-ppd
```

### Cuando el documento no dice nada

Si ningún hecho declara el método de pago, se aplica el criterio que **no puede subestimar el impuesto**: lo emitido se trata como PUE (el IVA trasladado se reconoce ya; reconocerlo tarde difiere el entero, que es el error caro) y lo recibido como PPD (el IVA acreditable espera; acreditarlo ya lo adelanta sobre una factura que quizá nunca se pague). Ambas elecciones se autocorrigen cuando el efectivo se mueve.

La lectura del método desde texto libre está deliberadamente apretada: `PUE` o `PPD` sólo cuentan como declaración cuando van solos. `"Entrega en Cholula, Pue."` es el estado de Puebla y `"Ref PPD-2026-04"` es un folio; ambos casan con un `\b` ingenuo y el primero es el caro, porque acreditaría el IVA al recibir sin aviso alguno. Si el texto nombra los dos códigos, tampoco hay respuesta: dos respuestas no son una respuesta.

## El REP: la ligadura primero, el impuesto es su consecuencia

Un CFDI tipo P documenta que un dinero se movió y contra qué facturas se aplicó. La tentación es que su ingesta postee el asiento directamente. Eso produce dos daños.

El primero se ve: si el pago también se capturó por la puerta de pagos, el banco queda abonado dos veces. El segundo no se ve, y es peor: si además se liberan las líneas de IVA, el impuesto se traspasa dos veces, pero el tope de `ivaStillParked` recorta el exceso **sin avisar**, así que la póliza cuadra y la declaración mensual sale mal. Un número equivocado que cuadra no lo encuentra nadie.

Por eso [`rep-linkage.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/rep-linkage.ts) nunca escribe un asiento. Resuelve a qué pago corresponde el comprobante y, si ese pago no existe, lo crea **por la puerta de pagos** — que ya libera el IVA, porque la reclasificación no lee el pago sino las filas de aplicación. El traspaso sale gratis, en la misma póliza y sin una sola línea de impuesto escrita ahí.

El camino, en orden:

1. **Idempotencia primero.** La llave es `(entidad, uuid, índice del nodo de pago)`: un REP puede documentar varios movimientos de banco y cada uno es una fila de pago. La impone además un índice único parcial en la migración 036; la consulta previa evita el error, no lo sustituye.
2. **Moneda.** Si el pago viene en moneda distinta de la funcional, la diferencia cambiaria no se calcula todavía —nada postea a utilidad o pérdida cambiaria—, así que por omisión el comprobante queda para revisión en vez de casarse con un tipo de cambio inventado. La política `rep_moneda_extranjera` puede autorizar casar al tipo de cambio del documento, y entonces el aviso lo dice.
3. **Documentos relacionados.** Los UUID se resuelven a documentos del sistema. Las facturas emitidas llevan su UUID en la propia tabla; los gastos no, y el puente es el pre-registro que los creó. Si falta alguno, por omisión el impuesto se queda aparcado —que es donde la ley lo quiere hasta que haya documento que lo ampare—.
4. **Cotejo del IVA declarado.** `ImpuestosDR` es la cifra del SAT para esa parcialidad; el prorrateo sobre el documento es la nuestra. Si divergen más que la tolerancia, se detiene con **las dos cifras nombradas** en vez de elegir una en silencio: puede ser otra parcialidad, un documento corregido o un error del emisor.
5. **Búsqueda del pago existente.** Mismo tercero, importe dentro de tolerancia, fecha dentro de ventana, sin comprobante ya ligado — **y aplicado a alguno de los documentos que el REP relaciona**. Los tres primeros criterios no bastan: dos pagos iguales al mismo proveedor en la misma semana (una renta quincenal, una iguala) se cruzarían, y el gasto equivocado quedaría «con comprobante» mientras el del REP se queda sin pago y con su IVA aparcado. La aplicación es lo que dice de qué hecho económico es el dinero.
6. **Casar es anotar, no volver a postear.** El asiento del pago ya existe y ya liberó su IVA.

Hay un detalle que se descubrió reproduciendo el fallo: el importe con el que se **busca** tiene que ser el mismo con el que se **crearía**. La primera versión buscaba por el `Monto` del nodo y creaba por la suma resuelta; cuando divergían, el pago capturado a mano no se encontraba y se creaba el duplicado que el módulo existe para impedir.

Y otro que sólo se vio porque faltaba una prueba: la resolución del lado emitido consultaba `balance_due`, columna que no existe —la tabla se creó con `amount_due`—, así que **todo** REP emitido moría con un error de Postgres. La suite sólo cubría el lado de proveedores. Una rama sin prueba no está casi lista: está sin ejecutar.

### Los aparcados y los faltantes

Durante mucho tiempo el propio código lo decía: «nada lo reintenta solo». Ya no.

```bash
mnemosine rep reconcile
```

Reintenta los REP que quedaron en `needs_review` porque la ligadura pidió decisión humana. Es idempotente de punta a punta: los nodos ya resueltos los salta el índice único, y un REP que vuelve a pedir decisión se queda aparcado con su motivo fresco.

El checklist de faltantes va por dirección, porque son dos obligaciones distintas:

```bash
mnemosine rep missing list --direction received
```

- **`received`**: facturas PPD ya pagadas cuyo comprobante del proveedor no ha llegado. Mientras no llegue, el IVA sigue en la 1135 y **no es acreditable**.
- **`issued`**: cobros nuestros sin REP emitido. Es obligación fiscal propia, con plazo.

El método de pago sale del **espejo** de CFDI. Cuando el comprobante propio no está espejado, el método es desconocido y la fila se lista **con esa marca**: listar de más con la duda dicha es mejor que esconder un REP exigible.

### El espejo es por entidad

`xml_documents.cfdi_uuid` nació con unicidad **global** —ni siquiera por inquilino—, y eso rompía el caso más normal de un despacho: cuando las dos partes de la operación son clientes suyos, el mismo XML debe entrar dos veces, el emisor como `emitido` y el receptor como `recibido`. La migración 046 cambió la llave a `(entity_id, cfdi_uuid)`, y de paso llevó a la base la unicidad de `xml_hash`, que hasta entonces sólo vivía en código y por tanto era una carrera. Ver [[Base-de-datos-y-migraciones]] y [[Aislamiento-multi-inquilino]].

## Deducibilidad LISR: el clasificador pregunta, el panel responde

Hay escenarios donde el **mismo XML** admite varios registros válidos según información que no está en el documento. El sistema no elige solo: pregunta con opciones concretas, y cada respuesta se guarda como precedente. Están declarados en [`cfdi-decisions.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/xml-ingestion/cfdi-decisions.ts), cada uno con su fundamento:

| Decisión | Fundamento | Severidad |
|---|---|---|
| `efectivo_no_deducible` — pago en efectivo por encima del límite | LISR 27 fr. III; LIVA 5 fr. I | bloqueante |
| `combustible_efectivo` — combustible en efectivo, sin importar el monto | LISR 27 fr. III | bloqueante |
| `consumo_restaurante` — sólo el 8.5 % es deducible | LISR 28 fr. XX | consultiva |
| `gasto_vs_activo` — capitalizar o mandar a resultados | LISR 31-38 (el umbral es política de la empresa, no regla del SAT) | bloqueante |
| `anticipo_o_gasto` — anticipo o gasto ya devengado | Guía de llenado del Anexo 20, apéndice 6 | bloqueante |
| `ieps_acreditable` — acreditable o parte del costo | LIEPS art. 4 | consultiva |
| `por_cuenta_terceros` — de quién es el gasto | RMF 2.7.1.13 | bloqueante |
| `cfdi_cancelado` — el SAT lo reporta cancelado | CFF 29-A | bloqueante |
| `periodo_cerrado` — el CFDI cae en periodo cerrado | NIF B-1 / política de cierre | bloqueante |
| `gasto_vs_anticipado` — gasto que cubre varios periodos | NIF A-2 | consultiva |
| `proveedor_nuevo` — dar de alta al emisor | control interno | bloqueante |

Una decisión `blocking` impide postear; una `advisory` deja postear con su valor por omisión pero conviene confirmarla.

Los umbrales no están cableados: los resuelve el **panel de políticas** ([`pending-catalog.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/policy/pending-catalog.ts)) y se inyectan en el clasificador. Que esa inyección existiera y nadie la usara era un fallo real: el despacho contestaba `umbral_capitalizacion_mxn` y no cambiaba nada. Hoy `lleva_inventarios` gobierna incluso qué **opciones** se ofrecen: sólo con el valor literal `perpetuos` aparece la opción de inventario, para que un despacho a costo directo no acabe con compras capitalizadas por un clic distraído.

```bash
mnemosine pending
```

Una bifurcación de criterio contable no se pregunta al usuario en el momento ni se elige en el código: se añade al panel. Ver [[El-tablero-y-los-criterios]] y [[El-agente-y-sus-limites]].

## El agrupador SAT y la contabilidad electrónica

El Anexo 24 exige que cada cuenta del catálogo declare su **código agrupador**. Es la tarea de alta más pesada de un despacho mexicano, y las columnas para guardarla existían en `accounts` desde la primera migración, tipadas y **siempre nulas**: ninguna ruta las escribía. Hoy sí:

```bash
mnemosine account map set 1130 --scheme sat-agrupador --value 118
```

```bash
mnemosine account map check --scheme sat-agrupador --level 2
```

`map check` es la compuerta de cobertura previa al XML de catálogo: lista las cuentas activas hasta el nivel indicado que aún no tienen valor en el esquema. La carga masiva **no valida** contra `c_CodAgrup` porque ese catálogo no está en el repositorio; la bandera `--year` se rechaza con mensaje explícito en vez de fingir que soporta versiones. Los esquemas sin columna (`fs-line`, `cash-flow`, `consolidation`) se rechazan igual: fingir que se guardó un mapeo es peor que decir que aún no se puede.

La otra pieza es el **auxiliar**, con la forma que pide el XML XC: por cuenta y periodo, el saldo inicial, cada movimiento y el final.

```bash
mnemosine ledger auxiliary show --account 1130 --period March
```

Y aquí hay un rojo que un despacho tiene que conocer antes de firmar nada: el saldo inicial sale de `account_balances.beginning_balance`, que **sólo lo siembra el cierre duro**. En un periodo abierto ese campo dice cero, y eso es ausencia de arrastre, no un saldo. La vista lo dice con `period_status` y con `inicial_confiable` en vez de fingir — pero si marzo está cerrado en duro con febrero abierto, el inicial de marzo es cero por ausencia de arrastre y la marca de confianza no lo advierte. Ese es el número que saldría en el XC.

**Lo que hoy se puede generar sin PAC**: la balanza de comprobación, el mayor, el auxiliar con la forma del XC, y el estado de cobertura del agrupador. **Lo que no**: el XML del catálogo de cuentas y el XML de la balanza del Anexo 24, ninguno de los dos está escrito. El envío al buzón tributario tampoco.

## Nómina, DIOT y lo que falta nombrar

- **Nómina.** Existe el generador de CFDI tipo N con complemento Nómina 1.2, que arma el XML y lo manda al enrutador de PAC — sujeto al mismo cerrojo antisimulación que todo lo demás. La taxonomía registra el asiento base (sueldos, ISR retenido, neto por pagar); el desglose fino —IMSS del trabajador, préstamos, subsidio, incapacidades— lo maneja el módulo de nómina.
- **DIOT.** No se genera. El generador que existía se eliminó junto con el resto de `mexico/cfdi.ts`, porque estaba construido sobre el formato de devengo derogado. Lo que sí hay es la lista de bloqueadores: `mnemosine vendor list --no-tax-id` enumera los proveedores sin RFC en el expediente, que son los que impiden armar la declaración.
- **CFDI de retenciones (tipo R).** El esquema es `retenciones:Retenciones`, no `cfdi:Comprobante`: el analizador actual lo rechazaría. Necesita su propio analizador. La taxonomía ya declara su tratamiento contable, a la espera.
- **Activo fijo.** Cuando una decisión capitaliza un desembolso, el importe llega a la cuenta de activo pero el sistema **no da de alta el activo ni calcula su depreciación mensual**. El aviso viaja con el documento para que la falta se vea en la revisión y no al cierre del ejercicio.

## Los números no se copian: se preguntan

Dos marcadores, cero copias.

```bash
npm run plan:status
```

Decide qué paquetes están en verde —incluido el rojo de la descarga masiva del SAT— evaluando criterios ejecutables, no una tabla escrita a mano.

```bash
npm run catalogo:estado
```

Decide cuántas filas del catálogo de comandos son hoy invocables. La tabla anterior estaba escrita a mano, duró cuarenta y dos commits y decía «~30 comandos» cuando el binario ya respondía más de cien.

---

Relacionado: [[Arquitectura]] · [[Base-de-datos-y-migraciones]] · [[Catalogo-de-comandos]] · [[El-tablero-y-los-criterios]] · [[Seguridad-y-credenciales]] · [[Glosario]] · [[Hoja-de-ruta]]
