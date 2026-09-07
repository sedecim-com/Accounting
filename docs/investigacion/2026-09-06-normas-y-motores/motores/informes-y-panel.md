# Informes, calendario fiscal y panel de políticas — inventario verificado

> **Método.** El inventario original lo escribió el agente de motores por lectura de `src/services/reporting/`, `src/services/policy/`, `src/services/accounting/pais-contable.ts` y `src/services/accounting/fiscal-calendar-service.ts`; lo verificó un segundo agente escéptico que abrió cada `archivo:línea`, corrió grep sobre `src/` por cada «ausente», «sin puerta» y «quemado», buscó cada motor bajo otro nombre y cada puerta en `src/cli`, `src/api/rest` y `src/api/graphql`, y comprobó que ninguno de los parámetros quemados vive ya en `tax_tables`/`tax_parameters` ni en el panel. Ambos trabajaron sobre la rama `investigacion/normas-y-motores`; este documento los funde contra el HEAD `4b1d8fe`, y cada reclamo queda como el verificador lo dejó (confirmado, corregido o eliminado — §6 lista lo que no hay que creerse del original).
>
> **Convenciones.** Rutas relativas a la raíz del repositorio; dentro de cada apartado, el archivo nombrado en su título se abrevia a `:NNN`. Las migraciones se citan por número (`001` = `src/database/migrations/001_core_schema.sql`, `010` = `010_fix_mv_trial_balance.sql`, `016` = `016_policy_decisions.sql`, `017` = `017_fix_policy_unique.sql`, `031` = `031_refresh_reporting_views.sql`, `057` = `057_la_moneda_en_el_origen.sql`). Estado de motor: **completo** | **parcial** | **inerte** (motor sin puerta, o con puerta que no escribe) | **ausente**. Origen de parámetro: **ley** (lo fija una norma; debería leerse de una tabla con vigencia) | **panel** (vive o debe vivir en `pending-catalog.ts`) | **casa** (convención del producto, legítima en código) | **quemado** (literal en código que debería ser ley, panel o configuración; se indica con «→» a dónde debería ir). Nada del repositorio fuera de este archivo se tocó; nada se ejecutó — toda conducta es por lectura del SQL y del TypeScript.

---

## 0. Cómo ve la jurisdicción este subsistema

1. **Ningún informe conoce la jurisdicción.** `esContabilidadMexicana` (`src/services/accounting/pais-contable.ts:35-44`) lo consumen exactamente dos sitios de `src/services/accounting/entity-accounting.ts` (`:75`, para sembrar el catálogo; `:172`, para diagnosticar roles) más su import (`:5`). Ni `src/services/reporting/report-service.ts`, ni `cash-flow-service.ts`, ni `src/services/accounting/fiscal-calendar-service.ts`, ni `src/services/policy/policy-service.ts` lo importan. Los estados financieros se producen con una sola forma para México y Estados Unidos.
2. **El conmutador no es único.** El encabezado de `pais-contable.ts:4-9` afirma haber unificado cuatro sitios, pero tres copias inline sobreviven: `src/services/accounting/iva-ppd-reclass.ts:101` (`incorporation_country = 'MX' OR accounting_standard = 'mx_nif'` en SQL), `src/services/accounting/iva-cash-basis.ts:310` (la misma regla en TS) y `src/ai/doctor-service.ts:190` (`incorporation_country = 'MX'` a secas). Coinciden en el caso normal y difieren en el borde: «país vacío → México» sólo lo hace `pais-contable`; `doctor` no mira `accounting_standard`.
3. **Es binario: «México / no México».** El CHECK admite `'us_gaap' | 'mx_nif' | 'ifrs'` (`001:87-88`) y el conmutador colapsa `us_gaap` e `ifrs` en «no mexicana». Hoy es colapso teórico: `type Country = 'MX' | 'USA'` (`src/services/entity/entity-service.ts:33`) y el `INSERT` de `entity-service.ts:236-245` escribe siempre `incorporation_country, functional_currency, accounting_standard` desde `COUNTRY_PROFILES` — ninguna puerta puede crear una entidad `'ifrs'` ni dejar el país vacío (`src/cli/entity-command.ts:184` y `src/cli/init/s1-identity.ts:96-98` traen defecto `MX`; `src/database/seed.ts:41` lo inserta explícito). Los defaults del DDL (`accounting_standard DEFAULT 'us_gaap'`, `functional_currency DEFAULT 'USD'`, `001:86-87`) contradicen al conmutador («ante la duda, mexicana», `pais-contable.ts:43`), pero no hay puerta que los active: deuda de esquema, no riesgo operativo.
4. **El panel se siembra entero a todo inquilino.** `seedPolicies` (`policy-service.ts:47-68`) recorre `POLICY_CATALOG` sin filtro de país; sus tres llamadores pasan sólo `tenantId` (`src/cli/pending-command.ts:249,343`; `src/cli/init/s4-policies.ts:62`). `PolicySpec` (`src/services/policy/pending-catalog.ts:14-38`) no tiene campo de jurisdicción y `policy_decisions` no tiene columna de país (`016:9-46`; la `017` sólo toca unicidad). De las 39 claves, 21 llevan texto de norma o práctica mexicana (LISR, LIVA, LIEPS, LFT, LGSM, CFF, CFDI/REP, e.firma, DOF), pero al menos tres de ellas (`base_depreciacion`, `convencion_primer_mes`, `destino_del_resultado_del_ejercicio`) son bifurcaciones universales con etiquetas mexicanas: lo atado a MX es el texto de la opción, no la pregunta. A una sociedad de Delaware se le pregunta por IEPS, aguinaldo y complementos de pago igual que a una S.A. de C.V.
5. **El calendario fiscal sólo construye el año natural con doce periodos** (`fiscal-calendar-service.ts:513-538`). México lo exige así (CFF art. 11); Estados Unidos no (IRC §441). El esquema ya admite otra cosa —`legal_entities.fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK (BETWEEN 1 AND 12)` (`001:89`), `period_number BETWEEN 1 AND 13`, `period_type IN ('regular','adjustment','closing')`, `is_calendar_year` (`001:186,197,201-202`)— y nadie lo lee: `fiscal_year_start_month` aparece en `src/` sólo en `src/types/index.ts:904`, sin escritor ni lector.
6. **No existe una función «jurisdicción de informes»** que devuelva `nif | nif_2028 | us_gaap | ifrs` para que los estados elijan layout; el catálogo lo pide como `statement layout install --norms` (🟡 sin motor, `docs/cli-command-catalog.md:2283`). Las NIF B-1 y B-3 nuevas (vigentes 1-ene-2028, adopción anticipada 2027) están registradas como prosa para el agente (`src/ai/docs/nif-marco.md:121-125`) y como tarea del plan (`docs/plan-cierre-brechas.md:8074`); el `nif-registry.json` que el plan pide no existe (`ls src/ai/docs/`: sólo `ifrs-registry.json`). `docs/SCOPE.md:53` declara que la internacionalización va por paquetes de jurisdicción sobre un motor común y que hoy hay dos: «México, completo; Estados Unidos, parcial (nómina)» — para este subsistema, el paquete US es el calendario natural y una sola forma de estados.

---

## 1. Motores

### 1.1 Resolución de periodos y rangos — `src/services/reporting/report-service.ts:217` (`resolvePeriodRange`) · **parcial** · ambas

**Implementa:** nombre exacto del periodo (`:137-150`); expresiones `AAAA-MM`, `AAAA-Qn`, `FY2026`/`2026` (`MONTH_RE`, `QUARTER_RE`, `YEAR_RE`, `:74-76`; aritmética `:106-129`); rango `a..b` (`:217-236`); preferencia por el periodo fiscal cuando sus fechas coinciden con el calendario (`resolveSinglePeriod`, `:133-204`; coincidencia exacta en `:157-172`); bandera `matched_fiscal_period` (`:65-71`) que el CLI usa para avisar cuando cae al calendario (`src/cli/report-command.ts:247-256`).

**Por definir — ambas:** nada normativo; es aritmética de fechas atada al año natural: `first = (q-1)*3+1` (`:117-121`) asume que el trimestre 1 empieza en enero y `FY2026` resuelve `AAAA-01-01..AAAA-12-31` (`:123-127`). `resolveSinglePeriod` consulta sólo `fiscal_periods`; nunca lee `fiscal_years` ni la entidad. Con un año fiscal de EE. UU. que cierre en junio (IRC §441), `FY2026` y `2026-Q1` resuelven mal por construcción — y el esquema ya tiene `legal_entities.fiscal_year_start_month` (`001:89`) que el resolutor ignora.

**Parámetros:** los tres regex y la aritmética de trimestre (`:74-76`, `:117-121`) — **quemado → configuración por entidad** (`fiscal_year_start_month`, hoy inerte, §1.12.b).

### 1.2 Balanza de comprobación — `src/services/reporting/report-service.ts:301` (`queryTrialBalanceRows`), `:395` (`getTrialBalance`) · **parcial** · ambas

**Implementa:** una fila por cuenta activa con cargos, abonos y saldo cargo-positivo (`:326-346`); conserva cuentas sin movimiento (`:296-300`); filtros por periodo fiscal, corte acumulado o rango (`:274-294`); nivel máximo (`:309-312`); criterio del panel sobre asientos de cierre aplicado dentro del par `(jel JOIN je)` (`:315-324`); pie sumado sobre todas las filas y no sobre la página (`:39-42`, `:404-409`); tolerancia de un centavo (`:355-369`); aviso de cierre en el rango (`:411`).

**Por definir — MX (CFF art. 28-IV; RCFF art. 33-B; RMF 2.8.1.x; Anexo 24 apartado C):** la balanza del Anexo 24 pide cuatro columnas —`SaldoIni`, `Debe`, `Haber`, `SaldoFin`— por cuenta y periodo, con la invariante `SaldoIni + Debe − Haber = SaldoFin` respetando la naturaleza. **Este motor publica tres** (`TrialBalanceQueryRow`, `:242-250`): sin saldo inicial ni naturaleza; `src/types/index.ts:914-918` declara `beginning_balance` que ninguna consulta selecciona y `src/api/rest/routes/reports.ts:44-50` lo admite en su comentario. `--shape 4col` del catálogo (`docs/cli-command-catalog.md:2296`) no está implementado (grep `shape|4col` en `report-command.ts`: 0). **Pero «no hay saldo inicial en el sistema» sería falso**: las cuatro columnas existen por cuenta (§1.2.a), la invariante se verifica (§1.2.b) y la naturaleza existe como columna (`accounts.normal_balance CHECK IN ('debit','credit')`, `001:132`; `mv_trial_balance` la proyecta, `010:23,43`) — la balanza del servicio no la lee. Lo ausente es la **balanza de cuatro columnas como documento**.
**Por definir — US:** ninguna norma exige la balanza como estado; es papel de trabajo.

