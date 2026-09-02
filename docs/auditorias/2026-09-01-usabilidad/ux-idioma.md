## LO QUE ESTÁ BIEN (y hay que acreditarlo)

**1. El catálogo de cuentas sembrado está en español mexicano correcto, con acentos y con la terminología fiscal exacta.** No es una traducción: es vocabulario nativo.

```
src/database/seed.ts:75-116
{ code: '1130', name: 'IVA Acreditable', ... }
{ code: '2120', name: 'IVA Trasladado', ... }
{ code: '2130', name: 'ISR por Pagar', ... }
{ code: '2140', name: 'Retenciones por Pagar', ... }
{ code: '3200', name: 'Resultado de Ejercicios Anteriores', ... }
{ code: '1220', name: 'Equipo de Cómputo', ... }
```

Esta es la capa que un contador lee todos los días, y está resuelta. Es también la que vuelve más visible el problema del resto del informe: los datos hablan español y el marco que los envuelve no.

**2. El glosario del wiki ya hizo el trabajo de traducción, y lo hizo bien.** `docs/wiki/Glosario.md` tiene 47 entradas y 13 de ellas citan el comando exacto que corresponde al término:

```
$ grep -c '^\*\*' docs/wiki/Glosario.md          → 47
$ grep '^\*\*' docs/wiki/Glosario.md | grep -c 'mnemosine ' → 13
```

```
docs/wiki/Glosario.md:61
**Póliza** — En el vocabulario mexicano, el documento que contiene uno o varios
asientos: póliza de ingresos, de egresos, de diario. Es el término que usan el
Anexo 24 y la mayoría de los despachos donde un texto en inglés diría *journal entry*.
```

```
docs/wiki/Glosario.md:19
**Auxiliar** — El detalle de una cuenta en un periodo... `mnemosine ledger auxiliary show`.
```

El repositorio ya sabe cuál es la palabra correcta y ya sabe a qué comando corresponde. El mapeo existe como prosa; nunca llegó al `--help`. Eso convierte la brecha en un problema de plomería, no de investigación — y es la razón por la que las recomendaciones de abajo son baratas.

**3. La política de idioma es una decisión escrita y razonada, no un accidente.** Hay dos lugares donde se declara y se justifica:

```
src/cli/README.md:396
- **CLI chrome** — always English (canonical command names, flags, help and
  runtime output). The complete Spanish surface is provided by aliases...
```

```
docs/cli-command-catalog.md:2050
Los sub-recursos usan sustantivos ingleses deliberadamente — `catalog`,
`balance` (balanza), `voucher` (póliza; `voucher` y no `entry` para no
colisionar con los asientos del mayor), `subledger` (auxiliar) — y el término
del SAT vive en el alias español.
```

Y hay una prueba que la sostiene y que pasa hoy:

```
$ npx vitest run tests/cli/bilingual-matrix.spec.ts
 ✓ tests/cli/bilingual-matrix.spec.ts  (21 tests) 12840ms
 Test Files  1 passed (1)
```

Auditar esto no es auditar un descuido. La decisión —nombres canónicos en inglés, alias en español— es la que toman `kubectl`, `gh` y `stripe` cuando internacionalizan: el identificador es estable y ASCII, la lengua vive en la capa de presentación. Es defendible. Lo que sigue no ataca la decisión: mide qué tan lejos está la ejecución de ella.

**4. El RFC es ciudadano de primera clase.** `mnemosine init --rfc <rfc>` existe como bandera, el patrón acepta Ñ y `&` (los dos caracteres legales que rompen las validaciones ingenuas), y el mensaje distingue correctamente persona moral de física:

```
src/services/entity/entity-service.ts:51-53
// 12 for a moral person, 13 for a physical one. Ñ and & are legal.
taxIdPattern: /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/,
```

**5. `--section` acepta las dos lenguas de verdad**, y está documentado por qué (`src/cli/init-command.ts:112-123`): `identity` e `identidad`, `users` y `usuarios`, `policies`, `politicas` y `policy`. Es el único lugar del producto donde una bandera es bilingüe.

**6. `NO_COLOR` se respeta con su razón citada y la tubería queda limpia — comprobado, no supuesto:**

```
src/cli/palette.ts:6
//   - honor NO_COLOR (https://no-color.org);

$ npx tsx src/cli/mnemosine.ts doctor > /tmp/d.txt 2>&1
$ grep -c $'\033' /tmp/d.txt
0
```

**7. `doctor` es el mejor comando del producto.** Cada falla trae su remedio, en el orden en que hay que resolverlas, con código de salida 1:

```
$ npx tsx src/cli/mnemosine.ts doctor

Mnemosine health check

  ✘ Database        no connection: role "postgres" does not exist
      → Check DATABASE_URL in .env and that PostgreSQL is running (docker compose up -d postgres)
  ✘ Model provider  anthropic requires ANTHROPIC_API_KEY and it is not set
      → Set ANTHROPIC_API_KEY in .env, or use --provider ollama
  ⚠ Encryption key  ENCRYPTION_KEY not set (the code default is used)
      → openssl rand -hex 32  → ENCRYPTION_KEY in .env

  There are failures that prevent operation. Resolve them in the order shown.
```

**8. El formateo monetario mexicano existe y está bien hecho donde existe** (`src/services/xml-ingestion/cfdi-decisions.ts:41`): `toLocaleString('es-MX')` con dos decimales y la moneda. La capacidad está en el repositorio; la brecha 6 es que no se aplicó a los reportes.

**9. La compuerta de confirmación falla cerrada.** Cuando la respuesta no se reconoce, `abortedByUser()` lanza y el proceso sale con 10 (`src/cli/kernel/exit.ts:98`, `:41`). Nada se postea por accidente. Eso importa para calibrar la severidad de la brecha 1: el daño es de confianza y de tiempo, no de integridad del mayor.

---

## BRECHAS

### 1. El «sí» se rechaza exactamente en los siete comandos que tocan el mayor

**Evidencia.** Hay cuatro implementaciones distintas de la compuerta sí/no en `src/cli/`, con tres reglas de aceptación distintas. Las comparé ejecutando los predicados literales del código:

```
$ npx tsx /tmp/.../si.ts
respuesta | isAffirmative | entry/invoice/payment | bill approve | close/init
"y"       | true          | true                  | true         | true
"yes"     | true          | true                  | true         | true
"s"       | true          | false                 | false        | true
"si"      | true          | false                 | false        | true
"sí"      | true          | false                 | false        | true
"S"       | true          | false                 | false        | true
"Sí"      | true          | false                 | false        | true
```

Los cuatro predicados, con su origen:

| dónde | archivo:línea | código | acepta `sí` |
|---|---|---|---|
| helper canónico | `src/cli/mnemosine.ts:390` | `t==='y' \|\| t==='yes' \|\| t==='s' \|\| t==='si' \|\| t==='sí'` | sí |
| `close` | `src/cli/close-command.ts:179` | `/^y\|^s/i` | sí |
| `init` | `src/cli/init-command.ts:108` | `/^s\|^y/i` | sí |
| `entry post/reverse/void` | `src/cli/entry-command.ts:261` | `if (answer !== 'y' && answer !== 'yes') throw abortedByUser()` | **no** |
| `invoice issue/void` | `src/cli/invoice-command.ts:228` | idéntico al anterior | **no** |
| `payment create` | `src/cli/payment-command.ts:116` | idéntico al anterior | **no** |
| `bill approve` | `src/cli/bill-command.ts:184` | `/^y(es)?$/i` | **no** |

El helper bilingüe existe (`isAffirmative`, `src/cli/mnemosine.ts:382-391`, con el comentario «Accepts English and Spanish») y ninguna de las cuatro familias de mutación lo llama. La correlación es perfecta y va en la peor dirección: las siete hojas irreversibles del producto —contabilizar, reversar, anular póliza, emitir y anular factura, registrar pago, aprobar factura de proveedor— son justo las que rechazan el sí en español. Las reversibles (`init`, `close`) lo aceptan.

