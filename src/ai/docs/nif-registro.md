# NIF — Registro por tipo de operación (Series B, C y D)

Guía operativa: cómo se registra cada operación común y qué NIF lo fundamenta.
Los asientos usan roles de cuenta genéricos; resuelve los códigos reales con el
catálogo de la entidad (y los roles sembrados del módulo CFDI).

## D-1 / D-2 — Ingresos por contratos con clientes

El ingreso se reconoce al **transferir el control** del bien o servicio (modelo
de 5 pasos: contrato → obligaciones → precio → asignación → reconocimiento al
cumplir). Consecuencias de registro:

- **Venta devengada (CFDI I emitido, entrega hecha):**
  Cargo Clientes · Abono Ingresos · Abono IVA trasladado (cobrado si PUE,
  no cobrado si PPD).
- **Anticipo de cliente (no hay entrega aún):** Cargo Bancos · Abono
  **Anticipos de clientes (PASIVO)** · Abono IVA trasladado (el IVA sí se
  causa al cobro — LIVA). El ingreso NO se toca. Al facturar la venta real se
  aplica el anticipo (TipoRelacion 07): Cargo Anticipos de clientes · Abono
  Ingresos.
- **Devolución/descuento sobre venta (CFDI E):** Cargo Devoluciones y rebajas
  sobre ventas (cuenta de resultados deudora) · Cargo IVA trasladado · Abono
  Clientes. No se borra la venta original (NIF B-1: nada se edita).
- **Servicio cobrado o facturado por adelantado que se presta durante meses
  (suscripción, soporte, mantenimiento):** Abono **2158 Ingresos Cobrados por
  Anticipado** (rol `ingreso_cobrado_por_anticipado`, pasivo de contrato) por
  el subtotal; el IVA va a 2120 al cobro, como siempre. `deferred-revenue
  create` adopta ese abono y `deferred-revenue run` (o el paso
  `recognize-deferred-revenue` de `closing run`) reconoce cada mes: Cargo 2158 ·
  Abono Ingresos, sin IVA. El corte del primer mes lo fija la política
  `deferred_revenue_recognition_convention` (por días, por omisión). Para el
  ISR el ingreso se acumula completo al primero de CFDI, prestación o cobro
  (LISR art. 17 fr. I): el papel del pago provisional suma el abono neto del año
  a la 2158, así que no lo restes a mano.
- **Ingreso por avance de obra (D-2):** requiere medir el grado de avance —
  registro solo con confirmación del usuario.
- **ONIF 7** (30-ago-2024, en el libro NIF 2026): orientación NO obligatoria
  sobre contratos de construcción y de compraventa de bienes de capital; aplica
  D-1 / D-2 a esos contratos (identificar el contrato y sus obligaciones, y medir
  el avance). Cítala como orientación, nunca como requisito. Fuente secundaria
  (el CINIF la publica sólo en su sección de pago).

Precisiones D-1: **emitir factura NO equivale a devengar** (un CFDI por bienes
no entregados no genera ingreso contable — genera pasivo del contrato); el
ingreso se registra por el **subtotal sin IVA** (el IVA trasladado es pasivo,
nunca ingreso); las devoluciones y descuentos van en cuentas complementarias
de ingresos, no como gastos.

## C-3 — Cuentas por cobrar

Se reconocen al facturar. La **estimación para incobrables** usa pérdidas
crediticias esperadas: Cargo Gasto por estimación · Abono Estimación de cuentas
incobrables (contra-activo). Cancelar una cuenta incobrable consume la
estimación, no genera gasto nuevo (si la estimación alcanza). Es juicio del
usuario: propón, no impongas.

## C-4 — Inventarios

Costo de adquisición: precio + gastos directos para ponerlo en condiciones de
venta (fletes, aranceles). Fórmulas aceptadas: costos identificados, promedios,
PEPS (**UEPS no está permitido**). Valuación posterior: costo o valor neto de
realización, el menor. Registro:

- Compra de mercancía (inventario perpetuo): Cargo Inventarios · Cargo IVA ·
  Abono Proveedores.
- Venta: además del ingreso, Cargo Costo de ventas · Abono Inventarios
  (postulado de asociación de costos con ingresos, NIF A-1, cap. 20).

