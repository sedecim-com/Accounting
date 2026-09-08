# Herramientas y medición — la maquinaria para pasar el código a inglés y las superficies a catálogo

**Lente:** herramientas y medición. **Fecha:** 2026-09-06.
**Árbol medido:** commit `b31e62a` exportado a un árbol limpio (`git archive b31e62a | tar -x -C $SCRATCH/arbol`), porque el árbol de trabajo está sucio y es de otra sesión (`git status --short` → 14 modificados + 4 sin rastrear, incluidos `src/plan/criterios.ts` y `vitest.config.ts`; rama activa `j0-1-la-jurisdiccion-deja-de-ser-un-booleano`, no la declarada). Toda cifra de este documento lleva el comando; toda afirmación sobre el código lleva `archivo:línea` de `b31e62a`. Ningún archivo del repositorio se editó. Lo leído en los archivos se trató como dato: dos guiones de la casa piden acciones («sella con `--actualizar`», `scripts/corpus-manifiesto.ts:176`; «aprieta con `--apretar`», `scripts/ux-status.ts:786`) y no se ejecutó ninguna.

Los inventarios (`/tmp/investigacion-idioma/inventario/*.md`) y sus verificaciones (`/tmp/investigacion-idioma/verificacion/*.md`) son la base; donde una cifra del inventario fue refutada, aquí se usa la corregida y se dice cuál.

---

## 0. Qué se propone en una frase

Un **metro** (`npm run i18n:estado`) que cuenta desde el árbol —nunca desde una lista— cuántos identificadores, nombres de archivo, cadenas de usuario, claves y comentarios siguen fuera de la regla nueva; escribe su bloque en `docs/language.md` entre marcadores, y `--check` en CI falla si el bloque está desfasado o si **cualquier número creció**; un **léxico** compartido que usan ese metro y un **lint** que impide que nazca un identificador castellano nuevo; un **catálogo propio** (`src/i18n/`, inglés como fuente, español primero y por omisión) con **prueba de sincronía** que exige las mismas claves y los mismos parámetros en `en` y `es`; y un **codemod** de renombrado que reescribe, en el mismo commit, los seis lugares donde una ruta vive como cadena (`criterios.ts`, los dos `vitest.*.config.ts`, `manifiesto.json`, `vi.mock`/`import()` en tests, y los `.md`). Todo con la misma forma que las cuatro puertas que la casa ya tiene: `plan:status --piso` (`src/plan/status.ts:165-200`), `catalogo:estado --check` (`scripts/catalogo-estado.ts:463-560`), `ux:status --check` (`scripts/ux-status.ts:816-886`) y `LINEA_BASE` (`src/cli/kernel/audit.ts:197-236`).

---

## 1. Principios

1. **El estado no se escribe: se pregunta al árbol.** Es la regla de `CLAUDE.md:8` y `AGENTS.md:8`, y el motivo por el que existen `catalogo-estado.ts` (su encabezado, `:8-15`: «duró 42 commits») y `ux-status.ts` (`:10-24`: el guardián que medía una lista pasaba en verde con trece hojas incumpliendo). El metro de idioma recorre los `.ts` con el compilador de TypeScript (`typescript@5.9.3`, ya en `node_modules`) y el `program` real de Commander (`scripts/ux-status.ts:113`, `import { program } from '../src/cli/mnemosine.js'`), no un TSV de una auditoría.
2. **Cada número lleva su línea base y SÓLO PUEDE ENCOGER.** Ninguna de las medidas se puede llevar a cero en un commit (2 274 identificadores, 3 804 cadenas): sembrar la línea base con lo medido y fallar si crece es exactamente `LINEAS_BASE` de `scripts/ux-status.ts:213-220` con su `--apretar` (`:672-700`) y `LINEA_BASE` de `audit.ts:197`. Subir una línea base es un acto manual que queda en el diff con su porqué (`ux-status.ts:207-211`).
3. **Instrumento y cambio viajan en el mismo commit.** Es la regla de `docs/PROCESS.md:24-26` para `--exigir` y de `status.ts:322-327` para el piso («un renombre silencioso vacía el trinquete»). Un codemod que renombra sin tocar `criterios.ts`, `vitest.config.ts` y el manifiesto deja tres puertas en rojo; por eso el codemod los reescribe él y su criterio de aceptación es que las cuatro puertas existentes sigan en verde.
4. **Inglés es la FUENTE, español la primera traducción.** El catálogo `en` es el texto que hoy ya está en inglés (la ayuda del CLI: 1 397 cadenas, 6 castellanas, `verificacion/cli.md` §1.1), así que migrar una familia en inglés no cambia lo que sus pruebas afirman: 43 de 48 spec de `tests/cli` afirman texto inglés (`verificacion/cli.md` fila 19) y siguen pasando con `MNEMOSINE_LANG=en` clavado en la suite. Lo que cambia de texto son las 495 cadenas castellanas de ejecución (`cli.md` §1.1) y las 305 de servicios (`cli.md` §2.3): ésas sí arrastran sus aserciones, y el tramo que las migra lo paga.
5. **Un criterio afirma comportamiento, no identificadores** (`src/plan/criterios.ts:17-22`). El metro no añade criterios que hagan grep de nombres castellanos al tablero del plan: el idioma es un instrumento aparte, con su propia puerta en CI, para no inflar los 136 criterios con 6 de forma. Lo único que entra en `criterios.ts` es un criterio que vigila que la puerta exista en `ci.yml` (la forma que ya usa `:816-849` para `docs/auditorias/`).
6. **Lo persistido no se renombra; se renderiza al leer.** Migraciones inmutables (`docs/migraciones.md`), 4 números duplicados y `014` triple (`ls src/database/migrations | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -c | awk '$1>1'` → `2 012`, `3 014`, `2 015`, `2 018`), valores del panel persistidos en `policy_decisions` (`016_policy_decisions.sql:17-24`) con `ON CONFLICT DO NOTHING` (`policy-service.ts:57-58`), `account_roles.role` sin CHECK (`015_account_roles.sql:13`), mayor congelado por `041`. El metro los cuenta como **informativos** (radio de impacto), no como deuda que baje.
7. **Lo que es contrato de máquina no es texto.** Claves de `--json` (`output.ts:262-270`, `SCHEMA_VERSION` `:34`), nombres canónicos de comando y banderas (`vocabulary.ts:1-19`, cerrado y ya inglés), códigos de error (`errors.ts:1-9`, 72 códigos publicados en `docs/openapi.json` y citados 129 veces en 33 `.md`), claves JSON de `tests/golden/cfdi/*.esperado.json`, `x-*` del OpenAPI (`openapi.ts:137-157`). Ni el lint ni el metro los cuentan como deuda; si el dueño quiere renombrarlos es una decisión de contrato con versión (§5).

---

## 2. Arquitectura

### 2.1 Un léxico, dos consumidores — `scripts/idioma/lexico.ts`

