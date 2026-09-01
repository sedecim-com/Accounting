> **Lente 2 — La herencia del plan de cierre.** Re-medición de las 147 partidas de
> `docs/auditorias/2026-08-31-integral/disposicion-plan-cierre.md` contra el árbol en
> HEAD `a149e62` (+ commits de endurecimiento posteriores hasta `6e280dd`), con
> `npm run plan:status` como tablero vivo. Toda afirmación lleva evidencia
> `archivo:línea` verificada en esta sesión; lo no verificable se dice.

## FORTALEZAS

**F1 · La disposición fue un instrumento honesto, y se puede volver a medir.**
De las 64 partidas que la auditoría I dejó fuera de HECHA, 14 cerraron en un solo tramo de
trabajo. El registro a nivel tarea funcionó: cada una tenía dueño nombrado y por eso se pudo
verificar una por una. El nuevo reparto es **97 HECHA · 28 ABSORBIDA · 15 PENDIENTE ·
4 PENDIENTE† · 3 CAÍDA-RESCATADA-abierta = 147** (la suma vuelve a cuadrar).

**F2 · Los dos rojos que la auditoría I dejó como paquete completo cerraron de verdad, no por
prosa.** E1.2 (3/3) y E1.3 (1/1) están verdes y el criterio los decide por mutación:
`src/plan/criterios.ts:1207` busca un `INSERT INTO cfdi_classifications` real y lo encuentra en
`src/services/xml-ingestion/pre-registration-service.ts:642`; las dos políticas de e.firma
tienen lector en `src/services/fiscal-credentials/service.ts:259` y `:264`. No es un verde
declarado: si se borra el escritor, el criterio vuelve a rojo.

**F3 · Los tres huérfanos históricos más citados quedaron pagados.**
`checkSoDViolations` tiene por fin llamador real (`src/ai/doctor-service.ts:882`) y el
maker-checker es política del panel con lector en el motor
(`src/services/accounting/posting.ts:320`, `src/services/policy/pending-catalog.ts:439`).
La verificación pública dejó de empujar a un rol que ignora RLS: `src/database/consulta-publica.ts`
asume `mnemosine_verifier` con `SET LOCAL ROLE` y el rol se aprovisiona en
`src/database/rls-policies.sql:291-313`. Y el refresco salió del posteo:
`src/database/migrations/042_el_refresco_sale_del_posteo.sql:25-26` tira trigger y función.

**F4 · La semántica de saldos dejó de ser prosa y se volvió compuerta con `fail`.**
`src/ai/doctor-service.ts:770-829` compara `account_balances` contra Σ líneas posteadas y falla,
con el texto que apunta al camino de escritura. Eso era E4.2-i, ABSORBIDA a R1, y R1 la entregó.

**F5 · El estatus del SAT dejó de ser un «Vigente» fabricado.**
`src/services/sat/cfdi-status.ts:46` habla SOAP real contra `ConsultaCFDIService`, y
`src/services/xml-ingestion/sat-validation.ts:23-24` documenta el stub que sustituye. La decisión
`cfdi_cancelado` está activa (`src/services/xml-ingestion/cfdi-decisions.ts:316`, consumida en
`cfdi-classifier.ts:152`).

**F6 · La serie del folio cerró bien y con la lección escrita.**
`src/utils/sequence.ts:47-56` (`añoDeDocumento`) lee el año del texto `YYYY-MM-DD` sin pasar por
`Date` para no retroceder un día al oeste de Greenwich. Los dos `new Date().getFullYear()` que
quedan (`:68`, `:90`) están marcados `@deprecated` y acotados a identificadores no financieros.

**F7 · La remediación destructiva más peligrosa del plan ya existe y es idempotente.**
`src/services/accounting/iva-ppd-reclass.ts` reclasifica —no revierte— el IVA PPD mal acreditado,
fechado en el periodo del hecho, marcado con `source_type='iva_reclass'` y con
`reopenClosedPeriod`/`restorePeriodStatus` alrededor (`:209`). Exactamente el modo que
«Riesgos del plan» exigía: por reversa/reclasificación, nunca por `UPDATE`.

---

## BRECHAS

### El hallazgo mayor

**B1 · El corpus documental del agente está congelado en la línea base, y una de sus páginas le
enseña al agente el error contable que el sistema tiene un módulo para reparar. — NUEVA**

