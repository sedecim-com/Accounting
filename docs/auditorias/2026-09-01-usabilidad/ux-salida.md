# Auditoría de salida — legibilidad para humano y para máquina

Alcance: `src/cli/kernel/output.ts` completo, los módulos que más imprimen (`report`, `ledger`, `cfdi`, `drafts`, `entry`, `bill`, `invoice`), y el árbol completo de 134 hojas de comando recorrido programáticamente. Todo se corrió contra el árbol de auditoría. La base de datos no responde (`role "mnemo" does not exist`), y ese estado de fallo se auditó como superficie.

---

## LO QUE ESTÁ BIEN

Hay que decirlo antes que nada: **el contrato de salida de este CLI está por encima de la media de la industria**, y las dos decisiones que más pesan están tomadas correctamente y por escrito.

**1. El dinero nunca es un número de JSON.** `output.ts:14-17` lo declara y el código lo cumple: los numerics de Postgres llegan como cadena y salen como cadena. `report-command.ts:47-50` lo repite para su familia. Esto elimina de raíz la clase de error donde una balanza deja de cuadrar por un centavo que nadie encuentra. QuickBooks y Xero exponen importes como float en sus APIs; aquí no.

**2. El truncamiento nunca es silencioso.** `output.ts:19-23`. Reproducido:

```
$ (render con 2 filas de 412)
account_code  account_name  ending_balance
────────────  ────────────  ──────────────
        1100  Bancos          2638816.3500
        4100  Ventas        -18450200.0000
Showing 2 of 412 rows. Raise --limit, page with --offset, or use --all to see the rest.
```

El aviso va a stderr —no contamina el CSV—, dice cuántas de cuántas, y **nombra los tres remedios**. Eso es un error accionable en el sentido de clig.dev. En `--format json` el mismo hecho viaja como `total` y `truncated` dentro del sobre.

**3. Los totales se suman sobre todo y la página se corta después.** `report-command.ts:59-61`, implementado en `pageOf()` (`report-command.ts:154-158`) y en el pie que se calcula sobre `tb.totals`, no sobre las filas mostradas (`report-command.ts:270-275`). Un `--limit 50` cambia lo que ves, nunca lo que la balanza dice. Éste es exactamente el error que comete la paginación ingenua y que produce estados financieros equivocados.

**4. El pie de la balanza va a stderr a propósito.** `report-command.ts:272-273`: «una fila TOTAL extraviada es una mina en un csv que alguien importa». Es la decisión correcta y está razonada. CONTPAQi exporta la balanza con fila de totales embebida y es un dolor recurrente al importarla a Excel.

**5. Se niega a honrar una bandera que no puede honrar.** `rejectStatus()` (`report-command.ts:126-136`): si pides `--status` en un reporte que no filtra por ciclo de vida, **falla** en lugar de ignorarte. El comentario dice el porqué: «ignorar en silencio una bandera que el usuario tecleó es como alguien acaba confiando en un filtro que nunca corrió». Es el principio correcto, y sólo lamento que no se aplique en todas partes (brecha 8).

**6. stdout queda vacío en el fallo.** Verificado byte a byte:

```
$ npx tsx src/cli/mnemosine.ts account list --format json -e <uuid> >/tmp/o.txt 2>/tmp/e.txt
rc=1
--- STDOUT (0 bytes) ---
--- STDERR ---
0000000   \n   r   o   l   e       "   m   n   e   m   o   "       d   o
0000020    e   s       n   o   t       e   x   i   s   t  \n
```

Cero bytes en stdout. Un `> balanza.csv` que falla deja un archivo vacío, no un archivo medio escrito que alguien importa creyéndolo bueno. Muchas CLI comerciales fallan justo aquí.

**7. `--fields` sin valor lista el esquema.** Descubribilidad gratuita, para el humano y para el agente:

```
--- --fields ---
account_code
account_name
ending_balance
```

**8. `--quiet` produce identificadores puros, uno por renglón**, listos para `xargs`. Y el `idField` es explícito por comando (`idField: 'account_code'`, `'entry_number'`, `'period_name'`), no adivinado.

**9. El escape de Markdown está pensado contra la FORJA, no contra la fealdad.** `output.ts:142-153`: escapa la barra invertida primero, luego el pipe, y los saltos de línea al final, con el razonamiento escrito de que el nombre de un proveedor con `\n` bastaba para que las cifras dejaran de corresponder a su columna. Eso es un pensamiento de seguridad aplicado a una tabla.

**10. El vocabulario contable en español es el correcto.** No son traducciones de diccionario:

```
$ npx tsx src/cli/mnemosine.ts report --help
  trial-balance|balanza              Trial balance
  balance-sheet|balance              Balance sheet
  income-statement|resultados        Income statement
  general-ledger|mayor               General ledger detail
  aged-receivable|antiguedad-cobrar  Aged receivables
  aged-payable|antiguedad-pagar      Aged payables
```

`balanza`, `mayor`, `resultados`, `antigüedad`. Quien escribió esos alias sabe contabilidad mexicana.

**11. La moneda sí se acompaña donde hay varias.** `bill-command.ts:101` y `invoice-command.ts:120` llevan `currency_code` como columna por fila, y las confirmaciones nombran la moneda junto al importe: `Post ${target.bill_number} (${target.total_amount} ${target.currency_code}) to the ledger` (`bill-command.ts:562`). La balanza y el mayor no llevan moneda, y **eso es correcto**: son reportes en moneda funcional, y `header()` (`report-command.ts:201-202`) la imprime una vez en el encabezado. No es una brecha.

**12. El contrato de códigos de salida es de los mejores que he visto en una CLI.** `exit.ts:19-46`: doce códigos, cada uno documentado, y el razonamiento explícito de que un `check` que **no pudo correr** nunca sale 4, porque «confundir "encontré problemas" con "no pude mirar" es como un pipeline verde miente». `130` para SIGINT, según POSIX.

**13. El mayor sí tiene límite por omisión y lo anuncia.** `report-command.ts:448-450`: «El mayor es el único reporte con límite por omisión: no está acotado por naturaleza», `pageLimit(opts, 100)`. La decisión está tomada donde debía tomarse.

**14. Hay una auditoría automatizada del propio contrato,** con baseline congelado y sólo-puede-encoger (`kernel/audit.ts:141-149` y el listado desde la línea 199). Incluye una regla explícita: «todo comando list debe ser paginable y formateable, o algún día truncará el estado financiero de alguien en silencio».

**15. `bill show` apila en lugar de desbordar.** `bill-command.ts:307`: «Una factura tiene treinta columnas. Lado a lado son un muro». Se decidió el formato vertical. Es la mitigación correcta al problema de la brecha 4 — sólo que aplicada en un comando y no en el renderizador.

**16. Además, verificado:** `NO_COLOR` respetado con su razón citada (`palette.ts:23`), `-f` deliberadamente sin asignar para que nadie confunda `--file` con `--force` (`flags.ts:19-21`), `--dry-run` / `--yes` / `--idempotency-key` exigidos por clase de riesgo (`audit.ts:126-137`), y once deletreos prohibidos (`--fmt`, `--pretty`, `--silent`, `--dryrun`…) rechazados por la puerta (`flags.ts:28-31`).

---

## BRECHAS

### 1. Las fechas salen como marca de tiempo UTC, y eso corre pólizas de mes — ALTA / S

`output.ts:99` es la única regla de fecha del renderizador:

```typescript
if (value instanceof Date) return value.toISOString();
```

`node-postgres` entrega un `timestamptz` como `Date`. Una póliza capturada el **31 de enero a las 20:00 hora de la Ciudad de México** se convierte en 1 de febrero. Reproducido:

```
$ TZ=America/Mexico_City npx tsx probe3.ts
--- corte de periodo: poliza posteada 31/ene 20:00 hora CDMX ---
folio  posted_at                 importe
─────  ────────────────────────  ───────
D-1    2026-02-01T02:00:00.000Z  1000.00
```

**La práctica que incumple:** presentar un valor en un huso distinto del que el usuario capturó es un defecto de correctitud, no de formato. El propio repositorio lo sabe y lo dice: `bill-command.ts:108-112` documenta que «`toISOString()` lo movería un día al oeste de Greenwich; los getters locales son los que concuerdan con la columna».

**Lo grave es que el arreglo ya existe cinco veces y ninguna está en el kernel.** El mismo helper `getFullYear()/pad(getMonth()+1)/pad(getDate())` está copiado en `bill-command.ts:117`, `customer-command.ts:119`, `invoice-command.ts:108`, `entry-command.ts:153` y `report-command.ts:100-108`. Y `entry-command.ts` **exporta `day()` en la línea 151 y en la 362 hace exactamente lo contrario** sobre el mismo tipo de valor:

```typescript
// entry-command.ts:151  — el arreglo
export function day(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

// entry-command.ts:362  — el defecto, en el mismo archivo
posted_date: detail.posted_date ? new Date(detail.posted_date).toISOString() : '',
```

Lo mismo en `invoice-command.ts:718` (`updated_at`), `memory-command.ts:47`, `approvals-command.ts:102` y `mnemosine.ts:1534, 1855`.

