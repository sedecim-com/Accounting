# Verificación escéptica: esquema y vocabularios como datos

Informe verificado: `/tmp/investigacion-idioma/inventario/esquema-y-vocabularios.md`.
Árbol: `/Users/victor/projects/Accounting` en `b31e62a` (el mismo commit que declara el
informe; rama `j0-1-la-jurisdiccion-deja-de-ser-un-booleano`). Hay modificaciones sin
comprometer en 7 archivos y 4 rutas nuevas (`git status --short`), ninguna en
`src/database/`, `src/services/policy/` ni `src/types/`; sí en `vitest.config.ts`
(+17 líneas), por lo que ese archivo se verificó contra `git show b31e62a:vitest.config.ts`.
Fecha: 2026-09-06. No se editó ningún archivo del repositorio. Los archivos de trabajo
(salidas de scripts, listas) están en `/tmp/investigacion-idioma/verificacion/esq-work/`.

Criterio: cada cifra se volvió a contar con el comando del informe o uno mejor; cada
`archivo:línea` de la muestra se abrió con `sed -n`. Ante la duda, refuto.

---

## 1. Veredicto por conteo

| # | Informe | Re-conteo | Veredicto |
|---|---|---|---|
| C1 | 74 migraciones | `ls src/database/migrations/*.sql \| wc -l` → **74** | Se sostiene |
| C2 | 115 tablas | mismo comando → **115** CREATE. Pero `grep -hoiE 'DROP TABLE (IF EXISTS )?[a-z_.0-9]+' src/database/migrations/*.sql \| sort -u` → **6** tablas tiradas en `038_entierro_s05.sql` (`blockchain_jobs`, `custom_reports`, `integration_events`, `integration_mappings`, `integration_sync_jobs`, `transactions`), todas creadas antes (001/004/006/007). | **Matiz**: 115 es cuenta de `CREATE`, no de tablas vivas: **109 vivas**. «Las otras 90 tablas 100 % inglés» son 84 vivas. |
| C3 | 5 tablas castellanas | mismo filtro → **5** (`inpc_serie`, `mx_isn_tasas_estatales`, `sat_anexo24_artefactos`, `sat_bancos`, `sat_codigos_agrupadores`); revisé a ojo las 115 y no hay otra. | Se sostiene |
| C4 | 1868 pares | `python3 columnas.py` → **1868** | Se sostiene (incluye columnas de las 6 tablas tiradas) |
| C5 | 117 columnas / 25 tablas | `python3 columnas2.py` → **117 / 25** | Se sostiene |
| C6 | 61 sólo-acrónimo | idem → **61** | Se sostiene |
| C7 | 2 vistas | grep del informe → `mv_trial_balance`, `mv_account_balance_summary` (**2**) | Se sostiene |
| C8 | 14 funciones, 6 castellanas | grep del informe → **14** creadas, 6 castellanas. Pero `042_el_refresco_sale_del_posteo.sql:26` hace `DROP FUNCTION IF EXISTS refresh_materialized_views()` sin recrearla (`grep -l "FUNCTION refresh_materialized_views" migrations/*` → 004, 024, 042; en 042 sólo el DROP). | **Matiz**: 13 vivas, 6 castellanas |
| C9 | 321 objetos, 59 castellanos | Regeneré la extracción (`esq-work/nombres_objetos_regen.txt`, 325 líneas; `diff` con el `nombres_objetos.txt` del informe → vacío) y corrí el script inline de §4.7 → **321 / 59**. Los 4 tokens basura (`IF`, `del`, `global`, `violation`) se excluyen igual. | Se sostiene. Nota: `rls-policies.sql:60` crea `tenant_isolation` por `EXECUTE format(...)`; el regex no la ve, pero es un solo nombre inglés. |
| C10 | 134 CHECK IN, 604 literales | `python3 checks.py` → **134 / 604** | Se sostiene, con salvedad: cuenta **declaraciones**, no restricciones vivas; el propio `criterios.ts:1621-1623` documenta que `journal_entries.entry_type` se redefine en 023 y 025 («gana la última»). |
| C11 | 14 CHECK / 43 valores castellanos | El script marca **26 CHECK / 47 valores** (`checks.out`). La curación quita 12 CHECK cuyo único «castellano» es `manual`, `error`, `global`, `ok`, `banco_mexico`, `dof` y añade 3 que el script NO ve (`062:39` catalogo/balanza/poliza…, `015:45` emitido/recibido/ajeno, `044:62` sospecha). Sumé la tabla de §3.3 a mano: 6+3+4+4+2+1+3+1+1+3+1+6+5+3 = **43** en **14**. | Se sostiene como curación; el «comando» real es la tabla a mano, no `checks.py` |
| C12 | 22 vocabularios | `grep -c "^  v('" src/database/enums.ts` → **22** | Se sostiene |
| C13 | 53 claves | `grep -cE "^\s*key: '" pending-catalog.ts` → **53**, 53 distintas | Se sostiene |
| C14 | 133 valores; 32 num, 8 no-ES, 93 ES, 70 distintos | `grep -oE "value: '[^']*'" ... \| wc -l` → **133**; numéricos `grep -cE "value: '[0-9.,-]+'"` → **32**; los 8 (`off on shadow manual dof fix_banxico split_85`) → **8**; resto **93**; distintos no numéricos no-8 → **70** | Se sostiene |
| C15 | 53 defaultValue (54 con interfaz) | `grep -c "defaultValue:"` → **54** | Se sostiene |
| C16 | 18 líneas / 4 archivos | `grep -rn "resolved_value" src --include='*.ts' \| grep -v pending-catalog` → **18 / 4** (`pending-command.ts`, `memory-service.ts`, `policy-tools.ts`, `policy-service.ts`) | Se sostiene |
| C17 | src 123/34, tests 247/47, docs 83/15 | Reconstruí «los 44 valores inequívocos con `_`» = los 70 distintos castellanos que llevan `_` → exactamente **44** (`esq-work/panel_vals_underscore.txt`). `grep -rnoE "'(…44…)'" src --include='*.ts' \| grep -v pending-catalog` → **123 en 34**; tests → **247 en 47**. Docs: con comillas simples **19 en 6**; con backticks **59 en 13**; por palabra (`-w`, sin delimitador) **90 en 16**. Ninguna variante da 83/15. | src y tests se sostienen; **docs 83/15 no reproducible** (la cifra más cercana es 90/16 por palabra) |
| C18 | src 326/45, tests 511; period-close 46, cash-flow-service 28, cash-flow-reconcile 21, cfdi-decisions 16, criterios 16 | Con los 44 + las 31 palabras sueltas del panel: src **320 en 53**, tests **509**; period-close **46**, cash-flow-service **28**, cash-flow-reconcile **21**, cfdi-decisions **13**, criterios **11** | Cota superior: se sostiene en orden de magnitud; los tres primeros archivos exactos; los dos últimos no. La lista de palabras del informe no está publicada, así que la cifra exacta no es reproducible. |
| C19 | src 25, tests 22, docs 80, criterios 17 (35 líneas) | src **25** ✓, tests **22** ✓, criterios **17** ✓ y 35 líneas con `migrations/` ✓; docs → **84** (por subdirectorio: 12 en `auditorias/2026-09-01-integral-iii`, 11 en `integral-ii`, 9 en `investigacion/.../motores`, 6 en `wiki`…). `docs/` no tiene cambios sin comprometer. | **docs 80 refutado → 84**. Además: de los 22 de tests, **15 son nombres ficticios de fixtures** (`001_a.sql`, `012_b.sql`, `031_c.sql`…, `comm -23` contra `ls migrations`); sólo 7 nombran migraciones reales. |
| C20 | 21 nombres en docs que no existen | `comm -23 <(grep -rhoE "[0-9]{3}_[a-z_0-9]+\.sql" docs \| sort -u) <(ls src/database/migrations \| sort -u) \| wc -l` → **23**. De ellos 4 son marcadores ilustrativos de `docs/migraciones.md` (`012_a.sql`, `033_a.sql`, `033_b.sql`, `014_migracion_nueva_de_hoy.sql`) → **19 obsoletos reales**. | **Refutado: 23 (19 reales), no 21** |
| §3.5 | 131 `label:` inline, 48 `question:` (45 inglesas, 0 castellanas) | `grep -oE "label: '[^']*'" \| wc -l` → **131** ✓ (0 con artículo castellano ✓; 113 con partícula inglesa con lista amplia, 92 del informe es compatible). `grep -cE "^\s*question:"` → **54** = 53 claves + 1 interfaz; **5 son multilínea** (`grep -cE "question:\s*$"` → 5), que es justo la diferencia con los 48 del informe. 0 castellanas ✓. | **48 refutado → 53 preguntas** |
| §3.6 | 38 títulos ingleses (001-033) / 36 castellanos (034+) | `ls migrations \| awk -F_ '$1<=33' \| wc -l` → **38**; `$1>=34` → **36** | Se sostiene |
| §4.1.2 | lectores src 5/4/3/3/3; tests 4/4/3/5/5; docs 2/0/0/2/0 | `grep -rl <tabla>` → **idénticos** | Se sostiene |
| §4.2.4 | «Pruebas de integración que nombran la tabla»: 10/14/5/2/13 | `grep -rl <tabla> tests` → **10/14/5/2/13**; pero `tests/integration` solo → **7/7/3/0/9** | Cifras correctas, **etiqueta falsa**: son de todo `tests/`, no de integración. `reconciliation_match_groups` no aparece en ninguna prueba de integración. |
| §4.3.3 | cheque-en-circulacion 5/22, cargo-del-banco 4/27, iva-comision 4/23, proporcional_dias 10/39, tasa_plana 6/15, quincenal 7/12, devolucion 1/2 | `grep -rn "'<v>'"` src/tests → **todos idénticos** | Se sostiene |
| §4.3.5 | docs isr-retenido 9, iva-comision 6 | **9 / 6** | Se sostiene |
| §4.4.3 | criterios.ts ancla «7 valores más» | `grep -noE "'(…44…)'" src/plan/criterios.ts` → **4** (`descuento_compras` ×2, `otros_ingresos` ×2); + `'exigir'` (:1437) + `'shadow'` (:3438) = 6 | **No reproducible como 7**. Claves del panel citadas en `criterios.ts`: 4 de 53. |
| §4.4.4 | docs por clave: segregacion 21, umbral 19, ingest 18 | `grep -rl <clave> docs \| wc -l` → **22 / 20 / 20** | Refutado por 1-2 en cada caso (menor) |
| §5 | manifiesto 46 hashes | `python3`: `hashes` dict → **46**; rutas `src/` distintas en el JSON → 49 (las 3 extra están en `manuales`, que mapea `.md` → rutas de código, no hashes de `.md`) | Se sostiene |

