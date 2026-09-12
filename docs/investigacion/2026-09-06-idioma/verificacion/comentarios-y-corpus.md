# Verificación escéptica — superficie «comentarios-y-corpus»

Informe verificado: `/tmp/investigacion-idioma/inventario/comentarios-y-corpus.md` (escrito 21:31).
Árbol usado para verificar: `/Users/victor/projects/Accounting`, HEAD `b31e62a` (`git rev-parse --short HEAD`), con 11 entradas sucias de otra sesión (`git status --short | wc -l` → 11: `src/ai/doctor-service.ts`, `src/services/accounting/{iva-cash-basis,iva-ppd-reclass,pais-contable}.ts`, `vitest.config.ts`, `src/services/jurisdiccion/` sin versionar, etc.). Datos de trabajo: `/tmp/investigacion-idioma/verificacion/cc-work/` (`bloques.json`, `commits_por_archivo.txt`, `tokens.txt`).

Regla que seguí: cada cifra del informe se volvió a contar con el mismo comando o uno mejor; cada `archivo:línea` de la muestra se abrió con `sed -n`; ante la duda, refuto.

---

## 0. El árbol que el informe dice haber auditado no es el que auditó

El informe declara «HEAD `25efb18`». No es cierto, y no es un detalle:

| Cita del informe | En `25efb18` | Comando |
|---|---|---|
| `docs/PROCESS.md:58` | **el archivo no existe** | `git show 25efb18:docs/PROCESS.md` → `fatal: path 'docs/PROCESS.md' exists on disk, but not in '25efb18'` |
| `AGENTS.md:3` | **no existe** | ídem; ambos nacen en `c01d79a` (`git log --diff-filter=A --format='%h %ad %s' --date=short -- docs/PROCESS.md AGENTS.md`) |
| `README.md:345-346` «Los comentarios y la documentación van en español» | en `25efb18` esas líneas hablan de la wiki | `git show 25efb18:README.md \| sed -n 345,346p` |
| «`ls src/database/migrations \| wc -l` → 74» | en `25efb18` son 73: `069_el_predicado_que_se_paga_por_fila.sql` entra en `8bdc8f2` | `git diff --stat 25efb18 HEAD -- src` |
| `src/services/jurisdiction/jurisdiction.ts` (encabezado de 33 líneas; umbral de cobertura «`:105`») | **no está en ningún commit**: es un archivo sin versionar de otra sesión | `git log --format=%h -- src/services/jurisdiction/jurisdiction.ts \| wc -l` → 0; `git status --short` → `?? src/services/jurisdiccion/` |

Conclusión: el informe se corrió sobre el **árbol de trabajo sucio** alrededor de `b31e62a`, no sobre `25efb18`. Las cifras de `src/` apenas se mueven (el diff `25efb18..HEAD` en `src` son +88 líneas al final de `criterios.ts`, una migración nueva y dos docs), así que las líneas citadas en `src/` siguen valiendo; pero dos citas descansan en archivos que no existen en HEAD (ver §3, filas 24 y 25).

---

## 1. Conteos: qué se sostiene y qué no

Comandos exactos. «Sostiene» = misma cifra o diferencia explicada por el diff del árbol.

### 1.1 Volumen global (§3.1) — SOSTIENE

```
python3 /tmp/investigacion-idioma/inventario/cuenta_comentarios.py src 1 /tmp/investigacion-idioma/verificacion/cc-work/bloques.json
```
→ TOTAL 376 archivos, 151 194 líneas, **29 319** comentario, **22 731** es, **5 498** en, 1 074 neutro, 16 mixto, 78 %; 7 394 bloques, 4 784 es; JSDoc 3 402 → 2 343 es / 961 en.
Informe: 29 309 / 22 721 / 5 498. La diferencia (+10 líneas, todas en `services`) es el árbol sucio (`iva-cash-basis.ts`, `iva-ppd-reclass.ts`, `pais-contable.ts` modificados). `find src -name '*.ts' | wc -l` → 376; `… | xargs wc -l | tail -1` → 150 818 (informe 150 808; mismo +10).

