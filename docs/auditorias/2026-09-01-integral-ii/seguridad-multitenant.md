# LENTE 7 — SEGURIDAD, MULTI-INQUILINO Y CREDENCIALES

**Medido contra HEAD = `6e280dd`** (rama `fase-0-1-cli-y-cimientos`), no contra el `a149e62` del encargo: el árbol se movió (merge con `origin/main` + cuatro commits de CodeQL + `6e280dd`). El trabajo sin cometer que mencionaba el encargo (`rate-limiter.ts`, `public-verification.ts`, `redis.ts`, `output.ts`, `index.ts`) **ya está cometido**; lo que hoy está sin cometer es otra cosa (A3: agente) y se trata al final.

Correcciones al encargo, verificadas con `npm run plan:status`: **E1.3 está VERDE** (1/1), no rojo — las políticas de e.firma ya tienen lector. **E2.1 creció de 3/3 a 7/7**.

---

## FORTALEZAS

1. **El arranque falla cerrado de verdad.** `src/database/rls-guard.ts:60-63`: con `config.env === 'production'` y un rol `rolsuper OR rolbypassrls`, el proceso **lanza** en vez de loguear, con válvula explícita `ALLOW_RLS_BYPASS_ROLE=I_UNDERSTAND`. Montado en `src/index.ts:51`, antes de crear el `app`. Criterio ejecutable en `src/plan/criterios.ts:1400-1419`, y el regex `(?<!NO)BYPASSRLS` de `criterios.ts:634-636` demuestra que quien escribió los criterios pensó en el mutante que apaga el bypass.

2. **La verificación pública tiene camino sancionado, y el camino es un paso HACIA ABAJO.** `src/database/consulta-publica.ts:19-30` asume `mnemosine_verifier` con `SET LOCAL ROLE` dentro de la transacción. El rol es `NOLOGIN NOSUPERUSER NOBYPASSRLS` (`scripts/provision-roles.sql:38`), con `GRANT SELECT` de **columnas enumeradas** sobre `legal_entities` — el RFC deliberadamente fuera (`rls-policies.sql:298-299`).

3. **El fix `5c7dc8e` está bien razonado y bien escrito.** `rls-policies.sql:305-336`: una política `TO mnemosine_verifier` aplicaba a `mnemosine_app` por ser MIEMBRO, y siendo PERMISIVA se sumaba con OR a `tenant_isolation` — abriendo todas las filas activas de todos los inquilinos. La corrección exige `current_user = 'mnemosine_verifier'` (el rol ASUMIDO, no el heredado) en los cinco predicados. **CERRADA correctamente**, y detectada por `verify-isolation.sh`, no por lectura.

4. **La bitácora ya no guarda en claro lo que las tablas cifran.** `src/api/rest/middleware/audit.ts:20-39` define 17 campos sensibles y `redactarSensibles` recorre a cualquier profundidad, incluyendo arreglos; `audit.ts:64` lo aplica antes del `JSON.stringify`. La lista es deliberadamente más ancha que lo que hoy se cifra.

5. **La frontera de entidad está DENTRO del SQL en los caminos que la auditoría I señaló.** `customer-service.ts:272` (`findByIdInScope`), `:479-481` (el UPDATE lleva `condicionDeAlcance` en la misma sentencia); `vendor-service.ts:297,484,566` (`requireByIdInScope` con candado y pertenencia en una sola sentencia); `webhook-service.ts:48` (`AND tenant_id = $2`), `:184` y `:200` (join a `webhook_subscriptions.tenant_id`). Con criterio ejecutable: `criterios.ts:1424`.

