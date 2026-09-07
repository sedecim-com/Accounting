# El idioma del código y el de la interfaz

> Documento rector. Escrito el 2026-09-06 sobre `main` (`b31e62a`), a partir de un inventario del idioma de cada superficie del árbol —ocho lectores con conteos reproducibles (el comando de cada cifra está en los informes) y escépticos que los volvieron a correr—. Todo lo que aquí se dice que **existe** lleva `archivo:línea`; todo lo que se dice que **se propone** no existe todavía. Cuando este documento y el código discrepen, gana el código y este documento se corrige en el mismo PR.

## 0. El pedido, y las tres capas que esconde

La instrucción es una frase: *todo el código basado en inglés y, a partir de ahí, traducido a distintos idiomas dejando primero el español*. Para cumplirla sin romper lo que ya funciona hay que separar tres capas que hoy están mezcladas, porque **no se traducen igual**:

| Capa | Qué es | Idioma | Cómo se cambia |
|---|---|---|---|
| **Lo que lee la máquina y el programador** | identificadores, nombres de archivo, comentarios, claves de catálogo, códigos de error, nombres canónicos de comando, columnas nuevas | **inglés**, y sólo inglés | renombrando, con *codemod* y con los instrumentos actualizados en el mismo commit |
| **Lo que lee el usuario** | ayuda y mensajes del CLI, errores de la API, rótulos de informes, preguntas y etiquetas del panel, avisos de `doctor`, respuestas del agente | **el del usuario**: español primero y por omisión, inglés segundo, los demás después | extrayendo el texto fuente (en inglés) a un catálogo y renderizando en el idioma resuelto |
| **Lo que es dato** | valores persistidos (claves y valores del panel, listas `CHECK`, nombres de migración, códigos de error ya publicados, verbos del CLI), textos históricos ya escritos en la base, textos que una autoridad exige en su idioma (el XML del SAT en español, las formas del IRS en inglés) | **el que tiene**; los nuevos nacen en inglés | no se renombra ni se traduce: se documenta como **vocabulario estable** y se renderiza con etiqueta al mostrarlo |

Confundir las capas es el error que este documento existe para evitar: traducir un valor persistido es una migración de datos bajo RLS, no una traducción; renombrar un código de error es romper a todos los clientes HTTP en silencio; y «poner la ayuda en español» sin decidir contra qué mide `ux:status` es poner en rojo un trinquete que hoy vigila justamente lo contrario.

## 1. Lo que hay hoy, contado

Los informes completos, con el comando de cada cifra, están en [`docs/investigacion/2026-09-06-idioma/`](investigacion/2026-09-06-idioma/). Aquí, lo que decide el diseño.

### 1.1 La capa de la máquina está a medias, y por fecha

- **Identificadores**: 4 637 declaraciones de nivel superior en 376 archivos de `src/`; 49 % en inglés, 45 % en español, 5 % mixtas (heurística con 1,5 % de error medido sobre 200 revisados a mano). La partición no es por capa sino **por fecha**: `types`, `utils`, `config`, `ar`, `ap`, `policy`, `vault`, `ai/skills` y el esquema GraphQL están al 98-100 % en inglés; `banking` (88 %), `sat` (87 %), `fiscal` (95 %), `backup`, `accruals`, `fx`, `plan` (91 %) y `jurisdiccion` (100 %) en español; `accounting` y `payroll` son costura al 35 %. 200 de los 766 símbolos que cruzan carpetas son españoles (`registrarAuditoria` con 20 consumidores, `confirmarConReintento` 16, `declararRiesgoRuta` 16).
- **Nombres de archivo**: 41 de 376 `.ts` en español (`pais-contable.ts`, `criterios.ts`, `moneda-origen.ts`, `balanza-*.ts`, `criterio-cierre.ts`…); 35 de 75 migraciones, **que no se renombran jamás** (`migrate.ts:66-68` registra por nombre de archivo; `docs/migraciones.md`).
- **Comentarios**: 29 309 líneas en `src/`, **78 % en español** (22 721), JSDoc al 69 %. No es lo viejo ni lo nuevo: es el estilo de la casa desde el primer commit, ordenado por escrito en `CONTRIBUTING.md:158` («Los comentarios y la documentación van en español»), `README.md:345` y `docs/PROCESS.md:58` (commits). La mitad de ese español vive en 776 bloques de ocho o más líneas que argumentan el porqué y citan 787 veces paquetes del plan.
- **Esquema**: 115 tablas (5 españolas), 1 868 columnas (117 con palabra española, en 25 tablas), 134 listas `CHECK` con 43 literales españoles, y un solo campo español en `src/types/index.ts` (`codigo_agrupador_sat`). De las columnas españolas, ~77 **espejan un atributo del SAT, del IMSS o de la DIOT** (`xml_documents.forma_pago`, `metodo_pago`, `tipo_factor`…): son vocabulario de la autoridad, no de la casa.
- **Pruebas e instrumentos**: 232 de 336 spec con títulos en español; 139 con nombre de archivo español; 82 pruebas importan módulos con nombre español. Y el acoplamiento que decide el orden de todo lo demás: **51 de 133 criterios ejecutables se rompen con un renombre masivo** (40 por ruta, 15 por identificador), 19 anclas de mutantes citan identificadores españoles, los umbrales de cobertura por archivo viven por triplicado (`vitest.config.ts`, `vitest.integration.config.ts`, `criterios.ts:575-604`) con el criterio E0.1 diseñado para ponerse rojo ante un renombre, el piso `docs/criterios-minimos.json` usa **el enunciado en español como identidad** de 69 criterios (`status.ts:165`), y `manifiesto.json` sella 46 archivos por hash completo, comentarios incluidos.

