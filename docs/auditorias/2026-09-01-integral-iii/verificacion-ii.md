# LENTE 1 · ¿Resiste la auditoría II?

**Árbol:** `/private/tmp/…-aud` en `61379d0` (= `cfe40c6` + los dos commits de documentación del PR 19).
**Método:** re-verificación una por una de las nueve titulares, con ejecución real donde el encargo la
pidió (criterio mutado, línea literal de CI, `resolverUmbralesConPanel`, `costo-por-fila.ts`).
**Veredicto agregado: 9 SIGUEN VIVAS · 0 CERRADAS · 0 tumbadas.** Tres llevan un matiz de medición
que corrijo; ninguno cambia la sustancia.

---

## LO QUE RESISTE (auditoría a favor)

No todo lo que la II tocó es hueco, y conviene decirlo antes que lo demás:

- **La compuerta de la evidencia existe y cobra de verdad.** `src/services/policy/policy-service.ts:172-186`
  bloquea `ingest_auto_post='on'` contra `FLOOR_SOMBRA_DIAS/ACUERDO/VEREDICTOS` (`src/ai/floor.ts:69-71`),
  y está puesta en `resolvePolicy` —no en el CLI— justo porque tiene dos llamadores. El comentario
  explica el porqué. La II fue justa: es la única puerta con peaje, y el peaje es real.
- **`declareRisk` sí revienta en el arranque.** `src/cli/kernel/risk.ts:93-108`: `agent:true` con riesgo
  `irreversible`/`externo`, o `escritura` sin `draftOnly`, lanza al registrar el comando. La afirmación
  del Plan Maestro v3 §7 sobre esto es cierta y verificada. (Su alcance es la hoja del CLI, no
  `src/ai/tools/` — ver hallazgo 8.)
- **`gateMutation` falla cerrado** (`src/cli/kernel/risk.ts:193-200`): una hoja que muta sin declaración
  rompe en el primer uso. Es el patrón correcto.
- **El trinquete tiene dos cerrojos honestos que la II no le acreditó:** `--exigir` con un paquete
  inexistente sale en rojo (`src/plan/status.ts:219-227`) y un criterio bloqueado por entorno se
  **muestra** aunque no se exija (`status.ts:116-135, 157-158`). No es un instrumento perezoso: es un
  instrumento con la granularidad equivocada, que es otra cosa.
- **El criterio de `necesita: 'base-de-datos'` es auto-consciente.** `src/plan/criterios.ts:395-397`
  dice literalmente que un verde que no reporte cuántos sellos inspeccionó «sería verde por no mirar».
  La II lo trató peor de lo que merece (ver matiz en el hallazgo 1).
- **La reapertura del trinquete es honesta.** `.github/workflows/ci.yml:70-89` documenta por qué E1.2,
  E4.1 y E3.2 salieron de `--exigir`, con la causa escrita. Regla de la casa (d) cumplida.
- **Los tres PR fusionados desde `689458a` son correcciones legítimas**, sólo que de otra procedencia
  (ver §«Qué cerraron los PR fusionados»).

---

## HALLAZGOS

### 1 · [II-SIGUE-VIVA] `FLUJOS_CERRADOS` sigue vacío y el meta-criterio de espejos sigue sin existir · ALTA

`src/plan/criterios.ts:243-245`:

```
const FLUJOS_CERRADOS: Record<string, string> = {
  // 'F01': 'docs/auditorias/F01.md',
};
```

`Object.entries({})` da `[]`, `sinRegistro.length === 0` siempre, y el criterio devuelve
`ok('0 flujo(s) cerrados con registro')` (`:249-255`). Lo leí entero y lo ejecuté: `E0.0` sale
4/5 y el único rojo es el artefacto de `.git`, no éste. La **única** comprobación viva del criterio
es `existe('docs/auditorias/2026-08-31-integral/README.md')` (`:246`) — que la carpeta de la
auditoría **I** siga en su sitio. Nótese que la II se archivó en `2026-09-01-integral-ii/` y el
criterio **ni la mira**: el registro que vigila es el de hace dos semanas.

Meta-criterio de espejos: `tests/plan/` tiene 351 líneas en dos archivos
(`criterios.spec.ts` 103, `status.spec.ts` 248). Leí `criterios.spec.ts` completo: prueba
`sinComentarios`, `fuentes`, `consumidoresDe` y que todo criterio traiga detalle — **no hay un solo
mutante que neutralice una conducta y afirme el rojo**. Eso es violación directa de la regla de la
casa (c) («los criterios se verifican por MUTACIÓN en ambas direcciones»), y el propio Plan Maestro v3
§7 lo declara pendiente hasta S2.

