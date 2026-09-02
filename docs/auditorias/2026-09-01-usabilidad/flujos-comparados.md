> Auditoría con lente **flujos de despacho mexicano**: mnemosine contra CONTPAQi Contabilidad, Aspel COI/SAE, QuickBooks, Xero y NetSuite. Todo se corrió en `/private/tmp/claude-501/-Users-victor-projects-Accounting/d48ca5a0-ac05-4c38-a2d6-62373f8f-aud` con `npx tsx src/cli/mnemosine.ts`. No hay base de datos, así que el estado de fallo se auditó como superficie de usuario, que es lo que un contador ve el día que se cae el túnel.

---

## LO QUE ESTÁ BIEN

**1. `cfdi explain <uuid>` no tiene equivalente en ningún sistema comparado.**

```
$ npx tsx src/cli/mnemosine.ts cfdi explain --help
Usage: mnemosine cfdi explain|explicar [options] <uuid>

WHY it was recorded the way it was: case, facts and decisions the classifier
left
```

CONTPAQi y Aspel no clasifican con IA, así que no tienen nada que explicar. QuickBooks y Xero sí sugieren categoría, y su explicación se agota en «lo hiciste así la vez pasada». Un rastro que separa **caso, hechos y decisiones** es material de papel de trabajo: es lo que un contador enseña cuando el SAT pregunta por qué una cuenta quedó donde quedó. Esto es superior a los cinco sistemas y hay que decirlo sin adornos.

**2. `entity show` dice POR QUÉ está seleccionada esa entidad.** `src/cli/entity-command.ts:124-129`:

```ts
const SOURCE_LABEL: Record<typeof source, string> = {
  flag: 'named on the command line',
  env: 'from MNEMOSINE_ENTITY',
  stored: 'pinned with `mnemosine entity use`',
  only: 'the only active entity',
};
```

CONTPAQi pone el nombre de la empresa en la barra de título y ahí termina; nunca dice si lo abriste tú o si quedó de la sesión anterior. Es Nielsen 1 (visibilidad del estado) aplicado al problema exacto del despacho: trabajar en los libros equivocados.

**3. La cadena de custodia del acto irreversible es mejor que la de los cinco sistemas.** El núcleo obliga, por declaración de riesgo (`src/cli/kernel/risk.ts:135-141`), a que todo acto `irreversible` o `externo` traiga `--dry-run`, `--yes` e `--idempotency-key`; `gateMutation` **falla cerrado** si una hoja pide compuerta sin haber declarado riesgo (`risk.ts:191-198`). Y la aprobación de un borrador queda amarrada al hash del contenido que el revisor **vio** (`src/cli/mnemosine.ts:1108-1110`). Ninguno de CONTPAQi, Aspel, QuickBooks, Xero o NetSuite tiene llave de idempotencia en la interfaz de usuario: si el contador da doble clic en «Contabilizar» mientras la red titubea, se rezan padrenuestros. Aquí no.

**4. La disciplina de cierre es más estricta que la de CONTPAQi.** `src/cli/close-command.ts:128-131`:

```ts
// A period cannot be closed while an earlier one is open, so the
// default is always the oldest — never "the current month".
```

CONTPAQi te deja cerrar meses salteados. Aquí no se puede, y el valor por omisión es el mes más viejo abierto, que es el que de verdad estorba.

**5. Honestidad en el punto de uso, no en el manual.** Tres casos verificados:

```
$ npx tsx src/cli/mnemosine.ts entry import --help
  --layout <name>          file layout: csv, ndjson
                           (contpaqi/aspel/iif/sat-polizas: aún sin parser)
```

`src/services/xml-ingestion/cfdi-decisions.ts:90-92` avisa, en la pantalla donde el usuario decide capitalizar, que el sistema **no** dará de alta el activo ni calculará depreciación. Y `vendor list --no-tax-id` se describe como «only vendors with no tax id on file (**the DIOT/1099 blockers**)»: nombra el uso río abajo, que es exactamente cómo se hace descubrible una bandera para un experto de dominio. Xero jamás te dice qué no hace.

**6. `doctor` es el único comando con diagnóstico completo, y está bien hecho.** Reproducido:

```
$ npx tsx src/cli/mnemosine.ts doctor
  ✘ Database        no connection: role "mnemo" does not exist
      → Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)
  ✘ Model provider  anthropic requires ANTHROPIC_API_KEY and it is not set
      → Set ANTHROPIC_API_KEY in .env, or use --provider ollama
  ⚠ Encryption key  ENCRYPTION_KEY not set (the code default is used)
      → openssl rand -hex 32  → ENCRYPTION_KEY in .env
$ echo $?
1
```