---

## 2. Muestra de `archivo:línea`

Abrí **116 citas** (55 en migraciones, 61 en TS/docs) con `sed -n Np` y un patrón por cita
(`esq-work/`, salida en el registro de esta sesión). Resultado: **107 exactas, 9 inexactas**.
La muestra de 30 pedida es el subconjunto marcado con ★; el resto se añade porque ya estaba
abierto.

### 2.1 Migraciones — 54/55 exactas

★ Exactas: `063:75` sat_codigos_agrupadores, `064:67` sat_bancos, `065:26` inpc_serie,
`062:33` sat_anexo24_artefactos, `054:67` tipo, `054:91` importe, `054:96` fecha_esperada,
`054:98` ninguno/avisado/vencido, `054:135` reconciliation_adjustments.tipo (la línea abre el
CHECK; los valores empiezan en :136), `052:41` total_banco, `052:53` motor, `039:36` clave,
`047:24` motivo, `044:43` sospecha_count, `044:62` sospecha, `037:28` codigo_agrupador_sat,
`005:14` document_type (abre el CHECK; `cfdi_ingreso` está en :15), `005:30` emisor_rfc,
`005:113` clave_prod_serv, `008:45` tipo_regimen_sat, `008:123` quincenal, `008:219`
subsidio_empleo, `066:46` tipo_tercero, `066:84` tasa/cuota/exento, `064:34` cuenta_destino,
`032:28` imss_registro_patronal, `067:147` subsidio_entregado_efectivo, `067:51` tasa_plana,
`049:45` devolucion, `059:137` proporcional_dias, `015:45` emitido, `016:16/21/24/29`.

