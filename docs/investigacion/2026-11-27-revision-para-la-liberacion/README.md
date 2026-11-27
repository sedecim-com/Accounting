# Revisión para la liberación · 2026-11-27

**Qué se pidió y quién lo pidió.** El dueño, el 27 de noviembre de 2026, en la sesión del coordinador: «Revisa los issues ye integra todo lo de la versión 1.0 al MVP. Revisa todo el código creado, y revisa todas las normas contables y fiscales que debe de llevar un sistema core contable como este. Y una vez armonizado, traza una ruta para llegar a la liberación del sistema y ejecuta la.» Sus tres mensajes de ese día están transcritos en la issue #329 (comentario 7210598786) y registrados en el backlog como MNE-001-860.

**Sobre qué árbol.** `develop` en `e9a327d0`, el 27 de noviembre de 2026. Siete revisores, cada uno con un dominio, leyeron el código, el corpus y el backlog sin escribir nada en el repositorio. Cada informe dice en su última sección qué no revisó y qué no ejecutó, y marca «to verify» o «tv» la norma que citó de memoria y no contra su texto oficial.

**Lo que pasó después de las revisiones.** El mismo día, cuando los informes ya estaban escritos, el dueño desaparcó todo para la 1.0 («Para el 1.0 desaparca lo aparcado»). Por eso una frase de estos informes o de los cuerpos de las issues que diga que una tarea de Estados Unidos «está aparcada por D-03», o que algo «se queda en la ola 4», es historia: los informes son evidencia fechada y se dejan como se escribieron. El estado de hoy se pregunta a `docs/backlog/PRD-001.md`.

**Las dos revisiones de Estados Unidos.** Corrieron después del tercer mensaje del dueño, «Para el 1.0 desaparca lo aparcado», que metió a Estados Unidos en la liberación: dos revisores más leyeron el mismo árbol, `develop` en `e9a327d0`, uno la nómina de Estados Unidos y sus impuestos (informe 08) y otro la contabilidad, los informes y los impuestos de Estados Unidos fuera de la nómina, con el interruptor de jurisdicción (informe 09). Sus 22 tareas son las MNE-001-976 a MNE-001-997, que el backlog registró en el PR de historial siguiente al de la armonización, con una issue nueva, #1084, y tres adendas a issues que ya existían (#124, #123 y #131). El informe 09 leyó el backlog antes de la armonización, cuando tenía 854 tareas. Donde un informe abrevia una propuesta (U4, P12), el número es el de la tabla «Del hallazgo a la tarea».

**Idioma.** Los informes y los cuerpos de las issues están en inglés, como las issues del repositorio; este índice y el párrafo «Para el dueño» de cada issue están en español. Son registro fechado (D1 de `docs/language.md`, enmendada el 2026-11-16) y entran sin gemela española a la línea base de `language:status`, como pide su regla 8 mientras la MNE-001-213 no los saque de esa cuenta.

## Los siete informes

| Informe | Dominio |
|---|---|
| [`01-ledger-statements.md`](01-ledger-statements.md) | El mayor y los estados financieros |
| [`02-measurement-engines.md`](02-measurement-engines.md) | Los motores de medición (NIF series C y D) |
| [`03-cfdi-econtabilidad.md`](03-cfdi-econtabilidad.md) | El CFDI y la contabilidad electrónica |
| [`04-impuestos.md`](04-impuestos.md) | Los impuestos que los libros calculan y sostienen |
| [`05-nomina.md`](05-nomina.md) | La nómina mexicana, la seguridad social y sus obligaciones |
| [`06-subledgers-controls.md`](06-subledgers-controls.md) | Los auxiliares y los controles internos |
| [`07-backlog-release.md`](07-backlog-release.md) | El backlog y la mecánica de la liberación |

## Los dos informes de Estados Unidos

| Informe | Dominio |
|---|---|
| [`08-us-payroll.md`](08-us-payroll.md) | La nómina de Estados Unidos y sus impuestos |
| [`09-us-accounting.md`](09-us-accounting.md) | La contabilidad, los informes y los impuestos de Estados Unidos fuera de la nómina, y el interruptor de jurisdicción |

## Cómo leer las clases

Cada hueco lleva una clase:

