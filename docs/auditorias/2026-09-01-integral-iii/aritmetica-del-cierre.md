> **Lente 4 · ¿Las cuentas cuadran de verdad?** — árbol `61379d0` (origin/main `cfe40c6` + los dos commits de doc del PR 19). Toda cita es `ruta:línea` abierta de verdad; tres hallazgos están **probados por ejecución** con `decimal.js` del propio repo, replicando el código línea por línea. Sin base de datos disponible: donde hago falta de Postgres lo digo.

---

## LO QUE RESISTE

**R1 · El prorrateo del IVA por pagos parciales está bien hecho, y es lo mejor de esta lente.**
`ivaToReclassify` no redondea por pago: calcula dos *objetivos acumulados* y resta (`src/services/accounting/iva-cash-basis.ts:281-287`), con el atajo `applied >= total → iva` que garantiza que el último pago libera el remanente exacto. Comprobado a mano: IVA 16,00 sobre documento de 116,00 pagado 40/40/36 → 5,5172 + 5,5173 + 4,9655 = **16,0000 exactos**. Un prorrateo ingenuo (`iva × parte / total` redondeado por pago) habría dejado 0,0001 varado en la 1135 para siempre. Es la técnica correcta y está explicada en el comentario.

**R2 · El balance general cuadra por construcción, y por una razón bien argumentada.**
`queryUnclosedEarnings` suma las cuentas de resultados **desde el origen**, no desde el inicio del ejercicio, y el comentario dice exactamente por qué: un asiento de cierre carga ingresos y abona gastos, así que un año ya cerrado neutraliza a cero y su resultado ya está en 3200 (`src/services/reporting/report-service.ts:464-475, 519-528`). Ése es el renglón que hace que el estado cuadre sin condiciones. El autor entendió la interacción con el cierre — y no la aplicó al estado de resultados (hallazgo 1).

**R3 · Los signos de las secciones no usan `abs()`, y está razonado.**
`buildIncomeStatementSection` voltea el signo con `naturalSign` en vez de `abs()`, con el comentario «abs() would inflate a section holding contra-natural rows, e.g. sales returns booked as revenue debits» (`report-service.ts:605-619`). Lo mismo en el balance para las contra-cuentas (`:426-430`). El repositorio **sabe** cuál es el riesgo. El asiento de cierre es el único sitio donde no aplicó la lección (hallazgo 2).

**R4 · El pie de la balanza se calcula antes de paginar.**
`getTrialBalance` suma sobre todas las filas casadas y recorta después (`report-service.ts:371-376`), y la tolerancia de un centavo está declarada como afirmación sobre redondeo, no sobre corrección (`:328-331`). Es la decisión correcta y es rara.

**R5 · Archivar una cuenta tiene compuerta de saldo vivo.**
`deactivateAccount` cuenta líneas y suma `debit_total − credit_total` de todos los periodos antes de escribir (`src/services/accounting/account-service.ts:264-297`); el mensaje remite a saldar o reclasificar. La aritmética del saldo es correcta (el arrastre pone `debit=credit=0`, así que no hay doble conteo).

**R6 · El cierre anual sí agrega el ejercicio COMPLETO.** La mitad de la fortaleza F8 de la auditoría II es cierta: `SUM` sobre todos los periodos del `fiscal_year_id` (`src/services/accounting/period-close.ts:448-458, 491-501`), no sólo el último. La otra mitad no lo es (hallazgo 2).

---

## HALLAZGOS

### 1 · [NUEVA] · **ALTA** · El estado de resultados de un ejercicio ya cerrado sale en CEROS; el de diciembre, con ingresos NEGATIVOS

Ningún reporte del árbol filtra `entry_type = 'closing'`. Censo: `entry_type` aparece tres veces en toda la capa de reportes y ninguna es un filtro de cierre — `report-service.ts:670` y `:709` son la columna del mayor, y `src/api/rest/routes/reports.ts:197` filtra `auto_depreciation` para la depreciación del flujo de efectivo.

`queryIncomeStatementRows` acota sólo por fecha (`report-service.ts:588`: `je.status = 'posted' AND je.entry_date BETWEEN $2 AND $3`). El asiento de cierre se fecha en `period.end_date` del último periodo del ejercicio (`period-close.ts:312, 531-539`), es decir **dentro del rango**.

**Escenario numérico.** Entidad con ventas 100.000 (4100) y sueldos 50.000 (6110) en 2026; diciembre aporta 8.000 de venta y 4.000 de sueldo. Se cierra 2026 en duro.