6. **Webhooks salientes endurecidos en los tres frentes.** SSRF con doble validación — sintáctica al crear (`webhook-service.ts:30` → `url-guard.ts:59-82`) y **resuelta por DNS** antes de conectar (`webhook-service.ts:119` → `url-guard.ts:89-105`), con CGNAT, link-local/metadata, y las dos grafías de IPv4-mapeada (`url-guard.ts:44-51`); la ventana TOCTOU de re-binding **se anota como límite en vez de fingirse cerrada** (`url-guard.ts:17-20`). Replay: la firma cubre `timestamp.body` en formato `t=…,v1=…` (`webhook-service.ts:113`) con HMAC-SHA256 real (`utils/encryption.ts:37-41`). Secreto: columnas enumeradas en `listWebhooks` (`webhook-service.ts:59-63`), sale sólo en el 201.

7. **Rate limiting: sin Redis tampoco hay barra libre.** `redis.ts:212` y `:226-228` degradan a `limiteEnMemoria` en ambos caminos; `redis.ts:176-180` poda para que claves únicas por IP no crezcan sin tope. El comentario `redis.ts:200-205` es honesto hasta el punto de admitir que la rama que corrigió estaba muerta.

8. **e.firma: E1.3 pagada.** `fiscal-credentials/service.ts:259-262` lee `efirma_max_accesos_diarios` del panel y combina con `Math.min` (el techo más estricto gana); `:264-278` lee `efirma_accion_anomalia`, y **sólo el literal `'alertar'` deja continuar** — `'bloquear_fuera_horario'` con la ventana horaria inexistente NIEGA. El lado seguro por omisión, y la anomalía queda como fila `denied` informativa.

9. **El job de aislamiento de CI corre con el rol correcto.** `.github/workflows/ci.yml:156` conecta la aplicación como `mnemosine_app`, aprovisiona roles con `provision-roles.sql`, siembra y ejecuta `verify-isolation.sh` de punta a punta.

10. **Cierres menores todos verificados**: `jwt.verify(..., { algorithms: ['HS256'] })` en `auth.ts:112`; `cors({ origin: … })` explícito por entorno con producción cerrada por omisión (`index.ts:90-94`); `setTenantSchema` **borrada** (`connection.ts:198` sólo conserva la lápida); `tests/fixtures/certs/README.md` afirma el material sintético y da el generador OpenSSL.

11. **Inyección de prompt de primer orden cubierta en tres superficies**: `scanImportedText` sobre campos CFDI (`ingest-service.ts:505,534,567`), sobre el cuerpo crudo del webhook (`routes/ai-webhooks.ts:99`) y en el reader-agent (`reader-agent.ts:114`); `ai/skills/trust-scanner.ts:1-30` trata un `SKILL.md` como código no confiable con cinco clases de amenaza, incluidos los delimitadores `<<< >>>` que usan los propios prompts.

12. **Ninguna herramienta del agente alcanza el mayor** (regla de la casa b): `git show HEAD:src/ai/tools/ledger-tools.ts` sólo declara `search_journal_entries` y `get_journal_entry`. Cero escritores.

---

## BRECHAS

### 1. (ALTA · NUEVA) El DML de las migraciones corre bajo RLS forzada sin contexto: rellena CERO filas, en silencio. Y el repo ya lo sabía desde la 026.

La cadena, toda verificada:

- `rls-policies.sql:54-55` aplica `ENABLE` + **`FORCE ROW LEVEL SECURITY`** a toda tabla con `tenant_id`/`entity_id`; el predicado es `tenant_id = public.app_current_tenant()` (`:57-60`).
- `provision-roles.sql:59-60`: `mnemosine_owner` es **`NOBYPASSRLS`** — la línea que, en palabras del propio archivo, «hace que las políticas signifiquen algo».
- `migrate.ts:11` conecta con `config.database.migrationUrl` (el dueño) y `:83-90` ejecuta el `.sql` **sin fijar `app.current_tenant` nunca**.
- Por tanto `app_current_tenant()` es NULL (`014_rls_tenant_isolation.sql:32-34`) y todo SELECT/UPDATE/DELETE de una migración lee cero filas.

