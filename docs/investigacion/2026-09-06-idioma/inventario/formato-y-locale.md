# Inventario · Formato y locale

Superficie: todo lo que decide CÓMO se escriben números, dinero, fechas, plurales, meses y orden alfabético en mnemosine, y dónde vive (o no vive) la noción de idioma y de locale del usuario, del inquilino y de la entidad.

- Árbol: `/Users/victor/projects/Accounting`, HEAD `b31e62a` (rama `instrumentos-que-mienten-segun-la-maquina`, árbol limpio), 2026-09-06.
- Tamaño de referencia: 376 archivos `.ts` en `src` (`find src -name '*.ts' | wc -l`), 150 818 líneas (`find src -name '*.ts' -exec cat {} + | wc -l`), 336 specs en `tests` (`find tests -name '*.spec.ts' | wc -l`), 112 tablas en 74 migraciones (`grep -rhoE "CREATE TABLE( IF NOT EXISTS)? [a-z_]+" src/database/migrations | awk '{print $NF}' | sort -u | wc -l`; `ls src/database/migrations | wc -l`).
- No se editó ningún archivo del repositorio. Ningún archivo leído contenía instrucciones dirigidas al investigador; las «recomendaciones» de `docs/auditorias/2026-09-01-usabilidad/ux-salida.md` y de `docs/jurisdicciones.md` se citan como dato.

## 1. Método

Todo se contó con `grep` recursivo sobre `src`, `tests`, `scripts`, `docs` y los archivos raíz, y se verificó con lectura del contexto (`sed -n`). En este shell `grep` es una función que envuelve `ugrep`; los conteos que aquí figuran se hicieron con `command grep` (GNU/BSD) y patrones `-E`, para que sean reproducibles con cualquier grep. Los globs `--include='*.ts'` van entre comillas por zsh.

Las clases usadas en los ejemplos son las del pedido: `identificador`, `nombre_de_archivo`, `comentario`, `texto_de_usuario_renderizado`, `texto_persistido`, `texto_emitido_a_tercero`, `dato_vocabulario`, `formato_locale`.

## 2. Conteos

