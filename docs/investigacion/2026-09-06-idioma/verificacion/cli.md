# Verificación escéptica — superficie «cli»

Informe verificado: `/tmp/investigacion-idioma/inventario/cli.md`.
Árbol: `/Users/victor/projects/Accounting`. Sólo lectura: ningún archivo del repo fue modificado.

**Advertencia de estado del árbol.** El informe dice «HEAD `25efb18`, árbol limpio». Al verificar, `git rev-parse --short HEAD` = `b31e62a` (tres merges después: `c01d79a`, `b31e62a`, `70a4aef`) y el árbol está sucio (otra sesión editó `src/ai/doctor-service.ts`, `vitest.config.ts` y otros). `git diff --stat 25efb18 HEAD -- src/cli` → **vacío**: `src/cli` no cambió, así que los conteos sobre `src/cli` siguen comparables. Pero `src/plan/criterios.ts` creció 88 líneas (todas al final, `@@ -6535`, por eso sus líneas citadas siguen exactas) y `src/ai/doctor-service.ts` tiene 21 líneas añadidas SIN comprometer: el informe cita `doctor-service.ts:420` y `:94-177`, que son las líneas del árbol sucio; en `25efb18` y en HEAD la llamada está en `:399-400` (`git show HEAD:src/ai/doctor-service.ts | grep -n auditarContraLineaBase`). El informe midió, al menos en parte, sobre el árbol de trabajo de otra sesión.

---

## 1. Conteos del informe, re-corridos