**El repo aprendió esto en la 026.** Su encabezado literal (`026_reseed_entity_sequences.sql:2-4`): *«025's seed ran as the schema owner with no tenant context and FORCE RLS filtered every source row: it seeded nothing»*. La 025 y la 026 escriben el patrón correcto — `FOR t IN SELECT id FROM tenants LOOP; PERFORM set_config('app.current_tenant', t.id::text, true); …` (`025_ledger_hardening.sql:30-35`, `026:12-17`).

**Y tres migraciones posteriores lo ignoraron.** `grep -c "set_config('app.current_tenant'" ` devuelve **0** en las tres:

- **`040_el_secreto_que_el_compromiso_revelaba.sql:26,31`** — dos `UPDATE blockchain_attestations` que purgan `range_proof`/`zkverify_proof` de las filas donde el placeholder escribió `_test_value` y `_test_bf`, es decir **el importe y el factor para abrir el compromiso**. Es una **purga de seguridad** que no purgó nada.
- **`043_la_serie_del_folio_por_ejercicio.sql:26-74`** — las cinco siembras de `entity_sequences` desde los folios reales. Es el incidente ya conocido (colisión de folios), y es **literalmente la repetición del fallo de la 025 sobre la misma tabla**, 18 migraciones después.
- **`037_etiquetado_que_encarece.sql:48-53,77-85,86-94`** — `UPDATE bills SET cfdi_uuid`, `UPDATE vendors SET related_entity_id`, `UPDATE customers SET related_entity_id`. El amarre intercompañía que la propia migración justifica como «exacto, no heurístico» no se escribió.

**Probado empíricamente**, no deducido. Reproduje la forma exacta de la 040 (tabla con `tenant_id`, `FORCE ROW LEVEL SECURITY`, política `tenant_isolation` copiada de `rls-policies.sql:57-60`, dueño `NOSUPERUSER NOBYPASSRLS`) y corrí su SQL literal:

```
UPDATE 0     ← como el dueño, sin contexto (lo que hace migrate.ts)
UPDATE 1     ← el mismo SQL, mismo rol, con set_config('app.current_tenant', …)
```

La fila con `{"v":"_test_value","bf":"_test_bf"}` sobrevivió intacta a la purga.

**Severidad honesta.** La fuga de la 040 persiste **en reposo** (base de datos, respaldos, réplicas), no en la superficie pública: la 034 declaró `is_simulated BOOLEAN NOT NULL DEFAULT true` (`034_atestaciones_simuladas.sql:21-23`) sin relleno, y tanto la política del verificador (`rls-policies.sql:331`, `is_simulated = false`) como el router (`public-verification.ts:102-105`) rechazan lo simulado. Esa defensa en profundidad es real y hay que darle crédito. Pero el estado creído («la 040 purgó las filas históricas», `criterios.ts:465-466`) no es el estado que hay.

**No verificado**: si la base desplegada de este usuario tiene efectivamente filas sin purgar. Probé el **mecanismo**, no ese despliegue. Hay una tarea aparte corriendo sobre esto; a HEAD, el árbol cometido no contiene ninguna guarda, ninguna corrección y ninguna migración de reparación.

### 2. (ALTA · NUEVA) Los criterios que vigilan esos rellenos son verdes de TEXTO, no de efecto — verdes falsos en los términos de la casa.

- `criterios.ts:470-479` (la 040): comprueba que el archivo exista y que `/range_proof\s*=\s*NULL/` y `/zkverify_proof\s*=\s*NULL/` **aparezcan en el texto**. Nunca que la purga moviera una fila, ni que queden cero filas con la fuga. Verde hoy, con la fuga intacta.
- `criterios.ts:610-616` (la 043): cuenta que haya `>= 5` ocurrencias de `INSERT INTO entity_sequences` y que exista `GREATEST`. Verde hoy, con los contadores en cero.
- La 037 no tiene criterio alguno (`grep "cfdi_uuid\|related_entity_id" criterios.ts` → sólo referencias a la 046).

Esto viola directamente la regla (c) —los criterios se verifican por MUTACIÓN en ambas direcciones— y la (d): un criterio que sólo lee el `.sql` no puede distinguir «la purga corrió» de «la purga no tocó nada», así que su verde no informa.

