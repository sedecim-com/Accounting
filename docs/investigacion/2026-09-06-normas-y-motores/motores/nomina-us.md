# Nómina de Estados Unidos — inventario verificado de motores

Alcance: `src/services/payroll/usa/`, `src/services/payroll/tax-engine/`, `src/services/payroll/common/paycheck-service.ts` (el orquestador que los une), `src/database/migrations/009_tax_tables_2026.sql` (la semilla de parámetros) y la única puerta, `src/api/rest/routes/payroll.ts`. 17 archivos, 2 004 líneas.

**Método.** Un lector de código escribió el inventario original sobre `812a43c`, y un escéptico independiente lo rehizo reclamo por reclamo sobre `bd148ec` con la instrucción de refutar: abrió cada `archivo:línea`, corrió `grep` sobre `src/`, `tests/`, `scripts/` y las migraciones para cada «ausente», «sin puerta» y «sin lector», y cotejó las cifras 2026 con las publicaciones del IRS. Este documento funde ambos contra HEAD `4b1d8fe`; `git log 812a43c..4b1d8fe -- src/services/payroll src/database/migrations src/api/rest/routes/payroll.ts` está vacío, así que todas las líneas citadas siguen vigentes.

**Convenciones.** Estado: `completo` | `parcial` | `inerte` (motor sin puerta, o con puerta que no escribe) | `ausente`. Parámetro: `ley` (debe vivir en tabla con vigencia) | `panel` (criterio del despacho, `pending-catalog.ts`) | `casa` (constante del motor) | `quemado` (ley o criterio escrito en código; es lo que hay que mover). **[norma]** marca una regla externa que el repositorio no contiene. **[externo, confirmado: N]** marca una cifra 2026 que el escéptico cotejó con la fuente N del final; **[externo, confirmar]** una que no pudo cotejar. **[nuevo]** marca un hallazgo del escéptico que el original no vio. Rutas abreviadas: `fica-calculator.ts`, `fit-calculator.ts`, `futa-calculator.ts` viven en `src/services/payroll/usa/federal/`; `state-tax-calculator.ts` en `usa/state/`; `local-tax-calculator.ts` en `usa/local/`; `form-941-generator.ts`, `form-940-generator.ts`, `w2-generator.ts`, `w3-generator.ts` en `usa/forms/`; `nacha-generator.ts` en `usa/`; `garnishment-engine.ts` en `usa/garnishments/`; `benefits-service.ts` en `usa/benefits/`; `tax-tables.ts`, `ytd-service.ts`, `tax-registry.ts`, `register-all.ts`, `tax-engine.interface.ts` en `tax-engine/`; `paycheck-service.ts`, `pay-run-service.ts`, `gl-posting-service.ts`, `employee-service.ts` en `common/`; `payroll.ts` es `src/api/rest/routes/payroll.ts`; `008`, `009`, `032` son las migraciones `008_payroll.sql`, `009_tax_tables_2026.sql`, `032_schema_contract.sql`. Cuando la tabla resumen de [`../motores-inventario.md`](../motores-inventario.md) §6 y este documento difieran en estado o cifra, éste es el detalle verificado. Ninguno de los dos informes fuente contenía instrucciones ejecutables; nada se cambió en el repositorio fuera de este archivo.

## 0. Cómo ve la jurisdicción este subsistema

- **Dos conmutadores de país.** `esContabilidadMexicana` (`src/services/jurisdiction/jurisdiction.ts:35-44`) decide el estrato contable de la **entidad**. La nómina no lo consulta: bifurca por `employees.country_code` (`'MX' | 'US'`, CHECK en `008:35`) en `paycheck-service.ts:153` (`if (emp.country_code === 'US')`) y `:236` (`else` → México); el embargo corre sólo si `country_code === 'US'` (`:287`); los formularios filtran `e.country_code = 'US'` (`form-941-generator.ts:71`, `form-940-generator.ts:58`, `nacha-generator.ts:68`). Una entidad mexicana puede tener empleados `US` que reciben FIT/FICA y un W-2.
- **La jurisdicción fiscal es una cadena.** `'US-FEDERAL'`, `'US-<ST>'`, `'US-<ST>-<CIUDAD>'` (`tax-engine.interface.ts:57`), resuelta con `employees.work_state` (`paycheck-service.ts:196`) y `work_city` recortado a tres letras (`:224-225`). `residence_state` (`008:56`) sólo lo lee el calculador local (`local-tax-calculator.ts:34`).
- **Los parámetros de ley son globales.** `tax_tables` (`008:354-372`) y `tax_parameters` (`008:376-382`) no tienen `tenant_id` ni `entity_id`; sólo tres migraciones tocan tablas de nómina (`008`, `009`, `032`; `grep -l "tax_parameters\|tax_tables\|tax_form_filings\|ALTER TABLE paychecks" src/database/migrations/*.sql`) y ninguna posterior añade columnas, `UNIQUE`, `tenant_id` ni siembras. Están excluidas de RLS a propósito como «reference data» (`src/database/rls-policies.sql:137-138`). Un parámetro **por patrón** (tasa de experiencia SUTA, reducción de crédito FUTA, calendario de depósito, número estatal) no tiene dónde vivir.
- **El panel no sabe de Estados Unidos.** Las 39 claves de `src/services/policy/pending-catalog.ts` no incluyen ninguna estadounidense (`grep -i "usd|_us|fmw|futa|suta|fica|401|w4|federal"` → sólo texto incidental). Las bifurcaciones de criterio que este subsistema deja quemadas (estado civil por defecto, tratamiento FICA de 401(k), clase de servicio NACHA, «kind of payer») deberían declararse allí con su lector, como hace el finiquito con `dias_aguinaldo` (`finiquito-calculator.ts:4, 98-105`).
- **Silencio-cero como patrón.** Tabla ausente → 0 (`tax-tables.ts:91-100`, `state-tax-calculator.ts:56-58`, `:125-126`, `local-tax-calculator.ts:61-62`); vocabulario desconocido → 0 (`filing_status` §1.4, tipo de embargo y `amount_type` §1.19); depósitos → 0 (§1.22). Los fallbacks numéricos en código (§2) convierten «año sin tabla» en «tabla de 2024». Un sistema fiscal debe distinguir «no aplica» de «no sé».
- **Registro.** `register-all.ts:27-60` (importado en `src/index.ts:47`) registra 6 calculadores MX, 7 federales US, 51×3 estatales (`:44-55`) y 4 locales (`:58-60`). Registrar 51 SDI/SIT no significa tenerlos: sin filas en `tax_parameters`/`tax_tables` el calculador devuelve 0.
- **Pruebas.** Con spec propio: FICA (`tests/payroll/usa/fica.spec.ts`, 8 casos, con `getTaxParameters` **mockeado** a 168 600 en `:3-19`: pasa aunque la tabla no exista o esté mal), embargos (`garnishments.spec.ts`, 8, base mockeada), beneficios (`benefits.spec.ts`, 5), SUTA-YTD (`suta-ytd.spec.ts`, 4), `applyBrackets`/`periodsPerYear`/`cappedTaxableWages` (`tests/payroll/tax-engine/tax-tables.spec.ts`, 10 casos; el original decía 11). Ningún spec importa `fit-calculator|futa-calculator|state-tax-calculator|local-tax-calculator|form-941|form-940|w2-generator|w3-generator|nacha-generator|paycheck-service` (`grep -rln` en `tests/` → sólo `integration/helpers/sql-scan.ts` y `api/routes/withdrawn-endpoints.spec.ts`, que no los ejercitan). Ninguna prueba compara un valor sembrado con una publicación oficial (`docs/auditorias/2026-09-01-integral-iii/SINTESIS-critico.md:98`).
- **Alcance documental.** `docs/SCOPE.md:53` decía que internacionalizar no estaba en el plan; la síntesis de la auditoría III (`SINTESIS-critico.md:88-92`) observa que la nómina US tiene más código y más pruebas que la mexicana sin que nadie haya hecho la pregunta de producto. El catálogo CLI ya planifica `w2 prepare/reconcile/check/file/send/correct`, `w3 prepare`, `tax-deposit create`, `garnishment record`, `pension-alimenticia record`, `isn calculate`, `ptu calculate/allocate/run` (`docs/cli-command-catalog.md:1664, 1674, 1777, 1789-1791, 1802-1808, 1830`).

## 1. Motores, uno por uno

Formato: **estado · jurisdicción · puerta** → implementa → por definir (marcado **MX** / **US** / **ambas**) → parámetros (clase hoy).

### 1.1 Infraestructura del tax-engine (`src/services/payroll/tax-engine/`)

**parcial · ambas · interna** (la consume el orquestador, §1.21).

Implementa:
- Contrato «un plugin por (jurisdicción, tipo de impuesto)»: `TaxInput` (`tax-engine.interface.ts:9-43`), `TaxOutput` (`:45-54`), `ITaxCalculator` (`:56-60`). `w4_data` con cajas 2c/3/4a/4b/4c (`:21-28`), `is_supplemental` (`:34`), campos MX (`:37-39`), `experience_rate` (`:42`).
- Registro `jurisdicción:tipo → calculador` (`tax-registry.ts:3-29`).
- Lectura de tablas: `getBrackets` (`tax-tables.ts:25-64`), `getTaxParameters` (`:66-82`), `applyBrackets` (`:88-103`), `periodsPerYear` (`:108-117`); caché de proceso en dos `Map` (`:18-19`) con `clearCache` (`:119-122`).

