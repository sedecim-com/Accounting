# Base de datos y migraciones: lo que corre después de cada migración, y por qué

Esta página cubre cómo evoluciona el esquema de mnemosine: cómo se numeran las migraciones, qué hace el runner, por qué las políticas de aislamiento se vuelven a aplicar cada vez, quién es el dueño de las vistas materializadas, y una trampa que puede costar caro. Lo que hay dentro del esquema —qué tabla guarda qué— se recorre desde [[Arquitectura]] y [[Aislamiento-multi-inquilino]].

Las cifras no se copian aquí. Se preguntan:

```bash
ls src/database/migrations/*.sql | wc -l
```

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
```

## Lo que esta capa todavía no tiene

Tres huecos, arriba y no en una nota al pie:

- **No hay migraciones de reversa.** Ninguna migración trae su `down`. Deshacer un cambio de esquema es escribir la siguiente migración a mano.
- **No hay respaldo ni restauración en todo el árbol.** Y lo que el proyecto hizo bien lo empeora: desde la migración 041 el mayor es físicamente inmutable y `audit_log` es de sólo agregar, así que un error de datos **no se puede reparar a mano**. Quien opere esto tiene que resolver su propio respaldo de PostgreSQL.
- **Nada impide escribir una migración con relleno de datos que no haga nada.** La trampa del final de esta página es real, está viva en el árbol de hoy en dos migraciones, y ninguna prueba la detecta.

## La numeración, y los cuatro duplicados que no se pueden renumerar

Cada migración lleva prefijo de tres dígitos. `npm run migrate` **falla** si dos archivos comparten número: la guarda es `assertNumeracionUnica` en [`src/database/migrate.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrate.ts), y la prueba `tests/database/migration-numbering.spec.ts` la fija.

Cuatro números quedaron duplicados antes de que la guarda existiera y **ya están aplicados en bases desplegadas**: 012, 014, 015 y 018. Renumerarlos rompería esas instalaciones —el runner se acuerda de las migraciones **por nombre de archivo**, así que cambiarle el nombre a una ya aplicada la vuelve a ejecutar—, de modo que se toleran de forma explícita, listados en un `Set` del propio runner y en [`docs/migraciones.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/migraciones.md). Cualquier duplicado **nuevo** es un error, y el mensaje dice cuál es el siguiente número libre.

En ese mismo documento vivía una tabla que repartía rangos de numeración por etapa del plan de cierre. Murió sin que nadie la tocara: las migraciones 031 a 037 las quemó el trabajo correctivo y ninguna pertenecía a los paquetes que los rangos reservaban. Una reserva que nadie consulta no coordina: desinforma, porque promete un orden que el historial ya contradice. La regla vigente es la simple —secuencial estricto, `max + 1` sobre lo que hay en el directorio— y quien decide es la guarda, no el documento. Dos sesiones que colisionen lo descubren en el primer `npm run migrate` o en CI, que es más pronto y más fuerte que una tabla que había que acordarse de leer.

## El runner

`npm run migrate` ejecuta [`src/database/migrate.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrate.ts). Cinco decisiones dentro de él tienen historia:

### Pool propio, y un rol distinto

El runner construye su propio pool sobre `MIGRATION_DATABASE_URL` y **no** importa el de `connection.ts`. Son dos principales distintos: las migraciones corren DDL como `mnemosine_owner`, dueño del esquema; la aplicación corre DML como `mnemosine_app`, que no posee nada. El pool de la aplicación carga además el contexto de inquilino, que en una migración no tiene sentido. Si `MIGRATION_DATABASE_URL` no está, se cae a `DATABASE_URL`, que es cómodo en desarrollo y es exactamente cómo siete tablas acabaron creadas por otro rol y nacieron invisibles para la aplicación.

### Una migración y su anotación son un solo acto

```ts
await client.query('BEGIN');
try {
  await client.query(sql);
  await client.query('INSERT INTO public.migrations (filename) VALUES ($1)', [file]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw err;
}
```