| # | cifra del informe | comando que corrí | resultado | veredicto |
|---|---|---|---|---|
| 1 | 70 `.ts` + README en `src/cli` | `find src/cli -type f \| wc -l` / `-name '*.ts'` | 71 / 70 | sostiene |
| 2 | 37 999 líneas | `wc -l src/cli/*.ts src/cli/init/*.ts src/cli/kernel/*.ts \| tail -1` | 37 999 | sostiene |
| 3 | 5 ternarios de plural | `grep -rnE "(===\|!==\|>) 1 \? ['\"]" src/cli --include='*.ts' \| wc -l` | 5 | sostiene |
| 4 | 272 «fila(s)» | `grep -rhoE "[a-záéíóú]+\((s\|es\|n)\)" src/cli --include='*.ts' \| wc -l` | 272 | sostiene |
| 5 | 53 `toFixed(` | `grep -rn "toFixed(" src/cli --include='*.ts' \| wc -l` | 53 | sostiene |
| 6 | 61 `padStart/padEnd` | `grep -rn "padStart(\|padEnd(" src/cli --include='*.ts' \| wc -l` | 61 | sostiene |
| 7 | 830 líneas que terminan en `' +` | `grep -rnE "['\"\`] \+$" src/cli --include='*.ts' \| wc -l` | 830 | sostiene |
| 8 | 37 `toISOString()` | `grep -rn "toISOString()" src/cli --include='*.ts' \| wc -l` | 37 | sostiene |
| 9 | 0 `Intl.` | `grep -rn "Intl\.\|toLocaleDateString\|toLocaleTimeString" src/cli --include='*.ts' \| wc -l` | 0 | sostiene |
| 10 | «4 `toLocaleString` (todas 'en-US')» | `grep -rn "toLocaleString" src/cli --include='*.ts'` | **5 líneas** (usage:71, compact:83, approvals:158, approvals:159, prompt-size:103), todas `'en-US'` | **refutado** (4 → 5) |
| 11 | 199 llamadas a `render(` en 33 archivos | `grep -rho "\brender(" src/cli --include='*.ts' \| wc -l` / `grep -rl … \| wc -l` | 199 / **34** archivos | cifra sostiene; archivos 33 → 34 |
| 12 | cli-reference.md 8 469 líneas / 398 877 bytes / 311 secciones / 389 «display help» / 675b2a9 2026-09-03 | `wc -l -c`, `grep -c '^#\{2,6\} \`'`, `grep -c "display help for command"`, `git log -1 --format='%h %ad' --date=short --` | 8 469 / 398 877 / 311 / 389 / 675b2a9 2026-09-03 | sostiene |
| 13 | 13 líneas con acento en cli-reference.md; «5 castellanas de la ayuda + 8 datos» | `grep -n "[áéíóúñÁÉÍÓÚÑ¿¡]" src/ai/docs/cli-reference.md` | 13 líneas, pero **7 son prosa castellana de la ayuda** (`:84` «ai\|ia  Métricas y calibración…», `:1621`, `:2022`, `:7903`, `:8055`, `:8061` «stats\|estadisticas  Aprobación por bucket…», `:8071`) y **6 son datos** (`:747, :753, :756` alias `enseña`; `:5588` «Equipo de Cómputo»; `:6392, :6450` «Buzón Tributario») | **refutado** (5+8 → 7+6): el informe olvidó que la descripción castellana de `ai` y `ai stats` sale DOS veces, en la lista del padre y en la sección propia |
| 14 | «Usage:» ×311, «Options:» ×311, «Commands:» ×82, «Arguments:» ×123, «output the version number» ×1, 290 `name\|alias` | `grep -c '^Usage:'` etc.; `grep -cE '^\s+[a-z-]+\|[a-záéíóúñ-]+'` | 311 / 311 / 82 / 123 / 1 / 290 | sostiene |
| 15 | 139 `toContain` con prosa en tests/cli | `grep -rEo "toContain\(['\"\`][^'\"\`]* [^'\"\`]*['\"\`]\)" tests/cli \| wc -l` | 139 | sostiene |
| 16 | 89 `toThrow` con texto | `grep -rEo "toThrow\(['\"\`/][^)]*\)" tests/cli \| wc -l` | 89 | sostiene |
| 17 | 385 `toMatch` con prosa | `grep -rEo 'toMatch\(/[^/]*( \|\\s)[^/]*/' tests/cli \| wc -l` | 385 (con `\s`; sin la alternativa `\s` da 364 — en zsh la cadena del informe entre comillas dobles se degrada a 364; el conteo es sensible a cómo se escapa) | sostiene con reserva |
| 18 | 140 aserciones en `tests/integration/*.int.spec.ts` | comando del informe | 140 | sostiene |
| 19 | «47 de 41+ archivos en tests/cli» con aserciones de texto | `grep -rlE "<los 3 patrones>" tests/cli \| wc -l`; `find tests/cli -name '*.spec.ts' \| wc -l`; `ls tests/cli \| wc -l` | **43** archivos con aserciones de texto, de **48** spec (41 entradas en `ls`, 2 son directorios) | **refutado** (47 → 43; y «47 de 41» era aritméticamente imposible) |
| 20 | «19 [archivos de integración] importan `src/cli`» | `grep -lE "from ['\"][^'\"]*cli[^'\"]*['\"]" tests/integration/*.int.spec.ts \| wc -l`; `grep -lE "src/cli\|/cli/" … \| wc -l` | **7** importan de `src/cli` (8 imports: `kernel/exit.js` ×2, `webhook-sweep`, `report`, `payroll-isn`, `palette`, `kernel/index`, `diot`, `cashflow-reconcile`); 10 si se cuenta cualquier mención de `src/cli` | **refutado** (19 → 7); no encontré ningún comando que dé 19 |
| 21 | 3 archivos de integración ejecutan el binario | `grep -lE "spawn\|execa\|execFile\|execSync\|dist/cli\|mnemosine\.ts" tests/integration/*.int.spec.ts` | 3 (`g4a-ataque`, `plan-conducta-mutacion`, `s4a-ataque`) | sostiene |
| 22 | criterios.ts referencia `src/cli` 42 veces; `codigoDe('src/cli/mnemosine.ts')` ×9 | `grep -c "src/cli" src/plan/criterios.ts`; `grep -c "codigoDe('src/cli/mnemosine.ts')"` | 42 / **12** | 42 sostiene; ×9 → **×12 refutado** |
| 23 | mutantes en criterios `:2240, 2840, 2966, 4281, 4529, 4590, 5398, 5492, 5639, 5696, 6155, 6234, 6269, 6279, 6307` | `sed -n "${l}p" src/plan/criterios.ts` para cada uno | los 15 exactos en HEAD `b31e62a` (el crecimiento de 88 líneas está después de 6535) | sostiene |
| 24 | `LINEA_BASE` 36 entradas, `audit.ts:197-237`, `claveDeViolacion :187-195` | `awk 'NR>=197 && NR<=237' src/cli/kernel/audit.ts \| grep -c "^\s*'"`; `sed -n 187,197p` | 36; `claveDeViolacion` empieza en 187 y `LINEA_BASE` en 197 | sostiene |
| 25 | «LINEA_BASE → doctor-service.ts:420» | `grep -n "LINEA_BASE\|auditarContraLineaBase" src/ai/doctor-service.ts`; ídem con `git show HEAD:` y `git show 25efb18:` | doctor-service NO importa `LINEA_BASE`, importa `auditarContraLineaBase` (que la usa por dentro); línea **399** en HEAD y en 25efb18, 420 sólo en el árbol sucio | **refutado en la línea**, correcto en el fondo |
| 26 | `ux-status.ts:214` línea base 7; `:299-303` partículas; `:314-330` `fueraDeIdioma`; `:465-479` `prosaDe` | `sed -n` de cada rango | exactos | sostiene |
| 27 | `ci.yml:145` plan:status, `:153` catalogo, `:158` corpus-manifiesto, `:176` ux-status | `sed -n '145p;153p;158p;176p' .github/workflows/ci.yml` | exactos | sostiene |
| 28 | manifiesto sella `entry-command.ts` (accounting.md) y `bank-command.ts` (banking.md) | `node -e` sobre `manifiesto.json` | exacto; ningún otro archivo de `src/cli` está sellado | sostiene |
| 29 | vitest sin umbral sobre `src/cli`; umbrales en `:91-115` | `grep -n "src/" vitest.config.ts` | los 6 umbrales por archivo son de `src/services/**` y `src/utils/sequence.ts` (líneas 92-113 del archivo sucio); ninguno en `src/cli` | sostiene |
| 30 | censo: 229 hojas, 311 nodos, 7 fuera de idioma (las 7 listadas), 17 sin alias | `node -e` sobre `cli-ux-status.json` | 229 / 311 / 7 (`account map import`, `entry import`, `batch check`, `cfdi list`, `cfdi status show`, `ai`, `ai stats`) / 17 | sostiene |
| 31 | vocabulario: «77 verbos» | `npx tsx -e "import('./src/cli/kernel/vocabulary.ts').then(m=>console.log(Object.keys(m.VERBS).length))"` | **79** (y `OBJECTLESS_COMMANDS` 18, `LEGACY_PLURALS` 9) | **refutado** (77 → 79) |
| 32 | `[y/N]` como sufijo cableado en «7 archivos» | `grep -rn "\[y/N\]" src/cli --include='*.ts'` | el patrón `${question\|pregunta} [y/N]` está en **13 hojas** (receipt, prepaid, entry, bill, invoice, e-accounting, batch, bank, payment, backup, payroll-isn, depreciation, credit-note) y hay otros 6 prompts con `[y/N]` cableado en prosa (`period:497`, `close:94`, `mnemosine:1586, 1712, 2137, 2340`): **16 archivos** de código | **refutado** (7 → 16) |
| 33 | «idioma del nodo» escrito 19 veces | `grep -rn "idioma del nodo" src/cli \| wc -l` | **21** | **refutado** (19 → 21) |
| 34 | `grep configureHelp src/cli` → 0; `\.detail\b` sólo `exit.ts:65` y `audit.ts:194`; `\.writes\b` en src → 0 | los tres comandos | 0; `.detail` además en `mnemosine.ts:1852, 2010` (otro `detail`, de resultados de ingesta, no de `CliError`); 0 | sostiene (con la salvedad del `.detail` homónimo) |
| 35 | Commander 15.0.0; `index.d.ts:235-248, 357, 527, 609, 1059`; `command.js:712, 1445` | `node -p require('./node_modules/commander/package.json').version`; `sed -n` | 15.0.0; todas exactas | sostiene |
| 36 | fechas de alta de las familias (`git log --diff-filter=A`) | mismo comando por archivo | bank d7aca3f 09-01, backup ed551ac 09-01, prepaid/e-accounting/diot/depreciation/batch/audit 09-02 | sostiene |
| 37 | apéndice A (`grep -c` por archivo) | `grep -c '\.description('` etc. en bank, mnemosine, skills, init, bill | bank 44/142/30/32/0/48, mnemosine 21/41/6/17/164/25, skills 4/9/1/0/27/0, init 1/11/0/0/32/0, bill 10/34/6/8/0/19 | sostiene (5 filas muestreadas) |
| 38 | «13 códigos de salida»; `exitCodeFor` en `kernel/index.ts:111-116`; `STATUS_TO_EXIT :93-104` | `awk '/export const ExitCode/,/\}/' src/cli/kernel/exit.ts \| grep -cE "^\s+[A-Z_]+:"`; `sed -n` | 13; exactos | sostiene |
| 39 | «20 descripciones de banderas del diccionario `flags.ts:490-573`» | `sed -n '490,573p' src/cli/kernel/flags.ts \| grep -c "\.option("` | 20 `.option(`; pero el diccionario de verdad (`FLAG_DICTIONARY`, `flags.ts:34`) tiene **43** entradas, y 490-573 son las funciones `withContext/withTime/…`, no el diccionario | cifra sostiene, etiqueta inexacta |
| 40 | `withOutput` en `flags.ts:454-461`; `withReadFlags :576-578` | `grep -n "export function withOutput\|withReadFlags"` | `withOutput` está en **:520** (454 es un comentario); `withReadFlags` en :577 | **refutado** la primera |
| 41 | `palette.ts:22-33` bajo «`src/cli/kernel/`» | `ls src/cli/kernel/` | no existe `kernel/palette.ts`; es `src/cli/palette.ts:22-33` (líneas correctas) | ruta inexacta |
| 42 | `reportError` `mnemosine.ts:291-323` | `awk` hasta la primera `}` | 291-**317** | inexacto (menor) |
| 43 | «The children of Caja y Bancos» en `account-command.ts:117` | `grep -n "Caja y Bancos" src/cli/account-command.ts` | `:121` (117 es la apertura del template) | inexacto (menor) |
| 44 | Commander ya escribió a stderr: `mnemosine.ts:665-668` | `sed -n 660,680p` | el comentario que lo dice es `:661-664`; `exitOverride` :676-678 exacto | inexacto (menor) |

