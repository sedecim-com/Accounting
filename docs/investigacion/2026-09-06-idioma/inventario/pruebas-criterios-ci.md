# Inventario de idioma · pruebas, criterios, CI y metros

Superficie: `tests/`, `src/plan/criterios.ts` (+ `conducta.ts`, `status.ts`), `vitest.config.ts`,
`vitest.integration.config.ts`, `src/cli/kernel/audit.ts` (`LINEA_BASE`), `src/ai/docs/manifiesto.json`,
`docs/cli-command-catalog.md` + `scripts/catalogo-estado.ts`, `scripts/*`, `.github/workflows/*`,
`package.json` (scripts).

Árbol medido: `/Users/victor/projects/Accounting` en `b31e62a` («Investigación normativa y de motores:
la jurisdicción como dimensión (#135)», 2026-09-06). **El árbol NO está limpio**: otra sesión tiene
sin comprometer `src/ai/doctor-service.ts`, `src/services/accounting/{iva-cash-basis,iva-ppd-reclass,pais-contable}.ts`,
`tests/accounting/iva-cash-basis.spec.ts`, `tests/ai/doctor-service.spec.ts`, `vitest.config.ts`
(+7 líneas: el `include` de `src/services/jurisdiccion/**`) y los no rastreados `src/services/jurisdiccion/`,
`tests/accounting/iva-ppd-reclass.spec.ts`, `tests/services/jurisdiccion/` (`git status --short`,
`git diff --stat`). Los conteos de abajo son sobre el árbol de trabajo, no sobre el commit; donde importa se dice.

Nada del repositorio se editó. Los guiones de medida y sus salidas crudas están en
`/tmp/investigacion-idioma/inventario/metodo/` (`clasificar-tests.js`, `clasificar-criterios.js`,
`tests-clasificacion.json`, `criterios-clasificacion.json`, `tests-salida.txt`, `tests-por-dir.txt`).

Nota de disciplina: varios archivos contienen instrucciones a quien los mantiene («regenera con…»,
«sube la línea base a mano y dilo en el commit», «sella con `--actualizar`»). Se leyeron como dato;
sólo se corrieron modos de lectura (`--check`, `--json`, `plan:status` sin banderas, `mutantes`, que
muta en memoria). Ningún `--actualizar`, `--apretar` ni regeneración.

---

## 1. Método y comandos

| Cifra | Comando exacto |
|---|---|
| Archivos `.ts` en `tests/` | `find tests -type f -name '*.ts' \| wc -l` → **343** (336 `.spec.ts`: 248 unitarios + 88 `tests/integration/**/*.int.spec.ts`; 7 ayudantes sin `describe`) |
| Títulos `describe/it/test` por idioma | `node metodo/clasificar-tests.js /Users/victor/projects/Accounting` — extrae el primer literal de `describe(`/`it(`/`test(` (y `.skip/.only/.todo`), puntúa palabras funcionales ES vs EN + acentos/ñ/¿¡; `indeterminado` = sin ninguna palabra funcional (casi siempre `describe('nombreDeFuncion')`) |
| Conteo crudo de `describe(` | `grep -rhoE '\bdescribe(\.(skip\|only\|each\|todo))?\s*\(' tests --include='*.ts' \| wc -l` → **1535** (el guion titula 1533: dos `describe(` viven en comentarios/cadenas) |
| Archivos de prueba con NOMBRE castellano | mismo guion, conjunto (a) de tokens castellanos comunes; los términos fiscales MX (`cfdi sat diot isn imss infonavit isr iva rfc clabe pac ppd rep inpc anexo24 nomina finiquito agrupador polizas balanza`) se cuentan aparte (b) |
| Tests que importan módulos con nombre castellano | mismo guion: `from '…'`, `import('…')`, `vi.mock('…')` relativos; nombre base o directorio con token (a) |
| Tests que leen fuente por RUTA (no por import) | `grep -rln "readFileSync\|rutaDe(\|path.join(.*'src\|'src/\|\"src/" tests --include='*.ts' \| wc -l` → **50** |
| Criterios | `grep -c 'paquete:' src/plan/criterios.ts` → 135 (1 es el campo de la interfaz l.75, 1 es el mapeo l.6641) ⇒ **133 literales** + `...PRUEBAS_DE_CONDUCTA.map(criterioDeConducta)` (criterios.ts:6138; `grep -c 'paquete:' src/plan/conducta.ts` → 4, uno es el tipo) ⇒ **136**. Confirmado con `npx tsx src/plan/status.ts \| tail -3`: «136 criterios · 133 leen el fuente · 3 ▶ ejecutan…» |
| Criterios con ruta / identificador castellano | `node metodo/clasificar-criterios.js …` — parte el array `CRITERIOS` por cada `    paquete:`; extrae literales `'src/…'`, regex `/…/`, `.includes('…')`, `consumidoresDe('…')`, anclas `de:` y `archivo:` de mutantes; marca tokens castellanos (camelCase y snake_case partidos) |
| Mutantes | `npx tsx scripts/mutantes.ts \| tail -8` → «136 criterios · 78 con espejo · 58 sin espejo · 120 mutantes … 120 murieron» |
| Rutas citadas por criterios | `grep -oE "'(src\|tests\|docs\|scripts\|\.github)/[^']+'" src/plan/criterios.ts \| sort -u \| wc -l` → **182** literales (181 sin contar un duplicado por comillas) |
| Umbrales por archivo | `grep -n "'src/" vitest.config.ts` / `vitest.integration.config.ts` |
| `LINEA_BASE` | `sed -n '197,236p' src/cli/kernel/audit.ts \| grep -c "^  '"` → **36** entradas |
| Manifiesto del corpus | `python3 -c "import json;m=json.load(open('src/ai/docs/manifiesto.json'));print(len(m['manuales']),len(m['hashes']),len(set(sum(m['manuales'].values(),[]))))"` → **13 manuales, 46 hashes, 49 fuentes declaradas** (3 sin sellar: `payroll.md` está en `sin_revisar`) |
| Citas `archivo:línea` del catálogo | `grep -oE '(src\|tests\|scripts)/[A-Za-z0-9_/.\-]+\.(ts\|sql):[0-9]+' docs/cli-command-catalog.md \| sort -u \| wc -l` → **616** citas únicas sobre **171** archivos; el bloque generado (l.81) dice «1 de 616 … ya no resuelven» |
| Referencias documentales a rutas de tests | `grep -rhoE 'tests/[A-Za-z0-9_./-]+\.ts' docs AGENTS.md CONTRIBUTING.md README.md \| sort -u \| wc -l` → **259**, de las que **145 ya no existen** (bucle `[ -e "$p" ]`) |
| Menciones `npm run <script>` | `grep -rhoE 'npm run (plan:status\|catalogo:estado\|ux:status\|corpus:estado\|mutantes\|costo:por-fila\|reclass:iva-ppd\|backfill:account-roles\|eval\|openapi)' docs src scripts tests .github AGENTS.md CONTRIBUTING.md README.md CLAUDE.md \| sort \| uniq -c` |
| Migraciones con nombre castellano | `ls src/database/migrations \| grep -cE '^0(3[4-9]\|[4-6][0-9])_'` → **36 de 74** (034–069, todas) |
| Aserciones sobre texto en `tests/cli` | `grep -c "toContain(\|toMatch(" tests/cli/*.spec.ts` (suma) → 910; literales largos `toContain('…≥12 chars')` → 173, de los que **5** llevan marca castellana |

---

## 2. Conteos

### 2.1 `tests/`

| Qué | Cuántos |
|---|---|
| Archivos `.ts` | 343 (336 spec; 248 unitarios, 88 integración; 7 ayudantes) |
| Títulos extraídos (`describe`+`it`+`test`) | 7 391: **4 831 es (65 %)**, **1 999 en (27 %)**, 44 mixtos, 517 indeterminados (identificadores) |
| — `describe` | 1 533: 860 es · 178 en · 11 mixtos · 484 indeterminados (`describe('runDoctor — database')`, `describe('exigirSegregacion')`…) |
| — `it`/`test` | 5 858: 3 971 es · 1 821 en · 33 · 33 |
| `it.each`/`describe.each` (no se titulan) | 44 |
| Archivos por idioma mayoritario de sus títulos | **232 es · 104 en** · 7 sin títulos |
| Por carpeta (es/en): | `integration` 88/0 · `services` 41/11 · `cli` 25/23 · **`ai` 17/45** · `api` 12/4 · `accounting` 10/3 · `sat` 9/0 · `payroll` 5/6 · `database` 6/1 · `xml-ingestion` 5/3 · `plan` 4/0 · `docs` 2/0 · `integrations` 3/0 · `auth` 2/2 · `config` 2/1 · `utils` 1/1 · `fiscal-credentials` 0/2 · `vault` 0/2 |
| Spec con nombre de archivo castellano (a) | **139 de 336** (p. ej. `tests/cli/codigos-de-salida.spec.ts`, `tests/integration/g1a-cifras-que-se-firman.int.spec.ts`, `tests/plan/mutacion.spec.ts`) |
| Spec con nombre sólo de dominio MX (b) | 22 (`iva-cash-basis.spec.ts`, `cfdi-pagos.spec.ts`, `finiquito-math.spec.ts`…) |
| Tests que importan ≥1 módulo con nombre castellano (a) | **82 archivos → 46 módulos distintos**. Los más importados: `tests/integration/helpers/servidor` (11), `src/plan/criterios` (6), `tests/helpers/entidades` (5), `src/ai/tools/superficie` (5), `src/services/sat/anexo24/balanza-invariantes` (5), `src/services/jurisdiccion/jurisdiccion` (4), `src/services/reporting/criterio-cierre` (4), `src/api/rest/montajes` (4) |
| Tests que importan módulos de dominio MX (b) | 46 archivos → 28 módulos (`cfdi-parser`, `sat-agrupadores`, `iva-ppd-reclass`, `pac-router`…) |
| Tests que leen fuentes por ruta literal | 50 (p. ej. `tests/ai/cli-reference.spec.ts:27` lee `src/ai/docs/cli-reference.md`; `tests/config/env-example.spec.ts:84`; `tests/ai/niif-registry.spec.ts:22`; `tests/integration/helpers/sql-scan.ts:53` recorre `src/`) |

Lectura: la suite es **bilingüe por capas de edad**. `tests/ai` y las pruebas de plomería del agente
nacieron en inglés (`tests/ai/providers/config.spec.ts` 0/60, `tests/ai/skills/skill-drafts.spec.ts` 0/24);
todo lo escrito desde el plan de cierre (integración, sat, plan, docs, servicios contables) está en
castellano, incluidos los nombres de archivo con código de paquete (`f05c-ataque.int.spec.ts`, `g3-quien-firmo.int.spec.ts`).

### 2.2 `src/plan/criterios.ts` (6 648 líneas) y satélites

| Qué | Cuántos |
|---|---|
| Criterios | 136 (133 de lectura en `criterios.ts` + 3 de conducta en `conducta.ts:275,349,438`) |
| Criterios que citan ≥1 ruta literal | **117 de 133** |
| Rutas literales únicas citadas | 181; **49 con tokens castellanos** (16 migraciones `04x_/05x_/06x_…sql`, `criterio-cierre.ts`, `superficie.ts`, `permisos.ts`, `consulta-publica.ts`, `rls-guard.ts`, `barrido-entregas.ts`, `rep-pendientes.ts`, `descarga-masiva.ts`, `puntuacion.ts`, `riesgos-retrofit.ts`, `balanza-*.ts`, `polizas-service.ts`, `artefactos.ts`, `finiquito-math.ts`, `cfdi-nomina-generator.ts`, `factor.ts`, 4 scripts, `tests/plan/mutacion.spec.ts`, `tests/cli/ejemplos-de-ayuda.spec.ts`, `tests/golden/cfdi`, `manifiesto.json`) |
| Criterios cuyo `evaluar` hace grep de un IDENTIFICADOR castellano (regex/`includes`/`consumidoresDe`) | **≥60 de 133** (lista completa en §4.2) |
| Criterios con ruta castellana | 46 |
| Criterios con algo castellano (ruta, patrón, ancla o archivo de mutante) | **78 de 133** |
| Mutantes declarados | 120 (`archivo:` + `de:` literal + `a:`); **30** apuntan a un archivo de nombre castellano; **38** de las 119 anclas `de:` contienen identificadores castellanos; hoy **120/120 mueren** |
| Criterios sin espejo (línea base que sólo encoge) | 58 (`tests/plan/mutacion.spec.ts:52 SIN_ESPEJO_MAXIMO = 58`) |
| Piso de criterios | `docs/criterios-minimos.json` → **69 «verdes»**, identidad = `paquete · enunciado` en castellano (`src/plan/status.ts:165`) |
| Rutas de `tests/` que un criterio nombra | 6: `tests/plan/mutacion.spec.ts` (3669-3672), `tests/cli/ejemplos-de-ayuda.spec.ts`, `tests/cli/completion-command.spec.ts` (6191), `tests/integration/global-setup.ts` (1108-1109, 1411), `tests/integration/helpers/sql-scan.ts`, `tests/golden/cfdi` (3157) |
| Ids de jobs de CI que un criterio exige por nombre | 5: `criterios.ts:701 NOMBRES = ['typecheck','unit','integration','aislamiento','restauracion']` (regex `^  ${j}:` sobre `ci.yml`; espejo l.729-737 renombra `restauracion:` y exige rojo) |

### 2.3 Umbrales de cobertura POR ARCHIVO (claves = rutas)

- `vitest.config.ts:35-39` `coverage.include` = `src/services/accounting/**`, `src/services/jurisdiccion/**` (sin comprometer), `src/services/reporting/**`, `src/utils/sequence.ts`.
- `vitest.config.ts:91-115` **6 claves**: `posting.ts` (92), `validation.ts` (95), `ar-ap-posting.ts` (98), `src/utils/sequence.ts` (101), `report-service.ts` (105), **`criterio-cierre.ts`** (112, castellano).
- `vitest.integration.config.ts:57-104` **9 claves**: `period-close.ts` (60), `ledger-checks.ts` (64), `posting.ts` (71), `ar-ap-posting.ts` (75), `validation.ts` (79), `iva-cash-basis.ts` (85), `report-service.ts` (93), **`criterio-cierre.ts`** (97), `cash-flow-service.ts` (101).
- **Las mismas claves están DUPLICADAS en el instrumento**: `src/plan/criterios.ts:575-589 SUELO_COBERTURA_UNITARIA` (6 rutas) y `:590-604 SUELO_COBERTURA_INTEGRACION` (9 rutas); el criterio «La cobertura del motor contable tiene trinquete por archivo» (`:996-1040`) lee `vitest.config.ts` con `umbralesDeclarados`/`contraSuelo` (`:483`, `:530`) y compara clave por clave. Su segundo espejo (`:1023-1029`) es literalmente «renombrar `criterio-cierre.ts` → `otro-archivo.ts`» y exige rojo: **un renombre del archivo sin tocar las tres tablas a la vez es, por diseño, un fallo de CI**.
- Un archivo nuevo en `posting.ts` necesita spec propio (memoria de la casa): el umbral 99/95/100/99 no tolera funciones sin cubrir.

### 2.4 `src/cli/kernel/audit.ts` `LINEA_BASE` (l.197-236)

36 entradas con clave `comando|regla|detalle` (`claveDeViolacion` l.188-194, dígitos → `#`). Comandos y
reglas ya están en **inglés** (`'pending define|R3 closed verb list|"define" is not a verb…'`). La prueba
`tests/cli/kernel/auditoria-programa.spec.ts:67` guarda una `FOTO_ORIGINAL` congelada (subconjunto, no conteo).
Un renombre de identificadores TS no la toca; sólo la mueve renombrar un COMANDO, una regla o la
redacción del `detail`. Los verbos del CLI son lista cerrada inglesa con alias castellano biyectivo
(`src/cli/kernel/vocabulary.ts:22 VERBS`, `:133 OBJECTLESS_COMMANDS`); `tests/cli/bilingual-matrix.spec.ts:25 TOP_LEVEL`
fija el mapa canónico→alias y `:310-323` exige que la ayuda NO tenga castellano (`SPANISH_LEFTOVERS` l.208).

### 2.5 `src/ai/docs/manifiesto.json`

13 manuales → 49 fuentes → 46 hashes `git hash-object` por RUTA (`scripts/corpus-manifiesto.ts:58-66`).
`revisar()` (l.75-92) devuelve `desapareció` si la ruta ya no existe (l.84) y `cambió` si el contenido
cambió (l.89); `--check` sale 1 (l.173) y corre en `ci.yml:158`. **Hoy ya está en rojo en este árbol**
por los cambios sin comprometer: `mexico-cfdi.md ← src/services/accounting/iva-cash-basis.ts` y
`playbooks.md ← src/ai/doctor-service.ts` (`npx tsx scripts/corpus-manifiesto.ts --check`). Las 46 rutas
selladas son inglesas salvo ninguna: el manifiesto no nombra archivos castellanos, pero **cualquier
renombre de identificadores dentro de esas 46 fuentes cambia su hash** y la regla de la casa exige
releer el manual antes de sellar (l.29-55 y el mensaje de l.174-177), no sellar en bloque.

### 2.6 `docs/cli-command-catalog.md` (3 073 líneas) y `scripts/catalogo-estado.ts` (565)

- **Casan por NOMBRE DE COMANDO, no de archivo**: `filasDelCatalogo` (l.145-159) parsea filas
  `| \`mnemosine …\`` y reduce a `ruta` (verbos sin argumentos, `rutaDe` l.122-127); `arbolVivo()` (l.42-53)
  recorre el `program` real; `sinFila` (l.102-108) falla `--check` si una hoja viva no tiene fila
  (ci.yml:153). El alias castellano de cada fila es la celda `es` (l.170-172), dato del documento.
- Además `citasDe` (l.243-253) extrae **616 citas `archivo:línea`** sobre 171 archivos (`src|tests|scripts`) y
  `medir` comprueba existencia y rango de línea; el resultado va al bloque generado (l.81: «1 de 616 … ya
  no resuelven»). Con mi patrón, **4** de los 171 archivos citados tienen nombre castellano
  (`src/ai/tools/superficie.ts`, `src/plan/criterios.ts`, `src/services/payroll/mx/cfdi-nomina-generator.ts`,
  `src/services/payroll/mx/finiquito-calculator.ts`). Un renombre no rompe `--check` por sí mismo: cambia
  el bloque (el texto «N de 616 citas… no resuelven») y `--check` exige regenerarlo (l.547-556); la degradación
  queda publicada, no bloqueada. Los **números de línea** de las 616 citas se desplazan con cualquier
  reescritura del archivo citado (se detecta sólo si la línea cae fuera del archivo).
- Suelo: `docs/catalogo-minimos.json` (`invocables: 214`, `fase1Invocables: 194`) — números, no nombres.

### 2.7 `scripts/` (17 archivos: 13 `.ts`, 2 `.sh`, 2 `.sql`)

| Script | Nombre | En CI | Quién lo nombra por ruta |
|---|---|---|---|
| `catalogo-estado.ts` | es | `ci.yml:153` | `criterios.ts:711 PUERTAS`, `tests/docs/catalogo-estado.spec.ts:1-13`, package.json:26, 27 citas en docs |
| `corpus-manifiesto.ts` | es | `ci.yml:158` | `criterios.ts:3718-3729` (+regex `corpus-manifiesto\.ts --check`), package.json:31 |
| `ux-status.ts` | en | `ci.yml:176` | `criterios.ts:6352-6357` (espejo ancla en la línea exacta del YAML) y `:6364-6372`, `tests/cli/censo-superficie.spec.ts`, package.json:27 |
| `openapi.ts` | en | `ci.yml:166` | package.json:32 |
| `eval-clasificador.ts` | es | `ci.yml:423` (`npm run eval`) | `criterios.ts:3165`, `:6390-6403`, `tests/ai/eval/arnes-cableado.spec.ts`, package.json:33 |
| `provision-roles.sql` | en | `ci.yml:304` | `criterios.ts:1393`, `:2642`; 46 citas en docs |
| `verify-isolation.sh` | en | `ci.yml:312` | `criterios.ts:1407`, `:711` |
| `mutantes.ts` | es | no (`npm run mutantes`) | package.json:25, 11 menciones en docs |
| `costo-por-fila.ts` | es | no | `criterios.ts:4003-4023`, package.json:28 |
| `generate-cli-reference.ts` | en | no (lo cubren `tests/ai/cli-reference.spec.ts`, `tests/docs/generador-de-referencia.spec.ts`) | `criterios.ts:6203-6211` |
| `build-niif-indice.ts` | mixto | no (`tests/ai/niif-registry.spec.ts`) | — |
| `reclasificar-iva-ppd.ts`, `rellenar-roles-de-cuenta.ts` | es | no | package.json:29-30 (con nombres npm en inglés parcial: `reclass:iva-ppd`, `backfill:account-roles`) |
| `artefacto-catalogo.ts`, `publicar-wiki.sh`, `rol-auditor.sql` | es | no | docs |

11 de 17 nombres son castellanos o mixtos. Las cabeceras están en castellano salvo
`generate-cli-reference.ts:1-9`, `build-niif-indice.ts:1-7` y `openapi.ts` (mixto). Docs citan 25 rutas
de `scripts/` distintas, y varias ya no existen (`scripts/e2e-arap.ts` ×35, `scripts/backfill-account-roles.ts` ×8,
`scripts/build-nif-indice.ts` ×8): las citas documentales a scripts ya rotan sin puerta.

### 2.8 `.github/workflows/`

- `ci.yml` (436 líneas): 8 jobs — ids `typecheck`(33) `lint`(46) `unit`(61) `plan`(76) **`restauracion`**(185)
  `integration`(229) **`aislamiento`**(263) `eval`(338); `name:` en castellano («Tipos», «Pruebas unitarias»,
  «Estado del plan», «Ensayo de restauración», «Integración contra Postgres», «Aislamiento por inquilino», «Eval del clasificador»).
  Comentarios: castellano. `--exigir` es **por PAQUETE del plan, no por paquete npm**:
  `ci.yml:145 npm run plan:status -- --piso --exigir=E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E2.1,E2.2,E3.1` (10 paquetes);
  `src/plan/status.ts:391` falla si un id exigido no existe. `--piso` compara los 69 enunciados de
  `docs/criterios-minimos.json` (`status.ts:311`) por identidad textual (`compararConPiso` l.173-197).
  `ci.yml:225` filtra integración por PREFIJO de ruta `tests/integration/s3-` (hoy 1 archivo: `s3-respaldo.int.spec.ts`).
- `witness-triage.yml` (228): listener de PR, no puerta. Su lista de palabras seguras del detector de
  secretos es bilingüe a propósito (l.75: `…|ejemplo|prueba|mentira|ficticio|fals[ao]`) y el detector de
  `TODO` está anclado a `//`+`:` porque «el repositorio está EN ESPAÑOL» (l.113-150). Ninguna ruta.

### 2.9 `package.json` scripts

Castellano o mixto: `plan:status`(24), `mutantes`(25), `catalogo:estado`(26), `costo:por-fila`(28),
`reclass:iva-ppd`(29), `corpus:estado`(31). Inglés: `ux:status`, `backfill:account-roles`, `openapi`, `eval`,
`test*`, `lint`(18, `--max-warnings 1117`), `typecheck:tests`(23). Menciones `npm run …` en docs/src/scripts/tests/workflows:
`plan:status` **91**, `catalogo:estado` 31, `eval` 19, `ux:status` 16, `mutantes` 11, `costo:por-fila` 10,
`backfill:account-roles` 9, `reclass:iva-ppd` 3, `openapi` 1, **`corpus:estado` 0** (CI usa `npx tsx scripts/corpus-manifiesto.ts --check`).
`CLAUDE.md:8`, `AGENTS.md:8` y `docs/PROCESS.md:38` ordenan correr `plan:status` y `catalogo:estado` por nombre.

---

## 3. Reglas de la casa que este inventario confirma (dato, no objeción)

- `CONTRIBUTING.md:158` y `README.md:345`: «Los comentarios y la documentación van en español»; `docs/PROCESS.md:58` y `CONTRIBUTING.md:96`: commits en español.
- El CLI ya es **inglés canónico + alias castellano** (`vocabulary.ts:1-20`, `bilingual-matrix.spec.ts:5-11`), y su ayuda se exige en inglés
  (`bilingual-matrix.spec.ts:310-323`; `scripts/ux-status.ts:299-330 PALABRAS_CASTELLANAS`/`fueraDeIdioma` cuenta como defecto la prosa
  castellana en pantalla: línea base `nodos-fuera-del-idioma-canonico: 7`, `hojas-sin-alias-castellano: 17`, `ux-status.ts:210-215`).
  Es decir: en el CLI el pedido del dueño («fuente en inglés») ya se cumple para nombres y ayuda; lo que NO existe es la
  capa de catálogo que traduzca la ayuda/mensajes al castellano — hoy el castellano en pantalla se penaliza.
- Migraciones append-only con 4 números duplicados (`docs/migraciones.md`, `tests/database/migration-numbering.spec.ts:9-23`):
  **36 de 74 archivos de migración tienen nombre castellano (034–069) y no pueden renombrarse**; 16 de ellos los nombran criterios
  (`existe('src/database/migrations/041_el_mayor_inviolable.sql')`, criterios.ts:1241 etc.).

---

## 4. Ejemplos con archivo:línea y clase

### 4.1 Pruebas

| archivo:línea | texto | clase | idioma |
|---|---|---|---|
| `tests/accounting/ar-ap-posting-f03.spec.ts:137` | `describe('la nota de crédito deshace el IVA en la cuenta donde la factura lo dejó')` | comentario (título de prueba) | es |
| `tests/accounting/ar-ap-posting-iva.spec.ts:174` | `describe('the four issuance cases land in the four accounts')` | comentario | en |
| `tests/ai/compaction.spec.ts:267` | `it('matches RFCs with Ñ/& initial characters…')` | comentario | mixto |
| `tests/accounting/exigir-segregacion.spec.ts` | `describe('exigirSegregacion')` | identificador | es |
| `tests/cli/codigos-de-salida.spec.ts` (nombre) | — | nombre_de_archivo | es |
| `tests/integration/g1a-cifras-que-se-firman.int.spec.ts` (nombre; citado en `vitest.config.ts:72`) | — | nombre_de_archivo | es |
| `tests/plan/mutacion.spec.ts:52` | `const SIN_ESPEJO_MAXIMO = 58;` | identificador (trinquete) | es |
| `tests/cli/kernel/auditoria-programa.spec.ts:67` | `const FOTO_ORIGINAL = new Set([ 'entities\|R1 objectless allowlist\|"entities" is a top-level command…' ])` | dato_vocabulario (clave de violación, inglés) | en |
| `tests/cli/bilingual-matrix.spec.ts:25` | `const TOP_LEVEL: Record<string,string> = { ledger: 'mayor', entity: 'entidad', … }` | dato_vocabulario | mixto |
| `tests/cli/bilingual-matrix.spec.ts:310` | `describe('help text is English', …)` | comentario | en |
| `tests/ai/cli-reference.spec.ts:27` | `readFileSync(path.join(…,'src','ai','docs','cli-reference.md'))` | nombre_de_archivo (lectura por ruta) | en |

### 4.2 Criterios que hacen grep de identificadores o rutas castellanas (lista de patrones)

Formato: `criterios.ts:línea · paquete · patrón(es)`.

- 1255 E0.1 · `/checkLedgerIntegrity/`, `/checks\.push\(await checkLedgerIntegrity\(\)\)/` (mixto)
- 1280 E0.1 · `/bloquearPeriodoParaPostear\(client/g`
- 1342 E0.1 · `/fecha:\s*Date \| string/`, `/exec\(String\(fecha\)/` + ruta `043_la_serie_del_folio_por_ejercicio.sql`
- 1418 E0.1 · `/key: 'segregacion_de_funciones'/`, `/'exigir'/`, `/async function autorizarPosteo/`, `/export async function exigirSegregacion/`, `/exigirSegregacion\(\{/`, `/politica\.value === 'exigir'/g`, `/SOD_QUIEN_CREA_NO_POSTEA/`
- 1493 E0.1 · `/consultaCfdi\(/` + ruta `046_el_espejo_del_cfdi.sql`
- 1584 E0.2 · `/columnasCalificadas/`
- 1729 E0.3 · `/registrarAuditoria/g` · 1933 E0.3 · `consumidoresDe('registrarAuditoria', …)`
- 2235 E1.4 · `/export function indiceDeCalendario\(/`, `/indiceDeCalendario\(/`
- 2394 E2.1 · `/auditarRaiz\(\s*typeDefs/`, `/throw new CompuertaAbiertaError\(huecos\);/` + ruta `src/api/graphql/permisos.ts`
- 2528 E2.1 · `/throw new RolIgnoraRlsError/`, `/verificarRolSujetoARls/` + ruta `src/database/rls-guard.ts`
- 2614 E2.1 · `/CREATE POLICY verificacion_publica/g` + ruta `src/database/consulta-publica.ts`
- 2718 E3.2 · `/SolicitaDescarga/i` + rutas `src/services/sat-download/descarga-masiva.ts` (no existe: criterio en rojo a propósito)
- 2927 E5.1 · `/herramientas:[^\n]*SUPERFICIE_DESATENDIDA/` + ruta `src/ai/tools/superficie.ts`
- 2957 E5.1 · `consumidoresDe('conLlave', …)` + ruta `src/cli/kernel/riesgos-retrofit.ts`
- 3018 E5.1 · `/historial/` · 3041 E5.1 · `/PRECIOS_VIGENTES_A\s*=…/`
- 3147 E5.1 · `/clasificador\.jsonl/`, `/marca\(\s*\n?\s*'abstencion'/` + rutas `tests/golden/cfdi`, `scripts/eval-clasificador.ts`, `src/ai/eval/puntuacion.ts`
- 3218 E5.1 · `/conCorridaRegistrada\(|registrarCorridaIngesta\(ctx/` + `044_el_agente_medible.sql`
- 3274 E5.1 · `/if \(veredicto\.integridad\)/` · 3368 E5.1 · `/const modoSombra = thresholds\.sombra…/`, `/const habriaPosteado = veredicto\.procede \|\| porPolitica !== null/`
- 3447 E0.1 · `/requireRole\(roles, 'devolucion_ventas'\)/` (valor de rol persistido) · 3494 E0.1 · `/if \(factura\.journal_entry_id\)/`, `/SAT_CATALOGS\.REGIMEN_FISCAL/g`
- 3560 E1.2 · `/requireRole\(roles, 'anticipo_clientes'\)/g`
- 3656 E0.0 · `/conFuenteMutada\(overlay, \(\) => criterio\.evaluar\(\)\)/` sobre `tests/plan/mutacion.spec.ts`
- 3708 E0.0 · `/corpus-manifiesto\.ts --check/` sobre `ci.yml` · 3834 E0.0 · `/await runLedgerChecksEn\(/`
- 3897 E1.3 · `/encendidoIgnorado/`, `/const tope = maxPolitica \?\? Infinity/` · 3945 E1.3 · `/wouldAutoPost: habriaPosteado/`
- 3994 E0.0 · `/export function entregaYGarantia/` sobre `scripts/costo-por-fila.ts`
- 4037 E1.2 · `/function fechaDelAsiento\(/` · 4139 E1.2 · `/await cotejarMovimientoConSuLinea\(/g`
- 4189 E0.3 · `/CONSTRAINT sesion_balanceada_con_aritmetica/` · 4468 E0.3 · `/CONSTRAINT jel_sello_coherente/` (nombres SQL persistidos en migraciones)
- 4354 E1.2 · `/auto_applicable: importeExacto && empatanEnImporte === 1,/`
- 4575 E1.2 · `/exigirEstado\(/g`, `/ORIGEN_LOTE_IMPORTADO = 'import_batch'/`
- 4638 E4.1 · `/subsidio_entregado_efectivo/`, `/isrDeLaCorrida\.lessThan\(0\)/` + `cfdi-nomina-generator.ts`
- 4813 E2.1 · `/export function recalculoDelSat\(i: ImportesDeclarados, natur: Natur\)/`, `/politicaSellado: string;/` + `balanza-service.ts`, `balanza-invariantes.ts`, `artefactos.ts`
- 4875 E1.2 · `/'sat-agrupador': 'codigo_agrupador_sat'/`
- 4985 E0.3 · `/checks\.push\(await checkSelloDeGarantias\(\)\)/`
- 5054 E2.1 · `/alcanceDeIdempotencia/` + `barrido-entregas.ts` · 5112 E2.1 · `/export function declararRiesgoRuta/`, `/auditarRiesgoDeRutas\(app\)/`
- 5227 E1.2 · `/export async function politicasDeFlujo/`, `/export async function conciliarFlujoDeEfectivo/`
- 5271 E1.2 · `/function lineaQueBarre/`, `/verificarQueElEjercicioBarrio/`, `/export function predicadoSinCierre/` + `criterio-cierre.ts`, `ledger-checks.ts`
- 5383 E1.2 · `/verificarOrigenFx\(line, monedaFuncional, i \+ 1\)/`
- 5729 E0.3 · `/clabe: enmascarar\(fila\.clabe_last4\)/`
- 5766 E0.3 · `/permitirProveedorNuevo\?: boolean;/`, `/throw new ProveedorNuevoSinAutorizar\(/` + `rep-pendientes.ts`
- 5848/5917/5979 E1.2/E1.3 · `/…'devolucion_compras'…/`, `/condonadoAqui…/`, `/getPolicy\(…'pago_corto_residual'\)/`, `/politica\?\.value === 'prohibir'/` (claves del panel: VALORES persistidos en `policy_decisions`)
- 6058 E1.2 · `/requireRole\((?:roles|[a-zA-Z]+), 'banco'\)/`
- 6198 E5.1 · `/emitir\(cmd, 'afterHelp', contexto\)/` sobre `scripts/generate-cli-reference.ts`
- 6349 E0.0 · `/LINEAS_BASE[^=]*=\s*Object\.freeze\(\{…\}\)/` sobre `scripts/ux-status.ts` y la línea exacta `- run: npx tsx scripts/ux-status.ts --check` de `ci.yml`
- 6390/6461 E5.1 · `/herramientas: SUPERFICIE_INGESTA/`, `/process\.exitCode = codigoDeSalida\(/`

Obsérvese que una parte de estos patrones NO son identificadores de código sino **valores persistidos**
(`'segregacion_de_funciones'`, `'pago_corto_residual'`, `'devolucion_ventas'`, `'anticipo_clientes'`, `'banco'`,
`codigo_agrupador_sat`, `CONSTRAINT sesion_balanceada_con_aritmetica`): claves del panel de políticas,
roles de cuenta y nombres SQL. Renombrarlos no es una decisión de idioma del fuente, es una migración de datos.

### 4.3 Anclas de mutante (texto literal que debe existir HOY)

`tests/plan/mutacion.spec.ts:71` «todo mutante declarado ancla en texto que EXISTE hoy» — cualquier
reescritura de la línea anclada rompe la prueba. Ejemplos castellanos: `criterios.ts:1280 de: 'bloquearPeriodoParaPostear(client'`,
`:2235 de: 'export function indiceDeCalendario('`, `:4139 de: '      await cotejarMovimientoConSuLinea(client, {'`,
`:5112 de: '  const censo = auditarRiesgoDeRutas(app);'`, `:1023 de: "'src/services/reporting/criterio-cierre.ts': {"`,
`:6352 de: '      - run: npx tsx scripts/ux-status.ts --check'`.

---

## 5. Qué se rompe con un renombre masivo (por mecanismo) y quién lo detecta

| Cambio | Qué se rompe | Quién lo acusa | archivo:línea |
|---|---|---|---|
| Renombrar un módulo `src/*` con nombre castellano | Importaciones relativas en 82 tests (46 módulos) y en `scripts/`; `vi.mock('…')` por ruta | `npm run typecheck:tests` (`tsconfig.test.json` incluye `src`, `tests`, `scripts`), `npm test` | `package.json:23`, `ci.yml:44` |
| Renombrar `criterio-cierre.ts`, `posting.ts`… | Clave de umbral huérfana en `vitest.config.ts` y `vitest.integration.config.ts`; y el criterio E0.1 compara contra `SUELO_COBERTURA_*` por clave | `npx vitest run --coverage` (ci.yml:74), `plan:status --exigir=E0.1` (E0.1 está exigido) | `vitest.config.ts:92-115`, `vitest.integration.config.ts:57-104`, `criterios.ts:575-604, 996-1040` |
| Renombrar cualquiera de las 181 rutas que un criterio nombra (49 castellanas) | `existe()`/`codigoDe()` → `falla` o excepción → paquete abierto; si el paquete está en `--exigir` o el criterio en el piso, CI rojo | `plan:status --piso --exigir=…` | `ci.yml:145`, `status.ts:173-197, 391` |
| Renombrar un identificador que ≥60 criterios buscan por regex | El criterio pasa a rojo (mide texto); sus mutantes quedan `ancla-rota` | `plan:status`, `npm run mutantes`, `tests/plan/mutacion.spec.ts:71` | §4.2 |
| Traducir el texto de un `enunciado` | `--piso` acusa «El piso nombra criterios que ya no existen» para los 69 del piso; `--exigir` no (va por id de paquete) | `status.ts:182, 327` | `docs/criterios-minimos.json:6-77` |
| Renombrar ids de jobs `restauracion`/`aislamiento` en `ci.yml` | Criterio E0.0 «cinco jobs» rojo (E0.0 está exigido) | `criterios.ts:701-708`, espejo `:729-737` |
| Renombrar cualquiera de las 46 fuentes selladas, o cambiar su contenido (identificadores) | `corpus-manifiesto --check` → `desapareció`/`cambió` → CI rojo; sellar exige releer el manual, uno a uno | `ci.yml:158`, `corpus-manifiesto.ts:75-92, 100-135` |
| Renombrar un script de `scripts/` | `package.json`, 4 pasos de `ci.yml` (153, 158, 166, 176) + 304, 312, 423; regex `PUERTAS` (`criterios.ts:711`); 7 rutas de scripts en criterios; anclas de mutante que citan la línea exacta del YAML (`:6352`); imports en `tests/docs/*.spec.ts`, `tests/ai/eval/arnes-cableado.spec.ts`, `tests/cli/censo-superficie.spec.ts` | typecheck, `plan:status`, `mutantes` | §2.7 |
| Renombrar un script npm (`plan:status`, `catalogo:estado`…) | `ci.yml:145,423`; `CLAUDE.md:8`, `AGENTS.md:8`, `docs/PROCESS.md:38`; 91+31+… menciones; el criterio `PUERTAS` busca `plan\/status` como ruta de archivo, no el nombre npm | nada automático salvo CI (el nombre npm no está en ningún criterio) | §2.9 |
| Renombrar archivos de `tests/` (139 castellanos) | `vitest` incluye por glob (`vitest.config.ts:7`, `vitest.integration.config.ts:7`): no se rompe. Se rompen: el prefijo `tests/integration/s3-` (`ci.yml:225`; si no queda ninguno, vitest sale 1), 6 rutas de tests en criterios (`:3669, 6191, 1108, 1411, 3157`), el mutante `archivo: 'tests/plan/mutacion.spec.ts'` (`:3700`), `HOJAS_PROPIAS`/listas por nombre en `tests/cli/codigos-de-salida.spec.ts:395`, y 259 citas documentales (145 ya rotas: nadie las vigila) | `plan:status`, `mutantes` | — |
| Traducir títulos `describe/it` | Nada mecánico (vitest no los indexa); pero E0.0 «cinco jobs» y E0.0 «espejo ejecutable» leen `mutacion.spec.ts` por regex de CÓDIGO (`conFuenteMutada(overlay, () => criterio.evaluar())`, `.toBe('falla')`), no de títulos | `criterios.ts:3672-3679` |
| Renombrar un COMANDO del CLI | `LINEA_BASE` (obsoletas + nuevas), `FOTO_ORIGINAL`, `TOP_LEVEL`, filas del catálogo (`sinFila`), `docs/catalogo-minimos.json`, `LINEAS_BASE` de `ux-status` | `auditoria-programa.spec.ts`, `catalogo-estado --check`, `ux-status --check` | `audit.ts:197`, `catalogo-estado.ts:102`, `ux-status.ts:210` |
| Mover mensajes/ayuda del CLI a catálogos con castellano por omisión | 910 aserciones de texto en `tests/cli` (173 literales largos, casi todos ingleses); `bilingual-matrix.spec.ts:310-323` exige inglés en pantalla; `ux-status` cuenta castellano como defecto (`fueraDeIdioma`, líneas base 7 y 17) | `npm test`, `ux-status --check` | `ux-status.ts:299-330, 210-215` |
| Renombrar migraciones 034–069 | Prohibido (append-only, aplicadas); 16 nombradas por criterios; `migration-numbering.spec.ts` tolera sólo los 4 duplicados | `npm run migrate` | `docs/migraciones.md` |

---

## 6. Dependencias (quién referencia por nombre o ruta)

- `.github/workflows/ci.yml:145` (`--exigir` de 10 paquetes; `--piso`), `:153,158,166,176,225,304,312,423` (rutas de scripts y prefijo de tests).
- `src/plan/criterios.ts` (181 rutas; 49 castellanas; 5 ids de job; ~60 regex de identificadores castellanos; 120 anclas literales), `src/plan/status.ts:165,173-197,311,391`.
- `docs/criterios-minimos.json` (69 enunciados), `docs/catalogo-minimos.json` (2 números).
- `vitest.config.ts:35-39,91-115`, `vitest.integration.config.ts:53-104`, `criterios.ts:575-604` (tablas espejo).
- `src/ai/docs/manifiesto.json` (46 hashes por ruta; 13 manuales) ↔ `scripts/corpus-manifiesto.ts`.
- `docs/cli-command-catalog.md` (616 citas `archivo:línea`; filas por nombre de comando; celda de alias castellano) ↔ `scripts/catalogo-estado.ts:42-53,102-108,145-159,243-253`.
- `src/cli/kernel/audit.ts:197-236` ↔ `tests/cli/kernel/auditoria-programa.spec.ts:67`; `src/cli/kernel/vocabulary.ts:22,133` ↔ `tests/cli/bilingual-matrix.spec.ts:25,208,310`.
- `scripts/ux-status.ts:210-215 LINEAS_BASE`, `:299 PALABRAS_CASTELLANAS` ↔ `tests/cli/censo-superficie.spec.ts:149-155,296-298,503-506,540-554`.
- `package.json:18-33` ↔ `CLAUDE.md:8`, `AGENTS.md:8`, `docs/PROCESS.md:38`, 91 menciones de `plan:status`.
- `tests/plan/mutacion.spec.ts:52,71` (58 sin espejo; anclas), `tests/database/migration-numbering.spec.ts:9-23`, `tests/cli/codigos-de-salida.spec.ts:395`, `tests/ai/cli-reference.spec.ts:27`.
- Documentos que citan rutas de tests: 259 únicas (145 rotas ya) y de scripts: 25 (varias rotas).
- Reglas escritas en contra: `CONTRIBUTING.md:158`, `README.md:345`, `docs/PROCESS.md:58`, `CONTRIBUTING.md:96`.

---

## 7. Cómo se secuenciaría (codemod + criterios en el mismo commit; un subsistema por PR)

Principio que el propio repositorio ya practica: **el instrumento vive en el mismo commit que el cambio que juzga**
(`status.ts:383-390`, `criterios-minimos.json:_reglas`, `catalogo-minimos.json:_`). Cada PR de renombre lleva en su
diff: el codemod, las claves de umbral (3 tablas), las rutas/regex/anclas de `criterios.ts`, el piso si cambia un
enunciado, el manifiesto si cambia una fuente sellada, y el bloque regenerado del catálogo. Verificación mínima por PR,
en un worktree limpio del commit (regla de la casa): `npm run typecheck && npm run typecheck:tests && npm test &&
npx vitest run --coverage && npm run plan:status -- --piso --exigir=<lista de ci.yml> && npm run mutantes &&
npx tsx scripts/catalogo-estado.ts --check && npx tsx scripts/corpus-manifiesto.ts --check && npx tsx scripts/ux-status.ts --check && npx tsx scripts/openapi.ts --check`.

0. **PR 0 — identidad estable antes de traducir prosa de instrumento.** Hoy la identidad de un criterio es
   `paquete · enunciado` (`status.ts:165`) y el piso guarda 69 de esas cadenas castellanas. Si el dueño quiere que la
   SALIDA de `plan:status` se traduzca por catálogo, primero hay que dar a cada criterio un `id` estable (o declarar
   que `enunciado` es clave y no se traduce) y hacer que `--piso` compare por ese id. Sin esto, cada traducción de un
   enunciado es un `desaparecidos` en CI. Lo mismo para `LINEAS_BASE`/`CLAVES` de `ux-status` (son claves, no prosa).
1. **PR 1 — `tests/` solo, sin tocar `src/`.** Renombrar los 139 spec castellanos y traducir 4 831 títulos no mueve
   ningún trinquete de cobertura ni el manifiesto. Hay que actualizar en el mismo commit: `ci.yml:225` (prefijo `s3-`),
   las 6 rutas de tests en `criterios.ts` y el mutante `:3700`, `HOJAS_PROPIAS` si cambia, y decidir qué hacer con las
   259 citas documentales (145 ya están rotas: el coste de no tocarlas es conocido y ya aceptado). Los 3 ayudantes
   castellanos (`servidor.ts`, `entidades.ts`, `rls-censo.ts`) los importan 18 tests: codemod trivial. Riesgo: bajo.
2. **PR 2 — `scripts/` y nombres npm.** 11 scripts castellanos; tocar `package.json`, 7 pasos de `ci.yml`, `PUERTAS`
   (`criterios.ts:711`), 7 rutas + anclas en criterios (`:3718-3729, 4003-4023, 6203, 6352-6357, 6390-6403`), imports
   en 6 tests, y los 3 documentos de proceso (`CLAUDE.md:8`, `AGENTS.md:8`, `PROCESS.md:38`). Conviene mantener alias
   npm viejos un tramo (`"plan:status"` → mismo tsx) porque 91 menciones en docs no se van a reescribir todas.
3. **PR 3…n — `src/` por subsistema, en este orden de menor a mayor acoplamiento con el instrumento**
   (número = criterios que lo nombran, de `criterios-clasificacion.json`):
   - `src/services/banking/parsers/{tipos,fecha,importe,texto,perfiles-csv}` (0 criterios; 5 tests) · `src/api/rest/{montajes,topes,zod-a-json-schema}`, `src/api/graphql/errores` (0-1) · `src/services/fiscal/inpc/{periodo,parseo}` (0).
   - `src/services/sat/{anexo24,diot}` (criterios 4748, 4813, 4875; nombres de artefactos SAT — decidir antes si `balanza/polizas/catalogo-cuentas` son nombre propio del Anexo 24 o se traducen).
   - `src/services/webhooks/{barrido-entregas,politica-reintento}` (5054) · `src/services/payroll/mx/{finiquito-*,subsidio-entregado,cfdi-nomina-generator}` (4638, 4929) · `src/database/{consulta-publica,rls-guard}` + `src/api/graphql/permisos` (2394, 2528, 2614).
   - `src/ai/tools/superficie.ts`, `src/ai/eval/puntuacion.ts`, `src/cli/kernel/{riesgos-retrofit,confirmacion}` (2927, 2957, 3147, 6430, 6461).
   - **Último**: `src/services/reporting/criterio-cierre.ts` y los identificadores de `posting.ts`/`period-close.ts`/`ledger-checks.ts`
     (`bloquearPeriodoParaPostear`, `registrarAuditoria`, `exigirSegregacion`, `lineaQueBarre`, `verificarQueElEjercicioBarrio`…):
     3 tablas de umbral + ~12 criterios exigidos + 46 hashes del manifiesto (posting/validation/ar-ap-posting/report-service
     están sellados: cada renombre obliga a releer `accounting.md`, `receivables.md`, `reports.md`).
   Para cada uno: codemod (ts-morph/`tsc --listFiles` + sed no basta por las regex de criterios), reescritura de las
   regex y anclas `de:` afectadas, `npm run mutantes` debe seguir en 120/120, y `plan:status --piso --exigir` en verde.
4. **Nunca**: renombrar/renumerar migraciones (36 nombres castellanos se quedan; sólo pueden nacer nuevas en inglés);
   renombrar claves del panel (`pending-catalog.ts`), roles de cuenta ni `CONSTRAINT`s citados por criterios sin una
   migración de datos, porque son VALORES persistidos, no identificadores.
5. **Superficie de usuario (fuera de este inventario pero condicionada por él)**: mover ayuda/mensajes a catálogos con
   castellano por omisión invierte dos guardias vigentes — `bilingual-matrix.spec.ts:310-323` («help text is English») y
   `ux-status.ts:314 fueraDeIdioma` (castellano en pantalla = defecto, líneas base 7 y 17) — y reescribe las 910 aserciones
   de texto de `tests/cli`. Debe ir en su propio PR, con las líneas base reexpresadas sobre el idioma nuevo, no «bajadas».

---

## 8. Resumen

La superficie de pruebas/criterios/CI es castellana en su capa nueva e inglesa en la vieja: 232 de 336 spec tienen títulos
castellanos (4 831 títulos es vs 1 999 en), 139 spec llevan nombre castellano, 82 tests importan 46 módulos con nombre
castellano, y `tests/ai` es la excepción inglesa (45 de 62). El instrumento de medida es el acoplamiento fuerte: 117 de
133 criterios leen archivos por ruta (181 rutas, 49 castellanas), ≥60 buscan identificadores castellanos por regex, 120
mutantes anclan en texto literal (38 castellanos) y las claves de umbral por archivo viven por triplicado
(`vitest.config.ts` 6, `vitest.integration.config.ts` 9, `criterios.ts:575-604`), con el criterio E0.1 diseñado para
ponerse rojo ante un renombre. Lo que casa por NOMBRE DE COMANDO (catálogo, `LINEA_BASE`, censo) ya es inglés y no se
mueve con un renombre de identificadores; lo que casa por RUTA o TEXTO (criterios, umbrales, manifiesto con 46 hashes,
616 citas del catálogo, 259 citas documentales de tests de las que 145 ya están rotas) sí, y cada PR debe llevar codemod
e instrumento juntos, empezando por `tests/` y `scripts/` y dejando el motor contable sellado para el final; 36 migraciones
castellanas y los valores persistidos (claves del panel, roles, constraints) quedan fuera de cualquier renombre.