Síntoma, causa y remedio ejecutable en tres líneas, con código de salida correcto. Es lo que pide clig.dev de un error. El problema —ver Brecha 4— es que ese remedio no existe en ningún otro lado del binario.

**7. `cfdi status sync`: revalidación masiva contra el SAT ordenada por antigüedad de consulta.** «Re-check the whole mirror against the SAT: stale or never-consulted first». El módulo ADD de CONTPAQi valida CFDI, pero el barrido priorizado por obsolescencia del dato es una idea mejor y no la tienen.

**8. La invocación desnuda en máquina rota da una línea accionable.**

```
$ echo "" | npx tsx src/cli/mnemosine.ts
Not configured. Run: mnemosine init
```

**9. Contrato de salida legible por máquina donde el núcleo alcanzó.** `--format table|json|ndjson|csv|tsv|md`, `--fields`, `-q`, `-o`. Verificado que en fallo `stdout` queda limpio y el error se va a `stderr` (`cfdi list --json 2>/dev/null` no imprime nada y sale 1). Eso es el principio de clig.dev de «salida para humano y para máquina» bien ejecutado, y ni CONTPAQi ni Aspel tienen nada parecido.

---

## BRECHAS

### 1 · `close --hard` acepta «salir» y «stop» como SÍ. Conviven cuatro definiciones de «sí» detrás del mismo prompt `[y/N]`. — ALTA / S

Evidencia reproducida (`probe-si.ts` replica literalmente los cuatro predicados del binario):

```
$ npx tsx probe-si.ts
respuesta   onboard   entry/payment/invoice   close (incl. --hard)   isAffirmative
"y"        SIGUE    SIGUE                  SIGUE                  SIGUE
"yes"      SIGUE    SIGUE                  SIGUE                  SIGUE
"s"        SIGUE    CANCELA                SIGUE                  SIGUE
"si"       SIGUE    CANCELA                SIGUE                  SIGUE
"sí"       SIGUE    CANCELA                SIGUE                  SIGUE
"SI"       SIGUE    CANCELA                SIGUE                  SIGUE
"salir"    CANCELA   CANCELA                SIGUE                  CANCELA
"stop"     CANCELA   CANCELA                SIGUE                  CANCELA
"n"        CANCELA   CANCELA                CANCELA                CANCELA
"no"       CANCELA   CANCELA                CANCELA                CANCELA
""         CANCELA   CANCELA                CANCELA                SIGUE
```

Los cuatro predicados, con archivo y línea:

- `src/cli/close-command.ts:180` — `/^y|^s/i` — **sin anclar**. Cualquier respuesta que empiece con `s` cierra el periodo, y con `--hard` el cierre es irreversible.
- `src/cli/entry-command.ts:262`, `src/cli/payment-command.ts:116`, `src/cli/invoice-command.ts:228` — `t === 'y' || t === 'yes'` — rechaza el español.
- `src/cli/mnemosine.ts:1436` (`onboard`) y `src/cli/mnemosine.ts:1631` (`outbox run`) — `/^(y|yes|s|si|sí)$/i` — acepta el español.
- `src/cli/mnemosine.ts:386` `isAffirmative()` — acepta español y además vacío ⇒ sí.

**Práctica incumplida.** clig.dev, *Confirmation before dangerous actions*: la confirmación de un acto destructivo debe ser inequívoca y su severidad proporcional al daño. La convención de shell POSIX es que un `[y/N]` acepta el conjunto anclado `y|yes` y **todo lo demás** es no. `git`, `docker` y `gh` anclan. Y Nielsen 4 (consistencia y estándares): la misma pregunta con el mismo formato no puede tener cuatro semánticas dentro del mismo binario.

**Escenario.** El contador corre `mnemosine close --hard --period "2026-07"`. Sale `Proceed with HARD close (irreversible)? [y/N]`. Se arrepiente, escribe `salir` para abortar. Julio queda cerrado en duro. Cinco minutos después, el mismo contador contabiliza una póliza, ve `[y/N]`, escribe `sí` y el sistema le responde `Aborted.` — sin decir que no entendió la respuesta (`src/cli/kernel/exit.ts:98`: `abortedByUser = (message = 'Aborted.')`). Concluye que la póliza tenía un problema contable y se va a buscarlo. En el mismo producto, el mismo día: `s` cerró un ejercicio y `sí` canceló un asiento.

