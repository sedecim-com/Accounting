# Verificación (escéptico) · superficie «pruebas-criterios-ci»

Informe verificado: `/tmp/investigacion-idioma/inventario/pruebas-criterios-ci.md`.
Árbol: `/Users/victor/projects/Accounting` en `b31e62a`, sucio (11 entradas en `git status --short`), el
MISMO que midió el inventario. Diferencia: el inventario omite en su lista de no rastreados
`tests/integration/jurisdiction-predicate.int.spec.ts` (mtime 21:20, anterior al informe de 21:33); sus
conteos sí lo incluyen (88 `.int.spec.ts` sólo cuadran con él).
Nada del repositorio se editó; sólo modos de lectura (`plan:status` sin banderas, `mutantes` en memoria,
`corpus-manifiesto.ts --check`). Salidas crudas en `/tmp/investigacion-idioma/verificacion/pcc-work/`.

Criterio: ante la duda, refuto. «Confirmado» = volví a correr el comando (o uno mejor) y la cifra sale.

---

## 1. Conteos: comando, cifra del informe, cifra mía, veredicto

| Qué | Informe | Comando mío | Mío | Veredicto |
|---|---|---|---|---|
| Archivos `.ts` en `tests/` | 343 | `find tests -type f -name '*.ts' \| wc -l` | 343 | Confirmado |
| Spec / int / unit / ayudantes | 336 / 88 / 248 / 7 | `find tests -name '*.spec.ts' \| wc -l`; `find tests/integration -name '*.int.spec.ts' \| wc -l`; `find tests -name '*.spec.ts' ! -name '*.int.spec.ts' \| wc -l`; `find tests -name '*.ts' ! -name '*.spec.ts'` | 336 / 88 / 248 / 7 | Confirmado |
| `describe(` crudo | 1535 | `grep -rhoE '\bdescribe(\.(skip\|only\|each\|todo))?\s*\(' tests --include='*.ts' \| wc -l` | 1535 | Confirmado |
| Títulos 4 831 es / 1 999 en / 44 / 517; archivos 232 es / 104 en / 7 | — | `node inventario/metodo/clasificar-tests.js …` → `diff` contra `metodo/tests-salida.txt` | **IGUAL** byte a byte | Confirmado (reproducible). Reserva: el conjunto ES del guion (l.9-11) incluye `plan panel error errores alias rol roles memoria`; puntúa por mayoría, así que un título inglés con «plan» no se vuelca. No encontré archivo que cambie de idioma por esos tokens. |
| Spec con nombre castellano | 139 | mismo guion + guion propio que busca los marcados SÓLO por tokens débiles (`a en no de lo que con una sola solo dos…` que están en `ES_FICHERO`, l.39) | 139; **0** marcados sólo por tokens débiles | Confirmado |
| Tests que importan módulos castellanos / módulos | 82 / 46 | mismo guion (salida idéntica) | 82 / 46 | Confirmado con su método; no lo reclasifiqué a mano |
| Tests que leen fuente por ruta | 50 | `grep -rln "readFileSync\|rutaDe(\|path.join(.*'src\|'src/\|\"src/" tests --include='*.ts' \| wc -l` | 50 | Confirmado |
| Criterios 135 `paquete:` → 133 + 3 = 136 | 136 | `grep -c 'paquete:' src/plan/criterios.ts` (135; l.75 tipo, l.6641 mapeo); `grep -n 'paquete:' src/plan/conducta.ts` (275, 349, 438); `npx tsx src/plan/status.ts \| tail -3` | 136 · «133 leen el fuente · 3 ▶» | Confirmado |
| Mutantes 120, 78 espejo, 58 sin, 120 mueren | — | `npx tsx scripts/mutantes.ts \| tail -9` | 136 · 78 · 58 · 120 · «✔ 120 murieron» | Confirmado |
| **Rutas literales en criterios: 182 (181 únicas)** | 182/181 | su comando: `grep -oE "'(src\|tests\|docs\|scripts\|\.github)/[^']+'" src/plan/criterios.ts \| sort -u \| wc -l` → 182; **pero** el patrón `[^']+` traga prosa: `'src/services/sat-download existe pero sin descarga-masiva.ts (el motor)'`, `'…sin el ciclo solicitar/verificar/descargar'`, `'src/…ts'`, `'src/services/reporting/**'`. Con `[^"' ]+` y sin `**`/`…`: | **178** rutas; 174 existen; 4 no (`sendgrid-adapter.ts`, `otro-archivo.ts`, `sat-download`, `sat-download/descarga-masiva.ts` — tres son rojos a propósito) | **Refutado como cifra**: 181 → 178 (174 vivas) |
| **Rutas castellanas 49; criterios con ruta es 46; con patrón es ≥60; con algo es 78; mutantes con archivo es 30; anclas es 38** | 49/46/60/78/30/38 | `node metodo/clasificar-criterios.js` reproduce idéntico. **Pero** `ES_TOKENS` (l.12-14 del guion) contiene `ledger roles rls auto catch pool golden bucket delta commander via factor`: por eso salen como «castellanas» `src/ai/tools/ledger-tools.ts`, `src/ai/usage-ledger.ts`, `src/services/accounting/ledger-checks.ts`, `src/database/rls-policies.sql`, `src/database/rls-guard.ts`, `scripts/provision-roles.sql`, `src/services/xml-ingestion/account-roles-seed.ts`. Rerun quitando SÓLO esos 12 tokens (`pcc-work/cc-conservador.js`): | **41 rutas (39 sin los 2 fragmentos de prosa) / 39 / 55 / 70 / 28 / 32** | **Refutado**: todas las cifras «castellanas» de §2.2 están infladas entre 7 y 16 % por tokens ingleses |
| 117 de 133 criterios citan ruta | 117 | mismo guion | 117 | Confirmado |
| Rutas de `tests/` en criterios | 6 | `grep -noE "'tests/[^']+'" src/plan/criterios.ts` | 10 literales en 1108, 1109, 1411, 1587, 3157, 3669, 3672, 3700, 6191, 6241 → 6 distintas | Confirmado (líneas exactas) |
| `LINEA_BASE` | 36 | `sed -n '197,236p' src/cli/kernel/audit.ts \| grep -c "^  '"` → 36; método alterno `awk '/^export const LINEA_BASE/{f=1;next} f&&/^\];/{exit} f&&/\|/{n++} END{print n}'` → 37, el 37.º es un comentario (l.204 «`outbox list\|run`») | 36 | Confirmado |
| Manifiesto 13 / 46 / 49 | — | su `python3 -c …` | 13 46 49; sin sellar: `pay-run-service.ts`, `paycheck-service.ts`, `cfdi-nomina-generator.ts` | Confirmado. Matiz: «no nombra archivos castellanos» vale para los 46 sellados; de los 49 declarados, `cfdi-nomina-generator.ts` lleva `nomina`. |
| `corpus-manifiesto --check` en rojo hoy | rojo | `npx tsx scripts/corpus-manifiesto.ts --check` | exit 1: `cambió iva-cash-basis.ts` (mexico-cfdi.md), `cambió doctor-service.ts` (playbooks.md) | Confirmado |
| Catálogo: 616 citas / 171 archivos / «1 de 616» | — | su `grep -oE … \| sort -u \| wc -l`; existencia con bucle `[ -e ]`; `sed -n '81p'` | 616 / 171 / 1 (`sendgrid-adapter.ts`) | Confirmado |
| Docs → rutas de tests: 259 / 145 rotas | — | su grep + bucle `[ -e "$p" ]` | 259 / 145 | Confirmado |
| `npm run …` menciones | 91/31/19/16/11/10/9/3/1/0 | su grep | 91 plan:status · 31 catalogo:estado · 19 eval · 16 ux:status · 11 mutantes · 10 costo:por-fila · 9 backfill · 3 reclass · 1 openapi · 0 corpus:estado | Confirmado |
| **Migraciones castellanas «36 de 74 (034–069, todas)»** | 36 | `ls src/database/migrations \| wc -l` → 74; `ls … \| grep -E '^0(3[4-9]\|[4-6][0-9])_'` | 36 en el rango, pero **`035_fiscal_credential_log_append_only.sql` es inglesa** | **Refutado**: 35 castellanas, no 36; «todas» es falso |
| Aserciones `toContain/toMatch` en `tests/cli` | 910 | `grep -c "toContain(\|toMatch(" tests/cli/*.spec.ts` (suma) → 910; **recursivo** `grep -rc … tests/cli --include='*.spec.ts'` | **1 025** (`tests/cli/kernel/` aporta 115) | Parcial: 910 es el glob plano; `tests/cli` tiene subcarpeta y el informe dice «tests/cli» |
| Literales largos 173, con marca castellana 5 | 173 / 5 | `grep -rhoE "toContain\('[^']{12,}'\)" tests/cli/*.spec.ts \| wc -l` → 160 (+5 con comillas dobles); castellanos por `[áéíóúñ¿¡]\| (de\|la\|el\|…) ` → 4 (`Acme Corporación SA de CV`, `Acme Corporación`, `No hay holgura que apretar.`, `¿A partir de qué monto se capitaliza?`) | 160-165 / 4 | **No reproducible**: el informe no da el comando; con el mío no salen 173 ni 5 |
| `vitest.config.ts` 6 claves (92-112), `vitest.integration.config.ts` 9 claves (60-101) | — | `grep -n "'src/" vitest*.config.ts` | 92, 95, 98, 101, 105, 112 / 60, 64, 71, 75, 79, 85, 93, 97, 101 | Confirmado |
| Diff sin comprometer de `vitest.config.ts` «+7 líneas: el include» | +7 | `git diff --stat vitest.config.ts` | **+17** (16 líneas de comentario + 1 `include`) | Refutado (cifra) |
| `criterios.ts:575-589 / 590-604` suelos; `:996-1040` criterio; `:1023-1029` espejo `otro-archivo` | — | `grep -n SUELO_COBERTURA`; `grep -n otro-archivo` | 575, 590; `otro-archivo` en **1027** (el informe ancla el `de:` en 1023, que es `},`) | Confirmado el rango; ancla desviada 4 líneas |
| `ci.yml` 8 jobs (33/46/61/76/185/229/263/338), nombres castellanos, líneas 44/74/145/153/158/166/176/225/304/312/423 | — | `grep -nE '^  [a-z_-]+:$' .github/workflows/ci.yml`; `sed -n` de cada línea | Todas exactas | Confirmado |
| `witness-triage.yml:75` lista bilingüe de palabras seguras; TODO l.113-150 | 75 | `grep -no 'ejemplo\|prueba\|mentira\|ficticio\|fals\[ao\]'` | **l.98**; l.75 es un comentario; el bloque TODO va de 103 a 160 | Refutado (líneas) |
| `scripts/` «17 archivos: 13 .ts, 2 .sh, 2 .sql» | 13 ts | `ls -1 scripts/ \| wc -l` → 17 ENTRADAS; `find scripts/artefacto -type f` | **12 `.ts`** + 2 `.sh` + 2 `.sql` + directorio `artefacto/` con `plantilla.html` | Refutado (13 → 12; la 17.ª es un directorio) |
| `package.json` scripts l.18-33 | — | `sed -n '15,36p'` | `lint` 18 … `eval` 33 | Confirmado |
| `NOMBRES` 5 jobs l.701; espejo `restauracion_retirada` l.729-737; `PUERTAS` l.711 | — | `sed -n '690,740p'` | Exacto. Matiz: `PUERTAS` sólo se aplica a los workflows DISTINTOS de `ci.yml` (`intrusos`, l.712-717): detecta puertas fugadas, no vigila que `ci.yml` siga llamando `plan:status`. La conclusión del informe (nada automático acusa un renombre del script npm) se sostiene por otra vía, no por la que da. | Confirmado con matiz |
| Piso 69 verdes; identidad `paquete · enunciado` (`status.ts:165`) | — | `python3` sobre `docs/criterios-minimos.json`; `sed -n '165p'` | `verdes: 69`; `identidadDe = … \`${c.paquete} · ${c.enunciado}\`` | Confirmado |
| Catálogo-mínimos 214 / 194 | — | `head docs/catalogo-minimos.json` | 214 / 194 | Confirmado |