| Qué | Cuántos | Comando |
|---|---|---|
| `Intl.` en `src` | **0** | `command grep -rn "Intl\." src --include='*.ts' \| wc -l` |
| `Intl.` en `docs`+`skills` | 2 (1 propuesta real: `ux-salida.md:414`; 1 falso positivo «XBRL Intl.») | `command grep -rn "Intl\." skills docs --include='*.md'` |
| `toLocaleString/toLocaleDateString` en `src` | **8** (7 con `'en-US'`, 1 con `'es-MX'`) | `command grep -rn "toLocale" src --include='*.ts'` |
| `toLocale*` en `tests` | 0 | `command grep -rn "toLocale" tests --include='*.ts' \| wc -l` |
| `toLocale*` en `scripts` | 2 (`reclasificar-iva-ppd.ts:30` es-MX currency; `artefacto/plantilla.html:354` comentario que lo evita) | `command grep -rn "toLocale" scripts` |
| Literales `'es-MX'` / `'en-US'` en `src` (todo tipo de archivo) | 2 / 7 | `command grep -rn "es-MX" src \| wc -l`; `command grep -rn "en-US" src \| wc -l` |
| `localeCompare` en `src` | **13** en 11 archivos (+1 comentario que lo evita a propósito, `catalogo-cuentas.ts:280`) | `command grep -rn "localeCompare" src --include='*.ts'` |
| `localeCompare` en `scripts` / `tests` | 1 / 0 | `command grep -rn "localeCompare" scripts tests \| wc -l` |
| Dinero a mano con `$${…}` (excluidos placeholders SQL) | **3** (`usage-command.ts:72`, `budget.ts:99`, `budget.ts:109`) de 279 `$${` totales; 261 son `$1..$n` de SQL | `command grep -rnE '\$\$\{[^}]*(toFixed\|monto\|amount\|total\|importe\|saldo\|balance\|fmt\|Number\()' src --include='*.ts'`; total: `command grep -rn '\$\${' src --include='*.ts' \| wc -l` |
| Literal `'MXN'` en `src` | 26 líneas en 17 archivos | `command grep -rn "'MXN'" src --include='*.ts' \| wc -l`; `… -l \| wc -l` |
| Literal `'USD'` en `src` | 12 | `command grep -rn "'USD'" src --include='*.ts' \| wc -l` |
| `toFixed(` en `src` | **569** llamadas en 104 archivos; `toFixed(2)` 197, `toFixed(4)` 187, `toFixed(<const>)` 151; en `src/cli` 53; en `tests` 197 | `command grep -rn "toFixed(" src --include='*.ts' \| wc -l`; `command grep -rc "toFixed(" src --include='*.ts' \| grep -v ':0$' \| wc -l` |
| Separador de miles a mano (regex `\B(?=(\d{3})+(?!\d))`) | 2 (`kernel/output.ts:176`, `scripts/artefacto/plantilla.html:358`) | `command grep -rnE "\(\?=\(\\\\d\{3\}\)" src scripts --include='*.ts' --include='*.html'` |
| Formateadores de dinero definidos (`money`, `fmt`, `formatMoneyMx`, `formatearImporte`…) | 12 definiciones en 11 archivos | `command grep -rnE "const (money\|fmt\|fmtMoney\|fmtUsd\|formatMoney\|formatearMoneda\|formatearImporte\|dinero\|importe) = \(\|function (money\|fmtMoney\|formatMoney\|formatCurrency\|formatearMoneda\|formatearImporte\|formatoMoneda\|formatMoneyMx)\(" src --include='*.ts'` |
| Usos de `formatMoneyMx` (src+tests) | 21 líneas; en `src`: definición + export del kernel + rama `table` + 8 llamadas en `diot-command.ts` y `payroll-isn-command.ts` | `command grep -rn "formatMoneyMx" src tests --include='*.ts'` |
| Plurales a mano, forma `palabra(s)`/`palabra(es)` | **304** líneas (top: `bank-command.ts` 46, `criterios.ts` 19, `period-close.ts` 15, `batch-command.ts` 15, `doctor-service.ts` 14, `mnemosine.ts` 12) | `command grep -rnE "[a-záéíóúñA-Z]\((s\|es)\)" src --include='*.ts' \| command grep -vE "\.test\(s\)\|\(s\) =>\|\(s\)\.\|\(s\): \|\(s\)\) \|\(s\) \{\|\(s\)\)\|\bfn\(s\)\|\(s\),\s*$\|\(s\)\]" \| wc -l` |
| Plurales a mano, ternario `n === 1 ? '' : 's'` | **9** líneas (7 en inglés en `policy-preview.ts`, 2 en español en `bank-account-service.ts:1308,1322`, 1 en `mnemosine.ts:1312`) | `command grep -rnE "\? 's' : ''\|\? '' : 's'\|\? 'es' : ''\|\? '' : 'es'\|=== 1 \? '' :\|!== 1 \? 's'" src --include='*.ts'` |
| Tablas de nombres de mes en `src` | **4**: `parsers/fecha.ts:19-32` (bilingüe, para LEER), `inpc/periodo.ts:37-40` (español, para MOSTRAR), `database/seed.ts:54` (inglés, para PERSISTIR), `fiscal-calendar-service.ts:534` (`en-US` vía `toLocaleString`, para PERSISTIR) | `command grep -rniE "'enero'\|'january'\|MESES\|NOMBRES_DE_MES\|month: 'long'" src --include='*.ts'` (170 líneas brutas; 166 son la palabra «meses» en comentarios/identificadores de aritmética de calendario) |
| `period_name` (columna que guarda «January 2026») | 172 menciones; **2** búsquedas de periodo por subcadena del nombre en inglés (`close-command.ts:196`, `closing-command.ts:156`); 34 líneas de tests fijan `'January 2026'` y similares | `command grep -rn "period_name" src --include='*.ts' \| wc -l`; `command grep -rnE "'(January\|…\|December) 20" tests --include='*.ts' \| wc -l` |
| Zona horaria en `src` | 12 líneas: **1** de código (`fiscal-calendar-service.ts:534` `timeZone: 'UTC'`) y 11 comentarios que explican por qué se evita el `Date` con hora; `process.env.TZ` en `src`: 0; `TZ` en `.github`/`vitest.config`: 0; `tests/cli/kernel/presentation.spec.ts:19` fija `TZ='America/Mexico_City'` | `command grep -rniE "timeZone\|timezone\|time_zone\|zona horaria\|huso\|America/\|process\.env\.TZ" src --include='*.ts'` |
| `getFullYear/getMonth/getDate/getDay/getHours` (hora local) vs `getUTC*` vs `Date.UTC(` | 38 / 27 / 28; `new Date(` 317 | `command grep -rnE "\.(getFullYear\|getMonth\|getDate\|getDay\|getHours)\(\)" src --include='*.ts' \| wc -l` (y variantes) |
| Fechas ISO: `toISOString` / `split('T')[0]` / `slice(0, 10)` / texto `YYYY-MM-DD` | 194 / 25 / 42 / 184 | `command grep -rn "toISOString" src --include='*.ts' \| wc -l` (y variantes) |
| `DD/MM` fuera de `fecha.ts` | perfiles bancarios: 3 declaraciones `formatoFecha` en 4 perfiles (`perfiles-csv.ts:72,109,148`) | `command grep -rnE "DD/MM\|MM/DD\|DD-MM\|MM-DD" src --include='*.ts' \| command grep -v parsers/fecha.ts` (189 líneas brutas, 186 son `YYYY-MM-DD`) |
| `to_char(` en SQL / con nombre de mes (`Month`, `Mon`, `TM…` — dependería de `lc_time`) | 34 / **0** | `command grep -rn "to_char(" src --include='*.ts' \| wc -l`; `command grep -rnE "to_char\([^)]*'[^']*(Month\|Mon\|Day\|Dy\|TM)[^']*'" src --include='*.ts' \| wc -l` |
| `COLLATE`/`lc_collate`/`SET TIME ZONE`/`setTypeParser` en `src`+`docs`+`docker` | 1 (sólo el comentario `catalogo-cuentas.ts:276`) / 0 en `src/database` | `command grep -rniE "lc_collate\|COLLATE\|collation\|lc_time" src docs docker …`; `command grep -rniE "SET TIME ZONE\|timezone\|setTypeParser" src/database --include='*.ts' \| wc -l` |
| Noción de idioma en código: `language` en `src` (sin `LANGUAGE plpgsql`) | 29 líneas; consumidores de `resolveLanguage()`: `system-prompt.ts:185`, `mnemosine.ts:1066,2045`, `status-command.ts:253` | `command grep -rn "language" src --include='*.ts' \| command grep -viE "LANGUAGE plpgsql\|language-neutral\|language-specific" \| wc -l`; `command grep -rn "resolveLanguage\|MNEMOSINE_LANG" src --include='*.ts'` |
| `MNEMOSINE_LANG` en `src` / en `tests` | 3 / 6 líneas en 3 specs | `command grep -rn "MNEMOSINE_LANG" src tests --include='*.ts'` |
| `MNEMOSINE_LOCALE` en `src` / en `docs` | **0** / 1 (`ux-salida.md:418`, propuesta) | `command grep -rn "MNEMOSINE_LOCALE" src docs \| wc -l` |
| `Accept-Language` en `src` | **0** | `command grep -rniE "accept-language" src \| wc -l` |
| Columnas `locale`/`language`/`idioma`/`lang`/`timezone` en migraciones | **0** (los 22 aciertos son `LANGUAGE plpgsql` y el comentario del FTS `029:8-13`; timezone 0) | `command grep -rniE "locale\|language\|idioma\|\blang\b" src/database/migrations`; `command grep -rniE "timezone\|time_zone\|\btz\b" src/database/migrations \| wc -l` |
| Columnas de moneda en migraciones | 27 líneas; `legal_entities.functional_currency CHAR(3) DEFAULT 'USD'` (`001:86`); `currency_code … DEFAULT 'USD'` en AP/AR/banca/nómina (`002:25,58,120,175,206,280`, `003:22`, `008:69`); `DEFAULT 'MXN'` sólo en `xml_documents` (`005:170`) | `command grep -rniE "^\s*[a-z_]*currency[a-z_]* " src/database/migrations` |
| País/jurisdicción en esquema | `incorporation_country CHAR(2)` (`001:85`), `state_province` texto libre (`032:24`), `country_code CHECK IN ('MX','US')` y `jurisdiction VARCHAR(20)` en nómina (`008:35,124,313,335,356,377`) | `command grep -rniE "^\s*[a-z_]*(country\|jurisdic)[a-z_]* " src/database/migrations` |
| Tablas `tenants` / `users` | **0 / 0** (existe `organizations`, `001:66-74`; `tenant_id` es columna sin tabla propia; el usuario es un sujeto OIDC, `src/auth/sujeto-activo.ts`, o el `--user` tecleado) | `command grep -rnE "CREATE TABLE( IF NOT EXISTS)? (tenants\|users\|organizations\|user_)" src/database/migrations` |
| Banderas globales de idioma/locale en el kernel | **0** (`--locale`/`LANG` no existen; sólo el comando raíz `lang` con alias `idioma`) | `command grep -rniE "locale\|\bLANG\b\|LC_ALL\|idioma\|language" src/cli/kernel` (4 líneas, ninguna es una bandera) |
| Variables de entorno leídas en `src` | 78 nombres distintos; de idioma/locale sólo `MNEMOSINE_LANG`; ninguna `LANG`, `LC_*`, `TZ` | `command grep -rhoE "process\.env\.[A-Za-z_0-9]+" src --include='*.ts' \| sort \| uniq -c \| sort -nr` |
| Criterios de `src/plan/criterios.ts` que leen archivos de esta superficie | **1** (`criterios.ts:3051` lee `src/cli/usage-command.ts` buscando `PRECIOS_VIGENTES_A`) | `command grep -nE "parsers/fecha\|parsers/importe\|kernel/output\|fiscal-calendar-service\|cfdi-decisions\|policy-preview\|inpc/periodo\|database/seed\|compact-command\|usage-command\|prompt-size-command\|approvals-command\|formatMoneyMx\|toLocaleString\|localeCompare\|resolveLanguage\|MNEMOSINE_LANG\|jurisdiccion\.ts" src/plan/criterios.ts` |
| Umbrales por archivo en `vitest.config.ts` que tocan la superficie | 1 de 7 (`jurisdiccion.ts`, línea 105); `include` de cobertura: `src/services/accounting/**`, `src/services/jurisdiccion/**`, `src/services/reporting/**`, `src/utils/sequence.ts` (líneas 25-30) — **`src/cli/kernel` no se mide** | `command grep -nE "^\s*'src/[^']+':\s*\{" vitest.config.ts`; `sed -n '25,30p' vitest.config.ts` |
| Rutas de esta superficie en `LINEA_BASE` (`src/cli/kernel/audit.ts:197`) | **0** | mismo patrón sobre `src/cli/kernel/audit.ts` |
| Rutas de esta superficie en `src/ai/docs/manifiesto.json` | 1: `fiscal-calendar-service.ts` (líneas 9 y 89, hash por ruta) | `command grep -nE "<patrón>" src/ai/docs/manifiesto.json` |
| Specs que referencian la superficie | 38 archivos; `analizarFecha` 26 líneas/1 spec, `analizarImporte` 31/1, `formatMoneyMx` 9/1, `nombrarPeriodo` 3/1, `jurisdiccionDe` 12/2, `monedaLegal` 14/1, `separadorDecimal` 15/2, `toLocaleString` 0, `localeCompare` 0, `'en-US'` 0, `'es-MX'` 3 (sólo comentarios) | `command grep -rlF "<id>" tests --include='*.ts' \| wc -l` por identificador |

