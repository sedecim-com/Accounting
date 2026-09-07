# Activos fijos, pagos anticipados, intangibles, inventarios y deterioro · inventario verificado

> **Método.** El inventario original lo escribió un lector de código sobre `src/services/assets/`, `src/services/accruals/` y las tres tablas `inventory_*` de la migración 003, y lo verificó un escéptico independiente con la instrucción de refutar cada reclamo (abrió cada `archivo:línea`, buscó cada motor «ausente» bajo otro nombre, cada puerta en `src/cli`, `src/api` y `src/ai/tools`, y comprobó si cada «parámetro quemado» viene ya del panel o de `tax_tables`) contra HEAD `812a43c`. Esta fusión se cotejó contra HEAD `4b1d8fe` de `investigacion/normas-y-motores`; entre ambos commits no cambió ningún archivo de `src/`, `tests/` ni de los dos documentos citados (`git diff --stat 812a43c 4b1d8fe -- src tests docs/cli-command-catalog.md docs/plan-cierre-brechas.md` vacío), así que cada línea vale contra el HEAD actual.

Cada reclamo queda como el escéptico lo dejó: confirmado tal cual, corregido, o eliminado (y en §6 se dice qué se creía y por qué era falso). Las líneas de `asset-service.ts` son las corregidas: el original las contó con 2-7 líneas de deriva sobre el mismo commit (`b59d288`). Ninguno de los dos informes contenía instrucciones dirigidas al lector; nada se ejecutó fuera de lectura.

**Vocabulario de estado.** `completo`: existe, tiene puerta y hace lo que dice. `parcial`: existe con huecos nombrados. `inerte`: el motor existe pero no tiene puerta, o la tiene y no escribe. `ausente`: no hay motor bajo ningún nombre (se buscó por grep antes de afirmarlo).
**Vocabulario de parámetro.** `ley`: debería estar en tabla con vigencia (`tax_tables`/`tax_parameters`). `panel`: criterio del despacho en `pending-catalog.ts` con lector real. `casa`: constante del motor que no es tasa, tabla ni umbral. `quemado`: ley o criterio escrito en código, que es lo que hay que mover.

Resumen: nueve motores; ninguno `completo`, cuatro `parcial` (alta, aritmética, corrida, anticipados), uno `inerte` (siembra de categorías LISR, sin un solo llamador), cuatro `ausente` (inventarios, intangibles, deterioro, baja). Todos los que existen tienen semántica mexicana y ninguno consulta la jurisdicción.

---

## 0. Cómo ve la jurisdicción este subsistema

No la ve. `grep -rn esContabilidadMexicana src/` devuelve la definición (`src/services/accounting/pais-contable.ts:35`) y un solo consumidor real, `src/services/accounting/entity-accounting.ts:5,75,172` (siembra de catálogo, roles y nómina; `chart-seed.ts:156` y `payroll-account-mapping-seed.ts:252` sólo lo citan en comentarios). Ningún archivo de `src/services/assets/` ni `src/services/accruals/` lo importa.

Lo único que distingue MX de US en el subsistema es:

1. **El esquema admite vocabulario de las dos jurisdicciones para cualquier entidad**: el CHECK de métodos de `fixed_assets` incluye `macrs` (`src/database/migrations/003_banking_assets_inventory.sql:160-163`) y el de `inventory_items` incluye `'lifo'` (`003:231-232`; enum espejo `src/types/index.ts:171-176`). UEPS está prohibido en México (NIF C-4; LISR art. 41) y el CHECK no lo sabe.
2. **Las ocho políticas del panel que este subsistema lee llevan vocabulario mexicano** y se aplican a toda entidad: `base_depreciacion` (`src/services/policy/pending-catalog.ts:104`, opciones `vida_util_nif`/`tasa_lisr`, sin `macrs`), `convencion_primer_mes` (`:132`, `mes_completo` justificada por «LISR counts whole months», `:141`), `depreciacion_faltante_al_cierre` (`:160`), `umbral_capitalizacion_mxn` (`:186`, «Most common threshold in Mexican practice», `:198`), `lleva_inventarios` (`:250`), `amortizacion_anticipados_convencion` (`:403`), `amortizacion_faltante_al_cierre` (`:428`), `umbral_anticipado_mxn` (`:451`, opciones «5,000 MXN»/«20,000 MXN», `:451-464`). Ninguna tiene dimensión de moneda ni de país.
3. **La siembra de categorías es LISR** (`CATALOGO_LISR`, `src/services/assets/asset-service.ts:100-153`) y la función no recibe ni consulta país; hoy es hipotético porque no tiene llamador (§1.2).
4. **Ninguna tabla del subsistema tiene moneda**: `fixed_assets` (`003:145-195`) no la tiene y la 057 «la moneda en el origen» sólo toca `exchange_rates` (`057:26-54`); `prepaid_expenses` tampoco (`grep -n 'currency\|moneda' 059_*.sql` vacío). Los umbrales en MXN se comparan contra importes cuya moneda existe y sólo se imprime (`src/services/xml-ingestion/cfdi-decisions.ts:139` compara `f.subtotal >= t.capitalizationThreshold`; `f.moneda` aparece en `:112`, `:151` como texto).
5. **Las tablas legales que sí hay están en código, no en `tax_tables`**: los únicos consumidores TS de `tax_tables`/`tax_parameters` son de nómina (`payroll/tax-engine/tax-tables.ts`, `payroll/usa/local/local-tax-calculator.ts`, `backup/exportacion-inquilino.ts`, `ai/orphan-scan.ts`); `grep -rn 'tax_tables\|tax_parameters' src/ | grep -i 'deprec\|lisr\|macrs\|asset\|inpc'` → vacío. `tax_parameters` es JSONB por jurisdicción/año (`008_payroll.sql:375-382`): cabría, pero no hay fila.

Una entidad de Estados Unidos recibe hoy: umbrales en MXN, `base_depreciacion` sin opción MACRS, convención `mes_completo` justificada por la LISR, y, si alguien llegara a llamar a la siembra, categorías con vidas y fundamentos de la LISR.

---

## 1. Motores

### 1.1 Alta de activo fijo — `crearActivo` — **parcial**

**Archivo:** `src/services/assets/asset-service.ts:491-780`. Escritor único de `fixed_assets` (`:15`).
**Jurisdicción efectiva:** MX (semántica LISR/NIF). El esquema es multipaís por el CHECK de métodos (`003:160-163`) pero nada del alta distingue país.

#### Reglas implementadas

| Regla | Norma | Dónde |
|---|---|---|
| Costo > 0; salvamento ≥ 0 y estrictamente < costo (base depreciable nunca cero) | NIF C-6 (base depreciable = costo − valor residual); CHECKs `003:153`, `:156`, `:194` | `asset-service.ts:416-456` (`montosDelAlta`) |
| Vida útil: años = techo(meses/12), porque las tasas LISR no dan años enteros (30 % = 40 meses = 4 años) | LISR art. 34 fr. VII | `:359-404` (`vidaUtilCoherente`), `Math.ceil` en `:391` |
| Dos métodos por activo: contable (`book_depreciation_method`, NIF C-6) y fiscal (`tax_depreciation_method`, LISR 31-38). Cuál rige el gasto posteado lo decide la política `base_depreciacion` | NIF C-6 vs LISR 31 | `:545-554`; política `pending-catalog.ts:104-130`; vocabulario en CHECK `056:34-46` |
| Método fiscal por omisión línea recta, «porque el art. 31 aplica el por ciento sobre el MOI» | LISR art. 31 párr. 1 | `:550-553` |
| Convención del primer mes desde el panel (`mes_completo` → día 1 del mes de adquisición; `proporcional_dias` → día de compra) | LISR art. 31 párr. 5; NIF C-6 (desde que está disponible para uso) | `:467-469` (`inicioDeDepreciacion`), `:558-562`; política `pending-catalog.ts:132-158` |
| Arranque explícito anterior a la adquisición se rechaza; el derivado sí puede caer antes | — | `:568-576` |
| El alta NO postea; `contabilizacion` obligatoria sin defecto (`ya_contabilizado` / `sin_contabilizar`) porque el cargo puede venir de un CFDI ya capitalizado a la 1210 | Evita doble cargo bajo mayor inmutable (041) | `:278-285`, `:296`, aviso `:743-748` |
| Frontera de entidad DENTRO del SQL para categoría, tres cuentas (excluyendo encabezados) y proveedor | Serie TEN | `:508-520`, `:601-612`, `:629-634` |
| Folio `AF-<año>-<n>` por serie de entidad | — | `:639` |
| `tags` JSONB guarda contabilización y las dos políticas leídas | Deuda declarada: no hay columna | `:645-656` |
| Auditoría en la misma transacción | — | `:726-741` |

#### Reglas por definir