**Escenario de fallo:** alguien declara F03 cerrado sin auditarlo, lo mete a `--exigir`, y la CI
sale verde. Es exactamente lo que ya pasó con F01, F02 y A3–A4.

**Matiz — [II-EXAGERADA en el detalle]:** la II escribió que el criterio de `necesita: 'base-de-datos'`
«con base vacía devuelve verde por no mirar». Son dos caminos distintos y sólo uno es verde:
sin base alcanzable devuelve **no-evaluable** (`criterios.ts:435-438`, y así salió en mi corrida:
`? … no hay base de datos accesible`); con base alcanzable y vacía sí devuelve `ok` (`:449-453`).
En el job `plan` de CI (`ci.yml:61-100`, sin bloque `services:`) el camino real es el primero, así
que el criterio **nunca ha juzgado nada en CI** — la conclusión de la II se sostiene, su redacción no.

---

### 2 · [II-SIGUE-VIVA] La documentación del agente sigue caducada, y no está caducada: está **equivocada** · ALTA

`src/ai/docs/mexico-cfdi.md` no se toca desde el commit fundacional (`git log --oneline -- ` sobre él
devuelve un solo commit: `4eeee63 Línea base del sistema contable mnemosine`). Sus tres renglones
críticos siguen intactos:

- `:4` — «PUE (single-payment) → the expense is **credited against BANKS**».
- `:5` — «16% input VAT goes as a separate debit», sin distinguir PPD.
- `:10` — «Human: POST /v1/invoices/:id/cfdi/stamp and **/cfdi/cancel** (SAT reasons 01-04)».

Los tres se contradicen con el propio árbol, **en el mismo commit**:

| El doc que lee el agente | Lo que el código hace |
|---|---|
| `mexico-cfdi.md:4` «credited against BANKS» | `src/services/xml-ingestion/cfdi-taxonomy.ts:166-167`: «Credited to vendors and **not** to banks: … Crediting banks directly would **double the outflow** when the bank movement arrives.» |
| `mexico-cfdi.md:5` IVA acreditable sin mirar PPD | `src/services/accounting/iva-ppd-reclass.ts:8-14` existe **exactamente** para reparar ese asiento: «Bajo PPD el IVA no es acreditable hasta que se paga… lo ya registrado sobrestima el IVA acreditable de cada periodo.» |
| `mexico-cfdi.md:10` promete `/cfdi/cancel` | `src/api/rest/routes/invoices.ts:321` lanza `NotImplementedError` sin condición. |

La disposición está escrita y firmada: `docs/plan-cierre-brechas.md:8291` dice que `E1.2-i` fue
«Absorbida por F02; F02 corrió y el…»; y `:2952-2982` detalla la partida completa, incluyendo el
test de gobernanza `tests/ai/docs-mexico-cfdi.spec.ts` y el criterio de aceptación
`grep -n 'credited against BANKS' … devuelve cero líneas`. Hoy `grep -c` devuelve **1** y
`tests/ai/docs-mexico-cfdi.spec.ts` **no existe**.

**Escenario de fallo:** el agente clasifica un CFDI recibido PUE, lee su propio `mexico-cfdi.md`,
acredita contra BANCOS, y cuando el movimiento bancario entra por conciliación la salida se duplica —
la falla que la nota de `cfdi-taxonomy.ts` describe palabra por palabra.

**La II se quedó corta aquí:** la llamó «documentación caducada». Es peor: son dos artefactos que el
mismo agente consume diciendo lo contrario, y el que gana es el que el modelo lee.

---

### 3 · [II-SIGUE-VIVA] El medidor de coste sigue imprimiendo 0,7 % de cola correctiva · MEDIA

Ejecutado hace minutos sobre este árbol:

```
Agregado desde S0.1: 31 fila(s) invocable(s) ganadas · 13126 líneas · 423 líneas/fila
Cola correctiva declarada (asuntos AUD-*/correctivos): 111 de 15025 líneas = 0.7%
Referencia fundacional («Doce sprints», …): ~390 líneas/fila, 12.3% de cola.
```

Reproduje el 0,7 % exacto. El clasificador sigue siendo `CORRECTIVO_RE = /^AUD-|falso verde|corrig|repara/i`
sobre el **asunto** del commit (`scripts/costo-por-fila.ts:68`), y sigue imprimiéndose **junto a** la
referencia de 12,3 % (`:120-122`), que es la invitación a concluir que la cola se desplomó 17×.
`docs/plan-catalogo.md:48` **ya dice** que esto está mal — el documento absorbió el hallazgo, el
instrumento no. Esto es lo contrario de la regla de la casa (d): un verde falso publicado por el único
instrumento que S1 construyó para dejar de mentir.