Todo lo que decide «¿este token es castellano?» vive en UN módulo, y lo importan el metro y el lint. La verificación demostró por qué: el clasificador del inventario de criterios metía `ledger roles rls auto catch pool golden` en su lista castellana e inflaba todas las cifras entre 7 y 16 % (`verificacion/pruebas-criterios-ci.md` §1, fila «Rutas castellanas 49»); el de identificadores marcaba `MetaDePolizas` como mixto por `meta` (`verificacion/identificadores.md` §3); el de la API no llevaba `/i` y dejaba «Un comprobante…» como neutro (`verificacion/api.md` C7). Dos listas paralelas se desincronizan igual que dos tablas de estado.

Forma:

```ts
// scripts/idioma/lexico.ts
export const CASTELLANO: ReadonlySet<string>;   // ~600 tokens: es_sorted.txt del inventario, depurado
export const NEUTRO: ReadonlySet<string>;       // acrónimos y topónimos: sat cfdi rep diot iva isr imss inpc uma rfc pac mx clabe ppd…
export const INGLES_EXTRA: ReadonlySet<string>; // abreviaturas que /usr/share/dict/words no trae (opts ctx cfg…)
export function tokens(identificador: string): string[];   // camelCase, snake_case, kebab-case, dígitos
export type Clase = 'es' | 'en' | 'mixto' | 'neutro';
export function clasificar(identificador: string): { clase: Clase; castellanos: string[] };
```

La regla de decisión es la de `clasificar.pl` del inventario (`/tmp/investigacion-idioma/inventario/datos/clasificar.pl:36-47`): un token castellano y ninguno inglés → `es`; ambos → `mixto`; sólo ingleses → `en`; sólo neutros → `neutro`. **No** se usa `/usr/share/dict/words` en producción (no está en CI: es un archivo de macOS); el inglés se decide por exclusión (lo que no es castellano ni neutro es inglés) más `INGLES_EXTRA` para las abreviaturas. Es lo que ya hace `fueraDeIdioma` en `ux-status.ts:291-322` (lista corta de partículas + acentos), llevado a identificadores.

Prueba: `tests/idioma/lexico.spec.ts` fija (a) que los 12 tokens que inflaron la verificación (`ledger roles rls auto catch pool golden bucket delta commander via factor`) NO están en `CASTELLANO`; (b) que los acrónimos fiscales están en `NEUTRO`; (c) una muestra de 40 identificadores reales con su clase esperada (la del inventario, 39/40 coherente); (d) que `clasificar('MetaDePolizas')` es `es`, no `mixto`.

### 2.2 El metro — `scripts/i18n-estado.ts`, `npm run i18n:estado`

Mismo contrato de línea de comandos que `ux-status.ts:3-8`:

```
npm run i18n:estado              tabla: medida · hoy · línea base · estado
npm run i18n:estado -- --json    contrato de máquina; stdout SÓLO el JSON (ux-status.ts:735-760)
npm run i18n:estado -- --check   sale 1 si (a) un número creció, (b) el bloque de docs/language.md está desfasado,
                                 (c) una entrada de la línea base por archivo ya no se viola (deuda muerta)
npm run i18n:estado -- --apretar reescribe las líneas base que quedaron con holgura; NUNCA sube ninguna
npm run i18n:estado -- --escribir regenera el bloque entre <!-- IDIOMA-ESTADO:INICIO --> … FIN en docs/language.md
```

**Las medidas** (`CLAVES`, con su semilla medida en `b31e62a`):

| clave | qué cuenta | cómo lo deriva | semilla (comando) |
|---|---|---|---|
| `identificadores-castellanos` | declaraciones de nivel superior (`function|const|let|class|interface|type|enum`) exportadas e internas en `src/`, `scripts/`, cuyo nombre es `es` o `mixto` | `ts.createSourceFile` + recorrido de `SourceFile.statements`; `clasificar(nombre)` | **2 274** = 2 065 es + 209 mixto sobre 4 627 declaraciones y 375 `.ts` (`perl datos/extract.pl $(find src -name '*.ts') \| COL=4 perl datos/clasificar.pl … \| cut -f6 \| sort \| uniq -c` en el árbol congelado → `2278 en 2065 es 209 mixto 75 neutro`) |
| `miembros-castellanos` | miembros de nivel 1 de `interface`/`type` exportados (claves JSON potenciales) | mismo recorrido, `TypeLiteral`/`InterfaceDeclaration.members` | **1 473** = 1 391 es + 82 mixto sobre 5 362 (`verificacion/identificadores.md` §4.1, `work/miembros.tsv`). **Informativa** hasta la decisión §5.3: son contrato de `--json`/REST |
| `archivos-castellanos` | archivos `.ts` de `src/`, `scripts/`, `tests/` con token castellano en el nombre | `tokens(basename)` ∩ `CASTELLANO` | src **50** (`find src -name '*.ts' \| grep -E "/([a-z0-9-]*-)?(TOKENS)(-[a-z0-9-]*)?\.ts$"` → 52, de los que `rep-command.ts` y `rep-linkage.ts` son acrónimo → 50; coincide con los 51 de `verificacion/comentarios-y-corpus.md` §3.5 menos `jurisdiccion.ts`, que no está en ningún commit); scripts **13** (`ls scripts \| grep -cE 'artefacto\|catalogo\|corpus\|costo\|eval-clasificador\|mutantes\|provision-roles\|publicar\|reclasificar\|rellenar\|rol-auditor\|niif'`); specs **139** (`node inventario/metodo/clasificar-tests.js`, reproducido byte a byte en `verificacion/pruebas-criterios-ci.md`) |
| `cadenas-sin-catalogo` | literales de prosa que llegan a un humano y no pasan por `t()`: argumentos de `console.log/error/warn`, `CliError` y sus 10 constructores (`exit.ts:65-115`), `.description(`, `.option(` (3.er argumento), `.argument(`, `addHelpText(`, `AppError` y subclases (`errors.ts`), etiquetas de `fact/linea/renglon/field` (`cli.md` §2.1) y encabezados pasados a `render()` | AST: `CallExpression` cuyo callee esté en el conjunto de emisores y cuyo argumento sea `StringLiteral`/`TemplateExpression` con ≥ 1 palabra alfabética de ≥ 3 letras, no envuelto en `t(`; sin filtro de «≥ 3 palabras» (el extractor del inventario lo tenía y perdió 95 etiquetas, `cli.md` §2.1) | CLI: `console.*` **374**, `CliError` **18** + helpers **349**, `.description(` **309**, `.option(` **700**, `addHelpText(` **185**, `render(` **199** (`grep -rhoE … src/cli --include='*.ts' \| wc -l`, cada patrón en el árbol congelado); servicios+utils `throw new …Error('…')` **305**; `new AccountingError(` **113** en `src`. La semilla exacta la da el propio metro la primera vez (`--sembrar`): hoy es «todas», porque `t()` no existe |
| `claves-sin-traducir` | claves de `src/i18n/en.ts` sin entrada en `es.ts` o al revés, y claves cuyo conjunto de `{parametros}` difiere | importa los dos catálogos | **0** por construcción; no es trinquete sino invariante duro (la prueba de sincronía, §2.4) |
| `comentarios-castellanos` | líneas de comentario `//`, `/* */`, JSDoc y `--` dentro de template literals SQL, clasificadas por bloque | escáner del inventario (`cuenta_comentarios.py`) portado a TS, más los 128 `--` en template literals que no veía (`comentarios-y-corpus.md` §3.1) | **22 529** líneas es de 29 125 (`python3 inventario/cuenta_comentarios.py src 1 /dev/null` en el árbol congelado → `TOTAL 375 150893 29125 22529 5506`) + 128 SQL embebidos (`grep -rn -E "^\s*--\s" src --include='*.ts' \| wc -l`). **Informativa** hasta la decisión §5.1 |
| `anclas-por-ruta` | dónde vive una ruta de archivo como CADENA: `criterios.ts` (`codigoDe/crudoDe/existe/rutaDe/archivo:`), `vitest.config.ts`, `vitest.integration.config.ts`, `SUELO_COBERTURA_*` (`criterios.ts:575-604`), `manifiesto.json`, `vi.mock(` e `import(` en tests, `.md`, `CODEOWNERS`, `ci.yml` | greps sobre el árbol; NO es deuda que baje: es el **radio de impacto** de un renombre, y el metro lo imprime para presupuestar | criterios **134** rutas `src/` (`grep -oE "['\"\`]src/[A-Za-z0-9_./-]+\.(ts\|json\|sql\|md)['\"\`]" src/plan/criterios.ts \| tr -d "'\"\`" \| sort -u \| wc -l`); vitest **6 + 9** (`grep -cE "^\s*'src/[^']+':\s*\{" vitest*.config.ts`); manifiesto **46** (`node -e "…Object.keys(m.hashes).length"`); `vi.mock` **81** rutas únicas, 6 castellanas; `import('./…')` **30**; docs+raíz **422** (`grep -rhoE 'src/[A-Za-z0-9_./-]+\.(ts\|sql)' docs AGENTS.md CONTRIBUTING.md README.md CLAUDE.md \| sort -u \| wc -l`), **92** ya muertas (`verificacion/identificadores.md` §4.6) |
| `plantillas-persistidas` | plantillas de sistema que escriben texto en la base (`description:` de pólizas, `calculation_notes`, `ai_reasoning` de sistema, `motivo` de veredictos) | grep de los 11 escritores + los 3 que la verificación añadió | **106** `description:` (`verificacion/textos-emitidos-y-persistidos.md` C1) + **21** de nómina (`paycheck_taxes.calculation_notes`, §3.1) + **4** de póliza (§3.1.3) + **7** `motivo`. **Informativa**: la otra lente decide clave+parámetros |

