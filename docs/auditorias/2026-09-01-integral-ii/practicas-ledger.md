# LENTE 4 — MEJORES PRÁCTICAS DEL NÚCLEO CONTABLE (el mayor)

HEAD `a149e62`, rama `fase-0-1-cli-y-cimientos`. Todo lo que sigue está verificado contra el árbol de trabajo; tres hallazgos están además **probados por ejecución** contra la base viva (`accounting_core`, en transacciones con ROLLBACK). Lo que no pude verificar va marcado como tal.

---

## FORTALEZAS (verificado)

**F1. El mayor ya es físicamente inviolable, y con prueba por mutación en ambas direcciones.**
`ledger_posteado_inmutable()` compara por resta de JSONB con lista blanca (`041_el_mayor_inviolable.sql:35-66`), la línea hereda el estado del padre (`041:68-99`), y TRUNCATE se bloquea a nivel sentencia (`041:103-117`). El diseño es mejor que un REVOKE: una columna nueva nace protegida por omisión (`041:19-20`), y el propio archivo explica por qué NO hay REVOKE (el GRANT general lo devolvería, `041:28-32`). La prueba intenta las seis mutaciones prohibidas Y las cuatro permitidas (`tests/integration/mayor-inviolable.int.spec.ts:56-124`). Verifiqué el trigger contra la base real: el rechazo es genuino.

**F2. `ledger check` existe como registro nombrado y enumerable, modelo `hledger`.**
`LEDGER_CHECK_NAMES` con bloqueantes por defecto (`src/services/accounting/ledger-checks.ts:30-32`), verificación desconocida rechazada con la lista disponible (`ledger-checks.ts:146-151`), y la puerta CLI con salida 4 (`src/cli/ledger-command.ts:91-122`). El chequeo `audit-trail` —posteados sin fila `post` en la bitácora— es un control que la mayoría de los ERP ni nombra (`ledger-checks.ts:87-106`).

**F3. Maker-checker humano cableado, y como decisión del panel, no de código.**
`postJournalEntry` consulta `segregacion_de_funciones` y sólo el literal `'exigir'` bloquea (`src/services/accounting/posting.ts:308-333`); la política vive en el catálogo con default `off` razonado para el despacho unipersonal (`src/services/policy/pending-catalog.ts:439-460`); el criterio del tablero vigila que la clave no salga del panel (`src/plan/criterios.ts:658-669`). El alcance —sólo pólizas manuales, `source_type` nulo— está argumentado, no asumido (`posting.ts:310-315`). Cumple la regla de la casa (a) al pie de la letra.

**F4. TOCTOU posteo-vs-cierre cerrado con dos candados que se cruzan.**
`bloquearPeriodoParaPostear` toma `FOR SHARE` dentro de la transacción de posteo (`posting.ts:417-435`), aplicado en los DOS caminos —`postJournalEntry` (`posting.ts:340`) y el `autoPost` de `createJournalEntry` (`posting.ts:186`)—; el cierre suave toma `FOR UPDATE` de la fila y evalúa el checklist YA dentro de la transacción (`src/services/accounting/period-close.ts:205-217`). La re-verificación usa deliberadamente la misma regla que la validación para cerrar la carrera sin cambiar comportamiento (`posting.ts:412-415`).

**F5. El refresco de vistas salió del posteo.**
`DROP TRIGGER trg_refresh_materialized_views` + `DROP FUNCTION refresh_materialized_views` (`042_el_refresco_sale_del_posteo.sql:26-27`), con el camino de reemplazo ya existente nombrado en la migración (`042:14-21`). Elimina el único cuello de botella medible del motor y la fuga de coste entre inquilinos.

**F6. La serie del folio la fija la fecha del documento.**
Contador por `(entidad, tipo_AAAA)` sembrado desde los folios REALES ya emitidos, no desde el contador viejo que mezclaba años (`043_la_serie_del_folio_por_ejercicio.sql:26-45`), con `GREATEST` en el conflicto por corridas parciales. Las llaves viejas se conservan como constancia del modelo anterior (`043:20-23`) — decisión de auditor, no de programador.

**F7. Corrección sólo por reversa, con las guardas correctas.**
Sólo posteados se reversan y sólo una vez (`posting.ts:501-513`), el original NO pasa a `void` (se expresa por `reversed_by_entry_id`, `posting.ts:550-553`), y el rastro se escribe en la misma transacción (`posting.ts:551-559`). El `FOR UPDATE` está en todos los caminos (`posting.ts:270, 578`).