---

### 2 · La conciliación bancaria tiene motor y API REST, y cero superficie de terminal. El cierre la exige. — ALTA / M

El motor existe: `src/services/banking/matching.ts` (casado de movimientos, `UPDATE bank_transactions SET is_matched = true, matched_at = NOW(), confidence_score = $1`, línea 391). La ruta HTTP existe: `src/api/rest/routes/bank-reconciliation.ts:67` (`INSERT INTO bank_transactions`). Y el checklist de cierre la revisa, `src/services/accounting/period-close.ts:52-69`:

```sql
SELECT COUNT(*) as count FROM bank_accounts ba
WHERE ba.entity_id = $1 AND ba.is_active = true
AND NOT EXISTS (SELECT 1 FROM reconciliation_sessions rs ...)
```
```ts
checklist.push({ item: 'Bank reconciliations complete', ... });
if (unreconCount > 0) warnings.push(`${unreconCount} bank accounts not reconciled`);
```

Pero desde la terminal no se llega:

```
$ npx tsx src/cli/mnemosine.ts banco
error: too many arguments for 'chat'. Expected 0 arguments but got 1: banco.

$ grep -rn "services/banking\|services/assets" src/cli src/ai
(sin resultados)
```

El único `reconcile` del binario es `rep reconcile` (`src/cli/rep-command.ts:128`), que reprocesa complementos de pago, no banco.

**Práctica incumplida.** Es el flujo mensual que más horas consume en un despacho, después de la captura. CONTPAQi Bancos importa el estado de cuenta y casa contra pólizas; Aspel COI lo hace con el auxiliar; QuickBooks y Xero viven de eso —el *bank feed* con reglas y aceptación masiva es literalmente su producto. Y aquí no es «falta la capacidad»: **la capacidad existe y el camino es intransitable** desde el medio que el producto declara como suyo. El mismo patrón afecta a activo fijo: `src/services/assets/depreciation.ts` tiene `runMonthlyDepreciation` y el comentario en `src/services/xml-ingestion/cfdi-decisions.ts:96` admite que «no existe un INSERT INTO fixed_assets en todo src», con lo cual la partida «Depreciation calculated and posted» del checklist está en verde por vacuidad.

**Escenario.** El contador corre `mnemosine close --check` para julio. La lista le marca «Bank reconciliations complete» en rojo con «1 accounts not reconciled». Busca cómo conciliar. Prueba `mnemosine banco`, `mnemosine conciliacion`, `mnemosine bank` — las tres le contestan hablándole de `chat`. Revisa `mnemosine --help`, 46 familias, ninguna dice banco. No hay forma de poner esa partida en verde desde la terminal, y el comando no le dice que no la hay.

---

### 3 · `review` no filtra, no agrupa, no limita, y traga en silencio lo que no entiende. Es la cola diaria del despacho. — ALTA / M

```
$ npx tsx src/cli/mnemosine.ts drafts --help
Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -s, --status <status>    pending_review | approved | rejected

$ npx tsx src/cli/mnemosine.ts review --help
Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Reviewer email ...
  --dry-run / -y, --yes / --idempotency-key
```

`src/cli/mnemosine.ts:1060` carga la cola completa sin cota — `const pending = await listDrafts(ctx, 'pending_review')` — y recorre `for (let i = 0; i < pending.length; i++)` con un prompt por borrador. No hay `--limit`, ni `--min-amount`, ni `--vendor`, ni `--min-confidence`, ni orden, ni aprobación por lote. Y el manejo de la respuesta, `src/cli/mnemosine.ts:1100` y `1136`:

```ts
const raw = await ask(rl, c.cyan('\n[a]pprove and post  [r]eject  [s]kip  [q]uit > '));
...
// 's' or anything else: skip
```

Cualquier cosa que no sea `a`, `r` o `q` salta el borrador **sin imprimir nada**.

**Práctica incumplida.** Nielsen 9 (ayudar a reconocer y recuperarse de errores): una entrada no reconocida debe decirse, no interpretarse como una acción. Nielsen 7 (flexibilidad y eficiencia): el experto necesita atajos para el volumen. Xero acepta en bloque las coincidencias sugeridas, QuickBooks tiene «Accept all» en la bandeja, CONTPAQi ADD genera pólizas por selección. Y la mnemotecnia está en inglés: `[s]kip` colisiona de frente con `salir`, y `[q]uit` no corresponde a ninguna palabra española.

