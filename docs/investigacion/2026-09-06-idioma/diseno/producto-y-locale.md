# Diseño · Producto y locale

Lente: **producto y locale** — la experiencia de la persona que lee (español primero y por omisión, inglés segundo, otros después), y de la autoridad que recibe (el SAT en español, el IRS en inglés), sobre un código que pasa a estar escrito en inglés.

Árbol leído: `/Users/victor/projects/Accounting`, `HEAD b31e62a` (`git rev-parse --short HEAD`), rama `j0-1-la-jurisdiccion-deja-de-ser-un-booleano` (`git branch --show-current`), **sucio**: 14 archivos modificados y 4 rutas sin versionar, entre ellas `src/services/jurisdiccion/` (`git status --short | wc -l` → 18). Ningún archivo del repositorio fue editado. Todo lo que cito de los inventarios lleva su informe; todo lo que conté yo lleva el comando.

Ningún archivo leído contenía instrucciones dirigidas al agente que hubiera que ignorar; los `--actualizar`, `--apretar` y «sella con…» de los scripts se leyeron como dato.

---

## 0. Lo que el inventario deja como punto de partida (resumen operativo)

Las cifras que este diseño usa como base, con la fuente:

| Hecho | Cifra | Fuente (informe o comando) |
|---|---|---|
| La noción de idioma que existe hoy es UNA: la del agente | `resolveLanguage()` en `src/ai/providers/config.ts:1119-1131`: `MNEMOSINE_LANG` > `./mnemosine.config.json` > `~/.mnemosine/config.json` > `'es'`; síncrona y sin base | verificado con `sed -n 1105,1150p src/ai/providers/config.ts` |
| Consumidores de esa noción | `src/ai/system-prompt.ts:171-174` (`LANGUAGE_LINE`), `src/cli/mnemosine.ts:1066,2045`, `src/cli/status-command.ts:253` | inventario formato-y-locale §2 fila 25 |
| `MNEMOSINE_LANG` en `src` / `Intl.` en `src` / `Accept-Language` en `src` | 5 / 0 / 0 | `grep -rn "MNEMOSINE_LANG" src --include='*.ts' \| wc -l`; `grep -rn "Intl\." src --include='*.ts' \| wc -l`; `grep -rniE "accept-language" src --include='*.ts' \| wc -l` |
| `configureHelp` en `src/cli` | 0 archivos | `grep -rc "configureHelp" src/cli --include='*.ts' \| grep -v ':0$' \| wc -l` |
| Familias del CLI inyectadas por una misma costura | 43 llamadas `registerXCommand(program, { palette: c, shutdown, reportError })` en `src/cli/mnemosine.ts:3018-3078` | `grep -nE "register[A-Za-z]+Command\(program" src/cli/mnemosine.ts` |
| Sitios de emisión de ayuda en `src/cli` | 309 `.description(`, 700 `.option(` | `grep -rho "\.description(" src/cli --include='*.ts' \| wc -l`; ídem `\.option(` |
| Sitios de lanzamiento de error en `src/cli` | 350 (`throw new CliError\|usageError\|…\|needsHuman(`) | `grep -rhoE "throw (new CliError\|usageError\|notFound\|validationFailed\|blockedByState\|conflict\|permissionDenied\|externalFailed\|externalRejected\|abortedByUser\|needsHuman)\(" src/cli --include='*.ts' \| wc -l` |
| Prosa del CLI: ayuda / ejecución | 1 397 (6 castellanas) / 1 827 (495 castellanas, 199 mixtas) | inventario cli §2.2, verificado al dígito (verificación cli §1.1) |
| Errores de servicio que llegan al usuario sin pasar por el CLI | 305 sitios `throw new XError('…')` en `src/services`+`src/utils`; 113 `new AccountingError(` | `grep -rhoE "throw new [A-Za-z]+Error\(\s*[\`'\"]" src/services src/utils --include='*.ts' \| wc -l`; `grep -rhoE "new AccountingError\(" src --include='*.ts' \| wc -l` |
| Códigos de error en circulación / castellanos | 72 / 24 | inventario api §3.2, confirmado (verificación api C3, §3.2) |
| Panel de políticas: claves / etiquetas / preguntas | 53 / 131 `label:` / 53; ~450 cadenas de usuario en total, 100 % inglés, persistidas por inquilino con `ON CONFLICT DO NOTHING` y renderizadas desde la fila | `grep -cE "^\s*key: '" src/services/policy/pending-catalog.ts`; `grep -oE "label: '[^']*'" … \| wc -l`; verificación esquema §3.2-3.3 |
| Aserciones de texto en `tests/cli` (incluido `kernel/`) | 1 025 | `grep -rc "toContain(\|toMatch(" tests/cli --include='*.spec.ts' \| awk -F: '{s+=$2} END{print s}'` |
| Aserciones de texto de mensajes en `tests/` | 766 en el commit (983 con `toThrowError`) | verificación api C14 |
| `period_name` menciones / tests con `'January 2026'` / con `'Periodo 3/2026'` | 172 / 34 / 34 | `grep -rn "period_name" src --include='*.ts' \| wc -l`; `grep -rnE "'(January\|…\|December) 20" tests --include='*.ts' \| wc -l`; `grep -rnE "'Periodo [0-9]" tests --include='*.ts' \| wc -l` |
| `period_name` entra en el `GROUP BY` de una vista materializada | `001_core_schema.sql:508,520`, `004_partitioning_and_views.sql:37,53` | `grep -n "period_name" src/database/migrations/001_core_schema.sql src/database/migrations/004_partitioning_and_views.sql` |
| Plurales a mano `palabra(s)` en `src` | 304 | comando del inventario formato-y-locale §2 (reproducido) |
| Formateo con locale cableado | 8 `toLocale*` (7 `en-US`, 1 `es-MX`) | `grep -rn "toLocale" src --include='*.ts' \| wc -l` |
| ICU de Node en esta máquina | Node v22.23.1, ICU 78.2; `es-MX`, `en-US`, `es`, `pt-BR` soportados; `es-MX` y `en-US` agrupan igual (`$1,234,567.50`); plurales `es` = one/other | `node -p "process.versions.icu + …"` (salida: `78.2 ["es-MX","en-US","es","pt-BR"] $1,234,567.50 \| $1,234,567.50 \| 15 de enero de 2026 \| one/other`) |
| Tablas `tenants` (con `settings JSONB`) y `users` existen | `001_core_schema.sql:15-26` y `:28-43`; ninguna columna de idioma en 74 migraciones | `sed -n 10,50p src/database/migrations/001_core_schema.sql`; verificación formato-y-locale fila 31 |
| `tenants.settings` no tiene ningún lector en `src` | 0 | `grep -rnE "settings" src --include='*.ts' \| grep -iE "tenant"` → vacío |
| Siguiente número de migración libre | 070 (`ls src/database/migrations \| tail -1` → `069_…`; 74 archivos; 014 triplicado) | `ls src/database/migrations \| tail -5`; `docs/migraciones.md` («el siguiente número se pregunta al directorio») |
| `AsyncLocalStorage` en `src` | `src/database/connection.ts`, `src/utils/logger.ts`, `src/api/rest/middleware/correlation.ts`, `src/api/rest/middleware/tenant-context.ts` | `grep -rln "AsyncLocalStorage" src --include='*.ts'` |
| Identidad de un criterio del plan | `paquete · enunciado` (`src/plan/status.ts:165`); `--piso` compara por ese texto; `s4a-ataque.int.spec.ts:282-291` busca un criterio por su enunciado castellano | `sed -n 160,200p src/plan/status.ts`; `grep -n "criterioPorEnunciado" tests/integration/s4a-ataque.int.spec.ts` |
| Glosario ES↔EN ya escrito | 47 entradas en `docs/wiki/Glosario.md` | `grep -c '^\*\*' docs/wiki/Glosario.md` |
| Reglas vigentes contrarias al pedido | `CONTRIBUTING.md:158`, `README.md:345-346`, `docs/PROCESS.md:58`, `CONTRIBUTING.md:96`; `AGENTS.md` no dice nada de idioma; `src/cli/mnemosine.ts:2039` («CLI UI stays English»); `src/cli/README.md:396` | leídos |

