# Solución de problemas

Cada entrada tiene la misma forma: **síntoma → causa → arreglo**. Están derivadas
de lo que el código lanza de verdad y de las trampas que este proyecto ya se puso
a sí mismo, no de una lista genérica.

Antes de nada: hay un comando que responde por casi todas ellas de una vez.

```bash
npm run mnemosine -- doctor
```

Comprueba base, migraciones, entidades, roles de cuenta, transporte de la
conexión, aislamiento por inquilino, credenciales fiscales, proveedor de modelo,
llave de cifrado e integridad del mayor. Sale con código 1 sólo ante fallos: un
aviso no rompe una tubería.

## El código de salida ya te dice de qué familia es el problema

El CLI tiene una sola tabla de códigos, publicada en
[`src/cli/kernel/exit.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/kernel/exit.ts).
Antes de leer el mensaje, mira `echo $?`:

| Código | Significa |
|---:|---|
| 0 | Bien, incluida una comprobación limpia |
| 1 | Fallo genérico |
| 2 | Error de uso: bandera mala, argumento que falta |
| 3 | No existe la entidad, el asiento, la cuenta, el periodo o el documento |
| 4 | Validación fallida, o una comprobación **que encontró** hallazgos bloqueantes |
| 5 | Bloqueado por estado: periodo cerrado, asiento ya posteado, credencial vencida |
| 6 | Conflicto: misma clave de idempotencia con cuerpo distinto |
| 7 | Permiso denegado: RLS, rol, acceso a la entidad, política de aprobación |
| 8 | Servicio externo falló (PAC, SAT, banco). **Reintentable** |
| 9 | Servicio externo **rechazó**. No reintentable: reintentar a ciegas quema presupuesto |
| 10 | Abortado por ti al declinar una confirmación |
| 11 | Necesita humano: hay una pregunta abierta o un borrador esperando revisión |

Los dos que cargan significado más allá de «falló» son el **4** y el **11**. El 4
existe para que una comprobación se pueda meter en CI sin envolturas: encontró
algo. El 11 dice que el trabajo **no falló**, está esperando a una persona. Y una
comprobación que no pudo correr —sin conexión, con selector malo— sale 1, 2, 3 u
8, nunca 4: confundir «encontré problemas» con «no pude mirar» es la forma más
limpia de que una tubería verde mienta.

---

## Un comando devuelve cero filas, o dice que no encuentra nada

**Síntoma.** `No entities are visible…`, `No active entity matches "…"`, un
listado vacío donde ayer había datos, o un `report` que sale sin renglones.

**Causa.** Falta el contexto de inquilino. La aplicación conecta como
`mnemosine_app`, un rol **sujeto a RLS**, y sin `app.current_tenant` puesto la
política no devuelve nada. Bajo RLS «no existe» y «no es tuyo» son
indistinguibles desde la consulta: eso es a propósito —un 403 confirmaría que el
recurso existe— pero significa que un olvido de contexto se parece a una base
vacía.

**Arreglo.** Fija el inquilino. La precedencia es `--tenant` > `MNEMOSINE_TENANT`
> lo que ya traiga la entidad resuelta.

```bash
npm run mnemosine -- -T <uuid-del-inquilino> entity list
```

O déjalo en `.env` como `MNEMOSINE_TENANT=<uuid>`; `mnemosine init` lo escribe
ahí solo. Si no sabes cuál es tu UUID, `mnemosine doctor` lo dice indirectamente:
la comprobación «Legal entities» cuenta activas, y si el rol ignora RLS las verá
todas.

El propio mensaje distingue los dos casos y merece leerse entero: cuando **no**
hay contexto dice «especifica uno con `--tenant` o `MNEMOSINE_TENANT`»; cuando sí
lo hay dice «no hay entidades activas en este inquilino». Son diagnósticos
distintos.

**Variante.** `La entidad X pertenece al inquilino A y el contexto activo es B`.
Ahí el contexto está puesto y está **mal**: corrígelo o quítalo. En el servidor,
el inquilino lo fija el token y jamás la cabecera `x-entity-id`.

---

## `permission denied` sobre una tabla que acabas de crear

**Síntoma.** Una migración corrió sin quejarse y semanas después la aplicación
falla con `permission denied` sobre esa tabla —o sobre su secuencia—, mientras
`psql` como superusuario la lee sin problema.

**Causa.** El bloque de auto-reparación de privilegios de
[`src/database/rls-policies.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-policies.sql)
recorre las tablas del esquema `public` **cuyo dueño es el rol que está
corriendo** (`c.relowner = current_user`) y les otorga a `mnemosine_app`. Una
tabla creada por **otro** rol no entra en ese recorrido: nace invisible para la
aplicación y el síntoma aparece mucho después. Es exactamente lo que le pasó a
siete tablas de este repositorio mientras `MIGRATION_DATABASE_URL` no existía.

