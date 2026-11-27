# PRD-001 — El MVP: el mes completo de una PyME, desde el CLI

Estado: aprobado · Versión: 1.1 (enmienda del 27 nov 2026, §10) · Owner: @vic2099
Fuentes: [`docs/SCOPE.md`](../SCOPE.md), «El MVP», y [`docs/MVP.md`](../MVP.md) §1–§4. Este PRD **no añade alcance ni decisiones**: traduce a requisitos identificados lo que esos dos documentos ya fijaron, para que el backlog ([`docs/backlog/PRD-001.md`](../backlog/PRD-001.md)) pueda apuntar a ellos. Si este PRD y `docs/MVP.md` no coinciden, manda `docs/MVP.md` y este se corrige.

## 1. Problema y objetivo

Un despacho contable necesita llevar el ciclo mensual completo de un cliente PyME mexicano (persona moral, régimen general) sin salir de la terminal ni rehacer nada en una hoja aparte. El motor contable ya recorre el mes; faltan el circuito CFDI → mayor y las salidas fiscales del mes (`docs/MVP.md` §2).

## 2. Métricas de éxito

- **La única que entrega el MVP:** el criterio ▶ de #311 en verde en CI. Recorre por el CLI el mes de una PyME sintética contra una base efímera, y cada cifra coincide al centavo con una escrita a mano (RF-10).
- `npm run plan:status`: ningún paquete exigido retrocede.

## 3. Usuarios y roles

El contador del despacho, que opera el CLI, y el dueño o auditor del despacho, que aprueba lo que el agente propone.

## 4. Requisitos funcionales