---

## 1. Principios

1. **Tres ejes, no uno.** *Idioma* (lo que la persona lee), *jurisdicción* (lo que la autoridad exige) y *formato* (cómo se escriben número, moneda y fecha) se resuelven por separado y no se contaminan. El idioma sigue a la persona; la jurisdicción sigue a la entidad (`docs/jurisdicciones.md:135`, `informes: { idioma }` ya lo coloca ahí); el formato sigue a un *locale* BCP 47 que por omisión se deriva de la jurisdicción de la entidad y que el usuario puede cambiar sin cambiar lo que recibe el SAT.
2. **Fuente en inglés; el español es el primer catálogo y la omisión.** El código lleva claves en inglés; el catálogo `en` es la fuente y está completo por construcción; el catálogo `es` es obligatorio al 100 % en el mismo PR (la puerta lo exige); cualquier otro idioma puede nacer parcial y cae a `en`. Sin preferencia declarada, todo —CLI, API, agente— sale en `es`.
3. **Lo que el sistema redacta se guarda como clave + parámetros y se renderiza al leer o al emitir.** Lo que redacta una persona o el modelo se guarda como está, con su idioma anotado. Lo histórico no se reescribe: el mayor posteado es inmutable (`041_el_mayor_inviolable.sql:42-70`), `audit_log` es append-only (`033`), y una fila sin clave se muestra tal cual, como dato.
4. **Los contratos de máquina no se traducen.** Nombres canónicos de comando y banderas (los alias castellanos siguen siendo alias, `src/cli/kernel/vocabulary.ts:1-20`), claves de `--json/--csv/--fields` (`src/cli/kernel/output.ts:208,238`), códigos de error (`code`, 72, los 24 castellanos congelados), valores persistidos (panel, CHECK, `account_roles.role`), fechas ISO en formatos de máquina, tags del SAT y del IRS. Se traduce la *etiqueta*, nunca la *clave*.
5. **El locale sólo viste la rama humana.** `table` y la prosa; jamás `json/ndjson/csv/tsv/md` (contrato en `tests/cli/kernel/presentation.spec.ts:10-14` y `output.ts:193-195`), jamás lo persistido, jamás lo firmado.
6. **Lo que exige la autoridad va en el idioma de la autoridad, con render determinista.** Anexo 24, CFDI, DIOT: `es-MX` siempre; 941, W-2, NACHA: `en-US` siempre — sin depender del ICU del host ni de la preferencia del usuario (la regla que `catalogo-cuentas.ts:273-281` ya aplica al orden, extendida al texto). Un mismo mes produce bytes idénticos con cualquier `--locale`.
7. **El instrumento viaja con el cambio, y tiene identidad estable antes de que se traduzca su prosa.** Cada tramo lleva su criterio en `src/plan/criterios.ts` y sus anclas en el mismo PR; y antes de tocar un solo enunciado, un `id` por criterio, porque hoy el piso (`docs/criterios-minimos.json`) y `s4a-ataque.int.spec.ts:283` casan por texto castellano.
8. **El agente propone y nunca dispone.** Un modelo puede *redactar* una traducción como borrador; no escribe catálogos ni cambia la preferencia de nadie. La preferencia de idioma se fija por bandera, entorno, archivo de configuración o cabecera HTTP: siempre por una persona o su script.

---

## 2. Arquitectura

### 2.1 El modelo: un locale, tres derivadas

```
locale (BCP 47)  ──► idioma  = subetiqueta de lengua      → catálogos de mensajes (es, en, …)
                 ──► región  = subetiqueta de región       → Intl.NumberFormat / DateTimeFormat / PluralRules
jurisdicción de la entidad (docs/jurisdicciones.md §3.1) ──► idioma y formato de lo ESTATUTARIO (fijos por autoridad)
```

- Valores admitidos en el primer tramo: `es-MX` (omisión), `en-US`, y las formas cortas `es`, `en` que se **canonizan** a `es-MX`/`en-US`. Razón medida: `es` a secas en ICU agrupa `1.234.567,891` (verificación formato-y-locale fila 43), y dos regex de la casa sólo entienden miles con coma (`src/cli/kernel/output.ts:186`, `src/ai/compaction.ts:249`): un `es-ES` accidental rompería la alineación de tablas y la compactación del agente. Otros idiomas entran cuando existe su catálogo y su prueba de formato.
- `es-MX` y `en-US` comparten separadores (`$1,234,567.50` en ambos, verificado con `Intl.NumberFormat`), así que cambiar de idioma **no cambia los bytes de las cifras** en tabla: lo que cambia es texto, nombres de mes, símbolo/código de moneda y plurales. Eso acota el radio de las 1 025 aserciones.

### 2.2 Dónde vive la preferencia y cómo se resuelve

Un solo resolutor, `src/i18n/locale.ts` → `resolveLocale(): Locale`, **síncrono y sin base** para el CLI (como `resolveLanguage` hoy, que `NO_DB_COMMANDS` protege en `mnemosine.ts:832`), con una segunda entrada `resolveLocaleFor(req)` para HTTP.

Precedencia, de lo particular a lo general (la misma forma que ya rige para la entidad en `src/cli/kernel/entity-context.ts:14-19`):

| Nivel | CLI | REST / GraphQL | Agente |
|---|---|---|---|
| 1. Explícito por invocación | `--locale <tag>` global (entra a `FLAG_DICTIONARY`, `src/cli/kernel/flags.ts:34`; sin forma corta) | cabecera `Accept-Language` (Express 4.22 ya trae `req.acceptsLanguages()`) y, para forzar, `X-Locale` en la tradición de `x-entity-id` | hereda del CLI o de la petición |
| 2. Entorno | `MNEMOSINE_LOCALE`; `MNEMOSINE_LANG` se conserva como alias (5 líneas en `src`, 6 en tests, `.env.example:352`) | — | ídem |
| 3. Persona | `~/.mnemosine/config.json` `locale` (config de USUARIO; `config.ts:16,611`) | `users.locale` (columna nueva, migración ≥070, **si el dueño la quiere**; §4.2) | ídem |
| 4. Proyecto | `./mnemosine.config.json` `locale` (hoy `language`, `mnemosine.config.json:16`; se acepta como alias) | — | ídem |
| 5. Inquilino | `tenants.settings.locale` (JSONB ya existe, `001:23`; 0 lectores hoy: no hace falta migración) | ídem | ídem |
| 6. Entidad | `jurisdiccionDe(e)` → MX `es-MX`, US `en-US` (`docs/jurisdicciones.md` §3.1; hoy `esContabilidadMexicana` en `pais-contable.ts:35-44`) — **sólo para el formato**, no para el idioma de la persona | ídem | ídem |
| 7. Sistema | `es-MX` | `es-MX` | `es-MX` |

Dos decisiones deliberadas:

- **El idioma de la persona no lo decide la entidad.** Una contadora de CDMX que lleva una LLC de Delaware lee en español y entrega al IRS en inglés. Por eso el nivel 6 sólo aporta *formato por omisión* (y ni eso si hay un nivel superior); el idioma estatutario lo fija §2.6.
- **`lang` se extiende, no se duplica.** `lang` ya ocupa una palabra del vocabulario cerrado (`vocabulary.ts:136`) y ya tiene riesgo declarado (`riesgos-retrofit.ts:87`); pasa a leer/escribir `locale` y a aceptar `es`, `en`, `es-MX`, `en-US`. Ningún verbo nuevo.

El texto de `.env.example:350` («Omisión: la del sistema») hoy miente (`config.ts:1131` devuelve `'es'` fijo): se corrige para decir `es-MX`, o se implementa leer `LANG`/`LC_ALL` como nivel 2b. Recomendación: **no** leer `LANG` del sistema —un servidor en `C.UTF-8` produciría inglés a un despacho mexicano—; corregir el texto.

### 2.3 Qué sigue al idioma y qué sigue a la jurisdicción

| Sigue al **idioma** (locale de la persona) | Sigue a la **jurisdicción/moneda** de la entidad (fijo) |
|---|---|
| Ayuda del CLI (descripciones, opciones, argumentos, `Examples:`), cromo de Commander | `Concepto`/`DesCta` del Anexo 24 (`polizas-service.ts:949-951,980`; `catalogo-cuentas.ts:290,381,418`): `es-MX` |
| Mensajes de ejecución, errores (`CliError` y `AppError`), prompts `[y/N]`, `noEntendi` | CFDI de nómina (`cfdi-nomina-generator.ts:108,134,154`), DIOT (lote y papel de trabajo), SUA: `es-MX` |
| Etiquetas de columna en `table`/`md` (`render({labels})`), rótulos de fichas `fact/linea/renglon/field` (≈95, verificación cli §2.1) | Formas 940/941, W-2/W-3, NACHA, IDSE: `en-US` (o el formato numérico que el protocolo dicta, p. ej. `imss-idse-adapter.ts:104`) |
| Textos del panel: `question`, `impact`, `options[].label`, `defaultRationale`, `whyAsking`, `whatIDo`, `ifSkipped` (~450) | **Nombres de cuenta sembrados** (41+24+15+38): se renderizan en el idioma del paquete de jurisdicción **al sembrar** y desde entonces son dato del cliente (`docs/jurisdicciones.md` §3.2 `informes.idioma`) |
| Rótulos de informes en pantalla (`Assets`, `Liabilities`… 6 literales, `report-service.ts:964-1085`) cuando el informe es de gestión | Rótulos **estatutarios** (balanza de 4 columnas para el SAT, estado de resultados que se entrega): idioma del paquete |
| Nombres y `detail` del `doctor` (53 `name:` en HEAD), textos del `status`, banner | `period_name` que se **entrega** en un artefacto fiscal |
| Respuestas del agente (`LANGUAGE_LINE`), prefijo de grounding, resumen de compactación | El corpus normativo que el agente lee: en el idioma de la norma (NIF en español, IFRS/ASC en inglés) — no se traduce |
| Formato de número/moneda/fecha **en tabla y prosa**: agrupación, decimales de presentación, nombre de mes, símbolo o código de moneda (`formatMoneyMx` → `formatMoney(value, {locale, currency})`) | Formato de número/fecha en **archivos a terceros**: el del protocolo (`formatearImporte` del Anexo 24, `balanza-invariantes.ts:106`; `to_char … YYYY-MM-DD` en SQL) |
| Nada de lo persistido | Nada de lo persistido |

Zona horaria: **fuera de este diseño**. Hoy es la del proceso Node (`output.ts:97-107`, `treasury-posting.ts:583`) y hay 18 `CURRENT_DATE` del lado Postgres (verificación formato-y-locale H4); es un atributo de entidad, no de locale, y se decide en la serie J (§4.12).

### 2.4 El catálogo: formato, claves, plurales, género

- **Ubicación**: `src/i18n/<lang>/<namespace>.json` (`en/` es la fuente; `es/` obligatoria; `es-MX/` sólo si un día hace falta una variante regional, y cae a `es`). Cadena de fallback: `es-MX → es → en`; nunca se imprime una clave desnuda en producción — se imprime el `en` y el metro (§2.9) lo cuenta.
- **Formato de mensaje**: **ICU MessageFormat** (`{n, plural, one {# fila} other {# filas}}`, `{amount, number, ::currency/MXN}`, `{date, date, long}`, `{gender, select, …}`). Es el estándar que `Intl.PluralRules`/`NumberFormat`/`DateTimeFormat` ya implementan en Node ≥ 20 con full-icu (`engines.node >= 20`, `package.json:85`); mata de raíz los 304 plurales `palabra(s)` y los 18-22 ternarios. Implementación: `intl-messageformat` (pinado) **o** un formateador propio mínimo (plural, select, number, date) sobre `Intl` — decisión del dueño (§4.5); el contrato `t(key, params)` es el mismo en ambos casos.
- **Claves**: jerárquicas, en inglés, con el espacio de nombres igual a la superficie que las emite y al archivo donde viven, para que `criterios.ts` pueda hacer grep por prefijo:
  - `cli.kernel.no_rows`, `cli.kernel.showing_of` (las ~45 del kernel), `cli.bank.import.truncated`, `cli.help.<command path>.description` / `.option.<flag>` / `.argument.<name>` / `.examples`;
  - `error.<CODE>` — **el código de error es la clave**: 72 códigos ↔ 72 mensajes, un solo texto por código y por idioma (hoy `PERIOD_ALREADY_OPEN` tiene dos textos en dos idiomas en el mismo archivo, `fiscal-calendar-service.ts:246/376`);
  - `policy.<key>.question|impact|rationale|why|what|if_skipped`, `policy.<key>.option.<value>` (la clave del panel ES el valor persistido, en castellano; se conserva);
  - `ledger.reversal_of`, `ledger.voided`, `closing.year_end`, `treasury.bank_fee`, `payroll.gross_wages`… (las ~120 plantillas de póliza) y `audit.reason.<motivo>`;
  - `report.section.assets|liabilities|equity|result|revenue|expenses`, `report.column.account_code|debit_total|…` (etiquetas, no claves JSON);
  - `doctor.check.<id>.name|detail`, `agent.language_line`, `agent.grounding.prefix`.
- **Género**: se evita en la redacción («se listaron 3 filas», no «3 fila(s) listada(s)»); donde no se pueda, `select` de ICU con parámetro explícito. No se infiere género de nombres propios.
- **Interpolación de datos**: los datos (folios, RFC, nombres de cuenta, cifras) van como parámetros; el catálogo nunca contiene un dato. Las invocaciones incrustadas (`→ mnemosine doctor`, 274 cadenas) van como parámetro `{command}` para que nunca se traduzcan.
- **Lo que NO entra al catálogo**: `LINEA_BASE` de `audit.ts:197-236` (36 claves con `detail` inglés: son identidad de una violación para el desarrollador, no texto de usuario); `enunciado` de criterios y `LINEAS_BASE` de `ux-status` (interfaz del desarrollador; se decide en §4.9); `x-escribe` y `x-riesgo` del OpenAPI (contrato publicado, §4.13); las 25 herramientas del agente y sus 49 `.describe()` (van al modelo, en inglés).

### 2.5 Las costuras por superficie