**MX**
- **MOI conforme a LISR art. 32 párr. 2** (precio + impuestos de importación + fletes + seguros + comisiones + honorarios, **IVA excluido**). `--cost <amount>` es «original cost of the investment (MOI), as a decimal» (`src/cli/asset-command.ts:281`); `DatosDeAlta.acquisition_cost: string` (`asset-service.ts:294`); `montosDelAlta` (`:416-456`) sólo valida numérico, finito, `> 0` y `salvamento < costo`. El catálogo declara `asset moi generate` ❌ (`docs/cli-command-catalog.md:1398`).
- **Topes del art. 36** ($175,000 MXN automóviles; $250,000 eléctricos/híbridos; aviones, casas habitación, comedores). `grep -rniI '175[,_.]\?000\|autom[oó]vil\|art\.\? \?36\b' src/` (fuera de `src/ai/docs`) → sólo el fundamento de la categoría (`asset-service.ts:133`).
- **Opción del art. 31 párr. 5** (iniciar la deducción en el ejercicio de uso o en el siguiente): sin campo en `DatosDeAlta` (`:287-316`), sin opción en `asset create` (`asset-command.ts:280-310`), sin clave en el panel (`pending-catalog.ts:50-1055`).
- **NIF C-6 párr. 44-46 (componentes)**: `fixed_assets` no tiene padre/hijo (`003:145-195`).
- **NIF C-6: revisión anual de vida útil, valor residual y método** (cambio de estimación prospectivo). No existe `asset edit`: `asset` sólo registra `create` (`asset-command.ts:246`, `:270`); `list`, `show`, `edit`, `category`, `disposal` son fase 2 (`:37-43`; catálogo `:1396` 🟡).
- **NIF C-6 / NIF D-6**: capitalización del RIF en activos calificables. Ausente.

**US**
- **`macrs_class` nunca se escribe**: `grep -rn macrs_class src/` → columna (`003:166`), tipo (`types/index.ts:674`, `depreciation-math.ts:83`), defecto `'5-year'` (`depreciation-math.ts:276`) y dos lectores (`depreciation.ts:327`, `depreciation-plan.ts:312`). El INSERT (`asset-service.ts:661-713`; lista de columnas `:661-682`) no la incluye, `DatosDeAlta` (`:287-316`) no la tiene y la CLI no ofrece `--macrs-class` (`asset-command.ts:280-310`). Consecuencia: todo activo `--method macrs` cae a `'5-year'` en silencio.
- **Umbral de capitalización en USD**: la política es `umbral_capitalizacion_mxn` (`pending-catalog.ts:186-199`, opciones 5 000/20 000/50 000). El equivalente US es el *de minimis safe harbor* de Treas. Reg. §1.263(a)-1(f) ($2,500 sin AFS / $5,000 con AFS). No existe dimensión de moneda ni de jurisdicción, y la comparación ignora `f.moneda` (`cfdi-decisions.ts:139`).
- **Defecto `STRAIGHT_LINE` contable y fiscal** (`asset-service.ts:549`, `:553`): para una entidad US el fiscal por omisión debería ser MACRS y no hay bifurcación por jurisdicción.
- **ASC 360-10-30**: costos directamente atribuibles capitalizables. Mismo hueco que el MOI.

**Ambas**
- **Sin moneda**: `fixed_assets` (`003:145-195`); la 056 sólo añade CHECKs de método y el CHECK posteada-con-asiento (`056:34-65`); la 057 sólo toca `exchange_rates` (`057:26-54`).
- **Sin baja** (§1.9): `disposal_date/amount/method`, `gain_loss_amount` (`003:183-186`) no tienen escritor.
- **`depreciation_method` congelado**: `metodoQueRige` se decide con el panel del día del alta (`asset-service.ts:554`) y se inserta en la columna NOT NULL (`:695`); la corrida relee el panel y elige `book_`/`tax_` (`depreciation.ts:231-234`), cayendo a `depreciation_method` sólo si la columna elegida es NULL. Si el despacho cambia `base_depreciacion`, la ficha queda desfasada; el importe posteado no.
- **`'1290'`/`'6140'` literales** (`asset-service.ts:96-98`, resueltos en `:187-205`): la siembra no consulta `account_roles` aunque los roles `depreciacion_acumulada`/`depreciacion_gasto` **existen** (`src/services/xml-ingestion/account-roles-seed.ts:253-254`; cuentas sembradas con rol `:177-192`; tipo `AccountRole` en `cfdi-taxonomy.ts:44`; consumidor `reporting/cash-flow-reconcile.ts:467`). El hueco es el lector, no el rol.

#### Parámetros

| Parámetro | Dónde | Clase |
|---|---|---|
| Códigos `'1290'`/`'6140'` en vez de roles | `asset-service.ts:96-98`, `:187-205` | quemado (criterio de cuenta; el rol ya existe) |
| Defecto `STRAIGHT_LINE` contable y fiscal | `:549`, `:553` | quemado (criterio por jurisdicción) |
| `umbral_capitalizacion_mxn` = 20 000 | `pending-catalog.ts:186-199`; `cfdi-decisions.ts:54` es el defecto declarado «only when evaluating without tenant context» (`:49-53`) e inyectado desde el panel por el único llamador de producción (`pre-registration-service.ts:764`, `:803-804`) | panel (falta dimensión moneda/jurisdicción) |
| `ACTIVO_FIJO_PREFIXES` | `cfdi-decisions.ts:99`, usado en `:140` | casa (claves `c_ClaveProdServ` del SAT; sólo aplica a CFDI) |
| Prefijo `'AF'` | `asset-service.ts:639` | casa (patrón de folios: `'JE'` `posting.ts:147`, `'BILL'` `bill-service.ts:344`, `'INV'` `invoice-service.ts:308`, `'CN'` `credit-note-service.ts:150`) |

#### Puerta
`mnemosine asset create` (`asset-command.ts:269-439`): `declareRisk` escritura, `agent: false`, escribe «fixed_assets + entity_sequences + audit_log; ninguna póliza» (`:315-319`). `--dry-run` ensaya el camino real y aborta la transacción (`:392-405`). `--book` declara y se contrasta con el panel, no elige (`asset-lookup.ts:162-186`). Sin REST, sin GraphQL, sin herramienta del agente.

---

### 1.2 Siembra de categorías con tasas LISR — `sembrarCategoriasDeActivo` — **inerte**

**Archivo:** `src/services/assets/asset-service.ts:174-252`; catálogo `CATALOGO_LISR` en `:100-153`.
**Estado:** inerte. Ambos informes lo llamaron «parcial»; con el vocabulario de la casa un motor sin puerta es inerte. `grep -rn sembrarCategoriasDeActivo src/` → definición `:174` y dos comentarios (`asset-lookup.ts:11`, `:63`). `entity-accounting.ts:3-10, 124-130` siembra catálogo, roles y nómina; nada de categorías. El propio código lo confiesa («hoy el sembrador no tiene ningún llamador y `asset category seed` es fase 2», `asset-lookup.ts:62-65`), y sin categorías no hay alta posible (`asset-lookup.ts:86-92`, mensaje de error al primer usuario).
**Jurisdicción:** MX.

#### Reglas implementadas

Seis especies en `CATALOGO_LISR` (`asset-service.ts:100-153`): Edificios y Construcciones 5 % (LISR 34 fr. I-b, vida 20), Mobiliario y Equipo de Oficina 10 % (fr. III, 10), Equipo de Cómputo 30 % (fr. VII, 4 = techo de 3.33), Equipo de Transporte 25 % (fr. VI, 4; fundamento en `:133`), Maquinaria y Equipo 10 % (LISR 35 fr. XIV residual, 10), Herramientas/dados/troqueles 35 % (34 fr. VIII, 3 = techo de 2.86).

- Vida = techo(100/tasa) porque las tasas son **máximos** (`:59-66`; LISR 34 «por cientos máximos autorizados»).
- Método `'straight_line'` en las seis por LISR 31 (`:68-72`; literal en el INSERT `:231`).
- Idempotente por nombre; no pisa ajustes manuales (`:164-172`).
- Cuentas resueltas **por código literal**, acotadas por entidad y excluyendo encabezados (`:187-205`).
- Art. 35 por actividad deliberadamente no transcrito (`:74-80`).

#### Reglas por definir

**MX**
- Resto de las fracciones del art. 34 (I-a 3 % ferrocarriles; II 3 %/5 %/10 % pozos/vías; IV-V 6 %/7 %; IX-XIV: 100 % adaptaciones para discapacidad y energía renovable, 25 % bicicletas/motos eléctricas, 5 %/10 % infraestructura fija de telecomunicaciones, etc.); **art. 35 por actividad** (fr. I-XIII); **art. 33 intangibles** (5 % cargos diferidos, 10 % erogaciones preoperativas, 15 % regalías/asistencia técnica/gastos diferidos).
- **Agrupador Anexo 24** — reformulado por el escéptico: el Anexo 24 asigna `c_CodAgrup` **por cuenta** del catálogo, no por categoría de activo, y esa infraestructura **existe**: columna `accounts.mx_nif_code` (`001_core_schema.sql:130`), esquema `sat-agrupador` en `MAPPING_SCHEMES` (`src/services/accounting/account-service.ts:445-460`, `:455`), puerta `account map set|list|import|check --scheme sat-agrupador` (`src/cli/account-command.ts:187-211`, `:621`, `:742`). Las categorías llegan al agrupador vía `default_asset_account_id → accounts`. Lo que falta: que la siembra proponga los códigos 15x/171/172 para las cuentas que crea, un catálogo `c_CodAgrup` versionado, y resolver la **columna duplicada** (hallazgo nuevo): `accounts.codigo_agrupador_sat` de la 037 (`037_etiquetado_que_encarece.sql:21-31`) no tiene un solo escritor en TS (`grep -rn codigo_agrupador_sat src/ --include='*.ts'` → vacío) mientras `mx_nif_code` sí lo tiene.

