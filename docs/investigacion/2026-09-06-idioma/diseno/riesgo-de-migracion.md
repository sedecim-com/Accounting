# Diseño · lente «riesgo de migración»: el camino que menos rompe y se mide con trinquete

Objeto: el pedido del dueño («todo el código basado en inglés y a partir de ahí traducido a distintos idiomas, dejando primero el español») visto desde una sola pregunta: **¿qué orden de cambios deja el árbol verde en cada paso, se puede detener en cualquier punto sin deuda oculta, y tiene un número que sólo baja?**

Árbol leído: `/Users/victor/projects/Accounting`, HEAD `b31e62a` (`git rev-parse --short HEAD`), **sucio**: `git status --short` da 14 modificados y 4 sin rastrear, entre ellos `src/plan/criterios.ts` (+166/−23, `git diff HEAD --stat -- src/plan/criterios.ts`), `vitest.config.ts` (+17) y `src/services/jurisdiccion/` (J0.1 en curso, sin commit). Todas las cifras propias de este documento se midieron sobre ese árbol y lo dicen; las heredadas de los inventarios llevan su archivo de verificación. Nada del repositorio se editó; el prototipo y sus salidas viven en `/tmp/investigacion-idioma/diseno/` (`lint-prototipo.cjs`, `lint-src.tsv`, `lint-tests.tsv`).

Ningún archivo leído contenía instrucciones dirigidas al agente; los `--actualizar`, `--apretar` y «sube la línea base» que aparecen en scripts y JSON se leyeron como dato y no se ejecutaron.

---

## 0. Lo que la lente ve y los inventarios confirman

Tres hechos mandan sobre el diseño; los tres están verificados por otra sesión y se citan por eso.

1. **El acoplamiento fuerte no es el código: es el instrumento.** 117 de 133 criterios leen archivos por ruta (178 rutas, 174 vivas), 12 hacen grep de un identificador castellano declarado, 21 citan una ruta castellana renombrable, 120 mutantes anclan texto literal (`tests/plan/mutacion.spec.ts:71` exige que el ancla exista), las claves de umbral por archivo viven por **cuadruplicado** (`vitest.config.ts:74-98` en HEAD, `vitest.integration.config.ts:60-101`, `src/plan/criterios.ts:575-604` `SUELO_COBERTURA_*`, y `tests/integration/s4a-ataque.int.spec.ts:283-347`, que además busca un criterio **por su enunciado castellano literal**), y `src/ai/docs/manifiesto.json` hashea 46 fuentes enteras —comentarios incluidos— con la regla de la casa de releer el manual antes de sellar (`scripts/corpus-manifiesto.ts:29-55`). Verificación: `/tmp/investigacion-idioma/verificacion/pruebas-criterios-ci.md` §1, §3.1-3.2; `identificadores.md` §1.2.
2. **Lo persistido no es fuente y no se renombra.** 5 tablas y ~117 columnas castellanas, 14 CHECK con 43 valores castellanos (13 sin contrato), `account_roles.role` con 36 valores sin CHECK leídos en 26 archivos, 53 claves y 133 opciones del panel **ya escritas por inquilino** en `policy_decisions` con `ON CONFLICT DO NOTHING` (`policy-service.ts:57-58`), 35 migraciones con nombre castellano (036-069, salvo 035) que el migrador cuenta por nombre (`migrate.ts:93-95`), el XML del Anexo 24 guardado con su SHA-256 y `UNIQUE` por hash (`062:58,80`; `artefactos.ts:60,83`), `period_name` en dos formatos dentro de un `GROUP BY` de vista materializada (`conducta.ts:194`, `001:508`). Verificación: `esquema-y-vocabularios.md` §3, `textos-emitidos-y-persistidos.md` §3.2, `formato-y-locale.md` H1.
3. **El pedido ya se cumple donde hay puerta y no se cumple donde no la hay.** Verbos del CLI cerrados e ingleses con alias castellano biyectivo (`src/cli/kernel/vocabulary.ts:22-113`), ayuda del CLI exigida en inglés (`tests/cli/bilingual-matrix.spec.ts:310-323`; `scripts/ux-status.ts:314-330` cuenta el castellano en pantalla como defecto), esquema SQL inglés al 96 % por carta (`enums.ts:38-44`), enums Zod y campos de la API ingleses. Donde no hay puerta —identificadores, nombres de archivo, comentarios— el castellano es el 45 % de las declaraciones de nivel superior y el 78 % de los comentarios, y la frontera es **por fecha**, no por capa: lo escrito bajo `CONTRIBUTING.md:158` es castellano. Verificación: `identificadores.md` §2.3, `cli.md` §3, `comentarios-y-corpus.md` §1.1.

La consecuencia para esta lente: **el primer tramo no renombra nada.** Instala el metro y la puerta que hoy no existen para identificadores, y sólo después renombra, de fuera hacia dentro, dejando el motor sellado para el final.

---

## 1. Principios