- `mnemosine report income-statement show --period 2026` (`src/cli/report-command.ts:392`): 4100 tiene abono 100.000 (ventas) y cargo 100.000 (cierre) → `netMovement = 0` → el `HAVING` de `nonzero-net` lo **descarta** (`report-service.ts:577`). Igual 6110. Resultado impreso: **Revenue 0,0000 · Expenses 0,0000 · Net income 0,0000**. Con `include: 'any-activity'` la cuenta sobrevive pero su `amount` sigue siendo 0,0000 (`:601-602`).
- `--period 2026-12`: 4100 = abono 8.000 + cargo 100.000 → `netMovement` = +92.000 debe-positivo → sección Revenue = **−92.000**. 6110 = cargo 4.000 + abono 50.000 → −46.000. `net_income` = −92.000 − (−46.000) = **−46.000**, contra un resultado real de diciembre de +4.000.

Alcanza a las tres puertas: CLI (`report-command.ts:392`), REST `GET /v1/reports/income-statement` (`routes/reports.ts:91`) y el flujo de efectivo (hallazgo 10). El balance general se salva **sólo** porque suma desde el origen (R2) — la asimetría es la prueba de que el defecto es una omisión, no un criterio.

Ninguna prueba lo cubre: `tests/services/reporting/report-service.spec.ts` no tiene un solo caso con asiento de cierre (el único que lo menciona es el comentario `:278` sobre el balance).

### 2 · [NUEVA] · **ALTA** · El asiento de cierre CARGA las cuentas de ingreso con saldo deudor: las duplica en vez de saldarlas, cuadra igual, y sobrevalúa Resultados Acumulados

`generateClosingEntries` empuja `debit_amount: balance.abs()` para **toda** cuenta de ingreso sin mirar el signo (`period-close.ts:472-479`) y `credit_amount: balance.abs()` para **toda** cuenta de gasto (`:508-515`). Una cuenta de ingreso con saldo deudor —devoluciones y descuentos sobre ventas, que en este esquema **tienen** que ser `account_type = 'revenue'` porque el `CHECK` de la 001 no admite `contra_revenue` (`src/database/migrations/001_core_schema.sql:110-113`)— recibe otro cargo.

**Probado por ejecución** (réplica exacta de `period-close.ts:468-524` con el `decimal.js` del repo). Ventas 4100 con abono 100.000; Devoluciones sobre ventas 4150 con cargo 10.000; Sueldos 6110 con cargo 50.000:

```
ASIENTO DE CIERRE que genera generateClosingEntries:
  4100  debe=100000.0000  haber=-
  4150  debe=10000.0000   haber=-      <-- debía ser ABONO
  3900  debe=-            haber=110000.0000
  6110  debe=-            haber=50000.0000
  3900  debe=50000.0000   haber=-
  cuadra? true (debe 160000.0000 = haber 160000.0000)

Saldo de 4150 DESPUES del cierre: 20000.0000   (debía quedar en 0)
Resultado barrido a 3200 :        60000.0000
Resultado CORRECTO       :        40000.0000
Sobrevaluacion de 3200   :        20000.0000  = 2x las devoluciones
```

Lo insidioso: **el asiento cuadra**, así que `balanceRule` lo acepta (`src/services/accounting/validation.ts:63-89`), el `CHECK` de la base lo acepta, y el balance general **sigue cuadrando** porque los 20.000 que quedan colgando en 4150 los recoge `queryUnclosedEarnings` como «Result Of The Period» de −20.000 y compensan exactamente la sobrevaluación de 3200. Nada protesta. Lo que queda mal es lo que se firma: 3200 sobrevaluada en 2× las devoluciones (base de PTU, CUFIN y del dictamen), una cuenta de ingreso que nunca se salda, y un renglón «Result Of The Period» permanente en el capital que crece cada ejercicio.

El propio repositorio documenta el riesgo cuatro archivos más allá: «abs() would inflate a section holding **contra-natural rows, e.g. sales returns booked as revenue debits**» (`report-service.ts:605-608`).

**Corrección de la auditoría II:** su fortaleza **F8 («Cierre anual correcto») está EXAGERADA**. La agregación por ejercicio es correcta; el manejo de signos no lo es, y ella no lo miró. Su única prueba es un regex sobre el fuente que sólo verifica las constantes 3200/3900 (`tests/accounting/period-close-accounts.spec.ts:19-27`) y la integración se conforma con `expect(acumulados).not.toBe(0)` (`tests/integration/period-close.int.spec.ts:144`) — no comprueba el importe ni que las cuentas de resultados queden en cero.

### 3 · [NUEVA] · **ALTA** · Nada exige cerrar los periodos en orden, y el arrastre supone que sí; `inicial_confiable` jura por el periodo equivocado

`hardClosePeriod` sólo exige que ESTE periodo esté en `soft_close` (`period-close.ts:292-297`); `softClosePeriod` sólo que esté en `open` (`:213-215`). El checklist de nueve ítems (`:36-182`) **no tiene ninguno** sobre el periodo anterior. Censo: cero apariciones de «previous period», «periodo anterior» o `period_number - 1` en `period-close.ts`, `validation.ts` y `close-command.ts`.

