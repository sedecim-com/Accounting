# Síntesis de brechas de usabilidad — mnemosine

> Consolidación de los informes de auditoría de usabilidad. Entraron 100 brechas con evidencia; salen 41 distintas, agrupadas en ocho temas. Cada afirmación de este documento trae salida reproducida o `archivo:línea`. Lo que no pude verificar, lo digo.
>
> **Nota de método.** Recibí siete informes con cuerpo (`ux-errores` 11, `ux-descubribilidad` 13, `ux-salida` 14, `ux-idioma` 15, `ux-agente` 13, `flujos-reales` 21, `flujos-comparados` 13). Reverifiqué a mano las doce afirmaciones que sostienen las diez primeras recomendaciones, corriendo comandos y `grep` contra el árbol montado; ninguna se cayó. Descarté tres hallazgos por estar mal medidos o por ser inferencia sin ejercicio: la duplicación de cuentas por NFD en Postgres (`ux-idioma` 9, declarada «no verificada» por su propio autor), el mapeo de CFDI tipo I a `bill` sin mirar dirección (`flujos-reales`, riesgo condicionado a una regla en modo `auto`), y si `ingest` acepta una carpeta (nunca se llegó a ejercitar).
>
> **Dos afirmaciones del arranque quedan corregidas.** (a) «Ningún error remite a `doctor`» es falso para la invocación desnuda: `renderBrokenFlow` sí imprime `→ mnemosine doctor` (`src/cli/mnemosine.ts:463,467`). Es cierto para las 134 hojas. (b) «La familia `ai|ia` describe en español y las otras 44 en inglés» está mal medido: son 2 nodos de 179 y 3 opciones de 1069. No es una decisión de diseño con una excepción, es filtración.

---

## 1. La tesis

**mnemosine está construido para quien lo escribió, no para quien lo va a usar — y la evidencia no es que falten capacidades, es que casi todas las que faltan ya existen y no están cableadas al lugar donde el contador está parado.** El binario tiene un redactor de remedios que clasifica el fallo y devuelve el comando exacto que lo arregla (`repairCommandFor`, `src/cli/mnemosine.ts:398`), y tiene exactamente dos llamadores, los dos en el arranque desnudo: las 134 hojas restantes escupen `role "postgres" does not exist`. Tiene un helper de confirmación bilingüe (`isAffirmative`, `:386`) y ninguna de las cuatro familias de mutación lo llama, así que `s` significa «sí» en `init` y «no» en `entry post`. Tiene una capa que le explica a un contador por qué se le pregunta una política y qué pasa si no contesta (`whyAsking`, `whatIDo`, `ifSkipped`) más una vista previa contra los datos propios del cliente —lo mejor del producto, y no lo hace ningún competidor—, y se muestra en un solo sitio, `src/cli/init/s4-policies.ts`, el día uno, cuando `xml_documents` está vacía y el preview degrada a silencio por diseño. Tiene un helper de fecha local correcto, escrito y razonado, copiado cinco veces en los comandos y nunca subido al kernel, al punto de que `entry-command.ts` exporta `day()` en la línea 151 y usa `toISOString()` en la 362. Tiene un contrato de trece códigos de salida con una justificación excelente y emite 1 en todo (`85 shutdown(0)`, `52 shutdown(1)`, `13 shutdown(130)`, cero literales entre 2 y 11, cero `exitOverride`). Y tiene remedios que citan un binario que no existe: `package.json` no declara `bin`. Ese patrón —la pieza correcta a una llamada de función de donde hace falta— es la firma de un sistema donde el autor sabe dónde vive cada cosa y nunca tuvo que encontrarla desde fuera. La segunda cara de la misma tesis es el idioma: la interfaz son 8,731 palabras en inglés mientras el agente responde en español por omisión (`src/ai/providers/config.ts:590`), el manual del contador tiene 31 KB en español y cero apariciones de la palabra `mnemosine`, y los 19 mensajes en español que sí existen aparecen donde el autor escribió en su idioma, no donde el usuario lo necesita. El producto no es difícil por falta de trabajo; es ajeno por falta de un consumidor externo que lo recorriera.

---

## 2. Las brechas, por tema

Severidad = consecuencia para un despacho. Esfuerzo: S = una tarde a un día; M = de días a una semana; L = un sprint o más.

### A. La compuerta que decide — el acto irreversible

**A1 · «salir» cierra el ejercicio.** `src/cli/close-command.ts:179` valida con `/^y|^s/i`, sin anclar: cualquier respuesta que empiece con `s` sigue adelante, incluido `salir` —que este mismo CLI define como alias de `logout` (`mnemosine.ts:2079`)— y `stop`, `sale`, `seguro que no`. En la dirección contraria, `entry post`, `entry reverse`, `entry void`, `invoice issue`, `invoice void`, `payment create` (`entry-command.ts:261`, `invoice-command.ts:228`, `payment-command.ts:116`) rechazan `s`, `si` y `sí` con `answer !== 'y' && answer !== 'yes'`, y `bill approve` (`bill-command.ts:184`) con `/^y(es)?$/i`. Verificado a mano: cuatro predicados incompatibles detrás del mismo prompt `[y/N]`, y la correlación va en la peor dirección —las siete hojas irreversibles son justo las que rechazan el sí en español—. Cuando no entiende, el mensaje es una palabra, `Aborted.` (`kernel/exit.ts:98`), que el contador lee como rechazo contable. Y `src/cli/README.md:407` promete lo contrario de lo que hacen cuatro de las siete compuertas; la prueba que dice fijarlo (`tests/cli/bilingual-matrix.spec.ts`) fija alias de comando, no respuestas.
*Incumple:* clig.dev (confirmación destructiva inequívoca), convención POSIX del `[y/N]` anclado, Nielsen 2 y 4. *Duele a:* el contador, en el cierre de mes y en cada posteo. *ALTA / S.*
*Arreglo:* mover `isAffirmative` al kernel, hacer que las siete compuertas la llamen, anclarla, y que la respuesta no reconocida vuelva a preguntar («no entendí "salir"; responde y/n») en lugar de decidir. Para `close --hard`, subir el listón como `terraform destroy`: escribir el nombre del periodo. Prueba que falle si aparece un quinto predicado.

**A2 · La llave de idempotencia se graba fuera de la transacción que protege.** `src/services/idempotency/idempotency-store.ts:82-88`: `fn()` hace COMMIT y el `INSERT` de `idempotency_keys` va en otra transacción. La ayuda de las 19 hojas que llevan la bandera promete que «un reintento con la misma llave devuelve el resultado registrado» (`kernel/risk.ts:139`). Para `entry post` y `close` el estado del dominio hace de red; para pagos no la hay: `PAGABLES = ['approved','posted','partially_paid']` (`payment-service.ts:490`) y `nextEntityNumber` emite un VPMT nuevo en cada intento. Además la protección es opt-in (`:68`: sin `--idempotency-key` no hay nada) y ningún contador teclea un UUID.
*Incumple:* el diseño canónico de idempotencia (Stripe: la llave y el efecto se comprometen juntos). *Duele a:* el despacho, el día que se cae la red a media escritura: dos VPMT sobre la misma factura y un movimiento de banco que no existe. *ALTA / M.*
*Arreglo:* pasar el `client` de la transacción a `conLlave` y hacer el `INSERT` dentro, con `SELECT ... FOR UPDATE` al entrar. Mientras tanto, derivar la llave del `payloadHash` más la fecha del acto cuando no se pasa, para que la protección sea la omisión.

