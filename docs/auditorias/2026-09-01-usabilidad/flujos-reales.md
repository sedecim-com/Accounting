> Lente: **los flujos principales, documentados tal como son hoy**. Todo lo que sigue está trazado leyendo el código del árbol `/private/tmp/claude-501/-Users-victor-projects-Accounting/d48ca5a0-ac05-4c38-a2d6-62373f8f-aud` y verificado contra `--help` ejecutado de verdad. No hay base de datos, así que las secuencias no se corrieron de punta a punta: cada comando se verificó individualmente contra el árbol de comandos (volcado con Commander) y contra su propia ayuda. Donde no pude verificar, lo digo.

---

## LO QUE ESTÁ BIEN

Antes de las brechas, lo que un manual de usuario puede prometer sin mentir.

**1. El contrato de códigos de salida está publicado una sola vez y razonado.** `src/cli/kernel/exit.ts:1-46` define trece códigos con semántica, y explica por qué dos de ellos existen:

```
//   4  a `check` that FOUND something. Findings are also in the
//      payload — the code is what lets a check drop into CI or a
//      job runner unchanged (git diff --exit-code's trick).
//   11 needs human: a question was raised or a draft awaits
//      review. This is the code that makes an agent-driven
//      workflow safe — the work did not fail, it is waiting.
//
// A check that could NOT RUN (no connection, bad selector) exits
// 1/2/3/8 as appropriate — never 4. Conflating "I found problems"
// with "I could not look" is how a green pipeline lies.
```

Esa última frase es exactamente la distinción que las CLI de referencia (`git diff --exit-code`, `terraform plan -detailed-exitcode`) resuelven bien y que casi todo el resto confunde. Está bien resuelto y hay que acreditarlo.

**2. `doctor` diagnostica Y remedia, línea por línea.** Es el único comando que cumple la heurística 9 de Nielsen ("ayudar a reconocer, diagnosticar y recuperarse de errores") de forma completa:

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
$ echo $?
1
```

Nombra la causa, da el comando exacto, y ordena los fallos. Es el modelo que el resto de los errores debería copiar (ver brecha 15).

**3. Los 501 son honestos y nombran el sustituto.** Tres endpoints se retiraron en vez de fingir, y cada uno explica el daño que evitaba. `src/api/rest/routes/bank-reconciliation.ts:303-312`:

```
throw new NotImplementedError(
  'mnemosine cannot complete a bank reconciliation: it does not compute the book balance, the ' +
    'variance, outstanding checks or deposits in transit, and it does not post the bank fees, ' +
    'interest and returns a reconciliation uncovers. Marking the session "balanced" would have ' +
    'told the period-close checklist that this account was verified against the bank when nothing ' +
    'had been verified. Reconcile the account outside mnemosine, post the adjustments you find as ' +
    'journal entries, and leave the period-close warning standing until you have.'
);
```

Y `src/api/rest/routes/invoices.ts:330-336` da el comando de recambio: *"Cancela en el portal de tu PAC o en el del SAT, y después reversa el asiento con `mnemosine entry reverse <numero> --reason "CFDI cancelado, acuse <folio>"`"*. Esto es lo contrario de lo que hacen la mayoría de los sistemas: un `501` que enseña el camino manual vale más que un `200` que miente.

**4. El IVA en base de flujo (PPD/PUE) está construido con cuidado poco común.** `src/services/accounting/iva-cash-basis.ts:64-67` fija el default conservador y lo razona por lado del documento:

```
export const CONSERVATIVE_METODO: Readonly<Record<DocumentSide, MetodoPago>> = Object.freeze({
  issued: 'PUE',
  received: 'PPD',
});
```

Y el reconocedor de tokens (línea 99) descarta explícitamente el falso positivo mexicano por excelencia:

```
 *   "Entrega en Cholula, Pue."  → `Pue.` is the state of Puebla, not PUE.
 *   "Ref PPD-2026-04"           → a folio, not a payment method.
```

Además la suposición queda escrita en la descripción del asiento (`withAssumptionNote`, `ar-ap-posting.ts:80-85`): *"· MetodoPago missing: X assumed"*. Un contador que audite el mayor ve de dónde salió el criterio. Esto es mejor de lo que hace CONTPAQi, que simplemente toma lo que diga el XML.

**5. El cierre evalúa el checklist DENTRO de la transacción del cierre.** `src/services/accounting/period-close.ts:200-205`:

```
// Y desde R1 el CHECKLIST también vive dentro: se evaluaba fuera, así que
// un posteo en vuelo podía confirmar entre la foto y el UPDATE — el periodo
// cerraba con un checklist que no lo contaba. El FOR UPDATE de la fila se
// cruza con el FOR SHARE que todo posteo toma (posting.ts).
```

La auditoría del cierre duro también va en la misma transacción (`period-close.ts:335-342`), después de que antes sólo quedaba `hard_close_date` sin quién ni por qué.

**6. `entry create` da el error de periodo con su remedio.** `src/services/accounting/journal-entry-service.ts:425-429`:

```
throw new ValidationError(
  `No open fiscal period covers ${input.date}. Open it with \`mnemosine period open\`, ` +
    'or create the fiscal year with `mnemosine year create`.'
);
```

Es el patrón correcto. El problema es que sólo existe aquí (brecha 10).

**7. `--format` y `-o/--output` son reales, no decorativos.** `src/cli/kernel/output.ts:241-242` escribe el archivo de verdad, y el contrato dice que las notas van a stderr y los datos a stdout (línea 162-164). Combinado con `NO_COLOR` (ya acreditado por el orquestador), la salida por tubería es limpia. Un despacho puede hacer `mnemosine report trial-balance show --period 2026-08 --format csv -o balanza.csv` y abrirlo en Excel. Esto cubre buena parte de lo que un contador espera de "exportar".

**8. La aprobación de un borrador está atada al contenido que el revisor VIO.** `src/cli/mnemosine.ts:1105-1109`:

```
// Approval is bound to the exact content the reviewer SAW at
// render time: if the payload changes in between, approval aborts.
const posted = await approveDraft(
  ctx, pending[i].id, reviewer, undefined, canonicalDraftHash(pending[i].payload)
);
```

Es maker-checker de verdad, no un botón de "aprobar" sobre un id.

**9. `sat cred` trata la e.firma como lo que es.** Contraseña con eco apagado, texto de consentimiento explícito, bitácora de accesos (`sat cred audit`), revocación irreversible, y hasta un aviso si el archivo `.key` es legible por otros usuarios del sistema (`src/cli/sat-commands.ts:33-41`, con el `chmod 600` sugerido). La ceremonia está bien montada. Lo que falta es que sirva para algo (brecha 4).

**10. `init --section` acepta los dos idiomas y el error enumera las opciones.**

```
$ npx tsx src/cli/mnemosine.ts init --section zzz
Unknown section: "zzz". Options: infra, identity, users, ai, policies, import
```

Documentado a propósito en `src/cli/init-command.ts:113-114`: *"`--section` accepts the English name (advertised in --help) and the Spanish id"*. Es la manera correcta de hacer bilingüe una superficie.

---

## BRECHAS

### 1. La conciliación bancaria no existe en la terminal, y su ausencia pinta el cierre de verde

**Severidad: ALTA · Esfuerzo: L**

Evidencia. El árbol de comandos completo no tiene familia `bank`, `banco` ni `conciliacion`:

```
$ npx tsx src/cli/mnemosine.ts bank
error: too many arguments for 'chat'. Expected 0 arguments but got 1: bank.
$ echo $?
1
$ npx tsx src/cli/mnemosine.ts conciliacion
error: too many arguments for 'chat'. Expected 0 arguments but got 1: conciliacion.
```

El motor sí existe, pero sólo por HTTP. `src/api/rest/routes/bank-reconciliation.ts` publica ocho rutas —importar estado de cuenta, listar no conciliados, sugerir coincidencias, casar, auto-casar, abrir sesión, consultar—, y la novena, la que cierra la conciliación, es el `501` que ya cité: *"What does not exist is the arithmetic that turns a pile of matches into a reconciliation"* (línea 298-300).

Hay un segundo tramo, peor. Las cuentas bancarias sólo se crean desde el sembrador de demostración:

```
$ grep -rn --include='*.ts' "bank_accounts" src/ | grep -i "insert"
src/database/seed.ts:172:    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, ...
```

No hay comando de CLI ni ruta REST que dé de alta una cuenta bancaria. Y el checklist de cierre cuenta cuentas bancarias sin conciliar (`src/services/accounting/period-close.ts:50-67`):

```sql
SELECT COUNT(*) as count FROM bank_accounts ba
 WHERE ba.entity_id = $1 AND ba.is_active = true
 AND NOT EXISTS (SELECT 1 FROM reconciliation_sessions rs WHERE ... )