`E1.2-i` («Reescribir la documentación del agente») fue dispuesta **ABSORBIDA por F02**, con la
propia disposición confesando «sin constancia de ejecución»
(`docs/auditorias/2026-08-31-integral/disposicion-plan-cierre.md:118`). F02 se ejecutó
(`a149e62`) y **no la entregó**: el único `.md` del agente que tocó fue el auto-generado
`src/ai/docs/cli-reference.md`.

No es un archivo: son **trece**. `git log -1` por archivo devuelve la línea base `4eeee63` o el
temprano `02aaeea` para `accounting.md`, `receivables.md`, `reports.md`, `system.md`,
`mnemosine.md`, `playbooks.md`, `connectivity.md`, `external-integrations.md`,
`identity-access.md`, `mexico-cfdi.md`, `banking.md`, `payables.md`, `payroll.md`. Ninguno sabe
nada de S0.x, S1, R1, R2, R3, A1-A2, F01 ni F02. Todos se sirven al agente desde
`src/ai/tools/docs-tools.ts:17-45`.

Dos divergencias no son «documentación desactualizada», son **instrucción incorrecta**:

- `src/ai/docs/mexico-cfdi.md:5` — «16% input VAT goes as a separate debit (input VAT account)»,
  sin distinguir PPD. Es la regla que `src/services/accounting/iva-ppd-reclass.ts:9-13` describe
  como el defecto histórico a corregir: bajo PPD el IVA **no es acreditable** hasta el pago y el
  REP. El manual del agente enseña la práctica que el sistema tiene un módulo para deshacer.
- `src/ai/docs/accounting.md:5` — «void at any point (if it was posted, a reversing journal entry
  is generated automatically and **auto-posted**)». R1 hizo el mayor inviolable y F01 lo escribió
  al revés en `src/cli/entry-command.ts:80-82`: «a POSTED entry is never mutated and never flips
  to 'void'». El doc además promete auto-posteo, que viola la regla de la casa «el agente propone,
  el humano dispone».
- `src/ai/docs/mexico-cfdi.md:9-10` promete la cadena de timbrado «Finkok → SW Sapien → Edicom» y
  las rutas `POST /v1/invoices/:id/cfdi/stamp | /cfdi/cancel`. E3.1-a puso el cerrojo
  antisimulación y E3.1-g retiró la cancelación con 501; no hay PAC contratado (§5).

Ninguna de estas tres divergencias tiene criterio en `src/plan/criterios.ts` ni fila en el
catálogo: el tablero está verde y el agente está mal informado. Sólo `cli-reference.md` tiene
prueba de sincronía (E5.1-j, `6a6b40c`) — el resto del corpus no tiene ninguna.

### Lo que quedó sin disponer (pregunta 4)

**B2 · La sección «Cabos que ningún paquete recoge» —24 asuntos— nunca se dispuso. — NUEVA**

`docs/plan-cierre-brechas.md:8204-8232` contiene 24 viñetas que el propio plan declara «Asuntos
reales que ninguno de los paquetes cubre. No están planificados». La disposición dispuso
**147 tareas de los 15 paquetes** y nada más: la palabra «cabo» aparece una sola vez en todo el
directorio de la auditoría (`disposicion-plan-cierre.md:163`, sobre `docs/despliegue-perimetro.md`)
y en `cierre-cobertura.md:33` referida a otra cosa. Los 24 cabos quedaron fuera del inventario:
ni HECHA, ni ABSORBIDA, ni PENDIENTE, ni CAÍDA. **147/147 fue un conteo completo de lo numerado y
un conteo incompleto del documento.**

Re-medidos hoy, de los 24: **6 cerraron por efecto colateral**, **1 mutó**, **17 siguen abiertos**.

Cerrados (sin que nadie los planificara): serie del folio por fecha del documento (R3,
`src/utils/sequence.ts:47`); reconciliación de `account_balances` (R1,
`src/ai/doctor-service.ts:770`); superficie CLI `entry reverse` / `entry void` (F01,
`src/cli/entry-command.ts:829` y `:918`); CSP fuera de producción y CORS explícito
(`src/index.ts:78-90`); consumidor real de `tratamiento_ieps`
(`src/services/xml-ingestion/pre-registration-service.ts:699`); `FOR UPDATE` en la ruta de pago
de facturas (`src/services/ar/invoice-service.ts:475`, `src/services/ap/bill-service.ts:409`).