**Escenario.** El despacho ingesta el mes de un cliente: 800 CFDI, 800 borradores. El contador corre `mnemosine review`, ve el primero, escribe `aprobar`. El sistema no dice nada y muestra el segundo. Escribe `aprobar` otra vez. Repite 800 veces —o hasta que se cansa— y al final lee `Done: 0 approved, 0 rejected`. Ochocientas confirmaciones y cero asientos. Si en cambio hubiera escrito `s` creyendo que decía «sí», el resultado habría sido idéntico: `[s]kip`.

---

### 4 · La caída de conexión se presenta como problema de selección de entidad, en las 85 hojas que resuelven contexto. — ALTA / S

Reproducido en un comando de **lectura**, no sólo en `entry post`:

```
$ npx tsx src/cli/mnemosine.ts cfdi list
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "postgres" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "postgres" does not exist
$ echo $?
1
```

El mecanismo está en `src/cli/kernel/entity-context.ts:99-115`. El comentario del `catch` **reconoce el diagnóstico doble** y aun así no lo distingue:

```ts
// NEVER clear the pin here. This catch fires for "the entity was
// archived", but it fires just as readily on a dropped connection ...
warn(`Could not resolve the active entity (${stored}): ${(err as Error).message}\n` +
     'The selection was kept. Use `mnemosine entity use <id|name>` to change it, ...');
```

La decisión de **no** borrar el fijado es correcta y está bien argumentada; el defecto es que el mensaje no se condiciona a la causa. Alcance: `grep -rn "withContext(" src/cli | wc -l` → **85**.

**Práctica incumplida.** clig.dev, *Error messages*: decir qué pasó, por qué, y qué hacer — y que el remedio propuesto de verdad remedie. Aquí el remedio (`entity use`) es imposible: para fijar una entidad hay que consultar la base, que es justo lo que está caído. Además el error se imprime dos veces porque la ejecución continúa a `resolveEntity()` (línea 119), que vuelve a fallar. Y `doctor` **sí** tiene el texto correcto para este error exacto: el remedio existe en el repositorio y no está cableado a ningún otro camino.

**Escenario.** Martes de cierre, se cae el túnel SSH a la base. El contador corre `mnemosine cfdi list`. Lee que su entidad activa no se pudo resolver y que la arregle con `entity use`. Ejecuta `mnemosine entity use ACME` — falla igual. Prueba `entity unset` — falla igual. Pierde media hora persiguiendo un fantasma de configuración antes de que se le ocurra que la base no responde. Ningún mensaje de los que vio nombra `mnemosine doctor`.

---

### 5 · Una palabra desconocida en la raíz se la traga `chat` y el error habla de un comando que el usuario no escribió. — ALTA / S

```
$ npx tsx src/cli/mnemosine.ts diot
error: too many arguments for 'chat'. Expected 0 arguments but got 1: diot.
$ echo $?
1

$ npx tsx src/cli/mnemosine.ts balanza
error: too many arguments for 'chat'. Expected 0 arguments but got 1: balanza.

$ npx tsx src/cli/mnemosine.ts entiti
error: too many arguments for 'chat'. Expected 0 arguments but got 1: entiti.
```

Causa: `src/cli/mnemosine.ts:617` — `.command('chat', { isDefault: true })`. Commander enruta el token desconocido al comando por omisión, que no acepta argumentos posicionales.

**Práctica incumplida.** git lleva `did you mean` desde 2009; `gh`, `docker` y `kubectl` lo tienen. Commander expone `showSuggestionAfterError()` y no se usa. Nielsen 9 otra vez: el mensaje no nombra el token como desconocido, no lista lo cercano, y menciona un comando (`chat`) que el usuario no tecleó.

**Escenario.** El contador quiere la balanza. `balanza` es un alias real del producto —bajo `report trial-balance`— así que la intuición es correcta. Escribe `mnemosine balanza` y el sistema le habla de `chat`. Prueba `mnemosine diot` y le vuelve a hablar de `chat`. Concluye, razonablemente, que el binario está roto. Un `did you mean: report trial-balance` habría resuelto el primer caso y un «`diot` no es un comando» el segundo.

---

### 6 · La familia `sat` promete en su ayuda la descarga de CFDI, y no existe. Es el flujo del que vive el despacho. — ALTA / S

```
$ npx tsx src/cli/mnemosine.ts sat --help
SAT services (credentials and CFDI download)

Commands:
  cred            Fiscal credentials (e.firma)
  help [command]  display help for command

$ npx tsx src/cli/mnemosine.ts sat download
error: unknown command 'download'
$ echo $?
1
```