**F8. Cierre anual correcto y agregando el ejercicio completo.**
Cuentas de cierre resueltas por CÓDIGO 3900/3200 con el bug documentado que evitan (`period-close.ts:423-440`), agregación sobre TODOS los periodos del `fiscal_year_id` (`period-close.ts:448-458, 491-499`), y `carryForwardBalances` idempotente y sólo de cuentas de balance, con la invariante enunciada (`period-close.ts:370-414`).

**F9. Cobertura de bitácora extendida a los ciclos de documento.**
`registrarAuditoria` ya se invoca desde `invoice-service`, `bill-service` y `payment-service`, no sólo desde el asiento derivado (verificado por censo de importadores). Era la brecha 8 de la auditoría I, en su mitad de ESCRITURA.

**F10. Los reportes financieros no dependen de `account_balances`.**
Balanza, estado de resultados y mayor se calculan de las LÍNEAS vivas (`src/services/reporting/report-service.ts:305-307, 405, 481, 582-583`). Esto es lo que impide que el hallazgo B1 de abajo llegue a los estados financieros — es una fortaleza real, y también la razón de que la deriva pueda vivir años sin que nadie la note.

**F11. Los rojos son honestos y están razonados en el propio código.**
`POST /reconciliations/:id/complete` está RETIRADO con la explicación completa de por qué marcar `balanced` era una atestación falsa (`src/api/rest/routes/bank-reconciliation.ts:274-310`), y `GET /reconciliations/:id` advierte al renderizador que sus ceros significan «no calculado» (`bank-reconciliation.ts:239-243`). `ledger balance show --dim` rechaza con «las dimensiones no tienen maestro todavía» (`src/cli/ledger-command.ts:210`). Cumple la regla de la casa (d) mejor que cualquier ERP comercial.

---

## BRECHAS

### B1 · `ledger check` es ciego a la mitad de `account_balances`, y el nombre reservado para esa mitad ya se gastó — **MUTÓ desde la auditoría I** · MAYOR

La brecha 2 de la auditoría I («`account_balances` no se verifica») se cerró **sólo para dos de sus cuatro columnas**.

`checkBalance` compara únicamente `debit_total` y `credit_total` contra la Σ de líneas posteadas (`src/services/accounting/ledger-checks.ts:57-78`). `checkLedgerIntegrity` de doctor hace exactamente lo mismo (`src/ai/doctor-service.ts:778-794`). **Ninguno de los dos lee `ending_balance` ni `beginning_balance`.**

Y esas dos columnas son load-bearing: `carryForwardBalances` las propaga de ejercicio a ejercicio (`period-close.ts:397-410`), el auxiliar las muestra como saldo inicial y final (`report-service.ts:960-996`), `entry preview` calcula el delta contra `ending_balance` (`src/services/accounting/journal-entry-service.ts:608-613`), las herramientas del agente las sirven (`src/ai/tools/report-tools.ts:61,69`) y el espejo contra Contalink compara contra ellas (`src/ai/external-service.ts:82`).

**Probado por ejecución** (transacción con ROLLBACK contra `accounting_core`): inyecté `ending_balance = ending_balance + 99999` en una fila y corrí el SQL EXACTO del check `balance`:

```
 hallazgos_del_check_balance
                           0
 filas_que_violan_ending=beginning+d-c
                                     1
```

Cero hallazgos. La invariante que sí lo atrapa es una línea de SQL que no corre nadie.

Y hay tres agravantes que convierten esto de omisión en **verde falso**:

1. **El auxiliar detecta la deriva y remite a un comando que no puede verla.** `getAuxiliaryView` calcula `final_calculado = inicial + cargos - abonos` y lo compara con `final` (`report-service.ts:993-995`); cuando difieren, la CLI imprime `(calculado X: hay deriva — corre ledger check)` (`src/cli/ledger-command.ts:185`). `ledger check` es estructuralmente incapaz de encontrarla.
2. **El nombre `continuity` se gastó en otra verificación.** El catálogo define `continuity` como «el saldo final de cada cuenta en N es el inicial en N+1», la marca 🟡 y dice literalmente que `carryForwardBalances` «mantiene el invariante `ending = beginning + debit − credit` y **nadie lo verifica después**» (`docs/cli-command-catalog.md:565`). Lo que F01 embarcó bajo ese nombre es detección de HUECOS EN EL FOLIO (`ledger-checks.ts:108-131`) — otra cosa. Cuatro líneas más abajo, el mismo documento marca la fila `ledger check` como «✅ **hecha en F01**: balance, audit-trail y continuity nombradas» (`cli-command-catalog.md:570`). El catálogo se contradice a sí mismo en la misma página, y la mitad que se lee primero es la verde.
3. **El cierre no corre `ledger check`.** `runLedgerChecks` tiene UN solo llamador en todo `src/`: la CLI (`src/cli/ledger-command.ts:109`). El ítem «Trial balance balanced» del checklist suma `debit_total`/`credit_total` de `account_balances` (`period-close.ts:106-118`), así que una deriva de dos lados —o cualquier deriva en `ending_balance`— pasa el cierre sin ruido.

