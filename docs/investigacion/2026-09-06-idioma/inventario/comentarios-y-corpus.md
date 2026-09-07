# Inventario de idioma — comentarios, documentación en código y corpus del agente

Superficie: comentarios (`//`, `/* */`, JSDoc), encabezados largos de archivo, y el corpus que lee el modelo (`src/ai/system-prompt.ts`, `src/ai/docs/*.md`, `skills/`, descripciones de herramientas en `src/ai/tools/`). Árbol auditado: `/Users/victor/projects/Accounting`, rama `instrumentos-que-mienten-segun-la-maquina`, HEAD `25efb18`. Fecha: 2026-09-06.

Todo lo que se afirma del código lleva `archivo:línea`. Toda cifra lleva el comando con el que se contó. El script de conteo está junto a este informe: `/tmp/investigacion-idioma/inventario/cuenta_comentarios.py`.

---

## 1. Método y comandos

### 1.1 Comentarios en `.ts`

Script `cuenta_comentarios.py <raíz> <profundidad> [volcado.json]`:

- Recorre los `.ts` bajo la raíz (excluye `node_modules/` y `dist/`).
- Extrae comentarios con un escáner que **salta cadenas** (`'…'`, `"…"`, `` `…` ``) para no contar `//` dentro de una URL o un template; no distingue regex literales (falsos positivos raros, aceptados).
- Cada comentario contiguo forma un **bloque** (`//` consecutivos = un bloque; cada `/* … */` = un bloque; `/** … */` se etiqueta `jsdoc`). Se descartan las líneas vacías de un bloque (` *` solo).
- Clasificación por bloque, no por línea, porque una línea suelta rara vez tiene tokens suficientes:
  - `es` si contiene `áéíóúñ¿¡«»` **o** más tokens de la lista española (`el la los las de del que un una para por con se es en sin al lo su sus también pero porque sólo cada este esta esto hay ya más ni cuando donde como desde hasta entre sobre según nunca siempre antes después así…`) que de la inglesa;
  - `en` si más tokens ingleses (`the and is of to for with this that not are from which when it be or if we an as by on at has have was were will can should must into only each their there so but because then than these those does do did been…`);
  - `neutro` si no hay tokens de ninguna lista (separadores `// ====`, rutas, `GET /v1/...`, código comentado);
  - `mixto` si empate.
- Las líneas heredan el idioma de su bloque.

Comandos exactos:

```
python3 cuenta_comentarios.py src 1 bloques.json      # por carpeta de primer nivel + volcado de bloques
python3 cuenta_comentarios.py src 2                   # por carpeta de segundo nivel
python3 cuenta_comentarios.py tests 1                 # comparación
python3 cuenta_comentarios.py scripts 1               # comparación
```

**Verificación manual de la heurística** (muestra aleatoria, semilla 42, 40 bloques del volcado):

```
python3 -c "import json,random; b=json.load(open('bloques.json')); random.seed(42); [print(x['idioma'],x['archivo'],x['linea'],x['texto'][:100]) for x in random.sample(b,40)]"
```

Resultado: los 37 bloques etiquetados `es`/`en` estaban bien clasificados (37/37). De los 3 `neutro`, uno era inglés sin tokens de la lista (`src/services/xml-ingestion/cfdi-decisions.ts:100` — `* Food/restaurant keys.`). Es decir: el `neutro` esconde algo de inglés corto; las cifras de `en` son un **piso**, las de `es` son fiables.

### 1.2 Encabezados de archivo

Script inline (en el informe, §3.3): toma las líneas de comentario contiguas **antes del primer código** de cada `.ts`; idioma por acentos / tokens ingleses.

### 1.3 Corpus del agente

- Docs: `for f in src/ai/docs/*.md; do wc -l; grep -o -E '[áéíóúñ¿¡]' | wc -l; grep -o -w -i -E 'the|and|of|with' | wc -l; done` (dos marcadores opuestos por archivo, y lectura de las primeras líneas de cada uno).
- Herramientas: `grep -n -A3 -E '^ *description:$' src/ai/tools/*.ts`; `grep -h -o '\.describe(' src/ai/tools/*.ts | wc -l`; `grep -n -E "name: '[a-z_]+'" src/ai/tools/*.ts | wc -l`.
- Skills: `find skills -type f` + lectura.
- Prompts secundarios: `grep -n -E "role: 'user'|system:|You are|PROMPT" src/ai/{grounding,compaction,agent}.ts src/ai/webhooks/reader-agent.ts`.

### 1.4 SQL de migraciones

Script inline (§3.6): líneas que empiezan por `--`, descartando separadores; mismo criterio de tokens.

---

## 2. Las reglas rectoras: cita exacta

| Documento | Línea | Texto literal |
|---|---|---|
| `CONTRIBUTING.md` | 96 | «En español. El asunto lleva el código del paquete, dos puntos, y una línea que dice **qué cambió** — no qué archivos tocaste:» (sección «Mensajes de commit») |
| `CONTRIBUTING.md` | 158 | «Los comentarios y la documentación van en español, y explican el **porqué**. El qué ya lo dice el código; si no lo dice, arregla el código.» (sección «Documentación») |
| `docs/PROCESS.md` | 58 | «En español, con el código del tramo cuando exista (ver `CONTRIBUTING.md` para ejemplos). El cuerpo explica el **porqué**, no el diff.» (sección «Mensajes de commit») |
| `README.md` | 345-346 | «Los comentarios y la documentación van en español. Nada de emoji, nada de `feat:` ni `chore:`.» |
| `AGENTS.md` | — | **No contiene ninguna regla de idioma.** `grep -n -i -E 'idioma|castellano|español|ingl[eé]s|english|spanish|language' AGENTS.md` → 0 resultados. Está escrito íntegramente en español y en `AGENTS.md:3` se declara «la versión humana de este mismo contrato» respecto de `CONTRIBUTING.md` — el agente hereda la regla por referencia, no por texto. |