`carryForwardBalances` siembra el inicial del siguiente periodo con el `ending_balance` del que se cierra (`:393-412`), y ese `ending_balance` es `beginning + cargos − abonos` acumulado por el posteo (`src/services/accounting/posting.ts:214, 371`) — es decir, **hereda el cero de un periodo previo que nunca se cerró**.

**Escenario numérico.**
- Enero: DR 1111 Banco 500.000 / CR 3100 Capital 500.000. Enero se deja **abierto**.
- Febrero: sin movimiento, abierto.
- Marzo: DR 6120 Renta 30.000 / CR 1111 Banco 30.000. Se cierra marzo en suave y en duro.
- `account_balances` de 1111 en marzo: `beginning 0`, `credit 30.000`, `ending −30.000`.
- `carryForwardBalances(marzo)` siembra abril con **`beginning_balance = −30.000`**. El saldo inicial verdadero de abril es **470.000**. Error: 500.000.

Y el aviso está invertido: `getAuxiliaryView` marca `inicial_confiable: periodo.status === 'hard_close' || 'locked'` — el estado del periodo **que se consulta**, cuando quien siembra el inicial es el cierre duro del **anterior** (`report-service.ts:988`). Consecuencias en los dos sentidos:
- Enero cerrado en duro y febrero abierto: el inicial de febrero **sí** es fiable y el auxiliar dice que no.
- Marzo cerrado en duro con febrero abierto: el inicial de marzo es cero por ausencia de arrastre y el auxiliar dice **`inicial_confiable: true`**. Ése es el número que sale en el XML XC del Anexo 24 (`report-service.ts:905-913`): se atesta un saldo inicial de cero.

Sin base de datos no pude ejecutar la secuencia; el razonamiento es sobre el SQL y las guardas leídas, y ninguna de las dos rutas tiene guarda de orden.

### 4 · [NUEVA] · **ALTA** · `report trial-balance --level N` promete «roll up» y sólo FILTRA: la balanza sale descuadrada por construcción

La ayuda del comando dice literalmente `'roll up to at most this account level'` (`src/cli/report-command.ts:215`) y el catálogo promete «o en resumen a N niveles» (`docs/cli-command-catalog.md:2294`). La implementación no agrega hijos en padres: añade `AND a.account_level <= $n` al `WHERE` y agrupa por `a.id` (`report-service.ts:293-296, 315`). No hay CTE recursivo ni suma por `parent_id` en todo el archivo.

Los niveles son reales: el disparador `compute_account_full_code` los calcula desde el padre (`001_core_schema.sql:153-174`) y el catálogo base los encadena hasta cuatro (`src/services/accounting/chart-seed.ts:30-92`): 1000→1, 1100→2, 1120 (Cuentas por Cobrar)→**3**, 4100 (Ventas)→**2**, 2120 (IVA Trasladado)→**3**.

**Escenario numérico.** Una venta de 116.000 en el catálogo base: DR 1120 116.000 / CR 4100 100.000 / CR 2120 16.000. `mnemosine report trial-balance show --level 2`:
- 1120 (nivel 3) y 2120 (nivel 3) **desaparecen**; 4100 (nivel 2) queda.
- `totalTrialBalance` → `total_debits = 0,0000`, `total_credits = 100.000,0000`, **`is_balanced: false`**.

Una balanza que un despacho entrega diciendo que los libros están descuadrados en 100.000, con los libros perfectamente cuadrados. El caso espejo es peor: si el asiento vive entre cuentas de nivel 3, `--level 2` devuelve 0/0 e `is_balanced: true` sobre un informe vacío. La ruta REST lo hereda con `account_level = '5'` por omisión (`src/api/rest/routes/reports.ts:41, 47`) — inocuo con el catálogo base de cuatro niveles, letal con cualquier catálogo agrupador más profundo. La prueba existente sólo fija la **posición del parámetro** en el SQL, no el resultado (`tests/services/reporting/report-service.spec.ts:90-97`).

### 5 · [NUEVA] · **MEDIA** · `restorePeriodStatus` reabre-postea-recierra sin volver a arrastrar, y el arrastre nunca es transitivo

`restorePeriodStatus` devuelve el periodo a `hard_close` con un `UPDATE` pelado (`src/services/accounting/fiscal-calendar-service.ts:281-291`): **no llama a `carryForwardBalances` ni a `generateClosingEntries`**. Y tiene un llamador vivo: el backfill de IVA PPD reabre el periodo (`src/services/accounting/iva-ppd-reclass.ts:209`), postea la reclasificación dentro (`:228-255`) y lo vuelve a cerrar en el `finally` (`:275-280`).

**Escenario numérico.** Marzo cerrado en duro; 1130 IVA Acreditable con `ending_balance` 80.000; abril ya sembrado con `beginning_balance = 80.000` y cerrado a su vez, y así hasta diciembre. Se corre `iva ppd reclass --reabrir`: reclasifica 12.000 de 1130 a 1135 con fecha de marzo. El posteo actualiza marzo (1130 → 68.000, 1135 → 12.000) y `restorePeriodStatus` lo recierra. **El `beginning_balance` de abril sigue en 80.000 y el de 1135 en 0.** Los ocho meses siguientes arrastran el error.

