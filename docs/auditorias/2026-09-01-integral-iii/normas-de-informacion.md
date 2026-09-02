# Lente 6 · Normas de Información Financiera (NIF / IFRS)

> Árbol: `/private/tmp/claude-501/…-62373f8f-aud` (cfe40c6 + los dos commits de documentación del PR 19).
> Rutas relativas al raíz. Todo `archivo:línea` fue abierto. Lo no comprobado se dice literalmente.
> La I y la II auditaron el fisco y el mayor. Esta lente pregunta otra cosa: **¿lo que sale de aquí son estados financieros?**

---

## LO QUE RESISTE

Audito también a favor, porque hay decisiones aquí que muchos sistemas comerciales no toman.

1. **La separación entre IVA de flujo y resultado devengado está bien hecha y es rara.** `src/services/accounting/ar-ap-posting.ts:34-41` documenta y `iva-cash-basis.ts` ejecuta la regla correcta: el **IVA** se causa y se acredita al cobrar/pagar (LIVA 1-B y 5-III), aparcado en 1135/2125 y liberado por el REP, **mientras el ingreso y el gasto se reconocen al facturar**. El sistema no confunde base de efectivo fiscal con base de efectivo contable. Es exactamente lo que NIF A-2 exige y lo que la mayoría de los despachos mexicanos hace mal.

2. **El balance general cuadra por construcción y lo dice.** `report-service.ts:505-547` inyecta el resultado no cerrado dentro de capital sumando cuentas de resultados **desde el inicio** (`queryUnclosedEarnings`, `:476-491`), lo que hace el estado inmune al doble conteo tras un cierre. Devuelve `is_balanced`/`out_of_balance` y el comando sale 4 si no cuadra. Es sólido.

3. **Los contra-activos NETEAN, no se suman en valor absoluto.** `buildBalanceSheetSection` (`report-service.ts:425-462`) usa `naturalSign` y el comentario declara el defecto que corrigió. `buildIncomeStatementSection` (`:604-628`) repite la disciplina y **nombra el caso exacto**: «abs() would inflate a section holding contra-natural rows, e.g. sales returns booked as revenue debits». Esa frase es la que hace que el hallazgo #4 duela.

4. **El sistema no promete la depreciación donde el usuario decide.** `cfdi-decisions.ts:100-105` etiqueta la opción como «capitalized; depreciation NOT computed by the system yet» y `tests/xml-ingestion/dep-promesa.spec.ts` la vigila con tres aserciones. `cfdi-classifier.ts:220-226` repite el aviso en el documento. Es la regla (d) de la casa aplicada bien.

5. **El inventario está declarado como cascarón, no disfrazado de motor.** `src/plan/criterios.ts:277-278` dice literalmente «el motor es neto nuevo (S0.4)». Verificado: **cero** archivos TypeScript tocan `inventory_items`, `inventory_layers` o `inventory_layer_consumption`. Rojo honesto.

6. **NIF B-10 no se está violando hoy, y conviene decirlo.** México es entorno **no inflacionario** (inflación acumulada trienal muy por debajo del 26 %), así que **no reexpresar es la respuesta correcta**. El hueco no es el asiento; es que el sistema no tiene la serie del INPC y por tanto **no puede evaluar en qué entorno está** — y el lado fiscal (LISR 31 y 44) la necesita de todos modos. El plan ya lo tiene como prerrequisito de F07.

7. **NIF B-1 está implementado de verdad**, con reversa enlazada en ambas direcciones y prohibición de editar posteado (`nif-validaciones.md`, `posting.ts:531`). Es la única NIF particular que este repositorio implementa completa.

---

## HALLAZGOS

### 1 · Los dos sembradores de catálogo chocan en cinco códigos, y el que gana es el equivocado — [NUEVA] · **ALTA**

`ensureEntityAccounting` siembra **en un solo acto y en este orden**: catálogo base (`entity-accounting.ts:62`), roles CFDI (`:67`), mapeo de nómina (`:77`). Ambos sembradores crean «sólo lo que falte» (`account-roles-seed.ts:206-207`; `payroll-account-mapping-seed.ts:200-201`), así que **el primero fija el significado del código y el segundo lo hereda sin mirarlo**.

Colisión calculada por script sobre las dos listas (`REQUIRED_ACCOUNTS` 17 filas vs `MX_PAYROLL_ACCOUNTS` 6 filas):

| Código | Lo crea el sembrador de ROLES (gana) | Lo quería NÓMINA | Bucket que queda mal apuntado |
|---|---|---|---|
| **5200** | «Devoluciones y Descuentos sobre Compras» *expense/**credit**/cogs* (`account-roles-seed.ts:126-129`) | «Sueldos y Salarios» *expense/debit/operating_expenses* (`payroll-…-seed.ts:43-46`) | `wages_expense` (`:77`) |
| **2150** | «Anticipos de Clientes» (`:95-98`) | «IMSS por Pagar» (`:55-58`) | `imss_payable` (`:81`) |
| **2160** | «Sueldos por Pagar» (`:100-103`) | «INFONAVIT por Pagar» (`:60-63`) | `infonavit_payable` (`:82`) |
| **2170** | «IMSS por Pagar» (`:105-108`) | «Otras Retenciones de Nómina» (`:65-68`) | `garnishment_payable` (`:83`) |
| **2180** | «IEPS por Pagar» (`:110-113`) | «Prestaciones por Pagar» (`:70-73`) | `benefits_payable` (`:84`) |