Lo que el metro **no** duplica: `nodos-fuera-del-idioma-canonico` (ayuda del CLI fuera del inglés) ya es una medida de `ux-status.ts:213` con línea base 7. El metro la cita leyendo `ux:status --json` (`comoJson`, `ux-status.ts:735`) y no la recuenta: dos instrumentos con dos números para la misma cosa es la clase de duplicado que `status.ts:180-183` prohíbe para el piso.

**Línea base y trinquete.** Dos archivos, con la división que ya tiene la casa:

- `docs/idioma-lineas-base.json` — un número por clave (como `docs/catalogo-minimos.json` para el catálogo, `catalogo-estado.ts:31,489-507`). `--check` falla si `medido > lineaBase`; `--apretar` baja las que tienen holgura y una prueba (`tests/idioma/i18n-estado.spec.ts`, calcada de `censo-superficie.spec.ts:488-525`) falla mientras haya holgura: «una línea base con holgura deja de ser deuda registrada y se vuelve un permiso permanente».
- `docs/idioma-linea-base-por-archivo.json` — para las dos medidas que el lint vigila (`identificadores-castellanos`, `cadenas-sin-catalogo`): `{ "src/services/sat/diot/hechos.ts": { "identificadores": 14, "cadenas": 3 } }`. Es la `LINEA_BASE` de `audit.ts:197` con clave por archivo en vez de por comando: el lint acusa cualquier archivo que supere su cifra, y `--check` acusa toda entrada cuyo archivo ya cumple o ya no existe (deuda muerta que hay que borrar; `auditarContraLineaBase`, `audit.ts:250-267`, `obsoletas`). Por archivo y no por identificador: una lista de 2 274 nombres se desincroniza con cada refactor que no tiene que ver con idioma; una cifra por archivo (375 entradas) sólo se toca cuando el archivo gana terreno.

**Semilla.** `--sembrar` escribe ambos JSON con lo medido hoy y se corre UNA vez, en el commit que enciende la puerta (§4, I1). A partir de ahí sólo `--apretar`.

**El bloque en el documento.** `docs/language.md` es nuevo: el documento rector de la política de idioma (hoy vive repartida entre `src/cli/README.md:396`, `docs/cli-command-catalog.md:2050`, `CONTRIBUTING.md:158`, `docs/PROCESS.md:58` y `docs/auditorias/2026-09-01-usabilidad/ux-idioma.md:874-882`). Lleva la prosa de la regla (qué es fuente, qué es contrato, qué no se traduce: la lista de `ux-idioma.md:876-882` se hereda entera) y, entre `<!-- IDIOMA-ESTADO:INICIO -->` y `<!-- IDIOMA-ESTADO:FIN -->`, la tabla generada: `NO EDITAR A MANO` (`catalogo-estado.ts:388-393`). Cada fila: medida, hoy, línea base, delta, los 5 primeros casos.

**CI.** Una línea en el job `Estado del plan` de `.github/workflows/ci.yml`, tras `:176` (`ux-status.ts --check`): `- run: npx tsx scripts/i18n-estado.ts --check`, con su comentario de por qué en el estilo de `:146-175`. Y un criterio en `criterios.ts` que lo vigile, con espejo: `codigoDe('.github/workflows/ci.yml')` debe contener `i18n-estado.ts --check`; mutante `de: 'i18n-estado.ts --check'`, `a: 'i18n-estado.ts'`. Es la única entrada del idioma en el tablero del plan (principio 5).

### 2.3 El lint — reglas propias en `eslint.config.mjs`, sin plugin externo

ESLint 9.39.5 con flat config (`eslint.config.mjs:1-30`) admite un plugin declarado en línea (`plugins: { casa: { rules: { … } } }`) sin publicar un paquete. Dos reglas en `scripts/idioma/reglas-eslint.mjs`, importadas desde `eslint.config.mjs`:

1. **`casa/identificadores-en-ingles`** — visita `FunctionDeclaration`, `VariableDeclarator`, `ClassDeclaration`, `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`, `TSEnumDeclaration`, `TSPropertySignature` y **parámetros** (el inventario no contaba parámetros ni locales; el lint sí, porque el pedido es «identificadores»); llama a `clasificar()` del léxico; reporta `es`/`mixto`. Con la línea base por archivo: el mensaje dice «este archivo tiene N identificadores castellanos y su línea base es M» y sólo reporta cuando N > M. Para un archivo que no está en la línea base (nuevo), M = 0: **un archivo nuevo nace en inglés**, que es lo único que un lint puede garantizar sin big-bang.
2. **`casa/cadena-de-usuario-sin-catalogo`** — mismo conjunto de emisores que la medida `cadenas-sin-catalogo`; misma línea base por archivo; misma regla «archivo nuevo → 0».

