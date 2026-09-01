# Disposición renglón por renglón del plan de cierre

**Qué es.** El registro de herencia a nivel tarea que la regla de gobierno del Plan Maestro
exige («La herencia es a nivel tarea, no prosa» — §7): cada una de las 147 tareas del plan de
cierre con su destino individual, registrado una vez. Las cuatro obligaciones que cayeron de la
herencia anterior (presupuesto de IA, segregación de funciones, arranque fail-closed, los
huecos confesados de E5.1) son el costo de no haber tenido este documento antes.

**Cuándo y contra qué.** Generado en S1 (ítem 12) · 2026-08-31 · HEAD de referencia
`abb7f60` («Auditoría integral: siete lentes»), con los ítems 1–11 de S1 ya aplicados en el
árbol de trabajo sin commit (migración 040, criterio E3.2 en rojo honesto, `rls-guard.ts`,
redacción de la bitácora, HS256, backstop de importes, fecha de corte de precios,
`costo-por-fila.ts`). El tablero citado abajo es el de ese árbol: **8/15 paquetes en verde**;
rojos vivos en E1.2, E1.3, E1.4, E3.2, E4.1, E4.2 y E5.1.

**Fuentes.** El plan de cierre (147 tareas en 15 paquetes: E0.0:3 · E0.1:12 · E0.2:12 ·
E0.3:10 · E1.1:8 · E1.2:10 · E1.3:8 · E1.4:11 · E2.1:10 · E2.2:7 · E3.1:9 · E3.2:11 ·
E4.1:13 · E4.2:12 · E5.1:11), el censo previo ([cierre-cobertura](cierre-cobertura.md)), los
otros seis informes de este directorio, `npm run plan:status`, `git log` y verificación
puntual contra el código en los casos dudosos. Lo que un criterio verde o un informe ya
clasificó se hereda citándolo; lo demás se verificó a mano.

**Vocabulario.**

| Disposición | Significado |
|---|---|
| HECHA | Ejecutada y con evidencia (commit, criterio verde o archivo verificable) |
| ABSORBIDA | La carga un tramo del Plan Maestro v2 (S1, R1–R4, A1–A6, F01–F12, §5) |
| PENDIENTE | Un rojo del tablero la nombra; el rojo es su registro |
| PENDIENTE† | Sin rojo ni dueño en la v2: **este documento es su única constancia** |
| CAÍDA→RESCATADA | Cayó de la herencia a nivel prosa; la auditoría integral la rescató |
| RETIRADA | Abandonada por decisión escrita (ninguna tarea terminó aquí; ver resumen) |

---

## E0.0 · Control de versiones y CI (3 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E0.0-a | Inicializar el repositorio y su primer commit | HECHA | Repo en `github.com/sedecim-com/Accounting`; CI verde desde `f57c14f` |
| E0.0-b | Un único `.github/workflows/ci.yml` con jobs nombrados | HECHA | El archivo existe; criterio «un solo archivo de CI y sus cuatro jobs» verde |
| E0.0-c | Repartir números de migración y bloquear choques | HECHA | `docs/migraciones.md` + guarda `assertNumeracionUnica` en `migrate.ts` |

## E0.1 · Red de seguridad del motor contable (12 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E0.1-a | Arnés de pg falso y separación unitario/integración | HECHA | `vitest.config.ts` (censo verificó); criterio «proyectos separados» verde |
| E0.1-b | Unitarias de createJournalEntry | HECHA | Tablero ✅ E0.1 (5/5); suites 2 063+211 en verde |
| E0.1-c | Unitarias de postJournalEntry y sus candados | HECHA | Tablero ✅ E0.1 |
| E0.1-d | Unitarias de reversa y anulación | HECHA | Tablero ✅ E0.1 |
| E0.1-e | Pruebas de lineAmountRule y periodStatusRule | HECHA | Tablero ✅ E0.1 |
| E0.1-f | Unitarias de sequence.ts | HECHA | Tablero ✅ E0.1 |
| E0.1-g | Unitarias de period-close: checklist y candados | HECHA | Tablero ✅ E0.1 |
| E0.1-h | Infraestructura de integración con base efímera | HECHA | Criterio «base efímera, no la de desarrollo» verde |
| E0.1-i | Portar e2e-reversal a integración | HECHA | `scripts/e2e-reversal.ts` ya no existe (censo verificó) |
| E0.1-j | Portar e2e-arap a integración | HECHA | `scripts/e2e-arap.ts` ya no existe; `tests/integration/ar-ap.int.spec.ts` |
| E0.1-k | Integración de cierre, arrastre y concurrencia | HECHA | Tablero ✅ E0.1 |
| E0.1-l | Flujo de CI completo con Postgres de servicio | HECHA | `ci.yml`; commit `f57c14f` («la CI vuelve a verde») |