| Clase | Qué significa | Qué se hizo con ella |
|---|---|---|
| **R** | Bloquea una liberación para uso real: una cifra mal, un archivo que el SAT rechaza, un deber legal sin cumplir o una pérdida de datos | Tarea Must de la ola 3 |
| **R·v1.0** (informe 03) y **R-pac** (informe 07) | Bloquea sólo la parte de la liberación que timbra | Tarea Should de la ola 3 |
| **S** | Debería ir en la liberación | Tarea Should de la ola 3 |
| **C** | Puede esperar | En general sin tarea nueva: queda listado en «Out of scope / later» de su issue. Las pocas que el coordinador asignó de todos modos son Should |
| **N** | Fuera por una decisión del dueño, que el informe nombra | Sin tarea nueva |

Donde dos tratamientos contables aceptados difieren, la tarea lleva una clave del panel con el valor conservador por omisión (ADR-0006), y lo dice su aceptación. Una ley, una tasa o una fecha que el corpus del repositorio no trae va marcada «por verificar contra el texto oficial», y la tarea empieza por traer ese texto.

## Las issues nuevas

El cuerpo completo de cada una está en [`issues/`](issues/); la issue de GitHub lleva un cuerpo corto que apunta aquí.

| Issue | Cuerpo | Título |
|---|---|---|
| #1066 | [`issues/a-ledger-cents-and-foreign-currency.md`](issues/a-ledger-cents-and-foreign-currency.md) | Ledger: pesos to the cent, and foreign currency on hand entries and on every monetary account |
| #1067 | [`issues/b-statements.md`](issues/b-statements.md) | Statements: the NIF B-3 structure, changes in equity, comparatives, cash-flow presentation and the tie-out between statements |
| #1068 | [`issues/c-period-controls.md`](issues/c-period-controls.md) | Period controls: close by role, soft close, the annual seal's gates, the void date and a hand entry's vouchers |
| #1069 | [`issues/d-fixed-assets.md`](issues/d-fixed-assets.md) | Fixed assets: disposal, correction, units of production, classes, two schedules and the register's tie-out |
| #1070 | [`issues/f1-receivables-write-off-and-allowance.md`](issues/f1-receivables-write-off-and-allowance.md) | Receivables: write-off and the expected credit loss allowance (NIF C-3, C-16) |
| #1071 | [`issues/f2-inventories.md`](issues/f2-inventories.md) | Inventories: the honest minimum, and the decision on a cost engine |
| #1072 | [`issues/f3-leases.md`](issues/f3-leases.md) | Leases (NIF D-5): contract, right of use, liability and the close |
| #1073 | [`issues/g-received-cfdi-currency-and-relations.md`](issues/g-received-cfdi-currency-and-relations.md) | Received CFDI: a foreign-currency document posted at face value, and several CfdiRelacionados nodes read as none |
| #1074 | [`issues/g2-credit-notes-by-ingestion.md`](issues/g2-credit-notes-by-ingestion.md) | Credit notes by ingestion: an issued type E, a note over several bills or a paid bill, and the vendor advance (relation 07) |
| #1075 | [`issues/h-iva-not-creditable.md`](issues/h-iva-not-creditable.md) | IVA that must not be credited yet or at all: cash over the limit, restaurants, IVA withheld to suppliers, and the DIOT boxes that declare it |
| #1076 | [`issues/i1-payroll-wrong-figures.md`](issues/i1-payroll-wrong-figures.md) | Payroll: figures that are wrong today (the minimum-wage worker, the INFONAVIT credit, the class IV premium, the employer's risk premium, the subsidy ceiling, rounding by branch) |
| #1077 | [`issues/i2-payroll-real-payroll.md`](issues/i2-payroll-real-payroll.md) | Payroll: what a real payroll needs (SBC, incidences, the art. 93 exemptions, deductions, the annual adjustment, the settlement, the employee from the terminal, ISN and wages payable in the ledger) |
| #1078 | [`issues/m-migration-opening.md`](issues/m-migration-opening.md) | Migration: what the opening loses (the receivables' IVA, the foreign-currency origin, the prior system's files) |
| #1079 | [`issues/j-payables-and-payments.md`](issues/j-payables-and-payments.md) | Payables and payments: void an approved bill, the duplicate guard, the reversal guard on a document's entry, and a REP whose form moves no bank |
| #1080 | [`issues/k-first-release.md`](issues/k-first-release.md) | [REL] The first release: promotion, version, install, upgrade, evidence |