**Escenario:** el contador cierra enero. Corre `mnemosine entry show D-1` para revisar la última póliza del mes y lee `posted_date  2026-02-01T02:00:00.000Z`. O concluye que se le fue una póliza al mes siguiente y la reversa —creando dos asientos donde había uno—, o desconfía del sistema y verifica todo a mano. En un despacho con 40 clientes, esto pasa 40 veces en enero.

### 2. Los importes salen sin separador de miles y con cuatro decimales — ALTA / M

Una balanza real, armada exactamente como la arma `report-command.ts:260-266`:

```
account_code  account_name            account_type  debit_total    credit_total   ending_balance
────────────  ──────────────────────  ────────────  ─────────────  ─────────────  ──────────────
        1100  Bancos                  asset         12458930.5500   9820114.2000    2638816.3500
        1200  Clientes                asset                0.0000         0.0000          0.0000
        4100  Ingresos por servicios  revenue              0.0000  18450200.0000  -18450200.0000
```

Dos cosas. Primera, `12458930.5500` obliga a contar dígitos con el dedo. CONTPAQi Contabilidad, Aspel COI, QuickBooks, Xero y SAP imprimen todos `12,458,930.55`. Es la convención universal de presentación contable y no tiene excepciones.

Segunda, `money()` (`report-command.ts:118-121`) normaliza a `toFixed(4)`. El comentario justifica bien el **normalizar** —Postgres devuelve el entero `0` para una cuenta vacía y mezclar `"0"` con `"2469.1200"` impide comparar—, pero elige cuatro decimales, que es la precisión de almacenamiento del mayor, no la de presentación del peso. Cada importe carga dos ceros sin información y ensancha tres columnas seis caracteres, lo que empeora directamente la brecha 4.

En todo `src/` sólo hay **una** llamada a formato mexicano de número: `cfdi-decisions.ts:42`, `n.toLocaleString('es-MX', {minimumFractionDigits: 2, maximumFractionDigits: 2})`. Ésa es la línea correcta, y está enterrada en un servicio de decisiones. Las otras cuatro llamadas a `toLocaleString` del proyecto usan `'en-US'` (`compact-command.ts:82`, `usage-command.ts:70`, `prompt-size-command.ts:102`, `approvals-command.ts:157-158`).

**Escenario:** el contador exporta la balanza a CSV para conciliar y la lee en pantalla antes. Con seis cuentas de siete y ocho dígitos sin separador, confunde 1,245,893 con 12,458,930 y persigue una diferencia de un orden de magnitud durante media hora.

*Nota justa:* el CSV **debe** salir sin separadores, y sale sin ellos. Esta brecha es sólo del formato `table`. La solución es formatear en `toTable()`, no en el dato.

### 3. Ninguna fecha, en ninguna ruta, es dd/mm/aaaa — ALTA / M

Incluso donde el arreglo del huso está bien hecho, la salida es ISO. `report-command.ts:100-108` produce `2026-01-31`. `bill-command.ts:117`, `entry-command.ts:153`, `invoice-command.ts:108` y `customer-command.ts:119` producen lo mismo. No hay una sola ruta de código que emita `31/01/2026`.

Y la entrada es igual de rígida. `flags.ts:64-71`:

```typescript
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
...
throw new InvalidArgumentError(`${name} must be a date as YYYY-MM-DD; got "${value}".`);
```

Un contador que teclea `--since 31/01/2026` es rechazado. El mensaje de error es bueno —dice qué esperaba y qué recibió—, pero está en inglés y ofrece un solo formato.

**La práctica que incumple:** ISO 8601 es el formato correcto de intercambio y de `--format json|csv`; no es el formato de presentación de un país. Nielsen, heurística 2 («coincidencia entre el sistema y el mundo real»): la interfaz debe hablar el lenguaje del usuario. CONTPAQi y Aspel muestran dd/mm/aaaa y aceptan dd/mm/aaaa.

**Escenario:** el contador lee `2026-03-04` en un auxiliar y no sabe si es 4 de marzo o 3 de abril. Los primeros doce días de cada mes son ambiguos para quien lee dd/mm por costumbre.

*Recomendación acotada:* dd/mm/aaaa **sólo** en `table`; ISO intacto en `json`, `ndjson`, `csv`, `tsv`. Y aceptar ambos en la entrada.

### 4. La tabla no sabe qué tan ancha es la terminal — MEDIA / M

`toTable()` (`output.ts:114-129`) calcula anchos con `Math.max` sobre el contenido y no consulta `process.stdout.columns` en ningún punto. En todo `src/cli` la única lectura del ancho está en `banner.ts` (líneas 87, 102, 110, 128-130), que sí adapta —tiene modo compacto bajo 80 columnas y se calla bajo 40—. **El banner respeta la terminal; las tablas de datos no.**