## 3. Ejemplos con archivo:línea y clase

### 3.1 Dinero y números

| archivo:línea | texto | clase | idioma | nota |
|---|---|---|---|---|
| `src/cli/kernel/output.ts:162` | `export function formatMoneyMx(value: string): string` | identificador | en (sufijo `Mx` fija el locale en el nombre) | Único formateador del kernel; miles con coma y dos decimales por cadena+BigInt (`:155-178`). Se aplica **sólo** en la rama `table` (`:196-197`); `json/ndjson/csv/tsv/md` reciben la cadena de almacenamiento intacta. |
| `src/cli/kernel/output.ts:155` | `* es-MX de presentación: separador de miles y DOS decimales…` | comentario | es | |
| `src/cli/kernel/output.ts:144-145` | `MONEY_COL_RE = /(^\|_)(amount\|…\|importe\|price)(_\|$)/` | dato_vocabulario | mixto (`importe` entre nombres ingleses) | Decide qué columnas «son dinero» por el nombre. |
| `src/services/xml-ingestion/cfdi-decisions.ts:46-47` | `` const money = (n, moneda = 'MXN') => `${n.toLocaleString('es-MX', {min…2, max…2})} ${moneda}` `` | formato_locale | es-MX | Texto que ve el contador en las preguntas del agente. |
| `src/services/policy/policy-preview.ts:26-27` | `` const money = (n, currency = 'MXN') => `$${n.toLocaleString('en-US', {…0})} ${currency}` `` | formato_locale | en-US con `$` fijo y moneda `MXN` por omisión | «$1,234 MXN»: símbolo de dólar puesto a mano delante de pesos, sin decimales, en el panel `pending`. |
| `src/cli/compact-command.ts:83`, `src/cli/usage-command.ts:71`, `src/cli/prompt-size-command.ts:103` | `const fmt = (n: number): string => n.toLocaleString('en-US');` | formato_locale | en-US | Conteos de tokens/caracteres; tres copias idénticas. |
| `src/cli/approvals-command.ts:158-159` | `` …capped at ${cap.toLocaleString('en-US')} by the floor (FLOOR_MAX_AUTO_POST = …) `` | formato_locale + texto_de_usuario_renderizado | en | Importe del piso en advertencia. |
| `src/cli/usage-command.ts:72` | `` const fmtUsd = (n) => `$${n.toFixed(4)}` `` | formato_locale (moneda a mano) | — | Costo de proveedor LLM en USD. |
| `src/ai/budget.ts:99,109` | `` `$${v.spent.toFixed(4)} de $${v.limit} USD${nota}` `` | formato_locale + texto_de_usuario_renderizado | mixto («de» español, `USD`) | |
| `src/cli/report-command.ts:108-111` | `function money(value) { … return new Decimal(value).toFixed(4); }` | identificador | en | Cuatro decimales crudos; la vestimenta es-MX la pone `output.ts` en `table` (`tests/cli/report-command.spec.ts:198`). |
| `src/cli/mnemosine.ts:1338` | `const money = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '');` | formato_locale | — | Revisión de borradores. |
| `src/services/sat/anexo24/balanza-invariantes.ts:106` | `export function formatearImporte(valor: Decimal \| string): string` | identificador | es | Importe para el XML del Anexo 24 (tercero). |
| `src/services/payroll/integrations/imss-idse-adapter.ts:104` | `'decimal string — no thousands separator, no currency symbol.'` | texto_emitido_a_tercero (contrato) | en | El IDSE no admite formato de locale. |
| `src/cli/payroll-isn-command.ts:1267` | `` `  ISN computed: ${formatMoneyMx(total)} MXN across ${porEstado.length} state(s)\n` `` | texto_de_usuario_renderizado | en + plural a mano + moneda literal | |
| `src/services/banking/parsers/importe.ts:235-300` | `function decidirSeparadores(t, preferido: SeparadorDecimal)` | identificador + formato_locale (LECTURA) | es | Infiere si `,`/`.` es decimal o miles; la ambigüedad se confiesa en `aviso` (`:272-275`). `parseFloat` prohibido a propósito (`:7-11`). |
| `src/services/banking/parsers/tipos.ts:129,145` | `export type SeparadorDecimal = '.' \| ',' \| 'auto'` | dato_vocabulario | es | Valor de perfil bancario. |
| `scripts/reclasificar-iva-ppd.ts:29-30` | `Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })` | formato_locale | es-MX | Único uso de `style: 'currency'` en todo el árbol. |
| `scripts/artefacto/plantilla.html:354-358` | `` const mil = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); `` | formato_locale | — | Evita `toLocaleString('es')` porque «depende de los locales que traiga el navegador». |
| `src/plan/criterios.ts:5488` | `'…100.000 a 36 meses vuelve a acumular 100.000,0008…'` | texto_de_usuario_renderizado | es (punto de miles y coma decimal, convención española, no mexicana) | Los mensajes de criterios mezclan convención europea en prosa con `1,234.56` en tablas. |