Origen de la regla: `git log --format='%h %ad %s' --date=short -S'van en español' -- CONTRIBUTING.md README.md` → `aeb85c0 2026-08-31 Apache 2.0, y un README que describe el producto que existe`. El primer commit del repo es `4eeee63 2026-08-25 Línea base del sistema contable mnemosine`; la regla escrita llegó seis días después, pero la línea base ya venía en español (ver §3.4).

Regla de lint que **sí** toca comentarios: `eslint.config.mjs:58-61` — `reportUnusedDisableDirectives: 'error'`, con el comentario «The four pre-existing `eslint-disable-next-line no-explicit-any` comments in src/ai are real and load-bearing». No hay regla de idioma ni de ortografía.

---

## 3. Conteos

### 3.1 Volumen global de comentarios en `src/`

`find src -name '*.ts' | wc -l` → **376 archivos**; `find src -name '*.ts' | xargs wc -l | tail -1` → **150 808 líneas**.

`python3 cuenta_comentarios.py src 1`:

| Carpeta | Archivos | Líneas | Líneas de comentario | es | en | neutro | mixto | % es |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `src/index.ts` | 1 | 404 | 168 | 130 | 30 | 8 | 0 | 77 |
| `src/ai` | 59 | 16 766 | 3 745 | 1 814 | 1 842 | 85 | 4 | **48** |
| `src/api` | 36 | 9 965 | 2 281 | 1 780 | 317 | 184 | 0 | 78 |
| `src/auth` | 6 | 1 028 | 205 | 115 | 82 | 8 | 0 | 56 |
| `src/cli` | 70 | 38 069 | 5 815 | 4 290 | 1 310 | 213 | 2 | 74 |
| `src/config` | 1 | 239 | 76 | 18 | 58 | 0 | 0 | 24 |
| `src/database` | 10 | 1 536 | 403 | 352 | 32 | 19 | 0 | 87 |
| `src/plan` | 3 | 7 948 | 1 676 | 1 672 | 0 | 4 | 0 | **100** |
| `src/services` | 184 | 73 895 | 14 825 | 12 520 | 1 775 | 520 | 10 | 84 |
| `src/types` | 1 | 960 | 40 | 7 | 0 | 33 | 0 | 18 |
| `src/utils` | 5 | 374 | 75 | 23 | 52 | 0 | 0 | 31 |
| **TOTAL** | **376** | 151 184* | **29 309** | **22 721** | **5 498** | 1 074 | 16 | **78 %** |

\* el script cuenta `+1` por archivo respecto de `wc -l`.

Bloques: **7 394** bloques de comentario; 4 784 en español. Tipos: 3 983 bloques `//`, 3 402 JSDoc `/** */`, 9 bloques `/* */` a secas (`python3 -c` sobre `bloques.json`, §3.2).

**JSDoc**: 3 402 bloques → **2 343 es (69 %)**, 961 en (28 %), 94 neutro.

Comparación fuera de `src/`: `tests/` 342 archivos, 12 644 líneas de comentario, **89 % es**; `scripts/` 12 archivos, 854 líneas, **98 % es**.

### 3.2 Segundo nivel: dónde vive cada idioma

`python3 cuenta_comentarios.py src 2` (extracto; carpetas con contraste):

| Carpeta | Com. | es | en | % es |
|---|---:|---:|---:|---:|
| `ai/` (raíz) | 1 873 | 1 051 | 789 | 56 |
| `ai/eval` | 67 | 67 | 0 | 100 |
| `ai/jobs` | 145 | 0 | 144 | **0** |
| `ai/providers` | 763 | 334 | 395 | 44 |
| `ai/skills` | 243 | 0 | 233 | **0** |
| `ai/tools` | 502 | 322 | 178 | 64 |
| `ai/webhooks` | 152 | 40 | 103 | 26 |
| `api/graphql` | 363 | 345 | 1 | 95 |
| `api/rest` | 1 918 | 1 435 | 316 | 75 |
| `cli/` (raíz) | 4 758 | 3 668 | 888 | 77 |
| `cli/init` | 255 | 63 | 189 | 25 |
| `cli/kernel` | 802 | 559 | 233 | 70 |
| `services/accounting` | 2 209 | 1 767 | 400 | 80 |
| `services/ap` | 371 | 171 | 180 | 46 |
| `services/ar` | 301 | 121 | 179 | 40 |
| `services/assets` | 630 | 630 | 0 | 100 |
| `services/banking` | 3 557 | 3 494 | 1 | 98 |
| `services/entity` | 50 | 8 | 42 | 16 |
| `services/fiscal-credentials` | 78 | 15 | 60 | 19 |
| `services/payroll` | 1 248 | 856 | 250 | 69 |
| `services/policy` | 170 | 100 | 65 | 59 |
| `services/sat` | 1 765 | 1 748 | 1 | 99 |
| `services/vault` | 76 | 0 | 71 | **0** |
| `services/xml-ingestion` | 821 | 523 | 209 | 64 |

Por archivo dentro de `src/ai/` (script inline sobre las mismas funciones): 100 % inglés en `system-prompt.ts` (24 líneas), `external-service.ts` (78), `onboarding-service.ts` (34), `pending-service.ts` (16), `question-service.ts` (16), `session-search.ts` (33), `session-store.ts` (56), `tools/session-search-tools.ts` (36), `tools/status-tools.ts` (28), `tools/draft-tools.ts`, `tools/ledger-tools.ts`, `tools/search-tools.ts`, `tools/observer.ts`; 100 % español en `tools/policy-tools.ts` (142), `tools/superficie.ts` (102), `doctor-service.ts` (230 de 274), `memory-service.ts` (160 de 190), `untrusted.ts`, `budget.ts`, `ingest-runs.ts`, `agent-events.ts`; mezcla en `compaction.ts` (63 es / 67 en), `agent.ts` (28/65), `floor.ts` (50/39), `context.ts` (14/17), `ingest-service.ts` (83/48).

**Mezcla dentro del mismo archivo**: de los 295 archivos con ≥ 20 líneas de comentario, **69 tienen ambos idiomas con ≥ 20 % cada uno**; 142 son 100 % español; 38 son 0 % español.

```
python3 -c "import json,collections; b=json.load(open('bloques.json')); per=collections.defaultdict(lambda:[0,0,0]); ..."   # ver §3.1
```