**US**
- No existe un juego de categorías con **clase MACRS (3/5/7/10/15/20 años, 27.5, 39), vida GDS/ADS y convención** por categoría. `asset_categories` no tiene columna de clase MACRS (`003:126-143`).

**Ambas**
- La siembra no consulta `esContabilidadMexicana`. Como hecho del código, una entidad US recibiría vidas y fundamentos LISR; en operación es hipotético porque **ninguna** entidad recibe categorías hoy.
- Las tasas no vienen de `tax_tables`/`tax_parameters` (§0.5).

#### Parámetros

| Parámetro | Dónde | Clase |
|---|---|---|
| `CATALOGO_LISR` entero (tasas arts. 34-35, vidas, fundamentos) | `asset-service.ts:100-153` | quemado (ley: cambia por reforma; la deducción inmediata las sustituye por decreto) |
| `'straight_line'` como método de categoría | `:231` | quemado (criterio LISR 31 por jurisdicción) |
| `'1290'`/`'6140'` | `:96-98` | quemado (ver §1.1) |

#### Puerta
Ninguna. `asset category seed|create|list|show|archive` son fase 2 (catálogo `:1373-1377`; `:1376` exige el agrupador).

---

### 1.3 Aritmética de la depreciación (seis métodos) — `calculateDepreciation` — **parcial**

**Archivo:** `src/services/assets/depreciation-math.ts` (puro, sin Postgres). Despachador `calculateDepreciation` en `:461-490`.
**Estado:** parcial. Completo para lo que declara; parcial frente a la norma fiscal de ambos países.
**Jurisdicción:** ambas (MACRS es US; los otros cinco son neutros).
**Pruebas:** `tests/services/assets/depreciation.spec.ts` (28 casos por `grep -cE '^\s*(it|test)\('`; el original decía 37).

#### Reglas implementadas

| Regla | Norma | Dónde |
|---|---|---|
| Línea recta: (costo − salvamento)/meses | NIF C-6 párr. 46; ASC 360-10-35-4; LISR 31 | `depreciation-math.ts:193-199` |
| Saldos decrecientes 150 %/200 % con cambio a línea recta cuando ésta da más | NIF C-6; ASC 360 | `:201-230`; factores en `:468-471` |
| Suma de dígitos anual repartida en doce | idem | `:232-253` (confiesa el resto con vidas fraccionarias, `:245-251`) |
| MACRS media anualidad (half-year), seis clases GDS 200 %/150 % DB, base = costo entero (ignora salvamento) | IRC §168(b), §168(d)(1); IRS Pub 946 Tabla A-1 | `:263-299`; tablas `:263-273` |
| Unidades de producción: gasto = base × unidades/capacidad, serie densa | NIF C-6 párr. 46 | `:301-340`; fuerza `'mes_completo'` (`:456`) |
| Convención del primer mes como corrimiento que conserva el total | LISR 31 párr. 5 vs prorrateo | `:354-374`; fracción cuenta el día de compra `:148-151` |
| Tapón del último renglón sobre lo redondeado: Σ posteado = base exacta | Integridad aritmética | `:389-426` |
| Índice = diferencia de meses de calendario | — | `:135-140` |
| Cuatro decimales (`DECIMAL(19,4)`) | — | `:42` |
| Metadatos del cálculo (método, base, convención, índice, políticas y si estaban definidas) | Trazabilidad | `:503-528` |

Los porcentajes de las seis tablas MACRS (3, 5, 7, 10, 15, 20 años) coinciden con IRS Pub 946 Tabla A-1 (half-year, GDS).

#### Reglas por definir

**MX**
- **Actualización por inflación (LISR art. 31 párr. 7)**: la deducción del ejercicio se multiplica por el factor INPC. `grep -rniI 'INPC\|factor de actualizaci' src/` → sólo `src/ai/docs/{niif-interpretaciones,niif-moneda-seguros-adopcion,nif-registro,niif-activos}.md` (documentación del agente); nada en `services/`, `cli/` ni migraciones. Sólo el catálogo lo menciona (`docs/cli-command-catalog.md:1456`; `cli-command-registry.md:232` propone un sustantivo `inpc`).
- **La tasa fiscal no gobierna la vida del calendario fiscal**: `tasa_lisr` «cambia el MÉTODO y el `schedule_type`, no la vida» (confesado en `depreciation.ts:224-233`); el calendario se reparte sobre `useful_life_months` igual que el contable.
- **Deducción del saldo pendiente al enajenar o dejar de ser útil (art. 31 párr. 6)**, actualizado. Ausente (no hay baja).
- **Deducción inmediata** por decreto: `grep -rniI 'deducci[oó]n inmediata\|est[ií]mulo fiscal' src/` (fuera de docs) → vacío.
- **Componentes (NIF C-6)** y **cambio de estimación** prospectivo: el motor recalcula toda la vida desde el alta; no hay «valor en libros al inicio del ejercicio / vida remanente».

**US**
- **Convenciones mid-quarter (§168(d)(3)) y mid-month (§168(d)(2), 27.5/39 años), ADS (§168(g)), §179, §168(k), §280F, año fiscal corto (§168(f)(5))**: `grep -rniI 'mid-quarter\|mid_month\|half-year\|section 179\|168(k)\|168(g)\|280F\|27\.5\|39-year\|bonus depreciation' src/` → sólo texto de preguntas del panel (`pending-catalog.ts:134`, `:405`). `MACRS_TABLES` sólo 3/5/7/10/15/20 (`:263-273`).
- **Calendario MACRS desalineado del ejercicio**: `serieMACRS` reparte el año 1 en 6 mensualidades desde el mes de entrada en servicio (`:290-296`); `armarCalendario` indexa desde `primerDiaDelMes(depreciation_start_date)` (`:393`). La convención half-year es por año fiscal: un activo comprado en octubre recibe los 6 meses del año 1 entre octubre y marzo, cuando fiscalmente el año 1 termina en diciembre. La suma de la vida es correcta; la imputación por ejercicio no.
- **Convención mexicana sobre la serie MACRS** (hallazgo nuevo): `calculateMACRS` pasa la serie por `armarCalendario` sin forzar convención (`:442-444`), y `armarCalendario:392` aplica `repartirPrimerMes` —la `proporcional_dias` del panel— también a la serie MACRS. Dos jurisdicciones mezcladas sobre el mismo calendario; compárese con `calculateUnitsOfProduction`, que sí fuerza `'mes_completo'` (`:456`).
- **Clase MACRS por omisión `'5-year'`** cuando la columna viene vacía (`:276`), en silencio; y la columna nunca se escribe (§1.1).

**Ambas**
- Suma de dígitos con vidas no enteras absorbe un resto que no es de redondeo (`:245-251`, confesado).

#### Parámetros

| Parámetro | Dónde | Clase |
|---|---|---|
| `MACRS_TABLES` | `depreciation-math.ts:263-273` | quemado (ley: tablas del IRS sin fila en `tax_tables`/`tax_parameters`) |
| Clase por omisión `'5-year'` | `:276` | quemado (clase legal elegida en código, en silencio) |
| Factores `1.5`/`2.0` | `:468-471` | casa (son la definición de `DECLINING_BALANCE_150`/`_200`; el factor **es** el método) |
| Convención por omisión `'mes_completo'` | `:391` | panel (fallback inalcanzable: los dos llamadores pasan `convencion: criterios.convencion` del panel —`depreciation.ts:328`, `depreciation-plan.ts:313`— y `criteriosDeLaCorrida` detiene con `ValidationError` ante vocabulario desconocido, `depreciation.ts:183-203`; `pending-catalog.ts:132-145`) |
| `DECIMALES = 4` | `:42` | casa (del esquema) |

#### Puerta
Indirecta: la invocan `depreciation.ts:330` y `depreciation-plan.ts:318`. `indiceDeCalendario`/`primerDiaDelMes` los reutilizan `amortization-math.ts:2-7`, `amortization-run.ts:8` y `prepaid-command.ts:11` («el sistema tiene UN calendario», `amortization-math.ts:42-50`).

---

### 1.4 Corrida mensual, plan y posteo de la depreciación — `runMonthlyDepreciation` — **parcial**

**Archivos:** `src/services/assets/depreciation.ts:257-481`; `depreciation-plan.ts:209-429` (`planDeDepreciacion`), `:471-549` (`leerPlanAprobado`), `:559-588` (`diferenciasContraPlan`); checklist `src/services/accounting/period-close.ts:413-446`.
**Estado:** parcial. Completo para lo que declara; un solo libro llega al mayor, sin reversa, sin baja, sin transición de estado.
**Jurisdicción:** MX por las políticas; el motor es neutro.

#### Reglas implementadas