Por definir (**ambas**):
- `multiple_jobs_box`, `is_supplemental` y `experience_rate` existen en el contrato y **ningún motor ni el orquestador los honra** (§1.4, §1.9).
- `register` ignora duplicados en silencio (`tax-registry.ts:8`).
- SQL sin inquilino ni entidad: `getBrackets` filtra jurisdicción/tipo/año/estado civil/frecuencia (`tax-tables.ts:44-50`); `getTaxParameters` jurisdicción/año (`:75`).
- `applyBrackets([], x)`: el `for` no entra, `top` es `undefined` → `{tax: 0, rate: 0}` (`:91-100`). «No hay tabla» = «impuesto cero».
- Caché sin TTL; `clearCache` **no tiene llamador** (`grep -rn clearCache src/ tests/ scripts/` → sólo la definición). **[nuevo]** El resultado vacío también se cachea (`:62` guarda `[]`; `:80` guarda `{}`): sembrar una tabla después de la primera consulta no surte efecto hasta reiniciar el proceso.
- `tax_tables.effective_to` nunca se lee (`grep effective_to src/` → sólo `008:368`).

Parámetros: `casa` — `periodsPerYear` (`tax-tables.ts:108-117`; el original listaba «quincenal=24» como quemado y el escéptico lo sacó: 24 periodos es definición, no criterio). `ley` — todo lo que llega por `tax_parameters`/`tax_tables`, sin fuente ni vigencia efectiva (§1.3).

### 1.2 Servicio YTD (`tax-engine/ytd-service.ts`)

**parcial · ambas · interna.**

Implementa: `getEmployeeYtd` (`:60-138`), `getEmployeeSutaYtd` (`:147-167`), `cappedTaxableWages` (`:173-180`), acumulados del ejercicio desde `paychecks` (fuente autoritativa), sólo corridas `calculated/approved/paid` (`:107`).

Por definir (**US**):
- `pretax_401k`/`employer_401k` siempre 0 (`:134-135`).
- El YTD por estado para SUTA filtra por `employees.work_state` **actual** (`:158-161`); `paychecks` no guarda estado (`008:200-262`): el comentario `:141-146` promete lo que el SQL no hace. Un traslado a mitad de año recomputa mal el tope.
- `suta_taxable_wages` del snapshot es el FUTA agregado (`:121`).
- **[nuevo]** Ambas consultas excluyen cheques con `pp.pay_date < $3` estricto (`:108`, `:163`) y el orquestador pasa la `pay_date` del periodo actual (`paycheck-service.ts:135`, `:206-208`). Una segunda corrida con la misma fecha de pago (bono `off_cycle`, corrección) no ve la primera: tope SS, umbral de Additional Medicare y topes FUTA/SUTA se calculan como si el cheque anterior no existiera.

Parámetros: `casa` — lista de estatus admitidos (`:107`).

### 1.3 Tablas fiscales 2026 (`src/database/migrations/009_tax_tables_2026.sql`) — el motor de parámetros

**parcial · US (y MX) · sin puerta** (sólo la migración escribe; no hay comando ni ruta que siembre o corrija).

Lo que hay:
- Una sola migración siembra todo (`grep -l tax_parameters src/database/migrations/*.sql` → sólo `008` y `009`). Su cabecera lo confiesa: «Values are best estimates for 2026 … official IRS/SAT publications override these if they differ» (`009:3-5`). Ninguna fila cita fuente ni edición; `effective_from` existe (`008:367`) y ninguna fila usa `effective_to`.
- `US-FEDERAL` 2026 (`009:13-34`): `ss_wage_base` 168 600, tasas 6.2/1.45/0.9 %, umbral adicional 200 000/250 000, FUTA 7 000 y 6.0/0.6 %, `401k_limit` 23 500, `401k_catchup_age50` 7 500, `hsa_limit_self/family` 4 400/8 750, `fsa_medical_limit` 3 300, `standard_deduction_*` 15 000/30 000/22 500.
- FIT anual por tres estados civiles (`009:114-144`): `single`, `married_jointly`, `head_of_household`. **Sin tabla `married_separately`** (el comentario `009:113`, «Single / Married filing separately (standard)», muestra que se pretendía que MFS compartiera la de `single`; el código nunca hace ese mapeo, §1.4) ni tablas «Step 2 Checkbox».
- `US-CA` (`009:71-80`): SDI 1.1 %, `sdi_wage_base: null`, SUTA 3.4 %/7 000, ETT 0.1 %, `pit_low_income_exempt`; PIT sólo `single` (`009:200-209`). `US-NY` (`009:83-91`): SDI 0.5 % con `sdi_weekly_max 0.60`, SUTA 4.1 %/12 800, `pfl_rate`, `pfl_annual_cap`; PIT sólo `single`, «abbreviated» (`009:215-224`). `US-TX`, `US-FL` (`009:94-96`): sólo SUTA. `US-IL` (`009:99-105`): `flat_rate` 4.95 %, exención personal, SUTA.
- **Ninguna localidad** tiene fila (`grep "US-NY-NYC\|US-PA-PHI\|US-NY-YON\|US-CA-SF" src/database/` vacío). 51 − 5 = 46 estados sin fila alguna.

Contra la publicación oficial (cotejado por el escéptico):
- **Tope SS, tres sitios, tres valores, los tres incorrectos**: 168 600 en la semilla (`009:15`), 168 600 en el fallback del motor (`fica-calculator.ts:18`, `:99`; comentario «$168,600 in 2026 est.» `:7`), 183 600 en el W-2 (`w2-generator.ts:104`). La Pub 15 (2026) dice **184 500** **[externo, confirmado: 1]**. 168 600 fue 2024 y 176 100 fue 2025 (ambos en `w2-generator.ts:104`).
- 401(k) 23 500 / 7 500 (`009:26-27`) son de 2025; 2026 es **24 500 / 8 000**, y 11 250 para 60-63 años **[externo, confirmado: 2]**.
- Deducción estándar 15 000 / 30 000 / 22 500 (`009:31-33`) es 2025; 2026 es **16 100 / 32 200 / 24 150**; FSA médica **3 400** (`009:30` trae 3 300) **[externo, confirmado: 3]**. HSA 4 400 / 8 750 (`009:28-29`) coinciden con lo publicado.
- **[nuevo]** Las tablas FIT sembradas no son las de 2026: la Pub 15-T (2026) fija la banda 0 % del método STANDARD anual en **7 500** (single/MFS) y **19 300** (MFJ) **[externo, confirmado: 4]**; la semilla trae 6 300 y 16 300 (`009:115`, `:126`). 16 300 es la banda MFJ de 2024 (29 200 − 12 900); 6 300 no corresponde a ningún año (2024 = 6 000; 2025 = 6 400). El ancho del tramo del 10 % single (17 400 − 6 300 = 11 100, `009:116`) tampoco es el de ningún ejercicio (2024 = 11 600; 2025 = 11 925; 2026 = 12 400, fuente 3). El original decía que las tablas «no se pueden cotejar porque la migración no cita edición»; el escéptico las cotejó: no cuadran.
- **Coherencia interna**: los límites de beneficios están en la semilla (`009:26-30`) sin lector y quemados otra vez en `benefits-service.ts:178-180` con **otros** valores para HSA (4 300 frente a 4 400) y FSA (3 200 frente a 3 300); el comentario `benefits-service.ts:8-9` mezcla años.

Claves sembradas que nadie lee (`grep -rn <clave> src/ tests/`, excluyendo `009` → 0 para todas): **17** — `additional_medicare_threshold_mfj`, `futa_rate_gross`, `401k_limit`, `401k_catchup_age50`, `hsa_limit_self`, `hsa_limit_family`, `fsa_medical_limit`, `standard_deduction_single`, `standard_deduction_mfj`, `standard_deduction_hoh`, `sdi_wage_base`, `ett_rate`, `ett_wage_base`, `pit_low_income_exempt`, `sdi_weekly_max`, `pfl_rate`, `pfl_annual_cap` (el original agrupaba `standard_deduction_*` y contaba 16). Los únicos lectores de `params.*` en US son `fica-calculator.ts:18-19, 42, 63, 65, 99-100, 119`, `futa-calculator.ts:19, 21`, `state-tax-calculator.ts:37-39, 91-92, 124` y `local-tax-calculator.ts:43-44`. La semilla promete un motor que no existe (ETT, PFL, tope semanal SDI, deducción estándar).

Sin prueba de frescura: ningún spec compara con una publicación (`SINTESIS-critico.md:98`).

Parámetros: `ley` — todo el archivo, indexado por año sin vigencia real ni procedencia.

### 1.4 FIT — retención federal (`usa/federal/fit-calculator.ts:9-67`)

**parcial · US · REST `POST /pay-runs/:id/calculate`** (`paycheck-service.ts:155-158`).

Implementa:
- Método porcentual anualizado del W-4 2020+ **[norma: IRC §3402; Pub 15-T, Worksheet 1A]**: anualiza por `periodsPerYear` (`:34-37`), suma 4a y resta 4b (`:41-46`), aplica la tabla anual por estado civil (`:48-49`), resta el crédito de la caja 3 y divide por periodos (`:51-52`), suma 4c por periodo (`:55-56`). Estado civil por defecto `single` (`:33`).
- Salario suplementario a tasa fija 22 % / 37 % sobre 1 M **[norma: Reg. §31.3402(g)-1; Pub 15 §7]** (`:20-31`).