Tipos de bloque (`python3 -c` sobre `bloques.json`): `line` 3 983, `jsdoc` 3 402, `block` 9 — **exacto**.

`tests/`: 343 archivos, 12 681 líneas de comentario, 89 % es (informe 342 / 12 644 / 89 %): drift por `tests/accounting/exigir-segregacion.spec.ts` (+120 líneas en `8bdc8f2`). `scripts/`: 12 / 854 / 98 % — **exacto**.

### 1.2 Heurística de idioma (§1.1) — SOSTIENE, con un matiz cuantificado

Muestra propia, semilla 7, 40 bloques (`random.seed(7); random.sample(b,40)`): 38 etiquetados `es`/`en`, 2 `neutro` (ambos separadores `---- ledger balance show ----`). De los 38, 37 bien clasificados; 1 es un bloque **bilingüe** etiquetado `en` (`src/cli/init-command.ts:32`: «Reads a line WITHOUT echo … In raw mode we must manejar a mano el retorno»).

El informe hace heredar a cada línea el idioma de su bloque. Medí cuánto inglés se cuela así dentro de bloques `es` (línea con ≥ 2 tokens ingleses, 0 españoles y sin acento): **218 de 22 756 líneas (1,0 %)**; el caso inverso, 8 líneas. Concentrado en `src/ai/draft-service.ts` (26), `src/ai/compaction.ts` (21), `src/cli/customer-command.ts` (14), `src/cli/kernel/entity-context.ts` (14). La cifra de español es un techo, pero el techo está a 1 % del suelo: se sostiene.

Falsos positivos por regex literal: 2 bloques en 7 394 (`plan/criterios.ts:1508`, `backup/backup-service.ts:195`). Despreciable.

### 1.3 «142 archivos son 100 % español» (§3.2) — REFUTADO como está redactado

Recalculado sobre `bloques.json` (archivos con ≥ 20 líneas de comentario = 295 ✓; ambos idiomas ≥ 20 % = 69 ✓; 0 % español = 38 ✓):
- archivos con **0 líneas inglesas** (pueden tener `neutro`/`mixto`): **142** — es lo que el informe contó;
- archivos con **100 % de líneas `es`**: **81**.
La cifra 142 mide «sin inglés», no «100 % español». La conclusión de fondo (bolsillos puros) no cambia, la etiqueta sí.

### 1.4 Encabezados y bloques largos (§3.3) — SOSTIENE con método distinto

Recalculado descartando separadores (`// ====`) y líneas ` *` vacías: 36 archivos con encabezado (18 es, 17 en, 1 neutro) ✓; los más largos coinciden en orden, pero con **menos líneas** porque el informe cuenta las líneas crudas: `validador.ts` 47 crudas / 40 de contenido; `sat-agrupadores-catalogo.ts` 43/35; `compaction.ts` 35/32; `trust-scanner.ts` 30/25. «28 con ≥ 10 líneas» son 22 con contenido ≥ 10. No es error, es inflación de un 15-20 % por separadores. Y `jurisdiccion.ts` (33, es) es el archivo sin versionar de §0.

Bloques largos: ≥ 8 → 935 / 776 es / 156 en / 12 077 líneas es (informe 12 067: +10 del árbol sucio); ≥ 15 → 328 / 287 / 41 ✓; ≥ 25 → 104 / 96 / 8 / 3 583 (informe 103 / 95 / 3 554: el bloque nuevo es de un archivo sucio). Sostiene.

`grep -r -h -o -E '(//|\*).{0,80}\b(F0[0-9][a-d]?|S[0-9][a-b]?|G[0-9][a-b]?|E[0-9]\.[0-9]|R[0-9]|A[0-9](·[0-9])?|D1a)\b' src --include='*.ts' | wc -l` → **787** exacto.

### 1.5 Cruce con commits (§3.4) — cifras NO reproducidas, conclusión sí

