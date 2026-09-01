## LO QUE ESTÁ BIEN

Antes de las brechas, lo que esta CLI resuelve mejor que la mayoría de las herramientas de terminal que he auditado, y que hay que acreditar sin regatear.

**1. El arranque desnudo hace exactamente lo que clig.dev pide de un error.** Con un `.env` completo y Postgres caído:

```
$ cd /tmp/despacho && echo "" | npx tsx .../src/cli/mnemosine.ts
Something needs attention before we can chat:
  · database unreachable: role "mnemo" does not exist
      → mnemosine doctor   (and check DATABASE_URL in .env)
[exit 1]
```

Qué pasó, por qué, y el comando exacto que lo arregla. Sale 1. Es un error modelo. (`src/cli/mnemosine.ts:398-408`, `repairCommandFor`.)

**2. `doctor` es un diagnóstico de verdad, no un ping.**

```
$ mnemosine doctor
  ✘ Database        no connection: role "mnemo" does not exist
      → Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)
  ✘ Model provider  anthropic requires ANTHROPIC_API_KEY and it is not set
      → Set ANTHROPIC_API_KEY in .env, or use --provider ollama
  ⚠ Encryption key  ENCRYPTION_KEY not set (the code default is used)
      → openssl rand -hex 32  → ENCRYPTION_KEY in .env

  There are failures that prevent operation. Resolve them in the order shown.
```

Tres fallas, tres remedios, y una frase que dice el orden. Es la heurística 9 de Nielsen (ayudar a reconocer y recuperarse del error) ejecutada bien.

**3. Los mensajes de estado bloqueado del mayor son de manual.** No dicen «no se puede», dicen por qué y qué hacer en su lugar (`src/cli/entry-command.ts:778-786`):

> `${target.entry_number} is already posted (${day}). Correct it with 'entry reverse', which leaves an audit trail.`
> `${target.entry_number} is void and can never be posted.`
> `${target.entry_number} already has a reversal. A second mirror would double the correction.`

Ese último es el que un contador agradece: explica la consecuencia contable de insistir, no la regla de la base.

**4. La confirmación dice el importe y la irreversibilidad ANTES de preguntar.** `src/cli/entry-command.ts:800-802`: `Post P-0042 (18,500.00) to the ledger? This cannot be undone.` Y sin terminal no asume consentimiento: `src/cli/entry-command.ts:253-256` aborta con `there is no terminal to ask on. Re-run with --yes once you are sure, or with --dry-run to see the effect first.` Eso es lo correcto y casi nadie lo hace.

**5. Las 17 hojas graves llevan las tres banderas de seguridad, sin excepción.** Censo sobre el árbol montado (`/private/tmp/.../aud/.aud/censo4.ts`):

```
GRAVES (irreversible|externo): 17 ["review","ingest","onboard","outbox run","sat cred add","sat cred revoke","payment create","receipt record","entry post","entry reverse","entry void","bill approve","invoice issue","invoice void","cfdi status sync","jobs run-due","close"]
GRAVES SIN --dry-run: 0 []
```

Y `declareRisk` (`src/cli/kernel/risk.ts:94-109`) rompe el arranque —no una prueba, el arranque— si alguien marca como invocable por el agente un comando irreversible. La regla «el permiso jamás depende del valor de una bandera» está en código, no en una lista de revisión.

**6. `--dry-run` de `ingest` dice lo que NO calculó**, que es más honesto que casi cualquier simulacro que haya visto (`src/cli/mnemosine.ts:1214-1217`): *«nothing was written and nothing external was called. Firm rules, AI classification and the journal-entry plan are decided on the real run.»* Y avisa que la llave de idempotencia no aplica al lote (`:1221-1223`). Un simulacro que declara su propio alcance.

**7. La aprobación de un borrador es transaccional de verdad.** `src/ai/draft-service.ts:399-424`: la póliza se crea con `client` compartido y el `UPDATE ai_drafts` va en la misma transacción; si el borrador cambió de estado en medio, el mensaje es literal: `Draft ${draftId} changed status during approval; everything was rolled back`. Fui a buscar escrituras parciales en el camino que más importa —revisar y aprobar— y no las hay.

**8. Los validadores de tipo corren ANTES de tocar la red y explican el formato:**