### B2 · `new Date("YYYY-MM-DD")` en las superficies HTTP asienta en el día (y a veces en el PERIODO) anterior — **NUEVA** · MAYOR

`createDraftEntry` documenta y corrige este bug para la CLI con un comentario explícito de cinco líneas: «LOCAL midnight, not UTC midnight: node-postgres serialises a Date with the process's offset… an entry silently booked into the previous day, and occasionally into the previous PERIOD» (`src/services/accounting/journal-entry-service.ts:355-359`).

La corrección **no llegó a las otras tres puertas**:
- `POST /v1/journal-entries` — `new Date(entry_date)` con `entry_date` validado como `YYYY-MM-DD` (`src/api/rest/routes/journal-entries.ts:54, 184`)
- `POST /v1/journal-entries/:id/reverse` — `new Date(reversal_date)` (`journal-entries.ts:72, 260`)
- GraphQL `createJournalEntry` — `new Date(input.entryDate as string)` (`src/api/graphql/resolvers/index.ts:180`); no hay resolutor de escalar `Date` que normalice antes.

**Probado por ejecución** con el serializador real de `pg` en `TZ=America/Mexico_City`:

```
CLI path  new Date("2026-08-01T00:00:00") -> 2026-08-01T00:00:00.000-06:00
REST path new Date("2026-08-01")          -> 2026-07-31T18:00:00.000-06:00
```

Consecuencia: una póliza fechada 1-ago por API aterriza como **31-jul** en la columna DATE, y `createJournalEntry` busca el periodo con esa MISMA marca desplazada (`posting.ts:92-99`), así que también elige el periodo de julio. Si julio está en `hard_close` la API rechaza una póliza de agosto perfectamente válida con «No open fiscal period found»; si julio sigue abierto, la póliza se asienta en el mes equivocado y el 041 impide corregirla por edición — hay que reversar. Es el escenario exacto que el comentario de la CLI describe, vivo en las tres puertas que no lo leyeron.

### B3 · Los disparadores de inmutabilidad no tienen brazo de INSERT; la línea añadida a un posteado se bloquea por ricochet — **NUEVA** · MEDIA

Ambos disparadores del 041 son `BEFORE UPDATE OR DELETE` (`041_el_mayor_inviolable.sql:65, 98`). No existe brazo `INSERT` en `journal_entry_lines`, así que insertar una línea nueva en un asiento POSTEADO no toca la función de inmutabilidad.

**Probado por ejecución** — el INSERT sí falla, pero mírese POR DÓNDE:

```
ERROR:  journal_entries: un asiento POSTEADO no se edita (JE-2026-00006)...
CONTEXT: PL/pgSQL function ledger_posteado_inmutable() line 21 at RAISE
SQL statement "UPDATE journal_entries SET total_debits = ..."
PL/pgSQL function update_je_totals() line 3 at SQL statement
```

La defensa es indirecta: el disparador de totales de 2024 (`001_core_schema.sql:300-325`, `AFTER INSERT OR UPDATE OR DELETE`) emite un UPDATE sobre `journal_entries`, y ese UPDATE choca contra el 041 porque `total_debits`/`total_credits` **no están en la lista blanca**. La propiedad se sostiene hoy sobre dos accidentes: que `update_je_totals` siga existiendo, y que nadie añada esas dos columnas a `permitidas` — que es exactamente lo que parecen (metadatos derivados) para quien mañana lea la lista sin este contexto. Ni el comentario del 041 ni la prueba de integración nombran el INSERT (`tests/integration/mayor-inviolable.int.spec.ts:56-124`: sólo UPDATE, DELETE y TRUNCATE). Un muro cuya viga maestra es un efecto colateral no probado.

### B4 · La marca de conciliación del mayor es huérfana: se lee, se blinda, y no la escribe nadie — **NUEVA** · MEDIA

