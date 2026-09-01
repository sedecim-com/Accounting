# Titulares de la auditoría III y cómo tumbarlos

Un renglón por lente. El informe completo de cada una está en `<clave>.md`.

## `verificacion-ii` — Los titulares de la auditoria II, re-verificados

**TITULAR.** Los nueve hallazgos titulares de la auditoría II siguen los nueve vivos en `61379d0`: cero cerrados, porque desde `689458a` el árbol sólo se movió 101 líneas en 9 archivos (`git diff --stat 689458a cfe40c6`) y ninguna de ellas toca una sola de las nueve — lo único que cambió es que los tres documentos rectores ahora los describen (`docs/plan-catalogo.md:48`, Plan Maestro v3 §2/§4).

**CÓMO REFUTARLO (lo dice el propio lente).** Si el headline es falso, basta con exhibir un commit en `git log 689458a..61379d0` cuyo diff sobre `src/`, `scripts/` o `tests/` toque uno de estos nueve puntos: `src/plan/criterios.ts:243` (FLUJOS_CERRADOS), `.github/workflows/ci.yml:94` (la lista de --exigir), `src/ai/ingest-thresholds.ts:60-63` (la puerta del archivo), `src/database/migrate.ts:83-90` o cualquier migración con `set_config('app.current_tenant'…)` nueva, `src/services/accounting/ledger-checks.ts:57-76` (ending_balance), `src/services/integrations/mexico/pac/pac-router.ts:21-23` (el register de Sovos), `src/ai/docs/mexico-cfdi.md`, `scripts/costo-por-fila.ts:68` (CORRECTIVO_RE), o un `pg_dump`/`pg_restore` en cualquier parte del árbol. Yo corrí ese diff: los 9 archivos tocados son `.github/CODEOWNERS`, `scripts/eval-clasificador.ts`, `src/ai/docs/receivables.md`, `src/api/rest/routes/invoices.ts`, `src/api/rest/routes/public-verification.ts`, `src/services/cache/redis.ts` y tres specs. Ninguno está en la lista.

*Contabilidad del lente: 4 nuevas · 9 de la II siguen vivas · 0 cerradas.*

---

## `escala-y-rendimiento` — Escala, rendimiento y el dia que haya datos

**TITULAR.** La política RLS de las tablas hijas —`EXISTS (SELECT 1 FROM journal_entries p WHERE p.id = jel.journal_entry_id)` en `src/database/rls-policies.sql:176-180`— se evalúa una vez por línea de asiento (`loops=400000` en el plan real), y encarece la balanza 17× sobre 792 000 líneas: 46 ms como superusuario contra 782 ms como `mnemosine_app`; sustituirla por una comparación directa a `tenant_id`, probada en la misma base, la baja a 111 ms.

**CÓMO REFUTARLO (lo dice el propio lente).** Correr `EXPLAIN (ANALYZE)` del SQL literal de `src/services/reporting/report-service.ts:300-316` como `mnemosine_app` con `app.current_tenant` puesto, sobre una base con ≥400 000 filas en `journal_entry_lines` para una entidad. El headline es falso si (a) el plan NO muestra un SubPlan sobre `journal_entries` con `loops` igual al número de líneas examinadas —es decir, si el planificador aplana el EXISTS en semi-unión—, o (b) la razón entre el tiempo con `mnemosine_app` y con un rol `BYPASSRLS` sobre tabla vacuumada y analizada es menor que 3×, o (c) reemplazar la política hija por `USING (tenant_id = app_current_tenant())` con la columna rellenada no reduce el tiempo al menos a la mitad. Cualquiera de las tres lo tumba.

*Contabilidad del lente: 11 nuevas · 2 de la II siguen vivas · 1 cerradas.*

---

## `calidad-de-pruebas` — Que prueban de verdad las 170 suites

**TITULAR.** La balanza de comprobación y los otros cuatro estados financieros nunca se ejecutan contra Postgres: invertir el signo del saldo en src/services/reporting/report-service.ts:307 sobrevive las 2 440 pruebas de las dos suites, porque su única prueba mockea la consulta y recomputa la resta en su propio fixture (tests/services/reporting/report-service.spec.ts:3 y :43).

