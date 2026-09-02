_Lente 3 · La calidad real de las pruebas · árbol `61379d0` (origin/main `cfe40c6` + los dos commits de documentación del PR 19)._

Medí con las dos suites CORRIDAS (Postgres local disponible: unitarias 142 archivos / 2 185 pruebas en 20 s; integración 28 archivos / 255 pruebas en 15 s, ambas verdes) y con **mutación en ambas direcciones**, como pide la regla (c) de la casa. Ocho mutantes sembrados, restaurados uno por uno; el árbol quedó en `git diff` vacío y en verde al final.

---

## LO QUE RESISTE

Esto no es cortesía: es lo que aguantó una mutación deliberada.

1. **La cobertura SÍ está configurada, y con trinquete por archivo.** `vitest.config.ts:36-49` fija umbrales por archivo sobre `posting.ts` (99/95/100/99), `validation.ts`, `ar-ap-posting.ts` y `sequence.ts`, y `.github/workflows/ci.yml:59` los corre. La II no midió esto; decir «no hay cobertura» habría sido falso.
2. **Postear y reversar están probados de verdad y afirman el RESULTADO.** `tests/integration/posting-reversal.int.spec.ts` (14 pruebas) crea contra Postgres real, postea, reversa, anula, y comprueba saldos con `saldoDe` — no que «no truene». La segunda reversa se rechaza (:64), el desbalanceado no llega a saldos (:153), cinco concurrentes obtienen cinco folios (:164).
3. **La inmutabilidad del mayor está probada por conducta, no por prosa.** `tests/integration/mayor-inviolable.int.spec.ts:57-93`: `UPDATE` de monto, de cuenta, `DELETE` y hasta `TRUNCATE` revientan a nivel de disparador.
4. **`ledger check --check balance` mata a su mutante.** Sembré `AND false` en `src/services/accounting/ledger-checks.ts:73-74` y tres pruebas de integración se pusieron rojas (`f01-catalogo-asiento-mayor.int.spec.ts:158`, `mayor-inviolable.int.spec.ts:128` y `:133`). El chequeo hace algo. (Su límite está en el hallazgo 10.)
5. **Las 28 «de integración» son de integración de verdad.** Ninguna es unitaria disfrazada: revisé las 28 y todas importan `src/database/connection.js` o abren un `pg.Client`. `tests/integration/global-setup.ts:41-77` crea una base efímera por corrida, la migra y la destruye en `teardown`. Cubren RLS (una), disparadores de inmutabilidad, candados de periodo (`sello-periodo.int.spec.ts`, 13 pruebas), append-only de `audit_log` y del log de credenciales fiscales.
6. **Aplicar pago (lado CxP) está bien probado, con caminos de error.** `tests/integration/pagos.int.spec.ts`: 15 pruebas, de las cuales 11 son rechazos nombrados (más de lo debido, aplicaciones que exceden el pago, moneda distinta, descuento por pronto pago que «se rechaza en voz alta, no se traga», gasto de otra entidad conocido por UUID).
7. **Arrastre de saldos y cierre de ejercicio están probados contra Postgres.** `tests/integration/period-close.int.spec.ts:67` compara `beginning_balance` del periodo siguiente contra el `ending_balance` de abril; `:98` prueba idempotencia; `:119` que el barrido va a 3200 y nunca a 3100.
8. **La conciliación bancaria está RETIRADA con honestidad, no fingida.** `src/api/rest/routes/bank-reconciliation.ts:303-312` lanza `NotImplementedError` con la razón escrita: un `UPDATE status='balanced'` incondicional habría alimentado la lista de cierre con una atestación falsa. Es el ejemplar de «rojos honestos > verdes falsos» de la casa.
9. **No hay basura de prueba.** Cero `expect(true)`, cero `it.skip`/`it.todo`/`.only`, cero snapshots vacíos en las 170 specs. Los 34 `catch` de los tests son legítimos (abortos con temporizador, limpieza de roles de clúster); revisé los sospechosos (`tests/payroll/mx/imss-idse-batch.spec.ts:148`, `tests/integrations/pac-simulacion.spec.ts:43-50`) y ninguno se traga un fallo: el de PAC lleva su centinela `throw new Error('debió lanzar')` dentro del `try`.
10. **Caminos de error: 421 de 2 298 bloques `it` (18,3 %)** afirman un rechazo (`rejects`, `toThrow`, código de error, 4xx/5xx). No es el «solo camino feliz» que suele encontrarse.