Antes eran dos transacciones implícitas. Un fallo entre ambas dejaba la migración aplicada y sin registrar, y la siguiente corrida la re-ejecutaba: fatal en cualquier migración no idempotente y, peor, **volvía a correr los rellenos de datos**.

### El endurecimiento corre siempre, incluso ante un fallo

La reaplicación de `rls-policies.sql` vive en el `finally`, no en el `try`. Su comentario decía «ALWAYS» y estaba dentro del `try`, así que un fallo a mitad de corrida se lo saltaba: las migraciones que **sí** se habían aplicado antes del fallo quedaban con sus tablas creadas y sin política. Esa es exactamente la fuga que el bloque existe para impedir. En el `finally` cubre lo aplicado pase lo que pase, y el proceso sale en rojo igualmente.

### Migrar sólo cuando se invoca, no cuando se importa

El archivo exporta `assertNumeracionUnica`, que una prueba unitaria importa, y la llamada a `runMigrations()` estaba suelta en el cuerpo del módulo. El import ejecutaba las migraciones. En CI —donde el job unitario **no** tiene Postgres a propósito— eso reventaba con `ECONNREFUSED` y ponía el job en rojo con todas las pruebas en verde, porque vitest falla ante un error no manejado aunque no falle ninguna aserción. En la máquina de quien desarrolla no se veía: había un Postgres escuchando, así que `npm test` migraba su base sin decírselo. Hoy hay un cerrojo `require.main === module`, y un `.catch` de respaldo porque un rechazo del `finally` escaparía al try interno y el proceso saldría en **verde** tras fallar.

## Por qué `rls-policies.sql` se reaplica después de cada migración

Esta es la decisión más importante de la capa, y tiene una cicatriz que la explica.

Una migración de endurecimiento es de un solo disparo: protege lo que existe cuando corre. Toda tabla creada por una migración posterior nace **sin política, en silencio**. No es un riesgo teórico: pasó con `ai_external_ops`, creada nueve minutos después de la migración que la habría protegido. Nueve minutos, dentro de la misma sesión de trabajo. Nadie lo vio, porque una tabla sin política no falla: devuelve filas.