### 1.1 Recomputo del extractor desde `cli-cadenas.jsonl`

`node -e` sobre las 5 348 filas del jsonl (script en §5):

- total 5 348; idioma `{en 2451, es 673, mixto 255, indeterminado 425, token 277, pegamento 1267}`; prosa 3 804; únicos 3 479 — **sostienen**.
- interpolada 1 065; concatenada 1 091; plural manual (regex `[a-záéíóú]+\((s|es|n)\)` sobre el texto) 203 — **sostienen**. (El campo `plural_manual` del jsonl sólo marca 2 filas; la cifra 203 sale de la regex, no del campo.)
- ayuda 1 397 `{en 1235, es 6, mixto 7, indet 149}`; ejecución 1 827 `{en 958, es 495, mixto 199, indet 175}` — **sostienen**; las 6 castellanas son exactamente `account-command.ts:747`, `ai-command.ts:52, 71`, `cfdi-command.ts:145, 211`, `entry-command.ts:832` — **sostienen**.
- tabla por clase (§2.2) — las 9 filas **sostienen** al dígito.
- «24 archivos mezclan ayuda en inglés y ejecución en castellano» — 24 **sostiene** con la definición «≥1 descripción en inglés y ≥1 cadena de ejecución en castellano», pero esa definición mete `mnemosine.ts` (5 castellanas vs 184 inglesas), `payroll-isn` (4 vs 86), `period` (1 vs 26) y `entry` (4 vs 36): en 8 de los 24 el castellano es residual (<10 %). Los 8 pares que el informe da como ejemplo (bank 233/180 vs 16, prepaid 24/43 vs 1, …) **sostienen** al dígito.
- «273 cadenas incrustan `mnemosine …`; 26 con remedio →» — 274 con `/\bmnemosine\s+\S/`; 26 cadenas llevan `→`, pero **sólo 4** llevan `→` Y una invocación en la misma cadena. La frase del informe se lee como «26 de las 273», y eso no es lo que hay.
- «219 números interpolados sin formato de locale» — **no reproducible**: el jsonl no tiene campo para eso y el informe no da comando. Mi aproximación (`${…}` cuyo nombre contiene total/count/length/importe/monto/amount/saldo/balance/sum/cantidad/num) da 549. Cifra sin método: no la doy por buena.