### B. El diagnóstico: el remedio existe y no está cableado

**B1 · 134 puertas mudas y un redactor de remedios con dos llamadores.** Verificado: `grep -rn "repairCommandFor" src/` devuelve la definición (`mnemosine.ts:398`) y dos usos, `:463` y `:467`, ambos dentro de `renderBrokenFlow`. La rama genérica de `reportError` (`:253-255`) imprime `err.message` pelado; hay cuatro ramas con remedio para el proveedor de IA y ninguna para la base de datos, que es el fallo del primer día. Reproducido ahora mismo: `mnemosine entity list` → `role "postgres" does not exist`, salida 1. La primera regex de `repairCommandFor` casa con ese texto exacto y devolvería `mnemosine doctor   (and check DATABASE_URL in .env)`.
*Incumple:* clig.dev («catch errors and rewrite them for humans»), Nielsen 9. *Duele a:* todos, la primera mañana que Docker no levanta. *ALTA / S.*
*Arreglo:* una rama en `reportError` que pase el mensaje por `repairCommandFor` y añada la flecha `→ <comando>`.

**B2 · La envoltura de entidad misdiagnostica, propone un remedio inerte y repite el error.** `kernel/entity-context.ts:100-115`. Alcance medido: `grep -rn "withContext(" src/cli | wc -l` → **85 hojas**. Sale idéntico en lectura (`cfdi list`, `report trial-balance show`, `bill list`, `ai stats`) y en mutación. El comentario del propio `catch` (`:103-108`) reconoce que dispara tanto por «entidad archivada» como por «conexión caída» y sólo redacta para la primera; el remedio que ofrece —`entity use`— requiere consultar la base, que es lo que está caído. Y el error sale dos veces porque la ejecución continúa a `resolveEntity()`.
*Incumple:* Nielsen 9 (un remedio equivocado consume el intento del usuario); clig.dev, no imprimir el mismo error dos veces con dos voces. *Duele a:* el contador, diez minutos por incidente, persiguiendo un fantasma de selección de empresa. *MEDIA-ALTA / S.*
*Arreglo:* ramificar el aviso por clase de error antes de proponer nada, y no caer a `resolveEntity()` después de avisar. La decisión de **no** borrar el pin es correcta y no se toca.

**B3 · La comprobación barata corre después de la cara.** `ingest` resuelve entidad y umbrales antes de mirar los archivos (`mnemosine.ts:1181-1201`), así que `mnemosine ingest /tmp/no-existe.xml` responde con un error de Postgres; `mnemosine ingest descarga-julio.zip` también. `entry post` hace dos viajes a la base antes de llamar a `gateMutation`, que es una función pura. `--format jsonn` se valida dentro de `render()`, después de la consulta, aunque `kernel/output.ts:61-67` tiene el mensaje perfecto preparado. `onboard --provider contpaqi --dry-run` conecta antes de decir que el único proveedor conocido es `contalink`.
*Incumple:* clig.dev, «validate user input as early as possible»; POSIX (error de uso antes de hacer trabajo). *Duele a:* el que se equivoca al teclear una ruta y pasa media hora revisando la conexión. *MEDIA / M.*
*Arreglo:* mover `gateMutation`, la validación de `--format`, el `existsSync` de `ingest` y el catálogo de `onboard` delante de cualquier `await` que toque la red, y salir con el código de uso.

**B4 · `doctor` responde «¿conecta la base?», no «¿ya puedo trabajar?»; e `init --status` se apaga en la primera falla.** `doctor` es el mejor comando del producto (ver §4) y no comprueba que haya ejercicio, periodo abierto ni catálogo. `init --status` tiene seis secciones (`src/cli/init/s0..s5`) y muestra una antes de morir con el error crudo, así que el usuario no sabe si le falta un paso o seis.
*Incumple:* Nielsen 1 y 4. *Duele a:* el que termina `init` y no sabe cuál es el siguiente comando. *MEDIA / M.*
*Arreglo:* tres verificaciones contables más en `doctor`; degradar `init --status` por sección como ya hacen `doctor` y `status`.

### C. El binario que no existe y la ayuda que no enseña

**C1 · `mnemosine` no es un comando.** Verificado: `package.json` no declara `bin` (y su `"version": "1.0.0"` no casa con el `CLI_VERSION = '0.1.0'` codificado a mano en `mnemosine.ts:127`). La única invocación es `npx tsx src/cli/mnemosine.ts` o `npm run mnemosine --`. Mientras tanto todo el producto cita el otro: `Not configured. Run: mnemosine init`, `→ mnemosine doctor`, `Use \`mnemosine entity use <id|name>\``, y el banner.
*Incumple:* la convención de npm de declarar `bin`; clig.dev. *Duele a:* el usuario nuevo, en el primer consejo que recibe: `command not found`. *ALTA / S.*
*Arreglo:* declarar `bin`, documentar la instalación, alinear la versión.

**C2 · Cero ejemplos en 134 hojas.** Verificado: `grep -rn "addHelpText" src/ | wc -l` → **0**, sobre 179 nodos de ayuda. Las descripciones son buenas; ninguna trae una línea copiable. `entry create --help` enseña doce banderas y ni una póliza escrita: el usuario sale sin saber si `<account>` es el código, el nombre o un UUID, si el importe lleva coma de millares, ni cuál de `standard|adjusting|correction` es una póliza de egresos. Y `README_ACCOUNTANT.md`, el único documento escrito para el contador, contiene **cero** apariciones de la palabra `mnemosine`.
*Incumple:* clig.dev, «examples are the fastest way to understand a command»; es la convención de `git`, `gh`, `docker`, `stripe`, `aws`. *Duele a:* el usuario declarado —que no vive en la terminal— en cada comando, todos los días. *ALTA / M por partes.*
*Arreglo:* `addHelpText('after', …)` con dos o tres invocaciones reales, con números mexicanos, en las veinte hojas del uso diario: `entry create`, `entry post`, `entry reverse`, `ingest`, `review`, `close`, `report trial-balance show`, `bill create`, `invoice create`, `payment create`, `account map import`.

**C3 · La raíz se traga el token desconocido.** Reproducido: `mnemosine balanza` → `error: too many arguments for 'chat'. Expected 0 arguments but got 1: balanza.` Igual con `diot`, `poliza`, `ayuda`, `reportes`, `completion`, `entiti`, `bank`, `banco`, `conciliacion`. `balanza` no es una palabra inventada: es un alias real del producto un nivel más abajo. Y el sugeridor **existe y funciona** una capa adentro (`entity lst` → `(Did you mean list?)`); es un cable sin conectar en la raíz, porque `chat` es `isDefault`.
*Incumple:* clig.dev, «suggest the correct command»; lo que `git` hace desde 2009. *Duele a:* el contador que teclea la palabra de su oficio y recibe un error sobre un comando que no escribió. *ALTA / S.*
*Arreglo:* si `argv[2]` no empieza con `-` y no es comando ni alias registrado —incluidos los anidados y normalizando acentos—, reportar comando desconocido con la sugerencia más cercana y salir con el código de uso, en vez de entregárselo a `chat`.