### 3.3 Encabezados largos y bloques largos (el estilo de la casa)

Encabezados (comentario contiguo antes del primer código):

- 36 de 376 archivos tienen encabezado; **28 con ≥ 10 líneas (18 es, 10 en)**; 15 con ≥ 20 líneas (12 es, 3 en); 2 con ≥ 40 (ambos es).
- Los más largos: `src/services/sat/anexo24/validador.ts` (47 líneas, es), `src/services/accounting/sat-agrupadores-catalogo.ts` (43, es), `src/ai/compaction.ts` (35, es), `src/api/rest/trust-proxy.ts` (34, es), `src/services/jurisdiccion/jurisdiccion.ts` (33, es), `src/services/sat/diot/rfc.ts` (30, es), `src/ai/skills/trust-scanner.ts` (30, **en**), `src/auth/roles.ts` (27, es), `src/cli/kernel/confirmacion.ts` (26, es), `src/ai/tools/superficie.ts` (26, es).

Bloques largos en cualquier posición (del volcado):

| Umbral | Bloques | es | en | Líneas es | Líneas en |
|---|---:|---:|---:|---:|---:|
| ≥ 8 líneas | 935 | 776 | 156 | 12 067 | 1 994 |
| ≥ 15 líneas | 328 | 287 | 41 | 7 046 | 819 |
| ≥ 25 líneas | 103 | 95 | 8 | 3 554 | 222 |

Lectura: **el 53 % de las líneas de comentario en español (12 067 de 22 721) está en bloques de 8+ líneas** — prosa que explica el porqué, no anotaciones cortas. En inglés la proporción es 36 % (1 994 de 5 498). Traducir esta superficie no es traducir etiquetas: es traducir ensayos.

Comentarios que citan un código de paquete del plan (`F07c`, `S4a`, `G4b`, `E5.1`…): `grep -r -h -o -E '(//|\*).{0,80}\b(F0[0-9][a-d]?|S[0-9][a-b]?|G[0-9][a-b]?|E[0-9]\.[0-9]|R[0-9]|A[0-9](·[0-9])?|D1a)\b' src --include='*.ts' | wc -l` → **787 líneas**. Esos códigos apuntan a `docs/auditorias/*.md` (28 entradas, `ls docs/auditorias | wc -l`) y a `docs/plan-cierre-brechas.md` (8 371 líneas), todo en español.

### 3.4 ¿El inglés es «lo heredado» y el español «lo nuevo»? No.

Cruce de idioma con número de commits que tocan el archivo (`git log --format= --name-only -- src | sort | uniq -c` + script):

| Grupo | Archivos | Com. | es | en | % es |
|---|---:|---:|---:|---:|---:|
| sólo en la línea base (1 commit) | 165 | 9 753 | 7 908 | 1 561 | 81 |
| 2-3 commits | 138 | 8 904 | 6 724 | 1 788 | 76 |
| 4+ commits | 73 | 10 662 | 8 099 | 2 149 | 76 |

La línea base del 2026-08-25 ya venía mayoritariamente en español. Los bolsillos en inglés (`ai/skills`, `ai/jobs`, `services/vault`, `session-store.ts`, `system-prompt.ts`…) son módulos concretos escritos así desde el origen (`git log --format=%h -- src/ai/skills | wc -l` → 1 commit, 2026-08-25), no una era anterior.

### 3.5 Directivas semánticas dentro de comentarios (no traducibles)

- `grep -rn 'eslint-disable' src --include='*.ts' | wc -l` → **5** (vigiladas por `eslint.config.mjs:61`).
- `grep -rn -E '@ts-(ignore|expect-error)' src --include='*.ts' | wc -l` → **2**.
- `grep -rn -E '\b(TODO|FIXME|XXX)\b' src --include='*.ts' | wc -l` → **56**.

### 3.6 SQL de migraciones

`ls src/database/migrations | wc -l` → **74 archivos**. Script inline: **2 071 líneas de comentario `--`** (sin separadores) → **1 414 es (68 %)**, 403 en, 254 neutro/empate. **29 de 74 nombres de archivo** contienen partículas españolas (`_el_|_la_|_que_|_de_|_y_`…), p. ej. `040_el_secreto_que_el_compromiso_revelaba.sql`, `054_la_sesion_que_cuadra.sql`, `058_el_sello_de_las_garantias.sql`.

`grep -n -i -E 'checksum|hash|sha' src/database/migrate.ts` → 0 resultados sobre sumas de control: el migrador **no** verifica el contenido, sólo el nombre (ver memoria y `docs/migraciones.md`).

### 3.7 Corpus del agente

**Herramientas** (`src/ai/tools/`): `grep -n -E "name: '[a-z_]+'" src/ai/tools/*.ts | wc -l` → **25 herramientas** (coincide con `superficie.ts:29` y con el criterio de `criterios.ts:6473` «buildTools devuelve las 25»); `grep -n -A3 -E '^ *description:$' src/ai/tools/*.ts` → **29 campos `description:`** (25 de herramientas + 4 de esquemas Zod), **los 29 en inglés**; `grep -h -o '\.describe(' src/ai/tools/*.ts | wc -l` → **49 descripciones de parámetro Zod**, 0 con acento y 0 con partículas españolas → **inglés**. Los nombres de herramienta son `snake_case` inglés (`search_accounts`, `draft_journal_entry`, `get_accounting_policies`, `ask_user`…). Excepción de nombre de archivo: `src/ai/tools/superficie.ts` (y su export `SUPERFICIE_DESATENDIDA`, `:29`) — identificador y archivo en español, encabezado de 26 líneas en español.