`journal_entry_lines.is_reconciled / reconciled_at / reconciliation_id` (`001_core_schema.sql:275-277`) están: **leídas** por el motor de emparejamiento, que sólo propone contra líneas con `is_reconciled = false` (`src/services/banking/matching.ts:324`); **protegidas** con lista blanca explícita en el 041 para que un escritor legítimo pueda tocarlas sobre posteados (`041:70`); y **escritas por nadie** — el censo de `src/` no encuentra un solo UPDATE. El camino de emparejamiento escribe `bank_transactions.is_matched`, no la línea del mayor (`src/api/rest/routes/bank-reconciliation.ts:173-176`). Consecuencia operativa: `autoMatch` vuelve a proponer eternamente las mismas líneas ya emparejadas, y el 041 blinda una escritura que no existe.

### B5 · Dimensiones aceptadas de punta a punta sin maestro, y sin casa en el plan maestro — **NUEVA (en su mitad de plan)** · MEDIA

`cost_center_id`, `department_id`, `project_id` y `class_id` son UUID sueltos sin FK ni tabla destino (`001_core_schema.sql:269-272`). Los aceptan la CLI (`src/cli/bill-command.ts:416-417`, `src/cli/invoice-command.ts:486-487`), REST con validación `z.string().uuid()` que no comprueba existencia (`src/api/rest/routes/journal-entries.ts:44-45`, `bills.ts:47-48`, `invoices.ts:43-44`), GraphQL (`resolvers/index.ts:174-175`) y el motor (`posting.ts:29-30, 141-143`). Se puede etiquetar una línea posteada con un UUID inventado y nada protesta.

El código es honesto: `ledger balance show --dim` rechaza citando la familia inexistente (`src/cli/ledger-command.ts:210`) y el catálogo dedica cuatro filas a `dimension` con el hueco documentado (`docs/cli-command-catalog.md:436-443`). Pero el **plan maestro no menciona «dimensión» ni una sola vez** (extraje el texto del artefacto y busqué: 0 apariciones de `dimension`/`dimensión`). A diferencia de banco (F05), FX (R4) y depreciación (F06/DEP-2), esta familia no tiene fase asignada — sólo un prerrequisito citado desde otras filas que se autodeclaran bloqueadas.

### B6 · Consolidación y eliminaciones intercompañía: cimientos puestos, motor y plan ausentes — **NUEVA** · MEDIA

La 037 añadió la contraparte intercompañía con relleno por RFC y comentario que nombra el propósito: «El amarre intercompañía (tie-out, eliminaciones de consolidación)» (`037_etiquetado_que_encarece.sql:60-75`). Pero: `account map set --scheme consolidation` rechaza porque no hay columna (`src/services/accounting/account-service.ts:454`); `balanceSheet(..., consolidate: Boolean)` está en el esquema GraphQL (`src/api/graphql/schemas/schema.ts:483-484`) — **no verifiqué si el resolutor honra la bandera o la ignora en silencio**, y esa distinción importa; el catálogo la asigna a «reportes» y la saca de GL (`cli-command-catalog.md:580`); y el plan maestro tiene **0 menciones** de consolidación. Como B5: nombrada en el catálogo, sin dueño en el plan.

### B7 · Conciliación bancaria sin aritmética — **SIGUE-ABIERTA** (rojo honesto, con dueño)

Sin cambios desde la auditoría I, y por diseño. El endpoint de completar está retirado con la razón escrita (`bank-reconciliation.ts:274-310`), el cierre la degrada a advertencia (`period-close.ts:34-39`) y el plan maestro le asigna F05 («38 filas · bank 30 · reconciliation 8… motor neto nuevo»). No hay puerta CLI: el producto es CLI-first y la familia entera vive sólo en REST.

### B8 · Revaluación cambiaria B-15 inexistente — **SIGUE-ABIERTA** (ahora con dueño)

Censo de `src/` fuera de `src/ai/docs/`: cero código de revaluación. La infraestructura sí está completa —`exchange_rates` con cross-rate (`001_core_schema.sql:374-448`), importes foráneos por línea (`001:271-274`), y `currencyRule` que exige tipo y verifica la conversión con Decimal (`src/services/accounting/validation.ts:251-292`)— y la cerca de misma moneda en pagos sigue puesta, con su razón (`src/services/payments/payment-service.ts:162-170`), así que no hay ganancia/pérdida realizada posible. Sin roles `fx_gain`/`fx_loss`. **Progreso real**: era huérfana en la auditoría I y ahora es R4 en el plan maestro, con las tres piezas nombradas.

### B9 · Retención CFF art. 30 y archivado — **SIGUE-ABIERTA**