Agravante independiente: aun por el camino correcto (`open → soft → hard`) `carryForwardBalances` sólo siembra **el periodo inmediatamente siguiente** (`period-close.ts:383-390`, `ORDER BY start_date ASC LIMIT 1`). No cascadea. Corregir marzo arregla abril y deja mal mayo a diciembre; nada en `src/` re-cierra la cadena.

El único que vería la deriva es `getAuxiliaryView`, que la exhibe como `final_calculado ≠ final` y remite a `ledger check` (`src/cli/ledger-command.ts:185`) — un comando estructuralmente incapaz de verla (hallazgo 13).

### 6 · [NUEVA] · **MEDIA** · La balanza excluye cuentas archivadas y el balance general las incluye a propósito: archivar una cuenta con saldo descuadra la balanza, y las dos pruebas fijan la contradicción

`queryTrialBalanceRows` filtra `a.is_active = true` (`report-service.ts:290`). `queryBalanceSheetRows` **no**, y el comentario explica por qué se quitó: «a retired account that still carries a balance belongs on the balance sheet. Excluding it silently removed real money from the statement and was one of the reasons it did not foot» (`:412-416`). La lección no cruzó veinte líneas hacia arriba.

`mnemosine account archive` sólo pone `is_active = false` (`account-service.ts:294`) y la compuerta de saldo cero es **opcional** (`enforceZeroBalance`, `:285`), con `--force` documentado en el propio mensaje de error (`:287`).

**Escenario numérico.** 1130 IVA Acreditable con 16.000 de cargo vivo. `mnemosine account archive 1130 --force --reason "se sustituye por 1131"`. A partir de ahí:
- `report balance-sheet show` la incluye → cuadra.
- `report trial-balance show` la excluye → `total_debits` corto en 16.000 → **`is_balanced: false`**, y la causa no aparece en el informe porque la cuenta ya no se imprime.
- El ítem «Trial balance balanced» del cierre lee `account_balances` sin filtro de actividad (`period-close.ts:106-111`) → **pasa**.

Tres superficies, tres respuestas. Y la suite fija las dos mitades de la contradicción como comportamiento deseado: `expect(sql(0)).toMatch(/AND a\.is_active = true/)` para la balanza (`tests/services/reporting/report-service.spec.ts:73`) y `expect(sql(0)).not.toMatch(/a\.is_active/)` para el balance (`:307`). Ninguna prueba comprueba que ambos coincidan.

### 7 · [NUEVA] · **MEDIA** · La depreciación indexa el calendario con «meses de 30,44 días»: repite febrero en marzo, fecha el asiento en el mes anterior y deja de funcionar en cuanto el mes anterior cierra en duro

`runMonthlyDepreciation` elige la fila del calendario con `Math.floor((inicioPeriodo − inicioDepreciación) / (30.44 días))` (`src/services/assets/depreciation.ts:307-310`) y postea el asiento fechado en `entry.period_start_date`, la fecha de **esa fila** (`:333, 335`).

**Probado por ejecución** (misma fórmula, activo con `depreciation_start_date = 2026-01-01`):

```
2026-01-01 -> indice 0  => fila del calendario mes 1
2026-02-01 -> indice 1  => fila del calendario mes 2
2026-03-01 -> indice 1  => fila del calendario mes 2   <-- REPETIDA
2026-04-01 -> indice 2  => fila del calendario mes 3
2026-12-01 -> indice 10 => fila del calendario mes 11
2027-01-01 -> indice 11 => fila del calendario mes 12
```

Tres consecuencias, todas con número:
1. **Marzo vuelve a postear la fila de febrero.** El guardia de idempotencia es por `(asset_id, fiscal_period_id)` (`:284-289`), así que no lo detiene. Con línea recta da igual el importe; con `declining_balance_200` no: activo de 120.000 a 60 meses → m1 = 4.000,00, m2 = 3.866,67, m3 = 3.737,78. Marzo postea **3.866,67 en vez de 3.737,78** (128,89 de más) y escribe en `fixed_assets.accumulated_depreciation` el acumulado de m2, 7.866,67, mientras el mayor ya lleva 11.733,34: el auxiliar y el mayor divergen en 3.866,67 en un solo mes.
2. **El asiento se fecha en el mes anterior.** La corrida de abril usa `schedule[2].period_start_date = 2026-03-01`. En cuanto marzo esté en `hard_close`, `createJournalEntry` lo rechaza y la depreciación de abril entra en `errors[]` sin postear. Es decir: la depreciación deja de funcionar el día que se empieza a cerrar en duro. Y el ítem 4 del checklist de cierre pregunta por la fila en `depreciation_schedules`, no por el asiento (`period-close.ts:88-96`), así que el cierre no lo nota.
3. Doce meses de calendario consumen once filas del programa; la fila 12 cae en enero del año siguiente.