### 3. (MEDIA · NUEVA) CI no puede detectar esta clase: la enmascara por partida doble.

`.github/workflows/ci.yml:158` y `:122` corren las migraciones como **`postgres`, superusuario** — que ignora RLS incondicionalmente. Y lo hacen sobre una **base fresca**, donde `rls-policies.sql` sólo se aplica en el `finally` (`migrate.ts:109-113`), *después* de que todas las migraciones ya pasaron. El único escenario donde el fallo ocurre —actualización incremental de una base ya endurecida, migrando como `mnemosine_owner`— no se ejercita en ningún job. Por eso el incidente de la 043 apareció en un despliegue y no en la suite.

Nótese la asimetría: el job de aislamiento fue cuidadoso en conectar la **aplicación** como `mnemosine_app` (`ci.yml:156`, con un comentario que explica exactamente por qué), y no aplicó el mismo cuidado al **migrador**.

### 4. (MEDIA · NUEVA) Cadena de suministro sin puerta, con dos altas en rutas que este sistema pisa.

`npm audit --omit=dev` sobre HEAD: **14 vulnerabilidades en dependencias de producción (9 moderadas, 5 altas)**. Las dos que importan por dónde viven:

- **`@xmldom/xmldom@0.8.12` (alta)** — inyección de nodos XML por comentarios, processing instructions y DocumentType sin validar, más recursión no controlada (DoS). Llega por `soap@1.8.0 → xml-crypto@6.1.2`, es decir **la ruta de firma/verificación XML**, en un sistema cuyo negocio es ingerir CFDI de terceros.
- **`axios@1.15.0` (alta)** — entre ~29 avisos, `GHSA-m7pr-hjqh-92cm` (**bypass de `no_proxy` por alias de IP → SSRF**) y varios de contaminación de prototipo con secuestro de petición. Llega por `soap@1.8.0`. Es notable que el repo escribiera un `url-guard.ts` cuidadoso contra SSRF para sus webhooks salientes mientras la biblioteca del cliente SAT arrastra un SSRF conocido.

`.github/workflows/ci.yml` **no tiene ningún paso de `npm audit`** (verificado por grep sobre el archivo completo). `.github/dependabot.yml` existe y está bien pensado (agrupa para que alguien mire los PR), pero es semanal y agrupa minor+patch — ninguna de estas dos se arregla con un parche agrupado.

### 5. (BAJA · NUEVA) El mensaje de remediación de la consulta pública manda al operador a un bucle que nunca la arregla.

`src/database/consulta-publica.ts:24-27`, en el `catch` de `SET LOCAL ROLE mnemosine_verifier`: *«El rol lo crea la migración 042; si el rol de conexión no es miembro, corre las migraciones (el GRANT viaja ahí)»*.

Ninguna migración crea ese rol: `grep -rn "CREATE ROLE" src/database/migrations/*.sql` → **vacío**, y la 042 no menciona `verifier`. Lo crea `scripts/provision-roles.sql:37-41`, que **no** está en la cadena de migraciones (`ci.yml:171-176` lo corre como paso aparte, precisamente porque los roles son objetos de clúster). El propio `rls-policies.sql:281-282,292` lo dice bien («lo crea provision-roles.sql»); sólo el mensaje de error, que es lo único que el operador va a leer a las 3 de la mañana en la superficie no autenticada, apunta al lugar equivocado.

### 6. (BAJA · NUEVA) 017 y 018 comparten la clase, pero fallan RUIDOSAMENTE.

`017_fix_policy_unique.sql:14` (`DELETE FROM policy_decisions`) y `018_fix_account_roles_unique.sql:16` (`DELETE FROM account_roles`) son deduplicaciones previas a un índice único, sin contexto de inquilino. Borran cero filas; si había duplicados, el `CREATE UNIQUE INDEX` posterior revienta y la migración aborta. Es el modo de fallo **bueno** (bloquea la actualización en vez de mentir), y por eso van en BAJA — pero pertenecen al mismo inventario y se arreglan con la misma guarda.