## E0.2 · Contrato código–esquema (12 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E0.2-a | Extractor de literales SQL con archivo y línea | HECHA | Tablero ✅ E0.2 (6/6); migración `032_schema_contract.sql` |
| E0.2-b | Normalizador con salida «no verificable» | HECHA | Tablero ✅ E0.2 |
| E0.2-c | Verificador por PREPARE contra Postgres efímero | HECHA | Tablero ✅ E0.2 |
| E0.2-d | Chequeos estáticos que PREPARE no da | HECHA | Criterio «columnas calificadas por alias» verde |
| E0.2-e | Reparar las siete consultas contra `entities` | HECHA | Criterio «ninguna consulta nombra entities» verde; censo verificó grep |
| E0.2-f | Alinear garnishment-engine con la tabla real | HECHA | Tablero ✅ E0.2 (el *escritor* de garnishments sigue en el rojo E4.1) |
| E0.2-g | Alinear benefits-service con sus tablas | HECHA | Tablero ✅ E0.2 |
| E0.2-h | tax_form_filings: acuse y estado 'submitted' | HECHA | Tablero ✅ E0.2 |
| E0.2-i | Forma 940: columna `futa` | HECHA | Tablero ✅ E0.2 |
| E0.2-j | Seis vocabularios Zod alineados con el CHECK | HECHA | Criterio «ningún vocabulario admite lo que el CHECK rechaza» verde |
| E0.2-k | Política de numeración de migraciones | HECHA | `docs/migraciones.md`; test `migration-numbering.spec.ts` |
| E0.2-l | CI con Postgres: migraciones, contrato y suite | HECHA | `ci.yml`; tablero ✅ E0.2 |

## E0.3 · Bitácora inmutable (10 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E0.3-a | Contexto de actor por AsyncLocalStorage | HECHA | Tablero ✅ E0.3 (3/3) |
| E0.3-b | Migración de la bitácora, append-only real | HECHA | `033_audit_log_append_only.sql`; criterio «UPDATE y DELETE fallan» verde |
| E0.3-c | Emisor único recordAudit en la transacción | HECHA | Criterio «rastro en la misma transacción» verde |
| E0.3-d | Auditar el mayor desde posting.ts | HECHA | Tablero ✅ E0.3 (R1 extiende a invoice/bill/payment) |
| E0.3-e | Auditar hard close; soft close sin INSERT crudo | HECHA | Tablero ✅ E0.3 |
| E0.3-f | Auditar aprobaciones y operaciones externas | HECHA | Tablero ✅ E0.3 |
| E0.3-g | Transporte: request-id, UUIDs, cuerpo | HECHA | Tablero ✅ E0.3; S1(3) añadió la redacción de sensibles (`audit.ts`) |
| E0.3-h | Credenciales fiscales: log especializado espejado | HECHA | `035_fiscal_credential_log_append_only.sql`; AUD-4 `a45a854` |
| E0.3-i | Superficie de lectura: `mnemosine audit` y GET /v1/audit | ABSORBIDA | Cola F09–F12: 8 filas `audit`/`auditor` (cli-command-catalog.md:2643-2674) |
| E0.3-j | E2E del rastro de una vida contable | HECHA | Suite de integración; tablero ✅ E0.3 |

## E1.1 · Siembra contable de entidades (8 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E1.1-a | Extraer el catálogo base a módulo reutilizable | HECHA | Tablero ✅ E1.1 (2/2); arreglo `db1525b` |
| E1.1-b | account-roles-seed inyectable y diagnosticable | HECHA | `src/services/accounting/` (entity-accounting); tablero ✅ E1.1 |
| E1.1-c | ensureEntityAccounting idempotente | HECHA | Criterio «toda ruta de alta siembra los roles» verde |
| E1.1-d | Cablear la siembra a `mnemosine init` | HECHA | Tablero ✅ E1.1 |
| E1.1-e | Diagnóstico en doctor y `accounts roles` | HECHA | Tablero ✅ E1.1 |
| E1.1-f | MISSING_ROLE_ACCOUNT deja de mentir | HECHA | `ar-ap-posting.ts:69-75` nombra rol y comando (censo verificó) |
| E1.1-g | Backfill de entidades ya desplegadas | HECHA | `tests/integration/account-roles-backfill.int.spec.ts`; `db1525b` |
| E1.1-h | E2E: entidad recién creada que postea | HECHA | Tablero ✅ E1.1 |

## E1.2 · Clasificador CFDI e IVA en flujo (10 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E1.2-a | El parser emite los complementos presupuestos | HECHA | ImpuestosDR en `cfdi-facts.ts`/`rep-linkage.ts`; IVA-5 cimiento `fb95c5d` |
| E1.2-b | Migración del rastro de clasificación | PENDIENTE | Rojo E1.2: `cfdi_classifications` (015) con cero escritores en src |
| E1.2-c | Orquestador: clasificar y persistir el rastro | PENDIENTE | El clasificador existe (`cfdi-classifier.ts`) pero no persiste — mismo rojo; F02 decide «escribirla o retirarla» |
| E1.2-d | postClassification: póliza determinista, reversa única | HECHA | `cfdi-posting-plan.ts` + `postClassification` en la ingesta |
| E1.2-e | Clasificador cableado en processXMLUpload | HECHA | `cfdi-decisions.ts` en `ingest-service.ts`; compuertas de S0.3 |
| E1.2-f | Cuatro veredictos: preguntas, cola, CLI/REST | HECHA | `ask_user` en ingesta/agente; flujo drafts/review del CLI |
| E1.2-g | El REP cierra el ciclo (1135/2125) | HECHA | IVA-5 sustituyó la especificación (que doblaba el IVA) y lo cerró: `4b3b79c`, `f2fd789`, `edb1468`; criterios PPD verdes |
| E1.2-h | Remediación del histórico PPD mal acreditado | ABSORBIDA | F02 (REP-2: reproceso de `needs_review`, checklist del IVA aparcado) |
| E1.2-i | Reescribir la documentación del agente | ABSORBIDA | F02 (flujo de ingesta; sin constancia de ejecución) |
| E1.2-j | Fixtures y E2E del ciclo PPD → REP | HECHA | `iva-cash-basis.spec.ts`, `ar-ap-posting-iva.spec.ts`; «diez pruebas en verde» (`edb1468`) |

