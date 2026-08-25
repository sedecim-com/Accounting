# REGISTRY — the binding dictionaries of the mnemosine command tree

**Status: binding.** This file outranks all eleven section files. Where a section disagrees with this
file, the section is wrong and must be rewritten. Where this file is silent, `research/cli-ux.md`
PART III governs; where that is also silent, the section author decides and records the decision in
this file's Conflict Rulings table by amendment.

**Authority order.** (1) the shipping repo — `src/cli/` and `tests/cli/bilingual-matrix.spec.ts`;
a name that collides with a shipped one is a test failure, not an opinion. (2) `research/cli-ux.md`
PART III (R1–R12) and §II.4/§II.7. (3) this file. (4) the section files.

**Three global invariants this file exists to guarantee:**

1. **Shape.** `mnemosine <noun> <verb> [<qualifier>] [args] [--flags]`, depth ≤ 3. The **last
   token before the arguments is always a verb from §1**. There are no noun-final commands. There
   is no exception for "query" commands; `bank.md`'s prose exception is struck.
2. **Bijection.** The English→Spanish verb map is a bijection: one English verb, exactly one
   Spanish word, and no Spanish word used by two English verbs. Same for nouns.
3. **One owner.** Every noun is defined in exactly one file. Every other file that needs it links
   to the owner and adds flag *values*, never rows.

---

## 1. VERB REGISTRY

The closed list. 76 verbs: the 46 R3 verbs (R3 minus `pull`/`push`, deleted below) plus 30 marked
**EXT**. Anything outside this table is rejected by the R12 test. `pull` and `push` are **deleted
from R3**: R4 reserves them for bidirectional sync with a live external system, `sync` already means
exactly that, and every catalog use of `pull`/`push` was a one-way fetch or send.

### 1.1 Read