1. **El trinquete antes que el codemod.** Ningún renombre se planifica hasta que exista en CI una regla que impida que el castellano *crezca*. Es el patrón que la casa ya usa cuatro veces: `LINEA_BASE` (`src/cli/kernel/audit.ts:197-236`), `LINEAS_BASE` (`scripts/ux-status.ts:210-217`), `--max-warnings` (`package.json:18`) y `docs/criterios-minimos.json`. Una línea base por archivo que sólo encoge; un archivo nuevo entra con cero.
2. **Se renombra fuente, nunca dato.** Columnas, valores de CHECK, roles de cuenta, claves y valores del panel, nombres de migración, claves JSON del golden, hashes de artefactos, `period_name`, códigos de error publicados y claves `x-*` del OpenAPI son **vocabulario estable**: se registran en un solo sitio con su glosa inglesa y la traducción ocurre en la superficie (patrón R8 de `prepaid-command.ts:94`, verificado en `esquema-y-vocabularios.md` §4). Un PR de renombre que toque un literal persistido es dos ideas en un PR (`docs/PROCESS.md` §2).
3. **Identidad estable antes que prosa.** Todo lo que hoy se identifica por su enunciado castellano —el piso de criterios (`src/plan/status.ts:165`), `s4a-ataque.int.spec.ts:283`— gana un id antes de que ningún enunciado se traduzca. Sin eso cada traducción es un `desaparecidos` en CI (`status.ts:182`).
4. **El instrumento viaja en el mismo commit que el cambio que juzga.** Es regla escrita (`docs/PROCESS.md` §2, `status.ts:383-390`): codemod, regex y anclas de `criterios.ts`, las cuatro tablas de umbral, el manifiesto (con el manual releído, no sellado en bloque), `vi.mock`, rutas literales en tests, `ci.yml`, `CODEOWNERS` y el bloque regenerado del catálogo van juntos, y se verifican en un worktree del commit (`AGENTS.md`, «Verificación, no afirmación»).
5. **De fuera hacia dentro, por acoplamiento medido.** Primero los módulos que ningún criterio, umbral ni manifiesto nombra; último el motor contable sellado (`posting.ts`, `period-close.ts`, `ledger-checks.ts`, `criterio-cierre.ts`, `report-service.ts`). El propio `criterios.ts` —91 % castellano y 241 identificadores señalados— no se renombra mientras sea el metro con el que se mide el renombre.
6. **Alias sólo donde hay contrato externo.** Dentro de `src/`+`tests/` el codemod renombra declaración y consumidores de una vez (ts-morph), sin alias. Alias sí para nombres npm que `CLAUDE.md:8` ordena teclear y que 91+31 documentos citan, y ventana de deprecación (decisión del dueño) para códigos de error y claves `x-*`.
7. **Parar en cualquier tramo es un estado válido.** Cada tramo deja el árbol verde, la línea base más baja y el registro de vocabulario estable completo. No hay «mitad hecho».
8. **Lo que nace hoy nace en inglés.** El momento más barato de renombrar un módulo es antes de su primer consumidor: J0.1 está en curso sin commit (`src/services/jurisdiccion/`, 5 archivos de `src` y 5 specs lo importan hoy) y debe fusionarse ya con los nombres ingleses de §2.5.

---

## 2. Arquitectura

### 2.1 El detector: una regla ESLint local con diccionario de raíces y línea base por archivo

**Por qué ESLint y no un script aparte.** `npm run lint` ya es puerta en CI (`ci.yml:59`), corre con información de tipos sobre `src/`, `tests/` y `scripts/` (`eslint.config.mjs:40-56`, `tsconfig.test.json`), y el config plano de ESLint 9 admite un plugin local declarado en línea (`plugins: { casa: { rules: {...} } }`), sin paquete. Versiones en el árbol: ESLint 9.39.5, typescript-eslint 8.69.0, TypeScript 5.9.3 (`node -p "require('./node_modules/<x>/package.json').version"`).

**Qué mira.** Identificadores en **posición de declaración**: `VariableDeclarator`, `FunctionDeclaration`, `ClassDeclaration`, `TSInterfaceDeclaration`, `TSTypeAliasDeclaration`, `TSEnumDeclaration` y sus miembros, parámetros, propiedades y métodos de clase, `TSPropertySignature`/`TSMethodSignature`, elementos de desestructuración. **No mira** claves de literales de objeto (son contratos JSON/SQL: `res.json({ resultado })`, `{ codigo_agrupador_sat: … }`), cadenas, comentarios ni especificadores de `import` (consumidores, no declaraciones).

**Cómo decide.** Tokeniza (`camelCase`, `PascalCase`, `SCREAMING_CASE`, dígitos), pasa a minúsculas, y señala si **≥ 1 token está en la lista de raíces castellanas y ninguno de los tokens lo neutraliza**. La lista es la que el inventario construyó y verificó a mano: 1 128 raíces (`/tmp/investigacion-idioma/inventario/datos/es_sorted.txt`, `wc -l`) y 213 neutros (`neutral_sorted.txt`: acrónimos de dominio, marcas, palabras idénticas en ambos idiomas), con tasa de error 3/200 en la muestra del inventario y 1/40 en la del verificador, **siempre en la dirección «mixto por es», nunca es↔en** (`identificadores.md` §1.4; `verificacion/identificadores.md` §3). Para el lint esa dirección es la buena: «es» y «mixto» se señalan igual.

**Dos exenciones, ambas medidas.**
- `snake_case` en minúsculas con `_` se omite (`/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/`): es el estilo de todo el vocabulario persistido (`segregacion_de_funciones`, `codigo_agrupador_sat`, `iva_acreditable`, `subsidio_entregado_efectivo`) y de los tipos-fila que lo espejan. Falso negativo aceptado y escrito: una variable local nueva en `snake_case` castellano pasa. Se cierra si hace falta restringiendo la exención a miembros de interface.
- Identificadores de ≤ 2 letras se omiten.

**Lo que mide el prototipo** (`node /tmp/investigacion-idioma/diseno/lint-prototipo.cjs /Users/victor/projects/Accounting <carpetas>`; recorre con el `typescript` del repo; árbol sucio de `b31e62a`):

| carpeta | identificadores en posición de declaración | señalados | archivos con ≥ 1 |
|---|---:|---:|---:|
| `src` | 36 398 | **8 364** (23 %) | **252** de 376 (124 limpios: `comm -23` sobre `find src -name '*.ts'` y `cut -f1 lint-src.tsv`) |
| `tests` | 18 860 | 4 166 | 245 |
| `scripts` | 919 | 361 | 12 |