Y el README afirma lo contrario:

```
src/cli/README.md:407
  Yes/no prompts display `[y/N]` and also accept `s`/`si`/`sí`.
```

**Práctica que incumple.** Nielsen #2 («match between system and the real world»: hablar el lenguaje del usuario) y #5 («error prevention»). Las CLI Guidelines (clig.dev, «Prompts») exigen que una confirmación acepte las respuestas que un usuario razonablemente daría. Y sobre todo la regla más vieja de la interacción: *el mismo gesto debe significar lo mismo en todo el producto*. Aquí `s` significa «sí» en `init` y «no» en `entry post`.

**Severidad: ALTA. Esfuerzo: S.** Es reemplazar cuatro predicados por una llamada a `isAffirmative`, que ya existe y ya está exportado.

**Escenario.** El contador captura la póliza de la renta de agosto y corre `mnemosine poliza contabilizar P-2026-0431`. Ve `Post entry P-2026-0431? [y/N]`, teclea `s` y Enter. La terminal responde una palabra —`Aborted.`— y sale con 10. Él leyó su `s` como un sí; la herramienta lo leyó como un no. La póliza sigue en borrador. Si el mensaje fuera «no entendí la respuesta», sabría qué pasó; como es «Aborted», concluye que el sistema la rechazó por alguna razón contable y va a buscar el error en la póliza. En el cierre de mes, `ledger stale-draft list` le devolverá la póliza que él cree posteada.

---

### 2. Los alias en español son ASCII: `póliza` no existe, y el fallo es silencioso con código 0

**Evidencia.** De 168 alias en español en todo el árbol, exactamente **uno** lleva tilde o eñe:

```
alias totales: 168
alias CON acento/eñe: 1  [{"al":"enseña","path":"memory teach"}]
```

`memory teach` es el único caso que trae las dos formas (`enseña` y `ensena`). Los otros doce alias que en español se escriben con tilde no la tienen y no tienen variante acentuada:

```
alias que deberían llevar tilde y no la llevan:
   envio, envios     -> outbox
   auditoria         -> sat cred audit
   tamano-prompt     -> prompt-size
   poliza            -> entry
   periodo           -> period
   terminos          -> vendor terms
   linea             -> bill line
   antiguedad-cobrar -> report aged-receivable
   antiguedad-pagar  -> report aged-payable
   estadisticas      -> ai stats
```

Escribir la palabra correcta falla, y falla de dos maneras distintas, ninguna de ellas útil:

```
$ npx tsx src/cli/mnemosine.ts póliza --help
Usage: mnemosine [options] [command]

AI accounting assistant — converse with your accounting from the terminal
...
$ echo $?
0
```

```
$ npx tsx src/cli/mnemosine.ts período list
error: too many arguments for 'chat'. Expected 0 arguments but got 2: período, list.
```

El primer caso es el grave: `mnemosine póliza --help` imprime la ayuda de la raíz y **sale con 0**. No hay error, no hay advertencia, no hay pista. El token se comió como argumento del comando por defecto (`chat`) y `--help` se resolvió en la raíz. El segundo caso sí falla, pero el mensaje nombra `chat` —un comando que el usuario nunca escribió— y no sugiere `periodo`.

Vale la pena notar que la maquinaria de sugerencias de commander **sí funciona un nivel más abajo**, donde el comando por defecto no la tapa:

```
$ npx tsx src/cli/mnemosine.ts aprobaciones listar
error: unknown command 'listar'
(Did you mean list?)
```

O sea: el problema no es que falten sugerencias, es que el comando por defecto en la raíz se traga cualquier token desconocido antes de que la sugerencia pueda dispararse.

**Práctica que incumple.** POSIX/GNU y clig.dev («Catch errors, suggest the correct command») exigen que un comando desconocido salga con código distinto de cero y proponga el más cercano — es lo que hace `git` desde hace quince años (`git: 'statsu' is not a git command. See 'git --help'. The most similar command is status`). Salir con 0 tras no hacer nada viola además la convención de códigos de salida con significado que el propio repositorio declara y respeta en todos lados (`src/cli/kernel/exit.ts:41-46`). Y para el caso de los acentos, la práctica es la de Unicode UAX#15 aplicada a identificadores de entrada: se normaliza y se despoja de diacríticos *antes* de resolver, no se le pide al usuario que escriba mal su idioma.

**Severidad: ALTA. Esfuerzo: M.** Registrar la variante acentuada como alias adicional en las doce hojas es trivial (S). Arreglar el `exit 0` silencioso requiere quitarle al comando por defecto la facultad de tragarse tokens desconocidos, o interceptar antes de commander — eso es M.

**Escenario.** El contador leyó el README del despacho (que dice «póliza» 297 veces) y escribe `mnemosine póliza --help`. Aparece una pantalla de ayuda. Él asume que es la ayuda de pólizas y busca en ella el subcomando de contabilizar; no está, porque es la ayuda de la raíz. Concluye que el sistema no puede contabilizar pólizas. Los alias en español existían y se los diseñó pensando en él; se los perdió por una tilde.

---

### 3. La superficie en español que el README declara completa no lo está, y su guardián pasa en verde

**Evidencia.** El README afirma cobertura total:

```
src/cli/README.md:397
  The complete Spanish surface is provided by aliases, which always work
  regardless of `lang`: every command has one where the word differs
```

El árbol real dice otra cosa. De 45 familias de primer nivel, 40 tienen alias y 5 no (`chat`, `sat`, `doctor`, `cfdi`, `rep` — las cuatro últimas son la misma palabra en los dos idiomas, así que es correcto; `chat` también). Pero de las hojas, **13 nodos de subcomando no tienen alias en español** y en todos ellos la palabra sí difiere:

```
subcomandos SIN alias en español (13):
  - sat cred          :: Fiscal credentials (e.firma)          → credenciales
  - approvals list    :: List approval policies of the entity  → listar
  - approvals grant   :: Grant a pattern-based approval policy → otorgar
  - approvals revoke  :: Revoke an active approval policy      → revocar
  - jobs list / create / enable / disable / run-due / history  → listar/crear/…
  - skills list / drafts / view                                → listar/borradores/ver
```

Comprobado en vivo:

```
$ npx tsx src/cli/mnemosine.ts aprobaciones listar
error: unknown command 'listar'
(Did you mean list?)

$ npx tsx src/cli/mnemosine.ts tareas listar
error: unknown command 'listar'

$ npx tsx src/cli/mnemosine.ts habilidades listar
error: unknown command 'listar'
```

Es decir: la familia tiene alias (`aprobaciones`, `tareas`, `habilidades`) pero sus hijos no. El usuario llega hasta la puerta en español y ahí tiene que cambiar de idioma a media ruta.

**El mecanismo por el que esto pasó desapercibido es la parte importante.** `tests/cli/bilingual-matrix.spec.ts` verifica la cobertura contra un mapa escrito a mano:

```
tests/cli/bilingual-matrix.spec.ts:81
const SUBCOMMANDS: Record<string, Record<string, string>> = {
  memory: {...}, pending: {...}, entity: {...}, account: {...}, entry: {...},
  period: {...}, year: {...}, vendor: {...}, bill: {...}, customer: {...},
  invoice: {...}, report: {...}, outbox: {...}, question: {...},
};
```

Son 14 familias enumeradas de 45. `approvals`, `jobs`, `skills`, `webhooks`, `ledger`, `cfdi`, `rep`, `ai`, `payment`, `receipt` no están. El comentario del propio test lo dice sin darse cuenta de la consecuencia: «*so a new family only has to appear in SUBCOMMANDS to be held to the bilingual policy*» (línea 185). Es una lista de inclusión: lo que no se agrega, no se revisa. La prueba pasa con 21 casos en verde mientras 13 hojas incumplen la política que dice pinar.

