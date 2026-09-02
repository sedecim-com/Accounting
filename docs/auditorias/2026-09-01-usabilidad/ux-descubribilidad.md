## LO QUE ESTÁ BIEN (y hay que acreditarlo)

**1. `doctor` es el modelo que el resto del CLI debería copiar.** Es el único lugar donde un fallo trae síntoma, causa y remedio ejecutable:

```
$ npx tsx src/cli/mnemosine.ts doctor ; echo "exit=$?"

Mnemosine health check

  ✘ Database        no connection: role "mnemo" does not exist
      → Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)
  ✘ Model provider  anthropic requires ANTHROPIC_API_KEY and it is not set
      → Set ANTHROPIC_API_KEY in .env, or use --provider ollama
  ⚠ Encryption key  ENCRYPTION_KEY not set (the code default is used)
      → openssl rand -hex 32  → ENCRYPTION_KEY in .env

  There are failures that prevent operation. Resolve them in the order shown.
exit=1
```

Enumera todo aunque el primero falle, distingue `✘` de `⚠`, ordena por dependencia y sale con 1. Es exactamente lo que clig.dev llama un error accionable y lo que Nielsen #9 pide («ayudar a reconocer, diagnosticar y recuperarse»).

**2. `status` cumple el contrato de «salida compartible».** Sale con 1, no filtra secretos y lo dice:

```
Database
  connection         FAIL  auth (28000)
  RLS tenant scope   inactive  skipped: database unreachable
...
Redacted output: no keys, tokens or home paths. Safe to share in support tickets.
```

Es la práctica de `gh` y de `stripe` (`stripe status`, `gh auth status`): un comando pensado para pegarse en un ticket. Pocos CLI lo hacen.

**3. El flujo de entrada por estado (`first-run.ts` + `renderBrokenFlow`) sí remite a `doctor`.** Aquí hay que *corregir* el hallazgo del orquestador («NINGÚN error remite a doctor»): es cierto para los 134 comandos, es falso para la invocación desnuda. Reproducido bajo TTY real con un `DATABASE_URL` roto:

```
$ script -q /dev/null npx tsx src/cli/mnemosine.ts < /dev/null
█▀▄▀█ █▄ █ █▀▀ █▀▄▀█ █▀█ █▀ █ █▄ █ █▀▀
█ ▀ █ █ ▀█ ██▄ █ ▀ █ █▄█ ▄█ █ █ ▀█ ██▄
┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘┌┘
v0.1.0 · Your books, remembered.

chat: just type · /help for commands · mnemosine status for a checkup
Something needs attention before we can chat:
  · database unreachable: role "mnemo" does not exist
      → mnemosine doctor   (and check DATABASE_URL in .env)
```

Y en máquina virgen ofrece el rescate en línea sin abandonar el comando que el usuario ya tecleó:

```
Welcome. Mnemosine is an AI accountant that keeps your books auditable: it drafts, you approve.
  · no .env file (never configured)

Run setup now? [Y/n]
```

El comentario de `src/cli/first-run.ts:12-19` explica el porqué: el estado no se guarda en un archivo, se vuelve a derivar del sistema en cada arranque. Es la decisión correcta y es rara.

**4. El vocabulario cerrado no es una aspiración: hay un auditor que corre contra el binario real y una línea base congelada que sólo puede encoger.** `src/cli/kernel/audit.ts` (`LINEA_BASE`) y `tests/cli/kernel/auditoria-programa.spec.ts:13-24` dicen literalmente que `auditProgram` vivía en pruebas de juguete, que la primera corrida contra el `program` real dio 40 violaciones y que ahora la lista no puede crecer ni conservar entradas muertas. Verificado corriéndolo yo mismo sobre el árbol embarcado:

```
violaciones vivas: 36 | LINEA_BASE: 36
{ "R1 objectless allowlist": 7, "R6 banned spelling": 1, "R3 closed verb list": 8,
  "R6 short flag": 12, "list contract": 8 }
```

De 40 a 36. Y el vocabulario funciona donde importa: de 134 hojas, 22 son `list` y 21 son `show` — 43 de 134 comandos con dos verbos. Eso es aprendizaje transferible de verdad.