★ Inexacta: `067_lo_que_el_patron_paga_y_nadie_apunta.sql:39` para `CREATE TABLE
mx_isn_tasas_estatales` → la línea real es **:38** (`:39` es el comentario de la primera
columna).

### 2.2 TS y docs — 53/61 exactas

Exactas (entre otras): `period-close.ts:91, :105, :648, :1128, :1136, :1155, :1174` y 1491
líneas ✓; `policy-service.ts:34, :145, :235, :253, :290` ✓; `types/index.ts:266` y 959
líneas ✓; `account-service.ts:628` ✓; `bank-command.ts:1775` ✓; `prepaid-command.ts:94` ✓;
`cli-command-catalog.md:204/:208` (R8/R9) ✓; `Arquitectura.md:122` ✓; `criterios.ts:886`
(CREATE/DROP TABLE), `:1437-1438` (segregacion/exigir; el rango 1436-1439 los contiene),
`:1510-1511` (uq_xml_documents; rango 1507-1511 ✓), `:1615`, `:2162-2185`, `:3438`,
`:4086-4096` (mutantes con cuerpos de CHECK), `:4218`, `:4490`, `:4884`, `:5002` ✓;
`rls-policies.sql:21` (`excluded`), `:25-27` (rango 23-33 ✓), `:91` (`append_only`) ✓;
`reconciling-items.ts:133/179/389` ✓; `polizas-service.ts:301/673` ✓;
`polizas-invariantes.ts:37` ✓; sembradores `sat-agrupadores.ts:67`, `inpc-service.ts:309`,
`payroll-isn-command.ts:996`, `artefactos.ts:81` ✓; `schema-contract.int.spec.ts:15-19`
(rango 14-20 ✓); `reconciliation-math.ts:53` ✓.