Severidad `error` (no `warn`): `--max-warnings 1117` de `package.json:18` es un tope compartido con las reglas `no-unsafe-*` (`eslint.config.mjs:16-20`) y un idioma que se cuela ahí sería invisible. Con línea base por archivo no hace falta el tope: el número que trinca está en el JSON.

Por qué no un plugin de i18n del ecosistema: los que existen (`eslint-plugin-i18next`, `eslint-plugin-formatjs`) detectan literales JSX/`t()`; no saben qué es un emisor de Commander ni un `AccountingError`, y el conjunto de emisores es el contrato de esta casa (`kernel/index.ts:14-77`).

### 2.4 El catálogo — `src/i18n/`, propio, tipado, inglés como fuente

Se propone **propio**, no i18next/formatjs/lingui (decisión §5.6). Razones que pesan aquí: (a) `package.json:36-64` no trae ninguna dependencia de i18n y la casa ha rechazado añadir bibliotecas donde ~100 líneas bastan (`formato-y-locale.md` H9: «no hay biblioteca que sustituir»); (b) las claves tipadas se comprueban con `tsc` y las lee `codigoDe` en un criterio, que es como esta casa prueba cosas; (c) `Intl.PluralRules` e `Intl.NumberFormat` están garantizados (`engines.node >= 20`, `package.json:85`; hoy `grep -rn "PluralRules\|NumberFormat\|DateTimeFormat" src` → 0 usos, y 304 plurales a mano `palabra(s)` + 18-22 ternarios, `verificacion/formato-y-locale.md` filas 14-15).

```
src/i18n/
  index.ts     t(clave, params?) · idiomaDeSalida() · IDIOMAS = ['es','en'] as const · PRIMERO = 'es'
  en.ts        export const EN = { 'cli.output.no_rows': 'No rows.', 'cli.output.truncated': 'Showing {shown} of {total} rows. …', … } as const  ← FUENTE
  es.ts        export const ES: Record<keyof typeof EN, string> = { 'cli.output.no_rows': 'Sin filas.', … }
  errores.ts   mensajes por CÓDIGO de AccountingError/AppError: { PERIOD_ALREADY_OPEN: { en: …, es: … } }  (72 códigos)
  plural.ts    plural(clave, n): usa Intl.PluralRules(idioma) y claves `…_one` / `…_other`
```

- **Claves** con espacio de nombres por superficie y familia (`cli.bank.statement.imported`, `api.error.PERIOD_LOCKED`, `agent.tool.…`): el metro cuenta por prefijo y así «migrar `bank`» tiene cifra propia.
- **`es.ts` tipado contra `keyof typeof EN`**: una clave que falte en `es` es error de `tsc`, no de una prueba. La **prueba de sincronía** (`tests/i18n/sincronia.spec.ts`, calcada de `tests/ai/niif-registry.spec.ts:25-43`) añade lo que `tsc` no ve: (i) el conjunto de `{parametros}` de cada clave es el mismo en los dos idiomas; (ii) ninguna cadena vacía; (iii) ninguna clave de `es` con marca de inglés ni de `en` con acento/partícula castellana (`fueraDeIdioma` de `ux-status.ts:311-322`, exportada o movida al léxico); (iv) toda clave declarada tiene al menos un consumidor `t('clave'` en `src/` (capacidad huérfana: `consumidoresDe`, `criterios.ts:325-328`); (v) `IDIOMAS[0] === 'es'`.
- **Resolución del idioma.** Hoy hay UNA función, `resolveLanguage()` (`src/ai/providers/config.ts:1117-1131`: `MNEMOSINE_LANG` > `config.language` > `'es'`), que gobierna sólo al agente, y el comando `lang` dice explícitamente que «CLI UI stays English» (`mnemosine.ts:2039`). El catálogo la reutiliza —no se inventa otra— y se renombra a `idiomaDeSalida()` reexportada desde `src/i18n/index.ts`; que gobierne también al CLI es la decisión §5.7. `.env.example:350` promete «omisión: la del sistema» y el código devuelve `'es'` fijo (`formato-y-locale.md` H5): el catálogo hereda `'es'` fijo y se corrige el `.env.example`.
- **Encaje en el kernel.** `src/cli/kernel/i18n.ts` reexporta `t` y añade `configureHelp` de Commander 15 (`node_modules/commander/typings/index.d.ts`, `configureHelp`/`Help` — hoy `grep -rn "configureHelp\|configureOutput" src/cli` → 0): los rótulos `Usage:`, `Options:`, `Commands:`, `Arguments:` salen del catálogo (`cli.help.usage`…). `kernel/index.ts:14-77` lo reexporta: los comandos importan `t` «de aquí y de ningún otro sitio» (`:8-11`). `render()` (`output.ts:216`) gana `labels?: Record<string, string>` para separar etiqueta de clave (brecha 5 de `ux-idioma.md:327`); las claves de `--json` no se tocan.
- **Errores de servicio.** `AccountingError(code, message)` (`errors.ts:70-75`) conserva el `message` inglés como fuente; `reportError` (`mnemosine.ts:291-317`) y `errorHandler` (`error-handler.ts:12-28`) consultan `errores.ts` por `code` y sustituyen el mensaje cuando hay entrada. Así las 113 llamadas se migran por código y no por sitio, y la API traduce por `Accept-Language` (`req.acceptsLanguages`, Express 4.22.2; hoy `grep -rn "acceptsLanguages\|Accept-Language" src` → 0).
- **Pruebas.** `vitest.config.ts` gana `test.env: { MNEMOSINE_LANG: 'en' }` (Vitest 4: `test.env`) para que las 43 spec que afirman inglés no cambien; los tres sitios que hoy hacen `delete process.env.MNEMOSINE_LANG` (`tests/cli/codigos-de-salida-hojas.spec.ts:63`, `tests/cli/status-command.spec.ts:74`, `tests/ai/system-prompt.spec.ts:147,161`) pasan a fijar `'en'` explícito. Las pruebas de la superficie española se escriben contra `es` con `t()` o con `MNEMOSINE_LANG=es` por caso.

### 2.5 El extractor — `scripts/idioma/extraer.ts`, `npm run i18n:extraer -- <ruta>`

Semiautomático, por archivo, para que cada PR migre una familia (principio 3): recorre el AST con el compilador, localiza los literales de los emisores (mismo conjunto que el lint), propone una clave por prefijo + slug de las 4 primeras palabras, convierte `${x}` en `{x}`, escribe la entrada en `en.ts` (texto tal cual si ya es inglés) y deja `t('clave', { x })` en el fuente. Las cadenas castellanas las escribe en `es.ts` y deja en `en.ts` una entrada `'__TRADUCIR__: <texto es>'` que la prueba de sincronía rechaza: el inglés fuente lo escribe una persona (o el agente, revisado), nunca el extractor. Plurales `palabra(s)` (272 en `src/cli`) los marca con `// i18n:plural` y no los transforma: el plural correcto es `plural()` con dos claves, y decidirlo es humano.

No usa `i18next-parser` ni `formatjs extract` por lo mismo que el lint: no conocen los emisores de la casa.

### 2.6 El codemod de renombrado — `scripts/idioma/renombrar.ts`