## E1.3 · Panel de políticas con consumidores (8 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E1.3-a | Registro de consumidores de política, claves tipadas | HECHA | `policy/pending-catalog.ts`; el propio criterio E1.3 lo consume para contar lectores |
| E1.3-b | Puente de políticas y alcance por entidad | HECHA | S0.3 (`18c7adf`): el panel gobierna; 7 de 15 políticas con lector real |
| E1.3-c | Ingesta consume ingest_auto_post; autoApproveDraftByPolicy | ABSORBIDA | A3 (un solo autorizador): las políticas ya se leen (S0.3), `autoApproveDraftByPolicy` sigue huérfano |
| E1.3-d | El guardián de e.firma consume sus dos políticas | PENDIENTE | Rojo E1.3: `efirma_max_accesos_diarios`, `efirma_accion_anomalia` sin lector |
| E1.3-e | outbox intenta la política antes del humano | HECHA | `approvals-command.ts`: políticas graduadas con suelo `FLOOR_MAX_AUTO_POST` |
| E1.3-f | expectedHash en las rutas de aprobación | HECHA | `draft-service.ts`/`external-service.ts`; §2 del Plan Maestro lo lista como fortaleza |
| E1.3-g | Lo que el usuario ve al definir política/aprobación | HECHA | El panel se contesta desde el CLI (el rojo E1.3 confirma que contestar es posible; faltan lectores, no superficie) |
| E1.3-h | Puente al clasificador: umbral y respuestas implícitas | HECHA | Deducibilidad LISR gobernada por panel (§2 del Plan Maestro) |

## E1.4 · Activo fijo, blockchain honesta, retiros (11 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E1.4-a | Purgar valor y blinding factor del range proof | CAÍDA→RESCATADA | S1(2) — ya ejecutada en el árbol: `040_el_secreto_que_el_compromiso_revelaba.sql` + `crypto-service.ts`; criterio «el compromiso no persiste el valor» verde |
| E1.4-b | Atestación explícita, is_simulated, /public/v1 desmontado | HECHA | `6094f65`; `034_atestaciones_simuladas.sql` |
| E1.4-c | Sanear el router público (handlers, tenant_id) | HECHA | Desmontaje por omisión (`6094f65`, `b10b8f0`); el camino sancionado restante vive en R2 |
| E1.4-d | Alta de activo fijo desde la CLI | ABSORBIDA | F06 (DEP-2: alta del activo, ficha al capitalizar desde F02) |
| E1.4-e | Tres roles de cuenta para depreciación | HECHA | Roles en `entity-accounting.ts` |
| E1.4-f | Corregir runMonthlyDepreciation | ABSORBIDA | F06 (DEP-2): el motor existe (el rojo E1.4 lo confirma); sus correcciones se validan cuando la corrida sea invocable |
| E1.4-g | Puerta de entrada de la depreciación | PENDIENTE | Rojo E1.4: «runMonthlyDepreciation no tiene llamador: hay motor y no hay puerta» |
| E1.4-h | Cuarentena de inventarios | HECHA | Ejecutada como retiro con censo en S0.4 (`4e90539`) |
| E1.4-i | Retirar mexico/cfdi.ts rescatando catálogos | HECHA | `src/services/mexico/` ya no existe; catálogos en `sat-catalogs.ts` (censo verificó) |
| E1.4-j | Doctor: superficies simuladas o sin puerta | HECHA | Chequeo de capacidad huérfana en doctor + línea base S1(6) «sólo encoge»; simuladas marcadas por 034 |
| E1.4-k | E2E de depreciación contra base real | ABSORBIDA | F06 (con DEP-2) |