Inexactas:

1. `enums.ts:98` `CREDIT_NOTE_TYPES` → real **:92**.
2. `enums.ts:181-203` `VOCABULARIOS` → real **:183-206**.
3. `enums.ts:37-44` comentario «el esquema lo nombra en inglés» → real **:38-44** (:37 en blanco; menor).
4. `reconciliation-math.ts:78-85` `LADO_DE` → la declaración está en **:77**; el rango cubre el cuerpo.
5. `migrate.ts:66-68` «la tabla `public.migrations` guarda sólo `filename`» → real **:93-95** (`:66-68` es el error de números duplicados). Cierto que sólo hay `filename` (sin checksum): `grep -nE "checksum|hash" migrate.ts` → nada.
6. `migrate.ts:82` consulta por nombre → real **:109**.
7. `migrate.ts:105` inserta por nombre → real **:132**.
8. `migrate.ts:127` reaplica `rls-policies.sql` → real **:154**. (Las cuatro citas de `migrate.ts` están corridas ~27 líneas; el archivo tiene 195 y su último commit `ebf2181` es ancestro de `b31e62a`.)
9. `vitest.config.ts:41-44` «sin umbral en period-close/ledger-checks» → en el archivo comprometido (101 líneas) ese comentario está en **:34-38**; y `:97-121` (umbrales) **no existe**: los `thresholds` están en **:74-98**. Las rutas con umbral (`posting.ts`, `validation.ts`, `ar-ap-posting.ts`, `sequence.ts`, `report-service.ts`, `criterio-cierre.ts`) sí son las que dice.

Conclusión de la muestra: el 92 % de las citas son exactas; las inexactas se concentran en
`migrate.ts`, `vitest.config.ts` y `enums.ts`, donde todas las líneas están corridas de
forma consistente (probablemente leídas de una versión distinta). Ninguna inexactitud cambia
el fondo de lo que afirma, pero un plan que copie esas líneas irá a parar al sitio equivocado.

---

## 3. Lo que el informe no vio

### 3.1 `account_roles.role`: el mayor vocabulario castellano persistido, sin CHECK, fuera del inventario

- `015_account_roles.sql:13` `role VARCHAR(60) NOT NULL` — **sin CHECK**; por eso `checks.py`
  y el informe entero no lo ven (sólo miraron `CHECK (col IN (...))`).