**5. Los alias en español al primer nivel están casi completos, y los del dominio contable son los correctos.** De 45 comandos raíz (sin `help`), sólo 5 no traen alias, y tres de ellos (`sat`, `cfdi`, `rep`) ya son siglas mexicanas. La familia de reportes usa el vocabulario del despacho:

```
  trial-balance|balanza              income-statement|resultados
  balance-sheet|balance              general-ledger|mayor
  aged-receivable|antiguedad-cobrar  aged-payable|antiguedad-pagar
```

`balanza`, `mayor`, `resultados`, `antigüedad de saldos` es lo que dice CONTPAQi. No es una traducción de diccionario.

**6. La sugerencia ante error de tecleo funciona dentro de las familias**, incluso con acento:

```
$ mnemosine entry pst 3
error: unknown command 'pst'
(Did you mean post?)

$ mnemosine reporte antigüedad-cobrar
error: unknown command 'antigüedad-cobrar'
(Did you mean antiguedad-cobrar?)
```

**7. `src/cli/kernel/output.ts:14-26` fija dos reglas de corrección, no de estilo:** el dinero nunca es número JSON («un round-trip por float es cómo una balanza deja de cuadrar por un centavo que nadie encuentra») y el truncamiento siempre se reporta. Y separa stdout (datos) de stderr (todo lo demás). Eso es el contrato de tubería de clig.dev bien entendido.

---

## BRECHAS

### 1. El comando `mnemosine` no existe. Todos los remedios del producto citan un binario que el contador no tiene. — ALTA / S

```
$ which mnemosine ; echo "exit=$?"
mnemosine not found
exit=1

$ grep -n '"bin"' package.json
(sin coincidencias)
```

`package.json` no declara `bin`. La única forma de invocar es `npm run mnemosine ...` o `npx tsx src/cli/mnemosine.ts ...`. Mientras tanto, cada mensaje de auxilio del sistema dice otra cosa: `Not configured. Run: mnemosine init` (`src/cli/mnemosine.ts:697`), `→ mnemosine doctor   (and check DATABASE_URL in .env)` (`:401`), `Use \`mnemosine entity use <id|name>\`` (`src/cli/kernel/entity-context.ts:111`), y el banner `mnemosine status for a checkup` (`src/cli/banner.ts:41`).

**Práctica que incumple:** clig.dev, «un CLI es un programa que se instala y se invoca por su nombre»; y la convención de npm de declarar `bin` para todo paquete ejecutable. `git`, `gh`, `docker`, `stripe` y `psql` se llaman por su nombre; ninguno pide al usuario recordar la ruta de su punto de entrada.

**Escenario:** el contador lee en la salida de error «Run: mnemosine init», lo teclea, y el shell le contesta `command not found: mnemosine`. El primer consejo que le da el producto es el primero que falla. Ahora tiene dos problemas y ninguna pista de que el correcto era `npm run mnemosine -- init` — con el `--` que nadie le explicó.

---

### 2. La ayuda entera son 8,731 palabras en inglés, mientras el agente contesta en español por omisión. — ALTA / L

Medido recorriendo el árbol de comandos embarcado:

```
comandos: 179 | palabras de descripcion: 1848
opciones: 1083 | palabras de opciones: 6883
TOTAL palabras de ayuda en ingles (aprox): 8731
```

Y el idioma por omisión del agente es español (`src/ai/providers/config.ts:590`, `return config.language ?? 'es'`):

```
$ mnemosine lang
Agent response language: es
Change it with: mnemosine lang en|es (or MNEMOSINE_LANG env var)
```

El propio comando declara la contradicción como política: `Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command aliases always work)`.

Sólo dos nodos de 179 describen en español, ambos de la familia `ai|ia`:

```
ai :: Métricas y calibración del agente contable
ai stats :: Aprobación por bucket de confianza, delta confianza-vs-realidad, costo y eventos
```

**Práctica que incumple:** Nielsen #2 («coincidencia entre el sistema y el mundo real: hablar el lenguaje del usuario»). CONTPAQi, Aspel COI y Contalink están íntegramente en español; ningún despacho mexicano opera un sistema contable en inglés. Y la inconsistencia interna —dos nodos en español, 177 en inglés— viola además Nielsen #4 (consistencia).