Por definir (**US**):
- **Paso 1g/1h del Worksheet 1A**: la Pub 15-T (2026) instruye «enter $12,900 if … married filing jointly or $8,600 otherwise» cuando la caja 2c no está marcada **[externo, confirmado: 4]**. El código anualiza, suma 4a, resta 4b y aplica la tabla (`:37-49`) sin restar 1g; las tablas sembradas son del tipo STANDARD (banda 0 %), que presuponen el paso 1g ya aplicado. Sobre-retención estructural de 8 600 × tasa marginal al año.
- **Caja 2c (múltiples empleos)**: exige las tablas «Step 2, Checkbox» **[norma: Pub 15-T]**; no están sembradas, el código declara «no adjustment» (`:39`) y `multiple_jobs_box` sólo aparece en `tax-engine.interface.ts:23` y el comentario `008:54`.
- **`married_separately` y cualquier `filing_status` no validado → FIT 0 en silencio**: sin tabla (`009:114-144`) `getBrackets` devuelve `[]`, `applyBrackets` devuelve 0 y el FIT queda en sólo la caja 4c (`:51-56`). Y no es sólo MFS: `w4_data` entra por REST como `z.record(z.unknown())` (`payroll.ts:67`), `employee-service.ts:94` lo persiste tal cual y nadie valida el vocabulario (`grep "married_jointly\|head_of_household\|married_separately" src/` fuera de la interfaz y las migraciones → vacío). Cualquier valor que no sea exacto produce FIT = 0.
- **W-4 anterior a 2020** (allowances; Worksheet 1A líneas 1j-1l) y **extranjero no residente** (importe adicional del Paso 1, Notice 1392) **[norma: Pub 15-T]**: sin campo en `w4_data` (`tax-engine.interface.ts:21-28`).
- **Exento de FIT**: `employees.is_exempt_fit` existe (`008:58`) y nadie lo lee (`grep -rn is_exempt_fit src/ tests/` → sólo `008:58`).
- **Suplementario inalcanzable**: `baseTaxInput` (`paycheck-service.ts:141-151`) no lleva `is_supplemental`; la llamada FIT (`:156`) tampoco; la bandera de la percepción (`:26`) sólo se persiste (`:372`). Además `ytd_wages` = `ytd.gross_wages` (`:156`), no el acumulado suplementario que exige el umbral de 1 M (`fit-calculator.ts:21-22`) **[norma: Reg. §31.3402(g)-1(a)(2)]**.
- Método de tabla de salarios (Wage Bracket) y redondeo al dólar entero (opcional): no existen; aceptable en un sistema automatizado.

Parámetros: `quemado` — 0.22, 0.37 y 1 000 000 (`:22`; es ley, debe ir a `tax_parameters` US-FEDERAL); `'single'` como estado civil por defecto (`:33`; es criterio, debe ir al panel o convertirse en rechazo si falta W-4). `casa` — `'annual'` como frecuencia de tabla (`:48`).

### 1.5 FICA Seguro Social, trabajador y patrón (`usa/federal/fica-calculator.ts:11-33`, `:92-110`)

**completo (aritmética) · US · REST calculate** (`paycheck-service.ts:161-169`).

Implementa: 6.2 % hasta el tope anual con corte exacto por YTD vía `cappedTaxableWages` (`:18-22`, `:101`; `ytd-service.ts:173-180`) **[norma: IRC §3101(a), §3111(a), §3121(a)(1)]**; patrón espejo (`:99-101`). La base FICA excluye plan §125 pero no los diferimientos 401(k) **[norma: IRC §3121(v)(1)(A)]** (`paycheck-service.ts:123-126`). Probado en `fica.spec.ts:33-52, 81-86`, con la tabla mockeada (§0).

Por definir (**US**): exentos (`is_exempt_fica`, `is_statutory_employee` en `008:59-60`, sin lector; `grep` → sólo la migración) **[norma: IRC §3121(b)(10) estudiantes, §3121(b)(19) visas F/J/M/Q]**; propinas y salario en especie **[norma: §3121(q), §3102(c)]**; tope común entre patrones sucesores **[norma: §3121(a)(1); Reg. §31.3121(a)(1)-1(b)]**.

Parámetros: `quemado` — fallbacks 168 600 y 0.062 (`:18-19`, `:99-100`) y el comentario `:7`. Son «valores de respaldo si la fila no existe», pero convierten «año sin fila» en «tope de 2024». `ley` — la fila `009:15`, también equivocada (168 600 frente a 184 500 publicado, §1.3).

### 1.6 Medicare, trabajador y patrón (`fica-calculator.ts:35-53`, `:112-128`)

**completo · US · REST calculate** (`paycheck-service.ts:172-180`). 1.45 % sin tope **[norma: IRC §3101(b)(1), §3111(b)]**. Probado (`fica.spec.ts:53-59`).

Parámetros: `quemado` — fallback 0.0145 (`:42`, `:119`). `ley` — `009`.

### 1.7 Additional Medicare 0.9 % (`fica-calculator.ts:56-89`)

**completo · US · REST calculate** (`paycheck-service.ts:183-186`). Retención sobre el exceso de 200 000 con cálculo de cruce YTD (`:70-77`); umbral fijo para el patrón sin importar el estado civil (`:64-68`), que es lo que exige IRC §3102(f)(1) **[norma: §3101(b)(2)]**: no leer `additional_medicare_threshold_mfj` (`009:22`) es correcto. Probado (`fica.spec.ts:61-79`).

Parámetros: `quemado` — fallbacks 0.009 y 200 000 (`:63`, `:65`).

### 1.8 FUTA (`usa/federal/futa-calculator.ts:12-35`)

**parcial · US · REST calculate** (`paycheck-service.ts:189-192`).

Implementa: 0.6 % neto sobre los primeros 7 000 con corte YTD **[norma: IRC §3301, §3306(b)(1), §3302(a)-(b)]** (`:19-24`). Base = base FICA (`paycheck-service.ts:127`).

Por definir (**US**):
- **Reducción de crédito por estado** **[norma: IRC §3302(c)(2); Form 940 Schedule A]**: el motor asume «state credit applies» (`:20-21`); `futa_rate_gross` sembrado no se lee. Los estados con préstamo federal impago **[externo, confirmar por año]** pagan más y el sistema no lo sabe.
- **Percepciones exentas de FUTA** **[norma: §3306(b)(2)-(19)]**: la línea 4 del 940 es 0 fijo (§1.14).
- **Depósito trimestral cuando el pasivo supera 500 USD** **[norma: Reg. §31.6302(c)-3]**: sin motor de depósitos (§1.22).
- Patrón sucesor y crédito del 90 % por pago tardío al estado **[norma: §3302(a)(3)]**.

Parámetros: `quemado` — 7 000 y 0.006 (`:19`, `:21`); la nota `FUTA net 0.6%` (`:32`).

### 1.9 SUTA por estado (`usa/state/state-tax-calculator.ts:80-107`)

**parcial · US (51 registrados, 5 con datos) · REST calculate** (`paycheck-service.ts:203-212`).

Implementa: tope salarial por estado con YTD por estado (`getEmployeeSutaYtd`) y tasa de experiencia si llega (`:89-96`) **[norma: leyes estatales de seguro de desempleo; IRC §3304]**.

Por definir (**US**):
- **Tasa de experiencia por patrón**: `experience_rate` sólo existe en `tax-engine.interface.ts:42` y en `state-tax-calculator.ts:89, 92`; el orquestador no la pasa (`paycheck-service.ts:141-151`, `:209`). El comentario «Per-tenant experience rate» (`:77`) promete lo que nadie entrega. Siempre se usa `suta_default_rate` del estado o 0.027 (`:92`). Es un parámetro **por patrón y estado** que no tiene dónde vivir (§0).
- **Topes reales de 46 estados**: sólo CA, NY, TX, FL, IL tienen fila (`009:75-78, 87-88, 95-96, 103-104`); el resto cae al fallback 7 000 / 2.7 % (`:91-92`).
- **Aportación del trabajador** en AK, NJ, PA **[norma: estatal]**: el calculador es sólo patronal (`:88-106`).
- **Cuotas paralelas**: CA ETT sembrado (`009:76-77`) sin lector; NJ Workforce/SWF, etc.
- YTD por `work_state` actual (§1.2) **[norma: tope por estado; transferencia de salario entre estados sólo con acuerdo]**.
- Base SUTA = `taxableFuta` (`paycheck-service.ts:209`, `:127`): varios estados tratan §125/401(k) distinto **[norma: estatal]**.

Parámetros: `quemado` — 7 000 y 0.027 (`:91-92`).

### 1.10 SIT — retención estatal (`state-tax-calculator.ts:14-73`)

**parcial · US (51 registrados; 3 con datos y sólo para `single`) · REST calculate** (`paycheck-service.ts:197-202`).

Implementa: tres patrones — sin impuesto (conjunto quemado `:12`, 9 jurisdicciones), tasa plana con exención personal anualizada (`:37-51`), progresiva anual por estado civil (`:53-72`) **[norma: códigos fiscales estatales]**.

Por definir (**US**):
- **Silencio-cero**: estado con impuesto y sin fila → `brackets.length === 0` → 0 (`:56-58`). Son 51 registrados − 9 sin impuesto − 3 con datos (CA, NY, IL) = **39 jurisdicciones** (38 estados + DC; el original decía 38). En CA y NY, además, todo estado civil distinto de `single` (`009:200-224`).
- **Formularios estatales de retención** (DE-4, IT-2104…) y allowances/deducción estándar estatal: el motor reutiliza `w4_data.filing_status` federal (`:54`).
- **Reciprocidad** **[norma: acuerdos bilaterales, p. ej. PA-NJ, IL-IA-KY-MI-WI]**: `residence_state` se guarda (`008:56`) y el SIT se calcula siempre por `work_state` (`paycheck-service.ts:195-199`).
- Tasa suplementaria estatal; retención de no residentes por asignación de días; umbral de bajo ingreso de CA (`pit_low_income_exempt` sembrado sin lector).
- Base estatal = base FIT (`paycheck-service.ts:128`); PA y NJ gravan los diferimientos 401(k) **[norma: estatal]**.
- NH y WA están en la lista «sin impuesto» (`:12`), correcto para salarios; WA tiene PFML y WA Cares sobre nómina (§1.11).

