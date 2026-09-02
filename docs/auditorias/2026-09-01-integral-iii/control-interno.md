# Lente 5 · Control interno y evidencia para un tercero
**Árbol:** `61379d0` (origin/main `cfe40c6` + los dos commits de documentación del PR 19).
Toda cita es ruta relativa al raíz del árbol auditado y fue abierta.

---

## LO QUE RESISTE

Esto no es cortesía: son controles que un ERP comercial no trae y que un auditor externo agradecería encontrar.

**R1. La bitácora es append-only de verdad, incluso contra el dueño del esquema.** `src/database/migrations/033_audit_log_append_only.sql:45-58` pone disparadores `BEFORE UPDATE OR DELETE` y `BEFORE TRUNCATE`, y el comentario de la función (`:42-43`) dice explícitamente que alcanza al dueño, «que los privilegios de tabla no detienen». `scripts/provision-roles.sql:74-79` reconcilia el `GRANT ALL TABLES` para no devolverle UPDATE/DELETE a la app al reprovisionar. Es la clase de detalle que sólo aparece cuando alguien lo pensó dos veces.

**R2. El rastro se confirma con el hecho, no aparte.** `src/services/audit/audit-log.ts:16-20`: `registrarAuditoria` recibe el **cliente de la transacción**, no `query()`. La nota explica por qué —una reversión dejaba el renglón de auditoría huérfano— y el motor de posteo lo cumple (`src/services/accounting/posting.ts:161-170`). La mayoría de los ERP escriben la bitácora fuera de la transacción del hecho.

**R3. `ledger check --check audit-trail` busca posteadas sin autor.** `src/services/accounting/ledger-checks.ts:87-105`: `journal_entries` en estado `posted` sin fila `action='post'` en `audit_log`, severidad bloqueante. Es un control de completitud de bitácora que casi nadie construye. (Su límite está en el hallazgo 13.)

**R4. Reabrir un periodo tiene tres cerrojos y motivo obligatorio.** `src/services/accounting/fiscal-calendar-service.ts:215-272`: `'locked'` no se reabre por ningún camino, el motivo es obligatorio y llega a `audit_log` con el estado anterior, y devuelve `previousStatus` para que quien reabre sepa a dónde volver. `openPeriod` remite explícitamente aquí (`:357`). Bien hecho.

**R5. El mayor auxiliar ya trae la conciliación que pide un auditor.** `src/services/reporting/report-service.ts:958-994` devuelve a la vez `final` (el `ending_balance` almacenado) y `final_calculado` (inicial + cargos − abonos), más los movimientos y `inicial_confiable` según el estado del periodo. Es exactamente la prueba de «el saldo cuadra con sus movimientos», ya construida.

**R6. Para un sistema AI-first, la evidencia del acto de la máquina es mejor de lo normal.** `src/database/migrations/011_ai_drafts.sql:22-33` guarda `ai_confidence`, `ai_reasoning`, `ai_model` y `user_request`; el asiento aprobado nace con `sourceType:'ai_draft'` y `sourceId:draftId` (`src/ai/draft-service.ts:406-408`); y ese par viaja al `new_values` de la fila de auditoría porque `resumenAsiento` los incluye (`src/services/accounting/posting.ts:462-463`). Un auditor **sí** puede aislar los asientos propuestos por la IA. (Lo que no puede está en el hallazgo 8.)

**R7. El documento fuente se conserva, no sólo lo parseado.** `src/database/migrations/005_xml_ingestion.sql:62-63`: `xml_content TEXT NOT NULL` y `xml_hash`. Contra el art. 30 del CFF, retener el XML íntegro en la base es la decisión correcta.

**R8. Honestidad documentada donde duele.** `src/services/ap/bill-service.ts:205-207` nombra el hueco de su propia cadena en vez de esconderlo («The only link between a bill and its XML is `pre_registrations.bill_id` … A bill captured by hand has none»). `src/index.ts:208-232` documenta GraphQL como la puerta menos segura —fuera del prefijo auditado, sin comprobación de permisos en los resolvers— y la deja **apagada por omisión** (`GRAPHQL_ENABLED`), con un `logger.warn` al encenderla. Rojo honesto, no verde falso.

---

## HALLAZGOS

### 1. [NUEVA] · ALTA · La identidad del actor en la terminal es una afirmación libre, y el maker-checker descansa sobre ella

`src/cli/kernel/flags.ts:72-77` declara para toda la superficie con contexto:

```
.option('-u, --user <email>', 'acting user, for attribution and permissions');
```

El diccionario de banderas promete **permisos**. `grep -rn "requirePermission\|hasPermission\|permissionsOf" src/cli/ src/ai/` devuelve **cero** resultados: las tres funciones sólo aparecen en `src/api/rest/`. `resolveReviewer` (`src/ai/draft-service.ts:290-301`) resuelve el correo contra `users WHERE tenant_id = $1 AND is_active = true AND email = $2` y devuelve su `id`. No hay contraseña, ni token, ni sesión, ni comprobación de rol.

