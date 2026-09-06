# Motores contables

Qué motor existe para cada jurisdicción, con qué huecos, y cuál no existe bajo ningún nombre. La fuente es el inventario verificado del 2026-09-06 —nueve lectores de código y nueve escépticos con la instrucción de refutar—: [`motores-inventario.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/investigacion/2026-09-06-normas-y-motores/motores-inventario.md), con un informe largo por subsistema en [`motores/`](https://github.com/sedecim-com/Accounting/tree/main/docs/investigacion/2026-09-06-normas-y-motores/motores). Esta página es el resumen; las tablas con `archivo:línea` están allí.

## Cómo se lee el inventario

Cuatro estados: **completo** (existe, tiene puerta y hace lo que dice), **parcial** (existe con huecos nombrados), **inerte** (existe sin puerta, o con puerta y sin escribir nada) y **ausente** (se buscó por grep bajo otros nombres y no está). Y para cada motor, dónde vive el número que usa: en una **tabla de ley**, en el **panel** del despacho, como **constante de la casa**, o **quemado** en código cuando debería estar en uno de los dos primeros.

## Lo que está completo

El núcleo: partida doble y posteo por una sola puerta, las siete reglas de validación, reversión y anulación, arrastre de saldos, integridad del mayor, conversión FX. El CFDI de punta a punta: analizador, hechos, taxonomía, decisiones de deducibilidad con cita de ley, clasificador y plan de posteo; el IVA sobre base de flujo y la ligadura del REP; la consulta de estatus ante el SAT; la custodia de e.firma en bóveda. La nómina mexicana (ISR, subsidio, IMSS, INFONAVIT, finiquito, aguinaldo, vacaciones, CFDI N, SUA, IDSE) y la estadounidense (FIT, FICA, Medicare, FUTA, SUTA, 51 estados, SDI, 941/940/W-2/W-3/EFW2, NACHA, beneficios). Conciliación bancaria con cotejo, sesiones y partidas conciliatorias. Los ciclos de clientes y proveedores con sus controles auxiliares.

## Lo que está parcial, y por qué importa

- **El calendario** es siempre el año natural: el mes de inicio del ejercicio existe en el esquema y nadie lo lee; el periodo 13 está admitido y nunca se crea; nadie escribe `closed` ni `locked`.
- **El cierre** no pregunta la jurisdicción (cuenta faltantes de REP en toda entidad), tiene severidades fijas y una política cuyo texto promete gobernar el checklist y no lo gobierna.
- **El catálogo** de Estados Unidos es un marcador neutro; el agrupador SAT tiene dos columnas y una está huérfana.
- **Los informes** no tienen balance clasificado, ORI, cambios en el capital, notas ni comparativos — en ninguna de las dos jurisdicciones; la balanza no proyecta saldo inicial ni naturaleza aunque el dato existe por cuenta.
- **La moneda extranjera** sólo llega a pagos a proveedores: una factura a cliente en moneda no funcional se **rechaza**; la remedición al cierre (NIF B-15 / ASC 830) no existe.
- **La nómina de Estados Unidos** calcula bien y **declara ceros**: los formularios 941 y 940 suman una tabla que nadie escribe, los impuestos locales no se persisten (la casilla 19 del W-2 sale en cero) y una orden de embargo porcentual retiene cero porque el motor y el esquema usan vocabularios distintos.
- **La nómina mexicana** sólo tiene puerta REST —ni CLI ni herramientas del agente— y, sin fila del año en `tax_parameters`, el IMSS y el INFONAVIT calculan cero en silencio.

## Lo que está ausente

**En ambas jurisdicciones:** pasivos devengados, ingreso diferido calendarizado, diferencia cambiaria no realizada, estimación de incobrables (NIF C-16 / ASC 326), inventarios, intangibles, deterioro, baja de activos, arrendamientos (que además quedaron fuera del propio censo), provisión de impuesto a la utilidad (NIF D-4 / ASC 740), calendario de obligaciones, retención de registros, reexpresión retrospectiva.

**Sólo México:** contabilidad electrónica del Anexo 24, DIOT, retenciones al registrar o emitir (honorarios, arrendamiento, IVA 2/3), acreditamiento proporcional, determinación mensual del IVA y pagos provisionales, PTU, ISN, exentos del art. 93, ajuste anual del art. 97, descarga masiva del SAT, cancelación con acuse, sellado propio del CFDI, actualización por INPC.

**Sólo Estados Unidos:** catálogo fiscal propio, *sales & use tax*, 1099-NEC/MISC/K, W-9 y *backup withholding*, impuesto de la entidad (1120/1065) y su provisión, deducibilidad del IRC, MACRS más allá de *half-year* (§179, *bonus*), calendario de depósitos, FLSA, credenciales del IRS.

## Lo transversal

Casi todo lo que existe es **mexicano en semántica y universal en código**: los motores no preguntan la jurisdicción. La ley vive en tablas por año o quemada en código. El panel gobierna criterio pero no sabe de países. Las tres cosas tienen un mismo remedio y un mismo orden: [[Jurisdicciones]].

## Para seguir

- [[Jurisdicciones]] — el diseño que ordena lo anterior.
- [[Hoja-de-ruta]] — qué va antes de qué.
- [[Auditorias]] — de dónde salen los rojos.