| Regla | Norma / motivo | Dónde |
|---|---|---|
| Lee `base_depreciacion` y `convencion_primer_mes` una vez por corrida y DETIENE ante vocabulario desconocido | Decisión del despacho, no del código | `depreciation.ts:183-208` |
| Método por base (`tax_` con `tasa_lisr`, `book_` con `vida_util_nif`, fallback `depreciation_method`) | NIF C-6 vs LISR | `:231-234` |
| `schedule_type` = `'book'` o `'tax'` según base, fijado una vez por corrida | `003:209-210` | `depreciation.ts:268`; `depreciation-math.ts:65-68` |
| Freno de doble corrida: renglón posteado de cualquier libro o del mismo tipo cierra el mes | Mayor inmutable (041) | `depreciation.ts:277-306`; mismo predicado en el plan `depreciation-plan.ts:245-269` |
| Unidades de producción se omite (no hay de dónde leer la producción) | — | `depreciation.ts:309-315` |
| Índice negativo = aún no en servicio; fuera del arreglo = vida terminada (`if (!fila) continue;`); importe cero no se postea | — | `:337-344`, `:340` |
| Asiento `AUTO_DEPRECIATION` fechado el último día del periodo: Dr gasto / Cr acumulada, `sourceType 'depreciation'`, `autoPost` | Devengo de mes cerrado (NIF A-2 / ASC 360) | `:150-152`, `:363-386` |
| Fila con `journal_entry_id` y `calculation_metadata` SIEMPRE (CHECK `depreciacion_posteada_con_asiento`) | `056:63-65` | `:393-420` |
| Ficha del activo derivada de la SUMA de lo posteado | Meses fuera de orden | `:444-465` |
| Atestiguación tras commit | — | `:472` |
| Plan sin escribir: renglones, omitidos con motivo, pendientes, política de cierre, huella sha256 | Ensayo | `depreciation-plan.ts:61-151`, `:209-429` |
| La corrida se detiene si un activo que va a postear no resuelve sus cuentas contra el catálogo de la entidad | Frontera de entidad | `depreciation-plan.ts:347-397` |
| `post --file` compara pares (activo, importe) con Decimal | — | `depreciation-plan.ts:559-588` |
| `depreciacion_faltante_al_cierre` (`avisar`/`bloquear`) gobierna `run --strict` y `post`; leído en `depreciation-plan.ts:224` | Política `pending-catalog.ts:160-184` | `depreciation-command.ts:414-415` (`bloqueaElFaltante`), `:482`, `:564-571` |
| Idempotencia por llave con hash de (entidad, periodo, libro, huella) | — | `depreciation-command.ts:628-635` |

#### Reglas por definir

**Ambas**
- **Un solo libro llega al mayor y sólo ése se persiste**: `tipoDeCalendario` se fija una vez desde el panel (`depreciation.ts:268`) y es el único `schedule_type` insertado (`:410`); `--book` de la CLI sólo se «coteja contra el panel» (`depreciation-command.ts:441`). La política lo promete al revés: «Either way BOTH schedules can be computed; this decides which one reaches the ledger» (`pending-catalog.ts:111-112`) — promesa incumplida (hallazgo nuevo). Sin dos calendarios no hay conciliación contable-fiscal ni impuesto diferido (NIF D-4 / ASC 740); el catálogo lo delega a la familia fiscal (`docs/cli-command-catalog.md:1363`) pero la cédula que la alimentaría no se produce.
- **`status` nunca pasa a `'fully_depreciated'`**: el único `UPDATE fixed_assets` de `src/` (`depreciation.ts:445-449`) escribe `accumulated_depreciation`, `current_book_value`, `last_depreciation_date`, `updated_at`; `grep -rn fully_depreciated src/` → sólo CHECK (`003:182`), enums (`database/enums.ts:175`, `types/index.ts:168`). El plan lo exigía (`docs/plan-cierre-brechas.md:3864`). El checklist cuenta `status = 'active'` sin renglón posteado del periodo (`period-close.ts:419-427`): un activo agotado es «sin depreciar» para siempre y la casilla se vuelve insatisfacible. **Agravante** (hallazgo nuevo): el plan clasifica `'vida_terminada'` como **no** pendiente (`depreciation-plan.ts:67`, `:86-89`, `:283`, `:337`), así que `depreciation post` no bloquea y `close` avisa: plan y checklist se contradicen.
- **Reversa** (`depreciation reverse`): `depreciation-command.ts` sólo tiene `run` y `post` (`:431`, `:502`); las menciones a reversa son comentarios (`:61-80`, `:287`, `:595`); catálogo 🟡 (`:1417`). El freno `depreciation.ts:294-305` mira `is_posted`/`schedule_type` sin JOIN a reversas: reversar la póliza a mano deja el renglón posteado y el mes cerrado. `RENGLON_VIGENTE` sólo existe en `accruals/` (`prepaid-service.ts:109`; `amortization-run.ts:17, 236, 440`).
- **Unidades de producción sin captura** de producción del periodo (`depreciation.ts:309-315`).
- **Checklist con severidad literal y sin leer la política**: `period-close.ts:438` `severity: 'warning'`; `grep -n depreciacion_faltante_al_cierre period-close.ts` → vacío. El texto de la política promete exactamente eso: «Governs the “Depreciation calculated and posted” item on the close checklist … with “bloquear” it refuses until the run happens» (`pending-catalog.ts:163-167`). El bloqueo real vive en `depreciation-command.ts:414-415`, `:482`, `:564-571`: bloquea la corrida, no el cierre.

**MX**
- **Actualización INPC** por ejercicio (§1.3).
- **Agrupador Anexo 24** — reformulado: la póliza XML del Anexo 24 lleva `NumCta`/`DesCta`; el agrupador es atributo del catálogo de cuentas y ya tiene columna con escritor (`mx_nif_code`, §1.2). El faltante real es la cobertura de códigos 15x/171/172 en las cuentas de activo, verificable hoy con `account map check --scheme sat-agrupador` (`account-command.ts:209-211`, `:742`).

**US**
- **Form 4562** y libro fiscal MACRS por año fiscal: `grep -rniI '4562\|4797\|form 970' src/` → nada relevante (§1.3).

#### Parámetros

| Parámetro | Dónde | Clase |
|---|---|---|
| Descripciones de asiento en inglés (`'Monthly depreciation …'`) | `depreciation.ts:367`, `:373`, `:379` | casa (cosmético) |
| `JournalEntryType.AUTO_DEPRECIATION` | `:366` | casa (del núcleo) |
| `severity: 'warning'` de la casilla | `period-close.ts:438` | quemado (criterio que el panel dice gobernar y el código no lee) |

#### Puerta
- `mnemosine depreciation run --period --book --by --strict --format -o` (`depreciation-command.ts:431-500`): `risk: 'lectura'`, `agent: true` (`:452`).
- `mnemosine depreciation post --period --book --file --dry-run --yes --idempotency-key` (`:502-640`): `risk: 'irreversible'`, `agent: false`, escribe «journal_entries + journal_entry_lines (una póliza por activo), depreciation_schedules, fixed_assets» (`:517-521`).
- Cierre: item `depreciation-posted` (`period-close.ts:32`, `:52`, `:413-446`).
- Sin REST/GraphQL; sin herramienta del agente.
- **No hay** `tests/cli/depreciation-command.spec.ts` (`find -iname '*deprec*'` sólo devuelve el spec del servicio).

---

### 1.5 Pagos anticipados: alta, aritmética del devengo y corrida — `accruals/` — **parcial**

**Archivos:** `src/services/accruals/prepaid-service.ts:337` (`registrarPagoAnticipado`), `:572` (`huecoDeAnticipados`), `:652` (`revisionDeAmortizacionAlCierre`); `amortization-math.ts:239` (`calcularAmortizacion`); `amortization-run.ts:145` (`runMonthlyAmortization`). Esquema `059_la_promesa_que_se_devenga.sql:98-`, con `entity_id` propio y foráneas compuestas (`059:48-78`).
**Estado:** parcial. Completo para lo que declara (NIF); huecos frente a US, al cierre y en el clasificador CFDI.
**Jurisdicción:** MX (NIF A-2, A-4, umbral en MXN); aritmética neutra.
**Pruebas:** `tests/services/accruals/amortization-math.spec.ts` (31 casos; el original decía 36), `tests/cli/prepaid-command.spec.ts`, `tests/cli/prepaid-flujo.spec.ts`.

#### Reglas implementadas

| Regla | Norma | Dónde |
|---|---|---|
| Devengo por días cubiertos (`proporcional_dias`) o meses completos (`meses_completos`), como dos recortes de la misma ventana | NIF A-2 devengación | `amortization-math.ts:179-217` |
| Tapón del último renglón: Σ = importe exacto | — | `:239-307` |
| Días con ambos extremos incluidos, sin husos horarios | — | `:121-128` |
| Umbral de materialidad `umbral_anticipado_mxn` leído del panel (`getPolicy`, validado); por debajo se detiene salvo `--force --reason`, que deja rastro en notas | NIF A-4 | `prepaid-service.ts:250`, `:262-277`, `:337-367`; política `pending-catalog.ts:451-464` |
| Convención leída del panel en el alta, con detención ante vocabulario desconocido, y **congelada** en la fila (CHECK `059:137`; comentario `059:203`); la corrida relee el panel «PARA COMPARAR, NO PARA APLICAR» y anota si cambió | Mayor inmutable | `prepaid-service.ts:245-285`; `amortization-run.ts:158-170`; metadatos `amortization-math.ts:328-359` |
| Nunca carga la 1160: **adopta** un saldo ya posteado; con `origin = 'cfdi'` exige el asiento de origen (CHECK `059:32`) | Evita doble cargo | `prepaid-service.ts:15-33`, `:344-349` |
| Respaldo en la cuenta: la suma por devengar no puede superar el saldo posteado | — | `prepaid-service.ts:328-336`, `:489` |
| Freno de doble corrida por (anticipo, periodo) contando sólo renglones vigentes (asiento no reversado) | — | `amortization-run.ts:224-239`; `RENGLON_VIGENTE` `prepaid-service.ts:109` |
| Tope contra lo que queda en el mayor, anotado en la fila | — | `amortization-run.ts:274-295` |
| Asiento `ADJUSTING` Dr gasto / Cr 1160, último día del periodo, `sourceType 'prepaid_amortization'` | Ajuste de fin de mes | `:312-345` |
| Renglón anulado se retira antes de reponer; ficha derivada de la suma vigente; estado sube y baja (`'fully_amortized'`/`'active'`) | — | `:347-371`, `:407-449`, `:427-433`, `:470-471`; `prepaid-service.ts:785-796` |
| Hueco: saldo en 1160 sin calendario | — | `prepaid-service.ts:572` |
| Revisión al cierre con `amortizacion_faltante_al_cierre` | Política `pending-catalog.ts:428-455` | `prepaid-service.ts:652-657` |
| Frontera de entidad por `entity_id` propio | `059:48-78` | `amortization-run.ts:64-68` |