**Escenario de fallo.** Un despacho pone `segregacion_de_funciones = 'exigir'` (la promesa literal del panel: `src/services/policy/pending-catalog.ts:448`). Ana redacta una póliza manual de 800 000 MXN. `entry post` compara `entry.created_by === userId` (`src/services/accounting/posting.ts:317`). Ana escribe:

```
mnemosine entry post JE-2026-0412 --user beto@despacho.mx --yes
```

`withContext(post)` declaró la bandera (`src/cli/entry-command.ts:764` → `flags.ts:76`) y la acción la lee (`entry-command.ts:803`). El asiento se postea, `journal_entries.posted_by` dice Beto y `audit_log.user_id` dice Beto. La póliza que el control de cuatro ojos existía para impedir queda en el mayor, atribuida a alguien que nunca la vio, y el rastro no contradice nada.

**Consecuencia para el tercero.** Todo `audit_log.user_id` originado en la superficie CLI-first —que es *la* superficie de este producto— es una declaración del operador, no una prueba. Un auditor no puede apoyar una conclusión de responsabilidad en esa columna.

### 2. [NUEVA] · ALTA · La rama `autoPost` postea sin pasar por la política de segregación

`postJournalEntry` consulta `segregacion_de_funciones` en `src/services/accounting/posting.ts:317-333`. Pero `createJournalEntry` tiene su **propia** rama de posteo: `posting.ts:172-215` valida, toma el candado de periodo, hace `UPDATE journal_entries SET status='posted', posted_by=$2`, escribe la fila `post` y mueve `account_balances`. **En esas 44 líneas no hay una sola llamada a `getPolicy`.**

Alcanzable desde fuera: `createJournalEntrySchema` acepta `auto_post: z.boolean().optional()` (`src/api/rest/routes/journal-entries.ts:63`) y la ruta lo pasa tal cual (`:174-186`). Esa ruta exige `journal_entries:create` y **no** `journal_entries:post`.

**Escenario de fallo.** Tenant con la política en `'exigir'`. Un principal con rol `contador` (que tiene `journal_entries:create` y `journal_entries:post`, `src/auth/roles.ts:121`) —o cualquiera que sólo tuviera `create`— envía `POST /v1/journal-entries` con `{"auto_post": true, "lines": [...]}`. `source_type` queda NULL (es manual: `posting.ts:125` sólo lo llena desde `options`), `created_by = posted_by = él mismo`, y el asiento entra al mayor con los saldos movidos. La compuerta de cuatro ojos no se ejecutó, y de paso se saltó el permiso `journal_entries:post`.

**Agravante: el criterio del tablero es estructuralmente ciego a esto.** `src/plan/criterios.ts:672-674` recorta el fuente con `p.indexOf('export async function postJournalEntry')` y evalúa **sólo ese tramo**. La rama `autoPost` vive antes, en otra función. E0.1 seguirá verde para siempre por más que esta puerta esté abierta. Es exactamente el verde falso que la casa persigue, y la regla (c) —verificar por mutación en ambas direcciones— no lo habría cazado tampoco, porque el mutante iría al tramo que el criterio sí mira.

### 3. [NUEVA · corrige a la II] · ALTA · La única regla SoD de severidad alta no puede dispararse nunca, y el rol `owner` sale limpio

`SOD_RULES` (`src/api/rest/middleware/auth.ts:285-309`) tiene tres reglas. La única `severity: 'high'` es «Vendor Setup vs Payment Approval» y su primer grupo es `['vendors:create', 'vendors:update']` (`:289`). Esos dos permisos **no existen**: no están en `PERMISSIONS` (`src/auth/roles.ts:29-46`), ningún rol los concede y ninguna ruta los exige. Su única aparición en todo el árbol es esa línea.

**Verificado ejecutando** `checkSoDViolations` contra los siete roles reales y contra el universo completo de permisos declarados:

```
vendors:create en el catalogo? false
vendors:update en el catalogo? false
owner       []
admin       [{"rule":"Entry Creation vs Posting","severity":"medium"}]
controller  [{"rule":"Entry Creation vs Posting","severity":"medium"},{"rule":"Period Close vs Reopen","severity":"low"}]
contador    [{"rule":"Entry Creation vs Posting","severity":"medium"}]
revisor     []   auditor []   viewer []
TODOS       [{"rule":"Entry Creation vs Posting","severity":"medium"},{"rule":"Period Close vs Reopen","severity":"low"}]
```

Ni con **todos** los permisos del sistema concedidos a la vez se enciende la regla alta. Y `owner` —cuyo `permissions` es `['*']` (`src/auth/roles.ts:91`)— devuelve **cero conflictos**, porque `checkSoDViolations` hace pertenencia de cadena literal y `'*'` no casa con nada (`auth.ts:316-317`). El comodín que `requirePermission` honra (`auth.ts:148`) es invisible para el detector.