### 3.2 Fechas, meses, zona horaria

| archivo:línea | texto | clase | idioma | nota |
|---|---|---|---|---|
| `src/services/accounting/fiscal-calendar-service.ts:532-534` | `// Period names are stored, not translated at render time; the CLI UI is English, so they are minted in English.` / `start.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) + \` ${yearNumber}\`` | texto_persistido + formato_locale | en-US | **La única línea de `toLocaleString` cuyo resultado se guarda en la base** (`fiscal_periods.period_name`). |
| `src/database/seed.ts:54` | `const months = ['January', …, 'December'];` | texto_persistido | en | Semilla del mismo campo. |
| `src/cli/close-command.ts:196`, `src/cli/closing-command.ts:156` | `periods.find((p) => p.period_name.toLowerCase().includes(opts.period!.toLowerCase()))` | texto_de_usuario_renderizado (clave de búsqueda) | en | El contador teclea `--period january`: el nombre persistido en inglés es interfaz de entrada. |
| `src/services/fiscal/inpc/periodo.ts:36-40` | `/** Los meses en español, para mensajes que se leen. */ const NOMBRES_DE_MES = ['enero', …]` | texto_de_usuario_renderizado | es | `nombrarPeriodo` → «julio de 2024» (`:46-48`), 3 consumidores en `inpc/`. |
| `src/services/banking/parsers/fecha.ts:19-32` | `const MESES: Record<string, number> = { ene: 1, enero: 1, jan: 1, january: 1, … }` | dato_vocabulario (LECTURA) | mixto es/en | Reconoce abreviaturas de los dos idiomas al leer extractos. |
| `src/services/banking/parsers/fecha.ts:148-158` | `// Se toma DD/MM —la convención de México, que es de donde vienen estos archivos— y se confiesa.` + aviso `«…» es ambigua … Se leyó como DD/MM` | comentario + texto_de_usuario_renderizado | es | Convención MX cableada como omisión de `auto`; el perfil manda (`formatoFecha`). |
| `src/services/banking/parsers/perfiles-csv.ts:72,109,148` | `formatoFecha: 'DD/MM/YYYY'`, `'DD-MMM-YYYY'` | dato_vocabulario | — | 4 perfiles bancarios; `monedaAsumida: 'MXN'` (`:74`). |
| `src/cli/kernel/output.ts:97-109` | `* La fecha LOCAL como yyyy-mm-dd. … node-postgres entrega las columnas DATE como Date a medianoche local … toISOString() la movía un día` / `export function dateOnly(value)` | comentario + identificador | es / en | 21 usos; el día se imprime con getters LOCALES (hora del proceso). |
| `src/cli/kernel/flags.ts:477-483` | `parseDate … must be a date as YYYY-MM-DD` | texto_de_usuario_renderizado | en | Entrada ISO única en `--since/--until/--as-of` (`:548-550`). |
| `src/services/ap/ap-controls.ts:91` | `/** YYYY-MM-DD. Nunca un Date: una fecha de calendario con hora es una zona horaria esperando a equivocarse. */` | comentario | es | Regla de la casa: fecha contable = cadena ISO. |
| `src/services/banking/treasury-posting.ts:583,924` | `…serializa un Date en la ZONA HORARIA DEL PROCESO…` | comentario | es | La TZ efectiva es la del proceso Node; no hay atributo de entidad. |
| `tests/cli/kernel/presentation.spec.ts:16-19` | `// La zona horaria se fija aqui mismo … process.env.TZ = 'America/Mexico_City';` | comentario + dato de prueba | es | El único lugar donde se fija TZ. |
| `src/services/accounting/fiscal-calendar-service.ts:523` | `yearNumber === now.getFullYear() && m - 1 === now.getMonth()` | formato_locale (hora local) | — | «Mes en curso» según la TZ del proceso. |