## E2.1 · Perímetro multi-tenant (10 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E2.1-a | runInTenant síncrono, middleware, fugas de enterWith | HECHA | Tablero ✅ E2.1 (3/3); criterio «contexto montado una sola vez» verde |
| E2.1-b | Perímetro en el arranque, buildApp() extraída | HECHA | `b369bc2` («la guarda mira todas las fuentes») |
| E2.1-c | Matar el atajo de ?entity_id= | HECHA | Serie TEN (`e17a957`: dos entidades en una petición se rechazan) |
| E2.1-d | assertResourceEntity() en rutas por :id | HECHA | Criterio «ninguna ruta acota por entidad no comprobada» verde; R2 lo extiende a customers/vendors/webhooks |
| E2.1-e | Conectar como mnemosine_app, arranque fail-closed | CAÍDA→RESCATADA | S1(4) — ya ejecutada en el árbol: `rls-guard.ts` + `src/index.ts` (antes: sólo `logger.warn`) |
| E2.1-f | Destino de /public/v1 bajo RLS | ABSORBIDA | R2 (camino sancionado SECURITY DEFINER); el desmontaje ya ocurrió (E1.4-b) |
| E2.1-g | GraphQL: permisos, entidad y poda | ABSORBIDA | §5 (GraphQL: retirar o blindar); criterio verde vigila que siga apagado |
| E2.1-h | Batería del perímetro, un test por vector | HECHA | Tablero ✅ E2.1; suite de integración contra RLS real |
| E2.1-i | verify-isolation.sh completo | HECHA | Job de CI que conecta como rol no privilegiado (criterio verde) |
| E2.1-j | Orden de despliegue y ventana de migración | HECHA | S0.2 (`79565b8`) reparó `migrate.ts`; falta `docs/despliegue-perimetro.md` — cabo registrado aquí |

## E2.2 · Catálogo único de autorización (7 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E2.2-a | Catálogo único en src/auth/roles.ts | HECHA | CLI-9 (`0d39433`: «E2.2 cierra de verdad») |
| E2.2-b | Tipar requirePermission, borrar catálogo muerto | HECHA | Tablero ✅ E2.2 (2/2) |
| E2.2-c | Censo exigidos vs concedidos, con test | HECHA | Tablero ✅ E2.2 |
| E2.2-d | Permisos derivados del catálogo; deriva en doctor | HECHA | Criterio «los permisos se declaran en un solo sitio» verde |
| E2.2-e | Segregación de funciones con invocación real | CAÍDA→RESCATADA | §5 (maker-checker): cablear como política del panel con F01, o diferir por escrito. `checkSoDViolations` sigue con cero llamadores |
| E2.2-f | Rama HS256 retirada; arranque que falla | HECHA | Criterio «no arranca con el secreto de desarrollo» verde; S1(10) fija HS256 (`auth.ts` en el árbol) |
| E2.2-g | Sección generada en identity-access.md con test | PENDIENTE† | Sin rojo ni dueño en la v2; el archivo no existe en docs/ (censo, brecha 6) |

## E3.1 · Timbrado real con PAC (9 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E3.1-a | Cerrojo de simulación en timbre y acuse | HECHA | Criterio «un adaptador simulado no produce timbre ni acuse» verde (`assertPuedeTimbrar` en pac-router) |
| E3.1-b | Custodia de credenciales extendida al CSD | HECHA | `fiscal-credentials/service.ts` maneja tipo `csd`; `sat cred add` (sat-commands.ts:118) |
| E3.1-c | Cadena original y sellado CFDI 4.0 con CSD | ABSORBIDA | §5 (contrato PAC — decisión de Victor); familias `pac` de la cola |
| E3.1-d | Armar el CFDI de ingreso (datos que el esquema no tiene) | ABSORBIDA | §5 PAC + F03 (el esquema de invoices sigue sin régimen/CP/uso/serie) |
| E3.1-e | Interfaz PAC e implementación SOAP | ABSORBIDA | §5: cuatro adaptadores en el árbol (Sovos completo sin registrar; SW Sapien recomendado primario) |
| E3.1-f | Timbrado idempotente, XML persistido, ruta REST | ABSORBIDA | §5 PAC (bloqueada por el contrato) |
| E3.1-g | Cancelación fiscal encadenada al void | ABSORBIDA | F03 (retirada con 501, motor neto nuevo); criterio «no finge cancelar» verde |
| E3.1-h | CFDI de nómina 1.2 utilizable | ABSORBIDA | F08 (registro patronal, gravado/exento nombrados ahí) |
| E3.1-i | Retirar simulador; degradar adaptadores sin transporte | ABSORBIDA | §5 (los esqueletos siguen en el árbol; el cerrojo ya impide que fabriquen folios) |

## E3.2 · Descarga masiva del SAT (11 tareas)

El paquete entero era el falso verde que el censo destapó; S1(1) lo puso en rojo honesto
(`⬜ E3.2 0/1`) y §5 corrigió su alcance: **11 tareas de motor (~7 semanas), no «cargar una
credencial»**. La credencial es de Victor; el motor es del plan.

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E3.2-a | Esquema: solicitudes, cupo, paquetes | PENDIENTE | Rojo E3.2 (S1); §5 e.firma es el dueño del alcance |
| E3.2-b | Firma XML-DSig y transporte SOAP | PENDIENTE | Rojo E3.2 («ni SOAP») |
| E3.2-c | Sesión SAT: una desencriptación, propósito sat_auth | PENDIENTE | Rojo E3.2; la bóveda y la bitácora ya existen (§5) |
| E3.2-d | Tres operaciones de descarga y mapa de códigos | PENDIENTE | Rojo E3.2 |
| E3.2-e | Lector de ZIP mínimo sin dependencia | PENDIENTE | Rojo E3.2 («ni ZIP») |
| E3.2-f | Orquestador: cupo, ciclo, 72 h, ingesta marcada | PENDIENTE | Rojo E3.2 |
| E3.2-g | Estatus real del CFDI (adiós 'Vigente' simulado) | ABSORBIDA | F02: estatus SAT real, SOAP público — la auditoría lo desbloqueó de E3.1/E3.2 |
| E3.2-h | Propagar estatus; activar cfdi_cancelado | ABSORBIDA | F02 (con el estatus real) |
| E3.2-i | Factura contabilizada que el emisor canceló: reversa | PENDIENTE | Rojo E3.2; §5 la nombra como riesgo fiscal directo |
| E3.2-j | CLI: sat download y sat verify | PENDIENTE | Rojo E3.2 («ni comando») |
| E3.2-k | Modo desatendido: dos tareas deterministas | PENDIENTE | Rojo E3.2; la superficie desatendida nombrada (S0.3) es el prerrequisito ya puesto |