**System prompt** (`src/ai/system-prompt.ts`): `ROLE_INSTRUCTIONS` (`:25-88`) íntegramente en inglés; `MEMORY_HEADING` (`:90-91`), `skillsSection()` (`:127-131`) y `DOCS_AND_COA` (`:135-139`) en inglés. El idioma de **respuesta** se decide en un solo sitio: `LANGUAGE_LINE` (`:171-174`: «Always respond in Spanish» / «Always respond in English») sustituido en `:185` con `resolveLanguage()`. `resolveLanguage` vive en `src/ai/providers/config.ts:1119-1131`: `MNEMOSINE_LANG` (env) > `config.language` (`mnemosine.config.json`, esquema `:596-597`) > **por omisión `'es'`** («Default 'es' (Mexican accounting firms)», `:1118`). Se fija con `mnemosine lang|idioma` (`src/cli/mnemosine.ts:2036-2058`), cuya ayuda dice literalmente «CLI UI stays English; Spanish command aliases always work» (`:2039`). Sólo existen dos valores: `en | es` (`config.ts:1115`).

**Prompts secundarios** (todos en inglés, con dos cadenas fijas en español):
- `src/ai/grounding.ts:41-52` `GROUNDING_NUDGE`: inglés; en `:46-47` prescribe el prefijo bilingüe «"Verificando la documentación:" / "Checking the documentation:" per your response language», y en `:49` exige una línea fija **sólo en español** `"(sin datos del sistema)"` sea cual sea el idioma (nadie la parsea: `grep -rn "sin datos del sistema" src tests` → sólo esa línea).
- `src/ai/compaction.ts:321-327`: instrucción de resumen en inglés; **no dice en qué idioma resumir**, así que el resumen que se inyecta a la conversación (`agent.ts:198`) sale en el idioma que elija el modelo.
- `src/ai/webhooks/reader-agent.ts:153-166` `SOURCE_INSTRUCTIONS`: inglés.

**Docs** (`src/ai/docs/`, 28 `.md` + `ifrs-registry.json` + `manifiesto.json`):

| Idioma | Archivos | Líneas |
|---|---|---:|
| **Inglés (14)** | `accounting`, `banking`, `cli-reference` (generado, 8 469), `connectivity`, `external-integrations`, `identity-access`, `mexico-cfdi`, `mnemosine`, `payables`, `payroll`, `playbooks`, `receivables`, `reports`, `system` | 9 134 |
| **Español (14)** | `MANIFIESTO.md`, `nif-marco`, `nif-registro`, `nif-validaciones`, `niif-activos`, `niif-grupos`, `niif-indice`, `niif-ingresos-arrendamientos`, `niif-instrumentos-financieros`, `niif-interpretaciones`, `niif-marco-presentacion`, `niif-moneda-seguros-adopcion`, `niif-pasivos-empleados-impuestos`, `niif-pymes-convergencia` | 2 405 |

La frontera es nítida: **manuales del sistema en inglés, normativa contable (NIF/NIIF) en español**. `cli-reference.md` tiene 15 líneas con acento (`grep -n -E '[áéíóúñ¿¡]' src/ai/docs/cli-reference.md`) que **no** son del documento sino de textos de ayuda del CLI en español que se cuelan (`:84` «ai|ia  Métricas y calibración del agente contable», `:7903` «--refresh  consulta al SAT ahora y actualiza la caché sat_*», `:8055-8071`): superficie del CLI, no de esta.

El índice que el modelo ve en el prompt (`docs-tools.ts:253-256 docsIndex()`, inyectado en `system-prompt.ts:136`) mezcla idiomas en la misma lista: `docs-tools.ts:22` «CFDI 4.0 (PUE/PPD, VAT), multi-PAC stamping…» (en) frente a `:29` «NIF serie A: los 8 postulados, definiciones de activo/pasivo/ingreso — el fundamento de todo registro» (es) y `:35-44` (diez resúmenes `niif-*` en español).

`manifiesto.json`: claves en español (`manuales`, `sin_revisar`, `hashes`, `_como_actualizar`); 13 manuales, **49 archivos fuente distintos** (31 en `services/`, 12 en `ai/`, 2 `cli/`, 2 `database/`, 2 `api/`), 46 hashes sellados, `sin_revisar: ['payroll.md']`; `SIN_REVISAR_MAXIMO = 1` en `scripts/corpus-manifiesto.ts:55` (trinquete: sólo baja). `MANIFIESTO.md:4` cita `tests/ai/corpus-sincronia.spec.ts`, **que no existe** (`ls tests/ai | grep -i corpus` → vacío); la compuerta real es el paso de CI `.github/workflows/ci.yml:158` (`npx tsx scripts/corpus-manifiesto.ts --check`), vigilado por `tests/cli/censo-superficie.spec.ts:708` y `tests/ai/eval/arnes-cableado.spec.ts:503`, y por `criterios.ts:3729`.

**Skills** (`skills/` en la raíz): `find skills -type f` → 4 archivos, 3 skills (`diot-checklist`, `month-end-close` + `checklist.md`, `sat-reconciliation`), **todos en inglés** (frontmatter `name/description/when_to_use` y cuerpo). Se cargan en tiempo de ejecución desde `<cwd>/skills` y `~/.mnemosine/skills` (`src/ai/skills/store.ts:199`): corriendo desde la raíz del repo, el modelo recibe estas tres como «firm skills». Las pruebas usan directorios temporales (`tests/ai/skills/store.spec.ts:36,109`), no las de la raíz. El código de `src/ai/skills/*.ts` es 0 % español en comentarios.

**Eval**: `src/ai/eval/golden.ts` encabezado de 35 líneas en español (`:5-39`); el vocabulario **persistido** del corpus golden es español: `ResultadoEsperado = 'draft' | 'pregunta' | 'determinista'` (`:41`), `lado: 'cargo' | 'abono'` (`:46`), campos `cuenta`, `monto`, `caso`, `precondicion.politicas` (`:44-60`) — leídos de `tests/golden/cfdi/*.esperado.json`.

**Texto persistido escrito por el modelo o el humano** (dato, no fuente): `ai_questions.question/answer/topic/context` (`src/ai/memory-service.ts:16-27`) alimentan el «Firm memory» del prompt (`system-prompt.ts:101-109`) en el idioma de la sesión; los borradores de skill se escriben como `SKILL.md` (`src/ai/skills/skill-drafts.ts:263`) en el idioma en que el modelo los redactó.

### 3.8 Documentación fuera de `src/`