**Observación (ambas):** la balanza filtra `a.is_active = true` (`:306`); el balance general no filtra por `is_active` a propósito (`:452-455`, comentario explícito). Una cuenta retirada con saldo aparece en el balance y no en la balanza: los dos documentos del mismo corte pueden no atar entre sí. El estado de resultados también filtra `is_active` (`:642`) mientras `queryUnclosedEarnings` no (`:516-531`).

**Parámetros:** `LEDGER_SCALE = 4` (`:52`) — **casa**; tolerancia `'0.01'` (`:368`, repetida en `materialized-view-service.ts:147` y `src/services/accounting/period-close.ts:459-461`) — **quemado → panel** (es tolerancia en unidades de la moneda, no parámetro de moneda: un JPY no tiene centavos); `account_level` por omisión `'5'` en REST (`reports.ts:68`) — **casa**.

#### 1.2.a Saldos de cuatro columnas por cuenta y periodo — `src/services/accounting/account-service.ts:399-440` (`getAccountBalanceByPeriod`) · **completo** · ambas — *hallazgo del verificador*

`account_balances` (`001:481-491`) trae `beginning_balance, debit_total, credit_total, ending_balance`; el motor las publica con puertas `ledger balance show` (`src/cli/ledger-command.ts:244-272`) y `account balance show` (`src/cli/account-command.ts:519-528`). Sólo fiables tras cierre duro (`carryForwardBalances`, `period-close.ts:740,825`), y ambas puertas lo advierten («beginning_balance solo se siembra en el cierre duro», `ledger-command.ts:271`). No es la balanza del Anexo 24 (es por cuenta, no por catálogo entero y periodo), pero el dato de cuatro columnas existe.

#### 1.2.b Invariante `SaldoIni + Debe − Haber = SaldoFin` y encadenamiento entre periodos — `src/services/accounting/ledger-checks.ts:143-185` (`balanceInvarianteDeclarado`), `:188-256` · **completo** · ambas — *hallazgo del verificador*

Verifica la invariante por cuenta y el encadenamiento `ending(N) = beginning(N+1)`. Puerta: `ledger check` (`ledger-command.ts:134,152`, `runLedgerChecks`); lo invoca también `period-close.ts:6`.

### 1.3 Balance general / estado de situación financiera — `src/services/reporting/report-service.ts:545` (`getBalanceSheet`) · **parcial** · ambas

**Implementa:** cuentas permanentes con saldo distinto de cero al corte (`:438-464`), sin filtro `is_active` deliberadamente (`:452-455`); secciones Activo / Pasivo / Capital con signo natural y contracuentas que netean (`:466-502`); subsecciones por `fs_category` («Current Assets», «Non Current Assets», etc., `:479-495`), con `other` para la categoría nula (`:481`); resultado no barrido dentro de capital sumando cuentas de resultados desde el origen —lo que hace que cuadre tras cualquier cierre— (`:504-531`, `:556-568`); `out_of_balance`/`is_balanced` (`:570-583`). El CLI sale con código 4 si no cuadra (`src/cli/report-command.ts:416-426`); **la ruta REST omite `is_balanced` y `out_of_balance`** (`src/api/rest/routes/reports.ts:115-125` publica sólo `assets, liabilities, equity, total_liabilities_and_equity`).

**Por definir — MX (NIF B-6; NIF A-1 Serie A 2023):** (a) presentación comparativa con el ejercicio anterior; no hay comparativos (`docs/wiki/Manual-Reportes-y-entregables.md:320`). (b) Capital contable dividido en contribuido y ganado (NIF C-11 / B-6): las subsecciones salen de `fs_category`, cuyo dominio para capital es un único valor `'equity'` (`001:116-121`); la semilla lo confirma —3100/3200/3300/3900 todas con `fs: 'equity'` (`src/services/accounting/chart-seed.ts:61-65`)—, así que no hay forma de partirlo. (c) Otro resultado integral acumulado como componente separado (NIF B-3/B-4): grep `resultado integral|comprehensive income|\bORI\b|\bOCI\b` en `src/**/*.ts`: 0. (d) Impuestos diferidos (NIF D-4): grep `impuesto.*diferido|deferred tax|ASC 740|NIF D-4`: sólo el título de un doc (`src/ai/tools/docs-tools.ts:40`). (e) Moneda: el balance sale en la moneda de la entidad sin conversión ni cifras en moneda de informe (NIF B-15); grep `currency|exchange|tipo_cambio|moneda` en `src/services/reporting/`: 0.
**Por definir — US (ASC 210; ASC 205-10):** (a) balance clasificado circulante/no circulante: la clasificación existe por `fs_category` pero depende de que el catálogo importado la traiga; no hay regla de 12 meses/ciclo operativo (ASC 210-10-45-1 a 45-12) aplicada a saldos (porción circulante de deuda a largo plazo, p. ej.). (b) Compensación (ASC 210-20): sin regla. (c) Comparativos: ASC 205-10-45-2 los recomienda y la SEC los exige (Reg. S-X 3-01). (d) ASC 740 (diferidos), ASC 830 (conversión), ASC 810 (consolidación de entidades del mismo inquilino): sin motor; grep `consolidat`: `src/services/accounting/account-service.ts:450` (comentario), `:461` (`ESQUEMAS_SIN_COLUMNA = ['fs-line','cash-flow','consolidation']`) y un comentario GraphQL (`src/api/graphql/schemas/schema.ts:328`).

**Parámetros:** los tipos de cuenta que forman cada sección (`:552-554`) — **casa**; el rótulo `'Result Of The Period'` y su regla de inserción (`:561-568`) — **quemado → panel/layout**; los nombres de sección en inglés (`'Assets'`, `'Liabilities'`, `'Equity'`, `:552-554`) mientras el catálogo se siembra en español — **quemado → layout por norma/idioma**.

### 1.4 Estado de resultados — `src/services/reporting/report-service.ts:695` (`getIncomeStatement`) · **parcial** · ambas

**Implementa:** dos secciones, `revenue` y `expense`, con signo natural (`buildIncomeStatementSection`, `:662-682`); filtro de asientos de cierre resuelto por el panel dentro del par (`:613-622`); dos modos de inclusión (`nonzero-net` REST/CLI, `any-activity` agente; `:601-607`, `src/ai/tools/report-tools.ts:147-152`); `net_income = revenue − expenses` (`:714`); aviso de cierre (`:703-707`).

**Por definir — MX (NIF B-3 vigente; NIF D-3; NIF B-14):** el motor produce **un solo escalón**. `fs_category` trae en su dominio `revenue, cogs, operating_expenses, other_income, other_expenses, tax` (`001:116-121`); la consulta lo proyecta (`:633`) y `buildIncomeStatementSection` **no lo lee** (`:662-682` filtra sólo `account_type === type`). Faltan: utilidad bruta, utilidad de operación, resultado integral de financiamiento (RIF), utilidad antes de impuestos, impuestos a la utilidad (causado y diferido, D-4), operaciones discontinuadas, utilidad neta, ORI y resultado integral. La PTU causada y diferida (NIF D-3; LFT arts. 117-131) no tiene renglón ni provisión: grep `\bPTU\b|participación de los trabajadores|profit sharing` en `src/**/*.ts`: 0; sólo prosa (`src/ai/docs/nif-registro.md:112`). Presentación por función o por naturaleza: no es elegible; no hay layout. UPA (NIF B-14) sólo para listadas: fuera de alcance razonable, y ausente.
**Por definir — MX 2028 (NIF B-3 nueva, convergente con NIIF 18; NIF B-1 nueva):** categorías obligatorias de ingresos y gastos (operación / inversión / financiamiento) con subtotales definidos, medidas de desempeño de la administración (MPM) reveladas y conciliadas, reglas de agregación/desagregación. Nada de esto tiene esquema de datos: la única categorización por cuenta es `fs_category`, un CHECK cerrado en la migración `001`.
**Por definir — US (ASC 220; ASC 205-20; ASC 260; ASU 2024-03):** utilidad integral y ORI (ASC 220-10-45: un estado continuo o dos consecutivos); operaciones discontinuadas (ASC 205-20-45); impuestos a la utilidad separados (ASC 740-10-50); UPA (ASC 260) sólo emisoras; desagregación de gastos DISE (ASC 220-40, ASU 2024-03/2025-01) sólo entidades públicas, ejercicios que inicien después del 15-dic-2026. Para una PyME privada estadounidense lo que falta hoy es el escalón de utilidad bruta/operativa y el ORI.

**Parámetros:** rótulos `'Revenue'`/`'Expenses'` (`:673`) — **quemado → layout**; el tipo `contra_revenue` en `queryUnclosedEarnings` (`:527`) **no existe** en el CHECK de `account_type` (`001:110-113`) — valor muerto, inofensivo; indica que dominio y motor se escribieron por separado.

### 1.5 Mayor general — `src/services/reporting/report-service.ts:804` (`getGeneralLedger`) · **completo** (como listado) · ambas

**Implementa:** líneas posteadas con folio, fecha, tipo, descripción, dimensiones (`:766-781`); filtros por cuenta (id o código) y fechas (`ledgerWhere`, `:748-757`); conteo total aparte para señalar truncamiento (`:783-794`); pie sobre la página, y rotulado como tal (`:811-820`). Sin criterio de cierre (correcto: el mayor es el libro).
**Por definir:** ninguna norma de presentación aplica al mayor. Para MX, el auxiliar de folios y el auxiliar de cuentas del Anexo 24 son otro documento (§1.7).
**Parámetros:** ninguno normativo.