```
$ mnemosine entry list --limit abc
error: option '-n, --limit <n>' argument 'abc' is invalid. --limit must be a non-negative whole number; got "abc".
$ mnemosine entry list --since 31/12/2025
error: option '--since <date>' argument '31/12/2025' is invalid. --since must be a date as YYYY-MM-DD; got "31/12/2025".
```

**9. NO_COLOR, tuberías y el diccionario de banderas.** `src/cli/palette.ts:23` (`stream.isTTY === true && !process.env.NO_COLOR`, con la razón citando no-color.org), el contrato de salida que prohíbe el dinero como número JSON y obliga a reportar el truncamiento (`src/cli/kernel/output.ts:12-23`), y `src/cli/kernel/flags.ts:34-48`, que reserva `-f` para nada porque se lee a la vez como `--file` y `--force`. Ese nivel de cuidado no se improvisa.

**10. El sugeridor de comandos existe y funciona un nivel abajo de la raíz:**

```
$ mnemosine entity lst
error: unknown command 'lst'
(Did you mean list?)
```

---

## BRECHAS

### 1. La compuerta del cierre acepta `salir` como sí. ALTA / S

**Evidencia.** `src/cli/close-command.ts:179`:

```js
if (!answer || !/^y|^s/i.test(answer.trim())) {
```

`/^y|^s/i` es «empieza con y» O «empieza con s». Corrí las cuatro gramáticas de confirmación que existen en el binario contra las respuestas que un contador mexicano escribe de verdad:

```
respuesta        | close(--hard) | entry post/invoice/payment | bill approve | review/outbox
y                | SIGUE         | SIGUE                      | SIGUE        | SIGUE
s                | SIGUE         | cancela                    | cancela      | SIGUE
si               | SIGUE         | cancela                    | cancela      | SIGUE
sí               | SIGUE         | cancela                    | cancela      | SIGUE
n                | cancela       | cancela                    | cancela      | cancela
no               | cancela       | cancela                    | cancela      | cancela
salir            | SIGUE         | cancela                    | cancela      | cancela
stop             | SIGUE         | cancela                    | cancela      | cancela
seguro que no    | SIGUE         | cancela                    | cancela      | cancela
sale             | SIGUE         | cancela                    | cancela      | cancela
```

Las cuatro gramáticas: `close-command.ts:179` `/^y|^s/i`; `entry-command.ts:261`, `invoice-command.ts:228`, `payment-command.ts:116` `t==='y' || t==='yes'`; `bill-command.ts:184` `/^y(es)?$/i`; `mnemosine.ts:1436` y `:1632` `/^(y|yes|s|si|sí)$/i`.

**Qué incumple.** Dos cosas a la vez. Primero, `salir` no es una palabra cualquiera: es el alias en español que este mismo CLI define para `logout` (`src/cli/mnemosine.ts:2079-2080`, `.command('logout').alias('salir')`). El producto entrena al usuario a que `salir` significa «sácame de aquí» y luego, en el prompt del cierre duro —declarado `irreversible`—, lo interpreta como «adelante». Es una violación de la heurística 2 de Nielsen (correspondencia con el mundo real) con consecuencia irreversible, y de la regla de clig.dev de que una confirmación destructiva debe exigir una respuesta inequívoca.

Segundo, `src/cli/README.md:408-409` promete lo contrario de lo que hacen cuatro de las siete compuertas:

> «Yes/no prompts display `[y/N]` and also accept `s`/`si`/`sí`. Pinned by `tests/cli/bilingual-matrix.spec.ts`.»

Revisé esa prueba: fija los alias de comandos (`entities: 'entidades'`, `report: {'trial-balance': 'balanza'}`…), no las respuestas afirmativas. La promesa no está fijada por nada.

**Escenario.** Fin de mes. El contador corre `mnemosine close --hard`, ve `Proceed with HARD close (irreversible)? [y/N]`, duda, y escribe `salir` para abortar y revisar una póliza. El periodo se cierra en duro. En la dirección contraria, el mismo contador corre `mnemosine entry post P-0042`, ve el importe correcto, escribe `s`, y el comando aborta sin decir por qué no lo entendió: cree que el sistema lo rechazó por una regla contable.

---

### 2. El mismo fallo tiene dos presentaciones, y la buena sólo se alcanza escribiendo `mnemosine` a secas. ALTA / M