**Bonus de redondeo, también probado.** `calculateStraightLine` lleva el valor en libros sin redondear y sólo redondea al imprimir (`depreciation.ts:37-62`), así que el «tapón» del último mes no compensa lo que ya se redondeó:

```
costo 100.000, salvamento 0, 36 meses
mensual toFixed(4) = 2777.7778   ultimo = 2777.7778
SUMA de lo que se POSTEA al mayor = 100000.0008
accumulated_depreciation escrito al activo = 100000.0000
ending_book_value escrito al activo = 0.0000
deriva mayor - costo = 0.0008
```

La 1290 termina con 100.000,0008 contra un costo de 100.000,0000: **valor neto en libros negativo** en el balance, y el subsidiario dice 0,0000. No hay cuenta de diferencias por redondeo en todo el árbol (censo: cero apariciones de `rounding_diff`, «diferencia por redondeo» o equivalente en `src/`) ni ninguna conciliación entre `fixed_assets.accumulated_depreciation` y su cuenta del mayor.

Latente hoy porque `runMonthlyDepreciation` no tiene llamador (E1.4 del `plan:status`, ya en rojo y ajeno a esta lente). Es exactamente la deuda que se cobrará el día que se le ponga uno.

Nota menor del mismo camino: entra a `Decimal` desde `parseFloat` (`depreciation.ts:294-296`), único punto del dinero fuera de `Decimal` junto con `resumenAsiento`.

### 8 · [NUEVA] · **MEDIA** · GraphQL: `isBalanced: true` clavado a mano, borradores dentro de la balanza, tres argumentos ignorados, y dos estados financieros declarados sin resolutor

Cierra la pregunta que la auditoría II dejó abierta en su B7 («no verifiqué si el resolutor honra la bandera `consolidate` o la ignora en silencio»). **La respuesta es la tercera opción: no hay resolutor.** `balanceSheet` e `incomeStatement` están declarados en el esquema (`src/api/graphql/schemas/schema.ts:483-484`) y el mapa `Query` de `src/api/graphql/resolvers/index.ts:58-160` contiene exactamente ocho campos —`account`, `accounts`, `journalEntry`, `journalEntries`, `invoice`, `invoices`, `trialBalance`, `fiscalPeriods`— y ninguno es ésos. Un campo `BalanceSheet!` sin resolutor cae en el resolutor por omisión, devuelve `undefined` y revienta con «Cannot return null for non-nullable field». No es una bandera que se ignora: es un estado financiero que no existe detrás de un esquema que promete dos.

Y el que sí existe está peor de lo que aparenta, `trialBalance` (`resolvers/index.ts:126-150`):
- **`isBalanced: true` está escrito como literal** (`:146`). No compara nada. Es la definición de verde falso y viola la regla de la casa (d) en una sola palabra.
- **Cuenta los borradores.** El filtro de estado vive en el `ON` del **segundo** `LEFT JOIN` (`:135`: `LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'`), así que una línea de un asiento en `draft` o en `void` trae `je` en NULL pero **sigue sumando** `jel.debit_amount`. `report-service.ts` anida los dos joins entre paréntesis precisamente para evitarlo (`:309-313`). Escenario: un borrador DR 6120 10.000 / CR 2110 10.000 que nadie posteó aparece en la balanza de GraphQL como 10.000 de cargos y 10.000 de abonos que no están en el mayor.
- **Ignora sus tres argumentos.** El esquema ofrece `fiscalPeriodId`, `asOfDate` y `accountLevel` (`schema.ts:482`); el resolutor sólo lee `entityId`. Una balanza «al 31-dic-2025» devuelve la historia completa.
- Suma con `parseFloat` (`:143-144`), fuera de `Decimal`.

Atenuante real y honesto: GraphQL está **apagado por omisión** (`GRAPHQL_ENABLED === 'true'`, `src/index.ts:233, 246`) con una advertencia escrita sobre que vive fuera del prefijo `/v1` auditado (`:213-222, 264`). Por eso es MEDIA y no ALTA. Pero es código embarcado que miente sobre el cuadre.

### 9 · [NUEVA] · **MEDIA** · La cuenta 3300 «Resultado del Ejercicio» se siembra y nadie la escribe: el cierre barre directo a 3200

El catálogo base crea 3300 en los dos sembradores (`src/services/accounting/chart-seed.ts:55` y `src/database/seed.ts:99`) y `generateClosingEntries` la salta: barre 3900 contra 3200 en un solo asiento (`period-close.ts:547-570`). Censo de `src/`: 3300 no aparece en ningún otro sitio (ni en `ROLE_MAP`, ni en reportes, ni en el panel).