**Arreglo.** Primero, que la migración la corra el dueño del esquema —ver la
entrada siguiente—. Si la tabla ya nació torcida, devuélvele el dueño y vuelve a
migrar; el endurecimiento se reaplica **después de cada corrida de migraciones**,
así que basta con eso:

```bash
psql "$MIGRATION_DATABASE_URL" -c 'ALTER TABLE public.<tabla> OWNER TO mnemosine_owner'
```

```bash
npm run migrate
```

**Caso hermano, más silencioso.** Si la tabla nueva tampoco quedó con política de
RLS, no vas a ver `permission denied`: vas a ver **filas de otros inquilinos**.
La razón de que `rls-policies.sql` sea idempotente y se reejecute siempre es una
cicatriz: una migración de endurecimiento protege lo que existe cuando corre, y
`ai_external_ops` nació nueve minutos después, sin política y en silencio. Si
tocas RLS o migraciones, reproduce el job de aislamiento en local antes del PR
(está en [[Pruebas-y-CI]]).

---

## Las migraciones no aplican, o el rol no puede crear nada

**Síntoma.** `npm run migrate` falla con un error de permisos de Postgres al
crear una tabla, un tipo o un índice. O corre «bien» y `mnemosine doctor` sigue
diciendo `Migrations: N unapplied`.

**Causa.** Confusión entre las dos cadenas de conexión. Son dos roles distintos
con dos atribuciones distintas, y no es un detalle de configuración: es el diseño
del aislamiento.

| Variable | Rol | Para qué |
|---|---|---|
| `DATABASE_URL` | `mnemosine_app` | Lo que corre la aplicación y el CLI. Sujeto a RLS, sólo DML, **no posee nada** |
| `MIGRATION_DATABASE_URL` | `mnemosine_owner` | Sólo `npm run migrate`. Posee el esquema y puede hacer DDL |

[`src/database/migrate.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/migrate.ts)
abre su **propio** pool contra `migrationUrl` y no importa el de la aplicación a
propósito. Y si `MIGRATION_DATABASE_URL` no está definida, cae a `DATABASE_URL`:
ahí es donde nace el problema, porque la caída es silenciosa y el rol de la
aplicación no puede hacer DDL.

Que `doctor` siga acusando migraciones sin aplicar después de una corrida que
pareció ir bien tiene explicación: cada archivo se ejecuta y se anota en
`public.migrations` dentro de **una sola transacción**. Si el DDL falla, el
`ROLLBACK` deshace las dos cosas. No queda a medias, pero tampoco queda.

**Arreglo.** Define las dos, y crea los roles antes si no existen. Los roles son
objetos de nivel clúster, así que no están en la cadena de migraciones:

```bash
psql "$SUPERUSER_URL" -v app_pw=... -v owner_pw=... -f scripts/provision-roles.sql
```

```bash
export MIGRATION_DATABASE_URL=postgresql://mnemosine_owner:...@localhost:5432/mnemosine
```

```bash
npm run migrate
```

**Si el error es «números de migración duplicados».** No es un bug: es la guarda
`assertNumeracionUnica`, que rechaza cualquier prefijo repetido y te dice cuál es
el siguiente número libre. Hay cuatro duplicados históricos tolerados —012, 014,
015 y 018— porque ya están aplicados en bases desplegadas y renumerarlos rompería
instalaciones. Cualquier duplicado nuevo es un error tuyo. El reparto de rangos
está en [`docs/migraciones.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/migraciones.md).

---

## La suite de integración se niega a arrancar

**Síntoma.**

```
La suite de integración necesita TEST_ADMIN_DATABASE_URL (un rol con CREATE DATABASE)
o, en su defecto, MIGRATION_DATABASE_URL / DATABASE_URL.
```