**Evidencia.** Postgres caído, `.env` correcto, mismo directorio, seis invocaciones:

```
$ mnemosine                      → Something needs attention before we can chat:
                                     · database unreachable: role "mnemo" does not exist
                                         → mnemosine doctor   (and check DATABASE_URL in .env)
$ mnemosine entity list          → role "mnemo" does not exist
$ mnemosine close --check        → role "mnemo" does not exist
$ mnemosine pending              → role "mnemo" does not exist
$ mnemosine review               → role "mnemo" does not exist
$ mnemosine report trial-balance → (imprime la ayuda de la familia; ni error ni diagnóstico)
```

`repairCommandFor` (`src/cli/mnemosine.ts:398-408`) clasifica el motivo del fallo y devuelve el comando que lo repara. Tiene un solo llamador: el flujo de arranque desnudo (`:684-691`). Ninguna de las 134 hojas lo usa. El texto de remedio de la base de datos existe además en `src/ai/doctor-service.ts:83` y tampoco se reutiliza.

**Qué incumple.** clig.dev, *«errors should be actionable... catch errors and rewrite them for humans»*, y la heurística 9 de Nielsen. El agravante no es que falte la información: es que el binario ya la tiene calculada, en dos sitios, y la retiene en 134 de 135 puertas de entrada.

**Escenario.** El despacho arranca la mañana con `mnemosine pending` (que es lo que la propia ayuda describe como «what you need to do»). Recibe `role "mnemo" does not exist`. Nada en esa línea dice que existe `mnemosine doctor`. Llama al proveedor del software.

---

### 3. El contrato de trece códigos de salida entrega 1 en todas las clases de error. ALTA / M

**Evidencia.** `src/cli/kernel/exit.ts:19-46` declara 13 códigos con una justificación excelente escrita encima (el 4 para que un `check` caiga en CI sin cambios, el 11 para «no falló, espera a un humano»). Medí lo que sale de verdad:

```
  exit=1  <- mnemosine entity list            (sin base)
  exit=1  <- mnemosine entity lst             (subcomando inexistente; contrato dice 2 USAGE)
  exit=1  <- mnemosine entity list --formt json (bandera mal escrita; contrato dice 2)
  exit=1  <- mnemosine entity show
  exit=1  <- mnemosine ingest /no/existe.xml  (contrato dice 3 NOT_FOUND)
  exit=1  <- mnemosine entry post 0000...     (id inexistente; contrato dice 3)
  exit=1  <- mnemosine doctor                 (check con hallazgos bloqueantes)
  exit=1  <- mnemosine lang zz                (valor inválido; contrato dice 2)
  exit=1  <- mnemosine entry reverse 0000...
  exit=1  <- mnemosine report trial-balance
```

Y en el código:

```
$ grep -rhon "shutdown([0-9]*)" src/cli/ | sort | uniq -c
  85 shutdown(0)
  52 shutdown(1)
  13 shutdown(130)
```

Cero literales entre 2 y 11. La ruta que sí honra el contrato es `shutdown(exitCodeFor(err))`, con 25 llamadas. El reparto por archivo separa dos generaciones limpiamente: `entry`, `invoice`, `payment`, `account`, `period`, `vendor`, `bill`, `customer`, `cfdi`, `rep`, `ledger`, `report`, `entity` usan `exitCodeFor` y cero `shutdown(1)`; `approvals`(3), `jobs`(3), `memory`(5), `pending`(5), `skills`(3), `webhooks`(5), `sat`(6), `compact`(2), `usage`(1), `status`(1), `init`(1), `doctor`(1) y `mnemosine.ts`(14) llevan `shutdown(1)` a mano.

Además, Commander no lleva `exitOverride` en ningún sitio (`grep -rn "exitOverride" src/cli/` → sin resultados), así que todo error de uso sale por su `process.exit(1)` propio: ni pasa por el contrato ni por `shutdown()`, que es donde se drenan las atestaciones pendientes y se cierra el pool (`src/cli/mnemosine.ts:143-158`).

**Qué incumple.** El propio contrato del proyecto, y las convenciones POSIX/GNU que reservan 2 para el error de uso. El comentario de `exit.ts:14-16` es la sentencia contra sí mismo: *«conflating "I found problems" with "I could not look" is how a green pipeline lies»* — y hoy no se puede distinguir ninguna de las dos, porque ambas salen 1.