## E4.1 · Banca y nómina (13 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E4.1-a | Migración: integridad de conciliación, columnas nómina | ABSORBIDA | F05 (motor de conciliación); las columnas de nómina ya las reparó E0.2 |
| E4.1-b | Alta y consulta de cuentas bancarias | ABSORBIDA | F05 (familia `bank`, 30 filas) |
| E4.1-c | Ligar match a sesión; línea conciliada una vez | ABSORBIDA | F05 («completar conciliación» retirada a propósito: motor neto nuevo) |
| E4.1-d | Comisiones e intereses al libro mayor | ABSORBIDA | F05 (los nombra: «el posteo que la conciliación destapa») |
| E4.1-e | La variancia que valida el cierre | HECHA | Criterio «una conciliación no se declara cuadrada sin postear su diferencia» verde |
| E4.1-f | E2E de banca contra base real | ABSORBIDA | F05 |
| E4.1-g | Sembrar payroll_account_mapping en init | HECHA | Criterio «el mapeo contable de nómina se siembra en el alta» verde |
| E4.1-h | Persistir paycheck_taxes y columnas del recibo | PENDIENTE | Rojo E4.1: «se leen y nadie las escribe»; F08 carga el motor |
| E4.1-i | Subsidio al empleo: entregar el remanente | PENDIENTE† | Sin rojo ni dueño: F08 no la nombra (censo, brecha 6); su decisión de régimen sigue abierta |
| E4.1-j | Posteo de la corrida al mayor, idempotente | ABSORBIDA | F08 («el motor que E4.1 daba por cerrado») |
| E4.1-k | Marcar depositado un pasivo fiscal (941/940) | PENDIENTE | Rojo E4.1: «los 941/940 reportan ceros» |
| E4.1-l | Asiento de dispersión al pagar la corrida | ABSORBIDA | F08 |
| E4.1-m | E2E de nómina al estilo e2e-arap | ABSORBIDA | F08 |

## E4.2 · Worker y capa de reportes (12 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E4.2-a | system_tasks/system_task_runs con reclamo atómico | ABSORBIDA | Cola F09–F12 (familia `job`, 7 filas); la decisión de runtime quedó resuelta: patrón Postgres |
| E4.2-b | Runtime del worker: manejadores, tick, CLI | ABSORBIDA | Cola F09–F12 (`jobs run-due` ya existe como base) |
| E4.2-c | Retirar el trigger de refresco del posteo | ABSORBIDA | R3 («lo ya decidido que faltaba ejecutar» — lo cita textual) |
| E4.2-d | Barredor webhook_retry_sweep | ABSORBIDA | Cola F09–F12 (familia webhook) + R2 (SSRF/firma/secreto) |
| E4.2-e | Persistir cuerpo entrante; drenar 'received' | ABSORBIDA | Cola F09–F12 + R2 |
| E4.2-f | Depreciación como tarea del worker | ABSORBIDA | F06 (DEP-2: corrida mensual invocable) |
| E4.2-g | Revalidación periódica del estatus CFDI | ABSORBIDA | F02 (estatus SAT real; su decisión de reversa, en §5 e.firma) |
| E4.2-h | Presupuesto y alerta sobre ai_usage | CAÍDA→RESCATADA | A3 (rescata E5.1-e; misma obligación); block por defecto en desatendido |
| E4.2-i | Semántica de account_balances comprobable | ABSORBIDA | R1 (doctor: `account_balances` = Σ líneas posteadas, con fail) |
| E4.2-j | Capa compartida de consulta de reportes | PENDIENTE | Rojo E4.2: 4 copias del SQL de saldos; prerrequisito de `report` en F09–F12 |
| E4.2-k | Recablear las cuatro superficies a la capa | PENDIENTE | Mismo rojo (external-service, graphql, reports, orchestrator) |
| E4.2-l | Test que impide divergir de nuevo | PENDIENTE | Mismo rojo (el test llega con la capa) |

## E5.1 · Madurez del agente (11 tareas)