**Escenario:** el contador escribe una pregunta y el agente le contesta en español correcto. Envalentonado, teclea `--help` para ver qué más puede hacer, y recibe 113 líneas de inglés técnico. El producto le acaba de demostrar que entiende su idioma y acto seguido le niega la puerta.

---

### 3. Cualquier palabra desconocida en el primer nivel se la traga `chat`: no hay «¿quisiste decir…?» donde más falta hace. — ALTA / S

`chat` está declarado `isDefault`, así que commander le entrega todo token no reconocido como argumento posicional en vez de reportar comando desconocido:

```
$ mnemosine balanza
error: too many arguments for 'chat'. Expected 0 arguments but got 1: balanza.

$ mnemosine ayuda
error: too many arguments for 'chat'. Expected 0 arguments but got 1: ayuda.

$ mnemosine reportes
error: too many arguments for 'chat'. Expected 0 arguments but got 1: reportes.

$ mnemosine póliza list
error: too many arguments for 'chat'. Expected 0 arguments but got 2: póliza, list.

$ mnemosine completion
error: too many arguments for 'chat'. Expected 0 arguments but got 1: completion.
```

Nótese el contraste con la brecha 6 del apartado anterior: **el sugeridor existe y funciona una capa más abajo** (`entry pst` → `Did you mean post?`). Es un cable sin conectar en la raíz, no una capacidad ausente.

Nótese también qué palabras caen aquí: `ayuda` (el español de `help`), `balanza` y `póliza` (el vocabulario del oficio, que además SÍ existen como alias un nivel adentro), y `completion` y `version`, que `src/cli/kernel/vocabulary.ts:130-131` reserva explícitamente en `OBJECTLESS_COMMANDS` pero nadie implementó.

**Práctica que incumple:** clig.dev, «si el usuario se equivoca, sugiere el comando correcto»; y el comportamiento de `git` (`git stauts` → `The most similar command is status`), `docker` y `kubectl`. Nielsen #9.

**Escenario:** primer día. El contador sabe que quiere la balanza de comprobación. Teclea `mnemosine balanza`, que es literalmente el alias correcto de `report trial-balance`, sólo que un nivel más arriba de donde vive. El sistema le contesta hablándole de un comando `chat` que él nunca escribió y de «argumentos» que no sabe qué son. La palabra correcta, castigada con un error incomprensible.

---

### 4. Cero ejemplos en 179 nodos de ayuda, y el único manual del contador no contiene ni un comando. — ALTA / M

```
$ grep -rn "addHelpText" src/ | wc -l
       0

$ grep -c "mnemosine " README_ACCOUNTANT.md
0
```

`README_ACCOUNTANT.md` son 31 KB en español, con el vocabulario correcto («cargo», «abono», «póliza», «catálogo de cuentas»), y no menciona el CLI una sola vez: documenta el motor, no el producto. El único documento con comandos, `docs/cli-command-catalog.md` (3,065 líneas), se declara a sí mismo «Documento de diseño» y no es alcanzable desde el binario.

El costo concreto. El contador quiere contabilizar una póliza y pide ayuda:

```
$ mnemosine entry create --help
Usage: mnemosine entry create|crear [options]

Create a journal entry — ALWAYS a draft; posting is a separate human step

Options:
  --line <spec...>         a line as
                           <account>:<debit|credit>:<amount>[:description];
                           repeat for each line
  --type <type>            entry type: standard, adjusting, correction (default:
                           standard)
  ...
```

Sale de ahí sin saber: si `<account>` es el código `601-01`, el nombre o un UUID; si `<amount>` lleva punto, coma o signo de pesos; si el separador `:` choca con una descripción que lleve `:`; cuántas `--line` puede repetir; ni cuál de los tres `--type` corresponde a una póliza de egresos. Una sola línea `addHelpText('after', ...)` respondería las seis:

```
mnemosine entry create --date 2026-08-31 --description "Renta agosto" \
  --line 613-01:debit:10000.00 --line 118-01:debit:1600.00 \
  --line 102-01:credit:11600.00
```