### 7. (SIGUE-ABIERTA · brecha 3 de la auditoría I · MUTÓ) GraphQL: las lecturas por id y las mutaciones se cerraron; los cuatro listados y los permisos, no.

Lo cerrado, con crédito: `resolvers/index.ts:48-54` (`alcanceDe`), `:61,87` (`findByIdInScope`), `:192,197` (`requireByIdInScope`), `:168,202,207` (`assertEntityAccess` en mutaciones), y `tenantContext` ya montado en la puerta GraphQL (`index.ts:254`) — lo que cierra la fuga entre INQUILINOS.

Lo que sigue abierto, entre entidades del mismo inquilino: `accounts` (`:64-66`), `journalEntries` (`:90-92`), `invoices` (`:112-114`) y `fiscalPeriods` (`:153-155`) toman `args.entityId` del cliente y construyen `WHERE entity_id = $1` **sin recibir siquiera `ctx`** — no es que se les olvide comprobar: no pueden. Y `grep -c requirePermission resolvers/index.ts` → **0**: sigue sin haber ningún control de permiso en todo el archivo. Mitigado por `GRAPHQL_ENABLED=false` y vigilado por `criterios.ts:1389-1395`, que sólo comprueba que esté apagado.

### 8. (SIGUE-ABIERTA · brecha 8 de la auditoría I · PARCIAL) e.firma: cerrado el panel, abierta la rotación.

E1.3 está pagada (ver Fortaleza 8). Quedan los tres tramos que la auditoría I ya había separado:
- **Sin rotación de `ENCRYPTION_KEY`**: `utils/encryption.ts:8-19` produce `iv:tag:cipher` **sin versión de llave**, así que no hay forma de tener dos llaves vivas durante una rotación — cambiarla vuelve ilegible lo existente.
- **KMS gestionado por el cliente sigue OPCIONAL**: `vault/index.ts:44` pasa `kmsKeyId: process.env.VAULT_KMS_KEY_ID`, y sin él AWS usa la llave por defecto de Secrets Manager.
- **`unattended_access` nace en `true`**: `fiscal-credentials/service.ts:183` (`input.unattendedAccess ?? true`). Sigue sin decisión escrita ni volteo.

### 9. (SIGUE-ABIERTA · brecha 10 de la auditoría I · RESIDUAL) `/metrics` sin autenticación.

`index.ts:114-115` monta `/metrics` antes de `authenticate`, delegando en un allowlist de IP del balanceador que este repo no controla ni verifica. `cors` y `setTenantSchema` de esa misma brecha sí cerraron.

### 10. (BAJA · residuales de brechas cerradas) Dos flecos que la corrección dejó.

- `rate-limiter.ts:59`: el `.catch(() => next())` sigue ahí. `checkRateLimit` ya no rechaza por su propio camino (`redis.ts:213-229` atrapa todo), pero si `getRedis()` lanzara síncronamente, la promesa se rechaza y **el limitador vuelve a abrir**. La corrección del fail-open vive en `redis.ts`; este archivo conserva la salida de emergencia que la contradice.
- `webhook-service.ts:37-40`: el `secret` se INSERTA **en claro**. Los listados ya no lo devuelven (brecha 7c cerrada), pero sigue legible para cualquiera con acceso a la tabla o a un respaldo — la recomendación 6 de la auditoría I lo sugería como opcional y no se tomó, mientras `vendor-service` sí cifra la CLABE.

---

## Trabajo SIN COMETER (no cuenta en el dictamen; mencionado aparte)