### 1.2 Muestra de archivo:línea

**Muestra A — 30 filas del jsonl** (una cada ⌊3804/30⌋ filas de prosa, determinista): se comprobó que la primera palabra ≥4 letras del texto está en esa línea del fuente. **30/30 exactas** (0 «cerca», 0 fallos). El extractor anota bien la línea.

**Muestra B — 30 citas del cuerpo del informe** (§3-§5, tabla §4), verificadas con `sed -n`:

| cita | veredicto |
|---|---|
| `mnemosine.ts:2039` «Shows or sets the language…» | exacta |
| `ai-command.ts:52`, `:71` | exactas |
| `entry-command.ts:832` `--layout … aún sin parser` | exacta |
| `bank-command.ts:1919-1920`, `:2189`, `:409-410`, `:2630` | exactas |
| `kernel/risk.ts:194-196` | exacta |
| `kernel/entity-context.ts:146-148` | exacta |
| `kernel/output.ts:318`, `:208`, `:238`, `:63`, `:90`, `:297`, `:254`, `:277`, `:33`, `:109-118`, `:162` | exactas |
| `report-command.ts:338-342` claves `beginning_balance`…; `:108-111` `money()` | exactas |
| `usage-command.ts:71-72` | exacta |
| `banner.ts:53-55`, `:86` | exactas |
| `mnemosine.ts:1416` `REVIEW_MENU` | exacta |
| `kernel/confirmacion.ts:35-36`, `:64`, `:42`, `:52`, `:79` | exactas |
| `backup-command.ts:125` | exacta |
| `init/s1-identity.ts:91-101` | exacta (91 «Legal entity name», 96 «Country [MX/USA] (MX)») |
| `mnemosine.ts:1246-1251` `/help` `/ayuda` | exacta |
| `doctor-command.ts:18, 31-35` | exacta |
| `doctor-service.ts:94-177`, `:420` | **inexacta**: líneas del árbol sucio; en HEAD son ~73-156 y 399 |
| `pending-command.ts:397`, `:61`; `pending-catalog.ts:52, 279-282` | exactas |
| `audit.ts:198`, `:255`; `riesgos-retrofit.ts:80-113`, `:147`; `entity-context.ts:100` | exactas |
| `mnemosine.ts:683-687` «prosa en el idioma del nodo» | exacta |
| `audit-command.ts:373` (falso positivo SQL reconocido) | exacta |
| `cfdi-command.ts:145, 211`; `account-command.ts:747` | exactas |
| `account-command.ts:117` «Caja y Bancos» | **inexacta** (es :121) |
| `asset-command.ts:197-198`; `ap-command.ts:259`; `init/s5-import.ts:447`; `mnemosine.ts:1312` | exactas |
| `status-command.ts:253, 301-305`; `mnemosine.ts:1066, 2045, 832, 3026-3063, 676-678` | exactas |
| `mnemosine.ts:665-668` | **inexacta** (comentario en 661-664) |
| `kernel/flags.ts:472, 481, 490, 573, 576-578` | exactas; `:454-461` como `withOutput` **inexacta** (es :520) |
| `kernel/exit.ts:56, 98`; `kernel/risk.ts:136, 207, 213`; `kernel/index.ts:85-104, 111-116` | exactas |
| `palette.ts:22-33` | líneas exactas, **ruta inexacta** (no está en `kernel/`) |
| tests: `report-command.spec.ts:291`, `close-command.spec.ts:49, 59`, `pending-capa-explicativa.spec.ts:394-395`, `raiz-y-remedios.spec.ts:138`, `first-run.spec.ts:86`, `bilingual-matrix.spec.ts:25, 136, 203, 207-212, 221-228, 230-247`, `cli-reference.spec.ts:37-49` | exactas |
| scripts/docs: `generate-cli-reference.ts:9, 16-30, 33-44, 92-109, 198-208`; `corpus-manifiesto.ts:19, 82-87, 173`; `README.md:129, 387-414`; `ux-idioma.md:17, 327, 426, 513, 806`; `config.ts:596-597, 1117-1131`; `system-prompt.ts` `LANGUAGE_LINE` (:171) | exactas |

