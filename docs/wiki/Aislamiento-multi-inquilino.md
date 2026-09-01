# Dos fronteras, y Postgres sólo defiende una

Un despacho lleva los libros de varios clientes, y cada cliente puede tener más de
una entidad legal. Eso son **dos** ejes de separación, no uno:

| Eje | Qué separa | Quién lo hace cumplir |
| --- | --- | --- |
| **Inquilino** (`tenant_id`) | un despacho de otro | PostgreSQL, con *row-level security* forzada |
| **Entidad** (`entity_id`) | dos sociedades del mismo despacho | el código, dentro del SQL de cada consulta |

El [README](https://github.com/sedecim-com/Accounting/blob/main/README.md) resume
el primero en seis viñetas. Esta página explica cómo está construido, y empieza
por lo que **no** cubre, porque descubrirlo leyendo el código sería peor.

---

## Lo primero: los tres huecos que hay que conocer

**1. RLS no acota por entidad.** Todas las políticas tienen como predicado el
inquilino. Dentro de un inquilino con tres sociedades, la base de datos no
separa nada entre ellas: ese eje lo defiende el código y nada más.

**2. RLS es inerte para un rol que la ignore.** Un superusuario o un rol con
`BYPASSRLS` no evalúa políticas. La misma consulta devuelve cero filas o las
filas de todos según con qué rol se conectó el proceso. Por eso existe el
guardián de arranque y por eso la CI tiene un trabajo aparte; los dos están más
abajo.

**3. La frontera de entidad todavía no es universal.** Hay una función
compartida ([`src/database/scope.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/scope.ts)),
y los caminos que se cerraron con causa comprobada la usan. El resto de las
lecturas por id llevan su propio predicado escrito a mano, y **ningún criterio
comprueba mecánicamente que todas lo lleven**: sólo hay un trinquete de
regresión sobre los archivos que ya se arreglaron. Para saber cuántos archivos
pasan hoy por la función compartida, no confíes en un número escrito aquí:

```bash
grep -rln "database/scope.js" src
```

---

## Cuatro roles de clúster, y ninguno vive en una migración

[`scripts/provision-roles.sql`](https://github.com/sedecim-com/Accounting/blob/main/scripts/provision-roles.sql)
crea cuatro principales. Está **fuera** de la cadena de migraciones a propósito:
un rol es un objeto de nivel de clúster, no de base de datos, y crearlo exige
superusuario. Meterlo en una migración obligaría a que `npm run migrate` corriera
como superusuario — que es justamente el estado en que las políticas dejan de
significar algo.

| Rol | Entra | Ignora RLS | Para qué |
| --- | --- | --- | --- |
| `mnemosine_app` | sí | **no** | la aplicación. Sólo DML: sin DDL, sin `TRUNCATE`, sin `REFERENCES`. No posee nada |
| `mnemosine_owner` | sí | **no** | dueño del esquema. Corre las migraciones. Es el *break-glass* |
| `mnemosine_verifier` | no | no | la verificación pública de `/public/v1`. Sólo se asume con `SET LOCAL ROLE` |
| `mnemosine_refresher` | no | **sí** | dueño de las vistas materializadas, sólo para que el `REFRESH` vea el clúster entero |

Dos detalles que parecen contradicciones y no lo son:

- **`NOBYPASSRLS` en `mnemosine_owner`.** El dueño de una tabla salta sus
  políticas por omisión; por eso la migración 014 declara `FORCE ROW LEVEL
  SECURITY` y por eso el `ALTER ROLE` le quita el atributo. Sin esas dos líneas,
  el operador y las migraciones verían todo sin filtro y nadie lo notaría.
- **`BYPASSRLS` en `mnemosine_refresher`.** No abre ninguna lectura: el rol es
  `NOLOGIN` y nadie se conecta con él. Existe porque `REFRESH MATERIALIZED VIEW`
  corre la consulta definitoria **como el dueño de la vista**, y un dueño sujeto
  a RLS reconstruye una vista global con los lentes del inquilino que
  casualmente traiga la sesión — o vacía, si no trae ninguno. Eso pasó de
  verdad: `refresh_reporting_views()` devolvía «hecho» y dejaba cero filas para
  todos.

El guion es idempotente y termina imprimiendo `rolsuper`, `rolbypassrls` y
`rolcanlogin` de los tres roles con nombre, para que el operador vea con sus ojos
que el aprovisionamiento quedó como dice.

---

## Cómo se abre el contexto, y por qué va parametrizado

Las políticas comparan contra `public.app_current_tenant()`, una función
definida en la migración 014 que lee el ajuste de sesión `app.current_tenant`.
Si está ausente o es inválido, devuelve `NULL`, y una política que compara
contra `NULL` no devuelve ninguna fila. **Cierre en falso**: preferimos que un
camino sin autenticar no vea nada a que lo vea todo.

Quien pone ese ajuste es la capa de conexión
([`src/database/connection.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/connection.ts)),
con dos formas que no son intercambiables:

- **`withTenant(tenantId, fn)`** — acota. Es la del servidor: el middleware
  `tenantContext` la monta una sola vez, justo después de `authenticate`, para
  que ningún router pueda olvidarse.
- **`enterTenant(tenantId)`** — no acota, entra y se queda. Es la de la terminal:
  un proceso sirve un comando y opera sobre un inquilino, así que no hay de dónde
  salir. **En un servidor sería un defecto**: el inquilino de una petición se
  filtraría a la siguiente que tomara ese hilo.

Y el ajuste se aplica así:

```ts
await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
```

Tres decisiones en una línea:

1. **`set_config` y no `SET LOCAL`**, porque `SET` no admite parámetros ligados
   y el identificador del inquilino viene de datos. Interpolarlo en el texto de
   la sentencia sería una inyección con el aislamiento entero como premio.
2. **El tercer argumento en `true`** es el alcance local: revierte al terminar la
   transacción. Un `SET` de sesión sobreviviría al `release()` y contaminaría a
   quien tomara esa conexión después.
3. **Con contexto abierto, toda consulta va dentro de una transacción**, aunque
   sea una sola sentencia: es lo único que le da alcance al ajuste local y
   garantiza que se deshaga.

Hay una regla más, que costó una fuga: **el contexto abierto no se reemplaza**.
`resolveEntity` hacía `enterTenant` con el inquilino de la fila que designa la
cabecera `x-entity-id`; a partir de ahí el inquilino efectivo lo elegía quien
mandaba la cabecera, no el token. Hoy, con contexto abierto, se **comprueba** la
pertenencia y se rechaza si no coincide.

---

## Las políticas se derivan del catálogo, no de una lista

[`src/database/rls-policies.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-policies.sql)
recorre `pg_class` y genera las políticas a partir de las columnas que cada
tabla realmente tiene. `migrate.ts` lo ejecuta **después de cada migración**, y
en el `finally`: si una migración falla a mitad, las tablas que sí se crearon
quedan cubiertas igual, y el proceso sale en rojo de todos modos.

La razón es una cicatriz concreta. Una migración de endurecimiento es de un solo
tiro: protege lo que existe cuando corre. `ai_external_ops` nació nueve minutos
después, sin política y en silencio.

El archivo distingue tres formas:

**Tablas con `tenant_id`** — comparación directa, el camino barato:

```sql
tenant_id = public.app_current_tenant()
```

Si la columna admite nulos, el predicado añade `OR tenant_id IS NULL`: un nulo
significa fila global compartida (anclajes de bitcoin, eventos de integración) y
la aplicación ya la consultaba así.

**Tablas con sólo `entity_id`** — el inquilino se resuelve por `legal_entities`,
que a su vez está protegida por su propia política:

```sql
entity_id IN (SELECT id FROM public.legal_entities
              WHERE tenant_id = public.app_current_tenant())
```

**Tablas hijas sin ninguna de las dos columnas** — líneas de asiento, líneas de
factura, percepciones de un recibo de nómina, mensajes de una sesión del agente.
Llegan a su inquilino por la clave foránea del padre, y cada una recibe una
política `EXISTS` contra él. La política **forzada del padre** filtra la
subconsulta para el rol que pregunta, así que la hija hereda el acotamiento sin
duplicar el predicado. Esa lista sí está escrita a mano en el archivo, con el
par hija/padre/columna, y salta las que aún no existen en ese entorno.

Todas se crean como `FOR ALL USING (...)` **sin `WITH CHECK`**: Postgres reutiliza
`USING` para validar filas nuevas, de modo que una fila tampoco se puede insertar
ni mover hacia otro inquilino.

### Las cuatro excluidas, y por qué

```sql
excluded text[] := ARRAY['users', 'sessions', 'tenants', 'migrations'];
```

- **`users` y `sessions`**: el camino de autenticación tiene que leerlas *antes*
  de saber a qué inquilino pertenece quien llama. Una política aquí sería un
  candado con la llave dentro.
- **`tenants`**: es la raíz de la jerarquía. No hay un inquilino por encima
  contra el cual comparar.
- **`migrations`**: no tiene alcance; es el registro de qué se aplicó.

El bloque de tablas hijas excluye además `exchange_rates`, `tax_parameters`,
`tax_tables` (datos de referencia, globales por naturaleza) e `identities` (otra
vez el camino de autenticación, que corre antes del contexto).

Que una tabla esté excluida no es un descuido tolerado: es una decisión escrita
en el archivo, y `verify-isolation.sh` usa **la misma lista** al comprobar
cobertura, así que añadir una excepción exige tocar los dos sitios.

---

## La frontera de entidad: 404 siempre, nunca 403

RLS no llega hasta aquí. Dentro de un inquilino, separar dos sociedades es
trabajo del código, y el patrón que se repetía —leer por id primero, comparar
después— falla de tres maneras a la vez: deja una ventana entre la comprobación
y la escritura; obliga a que **cada** llamador se acuerde (y basta uno que no —
anular una factura por su UUID llegaba a contabilizar un asiento espejo en el
mayor de otra entidad); y ramifica, de modo que la respuesta delata la
existencia del recurso aunque el código HTTP sea el mismo.

La función compartida pone el filtro **dentro del SQL**:

```sql
SELECT * FROM invoices WHERE id = $1 AND entity_id = $2
```

Cero filas significa a la vez «no existe» y «no es tuyo», y no queda ningún punto
en el programa donde se puedan distinguir. De ahí sale un `NotFoundError`, que es
**404**. Nunca 403.

El porqué es que un 403 dice dos cosas: «existe» y «no es tuyo». La primera no
debe salir del sistema, porque en mnemosine los identificadores **circulan**:
`/public/v1` devuelve identificadores de entidad sin autenticar, y las respuestas
arrastran claves foráneas de recursos que nadie pidió. Frente a un id ya
conocido, la pregunta de quien ataca no es «cuál» sino «sigue vivo», y un 403 se
la contesta gratis. El 403 se reserva para lo que no filtra nada: permiso ausente
sobre un recurso cuya pertenencia ya se probó.

Tres decisiones más del mismo archivo:

- **Vive en la capa de datos, no en un middleware.** Los cinco caminos que
  necesitan frontera —REST, GraphQL, la terminal, las herramientas del agente y
  los webhooks— no pueden importar de `src/api/rest/middleware`.
- **El mapa de qué columna acota cada tabla se deduce del esquema**, con el mismo
  criterio que usan las políticas: si hay `entity_id`, acota por entidad; si sólo
  hay `tenant_id`, por inquilino. Una tabla que nazca en una migración futura
  entra sola en el mapa en vez de nacer sin frontera.
- **Una tabla sin ninguna de las dos columnas se rechaza con excepción**, no se
  devuelve sin acotar. Si alguien la pide por ahí, o la tabla necesita alcance o
  la llamada está mal, y ninguna de las dos debe pasar en silencio.

Para escrituras de un solo viaje existe `condicionDeAlcance`, que entrega el
predicado como fragmento: `UPDATE ... WHERE id = $3 AND <condición>`. El
`UPDATE` que no alcanza devuelve cero filas y el llamador lo trata como
«no encontrado» — indistinguible, otra vez a propósito.

Las pruebas de esto viven en
[`tests/integration/frontera-entidad.int.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/frontera-entidad.int.spec.ts)
y
[`frontera-caminos.int.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/frontera-caminos.int.spec.ts),
y usan **dos entidades del mismo inquilino** a propósito: con dos inquilinos
distintos, una prueba podría pasar por el motivo equivocado —el que RLS sí
defendería— y no demostraría nada de esta frontera. Las de ruta hablan por HTTP
contra el router real; llamar al servicio directamente daría por bueno justo lo
que se está arreglando, que es que la ruta le pase el alcance correcto.

---

## El rol verificador, y la trampa de la membresía

`/public/v1` sirve sin credenciales, así que corre sin contexto de inquilino.
Bajo RLS forzada eso son cero filas con `mnemosine_app`, y la tentación
inmediata es conectar el proceso con un rol que ignore RLS — exactamente el
despliegue que el guardián de arranque impide.

El camino sancionado es otro: la consulta pública se ejecuta dentro de una
transacción que **asume** `mnemosine_verifier` con `SET LOCAL ROLE`
([`src/database/consulta-publica.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/consulta-publica.ts)).
Es un paso **hacia abajo** en privilegios: `SELECT` sobre columnas **enumeradas**
—un `SELECT *` nuevo truena en vez de exponer— y políticas propias con el
predicado público. El RFC no está entre esas columnas: no es dato público de
verificación.