**CLI (`src/cli/kernel/`).**
1. `program.configureHelp({ subcommandDescription, optionDescription, argumentDescription, commandDescription })` (Commander 15, `typings/index.d.ts:235-248`) traduce **en el momento de renderizar la ayuda**, usando la descripción inglesa como clave de búsqueda (`cli.help.*`). La fuente sigue siendo la cadena inglesa de `.description()`, así que `scripts/ux-status.ts` y `scripts/generate-cli-reference.ts` siguen midiendo y reproduciendo la fuente; y como el render ocurre en `parseAsync`, **`--locale` llega a tiempo para la ayuda**, cosa que un cambio en el momento de registro no lograría (inventario cli §3.2.1).
2. Cromo de Commander: `helpOption(flags, desc)`, `helpCommand(name, desc)`, `.version(str, flags, desc)`, `configureOutput({ outputError })` y `showSuggestionAfterError` — «Usage:», «Options:», «Did you mean», «unknown command» pasan por el catálogo. Dos pruebas afirman ese cromo hoy (`tests/cli/raiz-y-remedios.spec.ts:138`, `tests/cli/bilingual-matrix.spec.ts:306`): se reexpresan sobre el render `en`.
3. `render(rows, { labels })`: `RenderOptions` (`output.ts:37-55`) gana `labels?: Record<string,string>` que **sólo** usan `toTable` (`:191`) y `toMarkdown` (`:225`); `json/ndjson/csv/tsv` y `--fields` siguen con las claves. Brecha 5 de `ux-idioma.md:327-369`.
4. `CliError` (`exit.ts:56-67`) gana `key?: string` y `params?`; `message` se sigue rellenando (en inglés, para las pruebas y el `--json`); `reportError` (`mnemosine.ts:291-317`) renderiza `t(key, params)` si hay clave y `message` si no. `detail`, que nadie lee, es el sitio natural del sobre JSON de error.
5. El traductor entra por la costura que ya existe: `registerXCommand(program, { palette: c, shutdown, reportError, t })` (43 sitios, `mnemosine.ts:3018-3078`). Ninguna hoja importa nada global.
6. `confirmarConReintento` (`confirmacion.ts:79-91`) pasa a poner el sufijo del prompt (`[y/N]`/`[s/N]`) — hoy repetido en 16 archivos (verificación cli fila 32) — y sigue aceptando `y/yes/s/si/sí` en cualquier idioma (`:35`).
7. `formatMoneyMx` (`output.ts:162`) se conserva como alias de `formatMoney(value, { locale })` un tramo (API del kernel, `index.ts:36`, 7 llamadas); la agrupación de `es-MX` y `en-US` es idéntica, así que su salida no cambia; lo que cambia es que `money()` de `policy-preview.ts:26-27` (`$1,234 MXN`, dólar puesto a mano delante de pesos) y los 7 `$${…}` a mano desaparecen.

**API.**
1. Middleware `negotiateLocale` justo después de `correlationIdMiddleware` (`src/index.ts:129`) y **antes** de `authenticate` (`:201`), para que 401/403/429 ya salgan localizados; guarda el locale en el mismo `AsyncLocalStorage` que `withTenant` (`tenant-context.ts:48-52`) para que **cualquier servicio** lo vea sin cambiar firmas — importa porque los mensajes nacen en `src/services`, no en la API. GraphQL: mismo middleware en la cadena de `/graphql` (`index.ts:273-309`) y el locale en el contexto, como `entidadDeCabecera`.
2. `AppError` (`utils/errors.ts:1-12`) gana `key`/`params` sin quitar `message`; `errorHandler` (`error-handler.ts:12-27`) y `formatearError` (`graphql/errores.ts:23-43`) renderizan `message` desde `error.<code>` con el locale del ALS. `code`, `field`, `details` no cambian. Respuesta: `Content-Language`, `Vary: Accept-Language` y `meta.locale` (aditivo; el sobre ya tiene `meta`).
3. Las tres salidas que esquivan el sobre (`ai-webhooks.ts:82,124,131` con `{ error }`), `/ready` con el mensaje crudo de `pg` (`index.ts:150-154`) y el 404 HTML de Express se traen al sobre en el mismo tramo (verificación api H1).
4. Zod: `z.setErrorMap` por locale en `validateBody/validateQuery` (`async-handler.ts:64-90`); lo nativo de Apollo queda en inglés y **se dice en el contrato**.
5. Los 24 códigos castellanos **se congelan** (son contrato; `criterios.ts:1470,1476,3312,3339,4779,1995` los anclan; `entry-command.ts:130-139`, `bill-command.ts:1215-1500`, `ingest-service.ts:206`, `rep-pendientes.ts:150`, `pac-router.ts:194` los comparan). Los nuevos nacen en inglés. Si algún día se unifica, alias con `details.legacy_code` y ventana de retiro; nunca un renombre seco.

**Agente.**
1. `LANGUAGE_LINE` (`system-prompt.ts:171-174`) pasa a derivarse del locale: `Always respond in ${Intl.DisplayNames(['en'],{type:'language'}).of(lang)}` — cualquier idioma con catálogo, no dos. `tests/ai/system-prompt.spec.ts:147-161` sigue verde porque la omisión sigue siendo español.
2. `grounding.ts:49` (`"(sin datos del sistema)"` fijo en español; nadie lo parsea: `grep -rn "sin datos del sistema" src tests` → 1 línea) pasa a un marcador neutro o al idioma de respuesta; `compaction.ts:321-327` gana «Write the summary in {language}»: hoy el resumen sale en el idioma que elija el modelo.
3. El corpus no se traduce: manuales de sistema en inglés (14, 9 134 líneas), normativa en el idioma de la norma (14, 2 405 líneas); `docs/jurisdicciones.md` §3.8 ya reparte el corpus por jurisdicción. El agente lee en lo que sea y responde en el locale del usuario. `docs/wiki/Glosario.md` (47 entradas) entra al prompt como mapeo ES↔EN (brecha 14 de `ux-idioma.md`).
4. Lo que el modelo y las personas escriben (`ai_messages`, `ai_questions`, `ai_drafts.payload`, `resolution_notes`, `notas`) gana una columna `lang` (migración ≥070) con el locale vigente al escribir. No se traduce; se sabe qué es. El FTS de `029` sigue `simple`, ahora con motivo documentado.

### 2.6 Lo persistido: clave + parámetros en la fila, render al leer