```

Con cero filas en `bank_accounts`, el `COUNT(*)` da 0, `is_complete` da `true`, y el cierre reporta **"Bank reconciliations complete"**.

Práctica que incumple. Nielsen 1 (visibilidad del estado del sistema): un checklist que dice "completo" porque no hay nada que revisar es la peor forma de invisibilidad. Y en el terreno contable, cualquier despacho que use CONTPAQi Bancos o el módulo de conciliación de Aspel COI da por sentado que el cierre no se firma sin la conciliación; aquí se firma solo.

Escenario. El contador cierra agosto. `mnemosine close --period 2026-08 --check` le lista el checklist y la línea de conciliación bancaria aparece cumplida. Cierra. En octubre el cliente pregunta por qué la 1120 trae 84 mil pesos más que el estado de cuenta: nunca hubo comisiones, ni intereses, ni cheques en tránsito registrados, porque nunca hubo conciliación y nada se lo dijo.

---

### 2. `tax=` significa cosas opuestas en `bill create` y en `invoice create`, y el help de `bill` lo esconde

**Severidad: ALTA · Esfuerzo: S**

Evidencia. Tres familias, tres sintaxis de línea distintas, verificadas contra la ayuda ejecutada:

```
$ npx tsx src/cli/mnemosine.ts entry create --help
  --line <spec...>         a line as
                           <account>:<debit|credit>:<amount>[:description];
                           repeat for each line

$ npx tsx src/cli/mnemosine.ts bill create --help
  --line <spec...>                one line, repeatable:
                                  "account=…,qty=…,quantity=…,price=…,unit-price=…".
                                  Account is a code from the chart

$ npx tsx src/cli/mnemosine.ts invoice create --help
  --line <spec...>         a line:
                           "account=4100;qty=2;price=1500;tax=16;description=…"
```

Separadores: dos puntos, coma, punto y coma. Tres.

Y `tax` no significa lo mismo. En factura de cliente es una **tasa**: `src/cli/invoice-command.ts:484` → `tax_rate: fields.tax ?? fields.tax_rate ?? null`. En factura de proveedor es un **monto**: `src/cli/bill-command.ts:414` → `tax_amount: parsed.tax ?? '0'`. El ejemplo interno de `bill` lo confirma (`bill-command.ts:132`):

```
 * `--line "account=5100,qty=2,price=350.00,tax=112,description=Papelería"`.
```

112 pesos sobre 700 de base: monto, no tasa. Pero **la ayuda que ve el usuario no menciona `tax` en absoluto** — la lista de claves aceptadas está en `bill-command.ts:151` (`['account','qty','quantity','price','unit-price','tax','description','cost-center','project']`) y el texto de `--option` sólo enumera cinco de las nueve.

Práctica que incumple. clig.dev, sección "Help": *"Show examples"* y la regla de que la ayuda documente todos los argumentos aceptados. Y la consistencia interna que hacen bien `git`, `docker` y `kubectl`: un mismo nombre de bandera no cambia de semántica entre subcomandos.

Escenario. El contador captura la factura de papelería por 1,000 más IVA. Como acaba de facturar a un cliente con `--line "...;tax=16"`, teclea `mnemosine bill create Papelería --line "account=5100,qty=1,price=1000,tax=16"`. El sistema registra **16 pesos de IVA acreditable** en vez de 160. La factura cuadra a 1,016 en vez de 1,160, el pago de 1,160 no casa, y el faltante de 144 pesos de IVA acreditable no aparece en ningún lado hasta la declaración.

---

### 3. Timbrado y cancelación de CFDI están fuera: el flujo de facturación no cierra

**Severidad: ALTA · Esfuerzo: L**

Evidencia. Hay adaptadores de cuatro PAC (`src/services/integrations/mexico/pac/`: edicom, finkok, sovos-reachcore, sw-sapien, más `pac-router.ts` y `simulacion.ts`), pero ningún comando los alcanza. La familia `invoice` lo declara en su propia cabecera (`src/cli/invoice-command.ts:46-52`):

```
// WHAT THIS FAMILY DOES NOT DO: it does not stamp, it does not cancel
// before the SAT, and it does not send anything to anyone. An invoice
// created here is a LOCAL document; in Mexico it becomes a CFDI only
// when the fiscal family stamps it with a PAC.
```

Y la familia `rep` lo repite para el complemento de pago (`src/cli/rep-command.ts:32`): *"Emitir y corregir REPs (stamp/correct) siguen fuera: dependen del PAC (§5)"*.

La cancelación tampoco: el endpoint se retiró con el `501` citado arriba, y no hay comando equivalente.

Práctica que incumple. Es la diferencia con CONTPAQi Comercial o Facturama: para un despacho mexicano, "facturar" **es** timbrar. Un sistema que emite un documento local y no lo timbra no facturó.

Escenario. Ver flujo 2 abajo. El contador emite la factura, la contabiliza, y luego tiene que entrar al portal del PAC a timbrarla otra vez a mano, con el riesgo de que el folio, la fecha o el importe no coincidan con lo que ya quedó en el mayor. No hay ningún amarre entre el documento de mnemosine y el CFDI timbrado fuera.

---

### 4. La familia `sat` anuncia "CFDI download" y no la tiene; la e.firma se guarda y nadie la usa

**Severidad: ALTA · Esfuerzo: L**

Evidencia.

```
$ npx tsx src/cli/mnemosine.ts sat --help
Usage: mnemosine sat [options] [command]

SAT services (credentials and CFDI download)

Options:
  -h, --help      display help for command

Commands:
  cred            Fiscal credentials (e.firma)
  help [command]  display help for command
```

"and CFDI download" es una promesa vacía: la única subfamilia es `cred`. Y el envoltorio que debería consumir la credencial no tiene ningún consumidor:

```
$ grep -rn --include='*.ts' "withCredential" src/ | grep -v "fiscal-credentials/service.ts"
src/config/index.ts:151:  // anónimo (no usa e.firma ni PAC, no pasa por withCredential): el bloqueo
src/services/sat/cfdi-status.ts:11:// la e.firma, no pasa por withCredential y no consume cupo de credencial
```

Las dos únicas menciones son comentarios que explican por qué **no** se usa. Cero llamadas reales. El único servicio SAT que existe es `cfdi-status.ts`, que consulta el `ConsultaCFDIService` público y no requiere e.firma.

Práctica que incumple. clig.dev: la ayuda no debe describir capacidades que no existen. Y aquí el costo es de confianza: se le pide a un cliente su e.firma —la llave de su identidad fiscal— con un texto de consentimiento formal, y no se hace nada con ella.

Escenario. El despacho sigue el flujo: `mnemosine sat cred add --cer ... --key ... --live`, mete la contraseña, firma el consentimiento. Después busca cómo bajar los CFDI del mes y descubre que `sat` no tiene más que `cred`. Sigue bajando el ZIP del portal del SAT a mano, y ahora además tiene la e.firma de su cliente guardada en un sistema que no la ocupa.

---

### 5. La contabilidad electrónica (Anexo 24) y la DIOT no se generan

**Severidad: ALTA · Esfuerzo: L**

Evidencia. Hay tres piezas que preparan el terreno y ninguna que produzca el XML:

- `mnemosine account map check` se describe como *"Coverage gate before the Anexo 24 catalog XML"* (`src/cli/account-command.ts:602`).
- `mnemosine ledger auxiliary show` se describe como *"Account auxiliary: beginning balance, movements, ending — the SAT XC shape"*.
- `src/services/reporting/report-service.ts:908` comenta: *"La forma que pide el XML XC del SAT (Anexo 24): por cuenta y..."*.

Pero la búsqueda de generación de XML no encuentra nada:

```
$ grep -rn --include='*.ts' -i "anexo 24|anexo24|catalogocuentas|BalanzaComprobacion|contabilidad electr" src/
src/cli/account-command.ts:488:    .description('Statutory mappings per account: SAT agrupador (Anexo 24), US tax line, IFRS');
src/cli/account-command.ts:602:    .description('Coverage gate before the Anexo 24 catalog XML: which top accounts still lack a mapping');
src/services/accounting/account-service.ts:442:// del Anexo 24). Esquemas sin columna (fs-line, cash-flow,
src/services/accounting/account-service.ts:553: * compuerta previa al XML de catálogo del Anexo 24.
src/services/reporting/report-service.ts:908:// La forma que pide el XML XC del SAT (Anexo 24): por cuenta y
```

Cinco menciones, todas descriptivas. Cero generadores. La DIOT igual: sólo aparece como motivo de la lista de proveedores sin RFC (`src/cli/vendor-command.ts:131`, `vendor-service.ts:227`), nunca como salida.

Práctica que incumple. Es una obligación mensual del artículo 28 del CFF y la regla 2.8.1.6 de la RMF. CONTPAQi Contabilidad y Aspel COI la generan con un botón; es literalmente la razón por la que un despacho compra el sistema.

Escenario. El contador termina el cierre, saca la balanza, y busca cómo generar el XML de balanza para el SAT. No está. Tiene que exportar a CSV, importarlo a CONTPAQi o a un generador aparte, y volver a mapear el agrupador que ya mapeó aquí con `account map import`.

---

### 6. El PPD/PUE de una factura capturada a mano sólo se declara escribiendo la palabra dentro de un campo de texto libre

**Severidad: ALTA · Esfuerzo: M**

Evidencia. La resolución del método de pago tiene cuatro fuentes en orden (`src/services/accounting/iva-cash-basis.ts:131-145`):

```
const fromDocument = parseMetodoPago(signals.documentMetodoPago);
if (fromDocument) return { metodo: fromDocument, origin: 'document', assumed: false };
const fromCfdi = parseMetodoPago(signals.cfdiMetodoPago);
if (fromCfdi) return { metodo: fromCfdi, origin: 'cfdi', assumed: false };
const fromText = metodoPagoFromText(signals.terms) ?? metodoPagoFromText(signals.memo);
if (fromText) return { metodo: fromText, origin: 'terms', assumed: false };
return { metodo: CONSERVATIVE_METODO[side], origin: 'default', assumed: true };
```

La primera fuente todavía no existe. Línea 118-121:

```
   * A MetodoPago on the document row. Reserved for the `cfdi_metodo_pago`
   * column the schema lane still owns — see the migration spec in the
   * lane report.