Y aquí está la lección más cara del archivo, que conviene leer dos veces si vas a
escribir políticas:

> Una política `TO rol` aplica a **todo miembro** de ese rol, no sólo a quien lo
> asumió.

`mnemosine_app` **es** miembro de `mnemosine_verifier` —tiene que serlo para
poder hacer `SET LOCAL ROLE`—, así que las políticas del verificador, siendo
permisivas, se sumaban con `OR` a `tenant_isolation` y le abrían a la aplicación
todas las filas activas de todos los inquilinos, sin contexto de inquilino
siquiera. `verify-isolation.sh` lo detectó con la frase más seca posible: «sin
contexto no ve ninguna entidad — obtenido 2, esperado 0».

La corrección es que cada predicado exige el rol **asumido**, no el heredado:

```sql
USING (is_active = true AND current_user = 'mnemosine_verifier')
```

`SET LOCAL ROLE` cambia `current_user`, de modo que el router público sigue
leyendo y la aplicación, actuando como ella misma, vuelve a quedar sujeta sólo a
`tenant_isolation`.

Un detalle que ahorra media hora de depuración: el mensaje de error de
`consulta-publica.ts` dice que el rol lo crea «la migración 042». **No es así** —
ninguna migración lo crea, y no podría: es un objeto de clúster. Lo crea
`scripts/provision-roles.sql`. Si te topas con ese mensaje, corre el guion de
aprovisionamiento.