## 2. Muestra de `archivo:línea`

Abrí **66** citas (`sed -n '<l>p'`), no 30, porque las de `criterios.ts` merecían comprobación aparte.

- **Exactas en la línea (56)**: `tests/accounting/ar-ap-posting-f03.spec.ts:137`, `ar-ap-posting-iva.spec.ts:174`,
  `tests/ai/compaction.spec.ts:267`, `tests/plan/mutacion.spec.ts:52` y `:71`, `tests/cli/kernel/auditoria-programa.spec.ts:67`,
  `tests/cli/bilingual-matrix.spec.ts:25/:208/:310`, `tests/ai/cli-reference.spec.ts:27`, `tests/config/env-example.spec.ts:84`,
  `tests/ai/niif-registry.spec.ts:22`, `tests/integration/helpers/sql-scan.ts:53`, `tests/cli/codigos-de-salida.spec.ts:395`
  (`HOJAS_PROPIAS = 18`), `tests/database/migration-numbering.spec.ts:9`, `criterios.ts:3700/:3165/:1241/:1393/:1407/:729/:483/:530/:701/:711`,
  `status.ts:165/:182/:311/:327/:391`, `vocabulary.ts:22/:133`, `corpus-manifiesto.ts:58/:84/:89/:173`,
  `catalogo-estado.ts:42/:102/:122/:145/:170/:243/:547`, `ux-status.ts:210/:299/:314`, `CONTRIBUTING.md:158/:96`, `README.md:345`,
  `docs/PROCESS.md:58/:38`, `AGENTS.md:8`, `CLAUDE.md:8`, `censo-superficie.spec.ts:149/:296/:503/:540`, `vitest.config.ts:72`,
  `ci.yml` ×11.