**Práctica que incumple:** clig.dev, «los ejemplos son la mejor documentación; muéstralos en `--help`». Es la convención de `git help`, `gh` (`EXAMPLES` en cada subcomando), `docker`, `stripe` y `aws`. `commander` lo soporta con `addHelpText` y el proyecto no lo usa ni una vez en 179 nodos.

**Escenario:** el contador tiene 40 pólizas de agosto pendientes. Abre `entry create --help`, lee la especificación `<account>:<debit|credit>:<amount>`, y prueba `--line "Renta:cargo:10,000.00"`. Falla tres veces por tres razones distintas —el nombre en vez del código, «cargo» en vez de «debit», la coma de millares— y cada falla le cuesta un ciclo de prueba contra una base de datos real. Al cuarto intento vuelve a Excel.

---

### 5. Los 134 comandos escupen el error crudo de Postgres, sin contexto ni remedio, y ninguno remite a `doctor`. — ALTA / S

```
$ mnemosine entity list ; echo "exit=$?"
role "mnemo" does not exist
exit=1

$ mnemosine pending
role "mnemo" does not exist
```

La causa está en un solo lugar, `src/cli/mnemosine.ts:241-256`. `reportError` tiene cuatro ramas —autenticación Anthropic, autenticación OpenAI, conexión al proveedor, error de API— cada una con su remedio escrito. La quinta, la genérica, es:

```ts
} else {
  console.error(ce.red(`\n${err instanceof Error ? err.message : String(err)}`));
}
```

No hay rama para el fallo de base de datos, que es el fallo más frecuente del primer día. El patrón «síntoma + remedio» ya está establecido dos líneas más arriba (`Set ANTHROPIC_API_KEY in your environment or .env`) y perfeccionado en `doctor`; simplemente no se aplicó al caso más común.

**Práctica que incumple:** clig.dev, «los mensajes de error deben decir cómo arreglar el problema»; Nielsen #9. `psql` mismo, ante el mismo fallo, dice `FATAL: role "mnemo" does not exist` precedido de `psql: error: connection to server ... failed` — al menos nombra la conexión.

**Escenario:** el contador corre `mnemosine entity list` y lee `role "mnemo" does not exist`. No sabe qué es un «role», no sabe que eso es Postgres, no sabe que existe un comando `doctor` que en tres líneas le diría `docker compose up -d postgres`. Llama al soporte del despacho. El sistema tenía la respuesta escrita y no la enseñó.

---

### 6. La envoltura de entidad misdiagnostica una caída de conexión como problema de selección, propone un remedio que no arregla nada, y luego imprime el error otra vez. — MEDIA / S

Reproducido, con los flujos separados para probar que las dos copias van a stderr:

```
$ mnemosine entry post 3 --yes 2>&1 1>/dev/null ; echo "exit=$?"
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "mnemo" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "mnemo" does not exist
exit=1
```

`src/cli/kernel/entity-context.ts:100-115`. En descargo del código: el comentario que lo acompaña es honesto y la decisión de fondo es correcta —«NEVER clear the pin here… un pin obsoleto es una molestia que el usuario arregla en un comando; uno borrado en silencio es estado que no puede recuperar»—. El problema no es que conserve la selección, es que **no distingue las dos causas que el propio comentario reconoce que caen en el mismo `catch`**: entidad archivada (donde `entity use` sí es el remedio) y conexión caída (donde no lo es). Ante la segunda, ofrece un remedio inerte y filtra un UUID que al contador no le dice nada.

**Práctica que incumple:** Nielsen #9 y clig.dev: un remedio incorrecto es peor que ninguno, porque consume el intento del usuario. La duplicación viola además la regla de «di cada cosa una vez» del contrato de salida del propio proyecto.

**Escenario:** el contador quiere contabilizar la póliza 3 antes de cerrar el mes. Lee «no pude resolver la entidad activa» y hace lo que le dicen: `mnemosine entity use "Mi Empresa SA"`. Falla igual. Prueba `entity unset`. Falla igual. Diez minutos persiguiendo un problema de selección de empresa que nunca existió: Postgres no está arriba.

---