### 1.2 La capa del usuario está al revés en dos sitios

- **CLI**: la **ayuda** está en inglés al 99 % (1 397 cadenas; 6 en español) y así lo exigen `tests/cli/bilingual-matrix.spec.ts:310-323` («help text is English»), `scripts/ux-status.ts:214` (línea base de 7 nodos fuera del idioma canónico, puerta `--check` en `ci.yml:176`) y la regla R8 de `docs/cli-command-catalog.md:204-208` («el español es una capa de alias, nunca una segunda superficie»). Pero la **ejecución** es bilingüe por familia: de 1 827 cadenas de salida, error y prompt, 495 están en español y 199 son mixtas, concentradas en las familias fusionadas los días 1-3 de septiembre (`bank` 246, `prepaid` 49, `batch` 43, `e-accounting` 39…). **24 archivos enseñan en inglés y contestan en español**, y ninguna puerta lo mide porque `ux:status` sólo censa la ayuda.
- **API**: `src/api` emite el 81 % de sus cadenas en inglés y `src/services` el 81 % de las suyas en español, y ambas viajan sin transformar por el mismo sobre (`{errors:[{code,message,field,details}],meta}`). De 72 códigos de error en circulación, **24 llevan vocablo español** (`SOD_QUIEN_CREA_NO_POSTEA`, `CFDI_REQUIERE_DECISION`, `INPC_*`…) y el mismo `PERIOD_ALREADY_OPEN` sale en español en `fiscal-calendar-service.ts:246` y en inglés en `:376`. No hay negociación de idioma (cero lecturas de `Accept-Language`).
- **El panel de políticas está exactamente al revés del pedido**: 53 claves y 93 valores **en español** (persistidos en `policy_decisions`, no se tocan) bajo 131 etiquetas y 48 preguntas **en inglés** (`pending-catalog.ts`). El contador mexicano lee en inglés una pregunta cuya respuesta se guarda en español.
- **El agente** ya tiene el único resolutor de idioma del sistema —`MNEMOSINE_LANG` > `./mnemosine.config.json` > `~/.mnemosine/config.json` > `'es'` (`src/ai/providers/config.ts:1119-1131`)— y sólo lo usa él (`system-prompt.ts:171-185`, `LANGUAGE_LINE`). El prompt, las 25 herramientas y sus 49 descripciones ya están en inglés; el corpus está en español donde es norma (`nif-*`, `niif-*`) y en inglés donde es sistema.
- **Formato**: cero `Intl` en `src/`; 8 `toLocaleString` con locale cableado (7 `en-US`, 1 `es-MX`), 569 `toFixed`, 313 plurales a mano («fila(s)»), separador de miles a mano (`output.ts:176`), fechas `DD/MM` por omisión en los lectores bancarios. Ni columna de idioma ni de zona horaria en 74 migraciones; ni bandera `--lang` en el kernel.