Mutó: el parser de constancias de retenciones. Ya no revienta —lo rechaza con explicación,
`src/services/xml-ingestion/cfdi-parser.ts:385-391` y `cfdi-taxonomy.ts:402`— pero la
**capacidad sigue ausente**. Rojo honesto, no cierre.

### Brechas de mayor riesgo contable/fiscal (pregunta 2)

**B3 · El cierre duro puede reportar éxito sin haber cerrado el ejercicio. — NUEVA (cabo sin disponer)**
`src/services/accounting/period-close.ts:440`: `if (!incomeSummaryId || !retainedEarningsId) return [];`.
Las cuentas de sistema se resuelven por **código literal** `'3900'`/`'3200'` (`:434`), no por
`account_roles` —que es justo la capa semántica que E1.1 sembró—. Si un catálogo no trae esos
códigos, `generateClosingEntries` devuelve cero asientos **en silencio** y el hard close se
declara exitoso. El plan lo dice y ningún paquete lo toca
(`docs/plan-cierre-brechas.md:8208`). Riesgo: un ejercicio que el sistema afirma cerrado y cuyo
resultado nunca se traspasó a Resultados de Ejercicios Anteriores.

**B4 · El subsidio al empleo se calcula y su remanente se descarta. — SIGUE-ABIERTA (E4.1-i, PENDIENTE†) — con evidencia nueva**
`src/services/payroll/common/paycheck-service.ts:247`: `const netIsr = Math.max(0, isr.tax_amount - sub.tax_amount);`.
El comentario de la línea anterior dice «if negative, employee receives as cash» y el código hace
lo contrario: lo **trunca a cero** y nada entrega el remanente al trabajador. La disposición la
marcó PENDIENTE† («sin rojo ni dueño; F08 no la nombra»,
`disposicion-plan-cierre.md:223`) y sigue igual. Es la brecha de mayor riesgo **laboral y
fiscal** del inventario: subsidio retenido indebidamente, con contingencia frente al trabajador y
frente al SAT, y sin criterio en el tablero que la vigile.

**B5 · El flujo de efectivo devuelve cero en un catálogo en español. — NUEVA (cabo sin disponer)**
`src/api/rest/routes/reports.ts:211` y `:223`: `AND a.name ILIKE '%receivable%'` / `'%payable%'`.
El catálogo que `mnemosine init` siembra está en español. El reporte no falla: **devuelve cero y
lo presenta como dato**. Es el patrón «verde falso» que la casa prohíbe. El propio plan escribió
la corrección dentro del cuerpo de E4.2-j (`docs/plan-cierre-brechas.md:7464`: sustituir por
`account_roles` y devolver `null` con `unavailable_reason` en vez de cero), pero E4.2-j sigue
**PENDIENTE** — el tablero lo confirma: 4 copias del SQL de saldos fuera de `report-service`.

**B6 · El operador `regex` del motor de reglas compila expresiones del inquilino sin cota. — NUEVA (cabo sin disponer)**
`src/services/xml-ingestion/rules-engine.ts:208`: `new RegExp(String(compareValue), 'i').test(String(fieldValue))`.
`compareValue` sale de una regla almacenada en base. Sin límite de longitud ni de tiempo: ReDoS con
entrada controlada por el inquilino, en la ruta de ingesta. `docs/plan-cierre-brechas.md:8220` ya
lo nombraba.

**B7 · La reapertura de periodo no tiene puerta, y `fiscal_years.status` nunca llega a `closed`. — SIGUE-ABIERTA (cabo)**
Honestidad ganada: `src/auth/roles.ts:59` ahora lo confiesa por escrito —«reopenClosedPeriod existe
pero sólo lo invoca el backfill de IVA; falta su ruta y su comando»—. Pero el permiso
`periods:reopen` se concede (`src/auth/roles.ts:41`, `:112`) para una capacidad que ningún humano
puede invocar: hoy sólo la usa `src/services/accounting/iva-ppd-reclass.ts:209`.

**B8 · 27 de los 30 eventos de webhook nunca se emiten. — SIGUE-ABIERTA (cabo)**
El catálogo declara `journal_entry.posted`, `invoice.*`, `cfdi.stamped`, `period.hard_closed`
(`src/services/webhooks/webhook-service.ts:9-17`). Los únicos llamadores reales de `dispatchEvent`
son tres de nómina (`src/services/payroll/common/pay-run-service.ts:99`, `:125`, `:136`) y un
`test.ping` (`src/api/rest/routes/webhooks.ts:60`). R2 endureció la **entrega** (URL vigilada en
`src/services/webhooks/url-guard.ts:59`, firma anti-replay en `webhook-service.ts:113`) — endureció
un canal por el que casi nada viaja.