### 1.6 Antigüedad de saldos CxC/CxP — `src/services/reporting/report-service.ts:868` (CxC), `:889` (CxP) · **parcial** · ambas

**Implementa:** documentos abiertos con `days_overdue = as_of − due_date` (`:874-886`, `:895-907`); orden por tercero o por atraso (`:854`, `:872`); suma sobre todas las filas (`:920-922`, `:947`, `:961`). **Cubetas de antigüedad: existen en la puerta CLI, no en el motor.** `bucketOf(daysOverdue)` (`src/cli/report-command.ts:722-729`) devuelve `current | 1-30 | 31-60 | 61-90 | 90+` y se adjunta a cada fila (`:600`); la ayuda lo anuncia («bucketed by age», `:191,198,577-578`). El motor (`AgedReceivableRow`, `:827-838`), REST (`src/api/rest/routes/reports.ts:154-176`, proyecta a mano sin cubeta) y el agente (`src/ai/tools/report-tools.ts:185-245`) no las tienen.

**Limitación declarada:** `amount_due` se lee como está hoy; el corte sólo envejece la fecha, no reconstruye el saldo a esa fecha (`:859-867`: «ninguna tabla lo trae en forma usable»). Un aging «al 31 de diciembre» producido en febrero es el saldo de febrero con la antigüedad de diciembre. **Para CxC la afirmación del motor es falsa**: la reconstrucción existe a dos archivos (§1.6.a) y el aging no la usa. Para CxP sí falta: `src/services/ap/ap-controls.ts:248-262` lo declara imposible sobre `bills`.

**Por definir — ambas:** estimación de pérdidas crediticias esperadas —NIF C-16 (MX) / ASC 326 CECL (US)— alimentada del aging por cubeta: grep `CECL|incobrable|allowance for|bad debt|expected credit|C-16|ASC 326`: un ejemplo de ayuda (`src/cli/customer-command.ts:171`), un comentario (`cash-flow-service.ts:392`) y un estado de cliente (`src/services/ar/customer-service.ts:45`). Sin provisión ni motor. Cubetas en el motor (para que REST y agente las publiquen): faltan.

**Parámetros:** estados que cuentan como «abierto» (`RECEIVABLE_OPEN_STATUSES`, `PAYABLE_OPEN_STATUSES`, `:856-857`) — **casa**, pero se exportan y las consultas repiten los literales en el SQL (`:880`, `:902`) en vez de usarlos (*hallazgo del verificador*); los cortes de cubeta 30/60/90 (`report-command.ts:724-728`) — **quemado → panel** (NIF C-16/ASC 326 no fijan cubetas; la casa las elige).

#### 1.6.a Reconstrucción del saldo CxC a fecha de corte — `src/services/ar/invoice-service.ts:164-178` (`amount_due_as_of`) · **completo** · ambas — *hallazgo del verificador*

`amount_due_as_of = total_amount − Σ payment_allocations.amount_applied` con `customer_payments.payment_date <= asOf AND status <> 'void'`. Puerta: `invoice list --as-of` (`src/cli/invoice-command.ts:375-388`). El aging (§1.6) no lo usa.

### 1.7 Auxiliar de cuenta (forma XC del SAT) — `src/services/reporting/report-service.ts:999` (`getAuxiliaryView`) · **parcial** · MX

**Implementa:** inicial → movimientos → final por cuenta y periodo (`:1025-1086`); `inicial` de `account_balances.beginning_balance` (`:1025-1030`), que sólo siembra `carryForwardBalances` en el cierre duro del periodo anterior; por eso publica `inicial_confiable` mirando el estado del periodo **anterior**, no el consultado (`:1045-1078`; `inicial_confiable = previo !== null && (previo.status === 'hard_close' || previo.status === 'locked')`, `:1078`); `final_calculado` para exhibir deriva (`:1085`).

**Por definir — MX (CFF art. 28-IV; RCFF art. 33-B fracc. III y IV; Anexo 24 apartados D y E):** el XML `AuxiliarCtas` 1.3 y `RepAuxFol` 1.3 —naturaleza, `SaldoIni`/`SaldoFin`, y en el auxiliar de folios el UUID, RFC y método de pago por comprobante— no se generan: grep `AuxiliarCtas|RepAuxFol|BalanzaComprobacion|CtaCatalogo` en `src/**/*.ts`: 0 (sólo «Anexo 24» en comentarios y descripciones de `src/cli/account-command.ts:187,208,621,738` y `src/cli/ledger-command.ts:69,218`); `docs/wiki/Manual-Reportes-y-entregables.md:264`: «No se genera el XML de contabilidad electrónica»; familia `e-accounting` ❌ (`docs/cli-command-catalog.md:2058-2068`). La liga UUID por línea de asiento que el auxiliar de folios necesita no existe en el esquema (`cli-command-catalog.md:2018`: «`journal_entry_lines` no tiene `cfdi_uuid`, `counterparty_rfc` ni método de pago»).
**Por definir — US:** no aplica.

**Parámetros:** criterio «confiable = anterior en `hard_close` o `locked`» (`:1078`) — **casa**.

### 1.8 Criterio de cierre en informes — `src/services/reporting/criterio-cierre.ts:73` · **completo** · ambas (neutral)

**Implementa:** lectura de `informes_asientos_de_cierre` con defecto conservador (`:40`, `:73-90`); reconocimiento del asiento de cierre y del espejo que lo deshace (`condicionDeCierre`, `:119-126`); predicado dentro del par (`:134-136`); conteo coherente con el predicado (`:168-183`); aviso listo para imprimir (`:196-214`).
**Por definir:** nada normativo. Es una decisión de presentación declarada en el panel (`pending-catalog.ts:595-623`) y el defecto que corrige (NIF B-1 vigente: corregir por reversa; utilidad en cero por contar el barrido) está documentado.
**Parámetros:** `TIPO_ASIENTO_DE_CIERRE = 'closing'` (`:32`) — **casa** (es el tipo que emite `period-close.ts:1258,1288` como `'closing' as JournalEntryType`); `CRITERIO_POR_OMISION = 'estado_sin_cierre_balanza_con_cierre'` (`:40`) — **panel**, pero **duplicado** del `defaultValue` de `pending-catalog.ts:612` sin importarlo: si el catálogo cambia el defecto, éste no lo sigue.

### 1.9 Estado de flujos de efectivo — `src/services/reporting/cash-flow-service.ts:844` (`getCashFlowStatement`) · **parcial** · ambas

**Implementa (NIF B-2 / ASC 230):** método indirecto (`:649-707`): utilidad neta + partidas no monetarias ± capital de trabajo = operación; inversión; financiamiento; `net_cash_flow` (`:702-705`). Identidad de partida doble como fundamento (`:40-65`). Clasificación por columnas estructurales (`account_type`, `fs_category`), nunca por nombre (`clasificarCuenta`, `:378-426`). Contra-activos como partida no monetaria antes de mirar categoría (`:410`). Operaciones de inversión/financiamiento sin efectivo excluidas del cuerpo y reveladas aparte (`:454-582`). Cuentas de efectivo por rol `banco` + `bank_accounts.gl_account_id` + descendientes (`:222-292`). Método directo rechazado con motivo (`:799-834`); presentación bruta rechazada (`src/cli/cashflow-command.ts:270-300`); el CLI declara `--method` y `--gross` (`:339-350`). Lo no clasificado queda fuera del neto y se publica (`:726-760`). Criterio `lista` falla cerrado por falta de columna (`:226-237`). Tres políticas del panel (`:159-173`; `pending-catalog.ts:516-593`).

**Por definir — ambas:**
- **Efectivo al inicio y al final dentro del estado** (NIF B-2; ASC 230-10-45-24). `CashFlowStatement` (`:767-785`) no trae ni inicial ni final; el CLI los toma del amarre en `filasDelAmarre` (`cashflow-command.ts:255-268`: `saldo_inicial` `:261`, `saldo_final` `:263`); **REST publica `{ data: statement }` a secas** (`src/api/rest/routes/reports.ts:249-255`).
- **Efecto de la fluctuación cambiaria sobre el efectivo** como renglón propio (ASC 230-10-45-18; NIF B-2): sin motor; grep `currency|exchange` en `reporting/`: 0.
- **Intereses e impuestos pagados** revelados bajo el indirecto (ASC 230-10-50-2; NIF B-2): sin motor; grep `interes|dividend` en `reporting/`: un solo comentario (`cash-flow-reconcile.ts:489`).
- **Sección de intereses y dividendos por jurisdicción.** ASC 230-10-45-15/16/17 fija intereses pagados/cobrados y dividendos cobrados en operación, dividendos pagados en financiamiento; NIF B-2 tiene reglas propias que no coinciden punto por punto. Hoy lo decide `account_type` (`:409-411`): interés pagado es `expense` → utilidad → operación; dividendo pagado es `equity` → financiamiento. Coincide con ASC 230 por accidente. Es bifurcación de criterio: va al panel con dimensión de jurisdicción, no a un `if`.
- **Equivalentes y efectivo restringido:** ASC 230 (ASU 2016-18) incluye el restringido en el total conciliado; NIF B-2 pide revelarlo. Sin concepto de «restringido» ni «equivalente ≤ 3 meses»; grep en `reporting/`: sólo el subtipo `'equivalentes_de_efectivo'` (`:198`).
- **Método directo con conciliación** (ASC 230-10-45-30; NIF B-2 lo permite): requiere clasificar cada movimiento por concepto al registrarlo, que el motor declara inexistente (`:799-821`). La opción `directo` del panel hoy sólo puede fallar: **opción inerte**.
- **Criterio `lista`** de cuentas de efectivo: el catálogo lo tiene como `cashflow category set` fase 2 (`docs/cli-command-catalog.md:2288`).