Origen del texto: `src/cli/sat-commands.ts:66`. La ausencia está documentada con todas sus letras en `docs/wiki/Home.md:74` («Ni cliente SOAP (`SolicitaDescarga` / `VerificaSolicitud`), ni lector de paquetes ZIP, ni comando `sat download`») y el criterio E3.2 de `plan:status` está en rojo a propósito (`src/plan/criterios.ts:1596-1607`). El proyecto es honesto — en el wiki. La ayuda del comando, que es donde el contador mira, dice lo contrario.

**Práctica incumplida.** clig.dev: la ayuda es la documentación primaria y debe describir lo que el comando hace, no lo que hará. Nielsen 2 (correspondencia con el mundo real) se cumple —«descarga de CFDI» es el nombre correcto de la cosa— pero Nielsen 1 y 4 se rompen: el estado que anuncia no es el estado que tiene.

**Escenario.** El despacho evalúa mnemosine. El socio corre `mnemosine sat --help`, lee «credentials and CFDI download», y decide que el flujo mensual está cubierto. Da de alta la e.firma de doce clientes con `sat cred add` —que sí funciona, y guarda material criptográfico serio en bóveda— y hasta el día 5 del mes siguiente no descubre que no hay de dónde bajar los CFDI. La comparación es brutal: CONTPAQi ADD, Aspel, Contalink y cualquier «descargador» de $300 al mes hacen exactamente eso y nada más.

---

### 7 · `entry import` es un callejón sin salida: escenifica el lote y la familia que lo aplica no existe. — MEDIA / M

```
$ npx tsx src/cli/mnemosine.ts entry import --help
Stage a file of entries into a batch (returns a batch_id); NEVER touches the ledger
  --layout <name>   file layout: csv, ndjson
                    (contpaqi/aspel/iif/sat-polizas: aún sin parser) (default: "csv")

$ npx tsx src/cli/mnemosine.ts entry batch --help
Usage: mnemosine entry|poliza [options] [command]
Journal entries: draft, inspect, validate, post, reverse and void
```

`entry batch` no existe: Commander imprime la ayuda del padre. Y `src/cli/entry-command.ts:754` lo dice en la salida del propio comando: «se valida y aplica con la familia batch (check/post) **cuando llegue**».

**Práctica incumplida.** clig.dev, *Idempotency and completeness*: no publiques la mitad de un flujo sin la otra. El aviso en la salida es honesto y se le acredita, pero deja al usuario con un `batch_id` y ninguna operación que lo consuma. Y los layouts que faltan son precisamente los de los sistemas que el despacho trae puestos: pólizas de CONTPAQi y de Aspel.

**Escenario.** El despacho migra un cliente. Exporta las pólizas del año de CONTPAQi, las convierte a CSV a mano, corre `entry import`, obtiene un `batch_id`, y no hay comando que lo aplique. La única ruta de migración real, `onboard`, sólo habla con Contalink (`-p, --provider <name>   External system, e.g. contalink`), no con CONTPAQi ni Aspel.

---

### 8 · No hay ninguna vista de todos los clientes a la vez. Esa es LA operación del despacho. — ALTA / M

Toda la superficie es de una entidad por invocación: `-e, --entity <idOrName>` en las 85 hojas con contexto. `close --list`, `close --check`, `period list`, `pending`, `drafts`, `question list` — todas por entidad. La única operación transversal del binario es de mantenimiento:

```
src/cli/report-command.ts:645
note('Reporting views rebuilt for every entity in this installation.');
```

Verificado: `grep -rn "all-entities\|allEntities\|across entities\|portfolio" src/cli` → sólo esa línea.

**Práctica incumplida.** Es el caso de uso central del segmento. NetSuite tiene consolidación multi-subsidiaria y un *Period Close Checklist* que se ve por entidad legal desde un solo tablero. Xero tiene *Practice Manager* / *XPM* con la lista de clientes y qué le falta a cada uno. QuickBooks tiene *QuickBooks Online Accountant*, cuya pantalla de inicio es literalmente «tus clientes y su estado». CONTPAQi tiene el selector de empresa, que es poco, pero al menos las lista con su ejercicio abierto. mnemosine tiene `entity list` y nada más.

Y hay que ser justo: el producto **sí** trae la pieza para construirlo — `entity list -q` («identifiers only, one per line, for piping»). Pero eso convierte «¿a quién le falta cerrar julio?» en:

```
mnemosine entity list -q | while read id; do mnemosine close --check -e "$id"; done
```

Un bucle de shell, para un usuario que el propio enunciado del producto describe como alguien que no necesariamente sabe de terminales. Es la brecha de tipo «la capacidad existe pero el camino es intransitable» en su forma más pura.

**Escenario.** Día 12 del mes. El socio quiere saber cuáles de sus 40 clientes ya tienen la balanza cuadrada y cuáles siguen con borradores sin revisar. Hoy son 40 `entity use` más 40 `close --check`, leídos de uno en uno, sin nada que los junte. En QBOA es una pantalla.

---

### 9 · La validación de argumentos ocurre DESPUÉS del viaje a la base: todo error de captura se presenta como error de Postgres. — MEDIA / S

Dos reproducciones del mismo patrón:

```
$ npx tsx src/cli/mnemosine.ts ingest ./files.zip

role "postgres" does not exist

$ npx tsx src/cli/mnemosine.ts onboard --provider contpaqi --cutoff 2026-07-31 --dry-run
role "postgres" does not exist
```

Ni «un ZIP no es un CFDI; pásame los XML» ni «`contpaqi` no es un sistema externo conocido; los disponibles son: contalink». Nótese que `--dry-run` —la bandera cuyo contrato es «compute and show the full effect; **write nothing and call nothing external**»— tampoco evita la conexión.

**Práctica incumplida.** clig.dev, *Validate user input as early as possible* y *Suggest valid values for an enum*. La convención GNU de CLI dice lo mismo: los errores de uso se detectan antes de hacer trabajo, y salen con código de uso, no con el código genérico. Aquí todo sale 1, indistinguible de una caída de red.

**Escenario.** El SAT entrega los CFDI en un ZIP; eso es lo que el contador tiene en el escritorio. Corre `mnemosine ingest descarga-julio.zip` y lee un error sobre roles de Postgres. No hay en toda la salida un solo carácter que sugiera que el problema es el formato del archivo. Nada en la ayuda de `ingest` dice que sólo acepta XML sueltos, ni que hay que expandir el ZIP, ni que hay que escribir un glob.

---

### 10 · Los reportes que el despacho ENTREGA no salen en el formato en que se entregan. — MEDIA / M

```
$ npx tsx src/cli/mnemosine.ts report trial-balance show --help
  --format <table|json|ndjson|csv|tsv|md>  output format (default: "table")
  -o, --output <path>                      write to a file instead of stdout
  --period <expr>                          period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06
  --level <n>                              roll up to at most this account level
  --exclude-zero                           omit accounts whose ending balance is exactly zero
```

Verificado: sin PDF, sin XLSX. Y `grep -rn "comparativ\|prior year\|--compare" src/cli/report-command.ts` → sin resultados: no hay columna comparativa contra el mes anterior ni contra el mismo mes del ejercicio previo. Tampoco hay un comando que arme el paquete mensual: son seis invocaciones sueltas (`trial-balance`, `balance-sheet`, `income-statement`, `general-ledger`, `aged-receivable`, `aged-payable`), cada una con su `-o`.

**Práctica incumplida.** No es una brecha de formato de archivo, es de flujo. CONTPAQi y Aspel COI exportan a Excel y PDF con un clic y tienen «juegos de reportes». Xero y QuickBooks tienen *report packs* que se generan y se mandan por correo al cliente. El comparativo contra periodo anterior es la columna que el cliente lee primero. El `-o` por comando es la primitiva correcta —y el `--period` con `last-month` y rangos `2026-01..2026-06` está bien pensado— pero el despacho entrega un paquete, no seis CSV.

**Escenario.** Día 20, el despacho manda estados financieros a 40 clientes. Por cliente: seis comandos, seis archivos CSV, abrir Excel, dar formato, convertir a PDF, adjuntar. Multiplicado por 40. En CONTPAQi es «Reportes → juego de estados financieros → PDF».

---

### 11 · La interfaz es bilingüe al azar a nivel de cadena, no «inglés con alias en español». — MEDIA / S

El orquestador ya reprodujo el `lang` («CLI UI stays English») y la familia `ai|ia`. El alcance es mayor: la mezcla baja al nivel de argumento y de bandera, dentro de comandos por lo demás en inglés.