**Este sistema no postea ese costo de ventas** ni lleva existencias: lo de
arriba es la norma. Qué hace y qué no, en la tabla «Lo que este sistema
devenga».

## C-5 — Pagos anticipados

Erogaciones por bienes/servicios AÚN no recibidos (seguros, rentas, licencias
pagadas por adelantado): son **activo** y se llevan a resultados conforme se
devengan. Cargo Pagos anticipados al pagar; cada mes Cargo Gasto · Abono Pagos
anticipados. Un seguro anual cargado 100% a gasto el día 1 viola NIF A-1,
cap. 20 (asociación); adviértelo y ofrece la tabla de devengo.

## C-6 — Propiedades, planta y equipo

Es PPyE si: bien tangible, para uso en la operación (no para venta), y con
beneficio económico por más de un periodo. Costo inicial: precio + todo lo
necesario para dejarlo funcionando (instalación, fletes, honorarios).
**Depreciación**: sistemática sobre vida útil, desde que está disponible para
uso, componente por componente si son significativos. Cargo Gasto por
depreciación · Abono Depreciación acumulada (contra-activo). El umbral
gasto-vs-activo es política de la entidad (pendiente de política si no está
definida) — la NIF define QUÉ es PPyE, no el monto mínimo.

## C-8 — Intangibles

Se capitalizan si son identificables, controlados y con beneficios futuros
(licencias, software adquirido, marcas compradas). Los gastos de investigación
van a resultados; desarrollo solo se capitaliza con requisitos estrictos. La
publicidad y la capacitación NUNCA se capitalizan.

## C-9 — Provisiones, contingencias y compromisos

Provisión = pasivo de monto o fecha inciertos pero **obligación presente
probable y estimable** (garantías, litigios probables, reestructuras): Cargo
Gasto · Abono Provisión. Contingencia solo se revela, no se registra. No
registres provisiones sin confirmación del usuario: son estimaciones.

## C-11 — Capital contable

Movimientos SOLO por actos formales: aportaciones (acta de asamblea),
reembolsos, dividendos decretados (Cargo Utilidades acumuladas · Abono
Dividendos por pagar al DECRETO, no al pago), reserva legal (5% de la utilidad
neta anual hasta 20% del capital social — LGSM art. 20). Ante cualquier póliza
manual al capital, pide el documento que la soporta.

## B-15 — Moneda extranjera

- Reconocimiento inicial: tipo de cambio de la FECHA de la transacción.
- Al cierre: partidas monetarias (bancos, clientes, proveedores en USD) se
  revalúan al tipo de cierre; la diferencia va a resultados como fluctuación
  cambiaria (Cargo/Abono Pérdida/Utilidad cambiaria).
- Al cobrar/pagar: la diferencia entre el histórico y el tipo del día es
  fluctuación realizada.
- Partidas NO monetarias (inventario, PPyE comprados en USD) se quedan al
  histórico: no se revalúan.

## D-3 — Beneficios a los empleados

- Nómina devengada: Cargo Sueldos y salarios (+ carga social: IMSS patronal,
  Infonavit, SAR, impuesto sobre nómina) · Abono Sueldos por pagar · Abono
  ISR retenido · Abono IMSS retenido.
- **Aguinaldo, vacaciones, prima vacacional**: se devengan DURANTE el año
  (provisión mensual), no de golpe en diciembre (NIF A-1, cap. 20, devengación). El sistema
  lo hace: `runMonthlyProvisions` postea un asiento por corrida y deja la
  cédula por trabajador y periodo, y se pide con `mnemosine payroll accrue
  --period <YYYY-MM>` (con `--dry-run` para ver la cédula antes de postear).
- **PTU**: 10% de la renta gravable; la causada del ejercicio se provisiona
  contra resultados del mismo ejercicio. La base es de la ENTIDAD, no del
  salario de cada trabajador, así que NO cae en la corrida mensual de
  prestaciones: la propone `ptu close` al cierre del ejercicio, y hoy se
  niega — ver la tabla de abajo.
- Beneficios post-empleo / prima de antigüedad: cálculo actuarial — fuera del
  registro automático; refiere al actuario.

## D-4 — Impuestos a la utilidad