### 3.3 Ordenamiento

| archivo:línea | texto | clase | nota |
|---|---|---|---|
| `src/services/sat/anexo24/catalogo-cuentas.ts:273-281` | `// …con lc_collate en es_MX.UTF-8 y en C, el mismo catálogo sale en orden distinto… Por lo mismo NO se usa localeCompare, que depende del ICU del host.` | comentario (es) | Orden por unidad de código a propósito: el XML del Anexo 24 se firma y sus bytes no pueden depender del host. |
| `src/services/sat/diot/diot-service.ts:277-281` | `renglones.sort((a, b) => (a.tercero.rfc ?? …).localeCompare(b…))` | texto_emitido_a_tercero (orden) | La DIOT sí depende del ICU del host; contradice la regla del Anexo 24. |
| `src/services/sat/diot/desglose.ts:131,544` | `.sort(([x], [y]) => x.localeCompare(y))` | texto_emitido_a_tercero (orden) | Ídem. |
| `src/services/accounting/journal-entry-service.ts:647` | `.sort((x, y) => x.account_code.localeCompare(y.account_code))` | texto_de_usuario_renderizado (orden) | Orden de cuentas en la explicación del asiento. |
| `src/api/rest/openapi.ts:83` | `a.ruta.localeCompare(b.ruta) \|\| a.metodo.localeCompare(b.metodo)` | texto_emitido_a_tercero (orden) | Orden del documento OpenAPI. |
| `src/services/backup/exportacion-inquilino.ts:794,858` | `planes.sort((x, y) => x.tabla.localeCompare(y.tabla))` | texto_persistido (orden del respaldo) | |
| `src/plan/status.ts:63`, `src/cli/backup-command.ts:391`, `src/cli/prompt-size-command.ts:81`, `src/ai/memory-service.ts:491`, `src/ai/skills/store.ts:218` | `localeCompare` sobre ids/nombres/fechas ISO | texto_de_usuario_renderizado (orden) | Sobre ASCII; inocuos hoy, sensibles si entran acentos. |

### 3.4 Plurales a mano

| archivo:línea | texto | clase | idioma |
|---|---|---|---|
| `src/services/policy/policy-preview.ts:52,68,124,142,168,189` | `` `${n} time${n === 1 ? '' : 's'}` ``, `` `access${n === 1 ? '' : 'es'}` `` | texto_de_usuario_renderizado | en |
| `src/services/banking/bank-account-service.ts:1308,1322` | `` `${historia.lineas} línea${… ? '' : 's'} contabilizada${… ? '' : 's'}` `` | texto_de_usuario_renderizado | es |
| `src/cli/mnemosine.ts:1312` | `` `${s.message_count} message${s.message_count === 1 ? '' : 's'}` `` | texto_de_usuario_renderizado | en |
| `src/plan/criterios.ts:393,424,427,1187` | `atestación(es)`, `entidad(es)`, `sello(s)` | texto_de_usuario_renderizado | es |
| `src/cli/bank-command.ts` (46 líneas) | `movimiento(s)`, `sesión(es)`… | texto_de_usuario_renderizado | mixto |
| `src/services/assets/asset-service.ts:397-399` | `` `${m} meses caben en ${derivados} año(s)…` `` | texto_de_usuario_renderizado | es |

### 3.5 La noción de idioma y de locale que YA existe