`for f in docs/*.md README.md …` (acentos vs `the|and|of|with`): todo en español salvo **`docs/cli-command-registry.md`** (603 líneas, inglés: «REGISTRY — the binding dictionaries…») y **`docs/harness-best-practices.md`** (133 líneas, inglés). `docs/cli-command-catalog.md` (3 073 líneas) y `docs/plan-cierre-brechas.md` (8 371) en español. `docs/auditorias/`: 28 entradas en español. `README_ACCOUNTANT.md` (636) español.

**Commits**: `git log --format='%s' | wc -l` → 247; con acento 117; con palabras clave inglesas (`the|and|of|with|for|fix|add|remove|update`) 10, de los cuales 8 son Dependabot («Bump …») o «Merge branch». Prácticamente el 100 % de los commits humanos en español. Por mes: 2026-08 65 (38 con acento), 2026-09 182 (79 con acento) — «sin acento» no significa inglés: «S4b: el manual del agente no conocía tres de sus propias manos» no lleva acento.

**Salida de `npm run plan:status`**: `grep -c "enunciado:" src/plan/criterios.ts` → 135 enunciados, en español (p. ej. `:608` «El repositorio tiene remoto, así que la CI puede dispararse»). Es interfaz de desarrollador, no de usuario final.

---

## 4. Ejemplos con archivo:línea y clase

| # | archivo:línea | texto | clase | idioma |
|---|---|---|---|---|
| 1 | `CONTRIBUTING.md:158` | «Los comentarios y la documentación van en español, y explican el **porqué**.» | comentario (regla) | es |
| 2 | `src/ai/system-prompt.ts:25-27` | `You are Mnemosine, an expert accounting assistant … __RESPONSE_LANGUAGE__, with technical accounting precision.` | texto_emitido_a_tercero (al modelo) | en |
| 3 | `src/ai/system-prompt.ts:171-174` | `LANGUAGE_LINE = { es: 'Always respond in Spanish', en: 'Always respond in English' }` | texto_emitido_a_tercero | en |
| 4 | `src/ai/providers/config.ts:1117-1131` | «Language the AGENT answers in. CLI/UI text is always English … Default 'es'» / `return config.language ?? 'es'` | comentario + formato_locale | en |
| 5 | `src/ai/grounding.ts:49` | `answer with ONLY the single line "(sin datos del sistema)"` — cadena fija en español dentro de un prompt inglés, independiente del idioma de respuesta | texto_emitido_a_tercero | mixto |
| 6 | `src/ai/tools/docs-tools.ts:263-265` | «Reads the internal documentation of a system module. Use it BEFORE operating…» | texto_emitido_a_tercero (descripción de herramienta) | en |
| 7 | `src/ai/tools/docs-tools.ts:29` vs `:22` | «NIF serie A: los 8 postulados…» junto a «CFDI 4.0 (PUE/PPD, VAT), multi-PAC stamping» en el mismo índice inyectado al prompt | texto_emitido_a_tercero | mixto |
| 8 | `src/ai/tools/policy-tools.ts:353-355` + `:362-365` | comentario «Panel patológico (valores libres enormes): el tope de la herramienta lo cortará…» dos líneas encima de la descripción inglesa «Reads your firm's ACCOUNTING POLICY PANEL…» | comentario / texto_emitido_a_tercero | es / en |
| 9 | `src/services/sat/anexo24/validador.ts:1-47` | «F07b · EL VALIDADOR DE REGLAS DEL ANEXO 24 / ESTO NO ES UN XSD, Y EL NOMBRE DEL ARCHIVO NO DEBE DEJAR CREERLO…» | comentario (encabezado 47 líneas) | es |
| 10 | `src/ai/skills/trust-scanner.ts:1-30` | «SKILL TRUST SCANNER / Skills are EXECUTABLE CONFIG: a SKILL.md is a set of instructions a model will follow…» | comentario (encabezado 30 líneas) | en |
| 11 | `src/cli/init-command.ts:221-222` | «Idempotencia: lo ya configurado no se vuelve a preguntar, salvo / unless that section is requested explicitly with --section.» — cambia de idioma a mitad de frase | comentario | mixto |
| 12 | `src/services/accounting/iva-cash-basis.ts:74` | `// READING THE METODO DE PAGO` | comentario | mixto |
| 13 | `src/ai/compaction.ts:17-19` | «(auditoría 2026-08-31) — monetary amount the summary dropped. / En un agente CONTABLE el importe es la carga útil…» — inglés y español en el mismo bloque | comentario | mixto |
| 14 | `src/services/fiscal/inpc/periodo.ts:3-4` | `// F07c · EL PERIODO MENSUAL DEL INPC` — encabezado que cita el paquete del plan | comentario | es |
| 15 | `src/ai/docs/nif-registro.md:1-4` | «# NIF — Registro por tipo de operación (Series B, C y D) / Guía operativa: cómo se registra cada operación…» | texto_emitido_a_tercero (doc que lee el modelo) | es |
| 16 | `src/ai/docs/accounting.md:1-5` | «# Accounting engine: journal entries and periods … A POSTED entry is IMMUTABLE…» | texto_emitido_a_tercero | en |
| 17 | `src/ai/docs/MANIFIESTO.md:4` | cita `tests/ai/corpus-sincronia.spec.ts`, archivo inexistente | comentario (doc desfasada) | es |
| 18 | `src/ai/docs/manifiesto.json:1-4` | claves `_sin_revisar`, `manuales`, `hashes` | dato_vocabulario (esquema persistido en el repo) | es |
| 19 | `skills/month-end-close/SKILL.md:1-6` | `name: month-end-close / description: Month-end close workflow for a Mexican entity…` | texto_emitido_a_tercero (skill que lee el modelo) | en |
| 20 | `src/ai/eval/golden.ts:41,46` | `'draft' \| 'pregunta' \| 'determinista'`, `lado: 'cargo' \| 'abono'` | dato_vocabulario (corpus golden persistido) | mixto |
| 21 | `src/ai/tools/superficie.ts` (archivo) + `:29 SUPERFICIE_DESATENDIDA` | nombre de archivo e identificador en español en una carpeta donde todo lo demás es inglés | nombre_de_archivo / identificador | es |
| 22 | `src/database/migrations/040_el_secreto_que_el_compromiso_revelaba.sql` | nombre de migración en español (uno de 29) | nombre_de_archivo | es |
| 23 | `src/ai/memory-service.ts:16-27` | `question`, `answer`, `topic` de `ai_questions`, escritos por modelo/humano en el idioma de la sesión, inyectados luego al prompt | texto_persistido | mixto |
| 24 | `src/cli/mnemosine.ts:2039` | «Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)» | texto_de_usuario_renderizado | en |
| 25 | `src/plan/criterios.ts:608` | `enunciado: 'El repositorio tiene remoto, así que la CI puede dispararse'` — sale por `npm run plan:status` | texto_de_usuario_renderizado (desarrollador) | es |