| ID | Tarea | Disposición | Dónde |
|---|---|---|---|
| E5.1-a | Primitivas portables de rehidratación | HECHA | `compaction.ts`: `anthropicView`/`openAiView`/`planCompaction`; el failover las usa |
| E5.1-b | Rehidratar de verdad en --continue/--resume | CAÍDA→RESCATADA | S1(7) la registró como hueco; **sin implementar aún** (`--continue` sigue arrancando contexto fresco) |
| E5.1-c | Backstop determinista de importes | CAÍDA→RESCATADA | S1(7) — ya ejecutada en el árbol: `MONTO_RE` en `compaction.ts` (la mitad UUID/RFC/folio ya existía) |
| E5.1-d | Failover a mitad de sesión con historia compactada | HECHA | `onFailover` en `mnemosine.ts` (censo verificó) |
| E5.1-e | Presupuesto aplicado donde nace toda sesión | CAÍDA→RESCATADA | A3: `budget.ts` según la spec ya escrita; block (no warn) en desatendido; alcance entidad/tenant en §5 |
| E5.1-f | Fecha de corte auditada de la tabla de precios | CAÍDA→RESCATADA | S1(7) — ya ejecutada en el árbol: la fecha es dato en `prices.ts`, no comentario |
| E5.1-g | Unificar la raíz del árbol de skills | PENDIENTE† | Sin rojo ni dueño: `skillDirs(` sigue en `store.ts:198` (su propio criterio de cierre la da por abierta) |
| E5.1-h | Dos entradas a skill_drafts (stage + propose_skill) | PENDIENTE† | Sin rojo ni dueño: la revisión existe (`skill draft list`, catálogo:2877); las dos entradas de creación, no |
| E5.1-i | Registro maquinable del corpus NIF con índice | HECHA | `scripts/build-niif-indice.ts` |
| E5.1-j | cli-reference importable con test de sincronía | HECHA | `6a6b40c` («el agente vuelve a saber qué comandos existen») |
| E5.1-k | Coherencia interna del registro NIIF | HECHA | `tests/ai/niif-registry.spec.ts` |

---

## Resumen por disposición

| Disposición | Tareas |
|---|---|
| HECHA | **83** |
| ABSORBIDA | **34** |
| PENDIENTE (con rojo del tablero) | **18** |
| PENDIENTE† (sin rojo ni dueño — sólo este registro las carga) | **4** |
| CAÍDA→RESCATADA | **8** |
| RETIRADA | **0** |
| **Total** | **147** |

RETIRADA quedó vacía a propósito: las dos retiradas decididas del plan (inventarios E1.4-h,
`cfdi.ts` E1.4-i) eran tareas *de* retiro, y ejecutarlas las vuelve HECHA.

Las cuatro PENDIENTE† son el residuo que esta disposición existe para atrapar:
**E2.2-g** (gobierno documental del catálogo de roles), **E4.1-i** (subsidio al empleo:
entregar el remanente), **E5.1-g** (raíz única de skills) y **E5.1-h** (entradas de creación
de skill_drafts). Ninguna tiene criterio, fila ni tramo; quien planifique el siguiente tramo
debe darles dueño o retirarlas por escrito.

De las 8 rescatadas, 5 ya están ejecutadas en el árbol de S1 (E1.4-a, E2.1-e, E5.1-c,
E5.1-f y la parte de criterio de E4.2-h/E5.1-e vive en A3); E5.1-b sigue confesada y sin
implementar; E2.2-e espera la decisión escrita de §5.

---

## Las decisiones del plan de cierre, por sección

El plan de cierre tiene 15 secciones «Decisiones que alguien debe tomar» (una por paquete)
más la sección de sprint «Lo que necesita tu decisión»: **87 decisiones con encabezado
propio, de las cuales 52 están formuladas como pregunta «¿…?»** — 52 es la cifra que el censo
contó. Estados: **resuelta** (con evidencia) · **heredada** (a panel, §5, o tramo/flujo de la
v2) · **caducada** (el supuesto murió) · **sin dueño** (sólo este registro la carga).

### Sprint · «Lo que necesita tu decisión» (2)

1. Qué PAC se contrata, y sellar con CSD propio o delegar — **heredada a §5** (decisión de Victor; SW Sapien recomendado primario).
2. Cuál de los dos planes gobierna el alcance — **resuelta**: el Plan Maestro v2 es el único rector; plan de cierre y «Doce sprints» quedan como registro (pie del artefacto).

### E0.0 (1)

1. ¿Dónde se aloja el repositorio? — **resuelta**: `github.com/sedecim-com/Accounting`, CI en Actions (`f57c14f`).

### E0.1 (6)

1. ¿postJournalEntry atesta? — **resuelta**: sí (ATE-1, `1b8e40f`).
2. ¿Rol de la suite de integración? — **resuelta**: superusuario a propósito en local; el job de CI de aislamiento conecta como rol no privilegiado (criterio verde).
3. ¿Dónde vive la CI? — **resuelta**: GitHub Actions.
4. ¿Se eliminan los scripts e2e? — **resuelta**: eliminados al portar.
5. ¿Cobertura como puerta? — **resuelta**: `vitest --coverage` en CI con trinquete por archivo (criterio verde).
6. ¿El cierre suave bloquea o advierte? — **heredada**: R1 mete el checklist en la transacción del soft close y F06 le da compuertas; sin decisión única escrita.

### E0.2 (6)