### La issue y las adendas de Estados Unidos

El informe 08 propuso una issue nueva y el 09 ninguna: sus tareas cuelgan de tres issues que ya existían, y cada una lleva una adenda en la plantilla de la casa.

| Issue | Cuerpo | Título |
|---|---|---|
| #1084 | [`issues/us08-us-payroll-forms.md`](issues/us08-us-payroll-forms.md) | US payroll: forms 941, 940, W-2/W-3 and EFW2 follow their instructions, and the employer liability is recorded |
| #124 (adenda) | [`issues/addendum-124.md`](issues/addendum-124.md) | United States outside payroll: four wrong figures to stop, and the pieces the J1 index did not name |
| #123 (adenda) | [`issues/addendum-123.md`](issues/addendum-123.md) | What the switch still does not reach for a United States entity |
| #131 (adenda) | [`issues/addendum-131.md`](issues/addendum-131.md) | Until the US GAAP corpus exists, the agent says so |

## Del hallazgo a la tarea

Las 116 entradas que este trabajo registró en `docs/backlog/PRD-001.json`, en el orden de sus ids. «Número» es el que la propuesta lleva en la sección de tareas propuestas de su informe (P, N, T o R según el informe; DEC es una decisión del dueño); el hallazgo que la origina (G01, V-11, I-7…) lo nombra la aceptación de cada tarea. Las 22 últimas filas, de los informes 08 y 09 (número U), son las tareas de Estados Unidos, MNE-001-976 a MNE-001-997, que se registraron después, con las dos revisiones de Estados Unidos. La última fila, MNE-001-999, no sale de un informe: es lo que el constructor de la MNE-001-895 (informe 03, issue #1073) encontró y dejó ese mismo día, y cierra los ids de tres dígitos.

| Informe | Número | Tarea | Título |
|---|---|---|---|
| 07 | DEC27 | MNE-001-860 | Decisión: lo de la versión 1.0 se integra al MVP, lo aparcado se desaparca y la ola 3 pasa a ser la liberación 1.0 |
| 07 | R14 | MNE-001-861 | El id de una tarea admite cuatro dígitos |
| 01 | P1 | MNE-001-862 | El importe en moneda funcional se guarda a la unidad mínima de su moneda: la conversión redondea al centavo, la cuenta de control conserva su origen y una póliza con fracción de centavo se niega |
| 01 | P2 | MNE-001-863 | Un censo nombra cada cuenta con fracción de centavo ya posteada, y una persona la corrige con una póliza de ajuste revisada |
| 01 | P3 | MNE-001-864 | Una póliza manual lleva su origen en moneda extranjera: entry create, entry import y POST /v1/journal-entries aceptan moneda, importe de origen y tipo de cambio por renglón |
| 01 | P4 | MNE-001-865 | La apertura carga con su origen los saldos en otra divisa: bancos, clientes y proveedores entran con importe de origen y tipo de cambio |
| 01 | P5 | MNE-001-866 | La revaluación del cierre alcanza toda cuenta monetaria en moneda extranjera que el despacho marque, y nombra la que está en divisa y nadie marcó |
| 01 | P6 | MNE-001-867 | El cierre anual localiza por rol el resumen de resultados, el resultado del ejercicio y los resultados acumulados, no por los códigos 3900, 3300 y 3200 |
| 01 | P8 | MNE-001-868 | Una clave del panel dice qué se puede postear en un periodo en cierre suave; por omisión, sólo ajustes y motores |
| 01 | P9 | MNE-001-869 | El sello del ejercicio espera la revaluación y los devengos del año, y las atestaciones firmadas de negocio en marcha, hechos posteriores y entorno inflacionario |
| 01 | P10 | MNE-001-870 | El estado de resultado integral sale con los niveles de la NIF B-3 y su ORI, por función o por naturaleza según el panel |
| 01 | P12 | MNE-001-871 | El estado de cambios en el capital contable (NIF B-4) sale por componente y amarra con el balance |
| 01 | P13 | MNE-001-872 | Los estados financieros llevan la columna comparativa del periodo anterior |
| 01 | P14 | MNE-001-873 | El flujo de efectivo presenta la deuda de corto plazo en financiamiento y el efecto cambiario sobre el efectivo en su renglón |
| 01 | P15 | MNE-001-874 | Un comando y un criterio ▶ amarran los estados entre sí y salen distintos de cero cuando uno no casa |
| 01 | P16 | MNE-001-875 | Una póliza manual liga sus comprobantes con entry support, y el XML de pólizas los declara |
| 01 | P18 | MNE-001-876 | entry void fecha su espejo con el día de la entidad y acepta --date, como entry reverse |
| 01 | P17 | MNE-001-877 | Decisión: la balanza del primer mes tras una migración, ¿declara la apertura como movimiento del mes o como saldo inicial? |
| 02 | N01 | MNE-001-878 | El pago de aguinaldo, vacaciones y prima vacacional en una corrida consume su provisión (2202 a 2204) antes de cargar gasto |
| 02 | N02 | MNE-001-879 | Baja de un activo: asset dispose registra el retiro o la venta, deja su póliza con la utilidad o la pérdida como borrador y el activo deja de depreciarse |
| 02 | N03 | MNE-001-880 | asset edit corrige un activo que aún no tiene renglones posteados, y asset retire detiene uno que no debe depreciarse, cada uno con su fila de auditoría |
| 02 | N04 | MNE-001-881 | Un activo por unidades de producción se rehúsa en el alta mientras no exista la captura de producción, y uno ya registrado deja de detener closing run |
| 02 | N05 | MNE-001-882 | Castigo de una cuenta por cobrar: invoice write-off deja su póliza como borrador, la factura pasa a uncollectible y --reverse la reinstala |
| 02 | N06 | MNE-001-883 | Estimación para pérdidas crediticias esperadas: allowance calculate propone como borrador el ajuste de la 1129 desde la antigüedad a la fecha, con su cédula |
| 02 | N07 | MNE-001-884 | Inventarios, lo mínimo honesto: el panel y el manual dicen que no hay motor de costo, el cierre anual propone el ajuste al inventario contado y el checklist avisa de una 1140 sin salidas |
| 02 | N09 | MNE-001-885 | La depreciación guarda los dos calendarios: el que rige postea, el otro queda sin postear, y asset book diff da la diferencia por activo |
| 02 | N10 | MNE-001-886 | El registro de activos casa con el mayor: depreciación acumulada de apertura en el alta, asset list y asset show, y asset reconcile contra sus cuentas de control |
| 02 | N11 | MNE-001-887 | Clases de activo fuera del art. 34: asset category create da de alta intangibles, mejoras y terrenos con sus cuentas y su vida, y el mismo motor los amortiza |
| 02 | N12 | MNE-001-888 | Terminar antes de tiempo un anticipado o un ingreso diferido: prepaid cancel y deferred-revenue cancel dejan el remanente como borrador y detienen el calendario |
| 02 | N13 | MNE-001-889 | La PTU al cierre admite la cifra con el tope del art. 127 fr. VIII capturada con su fuente, y el borrador dice cuál usó |
| 02 | N16 | MNE-001-890 | Arrendamientos (NIF D-5): un contrato con su calendario reconoce el derecho de uso y el pasivo, y el cierre postea el interés y la depreciación |
| 02 | N17 | MNE-001-891 | Manuales: nif-registro.md y nif-validaciones.md dicen la verdad de los motores, y la tabla gana una fila por norma sin motor |
| 02 | N18 | MNE-001-892 | Registro de normas NIF legible por máquina y la matriz norma → motor → comando → criterio, con --check en CI |
| 02 | DEC1 | MNE-001-893 | Decisión: ¿entra a la liberación un motor de inventarios y costo de ventas (RF-06 del PRD-003), o el sistema declara que no lo lleva? |
| 03 | N1 | MNE-001-894 | Un CFDI recibido en moneda extranjera se niega nombrando la moneda en cada puerta que lo contabiliza, y después se contabiliza convertido con sus columnas de divisa |
| 03 | N2 | MNE-001-895 | El parser lee todos los nodos CfdiRelacionados de un CFDI 4.0, y las dos puertas de un CFDI emitido se niegan ante un anticipo aplicado o una sustitución |
| 03 | N3 | MNE-001-896 | El XML de pólizas declara el CFDI de una nota de crédito recibida y los de la nómina, lleva TipCamb, y una póliza con CFDI en su origen y sin CompNal sale con su hallazgo |
| 03 | N4 | MNE-001-897 | Una nota de crédito emitida (CFDI tipo E) que llega por la ingesta se registra por la puerta de notas de crédito de CxC, ligada a su factura y con su UUID |
| 03 | N5 | MNE-001-898 | Una nota de crédito recibida sobre varias facturas o sobre una ya pagada, y la aplicación de un anticipo a proveedor (TipoRelacion 07), tienen puerta |
| 03 | N6 | MNE-001-899 | Las solicitudes de cancelación en proceso de un CFDI recibido se nombran con su plazo en ap check |
| 03 | N8 | MNE-001-900 | Normas: el corpus del agente lleva las reglas de la RMF sobre contabilidad electrónica, cancelación de CFDI y plazo del REP, con su fuente |
| 03 | N9 | MNE-001-901 | El XML timbrado y el acuse de cancelación se guardan por bytes, con su hash, junto al documento |
| 03 | N10 | MNE-001-902 | cfdi stamp y cfdi cancel: las hojas del CLI que timbran y cancelan una factura por el enrutador, cerradas al agente |
| 03 | N11 | MNE-001-903 | El CFDI de ingreso lleva Serie, descuentos, retenciones e IEPS, y el receptor público en general o extranjero, o la puerta se niega nombrando el dato |
| 03 | N12 | MNE-001-904 | El CFDI de egreso de una nota de crédito de CxC se construye con sus CfdiRelacionados y se timbra una sola vez |
| 03 | N13 | MNE-001-905 | Los nombres de archivo y el .zip del Anexo 24 se verifican contra el texto del SAT, y las marcas NO VERIFICADO desaparecen |
| 04 | N1 | MNE-001-906 | El efectivo sobre el límite contestado como no deducible en la ingesta lleva su IVA al gasto no deducible, y no a 1135 |
| 04 | N2 | MNE-001-907 | Un censo que no escribe nombra las facturas contabilizadas como no deducibles cuyo IVA quedó en 1135 o 1130, y una póliza auditada corrige cada una |
| 04 | N3 | MNE-001-908 | Un consumo en restaurante bajo split_85 parte el gasto en su parte deducible y su parte no deducible, con su IVA en la misma proporción |
| 04 | N4 | MNE-001-909 | El IVA retenido a un proveedor se acredita hasta el mes siguiente a su entero: el papel del IVA lo separa del IVA pagado |
| 04 | N5 | MNE-001-910 | Las retenciones por enterar del mes se leen también de lo efectivamente pagado, y el papel nombra lo retenido en facturas sin pagar |
| 04 | N6 | MNE-001-911 | Papel de trabajo de retenciones: el ISR retenido por honorarios, arrendamiento, RESICO y salarios y el IVA retenido, por mes y por concepto |
| 04 | N7 | MNE-001-912 | filing record guarda un pago provisional de ISR presentado, y el papel del ISR lee de ahí los pagos anteriores del ejercicio |
| 04 | N8 | MNE-001-913 | Un coeficiente de utilidad en cero no se usa: el papel del ISR toma el último coeficiente de hasta cinco años y annual figure record niega el cero |
| 04 | N9 | MNE-001-914 | El papel del ISR suma a los ingresos nominales los anticipos de clientes cobrados, por su base y con su traza |
| 04 | N10 | MNE-001-915 | La póliza mensual de impuestos como borrador: la determinación del IVA y el pago de IVA, ISR provisional y retenciones, con sus roles |
| 04 | N11 | MNE-001-916 | El calendario fiscal topa la inversión en automóviles (LISR art. 36 fr. II) y conoce los por cientos de los arts. 34 y 35 que faltan |
| 04 | N12 | MNE-001-917 | La deducción de inversiones del ejercicio se actualiza por INPC (LISR art. 31) en una cédula que lee el calendario fiscal |
| 04 | N13 | MNE-001-918 | El archivo de la DIOT declara el IVA no acreditable y la proporción, en vez de callarlo o negarse |
| 04 | N14 | MNE-001-919 | Semilla: las retenciones del RLIVA, la retención de RESICO y el tope de separación quedan con su texto oficial abierto y anotado en el corpus |
| 04 | N15 | MNE-001-920 | El ajuste anual por inflación (LISR arts. 44 a 46) sale de los saldos promedio del mayor, como cédula del papel anual |
| 04 | N16 | MNE-001-921 | Las pérdidas fiscales pendientes se guardan por ejercicio de origen, con su actualización y su vigencia, y el papel del ISR las aplica de la más antigua a la más nueva |
| 04 | N19 | MNE-001-922 | Decisión: la región fronteriza (IVA al 8 %), ¿entra a la liberación o se niega por escrito? |
| 05 | N1 | MNE-001-923 | Quien sólo gana el salario mínimo de su zona no sufre retención de ISR, y el recibo dice por qué |
| 05 | N2 | MNE-001-924 | El patrón absorbe la cuota obrera del IMSS de quien cotiza con el salario mínimo: recibo, pasivo, póliza, SUA y CFDI |
| 05 | N3 | MNE-001-925 | El descuento del crédito INFONAVIT sale de la ley: veces en UMI, cuota fija y porcentaje por los días del bimestre, con seguro de daños y tope del salario mínimo |
| 05 | N4 | MNE-001-926 | La prima media de la clase IV de riesgo de trabajo vale lo que dice la LSS, con el censo de los recibos que usaron la sembrada |
| 05 | N5 | MNE-001-927 | La prima de riesgo de trabajo es la del registro patronal, con vigencia, y sin ella la corrida se niega |
| 05 | N7 | MNE-001-928 | El CFDI de nómina entero valida contra nomina12.xsd, sin datos genéricos ni atributos vacíos |
| 05 | N10a | MNE-001-929 | imss sua export deja de llamar a su salida el archivo de importación del SUA: es una cédula de cotejo hasta que exista el layout oficial |
| 05 | N10b | MNE-001-930 | imss sua export entrega el layout oficial de importación del SUA, versionado en el repositorio con su fuente |
| 05 | N8 | MNE-001-931 | CFDI de nómina: la clave SAT de cada percepción sale de su tipo, y los nodos HorasExtra, Incapacidades y SeparacionIndemnizacion existen cuando su clave los exige |
| 05 | N9 | MNE-001-932 | payslip stamp: el CFDI de nómina se timbra desde la terminal, una vez, con ensayo |
| 05 | N11 | MNE-001-933 | Movimientos afiliatorios en el layout oficial del IDSE: alta, baja y modificación de salario nacen del cambio del empleado, con su plazo y su hoja de CLI |
| 05 | N12 | MNE-001-934 | Ajuste anual del ISR de sueldos: el cálculo por trabajador y la corrida que retiene o devuelve la diferencia |
| 05 | N13 | MNE-001-935 | El SBC se calcula con el factor de integración, piso de un salario mínimo y tope de 25 UMA, y se guarda con historial fechado |
| 05 | N14 | MNE-001-936 | Incidencias del periodo: faltas e incapacidades con sus días reducen el sueldo y los días cotizados, y la corrida recibe sus insumos |
| 05 | N15 | MNE-001-937 | Las exenciones del art. 93 que faltan: prima dominical, PTU, descanso trabajado y previsión social con su tope |
| 05 | N16 | MNE-001-938 | Liquidación: indemnización de tres meses y veinte días por año, y el finiquito guardado como corrida final con recibo, póliza y hoja de CLI |
| 05 | N17 | MNE-001-939 | Empleado desde la terminal: baja, cambio de sueldo, de clase de riesgo y de crédito INFONAVIT, con motivo y fila de auditoría |
| 05 | N18 | MNE-001-940 | Descuentos del recibo mexicano: FONACOT y cuota sindical con su clave, y los topes de la LFT como parámetros fechados; un neto negativo se niega |
| 05 | N19 | MNE-001-941 | La póliza de nómina lleva el ISN a gasto y a su pasivo, y los sueldos por pagar al devengarse |
| 05 | N20 | MNE-001-942 | Subsidio al empleo: el tope mensual entre los pagos del mes y la base de elegibilidad de un periodo menor al mes |
| 05 | N21 | MNE-001-943 | PTU: el reparto por trabajador, su corrida y la exención de 15 UMA |
| 05 | N22 | MNE-001-944 | Los ingresos exentos pagados a trabajadores y su parte no deducible, por ejercicio, salen de los recibos |
| 05 | N23 | MNE-001-945 | Las cuotas del IMSS y del INFONAVIT se calculan en Decimal y se redondean por ramo como la cédula del SUA |
| 06 | T1 | MNE-001-946 | Documentos abiertos de CxC en la migración: cada factura lleva su tasa de IVA, y cobrarla libera su parte de 2125 a 2120 |
| 06 | T2 | MNE-001-947 | bill void: un gasto aprobado se anula con su póliza espejo, su IVA de 1135 y su fila de auditoría, y se niega con pagos vivos |
| 06 | T3 | MNE-001-948 | Un REP cuya forma de pago no mueve banco queda en revisión, y el que sí lo mueve nombra la cuenta propia en vez del rol banco |
| 06 | T4 | MNE-001-949 | Con la segregación exigida, quien capturó un gasto o una factura manual no lo aprueba ni la emite, y quien cargó la apertura en borrador no la postea |
| 06 | T5 | MNE-001-950 | Dos claves del panel para el cierre: conciliación bancaria faltante y periodo anterior sin cerrar, con valor por omisión que bloquea |
| 06 | T6 | MNE-001-951 | period lock sella un periodo ya declarado, y period reopen nombra la declaración registrada, los artefactos del Anexo 24 y el expediente antes de reabrir |
| 06 | T7 | MNE-001-952 | entry reverse y entry void se niegan sobre la póliza de un documento y nombran el comando del documento |
| 06 | T8 | MNE-001-953 | Un gasto de proveedor no entra dos veces: bill create se niega ante el mismo folio del mismo proveedor, y ap check gana la sonda duplicate-bill |
| 06 | T9 | MNE-001-954 | La carga del catálogo y de la apertura guarda la huella sha256 y los bytes de su archivo, como los paquetes del SAT |
| 06 | T10 | MNE-001-955 | Moneda extranjera en los auxiliares: el pago por una cuenta en otra moneda, la nota de crédito y el saldo a cuenta dejan de negarse |
| 06 | T11 | MNE-001-956 | account role set avisa o se niega cuando la cuenta que deja el rol tiene saldo o documentos abiertos |
| 06 | T12 | MNE-001-957 | El checklist del cierre gana las casillas de revaluación cambiaria y de provisiones, para quien cierra sin closing run |
| 06 | T13 | MNE-001-958 | bank reconciling-item correct y assign dejan su fila de auditoría |
| 06 | T14 | MNE-001-959 | Tarjeta de débito: vendor_payments la admite, el REP recibido con forma 28 la guarda, y el código c_MetPagos de su póliza lo elige el panel |
| 06 | T15 | MNE-001-960 | Compensación entre lo que un tercero debe y lo que se le debe, como documento que salda los dos auxiliares sin mover el banco |
| 06 | T16 | MNE-001-961 | Corpus: los deberes de registro y de conservación de la contabilidad (CFF 28 y 30, RCFF 33, Código de Comercio 38), con su fuente |
| 06 | T17 | MNE-001-962 | El efectivo sobre el límite de la LISR 27-III se mide por operación o por pago, según el panel, igual en la ingesta y en la puerta de pagos |
| 07 | R1 | MNE-001-963 | La primera liberación se corta como dice el ADR-0008: release desde develop, main desde release, con su tag y su lista de comprobación |
| 07 | R2 | MNE-001-964 | Decisión: ¿cómo entra un arreglo urgente a main después de la primera liberación? |
| 07 | R3 | MNE-001-965 | El historial cuenta los PR que entraron a develop, y una fusión de release a main no lo deja sin mirar |
| 07 | R4 | MNE-001-966 | La versión tiene una sola regla: SemVer en package.json, igual al tag, y el paquete declara su licencia |
| 07 | R5 | MNE-001-967 | Las notas de la versión 1.0 dicen qué hace el sistema, qué no hace todavía y qué mantenimiento con fecha le espera |
| 07 | R6 | MNE-001-968 | Un despacho instala una versión etiquetada en su equipo, en modo de producción, siguiendo una sola página |
| 07 | R7 | MNE-001-969 | La bóveda de producción vive en el equipo del despacho, cifrada y con la llave fuera del directorio de datos (D-06) |
| 07 | R8 | MNE-001-970 | El binario construido arranca antes de liberar: npm run build, la versión, doctor y una lectura contra una base recién migrada |
| 07 | R9 | MNE-001-971 | Actualizar una instalación a una versión nueva tiene su página: respaldo, tag, build, migrate y doctor |
| 07 | R10 | MNE-001-972 | Una base migrada hasta el corte anterior, con datos, sube a la punta sin perder nada, probado en la suite de integración |
| 07 | R11 | MNE-001-973 | El candidato a liberación deja su evidencia en un solo lugar: el mes, el tablero, la restauración, el aislamiento y el binario sobre el commit que se etiqueta |
| 07 | R12 | MNE-001-974 | E3.2 entra a --exigir: está en verde y la CI todavía no lo protege |
| 07 | R13 | MNE-001-975 | Antes del tag hay una pasada de seguridad sobre el candidato y un dictamen del dueño por cada issue reservada |
| 08 | U1 | MNE-001-976 | El impuesto federal de un recibo de EE. UU. sigue la hoja 1A de la Pub 15-T: línea 1g, casilla del paso 2 y W-4 validado |
| 08 | U2 | MNE-001-977 | Un pago suplementario de EE. UU. retiene por el método que el panel eligió |
| 08 | U3 | MNE-001-978 | Los topes anuales de EE. UU. cuentan todo lo pagado hasta la fecha de pago, también la otra corrida del mismo día |
| 08 | U4 | MNE-001-979 | Al aprobar una corrida de EE. UU. se apunta el pasivo federal, FUTA y estatal con su fecha de depósito, y el depósito se registra |
| 08 | U5 | MNE-001-980 | La forma 941 cuadra renglón por renglón con sus instrucciones |
| 08 | U6 | MNE-001-981 | La forma 940 separa lo exento y lo que pasa de 7,000, y el FUTA conoce la reducción de crédito |
| 08 | U7 | MNE-001-982 | El W-2 llena sus casillas 12 a 20 como dicen sus instrucciones y el W-3 se niega si no cuadra |
| 08 | U8 | MNE-001-983 | El archivo EFW2 se niega hasta seguir la especificación de la SSA, y el corpus dice lo que la nómina de EE. UU. hace hoy |
| 08 | U9 | MNE-001-984 | Un acreedor ordinario no cobra por encima de la pensión alimenticia, y una orden se detiene en lo que se debe |
| 08 | U10 | MNE-001-985 | California y Nueva York retienen por el método de su agencia, con su certificado, y el SDI de Nueva York respeta su tope |
| 08 | U11 | MNE-001-986 | La tasa de SUTA es la que el estado asignó al patrón, por entidad, estado y año |
| 08 | U12 | MNE-001-987 | Las elecciones de prestaciones llegan al recibo con su límite anual, y la aportación del patrón llega a la póliza |
| 09 | U1 | MNE-001-988 | En una entidad de Estados Unidos el impuesto sobre ventas pagado en una compra entra al costo del renglón, no a una cuenta acreditable |
| 09 | U2 | MNE-001-989 | MACRS deprecia por ejercicio fiscal con la clase del activo escrita, y se niega sin ella |
| 09 | U3 | MNE-001-990 | Una entidad de Estados Unidos nace con sus clases de activo, y asset category seed se niega a sembrarle las de la LISR |
| 09 | U4 | MNE-001-991 | El 1099-NEC tiene puerta: el proveedor guarda su W-9 con el TIN de una persona física, y vendor 1099 genera, lista y marca presentado |
| 09 | U5 | MNE-001-992 | Cada pago a un proveedor 1099 lleva su casilla: el NEC sólo suma servicios, el 1099-MISC sale con rentas y otros ingresos, y el pago sin TIN avisa |
| 09 | U6 | MNE-001-993 | El agente dice la verdad sobre una entidad con libros US GAAP mientras su corpus no exista |
| 09 | U7 | MNE-001-994 | La puerta de la entidad de Estados Unidos: tipo, clasificación fiscal federal y estados, en entity create y entity edit |
| 09 | U8 | MNE-001-995 | El checklist del cierre y los comandos de ley mexicana preguntan la jurisdicción de la entidad |
| 09 | U9 | MNE-001-996 | Sales tax 2/2: las cifras de la declaración por estado, el cliente exento y el use tax devengado |
| 09 | U10 | MNE-001-997 | closing fx revalue remide los saldos en moneda extranjera de una entidad con moneda funcional USD |
| — | — | MNE-001-999 | Un CFDI recibido de ingreso que sustituye a otro (TipoRelacion 04) o aplica un anticipo (07) no contabiliza la compra dos veces |