`src/ai/untrusted.ts` (nuevo, sin cometer) cerraría un hueco que **este informe no cuenta como brecha porque su corrección ya está escrita**: la **inyección de prompt de SEGUNDO orden**. Su propio encabezado lo describe con precisión — el primer orden existía, pero el texto hostil vuelve cuando una herramienta lo relee (la descripción del asiento generada desde un CFDI, el nombre del proveedor capturado del emisor), había **tres copias privadas** de la neutralización, y las herramientas de búsqueda no envolvían nada. Aporta `neutralizarMarcadores` (`<<<` → `‹‹‹`) y `envolverDatosDeTerceros` con el preámbulo FUERA del bloque marcado, que es la parte que la mayoría de las implementaciones se equivoca.

`src/ai/budget.ts` (sin cometer) pone tope de gasto en `createLlmSession` con `on_exceed: 'block'` por omisión en rutas desatendidas. Es control de abuso, no de aislamiento.

A HEAD cometido, el segundo orden **sigue sin envoltura uniforme**. Lo señalo aquí y no en BRECHAS para no cobrar dos veces por trabajo en curso.

---

## RECOMENDACIONES

1. **(M · tramo R4 propuesto — hoy ningún tramo lo posee) Una guarda estructural para el DML de migración.** Que `migrate.ts` detecte DML sobre tablas con política antes de ejecutarlo, o —más simple y más robusto— que exponga a las migraciones un helper `porCadaInquilino($$ … $$)` que envuelva el bucle de la 026, y que un criterio ejecutable falle si un `.sql` con `INSERT/UPDATE/DELETE` sobre una tabla con `tenant_id`/`entity_id` no lo usa. La corrección estructural importa más que las tres reparaciones: la 026 ya había escrito el patrón correcto y la 043 lo repitió igual 18 migraciones después, lo que demuestra que documentarlo no basta (brecha 1).

2. **(S · R4) Tres migraciones de reparación, idempotentes, con el bucle de la 026** para la 037, la 040 y la 043. Prioridad a la **040**: es la única cuyo contenido es un secreto (el importe y el factor de apertura del compromiso), y a diferencia de las otras dos su daño no se corrige solo con el tiempo. La 043 la puede estar cubriendo la tarea que corre aparte — verificarlo antes de duplicar (brecha 1).

3. **(M · R4) Volver de efecto los dos criterios de texto.** `criterios.ts:470-479` debe consultar la base y exigir cero filas de `blockchain_attestations` con `_test_value` en los blobs; `criterios.ts:610-616` debe exigir que existan contadores anuales para las entidades que tienen folios emitidos. Mientras sólo lean el `.sql`, son verdes que no distinguen «corrió» de «no tocó nada» — exactamente lo que la regla (d) proscribe (brecha 2).

4. **(S · R4) Migrar en CI como `mnemosine_owner`, no como `postgres`.** Cambiar `ci.yml:158` (y `:122`) a un DSN de `mnemosine_owner`, y añadir al job de aislamiento un segundo `npm run migrate` sobre la base **ya endurecida** — es decir, ejercitar la actualización incremental, que es el único escenario donde esta clase se manifiesta. Sin este paso, las recomendaciones 1-3 no tienen quien las vigile (brecha 3).

5. **(S · cimientos) `npm audit --omit=dev --audit-level=high` como paso de CI**, y subir `soap` (o fijar overrides de `axios` y `@xmldom/xmldom`) — `npm audit fix` resuelve ambas sin cambio de ruptura según el propio informe. Un sistema que ingiere XML de terceros no debería llevar un `xmldom` con inyección de nodos conocida (brecha 4).

6. **(S · R2 residual) Corregir el mensaje de `consulta-publica.ts:24-27`** para que diga `scripts/provision-roles.sql`, como ya dice bien `rls-policies.sql:281-282`. Es una línea, y es la única instrucción que verá quien depure la superficie no autenticada (brecha 5).

7. **(S · R2 residual) Quitar el `.catch(() => next())` de `rate-limiter.ts:59`** o hacerlo caer en `limiteEnMemoria`: la decisión «nunca barra libre» ya está tomada en `redis.ts` y este archivo conserva la puerta que la anula (brecha 10a).