ISR causado: Cargo Gasto por ISR · Abono ISR por pagar. Los impuestos
DIFERIDOS (método de activos y pasivos por diferencias temporales) son cálculo
de cierre anual con juicio: propónlo solo como borrador de cierre y explica la
diferencia temporal que lo origina.

## D-5 — Arrendamientos

El arrendatario reconoce **activo por derecho de uso y pasivo por
arrendamiento** para casi todos los arrendamientos (excepciones: corto plazo
≤12 meses y bajo valor, que van directo a gasto). La renta simple mensual como
gasto solo es correcta bajo esas excepciones — si detectas rentas recurrentes
grandes de largo plazo, sugiere evaluar D-5 con el contador.

## C-13 — Partes relacionadas

Una operación con parte relacionada se registra como cualquier otra, pero
**exige revelación**: naturaleza de la relación, monto, saldos pendientes y
condiciones. Lo que la norma prohíbe es afirmar que fueron condiciones de
mercado sin sustento. Desde las Mejoras a las NIF 2026, toda entidad revela
además el total de beneficios del personal gerencial clave (ver «Cambios del
CINIF 2026-2028» abajo).

**Este sistema no la cubre.** No hay marca de parte relacionada en clientes ni
proveedores, ni informe que las agrupe. Si el contador identifica una, el
registro es correcto y la revelación se redacta fuera. Se nombra aquí para que
la ausencia sea medible: lo que no se nombra no se echa de menos.

## Lo que este sistema devenga, y lo que declara no devengar

La sección de cada NIF describe la NORMA. Ésta describe el MOTOR, que es otra
cosa y conviene no confundir.

**«Sin motor» quiere decir siempre lo mismo:** no hay registro, corrida ni
comando. El contador lo registra a mano; tú lo propones como borrador, nombras
la norma y dices qué parte es estimación. Nunca digas que el sistema lo
calcula, lo devenga o lo hará.

Los comandos de esta tabla que escriben los corre una persona: el catálogo de
comandos los declara no invocables por el agente. Los de consulta sí puedes
correrlos: `prepaid list`, `prepaid show`, `depreciation run` y
`report aged-receivable show`.