Método propio: `for f in $(find src -name '*.ts'); do git log --format=%h -- "$f" | wc -l; done` (guardado en `cc-work/commits_por_archivo.txt`) → 1 commit: **159** (informe 165); 2-3: **152** (138); 4+: **65** (73). El método del informe (`git log --name-only -- src | sort | uniq -c`) cuenta rutas borradas/renombradas que ya no existen, y por eso no cuadra. El % es por grupo, con mi agrupación: 83 / 73 / 76 (informe 81 / 76 / 76). **La tesis «el español no es lo viejo ni lo nuevo» se sostiene**; las cifras de la tabla, no.

`git log --format=%h -- src/ai/skills | wc -l` → 1 (`4eeee63 2026-08-25`) ✓.

### 1.6 Directivas (§3.5) — EXACTO

`grep -rn 'eslint-disable' src --include='*.ts' | wc -l` → 5; `@ts-(ignore|expect-error)` → 2; `TODO|FIXME|XXX` → 56.

### 1.7 SQL de migraciones (§3.6) — cifra NO reproducida; dos afirmaciones falsas en el detalle

- `ls src/database/migrations | wc -l` → 74 (sólo con `069`, ver §0). Nombres con partícula española: `ls src/database/migrations | grep -c -E '_(el|la|los|las|que|de|y|del|un|una)_'` → **29** ✓.
- Líneas `--` sin separadores, misma heurística de tokens (script en §1.2 de este informe, guion inline): **2 131** → 1 474 es (69 %), 409 en, 242 neutro, 6 mixto. Informe: 2 071 / 1 414 / 403 / 254. La migración `069` aporta 75 líneas al archivo, no 60 líneas de comentario; el informe no publica su regla de separadores y no la puedo reproducir. La proporción (68-69 % es) se sostiene; la cifra absoluta, no.
- «`grep -n -i -E 'checksum|hash|sha' src/database/migrate.ts` → 0 resultados»: **falso**, da **1** (`migrate.ts:100` «el ROLLBACK des**ha**ce ambas»). La conclusión (no hay suma de control) es correcta; el comando citado no da lo que dice.

### 1.8 Corpus del agente (§3.7)

| Afirmación | Resultado | Veredicto |
|---|---|---|
| 25 herramientas (`grep -n -E "name: '[a-z_]+'" src/ai/tools/*.ts \| wc -l`) | 25 | ✓ |
| «coincide con `superficie.ts:29`» | `SUPERFICIE_DESATENDIDA` está en **`:28`** (`grep -n SUPERFICIE_DESATENDIDA src/ai/tools/superficie.ts`); 25 entradas (`sed -n 28,74p \| grep -c "^\s*'"`) | línea errada por 1 |
| «29 campos `description:`» con `grep -n -A3 -E '^ *description:$'` | ese comando da **25** (`'^ *description:$'`), y con `-A3 \| wc -l` daría 100. Los 29 salen de `grep -c -E '^\s*description:'` | cifra ✓, comando ✗ |
| 49 `.describe(` | 49 | ✓ |
| 28 `.md` + 2 json en `src/ai/docs` | `ls src/ai/docs/*.md \| wc -l` → 28; `ls \| wc -l` → 30 | ✓ |
| 14 en / 14 es, 9 134 / 2 405 líneas | reproducido con el mismo criterio (acentos vs `the/and/of/with`): 14 / 14, **9 134 / 2 405** | ✓ exacto |
| `cli-reference.md`: «15 líneas con acento» | **13 líneas** (`grep -c -E '[áéíóúñ¿¡]'`); 15 son los **caracteres** (`grep -o … \| wc -l`) | ✗ |
| manifiesto: 13 manuales, 49 fuentes, 46 hashes, `sin_revisar: ['payroll.md']` | python sobre el json: 13 / 49 / 46 / `['payroll.md']` | ✓ |
| `SIN_REVISAR_MAXIMO = 1` en `corpus-manifiesto.ts:55` | `:55` | ✓ |
| `MANIFIESTO.md:4` cita `tests/ai/corpus-sincronia.spec.ts` inexistente | `sed -n 4p` lo cita; `ls tests/ai \| grep -i corpus` → vacío | ✓ |
| `hashDe` hace hash del contenido entero (`corpus-manifiesto.ts:58-67`) | `fs.readFileSync(abs)` + sha1 «blob N\0» + contenido: sí, comentarios incluidos | ✓ |
| skills: 4 archivos, 3 skills, inglés | `find skills -type f` → 4; acentos 0 en los 4 | ✓ |
| `"(sin datos del sistema)"` sólo en `grounding.ts:49` | `grep -rn "sin datos del sistema" src tests` → 1 línea | ✓ |
| `criterios.ts:6473` «el criterio … buildTools devuelve las 25» | `:6473` es la cadena `a:` de un **mutante** (`'    // sin superficie: buildTools devuelve las 25'`), no el enunciado del criterio | matiz |