---

## HALLAZGOS

### 1 · [NUEVA] · ALTA · Los cinco estados financieros nunca producen un número contra Postgres: su prueba recomputa en el fixture la aritmética que el SQL hace

`tests/services/reporting/report-service.spec.ts:3` mockea `query`, y `:36-44` construye la fila esperada así:

```ts
ending_balance: String(Number(debit) - Number(credit)),
```

Es decir: **el test calcula el saldo y luego comprueba que el saldo es el que él calculó**. La resta que vive en el SQL (`src/services/reporting/report-service.ts:307`) nunca se evalúa. De las 111 aserciones de ese archivo, 28 son sobre el TEXTO del SQL (`expect(sql(n)).toMatch(...)`), no sobre su resultado.

Y ninguna prueba de integración lo rescata: **cero archivos de `tests/integration/` importan `report-service`** (verificado con grep sobre los 28). `getTrialBalance`, `getBalanceSheet`, `getIncomeStatement`, `getGeneralLedger`, `getAgedReceivables` y `getAgedPayables` aparecen únicamente en `tests/services/reporting/report-service.spec.ts` y en `tests/cli/report-command.spec.ts`, que también mockea.

**Mutación verificada:** invertí el signo en `src/services/reporting/report-service.ts:307` (`debit - credit` → `credit - debit`). Resultado: **142/142 archivos y 2 185 pruebas unitarias verdes; 28/28 archivos y 255 pruebas de integración verdes.** 2 440 pruebas y ni una roja.

**Escenario de fallo:** alguien toca esa línea al añadir un filtro de periodo. La balanza de comprobación —el informe que el contador mira antes de firmar— imprime el activo en negativo y el pasivo en positivo, en el CLI (`src/cli/report-command.ts:254`) y en la herramienta del agente (`src/ai/tools/report-tools.ts:58`). CI verde. El error se descubre cuando un tercero cuadra contra el SAT.

### 2 · [NUEVA] · ALTA · Diecinueve tablas hijas quedan fuera de toda prueba de RLS, y la prueba de catálogo no las mira

`tests/integration/tenant-isolation.int.spec.ts` es **la única** de las 28 que ejercita un rol `NOBYPASSRLS` (`:43`, `:73` con `SET LOCAL ROLE`). Es un buen instrumento, pero su alcance son tres tablas: `legal_entities` (:87), `accounts` (:102) y `organizations` (:135). El clúster migrado tiene **70 tablas con política `tenant_isolation`** (contado en `pg_policy` sobre una base migrada) y **97 tablas** en `public`.

Peor: las tablas hijas llevan otra política, `tenant_isolation_child` (`src/database/rls-policies.sql:176-181`), y **no aparecen en ninguna de las dos redes**. La prueba de catálogo `tenant-isolation.int.spec.ts:141-164` sólo busca tablas que tengan columna `tenant_id` o `entity_id` y política llamada exactamente `tenant_isolation` — las hijas no tienen ninguna de las dos columnas, así que ni se enumeran. Y la comprobación es de NOMBRE de política, nunca de predicado.

**Mutación verificada:** cambié el predicado hijo de `rls-policies.sql:178-181` a `USING (true OR EXISTS (...))`. Resultado: **28/28 archivos, 255/255 pruebas verdes.**

**Escenario de fallo:** `journal_entry_lines`, `invoice_lines`, `bill_lines`, `payment_allocations`, `payment_applications`, `paycheck_taxes`, `garnishments` y 12 tablas más (la lista literal está en `rls-policies.sql:149-168`) quedan legibles y escribibles entre inquilinos. Un inquilino lee las líneas del mayor de otro. La suite entera dice que sí.