**Escenario de fallo:** se presupuesta el tramo F03 con «la cola es 0,7 %, casi todo es entrega», y el
tramo se queda sin presupuesto a la mitad, porque la medición honesta de la misma ventana da
11,8–51,7 % y hoy se escriben 0,94 líneas de garantía por línea de entrega.

**Matiz — [II-MAL-MEDIDA, trivial]:** la II cita `scripts/costo-por-fila.ts:67`; la línea real de
`CORRECTIVO_RE` es la **68** (la 67 está en blanco). El archivo no se ha modificado desde `689458a`
(no aparece en `git diff --stat 689458a cfe40c6`), así que es error de cita, no deriva del árbol.
Su F4 (389,6 vs 390) sí es correcta: se midió sobre `5d24463..a149e62`, ventana distinta de la que el
script agrega desde S0.1 (423) — no hay contradicción, y la propia II lo advierte en su B12.

---

### 4 · [II-SIGUE-VIVA] `ledger check --check balance` sigue ciego a `ending_balance` — y `doctor` también · ALTA

`src/services/accounting/ledger-checks.ts:57-76`. El SELECT compara **exclusivamente**
`ab.debit_total` / `ab.credit_total` contra la suma de líneas posteadas (`:58-59, 73-74`).
`ending_balance` y `beginning_balance` no aparecen ni una vez en el archivo. Y `continuity`
(`:30, 108-131`) es el hueco de folio en la serie `JE-AAAA`, no la continuidad de saldos — el nombre
que el catálogo reservó para el arrastre se gastó en otra cosa.

Las dos columnas ciegas **son justo las que propagan saldo entre ejercicios**:
`src/services/accounting/period-close.ts:396-408` las escribe en el cierre duro
(`ending_balance = EXCLUDED.beginning_balance`).

**Ampliación que la II no midió:** `doctor` tiene la **misma** ceguera y con el **mismo** SQL.
`src/ai/doctor-service.ts:777-803` (`checkLedgerIntegrity`) hace las dos comprobaciones idénticas
—deriva `debit_total`/`credit_total` y posteados sin fila `post`— y tampoco mira `ending_balance`.
Son las dos superficies de integridad del mayor, y las dos están ciegas al mismo sitio.

**Escenario de fallo:** se inyectan 99 999 de deriva en `account_balances.ending_balance` de un
periodo cerrado. `ledger check --check balance` devuelve cero hallazgos, `doctor` devuelve
`level: 'ok'`, el cierre siguiente arrastra la deriva como `beginning_balance`, y el estado de
posición financiera del ejercicio nuevo nace torcido sin que ninguna de las dos compuertas lo diga.

---

### 5 · [II-SIGUE-VIVA] El único PAC no simulado sigue sin registrarse · MEDIA

`src/services/integrations/mexico/pac/pac-router.ts:21-23`:

```
integrationRegistry.register(finkokAdapter);
integrationRegistry.register(swSapienAdapter);
integrationRegistry.register(edicomAdapter);
```

`sovosReachcoreAdapter` se importa (`:9`) y se pone en el mapa de despacho `PAC_ADAPTERS` (`:26`),
pero **no se registra**. `finkokAdapter` declara `readonly simulado = true` (`finkok-adapter.ts:27`);
`SovosReachcoreAdapter` (`sovos-reachcore-adapter.ts:116`, instancia exportada en `:492`) es el único
con `configure()` real (`:134-155`) contra el contrato de Reachcore.

**Precisión sobre la II:** dijo «`integrationRegistry.get()` muere en `PROVIDER_NOT_FOUND`». Es cierto
pero por una vía distinta de la que sugiere. El timbrado **no** pasa por `get()`: `selectPac` resuelve
por `PAC_ADAPTERS[providerId]` (`pac-router.ts:96`), donde Sovos **sí** está. Lo que muere es la
**configuración**: `PUT /v1/admin/integrations/:provider` llama `integrationRegistry.get()`
(`src/api/rest/routes/integrations.ts:81`) → `PROVIDER_NOT_FOUND`
(`src/services/integrations/base/registry.ts:21-24`). Sin credenciales guardadas,
`selectPac` lo salta con `${providerId}: not configured` (`pac-router.ts:108-113`). El resultado es
el mismo —inalcanzable— y el arreglo también: **un renglón** junto a `:21-23`.

**Escenario de fallo:** el despacho contrata Sovos, `PUT /v1/admin/integrations/sovos_reachcore`
responde 404/PROVIDER_NOT_FOUND, y el equipo concluye que «mnemosine no soporta Sovos» cuando el
adaptador completo lleva meses en el árbol. El Plan Maestro v3 §5 ya recoge este encogimiento.

---

### 6 · [II-SIGUE-VIVA] Tres puertas al auto-posteo, una custodiada — **ejecutado** · ALTA