Consecuencia de presentación, no de cuadre: el capital contable nunca distingue el resultado **del ejercicio** del **acumulado de ejercicios anteriores**, que es justo la separación que exige el capital ganado de un balance general mexicano y el punto de partida del estado de cambios en el capital contable (NIF B-4). El catálogo ya lo tiene diagnosticado en otra fila: «`generateClosingEntries` mueve el resultado a la cuenta 3200 pero no arma el movimiento por componente» (`docs/cli-command-catalog.md:2277`), pero registra la brecha como «falta el estado», no como «falta el paso 3900→3300→3200».

### 10 · [NUEVA] · **MEDIA** · El flujo de efectivo tiene dos defectos más que los tres que el catálogo confiesa: lo contamina el asiento de cierre, y no concilia contra el efectivo

El catálogo enumera tres defectos y el propio código los repite en su comentario: `method` se acepta y no cambia nada, financiamiento clavado en `'0.0000'`, y AR/AP detectados con `name ILIKE` (`src/api/rest/routes/reports.ts:163-171`; `docs/cli-command-catalog.md:2284`). Eso es rojo honesto y lo cuento a favor. Los dos que **nadie nombra**:

- **La utilidad neta la borra el cierre.** La consulta de `netIncome` (`reports.ts:179-190`) no excluye `entry_type = 'closing'` — mismo origen que el hallazgo 1. Aritmética: el asiento de cierre carga ingresos (aporta `credit − debit` = −100.000) y abona gastos (aporta +50.000), cancelando exactamente los +100.000 y −50.000 de las operaciones reales. `GET /v1/reports/cash-flow?start_date=2026-01-01&end_date=2026-12-31` sobre un ejercicio cerrado devuelve **`net_income: 0.0000`**, y el flujo de operación queda reducido a depreciación + ΔCxC + ΔCxP. Para la entidad del hallazgo 1 son 40.000 de flujo operativo que desaparecen.
- **No concilia contra el efectivo.** `net_cash_flow` es una suma de estimaciones (`:246-252`) que **nunca se compara con el movimiento real de las cuentas de efectivo**, y la respuesta no trae saldo de efectivo inicial ni final (`:254-274`). Es el requisito de cierre de la NIF B-2 y es también la única prueba de cuadre posible de este estado: sin él, cualquiera de los otros cinco defectos es indetectable desde el propio informe. Además `assetPurchases` sale de `fixed_assets.acquisition_cost` (`:228-233`) sin comprobar que la adquisición fuera en efectivo — un activo comprado a crédito se reporta como salida de caja que no ocurrió.

No tiene comando: `report` no expone `cashflow` (verificado en `src/cli/report-command.ts`), en un producto CLI-first. El estado de cambios en el capital contable no existe en ninguna capa (censo de `src/`: sólo aparece en la documentación del agente, `src/ai/docs/niif-marco-presentacion.md:32`). Ambas ausencias ya están declaradas en `docs/cli-command-catalog.md:2277, 2284` — **no las cuento como nuevas**, son rojos honestos con dueño.

### 11 · [NUEVA] · **BAJA** · El arrastre salta las cuentas cuyo saldo final quedó en cero: un saldo inicial viejo nunca se corrige a cero

`carryForwardBalances` filtra `AND ab.ending_balance <> 0` (`period-close.ts:404`). El filtro tiene sentido para no sembrar filas vacías, pero convierte el arrastre en no-idempotente frente a correcciones que llevan una cuenta a cero.

**Escenario.** Marzo cierra con 1112 (Banco USD) en 5.000 → abril nace con `beginning_balance = 5.000`. Se reabre marzo, se reversa el depósito, el `ending_balance` de marzo pasa a 0 y se recierra. El `SELECT` ya no devuelve la fila, el `ON CONFLICT` no dispara, y **abril conserva `beginning_balance = 5.000`**. La prueba de idempotencia existente sólo repite el arrastre sobre un saldo que no cambió (`tests/integration/period-close.int.spec.ts:98-115`), que es el caso que no falla.

### 12 · [NUEVA] · **BAJA** · `queryUnclosedEarnings` filtra por un tipo de cuenta que el esquema prohíbe

`AND a.account_type IN ('revenue', 'expense', 'contra_revenue')` (`report-service.ts:487`), pinado además por una prueba (`tests/services/reporting/report-service.spec.ts:277`). El `CHECK` de la 001 admite ocho tipos y `contra_revenue` **no** está entre ellos (`001_core_schema.sql:110-113`). El tercer elemento del `IN` no puede casar nunca. Es inocuo hoy, pero es la señal de que quien lo escribió creía que existía un tipo contra-ingreso — la misma creencia equivocada que hace que las devoluciones tengan que vivir como `revenue` con saldo deudor y que el hallazgo 2 exista.

### 13 · [II-SIGUE-VIVA] · **ALTA** · `ledger check --check balance` sigue ciego a `ending_balance` y `beginning_balance` (B1 de la auditoría II)