**Causa.**
[`tests/integration/global-setup.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/global-setup.ts)
**crea y destruye una base efímera por corrida**, con nombre aleatorio. Para eso
necesita un rol con `CREATE DATABASE`, que deliberadamente **no** es
`mnemosine_owner`: crear bases no es atribución del dueño del esquema.

**Arreglo.**

```bash
export TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
```

**El matiz que ahorra media hora.** La variable tiene respaldo: si no está, el
setup cae a `MIGRATION_DATABASE_URL` y luego a `DATABASE_URL`. Sólo se niega a
arrancar si **ninguna** de las tres existe. Si defines alguna con un rol que no
puede crear bases, el mensaje que verás **no** será ése, sino un
`permission denied to create database` de Postgres, ya dentro del setup. Si te
topaste con eso, el problema no es que falte la variable: es que apunta al rol
equivocado.

Dos cosas más de esa suite, dichas por si te sorprenden: corre **en serie** a
propósito, porque varias pruebas cuentan filas sobre una base compartida; y corre
como superusuario también a propósito, porque varias pruebas necesitan verificar
que un disparador rebota incluso al rol más privilegiado. El aislamiento se
prueba en otro job, conectando como `mnemosine_app` — ver [[Pruebas-y-CI]].

---

## El agente conversa pero nunca consulta el mayor

**Síntoma.** `mnemosine chat` responde con soltura sobre contabilidad, pero no
lee documentación, no consulta saldos y no deja borradores. O peor: cita cifras y
comandos que suenan razonables y no existen.

**Causa.** Una de dos, y se distinguen en un comando.

**(a) El perfil declara `tools: false`.** Dos perfiles predefinidos lo hacen y no
es un defecto: `hermes-agent` y `openclaw` son pasarelas locales que **corren sus
propias herramientas del lado del servidor** y no devuelven las llamadas al
cliente. Por ese canal las herramientas contables no se invocan nunca. El código
lo trata explícitamente: con `tools: false` la sesión se construye con cero
herramientas y el prompt de sistema recibe una nota que le prohíbe citar cifras,
endpoints o flujos como si fueran reales.

**(b) El modelo no soporta *tool calling*.** Es el caso típico de un modelo local
pequeño servido por Ollama. El perfil sí manda las herramientas; el modelo no las
usa.

**Arreglo.** Pregúntale al CLI qué perfiles hay y qué declara cada uno:

```bash
npm run mnemosine -- providers
```

Cada renglón imprime `tools` o `no tools` junto al tipo, el modelo, la URL base y
si la variable de la credencial está puesta. Si el tuyo dice `no tools`, cambia
de perfil (`--provider`, `MNEMOSINE_PROVIDER` o `default_provider`). Si dice
`tools` y aun así el modelo no las llama, el problema es el modelo: elige uno
instalado que soporte funciones.

**Cómo saber si te está pasando sin darte cuenta.** El arnés tiene una red:
cuando un turno produce una respuesta sustantiva con **cero** llamadas a
herramienta y la sesión no ha consultado documentación en absoluto, inyecta un
turno correctivo que obliga al modelo a fundamentarse o a declarar que su
respuesta no contenía hechos del sistema. Ocurre como máximo una vez por sesión —
la red cierra el peor modo de fallo, no persigue al modelo en bucle— y **queda
registrada**:

```bash
npm run mnemosine -- ai stats
```

El renglón de eventos cuenta `nudge(s) de grounding`. Un número alto ahí quiere
decir que tu modelo está contestando de memoria, y eso en un sistema contable es
una respuesta inventada con formato de dato.

---

## Un reporte sale vacío, o con cifras viejas

**Síntoma.** La balanza o el resumen de saldos no cuadran con lo que sabes que
está posteado, o salen en ceros después de una carga masiva, una migración o una
restauración.

**Causa.** Las vistas materializadas `mv_trial_balance` y
`mv_account_balance_summary` se refrescaban por disparador ante **una sola
transición**: un asiento pasando a `posted`. La migración 042 quitó ese
disparador, porque cada posteo pagaba un refresco proporcional a la instalación
entera y los posteos de inquilinos distintos se serializaban entre sí. Desde
entonces el refresco es un **comando**, nunca un efecto secundario de una
lectura: un reporte que reconstruyera una vista en silencio sería una lectura que
toma un candado, cuesta segundos y cambia lo que ve el siguiente lector.

Cualquier otro camino por el que lleguen filas al mayor —una migración, una carga
masiva, un cambio de estado que no sea un posteo— deja las vistas atrás.

**Arreglo.** Primero pregunta, que es barato y no toma candados:

```bash
npm run mnemosine -- report view show
```

Compara los totales de cada vista contra el mayor vivo y **dice de cuánto es la
deriva**, con signo. Si algo está caduco, avisa. Después reconstruye:

```bash
npm run mnemosine -- report view sync
```

Ese sí está declarado `escritura` y **cerrado al agente**: toma candados, cuesta
tiempo real sobre un mayor grande y cambia lo que ven todos los demás lectores.
No es entity-scoped: una vista materializada cubre la instalación entera.

**El falso positivo que hay que conocer.** `mv_trial_balance` se agrupa por
periodo fiscal, así que sólo cubre asientos que llevan un `fiscal_period_id` de
esa entidad. Un asiento posteado **fuera de todo periodo** aparece como deriva
aunque la vista esté perfectamente fresca — lo cual, en sí mismo, es algo que te
conviene saber.

---

## El arranque se niega en producción

**Síntoma.** El proceso muere al importar, antes de servir una sola petición, con
`Refusing to start with NODE_ENV=production and development secrets:` o con
`RolIgnoraRlsError`.

**Causa y arreglo.** Son dos compuertas distintas, las dos deliberadamente
ruidosas. Un aviso en una bitácora que nadie lee es precisamente cómo esta clase
de defecto llega a producción.

**(a) Secretos de desarrollo.**
[`src/config/index.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/config/index.ts)
comprueba dos valores. Un `JWT_SECRET` que está **en este repositorio** no es un
secreto débil: es un secreto **publicado**, y quien tenga una copia del código
puede firmar un token para cualquier inquilino y cualquier rol. Y una
`ENCRYPTION_KEY` de 32 bytes de ceros significa que las cuentas bancarias, las
CLABE y las credenciales fiscales están guardadas en algo que parece cifrado y no
lo es.