| Concepto | NIF | El sistema |
|---|---|---|
| Anticipos y pagos anticipados (1160) | NIF A-1 cap. 20, C-5 | **Devenga**, corrida mensual idempotente por entidad-periodo. `prepaid create` registra el calendario de un cargo que ya está en la 1160 (no postea); `prepaid run --period` o el paso `amortize-prepaids` de `closing run` postean el mes; `prepaid list` y `prepaid show` lo consultan. Ningún comando cancela ni acorta un calendario |
| Ingreso cobrado por anticipado (2158) | D-1 | **Devenga** por calendario. `deferred-revenue create` adopta un abono que ya está en la 2158 y registra su calendario (no postea); `deferred-revenue run --period` o el paso `recognize-deferred-revenue` de `closing run` postean el mes: Cargo 2158 · Abono Ingresos. El corte del primer mes lo fija `deferred_revenue_recognition_convention`. Ningún comando lista, cancela ni acorta un calendario. Asignar el precio entre obligaciones, la contraprestación variable y el grado de avance: **sin motor** |
| Depreciación de propiedades, planta y equipo | C-6 | **Devenga.** `asset create` da de alta el activo (no postea); `depreciation run --period` calcula la corrida y la muestra sin escribir; `depreciation post --period` o el paso `depreciate-assets` de `closing run` postean una póliza por activo. La base (`base_depreciacion`: vida útil o tasa de la LISR) y el primer mes (`convencion_primer_mes`) los fija el panel; se calcula y se postea UN solo calendario, no uno contable y otro fiscal. **Sin componentes:** cada activo es una ficha, sin padre ni partes. **Unidades de producción:** `asset create` rechaza ese método, contable o fiscal, porque nada captura la producción del periodo. A un activo que ya estaba registrado así la corrida no le calcula ni le postea nada: lo omite y lo nombra, en `depreciation post` y en el paso `depreciate-assets`, que ya no falla por eso. Su cargo del mes se registra a mano, y la casilla de depreciación del cierre lo cuenta según `depreciacion_faltante_al_cierre`. Capturar la producción: **sin motor** |
| Baja, venta o retiro de un activo | C-6 | **Sin motor.** La familia `asset` sólo tiene `asset create` y `asset category seed`: ningún comando da de baja, vende, edita ni corrige un activo, y la corrida sigue depreciando todo activo `active`. Dilo al contador antes de proponer la póliza de la baja: el activo seguirá en el registro (editar y retirar: tarea abierta MNE-001-880) |
| Inventarios y costo de ventas | C-4 | **Sin motor.** No hay catálogo de artículos, fórmula de costeo, costo de ventas al facturar ni comparación contra el valor neto de realización; las tablas `inventory_*` existen sin lector ni escritor. Sólo existe la política `lleva_inventarios` (por omisión `directo`): con `perpetuos`, el clasificador de CFDI ofrece cargar la compra a Inventarios (1140). La salida a Costo de ventas al vender no la postea nadie |
| Intangibles | C-8 | **Sin motor.** `asset category seed` siembra seis clases, todas tangibles (LISR arts. 34 y 35), ningún comando crea otra, y el catálogo base no trae cuenta de intangibles |
| Provisiones, contingencias y compromisos (garantías, litigios) | C-9 | **Sin motor.** No hay registro de provisiones ni revisión al cierre |
| Deterioro de activos de larga duración | C-15 | **Sin motor.** No hay prueba de deterioro ni cuenta de deterioro acumulado en el catálogo base; y como ningún comando edita un activo, la corrida de depreciación no recalcula después de un deterioro registrado a mano |
| Estimación para incobrables y cancelación de cuentas incobrables | C-3, C-16 | **Cuenta sembrada** (1129) y **sin motor.** `report aged-receivable show` da la antigüedad de saldos; nada calcula la estimación, y ningún comando cancela una factura por incobrable |
| Préstamos y otros pasivos financieros | C-19 | **Sin motor.** No hay registro de préstamos, tabla de pagos ni devengo de intereses. Un préstamo en moneda extranjera tampoco se revalúa: `closing fx revalue` sólo toma las cuentas de los roles `cxc`, `cxp` y `banco` y las cuentas de mayor de las cuentas bancarias |
| Aguinaldo, vacaciones, prima vacacional | D-3 | **Devenga**, corrida mensual idempotente por entidad-periodo (`provisions-run.ts`): un asiento por corrida con cargo a 6116 y abono a 2202/2203/2204, cuentas resueltas por rol. El mes del aniversario se parte en dos tramos del art. 76. La base salarial (`provision_base_salarial`) y el momento del reconocimiento de vacaciones (`devengo_vacaciones`) los fija el panel. Se pide con `payroll accrue --period`, o corre en el paso `accrue-benefits` de `closing run`. **El pago en nómina consume primero la provisión**, según la política `benefit_payment_against_provision`. Con `consume_provision` (por omisión), la póliza de `pay-run post` carga a cada provisión lo que la corrida paga en renglones de tipo `aguinaldo`, `pto` o `vacaciones` (días de vacaciones) y `prima_vacacional`, hasta lo que la provisión tiene; el excedente va al gasto de sueldos en un renglón aparte. **El mes es la unidad:** el devengo del mes descuenta, prestación por prestación y nunca por debajo de cero, lo que las corridas fechadas en ese mes pagaron por encima de la provisión, así que un aguinaldo pagado el día 15 y devengado al cierre de ese mes queda una sola vez en resultados; su resultado dice cuánto descontó y cuánto no. Una corrida cuya póliza sigue como borrador en revisión no se cuenta y se nombra: el mes se devenga completo por ella, así que pide resolver el borrador antes del cierre, o reversar el devengo y correrlo otra vez. Con `expense_on_payment` todo el bruto va a sueldos, y la póliza se rechaza mientras la provisión de una prestación que la corrida paga tenga saldo. Las vacaciones pagadas dentro del renglón `salary` no se distinguen del sueldo y quedan en gasto: pide que se desglosen como `pto` o `vacaciones`. **Lo que todavía no hace** (MNE-001-878 sigue abierta): las pólizas posteadas antes de esta regla no se corrigen ni se censan; adviértelo |
| PTU causada | D-3, LFT 117 y 120, LISR 9 | **Motor al cierre, que hoy se niega en toda instalación.** `ptu close --year` propone la PTU del ejercicio como póliza BORRADOR en el periodo 13 y no postea nada. La base son tres cifras que captura el contador con su fuente (ingresos acumulables, deducciones autorizadas y la parte no deducible de los pagos exentos), sin restar la PTU pagada ni las pérdidas; el porcentaje se lee de `legal_parameters` (`ptu.rate`) al 31 de diciembre; el borrador es la PTU menos lo que el ejercicio ya abonó a la provisión (2205, rol `provision_ptu`), contra el gasto (6117, rol `ptu_gasto`). **La fila `ptu.rate` no está sembrada** y ningún comando la carga: el comando rechaza con «El porcentaje de la PTU (ptu.rate) no está vigente» (tarea abierta: MNE-001-854), y mientras tanto la PTU se registra a mano. Sólo para el régimen 601; con otro régimen declarado se niega. La provisión es bruta: no aplica los topes por trabajador de la LFT art. 127 fr. VIII. La corrida mensual de prestaciones no toca la 2205, tampoco con `provision_ptu_mensual` encendida, y lo declara en su resultado en vez de dejar un cero mudo. PTU diferida y reparto por trabajador: **sin motor** |
| Prima de antigüedad | D-3, LFT 162 | **Fuera de alcance, declarado.** Exige valuación actuarial —rotación, mortalidad, descuento—; una cuenta sin motor que la alimente es peor que ninguna, porque parece cobertura |
| Impuestos diferidos | D-4 | **Cuentas sembradas** (1310, 2300); el cálculo es de cierre anual y con juicio, se propone como borrador |
| Arrendamientos | D-5 | **Sin motor.** No hay activo por derecho de uso ni pasivo por arrendamiento; la renta se registra como gasto, que sólo es correcto bajo las excepciones de corto plazo y bajo valor |
| Partes relacionadas | C-13 | **Sin motor ni revelación** (ver arriba) |
| Otros Resultados Integrales | B-3 | **Categoría y cuenta existen** (3600, `fs_category = 'ori'`); qué se lleva al ORI lo decide cada caso |
| Capital ganado | B-6, C-11 | **Categoría existe** (`fs_category = 'earned_capital'`): la reserva legal 3150, los resultados 3200 y 3300 y el resumen 3900 se presentan aparte del capital contribuido (`equity`), con el rótulo «Reservas y resultados acumulados». El balance general presenta primero el capital contribuido y después el capital ganado, cuyo total («Total de Capital ganado», `earned_capital` en el informe, renglón `line = 'group'` en csv/json) suma esa categoría, el resultado del ejercicio aún no cerrado y el ORI, como lo define la C-11. En una entidad anterior a la migración 346, una de esas cuentas que alguien editó (otro código u otro subtipo) se quedó en `equity` hasta que una persona la reclasifique |