| Columna | Hoy | Diseño |
|---|---|---|
| `journal_entries.description`, `journal_entry_lines.description` | ~120 plantillas del sistema, 5 es + 1 mixta, el resto en (inventario textos §2.1) | Migración ≥070: `description_key VARCHAR(80)`, `description_params JSONB` en ambas tablas, escritas **al crear**. `description` se sigue escribiendo (render en el idioma del paquete de la entidad) para lectores viejos y para el Anexo 24. `ledger_posteado_inmutable` (`041:45-48`) **no se toca**: las columnas nuevas nacen con la fila; ningún posteado se rellena (NIF B-1, rastro). `period-close.ts:1320-1328` (mixto) desaparece al separar clave y motivo humano. |
| Anexo 24 `Concepto`/`DesCta` | copia `description`/`name` tal cual (`polizas-service.ts:949-951,980`); artefactos persistidos con SHA-256 y `UNIQUE (…, hash_sha256)` (`062:58,80`; `artefactos.ts:60,83`) | Al emitir, `Concepto` se renderiza **siempre en `es-MX`** desde `(key, params)` cuando existe y desde `description` cuando no. Artefactos ya guardados quedan como dato; un mes re-emitido con render distinto produce un artefacto nuevo (otro hash), que es el comportamiento que la tabla ya modela. Prueba: dos emisiones con `--locale es` y `--locale en` dan bytes idénticos. |
| `fiscal_periods.period_name` | `en-US` persistido (`fiscal-calendar-service.ts:534`), `seed.ts:54`, y `Periodo 3/2026` en `conducta.ts:194`; búsqueda por `ILIKE` (`:141-151`); entra en `mv_trial_balance` | El nombre **se muestra** derivado de `(period_number, year_number, locale)` con `Intl.DateTimeFormat(locale, { month: 'long' })`; la columna **se conserva** (vista materializada, `GROUP BY`) y se sigue acuñando en `en-US` como identificador estable; la búsqueda `--period` acepta `YYYY-MM` (ya existe, `:125-134`) y nombres de mes en `es` y `en`. Decidir si se deja de persistir es §4.8. |
| `audit_log.reason` | 16 literales del sistema, 8 en castellano (inventario textos §2.7) | `reason_key` + `reason_params` (migración ≥070; append-only, lo viejo queda). Los `--reason` del usuario siguen libres, con `lang`. |
| `ai_drafts.review_notes` `LIKE 'auto-post by threshold%'` | discriminador por texto (`stats-service.ts:97-102`, `shadow-verdicts.ts:57,61`, `criterios.ts:3198,3416`; 11 líneas en `src`) | columna `review_kind`; el `LIKE` queda como compatibilidad para filas viejas; `criterios.ts` se actualiza en el mismo PR. `ai_shadow_verdicts.motivo` → `motivo_key`. |
| `paycheck_taxes.calculation_notes` | 21 plantillas en dos idiomas mezclados en la misma fila (verificación textos §3.1) | `notes_key` + `params`; sin lector fuera del escritor, así que el cambio es barato. |
| `policy_decisions.question/impact/options/default_rationale` | copia congelada por inquilino, `ON CONFLICT DO NOTHING` (`policy-service.ts:47-58`); tres lectores renderizan desde la fila (`policy-service.ts:148`, `pending-command.ts:223-234`, `policy-tools.ts:212`) | Los tres lectores pasan a renderizar **por `key` desde el catálogo**; las columnas quedan como instantánea auditable de lo que se preguntó. Así **no hace falta migración de datos bajo RLS** (verificación esquema §3.2 la exigía si se seguía leyendo la fila). `criterios.ts:6312-6326` ya obliga a leer del catálogo. |
| Nombres de cuenta sembrados | 4 semillas, castellano incluso para US (`chart-seed.ts:123-127`) | `{ code, nameKey }` renderizado **al sembrar** en `JURISDICCIONES[j.fiscal].informes.idioma`; el catálogo es dato del cliente y no se re-renderiza; `053:91` (resuelve por nombre en una migración aplicada) obliga a que el render MX de esas dos claves sea byte a byte el nombre de hoy — lo fija una prueba de no-regresión. |
| Texto del usuario y del modelo | sin marca de idioma | columna `lang` (§2.5 agente). |

### 2.7 Qué se renombra y qué no (esta lente sólo lo que toca la experiencia)

- **Se renombra**: `resolveLanguage` → `resolveLocale` (con envoltura), `formatMoneyMx` → `formatMoney` (con alias un tramo), `AgentLanguage` → `Locale`. Todo con alias y criterio que exige cero consumidores del nombre viejo antes de retirarlo.
- **No se renombra**: comandos y banderas (`LINEA_BASE`, catálogo, `FOTO_ORIGINAL`, `TOP_LEVEL` casan por nombre), `lang`/`idioma`, `MNEMOSINE_LANG` (alias), códigos de error, claves y valores del panel, `account_roles.role` (36 valores, 26 lectores; verificación esquema §3.1), valores de CHECK (`--type cheque-en-circulacion` es contrato de CLI, R9 del catálogo), migraciones (36 castellanas, 4 números duplicados, 014 triple), tags SAT/IRS, las 11 claves `x-*` del OpenAPI (contrato publicado).
- **Identificadores y nombres de archivo en general**: otra lente; aquí sólo se pide que `src/i18n/` nazca en inglés y que ningún tramo de esta serie renombre `criterio-cierre.ts`, `posting.ts` ni ninguna de las 6+9 claves de umbral por archivo (`vitest.config.ts`, `vitest.integration.config.ts`, `criterios.ts:575-604`, `s4a-ataque.int.spec.ts:19,290-347`).

### 2.8 Proceso de traducción

- **Quién traduce**: quien escribe la clave escribe `en` y `es` en el mismo PR; el revisor de otro vendor (`docs/PROCESS.md` §4) revisa el `es` como parte del diff. Un PR con una clave sin `es` no es fusionable: lo dice la puerta, no una persona. Otros idiomas: PR aparte, parcial, con fallback a `en` y su propio número en el metro.
- **El modelo como ayudante**: `mnemosine i18n draft --to pt-BR` (verbo `draft` ya existe en el vocabulario) puede **proponer** un catálogo a partir de `en`; lo escribe como borrador fuera de `src/` y una persona lo revisa y lo mueve. Nunca escribe en `src/i18n/`.
- **Cómo se detecta una clave sin traducir**: `scripts/i18n-check.ts` (`npm run i18n:check`, paso de CI junto a `ux-status`), con el AST de TypeScript que los extractores de esta investigación ya usan (`/tmp/investigacion-idioma/inventario/cli-extraer-cadenas-cli.cjs`, `api-extraer-cadenas.mjs`, promovibles a `scripts/`): (a) claves usadas en `t('…')`, `key:` de `CliError`/`AppError`, `labels`, `configureHelp` ↔ claves declaradas en `en`; (b) `es` ⊇ `en` (fallo duro); (c) claves declaradas sin uso (aviso; trinquete como `hojas-sin-ejemplo`); (d) parámetros ICU de cada mensaje iguales en todos los idiomas (un `{n}` que falta en `es` es un mensaje que miente); (e) pseudo-locale `qps-ploc` (`[Šhöwïñg # öf # röwš]`) para ver a ojo qué no pasó por el catálogo.
- **Fallback**: `es-MX → es → en`; `en` nunca falla porque es la fuente. Jamás `en → es`: la fuente no cae a una traducción.
- **Glosario**: `docs/wiki/Glosario.md` es la referencia de términos (póliza ↔ journal entry, auxiliar ↔ subledger…); una prueba comprueba que los términos del glosario que aparecen en `es/*.json` se usan con la grafía del glosario.

### 2.9 Cómo se mide el avance (el metro)

Un `scripts/i18n-status.ts --check --json` con la forma de `ux-status.ts` (`LINEAS_BASE` que **sólo encogen**, `scripts/ux-status.ts:210-217`) y un criterio en `criterios.ts` que lo lee como números (la lección de `contraSuelo`, `criterios.ts:436-470`):

| Medida | Hoy (línea base inicial) | Meta |
|---|---|---|
| `cli-ayuda-fuera-de-catalogo` | 1 397 (inventario cli §2.2) | 0 |
| `cli-ejecucion-fuera-de-catalogo` | 1 827 + ≈95 etiquetas de fichas | 0 |
| `servicios-errores-sin-clave` | 305 (`throw new XError('…')`) | 0 |
| `api-cadenas-fuera-de-catalogo` | 117 (verificación api C7) | 0 |
| `panel-cadenas-fuera-de-catalogo` | ~450 | 0 |
| `plantillas-persistidas-sin-clave` | ~120 pólizas + 16 `reason` + 21 nómina | 0 |
| `claves-sin-es` | — | **0 siempre** (fallo duro, no trinquete) |
| `nodos-fuera-del-idioma-canonico` (ux-status) | 7, medido sobre el render **`en`** | 7 → 0 |
| `toLocaleString-cableados`, `plurales-a-mano` | 8, 304 | 0, 0 |

Cada tramo de §3 mueve una o dos filas de esta tabla y sube la línea base en el mismo commit.

---

## 3. Tramos