**CÓMO REFUTARLO (lo dice el propio lente).** Aplicar la mutación (cambiar `debit_amount, 0) - COALESCE(jel.credit_amount` por el orden inverso en report-service.ts:307) y correr `npx vitest run --config vitest.config.ts` y `npm run test:integration`: si alguna prueba se pone roja, el headline es falso. Segunda comprobación independiente: `grep -rn "reporting/report-service" tests/integration` — si devuelve una sola línea, existe una prueba del estado financiero contra Postgres y el headline es falso. Hoy la primera da 2 185 + 255 verdes y la segunda no devuelve nada.

*Contabilidad del lente: 8 nuevas · 2 de la II siguen vivas · 0 cerradas.*

---

## `aritmetica-del-cierre` — La aritmetica del cierre y del ejercicio

**TITULAR.** El estado de resultados de un ejercicio ya cerrado sale en CEROS y el de diciembre con ingresos negativos, porque ningún reporte excluye el asiento de cierre — que se fecha dentro del rango que el propio reporte consulta (src/services/reporting/report-service.ts:588 y src/services/accounting/period-close.ts:312).

**CÓMO REFUTARLO (lo dice el propio lente).** Correr contra una base con datos: postear ventas 100.000 (4100) y sueldos 50.000 (6110) en 2026, hard-close de diciembre, y luego `mnemosine report income-statement show --since 2026-01-01 --until 2026-12-31`. Si imprime Net income 50.000 el headline es falso; si imprime 0,0000 es cierto. La comprobación estática equivalente: si aparece un filtro `entry_type <> 'closing'` (o equivalente) en el SQL de queryIncomeStatementRows (report-service.ts:579-596), el headline es falso — hoy el censo de `entry_type` en toda la capa de reportes da tres apariciones y ninguna es ese filtro.

*Contabilidad del lente: 12 nuevas · 2 de la II siguen vivas · 0 cerradas.*

---

## `control-interno` — Control interno: lo que un auditor externo exigiria

**TITULAR.** La regla de la casa «el humano dispone» descansa sobre una identidad que nadie autentica: `-u, --user <email>` se documenta como «acting user, for attribution **and permissions**» (src/cli/kernel/flags.ts:76), ninguna ruta de la terminal llama jamás a `requirePermission`, y `resolveReviewer` sólo comprueba que el correo exista y esté activo (src/ai/draft-service.ts:290-301) — así que `entry post <n> --user otro@despacho.mx` derrota el maker-checker de F01 (src/services/accounting/posting.ts:317) sin tocar ninguna política.

**CÓMO REFUTARLO (lo dice el propio lente).** Si existiera UNA sola llamada a `requirePermission`, `hasPermission` o `permissionsOf` fuera de `src/api/rest/`, o si `resolveReviewer` exigiera cualquier prueba (contraseña, token, sesión) además del correo, el headline cae. La comprobación que lo tumbaría: `grep -rn "requirePermission\|hasPermission\|permissionsOf" src/cli/ src/ai/` devolviendo algo (hoy devuelve cero), o `bcrypt.compare|verify|jwt` dentro de `resolveReviewer`. Segundo flanco: si `entry post` NO declarara `--user`, el ataque exigiría base de datos; pero `withContext(post)` (src/cli/entry-command.ts:764) lo declara vía flags.ts:72-77 y la acción lo lee en :803.

*Contabilidad del lente: 12 nuevas · 4 de la II siguen vivas · 1 cerradas.*

---

## `normas-de-informacion` — NIF e IFRS, mas alla del fisco

**TITULAR.** Los sueldos brutos de toda nómina mexicana se cargan a «Devoluciones y Descuentos sobre Compras» —cuenta de naturaleza ACREEDORA y categoría `cogs`— porque los dos sembradores de catálogo chocan en cinco códigos y el de roles CFDI corre primero (`src/services/accounting/entity-accounting.ts:67` antes de `:77`; `src/services/xml-ingestion/account-roles-seed.ts:126` gana el 5200 sobre `src/services/payroll/common/payroll-account-mapping-seed.ts:43`, que el mapeo `wages_expense: '5200'` de `:77` sigue apuntando).