Nota adicional: los otros 27 archivos de integración corren los SERVICIOS como el superusuario dueño, que ignora RLS por diseño (`tenant-isolation.int.spec.ts:166-174` lo documenta bien). Consecuencia: **ninguna ruta de código de aplicación se ejerce nunca bajo RLS**; lo que las pruebas de frontera comprueban es el `WHERE entity_id` de la aplicación, no la política.

### 3 · [NUEVA] · ALTA · La depreciación: 380 líneas, seis funciones puras, cero pruebas

`src/services/assets/depreciation.ts` exporta `calculateStraightLine` (:35), `calculateDecliningBalance` (:70), `calculateSumOfYearsDigits` (:115), `calculateMACRS` (:160), `calculateUnitsOfProduction` (:202), `calculateDepreciation` (:246) y `runMonthlyDepreciation` (:270). Cobertura medida: **0 % de 380 líneas en la suite unitaria y 0 % en la de integración.** Las dos únicas menciones en `tests/` son de prosa: `tests/ai/orphan-scan.spec.ts:82` la usa como cadena de ejemplo y `tests/xml-ingestion/dep-promesa.spec.ts:9` comprueba que el agente AVISA que no existe puerta.

**Mutación verificada:** `depreciation.ts:38`, `monthlyDepreciation` × 2. **2 440 pruebas verdes.**

**Escenario de fallo:** las seis son funciones puras sin base de datos — el caso más barato de probar que existe en el repo — y ninguna tiene una sola aserción. El día que E1.4 cierre y `runMonthlyDepreciation` gane su llamador, el motor que empieza a escribir en el mayor no tiene una sola prueba detrás. `plan:status` ya marca E1.4 en rojo por «no tiene llamador»; **ningún criterio marca que tampoco tiene prueba**, así que el rojo se apagará en cuanto exista el llamador.

### 4 · [NUEVA] · ALTA · El filtro `status = 'posted'` de las copias del SQL de saldos no está probado: quitarlo sobrevive

`plan:status` ya reporta E4.2 en rojo por «4 copias del SQL de saldos fuera de report-service». Lo que nadie midió es que **esas copias no tienen red**. Mutación verificada: quité `AND je.status = 'posted'` de `src/api/graphql/resolvers/index.ts:136` y de las **cuatro** apariciones en `src/api/rest/routes/reports.ts` (`:185`, `:196`, `:207`, `:219`). Resultado: **2 440 pruebas verdes.**

La causa está medida: `src/api/rest/routes/reports.ts` tiene **0 % de cobertura en las dos suites** (310 líneas), y `src/api/graphql/resolvers/index.ts` también (393 líneas).

**Escenario de fallo:** un borrador de 500 000 MXN que un usuario dejó a medias entra en el estado de flujo de efectivo del REST y en la balanza del GraphQL. Es exactamente el defecto que `report-service.spec.ts:51` llama «el defecto que nunca debe volver» — y lo vigila sólo en `report-service`, no en las cuatro copias que el propio plan denuncia.

### 5 · [NUEVA] · ALTA · La conciliación bancaria: el motor de casamiento no tiene una sola prueba de conducta

`src/services/banking/matching.ts` (411 líneas) es tocado por **una** prueba, `tests/integration/frontera-caminos.int.spec.ts:174-200`, y esa prueba comprueba alcance por entidad, no aritmética: «findBestMatch tampoco propone candidatos del catálogo ajeno». Los umbrales del casamiento no los mira nadie.

**Mutación verificada** (ambas a la vez): la ventana de fecha de la regla 2 en `matching.ts:138` de ±3 días a ±3 años, y la tolerancia de importe de la regla 3 en `matching.ts:164` de 5 % a 500 %. Resultado: **2 440 pruebas verdes.**

**Escenario de fallo:** `autoMatch` liga un cargo bancario con una factura del año pasado de importe cinco veces mayor, marca `is_matched = true` y escribe `confidence_score` (`matching.ts:391`). Como `/reconciliations/:id/complete` está retirado (ver «lo que resiste» n.º 8), el daño no llega al mayor hoy — pero el día que la aritmética de conciliación se construya sobre este motor, se construirá sobre 411 líneas sin una sola aserción de conducta.