### 1.3 Lo que ya se escribió en un idioma y no se puede re-traducir

- **El mayor**: unas 120 plantillas de descripción de póliza en 11 escritores, **casi todas en inglés** (`Reversal of …`, `Year-end closing entries`, `VAT on bank fee parked in 1135…`, 54 en `cfdi-taxonomy.ts`), y esas cadenas **viajan al SAT como `Concepto`** del Anexo 24 (`polizas-service.ts:949-980`). El mayor posteado es inmutable por trigger (`041:42-70`): las filas que ya existen se quedan como están.
- **El catálogo sembrado** es español incluso para entidades estadounidenses (41 cuentas de `chart-seed.ts`, 24 de roles) salvo las 9 de nómina US; los **nombres de periodo** se persisten en `en-US` (`'January 2026'`, `fiscal-calendar-service.ts:534`) y el usuario los teclea para buscar (`close-command.ts:196`).
- **`audit_log.reason`** es sólo-agregar (033) y recibe sus 8 motivos de sistema casi todos en español; `ai_drafts.review_notes = 'auto-post by threshold%'` es un discriminador en dos servicios y dos criterios: cambiar la cadena parte la estadística histórica en dos.

## 2. Las reglas

1. **La capa de la máquina es inglesa, y lo nuevo nace inglés desde el día uno.** Identificadores, nombres de archivo, comentarios, claves de catálogo, códigos de error, columnas y valores nuevos: en inglés. Un lint lo hace fallar en CI para lo nuevo; lo existente entra a una línea base que **sólo encoge**. Esto invierte `CONTRIBUTING.md:158` y `README.md:345`, que se reescriben en el mismo PR que instala el lint.
2. **Toda cadena que lee un usuario tiene una clave y una fuente en inglés, y el catálogo español es completo antes de que la clave se use.** Una clave sin traducción al español **falla una prueba**, no cae en silencio al inglés. El inglés es la segunda traducción, no la fuente que se muestra.
3. **Lo que se persiste se persiste como clave y parámetros, y se renderiza al leer.** Descripciones de póliza, motivos de auditoría, nombres de periodo, textos del panel congelados por inquilino: la fila guarda `key` + `params`, la salida los renderiza en el idioma resuelto. Lo histórico se queda como está y se muestra tal cual.
4. **Lo que es vocabulario estable no se renombra: se documenta en inglés.** Claves y valores del panel (53 + 93), 43 valores de `CHECK`, 24 códigos de error españoles ya publicados, 35 nombres de migración, los verbos y nombres canónicos del CLI, las ~77 columnas que espejan al SAT/IMSS/DIOT. Cada uno gana una línea en inglés en el sitio donde se declara (`as const` con su comentario, o el registro de vocabularios de `enums.ts`) y los nuevos nacen en inglés.
5. **Idioma, formato y jurisdicción son tres cosas.** El **idioma** sigue al usuario (usuario > inquilino > entidad > sistema; `--lang`, `MNEMOSINE_LANG`, `Accept-Language`). El **formato** —fechas, números, moneda— sigue a la jurisdicción y a la moneda de la entidad, nunca al idioma. Los **artefactos a terceros** siguen a la autoridad: el XML del SAT en español, las formas del IRS en inglés, aunque el usuario lea en el otro.
6. **Los instrumentos miden la fuente, no el render.** `ux:status`, `generate-cli-reference.ts`, la matriz bilingüe y los criterios siguen viendo el inglés canónico; el catálogo se aplica al renderizar. Un instrumento nuevo, `i18n:estado`, mide lo que este documento cambia, y sus cifras sólo bajan.
7. **Fuera del pedido y por decidir**: los mensajes de commit y la documentación (`docs/`, wiki, auditorías). El pedido dice «código»; la voz de la casa es española y sus 787 citas a paquetes del plan la sostienen. Este documento **no lo decide**: lo deja como decisión del dueño (§6) con una omisión —siguen en español— que se puede cambiar sin tocar nada de lo anterior.

## 3. La maquinaria

### 3.1 El metro: `npm run i18n:estado`