`src/ai/ingest-thresholds.ts`. La asimetría correcta existe y está sólo en el tope de monto
(`:78-87`: el archivo gana **sólo si es más estricto**). En el **interruptor** no está:

```
60  if (archivo.autoPost !== undefined) {
61    autoPost = archivo.autoPost;      // sin comparar contra la política
62    fuenteAuto = 'archivo';
63  }
```

Ejecuté el peor caso —panel en `'shadow'`, archivo en `true`— mockando `getPolicy` e
`ingestFileValues` con el mismo aparejo de `tests/ai/frontera-desatendida.spec.ts`. Salida literal:

```
RESULTADO = {"sombra":true,"autoPost":true,"minConfidence":0.95,"maxAmount":10000,
             "fuentes":{"autoPost":"archivo","minConfidence":"omision","maxAmount":"politica"}}
modoSombra (ingest-service.ts:229) = false
```

`src/ai/ingest-service.ts:229` es `const modoSombra = thresholds.sombra === true && !thresholds.autoPost;`
— con `autoPost:true` la sombra se apaga. Es decir: **el despacho contestó «mídelo primero», el
despacho postea de verdad, y no se registra ni un veredicto de sombra.** Confirmado por ejecución,
no por lectura.

La suite existente prueba cinco combinaciones de precedencia
(`tests/ai/frontera-desatendida.spec.ts:52-110`) y **ninguna** es `shadow` + archivo.

Y la evidencia se mide por entidad mientras la decisión se escribe por inquilino:
`policy-service.ts:173` consulta `concordanciaSombra({tenantId, entityId})`, pero el UPDATE de
`:196-198` es `WHERE tenant_id = $4 AND key = $5` — **sin entidad**.

**Escenario de fallo:** siete días de sombra en una entidad de pruebas, `resolvePolicy('on')` pasa el
peaje, y el auto-posteo queda encendido para todas las entidades del inquilino, incluidas las que
nunca midieron nada. Alternativamente: el operador pone `{"ingest":{"auto_post":true}}` en
`mnemosine.config.json` de la máquina desatendida y ninguna de las tres puertas restantes se entera.

---

### 7 · [II-SIGUE-VIVA] El DML de migración bajo RLS forzada sigue sin contexto de inquilino · ALTA

El arreglo **no llegó**. Verificado en las dos direcciones:

- **El runner no lo pone.** `src/database/migrate.ts:83-90`: `BEGIN` → `client.query(sql)` →
  `INSERT INTO public.migrations` → `COMMIT`. Ni un `set_config`, ni un `SET LOCAL`, ni una
  comprobación de filas afectadas.
- **Sólo dos migraciones lo ponen ellas mismas**, y son las viejas: `025_ledger_hardening.sql:34,66`
  y `026_reseed_entity_sequences.sql:16,48` (`PERFORM set_config('app.current_tenant', t.id::text, true)`).
- **Las tres señaladas por la II siguen sin él:** `037_etiquetado_que_encarece.sql:48,77,86`
  (tres `UPDATE … FROM`), `040_el_secreto_que_el_compromiso_revelaba.sql:26,31`
  (la **purga de seguridad**), `043_la_serie_del_folio_por_ejercicio.sql:26+`
  (cinco `INSERT … ON CONFLICT DO UPDATE`).

El mecanismo está completo y comprobable en el árbol: las tablas se reasignan a `mnemosine_owner`
(`scripts/provision-roles.sql`, bloque «Traspaso de propiedad»), ese rol es **`NOBYPASSRLS`**
(`provision-roles.sql:58-60`, con el comentario «NOBYPASSRLS es la línea que hace que las políticas
signifiquen algo»), y `src/database/rls-policies.sql:55` aplica `FORCE ROW LEVEL SECURITY` a cada
tabla. Un dueño sin BYPASSRLS bajo RLS forzada y sin `app.current_tenant` ve cero filas.

**Escenario de fallo:** un despliegue nuevo corre `npm run migrate` con `MIGRATION_DATABASE_URL`
apuntando a `mnemosine_owner`. La 040 ejecuta `UPDATE blockchain_attestations …` y afecta **0 filas**;
la migración se registra como aplicada; el repositorio cree que la purga del secreto que el compromiso
revelaba está hecha, y no lo está. Nadie se entera porque nada compara `rowCount`.

---

### 8 · [II-SIGUE-VIVA] El trinquete es de granularidad paquete — **reproducido por mutación** · ALTA

La línea literal es `.github/workflows/ci.yml:94`:

```
- run: npm run plan:status -- --exigir=E0.0,E0.1,E0.2,E0.3,E1.1,E1.2,E1.3,E2.1,E2.2,E3.1
```

