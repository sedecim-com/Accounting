# Migraciones: numeración y reparto de rangos

## Regla

Cada migración lleva prefijo de tres dígitos. `npm run migrate` **falla** si dos
archivos comparten número (`assertNumeracionUnica` en `src/database/migrate.ts`),
y el test `tests/database/migration-numbering.spec.ts` lo fija.

## Duplicados históricos

Estos cuatro números quedaron duplicados antes de que existiera la guarda y **ya
están aplicados en bases desplegadas**. Renumerarlos rompería esas instalaciones,
así que se toleran de forma explícita:

| Número | Archivos |
|---|---|
| 012 | `012_ai_drafts_unique_source.sql`, `012_fix_mv_account_balance_summary.sql` |
| 014 | `014_ai_external_ops.sql`, `014_fiscal_credentials.sql`, `014_rls_tenant_isolation.sql` |
| 015 | `015_account_roles.sql`, `015_identities.sql` |
| 018 | `018_ai_sessions.sql`, `018_fix_account_roles_unique.sql` |

## El reparto de rangos, retirado

Aquí vivía una tabla que reservaba los números 031–053 por etapa del plan de
cierre («Última migración existente: **030**»). **Murió sin que nadie la
tocara**: las migraciones 031–037 las quemó el trabajo correctivo —auditorías,
bitácoras, la ligadura del REP, el etiquetado— y ninguna pertenecía a los
paquetes que los rangos reservaban. Una reserva que nadie consulta no
coordina: desinforma, porque promete un orden que el historial ya contradice.

La regla vigente es la simple:

- **Secuencial estricto.** El siguiente número es `max + 1` sobre lo que hay
  en `src/database/migrations/`. Hoy: **049** (la 048 es la última en el árbol).
- **La guarda decide, no este documento.** `assertNumeracionUnica` falla ante
  cualquier duplicado nuevo; los cuatro históricos de arriba son los únicos
  tolerados.
- **Dos sesiones que colisionen** en el mismo número lo descubren en el
  primer `npm run migrate` o en CI — que es más pronto y más fuerte que una
  tabla de reservas que había que recordar leer.

## Migraciones de datos bajo RLS: el piso y el opt-in

### La trampa

`npm run migrate` conecta como `mnemosine_owner`, que **no** ignora RLS
(NOBYPASSRLS es deliberado: es también el rol de break-glass). Las tablas de
inquilino llevan `FORCE ROW LEVEL SECURITY`, que somete **también al dueño**, y
la política evalúa `app_current_tenant()` — un GUC que la sesión del migrador
no trae. Resultado: cualquier `INSERT...SELECT`, `UPDATE` o `DELETE` sobre una
tabla de inquilino lee **cero filas y termina «bien»**. Pasó tres veces antes
de volverse regla: la 025 (lo confesó la 026), y el 2026-08-31 se descubrió —
por una colisión de folio — que la 043, la 037 y la 040 corrieron igual de
mudas.

### El piso

`migrate.ts` ejecuta `SET row_security = off` al abrir la sesión. Eso **no**
desactiva RLS: le pide a Postgres que **lance 42501** («query would be
affected by row-level security policy») en cuanto una política fuera a
aplicarse, en vez de filtrar en silencio. Es el default de `pg_dump`, por esta
misma razón. Una migración de datos que olvide la RLS ahora truena nombrando
la tabla; el cuarto olvido no callará.

Lo fijan el criterio E0.2 del tablero («Una migración de datos que olvide la
RLS truena en vez de correr filtrada») y
`tests/integration/migracion-bajo-rls.int.spec.ts`, que reproduce la
semántica con un rol de utilería NOBYPASSRLS — la suite corre como
superusuario a propósito y por eso nunca vio el no-op.

### El patrón sancionado

Una migración de datos sobre tablas de inquilino declara el opt-in e itera
inquilinos (`tenants` está excluida de RLS) fijando el GUC por vuelta:

```sql
-- El opt-in: migrate.ts corre la sesión con row_security=off. Este bucle SÍ
-- maneja RLS a propósito; SET LOCAL muere con la transacción del archivo.
SET LOCAL row_security = on;
DO $seed$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    -- ...el DML, que ahora ve las filas de ESTE inquilino...
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$seed$;
```

El `SET LOCAL` es transaccional: `migrate.ts` envuelve cada archivo en
`BEGIN`/`COMMIT`, así que el opt-in de una migración no alcanza a la
siguiente. El criterio E0.2 falla si un archivo usa el bucle sin declarar el
opt-in — contra el piso moriría en el primer catch-up de una base rezagada.

**No** hay rol de migración con BYPASSRLS y es a propósito: un credencial
LOGIN que ignora RLS en el `.env` es exactamente lo que `rls-guard.ts` existe
para impedir, y `SECURITY DEFINER` del dueño no resuelve nada — bajo FORCE el
dueño sigue sujeto.

### Censo del daño y su reparación (2026-08-31)

Auditadas todas las migraciones con DML en tiempo de migración (las 033/035/041
definen triggers: corren en tiempo de aplicación, con contexto):

| Migración | Bajo RLS al correr | Veredicto en la base de desarrollo |
|---|---|---|
| 009 | n/a | Tablas globales (`tax_*`), sin RLS: intacta. |
| 017, 018-fix | Sí | **Auto-verificantes**: si su `DELETE` de duplicados hubiera filtrado dejando alguno, el `CREATE UNIQUE INDEX` del mismo archivo habría tronado (el DDL no está sujeto a RLS). Registradas y sin duplicados residuales: limpias. |
| 025 | Sí | Sembró nada; ya reparada por la 026 (el precedente del patrón). |
| 037 | Sí | **No-op parcial**: 3 `bills` sin `cfdi_uuid` teniendo puente, 1 cliente intercompañía sin marca. |
| 040 | Sí | **No-op total**: 15 `range_proof` y 15 `zkverify_proof` seguían conteniendo `_test_value` — el secreto que la migración decía purgar. |
| 043 | Sí | Sembró nada; colisión de folio al crear la primera póliza post-R3. Re-corrida a mano como superusuario ese mismo día. |

La **046** re-corre las tres reparaciones (037 + 040 + 043) con el patrón
sancionado; cada paso es idempotente (`ON CONFLICT`/`GREATEST`, guardas `IS
NULL`, guardas por contenido), así que es inocua sobre bases sanas y sobre la
base de desarrollo ya reparada a mano. La 025/026/043 quedaron además
enmendadas en el árbol (el precedente de enmendar en sitio es la propia 025)
para que una base rezagada que llegue a ellas con RLS y datos siembre de
verdad en vez de errar contra el piso. Reparar una base = `npm run migrate`.