Como `catalogo:estado` y `ux:status`: recorre el árbol, escribe su bloque en este documento (entre marcadores) y la CI verifica con `--check` que no esté desfasado; `--piso` guarda las cifras y falla si alguna **sube**. Lo que cuenta, cada una con su comando publicado:

| Cifra | Hoy | Hacia |
|---|---:|---:|
| Identificadores de nivel superior en español o mixtos en `src/` | 2 284 | 0 |
| Archivos `.ts` de `src/` con nombre español o mixto | 51 | 0 |
| Cadenas de ejecución del CLI sin clave de catálogo | 1 827 | 0 |
| Cadenas de ayuda del CLI sin clave de catálogo | 1 397 | 0 |
| Mensajes de `AccountingError` en servicios sin clave | 108 | 0 |
| Textos del panel (question/impact/labels/whyAsking…) sin clave | 232 | 0 |
| Escritores de póliza/auditoría que persisten prosa en vez de clave | 11 + 8 | 0 |
| Claves del catálogo sin traducción al español | — | 0 siempre |
| Claves del catálogo sin traducción al inglés | — | 0 siempre |
| Líneas de comentario en español en `src/` | 22 721 | informativa (§6) |

Las líneas base se congelan en el primer commit del instrumento y sólo encogen; un PR que suba una cifra falla en CI. Es el mismo trinquete que `--exigir` y `--piso` de `plan:status`.

### 3.2 El lint: identificadores nuevos en inglés

Una regla propia de ESLint (`mnemosine/english-identifiers`) sobre declaraciones de nivel superior y nombres de archivo: falla si el nombre contiene una raíz española de una lista mantenida en el repo (la misma que usó el inventario, con 1,5 % de error medido) y no está en la **línea base** (`docs/i18n-linea-base.json`: los 2 284 de hoy, uno por línea, que sólo se pueden quitar). Los falsos positivos se resuelven con `// i18n-allow: <razón>`, que el metro cuenta. El lint corre en el job `lint` que ya existe (`--max-warnings` es un trinquete: aquí es error, no advertencia).

### 3.3 El catálogo de textos

- **Dónde**: `src/i18n/` con un archivo por idioma y por superficie (`cli.es.json`, `cli.en.json`, `api.es.json`, `panel.es.json`, `ledger.es.json`…), claves jerárquicas (`bank.match.run.capped`), formato **ICU MessageFormat** para plurales, género y números (`{n, plural, one {# fila} other {# filas}}`), que resuelve de raíz los 313 plurales a mano. Motor: `intl-messageformat` (FormatJS), sin *framework*.
- **Cómo se llama**: `t('bank.match.run.capped', { n })` desde el kernel del CLI (`src/cli/kernel/`), donde ya vive el único `render()` (199 llamadas), el único embudo de errores (`CliError` → `reportError`, `exit.ts:56`) y donde falta un `t`. En servicios, `AccountingError` gana `messageKey` + `params` y conserva `message` en inglés para los registros; el sobre de la API añade `meta.language` y renderiza `message` en el idioma negociado; el CLI renderiza el `messageKey` en el idioma del usuario. **Los códigos no cambian.**
- **La ayuda del CLI**: Commander 15 ofrece `configureHelp`, `helpOption`, `helpCommand` y `configureOutput`: la descripción se declara en inglés en la fuente (lo que `ux:status` y `generate-cli-reference.ts` siguen midiendo) y se traduce **al renderizar** la ayuda. El orden de arranque manda: las descripciones se fijan antes de `parseAsync`, así que el idioma de la ayuda se resuelve **antes** de registrar las familias (variable de entorno, config y `--lang` leído a mano de `process.argv`), y `generate-cli-reference.ts` fija `--lang en` como fija ya el ancho.
- **La prueba de sincronía**: como `tests/ai/niif-registry.spec.ts`: toda clave usada en `src/` existe en `es` y en `en`; toda clave de `es` existe en `en`; ninguna clave sobra; los parámetros de cada mensaje coinciden entre idiomas. Falla, no avisa.
- **Quién traduce**: el mismo PR que añade la clave añade `en` (fuente) y `es` (primera traducción); un tercer idioma es un archivo nuevo y un renglón en la prueba. El agente puede **proponer** traducciones; una persona las aprueba en el PR, como todo lo demás.

### 3.4 Lo persistido: clave y parámetros