`exigiblesAbiertos` (`src/plan/status.ts:129-135`) devuelve **ids de paquete**, y `:232` cruza esa
lista con `--exigir`. Cinco paquetes con rojo real —E1.4, E3.2, E4.1, E4.2, E5.1— quedan fuera de la
lista, y con ellos **17 criterios verdes** (E1.4: 1, E3.2: 0, E4.1: 2, E4.2: 1, E5.1: 13; la II contó
16 sobre `689458a`).

**Lo reproduje por mutación en ambas direcciones**, que es la regla de la casa (c). Creé
`src/ai/tools/__mutante_auditoria.ts` con tres líneas que importan y re-exportan `postJournalEntry`
desde `services/accounting/posting.js`. Resultado:

```
🟡 E5.1   12/15 criterios
     ✘ Ninguna herramienta del agente alcanza el mayor ni ejecuta hacia fuera
       … src/ai/tools/__mutante_auditoria.ts → postJournalEntry,
         src/ai/tools/__mutante_auditoria.ts → importa un módulo de dinero

=== línea literal de CI ===
exit=1
Se exigían cerrados y están abiertos: E0.0
```

El único incumplido es **E0.0**, y ése es el artefacto de `.git` del worktree. **El mutante que rompe
la regla de la casa (b) no aparece en la lista.** En la CI real, con `.git` como directorio, esa
corrida sale `exit=0`. El criterio detecta la mutación —está bien escrito, `criterios.ts:1927-2003`,
con tres cercas y el porqué de cada una— y el trinquete la deja pasar.

**Y no hay red debajo.** `declareRisk` (`src/cli/kernel/risk.ts:93-108`) protege las **hojas del CLI**,
no `src/ai/tools/`; y no existe ninguna prueba unitaria que afirme «ninguna herramienta alcanza el
mayor» (busqué en `tests/`: `tests/ai/tools/*` prueba comportamiento de cada herramienta, no la
frontera). El criterio del paquete E5.1 es **la única** guarda de esa superficie, y es la que no tiene
trinquete.

**Escenario de fallo:** un sprint futuro añade `src/ai/tools/posting-tools.ts` con una herramienta que
postea. El criterio se pone rojo, E5.1 ya estaba rojo, CI sale verde, y la garantía «el agente propone
y el humano dispone» se pierde en un commit que nadie tuvo que justificar.

---

### 9 · [II-SIGUE-VIVA] No existe respaldo ni restauración · ALTA

Verificado a la contra, que es la forma honesta de probar una ausencia:
`grep -rl "pg_dump"` sobre `src scripts docs docker package.json` devuelve **sólo** dos archivos:
`docs/auditorias/2026-09-01-integral-ii/producto-y-operacion.md` e `instrumento-ii.md` — la auditoría
misma. `pg_basebackup`, `wal_level`, `PITR` y `point-in-time`: cero fuera de la auditoría y del
catálogo. Los aciertos de `restore` en `src/cli/` (`customer-command.ts:474-488`,
`account-command.ts:635`, `memory-command.ts:173`) son des-archivar una entidad, no restaurar una base.

Las filas están **diseñadas y aparcadas**: `docs/cli-command-registry.md:535` deja
`backup create|list|verify|restore`·`respaldo …` en `platform.md`, y
`docs/plan-catalogo.md:152` ya nombra «el respaldo que no existe» entre las garantías rotas.

**Matiz — [II-EXAGERADA en el agravante]:** la II escribió que el mayor «es físicamente inmutable
desde la 041 — así que un error de datos **no se puede reparar a mano**». Eso es más fuerte de lo que
el árbol sostiene: los disparadores de la 041 son `CREATE TRIGGER` a secas
(`041_el_mayor_inviolable.sql:64-66, 98-100`), sin `ENABLE ALWAYS`, así que el dueño de la tabla
—`mnemosine_owner`, que es explícitamente el break-glass según `provision-roles.sql`— puede
`ALTER TABLE … DISABLE TRIGGER` y reparar. **Existe una salida manual.** Lo cual, lejos de aliviar el
hallazgo, abre uno nuevo: ver **N1**.

**Escenario de fallo (sin cambios):** un `UPDATE` mal filtrado en `account_balances` desde la consola
del operador. No hay de dónde restaurar; `audit_log` prueba que pasó pero no guarda el valor previo de
las filas afectadas; y la reparación exige apagar el disparador del mayor, que es un acto sin rastro.

---

### N1 · [NUEVA] La inmutabilidad del mayor y de las bitácoras descansa en disparadores que nadie comprueba que sigan encendidos · ALTA

Las tres garantías físicas del sistema son disparadores ordinarios:

- `src/database/migrations/041_el_mayor_inviolable.sql:64-66` (`journal_entries`), `:98-100`
  (`journal_entry_lines`), `:114-121` (los dos `BEFORE TRUNCATE`).