**C4 · 46 familias en lista plana, grupos con un solo hijo, sin autocompletado.** `mnemosine --help` son 113 líneas, sin agrupar, donde `entry` y `prompt-size` pesan lo mismo. `report trial-balance` sin `show` imprime su propia ayuda y sale 1: tres niveles para una balanza. `completion` está reservado en `kernel/vocabulary.ts:130` y no existe. En un árbol de 134 hojas el autocompletado no es un lujo, es el mecanismo principal de descubrimiento.
*Incumple:* clig.dev («group related commands», «help sin argumentos muestra lo básico»); el modelo de `git help`, `docker`, `kubectl`. *Duele a:* el primer día, y para siempre en la velocidad de captura. *MEDIA / M.*
*Arreglo:* agrupar en cinco bloques con encabezado, poner `init` y `doctor` bajo «Empieza aquí», reescribir el `HINT` del banner (`banner.ts:41`, que hoy manda a `status` en vez de a `doctor`), aplanar los grupos de un solo hijo, y generar `completion` para bash/zsh con los alias españoles.

### D. El idioma

**D1 · La interfaz es inglesa con fugas de español impredecibles.** Medido: 8,731 palabras de ayuda en inglés (1,848 de descripción, 6,883 de opciones); 2 nodos de 179 describen en español —verificado: `ai-command.ts:52`— y 3 opciones de 1,069; de 460 mensajes de error lanzados en `src/`, 19 en español y 441 en inglés; de 403 impresiones en `src/cli`, cero en español. Las fugas están en cuatro capas distintas: el `Usage` devuelve la forma inglesa cuando tecleas el alias español (`mnemosine reporte balanza ver --help` → `Usage: mnemosine report trial-balance show|ver`), los valores de bandera son españoles dentro de ayuda inglesa (`--chart auto|siempre|nunca`), la ayuda de argumento es española (`account map import`: `CSV: code,valor (una cuenta por línea…)`), y la salida de ejecución también (`entry import`). Y la misma bandera cambia de idioma entre familias: `cfdi list --direction` exige `emitido|recibido|ajeno`, `rep missing list --direction` exige `received|issued`. Todo esto mientras el agente responde en español por omisión (`config.ts:590`, verificado).
*Incumple:* Nielsen 2 y 4. *Duele a:* el auxiliar de captura, que no puede formarse ninguna expectativa. *ALTA / L.*
*Arreglo:* es la decisión de producto §5.1. Sea cual sea la respuesta, lo indefendible es la mezcla: el trabajo mínimo es un catálogo con los tres textos que se leen cien veces al día —prompt de confirmación, mensaje de estado bloqueado, línea de remedio— gobernado por `MNEMOSINE_LANG`, más una prueba que falle ante una cadena visible que mezcle idiomas dentro de una familia.

**D2 · El panel donde se ejerce el juicio fiscal mexicano está en inglés.** 17 de 17 preguntas de `src/services/policy/pending-catalog.ts` en inglés, con las llaves en español (`umbral_capitalizacion_mxn`, `tratamiento_ieps`, `politica_restaurantes`). Los conceptos son irreductiblemente mexicanos —IEPS, REP, el 8.5% de consumos en restaurantes— y la oración que los rodea es inglesa.
*Duele a:* el contador que deja el default en la decisión que cambia el asiento de todas las compras de su cliente. *ALTA / M.*
*Arreglo:* traducir las 17 entradas. Es el texto de mayor densidad de juicio contable del producto.

**D3 · Los alias son ASCII y tienen hoyos, y fallar sale con 0.** De 168 alias, uno lleva acento (`enseña`). `mnemosine póliza --help` imprime la ayuda de la raíz y **sale con 0**: ni error, ni advertencia. `mnemosine período list` falla nombrando `chat`. Trece hojas no tienen alias (`approvals list|grant|revoke`, las seis de `jobs`, las tres de `skills`, `sat cred`) mientras sus familias sí lo tienen, así que el usuario llega en español hasta la puerta y ahí cambia de idioma. Y `src/cli/README.md:397` afirma que la superficie española está completa.
*Incumple:* Unicode UAX#15 (normalizar antes de resolver); la propia regla de `kernel/vocabulary.ts:11-16`. *ALTA / S los alias, M el `exit 0`.*

**D4 · El vocabulario de los VALORES es inglés, y los tipos de póliza no son los del SAT.** `journal-entry-service.ts:532-537` rechaza `cargo` y `abono`, las dos palabras que el propio `README_ACCOUNTANT.md` usa. El enum es `standard, adjusting, correction` (`ENTRY_TYPES`, `001_core_schema.sql:225`): taxonomía US GAAP donde CONTPAQi y Aspel obligan a elegir Diario, Ingresos, Egresos, Traspaso. Precisión para no sobrepasar la evidencia: el XSD del Anexo 24 no enumera un atributo de tipo de póliza —la clasificación viaja por convención en `NumUnIdenPol`—, así que hoy no es incumplimiento normativo; es deuda que no se reconstruye retroactivamente. Agravante: `--dry-run` de `entry create` no es offline, así que el error de sintaxis sólo se descubre con base viva.
*ALTA / M (aceptar `cargo`/`abono` es S; el tipo de póliza es L y toca esquema).*

**D5 · Los nombres de periodo se acuñan en inglés y se persisten.** `fiscal-calendar-service.ts:504-507`, verificado, con el comentario que lo declara: *«Period names are stored, not translated at render time; the CLI UI is English, so they are minted in English»*, más `seed.ts:54`. Esto es distinto en clase del resto: es dato escrito. Si mañana se traduce la interfaz, los ejercicios ya abiertos dicen «January 2026» para siempre.
*Duele a:* el despacho, con cada cliente nuevo y cada ejercicio. *ALTA / M, y la ventana para que sea barato se cierra sola.*

**D6 · `factura emitir` usa el verbo que en México significa timbrar, y no timbra.** El alias es `emitir` (`invoice issue|emitir`) y las dos aclaraciones que evitan el malentendido —«Does not stamp or send», «never stamped here»— están en inglés, es decir, en el idioma que el usuario que eligió el alias español puede no leer. *ALTA / S:* cambiar el alias a `contabilizar` y traducir las advertencias.

**D7 · Alias mal elegidos y homónimos.** `ganchos` (traducción de diccionario de *hooks*; en México se dice webhook), `sembrar` (por *seed*), `reversar`, `mapeo` (cuando el término del SAT que la propia descripción usa es «agrupador»), y `deactivate` en inglés dentro de la ranura española. Homónimos: `mayor` apunta a `ledger` y a `report general-ledger`; `cliente` es a la vez la entidad, el *customer* de la entidad y el *tenant* —y el `--help` de `onboard` llama *client* a lo que el CLI llama `entity`—; `receipt|cobro` convive con `rep` (REP). El repositorio ya adoptó vocabulario cerrado para los verbos (`kernel/vocabulary.ts`) y no lo aplicó a los sustantivos. *BAJA-MEDIA / S.*

### E. El lazo del agente: proponer, revisar, aprender

**E1 · Toda la capa explicativa se gasta el día uno.** `grep` confirma un solo consumidor de `whyAsking`/`whatIDo`/`ifSkipped` y de `previewFor`: `src/cli/init/s4-policies.ts`. Y el asistente corre `s4` antes de `s5-import`, con `xml_documents` vacía, así que **el preview degrada a silencio por diseño exactamente en el único momento en que se muestra**. El panel `pending -v` —donde el contador vive el resto de la relación— muestra `impact`, `default_rationale` y `options`, nunca los tres campos ni el preview.
*Incumple:* Nielsen 6 y 10 (la ayuda va en el momento de la tarea, no en el tutorial). *Duele a:* el contador a los tres meses, cuando el preview por fin diría «con $20,000 te habría interrumpido 43 veces este trimestre» y la superficie que lo muestra ya no existe. *ALTA / S — la mejor relación esfuerzo/impacto del repositorio.*
*Arreglo:* que `renderPolicies` (`pending-command.ts:99-116`) imprima los tres campos y llame a `previewFor()`.