- `journal_entries.description_key`, `description_params JSONB` (y lo mismo en `journal_entry_lines`, `audit_log`, `fiscal_periods.period_key`): migración append-only (la siguiente libre), **sin rellenar lo histórico**; los escritores nuevos escriben clave + parámetros **y** la prosa en inglés en la columna vieja, para que nada que lea `description` se rompa. La lectura renderiza la clave si existe y cae a la prosa si no. El trigger de inmutabilidad (`041:42-70`) no se toca: las columnas nuevas sólo se escriben al insertar.
- **El Anexo 24 exige español**: el `Concepto` de cada póliza se renderiza **en español, siempre**, desde la clave, sin importar el idioma del usuario (regla 5). Hoy sale en inglés porque copia `description` (`polizas-service.ts:949-980`); es un defecto fiscal, no sólo de idioma, y es el primer lugar donde esta arquitectura paga.
- **Los nombres de periodo** pasan a `period_key` (`'2026-01'`) con `period_name` conservado; la búsqueda del usuario (`close-command.ts:196`) casa contra la clave y contra el nombre renderizado en su idioma.
- **El panel**: `question`, `impact`, `whyAsking`, `whatIDo`, `ifSkipped` y las `label` de opciones salen del catálogo; `policy_decisions` deja de copiar `question`/`impact`/`options` congelados por inquilino (`policy-service.ts:51-61`) y guarda sólo la clave del catálogo y su versión; los `key` y `value` **no cambian**.

### 3.5 Idioma, formato y jurisdicción

- **Resolución del idioma**: `--lang <es|en>` (bandera global nueva en el diccionario del kernel, un solo significado) > `MNEMOSINE_LANG` > preferencia del usuario (columna nueva `user_preferences.language`, o el `settings JSONB` del inquilino que ya existe en `001:23`) > `mnemosine.config.json` > `'es'`. En REST, `Accept-Language` > preferencia del inquilino > `'es'`; la respuesta declara `meta.language`. El resolutor es **uno** (`src/i18n/locale.ts`), y el del agente (`resolveLanguage`) pasa a leerlo.
- **Formato**: `Intl.NumberFormat`/`DateTimeFormat` con el locale de **formato** derivado de la jurisdicción y la moneda de la entidad (`jurisdictionOf(entity).formatLocale`: `es-MX` para MX, `en-US` para US), no del idioma del usuario. Un contador mexicano que lee en inglés sigue viendo `1,234.56 MXN` y `31/01/2026`. Se fija el locale del *runner* en CI (`full-icu`) para que ningún `toLocaleString` caiga en silencio a `en-US`. **La rama `table` es la única que formatea**; `json`, `csv`, `ndjson` y `md` siguen entregando la cadena de almacenamiento intacta (`tests/cli/kernel/presentation.spec.ts:10-14`).
- **Jurisdicción**: el `informes.idioma` que `docs/jurisdicciones.md` §3.2 ponía en el paquete se **reparte**: los rótulos de un informe para el usuario siguen al idioma; los artefactos estatutarios (Anexo 24, DIOT, 941, W-2) siguen al paquete. El paquete declara `statutoryLanguage`, no el idioma de la interfaz.

### 3.6 Los renombres, por subsistema y con *codemod*

Un renombre masivo a mano es imposible (2 284 identificadores, 737 sitios de import, 51 criterios). Se hace **por subsistema, un PR cada uno**, con una herramienta (`scripts/rename-identifiers.ts` sobre `ts-morph`) que lee un mapa `viejo → nuevo`, renombra símbolo y archivo, y **en el mismo commit** actualiza: las regex y rutas de `src/plan/criterios.ts` (y sus anclas de mutantes), las claves de umbral de `vitest.config.ts` y `vitest.integration.config.ts`, las rutas de `manifiesto.json` (con re-sellado **después** de releer el manual afectado, que es la regla de la casa), las citas `archivo:línea` de `docs/cli-command-catalog.md` (regenerado por `catalogo:estado`), y las rutas citadas en `docs/`. La red de seguridad es `npm run typecheck:tests` (tsconfig de pruebas incluye `src`, `tests` y `scripts`) más los cuatro `--check` de la CI y `plan:status --piso --exigir` en un worktree limpio.