### Absorbidas por fases ya ejecutadas que la fase no entregó (pregunta 3)

Busqué explícitamente toda partida ABSORBIDA cuyo dueño fuera S1, R1, R2, R3, A1-A2, F01 o F02.
Son 12. **Nueve se entregaron** (E2.1-f→R2, E4.2-c→R3, E4.2-i→R1, E3.2-g y E3.2-h→F02,
E2.2-e→F01, más E1.4-a/E2.1-e/E5.1-c/E5.1-f de S1, ya commiteadas en `205e1e0`). **Tres no**:

**B9 · E1.2-i (documentación del agente) → F02. NO ENTREGADA.** Es B1. La más grave: se dio por
muerta y no lo está.

**B10 · E4.2-g (revalidación periódica del estatus CFDI) → F02. ENTREGADA A MEDIAS. — SIGUE-ABIERTA**
El motor existe: `src/services/sat/cfdi-status.ts:191` (`revalidateEntityCfdis`, barrido por
entidad). Lo **periódico** no: su único llamador es la CLI (`src/cli/cfdi-command.ts:209`), y
`src/ai/jobs/job-store.ts:18` fija `JobKind = 'close_verification' | 'cfdi_reconciliation' | 'ar_reminders'`
— ninguno revalida estatus. La compuerta `cfdi_reconciliation`
(`src/ai/jobs/wake-gate.ts:47`) detecta CFDI **sin asiento**, no CFDI **cancelados por el emisor**.
Sin barrido programado, un CFDI ya contabilizado que el emisor cancela permanece vigente en los
libros hasta que alguien teclee el comando.

**B11 · E1.2-h (remediación del histórico PPD) → F02: mal clasificada, ya estaba HECHA. — CERRADA-DESDE-AUDITORIA-I (por corrección)**
`git log --diff-filter=A` sobre `src/services/accounting/iva-ppd-reclass.ts` devuelve `b975070`
(«E1.2-b: reparación del IVA de CFDI PPD ya mal acreditado») — **anterior** a la auditoría. La
disposición difirió a F02 una obligación ya satisfecha. Error benigno en dirección segura, pero
error de medición: contamina el conteo de las 34 ABSORBIDAS.

### Correcciones a la evidencia de la auditoría I

**B12 · La evidencia de E2.2-g es incorrecta: el archivo sí existe. — MUTÓ**
`disposicion-plan-cierre.md:175` y `cierre-cobertura.md:33` afirman «el archivo no existe en
docs/». Existe: **`src/ai/docs/identity-access.md`**, servido al agente desde
`src/ai/tools/docs-tools.ts:33`. Lo que no existe es lo que la tarea pedía: **sección generada
desde `src/auth/roles.ts` y test de sincronía** — `grep -rn "identity-access" src/ tests/` sólo
devuelve el registro del tema y una prueba del system-prompt
(`tests/ai/system-prompt.spec.ts:50`). E2.2-g sigue abierta, pero por otra razón que la escrita, y
ahora cae bajo B1: el archivo está en la línea base `4eeee63`.

### Pendientes que no se movieron

**B13 · E1.4-g — la depreciación sigue sin puerta. — SIGUE-ABIERTA**
`src/plan/criterios.ts:1285` lo dictamina y `src/services/assets/depreciation.ts:270` tiene el motor
sin un solo llamador fuera del criterio. Confirmado por el tablero (🟡 E1.4 1/2). Riesgo contable
directo: sin depreciación no hay resultado del ejercicio correcto ni deducción de inversiones
(LISR 31-38).

**B14 · E4.1-h/-k — nómina sin escritores. — SIGUE-ABIERTA**
`grep "INSERT INTO paycheck_taxes|employer_tax_liabilities|garnishments"` sobre `src/`: **cero
resultados**. Los 941/940 reportan ceros y los embargos salen de una tabla que ningún camino
puebla. Tablero 🟡 E4.1 2/3.

**B15 · E3.2-a…f, -i, -j, -k — la descarga masiva del SAT sigue entera. — SIGUE-ABIERTA**
⬜ E3.2 0/1. Nueve de las once tareas del paquete siguen sin empezar. **E3.2-i** (factura
contabilizada que el emisor canceló → reversa) es riesgo fiscal directo y su detección depende de
B10.