| archivo:línea | texto | clase | nota |
|---|---|---|---|
| `mnemosine.config.json:16` | `"language": "es"` | texto_persistido (config de proyecto) | Único ajuste de idioma persistido. Esquema zod: `src/ai/providers/config.ts:597` `language: z.enum(['en', 'es']).optional()`. |
| `src/ai/providers/config.ts:1115-1131` | `export type AgentLanguage = 'en' \| 'es'` / `/** Language the AGENT answers in. CLI/UI text is always English… Default 'es' (Mexican accounting firms). */` / `resolveLanguage()`: `MNEMOSINE_LANG` > `./mnemosine.config.json` > `~/.mnemosine/config.json` > `'es'` | identificador + comentario | en | Precedencia de archivos: `config.ts:16,610-611` (`proyecto > usuario`). Es una preferencia **de máquina/proyecto**, no de persona autenticada, ni de inquilino, ni de entidad. |
| `src/ai/system-prompt.ts:171-174,185` | `const LANGUAGE_LINE = { es: 'Always respond in Spanish', en: 'Always respond in English' }` | texto_emitido_a_tercero (al LLM) | Único consumidor funcional del idioma. |
| `src/cli/mnemosine.ts:2036-2041` | `.command('lang').alias('idioma').description("Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)")` | texto_de_usuario_renderizado | **La decisión vigente está escrita aquí: la UI del CLI es inglesa y el español es alias.** |
| `src/cli/kernel/vocabulary.ts:133-137` | `OBJECTLESS_COMMANDS = […, 'version', 'upgrade', 'lang']` | dato_vocabulario (cerrado) | `lang` ya ocupa una palabra del vocabulario cerrado. |
| `src/cli/kernel/riesgos-retrofit.ts:87` | `lang: { risk: 'escritura', agent: false, writes: 'mnemosine.config.json (idioma del agente)' }` | dato_vocabulario | Riesgo del comando registrado. |
| `src/cli/status-command.ts:305`, `src/cli/banner.ts:67` | `agent language     ${report.config.language}` / `rows.push({ label: 'language', value: info.language })` | texto_de_usuario_renderizado | en |
| `docs/wiki/Arquitectura.md:122` | «El español es una capa de alias, nunca una segunda superficie; un alias reclamado por dos comandos es un fallo duro de la matriz bilingüe» | comentario (doc) | Regla actual de la matriz bilingüe del CLI. |
| `src/services/jurisdiction/jurisdiction.ts:41-47,159` | `fiscal: 'MX' \| 'US'`, `libros: 'mx_nif' \| 'us_gaap' \| 'ifrs'`, `monedaLegal: fiscal === 'MX' ? 'MXN' : 'USD'` | dato_vocabulario | La única derivación «jurisdicción → moneda» del sistema. Comentario `:10-12`: la autoridad fiscal «manda sobre… los formatos y la moneda». |
| `src/database/migrations/001_core_schema.sql:85-86` | `incorporation_country CHAR(2) NOT NULL, functional_currency CHAR(3) NOT NULL DEFAULT 'USD'` | texto_persistido (esquema) | La moneda funcional por omisión es USD mientras la regla de la casa es «ante la duda, mexicana» (`jurisdiccion.ts:27`). |
| `src/database/migrations/032_schema_contract.sql:20-28` | `ALTER TABLE legal_entities ADD COLUMN … city, state_province, postal_code, imss_registro_patronal` | texto_persistido (esquema) | Único `ALTER` posterior de `legal_entities`; no hay `locale`, `language` ni `timezone`. |
| `docs/jurisdicciones.md:135` | `informes: { idioma: 'es' \| 'en'; formatos: string[] }; // 'anexo24-xml', 'balanza-4col' / '941', 'w2'` | comentario (diseño) | El diseño del paquete de jurisdicción ya coloca el **idioma de los rótulos de informes en la jurisdicción**, no en el usuario. |
| `docs/auditorias/2026-09-01-usabilidad/ux-salida.md:414-418` | «Dos decimales en presentación, con `Intl.NumberFormat('es-MX')`…» / «una variable `MNEMOSINE_LOCALE` con `es-MX` por omisión, y `--format table` con locale `C`» | comentario (auditoría, propuesta no implementada) | `MNEMOSINE_LOCALE` no existe en `src` (0). |
| `src/cli/kernel/entity-context.ts:15-16` | `1. --entity <id\|name> explicit beats everything / 2. MNEMOSINE_ENTITY for CI and scripts` | comentario | La cascada bandera > env > fijado ya existe para ENTIDAD; no para idioma ni locale. |
| `src/database/migrations/029_ai_messages_fts.sql:8-13` | «transcripts mix both languages … 'simple' just lowercases and splits: language-neutral» | comentario | El FTS se declaró neutral porque no hay idioma por fila. |

## 4. Qué se rompe al cambiar