El orden sale del acoplamiento medido, de menor a mayor: `tests/` y `scripts/` (bajo riesgo, sin criterios que dependan de sus nombres salvo seis rutas y un prefijo `s3-` en `ci.yml:225`) → `utils`, `types`, `config`, `ar`, `ap`, `policy`, `vault` (ya al 98-100 %: casi nada) → `ai` (48 %) → `api` y `cli/kernel` (`declararRiesgoRuta`, `confirmarConReintento`, `registrarAuditoria`: pocos símbolos, muchos consumidores: un PR por símbolo) → `fx`, `accruals`, `backup`, `fiscal`, `sat`, `banking` (cada uno 87-95 % español) → `payroll` y `accounting` (la costura al 35 %, con `posting.ts`, `validation.ts`, `ar-ap-posting.ts` bajo umbral de cobertura por archivo: **al final**, cuando la herramienta ya haya renombrado nueve subsistemas sin sorpresas) → `plan/criterios.ts` (el instrumento mismo, último de todos, y sólo después de que los criterios tengan identidad estable, §3.7).

### 3.7 El PR cero: identidad estable para los instrumentos

Antes de mover nada, tres cosas que hoy usan **texto en español como identidad** ganan un identificador: los 69 enunciados del piso `docs/criterios-minimos.json` (`status.ts:165` compara `paquete · enunciado`; pasa a comparar `paquete · id`), las 36 claves de `LINEA_BASE` del kernel (`audit.ts:197`, ya inglesas: se documenta que son claves y no prosa), y las 120 anclas de mutantes que citan literales (siguen citando literales, pero el *codemod* las actualiza). Sin este PR, traducir un enunciado o renombrar una función deja al trinquete diciendo «el piso nombra criterios que ya no existen».

## 4. Lo que no cambia

- Los siete invariantes de [`AGENTS.md`](../AGENTS.md). El agente propone; el humano dispone; un catálogo de textos no es una puerta al mayor.
- Los **nombres canónicos de comando** son ingleses y los alias españoles siguen siendo alias (R8 de `docs/cli-command-catalog.md`): lo que cambia es el texto que acompaña al comando, no el comando.
- Las claves de fila del JSON (`account_code`, `debit_total`…) que `--fields` valida y el agente teclea (`output.ts:79-95,208`): son contrato máquina, no texto; `table` puede mostrar una etiqueta traducida **además** de la clave, nunca en su lugar.
- Los valores persistidos del panel, los `CHECK`, los códigos de error publicados y los nombres de migración (regla 4).
- El texto que el modelo o el humano escribió en la sesión (`ai_questions`, memoria, borradores de skill): es dato.

## 5. La secuencia: tramo I0 y lo que cuelga