### 1.9 Fuera de `src/` (§3.8)

- Commits: `git log --format='%s' | wc -l` → 247; con acento 117; con palabras inglesas 10 (7 «Bump», 1 «Merge», «Update CODEOWNERS…», «Add github-advanced-security…») ✓.
- `grep -c "enunciado:" src/plan/criterios.ts` → 135 ✓ (`porque:` → 124).
- «todo en español salvo `docs/cli-command-registry.md` (603) y `docs/harness-best-practices.md` (133)»: ambos ✓ (`wc -l`, `head -3`). **Pero el barrido omitió** archivos `.md` versionados en inglés fuera de `docs/`: ver §4.

### 1.10 Acoplamientos (§5)

- `grep -c 'crudoDe(' src/plan/criterios.ts` → 41; `codigoDe(` → 187 ✓. Todas las líneas de `criterios.ts` citadas (170, 207, 226, 331-340, 608, 816-820, 843-849, 3681-3688, 3718, 3729, 3735-3747, 3755-3757, 6217-6222, 6473) **exactas** en HEAD y en `25efb18` (el diff `25efb18..HEAD` de `criterios.ts` es un único hunk `@@ -6535` de +88 líneas, posterior a todas ellas).
- `tests/ai/system-prompt.spec.ts`: `grep -c -E 'toMatch|toContain'` → **35**, no 34 (también 35 en `25efb18`). Las 11 aserciones de `:38-53,78` ✓; `:150` y `:159` ✓.
- **`vitest.config.ts:82-112`, «11 rutas, entre ellas `jurisdiccion.ts:105` y `criterio-cierre.ts:112`»: REFUTADO.** En el árbol de trabajo (sucio), `sed -n 82,112p | grep "'src/"` da **6** umbrales por archivo: `posting.ts` (:92), `validation.ts` (:95), `ar-ap-posting.ts` (:98), `sequence.ts` (:101), **`report-service.ts` (:105)**, `criterio-cierre.ts` (:112). `jurisdiccion.ts` **no tiene umbral por archivo** en ningún sitio: sólo aparece en `include` (`:37`, añadido por el diff sucio), y el propio comentario del diff dice «NO LLEVA TRINQUETE PROPIO». En `HEAD` (`git show HEAD:vitest.config.ts`) la franja 82-112 tiene 3 rutas. Las «11 rutas» son 10 `'src/` en todo el archivo sucio (4 de `include` + 6 umbrales).
- «27 nombres de archivo con palabras españolas» con un comando que contiene «…»: **no reproducible**. Recuento por diccionario (`/usr/share/dict/words` contra los tokens de los nombres; lista española resultante de 56 tokens en `cc-work/tokens.txt`): **51 archivos** (lista completa en §4.5). Con una lista corta como la del informe salen 16. El 27 no sale de ningún método que yo pueda escribir.
- `src/cli/kernel/audit.ts:197-209 LINEA_BASE`: empieza en `:197` ✓ pero **no termina en `:209`** (`:210-212` siguen siendo entradas). La afirmación de contenido (claves de comando, no rutas) ✓.
- `ci.yml:159-160` para `openapi`: son líneas de **comentario**; el `run: npx tsx scripts/openapi.ts --check` está en `:166`. `ci.yml:158` (`corpus-manifiesto.ts --check`) ✓.
- Mutantes que apuntan a comentarios: `grep -c -E "^\s*de: .*//" src/plan/criterios.ts` → 0 (ningún mutante depende de un comentario existente) ✓ implícito en el informe.