Balance de la muestra B: de ~30 grupos de citas, **25 exactos, 5 inexactos** (`doctor-service.ts` ×2 por árbol sucio, `account-command.ts:117`, `mnemosine.ts:665-668`, `flags.ts:454-461`) y 1 ruta equivocada (`kernel/palette.ts`). Ninguno de los inexactos cambia una conclusión; el de `doctor-service.ts` sí revela que se midió en un árbol que no era el de HEAD.

---

## 2. Lo que el informe no vio

### 2.1 Etiquetas de tarjetas «show» que el extractor descartó (≈95 cadenas de usuario fuera del inventario)

El extractor sólo recoge literales fuera de contexto conocido si tienen **≥ 3 palabras** (`cli-extraer-cadenas-cli.cjs:235-242`), y su lista de emisores (`:65`) no incluye los helpers locales que las hojas definen para pintar fichas: `fact(label, value)` (`receipt-command.ts:360`, `customer-command.ts:344, 612`, `invoice-command.ts:436`, `credit-note-command.ts:284`), `linea(etiqueta, valor)` (`bank-command.ts:2277, 2780, 3022`, `diot-command.ts:549`, `ap-command.ts:193`, `ar-command.ts:124`), `renglon(etiqueta, valor)` (`bank-command.ts:3747, 4842, 5616`), `renglonDeAsiento` (`bank-command.ts:5203`), `agregar(seccion, concepto…)` (`bank-command.ts:986`), `field(label, text)` (`pending-command.ts:153`), `row(label…)` (`prompt-size-command.ts:104`).