La balanza de arriba mide 96 columnas de ancho. En una terminal de 80:

```
$ npx tsx probe4.ts | fold -w 80
account_code  account_name            account_type  debit_total    credit_total 
  ending_balance
────────────  ──────────────────────  ────────────  ─────────────  ─────────────  ──────────────
        1100  Bancos                  asset         12458930.5500   9820114.2000
    2638816.3500
        1200  Clientes                asset                0.0000         0.0000
          0.0000
```

`ending_balance` —el saldo, la columna que el contador vino a ver— se desprende a su propio renglón, y el encabezado deja de estar sobre sus datos. Con seis columnas ya se rompe; el mayor y el auxiliar tienen más.

**La práctica que incumple:** clig.dev pide que la salida se adapte al ancho de la terminal cuando es un TTY, y que se mantenga estable cuando no lo es. `docker ps`, `kubectl get`, `gh pr list` y `psql` truncan o eliden por columna; ninguno desborda.

**Escenario:** el despacho trabaja en laptops con la terminal a la mitad de la pantalla junto al PDF del cliente. Cada balanza sale envuelta y hay que maximizar la ventana para leerla, o exportarla a CSV y abrirla en Excel — que es exactamente el flujo que este CLI existía para evitar.

*Nota:* la regla horizontal se dibuja con `─` (U+2500, 3 bytes en UTF-8). La línea mide 268 bytes y 96 columnas de despliegue. `toTable` usa `.length` de JavaScript para calcular anchos, que cuenta unidades UTF-16 — correcto para acentos latinos y para `─`, pero incorrecto para cualquier carácter de ancho doble o fuera del BMP. No lo verifiqué con datos reales; lo dejo señalado, no afirmado.

### 5. `drafts` —el flujo insignia del producto— no muestra importes ni tiene salida de máquina — ALTA / M

El producto entero es «la IA propone, la persona dispone». El comando donde eso ocurre es `drafts`. Su ayuda completa:

```
$ npx tsx src/cli/mnemosine.ts drafts --help
Usage: mnemosine drafts|borradores [options]

Lists the journal entry drafts created by the AI

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -s, --status <status>    pending_review | approved | rejected
  -h, --help               display help for command
```

Dos banderas. Sin `--json`, sin `--format`, sin `--limit`, sin `--fields`, sin `--quiet`, sin `--offset`. No pasa por `render()`; imprime a mano (`mnemosine.ts:1022-1031`):

```typescript
console.log(
  `${tag} ${c.bold(d.payload.entry_date)}  ${d.payload.description}  ` +
    c.dim(`(${d.payload.lines.length} lines · conf ${d.ai_confidence} · ${d.status} · ${d.id})`)
);
```

**No hay importe.** El renglón lleva fecha, descripción, número de renglones, confianza, estatus y UUID. No lleva cuánto dinero mueve el borrador.

**La práctica que incumple:** un contador tría por materialidad. Es lo primero que hace en cualquier bandeja de revisión de CONTPAQi, de NetSuite o de un banco. Sin importe no se puede ordenar por lo que importa, ni decidir qué revisar con calma y qué aprobar en bloque. Y sin `--limit`, doscientos borradores salen doscientos renglones.

**Escenario:** el lunes hay 180 borradores de la ingesta del fin de semana. El contador quiere revisar primero los cinco que pasan de cien mil pesos y aprobar el resto en lote. No puede: tiene que abrir los 180 uno por uno para saber de cuánto son.

*El mismo hueco en la misma familia:* `sessions`, `review`, `ingest`, `outbox run`, `question answer` y `pending define|dismiss|reopen` tampoco tienen salida de máquina.

### 6. 63 de 134 hojas no tienen ninguna salida legible por máquina — MEDIA / L

Medido recorriendo el árbol de comandos con `program` exportado (`mnemosine.ts:2152`):

```
TOTAL HOJAS: 134
con --json: 71
con --format: 47
con json O format: 71
con --quiet: 47
con --fields: 47
con --output: 47
con --limit: 32
```

El contrato completo (`--format` + `--fields` + `--quiet` + `--output`, o sea `withOutput()`) cubre **47 de 134, el 35%**. Otras 24 tienen `--json` a secas —contrato parcial, sin `csv`, sin `--fields`, sin `--output`—, y **63 no tienen nada**.