**Escenario de fallo.** Un despacho de dos personas corre `mnemosine doctor`. El usuario todopoderoso tiene rol `owner`. `checkPermisosEnConflicto` (`src/ai/doctor-service.ts:875-901`) lee `users.permissions`, obtiene `['*']`, no encuentra violaciones y emite: **«ningún usuario activo acumula permisos en conflicto»**, nivel `ok`. El auditor recibe un certificado de segregación limpia sobre el principal que puede hacer absolutamente todo.

**Sobre la auditoría II.** `maestro-vs-codigo.md:27` (F4) dio por buena la reparación del huérfano: «huérfano pagado con **llamada real** en doctor». La llamada es real; **la regla que evalúa es inerte y su lectura sobre `owner` es falsamente tranquilizadora**. La afirmación de la II fue medida a nivel de «¿tiene llamador?» y no a nivel de «¿juzga algo?» — el mismo vicio que la II denunció en los 66 criterios de regex.

### 4. [NUEVA] · ALTA · Un permiso, tres actos: alta de proveedor + captura de factura + registro del pago

- `POST /v1/vendors` → `requirePermission('bills:create')` (`src/api/rest/routes/vendors.ts:93`)
- `PATCH /v1/vendors/:id` → `requirePermission('bills:create')` (`vendors.ts:109`)
- `POST /v1/bills` → `requirePermission('bills:create')` (`src/api/rest/routes/bills.ts:125`)
- `POST /v1/bills/payments` (pago a proveedor) → `requirePermission('bills:create')` (`bills.ts:167`)

El mismo permiso. Y `createVendor` acepta `clabe`, `bank_account_number` y `bank_routing_number` y los cifra (`src/services/ap/vendor-service.ts:411-427`).

**Escenario de fallo.** Un `contador` (tiene `bills:create`, `src/auth/roles.ts:123`) da de alta «Servicios Integrales del Bajío S.A.» con su propia CLABE, captura una factura de 240 000 MXN a su nombre y registra el pago. Tres llamadas, un permiso, cero segundas firmas. La regla de SoD escrita para cazar precisamente esto es la del hallazgo 3, que no puede dispararse.

**Y el primer acto no deja rastro.** `createVendor` (`vendor-service.ts:399-442`) **no escribe fila en `audit_log`**. Sólo `updateVendor` (`:507`) y el cambio de términos (`:581`) lo hacen; el propio tipo `VendorUpdateContext` documenta que el hueco del `vendor edit` era exactamente ése (`:456-462`) — y se cerró para la edición, no para el alta. El pago sí queda auditado (`src/services/payments/payment-service.ts:296-308`, con nota «R1: el pago deja su rastro propio»), la factura también (`src/services/ap/bill-service.ts:534`). El eslabón que falta es justo el que un auditor buscaría primero: **quién dio de alta al beneficiario y cuándo**.

### 5. [NUEVA] · ALTA · No existe baja de usuario, ni cambio de rol auditado, ni revocación de sesión — y `init` es una puerta de escalada silenciosa

`grep -rn "UPDATE users" src/` → **cero resultados**. `users.is_active` se fija al crear y ningún camino del producto lo cambia.

Lo cruel es que el control *lector* sí está bien hecho: `resolveIdentity` comprueba `is_active` **en cada petición OIDC** y lanza `NoAccessError` (`src/auth/provisioning.ts:64`). El interruptor existe y nadie puede accionarlo.

Cadena completa:

- **Alta:** dos caminos (`src/cli/init/s2-users.ts:116` y `src/auth/provisioning.ts:120`). **Ninguno escribe en `audit_log`.**
- **Escalada:** `s2-users.ts:117-120` termina en `ON CONFLICT (tenant_id, email) DO UPDATE SET roles = EXCLUDED.roles, permissions = EXCLUDED.permissions`. `mnemosine init` es un asistente interactivo sin autenticación previa. **Quien alcance la terminal promueve cualquier correo existente a `owner` (`permissions: ['*']`), en una corrida, sin dejar renglón.**
- **Baja:** no existe.
- **Sesión:** `sessions` sólo recibe INSERT (`provisioning.ts:143`); `grep` de `revoke|logout|DELETE FROM sessions` en `src/auth/` → cero. El camino local es JWT apátrida verificado contra el secreto y nada más (`src/api/rest/middleware/auth.ts:106-116`), con los permisos **congelados dentro del token** (`requirePermission` lee `req.user.permissions`, `:148-152`).
- **Deriva:** `users.permissions` es una **copia** de `ROLES[role].permissions` en el instante del alta (`s2-users.ts:124`). Cambiar el catálogo en código no cambia lo que un usuario ya creado puede hacer. `users:manage` está declarado RESERVADO precisamente por esto (`src/auth/roles.ts:61`).