```
src/cli/ai-command.ts:52   .description('Métricas y calibración del agente contable')
src/cli/ai-command.ts:71   .description('Aprobación por bucket de confianza, delta confianza-vs-realidad, costo y eventos')
src/cli/account-command.ts:552  'CSV: code,valor (una cuenta por línea; separador coma o punto y coma)'
src/cli/account-command.ts:590  ' [repetido: resultado de la primera corrida]'
src/cli/cfdi-command.ts:97      'emitido, recibido o ajeno (derivada contra el RFC de la entidad)'
src/cli/cfdi-command.ts:153     'consulta al SAT ahora y actualiza la caché sat_* del documento'
src/cli/entry-command.ts:750    ' [repetido: lote de la primera corrida]'
src/cli/entry-command.ts:754    'El lote NO tocó el mayor: se valida y aplica con la familia batch...'
```

Visible así:

```
$ npx tsx src/cli/mnemosine.ts account map import --help
Bulk-load a statutory scheme from CSV — the heaviest setup task of a Mexican firm

Arguments:
  file                     CSV: code,valor (una cuenta por línea; separador coma
                           o punto y coma)
```

Una descripción en inglés y su argumento en español, en la misma pantalla.

**Práctica incumplida.** Nielsen 4 (consistencia y estándares) y Nielsen 2 (el lenguaje del usuario). Una decisión de «todo en inglés» es defendible y una de «todo en español» es la correcta para el segmento; lo indefendible es que el usuario no pueda formarse ninguna expectativa. El costo real no es estético: un contador que ve español en `account map import` asume que puede escribir `mnemosine cuenta mapeo importar`, y eso sí funciona por los alias, pero luego ve inglés en `entry` y no sabe si `poliza contabilizar` existe (existe) ni si `report balanza` existe (no: es `report trial-balance` con alias `balanza` en el hijo).

---

### 12 · 46 familias en una lista plana, cero ejemplos en 134 comandos, y grupos con un solo hijo. — MEDIA / M

```
$ npx tsx src/cli/mnemosine.ts --help | sed -n '/^Commands:/,$p' | grep -cE "^  [a-z]"
46

$ grep -rn "addHelpText" src/
(sin resultados)
```

Además el árbol tiene grupos que sólo estorban:

```
$ npx tsx src/cli/mnemosine.ts report trial-balance
Usage: mnemosine report trial-balance|balanza [options] [command]
Trial balance
Commands:
  show|ver [options]  Debits, credits and ending balance by account, with the footing
$ echo $?
1
```

Tres niveles para una balanza: `report trial-balance show`. Lo mismo en `report income-statement show`, `report balance-sheet show`, `ledger auxiliary show`, `account balance show`. Y el grupo sin hijo sale 1 sin decir qué falta.

**Práctica incumplida.** clig.dev, *Group related commands* y *Provide examples in help*: `gh help` agrupa en «core», «actions», «additional»; `docker` separa «Management Commands»; `kubectl` tiene «Basic», «Deploy», «Cluster Management». Ninguno presenta 46 hermanos en una columna. Y clig.dev es explícito en que la ayuda debe traer ejemplos ejecutables — `stripe`, `gh` y `aws` los traen todos. Cero de 134 aquí. Nielsen 6 (reconocer antes que recordar): sin agrupación y sin ejemplos, el usuario tiene que recordar la sintaxis en lugar de reconocerla.

**Escenario.** El contador abre `mnemosine --help` por primera vez. Ve 46 nombres en inglés, ordenados ni alfabética ni temáticamente —`entities`, `providers`, `ask`, `chat`, `sessions`, `drafts`, `review`, `ingest`, `lang`, `onboard`...— sin una sola línea que le diga por dónde empieza el mes. Ni un `mnemosine ingest ./cfdi/*.xml` de ejemplo en ninguna parte.

---

### 13 · Las pistas de «qué sigue» apuntan a comandos obsoletos, y `drafts` quedó fuera del núcleo de salida. — BAJA / S

`src/cli/mnemosine.ts:1326` y `src/ai/close-service.ts:117` remiten a `mnemosine questions`, que ya está deprecado:

```
$ npx tsx src/cli/mnemosine.ts questions
  ⚠ deprecated: `mnemosine questions` is split into `question list` and `question answer` — this shortcut will go away.
```

Y el mismo `close-service.ts:127` remite a `mnemosine outbox`, que hoy es un grupo cuyo `-l, --list` también está marcado deprecado.

Aparte, la cola diaria quedó fuera del contrato de salida que el resto del binario sí honra:

```
$ npx tsx src/cli/mnemosine.ts drafts --json
error: unknown option '--json'
```