El corte no es aleatorio: los módulos nuevos (`report`, `ledger`, `account`, `entry`, `bill`, `invoice`, `customer`, `vendor`, `period`, `cfdi`) usan el kernel; los viejos, que viven en `mnemosine.ts`, imprimen a mano. `mnemosine.ts` tiene **140 llamadas a `console.log`** frente a 2 a `render()`. En total, 15 archivos usan `render()` y 15 imprimen con `console.log`.

**La práctica que incumple:** clig.dev, «tener salida legible por máquina no es opcional». El esquema `json` sí es estable y versionado (`SCHEMA_VERSION`, `output.ts:33, 191-203`) — eso está bien. El problema es la cobertura, no el diseño.

**Escenario:** el despacho quiere una alerta diaria de borradores viejos. `ledger stale-draft list --format json` funciona. `drafts --json` no existe, así que el guion tiene que parsear renglones de texto con emoji, y se rompe el día que alguien cambia una palabra.

### 7. Cuando se pide `--json`, el error no sale en JSON — MEDIA / S

Reproducido arriba en «lo que está bien» (punto 6): stdout queda en 0 bytes y stderr lleva texto plano. La higiene de flujos es correcta; el hueco es que **no hay objeto de error**.

Un consumidor que hace `mnemosine account list --format json | jq '.rows[]'` recibe `jq: error: Unexpected end of input` — un mensaje sobre JSON malformado, no sobre una base de datos caída. El diagnóstico real está en stderr, que en una tubería suele no mirarse.

`CliError` ya tiene el campo para esto: `exit.ts:59` declara «`detail`: detalle legible por máquina llevado a la salida `--json`». Está declarado y no está conectado.

**La práctica que incumple:** clig.dev, «si el usuario pidió salida legible por máquina, los errores también deben serlo». `stripe`, `aws` y `az` emiten errores estructurados bajo `--output json`.

*Ojo:* el código de salida es `1` (`FAILURE`) para una caída de conexión, cuando el contrato tiene `8 EXTERNAL_FAILED` («Retryable»). Un runner de trabajos no puede distinguir «reintenta en cinco minutos» de «el comando está mal escrito».

### 8. `ledger stale-draft list` declara tres banderas de paginación y no honra ninguna — MEDIA / S

```
$ npx tsx src/cli/mnemosine.ts ledger stale-draft list -n 5 -e <uuid>
[error de conexión]
```

`ledger-command.ts:134` aplica `withOutput(withSelection(withContext(staleList)))`, o sea `-n/--limit`, `--offset`, `-a/--all`. La línea 145:

```typescript
const rows = await listStaleDrafts(ctx.entityId, { days: dias, period: opts.period });
render(rows as unknown as Row[], { ...opts, idField: 'entry_number' });
```

Ni `limit`, ni `offset`, ni `total`. Y la firma del servicio ni siquiera los acepta (`ledger-checks.ts:177-180`: `opts: { days?: number; period?: string }`). Lo que sí hay es un tope escondido en el SQL (`ledger-checks.ts:203`):

```sql
ORDER BY je.created_at
LIMIT 500
```

Sin `COUNT(*)`. Así que con 501 borradores viejos el usuario ve 500, `render()` no recibe `total`, y **no se dispara el aviso de truncamiento**. Es la violación exacta de la regla que `output.ts:19-23` declara como correctitud: «EL TRUNCAMIENTO SIEMPRE SE REPORTA».

Y es la violación exacta del principio que `report-command.ts:130-131` articula: «ignorar en silencio una bandera que el usuario tecleó es como alguien acaba confiando en un filtro que nunca corrió». El proyecto tiene escrita la regla y este comando la rompe.

**Por qué la puerta no lo atrapa:** `audit.ts:141-149` sólo verifica que el comando **declare** `--limit` y `--format`. `stale-draft list` los declara. La auditoría comprueba la existencia de la bandera, nunca que se honre — que es la mitad difícil.

**Escenario:** cierre de fin de año en un despacho con varios clientes grandes. El contador corre `ledger stale-draft list` —descrito como «el bloqueador número uno de toda lista de cierre»—, ve 500 borradores, los resuelve todos, vuelve a correr y siguen apareciendo 500. No hay nada en pantalla que le diga que la lista está cortada.

### 9. El auxiliar SAT no tiene límite por omisión — MEDIA / S

`ledger-command.ts:170-173`:

```typescript
const aux = await getAuxiliaryView(ctx.entityId, opts.account, opts.period, {
  limit: opts.all ? undefined : opts.limit,
  offset: opts.offset,
});
```

`opts.limit` es `undefined` cuando no se teclea (`flags.ts:116` no declara valor por omisión), y el servicio hace `limit: opts.limit ?? total` (`report-service.ts` en el cuerpo de `getAuxiliaryView`). Resultado: sin `--limit`, se devuelven **todos** los movimientos.