Parámetros: `quemado` — `NO_INCOME_TAX_STATES` (`:12`; es ley: `has_income_tax` en `tax_parameters`); `'single'` por defecto (`:54`).

### 1.11 SDI y permisos pagados estatales (`state-tax-calculator.ts:113-138`)

**parcial · US (registrado en 51; datos en CA y NY) · REST calculate** (`paycheck-service.ts:213-220`).

Implementa: `tasa × salario` sin tope (`:124-129`).

Por definir (**US**):
- **Tope semanal de NY DBL (0.60 USD/semana)** **[norma: NY WCL §209]**: sembrado como `sdi_weekly_max` (`009:86`) y el motor lo ignora → sobre-retención en NY.
- **Tope salarial**: `sdi_wage_base` sembrado sin lector. CA eliminó el tope en 2024 **[externo, confirmar]**; NJ, RI, HI lo tienen.
- **NY PFL**: `pfl_rate`, `pfl_annual_cap` sembrados (`009:89-90`) sin lector **[norma: NY WCL Art. 9]**.
- **NJ TDI/FLI, RI TDI, HI TDI, WA PFML (RCW 50A) y WA Cares (RCW 50B), MA PFML, CO FAMLI, OR Paid Leave, CT PFML, DC PFL, MN, DE, MD** (patronal y/o del trabajador): sin fila y sin motor. El comentario dice «CA, NY, NJ, RI, HI» (`:110`); hay datos sólo para CA y NY (`009:73`, `:85`).
- El importe se persiste en `sdi_withheld` (`paycheck-service.ts:332, 355`) y en el mayor va a `state_tax_payable` junto al SIT (`gl-posting-service.ts:138`): no existe cubeta propia.

Parámetros: ninguno quemado; todo llega por `tax_parameters` (`ley`). El problema es el inverso: parámetros sembrados sin motor que los lea.

### 1.12 Impuestos locales (`usa/local/local-tax-calculator.ts:16-83`)

**inerte · US · REST calculate** (`paycheck-service.ts:222-234`): el motor corre, ninguna localidad tiene datos, y lo que calcula no se escribe en ningún sitio.

Implementa: residente/no residente por comparación de `residence_state` con el estado de la jurisdicción (`:32-37`), tasa plana residente/no residente (`:42-56`), progresiva anual (`:58-73`) **[norma: NYC Admin. Code §11-1701 y NY Tax Law Art. 30; Yonkers Tax Law Art. 30-A; Philadelphia Code §19-1500]**. Cuatro localidades registradas (`:78-83`).

Por definir (**US**):
- **Ninguna localidad tiene parámetros ni tabla** (§1.3) → siempre 0.
- **Resolución de la localidad**: `work_city.toUpperCase().slice(0,3)` (`paycheck-service.ts:224-225`): «New York» → `US-NY-NEW` ≠ `US-NY-NYC`; «San Francisco» → `US-CA-SAN` ≠ `US-CA-SF`. Sólo `PHI` y `YON` casan con `US_LOCALITIES` (`:78-83`). Hace falta un catálogo de localidades por código.
- **El importe no se persiste**: `breakdown.local` se calcula (`:229-231`) pero el `INSERT` en `paychecks` (`paycheck-service.ts:326-336`) no lista `local_tax_withheld` (`grep local_tax_withheld src/` → `008:227` y el lector `w2-generator.ts:93`) → W-2 caja 19 siempre 0. Sin cubeta `local_tax_payable` en `US_BUCKET_MAP` (`src/services/payroll/common/payroll-account-mapping-seed.ts:205-216`) ni en `gl-posting-service.ts:134-149`; sólo el comentario `008:512`.
- **[nuevo]** Si un local diera > 0, `employeeTaxes` lo incluye (`paycheck-service.ts:231`) y baja el neto, pero ninguna columna ni cubeta lo acredita: el asiento quedaría descuadrado por ese importe y `postPayRunToGL` lanzaría «Payroll GL entry unbalanced» (`gl-posting-service.ts:152-158`). Hoy no ocurre sólo porque siempre es 0.
- **Residencia**: NYC grava por residencia **en la ciudad**; la comparación `residence_state === 'NY'` (`:33-34`) grava a todo residente del estado que trabaje en la ciudad.
- **Universo local faltante** **[norma]**: Pensilvania Act 32 EIT y LST; Ohio ORC Ch. 718 (municipios y JEDD); Indiana condado (IC 6-3.6); Maryland condado (Tax-Gen §10-103); Kentucky y Alabama licencias ocupacionales; Michigan City Income Tax Act; Missouri (Kansas City, St. Louis 1 %); Oregon transit (ORS 320.550) y TriMet/Lane; Denver, Aurora OPT; Newark, Jersey City patronales. «SF Payroll Expense» (`:82`) es un impuesto patronal, no retención, y su vigencia debe revisarse **[externo, confirmar]**.

Parámetros: `quemado` — `US_LOCALITIES` y `residentOnly` (`:78-83`), `'single'` por defecto (`:59`), el recorte a tres letras (`paycheck-service.ts:224`).

### 1.13 Formulario 941 (`usa/forms/form-941-generator.ts:35-121`)

**parcial · US · REST `POST /form-941`** (`payroll.ts:299-304`).

Implementa: agregación trimestral por `pay_date` **[norma: IRC §6011; Reg. §31.6011(a)-1; Form 941]** de las líneas 1, 2, 3, 5a, 5c, 5d, 6, 12, 13, 14, 15 (`:51-72`, `:83-112`); sólo corridas `approved/paid` (`:68`); persiste en `tax_form_filings` como `'ready'` (`:114-118`).

Por definir (**US**):
- **Línea 13 (depósitos) siempre 0**: lee `employer_tax_liabilities` con `deposited_at` (`:63-66`) y nadie escribe esa tabla (§1.22). Línea 14 = total del trimestre, siempre.
- **Línea 1**: la regla es «empleados con salario en el periodo de pago que incluye el 12 de marzo/junio/septiembre/diciembre» **[norma: instrucciones 941]**; el código hace `COUNT(DISTINCT employee_id)` del trimestre (`:52`).
- **Línea 5b (propinas)** ausente; **5d** suma la base FICA **entera** de cualquier cheque con retención adicional (`:61`), no el exceso sobre 200 000.
- **Líneas 7-9 (ajustes) y 11 (créditos)**: línea 12 := línea 6 (`:107-108`).
- **Línea 16 / Schedule B**: calendario mensual o quincenal por lookback y regla del día siguiente sobre 100 000 **[norma: Reg. §31.6302-1]**: no existe (§1.22).
- Schedule R, 941-X **[norma: §6205, §6413]**, 943/944/945, 941-SS/PR: no existen. El W-3 asume «941» (`w3-generator.ts:79`).
- Sin CLI ni 8879-EMP; la transmisión está retirada con 501 (`payroll.ts:412-426`).

Parámetros: `quemado` — lista de `tax_type` que cuentan como depósito (`:65`; debería ser vocabulario en `enums.ts`). `casa` — `'ready'` (`:116`).

### 1.14 Formulario 940 (`usa/forms/form-940-generator.ts:23-104`)

**parcial · US · REST `POST /form-940`** (`payroll.ts:307-312`).

Implementa: líneas 3, 5, 7, 8, 12-15 y pasivo trimestral (Parte 5) desde `paychecks.futa` **[norma: IRC §6011; Form 940]** (`:38-59`, `:77-95`).

Por definir (**US**): línea 4 (pagos exentos) = 0 fijo (`:81`) **[norma: §3306(b)]**; línea 5 se aproxima como `total − gravable` (`:72`), mezclando exentos con exceso de 7 000; **líneas 9-11 y Schedule A** (reducción de crédito, multiestatal) **[norma: §3302(c)]**; línea 13 depósitos siempre 0 (`:51-53`, misma causa que el 941); 940 enmendado; la casilla **«Type of Return»** (enmendado, patrón sucesor, sin pagos, final). El original llamaba a este hueco «Kind of payer», que es la casilla b del W-3 (`w3-generator.ts:11, 79`); el hueco existe, con el nombre corregido.

Parámetros: `casa` — `'ready'` (`:99`).

### 1.15 W-2 (`usa/forms/w2-generator.ts:39-157`)

**parcial · US · REST `POST /w2`** (`payroll.ts:291-296`); lectura por el empleado `GET /me/w2/:tax_year` (`:458-473`).

Implementa: cajas 1-6 desde `paychecks` (`:80-99`) **[norma: IRC §6051; Reg. §31.6051-1; Instrucciones W-2/W-3]**; caja 3 topada por año (`:104-106`); caja 12 códigos D, W, DD (`:108-111`); caja 14 SDI (`:113-114`); cajas 15-20 (`:137-142`); persiste con `ON CONFLICT DO NOTHING` (`:149-153`). Consulta `legal_entities` (`:64`) con las columnas de dirección que añadió `032:20-25` (el catálogo `docs/cli-command-catalog.md:1802` dice `FROM entities`: está desfasado).