- El vocabulario vive en TS: `src/services/xml-ingestion/cfdi-taxonomy.ts:11` `export type
  AccountRole = ...` con **36 valores** (`sed -n 11,71p | grep -oE "'[a-z_0-9]+'" | sort -u`
  → 39 tokens, 3 son `credit`/`debit`/`direction` de otros tipos vecinos), de los que **33 son
  castellanos**: `gasto`, `banco`, `cxc`, `cxp`, `iva_acreditable`, `iva_trasladado_no_cobrado`,
  `isr_retenido_por_pagar`, `ieps_por_pagar`, `sueldos_por_pagar`, `anticipo_clientes`,
  `depreciacion_acumulada`, `utilidad_cambiaria`…
- Lo siembra `src/services/xml-ingestion/account-roles-seed.ts`; lo leen **26 archivos** de
  `src` (`grep -rlw account_roles src --include='*.ts' | wc -l`); `'gasto'` aparece como
  literal 16 veces en src y en 8 archivos de tests; el planificador de pólizas compara por
  literal (`cfdi-posting-plan.ts:35` `ROLES_DE_GASTO = new Set<AccountRole>([...])`, `:138`,
  `:173`).
- **No está en `VOCABULARIOS`** (`grep account_roles enums.ts` → 0) ni en
  `enum-contract.int.spec.ts` (0). `criterios.ts` lo menciona 2 veces.
- Es la clase «dato_vocabulario» más acoplada al agente (el clasificador de CFDI produce
  roles y el agente los cita) y no aparece en §3, §4 ni §6 del informe. Cualquier plan de
  «valores persistidos» que parta del informe se deja fuera este vocabulario.

### 3.2 Las cadenas inglesas del panel están **persistidas por inquilino**, no sólo en el catálogo

El informe dice (§3.5) «Persistencia (tres sitios): `key`, `options`, `default_value`,
`resolved_value`» y concluye (§7, §8) que el panel invertido es «la más barata de cerrar (un
catálogo de labels)». Es falso en dos pasos:

1. `016_policy_decisions.sql:17-24` persiste además **`category`, `question`, `impact`,
   `default_rationale`** (y `status`, `source`). `policy-service.ts:51-61` los siembra desde el
   spec en cada fila; `:57-58` `ON CONFLICT DO NOTHING`: una fila sembrada **nunca se
   actualiza** desde el catálogo. La siembra ocurre en `init` (`src/cli/init/s4-policies.ts:62`)
   y en cada `pending` (`pending-command.ts:249, :343`).
2. Los lectores renderizan **desde la fila**: `policy-service.ts:148` `question: row.question`
   (`:158` usa el spec sólo como fallback); `pending-command.ts:223` `p.question`, `:228`
   `p.impact`, `:230` `p.default_rationale`, `:234` `p.options` (con sus `label`); el agente
   igual: `policy-tools.ts:212` selecciona `question, options` de la fila, `:234`, `:240`. Sólo
   `whyAsking`/`whatIDo`/`ifSkipped` salen del spec (`pending-command.ts:181-183`).

Consecuencia: traducir `pending-catalog.ts` cambia lo que ven los inquilinos **nuevos**; para
los existentes hace falta una migración de datos sobre `policy_decisions` (tabla de inquilino
→ bucle bajo RLS de `docs/migraciones.md:43-78`) que reescriba `question`, `impact`,
`default_rationale` y el `label` dentro del JSONB `options`, **o** cambiar los tres lectores
para que rendericen por `key` desde el catálogo. No es «trabajo de catálogo de textos».

### 3.3 Cinco campos de texto por clave que el informe no contó

`grep -oE "^\s*[a-zA-Z]+:" pending-catalog.ts | sort | uniq -c`: además de `question` (53)
y `label` (131) hay **`whyAsking`, `whatIDo`, `impact`, `ifSkipped`, `defaultRationale`**, 53
cada uno = **265 cadenas más**, y `category` (53). Idioma (heurística de partículas sobre las
líneas del campo y las dos siguientes): whyAsking 81 inglesas / 0 castellanas; whatIDo 65/0;
impact 91/0; ifSkipped 42/0; defaultRationale 91/0. El inventario de «textos del panel en
inglés» es de ~450 cadenas, no de 179. Además los **comentarios** del mismo archivo son
castellanos (70 líneas `//`: 44 con partículas castellanas, 11 inglesas): el archivo ya tiene
la inversión completa respecto al pedido (código-comentario en castellano, texto de usuario en
inglés).