1. ¿Columnas inventadas de nómina: esquema o código? — **resuelta**: esquema reparado (E0.2-f/g).
2. ¿Se honra max_withholding_pct? — **heredada a F08** (el escritor de garnishments sigue en el rojo E4.1).
3. ¿percentage o percent? — **resuelta**: vocabularios alineados con el CHECK (criterio verde).
4. ¿El contrato exige Postgres? — **resuelta**: Postgres efímero; la CI lo corre.
5. ¿Se renumeran los duplicados? — **resuelta**: no; se toleran con guarda (`docs/migraciones.md`).
6. ¿Divergencia enum: código o esquema? — **resuelta**: el registro de E0.2-j la impide; cada caso quedó documentado.

### E0.3 (6)

1. D1 ¿Fallo de auditoría aborta? — **resuelta**: fail-closed (AUD-5, `c4d47c6`).
2. D2 ¿user_id cuando el actor no es persona? — **resuelta**: contexto de actor de E0.3-a (paquete verde).
3. D3 ¿Dejar de concatenar en notes? — **resuelta**: rastro estructurado en la transacción.
4. D4 ¿Unificar el log de e.firma en audit_log? — **resuelta**: se mantiene separado e inmutable (migración 035; AUD-4).
5. D5 Retención de audit_log — **heredada a F09–F12** (retención CFF art. 30: particionado + purga auditada).
6. D6 ¿Se capturan old_values? — **heredada**: S1(3) redacta sensibles antes de escribir; el alcance de old_values sigue sin decisión escrita.

### E1.1 (4)

1. ¿Qué pasa si el catálogo no trae los códigos de ROLE_MAP? — **resuelta**: relleno diagnóstico que deja a la entidad capaz (`db1525b`).
2. ¿Tres retenciones en 2140? — **resuelta por aceptación** para fase 1; reabrirla es del panel (regla de la casa).
3. ¿El backfill crea cuentas? — **resuelta**: crea lo que falta (test de backfill en integración).
4. ¿Roles en base o TypeScript? — **resuelta**: TypeScript (no existe `account_role_catalog`).

### E1.2 (5)

1. ¿'ready' postea determinista o genera draft? — **resuelta**: plan determinista con compuertas del panel (S0.3); A4 lo gradúa con sombra.
2. ¿El CFDI emitido crea invoice? — **heredada a F02/F03** (sin constancia de decisión).
3. ¿Universo de la remediación histórica? — **heredada a F02** (REP-2).
4. ¿Se acepta 6100 con hijos y 2140 compartida, sin qualifiers? — **resuelta por aceptación** para fase 1; qualifiers quedan en fase 2.
5. ¿REP sin ImpuestosDR? — **resuelta**: IVA-5, defaults que nunca subdeclaran; las políticas `rep_faltante_*` van a F02.

### E1.3 (7)

1. D1 ¿La política autoriza con auto_post en off? — **resuelta**: el panel gobierna con precedencia y suelo inquebrantable (S0.3).
2. D2 ¿split_85 se implementa? — **heredada a F02**; el rojo E1.3 la nombra (`politica_restaurantes` sin lector).
3. D3 ¿Hasta dónde llega lleva_inventarios? — **caducada a medias**: S0.4 retiró el costeo que la consumiría; la clave sigue en el rojo E1.3.
4. D4 ¿expected_hash obligatorio? — **resuelta**: la aprobación quedó ligada al hash (§2 del Plan Maestro).
5. D5 efirma_accion_anomalia sin ventana horaria — **heredada** al guardián E1.3-d (rojo E1.3).
6. D6 ¿pac_ofrece_descarga se queda? — **caducada a medias**: la auditoría desbloqueó el estatus SAT sin PAC; la clave sigue sin lector (rojo E1.3).
7. D7 Precedencia config vs panel — **resuelta**: el panel gobierna (S0.3).

### E1.4 (6)

1. D1 Depreciación: ¿construir o retirar? — **resuelta**: construir (motor hecho; puerta en el rojo; DEP-2/F06).
2. D2 Inventarios: ¿construir o retirar? — **resuelta**: retirar (S0.4, `4e90539`).
3. D3 Blockchain — **heredada a §5** (gobernar o congelar; sigue sin decisión).
4. D4 cfdi.ts — **resuelta**: retirado rescatando catálogos SAT.
5. D5 Convención de inicio y prorrateo — **heredada al panel** (bifurcación de criterio contable), con F06.
6. D6 ¿La depreciación no posteada bloquea el cierre? — **heredada a F06** (compuertas del checklist).

### E2.1 (5)

1. ¿Qué se hace con /public/v1? — **resuelta**: desmontado por omisión (`6094f65`); camino sancionado en R2.
2. ¿Transacción por consulta o conexión por petición? — **resuelta**: `runInTenant` fijó el patrón (E2.1-a).
3. ¿Retirar HS256 o abortar el arranque? — **resuelta en S1(10)**: HS256 fijado; arrancar con el secreto de desarrollo falla (criterio verde).
4. ¿Se retiran los montajes duplicados? — **sin dueño**: `blockchainRouter` sigue montado dos veces (`src/index.ts:170-171`); candidata natural a la decisión §5 de blockchain.
5. ¿403 o 404 entre entidades del mismo tenant? — **resuelta**: 404 siempre, filtro dentro del SQL (serie TEN).

### E2.2 (5)