- **Anclas de criterio, no de patrón (8)**: `criterios.ts:1255, 1280, 1418, 2235, 2718, 3656, 4139, 5112` son la línea
  `paquete:` del criterio; el patrón citado vive 5-45 líneas más abajo dentro del mismo criterio (comprobado con
  `grep -n`: `checkLedgerIntegrity` 1263, `bloquearPeriodoParaPostear` 1285, `exigirSegregacion` 1459, `indiceDeCalendario`
  2246, `SolicitaDescarga` 2726, `conFuenteMutada` 3673, `cotejarMovimientoConSuLinea` 4144, `auditarRiesgoDeRutas` 5126).
  El formato «`criterios.ts:línea · paquete · patrón`» de §4.2 no lo aclara.
- **Desviadas (2)**: `criterios.ts:1023` (`},`) — el `de: "'src/services/reporting/criterio-cierre.ts': {"` está en **1027**;
  `audit.ts:188-194 claveDeViolacion` — la función empieza en **187**, 188 es comentario.

Sobre los 30 primeros de la lista (15 de tests + 15 de `criterios.ts`/`status.ts`): 21 exactos, 8 anclas de criterio con
patrón verificado dentro, 1 desviado (`:1023`). Ninguna cita apunta a algo que no exista.

## 3. Lo que el informe no vio (o citó sin peso)