**Práctica incumplida.** clig.dev: la deprecación se anuncia y **se deja de usar internamente**; el camino feliz no puede enseñar el nombre viejo. Y el contrato de salida no puede tener huecos: `drafts` es de los comandos que más se querría canalizar a un script de despacho, y es de los pocos sin `--format`.

---

## RECOMENDACIONES

**Primero, y hoy mismo (todas son de esfuerzo S):**

1. **Una sola función de confirmación**, exportada del núcleo, anclada, que acepte `y|yes|s|si|sí` y **nada más**, y que ante una respuesta no reconocida diga «no entendí "salir"; responde y/n» en lugar de decidir. Borrar los cuatro predicados de `close-command.ts:180`, `entry-command.ts:262`, `payment-command.ts:116`, `invoice-command.ts:228`, `mnemosine.ts:1436` y `mnemosine.ts:1631`. Añadir una prueba que falle si aparece un quinto. Esto cierra la Brecha 1 y quita el riesgo de un cierre duro accidental.
2. **Condicionar el mensaje de `entity-context.ts:110` a la causa.** Si el error trae `ECONNREFUSED`, `role ... does not exist`, `timeout` o `28000`, el texto correcto no es «no pude resolver la entidad» sino el que ya escribió `doctor`: «no hay conexión con la base — revisa DATABASE_URL en .env; diagnostica con `mnemosine doctor`». Y no seguir a `resolveEntity()` después de avisar, para que el error no salga dos veces. Un solo archivo arregla 85 comandos.
3. **Encender `showSuggestionAfterError()`** en el programa raíz, y hacer que el token desconocido se rechace como token desconocido en vez de caer en `chat`.
4. **Corregir `sat-commands.ts:66`**: la descripción debe decir lo que la familia hace hoy —«Credenciales fiscales (e.firma). La descarga masiva de CFDI todavía no existe»—. Es una línea y evita que un despacho compre un flujo que no está.
5. **Reemplazar las remisiones a `questions` y `outbox` sueltos** por `question list` y `outbox list` en `mnemosine.ts:1326` y `close-service.ts:117,127`.

**Después, por orden de valor para el despacho:**

6. **Un `mnemosine bank` sobre el motor que ya existe** (`services/banking/matching.ts`): `bank import <archivo>`, `bank match`, `bank list --unmatched`, `bank reconcile`. Es esfuerzo M, no L, porque el motor y el esquema están; falta la superficie. Mientras no exista, la partida «Bank reconciliations complete» del checklist debería decir explícitamente «esta partida sólo se puede resolver por la API REST».
7. **Filtros y lote en `review`**: `--min-amount`, `--max-amount`, `--min-confidence`, `--vendor`, `--limit`, y un `--approve-all` que exija `--min-confidence` y `--yes` juntos. Y que la respuesta no reconocida se diga, en vez de saltarse el borrador en silencio.
8. **Un `mnemosine firm status`** (o `entity status --all`) que recorra las entidades del tenant y devuelva una fila por cliente: periodo abierto más viejo, borradores pendientes, preguntas sin contestar, si la balanza cuadra. Es la pantalla de QBOA y de XPM, y es el comando que convierte a mnemosine en herramienta de despacho y no de contribuyente. El `entity list -q` ya da la primitiva; falta el comando que la use.
9. **Validar argumentos antes de conectar**: extensión de archivo en `ingest` (con mensaje explícito para `.zip` y para directorios), catálogo de proveedores en `onboard`, y que `--dry-run` de verdad no abra conexión. Es el mismo cambio en las tres rutas.
10. **`addHelpText('after', ...)` con un ejemplo real en las veinte hojas más usadas**, empezando por `ingest`, `review`, `close`, `report trial-balance show` y `account map import`. Y agrupar las 46 familias de la raíz en cinco bloques —captura, revisión, mayor, reportes, administración— como hacen `gh` y `docker`.
11. **Aplanar los grupos de un solo hijo**: `report trial-balance` debería ejecutar la balanza, no imprimir su propia ayuda y salir 1.
12. **Decidir el idioma y aplicarlo.** Para el segmento declarado la respuesta es español, con alias en inglés. Sea cual sea, una prueba que falle si una cadena visible mezcla idiomas dentro de la misma familia. Ocho cadenas identificadas arriba son el punto de partida.
13. **Cerrar el callejón de `entry import`**, o esconder el comando hasta que exista `entry batch check/post`. Un `batch_id` que nadie consume es peor que la ausencia del comando.