---

## 2. Muestra de 30 `archivo:línea` abiertas con `sed -n`

Criterio de «exacto»: la línea contiene lo que el informe dice que contiene. Src verificado en HEAD (y en `25efb18` para `criterios.ts` y `iva-cash-basis.ts`, que difieren); docs verificados en HEAD porque en `25efb18` no existen (§0).

| # | Cita | Exacto |
|---|---|---|
| 1 | `CONTRIBUTING.md:96` «En español. El asunto lleva…» | ✓ |
| 2 | `CONTRIBUTING.md:158` «Los comentarios y la documentación van en español…» | ✓ |
| 3 | `docs/PROCESS.md:58` «En español, con el código del tramo…» | ✓ (sólo en HEAD) |
| 4 | `README.md:345-346` «Los comentarios y la documentación van en español…» | ✓ en HEAD / **✗ en `25efb18`** (allí habla de la wiki) |
| 5 | `AGENTS.md:3` «la versión humana de este mismo contrato» | ✓ (sólo en HEAD) |
| 6 | `eslint.config.mjs:58-61` `reportUnusedDisableDirectives: 'error'` | ✓ (`:60`) |
| 7 | `src/ai/system-prompt.ts:25-27` «You are Mnemosine… __RESPONSE_LANGUAGE__» | ✓ |
| 8 | `src/ai/system-prompt.ts:171-174` `LANGUAGE_LINE` | ✓ |
| 9 | `src/ai/system-prompt.ts:185` `.replace('__RESPONSE_LANGUAGE__', LANGUAGE_LINE[resolveLanguage()])` | ✓ |
| 10 | `src/ai/providers/config.ts:596-597` esquema `language: z.enum(['en','es'])` | ✓ |
| 11 | `src/ai/providers/config.ts:1118,1131` «Default 'es'» / `?? 'es'` | ✓ |
| 12 | `src/ai/grounding.ts:46-47,49` prefijo bilingüe y «(sin datos del sistema)» | ✓ |
| 13 | `src/ai/compaction.ts:321-327` instrucción de resumen sin idioma | ✓ |
| 14 | `src/ai/webhooks/reader-agent.ts:153-166` `SOURCE_INSTRUCTIONS` | ✓ (`:154-166`) |
| 15 | `src/ai/tools/docs-tools.ts:22` (en) vs `:29` (es), `:253-256 docsIndex`, `:263-265` | ✓ |
| 16 | `src/ai/tools/policy-tools.ts:353-355` + `:362-365` | ✓ |
| 17 | `src/services/sat/anexo24/validador.ts:1-47` encabezado F07b | ✓ |
| 18 | `src/ai/skills/trust-scanner.ts:1-30` encabezado en | ✓ |
| 19 | `src/cli/init-command.ts:221-222` cambio de idioma a mitad de frase | ✓ |
| 20 | `src/services/accounting/iva-cash-basis.ts:74` `// READING THE METODO DE PAGO` | ✓ (HEAD y `25efb18`) |
| 21 | `src/ai/eval/golden.ts:41,46` `ResultadoEsperado`, `lado: 'cargo' \| 'abono'` | ✓ |
| 22 | `src/ai/tools/superficie.ts:29 SUPERFICIE_DESATENDIDA` | **✗** está en `:28` |
| 23 | `src/cli/mnemosine.ts:2036-2058, :2039` comando `lang\|idioma` | ✓ |
| 24 | `vitest.config.ts:105` = `jurisdiccion.ts` | **✗** `:105` es `report-service.ts`; `jurisdiccion.ts` no tiene umbral |
| 25 | `src/cli/kernel/audit.ts:197-209 LINEA_BASE` | **✗ parcial**: empieza en 197, sigue más allá de 209 |
| 26 | `scripts/corpus-manifiesto.ts:58-67 hashDe()` | ✓ |
| 27 | `.github/workflows/ci.yml:158` `corpus-manifiesto.ts --check` | ✓ |
| 28 | `tests/cli/censo-superficie.spec.ts:708` y `tests/ai/eval/arnes-cableado.spec.ts:503` | ✓ ambas |
| 29 | `tests/ai/tools/policy-tools.spec.ts:21,735-751` importa `hashDe/leerManifiesto`, exige `policy-tools.ts` como fuente | ✓ |
| 30 | `src/plan/criterios.ts:3735-3747` `PPD received → DR 1135` / `IMMUTABLE\|inmutable` | ✓ |