1. **Cuarto consumidor de las claves de umbral** — `tests/integration/s4a-ataque.int.spec.ts:19` importa
   `SUELO_COBERTURA_UNITARIA`, `:290-295` muta `vitest.config.ts` EN MEMORIA (`conFuenteMutada`) y `:346-347` inyecta una
   clave inexistente (`src/servicios/que-no-existen/jamas.ts`) para exigir que TODA entrada de `thresholds` esté también en el
   suelo; `:283-291 criterioPorEnunciado(CRITERIO_COBERTURA)` busca el criterio **por su enunciado castellano literal**.
   El propio diff sin comprometer de `vitest.config.ts` (l.+8-+16) lo describe: «el ataque 3e de s4a-ataque exige…».
   El informe dice «triplicado» (`vitest.config.ts`, `vitest.integration.config.ts`, `criterios.ts:575-604`); son cuatro,
   y el cuarto acopla además el TEXTO del enunciado. Comando: `grep -nE "SUELO_COBERTURA|thresholds|vitest\.config" tests/integration/s4a-ataque.int.spec.ts`.
2. **Un criterio hace regex de PROSA castellana sobre `docs/cli-command-catalog.md`** — `criterios.ts:~776-840`
   (compuerta de auditorías, E0.0): `catalogo.matchAll(/hecha en (F\d+[a-z]?|A\d+(?:-A\d+)?|R\d+)\b/g)` lee la celda
   «hecha en F03» de cada fila cerrada y exige `existe(REGISTROS[f])` sobre un mapa de **24 rutas `docs/auditorias/*.md`**
   (`grep -oE "'docs/[^' ]+'" src/plan/criterios.ts | sort | uniq -c`). Traducir la celda del catálogo («done in F03»)
   o mover `docs/auditorias/` pone E0.0 en rojo — y E0.0 está en `--exigir` (`ci.yml:145`). El informe no cita ningún
   criterio que lea `docs/` ni ninguna regex de prosa; su §5 «Traducir el texto de un enunciado» es la única fila sobre texto.