- `src/database/migrations/033_audit_log_append_only.sql:47-50, 55-58`.
- `src/database/migrations/035_fiscal_credential_log_append_only.sql:66-69, 74-77`.

Ninguno se crea con `ENABLE ALWAYS`. El comentario de la 041 (`:29-31`) afirma que «el disparador es
la capa que aguanta, **incluso ante el dueño del esquema**» — y eso es falso: el dueño de una tabla
puede `ALTER TABLE … DISABLE TRIGGER USER` sobre ella, y `mnemosine_owner` es el dueño de todas
(`scripts/provision-roles.sql`, bloque «Traspaso de propiedad al operador»).

Lo grave no es que exista la salida —un break-glass es legítimo— sino que **nada la detecta**:

```
grep -rn "tgenabled|DISABLE TRIGGER|ENABLE ALWAYS|pg_trigger|session_replication_role" src/ scripts/
→ (sin resultados)
```

Cero. Ni `doctor` (`src/ai/doctor-service.ts`), ni `ledger check`
(`src/services/accounting/ledger-checks.ts`), ni un criterio de `src/plan/criterios.ts`, ni
`scripts/verify-isolation.sh` leen jamás `pg_trigger.tgenabled`. `rls-policies.sql` re-aplica
`FORCE ROW LEVEL SECURITY` tras cada migración (`:55, :174`) pero **no** re-habilita ni verifica
disparador alguno.

**Escenario de fallo concreto:** un incidente de datos. El operador entra por túnel como
`mnemosine_owner`, corre `ALTER TABLE journal_entries DISABLE TRIGGER USER;`, corrige a mano tres
montos de un asiento posteado y sus `account_balances` para que cuadren, y vuelve a habilitar. Al
salir: `ledger check --check balance` da cero hallazgos (los totales cuadran porque los ajustó),
`--check audit-trail` da cero (los asientos conservan su fila `post`), `doctor` da `level: 'ok'`, y
`audit_log` no tiene una sola fila del acto. El `entry_hash` divergiría, pero nada lo re-verifica salvo
que el camino de atestación vuelva a correr sobre ese asiento. Un libro que el diseño entero llama
inmutable quedó editado, y no existe instrumento que lo diga. Combinado con el hallazgo 9 —sin
respaldo con el que comparar— el hecho es irrecuperable **y** invisible.

**Agravante de dirección equivocada:** `doctor-service.ts:826-829` le dice al operador que
«desde la 041 una línea posteada no se edita, así que una diferencia nueva apunta al camino de
escritura de `account_balances`, no a las líneas». Si las líneas *fueron* editadas con el disparador
apagado, el `fix` manda a investigar el sitio equivocado.

---

### N2 · [NUEVA] El criterio que mide la duplicación del SQL de saldos se evade quitando un `COALESCE`, y ya se le escapan dos copias vivas · MEDIA

`src/plan/criterios.ts:1690`:

```
const copias = dondeAparece(/SUM\(\s*COALESCE\(jel\.debit_amount/i, ['src'], true)
```

Exige literalmente `SUM(COALESCE(jel.debit_amount`. Dos consultas reales que agregan exactamente lo
mismo escriben `SUM(jel.debit_amount)` sin el `COALESCE` interno y por tanto **son invisibles** al
criterio:

- `src/services/accounting/ledger-checks.ts:66` — `SUM(jel.debit_amount) AS d, SUM(jel.credit_amount) AS c`
- `src/ai/doctor-service.ts:784` — `SUM(jel.debit_amount)  AS d,`

El criterio hoy acusa 4 copias (`src/ai/external-service.ts`, `src/api/graphql/resolvers/index.ts`,
`src/api/rest/routes/reports.ts`, `src/services/blockchain/orchestrator.ts`). El conteo honesto de
copias vivas en TypeScript es **6**. (`fuentes()` sólo recorre `.ts` —`criterios.ts:76`— así que las
definiciones de las vistas materializadas en `001/004/010/012` quedan fuera por diseño; eso es
defendible. Las dos de arriba no.)

**Escenario de fallo:** alguien decide cerrar E4.2. En vez de encaminar las cuatro superficies por
`report-service`, reescribe sus `SUM(COALESCE(jel.debit_amount, 0))` como
`COALESCE(SUM(jel.debit_amount), 0)` — semánticamente equivalente en estas consultas, cosmético en el
diff. El criterio pasa a verde, E4.2 cierra, entra a la lista de `--exigir` del `ci.yml`, y quedan
**seis** consultas de saldos divergentes gobernadas por un trinquete que ya no puede volver a
detectarlas. Es la patología que la II diagnosticó en general —«66 de 69 criterios son regex sobre el
fuente»— instanciada en un criterio concreto que ella no abrió. (Conteo propio hoy: **68 de 69**
criterios son estáticos sobre el fuente; sólo `criterios.ts:375` declara `necesita` y sólo `:399`
importa `database/connection.js`.)