| English | Spanish (the only one) | Precise meaning | May apply to |
|---|---|---|---|
| `list` | `listar` | Enumerate zero or more objects. Always accepts a positional query, `--limit`, `--format`, `--fields`. | every noun |
| `show` | `ver` | Take exactly one identifier, print exactly one object. | every noun |
| `search` | `buscar` | Full-text lookup across a corpus, ranked. | `memory`, `session`, `doc`, `entry`, `document`, `skill` |
| `explain` | `explicar` | Derive one number or one decision and name the rule that produced it. **Never** schema introspection — that is `schema show`. | any noun that computes a figure |
| `diff` | `comparar` | Compare two named states of the same object class; the other side is `--vs`. | `entry`, `report`, `trial-balance`, `pay-run`, `chart`, `variance`, `consolidation`, `config`, `snapshot` |
| `export` | `exportar` | Write internal data out to a file or stream. | every noun that has rows |
| `check` | `verificar` | **Local, read-only validation** producing named findings and an exit code. Calls nothing external. | every family noun (`ledger`, `ar`, `ap`, `bank`, `payroll`, `asset`, `inventory`, `cfdi`, `closing`, `config`, `report`, `entry`, …) |
| `status` | `estado` | Current state of one long-running object or process. Noun-shaped alias, grandfathered (see §2.5). | `pay-run`, `closing`, `job`, `integration`, `sat cred`, `bank reconciliation`, `filing`, `payroll run` |
| `history` | `historial` | Append-only trail of events **on one object**. | every versioned or audited noun |
| `watch` | `observar` | Stream/follow a changing source until interrupted. | `job`, `inbox`, `outbox`, `webhook`, `ingest` |
| `trace` **EXT** | `rastrear` | Follow **one document forward through every downstream object it produced** (CFDI → bill → entry → payment → reconciliation). Neither `history` (one object) nor `explain` (one number's rule) covers a cross-object chain, and the alternative was a noun `lineage`, which R1 forbids in the verb slot. | `ledger`, `cfdi`, `inventory cost`, `report` |
| `preview` **EXT** | `previsualizar` | Show what a *write* command would produce, as an object, without writing. Distinct from `--dry-run`, which is a flag on the write command itself; `preview` is the read-only sibling that an agent may invoke when the write is `✗`. Justifies its own row because the ✓/✗ split may never depend on a flag value. | `year`, `entry`, `depreciation`, `pay-run`, `allocation`, `close` |
| `verify` **EXT** | `comprobar` | Prove an artifact against an **external or cryptographic** authority (a hash chain, a timestamp anchor, a bank CEP, a government registry, a backup image). `check` is local and cheap; `verify` calls out and can fail for reasons that are not the data's fault. | `audit`, `anchor`, `attest`, `backup`, `bank cep`, `ssn`, `ledger chain` |
| `test` **EXT** | `probar` | Exercise a live external dependency or a rule end-to-end and report what it would have done. Pinned by `platform.md`. | `integration`, `ai-provider`, `bank rule`, `approval rule`, `memory`, `webhook`, `policy` |

### 1.2 Create / modify

| English | Spanish | Precise meaning | May apply to |
|---|---|---|---|
| `create` | `crear` | Make a new object; **fails if the identity already exists**. | every noun that has instances |
| `edit` | `editar` | Change one or more mutable fields of an existing object. | every mutable noun |
| `delete` | `eliminar` | Destroy a record that has **never affected the ledger**. A posted entry is never deleted. | `draft`, `template`, `rule`, `definition`, `dimension` (unused), `alias`, `webhook`, `job` |
| `import` | `importar` | Bring external **data** in from a file, directory or feed. | `entry`, `chart`, `bank statement`, `inventory count`, `payment-run`, `closing calendar`, `fx rate`, `timesheet` |
| `apply` | `aplicar` | Bring an input into effect against a target, **idempotently** (kubectl `apply`): from a file, or a payment against an invoice. | `chart`, `payment`, `receipt`, `credit-note`, `bank match`, `policy` |
| `unapply` **EXT** | `desaplicar` | Undo one application without touching the ledger's posted entry. The inverse of an idempotent `apply` has no other spelling; `reverse` is reserved for a posted contra-entry and `delete` is illegal on anything that touched the ledger. | `payment`, `receipt`, `credit-note`, `bank match` |
| `set` | `fijar` | Write **one** configuration value. | `config`, `policy`, `threshold`, `rule`, `numbering`, `materiality`, `costing`, `dimension policy`, `tolerance` |
| `unset` | `limpiar` | Clear one configuration value back to its default. | same as `set` |
| `assign` | `asignar` | Give a record an **owner or holder** (a person, a queue, a team). Disjoint from `set`, which writes configuration. | `task`, `dispute`, `question`, `approval`, `control`, `pbc`, `sample` |
| `use` | `usar` | Select the ambient context (current entity, profile, period). | `entity`, `profile`, `tenant`, `period` |
| `add` | `agregar` | Attach a child to a collection on a parent. | `memory`, `entry line`, `reconciliation item`, `user access`, `group member`, `pay-code`, `signer` |
| `remove` | `quitar` | Detach a child from a collection. | same as `add` |
| `record` **EXT** | `registrar` | Attest an act that **already happened outside the system** (a filing a human transmitted, an absence, a manual bank transfer). Distinct from `create` (which originates the act) and from `post` (which writes the ledger). | `filing`, `absence`, `incapacity`, `promise`, `payment`, `collection`, `obligation` |
| `seed` **EXT** | `sembrar` | Populate a table with a standard reference set (chart templates, tax tables, account roles). Pinned by `platform.md`. | `chart`, `tax-table`, `account role`, `pay-code` |
| `clone` **EXT** | `clonar` | Copy an existing object into a new identity. | `entity`, `report`, `budget`, `entry template`, `pay-schedule` |

### 1.3 Lifecycle

| English | Spanish | Precise meaning | May apply to |
|---|---|---|---|
| `post` | `contabilizar` | Write the approved entry to the general ledger. | `entry`, `bill`, `invoice`, `payment`, `pay-run`, `depreciation`, `allocation`, `consolidation`, `bank reconciliation`, `inventory` |
| `void` | `anular` | Kill an **unposted** document. | `entry`, `bill`, `invoice`, `payment`, `payslip`, `pay-run`, `bank check` |
| `reverse` | `reversar` | Write the contra-entry of a **posted** document. Absorbs `unpost`, `rollback`, `revert`. | `entry`, `bill`, `depreciation`, `accrual`, `inventory`, `pay-run`, `write-off`, `consolidation` |
| `correct` | `corregir` | Issue a superseding document that replaces an earlier one, both preserved. | `entry`, `cfdi`, `1099`, `w2`, `filing`, `memory`, `payslip` |
| `submit` | `enviar` | Hand a document to a **party inside the firm that must act on it** (an internal approver). | `entry`, `bill`, `invoice`, `pay-run`, `worksheet`, `closing task`, `attest`, `draft` |
| `approve` | `aprobar` | Human sign-off. Absorbs `certify`, `signoff`, `confirm` (human sense), `unapprove`→`reject`. | every noun with an approval gate |
| `reject` | `rechazar` | Human refusal, requires `--reason`. Absorbs `discard` (of a bad inbound document). | every noun with an approval gate, plus `cfdi`, `bill inbox` |
| `dismiss` **EXT** | `descartar` | Mark an item **not applicable** so it stops appearing, without judging it wrong. Pinned by the repo (`pending dismiss|descartar`); distinct from `reject`, which is a refusal of something submitted. | `pending`, `question`, `closing task`, `anomaly`, `control exception` |
| `cancel` | `cancelar` | Withdraw an **externally issued** document (a CFDI is cancelled, a period is closed — never swap). Absorbs `abandon`, `expire`. | `cfdi`, `invoice`, `payslip`, `order`, `purchase-order`, `job` |
| `open` | `abrir` | Move a period or a session into its working state. | `period`, `year`, `bank reconciliation`, `worksheet`, `dispute` |
| `close` | `cerrar` | Period/book operation only. | `period`, `year`, `dispute`, `bank reconciliation`, `contract` |
| `reopen` | `reabrir` | Undo a `close`, requires `--reason`. | `period`, `year`, `bank reconciliation`, `dispute`, `closing task` |
| `lock` | `bloquear` | Freeze edits without closing. Absorbs `freeze`. | `period`, `pay-run input`, `inventory count`, `chart`, `budget` |
| `unlock` | `desbloquear` | Undo a `lock`, requires `--reason`. Absorbs `unfreeze`. | same as `lock` |
| `archive` | `archivar` | Retire a master record from active use, preserving history. Absorbs `deactivate`, `retire`, `disable` **of a master record**. | `account`, `customer`, `vendor`, `item`, `employee`, `dimension`, `memory`, `entity`, `skill` |
| `restore` | `restaurar` | Undo an `archive`, or rehydrate from a backup. Absorbs `reinstate`, `reactivate`, `undelete`. | same as `archive`, plus `backup`, `cfdi` |
| `grant` **EXT** | `otorgar` | Give a principal a permission or a role. | `role`, `permission`, `user access`, `delegation`, `auditor` |
| `revoke` **EXT** | `revocar` | Take a permission, role or credential away. Pinned by the repo (`sat cred revoke\|revocar`). | same as `grant`, plus `secret`, `integration`, `token` |
| `enable` **EXT** | `activar` | Turn a **control, rule or feature** on. Distinct from `restore`, which returns a master record to active use. | `rule`, `control`, `webhook`, `integration`, `policy`, `skill`, `anomaly rule`, `daemon` |
| `disable` **EXT** | `desactivar` | Turn a control, rule or feature off. Always `✗` for the agent (turning off a control is not the agent's decision). | same as `enable` |

### 1.4 Operations

| English | Spanish | Precise meaning | May apply to |
|---|---|---|---|
| `run` | `ejecutar` | Execute a **defined process** that produces drafts, entries or documents. Absorbs `correr`, `execute`, `process`, `rerun`. | `depreciation`, `allocation`, `dunning`, `revenue`, `billing-schedule`, `payroll`, `closing`, `job`, `report`, `bank reconciliation` |
| `calculate` **EXT** | `calcular` | Compute a derived figure and **write nothing**. Absorbs `compute`, `recalculate`, `roll`. Separated from `run` because the agent tag differs: a calculation is `lectura`, a run is at least `borrador`. | `depreciation`, `sbc`, `imss cuota`, `isn`, `aguinaldo`, `ptu`, `finiquito`, `allowance`, `deferred-tax`, `provision`, `apportionment`, `estimated-tax`, `franchise-tax`, `kpi`, `consolidation nci` |
| `accrue` **EXT** | `devengar` | Produce the **period-end accrual draft** for a subledger. One act, one verb, replacing `accrual run` in two files with two meanings. | `ap`, `payroll`, `ar`, `use-tax`, `prepaid` |
| `allocate` **EXT** | `prorratear` | Distribute one amount across dimensions or entities by a basis. Absorbs `spread`, `distribute`, `apportion`. | `allocation`, `cost`, `overhead`, `apportionment`, `intercompany` |
| `match` | `cotejar` | **Propose** a correspondence between two populations; writes nothing to the ledger. | `bank`, `bill`, `receipt`, `payment`, `cfdi`, `purchase-order` |
| `reconcile` | `conciliar` | **Prove** a balance against a control account or an external statement. Absorbs `clear`, `tie` (verb sense). | `bank`, `ar`, `ap`, `inventory`, `asset`, `cfdi`, `payroll`, `imss`, `revenue`, `sales-tax`, `provision`, `1099`, `trial-balance`, `cashflow`, `w2`, `w3` |
| `prepare` | `preparar` | Stage a document for approval or transmission; it does not leave the firm. | `payment-run`, `filing`, `1099`, `w2`, `diot`, `closing pack`, `pbc` |
| `generate` | `generar` | Assemble a **deliverable artifact** (a file, a PDF, a layout, a statement). Absorbs `build`, `construir`, `render`, `draw`. | `statement`, `report`, `payslip`, `disclosure`, `narrative`, `efw2`, `idse`, `xbrl`, `closing pack`, `confirmation` |
| `issue` **EXT** | `emitir` | Release a document that has **legal effect on a third party**. Absorbs `restamp`, `reissue`, `print` (of a check). | `invoice`, `credit-note`, `bank check`, `withholding constancia`, `retention certificate`, `payslip` |
| `stamp` | `timbrar` | Obtain the PAC/authority seal (MX). Deliberately distinct from `issue`. | `cfdi`, `payslip`, `rep`, `invoice` |
| `file` **EXT** | `presentar` | **Transmit a return to a tax authority.** Separated from `submit` (internal approver) and `send` (a copy to a counterparty) because the three acts have different irreversibility, different credentials and different agent tags. | `filing`, `diot`, `annual`, `1099`, `w2`, `w3`, `fbar`, `sales-tax`, `estimated-tax` |
| `send` **EXT** | `entregar` | Deliver a copy of a document to a **third party for their records**. Absorbs `deliver`, `transmit`, `notice`. | `invoice`, `payslip`, `1099`, `w9 request`, `confirmation`, `dunning`, `statement` |
| `remit` **EXT** | `enterar` | **Pay money over to a third party that the firm was holding on their behalf** — a tax deposit, a garnishment, unclaimed property. It is neither `pay` (a purchase) nor `file` (a return) nor `post` (a ledger write), and the catalog otherwise spelled it `deposit`, `escheat`, `entero` and `run`. | `tax-deposit`, `garnishment`, `withholding`, `imss cuota`, `infonavit`, `bank check` (escheat) |
| `download` | `descargar` | Retrieve **one named external artifact**. Absorbs `fetch`, `obtener`, `bajar`, `traer`, `jalar`. | `sat download`, `bank statement`, `cfdi acuse`, `fx rate`, `e-accounting acuse`, `bank cep` |
| `upload` | `subir` | Send one named local artifact to an external system. | `sat`, `filing`, `integration`, `document` |
| `sync` | `sincronizar` | Reconcile local state with a live external catalog or feed, both directions, idempotently. Absorbs `pull`, `push`, `status-sync`, `catchup`. | `bank feed`, `cfdi status`, `inbox`, `integration`, `sat download`, `anchor`, `holiday`, `chart` |
| `retry` | `reintentar` | Re-attempt a **failed** external delivery or job. | `outbox`, `webhook delivery`, `attest`, `job`, `integration event`, `payment` |
| `resume` | `reanudar` | Continue a **paused or interrupted** multi-step process from where it stopped. | `payroll run`, `bank reconciliation run`, `closing run`, `sat download`, `ingest` |
| `recover` **EXT** | `recuperar` | Return a **stranded** operation to a consistent state when neither `retry` nor `resume` applies (an orphaned lock, a half-written batch). | `job`, `pay-run`, `batch`, `session`, `bank reconciliation` |
| `rotate` **EXT** | `rotar` | Replace a credential with a new one, proving the new one first. | `secret`, `integration`, `token`, `sat cred`, `webhook` |
| `install` **EXT** | `instalar` | Add an external component to the local environment. Pinned by `platform.md`. | `skill`, `completion`, `daemon`, `integration` |
| `start` **EXT** / `stop` **EXT** | `iniciar` / `detener` | Begin / halt a long-running local process. | `daemon`, `job`, `watch`, `session` |
| `answer` **EXT** | `responder` | Supply the human answer to an open question, minting a precedent. Pinned by `platform.md`. | `question`, `pending`, `pbc` |
| `review` **EXT** | `revisar` | **Open the interactive human approval queue.** Root-level only (`mnemosine review`), pinned by the shipping repo. No subcommand anywhere may use this verb — that is what freed `revisar` from the six English verbs it was carrying. | root only |
| `compact` **EXT** | `compactar` | Shrink a session or store while preserving meaning. Pinned by the repo (`compact\|compactar`). | `session`, `memory`, `log`, `prompt-size` |
| `upgrade` **EXT** | `actualizar` | Move the installation to a newer version. Pinned by the repo (`upgrade\|actualizar`). | root only |

### 1.5 Deleted spellings — every one of these is a rewrite, not an alias

`verify`→`check` **except** the seven cryptographic/external rows; `validate`, `lint`, `screen`,
`evaluate`, `preflight`, `risk-scan`, `audit`(as verb), `tie-out`(verb) → `check`.
`define`, `new`, `register`, `init`(of an object), `draft`(verb), `open`(of a dispute/CIP) → `create`.
`update`, `customize`, `annotate` → `edit` (`annotate` → `edit --note`).
`compute`, `recalculate`, `roll` → `calculate`. `correr`, `execute`, `process`, `rerun` → `run`.
`build`, `construir`, `render`, `draw` → `generate`. `simulate` → `preview`.
`fetch`, `obtener`, `bajar`, `traer`, `jalar` → `download`. `pull`, `push` → `sync`.
`log`(verb), `mark-filed` → `record`. `load`, `parse`, `reparse` → `import`.
`afectar`, `aplicar`(ledger sense) → `post`. `revertir`, `rollback`, `unpost`, `fix`, `amend`(non-fiscal) → `reverse`.
`certify`, `signoff`, `confirm`(human) → `approve`. `unapprove`, `discard` → `reject`. `waive`, `na` → `dismiss`.
`abandon`, `expire` → `cancel`. `hold`, `release` → `lock`/`unlock`. `freeze`/`unfreeze` → `lock`/`unlock`.
`deactivate`, `retire` → `archive`. `reinstate`, `reactivate` → `restore`.
`invite` → `grant`. `duplicate`, `copy` → `clone`. `reauth` → `rotate`. `deliver`, `transmit`, `notice` → `send`.
`restamp`, `reissue`, `print` → `issue`. `escheat`, `deposit`(verb) → `remit`. `spread`, `distribute` → `allocate`.
`add-member`/`remove-member`, `attach`, `enroll`, `exclude` → `add`/`remove`.
`definir`, `establecer`, `configurar` (in the `set` sense) → `fijar`. `asignar` (in the `set` sense) → `fijar`; `asignar` now means only `assign`.
`mostrar` → `ver`. `diferencias`, `diferencia` → `comparar`. `correr` → `ejecutar`. `cruce` → `cotejo`.
**Bare nouns in the verb slot** (`ledger orphans`, `cfdi anomalies`, `bank match forced`, `ar aging`,
`inventory kardex`, `treasury position`, `budget exceptions`, `sod matrix`, `pay-run inputs`, `close tie`,
`bank account signers`, …) → append the verb the row actually performs, almost always `list` or `show`.

---

## 2. NOUN REGISTRY

230 canonical nouns. Singular, lowercase, hyphenated when multi-word, English. Spanish aliases are
singular nouns too. **One owner file per noun**; every other file references it.

`--status` values are the noun's published state machine (R7), taken from the shipping schema where
one exists. `—` means the noun is a stateless master or a pure verb-carrier.

### 2.1 Root-level objectless commands — the closed list of 15 (R1)

`ask`·`pregunta` · `chat`·(none) · `review`·`revisar` · `close`·`cierre` · `doctor`·(none) ·
`status`·`estado` · `init`·`configurar` · `onboard`·`alta` · `login`·`entrar` · `logout`·`salir` ·
`whoami`·`quien` · `lang`·`idioma` · `ingest`·`ingesta` · `compact`·`compactar` · `help`·`ayuda`.

Every other command shipped at root today becomes `<noun> <verb>` and keeps its old name as an R9
deprecated alias with a stderr notice: `entities`→`entity list`, `providers`→`ai-provider list`,
`sessions`→`session list`, `drafts`→`draft list`, `outbox`→`outbox list`, `questions`→`question list`,
`pending`→`pending list`, `memory`→`memory list`, `approvals`→`approval list`, `usage`→`usage show`,
`jobs`→`job list`, `skills`→`skill list`, `webhooks`→`webhook list`, `prompt-size`→`prompt-size show`.
`sat` stays as a noun (`sat cred …`, `sat download …`).

### 2.2 ledger.md (12)

| Noun | Spanish | `--status` values |
|---|---|---|
| `account` | `cuenta` | `active \| dormant \| archived` |
| `chart` | `catalogo` | — |
| `entry` | `poliza` | `draft \| pending_approval \| approved \| posted \| void` (001:238); `reversed` is derived from `reversed_by_entry_id`, not a state |
| `period` | `periodo` | `future \| open \| soft_close \| hard_close \| locked` (001:204) |
| `year` | `ejercicio` | `open \| closed` (001:187) |
| `ledger` | `mayor` | — |
| `dimension` | `dimension` | `active \| retired` — **NEW, closes the blocking completeness gap** |
| `allocation` | `prorrateo` | `draft \| active \| archived` |
| `batch` | `lote` | `pending \| running \| completed \| failed \| cancelled` |
| `numbering` | `folio` | — |
| `opening-balance` | `saldo-inicial` | `draft \| loaded \| verified` |
| `fx` | `cambio` | — (`fx rate …` is the qualifier form) |

### 2.3 ar.md (25)

`ar`·`cxc` — · `customer`·`cliente` `active \| on_hold \| suspended \| archived` (002:181) ·
`invoice`·`factura` `draft \| pending \| sent \| viewed \| paid \| partially_paid \| overdue \| void \| cancelled \| uncollectible` (002:212) ·
`receipt`·`cobro` `draft \| pending \| processing \| completed \| failed \| void` (002:294) ·
`credit-note`·`nota-credito` · `debit-note`·`nota-cargo` · `advance`·`anticipo` (**AR owns it; fiscal-mx loses it**) ·
`allowance`·`estimacion` (**inventory's `reserve` becomes `inventory allowance`, same Spanish word, one concept**) ·
`dunning`·`recordatorio` · `collection`·`cobranza` · `dispute`·`disputa` `open \| investigating \| resolved \| closed` ·
`promise`·`promesa` `open \| kept \| broken` · `contract`·`contrato` · `billing-schedule`·`programa-facturacion` ·
`price-list`·`lista-precios` · `payment-term`·`condicion-pago` · `quote`·`cotizacion` · `order`·`pedido` ·
`revenue`·`ingreso` · `write-off`·`castigo` (**one spelling; `writeoff` and `writedown` die**) ·
`factoring`·`factoraje` · `finance-charge`·`recargo` · `netting`·`compensacion` · `retainage`·`fondo-garantia` ·
`meter`·`consumo`.

### 2.4 ap.md (18)

`ap`·`cxp` · `vendor`·`proveedor` (**AP owns `proveedor`; platform's LLM/PAC noun is renamed**) ·
`bill`·`factura-proveedor` `draft \| pending_approval \| approved \| posted \| paid \| partially_paid \| void \| cancelled` (002:64) ·
`payment`·`pago` `draft \| pending \| processing \| completed \| failed \| void` (002:129) ·
`payment-run`·`corrida-pago` `draft \| prepared \| approved \| released \| settled \| returned` (**the single batch-disbursement noun; payroll's `payment-batch` dies**) ·
`purchase-order`·`orden-compra` · `requisition`·`requisicion` · `goods-receipt`·`recepcion` ·
`service-entry`·`acta-servicio` · `grni`·`grni` (**domain-standard abbreviation, added to R2's allowed list; the alias `rnf` dies**) ·
`expense-report`·`informe-gasto` · `prepaid`·`pago-anticipado` · `mileage-rate`·`tarifa-kilometraje` ·
`vendor-advance`·`anticipo-proveedor` · `vendor-credit`·`nota-credito-proveedor` · `vendor-debit`·`nota-cargo-proveedor` ·
`withholding`·`retencion` (**AP owns `retencion`; fiscal-mx's `retention` and close-controls' `retention` both lose it**) ·
`accrual`·`devengo`.

### 2.5 bank.md (3)

| Noun | Spanish | `--status` |
|---|---|---|
| `bank` | `banco` | `bank reconciliation`: `in_progress \| balanced \| approved \| posted` (003:89); `bank check`: `issued \| outstanding \| cleared \| void \| stopped \| stale \| escheated` |
| `cash` | `caja` | — |
| `treasury` | `tesoreria` | — |

`check` is **not** a top-level noun: it collides with the verb `check`. All paper-check commands are
`bank check <verb>`·`banco cheque <verbo>` at depth 3. `card` is not a noun either: a credit card is
`bank account --type credit-card`, as `bank.md:54` already ruled. `bank statement`·`banco estado-cuenta`
— never `banco estado`, which is the `status` alias.

### 2.6 assets-inventory.md (7)

`asset`·`activo` `active \| inactive \| disposed \| fully_depreciated` (003:182) · `depreciation`·`depreciacion` ·
`inventory`·`inventario` · `item`·`articulo` · `warehouse`·`almacen` · `costing`·`costeo` · `inpc`·`inpc`.

`asset doctor` and `inventory doctor` are deleted; system health is `doctor --scope <family>` and
domain invariants are `asset check` / `inventory check`.

### 2.7 payroll.md (43)

`payroll`·`nomina` · `employee`·`empleado` `active \| on_leave \| terminated \| suspended` (008:32) ·
`pay-run`·`corrida` `draft \| calculating \| calculated \| approved \| paid \| voided` (008:162) ·
`pay-period`·`periodo-nomina` `draft \| calculated \| approved \| paid \| closed` (008:143) ·
`pay-schedule`·`calendario-nomina` · `pay-code`·`concepto` · `payslip`·`recibo` `pending \| stamped \| cancelled \| failed` (002:223) ·
`timesheet`·`asistencia` · `absence`·`ausencia` · `incapacity`·`incapacidad` · `vacation`·`vacaciones`
(**the one grandfathered plural Spanish alias — the singular does not exist in payroll usage**) ·
`benefit`·`prestacion` · `compensation`·`sueldo` · `garnishment`·`embargo` · `sbc`·`sbc` · `imss`·`imss` ·
`infonavit`·`infonavit` · `fonacot`·`fonacot` · `isn`·`isn` · `isr`·`isr` (**payroll ISR; corporate ISR is `provision`/`annual`**) ·
`sui`·`sui` · `ssn`·`ssn` · `multistate`·`multiestado` · `tax-table`·`tabla-fiscal` ·
`tax-deposit`·`entero` (**payroll owns it; fiscal-us' `deposito-fiscal` dies**) `pending \| deposited \| late \| waived` (008:344) ·
`employer-registration`·`registro-patronal` · `new-hire`·`nueva-contratacion` · `termination`·`terminacion` ·
`aguinaldo` · `ptu` · `finiquito` · `liquidacion` · `prima-antiguedad` · `prima-vacacional` ·
`pension-alimenticia` (**six untranslated MX statutory terms; alias identical, like `cfdi`**) ·
`imputed-income`·`ingreso-imputado` · `gl-map`·`mapeo-contable` · `prenote`·`prenota` `draft \| submitted \| settled \| rejected \| returned` (008:465) ·
`w2`·`w2` · `w3`·`w3` · `w4`·`w4` · `efw2`·`efw2` · `yearend`·`cierre-anual`.

### 2.8 fiscal-mx.md (11)

`cfdi`·`cfdi` `pending \| validating \| ready \| processing \| completed \| rejected \| error` (005:87) ·
`sat`·`sat` · `pac`·`pac` · `diot`·`diot` ·
`filing`·`declaracion` `draft \| ready \| filed \| accepted \| rejected \| amended` (008:490) — **fiscal-mx owns the noun; fiscal-us and payroll contribute `--form` values only** ·
`obligation`·`obligacion` `pending \| due \| filed \| waived` — **same ruling: fiscal-mx owns, the other two contribute `--jurisdiction`/`--form` values** ·
`party`·`contraparte` · `rep`·`rep` · `annual`·`anual` ·
`e-accounting`·`contabilidad-electronica` (**was `eaccounting`·`contae` — not a word, and the alias was opaque**) ·
`tax-mailbox`·`buzon` (**was the Spanish canonical `buzon`; R8 requires an English canonical, and this frees platform's `inbox`**).

### 2.9 fiscal-us.md (21)

`1099`·`1099` · `w9`·`w9` · `w8`·`w8` · `sales-tax`·`impuesto-ventas` · `use-tax`·`impuesto-uso`
(**fiscal-us owns both; ap.md's copies die**) · `nexus`·`nexo` ·
`apportionment`·`atribucion` (**was `prorrateo`, which belongs to ledger's `allocation`**) ·
`provision`·`provision` (**freed because payroll's `accrual`·`provision` becomes `payroll accrue`·`nomina devengar`**) ·
`deferred-tax`·`impuesto-diferido` · `book-tax`·`contable-fiscal` · `tax-basis`·`base-fiscal` ·
`estimated-tax`·`pago-estimado` · `franchise-tax`·`franquicia` · `property-tax`·`predial` ·
`nra-withholding`·`retencion-extranjeros` · `foreign-account`·`cuenta-extranjera` · `fbar`·`fbar` ·
`utp`·`posicion-incierta` · `transfer-price`·`precio-transferencia` · `related-party`·`parte-relacionada` ·
`registration`·`registro`.

The noun `tax`·`fiscal` is **deleted**: R10 forbids namespace-grabbing generic nouns, and every row
under it belongs to one of the twenty-one above.

### 2.10 report.md (22)

`report`·`reporte` · `statement`·`estado-financiero` · `trial-balance`·`balanza` · `worksheet`·`hoja-trabajo` ·
`budget`·`presupuesto` · `forecast`·`pronostico` · `variance`·`variacion` (**close-controls' `flux`·`variaciones` dies**) ·
`kpi`·`indicador` · `dashboard`·`tablero` · `narrative`·`narrativa` · `disclosure`·`nota` (**singular**) ·
`consolidation`·`consolidacion` · `intercompany`·`intercompania` · `segment`·`segmento` · `cashflow`·`flujo` ·
`covenant`·`convenio` · `benchmark`·`referencia` · `statistic`·`estadistica` · `account-group`·`grupo-cuentas` ·
`anomaly`·`anomalia` · `xbrl`·`xbrl` ·
`tie-out`·`amarre` — **one noun, one spelling, one owner.** `ledger tieout`, `tieout build`, `close tie`
and `disclosure tie-out` all become `tie-out check --scope <subledger>`·`amarre verificar`.

### 2.11 close-controls.md (15)

`closing`·`cierre-proceso` — **the close *process*, distinct from the root leaf `close`·`cierre`** ·
`control`·`control` · `sod`·`segregacion` · `materiality`·`materialidad` · `sample`·`muestra` ·
`pbc`·`pbc` (**domain-standard audit abbreviation, added to R2's allowed list; the plural alias `requerimientos` dies**) ·
`auditor`·`auditor` · `attest`·`atestacion` `pending \| submitted \| confirmed \| failed` (006:226) ·
`anchor`·`ancla` `pending \| broadcast \| confirmed \| failed` (006:149) · `permission`·`permiso` ·
`delegation`·`delegacion` · `document`·`documento` (**attachments; platform keeps `doc`·`doc` for help topics**) ·
`continuity`·`continuidad` (**was `dr`·`contingencia` — a two-letter abbreviation, banned by R5**) ·
`reconciliation`·`conciliacion` (**was `recon` — abbreviation banned by R2/R5**) `open \| in_progress \| balanced \| certified \| reopened` ·
`data-retention`·`conservacion` (**was `retention`·`retencion`, which now belongs to AP's `withholding`**).

### 2.12 platform.md (38)

`entity`·`entidad` · `tenant`·`despacho` · `user`·`usuario` · `role`·`rol` · `group`·`grupo` ·
`identity`·`identidad` · `token`·`token` · `approval`·`aprobacion` (**singular; `approvals rule set` becomes `approval rule set`**) ·
`policy`·`politica` `pending \| resolved \| dismissed` (016:28) · `draft`·`borrador` `pending_review \| approved \| rejected` (011:16) ·
`question`·`duda` `pending \| answered \| dismissed` (013:15) · `session`·`sesion` · `memory`·`memoria` ·
`skill`·`habilidad` `pending_review \| approved \| rejected` (027:41) · `job`·`tarea` (**singular; report.md's and close-controls' `jobs` die**) ·
`webhook`·`gancho` `received \| processed \| duplicate \| rejected` (028:78) · `subscription`·`suscripcion` ·
`integration`·`integracion` `active \| inactive \| error \| expired \| revoked` (007:22) ·
`ai-provider`·(no alias) (**was `provider`·`proveedor`, which collided with AP's supplier; technical term, no alias, precedent `chat`/`sat`/`doctor`**) ·
`secret`·`secreto` · `vault`·`boveda` · `config`·`configuracion` · `profile`·`perfil` (**split out of `config`, which had two aliases**) ·
`alias`·`alias` · `completion`·`completado` · `doc`·`doc` · `schema`·`esquema` (**`mnemosine explain <noun>` becomes `schema show <noun>`; `explain` is derivation only**) ·
`log`·`bitacora` · `audit`·`auditoria` (**platform owns it; close-controls' `audit log` dies in favour of `audit list --actor`**) ·
`backup`·`respaldo` (**platform owns it; close-controls' `backup`, `archive` and `restore` nouns die**) ·
`inbox`·`bandeja` (**was `buzon`, now free of the fiscal mailbox**) · `outbox`·`envio` (**singular**) ·
`telemetry`·`telemetria` · `metric`·`metrica` (**singular**) · `db`·`base-datos` · `daemon`·`demonio` ·
`support`·`soporte` · `usage`·`uso` · `agent`·`agente` (**NEW — the accountability surface the AI-safety lens found missing**).

The nouns `api` and `onboarding` are **deleted**: `api` is the catch-all R10 forbids and defeats the
point of an audited surface; `onboarding`'s rows move under the root command `onboard`.

### 2.13 The eight double-defined families — one owner each, and what the loser becomes

| Capability | Winner | Loser → becomes |
|---|---|---|
| batch outgoing payments | `payment-run` (ap.md) | payroll.md `payment-batch create/validate/generate/transmit` → `payment-run prepare --source pay-run <id>`, then the AP verbs |
| paper checks | `bank check` (bank.md) | ap.md `check *` and payroll.md `check print/void` → `bank check issue \| print→issue \| void \| stop→lock \| clear→reconcile \| remit` |
| 1099 cycle | `1099` (fiscal-us.md) | ap.md `1099 check/prepare/export/submit` → deleted; AP links to fiscal-us |
| use tax | `use-tax` (fiscal-us.md) | ap.md `use-tax run` → deleted; the AP accrual is `ap accrue --kind use-tax` |
| withholding certificates | `withholding` (ap.md) | fiscal-mx.md `retention issue/batch/list/validate/remit` → `withholding constancia issue \| list \| check \| remit` |
| variance / flux | `variance` (report.md) | close-controls.md `flux run/explain/review/report/ratio/threshold set` → deleted; `variance threshold set`·`variacion umbral fijar` is the one spelling |
| FX rate table | `fx rate` (ledger.md) | report.md `fx-rate load/list/check`·`tipo-cambio` → deleted; `fx rate import \| list \| check \| download \| set \| correct`·`cambio tipo …` |
| holiday calendar | `closing calendar` (close-controls.md) | fiscal-mx.md `sat holiday sync` and payroll.md `holiday-calendar load` → deleted; both call `closing calendar import` |

### 2.14 `entry` vs `je` — the ruling

**`entry`·`poliza` (ledger.md) is the object. The noun `je` does not exist.** It is an abbreviation
(R5), it duplicates six of `entry`'s seven verbs, and it claims the identical Spanish alias
`poliza enviar`, which is a hard failure of `bilingual-matrix.spec.ts`. close-controls.md deletes the
whole `je` subgroup and folds its three genuinely new capabilities onto `entry` in ledger.md:

- `je submit` → **delete** (it is `entry submit`, already in ledger.md:73)
- `je queue` → **delete** (it is `entry list --status pending_approval`)
- `je approve` / `je reject` / `je correct` → **delete** (already on `entry`)
- `je risk-scan` → merge with ledger.md's `entry audit-scan` into **one** command, `entry check --check risk`
- `je annotate` → `entry edit --note`

close-controls.md keeps exactly one row from that subgroup: `approval rule set|list|test`·`aprobacion regla fijar|listar|probar`.

---

## 3. FLAG DICTIONARY

The single §II.4 table. Every per-file dictionary is deleted: `close-controls.md:106`,
`fiscal-mx.md:13`, `payroll.md:24`, `bank.md:50`, `report.md:90-94`. New concepts get a row here, in
one place, with a test — nowhere else.

**Short-flag ruling.** The shipping repo pins the short forms and the repo wins. Where the repo
itself pins one short flag to two long names, the higher-count, root-level use wins:

- `-p` = `--provider` (mnemosine.ts:538, :560, :1072, :1179). **`-p, --period` at close-command.ts:75 loses and must be removed**; `--period` has no short form anywhere.
- `-n` = `--limit` (mnemosine.ts:896, sat-commands.ts:205, webhooks-command.ts:158). **`-n, --note` at pending-command.ts:194 and :250 loses its short form**; **`-n, --dry-run` from §II.4 is overruled** — `--dry-run` has no short form.
- `-l` = `--list` (mnemosine.ts:1276, :1417, close-command.ts:76). **`-l, --limit` from §II.4 is overruled.**
- `-s` = `--status` (mnemosine.ts:957). `-s, --session` loses its short form.
- `-b, --search` (memory-command.ts:70) is grandfathered on `memory list` only, deprecated under R9; `--search` has no short form elsewhere.
- `-T, --tenant <uuid>` collapses into `-t, --tenant`.
- `-f` is never assigned. Not `--force`, not `--file`.

### 3.1 Scope

| Long | Short | Meaning | Which commands |
|---|---|---|---|
| `--entity <idOrName>` | `-e` | scope to one legal entity; falls back to current context | every command that touches entity data |
| `--all-entities` | none | fan out over every visible entity; table output, non-zero if any item fails | any read or `--dry-run`-capable command |
| `--entity-query <expr>` | none | select the fan-out set for `--all-entities` | with `--all-entities` only |
| `--tenant <id>` | `-t` | firm scope / RLS context | admin and cross-firm commands |
| `--user <email>` | `-u` | attributed actor | every mutating command; absorbs `--approver`, `--owner` |
| `--profile <name>` | none | named connection/credential profile | `config`, `integration`, `ai-provider`, `sat` |
| `--config <path>` / `--no-config` | none | config file override / ignore | root |
| `--set <key=value>` | `-c` | one-shot config override, repeatable | root |

### 3.2 Time

| Long | Short | Meaning | Which commands |
|---|---|---|---|
| `--period <expr>` | **none** | accounting period: `2026-01`, `2026-Q1`, `2026-B1`, `FY2026`, `last-month`, `2026-01..2026-06` | every period-scoped command. **Absorbs `--month`, `--quarter`, `--bimester`, `--week`** |
| `--year <n>` | none | calendar year of an informative return or a fiscal year | fiscal and payroll year-end commands only |
| `--as-of <date>` | none | point-in-time balance/valuation date. **Absorbs `--date`** | balance, aging, valuation, `ytd` |
| `--since <date>` / `--until <date>` | none | inclusive bounds on a range. **Absorbs `--from`/`--to`, `--start`/`--end`** | every `list`, `history`, `export` |
| `--within <duration>` | none | forward horizon relative to today (`30d`, `2w`) — an absolute `--until` cannot express "what falls due soon" | `obligation`, `filing`, `invoice`, `bill`, `promise` |
| `--date-basis <document\|posting\|value>` | none | which of the three dates the filters apply to; default `posting` | every date-filtered read |
| `--interval <day\|week\|month\|quarter\|year>` | `-M`/`-Q`/`-Y` | column bucketing | report and register renderers |

### 3.3 Selection

| Long | Short | Meaning | Which commands |
|---|---|---|---|
| *(positional query)* | — | hledger-style terms: `acct:`, `desc:`, `amt:`, `cur:`, `tag:`, `dim:<name>=<value>`, `not:`, `or:` | every `list` |
| `--account <pattern>` | none | convenience for `acct:`; repeatable | ledger, bank, report reads |
| `--status <state>` | `-s` | filter by a published R7 state; repeatable | every `list` on a stateful noun |
| `--limit <n>` | `-n` | max rows; default 50 interactive, unlimited with `--json` | every `list` |
| `--offset <n>` / `--cursor <token>` | none | pagination | every `list` |
| `--all` | `-a` | disable the default limit; include archived and closed | every `list` |
| `--list` | `-l` | list-only mode of an otherwise interactive command | `review`, `close`, `outbox`, `question`, `pending` |
| `--check <name,…>` | none | select named diagnostics; **with no value, print the available check names**. **Absorbs every positional `[check...]`/`[codes...]`** | every `<noun> check` |
| `--scope <family>` | none | which family's system health to diagnose | `doctor` **only**. **`doctor --check bank.*` (bank.md:192) loses** |
| `--vs <ref>` | none | the other side of a comparison. **Absorbs `--a`/`--b` (report.md) and `--against` (5 files)** | every `diff` |
| `--fields <a,b,c>` | none | column selection; with no value, print available field names | every `list`/`show` |

### 3.4 Output

| Long | Short | Meaning | Which commands |
|---|---|---|---|
| `--format <table\|json\|ndjson\|csv\|tsv\|xlsx\|pdf\|xml\|md>` | none | output rendering. **Absorbs `--fmt`** | every read |
| `--json` | none | documented shorthand for `--format json` (already shipped in 12 places) | every read |
| `--output <path>` | `-o` | write output to a file. **`--out` (fiscal-mx.md:13, 16 rows) loses** | every read that can produce a file |
| `--file <path>` / `--dir <path>` | none | read input from a file / a directory. **`--from-file` (ar, ap, platform, payroll) loses** | every `import`, `apply`, `create --file` |
| `--generate-skeleton` | none | emit an empty commented JSON document for a complex object | `entry`, `cfdi`, `pay-run`, `bill`, `invoice`, `report definition` |
| `--jq <expr>` | none | post-filter JSON; requires a JSON format | every read |
| `--quiet` | `-q` | bare identifiers, one per line, for piping | every `list` |
| `--verbose` | `-v` | more detail, repeatable | every command |
| `--redacted` | none | mask tax identifiers (RFC, CURP, NSS, SSN, TIN) in the output | every command that can print a person's identifiers |
| `--no-color` / `--no-pager` / `--null` (`-z`) | `-z` for `--null` | terminal behaviour | every read |

### 3.5 Safety and mutation

| Long | Short | Meaning | Which commands |
|---|---|---|---|
| `--dry-run` | **none** | compute and display the full effect, write nothing, call nothing external. **Absorbs `--validate-only` (assets-inventory ×4) and `--plan`** | every mutating command; **required** on rung ≥ 3 |
| `--yes` | `-y` | skip an interactive confirmation. **`--confirm` (fiscal-us ×7, payroll ×3) loses** | every command that confirms |
| `--force` | **none, never `-f`** | override a blocking safety rule (closed period, lock date, duplicate reference); **always requires `--reason`** | commands with a hard validation to override |
| `--reason <text>` | none | mandatory justification → `audit_log.reason`. Required with `--force`, `reverse`, `void`, `reopen`, `unlock`, `cancel`, `reject`, `archive`, `revoke` | as listed |
| `--note <text>` | none | free annotation, **never a justification**. Absorbs `annotate` | `entry`, `draft`, `task`, `pending`, `question` |
| `--idempotency-key <k>` | none | client dedupe key; deterministic default derived from the payload. **Required on every rung ≥ 3 command and every external write** — this settles ledger.md (4 loads only) vs close-controls.md (everything) vs bank.md ("this section does not invent it") | as stated |
| `--live` | none | perform the real external effect; default is the sandbox endpoint. **`--test` and `--sandbox` lose** | every command that calls a PAC, the SAT, a bank, or sends mail |
| `--strict` | none | make warnings fail (turns a warning-only `check` into exit 4) | every `check`, `verify`, `reconcile` |
| `--no-input` | none | never prompt; fail with a clear message. Implied when stdin is not a TTY | every interactive command |
| `--watch` | none | stream/follow | `job`, `inbox`, `outbox`, `ingest`, `webhook` |
| `--stop-at <step>` / `--resume` | none | orchestrator control: stop before a named gate / continue where it stopped | `payroll run`, `bank reconciliation run`, `closing run`, `sat download` |
| `--journal <file>` | none | write the source→target map of every reassigned document, so a merge can be undone by hand | `account merge`, `customer merge`, `vendor merge` |
| `--teach <criterion>` | none | mint a memory precedent from a human rejection | `draft reject` |
| `--raise` | none | publish each finding above the threshold as an open question | `anomaly check`, `variance check`, `control check` |
| `--provider <name>` | `-p` | AI provider. **Already pinned by the repo — do not reuse `-p`** | `ask`, `chat`, `job`, `ai-provider` |
| `--model <name>` | `-m` | model within the provider (repo-pinned) | `ask`, `chat`, `job` |

---

## 4. EXIT CODE CONTRACT

`research/cli-ux.md` §II.7 publishes a table. It is the constitution and it wins over all five
per-file schemes. Published **once**, in the catalog preamble, and repeated in no section file.

| Code | Meaning | Notes |
|---|---|---|
| `0` | success — including a clean `check`, and an idempotency hit whose result is identical | `kubectl apply` semantics: a cron rerun must not page anyone |
| `1` | generic failure | last resort; prefer a specific code |
| `2` | usage error — bad flag, missing argument, unknown subcommand | |
| `3` | not found — entity, entry, account, period, document does not exist | |
| `4` | **validation failed** — unbalanced entry, NIF/GAAP rule violated, schema invalid, **and the code a `check` command returns when it finds a blocking finding** | |
| `5` | blocked by state — period closed or locked, lock date, entry already posted, credential expired | |
| `6` | conflict — same idempotency key, different payload | |
| `7` | permission denied — RLS, role, entity access, approval policy | |
| `8` | external service failed — PAC, SAT, bank, Contalink timed out or errored. **Retryable** | |
| `9` | external service rejected — SAT 5002, CFDI rejected. **Not retryable** | |
| `10` | aborted by user — declined confirmation | |
| `11` | **needs human** — a question was raised or a draft awaits review. `--json` carries both the successes and the open items | the code that makes an agent-driven workflow safe |
| `130` | interrupted (SIGINT) | |

### 4.1 The diagnostic convention — decided once

**A `check` command that finds problems exits `4`, not `0`.** Findings are also in the payload;
the exit code is not a substitute for them, it is what lets `mnemosine ledger check` drop into CI
and a `jobs` runner unchanged (`git diff --exit-code`'s trick, named at `cli-ux.md:759`).

- clean → `0`
- blocking findings → `4`
- warning-only findings → `0`, **unless `--strict`, which makes them `4`**
- the check could not run (no connection, bad selector) → `1`, `2`, `3` or `8` as appropriate — never `4`
- findings that require a human decision rather than a fix → `11`

**Deleted:** ap.md:71 (`bill match` exits 2), close-controls.md:75 (0/2/3), report.md:227 (2 =
precondition unmet, 3 = integrity error), bank.md:50 ("1 on failure, never on warn"), ledger.md:8
("non-zero on failure"). ap.md:267 and platform.md:48 already say 4 and are **correct** — they stay.

---

## 5. CONFLICT RULINGS

Every cross-file collision, the ruling, and the exact rewrite, addressed to the file that must change.

| # | Collision | Ruling | Rewrite required |
|---|---|---|---|
| 1 | `entry`·`poliza` (ledger) vs `je`·`poliza` (close-controls) — identical alias, hard test failure | `entry` wins; `je` does not exist | **close-controls.md:126-132**: delete all seven `je` rows. Fold `risk-scan` into ledger.md's `entry check --check risk` (merging it with `entry audit-scan`, which is the same capability under a third name) and `annotate` into `entry edit --note`. Keep only `approval rule set\|list\|test` |
| 2 | `proveedor listar` claimed by `vendor list` (ap) and `provider list` (platform) | AP keeps `vendor`·`proveedor` | **platform.md:53-56**: rename the noun `provider` → `ai-provider`, **no Spanish alias** (technical term; precedent `chat`, `sat`, `doctor`) |
| 3 | `anticipo aplicar` claimed by `advance apply` (ar) and `advance apply` (fiscal-mx) — identical in both languages | AR owns `advance`·`anticipo`, as ap.md:39 already adjudicated | **fiscal-mx.md:56**: delete the row. The CFDI anticipo path is a flag: `advance apply --cfdi` on ar.md:137 |
| 4 | `usuario listar`, `usuario ver`, `rol listar`, `rol otorgar`, `rol revocar` claimed twice | platform.md owns identity | **close-controls.md:172-181**: delete `user *` and `role *`. `user entity grant/revoke` → platform.md:81-82 `user access add/remove`. close-controls keeps `permission`, `delegation`, `auditor` |
| 5 | `doc list` — identical English, two meanings, two aliases | platform keeps `doc`·`doc` (help topics) | **close-controls.md:224-226**: rename `doc attach\|list\|verify` → `document attach\|list\|check`·`documento adjuntar\|listar\|verificar` |
| 6 | `close` is a leaf with eleven flags and a group with 34 subcommands | `close`·`cierre` stays the **guided period-close leaf**; the close *process* becomes the noun `closing`·`cierre-proceso` | **close-controls.md:49-87**: rename every `close <sub>` row to `closing <sub>` (`closing task list`, `closing calendar import`, `closing signoff`→`closing approve`, `closing template …`, `closing run …`, `closing pack generate`). **Delete close-controls.md:75's claim that `close check` replaces `close --check`** — `close --check` stays and four files depend on it. `close` keeps `--check --hard --yes --reason --period --subledger --jurisdiction --carry-forward-only --reopen --list --json` |
| 7 | `cierre --reabrir` mixes a Spanish alias with a Spanish flag | flags are never translated (bilingual-matrix.spec.ts:149-153) | **ap.md:165**: `close --reopen` · `cierre --reopen` |
| 8 | Three flag dictionaries, two reassigning repo-pinned short flags | §3 above is the only dictionary | **close-controls.md:106**, **fiscal-mx.md:13**, **payroll.md:24**, **bank.md:50**, **report.md:90-94**: delete the dictionaries. **fiscal-mx.md**: `--out` → `--output` in all 16 rows. **close-controls.md**: `-l/--limit` → `-n/--limit`, `-n/--dry-run` → `--dry-run`, `-p/--period` → `--period`. **close-command.ts:75**: drop `-p` from `--period` |
| 9 | Five exit-code contracts | §4 above | **ap.md:71**, **close-controls.md:75**, **report.md:227**, **bank.md:50**, **ledger.md:8**: delete the local contracts and cite the preamble |
| 10 | `ar check [check...]` / `ap check --check a,b` / `ledger check [name...]` / `close check [codes...]` | `--check <name,…>` everywhere, and bare `--check` lists the available names | **ar.md:216**, **ledger.md:172**, **close-controls.md:75**: convert to the flag form. **ledger.md:173-178**: delete the six argument-rows |
| 11 | `job` vs `jobs`, `approval` vs `approvals` | singular (R2) | **report.md:94-95**: `job create`·`tarea crear`, `job run-due`·`tarea ejecutar-vencidas`. **close-controls.md:87**: `job create --kind close_verification`·`tarea crear`. **close-controls.md:133-135**: `approval rule set\|list\|test`·`aprobacion regla fijar\|listar\|probar`. **ap.md:131**, **ar.md:20**: fix the prose references to `question` and `job` |
| 12 | `payment-run` (ap) vs `payment-batch` (payroll) | AP wins | **payroll.md:132-140**: delete; replace with one row `payment-run prepare --source pay-run <id>` pointing at ap.md |
| 13 | paper checks in three files, and the noun `check` collides with the verb `check` | bank.md wins, at depth 3 | **ap.md:206-209**, **payroll.md:142-143**: delete. **bank.md:140-149**: `bank check issue\|list\|void\|lock\|reconcile\|remit`·`banco cheque …`; `print`→`issue`, `stop`→`lock`, `clear`→`reconcile`, `stale`→`--status stale`, `escheat`→`remit --to unclaimed-property` |
| 14 | 1099 and use-tax in ap and fiscal-us | fiscal-us wins | **ap.md:225-229**: delete. The AP-side accrual is `ap accrue --kind use-tax` |
| 15 | withholding certificates in ap and fiscal-mx | ap wins | **fiscal-mx.md:146-150**: delete; `withholding constancia issue\|list\|check\|remit` in ap.md |
| 16 | `flux` (close-controls) vs `variance` (report) | report wins | **close-controls.md:113-118**: delete. `variance threshold set`·`variacion umbral fijar` is the one spelling |
| 17 | `fx rate` (ledger) vs `fx-rate` (report) | ledger wins | **report.md:187-189**: delete. ledger.md:152-157 becomes `fx rate list\|show\|set\|download\|import\|correct`·`cambio tipo …` (`fetch`→`download`) |
| 18 | holiday calendar in three files | close-controls wins | **fiscal-mx.md:39** and **payroll.md:91**: delete; both call `closing calendar import` |
| 19 | backup and audit trail in close-controls and platform | platform wins | **close-controls.md:208-213** and **:147-154**: delete, except `audit verify` and `audit immutability check`, which stay (cryptographic). platform.md:213 `audit list` gains `--actor`, `--action`, `--object` and the documented value `--actor agent` |
| 20 | `tax-deposit`·`deposito-fiscal` (fiscal-us) vs ·`entero` (payroll) | payroll owns the noun, alias `entero` | **fiscal-us.md:121-123**: delete; link to payroll |
| 21 | `filing` owned by three files, `amend` spelled three ways | fiscal-mx owns the noun | **fiscal-us.md:162-167**, **payroll.md:211-218**: delete the rows; contribute `--form` values only. `amend` → `correct`·`corregir` everywhere; the aliases `complementaria`/`complementar` die |
| 22 | `obligation` owned by three files | fiscal-mx owns the noun | **fiscal-us.md**, **payroll.md**: contribute `--jurisdiction`/`--form` values only |
| 23 | `card` re-created in ap after bank dissolved it | bank.md:54 wins | **ap.md:248-253**: delete; a credit card is `bank account --type credit-card` |
| 24 | `recon` and `bank reconcile <verb>` (noun-verb-verb) | `reconciliation`·`conciliacion` | **close-controls.md:93-107**: `recon` → `reconciliation`. **bank.md:117-131**: `bank reconcile <verb>` → `bank reconciliation <verb>`·`banco conciliacion <verbo>` |
| 25 | `conciliar` covers `reconcile` and `match`; `match` maps to `cotejar` and `cruce` | `match`·`cotejar`, `reconcile`·`conciliar`, disjoint in both languages | **ar.md:129**: `receipt match`·`cobro cotejar`. **bank.md:101-111**: `banco cruce …` → `banco cotejo …` |
| 26 | `check`/`verify`/`validate`/`lint`/`screen`/`test` are six spellings of one act; `revisar` covers six English verbs | `check`·`verificar` (local), `verify`·`comprobar` (external/cryptographic), `test`·`probar` (live dependency), `review`·`revisar` (root only) | **ar.md:25**→`customer tax check`; **fiscal-mx.md:46**→`cfdi check`; **payroll.md:214**→`filing check`; **report.md:86**→`report definition check`; **assets-inventory.md:37**→`asset map check`; **ledger.md:41**→`chart check`; **fiscal-mx.md:112**→`party check`; **bank.md:41**→`bank statement check`; **report.md:174**→`consolidation check <run>` merged with report.md:169. `verify`·`comprobar` survives **only** at close-controls.md:151, :165, bank.md:68, payroll.md:230, and platform's `backup verify` |
| 27 | `mostrar` (report ×11), `diferencias` (report ×5), `correr` (payroll ×6), `calcular` for `run` (fiscal-us ×5) | one Spanish word per English verb | **report.md**: `mostrar`→`ver` (11 rows); `statement render`→`statement show`; `disclosure render`→`disclosure generate`; `diferencias`/`diferencia`→`comparar` (:24,:42,:88,:106,:144,:199 and fiscal-mx.md:167). **payroll.md**: `correr`→`ejecutar` (6 rows). **fiscal-us.md:100,:103,:109,:117,:130**: rename the **verb** — `run`→`calculate`·`calcular` |
| 28 | `accrual run` defined twice with two meanings and two aliases; `calculate` vs `compute` | `accrue`·`devengar`; `calculate`·`calcular` | **ap.md:141-143**→`ap accrue` / `ap accrual list` / `ap accrual reverse`. **payroll.md:244-246**→`payroll accrue` / `payroll accrual show` / `payroll accrual reverse`. Replace all five `compute` with `calculate`. **assets-inventory.md:203-204**: `inventory reserve compute\|post` → `inventory allowance calculate\|post`, sharing AR's `allowance`·`estimacion` |
| 29 | `doctor --scope` vs `<family> check` vs `<family> doctor` | `doctor --scope <family>` for system health; `<noun> check` for domain invariants | **assets-inventory.md:135, :215**: delete `asset doctor` / `inventory doctor`; fold into `asset check` / `inventory check`. **bank.md:192**: `doctor --check bank.*` → `doctor --scope bank`. **fiscal-mx.md:129**: → `doctor --scope fiscal-mx` |
| 30 | 24 rows are one command with an argument | collapse | **ledger.md:183-191** → `tie-out check --scope <subledger>`·`amarre verificar` (one row, owned by report.md); delete `ledger tieout`, **close-controls.md:81** `close tie`, **close-controls.md:236** `tieout build`, **report.md:198** `disclosure tie-out`. **payroll.md:261-269** → `payroll export <report>`·`nomina exportar` with the nine names as an enumerated argument |
| 31 | ~155 noun-final rows, legalized in prose by bank.md:50 | struck | **bank.md:50**: delete the exception paragraph. Every noun-final row in bank (25), ar (8), assets-inventory (18), ledger (24), report (17), fiscal-mx (28), close-controls (16), payroll (18) gets its verb appended — `list` for a set, `show` for one object |
| 32 | `explain` means both derivation and schema introspection | `explain` = derivation only | **platform.md:220**: `mnemosine explain <noun>` → `mnemosine schema show <noun>`·`esquema ver`, with `--states` |
| 33 | `dr`, `pbc`, `je`, `recon`, `grni`, `rep`, `na` — abbreviations | R2's allowed list is extended to exactly `cfdi, sat, rfc, iva, isr, isn, diot, gl, ap, ar, fx, imss, ptu, sbc, ssn, sui, pac, rep, pbc, grni, kpi, utp, fbar, xbrl, sod, w2, w3, w4, w8, w9, efw2, inpc` | **close-controls.md**: `dr`→`continuity`·`continuidad`; `recon`→`reconciliation`; `close task na`→`closing task dismiss --reason not-applicable`; `requerimientos`→`pbc` |
| 34 | Spanish alias morphology: infinitives vs conjugated imperatives, singular vs plural | infinitives, unaccented, one word; nouns singular | **tests/cli/bilingual-matrix.spec.ts:57-64**: `memory {add\|agregar, correct\|corregir, archive\|archivar, restore\|restaurar}`; retire `enseña`, `ensena`, `corrige`, `retira`, `restaura` under R9. `pending define\|definir` → `pending create\|crear` (this is what frees `definir`, which was covering two English verbs). **TOP_LEVEL** plural aliases (`entidades`, `borradores`, `tareas`, `sesiones`, `dudas`, `envios`, `habilidades`, `ganchos`, `aprobaciones`, `proveedores`, `pendientes`) become singular, the plurals staying as R9 stderr-warning aliases |
| 35 | Colloquial and inconsistent Spanish for external retrieval | `download`·`descargar` for one artifact, `sync`·`sincronizar` for a catalog or feed | **platform.md:162**: `inbox pull`·`buzon jalar` → `inbox sync`·`bandeja sincronizar`. **ap.md:126**: delete (duplicate of fiscal-mx.md:98 `cfdi status sync`). **ap.md:125**: delete (`sat download` is a noun in fiscal-mx). **fiscal-mx.md:79, :174**, **ledger.md:155**, **bank.md:38, :67**: `fetch`→`download`·`descargar` |
| 36 | `inbox`·`buzon` (platform) vs `buzon`·`buzon` (fiscal-mx) — and `buzon` is a Spanish canonical | English canonicals only (R8) | **fiscal-mx.md**: `buzon` → `tax-mailbox`·`buzon`. **platform.md**: `inbox`·`buzon` → `inbox`·`bandeja` |
| 37 | `retencion` claimed by AP `withholding`, fiscal-mx `retention`, close-controls `retention` | AP's `withholding`·`retencion` | **fiscal-mx.md:146-150**: deleted (ruling 15). **close-controls.md:199**: `retention`·`retencion` → `data-retention`·`conservacion` |
| 38 | `prorrateo` claimed by ledger `allocation` and fiscal-us `apportionment` | ledger's `allocation`·`prorrateo` | **fiscal-us.md:109**: `apportionment`·`prorrateo` → `apportionment`·`atribucion` |
| 39 | `provision` claimed by fiscal-us `provision` and payroll `accrual`·`provision` | fiscal-us | **payroll.md:244**: resolved by ruling 28 — `payroll accrue`·`nomina devengar` |
| 40 | `estado` claimed by `status` and by `bank statement`·`banco estado` | `status`·`estado` (grandfathered noun-alias, pinned by `sat cred status\|estado`) | **bank.md**: `bank statement` → `banco estado-cuenta` |
| 41 | `archivo`/`restauracion` nouns collide with the verbs `archive`/`restore` | verbs win | **close-controls.md**: delete the nouns `archive` and `restore`; their rows become `backup create\|list\|verify\|restore`·`respaldo …` in platform.md |
| 42 | `config`·`configuracion` and `config`·`perfil` — one noun, two aliases | split the noun | **platform.md**: `config`·`configuracion` and a separate `profile`·`perfil` |
| 43 | `writeoff` / `write-off` / `writedown`; `carryforward` / `carry-forward`; `desechar` on two verbs | one spelling each | **ap.md:145, :160**: `writeoff`→`write-off`. **assets-inventory.md:205-206**: `inventory writedown`→`inventory write-down`, both rows aliased on the noun (`inventario castigo aplicar` / `inventario castigo reversar`). **ledger.md:136**: `carryforward`→`carry-forward`. **assets-inventory.md:115**: `asset write-off`·`activo desechar` → `activo castigar`, leaving `desechar` to `inventory scrap` |
| 44 | Two catch-all escape hatches (R10) | both deleted | **platform.md:29**: delete `entity run --entity-query -- <subcommand...>`; fan-out is `--all-entities [--entity-query <expr>]` on any command. **platform.md:219**: delete `mnemosine api <method> <path>` — an ungated REST hatch makes every backend endpoint reachable without appearing in the catalog, which is the whole point of an audited surface |
| 45 | No dimension master, 27 commands depend on one | ledger.md owns `dimension`·`dimension` | **ledger.md**: add `dimension create <type> <code>`·`dimension crear`, `dimension list [type]`·`dimension listar`, `dimension archive <type> <code>`·`dimension archivar`, `dimension policy set`·`dimension politica fijar` (the completeness lens proposed `define`/`retire`/`definir`; both verbs are outside §1 — `create`/`archive`). Correct the Backend cell of the six self-blocked rows to name `dimension create` as the declared prerequisite |
| 46 | `mnemosine ingest` carries opposite IA marks in two files | one row per invocation | **fiscal-mx.md:94**: riesgo `irreversible`, IA `✗`, delete `--auto-post`/`--no-auto-post`; platform.md:160 is the canonical row |
| 47 | `ask` is `✗` at platform.md:96 and `✓` at report.md:213; `job run`/`job run-due` are `✓` | any command that opens an agent session is `✗` | **report.md:213**: IA `✗`. **platform.md:145-146**: IA `✗`. **platform.md:9** rule (e) extended to name `chat`, `ask`, `job run`, `job run-due`, `inbox watch` |
| 48 | The IA tag and rung disagree for 12 commands and have no machine-readable home | one owning section per command; the tag ships in the generated catalog | **platform.md:231**: `doc export --format json` emits `agent: read\|draft\|never` alongside the rung. Add `tests/cli/catalog-consistency.spec.ts` asserting each canonical invocation maps to exactly one `(riesgo, IA)` pair. `period *` and `year *` owned by **ledger.md** (delete close-controls.md:33-36, :39-41) |
| 49 | `--status` values differ per file for the same object | the schema's CHECK is the state machine (§2) | every section: rewrite `--status` value lists to match §2, and delete any invented state not in the CHECK unless the row explicitly proposes extending it and says so |

---

## 6. NORMALIZER INSTRUCTIONS

Apply these mechanically to your section. Do not negotiate any of them; every conflict they touch is
already ruled on in §5.

1. **Verb slot.** For every row, the last token before the arguments must be a verb from §1. If it is
   a noun, append the verb the row actually performs (`list` for a set, `show` for one object). If it
   is a verb outside §1, replace it with the verb that absorbs it (§1.5).
2. **Spanish verb.** Replace the Spanish last token with the one word §1 assigns to the English verb.
   Never invent a second spelling. Infinitive, unaccented, one word.
3. **Noun and alias.** Use the canonical noun and the single Spanish alias from §2. Singular, English
   canonical, lowercase, hyphenated. If your file is not the owner of a noun, delete the row and add
   one line pointing at the owner.
4. **Depth.** Max 3 tokens before the arguments. A three-token command is `<noun> <qualifier-noun>
   <verb>` — never `<noun> <verb> <verb>`.
5. **Flags.** Every flag must appear in §3 with the same spelling, arity and meaning. Delete any
   local flag dictionary from your preamble. Replace the losers: `--out`→`--output`,
   `--from-file`→`--file`, `--confirm`→`--yes`, `--validate-only`/`--plan`→`--dry-run`,
   `--a`/`--b`/`--against`→`--vs`, `--fmt`→`--format`, `--date`→`--as-of`, `--from`/`--to`→
   `--since`/`--until`, `--month`/`--quarter`/`--bimester`/`--week`→`--period`, positional
   `[check...]`→`--check <name,…>`.
6. **Short flags.** Only these exist: `-e --entity`, `-t --tenant`, `-u --user`, `-p --provider`,
   `-m --model`, `-n --limit`, `-l --list`, `-s --status`, `-a --all`, `-y --yes`, `-o --output`,
   `-q --quiet`, `-v --verbose`, `-c --set`, `-z --null`, `-M/-Q/-Y --interval`. Anything else loses
   its short form. `-f` is never assigned.
7. **Flags are never translated.** A Spanish alias row shows English flags. `cierre --reabrir` is a
   test failure.
8. **Exit codes.** Delete every exit-code statement from your file and cite §4. If a row mentions an
   exit code, it may only be `4` (a `check` that found blocking findings) or `11` (needs human).
9. **Rung ≥ 3 rows** must carry `--dry-run`, `--yes`, `--reason` where a justification is required,
   and `--idempotency-key`. Add them if missing.
10. **Collapse argument-rows.** If N rows differ only by their last token and share one Spanish
    alias, they are one command with an enumerated argument. Write the one row and delete the N.
11. **One `(riesgo, IA)` per invocation.** If your row duplicates a command owned by another file,
    delete it. The ✓/✗ split may never depend on a flag value: if it does, split the command in two
    (`year preview-close` / `year close`, `sat download sync` / `sat download request`).
12. **PII is about the data, not the format.** Any command that materializes tax identifiers (RFC,
    CURP, NSS, SSN, TIN) for more than one person is IA `✗`, whether it is called `prepare`,
    `generate` or `export`. Give the agent a `--redacted` reader instead.
13. **Client credentials.** Any command that consumes a client credential (vault, integration,
    mailbox, PAC, bank, SAT) against a third party is IA `✗`, without exception. Where the read is
    valuable, split the credentialed call from the local mirror and keep only the mirror `✓`.
14. **Policy setters are `✗`.** Setting an accounting policy, a book that posts, or the frequency of
    a control is never the agent's decision. Publish the read half (`<noun> show`) as `✓`.
15. **State machines.** Rewrite every `--status` value list to the noun's published states in §2.
    A state not in the schema's CHECK may only appear if the row says explicitly that the CHECK must
    be extended.
16. **Deprecations.** Every name you rename goes into the R9 list with its old spelling, a stderr
    notice and a removal version. Do not silently drop a name the repo ships.
17. **Preamble.** Delete from your preamble anything this file now owns: verb tables, flag tables,
    exit codes, alias morphology, the `--idempotency-key` position, the `doctor` vs `check` argument,
    and any "conventions that cut across all tables" section. Replace it with one line citing
    `REGISTRY.md`.
18. **Phase.** Re-mark phase 1 against the single written test "the commands required to open the
    books, record a month, close it, and file". Targets: ledger 25 · ar 15 · ap 15 · bank 15 ·
    report 15 · fiscal-mx 20 · payroll 10 · platform 20 · close-controls 10 · assets-inventory 5 ·
    fiscal-us 5. ap.md, assets-inventory.md and platform.md do this first — they hold 208 of the 589.