### 6 · [NUEVA] · MEDIA · El instrumento de cobertura ve el 8,6 % del árbol y jamás mira la suite de integración

`vitest.config.ts:16` restringe la medición a `['src/services/accounting/**', 'src/utils/sequence.ts']`: **5 849 de 68 446 líneas de `src/`**, el 8,6 %. Y `vitest.integration.config.ts` no declara bloque `coverage` en absoluto, así que las 255 pruebas que tocan Postgres —las que prueban el dinero— **nunca se miden**. El propio comentario de `vitest.config.ts:27-30` lo admite («`period-close.ts` mide 8 % y el número es engañoso: sus pruebas son de INTEGRACIÓN y esta corrida las excluye») y lo trata como una excusa para no ponerle umbral, en vez de como el defecto del instrumento que es.

Corrí la medición que falta:

| | Unitaria | Integración |
|---|---|---|
| Líneas | 64,09 % (43 559/67 963) | 32,71 % (22 231/67 963) |
| Ramas | 81,84 % | 58,91 % |
| Funciones | 68,04 % | 34,63 % |

Cruzando las dos, **19 archivos de ≥100 líneas quedan por debajo del 15 % en AMBAS**, entre ellos: `services/assets/depreciation.ts` (380, 0 %), `api/graphql/schemas/schema.ts` (525, 0 %), `api/rest/routes/invoices.ts` (341, 0 %), `api/rest/routes/reports.ts` (310, 0 %), `database/seed.ts` (214, 0 %), `services/payroll/mx/imss-calculator.ts` (148, 0 %), `services/payroll/usa/state/state-tax-calculator.ts` (138, 0 %), `services/payroll/usa/nacha-generator.ts` (210, 12,4 % — es el generador del archivo ACH que mueve dinero de verdad al banco) y `services/payroll/common/gl-posting-service.ts` (185, 11,3 % — es quien lleva la nómina al mayor).

**Escenario de fallo:** el equipo cree que «la cobertura tiene trinquete» y el trinquete cubre cuatro archivos de dieciséis de un directorio de doscientos sesenta y siete. Nadie sabrá nunca si una regresión bajó la cobertura de la nómina o de los reportes, porque no hay número que baje.

### 7 · [NUEVA] · MEDIA · El criterio que vigila la cobertura cuenta LLAVES, no números: se desarma sin ponerse rojo

`src/plan/criterios.ts:351-358`:

```ts
const archivos = (c.match(/'src\/[^']+\.ts':/g) ?? []).length;
return archivos >= 3 ? ok(...) : falla(...);
```

Nunca lee el VALOR de un umbral, nunca mira el `include`, nunca corre cobertura.

**Mutación verificada:** puse los cuatro umbrales de `vitest.config.ts:37-48` en `statements: 0, branches: 0, functions: 0, lines: 0`. `npm run plan:status` siguió dando **E0.1 12/13**, con el único rojo siendo el criterio que necesita Postgres — el de cobertura, verde. Y `npx vitest run --coverage` pasó igual, porque un umbral de 0 no falla nunca.

**Escenario de fallo:** un commit baja los umbrales «temporalmente» para desbloquear un merge. Ni la suite ni el tablero lo notan. El trinquete anunciado en `ci.yml:57-58` («no exige trabajo nuevo, impide la regresión») deja de impedir cualquier cosa, en silencio.

### 8 · [NUEVA] · MEDIA · Cero pruebas de propiedad o de invariante: todo es por ejemplo

Cero usos de `fast-check` (no está en `package.json`), cero generadores, 16 `it.each` y 3 bucles `for` en las 170 specs. No existe una sola prueba de la forma «para toda entidad, al final de la corrida, Σ cargos posteados = Σ abonos posteados» ni «para toda cuenta-periodo, `account_balances` = Σ de sus líneas». Lo más cerca es `tests/integration/iva-puertas.int.spec.ts:164-172`, que comprueba que ningún asiento de gasto quede descuadrado — pero sobre los tres casos que esa prueba misma sembró, no sobre el mayor completo.