## B-1 — Cambios contables y correcciones de errores

- **Error del ejercicio EN CURSO** (detectado antes de emitir estados): se
  corrige en el propio ejercicio — en este sistema, REVERSA del asiento
  erróneo + asiento correcto contra los rubros originales, nunca edición.
- **Error de un ejercicio YA CERRADO**: no se reabre ni se borra nada — póliza
  de ajuste en el periodo actual con cargo/abono a **resultados de ejercicios
  anteriores / utilidades acumuladas**, aplicación retrospectiva en las cifras
  comparativas, y revelación.
- **Cambio de estimación** (vida útil, valor residual, % incobrables):
  prospectivo — solo afecta presente y futuro; JAMÁS recalcular
  retroactivamente la depreciación ya registrada.
- **Cambio de norma o política**: retrospectivo contra utilidades acumuladas,
  con revelación.
Distinguir error vs estimación decide si hay reversa: pregunta cuando sea
ambiguo.

## B-10 — Efectos de la inflación

Entorno **inflacionario** = inflación acumulada del trienio ≥ 26% (INPC);
hoy México está en entorno NO inflacionario: no se registran pólizas de
reexpresión ni REPOMO, pero las reexpresiones históricas previas se conservan
como parte del costo. En cada cierre anual se documenta la verificación del
entorno con el INPC.

## B-13 — Hechos posteriores al cierre