**Escenario de fallo.** Un contador renuncia el 15 de septiembre. El despacho quiere revocarle el acceso. No hay comando, no hay ruta, no hay `UPDATE users` en el árbol: la única salida es `psql` contra la base — que además no deja fila de auditoría, porque nadie inserta una. Un auditor que pida «evidencia de altas, bajas y revisión periódica de accesos» —la pregunta estándar de cualquier programa de auditoría de TI— se lleva la respuesta de que ninguno de los tres actos existe como operación del sistema.

### 6. [NUEVA] · MEDIA-ALTA · Catálogo de cuentas y roles semánticos: cambian el destino del dinero y no dejan rastro

`grep -n "registrarAuditoria\|audit_log" src/services/accounting/account-service.ts src/services/accounting/account-roles-service.ts` → **cero**. Ninguna de las dieciséis funciones exportadas de `account-service.ts` (crear, actualizar, desactivar, reactivar, gobernanza, mapeo al código agrupador del SAT) escribe en la bitácora.

Peor en los roles semánticos: `setAccountRole` (`src/services/accounting/account-roles-service.ts:83-126`) **ni siquiera recibe un `userId`**, y `account_roles` no tiene columnas de autor (`src/database/migrations/015_account_roles.sql:9-25`: sólo `created_at`/`updated_at`). No hay a quién preguntarle.

Y esa tabla gobierna el posteo automático: la leen `src/services/accounting/ar-ap-posting.ts:50` y `src/services/xml-ingestion/pre-registration-service.ts:1178`.

**Escenario de fallo.** Alguien corre `mnemosine account role set banco 1120-002` reapuntando el rol `banco` a una cuenta de gastos. A partir de ese instante cada pago a proveedor y cada REP ingerido abonan la cuenta equivocada. El error se descubre en el cierre, tres semanas y ochocientos asientos después. La pregunta del auditor —«¿quién lo cambió, cuándo y con qué autorización?»— no tiene respuesta posible: `account_roles` sobrescribe la fila con `UPDATE` (`:107-111`) y no existe registro del valor anterior en ninguna parte. Es la combinación tóxica «cambio de catálogo + posteo» sin vigilancia **y** sin evidencia.

### 7. [NUEVA] · MEDIA · La bitácora no puede decir «desde dónde» ni «con qué autorización» en la superficie primaria

`audit_log` declara `ip_address INET`, `user_agent TEXT`, `request_id UUID` y `approver_id UUID` (`src/database/migrations/001_core_schema.sql:465-469`).

- Las tres primeras las llena **sólo** el middleware REST (`src/api/rest/middleware/audit.ts:54-68`). `registrarAuditoria` —el único punto de escritura de todo el motor contable y de toda la terminal— no las incluye en su INSERT (`src/services/audit/audit-log.ts:71-74`).
- `approver_id` **no lo escribe nadie**. `grep -rn "approver_id" src/ tests/ scripts/` devuelve exactamente dos líneas: el DDL y `src/types/index.ts:771`. La columna reservada para «con qué autorización» lleva 47 migraciones vacía.

**Y el único escritor que sí puebla esas columnas lo hace fuera de la transacción y con el error tragado:** `audit.ts:53` usa `query()` (otra conexión del pool), se dispara desde `res.json` cuando la respuesta ya se está enviando (`:46-48`), y termina en `.catch((err) => console.error('Audit log error:', err))` (`:69`). Una mutación REST cuyo renglón de auditoría falle se confirma igual, y el único aviso es una línea en la consola de un proceso que —según `src/utils/logger.ts:50`— sólo escribe a consola.

**Escenario de fallo.** Investigación de un asiento sospechoso de 1,2 M MXN posteado un domingo. El auditor tiene: fecha, `user_id` (auto-declarado, hallazgo 1), acción y valores. No tiene: desde qué máquina, con qué sesión, ni si alguien lo autorizó. No puede distinguir «el contador entró desde la oficina» de «alguien con la llave de la base entró desde fuera».

### 8. [NUEVA] · MEDIA · Un auto-aprobado por política se atribuye en la bitácora a una persona, y la distinción vive en una tabla mutable

`autoApproveDraftByPolicy` resuelve el revisor así (`src/ai/draft-service.ts:539`):

```ts
const reviewer = await resolveReviewer(ctx.tenantId, policy.created_by);
```

y ese `reviewer.userId` es el que llega a `createJournalEntry` y, por tanto, a las dos filas de `audit_log` (`create` y `post`, `src/services/accounting/posting.ts:164-170` y `:196-203`). El marcador de máquina —`policy:<id>`— se escribe **sólo** en `ai_drafts.reviewed_by` (`draft-service.ts:549` vía `reviewedByAs`).