---

## El arranque falla cerrado ante un rol que ignore RLS

[`src/database/rls-guard.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-guard.ts)
pregunta a `pg_roles` por el rol de conexión. Con `NODE_ENV=production` y un rol
superusuario o con `BYPASSRLS`, **el proceso no arranca**.

Antes esto era un `logger.warn`, también en producción. Un aviso que nadie lee no
es una defensa: el aislamiento entero colgaba de una línea de bitácora. La
válvula de *break-glass* existe, pero es explícita y deja el hecho escrito en el
entorno y en el registro:

```bash
ALLOW_RLS_BYPASS_ROLE=I_UNDERSTAND
```

En desarrollo sigue siendo una advertencia: conectar como superusuario es lo
normal ahí, y la suite de integración lo hace a propósito.

---

## El trabajo de CI que conecta como `mnemosine_app`

Este es el punto entero del asunto, y es el requisito que dos planes distintos
levantaron por separado sin que ninguno lo cerrara: **corriendo como
superusuario, la RLS no filtra nada y una política ausente jamás se detectaría**.
Una suite verde en esas condiciones no dice nada sobre el aislamiento de la base.

Por eso [`ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml)
tiene un trabajo llamado `aislamiento`, separado del de integración, con las URL
repartidas entre tres roles:

```yaml
DATABASE_URL: postgresql://mnemosine_app:ci_app_pw@localhost:5432/mnemosine_iso
MIGRATION_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mnemosine_iso
SUPERUSER_URL: postgresql://postgres:postgres@localhost:5432/mnemosine_iso
```