**B16 · E4.2-j/-k/-l — cuatro copias del SQL de saldos. — SIGUE-ABIERTA**
El tablero las nombra: `src/ai/external-service.ts`, `src/api/graphql/resolvers/index.ts`,
`src/api/rest/routes/reports.ts`, `src/services/blockchain/orchestrator.ts`. Es donde vive B5, y
donde volverá a vivir cualquier divergencia futura entre superficies.

**B17 · E5.1-b, -g, -h — el agente no rehidrata, la raíz de skills sigue doble, y falta una entrada. — SIGUE-ABIERTA**
`--continue` sigue arrancando en blanco (tablero E5.1 10/12). `skillDirs` sigue en
`src/ai/skills/store.ts:198` mientras `src/ai/skills/skill-drafts.ts:55-64` resuelve la raíz desde
la ubicación del módulo y **documenta la divergencia como pendiente de integrar** — dos raíces con
la constancia escrita de que deben ser una. De las dos entradas a `skill_drafts` sólo existe
`stage` (`skill-drafts.ts:143`); `propose_skill` no aparece en `src/`.

**B18 · `docs/despliegue-perimetro.md` sigue sin escribirse. — SIGUE-ABIERTA**
`find` sobre el repo no lo encuentra. La disposición lo registró como cabo en
`disposicion-plan-cierre.md:163`. «Riesgos del plan» lo exigía **antes** de E2.1-b, no después; y
E2.1-b ya se desplegó.

### Resumen numérico de la re-medición

| Disposición | Auditoría I | Hoy | Δ |
|---|---:|---:|---:|
| HECHA | 83 | **97** | +14 |
| ABSORBIDA | 34 | **28** | −6 |
| PENDIENTE (con rojo) | 18 | **15** | −3 |
| PENDIENTE† (sin dueño) | 4 | **4** | 0 |
| CAÍDA→RESCATADA abierta | 8 | **3** | −5 |
| **Total** | 147 | **147** | — |

**Partidas que cambiaron de estado (las 14, con evidencia):**

| ID | Antes | Ahora | Evidencia |
|---|---|---|---|
| E1.2-b | PENDIENTE | HECHA | `src/services/xml-ingestion/pre-registration-service.ts:642` |
| E1.2-c | PENDIENTE | HECHA | mismo `INSERT` + `UPDATE cfdi_classifications` en `:520` |
| E1.3-d | PENDIENTE | HECHA | `src/services/fiscal-credentials/service.ts:259`, `:264` |
| E2.2-e | RESCATADA | HECHA | `src/ai/doctor-service.ts:882` + `src/services/accounting/posting.ts:320` |
| E2.1-f | ABSORBIDA (R2) | HECHA | `src/database/consulta-publica.ts` + `src/database/rls-policies.sql:291-313` |
| E4.2-c | ABSORBIDA (R3) | HECHA | `src/database/migrations/042_…sql:25-26` |
| E4.2-i | ABSORBIDA (R1) | HECHA | `src/ai/doctor-service.ts:770-829` (con `fail`) |
| E3.2-g | ABSORBIDA (F02) | HECHA | `src/services/sat/cfdi-status.ts:46` |
| E3.2-h | ABSORBIDA (F02) | HECHA | `src/services/xml-ingestion/cfdi-decisions.ts:316` + `cfdi-classifier.ts:152` |
| E1.2-h | ABSORBIDA (F02) | HECHA (ya lo era) | `src/services/accounting/iva-ppd-reclass.ts`, alta en `b975070` |
| E1.4-a | RESCATADA (árbol) | HECHA | migración 040 + `crypto-service.ts`, commiteadas en `205e1e0` |
| E2.1-e | RESCATADA (árbol) | HECHA | `rls-guard.ts` + `src/index.ts`, `205e1e0` |
| E5.1-c | RESCATADA (árbol) | HECHA | `MONTO_RE` en `compaction.ts`, `205e1e0` |
| E5.1-f | RESCATADA (árbol) | HECHA | fecha de corte como dato en `prices.ts`, `205e1e0` |

---

## RECOMENDACIONES