`npm run i18n:renombrar -- --archivo src/services/sat/diot/hechos.ts --a src/services/sat/diot/facts.ts` y `-- --simbolo hechosDe --a factsOf --en src/services/sat/diot/hechos.ts`. Herramienta: **ts-morph** como devDependency (decisión §5.10; alternativa sin dependencia nueva: `ts.LanguageService.findRenameLocations` + `getEditsForFileRename`, que el compilador 5.9.3 trae). ts-morph se prefiere porque `SourceFile.move()` reescribe todos los `import`/`export from` del proyecto —incluidos `tests/` y `scripts/`, con `tsconfig.test.json:3-7`— en una llamada.

Lo que ts-morph **no** ve, y el codemod reescribe en el mismo commit como cadenas:

| sitio | cómo lo actualiza | verificación |
|---|---|---|
| `src/plan/criterios.ts` — `codigoDe('ruta')`, `crudoDe`, `existe`, `rutaDe`, `archivo: 'ruta'` de mutantes, `SUELO_COBERTURA_UNITARIA`/`_INTEGRACION` (`:575-604`) | sustitución de la cadena exacta de la ruta vieja | `npm run plan:status -- --piso` en verde y `npm run mutantes` con 0 `ancla-rota` (`scripts/mutantes.ts:49-55`) |
| identificadores citados en regex de criterios (12 reales, `verificacion/identificadores.md` fila «15 criterios») | lista `--tambien-en-criterios` que el codemod imprime: NO los reescribe a ciegas, porque un regex con `\b` cambia de sentido; el humano los edita y `mutantes` lo prueba | mutantes 120/120 |
| `vitest.config.ts` y `vitest.integration.config.ts` — claves de `thresholds` (6 + 9) e `include` | sustitución de la clave; los NÚMEROS no se tocan | `s4a-ataque.int.spec.ts:346-347` exige que toda clave de `thresholds` esté en el suelo: por eso suelo y config van juntos |
| `src/ai/docs/manifiesto.json` — 46 rutas hasheadas | cambia la clave de ruta; recalcula el hash SÓLO si el diff del archivo se limita a especificadores de import (lo comprueba con `git diff --word-diff` sobre el archivo movido); si hay otro cambio, lo deja caducado y lo dice | `npx tsx scripts/corpus-manifiesto.ts --check` |
| `tests/**` — `vi.mock('…')` (81 rutas, 6 castellanas), `import('./…')` (30 en `src`), `readFileSync(resolve(__dirname, '…src/…'))` (`reconciliation-adjustments.spec.ts:107-118`, `g4a-ataque`), 43 rutas literales | sustitución de cadena | `npm test` y `npm run typecheck:tests` |
| `docs/**/*.md`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `src/ai/docs/*.md`, `.github/CODEOWNERS`, `.github/workflows/*.yml`, `package.json` (scripts) | sustitución de la ruta; `docs/auditorias/` y `docs/HISTORY.md` se EXCLUYEN (son registro histórico, principio 6) | `scripts/idioma/verificar-renombre.ts`: `git grep -n '<basename viejo>' -- . ':!src/database/migrations' ':!docs/auditorias' ':!docs/HISTORY.md' ':!docs/archive'` → 0 líneas |
| `src/cli/kernel/audit.ts` `LINEA_BASE:197-236` | **no se toca**: guarda `comando\|regla\|detalle`, no rutas (`verificacion/esquema-y-vocabularios.md` §3.5); sólo cambiaría si se renombra un COMANDO, y el vocabulario es cerrado e inglés | — |
| `docs/cli-command-catalog.md` — 616 citas `archivo:línea` (`catalogo-estado.ts:243-255`) | sustitución de la ruta; la línea puede quedar desfasada y `catalogo:estado --check` lo acusa como `fueraDeRango` | `npx tsx scripts/catalogo-estado.ts --check` |

**Orden de renombrado** (del inventario de pruebas, confirmado): `tests/` y `scripts/` primero (nadie los cita por ruta salvo `criterios.ts:1108-6241`, 6 rutas), luego `src/` fuera del motor sellado, y al final los 10 archivos que anclan mutantes (`permisos.ts` ×2, `barrido-entregas`, `polizas-service`, `balanza-service`, `balanza-invariantes`, `finiquito-math`, `cfdi-nomina-generator`, `scripts/costo-por-fila.ts`, `scripts/corpus-manifiesto.ts`; `verificacion/identificadores.md` fila «25 mutantes») y `criterio-cierre.ts`, que mueve a la vez `vitest.config.ts`, `vitest.integration.config.ts`, `SUELO_COBERTURA_UNITARIA` y `s4a-ataque`.

**Lo que el codemod se niega a renombrar** (falla cerrado con el motivo): `src/database/migrations/*` (`migrate.ts:93-95` cuenta por nombre de archivo), nombres de tabla/columna (esquema, otra lente), nombres de script npm citados en `CLAUDE.md`/`AGENTS.md` sin `--tambien-npm`, claves de `tests/golden/cfdi/*.esperado.json`, y cualquier identificador que aparezca en un `de:` de mutante (lo lista y para).

### 2.7 Identidad estable de los criterios — prerrequisito de traducir prosa

`identidadDe` es `paquete · enunciado` (`status.ts:165`), el piso guarda esa cadena (`docs/criterios-minimos.json`, 69 verdes), y `s4a-ataque.int.spec.ts:283-291` busca un criterio por su enunciado castellano literal. Traducir un enunciado hoy = criterio «desaparecido» en el piso (`status.ts:189-194`) y ataque «desanclado». Se propone un campo opcional `id?: string` en `Criterio` (`criterios.ts:63-99`), `identidadDe = c.id ?? `${paquete} · ${enunciado}``, migrar `docs/criterios-minimos.json` a ids en un commit sin cambiar ningún enunciado (`compararConPiso`, `status.ts:180-200`, sigue funcionando) y que `s4a-ataque` busque por id. Es pequeño y desbloquea la decisión §5.2 sin obligarla.

---

## 3. Cómo se mide el avance

- **Por medida:** el bloque de `docs/language.md` publica hoy/línea base/delta; el JSON de `--json` es el contrato para gráficas o para el agente.
- **Por familia:** `cadenas-sin-catalogo` se agrupa por archivo y por prefijo de clave; «`bank` migrada» = 0 cadenas sin catálogo en `src/cli/bank-command.ts` y su entrada de la línea base por archivo borrada.
- **Por dirección:** el trinquete falla si un número sube; la prueba falla si baja sin apretar; `--check` falla si una entrada por archivo quedó muerta. Tres direcciones, como el piso (`status.ts:151-163`).
- **Lo que NO mide y se dice:** la calidad de una traducción (prosa), el idioma dentro de una cadena ya catalogada (lo vigila la sincronía, no el metro), y todo lo persistido (informativo).

---

## 4. Tramos

Tamaños: S ≤ 1 día · M 2-4 días · L 1-2 semanas · XL > 2 semanas, para un ejecutor con el árbol limpio. Cada tramo es una issue y un PR (`docs/PROCESS.md:20-26`).