#### Reglas por definir

**Ambas**
- **La revisión al cierre no está enganchada al checklist**: `CLOSE_CHECK_ITEMS` (`period-close.ts:44-57`) no tiene anticipados; `grep -n 'prepaid\|anticipad\|amortiz' period-close.ts` → vacío. `revisionDeAmortizacionAlCierre` (`prepaid-service.ts:652`) tiene un solo llamador (`prepaid-command.ts:993`), que declara «su veredicto de bloqueo NO se usa aquí» (`:985-991`). La política promete «the checklist item goes red» (`pending-catalog.ts:428-437`) y hoy no hay item.
- **Umbral de anticipados quemado en el clasificador CFDI** (hallazgo nuevo, el más concreto del subsistema): en el alta el panel gobierna (`prepaid-service.ts:250`), pero la decisión `gasto_anticipado` del clasificador usa `t.prepaidThreshold ?? PREPAID_THRESHOLD_MXN` (`cfdi-decisions.ts:67`, `:91`, `:154`, `:195`) y el único llamador de producción **no inyecta `prepaidThreshold`**: `pre-registration-service.ts:803-808` pasa sólo `capitalizationThreshold`, `restaurantPolicy`, `iepsTreatment`, `inventoryPolicy`; `grep -rn prepaidThreshold src/` → sólo `cfdi-decisions.ts`. El despacho que fija `umbral_anticipado_mxn` en 20 000 sigue recibiendo la pregunta de devengo desde 5 000 al ingerir CFDI.
- **Sin moneda en `prepaid_expenses`** (`grep -n 'currency\|moneda' 059_*.sql` → vacío): una póliza en USD se devenga en la moneda que tenga la 1160.

**MX**
- **NIF C-5**: reclasificación circulante/no circulante (cobertura > 12 meses) y **pérdida** cuando el bien o servicio ya no se recibirá. Existe `status = 'cancelled'` (CHECK `059:173-174`) y ningún camino lo produce: los tres `UPDATE prepaid_expenses` sólo escriben `'fully_amortized'`/`'active'` (`amortization-run.ts:427-433`, `:470-471`; `prepaid-service.ts:785-796`); el resto son filtros `<> 'cancelled'` (`prepaid-service.ts:522, 599, 693, 757, 801`; `amortization-run.ts:385`).

**US**
- **Regla de los 12 meses** (Treas. Reg. §1.263(a)-4(f)): deducción fiscal inmediata del anticipo corto; libro y fiscal divergen. `grep -rniI '12.month\|1\.263(a)-4' src/` → nada; y sin libro fiscal (§1.4).
- **ASC 340-10**: en sustancia igual a lo implementado; sin diferencia de regla salvo moneda y umbral en MXN.

#### Parámetros

| Parámetro | Dónde | Clase |
|---|---|---|
| `PREPAID_THRESHOLD_MXN = 5_000` en el clasificador CFDI | `cfdi-decisions.ts:67`, `:91`, `:195`; llamador sin inyección `pre-registration-service.ts:803-808` | **quemado en producción** (el panel tiene la clave y el código no la llega a leer en esa vía) |
| `umbral_anticipado_mxn` en el alta | `pending-catalog.ts:451-464`; `prepaid-service.ts:250` | panel (falta dimensión moneda) |
| `'proporcional_dias'` por omisión | `amortization-math.ts:240`; `amortization-run.ts:170` | panel (la convención va congelada en la fila desde el alta; el fallback `:170` sólo sirve a la anotación comparativa; `pending-catalog.ts:403-418`) |
| Descripciones de asiento en inglés | `amortization-run.ts:326`, `:332`, `:338` | casa (cosmético) |

#### Puerta
- `mnemosine prepaid create --amount --start --end --origin cfdi|manual|saldo_preexistente --source-entry --convention --force --reason` (`prepaid-command.ts:623-830`): escritura, `agent: false`, «prepaid_expenses (la cabecera); ninguna póliza» (`:657-661`).
- `prepaid list`, `prepaid show` (`:835`, `:901`): lectura, `agent: true` (`:852`, `:907`).
- `prepaid run --period --dry-run --yes --idempotency-key` (`:954-1100`): irreversible, `agent: false`, escribe «journal_entries + journal_entry_lines, prepaid_amortization_schedules, prepaid_expenses» (`:963-969`).
- Clasificador CFDI: decisión `gasto_vs_anticipado` (`cfdi-decisions.ts:147-206`); rol `gasto_anticipado → 1160` (`account-roles-seed.ts:250`).
- Sin REST/GraphQL; sin herramienta del agente.

---

### 1.6 Costeo de inventarios — **ausente** (cascarón)

**Lo que hay:** sólo esquema y tipos. `003:225-276` (`inventory_items`, `inventory_layers`, `inventory_layer_consumption`); `src/types/index.ts:171-176` (`InventoryCostingMethod`), `:721-750` (`InventoryItem`, `InventoryLayer`); RLS por padre `src/database/rls-policies.sql:155-156`.
**Estado:** ausente. `ls src/services/` → no existe `inventory/`; `grep -rn 'costing.ts|calculateFIFO|calculateLIFO|consumeLayers|recordInventoryPurchase' src tests` → vacío. El módulo se borró en S0.4 (`docs/cli-command-catalog.md:122`; decisión D2 en `docs/plan-cierre-brechas.md:3603-3611`, `:3910-3927`). Las tres tablas fuera de la 003 sólo aparecen en `rls-policies.sql:155-156`, `038_entierro_s05.sql:28-29` y `src/plan/criterios.ts:635-637` (`RECLAMADAS`, con dueño: «el motor es neto nuevo»). Cero escritores, cero lectores.
**Jurisdicción:** ninguna.

#### Lo único implementado que toca inventarios
- CHECK `costing_method IN ('fifo','lifo','weighted_average','specific_identification')` (`003:231-232`) y el enum espejo (`types/index.ts:171-176`), **sin dimensión de jurisdicción**: `'lifo'` está permitido para cualquier entidad.
- Política `lleva_inventarios` (`perpetuos`/`directo`, defecto `directo`; `pending-catalog.ts:250-269`) leída en `pre-registration-service.ts:767` e inyectada al clasificador (`:807`), que sólo con `'perpetuos'` ofrece la opción `inventario` en `gasto_vs_activo` (`cfdi-classifier.ts:169-176`; `cfdi-decisions.ts:133`); rol `inventario → 1140` (`account-roles-seed.ts:251`; cuenta universal `chart-seed.ts:50`). Vista previa por movimientos en cuentas «%inventario%» (`policy-preview.ts:113-126`).
- Una compra puede llegar a la 1140 y **nada la saca de ahí**: `grep -rn "cogs\|'5100'\|cost_of_goods" src/services/ar src/services/accounting/posting.ts src/services/xml-ingestion/cfdi-posting-plan.ts` → vacío; `5100 Costo de Ventas` existe sólo como cuenta sembrada (`chart-seed.ts:73`). `invoice_lines.item_id UUID` sin `REFERENCES` (`002_ap_ar_schema.sql:95`, `:251`).

#### Reglas por definir

**MX (NIF C-4 · LISR 39-43 · RCFF 33-A)**
- Fórmulas permitidas: costos identificados, costos promedios, PEPS. **UEPS no está permitido** (NIF C-4 desde 2011; LISR art. 41: identificados, promedio, PEPS, detallista). El CHECK debe negar `'lifo'` bajo jurisdicción MX.
- Valuación al costo o valor neto de realización, el menor (NIF C-4) y estimación por obsolescencia/lento movimiento (catálogo `:1547-1548` ❌).
- Sistema de costeo absorbente (NIF C-4; LISR art. 39).
- Permanencia del método cinco ejercicios (LISR art. 41 párr. 2).
- Costo de lo vendido (LISR art. 39) y deducción de mercancía que pierde valor (art. 27 fr. XX / RLISR): destrucción/donación con aviso.
- **Kardex / auxiliar de almacén (RCFF art. 33 apartado B fr. XIII)**: fecha, documento, motivo, entradas, salidas, saldo y costo. El catálogo lo declara sin base (`docs/cli-command-catalog.md:1543`); no hay tabla de movimientos, almacén ni motivo (`:1341`).

**US (ASC 330 · IRC §471, §472, §263A)**
- Fórmulas: FIFO, **LIFO (permitido)**, promedio, identificación específica.
- Medición: lower of cost and NRV (ASU 2015-11) para FIFO/promedio; lower of cost or market para LIFO y detallista.
- LIFO: conformity rule §472(c), LIFO reserve, elección en Form 970, dollar-value LIFO.
- UNICAP §263A; castigos sin reversión (ASC 330-10-35-14).