Y `ai_drafts` es una tabla ordinaria: las tres migraciones de inmutabilidad del árbol (`033_audit_log_append_only.sql`, `035_fiscal_credential_log_append_only.sql`, `041_el_mayor_inviolable.sql`) no la alcanzan. `UPDATE ai_drafts SET reviewed_by = 'ana@despacho.mx'` es una sentencia legal para el rol de la aplicación.

**Escenario de fallo.** Auditoría de los asientos que la máquina posteó sola. `audit_log` dice: «usuario Ana creó y posteó el asiento JE-2026-1180, `source_type: ai_draft`». Ana declara que nunca lo vio. Ambas cosas son ciertas: una política que Ana creó meses atrás lo aprobó automáticamente. La **única** columna que distingue «Ana revisó» de «la máquina decidió bajo una política de Ana» es `ai_drafts.reviewed_by`, y esa columna es reescribible. En un sistema AI-first, la línea entre acto humano y acto de máquina es la evidencia más importante que existe, y aquí no está blindada mientras el mayor y la bitácora sí lo están.

### 9. [NUEVA] · MEDIA · Editar un borrador no deja los importes en el rastro

`updateDraftEntry` (`src/services/accounting/journal-entry-service.ts:739-771`) borra y reinserta las líneas (`:741-749`) y luego audita con:

- `oldValues: { description, reference }` — **sin las líneas anteriores**
- `newValues: { …, lines_replaced: patch.lines.length }` — **sólo el conteo**

**Escenario de fallo.** Ana redacta JE-2026-0501 por 12 000 MXN. Antes de postear, corre `entry edit JE-2026-0501 --line 5110-001:debit:1200000 --line 1110-001:credit:1200000`. La bitácora registra `action: 'update'` con `{"lines_replaced": 2}`. El importe anterior, las cuentas anteriores y el importe nuevo no están en ninguna parte. La póliza queda en el mayor por 1,2 M y el rastro de su edición no permite reconstruir de qué venía. La nota del propio código dice que «el rastro temporal de la edición es la fila de auditoría de más abajo» (`:733-734`) — la fila existe, el contenido no.

### 10. [NUEVA] · BAJA-MEDIA · `xml_hash` se guarda y nunca se re-verifica

`xml_documents` guarda `xml_content` y `xml_hash` (`005_xml_ingestion.sql:62-63`). Las dos únicas lecturas del hash en todo el árbol son de-duplicación: `src/ai/ingest-service.ts:657` y `src/services/xml-ingestion/pre-registration-service.ts:96`, ambas `WHERE entity_id = $1 AND (cfdi_uuid = $2 OR xml_hash = $3)`. **Nada recalcula el SHA de `xml_content` para contrastarlo con la columna.**

**Escenario de fallo.** Un auditor pregunta «¿cómo sabes que el XML que me enseñas es el que recibiste del PAC?». El sistema tiene la respuesta guardada y no tiene el comando que la pronuncie. Y `xml_documents` no está protegida por ningún disparador append-only: un `UPDATE xml_documents SET xml_content = …` desde el rol de la aplicación no rompe nada visible, porque el hash sólo se usa para no duplicar. Cierre barato: un `--check xml-hash` en `ledger check`.

### 11. [NUEVA] · MEDIA · No existe límite de autorización por monto para ningún actor humano

`grep` de `max_monto|maxMonto|approval_limit|authorization_limit` sobre `src/services/` y `src/api/` deja **un solo** límite monetario en todo el sistema: `ingest_auto_post_max_monto` (`src/services/policy/pending-catalog.ts:357`), que gobierna a la máquina.

Ninguna póliza, ningún pago a proveedor, ninguna nota de crédito tiene tope por monto, por usuario o por tipo. `bills:approve` es booleano: aprueba 500 MXN igual que 5 000 000. El único control por importe del producto vigila al agente; el humano no tiene ninguno.

**Escenario de fallo.** El `revisor` —cuyo rol se describe como «Aprueba borradores y responde dudas; no configura» (`src/auth/roles.ts:130`)— tiene `bills:approve` y `journal_entries:post`. Aprueba y postea sin techo. La matriz de autorizaciones que cualquier manual de control interno pide (quién autoriza hasta cuánto) no tiene dónde vivir. **Nota de la regla (a):** cuando esto se construya, el umbral es una bifurcación de criterio y va al panel con su lector en el mismo commit, no a un `.json`.

### 12. [NUEVA] · MEDIA · La cadena del peso recibido pasa por una tabla de staging

Para el CFDI **emitido** la cadena es directa: `invoices.cfdi_uuid` existe (`002_ap_ar_schema.sql:221`, índice en `:245`) y `invoices.journal_entry_id` cierra el otro extremo.