Por definir (**US**):
- **Tope SS quemado y distinto al de `tax_parameters`**: `ssCapByYear` `{2024: 168600, 2025: 176100, 2026: 183600}` con fallback 168 600 (`:104-105`), frente a 168 600 en `009:15` y a 184 500 publicado **[externo, confirmado: 1]**. Tres verdades para la caja 3.
- **`ON CONFLICT DO NOTHING` sin destino**: `tax_form_filings` (`008:482-501`) sólo tiene índices no únicos (`008:500-501`) y `032:30-31` sólo añade `provider` → regenerar duplica filas y el W-3 suma `COUNT(*)`/`SUM` de todas (`w3-generator.ts:51-67`).
- **SSN en claro dentro de `tax_form_filings.data`**: se descifra (`:124`) y se persiste en JSON (`:149-153`). El catálogo ya avisa «materializa SSN de toda la plantilla» (`cli-command-catalog.md:1802`).
- **Caja 12 W** bajo el alias `employer_hsa` consulta `deduction_type = 'hsa' AND NOT is_employer_contribution` (`:88`), es decir la aportación del **trabajador**; el código W exige patronal más trabajador vía §125 **[norma: Instrucciones W-2]**. Faltan AA (Roth 401k, tipo que existe en `benefits-service.ts:12`), C (GTL > 50 000), E/G/BB.
- **Caja 13** (statutory employee, retirement plan, third-party sick pay): sin cálculo; `is_statutory_employee` (`008:60`) sin lector.
- **Cajas 7, 8, 10, 11**: ausentes (10 = DCFSA, tipo que existe).
- **Caja 18** = `taxable_wages_state` (`:92`); **19** = `local_tax_withheld`, columna que nunca se escribe (`:93`; §1.12).
- **Caja 15**: sin número de identificación estatal del patrón; **multiestado** no cabe en un solo registro.
- Plazo 31 de enero **[norma: §6071(c)]**, entrega electrónica con consentimiento **[norma: Reg. §31.6051-1(j)]**, W-2c/W-3c: sin motor (catálogo `:1806-1807`).

Parámetros: `quemado` — `ssCapByYear` (`:104`), fallback 168 600 (`:105`). `casa` — etiquetas de códigos 12/14 (`:109-114`), `'ready'` (`:151`).

### 1.16 W-3 y archivo EFW2 (`usa/forms/w3-generator.ts:31-106`, `:112-179`)

**parcial · US · REST `POST /w3`, `POST /efw2`** (`payroll.ts:323-335`).

Implementa: totales W-3 desde los W-2 persistidos (`:51-67`) **[norma: IRC §6051(d); Form W-3]**; archivo EFW2 con registros RA, RE, RW, RT, RF de 512 caracteres (`:125-176`) **[norma: SSA EFW2 Pub 42-007]**.

Por definir (**US**):
- `kind_of_payer` fijo `'941'` (`:79`); cajas 7, 8, 10, 11, 14 fijas en 0 (`:87-90`, `:92`).
- Registros **RS** (estatal, obligatorio para reportar SIT), RO/RU (opcionales), RV (totales estatales): ausentes. El propio archivo se declara «Simplified — real EFW2 has many more record types» (`:109-111`).
- **[nuevo]** El RW está **desalineado**, no sólo «sin validar»: el código coloca el primer importe tras 2+9+15+15+20+4+22+22+2+5+5+23 = **144** caracteres (`:150-154`); la especificación sitúa «Wages, Tips and Other Compensation» en las posiciones 188-198, porque antes van ciudad (22), estado (2), ZIP (5), extensión ZIP (4), blanco (5), estado extranjero (23), postal extranjero (15) y país (2). El código omite ciudad, extensión ZIP, postal extranjero y país: 43 caracteres. La suma del código está verificada; las posiciones de la especificación son conocimiento del oficio y la SSA devolvió 403 a la descarga de `26efw2.pdf` **[externo, confirmar]**.
- La duplicidad de W-2 (§1.15) infla `total_w2_count`; sin validación previa tipo AccuWage (catálogo `:1804`).

Parámetros: `quemado` — `'941'` (`:79`; perfil fiscal de la entidad). `casa` — anchos y rellenos de registro (`:126-172`), `'ready'` (`:101`).

### 1.17 1099-NEC / 1099-MISC

**ausente · US · sin puerta.**

Lo que existe (`grep -rn 1099 src --include='*.ts'` fuera de migraciones): la bandera `vendors.is_1099_vendor` con CRUD y filtro (`src/services/ap/vendor-service.ts:225-227, 256-258, 396, 414, 420`; `src/api/rest/routes/vendors.ts:46`; `src/types/index.ts:400`), el filtro CLI (`src/cli/vendor-command.ts:177, 260, 331`), la herramienta de búsqueda del agente (`src/ai/tools/search-tools.ts:111, 133`), el `salary_type 'contractor_1099'` (`employee-service.ts:22`; `008:64-65`) que la ruta REST no permite crear (`payroll.ts:68` sólo `salary|hourly`), y los comentarios `008:65, 486, 496`. No hay generador, agregación de pagos por proveedor, umbral, 1096 ni IRIS.

Reglas que exige **[norma]**: IRC §6041/§6041A y Reg. §1.6041-1; umbral de **2 000 USD** «for tax years beginning after 2025» **[externo, confirmado: 5]** (antes 600); NEC caja 1 y retención de respaldo 24 % **[IRC §3406]**; MISC (rentas, regalías, premios, abogados); Form 1096 y e-file obligatorio desde 10 informativas **[TD 9972]**; W-9/TIN matching; plazo 31 de enero (NEC).

### 1.18 NACHA — depósito directo (`usa/nacha-generator.ts:45-205`)

**parcial · US · REST `POST /nacha`** (`payroll.ts:315-320`).

Implementa: archivo PPD de 94 caracteres con encabezado de archivo (`:79-92`), encabezado de lote (`:95-108`), detalle 22/32 (`:117-149`), control de lote (`:153-164`), control de archivo (`:169-177`) y relleno a bloques de 10 (`:183-186`) **[norma: NACHA Operating Rules & Guidelines]**; sólo empleados US con banco y neto > 0 (`:65-70`); persiste lote `draft` con SHA-256 (`:191-196`).

Por definir (**US**):
- **Clase de servicio**: `'200'` (mixto) en lote y control (`:97`, `:155`) para un archivo sólo de créditos (`debitTotal = 0`, `:113`); debería ser `220` **[norma: NACHA]**.
- **Marcado de cheques**: `UPDATE paychecks … WHERE pay_run_id = $2 AND id IN (SELECT id FROM paychecks WHERE pay_run_id = $2 LIMIT $3)` (`:198-202`), sin `ORDER BY` ni los filtros `country_code = 'US' AND bank_account_encrypted IS NOT NULL AND net_pay > 0` que sí usó la generación (`:65-70`): cheques omitidos quedan marcados y cheques incluidos pueden no quedarlo.
- **Números de traza**: `padN(i + 1, 7)` sobre el índice de todas las filas, incluidas las omitidas por `continue` (`:119`, `:123-124`, `:143`) → huecos.
- `file_id_modifier` fijo `'A'` (`:75`) para más de un archivo al día; lote 1 (`:76`); prenotificación (`--prenote` en catálogo `:1636`), devoluciones R01-R85 y NOC, reversos, split a varias cuentas, addenda **[norma: NACHA]**.
- **[nuevo]** `direct_deposit_batches` sólo tiene el `INSERT` en `'draft'` (`:192-196`); `grep -rn direct_deposit_batches src/` no encuentra ningún `UPDATE`: el lote nunca cambia de estatus. Coherente con no transmitir, pero sin puerta para registrar el envío a mano.

Parámetros: `casa` — `'094'`, `'10'`, `'1'` (`:87-89`: tamaño de registro, factor de bloqueo y código de formato fijados por la propia regla NACHA) y `'PPD'` (`:101`, SEC correcto para nómina a cuentas de consumidor); el original los listaba como quemados y el escéptico lo refutó. `quemado` (datos de la entidad) — `'BANK'` como nombre del destino (`:90`, marcador de posición), `'PAYROLL'` (`:102`), el modificador `'A'` (`:75`), la clase `200→220` (`:97`, `:155`), el número de lote (`:76`): perfil bancario de la entidad.

### 1.19 Embargos — CCPA (`usa/garnishments/garnishment-engine.ts:52-149`)

**inerte · US (la tabla admite `pension_alimenticia` MX; el motor no corre para MX) · sin puerta de alta.** Se invoca desde el orquestador (`paycheck-service.ts:283-312`, llamada `:293`), pero `garnishments` no tiene `INSERT` en `src/`, `tests/` ni `scripts/` (`grep` vacío; `src/plan/criterios.ts:2405-2408` lo mide en rojo; catálogo `:1664`): ningún camino de ejecución produce un importe distinto de cero.

Implementa **[norma: CCPA Título III, 15 U.S.C. §1671-1677; 29 CFR Parte 870]**: tope de acreedor «menor de 25 % del disponible o exceso sobre 30 × salario mínimo federal semanal» (`:94-95`, `:126-133`) **[§1673(a); 29 CFR 870.10]**; topes de manutención 50/55/60/65 % (`:47-50`, `:114-121`) **[§1673(b)(2)]**; levy federal por importe exento (`:122-125`) **[IRC §6334(d); Pub 1494]**; AWG estudiantil 15 % (`:134-138`) **[20 U.S.C. §1095a; 31 U.S.C. §3720D]**; orden por `priority` (`:78`); equivalente semanal por frecuencia (`:38-45`). Disponible = bruto − impuestos del trabajador (`paycheck-service.ts:288`), que coincide con la definición legal **[§1672(b)]**. Probado en `garnishments.spec.ts` (8 casos, base mockeada).