Comando (AST con el `typescript` del repo, script en §5): literales de 1-2 palabras como primer argumento de esos helpers **sin fila en el jsonl** → **95** (bank 41, customer 13, invoice 10, credit-note 9, receipt 7, diot 4, cashflow 2, prompt-size 2, pending 2, ap 2, ar 2, usage 1; ≈83 inglesas —«Date», «Method», «Email», «Credit limit», «RFC», «UsoCFDI»—, ≈12 castellanas —`linea('exento', …)` `diot-command.ts:556`…). Son texto que el usuario lee en cada `customer show`, `invoice show`, `receipt show`, `bank … show`, y no están en las 3 804. Además, el mismo filtro deja fuera cualquier etiqueta de 1-2 palabras pasada a `console.log`/`out.push` cuando el literal es una sola palabra («token», 277 separadas) — coherente con el método, pero conviene saber que las **etiquetas cortas** (la mayoría de las columnas y fichas) no están en ningún porcentaje del informe.

### 2.2 El extractor cuenta como «prosa castellana» 33 textos que nadie lee

De las 172 castellanas de `prosa_fuera_de_contexto`, **32** viven en líneas `writes:` de `declareRisk(...)`/`RIESGOS_RETROFIT` (comando: filas cuya línea del fuente casa `/writes\s*:/` → 65 filas: 14 en, 32 es, 1 mixto, 18 indet). El propio informe dice que `writes` no tiene consumidor (`grep "\.writes\b" src` → 0, verificado). Es decir: **el 5 % de las 673 castellanas es metadato sin salida**, y el informe lo suma al «castellano» sin descontarlo. Corregido: prosa castellana que llega al usuario ≈ 641 (673 − 32), y `prosa_fuera_de_contexto` es 140 es / 244 en sobre 515.

### 2.3 Los errores de los servicios que el CLI imprime tal cual (no cuantificados)

El informe lo menciona (§5.11) sin cifra. `grep -rhoE "throw new [A-Za-z]+Error\(\s*[\`'\"]" src/services src/utils --include='*.ts' | wc -l` → **305** sitios de lanzamiento con mensaje literal; **46** líneas llevan acento/eñe, **63** llevan partícula inglesa (`the|not|is|for|must|cannot|already`); el resto, indecidible por línea. Todos llegan a `reportError` (`mnemosine.ts:291-317`, que imprime `err.message` en rojo sin más) vía `exitCodeFor` (`kernel/index.ts:93-104`). Un catálogo del CLI no los alcanza y son la parte bilingüe que ninguna de las 3 804 cadenas mide.

### 2.4 Pruebas que afirman cromo de Commander: no es una, son tres

`grep -rn "unknown command\|Did you mean\|too many arguments\|Usage:" tests/cli --include='*.ts'`: además de `raiz-y-remedios.spec.ts:138` («Did you mean report?»), `:131` («unknown command 'balanza'»), `:144, :151` (negadas) y **`bilingual-matrix.spec.ts:306`** (`/Usage: mnemosine memory correct\|corrige/`). «Usage:» es texto de Commander; un `configureHelp` que lo traduzca rompe esa aserción.

### 2.5 `MNEMOSINE_LANG` ya toca dos pruebas del CLI

`grep -rln "MNEMOSINE_LANG" tests` → `tests/cli/codigos-de-salida-hojas.spec.ts:63` y `tests/cli/status-command.spec.ts:74` hacen `delete env.MNEMOSINE_LANG` para fijar el entorno. Si la ayuda pasa a depender de esa variable, las 48 spec que corren el `program` sin limpiarla heredan el `.env` de quien las corre (el `.env.example` la documenta).