8. **(S · R2 residual) Cifrar el `secret` del webhook en reposo** con el `encrypt()` que ya se usa para la CLABE (`webhook-service.ts:37-40`), o declarar por escrito que no se cifra y por qué (brecha 10b).

9. **(M · continuación de E1.3) Versionar el formato de cifrado** a `v1:iv:tag:cipher` en `utils/encryption.ts:8-19` y aceptar el formato viejo al descifrar. Es el requisito previo de cualquier rotación de `ENCRYPTION_KEY`, y hoy no se puede rotar sin perder lo existente. Además: exigir `VAULT_KMS_KEY_ID` en producción (`vault/index.ts:44`) y decidir por escrito el `unattendedAccess ?? true` (`service.ts:183`) — la regla (a) sugiere que «¿esta credencial puede usarse sin humano presente?» es candidata a política del panel, no a valor por omisión en el código (brecha 8).

10. **(S · perímetro) Autenticar `/metrics`** con un token de scrape, o al menos dejar escrito en `index.ts:114` que el allowlist del balanceador es una dependencia de despliegue no verificada por este repo (brecha 9).

11. **(L · ya nombrada) Ejecutar la decisión de GraphQL.** Si se blinda: pasar `ctx` a los cuatro listados y llamar `assertEntityAccess(ctx.user, args.entityId)`, añadir `requirePermission` a todos los resolvers y mover el montaje dentro de `/v1`. Si no, retirarlo — ahora hay control de versiones, que era la razón declarada para no borrarlo (`index.ts:227-229`). El criterio actual sólo vigila que esté apagado, no que esté sano (brecha 7).

12. **(M · R4, cuando lo demás esté) Cometer `src/ai/untrusted.ts`** y unificar en él las tres copias privadas de la neutralización, con un criterio que falle si una herramienta que devuelve texto de tercero no pasa por `envolverDatosDeTerceros` — hoy la envoltura correcta existiría en un archivo y las herramientas seguirían pudiendo saltársela.

---

## VERIFICACIÓN ADVERSARIA DEL HALLAZGO MAYOR

**Hallazgo:** El DML de las migraciones corre bajo RLS forzada sin contexto de inquilino y rellena CERO filas en silencio — probado empíricamente (mismo SQL, mismo rol: `UPDATE 0` sin contexto vs `UPDATE 1` con él) — y alcanza a tres migraciones que el repo cree aplicadas: 040_el_secreto_que_el_compromiso_revelaba.sql:26,31 (una PURGA DE SEGURIDAD que no purgó el importe ni el factor de apertura del compromiso), 043_la_serie_del_folio_por_ejercicio.sql:26-74 y 037_etiquetado_que_encarece.sql:48-94; el patrón correcto ya estaba escrito desde 026_reseed_entity_sequences.sql:2-4, y los criterios que las vigilan (criterios.ts:470-479 y :610-616) sólo comprueban que el texto SQL exista, nunca que haya movido una fila.

**¿Refutado?** No: se sostiene