### 7. El vocabulario de los VALORES es sólo en inglés, y los tipos de póliza no son los que exige el SAT. — ALTA / M

Los alias traducen los comandos pero no lo que se teclea dentro de ellos. `src/services/accounting/journal-entry-service.ts:532-537`:

```ts
const side = sideRaw.trim().toLowerCase();
if (side !== 'debit' && side !== 'credit') {
  throw new ValidationError(
    `--line "${spec}": the side must be "debit" or "credit", not "${sideRaw}".`
  );
}
```

`cargo` y `abono` —las dos palabras que un contador mexicano usa todos los días, las mismas que `README_ACCOUNTANT.md` emplea («todo cargo tiene un abono correspondiente»)— están rechazadas. Y el enum de tipos, según la ayuda de `entry create`, es `standard, adjusting, correction`: vocabulario US GAAP. El anexo de Contabilidad Electrónica del SAT (`PolizasPeriodo`) y tanto CONTPAQi como Aspel COI trabajan con **Diario, Ingresos, Egresos** (y Traspaso). No hay alias ni mapeo.

Agravante: no se puede ni descubrir el error sin base de datos, porque `--dry-run`, que la ayuda describe como «validate and show the entry that would be drafted; write nothing», no es offline:

```
$ mnemosine entry create --line "601-01:cargo:1160.00" --line "102-01:abono:1160.00" --description "prueba" --dry-run
role "mnemo" does not exist
```

**Práctica que incumple:** Nielsen #2 otra vez, pero en el punto donde más duele. Y el precedente propio del proyecto: `docs/cli-command-catalog.md` declara haberse contrastado contra CONTPAQi y Aspel; el resultado no llegó al enum. Compárese con `hledger`/`beancount`, que aceptan el vocabulario del plan de cuentas del usuario, no el del autor.

**Escenario:** el contador entiende la especificación `<account>:<debit|credit>:<amount>` y aun así teclea `cargo`, porque lleva veinte años tecleando cargo. El error sólo aparece si la base está viva; si no, recibe `role "mnemo" does not exist` y concluye que la sintaxis estaba bien. Cuando por fin llega al enum de tipos, tiene que decidir si una póliza de egresos es `standard`, `adjusting` o `correction`, y cualquiera que elija romperá la exportación al SAT.

---

### 8. Los alias en español son parciales en la profundidad y no aceptan acentos. — MEDIA / M

Recorriendo el árbol embarcado:

```
TOTAL nodos: 179 | HOJAS (comandos ejecutables): 134 | FAMILIAS: 45
hojas SIN alias: 14 de 134
chat, doctor,
approvals list, approvals grant, approvals revoke,
jobs list, jobs create, jobs enable, jobs disable, jobs run-due, jobs history,
skills list, skills drafts, skills view
```

Tres familias completas (`approvals`, `jobs`, `skills`) no tienen ni un subcomando en español, y al primer nivel faltan `chat` (¿`platicar`?) y `doctor` (¿`diagnostico`?) — los dos comandos que más se teclean el primer día. Y el alias es ASCII estricto: `póliza` con acento no llega ni al sugeridor (brecha 3), mientras que `antigüedad-cobrar` sí, porque dentro de la familia el sugeridor sí opera. Es decir: **el mismo acento se perdona un nivel adentro y se castiga en la raíz.**

**Práctica que incumple:** la regla que el propio `src/cli/kernel/vocabulary.ts:11-16` se impone («Spanish is an alias layer, never a second surface») exige que la capa sea completa; una capa con hoyos es peor que ninguna, porque enseña una expectativa que luego falla. Nielsen #4.

**Escenario:** el contador aprende que todo tiene su palabra en español —`entidad`, `poliza`, `reporte`, `balanza`— y generaliza. Llega a las políticas de aprobación y teclea `mnemosine aprobaciones listar`. Lo traga `chat`. Concluye que se equivocó de familia y va a buscar en la ayuda de nuevo.

---

### 9. No hay autocompletado, no hay página de manual, y `--version` no sirve para reportar un problema. — MEDIA / M

```
$ mnemosine --version
0.1.0

$ grep -n '"version"' package.json
  "version": "1.0.0",

$ mnemosine completion
error: too many arguments for 'chat'. Expected 0 arguments but got 1: completion.
```