Entre la fecha de los estados y su emisión: hechos que evidencian condiciones
que YA existían al cierre **ajustan** las cifras con fecha del ejercicio que se
cierra (quiebra de un cliente que confirma incobrabilidad al cierre); hechos de
condiciones surgidas DESPUÉS solo se **revelan**, jamás modifican saldos. Un
dividendo decretado después del cierre NO es pasivo del ejercicio cerrado.

## C-15 — Deterioro de activos de larga duración

Con indicios (pérdidas recurrentes, obsolescencia, caída de demanda), se
compara valor en libros contra valor de recuperación (el mayor entre valor
razonable menos costos de disposición y valor de uso): el exceso es pérdida
por deterioro — Cargo Resultados · Abono Deterioro acumulado (complementaria
del activo), y la depreciación futura se recalcula. Es estimación con juicio:
propón solo con confirmación del usuario.

## Cambios del CINIF 2026-2028: Mejoras 2026, Mejoras 2027 y B-4/B-6

Resumen de documentos del CINIF en abierto, leídos el 2026-11-24; no copia su
texto. El texto promulgado vive en el libro NIF 2026, que es de pago, así que
donde sólo hay proyecto se dice «proyecto» y se cita como tal.

- **Mejoras a las NIF 2026**, vigentes para ejercicios desde el 1-ene-2026,
  con aplicación anticipada en 2025. La página del libro NIF 2026 dice que el
  libro las incluye. Sección I (generan cambio contable):
  - **NIF B-11** (párr. 50.4): los flujos de efectivo de la disposición de
    activos de larga duración y de las operaciones discontinuadas se presentan
    de forma prospectiva; los estados de flujos de periodos anteriores que se
    presentan comparativos no se reformulan.
  - **NIF C-10** (párr. 32.6): un contrato de bienes de uso propio se trata
    como IFD sólo si al valuarlo inicialmente se designa a valor razonable con
    efecto en resultados, para eliminar o reducir una asimetría contable; el
    proyecto lo presenta como alineación con NIIF 9. Párr. 35.2.4 y 62.2.2: un
    instrumento contratado con una parte relacionada (p. ej. una permuta de
    tasa de la subsidiaria con su controladora) puede ser instrumento de
    cobertura en los estados individuales; en los consolidados esa cobertura se
    elimina, y la revelación dice si se celebró con partes relacionadas.
  - **NIF C-13** (párr. 61.10, nuevo, y 66.1): toda entidad revela el importe
    total de los beneficios a empleados del personal gerencial clave; la EIP lo
    segrega en beneficios directos a corto y largo plazo, pagos basados en
    acciones, beneficios por terminación y post-empleo. Es revelación de
    partes relacionadas, no un cambio a NIF D-3.
  - Sección II (precisiones sin cambio contable ni fecha de vigencia): NIF A-1
    y B-4 (capital ganado; en B-4 también los ORI netos), B-6 (párr. 56.1,
    pasivos a corto plazo), C-20 (cambio de modelo de negocio), D-4 (alcance:
    impuestos sobre una utilidad fiscal de base neta, no bruta), el párr. 60.1
    de revelación de todas las NIF particulares y el glosario.
  Fuentes: proyecto de auscultación del 15-sep-2025,
  https://www.cinif.org.mx/uploads/Mejoras_NIF_2026_PROYECTO_AUSCULTACION.pdf
  y la página del libro, https://www.cinif.org.mx/info_libro2026.php (leídos
  el 2026-11-24). El texto promulgado no se verificó en fuente abierta.