**Escenario de fallo:** cualquier camino de escritura nuevo que no pase por `postJournalEntry` (una migración con DML, un `backfill`, el futuro `runMonthlyDepreciation`) puede dejar el mayor descuadrado y la suite no tiene ningún guardián global que lo vea. El barrido existe como comando (`ledger check`), pero ninguna prueba lo corre sobre el estado que dejaron las otras 254.

### 9 · [II-SIGUE-VIVA] · MEDIA · `tests/plan/` no verifica ni un solo criterio por mutación del código que ese criterio vigila

La II dijo «`tests/plan/` no contiene un solo mutante». Verificado en sustancia: `tests/plan/criterios.spec.ts` (103 líneas) prueba tres funciones auxiliares (`sinComentarios`, `fuentes`, `consumidoresDe`) y, en `:96-101`, **ejecuta los 70 criterios pero sólo afirma que su `detalle` tiene más de 10 caracteres** — ignora el veredicto de cada uno. Un criterio que se volviera verde por error pasaría esa prueba con nota.

Mi mutación del hallazgo 7 es la demostración directa: desarmé lo que un criterio vigila y el criterio siguió verde, sin que ninguna prueba de `tests/plan/` lo detectara.

**Escenario de fallo:** el gobierno entero del proyecto descansa en 70 criterios de los cuales **69 son regex sobre el fuente** (sólo uno declara `necesita: 'base-de-datos'`, en `criterios.ts:375`). Un refactor que renombre un símbolo o mueva una cadena apaga un criterio o lo enciende en falso, y nada lo dice.

### 10 · [II-SIGUE-VIVA] · ALTA · `ledger check --check balance` sigue ciego a `ending_balance` — y las dos pruebas que lo «cazan» están construidas para no poder revelarlo

La II lo afirmó; lo verifiqué y además encontré **por qué las pruebas no lo veían**.

El SQL de `src/services/accounting/ledger-checks.ts:73-74` compara sólo `debit_total` y `credit_total` contra la suma de líneas. Nunca menciona `ending_balance` ni `beginning_balance` — las dos columnas que **`carryForwardBalances` escribe en el cierre duro** (`src/services/accounting/period-close.ts:378`) y las que propagan el saldo entre ejercicios. `doctor` tiene el mismo punto ciego: `src/ai/doctor-service.ts:791` sólo mira `debit_total`.

Las dos pruebas que parecen cubrirlo mueven siempre `debit_total`. `tests/integration/f01-catalogo-asiento-mayor.int.spec.ts:165-168` mueve `debit_total` **y** `ending_balance` juntos — parece cobertura de las dos columnas, pero como se mueven a la vez la prueba no puede distinguir cuál mira el chequeo. `mayor-inviolable.int.spec.ts:138` mueve sólo `debit_total`.

**Mutación verificada (dirección contraria):** cambié la siembra de `f01...:165-168` para inyectar 99 999 **únicamente** en `ending_balance`. `runLedgerChecks(entityId, ['balance'], { account: '6100' })` devolvió **cero hallazgos** — `AssertionError: expected 0 to be greater than 0`. La deriva de casi cien mil pesos en la columna del arrastre es invisible.

**Escenario de fallo:** un cierre duro escribe mal el `ending_balance` de una cuenta de balance. El periodo siguiente hereda un `beginning_balance` falso (`period-close.int.spec.ts:78-83` compara uno contra otro, así que ambos mienten coherentemente y la prueba pasa). `ledger check` sale limpio, `doctor` sale `ok`, y el ejercicio arranca con un saldo inventado.

### 11 · [II-EXAGERADA] · «`tests/plan/` no contiene un solo mutante»

Es cierto para los criterios y falso para el runner. `tests/plan/status.spec.ts` (248 líneas, 24 pruebas) **sí inyecta mutantes sintéticos** y verifica ambas direcciones: `:36` un criterio no-evaluable impide declarar resuelto; `:46` un rojo entre nueve verdes abre el paquete; `:130` `--exigir` rompe ante un paquete abierto; `:138` el filtro no puede blanquear lo exigido; `:146` un paquete exigido inexistente rompe en vez de pasar en silencio. La fábrica de criterios falsos está en `:30-33`.