```bash
openssl rand -hex 32   # ENCRYPTION_KEY: 64 caracteres hexadecimales
```

Con una advertencia que el propio mensaje incluye: **ponla antes de la primera
escritura**. Cambiarla después vuelve ilegible el texto cifrado que ya existe.

La comprobación se dispara al **importar**, no al arrancar el servidor, así que
también alcanza al CLI y al corredor de migraciones: un operador que corra
`mnemosine` contra producción sin `ENCRYPTION_KEY` escribiría las mismas filas
desprotegidas que escribiría la API.

**(b) Un rol que ignora RLS.**
[`src/database/rls-guard.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-guard.ts)
consulta `pg_roles` al arrancar. Si el rol es superusuario o tiene `BYPASSRLS` y
`NODE_ENV=production`, el proceso **no arranca**: con ese rol la RLS es inerte y
un error de programación que olvide filtrar por inquilino devuelve las filas de
todos en vez de ninguna. Antes esto era un `logger.warn`, también en producción;
el aislamiento entero colgaba de una línea de bitácora.

En desarrollo sigue siendo aviso, porque conectar como superusuario ahí es lo
normal y la suite de integración lo hace a propósito.

```bash
# Lo correcto: conectar como el rol sujeto a políticas
export DATABASE_URL=postgresql://mnemosine_app:...@host:5432/mnemosine
```

```bash
# El break-glass deliberado, que queda escrito en el entorno y en la bitácora
export ALLOW_RLS_BYPASS_ROLE=I_UNDERSTAND
```

Ojo con los Postgres gestionados: hay proveedores cuyo rol por omisión trae
`BYPASSRLS`. La comprobación «Connection transport» de `doctor` publica el aviso
del proveedor cuando lo hay.

---

## Cruzar de entidad devuelve 404, y eso no es un error

**Síntoma.** Pides por su UUID un asiento, una factura o un documento que **sabes
que existe**, y te contesta que no existe. Código de salida 3.

**Causa.** Es el comportamiento correcto y está escrito así a propósito en
[`src/database/scope.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/database/scope.ts).
Cruzar la frontera de entidad devuelve **404, siempre**. Un 403 confirmaría que
el recurso existe, y ese es exactamente el dato que no se puede regalar en un
despacho que lleva los libros de varios clientes.