Para el CFDI **recibido** —el que sostiene la deducción y el IVA acreditable, o sea el peso que un auditor fiscal mexicano persigue— **`bills` no tiene `cfdi_uuid` ni `xml_document_id`** (tabla completa: `002_ap_ar_schema.sql:49-83`). El asiento apunta al bill (`sourceType:'bill'`, `pre-registration-service.ts:1076`), el bill apunta al asiento (`:1080`), y el único puente hasta el XML es `pre_registrations.bill_id` (`005_xml_ingestion.sql:228`) — una tabla que su propio encabezado llama «(Staging)» (`005:140`), sin unicidad sobre `bill_id`.

**Escenario de fallo.** El auditor toma el asiento JE-2026-0803 por 92 800 MXN con 12 800 de IVA acreditable y pide el CFDI que lo respalda. La cadena es: asiento → `source_id` → bill → **búsqueda inversa** en una tabla de staging → `xml_document_id` → XML. Existe una sola consulta que la recorre (`src/services/ap/bill-service.ts:206-213`, tras `opts.includeCfdi`), y el propio código advierte que un bill capturado a mano no tiene ese eslabón. Si alguien alguna vez purga el staging —lo normal con una tabla llamada staging— la cadena se corta y **no es reconstruible**, porque el UUID fiscal no vive en ninguna tabla del ciclo de compras. El siguiente tramo, del reporte a la declaración, no se puede evaluar: no hay declaración (`grep -il "diot|declaracion|declaration"` sobre `src/` no arroja ningún servicio de presentación) — **no verificado más allá de su inexistencia**.

---

### Re-medición de la auditoría II en esta lente

### 13. [II-SIGUE-VIVA] · ALTA · B10 — la bitácora sigue sin superficie de lectura

`practicas-ledger.md:130-132` la dio por «MUTÓ: cerrada la escritura, abierta la lectura». Sigue exactamente igual en `61379d0`: `audit:read` continúa en `RESERVADOS` con la razón escrita —«la bitácora no tiene ruta de consulta; hoy se lee por SQL»— (`src/auth/roles.ts:63`), y no hay `audit-command.ts` en `src/cli/`.

**Lo que agrego.** El rol `auditor` **existe**, está definido como «Sólo lectura, incluida la bitácora» y se le concede `audit:read` (`src/auth/roles.ts:136-142`). Es decir: el sistema tiene un rol diseñado para el auditor externo cuyo permiso distintivo no abre ninguna puerta. El único acceso posible es `psql` con credenciales de base — y `mnemosine_app` tiene `SELECT, INSERT, UPDATE, DELETE` sobre todo lo que no sean las dos bitácoras blindadas (`scripts/provision-roles.sql:73`). **Darle acceso a un auditor externo hoy significa darle credenciales de escritura sobre los libros.**

### 14. [II-SIGUE-VIVA] · ALTA · B9 — retención documental (CFF art. 30)

`practicas-ledger.md:126-128`. Confirmado sin cambio: `004_partitioning_and_views.sql:10-11` sigue prometiendo particionado en un comentario y creando sólo índices; no hay política de cinco años ni la purga auditada que la 033 se reservó (`033:23-25`). Sumado a que no existe respaldo (tema 4 de la II), lo que hay es: conservación obligatoria por ley, inmutabilidad reforzada por disparador, y ningún mecanismo ni para garantizar los cinco años ni para recuperar si se pierden.

### 15. [II-SIGUE-VIVA] · MEDIA-ALTA · instrumento-ii #24(b) — completitud de la bitácora, ahora con los huecos nombrados

`instrumento-ii.md:77` pedía «muestreo de completitud del `audit_log` — hay criterios de que la bitácora es inmutable y de que el posteo escribe en ella, ninguno de que el % de mutaciones registradas sea 100». Sigue viva, y esta lente le pone los nombres concretos:

| Acto de dinero o de control | ¿Fila en `audit_log`? | Evidencia |
|---|---|---|
| Crear / postear / reversar / anular póliza | ✅ | `posting.ts:164,196,351,552,669` |
| Registrar pago a proveedor | ✅ | `payment-service.ts:296,437` |
| Aprobar factura de proveedor | ✅ | `bill-service.ts:534` |
| Cerrar / reabrir periodo | ✅ | `period-close.ts:238,333`; `fiscal-calendar-service.ts:260,305` |
| **Alta de proveedor** | ❌ | `vendor-service.ts:399-442` (hallazgo 4) |
| **Alta / promoción de usuario** | ❌ | `s2-users.ts:116`; `provisioning.ts:120` (hallazgo 5) |
| **Alta / cambio / baja de cuenta contable** | ❌ | `account-service.ts` completo (hallazgo 6) |
| **Reapuntar un rol semántico de cuenta** | ❌ | `account-roles-service.ts:83-126` (hallazgo 6) |
| **Aprobar / rechazar un borrador de IA** | ❌ (sólo el asiento derivado) | `draft-service.ts:415-421` (hallazgo 8) |