Por eso [`src/database/rls-policies.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-policies.sql) es **canónico e idempotente** —`DROP POLICY IF EXISTS` seguido de `CREATE` en cada pasada— y el runner lo ejecuta al terminar, siempre. No es una migración más: es el estado deseado, reconciliado desde cero cada vez.

Hace cinco cosas, en este orden:

**1. Políticas por inquilino, derivadas del catálogo.** Recorre `pg_class` buscando toda tabla ordinaria o particionada de `public` que lleve `tenant_id` o `entity_id`, y le aplica `ENABLE` + `FORCE ROW LEVEL SECURITY` más una política `FOR ALL` con `USING` y sin `WITH CHECK` —Postgres reutiliza el `USING` para validar filas nuevas, así que una fila tampoco puede INSERTARSE ni MOVERSE a otro inquilino—. No es una lista escrita a mano, que caducaría en la primera migración que añada una tabla. Se excluyen a propósito `users` y `sessions` —el camino de autenticación tiene que leerlas **antes** de saber a qué inquilino pertenece quien llama—, más `tenants`, que es la raíz de la jerarquía, y `migrations`, que no tiene alcance.

**2. Privilegios de la aplicación, con auto-reparación.** Los privilegios por omisión sólo alcanzan a lo que crea el dueño del esquema; una tabla creada por otro rol nace invisible para la aplicación y el síntoma aparece semanas después como «permission denied». El bloque vuelve a otorgar sobre todo lo que el rol actual posee, en cada migración. Con una excepción enumerada a mano: `audit_log` y `fiscal_credential_access_log` son de sólo agregar y reciben `REVOKE ALL` seguido de `GRANT SELECT, INSERT`. Sin esa excepción, el `GRANT` general deshacía en la misma corrida el `REVOKE` de las migraciones 033 y 035, y dejaba la bitácora modificable otra vez: el disparador seguía deteniéndolo, pero la primera capa —la barata, la que Postgres aplica antes de ejecutar nada— quedaba muerta sin que nada lo dijera. La lista es corta a propósito y **no se deriva por heurística de nombre**: hay una docena de tablas que *parecen* bitácora —`policy_decisions`, `webhook_deliveries`, `ai_external_ops`, `blockchain_attestations`, `integration_events`— y reciben `UPDATE` del código o son máquinas de estado.

**3. Políticas de tablas hijas.** El primer bucle sólo cubre tablas que llevan la columna. Las hijas —líneas, aplicaciones, detalles de recibo de nómina— llegan a su inquilino por la clave foránea del padre, así que cada una recibe una política `EXISTS` contra el padre. La política forzada del padre filtra la subconsulta para el rol que pregunta, de modo que la hija hereda el alcance sin duplicar el predicado.

**4. Dueño de las vistas** — la sección siguiente.

**5. El camino sancionado de la verificación pública**, con el rol `mnemosine_verifier` y sus columnas enumeradas. Ver [[Seguridad-y-credenciales]].

Un detalle que se ganó a golpes y merece leerse entero en el archivo: **una política `TO rol` aplica a todo MIEMBRO de ese rol, no sólo a quien lo asumió.** Como `mnemosine_app` es miembro de `mnemosine_verifier` —tiene que serlo para poder hacer `SET LOCAL ROLE`—, las políticas públicas, siendo permisivas, se sumaban con `OR` a `tenant_isolation` y le abrían a la aplicación todas las filas activas de todos los inquilinos, sin contexto de inquilino siquiera. Por eso cada predicado público exige `current_user = 'mnemosine_verifier'`: el rol **asumido**, no el heredado.

## Las vistas materializadas y su dueño

Hay dos vistas materializadas de reporte, `mv_trial_balance` y `mv_account_balance_summary`. Su historia es la mejor lección de esta capa, porque una vista plana y una materializada son casos **opuestos** y tratarlos igual produce dos fallos distintos.

**Una vista plana** re-corre su consulta con los permisos de su dueño cada vez que alguien la lee. Si el dueño es un superusuario, la aplicación leía a través de la RLS de todos los inquilinos. `verify-isolation.sh` ya lo comprobaba y era su única comprobación en rojo. La cura es reasignarla a `mnemosine_owner`, que es `NOBYPASSRLS`, y devolverla al régimen normal.

**Una vista materializada** es lo contrario: es una tabla-instantánea. Leerla **no** re-corre la consulta —la aíslan los `GRANT` y el `WHERE entity_id`, no las políticas; una vista materializada ni siquiera admite `CREATE POLICY`—. Donde su dueño sí importa es en el **REFRESH**: la consulta definitoria corre como el dueño, y bajo RLS forzada un dueño sin `BYPASSRLS` reconstruye la vista **global** con los lentes del inquilino que traiga la sesión, o **vacía** si no trae ninguno.

Eso fue lo que pasó. `refresh_reporting_views()` devolvía «hecho» y dejaba cero filas para todos. No fallaba; mentía en verde.

La cura es un tercer rol, `mnemosine_refresher`, creado en [`scripts/provision-roles.sql`](https://github.com/sedecim-com/Accounting/blob/main/scripts/provision-roles.sql):

```sql
CREATE ROLE mnemosine_refresher NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS;
```

`BYPASSRLS` aquí no abre ninguna lectura: el rol es `NOLOGIN`, nadie puede conectarse con él, y una vista materializada no re-corre su consulta al leerse. Su única función es que el refresco vuelva a ver el clúster entero, que es lo que un agregado global necesita. `rls-policies.sql` reasigna las `'m'` a `mnemosine_refresher` y las `'v'` a `mnemosine_owner`, otorgando antes `SELECT` sobre las tablas base —`BYPASSRLS` salta políticas, no `GRANT`, y sin ese paso previo la reasignación rompe la vista entera con «permission denied for table accounts»— y `USAGE, CREATE` sobre el esquema, porque `ALTER ... OWNER` exige que el dueño **entrante** pueda crear ahí.

Si el rol no existe, la vista se queda con su dueño actual y se avisa. **No se cae al operador a propósito**: una materializada del operador refresca filtrada, que es peor que quedarse como está y decirlo.

### El refresco es un comando, no un efecto secundario

Desde la migración 004, **cada posteo** disparaba dos `REFRESH MATERIALIZED VIEW CONCURRENTLY` dentro de su propia transacción, sobre vistas globales que cruzan todos los inquilinos. Tres costos a la vez: cada posteo pagaba un refresco proporcional a la instalación entera y no a su asiento; los posteos concurrentes de inquilinos **distintos** se serializaban entre sí esperando el refresco del otro; y la latencia del acto contable quedaba atada al tamaño de las vistas de reporte.

[`042_el_refresco_sale_del_posteo.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/042_el_refresco_sale_del_posteo.sql) borra ese disparador. El camino de reemplazo ya existía y es más honesto:

- `refresh_reporting_views()` (migración 031) — refrescable por llamada, con lista blanca de nombres, `SECURITY DEFINER` y `search_path` fijado. Los nombres llegan como dato, así que se comprueban contra la lista antes de interpolarse: una función `SECURITY DEFINER` que concatena identificadores del que llama es una escalada de privilegios, no una comodidad.
- `mnemosine report view sync` — el comando que la invoca, declarado `escritura` y cerrado al agente.
- `getReportingViewStatus` — el detector de deriva, que compara la vista contra el mayor vivo y **dice** si está caduca en vez de prometer una frescura carísima de sostener.

Una vista de reporte puede estar segundos desactualizada y decirlo; un posteo no puede pagar el reporte de todos los demás.

## La trampa: DML dentro de una migración bajo RLS forzada

Si vas a escribir una migración con relleno de datos, lee esto entero.

**Una migración corre como `mnemosine_owner`, que es `NOBYPASSRLS`, y sin contexto de inquilino.** Las políticas de aislamiento se apoyan en `app_current_tenant()`, que lee el GUC `app.current_tenant` y devuelve `NULL` cuando no está puesto. Bajo `FORCE ROW LEVEL SECURITY` —forzada precisamente para que el dueño de la tabla tampoco se la salte—, un `NULL` ahí significa **cero filas**.

No hay error. No hay aviso. Un `SELECT` devuelve vacío, un `UPDATE` reporta cero filas afectadas, un `INSERT ... SELECT` no inserta nada, y la migración se marca como aplicada con éxito.

Ya pasó: la migración 025 sembró `entity_sequences` como dueño del esquema sin contexto, y no sembró nada. El daño potencial no era cosmético —los contadores de folio habrían reiniciado en 1 y colisionado con números ya emitidos—, y hubo que escribir la 026 para repararlo.

### La forma correcta

El relleno se hace **por inquilino**, enumerando `tenants` —que está excluida de la RLS justamente para que este bucle sea posible— y abriendo el contexto en cada vuelta. Es el patrón de [`026_reseed_entity_sequences.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/026_reseed_entity_sequences.sql):

```sql
DO $seed$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    INSERT INTO entity_sequences (entity_id, name, value)
    SELECT entity_id, 'journal_entry', GREATEST(COUNT(*), 0)
    FROM journal_entries GROUP BY entity_id
    ON CONFLICT (entity_id, name) DO NOTHING;

  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$seed$;
```

El tercer argumento de `set_config` en `true` es alcance local a la transacción: se revierte al terminar. Y la última línea limpia el contexto explícitamente, para que lo que venga después de este bloque no herede un inquilino por accidente.

### Por qué CI no te va a salvar

Esto es lo que hace la trampa peligrosa en vez de sólo molesta. En [`.github/workflows/ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml), los dos jobs que migran lo hacen con `MIGRATION_DATABASE_URL` apuntando al rol `postgres`, es decir, **superusuario**. Un superusuario ignora la RLS siempre, forzada o no. El relleno funciona perfectamente en CI y no hace nada en un despliegue donde las migraciones corran, como deben, como `mnemosine_owner`.

