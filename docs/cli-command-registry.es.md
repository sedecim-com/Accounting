# REGISTRY — los diccionarios vinculantes del árbol de comandos de mnemosine

> Gemela en español de [`cli-command-registry.md`](cli-command-registry.md) · source_sha: 970f8f9ab97f516da70b1a4451f67547e3759115

**Estado: vinculante.** Este archivo prevalece sobre los once archivos de sección. Donde una sección discrepe de
este archivo, la sección está mal y debe reescribirse. Donde este archivo calle, gobierna `research/cli-ux.md`
PARTE III; donde ésta también calle, decide el autor de la sección y registra la decisión en
la tabla de Resoluciones de conflictos de este archivo mediante una enmienda.

**Orden de autoridad.** (1) el repositorio que se distribuye: `src/cli/` y `tests/cli/bilingual-matrix.spec.ts`;
un nombre que choque con uno ya distribuido es una prueba que falla, no una opinión. (2) `research/cli-ux.md`
PARTE III (R1–R12) y §II.4/§II.7. (3) este archivo. (4) los archivos de sección.

**Tres invariantes globales que este archivo existe para garantizar:**

1. **Forma.** `mnemosine <noun> <verb> [<qualifier>] [args] [--flags]`, profundidad ≤ 3. El **último
   token antes de los argumentos es siempre un verbo de §1**. No hay comandos que terminen en sustantivo. No hay
   excepción para los comandos de «consulta»; la excepción en prosa de `bank.md` queda tachada.
2. **Biyección.** El mapa de verbos inglés→español es una biyección: un verbo en inglés, exactamente una
   palabra en español, y ninguna palabra española usada por dos verbos en inglés. Igual para los sustantivos.
3. **Un dueño.** Cada sustantivo se define en exactamente un archivo. Todo otro archivo que lo necesite
   enlaza al dueño y añade *valores* de banderas, nunca filas.

---

## 1. REGISTRO DE VERBOS

La lista cerrada. 76 verbos: los 46 verbos de R3 (R3 menos `pull`/`push`, eliminados abajo) más 30 marcados
**EXT**. Todo lo que no esté en esta tabla lo rechaza la prueba R12. `pull` y `push` quedan **eliminados
de R3**: R4 los reserva para la sincronización bidireccional con un sistema externo vivo, `sync` ya significa
exactamente eso, y todo uso de `pull`/`push` en el catálogo era una descarga o un envío en un solo sentido.

### 1.1 Lectura

| Inglés | Español (el único) | Significado preciso | Puede aplicarse a |
|---|---|---|---|
| `list` | `listar` | Enumerar cero o más objetos. Siempre acepta una consulta posicional, `--limit`, `--format`, `--fields`. | todo sustantivo |
| `show` | `ver` | Tomar exactamente un identificador, imprimir exactamente un objeto. | todo sustantivo |
| `search` | `buscar` | Búsqueda de texto completo en un corpus, con ranking. | `memory`, `session`, `doc`, `entry`, `document`, `skill` |
| `explain` | `explicar` | Derivar una cifra o una decisión y nombrar la regla que la produjo. **Nunca** introspección de esquema: eso es `schema show`. | todo sustantivo que calcula una cifra |
| `diff` | `comparar` | Comparar dos estados nombrados de la misma clase de objeto; el otro lado es `--vs`. | `entry`, `report`, `trial-balance`, `pay-run`, `chart`, `variance`, `consolidation`, `config`, `snapshot` |
| `export` | `exportar` | Escribir datos internos a un archivo o flujo. | todo sustantivo que tiene filas |
| `check` | `verificar` | **Validación local y de sólo lectura** que produce hallazgos nombrados y un código de salida. No llama nada externo. | todo sustantivo de familia (`ledger`, `ar`, `ap`, `bank`, `payroll`, `asset`, `inventory`, `cfdi`, `closing`, `config`, `report`, `entry`, …) |
| `status` | `estado` | Estado actual de un objeto o proceso de larga duración. Alias con forma de sustantivo, heredado (ver §2.5). | `pay-run`, `closing`, `job`, `integration`, `sat cred`, `bank reconciliation`, `filing`, `payroll run` |
| `history` | `historial` | Rastro de sólo añadir de eventos **sobre un objeto**. | todo sustantivo versionado o auditado |
| `watch` | `observar` | Transmitir/seguir una fuente cambiante hasta que se interrumpa. | `job`, `inbox`, `outbox`, `webhook`, `ingest` |
| `trace` **EXT** | `rastrear` | Seguir **un documento hacia adelante por todos los objetos posteriores que produjo** (CFDI → factura de proveedor → póliza → pago → conciliación). Ni `history` (un objeto) ni `explain` (la regla de una cifra) cubren una cadena entre objetos, y la alternativa era un sustantivo `lineage`, que R1 prohíbe en la posición del verbo. | `ledger`, `cfdi`, `inventory cost`, `report` |
| `preview` **EXT** | `previsualizar` | Mostrar, como objeto, lo que produciría un comando de *escritura*, sin escribir. Distinto de `--dry-run`, que es una bandera del propio comando de escritura; `preview` es el hermano de sólo lectura que un agente puede invocar cuando la escritura es `✗`. Justifica su propia fila porque la división ✓/✗ nunca puede depender del valor de una bandera. | `year`, `entry`, `depreciation`, `pay-run`, `allocation`, `close` |
| `verify` **EXT** | `comprobar` | Probar un artefacto frente a una autoridad **externa o criptográfica** (una cadena de hashes, un ancla de sello de tiempo, un CEP bancario, un registro gubernamental, una imagen de respaldo). `check` es local y barato; `verify` llama hacia afuera y puede fallar por razones que no son culpa de los datos. | `audit`, `anchor`, `attest`, `backup`, `bank cep`, `ssn`, `ledger chain` |
| `test` **EXT** | `probar` | Ejercitar de punta a punta una dependencia externa viva o una regla, e informar lo que habría hecho. Fijado por `platform.md`. | `integration`, `ai-provider`, `bank rule`, `approval rule`, `memory`, `webhook`, `policy` |

### 1.2 Crear / modificar

| Inglés | Español | Significado preciso | Puede aplicarse a |
|---|---|---|---|
| `create` | `crear` | Crear un objeto nuevo; **falla si la identidad ya existe**. | todo sustantivo que tiene instancias |
| `edit` | `editar` | Cambiar uno o más campos mutables de un objeto existente. | todo sustantivo mutable |
| `delete` | `eliminar` | Destruir un registro que **nunca ha afectado al libro mayor**. Una póliza contabilizada nunca se elimina. | `draft`, `template`, `rule`, `definition`, `dimension` (sin uso), `alias`, `webhook`, `job` |
| `import` | `importar` | Traer **datos** externos desde un archivo, directorio o flujo. | `entry`, `chart`, `bank statement`, `inventory count`, `payment-run`, `closing calendar`, `fx rate`, `timesheet` |
| `apply` | `aplicar` | Poner en vigor una entrada sobre un destino, de forma **idempotente** (`apply` de kubectl): desde un archivo, o un pago contra una factura. | `chart`, `payment`, `receipt`, `credit-note`, `bank match`, `policy` |
| `unapply` **EXT** | `desaplicar` | Deshacer una aplicación sin tocar la póliza contabilizada del mayor. La inversa de un `apply` idempotente no tiene otra grafía; `reverse` se reserva para una contrapóliza contabilizada y `delete` es ilegal sobre cualquier cosa que tocó el mayor. | `payment`, `receipt`, `credit-note`, `bank match` |
| `set` | `fijar` | Escribir **un** valor de configuración. | `config`, `policy`, `threshold`, `rule`, `numbering`, `materiality`, `costing`, `dimension policy`, `tolerance` |
| `unset` | `limpiar` | Devolver un valor de configuración a su valor por defecto. | igual que `set` |
| `assign` | `asignar` | Dar a un registro un **dueño o responsable** (una persona, una cola, un equipo). Disjunto de `set`, que escribe configuración. | `task`, `dispute`, `question`, `approval`, `control`, `pbc`, `sample` |
| `use` | `usar` | Seleccionar el contexto ambiente (entidad actual, perfil, periodo). | `entity`, `profile`, `tenant`, `period` |
| `add` | `agregar` | Anexar un hijo a una colección de un padre. | `memory`, `entry line`, `reconciliation item`, `user access`, `group member`, `pay-code`, `signer` |
| `remove` | `quitar` | Separar un hijo de una colección. | igual que `add` |
| `record` **EXT** | `registrar` | Dar fe de un acto que **ya ocurrió fuera del sistema** (una declaración que una persona transmitió, una ausencia, una transferencia bancaria manual). Distinto de `create` (que origina el acto) y de `post` (que escribe el mayor). | `filing`, `absence`, `incapacity`, `promise`, `payment`, `collection`, `obligation` |
| `seed` **EXT** | `sembrar` | Poblar una tabla con un conjunto de referencia estándar (plantillas de catálogo, tablas de impuestos, roles de cuenta). Fijado por `platform.md`. | `chart`, `tax-table`, `account role`, `pay-code` |
| `clone` **EXT** | `clonar` | Copiar un objeto existente a una identidad nueva. | `entity`, `report`, `budget`, `entry template`, `pay-schedule` |

### 1.3 Ciclo de vida