**Escenario.** El despacho automatiza el cierre en un `cron`: `mnemosine close --check || avisar`. El aviso se dispara igual cuando el periodo tiene partidas sin cuadrar (hallazgo real, código 4) que cuando el túnel a la base se cayó (no se pudo mirar). El contador atiende la falsa alarma dos veces y a la tercera la ignora, que es el mes en que la balanza sí estaba descuadrada.

---

### 4. Un comando mal escrito lo traga `chat`, y con él se pierde el sugeridor. ALTA / S

**Evidencia.**

```
$ mnemosine balanza
error: too many arguments for 'chat'. Expected 0 arguments but got 1: balanza.
[exit 1]

$ mnemosine entyti list
error: too many arguments for 'chat'. Expected 0 arguments but got 2: entyti, list.
[exit 1]

$ mnemosine entity lst
error: unknown command 'lst'
(Did you mean list?)
```

`balanza` no es una palabra inventada: es un alias registrado en este binario, `report trial-balance|balanza` (visible en `mnemosine report --help`). Como `chat` es el comando por omisión, Commander enruta cualquier primer token desconocido hacia él y el sugeridor —que funciona perfectamente un nivel más abajo— nunca corre en la raíz.

**Qué incumple.** clig.dev, *«suggest what to do next»* y el patrón que `git`, `docker` y `gh` implementan en la raíz. La heurística 1 de Nielsen (visibilidad del estado del sistema): el mensaje habla de un comando, `chat`, que el usuario no escribió ni conoce.

**Escenario.** El contador quiere la balanza de comprobación. Escribe la palabra que usa todos los días y que este producto reconoce como alias: `mnemosine balanza`. La respuesta menciona `chat` y unos «arguments». No hay forma de llegar desde ahí a `mnemosine report balanza show`.

---

### 5. La llave de idempotencia se graba en una transacción distinta del acto que protege. ALTA / M

**Evidencia.** `src/services/idempotency/idempotency-store.ts:82-88`:

```js
const resultado = await fn();                    // el acto: COMMIT aquí
const grabada = await query(
  `INSERT INTO idempotency_keys (tenant_id, entity_id, scope, clave, payload_hash, resultado)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT ON CONSTRAINT uq_idempotency_keys DO NOTHING`,
  [...]);                                        // la llave: otro COMMIT
```

`fn()` envuelve un `withTransaction` completo que ya hizo COMMIT cuando se ejecuta el `INSERT`. Entre los dos hay una ventana. El comentario de `:90-92` razona sobre la carrera entre dos procesos, pero no sobre la caída entre el commit del acto y el de la llave.

La promesa que se le hace al usuario está en `src/cli/kernel/risk.ts:139-141`, en el texto de ayuda de las 19 hojas que llevan la bandera: *«client dedupe key, stored on success: a retry with the same key and payload returns the recorded result»*.

Para `entry post` y `close` el estado del dominio hace de red (la póliza ya posteada da BLOCKED; el periodo ya cerrado también), y `src/cli/entry-command.ts:236-237` lo dice explícitamente. Para pagos no la hay: `src/services/payments/payment-service.ts:490` declara `const PAGABLES = ['approved', 'posted', 'partially_paid']`, y `nextEntityNumber` (`:241`) emite un VPMT nuevo en cada intento.

**Qué incumple.** El diseño canónico de idempotencia (Stripe: el registro de la llave y el efecto se comprometen juntos, o la llave no vale). Aquí no valen para el único caso por el que existen: el proceso que muere a media escritura.

**Escenario.** Abono parcial a un proveedor: `mnemosine payment create --idempotency-key abono-mayo-07 ...` sobre una factura de $100,000 a la que se le abonan $40,000. El pago se registra y la factura queda en `partially_paid`; la red se cae antes del `INSERT` de la llave. El contador ve el error, y como el manual dice que la llave protege, repite el mismo comando. `partially_paid` está en `PAGABLES`, quedan $60,000 de saldo, así que el segundo pago pasa: dos VPMT, $80,000 aplicados, y un movimiento de banco que no existe. Es exactamente el «escribir a medias sin que el usuario se entere» que un sistema contable no puede permitirse.