---

## 5. Qué se rompe al cambiar (acoplamientos, con archivo:línea)

1. **El manifiesto del corpus hace hash del archivo entero, comentarios incluidos.** `scripts/corpus-manifiesto.ts:58-67 hashDe()` calcula el SHA-1 de blob de git del contenido completo. Traducir **un solo comentario** en cualquiera de los **49 archivos fuente** listados en `src/ai/docs/manifiesto.json` (46 sellados) hace fallar `npx tsx scripts/corpus-manifiesto.ts --check` en CI (`.github/workflows/ci.yml:158`). Volver a sellar es `--actualizar <manual.md>` **por manual** (12 manuales sellados), y la regla de la casa dice que sólo se sella tras releer el manual contra sus fuentes (`MANIFIESTO.md:36-39,51`; `corpus-manifiesto.ts:5-21`). Es decir: una pasada de traducción de comentarios obliga, o a **12 relecturas de manual**, o a decidir explícitamente que un cambio sólo-comentarios se resella sin releer (lo que el propio manifiesto llama «mentirse a sí mismo», `MANIFIESTO.md:38`), o a cambiar la compuerta para que haga hash del código sin comentarios (usar `sinComentarios`, `criterios.ts:207-226`), que es un cambio de diseño con su propio PR. Además `tests/ai/tools/policy-tools.spec.ts:21,735-751` importa `hashDe`/`leerManifiesto` y exige que `policy-tools.ts` esté declarado como fuente.