1. ¿Cómo se cubren los permisos de nómina? — **heredada a F08** (hoy owner-only).
2. ¿Permisos derivados o copiados? — **resuelta**: derivados del catálogo único (criterio verde).
3. ¿Rama HS256? — **resuelta en S1(10)** (misma que E2.1).
4. ¿Default de segregacion_de_funciones? — **heredada a §5** (maker-checker: cablear con F01 o diferir por escrito).
5. ¿Quién tiene settings:manage? — **sin dueño**: ningún documento vigente la nombra.

### E3.1 (7)

1. ¿Sellado propio o delegado al PAC? — **heredada a §5** (con el contrato).
2. ¿Se conservan los adaptadores simulados? — **resuelta**: se conservan tras el cerrojo (criterio verde); su degradación quedó nombrada en §5.
3. ¿Cancelación 'En proceso': anular ya o esperar acuse? — **heredada a F03** y a la decisión chica de §5 (plazo CFF 29-A).
4. ¿XML timbrado en Postgres u objeto? — **heredada a §5/F03** (bloqueada por PAC).
5. ¿Motor de exenciones art. 93 o dato de entrada? — **heredada a F08**.
6. ¿UUID fiscal en el asiento? — **heredada a F02/F03** (sin constancia).
7. ¿Con qué PAC primero? — **heredada a §5**: SW Sapien recomendado primario; el contrato es de Victor.

### E3.2 (6)

1. ¿Qué hace efirma_accion_anomalia? — **heredada** al rojo E1.3 (misma decisión que E1.3-D5).
2. ¿Se guarda el ZIP crudo? — **heredada a §5 e.firma** (motor E3.2).
3. ¿tipoSolicitud='Metadata'? — **heredada a §5 e.firma**.
4. ¿Cómo se corrige la cancelada ya pagada? — **heredada a §5** (la reversa es riesgo fiscal directo; §5 la nombra).
5. ¿ZIP propio o dependencia? — **heredada a §5 e.firma**.
6. ¿La descarga desatendida auto-contabiliza? — **resuelta en dirección**: superficie desatendida nombrada (S0.3) + regla del agente de §7 (eval, calibración y sombra antes de encender).

### E4.1 (6)

1. ¿Régimen del subsidio al empleo? — **sin dueño** (con E4.1-i; F08 no la nombra).
2. ¿Neto a banco o pasivo de sueldos? — **heredada a F08 + panel** (criterio contable).
3. ¿Calendario de entero constante o por entidad? — **heredada a F08**.
4. ¿Se desglosa el IVA de comisiones bancarias? — **heredada al panel**, con F05.
5. ¿Intereses en bruto con retención o en neto? — **heredada al panel**, con F05.
6. ¿Conciliación parcial desde el día uno? — **heredada a F05** (motor neto).

### E4.2 (8)

1. ¿bullmq+Redis o patrón Postgres? — **resuelta**: Postgres (`ai_jobs` + reclamo atómico + `jobs run-due`).
2. ¿Qué se hace con las mv_ sin lector? — **resuelta a medias**: R3 tira el trigger; el destino de las vistas quedó con el censo de muertos (S0.5).
3. ¿Cómo se despliega el worker? — **heredada a F09–F12** (familia job).
4. ¿Se persiste el cuerpo de webhooks y cuánto? — **heredada a R2/F09–F12**.
5. ¿La balanza incluye saldo de apertura? — **heredada al rojo E4.2** (la capa única decide y documenta).
6. ¿Qué se hace con las divergencias entre copias? — **heredada al rojo E4.2** (resolverlas es el trabajo de la capa).
7. ¿CFDI contabilizado que resultó cancelado? — **heredada a §5 e.firma** (reversa).
8. ¿Presupuesto por entidad o por tenant? — **heredada a §5** (decisión chica nombrada; A3 la ejecuta).

### E5.1 (7)

1. ¿Qué cuenta como IMPORTE para el backstop? — **resuelta en S1**: `MONTO_RE` en `compaction.ts`.
2. ¿Presupuesto apagado o tope; bloquea o avisa? — **resuelta en v2**: block en desatendido (A3); el alcance queda en §5.
3. ¿--continue rehidrata por defecto? — **heredada a S1(7)**; E5.1-b sigue sin implementar.
4. ¿Fallo del proveedor tras una herramienta de escritura? — **resuelta en lo esencial** con E5.1-d (failover sobre historia compactada); la semántica fina no tiene constancia escrita.
5. ¿Ventana de frescura de precios? — **resuelta en S1**: la fecha de corte es dato en `prices.ts`.
6. ¿propose_skill para el agente? — **sin dueño** (E5.1-h no se ejecutó y nadie la carga).
7. ¿Alcance del registro NIF? — **resuelta**: acotado al corpus, con test de vigencias (E5.1-i/k).

### Conteo de decisiones

**87 enumeradas**: **44 resueltas** · **37 heredadas** (al panel: 4 · a §5: 13 · a tramos, flujos o rojos del tablero: 20; las de destino doble se cuentan una vez, por su destino primario) ·
**2 caducadas a medias** (ambas claves de política que el rojo E1.3 aún nombra) ·
**4 sin dueño** (montaje doble de blockchain, `settings:manage`, régimen del subsidio,
`propose_skill`) — estas cuatro, como las tareas PENDIENTE†, no tienen más registro que este
documento.