Nota aparte de la misma línea: `:68` dice `if (!acto.clave) return { repetido: false, resultado: await fn() }`. Sin la bandera no hay ninguna protección, y ningún contador va a teclear un UUID a mano en la terminal. La protección es opt-in y la ergonomía garantiza que nunca se opte.

---

### 6. La comprobación barata corre después de la cara. MEDIA / M

**Evidencia.** Tres casos, mismo patrón.

`ingest` nunca comprueba que el archivo exista antes de ir a la base (`src/cli/mnemosine.ts:1181` resuelve la entidad, `:1194` llama a `gateMutation`, y la lectura de archivos ocurre después):

```
$ mnemosine ingest /no/existe/factura.xml
role "mnemo" does not exist
[exit 1]
```

Ni una palabra del archivo que el usuario escribió mal.

`entry post` hace dos viajes a la base antes de mirar sus propias banderas (`src/cli/entry-command.ts:772` `entityOf`, `:774` `resolveJournalEntry`, `:775` `gateMutation`). `gateMutation` es una función pura que sólo comprueba la presencia de `--reason` y `--force`, y llega tercera.

`--format` se valida dentro de `render()`, es decir después de la consulta:

```
$ mnemosine entity list --format jsonn
role "mnemo" does not exist
[exit 1]
```

El valor inválido nunca se menciona, aunque `src/cli/kernel/output.ts:61-67` tiene un mensaje perfecto preparado (`Unknown --format "jsonn". Use one of: table, json, ndjson, csv, tsv, md.`).

**Qué incumple.** clig.dev, *«validate user input as early as possible»*, y el principio de prevención de errores (heurística 5 de Nielsen). Con la red viva el coste es latencia; con la red muerta el coste es que el diagnóstico correcto es inalcanzable.

**Escenario.** El contador arrastra la carpeta del mes al terminal y le sobra una comilla en la ruta. Con la base viva espera dos consultas y recibe un error de archivo; con la base caída recibe un error de Postgres y pasa media hora revisando la conexión cuando el problema era la comilla.

---

### 7. La envoltura de la entidad activa misdiagnostica el fallo, lo imprime dos veces, y su remedio no arregla nada. MEDIA / S

**Evidencia.**

```
$ mnemosine entry post X
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "mnemo" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "mnemo" does not exist
[exit 1]
```

`src/cli/kernel/entity-context.ts:100-115`: el `catch` alrededor de `resolveEntity(stored)` llama a `warn(...)` con un texto fijo y luego cae a `resolveEntity()`, que lanza el mismo error crudo otra vez.

El comentario de `:103-108` es correcto y la decisión de no borrar el pin es la buena («a stale pin is an annoyance the user can fix in one command; a silently deleted one is state they cannot get back»). El problema no es la decisión, es la redacción: el `catch` cubre dos causas distintas —la entidad archivada y la conexión caída— y sólo redacta para la primera. El binario ya sabe distinguirlas: `repairCommandFor` (`src/cli/mnemosine.ts:398-408`) hace justo esa clasificación con una expresión regular sobre el motivo.

**Qué incumple.** Heurística 9 de Nielsen: el mensaje debe *diagnosticar* el problema, no ofrecer un remedio de otra categoría. Y clig.dev sobre no repetir el mismo error dos veces con dos voces distintas.

**Escenario.** El contador lee «la entidad activa no se pudo resolver», corre `mnemosine entity use ACME`, que falla igual, y concluye que se le corrompió la selección de empresa. El problema era el contenedor de Postgres.

---

### 8. Cero ejemplos en 134 comandos. MEDIA / L

**Evidencia.** `grep -rn "addHelpText" src/ | wc -l` → `0`. Censo sobre el árbol montado (`/private/tmp/.../aud/.aud/censo.ts`):

```
HOJAS TOTAL: 134
CON EJEMPLOS EN AYUDA: 0  SIN: 134
SIN DESCRIPCION: 0
```

Las descripciones son buenas —`entry import`: *«Stage a file of entries into a batch (returns a batch_id); NEVER touches the ledger»*— pero ninguna se acompaña de una línea que se pueda copiar. La ayuda de `entry create`, el comando con el que un contador captura una póliza a mano, no muestra cómo se escribe un renglón.