Así que la comprobación no puede ser «pasó en verde». Tiene que ser leer la migración.

### Dos migraciones del árbol de hoy están en ese estado

Se dice porque callarlo sería peor:

- [`037_etiquetado_que_encarece.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/037_etiquetado_que_encarece.sql) rellena `bills.cfdi_uuid` desde el puente `pre_registrations → xml_documents`, y `vendors.related_entity_id` / `customers.related_entity_id` cotejando RFC dentro del mismo inquilino. Tres `UPDATE` sin bucle por inquilino.
- [`043_la_serie_del_folio_por_ejercicio.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrations/043_la_serie_del_folio_por_ejercicio.sql) siembra los contadores anuales de folio leyendo los folios ya emitidos de `journal_entries`, `invoices`, `bills` y las dos tablas de pago. Seis `INSERT ... SELECT` sin bucle por inquilino.

Ambas son idempotentes —`ON CONFLICT DO NOTHING` en un caso, `GREATEST` en el otro— así que reparar el relleno es escribir la migración siguiente con el bucle, no rescatar un estado a medias. Y ninguna prueba lo detecta hoy: `assertNumeracionUnica` mira nombres de archivo, `schema-contract.int.spec.ts` mira que las consultas del código nombren tablas y columnas que existen, y ninguna de las dos abre una migración a buscar DML sin contexto.

## Cómo se comprueba que el esquema y el código no divergen

Dos pruebas de integración corren contra una base **efímera** —creada, migrada y destruida en cada corrida— para que la fuente de verdad sea el esquema resultante y no un archivo que alguien recuerde actualizar:

- `schema-contract.int.spec.ts` convierte en fallo de CI cualquier consulta que nombre una tabla o columna inexistente. Su alcance está declarado a propósito para que nadie lo confunda con cobertura total: sí los nombres de tabla en `FROM`/`JOIN`/`INSERT INTO`/`UPDATE`, sí las listas de columnas de un `INSERT`, sí las columnas de un `SELECT` sobre una sola tabla; no las columnas de un `WHERE` o un `SET`, ni las de un `SELECT` con `JOIN`. Eso exigiría un analizador de SQL de verdad.
- `enum-contract.int.spec.ts` hace lo propio con los vocabularios.

La suite de integración necesita `TEST_ADMIN_DATABASE_URL`, un rol con permiso de `CREATE DATABASE` que deliberadamente **no** tiene `mnemosine_owner`: crear bases no es atribución del dueño del esquema.

El detalle de los jobs está en [[Pruebas-y-CI]].

## Añadir una migración

1. El siguiente número es `max + 1` sobre lo que hay en el directorio. Si te equivocas, la guarda te dice cuál era.
2. El nombre dice qué hace, no qué paquete la pidió.
3. Abre el archivo con un comentario que explique **por qué**, no qué. Las migraciones de este árbol se leen como el registro de decisiones que son.
4. Si crea una tabla con `tenant_id` o `entity_id`, no escribas su política: `rls-policies.sql` se la pone sola al terminar la corrida. Si crea una tabla **hija** que llega a su inquilino por la clave foránea del padre, añádela a la lista de ese archivo.
5. Si lleva relleno de datos, envuélvelo en el bucle por inquilino. Y no confíes en que CI te lo diga.
6. Corre `npm run migrate` contra una base local y después `npm test` y `npm run plan:status`.

## Para seguir

- [[Aislamiento-multi-inquilino]] — los tres roles, el guardián de arranque y por qué cruzar la frontera devuelve 404.
- [[Arquitectura]] — el motor de posteo, que es lo que estas políticas protegen.
- [[Seguridad-y-credenciales]] — la bóveda, las bitácoras de sólo agregar y el camino público de verificación.
- [[Pruebas-y-CI]] — los jobs, y cuál de ellos conecta como `mnemosine_app` a propósito.
- [[Solucion-de-problemas]] — «permission denied», «cero filas» y otros síntomas de esta capa.