La 004 sigue prometiendo particionado en un comentario («in production, migrate data with pg_partman», `004_partitioning_and_views.sql:10-11`) y creando sólo índices. Ninguna política implementa los 5 años ni la purga auditada que la 033 se reservó (`033_audit_log_append_only.sql:23-25`). El plan maestro sí la nombra ahora («la retención CFF art. 30 (particionado + purga auditada)»), sin item ejecutable que yo pueda citar.

### B10 · La bitácora sigue sin superficie de lectura — **MUTÓ** (cerrada la escritura, abierta la lectura)

Los ciclos de invoice/bill/payment ya auditan (F9). Pero `FROM audit_log` sólo aparece en dos consumidores internos —`doctor-service.ts:800, 836, 842` y `ledger-checks.ts:93`— y **ninguna ruta REST ni comando CLI la lee**. Un auditor externo que pida el rastro de una póliza hoy necesita `psql`. Es media brecha de un control que por lo demás es ejemplar (dos capas, append-only, transaccional).

### B11 · `future` y `soft_close` aceptan cualquier posteo con sólo advertencia — **SIGUE-ABIERTA**, y es deuda de la regla de la casa (a)

`periodStatus` sólo convierte en error `hard_close`/`locked`; `soft_close` y `future` producen advertencias (`validation.ts:176-186`), y `bloquearPeriodoParaPostear` replica esa regla a propósito (`posting.ts:429-434`). El soft close no restringe a asientos de ajuste ni por rol. **Esto es una bifurcación de criterio contable sin fila en `policy_decisions`** — el panel ya tiene ocho políticas y ésta no está.

### B12 · Float residual en el resumen de auditoría — **SIGUE-ABIERTA** (trivial)

`resumenAsiento` sigue sumando con `Number(...)` para los totales del rastro (`posting.ts:454-455`). No toca el mayor; ensucia el único punto del camino del dinero que no usa Decimal.js.

---

**Dictamen sobre las 12 brechas de la auditoría I:** cerradas 5 (1 mayor reescribible, 3 SoD, 6 doble REFRESH, 7 TOCTOU, 10 serie del folio). Mutaron 2 (la 2 → B1, la 8 → B10). Siguen abiertas sin cambio 5 (4, 5, 9, 11, 12). Ninguna se cerró en falso salvo la parte de la 2 que B1 documenta. **Los tres hallazgos mayores que la auditoría I nombró —mayor reescribible, `account_balances` sin verificación, sin revaluación FX— quedan: el primero CERRADO y bien; el segundo CERRADO A MEDIAS con verde falso en el catálogo; el tercero ABIERTO pero por fin con dueño.**

---

## RECOMENDACIONES

**R1 · (S) Extender `checkBalance` a las cuatro columnas y devolverle el nombre a `continuity`.** Añadir a `ledger-checks.ts:73-74` la condición `ending_balance IS DISTINCT FROM beginning_balance + debit_total - credit_total`, o —mejor, porque respeta el contrato ya publicado— separar: `balance` sigue siendo cargos=abonos vs líneas, y `continuity` pasa a ser la invariante del arrastre que el catálogo ya define (`cli-command-catalog.md:565`), moviendo la detección de huecos de folio a un nombre propio (`folio-gaps`). Actualizar `checkLedgerIntegrity` (`doctor-service.ts:778-794`) en el mismo commit, y una prueba de mutación que inyecte deriva SÓLO en `ending_balance` — hoy ninguna la atrapa. Cierra B1. **Fase: F01 bis / inmediata** — es corrección de algo declarado hecho, no capacidad nueva.

**R2 · (S) Correr `runLedgerChecks` dentro de `getPeriodCloseStatus` como ítem bloqueante.** El comando existe y tiene un solo llamador (la CLI). El cierre es exactamente el momento en que la integridad del mayor debe ser compuerta y no consulta opcional. Cierra la mitad operativa de B1. **Fase: F06 (cerrar el mes)**, o antes si R1 se hace sola.

**R3 · (S) Normalizar la fecha a medianoche LOCAL en las tres puertas HTTP.** Un helper `fechaContable(s: string): Date` que haga `new Date(\`${s}T00:00:00\`)`, aplicado en `journal-entries.ts:184`, `journal-entries.ts:260` y `resolvers/index.ts:180`; y una prueba que corra con `TZ` al oeste de Greenwich y afirme que una póliza del día 1 aterriza en el mes correcto. Cierra B2. **Fase: inmediata** — es un bug de corrección con consecuencia de periodo, ya diagnosticado y resuelto en otra puerta del mismo repo.