| código | título | entrega | criterio ejecutable | depende de | tamaño |
|---|---|---|---|---|---|
| **I0** | El léxico compartido | `scripts/idioma/lexico.ts` (`CASTELLANO`, `NEUTRO`, `INGLES_EXTRA`, `tokens`, `clasificar`), `tests/idioma/lexico.spec.ts` | `tests/idioma/lexico.spec.ts` verde: los 12 tokens que inflaron la verificación no están en `CASTELLANO`; 40 identificadores de muestra con su clase; `clasificar('MetaDePolizas').clase === 'es'` | — | S |
| **I0b** | La regla de la casa cambia donde está escrita | `docs/language.md` (prosa: fuente inglés, español primero, lista de lo que no se traduce heredada de `ux-idioma.md:876-882`), y `CONTRIBUTING.md:158`, `docs/PROCESS.md:58`, `README.md:345-346` reescritos según §5.1 | criterio nuevo en `criterios.ts`: `crudoDe('CONTRIBUTING.md')` NO contiene «Los comentarios y la documentación van en español»; mutante que lo reintroduce → `falla` | decisión §5.1 | S |
| **I1** | El metro `i18n:estado` y su puerta | `scripts/i18n-estado.ts` con las 8 medidas, `--json/--check/--apretar/--escribir/--sembrar`; `docs/idioma-lineas-base.json` y `docs/idioma-linea-base-por-archivo.json` sembrados; bloque en `docs/language.md`; `package.json` `"i18n:estado"`; línea en `ci.yml`; `tests/idioma/i18n-estado.spec.ts` (mide un árbol sintético; `--apretar` sólo baja; holgura = rojo; `--json` sólo JSON en stdout) | criterio en `criterios.ts`: `codigoDe('.github/workflows/ci.yml')` contiene `i18n-estado.ts --check` y `existe('docs/idioma-lineas-base.json')`; mutantes: quitar `--check` → falla; borrar el JSON → falla. Y `npx tsx scripts/i18n-estado.ts --check` sale 0 en el commit que lo enciende | I0 | M |
| **I2** | Identidad estable de los criterios | `id?` en `Criterio`; `identidadDe` por id; `docs/criterios-minimos.json` migrado a ids (mismos 69, sin tocar enunciados); `s4a-ataque.int.spec.ts:283` busca por id; `tests/plan/` prueba que dos criterios no comparten id | `npm run plan:status -- --piso` verde con el JSON en ids; criterio: `codigoDe('src/plan/status.ts')` contiene `c.id ??`; mutante que vuelve a `${c.paquete} · ${c.enunciado}` sin id → falla | — | S |
| **I3** | El lint que impide nacer en castellano | `scripts/idioma/reglas-eslint.mjs` con `casa/identificadores-en-ingles` y `casa/cadena-de-usuario-sin-catalogo`; plugin en línea en `eslint.config.mjs`; línea base por archivo (la de I1); `tests/idioma/reglas-eslint.spec.ts` con `RuleTester` | `npm run lint` verde en el commit; RuleTester: un archivo nuevo con `function calcularSaldo()` → 1 error; un archivo de la línea base con N ≤ M → 0; `i18n:estado --check` acusa una entrada por archivo muerta (prueba con línea base sintética) | I0, I1 | M |
| **I4** | El catálogo y su prueba de sincronía | `src/i18n/{index,en,es,errores,plural}.ts`; `idiomaDeSalida()` sobre `resolveLanguage` (`config.ts:1117`); `src/cli/kernel/i18n.ts` + reexport en `kernel/index.ts`; `configureHelp` con rótulos del catálogo; `render()` con `labels`; `test.env.MNEMOSINE_LANG='en'` en `vitest.config.ts` y los 3 `delete` ajustados; `tests/i18n/sincronia.spec.ts` (claves, parámetros, vacías, idioma, huérfanas, `IDIOMAS[0]==='es'`) | criterio: `existe('src/i18n/en.ts')`, `existe('src/i18n/es.ts')`, `codigoDe('src/cli/kernel/index.ts')` exporta `t`; mutante que borra `es.ts` → falla; mutante `IDIOMAS = ['en','es']` → la sincronía falla. `bilingual-matrix.spec.ts:306` («Usage:») y `raiz-y-remedios.spec.ts:131-151` siguen verdes bajo `en` | I0 | M |
| **I5** | El extractor | `scripts/idioma/extraer.ts`, `npm run i18n:extraer`; marca `__TRADUCIR__` y `// i18n:plural`; `tests/idioma/extraer.spec.ts` sobre un fuente sintético (emisor → clave, `${x}` → `{x}`, castellano → `es.ts` + marcador) | la prueba de sincronía rechaza cualquier `__TRADUCIR__` en `en.ts` (mutante en un spec: inyectar uno → rojo); el extractor sobre `src/cli/kernel/output.ts` deja 0 cadenas sin catálogo en ese archivo y `i18n:estado` lo refleja | I1, I4 | L |
| **I6a** | Piloto: el kernel y una familia | `src/cli/kernel/*` (rótulos de `output.ts:286-292`, `Showing … rows`, `No rows.`, remedios de `mnemosine.ts:291-317`) y `bank` (la familia más castellana: 233/180 vs 16, `cli.md` §1.1) migrados con `t()`; sus aserciones castellanas convertidas a `t()`/`es` | `i18n:estado --json` → `cadenas-sin-catalogo` = 0 para `src/cli/kernel/**` y `src/cli/bank-command.ts`; entradas por archivo borradas; `MNEMOSINE_LANG=es npx tsx src/cli/mnemosine.ts bank --help` muestra `Uso:` (prueba nueva `tests/cli/superficie-es.spec.ts`) | I5 | L |
| **I6b…n** | El resto del CLI, por familia | una issue por familia (24 mezclan idiomas, `cli.md` §1.1); cada PR baja `cadenas-sin-catalogo` y borra su entrada por archivo | igual que I6a, por archivo; `ux:status --check` sigue verde (la ayuda fuente sigue en inglés) | I6a | XL (suma) |
| **I7** | La API: mensajes por código y un solo sobre | `errores.ts` con los 72 códigos (en/es); `errorHandler` traduce por `Accept-Language`; `ai-webhooks.ts:82,124,131` y `/ready` (`index.ts:150-154`) pasan al sobre único; 404 propio; `withdrawn-endpoints.spec.ts:109-142` corre en `en` | `tests/api/errores-por-idioma.spec.ts`: misma petición con `Accept-Language: es` y `en` → mismo `code`, `message` distinto; `grep -rnE "json\(\{\s*error:" src/api src/index.ts` → 0 (criterio con mutante que reintroduce uno) | I4 | M |
| **I8a** | El codemod de renombrado | `scripts/idioma/renombrar.ts` (ts-morph) + `verificar-renombre.ts`; `tests/idioma/renombrar.spec.ts` sobre un proyecto sintético en `$TMP` (import, `vi.mock`, `codigoDe`, clave de `thresholds`, ruta en `.md`, manifiesto con diff sólo de imports → hash recalculado; con otro diff → caducado) | la prueba sintética; y un ensayo real: renombrar `src/services/sat/diot/hechos.ts` → `facts.ts` en el commit del tramo con las 5 puertas (`plan:status --piso`, `mutantes`, `corpus:estado --check`, `catalogo:estado --check`, `ux:status --check`) en verde y `verificar-renombre` → 0 | I1, decisión §5.9/§5.10 | M |
| **I8b** | Renombrar `tests/` y `scripts/` | 139 specs y 13 scripts; `package.json` con alias (`"mutantes"` y `"catalogo:estado"` se conservan como alias mientras `CLAUDE.md`/`AGENTS.md` los citen, decisión §5.5) | `archivos-castellanos` baja a 50 (sólo `src`); `verificar-renombre` → 0 por archivo | I8a | L |
| **I8c** | Renombrar `src/` fuera del motor sellado | 39 de los 50 (los que no anclan mutante ni umbral); identificadores exportados por archivo (`--simbolo`) | `archivos-castellanos` = 11; `identificadores-castellanos` baja por PR; puertas verdes | I8b | L |
| **I8d** | Los 11 que anclan el instrumento | los 10 con mutante + `criterio-cierre.ts` (vitest ×2 + `SUELO` + `s4a`); cada uno su PR | `archivos-castellanos` = 0 en `src`; `mutantes` 120/120 muertos; `s4a-ataque` verde | I8c | M |
| **I9** | Comentarios (sólo si §5.1 = sí) | `comentarios-castellanos` pasa de informativa a trinquete; traducción por archivo, humana o del agente con revisión; `reconciliation-adjustments.spec.ts:107-118` se cambia para leer `codigoDe` (sin comentarios); los 10 mutantes que inyectan comentarios castellanos (`criterios.ts:2241,4530,…`) se reescriben en inglés | el número baja y la línea base se aprieta por PR; la prueba de `reconciliation-adjustments` no lee comentarios | I1, I0b | XL |