Por definir (**US**, salvo el último punto):
- **Quiebra** topada como acreedor (`:126`); las órdenes de Cap. 13 están exentas del tope **[§1673(b)(1)(B)]**.
- **Vocabulario de tipos**: el esquema enumera `tax_levy_federal, tax_levy_state, pension_alimenticia` (`008:427`, sin CHECK); el motor sólo conoce `child_support|tax_levy|creditor|bankruptcy|student_loan` (`:15`); cualquier otro no entra en ningún `if` (`:114-138`) → 0 en silencio.
- **[nuevo] Vocabulario de `amount_type`**: el motor lee `CASE WHEN amount_type = 'percentage'` (`:71`) mientras el esquema documenta `fixed, percent_disposable, percent_gross` (`008:429`). Una orden porcentual guardada con el vocabulario documentado da `percentage = NULL` y `amount_per_period = NULL` → `desired = 0` → retiene 0. `garnishments.spec.ts:32-89` mockea filas ya con `percentage: null` y `amount_per_period` fijo, así que el desajuste nunca se ejercita.
- **[nuevo] Prelación**: la cabecera promete «Priority: federal tax levy > child support > bankruptcy > creditor» (`:5`), pero el orden real es sólo `ORDER BY priority ASC, start_date ASC` (`:78`): la prelación **[42 U.S.C. §666(b)(7); 26 CFR 301.6331-1]** es la que capture quien no tiene puerta para capturarla.
- **Límites estatales más protectores** **[§1677; TX prohíbe embargo de acreedor, CA 40× mínimo estatal, NY 10 % bruto, PA/NC/SC restringen]**: nada.
- **Salario mínimo federal** `7.25` quemado (`:36`) **[29 U.S.C. §206(a)(1)]**; el estado puede fijar uno mayor.
- **Levy federal**: Pub 1494 depende de estado civil, dependientes y frecuencia; aquí es un importe manual (`:123`).
- `max_withholding_pct`, `total_paid`, `total_owed` (`008:431, 438-440`) sin lector; `end_date` no se filtra (`:77` sólo `is_active`): el embargo no se extingue al saldarse.
- Cuota administrativa del patrón por estado; remesa al acreedor (`payee_*`) sin puerta.
- **MX**: pensión alimenticia (LFT art. 110-V, 97-IV; CCF 308-323): el motor no corre para MX (`paycheck-service.ts:287`; catálogo `:1674`).

En el mayor el importe **no se pierde** (matización del escéptico al original): va sumado en `post_tax_deductions` (`paycheck-service.ts:313`, `:351`) y de ahí a `garnishment_payable` (`gl-posting-service.ts:80`, `:147-150`); lo que se pierde es la cifra distinguible en `paychecks.garnishments`, que el `INSERT` no escribe (§1.21).

Parámetros: `quemado` — `FMW_PER_HOUR = 7.25` (`:36`), 30× (`:94`), 0.25 (`:95`), 0.50/0.55/0.60/0.65 (`:48-49`), 0.15 (`:136`). Todos son ley federal que el estado puede endurecer.

### 1.20 Beneficios — 401(k), HSA, FSA, §125 (`usa/benefits/benefits-service.ts`)

**parcial · US · REST `GET/POST /benefit-plans`, `GET/POST /employees/:id/benefit-elections`** (`payroll.ts:338-372`) para alta y elección. El cálculo por cheque, `calculateBenefitsForPaycheck` (`:79-153`), es **inerte**: sin llamador en `src/` (`criterios.ts:1205` lo congela; sólo lo llama el spec).

Implementa: alta de plan con fórmula de aportación patronal (`:46-56`); elección por porcentaje o importe con upsert (`:58-73`); cálculo de deducción con tope anual del plan y aportación patronal por tres fórmulas (`:110-150`); `validateContribution` contra límites 2026 quemados (`:177-185`), también sin llamador en `src/` (sólo `benefits.spec.ts:68-75`). Probado (`benefits.spec.ts`, 5 casos). El tratamiento fiscal por cheque (pre-tax FIT sí / FICA no para 401(k)) lo hace el orquestador con las deducciones que **manda el cliente HTTP** (`paycheck-service.ts:112-126`), no este servicio.

Por definir (**US**):
- **Límites legales en un solo sitio**: `limits2026` (`:178-180`: 23 500 / 23 500 / 4 300 / 3 200 / 5 000) frente a `009:26-30` (23 500 / 7 500 / 4 400 / 8 750 / 3 300, sin lector) frente a lo publicado: 401(k) **24 500**, catch-up **8 000**, súper catch-up 60-63 **11 250** **[externo, confirmado: 2]**; FSA **3 400** **[externo, confirmado: 3]**; HSA 4 400 / 8 750 coinciden con la semilla y no con el servicio; DCFSA 7 500 desde 2026 por OBBBA **[externo, confirmar]**. El comentario `:8-9` mezcla años.
- **Catch-up 50+ y 60-63** **[IRC §414(v); SECURE 2.0 §109]**: `date_of_birth` (`008:24`) y `catchup_limit_annual` (`008:398`) sin lector (`grep` vacío fuera de migraciones).
- **Límite conjunto 401(k) + Roth 401(k)** **[§402(g), §402A]**: el tope se aplica por `plan_type` (`:118`) → se puede exceder sumando ambos.
- Límite §415(c); HSA familiar frente a individual (`:179`, un solo número); no discriminación §125/§401(k) fuera de alcance razonable.
- **YTD real**: `ytdBenefits` lo pasa el llamador (`:83`) y `ytd-service` devuelve 0 en `pretax_401k` (`ytd-service.ts:134`): no hay tope anual efectivo desde datos persistidos.
- `employer_contribution_value` de la elección (`008:411`) sin lector; `plan_type 'life'` aceptado por la ruta (`payroll.ts:102`) y ausente del tipo (`:12`).
- Vencimiento de elecciones (`end_date`), eventos calificantes §125, COBRA: nada.

Parámetros: `quemado` — `limits2026` (`:178-180`) y el comentario `:8-9`. `ley` — `009:26-30`, sembrado sin lector.

### 1.21 Orquestación bruto→neto (`src/services/payroll/common/paycheck-service.ts:67-402`)

**parcial · ambas · REST `POST /pay-runs/:id/calculate`** (`payroll.ts:207-219` → `pay-run-service.ts:46-106` → `calculatePaycheck`, `:67`).

Implementa: bases FIT/FICA/FUTA/estatal (`:119-128`), YTD (`:135`), despacho por país (`:153-281`), embargos (`:283-312`), neto (`:316-320`), persistencia (`:325-389`).

Por definir (**ambas**):
- No escribe `paycheck_taxes` (`008:309`; `grep "INSERT INTO paycheck_taxes"` vacío; sí lo lee `payroll.ts:481`; `doctor-service.ts:695` lo clasifica «numero-falso»; catálogo `:1592`), ni `employer_tax_liabilities` (§1.22), ni las columnas `local_tax_withheld` (§1.12) y `garnishments` (§1.19) de `paychecks` (`INSERT` `:326-336`).
- No lee `is_exempt_fit/fica`; no pasa `is_supplemental` ni `experience_rate` (`:141-151`).
- `country: 'unknown'` en la métrica (`pay-run-service.ts:105, 126, 137`).
- La ruta `calculate` no tiene `validateBody` (`payroll.ts:207-219`) y esparce `req.body` entero; no existe catálogo de conceptos (`grep -i "pay_code\|EARNING_TYPES\|DEDUCTION_TYPES" src/` vacío; `earning_type` es texto libre, `:16`): las bases gravables dependen de lo que mande el cliente HTTP. **MX**: la base ISR es «lo que el cliente marque `is_taxable_isr`» (`:129-131`).

Parámetros: `quemado` — exclusión de `'401k'|'roth_401k'` de la base FICA (`:125`; es ley §3121(v) y debería ser un catálogo de conceptos con banderas por impuesto). `casa` — `freqMap` (`:289-292`).

### 1.22 Calendario de depósitos y pasivos del patrón

**ausente · US (y MX) · sin puerta.**

La tabla `employer_tax_liabilities` tiene `due_date`, `deposit_frequency` (`monthly, semi_weekly, next_day, quarterly, annual`) y `deposited_at` (`008:329-348`); la leen `form-940-generator.ts:51-53` y `form-941-generator.ts:63-66`; la mide en rojo `criterios.ts:2392-2416`; `doctor-service.ts:285-292` la reporta con `level: 'fail'` y el aviso «do not file 940/941». **Ningún escritor**: sin `INSERT` en `src/`, `tests/`, `scripts/`. El catálogo (`:1593`, `:1830`) y el plan (`docs/plan-cierre-brechas.md:72`) lo declaran pendiente.

Reglas que exige **[norma]** — **US**: Reg. §31.6302-1 (lookback de 4 trimestres; mensual ≤ 50 000, quincenal > 50 000; día siguiente ≥ 100 000; regla de 2 500 para el 941), Reg. §31.6302(c)-3 (FUTA trimestral > 500), calendarios estatales de SUTA/SIT, EFTPS obligatorio. **MX**: ISR retenido día 17, IMSS mensual, IMSS-INFONAVIT bimestral, ISN estatal. Hoy el 941 y el 940 reportan cero depósitos por diseño.

## 2. Parámetros quemados consolidados

Sin «quincenal=24» ni `094/10/1/PPD`, que el escéptico sacó de la lista (son definición y formato, no parámetros).