- **Mejoras a las NIF 2027: proyecto en auscultación**, fechado el
  31-ago-2026, con comentarios hasta el 30-sep-2026; propone vigencia para
  ejercicios desde el 1-ene-2027, con aplicación anticipada en 2026. El
  2026-11-24 la página de auscultación del CINIF lo seguía listando como
  proyecto y ninguna fuente abierta mostraba su promulgación: es propuesta, no
  requisito. Sección I del proyecto:
  - **NIF B-7**: cómo evaluar si lo adquirido es un negocio. Define sus
    elementos (insumos, procesos sustantivos y productos, párr. 32.1, nuevo);
    pide como mínimo un insumo y un proceso sustantivo (41.3.3); si casi todo
    el valor razonable de los activos brutos adquiridos está en un solo activo
    o grupo de activos similares, no es negocio (41.3.5), y entonces se
    reconocen activos y pasivos uno a uno, y el costo restante se reparte
    entre los activos no monetarios según sus valores razonables relativos
    (41.3.6). El párr. 49.1 precisa las fusiones entre entidades bajo control
    común (método de valor en libros).
  - **NIF D-1** (párr. 42.4.42, nuevo): anticipos de clientes en moneda
    extranjera. Por regla es partida no monetaria y queda al tipo de cambio
    histórico de la fecha de la transacción; sólo es monetaria cuando no obliga
    a entregar bienes o servicios en cantidad y características fijas y su
    precio no está garantizado, y entonces se convierte al tipo de cambio de
    cierre y la fluctuación va al estado de resultado integral.
  - **NIF D-4** (párr. 20.1 y 20.1A, nuevo): alcance. Lo que decide si un
    impuesto es a la utilidad es su base de cálculo fiscal (neta de ingresos
    menos costos y gastos), no la forma de pago ni quién lo recibe; un impuesto
    fuera de alcance se trata con NIF C-9.
  - Sección II (precisiones sin cambio contable):
    NIF A-2 Incertidumbres sobre negocio en marcha, C-8, C-9, C-19 y C-20.
  Fuentes: https://www.cinif.org.mx/uploads/Auscultacion_Mejoras_NIF_2027.pdf
  y https://www.cinif.org.mx/normatividad_nifenauscultacion.php (leídos el
  2026-11-24).
- **NIF B-4 y NIF B-6, cambios con vigencia 2028.** Van en los párrafos
  transitorios de la nueva NIF B-1 (en su proyecto, párr. 80.4 para B-4 y 80.5
  para B-6). La carta de auscultación del 31-jul-2025 propone que entren en
  vigor con las nuevas B-1 y B-3, el 1-ene-2028, con aplicación anticipada
  desde el 1-ene-2027. En B-4: remite a los requisitos de la nueva B-1 (10.2),
  presenta por separado los ajustes retrospectivos por cambios en políticas
  contables y por correcciones de errores (52.3.4), los trata como ajuste al
  saldo inicial de resultados acumulados (52.3.5) y elimina los párr. 53.1 y
  53.2. En B-6: remite también a la B-1 (10.2), amplía los criterios para
  presentar rubros adicionales por separado (52.14) y elimina los párr. 20.2,
  20.3, 52.4 y 59.3. Fuentes:
  https://www.cinif.org.mx/uploads/2025-Carta_Invitacion_Auscultacion_B1_B3.pdf
  y https://www.cinif.org.mx/uploads/NIF_B-1_proyecto_auscultacion.pdf
  (proyecto; leídos el 2026-11-24). El texto promulgado está en el libro NIF
  2026 y no se verificó en fuente abierta.
- **Qué páginas del CINIF son fuente abierta** (comprobado el 2026-11-24):
  `normatividad_listadonormas.php` (listado de normas promulgadas),
  `normatividad_plandetrabajo.php` (plan de trabajo), `exclusivo_mejoras.php`
  (Mejoras a las NIF) y `exclusivo_orientacion.php` (Orientaciones a las NIF)
  responden con una redirección HTTP 302 a `usuario_login.php?info=DENIED`,
  una pantalla que pide usuario y contraseña; el libro NIF 2026
  (`normatividad_NIF2026.php`) se consulta con usuario tras pagar una cuota.
  Una página tras login no es fuente abierta: no se cita como fuente de una
  afirmación. Las fuentes abiertas son la página de auscultación, la página
  informativa del libro y los PDF que el CINIF publica en `/uploads/`.

## Recordatorios transversales

- El registro contable sigue la NIF; el momento FISCAL (IVA acreditable al
  pago con REP en PPD, deducciones al pago para personas físicas) puede
  diferir — de ahí las cuentas puente "IVA pendiente de acreditar" / "IVA
  trasladado no cobrado" (ver mexico-cfdi).
- Sin documento soporte (CFDI, contrato, acta), un gasto es probablemente
  **no deducible** (6900) aunque contablemente sea gasto real.
- Ante la duda entre dos tratamientos: postulados, NIF A-1 cap. 20 (sustancia
  económica y devengación) → ver nif-marco.