`src/cli/mnemosine.ts:127` codifica `const CLI_VERSION = '0.1.0'` a mano, desalineado del paquete. La salida es un número pelado: sin commit, sin versión de Node, sin ruta de configuración. Y `completion` está reservado en el vocabulario (`vocabulary.ts:130`) sin implementación, siendo que `commander` no lo genera solo.

**Práctica que incumple:** clig.dev pide autocompletado de shell y una `--version` que sirva en un reporte de bug. `gh version`, `docker version`, `kubectl version` y `stripe version` imprimen build y plataforma; `gh completion -s zsh`, `kubectl completion`, `docker completion` y `stripe completion` son comandos de primera clase. En un CLI de **134 comandos en 45 familias**, el autocompletado no es un lujo: es el mecanismo principal de descubrimiento incremental. Sin él, la única vía es leer 113 líneas de ayuda.

**Escenario:** el contador teclea `mnemosine rep` y espera que el TAB le muestre `report`, `rep`. No pasa nada. Sin autocompletado, los 134 comandos sólo existen si ya sabías que existían — que es la definición exacta de un producto no descubrible.

---

### 10. La ayuda de primer nivel son 46 comandos en lista plana: enumera, no orienta. — MEDIA / M

```
$ mnemosine --help | wc -l
     113
```

113 líneas, 46 entradas de un solo nivel, sin agrupar y sin jerarquía visual. Conviven ahí `entry` (la operación central de un contador) y `prompt-size|tamano-prompt` («Offline breakdown of the system prompt and tool schemas»), con el mismo peso tipográfico y el mismo lugar en el orden. No hay una sección «empieza aquí», no hay un puntero a `init`, y no hay agrupación por función, aunque las funciones son evidentes y ya están en el árbol: catálogo y pólizas / clientes y proveedores / CFDI y SAT / reportes / sistema y agente.

Peor: la única pista de orientación que el producto emite —el `HINT` del banner, `src/cli/banner.ts:41`— dice `chat: just type · /help for commands · mnemosine status for a checkup`. No menciona `--help`, no menciona `init`, y manda a `status` en vez de a `doctor`, que es el que trae remedios.

**Práctica que incumple:** clig.dev, «la ayuda sin argumentos debe mostrar lo básico, no todo»; el modelo de `git help` (que separa «comandos de uso común» del resto), `docker` (Management Commands vs Commands) y `kubectl` (`Basic Commands (Beginner)`, `Basic Commands (Intermediate)`, `Troubleshooting`…). Nielsen #8 (diseño minimalista: cada unidad extra de información compite con la relevante).

**Escenario:** primer día, el contador teclea `--help` buscando cómo registrar una factura de proveedor. Ve 46 palabras en inglés. `bill|factura-proveedor` está en la posición 33, entre `vendor` y `customer`. Antes de llegar ahí pasó por `prompt-size`, `compact`, `approvals` y `webhooks`, cuatro conceptos que no significan nada para él y que le sugieren que este programa no es para él.

---

### 11. Hay tres comandos de salud solapados con tres calidades distintas, y el peor es el que el asistente de configuración expone. — MEDIA / S

`doctor`, `status` y `init --status` responden a la misma pregunta. Los dos primeros son buenos (ver acreditación). El tercero se corta en la primera sección que falla, en vez de degradar como hacen los otros dos:

```
$ mnemosine init --status ; echo "exit=$?"

Configuration status

  ○ pending  Infrastructure (database, migrations, encryption)

role "mnemo" does not exist
exit=1
```

`src/cli/init/` tiene seis secciones (`s0-infra` … `s5-import`). El usuario ve una, no le dicen que hay cinco más, y el mensaje que cierra la pantalla es el error crudo de la brecha 5.

**Práctica que incumple:** Nielsen #4 (consistencia) y #1 (visibilidad del estado del sistema): un panel de estado que se apaga al primer fallo no informa del estado, informa del primer fallo. `doctor`, doce líneas más abajo en el mismo binario, demuestra que la degradación por sección ya está resuelta en este proyecto.