---

## 5. Decisiones del dueño (no se deciden en el diseño: se preguntan)

1. **¿Comentarios, documentación y mensajes de commit también en inglés?** `CONTRIBUTING.md:158`, `docs/PROCESS.md:58` y `README.md:345-346` ordenan español; 22 529 líneas de comentario (78 %), 135 `enunciado:` de criterios y 247 commits (117 con acento) están en castellano. Son texto para personas, no superficie de usuario. Sin esta decisión, `comentarios-castellanos` es informativa y I9 no existe.
2. **¿Se traducen los enunciados de `criterios.ts` y las celdas del catálogo (`hecha en F03`, `criterios.ts:820`)?** Rompe el piso (`status.ts:165`) y E0.0 (regex de prosa `:820`) salvo que I2 vaya antes. Recomendación: I2 sí (barato, sin efecto), traducir no hasta que §5.1 se decida.
3. **¿Se renombran los 1 391 miembros castellanos de interfaces exportadas?** Son claves de `--json`/REST/GraphQL (`output.ts:262-270`; `SCHEMA_VERSION` `:34` «it is an API»). Recomendación: no; si sí, con `SCHEMA_VERSION` 2 y `docs/openapi.json` regenerado, y fuera de este plan.
4. **¿Se renombran los 24 códigos de error castellanos (de 72) y las 10 claves `x-*` del OpenAPI?** Contrato publicado (`openapi.ts:137-157`; 129 menciones en 33 `.md`; `withdrawn-endpoints.spec.ts`). Recomendación: no; el mensaje se traduce por código (I7), el código queda.
5. **¿Se renombran los scripts npm castellanos (`mutantes`, `catalogo:estado`, `costo:por-fila`, `corpus:estado`)?** `CLAUDE.md:8` y `AGENTS.md:8` ordenan correrlos por ese nombre; `ci.yml:145-176` los invoca por ruta. Recomendación: renombrar el archivo con alias npm durante un tramo, y actualizar `CLAUDE.md`/`AGENTS.md` en el mismo PR.
6. **Biblioteca de catálogo: propia (recomendada) o i18next/formatjs/lingui.** Propia = 0 dependencias, claves tipadas, `Intl.PluralRules`; i18next = ICU completo, ecosistema, ~200 KB y una convención de archivos JSON que `codigoDe` y `tsc` no ven.
7. **¿`mnemosine lang` / `MNEMOSINE_LANG` gobiernan también el CLI y la API, con omisión `es`?** Hoy sólo al agente, y la ayuda dice «CLI UI stays English» (`mnemosine.ts:2039`); `docs/cli-command-catalog.md:2050` y `src/cli/README.md:396` fijan el canónico inglés. El pedido dice español por omisión: la ayuda pasa a `es` salvo `MNEMOSINE_LANG=en`. Rompe el hábito de quien ya lo usa en inglés.
8. **¿El idioma se persiste por inquilino o usuario (`tenants.settings JSONB`, `001_core_schema.sql:23`; `users`, `:28`) o es sólo del proceso/petición?** Con persistencia hay migración; sin ella, la API sólo tiene `Accept-Language`.
9. **¿El codemod puede resellar el manifiesto tras un renombre cuyo único diff son los imports?** `corpus-manifiesto.ts:176-178`: «sellar sin releer no engaña al instrumento: engaña al agente». Recomendación: sí, con la condición del diff limitado a especificadores y un `--porque` obligatorio en el commit.
10. **¿ts-morph como devDependency?** Alternativa: `ts.LanguageService` sin dependencia nueva, con más código propio para mover archivos.
11. **¿Los nombres de archivo de `tests/golden/cfdi/` y sus claves JSON castellanas (`asiento caso nota …`)?** Contrato del eval (`scripts/eval-clasificador.ts`, `src/ai/eval/puntuacion.ts`). Recomendación: no.
12. **¿Qué queda como «neutro» por ser vocabulario del oficio mexicano?** `sat cfdi rep diot iva isr imss inpc uma rfc pac ppd clabe anexo24 poliza(?)`. `póliza`/`balanza` son palabras del despacho, no acrónimos; el léxico (I0) necesita la lista cerrada y firmada.

---

## 6. Riesgos