**Ambas**
- Tabla de movimientos con documento y motivo; almacenes; COGS al facturar (enganche con AR); recepción por compra (enganche con AP/CFDI); conteos físicos y ajuste; recálculo retroactivo del promedio (catálogo `:1520`).

#### Parámetros

| Parámetro | Dónde | Clase |
|---|---|---|
| Vocabulario de métodos con `'lifo'` para toda entidad | `003:231-232`; `types/index.ts:171-176` | casa hoy; ley por definir (prohibición MX) |
| `lleva_inventarios` = `'directo'` | `pending-catalog.ts:250-269`; `cfdi-decisions.ts:90` es el defecto duplicado, inyectado desde el panel (`pre-registration-service.ts:767`, `:807`) | panel (sin motor detrás) |

#### Puerta
Ninguna. `item create` 🟡 sin servicio (catálogo `:1483`); toda la familia `inventory *` ❌ (`:1519-1548`). `grep -rn -i 'inventario|inventory' src/cli/*.ts` sólo devuelve comentarios de `backup-command.ts` y `riesgos-retrofit.ts` con otro sentido de la palabra. `tests/inventory` no existe.

---

### 1.7 Intangibles y su amortización — **ausente**

**Estado:** ausente. `grep -rln -i 'intangib|goodwill|crédito mercantil' src --include='*.ts'` → `src/ai/tools/docs-tools.ts:37` (índice de documentación IFRS, «NIC 38 intangibles») y `src/cli/account-command.ts:133` (ejemplo de ayuda `account create 1250 "Activo Intangible" --header`). Ambas son texto; ningún motor. Sin tabla, sin cuenta (`grep -n "'13[0-9][0-9]'" chart-seed.ts` → vacío; el 1200 «Activo Fijo» agrupa 1210/1220/1230/1290, `chart-seed.ts:51-55`; ni `ESTRATO_FISCAL_MX` (`:92`) ni `ESTRATO_FISCAL_NEUTRO` (`:123`) añaden intangibles), sin categoría art. 33 en `CATALOGO_LISR` (`asset-service.ts:100-153`).
**Jurisdicción:** ninguna.

#### Reglas que exige cada jurisdicción
**MX**
- **NIF C-8**: reconocimiento (identificable, control, beneficios futuros), amortización de vida definida por patrón de consumo (línea recta por omisión), vida indefinida sin amortizar y con prueba de deterioro anual (NIF C-15), investigación al resultado, desarrollo capitalizable bajo criterios.
- **LISR art. 32** (gastos diferidos, cargos diferidos, erogaciones preoperativas) y **art. 33**: 5 % cargos diferidos, 10 % erogaciones preoperativas, 15 % regalías/asistencia técnica/gastos diferidos; intangibles con vida limitada por contrato o ley, por ciento según su duración.
**US**
- **ASC 350-30** (finite-lived: amortización; indefinite-lived: prueba de deterioro), **ASC 350-20** goodwill (prueba anual; alternativa de compañía privada a 10 años, ASU 2014-02), **ASC 350-40** software de uso interno, **ASC 985-20** software para venta.
- **IRC §197**: intangibles adquiridos a 15 años línea recta (goodwill incluido); **§174** I+D (amortización obligatoria desde 2022; el tratamiento de los domésticos volvió a deducción inmediata por legislación de 2025 — verificar vigencia antes de codificar).

Reutilizable del subsistema actual: el calendario mensual, el tapón y el freno de doble corrida de `depreciation-math.ts`/`depreciation.ts`. No reutilizable: la base (los intangibles no tienen valor de salvamento típico) y el par de cuentas.

---

### 1.8 Deterioro de activos — **ausente**

**Estado:** ausente. `grep -rniI 'deterioro\|impairment\|valor de recuperaci\|recoverable\|C-15\|ASC 360\|lower of cost\|net realizable\|\bVNR\b\|obsolesc\|held.for.sale' src/` (fuera de `src/ai/docs`) → `docs-tools.ts:37` (índice) y tres usos de «recoverable» en otro sentido (`index.ts:273`, `vendor-service.ts:333`, `pending-catalog.ts:700`). `fixed_assets` sin columna de deterioro (`003:145-195`); `schedule_type` CHECK `('book','tax','projected')` sin «impairment» (`003:209-210`); `status` sin `held_for_sale` (`003:182`).
**Jurisdicción:** ninguna.

#### Reglas que exige cada jurisdicción
**MX**
- **NIF C-15**: indicios internos y externos; valor de recuperación = mayor entre valor de uso y precio neto de venta; pérdida cuando valor neto en libros > valor de recuperación; **reversión permitida** (excepto crédito mercantil); la depreciación posterior se recalcula sobre el nuevo valor.
- **NIF C-4**: castigo de inventarios al VNR. **NIF C-5**: pérdida en anticipados no recuperables.
- **LISR**: el deterioro contable no es deducible → diferencia temporal (NIF D-4).
**US**
- **ASC 360-10-35**: dos pasos para activos en uso (recuperabilidad con flujos no descontados; pérdida = valor en libros − valor razonable); **sin reversión**.
- **ASC 360-10-45**: mantenidos para la venta (cesa la depreciación; menor entre valor en libros y valor razonable menos costos de venta).
- **ASC 350-20/350-30** goodwill e intangibles de vida indefinida; **ASC 330-10-35** inventarios al NRV sin reversión.

---

### 1.9 Baja y enajenación de activos — **ausente**

**Estado:** ausente. Las columnas existen (`disposal_date`, `disposal_amount`, `disposal_method`, `gain_loss_amount`, `003:183-186`; `status` admite `'disposed'`, `:182`) y nadie las escribe: `grep -rn 'disposal_\|gain_loss\|disposed' src/` fuera de la 003 → enums (`database/enums.ts:175`, `types/index.ts:167`) y **un lector**, el flujo de efectivo (`reporting/cash-flow-reconcile.ts:543`, `fa.disposal_date BETWEEN`). El único `UPDATE fixed_assets` de `src/` es `depreciation.ts:445` y no toca `status`. `asset-command.ts:40-43` («`disposal`— es fase 2»); catálogo 🟡 (`docs/cli-command-catalog.md:1456`). `grep -rniI '§1245\|1245\|4797\|1231' src/` → nada relevante. Sin ruta REST/GraphQL ni herramienta del agente (`grep -rln 'fixed_assets\|crearActivo' src/api src/ai` → sólo `reports.ts`, en comentario).
**Jurisdicción:** ninguna.

#### Reglas que exige cada jurisdicción
**MX**
- **NIF C-6**: depreciar hasta la fecha de baja; utilidad/pérdida = contraprestación − valor neto en libros; dar de baja costo, depreciación acumulada y deterioro.
- **LISR art. 31 párr. 6**: al enajenar o dejar de ser útil, deducir la parte no deducida, **actualizada** (párr. 7); **art. 18 fr. IV**: ganancia por enajenación = ingreso − MOI pendiente actualizado; **art. 37**: pérdida por caso fortuito/fuerza mayor con opción de reinversión en 12 meses; **art. 38**: arrendamiento financiero.
- **LIVA**: la venta de activo fijo causa IVA; CFDI de venta (delegado a la familia CFDI, catálogo `:1363`).
**US**
- **ASC 360-10-40**: baja y ganancia/pérdida.
- **IRC §1245** (recaptura como ingreso ordinario), **§1250** (inmuebles), **§1231**, **Form 4797**; **§1031** sólo inmuebles tras TCJA.

---

## 2. Parámetros quemados consolidados

Tres clases, como las separó el escéptico: (a) defectos declarados del panel duplicados en código y gobernados por él en producción — el hueco es la dimensión moneda/jurisdicción de la clave, no el valor; (b) tablas y criterios legales en código sin fila en `tax_tables`/`tax_parameters`; (c) un quemado real en producción, donde el panel tiene la clave y una vía del código no la lee.