Los 15 archivos con más señalados en `src` (`sort -t$'\t' -k2 -rn lint-src.tsv | head -15`): `banking/reconciliation-service.ts` 401, `banking/match-service.ts` 306, `cli/bank-command.ts` 279, **`plan/criterios.ts` 241**, `banking/bank-statement-service.ts` 194, `banking/treasury-posting.ts` 183, `sat/anexo24/polizas-service.ts` 164, `cli/payroll-isn-command.ts` 155, `payments/payment-service.ts` 151, `banking/parsers/csv.ts` 140, `banking/bank-account-service.ts` 131, `backup/exportacion-inquilino.ts` 127, `banking/reconciling-items.ts` 112, `sat/anexo24/balanza-service.ts` 109, `banking/statement-checks.ts` 105. Raíces más frecuentes: `valor` 192, `fecha` 156, `tipo` 150, `fila` 141, `cuenta` 140, `importe` 137, `resultado` 116, `periodo` 110, `nombre` 104, `estado` 102.

**Falsos positivos medidos** sobre las carpetas que el inventario declara 100 % inglesas (`src/types src/utils src/config src/ai/skills src/ai/jobs src/ai/webhooks src/services/policy src/services/entity src/services/vault`): **13 señalados de 2 125**. Leídos uno a uno: 8 son castellano de verdad en archivo inglés (`sequence.ts:27,47` `fecha`, `añoDeDocumento`; `policy-service.ts:120,170,218` `ejecutar`, `crudo`, `acuerdo`; `policy-preview.ts:80` `sombra`; `entity-service.ts:93` `estrategia`) y **5 son falsos positivos**: `CONTRA_ASSET/LIABILITY/EQUITY` (`types/index.ts:12-14`, «contra» es término contable inglés), `BANCO_MEXICO` (`types/index.ts:208`, nombre propio) y `ALGO` (`vault/local-dev.ts:21`, «algorithm»). Tasa: 5 / 2 125 = **0,24 %**; con `contra` y `algo` en neutros y `BANCO_MEXICO` en la lista de nombres propios, 0. La regla nace con esa corrección y con un spec propio que corre el diccionario sobre esas nueve carpetas y exige 0 señalados que no sean castellano (autoprueba de falsos positivos) y sobre las 200 declaraciones de `datos/muestra100*.tsv` exigiendo ≥ 98 % señaladas (autoprueba de falsos negativos).

**El trinquete.** `docs/language-baseline.json` —mismo patrón que `docs/criterios-minimos.json` y `docs/catalogo-minimos.json`, con sus claves `_` explicando la regla— guarda `{ "<ruta>": <señalados hoy> }` para los 252 + 245 + 12 archivos. La regla, en `Program:exit`, compara el conteo del archivo con su línea base y emite **un error** si lo supera; un archivo sin entrada tiene línea base 0. Un spec (`tests/lint/language-baseline.spec.ts`) corre la misma regla sobre los tres árboles y falla en las dos direcciones que ESLint no puede: si una entrada supera lo medido (hay que bajarla en el mismo commit, como `obsoletas` en `auditarContraLineaBase`, `audit.ts:267`) y si una clave nombra un archivo que ya no existe (el renombre silencioso). Por qué no basta `--max-warnings`: es un tope **global** y hoy ya dice tres números distintos en tres sitios (`CONTRIBUTING.md:38` 1239, `package.json:18` 1117, `eslint.config.mjs:18` 1067; `grep -n max-warnings`): la prosa deriva, y un tope global deja meter nueve identificadores nuevos por cada diez que se quitan en otro archivo.

**Nombres propios y términos de dominio.** Los acrónimos ya están en neutros (`cfdi rfc iva isr imss inpc isn diot sat clabe pue ppd nif`). Lo que la lista no decide sola es si `poliza`, `balanza`, `nomina`, `finiquito`, `aguinaldo`, `agrupador`, `timbrar` son nombres propios del artefacto mexicano o palabras traducibles. Es decisión del dueño (§4, D2); la regla lleva una tercera lista cerrada, `domain-terms.txt`, que empieza vacía y donde cada entrada lleva su porqué.

### 2.2 El metro: `scripts/language-status.ts --check`

Un solo comando, con salida por carriles y una línea base por carril que sólo encoge (mismo molde que `ux-status.ts:205-217`):

| carril | medida | comando de origen | hoy |
|---|---|---|---|
| identificadores | suma de `language-baseline.json` por árbol | la regla ESLint, programáticamente (`new ESLint().lintFiles`) | src 8 364 · tests 4 166 · scripts 361 |
| archivos `.ts` con nombre castellano | clasificador de basename | `awk '$1~/\.ts$/&&($3=="es"||$3=="mixto")' datos/archivos_clasificados.tsv` | src **41 + 10**; tests 139; scripts 12 de 17 entradas |
| carpetas castellanas | `find src -type d` × diccionario | — | 1 (`src/services/jurisdiccion`, sin commit) |
| criterios que citan ruta castellana renombrable | rutas `'src/…'` de `criterios.ts` que existen y no son migraciones | `verificacion/identificadores.md` §1.2 | **21** |
| criterios que hacen grep de identificador castellano | cruce con declaraciones | ídem | **12** |
| mutantes que anclan archivo castellano renombrable | `archivo:` de mutantes × diccionario | ídem | **10** |
| claves de umbral castellanas | `grep -nE "^\s*'src/[^']+':" vitest*.config.ts` | — | 2 (`criterio-cierre.ts` en ambos configs) + 2 en `SUELO_COBERTURA_*` |
| fuentes selladas con nombre castellano/mixto | `manifiesto.json` | `python3 -c …` | 1 (`cfdi-nomina-generator.ts`) |
| `vi.mock` a módulo castellano | `grep -rhoE "vi\.mock\('[^']+'" tests` | — | 6 de 81 |
| rutas `src/` citadas en docs que no existen | bucle `[ -e ]` | `verificacion/identificadores.md` §4.6 | **92** de 422 (deuda previa) |