| ID | Requisito | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-01 | Alta y migración | Must | Dado el XML del Anexo 24 del sistema anterior, cuando el contador migra, entonces quedan la entidad con RFC y régimen, el catálogo con código agrupador, la balanza de apertura y los documentos abiertos. |
| RF-02 | CFDI → mayor | Must | Dados los CFDI emitidos y recibidos del mes (PUE, PPD y REP), cuando se ingieren, entonces cada uno llega al mayor con su naturaleza correcta, propuesto por el agente y aprobado por una persona, o por el camino manual sin modelo. |
| RF-03 | CxC y CxP | Must | Dados cobros, pagos, notas de crédito, anticipos y retenciones, cuando se registran, entonces los saldos a una fecha cuadran con su cuenta de control. |
| RF-04 | Banco y conciliación | Must | Dado el estado de cuenta, cuando se importa y se concilia, entonces la primera sesión parte de una línea base y una sesión cerrada se puede reabrir. |
| RF-05 | Nómina básica | Must | Dada una quincena, cuando se corre desde la terminal, entonces salen ISR con subsidio, IMSS, INFONAVIT, ISN, el asiento y el SUA. |
| RF-06 | Cierre | Must | Dado el mes, cuando se cierra, entonces corren devengos y depreciación, el checklist bloquea lo pendiente, y `closing run` produce el expediente; al cierre del ejercicio, el periodo 13. |
| RF-07 | Estados financieros | Must | Dado el mes cerrado, cuando se piden, entonces salen balanza, estado de resultados, balance y flujo de efectivo, cuadrados entre sí. |
| RF-08 | Obligaciones del mes | Must | Dado el mes cerrado, cuando se generan, entonces salen el catálogo y la balanza XML del Anexo 24, la DIOT en un archivo que el SAT recibe, y el papel de trabajo de IVA definitivo e ISR provisional. Si el despacho declara `sellar_con_custodia`, el catálogo y la balanza salen sellados con la e.firma; la presentación sigue siendo manual, en el portal (#442). |
| RF-09 | Operación segura | Must | Dado un despacho con varios inquilinos y entidades, cuando opera, entonces ninguno ve datos de otro, y un respaldo se restaura y pasa los chequeos del mayor. |
| RF-10 | El mes de punta a punta | Must | Dado el mes sintético, cuando corre el criterio ▶ de #311, entonces los nueve pasos anteriores pasan por el CLI, y cada cifra coincide al centavo con una cifra escrita a mano. |
| RF-11 | Completitud de CFDI | Must | Dado el censo del SAT del periodo (el ZIP o los metadatos que baja el despacho), cuando se concilia, entonces el despacho sabe el estado de cada CFDI del censo: falta traerlo, falta contabilizarlo o cuadra. Además, con la e.firma de la bóveda, el sistema descarga del SAT los XML y los metadatos del periodo y detecta las cancelaciones; esos paquetes alimentan el mismo censo (decisión del dueño del 2026-09-28, #312; #439, #440, #441). |
| RF-12 | La superficie en español | Should | Dado un contador en `es-MX`, cuando lee el panel de políticas o la ayuda del CLI, entonces la lee en su idioma y por clave. |
| RF-13 | Puesta en marcha sin fricción | Should | Dado un despacho nuevo, cuando se da de alta con sus usuarios sin TTY y sigue los manuales, entonces opera el mes sin ayuda del equipo. |
| RF-14 | Lo que entró a la liberación 1.0 desde la ola 4 | Should | Dada una tarea que el 2026-11-27 pasó de la ola 4 a la 3 (§10), cuando se construye, entonces sirve al requisito de esta tabla que su issue nombra, conserva este identificador como registro de su origen y dice en su aceptación por qué cambió de ola. Hasta ese día este requisito era «Lo que sigue al MVP», de prioridad Could (revisión de las 105 issues, 2026-09-30). |

## 5. Requisitos no funcionales

| ID | Requisito | Meta medible |
|---|---|---|
| RNF-01 | La IA nunca escribe el mayor ni sistemas externos (invariante 1) | Ningún criterio de E5.1 que hoy está en verde retrocede (lo vigila `npm run plan:status -- --piso` sobre `docs/criterios-minimos.json`; el estado lo da `npm run plan:status`, y los dos rojos nombrados quedan fuera de la cuenta); ninguna herramienta nueva salta `ai_drafts` ni `ai_external_ops`. Los dos rojos (herramientas del agente derivadas del registro de riesgo; rehidratación de `--continue`) quedan después del MVP (#378, MNE-001-132) |
| RNF-02 | Entrega sin atascos | Los criterios se evalúan una vez por corrida; el tablero no es el archivo donde chocan todos los PRs |
| RNF-03 | Terminal predecible | Gramática, salida y códigos de salida uniformes entre familias de comandos |
| RNF-04 | Encaja en la plataforma Sedecim | Acepta la identidad del IdP de la plataforma, se despliega por su camino y ninguna superficie promete lo que no hace (`docs/MVP.md` §3, «Armonía con la plataforma») |

## 6. Dentro y fuera de alcance

**Fuera,** declarado en `docs/MVP.md` §1:

- una interfaz gráfica nueva (#117): el tablero web y la API REST que existen se quedan;
- presentar ante el SAT la contabilidad electrónica, la DIOT o las declaraciones: se hace en el portal, porque el SAT no ofrece un servicio web público para eso. Descargar con la e.firma y sellar el Anexo 24 sí entran desde el 2026-09-28 (RF-08, RF-11, #312).

**Dentro desde el 2026-11-27** (§10): el timbrado y la cancelación con PAC, lo que el backlog tenía de Estados Unidos, los canales de mensajería, el carril de la plataforma y el renombrado interno del código al inglés.

## 7. Reutilización y dependencias de plataforma

Ningún contrato con otros repos de Sedecim todavía. La revisión del 2026-09-26 (`docs/platform/harmony-review.md`) identifica productores candidatos (Cognito, `hash-stamper`, `sat-services`, OCR, `pdf-generator`) y lo que falta para integrarse (RNF-04). Contalink es externo. Este repo escribe en él sólo por la cola revisada `ai_external_ops` y nunca en una compañía que ya tiene otro escritor: la de Grupo Promessa es de `accounting-manager` (ADR-0004, #357).

## 8. Supuestos, riesgos y preguntas abiertas

Las decisiones del dueño que bloquean tareas están en `docs/MVP.md` §4. En el backlog, cada decisión es una entrada con `"type": "decision"` y su `owner`. Una tarea que la espera la nombra en su `depends_on`, y por eso nunca cae en S1, que es el sprint de las decisiones.

## 9. Aprobaciones

Aprobado por el owner al fijar el MVP en `docs/MVP.md` (PR #291). Este PRD sólo lo indexa. La enmienda del 27 nov 2026 (§10) registra la instrucción del dueño de ese día; el dueño la revisa en el PR que la trae y puede corregir cualquier línea.

## 10. Enmienda del 27 de noviembre de 2026

El dueño cambió el alcance de este PRD el 2026-11-27, con tres mensajes en la sesión del coordinador, transcritos en #329 (comentario 7210598786) y registrados en el backlog como MNE-001-860: «El MVP se puede aplazar pero incluyamos la conciliación bancaria»; «Revisa los issues ye integra todo lo de la versión 1.0 al MVP. Revisa todo el código creado, y revisa todas las normas contables y fiscales que debe de llevar un sistema core contable como este. Y una vez armonizado, traza una ruta para llegar a la liberación del sistema y ejecuta la.»; y «Para el 1.0 desaparca lo aparcado».

Lo que cambia:

- **La entrega.** La Ola 3 es la liberación 1.0 y lleva toda tarea abierta del backlog menos dos, la MNE-001-201 y la MNE-001-207, que cierran una ventana de alias una versión después de la 1.0 y se quedan en la ola 4. El MVP de pruebas (lo Must de las olas 0 a 3 con la prueba de #311 en verde) se cumplió en el backlog ese día. La métrica de §2 no cambia: sin el criterio ▶ de #311 en verde no hay entrega.
- **El alcance.** Lo de la versión 1.0 y lo que registró la revisión de normas contables y fiscales de ese día entran al MVP. El timbrado y la cancelación con PAC salen de «Fuera» (§6), y con ellos lo que estaba aparcado: Estados Unidos, los canales, la plataforma y el renombrado interno. Sigue fuera lo que §6 conserva.
- **A qué requisito sirve cada trabajo.** Las tareas que ya existían conservan RF-14, reescrito en §4. Las tareas nuevas de ese día cuelgan de los requisitos que ya existían, RF-01 a RF-13 y RNF-01 a RNF-04: no usan RF-14 y no se añade ningún identificador de requisito:

| Trabajo | Requisito |
|---|---|
| Timbrado, cancelación y REP emitido (#105, #696) | RF-02 |
| El devengo, la PTU y el ISR del ejercicio (#111) | RF-06 |
| La jurisdicción como dimensión y la ley con vigencia (#123) | RF-01 y RF-05 |
| La pensión alimenticia y los parámetros de nómina de 2027 (#113, #953) | RF-05 |
| El `Concepto` del Anexo 24 en español (#158) | RF-08 |
| El publicador de cifras y el anclaje NOM-151 (#251, #374) | RNF-04 |
| La terminal como servicio remoto (#952) | RNF-03 y RF-09 |
| Lo que registró la revisión de normas | El requisito del paso del mes que corrige (RF-01 a RF-11) |
| La liberación: el corte, la versión, la instalación, la actualización y la evidencia (#1080) | RNF-02, RF-13 y RF-09 |

Esta enmienda es la instrucción del dueño, registrada aquí para su revisión en el PR que la trae. Este PRD sigue sin añadir decisiones propias: indexa las de `docs/MVP.md`, que manda si los dos no coinciden.