| Parámetro | Dónde | Clase | Qué falta |
|---|---|---|---|
| `CATALOGO_LISR` (tasas arts. 34-35, vidas, fundamentos) | `asset-service.ts:100-153` | **quemado** (ley) | Fila en `tax_tables`/`tax_parameters` con vigencia; resto de fracciones; art. 33; deducción inmediata |
| `MACRS_TABLES` (Pub 946 A-1) | `depreciation-math.ts:263-273` | **quemado** (ley) | Fila versionada por año/jurisdicción; tablas A-2..A-7a; ADS |
| Clase MACRS por omisión `'5-year'` | `depreciation-math.ts:276` | **quemado** | Que el alta escriba `macrs_class` y que la ausencia detenga en vez de elegir |
| Defecto `STRAIGHT_LINE` contable y fiscal | `asset-service.ts:549`, `:553` | **quemado** (criterio por jurisdicción) | Defecto fiscal por país (LISR 31 → línea recta; US → MACRS) |
| `'straight_line'` como método de categoría sembrada | `asset-service.ts:231` | **quemado** (criterio por jurisdicción) | idem |
| Códigos `'1290'`/`'6140'` | `asset-service.ts:96-98`, `:187-205` | **quemado** (criterio de cuenta) | Leer `account_roles` (`depreciacion_acumulada`/`depreciacion_gasto`, `account-roles-seed.ts:253-254`) |
| `PREPAID_THRESHOLD_MXN = 5_000` en el clasificador CFDI | `cfdi-decisions.ts:67`, `:91`, `:154`, `:195`; `pre-registration-service.ts:803-808` no inyecta `prepaidThreshold` | **quemado en producción** | Inyectar `umbral_anticipado_mxn` como ya se hace con `umbral_capitalizacion_mxn` (`:764`, `:803-804`) |
| `severity: 'warning'` de la casilla `depreciation-posted` | `period-close.ts:438` | **quemado** (criterio que el panel promete gobernar, `pending-catalog.ts:163-167`) | Leer `depreciacion_faltante_al_cierre` en el checklist |
| Vocabulario `'lifo'` / `'macrs'` sin jurisdicción | `003:160-163`, `:231-232`; `types/index.ts:171-176` | casa hoy; **ley por definir** | UEPS prohibido en MX (NIF C-4, LISR 41); MACRS sin sentido en MX |
| `umbral_capitalizacion_mxn` = 20 000 | `pending-catalog.ts:186-199`; defecto duplicado `cfdi-decisions.ts:54` | panel | Dimensión moneda/jurisdicción (US: *de minimis* $2,500/$5,000); comparar con `f.moneda` (`cfdi-decisions.ts:139`) |
| `umbral_anticipado_mxn` = 5 000 (alta) | `pending-catalog.ts:451-464`; `prepaid-service.ts:250` | panel | Dimensión moneda |
| `convencion_primer_mes` = `mes_completo` | `pending-catalog.ts:132-145`; fallback inalcanzable `depreciation-math.ts:391` | panel | Convenciones US (`half_year`/`mid_quarter`/`mid_month`) y que no se aplique sobre MACRS (`:392`, `:442-444`) |
| `amortizacion_anticipados_convencion` = `proporcional_dias` | `pending-catalog.ts:403-418`; `amortization-math.ts:240`; `amortization-run.ts:170` | panel | — (moneda) |
| `lleva_inventarios` = `directo` | `pending-catalog.ts:250-269`; duplicado `cfdi-decisions.ts:90` | panel | Motor de inventarios detrás |
| `ACTIVO_FIJO_PREFIXES` | `cfdi-decisions.ts:99` | casa | — (claves SAT; sólo CFDI) |
| Factores `1.5`/`2.0` | `depreciation-math.ts:468-471` | casa | — (definen el método) |
| Prefijo `'AF'` | `asset-service.ts:639` | casa | — (patrón de folios de la casa) |
| `DECIMALES = 4` | `depreciation-math.ts:42` | casa | — (esquema) |
| Descripciones de asiento en inglés | `depreciation.ts:367,373,379`; `amortization-run.ts:326,332,338` | casa | cosmético |
| `JournalEntryType.AUTO_DEPRECIATION` | `depreciation.ts:366` | casa | — |

Políticas que faltan para que las bifurcaciones existentes sean por jurisdicción (regla de la casa: no se elige en código, se declara en el panel con su lector): tercera opción fiscal US en `base_depreciacion` (`macrs`) o un panel por jurisdicción; convención US por clase de bien; umbrales de capitalización y anticipados **con moneda**; método de costeo permitido por jurisdicción; inicio de deducción fiscal MX (art. 31 párr. 5); actualización INPC sí/no (MX siempre sí; US nunca).

---

## 3. Lo que Estados Unidos exige y no existe

1. **MACRS completo**: convención **mid-quarter** (§168(d)(3), prueba del 40 %, Tablas A-2..A-5), **mid-month** para inmuebles (27.5/39 años, Tablas A-6/A-7a), **ADS** (§168(g)), año fiscal corto (§168(f)(5)), alineación del calendario al **año fiscal** (hoy `depreciation-math.ts:290-296` reparte desde el mes de entrada en servicio) y **sin la convención mexicana encima** (`repartirPrimerMes` se aplica a la serie MACRS: `:392`, `:442-444`). Sólo existe Tabla A-1 half-year.
2. **§179 expensing** y **§168(k) bonus depreciation** (elección por clase y límites anuales).
3. **De minimis safe harbor** §1.263(a)-1(f) ($2,500/$5,000) como umbral de capitalización en USD; **§280F** listed property / topes de automóviles.
4. **Clase MACRS y vidas GDS/ADS por categoría** (siembra US de `asset_categories`, sin columna hoy `003:126-143`) y escritura de `fixed_assets.macrs_class` desde el alta (`asset-service.ts:661-682` no la lista).
5. **Libro fiscal paralelo persistido** (book y tax el mismo mes) → diferencias temporales para **ASC 740** y **Form 4562**. La política dice que «BOTH schedules can be computed» (`pending-catalog.ts:111-112`); la corrida persiste uno (`depreciation.ts:268`, `:410`).
6. **Baja con recaptura** §1245/§1250/§1231 y Form 4797 (ASC 360-10-40 para el libro).
7. **Deterioro ASC 360-10-35** (dos pasos, sin reversión) y **held-for-sale ASC 360-10-45**.
8. **Intangibles**: ASC 350-30/350-20/350-40 en libros; **IRC §197** (15 años) y **§174** en fiscal.
9. **Inventarios ASC 330 / §471-472 / §263A**: FIFO, **LIFO permitido** con LIFO reserve, conformity rule y Form 970; lower of cost and NRV (no-LIFO) / lower of cost or market (LIFO y detallista); UNICAP.
10. **Prepaid, regla de los 12 meses** §1.263(a)-4(f) para la deducción fiscal del anticipo.
11. **Defecto fiscal por jurisdicción**: el método fiscal por omisión es línea recta para toda entidad (`asset-service.ts:553`); una entidad US debería caer a MACRS.

---

## 4. Lo que México exige y no existe

1. **Actualización por INPC** de la deducción anual de inversiones (LISR art. 31 párr. 7) y del saldo pendiente al enajenar (párr. 6). Sin factor de actualización ni tabla de INPC en `src/` (sólo documentación del agente en `src/ai/docs/`).
2. **Tasa máxima fiscal como dato del activo** que gobierne la vida del calendario `tax` (arts. 34-35 completos, con vigencia por ejercicio); hoy `tasa_lisr` no cambia la vida (`depreciation.ts:224-233`). Y la **deducción inmediata** por decreto como método fiscal alternativo.
3. **MOI conforme al art. 32** (componentes del costo, IVA excluido; `asset moi generate` ❌ en el catálogo `:1398`) y **opción de inicio de deducción** (art. 31 párr. 5).
4. **Topes del art. 36** (automóviles $175,000 / $250,000 eléctricos; aviones; casas habitación; comedores).
5. **Baja/enajenación**: utilidad o pérdida contable (NIF C-6), ganancia fiscal (art. 18 fr. IV), pérdida por caso fortuito (art. 37), reinversión, IVA de la venta y CFDI; transición de estado `disposed`/`fully_depreciated` (ninguna se escribe: `depreciation.ts:445-449`).
6. **Deterioro NIF C-15** (y VNR de inventarios NIF C-4, pérdida de anticipados NIF C-5; `status = 'cancelled'` de anticipados sin camino).
7. **Intangibles NIF C-8 + LISR art. 33** (5 %/10 %/15 % y por duración del contrato): tabla, cuentas 13xx y calendario.
8. **Inventarios NIF C-4 / LISR 39-43 / RCFF 33-A**: PEPS, promedio, identificados (**UEPS prohibido**; el CHECK `003:231-232` lo admite), costo o VNR el menor, costeo absorbente, permanencia del método (art. 41), costo de lo vendido, kardex, estimación por obsolescencia, destrucción/donación.
9. **Componentes NIF C-6** y **revisión anual** de vida útil/valor residual/método con efecto prospectivo (sin `asset edit`); **conciliación contable-fiscal e impuesto diferido NIF D-4** a partir de dos libros persistidos.
10. **Agrupador Anexo 24** — reformulado: cobertura de `accounts.mx_nif_code` (esquema `sat-agrupador`, `account map`, `account-service.ts:455`; `account-command.ts:187-211`) para las cuentas de activo fijo (15x/171/172), propuesta desde la siembra de categorías; catálogo `c_CodAgrup` versionado; y resolver la columna duplicada `codigo_agrupador_sat` (037) sin escritor. La columna y la puerta ya existen; la póliza del Anexo 24 no lleva agrupador.
11. **Siembra de categorías con puerta** (`asset category seed`): el motor existe (`asset-service.ts:174`) y nadie lo llama.
12. **Item de anticipados en el checklist de cierre** (la política `amortizacion_faltante_al_cierre` lo promete, `pending-catalog.ts:428-437`; `period-close.ts:44-57` no lo tiene) y reclasificación circulante/no circulante (NIF C-5).
13. **Reversa de la corrida** de depreciación con limpieza de `depreciation_schedules` y de la ficha (hoy sólo el hermano de anticipados la tolera vía `RENGLON_VIGENTE`).
14. **Casilla del cierre que lea `depreciacion_faltante_al_cierre`** (`period-close.ts:438` es `'warning'` literal) y que no cuente como pendiente al activo agotado (contradicción plan/checklist, §1.4).
15. **Umbral de anticipados del panel inyectado al clasificador CFDI** (`pre-registration-service.ts:803-808`).

---

## 5. Puertas

