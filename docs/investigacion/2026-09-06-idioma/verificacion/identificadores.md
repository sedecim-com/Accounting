# Verificación escéptica — superficie «identificadores y nombres de archivo»

Objeto: `/tmp/investigacion-idioma/inventario/identificadores.md`. Repositorio `/Users/victor/projects/Accounting`, HEAD `b31e62a9` (`git rev-parse HEAD`, coincide con el informe). Ningún archivo del repo fue tocado. Trabajo intermedio en `/tmp/investigacion-idioma/verificacion/work/`.

**Advertencia previa que el informe no da**: el árbol de trabajo NO está limpio. `git status --short` muestra 7 archivos modificados (`src/ai/doctor-service.ts`, `src/services/accounting/{iva-cash-basis,iva-ppd-reclass,pais-contable}.ts`, `vitest.config.ts`, 2 specs) y 4 rutas sin rastrear, entre ellas **`src/services/jurisdiccion/`** (`git ls-files src/services/jurisdiccion | wc -l` → 0). El inventario midió un árbol que ningún commit contiene: de sus 376 `.ts`, 375 están rastreados (`git ls-files src | grep -c '\.ts$'`); de sus 4 637 declaraciones, 11 viven en el archivo sin rastrear (`grep -c 'src/services/jurisdiccion/' decl_rerun.tsv`); la línea `include: 'src/services/jurisdiccion/**'` de `vitest.config.ts:37` que cita es un cambio sin comprometer (`git diff vitest.config.ts`). Además `jurisdiccion.ts` cambió a las 21:54 (`stat -f '%Sm'`), después del inventario (21:34): `esContabilidadMexicana` ya no está en la línea 201 sino en la 206, y en HEAD vive en `src/services/jurisdiction/jurisdiction.ts:35` (`git show HEAD:… | grep -n`). Todo lo que sigue se verificó contra el árbol tal como está ahora.

---

## 1. Cifras: se sostienen o no

Método: cada comando del informe se volvió a correr tal cual; cuando el comando citado no reproduce la cifra, se dice cuál sí la produce.

### 1.1 Se sostienen (reproducidas exactamente)