`gl-posting-service.ts:110-115` **carga** el bruto a `wages_expense`; `:148-150` **abona** IMSS a `imss_payable`.

**Escenario de fallo concreto.** Entidad MX, nómina mensual de 500 000 de bruto y 90 000 de cuotas IMSS (obrera + patronal). Tras postear: la cuenta que todo reporte llama **«Devoluciones y Descuentos sobre Compras» trae 500 000 de saldo deudor** en una cuenta de naturaleza acreedora y categoría `cogs`; **«Anticipos de Clientes» —pasivo por contrato bajo NIF D-1— trae 90 000 de cuotas de seguridad social**; y **«IMSS por Pagar», que sí existe (2170), recibe las pensiones alimenticias**. Conciliar IMSS contra SUA/IDSE es imposible — que es exactamente lo que el comentario de `payroll-…-seed.ts:15-18` dice que se quiso evitar.

**Sé preciso sobre el daño:** los **totales** de activo, pasivo, capital y resultado **NO se mueven** (todas las colisiones respetan `account_type` y `fs_category` salvo 5200, que sigue siendo `expense`). Lo que se rompe es la **composición y el nombre de cada renglón** — que es justo lo que un contador firma y lo que el Anexo 24 exporta con agrupador.

**Nada lo ve.** `doctor` sólo comprueba que los tres buckets obligatorios **existan** (`doctor-service.ts:238-247`), no a qué apuntan. La póliza cuadra, así que `ledger check --check balance` pasa. Y la prueba unitaria **no puede fallar por construcción**: `tests/services/payroll/payroll-account-mapping-seed.spec.ts:87` monta la entidad con `arrange(['1111','2130'], [])` —sólo los dos códigos del catálogo base— y `:69-81` valida los códigos **contra `BASE_CHART_MX` únicamente, nunca contra `REQUIRED_ACCOUNTS`**. Ningún test del árbol cruza las dos listas.

---

### 2 · `fixed_assets` no tiene un solo escritor, y por eso la casilla «Depreciation calculated and posted» del cierre es un verde estructural — [NUEVA, sobre E1.4 que sigue viva] · **ALTA**

`grep -rn "INSERT INTO fixed_assets" src` → **cero resultados** (lo dice también `cfdi-decisions.ts:96`). El único escritor de la tabla es un `UPDATE` dentro de `runMonthlyDepreciation` (`assets/depreciation.ts:359`), que a su vez **no tiene llamador** (E1.4, confirmado por `plan:status` y por `criterios.ts:1282-1285`).

Lo que la II y el tablero **no** miraron es la consecuencia de segundo orden:

```
period-close.ts:87-100
  SELECT COUNT(*) FROM fixed_assets fa WHERE fa.entity_id=$1 AND fa.status='active'
    AND NOT EXISTS (SELECT 1 FROM depreciation_schedules …)
  → checklist.push({ item: 'Depreciation calculated and posted', is_complete: undepCount === 0 })
```

La tabla está **siempre vacía** ⇒ `undepCount` es **siempre 0** ⇒ la casilla es **siempre verde**. Es un criterio de cierre que **ningún estado del mundo puede poner en rojo**: la misma patología de granularidad que la II encontró en el trinquete, pero dentro del checklist contable.

**Escenario de fallo.** Se capitalizan 1 200 000 de equipo de cómputo por la ruta CFDI (rol `activo_fijo` → cuenta 1210, `account-roles-seed.ts:155`). Vida NIF C-6 de 4 años ⇒ 25 000/mes. A los doce meses la depreciación acumulada debería ser 300 000. Es **cero**: activo sobrevaluado 300 000, gasto subvaluado 300 000, resultado sobrevaluado 300 000 — y **los doce cierres mensuales dijeron «Depreciation calculated and posted ✓»**. El mismo hueco anula la sección de inversión del flujo de efectivo (`api/rest/routes/reports.ts:227-239`, que lee `fixed_assets`): siempre 0.