Lo correcto es decir: **el agregador tiene mutantes; los 70 criterios no tienen ninguno**. La frase de la II, tal cual, subestima trabajo hecho y por eso pierde precisión sobre lo que falta.

### 12 · [II-EXAGERADA] · «El único criterio con base de datos devuelve verde por no mirar»

Medio cierto, y la mitad falsa importa. Sin Postgres, el criterio de `criterios.ts:375` **no devuelve verde**: `criterios.ts:435-437` devuelve `noEvaluable('no hay base de datos accesible para medirlo')`, y `estadoDe` lo cuenta como abierto — verificado corriendo `npm run plan:status` sin `DATABASE_URL` válida: **E0.1 sale ámbar 12/13**, no verde. Lo que sí sostiene la crítica es la otra mitad: **con una base vacía sí sale verde** (cero sellos, nada que contradiga la afirmación), y su propio comentario en `criterios.ts:51-54` lo asume a conciencia. La forma correcta del reproche es «un verde sobre cero filas no es evidencia», no «devuelve verde por no mirar»: hoy sabe decir que no sabe.

---

## RECOMENDACIONES

Ordenadas por lo que compra cada una.

**R1 · Catálogo de mutantes ejecutable — `npm run mutantes` · Tamaño M · Tramo E0.1**
La regla (c) de la casa exige verificación por mutación y hoy nadie la ejecuta. Un `scripts/mutantes.ts` con una tabla declarativa `{ archivo, buscar, reemplazar, suite, pruebasQueDebenCaer }`, que aplique cada mutante, corra la suite acotada, restaure y falle si alguno SOBREVIVE. Se siembra con los seis que sobrevivieron hoy — signo de `report-service.ts:307`, `tenant_isolation_child`, `depreciation.ts:38`, `status='posted'` en `resolvers/index.ts:136` y `routes/reports.ts:207`, ventana y tolerancia de `matching.ts:138/164` — más los dos que sí matan (`ledger-checks.ts:73`, para probar el instrumento en las dos direcciones). Nacen seis rojos honestos el primer día.

**Criterio propuesto (E0.1, `necesita: 'base-de-datos'`):** *«Todo mutante del catálogo mata al menos una prueba»* — `evaluar` corre `scripts/mutantes.ts --check` y falla nombrando los supervivientes. Es conducta pura: no hay regex que lo pueda fingir, y él mismo se verifica al primer intento de simularlo.

**R2 · Los estados financieros, contra Postgres · Tamaño M · Tramo E4.2**
`tests/integration/estados-financieros.int.spec.ts`: sembrar en un inquilino desechable tres asientos posteados y un borrador; comprobar que (a) `getTrialBalance` devuelve el signo correcto por tipo de cuenta y cuadra Σcargos = Σabonos; (b) el borrador NO aparece; (c) `getBalanceSheet` cumple activo = pasivo + capital; (d) `getIncomeStatement` sobre el mismo periodo da el resultado que el barrido del cierre lleva a 3200. Esto mata el mutante 1 y hace que el mutante 4 tenga a dónde caer si las copias se unifican.

**Criterio propuesto (E4.2):** *«La balanza de comprobación cuadra sobre datos reales, no sobre un fixture»* — `necesita: 'base-de-datos'`; siembra dos asientos y compara `queryTrialBalanceRows` contra la suma directa de `journal_entry_lines` con `status='posted'`. Detalle obligatorio: cuántas cuentas llegó a comparar (un verde sobre cero cuentas es el vicio del hallazgo 12).

**R3 · Cobertura de las dos suites, fusionada, con lista de módulos de dinero · Tamaño M · Tramo E0.1**
Añadir bloque `coverage` a `vitest.integration.config.ts`, fusionar los dos informes, y declarar en un archivo versionado la lista de MÓDULOS DE DINERO (`report-service`, `posting`, `period-close`, `iva-cash-basis`, `iva-ppd-reclass`, `ar-ap-posting`, `assets/depreciation`, `banking/matching`, `payroll/common/gl-posting-service`, `payroll/usa/nacha-generator`, `payroll/mx/imss-calculator`, `routes/reports`, `graphql/resolvers`). Fallar si alguno queda en 0 % de cobertura de UNIÓN. Hoy fallaría con seis.