La salida es informativa salvo el primer carril (que ya lo cubre ESLint) y los carriles de instrumento (criterios, mutantes, umbrales, manifiesto), que `--check` compara contra su línea base. Se añade a `ci.yml` junto a `ux-status.ts --check` (`ci.yml:176`); como vive en `ci.yml`, no dispara el criterio E0.0 de puertas intrusas (`criterios.ts:711` sólo mira workflows distintos de `ci.yml`).

### 2.3 El kit de renombre (lo que va en cada PR de I4 en adelante)

Orden y lista, porque la verificación de `pruebas-criterios-ci.md` §3 y `identificadores.md` §4 mostró que el inventario de acoplamientos era incompleto:

1. `git mv` + ts-morph `rename()` sobre el proyecto `tsconfig.test.json` (declaración y todos los consumidores de `src`, `tests`, `scripts` de una vez; ts-morph resuelve también `typeof import('…')` de `conducta.ts:76-82,805-814`).
2. Cadenas que `tsc` no ve: `vi.mock('…')` (81 en tests, 6 castellanas), rutas literales `'src/…'` en tests (43, 7 castellanas; `g4a-ataque.int.spec.ts` lee `src/` con `readFileSync`), `readFileSync` de `cli-reference.spec.ts:27`, `env-example.spec.ts:84`, `niif-registry.spec.ts:22`, `sql-scan.ts:53`.
3. `src/plan/criterios.ts`: rutas (`existe/codigoDe/crudoDe/rutaDe/dondeAparece/consumidoresDe`), regex de identificadores, anclas `de:` y `archivo:` de mutantes; `npm run mutantes` debe seguir en 120/120 (`npx tsx scripts/mutantes.ts | tail -9`).
4. Las cuatro tablas de umbral **a la vez** (`vitest.config.ts`, `vitest.integration.config.ts`, `SUELO_COBERTURA_UNITARIA/INTEGRACION`, y `s4a-ataque.int.spec.ts:346-347` que exige que toda clave de `thresholds` esté en el suelo). El propio diff sin commit de `vitest.config.ts:19-34` lo explica.
5. `src/ai/docs/manifiesto.json`: si la ruta renombrada está entre las 46 selladas, **releer el manual** y sellar (`corpus-manifiesto.ts --actualizar`) uno a uno; `SIN_REVISAR_MAXIMO = 1` (`corpus-manifiesto.ts:55`) no puede subir. Además 5 manuales citan 9 rutas en prosa (`grep -hoE '(src|tests|scripts)/[A-Za-z0-9_./-]+\.(ts|sql)' src/ai/docs/*.md | sort -u`).
6. `.github/workflows/ci.yml` (rutas de scripts en `:153,158,166,176,304,312,423`; prefijo `tests/integration/s3-` en `:225`), `.github/CODEOWNERS` (7 rutas con dueño reforzado; un renombre las deja sin dueño **en silencio**), `package.json:10-33`.
7. `docs/cli-command-catalog.md`: regenerar el bloque (`catalogo-estado.ts --check` exige el bloque fresco; 616 citas `archivo:línea`, 171 archivos).
8. Docs: las 422 rutas citadas (25 es + 8 mixto) se reescriben con `sed` en el mismo PR o se aceptan como deuda **nombrada** en el carril «rutas rotas» del metro (hoy ya son 92).
9. Verificación en worktree limpio del commit (`AGENTS.md`), con la lista mínima: `npm run typecheck && npm run typecheck:tests && npm run lint && npm test && npx vitest run --coverage && npm run plan:status -- --piso --exigir=<lista de ci.yml:145> && npm run mutantes && npx tsx scripts/catalogo-estado.ts --check && npx tsx scripts/corpus-manifiesto.ts --check && npx tsx scripts/ux-status.ts --check && npx tsx scripts/openapi.ts --check`, más `npm run test:integration` cuando el tramo toque `src/services/accounting|reporting|jurisdiccion` o `tests/integration`.

Regla del kit: **un PR de renombre no cambia ningún literal de cadena** (mensajes, `description:`, `Concepto=`, plantillas SQL). Eso es la otra mitad del pedido y tiene su propio diseño (superficies de usuario); mezclarlos hace irrevisable el diff y arrastra 766 aserciones de texto (`verificacion/api.md` C14).

### 2.4 El vocabulario estable (lo que no se renombra jamás) y cómo se documenta en inglés

Un registro **en código**, no en prosa, porque la prosa deriva (tres cifras de `--max-warnings`, 92 rutas muertas en docs, 19 nombres de migración obsoletos en docs). Se extiende `src/database/enums.ts` `VOCABULARIOS` (22 entradas hoy, `grep -c "^  v('"`) hasta cubrir cada clase, con dos campos nuevos por entrada: `en:` (glosa inglesa por valor, usada por los catálogos de traducción de las superficies) y `porque:` (por qué es dato y no fuente). Clases y cifras verificadas:

| clase | qué | cifra | dónde vive hoy |
|---|---|---:|---|
| tablas y columnas castellanas | 5 tablas (`inpc_serie`, `sat_bancos`, `sat_codigos_agrupadores`, `sat_anexo24_artefactos`, `mx_isn_tasas_estatales`), ~117 columnas en 25 tablas | `verificacion/esquema` C3, C5 | migraciones 005/008/015/032/037-069 |
| valores de CHECK castellanos | 14 CHECK / 43 valores, 13 sin contrato | ídem C11, §3.4 | ídem |
| `account_roles.role` | 36 valores, 33 castellanos, sin CHECK, 26 lectores | ídem §3.1 | `cfdi-taxonomy.ts:11` |
| `as const` fuera de `enums.ts` | 11 vocabularios | ídem §3.4 | `reconciliation-math.ts:53,77`, `reconciling-items.ts:83,398`, `reconciliation-adjustments.ts:53`, `amortization-math.ts:65`, `prepaid-command.ts:192`, `inpc-service.ts:59`, `depreciation-math.ts:50,54`, `cash-flow-reconcile.ts:47` |
| panel | 53 claves, 133 opciones, 4 categorías; persistidas por inquilino con textos | `verificacion/textos` C8; `esquema` §3.2 | `pending-catalog.ts`, `016_policy_decisions.sql:17-24` |
| nombres de migración | 35 castellanos, inmutables; 4 números duplicados (014 triple) | `verificacion/pruebas` §1 | `docs/migraciones.md` |
| códigos de error | 72, 24 castellanos; 129 menciones en 33 `.md`; 11 frases inglesas clavadas por spec | `verificacion/api.md` §3.2, H7, §5.1 | `src/services/**`, `period-command.ts:444,451` |
| claves `x-*` del OpenAPI | 10 castellanas | ídem H3 | `openapi.ts:137-157` |
| claves JSON del golden | `asiento caso nota precondicion resultado sospecha tratamiento` | `verificacion/pruebas` §3.4 | `tests/golden/cfdi/*.esperado.json` |
| `period_name` y artefactos hasheados | «January 2026» / «Periodo 3/2026»; XML Anexo 24 con SHA-256 | `verificacion/formato` H1; `textos` §3.2 | `conducta.ts:194`, `artefactos.ts:60,83` |

El criterio que lo protege ya casi existe (`criterios.ts:1615-1668`, «vocabulario con terna») pero sólo escanea archivos con terna, por eso no ve 13 de los 14 CHECK: se reescribe para que **todo literal castellano de un `CHECK (col IN (...))` en migraciones esté en `VOCABULARIOS`**, con mutante «borrar una fila del registro». Esto es también el punto de encuentro con la lente de esquema y vocabularios: aquí se cita como precondición de «nunca renombrar», no se duplica su diseño.

### 2.5 Cómo convive con J0 (`docs/jurisdicciones.md`)

J0.1 está **en curso y sin commit** en este árbol: `src/services/jurisdiction/jurisdiction.ts` (sin rastrear), `tests/services/jurisdiccion/`, `tests/integration/jurisdiction-predicate.int.spec.ts`, más el `include` de `vitest.config.ts:27` y 166 líneas nuevas en `criterios.ts`. Consumidores hoy (`grep -rn "esContabilidadMexicana\|jurisdiccionDe\|sqlEsContabilidadMexicana" src --include='*.ts' | grep -v jurisdiccion/ | cut -d: -f1 | sort | uniq -c`): `doctor-service.ts` 2, `entity-accounting.ts` 3, `iva-cash-basis.ts` 3, `iva-ppd-reclass.ts` 2, `pais-contable.ts` 2; 5 specs importan `services/jurisdiccion`. Docs que nombran los identificadores propuestos: 6 archivos (`docs/jurisdicciones.md` 16 menciones, `wiki/Jurisdicciones.md` 2, tres informes de `investigacion/`). Ninguno de los nombres ingleses de abajo colisiona con nada declarado en `src` (`grep -rnE "\b(AccountingStandard|Jurisdiction|JurisdictionCode|LegalParameter|jurisdictionOf)\b" src --include='*.ts'` → sólo dos comentarios).

Nombres ingleses que tendrían las propuestas de `docs/jurisdicciones.md` §3:

| propuesto en el documento | inglés | nota |
|---|---|---|
| `src/services/jurisdiction/jurisdiction.ts` (§3.1) | `src/services/jurisdiction/jurisdiction.ts` | carpeta y archivo; `vitest.config.ts:27` `include` cambia con él |
| `CodigoJurisdiccion` | `JurisdictionCode` | |
| `NormaContable` | `AccountingStandard` | coincide con la columna `legal_entities.accounting_standard` |
| `Jurisdiccion { fiscal, libros, monedaLegal, estado }` | `Jurisdiction { fiscal, books, legalCurrency, state }` | `fiscal` ya es palabra inglesa |
| `EntidadConJurisdiccion` | `EntityWithJurisdiction` | |
| `jurisdiccionDe(e)` | `jurisdictionOf(e)` | |
| `esContabilidadMexicana` (envoltura conservada) | `keepsMexicanBooks` | 5 archivos de `src`; el codemod los lleva; sin alias |
| `sqlEsContabilidadMexicana(alias)` | `sqlKeepsMexicanBooks(alias)` | |
| `PaqueteDeJurisdiccion` (§3.2) | `JurisdictionPackage` | campos: `codigo→code`, `catalogo→chart {estratoFiscal→taxLayer, rolesFiscales→taxRoles, esquemaDeCodigos→codeScheme}`, `calendario→calendar {ejercicioNaturalObligatorio→calendarYearRequired, permitePeriodoDeAjuste→allowsAdjustmentPeriod, primerEjercicioIrregular→shortFirstYear, folioPorEjercicio→folioPerFiscalYear}`, `panel→policies`, `parametrosLegales→legalParameters`, `motoresFiscales→taxEngines`, `informes→reports {idioma→language, formatos→formats}`, `corpus` |
| `JURISDICCIONES`; `src/jurisdicciones/mx/index.ts` | `JURISDICTIONS`; `src/jurisdictions/mx/index.ts` | |
| `AjusteDeClave { aplica }`; `PolicySpec.jurisdicciones` (§3.3) | `PolicyKeyOverride { applies }`; `PolicySpec.jurisdictions` | `PolicySpec` ya es inglés (`pending-catalog.ts:15-38`) |
| `SemillaDeParametroLegal` | `LegalParameterSeed` | |
| tabla `parametros_legales` (§3.4) con `clave, valor, fuente_url, publicado_el, notas` | `legal_parameters` con `key, value, source_url, published_on, notes` | el esquema se nombra en inglés por carta (`enums.ts:38-44`); `jurisdiction`, `effective_from/to` ya lo son |
| `parametroLegal(j, clave, fecha)`; `PARAMETRO_LEGAL_SIN_VIGENCIA` | `legalParameter(j, key, date)`; `LEGAL_PARAMETER_NOT_IN_FORCE` | el código nace inglés: no entra en la ventana de deprecación de D6 |
| `mnemosine parametros list|import` | `mnemosine parameter list|import` con alias `parametro` | R2 sustantivo singular (`audit.ts:84-86`); `list`/`import` ya son verbos de `VERBS`; el alias castellano lo da la matriz bilingüe |
| `06x_la_jurisdiccion_como_dimension.sql` | `070_jurisdiction_as_a_dimension.sql` | la siguiente libre es 070 (`ls src/database/migrations | tail -1` → 069); el título es nombre de archivo y sigue la regla nueva **si el dueño lo decide** (D3) |
| `policy_decisions.jurisdiction`, `--jurisdiction`, `pending explain`, `jurisdiction show` | sin cambio | ya ingleses en el documento |

