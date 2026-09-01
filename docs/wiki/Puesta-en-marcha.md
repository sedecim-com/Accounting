# Puesta en marcha

Esta página instala mnemosine desde cero y termina con un asiento real posteado al mayor. Es deliberadamente más larga que el arranque rápido del [README](https://github.com/sedecim-com/Accounting/blob/main/README.md): aquí se explica qué hace cada paso y qué se rompe si se salta.

Si ya lo tienes corriendo y algo falla, vete a [[Solucion-de-problemas]].

---

## Antes de empezar

**Node ≥ 20.** No es una recomendación: el campo `engines` del [`package.json`](https://github.com/sedecim-com/Accounting/blob/main/package.json) lo exige, y `npm ci` se queja.

**PostgreSQL 15.** Es la versión contra la que corre todo: la CI levanta `postgres:15` y el `docker-compose.yml` usa `postgres:15-alpine`. Nada del esquema exige 15 en particular, pero es lo único probado.

**`psql` en el PATH.** Hace falta una vez, para provisionar los roles. Ese paso no lo puede hacer la aplicación (ver más abajo por qué).

**`openssl`.** Para generar la llave de cifrado. Cualquier fuente de 32 bytes aleatorios sirve; `openssl rand -hex 32` es la que la propia guía del `.env` sugiere.

**Redis: opcional.** Es caché y limitador de peticiones de la API REST. Si no está, [`src/services/cache/redis.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/cache/redis.ts) atrapa el fallo de conexión, imprime `Redis not available, caching disabled` y sigue sin caché. El CLI no lo necesita en ningún camino.

El binario **no se instala como comando global**. Todo lo que en esta página aparece como `mnemosine <algo>` se invoca así:

```bash
npm run mnemosine -- <comando>
```

El `--` es obligatorio: sin él, npm se queda las banderas en vez de pasárselas al programa.

---

## Clonar e instalar

```bash
git clone https://github.com/sedecim-com/Accounting.git
```

```bash
cd Accounting && npm ci
```

`npm ci` y no `npm install`: respeta el `package-lock.json` al pie de la letra y borra `node_modules` antes de empezar. Una instalación que resuelve versiones por su cuenta es una instalación distinta de la que pasó la CI.

---

## El archivo `.env`

```bash
cp .env.example .env
```

El [`.env.example`](https://github.com/sedecim-com/Accounting/blob/main/.env.example) lleva sus propias notas en español; esta sección las amplía. El archivo real **nunca se versiona**, y el asistente de `init` lo escribe con permisos `600` porque carga secretos.

### `NODE_ENV`

`development` mientras trabajas en tu máquina. Es lo que decide si el proceso tolera los secretos de desarrollo; ver abajo.

### `PORT`, `API_VERSION`, `APP_NAME`

Sólo los usa el servidor REST (`npm start`). El CLI los ignora. `APP_NAME=mnemosine` es cosmético: si la variable falta, el código cae a `accounting-core`, que es el nombre del paquete.

### `DATABASE_URL`

La cadena de conexión de la **aplicación**. Va como el rol `mnemosine_app`: sólo DML, no posee nada, sujeto a RLS. Sin contexto de inquilino no ve una sola fila, y eso es correcto.

En una instalación de desarrollo sin roles provisionados puedes apuntarla a tu superusuario y todo «funcionará» — con la trampa de que RLS no filtrará nada y una política ausente jamás se notará. `doctor` te lo dirá con todas sus letras en la comprobación `Tenant isolation`.

### `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX`

Tamaño del pool. El `.env.example` sugiere `2` y `10`; si las dejas vacías el código usa `5` y `20`.

### `MIGRATION_DATABASE_URL`

La cadena del **operador**: el rol `mnemosine_owner`, dueño del esquema, el único que hace DDL. La usa exclusivamente `npm run migrate`. Si está vacía, cae a `DATABASE_URL`, que es lo habitual en desarrollo y lo incorrecto en cualquier otro sitio.

### `REDIS_URL`

Opcional. Vacía significa `redis://localhost:6379`, y si ahí no hay nadie, no pasa nada (ver arriba).

### `JWT_SECRET`, `JWT_ACCESS_EXPIRATION`, `JWT_REFRESH_EXPIRATION`

Firma de los tokens de acceso de la API REST. Las dos expiraciones tienen un detalle que conviene saber: el `.env.example` trae `15m` y `7d`, pero si **borras** esas líneas el código no se queda sin valor, cae a `1h` y `30d`. Vacío no es lo mismo que ausente en tu cabeza, pero para `process.env` sí lo es: ambos casos caen al valor por omisión del código.

### `ENCRYPTION_KEY`

64 caracteres hexadecimales — 32 bytes:

```bash
openssl rand -hex 32
```

Cifra las cuentas bancarias, las CLABE y el material de la e.firma y los CSD.

### Por qué `JWT_SECRET` y `ENCRYPTION_KEY` pueden ir vacías en desarrollo

Porque el código tiene valores por omisión para las dos, y en desarrollo son exactamente lo que quieres: nada que generar, nada que compartir entre quienes trabajan en el proyecto, la suite de pruebas corriendo sin ceremonia.

Y ése es justamente el peligro. Un valor por omisión de desarrollo que sobrevive a producción no es un secreto débil: es un secreto **publicado**. `dev-secret-change-me` está en este repositorio, así que cualquiera con una copia puede fabricar un token de acceso para cualquier inquilino y cualquier rol. Y una llave de cifrado de 32 bytes de ceros significa que las cuentas bancarias y las credenciales fiscales están guardadas en algo que parece texto cifrado y no lo es.

Por eso [`src/config/index.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/config/index.ts) **lanza y se niega a arrancar** con `NODE_ENV=production` mientras cualquiera de los dos siga puesto. Tres decisiones dentro de ese cerrojo merecen explicación:

1. **No es una advertencia.** Una advertencia en una bitácora que nadie lee es precisamente cómo esta clase de defecto llega a producción.
2. **Reconoce más de un secreto.** La lista `PUBLISHED_JWT_SECRETS` incluye el valor por omisión del código *y* el que `docker/docker-compose.yml` le pasa al contenedor, que es otra cadena distinta e igualmente legible por cualquiera con un clon. Una puerta que sólo conociera el primero dejaría arrancar un compose volteado a producción y se declararía comprobada.
3. **Se dispara al importar el módulo, no al levantar el servidor.** Así cubre también al CLI y al corredor de migraciones: un operador que corre `mnemosine` contra producción sin `ENCRYPTION_KEY` está escribiendo las mismas filas desprotegidas que escribiría la API.

### Por qué `ENCRYPTION_KEY` hay que fijarla ANTES de la primera escritura

Es cifrado simétrico: los datos escritos con una llave sólo se leen con esa llave. Cambiarla después vuelve **ilegible** todo lo ya cifrado — las cuentas bancarias de los proveedores, las CLABE, el material de la e.firma. No hay rotación automática ni recifrado en la puesta en marcha, así que el momento barato de decidirla es antes de que exista la primera fila; después ya no es un cambio de configuración, es una migración de datos que nadie escribió.

Si arrancaste con la llave de ejemplo, `doctor` no lo tolera: `ENCRYPTION_KEY is the EXAMPLE key (zeros)` sale como `fail`, no como advertencia.

### `MNEMOSINE_TENANT`

El inquilino por omisión del CLI. Tiene su sección propia más abajo.

### `TEST_ADMIN_DATABASE_URL`

Sólo para `npm run test:integration`, que crea y destruye una base efímera por corrida y por tanto necesita un rol con `CREATE DATABASE`. `mnemosine_owner` **no** lo tiene, a propósito. Detalles en [[Pruebas-y-CI]].

### Lo que `.env.example` no lista

El ejemplo es el mínimo para trabajar, no el inventario completo. `src/config/index.ts` también lee, entre otras: `DATABASE_SSL_MODE` y `DATABASE_SSL_CA` (TLS; sin valor explícito se infiere `disable` en local y `verify-full` fuera), `DATABASE_SSH_HOST` y compañía (túnel SSH hacia una base autoalojada, para no exponer el 5432 a internet), `DATABASE_PROVIDER`, `AUTH_OIDC_*` (identidad externa), `PAC_*`, `SAT_STATUS_MODE`, `RATE_LIMIT_*`, y las dos banderas de apagado que menciona [[Home]]: `GRAPHQL_ENABLED` y `PUBLIC_VERIFICATION_ENABLED`.

---

## Los dos roles de base

No es una formalidad de despliegue: es la pieza sin la cual el aislamiento entre clientes no significa nada.

**`mnemosine_app`** es la aplicación. Hace `SELECT`, `INSERT`, `UPDATE`, `DELETE` y nada más: sin DDL, sin `TRUNCATE`, sin `REFERENCES`, sin `CREATE` en el esquema. No posee ninguna tabla.

**`mnemosine_owner`** es el operador. Posee el esquema, corre las migraciones, entra por túnel, y es también el break-glass.

Son dos por dos razones que se cumplen a la vez:

- Ambos se crean `NOSUPERUSER` y **`NOBYPASSRLS`**. Ésa es la línea que hace que las políticas signifiquen algo: un rol que ignora RLS convierte cada política en decoración.
- Las tablas tienen que **pertenecer** al operador. `FORCE ROW LEVEL SECURITY` necesita a quién forzar; si las tablas siguen siendo de `postgres`, la RLS nunca se evalúa. El guion de provisión reasigna la propiedad por eso.

Hay además dos roles `NOLOGIN` que nadie usa para conectarse y que existen para problemas concretos: `mnemosine_verifier` (se asume con `SET LOCAL ROLE` dentro de la transacción de una consulta pública) y `mnemosine_refresher` (dueño de las vistas materializadas, porque un `REFRESH` corre la consulta definitoria como el dueño de la vista y un dueño sujeto a RLS reconstruiría la vista global con los lentes del inquilino que traiga la sesión — o vacía). El porqué completo está en [[Aislamiento-multi-inquilino]].

### Por qué los roles NO van en una migración

Porque son objetos de **nivel clúster**, no de esquema, y crearlos exige superusuario. El corredor de migraciones conecta como `mnemosine_owner`, que se crea `NOCREATEROLE` a propósito: literalmente no puede. Meterlos en la cadena de migraciones obligaría a correr las migraciones como superusuario, que es exactamente lo que este diseño evita.

Por eso viven aparte, en [`scripts/provision-roles.sql`](https://github.com/sedecim-com/Accounting/blob/main/scripts/provision-roles.sql), y se corren una vez a mano:

```bash
psql "$SUPERUSER_URL" -v app_pw="$MNEMOSINE_APP_PASSWORD" -v owner_pw="$MNEMOSINE_OWNER_PASSWORD" -f scripts/provision-roles.sql
```

El guion es idempotente y está pensado para reejecutarse: sirve tanto sobre un clúster recién creado, antes de la primera migración, como sobre una base ya migrada. Termina imprimiendo una tabla de verificación con `es_superusuario`, `ignora_rls` y `puede_entrar` para los tres roles con nombre — léela, es el punto entero del paso.

Un detalle que el propio archivo documenta como cicatriz: el `GRANT ... ON ALL TABLES` dice **todas** y lo dice en serio, así que reprovisionar sobre una base migrada le devolvía a la aplicación `UPDATE` y `DELETE` sobre `audit_log` y sobre la bitácora de accesos a la e.firma, deshaciendo en silencio lo que dos migraciones habían revocado. Hoy un bloque posterior vuelve a revocar esas dos tablas de sólo agregar, y un criterio de `plan:status` compara esa lista contra la de `rls-policies.sql` y falla si divergen.

**Orden correcto:** provisionar roles → migrar. Al revés, el bucle de `GRANT` de `rls-policies.sql` no encuentra a quién otorgar y sale sin hacer nada.

---

## Crear la base y migrar

```bash
createdb mnemosine
```

```bash
npm run migrate
```

Qué hace [`src/database/migrate.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrate.ts), en orden:

1. Abre un pool **propio** (`max: 1`) con `MIGRATION_DATABASE_URL`. No importa el pool de `connection.ts` a propósito: ése lleva el contexto de inquilino y el rol sin DDL.
2. Crea `public.migrations` si no existe.
3. Comprueba que ningún número de tres dígitos esté repetido. Hay cuatro duplicados históricos tolerados —`012`, `014`, `015`, `018`— que ya están aplicados en bases desplegadas y renumerarlos rompería instalaciones. Cualquier duplicado **nuevo** aborta la corrida y el mensaje te dice cuál es el siguiente número libre.
4. Aplica cada `.sql` pendiente. El `.sql` y su renglón en `public.migrations` van dentro de **una sola transacción**: antes eran dos, y un fallo entre ambas dejaba la migración aplicada y sin registrar, de modo que la siguiente corrida la re-ejecutaba —lo que revienta en cualquier migración no idempotente y, peor, vuelve a correr los rellenos de datos.
5. En el `finally` —siempre, incluso si una migración falló a mitad— reaplica [`src/database/rls-policies.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-policies.sql). Este paso estaba dentro del `try` y un fallo se lo saltaba: las migraciones que sí se habían aplicado quedaban con sus tablas creadas y sin política. Ésa es la fuga silenciosa que el bloque existe para impedir.
6. Sale con código 1 si algo falló, aunque el endurecimiento haya corrido.

Hoy son 52 migraciones con cabeza `047` y 99 tablas; para no fiarte de este párrafo, pregúntalo: `npm run mnemosine -- doctor` reporta cuántas hay aplicadas. La numeración, los rangos y los duplicados están en [[Base-de-datos-y-migraciones]].

---

## Sembrar datos de demostración

```bash
npm run seed
```

Crea un inquilino `Demo Company`, un usuario `admin@demo.com`, una organización, una entidad legal `Demo Corp MX` (RFC genérico `XAXX010101000`, MXN, norma `mx_nif`), el ejercicio fiscal 2026 con sus doce periodos —los tres primeros abiertos, el resto en `future`—, un catálogo de cuentas mexicano, un cliente, un proveedor y una cuenta bancaria.

Al terminar imprime un recuadro con el **Tenant ID**, el **Entity ID** y el **User ID**. Ahí es de donde sale el UUID que va en `MNEMOSINE_TENANT`; anótalo antes de limpiar la terminal.

**Una trampa que vale la pena conocer.** `seed` escribe a través del módulo de conexión normal, es decir con `DATABASE_URL`, y lo primero que hace es insertar la fila del inquilino. Si ya provisionaste los roles, esa cadena apunta a `mnemosine_app`, que está sujeto a RLS y todavía no tiene contexto de inquilino al que acogerse. La CI resuelve esto de la forma explícita: en el job de aislamiento corre `npm run seed` con `DATABASE_URL` sobreescrito a la cadena de migración ([`.github/workflows/ci.yml`](https://github.com/sedecim-com/Accounting/blob/main/.github/workflows/ci.yml)). Haz lo mismo en local si ya separaste los roles:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run seed
```

---

## `MNEMOSINE_TENANT`, y qué hacer sin ella

Con RLS activa, cada comando necesita saber **sobre qué inquilino** trabaja. La precedencia es: bandera `-T, --tenant <uuid>` primero, variable `MNEMOSINE_TENANT` después.

El inquilino se fija en un gancho `preAction` de commander, es decir **antes** de que corra el comando. Eso es deliberado: si se fijara dentro de cada acción, la propia resolución de entidades ocurriría sin lentes y `entities` vería las entidades de todos los clientes.

Pega el UUID en el `.env`:

```bash
MNEMOSINE_TENANT=<el Tenant ID que imprimió el seed>
```

**Si no la pones**, no revienta nada: los comandos corren sin contexto y las consultas no ven filas. La pista aparece donde más se nota — `entities` responde `No entities visible. If the database enforces tenant isolation, specify one with --tenant <uuid> or MNEMOSINE_TENANT.` — y `status` reporta `no tenant context`. Para una corrida suelta contra otro cliente, la bandera basta:

```bash
npm run mnemosine -- -T <uuid> entity list
```

Los únicos comandos que no exigen base de datos son `lang` y su alias `idioma`, que sólo leen y escriben un JSON local.

---

## El camino asistido, si lo prefieres

```bash
npm run mnemosine -- init
```

Es un asistente en seis secciones, en un orden que no es arbitrario: cada una supone resueltas las anteriores. Sin base de datos no hay entidad; sin entidad no hay usuarios a quién atribuir; sin proveedor no hay agente; las políticas necesitan que la entidad exista para poder previsualizar su efecto sobre datos reales; y la importación va al final porque necesita entidad **y** proveedor, y es el puente de la instalación al trabajo de verdad.

- `infra` — `.env`, conexión, migraciones, llave de cifrado. Reutiliza las mismas comprobaciones de `doctor`, más una prueba de humo de RLS: entra al inquilino fijado y corre un `SELECT` con alcance, de modo que la cadena entera (variable → `set_config` dentro de la transacción → política) se ejercita de verdad en vez de suponerse.
- `identity` — la entidad legal, y escribe `MNEMOSINE_TENANT` en el `.env`.
- `users` — los usuarios y sus roles.
- `ai` — el proveedor de modelo (ver [[Proveedores-de-modelo]]).
- `policies` — las decisiones contables del panel.
- `import` — traer la contabilidad de un sistema externo.

Admite `--status` para sólo ver el estado, `--section <id>` para una sola, y `-y` para no preguntar nada. El asistente **no guarda un archivo de estado**: el estado es el sistema, y se vuelve a derivar en cada invocación. Por eso invocar `mnemosine` a secas en una máquina virgen ofrece el asistente en vez de fallar.

---

## El primer ciclo real de trabajo

Cuatro comandos. Es todo el lazo: la IA propone, tú dispones, y el mayor cambia.

### 1. Ingesta

```bash
npm run mnemosine -- ingest facturas/*.xml
```

Toma CFDI en XML y los pasa por tres capas: reglas del despacho, clasificación con el modelo, y plan de asiento. El XML lo escribió un tercero, así que entra envuelto como **no confiable**: es dato, jamás instrucción.

El comando está declarado `irreversible` en el núcleo del CLI, lo que le añade `--dry-run`, `--yes` e `--idempotency-key` y **se lo niega al agente**. Con `--dry-run` corre sólo la capa determinista sin escribir nada, sin llamar al validador del SAT y sin llamar al modelo, y dice qué no calculó.

Por omisión **todo queda en borrador**. El auto-posteo se decide por precedencia —bandera > archivo del operador > política del panel > omisión— y `--no-auto-post` gana siempre. Aun encendido, `FLOOR_MAX_AUTO_POST` (50 000 en la moneda funcional de la entidad) recorta cualquier tope configurado por encima: un asiento más grande espera a un humano, diga lo que diga la configuración.

### 2. Ver lo que propuso

```bash
npm run mnemosine -- drafts
```

Lista los borradores con su fecha, descripción, número de renglones, confianza y estado. Se filtra con `-s pending_review | approved | rejected`.

### 3. Aprobar o rechazar

```bash
npm run mnemosine -- review
```

La cola interactiva. **Aprobar postea de verdad**: crea `journal_entries` y `journal_entry_lines` posteados. También está declarado `irreversible` y negado al agente. El borrador aprobado no toma un atajo hacia la base: entra por `createJournalEntry`, con todas las validaciones del motor, incluida la de que el periodo esté abierto —una regla que se revalida bajo el candado de fila, no sólo antes—.

`--dry-run` te muestra la cola completa sin abrir el prompt: lo que verías, sin poder aprobar nada.

### 4. Ver el efecto

```bash
npm run mnemosine -- report trial-balance show
```

Cargos, abonos y saldo final por cuenta, con su suma. Acepta acotar por periodo (`--as-of`, `--since`/`--until`), resumir a un nivel de cuenta (`--level`) y omitir saldos en cero (`--exclude-zero`). Nota que `report trial-balance` a secas es un menú, no un comando: la hoja es `show`.

La superficie completa está en [[Catalogo-de-comandos]] y, exacta y generada del propio binario, en [`src/ai/docs/cli-reference.md`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/docs/cli-reference.md).

---

## Cómo saber que quedó bien

```bash
npm run mnemosine -- doctor
```

Diseñado para responder «¿por qué no funciona?» sin leer código: cada comprobación dice qué está mal **y el comando que lo arregla**, nunca sólo el síntoma. Sale con código 1 únicamente si hay `fail` — un `warn` no debe romper una tubería de CI —, y admite `--json` para consumirlo desde un guion.

Lo que revisa, en orden. Si la base no responde, se detiene ahí y sólo evalúa lo que no la necesita: sin base, las demás comprobaciones no significan nada.

| Comprobación | Qué responde |
|---|---|
| `Database` | Si hay conexión, y con qué versión. |
| `Migrations` | Cuántas aplicadas, y cuáles faltan por aplicar. |
| `Legal entities` | Cuántas entidades activas hay. Cero es lo que ves antes del `seed` o del `init`. |
| `Account roles` | Si el catálogo tiene mapeados los roles de cuenta que el motor necesita — incluidas las **cuatro** de IVA: acreditable, pendiente de acreditar, trasladado y trasladado no cobrado. México acredita el IVA al pago, así que sin las cuatro el mayor no puede expresar el tratamiento que exige la ley. |
| `Payroll GL mapping` | Si la nómina puede postear. Es `fail` sólo si la entidad tiene empleados activos: una entidad sin empleados no está mal configurada por no tener mapeo. |
| `SAT product-code mapping` | Calidad, no bloqueo: sin mapeo de `ClaveProdServ` cada CFDI recibido cae a la conjetura por patrón histórico. |
| `Employer tax liabilities (USA)` | `fail` si hay empleados activos en EE. UU., por la razón de la portada: las formas 940 y 941 suman esa tabla y con cero filas declaran cero impuesto patronal. |
| `Orphaned capability` | Tablas con lector y sin escritor, y exportaciones sin consumidor. Nunca es `fail`: lee sólo el código y desde el código no se puede saber si esta instalación usa esa capacidad. |
| `Connection transport` | TLS y túnel: si vas cifrado y si de verdad estás verificando el certificado. |
| `CLI consistency` | Si el árbol del binario sigue casando con lo declarado. |
| `Tenant isolation` | **La importante.** No pregunta si RLS está activa, sino si además **significa algo**: si el rol con el que estás conectado es superusuario o tiene `BYPASSRLS`, reporta que la ignora y te dice que conectes como `mnemosine_app`. La diferencia entre creer que hay aislamiento y tenerlo. |
| `Ledger integrity` | Si el mayor cuadra. |
| `Segregación de funciones (permisos)` | Permisos que, juntos, dejan a una persona ser quien propone y quien aprueba. |
| `Reopened periods` | Periodos que se reabrieron y siguen abiertos. |
| `Pending work` | Qué hay en cola esperando a un humano. |
| `Fiscal credentials` | Vigencia de la e.firma y los CSD. |
| `Model provider` | Qué perfil resuelve y con qué modelo. |
| `Encryption key` | Si es tuya, si falta (`warn`) o si es la de ejemplo o mide mal (`fail`). |

Una corrida limpia sobre la instalación de demostración termina en `All good.` o en `Operational with warnings.` — lo segundo es normal si no cargaste credenciales fiscales ni configuraste un proveedor de modelo.

Y para saber en qué estado está el **proyecto**, no tu instalación, pregúntaselo a los dos medidores: `npm run plan:status` y `npm run catalogo:estado`. Cómo leerlos, en [[El-tablero-y-los-criterios]].