El mismo agujero explica la única inconsistencia de idioma en las descripciones. De 179 nodos de comando, 177 se describen en inglés y 2 en español:

```
descripciones con marca de español: 2
 * ai       :: Métricas y calibración del agente contable
 * ai stats :: Aprobación por bucket de confianza, delta confianza-vs-realidad, costo y eventos
```

La prueba tiene un detector de restos en español (`SPANISH_LEFTOVERS`, línea 108) pero solo lo aplica a cuatro pantallas: `topHelp`, `memoryHelp`, `pendingHelp`, `satCredHelp` (línea 205). La descripción de `ai` **sí** aparece en `topHelp`, pero los diez regex son frases literales del audit anterior (`/Solo muestra/`, `/No interactivo/`, `/túnel/`…) y ninguno casa con «Métricas y calibración». El guardián busca los restos que ya conocía, no la clase de problema.

**Práctica que incumple.** La regla básica de un guard test: la enumeración debe derivarse del árbol real, no de una lista mantenida a mano en paralelo — si no, la prueba mide la lista, no el sistema. Y la de documentación: `src/cli/README.md:397` afirma un invariante que el sistema no cumple, lo cual es peor que no afirmarlo (Nielsen #1, «visibility of system status», aplicado a la documentación).

**Severidad: ALTA. Esfuerzo: S.** Los 13 alias son una línea cada uno. Cambiar el test para que camine el programa exportado (`export { program }` ya existe en `src/cli/mnemosine.ts:2151`, y `scripts/generate-cli-reference.ts` ya lo hace) y falle ante cualquier hoja sin alias, es media hora.

**Escenario.** El despacho automatiza el ciclo nocturno y escribe un script en español, como el resto de sus scripts: `mnemosine tareas listar`. Falla. El sysadmin lo reporta como bug; alguien revisa el README, lee que la superficie en español está completa, corre la prueba bilingüe, la ve en verde, y cierra el ticket como «no reproducible».

---

### 4. `factura emitir` usa el verbo exacto que en México significa timbrar, y no timbra

**Evidencia.**

```
$ npx tsx src/cli/mnemosine.ts invoice issue --help
Usage: mnemosine invoice issue|emitir [options] <ref>

Issue an invoice: post DR receivable / CR revenue / CR VAT. Does not stamp or
send
```

```
$ npx tsx src/cli/mnemosine.ts invoice --help
Usage: mnemosine invoice|factura [options] [command]

Customer invoices: draft, inspect, issue to the ledger and void (never stamped
here)
```

El comando en español completo es `mnemosine factura emitir F-001`. En México, «emitir una factura» es exactamente el acto de timbrar el CFDI ante el PAC: es el verbo del SAT, el de los PAC, el de CONTPAQi y el de Aspel. El inglés `issue` es lo bastante ambiguo para sobrevivir («issue to the ledger» se entiende); el español `emitir` no lo es. El alias eligió la única palabra española que promete precisamente lo que el comando se niega a hacer.

Y la salvaguarda —las dos aclaraciones que evitan el malentendido, «Does not stamp or send» y «never stamped here»— está en inglés, es decir, en el idioma que el usuario que eligió el alias español probablemente no lee. La advertencia está escrita para quien no la necesita.

El propio catálogo de diseño registra que la palabra era un problema conocido y resuelto en otra parte del árbol:

```
docs/cli-command-catalog.md:2050
`voucher` (póliza; `voucher` y no `entry` para no colisionar con los asientos del mayor)
```

Se cuidó la colisión en inglés. No se hizo el mismo ejercicio con el alias español.

**Práctica que incumple.** Nielsen #2 (correspondencia con el mundo real) y la regla de nomenclatura de clig.dev: el nombre debe describir lo que el comando hace, no lo que suena parecido. Es también la razón por la que QuickBooks y Xero distinguen «Save» de «Send» y NetSuite separa «Approve» de «Transmit»: cuando un verbo tiene un significado regulatorio, no se reusa para la operación interna.

**Severidad: ALTA. Esfuerzo: S.** Cambiar el alias a `contabilizar` o `registrar` (y dejar `emitir` reservado para cuando exista el timbrado, o hacer que `emitir` falle con un mensaje que explique la diferencia) es una línea. Traducir las dos aclaraciones es otra.

**Escenario.** El contador captura la factura del mes, corre `mnemosine factura emitir F-2026-0088`, ve que el comando termina bien y le dice al cliente que ya se le facturó. El CFDI nunca se timbró: el cliente no puede deducir, y en la conciliación del mes siguiente aparece un ingreso en el mayor sin comprobante en el espejo del SAT. La única línea que lo hubiera prevenido decía «Does not stamp or send».

---

### 5. La balanza sale con encabezados en inglés sobre nombres de cuenta en español

**Evidencia.** Los encabezados de tabla son las claves crudas del objeto que arma cada comando, y son las mismas cadenas que sirven de contrato para `--json` y `--csv`:

```
src/cli/kernel/output.ts:125
const header = cols.map((c, i) => padded(c, widths[i], false)).join('  ').trimEnd();
```

```
src/cli/report-command.ts:260-267
const rows: Row[] = tb.rows.map((r) => ({
  account_code: r.account_code,
  account_name: r.account_name,
  account_type: r.account_type,
  debit_total: money(r.debit_total),
  credit_total: money(r.credit_total),
  ending_balance: money(r.ending_balance),
}));

header(ctx, 'Trial balance', scope);
```

Reproducido con el renderizador real y datos con la forma del catálogo sembrado:

```
$ npx tsx /tmp/.../tabla.ts
account_code  account_name            ending_balance
────────────  ──────────────────────  ──────────────
        1220  Equipo de Cómputo             1000.00
        1230  Equipo de Transporte           2000.00
        1290  Depreciacion Acumulada         -500.00
```

El informe se titula `Trial balance`, sus columnas se llaman `account_code`, `debit_total`, `credit_total`, `ending_balance`, la columna `account_type` trae valores del enum en inglés (`asset`, `liability`, `revenue`), el pie dice `Debits … Credits … (N accounts)` — y los nombres de cuenta debajo dicen «IVA Acreditable» y «Equipo de Cómputo». Es el informe que un despacho imprime y entrega.

El obstáculo real es de arquitectura, no de traducción: como los encabezados **son** las claves de `--json`, traducirlos rompería a cualquier consumidor de máquina. El renderizador no tiene hoy separación entre etiqueta y clave.

**Práctica que incumple.** La separación etiqueta/clave es la primera regla de cualquier esquema de i18n (gettext, ICU, y la práctica de `kubectl`, que traduce columnas y mantiene los campos de `-o json`). Y en el terreno contable: la balanza de comprobación es un entregable con formato esperado; CONTPAQi y Aspel presentan «Cuenta / Nombre / Cargos / Abonos / Saldo». Un contador no puede firmar un papel cuyas columnas no reconoce.

**Severidad: ALTA. Esfuerzo: M.** Requiere que `render()` acepte un mapa de etiquetas por columna, separado de las claves. Es una firma nueva en `src/cli/kernel/output.ts` y un mapa por comando de reporte — seis reportes.

**Escenario.** El cliente pide la balanza de julio. El contador corre `mnemosine reporte balanza ver --period 2026-07 --format csv -o balanza-julio.csv`, la abre en Excel y ve `account_code, account_name, account_type, debit_total, credit_total, ending_balance` con `asset` y `liability` en la tercera columna. Antes de mandarla renombra las seis columnas a mano y traduce los tipos. Lo hace todos los meses, para cada cliente.

---

### 6. La decisión de interfaz en inglés ya se filtró a los datos: los periodos se acuñan «January 2026» en la base

**Evidencia.** `mnemosine ejercicio crear` graba el nombre del periodo, y lo graba en inglés a propósito:

```
src/services/accounting/fiscal-calendar-service.ts:504-507
          // Period names are stored, not translated at render time; the CLI UI
          // is English, so they are minted in English.
          start.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) + ` ${yearNumber}`,
```

Lo mismo en el sembrado:

```
src/database/seed.ts:54
const months = ['January', 'February', 'March', ..., 'December'];
src/database/seed.ts:68
[periodId, FISCAL_YEAR_ID, ENTITY_ID, i + 1, `${months[i]} 2026`, startDate, endDate, status]
```

Y `es-MX` se usa en un solo lugar de todo el repositorio (`src/services/xml-ingestion/cfdi-decisions.ts:42`), o sea que la capacidad de formatear en español mexicano existe y no llegó aquí.

Esto es distinto en clase de todo lo demás del informe. El resto es cromo: se puede cambiar y el efecto es inmediato. Esto es **dato persistido**. `period_name` sale en `period list`, en `period show`, en el alcance de cada reporte, en la lista de cierre. Si mañana se decide poner la interfaz en español, los periodos ya creados siguen diciendo «January 2026» para siempre, porque no hay traducción en tiempo de render — el comentario lo dice explícitamente. La deuda crece con cada ejercicio abierto y con cada cliente dado de alta.

**Práctica que incumple.** La regla de i18n más básica: no se persiste texto localizado; se persiste un dato neutro (aquí ya existe: `period_number` 1..12 más `start_date`) y se formatea al mostrar. Es exactamente lo que impide que SAP o NetSuite tengan que migrar datos cuando un cliente cambia de idioma.

**Severidad: ALTA. Esfuerzo: M.** El cambio en sí es chico (formatear al render desde `period_number`, o al menos mintear con `es-MX` cuando el país de la entidad es MX). Lo que lo vuelve M es que hay que decidir qué hacer con los periodos ya escritos, y cuanto más se tarde más caro sale.

**Escenario.** El despacho da de alta doce clientes durante 2026. En 2027 se traduce la interfaz. Los doce ejercicios de 2026 conservan «January 2026»…«December 2026»; los de 2027 dicen «enero 2027». El auxiliar de una cuenta que cruza el cierre anual lista los dos idiomas en la misma columna, y ninguna consulta por nombre de periodo funciona igual en los dos años.

---

### 7. Los errores no están en un idioma ni en el otro: el mismo comando da la ayuda en inglés y el error en español

**Evidencia.** De 314 constructores de error dirigidos al usuario en `src/`, 7 producen texto en español:

```
$ grep -rn "usageError(\|notFound(\|new CliError(\|new ValidationError(\|new NotFoundError(\|new BusinessRuleError(" src/ | wc -l
314
$ ... | grep -c "[áéíóúñ¿¡]"
7
```

```
src/cli/account-command.ts:568  El archivo ${file} no trae pares código,valor legibles.
src/cli/account-command.ts:619  Verificación desconocida: ${...}. Disponibles: ${...}.
src/cli/account-command.ts:675  Clave desconocida "${clave}". Válidas: ${...}.
src/cli/cfdi-command.ts:162     CFDI ${uuid} no está en el espejo de esta entidad.
src/cli/ledger-command.ts:210   --dim aún no está disponible: las dimensiones no tienen maestro todavía.
src/services/accounting/account-service.ts:338       Moneda ilegible "${...}": tres letras (MXN, USD) o vacía para limpiar.
src/services/accounting/entry-import-service.ts:137  El archivo no trae una sola póliza legible: nada que preparar.
```

Y en `src/cli/`, de 403 llamadas de impresión (`console.log` / `stdout.write` / `console.error`), **cero** llevan texto en español. O sea: la salida normal es inglés puro; los errores son 97.8% inglés y 2.2% español.

El resultado es que un mismo comando responde en dos idiomas según por dónde falle:

```
$ npx tsx src/cli/mnemosine.ts account map check --help
Usage: mnemosine account map check|verificar [options]

Coverage gate before the Anexo 24 catalog XML: which top accounts still lack a
mapping

Options:
  -e, --entity <idOrName>   legal entity to operate on (defaults to the active one)
  --strict                  treat warnings as blocking (exit 4)
  ...

$ npx tsx src/cli/mnemosine.ts account map check --check foo
Verificación desconocida: foo. Disponibles: coverage.
$ echo $?
2
```

La misma línea de comando, una pantalla en inglés y la siguiente en español. Y el patrón dice hacia dónde va la deriva: los siete casos en español están en el código más nuevo (`account map`, `ledger check`, `cfdi`, `entry import`). La política de `src/cli/README.md:396` no se está aplicando en lo que se escribe hoy, y no hay nada que la haga cumplir: la prueba bilingüe solo mira cuatro pantallas de ayuda (brecha 3), nunca los errores.

Dos descripciones de opción tienen el mismo problema **dentro de una sola cadena**:

```
entry import  --layout <name> :: file layout: csv, ndjson (contpaqi/aspel/iif/sat-polizas: aún sin parser)
cfdi status show  --refresh   :: consulta al SAT ahora y actualiza la caché sat_* del documento
```

De 1083 descripciones de opción en todo el árbol, esas dos son las únicas con texto español, y la primera mezcla los dos idiomas en la misma línea.

**Práctica que incumple.** Consistencia (Nielsen #4). Y la regla operativa de clig.dev sobre mensajes de error: son parte de la interfaz, no un subproducto — se diseñan y se revisan como el resto. Un producto con dos idiomas mezclados sin regla es más difícil de usar que uno consistentemente en el idioma equivocado, porque el usuario no puede desarrollar una expectativa.

**Severidad: MEDIA. Esfuerzo: M.** Decidir la regla y aplicarla a 314 sitios es M; poner una prueba que la haga cumplir (grep sobre los constructores de error) es S y evita que siga creciendo.

**Escenario.** El contador aprende que cuando la herramienta le habla en español es porque el error es «suyo» (dato mal capturado) y cuando le habla en inglés es «del sistema». Es una heurística falsa, pero es la única señal que la interfaz le da. La aplica hasta que un error en inglés resulta ser un dato mal capturado y pierde una tarde.

---

### 8. El único camino de recuperación que existe —y es bueno— no está cableado al camino de error

**Evidencia.** `repairCommandFor` mapea cada categoría de falla al comando exacto que la repara:

```
src/cli/mnemosine.ts:398-408
export function repairCommandFor(reason: string): string {
  const r = reason.toLowerCase();
  if (/databas|\bdb\b|connect|tunnel|postgres|migrat|ssl/.test(r)) {
    return 'mnemosine doctor   (and check DATABASE_URL in .env)';
  }
  if (/entit|identity|rfc|tenant/.test(r)) return 'mnemosine init --section identity';
  if (/provider|api.?key|model|credential|anthropic|ollama|hermes/.test(r)) {
    return 'mnemosine init --section ai';
  }
  return 'mnemosine doctor';
}
```

Está probado (`tests/cli/entry-flow.spec.ts:51-73`, siete aserciones) y tiene exactamente dos llamadores, ambos en el banner de primer arranque:

```
$ grep -rn "repairCommandFor" src/
src/cli/mnemosine.ts:398:export function repairCommandFor(...)
src/cli/mnemosine.ts:463:    stderr.write(`      → ${repairCommandFor('')}\n`);
src/cli/mnemosine.ts:467:    stderr.write(`      → ${repairCommandFor(reason)}\n`);
```

El manejador de errores real no lo usa. Y su forma revela la prioridad:

```
src/cli/mnemosine.ts:241-256
function reportError(err: unknown): void {
  if (err instanceof Anthropic.AuthenticationError) { ... remedio ... }
  else if (err instanceof OpenAI.AuthenticationError) { ... remedio ... }
  else if (err instanceof OpenAI.APIConnectionError) { ... remedio ... }
  else if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) { ... }
  else {
    console.error(ce.red(`\n${err instanceof Error ? err.message : String(err)}`));
  }
}
```

Hay cuatro ramas con diagnóstico y remedio para los errores del proveedor de IA, y ninguna para la base de datos. Los errores de Postgres caen en el `else` y se vuelcan crudos. Reproducido:

```
$ npx tsx src/cli/mnemosine.ts entity list

role "mnemo" does not exist
$ echo $?
1
```

```
$ npx tsx src/cli/mnemosine.ts account list
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "mnemo" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "mnemo" does not exist
```

```
$ npx tsx src/cli/mnemosine.ts init --status

Configuration status

  ○ pending  Infrastructure (database, migrations, encryption)

role "postgres" does not exist
$ echo $?
1
```

Ese último es la primera pantalla que ve un usuario nuevo. `init --status` es el punto de entrada del asistente guiado, y termina con una línea cruda de libpq y ninguna indicación de qué hacer.

**La parte de idioma.** `role "mnemo" does not exist` viene de PostgreSQL y no es traducible desde aquí: para que libpq hable español haría falta configurar `lc_messages` en el servidor y tener el catálogo de traducciones instalado — un servidor gestionado (RDS, Neon, Supabase) normalmente no lo permite. La única forma de que un error de base de datos le hable en español al contador es **envolverlo**, y el envoltorio ya existe (`repairCommandFor`, `doctor`) y no está conectado. Es decir: la brecha de idioma y la brecha de accionabilidad son la misma brecha y tienen el mismo arreglo.

Y cuando el envoltorio sí actúa —el caso de `account list`— desdiagnostica: presenta una caída de conexión como un problema de selección de entidad y recomienda `mnemosine entity use`, que no arregla nada. El texto correcto (`mnemosine doctor`) está a una llamada de función.

Hay que decir también lo que sí funciona: `doctor` es un comando excelente (ver crédito 7). El problema es que ningún error remite a él, salvo tres menciones sueltas en prosa (`src/services/accounting/ar-ap-posting.ts:73`, `src/cli/init/s1-identity.ts:186`, `src/cli/init-command.ts:282`). Y sus remedios —`docker compose up -d postgres`, `openssl rand -hex 32`— exigen inglés técnico y alfabetización de terminal, que es justo lo que el perfil del usuario declara que no se puede dar por hecho.

**Práctica que incumple.** Nielsen #9 («help users recognize, diagnose and recover from errors»: lenguaje llano, diagnóstico preciso, solución concreta). clig.dev: «*If there's an unexpected error, catch it and rewrite the message to be helpful… Suggest what the user might do to fix it.*» Y la práctica de `stripe`, `gh` y `docker`, donde cada error de conectividad nombra el comando de diagnóstico.

**Severidad: ALTA. Esfuerzo: S.** Agregar una rama a `reportError` que reconozca los errores de `pg` y emita el texto de `repairCommandFor`; y corregir el envoltorio de `entity-context` para que priorice la falla de conexión sobre la de selección. La función ya existe, ya está probada, y los patrones que necesita ya están escritos en su regex.

**Escenario.** El contador enciende la laptop el lunes; Docker no arrancó. Escribe `mnemosine cuenta listar` y lee `role "postgres" does not exist`. No sabe qué es un role, ni por qué existe algo llamado postgres, ni que hay un comando que se lo diría. En el segundo intento el sistema le sugiere `mnemosine entity use`, lo corre, falla igual, y ahora además duda de si perdió la configuración de su cliente. Llama al despacho. `doctor` le hubiera resuelto la mañana en una línea.

---

### 9. El acento rompe la alineación de las columnas, y el repositorio no normaliza Unicode en ningún lado

**Evidencia.** El ancho de columna se calcula con `String.length`, que cuenta unidades UTF-16, no caracteres percibidos:

```
src/cli/kernel/output.ts:116-118
const widths = cols.map((c) =>
  Math.max(c.length, ...rows.map((r) => cell(r[c]).length), 0)
);
```

Con texto en NFC (como el que trae `seed.ts`) funciona. Con texto en NFD —lo que produce el sistema de archivos de macOS, y lo que sale de muchos CSV exportados desde Excel o desde CONTPAQi en Mac— cada acento suma una unidad y desalinea la fila:

```
$ npx tsx /tmp/.../tabla.ts
largo NFC = 17  largo NFD = 18
account_code  account_name            ending_balance
────────────  ──────────────────────  ──────────────
        1220  Equipo de Cómputo             1000.00
        1230  Equipo de Transporte           2000.00
        1290  Depreciacion Acumulada         -500.00
```

El desfase escala con el número de acentos:

```
$ npx tsx /tmp/.../tabla2.ts
cuenta  nombre                               saldo
──────  ───────────────────────────────────  ────────
  1220  Depreciación de Equipo de Cómputo   1000.00
  2120  IVA Trasladado no Cobrado            22000.00
  1130  IVA Acreditable Pagado                 333.00
```

Dos acentos, dos columnas de desfase: el `1000.00` deja de apilarse con los otros importes. El comentario del renderizador dice que los números se alinean a la derecha «*so digits stack*» (`output.ts:120`); con datos en español dejan de apilarse.

Y no hay defensa en ningún lado:

```
$ grep -rn "normalize(" src/ | grep -v node_modules
(sin resultados)
```

Cero llamadas a `String.prototype.normalize` en todo `src/`. Eso tiene una segunda consecuencia que no pude ejercitar sin base de datos y por eso declaro como **no verificada**: como PostgreSQL compara bytes, «Cómputo» en NFC y en NFD son cadenas distintas, así que una búsqueda por texto (`account list <search>`, `entity use <name>`) puede no encontrar la cuenta, y un `account create` puede crear una duplicada. La alineación sí está reproducida; la duplicación es la inferencia.

Lo notable es que este defecto solo se manifiesta con datos en español. Con nombres de cuenta en inglés el renderizador es correcto. Es un error de localización en el sentido estricto: el código es correcto para el idioma en que fue escrito y falso para el idioma de los datos que guarda.

**Práctica que incumple.** Unicode UAX #15: normalizar en la frontera de entrada (NFC es la recomendación del W3C para texto en la web y en almacenamiento). Y la regla de renderizado de tablas en terminal: el ancho se mide en columnas de display, no en unidades de código — lo que resuelven `wcwidth` / `string-width`, que también arregla de paso los caracteres anchos.

**Severidad: MEDIA. Esfuerzo: S.** Normalizar a NFC en la entrada (importación de CSV, argumentos de comando, escritura de nombres) y medir el ancho con `string-width` en `output.ts`. Es una dependencia y dos funciones.

**Escenario.** El contador importa el catálogo del cliente desde un CSV que le exportaron de CONTPAQi en una Mac. Corre la balanza y ve que en unas filas los importes están corridos. Piensa que su terminal está mal configurada, o que el reporte está mal. Lo exporta a CSV para revisar en Excel: ahí los números están bien, porque el CSV no pasa por el alineador. Concluye que el reporte en pantalla no es de fiar y deja de usarlo.

---

### 10. Tres cosas distintas se llaman «cliente» en el mismo producto

**Evidencia.** El producto es multi-inquilino para despachos, y la palabra más cargada del despacho está ocupada tres veces:

| lo que es | cómo se llama | dónde |
|---|---|---|
| la empresa a la que el despacho le lleva los libros | `entity` / `entidad` | `mnemosine entidad crear` |
| … pero el `--help` del comando que la da de alta la llama *client* | `onboard` / `alta` | ver abajo |
| el cliente de esa empresa (cartera de CxC) | `customer` / `cliente` | `mnemosine cliente listar` |
| el despacho mismo, frente al sistema | `tenant` (glosado como «El cliente del sistema») | `docs/wiki/Glosario.md:93` |

```
$ npx tsx src/cli/mnemosine.ts onboard --help
Usage: mnemosine onboard|alta [options]

Imports a client's accounting from an external system (chart of accounts +
opening balances)
```

```
docs/wiki/Glosario.md:93
**Inquilino (*tenant*)** — El cliente del sistema: un despacho, un grupo, una empresa.
```

```
docs/wiki/Home.md:5
**Para quién es.** Para un despacho contable mexicano que lleva varios clientes
en la misma instalación...
```

O sea: la documentación llama «clientes» a lo que el CLI llama `entity`, el `--help` de `onboard` también los llama *client*, y `mnemosine cliente` es otra cosa completamente. `mnemosine alta` da de alta un «client» que **no** es un `cliente`.

No es un problema de traducción: es un problema de modelo de dominio que la traducción destapa. En inglés `entity` / `customer` / `tenant` se distinguen sin esfuerzo; en español las tres colapsan sobre «cliente» salvo que se elija deliberadamente otra cosa. Nunca se eligió.

Hay una segunda colisión del mismo tipo: `receipt|cobro` es el cobro en efectivo, mientras `rep` es el Recibo Electrónico de Pago (complemento de pago). Un contador mexicano que lee «receipt» piensa REP.

**Práctica que incumple.** Vocabulario cerrado y sin homónimos — que es una regla que este repositorio ya adoptó para los verbos (`src/cli/kernel/vocabulary.ts`, con `list` significando siempre lo mismo) y no aplicó a los sustantivos. Y Nielsen #2.

**Severidad: MEDIA. Esfuerzo: M.** Los nombres canónicos no se tocan. Lo que hay que hacer es (a) corregir el `--help` de `onboard` para que no diga *client*, y (b) fijar el término español de `entity` en la documentación y en el `--help` — «entidad» ya es correcto y solo hace falta dejar de decirle «cliente» en el resto de la prosa.

**Escenario.** El contador quiere ver la cartera del cliente Aceros del Norte. Escribe `mnemosine cliente listar` esperando ver a sus clientes del despacho, y obtiene la lista de clientes de la entidad activa —los clientes de su cliente— con saldos que no reconoce. Peor si acaba de dar de alta a alguien con `mnemosine alta`, cuyo `--help` le dijo que estaba importando la contabilidad de *a client*.

---

### 11. `mayor` apunta a dos cosas y `balanza` no se alcanza desde la raíz

**Evidencia.** Del volcado del árbol completo, los alias que se repiten en ramas distintas:

```
alias repetidos en distintas ramas:
   mayor  => report general-ledger | ledger
   saldo  => account balance | ledger balance
   estado => sat cred status | status
   verificar => account map check | entry check | ledger check
```

`mayor` está en dos niveles distintos, y las dos cosas son plausibles para la misma frase:

```
$ npx tsx src/cli/mnemosine.ts mayor
Usage: mnemosine ledger|mayor [options] [command]

The general ledger itself: integrity checks, stale drafts, auxiliaries and
balances

Commands:
  check|verificar [options]   Named ledger checks; ...
  stale-draft|borrador-viejo  Draft journal entries that have sat unposted too
```

```
$ npx tsx src/cli/mnemosine.ts report mayor
Usage: mnemosine report general-ledger|mayor [options] [command]

General ledger detail

Commands:
  show|ver [options]  Posted movements line by line, filterable by account and date
```

El contador que dice «sácame el mayor» quiere el segundo y aterriza en el primero, que es una familia de verificaciones de integridad.

Y la balanza —el informe que más se corre en un despacho— no existe en la raíz:

```
$ npx tsx src/cli/mnemosine.ts balanza
error: too many arguments for 'chat'. Expected 0 arguments but got 1: balanza.
```

La ruta real es `mnemosine reporte balanza ver`: tres niveles y un `ver` final que no aporta información. Hay además un par de alias a una letra de distancia que apuntan a informes distintos: `report balanza` = balanza de comprobación, `report balance` = estado de situación financiera.

**Práctica que incumple.** clig.dev: las tareas frecuentes deben ser cortas y descubribles; y no debe haber dos rutas al mismo nombre con significados distintos. Es la razón por la que `docker ps` sobrevive junto a `docker container ls`, y por la que `git status` no está bajo `git repo status`.

**Severidad: MEDIA. Esfuerzo: S.** Un atajo de raíz `mnemosine balanza` → `report trial-balance show`, y renombrar uno de los dos `mayor` (por ejemplo `ledger` → `libros`, que es lo que un contador dice cuando habla del conjunto).

**Escenario.** El contador quiere la balanza de julio. Prueba `mnemosine balanza`: error que menciona `chat`. Prueba `mnemosine mayor`: aparece una pantalla de verificaciones de integridad que no entiende. En el tercer intento abre el `--help` de la raíz, encuentra `report|reporte`, y desde ahí tiene que descubrir dos niveles más. Tres intentos fallidos para el informe que corre todos los días.

---

### 12. Aliases que traducen la palabra en inglés en vez de nombrar la cosa en español

**Evidencia.** Cuatro casos donde el alias es una traducción literal que no es el término del oficio, más uno donde se coló un alias en inglés dentro de la ranura del español:

```
ganchos      | webhooks   :: Inbound webhook tokens...
sembrar      | account role seed :: Create the missing base accounts and map every unmapped role
reversar     | entry reverse     :: Create the linked posted mirror of an entry (NIF B-1...)
mapeo        | account map       :: Statutory mappings per account: SAT agrupador (Anexo 24)...
archivar,deactivate,desactivar | account archive :: Retire an account from active use
```

- **`ganchos`** es la traducción de diccionario de *hooks* y no significa nada en este contexto para nadie, ni contador ni técnico. En México se dice «webhook». La palabra correcta era no traducir.
- **`sembrar`** traduce *seed*. Un contador que ve `mnemosine cuenta rol sembrar` no puede inferir que crea las cuentas base faltantes. El verbo del oficio es «generar» o «crear».
- **`reversar`** es un americanismo que la RAE registra pero que no es el verbo mexicano; el estándar en español general es «revertir», y en el contexto contable mexicano la póliza que hace esto se llama «póliza de reversión». Lo notable es que la descripción cita correctamente **NIF B-1**, o sea que el marco normativo mexicano sí se consultó para el contenido y no para el nombre.
- **`mapeo`** es un anglicismo técnico; el término del SAT que la propia descripción usa dos palabras después es «agrupador» (Anexo 24). El alias podría ser `agrupador`, que es la palabra que el contador ya conoce.
- **`deactivate`** es una palabra en inglés viviendo en la lista de alias de `account archive`, junto a `archivar` y `desactivar`. Es un alias de compatibilidad hacia atrás (el nombre canónico anterior), pero al no estar marcado como tal contamina la ranura que el resto del árbol reserva para el español.

Contraste con lo que sí está bien elegido y hay que decirlo: `contabilizar` para *post*, `auxiliar` para *auxiliary*, `balanza` para *trial-balance*, `resultados` para *income-statement*, `ejercicio` para *fiscal year*, `alta` para *onboard*, `cierre` para *close*, `factura-proveedor` para *bill*. Ocho de ocho correctos en el vocabulario contable central. El problema está concentrado en la periferia técnica.

**Práctica que incumple.** La regla de localización de producto: se localiza el concepto, no la cadena. Un alias que traduce palabra por palabra produce texto gramaticalmente español y semánticamente vacío.

**Severidad: BAJA. Esfuerzo: S.** Son cinco líneas. La única precaución es agregar el nombre nuevo y dejar el viejo como alias, para no romper scripts.

**Escenario.** El contador corre `mnemosine cuenta rol --help`, ve `seed|sembrar`, no entiende qué siembra, y no lo corre. Las cuentas base que necesita para que el asiento automático funcione nunca se crean, y descubre el faltante cuando `entry post` falla con un rol sin cuenta.

---

### 13. Los cero ejemplos, y que los cinco que existen estén en el idioma equivocado

**Evidencia.** `addHelpText` de commander —el mecanismo para poner ejemplos en la ayuda— no se usa una sola vez:

```
$ grep -rn "addHelpText" src/ | wc -l
0
```

Sobre 179 nodos de comando y 134 hojas. El corpus completo de ejemplos del producto son cinco líneas dentro del chat, y `/ayuda` —el alias en español— las imprime en inglés:

```
src/cli/mnemosine.ts:909-917
if (line === '/help' || line === '/ayuda') {
  console.log(c.dim('Ask about your accounting in natural language. Examples:'));
  console.log(c.dim('  How is the trial balance doing?'));
  console.log(c.dim('  Which customers owe me and since when?'));
  console.log(c.dim('  record the August rent: 10,000 from banks'));
  console.log(c.dim('  /provider hermes   ← switch models mid-session'));
  console.log(c.dim('  /pending [-v]      ← policy decisions awaiting definition'));
```

Mientras tanto, el idioma por defecto del agente es español:

```
$ npx tsx src/cli/mnemosine.ts lang
Agent response language: es
Change it with: mnemosine lang en|es (or MNEMOSINE_LANG env var)
```

```
src/ai/providers/config.ts:590
  return config.language ?? 'es';
```

O sea: el usuario teclea `/ayuda`, el sistema le enseña en inglés cómo preguntar, y el agente le contesta en español. Si copia el ejemplo tal cual, funciona —el modelo entiende inglés— pero nunca aprende cómo se le pregunta en su idioma, que es la única cosa que `/ayuda` existía para enseñarle.

La ironía menor: la salida de `mnemosine lang` («Agent response language: es») también está en inglés.

**Práctica que incumple.** clig.dev es explícito: «*Provide examples… Users almost always look at examples first.*» Es lo que hacen `gh` (`gh pr create --help` trae cuatro), `docker`, `aws` y `stripe`. Y es doblemente crítico aquí porque el producto tiene 134 comandos con banderas compuestas (`--period 2026-Q3`, `--date-basis posting`, `--fields`) cuya sintaxis no se adivina.

**Severidad: MEDIA. Esfuerzo: S por comando.** Dos o tres ejemplos con `addHelpText('after', ...)` en las veinte hojas más usadas cubre el 90% del uso real. Y traducir las cinco líneas de `/ayuda` cuando `resolveLanguage() === 'es'` son cinco líneas.

**Escenario.** El contador entra al chat, teclea `/ayuda` porque no sabe qué preguntar, y recibe cinco frases en inglés. Cierra el chat y vuelve a la hoja de cálculo. El producto entero está construido alrededor de que él converse con sus libros, y el único onboarding a esa conversación está en un idioma que puede no leer.

---

### 14. El corpus del agente está partido en dos idiomas sin puente, y el agente contesta en español

**Evidencia.** Los 27 documentos que forman el conocimiento del agente se dividen limpiamente por idioma y por tema:

```
docs ES: 13 (52,511 palabras)  docs EN: 14 (23,019 palabras)
```

- **Español (13, normativos):** `nif-marco.md`, `nif-registro.md`, `nif-validaciones.md`, y los diez `niif-*.md`.
- **Inglés (14, operativos):** `accounting.md` («Accounting engine: journal entries and periods»), `payables.md`, `receivables.md`, `reports.md`, `banking.md`, `payroll.md`, `mexico-cfdi.md`, `playbooks.md`, `cli-reference.md`, `system.md`, `mnemosine.md`, `connectivity.md`, `identity-access.md`, `external-integrations.md`.

Dentro del mismo corpus:

```
$ grep -rio "journal entr" src/ai/docs/*.md | wc -l   → 36
$ grep -rio "póliza"       src/ai/docs/*.md | wc -l   → 10
```

Y encima, el agente tiene instrucción de contestar en español:

```
src/ai/system-prompt.ts:144-147
const LANGUAGE_LINE = {
  es: 'Always respond in Spanish',
  en: 'Always respond in English',
} as const;
```

Esa constante es, literalmente, **lo único que cambia cuando se corre `mnemosine lang`**. Rastreando `resolveLanguage()` en todo `src/`: `mnemosine.ts:1347` y `status-command.ts:252` la usan para *mostrar* el valor; `mnemosine.ts:729` la pasa al banner como etiqueta; el único consumidor de comportamiento es `system-prompt.ts:158`. Una cadena de todo el producto.

Así que el agente lee «journal entry» en su documentación operativa, «póliza» en la normativa, no tiene ningún glosario que las una en su contexto —el glosario existe pero vive en `docs/wiki/`, fuera de `src/ai/docs/`— y tiene que traducir sobre la marcha para responder. Esto no es cosmético: la desambiguación ES↔EN en contabilidad mexicana no es uno a uno (*ledger* es «mayor» pero también «auxiliar» según el contexto; *entry* es «asiento» pero el documento que lo contiene es «póliza»; *balance* es «saldo», «balance» y «balanza» según dónde caiga), y el corpus no le da al modelo ninguna guía sobre cuál elegir.

**Práctica que incumple.** La regla de construcción de contexto para agentes: un solo vocabulario, o un mapeo explícito. Si el corpus mezcla dos lenguas para el mismo concepto sin declarar la equivalencia, se está delegando en el modelo una decisión terminológica que tiene consecuencias fiscales.

**Severidad: MEDIA. Esfuerzo: M.** Lo barato y de mayor efecto es incluir `docs/wiki/Glosario.md` (o un extracto) en los bloques del sistema, junto a los precedentes: 47 entradas, ya escritas, ya revisadas. Traducir los 14 documentos operativos es el trabajo grande y no hace falta hacerlo primero.

**Escenario.** El contador pregunta «¿cuántas pólizas de diario quedaron sin contabilizar en julio?». El agente lee sus herramientas y su documentación en inglés, decide que «póliza» es *journal entry* y que «de diario» es el `entry_type` `standard`, y contesta con un número. La decisión de equivalencia la tomó el modelo, sin registro y sin que nadie la pueda auditar, sobre un corpus que no se la enseñó.

---

### 15. El esquema no tiene lugar para el tipo de póliza mexicano

**Evidencia.** Los valores que acepta `entry_type` son una taxonomía anglosajona:

```
src/database/migrations/001_core_schema.sql:225-229
entry_type VARCHAR(50) NOT NULL
    CHECK (entry_type IN (
        'standard', 'adjusting', 'closing', 'reversing', 'correction',
        'auto_invoice', 'auto_payment', 'auto_depreciation', 'auto_reconciliation'
    )),
```

```
src/services/accounting/journal-entry-service.ts:42-47
export const ENTRY_TYPES = [
  'standard', 'adjusting', 'closing', 'reversing', 'correction',
  'auto_invoice', 'auto_bill', 'auto_payment', 'auto_depreciation',
  'auto_reconciliation', 'payroll',
] as const;
```

`standard` / `adjusting` / `closing` / `reversing` / `correction` es la clasificación de un libro de US GAAP. La clasificación que usa un despacho mexicano —y la que el propio glosario del repositorio nombra— es otra:

```
docs/wiki/Glosario.md:61
**Póliza** — ... el documento que contiene uno o varios asientos: póliza de
ingresos, de egresos, de diario.
```

CONTPAQi y Aspel COI obligan a elegir Ingreso / Egreso / Diario en el momento de la captura, porque es la clasificación con la que el despacho archiva, revisa y explica. No hay columna aquí de la que derivarla. Y la bandera que la expondría no dice qué valores acepta:

```
$ npx tsx src/cli/mnemosine.ts entry list --help
  --type <type...>                         entry type (repeatable)
```

Una precisión para no sobrepasar la evidencia: el XSD del Anexo 24 (`PolizasPeriodo`) **no** enumera un atributo de tipo de póliza; la clasificación viaja por convención dentro de `NumUnIdenPol`. Así que esto no es hoy un incumplimiento normativo — el propio catálogo admite que los XML del Anexo 24 todavía no se generan (`docs/cli-command-catalog.md:1857`). Es una deuda de diseño: cuando el generador llegue, y cuando el contador pida filtrar «las de egresos de julio», no habrá de dónde sacarlo, y no se puede reconstruir retroactivamente para las pólizas ya capturadas.

**Práctica que incumple.** Localización de modelo de datos, no de cadenas: cuando un mercado clasifica un objeto de negocio de forma distinta, la taxonomía va en el esquema, no en la traducción de la etiqueta. Es lo que hacen SAP y NetSuite con los *document types* por país.

**Severidad: MEDIA. Esfuerzo: L.** Requiere migración de esquema, decidir el mapeo (derivable de las cuentas afectadas: caja/bancos al debe → ingreso, al haber → egreso, ninguna → diario), backfill de lo ya capturado, y exponerlo en `entry create/list`. También hay que decidir si es un campo nuevo o una extensión del CHECK. Por eso es L, y por eso conviene decidirlo antes de que crezca el volumen.

**Escenario.** Llega la revisión del SAT y piden las pólizas de egresos de un periodo. El contador corre `mnemosine poliza listar --type` y descubre que los tipos son `standard`, `adjusting` y `closing`. Tiene que reconstruir la clasificación a mano, póliza por póliza, mirando qué cuenta de bancos tocó cada una.

---

## RECOMENDACIONES

### Lo que NO conviene traducir, y por qué

Antes de la lista de trabajo, la parte que hay que dejar quieta. La decisión de `src/cli/README.md:396` y `docs/cli-command-catalog.md:2050` —nombres canónicos en inglés, ASCII, estables— es correcta y hay que sostenerla:

- **Los nombres canónicos de comando y las banderas.** Romperlos rompe los scripts del despacho, los guiones de cron (`jobs run-due` se llama desde launchd), la referencia que consume el agente (`src/ai/docs/cli-reference.md`) y cualquier documentación externa. El alias es el mecanismo correcto y ya existe.
- **Las claves de `--json`, `--csv` y `--fields`.** Son un contrato de máquina. Traducirlas rompe a cualquier consumidor. Lo que hay que hacer es lo contrario: separar la etiqueta de la clave (brecha 5) para poder traducir una sin tocar la otra.
- **Los valores de enum en la base** (`draft`, `posted`, `asset`) por la misma razón. Se traducen al mostrar.
- **El formato de fecha ISO `YYYY-MM-DD`.** Es no ambiguo, ordenable y correcto para una CLI. `dd/mm/aaaa` en la entrada invitaría a la confusión con `mm/dd`. Si se quiere, se acepta `dd/mm/aaaa` como entrada adicional; no se cambia la salida.
- **`sat`, `cfdi`, `rep`, `webhooks`.** Son las palabras que se usan en México. `ganchos` (brecha 12) es el error opuesto: traducir lo que no se traduce.

### Orden de trabajo: mayor efecto, menor riesgo

**Primero — arreglos de una línea que quitan fallas duras (una tarde):**

1. Sustituir los cuatro predicados sí/no por `isAffirmative` en `entry-command.ts:261`, `invoice-command.ts:228`, `payment-command.ts:116`, `bill-command.ts:184`. **Brecha 1.** Es el arreglo de mejor relación efecto/riesgo de todo el informe.
2. Registrar las variantes acentuadas como alias adicionales en las doce hojas (`póliza`, `período`, `términos`, `línea`, `envío`, `auditoría`, `estadísticas`, `antigüedad-*`). **Brecha 2, primera mitad.**
3. Agregar los 13 alias faltantes (`approvals`, `jobs`, `skills`) y corregir la afirmación de `src/cli/README.md:397`. **Brecha 3.**
4. Cambiar el alias de `invoice issue` de `emitir` a `contabilizar`, y traducir sus dos advertencias sobre el timbrado. **Brecha 4.**
5. Cablear `repairCommandFor` a `reportError`: una rama que reconozca los errores de `pg` antes del `else` de `src/cli/mnemosine.ts:253`, y corregir el envoltorio de entidad para que la falla de conexión gane sobre la de selección. **Brecha 8.**

**Segundo — lo que detiene el sangrado (una semana):**

6. Cambiar `tests/cli/bilingual-matrix.spec.ts` para que camine el `program` exportado en vez de leer un mapa a mano, y falle ante cualquier hoja sin alias o con descripción en español. Sin esto, todo lo anterior se vuelve a romper. **Brecha 3.**
7. Fijar la regla de idioma de los errores y ponerle un guard (un grep sobre los constructores). Cualquiera de las dos reglas sirve; la mezcla no. **Brecha 7.**
8. Dejar de acuñar nombres de periodo en inglés: formatear desde `period_number` al mostrar, o al menos mintear con `es-MX` cuando el país de la entidad es `MX`, **antes** de que se abran más ejercicios. **Brecha 6.** La ventana para que esto sea barato se está cerrando sola.
9. Normalizar a NFC en la entrada y medir el ancho con `string-width` en `output.ts`. **Brecha 9.**

**Tercero — el trabajo con diseño de por medio (un sprint):**

10. Separar etiqueta de clave en `render()`: una firma nueva que acepte encabezados por columna, y seis mapas para los seis reportes. Es lo que desbloquea que la balanza salga en español sin romper `--json`. **Brecha 5.**
11. Poner ejemplos con `addHelpText` en las veinte hojas más usadas, en español, tomados del glosario que ya existe. Y traducir las cinco líneas de `/ayuda` cuando el idioma del agente es `es`. **Brecha 13.**
12. Incluir `docs/wiki/Glosario.md` en los bloques del sistema del agente, junto a los precedentes. 47 entradas ya escritas que le dan al modelo el mapeo ES↔EN que hoy improvisa. **Brecha 14.**
13. Corregir los alias mal elegidos (`ganchos`, `sembrar`, `reversar`, `mapeo`) y sacar `deactivate` de la ranura de alias españoles. **Brecha 12.**
14. Un atajo de raíz `mnemosine balanza`, y desambiguar los dos `mayor`. **Brecha 11.**

**Cuarto — decisión de producto, no de código:**

15. El tipo de póliza mexicano (**brecha 15**) y la colisión de «cliente» (**brecha 10**) son decisiones de modelo de dominio. La primera hay que tomarla pronto porque la migración se encarece con el volumen; la segunda puede vivir como corrección de documentación y de `--help` hasta que haya una razón para tocar el esquema.

### La lectura de fondo

Ninguna de estas quince brechas nace de que nadie haya pensado en el idioma. Al contrario: la política está escrita en dos lugares, razonada, y tiene una prueba. El catálogo de cuentas está en español impecable, el glosario es excelente, el formateo `es-MX` existe, el helper que acepta `sí` existe, el `repairCommandFor` que remite a `doctor` existe y está probado, y el propio glosario documenta que «póliza» es lo que un texto en inglés llamaría *journal entry*.

El problema es que cada una de esas piezas correctas está a una llamada de función de donde hace falta, y nada verifica que llegue. La prueba bilingüe mide una lista escrita a mano en vez de medir el árbol; el detector de restos en español busca las diez frases del audit anterior en cuatro pantallas de cuarenta y cinco. El resultado es un producto donde el español está construido pero no conectado — y donde el guardián que debería haberlo notado pasa en verde, en 12.8 segundos, con veintiún casos.