Todos respetan: migraciones append-only con el siguiente número **preguntado al directorio** (hoy 070, `docs/migraciones.md`), ningún renombre de claves de umbral, codemod e instrumento en el mismo PR, verificación en un worktree limpio del commit (`AGENTS.md` «Verificación, no afirmación»). Tamaños: S (una tarde), M (2-3 días), L (una semana, un PR), XL (varios PR).

| Código | Título | Entrega | Criterio ejecutable (para `criterios.ts` o el metro) | Depende de | Tamaño |
|---|---|---|---|---|---|
| **L0** | Identidad estable del instrumento | Cada `Criterio` gana `id` estable; `identidadDe` (`status.ts:165`) y `docs/criterios-minimos.json` comparan por `id`; `s4a-ataque.int.spec.ts:283` busca por `id`; `LINEAS_BASE`/`CLAVES` de `ux-status` documentados como claves no traducibles | Lectura: todo elemento de `CRITERIOS` tiene `id` único (regex sobre `criterios.ts` + `Set`); mutante: duplicar un `id` → rojo. Conducta: `plan:status --piso` con un enunciado reescrito y el mismo `id` sigue verde | — | M |
| **L1** | El resolutor de locale | `src/i18n/locale.ts` con `resolveLocale()` (precedencia §2.2), `--locale` en `FLAG_DICTIONARY` y en la raíz, `MNEMOSINE_LOCALE` (+`MNEMOSINE_LANG` alias), `lang` extendido, `.env.example:350` corregido, `tenants.settings.locale` con lector, middleware `negotiateLocale` + ALS + `Content-Language` + `meta.locale` | Lectura: `MNEMOSINE_LANG\|MNEMOSINE_LOCALE` aparece en exactamente 1 archivo de `src` (`i18n/locale.ts`); mutante: leerla en otro archivo → rojo. Conducta: `--locale en-US` > `MNEMOSINE_LOCALE=es` > config; sin nada → `es-MX`; REST sin cabecera responde `Content-Language: es-MX`, con `Accept-Language: en` responde `en-US` | L0 | M |
| **L2** | Catálogo y formateador | `src/i18n/` con `t()`, catálogos `en`/`es`, ICU MessageFormat, `formatMoney/formatDate/formatNumber` sobre `Intl` restringidos a tabla/prosa, `scripts/i18n-check.ts` + paso de CI + pseudo-locale, `scripts/i18n-status.ts` con líneas base iniciales | Lectura: toda clave usada existe en `en` y en `es` y sus parámetros ICU coinciden (el propio `i18n-check` corrido por `crudoDe`); mutante: borrar una clave de `es/cli.json` → rojo. Conducta: `t('cli.kernel.showing_of', {shown:3,total:10})` en `es-MX`/`en-US` da dos textos con las mismas cifras; `--format json` idéntico en ambos locales | L1 | M |
| **L3** | Las reglas escritas | `CONTRIBUTING.md:158`, `README.md:345-346`, `src/cli/README.md:396-414`, `config.ts:1117-1118`, `mnemosine.ts:2039` reescritos con la frontera código/superficie; `AGENTS.md` gana la línea de idioma (hoy no tiene ninguna: `grep -ci 'idioma\|español\|english' AGENTS.md` → 0); `docs/PROCESS.md:58` según §4.9; `MANIFIESTO.md:4` corregido | Lectura: `AGENTS.md` y `CONTRIBUTING.md` contienen la frase de frontera y nombran `src/i18n/` (grep); mutante: quitarla de `AGENTS.md` → rojo | L2 | S |
| **L4** | Kernel del CLI | Las ~45 cadenas propias del kernel a catálogo; `render({labels})`; `CliError{key,params}` y `reportError` renderizando; `configureHelp` + cromo de Commander; `confirmarConReintento` dueño del sufijo `[y/N]`; `t` en las 43 `registerXCommand`; `ux-status` y `generate-cli-reference` fijan locale `en` (como fijan `ANCHO_CANONICO`); `bilingual-matrix:310-323`, `raiz-y-remedios:138`, `bilingual-matrix:306` reexpresados sobre `en` | Lectura: `configureHelp(` existe en `mnemosine.ts` y `generate-cli-reference.ts` fija `locale: 'en'`; mutante: quitar la fijación → rojo. Conducta: `mnemosine --locale es-MX --help` no contiene `Usage:` ni `Options:` y sí «Uso:»; con `en-US` al revés; `mnemosine --locale es-MX report trial-balance --format json` es byte a byte igual que con `en-US`; `ux-status --check` sigue con `nodos-fuera-del-idioma-canonico ≤ 7` | L2 | L |
| **L5** | Hojas del CLI, por familia | Un PR por familia, empezando por las 24 que enseñan en inglés y contestan en castellano (`bank` 246, `prepaid` 49, `batch` 43, `e-accounting` 39, `bill` 31, `account` 30, `diot` 28, `depreciation` 26, `backup` 23…), luego el resto; etiquetas de fichas; 1 025 aserciones de `tests/cli` pasan a clave o a render `en`; resello de `entry-command.ts`/`bank-command.ts` en el manifiesto (2 manuales); anclas de mutante en hojas (`criterios.ts:6234`, `:6307` y las `registerXCommand`) reancladas | Metro: `cli-ayuda-fuera-de-catalogo` y `cli-ejecucion-fuera-de-catalogo` por familia bajan a 0 y la línea base sólo encoge; lectura: ninguna hoja hace `console.log('<prosa con espacio>')` fuera del kernel (regex sobre `fuentes('src/cli')`) | L4 | XL |
| **L6** | Errores de dominio y API | `AppError{key,params}`; 113 `AccountingError` + 305 `throw` con clave `error.<CODE>`; códigos congelados; `errorHandler`/`formatearError` por ALS; Zod `errorMap`; las 3 salidas fuera del sobre y el 404 traídos al sobre; 766 aserciones a `code`; resello de los 7 servicios emisores hasheados | Lectura: todo `new AccountingError('X',` tiene `error.X` en `en` y `es` (regex + catálogo); mutante: quitar `error.PERIOD_ALREADY_OPEN` de `es` → rojo; `PERIOD_ALREADY_OPEN` tiene un solo texto por locale. Conducta: `POST` que cierra un periodo ya abierto responde 422 con `message` en español sin cabecera y en inglés con `Accept-Language: en`, mismo `code` | L2 | L |
| **L7** | El panel de políticas | ~450 cadenas a `policy.<key>.*`; tres lectores renderizan por `key`; columnas de la fila como instantánea; `criterios.ts:2723-2738` (grep de prosa) y `:6312-6326` reescritos; `whyAsking/whatIDo/ifSkipped` idem | Lectura: `pending-command.ts` y `policy-tools.ts` no leen `row.question\|impact\|options\|default_rationale` (grep = 0) y cada una de las 53 `key` tiene sus 6 claves en `es`/`en`; mutante: un `p.question` leído de la fila → rojo. Conducta: `mnemosine pending` en `es-MX` muestra la pregunta en español a un inquilino sembrado antes del cambio (sin migración de datos) | L2 | L |
| **L8** | Informes, doctor y agente | 6 rótulos de informe por `id` + catálogo; `doctor` con `id` estable + rótulo; `LANGUAGE_LINE` derivada del locale; `grounding.ts:49` y `compaction.ts:321-327`; Glosario al prompt; migración ≥070 `lang` en `ai_messages`, `ai_questions`, `ai_drafts` | Lectura: `report-service.ts` no contiene `'Assets'\|'Liabilities'\|'Result Of The Period'` como literal de salida; tests buscan por `id`. Conducta: sin `MNEMOSINE_LOCALE` el prompt lleva «Always respond in Spanish» (la prueba de hoy); con `--locale en-US`, «…in English»; `ai_messages.lang` se rellena en cada escritura | L2, L4 | M |
| **L9** | Lo que el sistema persiste | Migración ≥070: `description_key/params` en pólizas y líneas, `reason_key/params` en `audit_log`, `review_kind`, `motivo_key`, `notes_key`; escritores rellenan clave al crear; `period_name` derivado al mostrar y búsqueda bilingüe; Anexo 24 `Concepto` en `es-MX` desde clave; papel de trabajo de la DIOT por catálogo; históricos intactos; `041` sin tocar | Conducta (integración): reversar un asiento escribe `description_key='ledger.reversal_of'` y `entry list` lo muestra «Reversión de JE-…» en `es-MX` y «Reversal of JE-…» en `en-US`; `catalog file` del mismo mes con `--locale es` y `--locale en` produce XML byte a byte idéntico y un solo artefacto; un asiento posteado antes del cambio se muestra con su `description` original. Mutante en disco: escribir `description` con locale del usuario → rojo | L6, L8 | XL |
| **L10** | Semillas y jurisdicción | `{code, nameKey}` en `chart-seed`, `account-roles-seed`, `payroll-account-mapping-seed`, `seed.ts`; render al sembrar por `JURISDICCIONES[j].informes.idioma`; E1.1 (`criterios.ts:2058-2073`) reescrito para leer `nameKey`; 3 mutantes reanclados (`:1974-1975`, `:2021-2022`, `:2029-2030`); prueba de no-regresión del catálogo MX y de los dos nombres que `053:91` resuelve | Conducta: una entidad MX nueva siembra exactamente los nombres de hoy (instantánea de 41+24+6 nombres); una entidad US siembra el estrato neutro/US en inglés; E1.1 sigue evaluable (no `noEvaluable`) | L2, J0.1 y J0.5 de `docs/jurisdicciones.md` (hoy en un árbol **sin comprometer**) | L |