**Escenario:** el contador corre `init --status` para saber cuánto le falta de configurar. Ve una línea con `○ pending` y un error de Postgres. No sabe si le falta un paso o seis, ni cuáles.

---

### 12. Cuatro comandos `list` rompen el contrato que el usuario aprendió en los otros dieciocho. — MEDIA / S

El auditor del propio proyecto lo tiene registrado (`list contract: 8` violaciones), y se reproduce en vivo:

```
$ mnemosine approvals list --format json
error: unknown option '--format'

$ mnemosine approvals list --limit 5
error: unknown option '--limit'

$ mnemosine jobs list --format json
error: unknown option '--format'
```

Contra el comportamiento normal, donde `--format json` sí se acepta y el comando llega hasta la base:

```
$ mnemosine entry list --format json
Could not resolve the active entity (…): role "mnemo" does not exist
```

Es debt registrada y congelada, lo cual es mucho mejor que debt invisible. Pero registrada o no, el contador la paga: de 22 comandos `list`, 20 se comportan igual y dos no.

**Práctica que incumple:** el propio contrato `list` del kernel, y la regla de clig.dev de que toda salida legible por humano tenga su equivalente legible por máquina. `kubectl -o json` y `gh --json` funcionan en *todos* los listados, sin excepción; ahí está su valor.

**Escenario:** el despacho arma un script para volcar a Excel las políticas de aprobación vigentes de cada cliente. `--format json` funcionó en las otras seis listas que probaron. En ésta no, y el error `unknown option` no dice qué formatos sí acepta ni sugiere alternativa.

---

### 13. `init` y `doctor` como camino de entrada: llevan a la infraestructura viva, no al primer asiento contabilizado. — MEDIA / M

Leídos `src/cli/init-command.ts`, `src/cli/init/s0-infra.ts` … `s5-import.ts` y la ayuda:

```
$ mnemosine init --help
Guided setup: infrastructure, entity, users, AI provider, and your books

Options:
  --section <id>   Configure a single section (infra|identity|users|ai|policies|import)
```

Las seis secciones cubren base de datos, entidad y RFC, usuarios, proveedor de IA, políticas e importación del catálogo. Es un buen asistente y termina con el sistema operativo. Pero el recorrido se detiene ahí: al salir, nada le dice al contador cuál es el siguiente comando. La sección `import` trae el catálogo de cuentas de su sistema anterior; después de eso, para llegar a una póliza contabilizada tiene que descubrir por su cuenta —sin ejemplos (brecha 4), sin autocompletado (brecha 9) y en inglés (brecha 2)— esta cadena de cinco comandos que ningún texto del producto enumera junta:

```
year create → period open → entry create --line … → entry check → entry post
```

`doctor` diagnostica la infraestructura con precisión, pero no responde «¿ya puedo contabilizar?». No comprueba que exista ejercicio abierto, ni periodo abierto, ni catálogo con cuentas.

**Práctica que incumple:** clig.dev, «di al usuario cuál es el siguiente paso» al terminar una operación larga. Es lo que hacen `gh repo create` («Next steps: …»), `stripe login` y `git init`. Y es lo que hace CONTPAQi al crear una empresa: te deja en la pantalla de captura de pólizas.

**Escenario:** el contador termina `init` con éxito, ve el mensaje de configuración completa, y se queda frente a un prompt vacío. Su pregunta —«¿y ahora cómo capturo la póliza de la renta?»— no tiene respuesta ni en la ayuda, ni en el manual del contador, ni en `doctor`. La única salida que el producto le ofrece es preguntárselo al agente en `chat`, lo cual funciona, pero convierte el CLI en un accesorio del modelo en vez de en un sistema contable operable.

---

## RECOMENDACIONES

Ordenadas por relación entre lo que cuestan y lo que desbloquean.

**Baratas y de alto retorno (días, no semanas):**

1. **Declarar `bin` en `package.json`** apuntando a `src/cli/mnemosine.ts` (o al build) y documentar `npm link` / instalación global. Es la brecha 1 completa, y sin ella todos los remedios del producto siguen mintiendo. Alinear de paso `CLI_VERSION` con la versión del paquete.