`checkAuditTrail` (R3) sólo vigila la primera fila de la tabla. Las cinco últimas nadie las mide.

### 16. [II-EXAGERADA] · El maker-checker no «cumple la regla de la casa al pie de la letra»

`practicas-ledger.md:16` y `maestro-vs-codigo.md:27` (F4) lo declararon impecable: panel + lector en el motor + huérfano pagado + dos criterios. Las **piezas** están, y bien puestas. La **conducta** falla por tres flancos, ninguno de los cuales la II midió: la rama `autoPost` no consulta la política (hallazgo 2), la identidad que la política compara es auto-declarada (hallazgo 1), y el detector de acumulación de permisos que la acompaña no puede disparar su regla alta ni ve el comodín (hallazgo 3). La II midió forma; esta lente midió conducta y ejecutó el detector. **La calificación honesta no es «cerrado» sino «cerrada la puerta principal, abiertas dos laterales».**

### 17. [II-CERRADA] · Confirmada — PII en claro en `audit_log`

`producto-y-operacion.md:164` la dio por cerrada. Verificado en este árbol: `src/api/rest/middleware/audit.ts:20-39` mantiene la lista de veinte campos y la redacción **recursiva** a cualquier profundidad, incluida dentro de arreglos (`:32`). Sigue cerrada. (El defecto que le queda a ese middleware es otro y es el hallazgo 7: escribe fuera de transacción y se traga el error.)

---

## RECOMENDACIONES

Ordenadas por lo que un auditor externo tumbaría primero.

**A · (S) · Cerrar la rama `autoPost` y arreglar el criterio que la escondía.** Extraer la comprobación de `segregacion_de_funciones` de `posting.ts:317-333` a una función privada e invocarla también en `posting.ts:172` antes del `UPDATE ... status='posted'`. En el **mismo commit**, cambiar `criterios.ts:672-674` para que evalúe el archivo completo y exija la llamada en **ambas** ramas, con su mutante declarado (la regla (c): mutar cada rama por separado y ver rojo). Es la corrección más barata del informe y la que devuelve el sentido a un verde que hoy miente. **Tramo destino: inmediato / F01-bis.**

**B · (S) · Reparar `SOD_RULES` y hacer que el comodín cuente.** Sustituir `['vendors:create','vendors:update']` por los permisos que las rutas de proveedor sí exigen —hoy `bills:create`— o, mejor, crear `vendors:create`/`vendors:update` en `PERMISSIONS`, exigirlos en `vendors.ts:93,109` y repartirlos entre roles; el censo de `tests/auth/roles.spec.ts` ya obliga a que ambas listas cuadren. Y en `checkSoDViolations` (`auth.ts:312-323`) expandir `'*'` al universo de permisos antes de evaluar, para que `owner` deje de salir limpio. Acompañarlo de una prueba que afirme que **cada** regla se dispara con algún conjunto alcanzable de permisos —una regla que ningún rol pueda encender es una regla muerta por definición. **Tramo destino: inmediato / F01-bis.**

**C · (M) · Autenticar al actor de la terminal, o decir en voz alta que no lo está.** Dos caminos honestos y ninguno es no hacer nada. (i) Que `--user` exija una credencial: sesión local con expiración (`mnemosine login`), o al menos verificación del `password_hash` que `users` ya guarda (`s2-users.ts:114`). (ii) Si se decide que la terminal es una consola de operador de confianza, entonces **el maker-checker no puede vivir en ella**: la política `segregacion_de_funciones = 'exigir'` debe declarar en su `impact` que sólo muerde sobre la superficie autenticada, y `doctor` debe emitir `warn` cuando la política esté en `'exigir'` y la superficie CLI esté habilitada. Un control que se cree efectivo y no lo es, es peor que no tenerlo. **Tramo destino: fase 1 — es prerequisito de cualquier despacho de más de una persona.**

**D · (M) · El ciclo de vida del usuario, completo y auditado.** `mnemosine user list|grant|revoke|disable`, cada uno con `registrarAuditoria` (`entity_type: 'users'`, con `old_values`/`new_values` de roles y permisos) y con `--reason` en `disable`. Quitar el `ON CONFLICT DO UPDATE SET roles, permissions` de `s2-users.ts:117-120`: el alta crea, la promoción es su propio comando. Saca `users:manage` de `RESERVADOS` (`roles.ts:61`). Y regenerar `users.permissions` desde `ROLES` al cambiar el rol, para que la deriva no se acumule. **Tramo destino: fase 1.**