**E2 · La pantalla de revisión no trae el CFDI, y el modelo de datos no lo permite.** `renderDraft` (`mnemosine.ts:985-1010`) muestra fecha, confianza, descripción, referencia en texto libre y prosa del modelo. Verificado: `011_ai_drafts.sql` no tiene `xml_document_id` ni `cfdi_uuid`; el único hilo al documento es una cadena que la ingesta le pide al modelo (`ingest-service.ts:597`). Y la otra mitad existe y es buena: `cfdi show` y `cfdi explain` son exactamente el otro lado del asiento, y `review` no los menciona ni podría, porque el revisor está en un `readline` modal.
*Incumple:* Nielsen 1 y 6; lo que CONTPAQi, Aspel, QuickBooks y Xero dan por sentado (el comprobante junto a la propuesta). *Duele a:* el revisor, en cada borrador: aprueba a ciegas contra la palabra del modelo. *ALTA / M.*
*Arreglo:* columna `xml_document_id UUID REFERENCES xml_documents(id)` en `ai_drafts` y reconstruir la pantalla sobre ella.

**E3 · Revisar no escala.** `mnemosine.ts:1060` carga la cola completa sin cota y la recorre de uno en uno; el prompt es `[a]pprove / [r]eject / [s]kip / [q]uit` y **cualquier otra tecla salta el borrador sin imprimir nada** (`:1136`). `drafts` tiene dos banderas y ninguna salida de máquina —verificado ahora: `drafts --json` → `error: unknown option '--json'`—; no hay `--min-confidence`, `--max-amount`, `--since`, orden, lote, ni `draft approve <id>`. No hay corregir-y-aprobar: sólo aprobar o vetar. Y la mnemotecnia inglesa colisiona: `[s]kip` es lo que un contador teclea creyendo que dice «sí».
*Incumple:* clig.dev («make it scriptable»); Nielsen 5, 7 y 9. *Duele a:* el despacho el día 12, con 380 borradores. *ALTA / M.*

**E4 · El rechazo no enseña.** `rejectDraft` escribe el motivo en `ai_drafts.review_notes` y termina. El digest que entra al prompt de toda sesión sale **sólo** de `ai_questions` (`memory-service.ts:181`): una pregunta contestada se vuelve precedente automáticamente y el humano la ve en `mnemosine memory`; catorce rechazos con motivo escrito no entran a ningún lado. Además la ingesta crea sesión nueva por corrida, así que ni el aprendizaje intra-sesión sobrevive.
*Duele a:* el contador que rechaza el mismo error catorce veces y concluye, con razón, que el agente no aprende. *ALTA / M.*
*Arreglo:* tras un rechazo, ofrecer sembrar el criterio como precedente en un paso; el motivo ya está escrito.

**E5 · La confianza es un número sin leyenda.** `ai_confidence` es autorreporte del modelo; la única definición vive en el prompt (`system-prompt.ts:53`), no en la interfaz. Mientras tanto `ai stats` calcula la aprobación por bucket y el delta confianza-vs-realidad, y el veredicto de la sombra dice si esa póliza *habría* pasado las compuertas — y nada de eso aparece donde se decide. *ALTA / S:* llevar el histórico del bucket y el veredicto a `renderDraft`.

**E6 · `pending` exige transcribir una llave `snake_case`** de 26 caracteres, sin selector numérico ni recorredor, cuando la familia hermana sí lo tiene (`question answer` sin `id` recorre la cola). Y quedó fuera del contrato de salida. *MEDIA / S.*

**E7 · El costo no se le enseña a quien lo paga.** La ingesta lo calcula y lo escribe en `ai_ingest_runs`, y el `Summary` que ve el humano no lo menciona. El presupuesto existe y está bien razonado (`ai/budget.ts`) y **no tiene comando**: vive sólo en `mnemosine.config.json`, y `usage` reporta gasto sin decir contra qué tope. Los importes son USD a cuatro decimales para un despacho que factura en pesos. *MEDIA / S.*

**E8 · El aviso de pendientes existe en un solo lugar: el banner del chat, en TTY, de una entidad.** `fetchPendingCounts` tiene un llamador (`mnemosine.ts:730`), dentro del bloque que exige TTY. Un despacho que trabaja por lote nunca lo ve. *MEDIA / M.*

**E9 · El nombre que el producto se recomienda a sí mismo está deprecado.** `mnemosine question` —el nombre canónico— imprime la advertencia de `questions`, porque el shim está montado como acción por omisión del padre (`mnemosine.ts:2001`). Y cinco sitios del producto imprimen `mnemosine questions`, incluido el tablero de cierre (`:1329`) y los documentos que el agente lee (`compaction.ts:370`). *BAJA / S.*

**E10 · La conversación no tiene por dónde corregir.** Los comandos del chat son doce y no hay `/teach` ni `/memory`; el `/help` nombra `usage · status · jobs` y no `review`, `drafts`, `question` ni `memory`, que son el lazo del producto. Además `/ayuda` imprime sus cinco ejemplos en inglés mientras el agente contesta en español. *MEDIA / S.*

### F. La salida: presentación y contrato de máquina

**F1 · Las fechas salen en UTC y corren pólizas de mes.** Verificado: `kernel/output.ts:99` es la única regla de fecha del renderizador, `if (value instanceof Date) return value.toISOString()`. Una póliza capturada el 31 de enero a las 20:00 en CDMX se imprime `2026-02-01T02:00:00.000Z`. El arreglo correcto está escrito, probado y razonado —`bill-command.ts:108-120` explica que «`toISOString()` lo movería un día al oeste de Greenwich»— y copiado cinco veces (`bill`, `customer`, `invoice`, `entry`, `report`) sin llegar nunca al kernel; `entry-command.ts` exporta `day()` en la 151 y usa `toISOString()` en la 362. Quedan 24 `toISOString()` en `src/cli`.
*Incumple:* es un defecto de correctitud, no de formato. *Duele a:* el contador en cada corte de periodo; en un despacho de 40 clientes, 40 veces en enero. *ALTA / S.*

**F2 · Importes sin separador de miles, con cuatro decimales, bajo encabezados en inglés.** `12458930.5500` bajo una columna que dice `debit_total`, sobre nombres de cuenta que dicen «Equipo de Cómputo». `money()` normaliza a `toFixed(4)` —el normalizar está bien razonado, la precisión elegida es la de almacenamiento, no la de presentación— y en todo `src/` hay **una** llamada a formato mexicano (`cfdi-decisions.ts:42`), enterrada en un servicio. Los encabezados son las llaves del objeto, que a la vez son el contrato de `--json`/`--csv`: por eso el arreglo no es traducirlas sino separar etiqueta de clave.
*Duele a:* el contador que confunde 1,245,893 con 12,458,930, y el que entrega la balanza al cliente. *ALTA / M.*
*Arreglo (cubre F1 y F2):* subir al kernel `dateOnly`, formato `es-MX` de fecha e importe y un mapa opcional de etiquetas, aplicados **sólo** en la rama `format === 'table'`. `json`, `ndjson`, `csv`, `tsv` y `md` no cambian un byte. Es la línea que hace segura la recomendación.