**CÓMO REFUTARLO (lo dice el propio lente).** Crear una entidad MX por cualquier ruta de alta (`ensureEntityAccounting`) y consultar `SELECT a.code, a.name, a.normal_balance, a.fs_category FROM payroll_account_mapping m JOIN accounts a ON a.id = m.account_id WHERE m.entity_id = $1 AND m.bucket = 'wages_expense'`. Si devuelve `5200 · Sueldos y Salarios · debit · operating_expenses`, el hallazgo es FALSO. Si devuelve `5200 · Devoluciones y Descuentos sobre Compras · credit · cogs`, es cierto. Lo mismo con los buckets `imss_payable` (¿2150 = «IMSS por Pagar» o «Anticipos de Clientes»?), `infonavit_payable`, `garnishment_payable` y `benefits_payable`.

*Contabilidad del lente: 12 nuevas · 2 de la II siguen vivas · 0 cerradas.*

---

## `contexto-del-agente` — Ingenieria de contexto: que lee y que sabe el agente

**TITULAR.** El tope de 32 000 caracteres que la auditoría II celebró como fortaleza le entrega al agente sólo el 20 % de `cli-reference.md` — trece de las catorce familias contables (entry, invoice, payment, account, period, report…) quedan del otro lado del corte, que es exactamente el defecto que `tests/ai/cli-reference.spec.ts` se escribió para impedir (src/ai/tools/index.ts:26 · src/ai/tools/docs-tools.ts:51-53 · verificado ejecutando `read_docs{topic:'cli-reference'}`: 32 109 caracteres entregados de 163 501).

**CÓMO REFUTARLO (lo dice el propio lente).** Construir las herramientas con `buildTools(ctx, {})` y ejecutar `read_docs({topic:'cli-reference'})`. Si la cadena devuelta contiene `mnemosine entry post` —o si mide más de 32 109 caracteres, o si no termina en el marcador `[... result truncated at 32000 chars …]`— el hallazgo es falso. Lo corrí: devuelve 32 109 caracteres, termina en el marcador, y de las 14 familias que el spec enumera sólo `entity list` aparece (por una mención suelta en la ayuda raíz, no por su sección).

*Contabilidad del lente: 8 nuevas · 3 de la II siguen vivas · 0 cerradas.*

---

## `operacion-y-fallos` — Operacion: observabilidad, fallos y el dia malo

**TITULAR.** El canal de webhooks de entrada graba y nunca procesa: `src/index.ts:168` monta el router sin `runReaderTurn` (`src/api/rest/routes/ai-webhooks.ts:143`) y ese tipo no tiene un solo productor en el árbol, así que toda entrega queda en `'received'` — y como `recordDelivery` ya quemó la clave `UNIQUE(token_id, document_key)` (`src/ai/webhooks/intake.ts:240`), cada reintento del emisor recibe `duplicate` (`ai-webhooks.ts:105-107`) antes de llegar a procesarse, volviendo inalcanzable la reanudación que los comentarios de `reader-agent.ts:240` y `ai-webhooks.ts:120` prometen.

**CÓMO REFUTARLO (lo dice el propio lente).** El hallazgo cae si aparece cualquiera de estas dos cosas: (a) un productor de `RunReaderTurn` en el árbol — `grep -rn "runReaderTurn" src/` debe dar EXACTAMENTE tres resultados, los tres dentro de `src/api/rest/routes/ai-webhooks.ts` (:42, :110, :118); un cuarto resultado que construya la función y la pase a `createAiWebhooksRouter` lo refuta; o (b) cualquier consulta que reprocese lo recibido — `grep -rn "'received'" src/` no debe mostrar ningún SELECT sobre `ai_webhook_deliveries` filtrando por ese estado fuera de `intake.ts`/`reader-agent.ts`, ni ningún verbo en `src/cli/webhooks-command.ts` más allá de `create|list|disable|deliveries` (:56, :91, :129, :153).

*Contabilidad del lente: 14 nuevas · 7 de la II siguen vivas · 0 cerradas.*

---

## `superficies-no-cli` — La API REST y las superficies que no son el CLI