**Parámetros:**
- `POLITICAS_POR_OMISION` (`:91-95`: indirecto/rol/avisar) — **panel**, duplicado de `pending-catalog.ts:533,558,581` sin importarlo. **Hay una tercera copia** del default `'rol'` en `cash-flow-reconcile.ts:384` (`politicaDe(entityId, 'flujo_efectivo_cuentas_de_efectivo', 'rol')`) (*hallazgo del verificador*).
- `SUBTIPOS_DE_EFECTIVO` (`:192-199`, **seis** valores) **diverge** de la misma constante en `cash-flow-reconcile.ts:56` (**tres** valores). Bajo el criterio `subtipo`, `generate` y `reconcile` pueden usar conjuntos de efectivo distintos — exactamente lo que `cash-flow-reconcile.ts:305-308` exige que no pase. **Quemado → un solo sitio (tabla o panel).**
- Rol `'banco'` literal (`:257`) frente a `ROLES_DE_EFECTIVO` en el amarre (`cash-flow-reconcile.ts:47`) — **quemado → una constante compartida**.
- Mapa `fs_category → sección` (`:406-426`) — **quemado → panel** (el catálogo lo reconoce como decisión del despacho: `cashflow category set`, `cli-command-catalog.md:2288`).
- Comentario caduco `:120-126` («las tres claves todavía no están declaradas en el catálogo») frente a `pending-catalog.ts:516-593`, donde sí están; el `try/catch` sigue siendo útil.

### 1.10 Amarre del flujo contra el efectivo real — `src/services/reporting/cash-flow-reconcile.ts:597` (`conciliarFlujoDeEfectivo`) · **completo** · ambas (neutral)

**Implementa:** variación real de caja y bancos del mayor, no de extractos (`:24-30`, `:378-431`); saldo inicial como acumulado de todo lo posteado antes del periodo, no de `account_balances` (`:365-371`); residuo = derivado − real, impreso, jamás absorbido (`:612-617`, `:650-667`); tres tratos según `flujo_efectivo_descuadre` (`:626-648`); sospechosos por tipo y rol, nunca por nombre, con reparto proporcional de la póliza (`:497-581`); cobertura del residuo (`:685-690`).
**Por definir:** nada normativo; es control interno, no estado.
**Parámetros:** `ROLES_DE_EFECTIVO = ['banco']` (`:47`) — **casa** (ver duplicado en §1.9); `SUBTIPOS_DE_EFECTIVO` (`:56`) — **quemado**, divergente (§1.9); `opts.limite * 4` (`:558`) — **casa**; `categoriaDe` (`:463-478`) es un **segundo clasificador** con reglas distintas al del estado (`cash-flow-service.ts:406-426`): usa roles `cxc/cxp/activo_fijo/depreciacion_acumulada` y subtipos que el otro no mira; admitido en `:459-461`. Mientras existan dos, la lista de sospechosos puede discrepar del estado.

### 1.11 Vistas materializadas — `src/services/reporting/materialized-view-service.ts:67` (`refreshReportingViews`), `:107` (`getReportingViewStatus`) · **completo** (sin consumidor en el producto) · ambas (neutral)

**Implementa:** refresco como comando vía `refresh_reporting_views()` SECURITY DEFINER (`:67-80`); deriva vista vs mayor en crudo, ignorando el criterio de cierre (`:108-115`); `is_stale` con tolerancia (`:146-148`). «Nothing in the product reads them today» (`:14-16`): lectores de `mv_trial_balance|mv_account_balance_summary` fuera del servicio, sólo `report view show|sync` (`src/cli/report-command.ts:651-692`); `sync` cerrado al agente (`:23`).
**Parámetros:** `REPORTING_VIEWS` (`:40`, espejo de la migración `031`) — **casa**; tolerancia `'0.01'` (`:147`) — **quemado → panel** (misma que §1.2).
**Observación:** `mv_trial_balance` filtra `a.is_active = true` (`010:42`) igual que la balanza; el cotejo es coherente con ella y no con el balance.

### 1.12 Calendario fiscal — `src/services/accounting/fiscal-calendar-service.ts` · **parcial** · MX correcto, US incompleto

**Implementa:**
- `ensureFiscalYear` (`:489-543`): año natural (`start_date = AAAA-01-01`, `end_date = AAAA-12-31`, `:515`; `is_calendar_year = true, 'open'`, `:514`), doce periodos `regular` mensuales (`for m = 1..12`, `:518`; `'regular'`, `:529`), nombres `en-US` (`:534`), meses pasados y el actual nacen `open`, los futuros `future` (`:521-524`). `createFiscalYear` (`:557-570`) exige año 1900-2999 (`:551`).
- Estados: `future → open` con auditoría (`openPeriod`, `:361-414`); `soft_close|hard_close → open` con motivo obligatorio y `locked` intocable (`reopenClosedPeriod`, `:223-281`; cerrojo `:248-254`); restauración a `soft_close|hard_close` rehaciendo el arrastre en el duro (`restorePeriodStatus`, `:302-345`).
- `resolvePeriod` por uuid, `AAAA-MM` o nombre sin ambigüedad (`:111-155`); `getPeriodDetail` con conteos por estado y quién cerró (`:164-192`); años con progreso de cierre (`:424-467`); `overdue = end_date < CURRENT_DATE` (`:94`).
- La puerta del posteo busca el periodo por fecha y rechaza `hard_close`/`locked` (`src/services/accounting/posting.ts:100-110`); un `future` acepta pólizas (`:197-200`).

**Por definir — MX (CFF art. 11):** el ejercicio coincide con el año de calendario —lo que el motor hace— pero **el primer ejercicio es irregular** cuando la sociedad se constituye después del 1 de enero (CFF art. 11, segundo párrafo), y también el último cuando entra en liquidación. `ensureFiscalYear` crea siempre enero-diciembre y abre los meses anteriores a la constitución; no lee la fecha de constitución. Falta «ejercicio irregular = desde la fecha de constitución».
**Por definir — US (IRC §441, §442; Treas. Reg. §1.441-1):** año fiscal con cierre en cualquier mes, o 52-53 semanas (§441(f)); gestión 4-4-5 con periodo 13 de ajuste. El esquema lo admite —`fiscal_year_start_month` (`001:89`), `period_number BETWEEN 1 AND 13`, `period_type IN ('regular','adjustment','closing')`, `is_calendar_year` (`001:186,197,201-202`)— y el motor lo declara fuera (`:485-487`: «are not invented here»). `'adjustment'` aparece sólo en enums (`src/types/index.ts:81,151,190`) y en movimientos bancarios (`src/services/banking/transactions.ts:33`, `src/services/banking/bank-statement-service.ts:81,337`); `period_type` sólo lo escribe `:528` con `'regular'`. Un año fiscal no natural hoy es imposible de crear desde cualquier puerta.
**Por definir — ambas (calendario de obligaciones):** no existe motor de fechas límite ni MX (balanza electrónica RMF 2.8.1.x; pagos provisionales LISR art. 14 y definitivos LIVA art. 5-D el día 17; DIOT LIVA art. 32; anual LISR art. 9) ni US (Form 941 trimestral; 1120/1065 §6072; 1099-NEC 31 de enero; sales tax estatal). `obligation generate|list|deadline list|record` ❌ (`docs/cli-command-catalog.md:2077-2080`); grep `obligation|deadline|fecha límite` en `src/services`: nada de calendario. La marca `overdue` (`:94`) es «el mes ya terminó», no «venció una obligación». **Los formularios US sí tienen motor y puerta REST** (`src/api/rest/routes/payroll.ts:29-31` importa `generateForm941`, `generateForm940`, `generateW2`, `generateW3`, `generateEfw2File`; rutas `POST /w2` `:291`, `/form-941` `:299`, `/form-940` `:309-314`, W-3/EFW2 `:326,333`): lo que falta es que el generador conozca su fecha límite (grep `due|deadline` en `src/services/payroll/usa/forms/form-941-generator.ts`: sólo `line_14_balance_due`). También existe la marca `is_1099_vendor` (`src/types/index.ts`, `src/cli/vendor-command.ts`, `src/api/rest/routes/vendors.ts`, `src/ai/tools/search-tools.ts`). DIOT aparece sólo como «bloqueador» en `src/cli/vendor-command.ts:108,178,347`.
**Por definir — ambas (continuidad):** el wizard sólo crea el año en curso (`src/cli/init/s1-identity.ts:197-198`); `year create` existe (`src/cli/period-command.ts:636-682`) pero nadie lo dispara solo. Si nadie lo corre antes del 1 de enero, la primera póliza del año muere con `PERIOD_CLOSED: No open fiscal period found` (`posting.ts:107-110`). Sin creación anticipada ni aviso.

**Parámetros (todos deberían ser configuración por entidad/jurisdicción):** inicio `-01-01` y fin `-12-31` (`:515`) — **ley** para MX (CFF 11), **quemado → configuración** para US; doce meses (`:518`) — **quemado → configuración**; `is_calendar_year = true` (`:514`) — **quemado**; tipo `'regular'` (`:529`) — **quemado** (periodo 13); idioma `'en-US'` de los nombres (`:534`) — **quemado → panel**; rango 1900-2999 (`:551`) — **casa**; «meses pasados nacen abiertos» (`:521-524`) — **casa**.

#### 1.12.a Cerrojo `locked` de periodos y cierre de `fiscal_years` · **inerte**

`fiscal_periods.status = 'locked'` tiene lectores (`reopenClosedPeriod`, `fiscal-calendar-service.ts:248-254`; `posting.ts:100-110`; `getAuxiliaryView`, `report-service.ts:1078`) y el CLI lo presenta como «su información ya salió del sistema (dictamen, declaración anual)» (`fiscal-calendar-service.ts:215-217`), pero **cero escritores**: `restorePeriodStatus` (`:302-318`) sólo admite `soft_close|hard_close`; REST `src/api/rest/routes/fiscal-periods.ts:51,62` sólo `soft-close|hard-close`; `period-command.ts` no tiene `lock`. `hard_close` sí se escribe (`period-close.ts:745`). `UPDATE fiscal_years`: 0 en `src/` — nadie pone `fiscal_years.status = 'closed'`. El estado existe como promesa y no como acto.

#### 1.12.b Mes de inicio del ejercicio — `legal_entities.fiscal_year_start_month` (`001:89`) · **inerte** — *hallazgo del verificador*

Columna con CHECK 1-12 y default 1; en `src/` sólo `src/types/index.ts:904`. Ningún escritor (el `INSERT` de `entity-service.ts:236-245` no la incluye) ni lector (ni el resolutor de §1.1 ni `ensureFiscalYear`). El esquema ya admite el mes de inicio del ejercicio (IRC §441(e)) y todo el subsistema lo ignora.