**F3 · El contrato de salida cubre 47 de 134 hojas.** Verificado: 48 usos de `withOutput` en `src/cli`. 24 hojas tienen `--json` a secas y 63 no tienen nada — y el corte no es aleatorio: los módulos contables clásicos usan el kernel y los del flujo insignia no (`drafts`, `review`, `ingest`, `pending`, `sessions`, `jobs list`, `jobs history`, `sat cred status`, `sat cred audit`, `entities`). `mnemosine.ts` tiene 140 `console.log` frente a 2 `render()`. Además `drafts` no muestra importe, así que no se puede triar por materialidad, que es lo primero que hace un contador. *MEDIA / L, pero una línea por hoja para las diez que importan.*

**F4 · Banderas de paginación declaradas y no honradas.** `ledger stale-draft list` declara `--limit`, `--offset` y `--all` y no pasa ninguna al servicio (`ledger-command.ts:145`), que ni los acepta; el SQL corta en `LIMIT 500` sin `COUNT(*)`, así que **el aviso de truncamiento no se dispara** — la violación exacta de la regla que `output.ts:19-23` declara como correctitud, en el comando descrito como «el bloqueador número uno de toda lista de cierre». `ledger auxiliary show` no tiene límite por omisión, aunque el mayor sí lo resolvió y lo documentó. La puerta de auditoría no lo atrapa porque verifica que la bandera **exista**, no que se honre. *MEDIA / S.*

**F5 · La tabla no conoce el ancho de la terminal.** `toTable()` calcula con `Math.max` y no consulta `process.stdout.columns`; el banner sí lo hace, en el mismo repositorio. Una balanza de 96 columnas en una terminal de 80 desprende `ending_balance` a su propio renglón. Aparte, el ancho se mide con `String.length`, así que texto en NFD —lo que produce macOS y muchos CSV exportados— desalinea una columna por acento; `grep -rn "normalize(" src/` devuelve cero. *MEDIA / M.*

**F6 · Bajo `--json`, el error no es JSON.** stdout queda en cero bytes (lo cual está bien) y stderr lleva texto plano. `CliError.detail` está declarado justo para esto (`exit.ts:59`) y no está conectado. Un consumidor recibe `jq: Unexpected end of input` en vez de saber que la base está caída. *MEDIA / S.*

**F7 · Tres arreglos de un renglón.** `Interrupted.` se escribe en **stdout** en el manejador global de SIGINT (`mnemosine.ts:2111`), así que un `> mayor.csv` interrumpido queda con esa palabra como última fila; las cinco ramas de `reportError` empiezan con un `\n` espurio que dobla el tamaño de un log; el encabezado de `ingest` va a stdout mientras su progreso va a stderr. Y ese progreso no dice posición sobre total, con 500 XML y una llamada al modelo por archivo. *BAJA / S.*

### G. Contratos declarados que el propio sistema no honra

**G1 · Trece códigos de salida y todo sale 1.** Verificado: `85 shutdown(0)`, `52 shutdown(1)`, `13 shutdown(130)`, cero literales entre 2 y 11, y `grep -rn "exitOverride" src/cli` → 0, así que todo error de uso de Commander sale por su propio `process.exit(1)` sin pasar por `shutdown()`, que es donde se drenan las atestaciones y se cierra el pool. Los constructores `needsHuman`, `validationFailed`, `blockedByState`, `externalFailed`, `abortedByUser`, `conflict`, `permissionDenied` tienen **cero** usos fuera del kernel. El código 11 —«no falló, espera a un humano», que existe literalmente para la ingesta que dejó 140 borradores— no se emite nunca. El comentario de `exit.ts:14-16` es la sentencia contra sí mismo: *«conflating "I found problems" with "I could not look" is how a green pipeline lies»*.
*Duele a:* el despacho que automatiza el cierre en `cron` y no puede distinguir «la balanza está descuadrada» de «la base no levantó». *ALTA / M, mecánico archivo por archivo.*

**G2 · El guardián que debía notarlo mide una lista escrita a mano.** `tests/cli/bilingual-matrix.spec.ts` verifica la cobertura de alias contra un mapa de 14 familias de 45, y su detector de restos en español son diez regex de frases literales de una auditoría anterior aplicadas a cuatro pantallas de 179. Pasa en verde, en 12.8 segundos, con 21 casos, mientras 13 hojas incumplen la política que dice fijar. Esta es la brecha que explica por qué existen las otras: **la enumeración no se deriva del árbol real**, aunque `export { program }` ya existe (`mnemosine.ts:2151`) y `scripts/generate-cli-reference.ts` ya lo camina. *ALTA / S.*

**G3 · Superficie declarada que no existe.** Trece banderas del `FLAG_DICTIONARY` que ninguna hoja lleva (`--profile`, `--config`, `--jq`, `--verbose`, `--null`, `--no-color`, `--no-pager`, `--watch`…) mientras el diccionario se justifica diciendo que «una bandera sólo puede existir en el CLI si existe aquí primero»; y el gancho de `riesgos-retrofit.ts:189-201`, con su comentario de seguridad detallado, protege contra un estado que ya no existe (0 filas graves en la tabla). En un sistema donde el comentario es la especificación, un comentario de seguridad obsoleto es deuda de auditoría. *BAJA / S.*

### H. Los flujos que no cierran

**H1 · La conciliación bancaria no existe en la terminal, y su ausencia pinta el cierre de verde.** Verificado: cero archivos en `src/cli` o `src/ai` referencian `services/banking`, y el único `INSERT INTO bank_accounts` de todo `src/` está en `seed.ts:172`. El motor existe (`services/banking/matching.ts`) y la API REST publica ocho rutas; la novena, la que cierra la conciliación, es un `501` deliberado y bien argumentado. Y el checklist cuenta cuentas bancarias sin conciliar con un `COUNT(*)` que **con cero cuentas da 0**, `is_complete` da `true` y el cierre reporta «Bank reconciliations complete» (`period-close.ts:50-69`, verificado). El mismo patrón afecta a depreciación: no hay `INSERT INTO fixed_assets` en `src`, y la partida sale en verde igual.
*Duele a:* el despacho en octubre, cuando el cliente pregunta por qué la 1120 trae 84 mil pesos de más. *ALTA / S el aviso, M-L la familia `bank`.*
*Arreglo inmediato:* que el checklist diga «0 cuentas bancarias registradas: no se pudo comprobar» en vez de dar verde. Un checklist que dice «completo» porque no hay nada que revisar es la peor forma de invisibilidad.

**H2 · `sat --help` promete la descarga de CFDI, y no existe.** Verificado: `sat-commands.ts:66` dice «SAT services (credentials and CFDI download)» y la única subfamilia es `cred`. Y `withCredential` —el envoltorio que debería consumir la e.firma— tiene cero llamadas reales: las tres menciones fuera de su propio servicio son comentarios que explican por qué **no** se usa. La ausencia está documentada con todas sus letras en `docs/wiki/Home.md:74`; la ayuda del comando, que es donde el contador mira, dice lo contrario. *ALTA / S corregir la ayuda; L la capacidad.*
*Duele a:* el socio que da de alta la e.firma de doce clientes y descubre el día 5 que no hay de dónde bajar los CFDI. Es una decisión de compra tomada sobre una promesa falsa.