El mayor sí resolvió esto y lo documentó (`report-command.ts:448-450`, `pageLimit(opts, 100)`). El auxiliar —que es la forma XC que pide el SAT y que sobre una cuenta de bancos trae miles de movimientos al mes— no. Al menos sí pasa `total: aux.total_movimientos`, así que el conteo es honesto; el problema es el volumen.

**Escenario:** `mnemosine ledger auxiliar ver --account 1100 --period 2026-01` sobre la chequera de un cliente con 4,000 movimientos vuelca 4,000 renglones a la terminal. Sin paginador (`--no-pager` está en el diccionario, `flags.ts:43`, pero no hay paginador que desactivar), el contador pierde el búfer de scroll y vuelve a correr el comando con `-n`, si es que sabe que existe.

### 10. Los encabezados de columna son nombres de base de datos, en inglés — MEDIA / M

`account_code`, `account_name`, `account_type`, `debit_total`, `credit_total`, `ending_balance`. Son las llaves del objeto, y `toTable()` las imprime tal cual (`output.ts:125`).

Para un contador mexicano las columnas de una balanza son **Cuenta, Nombre, Saldo inicial, Cargos, Abonos, Saldo final**. Ni el idioma ni el `snake_case` corresponden. Es especialmente notorio junto al punto 10 de aciertos: los alias de comando sí están en español contable correcto (`balanza`, `mayor`, `resultados`), de modo que el usuario teclea `mnemosine reporte balanza` y recibe una tabla que dice `debit_total`.

Hay una tensión real aquí y hay que reconocerla: la misma llave alimenta `--fields`, `--format csv` y el sobre JSON, donde `snake_case` inglés es lo correcto y estable. La salida es un mapa de presentación **sólo para `table`**, dejando las llaves intactas en todo lo demás — igual que la separación que propongo para fechas e importes.

### 11. `ingest` no dice cuánto lleva, y produce dos renglones de ruido por archivo — MEDIA / S

`mnemosine.ts:1277`:

```typescript
onProgress: (msg) => stderr.write(ce.dim(`\n── ${msg}\n`)),
```

Y la única emisión, `ingest-service.ts:113-116`:

```typescript
for (const file of files) {
  const name = path.basename(file);
  onProgress?.(`Processing ${name}…`);
  results.push(await ingestOne(file, name));
}
```

`Processing factura.xml…` — sin contador, sin porcentaje, sin tiempo estimado. Con 500 XML, cada uno de los cuales hace una llamada a un modelo de lenguaje, son 1,000 renglones (una línea en blanco más una regla por archivo) y en ningún momento se sabe si va en el archivo 12 o en el 480. El total sí se conoce: `files.length` se imprime en el encabezado (`mnemosine.ts:1264-1268`).

**La práctica que incumple:** clig.dev, «si algo tarda más de un segundo, muestra progreso». `docker pull`, `npm install`, `gh repo clone` y `aws s3 sync` muestran todos posición sobre total.

**Detalle adicional:** ese encabezado sale por `console.log` —**stdout**— mientras el progreso va a stderr. Contradice `output.ts:25-26` («los datos van a stdout; toda nota, aviso y diagnóstico va a stderr»). Como `ingest` no tiene `--json`, hoy no rompe nada, pero deja stdout con contenido decorativo si algún día lo tuviera.

**Sobre la interrupción, en descargo:** el bucle es secuencial y cada archivo se confirma por separado, así que un Ctrl-C no deja transacciones a medias — los archivos ya procesados quedan hechos y el resto intactos. `SIGINT` está manejado y sale 130 (`mnemosine.ts:2110-2113`). Lo que falta es el resumen de dónde quedó: nada le dice al usuario qué archivos alcanzaron a procesarse, así que la única forma de reanudar es volver a pasarlos todos y confiar en la detección de duplicados.

### 12. La alineación numérica se infiere por página, y cambia entre corridas — BAJA / S

`output.ts:104-112` decide qué columna va a la derecha probando si **todos** los valores de esa página parsean como número. Reproducido:

```
--- misma columna, dos paginas distintas: la alineacion CAMBIA ---
pagina 1 (todas las referencias numericas):
ref   importe
────  ───────
1001    10.00
   9    20.00
pagina 2 (una referencia con letras):
ref   importe
────  ───────
1001    10.00
A-9     20.00
```

Y el efecto colateral sobre códigos de cuenta:

```
code  nombre             saldo
────  ─────────────────  ──────
1100  Bancos             100.00
 110  Activo circulante   90.00
```