**R4 · (S) Dar brazo de INSERT explícito al 041.** `CREATE TRIGGER ... BEFORE INSERT ON journal_entry_lines` que rechace si el padre está `posted`, más un caso en `mayor-inviolable.int.spec.ts` que intente insertar un par balanceado. Hoy la propiedad se sostiene por ricochet a través de `update_je_totals`; hacerla explícita cuesta ocho líneas y quita la dependencia de que nadie whiteliste `total_debits`. Cierra B3. **Fase: inmediata** — completa un blindaje ya embarcado.

**R5 · (M) Decidir el destino de la marca de conciliación del mayor.** Dos salidas legítimas: (a) que el emparejamiento escriba `is_reconciled/reconciled_at/reconciliation_id` en la línea, cerrando el bucle que `matching.ts:324` ya espera; o (b) declararla capacidad reclamada de F05 y quitarla del camino de lectura para que `autoMatch` no reproponga. Lo que no puede quedarse es leída-y-blindada-sin-escritor. Cierra B4. **Fase: F05 (banco)**.

**R6 · (M) Subir la familia `dimension` al plan maestro con fase propia.** Tablas `cost_centers`/`departments`/`projects`/`classes` con FK desde `journal_entry_lines`, `bill_lines`, `invoice_lines` y `fixed_assets`; y `dimension policy set` como POLÍTICA DEL PANEL (qué dimensión es obligatoria por patrón de cuenta es criterio contable configurable, regla de la casa (a)), no como bandera. Es prerrequisito declarado de `allocation`, de `ledger check --check dimension-balance` y de 27 filas del catálogo. Cierra B5. **Fase: nueva, entre F01 y F06** — todo lo que hoy se autodiagnostica bloqueado depende de ella.

**R7 · (M) Verificar y declarar el estado de `consolidate` en GraphQL, y darle fase a la consolidación.** Primero lo barato: confirmar si `balanceSheet(consolidate:)` (`schema.ts:483-484`) honra la bandera o la ignora — si la ignora, retirarla del esquema como se retiró `/reconciliations/:id/complete`, porque una bandera de consolidación que no consolida es la misma clase de atestación falsa. Después, fase para grupos, eliminaciones, participación no controladora y CTA, sobre los cimientos que la 037 ya puso. Cierra B6. **Fase: R-serie o fase 3 declarada**.

**R8 · (S) Subir `posteo_en_periodo_no_abierto` al panel de políticas.** Modos `permitir` / `advertir` / `solo_ajustes` / `exigir` para `soft_close`, y `permitir`/`bloquear` para `future`. El código ya lo llama «policy gate» sin panel (`validation.ts:176-186`); el panel ya tiene el molde de ocho políticas y `pending-catalog.ts` la fila donde ponerla. Cierra B11 y paga deuda de la regla de la casa (a). **Fase: F06**.

**R9 · (S) Superficie de lectura de la bitácora.** `mnemosine audit list --entity-type --entity-id --since` sobre el molde de `ledger-command.ts`, riesgo `lectura`, IA ✓. La tabla está blindada, es transaccional y hoy sólo se lee con `psql` — el control más fuerte del sistema es el único sin puerta. Cierra B10. **Fase: F01 bis / F06**.

**R10 · (S) `Decimal.js` en `resumenAsiento`.** Tres líneas en `posting.ts:454-455`. Cierra B12 y deja el camino del dinero sin un solo `Number()`. **Fase: cualquiera**.

**R11 · (L) Ejecutar R4 del plan maestro (revaluación B-15) antes de la primera entidad con USD que llegue a un cierre.** Roles `fx_gain`/`fx_loss` en `account_roles`, corrida de revaluación como tipo de asiento propio, y ganancia/pérdida REALIZADA al aplicar pagos cuando se levante `assertMoneda` (`payment-service.ts:162-170`). La infraestructura está completa; falta el motor. Cierra B8. **Fase: R4, ya asignada**.

**R12 · (L) Retención CFF art. 30 con item ejecutable.** Particionado real de `journal_entry_lines` y `audit_log` por año + purga como migración auditada — la salida que la 033 se reservó (`033:23-25`). Está nombrada en el plan maestro sin item; convertirla en uno. Cierra B9. **Fase: fase 2**.

---

## MAPA DE COBERTURA DEL LENTE (motor / puerta / probado / en plan)