**H3 · `tax=` significa cosas opuestas en `bill` y en `invoice`, y la ayuda de `bill` lo esconde.** En `invoice-command.ts:484` es una **tasa** (`tax_rate`); en `bill-command.ts:414` es un **monto** (`tax_amount`). El `--help` de `bill create --line` enumera cinco de las nueve claves aceptadas y **no menciona `tax`**. Además los separadores son tres: `:` en `entry`, `,` en `bill`, `;` en `invoice`. *ALTA / S.*
*Duele a:* quien registra 16 pesos de IVA acreditable donde iban 160, y no lo descubre hasta la declaración.

**H4 · Sin timbrado ni cancelación, el flujo de facturación no cierra.** Hay adaptadores de cuatro PAC y ningún comando los alcanza; la familia lo declara en su cabecera. La cancelación se retiró con un `501` honesto que además da el comando de recambio. *ALTA / L.*

**H5 · Sin Anexo 24 ni DIOT.** Cinco menciones descriptivas del Anexo 24 en `src/` y cero generadores; la DIOT sólo aparece como motivo de una bandera. Las tres piezas de preparación existen (`account map`, `ledger auxiliary`, la forma XC en `report-service.ts:908`). Es la obligación mensual que hace que un despacho compre un sistema contable. *ALTA / L.*

**H6 · `entry import` es una puerta de un solo sentido.** El propio comando lo imprime: «se valida y aplica con la familia batch (check/post) **cuando llegue**». La familia `batch` no existe. El contador queda con 1,847 pólizas en escenificación, ninguna en el mayor y ningún comando que las vea. *ALTA / M.* Y los layouts que faltan (`contpaqi`, `aspel`, `sat-polizas`) son los de los sistemas de los que el cliente viene; `onboard` sólo habla Contalink.

**H7 · No hay ninguna vista de todos los clientes a la vez.** Toda la superficie es de una entidad por invocación (85 hojas con `-e`); la única operación transversal del binario es reconstruir vistas materializadas. La primitiva existe (`entity list -q`), lo que convierte «¿a quién le falta cerrar julio?» en un bucle de shell — para un usuario que el enunciado del producto describe como alguien que no necesariamente sabe de terminales. Es la pantalla de inicio de QuickBooks Online Accountant y de Xero Practice Manager. *ALTA / M.*

**H8 · Las reglas de procesamiento sólo se administran por HTTP.** `processing_rules` es la capa 1 de la ingesta —la que gana sobre la IA— y su CRUD completo vive en `api/rest/routes/xml-ingestion.ts`, con cero comandos. Sin reglas, doce recibos de luz al año pagan tokens. *ALTA / M.* Lo más valioso sería `rule test <archivo.xml>`: probar la regla contra un CFDI real antes de encenderla.

**H9 · `period reopen` existe como servicio y no como comando.** Está escrito, probado y con tres cerrojos, y `src/auth/roles.ts:59` lo dice: *«reopenClosedPeriod existe pero sólo lo invoca el backfill de IVA; falta su ruta y su comando»*. Sin él, una corrección de marzo se registra en octubre y el papel de trabajo de marzo deja de cuadrar para siempre. *MEDIA / S.*

**H10 · PPD/PUE de una captura manual sólo se declara escribiendo la palabra dentro de un campo de texto libre.** `decideMetodoPago` tiene cuatro fuentes; la primera todavía no existe (columna reservada), la segunda exige CFDI, y la tercera es el literal `PPD`/`PUE` dentro de `--terms` o `--memo`, que ninguna ayuda menciona. No hay `--metodo-pago` en `bill create` ni en `invoice create`. El default conservador y la nota en la descripción del asiento están bien resueltos; lo que falta es la bandera. *ALTA / M.*

**H11 · Los asientos de cierre anual se saltan en silencio.** `period-close.ts:429-441`: si faltan las cuentas de sistema 3900 o 3200, `return []` — sin excepción, sin aviso, sin renglón de auditoría, y `hardClosePeriod` reporta éxito. Muerde a todo cliente migrado con catálogo propio. *MEDIA / S:* negarse con el motivo.

**H12 · La bitácora de auditoría no se lee desde la terminal.** `src/auth/roles.ts:64`: *«la bitácora no tiene ruta de consulta; hoy se lee por SQL»*. El único lector es `sat cred audit`. Para un despacho, la bitácora es lo que se enseña en una revisión. *MEDIA / M.*

**H13 · El alta deja huecos que nada anuncia.** `entity create` no crea el ejercicio fiscal y sólo sugiere `entity use`; el error de «no hay periodo abierto» tiene dos redacciones y la buena (`journal-entry-service.ts:425-429`, con `year create` y `period open` escritos) está en el camino que menos se usa, mientras los cuatro comandos de operación diaria reciben `No open fiscal period found for the entry date` sin remedio y con el código `PERIOD_CLOSED` cuando la causa es que el ejercicio nunca se creó. Tampoco hay `customer import`, `vendor import` ni familia `user`. *MEDIA / S.*

**H14 · Los reportes que el despacho entrega no salen como se entregan.** Sin PDF ni XLSX, sin columna comparativa contra el periodo anterior, y sin un comando que arme el paquete mensual: son seis invocaciones sueltas por cliente, por mes. El `-o` con seis formatos es la primitiva correcta y está bien hecha; falta el juego. *MEDIA / M.*

---

## 3. Las diez primeras

Ordenadas por consecuencia para un despacho, no por facilidad. Las cinco primeras se pueden empezar el lunes y terminar en la semana.

| # | Qué | Brecha | Esfuerzo | Por qué está aquí |
|---|---|---|---|---|
| 1 | **Una sola gramática de «sí», anclada, y que la respuesta no reconocida vuelva a preguntar** | A1 | S | Es la única brecha del informe que puede destruir estado contable por sí sola: `salir` cierra un periodo en duro. Y su gemela cuesta confianza todos los días: `sí` aborta un posteo sin decir que no entendió. El helper ya existe y ya está exportado. |
| 2 | **Subir `dateOnly` al kernel y formatear fecha e importe sólo en `table`** | F1, F2 | S | Es correctitud, no cosmética: hoy una póliza del 31 de enero se lee como del 1 de febrero, en el corte de periodo. El arreglo está escrito cinco veces en el repositorio y nunca subió. Nada de lo que consume una máquina cambia. |
| 3 | **Arreglar la ayuda y la semántica de `tax=` en `bill create`** | H3 | S | Un error de captura silencioso que mete el IVA acreditable con un factor de diez, y no aparece hasta la declaración. Renombrar a `tax-amount`/`tax-rate` y documentar las nueve claves. |
| 4 | **Un solo redactor de errores: `reportError` → `repairCommandFor`, y ramificar `entity-context` por causa** | B1, B2 | S | 134 puertas mudas y 85 hojas que misdiagnostican una caída de conexión como problema de selección de empresa, con un remedio que no puede funcionar. El código que lo arregla existe, es puro y está probado. Un llamador más. |
| 5 | **Declarar `bin` en `package.json` y alinear la versión** | C1 | S | Mientras no exista, todos los remedios de los puntos 1-4 citan un comando que el usuario no tiene. Es el prerrequisito de que cualquier mejora de mensajes sirva de algo. |
| 6 | **Que el checklist de cierre no dé verde por vacuidad** | H1 | S | «Bank reconciliations complete» con cero cuentas registradas es la peor mentira que puede decir un sistema contable: firma un cierre afirmando que se verificó algo que nadie miró. Lo mismo con depreciación. El aviso correcto es una línea; la familia `bank` viene después. |
| 7 | **Corregir la ayuda de `sat`** | H2 | S | «SAT services (credentials and CFDI download)» es una promesa sobre la que se toma una decisión de compra y sobre la que se entregan doce e.firmas. El wiki ya es honesto; la ayuda, que es donde el contador mira, no. |
| 8 | **Mover la capa explicativa y el preview a `pending -v`** | E1 | S | Es la mejor pieza de diseño del producto —ningún competidor la tiene— y hoy se muestra sólo el día uno, cuando por construcción no tiene datos que enseñar. Reusar dos módulos ya escritos en `renderPolicies`. |
| 9 | **Idempotencia dentro de la transacción del acto, y derivada por omisión** | A2 | M | Es el único caso donde el sistema puede escribir a medias sin que el usuario se entere, y ocurre en pagos, donde no hay red de dominio. La ayuda ya promete la protección que hoy no da. |
| 10 | **`addHelpText` con ejemplos reales en las veinte hojas del uso diario** | C2 | M | Es la brecha de mayor costo por hora perdida para el usuario declarado: cero ejemplos en 134 hojas frente a un manual en español que no menciona el binario. Empezar por `entry create`, `ingest`, `review`, `close`, `report trial-balance show`. |