1. **`fiscal_periods.period_name` es texto persistido en inglés** (`fiscal-calendar-service.ts:534`, `seed.ts:54`). Traducir la línea sólo cambia las filas futuras; las existentes quedan en inglés y conviven dos idiomas en la misma tabla. Además el nombre es clave de búsqueda del usuario (`close-command.ts:196`, `closing-command.ts:156`: `--period january`), 34 líneas de specs lo fijan (`journal-entry-service.spec.ts:261-272`, `fiscal-calendar-service.spec.ts:100,115`, entre otros: `command grep -rnE "'(January|…) 20" tests`), y el archivo tiene hash en `src/ai/docs/manifiesto.json:89` → cualquier edición obliga a regenerar el manifiesto. Derivarlo en render (`period_number` + año) en vez de persistirlo es una decisión de esquema/datos, no de formato.
2. **`formatMoneyMx` es API del kernel** (`src/cli/kernel/index.ts:36`), con el locale en el nombre. Renombrarlo toca 2 comandos (`diot-command.ts:25,550,551,562,564`; `payroll-isn-command.ts:28,533,1267,1432`), `output.ts:197` y 9 líneas de `tests/cli/kernel/output.spec.ts` + `presentation.spec.ts`. Cambiar su salida rompe `tests/cli/report-command.spec.ts:198` y los literales «a propósito» de `presentation.spec.ts:12-14`.
3. **El contrato máquina/humano** está escrito en `presentation.spec.ts:10-14` («json y csv son contrato: cadena de cuatro decimales, sin separador de miles») y en `output.ts:193-195`. Cualquier locale nuevo tiene que quedarse en la rama `table` (y en los textos del agente); si se cuela en `json/csv/ndjson/tsv/md` rompe guiones de terceros y esas pruebas.
4. **Anexo 24** ordena por unidad de código a propósito (`catalogo-cuentas.ts:273-281`); sustituirlo por `localeCompare` o `Intl.Collator` cambia los bytes de un XML firmado. **DIOT** hace lo contrario (`diot-service.ts:277-281`, `desglose.ts:131,544`): hoy su orden ya depende del ICU del host; unificar hacia unidad de código puede alterar fixtures de tests (comprobar `tests/services/sat/diot/`).
5. **`toLocaleString`/`Intl` dependen del ICU de Node.** Con `full-icu` (Node ≥ 13 por omisión) `es-MX` y `en-US` existen; con `small-icu` cualquier locale distinto de `en-US` cae a `en-US` en silencio. No hay test que fije el locale del runner (0 `toLocaleString` en tests; 0 `TZ` en `.github/workflows/ci.yml`). `plantilla.html:354` ya documenta el problema en navegadores.
6. **`MNEMOSINE_LANG` y `lang` son contrato público**: 3 specs (`status-command.spec.ts`, `codigos-de-salida-hojas.spec.ts`, `ai/system-prompt.spec.ts`), la descripción del comando (`mnemosine.ts:2039`), `riesgos-retrofit.ts:87`, `vocabulary.ts:136`, `status-command.ts:305`, `banner.ts:67`. Añadir `--locale` global toca `flags.ts:34-35` (`FLAG_DICTIONARY`) y `BANNED_FLAGS` (`:27`); añadir un verbo nuevo toca el vocabulario cerrado. Extender `lang` (ya existe) no consume palabra nueva.
7. **Columna nueva** (`legal_entities.report_language`, `…timezone`, `…locale`): migración nueva append-only con número ≥ 075 (no renumerar: `docs/migraciones.md`), `CHECK` explícito, y actualizar `docs/jurisdicciones.md` §3.1 si el paquete de jurisdicción la lee. `functional_currency DEFAULT 'USD'` (`001:86`) sólo se corrige con otra migración.
8. **Cobertura por archivo**: `src/services/jurisdiction/jurisdiction.ts` tiene umbral propio (`vitest.config.ts:105`) y `src/services/jurisdiccion/**` está en el `include` (`:27`); una función `formatoDe(...)` ahí necesita spec al mismo nivel. `src/cli/kernel/**` **no está en el `include`** (`:25-30`): un `locale.ts` nuevo en el kernel no mueve umbrales, pero tampoco se mide.
9. **Criterios ejecutables**: sólo `criterios.ts:3051` lee un archivo de esta superficie (`src/cli/usage-command.ts`, busca `PRECIOS_VIGENTES_A`): renombrar ese archivo lo rompe. Ninguna otra ruta de la superficie aparece en `criterios.ts` ni en `audit.ts:LINEA_BASE`.
10. **Panel de políticas**: las etiquetas de `pending-catalog.ts` (134 `label:`) son texto renderizado y pueden traducirse; los `value` (p. ej. `'meses_completos'`, `:411`) se persisten en `policy_decisions` (`016_policy_decisions.sql`) y no pueden cambiar.
11. **Zona horaria**: hoy es la del proceso (`output.ts:97-106`, `treasury-posting.ts:583`, `fiscal-calendar-service.ts:523`). Introducir una TZ por entidad cambia qué día imprime `dateOnly` y qué mes es «el actual»; `presentation.spec.ts:19` la fija a `America/Mexico_City` y acusaría el corrimiento.
12. **Parsers bancarios**: `fecha.ts` y `importe.ts` LEEN formatos; su omisión (`DD/MM`, miles con `.`/`,` inferidos) es mexicana por diseño (`fecha.ts:148-149`). Si la preferencia de formato pasa a la jurisdicción, la omisión de `auto` debería seguir al perfil/entidad, con 26+31 líneas de specs que fijan la conducta actual.

## 5. Dependencias (quién referencia esta superficie por nombre o ruta)

- Criterios: `src/plan/criterios.ts:3051` (ruta `src/cli/usage-command.ts`).
- Umbrales: `vitest.config.ts:25-30` (include), `:105-111` (`jurisdiccion.ts`).
- Manifiesto: `src/ai/docs/manifiesto.json:9,89` (`src/services/accounting/fiscal-calendar-service.ts`).
- Auditoría del kernel: `src/cli/kernel/audit.ts:197` `LINEA_BASE` — 0 rutas de esta superficie.
- Pruebas: `tests/cli/kernel/presentation.spec.ts` (TZ, es-MX sólo en tabla), `tests/cli/kernel/output.spec.ts:131`, `tests/cli/report-command.spec.ts:198`, spec de `analizarFecha` (1 archivo, 26 líneas), spec de `analizarImporte` (1, 31), `tests/services/accounting/journal-entry-service.spec.ts:261-272`, `tests/services/accounting/fiscal-calendar-service.spec.ts:100,115`, `tests/cli/status-command.spec.ts`, `tests/cli/codigos-de-salida-hojas.spec.ts`, `tests/ai/system-prompt.spec.ts` (`MNEMOSINE_LANG`), specs de `jurisdiccionDe`/`monedaLegal` (2 archivos).
- Configuración: `mnemosine.config.json:16`; esquema `src/ai/providers/config.ts:597`; precedencia `:16,610-611,1119-1131`.
- Vocabulario cerrado: `src/cli/kernel/vocabulary.ts:136`; riesgos `src/cli/kernel/riesgos-retrofit.ts:87`; banderas `src/cli/kernel/flags.ts:27-35,488-530`.
- Esquema: `001_core_schema.sql:85-86`, `032_schema_contract.sql:20-28`, `005_xml_ingestion.sql:170`, `008_payroll.sql:35,313`, `016_policy_decisions.sql`.
- Documentos: `docs/jurisdicciones.md:91,135,257`; `docs/auditorias/2026-09-01-usabilidad/ux-salida.md:408-418`; `docs/wiki/Arquitectura.md:122`; `README.md:345`; `CONTRIBUTING.md:158`; `docs/PROCESS.md:58`; `src/ai/docs/cli-reference.md:1824`.