`category` toma 4 valores castellanos (`contable` 39, `fiscal` 6, `operativa` 6, `seguridad`
3) y se persiste (`016:17`); ningún lector lo compara por literal (`grep -rn "category === '"`
→ sólo `s3-ai.ts` y `probe.ts`, otras categorías).

### 3.4 Hay 11 vocabularios castellanos `as const` fuera de `enums.ts`, no 1

El informe señala sólo `reconciliation-math.ts:53-60` como «copia no censada».
`grep -rnE "= \[('[a-z_-]+'(, )?)+\] as const" src --include='*.ts' | grep -v enums.ts` con
filtro de tokens castellanos:

| archivo:línea | constante | CHECK espejo |
|---|---|---|
| `src/services/banking/reconciliation-math.ts:53` | `TIPOS_DE_PARTIDA` | `054:67` |
| `src/services/banking/reconciling-items.ts:83` | `ESCALAMIENTOS` | `054:98` |
| `src/services/banking/reconciling-items.ts:398` | `MOTIVOS_DE_OMISION` (`importe-cero`) | — |
| `src/services/banking/reconciliation-adjustments.ts:53` | `TIPOS_DE_AJUSTE` | `054:135` |
| `src/services/accruals/amortization-math.ts:65` | `CONVENCIONES_AMORTIZACION` | `059:137` |
| `src/cli/prepaid-command.ts:192` | `ORIGENES_DE_ANTICIPO` | `059:148` |
| `src/services/fiscal/inpc/inpc-service.ts:59` | `FUENTES_INPC` | `065:34` |
| `src/services/assets/depreciation-math.ts:50` | `BASES_DE_DEPRECIACION` (`vida_util_nif`, `tasa_lisr`) | panel |
| `src/services/assets/depreciation-math.ts:54` | `CONVENCIONES_PRIMER_MES` | panel |
| `src/services/reporting/cash-flow-reconcile.ts:47` | `ROLES_DE_EFECTIVO` (`banco`) | account_roles |
| `src/services/banking/reconciliation-math.ts:77` | `LADO_DE` (Record) | `054:67` |

Ninguna está en `VOCABULARIOS` ni se nombra en `criterios.ts` (`grep -c` → 0 en ambos para
las once). Y el criterio de `criterios.ts:1615` **no puede** verlas: `:1668`
`dondeAparece(TERNA, ['src'], true)` sólo escanea archivos donde ya aparece una terna
`'tabla', 'columna', CONST)`, y `grep -rnoE "'(reconciliation_adjustments|prepaid_expenses|
inpc_serie|reconciling_items|…)', *'[a-z_]+', *[A-Z_]+" src` → vacío. `enum-contract.int.
spec.ts:97-102` sólo comprueba que `VOCABULARIOS` no tenga entradas duplicadas. Resultado: de
los 14 CHECK con valores castellanos, **13 no están vigilados** por ningún contrato (sólo
`credit_notes.type`, `enums.ts:183+`). El informe da a entender que es un caso aislado.

### 3.5 Otros sitios donde vive la misma clase de texto

- **Manuales del agente** (`src/ai/docs/*.md`, 28 archivos): 9 citan claves del panel, 7 citan
  valores de CHECK (`cheque-en-circulacion`, `proporcional_dias`, `emitido`…), 1 columnas
  compuestas, 1 tablas castellanas (`grep -lwE … src/ai/docs/*.md`). `manifiesto.json` no
  hashea los `.md` (`manuales` mapea `.md` → rutas de código), así que renombrar un valor deja
  la prosa del manual obsoleta **sin que ningún hash lo detecte**.
- **Esquema de herramienta del agente**: `src/ai/tools/external-tools.ts:35`
  `document_type: z.enum(['Nomina', 'Ingreso', 'Egreso', 'Pago'])` — nombres del SAT en el
  contrato de una herramienta; el informe no cubre `z.enum` (36 en src; los demás son ingleses).