**27 de 30 exactas; 3 erradas** (#22 por una línea; #24 archivo y umbral inexistentes; #25 rango truncado), más #4 que sólo es cierta en un árbol distinto del declarado. Fuera de la muestra también abrí y confirmé: `src/ai/docs/MANIFIESTO.md:4,36-39,51,57-64`, `src/ai/skills/store.ts:199,221`, `skill-drafts.ts:10,98,263`, `skills-tools.ts:32`, `cfdi-decisions.ts:100`, `memory-service.ts:16-27`, `status-command.ts:9,253`, `status-command.spec.ts:74`, `codigos-de-salida-hojas.spec.ts:63`, `cli-reference.md:84,7903`, `package.json:31`, `generate-cli-reference.ts:1-3,16`, `docs/auditorias/F03.md:1`, `criterios.ts:170,207,226,331-340,608,816-820,843-849,3681-3688,3718,3729,3755-3757,6217-6222,6473` — todas exactas.

---

## 3. Lo que el informe no vio

### 3.1 Comentarios SQL dentro de template literals de `.ts` — invisibles al escáner

El escáner del informe **salta las cadenas** (por diseño, para no contar `//` de URLs). Las consultas SQL embebidas en `` `…` `` llevan comentarios `--` que son comentarios de pleno derecho y no entran en las 29 319:

```
grep -rn -E "^\s*--\s" src --include='*.ts' | wc -l          → 128
grep -rn -E "^\s*--\s" src --include='*.ts' | grep -c -E '[áéíóúñ¿¡]'   → 73
```
Por archivo: `src/services/banking/reconciliation-service.ts` 28, `src/services/reporting/cash-flow-reconcile.ts` 19, `src/services/accounting/iva-ppd-reclass.ts` 12, `src/services/banking/reconciling-items.ts` 11, `src/services/accounting/iva-cash-basis.ts` 9, `src/services/banking/bank-account-service.ts` 8. Mismo idioma, misma clase, otro sitio.

### 3.2 Comentarios en fuentes versionadas que no son `.ts` ni migraciones

El informe cuenta `.ts` y `src/database/migrations/*.sql`. Fuera quedan (comando: `for f in $(git ls-files | grep -E '\.(mjs|cjs|js|sh|yml|yaml|sql|toml)$' | grep -v migrations); do grep -c -E '^\s*(//|#|--|\*)\s*\S' "$f" …`):

| Archivo | Líneas de comentario | Con acento | Con token inglés |
|---|---:|---:|---:|
| `scripts/rol-auditor.sql` | 186 | 96 | 2 |
| `.github/workflows/ci.yml` | 181 | 98 | 0 |
| `src/database/rls-policies.sql` | 146 | 65 | 22 (mixto) |
| `.github/workflows/witness-triage.yml` | 95 | 52 | 1 |
| `eslint.config.mjs` | 84 | 6 | 63 (inglés) |
| `scripts/provision-roles.sql` | 60 | 36 | 0 |
| `scripts/verify-isolation.sh` | 19 | 9 | 0 |
| `scripts/publicar-wiki.sh` | 18 | 7 | 0 |

≈ **789 líneas** de comentario no inventariadas, ~85 % en español. Y no son inertes: `rls-policies.sql` se **ejecuta en cada `npm run migrate`** (`src/database/migrate.ts:154`) y lo lee `criterios.ts:1403` (`codigoDe`, sin comentarios: seguro); `provision-roles.sql` corre en CI (`.github/workflows/ci.yml:304`) y lo lee `criterios.ts:1393` (`codigoDe`).

### 3.3 Documentación en inglés que el barrido de §3.8 no listó

Barrido: `git ls-files '*.md'` + acentos vs `the/and/of/with` (147 `.md` bajo `docs/`):
- **`files/accounting_core_technical_spec.md`, `_part2.md`, `_part3.md`** — 3 archivos versionados en la raíz, **5 686 líneas** (`wc -l files/*.md`), en inglés, sin que nada del repo los cite (`grep -rn "files/accounting_core" docs README.md AGENTS.md CONTRIBUTING.md src` → 0).
- **`src/cli/README.md`** — 414 líneas, inglés («# mnemosine — AI accounting assistant (CLI)»). Ningún código lo lee (`grep -rn "cli/README" src scripts tests --include='*.ts'` → 0); lo citan `docs/plan-cierre-brechas.md:8137` y `docs/auditorias/2026-09-01-usabilidad/ux-errores.md:107`.
- `tests/fixtures/certs/README.md` (menor).

### 3.4 Una prueba que lee el fuente CRUDO y hace aserción negativa sobre él

El informe dice que los criterios son robustos a comentarios salvo los `crudoDe` que lista. Hay además **una prueba unitaria** que lee un `.ts` completo (comentarios incluidos) y exige que **no** contenga ciertos identificadores:

`tests/services/banking/reconciliation-adjustments.spec.ts:107-118` — `readFileSync(resolve(__dirname, '../../../src/services/banking/reconciliation-adjustments.ts'))` y `expect(fuente).not.toMatch(/\bcreateJournalEntry\b/)`, `/\bpostJournalEntry\b/`, `/from '.*accounting\/posting\.js'/`. Un comentario traducido que diga «this module never calls createJournalEntry» rompe la prueba. Es el único test que lee un `.ts` de `src/` por ruta (`grep -rn -E "(resolve|join)\([^)]*(\.\./)+(src|scripts)/[^'\"]*\.ts" tests` → 1), y ninguna prueba busca texto de comentario como tal (`grep -rn -E "toMatch\(/\s*(\\\\/\\\\/|\\\\\*)|toContain\(['\"]\s*(//|/\*\*)" tests` → sólo `probe.spec.ts:135`, que es una URL).

### 3.5 Nombres de archivo en español: 51, no 27

Lista (tokens del nombre contra `/usr/share/dict/words`, luego filtrados a mano a 56 tokens españoles): `src/ai/eval/puntuacion.ts`, `src/ai/tools/superficie.ts`, `src/api/graphql/{errores,permisos}.ts`, `src/api/rest/middleware/idempotencia.ts`, `src/api/rest/{montajes,topes}.ts`, `src/auth/sujeto-activo.ts`, `src/cli/kernel/{confirmacion,riesgos-retrofit}.ts`, `src/database/consulta-publica.ts`, `src/plan/{conducta,criterios}.ts`, `src/services/accounting/{moneda-origen,pais-contable,sat-agrupadores,sat-agrupadores-catalogo}.ts`, `src/services/backup/exportacion-inquilino.ts`, `src/services/banking/parsers/{avisos,fecha,importe,perfiles-csv,texto,tipos}.ts`, `src/services/fiscal/inpc/{parseo,periodo}.ts`, `src/services/integrations/mexico/pac/simulacion.ts`, `src/services/jurisdiction/jurisdiction.ts` (sin versionar), `src/services/payroll/mx/{finiquito-calculator,finiquito-math,subsidio-entregado}.ts`, `src/services/reporting/criterio-cierre.ts`, `src/services/sat/anexo24/{artefactos,balanza-invariantes,balanza-service,balanza-xml,catalogo-cuentas,polizas-auxiliar-xml,polizas-invariantes,polizas-service,polizas-xml,validador}.ts`, `src/services/sat/diot/{desglose,hallazgos,hechos,modelo,serializador,tercero}.ts`, `src/services/webhooks/{barrido-entregas,politica-reintento}.ts`, `src/services/xml-ingestion/rep-pendientes.ts`.
De las 49 fuentes del manifiesto del corpus, **0** tienen nombre español (python sobre `manifiesto.json`): renombrar archivos no toca el manifiesto; sí toca `vitest.config.ts` (`criterio-cierre.ts:112`) y los `crudoDe/codigoDe` de `criterios.ts` que citan rutas (otra superficie).

### 3.6 Mutantes que inyectan comentarios en español

`grep -n -E "^\s*(de|a): '\s*(//|/\*\*| \*)" src/plan/criterios.ts` → 10 mutantes cuyo texto de sustitución `a:` es un comentario en español (`:2241` «// registerDepreciationCommand fuera del binario», `:4530`, `:4591`, `:4895`, `:4997`, `:5399`, `:5493`, `:6205`, `:6397`, `:6473`). Ningún `de:` es un comentario (0). Si la regla pasa a «comentarios en inglés», estos 10 comentarios generados por la mutación son texto fuente que hoy nace en español.

---

## 4. Veredicto

- **Se sostiene**: el volumen global (29 3xx / 22 7xx / 5 498, 78 %), los bloques y el JSDoc, la heurística (37/38 en mi muestra; 1 % de fuga a nivel de línea), los 787 códigos de paquete, las 5+2+56 directivas, los 25 / 49 / 28 / 14+14 / 9 134+2 405 del corpus, el manifiesto (13/49/46, hash del archivo entero), 187/41 en `criterios.ts` con todas sus líneas exactas, los 29 nombres de migración, los 247/117/10 commits, los 135 enunciados, la lectura de `resolveLanguage` y `LANGUAGE_LINE`.
- **Refutado o no reproducible**: el HEAD declarado (`25efb18`; el árbol real es el de trabajo sucio en `b31e62a`, con un archivo sin versionar citado dos veces); «142 archivos 100 % español» (son 142 sin inglés, 81 al 100 %); la tabla de commits de §3.4 (165/138/73 → 159/152/65 por archivo); las 2 071 líneas SQL (2 131 con regla publicada); «`grep checksum|hash|sha migrate.ts` → 0» (da 1); «15 líneas con acento» en `cli-reference.md` (13); «34 aserciones» (35); «`vitest.config.ts:82-112`, 11 rutas, `jurisdiccion.ts:105`» (6 umbrales, `:105` es `report-service.ts`, `jurisdiccion.ts` no tiene umbral); «27 nombres españoles» (51, y el comando no es reproducible); `superficie.ts:29` (`:28`); `audit.ts:197-209` (sigue).
- **Omitido**: 128 comentarios SQL en template literals (73 con acento); ≈ 789 líneas de comentario en `.yml/.sql/.sh/.mjs` versionados, incluida `rls-policies.sql` que corre en cada `migrate`; 5 686 líneas en inglés en `files/*.md` y 414 en `src/cli/README.md`; una prueba (`reconciliation-adjustments.spec.ts:107-118`) que lee un fuente crudo y falla si un comentario nombra `createJournalEntry`; 10 mutantes que inyectan comentarios en español.

Ninguna de las refutaciones invierte la tesis central del informe (el español es el estilo de la casa desde el primer commit, el corpus del agente es inglés donde es sistema, y lo que rompe una traducción es el manifiesto más un puñado de `crudoDe`). Lo que sí cambia: el inventario de «dónde vive esta clase de texto» es incompleto en ~900 líneas y tres documentos, y el acoplamiento tiene una prueba más de la que el informe sabía.