El repositorio es honesto en la pantalla de decisión (ver «LO QUE RESISTE» #4) y miente en la pantalla de cierre. Las dos frases están en el mismo árbol.

---

### 3 · Los importes en moneda extranjera se contabilizan SIN convertir, la validación B-15 es inalcanzable, y `nif-validaciones.md` la anuncia como bloqueante — [NUEVA] · **ALTA**

Tres eslabones, verificados uno por uno:

- **El parser lee el tipo de cambio y nadie lo usa.** `cfdi-facts.ts:166` guarda `tipoCambio`. Los atajos de importe de la taxonomía (`cfdi-taxonomy.ts:63-70`: `subtotalNeto`, `total`, `ivaTrasladado`…) devuelven el **número crudo del CFDI**. `grep tipoCambio src/services/xml-ingestion/cfdi-taxonomy.ts` → nada. El único rastro es una **advertencia en prosa** (`cfdi-classifier.ts:211-216`) que además dice algo falso: «amounts are recorded in the functional currency». No lo son.
- **El motor de posteo no escribe las columnas de FX.** `journal_entry_lines` fue diseñada para multimoneda con `currency_code`, `foreign_debit`, `foreign_credit`, `exchange_rate` y un `CHECK` que las obliga a viajar juntas (`001_core_schema.sql:264-289`). El `INSERT` de `posting.ts:135-145` **no menciona ninguna de las cuatro**. Y la ruta manual las anula a mano: `journal-entry-service.ts:449` construye las líneas sintéticas con `currency_code: null`.
- **Por lo tanto `currencyRule` (`validation.ts:251-290`) no puede dispararse jamás.** Y `src/ai/docs/nif-validaciones.md`, la tabla «Validaciones que BLOQUEAN», la lista: *«currency · Moneda extranjera exige tipo de cambio y montos en ambas monedas, conversión aritméticamente correcta · NIF B-15»*. **Verde falso dentro de la base de conocimiento del agente**, en la misma familia que el `mexico-cfdi.md` caducado que encontró la II.

**Escenario de fallo.** CFDI emitido por **USD 10 000**, `TipoCambio="18.50"`. El sistema postea CxC **10 000** e Ingreso **8 620.69** + IVA **1 379.31** contra un catálogo denominado en pesos. El valor real es **MXN 185 000**. Ingreso subvaluado **~MXN 149 000 en una sola factura**; la póliza cuadra; el veredicto del clasificador es `ready` (la advertencia no es `blocking`, `cfdi-classifier.ts:236`), así que **es candidata a auto-posteo**. Y si el usuario le pregunta al agente si el sistema lo protege, el agente lee `nif-validaciones.md` y contesta que sí.

---

### 4 · El asiento de cierre usa el `.abs()` que el propio repositorio documentó como defecto: duplica devoluciones en vez de cancelarlas — [NUEVA] · **ALTA**

`generateClosingEntries` (`period-close.ts:416`, alcanzable por `close --hard` → `hardClosePeriod:270` → `:312`) cierra por **valor absoluto**:

```
period-close.ts:474  debit_amount: balance.abs().toFixed(4)   // ingresos
period-close.ts:478  totalRevenue = totalRevenue.plus(balance.abs())
period-close.ts:511  credit_amount: balance.abs().toFixed(4)  // gastos
period-close.ts:514  totalExpenses = totalExpenses.plus(balance.abs())
```

Pero el catálogo tiene **cuentas de resultados de naturaleza contraria** y son de uso ordinario: **4400 «Devoluciones y Descuentos sobre Ventas»** es `account_type: 'revenue'` con `normal_balance: 'debit'` (`account-roles-seed.ts:120-124`) y la **carga toda nota de crédito emitida** (`cfdi-taxonomy.ts:293-296`); **5200** es `expense` con `normal_balance: 'credit'` y la abona toda nota de crédito recibida (`:265`).

`report-service.ts:600-603` escribió la advertencia textual: *«abs() would inflate a section holding contra-natural rows, e.g. sales returns booked as revenue debits»*. El reporte lo respetó. **El cierre no.**

**Escenario de fallo, con números.** Ventas (4100) 1 000 000 al haber; devoluciones (4400) 100 000 al debe. Ingreso neto real: **900 000**.
- Cierre: carga 1 000 000 a 4100 ✓; **carga otros 100 000 a 4400** ✗ (debía abonarlos); abona 1 100 000 a Resumen de Ingresos y Gastos.
- Después del cierre: **4400 queda con 200 000 de saldo deudor** (no se limpió, se duplicó) y **«Resultado de Ejercicios Anteriores» queda sobrevaluado en 200 000**.
- La póliza **cuadra** (cargos = `totalRevenue` + `totalExpenses` = abonos), así que `ledger check --check balance` no la ve.
- El balance general **sí cuadra en total** porque `queryUnclosedEarnings` recoge el residuo de 4400 y lo mete como «Result Of The Period» de **−200 000** en un ejercicio ya cerrado — dos errores que se compensan en el total y se ven en la composición.
- Y **el estado de resultados del ejercicio cerrado, re-emitido después del cierre, reporta ingresos NEGATIVOS de 200 000**: 4100 netea a cero y sale por el `HAVING`; 4400 netea 200 000 al debe y con `naturalSign = -1` da −200 000 (`report-service.ts:588-592`, `:609-628`).

---

### 5 · El motor calcula las advertencias NIF en cada posteo y las tira a la basura — [NUEVA] · **MEDIA**

`validateJournalEntry` corre siete reglas y devuelve `{ isValid, errors, warnings }`. Las dos rutas de posteo leen **sólo `isValid`**:

```
posting.ts:177-182   const validation = await validateJournalEntry(entry, entryLines);
                     if (!validation.isValid) throw …        // warnings: nunca se leen
posting.ts:294-300   idéntico en postJournalEntry
```

`grep -n "warnings" src/services/accounting/posting.ts` → **cero coincidencias**. Las advertencias tienen un lector, pero es **manual, por póliza y bajo demanda**: `entry check <ref>` (`journal-entry-service.ts:386-388` → `cli/entry-command.ts:1011`). No hay barrido, y **`getPeriodCloseStatus` (`period-close.ts:22-190`) no llama a `validateJournalEntry` en ninguna de sus siete casillas**.

Lo que se pierde es precisamente lo que esta lente busca:
- `accountTypeRule` (`validation.ts:120-155`) — cargo/abono **contra-natural**. Es la regla que habría gritado en el hallazgo #1 (cargar el bruto de nómina a una cuenta acreedora) y en el #4 (cargar de nuevo 4400).
- `nifSubstanceRule` (`validation.ts:296-342`) — ingreso abonado en póliza que menciona «anticipo» (**NIF D-1**) y movimiento a capital contable (**NIF C-11**).

**Escenario de fallo.** La primera nómina de una entidad genera la advertencia *«Posting debit to account "expense" which normally has credit balance [NIF A-5…]»*. Se descarta en la línea 182. El mes cierra verde. La advertencia sólo aparece si alguien adivina el número de póliza y teclea `entry check` sobre ella.

*Matiz honesto:* `nifSubstanceRule` dispara C-11 en **toda** línea a capital, incluidas las pólizas de cierre que el propio sistema genera contra 3900 y 3200 — así que si mañana se surfacean sin filtro, el ruido será inmediato. La corrección es surfacearlas **con exención para `entry_type='closing'`**, no a secas.

---

### 6 · El estado de resultados no tiene estructura: ni utilidad bruta, ni resultado de operación, ni RIF, ni ORI — [NUEVA] · **MEDIA**

`queryIncomeStatementRows` **selecciona** `a.fs_category` (`report-service.ts:581`) y **agrupa** por ella (`:592`). `buildIncomeStatementSection` (`:609-628`) **no la usa**: filtra sólo por `account_type` y devuelve dos totales, `Revenue` y `Expenses`, y su resta.

Consecuencia bajo NIF B-3 y A-5: `4300 Otros Ingresos` (`fs: other_income`) se suma a las ventas; `5100 Costo de Ventas` (`fs: cogs`) y `6300 Gastos Financieros` (`fs: other_expenses`) se suman a los gastos de operación. **No se puede calcular margen bruto ni resultado de operación**, y el **Resultado Integral de Financiamiento** no existe como renglón. El catálogo de comandos ya lo dice de la otra mitad: *«el ORI no existe en ninguna ruta ni servicio»* (`docs/cli-command-catalog.md:2270`).

Empeorado por el enrutamiento de la diferencia cambiaria: `utilidad_cambiaria → 4300` y `perdida_cambiaria → 6300` (`account-roles-seed.ts:179-180`) — las dos mitades de **un solo concepto** repartidas en dos secciones distintas, imposibles de netear.

**Escenario de fallo.** Entidad con 1 000 000 de ventas, 600 000 de costo de ventas y 500 000 de utilidad por venta de un activo fijo. El estado imprime **«Revenue 1 500 000»**. Un lector no puede saber si el negocio gana dinero operando.

---

### 7 · El estado de flujos de efectivo nunca amarra contra el efectivo — [II-SIGUE-VIVA, ampliada] · **ALTA**

La II lo encontró por el lado del idioma (`cierre-cobertura.md:139`, «B5 · el flujo devuelve cero en un catálogo en español»). **Verificado vivo en cfe40c6**: `reports.ts:210` y `:222` siguen filtrando con `a.name ILIKE '%receivable%'` / `'%payable%'` contra un catálogo cuyas cuentas se llaman «Cuentas por Cobrar» (`chart-seed.ts` 1120) y «Cuentas por Pagar» (2110). Cero coincidencias, siempre.

Lo que la II **no** midió, y es peor:

1. **El estado no reconcilia con nada.** No hay efectivo inicial, ni efectivo final, ni comprobación de que `net_cash_flow` iguale el movimiento de las cuentas de bancos. NIF B-2 (y ASC 230) exigen exactamente eso: el estado **explica el cambio en el efectivo**. Aquí es una lista de ajustes sin destino.
2. **Financiamiento cableado en `'0.0000'`** (`reports.ts:272`). Una aportación de capital o la disposición de un crédito **no aparecen nunca**, y por (1) nadie puede notarlo.
3. **La sección de inversión sale de otro libro.** Operación se deriva del mayor; inversión se deriva de la tabla `fixed_assets` (`:227-239`) que **no tiene escritor** (hallazgo #2). Dos secciones del mismo estado calculadas sobre dos fuentes, una de ellas vacía por construcción.
4. **El capital de trabajo son sólo CxC y CxP.** IVA acreditable (1130/1135), IVA trasladado (2120/2125), anticipos (1150/2150), pagos anticipados (1160) e inventarios **no entran**. En México el IVA por sí solo mueve el capital de trabajo más que muchos clientes.

**Escenario de fallo.** Ejercicio con utilidad de 200 000, cobranza de 1 800 000, pago a proveedores de 1 500 000 y una aportación de capital de 3 000 000. Los bancos suben 3 500 000. El estado imprime operación ≈ 200 000, inversión 0, financiamiento 0, **flujo neto 200 000** — y no hay renglón donde el faltante de 3 300 000 pueda aparecer.

---

### 8 · Sólo existen dos de los cuatro estados financieros básicos, y el que falta por norma está fuera del compromiso de diez sprints — [NUEVA] · **ALTA**

NIF A-3/A-5: un juego completo para una entidad lucrativa son **cuatro** estados **más las notas**. Inventario real de `src/services/reporting/report-service.ts`:

| Estado | Norma | Estado real |
|---|---|---|
| Balance general | NIF B-6 | ✅ `getBalanceSheet:505` |
| Estado de resultado **integral** | NIF B-3 | 🟡 `getIncomeStatement:641` — resultado sí, **integral no** (hallazgo #6) |
| Estado de **flujos de efectivo** | NIF B-2 | 🟡 sólo ruta REST, sin amarre, sin comando (hallazgo #7) |
| Estado de **cambios en el capital contable** | NIF B-4 | ❌ **no existe** |
| **Notas** | NIF A-5, A-7 | ❌ **no existe** — `disclosure_config` (`006_blockchain_integration.sql:51`) es de divulgación blockchain, no de notas |

El catálogo ya diagnosticó el B-4 con precisión (`docs/cli-command-catalog.md`, fila `statement equity show`: *«❌ ningún endpoint ni servicio lo produce»*) — y **lo puso en fase 2**. Como el compromiso del plan son las **379 filas de fase 1** («diez sprints para que un contador pueda llevar los libros enteros desde la terminal», `docs/plan-catalogo.md`), **el estado de cambios en el capital contable queda explícitamente fuera de lo que se promete entregar**.

**Escenario de fallo.** El contador termina los diez sprints, corre todo lo que el sistema ofrece y se sienta a firmar. Le faltan un estado obligatorio, las notas, y el dictamen sobre bases de preparación. No puede firmar.

---

### 9 · No existe motor de devengo: la pantalla ofrece «se devenga mes a mes» y nada lo devenga — [NUEVA] · **ALTA**

- **Gastos pagados por anticipado.** `cfdi-decisions.ts:129-130` ofrece *«Prepaid expenses (accrued month by month)»* con `basis: 'NIF A-2 (accrual accounting)'` (`:141`). El rol `gasto_anticipado` mapea a **1160 «Pagos Anticipados»**, cuya propia descripción dice *«se devengan mes a mes»* (`account-roles-seed.ts:67-70`). **Ningún código amortiza 1160**: `grep -rn "amortiz" src --include='*.ts'` fuera de `src/ai/docs` devuelve **una** línea, y es un comentario sobre créditos INFONAVIT (`payroll-…-seed.ts:62`).
- **No hay ninguna clase de asiento de ajuste automático.** `JournalEntryType.ADJUSTING` (`types/index.ts:54`) es sólo una **etiqueta que un humano elige** en una póliza manual (`journal-entry-service.ts:59`). Ni provisiones, ni devengos de cierre, ni reversas automáticas.
- **No hay periodo 13.** El esquema lo admite (`001_core_schema.sql:197-202`, `period_type IN ('regular','adjustment','closing')`) y `ensureFiscalYear` crea **doce y sólo doce** (`fiscal-calendar-service.ts:489`), diciéndolo con todas sus letras en `:458-460`. Honesto, pero significa que los ajustes de cierre anual se mezclan con la operación de diciembre.

**Escenario de fallo.** Póliza de seguro anual de 120 000 recibida en enero. El usuario elige «Prepaid expenses (accrued month by month)» confiando en la etiqueta. Enero: 1160 = 120 000. Diciembre: **1160 = 120 000**. Cada uno de los doce estados de resultados subvaluó el gasto en 10 000; el activo circulante quedó sobrevaluado hasta 120 000; el resultado del ejercicio, sobrevaluado en 120 000 hasta que alguien lo descubra a mano.

---

### 10 · NIF D-3 (beneficios a empleados) y NIF D-5 (arrendamientos): huecos totales, sin una sola fila en el plan de cierre — [NUEVA] · **ALTA**

**D-3.** `grep -rni "aguinaldo|vacacion|prima vacacional|prima de antig|PTU|indemniz" src --include='*.ts'` (excluyendo `src/ai/docs`) → **cero**. El único rastro es un **comentario** que enumera valores posibles de un `VARCHAR` sin `CHECK` (`008_payroll.sql:275`). No hay cuenta de provisión de aguinaldo, ni de vacaciones, ni de prima vacacional, ni de PTU por pagar, ni de prima de antigüedad (que bajo D-3 es un beneficio **post-empleo con valuación actuarial**, obligatorio en México desde el primer año de servicio). El sistema los registra **sólo cuando se pagan** — tratamiento de flujo, no de devengado.

**D-5.** `grep -rni "lease|arrendamiento|right.of.use|derecho de uso"` sobre `src` fuera de `src/ai/docs` → **cero coincidencias reales**. No hay tabla de arrendamientos, ni activo por derecho de uso, ni pasivo por arrendamiento, ni cuenta en ningún sembrador. El catálogo base tiene **6120 «Renta de Oficina»** como gasto de operación (`chart-seed.ts`): tratamiento **anterior a D-5**, obligatorio en México desde 2019.

**Y el agente sí sabe.** `src/ai/docs/niif-ingresos-arrendamientos.md` son 26 530 bytes sobre NIIF 16 (derecho de uso, arrendador, sale-leaseback) y `src/ai/system-prompt.ts:64` le ordena citar el código dual. **El agente puede explicar impecablemente un tratamiento que el sistema no tiene dónde registrar** — ni cuenta, ni tabla, ni renglón de reporte.

**Escenario de fallo.** Empresa con arrendamiento de oficina a 5 años por 100 000 mensuales. Bajo D-5 debe reconocer un activo por derecho de uso y un pasivo por arrendamiento del orden de **5 millones** cada uno (valor presente), con depreciación e interés separados. El sistema presenta **cero activo, cero pasivo** y 1 200 000 anuales de renta. Y una provisión de aguinaldo de ~42 000 mensuales que tampoco existe. Ningún criterio, ninguna casilla de cierre y ningún reporte lo detecta.

---

### 11 · La depreciación no distingue libro contable de libro fiscal, y el único método «fiscal» que implementa es estadounidense — [NUEVA] · **ALTA**

El esquema **sí diseñó** la dualidad: `fixed_assets.book_depreciation_method` y `.tax_depreciation_method` (`003_banking_assets_inventory.sql:162-163`), y `depreciation_schedules.schedule_type IN ('book','tax','projected')` (`:208-209`).

El motor **la ignora por completo**:
- `runMonthlyDepreciation` lee `asset.depreciation_method` —la columna **única**— y nunca las dos específicas (`assets/depreciation.ts:299`). `grep -rn "book_depreciation_method|tax_depreciation_method" src --include='*.ts'` sólo devuelve la **declaración del tipo** en `types/index.ts:673-674`. **Cero lectores.**
- `schedule_type` está **cableado a `'book'`** en el `INSERT` (`depreciation.ts:323`). Nunca se produce una cédula fiscal.
- El único método pensado como fiscal es **MACRS** (`depreciation.ts:149-199`, con las tablas de 3, 5, 7, 10, 15 y 20 años del IRS) y `macrs_class` en el esquema (`003:158`). **No existe la tabla del art. 34 LISR** (10 % construcciones, 30 % equipo de cómputo, 25 % automóviles…), ni el ajuste por **INPC** del art. 31 —`grep -rni "inpc" src` fuera de docs → **cero**—, ni el tope de deducción de automóviles.

Además, `monthsDiff` se calcula dividiendo entre **30.44 días promedio** (`depreciation.ts:344-347`) para indexar el arreglo del calendario: es aritmética de meses hecha con días, que corre el índice de la cédula conforme avanza el ejercicio.

**Escenario de fallo (para cuando #2 se abra).** Máquina de 1 000 000. Bajo NIF C-6 la vida útil es la del uso esperado, digamos 10 años; bajo LISR art. 34 la tasa es 10 % anual sobre MOI **actualizado por INPC**. Son dos cifras distintas, y su diferencia es la base de la **NIF D-4** (impuesto diferido) y del papel de trabajo de la conciliación contable-fiscal. El sistema sólo puede producir una, la llama `'book'`, y para «fiscal» ofrece MACRS. Llevar contabilidad y llenar declaraciones son dos cosas; hoy sólo hay libro para una y media.

---

### 12 · Reconocimiento de ingreso: factura = ingreso, sin ninguna de las cinco etapas de NIF D-1 — [NUEVA] · **MEDIA-ALTA**

`ar-ap-posting.ts:88-89` lo dice sin rodeos: *«DR cxc (total) · CR revenue per line»*. No hay contrato, ni obligaciones de desempeño, ni precio de transacción, ni asignación, ni reconocimiento al transferir el control. No existen `contract_asset`, `contract_liability`, ni reconocimiento por avance.

**Crédito parcial verificado, y merece decirse:** la etapa 5 sí está tratada para el caso del **anticipo**. `cfdi-taxonomy.ts:174-186` abona `anticipo_clientes` (2150) y **no** ingreso, con la nota *«A customer advance is a LIABILITY until the revenue is earned»*; `:275-288` lo aplica contra la factura final por TipoRelacion 07. Y `nifSubstanceRule` advierte cuando alguien abona ingreso en una póliza que menciona «anticipo» (`validation.ts:315-336`) — aunque esa advertencia se tira (hallazgo #5), y aunque el pasivo aterriza en la cuenta que la colisión del hallazgo #1 llena de IMSS.

**Escenario de fallo.** Contrato de desarrollo a doce meses facturado íntegro en enero. El sistema reconoce **el 100 % del ingreso en enero**. Bajo D-1 sólo procede lo transferido en el periodo. No hay ninguna superficie —ni cuenta, ni comando, ni advertencia— para diferir el resto.

---

### 13 · El catálogo base no tiene cuenta para ninguna estimación, provisión, diferido, deterioro ni reserva — [NUEVA] · **MEDIA**

Extraje los **61 nombres únicos** que siembran los tres sembradores (`chart-seed.ts`, `account-roles-seed.ts`, `payroll-…-seed.ts`). **No aparece ninguna** de estas:

- Estimación para cuentas de cobro dudoso (**C-3 / C-16**, pérdidas crediticias esperadas)
- Estimación de inventarios obsoletos o de lento movimiento (**C-4**)
- Deterioro acumulado de activos de larga duración (**C-15**)
- ISR diferido activo / pasivo (**D-4**)
- PTU por pagar y PTU diferida (**D-3**)
- Provisión de aguinaldo, vacaciones, prima vacacional, prima de antigüedad (**D-3**)
- Activo por derecho de uso · pasivo por arrendamiento (**D-5**)
- Otros Resultados Integrales / ORI (**B-3**)
- Reserva legal (LGSM art. 20, 5 % obligatorio hasta el 20 % del capital)
- Pasivo a largo plazo (existe la categoría `long_term_liabilities` en el `CHECK` de `001_core_schema.sql:116-122` y **ninguna cuenta ni encabezado** que la use)

El `CHECK` de `fs_category` tampoco contempla `other_comprehensive_income`: no hay dónde clasificar el ORI aunque la cuenta se creara a mano.

**Escenario de fallo.** El contador quiere estimar 3 % de la cartera como incobrable — la partida de ajuste más común del cierre mexicano. Debe crear la cuenta él, elegirle `account_type` y `fs_category`, y confiar en que nadie más siembre ese código después (ver hallazgo #1). El sistema no lo guía ni lo impide.

---

### 14 · El enum de costeo admite UEPS/LIFO, prohibido por NIF C-4 e IAS 2 — [NUEVA] · **BAJA hoy, ALTA cuando S0.4 escriba el motor**

`InventoryCostingMethod.LIFO = 'lifo'` (`types/index.ts:174`) y el `CHECK` de la tabla lo permite (`003_banking_assets_inventory.sql:232`). **NIF C-4 eliminó UEPS en 2011** y **IAS 2 lo prohíbe**. Hoy es inofensivo porque el módulo es cascarón declarado (ver «LO QUE RESISTE» #5), pero el enum es el contrato que S0.4 va a implementar, y una entidad que lo seleccione produce inventarios y costo de ventas que **ninguna NIF admite**.

En la misma familia, no verificado por falta de motor: no hay regla de **costo o valor neto de realización, el menor** (C-4), ni distinción entre costo contable C-4 y costo fiscal LISR art. 41 (que **obliga** a registrar la diferencia, como el propio `docs/cli-command-catalog.md:1333` reconoce).

---

### 15 · El plan maestro diagnostica bien R4 con una medición equivocada — [II-EXAGERADA / mal medida] · **BAJA**

Plan Maestro v3, tramo **R4 «La moneda extranjera dice la verdad»**: *«No hay revaluación cambiaria (B-15) y no hay cuentas de utilidad o pérdida cambiaria: **`fx_gain` y `fx_loss` tienen cero referencias en todo el código**»*.

La **conclusión es correcta** (nunca se registra diferencia cambiaria). La **evidencia es un artefacto de medición**: se buscaron nombres en inglés sobre un código que nombra en español. Verificado: los roles **sí existen y sí se siembran** en toda entidad — `utilidad_cambiaria: '4300'` y `perdida_cambiaria: '6300'` (`account-roles-seed.ts:179-180`), declarados en el tipo `AccountRole` (`cfdi-taxonomy.ts:30`). Lo que falta no es el rol ni la cuenta: es que **ninguna `PostingLine` de `cfdi-taxonomy.ts` los usa**.

Es la **misma clase de error** que el `ILIKE '%receivable%'` del flujo de efectivo (hallazgo #7): medir un sistema en español con cadenas en inglés. Consecuencia práctica: R4 se dimensiona como «crear cuentas + revaluación» cuando el trabajo real es (a) **convertir en el origen** —lo que el plan no menciona y es el hallazgo #3— y (b) la revaluación al cierre. **Construir la revaluación sobre importes que nunca se convirtieron no arregla nada.**

---

### 16 · El plan de cierre de brechas —147 partidas— no contiene una sola de reconocimiento NIF — [NUEVA, nivel plan] · **MEDIA**

`docs/plan-cierre-brechas.md` menciona «nif» 87 veces. Desglosadas: 13 `nif-indice`, 8 `nif-registry`, 6 `nif-validaciones`, 5 `nif-registro`, 4 `nif-marco` — **36 son nombres de archivo del corpus del agente**. De normas particulares: **B-1 ×11** (ya implementada), **C-6 ×1**, **B-3 ×1**, **A-2 ×1**, **A-1 ×1**. Y **cero** menciones de D-1, D-3, D-4, D-5, C-15, C-13, B-2, B-4, ORI o «estado de cambios en el capital».

`docs/plan-catalogo.md` menciona **NIF cero veces** y ordena los doce sprints por **flujos transaccionales** —cobrar, pagar, banco, cerrar el mes, contabilidad electrónica, nómina— sin un solo flujo llamado «producir estados financieros» ni «ajustes de devengo». El flujo 6, «Cerrar el mes», cruza `closing, period, batch` y el Plan Maestro lo describe como «la puerta de la depreciación y el amarre fiscal»: **no incluye provisiones, ni estimaciones, ni diferidos, ni deterioro**.

**El diagnóstico justo:** el problema **no es** que `docs/cli-command-catalog.md` no lo sepa — lo sabe con detalle notable (fila `asset impairment check` con NIF C-15, `asset deferred-tax calculate` con D-4, `statement equity show` con B-4, `cashflow reconcile`). El problema es que **la secuencia y las fases lo empujan fuera del compromiso**: B-4 y el deterioro están en fase 2 y 3; las 179 filas de fase 1 que quedan viven en «la cola larga, sprints 9–12». Un plan que promete «llevar los libros enteros» en diez sprints y deja el reconocimiento NIF en la cola no está midiendo lo que promete.

*(Nota de precisión sobre el catálogo, menor: `docs/cli-command-catalog.md:2190` afirma que «`fixed_assets` no lleva base fiscal ni método MACRS». Sí los lleva: `macrs_class` en `003:158` y `tax_depreciation_method` en `003:163`. El problema real no es que falten las columnas, sino que **nadie las lee** y que MACRS es la norma equivocada para México — hallazgo #11.)*

---

## ¿PUEDE UN CONTADOR FIRMAR UNOS ESTADOS FINANCIEROS SALIDOS DE AQUÍ?

**No, y no por poco.** Tres razones, en orden de gravedad, todas verificadas arriba:

1. **Faltan dos de los cuatro estados básicos y las notas** (#8). El estado de cambios en el capital contable no existe y está fuera del compromiso; el de flujos de efectivo existe como ruta REST que no amarra contra el efectivo.
2. **El reconocimiento es incompleto en las partidas más grandes de una empresa mexicana real** (#9, #10, #12): sin devengo, sin arrendamientos D-5, sin beneficios D-3, sin depreciación viva, sin estimaciones. Un balance sin activo por derecho de uso, sin provisión de aguinaldo y con depreciación acumulada en cero no es un balance conforme a NIF; es una balanza de comprobación bien formateada.
3. **La clasificación de lo que sí se registra es incorrecta en renglones concretos y nadie lo ve** (#1, #4, #6). Los totales cuadran; la composición no. Y las seis compuertas que existen —sembrador, `doctor`, `validateJournalEntry`, `ledger check`, checklist de cierre, reportes— dejan pasar los tres hallazgos altos, cada una por una razón distinta.

**Lo que le falta al Plan Maestro para poder responder que sí**, en orden:

- Un tramo explícito **«El devengo existe»**: motor de amortización de 1160, provisiones de D-3, periodo 13 y asientos de ajuste como objeto de primera clase. Hoy no hay tramo con ese nombre en ningún plan.
- Un tramo **«Los cuatro estados y sus amarres»**: B-4, B-2 con reconciliación contra el efectivo, ORI dentro de B-3, y `statement check` (que el catálogo ya diseñó, fase 1, 🟡) como criterio del tablero.
- **La conversión en el origen antes de la revaluación** en R4. R4 tal como está redactado construye el segundo piso sin el primero.
- **Un criterio que compare la unión de los sembradores** y falle ante cualquier código con dos significados. Es el único hallazgo alto de este informe que se cierra con menos de 40 líneas.
- Y el reconocimiento de que **D-5 y D-3 no tienen fila en ningún plan**: no están retrasados, están sin nombrar.

---

## RECOMENDACIONES

| # | Acción | Cierra | Tamaño | Tramo destino |
|---|---|---|---|---|
| R-1 | Criterio en `criterios.ts` + espejo en `tests/plan` que compute la intersección de `BASE_CHART_MX` ∪ `REQUIRED_ACCOUNTS` ∪ `MX_PAYROLL_ACCOUNTS` ∪ `US_PAYROLL_ACCOUNTS` y **falle ante cualquier código repetido con distinto nombre, tipo o naturaleza**. Verificado por mutación en ambas direcciones. | #1 | **S** | **S2** (garantías, antes de F03) |
| R-2 | Renumerar la nómina MX (5300 sueldos, 2210–2240 pasivos de nómina) **y** migración que reasigne los `payroll_account_mapping` ya sembrados. No basta arreglar la constante: las entidades existentes ya tienen el mapeo mal escrito. | #1 | **M** | **S2**, inmediatamente después de R-1 |
| R-3 | Sustituir los cuatro `.abs()` de `generateClosingEntries` por el mismo `naturalSign` que usa `buildIncomeStatementSection`, con prueba que cierre un ejercicio con 4400 y 5200 con saldo y afirme que quedan **en cero**. | #4 | **S** | **F06** (Cerrar el mes) |
| R-4 | Surfacear `validation.warnings` en el posteo (registro en `audit_log` + conteo en el checklist de cierre), con exención para `entry_type='closing'`. Añadir casilla «Pólizas del periodo con advertencia NIF» a `getPeriodCloseStatus`. | #5 | **M** | **F06** |
| R-5 | Convertir en el origen: multiplicar los importes de `cfdi-taxonomy.ts` por `facts.tipoCambio`, escribir `currency_code`/`foreign_*`/`exchange_rate` en `posting.ts:135`, hacer **bloqueante** la advertencia de moneda extranjera, y **corregir `nif-validaciones.md`** para que deje de anunciar una validación que no puede correr. | #3 | **L** | **R4**, como su **primera** partida |
| R-6 | Puerta para `runMonthlyDepreciation` + alta de activo (`INSERT INTO fixed_assets`) + **hacer que la casilla del checklist pueda ponerse en rojo**: contar activos capitalizados en la cuenta 1210 que no tengan fila en `fixed_assets`, no filas de una tabla vacía. | #2 | **L** | **F06** (cierra E1.4) |
| R-7 | Motor de amortización de pagos anticipados (1160 → gasto, mensual, idempotente por entidad-periodo) y periodo 13 de ajuste en `ensureFiscalYear`. | #9 | **M** | tramo nuevo **«El devengo existe»** |
| R-8 | Provisiones D-3: cuentas de aguinaldo, vacaciones, prima vacacional y PTU + devengo mensual sobre la nómina ya calculada. La prima de antigüedad (actuarial) se declara fuera de alcance **por escrito**, no por omisión. | #10, #13 | **L** | tramo nuevo **«El devengo existe»** |
| R-9 | `statement equity show` (NIF B-4) y `statement check` (amarres entre estados) **movidos a fase 1**, y `cashflow reconcile` con residuo impreso. Sin B-4 no hay juego completo y el compromiso de diez sprints es falso. | #7, #8 | **L** | **reordenar `plan-catalogo.md`** |
| R-10 | Usar `fs_category` en `buildIncomeStatementSection`: utilidad bruta, resultado de operación, RIF y ORI como secciones. La consulta ya la trae y la agrupa. | #6 | **M** | **F06** o el tramo de reportes |
| R-11 | Retirar `LIFO` del enum y del `CHECK`, con migración. Cuesta menos hoy que después de S0.4. | #14 | **S** | **S0.4** (inventarios), como precondición |
| R-12 | Reemplazar MACRS por la tabla del art. 34 LISR y leer `book_/tax_depreciation_method` + `schedule_type='tax'`. Requiere la serie del INPC, que el plan ya tiene como prerrequisito de F07. | #11 | **L** | **F07**, después del INPC |
| R-13 | Nombrar **D-5 (arrendamientos)** y **C-13 (partes relacionadas)** como huecos con fila propia en `plan-cierre-brechas.md`. Hoy no están retrasados: están sin nombrar, y lo que no se nombra no se mide. | #10, #16 | **S** | **S2**, con el resto de las garantías |
| R-14 | Corregir la evidencia de **R4** en el Plan Maestro (`fx_gain`/`fx_loss` → `utilidad_cambiaria`/`perdida_cambiaria`) y añadir un criterio genérico: **ningún medidor del plan busca identificadores en inglés sobre código en español**. Es la misma raíz que el `ILIKE '%receivable%'`. | #15, #7 | **S** | **S2** |