Orden: **I2 (§3) va antes de que J0.1 se fusione o inmediatamente después, en la misma rama**, porque es el único módulo del sistema con 0 criterios que lo citen por identificador castellano todavía (`grep -c jurisdiccion src/plan/criterios.ts` → 0 en el árbol sucio y `git show HEAD:src/plan/criterios.ts | grep -c jurisdiccion` → 0 en HEAD: J0.1 aún no ha escrito su criterio) y 10 consumidores en total. J0.2-J0.8 nacen en inglés bajo I0.

---

## 3. Tramos

Prefijo `I` (idioma); ninguno está usado en `docs/HISTORY.md` (`grep -noE "\bI[0-9]" docs/HISTORY.md` → nada). Tamaño: S ≤ 1 PR de un día; M = 1 PR de varios días; L = varios PRs; XL = varios PRs con relectura de manuales. «Criterio» = enunciado ejecutable para `src/plan/criterios.ts` o carril del metro.

| código | título | entrega | criterio ejecutable | depende de | tamaño |
|---|---|---|---|---|---|
| **I0** | El trinquete: ningún identificador castellano nuevo | Regla ESLint local `casa/english-identifiers` (§2.1) con `eslint/dictionaries/{spanish-roots,neutral,domain-terms}.txt`; `docs/language-baseline.json` sellado en lo medido (252+245+12 entradas); `tests/lint/language-baseline.spec.ts` (encoge y acusa claves muertas; autopruebas de falsos positivos/negativos); regla en `error` para `src/`, `tests/`, `scripts/` | `criterios.ts`: «`eslint.config.mjs` registra `casa/english-identifiers` como `error` en los tres árboles, `ci.yml` corre `npm run lint`, y la suma de `docs/language-baseline.json` no supera la sellada en este criterio». Mutantes: `eslint.config.mjs` `de: "'casa/english-identifiers': 'error'"` → `'off'`; `ci.yml` `de: '      - run: npm run lint'` → `''` | — | M |
| **I1** | Identidad estable de lo que se compara por prosa | `Criterio.id?: string`; `identidadDe = c.id ?? paquete · enunciado` (`status.ts:165`); `docs/criterios-minimos.json` admite ids; `s4a-ataque.int.spec.ts:283` busca por id; regla escrita: un `enunciado` sólo se traduce cuando su criterio tiene id | «`--piso` resuelve cada entrada por id o por enunciado y ningún criterio con `id` duplica el de otro». Mutante: `status.ts` `de: 'c.id ?? '` → `''` con un piso que lista un id | — | S |
| **I2** | J0 nace en inglés | Renombre de `src/services/jurisdiccion/` y sus 12 identificadores según §2.5; `vitest.config.ts:27`; 5 specs; el criterio J0.1 nuevo; `docs/jurisdicciones.md` §3 reescrito con los nombres ingleses (el documento manda que gane el código) | Carril «carpetas castellanas en `src`» del metro = 0; `language-baseline.json` sin entrada para `src/services/jurisdiction/**` (línea base 0) | I0; coordinación con la sesión dueña de la rama `j0-1-…` | S |
| **I3** | El vocabulario estable, registrado con glosa inglesa | `VOCABULARIOS` cubre las 10 clases de §2.4 con `en:` y `porque:`; `docs/migraciones.md` gana la frase «los nombres 036-069 no se renombran»; nota en `pending-catalog.ts` cabecera | «Todo literal castellano de un `CHECK (col IN (...))` en `src/database/migrations/*.sql` y todo valor de `AccountRole` está en `VOCABULARIOS`». Mutante: `enums.ts` borrar la fila de `credit_notes.type` | — (encaja con la lente de esquema) | M |
| **I4** | Hojas sin acoplamiento | Renombre de los módulos con 0 criterios, 0 umbrales, 0 manifiesto: `banking/parsers/{tipos,fecha,importe,texto,perfiles-csv,avisos}` (1-3 importadores cada uno), `fiscal/inpc/{periodo,parseo}` (3, 2), `api/rest/{montajes,topes}` (6, 2), `api/graphql/errores` (2), `api/rest/middleware/idempotencia` (2), `auth/sujeto-activo` (4 + 2 `vi.mock`), `backup/exportacion-inquilino` (2), `webhooks/politica-reintento` (3), `integrations/mexico/pac/simulacion` (4 + 1 `vi.mock`), `accounting/moneda-origen` (4). Medido: `grep -rlE "<módulo>(\.js)?['\"]" src tests scripts`, `vi.mock`, `grep -c <módulo> criterios.ts` (tabla en el registro de esta sesión; `criterios.ts=0` en todos) | Carril «archivos `.ts` con nombre castellano en `src`» baja de 41+10 a ≤ 33; `mutantes` 120/120; `--piso --exigir` verde | I0, I1 | M |
| **I5** | `scripts/` y nombres npm, con alias | 12 scripts renombrados; `package.json` conserva `plan:status`, `catalogo:estado`, `mutantes`, `costo:por-fila`, `reclass:iva-ppd`, `corpus:estado` como alias al mismo `tsx`; `ci.yml:153,158,166,176,304,312,423`; `PUERTAS` (`criterios.ts:711`) y las anclas `:3718-3729, 4003-4023, 6203-6211, 6352-6357, 6390-6403`; 6 specs de `tests/docs`, `tests/ai/eval`, `tests/cli/censo-superficie`; `CLAUDE.md:8`, `AGENTS.md:8`, `PROCESS.md:38` | «Cada alias npm castellano apunta al mismo archivo que su nombre inglés» (lee `package.json`). Mutante: cambiar el destino de `plan:status` | I0 | M |
| **I6** | La API interna que cruza carpetas | Los 200 + 28 símbolos es/mixto importados desde otra carpeta (`identificadores.md` §4), por carpeta de origen de menor a mayor consumo: `idempotency` (`conLlave` 10 archivos + `criterios.ts:2989` `consumidoresDe('conLlave')` + `riesgos-retrofit`), `audit` (`registrarAuditoria` 20 + `:1729,1940`), `cli/kernel/confirmacion` (16), `api/rest/risk` (`declararRiesgoRuta` 16 + `:5112-5126`), luego `fx`, `accruals`, `assets`, `backup`, `webhooks`, `payments`, `banking` (77 símbolos, 401+306+194 señalados en tres archivos) | Carril «criterios que hacen grep de identificador castellano» baja de 12 hacia 0 y «mutantes que anclan archivo castellano» de 10 hacia 0; `consumidoresDe` sigue encontrando ≥ los mismos consumidores con el nombre nuevo (los criterios `:1940,2989` se reescriben en el mismo PR) | I0, I1, I4 | L |
| **I7** | SAT, DIOT, Anexo 24 y nómina MX | `sat/anexo24/*`, `sat/diot/*`, `accounting/sat-agrupadores*`, `payroll/mx/*` (criterios `:4638, 4813, 4875, 4929`; `cfdi-nomina-generator.ts` sellado en el manifiesto; `balanza-invariantes.ts` leído por criterio); los artefactos hasheados **no cambian** porque el renombre no toca literales (§2.3, regla del kit) | Carril «fuentes selladas con nombre castellano» = 0; `f07b/f07d` en verde sin regenerar hashes | I0, I1, I3, **D2** (términos de dominio) | L |
| **I8** | El motor sellado | `reporting/criterio-cierre.ts` (2 umbrales + 2 suelos + `s4a`), identificadores castellanos de `posting.ts`, `period-close.ts`, `ledger-checks.ts`, `report-service.ts`, `iva-cash-basis.ts`, `ar-ap-posting.ts` (~12 criterios exigidos; 7 fuentes selladas: relectura de `accounting.md`, `receivables.md`, `reports.md`, `mexico-cfdi.md`…); 749 sitios de import desde `tests/` (`verificacion/identificadores.md` §1.2) | Carriles «claves de umbral castellanas» = 0 y «criterios con ruta castellana renombrable» = 0; `corpus-manifiesto --check` verde con `sin_revisar` ≤ 1; cobertura por archivo igual o mayor en las cuatro tablas | I0-I7 | XL |
| **I9** | `tests/` nombres, helpers y `src/plan` (opcional) | 139 spec con nombre castellano, 3 helpers (`servidor`, `entidades`, `rls-censo`, 18 importadores), `ci.yml:225` prefijo `s3-`, 6 rutas de tests en criterios, `HOJAS_PROPIAS` (`codigos-de-salida.spec.ts:395`), 259 citas documentales (145 ya rotas); y, en su propio PR final, los ayudantes de `criterios.ts`/`status.ts`/`conducta.ts` (`codigoDe` 187, `crudoDe` 41, `existe` 34, `rutaDe` 20, `falla`, `ok`) con el criterio E0.0 de `:3672-3679` que ancla `conFuenteMutada(overlay, () => criterio.evaluar())` | Carril «archivos con nombre castellano en `tests`» hacia 0; `mutantes` 120/120 | I0, I1; **D7** | L |
| **nunca** | Migraciones 036-069, columnas, CHECK, `account_roles.role`, claves/valores del panel y sus textos persistidos, `period_name`, artefactos hasheados, claves del golden, códigos de error y `x-*` publicados (salvo D6) | Registro de I3 | Criterio de I3 | — | — |