| cifra | comando | resultado |
|---|---|---|
| 376 `.ts` | `find src -type f -name '*.ts' -not -path '*/node_modules*' \| wc -l` | 376 (375 rastreados) |
| 75 sql / 29 md / 2 json | `find src -type f -not -name '*.ts' … \| sed 's/.*\.//' \| sort \| uniq -c` | 75/29/2 |
| 66 re-exports | `grep -nE '^\s*export\s+(\{\|\*)' -r src --include='*.ts' \| wc -l` | 66 |
| 4 637 declaraciones, 2 807/1 830 | `perl datos/extract.pl $(find src -name '*.ts') \| wc -l` (rerun completo, `work/decl_rerun.tsv`) | 4 637; `diff` con el TSV del informe: 16 líneas, todas por el desplazamiento de `jurisdiccion.ts` |
| 4 288 únicos | `cut -f5 declaraciones_clasificadas.tsv \| sort -u \| wc -l` | 4 288 |
| 2 282 en / 2 066 es / 218 mixto / 71 neutro | `cut -f6 … \| sort \| uniq -c` | idéntico; por ámbito 1497/1161/141/8 y 785/905/77/63 idéntico |
| 0 tokens sin clasificar | `cut -f11 … \| grep -v '^$' \| wc -l` | 0 |
| sumas por carpeta (cli 822, ai 731, banking 569, sat 346, accounting 344…) | `awk` sobre el TSV | idénticas |
| 41 `.ts` es / 298 en / 10 mixto / 27 neutro; sql 26+9 / 40; md 14/13/2 | `awk … archivos_clasificados.tsv \| sort \| uniq -c` | idéntico |
| duplicados 012, 014, 015, 018 | `ls src/database/migrations \| sed -E 's/^([0-9]+)_.*/\1/' \| sort \| uniq -d` | idéntico — pero **014 tiene tres archivos** (`uniq -c \| awk '$1>1'` → 2,3,2,2): son 74 archivos para 69 números |
| 53 claves del panel | `grep -cE "^\s+key:\s*'" src/services/policy/pending-catalog.ts` | 53 (y 53 distintas) |
| 36 tipos GraphQL, 23 campos Query/Mutation | `grep -cE "^\s*type\s+[A-Z]"` → 22 + `input\|enum\|interface` → 14; `awk` sobre bloques `type Query{`/`type Mutation{` | 36 y 23; los 155 campos de todos los tipos: 151 en + 4 neutro, **0 españoles** |
| 6 648 líneas; codigoDe 187, crudoDe 41, existe 34, rutaDe 20, dondeAparece 14, consumidoresDe 9, fuentes 7, sinComentarios 7, apariciones 1 | `wc -l`; `grep -cE "\bNOMBRE\("` | todos idénticos |
| 133 bloques | `grep -cE '^\s+paquete:'` → 135; uno es el campo del tipo (`criterios.ts:75`) y otro `p.paquete` (`:6641`) | 133 ✓. `npm run plan:status` dice **136 criterios · 133 leen el fuente · 3 ▶** — los 3 restantes viven en `src/plan/conducta.ts`, que el informe no menciona (ver §4) |
| 120 mutantes con `archivo:`, 75 criterios con `mutantes:` | `grep -cE "^\s+archivo:\s*'"`, `grep -cE "^\s+mutantes:"` | 120 / 75 |
| 6 + 9 umbrales por archivo; `include 'src/services/jurisdiccion/**'` en `:37` | `grep -nE "^\s+'src/[^']+'\s*:\s*\{" vitest*.ts` | 6 y 9, mismas líneas; el include existe pero **sin comprometer** |
| manifiesto: 46 hashes, 13 manuales, 1 sin revisar, 49 rutas, 1 mixta | `python3 -c "…len(m['hashes'])…"` | 46/13/1/49; única es/mixta `cfdi-nomina-generator.ts` |
| `LINEA_BASE` 36 entradas, formato `comando\|regla\|detalle` | `sed -n '197,240p' src/cli/kernel/audit.ts \| grep -cE "^\s+'"` | 36; no son rutas ✓ |
| 422 rutas `src/` en docs; 25 es + 8 mixto | `grep -rhoE 'src/[A-Za-z0-9_./-]+\.(ts\|sql)' docs AGENTS.md CONTRIBUTING.md README.md \| sort -u \| wc -l`; clasificación del basename con `clasificar.pl` | 422; 25/8 (+364 en, 25 neutro) |
| 3 338 sentencias import, 802 pares cruzados, 766 casados = 538/200/28, `src/plan/risk.ts` único origen inexistente | `perl datos/imports.pl $(find src -name '*.ts')`; `awk` carpeta≠carpeta; cruce exacto (origen, símbolo) con el TSV | idéntico |
| consumidores: `registrarAuditoria` 20, `noEntendi` 16, `confirmarConReintento` 16, `declararRiesgoRuta` 16, `tenantDe` 12 | `grep -rlE "import[^;]*\bSIMBOLO\b" src --include='*.ts' \| wc -l` | idéntico |
| tests: 35 módulos es + 8 mixto | `perl imports.pl $(find tests -name '*.ts')`, filtrar `^src/`, clasificar basename | 35/8 sobre **305** módulos (informe: 306; diferencia dentro del ruido del árbol cambiante) |
| `CONTRIBUTING.md:158`, `docs/PROCESS.md:58` ordenan español | `sed -n '158p'`, `sed -n '58p'` | ✓ |

### 1.2 No se sostienen o el comando citado no las produce