**El siguiente tramo, por si la primera semana rinde:** 11) sugeridor en la raíz y normalización de acentos (C3); 12) traducir `pending-catalog.ts` (D2); 13) cerrar el contrato de códigos de salida con `exitOverride` y `exitCodeFor` (G1); 14) que el guardián camine el `program` exportado en vez de una lista a mano (G2) —sin esto, todo lo anterior se vuelve a romper—; 15) filtros, lote y `--json` en `drafts`/`review` (E3).

---

## 4. Lo que ya está bien, con nombre, y no hay que tocar

Esto es acreditación, y también protección: son decisiones correctas que una refactorización distraída puede deshacer.

1. **`doctor`.** Enumera todo aunque el primero falle, distingue `✘` de `⚠`, ordena por dependencia, da el comando exacto de cada remedio y sale 1. Es el modelo que el resto debe copiar, no un candidato a rediseño.
2. **`status` como salida compartible.** Sale 1, no filtra secretos y lo declara: «Redacted output: no keys, tokens or home paths. Safe to share in support tickets.» Pocos CLI lo hacen.
3. **El dinero nunca es número JSON** (`kernel/output.ts:14-17`) y **el truncamiento nunca es silencioso** (`:19-23`). Dos reglas de correctitud que QuickBooks y Xero no toman.
4. **Los totales se suman sobre todo y la página se corta después** (`report-command.ts:59-61`, `pageOf`), y el pie de la balanza va a stderr a propósito, con su razón escrita: «una fila TOTAL extraviada es una mina en un csv que alguien importa».
5. **`rejectStatus()`**: se niega a honrar una bandera que no puede honrar, en vez de ignorarla en silencio. El principio está bien articulado y hay que extenderlo, no quitarlo.
6. **stdout queda en cero bytes cuando el comando falla.** Un `> balanza.csv` que falla deja un archivo vacío, no uno a medias.
7. **`NO_COLOR`** con su razón citando no-color.org (`palette.ts:23`), el diccionario de banderas cortas que reserva `-f` para nada porque se lee a la vez como `--file` y `--force` (`flags.ts:19-21`), y los once deletreos prohibidos.
8. **`declareRisk` y `gateMutation`**: rompen el arranque si alguien marca como invocable por el agente un comando irreversible, y fallan cerrado si una hoja pide compuerta sin declarar riesgo. Las 17 hojas graves llevan las tres banderas, sin excepción. Ningún competidor tiene llave de idempotencia en la interfaz de usuario.
9. **La aprobación atada al hash del contenido que el revisor vio** (`mnemosine.ts:1108`, `draft-service.ts:48-56`), y la aprobación de un borrador como transacción única con reversa completa si el estado cambió en medio.
10. **`cfdi explain`**: caso, hechos y decisiones del clasificador. No tiene equivalente en CONTPAQi, Aspel, QuickBooks, Xero ni NetSuite, y es material de papel de trabajo.
11. **La vista previa de política contra los datos propios del cliente** (`policy-preview.ts:6-15`), con su regla de degradar a silencio antes que inventar un ejemplo.
12. **El veredicto de la sombra** (`047_el_veredicto_de_la_sombra.sql`): las compuertas corren completas, el veredicto se registra con los umbrales vigentes y nada toca el mayor. Es la respuesta correcta a «¿cuándo confío en el agente?».
13. **El IVA en base de flujo**: el default conservador por lado del documento, el reconocedor que descarta «Cholula, Pue.» y «PPD-2026-04», y la suposición escrita en la descripción del asiento. Mejor que lo que hace CONTPAQi.
14. **Los `501` honestos** de conciliación y cancelación: explican el daño que evitan y nombran el sustituto manual. Un 501 que enseña el camino vale más que un 200 que miente.
15. **`--dry-run` de `ingest` declarando su propio alcance**, y `--dry-run` avisando que la llave de idempotencia no aplica al lote.
16. **La disciplina de cierre**: no se puede cerrar un mes con uno anterior abierto, y el valor por omisión es el más viejo. CONTPAQi deja cerrar salteado. Y el checklist se evalúa **dentro** de la transacción del cierre, con su razón escrita.
17. **`entity show` dice por qué está seleccionada esa entidad** (`flag`, `env`, `stored`, `only`).
18. **El vocabulario cerrado de verbos** (`kernel/vocabulary.ts`) con auditor contra el binario real y línea base que sólo puede encoger (40 → 36). El mecanismo de congelación es correcto; lo que hay que hacer es usarlo más, no cambiarlo.
19. **Los alias contables centrales están bien elegidos**: `balanza`, `mayor`, `resultados`, `antigüedad`, `contabilizar`, `auxiliar`, `ejercicio`, `alta`, `cierre`, `factura-proveedor`. Quien los escribió sabe contabilidad mexicana.
20. **El catálogo de cuentas sembrado y el glosario del wiki** (47 entradas, 13 con su comando). El trabajo de traducción ya está hecho y revisado; falta conectarlo.
21. **La ceremonia de la e.firma**: eco apagado, consentimiento explícito, bitácora, revocación irreversible y aviso si el `.key` es legible por otros usuarios.
22. **El manejo de EOF y SIGINT en la cola de revisión**, y el rechazo a asumir consentimiento sin terminal: `re-run with --yes once you are sure, or with --dry-run to see the effect first`.

---

## 5. Las tres decisiones de producto

No son técnicas y no me toca tomarlas. Las formulo con sus opciones y su costo.

### 5.1 · ¿En qué idioma habla el producto?

Hoy la respuesta escrita es «inglés, con alias en español» (`src/cli/README.md:396`, `docs/cli-command-catalog.md:2050`) y la respuesta ejecutada es «inglés con fugas impredecibles»: 2 nodos de 179 en español, 19 de 460 errores, cuatro capas distintas de mezcla, y el agente contestando en español por omisión.