SE SOSTIENE, y lo reproduje yo mismo. (1) Mecanismo: migrate.ts:11 abre el pool con `config.database.migrationUrl` y nunca hace `set_config('app.current_tenant', ...)`; el rol destinado es mnemosine_owner, NOSUPERUSER NOBYPASSRLS (scripts/provision-roles.sql:26 + docs/auditorias/2026-08-31-integral/seguridad-multitenant.md:4), y rls-policies.sql:54-60 pone ENABLE + FORCE ROW LEVEL SECURITY con predicado `tenant_id = public.app_current_tenant()` (línea 45) o vía legal_entities (líneas 50-51); app_current_tenant() devuelve NULL sin contexto por diseño (014_rls_tenant_isolation.sql:26-42, «Fail-closed»). Prueba propia en una base de usar y tirar, mismo rol NOBYPASSRLS, mismas políticas y mismo SQL de la 040 y de la 037: `UPDATE 0` / `UPDATE 0` sin contexto, `UPDATE 1` / `UPDATE 1` tras `set_config('app.current_tenant', ...)`. blockchain_attestations.tenant_id es NOT NULL (006_blockchain_integration.sql:199), así que ni siquiera hay escapatoria por la rama `OR tenant_id IS NULL` de rls-policies.sql:43. (2) Alcance: exacto. Recorrí las 40+ migraciones; sólo 001, 009, 025, 026, 037, 040 y 043 traen DML, y 001 es pre-RLS y 009 son tax_tables (excluidas a propósito, rls-policies.sql:138). Las tres señaladas son las únicas posteriores a la 026 con DML sobre tablas con inquilino y sin el bucle por inquilino: 040:26 y 040:31, 043:26-74, 037:48, 037:77, 037:86. (3) El patrón correcto ya estaba escrito y con la lección explícita en el comentario: 026_reseed_entity_sequences.sql:2-4 («025's seed ran as the schema owner with no tenant context and FORCE RLS filtered every source row: it seeded nothing») y :7-11 + el bucle :15-16,48. (4) Los criterios sólo miran texto: criterios.ts:470-479 lee la 040 y afirma «la 040 purgó ambos blobs» con dos regex (`/range_proof\s*=\s*NULL/`, `/zkverify_proof\s*=\s*NULL/`); criterios.ts:610-616 cuenta `INSERT INTO entity_sequences` >= 5 y `GREATEST`. Ninguno consulta la base. (5) Ninguna prueba puede cazarlo: tests/integration/global-setup.ts:71-76 migra una base efímera recién creada con la URL de administración. Lo que NO se sostiene tal cual: dos matices que la formulación omite y que cambian dónde muerde y cuánto duele — la precondición (base ya endurecida) y la severidad real de la 040 (fuga en reposo, no servida).

**Formulación corregida:** Formulación corregida: «El DML de las migraciones corre bajo RLS forzada sin contexto de inquilino y rellena CERO filas en silencio — pero SÓLO en una base que YA tenía rls-policies.sql aplicado cuando esas migraciones quedaron pendientes, es decir, toda instalación existente/desplegada. En una base virgen no muerde: migrate.ts corre todas las migraciones en una pasada y aplica rls-policies.sql apenas en el `finally` (migrate.ts:103-118), así que 037/040/043 rellenan bien; también queda enmascarado si MIGRATION_DATABASE_URL apunta a un rol superusuario o BYPASSRLS (config/index.ts:48-51 cae a DATABASE_URL y luego a postgres:postgres). Bajo la configuración documentada y recomendada —MIGRATION_DATABASE_URL = mnemosine_owner, NOBYPASSRLS, dueño de las tablas, FORCE RLS— alcanza a las tres migraciones que el repo cree aplicadas: 040:26,31 (la purga del compromiso no borró ni un blob), 043:26-74 (los contadores anuales no se sembraron desde los folios reales: la serie 2026 arranca en 1 y colisiona con lo emitido — el daño contable más caro de los tres) y 037:48,77,86 (cfdi_uuid y related_entity_id quedaron NULL en todas las filas históricas). Sobre la 040, precisar la severidad: es una fuga EN REPOSO que la migración afirma cerrada, no una exposición viva — public-verification.ts:86-89 enumera columnas y NO devuelve range_proof ni zkverify_proof; el riesgo latente es que rls-policies.sql:300 concede `GRANT SELECT ON blockchain_attestations` (tabla entera, sin enumerar columnas, a diferencia del GRANT de legal_entities en :298-299) al rol de la verificación pública, de modo que un `SELECT *` futuro sí los serviría. Y sobre la vigilancia, corregir al alza: no es que los criterios comprueben mal las tres, es que sólo DOS están vigiladas —criterios.ts:470-479 (040) y :610-616 (043), ambas por regex sobre el texto del .sql— y la 037 no aparece ni una vez en criterios.ts. El patrón correcto ya estaba escrito desde 026_reseed_entity_sequences.sql:2-4,15-16,48, con la lección en su propio comentario: es una reincidencia, no un descubrimiento.»