| cifra del informe | qué encontré | comando |
|---|---|---|
| **143 comandos CLI** con `grep -oE "\.command\('[a-z][a-z-]*'" -r src/cli \| sort -u \| wc -l` | **El comando citado da 270** (sin `-h`, `sort -u` deduplica por archivo). 143 sale con `-h`. Con `[^']*` son 146 (`create <name>`, `disable <name>`, `revoke <id>`). Y hay 2 nombres que ningún grep de `.command('` ve: `.command(isAr ? 'aged-receivable' : 'aged-payable')` en `src/cli/report-command.ts:609` | `grep -ohE … \| sort -u \| wc -l` → 143; `grep -rnE "\.command\([a-zA-Z]" src/cli` |
| **116 registros REST** en 17 archivos | **No reproducible con ninguna variante.** `router.(get\|post\|put\|patch\|delete)(` → **151** (64 get, 73 post, 6 put, 4 patch, 4 delete) en 17 archivos; con literal en la misma línea → 132; rutas literales distintas → 103 | `grep -hoE "router\.(get\|post\|put\|patch\|delete)\(" src/api/rest/routes/*.ts \| wc -l` |
| **112 tablas, 107 en + 4 es + 1 neutro** | El regex `[a-z_]+` capturó **`public` como tabla** (de `create table public.tenants/users/sessions/identities`) y **truncó `sat_anexo24_artefactos` a `sat_anexo`**. Real: **115** tablas distintas (110 en, 4 es: `inpc_serie`, `sat_bancos`, `sat_codigos_agrupadores`, `sat_anexo24_artefactos`; 1 neutro `mx_isn_tasas_estatales`) | `grep -rhoiE 'create table (if not exists )?[a-z0-9_.]+' src/database/migrations/*.sql \| sed -E 's/.* //' \| tr A-Z a-z \| sed 's/^public\.//' \| sort -u \| wc -l` |
| **16 `export default` anónimos** | **17** | `grep -rnE '^\s*export\s+default' src --include='*.ts' \| wc -l` (17, todos `router` o `createAiWebhooksRouter()`) |
| **41 archivos `.ts` españoles «lista completa»** | La cifra 41 es correcta en el TSV, pero **la lista impresa tiene 38**: faltan `src/services/sat/anexo24/artefactos.ts`, `src/services/sat/anexo24/validador.ts`, `src/services/sat/diot/modelo.ts` | `comm -23 <(awk '$1~/\.ts$/&&$3=="es"{print $1}' archivos_clasificados.tsv \| sort) <(lista del informe \| sort)` |
| **`hashDeCarga` 11, `conLlave` 11** archivos consumidores | Por línea de `import`: **10 y 10**; por uso del nombre: 12 y 14. El 11 no sale con ningún método que probé | `grep -rlE "import[^;]*\bconLlave\b" src --include='*.ts' \| wc -l` |
| **tests: 1 399 símbolos importados desde `src/`; 189 sitios / 144 símbolos es-mixto** | Con `imports.pl` (que sí ve imports multilínea): **1 305 símbolos distintos, 1 346 pares (origen, símbolo)**; cruce exacto (origen, símbolo) contra las declaraciones exportadas es/mixto: **749 sitios y 575 símbolos**, casi 4× lo que dice el informe. Causa probable: el informe usó `grep -rhoE "import…from…src/"` en una sola línea, y sólo en `src/` hay 213 sentencias `import {` que abren llave sin `from` en la misma línea (`grep -rhE "^\s*import\s+(type\s+)?\{[^}]*$" src --include='*.ts' \| wc -l`); en tests son más | `awk` con `e[$1"\t"$5]` sobre `declaraciones_clasificadas.tsv` × `work/imports_tests_src.tsv` |
| **720 exportados es/mixto sin ningún import nominal** | **464** (1 265 nombres exportados es/mixto − los importados por nombre desde `src/` o `tests/`); 61 de esos 464 aparecen por nombre en más de un archivo (barril `index.ts`, cadenas) | `comm -23 work/exp_es.txt work/importados.txt \| wc -l` |
| **40 criterios leen ruta española/mixta** | Se reproduce 40 desde `criterios_idioma.tsv`, pero **19 de los 40 sólo citan migraciones (inmutables por regla de la casa, no se renombran) o cadenas que no son rutas**: `src/services/reporting/otro-archivo.ts` es el destino `a:` de un mutante (`criterios.ts:1026`), «`src/services/sat-download existe pero sin descarga-masiva.ts (el motor)`» es un mensaje de `falla`, y `src/services/sat-download/descarga-masiva.ts` no existe. **21 criterios citan una ruta española renombrable que existe** | `work/crit_rutas_detalle.tsv`; `[ -e "$p" ]` por ruta; `grep -c 'migrations/'` |
| **«18 migraciones» citadas por criterios** | Son **15 rutas de migración distintas**; 18 es el número de criterios que citan *sólo* migraciones | `awk '$3==1{print $5}' criterios_idioma.tsv \| tr '\|' '\n' \| sort -u \| grep -c migrations/` |
| **15 criterios cuyo regex/literal contiene un identificador español declarado** | **12**. Tres son coincidencias vacías: `criterios.ts:2235` casa `consumidoresDe` y `sobre` (la primera es función del propio `criterios.ts`; `sobre` es una función interna de `src/services/sat/cfdi-status.ts:48` que nada tiene que ver), `:3656` casa `falla` (`criterios.ts:433`, propio), `:5628` casa `continuidad/identidad/secuencia/reversos`, que ahí son **valores de cadena** `check: 'continuidad'` y coinciden por nombre con la función interna `reversos` de `statement-checks.ts:493` | `cat datos/criterios_cruce.tsv`; `sed -n '2235,2240p;5628,5660p'` |
| **Unión: 51 de 133 criterios se ponen en rojo** | 40 ∪ 15 = 51 se reproduce aritméticamente, pero es un techo inflado: sin self-hits, **49**; contando sólo rutas renombrables existentes (fuera migraciones y cadenas) ∪ 12 identificadores, **31** (33 con los self-hits). El informe iguala «cita una migración inmutable» con «se rompe al renombrar», y eso no ocurre porque esas migraciones no se renombran por definición | `cat work/crit_rutas_reales.txt work/crit_ids12.txt \| sort -u \| wc -l` |
| **25 mutantes apuntan a archivo español/mixto** | 25 ✓ (15 es + 10 mixto), pero **15 de los 25 apuntan a migraciones** (069 ×4, 051 ×4, 055 ×2, 058, 054, 052, 049, 048): inmutables. A archivos renombrables: **10** (`permisos.ts` ×2, `barrido-entregas`, `polizas-service`, `balanza-service`, `balanza-invariantes`, `finiquito-math`, `cfdi-nomina-generator`, `scripts/costo-por-fila.ts`, `scripts/corpus-manifiesto.ts`) | `grep -oE "^\s+archivo:\s*'[^']+'" src/plan/criterios.ts` + `clasificar.pl` |
| **«tres mutantes anclan literales de vitest.config.ts (`criterios.ts:1018,1026,1034`: `'src/services/reporting/criterio-cierre.ts': {`)»** | Sólo **1026** contiene ese literal. `1018` es `de: 'statements: 99, branches: 95, functions: 100, lines: 99,'` (números) y `1034` es `de: "'src/services/reporting/**',\n"` (el include de la carpeta). Los tres son mutantes del mismo criterio, pero sólo uno se rompe por el nombre `criterio-cierre.ts`; el tercero se rompe si se renombra la carpeta `reporting` | `sed -n '1012,1040p' src/plan/criterios.ts` |
| **`esContabilidadMexicana` en `jurisdiccion.ts:201`** | Hoy en `:206` (archivo sin rastrear, editado tras el inventario); en HEAD está en `pais-contable.ts:35` | `grep -nE "export function esContabilidadMexicana" …`; `git show HEAD:…` |