**Qué incumple.** clig.dev es explícito: *«Provide examples... they are the fastest way for a user to understand a command.»* `git`, `gh`, `docker`, `stripe` y `aws` traen ejemplos en el `--help` de sus subcomandos.

**Escenario.** El usuario objetivo declarado no sabe de terminales. `mnemosine entry create --help` le enseña doce banderas y ni una póliza escrita. Lo que un contador necesita ver una vez es `mnemosine entry create --date 2026-08-31 --desc "Renta agosto" --line 6100:12000 --line 1120:-12000`; sin ese renglón la ayuda es una referencia, no una enseñanza.

---

### 9. El contrato de salida cubre 47 de las 134 hojas; 63 no tienen salida legible por máquina. MEDIA / M

**Evidencia.** Censo (`/private/tmp/.../aud/.aud/censo2.ts`):

```
CON --format: 47      (y con ellas --quiet: 47, --fields: 47, --output: 47)
SOLO --json: 24
NI UNA NI OTRA: 63    ["entities","providers","ask","chat","sessions","drafts","review","ingest",
                       "lang","onboard","outbox run","question answer","sat cred add",
                       "sat cred status","sat cred audit","sat cred revoke","pending define",
                       "pending dismiss","pending reopen","login","logout","whoami","memory teach",
                       ...,"jobs list","jobs create","jobs enable","jobs disable","jobs run-due",
                       "jobs history","skills view","webhooks create","webhooks disable","init"]
```

Comprobado a mano:

```
$ mnemosine drafts --json     → error: unknown option '--json'
$ mnemosine jobs list --json  → error: unknown option '--json'
$ mnemosine sessions --format json → error: unknown option '--format'
$ mnemosine usage --format jsonn   → error: unknown option '--format'   (usage sólo tiene --json)
```

Duele especialmente en las hojas puramente de lectura que un despacho querría automatizar: `drafts` (la cola de borradores de la IA), `jobs list`, `jobs history`, `sat cred status`, `sat cred audit`, `sessions`, `entities`. El contrato de `src/cli/kernel/output.ts:5-27` está bien escrito y bien implementado; lo que falta es aplicarlo.

Esto extiende, sin refutarlo, el hallazgo de que `mnemosine --json entity list` falla: las banderas son por subcomando **y** además la mitad de los subcomandos no las tienen.

**Qué incumple.** clig.dev: *«If your command outputs data, consider a `--json` flag»*, y el propio contrato de la casa, que declara seis formatos y los entrega en el 35% del binario.

**Escenario.** El despacho quiere un tablero de borradores pendientes por cliente. `mnemosine drafts` sólo imprime una tabla alineada para humanos; automatizarlo obliga a parsear columnas con `awk`, y el día que una descripción traiga un espacio de más el conteo se rompe en silencio.

---

### 10. La superficie declarada que no existe: 13 banderas del diccionario y un gancho de seguridad muerto. BAJA / S

**Evidencia.** Censo (`/private/tmp/.../aud/.aud/censo3.ts`), cruzando `FLAG_DICTIONARY` contra las opciones realmente registradas:

```
FLAGS DEL DICCIONARIO QUE NINGUNA HOJA LLEVA: 13
["--profile","--config","--set","--interval","--cursor","--jq","--verbose","--null",
 "--no-color","--no-pager","--diff","--no-input","--watch"]
```

Comprobado:

```
$ mnemosine entity list --no-color
error: unknown option '--no-color'
```

(La variable `NO_COLOR` sí se respeta, `src/cli/palette.ts:23`; la bandera no existe.)

Y el gancho de `src/cli/kernel/riesgos-retrofit.ts:189-201`, que rechaza `--dry-run` en los comandos retrofitados «que todavía no la honran», nunca se registra: la tabla ya no tiene ninguna fila grave (`/private/tmp/.../aud/.aud/censo5.ts`):

```
FILAS EN LA TABLA DE RETROFIT: 40
FILAS GRAVES (que dispararian el gancho preAction): 0 []
```

El comentario de `:177-187`, que describe con detalle el peligro de «una `--dry-run` aceptada que ESCRIBE de todos modos», documenta un estado que ya no existe.