`110` se alinea a la derecha como si fuera una cantidad. Un código de cuenta es un identificador, no un número; su jerarquía se lee de izquierda a derecha y alinearlo a la derecha rompe la lectura del árbol de cuentas.

**La práctica que incumple:** Nielsen, heurística 4 («consistencia y estándares»). El mismo comando con distintos filtros produce tablas alineadas distinto, y el usuario no puede saber por qué.

**El arreglo ya está disponible y sin usar.** `RenderOptions.numeric` existe (`output.ts:52`: «Columnas a alinear a la derecha (números). Se infiere cuando se omite») y `render()` la respeta (`output.ts:217`). No la pasa **ningún** llamador: `grep -rn "numeric:" src/cli` no devuelve nada. Los comandos que arman filas ya saben cuáles son importes —`report-command.ts:260-266` los pasa por `money()` uno por uno—, así que declararlo es una línea por comando.

### 13. Todo error empieza con un salto de línea espurio — BAJA / S

`mnemosine.ts:254`:

```typescript
console.error(ce.red(`\n${err instanceof Error ? err.message : String(err)}`));
```

El `\n` está en las cinco ramas de `reportError` (líneas 243, 246, 249, 252, 254). Verificado en el volcado octal del punto 6 de aciertos: el primer byte de stderr es `\n`.

Es cosmético en una terminal, y molesto en un registro: `mnemosine ... 2>> mnemosine.log` intercala un renglón vacío antes de cada error, lo que duplica el tamaño del archivo de errores y estorba a un `grep -c`.

### 14. «Interrupted.» se escribe en stdout y contamina el flujo de datos — BAJA / S

`mnemosine.ts:2110-2113`:

```typescript
process.on('SIGINT', () => {
  stdout.write(c.dim('\nInterrupted.\n'));
  void shutdown(130);
});
```

`stdout` es `process.stdout` (importado en `mnemosine.ts:3`). Es la única violación de la regla de flujos de `output.ts:25-26` que encontré en una ruta genérica que cubre **todos** los comandos no interactivos.

**Escenario:** `mnemosine report general-ledger show --format csv --all -o mayor.csv` está tardando y el contador aprieta Ctrl-C. Con `-o` el archivo se escribe por `writeFileSync` y se salva; pero con redirección de shell —`mnemosine report general-ledger show --format csv --all > mayor.csv`— el archivo queda con `Interrupted.` como última línea, que Excel importa como una fila de datos.

El arreglo es cambiar `stdout` por `stderr` en esa línea. La versión interactiva (`mnemosine.ts:1434`) tiene el mismo patrón, pero ahí es correcto porque no hay tubería.

---

## RECOMENDACIONES

Ordenadas por relación entre daño evitado y trabajo.

**1. Subir al kernel los cuatro formateadores, y aplicarlos sólo a `table`.** Es la recomendación central y resuelve las brechas 1, 2, 3, 10 y 12 de una vez, porque las cinco son la misma omisión: `output.ts` no tiene una capa de presentación.

En `output.ts`, junto a `cell()`:

- `dateOnly(Date)` con getters locales, ascendido desde `bill-command.ts:113-120` — que ya está escrito, probado y con su razón documentada. Borrar las cinco copias y las siete llamadas sueltas a `toISOString()` de la brecha 1.
- Formato mexicano de fecha y de importe **únicamente** en la rama `format === 'table'` (`output.ts:212-219`). `json`, `ndjson`, `csv`, `tsv` y `md` siguen recibiendo ISO y decimal crudo, sin tocar. Ésta es la línea que hace que la recomendación sea segura: nada de lo que consume una máquina cambia.
- Dos decimales en presentación, con `Intl.NumberFormat('es-MX')`, tomando como modelo la línea que ya existe en `cfdi-decisions.ts:42`.
- Un mapa opcional de etiquetas por columna, para que `debit_total` se despliegue como `Cargos` sin cambiar la llave.

Para no romper a nadie: una variable `MNEMOSINE_LOCALE` con `es-MX` por omisión, y `--format table` con locale `C` disponible para quien tenga guiones que parsean la tabla.

**2. Declarar `numeric` en los comandos que arman filas de dinero.** Elimina la inestabilidad de alineación (brecha 12) y saca los códigos de cuenta de la columna derecha. `RenderOptions.numeric` ya existe y nadie la usa; es una línea por comando y `report-command.ts:260-266` ya sabe cuáles son sus importes.