2. **Conectar el sugeridor en la raíz.** `program.showSuggestionAfterError()` ya está disponible en commander y funciona un nivel abajo; el bloqueo es `chat` como `isDefault` con aridad 0. Cambiar a: si el primer token no es un comando conocido y *no* parece lenguaje natural (una sola palabra sin espacios, por ejemplo), reportar comando desconocido con sugerencia en vez de entregarlo a `chat`. Y normalizar acentos al resolver alias (`póliza`→`poliza`), que es una línea. Cierra la brecha 3 y la mitad de la 8.

3. **Añadir una rama de base de datos a `reportError`** (`src/cli/mnemosine.ts:253`) con la forma que `doctor` ya usa: síntoma, causa probable y `→ mnemosine doctor`. Un `else if` cierra la brecha 5 para los 134 comandos. Y en `entity-context.ts:109`, distinguir el fallo de conexión del de entidad archivada antes de proponer `entity use`, y no volver a imprimir el error crudo (brecha 6).

4. **`addHelpText('after', …)` con uno a tres ejemplos reales** empezando por los veinte comandos que un despacho toca a diario: `entry create`, `entry post`, `bill create`, `invoice create`, `payment record`, `report trial-balance`, `close`, `ingest`, `review`. Un ejemplo con números mexicanos —IVA al 16 %, cuentas del código agrupador— vale más que tres párrafos. Cierra la brecha 4, que es la de mayor costo por hora perdida.

**De esfuerzo medio, pero es donde se decide si el producto es mexicano:**

5. **Aceptar `cargo`/`abono`** en `parseLineFlag` (dos términos más en la comparación de `side`) y **mapear los tipos de póliza a los del SAT** —Diario, Ingresos, Egresos, Traspaso— conservando los actuales como alias. Sin esto, la capa de alias es cosmética: traduce el sobre y no la carta (brecha 7).

6. **Hacer `--dry-run` genuinamente offline** donde la validación no requiere datos: parseo de `--line`, cuadre de la partida doble, formato de fecha. Es lo que ya hacen `prompt-size` y `compact`, que anuncian «no API calls». Permite al contador ensayar la sintaxis sin infraestructura.

7. **Traducir la superficie.** Las 1,848 palabras de descripciones son el 21 % del texto y el 80 % del beneficio: hazlas primero, deja las 6,883 de opciones para después. El mecanismo ya existe conceptualmente (`resolveLanguage()` devuelve `es` por omisión); lo que falta es que la UI lo consulte. Y completar los alias de `chat`, `doctor`, `approvals`, `jobs` y `skills` (brecha 8).

8. **Generar `mnemosine completion` para bash/zsh** —el nombre ya está reservado en el vocabulario— y hacer que emita también los alias en español. En un árbol de 134 hojas es la herramienta de descubrimiento más rentable que existe (brecha 9).

**Estructurales:**

9. **Agrupar la ayuda raíz** en cinco bloques con encabezado (Contabilidad · Clientes y proveedores · CFDI y SAT · Reportes · Sistema y agente), poner `init` y `doctor` arriba bajo «Empieza aquí», y reescribir el `HINT` del banner para que apunte a `--help` y a `init`. Y añadir `mnemosine help --all` para quien sí quiera las 179 líneas (brecha 10).

10. **Un `mnemosine start` (o el cierre de `init`) que imprima la cadena de cinco comandos hasta el primer asiento** y la vaya tachando conforme se cumple. Extender `doctor` con tres verificaciones contables además de las de infraestructura: ¿hay ejercicio?, ¿hay periodo abierto?, ¿hay catálogo? Es lo que convierte a `doctor` en «¿ya puedo trabajar?» en vez de «¿ya conecta la base?» (brecha 13).

11. **Reparar `init --status`** para que degrade por sección como `doctor` y `status`, y decidir cuál de los tres es el canónico, dejando los otros dos como alias documentados (brecha 11).

12. **Bajar la línea base del auditor a cero en las ocho violaciones de contrato `list`**, que son las únicas de las 36 que el usuario percibe directamente (brecha 12). El mecanismo de congelación es correcto y no hay que tocarlo: sólo hay que usarlo.