### 1.13 Conmutador de jurisdicción — `src/services/accounting/pais-contable.ts:35` (`esContabilidadMexicana`) · **parcial** · sólo distingue «México / no México»

**Implementa:** `accounting_standard === 'mx_nif'` → México (`:39`); país vacío, nulo, desconocido o `MX` → México (`'' || 'MX'`, `:43`); sólo un país declarado distinto de `MX` saca del estrato. Consumidores: `entity-accounting.ts:75` (qué catálogo se siembra: `catalogoBasePara(esMexicana)`, `chart-seed.ts:142-145`, binario) y `:172` (qué roles se diagnostican).
**Por definir — ambas:** (a) el CHECK admite `'us_gaap' | 'mx_nif' | 'ifrs'` (`001:87-88`) y el conmutador colapsa `us_gaap` e `ifrs`; IFRS no tiene tratamiento propio en ningún sitio — colapso hoy teórico, porque ninguna puerta puede escribir `'ifrs'` (§0.3). (b) Tres copias inline del conmutador con reglas de borde distintas (§0.2): la unificación que `:4-9` anuncia no se completó. (c) No existe «jurisdicción de informes» que devuelva `nif | nif_2028 | us_gaap | ifrs` (`statement layout install --norms`, 🟡 `cli-command-catalog.md:2283`). (d) Los defaults del DDL contradicen al conmutador (`001:86-87` vs `:43`), sin puerta que lo active.
**Parámetros:** `'mx_nif'` (`:39`) y `'MX'` (`:43`) — **casa**; el defecto «ante la duda, mexicana» (`:19-24`, `:43`) — **casa**, hoy inalcanzable.

### 1.14 Panel de políticas — `src/services/policy/pending-catalog.ts:40` (39 claves), `src/services/policy/policy-service.ts:106` (`getPolicy`) · **parcial** · sin dimensión de jurisdicción

**Implementa:** catálogo con pregunta, impacto, opciones, default y justificación (`pending-catalog.ts:14-38`); siembra idempotente a nivel inquilino o entidad (`policy-service.ts:47-68`); resolución `valor resuelto > default en BD > default del catálogo` acotada a la entidad (`:100-161`); rechazo de respuesta en blanco (`:202-208`); compuerta de evidencia para `ingest_auto_post = on` (`:216-231`; constantes `FLOOR_SOMBRA_DIAS = 7`, `FLOOR_SOMBRA_ACUERDO = 0.9`, `FLOOR_SOMBRA_VEREDICTOS = 10` en `src/ai/floor.ts:78-80`, importadas en `policy-service.ts:5`); decisión escrita en el mismo alcance que se midió (`:238-265`); vista previa con datos propios (`src/services/policy/policy-preview.ts:41-192`). 39 claves (grep `key: '`: 39); categorías 25 contable, 5 fiscal, 6 operativa, 3 seguridad. Todas con lector real, verificado clave por clave:

| Clave (línea) | Categoría | Jurisdicción del texto | Norma/ley que la ata | Lector |
|---|---|---|---|---|
| `catalogo_entidad_no_mexicana` (50) | contable | la única consciente de país | — | `entity-accounting.ts:84` |
| `base_depreciacion` (104) | contable | universal con etiqueta MX | NIF C-6 vs LISR arts. 31-38 | `src/services/assets/asset-service.ts:545`, `src/services/assets/depreciation.ts:184` |
| `convencion_primer_mes` (132) | contable | universal con etiqueta MX (cita LISR); opciones `mes_completo \| proporcional_dias` (`:129-158`), sin half-year/mid-quarter | LISR meses completos; US: MACRS §168(d) | `asset-service.ts:558`, `depreciation.ts:185` |
| `depreciacion_faltante_al_cierre` (160) | operativa | neutral | — | `src/services/assets/depreciation-plan.ts:224` |
| `umbral_capitalizacion_mxn` (186) | contable | MX (MXN en la clave; `$5,000 … $50,000` sin moneda en `:186-198`) | política interna; US: de minimis safe harbor Treas. Reg. §1.263(a)-1(f) | `src/services/xml-ingestion/pre-registration-service.ts:764` |
| `politica_restaurantes` (208) | fiscal | MX | LISR art. 28-XX (8.5 %); US: IRC §274(n) 50 % | `pre-registration-service.ts:765` |
| `tratamiento_ieps` (229) | fiscal | MX | LIEPS art. 4 | `pre-registration-service.ts:766` |
| `lleva_inventarios` (250) | contable | neutral (texto habla de CFDI) | NIF C-4 / ASC 330 | `pre-registration-service.ts:767` |
| `cfdi_periodo_cerrado` (271) | contable | MX | CFDI | `pre-registration-service.ts:777` |
| `rep_pago_no_registrado` (302) | contable | MX | CFDI tipo P; LIVA art. 5-III | `src/services/xml-ingestion/rep-linkage.ts:285` |
| `rep_tolerancia_importe` (330) | contable | MX | REP | `rep-linkage.ts:206` |
| `rep_documento_desconocido` (355) | fiscal | MX | LIVA art. 5-III | `rep-linkage.ts:167` |
| `rep_ventana_dias` (380) | operativa | MX | REP | `rep-linkage.ts:208` |
| `amortizacion_anticipados_convencion` (403) | contable | neutral | NIF A-2 / ASC 340 | `src/services/accruals/prepaid-service.ts:249`, `src/services/accruals/amortization-run.ts:167` |
| `amortizacion_faltante_al_cierre` (428) | contable | neutral | — | `prepaid-service.ts:657` |
| `umbral_anticipado_mxn` (451) | contable | MX, **moneda explícita** (`'5,000 MXN'`, `'20,000 MXN'`, `:459-460`; `:468-469`) | NIF A-4 materialidad | `prepaid-service.ts:250` |
| `dias_aguinaldo` (474) | contable | MX | LFT art. 87 | `src/services/payroll/mx/finiquito-calculator.ts:101` |
| `prima_vacacional_pct` (496) | contable | MX | LFT art. 80 | `finiquito-calculator.ts:105` |
| `flujo_efectivo_metodo` (516) | contable | neutral; opción `directo` inerte (§1.9) | NIF B-2 / ASC 230 | `cash-flow-service.ts:164` |
| `flujo_efectivo_cuentas_de_efectivo` (545) | contable | neutral | NIF B-2 / ASC 230 | `cash-flow-service.ts:165`, `cash-flow-reconcile.ts:384` |
| `flujo_efectivo_descuadre` (569) | contable | neutral | — | `cash-flow-service.ts:166`, `cash-flow-reconcile.ts:619` |
| `informes_asientos_de_cierre` (595) | contable | neutral | — | `criterio-cierre.ts:76` |
| `destino_del_resultado_del_ejercicio` (625) | contable | universal con etiqueta MX (LGSM, cuenta 3300) | LGSM art. 19; US: retained earnings | `period-close.ts:1105`; valor `dos_pasos_hasta_asamblea` en `:982,1006-1011` |
| `cierre_recierre_de_periodo_reabierto` (652) | contable | neutral | NIF B-1 / ASC 250 | `period-close.ts:1106` |
| `severidad_resultado_sin_barrer` (680) | contable | neutral | — | `period-close.ts:1107` |
| `fuente_tipo_cambio` (708) | contable | MX: opciones `dof \| fix_banxico \| manual` (`:708-731`; `src/services/fx/rate-service.ts:57-60`) aunque `exchange_rates.source` admite además `'fed'`, `'ecb'`, `'xe'`, `'openexchangerates'` (`001:383`; `057:30`) y `FUENTES_DE_TIPO` los lista (`rate-service.ts:41-42`) | CFF art. 20; US: Fed H.10, IRS yearly average | `rate-service.ts:288` |
| `rep_moneda_extranjera` (733) | contable | MX | REP; NIF B-15 | `rep-linkage.ts:134` |
| `efirma_max_accesos_diarios` (760) | seguridad | MX | e.firma SAT | `src/services/fiscal-credentials/service.ts:259` |
| `efirma_accion_anomalia` (782) | seguridad | MX | e.firma SAT | `fiscal-credentials/service.ts:264` |
| `ingest_auto_post` (808) | operativa | neutral | — | `src/ai/ingest-thresholds.ts:67` |
| `ingest_auto_post_max_monto` (831) | operativa | neutral (`$5,000 … $50,000` sin moneda, `:831-840`) | — | `ingest-thresholds.ts:118` |
| `rep_faltante_recibido` (861) | fiscal | MX | REP / LIVA 5-III | `period-close.ts:559` |
| `rep_faltante_emitido` (885) | fiscal | MX | REP | `period-close.ts:560` |
| `segregacion_de_funciones` (913) | seguridad | neutral | control interno | `posting.ts:357`, `src/services/banking/reconciliation-service.ts:2334` |
| `conciliacion_tolerancia` (943) | contable | neutral | — | `reconciliation-service.ts:895` |
| `linea_banco_sin_partida_al_cierre` (969) | contable | neutral | — | `period-close.ts:375`, `reconciliation-service.ts:896` |
| `cotejo_umbral_confianza` (998) | operativa | neutral | — | `src/services/banking/matching.ts:587` |
| `cotejo_monto_maximo_auto` (1026) | operativa | neutral (`$10,000 … $50,000` sin moneda, `:1026-1038`) | — | `matching.ts:588` |
| `pago_corto_residual` (1055) | contable | neutral (cuenta 5200 del estrato universal) | — | `src/services/payments/payment-service.ts:1527` |

**Conteo:** 21 claves con texto mexicano (de las cuales al menos 3 son bifurcaciones universales mal etiquetadas), 18 neutrales, 0 estadounidenses, 1 consciente de país. Ninguna puerta vuelca el panel a una nota de políticas contables: familia `disclosure` ❌ (`docs/cli-command-catalog.md:2453-2459`).

**Por definir — el panel por jurisdicción que no existe.** Con la regla de la casa («una bifurcación de criterio contable no se elige en el código: se declara en el panel con su lector»), estas bifurcaciones están hoy decididas en código y deberían ser claves con dimensión de jurisdicción (o al menos `aplica_a: MX | US | ambas` para no preguntarlas donde no aplican):