**3. Hacer que la tabla conozca `process.stdout.columns`** (brecha 4). `banner.ts` ya tiene el patrón resuelto en el mismo repositorio, incluida la elisión (`clip()`, `banner.ts:40`) y el escalón por ancho (`banner.ts:128-130`). Reglas mínimas: nunca truncar una columna numérica; elidir la columna de texto más ancha; cuando ni así entre, decirlo en stderr y sugerir `--fields`. Cuando no es TTY, `columns` es `undefined` y el comportamiento debe quedar exactamente como hoy, para que ningún archivo redirigido cambie.

**4. Endurecer la puerta de auditoría para que verifique el honramiento, no la declaración** (brecha 8). Hoy `audit.ts:141-149` sólo comprueba que la bandera exista. Añadir una prueba que, por cada hoja que declare `--limit`, corra el manejador con un servicio simulado y afirme que el límite llegó. Eso habría atrapado `ledger stale-draft list`, y atrapa el siguiente. Aparte: darle `limit`/`offset` y un `COUNT(*)` a `listStaleDrafts`, y un límite por omisión a `getAuxiliaryView` como el que ya tiene el mayor.

**5. Darle a `drafts` el contrato completo y una columna de importe** (brecha 5). Es el comando del que depende la promesa del producto y es el peor servido. Pasarlo por `render()` con `withReadFlags()`, y que la fila lleve `total` además de fecha, descripción, confianza y estatus. Mismo trato para `sessions`, `review`, `pending` y `outbox`.

**6. Error estructurado bajo `--json`** (brecha 7). `CliError.detail` ya está declarado para esto (`exit.ts:59`). Cuando el formato resuelto sea `json` o `ndjson`, emitir a stderr un `{schema, error: {code, message, detail, exit_code}}` en vez de texto plano, y mapear el fallo de conexión a `EXTERNAL_FAILED` (8) en lugar de `FAILURE` (1). El sobre versionado ya existe; es reusarlo.

**7. Los tres arreglos de un renglón:** quitar el `\n` de las cinco ramas de `reportError` (`mnemosine.ts:243-254`); cambiar `stdout` por `stderr` en el manejador global de SIGINT (`mnemosine.ts:2111`); y mover el encabezado de `ingest` de `console.log` a `stderr` (`mnemosine.ts:1264`).

**8. Contador en el progreso de `ingest`** (brecha 11). `files.length` ya se conoce y ya se imprime. Cambiar la firma a `onProgress?.(name, i + 1, files.length)` y emitir `[ 47/500] factura-A123.xml` en un solo renglón, sin la línea en blanco ni la regla. Cuando stderr no es TTY, un renglón cada 25 archivos en vez de uno por archivo, para que un registro de trabajo desatendido no engorde. Y al terminar —o al interrumpir— un resumen de qué se procesó, para poder reanudar.

**9. Aceptar dd/mm/aaaa en la entrada,** no sólo en la salida. `parseDate` (`flags.ts:64-71`) es un solo lugar: probar primero `dd/mm/aaaa`, luego ISO, y ampliar el mensaje de error para que nombre ambos. Es donde más rápido se nota que el producto es para México.

**10. Ejemplos en la ayuda.** Confirmado: `addHelpText` no se usa en ninguna de las 134 hojas (medido recorriendo el árbol y contando `_helpTexts` por comando: 0 de 134). No es de esta lente, pero interactúa con ella: `--fields`, `--format csv`, `--limit` y `--all` son buenas banderas que nadie va a descubrir leyendo una lista de opciones. Tres ejemplos en `report trial-balance show` y tres en `ledger auxiliary show` enseñan el contrato de salida entero.

---

## CIERRE

Este CLI tiene un contrato de salida diseñado, escrito y razonado, con dos decisiones de correctitud —el dinero como cadena y el truncamiento nunca silencioso— que la mayoría de los sistemas contables comerciales no toman. El problema no es de diseño: es de **cobertura y de capa**.

De cobertura, porque el contrato llega al 35% de las hojas y los comandos que quedaron fuera son justamente los del flujo insignia — `drafts`, `review`, `ingest`, `pending`.

De capa, porque la presentación quedó sin dueño. `output.ts` renderiza el dato crudo; cada módulo que necesitó una fecha correcta se escribió su propio `dateOnly`, y ya van cinco copias, una de las cuales convive en el mismo archivo con el defecto que arregla. Los importes ni siquiera tuvieron ese remedio local: salen sin separador de miles en toda la aplicación.

La consecuencia práctica es que el sistema es correcto por dentro y ajeno por fuera. Un contador mexicano abre una balanza y lee `12458930.5500` bajo una columna que dice `debit_total`, con fechas `2026-02-01T02:00:00.000Z` que a veces son de enero. Todo eso se arregla en un solo lugar —la rama `table` de `render()`— y sin tocar un byte de lo que consumen las máquinas.