**R1 · Disponer los 24 cabos como partidas 148–171. — S — antes del siguiente tramo (gobernanza, §7)**
No es trabajo de código: es una tabla igual a la de las 147, con las mismas cinco etiquetas, en
`docs/auditorias/.../disposicion-plan-cierre.md`. Sin ella, «147/147» seguirá midiendo un
subconjunto del documento y nadie sabrá que 17 asuntos reales no tienen dueño. Los ya cerrados
por efecto colateral (6) se registran como HECHA con su commit; los 17 abiertos reciben fase o
retirada por escrito. **Nota:** DIOT (cabo `docs/plan-cierre-brechas.md:8231`) **sí** tiene dueño en
el Plan Maestro — F07 lo lista como «10 filas + DIOT/filing de la cola». Ése se dispone ABSORBIDA,
no huérfano.

**R2 · Poner el corpus documental del agente bajo criterio del tablero. — M — A5 (el lazo que aprende), adelantando la parte de sincronía**
Un criterio nuevo en `src/plan/criterios.ts` que falle cuando un `.md` de
`src/ai/tools/docs-tools.ts:17-45` no se haya tocado desde un commit que cambió el servicio que
describe. Es el mismo patrón que ya funcionó para `cli-reference.md` (E5.1-j). Sin la compuerta,
la próxima fase volverá a dejar el manual atrás y el tablero volverá a estar verde.

**R3 · Reescribir hoy `mexico-cfdi.md` y `accounting.md`, antes de que ningún tramo más los use. — S — F02 (deuda de F02, se paga en F02)**
Son dos archivos de 20 y 25 líneas. Lo que hay que corregir está identificado y acotado:
IVA PPD a `1135` pendiente de acreditar (`mexico-cfdi.md:5`); mayor inviolable y reversa que
**no** se auto-postea (`accounting.md:5`); cadena de PAC y rutas de timbrado que no existen
(`mexico-cfdi.md:9-10`); el panel de políticas como gobierno de la ingesta (`mexico-cfdi.md:16`).
Prioridad sobre R2 porque R2 es la compuerta y esto es el incendio.

**R4 · Entregar el remanente del subsidio al empleo — y llevar su régimen al panel. — M — F08, con decisión previa de panel**
`src/services/payroll/common/paycheck-service.ts:247` trunca con `Math.max(0, …)`. Dos actos
distintos: (a) el régimen —tabular con entrega en efectivo vs. porcentaje de UMA sin entrega— es
**bifurcación de criterio fiscal**, luego va a `policy_decisions` como nueva clave, nunca
hardcodeada ni preguntada en chat (regla de la casa a); (b) el asiento del remanente como pasivo o
como dispersión, dentro del motor de F08. **E4.1-i debe dejar de ser PENDIENTE†**: hoy no tiene
criterio, ni fila, ni tramo. Es la única brecha del inventario con contingencia laboral directa.

**R5 · Que el cierre duro no pueda mentir. — S — F06 (cerrar el mes)**
`src/services/accounting/period-close.ts:434-440`: resolver `income_summary` y `retained_earnings`
por `account_roles` (la capa que E1.1 ya siembra) y **lanzar** en vez de `return []`. Un hard
close que no encuentra sus cuentas de sistema debe fallar ruidosamente. S de tamaño, alto de
consecuencia.

**R6 · Acotar el operador `regex` del motor de reglas. — S — R2/endurecimiento (deuda de perímetro)**
`src/services/xml-ingestion/rules-engine.ts:208`: cota de longitud del patrón, lista blanca de
construcciones o motor lineal. Entrada controlada por el inquilino en la ruta de ingesta; encaja
en el mismo tramo que ya endureció URL saliente y firma de webhook.

**R7 · Levantar la capa única de reportes y matar el `ILIKE` en el mismo movimiento. — L — F09–F12, prerrequisito de la familia `report`**
E4.2-j/-k/-l siguen pendientes y el tablero nombra las cuatro copias. El cuerpo de E4.2-j en
`docs/plan-cierre-brechas.md:7464` ya prescribe la solución del flujo de efectivo: resolver por
`account_roles` y devolver `null` con `unavailable_reason` en lugar de cero. Escribir la capa sin
esa corrección reproduce el verde falso en un solo sitio en vez de cuatro.

**R8 · Añadir `cfdi_status_revalidation` como cuarto `JobKind`. — S — F09–F12 (familia `job`), con la reversa en §5 e.firma**
`src/ai/jobs/job-store.ts:18-20`. El motor ya existe (`revalidateEntityCfdis`,
`src/services/sat/cfdi-status.ts:191`); falta el tick. Cierra la mitad no entregada de E4.2-g y es
prerrequisito de detección para E3.2-i (la reversa de la factura cancelada, que sigue siendo
decisión de §5 y **bifurcación contable → panel**).