**Qué incumple.** El diccionario se justifica a sí mismo (`src/cli/kernel/flags.ts:8-10`) diciendo que *«a flag can only exist in the CLI if it exists here first»* — la implicación inversa, que lo que está aquí existe allá, no se sostiene, y un lector del diccionario se lleva una idea falsa de la superficie. En un sistema contable, donde el comentario ES la especificación (y esta base los usa así, con criterio), un comentario de seguridad obsoleto es deuda de auditoría.

**Escenario.** Un integrador lee el diccionario, escribe un script con `--no-color` porque es la forma canónica en el resto del ecosistema, y el script muere en la primera línea. Menos grave, pero es la clase de fricción que hace que un despacho abandone la automatización.

---

### 11. El manual del contador está en español; la interfaz que teclea, no. ALTA / L

**Evidencia.** `README_ACCOUNTANT.md` (31 KB) abre así:

```
# Accounting Core — Guia Funcional
...
3. [Pólizas Contables (Asientos de Diario)]
4. [Cuentas por Cobrar (Clientes y Facturación)]
```

El producto ya decidió que su lector lee español. La interfaz que ese mismo lector opera, medida sobre el árbol montado (`/private/tmp/.../aud/.aud/idioma.ts`):

```
HOJAS TOTAL: 134
HOJAS CON DESCRIPCION EN ESPANOL: 1
   ai stats :: Aprobación por bucket de confianza, delta confianza-vs-realidad, costo y eventos
OPCIONES TOTAL: 1069  CON TEXTO EN ESPANOL: 3
```

Y en los errores de tiempo de ejecución, contando los 460 mensajes lanzados con texto en `src/`: 19 en español, 441 en inglés. Ejemplos del lado español: `src/services/payments/payment-service.ts:208` (*«está en "draft" y sólo se puede pagar un gasto approved, posted, partially_paid: su pasivo tiene que estar en el mayor primero»*), `src/cli/kernel/risk.ts:194-196`, `src/cli/kernel/riesgos-retrofit.ts:195-199`.

Esto **matiza** el hallazgo del orquestador sobre la familia `ai|ia`: no son «44 familias en inglés y una en español» como decisión de diseño. Es una hoja de 134 y tres opciones de 1069. El español que hay no es una alternativa, es filtración: aparece donde el autor escribió en su idioma, no donde el usuario lo necesita. El usuario no puede predecir en qué idioma le va a hablar el sistema en la siguiente línea.

La política está escrita en la ayuda del propio comando: `lang|idioma` — *«Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)»*. Los alias sí funcionan (`mnemosine entidad list` enruta bien), y el `README` del CLI mantiene una matriz bilingüe fijada por prueba. Pero los alias resuelven cómo se **escribe** el comando, no cómo se **lee** la respuesta, y leer es donde el usuario pasa el 90% del tiempo.

**Qué incumple.** Heurística 2 de Nielsen, hablar el idioma del usuario. Y el marco de comparación real: CONTPAQi Contabilidad, Aspel COI y Aspel SAE están íntegramente en español, con la terminología fiscal mexicana (póliza, balanza de comprobación, auxiliar, DIOT, complemento de pago). Un despacho que evalúa este producto contra CONTPAQi compara *«Post P-0042 to the ledger? This cannot be undone.»* con *«¿Contabilizar la póliza P-0042? Esta operación no se puede deshacer.»*

**Escenario.** El titular del despacho instala la herramienta y se la pasa a la auxiliar contable, que es quien captura. Ella sabe qué es una póliza y qué es una balanza; no sabe qué es *ledger*, *draft* ni *void*. La primera pantalla que ve es `mnemosine --help` con 45 familias en inglés. El vocabulario cerrado de verbos (`src/cli/kernel/vocabulary.ts`), que es una decisión de diseño excelente, se convierte en 45 palabras nuevas que memorizar en otro idioma.

---

## RECOMENDACIONES

Ordenadas por relación entre daño evitado y trabajo.

**1. Una sola función que decida si una respuesta es afirmativa (S).** `isAffirmative` ya existe en `src/cli/mnemosine.ts:386-391` y está bien escrita. Muévela a `src/cli/kernel/`, haz que las siete compuertas la llamen, y añade una prueba que recorra las hojas graves comprobando que ninguna acepte un token que no sea exactamente `y|yes|s|si|sí`. Para el cierre duro, sube el listón un escalón como hace `terraform destroy`: pedir que se escriba el nombre del periodo. Esto elimina la brecha 1 entera.