1. `marco_de_presentacion` (`nif | nif_2028 | us_gaap | ifrs`) — implícito en `accounting_standard`, no leído por ningún informe.
2. `tipo_de_calendario` (`natural | fiscal_cierre_mes_N | 52_53_semanas | 4_4_5`) y `periodo_13_de_ajuste` — quemados en `fiscal-calendar-service.ts:513-529`; `fiscal_year_start_month` ya existe en el esquema (§1.12.b). Para MX la respuesta es obligatoriamente «natural» (CFF art. 11): la clave necesita saber la jurisdicción para restringir sus opciones.
3. `idioma_de_nombres_de_periodo` — quemado `'en-US'` (`:534`).
4. `estado_resultados_presentacion` (`por_funcion | por_naturaleza`) y sus subtotales (NIF B-3; ASC 220 / Reg. S-X 5-03).
5. `flujo_intereses_dividendos_seccion` — NIF B-2 vs ASC 230-10-45-15/16/17 (§1.9).
6. `flujo_efectivo_restringido_en_total` — ASU 2016-18 sí; NIF B-2 revelación.
7. `flujo_mapa_categorias` — `fs_category → sección` (`cash-flow-service.ts:406-426`), planeada como `cashflow category set`.
8. `tolerancia_de_cuadre` — `'0.01'` en `report-service.ts:368`, `materialized-view-service.ts:147`, `period-close.ts:459-461`; debería depender de la moneda funcional.
9. `comparativos` (`ninguno | periodo_anterior | mismo_periodo_ano_anterior`) — sin motor.
10. `moneda_de_informe` y `metodo_de_conversion` (NIF B-15 / ASC 830) — sin motor.
11. `convencion_primer_mes` con opciones US (half-year / mid-quarter): MACRS existe como método de depreciación (`src/database/enums.ts:164`, `src/types/index.ts:161`, `macrs_class` en `depreciation-plan.ts:312`), no como convención del panel.
12. `fuente_tipo_cambio` con opciones `fed_h10 | irs_yearly_average | manual`: la fuente US existe en el dato (`001:383`; `057:30`) y no en el panel.
13. Las claves mexicanas con `aplica_a: MX` para que `seedPolicies` no las siembre a una entidad US, y sus gemelas US —`umbral_capitalizacion_usd` con el safe harbor §1.263(a)-1(f), `politica_comidas_50pct` §274(n)— que no existen (grep `274(n)|50% deductible`, `de minimis|safe harbor|1.263|2500` en `src/services`: 0). Las tres universales mal etiquetadas necesitan reetiquetado, no gemela.

**Parámetros en el panel y su vista previa:** `money(n, currency = 'MXN')` (`policy-preview.ts:26`) — **quemado → moneda funcional de la entidad**; candidatos `[5000, 20000, 50000]` (`:47`) y `[5000, 10000, 50000]` (`:103`) — **casa**, en MXN implícito; `0.085`/`0.915` (`:143-144`) — **ley** (LISR 28-XX), quemada; `receptor_rfc` y `cfdi_nomina` como población (`:33-34`) — **quemado** MX; `ILIKE '%inventario%'` (`:119`) y nombres de restaurante en español (`:134-135`) — **quemado** MX; el texto «≥7 days, ≥10 decided, ≥0.90» (`:85`) repite en prosa `FLOOR_SOMBRA_*` (`src/ai/floor.ts:78-80`) — duplicado, hoy coincidente; `$` sin moneda en `pending-catalog.ts:186-198`, `:831-840`, `:1026-1038` — **quemado** (implícito MXN).

**Recuento de §1:** completos 7 (1.2.a, 1.2.b, 1.5, 1.6.a, 1.8, 1.10, 1.11) · parciales 10 (1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.9, 1.12, 1.13, 1.14) · inertes 2 (1.12.a, 1.12.b) · ausentes 22 (A1-A22 en §3 y §4).

---

## 2. Parámetros quemados consolidados

Ninguno de los siguientes vive en `tax_tables`/`tax_parameters` (`008_payroll.sql:354,375`; `009_tax_tables_2026.sql`: sólo nómina) ni en el panel; verificado por el escéptico.

| Parámetro | Dónde está | Origen hoy | Debería ser | Jurisdicción |
|---|---|---|---|---|
| Regex de periodo y aritmética de trimestre (año natural) | `report-service.ts:74-76`, `:117-121`, `:123-127` | quemado | configuración por entidad (`fiscal_year_start_month`) | US |
| Tolerancia de cuadre `'0.01'` | `report-service.ts:368`; `materialized-view-service.ts:147`; `period-close.ts:459-461` | quemado (3 copias) | panel, dependiente de moneda funcional | ambas |
| `account_level` por omisión `'5'` (REST) | `src/api/rest/routes/reports.ts:68` | casa | casa | ambas |
| Rótulos de sección en inglés (`Assets`, `Liabilities`, `Equity`, `Result Of The Period`, `Revenue`, `Expenses`) | `report-service.ts:552-554`, `:561-568`, `:673` | quemado | layout por norma/idioma | ambas |
| `contra_revenue` inexistente en el CHECK | `report-service.ts:527` vs `001:110-113` | valor muerto | eliminar o añadir al dominio | ambas |
| Estados «abierto» de CxC/CxP | `report-service.ts:856-857`; literales repetidos en `:880`, `:902` | casa, duplicada | una sola constante | ambas |
| Cortes de cubeta 30/60/90 | `src/cli/report-command.ts:724-728` | quemado (sólo CLI) | panel; motor | ambas |
| Criterio «inicial confiable» (`hard_close \| locked`) | `report-service.ts:1078` | casa | casa | MX |
| `CRITERIO_POR_OMISION` | `criterio-cierre.ts:40` vs `pending-catalog.ts:612` | panel, duplicado | importar del catálogo | ambas |
| `POLITICAS_POR_OMISION` | `cash-flow-service.ts:91-95` vs `pending-catalog.ts:533,558,581`; tercera copia `cash-flow-reconcile.ts:384` | panel, triplicado | importar del catálogo | ambas |
| `SUBTIPOS_DE_EFECTIVO` (6 vs 3) | `cash-flow-service.ts:192-199` vs `cash-flow-reconcile.ts:56` | quemado, divergente | un solo sitio (tabla o panel) | ambas |
| Rol `'banco'` / `ROLES_DE_EFECTIVO` | `cash-flow-service.ts:257` vs `cash-flow-reconcile.ts:47` | casa, duplicada | una sola constante | ambas |
| Mapa `fs_category → sección` del flujo | `cash-flow-service.ts:406-426` | quemado | panel (`cashflow category set`) | ambas |
| Sección de intereses/dividendos por `account_type` | `cash-flow-service.ts:409-411` | quemado | panel con jurisdicción (NIF B-2 vs ASC 230) | ambas |
| Segundo clasificador `categoriaDe` | `cash-flow-reconcile.ts:463-478` | quemado, distinto del estado | un clasificador | ambas |
| `limite * 4` | `cash-flow-reconcile.ts:558` | casa | casa | ambas |
| `REPORTING_VIEWS` | `materialized-view-service.ts:40` (espejo de `031`) | casa | casa | ambas |
| Inicio `-01-01`, fin `-12-31`, `is_calendar_year = true` | `fiscal-calendar-service.ts:514-515` | ley (MX, CFF 11) / quemado (US) | configuración por entidad | ambas |
| Doce meses, tipo `'regular'` | `fiscal-calendar-service.ts:518`, `:529` | quemado | configuración (periodo 13) | US |
| Idioma `'en-US'` de nombres de periodo | `fiscal-calendar-service.ts:534` | quemado | panel | ambas |
| Rango 1900-2999; «meses pasados nacen abiertos» | `fiscal-calendar-service.ts:551`, `:521-524` | casa | casa | ambas |
| `'mx_nif'`, `'MX'`, «ante la duda, mexicana» | `pais-contable.ts:39`, `:43`, `:19-24` | casa | conmutador de 3-4 vías por informes | ambas |
| Tres copias inline del conmutador | `iva-ppd-reclass.ts:101`; `iva-cash-basis.ts:310`; `doctor-service.ts:190` | quemado, con bordes distintos | `esContabilidadMexicana` | ambas |
| `money()` con `'MXN'` por omisión | `policy-preview.ts:26` | quemado | moneda funcional | ambas |
| Candidatos `[5000,20000,50000]`, `[5000,10000,50000]` | `policy-preview.ts:47`, `:103` | casa (MXN implícito) | casa por moneda | MX |
| `0.085` / `0.915` | `policy-preview.ts:143-144` | ley (LISR 28-XX), quemada | tabla con vigencia | MX |
| `receptor_rfc`, `cfdi_nomina`, `ILIKE '%inventario%'`, nombres de restaurante | `policy-preview.ts:33-34`, `:119`, `:134-135` | quemado | población por jurisdicción | MX |
| «≥7 days, ≥10 decided, ≥0.90» en prosa | `policy-preview.ts:85` vs `src/ai/floor.ts:78-80` | duplicado | interpolar las constantes | ambas |
| `$` sin moneda en etiquetas del catálogo | `pending-catalog.ts:186-198`, `:831-840`, `:1026-1038` | quemado (MXN implícito) | etiqueta con moneda (como `:459-460`) | ambas |
| Opciones de `fuente_tipo_cambio` (3 de 7 fuentes del dato) | `pending-catalog.ts:708-731`; `rate-service.ts:41-42,57-60`; `001:383`; `057:30` | panel, incompleto | panel con opciones por jurisdicción | US |

---

## 3. Lo que Estados Unidos exige y no existe

Los identificadores A-n son únicos entre §3 y §4; un motor que ambas jurisdicciones exigen se lista una vez con su id y se referencia en la otra sección.