| Práctica | Motor | Puerta | Probado | En plan | Evidencia |
|---|---|---|---|---|---|
| Partida doble | ✅ dos capas | ✅ | ✅ | — | `001:252, 284-289`; `validation.ts:63-89` |
| Inmutabilidad del mayor | ✅ | ✅ | ✅ (sin INSERT) | cerrado | `041:35-117`; `mayor-inviolable.int.spec.ts` |
| Periodos y cierre suave/duro/bloqueo | ✅ | ✅ | ✅ | — | `001:203-204`; `period-close.ts:192-300` |
| Reapertura con rastro | ✅ | ✅ | ✅ | — | `fiscal-calendar-service.ts:215-304` |
| Arrastre de saldos | ✅ | ✅ | ✅ | — | `period-close.ts:378-414` |
| **Verificación del arrastre** | ❌ | ❌ | ❌ | 🟡 catálogo se contradice | **B1** |
| Conciliación bancaria | ❌ aritmética | 🟡 sólo REST | n/a | ✅ F05 | **B7** |
| Multi-moneda (registro) | ✅ | ✅ | ✅ | — | `001:374-448`; `validation.ts:251-292` |
| **Revaluación FX B-15** | ❌ | ❌ | ❌ | ✅ R4 | **B8** |
| Consolidación / eliminaciones | ❌ | 🟡 bandera GraphQL sin verificar | ❌ | ❌ | **B6** |
| **Dimensiones + maestro** | ❌ | 🟡 aceptadas sin validar | ❌ | ❌ | **B5** |
| Devengos y provisiones | ❌ | ❌ | ❌ | 🟡 F06 «devengos por plantilla» | censo de `src/` |
| Activo fijo y depreciación | ✅ 5 métodos | ❌ sin llamador | 🟡 | ✅ F06/DEP-2 | `depreciation.ts:270-340`; `plan:status` E1.4 |
| Inventarios y costeo | ❌ | ❌ | ❌ | ✅ reclamado en `038` | `038:28-32` |
| Papeles de trabajo / evidencia | ❌ | ❌ | ❌ | ❌ | sin `entry support` en `src/` |
| Segregación de funciones | ✅ | ✅ | ✅ | cerrado | `posting.ts:308-333`; `posting-sod.spec.ts` |
| Pista de auditoría (escritura) | ✅ | ✅ | ✅ | — | `033`; 11 servicios |
| **Pista de auditoría (lectura)** | ✅ | ❌ | — | ❌ | **B10** |
| Numeración y folios | ✅ | ✅ | ✅ | cerrado | `043`; `utils/sequence.ts` |
| Cierre anual / resultado | ✅ | ✅ | ✅ | — | `period-close.ts:416-500` |
| Retención / archivado | ❌ | ❌ | ❌ | 🟡 sin item | **B9** |

---

**Balance honesto.** El núcleo es hoy más fuerte que en la auditoría I, y las cinco cerraduras que se pusieron (041, 042, 043, el candado de periodo, el maker-checker del panel) están bien hechas: con lista blanca argumentada, con prueba por mutación en ambas direcciones, y con la razón escrita en la migración. Lo que este lente encuentra no son cerraduras flojas sino **tres huecos de cobertura en cerraduras buenas**: el chequeo de saldos que sólo mira dos de cuatro columnas y encima gastó el nombre reservado para la tercera (B1); la normalización de fecha que llegó a una puerta de cuatro (B2); y el blindaje de inmutabilidad cuyo brazo de INSERT lo sostiene un efecto colateral de 2024 (B3). Los tres son baratos y los tres son de la clase que la casa dice preferir muerta: verde que no es verde. Lo perimetral —banco, FX, depreciación, retención— sigue rojo y sigue honesto, y a diferencia de agosto ya casi todo tiene dueño; las dos excepciones sin casa en el plan maestro son dimensiones y consolidación.

---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** `ledger check --check balance` es ciego a `ending_balance`/`beginning_balance` —las dos columnas que el arrastre propaga entre ejercicios— y el nombre `continuity`, que el catálogo reservó para esa invariante (docs/cli-command-catalog.md:565, «nadie lo verifica después»), se gastó en detectar huecos de folio (src/services/accounting/ledger-checks.ts:57-78 y :108-131): inyecté 99,999 de deriva en `ending_balance` contra la base viva y el check devolvió CERO hallazgos, mientras el auxiliar sí la ve y remite al usuario a ese mismo comando incapaz de encontrarla (src/cli/ledger-command.ts:185).

**¿Refutado?** No: se sostiene

