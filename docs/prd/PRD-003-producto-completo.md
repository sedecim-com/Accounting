# PRD-003 — El producto completo: núcleo, jurisdicciones, nómina, NIF y NIIF, desde la terminal y para agentes

Estado: en revisión · Versión: 0.2 · Owner: @vic2099
Evidencia: [`docs/auditorias/2026-11-13-contra-el-objetivo/`](../auditorias/2026-11-13-contra-el-objetivo/README.md), la revisión del árbol contra este objetivo. Épica y entrevista: [#603](https://github.com/sedecim-com/Accounting/issues/603), donde el dueño contesta las decisiones de §8; su frase del 2026-11-13 se cita abajo. Informe de contexto: §7.

El número 002 queda reservado para la integración con la plataforma Sedecim (#379). [PRD-001](PRD-001-mvp.md) no cambia: es el primer hito de este producto, y su prueba de aceptación (#311) sigue siendo lo primero que se cierra.

La versión 0.2 (2026-11-14) corrige la primera tras una contra-revisión de tres lectores contra el árbol. Un requisito conserva su identificador aunque cambie de sitio; por eso los que nacieron en esta versión llevan números del 46 en adelante.

## 1. Problema y objetivo

El objetivo, con las palabras del dueño (2026-11-13):

> un sistema contable CLI completo y multijurisdicción nativo para IA que tenga un core contable y módulos de cálculo de nóminas y cumplimiento de las reglas contables NIF y NIIF

La visión de [`docs/SCOPE.md`](../SCOPE.md) ya decía lo mismo. Lo que no lo persigue es el plan. PRD-001 entrega el mes de una PyME mexicana. De lo que el backlog tenía después, la revisión clasificó las 210 tareas de la ola 4, por su issue y su título, el 2026-11-13: 82 de renombrado e idioma, 42 de jurisdicción, 19 del agente, 18 de nómina, 17 del núcleo, 17 de proceso, 10 de plataforma, 4 del CLI, **una de motor NIF y ninguna de motor NIIF**. Ninguna era `Must`. Es una foto de la revisión, no la salida de un comando.

El árbol, según la misma revisión, sobre `develop`:

| Dimensión del objetivo | Estado | El hecho que lo resume |
|---|---|---|
| Núcleo contable | Parcial | Partida doble, mayor inmutable y cierre sólidos para una entidad en pesos. Sin libros por norma, sin maestro de dimensiones, sin consolidación |
| Multijurisdicción | Esqueleto | `JurisdictionCode = 'MX' \| 'US'` (`src/services/jurisdiction/jurisdiction.ts`). El paquete por país es diseño (`docs/jurisdicciones.md`), no código |
| Nómina | Parcial | Calcula impuestos sobre importes tecleados; no calcula el sueldo. El binario no registra los calculadores: sólo los carga el servidor REST (`src/index.ts`) |
| Cumplimiento NIF | Parcial | Hay NIF dentro de los motores (B-15, C-6, D-3 de corto plazo). No hay módulo: sin B-4, sin estructura de B-3, sin D-4, sin revelaciones |
| Cumplimiento NIIF | Esqueleto | Ninguna regla NIIF se ejecuta. Existe el corpus del agente. Ninguna puerta crea una entidad `ifrs`. La norma de la entidad sólo decide hoy, junto con el país, si recibe el estrato fiscal mexicano: ningún motor de medición ni de presentación la lee |
| CLI completo | Parcial | 278 comandos; 263 de 1 640 filas del catálogo se pueden invocar (`npm run catalogo:estado`), y el medidor cuenta de más y de menos |
| Nativo para IA | Parcial | «La IA propone, una persona dispone» sólo protege al agente embebido; la revisión contó 25 herramientas escritas a mano frente a 137 hojas declaradas para él |

Este PRD traduce el objetivo a requisitos con criterio ejecutable, dice qué significa «completo» en cada dimensión y con qué se mide, y separa lo que puede empezar hoy de lo que espera una decisión del dueño.

## 2. Métricas de éxito

Una dimensión está completa cuando su instrumento lo dice, no cuando lo dice este documento. Donde el instrumento no existe, construirlo es el primer requisito de la dimensión.

| Dimensión | «Completo» quiere decir | Lo mide | Hoy |
|---|---|---|---|
| Núcleo contable | Una entidad lleva sus libros, cierra el ejercicio y emite el juego completo de estados sin salir del CLI ni tocar SQL | Un paquete nuevo de `npm run plan:status` con criterios ▶ | No existe el paquete. E4.2 está en 4 de 5: quedan siete copias del SQL de saldos |
| Multijurisdicción | Una jurisdicción se añade como paquete, sin editar el motor común | El kit de conformidad por paquete en CI (RF-14) y el conteo de literales de país en módulos comunes, que sólo baja | No existe el kit. La revisión contó unos 28 archivos comunes que nombran un país |
| Nómina | Un periodo completo —alta, incidencias, cálculo, aprobación, póliza, recibos y enteros a la autoridad— corre desde el binario, y sus cifras coinciden con casos calculados a mano | Criterios ▶ por jurisdicción con casos dorados (RF-16 a RF-22 y RF-47) | El paso de nómina de la prueba del mes es `it.todo` |
| NIF | Cada NIF vigente tiene motor o atestación, comando y criterio, y el cierre anual no pasa sin ellos | La matriz norma → motor → comando → criterio, generada y con `--check` en CI (RF-23) | No existe la matriz, ni un registro de NIF legible por máquina |
| NIIF | Una entidad NIIF se crea, opera, cierra y presenta | La misma matriz, por norma, y el criterio de RF-29 | Cero filas ejecutadas |
| CLI | Todo motor contable tiene hoja; toda hoja tiene contrato de máquina | `npm run catalogo:estado` por dimensión del objetivo (RF-34) y el censo de paridad REST–CLI (RF-35) | Un porcentaje global, 16.0 %, que no mide el objetivo. Leído el 2026-11-14: doce hojas declaran la llave de idempotencia sin honrarla, tres salen con el código 11, ninguna emite su error en JSON y ninguna comprueba permisos |
| IA | Cualquier agente puede conducir el sistema por un contrato legible por máquina, y ninguno puede disponer | Los dos criterios rojos de E5.1 en verde, el manifiesto de comandos generado y un eval con umbral como compuerta de CI | E5.1 en 24 de 26 (`npm run plan:status`); el eval sale saltado en CI por falta de credencial |

## 3. Usuarios y roles

- **El contador del despacho**, que opera el CLI.
- **Quien aprueba** lo que un agente propone: el dueño o el auditor del despacho.
- **Un agente**, el embebido o uno externo que conduce el binario. Propone y nunca dispone. Es un rol nuevo en un PRD de este repo: hasta ahora el agente era una función, no un usuario.
- **Quien mantiene un paquete** de jurisdicción o de norma: añade un país o una norma sin tocar el motor.

## 4. Requisitos funcionales

Cada criterio se escribe para que una prueba o un criterio del plan lo ejecute. Las decisiones `D-nn` están en §8, y las tareas `MNE-001-nnn` son las del backlog de PRD-001 que ya cubren parte de un requisito (§8, trazabilidad).

En este documento, **libro** es el conjunto de asientos que se lee bajo una norma. Hoy cada entidad tiene uno solo; si tendrá varios es la decisión D-01. Los requisitos hablan de «la norma del libro» para valer con cualquiera de las dos respuestas.

### 4.1 Núcleo contable

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-01 | Libros paralelos por norma, si el dueño los decide | Must si D-01 es (b); no aplica si es (a) | Dada una entidad con dos libros de norma distinta y un asiento posteado sólo a uno de ellos, cuando se pide la balanza de cada libro, entonces las dos cuadran y difieren exactamente en ese asiento. |
| RF-02 | Estados por layout declarado, no por código | Must | Dado un layout declarado como dato —renglones, subtotales, signos y títulos, con su norma y su vigencia—, cuando se pide un estado de un ejercicio, entonces sale armado por el layout vigente al inicio de ese ejercicio, con la columna comparativa del ejercicio anterior, y una verificación de amarres sale con código distinto de cero si un estado no casa con otro. Los layouts de cada norma son RF-24 y RF-30. Absorbe las columnas comparativas de MNE-001-343, que hoy las pide sólo para Estados Unidos. |
| RF-03 | El mayor y el cierre no se eluden por ninguna puerta conocida | Must | (a) Dada la política de segregación de funciones en «exigir», cuando la misma persona importa un lote por el CLI y lo postea, entonces el posteo se rechaza. (b) Dada una cuenta cerrada a pólizas manuales, cuando una póliza sin origen de motor declara un tipo automático, entonces se rechaza. (c) Dado un ejercicio sellado antes de existir el siguiente, cuando se crea el siguiente, entonces su primer periodo abre con los saldos arrastrados. (d) Dada la póliza de depreciación de un mes reversada, cuando se vuelve a correr el mes, entonces postea de nuevo y la ficha del activo coincide con el mayor. Cada una con su prueba de ataque: #592, #593, #594 y #595. La revisión confirmó (a), (b) y (c) con una sonda y (d) por lectura. |
| RF-46 | El barrido anual frente a los meses en cierre suave | Should | Dada la clave del panel que dice si un ejercicio puede sellarse con meses en cierre suave —por omisión, no—, cuando se pide sellar con un mes así, entonces se rehúsa o se acepta según la clave; y dada una póliza de resultados posteada a un ejercicio ya barrido, cuando se revisa el mayor, entonces se detecta y el cierre siguiente no pasa hasta volver a cerrar el periodo 13 (#602). Es una bifurcación de criterio: va al panel, con su lector. |
| RF-50 | El cierre anual localiza las cuentas de capital por rol | Should | Dado un catálogo cuyas cuentas de resultado del ejercicio y de resultados acumulados no llevan los códigos sembrados, cuando se sella el ejercicio, entonces el barrido las encuentra por su rol. |
| RF-04 | Dimensiones analíticas con maestro | Should | Dada una dimensión con sus valores, cuando una póliza nombra un valor que no existe, entonces se rechaza; y la balanza por dimensión suma la balanza general. |
| RF-05 | El ciclo de vida de los auxiliares | Should | (a) Dado un activo vendido o dado de baja, cuando se registra, entonces deja su asiento con la utilidad o la pérdida y deja de depreciarse (NIF C-6). (b) Dada una factura de proveedor aprobada, cuando se anula, entonces se reversa con su motivo. (c) Dada una cuenta por cobrar incobrable, cuando se castiga, entonces deja su asiento. (d) Dada cualquier fecha, cuando se pide la antigüedad, entonces sale lo adeudado ese día, por moneda, y casa con su cuenta de control a esa misma fecha (#596). |
| RF-49 | Moneda funcional distinta del peso | Should | Dada una entidad cuya moneda funcional no es el peso y un saldo en otra divisa, cuando corre el cierre, entonces la revaluación se calcula contra su moneda funcional (NIF B-15, NIC 21). Hoy se rehúsa. |
| RF-06 | Inventarios y costo de ventas | Should | Dadas compras y ventas de un artículo, cuando se factura la venta, entonces el costo sale de inventario por el método declarado en el panel y el auxiliar de inventarios casa con su cuenta de control al cierre (NIF C-4, NIC 2). |
| RF-07 | Contratos con calendario: arrendamientos y préstamos | Should | Dado un contrato de arrendamiento o un préstamo, cuando corre el cierre del mes, entonces se postean el interés, la depreciación del derecho de uso y la porción que cambia de plazo, y el saldo del pasivo casa con su tabla (NIF D-5 y NIIF 16; NIF C-19 para lo recibido en préstamo). Las exenciones de corto plazo y de bajo valor son claves del panel. |
| RF-08 | El grupo: intercompañía, eliminaciones, consolidación y conversión | Could | Dadas dos entidades de un grupo con saldos entre sí y monedas funcionales distintas, cuando se consolida, entonces los saldos recíprocos se eliminan, el efecto de conversión queda en otro resultado integral, acumulado en el capital, y la participación no controladora se presenta aparte (NIF B-8 y B-15; NIIF 10 y NIC 21). |
| RF-09 | Una sola capa de consulta de saldos | Should | Dado el árbol, cuando corre `npm run plan:status`, entonces E4.2 está en verde y CI lo exige. Lo cubre MNE-001-052. |
| RF-48 | Reexpresión en entorno inflacionario | Could | Dada una entidad en entorno inflacionario según la serie del INPC, cuando corre el cierre anual, entonces se propone la reexpresión de sus partidas no monetarias como borrador, con su cédula (NIF B-10; NIC 29 en un libro NIIF). |

### 4.2 Multijurisdicción

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-10 | El paquete de jurisdicción existe en el código | Must | Dado un paquete de prueba añadido como carpeta y registrado, cuando se da de alta una entidad de esa jurisdicción y se postea y se cierra un mes, entonces funciona, y un criterio comprueba que ningún archivo del motor común cambió para ello. Y dado un país sin paquete, cuando se pregunta por su jurisdicción, entonces el sistema falla cerrado en vez de tratarlo como mexicano. Enmienda una regla vigente (§8). |
| RF-11 | La puerta de la entidad | Must | Dada la orden de crear una entidad con un país que tiene paquete, una norma, una moneda funcional y un mes de inicio de ejercicio, cuando se crea, entonces su catálogo se siembra con el estrato de ese paquete, sus periodos empiezan en el mes pedido y sus estados usan el layout de su norma; y el paquete rechaza lo que su ley no admite: México, un inicio que no sea enero. Lo cubren en parte MNE-001-329 y MNE-001-330. |
| RF-12 | La ley, en un solo almacén con vigencia y fuente, cargable por comando | Must | Dado un parámetro legal del ejercicio siguiente importado por comando con su fuente oficial, cuando se calcula un hecho de esa fecha, entonces usa ese valor; sin él, el cálculo falla cerrado y nombra el hueco. Toda tasa, tope o tabla que hoy sólo entra por migración se puede cargar también así. Lo cubren en parte MNE-001-326, 327 y 328. |
| RF-13 | El impuesto indirecto lo pone el paquete | Should | Dada una factura con dos tasas y una retención en una entidad no mexicana, cuando se postea, entonces el motor común pide las líneas de impuesto al paquete y no nombra el IVA; en una entidad mexicana el resultado es idéntico al de hoy. |
| RF-14 | Kit de conformidad por paquete | Should | Dado un paquete, cuando corre CI, entonces un mismo juego de pruebas recorre su mes completo —factura, cobro, banco, activo, devengo, cierre y estados— y falla si el paquete no cumple el contrato. |
| RF-15 | Una tercera jurisdicción real | Could | Dada la jurisdicción que el dueño elija en D-02, cuando se entrega su paquete, entonces pasa el kit de conformidad sin cambios en el motor común. |

### 4.3 Nómina

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-16 | La nómina corre de punta a punta desde el binario | Must | Dada una entidad con empleados, cuando una prueba ejecuta el binario —no el servicio, y sin importar por su cuenta el registro de calculadores— con sólo comandos del CLI, entonces quedan hechos el calendario, el periodo, la corrida, el cálculo, la aprobación, la póliza y los recibos, y el paso de nómina de `tests/integration/mvp-month-end-to-end.int.spec.ts` deja de ser `it.todo`. Hasta el 14 de noviembre de 2026 trece pruebas de integración importaban ese registro ellas mismas: por eso el backlog daba por entregadas MNE-001-066 a 070 con un binario que no calculaba. MNE-001-402 (#586) lo corrigió con #610. Faltan MNE-001-403 (#587, el calendario), MNE-001-404 (#613, los periodos) y MNE-001-098 (el paso de nómina de la prueba del mes). |
| RF-17 | El contrato del módulo de nómina | Must | Dada una corrida calculada y sin aprobar, cuando se recalcula, entonces los recibos se rehacen y los totales de la corrida son la suma de sus recibos; dada una falla a media corrida, entonces no queda ningún recibo escrito (#601); y dado el paquete de prueba de RF-10 con su nómina, cuando se añade, entonces el orquestador no cambia. |
| RF-18 | México calcula las percepciones y cotiza lo que la ley dice | Must | Dados un empleado con su compensación, sus días trabajados y sus incidencias, cuando se calcula el periodo, entonces el sueldo, el salario base de cotización y las cuotas obreras y patronales coinciden con un caso calculado a mano contra la cédula del SUA; dos corridas del mismo periodo no cotizan dos veces (#601); y el subsidio al empleo sigue lo que el decreto vigente a la fecha de pago diga (#600). |
| RF-47 | La póliza de nómina reconoce lo devengado y sus pasivos | Should | Dada una corrida aprobada, cuando se postea, entonces el impuesto estatal sobre nómina queda en gasto y en su pasivo, los sueldos se reconocen por pagar al devengarse y se cancelan al pagar, y cada entero a la autoridad se registra contra su pasivo. |
| RF-19 | Terminaciones y obligaciones anuales de México | Should | Dada una baja con antigüedad, cuando se calcula el finiquito o la liquidación, entonces incluye las partes proporcionales, la indemnización que corresponda y el ISR de separación, y queda guardado como corrida con recibo y póliza. Dado el cierre del ejercicio, entonces existen el ajuste anual y la PTU. Lo cubren en parte MNE-001-298, 374 y 375, con la decisión MNE-001-373; el ajuste anual no tiene tarea. |
| RF-20 | Lo que se entrega a la autoridad es válido, o no se ofrece | Should | Dado un recibo timbrable, cuando se genera el CFDI de nómina, entonces valida contra el XSD oficial del complemento con los datos de la entidad, sin literales. Un formato que no tiene layout oficial versionado en el repositorio no tiene comando. Lo cubren en parte MNE-001-278, 279 y 296. |
| RF-21 | Los invariantes valen en nómina | Must | Dados el timbrado de un recibo y la lectura de un empleado por cualquier puerta, cuando se ejecutan, entonces timbrar exige corrida aprobada y recibo sin timbre, con `UPDATE` guardado, y toda lectura lleva alcance de entidad dentro del SQL (#590). Dado un W-2 generado, entonces no guarda el SSN en claro y hay uno por empleado y ejercicio (#591, MNE-001-282). El W-2 y el lote de movimientos afiliatorios hoy sólo existen por REST: ganan hoja de CLI o se retiran con su ruta según D-03 y D-09. |
| RF-22 | Estados Unidos, al nivel que el dueño decida | Could | Escrito para la opción recomendada de D-03: dado un empleado de un estado sin parámetros sembrados, cuando se calcula su recibo, entonces el sistema se niega y nombra el estado; y para cada estado soportado hay un caso tomado de un ejemplo publicado por la autoridad. Se reescribe si D-03 se contesta de otro modo. |

### 4.4 Cumplimiento NIF

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-23 | El registro de normas y su matriz | Must | Dado un registro de normas legible por máquina que dice de cada una su vigencia y si es norma, interpretación u orientación —el de NIIF ya existe; el de NIF se crea, con su prueba de frescura—, cuando corre el generador, entonces sale la matriz norma → motor → comando → criterio para las normas vigentes a una fecha, cada una con su motor o declarada sin él, y `--check` en CI falla si la matriz quedó vieja. Es el primer instrumento que obliga a separar lo que es de la norma de lo que es del país. |
| RF-24 | Los estados que piden las NIF | Must | Dado un ejercicio de una entidad NIF, cuando se piden sus estados, entonces salen el de situación financiera con el capital contribuido separado del ganado (B-6), el de resultado integral en uno o dos estados y por función o por naturaleza según lo declarado en el panel, con el ORI (B-3), el de cambios en el capital contable (B-4) y el de flujos de efectivo (B-2), cada uno en la versión de su norma vigente al inicio del ejercicio, contra un caso escrito a mano. Lo cubre en parte MNE-001-365. |
| RF-25 | Los avisos normativos quedan guardados | Must | Dada una póliza que dispara un aviso normativo, cuando se postea, entonces el hallazgo queda guardado con su norma y se muestra a quien aprueba. |
| RF-51 | El cierre anual no pasa sin sus compuertas normativas | Must | Dado un cierre anual, cuando se pide, entonces no pasa sin las corridas del ejercicio de beneficios a empleados y de revaluación cambiaria, ni sin las atestaciones firmadas por una persona: negocio en marcha (NIF A-2, vigente desde 2026), hechos posteriores (NIF B-13) y entorno inflacionario (NIF B-10). |
| RF-26 | Impuestos a la utilidad y PTU (NIF D-4 y D-3) | Must | Dado un ejercicio con diferencias temporales entre el libro contable y el fiscal, cuando corre el cierre anual, entonces quedan como borrador el impuesto causado y el diferido y la PTU causada y diferida, con la conciliación contable-fiscal y la de tasa efectiva. Lo cubren en parte MNE-001-300 y MNE-001-298. |
| RF-27 | Estimaciones y valuación posterior | Should | Dadas una cartera vencida, un activo con indicio de deterioro y una obligación probable, cuando corre el cierre, entonces se proponen la pérdida crediticia esperada (C-16), el deterioro (C-15) y la provisión (C-9) como borradores con su cédula, y el pasivo de beneficios a largo plazo (D-3) entra desde una valuación actuarial externa. |
| RF-28 | Revelaciones y notas | Should | Dado un ejercicio cerrado, cuando se pide el paquete de notas, entonces la nota de políticas sale del panel de decisiones, los anexos salen del mayor —partes relacionadas incluidas— y la lista de revelaciones dice cuáles faltan; el agente redacta el borrador y una persona lo aprueba. |

### 4.5 Cumplimiento NIIF

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-29 | La norma del libro gobierna, por una sola puerta | Must | Dadas dos entidades iguales salvo su norma —NIF una, NIIF la otra; al alta se declara si son NIIF completas o NIIF para las PyMEs—, cuando se piden sus estados y su panel, entonces difieren al menos en tres cosas: el layout de sus estados (RF-24 frente a RF-30), las citas de sus validaciones y las opciones que su panel admite (RF-31). Un criterio comprueba que ningún motor decide por el país lo que es de la norma, ni por la norma lo que es fiscal: hoy `keepsMexicanBooks` da el estrato fiscal mexicano a toda entidad con norma `mx_nif`. Reabre lo que un documento vigente dejó impedido (§8). |
| RF-30 | Presentación NIIF | Must | Dado un ejercicio de una entidad NIIF, cuando se piden sus estados, entonces siguen la NIC 1 si el ejercicio empezó antes del 2027-01-01, y la NIIF 18 con el comparativo reexpresado si empezó desde esa fecha o si la entidad declaró en el panel su adopción anticipada; y la NIC 7; contra un caso escrito a mano. |
| RF-31 | El panel resuelve también por norma, y rechaza lo que la norma no admite | Must | Dada una clave del panel cuyas opciones dependen de la norma, cuando se contesta para un libro una opción que su norma no admite, entonces se rechaza con la cita: UEPS no se admite ni en NIF (C-4) ni en NIIF (NIC 2). Cada opción declara las normas que la admiten, y las que hoy se ofrecen a toda entidad, como depreciar a la tasa fiscal, se revisan contra cada norma. Extiende MNE-001-324, que resuelve sólo por jurisdicción. |
| RF-32 | Medición NIIF sobre los motores compartidos | Should | Dada la matriz de RF-23, cuando corre su comprobación, entonces cada una de estas normas tiene su motor y un caso que ejecuta su diferencia frente a NIF, o está declarada sin motor: NIC 2, NIC 12, NIC 16, NIC 19, NIC 21, NIC 29, NIC 36, NIC 37, NIIF 9, NIIF 13, NIIF 15 y NIIF 16. |
| RF-33 | Cambiar de norma y conciliar entre normas | Could | Dada una entidad que adopta NIIF, cuando se registra la transición, entonces queda el asiento de adopción (NIIF 1); y si lleva libros paralelos (D-01), un informe concilia capital y resultado entre ellos. |

### 4.6 CLI completo

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-34 | «Completo» se mide por dimensión del objetivo | Must | Dado el catálogo, cuando corre `npm run catalogo:estado`, entonces el avance sale por dimensión —núcleo, jurisdicciones, nómina, NIF, NIIF e IA—, las familias que el objetivo no pide quedan fuera del denominador, y el medidor no cuenta como viva una fila cuya bandera no existe ni como muerta una hoja con otro nombre. |
| RF-35 | Ningún motor contable vive sólo en REST | Must | Dado el árbol, cuando corre el censo de paridad, entonces falla si un servicio contable es alcanzable desde el servidor y no desde el binario. Su línea base es la que mida el propio censo al nacer, y sólo baja. |
| RF-36 | Contrato de máquina en toda hoja | Must | Dada cualquier hoja con `--json`, cuando termina bien, entonces su salida es JSON; cuando falla, entonces emite por stderr un sobre con código de salida, clave, parámetros y remedio; y cuando deja algo en una cola de revisión, entonces sale con 11. |
| RF-37 | El binario se instala y se opera solo | Should | Dada una instalación sin el clon del repositorio ni herramientas de desarrollo, cuando se ejecuta el binario, entonces migra su base y carga los parámetros legales con su fuente. |
| RF-38 | El CLI aplica roles y permisos | Should | Dado un usuario sin el permiso de cerrar o reabrir periodos, cuando ejecuta el comando, entonces se rechaza con el mismo catálogo de permisos que usa REST. Se cruza con MNE-001-264 y MNE-001-266. |
| RF-39 | Reintentar no duplica | Should | Dada una escritura grave ejecutada dos veces con la misma llave de idempotencia, cuando termina la segunda, entonces hay un solo efecto; y la lista de hojas que declaran la llave sin honrarla (`DEUDA_DE_LLAVES`, en `src/cli/kernel/audit.ts`) llega a cero. |

### 4.7 Nativo para IA

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-40 | El invariante vale para cualquier agente | Must | Dado un agente que conduce el binario con su propia identidad, cuando intenta postear, aprobar un borrador o escribir en el mayor por cualquier puerta —el CLI, REST o la base de datos—, entonces no deja ningún efecto sin una aprobación humana atada al hash de lo revisado. MNE-001-245 (#331) trata de los agentes que desarrollan, no de éste. |
| RF-41 | Un solo registro de comandos | Must | Dado el registro de riesgo del CLI, cuando se generan, entonces de él salen las herramientas del agente embebido y un manifiesto JSON de comandos con riesgo, opciones y códigos de salida, y el criterio `agent-tools-from-risk-registry` de E5.1 queda en verde. Lo cubre en parte MNE-001-391. Si además hay un servidor MCP es D-07. |
| RF-42 | La cola de aprobaciones se consume por máquina | Should | Dado un borrador en cola, cuando una persona lo aprueba por un comando no interactivo, entonces la aprobación queda atada al hash de lo que vio, igual que en el menú. |
| RF-43 | Sesión reanudable | Should | Dada una sesión interrumpida, cuando se reanuda, entonces el modelo recibe el historial con sus llamadas a herramientas, y el criterio `resumed-session-rehydrates-history` de E5.1 queda en verde. Lo cubre MNE-001-392. |
| RF-44 | El eval mide lo que se embarca | Should | Dado un cambio al clasificador o a su prompt, cuando corre CI con la credencial del proveedor, entonces el eval corre; tras la primera corrida medida su umbral es esa medida, y sólo sube; y los casos comparan por rol de cuenta, no por código del catálogo sembrado. Necesita una acción del dueño (§8). Lo cubre en parte MNE-001-292. |
| RF-45 | Lo que entra y lo que sale del modelo está gobernado | Should | Dado un inquilino con su lista de proveedores de modelo permitidos, cuando una orden pide otro, entonces se rechaza y queda registrado; y un documento con Unicode invisible o instrucciones incrustadas no cambia lo que el agente propone. |

## 5. Requisitos no funcionales

| ID | Requisito | Meta medible |
|---|---|---|
| RNF-01 | Los siete invariantes de `AGENTS.md` no se negocian | Ningún criterio de los paquetes hoy en verde retrocede (`npm run plan:status -- --piso`) |
| RNF-02 | Ningún requisito se da por cumplido sin instrumento | Cada RF de este PRD tiene, al cerrarse, un criterio del plan con su mutante o una prueba que lo ejecuta |
| RNF-03 | El CLI es el producto; REST no le saca ventaja | Ninguna ruta de `/v1` gana una capacidad contable que el CLI no tenga. Si además REST se congela es D-04. Hasta que nazca el censo de RF-35, lo vigila el censo de rutas que ya existe |
| RNF-04 | La instalación es segura como dice el alcance | Los respaldos salen cifrados (#598), `npm audit --omit=dev` da cero (#584), y la bóveda de producción funciona donde D-06 diga |
| RNF-05 | La entrega fluye | El flujo de ramas del ADR-0008 existe (§8, acciones del dueño); cada comprobación que un documento llama obligatoria lo es en la rama de trabajo, nombrada por su job; y la duración del job de integración se mide y no sube de su línea base. La revisión registró 38 minutos en una corrida. Lo cubre en parte MNE-001-251 |

## 6. Dentro y fuera de alcance

**Dentro:** lo que nombra la frase del dueño. El núcleo contable con sus auxiliares e informes, los paquetes de jurisdicción, los módulos de nómina, el cumplimiento NIF y NIIF, el CLI como superficie completa y el contrato para agentes.

**Fuera, mientras el dueño no diga otra cosa (D-03, D-04, D-05, D-08):**

- la atestación en blockchain y las cifras públicas;
- el tablero web, que se congela como está: sólo lectura;
- los canales de mensajería, que ya estaban fuera del MVP;
- el renombrado interno del código al inglés. Sí siguen la superficie por clave y el idioma estatutario por jurisdicción;
- las familias de ERP del catálogo (cotizaciones, pedidos, compras, almacén);
- el corpus US GAAP del agente y la inversión nueva en Estados Unidos;
- el timbrado con PAC, que sigue esperando un contrato con un proveedor;
- presentar ante el SAT, igual que en PRD-001.

## 7. Reutilización y dependencias de plataforma

Informe de contexto, de [`docs/platform/inventory.md`](../platform/inventory.md) y [`docs/platform/harmony-review.md`](../platform/harmony-review.md) (revisión del 2026-09-26). Esa revisión avisa de que sus informes completos se quedaron en la sesión de trabajo, y para este PRD no se volvieron a leer los repos vecinos.

| Capacidad | Lo que dice la revisión de plataforma | Consecuencia para este PRD |
|---|---|---|
| Descarga masiva del SAT | `sat-services` la duplica. Prevé que Accounting la consuma o comparta la librería, con un solo custodio de la e.firma, cuando aquél se endurezca | Se mantiene la duplicación, ya entregada aquí (E3.2), y se revisa cuando `sat-services` esté listo |
| PDF de estados y recibos | `pdf-generator` es productor candidato y todavía no está listo | RF-02 y RF-28 no dependen de él; el formato de entrega se decide en su diseño |
| Catálogos del SAT | `catalogs` los duplica; este repo mantiene su copia y la compara en una prueba cuando aquél esté listo | Sin cambio |
| Constancia NOM-151 | `hash-stamper` es productor candidato | Fuera de este PRD (#374) |
| Cálculo de nómina | Sólo nombra `payroll-extraction-service`: duplica el parser de nómina, guarda datos personales sin cifrar y propone archivarlo | **No contesta la pregunta.** Antes de aprobar §4.3 hay que volver a leer la organización y confirmar que ningún repo calcula nómina |
| Identidad | Cognito (ADR-0007). Siguen abiertas MNE-001-264 y 266: el inquilino por `external_ref` y el mapeo de roles | RF-38 se diseña junto con ellas |

Lo que escriba en Contalink sigue la frontera del ADR-0004.

## 8. Supuestos, riesgos y preguntas abiertas

### Decisiones del dueño

La recomendación es de quien hizo la revisión; la decisión es del dueño y, cuando se tome, se escribe como ADR o como entrada `decision` del backlog. Se contestan en #603.

| ID | Pregunta | Opciones | Recomendación | Bloquea |
|---|---|---|---|---|
| D-01 | ¿Una entidad lleva un libro, o varios libros paralelos de norma distinta? | (a) Uno, como hoy. (b) Varios: una filial mexicana lleva NIF y reporta NIIF a su grupo desde los mismos asientos. | (b), y decidirlo antes de construir cualquier motor de medición. Reabre `docs/jurisdicciones.md` §3.1, que modela una sola norma por entidad, y su §6, que dejó la entidad IFRS impedida «hasta que un cliente lo necesite». La mecánica es del diseño de sistema, no de esta decisión. | RF-01; la redacción de RF-33 |
| D-02 | ¿Cuál es la tercera jurisdicción? | (a) Ninguna real todavía: un paquete de prueba en CI basta para probar el contrato. (b) Una de norma NIIF, la que tenga primer cliente. | (a) ahora y (b) cuando haya cliente. El paquete de prueba es parte de RF-10 y no espera. | RF-15 |
| D-03 | ¿Hasta dónde llega Estados Unidos? | (a) Se queda como está, declarando sólo los estados con parámetros sembrados y negando el resto. (b) Nómina federal completa y una lista de estados. (c) Sólo importar nóminas calculadas fuera. | (a) hasta cerrar NIF y NIIF. Hoy registra calculadores para los 50 estados y el Distrito de Columbia, y sólo cinco tienen parámetros. | RF-22; el W-2 de RF-21; la hoja del 1099-NEC que MNE-001-332 dejó sin puerta |
| D-04 | ¿Qué se hace con lo que el objetivo no nombra? | Por pieza: retirar, congelar o conservar. | Retirar con ADR la atestación en blockchain y los adaptadores de pago simulados; congelar el tablero web y REST: ninguna ruta nueva. Si la atestación se retira, la decisión MNE-001-382 (#257) queda sin objeto. | RNF-03; el denominador de RF-34 |
| D-05 | ¿Sigue el renombrado interno al inglés (epic #141)? | (a) Sigue. (b) Se aparcan los tramos internos —identificadores, esquema, vocabulario persistido, contratos— y siguen sólo la superficie por clave y el idioma estatutario. | (b). Son unas 50 tareas que no acercan ninguna dimensión del objetivo, y tres de ellas tocan datos de inquilinos y contratos publicados. | Ningún requisito: libera capacidad |
| D-06 | ¿Dónde vive la bóveda de producción? | (a) En el equipo del despacho, cifrada, con la llave fuera del directorio de datos. (b) En la nube: AWS pasa a ser requisito declarado de instalación. | (a), porque el alcance dice que hoy se instala en el equipo del despacho. Hoy en producción sólo se admite AWS Secrets Manager (`src/services/vault/`). | RNF-04 |
| D-07 | ¿Los agentes externos tienen, además del manifiesto, un servidor MCP? | (a) No todavía: el manifiesto JSON de RF-41 basta. (b) Sí, derivado del mismo registro. | (a) primero; (b) después, con su dependencia justificada. | Ningún `Must`: sólo el alcance de RF-41 |
| D-08 | ¿Qué prioridad tiene la plataforma Sedecim frente a este objetivo? | Las de la decisión que ya está abierta: MNE-001-270 (#379). | Carril propio, sin prioridad sobre el objetivo. Se contesta allá, para que haya un solo registro. | Ningún requisito: capacidad |
| D-09 | ¿Los movimientos afiliatorios y la dispersión son parte de la nómina? | (a) Los movimientos ante el IMSS sí, con su layout oficial; la dispersión bancaria va a pagos. (b) Ninguno. | (a): alta, baja y cambio de salario son la otra mitad del salario base de cotización. | El lote afiliatorio de RF-21 y de RF-20 |
| D-10 | ¿Cómo se revisa este volumen de trabajo? | (a) Se mantiene la regla de dos PRs de agente por revisor humano. (b) Se cambia la regla. (c) Se construye el orquestador de MNE-001-247 (#332). | Sin recomendación: es capacidad y riesgo del dueño. Este plan no cabe en (a). | Ningún requisito: el ritmo de todos |

### Acciones que sólo puede hacer el dueño

No son decisiones abiertas: ya están tomadas, o son ajustes fuera del árbol.

- **Ramas.** El ADR-0008 ya decidió `feature → develop → release → main`. Falta ejecutarlo: hacer de `develop` la rama por omisión y protegerla, y crear `release` en el primer corte. Hoy `release` no existe en `origin`, no hay tags y `main` va detrás de `develop` (`git rev-list --count origin/main..origin/develop`). Mientras `main` sea la rama por omisión, Dependabot abre sus PRs contra ella. Lo que sí sigue abierto es la decisión MNE-001-267 (#372): cómo se concilian esas ramas con el despliegue de la plataforma.
- **La credencial del proveedor de modelo en CI.** Sin ella el job del eval sale saltado y RF-44 no puede medirse.
- **Confirmar contra el DOF** el decreto del subsidio al empleo (#600) antes de tocar el cálculo.
- **El plan aprobado** (`/aprobar-plan`) en las issues que tocan rutas con dueño reforzado.

### Lo que este PRD enmienda de documentos vigentes

Al aprobarse, estos textos se corrigen en el mismo PR o con su ADR. Hasta entonces mandan ellos.

| Documento | Lo que dice hoy | Lo que pide este PRD |
|---|---|---|
| `docs/jurisdicciones.md` §3.1 | Un país nulo, vacío o desconocido es México: «la segura para este producto» | Un país sin paquete falla cerrado (RF-10) |
| `docs/jurisdicciones.md` §3.2 | El registro de paquetes se indexa con la unión cerrada de dos países; una jurisdicción nueva trae «una migración con sus parámetros legales» | El registro es abierto (RF-10) y la ley también se carga por comando (RF-12) |
| `docs/jurisdicciones.md` §3.3 | El panel resuelve por jurisdicción fiscal | El panel resuelve también por norma (RF-31) |
| `docs/jurisdicciones.md` §6 | La entidad con libros IFRS «se mantiene impedida hasta que un cliente lo necesite» | El objetivo del 2026-11-13 nombra el cumplimiento NIIF (RF-29, RF-30) |

### Riesgos

- **El tamaño.** Esto es más trabajo que todo PRD-001. Sin D-01 y sin el paquete de jurisdicción (RF-10), los motores nuevos se construirían sobre el país y habría que rehacerlos.
- **El orden importa más que la velocidad.** Primero se cierra el MVP (#311), después los cimientos (D-01, RF-10, RF-17, RF-23, RF-41), después los motores.
- **La ley se verifica en su fuente.** Varias brechas de nómina (las cuotas patronales por tramo, el subsidio al empleo que excede al ISR) salen de la investigación del propio repositorio, no del texto oficial. Cada una se confirma contra su fuente antes de tocar el cálculo.
- **Las normas las juzga un contador.** Los números de norma de §4.4 y §4.5 se cotejaron con el corpus del repositorio, no con el CINIF ni con el IASB. Antes de aprobar, alguien con criterio contable los revisa.
- **Capacidad de revisión.** Es D-10.

### Lo que no espera ninguna decisión

Defectos confirmados y desbloqueos, que van directo por `docs/PROCESS.md` como issues con su Definition of Ready:

1. La prueba de aceptación del MVP (#311, MNE-001-098).
2. El binario registra los calculadores de nómina y tiene hojas para calendario y periodos: #586 y #587 (RF-16).
3. Los cuatro caminos de RF-03 (#592 a #595) y lo que RF-21 pide de timbrado, alcance y W-2 (#590, #591).
4. La lectura de un XML por id y el archivado de una entidad llevan alcance: #588 y #589 (RNF-01).
5. Los respaldos salen cifrados: #598 (RNF-04). Las tablas de ley dejan de ser editables por cualquier inquilino: #599.
6. La antigüedad a una fecha y por moneda: #596. El rótulo del capital: #597.
7. La corrida de nómina atómica y sin doble cotización: #601.

Dos más tienen issue y sí esperan algo: la clave del panel de RF-46 (#602), que es criterio contable y nace con su lector, y el subsidio al empleo (#600), que espera la confirmación contra el decreto.

### Trazabilidad con el backlog de PRD-001

Tareas abiertas de `docs/backlog/PRD-001.json` que ya cubren parte de un requisito. Al aprobarse este PRD pasan a su backlog con la prioridad de su requisito; hasta entonces conservan la que tienen.

| Requisito | Tareas que lo cubren en parte | Prioridad de hoy |
|---|---|---|
| RF-02, RF-24 | MNE-001-343 (comparativos y balance clasificado, hoy sólo para Estados Unidos), MNE-001-365 (vigencias de B-3, B-4 y B-6) | Could |
| RF-09 | MNE-001-052 | Could |
| RF-10, RF-31 | MNE-001-324, 325 (J0.3), MNE-001-331 | Should, Could |
| RF-11 | MNE-001-329 (J0.5), MNE-001-330 (J0.6) | Could |
| RF-12 | MNE-001-326, 327, 328 (J0.4) | Should, Could |
| RF-16 | MNE-001-402, MNE-001-403, MNE-001-404, MNE-001-098 | Must |
| RF-19 | MNE-001-298, 374, 375; decisión MNE-001-373 | Should |
| RF-20 | MNE-001-278, 279, 296 | Should |
| RF-21 | MNE-001-282 | Should |
| RF-26 | MNE-001-300, MNE-001-298 | Could, Should |
| RF-38 | MNE-001-264, 266 | Should, Could |
| RF-41, RF-43 | MNE-001-391, MNE-001-392 | Should, Could |
| RF-44 | MNE-001-292 | Should |
| RNF-05 | MNE-001-251; decisión MNE-001-267 | Should |

**Sin tarea todavía:** RF-01, RF-04 a RF-08, RF-13 a RF-15, RF-17, RF-18, RF-22, RF-23, RF-25, RF-27 a RF-30, RF-32 a RF-37, RF-39, RF-40, RF-42, RF-45 a RF-51, y el ajuste anual de RF-19. Varias tienen ya su issue de defecto (arriba); ninguna tiene tarea atómica, porque el backlog de este PRD se escribe después de aprobarlo.

## 9. Aprobaciones

Pendiente. Este PRD no se aprueba con D-01 abierta, porque de ella depende que RF-01 exista, ni sin contestar la pregunta de §7 sobre el cálculo de nómina en la plataforma, que condiciona §4.3. El diseño de sistema (SD-003) y el backlog se escriben después de la aprobación, como pide [`docs/prd/README.md`](README.md).