Orden recomendado: L0 → L1 → L2 → L3 → (L4 → L5) ∥ (L6) ∥ (L7) → L8 → L9 → L10. L3 va temprano a propósito: mientras `AGENTS.md` no diga nada, cada agente que abra el repositorio seguirá escribiendo texto de usuario en línea y en español (verificación comentarios §1.5: la línea base nació en español sin regla escrita).

---

## 4. Decisiones que se le preguntan al dueño

1. **¿Un solo ajuste `locale` para la UI y el agente, o dos?** Hoy hay uno y es del agente (`config.ts:1117`). Recomendación: **uno**; un usuario que teclea en español quiere leer en español. Si se quieren dos, `agent_locale` como override opcional.
2. **¿La preferencia por persona vive en la base (`users.locale`, migración nueva) o sólo en `~/.mnemosine/config.json`?** Para el CLI basta el archivo; para la API sin cabecera hace falta base o inquilino. Recomendación: `tenants.settings.locale` ahora (sin migración) y `users.locale` cuando exista el primer cliente API multiusuario.
3. **¿Se traduce la AYUDA del CLI?** El pedido dice sí; conviene confirmarlo porque invierte dos guardias vigentes (`bilingual-matrix.spec.ts:310-323` «help text is English», `ux-status.ts:314 fueraDeIdioma`) y la política escrita en `mnemosine.ts:2039` y `src/cli/README.md:396`. Alternativa mínima: ejecución y errores en el locale, ayuda sólo `en` + alias.
4. **¿`cli-reference.md` que lee el agente se publica sólo en `en` (fuente) o también un `cli-reference.es.md`?** Recomendación: sólo `en`; el agente ya conoce los alias (`generate-cli-reference.ts:16-30`) y responde en el locale del usuario.
5. **Dependencia `intl-messageformat` (ICU completo, pinado) o formateador propio mínimo** (plural/select/number/date sobre `Intl`). Recomendación: la dependencia; la casa ya depende de `commander`, `zod`, `decimal.js`.
6. **Símbolo o código de moneda en tablas**: `$1,234.56` (ambiguo entre MXN y USD) vs `1,234.56 MXN`. Recomendación: **código ISO** siempre que la fila tenga moneda; `policy-preview.ts:27` (`$1,234 MXN`) es el defecto que esto evita.
7. **Fechas para humanos**: ISO `2026-01-15` siempre (recomendación de `ux-idioma.md:874`: no ambigua, ordenable) vs `15/01/2026` por locale en tabla. Recomendación: ISO en tabla; nombre de mes sólo en prosa y nombres de periodo.
8. **`period_name`**: conservar la columna (vista materializada, `ILIKE`) y derivar la vista, o dejar de persistirla (toca `mv_trial_balance` y 172 lectores). Recomendación: conservar y derivar.
9. **Mensajes de commit y documentación de proceso**: el pedido cubre comentarios; ¿`CONTRIBUTING.md:96`/`PROCESS.md:58` (commits en español) y `docs/auditorias/`, wiki, `HISTORY.md` siguen en español? Recomendación: sí; son voz del equipo y `criterios.ts:776-849` ancla prosa castellana de `docs/auditorias/` y del catálogo.
10. **Manuales normativos (`nif-*` en español) y skills de ejemplo (`skills/`, inglés)**: ¿se dejan como están? Recomendación: sí; el corpus va en el idioma de su fuente.
11. **¿Se rellenan históricos** (asientos posteados, `audit_log`) con claves? Recomendación: **no** (`041`, `033`, NIF B-1, y el rastro debe leerse como se escribió).
12. **Zona horaria por entidad**: fuera de este diseño; ¿se abre tramo en la serie J? (18 `CURRENT_DATE` en Postgres frente a `now.getMonth()` en Node, verificación formato-y-locale H4.)
13. **Los 24 códigos de error castellanos**: congelar (recomendado) o alias inglés con ventana de retiro y `details.legacy_code`.
14. **Las 10 claves `x-*` castellanas del OpenAPI** (`x-escribe`, `x-riesgo`…; `openapi.ts:137-157`): ¿se conservan (contrato publicado) o se duplican en inglés con ventana?
15. **¿Un tercer idioma de prueba (`pt-BR`) desde L2** para demostrar que el fallback y el metro funcionan antes de que exista un cliente que lo necesite?
16. **`MNEMOSINE_LANG`**: ¿alias permanente o retiro con aviso tras un tramo? Recomendación: alias permanente (6 líneas en tests, `.env.example`, docs).

---

## 5. Riesgos