**R9 · Escribir `docs/despliegue-perimetro.md` aunque el perímetro ya esté desplegado. — S — R2 (deuda cerrada tarde)**
E2.1-j se marcó HECHA con el cabo registrado. El documento sigue faltando y ahora sirve para lo
inverso de lo que se pensó: no para desplegar, sino para **volver atrás** si una política RLS
resulta incompleta en producción.

**R10 · Dar dueño o retirar por escrito las cuatro PENDIENTE† y las cuatro decisiones sin dueño. — S — gobernanza, con el siguiente tramo**
PENDIENTE†: E2.2-g (sección generada de `identity-access.md` — corregir además la evidencia, ver
B12), E4.1-i (→ R4), E5.1-g (raíz única de skills; la divergencia está documentada en
`src/ai/skills/skill-drafts.ts:55-64` y es una `S`), E5.1-h (`propose_skill`).
Sin dueño: doble montaje de `blockchainRouter`, `settings:manage`, régimen del subsidio (→ R4),
`propose_skill`. Ocho renglones que sólo este registro carga; si el siguiente tramo no los toma,
el registro deja de ser suficiente.

---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** La documentación del agente (E1.2-i) fue dada por ABSORBIDA por F02, F02 se ejecutó y no la entregó: los 13 .md de src/ai/docs/ siguen en la línea base 4eeee63 y uno de ellos, src/ai/docs/mexico-cfdi.md:5, le enseña al agente el tratamiento de IVA que src/services/accounting/iva-ppd-reclass.ts:9-13 existe para reparar.

**¿Refutado?** No: se sostiene

SE SOSTIENE, con correcciones de conteo y de causalidad. Lo verificado con evidencia propia:

(1) LA ABSORCIÓN Y LA NO ENTREGA — CONFIRMADO LITERALMENTE. `docs/auditorias/2026-08-31-integral/disposicion-plan-cierre.md:118` dice: «E1.2-i | Reescribir la documentación del agente | ABSORBIDA | F02 (flujo de ingesta; sin constancia de ejecución)». `git show --stat --name-only a149e62 -- src/ai/` devuelve exactamente dos archivos: `src/ai/docs/cli-reference.md` y `src/ai/ingest-service.ts`. cli-reference.md es autogenerado por el catálogo, no es la documentación de criterio que E1.2-i pedía. F02 declara en su propio cuerpo «EL RASTRO (E1.2 → VERDE)». Es decir: se dio E1.2 por cerrada con la tarea -i absorbida y sin tocar ninguno de los tres archivos que su especificación nombra.

(2) EL CONTEO ES FALSO. No son 13 sino 23 de 27 .md los que siguen en 4eeee63 (`git log -1 -- <cada archivo>`). Tres (`banking.md`, `payables.md`, `payroll.md`) están en 02aaeea, y `cli-reference.md` en a149e62. El «13» no corresponde a ningún corte verificable del directorio.

(3) EL CONTENIDO DEL DOC — CONFIRMADO Y PEOR DE LO DICHO. `src/ai/docs/mexico-cfdi.md:5` dice «16% input VAT goes as a separate debit (input VAT account)» sin distinguir PPD, y la línea 4 añade el error de contrapartida («PUE → credited against BANKS»), que `src/services/xml-ingestion/cfdi-taxonomy.ts:165-167` contradice explícitamente (`{ role: 'cxp', side: 'credit' }` + nota «Crediting banks directly would double the outflow»). El doc es servido VIVO al modelo: `src/ai/tools/docs-tools.ts:53` (`readDoc` lee de `src/ai/docs`) y la herramienta `read_docs` está disponible en cualquier sesión. `grep '1135'` sobre `src/ai/docs/` devuelve UNA sola línea, `nif-registro.md:178` — y esa línea remata «(ver mexico-cfdi)»: una referencia cruzada colgando, porque mexico-cfdi.md nunca menciona 1135 ni 2125. Eso el hallazgo no lo vio y refuerza su caso.