**2. Un solo redactor de errores para todo el binario (M).** Envuelve `reportError` (`src/cli/mnemosine.ts:241-256`) para que, antes de imprimir, pase el mensaje por `repairCommandFor` y añada la flecha `→ <comando>` que el arranque desnudo ya imprime. Es el mismo código, un llamador más, y cierra las brechas 2 y 7 y la mitad de la 3. En el mismo cambio, dale a `entity-context.ts:109` una redacción por causa: si el motivo casa con `/connect|role|postgres|timeout/`, el texto es «no hay conexión, corre `mnemosine doctor`», no «la selección se conservó».

**3. Cierra el contrato de códigos de salida (M).** Añade `program.exitOverride()` para que los errores de uso de Commander salgan por `shutdown(ExitCode.USAGE)` en lugar de por su `process.exit(1)` —esto además garantiza que las atestaciones pendientes se drenen—, y sustituye los 52 `shutdown(1)` por `shutdown(exitCodeFor(err))`, que es un cambio mecánico archivo por archivo. Añade una prueba de contrato que corra una docena de invocaciones fallidas conocidas y fije su código; si no está fijada, vuelve a derivar.

**4. Idempotencia dentro de la transacción del acto (M).** `conLlave` debe recibir el `client` de la transacción y hacer el `INSERT` de `idempotency_keys` dentro de ella, con `SELECT ... FOR UPDATE` sobre la llave al entrar. Mientras tanto, y esto es de una tarde: cuando no se pasa `--idempotency-key`, deriva una del `payloadHash` más la fecha del acto, de modo que la protección sea la omisión y no la excepción. Ningún contador va a teclear un UUID.

**5. Sugeridor en la raíz (S).** Antes de `parseAsync`, si `argv[2]` no empieza con `-` y no es un comando ni un alias registrado, calcula la distancia de edición contra el catálogo completo de nombres y alias —incluidos los anidados, que es lo que hace falta para que `balanza` proponga `report balanza show`— e imprime `unknown command 'X' (did you mean 'Y'?)` con salida 2, en lugar de dejar que `chat` lo trague.

**6. Comprobaciones baratas primero (M).** Mueve `gateMutation` y la validación de `--format` delante de cualquier `await` que toque la red, y haz que `ingest` recorra `files` con un `existsSync` antes de resolver la entidad. Es reordenar líneas, y convierte tres diagnósticos inútiles en tres correctos.

**7. Ejemplos, empezando por veinte (L, pero por partes).** No hacen falta 134 de golpe. `addHelpText('after', ...)` en las hojas que un contador toca a diario —`entry create`, `entry post`, `entry reverse`, `ingest`, `review`, `close`, `report balanza show`, `payment create`, `bill approve`, `cfdi list`— cubre el 90% del uso real. Ponlos en el mismo lugar donde ya vive el catálogo de comandos, para que la ayuda y la referencia no se separen.

**8. Extiende el contrato de salida a las hojas de lectura que faltan (M).** `withOutput(...)` ya existe y ya funciona; aplicarlo a `drafts`, `sessions`, `entities`, `jobs list`, `jobs history`, `sat cred status` y `sat cred audit` es una línea por hoja. Añade al criterio de cierre la regla que ya existe para el riesgo: toda hoja declarada `lectura` lleva el contrato de salida completo, o rompe.

**9. Decide el idioma de la interfaz, y hazlo del lado del usuario (L).** Es la recomendación de más trabajo y la de mayor consecuencia comercial, y no se resuelve con más alias. La forma barata de empezar sin reescribir 1069 cadenas: extraer a un catálogo los tres textos que un contador lee cien veces al día —el prompt de confirmación, el mensaje de estado bloqueado y la línea de remedio del error— y traducirlos primero, con `MNEMOSINE_LANG` gobernando también la interfaz y no sólo las respuestas del agente. Mientras tanto, arregla la incoherencia al revés: los 19 mensajes en español dentro de una interfaz inglesa son peores que 460 en inglés, porque el usuario no puede anticipar cuál le va a tocar. Uno u otro, no la mezcla actual.