El filtro va **dentro** del SQL, no en una comparación posterior en TypeScript.
Cero filas significa a la vez «no existe» y «no es tuyo», y no hay ningún punto
del programa donde se puedan distinguir. El patrón anterior —leer primero,
comparar después— fallaba de tres maneras a la vez: dejaba una ventana entre la
comprobación y la escritura, obligaba a que cada llamador se acordara (y
anular una factura por su UUID llegó a crear y contabilizar un asiento espejo en
el mayor de otra entidad), y ramificaba, de modo que la respuesta delataba la
existencia del recurso aunque el código HTTP fuera el mismo.

**Y RLS no sustituye a esto.** RLS acota por **inquilino**. Dentro de un
inquilino con varias entidades legales no acota nada, y ese es justo el eje que
`scope.ts` defiende.

**Arreglo.** Selecciona la entidad correcta, con `--entity <id|RFC|fragmento del
nombre>`:

```bash
npm run mnemosine -- entity list
```

Si tienes varias entidades activas y no seleccionas ninguna, el CLI te lo dice
con la lista y sus UUID en vez de elegir por ti.

---

## Límites de tasa que no cuadran entre instancias

**Síntoma.** La API devuelve 429 antes de lo esperado, o al revés, la cuota
parece multiplicarse: dos instancias detrás de un balanceador dejan pasar el
doble.

**Causa.** Redis está configurado pero inalcanzable. Cuando la operación contra
Redis falla, el limitador **degrada a un contador local en memoria**, no a barra
libre. Ese contador es **por proceso**: varias instancias multiplican la cuota y
un reinicio la olvida.

La decisión está razonada en
[`src/services/cache/redis.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/cache/redis.ts):
un freno imperfecto vence a ninguno, y pesa más desde que `/public/v1` sirve sin
credenciales. Pero Redis sigue siendo lo correcto en producción, y es la única
configuración que le da efecto real al límite.

**Arreglo.** Que Redis responda. Para el CLI no hace falta: Redis es opcional y
sólo lo usan la caché y el limitador de la API.

---

## Cuando nada de esto ayuda

Corre el diagnóstico y guarda su salida legible por máquina:

```bash
npm run mnemosine -- doctor --json
```

Y el estado del plan, que dice qué está cerrado y qué no en este árbol:

```bash
npm run plan:status
```

**Qué adjuntar a un issue** en
[github.com/sedecim-com/Accounting/issues](https://github.com/sedecim-com/Accounting/issues):

- La salida de `mnemosine doctor --json`.
- El comando exacto que corriste y su **código de salida** (`echo $?`).
- La versión de Node (`node -v`) y de Postgres (la imprime la comprobación
  «Database» de `doctor`).
- El commit en el que estás (`git rev-parse --short HEAD`).
- Si el comando acepta `--json`, su salida: lleva el detalle legible por máquina
  del error, que el renglón de `stderr` resume.
- Qué esperabas que pasara. En un sistema contable la mitad de los reportes de
  fallo son en realidad desacuerdos de criterio contable, y ésos no se arreglan
  con un parche: se añaden al panel de políticas.

**Qué no adjuntar, nunca.** Tu `.env`. Ninguna e.firma, ningún CSD, ninguna
contraseña, ningún token. Ningún CFDI de un contribuyente real: llevan RFC,
domicilios e importes. Si necesitas mostrar un XML, usa los genéricos publicados
por el SAT (`XAXX010101000`, `XEXX010101000`) o los fixtures sintéticos del
repositorio.

**Si lo que encontraste es una vulnerabilidad, no abras un issue.** Un diff
público es la divulgación. El canal privado y el orden de prioridades están en
[`SECURITY.md`](https://github.com/sedecim-com/Accounting/blob/main/SECURITY.md);
las cuatro clases que van primero son fuga entre inquilinos, custodia de
credenciales fiscales, escrituras de la IA sin revisión humana e integridad
contable.

## Para seguir

- [[Puesta-en-marcha]] — el arranque limpio, si lo que quieres es empezar de cero.
- [[Aislamiento-multi-inquilino]] — por qué el 404 y el rol `mnemosine_app` son
  el diseño y no un obstáculo.
- [[Base-de-datos-y-migraciones]] — numeración, rangos y los cuatro duplicados
  históricos.
- [[Proveedores-de-modelo]] — perfiles, precedencia y credenciales.
- [[Pruebas-y-CI]] — cómo reproducir en local cada job de la CI.