3. **`.github/CODEOWNERS`** (no aparece en el informe): 7 rutas con dueño (`/src/services/fiscal-credentials/`,
   `/src/services/vault/`, `/src/database/migrations/`, `/src/database/rls-policies.sql`, `/src/ai/floor.ts`,
   `/.github/workflows/`, `/.github/CODEOWNERS`) bajo el ruleset `require_code_owner_review`. Un renombre deja la regla
   sin dueño **en silencio** (el archivo lo dice: «la regla existía y no pedía nada, porque ninguna ruta tenía dueño»).
   Hoy todas inglesas; es un sitio más que vive por ruta y no tiene puerta.
4. **`tests/golden/cfdi/`** (20 archivos; el informe sólo nombra el directorio en `criterios.ts:3157`): nombres castellanos
   (`nota-credito-ppd`, `sospechoso-inyeccion`, `ask-ambiguo-servicios`, `capitaliza-equipo-computo`), sufijo
   `.esperado.json`, y **claves JSON castellanas** (`asiento caso nota precondicion resultado sospecha tratamiento`,
   `python3` sobre `tests/golden/cfdi/*.esperado.json`) consumidas por `scripts/eval-clasificador.ts` y
   `src/ai/eval/puntuacion.ts`. Son DATO de un contrato (el eval), no identificadores: traducir claves rompe el arnés.
5. **`vi.mock('…')` por cadena**: 81 rutas únicas en `tests/` (`grep -rhoE "vi\.mock\(\s*'[^']+'" tests --include='*.ts' | sort -u | wc -l`),
   6 a módulos de nombre castellano. El informe lo menciona sin contar; no lo detecta `tsc` (son cadenas), sólo `vitest` al correr.