| Inglés | Español | Significado preciso | Puede aplicarse a |
|---|---|---|---|
| `post` | `contabilizar` | Escribir la póliza aprobada en el libro mayor. | `entry`, `bill`, `invoice`, `payment`, `pay-run`, `depreciation`, `allocation`, `consolidation`, `bank reconciliation`, `inventory` |
| `void` | `anular` | Matar un documento **no contabilizado**. | `entry`, `bill`, `invoice`, `payment`, `payslip`, `pay-run`, `bank check` |
| `reverse` | `reversar` | Escribir la contrapóliza de un documento **contabilizado**. Absorbe `unpost`, `rollback`, `revert`. | `entry`, `bill`, `depreciation`, `accrual`, `inventory`, `pay-run`, `write-off`, `consolidation` |
| `correct` | `corregir` | Emitir un documento sustituto que reemplaza a uno anterior, conservando ambos. | `entry`, `cfdi`, `1099`, `w2`, `filing`, `memory`, `payslip` |
| `submit` | `enviar` | Entregar un documento a una **parte dentro del despacho que debe actuar sobre él** (un aprobador interno). | `entry`, `bill`, `invoice`, `pay-run`, `worksheet`, `closing task`, `attest`, `draft` |
| `approve` | `aprobar` | Visto bueno humano. Absorbe `certify`, `signoff`, `confirm` (sentido humano), `unapprove`→`reject`. | todo sustantivo con una compuerta de aprobación |
| `reject` | `rechazar` | Rechazo humano, exige `--reason`. Absorbe `discard` (de un documento entrante malo). | todo sustantivo con una compuerta de aprobación, más `cfdi`, `bill inbox` |
| `dismiss` **EXT** | `descartar` | Marcar un elemento como **no aplicable** para que deje de aparecer, sin juzgarlo erróneo. Fijado por el repositorio (`pending dismiss|descartar`); distinto de `reject`, que es el rechazo de algo enviado. | `pending`, `question`, `closing task`, `anomaly`, `control exception` |
| `cancel` | `cancelar` | Retirar un documento **emitido externamente** (un CFDI se cancela, un periodo se cierra; nunca se intercambian). Absorbe `abandon`, `expire`. | `cfdi`, `invoice`, `payslip`, `order`, `purchase-order`, `job` |
| `open` | `abrir` | Llevar un periodo o una sesión a su estado de trabajo. | `period`, `year`, `bank reconciliation`, `worksheet`, `dispute` |
| `close` | `cerrar` | Sólo operación de periodo/libros. | `period`, `year`, `dispute`, `bank reconciliation`, `contract` |
| `reopen` | `reabrir` | Deshacer un `close`, exige `--reason`. | `period`, `year`, `bank reconciliation`, `dispute`, `closing task` |
| `lock` | `bloquear` | Congelar ediciones sin cerrar. Absorbe `freeze`. | `period`, `pay-run input`, `inventory count`, `chart`, `budget` |
| `unlock` | `desbloquear` | Deshacer un `lock`, exige `--reason`. Absorbe `unfreeze`. | igual que `lock` |
| `archive` | `archivar` | Retirar un registro maestro del uso activo, conservando el historial. Absorbe `deactivate`, `retire`, `disable` **de un registro maestro**. | `account`, `customer`, `vendor`, `item`, `employee`, `dimension`, `memory`, `entity`, `skill` |
| `restore` | `restaurar` | Deshacer un `archive`, o rehidratar desde un respaldo. Absorbe `reinstate`, `reactivate`, `undelete`. | igual que `archive`, más `backup`, `cfdi` |
| `grant` **EXT** | `otorgar` | Dar a un principal un permiso o un rol. | `role`, `permission`, `user access`, `delegation`, `auditor` |
| `revoke` **EXT** | `revocar` | Quitar un permiso, rol o credencial. Fijado por el repositorio (`sat cred revoke\|revocar`). | igual que `grant`, más `secret`, `integration`, `token` |
| `enable` **EXT** | `activar` | Encender un **control, regla o función**. Distinto de `restore`, que devuelve un registro maestro al uso activo. | `rule`, `control`, `webhook`, `integration`, `policy`, `skill`, `anomaly rule`, `daemon` |
| `disable` **EXT** | `desactivar` | Apagar un control, regla o función. Siempre `✗` para el agente (apagar un control no es decisión del agente). | igual que `enable` |

### 1.4 Operaciones