La secuencia importa: **aprovisionar roles → migrar → sembrar → verificar**. Sin
el primer paso, el bucle de `GRANT` de `rls-policies.sql` no encuentra a quién
otorgar y sale sin hacer nada; sin la siembra, la primera comprobación del guion
compara contra una base vacía y no prueba nada.

[`scripts/verify-isolation.sh`](https://github.com/sedecim-com/Accounting/blob/main/scripts/verify-isolation.sh)
corre siete comprobaciones, tres de comportamiento y cuatro de cobertura:

```bash
SUPERUSER_URL=... MNEMOSINE_APP_PASSWORD=... bash scripts/verify-isolation.sh
```

1. Sin contexto, `mnemosine_app` no ve **ninguna** entidad (cero, no todas).
2. Con contexto, no ve entidades de otro inquilino.
3. La escritura hacia otro inquilino se rechaza con el error de *row-level security*.
4. Toda tabla con `tenant_id` o `entity_id` tiene RLS habilitada, **forzada** y
   con la política `tenant_isolation`. Es la comprobación que existe porque
   `ai_external_ops` nació sin ella.
5. Ninguna vista **plana** pertenece a un rol que ignore RLS. Una vista plana
   re-corre su consulta con los permisos de su dueño en cada lectura: una vista
   de superusuario sobre una tabla protegida salta RLS para todo el que la lea.
   Ésta fue durante un tiempo la única comprobación en rojo del guion.
6. Toda vista **materializada** pertenece a `mnemosine_refresher`. Es el caso
   contrario: leerla no re-corre nada (es una tabla-instantánea; la aíslan los
   `GRANT` y el `WHERE`, y una materializada ni siquiera admite `CREATE POLICY`),
   pero el `REFRESH` sí corre como su dueño.
7. La aplicación tiene permisos sobre todas las tablas. Una tabla sin permisos
   rompe el comando que la toque semanas después y lejos de la migración que la
   creó — pasó con siete de ellas mientras `MIGRATION_DATABASE_URL` no existía.

El guion limpia lo que creó en un `trap EXIT`, así que se puede correr contra una
base de desarrollo sin dejarla sucia.

### Por qué la suite de integración corre como superusuario

No es un descuido. Las pruebas de `frontera-entidad` y `frontera-caminos`
demuestran la frontera **del código**, y con RLS activa podrían pasar por el
motivo equivocado. Si pasan con RLS inerte, pasan también con RLS activa.

La parte de base de datos se cubre en
[`tests/integration/tenant-isolation.int.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/tenant-isolation.int.spec.ts)
con un truco limpio: `SET LOCAL ROLE` hacia un rol `NOLOGIN NOBYPASSRLS`.
Postgres decide el *bypass* por el rol **actual**, así que la conexión de
superusuario deja de serlo dentro de la transacción y las políticas empiezan a
filtrar; al hacer `ROLLBACK` vuelve a ser quien era. Eso permite probar RLS sin
dar de alta un rol con login ni tocar `pg_hba`. Lo que queda —propiedad de las
vistas y permisos de `mnemosine_app`— habla del entorno aprovisionado, no del
esquema, y sigue siendo trabajo de `verify-isolation.sh`.

Más sobre cómo corren las dos suites y qué exige cada una en
[[Pruebas-y-CI]].

---

## Si algo no cuadra

| Síntoma | Causa más probable |
| --- | --- |
| Todo devuelve cero filas | no hay contexto de inquilino: `--tenant <uuid>` o `MNEMOSINE_TENANT` en la terminal; en el servidor, el token no trae inquilino |
| `permission denied for table legal_entities` al leer otra tabla | falta el `GRANT` de la columna `tenant_id` que necesita el predicado de la política, no la tabla que nombra el error |
| El rol asume `mnemosine_verifier` y falla | el rol no existe: corre `scripts/provision-roles.sql` (el mensaje que culpa a la migración 042 está equivocado) |
| Una vista materializada refresca vacía | su dueño no es `mnemosine_refresher` |
| El proceso no arranca y habla de RLS | es `rls-guard.ts` haciendo su trabajo: conecta como `mnemosine_app` |

Más casos en [[Solucion-de-problemas]].

---

## Para seguir

- [[Base-de-datos-y-migraciones]] — cómo se aplican las migraciones y por qué el
  endurecimiento se reejecuta en el `finally`.
- [[Seguridad-y-credenciales]] — la custodia de la e.firma, las bitácoras de sólo
  agregar y la postura general.
- [[Arquitectura]] — dónde encajan la capa de datos, el servidor y la terminal.
- [[El-tablero-y-los-criterios]] — el trinquete que impide que estas garantías
  retrocedan sin que nadie se entere.
- [[Glosario]] — inquilino, entidad, alcance, contexto.