6. **Corpus del agente cita rutas**: `src/ai/docs/*.md` nombran 9 rutas `src|tests|scripts` en 5 manuales
   (`grep -hoE '(src|tests|scripts)/[A-Za-z0-9_./-]+\.(ts|sql)' src/ai/docs/*.md | sort -u`), 1 ya inexistente.
   Renombrar la fuente obliga a reescribir el manual (texto) además de resellar el hash.
7. **`eslint.config.mjs:42,66,125,190`** y **`tsconfig.test.json:3-7`** trabajan por glob (`src/**`, `tests/**`, `scripts/**`):
   NO se rompen con renombres. Vale decirlo porque el informe lista `typecheck:tests` como acusador sin decir qué no acusa.
8. **`.claude/worktrees/`** (ignorado por `.gitignore:73`) contiene copias de otros árboles; cualquier `grep -r` desde la raíz
   sin excluirlo contamina conteos. Los comandos del informe restringen a `docs src scripts tests .github` y no caen; el mío
   sobre `.claude` sí cayó (por eso lo anoto).

Instrucciones encontradas en archivos y NO ejecutadas: `corpus-manifiesto.ts` pide «sella con `--actualizar`»;
`docs/criterios-minimos.json:_` y `catalogo-minimos.json:_` describen cómo subir el piso; `witness-triage.yml` es un
listener. Todo leído como dato.

## 4. Veredictos

- **Se sostienen**: 343/336/88/248/7; 1535 `describe`; 4 831/1 999 y 232/104 (guion reproducible byte a byte); 139 nombres
  castellanos; 82/46 importaciones; 50 lecturas por ruta; 136 criterios; 120/120 mutantes, 78/58; 117 con ruta; 6 rutas de
  tests; 36 `LINEA_BASE`; 13/46/49 manifiesto y su rojo actual; 616/171/1; 259/145; menciones `npm run`; claves de vitest
  (6 y 9) con sus líneas; jobs y líneas de `ci.yml`; scripts npm; piso 69; suelo 214/194; la lectura «CLI ya inglés
  canónico + alias castellano, ayuda exigida en inglés».
- **Refutados**: «181 rutas únicas» (178 reales, 174 vivas: el grep traga prosa); **todas las cifras «castellanas» de §2.2**
  (49→39 rutas, 46→39 criterios con ruta es, ≥60→55 con patrón, 78→70 con algo, 30→28 mutantes, 38→32 anclas) por
  `ledger/roles/rls/auto/catch/pool/golden/…` en `ES_TOKENS`; «36 migraciones castellanas, 034–069 todas» (035 es inglesa →
  35); «+7 líneas» del diff (+17); «13 .ts» en scripts (12 + un directorio); `witness-triage.yml:75` (es l.98);
  «173 literales / 5 castellanos» (sin comando; con el mío 160-165 / 4); «910 aserciones en tests/cli» es sólo el glob plano
  (1 025 con `tests/cli/kernel/`).
- **Omisiones con peso**: `s4a-ataque.int.spec.ts` como cuarto consumidor de umbrales y como test que fija un enunciado
  literal; el criterio E0.0 que hace regex de prosa castellana («hecha en F03») sobre el catálogo y exige 24 rutas
  `docs/auditorias/`; `CODEOWNERS`; claves castellanas dentro de `tests/golden/cfdi/*.esperado.json`; 81 `vi.mock` por cadena.
- **Conclusión del informe (§8) que sigue en pie con corrección**: el acoplamiento fuerte es el instrumento
  (`criterios.ts` + suelos + manifiesto + catálogo), y cada PR debe llevar codemod e instrumento juntos. Lo que cambia:
  la cuenta de criterios «castellanos» es 70 de 133, no 78; hay un cuarto trinquete de cobertura en un test de ataque;
  y traducir PROSA (celdas del catálogo, enunciados) rompe criterios y tests, no sólo `--piso` — el «PR 0» de identidad
  estable del §7 es más urgente de lo que el informe le da, porque `s4a-ataque:283` ya casa por enunciado.
