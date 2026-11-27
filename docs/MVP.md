# MVP: el mes de una PyME mexicana, de punta a punta, en la terminal

> Este documento dice **qué es el MVP y cómo llegar**. La lista viva de issues está en la issue de seguimiento [#329](https://github.com/sedecim-com/Accounting/issues/329), que GitHub marca sola conforme se cierran las tareas. El estado del sistema no se escribe aquí: se pregunta con `npm run plan:status` y `npm run catalogo:estado`, como manda [`AGENTS.md`](../AGENTS.md).
>
> Las cifras de la sección 2 son una **foto fechada** (2026-09-25, `main` en `d1420ab`), no un estado. Sirven para saber de dónde se partió, no para citarlas.

## 1. Qué es el MVP

**Un despacho lleva, desde el CLI y con cifras correctas, el ciclo mensual completo de un cliente PyME mexicano** (persona moral, régimen general), sin salir de la terminal ni rehacer nada en una hoja aparte:

| # | Paso del mes | Qué tiene que poder hacer el contador |
|---|---|---|
| 1 | Alta y migración | Crear la entidad con su RFC y su régimen. Cargar el catálogo con código agrupador, la balanza de apertura y los documentos abiertos desde el sistema anterior (XML del Anexo 24). |
| 2 | CFDI → mayor | Ingerir los emitidos y los recibidos del mes, incluidos PUE, PPD y REP. El agente propone y una persona aprueba; y existe el camino manual, sin modelo. Con el censo del SAT del periodo, saber qué CFDI faltan por traer o por contabilizar. |
| 3 | CxC y CxP | Cobros, pagos, notas de crédito, anticipos, retenciones y saldos a una fecha que cuadran con su cuenta de control. |
| 4 | Banco | Importar el estado de cuenta y conciliar, con línea base en la primera sesión y la posibilidad de reabrir. |
| 5 | Nómina básica | Correr una quincena desde la terminal: ISR con subsidio, IMSS, INFONAVIT, ISN, asiento y SUA. |
| 6 | Cierre | Devengos, depreciación y checklist bloqueante, con `closing run`, expediente y periodo 13 al cierre del ejercicio. |
| 7 | Estados financieros | Balanza, estado de resultados, balance y flujo de efectivo. |
| 8 | Obligaciones del mes | Catálogo y balanza XML del Anexo 24, la DIOT en archivo que el SAT reciba, y el papel de trabajo de IVA definitivo e ISR provisional. |
| 9 | Operación segura | Aislamiento por inquilino y por entidad, y un respaldo probado por restauración. |

**La prueba de aceptación es una, y ejecutable:** [#311](https://github.com/sedecim-com/Accounting/issues/311). El mes de una PyME sintética recorre esos nueve pasos por el CLI, contra una base efímera y con cifras escritas a mano, como criterio ▶ del tablero. Mientras esa prueba no esté en verde en CI, el MVP no está entregado, diga lo que diga cualquier documento, este incluido. Se puede empezar ya, con un `it.todo` por cada issue abierta, y así la ruta se vacía sola.

**El MVP sale en dos cortes.** Lo decidió el dueño el 2026-11-18 ([#644](https://github.com/sedecim-com/Accounting/issues/644), MNE-001-547): «Hagamos las 55 obligatorias para un MVP de pruebas y luego las 137 para el mvp final».

- **MVP de pruebas:** las tareas Must de las olas 0 a 3, con la prueba de [#311](https://github.com/sedecim-com/Accounting/issues/311) en verde. **Se cumplió en el backlog el 2026-11-27**: ese día no quedaba ninguna tarea Must abierta en las olas 0 a 3 y la prueba de #311 corría completa en la CI, exigida en cada PR (E6.1).
- **MVP final:** todas las tareas de las olas 0 a 3. Desde el 2026-11-27 no es una entrega aparte: es la **liberación 1.0**, la entrega de la Ola 3.

Las cifras 55 y 137 son las de aquel día, de la ruta escrita en [#329](https://github.com/sedecim-com/Accounting/issues/329); las de hoy se preguntan a [`docs/backlog/PRD-001.md`](backlog/PRD-001.md). **Del 2026-11-18 al 2026-11-27 la v1.0 fue el hito que seguía al MVP**: preguntado qué era «MVP2», el dueño contestó «es 1.0» ([#603](https://github.com/sedecim-com/Accounting/issues/603), MNE-001-548). **El 2026-11-27 la integró al MVP y desaparcó lo aparcado**, con tres mensajes en la sesión del coordinador, transcritos en [#329](https://github.com/sedecim-com/Accounting/issues/329) (comentario 7210598786, MNE-001-860): «El MVP se puede aplazar pero incluyamos la conciliación bancaria»; «Revisa los issues ye integra todo lo de la versión 1.0 al MVP. Revisa todo el código creado, y revisa todas las normas contables y fiscales que debe de llevar un sistema core contable como este. Y una vez armonizado, traza una ruta para llegar a la liberación del sistema y ejecuta la.»; y «Para el 1.0 desaparca lo aparcado». Lo que lleva está en la sección 3, «La liberación 1.0».

**Fuera de la liberación 1.0, declarado:**

- **Una interfaz gráfica nueva** ([#117](https://github.com/sedecim-com/Accounting/issues/117)). El tablero web del PR #249 y la API REST se quedan y pueden ganar funciones (D-04 de PRD-003, enmendada el 2026-11-18, MNE-001-544). Ningún mensaje del dueño trajo una interfaz nueva, y #117 no tiene tareas abiertas en el backlog.
- **Presentar ante el SAT.** Sigue manual, por el portal, como dice el último punto de esta sección.
- **Lo que PRD-003 pide y todavía no tiene tarea.** Entra cuando ese PRD esté aprobado y tenga su diseño y su backlog ([docs/prd/README.md](prd/README.md)).

**Entró a la liberación el 2026-11-27.** Estaba fuera del MVP o aparcado, y nada se había retirado:

- **Timbrado y cancelación con PAC** ([#105](https://github.com/sedecim-com/Accounting/issues/105), con [#115](https://github.com/sedecim-com/Accounting/issues/115) plegada en ella): Sovos primero, varios proveedores tras un mismo contrato y la llave de cada uno agregada por el administrador (MNE-001-534). Mientras no esté construido, los CFDI los emite el cliente en su sistema, y aquí se ingieren.
- **Estados Unidos**, en lo que el backlog ya tenía escrito ([#124](https://github.com/sedecim-com/Accounting/issues/124), [#131](https://github.com/sedecim-com/Accounting/issues/131) y lo demás que D-03 aparcó). D-03 no cambia: los cinco estados sembrados, y el resto negado.
- **Los canales de mensajería** ([#116](https://github.com/sedecim-com/Accounting/issues/116)).
- **El carril de la plataforma Sedecim** ([#371](https://github.com/sedecim-com/Accounting/issues/371), [#372](https://github.com/sedecim-com/Accounting/issues/372), [#379](https://github.com/sedecim-com/Accounting/issues/379); D-08). El despliegue mismo sigue dependiendo de la plataforma.
- **El renombrado del código al inglés**, tramos I12 a I26 (epic [#141](https://github.com/sedecim-com/Accounting/issues/141), D-05, MNE-001-538). Va al final de la liberación, en una ventana sin otros PR de código abiertos sobre los archivos que renombra, porque un renombrado choca con todo PR en vuelo. Lo que lee una persona ya estaba en la Ola 3: el panel de políticas ([#152](https://github.com/sedecim-com/Accounting/issues/152)) y, desde que el dueño contestó «Las dos mitades (recomendada)» el 2026-11-16 (D14, «English first Spanish u otro lenguaje second», en #141), la secuencia de D14 (#651 a #659), la ayuda del CLI ([#314](https://github.com/sedecim-com/Accounting/issues/314)) con sus ejemplos, las hojas del CLI por clave (I8, #263 a #271) y las cadenas inglesas que el CLI imprime sin clave (I8b, [#150](https://github.com/sedecim-com/Accounting/issues/150)), los mensajes de servicio y de la API que llegan a quien hace la petición (I9, [#151](https://github.com/sedecim-com/Accounting/issues/151)), `doctor` y las líneas fijas del agente ([#153](https://github.com/sedecim-com/Accounting/issues/153)), con lo que necesitan antes: los carriles de #150 y #151 y el `[y/N]` del kernel ([#262](https://github.com/sedecim-com/Accounting/issues/262)).
**Dentro del MVP desde el 2026-09-28: la e.firma descarga del SAT y sella.** El dueño decidió ([#312](https://github.com/sedecim-com/Accounting/issues/312), MNE-001-140): «para efectos de scope del proyecto considera que sí se va a usar [la e.firma] para descargar y firmar… revisa el proyecto y mejora lo que se pueda automatizar con esta posibilidad.» Eso reemplaza la decisión del 2026-09-26, que dejaba la descarga automática después del MVP.

- **Descargar:** la autenticación con la e.firma ([#439](https://github.com/sedecim-com/Accounting/issues/439)), la descarga masiva de XML y metadatos con sus comandos ([#440](https://github.com/sedecim-com/Accounting/issues/440)) y la sincronización diaria de metadatos que detecta cancelaciones ([#441](https://github.com/sedecim-com/Accounting/issues/441)). El censo por ZIP o metadatos del portal (MNE-001-096 y 119) se queda, y la descarga lo alimenta por el mismo lector. E3.2 sigue en rojo mientras el motor no exista.
- **Sellar:** el catálogo y la balanza del Anexo 24, con la e.firma, cuando el despacho declara `sellar_con_custodia` ([#442](https://github.com/sedecim-com/Accounting/issues/442)). El valor por omisión de la política sigue siendo `nunca_sellar_en_el_sistema`.
- **El consentimiento** que firma el contador al entregar su e.firma dice ambos usos antes de que el sistema la use ([#313](https://github.com/sedecim-com/Accounting/issues/313)).
- **Sigue manual, por el portal del SAT:** presentar la contabilidad electrónica, la DIOT y las declaraciones, el buzón tributario, la opinión de cumplimiento (32-D) y la constancia. El SAT no ofrece un servicio web público para eso, y no se raspa el portal.

## 2. De dónde se parte (foto del 2026-09-25)

**Lo que se midió:**

- `plan:status` con base de datos:
  - 11 de 15 paquetes en verde;
  - 198 criterios, de los cuales 6 ejecutan el camino real contra una base efímera;
  - en rojo: E3.2 (no hay descarga masiva), E4.1 (nadie escribe los embargos; lo cierra el PR #272), E4.2 (cinco copias del SQL de saldos) y dos de E5.1.
  - Sin base de datos el mismo comando responde **10 de 15**, porque E0.1 no se puede evaluar. Mide siempre con base: ver la sección 7.
- `catalogo:estado`: el binario ejecuta 233 comandos en 65 familias; 218 de las 1 634 filas del catálogo ya se pueden invocar, 197 de ellas de fase 1.
- `npm test`: 295 archivos y 6 700 pruebas en verde. Lint sin errores, con 1 093 advertencias bajo el tope de 1 106.

**Lo que dio el recorrido real del CLI** (una PyME sintética, Postgres 16, sin llave de IA):

| Paso | Hoy | Lo que falta |
|---|---|---|
| Alta, asiento manual, CxC y CxP capturadas, cierre suave, estados financieros, respaldo, aislamiento | ✅ funcionan | Detalles en [#327](https://github.com/sedecim-com/Accounting/issues/327) |
| Migrar desde el Anexo 24 | ❌ el motor existe, pero no hay comando | [#220](https://github.com/sedecim-com/Accounting/issues/220), [#310](https://github.com/sedecim-com/Accounting/issues/310) |
| CFDI → mayor | ❌ tres defectos bloqueantes | Aprobar no crea la factura ([#318](https://github.com/sedecim-com/Accounting/issues/318)); lo emitido entra como gasto ([#320](https://github.com/sedecim-com/Accounting/issues/320)); sin modelo, los CFDI quedan varados ([#319](https://github.com/sedecim-com/Accounting/issues/319)) |
| Banco | 🟡 la primera sesión arrastra toda la historia del mayor | [#324](https://github.com/sedecim-com/Accounting/issues/324) |
| Depreciación | ❌ no hay categorías de activo, y el checklist sale verde | [#322](https://github.com/sedecim-com/Accounting/issues/322) |
| Balanza XML | 🟡 las cuentas de mayor salen en cero | [#323](https://github.com/sedecim-com/Accounting/issues/323) |
| DIOT, IVA/ISR del mes, nómina, pólizas XML | ❌ o sólo papel de trabajo | [#307](https://github.com/sedecim-com/Accounting/issues/307), [#308](https://github.com/sedecim-com/Accounting/issues/308), [#306](https://github.com/sedecim-com/Accounting/issues/306), [#328](https://github.com/sedecim-com/Accounting/issues/328) |

**En resumen:** el motor contable ya recorre el mes. Lo que falta es, sobre todo, el **circuito CFDI → mayor**, que es la razón de ser del producto, y **las salidas fiscales del mes**.

## 3. La línea de trabajo: cuatro olas

Cada ola es una **etapa** y marca una **entrega**: la entrega N sale cuando está hecho todo lo de las olas ≤ N. Las olas no frenan el calendario. Lo decidió el dueño el 2026-09-29, para hacer en paralelo todo lo posible: una tarea entra en el primer sprint después del de todo lo que necesita, sea de la ola que sea, con un tope de dos tareas por carril (los carriles se parten por los archivos que tocan, y así los PRs no chocan) y ninguno por sprint. Si un carril se llena, entra primero la ola más temprana. Reemplaza la regla del 2026-09-28, que no abría una ola hasta tener en el calendario toda la anterior; en los datos de ese día, el último sprint pasa de S12 a S7.

| Ola | Etapa | Entrega |
|---|---|---|
| 0 | Desbloquear | R0 · la entrega fluye |
| 1 | Que el mes cuadre | R1 · MVP α: el mes cuadra en la terminal |
| 2 | Lo que falta construir | R2 · MVP β: nómina, DIOT, papel de trabajo, retenciones y moneda extranjera |
| 3 | La liberación 1.0 | 1.0 · el MVP con la v1.0, las normas y lo que estaba aparcado |
| 4 | Después de la 1.0 | Después de la 1.0 · lo que se registre después de la liberación |

La entrega de la Ola 3 se llamaba «v1.0» hasta el 2026-11-18. Desde ese día es el **MVP final**, y la v1.0 es el hito que le sigue. El backlog guarda en una ola más, la 4 («Después del MVP»), lo que es alcance de la v1.0 junto con lo aparcado; cada tarea de la v1.0 lo dice en su aceptación. Desde el 2026-11-27 la Ola 3 es la **liberación 1.0** y lleva toda tarea abierta menos dos, y la Ola 4 queda para esas dos y para lo que se registre después (MNE-001-860). Lo que esa ola única ya no ordena está escrito en la aceptación de cada tarea: el renombrado interno va al final, en su ventana, y una tarea con fecha o que espera a un tercero conserva su compuerta.

Lo entregado hasta el 2026-09-27 es **S1**; el trabajo abierto empieza en **S2**, el 2026-09-28. Una tarea no puede depender de otra de una ola posterior, porque su entrega esperaría a una posterior: `scripts/backlog.ts` lo rechaza.

**El detalle tarea por tarea** está en [`docs/backlog/PRD-001.md`](backlog/PRD-001.md). Ahí cada issue de estas olas está partida en tareas atómicas `MNE-001-nnn`, con prioridad, dependencias y sprint sugerido, calculado por `scripts/backlog.ts`.

### Ola 0 · Desbloquear (horas, casi sin código de producto)

Vaciar la cola de PRs en el orden de la sección 5. Después:

- vitest 5 con Node 22 en un solo PR ([#292](https://github.com/sedecim-com/Accounting/issues/292));
- los criterios se evalúan una vez por corrida y los timeouts dejan de subir ([#293](https://github.com/sedecim-com/Accounting/issues/293));
- partir el tablero en un archivo por paquete ([#294](https://github.com/sedecim-com/Accounting/issues/294)). Es el habilitador de velocidad más grande: casi todos los conflictos entre PRs ocurrían en `src/plan/criterios.ts`. Se decidió el 2026-09-26 y va en cuatro PRs; los dos primeros ya están en `main` (#360, #362).
- Las **decisiones del dueño** de la sección 4 ya están contestadas, salvo la sesión de firma de #337.

### Ola 1 · Que el mes cuadre

Defectos en el camino del MVP, repartidos en **carriles** que tocan archivos distintos y pueden correr en paralelo, un issue por carril a la vez:

| Carril | Issues, en orden | Dónde viven |
|---|---|---|
| A · Alta y migración | #220 → #219 → #321 → #322 | `src/services/accounting/` (importación y apertura), `src/services/assets/` |
| B · CFDI → mayor | #318 → #320 → #319 → #299 y #218 → #102 → #284 | `src/services/xml-ingestion/`, `src/ai/draft-service.ts` |
| C · CxC y CxP | #94 → #98 | `src/services/ar/`, `src/services/ap/`, `period-close.ts` (checklist) |
| D · Banco | #324 → #95 → #138 → #128 → #302 | `src/services/banking/` |
| E · Cierre y salidas | #99 → #304 → #323 (junto con #100) | `src/services/accounting/period-close.ts`, `src/services/sat/anexo24/` |
| F · Nómina MX | #296 → #297 → #298 → #242 | `src/services/payroll/` |
| G · Panel y agente | #300 → #301 → #93 → #303 | `src/services/policy/`, `src/ai/` |

Los carriles C y E comparten `period-close.ts`: el checklist lo toca #98, y el arrastre, #99. Conviene que no corran a la vez.

### Ola 2 · Lo que falta construir

- nómina MX en la terminal ([#306](https://github.com/sedecim-com/Accounting/issues/306));
- la DIOT en archivo que el SAT reciba ([#307](https://github.com/sedecim-com/Accounting/issues/307), después de #284);
- el papel de trabajo de IVA e ISR ([#308](https://github.com/sedecim-com/Accounting/issues/308));
- las retenciones ([#309](https://github.com/sedecim-com/Accounting/issues/309));
- los documentos abiertos en la migración ([#310](https://github.com/sedecim-com/Accounting/issues/310), después de #220);
- la factura en moneda extranjera y la revaluación ([#305](https://github.com/sedecim-com/Accounting/issues/305));
- el consentimiento de la e.firma que dice descarga y sellado ([#313](https://github.com/sedecim-com/Accounting/issues/313)) y la autenticación con el SAT ([#439](https://github.com/sedecim-com/Accounting/issues/439));
- la zona de salario mínimo de la entidad ([#196](https://github.com/sedecim-com/Accounting/issues/196)) y el ISR de separación del finiquito ([#194](https://github.com/sedecim-com/Accounting/issues/194)): entran antes del MVP por las respuestas del dueño del 17 y del 18 de noviembre, junto a la cesantía y vejez por tramo ([#661](https://github.com/sedecim-com/Accounting/issues/661));
- el registro de declaraciones presentadas, del que sale el saldo a favor del papel de trabajo ([#308](https://github.com/sedecim-com/Accounting/issues/308), MNE-001-533).

### Armonía con la plataforma (revisión del 2026-09-26)

La revisión de los repos de `sedecim-com` ([`platform/harmony-review.md`](platform/harmony-review.md)) deja cinco trabajos en este repo:

- aceptar los access tokens de Cognito ([#369](https://github.com/sedecim-com/Accounting/issues/369)), Ola 1;
- que el adaptador S3 deje de prometer lo que no hace ([#370](https://github.com/sedecim-com/Accounting/issues/370)), Ola 1;
- la decisión de identidad de plataforma ([#371](https://github.com/sedecim-com/Accounting/issues/371));
- la imagen y los workflows desplegables como los demás servicios ([#372](https://github.com/sedecim-com/Accounting/issues/372)), después del MVP desde el 2026-11-18;
- `migrate` con candado ([#373](https://github.com/sedecim-com/Accounting/issues/373)), Ola 3.

El despliegue mismo depende de la plataforma (Postgres gestionado, IAM y namespaces propios, `/mnemosine/` en el gateway) y no entra en la definición de terminado.

### Ola 3 · La liberación 1.0

Primero, lo que ya era del MVP:

- [#311](https://github.com/sedecim-com/Accounting/issues/311), el mes de punta a punta; conviene **empezarla en la Ola 1**, con `it.todo`.
- El censo del SAT contra lo contabilizado ([#312](https://github.com/sedecim-com/Accounting/issues/312)), alimentado también por la descarga automática ([#440](https://github.com/sedecim-com/Accounting/issues/440), [#441](https://github.com/sedecim-com/Accounting/issues/441)).
- El sellado del Anexo 24 con la e.firma bajo `sellar_con_custodia` ([#442](https://github.com/sedecim-com/Accounting/issues/442)).
- El español del panel y de la ayuda ([#152](https://github.com/sedecim-com/Accounting/issues/152), [#314](https://github.com/sedecim-com/Accounting/issues/314)).
- Inglés primero (D14, epic [#141](https://github.com/sedecim-com/Accounting/issues/141)), en lo que lee una persona: la secuencia de #651 a #659, los ejemplos de la ayuda, las hojas I8 (#263 a #271), I8b ([#150](https://github.com/sedecim-com/Accounting/issues/150)), I9 ([#151](https://github.com/sedecim-com/Accounting/issues/151)), `doctor` y las líneas fijas del agente ([#153](https://github.com/sedecim-com/Accounting/issues/153)) y el `[y/N]` del kernel ([#262](https://github.com/sedecim-com/Accounting/issues/262)), como dice §1.
- El traspaso acordado de saldo a cuenta entre clientes ([#695](https://github.com/sedecim-com/Accounting/issues/695)), que el dueño puso antes del MVP el 2026-11-17. Es una D4, y avanza sin segunda persona mientras el producto sea experimental ([`ROUTING.md`](ROUTING.md)).
- El trinquete por archivo de los comentarios en español (MNE-001-187, [#162](https://github.com/sedecim-com/Accounting/issues/162)) y el README con fuente inglesa y gemela española (MNE-001-192, [#164](https://github.com/sedecim-com/Accounting/issues/164)), que siguen ahora por las respuestas del 2026-11-18.
- Los manuales ([#325](https://github.com/sedecim-com/Accounting/issues/325)).
- El alta de despacho y de usuarios sin TTY ([#326](https://github.com/sedecim-com/Accounting/issues/326)).
- La gramática de la terminal ([#327](https://github.com/sedecim-com/Accounting/issues/327)).
- Y lo deseable: #328, #315, #317, #100, #101, #215, #231, #133.

### Lo que entró a la Ola 3 el 2026-11-27

Por los tres mensajes del dueño de ese día (sección 1; [#329](https://github.com/sedecim-com/Accounting/issues/329), MNE-001-860). En el backlog eran tareas de la ola 4, y cada una dice en su aceptación por qué cambió:

- lo que el dueño había puesto en la v1.0 el 2026-11-18 ([#603](https://github.com/sedecim-com/Accounting/issues/603), MNE-001-548): el devengo ([#111](https://github.com/sedecim-com/Accounting/issues/111)) y la jurisdicción como dimensión ([#123](https://github.com/sedecim-com/Accounting/issues/123)), con sus tareas en Must; el timbrado y la cancelación con PAC, con Sovos primero ([#105](https://github.com/sedecim-com/Accounting/issues/105)); el publicador de cifras públicas ([#251](https://github.com/sedecim-com/Accounting/issues/251)) y el anclaje NOM-151 ([#374](https://github.com/sedecim-com/Accounting/issues/374)); la pensión alimenticia de la nómina mexicana ([#113](https://github.com/sedecim-com/Accounting/issues/113)); y el `Concepto` de las pólizas del Anexo 24 siempre en español ([#158](https://github.com/sedecim-com/Accounting/issues/158));
- la terminal como servicio remoto ([#952](https://github.com/sedecim-com/Accounting/issues/952)), que va al final, después de sus dos documentos y de su compuerta de seguridad;
- lo que registró la revisión de normas contables y fiscales del 2026-11-27, con sus issues nuevas;
- lo que estaba aparcado: lo de Estados Unidos (D-03), el carril de la plataforma (D-08), los canales de mensajería ([#116](https://github.com/sedecim-com/Accounting/issues/116)) y, al final y en su ventana, el renombrado interno al inglés (D-05);
- lo demás que la ola 4 guardaba: los cierres de E4.2 y de E5.1, los parámetros de nómina de 2027 ([#953](https://github.com/sedecim-com/Accounting/issues/953)) y las deudas con issue propia;
- y la liberación misma ([#1080](https://github.com/sedecim-com/Accounting/issues/1080)): el corte de `release` y de `main` con su tag, la bóveda de producción en el equipo del despacho, la página de instalación y la de actualización, y la evidencia del candidato.

### Ola 4 · Después de la 1.0

El 2026-11-27 le quedan dos tareas abiertas, la MNE-001-201 y la MNE-001-207: cada una cierra una ventana de alias una versión después de la 1.0, que es la que la abre. Recibe además lo que se registre después de la liberación.

## 4. Decisiones que sólo el dueño puede tomar

Invariante 6 de `AGENTS.md`: un agente no las elige y tampoco las pregunta en el chat. Cada una bloquea una issue concreta; ahí se contesta.

El 2026-09-26 el dueño abrió él mismo una sesión para contestar las de S1 de una vez. El registro de cada respuesta es el comentario en su issue; la de #314 está en #152. Aplicó el invariante 6 con un criterio propio: lo que tiene dos caminos legítimos y no cambia la arquitectura se vuelve una clave del panel con valor por omisión. Por eso las que son bifurcación dicen su clave y su valor. Las de alcance (#219, #312), las de proceso (#294, #337) y las de forma (#152, y #327, que es regla fija del kernel) no llevan clave.

| Issue | Pregunta | Decisión (2026-09-26) |
|---|---|---|
| #220 | La carga de la balanza de apertura, ¿postea o deja borrador? ¿Con qué nombres de comando? | Contabiliza por omisión, con `--dry-run` y luego `--yes`; la clave `apertura_modo_de_carga` permite dejar borrador. Nombres del catálogo (`opening-balance import`) |
| #219 | Las cuentas de orden (8xx), ¿migran? | No migran en esta versión: se escribe la doctrina y se excluyen del cuadre; el tipo de memoria queda después del MVP |
| #242 | El «hoy», ¿de quién es? | `zona_horaria` en el panel, `America/Mexico_City` por omisión y fila por entidad. La fecha del acto en nómina la fija la ley |
| #298, #308 | Redondeos del subsidio y del papel de trabajo | `subsidio_al_empleo_redondeo` = `producto_al_centavo`; `declaracion_redondeo_a_pesos` = `cada_renglon` |
| #322 | Tasa contable (NIF C-6) frente a tasa fiscal (art. 34) | `base_depreciacion` = `vida_util_nif` por omisión; la tasa fiscal se guarda y `tasa_lisr` opera. El calendario paralelo, en #112 |
| #322 | Depreciación fiscal (`tasa_lisr`): ¿la tasa se aplica al monto original de la inversión (art. 31 LISR) o a costo menos valor de desecho? | `tasa_lisr`: monto original de la inversión sin restar desecho (art. 31 LISR); lo ya posteado conserva su base; `vida_util_nif`, y el activo sin tasa guardada que corre por su vida útil, restan el desecho — MNE-001-135, entregado en MNE-001-396 (#538) |
| #305 | Si la revaluación se revierte, y con qué tipo de cambio se cierra | `revaluacion_cambiaria_reversion` = `revertir_al_inicio`; `sin_reversion` no se ofrece hasta tener su lector. `fuente_tipo_cambio_cierre` = `la_de_operaciones` (hoy DOF), del último día natural |
| #312 | La descarga masiva, ¿entra al MVP? | Entra el censo; la descarga automática con e.firma, después (2026-09-26). **Reemplazada** el 2026-09-28 por la fila siguiente |
| #312 | La e.firma, ¿descarga y sella dentro del MVP? | Sí (2026-09-28, MNE-001-140): «para efectos de scope del proyecto considera que sí se va a usar [la e.firma] para descargar y firmar… revisa el proyecto y mejora lo que se pueda automatizar con esta posibilidad.» La descarga (#439, #440, #441) y el sellado del Anexo 24 bajo `sellar_con_custodia` (#442) entran; la presentación ante el SAT sigue siendo manual |
| #294 | ¿Cuándo se parte el tablero por paquete? | Al arrancar S1, sin esperar a #283 ni a #249 (empezó con #360) |
| #152, #314 | Formato de claves del panel y de la ayuda | `policy.<nombre inglés del registro de I4>.*` y `help.<cmd>.<sub>.*` |
| #327 | La sintaxis de los renglones | Regla fija del kernel, no configuración: `clave=valor` con «;», `cargo`/`abono` como sinónimos permanentes y lo actual aceptado |
| #337 | La firma del SCOPE y de `catalog-info.yaml` | Un solo PR tras una sesión campo por campo; lo legal, como pregunta abierta al 2026-10-09 (falta la sesión) |
| PR #249, PR #283 | La lectura de §5.3 del tablero y la revisión de seguridad; si se juzga el título del PR | Los dos se fusionaron el 2026-09-26; desde #283 el asunto de cada commit y el título del PR se juzgan en inglés |
| #367 | La migración a zod 4: ¿qué se conserva del contrato? | El cuerpo del 422 y la aceptación de UUID, byte a byte (2026-09-26). Dos endurecimientos aprobados en #380 (2026-09-26): ±Infinity y los enteros fuera de ±(2^53 − 1) se rechazan. Entregado en #401 y #402 (2026-09-27) |
| #323 | Cómo se prueba la validez del XML del Anexo 24 | Contra el XSD oficial del SAT guardado en el repositorio; la relectura estructural no basta (2026-09-27). El trabajo es MNE-001-136 (#397) |
| #378 | Los dos criterios rojos de E5.1, ¿entran al MVP o se enmienda la meta de RNF-01? | Se enmienda RNF-01 (2026-09-30, MNE-001-132): las herramientas del agente derivadas del registro de riesgo y la rehidratación de `--continue` quedan después del MVP (MNE-001-391, MNE-001-392); ningún criterio verde retrocede. PRD-001 §RNF-01 enmendado en MNE-001-390 |

**Pendientes.** Al cruzar el backlog con las issues, el 2026-09-26, salieron preguntas que nadie había hecho. Cada una es una decisión en el backlog (`docs/backlog/PRD-001.md`) y bloquea tareas concretas:

| Issue | Pregunta | Decisión | Bloquea |
|---|---|---|---|
| #308 | El prorrateo del IVA de actividades mixtas (art. 5 fr. V) y dónde se capturan el coeficiente de utilidad y las pérdidas | MNE-001-114 | El ISR provisional (059), y con él el papel de trabajo (060), en la ruta crítica del MVP |
| #297 | Las horas extra (art. 93 fr. I): ¿qué trato declara el panel, o quedan fuera del MVP? | MNE-001-109 | 110 |
| #371 | La identidad de plataforma | MNE-001-106 | El despliegue (107) |
| #357 | La `CONTALINK_API_KEY` global, ¿queda de respaldo de sólo lectura o se retira? | MNE-001-120 | La llave por entidad (121), y con ella el despliegue |
| #231 | La semana a caballo entre meses: ¿la prorrata la fija la ley, como dice la decisión de #242, o es un criterio del panel? | MNE-001-131 | 071 |
| #133 | N, los meses tras los que una norma verificada se considera vieja | MNE-001-123 | 078 |
| #337 | La sesión de firma del SCOPE | MNE-001-011 | — |
| #407 | Un cuerpo de 10 MB muy por encima del tope de un arreglo tarda ~24 s en rechazarse: ¿se corta antes, cambiando los bytes del 422, o se acepta? | MNE-001-137 | — |
| [#1080](https://github.com/sedecim-com/Accounting/issues/1080) | Cómo entra un arreglo urgente a `main` después de la primera liberación (el ADR-0008 lo dejó sin decidir) | MNE-001-964 | La regla de hotfix de MNE-001-251 y 252 |
| [#1080](https://github.com/sedecim-com/Accounting/issues/1080) | El plan de la bóveda de producción en el equipo del despacho (D-06): dónde vive la llave, cómo se respalda y se rota | MNE-001-969 (ruta crítica) | MNE-001-968 y el corte (MNE-001-963) |
| [#105](https://github.com/sedecim-com/Accounting/issues/105) | Lo que el timbrado necesita del dueño: qué producto de Sovos cubre el contrato, las llaves de prueba y de producción por el formulario seguro, el RFC emisor registrado con el PAC y un CSD de prueba | MNE-001-534 | 296, 297, 310 a 313, 767 |

## 5. La cola de PRs (foto del 2026-09-25)

Orden de fusión recomendado. Cada paso se re-verifica en la cabeza del PR antes de fusionarlo:

1. **#291**: el historial al día. Desde el 2026-09-24, `historial-estado --check` pone en rojo el trabajo `plan` de **toda** corrida nueva, así que va primero.
2. **#287**: dependencias menores; verde y sin conflictos.
3. **#288**: ESLint 10; verde, con el mismo número de advertencias. Después hay que actualizar las menciones a «ESLint 9» en `PROCESS.md`, `CONTRIBUTING.md` y el README.
4. **#272**: F08, el escritor de embargos. Verificado contra `main`, deja E4.1 en 23/23.
   - Falta actualizarlo con `main` y añadir `E4.1` a `--exigir` en `ci.yml` en el mismo commit (PROCESS §2).
   - Hay que avisar a los despachos de que la 085 **aborta a propósito** si tienen embargos heredados sin exención.
5. **#286** y **#283**: nunca han corrido en CI porque están en conflicto.
   - #286: al fusionar `main` hay que **re-medir** `MIRRORS_FLOOR` y `ANCHORS_HERE`; no se elige un lado.
   - #283: hay que elegir el timeout de `doctor-service.spec` y contestar las dos preguntas del dueño.
6. **#249**: el tablero gráfico. Está verde, pero antes pide la decisión sobre §5.3 y una revisión de seguridad. Es post-MVP.
7. **Cerrar sin fusionar:**
   - **#260**: rehace J0.1, que ya entró como #140, en una rama reempujada a un commit viejo;
   - **#207** y **#289**: los reemplaza #292, porque cada uno por separado rompe `npm ci`;
   - **#290**: Express 5 deja **vacío en silencio** el censo de riesgo por ruta. Ver #295.

## 6. Cómo tomar una issue y cerrarla rápido

Cada issue de la ruta lleva dos comentarios:

- el de **triage**: estado verificado, lo que queda, punto de entrada;
- el de **clasificación y Definition of Ready**: puntaje de dificultad por dimensión, autonomía, criterios Dado/Cuando/Entonces, fuera de alcance, cómo probar y, si pasa de ~400 líneas, la división propuesta.

El esquema viene del [Framework de Desarrollo Agéntico](https://claude.ai/artifact/V5nLbNQmVkbCDpZfMkUx6A); su adaptación a este repo está en el [ADR-0001](adr/0001-agentic-framework-adoption.md).

| Etiqueta | Qué dice |
|---|---|
| `mvp` · `ola-0` … `ola-3` · `post-mvp` | Si la issue está en la ruta y cuándo conviene hacerla |
| `difficulty:D1` … `D4` | Puntaje de 5 dimensiones. Decide el modelo, el esfuerzo y el presupuesto de tokens ([`ROUTING.md`](ROUTING.md)) |
| `autonomy:A1` … `A3` | Cuánta supervisión humana hay. **A3 por omisión**: el repo maneja PII y funciones financieras reguladas |
| `status:agent-ready` | Cumple la DoR, es D1–D2 y no está bloqueada: se puede tomar hoy |
| `status:triage` | Le falta algo de la DoR (casi siempre, dividirse), o es D3–D4 y espera el `/confirmar` de un humano |
| `status:needs-clarification` | Espera una decisión del dueño (sección 4). No se empieza |
| `status:blocked` | Espera a otra issue, que se nombra en el comentario |

Estas etiquetas sustituyen a `size-*`, `nivel-L*`, `listo` y `decision-pendiente` del primer triage; la equivalencia está en `ROUTING.md`. Los estados y quién los cambia están en `PROCESS.md` §7.

La receta para una issue `status:agent-ready` (o una D3 ya confirmada):

1. `git fetch` y una rama desde `main` fresco. Lee la issue **y su comentario de triage**. Si el plan está mal, comenta y detente (`PROCESS.md` §5).
2. **Reproduce primero.** Escribe una prueba de integración contra Postgres (`tests/integration/`, base efímera de `tests/integration/global-setup.ts`) que falle con el defecto.
3. Arregla. Un PR resuelve una issue: si la issue sugiere dos PRs, son dos.
4. **Criterio con mutante** en el archivo de su paquete, `src/plan/criteria/<paquete>.ts`. Rómpelo en memoria (guardar y restaurar, nunca `git checkout --`) y exige que caiga: `npm run mutantes`. Si el paquete cierra, añádelo a `--exigir` en `.github/workflows/ci.yml` en el mismo commit.
5. **Regenera los bloques generados** en lugar de editarlos a mano: los de la sección 7.
6. Pasa las puertas locales:

   ```bash
   npm run typecheck && npm run typecheck:tests && npm test && npm run lint
   npm run test:integration          # con Postgres, ver la sección 7
   npm run plan:status -- --piso --exigir=E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E1.4,E2.1,E2.2,E3.1,E4.1
   npx tsx scripts/catalogo-estado.ts --check
   npx tsx scripts/corpus-manifiesto.ts --check
   npx tsx scripts/historial-estado.ts --check
   npx tsx scripts/openapi.ts --check
   npx tsx scripts/ux-status.ts --check
   npx tsx scripts/language-status.ts --check
   npx tsx scripts/command-manifest.ts --check
   ```

   La lista de `--exigir` es la de `ci.yml` el día que se escribió esto: cópiala de ahí.
7. **Quien fusiona un PR añade su fila a `docs/HISTORY.md` antes de siete días.** Si no, el guardián pone en rojo el trabajo `plan` de todos los demás PRs. Es exactamente lo que pasó con los 18 PRs del 16 de septiembre.

## 7. Lo que hace chocar a dos PRs, y el entorno local

**Los archivos calientes.** Si tu PR toca alguno, fusiona `main` justo antes de pedir revisión y **regenera; nunca elijas un lado**. Aprender esto costó PRs rotos en #283, #286 y #281.

| Archivo | Por qué choca | Cómo se resuelve |
|---|---|---|
| `src/plan/mutation-census.txt` | El censo de espejos y anclas que sustituyó a `MIRRORS_FLOOR` y `ANCHORS_HERE` (#356). Una línea por espejo: dos PRs sólo chocan si tocan el mismo sitio | `npm run mutation:census` sobre el árbol fusionado; nunca se suma a mano |
| `docs/language.md` y `docs/language.es.md` (bloque) | Lo genera el metro del idioma | `npm run language:status -- --write` |
| `docs/language-baseline.json` | La línea base sólo baja. El carril `help-descriptions-without-key` va por familia del CLI y está cerrado en 0, sin línea base (MNE-001-405): la ayuda nueva se registra con `describeCommand`/`optionByKey`/`argumentByKey`, no en prosa (#314) | `npm run language:status -- --tighten` |
| `src/i18n/en.ts` y `src/i18n/es.ts` | El extractor inserta antes del último `};` | Conservar el orden de los bloques en los dos archivos |
| `src/ai/docs/manifiesto.json` | Sello del corpus contra sus fuentes | Releer el manual y `npx tsx scripts/corpus-manifiesto.ts --actualizar <manual>.md` |
| `docs/cli-command-catalog.md` (bloque) y `docs/catalogo-minimos.json` | Recuento del binario y suelo | `npm run catalogo:estado`. Ojo: **sin `--check` reescribe el archivo** |
| `docs/HISTORY.md` | Censo generado y filas a mano | `npm run historial:estado` |
| `docs/openapi.json` | Se genera de las rutas | `npm run openapi` |
| `docs/command-manifest.json` | Se genera del árbol de comandos y de su registro de riesgo | `npm run command:manifest` |
| `tests/api/golden/rest-body.golden.json` y `tests/ai/tools/tool-schemas.golden.json` | Se generan de los esquemas de cuerpo y de las herramientas del agente, y son contrato (#367) | `npx tsx scripts/zod-contract-goldens.ts --write`, sólo si el PR cambia ese contrato a propósito |

**El entorno local.** Un solo comando, idempotente (#335):

```bash
scripts/setup.sh                  # dependencias, .env de desarrollo, Postgres, base, roles y migraciones
scripts/verify.sh                 # ya con integración y con los criterios ▶
```

- **El devcontainer** (`.devcontainer/`) fija el Node y el Postgres de CI y corre `scripts/setup.sh` al crearse.
- **En Claude Code en la web**, el hook `SessionStart` (`.claude/hooks/session-start.sh`) corre `scripts/setup.sh --local-cluster`. Esa bandera arranca el Postgres del contenedor y le pone la contraseña de desarrollo: es sólo para contenedores desechables.
- **En tu máquina**, `setup.sh` usa el Postgres que responda en `TEST_ADMIN_DATABASE_URL`. Si no responde ninguno y hay Docker, levanta el contenedor `mnemosine-postgres` con la versión de CI. Con otra versión mayor, avisa y sigue.
- **El `.env`** lo escribe sólo si no existe, y nunca reescribe uno tuyo. `scripts/verify.sh` lee de ahí las URLs de base, igual que los procesos Node.
- **El orden del texto.** Las bases de la CI ordenan el texto con `en_US.utf8`: minúsculas antes que mayúsculas, y sin mirar los signos en la primera pasada. `setup.sh` y la suite de integración crean sus bases con ese orden (MNE-001-753):
  - si el Postgres local no trae ese locale, usan un sustituto de ICU y lo dicen en una línea; ordena igual salvo entre dos textos con las mismas letras y cifras que difieren en sus signos;
  - una base que ya existía con otro orden no se toca: `setup.sh` avisa en cada corrida y dice cómo igualarla.

Lo que hace por dentro, por si hay que hacerlo a mano:

```bash
createdb -h localhost -U postgres mnemosine_dev
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemosine_dev
export MIGRATION_DATABASE_URL=$DATABASE_URL
export TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
psql "$MIGRATION_DATABASE_URL" -v app_pw=dev_app_pw -v owner_pw=dev_owner_pw -f scripts/provision-roles.sql   # sólo si faltan los roles, y antes de migrar
npm run migrate && npm run plan:status
```

Tres trampas que ya costaron tiempo:

- Sin `TEST_ADMIN_DATABASE_URL`, los criterios ▶ no corren y `plan:status` **no lo presenta como un fallo**: sale con menos paquetes en verde y lo dice sólo en la última línea.
- Conectado como superusuario, la RLS no filtra nada y en silencio. Para probar aislamiento, usa el rol de `scripts/provision-roles.sql`, como el trabajo «Aislamiento por inquilino» de CI.
- `historial-estado --check` necesita el historial completo: en un clon superficial, `git fetch --unshallow` primero.