---

## 2. Muestra de 30 referencias archivo:línea

Se tomaron las 22 filas con línea de la tabla §3 del informe más 8 de §4/§5 (`audit-log.ts:50`, `idempotency-store.ts:43`, `confirmacion.ts:63`, `criterios.ts:325`, `criterios.ts:1280`, `criterios.ts:2957`, `criterios.ts:6228`, `vitest.config.ts:112`). Comprobación: `sed -n "${n}p" "$f" | grep -qE "$identificador"`.

**Exactas: 26 / 30.** Inexactas:
1. `src/services/jurisdiction/jurisdiction.ts:201` — el identificador está en `:206` (archivo movido después del inventario; no es error de método sino de blanco móvil).
2. `src/plan/criterios.ts:1280` (`bloquearPeriodoParaPostear`) — la línea 1280 es `paquete: 'E0.1'`; el identificador está en `:1285-1286`.
3. `src/plan/criterios.ts:2957` (`conLlave`) — `:2989, 2995`.
4. `src/plan/criterios.ts:6228` (`EJEMPLOS`) — `:6256`.

Los tres de `criterios.ts` siguen una convención no declarada: citan la línea `paquete:` con que empieza el bloque, no la del identificador. Sirve para localizar el criterio, no el literal.

**Muestra ampliada (52 referencias, `work/`):** 37 exactas, 15 no. Además de las 4 anteriores: los otros 9 `criterios.ts:N` de §5.1 (`1729`, `1933`, `2691`, `3057`, `3218`, `4037`, `4139`, `4276`, `4575`; desfase de 5 a 40 líneas, misma convención de bloque) y `criterios.ts:1018` y `:1034`, que no contienen lo que el informe dice (ver tabla). Todas las referencias a `src/services/**`, `src/cli/**`, `src/ai/**`, `src/api/**`, `src/database/**`, `vitest*.ts`, `audit.ts:197`, `vocabulary.ts:22`, `corpus-manifiesto.ts:24`, `ci.yml:410` y `pending-catalog.ts` son exactas.