Verificado en `61379d0`: `checkBalance` compara **sólo** `debit_total` y `credit_total` contra la Σ de líneas posteadas (`src/services/accounting/ledger-checks.ts:73-74`), y el comentario de cabecera lo declara así (`:15`). `checkLedgerIntegrity` de doctor hace lo mismo (`src/ai/doctor-service.ts:781`). `runLedgerChecks` sigue con un único llamador, la CLI (`src/cli/ledger-command.ts`), y `getPeriodCloseStatus` sigue sin invocarlo. Ningún PR fusionado la tocó.

**Lo que esta lente añade es la consecuencia:** cuatro de mis hallazgos (3, 5, 7 y 11) producen deriva **exclusivamente** en `beginning_balance`/`ending_balance` y son por tanto invisibles para el único instrumento que el sistema tiene para detectarlos. B1 no es una omisión de cobertura: es el punto ciego exacto por donde entran los errores de arrastre que este árbol produce hoy.

### 14 · [II-SIGUE-VIVA] · **BAJA** · Float en el resumen de auditoría (B12)

`resumenAsiento` sigue sumando con `Number(...)` (`src/services/accounting/posting.ts:454-455`). Sin cambios. Añado que ya no es el único: `runMonthlyDepreciation` entra a `Decimal` desde `parseFloat` (`depreciation.ts:294-296`) y el resolutor de GraphQL suma con `parseFloat` (`resolvers/index.ts:143-144`).

---

## RECOMENDACIONES