---

### N3 · [NUEVA] `checkLedgerIntegrity` es una quinta copia del SQL del mayor con la misma ceguera, en la superficie que el operador consulta primero · MEDIA

`src/ai/doctor-service.ts:777-803` reproduce, palabra por palabra en estructura, las dos consultas de
`ledger-checks.ts:41-106`: la deriva `account_balances` vs Σ líneas posteadas, y los posteados sin
fila `post`. Diferencias: `doctor` corre **global** (sin `entity_id`, `:778-794`) mientras
`ledger check` corre por entidad (`:43, 69, 72`); `doctor` devuelve un `CheckResult`, `ledger check`
filas señalables.

Esto no es sólo duplicación (ver N2): es que **las dos únicas superficies de integridad del mayor
comparten el mismo punto ciego** del hallazgo 4. No hay lugar en el árbol donde se compruebe
`ending_balance`.

**Escenario de fallo:** el despacho corre `doctor` antes del cierre anual —que es lo que `doctor`
existe para que hagan—, obtiene `Ledger integrity: ok · account_balances = Σ líneas posteadas`, y
cierra el ejercicio arrastrando un `ending_balance` derivado. El verde es literalmente cierto y
literalmente insuficiente.

---

### N4 · [NUEVA] Código muerto tras el `throw` en la cancelación de CFDI, en un archivo que un PR fusionado acaba de tocar · BAJA

