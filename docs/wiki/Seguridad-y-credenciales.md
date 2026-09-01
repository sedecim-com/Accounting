# La llave que firma por otro, y el respaldo que no existe

Este sistema custodia la e.firma de contribuyentes reales. Es la misma llave que
firma declaraciones ante el SAT: quien la tiene puede actuar en nombre de una
persona, y la responsabilidad ante la autoridad es de esa persona y no se puede
delegar. Esta página explica cómo está custodiada, qué queda registrado y qué
**no** está resuelto.

---

## Antes que nada: la brecha abierta más grande

El libro mayor es físicamente inmutable desde la migración 041 y las dos
bitácoras críticas son de sólo agregar. Eso es bueno para la integridad y tiene
una consecuencia incómoda que hay que decir en voz alta:

> **Un error de datos en el mayor no se puede reparar a mano.** La salida sería
> restaurar de un respaldo, y **hoy no existe ninguna rutina de respaldo ni de
> restauración en el árbol**.

No hay guion, no hay tarea de `npm`, no hay `pg_dump` en ningún lado.
Compruébalo:

```bash
grep -rn "pg_dump\|pg_restore" src scripts docker package.json
```

Quien opere esto **tiene que resolver su propio respaldo de PostgreSQL** —
snapshots del volumen, *WAL archiving*, lo que su infraestructura permita— antes
de meter datos que le importen. No es una tarea pendiente de la que ya se ocupa
alguien: es un hueco del proyecto, y está señalado como tal en
[`docs/plan-catalogo.md`](https://github.com/sedecim-com/Accounting/blob/main/docs/plan-catalogo.md).

El resto de esta página describe garantías que sí están implementadas.

---

## La bóveda: un solo punto de descifrado

El material de la e.firma —certificado, llave privada y contraseña— **no vive en
Postgres**. La tabla `fiscal_credentials` (migración 014) guarda únicamente la
referencia a la bóveda y los metadatos que permiten operar sin descifrar: RFC,
número de serie, vigencia, tipo. La frase que encabeza esa migración es
comprobable: *un volcado de esta base no contiene la e.firma de nadie*.

La abstracción de bóveda
([`src/services/vault/`](https://github.com/sedecim-com/Accounting/blob/main/src/services/vault/types.ts))
tiene dos implementaciones:

- **`aws-secrets-manager`** — el material vive en AWS; la base guarda el ARN.
- **`local-dev`** — AES-256-GCM contra un archivo de llave con permisos 600, en
  un directorio ignorado por git. **Se niega a construirse con
  `NODE_ENV=production`**, y la fábrica también: sin `VAULT_BACKEND` configurado
  en producción, lanza en vez de caer al respaldo local.

El contexto (`tenantId`, `entityId`, `kind`) viaja con cada operación y el
backend **rechaza** una lectura cuya referencia no corresponda a ese contexto.
Copiar una fila de un inquilino a otro no da acceso al secreto del vecino: eso es
`SecretContextMismatchError`, y su mensaje dice literalmente que se sospecha
manipulación de datos.

Detalle que suele omitirse: la interfaz recibe y devuelve `Buffer`, no `string`.
Una cadena de JavaScript es inmutable y no se puede borrar de memoria. La función
`zeroize` rellena el búfer con ceros y se llama siempre en `finally`.

### `withCredential` es la única puerta

[`src/services/fiscal-credentials/service.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/services/fiscal-credentials/service.ts)
expone **una sola** función que descifra:

```ts
withCredential(entityId, tenantId, opts, async (material, row) => { /* ... */ });
```

Descifra, corre la función, escribe en la bitácora y borra el material de memoria
—incluida la contraseña, que se reasigna a cadena vacía—. Escribe **siempre**:
éxito, negación o error. No hay camino para usar la credencial sin dejar rastro,
y eso es una prioridad declarada en
[SECURITY.md](https://github.com/sedecim-com/Accounting/blob/main/SECURITY.md):
cualquier lectura del material fuera de `withCredential` es una vulnerabilidad,
no un detalle de estilo.

Antes de descifrar comprueba, en este orden: que exista credencial activa, que no
esté vencida (y si lo está, marca la fila como `expired`), que el uso desatendido
esté permitido cuando no hay humano presente, y el techo de accesos diarios.

Ese techo es el **más estricto** entre el de la credencial y el del panel de
políticas, combinados con `Math.min`. Es la única dirección en la que se combinan
topes en esta casa: nunca `Math.max`. Al tocarlo decide la política
`efirma_accion_anomalia`, y **sólo** el literal `alertar` deja continuar; un
valor desconocido, o uno cuya ventana horaria todavía no está implementada,
**niega**. El lado seguro de una credencial es el candado. Sobre el panel de
políticas, [[Fiscal-mexicano]].

### Registrar una credencial

El alta valida **localmente, antes de transmitir**: que el certificado sea una
e.firma y no un CSD (el servicio de descarga masiva del SAT rechaza el CSD), que
la llave privada corresponda al certificado y la contraseña sea correcta, que la
vigencia cubra hoy, y que **el RFC del certificado sea el de la entidad** — para
que nadie suba la e.firma equivocada a la sociedad equivocada.

El consentimiento se guarda con versión, fecha y quién lo dio. Su texto
([`CONSENT_TEXT`](https://github.com/sedecim-com/Accounting/blob/main/src/services/fiscal-credentials/service.ts))
dice lo incómodo sin adornos: que la e.firma tiene la misma validez legal que una
firma autógrafa, que quien la tenga podría firmar declaraciones, que el SAT no
ofrece una credencial de alcance más estrecho para esto, y que existe la
alternativa de correr la descarga en infraestructura propia.

---

## La regla que no se negocia: la e.firma no se pide por chat

El agente no tiene —ni puede tener— una herramienta que reciba llaves. Su
documento de identidad y acceso
([`src/ai/docs/identity-access.md`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/docs/identity-access.md))
se lo dice en una línea: nunca pedirle a la persona que pegue llaves o
contraseñas en el chat; señalarle `mnemosine sat cred add`, que pregunta de forma
segura.

«De forma segura» significa, en
[`src/cli/sat-commands.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/cli/sat-commands.ts):

- La contraseña se pide con **eco apagado**: no queda en pantalla ni en el
  historial del intérprete de comandos.
- El RFC se valida **antes** de pedir la contraseña. Nadie debería teclear la
  frase de paso de su e.firma para enterarse después de que subió el certificado
  equivocado.
- El depósito real exige `--live`. Sin la bandera, el comando valida y se
  detiene: guardar la e.firma en la bóveda es el efecto externo, y es *opt-in*.
- Hay que escribir la palabra `accept`. **`--yes` no salta ese paso**, y está
  dicho en el propio texto de la pregunta.

El límite general del agente —propone, la persona dispone— está en
[[El-agente-y-sus-limites]].

---

## Bitácoras de sólo agregar: dos capas, y qué pasó cuando faltó una

Dos tablas son de **sólo `INSERT`**:

- **`audit_log`** — quién hizo qué (migración 033).
- **`fiscal_credential_access_log`** — quién descifró la e.firma, cuándo y para
  qué (migración 035).

El cierre es de dos capas, y hacen falta las dos:

1. **Privilegios.** `REVOKE UPDATE, DELETE, TRUNCATE` a `mnemosine_app` y a
   `PUBLIC`. Es la barrera barata: Postgres la aplica antes de ejecutar nada.
2. **Disparador.** El dueño del esquema y el superusuario **ignoran los
   privilegios de tabla**, así que la primera capa no los detiene. El disparador
   sí: se dispara para todos por igual, incluido `mnemosine_owner` corriendo
   migraciones. Y como `TRUNCATE` no dispara *triggers* de fila, cada tabla lleva
   además el suyo a nivel de sentencia.

No hay puerta de escape. Un renglón escrito por error se corrige con otro renglón
que lo diga — igual que un asiento equivocado se corrige por reversión y no por
edición (NIF B-1).

### Qué pasó cuando faltó una capa

La migración 014 **creía** haber cerrado la bitácora de credenciales. Su
comentario lo afirmaba con todas las letras: que la aplicación sólo tenía
`INSERT` y `SELECT`, y que ni el código ni un atacante con la conexión de la
aplicación podían borrar el historial.

Era falso desde el primer día, por dos razones independientes:

1. Su único `REVOKE` era `FROM PUBLIC`. Quitarle un privilegio a `PUBLIC` **no
   toca** el `GRANT` explícito que se le hace a `mnemosine_app`, que es
   exactamente el actor del que hablaba el comentario.
2. `rls-policies.sql` se aplica **después** de todas las migraciones, y su lista
   `append_only` sólo contenía `audit_log`. El `GRANT` general le devolvía
   `UPDATE` y `DELETE` en la misma corrida de `npm run migrate` que acababa de
   revocarlos.

Y peor que en `audit_log`: allí, cuando fallan los privilegios, queda el
disparador. Esta tabla no tenía ninguno, así que la capa que fallaba era la única
capa.

Hay un tercer sitio que también las devolvía:
`scripts/provision-roles.sql` concede `SELECT, INSERT, UPDATE, DELETE ON ALL
TABLES`, y lo dice en serio — reprovisionar sobre una base ya migrada deshacía en
silencio lo que las migraciones 033 y 035 acababan de revocar.

### Por eso la lista vive reflejada, y un criterio obliga a que coincida

Hoy el arreglo es que **tres listas tienen que decir lo mismo**:

- las tablas con disparador de sólo agregar, leídas de las migraciones;
- el array `append_only` de
  [`rls-policies.sql`](https://github.com/sedecim-com/Accounting/blob/main/src/database/rls-policies.sql);
- el mismo array en
  [`provision-roles.sql`](https://github.com/sedecim-com/Accounting/blob/main/scripts/provision-roles.sql).

Y el criterio **E0.3** de
[`src/plan/criterios.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/plan/criterios.ts)
las cruza y falla si divergen: una tabla con disparador que falte de cualquiera
de los dos arrays pierde la capa barata en silencio; un nombre en un array sin
disparador que lo respalde es una protección que sólo existe en la lista.

Ese criterio es un buen ejemplo de instrumento afilado a golpes. Tres cosas que
aprendió por las malas:

- **Existe un criterio anterior que da verde con un archivo que sólo revoca.** Su
  regla es «`audit_log` y (`REVOKE` o disparador)», y la migración 014 hacía
  exactamente eso. Un criterio calcado habría declarado protegida una bitácora
  que cualquiera podía reescribir. E0.3 exige la capa que aguanta: el disparador.
- **El SQL se lee sin comentarios, y con el comentario de SQL.** La versión
  anterior quitaba `/* */` y `//` —los de TypeScript— y dejaba pasar `--`, de
  modo que **comentar la tabla dentro del array bastaba** para que el criterio
  siguiera en verde mientras Postgres la dejaba fuera. Se comprobó ejecutándolo.
- **«Hay disparador» y «el disparador rechaza» son cosas distintas.** Uno cuyo
  cuerpo hiciera `RETURN NEW` satisfaría lo primero sin proteger nada. Se exige
  que la función levante excepción **y que rechace siempre**.

Para comprobar el estado hoy, no leas un número escrito aquí:

```bash
npm run plan:status
```

Las pruebas contra Postgres real están en
[`audit-append-only.int.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/audit-append-only.int.spec.ts)
y
[`fiscal-credential-log-append-only.int.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/fiscal-credential-log-append-only.int.spec.ts).

Qué se registra y cómo se consulta: [[Auditorias]].

---

## El mayor inviolable, y por qué la lista blanca va por resta

La migración 041 cerró el hueco que quedaba: la bitácora tenía dos capas, y el
libro mayor —lo que la bitácora existe para proteger— seguía siendo físicamente
reescribible. Ningún disparador impedía un `UPDATE` que cambiara cuenta o monto
de una línea posteada manteniendo el par balanceado (ningún `CHECK` lo ve, y
desalinea `account_balances` sin rastro), ni un `DELETE` del asiento entero.

El patrón **no** es el de sólo agregar: un asiento posteado sí admite escritura
en una lista corta de metadatos, cada uno con su escritor legítimo identificado
por un censo del código:

| Columna | Quién la escribe |
| --- | --- |
| `reversed_by_entry_id` | la reversa, al ligar el espejo |
| `notes` | la anulación, al anexar su constancia |
| `entry_hash`, `blockchain_attestation_id`, `commitment` | la atestación, después de postear |

Todo lo demás —montos, cuentas, fechas, estado, referencia— es el hecho contable,
y un hecho posteado se corrige por reversa, jamás por edición.

La parte interesante es **cómo** se compara. No es una lista de columnas
prohibidas, sino una **resta de JSONB** sobre las permitidas:

```sql
IF OLD.status = 'posted'
   AND (to_jsonb(NEW) - permitidas) IS DISTINCT FROM (to_jsonb(OLD) - permitidas) THEN
  RAISE EXCEPTION ...
```

La elección importa: con una lista de prohibidas, **una columna que alguien añada
mañana nace expuesta** y nadie se entera hasta que se usa. Con la resta, nace
protegida por omisión, y para dejarla escribible hay que decirlo explícitamente
en la lista blanca — un acto que viaja en el diff y que alguien puede discutir en
la revisión.

Dos consecuencias más de esa migración:

- **No hay `REVOKE` ahí**, a propósito. El `GRANT` general de `rls-policies.sql` y
  el reprovisionado lo devolverían en silencio: es la lección exacta que parió a
  E0.3. El disparador es la capa que aguanta, incluso ante el dueño del esquema.
- **Las funciones tienen caminos con `RETURN NEW`**, y eso tiene consecuencia
  para el instrumento: E0.3 distingue «bitácora de sólo agregar» (rechaza
  siempre, sin `RETURN NEW`) de esta clase **condicional**, así que el mayor no
  entra a los arrays `append_only` — que le revocarían el `UPDATE` que el posteo
  mismo necesita.

`TRUNCATE` se bloquea aparte y sin condición, sobre las dos tablas: no existe un
`TRUNCATE` legítimo del libro. Si es una base de pruebas, bórrala entera y vuelve
a migrar.

La prueba vive en
[`tests/integration/mayor-inviolable.int.spec.ts`](https://github.com/sedecim-com/Accounting/blob/main/tests/integration/mayor-inviolable.int.spec.ts).

---

## La consecuencia que nadie quiere escribir

Junta las tres piezas anteriores y sale esto:

- El mayor posteado no admite `UPDATE` ni `DELETE` sobre el hecho contable.
- Las dos bitácoras no admiten `UPDATE`, `DELETE` ni `TRUNCATE`.
- Ninguna de las dos protecciones tiene puerta de escape, y las dos alcanzan al
  dueño del esquema.

Por tanto: **si entran datos malos, no se pueden borrar**. Se corrigen por
reversa mientras el error sea contable —un asiento equivocado se revierte y se
vuelve a hacer, que es lo correcto y lo que pide NIF B-1—. Pero un error que la
reversa no arregla (una carga masiva contra la entidad equivocada, una migración
que escribió basura) sólo tiene una salida real: **restaurar a un punto anterior
en el tiempo**.

Eso vuelve al primer apartado de esta página. La rutina de respaldo y
restauración no existe en el árbol, y hasta que exista, el respaldo de PostgreSQL
es responsabilidad entera de quien opera. Si estás decidiendo si poner datos
reales aquí, éste es el párrafo que importa.

---

## Los secretos de desarrollo están en el repositorio a propósito

Y el arranque **se niega** a correr con ellos:

```
Refusing to start with NODE_ENV=production and development secrets:
```

[`src/config/index.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/config/index.ts)
lanza en tiempo de **importación**, no al levantar el servidor, para que también
alcance a la terminal y al ejecutor de migraciones: un operador corriendo
`mnemosine` contra producción sin `ENCRYPTION_KEY` escribe las mismas filas
desprotegidas que escribiría el API.

El razonamiento vale la pena. Un valor por omisión de desarrollo que sobrevive a
producción no es un secreto **débil**: es un secreto **publicado**. Está en el
repositorio, y cualquiera con una copia puede acuñar un token de acceso para
cualquier inquilino y cualquier rol; y una llave de cifrado de 32 bytes de ceros
significa que las cuentas bancarias, las CLABE y las credenciales guardadas están
en algo que parece texto cifrado y no lo es.

Dos afinaciones que este guardián tiene y que se olvidan fácil:

- La lista de secretos quemados incluye **el que pasa `docker-compose.yml`**
  (`dev-secret-change-in-production`), no sólo el que usa el código por omisión.
  Un archivo de composición al que alguien le cambie el `NODE_ENV` arrancaría con
  un secreto publicado y se reportaría a sí mismo como revisado. La regla es
  **añadir a esa lista, nunca quitar**: un secreto que estuvo en el repositorio
  está quemado aunque ya no sea el valor por omisión.
- No es una advertencia. Una advertencia en una bitácora que nadie lee es
  precisamente cómo esta clase de defecto llega a producción.

Lo que sí está en el repositorio y **no** hace falta reportar está enumerado en
SECURITY.md: los certificados autofirmados de `tests/fixtures/certs/`
(`CN=DEMO CORP MX`), los RFC genéricos publicados por el SAT, y el propio
`dev-secret-change-me`. Lo que sí sería un hallazgo es un camino que los acepte en
producción.

Y una comprobación mecánica que evita el accidente clásico: el criterio **E0.0**
le pregunta a **git** —no al texto del `.gitignore`— si versionaría `.env`,
`.env.local`, `.env.old` y compañía, y además exige que `.env.example` **sí** sea
versionable, para que la excepción siga siendo excepción y el próximo arreglo no
sea aflojar el patrón.

---

## El resto de la postura, en corto

**Roles de base de datos y aislamiento.** El proceso conecta como un rol sujeto a
RLS, y el arranque falla cerrado si no lo es. Todo eso está en
[[Aislamiento-multi-inquilino]], que también explica por qué cruzar la frontera
de entidad devuelve 404 y nunca 403.

**Autenticación.** Verificación dual: el token propio (HS256, firmado con el
secreto de la instancia) y los de un proveedor OIDC (RS256/ES256 contra su JWKS).
La decisión sale del algoritmo del encabezado, no de la configuración, para que el
camino local y el del IdP coexistan. El primer inicio de sesión de una persona
nueva crea su usuario **con cero entidades accesibles**, ligado por
proveedor+sujeto y nunca por correo: verá «sin acceso» hasta que un administrador
se las conceda, y eso es diseño, no falla.

**Credenciales del CLI.** Llavero del sistema primero; archivo con permisos 0600
como último recurso — el patrón de `gh`
([`src/auth/token-store.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/auth/token-store.ts)).
Nunca en archivos de configuración.

**Llaves de proveedores de modelo.** El perfil sólo nombra la **variable de
entorno** (`api_key_env`), jamás la credencial. También admite un comando que
imprime la credencial (`api_key_cmd`, el patrón de git/kubectl/aws), útil para
gestores de secretos. Detalles en [[Proveedores-de-modelo]].

**Cifrado en reposo de datos no-bóveda.** AES-256-GCM para cuentas bancarias,
CLABE y similares, con la llave de `ENCRYPTION_KEY`. Cambiarla después vuelve
ilegible lo ya escrito, así que se fija antes de la primera escritura.

**Limitador de tasa.** Hay uno **antes** de autenticar, con cubeta propia por IP:
sin él, verificar una firma JWT —trabajo de CPU— era gratis para quien no tiene
credenciales, y bastaba con inundar el endpoint con tokens basura. También cubre
`/public/v1`, que sirve sin credenciales. Sin Redis, degrada a un conteo en
memoria: es un freno **por proceso** —varias instancias multiplican la cuota y un
reinicio la olvida—, así que Redis sigue siendo lo correcto en producción, pero
un freno imperfecto vence a ninguno.

**Escrituras del agente.** No hay ninguna directa. Todo pasa por `ai_drafts` /
`ai_external_ops` y lo aprueba una persona; los topes de
[`src/ai/floor.ts`](https://github.com/sedecim-com/Accounting/blob/main/src/ai/floor.ts)
sólo se combinan con `Math.min`, nunca `Math.max`. Un camino que postee sin esa
aprobación, o que levante ese piso, es una vulnerabilidad y no un detalle de
diseño. Ver [[El-agente-y-sus-limites]].

---

## Cómo reportar una vulnerabilidad

**No abras un issue y no mandes un PR con el arreglo.** Un diff público **es** la
divulgación: publica el camino de ataque antes de que exista la corrección, y en
un repositorio público las bitácoras de CI también son legibles por cualquiera.

Usa el canal privado de GitHub:

```
Security → Report a vulnerability
https://github.com/sedecim-com/Accounting/security/advisories/new
```

Es privado entre quien reporta y quien mantiene el repositorio hasta que haya
arreglo. El compromiso es acusar recibo en **72 horas**; si en ese plazo no hubo
respuesta, insiste por el mismo canal antes de considerar cualquier divulgación.

El orden de prioridad —por lo que cuesta reparar el daño una vez hecho—, qué está
fuera de alcance y la postura de divulgación coordinada están en
[SECURITY.md](https://github.com/sedecim-com/Accounting/blob/main/SECURITY.md).
En resumen, arriba de la lista: fuga entre inquilinos, custodia de credenciales
fiscales, escrituras de la IA sin revisión humana, integridad contable, y
autenticación y autorización.

---

## Para seguir

- [[Aislamiento-multi-inquilino]] — los roles de clúster, las políticas y las dos
  fronteras.
- [[Auditorias]] — qué queda registrado y cómo se lee.
- [[Base-de-datos-y-migraciones]] — las migraciones 033, 035 y 041, en contexto.
- [[El-tablero-y-los-criterios]] — el criterio E0.3 y por qué un criterio mal
  escrito es peor que ninguno.
- [[Puesta-en-marcha]] — qué variables hay que fijar antes de la primera
  escritura.