- **(a) Inglés puro, alias españoles completos.** Costo: hay que limpiar las fugas —los valores de `--chart`, `cfdi list --direction`, la ayuda de `account map import`, la salida de `entry import`, los dos nodos de `ai`— y aceptar que la auxiliar contable lee `Post P-0042 to the ledger? This cannot be undone.` mientras evalúa contra CONTPAQi, que dice `¿Contabilizar la póliza P-0042?`. Es la opción barata y la que peor compite.
- **(b) Español completo, con nombres canónicos y llaves de `--json` en inglés estable.** Costo: 1,848 palabras de descripción más 6,883 de opciones, más los 441 mensajes de error, más separar etiqueta de clave en `render()`. Es un proyecto de semanas, y es lo que el usuario declarado necesita. El 21 % del texto (las descripciones) da el 80 % del beneficio.
- **(c) Bilingüe gobernado por `MNEMOSINE_LANG`**, que hoy sólo cambia una constante del prompt del sistema. Costo: el más alto y el más duradero, porque cada cadena nueva paga peaje para siempre.

**Lo que hace que esta decisión no pueda esperar:** los nombres de periodo se persisten en inglés a propósito y sin traducción en tiempo de render (D5). Cada ejercicio abierto y cada cliente dado de alta encarece la opción (b) y la (c). La decisión tiene fecha de caducidad aunque nadie la haya puesto.

### 5.2 · ¿Qué es mnemosine: el sistema contable del despacho, o el motor auditable que se conecta al que ya tienen?

Hoy el producto dice ser lo primero y le faltan cuatro piezas que ningún despacho mexicano considera opcionales: conciliación bancaria operable, timbrado y cancelación, Anexo 24 y DIOT. La familia `sat` incluso promete una quinta que no tiene.

- **(a) Sistema completo.** Costo: los cuatro flujos son L y son de calendario fiscal, no de conveniencia. Mientras no estén, el checklist de cierre miente por vacuidad y el flujo de facturación no cierra. Ganancia: se puede vender contra CONTPAQi.
- **(b) Motor auditable complementario.** Costo: hay que decirlo en la ayuda, en el README y en el discurso comercial, y hay que invertir en interoperar de verdad —`entry import` con layouts de CONTPAQi y Aspel, `onboard` con esos dos adaptadores en vez de sólo Contalink, exportación con la forma que esos sistemas leen—. Ganancia: el alcance se vuelve honesto y el diferenciador (la IA que propone con rastro auditable) queda al frente.
- **(c) Lo de hoy: prometer (a) y entregar (b).** Costo: el que ya se está pagando, y se paga en el peor momento —el día 5 del mes, después de haber entregado doce e.firmas.

### 5.3 · ¿La unidad de trabajo es la entidad o el despacho?

Todo el producto es de una entidad por invocación (85 hojas con `-e`), sin ninguna vista de cartera. El enunciado dice que el usuario es un despacho con varios clientes.

- **(a) La entidad, y el despacho se resuelve con guiones de shell.** Costo: `entity list -q | while read id; …` para responder «¿a quién le falta cerrar julio?», en un producto cuyo usuario declarado no necesariamente sabe de terminales. Y sin vista de cartera, las preguntas del agente en siete de cuarenta clientes no se enteran.
- **(b) El despacho como primera clase:** `firm status`, cierre por lote, panel de pendientes cross-entidad, políticas heredables. Costo: M-L, y obliga a decidir qué se hereda del despacho y qué es del cliente. Ganancia: es la pantalla de inicio de QuickBooks Online Accountant y de Xero Practice Manager; es lo que separa una herramienta de contribuyente de una herramienta de despacho.

Esta decisión arrastra una segunda, implícita: **quién opera el CLI**. Si es el socio técnico, `bin`, `completion` y `--json` bastan. Si es la auxiliar de captura —que es quien teclea— entonces 5.1 se resuelve sola en (b) y los ejemplos dejan de ser opcionales.

---

## 6. Cómo se mide el avance

«La usabilidad mejoró» no es un dato hasta que hay un instrumento que lo devuelva. La casa ya tiene la forma correcta —`npm run plan:status`, criterios ejecutables, `LINEA_BASE` que sólo puede encoger, `auditProgram` corriendo contra el `program` real— y la lección de G2 es que el instrumento debe **derivarse del árbol**, nunca de una lista escrita a mano en paralelo. Siete instrumentos, seis automáticos y uno de campo.

**1. Censo de superficie, derivado del `program` exportado.** `export { program }` ya existe (`mnemosine.ts:2151`) y `scripts/generate-cli-reference.ts` ya lo camina. Un `npm run ux:status` que recorra las 134 hojas y devuelva seis números, cada uno con línea base que sólo puede encoger:

```
hojas sin ejemplo en la ayuda        134 → 0
hojas sin contrato de salida          87 → 0   (de las declaradas lectura)
hojas sin alias en español            14 → 0
nodos con descripción fuera del
  idioma canónico                      2 → 0
hojas graves sin las tres banderas     0 → 0   (ya en cero: no debe crecer)
banderas del diccionario sin hoja     13 → 0
```

**2. Prueba de gramática de confirmación.** Una sola función; el test recorre las hojas con riesgo `irreversible|externo` y falla si alguna acepta un token fuera de `y|yes|s|si|sí` o rechaza uno dentro. Hoy la tabla de verdad tiene cuatro columnas distintas; el criterio es que tenga una.

**3. Prueba de contrato de códigos de salida.** Una docena de invocaciones fallidas conocidas —subcomando inexistente, bandera mal escrita, archivo que no existe, id que no existe, base caída, `check` con hallazgos, ingesta que dejó borradores— con su código esperado. Hoy las diez medidas dan 1; el criterio es que ninguna clase comparta código con otra. Añadir `program.exitOverride()` es parte del arreglo y parte de la medición.

**4. Prueba de «cero errores mudos».** Correr cada hoja con la base caída y afirmar que stderr contiene una línea `→ <comando>`. Es el criterio que convierte B1 y B2 en un número: **hojas sin remedio: 134 → 0**.

**5. Prueba de honramiento, no de declaración.** Por cada hoja que declare `--limit`, correr el manejador contra un servicio simulado y afirmar que el límite llegó al servicio y que el `total` volvió al `render`. Habría atrapado `ledger stale-draft list` y atrapa al siguiente. La regla vieja —«declara la bandera»— se queda; ésta es la mitad difícil.

**6. Instantáneas de presentación.** Golden files de `render()` en `table` con `TZ=America/Mexico_City`, importes de siete dígitos, nombres con acentos en NFC y en NFD, y anchos de terminal de 80 y 120. Fija F1, F2 y F5 de una vez, y garantiza que `json`, `csv` y `tsv` no cambian un byte.

**7. El mapa de flujos, y el número que lo resume.** Un guion de aceptación que ejecute los siete flujos del despacho —CFDI a póliza, facturar y cobrar, capturar y pagar, conciliar, cerrar el mes, estados financieros, alta de cliente— contra una base sembrada, y que reporte cuántos pasos **no se pueden dar desde la terminal**. Hoy son once (el `⛔` de `flujos-reales`). Ese conteo es la métrica más honesta que tiene el producto, porque no premia el pulido de lo que ya existe.

**Y el único que no sale de un test: tiempo a la primera póliza contabilizada.** Cronometrar a un contador que no conoce el producto, con la documentación que hay, desde `init` hasta un `entry post` exitoso, sin ayuda humana, y anotar dónde se atora. Todo lo demás de esta lista predice ese número; ninguno lo sustituye. Si al terminar las diez primeras ese tiempo no baja, la tesis de este informe estaba mal.