**TITULAR.** La API tiene un camino al mayor que el CLI se prohibió a sí mismo por escrito: `POST /v1/journal-entries {"auto_post":true}` crea y postea en un solo acto sin consultar la política `segregacion_de_funciones` — el candado maker-checker vive sólo en `postJournalEntry` (src/services/accounting/posting.ts:317-333) y la rama de auto-posteo (src/services/accounting/posting.ts:174-231) no lo llama, mientras src/cli/entry-command.ts:68-73 declara que ese `auto_post` «deliberadamente no se expone».

**CÓMO REFUTARLO (lo dice el propio lente).** Basta encontrar UNA llamada a `getPolicy(..., 'segregacion_de_funciones')` dentro de `createJournalEntry` o en la ruta `POST /v1/journal-entries`. Comprobación concreta: con la política en `exigir`, un usuario `contador` (rol con `journal_entries:create` y `:post`) crea un borrador y corre `entry post` → debe salir `SOD_QUIEN_CREA_NO_POSTEA`; el mismo usuario manda `POST /v1/journal-entries` con `auto_post:true` sobre el mismo cuerpo → si la respuesta es 201 con `status:'posted'`, el hallazgo está confirmado; si sale 422 con ese mismo código, el hallazgo es falso. `grep -rn "segregacion_de_funciones" src --include="*.ts"` devuelve hoy una sola llamada en código de ejecución: posting.ts:320.

*Contabilidad del lente: 14 nuevas · 2 de la II siguen vivas · 2 cerradas.*

---

## `suministro-y-build` — Dependencias, build y las puertas de calidad

**TITULAR.** El trinquete de cobertura vigila 3 de los 16 archivos del motor contable y es estructuralmente ciego a los que sólo tienen prueba de integración — `vitest.config.ts:8` excluye `tests/integration/**` y `vitest.integration.config.ts:5-15` no declara cobertura alguna, así que `iva-ppd-reclass.ts` (0 %), `account-roles-backfill.ts` (0 %), `period-close.ts` (6,77 %) y `ledger-checks.ts` (33,17 %) no pueden mover la puerta en ninguna de las dos suites.

**CÓMO REFUTARLO (lo dice el propio lente).** Se cae si alguna de estas tres es cierta: (1) `vitest.integration.config.ts` declara un bloque `coverage` con umbrales — no lo tiene, el archivo entero son 15 líneas; (2) los cuatro módulos citados aparecen en `thresholds` de `vitest.config.ts:36-49` — sólo están posting.ts, validation.ts, ar-ap-posting.ts y utils/sequence.ts; (3) borrar el cuerpo de `iva-ppd-reclass.ts` pone en rojo el job `unit` — no puede, porque su porcentaje ya es 0 y no hay umbral que violar. La comprobación que la tumbaría: correr `npx vitest run --coverage` tras mutar esos archivos y ver salir `exit=1`.

*Contabilidad del lente: 12 nuevas · 4 de la II siguen vivas · 0 cerradas.*

---

## `planes-vs-realidad` — Los tres documentos contra el arbol de hoy

**TITULAR.** §1 del Plan Maestro jura que ninguna de sus cifras se escribe a mano y que «gana el medidor», pero publica «390 líneas por fila — 200 entrega + 190 garantía» cuando `npm run costo:por-fila` imprime 423 líneas/fila como lectura viva y no publica ningún desglose entrega/garantía (scripts/costo-por-fila.ts, salida verificada; el 390 sólo aparece ahí rotulado «Referencia fundacional… medida una vez sobre 50 filas», y el 200/190 sale a mano de docs/plan-catalogo.md:20-22).

**CÓMO REFUTARLO (lo dice el propio lente).** Correr `npm run costo:por-fila` en el árbol auditado. Si su renglón «Agregado desde S0.1» dice 390 líneas/fila (y no 423), o si imprime en algún lado un desglose entrega/garantía, el hallazgo muere. También muere si se acredita que §1 declaró una convención —«cito la referencia fundacional, no el agregado»—: no la declara; dice literalmente «se copian de la última corrida de los medidores, y si el documento y el medidor discrepan, gana el medidor».

*Contabilidad del lente: 7 nuevas · 7 de la II siguen vivas · 3 cerradas.*

---