## 6. Dónde podría vivir cada preferencia (sin decidir por el dueño)

Conviene separar tres «idiomas» y un «formato», porque hoy están mezclados en un solo ajuste:

| Dimensión | Hoy | Sigue a… | Dónde podría vivir |
|---|---|---|---|
| Idioma del **agente** (respuestas del LLM) | `MNEMOSINE_LANG` > `./mnemosine.config.json` > `~/.mnemosine/config.json` > `'es'` (`config.ts:1119-1131`) | la persona que conversa | **usuario**: ya existe a nivel máquina/proyecto. Falta el nivel de persona autenticada (no hay tabla `users`; el sujeto es OIDC en `sujeto-activo.ts`) y el de inquilino (no hay tabla `tenants`; `tenant_id` es columna). |
| Idioma de la **UI del CLI** (ayuda, mensajes, etiquetas de tabla) | inglés fijo por decisión (`mnemosine.ts:2039`), con alias español biyectivo (`Arquitectura.md:122`); textos mezclados de hecho (ver §3) | la persona que teclea | **usuario > inquilino > sistema**: bandera global (el pedido pregunta por `--locale`; hoy no hay ninguna) > `MNEMOSINE_LANG`/`LANG` > config de usuario (`~/.mnemosine/config.json`) > config de proyecto > `'es'`. Requiere decidir si el ajuste de agente y el de UI son el mismo o dos. |
| Idioma de los **artefactos a terceros** (Anexo 24, DIOT, CFDI, 941, W-2, IDSE) | fijo por artefacto (español los del SAT, inglés los de EE. UU.) | la **jurisdicción fiscal** de la entidad | **entidad → jurisdicción**: `docs/jurisdicciones.md:135` ya lo propone (`informes.idioma`). No debe seguir a la preferencia del usuario. |
| **Formato** (símbolo y posición de moneda, decimales, DD/MM vs MM/DD, nombres de mes, orden alfabético, zona horaria) | es-MX fijo en tabla (`output.ts:162`), `en-US` fijo en 7 sitios, `$` fijo en `policy-preview.ts:27`, TZ del proceso | la **jurisdicción y la moneda** de la entidad (`jurisdiccion.ts:10-12,46-47,159`), nunca el idioma | **entidad**: derivación pura junto a `jurisdiccionDe` (p. ej. en `src/services/jurisdiccion/`, ya medido por cobertura), consumida por la rama `table` del kernel y por los textos del agente; `functional_currency` (`001:86`) para el símbolo del importe, `monedaLegal` para umbrales. La zona horaria no existe en el esquema: sería columna nueva de `legal_entities` (migración ≥ 075) o derivada de `incorporation_country`/`state_province`. |

Restricciones que cualquiera de esas opciones tiene que respetar y que el código ya defiende: (a) la vestimenta de locale sólo en `table` y en prosa, nunca en `json/csv/ndjson/tsv/md` (`presentation.spec.ts:10-14`); (b) nada de locale en lo persistido (la lección de `period_name`) ni en lo firmado (`catalogo-cuentas.ts:273-281`); (c) `es-MX` y `en-US` comparten separadores (`1,234.56`), así que la diferencia útil es símbolo/posición, fecha, nombres de mes y colación — no los miles; (d) los parsers bancarios ya llevan el formato en el **perfil** (`formatoFecha`, `separadorDecimal`), que es el modelo correcto: se declara, no se adivina.

Preguntas que sólo el dueño puede contestar: (1) ¿`period_name` se sigue persistiendo o se deriva y se rotula al mostrar? (2) ¿La UI del CLI se traduce, contradiciendo `mnemosine.ts:2039`, o se mantiene inglés + alias? (3) ¿Idioma del agente e idioma de UI son un solo ajuste (`lang`) o dos? (4) ¿Se corrige `functional_currency DEFAULT 'USD'` por migración? (5) ¿La zona horaria pasa a ser atributo de entidad? (6) ¿La DIOT deja `localeCompare` y ordena como el Anexo 24?

## 7. Resumen

En `src` no hay ni un `Intl.`; el formato vive en 8 `toLocaleString` con locale cableado (7 `en-US`, 1 `es-MX`), 13 `localeCompare`, 569 `toFixed` (decimal crudo, no locale), 2 separadores de miles a mano, 4 tablas de nombres de mes (una bilingüe para leer, una en español para mostrar, dos en inglés que se PERSISTEN en `fiscal_periods.period_name`) y 313 plurales a mano (304 `palabra(s)` + 9 ternarios). La única noción de idioma es la del AGENTE (`MNEMOSINE_LANG` > config de proyecto > config de usuario > `'es'`, `config.ts:1119-1131`), sin columna en el esquema (0 columnas `locale`/`language`/`timezone` en 74 migraciones, 0 tablas `tenants`/`users`) ni bandera global (`--locale` no existe), y el CLI declara explícitamente que su UI es inglesa con alias en español (`mnemosine.ts:2039`). El formato sigue hoy a México por omisión (tabla es-MX en `output.ts:162`, `DD/MM` y `MXN` en parsers) mientras el esquema dice `functional_currency DEFAULT 'USD'` (`001:86`); la única derivación jurisdicción→moneda es `jurisdiccion.ts:159`, y `docs/jurisdicciones.md:135` ya propone que el idioma de los informes viva en la jurisdicción. El acoplamiento externo de esta superficie es bajo (1 criterio, 1 hash de manifiesto, 1 umbral por archivo, 0 rutas en `LINEA_BASE`), pero el interno es alto: `period_name` es a la vez persistido, buscado por subcadena por el usuario y fijado por 34 líneas de tests, y el contrato «locale sólo en `table`» está escrito en `presentation.spec.ts:10-14`.