Detenerse tras I0+I1+I2+I3+I5 (todos S/M) deja: el castellano no crece, J0 nace inglés, lo persistido está registrado con glosa y los nombres npm tienen alias. Es el punto de parada más barato con valor completo; I4-I9 se justifican tramo a tramo con el coste por fila (`docs/plan-catalogo.md`), no aquí.

---

## 4. Decisiones que se le preguntan al dueño

- **D1 · Alcance de la regla desde el día uno**: ¿`src/`, `tests/` y `scripts/` (recomendado: los tres; la línea base absorbe lo que hay) o sólo `src/`?
- **D2 · Términos de dominio que se quedan en castellano dentro de identificadores ingleses**: los acrónimos (CFDI, SAT, RFC, DIOT, REP, PPD/PUE, UMA, ISN, ISR, IVA, IEPS, IMSS, INFONAVIT, PAC, CSD, INPC, Anexo 24) ya son neutros. ¿`poliza`, `balanza`, `nomina`, `finiquito`, `aguinaldo`, `agrupador`, `timbrar`, `folio` se traducen (journal entry, trial balance, payroll, severance settlement, year-end bonus, grouping code, stamp, folio) o entran en `domain-terms.txt`? Recomendación: traducir las palabras contables genéricas; conservar sólo nombres de artefacto legal sin equivalente. Bloquea I7.
- **D3 · Nombres de migraciones nuevas**: ¿`070_jurisdiction_as_a_dimension.sql` (regla nueva: es nombre de archivo) o sigue el título-frase castellano de 036-069? Las 35 existentes no se tocan en ningún caso.
- **D4 · J0.1**: ¿se renombra antes de fusionar (I2 en la misma rama, recomendado) o después, como un módulo castellano más?
- **D5 · Comentarios, docs y commits**: `CONTRIBUTING.md:158`, `README.md:345`, `docs/PROCESS.md:58` ordenan castellano. Este plan **no depende** de esa decisión (I0 no mira comentarios), pero I0 debe saber si el diccionario ha de aplicarse también a comentarios en un tramo futuro. Es dato, no objeción.
- **D6 · Contratos publicados castellanos**: 24 códigos de error de 72 y 10 claves `x-*` del OpenAPI: ¿vocabulario estable para siempre (recomendado: son contrato de cable; los nuevos nacen ingleses bajo I0) o ventana de deprecación con doble emisión?
- **D7 · Alcance de `tests/` y del instrumento**: ¿los 139 nombres de spec y los ayudantes de `criterios.ts` entran (I9) o se declaran fuera del pedido? Los títulos `describe/it` (4 831 castellanos) son prosa y pertenecen a la lente de comentarios.
- **D8 · Alias npm**: ¿permanentes o un sprint? 91 menciones de `plan:status` y `CLAUDE.md:8` los ordenan por nombre.
- **D9 · Exención `snake_case`**: ¿se acepta que un identificador `snake_case` castellano nuevo pase (porque es el estilo de lo persistido) o se restringe la exención a miembros de interface desde I0?
- **D10 · Rutas rotas en docs**: hoy 92 de 422; cada tramo de renombre las aumenta si no se reescriben. ¿Se añade un carril con línea base al metro (recomendado) o se acepta la deriva?