| Paso | Qué entrega | Criterio ejecutable |
|---|---|---|
| **I0.1** | Las reglas: este documento; `CONTRIBUTING.md:158`, `README.md:345`, `AGENTS.md` con la regla de código en inglés; `docs/PROCESS.md` con la decisión del §6 tomada | los tres archivos citan `docs/idioma.md`; la regla vieja no aparece |
| **I0.2** | `i18n:estado` con sus cifras, bloque en este documento, `--check` en CI y `--piso`; `docs/i18n-linea-base.json` | el bloque está al día; un identificador español nuevo sube la cifra y falla |
| **I0.3** | El lint `english-identifiers` con la línea base congelada | un identificador nuevo en español falla `npm run lint`; quitar uno de la línea base pasa |
| **I0.4** | El PR cero de identidad estable: ids en el piso, `status.ts` compara por id | `plan:status --piso` pasa con un enunciado reescrito |
| **I1** | El catálogo: `src/i18n/`, `t()` en el kernel, resolutor de idioma único, `--lang`, prueba de sincronía; las 45 cadenas del kernel y el cromo de Commander en `es` y `en` | `mnemosine --lang en --help` y `--lang es --help` difieren sólo en el texto; `ux:status` y `cli-reference` miden la fuente y no cambian |
| **I2** | Las 24 familias bilingües del CLI (empezando por `bank`, 246 cadenas) a claves; español primero | la cifra «cadenas de ejecución sin clave» baja a 0 por familia; las 613 aserciones de `tests/cli` pasan a comparar por clave o por `--lang en` |
| **I3** | La API: `messageKey` + `params` en `AccountingError`; `Accept-Language`; `meta.language`; los 24 códigos españoles congelados y documentados; los nuevos en inglés | `openapi.ts --check` pasa; un cliente sin `Accept-Language` recibe español; con `en`, inglés; el `code` es idéntico en ambos |
| **I4** | El panel: preguntas, impacto y etiquetas al catálogo, **español primero**; `policy_decisions` guarda clave y versión, no prosa | las 232 cadenas del panel sin clave bajan a 0; un inquilino nuevo ve las preguntas en su idioma |
| **I5** | Lo persistido: `description_key` + `params` en pólizas, líneas, auditoría y periodos; el `Concepto` del Anexo 24 en español desde la clave | migración; los 11 escritores escriben clave; el XML de una póliza de reversa dice «Reversa de…» y no «Reversal of…» |
| **I6** | Formato por jurisdicción: `Intl` con `formatLocale` del paquete; `full-icu` fijado en CI; `formatMoneyMx` deja de llevar el locale en el nombre | una entidad US imprime `1,234.56 USD` y `01/31/2026` en `table` con `--lang es`; `json` no cambia |
| **I7** | Los renombres por subsistema con el *codemod* (§3.6), un PR por subsistema, `accounting` y `plan` al final | la cifra de identificadores españoles baja a 0; 133/133 criterios verdes y 120/120 mutantes muertos en cada PR |
| **I8** | El agente: `resolveLanguage` lee el resolutor único; las descripciones de herramientas ya son inglesas; el corpus queda como está | `tests/ai/system-prompt.spec.ts` pasa con el resolutor nuevo |
| **I9** | Un tercer idioma como prueba de que el sistema es un sistema: `fr` o `pt` sólo para el kernel, sin tocar `src/` fuera de `src/i18n/` | el archivo nuevo + un renglón en la prueba de sincronía bastan |

**J0 nace en inglés.** `docs/jurisdicciones.md` propuso `jurisdiccionDe`, `PaqueteDeJurisdiccion`, `parametros_legales` y `src/jurisdicciones/`; con esta regla son `jurisdictionOf`, `JurisdictionPackage`, `legal_parameters` y `src/jurisdictions/`. El primer paso de J0 (#123) ya está en curso con los nombres españoles en una rama sin fusionar: es el primer renombre que este documento pide, y el más barato de todos si se hace antes de fusionar.

## 6. Lo que decide el dueño

- **Comentarios existentes**: la regla 1 los pide en inglés para lo nuevo. Los 22 721 renglones que ya existen, ¿se traducen? A favor: coherencia con el pedido. En contra: son ensayos con notas al pie a documentos en español, 46 archivos están sellados por hash en `manifiesto.json` (traducir un comentario obliga a releer el manual), y el valor para un lector es nulo hasta que exista un lector que no lea español. **Omisión propuesta**: no se traducen en masa; el encabezado de cada archivo se traduce cuando el archivo se toca por otra razón (regla del *boy scout*), y `i18n:estado` publica la cifra sin trinquete.
- **Commits y documentación** (`docs/`, wiki, auditorías, mensajes de commit): fuera del pedido. **Omisión propuesta**: siguen en español —es la voz de la casa— y `CONTRIBUTING.md` lo dice con esas palabras, separado de la regla del código.
- **La ayuda del CLI en español por omisión** invierte la política escrita en `src/cli/README.md:387-414` («CLI chrome — always English») y en la R8. **Omisión propuesta**: sí, porque es lo que el pedido dice; los instrumentos miden la fuente inglesa (regla 6) y nada se rompe.
- **El tercer idioma** (I9): cuál, y si se hace ahora o cuando haya un usuario que lo lea.

## Para seguir

- El inventario, con el comando de cada cifra: [`docs/investigacion/2026-09-06-idioma/`](investigacion/2026-09-06-idioma/)
- La jurisdicción como dimensión, que este documento renombra al inglés: [`docs/jurisdicciones.md`](jurisdicciones.md)
- Las issues: el tramo **I0** y los que cuelgan de él llevan la etiqueta `idioma`; el estado se pregunta con `npm run i18n:estado` cuando exista, y hasta entonces nada de este documento cuenta como hecho.