SE SOSTIENE, y la reproducción es literal. (1) CEGUERA CONFIRMADA — el único predicado de `checkBalance` es src/services/accounting/ledger-checks.ts:73-74: `COALESCE(ab.debit_total,0) IS DISTINCT FROM COALESCE(l.d,0) OR COALESCE(ab.credit_total,0) IS DISTINCT FROM COALESCE(l.c,0)`. Ni `ending_balance` ni `beginning_balance` aparecen en el SELECT (:57-59) ni en el WHERE. Grep sobre todo el repo: ninguna verificación, en ningún módulo y con ningún otro nombre, lee esas columnas para compararlas — el `checkLedgerIntegrity` de doctor tiene EXACTAMENTE el mismo WHERE (src/ai/doctor-service.ts:792-793) y la balanza del checklist de cierre suma `debit_total`/`credit_total`, no saldos (src/services/accounting/period-close.ts:96-108). Tampoco hay CHECK ni trigger que proteja la columna: `account_balances` (001_core_schema.sql:481-491) no tiene restricción alguna, y la 041_el_mayor_inviolable.sql solo la menciona en un comentario (:8) para decir que un UPDATE ilegítimo «desalinea account_balances sin rastro». (2) REPRODUCIDO — inyecté +99,999 en `ending_balance` de una fila (quedó beginning 0.0000, debit 11600.0000, credit 0.0000, ending 111599.0000) y corrí el SQL literal de :57-77: `hallazgos_balance = 0`, mientras la consulta del invariante devuelve 1 fila. Antes de inyectar, la base tiene 0 filas rotas: la deriva la metí yo y el check no la vio. Rollback verificado. (3) NOMBRE GASTADO CONFIRMADO, y peor de lo que dice el hallazgo: el catálogo no solo reserva `continuity` para el arrastre (docs/cli-command-catalog.md:565, «el saldo final de cada cuenta en N es el inicial en N+1 … nadie lo verifica después»), sino que asigna los huecos de folio a OTRO comando, `numbering check`·`folio verificar` (docs/cli-command-catalog.md:574), que sigue 🟡 sin implementar. F01 tomó el nombre de una verificación para hacer el trabajo de otra, y marcó la fila como «✅ hecha en F01» (catalog:569). (4) EL REENVÍO CIEGO CONFIRMADO — src/cli/ledger-command.ts:182-187 compara `aux.final` (= `ending_balance`, report-service.ts:960, :997) contra `aux.final_calculado` (= inicial+cargos−abonos, :998) y ante la diferencia imprime «hay deriva — corre ledger check»: manda al usuario al único comando que no puede encontrarla.

**Formulación corregida:** FORMULACIÓN CORREGIDA: «Ninguna verificación del sistema lee `account_balances.ending_balance` ni `beginning_balance`. `ledger check --check balance` (ledger-checks.ts:73-74), `doctor`/`checkLedgerIntegrity` (doctor-service.ts:792-793) y la balanza del checklist de cierre (period-close.ts:96-108) comparan solo `debit_total`/`credit_total` contra las líneas posteadas; el esquema no tiene CHECK ni trigger sobre la tabla (001_core_schema.sql:481-491). Inyectados 99,999 en `ending_balance` contra la base viva, el SQL de `checkBalance` devuelve CERO hallazgos. El nombre `continuity`, que el catálogo reserva para el invariante del arrastre (catalog:565) y cuyo trabajo actual —huecos de folio— el propio catálogo asigna a `numbering check` (catalog:574, sin implementar), se gastó en la verificación equivocada, y la fila quedó marcada ✅ (catalog:569). El auxiliar sí exhibe la deriva y remite a ese comando incapaz (ledger-command.ts:182-187).» MATICES QUE EL HALLAZGO OMITE, dos agravantes y uno atenuante: (a) AGRAVANTE — la deriva nunca se autocura: posting.ts:208-215 y :365-372 actualizan `ending_balance = account_balances.ending_balance + d − c` de forma INCREMENTAL, jamás recalculan desde los componentes, así que un valor sucio sobrevive a todo posteo posterior; (b) AGRAVANTE — `carryForwardBalances` siembra `beginning_balance` del periodo siguiente COPIANDO el `ending_balance` derivado (period-close.ts:396-398, :407), de modo que el error se propaga en vez de detenerse; (c) ATENUANTE parcial — en la rama ON CONFLICT ese mismo INSERT recalcula el ending del periodo destino como `beginning + debit − credit` (:407-409) y account-service.ts:119 evita a propósito `SUM(ending_balance)`; ninguna de las dos es una verificación ni reporta nada. PRECISIÓN MENOR: el arrastre no es «entre ejercicios» sino hacia el SIGUIENTE periodo fiscal por `start_date` (period-close.ts:383-389), disparado desde `hardClosePeriod` (:319) y limitado a cuentas de balance con ending distinto de cero (:401-404).