**Criterio propuesto (E0.1) — reemplaza al de `criterios.ts:351-358`:** *«El trinquete de cobertura es un número, y alcanza a cada módulo de dinero»*. `evaluar` debe (a) leer los VALORES de los umbrales y fallar si alguno es 0; (b) comprobar que el `include` de `vitest.config.ts` cubre cada módulo de la lista de dinero; (c) comprobar que `vitest.integration.config.ts` declara `coverage`. Los tres son verificables por mutación: bajar un umbral a 0, sacar un módulo del `include`, borrar el bloque — cada uno pone el criterio en rojo.

**R4 · La RLS, probada donde el dinero vive · Tamaño M · Tramo E0.1**
Extender `tenant-isolation.int.spec.ts` en dos ejes: (a) recorrer las 70 tablas con `tenant_isolation` y las 19 hijas con `tenant_isolation_child`, sembrando una fila del inquilino B y comprobando que A ve CERO — un bucle sobre `pg_policy`, no una lista a mano, para que una tabla nueva entre sola; (b) correr al menos un camino de SERVICIO completo (crear asiento → postear → leer balanza) bajo `SET LOCAL ROLE` de la sonda `NOBYPASSRLS`, para que alguna vez el código de aplicación se ejerza bajo las políticas que dice tener. Mata el mutante 2.

**Criterio propuesto (E0.1, `necesita: 'base-de-datos'`):** *«Ninguna política de aislamiento admite un predicado que no filtre»* — leer `pg_policy.polqual` de cada política y fallar si alguna es constante verdadera o menciona `true` sin comparar `app_current_tenant()`. Complementa, no sustituye, a la prueba de conducta.

**R5 · Depreciación: seis funciones puras, seis pruebas · Tamaño S · Tramo E1.4**
Es la deuda más barata del repo: `tests/services/assets/depreciation.spec.ts` con un caso por método comprobando que Σ del calendario = base depreciable, que el último periodo aterriza exactamente en el valor de rescate, y que `useful_life_months = 0` se rechaza en vez de dividir entre cero. Debe entrar **antes** de que E1.4 gane su llamador, no después.

**Criterio propuesto (E1.4):** el rojo actual («`runMonthlyDepreciation` no tiene llamador») debe partirse en dos, para que cerrar la puerta no apague la exigencia de prueba: *«La depreciación mensual tiene por dónde invocarse»* y *«Cada método de depreciación produce un calendario que suma la base depreciable»*.

**R6 · `ledger check`: mirar la columna del arrastre · Tamaño S · Tramo E4.2**
Añadir `ending_balance` y `beginning_balance` a la comparación de `ledger-checks.ts:73-74` y a `doctor-service.ts:791`, y —lo que importa para esta lente— **partir la siembra de `f01...:165-168` en dos pruebas**, una que mueva sólo `debit_total` y otra que mueva sólo `ending_balance`. Una prueba que mueve dos columnas a la vez no puede decir cuál se está vigilando; ése fue el mecanismo exacto por el que este agujero sobrevivió a dos auditorías.

**R7 · Una invariante global al cierre de la corrida · Tamaño S · Tramo E0.1**
Un `afterAll` global en la suite de integración que, sobre la base efímera antes de destruirla, afirme para TODA entidad: Σ`debit_amount` = Σ`credit_amount` sobre `status='posted'`, y `account_balances` = Σ de sus líneas. Cuesta una consulta y convierte las 255 pruebas en una fuente de datos para una invariante que hoy nadie afirma. Es lo más cerca de una prueba de propiedad que este proyecto puede tener sin introducir `fast-check`.

---

**Nota de método:** todas las mutaciones se aplicaron y revirtieron sobre `/private/tmp/.../d48ca5a0-...-aud`; `git status --porcelain` quedó sin cambios rastreados y las dos suites verdes al terminar. Lo que no pude comprobar y por tanto no afirmo: si estos mutantes sobreviven también en la CI de GitHub (no la corrí) y si el criterio con base de datos ha juzgado alguna vez algo distinto de cero sellos en una corrida real de CI — **no verificado**.
