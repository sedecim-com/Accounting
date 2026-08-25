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
- **Ingreso por avance de obra (D-2):** requiere medir el grado de avance —
  registro solo con confirmación del usuario.

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
  (postulado de asociación de costos con ingresos, NIF A-2).

## C-5 — Pagos anticipados

Erogaciones por bienes/servicios AÚN no recibidos (seguros, rentas, licencias
pagadas por adelantado): son **activo** y se llevan a resultados conforme se
devengan. Cargo Pagos anticipados al pagar; cada mes Cargo Gasto · Abono Pagos
anticipados. Un seguro anual cargado 100% a gasto el día 1 viola A-2
(asociación); adviértelo y ofrece la tabla de devengo.

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
  (provisión mensual), no de golpe en diciembre (A-2 devengación).
- **PTU**: 10% de la renta gravable; la causada del ejercicio se provisiona
  contra resultados del mismo ejercicio.
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

## Recordatorios transversales

- El registro contable sigue la NIF; el momento FISCAL (IVA acreditable al
  pago con REP en PPD, deducciones al pago para personas físicas) puede
  diferir — de ahí las cuentas puente "IVA pendiente de acreditar" / "IVA
  trasladado no cobrado" (ver mexico-cfdi).
- Sin documento soporte (CFDI, contrato, acta), un gasto es probablemente
  **no deducible** (6900) aunque contablemente sea gasto real.
- Ante la duda entre dos tratamientos: postulados de A-2 (sustancia económica
  y devengación) → ver nif-marco.