1. **El árbol compartido.** Todo se midió sobre `b31e62a` exportado; el árbol de trabajo tiene `criterios.ts` y `vitest.config.ts` modificados por otra sesión. Sembrar las líneas base sobre un árbol sucio las deja con holgura o con crecimiento falso desde el primer día (memoria «Árbol compartido»). Mitigación: `--sembrar` se niega si `git status --porcelain` no está vacío.
2. **Falsos positivos del léxico.** La verificación encontró 12 tokens ingleses en una lista castellana (7-16 % de inflación) y `meta` en la inglesa. Un lint con falsos positivos se apaga el primer día (`ux-status.ts:35-37`). Mitigación: I0 con su prueba de tokens prohibidos y muestra de 40; el metro imprime los tokens que decidieron cada caso.
3. **`MNEMOSINE_LANG` heredado del `.env`.** 48 spec corren el `program` sin limpiarla (`cli.md` §2.5): cuando la ayuda dependa del idioma, la suite depende de la máquina. Mitigación: `test.env` en `vitest.config.ts` (I4) antes de migrar la primera cadena.
4. **Los cuatro consumidores de los umbrales de cobertura.** `vitest.config.ts`, `vitest.integration.config.ts`, `SUELO_COBERTURA_*` (`criterios.ts:575-604`) y `s4a-ataque.int.spec.ts:346` deben moverse juntos; un codemod que olvide uno pone `--piso` en rojo. Mitigación: el codemod los trata como un solo sitio y `s4a` lo prueba.
5. **Mutantes anclados en texto castellano.** 10 mutantes a archivos renombrables y 3 a nombres de cuenta sembrados (`criterios.ts:1974,2021,2029`) + E1.1 (`:2058-2073`) parsea `code:/name:` en todo `src`. Un renombre o un `nameKey` sin reescribir mutantes = `ancla-rota` y `--piso` rojo. Mitigación: `mutantes` en las puertas de I8a y el codemod lista y para.
6. **Resellar el manifiesto sin releer.** 46 hashes; 7 servicios emisores de errores y `entry-command.ts` están hasheados (`verificacion/api.md` H4): migrar mensajes a `t()` caduca manuales. Cada PR de I6/I7 tendrá manuales que releer, y sellar mecánicamente es el ritual que `corpus-manifiesto.ts:100-103` prohíbe. Mitigación: la decisión §5.9 y que el PR nombre qué manual releyó.
7. **Prosa como contrato.** E0.0 hace regex de «hecha en F03» (`criterios.ts:820`); `s4a` busca por enunciado; `reconciliation-adjustments.spec.ts:107-118` lee un fuente crudo y falla si un comentario nombra `createJournalEntry`; 10 mutantes inyectan comentarios castellanos. Traducir prosa antes de I2 rompe instrumentos. Mitigación: I2 primero; I9 sólo tras §5.1.
8. **Aserciones de texto.** 3 637 aserciones con literal en `tests/` (`grep -rhoE "(toContain|toMatch|toThrow|toThrowError)\((['\"\`/])" tests --include='*.ts' | wc -l`; 766 con el patrón estrecho de `verificacion/api.md` C14). Con inglés como fuente y `en` en la suite, las que afirman inglés no cambian; las que afirman castellano (495 de ejecución + 305 de servicios, y `SPANISH_LEFTOVERS` de `bilingual-matrix.spec.ts:213-216`) sí. Mitigación: el tramo que migra la cadena migra su aserción; el metro por archivo hace visible el tamaño antes de abrir la issue.
9. **Big-bang por familia.** `mnemosine.ts` tiene 184 cadenas inglesas y 5 castellanas; `bank-command.ts` 5 616 líneas. Un PR que migra un archivo entero puede no caber en una revisión. Mitigación: el extractor por archivo y la línea base por archivo permiten PRs por sección; el criterio es el número, no «terminado».
10. **Docs ya rotas.** 92 de 422 rutas citadas en docs no existen y 145 de 259 rutas de tests citadas están rotas (`verificacion/pruebas-criterios-ci.md` §1). El codemod no las arregla y `verificar-renombre` sólo busca el nombre viejo: la deuda previa sigue. Mitigación: el metro publica `anclas-por-ruta.muertas` como informativa para que no se confunda con lo que el renombre rompió.
11. **Lo que este diseño no cubre y otras lentes deciden:** valores persistidos (`account_roles.role`, 36 valores sin CHECK; 14 CHECK castellanos; panel en filas por inquilino), `period_name` en dos formatos y en un `GROUP BY` de vista materializada, `ORDER BY` sobre texto con intercalación del contenedor, el Anexo 24 hasheado. El metro los cuenta como informativos para que su tamaño esté a la vista, nada más.

---

## 7. Apéndice — comandos con los que se contó lo propio

Todos en `$SCRATCH/arbol` = `git archive b31e62a | tar -x`.

```
find src -name '*.ts' | wc -l                                              → 375
perl datos/extract.pl $(find src -name '*.ts') | wc -l                     → 4627
COL=4 perl datos/clasificar.pl es_sorted.txt neutral_sorted.txt /usr/share/dict/words < decl.tsv | cut -f6 | sort | uniq -c
                                                                           → 2278 en · 2065 es · 209 mixto · 75 neutro
awk -F'\t' '$3=="export" && ($6=="es"||$6=="mixto")' decl_cls.tsv | wc -l  → 1296
grep -rhoE 'console\.(log|error|warn)\(' src/cli --include='*.ts' | wc -l  → 374
grep -rhoE 'new CliError\(' src/cli --include='*.ts' | wc -l               → 18
grep -rhoE '\b(usageError|notFound|validationFailed|blockedByState|conflict|permissionDenied|externalFailed|externalRejected|abortedByUser|needsHuman)\(' src/cli --include='*.ts' | wc -l → 349
grep -rhoE '\.description\(' src/cli --include='*.ts' | wc -l              → 309
grep -rhoE '\.option\(' src/cli --include='*.ts' | wc -l                   → 700
grep -rhoE 'addHelpText\(' src/cli --include='*.ts' | wc -l                → 185
grep -rhoE '\brender\(' src/cli --include='*.ts' | wc -l                   → 199
grep -rhoE "throw new [A-Za-z]+Error\(\s*[\`'\"]" src/services src/utils --include='*.ts' | wc -l → 305
grep -rhoE 'new AccountingError\(' src --include='*.ts' | wc -l            → 113
grep -rhoE "vi\.mock\(\s*['\"][^'\"]+['\"]" tests --include='*.ts' | sort -u | wc -l → 81
grep -rhoE "\bimport\(['\"]\." src --include='*.ts' | wc -l               → 30
grep -oE "['\"\`]src/[A-Za-z0-9_./-]+\.(ts|json|sql|md)['\"\`]" src/plan/criterios.ts | tr -d "'\"\`" | sort -u | wc -l → 134
grep -cE "^\s*'src/[^']+':\s*\{" vitest.config.ts / vitest.integration.config.ts → 6 / 9
node -e "const m=require('./src/ai/docs/manifiesto.json');console.log(Object.keys(m.hashes).length)" → 46
grep -rhoE 'src/[A-Za-z0-9_./-]+\.(ts|sql)' docs AGENTS.md CONTRIBUTING.md README.md CLAUDE.md | sort -u | wc -l → 422
grep -cE '^\s+paquete:' src/plan/criterios.ts                              → 135 (133 criterios + tipo + mapeo)
grep -rhoE "(toContain|toMatch|toThrow|toThrowError)\((['\"\`/])" tests --include='*.ts' | wc -l → 3637
python3 inventario/cuenta_comentarios.py src 1 /dev/null | tail -1        → TOTAL 375 150893 29125 22529 5506 …
find src -name '*.ts' | grep -E "/([a-z0-9-]*-)?(TOKENS)(-[a-z0-9-]*)?\.ts$" | wc -l → 52 (50 sin rep-*)
ls src/database/migrations | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -c | awk '$1>1' → 012×2 014×3 015×2 018×2
grep -rn "configureHelp\|configureOutput" src/cli --include='*.ts' | wc -l → 0
grep -rn "PluralRules\|NumberFormat\|DateTimeFormat" src --include='*.ts' | wc -l → 0
grep -rn "acceptsLanguages\|Accept-Language" src | wc -l                   → 0
grep -rn "MNEMOSINE_LANG" tests --include='*.ts'                           → 3 archivos (codigos-de-salida-hojas:63, status-command:74, system-prompt:147-161)
node -p "require('./node_modules/typescript/package.json').version"       → 5.9.3 ; eslint 9.39.5 ; typescript-eslint ^8.68.0 ; ts-morph: no instalado
```