1. **El árbol es compartido y está en movimiento.** `src/services/jurisdiccion/` no está en ningún commit; L10 depende de J0.1/J0.5. Todo lo verificable de este diseño se verifica en un worktree del commit, no en la copia de trabajo (`AGENTS.md`).
2. **Las guardias vigentes miden lo contrario del pedido.** `ux-status.ts:299-330` cuenta castellano en pantalla como defecto (líneas base 7 y 17, `ci.yml:176`); `bilingual-matrix.spec.ts:310-323` exige ayuda inglesa. Deben **reexpresarse** sobre el render `en` en L4, no «bajarse»: la fuente inglesa es exactamente lo que siguen protegiendo.
3. **Volumen de aserciones**: 1 025 en `tests/cli` (43 de 48 spec), 766-983 de mensajes en `tests/`, 34+34 de `period_name`, 11 frases inglesas clavadas en `withdrawn-endpoints.spec.ts:109-142`, y una prueba que lee un fuente crudo (`reconciliation-adjustments.spec.ts:107-118`). Se pagan tramo a tramo, por clave o por render `en`; nunca en una pasada masiva.
4. **El manifiesto del corpus hace hash del archivo entero** (`corpus-manifiesto.ts:58-67`): 49 fuentes, entre ellas `entry-command.ts`, `bank-command.ts`, `posting.ts`, `fiscal-calendar-service.ts`, `policy-service.ts`, `policy-tools.ts`, `doctor-service.ts`. Cada tramo que toque una fuente sellada obliga a releer y resellar **su** manual (`--actualizar <manual>`), uno a uno; hoy ya está en rojo por el árbol sucio. Es coste conocido, no bloqueo.
5. **`criterios.ts` ancla texto y líneas**: 12 identificadores y 21 rutas renombrables (verificación identificadores), mutantes en hojas del CLI (`:6234` `tax-amount=2000.00`, `:6307` `out.push(...wrapLines(…p.question))`), prosa del panel (`:2723-2738`), E1.1 sobre `code:/name:` (`:2058-2073`), `INPC_BASES_DISTINTAS` (`:4779`), `MISSING_ROLE_ACCOUNT` (`:1995`), `Examples:` contados en `cli-reference.md` (`:6217-6222`), `PPD received → DR 1135` en un manual (`:3735-3747`). `npm run mutantes` debe seguir en 120/120 en cada PR; un ancla rota es rojo.
6. **Trinquete `--piso` por texto**: hasta L0, cualquier enunciado tocado es un `desaparecidos`. Por eso L0 es previo a todo, no opcional.
7. **Anexo 24 con artefactos hasheados** (`sat_anexo24_artefactos`, `UNIQUE` por hash; `f07b:170`, `f07d:430-435` comparan hash): un cambio de render de `Concepto` para meses ya emitidos produce artefactos nuevos; el diseño lo asume y lo prueba; hay que decir en la nota de versión que un mes re-emitido tras L9 puede dar otro hash.
8. **`period_name` ya tiene dos convenciones en la misma columna** (`January 2026` y `Periodo 3/2026`, `conducta.ts:194`, fijado por 4 tests de integración). Derivar la vista las unifica en pantalla; la búsqueda por nombre debe seguir encontrando ambas.
9. **Formato numérico por región**: `es` sin región agrupa con punto; dos regex de la casa (`output.ts:186`, `compaction.ts:249`) sólo entienden coma. La canonización `es → es-MX` del §2.1 lo evita; un tercer idioma con otra agrupación exige tocar esas dos regex antes de admitirlo.
10. **Dos ordenamientos**: 58 `ORDER BY` sobre texto deciden con la intercalación de un `postgres:15-alpine` sin `LANG` (verificación formato-y-locale H2), la DIOT ordena con `localeCompare` del host, el Anexo 24 por unidad de código. Este diseño no mueve ninguno; sí exige que nada nuevo ordene con `Intl.Collator` un artefacto firmado.
11. **Cobertura por archivo**: `src/i18n/` no estará en `coverage.include` (`vitest.config.ts:35-39`) salvo que se añada; y toda función nueva en `posting.ts` (umbral 99/95/100/99) necesita spec propio porque sus llamadores lo mockean entero (memoria de la casa). L9 lo presupuesta.
12. **El agente y las traducciones**: un modelo que redacte catálogos y los escriba en `src/` viola «propone, nunca dispone»; el borrador va fuera de `src/` y lo mueve una persona (§2.8).
13. **`AGENTS.md` sin regla de idioma hasta L3**: cada sesión nueva seguirá escribiendo prosa de usuario en línea. Cuanto más tarde L3, más cadenas nuevas fuera de catálogo — el metro las contará, pero contarlas no las evita.
14. **Mensajes de bibliotecas**: Zod sin `errorMap` y Apollo nativo salen en inglés; `pg` («role "postgres" does not exist») también. Lo cubre el remedio de `reportError` y un `errorMap`; lo que no se cubra se documenta en el contrato como inglés.
15. **Coste de traducir «ensayos»**: no aplica a esta lente (los comentarios son otra), pero los ~450 textos del panel y las ~120 plantillas de póliza son prosa contable con fundamento legal (LISR 28-XX, LGSM 19-20): la traducción la revisa un contador, no sólo un desarrollador.

---

## 6. Comandos propios de esta sesión (para reproducir cada cifra de §0 que no cita un informe)

```
git rev-parse --short HEAD; git branch --show-current; git status --short | wc -l
grep -rn "MNEMOSINE_LANG" src --include='*.ts' | wc -l                         # 5
grep -rn "Intl\." src --include='*.ts' | wc -l                                  # 0
grep -rniE "accept-language" src --include='*.ts' | wc -l                       # 0
grep -rc "configureHelp" src/cli --include='*.ts' | grep -v ':0$' | wc -l       # 0
grep -nE "register[A-Za-z]+Command\(program" src/cli/mnemosine.ts | wc -l       # 43
grep -rho "\.description(" src/cli --include='*.ts' | wc -l                     # 309
grep -rho "\.option(" src/cli --include='*.ts' | wc -l                          # 700
grep -rhoE "throw (new CliError|usageError|notFound|validationFailed|blockedByState|conflict|permissionDenied|externalFailed|externalRejected|abortedByUser|needsHuman)\(" src/cli --include='*.ts' | wc -l   # 350
grep -rhoE "throw new [A-Za-z]+Error\(\s*[\`'\"]" src/services src/utils --include='*.ts' | wc -l   # 305
grep -rhoE "new AccountingError\(" src --include='*.ts' | wc -l                # 113
grep -cE "^\s*key: '" src/services/policy/pending-catalog.ts                    # 53
grep -oE "label: '[^']*'" src/services/policy/pending-catalog.ts | wc -l        # 131
grep -rc "toContain(\|toMatch(" tests/cli --include='*.spec.ts' | awk -F: '{s+=$2} END{print s}'   # 1025
grep -rn "period_name" src --include='*.ts' | wc -l                             # 172
grep -rnE "'(January|February|March|April|May|June|July|August|September|October|November|December) 20" tests --include='*.ts' | wc -l   # 34
grep -rnE "'Periodo [0-9]" tests --include='*.ts' | wc -l                       # 34
grep -rn "toLocale" src --include='*.ts' | wc -l                                # 8
grep -rn "auto-post by threshold" src --include='*.ts' | wc -l                  # 11
grep -rnE "reason: (\`|')" src --include='*.ts' | grep -vE "/plan/|\.spec\." | wc -l   # 16
git show HEAD:src/ai/doctor-service.ts | grep -c "name: '"                       # 53
grep -c '^\*\*' docs/wiki/Glosario.md                                           # 47
grep -rln "AsyncLocalStorage" src --include='*.ts'                              # 4 archivos
grep -rnE "settings" src --include='*.ts' | grep -iE "tenant" | wc -l           # 0
ls src/database/migrations | wc -l; ls src/database/migrations | tail -1       # 74; 069_…
grep -oE '"x-[a-z-]+"' docs/openapi.json | sort -u | wc -l                      # 11
node -p "process.versions.icu + ' ' + JSON.stringify(Intl.NumberFormat.supportedLocalesOf(['es-MX','en-US','es','pt-BR'])) + ' ' + new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(1234567.5) + ' | ' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(1234567.5) + ' | ' + new Intl.DateTimeFormat('es-MX',{dateStyle:'long'}).format(new Date(Date.UTC(2026,0,15,12))) + ' | ' + new Intl.PluralRules('es').select(1) + '/' + new Intl.PluralRules('es').select(2)"
#   → 78.2 ["es-MX","en-US","es","pt-BR"] $1,234,567.50 | $1,234,567.50 | 15 de enero de 2026 | one/other
```