## 3. Muestra propia de clasificación (40 declaraciones, semilla 4242)

`awk 'BEGIN{srand(4242)}{print rand()"\t"$0}' declaraciones_clasificadas.tsv | sort -n | head -40`. Revisadas a mano: **39/40** coherentes con el criterio del informe. Fallo: `MetaDePolizas` (`polizas-service.ts:656`) sale «mixto» porque `meta` está en web2; un lector lo llama español. Misma dirección que los 3/200 del informe (mixto inflado a costa de es). No refuta la tasa del 1,5 %; la muestra es pequeña para afinarla.

---

## 4. Lo que el informe no vio

1. **Miembros de interfaces y tipos exportados (claves de objetos).** El inventario sólo cuenta el *nombre* de la interfaz. Extrayendo los miembros de nivel 1 de cada `export interface|type … {` (`perl` en `work/miembros.tsv`): **5 362 miembros, 1 391 es (26 %) + 82 mixto**, 612 nombres españoles distintos (`cuenta`, `monto`, `politicas`, `resultado`, `tratamiento`…), y **555 tokens que el diccionario del informe no clasifica** y que son en su mayoría españoles (`definida` ×12, `advertencias` ×7, `pendiente`, `omitidos`, `descuento`, `vacacional`…): el 26 % es un piso. Son las claves que un `JSON.stringify` saca por `--json`, por los `res.json` de REST y por los resolvers; no se comprobó cuántas llegan al cable. Comando: `COL=3 perl clasificar.pl es_sorted.txt neutral_sorted.txt /usr/share/dict/words < work/miembros.tsv | cut -f5 | sort | uniq -c`.
2. **`src/plan/conducta.ts`** — los 3 criterios «▶» que `plan:status` cuenta aparte (136 = 133 + 3) importan por ruta con `typeof import('../services/accounting/posting.js')` etc. (`conducta.ts:76-82` y `:805-814`, 17 referencias; también `criterios.ts:2872` → `riesgos-retrofit.js`). `imports.pl` sólo ve `import … from`, así que estas 30 referencias `import('./…')` de `src/` (`grep -rnE "\bimport\(['\"]\." src --include='*.ts' | wc -l`) no están en los 3 338. Hoy ninguna apunta a un archivo español salvo `riesgos-retrofit`.
3. **`vi.mock('<ruta>')` en tests.** 81 rutas distintas (`grep -rhoE "vi\.mock\(['\"][^'\"]+['\"]" tests | sort -u | wc -l`), **6 a módulos de nombre español**: `pac/simulacion.js`, `reporting/criterio-cierre.js`, `auth/sujeto-activo.js`, `accounting/sat-agrupadores.js`, `anexo24/balanza-service.js`, `webhooks/barrido-entregas.js`. Son cadenas: ni `tsc` ni `imports.pl` las ven; un renombrado las deja apuntando al vacío.
4. **43 rutas `src/…` literales dentro de tests** (`grep -rhoE "['\"\`]src/[A-Za-z0-9_./-]+\.(ts|sql|json|md)['\"\`]" tests | sort -u | wc -l`), 7 de ellas españolas (`043_la_serie_del_folio…sql`, `criterios.ts`, `jurisdiccion.ts`, `balanza-invariantes/service/xml.ts`, `catalogo-cuentas.ts`); `tests/integration/g4a-ataque.int.spec.ts` lee `src/` con `readFileSync`. Y `tests/integration/s4a-ataque.int.spec.ts:398` recorre `SUELO_COBERTURA_UNITARIA` (`criterios.ts:575`) exigiendo que **toda** clave de `thresholds` de `vitest.config.ts` esté también en ese suelo: renombrar `criterio-cierre.ts` obliga a tocar tres sitios a la vez (vitest, suelo, spec), no dos como dice §5.2.
5. **`package.json` y `scripts/`.** El informe dice que los scripts de `package.json` citan rutas «todas inglesas hoy» restringiéndose a `src/`. Pero `"mutantes": "tsx scripts/mutantes.ts"` y `"catalogo:estado": "tsx scripts/catalogo-estado.ts"` son **nombres de script npm en español** que `CLAUDE.md` ordena ejecutar, y 12 de los 17 archivos de `scripts/` tienen nombre español o mixto (`artefacto-catalogo`, `catalogo-estado`, `corpus-manifiesto`, `costo-por-fila`, `eval-clasificador`, `mutantes`, `provision-roles.sql`, `publicar-wiki.sh`, `reclasificar-iva-ppd`, `rellenar-roles-de-cuenta`, `rol-auditor.sql`, `build-niif-indice`). Fuera del universo `src/` del informe, pero es la misma clase de texto y una superficie del desarrollador.
6. **Docs con deuda previa**: de las 422 rutas citadas, **92 no existen** en el árbol (`cut -f1 work/docs_rutas.tsv | while read p; do [ -e "$p" ] || echo; done | wc -l`). Un renombrado no crea el problema, lo agranda sobre una base ya rota.
7. **Nombres de herramientas del agente** (lo que ve el modelo): 25, todos ingleses `snake_case` (`grep -rhoE "^\s*name:\s*'[^']+'" src/ai/tools | sort -u`). Confirma «ninguno sale por nombre», que el informe afirma sin haberlo mirado.
8. **Directorios**: el único con nombre español propiamente es `jurisdiccion` (sin rastrear); `anexo24`, `diot`, `inpc`, `mx`, `mexico`, `pac` son acrónimos o topónimos. `tests/` replica la estructura (`tests/services/jurisdiccion/`, también sin rastrear) y 76 de 343 specs llevan palabra española en el nombre (grep de vocabulario; cota gruesa).
9. **`.tmp-*.config.ts`** en la raíz (ignorados por `.gitignore:65`): son copias de configuración de vitest de otras sesiones; no citan rutas hoy. `eslint.config.mjs`, `tsconfig*.json`, `.claude/launch.json` citan sólo `src/**`, `tests/**`, `scripts/**` — no dependen de nombres.

