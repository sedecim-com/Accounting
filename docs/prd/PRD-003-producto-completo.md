# PRD-003 — El producto completo: núcleo, jurisdicciones, nómina, NIF y NIIF, desde la terminal y para agentes

Estado: en revisión · Versión: 0.1 · Owner: @vic2099
Evidencia: [`docs/auditorias/2026-11-13-contra-el-objetivo/`](../auditorias/2026-11-13-contra-el-objetivo/README.md), la revisión del árbol contra este objetivo. Épica y entrevista: [#603](https://github.com/sedecim-com/Accounting/issues/603), donde el dueño contesta las decisiones de §8; su frase del 2026-11-13 se cita abajo. Informe de contexto: §7.

El número 002 queda reservado para la integración con la plataforma Sedecim (#379). [PRD-001](PRD-001-mvp.md) no cambia: es el primer hito de este producto, y su prueba de aceptación (#311) sigue siendo lo primero que se cierra.

## 1. Problema y objetivo

El objetivo, con las palabras del dueño (2026-11-13):

> un sistema contable CLI completo y multijurisdicción nativo para IA que tenga un core contable y módulos de cálculo de nóminas y cumplimiento de las reglas contables NIF y NIIF

La visión de [`docs/SCOPE.md`](../SCOPE.md) ya decía lo mismo. Lo que no lo persigue es el plan. PRD-001 entrega el mes de una PyME mexicana, y lo que el backlog tiene después (la ola 4, 210 tareas) reparte así, según la revisión: 82 de renombrado e idioma, 42 de jurisdicción, 19 del agente, 18 de nómina, 17 del núcleo, 17 de proceso, 10 de plataforma, 4 del CLI, **una de motor NIF y ninguna de motor NIIF**. Ninguna es `Must`.

El árbol, medido el 2026-11-13 sobre `develop`:

| Dimensión del objetivo | Estado | El hecho que lo resume |
|---|---|---|
| Núcleo contable | Parcial | Partida doble, mayor inmutable y cierre sólidos para una entidad en pesos. Sin libros por norma, sin maestro de dimensiones, sin consolidación |
| Multijurisdicción | Esqueleto | `JurisdictionCode = 'MX' \| 'US'` (`src/services/jurisdiction/jurisdiction.ts`). El paquete por país es diseño (`docs/jurisdicciones.md`), no código |
| Nómina | Parcial | Calcula impuestos sobre importes tecleados; no calcula el sueldo. El binario no registra los calculadores: sólo los carga el servidor REST (`src/index.ts`) |
| Cumplimiento NIF | Parcial | Hay NIF dentro de los motores (B-15, C-6, D-3 de corto plazo). No hay módulo: sin B-4, sin estructura de B-3, sin D-4, sin revelaciones |
| Cumplimiento NIIF | Esqueleto | Ninguna regla NIIF se ejecuta. Existe el corpus del agente. Ninguna puerta crea una entidad `ifrs` y nadie lee la norma de la entidad |
| CLI completo | Parcial | 278 comandos; 263 de 1 640 filas del catálogo se pueden invocar, y el medidor cuenta de más y de menos |
| Nativo para IA | Parcial | «La IA propone, una persona dispone» sólo protege al agente embebido; 25 herramientas escritas a mano frente a 137 hojas declaradas para él |

Este PRD traduce el objetivo a requisitos con criterio ejecutable, dice qué significa «completo» en cada dimensión y con qué se mide, y separa lo que puede empezar hoy de lo que espera una decisión del dueño.

## 2. Métricas de éxito

Una dimensión está completa cuando su instrumento lo dice, no cuando lo dice este documento. Donde el instrumento no existe, construirlo es el primer requisito de la dimensión.

| Dimensión | «Completo» quiere decir | Lo mide | Hoy |
|---|---|---|---|
| Núcleo contable | Una entidad lleva sus libros por norma, cierra el ejercicio y emite el juego completo de estados sin salir del CLI ni tocar SQL | Un paquete nuevo de `npm run plan:status` con criterios ▶ (RF-01 a RF-09) | No existe el paquete; E4.2 en rojo (7 copias del SQL de saldos) |
| Multijurisdicción | Una jurisdicción se añade como paquete, sin editar el motor común | El kit de conformidad por paquete en CI (RF-14) y el conteo de literales de país en módulos comunes, que sólo baja | No existe el kit; unos 28 archivos comunes nombran un país |
| Nómina | Un periodo completo (alta, incidencias, cálculo, aprobación, póliza, recibos y pagos a la autoridad) corre desde el binario y sus cifras coinciden con casos calculados a mano | Criterios ▶ por jurisdicción con casos dorados (RF-16 a RF-22) | El paso de nómina de la prueba del mes es `it.todo` |
| NIF | Cada NIF aplicable tiene motor o atestación, comando y criterio, y el cierre anual no pasa sin ellos | La matriz norma → motor → comando → criterio, generada y con `--check` en CI (RF-23) | No existe la matriz |
| NIIF | Una entidad NIIF se crea, opera, cierra y presenta, y una entidad puede llevar NIF y NIIF a la vez | La misma matriz, por norma, y el criterio «dos entidades con norma distinta producen estados distintos» (RF-29) | Cero filas ejecutadas |
| CLI | Todo motor contable tiene hoja; toda hoja tiene contrato de máquina | `npm run catalogo:estado` por dimensión del objetivo (RF-34) y el censo de paridad REST–CLI (RF-35) | Un porcentaje global, 16.0 %, que no mide el objetivo |
| IA | Cualquier agente puede conducir el sistema por un contrato legible por máquina, y ninguno puede disponer | E5.1 en verde, el manifiesto de comandos generado y un eval con umbral como compuerta de CI (RF-40 a RF-45) | E5.1 24/26; el eval sale `SKIP` en CI |

## 3. Usuarios y roles

- **El contador del despacho**, que opera el CLI.
- **Quien aprueba** lo que un agente propone: el dueño o el auditor del despacho.
- **Un agente**, el embebido o uno externo que conduce el binario. Propone y nunca dispone. Es un rol nuevo en un PRD de este repo: hasta ahora el agente era una función, no un usuario.
- **Quien mantiene un paquete** de jurisdicción o de norma: añade un país o una norma sin tocar el motor.

## 4. Requisitos funcionales

Cada criterio se escribe para que una prueba o un criterio del plan lo ejecute. Las decisiones `D-nn` están en §8.

### 4.1 Núcleo contable

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-01 | Libros por norma | Must | Dada una entidad con un libro NIF y un libro NIIF y un asiento de ajuste posteado sólo al libro NIIF, cuando se pide la balanza de cada libro, entonces las dos cuadran y difieren exactamente en ese asiento. Espera D-01. |
| RF-02 | El juego completo de estados, por layout declarado | Must | Dado un ejercicio cerrado y su anterior, cuando se pide el juego de estados, entonces salen situación financiera, resultado integral con sus subtotales, cambios en el capital y flujos de efectivo, cada uno con su columna comparativa, y una verificación de amarres falla con salida distinta de cero si un estado no casa con otro. |
| RF-03 | El mayor y el cierre no se eluden por ninguna puerta | Must | Dados los cinco caminos que la revisión confirmó (el candado de cuatro ojos del lote importado por el CLI; la cuenta de control con un tipo automático declarado por REST; sellar el ejercicio antes de crear el siguiente; barrer el año con meses en cierre suave; reversar la póliza de depreciación y volver a correr el mes), cuando se intenta cada uno, entonces el sistema lo rechaza o lo deja correcto, con su prueba de ataque. |
| RF-04 | Dimensiones analíticas con maestro | Should | Dada una dimensión con sus valores, cuando una póliza nombra un valor que no existe, entonces se rechaza; y la balanza por dimensión suma la balanza general. |
| RF-05 | El ciclo de vida de los auxiliares | Should | Dado un activo vendido, una factura de proveedor anulada, una cuenta por cobrar castigada y un documento en moneda extranjera, cuando se registra cada acto, entonces deja su asiento, el auxiliar casa con su cuenta de control a esa fecha y la antigüedad sale por moneda. |
| RF-06 | Inventarios y costo de ventas | Should | Dadas compras y ventas de un artículo, cuando se factura la venta, entonces el costo sale de inventario por el método declarado en el panel y el auxiliar de inventarios casa con su cuenta de control al cierre. |
| RF-07 | Contratos con calendario: arrendamientos y préstamos | Should | Dado un contrato de arrendamiento o un préstamo, cuando corre el cierre del mes, entonces se postean el interés, la depreciación del derecho de uso y la porción que cambia de plazo, y el saldo del pasivo casa con su tabla. |
| RF-08 | El grupo: intercompañía, eliminaciones, consolidación y conversión | Could | Dadas dos entidades de un grupo con saldos entre sí y monedas funcionales distintas, cuando se consolida, entonces los saldos recíprocos se eliminan y el efecto de conversión queda en el resultado integral. |
| RF-09 | Una sola capa de consulta de saldos | Should | Dado el árbol, cuando corre `npm run plan:status`, entonces E4.2 está en verde y CI lo exige. Lo cubre MNE-001-052. |

### 4.2 Multijurisdicción

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-10 | El paquete de jurisdicción existe en el código | Must | Dado un paquete de prueba añadido como carpeta, cuando se registra, entonces se da de alta una entidad de esa jurisdicción, se postea y se cierra un mes, y un criterio comprueba que ningún archivo del motor común cambió. Un país sin paquete no cae a México: se rechaza. |
| RF-11 | La puerta de la entidad | Must | Dada la orden de crear una entidad con un país que tiene paquete, una norma, una moneda funcional y un mes de inicio de ejercicio, cuando se crea, entonces los cuatro quedan como se pidieron y gobiernan el catálogo, el calendario y los informes. |
| RF-12 | La ley, en un solo almacén con vigencia y fuente, cargable por comando | Must | Dado un parámetro legal del ejercicio siguiente importado por comando con su fuente oficial, cuando se calcula un hecho de esa fecha, entonces usa ese valor; sin él, el cálculo falla cerrado y nombra el hueco. Ninguna tasa, tope ni tabla entra sólo por migración. |
| RF-13 | El impuesto indirecto lo pone el paquete | Should | Dada una factura con dos tasas y una retención en una entidad no mexicana, cuando se postea, entonces el motor común pide las líneas de impuesto al paquete y no nombra el IVA; en una entidad mexicana el resultado es idéntico al de hoy. |
| RF-14 | Kit de conformidad por paquete | Should | Dado un paquete, cuando corre CI, entonces un mismo juego de pruebas recorre su mes completo (factura, cobro, banco, activo, devengo, cierre y estados) y falla si el paquete no cumple el contrato. |
| RF-15 | Una tercera jurisdicción real | Could | Dada la jurisdicción que el dueño elija, cuando se entrega su paquete, entonces pasa el kit de conformidad sin cambios en el motor común. Espera D-02. |

### 4.3 Nómina

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-16 | La nómina corre de punta a punta desde el binario | Must | Dada una entidad con empleados, cuando se ejecutan sólo comandos del binario, sin REST ni SQL, entonces el calendario, el periodo, la corrida, el cálculo, la aprobación, la póliza y los recibos quedan hechos, y el paso de nómina de `tests/integration/mvp-month-end-to-end.int.spec.ts` deja de ser `it.todo`. |
| RF-17 | El contrato del módulo de nómina | Must | Dada una corrida calculada y sin aprobar, cuando se recalcula, entonces los recibos se rehacen y los totales salen de los recibos; una falla a media corrida no deja recibos escritos; el orquestador no contiene una bifurcación por país. |
| RF-18 | México calcula las percepciones y cotiza lo que la ley dice | Must | Dados un empleado con su compensación, sus días trabajados y sus incidencias, cuando se calcula el periodo, entonces el sueldo, el salario base de cotización y las cuotas obreras y patronales coinciden con un caso calculado a mano contra la cédula del SUA, y dos corridas del mismo periodo no cotizan dos veces. |
| RF-19 | Terminaciones y obligaciones anuales de México | Should | Dada una baja con antigüedad, cuando se calcula el finiquito o la liquidación, entonces incluye las partes proporcionales, la indemnización que corresponda y el ISR de separación, y queda guardado como corrida con recibo y póliza. Dado el cierre del ejercicio, entonces existen el ajuste anual y la PTU. |
| RF-20 | Lo que se entrega a la autoridad es válido, o no se ofrece | Should | Dado un recibo timbrable, cuando se genera el CFDI de nómina, entonces valida contra el XSD oficial del complemento con los datos de la entidad, sin literales. Un formato que no tiene layout oficial versionado en el repositorio no tiene comando. |
| RF-21 | Los invariantes valen en nómina | Must | Dados el W-2, el lote de movimientos afiliatorios y el timbrado de un recibo, cuando se ejecutan, entonces el SSN no queda guardado en claro, la lectura de empleados lleva alcance de entidad dentro del SQL, y timbrar exige corrida aprobada y recibo sin timbre, con `UPDATE` guardado. |
| RF-22 | Estados Unidos, al nivel que el dueño decida | Could | Dada la decisión D-03, cuando se calcula un recibo de una jurisdicción estadounidense, entonces o usa tablas con fuente y vigencia y pasa los ejemplos publicados por la autoridad, o el sistema se niega con un mensaje que nombra lo que no soporta. |

### 4.4 Cumplimiento NIF

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-23 | El registro de normas y su matriz | Must | Dado el árbol, cuando corre el generador de la matriz, entonces cada norma vigente (NIF y NIIF) aparece con su motor, su comando y su criterio, o declarada sin ellos; `--check` en CI falla si la matriz quedó vieja. |
| RF-24 | Los estados que piden las NIF | Must | Dado un ejercicio de una entidad NIF, cuando se piden sus estados, entonces el de resultado integral trae utilidad bruta, de operación, resultado integral de financiamiento, impuestos a la utilidad y ORI (B-3), existe el de cambios en el capital (B-4) y el balance separa capital contribuido y ganado (B-6), contra un caso escrito a mano. |
| RF-25 | Reglas al postear y al cerrar | Must | Dada una póliza que dispara un aviso normativo, cuando se postea, entonces el hallazgo queda guardado con su norma y se muestra al aprobar. Dado un cierre anual, entonces no pasa sin las casillas de beneficios devengados y revaluación, ni sin las atestaciones de negocio en marcha, hechos posteriores y entorno inflacionario firmadas por una persona. |
| RF-26 | Impuestos a la utilidad (NIF D-4) | Should | Dado un ejercicio con diferencias temporales entre el libro contable y el fiscal, cuando corre el cierre anual, entonces quedan como borrador el impuesto causado y el diferido, con su conciliación contable-fiscal y la de tasa efectiva. |
| RF-27 | Estimaciones y valuación posterior | Should | Dadas una cartera vencida, un activo con indicio de deterioro y una obligación probable, cuando corre el cierre, entonces se proponen la pérdida crediticia esperada (C-16), el deterioro (C-15) y la provisión (C-9) como borradores con su cédula, y el pasivo de beneficios a largo plazo (D-3) entra desde una valuación actuarial externa. |
| RF-28 | Revelaciones y notas | Should | Dado un ejercicio cerrado, cuando se pide el paquete de notas, entonces la nota de políticas sale del panel de decisiones, los anexos salen del mayor y la lista de revelaciones dice cuáles faltan; el agente redacta el borrador y una persona lo aprueba. |

### 4.5 Cumplimiento NIIF

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-29 | La norma de la entidad gobierna, por una sola puerta | Must | Dadas dos entidades iguales, una NIF y otra NIIF, cuando se piden sus estados, sus validaciones y su panel, entonces difieren donde la norma difiere, y un criterio comprueba que ningún motor decide por el país lo que es de la norma. |
| RF-30 | Presentación NIIF | Must | Dado un ejercicio de una entidad NIIF, cuando se piden sus estados, entonces siguen NIC 1 o NIIF 18 según la fecha, y NIC 7, contra un caso escrito a mano. |
| RF-31 | Lo que la norma prohíbe no se puede elegir | Should | Dada una entidad NIIF, cuando se contesta en el panel una opción que su norma no admite (UEPS; depreciar a la tasa fiscal), entonces se rechaza con la cita. |
| RF-32 | Medición NIIF sobre los motores compartidos | Should | Dado cada motor de RF-05 a RF-07, RF-26 y RF-27, cuando la entidad es NIIF, entonces aplica la regla de su norma (NIIF 16, NIC 12, NIIF 9, NIC 36, NIC 2, NIIF 15, NIC 19, NIC 21) y la matriz de RF-23 lo registra. |
| RF-33 | Cambiar de norma y conciliar entre normas | Could | Dada una entidad que adopta NIIF, cuando se registra la transición, entonces queda el asiento de adopción (NIIF 1) y un informe concilia capital y resultado entre el libro NIF y el libro NIIF. |

### 4.6 CLI completo

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-34 | «Completo» se mide por dimensión del objetivo | Must | Dado el catálogo, cuando corre `npm run catalogo:estado`, entonces el avance sale por dimensión (núcleo, jurisdicciones, nómina, NIF, NIIF, IA), las familias que el objetivo no pide quedan fuera del denominador, y el medidor no cuenta como viva una fila cuya bandera no existe ni como muerta una hoja con otro nombre. |
| RF-35 | Ningún motor contable vive sólo en REST | Must | Dado el árbol, cuando corre el censo de paridad, entonces falla si un servicio contable es alcanzable desde el servidor y no desde el binario. Su línea base es la que mida el propio censo al nacer, y sólo baja. |
| RF-36 | Contrato de máquina en toda hoja | Must | Dada cualquier hoja con `--json`, cuando termina bien, entonces su salida es JSON; cuando falla, entonces emite por stderr un sobre con código de salida, clave, parámetros y remedio; y cuando deja algo en una cola de revisión, entonces sale con 11. |
| RF-37 | El binario se instala y se opera solo | Should | Dada una instalación sin el clon del repositorio ni herramientas de desarrollo, cuando se ejecuta el binario, entonces migra su base y carga los parámetros legales con su fuente. |
| RF-38 | El CLI aplica roles y permisos | Should | Dado un usuario sin el permiso de cerrar o reabrir periodos, cuando ejecuta el comando, entonces se rechaza con el mismo catálogo de permisos que usa REST. |
| RF-39 | Reintentar no duplica | Should | Dada una escritura grave ejecutada dos veces con la misma llave de idempotencia, cuando termina la segunda, entonces hay un solo efecto. Empieza por las doce hojas que hoy rechazan la llave. |

### 4.7 Nativo para IA

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-40 | El invariante vale para cualquier agente | Must | Dado un agente que conduce el binario con su propia identidad, cuando intenta postear, aprobar un borrador o escribir en el mayor por cualquier puerta, entonces la base de datos lo rechaza (rol propio sin permiso de escritura sobre el mayor) y las hojas de aprobación exigen una persona o el hash de lo revisado. |
| RF-41 | Un solo registro de comandos | Must | Dado el registro de riesgo del CLI, cuando se generan, entonces de él salen las herramientas del agente embebido y un manifiesto JSON de comandos con riesgo, opciones y códigos de salida; E5.1 queda en verde. Lo cubre en parte MNE-001-391. |
| RF-42 | La cola de aprobaciones se consume por máquina | Should | Dado un borrador en cola, cuando una persona lo aprueba por un comando no interactivo, entonces la aprobación queda atada al hash de lo que vio, igual que en el menú. |
| RF-43 | Sesión reanudable | Should | Dada una sesión interrumpida, cuando se reanuda, entonces el modelo recibe el historial con sus llamadas a herramientas. Lo cubre MNE-001-392. |
| RF-44 | El eval mide lo que se embarca | Should | Dado un cambio al clasificador o a su prompt, cuando corre CI, entonces el eval corre con umbral y bloquea si baja; los casos comparan por rol de cuenta, no por código del catálogo sembrado. |
| RF-45 | Lo que entra y lo que sale del modelo está gobernado | Should | Dado un inquilino con su lista de proveedores de modelo permitidos, cuando una orden pide otro, entonces se rechaza y queda registrado; y un documento con Unicode invisible o instrucciones incrustadas no cambia lo que el agente propone. |

## 5. Requisitos no funcionales

| ID | Requisito | Meta medible |
|---|---|---|
| RNF-01 | Los siete invariantes de `AGENTS.md` no se negocian | Ningún criterio de los paquetes hoy en verde retrocede (`npm run plan:status -- --piso`) |
| RNF-02 | Ningún requisito se da por cumplido sin instrumento | Cada RF de este PRD tiene, al cerrarse, un criterio del plan con su mutante o una prueba que lo ejecuta |
| RNF-03 | El CLI es el producto; REST no crece | Ninguna ruta nueva en `/v1` sin su hoja de CLI; lo vigila el censo de RF-35 |
| RNF-04 | La instalación es segura como dice el alcance | Los respaldos salen cifrados, `npm audit --omit=dev` da cero, y la bóveda de producción funciona en el equipo del despacho o el requisito de nube queda escrito |
| RNF-05 | La entrega fluye | El modelo de ramas descrito existe (D-06); las comprobaciones que los documentos llaman obligatorias lo son; la integración corre en menos de 15 minutos |

## 6. Dentro y fuera de alcance

**Dentro:** lo que nombra la frase del dueño. El núcleo contable con sus auxiliares e informes, los paquetes de jurisdicción, los módulos de nómina, el cumplimiento NIF y NIIF, el CLI como superficie completa y el contrato para agentes.

**Fuera, mientras el dueño no diga otra cosa (D-03, D-04, D-05, D-08):**

- la atestación en blockchain y las cifras públicas;
- el tablero web, que se congela como está: sólo lectura;
- los canales de mensajería;
- el renombrado interno del código al inglés. Sí siguen la superficie por clave y el idioma estatutario por jurisdicción;
- las familias de ERP del catálogo (cotizaciones, pedidos, compras, almacén);
- el corpus US GAAP del agente y la inversión nueva en Estados Unidos;
- el timbrado con PAC, que sigue esperando un contrato con un proveedor;
- presentar ante el SAT, igual que en PRD-001.

## 7. Reutilización y dependencias de plataforma

Informe de contexto, de [`docs/platform/inventory.md`](../platform/inventory.md) y [`docs/platform/harmony-review.md`](../platform/harmony-review.md) (revisión del 2026-09-26). No se volvieron a leer los repos vecinos para este PRD.

| Capacidad | ¿Existe en la plataforma? | Decisión |
|---|---|---|
| Descarga masiva del SAT | Sí, en `sat-services`, duplicada aquí | Sin cambio: ya entregada aquí (E3.2); compartir custodio de la e.firma sigue pendiente allá |
| PDF de estados y recibos | Candidato: `pdf-generator`, aún sin pruebas | RF-02 y RF-28 no dependen de él; el formato de entrega se decide en su diseño |
| Catálogos del SAT | Duplicados en `catalogs` | Sin cambio: este repo mantiene su copia |
| Constancia NOM-151 | `hash-stamper` | Fuera de este PRD (#374) |
| Cálculo de nómina | La revisión de plataforma sólo describe `payroll-extraction-service`, que extrae y no calcula | **Pregunta abierta** antes de aprobar §4.3: confirmar que ningún repo de la organización calcula nómina |
| Identidad | Cognito (ADR-0007) | Sin cambio |

Lo que escriba en Contalink sigue la frontera del ADR-0004.

## 8. Supuestos, riesgos y preguntas abiertas

### Decisiones del dueño

Cada una bloquea los requisitos que la nombran. La recomendación es de quien hizo la revisión; la decisión es del dueño y, cuando se tome, se escribe como ADR o como entrada `decision` del backlog.

| ID | Pregunta | Opciones | Recomendación |
|---|---|---|---|
| D-01 | ¿Una entidad lleva una norma, o libros paralelos? | (a) Una norma por entidad, como hoy. (b) Libros por entidad: asientos comunes más asientos de ajuste por libro (NIF, NIIF, fiscal). | (b), y diseñarlo antes de construir cualquier motor de medición. Una filial mexicana que reporta NIIF a su grupo es el caso normal, no el raro. |
| D-02 | ¿Cuál es la tercera jurisdicción? | (a) Ninguna real todavía: un paquete de prueba en CI basta para probar el contrato. (b) Una jurisdicción de norma NIIF, la que tenga primer cliente. | (a) ahora y (b) cuando haya cliente. El paquete de prueba es parte de RF-10 y no espera. |
| D-03 | ¿Hasta dónde llega Estados Unidos? | (a) Se queda como está, declarando sólo los estados con parámetros sembrados y negando el resto. (b) Nómina federal completa y una lista de estados. (c) Sólo importar nóminas calculadas fuera. | (a) hasta cerrar NIF y NIIF. Hoy registra 51 estados y sólo cinco tienen parámetros. |
| D-04 | ¿Qué se hace con lo que el objetivo no nombra? | Por pieza: retirar, congelar o conservar. | Retirar con ADR la atestación en blockchain y los adaptadores de pago simulados; congelar el tablero web y REST (ninguna ruta nueva); cerrar los canales de mensajería. |
| D-05 | ¿Sigue el renombrado interno al inglés (epic #141)? | (a) Sigue. (b) Se aparcan los tramos internos (identificadores, esquema, vocabulario persistido, contratos) y siguen sólo la superficie por clave y el idioma estatutario. | (b). Son unas 50 tareas que no acercan ninguna dimensión del objetivo y tres de ellas tocan datos de inquilinos y contratos publicados. |
| D-06 | ¿Cuál es el modelo de ramas real? | (a) `develop` pasa a ser la rama por omisión, protegida; `release` se crea en el primer corte. (b) Tronco único en `main`. | (a): conserva el ADR-0008 y es un ajuste del repositorio. Hoy `release` no existe, `main` va 53 commits atrás, no hay tags y Dependabot abre sus PRs contra `main`. |
| D-07 | ¿Qué superficie tienen los agentes externos? | (a) El manifiesto JSON del CLI. (b) Además, un servidor MCP derivado del mismo registro. | (a) primero; (b) después, con su dependencia justificada. |
| D-08 | ¿Qué prioridad tiene la plataforma Sedecim (PRD-002, #379) frente a este objetivo? | (a) Carril propio, sin prioridad sobre el objetivo. (b) Antes. | (a). |
| D-09 | ¿Los movimientos afiliatorios y la dispersión son parte de la nómina? | (a) Los movimientos ante el IMSS sí, con su layout oficial; la dispersión bancaria va a pagos. (b) Ninguno. | (a): alta, baja y cambio de salario son la otra mitad del salario base de cotización. |

### Riesgos

- **El tamaño.** Esto es más trabajo que todo PRD-001. Sin D-01 y sin el paquete de jurisdicción (RF-10), los motores nuevos se construirían sobre el país y habría que rehacerlos.
- **El orden importa más que la velocidad.** Primero se cierra el MVP (#311), después los cimientos (D-01, RF-10, RF-17, RF-23, RF-41), después los motores.
- **La ley se verifica en su fuente.** Varias brechas de nómina (cuotas patronales por tramo, subsidio al empleo que excede al ISR) salen de la investigación del propio repositorio, no del texto oficial. Cada una se confirma contra su fuente antes de tocar el cálculo.
- **Capacidad de revisión.** `docs/PROCESS.md` limita a dos los PRs de agente abiertos por revisor humano. Este plan no cabe en ese límite sin el orquestador (#332) o sin cambiar la regla.

### Lo que no espera ninguna decisión

Defectos confirmados y desbloqueos, que van directo por `docs/PROCESS.md` como issues con su Definition of Ready:

1. La prueba de aceptación del MVP (#311, MNE-001-098).
2. El binario registra los calculadores de nómina y tiene hojas para calendario y periodos (RF-16).
3. Los cinco caminos de RF-03 y las tres faltas de RF-21.
4. La lectura de un XML por id y el archivado de una entidad llevan alcance (RNF-01).
5. Los respaldos salen cifrados (RNF-04).
6. El censo de paridad REST–CLI (RF-35) y los errores en JSON (RF-36).
7. La matriz de normas, primero como instrumento que dice «sin motor» (RF-23).

## 9. Aprobaciones

Pendiente. Este PRD no se aprueba con D-01 abierta, porque bloquea RF-01, que es `Must`, ni sin contestar la pregunta de §7 sobre el cálculo de nómina en la plataforma, que condiciona §4.3. El diseño de sistema (SD-003) y el backlog se escriben después de la aprobación, como pide [`docs/prd/README.md`](README.md).
