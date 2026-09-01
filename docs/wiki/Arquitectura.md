# Arquitectura: cinco capas y un solo sitio donde se escribe el mayor

El [README](https://github.com/sedecim-com/Accounting/blob/main/README.md) responde qué es mnemosine y cómo se arranca. Esta página responde otra cosa: cómo está partido por dentro, qué impone cada capa sobre la de arriba, y por qué se decidió así. Lee el README primero; aquí no se repite.

## Lo que conviene saber antes de creerse el diseño

Cuatro cosas que suenan más terminadas de lo que están. Se dicen aquí arriba porque descubrirlas leyendo el código —después de haber confiado en la descripción— sería peor.

- **La puerta de confirmación no es una función del núcleo.** Cada familia de comandos define su propio `confirmOrAbort` con la misma forma: si `--yes`, pasa; si no hay terminal, aborta en vez de asumir un sí; si la hay, pregunta `[y/N]`. Está en [`entry-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/entry-command.ts), en [`invoice-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/invoice-command.ts), en [`payment-command.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/payment-command.ts) y, con readline propio, en `onboard` dentro de [`mnemosine.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/mnemosine.ts). Lo que sí es del núcleo es la *declaración* que obliga a tenerla y el mecanismo que exige `--reason`.
- **`gateMutation` no lo llama todo lo que muta.** Se consume en diez archivos de comandos, y el criterio del plan sólo exige que sean al menos ocho —los graves cableados—. Un comando declarado `escritura` normalmente no pasa por ella.
- **Una parte del binario declara su riesgo desde una tabla de retrofit**, no junto a su registro, en [`kernel/riesgos-retrofit.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/riesgos-retrofit.ts). Hoy esa tabla sólo contiene `lectura` y `escritura`: los ocho graves salieron de ahí y declaran junto a su registro con el manejador cableado. Que no vuelva a entrar un grave lo vigila un criterio del tablero.
- **La auditoría de consistencia arranca con una línea base congelada.** El binario que se embarca viola sus propias reglas en un puñado de sitios conocidos, enumerados uno por uno en `LINEA_BASE` de [`kernel/audit.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/audit.ts). La lista sólo puede encoger.

Y una ausencia estructural que condiciona todo lo demás: **el CLI no comprueba permisos**. `requirePermission` existe únicamente en la superficie REST. La terminal se apoya en la RLS para la frontera de inquilino y en la compuerta de riesgo para la confirmación; quién puede postear qué, dentro de un inquilino, no lo pregunta nadie desde la terminal.

## Las cinco capas

De fuera hacia dentro. La regla que las ordena: cada capa sólo puede llegar a la siguiente, y ninguna se salta el motor de posteo.

| Capa | Dónde vive | Qué impone hacia arriba |
|---|---|---|
| CLI | `src/cli/` sobre `src/cli/kernel/` | riesgo declarado por comando, vocabulario cerrado de verbos, diccionario único de banderas, contrato de salida, tabla de códigos de salida |
| Agente | `src/ai/` | ninguna herramienta escribe en el mayor ni ejecuta hacia fuera; el texto de terceros entra envuelto como no confiable |
| Escrituras en dos tiempos | `src/ai/draft-service.ts`, `src/ai/external-service.ts`, `src/ai/floor.ts` | lo que el agente propone aterriza en una cola de revisión; el suelo se combina con `Math.min`, jamás con `Math.max` |
| Servicios | `src/services/` | las reglas contables y fiscales; el motor de posteo es el único que toca el mayor |
| Base | `src/database/` | RLS forzada por inquilino, disparadores de inmutabilidad, políticas reaplicadas tras cada migración |

Los números de esa última fila —migraciones y tablas— no se escriben a mano en esta wiki. Se preguntan:

```bash
ls src/database/migrations/*.sql | wc -l
```

Y el estado de los paquetes de trabajo, igual: `npm run plan:status`. Ver [[El-tablero-y-los-criterios]].

## El invariante central: una sola puerta al mayor

**Toda escritura física al libro mayor pasa por [`src/services/accounting/posting.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/posting.ts).** No es una convención de estilo: es la propiedad de la que cuelga todo lo demás. Si el mayor tuviera dos entradas, cada garantía que el sistema hace —periodo abierto, folio sin colisión, cuadre, rastro de auditoría en la misma transacción, atestación después del commit— habría que reimplementarla en la segunda, y la segunda es siempre la que se olvida.

Lo que ese módulo hace por dentro, en un solo lugar y en una sola transacción:

1. **Resuelve el periodo fiscal** por la fecha del asiento, y rechaza si no hay uno que no esté en `hard_close` o `locked`.
2. **Toma el folio** con `nextEntityNumber`, un contador atómico por entidad cuyo candado de fila vive hasta el commit. Antes era un `COUNT(*)` y dos posteos concurrentes dibujaban el mismo número.
3. **Escribe la póliza y sus líneas**, y sólo entonces valida y postea si se pidió `autoPost`.
4. **Cruza el candado del periodo**: `FOR SHARE` sobre la fila del periodo mientras el cierre toma `FOR UPDATE`. Los posteos concurren entre sí y el cierre serializa contra todos. Sin ese cruce, un asiento en vuelo aterrizaba en un periodo cuyo checklist ya se había fotografiado sin él.
5. **Deja el rastro de auditoría dentro de la misma transacción.** Si el asiento no llega a confirmarse, su renglón de auditoría tampoco. Y si el inquilino no se puede determinar, el asiento **no se escribe**: un movimiento del mayor sin rastro no debe existir.
6. **Dispara la atestación después del COMMIT**, nunca antes: el orquestador vuelve a leer el asiento de la base, así que lanzarla dentro es una carrera. Las atestaciones en vuelo se drenan antes de cerrar el pool.

### Cómo se sostiene el invariante

Tres cercas, ninguna de las cuales es una nota en la revisión de código:

**Postgres.** Desde la migración [`041_el_mayor_inviolable.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/041_el_mayor_inviolable.sql), un asiento `posted` sólo admite escritura en una lista blanca de metadatos —`reversed_by_entry_id`, `notes`, `entry_hash`, `blockchain_attestation_id`, `commitment`— y la comparación es por resta de JSONB, de modo que una columna nueva nace protegida por omisión y no expuesta. El `DELETE` de un posteado se rechaza; el `TRUNCATE` de las dos tablas del mayor se rechaza sin condición. No hay `REVOKE` acompañándolo a propósito: el `GRANT` general de `rls-policies.sql` lo devolvería en silencio. El disparador es la capa que aguanta incluso ante el dueño del esquema.

**El plan.** Un criterio ejecutable en [`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts) falla si la 041 desaparece o pierde alguno de sus disparadores, y otro cuenta los puntos de auditoría dentro de `posting.ts`: si bajan de cuatro, un asiento creado por la terminal o por el agente deja de dejar rastro.

**La superficie del agente.** El criterio E5.1 recorre `src/ai/tools/` con tres cercas —nombres prohibidos por identificador y no por llamada, módulos de dinero prohibidos en los `import`, y SQL de escritura directo incluido el `UPDATE` multilínea—. Una herramienta nueva que llame al motor de posteo pone el tablero en rojo.

### Las dos excepciones, dichas con precisión

La frase «todo pasa por posting.ts» sería falsa sin estas dos, y una wiki que las oculte traiciona al lector:

- [`journal-entry-service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/journal-entry-service.ts) reescribe las líneas de un asiento en **estado borrador** al editarlo. Un borrador nunca tocó `account_balances`, y el disparador de la 041 impide que ese camino alcance un posteado: el `UPDATE` de una línea cuyo padre está en `posted` muere en la base.
- [`period-close.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/accounting/period-close.ts) escribe `account_balances` en el arrastre de saldos al periodo siguiente. No es un posteo: no crea póliza, copia el saldo final como saldo inicial y es idempotente por recomputación.

## El núcleo del CLI: lo que revienta en el arranque

[`src/cli/kernel/`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel) es la maquinaria compartida de la que se construyen todos los comandos. Cinco preocupaciones transversales viven ahí y en ningún otro sitio, que es lo que hace posible auditarlas de golpe.

### `declareRisk`: el permiso no puede depender del valor de una bandera

Cada comando que muta declara **una vez** su clase de riesgo, y esa declaración gobierna cuatro cosas a la vez: qué banderas de seguridad se le inyectan, cuán fuerte es la confirmación, qué dice su renglón de auditoría, y si el agente puede invocarlo.

Las cuatro clases —`lectura`, `escritura`, `irreversible`, `externo`— son exactamente el vocabulario del catálogo de comandos, para que una fila del catálogo y un comando del código no puedan divergir. Ver [[Catalogo-de-comandos]].

La regla que carga el peso es la cuarta, y está escrita en código y no en una lista de revisión:

```ts
if (agent && (risk === 'irreversible' || risk === 'externo')) {
  throw new Error(/* … */);
}
if (agent && risk === 'escritura' && !draftOnly) {
  throw new Error(/* … */);
}
```

Eso ocurre **en el arranque del proceso**, cuando los comandos se registran, antes de que exista una sola entrada del usuario. Si `year close --generate` fuera invocable por el agente y `year close --seal` no, el permiso sería una propiedad de *cómo se tecleó* el comando: incognoscible en el momento del registro e inaplicable en cualquier sitio. `declareRisk` se niega a esa alternativa. Un comando así se parte en dos comandos con dos declaraciones.

La declaración también inyecta banderas, y la inyección es idempotente: un comando que ya definió su propia `--dry-run` —`onboard` la tenía desde antes de que existiera el núcleo— no choca al declararse.

| Clase | Se le inyecta | El agente |
|---|---|---|
| `lectura` | nada | puede |
| `escritura` | nada | sólo con `draftOnly: true` |
| `irreversible` | `--dry-run`, `-y/--yes`, `--idempotency-key` | nunca |
| `externo` | lo anterior más `--live` | nunca |

Y un verbo cuyo propósito es deshacer o sobreescribir algo —`reverse`, `void`, `reopen`, `unlock`, `cancel`, `reject`, `archive`, `revoke`, `delete`— recibe además `--reason <text>`.

### `gateMutation`: fallar cerrado en el primer uso

Lo que la declaración prometió, esta función lo exige en el momento de la llamada: `--force` sin `--reason` es error de uso (código 2); un verbo de deshacer sin `--reason` y sin `--dry-run`, también. Devuelve el modo efectivo para que el manejador se bifurque una sola vez.

La parte interesante es cómo empieza:

```ts
if (!resolved) {
  throw new CliError(
    `"${cmd.name()}" pide una compuerta de mutación sin haber declarado su riesgo. …`,
    ExitCode.USAGE
  );
}
```

Antes, la única comprobación iba guardada por `if (resolved && …)`, así que una hoja sin declaración atravesaba la compuerta entera sin que nada la mirara. Como además casi la mitad del binario no declaraba, la compuerta era un no-op para casi todo. Y peor: la costura de pruebas `resetDeclarations()` vacía el registro, de modo que dentro de una suite **todo** el binario quedaba sin compuerta y las pruebas pasaban en ese estado. Un comando que llama a `gateMutation` está diciendo que muta; si no declaró, lo correcto es romper.

### El vocabulario cerrado, y por qué un CLI grande lo necesita

[`kernel/vocabulary.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/vocabulary.ts) fija una lista cerrada de verbos con dos propiedades que el auditor comprueba:

1. **Cerrada.** Un comando cuyo último token no está en la lista se rechaza. Sin lista cerrada aparecen `list`, `ls`, `show` y `get` haciendo lo mismo, y la superficie deja de ser aprendible: quien ya sabe `account list` tiene que volver a aprender cómo se listan los proveedores.
2. **Biyectiva.** Exactamente una palabra en español por verbo en inglés, y ninguna palabra española sirviendo a dos verbos. El español es una capa de alias, nunca una segunda superficie; un alias reclamado por dos comandos es un fallo duro de la matriz bilingüe, no una cuestión de estilo.

Añadir un verbo es un acto deliberado, y se nota: cada incorporación lleva su fecha y su razón en el propio archivo. `merge` entró porque tres comandos funden el historial de un registro en otro y ningún verbo existente lo absorbía —`apply` es idempotente, `import` lee de fuera, `correct` enmienda uno solo en vez de colapsar dos—. `stats` entró porque el nombre ya estaba embarcado.

Hay además dos listas cortas que existen para no mentir: `OBJECTLESS_COMMANDS`, los comandos de raíz que legítimamente no llevan objeto, y `LEGACY_PLURALS`, los sustantivos cuyo plural es el nombre embarcado y se queda por compatibilidad. A esta segunda no entra nada nuevo.

### El diccionario de banderas

[`kernel/flags.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/flags.ts) es la otra mitad: un concepto, una grafía, un significado, en todas partes. Los comandos no declaran estas banderas a mano; aplican el grupo que necesitan (`withContext`, `withOutput`, `withSelection`, `withTime`). Una bandera sólo puede existir en el CLI si existe antes aquí.

Dos decisiones que valen por sí solas:

- **`-f` no se asigna nunca.** Se lee igual de bien como `--file` que como `--force`, y el día que alguien las confunda sobreescribe el candado de un periodo creyendo que pasa un nombre de archivo.
- **`--date-basis` existe porque fecha de documento, fecha de registro y fecha de valor son tres cosas distintas.** Una sola `--date` respondiendo por las tres es una clase entera de respuestas equivocadas: el corte de devengo, la selección del tipo de cambio y la asignación de periodo fiscal se apoyan cada uno en una diferente.

Hay también grafías prohibidas —`--dryrun`, `--out`, `--fmt`, `--from`/`--to`, `--silent`, `--pretty`, `--sandbox`— que el auditor rechaza para que no vuelvan a colarse.

### Cómo se vigila todo esto

`auditProgram` recorre el programa de Commander ya montado y afirma las reglas: profundidad máxima de tres tokens, verbo de la lista cerrada, sustantivos en singular, banderas del diccionario, sin colisiones de forma corta, banderas exigidas por la clase de riesgo, y que todo `list` se pueda paginar y formatear.

Vivía en un `.spec.ts`, y eso tenía tres consecuencias invisibles. La primera: el binario que se embarca no pasaba por ella —cada prueba se construía un programa de juguete—, y ejecutada contra el real por primera vez dio cuarenta violaciones que nadie había visto. La segunda, peor: importar `auditProgram` desde el spec arrastraba su suite, y sus pruebas llaman a `resetDeclarations()`; como el registro de riesgo se indexa por la identidad del objeto `Command` y se puebla una sola vez al importar `mnemosine.ts`, un reset lo dejaba vacío para el resto del proceso. La tercera: un fichero de pruebas no puede ser destino de importación de producción, así que `doctor` no podía correr la auditoría aunque quisiera.

Hoy vive en producción y la corren tres cosas: `mnemosine doctor`, un criterio del tablero, y las pruebas de superficie de cada familia. Las cuarenta violaciones están congeladas en `LINEA_BASE`, la puerta falla ante cualquiera que **no** esté ahí, y la lista sólo puede encoger: una entrada que ya no se viola es letra muerta y la prueba obliga a borrarla.

### El contrato de salida y los códigos de salida

Dos reglas de [`kernel/output.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/output.ts) son corrección y no gusto:

- **El dinero nunca es un número de JSON.** Postgres entrega los numéricos como cadenas y salen como cadenas hasta el final. Un viaje de ida y vuelta por `JSON.parse` es cómo una balanza deja de cuadrar por un centavo que nadie encuentra.
- **El truncado siempre se reporta.** Un `--limit` por omisión que descarta filas en silencio produce un estado financiero equivocado y una respuesta del agente equivocada, de forma invisible. Las personas reciben un aviso por stderr; las máquinas reciben `truncated` y `total` en el sobre versionado.

Los datos van a stdout y toda nota, aviso o diagnóstico va a stderr, de modo que un mensaje suelto nunca corrompe una tubería.

De la tabla de [`kernel/exit.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/exit.ts), dos códigos cargan peso más allá de «falló»:

- **4** — un `check` que **encontró** algo. Los hallazgos también van en la carga útil; el código es lo que permite que un `check` entre en CI sin envoltorio. Un `check` que **no pudo correr** sale 1, 2, 3 u 8, nunca 4: confundir «encontré problemas» con «no pude mirar» es como una tubería en verde miente.
- **11** — necesita a una persona: se levantó una pregunta o hay un borrador esperando revisión. Es el código que hace seguro un flujo conducido por el agente, porque el trabajo no falló: está esperando.

## Qué comparten el CLI y la API REST, y qué no

El repositorio se llama `Accounting` y el paquete `accounting-core` por su origen: un servidor REST/GraphQL. Ese motor sigue vivo y es el que el agente opera, pero el producto es la terminal. Conviene saber exactamente dónde se tocan.

**Comparten:**

- Todo `src/services/` — el motor contable, incluido `posting.ts`. La ruta `POST /v1/journal-entries/:id/post` llama a `postJournalEntry`, la misma función que `mnemosine entry post`.
- Toda `src/database/` — pool, contexto de inquilino, políticas de RLS, guardián de arranque.
- El catálogo de autorización de [`src/auth/roles.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/auth/roles.ts). Había dos, con nombres de rol distintos y conjuntos distintos, y un usuario creado desde la terminal recibía permisos que la API no reconocía.

**No comparten:**

- **El núcleo del CLI.** La API no declara riesgo, no tiene marcha seca, no tiene compuerta `--live` ni vocabulario cerrado. Sus garantías son otras: JWT, `requirePermission`, `requireEntityAccess`, limitador de tasa, bitácora de auditoría por petición.
- **La aplicación de permisos.** El catálogo es común; el que lo hace cumplir es sólo el middleware REST. La terminal lo usa únicamente para *crear* usuarios, en `mnemosine init`.
- **Cómo se abre el contexto de inquilino.** El servidor usa `withTenant` por petición, montado una sola vez justo después de `authenticate` para que ningún router pueda olvidarlo. La terminal usa `enterTenant`, que fija el inquilino para el resto de la ejecución y **no debe usarse en un servidor**: nunca se sale de él y se filtraría entre peticiones. Es la forma correcta para un proceso que sirve un comando y un inquilino.
- **El agente no habla HTTP.** Sus herramientas llaman a los servicios directamente. No hay un cliente de la API dentro de `src/ai/`.

Donde los dos contratos se encuentran es un solo sitio: `exitCodeFor` en [`kernel/index.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/index.ts), que traduce el `statusCode` de un error de dominio al código de salida del CLI. Está tipado por pato sobre `statusCode`, para que el núcleo no dependa de la jerarquía de errores.

Lo que sí falta decir: **GraphQL está desmontado por omisión**, vive fuera del prefijo auditado `/v1` y sus mutaciones no comprueban permisos. Ver el README para el inventario completo de lo retirado.

## El camino de un CFDI hasta el mayor

Este es el recorrido completo, con el nombre real de cada módulo. La única forma de llegar a la caja de abajo es por la puerta de arriba.

```text
  facturas/*.xml
        |
        |  mnemosine ingest              src/ai/ingest-service.ts
        v
  +--------------------------------------------------------------+
  | 1. PRE-REGISTRO        xml-ingestion/pre-registration-service |
  |    CFDIParser -> SATValidationService -> dedupe por UUID       |
  |    escribe: xml_documents, xml_document_lines,                |
  |             pre_registrations                                  |
  +--------------------------------------------------------------+
        |                                     |
        | una regla determinista casa          | ninguna casa
        v                                     v
  +-------------------------+    +---------------------------------+
  | 2a. MOTOR DE REGLAS     |    | 2b. EL AGENTE CLASIFICA         |
  |  rules-engine.ts        |    |  el XML entra envuelto como NO  |
  |  processToAccounting    |    |  CONFIABLE (ai/untrusted.ts):   |
  |  crea el gasto y su     |    |  es dato, jamas instruccion     |
  |  plan de asiento        |    |  herramienta draft_journal_entry|
  |                         |    |  -> ai_drafts (pending_review)  |
  +-------------------------+    +---------------------------------+
        |                                     |
        |                                     v
        |                      +---------------------------------+
        |                      | 3. UMBRALES x SUELO             |
        |                      |  ai/floor.ts: Math.min, nunca    |
        |                      |  Math.max. Por encima del tope   |
        |                      |  no auto-postea NADA, diga lo    |
        |                      |  que diga la configuracion       |
        |                      +---------------------------------+
        |                          |                    |
        |                          | auto-post           | queda pendiente
        |                          |                     v
        |                          |     +----------------------------+
        |                          |     | 4. LA PERSONA DISPONE      |
        |                          |     |  mnemosine drafts / review |
        |                          |     |  approveDraft: candado de  |
        |                          |     |  fila, hash canonico del   |
        |                          |     |  contenido revisado, y     |
        |                          |     |  revalidacion bajo candado |
        |                          |     +----------------------------+
        |                          |                     |
        v                          v                     v
  +--------------------------------------------------------------+
  | 5. LA UNICA PUERTA AL MAYOR                                   |
  |    services/accounting/posting.ts :: createJournalEntry       |
  |    periodo abierto . folio atomico . cuadre . FOR SHARE del   |
  |    periodo . rastro de auditoria EN LA MISMA TRANSACCION      |
  |    escribe: journal_entries . journal_entry_lines .           |
  |             account_balances                                   |
  +--------------------------------------------------------------+
        |
        | despues del COMMIT, nunca antes
        v
   attestEntryAsync -> blockchain/orchestrator  (hoy simulado)
```

Dos detalles del paso 4 que explican por qué la aprobación es un acto y no una bandera:

- El borrador se lee **bajo candado de fila** y se le recalcula el hash canónico —orden alfabético de llaves fijo, importes normalizados a dos decimales, opcionales ausentes como `null`—. Si el hash no coincide con el que la persona revisó, la aprobación se invalida. Eso cierra la ventana entre la revisión humana y el posteo.
- Se **revalida** el pago contra el catálogo vigente, porque las cuentas pueden haber cambiado desde que el modelo redactó, y el motor vuelve a exigir periodo abierto por su cuenta. Ninguna configuración ni política de aprobación salta esa validación.

El detalle del paso 2b y de lo que el agente puede y no puede hacer está en [[El-agente-y-sus-limites]]. Lo fiscal del paso 1 —CFDI 4.0, catálogos del SAT, IVA sobre base de flujo— en [[Fiscal-mexicano]].

## Para seguir

- [[Base-de-datos-y-migraciones]] — el runner, las políticas reaplicadas y la trampa del DML bajo RLS.
- [[Aislamiento-multi-inquilino]] — por qué la frontera es RLS y no un `WHERE` en TypeScript.
- [[El-agente-y-sus-limites]] — qué propone, qué no puede tocar y cómo se comprueba.
- [[Catalogo-de-comandos]] — la superficie, y cuánta de ella está construida.
- [[El-tablero-y-los-criterios]] — cómo se le pregunta al código en qué estado está.
- [[Pruebas-y-CI]] — las puertas que sostienen todo lo anterior.