---

## 5. Veredicto por afirmación

- **Universo y extracción (376 / 4 637 / 2 807 / 1 830 / 4 288)**: se sostienen, con la salvedad de que 1 archivo y 11 declaraciones no están en ningún commit y `esContabilidadMexicana` cambió de sitio y de línea durante la investigación.
- **Clasificación es/en/mixto y tasa 1,5 %**: se sostiene; mi muestra de 40 da 1/40 en la misma dirección.
- **Nombres de archivo (41/298/10/27; migraciones 001-035 en, 036-069 es; 4 números duplicados)**: se sostienen; la lista «completa» omite 3 archivos y 014 tiene tres copias, no dos.
- **Tablas 112**: refutado — 115; el regex confundió `public.` con una tabla y truncó un nombre.
- **Comandos CLI 143**: la cifra es defendible pero el comando citado da 270; y faltan 2 comandos construidos por expresión.
- **REST 116**: refutado — 151 registros, 103 rutas distintas.
- **GraphQL 36/23, panel 53, manifiesto 46/13/1, LINEA_BASE 36, umbrales 6/9, docs 422 (25+8), imports 3 338/802/766**: se sostienen.
- **Tests 1 399 / 189 / 144**: refutado — 1 305 símbolos, 749 sitios, 575 símbolos españoles; el grep de una línea perdió los imports multilínea.
- **720 sin consumidor**: refutado — 464.
- **51 de 133 criterios en rojo**: aritméticamente reproducible, sustantivamente inflado: 12 identificadores reales (no 15), 21 rutas renombrables (no 40), **31 criterios** realmente expuestos a un renombrado; 15 de los 25 mutantes «españoles» apuntan a migraciones que nadie va a renombrar.
- **`criterios.ts:1018,1026,1034` anclan `criterio-cierre.ts`**: refutado — sólo 1026.
- **Radio de impacto omitido**: 1 391+ miembros de interfaces en español, 6 `vi.mock` por ruta, `conducta.ts` y sus 17 `typeof import(…)`, el suelo `SUELO_COBERTURA_UNITARIA` + `s4a-ataque`, y los nombres de script npm/`scripts/` en español.