| Parámetro | Dónde | Clase hoy | Debería vivir en |
|---|---|---|---|
| Tope SS 168 600; tasas 0.062 / 0.0145 / 0.009; umbral 200 000 (fallbacks) | `fica-calculator.ts:18-19, 42, 63, 65, 99-100, 119` | quemado (ley) | `tax_parameters` por año **sin fallback numérico**: ausencia → error, no tabla de 2024 |
| Tope SS por año `{2024, 2025, 2026}` y fallback 168 600 | `w2-generator.ts:104-105` | quemado (ley) | la misma fila que lee el motor FICA |
| FUTA 7 000 / 0.006 y supuesto «crédito íntegro» | `futa-calculator.ts:19-21` | quemado (ley) | `tax_parameters` + estatus de reducción de crédito por estado y año |
| SUTA 7 000 / 0.027 | `state-tax-calculator.ts:91-92` | quemado (ley) | `tax_parameters` por estado; tasa de experiencia **por patrón** en una tabla con `entity_id` |
| Estados sin impuesto sobre la renta | `state-tax-calculator.ts:12` | quemado (ley) | `tax_parameters` (`has_income_tax`) |
| Suplementario 0.22 / 0.37 / 1 000 000 | `fit-calculator.ts:22` | quemado (ley) | `tax_parameters` US-FEDERAL |
| Estado civil por defecto `'single'` | `fit-calculator.ts:33`, `state-tax-calculator.ts:54`, `local-tax-calculator.ts:59` | quemado (criterio) | panel de políticas, o rechazo si falta W-4 |
| Localidades y `residentOnly`; recorte de ciudad a 3 letras | `local-tax-calculator.ts:78-83`; `paycheck-service.ts:224` | quemado (ley) | catálogo de localidades en base |
| Salario mínimo federal 7.25; 30×; 25 %; 50-65 %; 15 % | `garnishment-engine.ts:36, 48-49, 94-95, 136` | quemado (ley) | `tax_parameters` US-FEDERAL y por estado (mínimos y topes estatales) |
| Límites 401(k) / HSA / FSA / DCFSA 2026 | `benefits-service.ts:178-180` | quemado (ley) | `tax_parameters` (ya sembrados en `009:26-30`, sin lector) |
| Clase de servicio NACHA `200` (→ `220`), descripción `PAYROLL`, destino `BANK`, modificador `A`, lote 1 | `nacha-generator.ts:75-76, 90, 97, 102, 155` | quemado (entidad) | perfil bancario de la entidad |
| `kind_of_payer '941'` | `w3-generator.ts:79` | quemado (entidad) | perfil fiscal de la entidad |
| Exclusión FICA de `401k` / `roth_401k` | `paycheck-service.ts:125` | quemado (ley) | catálogo de conceptos (pay codes) con banderas por impuesto |
| Lista de `tax_type` que cuenta como depósito en el 941 | `form-941-generator.ts:65` | quemado (vocabulario) | `enums.ts` |

## 3. Lo que Estados Unidos exige y no existe

1. **Calendario y registro de depósitos** (941 mensual/quincenal/día siguiente; FUTA trimestral; EFTPS) — Reg. §31.6302-1, §31.6302(c)-3. Tabla `employer_tax_liabilities` sin escritor (§1.22).
2. **Schedule B del 941 y Schedule A del 940** (pasivo por día; reducción de crédito multiestatal).
3. **1099-NEC/MISC, 1096, W-9 y retención de respaldo** — IRC §6041/§6041A/§3406; umbral 2 000 USD desde 2026 (§1.17).
4. **Retención estatal para 39 jurisdicciones** (38 estados + DC) y tablas MFJ/HoH/MFS en CA/NY; formularios estatales de retención; reciprocidad; asignación de no residentes (§1.10).
5. **Permisos pagados y discapacidad estatales** con topes semanales/anuales: NY PFL y tope DBL, NJ TDI/FLI, RI/HI TDI, WA PFML y WA Cares, MA, CO, OR, CT, DC, MN, DE, MD (§1.11).
6. **Aportación del trabajador al desempleo** (AK, NJ, PA) y cuotas patronales paralelas (CA ETT, NJ WF/SWF) (§1.9).
7. **Tasa de experiencia SUTA por patrón** con almacenamiento por entidad; **FUTA con reducción de crédito** (§1.8, §1.9).
8. **Impuestos locales reales**: catálogo de localidades por código, PA Act 32 EIT/LST, OH municipal, IN/MD condado, KY/AL ocupacionales, MI ciudades, MO, OR transit, Denver OPT; la persistencia de `local_tax_withheld` y la cubeta `local_tax_payable` (§1.12).
9. **Pub 15-T completo**: paso 1g/1h, tablas «Step 2 Checkbox», MFS, W-4 pre-2020, NRA, exento, suplementario alcanzable con acumulado suplementario; y **validación del vocabulario de `filing_status`** a la entrada (§1.4).
10. **Tablas 2026 correctas y con procedencia**: tope SS 184 500, 401(k) 24 500 / 8 000 / 11 250, deducción estándar 16 100 / 32 200 / 24 150, FSA 3 400, bandas FIT 7 500 / 19 300; una prueba que compare la semilla con la publicación (§1.3).
11. **W-2 completo**: cajas 7-13, códigos 12 restantes, número estatal del patrón, multiestado, W-2c/W-3c, entrega electrónica con consentimiento; **`UNIQUE` en `tax_form_filings`** para que regenerar no duplique; **EFW2** con RW alineado a la especificación, RS/RV y validación AccuWage (§1.15, §1.16).
12. **Catálogo de conceptos (pay codes) con banderas por impuesto** — hoy las bases dependen de lo que mande el cliente HTTP (§1.21).
13. **Embargos**: puerta de alta, vocabulario de `type` y `amount_type` alineado con el esquema, prelación legal, exención de Cap. 13, límites estatales, extinción por saldo, remesa al acreedor, Pub 1494 paramétrico (§1.19).
14. **Beneficios**: catch-up por edad, límite conjunto 402(g), §415(c), HSA familiar, YTD de beneficios desde datos, `calculateBenefitsForPaycheck` cableado a la corrida (§1.20).
15. **YTD que vea corridas del mismo día** (`pay_date <` estricto, §1.2) y **caché que no fije el vacío** (§1.1).
16. **New Hire Reporting** — 42 U.S.C. §653a; **Form I-9** — 8 U.S.C. §1324a; **salario mínimo y horas extra FLSA** (29 U.S.C. §206-207) para conceptos por hora: sin motor.
17. **Asientos**: cubeta `local_tax_payable`; separación SDI/PFL del `state_tax_payable`.
18. **Salario en especie, propinas** (FICA §3121(q), 941 5b, W-2 7-8), **GTL > 50 000** (código C).
19. **NACHA**: clase 220, marcado de cheques con los mismos filtros que la generación, trazas sin huecos, cambio de estatus del lote.
20. **Transmisión** IRS MeF / SSA BSO: retirada a propósito con 501 (`payroll.ts:412-435`; probado en `tests/api/routes/withdrawn-endpoints.spec.ts:107-127`); queda como acto humano documentado.

## 4. Lo que México exige y no existe (ámbito de nómina)

Verificado contra `src/services/payroll/mx/` (ISR art. 96 mensual/quincenal, subsidio, IMSS obrero-patronal, INFONAVIT 5 % y crédito, finiquito LFT 76/79/80/87 con factor de integración, SUA, IDSE, CFDI Nómina 1.2) y `grep` de conceptos en `src/services/payroll/`; el escéptico rehizo cada `grep` y no refutó ninguno.

1. **ISN — impuesto sobre nóminas estatal** (leyes de hacienda de las 32 entidades; p. ej. CDMX Código Fiscal arts. 156-159, 3 %): `ISN|impuesto sobre nómina` → sólo `src/ai/docs/nif-registro.md:108`; `isn_rate|impuesto_sobre_nomina|payroll_tax_state` → vacío; catálogo `:1777` ❌.
2. **PTU** (LFT arts. 117-131; 10 % de la renta gravable; tope art. 127-VIII; exención 15 UMA LISR 93-XIV): `PTU` → sólo documentación NIF del agente (`src/ai/docs/*.md`); catálogo `:1789-1791` ❌.
3. **Pensión alimenticia** (LFT art. 110-V, 97-IV; CCF 308-323): `pensi[oó]n.?alimenticia` → sólo comentarios `008:296, 427`; el tipo cabe en `garnishments` pero el motor sólo corre para US (`paycheck-service.ts:287`); catálogo `:1674`.
4. **Exenciones del art. 93 LISR en el cálculo**: aguinaldo 30 UMA, prima vacacional y PTU 15 UMA, horas extra (93-I; LFT 66-68), prima dominical (93-II), previsión social (93-VIII/IX, 7 UMA), fondo de ahorro (93-XI), vales. La base ISR es «lo que el cliente marque `is_taxable_isr`» (`paycheck-service.ts:129-131`); `exent|93|174|uma` en `isr-calculator.ts` → vacío.
5. **ISR sobre pagos separados** (aguinaldo, PTU, finiquito; art. 174 RLISR) y **retención por indemnización** (LISR 95-96): el finiquito calcula importes, no su ISR (`finiquito-math.ts`).
6. **Ajuste anual de ISR** (LISR art. 97) y constancia al trabajador: `ajuste anual` en `src/services/payroll/` → vacío.
7. **SBC integrado con variabilidad bimestral** (LSS arts. 27-30, 30-II): `factorDeIntegracion` sólo en `finiquito-math.ts:183, 206`; el IMSS usa `employees.sbc` capturado a mano (`paycheck-service.ts:145`); `bimestr` → un comentario del seed (`payroll-account-mapping-seed.ts:94`).
8. **Prima de riesgo de trabajo anual** (LSS art. 74; RACERF 32-39): `prima_riesgo|siniestr` → vacío; la clase es fija por empleado (`riesgo_puesto`); catálogo `:1774`.
9. **Dispersión bancaria mexicana** (SPEI/layouts por banco): el enum `rail` admite `'spei'` (`008:458`) y `spei` en `src/services/payroll/` → vacío (aparece sólo como método de cobro/pago).
10. **Vacaciones y prima vacacional devengadas por periodo** (LFT 76-80): `vacacion` fuera de finiquito → vacío.
11. **INFONAVIT**: descuentos con tope y modalidades VSM/pesos/factor están; falta el aviso de retención y el ciclo bimestral de amortización (Ley INFONAVIT art. 29) como obligación calendarizada.
12. **Provisiones de cierre** (aguinaldo, PTU, vacaciones, prima; NIF D-3): `provision|accrue|devengar` en `src/services/payroll/` → vacío; catálogo `:1827` planeado.
13. **Calendario de enteros** (ISR día 17, IMSS mensual, IMSS-INFONAVIT bimestral, ISN estatal): mismo hueco que §3.1, `employer_tax_liabilities` sin escritor.