2. **`src/plan/criterios.ts` es robusto a comentarios por diseño, salvo 41 lecturas crudas.** 187 usos de `codigoDe()` (`:331-340`, quita comentarios: «Leer prosa como si fuera conducta es el error que este archivo existe para no cometer») frente a 41 de `crudoDe()` (`:170`; `grep -c 'crudoDe('` / `grep -c 'codigoDe('`). Los `crudoDe` que dependen de **prosa en un idioma concreto**:
   - `criterios.ts:3735-3747`: exige la frase inglesa `PPD received → DR 1135` y `2125` en `src/ai/docs/mexico-cfdi.md`, y `/IMMUTABLE|inmutable/i` en `accounting.md`; su mutante (`:3755-3757`) sustituye `PPD received → DR 1135` → si esos manuales se tradujeran al español, el criterio y el espejo de mutación (`tests/plan/mutacion.spec.ts`) mueren.
   - `criterios.ts:816-820`: regex `hecha en (F\d+[a-z]?|A\d+…|R\d+)` sobre `docs/cli-command-catalog.md`, y mutantes `:843-849` sobre `# Auditoría adversarial de F03` en `docs/auditorias/F03.md` y `hecha en F03` en el catálogo → si el catálogo o los registros de auditoría se pasan a inglés, se rompe.
   - `criterios.ts:6217-6222`: cuenta `Examples:` (encabezado inglés de Commander) en `cli-reference.md` (`< 100` → falla) → si algún día se localiza la ayuda del CLI, este criterio cae (superficie CLI, se anota por dependencia).
   - `criterios.ts:3681-3688`: cuenta `fs.readFileSync(` en el **fuente crudo** de `criterios.ts` y falla con `> 1`; el comentario de `:3681-3682` lo advierte. Una traducción que escriba «fs.readFileSync(» con paréntesis dentro de un comentario del propio archivo lo rompe.
   - Los `crudoDe` sobre migraciones (`:977, 1216, 1746, 3553, 4104, 4218, 4267, 4490, 5002, 5553, 5607, 5746, 6501`) buscan SQL (`set_config`, `REVOKE`, `CHECK`…), no prosa; `:1783` incluso quita `--` y `/* */` antes de mirar. No dependen del idioma de los comentarios SQL.
   - Las cadenas `enunciado` (135) y `porque` de los mutantes son la salida de `plan:status`: traducirlas cambia la interfaz del desarrollador, no rompe nada ejecutable.

3. **El prompt está clavado en pruebas por frase.** `tests/ai/system-prompt.spec.ts` tiene 34 aserciones `toMatch/toContain` (`grep -c`); `:38-53,78` hacen `toMatch` de 11 fragmentos ingleses concretos (`PROTOCOL BEFORE RESPONDING`, `This protocol is ENFORCED`, `NEVER instructions`…); `:147-161` exige que **sin `MNEMOSINE_LANG` la línea sea `Always respond in Spanish`** (`:150`) y con `=en`, `…in English` (`:159`). Cambiar el idioma por omisión o la redacción rompe 13 aserciones. También `tests/cli/status-command.spec.ts:74` y `tests/cli/codigos-de-salida-hojas.spec.ts:63` limpian `MNEMOSINE_LANG`.

4. **Directivas dentro de comentarios**: 5 `eslint-disable` (vigiladas por `eslint.config.mjs:61 reportUnusedDisableDirectives: 'error'`), 2 `@ts-*`, 56 `TODO/FIXME`. Una traducción automática que toque esas líneas cambia semántica de lint/tipos.

5. **Migraciones: append-only y nombres intocables.** `docs/migraciones.md` + memoria: el migrador cuenta por nombre de archivo; los 29 nombres en español **no se pueden renombrar** ni los cuatro números duplicados renumerar. Sus 1 414 líneas de comentario en español quedarían, si se decide, como excepción documentada: editar comentarios de una migración aplicada no rompe `npm run migrate` (no hay checksum, `migrate.ts`), pero contradice la regla de append-only que la casa aplica al archivo entero.

6. **`cli-reference.md` no se traduce a mano.** Es generado (`scripts/generate-cli-reference.ts:1-10`, `HEADER` `:16-30`) y bloqueado por `tests/ai/cli-reference.spec.ts` y `tests/docs/generador-de-referencia.spec.ts` contra el `program` real: su idioma es el de las descripciones de Commander (superficie CLI). Sus 15 líneas con acento son fugas de ayuda en español del CLI, no de este documento.

7. **Los manuales normativos (`nif-*`, `niif-*`) no tienen compuerta** (`MANIFIESTO.md:62-64`: «describen NORMAS EXTERNAS… Un hash de código no dice nada sobre ellos»). Traducirlos a inglés no rompería ninguna prueba — y por eso mismo nadie detectaría una traducción infiel. Su fuente de verdad (las NIF del CINIF) se publica en español; las IFRS en inglés. `niif-indice.md` tiene un bloque **generado** de `ifrs-registry.json` con prueba «regenerar no cambia nada» (`MANIFIESTO.md:60-61`): traducirlo a mano rompe esa prueba.

8. **Umbrales de cobertura por archivo** (`vitest.config.ts:82-112`, 11 rutas, entre ellas `src/services/jurisdiccion/jurisdiccion.ts:105` y `src/services/reporting/criterio-cierre.ts:112`): editar comentarios **no** mueve la cobertura; renombrar archivos españoles (`jurisdiccion.ts`, `criterio-cierre.ts`, `criterios.ts`, `superficie.ts`, `confirmacion.ts`… 27 nombres con palabras españolas por `find src -name '*.ts' | sed 's#.*/##' | grep -c -E -i 'superficie|confirmacion|jurisdiccion|…'`) sí los descoloca. `src/cli/kernel/audit.ts:197-209 LINEA_BASE` no cita rutas de archivo sino claves de violación de comandos (`'sat cred audit|R3 closed verb list|…'`) — no le afecta esta superficie.

9. **Skills de la raíz**: sin acoplamiento de pruebas (`store.spec.ts` usa temporales), pero se sirven al modelo en producción cuando el cwd es el repo (`store.ts:199`). Están en inglés mientras el agente responde en español por omisión: el modelo lee «Ask the human to run `mnemosine pending` (alias `pendientes`)» y contesta en español. Funciona, pero es el único lugar donde el «despacho» habla inglés.

10. **`docs/openapi.json`** se genera de Zod (`ci.yml:159-160`): las descripciones `.describe()` de `src/api` son superficie de API (otro inventario); las 49 de `src/ai/tools` sólo las lee el modelo.

---

## 6. Dependencias (quién referencia esta superficie por nombre o ruta)

- `src/ai/docs/manifiesto.json` → 49 rutas fuente (hash de contenido completo); `scripts/corpus-manifiesto.ts:23-24,58-67`; `.github/workflows/ci.yml:158`; `tests/cli/censo-superficie.spec.ts:708`; `tests/ai/eval/arnes-cableado.spec.ts:503`; `tests/ai/tools/policy-tools.spec.ts:21,735-751`; `src/plan/criterios.ts:3718-3760`; `package.json:31` (`corpus:estado`).
- `src/ai/docs/*.md` → `src/ai/tools/docs-tools.ts:22-44` (`DOC_TOPICS`, nombres de tema = nombres de archivo; `:229,238` `${topic}.md`); `src/ai/system-prompt.ts:3,136`; `src/plan/criterios.ts:3735,3745,6217`; `tests/ai/cli-reference.spec.ts`; `tests/docs/generador-de-referencia.spec.ts`; `tests/ai/tools/policy-tools.spec.ts:736` (`mnemosine.md`).
- `src/ai/system-prompt.ts` → `tests/ai/system-prompt.spec.ts` (frases literales y `LANGUAGE_LINE`); `src/ai/providers/config.ts:596-597,1113-1145`; `src/cli/mnemosine.ts:23,1066,2036-2058`; `src/cli/status-command.ts:9,253`.
- `src/ai/grounding.ts:41-52` → `tests/ai/grounding.spec.ts` y `tests/ai/providers/grounding-session.spec.ts`, y el prefijo bilingüe que el usuario ve en pantalla.
- `skills/*/SKILL.md` → `src/ai/skills/store.ts:199-221` (carga en tiempo de ejecución), `src/ai/skills/skill-drafts.ts:10,98,263`.
- `docs/cli-command-catalog.md`, `docs/auditorias/*.md` → `src/plan/criterios.ts:776-849`.
- Reglas: `CONTRIBUTING.md:96,158`, `docs/PROCESS.md:58`, `README.md:345-346`, `AGENTS.md:3` (por referencia), `eslint.config.mjs:58-61`.

---

## 7. Propuesta para los documentos rectores (sin decidir)

### 7.1 Lo que debe cambiar para «código en inglés»

**`CONTRIBUTING.md:158`** (y su espejo `README.md:345-346`). Hoy: «Los comentarios y la documentación van en español, y explican el porqué». Propuesta de redacción, manteniendo la segunda frase, que es la que importa:

> Los identificadores, los nombres de archivo, los comentarios y el JSDoc van en inglés, y explican el **porqué**. El qué ya lo dice el código; si no lo dice, arregla el código. Todo texto que ve una persona —CLI, API, informes, panel, mensajes del agente— se escribe en inglés como texto fuente y se sirve traducido por catálogo; el español es el primer catálogo y el idioma por omisión. Los catálogos, las migraciones ya aplicadas y los registros históricos (`docs/auditorias/`, `docs/HISTORY.md`) no se reescriben.

**`AGENTS.md`**: hoy no tiene regla de idioma y la hereda por referencia (`:3`). Un agente que lee sólo `AGENTS.md` (que es lo que hacen) infiere «español» del propio documento. Conviene una línea explícita en «Antes de escribir una línea» que diga el idioma del código y remita a `CONTRIBUTING.md` para la frontera código/superficie. Sin ella, la regla nueva no llega al ejecutor que más código escribe.

**`src/ai/docs/MANIFIESTO.md:4`**: corregir la referencia a `tests/ai/corpus-sincronia.spec.ts` (inexistente) por la compuerta real (`ci.yml:158`). No es de idioma, pero es el documento que gobierna la compuerta que más va a sonar durante una traducción de comentarios.

**Definir por escrito la frontera de esta superficie**, porque hoy no existe: (a) un comentario es código (inglés); (b) un manual de `src/ai/docs/` es *texto emitido al modelo*, no al usuario — hay que decir si va con el código (inglés) o con la normativa (idioma de la fuente); (c) `skills/` de ejemplo: son voz del despacho, no del sistema; (d) el vocabulario persistido del corpus golden (`cargo/abono`, `pregunta/determinista`) es dato con lectores y no se renombra sin migración.

### 7.2 Lo que puede seguir en español si el dueño lo decide — pros y contras

**Mensajes de commit (`CONTRIBUTING.md:96`, `docs/PROCESS.md:58`).**
- A favor de mantener el español: 247 commits ya escritos en ese estilo; el cuerpo «explica el porqué» y hoy está encadenado a `docs/auditorias/` y `docs/plan-cierre-brechas.md` (787 comentarios citan códigos de paquete cuya prosa está ahí); el equipo humano y el revisor (`docs/ROUTING.md`) trabajan en español; no hay ninguna prueba ni criterio que lea un mensaje de commit.
- En contra: un contribuidor externo (`CONTRIBUTING.md` habla de fork y PR) que lea código en inglés y `git blame` en español tiene dos idiomas por línea; las herramientas de release notes / changelog automáticos leen commits.

**Documentación de proceso y plan (`AGENTS.md`, `docs/PROCESS.md`, `docs/SCOPE.md`, `docs/HISTORY.md`, `docs/auditorias/`, wiki).**
- A favor de mantener: `docs/PROCESS.md:54` («No se reescribe el pasado») y los criterios de `criterios.ts:776-849` que anclan frases españolas de `docs/auditorias/` y del catálogo; son 28 registros + 8 371 líneas de plan; su lector es el equipo, no el usuario del producto.
- En contra: `AGENTS.md` es lo que lee cada agente antes de tocar código; si el código pasa a inglés y el contrato sigue en español, el agente escribe comentarios en el idioma del contrato (es lo que ha pasado hasta hoy, ver §3.4: la línea base nació en español sin que ninguna regla escrita lo pidiera).

**Manuales normativos del agente (`nif-*`, `niif-*`, 2 405 líneas).**
- A favor de dejarlos en español: la fuente (NIF del CINIF) es española y el agente cita la norma textual («NIF D-1», `system-prompt.ts:58-65`); no hay compuerta que detecte una traducción infiel (`MANIFIESTO.md:57-60`); el usuario objetivo por omisión responde en español (`config.ts:1118`).
- En contra: el prompt, las herramientas y los otros 14 manuales están en inglés; el índice del prompt (`docs-tools.ts:22-44`) mezcla idiomas en la misma lista; con un despacho estadounidense (`MNEMOSINE_LANG=en`) el modelo lee normativa en español y responde en inglés — funciona, pero la NIIF/IFRS tiene fuente inglesa y hoy está resumida en español.

**Skills de ejemplo (`skills/`).** Hoy en inglés. A favor de pasarlas a español: son «guided workflows written by the accounting team» (`skills-tools.ts:32`), el despacho por omisión es mexicano y el borrador que el agente redacta (`skill-drafts.ts`) saldrá en el idioma de la sesión. En contra: son plantillas de producto y el resto del corpus es inglés; podrían existir en ambos idiomas como ejemplo de que un despacho escribe en el suyo.

**Comentarios existentes (22 721 líneas en español, 12 067 en bloques de 8+ líneas).** Opción «regla hacia adelante» (nuevo código en inglés, lo viejo se traduce al tocarlo): no rompe el manifiesto de golpe (sólo el archivo tocado, que ya obliga a resellar su manual), no toca directivas, y mantiene el 69 % de JSDoc español visible en el IDE durante meses. Opción «pasada masiva»: 49 archivos del manifiesto → 12 relecturas o un cambio de compuerta; 5 + 2 directivas a proteger; 787 referencias a paquetes del plan cuya prosa seguirá en español; riesgo de perder matiz en 328 bloques de 15+ líneas que son argumentos, no etiquetas. Ninguna de las dos se decide aquí.

---

## 8. Resumen

En `src/` hay 29 309 líneas de comentario (376 archivos, 150 808 líneas): 22 721 en español (78 %), 5 498 en inglés (19 %), y el JSDoc va 2 343 es / 961 en (3 402 bloques); el español no es lo viejo ni lo nuevo (81 % en la línea base, 76 % en lo más tocado), sino el estilo de la casa desde el primer commit, formalizado seis días después en `CONTRIBUTING.md:158`, `docs/PROCESS.md:58` y `README.md:345`, y ausente por escrito en `AGENTS.md`. La mitad de ese español (12 067 líneas) está en bloques de 8+ líneas que argumentan el porqué y citan 787 veces paquetes del plan cuya prosa vive en `docs/auditorias/`, de modo que traducir comentarios es traducir ensayos con notas al pie en otro idioma. El corpus del agente ya está en inglés donde es sistema —prompt (`system-prompt.ts:25-88`), 25 herramientas y 49 parámetros, 14 manuales, 3 skills— y en español donde es norma (14 manuales `nif-*/niif-*`) y donde es dato (memoria, golden, claves del manifiesto); el idioma de respuesta se decide en un único punto (`config.ts:1119-1131`, omisión `'es'`) y `grounding.ts:49` cuela una cadena fija en español. Lo que rompe una pasada de traducción no son los criterios (187 de 228 lecturas quitan comentarios a propósito) sino el manifiesto del corpus, que hace hash del archivo entero en 49 fuentes (`corpus-manifiesto.ts:58-67`) y obliga a releer 12 manuales o a rediseñar la compuerta, más 7 directivas de lint/tipos, 13 aserciones literales en `system-prompt.spec.ts` y tres criterios que anclan frases en un idioma concreto en docs (`criterios.ts:816,3735,6217`).
