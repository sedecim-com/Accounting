# Inventario de idioma — superficie: textos de usuario del CLI (`src/cli/`)

Fecha de la medición: 2026-09-06, rama `instrumentos-que-mienten-segun-la-maquina`, árbol limpio (`git status`), HEAD `25efb18`.
Raíz: `/Users/victor/projects/Accounting`. Sólo lectura: ningún archivo del repositorio fue modificado.

Anotación de método: durante la investigación otra sesión modificó `vitest.config.ts` en disco (sólo comentarios; los umbrales siguen siendo los seis de `src/services/**` y `src/utils/sequence.ts`, líneas 91-115 de la versión nueva). Se releyó y no cambia nada de lo afirmado abajo.

---

## 1. Método y comandos

### 1.1 Qué cuenta como «cadena de usuario»

Un literal de cadena (`'…'`, `"…"`, `` `…` `` con o sin interpolación) que llega a una persona por una de estas vías:

| clase | contexto sintáctico que la define |
|---|---|
| `descripcion_comando` | argumento 0 de `.description(…)` |
| `descripcion_opcion` | argumento 1 de `.option(…)` / `.requiredOption(…)` |
| `descripcion_argumento` | argumento 1 de `.argument(…)` |
| `ayuda_larga` | argumento 1 de `.addHelpText(…)` y todo template literal que contenga `Examples:` (los bloques `EJEMPLOS` que las familias registran vía `addHelpText`) |
| `salida_consola` | argumentos de `console.log/error/warn/info`, `process.stdout|stderr.write`, `out.write/err.write`, `print(…)`, y `X.push(…)` cuando `X` es un acumulador de líneas (`out`, `lines`, `lineas`, `reasons`…) |
| `error_cli` | argumento 0 de `new CliError`, `usageError`, `notFound`, `validationFailed`, `blockedByState`, `conflict`, `permissionDenied`, `externalFailed`, `externalRejected`, `abortedByUser`, `needsHuman`, `new InvalidArgumentError`, `new Error` |
| `prompt` | argumento 0 de `rl.question`, `askText`, `askSecret`, `confirm`, `preguntar`; argumento 1 de `confirmarConReintento` |
| `paleta` | argumento de `c.dim/bold/red/green/yellow/cyan(…)` cuando NO está dentro de otro contexto (si está dentro de un `console.log` cuenta como `salida_consola`, una sola vez) |
| `prosa_fuera_de_contexto` | literal con ≥ 3 palabras y un espacio que no cayó en ningún contexto anterior (tablas de mensajes, constantes, `writes:` de las declaraciones de riesgo, prosa pasada a helpers propios). Es el cajón menos fiable: incluye algún falso positivo (p. ej. un fragmento SQL en `audit-command.ts:373`) |

Se excluyen: especificaciones de bandera (`'-e, --entity <x>'`), nombres de comando/alias (`.command('x')`, `.alias('y')`), claves de propiedad, rutas de módulo, SQL, tipos literales. Los literales atravesados por `+`, ternarios, paréntesis, `.join/.trim/.padEnd` y llamadas a la paleta se siguen hasta el literal; cada literal se cuenta UNA vez.

### 1.2 Idioma

Heurística alineada con `fueraDeIdioma` de `scripts/ux-status.ts:314-330` (el instrumento que la casa ya usa): antes de puntuar se borra lo que es DATO y no prosa —`${…}`, lo entrecomillado, `<x>`, `[x]`, `--banderas`—; luego:

- marca de acento/eñe/¿¡«» → castellano (peso 2);
- partículas inequívocas de castellano (la lista de `ux-status.ts:299-303` más `de, del, que, para, por, se, es, al, sin, ya, …`; fuera `y`, `o`, `a`, `no`, `en`, `con`, `son`, `este`, `as` por ambiguas);
- partículas inglesas (`the, of, to, and, is, for, with, not, …`);
- si ninguna partícula aparece, desempate por morfología (`-ing/-ed/-tion/-ly` vs `-ando/-ado/-mente/-cion`).

Veredicto: `en` / `es` / `mixto` (marcas de los dos) / `indeterminado` (prosa sin marca decidible, p. ej. «Posted history stays intact.» no; «output format» sí) / `token` (una sola palabra: `✔`, `id`) / `pegamento` (sin palabras: `''`, `${x}`, `\n`). Los dos últimos NO son prosa y se separan de todos los porcentajes.

### 1.3 Comandos exactos

```
# Inventario y tamaño de la superficie
find src/cli -type f | sort                                  # 70 .ts + README.md
wc -l src/cli/*.ts src/cli/init/*.ts src/cli/kernel/*.ts     # 37 999 líneas

# Puntos de emisión por archivo (grep, apéndice A)
for f in src/cli/*.ts src/cli/init/*.ts src/cli/kernel/*.ts; do grep -c '\.description(' "$f"; grep -c '\.option(' "$f"; …; done

# Extractor AST (typescript de node_modules; fuente y salida junto a este informe)
node /tmp/investigacion-idioma/inventario/cli-extraer-cadenas-cli.cjs /Users/victor/projects/Accounting \
     --jsonl /tmp/investigacion-idioma/inventario/cli-cadenas.jsonl   # tabla: cli-extractor-salida.txt

# Censo de superficie de la casa (recorre el `program` real)
npm run -s ux:status -- --json > /tmp/investigacion-idioma/inventario/cli-ux-status.json

# Patrones que resisten extracción
grep -rnE "(===|!==|>) 1 \? ['\"]" src/cli --include='*.ts' | wc -l          # 5 (ternarios de plural; el AST cuenta 8 literales)
grep -rhoE "[a-záéíóú]+\((s|es|n)\)" src/cli --include='*.ts' | wc -l        # 272 «fila(s)», «estaba(n)»
grep -rn "toFixed(" src/cli --include='*.ts' | wc -l                          # 53
grep -rn "padStart(\|padEnd(" src/cli --include='*.ts' | wc -l               # 61
grep -rnE "['\"\`] \+$" src/cli --include='*.ts' | wc -l                      # 830 líneas que terminan en `' +`
grep -rn "toISOString()" src/cli --include='*.ts' | wc -l                     # 37
grep -rn "Intl\.\|toLocaleDateString\|toLocaleTimeString" src/cli --include='*.ts' | wc -l   # 0
grep -rn "toLocaleString" src/cli --include='*.ts'                            # 4 (todas 'en-US')
grep -rho "\brender(" src/cli --include='*.ts' | wc -l                        # 199 llamadas al render del kernel

# cli-reference.md
wc -l -c src/ai/docs/cli-reference.md                                         # 8 469 líneas, 398 877 bytes
grep -c '^#\{2,6\} `' src/ai/docs/cli-reference.md                            # 311 secciones (= nodos del árbol)
grep -n "[áéíóúñÁÉÍÓÚÑ¿¡]" src/ai/docs/cli-reference.md                        # 13 líneas
grep -c "display help for command" src/ai/docs/cli-reference.md               # 389 (texto de Commander, no del repo)
git log -1 --format='%h %ad' --date=short -- src/ai/docs/cli-reference.md     # 675b2a9 2026-09-03