| Puerta | Qué hay | Evidencia |
|---|---|---|
| **CLI** | `asset create` (escritura, `agent: false`); `depreciation run` (lectura, `agent: true`), `depreciation post` (irreversible, `agent: false`); `prepaid create` (escritura, `agent: false`), `prepaid list|show` (lectura, `agent: true`), `prepaid run` (irreversible, `agent: false`). Fase 2 sin registrar: `asset list|show|edit|category|disposal`, `depreciation reverse`, `item *`, `inventory *`. | `asset-command.ts:269-439`, `:315-319`, `:37-43`, `:246`, `:270`; `depreciation-command.ts:431`, `:452`, `:502`, `:517-521`; `prepaid-command.ts:623`, `:657-661`, `:835`, `:852`, `:901`, `:907`, `:954`, `:963-969`; catálogo `:1373-1398`, `:1417`, `:1456`, `:1483`, `:1519-1548` |
| **Cierre** | Item `depreciation-posted` con severidad literal `'warning'`, sin leer la política. Ningún item de anticipados. | `period-close.ts:32`, `:52`, `:413-446`, `:438`; `CLOSE_CHECK_ITEMS` `:44-57` |
| **Clasificador CFDI** | Decisiones `gasto_vs_activo` (con opción `inventario` sólo bajo `perpetuos`) y `gasto_anticipado`; la segunda con umbral quemado. | `cfdi-decisions.ts:133`, `:139-140`, `:147-206`, `:195`; `cfdi-classifier.ts:169-176`; `pre-registration-service.ts:764-808` |
| **REST** | Ninguna. `grep -rn -i 'fixed_asset|depreciat|inventory|prepaid' src/api` → comentario en `reports.ts:231-240` (explica por qué se retiró `asset_disposals` del cuerpo) y la lista de tipos de asiento (`journal-entries.ts:58`). | `src/api/rest/routes/reports.ts:231-240` |
| **GraphQL** | Ninguna. Sólo el enum `AUTO_DEPRECIATION`. | `src/api/graphql/schemas/schema.ts:49` |
| **Agente** | Ninguna herramienta. `grep -rln -i 'fixed_asset|depreciat|inventory_|prepaid' src/ai` → `report-tools.ts:97` (texto descriptivo en un reporte) y `docs-tools.ts:37` (índice). Las hojas `agent: true` (`depreciation run`, `prepaid list|show`) son la única vía indirecta; el puente por el que el agente invoca hojas `agent: true` no se verificó. | `src/ai/tools/report-tools.ts:97`; `docs-tools.ts:37` |
| **Siembra** | `sembrarCategoriasDeActivo` sin llamador; `entity-accounting.ts` siembra catálogo, roles y nómina, no categorías. | `asset-service.ts:174`; `asset-lookup.ts:11`, `:62-65`, `:86-92`; `entity-accounting.ts:3-10`, `:124-130` |

---

## 6. Lo que el escéptico refutó o corrigió

Para que el lector sepa qué **no** creerse del inventario original:

**Refutado (eliminado o reclasificado)**
1. «`CAPITALIZATION_THRESHOLD_MXN = 20_000` es un quemado que elude el panel» — falso: es el defecto declarado para evaluar sin contexto de inquilino (`cfdi-decisions.ts:49-53`) y el único llamador de producción inyecta el panel (`pre-registration-service.ts:764`, `:803-804`). Reclasificado como `panel`; lo que se sostiene es la falta de dimensión moneda/jurisdicción.
2. «El prefijo `'AF'` es un parámetro» — falso: es el patrón de folios de toda la casa (`'JE'`, `'BILL'`, `'INV'`, `'CN'`). Reclasificado `casa`.
3. «Los factores `1.5`/`2.0` son parámetros» — falso: definen `DECLINING_BALANCE_150`/`_200`; el factor es el método. `casa`.
4. «`'mes_completo'` por omisión en `depreciation-math.ts:391` es un quemado» — falso: fallback inalcanzable desde producción; los dos llamadores pasan la convención del panel y la corrida detiene ante vocabulario desconocido. `panel`.
5. «`'proporcional_dias'` por omisión en `amortization-math.ts:240` / `amortization-run.ts:170` es un quemado» — falso: la convención va congelada en la fila desde el alta, leída del panel; el fallback sólo sirve a la anotación comparativa. `panel`.
6. «`inventoryPolicy: 'directo'` está quemado» — matiz: es el defecto del panel duplicado y el llamador inyecta el valor del panel. `panel`.
7. «`PREPAID_THRESHOLD_MXN = 5_000` está quemado» — **refutado en el alta** (el panel gobierna, `prepaid-service.ts:250`) y **confirmado en el clasificador CFDI** por otra razón: `pre-registration-service.ts:803-808` no inyecta `prepaidThreshold`. El original acertó por la razón equivocada.
8. «Los roles `depreciacion_acumulada`/`depreciacion_gasto` no existen» — falso: existen en `account-roles-seed.ts:253-254`. El hueco es que la siembra resuelve por código literal y no por rol.
9. «La cadena “agrupador” no aparece en `src/`» (tomado del catálogo `:1341`, `:1376`) — falso: `037_etiquetado_que_encarece.sql:21-31`, `account-command.ts:187-211, 621, 742`, `account-service.ts:445-460`. Además el Anexo 24 asigna el agrupador **por cuenta**, no por categoría ni en la póliza: las dos entradas «agrupador Anexo 24» de los motores 2 y 4 se reformularon.
10. «`pais-contable.ts` sólo lo consume `chart-seed.ts`» — falso: el consumidor real es `entity-accounting.ts:5,75,172`; `chart-seed.ts:156` sólo lo cita en un comentario. Sin efecto en la conclusión (nada de `assets/` ni `accruals/` lo importa).
11. «El flujo de efectivo lee `disposal_date` desde `api/rest/routes/reports.ts:309`» (atribución del catálogo `:1456` que el original arrastró) — falso: el lector es `reporting/cash-flow-reconcile.ts:543`; `reports.ts:231-240` sólo lo menciona en un comentario.

**Corregido (cita o conteo)**
12. Líneas de `asset-service.ts` con deriva de 2-7 (`crearActivo` `:491`, no `:498`; `sembrarCategoriasDeActivo` `:174`, no `:172`; `CATALOGO_LISR` `:100-153`; `DatosDeAlta` `:287-316`; INSERT `:661-713`; defectos `:549`/`:553`; folio `:639`; `'straight_line'` `:231`). El archivo tiene un solo commit (`b59d288`): se contó mal, no se leyó otra versión. Esta fusión corrigió además las que el escéptico no tocó (`montosDelAlta` `:416-456`, `vidaUtilCoherente` `:359-404`, `inicioDeDepreciacion` `:467-469`, frontera `:508-520`/`:601-612`/`:629-634`, tags `:645-656`, auditoría `:726-741`).
13. `ACTIVO_FIJO_PREFIXES` está en `cfdi-decisions.ts:99`, no `:72`. El CHECK `costo > salvamento` está en `003:194`, no `:176`; `schedule_type` en `003:209-210`, no `:207`; costeo en `003:231-232`; columnas de baja en `003:183-186`.
14. Conteo de pruebas: `depreciation.spec.ts` 28 (no 37), `asset-service.spec.ts` 51 (no ≈40), `amortization-math.spec.ts` 31 (no 36). Sin efecto.
15. «Única mención de intangibles: `docs-tools.ts:37`» — también `account-command.ts:133` (ejemplo de ayuda). Ambas texto.
16. Estado de la siembra de categorías: ambos informes decían `parcial`; con el vocabulario obligatorio un motor sin puerta es `inerte`.

**Hallazgos nuevos del escéptico (no estaban en el original)**
- Dos columnas para el mismo agrupador SAT: `accounts.mx_nif_code` con escritor (`account-service.ts:455`) y `accounts.codigo_agrupador_sat` (037) sin ninguno.
- `PREPAID_THRESHOLD_MXN` quemado en producción en el clasificador CFDI (`pre-registration-service.ts:803-808`).
- La convención mexicana del panel (`repartirPrimerMes`) se aplica sobre la serie MACRS (`depreciation-math.ts:392`, `:442-444`).
- El plan clasifica `'vida_terminada'` como no pendiente (`depreciation-plan.ts:86-89`, `:283`) mientras el checklist cuenta al activo agotado como sin depreciar: `post` no bloquea y `close` avisa para siempre.
- La política `base_depreciacion` promete «BOTH schedules can be computed» (`pending-catalog.ts:111-112`) y la corrida persiste un solo libro (`depreciation.ts:268`, `:410`).

---

## Anexo · Pruebas existentes

- `tests/services/assets/depreciation.spec.ts` (28 casos): índice de calendario, tapón, convención, fechas locales, los seis calculadores, suma de tablas MACRS = 100 %, metadatos.
- `tests/services/assets/asset-service.spec.ts` (51 casos): `vidaUtilCoherente`, `montosDelAlta`, `inicioDeDepreciacion`, frontera de entidad, validaciones, no-posteo, avisos, lectura del panel.
- `tests/services/accruals/amortization-math.spec.ts` (31 casos): días, ventanas, convenciones, tapón, vocabulario, metadatos.
- `tests/cli/asset-command.spec.ts`, `tests/cli/prepaid-command.spec.ts`, `tests/cli/prepaid-flujo.spec.ts`.
- **No hay** `tests/cli/depreciation-command.spec.ts`, ni prueba alguna de inventarios (`tests/inventory` no existe).