## 5. Puertas

| Superficie | Qué hay | Evidencia |
|---|---|---|
| **CLI** | Ninguna puerta de nómina. Los 42 `register*Command` de `src/cli/mnemosine.ts:3013-3056` no incluyen ninguno de nómina; `grep -rln "payroll\|nomina\|pay-run" src/cli/*.ts` → `approvals-command.ts`, `bank-command.ts`, `entity-command.ts`, `entry-command.ts`, y ninguno lo es (son un origen de póliza, `entry-command.ts:391`, y el mapeo de cubetas al crear entidad, `entity-command.ts:180-253`). | `ls src/cli/`; catálogo `docs/cli-command-catalog.md:1664, 1674, 1777, 1789-1791, 1802-1808, 1830` (planificado, no construido) |
| **REST** | La única puerta: `src/api/rest/routes/payroll.ts`. Ver tabla siguiente. | — |
| **GraphQL** | Ninguna. `src/api/graphql/schemas/schema.ts` define `Query` (`:442`) y `Mutation` (`:461`) sin ningún tipo, campo ni resolutor de nómina (`grep -rn -i "payroll\|paycheck\|pay_run\|employee\|w2\|nacha\|garnish" src/api/graphql/` → vacío). | `schema.ts:442, 461` |
| **Agente** | Ninguna herramienta invoca nómina. `src/ai/tools/docs-tools.ts:23` sólo describe el módulo; `external-tools.ts:35` admite `'Nomina'` como tipo de CFDI a validar, no como acción de nómina; `search-tools.ts:111, 133` filtra proveedores 1099. | `grep -rn -i "payroll\|paycheck\|pay-run\|nomina" src/ai/tools/*.ts` |

Rutas REST de nómina US (`payroll.ts`), con permiso y guarda de entidad:

| Motor | Ruta | Permiso | `requireEntityAccess` |
|---|---|---|---|
| Alta de corrida | `POST /pay-runs` (`:193-205`, con `validateBody`) | `payroll:create` | — |
| Cálculo bruto→neto (todos los calculadores US) | `POST /pay-runs/:id/calculate` (`:207-219`, **sin** `validateBody`) → `pay-run-service.ts:46-106` → `paycheck-service.ts:67` | `payroll:create` | no |
| Aprobación, asiento al mayor, marcado pagado | `POST /pay-runs/:id/approve` (`:221`), `/post-to-gl` (`:230` → `gl-posting-service.ts`), `/mark-paid` (`:239`) | `payroll:approve` | no |
| W-2 | `POST /w2` (`:291-296`) | `payroll:approve` | no |
| 941 | `POST /form-941` (`:299-304`) | `payroll:approve` | sí |
| 940 | `POST /form-940` (`:307-312`) | `payroll:approve` | sí |
| NACHA | `POST /nacha` (`:315-320`) | `payroll:approve` | no |
| W-3 / EFW2 | `POST /w3` (`:323`), `POST /efw2` (`:330`) | `payroll:approve` | sí |
| Planes y elecciones de beneficios | `GET/POST /benefit-plans` (`:338, 344`), `GET/POST /employees/:id/benefit-elections` (`:359, 364`) | `payroll:read/create/update` | parcial |
| Embargos | **sin puerta**: ni ruta ni CRUD; `garnishments` sin `INSERT` en el árbol | — | — |
| `calculateBenefitsForPaycheck` | **sin puerta**: huérfano congelado en `criterios.ts:1205` | — | — |
| Depósitos (`employer_tax_liabilities`) | **sin puerta** ni escritor | — | — |
| Transmisión IRS/SSA | **retirada**: `POST /irs-efile/:filing_id` (`:413`), `GET /irs-efile/status/:submission_id` (`:421`), `POST /ssa-bso/submit` (`:429`) responden 501 y nombran el canal humano (`:412-435`) | — | — |
| Autoservicio del empleado | `GET /me/paychecks` (`:438`), `GET /me/w2/:tax_year` (`:458-473`, devuelve el JSON completo del W-2 persistido, SSN incluido) | sin `requirePermission` | — |
| Consulta de presentaciones | `GET /tax-filings` (`:485`) | `payroll:read` | sí |

## 6. Lo que el escéptico refutó o corrigió

Para que el lector sepa qué **no** creerse del inventario original:

**Refutado (eliminado de este documento):**
1. «`quincenal=24` fijo — `tax-tables.ts:114`» como parámetro quemado. Una quincena son 24 periodos al año por definición; no es criterio configurable ni pertenece al panel.
2. `'094'`, `'10'`, `'1'` y `'PPD'` (`nacha-generator.ts:87-89, 101`) como parámetros. Son el tamaño de registro, el factor de bloqueo, el código de formato y el SEC que fija la propia regla NACHA: constantes de casa. Sí siguen como quemados los datos de la entidad: `BANK`, `PAYROLL`, `A`, `200→220`, lote 1.

**Corregido (sustituido en este documento):**
3. Claves sembradas sin lector: son **17**, no 16 (el original agrupaba `standard_deduction_*` en una).
4. El hueco del 940 es la casilla **«Type of Return»**, no «Kind of payer»; «Kind of payer» es la casilla b del W-3 (`w3-generator.ts:11, 79`).
5. Jurisdicciones con impuesto y sin tabla SIT: **39** (38 estados + DC), no 38.
6. Las tablas FIT sembradas no es que «no se puedan cotejar»: **no cuadran** con la Pub 15-T 2026 (6 300 / 16 300 frente a 7 500 / 19 300).
7. El importe de los embargos **no se pierde para el mayor** (va por `post_tax_deductions` a `garnishment_payable`); lo que se pierde es la cifra distinguible en `paychecks.garnishments`.
8. `tests/payroll/tax-engine/tax-tables.spec.ts` tiene **10** casos, no 11.

**Afinado (el original era cierto pero incompleto):**
- El silencio-cero del FIT no es sólo MFS: cualquier `filing_status` no validado a la entrada (`payroll.ts:67`) produce FIT = 0; y `009:113` muestra que MFS iba a mapearse a `single` y nunca se hizo.
- El RW del EFW2 no está «sin validar»: está **desalineado 43 posiciones**.
- El catálogo CLI (`:1802`) describe el W-2 consultando `FROM entities`; hoy consulta `legal_entities`.

**Cifras 2026 que el original marcaba [externo, confirmar] y quedaron confirmadas** contra el IRS: tope SS 184 500; 401(k) 24 500 / 8 000 / 11 250; deducción estándar 16 100 / 32 200 / 24 150; FSA 3 400; HSA 4 400 / 8 750; tramo del 10 % single hasta 12 400; umbral 1099-NEC 2 000 USD. Siguen sin cotejar: posiciones del RW en la especificación EFW2 (SSA 403), estados con reducción de crédito FUTA por año, eliminación del tope SDI de CA en 2024, vigencia del SF Payroll Expense, DCFSA 7 500.

**Hallazgos nuevos del escéptico incorporados** (ocho, marcados **[nuevo]** en §1): el resultado vacío se cachea (§1.1); el YTD ignora corridas del mismo día (§1.2); las bandas FIT no son de ningún año (§1.3); un local > 0 descuadraría el asiento (§1.12); el RW desalineado (§1.16); `direct_deposit_batches` nunca sale de `draft` (§1.18); el vocabulario de `amount_type` retiene 0 (§1.19); la prelación de embargos es la capturada, no la de la cabecera (§1.19).

## Fuentes externas consultadas por el escéptico

1. IRS, Publication 15 (2026), «What's New»: «The social security wage base limit is $184,500.» https://www.irs.gov/publications/p15 (la SSA devolvió HTTP 403 en `ssa.gov/oact/cola/cbb.html`, `ssa.gov/news/en/cola/factsheets/2026.html` y `ssa.gov/cola/`).
2. IRS, «401(k) limit increases to $24,500 for 2026», Notice 2025-67: 24 500 / 8 000 / 11 250 (60-63). https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500
3. IRS, IR-2025-103 y Rev. Proc. 2025-32: deducción estándar 16 100 / 32 200 / 24 150; FSA 3 400; tramo del 10 % single hasta 12 400. https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill
4. IRS, Publication 15-T (2026), Worksheet 1A paso 1g («$12,900 if … married filing jointly or $8,600 otherwise») y tablas STANDARD anuales (0 % hasta 7 500 single/MFS, 19 300 MFJ). https://www.irs.gov/publications/p15t
5. IRS, Instructions for Forms 1099-MISC and 1099-NEC: umbral 2 000 USD «for tax years beginning after 2025». https://www.irs.gov/instructions/i1099mec
- SSA, EFW2 Tax Year 2026 (`ssa.gov/employer/efw/26efw2.pdf`): HTTP 403; las posiciones del RW quedan **[externo, confirmar]**.