### 2.6 Manuales del wiki que citan salida literal del CLI

`grep -rn "No rows\.\|Showing [0-9]* of\|Ready to close\.\|Cannot close yet\|Mnemosine health check\|All good\.\|Aborted\." docs/wiki | wc -l` → **7** líneas en `Manual-de-usuario.md`, `Manual-Cobrar-y-pagar.md`, `Manual-Primer-cliente.md`, `Puesta-en-marcha.md`, `Manual-Trabajar-con-el-agente.md`. El informe (§5.12) sólo cuenta invocaciones (`mnemosine …`), no salida citada. `src/ai/docs/banking.md` cita 3 líneas de salida (`grep -c "^\$ \|^mnemosine \|  →\|✔\|✗"`); `accounting.md` 0.

### 2.7 Lo que NO se rompe (y el informe deja en el aire)

- `completion-command.ts` no incrusta descripciones: `flagsOf` (`:128-137`) y `collectTree` (`:146+`) sólo emiten nombres, alias y banderas (`grep -n description src/cli/completion-command.ts` → sólo su propia `.description` en :384). La localización de la ayuda no toca los scripts de completado.
- `tests/cli/ejemplos-de-ayuda.spec.ts` detecta ejemplos por líneas que empiezan por `mnemosine ` (`:80`), no por el rótulo «Examples:»; `ux-status.ts` tampoco busca el rótulo (`:338-384`, «¿muestra una invocación?»). Traducir «Examples:» → «Ejemplos:» no mueve `hojas-sin-ejemplo`. Hay **183** apariciones de `Examples:` en `src/cli` (`grep -rc "Examples:" src/cli --include='*.ts' | awk` suma) y 234 referencias a `EJEMPLOS`.
- `scripts/catalogo-estado.ts` no compara descripciones (`grep -n "description\|descripcion\|helpInformation"` → 0 líneas); `docs/cli-command-catalog.md` es un documento de diseño en castellano (1 914 líneas con acento), no un espejo de la ayuda.
- No hay snapshots (`grep -rl "toMatchSnapshot\|toMatchInlineSnapshot" tests | wc -l` → 0): las 613 aserciones son todas puntuales, no volcados enteros.
- `src/cli/README.md` está en inglés (414 líneas, 2 con acento).

### 2.8 Anotación de método sobre el contenido

Ningún archivo leído contenía instrucciones dirigidas al agente. El jsonl y el extractor son datos del otro agente y se usaron sólo como entrada de conteo.

---

## 3. Veredictos

| reclamo | veredicto |
|---|---|
| 5 348 literales / 3 804 prosa / 3 479 únicos / 2 451 en / 673 es / 255 mixto / 425 indet | **confirmado** al dígito (recomputo del jsonl) |
| Ayuda 1 397 (6 es) y ejecución 1 827 (495 es, 199 mixto) | **confirmado**; pero las 495 incluyen 0 y las 673 totales incluyen 32 `writes:` sin consumidor (§2.2) |
| Tabla por clase §2.2 y ejemplos de «24 archivos mezclan» | **confirmado**; la cifra 24 incluye 8 archivos con castellano residual |
| Las 6 castellanas de la ayuda = 7 nodos del censo | **confirmado** |
| cli-reference: «5 líneas castellanas + 8 datos» | **refutado**: 7 + 6 |
| `toLocaleString` = 4 | **refutado**: 5 |
| 77 verbos | **refutado**: 79 |
| `[y/N]` cableado en 7 archivos | **refutado**: 16 archivos (13 con el patrón `${question} [y/N]`) |
| «idioma del nodo» ×19 | **refutado**: 21 |
| 19 spec de integración importan `src/cli` | **refutado**: 7 |
| 47 archivos de tests/cli con aserciones de texto | **refutado**: 43 de 48 |
| `codigoDe('src/cli/mnemosine.ts')` ×9 | **refutado**: 12 |
| `LINEA_BASE` consumida en `doctor-service.ts:420` | **refutado en la línea** (399 en HEAD; 420 es del árbol sucio); el consumo (vía `auditarContraLineaBase`) es real |
| «273 invocaciones incrustadas; 26 con remedio →» | **parcial**: 274 y 26 existen, pero sólo 4 cadenas tienen las dos cosas |
| «219 números sin locale» | **no reproducible** (sin comando ni campo) |
| render() 199 llamadas en 33 archivos | 199 confirmado; **34** archivos |
| Todas las líneas citadas en criterios.ts, ux-status.ts, ci.yml, audit.ts, manifiesto, Commander | **confirmado** |
| `withOutput` en `flags.ts:454-461` | **refutado**: :520 |
| «20 descripciones del diccionario `flags.ts:490-573`» | cifra confirmada; el diccionario real (`FLAG_DICTIONARY`, :34) tiene 43 entradas |
| Trinquetes y dependencias de §5 (ux:status, matriz bilingüe, LINEA_BASE, criterios, manifiesto, cli-reference, encabezados=claves, Commander, confirmación, valores persistidos) | **confirmado**; faltan §2.4 (`bilingual-matrix:306` afirma «Usage:»), §2.5 (`MNEMOSINE_LANG` en dos spec) y §2.3 (305 errores de servicio) |
| Medición sobre «HEAD 25efb18, árbol limpio» | **refutado**: al menos `doctor-service.ts` se citó con líneas del árbol de trabajo sucio de otra sesión; `src/cli` sí coincide con 25efb18 y con HEAD |