`src/api/rest/routes/invoices.ts:321-326` lanza `NotImplementedError` incondicionalmente, y
`:328-337` es un `res.json({ data: { … cfdi_status: 'cancelled' … } })` **inalcanzable** — el cuerpo
exacto de la respuesta falsa que el cerrojo antisimulación vino a retirar. El commit `8502ad7`
(`cfe40c6`, PR #3) tocó este archivo hace horas —añadió `validateBody(voidInvoiceSchema)` en `:214`—
y dejó el bloque.

**Escenario de fallo:** el día que se implemente la cancelación real, quien la escriba encuentra un
`res.json` con la forma «correcta» diez líneas más abajo del `throw` y lo cablea tal cual, sin acuse
del PAC y sin reversa encadenada — que es exactamente la «media cancelación» que el comentario de
`:315-318` declara peor que ninguna. Es una trampa de mantenimiento, no un fallo en producción.

---

## QUÉ CERRARON LOS PR FUSIONADOS DESDE `689458a`

**De las 104 brechas que la II dejó abiertas, cerraron cero.**

`git diff --stat 689458a cfe40c6` = **9 archivos, 101 inserciones, 27 borrados**. El delta completo:

| Commit | Qué arregló | ¿Está en la auditoría II? |
|---|---|---|
| `282407e` | `scripts/eval-clasificador.ts` — un comentario de supresión que aparentaba proteger | No |
| `88c5683` / `b0056b9` (PR #2) | `public-verification.ts:279` valida el uuid de entidad y reporta `truncated`; `redis.ts:110-115` retira un parámetro `periodId` que el esquema de claves no podía honrar | No |
| `cfe40c6` / `8502ad7` (PR #3) | `invoices.ts:214` — `POST /:id/void` valida y **propaga** el `reason` a `voidInvoice`; `receivables.md` lo documenta | No |
| `7ba240e` | Tipos en cuatro mocks de `tests/ai/` | No |

Busqué las tres cadenas (`invalidateReportCache`, `from_period`, `voidInvoice`/`/void`) en los doce
informes de `docs/auditorias/2026-09-01-integral-ii/` **y** en los nueve de
`docs/auditorias/2026-08-31-integral/`: **cero coincidencias en ambas**. Los PR fusionados son
correcciones legítimas de otra procedencia (revisión de PR), no ejecución del registro de brechas.

Lo único que sí se movió respecto de la II es **documental**: `3caf499` archivó los doce informes y
`61379d0` reescribió los tres rectores para que digan lo que la II midió — `docs/plan-catalogo.md:48`
recoge el 0,7 %, `:152` el respaldo ausente, y el Plan Maestro v3 §2/§4 ordena S2 («el instrumento se
somete al instrumento», cinco piezas), A7 (el lazo del auto-posteo) y S3 (la restauración) delante de
F03. **El plan absorbió los nueve; el código no absorbió ninguno.**

---

## RECOMENDACIONES

| # | Recomendación | Tamaño | Tramo destino |
|---|---|---|---|
| R1 | **Sellar los disparadores de inmutabilidad** (N1): recrearlos con `ENABLE ALWAYS` en una migración nueva, y añadir a `doctor` un check que lea `pg_trigger.tgenabled` para los seis disparadores de 033/035/041 y falle si alguno no está en `'A'`. Corregir el comentario mentiroso de `041:29-31`. Añadir el criterio espejo. | **M** | **S2** (garantías) — es prerequisito de S3: no tiene sentido diseñar la restauración sin saber si el libro fue editado |
| R2 | **Cerrar el interruptor del auto-posteo con la misma asimetría que ya tiene el tope** (hallazgo 6): en `ingest-thresholds.ts:60-63`, el archivo sólo puede **apagar**, nunca encender; y en `ingest-service.ts:229`, `sombra === true` gana a cualquier `autoPost` que no venga de la política. Añadir el caso `shadow + archivo` a `tests/ai/frontera-desatendida.spec.ts`. Alinear el alcance de la evidencia con el de la decisión (`policy-service.ts:173` vs `:196-198`). | **M** | **A7** |
| R3 | **Trinquete de granularidad criterio** (hallazgo 8): `--exigir` pasa a aceptar `paquete:enunciado` o, más barato, `exigiblesAbiertos` se sustituye por una lista de criterios verdes congelados que ningún commit puede poner en rojo. Empezar por los 17 verdes de E1.4/E3.2/E4.1/E4.2/E5.1, y el primero de la lista es `criterios.ts:1929`. | **M** | **S2**, pieza (2) |
| R4 | **Poblar `FLUJOS_CERRADOS`** con F01/F02/A3–A4 apuntando a `docs/auditorias/2026-09-01-integral-ii/`, y añadir al criterio que **el registro más reciente sea posterior al último flujo declarado** — si no, `:246` seguirá vigilando la auditoría de hace dos semanas. Y escribir los espejos de `tests/plan/` (regla de la casa (c)). | **S** + **M** | **S2**, piezas (1) y (4) |
| R5 | **`ending_balance` entra a las dos superficies** (hallazgos 4 y N3): un check nuevo en `ledger-checks.ts` que compare `ab.ending_balance` contra `beginning_balance + debit_total − credit_total` y contra el `beginning_balance` del periodo siguiente; renombrar el actual `continuity` a `folio-gaps` y liberar el nombre. Encaminar `doctor` por el mismo runner en vez de repetir el SQL. | **M** | **F03** o **S2**; es una fila del catálogo, no sólo una garantía |
| R6 | **Contexto de inquilino en el DML de migración** (hallazgo 7): un envoltorio en `migrate.ts:83-90` que, o bien corre el `.sql` con un bucle por inquilino como hacen la 025/026, o bien **rechaza** una migración que contenga DML sobre tabla con RLS forzada sin `set_config`. Mínimo viable hoy: un criterio de `src/plan/criterios.ts` que acuse cualquier migración con `UPDATE`/`INSERT` sobre tabla con política y sin `app.current_tenant`. Y re-correr 037/040/043 con contexto. | **L** (el arreglo) / **S** (el criterio que lo detecta) | **S2** el criterio · **S3** el re-relleno |
| R7 | **Arreglar el clasificador de cola correctiva** (hallazgo 3): sustituir `CORRECTIVO_RE` (`costo-por-fila.ts:68`) por un *trailer* declarado (`Corrige: E1.2, AUD-6`) con un criterio que rechace un commit de código sin él; mientras tanto, imprimir la **banda** (11,8–51,7 %) en vez de un número solo, y separar entrega de garantía en dos renglones. | **S** | **S2**, «de pilón» |
| R8 | **Un renglón para el PAC** (hallazgo 5): `integrationRegistry.register(sovosReachcoreAdapter);` en `pac-router.ts:23`, más el criterio que exija que todo adaptador de `PAC_ADAPTERS` esté registrado. | **S** | inmediato — desbloquea media decisión de negocio |
| R9 | **Reescribir `mexico-cfdi.md`** con el test de sincronía que `docs/plan-cierre-brechas.md:2974-2982` ya especifica, y añadir la pieza (5) de S2: un criterio que acuse un `.md` de `src/ai/docs/` cuyo servicio cambió y él no. | **M** | **S2**, pieza (5) — y no volver a marcarlo ABSORBIDA |
| R10 | **Blindar el criterio de duplicación de SQL** (N2): sustituir el regex por una comprobación estructural (p. ej. que ningún archivo fuera de `report-service`/`ledger-checks` mencione `journal_entry_lines` junto a `account_balances`), y contar hoy las 6 copias reales en vez de 4. Borrar el bloque muerto de `invoices.ts:328-337` (N4). | **S** | **S2** |

**Orden sugerido:** R8 y R7 hoy mismo (una tarde entre las dos). Después R3+R4 juntos, porque hasta
que el trinquete sea de criterio ningún arreglo posterior queda protegido. R1 antes que S3. R6 antes
del siguiente despliegue limpio.