| Id | Motor | Norma | Evidencia |
|---|---|---|---|
| A1 | Estado de cambios en el capital contable (incl. ORI acumulado) | ASC 505-10-50-2; Reg. S-X 3-04 | `statement equity show` ❌ (`docs/cli-command-catalog.md:2279`); `Manual-Reportes-y-entregables.md:319` |
| A2 | Estado de resultado integral / ORI | ASC 220-10-45 | un solo escalón (`report-service.ts:662-717`); grep ORI/OCI en `src/**/*.ts`: 0 |
| A3 | Notas a los estados y bases de preparación (políticas reveladas, negocio en marcha, comparativos, frecuencia) | ASC 235; ASC 205-10 | familia `disclosure` ❌ (`catalog:2453-2459`); el panel (39 claves) es la fuente natural y ninguna puerta lo vuelca |
| A4 | Comparativos | ASC 205-10-45-2; Reg. S-X 3-01/3-02 | `statement diff` ❌ (`catalog:2280`); `Manual:320`; cada informe es de un corte |
| A5 | Conversión de moneda extranjera en los estados | ASC 830 | grep `currency|exchange` en `src/services/reporting/`: 0 |
| A6 | Impuestos diferidos | ASC 740 | grep `deferred tax|ASC 740`: sólo `src/ai/tools/docs-tools.ts:40` |
| A7 | Estimación de pérdidas crediticias esperadas sobre el aging | ASC 326 (CECL) | sin provisión (§1.6); las cubetas existen sólo en CLI (`report-command.ts:722-729`) |
| A8 | Calendario de obligaciones (Form 941 trimestral; 1120/1065 §6072; 1099-NEC; sales tax) | IRC §6072 y reglamentos | `obligation *` ❌ (`catalog:2077-2080`); los formularios 941/940/W-2/W-3/EFW2 **sí** tienen motor y REST (`src/api/rest/routes/payroll.ts:29-31,291-333`), lo que falta es la fecha límite; `is_1099_vendor` existe |
| A9 | Marco de presentación por norma fechada (`nif \| nif_2028 \| us_gaap \| ifrs`) y layout de estados | ASC 205/220 vs NIF | `statement layout install --norms` 🟡 (`catalog:2283`); `pais-contable.ts:35-44` sólo contesta «México o no»; `nif-registry.json` no existe |
| A10 | Hechos posteriores y evaluación de negocio en marcha | ASC 855; ASC 205-40 | grep `subsequent event|going concern|negocio en marcha` en `src/`: 0; sin fecha de autorización de emisión en el esquema |
| A11 | Reexpresión retrospectiva de comparativos / restatement | ASC 250 | `statement restatement generate` ❌ (`catalog:2282`) |
| A12 | Año fiscal no natural, 52-53 semanas, periodo 13 de ajuste | IRC §441(b),(e),(f); Treas. Reg. §1.441-1 | `fiscal-calendar-service.ts:513-529` sólo enero-diciembre en doce meses; `fiscal_year_start_month` (`001:89`) inerte |
| A13 | Balance clasificado con regla de 12 meses/ciclo operativo y compensación | ASC 210-10-45; ASC 210-20 | sólo `fs_category` heredado del catálogo (`report-service.ts:479-495`) |
| A14 | Consolidación de entidades del mismo inquilino | ASC 810 | esquema `consolidation` rechazado por falta de columna (`account-service.ts:461`) |
| A15 | Panel con claves US y filtro de siembra por jurisdicción (safe harbor §1.263(a)-1(f), comidas 50 % §274(n), fuente de tipo de cambio Fed/IRS, convención MACRS) | Treas. Reg.; IRC | gemelas: grep 0 en `src/services`; `seedPolicies` sin filtro (`policy-service.ts:47-68`); fuentes US en el dato y no en el panel (§1.14) |
| A16 | DISE y UPA (sólo emisoras públicas; fuera de alcance PyME) | ASC 220-40 (ASU 2024-03); ASC 260 | sin motor ni esquema de categoría por cuenta |

Además, **parciales** (motor existe, renglón falta — §1.9): saldos inicial y final de efectivo en el cuerpo del estado (ASC 230-10-45-24) ausentes de la ruta REST; intereses e impuestos pagados (230-10-50-2); efecto FX (230-10-45-18); efectivo restringido (ASU 2016-18); método directo con conciliación (230-10-45-30).

## 4. Lo que México exige y no existe

| Id | Motor | Norma | Evidencia |
|---|---|---|---|
| A17 | Balanza de comprobación de cuatro columnas **como documento**, con `SaldoIni` y naturaleza | CFF art. 28-IV; RCFF art. 33-B; RMF 2.8.1.x; Anexo 24 apartado C | la balanza publica tres (`report-service.ts:242-250`); por cuenta sí existen las cuatro (`account-service.ts:399-440`, §1.2.a), invariante verificada (`ledger-checks.ts:143-185,188-256`, §1.2.b), `normal_balance` existe (`001:132`; `010:23,43`); `--shape 4col` no implementado (`catalog:2296`) |
| A18 | XML de contabilidad electrónica (`CtaCatalogo`, balanza mensual y de cierre, pólizas, `AuxiliarCtas`, `RepAuxFol`) y auxiliar de folios con UUID/RFC/método de pago por línea | Anexo 24 apartados A-E; RCFF 33-B | grep `AuxiliarCtas|RepAuxFol|BalanzaComprobacion|CtaCatalogo`: 0; `Manual:264`; `e-accounting` ❌ (`catalog:2058-2068`); `journal_entry_lines` sin `cfdi_uuid` (`catalog:2018`). El agrupador y su compuerta de cobertura sí existen (`account-service.ts:453-457`, `account map check`) |
| A19 | Estado de resultados con los subtotales de NIF B-3 (bruta, operación, RIF, antes de impuestos, impuestos, neta, ORI, integral) y **PTU** causada y diferida | NIF B-3; NIF D-3; LFT 117-131 | un solo escalón (`report-service.ts:662-682`); `fs_category` proyectado y no leído (`:633`); grep PTU en `src/**/*.ts`: 0 (`nif-registro.md:112` prosa) |
| A1 | Estado de cambios en el capital contable, con capital contribuido/ganado | NIF B-4; NIF C-11 | ver §3; `fs_category` de capital es un solo valor `'equity'` (`001:116-121`; `chart-seed.ts:61-65`) |
| A2 | Resultado integral y ORI | NIF B-3 | ver §3 |
| A3 | Notas y bases de preparación | NIF A-1; NIF B-1 nueva (2028) | ver §3 |
| A4 | Comparativos | NIF A-1; B-1 nueva | ver §3; `Manual:320` |
| A9 | Layout NIF 2028 (B-3 nueva / NIIF 18: categorías, MPM, agregación) y registro `nif-registry.json` con vigencia | NIF B-1/B-3 nuevas, vigentes 1-ene-2028 | sólo prosa (`nif-marco.md:121-125`); `plan-cierre-brechas.md:8074` lo pide; `ls src/ai/docs/`: sólo `ifrs-registry.json` |
| A20 | Ejercicio irregular (constitución después del 1 de enero; liquidación) | CFF art. 11, segundo párrafo | `ensureFiscalYear` no lee fecha de constitución; siempre 1-ene → 31-dic (`fiscal-calendar-service.ts:513-515`) |
| A8 | Calendario de obligaciones (balanza electrónica RMF 2.8.1.x; pagos provisionales LISR 14 y definitivos LIVA 5-D el 17; DIOT LIVA 32; anual LISR 9) | CFF; LISR; LIVA; RMF | ver §3; DIOT sólo como «bloqueador» en `src/cli/vendor-command.ts:108,178,347` |
| A5 | Conversión de moneda en los estados | NIF B-15 | ver §3 |
| A21 | Reexpresión y evaluación del entorno inflacionario (serie INPC) | NIF B-10 | `nif-registro.md:149` prosa; grep `INPC|reexpres` en `src/**/*.ts`: 0 |
| A6 | Impuestos diferidos | NIF D-4 | ver §3 |
| A7 | Estimación de pérdidas crediticias esperadas | NIF C-16 | ver §3 |
| A22 | Aplicación del resultado del ejercicio: reserva legal 5 % hasta el 20 % del capital, y segundo paso tras asamblea | LGSM arts. 19-20 | el panel decide sólo 3300 vs 3200 (`pending-catalog.ts:625-650`); `dos_pasos_hasta_asamblea` en `period-close.ts:982,1006-1011`; aviso en `src/services/accounting/validation.ts:332,338`; ningún motor de reserva 5 %/20 % ni puerta para el segundo paso |
| A10 | Hechos posteriores | NIF B-13 | ver §3 |
| A11 | Reexpresión retrospectiva de comparativos | NIF B-1 vigente | ver §3 |

Además, **parciales** (§1.9, NIF B-2): efectivo al inicio y al final dentro del estado (REST no lo trae), efectos por cambios en el valor del efectivo, revelación de intereses/dividendos/impuestos, sección de intereses y dividendos según B-2 (hoy decidida por `account_type`). Y **inerte** (§1.12.a): el cerrojo `locked` para «la información ya salió: dictamen, declaración anual» no tiene conductor.

---

## 5. Puertas