(4) LA ATRIBUCIÓN CAUSAL ESTÁ EXAGERADA. `src/services/accounting/iva-ppd-reclass.ts:9-13` no culpa al doc: dice «Hasta que el clasificador entró en la ruta viva, toda factura recibida mandaba su IVA a "IVA Acreditable" sin mirar el método de pago». La causa histórica declarada es el código, no la documentación. El doc no es la causa probada del daño que la reclasificación repara; es el portador SUPERVIVIENTE de la misma regla, en una superficie viva.

(5) LO QUE SÍ ESTÁ CERRADO Y EL HALLAZGO OMITE. La pieza 2 de E1.2-i (el prompt) ya se arregló antes de F02: `git blame` sobre `src/ai/ingest-service.ts:586-596` marca dc0d46d («IVA-2»), y el texto hoy enseña lo correcto: «PPD (on credit): debit expense for the subtotal + debit "IVA Pendiente de Acreditar" (1135) ... Do NOT debit IVA Acreditable». Presentar E1.2-i como intacta sería falso.

(6) RESIDUO REAL EN EL PROMPT. Ese mismo prompt corregido conserva el error de contrapartida: `src/ai/ingest-service.ts:590` («+ credit banks» para PUE) y `:579` («PUE = paid, PPD = on credit → account payable»), ambos contra cfdi-taxonomy.ts:165-167. Y la ruta viva existe: `src/ai/ingest-service.ts:205` (`session.runTurn(buildCfdiPrompt(upload))`, «Layer 2: the AI classifies and creates the draft»).

(7) LAS OTRAS DOS PIEZAS SIGUEN ABIERTAS. `src/ai/tools/docs-tools.ts:22` conserva la descripción vieja («CFDI 4.0 (PUE/PPD, VAT), multi-PAC stamping, XML ingestion»), sin la mención a cuentas puente que E1.2-i pide. Y el test de gobernanza `tests/ai/docs-mexico-cfdi.spec.ts` no existe (`ls tests/ai/`): nada impide reintroducir la regla vieja.

**Formulación corregida:** E1.2-i («Reescribir la documentación del agente») se marcó ABSORBIDA por F02 con la nota «sin constancia de ejecución» (disposicion-plan-cierre.md:118), y F02 la cerró sin entregarla: a149e62 tocó bajo src/ai/ únicamente cli-reference.md (autogenerado) e ingest-service.ts, mientras declaraba «E1.2 → VERDE».

De las tres piezas que E1.2-i especifica (plan-cierre-brechas.md:2952-2990), una ya estaba cerrada ANTES de F02 y dos siguen abiertas:

- CERRADA (por dc0d46d «IVA-2», no por F02): el prompt de ingesta enseña ya la regla correcta — ingest-service.ts:591-594 manda el IVA de PPD a 1135 y prohíbe explícitamente 1130.
- ABIERTA: src/ai/docs/mexico-cfdi.md sigue en la línea base 4eeee63. Su línea 5 («16% input VAT goes as a separate debit (input VAT account)») enseña el acreditamiento plano sin distinguir método de pago, y su línea 4 («PUE → credited against BANKS») contradice cfdi-taxonomy.ts:165-167, que acredita cxp en ambos casos y explica por qué. El documento se sirve vivo al modelo por read_docs (docs-tools.ts:53) en cualquier sesión, incluida la ruta donde el modelo redacta el asiento (ingest-service.ts:205). Agravante no citado en el hallazgo original: nif-registro.md:178 enseña lo correcto y remite «(ver mexico-cfdi)», una referencia cruzada colgando — mexico-cfdi.md es el único doc del directorio que debería mencionar 1135/2125 y no menciona ninguno.
- ABIERTA: docs-tools.ts:22 conserva la descripción vieja del tema, y el test de gobernanza tests/ai/docs-mexico-cfdi.spec.ts no existe, así que nada impide la reintroducción.

Corrección de escala: no son «13 .md» sino 23 de 27 los que permanecen en 4eeee63 — un dato que el hallazgo erró y que no cambia su fondo.

Corrección de causalidad: el doc NO es la causa del daño que iva-ppd-reclass.ts repara. Ese archivo atribuye el daño al código («hasta que el clasificador entró en la ruta viva», líneas 9-13). El doc es el portador superviviente de la misma regla errónea en una superficie viva y sin guardia — riesgo de reintroducción por la vía del agente, no origen probado del pasivo ya reclasificado.

Residuo adicional descubierto en la verificación: el prompt «corregido» conserva el error de contrapartida de PUE — ingest-service.ts:579 y :590 siguen diciendo «credit banks», contra cfdi-taxonomy.ts:165-167.