| Inglés | Español | Significado preciso | Puede aplicarse a |
|---|---|---|---|
| `run` | `ejecutar` | Ejecutar un **proceso definido** que produce borradores, pólizas o documentos. Absorbe `correr`, `execute`, `process`, `rerun`. | `depreciation`, `allocation`, `dunning`, `revenue`, `billing-schedule`, `payroll`, `closing`, `job`, `report`, `bank reconciliation` |
| `calculate` **EXT** | `calcular` | Calcular una cifra derivada y **no escribir nada**. Absorbe `compute`, `recalculate`, `roll`. Separado de `run` porque la etiqueta de agente difiere: un cálculo es `lectura`, una ejecución es al menos `borrador`. | `depreciation`, `sbc`, `imss cuota`, `isn`, `aguinaldo`, `ptu`, `finiquito`, `allowance`, `deferred-tax`, `provision`, `apportionment`, `estimated-tax`, `franchise-tax`, `kpi`, `consolidation nci` |
| `accrue` **EXT** | `devengar` | Producir el **borrador de devengo de cierre de periodo** de un auxiliar. Un acto, un verbo, en lugar de `accrual run` en dos archivos con dos significados. | `ap`, `payroll`, `ar`, `use-tax`, `prepaid` |
| `allocate` **EXT** | `prorratear` | Distribuir un monto entre dimensiones o entidades según una base. Absorbe `spread`, `distribute`, `apportion`. | `allocation`, `cost`, `overhead`, `apportionment`, `intercompany` |
| `match` | `cotejar` | **Proponer** una correspondencia entre dos poblaciones; no escribe nada en el mayor. | `bank`, `bill`, `receipt`, `payment`, `cfdi`, `purchase-order` |
| `reconcile` | `conciliar` | **Probar** un saldo contra una cuenta de control o un estado de cuenta externo. Absorbe `clear`, `tie` (sentido verbal). | `bank`, `ar`, `ap`, `inventory`, `asset`, `cfdi`, `payroll`, `imss`, `revenue`, `sales-tax`, `provision`, `1099`, `trial-balance`, `cashflow`, `w2`, `w3` |
| `prepare` | `preparar` | Dejar un documento listo para aprobación o transmisión; no sale del despacho. | `payment-run`, `filing`, `1099`, `w2`, `diot`, `closing pack`, `pbc` |
| `generate` | `generar` | Armar un **artefacto entregable** (un archivo, un PDF, un layout, un estado). Absorbe `build`, `construir`, `render`, `draw`. | `statement`, `report`, `payslip`, `disclosure`, `narrative`, `efw2`, `idse`, `xbrl`, `closing pack`, `confirmation` |
| `issue` **EXT** | `emitir` | Liberar un documento que tiene **efecto legal sobre un tercero**. Absorbe `restamp`, `reissue`, `print` (de un cheque). | `invoice`, `credit-note`, `bank check`, `withholding constancia`, `retention certificate`, `payslip` |
| `stamp` | `timbrar` | Obtener el sello del PAC/autoridad (MX). Deliberadamente distinto de `issue`. | `cfdi`, `payslip`, `rep`, `invoice` |
| `seal` **EXT** | `sellar` | Poner el **sello de la e.firma del propio contribuyente** sobre un archivo entregable (Anexo 24: `Sello`, `noCertificado`, `Certificado`). Distinto de `stamp` (sella el PAC o la autoridad) y de `file` (una transmisión): nada sale del despacho, y la carga es un acto de una persona en el portal del SAT (#442). | `e-accounting catalog`, `e-accounting balance` |
| `file` **EXT** | `presentar` | **Transmitir una declaración a una autoridad fiscal.** Separado de `submit` (aprobador interno) y de `send` (una copia a una contraparte) porque los tres actos tienen distinta irreversibilidad, distintas credenciales y distintas etiquetas de agente. | `filing`, `diot`, `annual`, `1099`, `w2`, `w3`, `fbar`, `sales-tax`, `estimated-tax` |
| `send` **EXT** | `entregar` | Entregar una copia de un documento a un **tercero para sus registros**. Absorbe `deliver`, `transmit`, `notice`. | `invoice`, `payslip`, `1099`, `w9 request`, `confirmation`, `dunning`, `statement` |
| `remit` **EXT** | `enterar` | **Pagar a un tercero dinero que el despacho retenía por cuenta de él**: un entero de impuestos, un embargo, bienes no reclamados. No es `pay` (una compra), ni `file` (una declaración), ni `post` (una escritura en el mayor), y el catálogo lo escribía de otro modo como `deposit`, `escheat`, `entero` y `run`. | `tax-deposit`, `garnishment`, `withholding`, `imss cuota`, `infonavit`, `bank check` (escheat) |
| `download` | `descargar` | Recuperar **un artefacto externo nombrado**. Absorbe `fetch`, `obtener`, `bajar`, `traer`, `jalar`. | `sat download`, `bank statement`, `cfdi acuse`, `fx rate`, `e-accounting acuse`, `bank cep` |
| `upload` | `subir` | Enviar un artefacto local nombrado a un sistema externo. | `sat`, `filing`, `integration`, `document` |
| `sync` | `sincronizar` | Conciliar el estado local con un catálogo o flujo externo vivo, en ambos sentidos, de forma idempotente. Absorbe `pull`, `push`, `status-sync`, `catchup`. | `bank feed`, `cfdi status`, `inbox`, `integration`, `sat download`, `anchor`, `holiday`, `chart` |
| `retry` | `reintentar` | Reintentar una entrega externa o un trabajo **fallido**. | `outbox`, `webhook delivery`, `attest`, `job`, `integration event`, `payment` |
| `resume` | `reanudar` | Continuar desde donde se detuvo un proceso de varios pasos **pausado o interrumpido**. | `payroll run`, `bank reconciliation run`, `closing run`, `sat download`, `ingest` |
| `recover` **EXT** | `recuperar` | Devolver a un estado consistente una operación **varada** cuando ni `retry` ni `resume` aplican (un candado huérfano, un lote a medio escribir). | `job`, `pay-run`, `batch`, `session`, `bank reconciliation` |
| `rotate` **EXT** | `rotar` | Reemplazar una credencial por una nueva, probando primero la nueva. | `secret`, `integration`, `token`, `sat cred`, `webhook` |
| `install` **EXT** | `instalar` | Añadir un componente externo al entorno local. Fijado por `platform.md`. | `skill`, `completion`, `daemon`, `integration` |
| `start` **EXT** / `stop` **EXT** | `iniciar` / `detener` | Comenzar / detener un proceso local de larga duración. | `daemon`, `job`, `watch`, `session` |
| `answer` **EXT** | `responder` | Dar la respuesta humana a una duda abierta, acuñando un precedente. Fijado por `platform.md`. | `question`, `pending`, `pbc` |
| `review` **EXT** | `revisar` | **Abrir la cola interactiva de aprobación humana.** Sólo a nivel raíz (`mnemosine review`), fijado por el repositorio distribuido. Ningún subcomando puede usar este verbo: eso liberó a `revisar` de los seis verbos en inglés que cargaba. | sólo raíz |
| `compact` **EXT** | `compactar` | Reducir una sesión o un almacén conservando el significado. Fijado por el repositorio (`compact\|compactar`). | `session`, `memory`, `log`, `prompt-size` |
| `upgrade` **EXT** | `actualizar` | Llevar la instalación a una versión más nueva. Fijado por el repositorio (`upgrade\|actualizar`). | sólo raíz |

### 1.5 Grafías eliminadas — cada una es una reescritura, no un alias

`verify`→`check` **excepto** las siete filas criptográficas/externas; `validate`, `lint`, `screen`,
`evaluate`, `preflight`, `risk-scan`, `audit`(como verbo), `tie-out`(verbo) → `check`.
`define`, `new`, `register`, `init`(de un objeto), `draft`(verbo), `open`(de una disputa/CIP) → `create`.
`update`, `customize`, `annotate` → `edit` (`annotate` → `edit --note`).
`compute`, `recalculate`, `roll` → `calculate`. `correr`, `execute`, `process`, `rerun` → `run`.
`build`, `construir`, `render`, `draw` → `generate`. `simulate` → `preview`.
`fetch`, `obtener`, `bajar`, `traer`, `jalar` → `download`. `pull`, `push` → `sync`.
`log`(verbo), `mark-filed` → `record`. `load`, `parse`, `reparse` → `import`.
`afectar`, `aplicar`(sentido de mayor) → `post`. `revertir`, `rollback`, `unpost`, `fix`, `amend`(no fiscal) → `reverse`.
`certify`, `signoff`, `confirm`(humano) → `approve`. `unapprove`, `discard` → `reject`. `waive`, `na` → `dismiss`.
`abandon`, `expire` → `cancel`. `hold`, `release` → `lock`/`unlock`. `freeze`/`unfreeze` → `lock`/`unlock`.
`deactivate`, `retire` → `archive`. `reinstate`, `reactivate` → `restore`.
`invite` → `grant`. `duplicate`, `copy` → `clone`. `reauth` → `rotate`. `deliver`, `transmit`, `notice` → `send`.
`restamp`, `reissue`, `print` → `issue`. `escheat`, `deposit`(verbo) → `remit`. `spread`, `distribute` → `allocate`.
`add-member`/`remove-member`, `attach`, `enroll`, `exclude` → `add`/`remove`.
`definir`, `establecer`, `configurar` (en sentido de `set`) → `fijar`. `asignar` (en sentido de `set`) → `fijar`; `asignar` ahora significa sólo `assign`.
`mostrar` → `ver`. `diferencias`, `diferencia` → `comparar`. `correr` → `ejecutar`. `cruce` → `cotejo`.
**Sustantivos sueltos en la posición del verbo** (`ledger orphans`, `cfdi anomalies`, `bank match forced`, `ar aging`,
`inventory kardex`, `treasury position`, `budget exceptions`, `sod matrix`, `pay-run inputs`, `close tie`,
`bank account signers`, …) → se añade el verbo que la fila realmente ejecuta, casi siempre `list` o `show`.

---

## 2. REGISTRO DE SUSTANTIVOS

232 sustantivos canónicos. En singular, minúsculas, con guion cuando son de varias palabras, en inglés. Los alias en español
también son sustantivos en singular. **Un archivo dueño por sustantivo**; todo otro archivo lo referencia.

Los valores de `--status` son la máquina de estados publicada del sustantivo (R7), tomada del esquema distribuido donde
exista. `—` significa que el sustantivo es un maestro sin estado o un puro portador de verbos.

### 2.1 Comandos de raíz sin objeto — la lista cerrada de 15 (R1)

`ask`·`pregunta` · `chat`·(ninguno) · `review`·`revisar` · `close`·`cierre` · `doctor`·(ninguno) ·
`status`·`estado` · `init`·`configurar` · `onboard`·`alta` · `login`·`entrar` · `logout`·`salir` ·
`whoami`·`quien` · `lang`·`idioma` · `ingest`·`ingesta` · `compact`·`compactar` · `help`·`ayuda`.

Todo otro comando que hoy se distribuye en la raíz pasa a ser `<noun> <verb>` y conserva su nombre anterior
como alias obsoleto R9 con aviso en stderr: `entities`→`entity list`, `providers`→`ai-provider list`,
`sessions`→`session list`, `drafts`→`draft list`, `outbox`→`outbox list`, `questions`→`question list`,
`pending`→`pending list`, `memory`→`memory list`, `approvals`→`approval list`, `usage`→`usage show`,
`jobs`→`job list`, `skills`→`skill list`, `webhooks`→`webhook list`, `prompt-size`→`prompt-size show`.
`sat` sigue como sustantivo (`sat cred …`, `sat download …`).

### 2.2 ledger.md (12)

| Sustantivo | Español | Valores de `--status` |
|---|---|---|
| `account` | `cuenta` | `active \| dormant \| archived` |
| `chart` | `catalogo` | — |
| `entry` | `poliza` | `draft \| pending_approval \| approved \| posted \| void` (001:238); `reversed` se deriva de `reversed_by_entry_id`, no es un estado |
| `period` | `periodo` | `future \| open \| soft_close \| hard_close \| locked` (001:204) |
| `year` | `ejercicio` | `open \| closed` (001:187) |
| `ledger` | `mayor` | — |
| `dimension` | `dimension` | `active \| retired` — **NUEVO, cierra la brecha bloqueante de completitud** |
| `allocation` | `prorrateo` | `draft \| active \| archived` |
| `batch` | `lote` | `pending \| running \| completed \| failed \| cancelled` |
| `numbering` | `folio` | — |
| `opening-balance` | `saldo-inicial` | `draft \| loaded \| verified` |
| `fx` | `cambio` | — (`fx rate …` es la forma con calificador) |

### 2.3 ar.md (25)

`ar`·`cxc` — · `customer`·`cliente` `active \| on_hold \| suspended \| archived` (002:181) ·
`invoice`·`factura` `draft \| pending \| sent \| viewed \| paid \| partially_paid \| overdue \| void \| cancelled \| uncollectible` (002:212) ·
`receipt`·`cobro` `draft \| pending \| processing \| completed \| failed \| void` (002:294) ·
`credit-note`·`nota-credito` · `debit-note`·`nota-cargo` · `advance`·`anticipo` (**CxC lo posee; fiscal-mx lo pierde**) ·
`allowance`·`estimacion` (**el `reserve` de inventario pasa a ser `inventory allowance`, misma palabra en español, un solo concepto**) ·
`dunning`·`recordatorio` · `collection`·`cobranza` · `dispute`·`disputa` `open \| investigating \| resolved \| closed` ·
`promise`·`promesa` `open \| kept \| broken` · `contract`·`contrato` · `billing-schedule`·`programa-facturacion` ·
`price-list`·`lista-precios` · `payment-term`·`condicion-pago` · `quote`·`cotizacion` · `order`·`pedido` ·
`revenue`·`ingreso` · `write-off`·`castigo` (**una sola grafía; `writeoff` y `writedown` mueren**) ·
`factoring`·`factoraje` · `finance-charge`·`recargo` · `netting`·`compensacion` · `retainage`·`fondo-garantia` ·
`meter`·`consumo`.

### 2.4 ap.md (18)

`ap`·`cxp` · `vendor`·`proveedor` (**CxP posee `proveedor`; el sustantivo de LLM/PAC de platform se renombra**) ·
`bill`·`factura-proveedor` `draft \| pending_approval \| approved \| posted \| paid \| partially_paid \| void \| cancelled` (002:64) ·
`payment`·`pago` `draft \| pending \| processing \| completed \| failed \| void` (002:129) ·
`payment-run`·`corrida-pago` `draft \| prepared \| approved \| released \| settled \| returned` (**el único sustantivo de desembolso por lotes; el `payment-batch` de nómina muere**) ·
`purchase-order`·`orden-compra` · `requisition`·`requisicion` · `goods-receipt`·`recepcion` ·
`service-entry`·`acta-servicio` · `grni`·`grni` (**abreviatura estándar del dominio, añadida a la lista permitida de R2; el alias `rnf` muere**) ·
`expense-report`·`informe-gasto` · `prepaid`·`pago-anticipado` · `mileage-rate`·`tarifa-kilometraje` ·
`vendor-advance`·`anticipo-proveedor` · `vendor-credit`·`nota-credito-proveedor` · `vendor-debit`·`nota-cargo-proveedor` ·
`withholding`·`retencion` (**CxP posee `retencion`; el `retention` de fiscal-mx y el de close-controls la pierden ambos**) ·
`accrual`·`devengo`.

### 2.5 bank.md (3)

| Sustantivo | Español | `--status` |
|---|---|---|
| `bank` | `banco` | `bank reconciliation`: `in_progress \| balanced \| approved \| posted` (003:89); `bank check`: `issued \| outstanding \| cleared \| void \| stopped \| stale \| escheated` |
| `cash` | `caja` | — |
| `treasury` | `tesoreria` | — |

`check` **no** es un sustantivo de primer nivel: choca con el verbo `check`. Todos los comandos de cheque en papel son
`bank check <verb>`·`banco cheque <verbo>` a profundidad 3. `card` tampoco es un sustantivo: una tarjeta de crédito es
`bank account --type credit-card`, como ya resolvió `bank.md:54`. `bank statement`·`banco estado-cuenta`
— nunca `banco estado`, que es el alias de `status`.

### 2.6 assets-inventory.md (7)

`asset`·`activo` `active \| inactive \| disposed \| fully_depreciated` (003:182) · `depreciation`·`depreciacion` ·
`inventory`·`inventario` · `item`·`articulo` · `warehouse`·`almacen` · `costing`·`costeo` · `inpc`·`inpc`.

`asset doctor` e `inventory doctor` se eliminan; la salud del sistema es `doctor --scope <family>` y
las invariantes del dominio son `asset check` / `inventory check`.

### 2.7 payroll.md (43)

`payroll`·`nomina` · `employee`·`empleado` `active \| on_leave \| terminated \| suspended` (008:32) ·
`pay-run`·`corrida` `draft \| calculating \| calculated \| approved \| paid \| voided` (008:162) ·
`pay-period`·`periodo-nomina` `draft \| calculated \| approved \| paid \| closed` (008:143) ·
`pay-schedule`·`calendario-nomina` · `pay-code`·`concepto` · `payslip`·`recibo` `pending \| stamped \| cancelled \| failed` (002:223) ·
`timesheet`·`asistencia` · `absence`·`ausencia` · `incapacity`·`incapacidad` · `vacation`·`vacaciones`
(**el único alias plural en español heredado: el singular no existe en el uso de nómina**) ·
`benefit`·`prestacion` · `compensation`·`sueldo` · `garnishment`·`embargo` · `sbc`·`sbc` · `imss`·`imss` ·
`infonavit`·`infonavit` · `fonacot`·`fonacot` · `isn`·`isn` · `isr`·`isr` (**ISR de nómina; el ISR corporativo es `provision`/`annual`**) ·
`sui`·`sui` · `ssn`·`ssn` · `multistate`·`multiestado` · `tax-table`·`tabla-fiscal` ·
`tax-deposit`·`entero` (**nómina lo posee; el `deposito-fiscal` de fiscal-us muere**) `pending \| deposited \| late \| waived` (008:344) ·
`employer-registration`·`registro-patronal` · `new-hire`·`nueva-contratacion` · `termination`·`terminacion` ·
`aguinaldo` · `ptu` · `finiquito` · `liquidacion` · `prima-antiguedad` · `prima-vacacional` ·
`pension-alimenticia` (**seis términos legales mexicanos sin traducir; alias idéntico, como `cfdi`**) ·
`imputed-income`·`ingreso-imputado` · `gl-map`·`mapeo-contable` · `prenote`·`prenota` `draft \| submitted \| settled \| rejected \| returned` (008:465) ·
`w2`·`w2` · `w3`·`w3` · `w4`·`w4` · `efw2`·`efw2` · `yearend`·`cierre-anual`.

### 2.8 fiscal-mx.md (11)

`cfdi`·`cfdi` `pending \| validating \| ready \| processing \| completed \| rejected \| error` (005:87) ·
`sat`·`sat` · `pac`·`pac` · `diot`·`diot` ·
`filing`·`declaracion` `draft \| ready \| filed \| accepted \| rejected \| amended` (008:490) — **fiscal-mx posee el sustantivo; fiscal-us y nómina aportan sólo valores de `--form`** ·
`obligation`·`obligacion` `pending \| due \| filed \| waived` — **mismo fallo: fiscal-mx posee, los otros dos aportan valores de `--jurisdiction`/`--form`** ·
`party`·`contraparte` · `rep`·`rep` · `annual`·`anual` ·
`e-accounting`·`contabilidad-electronica` (**antes `eaccounting`·`contae`: no es una palabra, y el alias era opaco**) ·
`tax-mailbox`·`buzon` (**antes el canónico en español `buzon`; R8 exige un canónico en inglés, y esto libera el `inbox` de platform**).

### 2.9 fiscal-us.md (21)

`1099`·`1099` · `w9`·`w9` · `w8`·`w8` · `sales-tax`·`impuesto-ventas` · `use-tax`·`impuesto-uso`
(**fiscal-us posee ambos; las copias de ap.md mueren**) · `nexus`·`nexo` ·
`apportionment`·`atribucion` (**antes `prorrateo`, que pertenece al `allocation` de ledger**) ·
`provision`·`provision` (**liberado porque el `accrual`·`provision` de nómina pasa a ser `payroll accrue`·`nomina devengar`**) ·
`deferred-tax`·`impuesto-diferido` · `book-tax`·`contable-fiscal` · `tax-basis`·`base-fiscal` ·
`estimated-tax`·`pago-estimado` · `franchise-tax`·`franquicia` · `property-tax`·`predial` ·
`nra-withholding`·`retencion-extranjeros` · `foreign-account`·`cuenta-extranjera` · `fbar`·`fbar` ·
`utp`·`posicion-incierta` · `transfer-price`·`precio-transferencia` · `related-party`·`parte-relacionada` ·
`registration`·`registro`.

El sustantivo `tax`·`fiscal` está **eliminado**: R10 prohíbe los sustantivos genéricos que acaparan un espacio de nombres, y cada fila
bajo él pertenece a uno de los veintiún anteriores.

### 2.10 report.md (22)

`report`·`reporte` · `statement`·`estado-financiero` · `trial-balance`·`balanza` · `worksheet`·`hoja-trabajo` ·
`budget`·`presupuesto` · `forecast`·`pronostico` · `variance`·`variacion` (**el `flux`·`variaciones` de close-controls muere**) ·
`kpi`·`indicador` · `dashboard`·`tablero` · `narrative`·`narrativa` · `disclosure`·`nota` (**singular**) ·
`consolidation`·`consolidacion` · `intercompany`·`intercompania` · `segment`·`segmento` · `cashflow`·`flujo` ·
`covenant`·`convenio` · `benchmark`·`referencia` · `statistic`·`estadistica` · `account-group`·`grupo-cuentas` ·
`anomaly`·`anomalia` · `xbrl`·`xbrl` ·
`tie-out`·`amarre` — **un sustantivo, una grafía, un dueño.** `ledger tieout`, `tieout build`, `close tie`
y `disclosure tie-out` pasan todos a `tie-out check --scope <subledger>`·`amarre verificar`.

### 2.11 close-controls.md (15)

`closing`·`cierre-proceso` — **el *proceso* de cierre, distinto de la hoja raíz `close`·`cierre`** ·
`control`·`control` · `sod`·`segregacion` · `materiality`·`materialidad` · `sample`·`muestra` ·
`pbc`·`pbc` (**abreviatura estándar de auditoría, añadida a la lista permitida de R2; el alias plural `requerimientos` muere**) ·
`auditor`·`auditor` · `attest`·`atestacion` `pending \| submitted \| confirmed \| failed` (006:226) ·
`anchor`·`ancla` `pending \| broadcast \| confirmed \| failed` (006:149) · `permission`·`permiso` ·
`delegation`·`delegacion` · `document`·`documento` (**adjuntos; platform conserva `doc`·`doc` para temas de ayuda**) ·
`continuity`·`continuidad` (**antes `dr`·`contingencia`, una abreviatura de dos letras prohibida por R5**) ·
`reconciliation`·`conciliacion` (**antes `recon`, abreviatura prohibida por R2/R5**) `open \| in_progress \| balanced \| certified \| reopened` ·
`data-retention`·`conservacion` (**antes `retention`·`retencion`, que ahora pertenece al `withholding` de CxP**).

### 2.12 platform.md (40)

`entity`·`entidad` · `tenant`·`despacho` · `user`·`usuario` · `role`·`rol` · `group`·`grupo` ·
`identity`·`identidad` · `token`·`token` · `approval`·`aprobacion` (**singular; `approvals rule set` pasa a `approval rule set`**) ·
`policy`·`politica` `pending \| resolved \| dismissed` (016:28) · `draft`·`borrador` `pending_review \| approved \| rejected` (011:16) ·
`question`·`duda` `pending \| answered \| dismissed` (013:15) · `session`·`sesion` · `memory`·`memoria` ·
`skill`·`habilidad` `pending_review \| approved \| rejected` (027:41) · `job`·`tarea` (**singular; los `jobs` de report.md y close-controls mueren**) ·
`webhook`·`gancho` `received \| processed \| duplicate \| rejected` (028:78) · `subscription`·`suscripcion` ·
`integration`·`integracion` `active \| inactive \| error \| expired \| revoked` (007:22) ·
`ai-provider`·(sin alias) (**antes `provider`·`proveedor`, que chocaba con el proveedor de CxP; término técnico, sin alias, precedente `chat`/`sat`/`doctor`**) ·
`secret`·`secreto` · `vault`·`boveda` · `config`·`configuracion` · `profile`·`perfil` (**separado de `config`, que tenía dos alias**) ·
`alias`·`alias` · `completion`·`completado` · `doc`·`doc` · `schema`·`esquema` (**`mnemosine explain <noun>` pasa a `schema show <noun>`; `explain` es sólo derivación**) ·
`log`·`bitacora` · `audit`·`auditoria` (**platform lo posee; el `audit log` de close-controls muere en favor de `audit list --actor`**) ·
`backup`·`respaldo` (**platform lo posee; los sustantivos `backup`, `archive` y `restore` de close-controls mueren**) ·
`inbox`·`bandeja` (**antes `buzon`, ahora libre del buzón fiscal**) · `outbox`·`envio` (**singular**) ·
`telemetry`·`telemetria` · `metric`·`metrica` (**singular**) · `db`·`base-datos` · `daemon`·`demonio` ·
`support`·`soporte` · `usage`·`uso` · `agent`·`agente` (**NUEVO: la superficie de rendición de cuentas que la lente de seguridad de la IA echó en falta**) ·
`web`·(sin alias) (**W0: la puerta de entrada del tablero en el navegador; `tablero` se queda con el `dashboard` de report.md, precedente `chat`/`sat`/`doctor`**).

Los sustantivos `api` y `onboarding` están **eliminados**: `api` es el cajón de sastre que R10 prohíbe y que anula el
sentido de una superficie auditada; las filas de `onboarding` pasan al comando raíz `onboard`.

### 2.13 Las ocho familias doblemente definidas — un dueño cada una, y en qué se convierte el perdedor

| Capacidad | Ganador | Perdedor → se convierte en |
|---|---|---|
| pagos salientes por lote | `payment-run` (ap.md) | `payment-batch create/validate/generate/transmit` de payroll.md → `payment-run prepare --source pay-run <id>`, luego los verbos de CxP |
| cheques en papel | `bank check` (bank.md) | `check *` de ap.md y `check print/void` de payroll.md → `bank check issue \| print→issue \| void \| stop→lock \| clear→reconcile \| remit` |
| ciclo 1099 | `1099` (fiscal-us.md) | `1099 check/prepare/export/submit` de ap.md → eliminado; CxP enlaza a fiscal-us |
| use tax | `use-tax` (fiscal-us.md) | `use-tax run` de ap.md → eliminado; el devengo de CxP es `ap accrue --kind use-tax` |
| constancias de retención | `withholding` (ap.md) | `retention issue/batch/list/validate/remit` de fiscal-mx.md → `withholding constancia issue \| list \| check \| remit` |
| variación / flux | `variance` (report.md) | `flux run/explain/review/report/ratio/threshold set` de close-controls.md → eliminado; `variance threshold set`·`variacion umbral fijar` es la única grafía |
| tabla de tipos de cambio | `fx rate` (ledger.md) | `fx-rate load/list/check`·`tipo-cambio` de report.md → eliminado; `fx rate import \| list \| check \| download \| set \| correct`·`cambio tipo …` |
| calendario de días festivos | `closing calendar` (close-controls.md) | `sat holiday sync` de fiscal-mx.md y `holiday-calendar load` de payroll.md → eliminados; ambos llaman a `closing calendar import` |

### 2.14 `entry` frente a `je` — el fallo

**`entry`·`poliza` (ledger.md) es el objeto. El sustantivo `je` no existe.** Es una abreviatura
(R5), duplica seis de los siete verbos de `entry`, y reclama el alias español idéntico
`poliza enviar`, lo cual es una falla dura de `bilingual-matrix.spec.ts`. close-controls.md elimina todo
el subgrupo `je` y traslada sus tres capacidades genuinamente nuevas a `entry` en ledger.md:

- `je submit` → **eliminar** (es `entry submit`, ya en ledger.md:73)
- `je queue` → **eliminar** (es `entry list --status pending_approval`)
- `je approve` / `je reject` / `je correct` → **eliminar** (ya están en `entry`)
- `je risk-scan` → fusionar con el `entry audit-scan` de ledger.md en **un** solo comando, `entry check --check risk`
- `je annotate` → `entry edit --note`

close-controls.md conserva exactamente una fila de ese subgrupo: `approval rule set|list|test`·`aprobacion regla fijar|listar|probar`.

---

## 3. DICCIONARIO DE BANDERAS

La única tabla de §II.4. Se eliminan todos los diccionarios por archivo: `close-controls.md:106`,
`fiscal-mx.md:13`, `payroll.md:24`, `bank.md:50`, `report.md:90-94`. Los conceptos nuevos obtienen una fila aquí, en
un solo lugar, con una prueba, y en ningún otro sitio.

**Fallo sobre banderas cortas.** El repositorio distribuido fija las formas cortas y el repositorio gana. Donde el propio repositorio
fija una bandera corta a dos nombres largos, gana el uso de mayor frecuencia y a nivel raíz:

- `-p` = `--provider` (mnemosine.ts:538, :560, :1072, :1179). **`-p, --period` en close-command.ts:75 pierde y debe quitarse**; `--period` no tiene forma corta en ninguna parte.
- `-n` = `--limit` (mnemosine.ts:896, sat-commands.ts:205, webhooks-command.ts:158). **`-n, --note` en pending-command.ts:194 y :250 pierde su forma corta**; **`-n, --dry-run` de §II.4 queda anulado**: `--dry-run` no tiene forma corta.
- `-l` = `--list` (mnemosine.ts:1276, :1417, close-command.ts:76). **`-l, --limit` de §II.4 queda anulado.**
- `-s` = `--status` (mnemosine.ts:957). `-s, --session` pierde su forma corta.
- `-b, --search` (memory-command.ts:70) se hereda sólo en `memory list`, obsoleto bajo R9; `--search` no tiene forma corta en otros lugares.
- `-T, --tenant <uuid>` se funde en `-t, --tenant`.
- `-f` nunca se asigna. Ni `--force`, ni `--file`.

### 3.1 Alcance

| Larga | Corta | Significado | Qué comandos |
|---|---|---|---|
| `--entity <idOrName>` | `-e` | limitar a una entidad legal; recurre al contexto actual | todo comando que toca datos de una entidad |
| `--all-entities` | ninguna | abanicar sobre toda entidad visible; salida en tabla, distinto de cero si algún elemento falla | cualquier comando de lectura o capaz de `--dry-run` |
| `--entity-query <expr>` | ninguna | seleccionar el conjunto de abanico para `--all-entities` | sólo con `--all-entities` |
| `--tenant <id>` | `-t` | alcance del despacho / contexto RLS | comandos de administración y entre despachos |
| `--user <email>` | `-u` | actor atribuido | todo comando que muta; absorbe `--approver`, `--owner` |
| `--profile <name>` | ninguna | perfil nombrado de conexión/credencial | `config`, `integration`, `ai-provider`, `sat` |
| `--config <path>` / `--no-config` | ninguna | anular / ignorar el archivo de configuración | raíz |
| `--set <key=value>` | `-c` | anulación de configuración de una sola vez, repetible | raíz |

### 3.2 Tiempo

| Larga | Corta | Significado | Qué comandos |
|---|---|---|---|
| `--period <expr>` | **ninguna** | periodo contable: `2026-01`, `2026-Q1`, `2026-B1`, `FY2026`, `last-month`, `2026-01..2026-06` | todo comando con alcance de periodo. **Absorbe `--month`, `--quarter`, `--bimester`, `--week`** |
| `--year <n>` | ninguna | año calendario de una declaración informativa o un ejercicio fiscal | sólo comandos fiscales y de cierre anual de nómina |
| `--as-of <date>` | ninguna | fecha de saldo/valuación a un momento dado. **Absorbe `--date`** | saldo, antigüedad, valuación, `ytd` |
| `--since <date>` / `--until <date>` | ninguna | límites inclusivos de un rango. **Absorbe `--from`/`--to`, `--start`/`--end`** | todo `list`, `history`, `export` |
| `--within <duration>` | ninguna | horizonte hacia adelante relativo a hoy (`30d`, `2w`): un `--until` absoluto no puede expresar «lo que vence pronto» | `obligation`, `filing`, `invoice`, `bill`, `promise` |
| `--date-basis <document\|posting\|value>` | ninguna | a cuál de las tres fechas se aplican los filtros; por defecto `posting` | toda lectura filtrada por fecha |
| `--interval <day\|week\|month\|quarter\|year>` | `-M`/`-Q`/`-Y` | agrupación en columnas | renderizadores de reportes y de registros |

### 3.3 Selección

| Larga | Corta | Significado | Qué comandos |
|---|---|---|---|
| *(consulta posicional)* | — | términos al estilo hledger: `acct:`, `desc:`, `amt:`, `cur:`, `tag:`, `dim:<name>=<value>`, `not:`, `or:` | todo `list` |
| `--account <pattern>` | ninguna | atajo de `acct:`; repetible | lecturas de ledger, bank, report |
| `--status <state>` | `-s` | filtrar por un estado R7 publicado; repetible | todo `list` sobre un sustantivo con estados |
| `--limit <n>` | `-n` | máximo de filas; 50 por defecto en interactivo, ilimitado con `--json` | todo `list` |
| `--offset <n>` / `--cursor <token>` | ninguna | paginación | todo `list` |
| `--all` | `-a` | desactivar el límite por defecto; incluir archivados y cerrados | todo `list` |
| `--list` | `-l` | modo sólo-lista de un comando que de otro modo es interactivo | `review`, `close`, `outbox`, `question`, `pending` |
| `--check <name,…>` | ninguna | seleccionar diagnósticos nombrados; **sin valor, imprime los nombres de verificación disponibles**. **Absorbe todo `[check...]`/`[codes...]` posicional** | todo `<noun> check` |
| `--scope <family>` | ninguna | de qué familia se diagnostica la salud del sistema | **sólo** `doctor`. **`doctor --check bank.*` (bank.md:192) pierde** |
| `--vs <ref>` | ninguna | el otro lado de una comparación. **Absorbe `--a`/`--b` (report.md) y `--against` (5 archivos)** | todo `diff` |
| `--fields <a,b,c>` | ninguna | selección de columnas; sin valor, imprime los nombres de campo disponibles | todo `list`/`show` |

### 3.4 Salida

| Larga | Corta | Significado | Qué comandos |
|---|---|---|---|
| `--format <table\|json\|ndjson\|csv\|tsv\|xlsx\|pdf\|xml\|md>` | ninguna | formato de salida. **Absorbe `--fmt`** | toda lectura |
| `--json` | ninguna | atajo documentado de `--format json` (ya distribuido en 12 lugares) | toda lectura |
| `--output <path>` | `-o` | escribir la salida en un archivo en vez de stdout. Es una redirección, no un volcado: el archivo contiene exactamente lo que el comando habría impreso, así que un comando que renderiza más de una vez (`cfdi show`: encabezado, luego líneas) añade dentro de la corrida, y una corrida nueva trunca, como `>`. Las notas y advertencias se quedan en stderr. **`--out` (fiscal-mx.md:13, 16 filas) pierde** | toda lectura que puede producir un archivo |
| `--file <path>` / `--dir <path>` | ninguna | leer la entrada de un archivo / un directorio. **`--from-file` (ar, ap, platform, payroll) pierde** | todo `import`, `apply`, `create --file` |
| `--generate-skeleton` | ninguna | emitir un documento JSON vacío y comentado para un objeto complejo | `entry`, `cfdi`, `pay-run`, `bill`, `invoice`, `report definition` |
| `--jq <expr>` | ninguna | postfiltro de JSON; exige un formato JSON | toda lectura |
| `--quiet` | `-q` | sólo identificadores, uno por línea, para tuberías | todo `list` |
| `--verbose` | `-v` | más detalle, repetible | todo comando |
| `--redacted` | ninguna | enmascarar identificadores fiscales (RFC, CURP, NSS, SSN, TIN) en la salida | todo comando que puede imprimir identificadores de una persona |
| `--no-color` / `--no-pager` / `--null` (`-z`) | `-z` para `--null` | comportamiento de la terminal | toda lectura |

### 3.5 Seguridad y mutación

| Larga | Corta | Significado | Qué comandos |
|---|---|---|---|
| `--dry-run` | **ninguna** | calcular y mostrar el efecto completo, no escribir nada, no llamar nada externo. **Absorbe `--validate-only` (assets-inventory ×4) y `--plan`** | todo comando que muta; **obligatorio** en el peldaño ≥ 3 |
| `--yes` | `-y` | omitir una confirmación interactiva. **`--confirm` (fiscal-us ×7, payroll ×3) pierde** | todo comando que confirma |
| `--force` | **ninguna, nunca `-f`** | anular una regla de seguridad que bloquea (periodo cerrado, fecha de bloqueo, referencia duplicada); **siempre exige `--reason`** | comandos con una validación dura que se puede anular |
| `--reason <text>` | ninguna | justificación obligatoria → `audit_log.reason`. Se exige con `--force`, `reverse`, `void`, `reopen`, `unlock`, `cancel`, `reject`, `archive`, `revoke` | los listados |
| `--note <text>` | ninguna | anotación libre, **nunca una justificación**. Absorbe `annotate` | `entry`, `draft`, `task`, `pending`, `question` |
| `--idempotency-key <k>` | ninguna | llave de deduplicación del cliente; el valor por defecto determinista se deriva de la carga. **Obligatoria en todo comando de peldaño ≥ 3 y toda escritura externa**: esto zanja ledger.md (sólo 4 cargas) frente a close-controls.md (todo) frente a bank.md («esta sección no la inventa») | los indicados |
| `--live` | ninguna | ejecutar el efecto externo real; por defecto es el punto de acceso sandbox. **`--test` y `--sandbox` pierden** | todo comando que llama a un PAC, al SAT, a un banco, o envía correo |
| `--strict` | ninguna | hacer que las advertencias fallen (convierte un `check` de sólo advertencias en salida 4) | todo `check`, `verify`, `reconcile` |
| `--no-input` | ninguna | nunca preguntar; fallar con un mensaje claro. Implícito cuando stdin no es un TTY | todo comando interactivo |
| `--watch` | ninguna | transmitir/seguir | `job`, `inbox`, `outbox`, `ingest`, `webhook` |
| `--stop-at <step>` / `--resume` | ninguna | control del orquestador: detenerse antes de una compuerta nombrada / continuar donde se detuvo | `payroll run`, `bank reconciliation run`, `closing run`, `sat download` |
| `--journal <file>` | ninguna | escribir el mapa origen→destino de cada documento reasignado, para poder deshacer una fusión a mano | `account merge`, `customer merge`, `vendor merge` |
| `--teach <criterion>` | ninguna | acuñar un precedente de memoria a partir de un rechazo humano | `draft reject` |
| `--raise` | ninguna | publicar cada hallazgo por encima del umbral como una duda abierta | `anomaly check`, `variance check`, `control check` |
| `--provider <name>` | `-p` | proveedor de IA. **Ya fijado por el repositorio: no reutilizar `-p`** | `ask`, `chat`, `job`, `ai-provider` |
| `--model <name>` | `-m` | modelo dentro del proveedor (fijado por el repositorio) | `ask`, `chat`, `job` |

---

## 4. CONTRATO DE CÓDIGOS DE SALIDA

`research/cli-ux.md` §II.7 publica una tabla. Es la constitución y gana sobre los cinco
esquemas por archivo. Se publica **una vez**, en el preámbulo del catálogo, y no se repite en ningún archivo de sección.

| Código | Significado | Notas |
|---|---|---|
| `0` | éxito, incluido un `check` limpio y un acierto de idempotencia cuyo resultado es idéntico | semántica de `kubectl apply`: una repetición por cron no debe despertar a nadie |
| `1` | falla genérica | último recurso; preferir un código específico |
| `2` | error de uso: bandera incorrecta, argumento faltante, subcomando desconocido | |
| `3` | no encontrado: la entidad, póliza, cuenta, periodo o documento no existe | |
| `4` | **validación fallida**: póliza descuadrada, regla NIF/GAAP violada, esquema inválido, **y el código que devuelve un comando `check` cuando encuentra un hallazgo bloqueante** | |
| `5` | bloqueado por estado: periodo cerrado o bloqueado, fecha de bloqueo, póliza ya contabilizada, credencial vencida | |
| `6` | conflicto: misma llave de idempotencia, distinta carga | |
| `7` | permiso denegado: RLS, rol, acceso a la entidad, política de aprobación | |
| `8` | falló un servicio externo: el PAC, el SAT, el banco o Contalink estuvo inalcanzable, agotó el tiempo, respondió 5xx/408/429, o devolvió un cuerpo que no es el JSON prometido. **Reintentable** | `ExternalServiceError` (HTTP 502) es el productor; `STATUS_TO_EXIT` asigna 502/503/504 aquí. `scripts/eval-clasificador.ts` también sale con 8 cuando falla el proveedor del modelo |
| `9` | un servicio externo rechazó: SAT 5002, CFDI rechazado, un 4xx del proveedor (credencial inválida, RFC no autorizado, carga que nunca aceptará), o un sobre del proveedor que dice que no. **No reintentable: nunca reintentar a ciegas** | `ExternalRejectedError` (HTTP 424 Failed Dependency) es el productor; `STATUS_TO_EXIT` asigna 424 aquí |
| `10` | abortado por el usuario: rechazó la confirmación | |
| `11` | **requiere humano**: se planteó una duda o un borrador espera revisión. `--json` lleva tanto los éxitos como los pendientes abiertos | el código que hace seguro un flujo guiado por agente |
| `130` | interrumpido (SIGINT) | |

### 4.1 La convención de diagnóstico — decidida una sola vez

**Un comando `check` que encuentra problemas sale con `4`, no con `0`.** Los hallazgos también van en la carga;
el código de salida no los sustituye, es lo que permite que `mnemosine ledger check` entre en CI
y en un ejecutor de `jobs` sin cambios (el truco de `git diff --exit-code`, nombrado en `cli-ux.md:759`).

- limpio → `0`
- hallazgos bloqueantes → `4`
- hallazgos sólo de advertencia → `0`, **salvo con `--strict`, que los vuelve `4`**
- el chequeo no pudo correr (sin conexión, selector inválido) → `1`, `2`, `3` u `8` según corresponda, nunca `4`
- hallazgos que requieren una decisión humana y no una corrección → `11`

### 4.2 El par externo, y qué devuelve un lote

`8` y `9` suenan parecido para un humano y significan lo opuesto para un cron: `8` dice *reintenta*, `9`
dice *esto nunca va a funcionar, detente*. Sólo vale la pena publicarlos si el binario realmente puede distinguirlos,
así que la clasificación se hace una vez, en la frontera donde existe la evidencia (el
adaptador que hizo la llamada) y se preserva desde ahí hasta `process.exit`:

- el adaptador lanza `ExternalServiceError` (502) o `ExternalRejectedError` (424);
- `executeExternalOp` relanza esos dos sin cambios en vez de aplastarlos en un
  `Error` simple, que antes borraba el veredicto en el último paso;
- `exitCodeFor` asigna el estado a `8` o `9`.

Un comando que sigue adelante después de cada falla (`outbox run` con ids explícitos: la hoja que llama un ejecutor
de tareas) no puede lanzar, así que **compone** su código con `batchExitCode`: una falla reintentable
domina, porque si una operación aún puede tener éxito vale la pena repetir el lote, y las
operaciones ya rechazadas dejan de estar `pending` y por tanto no se llaman una segunda vez. Sólo cuando
toda falla fue un rechazo definitivo el lote mismo sale con `9`.

**Eliminados:** ap.md:71 (`bill match` sale con 2), close-controls.md:75 (0/2/3), report.md:227 (2 =
precondición incumplida, 3 = error de integridad), bank.md:50 («1 en falla, nunca en advertencia»), ledger.md:8
(«distinto de cero en falla»). ap.md:267 y platform.md:48 ya dicen 4 y son **correctos**: se quedan.

---

## 5. RESOLUCIÓN DE CONFLICTOS

Cada choque entre archivos, su resolución y la reescritura exacta, dirigida al archivo que debe cambiar.

| # | Choque | Resolución | Reescritura requerida |
|---|---|---|---|
| 1 | `entry`·`poliza` (ledger) frente a `je`·`poliza` (close-controls): alias idéntico, falla dura de prueba | gana `entry`; `je` no existe | **close-controls.md:126-132**: eliminar las siete filas de `je`. Fundir `risk-scan` en `entry check --check risk` de ledger.md (fusionándolo con `entry audit-scan`, que es la misma capacidad bajo un tercer nombre) y `annotate` en `entry edit --note`. Conservar sólo `approval rule set\|list\|test` |
| 2 | `proveedor listar` reclamado por `vendor list` (ap) y `provider list` (platform) | CxP conserva `vendor`·`proveedor` | **platform.md:53-56**: renombrar el sustantivo `provider` → `ai-provider`, **sin alias en español** (término técnico; precedente `chat`, `sat`, `doctor`) |
| 3 | `anticipo aplicar` reclamado por `advance apply` (ar) y `advance apply` (fiscal-mx), idénticos en ambos idiomas | CxC posee `advance`·`anticipo`, como ya adjudicó ap.md:39 | **fiscal-mx.md:56**: eliminar la fila. La ruta del anticipo CFDI es una bandera: `advance apply --cfdi` en ar.md:137 |
| 4 | `usuario listar`, `usuario ver`, `rol listar`, `rol otorgar`, `rol revocar` reclamados dos veces | platform.md posee la identidad | **close-controls.md:172-181**: eliminar `user *` y `role *`. `user entity grant/revoke` → `user access add/remove` de platform.md:81-82. close-controls conserva `permission`, `delegation`, `auditor` |
| 5 | `doc list`: mismo inglés, dos significados, dos alias | platform conserva `doc`·`doc` (temas de ayuda) | **close-controls.md:224-226**: renombrar `doc attach\|list\|verify` → `document attach\|list\|check`·`documento adjuntar\|listar\|verificar` |
| 6 | `close` es una hoja con once banderas y un grupo con 34 subcomandos | `close`·`cierre` sigue siendo la **hoja guiada de cierre de periodo**; el *proceso* de cierre pasa a ser el sustantivo `closing`·`cierre-proceso` | **close-controls.md:49-87**: renombrar cada fila `close <sub>` a `closing <sub>` (`closing task list`, `closing calendar import`, `closing signoff`→`closing approve`, `closing template …`, `closing run …`, `closing pack generate`). **Eliminar la afirmación de close-controls.md:75 de que `close check` reemplaza a `close --check`**: `close --check` se queda y cuatro archivos dependen de él. `close` conserva `--check --hard --yes --reason --period --subledger --jurisdiction --carry-forward-only --reopen --list --json` |
| 7 | `cierre --reabrir` mezcla un alias en español con una bandera en español | las banderas nunca se traducen (bilingual-matrix.spec.ts:149-153) | **ap.md:165**: `close --reopen` · `cierre --reopen` |
| 8 | Tres diccionarios de banderas, dos reasignando banderas cortas fijadas por el repositorio | §3 de arriba es el único diccionario | **close-controls.md:106**, **fiscal-mx.md:13**, **payroll.md:24**, **bank.md:50**, **report.md:90-94**: eliminar los diccionarios. **fiscal-mx.md**: `--out` → `--output` en las 16 filas. **close-controls.md**: `-l/--limit` → `-n/--limit`, `-n/--dry-run` → `--dry-run`, `-p/--period` → `--period`. **close-command.ts:75**: quitar `-p` de `--period` |
| 9 | Cinco contratos de códigos de salida | §4 de arriba | **ap.md:71**, **close-controls.md:75**, **report.md:227**, **bank.md:50**, **ledger.md:8**: eliminar los contratos locales y citar el preámbulo |
| 10 | `ar check [check...]` / `ap check --check a,b` / `ledger check [name...]` / `close check [codes...]` | `--check <name,…>` en todas partes, y un `--check` sin valor lista los nombres disponibles | **ar.md:216**, **ledger.md:172**, **close-controls.md:75**: convertir a la forma con bandera. **ledger.md:173-178**: eliminar las seis filas de argumento |
| 11 | `job` frente a `jobs`, `approval` frente a `approvals` | singular (R2) | **report.md:94-95**: `job create`·`tarea crear`, `job run-due`·`tarea ejecutar-vencidas`. **close-controls.md:87**: `job create --kind close_verification`·`tarea crear`. **close-controls.md:133-135**: `approval rule set\|list\|test`·`aprobacion regla fijar\|listar\|probar`. **ap.md:131**, **ar.md:20**: corregir las referencias en prosa a `question` y `job` |
| 12 | `payment-run` (ap) frente a `payment-batch` (payroll) | gana CxP | **payroll.md:132-140**: eliminar; reemplazar por una fila `payment-run prepare --source pay-run <id>` que apunte a ap.md |
| 13 | cheques en papel en tres archivos, y el sustantivo `check` choca con el verbo `check` | gana bank.md, a profundidad 3 | **ap.md:206-209**, **payroll.md:142-143**: eliminar. **bank.md:140-149**: `bank check issue\|list\|void\|lock\|reconcile\|remit`·`banco cheque …`; `print`→`issue`, `stop`→`lock`, `clear`→`reconcile`, `stale`→`--status stale`, `escheat`→`remit --to unclaimed-property` |
| 14 | 1099 y use-tax en ap y fiscal-us | gana fiscal-us | **ap.md:225-229**: eliminar. El devengo del lado de CxP es `ap accrue --kind use-tax` |
| 15 | constancias de retención en ap y fiscal-mx | gana ap | **fiscal-mx.md:146-150**: eliminar; `withholding constancia issue\|list\|check\|remit` en ap.md |
| 16 | `flux` (close-controls) frente a `variance` (report) | gana report | **close-controls.md:113-118**: eliminar. `variance threshold set`·`variacion umbral fijar` es la única grafía |
| 17 | `fx rate` (ledger) frente a `fx-rate` (report) | gana ledger | **report.md:187-189**: eliminar. ledger.md:152-157 pasa a `fx rate list\|show\|set\|download\|import\|correct`·`cambio tipo …` (`fetch`→`download`) |
| 18 | calendario de días festivos en tres archivos | gana close-controls | **fiscal-mx.md:39** y **payroll.md:91**: eliminar; ambos llaman a `closing calendar import` |
| 19 | respaldo y rastro de auditoría en close-controls y platform | gana platform | **close-controls.md:208-213** y **:147-154**: eliminar, salvo `audit verify` y `audit immutability check`, que se quedan (criptográficos). `audit list` de platform.md:213 gana `--actor`, `--action`, `--object` y el valor documentado `--actor agent` |
| 20 | `tax-deposit`·`deposito-fiscal` (fiscal-us) frente a ·`entero` (payroll) | nómina posee el sustantivo, alias `entero` | **fiscal-us.md:121-123**: eliminar; enlazar a nómina |
| 21 | `filing` poseído por tres archivos, `amend` escrito de tres maneras | fiscal-mx posee el sustantivo | **fiscal-us.md:162-167**, **payroll.md:211-218**: eliminar las filas; aportar sólo valores de `--form`. `amend` → `correct`·`corregir` en todas partes; los alias `complementaria`/`complementar` mueren |
| 22 | `obligation` poseído por tres archivos | fiscal-mx posee el sustantivo | **fiscal-us.md**, **payroll.md**: aportar sólo valores de `--jurisdiction`/`--form` |
| 23 | `card` recreado en ap después de que bank lo disolviera | gana bank.md:54 | **ap.md:248-253**: eliminar; una tarjeta de crédito es `bank account --type credit-card` |
| 24 | `recon` y `bank reconcile <verb>` (sustantivo-verbo-verbo) | `reconciliation`·`conciliacion` | **close-controls.md:93-107**: `recon` → `reconciliation`. **bank.md:117-131**: `bank reconcile <verb>` → `bank reconciliation <verb>`·`banco conciliacion <verbo>` |
| 25 | `conciliar` cubre `reconcile` y `match`; `match` se asigna a `cotejar` y `cruce` | `match`·`cotejar`, `reconcile`·`conciliar`, disjuntos en ambos idiomas | **ar.md:129**: `receipt match`·`cobro cotejar`. **bank.md:101-111**: `banco cruce …` → `banco cotejo …` |
| 26 | `check`/`verify`/`validate`/`lint`/`screen`/`test` son seis grafías de un acto; `revisar` cubre seis verbos en inglés | `check`·`verificar` (local), `verify`·`comprobar` (externo/criptográfico), `test`·`probar` (dependencia viva), `review`·`revisar` (sólo raíz) | **ar.md:25**→`customer tax check`; **fiscal-mx.md:46**→`cfdi check`; **payroll.md:214**→`filing check`; **report.md:86**→`report definition check`; **assets-inventory.md:37**→`asset map check`; **ledger.md:41**→`chart check`; **fiscal-mx.md:112**→`party check`; **bank.md:41**→`bank statement check`; **report.md:174**→`consolidation check <run>` fusionado con report.md:169. `verify`·`comprobar` sobrevive **sólo** en close-controls.md:151, :165, bank.md:68, payroll.md:230, y el `backup verify` de platform |
| 27 | `mostrar` (report ×11), `diferencias` (report ×5), `correr` (payroll ×6), `calcular` por `run` (fiscal-us ×5) | una palabra en español por verbo en inglés | **report.md**: `mostrar`→`ver` (11 filas); `statement render`→`statement show`; `disclosure render`→`disclosure generate`; `diferencias`/`diferencia`→`comparar` (:24,:42,:88,:106,:144,:199 y fiscal-mx.md:167). **payroll.md**: `correr`→`ejecutar` (6 filas). **fiscal-us.md:100,:103,:109,:117,:130**: renombrar el **verbo**: `run`→`calculate`·`calcular` |
| 28 | `accrual run` definido dos veces con dos significados y dos alias; `calculate` frente a `compute` | `accrue`·`devengar`; `calculate`·`calcular` | **ap.md:141-143**→`ap accrue` / `ap accrual list` / `ap accrual reverse`. **payroll.md:244-246**→`payroll accrue` / `payroll accrual show` / `payroll accrual reverse`. Reemplazar los cinco `compute` por `calculate`. **assets-inventory.md:203-204**: `inventory reserve compute\|post` → `inventory allowance calculate\|post`, compartiendo el `allowance`·`estimacion` de CxC |
| 29 | `doctor --scope` frente a `<family> check` frente a `<family> doctor` | `doctor --scope <family>` para la salud del sistema; `<noun> check` para las invariantes del dominio | **assets-inventory.md:135, :215**: eliminar `asset doctor` / `inventory doctor`; fundir en `asset check` / `inventory check`. **bank.md:192**: `doctor --check bank.*` → `doctor --scope bank`. **fiscal-mx.md:129**: → `doctor --scope fiscal-mx` |
| 30 | 24 filas son un comando con un argumento | colapsar | **ledger.md:183-191** → `tie-out check --scope <subledger>`·`amarre verificar` (una fila, poseída por report.md); eliminar `ledger tieout`, **close-controls.md:81** `close tie`, **close-controls.md:236** `tieout build`, **report.md:198** `disclosure tie-out`. **payroll.md:261-269** → `payroll export <report>`·`nomina exportar` con los nueve nombres como argumento enumerado |
| 31 | ~155 filas que terminan en sustantivo, legalizadas en prosa por bank.md:50 | tachado | **bank.md:50**: eliminar el párrafo de la excepción. Toda fila que termina en sustantivo en bank (25), ar (8), assets-inventory (18), ledger (24), report (17), fiscal-mx (28), close-controls (16), payroll (18) recibe su verbo añadido: `list` para un conjunto, `show` para un objeto |
| 32 | `explain` significa a la vez derivación e introspección de esquema | `explain` = sólo derivación | **platform.md:220**: `mnemosine explain <noun>` → `mnemosine schema show <noun>`·`esquema ver`, con `--states` |
| 33 | `dr`, `pbc`, `je`, `recon`, `grni`, `rep`, `na`: abreviaturas | la lista permitida de R2 se amplía a exactamente `cfdi, sat, rfc, iva, isr, isn, diot, gl, ap, ar, fx, imss, ptu, sbc, ssn, sui, pac, rep, pbc, grni, kpi, utp, fbar, xbrl, sod, w2, w3, w4, w8, w9, efw2, inpc` | **close-controls.md**: `dr`→`continuity`·`continuidad`; `recon`→`reconciliation`; `close task na`→`closing task dismiss --reason not-applicable`; `requerimientos`→`pbc` |
| 34 | Morfología de los alias en español: infinitivos frente a imperativos conjugados, singular frente a plural | infinitivos, sin acento, una palabra; sustantivos en singular | **tests/cli/bilingual-matrix.spec.ts:57-64**: `memory {add\|agregar, correct\|corregir, archive\|archivar, restore\|restaurar}`; retirar `enseña`, `ensena`, `corrige`, `retira`, `restaura` bajo R9. `pending define\|definir` → `pending create\|crear` (esto libera `definir`, que cubría dos verbos en inglés). Los alias plurales de **TOP_LEVEL** (`entidades`, `borradores`, `tareas`, `sesiones`, `dudas`, `envios`, `habilidades`, `ganchos`, `aprobaciones`, `proveedores`, `pendientes`) pasan a singular, y los plurales se quedan como alias R9 con advertencia en stderr |
| 35 | Español coloquial e inconsistente para la recuperación externa | `download`·`descargar` para un artefacto, `sync`·`sincronizar` para un catálogo o flujo | **platform.md:162**: `inbox pull`·`buzon jalar` → `inbox sync`·`bandeja sincronizar`. **ap.md:126**: eliminar (duplicado de `cfdi status sync` de fiscal-mx.md:98). **ap.md:125**: eliminar (`sat download` es un sustantivo en fiscal-mx). **fiscal-mx.md:79, :174**, **ledger.md:155**, **bank.md:38, :67**: `fetch`→`download`·`descargar` |
| 36 | `inbox`·`buzon` (platform) frente a `buzon`·`buzon` (fiscal-mx), y `buzon` es un canónico en español | sólo canónicos en inglés (R8) | **fiscal-mx.md**: `buzon` → `tax-mailbox`·`buzon`. **platform.md**: `inbox`·`buzon` → `inbox`·`bandeja` |
| 37 | `retencion` reclamado por `withholding` de CxP, `retention` de fiscal-mx, `retention` de close-controls | `withholding`·`retencion` de CxP | **fiscal-mx.md:146-150**: eliminado (resolución 15). **close-controls.md:199**: `retention`·`retencion` → `data-retention`·`conservacion` |
| 38 | `prorrateo` reclamado por `allocation` de ledger y `apportionment` de fiscal-us | `allocation`·`prorrateo` de ledger | **fiscal-us.md:109**: `apportionment`·`prorrateo` → `apportionment`·`atribucion` |
| 39 | `provision` reclamado por `provision` de fiscal-us y `accrual`·`provision` de payroll | fiscal-us | **payroll.md:244**: resuelto por la resolución 28 — `payroll accrue`·`nomina devengar` |
| 40 | `estado` reclamado por `status` y por `bank statement`·`banco estado` | `status`·`estado` (alias de sustantivo heredado, fijado por `sat cred status\|estado`) | **bank.md**: `bank statement` → `banco estado-cuenta` |
| 41 | los sustantivos `archivo`/`restauracion` chocan con los verbos `archive`/`restore` | ganan los verbos | **close-controls.md**: eliminar los sustantivos `archive` y `restore`; sus filas pasan a `backup create\|list\|verify\|restore`·`respaldo …` en platform.md |
| 42 | `config`·`configuracion` y `config`·`perfil`: un sustantivo, dos alias | separar el sustantivo | **platform.md**: `config`·`configuracion` y un `profile`·`perfil` aparte |
| 43 | `writeoff` / `write-off` / `writedown`; `carryforward` / `carry-forward`; `desechar` en dos verbos | una grafía cada uno | **ap.md:145, :160**: `writeoff`→`write-off`. **assets-inventory.md:205-206**: `inventory writedown`→`inventory write-down`, ambas filas con alias sobre el sustantivo (`inventario castigo aplicar` / `inventario castigo reversar`). **ledger.md:136**: `carryforward`→`carry-forward`. **assets-inventory.md:115**: `asset write-off`·`activo desechar` → `activo castigar`, dejando `desechar` para `inventory scrap` |
| 44 | Dos válvulas de escape comodín (R10) | ambas eliminadas | **platform.md:29**: eliminar `entity run --entity-query -- <subcommand...>`; el abanico es `--all-entities [--entity-query <expr>]` en cualquier comando. **platform.md:219**: eliminar `mnemosine api <method> <path>`: una válvula REST sin compuertas deja alcanzable todo endpoint del backend sin aparecer en el catálogo, que es justo lo contrario del sentido de una superficie auditada |
| 45 | Sin maestro de dimensiones, 27 comandos dependen de uno | ledger.md posee `dimension`·`dimension` | **ledger.md**: añadir `dimension create <type> <code>`·`dimension crear`, `dimension list [type]`·`dimension listar`, `dimension archive <type> <code>`·`dimension archivar`, `dimension policy set`·`dimension politica fijar` (la lente de completitud propuso `define`/`retire`/`definir`; ambos verbos quedan fuera de §1: `create`/`archive`). Corregir la celda de Backend de las seis filas autobloqueadas para que nombre `dimension create` como prerrequisito declarado |
| 46 | `mnemosine ingest` lleva marcas de IA opuestas en dos archivos | una fila por invocación | **fiscal-mx.md:94**: riesgo `irreversible`, IA `✗`, eliminar `--auto-post`/`--no-auto-post`; platform.md:160 es la fila canónica |
| 47 | `ask` es `✗` en platform.md:96 y `✓` en report.md:213; `job run`/`job run-due` son `✓` | todo comando que abre una sesión de agente es `✗` | **report.md:213**: IA `✗`. **platform.md:145-146**: IA `✗`. **platform.md:9** regla (e) ampliada para nombrar `chat`, `ask`, `job run`, `job run-due`, `inbox watch` |
| 48 | La etiqueta de IA y el peldaño discrepan en 12 comandos y no tienen un hogar legible por máquina | una sección dueña por comando; la etiqueta viaja en el catálogo generado | **platform.md:231**: `doc export --format json` emite `agent: read\|draft\|never` junto al peldaño. Añadir la prueba tests/cli/catalog-consistency.spec.ts (aún no existe) que afirme que cada invocación canónica corresponde a exactamente un par `(riesgo, IA)`. `period *` y `year *` pertenecen a **ledger.md** (eliminar close-controls.md:33-36, :39-41) |
| 49 | Los valores de `--status` difieren por archivo para el mismo objeto | el CHECK del esquema es la máquina de estados (§2) | toda sección: reescribir las listas de valores de `--status` para que coincidan con §2, y eliminar cualquier estado inventado que no esté en el CHECK, salvo que la fila proponga explícitamente ampliarlo y lo diga |

---

## 6. INSTRUCCIONES DEL NORMALIZADOR

Aplíquense mecánicamente a su sección. No se negocia ninguna; todo conflicto que tocan
ya está resuelto en §5.

1. **Posición del verbo.** En cada fila, el último token antes de los argumentos debe ser un verbo de §1. Si es
   un sustantivo, añadir el verbo que la fila realmente ejecuta (`list` para un conjunto, `show` para un objeto). Si
   es un verbo fuera de §1, reemplazarlo por el verbo que lo absorbe (§1.5).
2. **Verbo en español.** Reemplazar el último token en español por la única palabra que §1 asigna al verbo
   en inglés. Nunca inventar una segunda grafía. Infinitivo, sin acento, una palabra.
3. **Sustantivo y alias.** Usar el sustantivo canónico y el único alias en español de §2. En singular, canónico
   en inglés, minúsculas, con guion. Si su archivo no es el dueño de un sustantivo, eliminar la fila y añadir
   una línea que apunte al dueño.
4. **Profundidad.** Máximo 3 tokens antes de los argumentos. Un comando de tres tokens es `<noun> <qualifier-noun>
   <verb>`, nunca `<noun> <verb> <verb>`.
5. **Banderas.** Toda bandera debe aparecer en §3 con la misma grafía, aridad y significado. Eliminar cualquier
   diccionario local de banderas de su preámbulo. Reemplazar las perdedoras: `--out`→`--output`,
   `--from-file`→`--file`, `--confirm`→`--yes`, `--validate-only`/`--plan`→`--dry-run`,
   `--a`/`--b`/`--against`→`--vs`, `--fmt`→`--format`, `--date`→`--as-of`, `--from`/`--to`→
   `--since`/`--until`, `--month`/`--quarter`/`--bimester`/`--week`→`--period`, `[check...]`
   posicional→`--check <name,…>`.
6. **Banderas cortas.** Sólo existen éstas: `-e --entity`, `-t --tenant`, `-u --user`, `-p --provider`,
   `-m --model`, `-n --limit`, `-l --list`, `-s --status`, `-a --all`, `-y --yes`, `-o --output`,
   `-q --quiet`, `-v --verbose`, `-c --set`, `-z --null`, `-M/-Q/-Y --interval`. Cualquier otra pierde
   su forma corta. `-f` nunca se asigna.
7. **Las banderas nunca se traducen.** Una fila de alias en español muestra banderas en inglés. `cierre --reabrir`
   es una falla de prueba.
8. **Códigos de salida.** Eliminar de su archivo toda afirmación sobre códigos de salida y citar §4. Si una fila menciona un
   código de salida, sólo puede ser `4` (un `check` que encontró hallazgos bloqueantes) u `11` (requiere humano).
9. **Las filas de peldaño ≥ 3** deben llevar `--dry-run`, `--yes`, `--reason` donde se requiera una justificación,
   y `--idempotency-key`. Añadirlos si faltan.
10. **Colapsar las filas de argumento.** Si N filas difieren sólo en su último token y comparten un alias
    en español, son un comando con un argumento enumerado. Escribir la fila única y eliminar las N.
11. **Un `(riesgo, IA)` por invocación.** Si su fila duplica un comando poseído por otro archivo,
    eliminarla. La división ✓/✗ nunca puede depender del valor de una bandera: si depende, dividir el comando en dos
    (`year preview-close` / `year close`, `sat download sync` / `sat download request`).
12. **El PII se refiere a los datos, no al formato.** Todo comando que materializa identificadores fiscales (RFC,
    CURP, NSS, SSN, TIN) de más de una persona es IA `✗`, se llame `prepare`,
    `generate` o `export`. Dar al agente un lector `--redacted` en su lugar.
13. **Credenciales de clientes.** Todo comando que consume una credencial de cliente (bóveda, integración,
    buzón, PAC, banco, SAT) contra un tercero es IA `✗`, sin excepción. Donde la lectura sea
    valiosa, separar la llamada con credencial del espejo local y dejar sólo el espejo como `✓`.
14. **Los fijadores de política son `✗`.** Fijar una política contable, un libro que contabiliza o la frecuencia de
    un control nunca es decisión del agente. Publicar la mitad de lectura (`<noun> show`) como `✓`.
15. **Máquinas de estados.** Reescribir cada lista de valores de `--status` a los estados publicados del sustantivo en §2.
    Un estado que no esté en el CHECK del esquema sólo puede aparecer si la fila dice explícitamente que el CHECK debe
    ampliarse.
16. **Obsolescencias.** Todo nombre que renombre va a la lista R9 con su grafía anterior, un aviso en
    stderr y una versión de retiro. No eliminar en silencio un nombre que el repositorio distribuye.
17. **Preámbulo.** Eliminar de su preámbulo todo lo que este archivo ahora posee: tablas de verbos, tablas de banderas,
    códigos de salida, morfología de alias, la posición de `--idempotency-key`, el argumento `doctor` frente a `check`,
    y cualquier sección de «convenciones que atraviesan todas las tablas». Reemplazarlo con una línea que cite
    `REGISTRY.md`.
18. **Fase.** Volver a marcar la fase 1 contra la única prueba escrita «los comandos necesarios para abrir los
    libros, registrar un mes, cerrarlo y declarar». Metas: ledger 25 · ar 15 · ap 15 · bank 15 ·
    report 15 · fiscal-mx 20 · payroll 10 · platform 20 · close-controls 10 · assets-inventory 5 ·
    fiscal-us 5. ap.md, assets-inventory.md y platform.md lo hacen primero: concentran 208 de los 589.