# Pruebas que afirman texto literal
grep -rEo "toContain\(['\"\`][^'\"\`]* [^'\"\`]*['\"\`]\)" tests/cli | wc -l  # 139
grep -rEo "toThrow\(['\"\`/][^)]*\)" tests/cli | wc -l                        # 89
grep -rEo "toMatch\(/[^/]*( |\\s)[^/]*/" tests/cli | wc -l                    # 385
grep -rEo "toContain\(['\"\`][^'\"\`]* [^'\"\`]*['\"\`]\)|toMatch\(/[^/]* [^/]*/" tests/integration/*.int.spec.ts | wc -l   # 140
```

---

## 2. Conteos

### 2.1 Totales (extractor AST, `cli-extractor-salida.txt`)

| medida | cifra |
|---|---|
| literales en contexto de usuario | **5 348** |
| de ellos pegamento (`''`, `${x}`, saltos) | 1 267 |
| de ellos tokens sueltos (`✔`, `id`, `ok`) | 277 |
| **prosa** (en + es + mixto + indeterminado) | **3 804** |
| textos de prosa únicos (deduplicados por texto) | 3 479 |
| prosa en inglés | 2 451 (64 %) |
| prosa en castellano | 673 (18 %) |
| prosa mixta (las dos marcas en la misma cadena) | 255 (7 %) |
| prosa indeterminada | 425 (11 %) |

### 2.2 Por clase (prosa)

| clase | total | en | es | mixto | indet |
|---|---:|---:|---:|---:|---:|
| salida_consola | 1 218 | 642 | 333 | 103 | 140 |
| descripcion_opcion | 722 | 599 | 3 | 0 | 120 |
| prosa_fuera_de_contexto | 580 | 258 | 172 | 49 | 101 |
| error_cli | 514 | 266 | 147 | 92 | 9 |
| descripcion_comando | 337 | 327 | 2 | 2 | 6 |
| ayuda_larga | 201 | 196 | 0 | 5 | 0 |
| descripcion_argumento | 137 | 113 | 1 | 0 | 23 |
| paleta | 60 | 35 | 12 | 2 | 11 |
| prompt | 35 | 15 | 3 | 2 | 15 |

Agrupando por lo que ve el usuario:

- **Ayuda (`--help`)** = descripciones de comando + opción + argumento + bloques `Examples:` = **1 397** cadenas: 1 235 en, **6 es**, 7 mixto, 149 indeterminado. Entre las decidibles, 99,0 % inglés. Las 6 castellanas: `src/cli/ai-command.ts:52` y `:71` (descripciones de `ai` y `ai stats`), `src/cli/cfdi-command.ts:145` (`--direction`) y `:211` (`--refresh`), `src/cli/account-command.ts:747` (`<file>` de `account map import`), `src/cli/entry-command.ts:832` (`--layout`, mixta). Coincide exactamente con los 7 nodos que el censo de la casa reporta en `nodos-fuera-del-idioma-canonico` (`ux-status.json`; el séptimo es `batch check`, `src/cli/batch-command.ts`, por el valor de bandera `cuenta`). Las 5 mixtas de `ayuda_larga` son ejemplos con datos mexicanos dentro de prosa inglesa («The children of Caja y Bancos», `account-command.ts:117`), que es la convención declarada en los propios archivos («prosa en inglés (idioma del nodo), datos mexicanos», p. ej. `src/cli/mnemosine.ts:683-687`).
- **Ejecución** (lo que imprime un comando al correr: salida, errores, paleta suelta, prompts) = **1 827** cadenas: 958 en, **495 es**, 199 mixto, 175 indeterminado. Entre las decidibles, **30 % castellano y 12 % mixto**.
- **Fuera de contexto** = 580 (258 en / 172 es).

Esto es la cifra que cambia el diagnóstico respecto a la auditoría del 1 de septiembre (`docs/auditorias/2026-09-01-usabilidad/ux-idioma.md:426`: «de 403 llamadas de impresión, cero llevan texto en español»). Las familias fusionadas los días 1-3 de septiembre (`git log --diff-filter=A`: `bank-command.ts` d7aca3f 2026-09-01, `backup-command.ts` ed551ac 2026-09-01, `prepaid`, `e-accounting`, `diot`, `depreciation`, `batch`, `audit` 2026-09-02) escriben su salida de ejecución en castellano mientras su ayuda sigue en inglés. Hoy el CLI no está «en inglés con fugas»: está en inglés en la ayuda y bilingüe por familia en la ejecución.

### 2.3 Por archivo (prosa; ordenado por castellano)

| archivo | prosa | en | es | mixto | indet | % es |
|---|---:|---:|---:|---:|---:|---:|
| bank-command.ts | 651 | 294 | 246 | 54 | 57 | 38 % |
| prepaid-command.ts | 114 | 31 | 49 | 28 | 6 | 43 % |
| batch-command.ts | 83 | 18 | 43 | 12 | 10 | 52 % |
| e-accounting-command.ts | 86 | 23 | 39 | 20 | 4 | 45 % |
| bill-command.ts | 161 | 98 | 31 | 21 | 11 | 19 % |
| account-command.ts | 132 | 85 | 30 | 5 | 12 | 23 % |
| diot-command.ts | 77 | 28 | 28 | 17 | 4 | 36 % |
| depreciation-command.ts | 53 | 13 | 26 | 14 | 0 | 49 % |
| backup-command.ts | 70 | 24 | 23 | 16 | 7 | 33 % |
| fx-command.ts | 60 | 25 | 17 | 6 | 12 | 28 % |
| ai-command.ts | 16 | 0 | 15 | 1 | 0 | 94 % |
| audit-command.ts | 44 | 17 | 15 | 7 | 5 | 34 % |
| kernel/riesgos-retrofit.ts | 17 | 0 | 15 | 1 | 1 | 88 % |
| cfdi-command.ts | 32 | 15 | 11 | 2 | 4 | 34 % |
| cashflow-reconcile-command.ts | 20 | 7 | 10 | 3 | 0 | 50 % |
| mnemosine.ts | 328 | 275 | 10 | 16 | 27 | 3 % |
| payment-command.ts | 58 | 43 | 10 | 2 | 3 | 17 % |
| payroll-isn-command.ts | 137 | 123 | 9 | 3 | 2 | 7 % |
| asset-command.ts | 39 | 25 | 8 | 6 | 0 | 21 % |
| entry-command.ts | 122 | 101 | 6 | 2 | 13 | 5 % |
| ledger-command.ts | 33 | 22 | 6 | 2 | 3 | 18 % |
| period-command.ts | 68 | 49 | 5 | 3 | 11 | 7 % |
| rep-command.ts | 15 | 8 | 5 | 2 | 0 | 33 % |
| cashflow-command.ts | 37 | 26 | 4 | 6 | 1 | 11 % |
| receipt-command.ts | 84 | 68 | 3 | 1 | 12 | 4 % |
| ap-command.ts | 22 | 17 | 2 | 1 | 2 | 9 % |
| kernel/risk.ts | 17 | 14 | 2 | 1 | 0 | 12 % |
| sat-commands.ts | 68 | 49 | 2 | 0 | 17 | 3 % |
| close / jobs / webhook-sweep | 30 / 37 / 25 | 25 / 29 / 21 | 1 / 1 / 1 | 0 | 4 / 7 / 3 | 3-4 % |
| **34 archivos restantes** (approvals, ar, banner, closing, compact, completion, credit-note, customer, doctor, entity, first-run, init-command, init/s0-s5, invoice, kernel/audit, confirmacion, entity-context, flags, output, memory, pending, prompt-size, report, skills, status, usage, vendor, webhooks) | 1 176 | 1 003 | 0 | 2 | 171 | 0 % |

La tabla completa (70 archivos, con pegamento, tokens, interpolación y concatenación por archivo) está en `cli-extractor-salida.txt`.

**24 archivos mezclan dentro de sí ayuda en inglés y ejecución en castellano** (cálculo sobre `cadenas.jsonl`): los más nítidos son `bank-command.ts` (233 descripciones en inglés; 180 cadenas de ejecución en castellano contra 16 en inglés), `prepaid-command.ts` (24 / 43 vs 1), `e-accounting-command.ts` (16 / 29 vs 0), `depreciation-command.ts` (9 / 24 vs 0), `batch-command.ts` (14 / 30 vs 0), `diot-command.ts` (10 / 22 vs 2), `backup-command.ts` (19 / 20 vs 4), `audit-command.ts` (12 / 12 vs 0). El mismo comando enseña en inglés y contesta en castellano.

### 2.4 El censo de la casa (`npm run ux:status -- --json`)

229 hojas, 311 nodos. `nodos-fuera-del-idioma-canonico` = 7 (línea base 7, `scripts/ux-status.ts:214`), los 7 enumerados en §2.2. El censo mide SÓLO la ayuda (`prosaDe`, `ux-status.ts:465-479`: descripción, opciones, argumentos): la ejecución no entra en ninguna de sus seis medidas, y por eso 495 cadenas castellanas de ejecución pasan la puerta de CI (`.github/workflows/ci.yml:176`) en verde. `hojas-sin-alias-castellano` = 17 (`chat`, `doctor`, `approvals *`, `jobs *`, `skills *`, y `memory correct/restore` y `close` con alias distinto del vocabulario).

### 2.5 Patrones que resisten la extracción a un catálogo (cifras sobre las 3 804 cadenas de prosa)

| patrón | cifra | ejemplos (archivo:línea) |
|---|---:|---|
| cadena con interpolación `${…}` | 1 065 | `kernel/output.ts:318`, `bank-command.ts:1919` |
| cadena construida con `+` (una frase partida en varios literales, a veces a media cláusula) | 1 091 literales; 830 líneas terminan en `' +` | `bank-command.ts:409-410` («…0 para» / «ninguna. Llegó…»), `asset-command.ts:197-198`, `kernel/risk.ts:96-100`, `kernel/entity-context.ts:146-148` |
| plural a mano con `(s)`/`(n)` | 203 cadenas (272 apariciones en el fuente) | `bank-command.ts:1919` «fila(s)», `:2630` «${r.importadas} nueva(s), ${r.duplicadas} ya estaba(n)», `ap-command.ts:259` «partida(s)» |
| plural por ternario `=== 1 ? 'x' : 'xs'` (sólo inglés) | 8 literales / 5 líneas | `banner.ts:53-55`, `mnemosine.ts:1312`, `init/s5-import.ts:447`; helper `plural()` en `pending-command.ts:61` sólo con dos formas |
| `Intl.PluralRules` / `Intl.NumberFormat` / `Intl.DateTimeFormat` | **0** en `src/cli` | — |
| número o importe interpolado sin formato de locale | 219 cadenas | `usage-command.ts:71-72` (`toLocaleString('en-US')`, `$${n.toFixed(4)}`), `compact-command.ts:83`, `prompt-size-command.ts:103`, `approvals-command.ts:158-159`, `report-command.ts:108` (`money()` = `toFixed(4)`), 53 `toFixed(` |
| dinero de presentación cableado | `kernel/output.ts:144-179` `formatMoneyMx`: agrupación con `,` y dos decimales, por cadena y BigInt; el comentario lo llama «es-MX de presentación» pero el formato es idéntico al en-US (`12,458,930.55`) | 9 llamadas fuera del kernel |
| fechas | `kernel/output.ts:109-118` `dateOnly` → `yyyy-mm-dd` (neutro, correcto); 37 `toISOString()` en las hojas, 0 `toLocaleDateString` | `approvals-command.ts:103` |
| alineación manual con anchos fijos | 61 `padStart/padEnd` | `status-command.ts:301-305` (etiquetas de 19 columnas), `banner.ts:86` (`labelWidth = 9 // longest label ('provider'/'language') + 1` — «proveedor» mide 9, «idioma» cabe, «pendientes» no) |
| prosa que incrusta una invocación `mnemosine …` (no se traduce) | 273 cadenas; 26 con remedio `→` | `kernel/entity-context.ts:147` «→ mnemosine doctor (and check DATABASE_URL in .env)» |
| teclas de menú ligadas a palabras inglesas | `mnemosine.ts:1416` `REVIEW_MENU` «[a]pprove and post [e]dit then approve [r]eject ENTER next [q]uit»; `README.md:129` | traducir el texto sin cambiar las teclas rompe la mnemotecnia; cambiarlas rompe guiones |
| prompts `[y/N]` como sufijo cableado | 7 archivos: `backup-command.ts:125`, `bank-command.ts:1974`, `batch-command.ts:252`, `bill-command.ts:409`, `credit-note-command.ts:181`, `depreciation-command.ts:342`, `e-accounting-command.ts:411` | la gramática ya es bilingüe (`kernel/confirmacion.ts:35-36`: y/yes/s/si); el sufijo no |
| encabezado de tabla = clave del JSON | `kernel/output.ts:208` (`header = cols…`), `:238` (markdown); claves como `account_code`, `debit_total` en `report-command.ts:338-342`; `--fields` valida contra esas mismas claves (`output.ts:79-95`) | no hay separación etiqueta/clave en `RenderOptions` (`output.ts:37-55`) |
| texto usado como CLAVE de un trinquete | `kernel/audit.ts:197-237` `LINEA_BASE`: 36 entradas cuya clave incluye el `detail` inglés («"entities" is a top-level command…»); `claveDeViolacion` `audit.ts:187-195` | traducir o reescribir esos mensajes deja las 36 como «nuevas» y la puerta (`src/ai/doctor-service.ts:420`, `src/plan/criterios.ts:2840`) se pone roja |
| cromo de Commander (no está en el repo) | «Usage:», «Options:», «Commands:», «Arguments:», «display help for command» (×389 en cli-reference.md), «output the version number», «error: unknown command…», «(Did you mean …?)», «too many arguments for 'chat'» | `node_modules/commander/lib/command.js:712, 1445`; versión 15.0.0; `tests/cli/raiz-y-remedios.spec.ts:138` afirma «Did you mean report?» |

---

## 3. Cómo se renderiza la salida y dónde se enchufa un catálogo

### 3.1 El contrato de salida (`src/cli/kernel/`)

- `output.ts:5-27` — tres audiencias, una implementación: tabla alineada para humanos (color sólo en TTY, `palette.ts:22-33`, respeta `NO_COLOR`), `--quiet`/`csv`/`tsv`/`ndjson` para tuberías, `--format json` con sobre versionado (`SCHEMA_VERSION = 1`, `output.ts:33`; `{schema, count, total?, truncated?, rows}` `output.ts:277-286`). Datos a stdout; toda nota a stderr (`output.ts:25-26`).
- `render(rows, opts)` `output.ts:248-308` es la ÚNICA función de tabla: 199 llamadas en 33 archivos (`grep -rho "\brender("`). Las hojas que no pasan por ella imprimen a mano con `console.log`/`stderr.write` (25 `stderr.write` en `mnemosine.ts`, 48 en `bank-command.ts`, 164 `console.log` en `mnemosine.ts`; apéndice A).
- Prosa PROPIA del kernel (lo que el usuario lee sin que ninguna hoja lo escriba): `output.ts:63` (formato desconocido), `:90` (campos desconocidos), `:297` («No rows.»), `:318` («Showing N of M rows…»); `flags.ts:472, 481` (validación de `--limit/--offset/--since/--until/--as-of`); `entity-context.ts:146-148, 153-155, 201-202`; `risk.ts:96-107` (arranque), `:136-147` (descripciones inyectadas de `--dry-run/--yes/--idempotency-key/--live/--reason`), `:194-196` (**en castellano**, «pide una compuerta de mutación sin haber declarado su riesgo»), `:207, :213`; `exit.ts:98` (`'Aborted.'` por omisión); `confirmacion.ts:64` (`noEntendi`, **en castellano**); las 20 descripciones de banderas del diccionario `flags.ts:490-573`. En total unas 45 cadenas: **el primer tramo natural de un catálogo, porque las 229 hojas las heredan**.
- `withOutput` `flags.ts:454-461` declara `--format/--json/-o/--fields/-q` en toda hoja de lectura; `withReadFlags` `flags.ts:576-578` compone contexto + tiempo + selección + salida.
- Errores: un solo embudo. `CliError` (`exit.ts:56-67`) lleva `message`, `exitCode` y `detail`; `reportError` (`mnemosine.ts:291-323`) imprime `message` en rojo a stderr y, si no es `CliError`, añade el remedio de `remedioParaMensaje`; `exitCodeFor` (`kernel/index.ts:111-116`) mapea a los trece códigos. **`detail` no llega a ningún sitio**: `grep "\.detail\b"` en `src/cli/mnemosine.ts src/cli/kernel/*.ts` → sólo `exit.ts:65` (asignación) y `audit.ts:194` (otro `detail`). No existe un sobre JSON de error: con `--json` un fallo sigue saliendo como texto en stderr. Commander pasa por la misma puerta vía `exitOverride` (`mnemosine.ts:676-678`), pero SU texto («error: unknown command») ya salió por stderr antes (`mnemosine.ts:665-668`).
- Idioma: `resolveLanguage()` (`src/ai/providers/config.ts:1119-1131`) es síncrona y sin base: `MNEMOSINE_LANG` > `language` de `mnemosine.config.json` > `'es'`. Hoy su único consumidor de conducta es el prompt del agente (`LANGUAGE_LINE`, `src/ai/system-prompt.ts`, citado en `ux-idioma.md:806-813`); el CLI sólo la MUESTRA (`mnemosine.ts:1066` en el banner, `:2045` en `lang`, `status-command.ts:253,305`). La política está escrita en la propia ayuda (`mnemosine.ts:2039`: «CLI UI stays English; Spanish command aliases always work») y en `src/cli/README.md:396-414` y `config.ts:1117-1118`.
- Alias: el vocabulario cerrado `kernel/vocabulary.ts:22-115` (77 verbos, biyección inglés→castellano) y `OBJECTLESS_COMMANDS`/`LEGACY_PLURALS` `:133-147`; los sustantivos se alían hoja por hoja (`tests/cli/bilingual-matrix.spec.ts:25-205`). Esto es la i18n de NOMBRES, ya hecha; no existe i18n de TEXTO.

### 3.2 Dónde enchufar un catálogo sin romper el contrato

1. **Resolver el idioma antes de registrar el árbol.** Las descripciones son cadenas en el momento de `.command().description()` (`mnemosine.ts:818-826` y el registro de familias `:3026-3063`), es decir al importar el módulo y ANTES de `parseAsync`. Un `--lang` de línea de comandos llega tarde para la ayuda; `MNEMOSINE_LANG`/config sí llegan a tiempo porque `resolveLanguage` es síncrona y no toca la base (`NO_DB_COMMANDS`, `mnemosine.ts:832`, ya protege a `lang` de la conexión). Nada obliga a añadir una bandera: la precedencia existe.
2. **Alternativa que deja el inglés como fuente sin resolver nada al importar**: `program.configureHelp({ subcommandDescription, optionDescription, argumentDescription, commandDescription })` (`node_modules/commander/typings/index.d.ts:235-248`) traduce en el momento de RENDERIZAR la ayuda usando la cadena inglesa de `.description()` como clave. Ventaja: `scripts/ux-status.ts` y `generate-cli-reference.ts` siguen midiendo/reproduciendo la fuente; el `--help` en castellano es una vista. Hoy `configureHelp` no se usa (`grep configureHelp src/cli` → 0). Para el cromo de Commander: `helpOption(flags, description)` (`index.d.ts:1059`), `helpCommand(name, description)` (`:527`), `.version(str, flags, description)`, `configureOutput({ outputError })` (`:357`) para reescribir sus líneas de error; `showSuggestionAfterError` (`:609`) para el «Did you mean».
3. **`render()`**: añadir a `RenderOptions` (`output.ts:37-55`) un `labels?: Record<string,string>` que SÓLO usen `toTable` (`:191-212`) y `toMarkdown` (`:225-242`); `json/ndjson/csv/tsv` y `--fields` siguen con las claves. Es la brecha 5 de la auditoría (`ux-idioma.md:327-369`) y no toca el sobre.
4. **Inyección por familia**: cada `registerXCommand(program, { palette: c, shutdown, reportError })` (`mnemosine.ts:3026-3063`) ya recibe sus dependencias; un `t` (traductor) entra por la misma costura sin importar nada global. `doctor-command.ts:9-13` y `status-command.ts:289-293` muestran el patrón (`DoctorCliDeps`, `StatusDeps`).
5. **Errores**: hacer que `CliError` lleve `code` + parámetros y que `reportError` resuelva el texto por locale es lo limpio, pero hoy 613 sitios construyen el mensaje en el `throw`; el catálogo por familia (punto 4) es lo que no obliga a reescribir el embudo. Si se añade un sobre JSON de error, el sitio es `reportError` y el campo `detail` que ya existe y nadie lee.
6. **Prompts**: `confirmarConReintento` (`confirmacion.ts:79-91`) es la única costura de la repregunta; el sufijo `[y/N]` está repetido en 7 hojas (§2.5) y debería salir de la misma función que ya sabe qué respuestas acepta.
7. **cli-reference.md**: el generador fija el ancho a 80 columnas para que el documento no dependa de la terminal de quien lo corre (`ANCHO_CANONICO`, `scripts/generate-cli-reference.ts:33-44`); con ayuda localizable tiene que fijar el idioma de la misma manera (fuente = inglés) o el documento que lee el agente cambiará según el `.env` de quien regenere.

### 3.3 `src/ai/docs/cli-reference.md`: en qué idioma sale

Generado del `program` real (`scripts/generate-cli-reference.ts:1-14, 198-208`; regenerado por última vez en 675b2a9, 2026-09-03). 311 secciones = 311 nodos. Sale **en inglés**, en tres capas:

1. cromo de Commander: «Usage:» ×311, «Options:» ×311, «Commands:» ×82, «Arguments:» ×123, «display help for command» ×389 (`cli-reference.md:26, 93`), «output the version number» ×1 — ninguna vive en el repo;
2. descripciones y ejemplos del repo, en inglés salvo las **5 líneas castellanas que la ayuda arrastra**: `:1621` (`account map import <file>`), `:2022` (`entry import --layout`, mixta), `:7903` (`cfdi status show --refresh`), `:8055` (`ai`), `:8071` (`ai stats`); las otras 8 líneas con marca de acento son datos (alias `enseña` `:753`, «Equipo de Cómputo» `:5588`, «Buzón Tributario» `:6392, 6450`);
3. la cabecera fija (`generate-cli-reference.ts:16-30`) le dice al agente «Spanish aliases (shown as `name|alias`) are equivalent to the English names; use whichever matches the user's language», y 290 renglones muestran `name|alias`.

`tests/ai/cli-reference.spec.ts:37-49` sólo exige que toda hoja aparezca por NOMBRE; `tests/docs/generador-de-referencia.spec.ts` prueba el generador sobre un árbol de juguete. Ninguna prueba compara el texto del documento con el binario.

---

## 4. Ejemplos con archivo:línea y clase

| archivo:línea | texto | clase | idioma |
|---|---|---|---|
| `src/cli/mnemosine.ts:2039` | «Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)» | texto_de_usuario_renderizado | en |
| `src/cli/mnemosine.ts:820-826` | «AI accounting assistant — converse with your accounting from the terminal» / «Tenant to operate on (or MNEMOSINE_TENANT). Scopes EVERY query via RLS» | texto_de_usuario_renderizado | en |
| `src/cli/ai-command.ts:52` | «Métricas y calibración del agente contable» (descripción de familia; sale en `cli-reference.md:8055`) | texto_de_usuario_renderizado | es |
| `src/cli/entry-command.ts:832` | «file layout: ${…} (contpaqi/aspel/iif/sat-polizas: aún sin parser)» | texto_de_usuario_renderizado | mixto |
| `src/cli/bank-command.ts:1919-1920` | «Se listaron ${obtenidas} fila(s), que es el tope de --limit: puede haber más.» + «Sube --limit, o usa --all en `${comando}`.» (stderr; plural «(s)», interpolación, bandera incrustada) | texto_de_usuario_renderizado | es |
| `src/cli/bank-command.ts:2189` | «Ensayo: el alta se ejecutó de verdad —índice único incluido— y se deshizo. Nada quedó escrito.» (`--dry-run`) | texto_de_usuario_renderizado | es |
| `src/cli/bank-command.ts:409-410` | «${flag} va entre 0 y 1, no en porcentaje: 0.16 para el 16%, 0.0125 para el 1.25%, 0 para» + «ninguna. Llegó "${valor}".» (frase partida en dos literales) | texto_de_usuario_renderizado | es |
| `src/cli/kernel/risk.ts:194-196` | «"${cmd.name()}" pide una compuerta de mutación sin haber declarado su riesgo. Toda hoja que muta declara con `declareRisk`…» (único error castellano del kernel) | texto_de_usuario_renderizado | es |
| `src/cli/kernel/entity-context.ts:146-148` | «Could not reach the database while resolving the active entity (${stored}): ${detalle}\n  → mnemosine doctor   (and check DATABASE_URL in .env)\nThe pinned entity was kept.» (remedio con comando incrustado) | texto_de_usuario_renderizado | en |
| `src/cli/kernel/output.ts:318` | «Showing ${shown} of ${total} rows. Raise --limit, page with --offset, or use --all to see the rest.» | texto_de_usuario_renderizado | en |
| `src/cli/kernel/output.ts:208` + `src/cli/report-command.ts:338-342` | encabezado de tabla = `account_code`, `debit_total`, `credit_total`, `ending_balance` (claves del JSON impresas como etiquetas) | identificador | en |
| `src/cli/kernel/output.ts:162-179` | `formatMoneyMx`: «12,458,930.55» — agrupación y decimales cableados, sin `Intl` | formato_locale | — |
| `src/cli/usage-command.ts:71-72` | `n.toLocaleString('en-US')`; `` `$${n.toFixed(4)}` `` | formato_locale | en |
| `src/cli/report-command.ts:108-111` | `money()` → `new Decimal(value).toFixed(4)` (presentación a cuatro decimales) | formato_locale | — |
| `src/cli/kernel/output.ts:109-118` | `dateOnly` → `yyyy-mm-dd` (neutro) | formato_locale | — |
| `src/cli/banner.ts:53-55` | «${p.drafts} ${p.drafts === 1 ? 'draft' : 'drafts'}» (plural por ternario) | texto_de_usuario_renderizado | en |
| `src/cli/mnemosine.ts:1416` | «[a]pprove and post  [e]dit then approve  [r]eject  ENTER next  [q]uit >» (teclas = iniciales inglesas) | texto_de_usuario_renderizado | en |
| `src/cli/kernel/confirmacion.ts:64` | «no entendí «${respuesta}»: responde y/s para sí, n para no» | texto_de_usuario_renderizado | mixto |
| `src/cli/backup-command.ts:125` | «${question} [y/N]» (sufijo repetido en 7 hojas) | texto_de_usuario_renderizado | en |
| `src/cli/init/s1-identity.ts:91-101` | «  Legal entity name: », «  Country [MX/USA] (MX): » (asistente `init`, íntegramente en inglés) | texto_de_usuario_renderizado | en |
| `src/cli/mnemosine.ts:1246-1251` | `/help` y `/ayuda` imprimen «Ask about your accounting in natural language. Examples:…» mientras el agente contesta en `es` por omisión (`config.ts:1130`) | texto_de_usuario_renderizado | en |
| `src/cli/doctor-command.ts:18, 31-35` | «Mnemosine health check», «There are failures that prevent operation…»; los nombres y remedios de cada chequeo vienen de fuera de la superficie: `src/ai/doctor-service.ts:94-177` («Database», «Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)») | texto_de_usuario_renderizado | en |
| `src/cli/pending-command.ts:397` + `src/services/policy/pending-catalog.ts:279-282` | «✔ ${key} = ${chosen}» donde `chosen` es el VALOR persistido (`'preguntar'`) y la etiqueta («Ask case by case») está en inglés; el catálogo de políticas pregunta en inglés (`pending-catalog.ts:52`) | texto_persistido (valor) / texto_de_usuario_renderizado (etiqueta) | mixto |
| `src/cli/kernel/vocabulary.ts:22-115` | `'post': 'contabilizar'`, `'reverse': 'reversar'`… (la biyección de verbos; la única capa de traducción que existe) | dato_vocabulario | mixto |
| `src/cli/kernel/audit.ts:198-236` | `'entities|R1 objectless allowlist|"entities" is a top-level command with no object…'` (el texto inglés del detalle ES la clave de la línea base) | dato_vocabulario | en |
| `src/cli/kernel/riesgos-retrofit.ts:80-113` | `writes: 'ai_sessions, ai_messages; y por sus herramientas: ai_drafts…'` (castellano; sin consumidor: `grep "\.writes\b" src` → 0) | dato_vocabulario | es |
| `src/ai/docs/cli-reference.md:26` | «-h, --help   display help for command» (cromo de Commander, publicado al agente como «la superficie exacta del binario») | texto_emitido_a_tercero | en |
| `src/ai/docs/cli-reference.md:8055` | «Métricas y calibración del agente contable» (la fuga castellana llega al documento del agente) | texto_emitido_a_tercero | es |
| `src/cli/kernel/confirmacion.ts`, `src/cli/kernel/riesgos-retrofit.ts` | nombres de archivo en castellano dentro de un árbol con nombres ingleses (`exit.ts`, `flags.ts`, `output.ts`…) | nombre_de_archivo | es |
| `src/cli/kernel/audit.ts:187, 255`, `riesgos-retrofit.ts:147`, `confirmacion.ts:42, 52, 79`, `entity-context.ts:100` | `claveDeViolacion`, `auditarContraLineaBase`, `declararPendientes`, `esAfirmativa`, `esNegativa`, `confirmarConReintento`, `esFalloDeConexion`, `LINEA_BASE`, `RIESGOS_RETROFIT` (identificadores castellanos exportados y consumidos fuera del kernel: `doctor-service.ts:420`, `criterios.ts:2840, 2966`) | identificador | es |
| `src/cli/kernel/output.ts:5-27` vs `:97-107, 134-142` | cabecera de sección en inglés («OUTPUT CONTRACT») y doc-comments castellanos en el mismo archivo | comentario | mixto |
| `src/cli/mnemosine.ts:683-687` | «prosa en el idioma del nodo —estas hojas están en inglés— y datos mexicanos de verdad» (la convención de idioma, escrita 19 veces como comentario: `grep -rn "idioma del nodo" src/cli`) | comentario | es |

---

## 5. Qué se rompe al cambiar (acoplamientos, con archivo:línea)

1. **El trinquete de idioma canónico**: `scripts/ux-status.ts:214` (`'nodos-fuera-del-idioma-canonico': 7`), detector `fueraDeIdioma` `:299-330` sobre la ayuda RENDERIZADA, puerta `npx tsx scripts/ux-status.ts --check` en `.github/workflows/ci.yml:176` y `tests/cli/censo-superficie.spec.ts`. Si la ayuda se traduce al castellano en el render, el censo cuenta 300+ nodos y CI falla; si se traduce en la fuente, la fuente deja de ser inglesa (contrario al pedido). Hay que decidir contra QUÉ mide (la fuente inglesa, no la vista) antes de tocar una cadena.
2. **La matriz bilingüe**: `tests/cli/bilingual-matrix.spec.ts:230-247` exige nombres canónicos ingleses (compatible con el pedido) y `:207-212` `SPANISH_LEFTOVERS` (`/\(opcional\)/`, `/Solo muestra/`…) sobre `--help` de la raíz, `memory`, `pending`, `sat cred`, `entity`, `account` (`:221-228`): una ayuda localizada la pone en rojo.
3. **Pruebas que afirman texto**: 47 de 41+ archivos en `tests/cli` (139 `toContain` con prosa, 89 `toThrow` con texto, 385 `toMatch` con prosa) y 140 aserciones en `tests/integration/*.int.spec.ts` (3 archivos corren el binario). Ejemplos: `tests/cli/report-command.spec.ts:291` (`/Total due 12528\.0000 across 6 open bill\(s\)/`), `close-command.spec.ts:49, 59` («Ready to close.», «Cannot close yet»), `pending-capa-explicativa.spec.ts:394-395` («Of your 12 received invoices:»), `raiz-y-remedios.spec.ts:138` («Did you mean report?», que es texto de Commander), `first-run.spec.ts:86`. Cada cadena que pase a catálogo tiene su aserción.
4. **La línea base de la auditoría R12**: `src/cli/kernel/audit.ts:197-237` usa el texto inglés del `detail` como clave (`claveDeViolacion`, `:187-195`); la consume `src/ai/doctor-service.ts:420-421` y `src/plan/criterios.ts:2840-2842`, y la prueba `tests/cli/kernel/auditoria-programa.spec.ts`. Cambiar la redacción de un mensaje de `auditProgram` (`audit.ts:62-147`) invalida entradas de la línea base.
5. **Rutas fijadas por nombre**: `src/plan/criterios.ts` referencia `src/cli` 42 veces (`codigoDe('src/cli/mnemosine.ts')` ×9, `bank-command.ts` ×4, `entry-command.ts`, `report-command.ts`, `usage-command.ts`, `ai-command.ts`, `completion-command.ts`, `bill-command.ts`, `memory-command.ts`, `pending-command.ts`, `init/s5-import.ts`, `kernel/riesgos-retrofit.ts:2966`) y `readdirSync(rutaDe('src/cli'))` `:6279`; con mutantes anclados a líneas exactas: `:6234` (`tax-amount=2000.00` en un ejemplo de `bill-command.ts`), `:6307` (`out.push(...wrapLines('   ', '   ', p.question))` en `pending-command.ts`), `:4281` (`.command('assign')`), `:2240, 4529, 4590, 5398, 5492` (`registerXCommand(program, { palette: c, shutdown, reportError })`), `:6269` (`deps.shutdown(exitCodeFor(err))`). Renombrar archivos, identificadores o reescribir esas líneas al extraer texto rompe `npm run plan:status -- --piso --exigir=…` (`ci.yml:145`). `src/ai/docs/manifiesto.json` sella por hash `src/cli/entry-command.ts` (manual `accounting.md`) y `src/cli/bank-command.ts` (`banking.md`); `scripts/corpus-manifiesto.ts --check` (`ci.yml:158`) sale 1 si el hash cambió (`corpus-manifiesto.ts:19, 82-87, 173`): CUALQUIER edición de cadenas en esos dos archivos obliga a releer el manual y resellar. `vitest.config.ts:91-115` no lleva umbral sobre `src/cli` (verificado en la versión que cambió en disco durante esta medición): renombrar archivos del CLI NO descoloca la cobertura, pero sí los criterios y el manifiesto.
6. **El documento del agente**: `src/ai/docs/cli-reference.md` se regenera a mano (`scripts/generate-cli-reference.ts:9`) y `tests/ai/cli-reference.spec.ts:37-49` exige que toda hoja aparezca; el generador reproduce lo que `--help` imprime (`ayudaCompleta`, `:92-109`) con ancho fijo pero SIN idioma fijo: si la ayuda depende de `MNEMOSINE_LANG`, el documento cambia según el entorno de quien regenera y el agente (que lo lee como «la superficie exacta», cabecera `:16-30`) vería un idioma u otro. `src/ai/tools/docs-tools.ts` (`DOC_TOPICS`) lo publica.
7. **Encabezados = claves**: `output.ts:208, 238` y la validación de `--fields` `output.ts:79-95`; `--fields` es vocabulario tecleado por el usuario y por el agente (`--fields` desnudo lista las claves, `:254-257`). Traducir las claves rompe `--json/--csv/--fields` y los guiones; traducir sólo etiquetas exige la separación que `RenderOptions` no tiene.
8. **Commander**: sus 6 títulos y sus mensajes de error no están en el repo; sin `configureHelp/helpOption/helpCommand/configureOutput` (§3.2.2) seguirán en inglés en un `--help` castellano, y `tests/cli/raiz-y-remedios.spec.ts:138` afirma uno de ellos.
9. **Gramática de confirmación**: `kernel/confirmacion.ts:35-36` acepta y/yes/s/si en cualquier idioma y `tests/cli/confirmacion-gramatica.spec.ts` censa que ningún predicado nuevo aparezca fuera del kernel; un prompt localizado que imprima `[s/N]` debe seguir aceptando `y`, y al revés.
10. **Valores persistidos que el CLI imprime**: las opciones del panel (`pending-catalog.ts:279` `value: 'preguntar'`) son valores en `policy_decisions` y salen por pantalla en `pending-command.ts:397`; las categorías de `batch check --check` (`parse, forma, cuenta, periodo, validacion`, `batch-command.ts`) y los valores de `cfdi list --direction` (`emitido, recibido, ajeno`, `cfdi-command.ts:145`) son valores que el usuario teclea. No se traducen; sólo su etiqueta.
11. **Textos que la superficie renderiza pero no posee**: `src/ai/doctor-service.ts:94-177` (nombres y remedios de `doctor`), `src/services/policy/pending-catalog.ts` y `policy-preview.ts` (preguntas, impacto, etiquetas de `pending`), los mensajes de `AppError` de los servicios que `exitCodeFor` mapea (`kernel/index.ts:85-104`) y los de `pg` («role "postgres" does not exist», `ux-idioma.md:513-542`). Un catálogo del CLI no los alcanza: son de otras superficies.
12. **Documentación que cita texto**: `src/cli/README.md:387-414` (declara «CLI chrome — always English»), `docs/auditorias/2026-09-01-usabilidad/ux-idioma.md` (15 brechas con archivo:línea que se desplazan), 90 archivos de `docs/` y README citan invocaciones `mnemosine …` (nombres, no texto), `docs/cli-command-registry.md` (vinculante para nombres y biyección de verbos, `:1-30`), `docs/cli-command-catalog.md` (+ `scripts/catalogo-estado.ts --check`, `ci.yml:153`, sólo nombres).

---

## 6. Dependencias (quién referencia esta superficie por nombre o ruta)

- `scripts/ux-status.ts` (LINEAS_BASE `:210-217`, `fueraDeIdioma` `:314-330`) · `tests/cli/censo-superficie.spec.ts` · `.github/workflows/ci.yml:176`
- `tests/cli/bilingual-matrix.spec.ts` (`TOP_LEVEL` `:25-134`, `SUBCOMMANDS` `:136-201`, `SAT_CRED` `:203-205`, `SPANISH_LEFTOVERS` `:208-212`)
- `tests/cli/*.spec.ts` (41 entradas; 47 archivos con aserciones de texto) · `tests/cli/kernel/{auditoria-programa,consistency,entity-context,output,presentation,riesgo-cobertura}.spec.ts` · `tests/cli/init/*.spec.ts` · `tests/cli/confirmacion-gramatica.spec.ts` · `tests/cli/ejemplos-de-ayuda.spec.ts` · `tests/cli/codigos-de-salida{,-hojas}.spec.ts`
- `tests/integration/*.int.spec.ts` (19 importan `src/cli`; 3 ejecutan el binario; 140 aserciones de texto)
- `src/cli/kernel/audit.ts` `LINEA_BASE` `:197-237` → `src/ai/doctor-service.ts:420` · `src/plan/criterios.ts:2840`
- `src/plan/criterios.ts` (42 referencias a `src/cli`; mutantes en `:2240, 4281, 4529, 4590, 5398, 5492, 5639, 5696, 6155, 6234, 6269, 6307`) · `.github/workflows/ci.yml:145`
- `src/ai/docs/manifiesto.json` (`hashes`: `src/cli/entry-command.ts`, `src/cli/bank-command.ts`; `manuales.accounting.md`, `manuales.banking.md`) · `scripts/corpus-manifiesto.ts --check` · `ci.yml:158`
- `src/ai/docs/cli-reference.md` · `scripts/generate-cli-reference.ts` · `tests/ai/cli-reference.spec.ts` · `tests/docs/generador-de-referencia.spec.ts` · `src/ai/tools/docs-tools.ts` (`DOC_TOPICS`) · `tests/ai/system-prompt.spec.ts`, `tests/ai/tools/docs-tools.spec.ts`
- `src/ai/providers/config.ts:596-597` (esquema `language`), `:1113-1146` (`resolveLanguage`, `setLanguage`; comentario «CLI/UI text is always English») · `src/ai/system-prompt.ts` (`LANGUAGE_LINE`)
- `src/cli/README.md:387-414` (política de idioma) · `docs/cli-command-registry.md` · `docs/cli-command-catalog.md` · `scripts/catalogo-estado.ts` (`ci.yml:153`)
- `docs/auditorias/2026-09-01-usabilidad/ux-idioma.md` (brechas 1-15; 5 = etiqueta/clave, 7 = errores bilingües, 9 = ancho con acentos, 13 = `/ayuda`) · `ux-errores.md:394`, `flujos-reales.md:698`, `ux-descubribilidad.md:136`, `flujos-comparados.md:346`
- `node_modules/commander` 15.0.0 (`lib/command.js`, `lib/help.js`, `typings/index.d.ts:235-248, 357, 527, 609, 1059`)
- Fuera de la superficie pero renderizados por ella: `src/ai/doctor-service.ts`, `src/services/policy/pending-catalog.ts`, `src/services/policy/policy-preview.ts`, `src/utils/errors.ts` (`AppError.statusCode` → `kernel/index.ts:93-104`)
- Recurso ya existente para un glosario ES↔EN: `docs/wiki/Glosario.md` (47 entradas, según `ux-idioma.md:17-36`)

---

## 7. Resumen

La superficie de usuario del CLI tiene 3 804 cadenas de prosa (3 479 únicas) en 70 archivos y 37 999 líneas: la AYUDA está en inglés en un 99 % (1 397 cadenas, 6 en castellano, las mismas 7 pantallas que el censo `ux:status` ya registra), pero la EJECUCIÓN es bilingüe por familia —de 1 827 cadenas de salida/error/prompt, 495 (30 % de las decidibles) están en castellano y 199 son mixtas, concentradas en las familias fusionadas los días 1-3 de septiembre (`bank` 246, `prepaid` 49, `batch` 43, `e-accounting` 39, `bill` 31, `account` 30, `diot` 28, `depreciation` 26, `backup` 23)— de modo que 24 archivos enseñan en inglés y contestan en castellano, y ninguna puerta lo mide porque `ux:status` sólo censa la ayuda. El kernel (`src/cli/kernel/`) es la costura correcta para un catálogo: un solo `render()` con 199 llamadas y un sobre JSON versionado, un solo embudo de errores (`CliError` → `reportError`) cuyo `detail` nadie lee, un resolutor de idioma síncrono y sin base (`resolveLanguage`, hoy sólo usado por el agente) y unas 45 cadenas propias que las 229 hojas heredan; y Commander 15 ofrece `configureHelp/helpOption/helpCommand/configureOutput` para traducir la ayuda y su cromo en el render sin tocar la fuente inglesa. Resisten la extracción 1 091 literales concatenados con `+` (frases partidas a media cláusula), 1 065 con interpolación, 203 plurales «(s)/(n)» y 8 por ternario, 219 números sin `Intl` (0 usos de `Intl` en `src/cli`; `formatMoneyMx` y `toLocaleString('en-US')` cableados), 61 alineaciones con anchos fijos, los encabezados que son claves del JSON (`output.ts:208`) y el texto usado como clave de trinquete (`audit.ts:197-237`). Lo que un plan debe decidir antes de mover una cadena: contra qué mide `nodos-fuera-del-idioma-canonico` (fuente inglesa o vista renderizada), cómo se fija el idioma en `generate-cli-reference.ts`, que 613 aserciones de prueba (473 en `tests/cli`, 140 en integración) nombran texto literal, y que `entry-command.ts` y `bank-command.ts` están sellados por hash en el manifiesto del agente.

---

## Apéndice A — puntos de emisión por archivo (`grep -c`)

Columnas: `.description(` · `.option(` · `.argument(` · `.addHelpText(` · `console.log(` · `console.error(` · `stderr.write(` · constructores de `CliError` y helpers · prompts (`rl.question|askText|askSecret|confirm|preguntar|confirmar*`).

```
archivo                              descr   opt   arg  help   log   err  werr clierr prompt
account-command.ts                      19    36    14    15     0     0     6    12     0
ai-command.ts                            2     0     0     0     0     0     2     0     0
ap-command.ts                            2     2     0     1     0     0     1     1     0
approvals-command.ts                     4    15     0     0     7     0     0     3     0
ar-command.ts                            3     3     0     2     0     0     1     0     0
asset-command.ts                         2    21     1     1     0     0     0     6     0
audit-command.ts                         3     8     1     2     0     0     2    10     0
backup-command.ts                        6    12     2     0     0     0     3     8     3
bank-command.ts                         44   142    30    32     0     0    48    48     3
batch-command.ts                         6     7     4     5     0     0     7     6     3
bill-command.ts                         10    34     6     8     0     0    19    43     3
cashflow-command.ts                      2     2     0     1     0     0     2     3     0
cashflow-reconcile-command.ts            1     1     0     1     0     0     2     1     0
cfdi-command.ts                          7     5     3     5     0     0     3     1     0
close-command.ts                         1     9     0     1    12     2     0     1     4
closing-command.ts                       4     4     2     3     0     0     1     4     0
compact-command.ts                       1     5     0     0     3     0     0     0     0
completion-command.ts                    1     0     1     1     0     0     0     2     0
credit-note-command.ts                   6    15     3     5     0     0     3     8     3
customer-command.ts                     11    29     7     9     0     0     2    10     0
depreciation-command.ts                  3     6     0     2     0     0     7     6     3
diot-command.ts                          4     6     0     5     0     0     1     8     0
doctor-command.ts                        1     1     0     0     2     0     0     0     0
e-accounting-command.ts                  6    12     0     4     0     0     2     7     4
entity-command.ts                        7     4     4     0     0     0     9     3     0
entry-command.ts                        14    27     9    12     0     0     8    21     3
fx-command.ts                            6    14     5     4     0     0     3     8     0
init-command.ts                          1    11     0     0    32     1     0     0     4
invoice-command.ts                      11    23     6     9     0     0     3    28     3
jobs-command.ts                          7     6     2     0    17     0     1     0     0
ledger-command.ts                        8     8     0     4     0     0     3     2     0
memory-command.ts                        5    11     6     0    16     0     0     0     0
mnemosine.ts                            21    41     6    17   164    14    25    13    12
payment-command.ts                       3    16     2     2     0     0     8     9     3
payroll-isn-command.ts                   7    17     2     4     0     0     2    26     3
pending-command.ts                       4    10     4     0    17     0     0     1     0
period-command.ts                        9     5     5     7     0     0     3     9     2
prepaid-command.ts                       5    18     2     4     0     0     7    13     3
prompt-size-command.ts                   1     3     0     0     2     0     0     0     0
receipt-command.ts                       7    15     5     6     0     0     7     7     3
rep-command.ts                           4     4     0     0     0     0     3     1     0
report-command.ts                       14     5     0     7     0     0     2     4     0
sat-commands.ts                          6     9     0     0    19     5     4     1     1
skills-command.ts                        4     9     1     0    27     0     0     1     1
status-command.ts                        1     4     0     0     2     0     0     0     0
usage-command.ts                         1     5     0     0     2     0     0     4     0
vendor-command.ts                        7    23     5     5     0     0     4     8     0
webhook-sweep-command.ts                 2     4     0     1     8     0     1     0     0
webhooks-command.ts                      5    12     0     0    22     0     0     2     0
init/s0-infra.ts … s5-import.ts          0     0     0     0     0     0     0     0   2-6
kernel/confirmacion.ts                   0     0     0     0     0     0     0     0     3
kernel/entity-context.ts                 0     0     0     0     0     0     0     3     0
kernel/exit.ts                           0     0     0     0     0     0     0    10     0
kernel/flags.ts                          0    20     0     0     0     0     0     0     0
kernel/output.ts                         0     0     0     0     0     0     0     2     0
kernel/risk.ts                           0     1     0     0     0     0     0     3     0
(banner, first-run, palette, init/index, init/section, kernel/audit, index, riesgos-retrofit, vocabulary: 0 en todas)
```

## Apéndice B — archivos adjuntos en este directorio (prefijo `cli-`; el directorio es compartido con otras superficies)

- `cli-extraer-cadenas-cli.cjs` — el extractor (Node 22 + `typescript` del repo); sólo lee.
- `cli-cadenas.jsonl` — las 5 348 cadenas con `archivo`, `linea`, `clase`, `idioma`, `interpolada`, `concatenada`, `plural_manual`, `texto`.
- `cli-extractor-salida.txt` — la tabla por archivo y por clase tal como la imprimió el extractor.
- `cli-ux-status.json` — el censo de superficie de la casa en la fecha de la medición.

## Apéndice C — texto persistido desde `src/cli`

`grep -rn "INSERT INTO\|UPDATE [a-z_]* SET" src/cli --include='*.ts'` → 3 líneas: un comentario (`asset-command.ts:38`) y dos INSERT reales, `init/s2-users.ts:116` (`users`: datos que teclea el operador) y `payroll-isn-command.ts:996` (`mx_isn_tasas_estatales`: tasas y fundamentos que teclea el operador). Ninguna cadena de prosa generada por el CLI viaja a la base desde esta superficie; los textos persistidos que sí pasan por ella son del usuario (`--reason`, `--note`, `resolution_notes`) o valores de vocabulario (`policy_decisions`, §5.10). Los nombres de periodo acuñados en inglés («January 2026») los persiste `src/services/accounting/fiscal-calendar-service.ts:504-507`, fuera de esta superficie (brecha 6 de `ux-idioma.md:373-401`).