- **Pruebas doradas**: `tests/golden/cfdi/*.esperado.json` — 10 archivos contienen `"sospecha"`
  (veredicto del clasificador, mismo vocabulario que `ai_agent_events.kind`, `044:62`).
- **`dist/`** no está versionado (`.gitignore:3`), pero `package.json:12` copia
  `src/database/migrations/*.sql` a `dist/database/migrations/` y `migrate.ts:154` lee
  `rls-policies.sql` desde `__dirname`: la app compilada ejecuta la copia. No cambia el coste
  de un renombre, pero es un cuarto lugar donde existen los nombres de archivo.
- **`src/cli/kernel/audit.ts:197` `LINEA_BASE`** (36 entradas `comando|regla|mensaje`) es una
  línea base de hallazgos de la auditoría de la CLI, no de rutas de archivo; 3 entradas nombran
  `pending define`/`pending dismiss`. No depende de esta superficie; el informe hizo bien en
  no citarlo, pero conviene dejarlo escrito porque el encargo lo lista como regla de la casa.

### 3.6 Afirmaciones menores refutadas

- «`doctor` las marcaría huérfanas» (§4.2.7, columnas sin lector): `doctor-service.ts` sólo
  consulta `information_schema.table_privileges` (`:1056`, privilegios del rol auditor); su
  escáner de «capacidad huérfana» trabaja por tabla y por export, no por columna
  (`grep -nE "information_schema\.columns" doctor-service.ts` → nada). Las tres columnas sin
  lector (`sat_bancos.nombre_corto`, `xml_documents.condiciones_pago`, `employees.departamento`:
  `grep -rlw` en src → 0/0/0 ✓) **no las detecta nadie**.
- «Las excepciones son posteriores a la 034 … salvo `005`, `008`, `015`» (§3.4): también
  `032_schema_contract.sql:28` (`imss_registro_patronal`), que el propio informe cita en §3.2.
  El resto de columnas <034 que marca el script son sólo-acrónimo (`clabe`, `rfc`, `pac_*`,
  `ots_*`, `cfdi_*`), correctamente excluidas.
- «`sat_bancos` no tiene INSERT en el árbol» (§5, §7): cierto para `src` y migraciones;
  `tests/integration/f07d-polizas-y-su-rastro.int.spec.ts:340, :376` sí insertan (fixture).
- «14 funciones» → 13 vivas (§1 C8). «115 tablas» → 109 vivas (C2).
- «cuatro números duplicados»: correcto, pero `014` es **triple** (`docs/migraciones.md:18`;
  `migration-numbering.spec.ts:9-10`), lo que importa si alguien cuenta archivos.

---

## 4. Qué se sostiene del fondo

- El esquema es inglés en su carta (`enums.ts:38-44`) y en su mayoría; las 5 tablas y ~117
  columnas castellanas están bien localizadas y bien clasificadas (norma vs. casa).
- Los costes relativos de §4 son correctos en su orden: renombrar tablas/columnas compuestas
  es barato (RLS por descubrimiento en `rls-policies.sql:25-27`, 0 referencias en vistas, 0 en
  RLS: ambos re-verificados); renombrar valores persistidos es caro; los nombres de migración no
  se tocan (`migrate.ts:93-95` sólo `filename`).
- La fuga a la CLI (`bank-command.ts:1775` `--type cheque-en-circulacion`) y el patrón R8 de
  traducir en superficie (`prepaid-command.ts:94`) son reales.
- La recomendación de congelar el vocabulario del SAT/IMSS/DIOT como estable es defendible;
  pero la lista de «vocabulario estable» de §6 debe incorporar `account_roles.role` (§3.1) y
  los 11 `as const` (§3.4), y la recomendación sobre el panel (§6.4) debe decir que las cadenas
  ya están en filas por inquilino (§3.2).

---

## 5. Anotaciones

- Ningún archivo leído contenía instrucciones dirigidas al agente. `pending-catalog.ts:65-69`
  contiene un comentario que narra una decisión de producto; se leyó como dato.
- El árbol es compartido y está en una rama distinta de la del snapshot de sesión; todas las
  cifras de este documento se tomaron el mismo día sobre `b31e62a` con las modificaciones sin
  comprometer descritas al inicio.