```

La segunda sólo existe si hay un CFDI detrás. Para una factura tecleada a mano queda la tercera: el literal `PPD` o `PUE` dentro de `--terms` o `--memo`. Y ninguna de las dos banderas lo menciona:

```
$ npx tsx src/cli/mnemosine.ts bill create --help
  --terms <text>                  payment terms recorded on the bill; defaults
                                  to the vendor terms
```

No hay `--metodo-pago` ni en `bill create` ni en `invoice create` (verificado en las ayudas completas de ambos).

Práctica que incumple. Nielsen 6 (reconocer antes que recordar): un dato fiscal determinante no puede depender de que el usuario recuerde una palabra mágica que ninguna ayuda menciona. Es exactamente el campo que CONTPAQi pone como catálogo desplegable obligatorio.

Escenario. El contador captura una factura de proveedor a 30 días con `--terms "30 días"`. El sistema no encuentra ni PPD ni PUE, cae al default conservador (`received → PPD`) y aparca el IVA en la 1135. Es la decisión correcta, y el asiento lleva la nota `MetodoPago missing: PPD assumed`. Pero si la factura era PUE, el IVA acreditable de ese mes no se acredita y nadie lo nota hasta que se compara la declaración con el papel de trabajo. La autocorrección al pagar (que sí existe) sólo lo arregla cuando el dinero se mueve.

---

### 7. `review` es una cola FIFO interactiva sin filtro, sin id, y cualquier tecla distinta de a/r/q salta el borrador en silencio

**Severidad: ALTA · Esfuerzo: M**

Evidencia. `src/cli/mnemosine.ts:1095-1137`:

```
for (let i = 0; i < pending.length; i++) {
  renderDraft(pending[i], i, pending.length);
  const raw = await ask(rl, c.cyan('\n[a]pprove and post  [r]eject  [s]kip  [q]uit > '));
  ...
  // 's' or anything else: skip
}
```

La cola es `listDrafts(ctx, 'pending_review')` completa, sin paginar, sin filtrar. La ayuda confirma que no hay selector:

```
$ npx tsx src/cli/mnemosine.ts review --help
Usage: mnemosine review|revisar [options]

Options:
  -e, --entity <idOrName>  Legal entity (id, RFC or name fragment)
  -u, --user <email>       Reviewer email (default: first active user of the tenant)
  --dry-run                ...
  -y, --yes                skip the confirmation prompt
  --idempotency-key <key>  ...