**E · (S) · Poner autor y rastro donde el dinero cambia de destino.** `createVendor` escribe fila `create` (con las columnas bancarias redactadas: reutilizar `redactarSensibles` de `audit.ts:31`). `setAccountRole` recibe `userId` y escribe fila `update` con la cuenta anterior y la nueva. `createAccount`/`updateAccount`/`deactivateAccount`/`setAccountMapping` idem. Cuatro llamadas a una función que ya existe y que ya es transaccional. Cierra la mitad del hallazgo 15. **Tramo destino: inmediato / F01-bis.**

**F · (S) · `mnemosine audit list` y un rol de base de sólo lectura.** El comando que `practicas-ledger.md:166` (R9) ya diseñó —`--entity-type --entity-id --since`, riesgo `lectura`, IA ✓— sobre el molde de `ledger-command.ts`, más `approver_id`/`ip_address` en la proyección para que se vea qué falta. Y un `mnemosine_auditor` en `scripts/provision-roles.sql` (objeto de clúster: **ahí**, nunca en una migración) con `SELECT` y nada más, para que dar acceso a un tercero deje de significar darle escritura. Cierra B10 y le da puerta al rol `auditor` que ya existe. **Tramo destino: F01-bis / F06.**

**G · (S) · Completar la fila de auditoría y dejar de tragarse su error.** Que `EntradaAuditoria` acepte `ipAddress`, `userAgent`, `requestId` y `approverId`, y que `registrarAuditoria` los inserte. Que el middleware REST llame a esa función dentro de la transacción de la ruta —o, mientras eso no sea posible, que su fallo devuelva 500 en lugar de `console.error`. Y escribir `approver_id` en los dos sitios donde hoy hay un aprobador real: `approveBill` (`bill-service.ts:534`) y la aprobación de borrador. **Tramo destino: F01-bis.**

**H · (M) · Blindar la evidencia del acto de la máquina.** Disparador append-only sobre las columnas de veredicto de `ai_drafts` (`status`, `reviewed_by`, `reviewed_at`, `approved_content_hash`) siguiendo el molde de la 033 — una vez escritas, no se reescriben. Y una fila de `audit_log` con `action: 'approve'`, `entity_type: 'ai_drafts'`, cuyo `user_id` sea el humano y cuyo `new_values` diga si la aprobación fue humana o `policy:<id>`. Hoy la frontera humano/máquina es la evidencia más importante del sistema y la única que no está protegida. **Tramo destino: fase 1 — es la auditabilidad de la tesis AI-first.**

**I · (S) · Importes en el rastro de la edición de borradores.** En `journal-entry-service.ts:757-770`, incluir en `oldValues` las líneas leídas bajo el candado y en `newValues` las resueltas. Ya están ambas en memoria (`:739-749`). **Tramo destino: inmediato.**

**J · (M) · El UUID fiscal en el ciclo de compras.** Migración que añada `cfdi_uuid VARCHAR(50)` a `bills` con índice, poblada desde `pre_registrations` (**con contexto de inquilino puesto**: el DML de migración bajo RLS forzada rellena cero filas en silencio — tema 3 de la auditoría II), y que `pre-registration-service.ts:1076` lo escriba en adelante. Deja la cadena asiento→bill→CFDI en una sola consulta y sobreviviendo a cualquier purga del staging. **Tramo destino: fase 1, antes de la DIOT.**

**K · (M) · Límites de autorización por monto, en el panel.** Una clave `autorizacion_monto_maximo_por_rol` (o por usuario) con su lector en `postJournalEntry`, `recordVendorPayment` y `approveBill`, en el **mismo commit** que la clave — regla (a). Por encima del límite, el acto exige una segunda aprobación, no una advertencia. **Tramo destino: fase 2.**

**L · (S) · `ledger check --check xml-hash`.** Recalcular el SHA-256 de `xml_content` y contrastarlo contra `xml_hash`, severidad bloqueante. Convierte una columna decorativa en la prueba de integridad documental que el art. 30 del CFF hace exigible. **Tramo destino: F06.**

---

## Lo que no pude verificar

- **La cadena reporte → declaración.** No hay servicio de presentación en el árbol (`grep -il "diot|declaracion|declaration"` sobre `src/` no devuelve ningún módulo de generación de declaraciones), así que el último tramo del recorrido del peso no tiene código que auditar. Lo que existe es su ausencia; el comportamiento, **no verificado**.
- **Conducta en base viva.** Los hallazgos 1, 2, 4, 5 y 6 se establecieron por lectura del fuente y —el 3— por ejecución de `checkSoDViolations`. No se levantó Postgres, así que no se ejecutó `entry post --user`, ni un `POST /v1/journal-entries {"auto_post":true}` contra el motor real. La ruta de código está trazada línea por línea y no tiene bifurcaciones intermedias, pero la ejecución de punta a punta queda **no verificada**.
- **RLS sobre `pre_registrations`.** La tabla no declara `tenant_id` (`005_xml_ingestion.sql:143-245`). Si eso tiene consecuencias de aislamiento es materia de la lente multi-inquilino y aquí queda **no verificado**.