| # | Tamaño | Recomendación | Cierra | Tramo destino |
|---|---|---|---|---|
| **R1** | **S** | Excluir `entry_type = 'closing'` de `queryIncomeStatementRows` (`report-service.ts:588`) y del `netIncome` del flujo de efectivo (`reports.ts:188`), con prueba que cierre un ejercicio y afirme que el estado de resultados anual **y** el de diciembre siguen dando el resultado real. El balance NO se toca: su suma desde el origen es correcta y depende de que el cierre sí esté ahí. | 1, mitad de 10 | **Inmediata** — es corrección, no capacidad |
| **R2** | **S** | En `generateClosingEntries`, emitir el lado por el SIGNO del saldo y no por `abs()`: ingreso con saldo acreedor → cargo, con saldo deudor → abono; gasto al revés (`period-close.ts:472-479, 508-515`). Y `totalRevenue`/`totalExpenses` deben acumular el saldo **con signo**, no su valor absoluto, para que `netIncome` salga bien. Prueba de conducta —no regex— con una cuenta de devoluciones: que las dos cuentas de ingreso queden en cero y 3200 reciba 40.000, no 60.000. | 2 | **Inmediata** |
| **R3** | **S** | Ítem bloqueante en `getPeriodCloseStatus`: «el periodo anterior está cerrado». Cinco líneas de SQL sobre `fiscal_periods` ordenadas por `start_date`. Y arreglar `inicial_confiable` para que mire el estado del periodo **anterior**, no el propio (`report-service.ts:988`). | 3 | **Inmediata** — el segundo trozo es un número que se atesta al SAT |
| **R4** | **M** | Que `--level N` haga lo que su ayuda promete: CTE recursivo que acumule los descendientes en el ancestro de nivel ≤ N, en lugar de filtrar. Mientras no exista, la salida honesta es rechazar la bandera con su razón, como ya hace `ledger balance show --dim` (`ledger-command.ts:210`). Prueba: una venta del catálogo base a `--level 2` cuadra. | 4 | **F01 bis / inmediata** (rechazar) · **F06** (implementar el roll-up) |
| **R5** | **S** | `restorePeriodStatus` debe re-arrastrar: llamar a `carryForwardBalances` en la misma transacción antes de volver a poner `hard_close` (`fiscal-calendar-service.ts:281-291`). Y `carryForwardBalances` debe **cascadear** hacia adelante mientras el periodo siguiente esté cerrado, no parar en N+1 (`period-close.ts:383-390`). Quitar de paso el `ending_balance <> 0` y sembrar el cero explícito. | 5, 11 | **Inmediata** — hay un llamador vivo (`iva-ppd-reclass.ts:275`) |
| **R6** | **S** | Extender `checkBalance` a las dos columnas que le faltan —`ending_balance IS DISTINCT FROM beginning_balance + debit_total − credit_total`— y correr `runLedgerChecks` como ítem **bloqueante** dentro de `getPeriodCloseStatus`. Es la R1/R2 de la auditoría II, sigue sin hacerse, y ahora tiene cuatro hallazgos que sólo ella puede atrapar. Prueba de mutación que inyecte deriva **sólo** en `ending_balance`. | 13, y hace detectables 3/5/7/11 | **F01 bis / inmediata** |
| **R7** | **S** | Quitar `a.is_active = true` de `queryTrialBalanceRows` (`report-service.ts:290`) por la misma razón escrita en el balance (`:412-416`), y cambiar la prueba que hoy fija lo contrario (`report-service.spec.ts:73`). Añadir una prueba cruzada: balanza y balance general deben coincidir en el universo de cuentas. | 6 | **Inmediata** |
| **R8** | **M** | Depreciación: indexar el calendario por **diferencia de meses de calendario** (`(añoP−añoI)*12 + (mesP−mesI)`), no por 30,44 días (`depreciation.ts:307-310`); fechar el asiento en el periodo que se está corriendo, no en `entry.period_start_date`; y hacer el tapón del último mes sobre el valor en libros **ya redondeado** para que Σ posteado = costo − salvamento exacto. Pruebas: un activo con inicio 2026-01-01 consume 12 filas distintas en 12 meses; un activo de 100.000/36 meses acumula exactamente 100.000,0000 en la 1290. | 7 | **F06 / DEP-2**, junto con el llamador que E1.4 ya reclama |
| **R9** | **S** | GraphQL: calcular `isBalanced` en vez de escribirlo (`resolvers/index.ts:146`), anidar los dos joins como en `report-service.ts:309-313` para excluir borradores, honrar los tres argumentos o quitarlos del esquema, y **retirar `balanceSheet` e `incomeStatement` del esquema** hasta que tengan resolutor — igual que se retiró `POST /reconciliations/:id/complete` con su razón escrita. Mejor todavía: que los tres deleguen en `report-service`. | 8 | **Inmediata** (retirar) · **F06** (delegar) |
| **R10** | **M** | Cierre en dos pasos: 3900 → **3300** al cerrar el ejercicio, y 3300 → 3200 en la apertura del siguiente. Es el paso que le falta al capital ganado para presentarse por componente y el cimiento del estado de cambios en el capital contable que el catálogo ya tiene diagnosticado (`cli-command-catalog.md:2277`). Como toca criterio de presentación, si se quiere ofrecer el barrido directo debe ser **fila del panel de políticas** con su lector en el mismo commit — regla de la casa (a). | 9 | **F06** |
| **R11** | **M** | Añadir al flujo de efectivo el renglón que lo hace verificable: efectivo al inicio, efectivo al final, y la afirmación `net_cash_flow == final − inicial` calculada de las cuentas de efectivo reales, con salida 4 si no casa. Es más barato que el método directo y convierte los otros cinco defectos en detectables desde el propio informe. | mitad de 10 | **F06 / reportes** |
| **R12** | **S** | Decidir y documentar dónde vive la diferencia por redondeo. Hoy no hay ninguna cuenta para ella en todo el árbol, y ya hay al menos un productor (la depreciación) y ningún consumidor. Si la respuesta es «no hace falta porque todo es 19,4 y los tapones cierran», entonces hay que **probarlo**: una prueba por cada camino que reparte (depreciación, prorrateo de IVA, conversión FX) que afirme Σ partes = total exacto. | 7 (mitad), higiene de toda la lente | **F06** |
| **R13** | **S** | Cambiar `tests/accounting/period-close-accounts.spec.ts` de regex sobre el fuente a prueba de conducta, y añadir a `period-close.int.spec.ts` los tres casos que hoy no existen: cuenta de ingreso con saldo deudor, cierre fuera de orden, y reapertura + recierre con verificación del inicial del siguiente. Las tres fallan hoy. | pruebas de 2, 3, 5 | **Inmediata** |
| **R14** | **S** | `Decimal` en los tres puntos flotantes del camino del dinero: `posting.ts:454-455`, `depreciation.ts:294-296`, `resolvers/index.ts:143-144`. | 14 | Cualquiera |

---

## LO QUE NO PUDE VERIFICAR

- **No hay Postgres en este entorno.** Los hallazgos 2 y 7 están probados por ejecución de la aritmética replicada con el `decimal.js` del repositorio; los hallazgos 1, 3, 4, 5, 6, 8, 10, 11, 12 y 13 están razonados sobre SQL y código leídos línea por línea, no ejecutados contra una base. El que más se beneficiaría de una corrida real es el 3 (secuencia cerrar-marzo-con-enero-abierto).
- **Plan Maestro v3**: la copia HTML del scratchpad no formó parte de esta lente; las referencias de plan salen de `docs/cli-command-catalog.md`, que sí leí.
- **Consolidación multi-entidad y eliminaciones intercompañía**: cero motor en `src/` (confirmado); el catálogo lo asigna a reportes fase 2 (`cli-command-catalog.md:2421-2424, 580`). No lo cuento como hallazgo nuevo — la auditoría II ya lo levantó como B6; lo único que aporto es cerrar su duda abierta (hallazgo 8).
- **Cuentas de orden**: no existen en el esquema (el `CHECK` de `account_type` no las contempla, `001:110-113`) y el catálogo las tiene en fase 3 (`cli-command-catalog.md:535`). Ausencia declarada, no hallazgo.