| Motor | CLI | REST | GraphQL | Agente |
|---|---|---|---|---|
| Balanza (§1.2) | `report trial-balance show` (`src/cli/report-command.ts:265-275`) | `GET /v1/reports/trial-balance` (`src/api/rest/routes/reports.ts:67`) | `trialBalance` (`src/api/graphql/schemas/schema.ts:452`; tipos `:298-320`) — *omitida en el original* | `get_trial_balance` (`src/ai/tools/report-tools.ts:49`) |
| Saldos de cuatro columnas por cuenta (§1.2.a) | `ledger balance show` (`src/cli/ledger-command.ts:244-272`); `account balance show` (`src/cli/account-command.ts:519-528`) | — | — | — |
| Invariante y encadenamiento (§1.2.b) | `ledger check` (`ledger-command.ts:134,152`) | — | — | — |
| Balance general (§1.3) | `report balance-sheet show` (`report-command.ts:353-359`; sale 4 si no cuadra, `:416-426`) | `GET /v1/reports/balance-sheet` (`reports.ts:107`; sin `is_balanced`) | — (`balanceSheet` ya no está declarado; comentario `schema.ts:324`) | `get_balance_sheet` (`report-tools.ts:93`) |
| Estado de resultados (§1.4) | `report income-statement show` (`:432-438`) | `GET /v1/reports/income-statement` (`reports.ts:129`) | — | `get_income_statement` (`:137`) |
| Mayor (§1.5) | `report general-ledger show` (`:486-494`); `entry line list` (`src/cli/entry-command.ts:32`) | `GET /v1/reports/general-ledger` (`reports.ts:259`) | — | `get_general_ledger` (`:245`) |
| Antigüedad CxC/CxP (§1.6) | `report aged-receivable\|aged-payable show` (`:569-575`; cubetas `:722-729`) | `GET /v1/reports/aged-receivables\|aged-payables` (`reports.ts:179,195`; sin cubetas) | — | `get_aged_receivables\|payables` (`:185,215`; sin cubetas) |
| Saldo CxC a fecha de corte (§1.6.a) | `invoice list --as-of` (`src/cli/invoice-command.ts:375-388`) | — | — | — |
| Auxiliar de cuenta XC (§1.7) | `ledger auxiliary show` (`ledger-command.ts:198-204`) | **sin puerta** | — | **sin puerta** |
| Criterio de cierre (§1.8) | dentro de las consultas; `pending define informes_asientos_de_cierre` | — | — | heredado por las herramientas |
| Flujo de efectivo (§1.9) | `cashflow generate` (`src/cli/cashflow-command.ts:335-346`) | `GET /v1/reports/cash-flow` (`reports.ts:243`; sin saldos inicial/final) | — | **sin puerta** (`report-tools.ts` tiene 6 herramientas, ninguna es el flujo; `src/ai/docs/reports.md:10-11` lo manda a REST y describe el motor viejo: «depreciation ± AR/AP changes; investing = fixed asset additions») |
| Amarre del flujo (§1.10) | `cashflow reconcile` (`src/cli/cashflow-reconcile-command.ts:156-166`) | **sin puerta** | — | **sin puerta** |
| Vistas materializadas (§1.11) | `report view show\|sync` (`report-command.ts:651-692`) | **sin puerta** | — | `sync` cerrado al agente (`materialized-view-service.ts:23`) |
| Calendario fiscal (§1.12) | `period list\|show\|open\|reopen` (`src/cli/period-command.ts:214-399`); `year list\|show\|create` (`:553-643`, `year create` `:636-682`); wizard `init` (`src/cli/init/s1-identity.ts:197-198`); sin `lock` | `GET /v1/fiscal-periods` (`src/api/rest/routes/fiscal-periods.ts:20`); `close-status`, `soft-close`, `hard-close` (`:38-62`) | `fiscalPeriods` (`schema.ts:454`); `softClosePeriod`/`hardClosePeriod` (`:479-480`); suscripción `periodClosed` **declarada sin resolutor** (`:490`; `src/api/graphql/permisos.ts:191`) | **sin puerta** |
| Panel de políticas (§1.14) | `pending`, `pending define\|dismiss\|reopen` (`src/cli/pending-command.ts:290-433`); wizard sección 4 (`src/cli/init/s4-policies.ts`) | **sin puerta** (`ls src/api/rest/routes/`: ningún `polic*`; grep `polic` en rutas: 0) | **sin tipo** de política en `schema.ts` | `get_accounting_policies`, sólo lectura (`src/ai/tools/policy-tools.ts:319-330`) |
| Conmutador de país (§1.13) | — (lo invoca `entity create`/`init` vía `entity-accounting.ts:75`) | — | — | — |
| Formularios US 941/940/W-2/W-3/EFW2 (fuera del subsistema; §3 A8) | — | `POST /v1/payroll/w2\|form-941\|form-940\|…` (`payroll.ts:291-333`) | — | — |

---

## 6. Lo que el escéptico refutó o corrigió

Lo que **no** hay que creerse del inventario original:

**Refutado (eliminado o invertido):**
1. «No hay cubetas de antigüedad (0-30, 31-60, 61-90, >90)». Falso en la puerta CLI: `bucketOf` (`src/cli/report-command.ts:722-729`) las adjunta a cada fila. Cierto para el motor, REST y agente.
2. «Falta la reconstrucción del saldo a la fecha de corte». Falso para CxC: `amount_due_as_of` (`src/services/ar/invoice-service.ts:164-178`) con puerta `invoice list --as-of`; el aging no lo usa. Cierto para CxP (`src/services/ap/ap-controls.ts:248-262`).
3. «`umbral_anticipado_mxn` (`pending-catalog.ts:451-470`) lleva `$` implícito MXN». Falso: etiqueta `'5,000 MXN'`, `'20,000 MXN'` (`:459-460`) y textos (`:468-469`). Las otras tres citas de `$` sin moneda (`:186-198`, `:831-840`, `:1026-1038`) se sostienen.

**Corregido (el hecho es otro, o el peso es otro):**
4. «El único conmutador» de jurisdicción. Tres copias inline sobreviven con bordes distintos (`iva-ppd-reclass.ts:101`, `iva-cash-basis.ts:310`, `doctor-service.ts:190`).
5. «Defaults contradictorios: una entidad creada sin país explícito es US GAAP para el esquema y mexicana para la siembra». Es un hecho del DDL sin puerta que lo active: `entity-service.ts:236-245` escribe siempre desde `COUNTRY_PROFILES`, `Country = 'MX' | 'USA'` (`:33`), y ninguna puerta deja el país vacío ni puede escribir `'ifrs'`. Deuda de esquema, no riesgo operativo.
6. «Form 941 … sin motor». El formulario tiene motor y puerta REST (`src/api/rest/routes/payroll.ts:29-31,299`); lo que falta es el calendario de vencimiento.
7. «No hay saldo inicial» (balanza). La balanza no lo publica, pero las cuatro columnas existen por cuenta con puerta (`account-service.ts:399-440`), la invariante del SAT se verifica (`ledger-checks.ts:143-185,188-256`) y `normal_balance` existe (`001:132`; `010:23,43`). Lo ausente es la balanza como documento.
8. «21 claves atadas a México». Al menos tres (`base_depreciacion`, `convencion_primer_mes`, `destino_del_resultado_del_ejercicio`) son bifurcaciones universales con etiquetas mexicanas; el remedio cambia (reetiquetar, no gemela).
9. «Lo que el esquema admite» para el calendario estaba incompleto en favor del propio reclamo: `legal_entities.fiscal_year_start_month` (`001:89`) también existe, y nadie lo lee ni lo escribe.

**Citas corregidas:**
10. `account-service.ts:460` → `:461` (`ESQUEMAS_SIN_COLUMNA`).
11. `cli-command-catalog.md:2298` → `:2296` (`report trial-balance show --shape 4col`).
12. `cashflow-command.ts:260-266` → `:255-268` (`filasDelAmarre`).
13. `policy-service.ts:5` → `src/ai/floor.ts:78-80` (`FLOOR_SOMBRA_*`; `:5` es el import).
14. `cli-command-catalog.md:2075-2078` → `:2077-2080` (`obligation *`).

**Corregido al fundir (no lo vio el escéptico; comprobado contra `4b1d8fe`):**
15. `docs/SCOPE.md:50` está vacía. El no-goal está en `:53` y **no dice** que «internacionalizar el motor contable no está en el plan»: dice que no es un motor «sin país», que la internacionalización va por paquetes de jurisdicción sobre un motor común, y que hoy hay dos paquetes: «México, completo; Estados Unidos, parcial (nómina)». Ambos informes llevaban la cita y la paráfrasis equivocadas.
16. `Manual-Reportes-y-entregables.md:317` (estado de cambios en capital) → `:319`; `:319` (comparativos) → `:320`. De paso: esa misma lista («Lo que todavía no sale», `:315-324`) sigue diciendo que el estado de flujos NIF B-2 no sale, cuando `cashflow generate` existe (`src/cli/cashflow-command.ts:335-346`); el manual está caduco en ese punto, como `src/ai/docs/reports.md:10-11`.

**Hallazgos nuevos incorporados** (marcados «hallazgo del verificador» en §1 salvo los dos últimos, que son de la fusión): `fiscal_year_start_month` inerte (§1.12.b); tercera copia del default `'rol'` (§1.9); puerta GraphQL `trialBalance` (§5); `*_OPEN_STATUSES` exportados y no usados en el SQL (§1.6); `getAccountBalanceByPeriod` y sus dos puertas (§1.2.a); invariante y encadenamiento en `ledger-checks.ts` con puerta `ledger check` (§1.2.b); `normal_balance` en `001` y `mv_trial_balance` (§1.2); `amount_due_as_of` con puerta y la imposibilidad para CxP (§1.6.a); tres copias inline del conmutador (§0.2); `Country = 'MX' | 'USA'` e `INSERT` desde `COUNTRY_PROFILES` (§0.3); formularios 941/940/W-2/W-3/EFW2 con motor y REST, e `is_1099_vendor` (§1.12); MACRS como método y no como convención (§1.14); `exchange_rates.source` con fuentes US que el panel no ofrece (§1.14); cero escritores de `locked` y quién sí escribe `hard_close` (§1.12.a); DIOT sólo como bloqueador (§4 A8); aplicación del resultado en `validation.ts` y `period-close.ts` sin motor de reserva legal (§4 A22); `tax_tables`/`tax_parameters` sólo contienen nómina (§2); el no-goal real de `SCOPE.md:53` (§0.6); el Manual caduco sobre el flujo B-2 (§6.16).

## 7. Lo que no se verificó

- Ni el original ni la verificación corrieron la base ni las pruebas; toda conducta es por lectura del SQL y del TypeScript.
- El escéptico no re-clasificó las 39 claves una por una; señaló tres cuya «mexicanidad» está en la etiqueta. La columna «jurisdicción del texto» de §1.14 hereda la clasificación del original para las 36 restantes.
- `period-close.ts` no se abrió completo (fuera del subsistema): se citan `:375`, `:459-461`, `:559-560`, `:740,825`, `:745`, `:982,1006-1011`, `:1105-1107`, `:1258,1288`, obtenidas por grep.
- Los números de párrafo de ASC y NIF y los artículos de ley se citan de memoria normativa, salvo NIF B-2 §40 y ASC 230-10-45-7/50-3 que el propio código cita (`cashflow-command.ts:271`, `:399`); deben cotejarse contra el texto vigente antes de convertirse en criterios del plan. En NIF B-2 no se afirma la sección exacta de intereses y dividendos.
- La fusión comprobó contra `4b1d8fe` las líneas corregidas por el escéptico y las puertas de los motores hallados bajo otro nombre; no re-abrió cada cita confirmada del original.