```

No hay `--draft <id>`, ni `--since`, ni `--min-amount`, ni `--vendor`. `mnemosine drafts -s pending_review` sí lista con filtro, pero de ahí no hay puente: no existe `draft approve <id>`. La única forma de aprobar el borrador número 47 es teclear `s` cuarenta y seis veces.

Práctica que incumple. clig.dev, "Prefer flags to args" y "Make it scriptable": todo lo que se puede hacer interactivamente debería poderse hacer en un comando. Y Nielsen 5 (prevención de errores): un Enter accidental o una `y` (por "yes") no aprueba ni rechaza, salta en silencio y el borrador queda pendiente sin que el usuario sepa que lo pasó de largo.

Escenario. El despacho ingiere 380 CFDI de un cliente. `mnemosine review` abre una cola de 380. El contador revisa 60, se equivoca al teclear en el 61 (aprieta Enter), el borrador se salta sin decir nada, sigue hasta el 90 y se sale con `q`. Al día siguiente vuelve a `review` y la cola arranca otra vez desde el principio, sin marca de por dónde iba.

---

### 8. Las reglas de procesamiento —la capa 1 de la ingesta— sólo se administran por HTTP

**Severidad: ALTA · Esfuerzo: M**

Evidencia. La ingesta compone tres capas y la primera manda (`src/ai/ingest-service.ts:26-33`):

```
// Composition of three layers, in order of confidence:
//   1. Deterministic rules (existing pipeline: dedupe, vendor
//      match, rules engine — if a rule auto-processes, it wins).
```

Las reglas viven en `processing_rules` (`src/services/xml-ingestion/pre-registration-service.ts:386-390`). Sus escritores:

```
$ grep -rn --include='*.ts' --include='*.sql' "processing_rules" src/
src/database/migrations/005_xml_ingestion.sql:263:CREATE TABLE processing_rules (
src/api/rest/routes/xml-ingestion.ts:512:  `SELECT * FROM processing_rules ${where} ORDER BY priority ASC, created_at DESC`,
src/api/rest/routes/xml-ingestion.ts:528:  `INSERT INTO processing_rules (
src/api/rest/routes/xml-ingestion.ts:567:  `UPDATE processing_rules SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
src/api/rest/routes/xml-ingestion.ts:580:  const result = await query('DELETE FROM processing_rules WHERE id = $1', [req.params.id]);
$ grep -rn --include='*.ts' -il "rules-engine" src/cli/ src/api/
(sin resultados en src/cli/)
```

CRUD completo por REST, cero comandos.

Práctica que incumple. La tesis del producto —"un sistema contable que se opera desde la terminal"— no admite que la capa que decide qué se contabiliza solo se configure con `curl`. Es la misma superficie que Contalink expone como "reglas de asignación" en su UI y que Aspel resuelve con la póliza modelo.

Escenario. El despacho quiere que todo CFDI de CFE se codifique automáticamente a 5140 sin pasar por la IA. No hay comando. O escribe la regla con `curl` contra la API, o la mete por SQL, o paga tokens por 12 recibos de luz al año que un `if` resolvería.

---

### 9. `entry import` es una puerta de un solo sentido: deja el lote en dos tablas y no hay comando para aplicarlo

**Severidad: ALTA · Esfuerzo: M**

Evidencia. El propio comando lo dice al terminar (`src/cli/entry-command.ts:753-755`):

```
process.stderr.write(deps.palette.dim(
  'El lote NO tocó el mayor: se valida y aplica con la familia batch (check/post) cuando llegue; mientras, es inspeccionable por batch_id.\n'
));
```

"cuando llegue". Y el comentario de la línea 711 lo confirma: *"aplicarlo será un acto humano de la familia batch, con sus compuertas"*. La familia `batch` no existe en el árbol de comandos (volcado completo verificado). Las filas quedan en `journal_entry_import_batches` y `journal_entry_import_rows` (`src/services/accounting/entry-import-service.ts:142,153`), que no son `journal_entries`, así que "inspeccionable por batch_id" significa por SQL.

Práctica que incumple. clig.dev: no dejes al usuario en un estado del que no pueda salir con la misma herramienta. Y contablemente: la migración de pólizas históricas es *el* trabajo de alta de un cliente nuevo.

Escenario. El contador migra 2025 completo: `mnemosine entry import polizas-2025.csv`. Sale `✔ lote 8f3a...: 1,847 póliza(s) preparadas, 12 con error`. Ahora tiene 1,847 pólizas en una tabla de escenificación, ninguna en el mayor, ningún comando para verlas y ninguno para aplicarlas.

---

### 10. `period reopen` no tiene comando, y el propio código lo dice

**Severidad: MEDIA · Esfuerzo: S**

Evidencia. El servicio existe, completo y bien razonado (`src/services/accounting/fiscal-calendar-service.ts:216-274`), con tres cerrojos: `locked` no se reabre nunca, exige motivo, y devuelve el estado anterior. Pero:

```
$ grep -rn --include='*.ts' "reopenClosedPeriod" src/ | grep -v "fiscal-calendar-service.ts"
src/auth/roles.ts:59:  'periods:reopen': 'reopenClosedPeriod existe pero sólo lo invoca el backfill de IVA; falta su ruta y su comando.',
src/services/accounting/iva-ppd-reclass.ts:209:  const r = await reopenClosedPeriod(h.entity_id, h.period_id, actorUserId, motivo);
```

El permiso `periods:reopen` está en la lista de RESERVADOS con esa nota literal. La familia `period` tiene `list`, `show` y `open` (sólo futuro → abierto); `period open` se niega explícitamente a reabrir cerrados (`fiscal-calendar-service.ts:195-197`).

Práctica que incumple. La reapertura auditada de un periodo es funcionalidad estándar en NetSuite, SAP y CONTPAQi, precisamente porque hay correcciones que pertenecen al mes del hecho. Aquí el álgebra está resuelta y falta el cable.

Escenario. En octubre se descubre que un IVA de marzo se acreditó mal. Marzo está en `soft_close`. La corrección pertenece a marzo. No hay comando para reabrirlo, así que se registra en octubre, y el papel de trabajo de IVA de marzo deja de cuadrar con el mayor de marzo para siempre.

---

### 11. Dos mensajes distintos para "no hay periodo abierto": el bueno está en el camino que menos se usa

**Severidad: MEDIA · Esfuerzo: S**

Evidencia. `src/services/accounting/journal-entry-service.ts:425-429` (camino de `entry create`):

```
throw new ValidationError(
  `No open fiscal period covers ${input.date}. Open it with \`mnemosine period open\`, ` +
    'or create the fiscal year with `mnemosine year create`.'
);
```

`src/services/accounting/posting.ts:102-107` (camino de `bill approve`, `invoice issue`, `payment create`, `receipt record`, vía `ar-ap-posting.ts`):

```
throw new AccountingError(
  ErrorCodes.PERIOD_CLOSED,
  'No open fiscal period found for the entry date'
);
```

Sin remedio, sin la fecha, y con el código `PERIOD_CLOSED` cuando la causa más probable en un alta nueva es que el ejercicio nunca se creó — no que esté cerrado.

Práctica que incumple. Nielsen 9 y clig.dev "Actionable error messages". El primer mensaje es el modelo; el segundo es el que ven los cuatro comandos de operación diaria.

Escenario. Cliente nuevo, alta terminada, primera factura de proveedor. `mnemosine bill approve F-001` responde *"No open fiscal period found for the entry date"* y sale. El contador no sabe si el problema es la fecha de la factura, un periodo cerrado, o algo más. El comando que lo arregla —`mnemosine year create 2026`— no se menciona.

---

### 12. `entity create` no crea el ejercicio y sólo sugiere un paso siguiente

**Severidad: MEDIA · Esfuerzo: S**

Evidencia. `createEntity` llama a `ensureEntityAccounting` (`src/services/entity/entity-service.ts:234-237`), que siembra catálogo base, roles semánticos y mapeo de nómina (`src/services/accounting/entity-accounting.ts:58-83`). No hay ninguna llamada a creación de ejercicio o periodos. Y la salida del comando (`src/cli/entity-command.ts:241-260`) termina con una sola pista:

```
process.stderr.write(p.dim(`  pin it with: mnemosine entity use ${result.taxId}\n`));
```

Nada sobre `year create`, que es prerrequisito duro de cualquier posteo (brecha 11).

Práctica que incumple. clig.dev, "Suggest the next command": un comando de alta debería enumerar lo que falta. `gh repo create` y `stripe login` lo hacen.

Escenario. El de la brecha 11: el contador da de alta la entidad, ve el ✔ verde con las cuentas sembradas, la fija, y se estrella en el primer posteo con un error que no nombra la causa.

---

### 13. La validación local corre después de la conexión a base

**Severidad: MEDIA · Esfuerzo: M**

Evidencia. Dos casos reproducidos.

Proveedor inexistente en `onboard` (el registro sólo conoce `contalink`, `src/services/integrations/accounting/registry.ts:11`):

```
$ npx tsx src/cli/mnemosine.ts onboard --dry-run -p contpaqi --cutoff 2025-12-31
role "mnemo" does not exist
$ echo $?
1
```

Ruta de archivo inexistente en `ingest`:

```
$ npx tsx src/cli/mnemosine.ts ingest /tmp/no-existe.xml --dry-run

role "postgres" does not exist
$ echo $?
1
```

En `ingest` el orden está a la vista (`src/cli/mnemosine.ts:1181-1201`): primero `resolveEntity(opts.entity)` (base), luego `resolverUmbralesConPanel` (base), y sólo al final `previewCfdiFiles` toca los archivos.

Práctica que incumple. clig.dev, "Validate user input as early as possible" — y la convención POSIX de que un error de uso (código 2) se detecta antes de hacer trabajo. Aquí un error de tecleo se disfraza de caída de infraestructura.

Escenario. El contador escribe `mnemosine ingest ./xmls/*.xml` en una carpeta que se llama `xml`. El shell no expande nada, pasa el literal, y el sistema responde `role "postgres" does not exist`. Va a revisar la base de datos, que está perfecta.

---

### 14. Un error de tecleo en la familia se atribuye a `chat`, sin sugerencia; en el subcomando sí hay sugerencia

**Severidad: MEDIA · Esfuerzo: S**

Evidencia.

```
$ npx tsx src/cli/mnemosine.ts factuar
error: too many arguments for 'chat'. Expected 0 arguments but got 1: factuar.
$ echo $?
1

$ npx tsx src/cli/mnemosine.ts entity lst
error: unknown command 'lst'
(Did you mean list?)
$ echo $?
1
```

Dos niveles del mismo árbol, dos comportamientos. El primero ocurre porque `chat` es el comando por omisión y Commander le entrega cualquier argumento suelto; el segundo usa el `did you mean` de Commander, que funciona bien.

Práctica que incumple. Nielsen 9 otra vez, y la consistencia interna (Nielsen 4). `git`, `docker` y `kubectl` sugieren en todos los niveles.

Escenario. El contador escribe `mnemosine factuar` (que existe como alias de `invoice`… no: el alias es `factura`). Recibe un error que menciona un comando `chat` que él nunca escribió y que no le dice que existe `factura`. La palabra correcta está a una letra de distancia y el sistema no la ofrece.

---

### 15. `repairCommandFor` existe, hace exactamente lo que falta, y sólo se llama en el arranque roto

**Severidad: MEDIA · Esfuerzo: S**

Evidencia. La función está escrita y mapea causas a remedios (`src/cli/mnemosine.ts:398-408`):

```
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

Sus llamadores:

```
$ grep -rn --include='*.ts' "repairCommandFor" src/
src/cli/mnemosine.ts:398:export function repairCommandFor(reason: string): string {
src/cli/mnemosine.ts:463:    stderr.write(`      → ${repairCommandFor('')}\n`);
src/cli/mnemosine.ts:467:    stderr.write(`      → ${repairCommandFor(reason)}\n`);
```

Los dos están dentro de `renderBrokenFlow`, que sólo corre en el arranque de `chat`. Ningún subcomando lo usa. Por eso la salida cruda:

```
$ npx tsx src/cli/mnemosine.ts entity list

role "postgres" does not exist
```

Su primera regex (`/databas|...|postgres|.../`) casa perfectamente con ese texto y devolvería `mnemosine doctor   (and check DATABASE_URL in .env)`. Está a una llamada de distancia.

Práctica que incumple. Esta es la que hace más daño por unidad de esfuerzo: el remedio existe, funciona, y no se conecta. Y confirma en profundidad lo que el orquestador ya había visto (ningún error remite a `doctor`): no es que falte la capacidad, es que falta el cable.

Escenario. Ver brecha 13. El contador no llega nunca a `doctor` porque nada se lo dice, y `doctor` es el único comando que le habría explicado el problema y dado el `docker compose up -d postgres` que lo arregla.

---

### 16. El error de la selección de entidad se imprime dos veces y misdiagnostica, y afecta a casi todas las familias

**Severidad: MEDIA · Esfuerzo: S**

Evidencia. Medí el alcance, que era lo que faltaba al hallazgo del orquestador. Todas las familias que pasan por `resolveActiveEntity` con una entidad fijada reproducen el patrón:

```
$ npx tsx src/cli/mnemosine.ts cfdi list
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "postgres" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "postgres" does not exist

$ npx tsx src/cli/mnemosine.ts report trial-balance show
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "postgres" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "postgres" does not exist

$ npx tsx src/cli/mnemosine.ts bill list
Could not resolve the active entity (1ddac7ab-1f0d-42a2-8e21-6387fd1789bb): role "postgres" does not exist
The selection was kept. Use `mnemosine entity use <id|name>` to change it, or `mnemosine entity unset` to clear it.

role "postgres" does not exist
```

Y las familias que no dependen de la selección fijada (`entity list`, `close --list`, `account list`) dan sólo la línea cruda, precedida de una línea en blanco:

```
$ npx tsx src/cli/mnemosine.ts account list

role "postgres" does not exist
```

Es decir: el patrón cubre las dos mitades del CLI y ninguna de las dos versiones nombra la causa real ni el remedio. El envoltorio además presenta una caída de conexión como problema de selección, y los dos comandos que sugiere (`entity use`, `entity unset`) fallarían igual.

Práctica que incumple. clig.dev: *"Don't print the same error twice"*, y no atribuyas un fallo de infraestructura a una capa que no lo causó.

Escenario. Ver brecha 15. El contador ejecuta los dos comandos que le sugieren, ambos fallan con el mismo error, y concluye que el sistema está roto sin remedio.

---

### 17. El idioma: los alias en español funcionan, pero la ayuda los reescribe en inglés, y hay tres vocabularios mezclados

**Severidad: MEDIA · Esfuerzo: M**

Evidencia. Profundicé el hallazgo del orquestador con cuatro casos verificados que van más allá de la descripción de `ai|ia`.

**(a) El `Usage` devuelve la forma inglesa.** El contador teclea en español y la ayuda le enseña inglés:

```
$ npx tsx src/cli/mnemosine.ts reporte balanza ver --help
Usage: mnemosine report trial-balance show|ver [options]

$ npx tsx src/cli/mnemosine.ts poliza contabilizar --help
Usage: mnemosine entry post|contabilizar [options] <number>

$ npx tsx src/cli/mnemosine.ts factura-proveedor aprobar --help
Usage: mnemosine bill approve|aprobar [options] <bill>
```

**(b) La misma bandera habla dos idiomas con valores incompatibles.**

```
$ npx tsx src/cli/mnemosine.ts cfdi list --help | grep direction
  --direction <d>    emitido, recibido o ajeno (derivada contra el RFC de la entidad)

$ npx tsx src/cli/mnemosine.ts rep missing list --help | grep direction
  --direction <d>    received (default) or issued (default: "received")
```

Y el validador confirma que `cfdi` rechaza los valores ingleses (`src/services/xml-ingestion/cfdi-query-service.ts:53-55`):

```
if (f.direction && !['emitido', 'recibido', 'ajeno'].includes(f.direction)) {
  throw new ValidationError(`--direction ilegible "${f.direction}": emitido, recibido o ajeno.`);
}
```

**(c) Valores de bandera en español dentro de ayuda inglesa.**

```
$ npx tsx src/cli/mnemosine.ts entity create --help | grep -A1 chart
  --chart <strategy>       auto | siempre | nunca — whether to seed the base
                           chart (default: "auto")
```

**(d) Ayuda de argumento y salida de ejecución en español.** `src/cli/account-command.ts:552`:

```
.argument('<file>', 'CSV: code,valor (una cuenta por línea; separador coma o punto y coma)')
```

`src/cli/entry-command.ts:754`, que es salida en tiempo de ejecución, no ayuda:

```
'El lote NO tocó el mayor: se valida y aplica con la familia batch (check/post) cuando llegue; mientras, es inspeccionable por batch_id.\n'
```

Práctica que incumple. Nielsen 2 ("match between system and the real world") y Nielsen 4 (consistencia). El producto declara en `lang` que *"CLI UI stays English"*, pero la UI no es inglesa: es inglesa con cuatro tipos de fuga al español, en cuatro capas distintas (Usage, valores de bandera, ayuda de argumento, salida de ejecución). Es peor que cualquiera de los dos idiomas puros.

Escenario. El contador aprende `mnemosine factura-proveedor aprobar`. Pide ayuda y el sistema le contesta `Usage: mnemosine bill approve|aprobar`. Se pregunta si escribió mal. Después usa `--direction recibido` en `cfdi list`, funciona, lo repite en `rep missing list` y falla.

---

### 18. Los asientos de cierre anual se saltan en silencio si faltan las cuentas 3900 o 3200

**Severidad: MEDIA · Esfuerzo: S**

Evidencia. `src/services/accounting/period-close.ts:429-441`:

```
const systemAccounts = await client.query<{ id: string; code: string }>(
  `SELECT id, code FROM accounts
   WHERE entity_id = $1 AND is_system_account = true
   AND code IN ('3900', '3200')`,
  [entityId]
);

const incomeSummaryId = systemAccounts.rows.find((a) => a.code === '3900')?.id;
const retainedEarningsId = systemAccounts.rows.find((a) => a.code === '3200')?.id;
if (!incomeSummaryId || !retainedEarningsId) return []; // System accounts not set up
```

`return []` sin excepción, sin aviso, sin renglón de auditoría. El catálogo sembrado sí las trae marcadas como `system: true` (`src/services/accounting/chart-seed.ts:54,56`), así que en el camino feliz funciona. Pero `entity create --chart nunca` y el catálogo importado por `onboard` no las garantizan.

Práctica que incumple. La regla que el propio proyecto aplica bien en otros sitios: un acto que no se ejecuta tiene que decirlo. Aquí `hardClosePeriod` reporta éxito habiendo omitido su parte más importante.

Escenario. Un cliente se migra desde CONTPAQi con su catálogo propio, cuyas cuentas de capital no son 3200/3900. En diciembre el contador ejecuta `mnemosine close --period 2026-12 --hard --reason "cierre del ejercicio"`. El comando responde bien. Ningún asiento de cierre se generó: los resultados no se traspasaron a capital, y el balance de enero arrastra ingresos y gastos del año anterior.

---

### 19. La bitácora de auditoría no se lee desde la terminal

**Severidad: MEDIA · Esfuerzo: M**

Evidencia. El propio catálogo de permisos lo declara (`src/auth/roles.ts:64`):

```
'audit:read': 'la bitácora no tiene ruta de consulta; hoy se lee por SQL.',
```

`registrarAuditoria` se llama desde todo el sistema (cierre, reapertura, archivado de entidad, credenciales…), y el único lector es `mnemosine sat cred audit`, que sólo cubre accesos a la e.firma. No hay `mnemosine audit list`.

Práctica que incumple. Para un despacho, la bitácora **es** el producto: es lo que se enseña en una revisión. Y el sistema entero está construido sobre la premisa de que la IA propone y la persona dispone; el registro de quién dispuso qué no es opcional.

Escenario. En una revisión preguntan quién cerró marzo y por qué. El dato está en `audit_log` con el motivo y el estado anterior. Para verlo hay que abrir `psql`.

---

### 20. Cero ejemplos en las 179 entradas del árbol de comandos

**Severidad: MEDIA · Esfuerzo: M**

Evidencia.

```
$ grep -rn --include='*.ts' 'addHelpText' src/cli/ | wc -l
0
$ npx tsx /tmp/dumpcmds.ts | grep -c "^[a-z]"
179
```

Confirmo y amplío el conteo del orquestador: son 179 entradas en el árbol (familias y comandos ejecutables), ninguna con `addHelpText`. Los únicos ejemplos que existen están **dentro** de la descripción de una bandera (`invoice create --line`, `bill create --line`) y son precisamente los que se contradicen entre sí (brecha 2).

Práctica que incumple. clig.dev es tajante: *"Show, don't tell. Examples are the best documentation."* `git`, `gh`, `stripe`, `aws` y `docker` cierran cada `--help` con un bloque de ejemplos. Es lo primero que mira alguien que no vive en la terminal, que es exactamente el usuario declarado de este producto.

Escenario. El contador ejecuta `mnemosine entry create --help`, lee `--line <spec...> a line as <account>:<debit|credit>:<amount>[:description]` y tiene que adivinar si el importe lleva coma de miles, si la descripción va entre comillas, y qué pasa si trae dos puntos.

---

### 21. Asimetrías menores que un manual tiene que documentar como excepciones

**Severidad: BAJA · Esfuerzo: M**

Evidencia, en tres pares verificados contra la ayuda ejecutada.

**(a) `vendor create` toma posicional, `customer create` no.**

```
$ npx tsx src/cli/mnemosine.ts vendor create --help
Usage: mnemosine vendor create|crear [options] <name>
Arguments:
  name                      company name

$ npx tsx src/cli/mnemosine.ts customer create --help
Usage: mnemosine customer create|crear [options]
```

El cliente se da de alta con `--name`, el proveedor con un argumento. Mismo verbo, misma familia conceptual.

**(b) Sin `edit` ni `void` en facturas de proveedor.** Del volcado del árbol: `bill` tiene `list`, `show`, `create`, `line set`, `approve`. No hay `bill edit`, `bill void` ni `bill cancel`. `invoice` tiene `void` pero no `edit`. Una factura de proveedor aprobada con el importe mal sólo se corrige reversando su asiento (`entry reverse`), y la fila de `bills` queda con el importe malo.

**(c) `invoice series` sólo lista.** No hay `series create` ni `series set`: los folios salen de `listEntitySequences` (`src/cli/invoice-command.ts:711`), un contador por tipo de documento. No se puede definir una serie A/B como en CONTPAQi. Coherente mientras no haya timbrado (brecha 3), pero hay que decirlo.

Escenario. El contador aprueba una factura de proveedor de 11,600 que eran 1,160. La única salida es `mnemosine entry reverse <numero> --reason "..."` y capturar otra. Quedan tres asientos y dos facturas en el sistema para un solo documento.

---

## LOS SIETE FLUJOS, TAL COMO SON HOY

Cada bloque es la secuencia real. `⛔` marca un paso que **hoy no se puede dar** desde la terminal, con su sustituto.

---

### Flujo 1 · De un CFDI recibido a un asiento contabilizado

```bash
⛔  # PASO 0: obtener los XML. No existe descarga masiva (brecha 4).
    # Sustituto: bajar el ZIP del portal del SAT a mano y descomprimirlo.

mnemosine entity use ACO850101AB1

mnemosine ingest ./cfdis/*.xml --dry-run
    # Sólo la capa determinista. No escribe, no llama al SAT ni al modelo.

mnemosine ingest ./cfdis/*.xml
    # Capa 1: reglas de processing_rules → crea bill + asiento si una regla lo cubre.
    # Capa 2: la IA clasifica el resto y crea BORRADORES.
    # Capa 3: umbrales de auto-posteo (apagados por omisión; --auto-post los enciende).

mnemosine question list
mnemosine question answer <id> "<respuesta>"
    # Lo que respondas queda como precedente del despacho.

mnemosine drafts -s pending_review
mnemosine review
    # Cola FIFO interactiva: [a]pprove / [r]eject / [s]kip / [q]uit.
    # 'a' crea Y postea el asiento en un solo acto.

mnemosine cfdi explain <uuid>      # caso, hechos y decisiones del clasificador
mnemosine entry show <numero>
mnemosine cfdi status sync --live  # re-consulta el estado ante el SAT
```

**Dónde se rompe.**
1. El paso 0 no existe (brecha 4).
2. Las reglas de la capa 1 no se administran desde la terminal (brecha 8). Sin reglas, todo pasa por la IA y cuesta tokens.
3. Si el auto-proceso determinista falla, el fallo se traga: `src/services/xml-ingestion/pre-registration-service.ts:194` hace `console.error('Auto-processing failed:', err)` y sigue. La ingesta reporta éxito y no hay ni bill ni asiento.
4. `review` no tiene selector (brecha 7).
5. Un CFDI tipo I se mapea a `document_type = 'bill'` sin mirar la dirección (`pre-registration-service.ts:29-33`). Sólo muerde si una regla del despacho pone el pre-registro en modo `auto`; la capa de IA sí distingue emitido de recibido (`cfdi-classifier.ts:126,143`). Lo anoto como riesgo condicionado, no como fallo verificado.

---

### Flujo 2 · Facturar a un cliente y cobrarle (con REP cuando es PPD)

```bash
mnemosine customer create --name "Comercializadora del Norte SA de CV" \
  --tax-id CNO120315QX8 --tax-id-type RFC --terms "Net 30" --currency MXN

mnemosine invoice create --customer "Comercializadora del Norte" \
  --line "account=4100;qty=1;price=10000;tax=16;description=Servicios agosto" \
  --date 2026-08-31 --terms "Net 30"
    # ATENCIÓN: separador PUNTO Y COMA, y tax=16 es la TASA (brecha 2).

mnemosine invoice show <ref>
mnemosine invoice issue <ref>
    # Postea DR cxc / CR ingreso / CR el rol de IVA que decida el MetodoPago.
    # PUE → iva_trasladado. PPD → iva_trasladado_no_cobrado (2125).
    # Sin bandera --metodo-pago: se decide por el texto de --terms/--memo (brecha 6).

⛔  # TIMBRAR. No existe (brecha 3).
    # Sustituto: timbrar en el portal del PAC, a mano, con los mismos datos.

mnemosine receipt record <invoice> --amount 11600 --date 2026-09-15 --method spei
    # Registra el cobro Y reclasifica el IVA de 2125 a iva_trasladado.

⛔  # EMITIR EL REP. No existe (brecha 3, rep-command.ts:32).
    # Sustituto: emitirlo en el PAC. Obligación fiscal propia, con plazo.

mnemosine rep missing list --direction issued
    # Lista los cobros sin REP emitido. Ojo: aquí el valor es INGLÉS (brecha 17).

⛔  # CANCELAR ANTE EL SAT. No existe (brecha 3).
mnemosine invoice void <ref> --reason "..."
    # Sólo anula el documento local y reversa su asiento.
    # Se NIEGA si está timbrada o pagada.
    # Sustituto para una timbrada: cancelar en el PAC y después
    #   mnemosine entry reverse <numero> --reason "CFDI cancelado, acuse <folio>"
```

**Dónde se rompe.** Los tres actos fiscales del flujo —timbrar, emitir el REP, cancelar— están fuera. Lo que sí funciona, y funciona bien, es la mitad contable: el reconocimiento del IVA al cobrar está construido con cuidado (acreditación 4 del apartado anterior).

---

### Flujo 3 · Capturar una factura de proveedor y pagarla

```bash
mnemosine vendor create "Papelería del Centro SA de CV" \
  --tax-id PCE010101AB1 --tax-id-type RFC --terms "Net 30" \
  --currency MXN --default-account 5100
    # El proveedor SÍ toma posicional; el cliente no (brecha 21a).

mnemosine bill create "Papelería del Centro" \
  --vendor-invoice-number A-1234 --bill-date 2026-08-10 \
  --line "account=5100,qty=1,price=1000,tax=160,description=Papelería agosto" \
  --terms "Net 30 PPD"
    # ATENCIÓN 1: separador COMA (no punto y coma).
    # ATENCIÓN 2: tax=160 es el MONTO del IVA, no la tasa. El --help NO lo dice (brecha 2).
    # ATENCIÓN 3: "PPD" dentro de --terms es la ÚNICA forma de declarar el
    #             método de pago en una captura manual (brecha 6).

mnemosine bill show <bill> --no-lines
mnemosine bill line set <bill> --line 1 --account 5110   # recodificar antes de aprobar

mnemosine bill approve <bill>
    # Reconoce el pasivo: DR gasto + DR el rol de IVA que toque / CR cxp.
    # PPD → iva_pendiente_acreditar (1135). PUE → iva_acreditable.

mnemosine payment create <bill> --amount 1160 --date 2026-09-09 --method spei
    # Registra que el dinero YA salió. mnemosine no paga: no habla con ningún banco.
    # Reclasifica el IVA de 1135 a iva_acreditable.
    # --bank <account> exige un id de bank_accounts, tabla sin comando de alta (brecha 1).
    # Sin --bank usa el rol `banco` de la entidad, que sí funciona.

mnemosine rep missing list --direction received
    # Pagos PPD sin el REP del proveedor: su IVA sigue aparcado en 1135.

mnemosine rep reconcile
    # Reintenta los REP que llegaron y quedaron en needs_review. Repetible.
```

**Dónde se rompe.**
1. `tax=` (brecha 2) y PPD/PUE por texto libre (brecha 6) — los dos en el mismo comando.
2. `--bank` es inutilizable sin SQL (brecha 1).
3. No hay programación de pagos, y el sistema lo dice bien (`src/api/rest/routes/bills.ts:150-156`): *"mnemosine does not schedule payments: it has no payment scheduler and no connection to your bank"*.
4. Una factura aprobada mal sólo se arregla reversando el asiento (brecha 21b).

---

### Flujo 4 · Conciliar el banco

```bash
⛔  # EL FLUJO COMPLETO NO EXISTE EN LA TERMINAL.
```

No hay familia `bank`, `banco` ni `conciliacion` (brecha 1). Lo que existe y dónde:

| Paso | Estado | Dónde |
|---|---|---|
| Dar de alta la cuenta bancaria | **No existe** en CLI ni en REST | sólo `src/database/seed.ts:172` |
| Importar el estado de cuenta | Existe, sólo REST | `POST /:account_id/import` |
| Ver movimientos sin casar | Existe, sólo REST | `GET /:account_id/transactions/unmatched` |
| Sugerencias de coincidencia | Existe, sólo REST | `GET /transactions/:id/suggestions` |
| Casar un movimiento | Existe, sólo REST | `POST /transactions/:id/match` |
| Auto-casar | Existe, sólo REST | `POST /:account_id/auto-match` |
| **Cerrar la conciliación** | **501 deliberado** | `bank-reconciliation.ts:303` |

**Sustituto mientras tanto**, que es el que el propio `501` recomienda: conciliar fuera de mnemosine, y registrar los hallazgos como pólizas manuales.

```bash
mnemosine entry create --date 2026-08-31 --type adjusting \
  --description "Comisiones bancarias agosto" \
  --line "5910:debit:850.00:Comisión manejo de cuenta" \
  --line "1120:credit:850.00:Cargo BBVA 31/08"
    # ATENCIÓN: aquí el separador es DOS PUNTOS y el formato es
    #           <cuenta>:<debit|credit>:<importe>[:descripción] (brecha 2).

mnemosine entry check --entry <numero>   # las siete reglas NIF, sin escribir
mnemosine entry preview <numero>         # el delta exacto de saldos
mnemosine entry post <numero>
```

Y hay que saber que el checklist de cierre **no** va a avisar de nada (brecha 1).

---

### Flujo 5 · Cerrar el mes

```bash
mnemosine close --list                          # periodos cerrables
mnemosine close --period 2026-08 --check        # sólo el checklist, nunca cierra

# Los cinco bloqueos y avisos que evalúa (period-close.ts:36-183):
#   1. Pólizas en borrador o pendientes de aprobación  → BLOQUEA
#   2. Conciliaciones bancarias                        → avisa (y da falso verde, brecha 1)
#   3. Facturas de cliente en borrador                 → avisa
#   4. Depreciación del periodo                        → avisa
#   5. Balanza cuadrada                                → BLOQUEA
#   6. REP aparcados en needs_review                   → avisa
#   7. Pagos y cobros del periodo sin REP              → bloquea o avisa según el panel

mnemosine ledger stale-draft list --days 7 --period 2026-08
mnemosine drafts -s pending_review
mnemosine review

mnemosine rep missing list --direction received
mnemosine rep reconcile

mnemosine pending -v          # decisiones de política sin definir
mnemosine pending define rep_faltante_recibido bloquear -n "criterio del despacho"

mnemosine ledger check --period 2026-08
    # Sale con código 4 si encuentra algo. 4 es "encontré", no "no pude mirar".

mnemosine report view show     # ¿las vistas materializadas siguen de acuerdo con el mayor?
mnemosine report view sync     # reconstruirlas si no

mnemosine close --period 2026-08 --dry-run
mnemosine close --period 2026-08 --reason "cierre mensual agosto"
    # soft_close. Reversible por diseño... pero no hay comando para revertirlo (brecha 10).

mnemosine close --period 2026-08 --hard --reason "cierre definitivo"
    # Exige soft_close previo. Si es el último periodo del ejercicio,
    # genera los asientos de cierre y arrastra saldos al siguiente periodo.
```

**Dónde se rompe.**
1. No hay `period reopen` (brecha 10). El servicio existe.
2. La línea de conciliación bancaria da verde con cero cuentas (brecha 1).
3. Los asientos de cierre anual pueden saltarse en silencio (brecha 18).
4. `--hard` en diciembre traspasa el resultado a **3200 Resultado de Ejercicios Anteriores**, no a 3300 Resultado del Ejercicio (`period-close.ts:440`). Está razonado en el código (evitar 3100 Capital Social por NIF C-11) pero difiere de la práctica mexicana habitual de dejar el resultado del ejercicio en 3300 durante el año siguiente. Un manual tiene que decirlo.

---

### Flujo 6 · Estados financieros y balanza

```bash
mnemosine report trial-balance show --period 2026-08 --level 4 --exclude-zero
mnemosine report balance-sheet show --as-of 2026-08-31
mnemosine report income-statement show --period 2026-08
mnemosine report general-ledger show --account 1120 --period 2026-08

mnemosine ledger auxiliary show --account 1120 --period 2026-08
    # Saldo inicial → cada movimiento → saldo final. La forma del XC del SAT.

mnemosine ledger balance show --account 1120 --as-of 2026-08-31
mnemosine account balance show 1120 --period 2026-08

mnemosine report aged-receivable show --as-of 2026-08-31
mnemosine report aged-payable show --as-of 2026-08-31

# Exportar (esto SÍ funciona, kernel/output.ts:241):
mnemosine report trial-balance show --period 2026-08 --format csv -o balanza-2026-08.csv
mnemosine report income-statement show --period 2026-08 --format md -o resultados.md
mnemosine entry export --period 2026-08 --format csv -o polizas-2026-08.csv
    # entry export saca pólizas CON sus renglones, sin tope de página.

# Bases de fecha, en todos los reportes:
mnemosine report trial-balance show --period 2026-08 --date-basis posting
```

**Dónde se rompe.**
1. **No hay estado de flujos de efectivo** (NIF B-2). Verificado: la búsqueda de `cash.flow|flujo de efectivo|cash_flow` en `src/services/reporting/` y `src/cli/report-command.ts` no devuelve nada. Tampoco hay estado de variaciones en el capital contable (NIF B-4). La familia `report` cubre balanza, balance, resultados, mayor y dos antigüedades: cinco de los siete estados que un despacho entrega.
2. **No hay XML de contabilidad electrónica ni DIOT** (brecha 5). Este es el que duele.
3. No hay comparativo entre periodos ni columna de variación: cada reporte es de un corte. Un contador que quiere agosto contra julio corre dos veces y compara a mano.

---

### Flujo 7 · Dar de alta un cliente nuevo del despacho

```bash
# --- Identidad y catálogo ---
mnemosine entity create "Aceros del Centro SA de CV" \
  --tax-id ACO850101AB1 --country MX --currency MXN --chart auto
    # Siembra: catálogo base + roles semánticos + mapeo de nómina.
    # NO siembra el ejercicio fiscal (brecha 12).
    # --chart acepta auto | siempre | nunca — valores en español (brecha 17c).

mnemosine entity use ACO850101AB1

# --- El calendario. Paso obligatorio que nada te dice que existe ---
mnemosine year create 2026        # crea el ejercicio y sus doce periodos
mnemosine period list
mnemosine period open 2026-09     # abrir un periodo futuro si hace falta

# --- Roles semánticos: lo que el posteo automático lee ---
mnemosine account role list
mnemosine account role seed       # crea las cuentas base faltantes; nunca pisa una decisión manual
mnemosine account role set banco 1120
mnemosine account role set iva_acreditable 1190 --qualifier tasa16

# --- Catálogo propio del cliente ---
mnemosine account list --type expense
mnemosine account create 5110 "Papelería y artículos de oficina" \
  --type expense --normal-balance debit --parent 5100
mnemosine account set 5110 postable=true
mnemosine account edit 5110 --fs-category "Gastos de administración"

# --- Agrupador del SAT (Anexo 24). El trabajo pesado del alta ---
mnemosine account map import ./agrupador.csv --scheme sat-agrupador --dry-run
mnemosine account map import ./agrupador.csv --scheme sat-agrupador
    # El CSV es code,valor — una cuenta por línea, coma o punto y coma.
mnemosine account map list --scheme sat-agrupador
mnemosine account map check --scheme sat-agrupador --level 3 --strict
    # Sale con 4 si quedan cuentas de primer nivel sin mapear.

# --- Saldos iniciales, camino A: importar del sistema anterior ---
mnemosine onboard -p contalink --cutoff 2025-12-31 --from 2025-01-01 \
  --balance-account 3200 --dry-run
mnemosine onboard -p contalink --cutoff 2025-12-31 --balance-account 3200
mnemosine review           # el saldo inicial llega como borrador; hay que aprobarlo
⛔  # Sólo existe el adaptador de Contalink (registry.ts:11). Ni CONTPAQi ni Aspel.

# --- Saldos iniciales, camino B: a mano ---
mnemosine entry create --file saldos-iniciales.json \
  --type standard --description "Saldos iniciales al 31/12/2025"
mnemosine entry check --entry <numero> --strict
mnemosine entry post <numero>

⛔  # --- Saldos iniciales, camino C: migrar el histórico completo ---
mnemosine entry import polizas-2025.csv --layout <nombre>
    # Deja el lote en escenificación y NO HAY COMANDO PARA APLICARLO (brecha 9).

# --- Usuarios ---
mnemosine init --section users     # o --section usuarios; no hay familia `user`

# --- Panel de criterios contables ---
mnemosine pending -v
mnemosine pending define <clave> <valor> -n "criterio del despacho"

# --- Credenciales fiscales ---
mnemosine sat cred add --cer ./fiel.cer --key ./fiel.key --live
mnemosine sat cred status
⛔  # ...que hoy no sirve para nada: withCredential no tiene consumidores (brecha 4).

# --- Verificar ---
mnemosine doctor
mnemosine entity show
mnemosine ledger check
```

**Dónde se rompe.**
1. El ejercicio no se crea solo y nada lo anuncia (brecha 12).
2. `onboard` sólo habla Contalink — no el mercado real mexicano.
3. `entry import` es una puerta de un solo sentido (brecha 9).
4. No hay alta masiva de clientes ni de proveedores: no existen `customer import` ni `vendor import` (verificado en el volcado del árbol). Un cliente con 300 proveedores se captura de uno en uno o por SQL.
5. No hay alta de cuentas bancarias (brecha 1).
6. No hay familia `user`: el alta de usuarios sólo vive dentro del asistente, y el propio código lo declara (`src/auth/roles.ts:62`): *"el alta de usuarios vive en `mnemosine init`, que no pasa por requirePermission"*.

---

## RECOMENDACIONES

Ordenadas por relación entre daño evitado y esfuerzo.

**Inmediatas, de horas.**

1. **Conectar `repairCommandFor` al manejador de errores de los subcomandos** (brecha 15). La función ya existe, ya casa con el texto real de los fallos, y ya devuelve el comando correcto. Es una llamada en el `catch` de nivel superior. Convierte 179 errores mudos en 179 errores accionables.
2. **Arreglar la ayuda de `bill create --line`** (brecha 2): enumerar las nueve claves que `LINE_KEYS` acepta, y decir explícitamente que `tax` es un **monto** en `bill` y una **tasa** en `invoice` — o mejor, renombrar una de las dos a `tax-amount` / `tax-rate` y dejar `tax` como error de uso con mensaje.
3. **Unificar el separador de `--line`.** Tres formatos en un mismo CLI es un defecto de diseño, no una preferencia. Aceptar los tres durante una transición y documentar uno.
4. **Sembrar el ejercicio en `entity create`**, o al menos imprimir los pasos siguientes con sus comandos (brecha 12), como hace `gh repo create`.
5. **Copiar el mensaje bueno del periodo al malo** (brecha 11): `posting.ts:102-107` debe decir lo mismo que `journal-entry-service.ts:425-429`, y usar un código distinto de `PERIOD_CLOSED` cuando el periodo no existe.
6. **Que `generateClosingEntries` grite en vez de devolver `[]`** (brecha 18): si faltan 3900 o 3200, el cierre duro debe negarse con el motivo, no reportar éxito.

**De días.**

7. **Ejemplos en la ayuda** (brecha 20). Empezar por los veinte comandos de los siete flujos de este informe: `addHelpText('after', ...)` con dos o tres invocaciones reales. Es lo que más rendimiento da por línea escrita en un producto cuyo usuario declarado no vive en la terminal.
8. **Un selector en `review`** (brecha 7): `--draft <id>`, `--vendor`, `--min-amount`, `--since`, y que una tecla desconocida vuelva a preguntar en vez de saltar.
9. **`mnemosine period reopen <name> --reason <text>`** (brecha 10). El servicio está escrito, probado y con sus tres cerrojos. Falta el comando y su ruta.
10. **`mnemosine audit list`** (brecha 19), aunque sea con filtros mínimos por entidad, acción y rango de fechas.
11. **Bandera `--metodo-pago PUE|PPD` en `bill create` e `invoice create`** (brecha 6), que alimente la primera fuente de `decideMetodoPago`. Es el hueco que el propio comentario del código reserva.
12. **Decidir el idioma y cumplirlo** (brecha 17). Si la UI es inglesa, los valores de `--chart` y de `cfdi list --direction`, la ayuda de `account map import` y la salida de `entry import` tienen que traducirse. Si va a ser español —que es lo que el usuario objetivo pide—, ese es un proyecto propio, y el `Usage` que devuelve la forma inglesa es el primer sitio donde se nota.
13. **Validar lo local antes de conectar** (brecha 13): existencia de archivos, proveedor conocido, formato de fecha. Salir con código 2 antes de tocar la base.
14. **Ofrecer `did you mean` también en el primer nivel** (brecha 14), y no atribuir a `chat` un argumento que no es suyo.

**De semanas, por orden de valor para un despacho mexicano.**

15. **Contabilidad electrónica (Anexo 24) y DIOT** (brecha 5). Es la obligación que hace que un despacho compre un sistema contable. Las tres piezas de preparación ya están (`account map`, `ledger auxiliary`, la forma XC en `report-service.ts:908`); falta el generador y el comando.
16. **La familia `bank`** (brecha 1), aunque sea sólo `bank create`, `bank list`, `bank import`, `bank match`. Y mientras el cierre no pueda comprobar nada, que el checklist diga *"0 cuentas bancarias registradas: no se pudo comprobar"* en vez de dar verde. El `501` de `reconciliations/:id/complete` es correcto y debe quedarse hasta que exista la aritmética.
17. **La familia `batch`** (brecha 9): `batch list`, `batch show`, `batch check`, `batch post`. Sin ella, `entry import` no debería existir.
18. **Timbrado y cancelación por `pac-router`** (brecha 3). Cuatro adaptadores esperando. Con acuse archivado por bytes y reversa encadenada, como ya dice el `501`.
19. **Reglas de procesamiento desde la terminal** (brecha 8): `rule list`, `rule create`, `rule test <archivo.xml>`. La tercera es la que más valor tiene: probar una regla contra un CFDI real antes de encenderla.
20. **Adaptadores de CONTPAQi y Aspel para `onboard`.** Son los sistemas de los que el cliente realmente viene.

---

## NOTA DE MÉTODO

Dos cosas que estuve a punto de reportar y descarté al verificarlas, porque una brecha mal medida en un manual es peor que un hueco:

- **`init --section identity` / `--section ai`.** El `repairCommandFor` sugiere ids ingleses mientras las secciones se declaran en español (`infra`, `identidad`, `ia`, `politicas`, `importar`, `usuarios`). Parecía un remedio roto. No lo es: `resolveSectionId` acepta los dos idiomas a propósito (`init-command.ts:113-114`) y lo verifiqué ejecutándolo. Está bien resuelto.
- **Nombre del rol de Postgres en los errores.** Vi `role "postgres"` en unas corridas y `role "mnemo"` en otras, y parecía que `doctor` y los comandos leían configuraciones distintas. Al reproducirlo todo en una sola invocación, los cuatro comandos coinciden. El `.env` cambiaba entre corridas por otro proceso del entorno de auditoría, no por el código. Descartado.

Y una que no pude verificar: **si `mnemosine ingest` acepta una carpeta**. El fallo de base de datos ocurre antes de tocar los archivos (brecha 13), así que no llegué a la respuesta. Por la firma (`<files...>`) y por la ausencia de `existsSync`/`isDirectory` en `ingest-service.ts`, lo probable es que no, pero **no está verificado**.