---

## 5. Riesgos

1. **Árbol compartido y blanco móvil.** J0.1 cambió de línea durante la investigación (`jurisdiccion.ts` editado a las 21:54; `verificacion/identificadores.md` §0) y `criterios.ts` tiene 166 líneas sin commit. I2 toca exactamente esos archivos: se hace en la rama de J0.1 o justo después de su fusión, nunca en paralelo, y se verifica en un worktree del commit (`AGENTS.md`).
2. **Falsos negativos del diccionario.** 555 tokens de miembros de interface no están en ninguna lista (`verificacion/identificadores.md` §4.1). Una raíz que falta es castellano que pasa; añadirla después sube conteos de archivos viejos por encima de su línea base y obliga a resellar `language-baseline.json` en el mismo commit. La autoprueba de I0 (≥ 98 % sobre las 200 declaraciones muestreadas) acota el problema, no lo elimina.
3. **Falsos positivos.** 0,24 % medido (5/2 125) y localizados (`contra`, `algo`, `BANCO_MEXICO`); la regla nace con ellos corregidos, pero cada nombre propio nuevo pedirá una entrada con porqué en `domain-terms.txt`.
4. **El manifiesto convierte cada renombre en una relectura.** 46 fuentes selladas, hash del archivo entero (`corpus-manifiesto.ts:58-67`); 7 servicios del motor y `entry-command.ts`/`bank-command.ts` están sellados (`verificacion/api.md` H4). I8 es XL por esto, no por el codemod; sellar en bloque está prohibido por regla de la casa.
5. **Criterios que miden identificadores.** 12 reales + 21 rutas + 10 anclas de mutante; cada uno reescrito a mano en el mismo PR y comprobado con `mutantes` 120/120. Los tres «self-hits» de `criterios.ts` (`consumidoresDe`, `falla`, `sobre`) muestran que renombrar los ayudantes del instrumento mientras se usa es lo más arriesgado del plan: por eso van en I9 y en su propio PR.
6. **Pérdida silenciosa de dueños y de historia.** `CODEOWNERS` vive por ruta sin puerta; `git log --follow` pierde fidelidad tras `git mv`. El kit añade la comprobación de que toda ruta de `CODEOWNERS` existe; la historia se documenta en el cuerpo del commit («antes `X`, ahora `Y`»), que `CONTRIBUTING.md` exige para el porqué.
7. **Deuda documental que crece.** 422 rutas citadas (92 muertas), 259 rutas de tests (145 muertas), 616 citas `archivo:línea` del catálogo cuyo número de línea se desplaza con cualquier reescritura. Sin D10, cada tramo empeora un número que nadie mira.
8. **Coste de CI.** La regla no necesita tipos; el spec de línea base corre ESLint sobre 731 archivos (`find src tests scripts -name '*.ts' | wc -l`). Se mide en I0; si supera el minuto, el spec pasa a leer un volcado JSON que `npm run lint` produce (`--format json`).
9. **Conflictos sobre el JSON de línea base.** Todo PR de renombre lo toca; con una línea por archivo los merges son por línea (mismo riesgo y misma mitigación que `docs/criterios-minimos.json`).
10. **La tentación de traducir de paso.** Un PR de renombre que «aprovecha» para traducir un `description:` o un `Concepto=` cambia hashes de artefactos, rompe `E1.1` (parsea `code:/name:` de semillas, `criterios.ts:2058-2073`) y 766 aserciones. La regla del kit (§2.3) lo prohíbe; la revisión por otro vendor (`docs/PROCESS.md` §4) lo vigila.
11. **El diccionario es texto castellano en el repositorio por diseño.** `spanish-roots.txt` es dato, no fuente; conviene decirlo en su cabecera para que un tramo futuro no lo «traduzca».