---

## 4. Resumen corregido

El diagnóstico central del informe **sostiene**: la ayuda del CLI está en inglés (1 397 cadenas, 6 castellanas = los 7 nodos que `ux:status` ya registra) y la ejecución es bilingüe por familia (495 castellanas de 1 827, concentradas en las familias fusionadas el 1-2 de septiembre), y ninguna puerta lo mide. Lo que hay que corregir: (a) el castellano de ejecución está algo inflado por 32 metadatos `writes:` sin consumidor, y a la vez el inventario **omite ≈95 etiquetas de fichas** (`fact/linea/renglon/field`, 83 inglesas, 12 castellanas) porque el extractor descarta literales de menos de 3 palabras fuera de contexto; (b) los errores de servicios que `reportError` imprime tal cual son **305** sitios (46 con acento) fuera de las 3 804 y fuera del alcance de cualquier catálogo del CLI; (c) `cli-reference.md` arrastra 7 líneas castellanas, no 5; (d) los conteos de dependencias tienen errores de bulto en cuatro sitios —16 archivos con `[y/N]` cableado (no 7), 7 spec de integración importan `src/cli` (no 19), 43 archivos de tests con aserciones de texto (no 47), 79 verbos (no 77)— y una prueba más afirma cromo de Commander (`bilingual-matrix.spec.ts:306` «Usage:»); (e) el informe cita al menos `doctor-service.ts` con líneas de un árbol sucio de otra sesión, no de HEAD. Ninguna corrección altera la costura propuesta (kernel + `configureHelp` + `render()` con etiquetas), pero un plan debe contar con las etiquetas cortas de las fichas y con los 305 mensajes de servicio, que el informe no tiene en su universo.

---

## 5. Scripts usados (reproducibles)

```
# recomputo del jsonl (totales, clases, ayuda/ejecución, 24 archivos, plural, →)
node -e 'const L=require("fs").readFileSync("/tmp/investigacion-idioma/inventario/cli-cadenas.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse); …'
#   (cuerpo: prosa = idioma ∉ {token, pegamento}; ayuda = descripcion_* + ayuda_larga; ejecución = salida_consola+error_cli+paleta+prompt)

# muestra A: 30 filas del jsonl, una cada ⌊3804/30⌋, se busca la primera palabra ≥4 letras del texto en la línea citada

# writes: sin consumidor dentro de prosa_fuera_de_contexto
#   filas cuya línea del fuente casa /writes\s*:/  → 65 (14 en, 32 es, 1 mixto, 18 indet)

# etiquetas de helpers sin fila en el jsonl (AST, typescript del repo)
#   helpers = fact|linea|renglon|renglonDeAsiento|agregar|printCheck|filasDeSeccion|header|row|field|line|note|omitido
#   1er argumento StringLiteral, archivo:línea ∉ jsonl → 95

# errores de servicios
grep -rhoE "throw new [A-Za-z]+Error\(\s*[\`'\"]" src/services src/utils --include='*.ts' | wc -l   # 305
grep -rE  "throw new [A-Za-z]+Error\(\s*[\`'\"]" src/services src/utils --include='*.ts' | grep -c "[áéíóúñ¿¡]"   # 46
```
