// ============================================================
// EL CATÁLOGO FUENTE (I6 · issue #148)
//
// Aquí nacen las CLAVES. `es.ts` se declara `Record<keyof typeof EN, string>`,
// así que este archivo es el que manda: una clave que no exista aquí no puede
// existir allí, y una que exista aquí y falte allí es un error de `tsc` antes
// de que nadie corra una prueba. El orden de sincronía va en una sola
// dirección, y por eso hay un solo archivo `as const`.
//
// LAS TRECE CADENAS DE LA SIEMBRA SON REALES, y cada una lleva escrito de dónde
// salió. Ninguna es un `hello_world`: son mensajes que el CLI imprime HOY en
// español, elegidos porque tres de ellos se repiten palabra por palabra en dos
// y tres archivos distintos —`Sin cambios: el mayor no se tocó.` vive en
// `batch-command.ts:268`, `bank-command.ts:2010` y `prepaid-command.ts:1072`—,
// que es la señal de que una cadena ya era una clave y nadie lo había escrito.
//
// TRES DE ELLAS TRAEN EL DEFECTO QUE JUSTIFICA EL PLURAL PROPIO. El CLI de hoy
// resuelve el plural con `(s)`: `cancelado(s)` en `cfdi-command.ts:308`,
// `verificación(es)` en `diot-command.ts:744`, `bloqueante(s), aviso(s)` en
// `diot-command.ts:752`. Eso no es una elección de estilo, es la ausencia de un
// mecanismo: con uno, «1 CFDI cancelado» y «2 CFDI cancelados» se escriben cada
// uno en su rama, y el inglés —donde el plural cae en otro sitio de la frase—
// deja de ser inexpresable.
//
// LO QUE NO ENTRA EN EL CATÁLOGO, y es la mitad del contrato:
//
//   · NI SANGRÍAS NI `\n`. La cadena es la FRASE; el renglón, el margen y el
//     `⚠` los pone quien imprime. El original de `bank-command.ts:3362` trae
//     dos espacios delante y un salto detrás, y meterlos aquí obligaría a
//     traducir la maquetación de cada sitio de llamada.
//   · NI DINERO NI FECHAS FORMATEADOS. Un `{date}` llega ya como cadena, hecha
//     por el formateador de la jurisdicción (`src/i18n/format.ts`). El idioma
//     no decide el separador de miles: ésa es la regla 5 del epic —idioma ≠
//     formato ≠ jurisdicción— y confundirla es el error caro.
//   · NADA QUE VAYA A UNA AUTORIDAD. Ni un nombre de campo del SAT, ni un
//     código de la DIOT, ni un renglón del Anexo 24. Un artefacto que se
//     entrega no se traduce; aquí sólo hay prosa para el operador.
// ============================================================

export const EN = {
  // ==== error.* — messages of API and service errors, by code (I9) ====
  // Keyed as `error.<CODE>`: the code is the wire contract, so the key names
  // it and a reader can go from a response straight to its text. Placed at the
  // top, not after the last tranche's block, so each tranche adds its keys in
  // its own section instead of every branch colliding at the end of the file.

  /** `AccountingError('PERIOD_ALREADY_OPEN')`: opening a period that is already open, or reopening one — the dry run of `period reopen` included. */
  'error.PERIOD_ALREADY_OPEN': '{period} is already open.',

  /** `AccountingError('FX_REVALUATION_PERIOD_NOT_OPEN')`: `closing fx revalue` on a period that is not a regular open or soft-closed month (MNE-001-083). */
  'error.FX_REVALUATION_PERIOD_NOT_OPEN':
    '{period} is {type} and {status}: the revaluation belongs to a regular month that is open or soft-closed, before its seal.',
  /** `AccountingError('FX_REVALUATION_NEXT_PERIOD_NOT_OPEN')`: the day-1 mirror has no open period to land in. */
  'error.FX_REVALUATION_NEXT_PERIOD_NOT_OPEN':
    'The revaluation of {period} is reversed on the first day of the next period, and that period {status, select, missing {does not exist} other {is {status}}}. Open it (in December, open the next fiscal year first) and run it again: nothing was posted.',
  /** `AccountingError('FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED')`: an entity whose functional currency is not MXN (#124). */
  'error.FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED':
    'The closing revaluation is built for entities that keep their books in Mexican pesos (NIF B-15), and this one keeps them in {currency}. Other functional currencies, and ASC 830, are issue 124: nothing was posted.',
  /** `AccountingError('INVOICE_CHANGED')`: a collection's invoice UPDATE matched no row (MNE-001-580). */
  'error.INVOICE_CHANGED': '{invoice} changed under this collection; nothing was written.',
  /** `AccountingError('BILL_CHANGED')`: a payment's bill UPDATE matched no row (MNE-001-532). */
  'error.BILL_CHANGED': '{bill} changed while the payment was being applied; nothing was written.',
  /** `AccountingError('FX_REVALUATION_PLAN_CHANGED')`: the live run recomputed a different gain or loss than the plan the user confirmed. */
  'error.FX_REVALUATION_PLAN_CHANGED':
    'The revaluation of {period} changed between the plan you confirmed (gain {expectedGain}, loss {expectedLoss}) and the post (gain {gain}, loss {loss}): something was posted or a rate changed in between. Nothing was posted; run it again to see the new plan.',
  /** `AccountingError('FX_REVALUATION_MARKER_MISMATCH')`: fx_revaluation_runs no longer agrees with the ledger's fx_revaluation entries of the period. */
  'error.FX_REVALUATION_MARKER_MISMATCH':
    'The revaluation record of {period} does not agree with the ledger: the ledger holds {ledger} revaluation entries for it and the record {marker}, or their amounts differ. Running it again could post the revaluation twice, so nothing was posted; the record needs to be reviewed.',
  /** `AccountingError('FX_REVALUATION_KEY_LOCKED')`: changing a key the revaluation reads while a revaluation is live (MNE-001-112). */
  'error.FX_REVALUATION_KEY_LOCKED':
    '{policy} cannot change now: {entity} revalued {period}, which is not hard-closed yet, and the months still to be revalued in its fiscal year would be measured under the new value. It changes once the revalued months are sealed, or at the start of a fiscal year: when the next fiscal year is open, has no revaluation yet, and every month before it is revalued or hard-closed.',
  /** `AccountingError('FX_RATE_MISSING')` when the source was chosen by a panel key other than fuente_tipo_cambio (the closing revaluation). */
  'error.FX_RATE_MISSING':
    'There is no {from}→{to} rate from the source {source} for {date}. Enter it with: mnemosine fx rate set {from}/{to} {date} RATE --source {source}, or download it with: mnemosine fx rate download. No other source or date is taken silently: the source was chosen on the policy panel, and it is a criterion of the firm.',

  // ---- MNE-001-154 · the AccountingError of src/services/accounting that were Spanish prose (issue #151) ----
  // `error.<CODE>` when the code has one text in the folder, `error.<CODE>.<case>`
  // when it carries several. The Spanish twin is the text each site printed.
  // ar-ap-posting.ts
  'error.MISSING_ROLE_ACCOUNT.unmapped':
    'No account is mapped to the role "{role}" on this entity. Seed the books with: mnemosine init --section identity (or check what is missing with: mnemosine doctor)',
  'error.FX_RATE_CONFLICT':
    "{invoice} carries the exchange rate {rate}, and the source '{source}' of the policy fuente_tipo_cambio published {published} for {date}. Neither is chosen silently: correct the invoice's rate or the policy before issuing it.",
  'error.INVOICE_ALREADY_POSTED': "{invoice} already has an entry or is not this entity's: no second one is linked.",
  'error.FX_RATE_MISSING.document':
    "{bill} is in {currency} and the books in {functional}, but its exchange_rate is {rate, select, none {null} other {{rate}}} (the capture default). Record the document's exchange rate before approving it: without it the liability would be posted unconverted and lose its origin (NIF B-15).",
  'error.FX_AR_ON_ACCOUNT_NOT_WIRED':
    "{payment} leaves {amount} {currency} on the customer's account: a balance on account in another currency is not yet applied or unapplied with conversion.",
  'error.WRITE_OFF_ACCOUNT_UNRESOLVED':
    'A short payment writes off a balance and nobody said which account it goes to. The policy `pago_corto_residual` decides it; posting without it would leave the entry unbalanced.',
  // fiscal-calendar-service.ts
  'error.REASON_REQUIRED': 'Reopening a closed period requires a reason: it stays in the audit trail.',
  'error.PERIOD_LOCKED':
    "{period} is 'locked': its information has already left the system and it is not reopened. The correction goes in the nearest open period.",
  'error.PERIOD_NOT_CLOSED': "{period} is '{status}': this operation is only for closed periods.",
  'error.INVALID_STATUS': "A period is restored only to 'soft_close' or 'hard_close'; '{status}' was asked for.",
  'error.PERIOD_NOT_OPEN.restore': 'Period {period} could not be restored: it was no longer open.',
  'error.TENANT_NO_RESUELTO.period': 'The tenant of {entity} could not be determined.',
  // MNE-001-645 (#594): `year carry-forward run`, the carry for a year that already exists.
  'error.CARRY_SOURCE_NOT_SEALED':
    "{previous} is '{status}': the year before {year} is not sealed, so there is nothing to carry yet. Its hard close will carry into {period}.",
  'error.CARRY_SOURCE_MISSING':
    'Fiscal year {year} is the first one of these books: there is no period before {period} to carry from. A first year opens with: mnemosine opening-balance import',
  'error.CARRY_TARGET_SEALED.locked':
    "{period} is 'locked': its figures already left the system and its opening balances are not rewritten.",
  'error.CARRY_TARGET_SEALED.hard_close':
    "{period} is 'hard_close' and {count, plural, one {# of its opening balances differs} other {# of its opening balances differ}} from the closing balances of {previous}. A closed period does not change without being reopened: mnemosine period reopen \"{period}\" --force --reason <text>, run this again, then close it and seal it (mnemosine close --period \"{period}\", and again with --hard), which redoes the carry of the months after it.",
  // iva-cash-basis.ts
  'error.IVA_ROLE_UNRESOLVED.no_line':
    'The CFDI taxonomy defines no VAT line for ({side}, {method}). Check CASES in src/services/xml-ingestion/cfdi-taxonomy.ts.',
  'error.MISSING_ROLE_ACCOUNT.no_semantic_layer':
    'Entity {entity} has no semantic layer seeded, so how much VAT it has parked cannot be known: the payment would release zero and the tax would stay there. Seed it with: npm run backfill:account-roles -- --tenant <uuid> --aplicar',
  // journal-entry-service.ts
  'error.ALREADY_POSTED.preview': '{entry} is already posted: there is no delta to preview.',
  'error.ENTRY_VOID.preview': '{entry} is void and will never be posted.',
  'error.ALREADY_POSTED.edit': '{entry} is already posted: an entry in the ledger is immutable.',
  'error.ENTRY_VOID.edit': '{entry} is void.',
  'error.ENTRY_NOT_EDITABLE': '{entry} is {status}: only a draft is edited.',
  'error.OPENING_DRAFT_LOCKED':
    '{entry} is the opening loaded from the trial balance: its lines and its date are not edited. Post it with `entry post`, or void it with `entry void` and load the trial balance again.',
  // the exchange-rate resolver of a document in its own currency
  'error.ENTITY_NOT_FOUND.functional_currency':
    'Entity {entity} does not exist: without its functional currency nothing can be converted.',
  'error.FX_POLITICA_DESCONOCIDA.rate_source':
    'fuente_tipo_cambio is "{value}" and this reader only understands {known}. Fix it with mnemosine pending.',
  'error.FX_RATE_MISSING.policy_source':
    "There is no {from}→{to} rate from the source '{source}' for {date}. Enter it with: mnemosine fx rate set {from}/{to} {date} <rate> --source {source}, or download it with: mnemosine fx rate download. No other source or date is taken silently: the policy fuente_tipo_cambio ({policy}) is a tax criterion of the firm, not a preference of this function.",
  // period-close.ts
  'error.TENANT_NO_RESUELTO.close':
    'The tenant of entity {entity} could not be determined: the close is not recorded without a trail.',
  'error.CIERRE_YA_EMITIDO':
    'The period already issued its closing ({entries}) and the policy cierre_recierre_de_periodo_reabierto forbids closing it again: correct it by an explicit reclassification, or change the policy with mnemosine pending.',
  'error.RESULTADO_SIN_BARRER':
    'The close did not leave the fiscal year at zero: {count} income-statement account(s) keep a balance ({detail}). The whole close was rolled back and the period is still open: a balance that survives the close seeds the next fiscal year wrongly. If the firm prefers this only to warn, the policy is severidad_resultado_sin_barrer.',
  'error.YEAR_MONTHS_NOT_SEALED':
    '{period} seals the fiscal year and {count, plural, one {another of its periods is} other {# of its other periods are}} not hard-closed: {periods}. A period that is not hard-closed still takes entries, and none posted after the seal would be swept. Hard-close {count, plural, one {it} other {them, oldest first}} with mnemosine close --period <period> --hard, or declare that the firm seals over them: mnemosine pending define year_seal_with_unsealed_months accept_unsealed.',
  // posting.ts
  'error.SOD_QUIEN_CREA_NO_POSTEA.apply':
    '{reference}: the segregation-of-duties policy requires that whoever applies it is not whoever prepared it. Have another user apply it, or adjust the policy segregacion_de_funciones with mnemosine pending.',
  'error.SOD_QUIEN_CREA_NO_POSTEA.post':
    '{entry}: the segregation-of-duties policy requires that whoever posts is not whoever created the draft. Have another user run entry post, or adjust the policy segregacion_de_funciones with mnemosine pending.',
  'error.ENTITY_NOT_FOUND.posting': 'Entity {entity} does not exist or is not visible.',
  'error.TENANT_NO_RESUELTO.entry':
    'The tenant of entity {entity} could not be determined: the entry is not written without an audit trail.',

  // part 2 (MNE-001-627): the AccountingError of the folder that were English
  // prose. The English is the text each site printed, byte for byte.
  // ar-ap-posting.ts
  'error.CREDIT_NOTE_ALREADY_POSTED': "{note} already has an entry or is not this entity's: no second one is linked.",
  'error.FX_BANK_CURRENCY_MISMATCH':
    '{payment} is in {currency} but its bank account is kept in {bankCurrency}. The bank converted the money at its own rate, which this payment does not carry: record it against a {currency} bank account, or record the conversion separately.',
  'error.PAYMENT_ALLOCATION_NOT_FOUND.no_live_allocation':
    '{payment}: no live allocation to invoice {invoice} is waiting for its released IVA, so the amount an unapply would re-park cannot be recorded.',
  'error.PAYMENT_ALLOCATION_NOT_FOUND.release_not_recorded':
    '{payment}: {unreleased} live allocations released no IVA and {recorded} recorded it, so an unapply could not tell them from rows that never stored one.',
  'error.PAYMENT_ALREADY_POSTED.payment': "{payment} already has an entry or is not this entity's: no second one is linked.",
  'error.ADVANCE_SPLIT_MISMATCH': "{payment}: the advance's base {base} plus its IVA {iva} is not the {remaining} left on account.",
  'error.PAYMENT_ALREADY_POSTED.transfer':
    "{transfer} already has an entry or is not this entity's transfer: no second one is linked.",
  // closing-conductor.ts and period-close.ts
  'error.PERIOD_NOT_FOUND': 'Fiscal period not found',
  'error.UNKNOWN_CLOSING_STEP': 'Unknown step "{step}". The steps are: {steps}.',
  // discount-vat-correction.ts and vat-overcredit.ts
  'error.MISSING_ROLE_ACCOUNT.no_account': '{entity} has no account for the {role} role.',
  // fiscal-calendar-service.ts
  'error.PERIOD_NOT_FUTURE':
    "{period} is '{status}', not 'future'. Only a future period can be opened; reopening a closed period is a separate, audited operation.",
  // fx-revaluation.ts
  'error.FX_POLITICA_DESCONOCIDA.policy':
    '{policy} is "{value}" and this reader only understands {known}. Fix it with mnemosine pending.',
  'error.MISSING_ROLE_ACCOUNT.fx_revaluation': 'No account is mapped to the role "{role}" in this entity.',
  // ieps-cash-basis.ts: `event` is the caller's word for what causes the IEPS
  'error.MISSING_ROLE_ACCOUNT.ieps':
    'No account is mapped to the role "{role}" on this entity, and an invoice parked IEPS that this {event, select, collection {collection} unapply {unapply} other {{event}}} causes (LIEPS art. 10). Map it with: mnemosine account map set (or check with: mnemosine doctor)',
  // iva-cash-basis.ts
  'error.IVA_ROLE_UNRESOLVED.same_role':
    'The CFDI taxonomy sends the VAT of a received PPD to {role}: a payment would have nowhere to release it from. Check CASES in src/services/xml-ingestion/cfdi-taxonomy.ts.',
  // journal-entry-service.ts
  'error.ENTRY_NOT_FOUND.ref': 'Journal entry {entry} not found',
  // period-close.ts
  'error.PERIOD_NOT_OPEN': 'Period is not in open status',
  'error.CANNOT_CLOSE_PERIOD': 'Cannot close period: {issues}',
  'error.PERIOD_NOT_SOFT_CLOSED': 'Period must be in soft_close status before hard close',
  // posting.ts
  'error.PERIOD_CLOSED.no_open_period': 'No open fiscal period found for the entry date',
  'error.VALIDATION_FAILED': 'Validation failed: {errors}',
  'error.ENTRY_NOT_FOUND': 'Journal entry not found',
  'error.ALREADY_POSTED.post': 'Journal entry is already posted',
  'error.ENTRY_VOID.post': 'Cannot post a voided entry',
  'error.PERIOD_NOT_FOUND.posting': 'Fiscal period not found while posting',
  'error.PERIOD_CLOSED.in_flight': "{period} is '{status}': it closed while this entry was in flight; nothing was posted",
  'error.ENTRY_NOT_POSTED':
    "Only posted entries can be reversed; {entry} is '{status}' and never touched the ledger — reject or void it instead",
  'error.ALREADY_REVERSED': 'Entry {entry} already has a reversal — reversing again would corrupt balances',
  'error.ASSET_CARD_NOT_REFRESHED':
    'Entry {entry} is a depreciation entry and its asset is not in this entity: the reversal was not posted',
  'error.ALREADY_VOID': 'Journal entry is already voided',
  // vat-overcredit.ts
  'error.POLICY_VALUE_UNKNOWN': '{policy} = "{value}" is not a value this system knows ({known}); nothing was posted.',

  // ---- MNE-001-480 part 1 · the refusals of src/services/payments that were Spanish prose (issue #151) ----
  // `error.VALIDATION_ERROR.payment.<case>` for a ValidationError, beside the
  // `schema.*` cases of MNE-001-152; `error.<CODE>[.<case>]` for an
  // AccountingError. The Spanish twin is the text each site printed. `side` is
  // the party the site already names, the customer or the vendor.
  // The bank trace of the money
  'error.VALIDATION_ERROR.payment.destination_bank_both':
    'The payment declares a national destination bank («{national}») and a foreign one («{foreign}») at once. Anexo 24 asks for the catalogue CODE for a national bank and the NAME for a foreign one: declaring both states two incompatible things about the same movement, and the file carries them as they are to the authority.{foreignCode, select, yes { A foreign bank is given by its name alone: the voucher puts the code {code} on it when it writes it.} other {}}',
  'error.VALIDATION_ERROR.payment.destination_bank_length':
    'The destination bank code «{national}» has {length} characters and the SAT c_Banco has {expected}. A bank is not identified by its name in this field: if the bank is foreign, give its name in the foreign bank field.',
  'error.VALIDATION_ERROR.payment.destination_bank_off_list':
    'The destination bank code «{national}» is not in the SAT c_Banco catalogue (three digits from the published list). If the bank is foreign, give its name in the foreign bank field.',
  'error.VALIDATION_ERROR.payment.destination_account_missing':
    'The destination bank was given and the destination account was not. In the Anexo 24 voucher the destination account is the required field of the transfer node and the bank the optional one: the bank alone does not let the trace be issued, and it looks as if the payment already had it.',
  'error.VALIDATION_ERROR.payment.cheque_on_other_method':
    'A cheque number («{cheque}») was given to a payment {side, select, cliente {received} other {made}} by «{method}». A cheque number identifies a cheque: on another method the Anexo 24 voucher would declare a cheque that does not exist. Use the bank reference for the folio of a transfer.',
  'error.VALIDATION_ERROR.payment.cheque_too_long':
    'The cheque number «{cheque}» is longer than the 20 characters the Cheque node of the Anexo 24 voucher admits.',
  'error.VALIDATION_ERROR.payment.payer_bank_on_vendor_payment':
    "The payer's bank and account are captured only on a receipt. On a payment to a vendor the origin is our own bank account (`--bank`), and its c_Banco code lives on that account.",
  'error.VALIDATION_ERROR.payment.payer_bank_method':
    'A customer bank or account was given to a receipt by «{method}». Only a cheque or a transfer declares, in the Anexo 24 voucher, which bank the money left from.',
  'error.VALIDATION_ERROR.payment.payer_bank_both':
    'The receipt declares a national customer bank («{bank}») and a foreign one («{foreign}») at once. A foreign bank is given by its name alone: the voucher puts the code {code} on it when it writes it.',
  'error.VALIDATION_ERROR.payment.payer_bank_off_list':
    'The customer bank code «{bank}» is not in the SAT c_Banco catalogue (three digits from the published list). If the bank is foreign, give its name in the foreign bank field.',
  'error.VALIDATION_ERROR.payment.payer_account_without_bank':
    "The customer's account was given and its bank was not. The payment node of the voucher requires the origin bank: the account alone does not let it be issued, and it looks as if the receipt already had its trace.",
  'error.VALIDATION_ERROR.payment.payer_trace_too_long':
    "The customer's account admits up to 50 characters and the name of its foreign bank up to 150, the same limits as the payment node of the voucher.",
  // Recording a payment or a receipt
  'error.PAYMENT_STATE_UNSUPPORTED':
    "A payment can only be recorded as '{state}': mnemosine records payments that have ALREADY happened. The status '{status}' belongs to a payment scheduler that does not exist, and a payment that has not left the bank cannot touch the ledger.",
  'error.VALIDATION_ERROR.payment.no_application':
    'A payment applied to no document releases no balance and credits no VAT: say what it applies to.',
  'error.VALIDATION_ERROR.payment.advance_without_party':
    'An advance with no document needs the {side, select, cliente {customer} other {vendor}} stated explicitly: with no document there is nothing to deduce it from.',
  'error.VALIDATION_ERROR.payment.document_repeated':
    'The document {document} appears twice in the same payment. Add them up into a single application: repeating it would subtract its balance twice.',
  'error.VALIDATION_ERROR.payment.customer_discount_is_credit_note':
    'A discount granted to a customer is not a line of the receipt: it is a CREDIT NOTE, with its document and its egreso CFDI. Issue it with `mnemosine credit-note create --type descuento` and apply it to the invoice.',
  'error.VALIDATION_ERROR.payment.applications_exceed_amount':
    'The applications add up to {total} and the payment is {amount}: more than was paid cannot be applied.',
  'error.VALIDATION_ERROR.payment.applications_mismatch':
    'The applications add up to {total} and the payment is {amount}. They have to match: what is left over would be charged to the control account without coming off any subledger. If the remainder is deliberate, say so with onAccount (--on-account): it will stay as an advance {side, select, cliente {from the customer} other {to vendors}}.',
  'error.VALIDATION_ERROR.payment.currency_mismatch':
    '{document} is in {documentCurrency} and the payment in {paymentCurrency}. An amount in another currency would be subtracted raw from the balance and posted raw, with no exchange rate.',
  'error.VALIDATION_ERROR.payment.document_rate_missing':
    '{document} is in {currency} but its exchange_rate is {rate} (the capture default): it was posted unconverted. Correct the document before {settle, select, cobrarlo {collecting it} other {paying it}}: the exchange difference is measured against the rate the document was born with (NIF B-15).',
  'error.VALIDATION_ERROR.payment.rate_not_positive': "The payment's exchange rate ({rate}) has to be greater than zero.",
  'error.VALIDATION_ERROR.payment.bank_account_inactive':
    'The bank account "{account}" is inactive: it records no new movements. Choose an active account from `bank account list`.',
  'error.VALIDATION_ERROR.payment.advance_other_currency':
    'The advance comes in {currency} and this entity keeps its books in {functional}. I do not record it converted, because the rate and its source are decided by the firm in the policy `fuente_tipo_cambio`, not by me; and I do not record it unconverted, because it would post a figure in another currency as if it were in this one. Apply the {side, select, cliente {receipt} other {payment}} to a document in its currency, or record the advance in {functional}.',
  'error.VALIDATION_ERROR.payment.vendor_unresolved': 'The vendor of the payment could not be determined.',
  'error.VALIDATION_ERROR.payment.customer_unresolved': 'The customer of the receipt could not be determined.',
  'error.FX_AR_ON_ACCOUNT_NOT_WIRED.receipt':
    "The receipt in {currency} leaves {amount} on the customer's account. A balance on account in another currency cannot be applied or unapplied with conversion yet, so I do not record it: apply the whole receipt to invoices in {currency}.",
  // The documents a payment or a receipt settles
  'error.VALIDATION_ERROR.payment.bill_not_payable':
    '{bill} is "{status}" and only a bill in {payable} can be paid: its liability has to be in the ledger first.',
  'error.VALIDATION_ERROR.payment.bill_not_applicable': '{bill} is "{status}" and only a bill in {payable} can be applied to.',
  'error.VALIDATION_ERROR.payment.bill_other_vendor':
    '{bill} belongs to vendor {vendor} and the payment is attributed to {counterparty}: the payment would land in the wrong subledger.',
  'error.VALIDATION_ERROR.payment.bill_exceeds_due':
    '{bill} owes {due} and {settled} is being extinguished ({cash} in cash + {discount} in discount).',
  'error.VALIDATION_ERROR.payment.invoice_not_collectible':
    '{invoice} is "{status}" and only an invoice in {collectible} can be collected: its revenue has to be in the ledger first.',
  'error.VALIDATION_ERROR.payment.invoice_not_applicable':
    '{invoice} is "{status}" and only an invoice in {collectible} can be applied to.',
  'error.VALIDATION_ERROR.payment.invoice_other_customer':
    '{invoice} belongs to customer {customer} and the receipt is attributed to {counterparty}: it would land in the wrong subledger.',
  'error.VALIDATION_ERROR.payment.invoice_exceeds_due': '{invoice} owes {due} and {applied} is being applied.',
  'error.VALIDATION_ERROR.payment.discount_over_terms':
    '{bill} grants {granted} of early-payment discount ("{terms}") and {taken} is being taken. The difference is not a discount: it is paying less. If it is deliberate, say so with --mode residual --short-pay-reason.',
  // Applying, unapplying and reversing what was recorded
  'error.VALIDATION_ERROR.payment.not_completed':
    "{side, select, cliente {Receipt} other {Payment}} {payment} is '{status}': only a 'completed' {side, select, cliente {receipt} other {payment}} admits this event.",
  'error.VALIDATION_ERROR.payment.apply_which_invoices': 'Say which invoice(s) the balance on account applies to.',
  'error.VALIDATION_ERROR.payment.apply_which_bills': 'Say which bill(s) the balance on account applies to.',
  'error.VALIDATION_ERROR.payment.application_document_repeated':
    'The document {document} appears twice in the same application: add them up into one.',
  'error.VALIDATION_ERROR.payment.on_account_short':
    '{side, select, cliente {Receipt} other {Payment}} {payment} has {left} unapplied and {total} is being applied: the balance on account does not cover it.',
  'error.VALIDATION_ERROR.payment.nothing_to_unapply':
    'Receipt {receipt} has no live application on {invoice}: there is nothing to unapply.',
  'error.VALIDATION_ERROR.payment.reversal_fee_not_wired':
    'The return fee cannot be recorded yet: it needs an account with the bank-fees role in the semantic layer. Reverse the receipt without --fee and record the fee as a manual entry meanwhile.',
  'error.VALIDATION_ERROR.payment.short_pay_reason_required':
    'Closing a bill by paying less erases a liability that was owed: say why with --short-pay-reason. Without a written reason, the auditor only sees a balance that disappeared.',
  'error.VALIDATION_ERROR.payment.short_pay_forbidden':
    'The policy `pago_corto_residual` of this firm is set to "prohibir": no bill is closed by paying less. Ask the vendor for the credit note and apply it, or change the policy with `mnemosine pending reopen pago_corto_residual` (if it was already defined) and then `mnemosine pending define pago_corto_residual`.',

  // ---- MNE-001-725 · I9 by folder, part 2: the refusals of the bank match in src/services/banking that were Spanish prose (issue #151) ----
  // `error.<CODE>.<area>.<case>`, codes unchanged: VALIDATION_ERROR for a
  // ValidationError, RESOURCE_ALREADY_EXISTS for a ConflictError. The Spanish
  // twin is the text each site printed. Ids, statuses, amounts, reason codes,
  // commands and flags are parameters or literals, never translated.
  // match-service.ts: the residual gate
  'error.VALIDATION_ERROR.bank_match.write_off_on_zero':
    'The group balances exactly (residual 0.0000): there is nothing to write off, so --residual write-off is not needed. Use keep or drop the flag.',
  'error.VALIDATION_ERROR.bank_match.residual_undeclared':
    'The group does not balance and no one declared what to do with the remainder. Bank {bank} = Books {books} + Adjustments {adjustments} leaves a difference of {difference}. Declare it with --residual keep (it stays alive as a reconciling item) or --residual write-off --write-off-account <account> (it is written off against that account), or correct the items of the group.',
  'error.VALIDATION_ERROR.bank_match.write_off_needs_account':
    'A residual of {difference} that is written off needs an account: --residual write-off requires --write-off-account. Without it the money would have nowhere to go and the imbalance would reappear in the session.',
  'error.VALIDATION_ERROR.bank_match.write_off_account_with_keep':
    '--write-off-account only makes sense with --residual write-off: a residual that is kept is not written off against any account.',
  // match-service.ts: the group, its sides and its session
  'error.VALIDATION_ERROR.bank_match.repeated_id':
    '{side, select, bank {The bank transaction} other {The book item}} {id} appears twice in the group: its amount would count double and the group would balance by asserting twice what there is.',
  'error.RESOURCE_ALREADY_EXISTS.bank_match.item_sealed_by_other_group':
    'Book item {id} is already sealed by match group {group}. Unapply that match before matching it again.',
  'error.VALIDATION_ERROR.bank_match.session_other_account':
    "Session {session} reconciles another bank account: a match cannot belong to the reconciliation of an account other than the transaction's.",
  'error.RESOURCE_ALREADY_EXISTS.bank_match.session_signed_add':
    "Session {session} is '{status}': adding matches to it now would rewrite an assertion already signed.",
  'error.VALIDATION_ERROR.bank_match.preview_needs_target': 'Preview needs a bank account (--account) or a specific transaction.',
  'error.VALIDATION_ERROR.bank_match.apply_needs_transaction': 'Apply needs at least one transaction: there is nothing to match.',
  'error.VALIDATION_ERROR.bank_match.apply_one_account':
    'All the transactions of one `apply` must be of the same bank account: one database transaction cannot be tied to two reconciliations.',
  'error.VALIDATION_ERROR.bank_match.transaction_other_account_than_group':
    "Transaction {id} belongs to a bank account other than the group's ({account}): a match cannot hang from an account that is not its own.",
  'error.VALIDATION_ERROR.bank_match.group_needs_bank': 'A match group needs at least one bank transaction.',
  'error.VALIDATION_ERROR.bank_match.group_needs_books': 'A match group needs at least one book item.',
  'error.VALIDATION_ERROR.bank_match.transaction_other_account':
    'Transaction {id} belongs to another bank account: a match group cannot span two accounts.',
  'error.RESOURCE_ALREADY_EXISTS.bank_match.period_closed':
    "Transaction {id} falls in a period that is '{status, select, missing {nonexistent} other {{status}}}': transactions of a locked period are not matched.",
  'error.RESOURCE_ALREADY_EXISTS.bank_match.transaction_already_matched':
    'Transaction {id} already has the live match {match}: unapply it before putting it in a new group, or the same money would be matched twice.',
  'error.VALIDATION_ERROR.bank_match.item_entry_not_posted':
    "Book item {id} belongs to an entry in '{status}': only posted entries are matched against.",
  'error.RESOURCE_ALREADY_EXISTS.bank_match.item_already_matched':
    'Book item {id} is already matched: unapply that match before including it in a new group.',
  'error.VALIDATION_ERROR.bank_match.opposite_directions':
    'The group adds up {bank} of bank against {books} of books: the two sides point in opposite directions, so the group would match money coming in against money going out.',
  'error.VALIDATION_ERROR.bank_match.orphan_transaction':
    'Transaction {id} receives no book item: the adjustments and the residual absorb it whole, so it would be marked as matched with nothing to explain it. Take it out of the group or give it an item.',
  'error.VALIDATION_ERROR.bank_match.orphan_item':
    'Book item {id} receives no bank transaction: the adjustments and the residual absorb it whole, so it would be sealed with no match to explain it. Take it out of the group, or add the bank transaction that covers it.',
  // match-service.ts: unapplying
  'error.VALIDATION_ERROR.bank_match.unapply_reason_unknown':
    "Unknown unapply reason: '{reason}'. The accepted ones are {known}. The reason is a code and not free prose because causes must be countable, not only readable.",
  'error.RESOURCE_ALREADY_EXISTS.bank_match.already_unapplied':
    'Match {match} was already unapplied: undoing what is already undone is not an act, and its row stays on file with its reason.',
  'error.RESOURCE_ALREADY_EXISTS.bank_match.session_signed_unapply':
    "Session {session} is '{status}': undoing one of its matches would rewrite an assertion already signed. Correct it with a new session, not by erasing this one.",
  // book-items.ts: the seal of the book items
  'error.VALIDATION_ERROR.bank_book_item.partial_seal':
    'The reconciliation seal reached {sealed} of {count} book item(s). The missing ones were already sealed, belong to an unposted entry, or are not of the same entity as group {group}. Nothing is sealed halfway: check the list with `bank book-item list` and build the group again.',
  'error.VALIDATION_ERROR.bank_book_item.partial_release':
    'Released {released} of {count} book item(s). The missing ones were not sealed, or their seal was set by something other than a bank match group of this entity (the account certification uses the same column) and it is not lifted from here.',

  // ---- MNE-001-824 · I9 by folder, part 2b, part 1: the identifier and field checks of a bank account and the refusals of bank transaction reclassify in src/services/banking (issue #151) ----
  // `error.<CODE>.<area>.<case>`, codes and fields unchanged: VALIDATION_ERROR
  // for a ValidationError, RESOURCE_ALREADY_EXISTS for a ConflictError. The
  // Spanish twin is the text each site printed. The act and the empty field are
  // selects, so each label goes with its sentence. Values, types, codes,
  // commands and the column name are parameters or literals, never translated.
  // bank-account-service.ts: the scope of create, edit and set
  'error.VALIDATION_ERROR.bank_account.needs_entity':
    '{act, select, create {Creating a bank account} edit {Editing a bank account} other {Setting the GL mapping of a bank account}} needs a specific entity: a tenant scope does not say in which of its entities the account lives.',
  // the CLABE and the ABA routing
  'error.VALIDATION_ERROR.bank_account.clabe_length':
    'A CLABE is 18 digits (3 for the bank, 3 for the city, 11 for the account and 1 check digit); "{value}" has {length}.',
  'error.VALIDATION_ERROR.bank_account.clabe_check_digit':
    'The CLABE ending in {last4} fails its check digit: the first 17 require {expected} and it has {got}. It is almost always two digits transposed when copying it.',
  'error.VALIDATION_ERROR.bank_account.clabe_bank_000':
    "The CLABE starts with 000, which is the code of no institution in Banxico's catalogue or in the SAT's c_Banco.",
  'error.VALIDATION_ERROR.bank_account.aba_length': 'An ABA routing number is 9 digits; "{value}" has {length}.',
  'error.VALIDATION_ERROR.bank_account.aba_checksum': 'Routing number {routing} fails its ABA checksum (weights 3,7,1, a multiple of 10).',
  'error.VALIDATION_ERROR.bank_account.aba_zero': 'Routing number 000000000 passes the checksum by arithmetic and belongs to no institution.',
  // the other fields of create and edit
  'error.VALIDATION_ERROR.bank_account.type_unknown': '"{value}" is not an account type. The five are: {known}.',
  'error.VALIDATION_ERROR.bank_account.currency_invalid': '"{value}" is not a three-letter ISO currency code.',
  'error.VALIDATION_ERROR.bank_account.sat_bank_code_invalid': 'The SAT bank code (c_Banco) is 3 digits; got "{value}".',
  'error.VALIDATION_ERROR.bank_account.field_empty':
    '{field, select, account_name {The account name} other {The bank name}} cannot be empty.',
  'error.VALIDATION_ERROR.bank_account.swift_invalid':
    '"{value}" does not have the shape of a SWIFT/BIC code (8 or 11 characters: 4 for the bank, 2 for the country, 2 for the location and an optional 3 for the branch).',
  'error.VALIDATION_ERROR.bank_account.iban_invalid':
    '"{value}" does not have the shape of an IBAN (2 country letters, 2 check digits and up to 30 alphanumerics).',
  'error.VALIDATION_ERROR.bank_account.routings_differ':
    'The ACH routing number and the wire one differ, and the table has only one column for both (`routing_number_encrypted`, migration 003): keeping one would lose the other without a word. Create the account with one and open the missing column as F05b work.',
  'error.VALIDATION_ERROR.bank_account.sat_bank_code_not_clabe':
    'The declared bank code ({declared}) is not the one the CLABE carries ({clabe}). They are the same catalogue: one of the two is wrong.',
  // transactions.ts: the type, and bank transaction reclassify
  'error.VALIDATION_ERROR.bank_transaction.type_unknown': '"{value}" is not a bank transaction type. The five are: {known}.',
  'error.VALIDATION_ERROR.bank_transaction.reclassify_sign':
    'Transaction {id} is for {amount} and "{type}" requires an amount {sign, select, out {going OUT of the account (negative)} other {coming INTO the account (positive)}}. A fee refund or a withholding does not change sign by being reclassified.',
  'error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_matched':
    'Transaction {id} is matched: something in the books already explains it. Undo the match with `bank match unapply` before changing what it is.',
  'error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_posted':
    'Transaction {id} was already posted by entry {entry}. Reverse that entry before reclassifying it.',
  'error.RESOURCE_ALREADY_EXISTS.bank_transaction.reclassify_race': 'Transaction {id} changed while it was being reclassified; try again.',
  // ---- end of MNE-001-824 ----

  // ---- MNE-001-825 · I9 by folder, part 2c, part 1: the refusals of the reconciliation adjustments and of the arithmetic in src/services/banking (issue #151) ----
  // `error.<CODE>.<area>.<case>`, codes unchanged: VALIDATION_ERROR for a
  // ValidationError, RESOURCE_ALREADY_EXISTS for a ConflictError. The Spanish
  // twin is the text each site printed. The direction of an adjustment and the
  // item of the arithmetic are selects, so each fragment goes with its
  // sentence. Types, roles, field names and commands are parameters or
  // literals, never translated. The draft's description and reasoning are book
  // data and stay in the service (rule 3 of docs/language.md).
  // reconciliation-adjustments.ts: the type, the amount and its sign
  'error.VALIDATION_ERROR.bank_adjustment.type_unknown': 'Unknown adjustment type "{value}". The accepted ones are: {known}.',
  'error.VALIDATION_ERROR.bank_adjustment.amount_unreadable': 'Unreadable amount for the adjustment: "{value}".',
  'error.VALIDATION_ERROR.bank_adjustment.amount_not_finite': 'Non-finite amount for the adjustment: "{value}".',
  'error.VALIDATION_ERROR.bank_adjustment.amount_zero':
    'The amount of a reconciliation adjustment cannot be zero: a zero entry corrects no difference and the engine would not accept it.',
  'error.VALIDATION_ERROR.bank_adjustment.sign_contradicts_type':
    'Adjustment "{type}" {direction, select, in {puts money into} other {takes money out of}} the account, so its amount must be {direction, select, in {positive} other {negative}}; got {amount}. The sign is NOT flipped here: if the transaction really goes the other way, it is not a "{type}" (it is probably "error").',
  'error.VALIDATION_ERROR.bank_adjustment.not_postable':
    'Adjustment "{type}" carries {amount}, which does not fit in a two-decimal entry: it would post {rounded} and the reconciliation row would still say {amount}. It is not rounded on its own (the two figures would end up contradicting each other): enter the amount it is going to be posted with.',
  // the counterparty account: a role still to be seeded, none to deduce, one not mapped
  'error.VALIDATION_ERROR.bank_adjustment.role_missing.comision':
    'Adjustment "{type}" has no account role to resolve: "{role}" still has to be seeded. The role `comision_bancaria` (6310) already exists and `treasury-posting` consumes it, but this adjustment path does not resolve it by itself yet: until ROL_DE_AJUSTE maps it, the account is given by hand. The neighbour NOT to use is `gasto` (6100), where the fee mixes with everything else and can no longer be counted. Give the account you want to propose it with.',
  'error.VALIDATION_ERROR.bank_adjustment.role_missing.interes':
    'Adjustment "{type}" has no account role to resolve: "{role}" still has to be seeded. The role `producto_financiero` (4310) already exists and `treasury-posting` consumes it, but this adjustment path does not resolve it by itself yet: until ROL_DE_AJUSTE maps it, the account is given by hand. The neighbour NOT to use is `otros_ingresos` (4200), deliberately reserved for the remainder of a short payment. Give the account you want to propose it with.',
  'error.VALIDATION_ERROR.bank_adjustment.account_not_deducible':
    'Adjustment "{type}" has no account that can be deduced (it depends on what was recorded wrongly). Give the account.',
  'error.VALIDATION_ERROR.bank_adjustment.role_unmapped':
    'Adjustment "{type}" relies on account role "{role}", which this entity has not mapped. Map it with `mnemosine account role set {role} <account>` or give the account here.',
  // the session, the bank's GL account, the counterparty, the context and the row
  'error.RESOURCE_ALREADY_EXISTS.bank_adjustment.session_not_open':
    'Session {session} is in status "{status}": it takes no new adjustments. Its figures are the summary frozen at close, and a later adjustment would contradict them.',
  'error.VALIDATION_ERROR.bank_adjustment.bank_gl_foreign':
    'Bank account "{account}" points to a GL account that does not belong to this entity. No entry is proposed against it.',
  'error.VALIDATION_ERROR.bank_adjustment.counterparty_is_bank':
    'The counterparty of the adjustment cannot be the bank account itself ({account}): the entry would debit and credit itself and move no balance.',
  'error.VALIDATION_ERROR.bank_adjustment.context_other_entity':
    'The context received is of entity {context} and the adjustment is of {entity}. They are not crossed: the draft would end up in the books of another.',
  /** `{reason}` is the failed INSERT's own message, as PostgreSQL wrote it (in English): it is not translated. */
  'error.RESOURCE_ALREADY_EXISTS.bank_adjustment.row_not_recorded':
    'Draft {draft} was created but the adjustment could not be recorded in session {session}: {reason}. Reject it in `mnemosine review` (option [r]eject) so it does not stay pending with no owner.',
  // reconciliation-math.ts: what the arithmetic cannot add (`item` is `none` for a balance or the tolerance)
  'error.VALIDATION_ERROR.bank_reconciliation_math.amount_unreadable':
    'Unreadable amount in {item, select, none {} other {item {item}.}}{field}: "{value}".',
  'error.VALIDATION_ERROR.bank_reconciliation_math.amount_not_finite':
    'Non-finite amount in {item, select, none {} other {item {item}.}}{field}: "{value}".',
  'error.VALIDATION_ERROR.bank_reconciliation_math.item_type_unknown':
    'Unknown reconciling item type in item {item}: "{value}". The accepted ones are: {known}.',
  // ---- end of MNE-001-825 ----

  // ---- MNE-001-856 · I9 by folder, part 2b, part 2: the GL mapping gate, the conflicts, the rest of edit and set and the warnings of a bank account in src/services/banking (issue #151) ----
  // Same recipe as MNE-001-824 above: `error.<CODE>.<area>.<case>`, codes and
  // fields unchanged, the Spanish twin is the text each site printed. The header
  // or no-entries reason and the ASSET or LIABILITY class are selects, and the
  // posted line or lines of the remap is an ICU plural, so each fragment goes
  // with its sentence. The warnings are not errors: they are the key half of
  // BankAccountWarning, rendered by the surface (bank-command.ts warningText).
  'error.VALIDATION_ERROR.bank_account.gl_inactive': 'GL account {code} is inactive: a bank account mapped to it could post nothing.',
  'error.VALIDATION_ERROR.bank_account.gl_not_postable':
    '{code} {reason, select, header {is a header account} other {does not take entries}}: the bank mapping must point at a posting account.',
  'error.VALIDATION_ERROR.bank_account.gl_wrong_class':
    'An account of type {type} is {expected, select, liability {a LIABILITY} other {an ASSET}} and {code} is classified as {glType}. With the type crossed, the balance is presented with its sign inverted.',
  'error.VALIDATION_ERROR.bank_account.gl_currency':
    'The bank account is in {currency} and GL account {code} in {glCurrency}. A book balance that adds two currencies cannot be reconciled against any statement: use a GL account in {currency}, or create the bank account in {glCurrency}.',
  // the conflicts: one name, one GL account, one account per ref
  'error.RESOURCE_ALREADY_EXISTS.bank_account.ambiguous_ref':
    '"{ref}" names {count} bank accounts within this scope. Narrow it to an entity or use the id.',
  'error.RESOURCE_ALREADY_EXISTS.bank_account.name_taken':
    'This entity already has a bank account called "{name}" ({id}). The name is what the terminal calls it by: repeating it leaves both without a handle.',
  'error.RESOURCE_ALREADY_EXISTS.bank_account.gl_taken':
    "GL account {code} is already taken by bank account \"{name}\" ({id}). The mapping is 1:1: two bank accounts on the same GL account share a book balance and each reconciliation sees the other's transactions.",
  'error.RESOURCE_ALREADY_EXISTS.bank_account.gl_taken_unseen':
    'GL account {code} is already taken by a bank account this scope cannot see. The mapping is 1:1.',
  // edit and set
  'error.VALIDATION_ERROR.bank_account.gl_outside_entity':
    'The account points at a GL account outside this entity: fix the mapping with `bank account set` before moving type or currency.',
  'error.VALIDATION_ERROR.bank_account.sensitive_needs_reason':
    'Changing {fields} requires a reason: it is the datum the money leaves with, and a change with no reason in the log cannot be told apart from a diversion.',
  'error.VALIDATION_ERROR.bank_account.clabe_other_bank':
    'The new CLABE belongs to bank {bank} and the account keeps SAT code {code}. Changing banks is creating another account, not editing this one.',
  'error.VALIDATION_ERROR.bank_account.nothing_to_change':
    'No change was asked for. Editable fields: name, bank, branch, SWIFT, IBAN, SAT code, type, currency, CLABE, account number, routing and the foreign-bank mark.',
  'error.RESOURCE_ALREADY_EXISTS.bank_account.remap_has_history':
    '{code} already has {lines} posted {lines, plural, one {line} other {lines}} (balance {balance}). Remapping would leave that balance orphaned: with no bank account to reconcile it and out of the new one\'s reach. If that is really what you want, repeat with --force and a reason.',
  'error.VALIDATION_ERROR.bank_account.forced_remap_needs_reason': 'Forcing the remap of an account with posted history requires a reason.',
  // the warnings: BankAccountWarning, rendered by the surface (bank-command.ts warningText)
  'bank.account.warning.gl_outside_entity':
    'The mapped GL account does not belong to this entity: the book balance reads as zero and the reconciliation has nothing to run against. Fix it with `bank account set`.',
  'bank.account.warning.gl_currency':
    'The account is in {currency} and its GL account {code} in {glCurrency}: the book balance mixes two currencies.',
  'bank.account.warning.gl_class': 'An account of type {type} should map to a GL account of type {expected}, and {code} is {glType}.',
  'bank.account.warning.single_signature':
    'Identifier change applied with ONE signature only. The catalogue requires a second approval by another user and the table to hold it does not exist yet; the reason and the actor stay in the log.',
  'bank.account.warning.already_mapped': 'The account was already mapped to {code}: there was nothing to write.',
  'bank.account.warning.remapped_over_history':
    'Remapped over {lines} posted {lines, plural, one {line} other {lines}} of {code} (balance {balance}): that balance is left with no bank account to reconcile it.',
  // ---- end of MNE-001-856 ----

  // ---- MNE-001-857 · I9 by folder, part 2c, part 2: the refusals of the reconciling items, reconciling-items.ts in src/services/banking (issue #151) ----
  // `error.<CODE>.<area>.<case>`, codes unchanged: VALIDATION_ERROR for a
  // ValidationError, RESOURCE_ALREADY_EXISTS for a ConflictError. The Spanish
  // twin is the text each site printed. The closing date of a session is a
  // select, so its clause goes with its sentence. Types, sides, escalation
  // values and field names are parameters or literals, never translated.
  // classify (and the --type of bank reconciling-item list)
  'error.VALIDATION_ERROR.bank_reconciling_item.classify_amount_unreadable': 'Unreadable amount when classifying the item: "{value}".',
  'error.VALIDATION_ERROR.bank_reconciling_item.classify_amount_not_finite': 'Non-finite amount when classifying the item: "{value}".',
  'error.VALIDATION_ERROR.bank_reconciling_item.type_unknown': 'Unknown reconciling item type "{value}". The accepted ones are: {known}.',
  'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.classify_session_not_open':
    'Session {session} is in status "{status}"{closedAt, select, none {} other { and closed on {closedAt}}}: it takes no new items. Its figures are the summary frozen at close; to classify again it has to be reopened.',
  // bank reconciling-item correct and assign
  'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.session_not_open':
    'Session {session} is in status "{status}"{closedAt, select, none {} other { and closed on {closedAt}}}: its items are no longer touched. Its figures are the summary frozen at close, and moving an item afterwards would contradict them without anyone having reopened anything.',
  'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.already_resolved':
    'Item {item} is already resolved: it stopped explaining a difference, and reclassifying it would change a closed history.',
  'error.VALIDATION_ERROR.bank_reconciling_item.side_change_needs_amount':
    'Moving item {item} from "{type}" (side {side}) to "{newType}" (side {newSide}) changes which of the two balances it corrects, and its contribution of {amount} would stop meaning the same. Give the new amount, SIGNED by its contribution to the {newSide} side.',
  'error.VALIDATION_ERROR.bank_reconciling_item.reclassify_amount_unreadable': 'Unreadable amount when reclassifying: "{value}".',
  'error.VALIDATION_ERROR.bank_reconciling_item.reclassify_amount_zero':
    'The amount of an item cannot be zero or unreadable; got "{value}". An item that contributes zero explains no difference: resolve it instead of leaving it at zero.',
  'error.RESOURCE_ALREADY_EXISTS.bank_reconciling_item.reclassify_race':
    'Item {item} was not reclassified: either its session is no longer in progress, or the item was resolved meanwhile. Nothing was changed.',
  'error.VALIDATION_ERROR.bank_reconciling_item.expected_date_format': '`fechaEsperada` must come as YYYY-MM-DD; got "{value}".',
  'error.VALIDATION_ERROR.bank_reconciling_item.overdue_by_hand':
    '"vencido" is not set by hand: the expected date against today decides it. If the item is already overdue, adjust its `fechaEsperada`; if it was only chased, mark it "avisado".',
  'error.VALIDATION_ERROR.bank_reconciling_item.escalation_unknown': 'Unknown escalation "{value}". Accepted here: {known}.',
  'error.VALIDATION_ERROR.bank_reconciling_item.nothing_to_assign':
    'Nothing to assign was given: responsable, fechaEsperada, escalamiento or notas.',
  // ---- end of MNE-001-857 ----

  // ---- MNE-001-727 · I9 by folder, part 4: the refusals of src/services/fiscal that were Spanish prose (issue #151) ----
  // `error.<CODE>.<area>.<case>`, codes, statuses and fields unchanged. The
  // Spanish twin is the text each site printed. Policy keys and their values,
  // kinds, option names, years and dates are parameters; commands and legal
  // references are literals, never translated.
  // the three closed readers of the panel: one sentence, three codes (the sentence of payroll_reader)
  'error.POLICY_VALUE_UNKNOWN.fiscal_reader':
    'The policy {policy} is set to "{value}" and this reader only understands {known}. Correct it in mnemosine pending.',
  // iva-workpaper.ts: the IVA workpaper's own guards
  'error.VALIDATION_ERROR.iva_workpaper.prior_balance_amount':
    'The balance in favor from prior periods is "{value}": it must be an amount of zero or more.',
  'error.VALIDATION_ERROR.iva_workpaper.month': 'Month {month} does not exist: the definitive IVA is monthly.',
  'error.VALIDATION_ERROR.iva_workpaper.entity_without_mexican_iva':
    'The entity does not owe Mexican IVA: there is no definitive IVA to compute.',
  // provisional-income-tax.ts: the ISR workpaper's own guards
  'error.VALIDATION_ERROR.isr_workpaper.amount': '{field} is "{value}": it must be an amount of zero or more.',
  'error.VALIDATION_ERROR.isr_workpaper.month': 'Month {month} does not exist: the provisional payment is monthly.',
  'error.VALIDATION_ERROR.isr_workpaper.entity_without_mexican_books':
    'The entity does not keep Mexican books: there is no provisional ISR to compute.',
  // provisional-income-tax-inputs.ts: the annual figures the provisional ISR reads
  'error.VALIDATION_ERROR.income_tax_input.payment_month': '{year}-{month} is not a provisional payment month.',
  'error.VALIDATION_ERROR.income_tax_input.kind': '"{kind}" is not an input of the provisional ISR: {known}.',
  'error.VALIDATION_ERROR.income_tax_input.year_not_integer': 'The fiscal year of the source return must be a whole number.',
  'error.VALIDATION_ERROR.income_tax_input.value_format':
    '"{value}" is not a non-negative figure with up to four decimals.',
  'error.VALIDATION_ERROR.income_tax_input.source_missing':
    'The source is missing: the annual return the figure was taken from.',
  'error.VALIDATION_ERROR.income_tax_input.filed_inside_year':
    'The return for {year} is filed after the fiscal year ends: "{filedOn}" cannot be its date.',
  'error.VALIDATION_ERROR.income_tax_input.update_month_required':
    'Pending losses state the INPC month they are updated through (YYYY-MM, LISR art. 57).',
  'error.VALIDATION_ERROR.income_tax_input.update_month_only_for_losses':
    'Only pending losses carry an update month.',

  // ---- MNE-001-728 · I9 by folder, part 5: the refusals of src/services/xml-ingestion that were Spanish prose (issue #151) ----
  // `error.<CODE>[.<case>]`, codes unchanged. The Spanish twin is the text each
  // site printed. Role ids, commands, flags and the `--direction` values are
  // parameters or literals, never translated.
  // pre-registration-service.ts
  'error.PROVEEDOR_NUEVO_SIN_AUTORIZAR':
    'The CFDI is issued by "{name}" (RFC {rfc}), who is not in this entity\'s vendor catalog. Posting it here would register the counterparty with the name and RFC the XML carries (master data written by a third party, approved by no one) and then recognize the liability in the ledger. Two ways out: register the vendor yourself with `mnemosine vendor create --tax-id {rfc}` and run again (the pre-registration will find it by RFC); or repeat the command with --allow-new-vendor if you accept creating it as the receipt states it.',
  'error.AP_ACCOUNT_MISSING':
    'The entity has no account for the role "cxp" (vendors). Seed the books with: mnemosine init --section identity',
  'error.MISSING_ROLE_ACCOUNT.seed_identity':
    'The entity has no account for the role "{role}". Seed the books with: mnemosine init --section identity',
  'error.REP_SIN_XML': 'The XML of the payment receipt is not kept.',
  'error.ENTITY_NOT_FOUND.pre_registration': "The pre-registration's entity does not exist.",
  'error.REP_SIN_PAGOS': 'The receipt is of type P but carries no payments complement: there is nothing to link.',
  'error.CFDI_REQUIERE_DECISION.not_a_party':
    'The receipt is from {issuer} to {receiver} and the entity is {entity}: it is not a party to the transaction. Check whether it was uploaded to the wrong entity.',
  // cfdi-posting-plan.ts
  'error.CFDI_REQUIERE_DECISION.missing_accounts':
    'The entity has no account for: {missing}. Seed the books with: mnemosine init --section identity',
  'error.CFDI_REQUIERE_DECISION.unbalanced': 'The proposed entry does not balance: debits {debits} vs credits {credits}.',
  // cfdi-query-service.ts
  'error.VALIDATION_ERROR.cfdi.direction': 'Unreadable --direction "{direction}": the values are emitido, recibido and ajeno.',
  'error.RESOURCE_NOT_FOUND.classification_trail':
    'Classification with id {uuid} not found (the trail exists for what was ingested since F02; earlier CFDIs were classified and their trail discarded)',

  // ---- MNE-001-729 · I9 by folder, part 6: the messages of src/api/rest that reached the caller in Spanish prose (issue #151) ----
  // `error.<CODE>[.<case>]` for an error, codes unchanged; `api.<router>.<case>` for
  // a text a route writes into a response body. The Spanish twin is the text each
  // site printed. Header names, fields, commands and values are parameters or
  // literals, never translated.
  // middleware/auth.ts
  'error.FORBIDDEN.entity_header_repeated': 'x-entity-id is repeated: a request acts on a single entity',
  'error.VALIDATION_ERROR.entity.several_named':
    "The request names {count} different entities ({named}). Each route uses the source that belongs to it and the audit log records the header's, so with two there is no knowing which one was worked on. Send only one.",
  /** One item of `named` above; the items are joined with '; ' in every language. */
  'error.VALIDATION_ERROR.entity.named_source':
    '{source, select, header {the x-entity-id header} route {the route (:entity_id)} body {the body} other {the query string (?entity_id=)}}: {value}',
  // the idempotency middleware
  'error.VALIDATION_ERROR.idempotency_key.repeated':
    'The request carries {count} {header} headers. Send exactly one: with two, which one wins would silently decide whether this act is repeated or not.',
  'error.VALIDATION_ERROR.idempotency_key.empty':
    'The {header} header is empty. Remove it, or send a key: an empty key deduplicates nothing and makes it look as if it did.',
  'error.VALIDATION_ERROR.idempotency_key.too_long': 'The idempotency key is {length} characters long and the maximum is {max}.',
  'error.VALIDATION_ERROR.idempotency_key.malformed':
    'The idempotency key "{value}" carries characters that are not accepted. Use letters, digits and _ . : @ + / = - (a UUID works). The comma and the space are left out on purpose: that is how TWO headers arrive once the server joins them, and such a key is not the one anybody sent — the retry would not match and the act would be repeated silently.',
  'error.VALIDATION_ERROR.idempotency_key.no_tenant':
    'Cannot honour {header}: the request does not identify a tenant, and consumed keys are kept per tenant.',
  // middleware/tenant-context.ts
  'error.UNAUTHORIZED.no_tenant': 'The token does not identify a tenant: the request cannot be scoped and is refused.',
  // routes/xml-ingestion.ts
  'error.VALIDATION_ERROR.xml.batch_cap': 'xml_contents must be an array of at most {max} documents.',
  'error.FORBIDDEN.detail.issued_payment_receipt': 'An issued payment receipt records customer collections.',
  // routes/invoices.ts
  'api.invoices.send_note': 'The invoice is recorded as sent; the system does not transmit email. Sending it is up to the user.',
  'error.NOT_IMPLEMENTED.cfdi_cancellation':
    "mnemosine does not cancel CFDIs before the SAT yet. Cancel in your PAC's portal or in the SAT's, then reverse the entry with `mnemosine entry reverse <number> --reason \"CFDI cancelled, acknowledgment <folio>\"`. When it exists, cancellation will go through pac-router with the acknowledgment archived and a chained reversal.",
  // routes/blockchain.ts
  'api.blockchain.simulated_attestations':
    '{simulated} of {total} attestations on this page are SIMULATED: their txHash, block number and explorer link are fabricated and match no transaction. They are no proof before a third party.',
  'api.blockchain.simulated_anchors':
    '{simulated} of {total} anchors on this page are SIMULATED: their txid was made up locally and does not exist on Bitcoin. Do not publish them as proof before a third party, nor share an explorer link to them.',
  // routes/public-verification.ts
  'error.ATTESTATION_SIMULATED':
    '{what, select, entry_attestation {The attestation of that entry} period_commitment {The commitment of that period} bitcoin_anchor {That Bitcoin anchor} other {The anchor proof of that entry}} exists, but its anchoring is SIMULATED: no hash was written to any chain, so there is nothing a third party can check. This endpoint refuses to present it as proof. It will answer again when a real chain adapter exists.',
  'api.public_verification.bitcoin_simulated_step': '6. The Bitcoin anchor is SIMULATED: there is no OP_RETURN on the chain to check',

  // ---- MNE-001-730 ·I9 by folder, part 7: the refusals of src/services/payroll that were Spanish prose (issue #151) ----
  // `error.<CODE>[.<case>]`, codes unchanged. The Spanish twin is the text each
  // site printed. Policy keys, their values, commands and `termination_reason`
  // are literals or parameters, never translated.
  // the employer liability and the ISN: an answer of the panel the engine does not know
  'error.VALIDATION_ERROR.payroll.policy.provision_cuotas_patronales':
    'The policy provision_cuotas_patronales is set to "{value}" and this engine only understands {known}. None is chosen for you: that answer decides whether the employer contributions are booked with each run or once a month, and applying the default as if it were your criterion leaves the month\'s liability split between two ways of counting it. Correct it with `mnemosine pending define provision_cuotas_patronales <{choices}>`.',
  'error.VALIDATION_ERROR.payroll.policy.isn_momento_de_causacion':
    'The policy isn_momento_de_causacion is set to "{value}" and this engine only understands {known}. None is chosen for you: that answer decides which MONTH the ISN of a payroll that crosses the month end belongs to, and with it its due date: a liability booked a month earlier than decided cannot be told from a correct one until the authority\'s demand arrives. Correct it with `mnemosine pending define isn_momento_de_causacion <{choices}>`.',
  'error.VALIDATION_ERROR.payroll.policy.isn_estado_que_causa':
    'The policy isn_estado_que_causa is set to "{value}" and this engine only understands {known}. None is chosen for you: that answer decides which state the ISN is declared to, and applying the default as if it were your criterion is how a firm ends up owing a state for years. Correct it with `mnemosine pending define isn_estado_que_causa <{choices}>`.',
  // the employer liability
  'error.VALIDATION_ERROR.payroll.date_unreadable':
    'Expected a date \'YYYY-MM-DD\' and got "{date}": an unreadable date here would produce a plausible and false due date.',
  'error.VALIDATION_ERROR.payroll.pay_run_not_found': 'Pay run {payRunId} does not exist in this tenant.',
  'error.VALIDATION_ERROR.payroll.pay_run_not_closed':
    'Pay run {payRunId} is in status "{status}": the employer liability is booked when the run closes (approved or paid), not before. Booking it on figures that can still change leaves a liability that matches no payslip.',
  // the three readers of the employment subsidy's policies: one sentence, three codes
  'error.POLICY_VALUE_UNKNOWN.payroll_reader':
    'The policy {policy} is set to "{value}" and this reader only understands {known}. Correct it in mnemosine pending.',
  // the severance settlement
  'error.VALIDATION_ERROR.payroll.termination_reason':
    'termination_reason is invalid or missing: expected {known}. It decides whether a seniority premium is owed, which for a long-serving worker is the largest item of the severance settlement, so it has no default.',

  // ---- MNE-001-815 · I9 by folder, part 7b: the findings and notes of src/services/payroll (issue #151) ----
  // Rendered by the surface in its reader's language; the Spanish twin is the text each site wrote.
  // Codes, policy keys, values, tables, columns and law articles are literals.
  'payroll.finding.isn_sin_estado_en_el_trabajador':
    '{count} payslip(s) of the period {start} to {end} add up to {base} with no state that causes them: the ISN of that base cannot be computed or declared. Capture the worker\'s work state, or change the policy isn_estado_que_causa to domicilio_fiscal if your criterion is to declare it all at the entity\'s address.',
  'payroll.finding.isn_sin_tasa_capturada.none':
    'No ISN rate is captured for {state} in the period {start} to {end} (causation {causation}). The base of {base} of {count} payslip(s) is NOT computed: zero is not declared, the missing figure is. Capture the rate with its legal basis in mx_isn_tasas_estatales.',
  'payroll.finding.isn_sin_tasa_capturada.not_in_force':
    '{state} has {count} captured validity period(s) that touch the period {start} to {end} or its causation, but none covers the causation date {causation}: the base of {base} is not computed. Check vigencia_desde/vigencia_hasta.',
  'payroll.finding.isn_regimen_no_soportado':
    'The ISN rate of {state} in force since {since} is captured as regime «{regime}»{exempt, select, none {} other { (it exempts {exempt} a month)}}, and this engine can only compute a flat rate. The base of {base} of the period {start} to {end} is NOT computed: applying the rate as if it were flat would give an amount of the right size and the wrong value.',
  'payroll.finding.isn_tasa_cambia_dentro_del_periodo':
    '{state} changed its rate within the period {start} to {end}: the rate in force on {causation} ({rate}, since {since}) was applied to the whole base, without splitting it by days.',
  'payroll.finding.recibos_de_otra_entidad_en_la_corrida':
    '{count} Mexican payslip(s) of this run belong to workers of ANOTHER legal entity and are not part of the liability of {entityId}, which is the entity of the run\'s schedule. Their IMSS, INFONAVIT and ISN are not accrued anywhere.',
  'payroll.finding.imss_patronal_en_cero':
    'The run has {count} Mexican payslip(s) and the employer IMSS adds up to zero. Check the SBC of those workers: without it there is no contribution to accrue and the labour cost of the run falls short.',
  'payroll.finding.pasivo_por_corrida_absorbido_por_el_mensual':
    '{count} employer contribution row(s) this run had booked on its own were removed: `provision_cuotas_patronales` now says «mensual_al_cierre» and the month\'s row already includes them. Leaving them would have doubled the employer IMSS of the month.',
  'payroll.finding.pasivo_mensual_y_por_corrida_a_la_vez':
    'There are {count} employer contribution row(s) provisioned AT MONTH END in the months this run touches ({rows}), and this run is also booking them PER RUN because `provision_cuotas_patronales` changed to «por_corrida». The provision is counted twice. The monthly row adds up several runs and this close cannot remove it without taking the liability of the others with it: resolve it by hand before filing.',
  'payroll.finding.pasivo_mensual_y_por_corrida_a_la_vez.row': '{taxType} {amount} of the month starting {monthStart}',
  'payroll.finding.share_in_already_settled_month':
    'The run crosses the month end: {days} contribution day(s), from {start} to {end}, fall in the month starting {monthStart}, which already has {settled, select, rows {{closedRows} employer IMSS/INFONAVIT row(s) already deposited} sua {its SUA file already generated} other {{closedRows} employer IMSS/INFONAVIT row(s) already deposited and its SUA file already generated}}. That share of the contributions arrives after the month was closed: the SUA already generated declares it short and, if the month\'s row was already deposited, it is not rewritten. File the complementary return for that month.',
  'payroll.finding.pasivo_reubicado_de_mes':
    '{count} liability row(s) of this run changed month in this close and the previous entry was removed: the answer of `isn_momento_de_causacion` moves the ISN to the month of accrual or to the month of payment, and leaving both would have doubled the tax. Check the due dates of the month that was emptied and of the one that was filled.',
  'payroll.finding.pasivo_ya_depositado_no_se_toca':
    '{count} liability row(s) are no longer in \'pending\' —deposited, waived or marked late— and were NOT rewritten: {rows}. Changing their amount would erase the evidence of what was paid.',
  'payroll.finiquito.seniority_premium.not_owed':
    'not earned: a resignation pays a seniority premium only after fifteen full years of service (LFT art. 162 fr. III)',
  'payroll.finiquito.seniority_premium.not_calculated':
    'NOT CALCULATED: the minimum wage of the zone is missing, and the cap of art. 486 hangs on it. {days} days of seniority premium are owed and are NOT in this total',
  'payroll.finiquito.seniority_premium.calculated':
    '{days} days × {base} (LFT art. 162 fr. I, base capped by art. 486 with a minimum wage of {minimumWage})',

  // ---- MNE-001-822 · I9 by folder, part 7c: the SUA cross-check and the data gaps of src/services/payroll (issue #151) ----
  // The SUA findings render inside `imss.sua.mismatch`; their stored detail stays the Spanish twin.
  // Each gap is a 500 with its own code, `error.<CODE>[.<case>]`. The Spanish twin is the text each
  // site printed. Buckets, policies, values, tables, frequencies and law articles are literals or parameters.
  'payroll.sua.finding.no_liability':
    'the file declares {file} of {concept} and no liability row is recorded for {monthStart}..{monthEnd} to check it against: the figure comes from one road only and nobody confirms it',
  'payroll.sua.finding.mismatch':
    '{concept}: the file declares {file} and the recorded liability says {ledger} (difference {difference}). If a period crosses the month end and its liability was recorded before the split by contribution days, that row carries it whole in one month: `npm run backfill:straddling-liabilities -- --tenant <id>` splits it',
  'error.PAYROLL_ACCOUNT_MAPPING_MISSING.subsidy_in_cash':
    'Missing payroll_account_mapping for bucket: {bucket}. The run handed over {amount} of employment subsidy in cash and the policy subsidio_al_empleo_entregado_registro says to record it as {value}.',
  'error.EMPLOYMENT_SUBSIDY_PERIOD_UNSUPPORTED':
    'There is no employment subsidy rule for the period "{frequency}": the decree prorates by days over 30.4, and only the week (7), the fortnight (15) and the month have an art. 96 tariff to credit it against. Set the payroll up as weekly, fortnightly or monthly.',
  'error.ISR_TARIFF_PERIOD_UNSUPPORTED':
    'No art. 96 tariff is published for the period "{frequency}": Anexo 8 publishes daily, 7, 10 and 15 days and monthly, and no 14-day one. The MONTHLY tariff used to be applied to the base of the period, which under-withholds by between 85 % and 100 %. Set the payroll up as fortnightly or monthly, or seed the tariff that applies, with its source.',
  'error.TAX_PARAMETERS_YEAR_MISMATCH':
    'The parameters of {jurisdiction} were asked for the tax year {taxYear} with a date of another year ({day}): the tax year and the date of the act must be the same, or recalculating an old payslip would take today\'s parameters.',
  'error.TAX_PARAMETERS_MISSING':
    'No tax parameters of {jurisdiction} are in force on {day} (tax year {taxYear}): seed the row in tax_parameters before calculating. Without it nothing can be withheld, and an invented figure reaches the payslip, the CFDI and the payment reference line.',
  'error.TAX_PARAMETER_MISSING':
    'The tax parameter "{parameter}" of {jurisdiction} for {taxYear} is missing: without it the contribution cannot be computed. It used to be replaced by a hard-coded value, and the invented figure reached the payslip, the payroll CFDI and the payment reference line.',
  'error.TAX_RATES_MISSING.block':
    'The rate block "{block}" of MX for {taxYear} is missing: without it the contribution would come out as zero with the right contribution days, which is a payslip that is credible and false.',
  'error.TAX_RATES_MISSING.rates':
    'Rates are missing in "{block}" of MX for {taxYear}: {missing}. A missing rate is not a zero rate.',

  // ---- MNE-001-726 · I9 by folder, part 3: the refusals of src/services/sat/diot (issue #151) ----
  // `error.<CODE>[.<case>]`, codes unchanged. The Spanish twin is the text each site
  // printed. The layout's own words are literals: sections (§3.1), field numbers,
  // the ZZZ country key, LIVA articles, the policy key and its value.
  // construirDiot and its taxpayer
  'error.VALIDATION_ERROR.diot.entity_not_mexican':
    'The entity {name} is not Mexican (country {country}). The DIOT is an obligation under the LIVA: there is no informative return of operations with third parties to build for an entity that does not cause IVA.',
  'error.VALIDATION_ERROR.diot.entity_without_rfc':
    'The entity {name} has no RFC on file, and the DIOT is filed in the name of an identified taxpayer.',
  'error.VALIDATION_ERROR.diot.month':
    'The month of the DIOT is {month}. The return is monthly and has no month 13: the year-end trial balance of Anexo 24 does, this one does not.',
  // the SAT serializer
  'error.DIOT_FORMATO_NO_FUNDAMENTADO':
    'The DIOT of {period} is filed with the layout of fiscal year 2024 and earlier, which this repository does not implement: only the one for 2025 onward is grounded ({url}, consulted on {consulted}). A period the authority validates with the old shape is not written in the new one.',
  'error.DIOT_NO_ENTREGABLE.no_third_parties':
    'The DIOT of {period} has no third parties to declare: an empty batch file is not a return, and it is not written.',
  /** `refusals`: the items below, one per line, rendered in the same language. */
  'error.DIOT_NO_ENTREGABLE.sat_batch': 'The DIOT of {period} does not fit the SAT layout as it stands:\n  · {refusals}',
  // the refusals of the batch layout, one per third party and reason; `who` is the vendor and its RFC
  'error.DIOT_NO_ENTREGABLE.sat_batch.operation':
    '{who}: third-party type {partyType} with operation type {operation}, which the 2025 layout does not accept (§3.1: {allowed}).',
  'error.DIOT_NO_ENTREGABLE.sat_batch.country':
    '{who}: the country "{country}" is not a three-letter key of the layout\'s country catalogue (§5, e.g. USA; ZZZ for other). Correct the vendor\'s country of residence.',
  'error.DIOT_NO_ENTREGABLE.sat_batch.country_other':
    '{who}: country ZZZ (Otro) requires the jurisdiction to be specified, and the record does not have it.',
  'error.DIOT_NO_ENTREGABLE.sat_batch.too_long':
    '{who}: the tax identification exceeds 40 characters or the name 300 (§3.1).',
  'error.DIOT_NO_ENTREGABLE.sat_batch.too_wide':
    '{who}: the amount {amount} does not fit in a numeric field of {digits} positions.',
  'error.DIOT_NO_ENTREGABLE.sat_batch.iva_without_acts':
    '{who}: it has IVA of {iva} (field {ivaField}) with no value of acts above zero in field {valueField}, and the layout only accepts the IVA when there is one (§3.3).',
  'error.DIOT_NO_ENTREGABLE.sat_batch.border_rate':
    '{who}: it has acts at the 8 % rate, and the layout splits them into the NORTHERN border region (fields 8 and 18) and the SOUTHERN one (10 and 20). The record does not say which one the vendor is in.',
  'error.DIOT_NO_ENTREGABLE.sat_batch.unnamed_rates': '{who}: it has amounts at rates the layout does not name ({rates}).',
  'error.DIOT_NO_ENTREGABLE.sat_batch.foreign_zero_rate':
    '{who}: it has 0 % acts ({base}) from a foreign vendor. Field 51 is for domestic 0 % acts; a foreign vendor\'s go in field 53 (not subject, no establishment in Mexico), in the import of services (self-assessed IVA) or in field 49 (exempt import), depending on the operation. Capture it in the portal.',
  /** `fields`: the items `.field`, joined with '; '. `anyUndone` is `yes` or `no`; `undone` lists the bills. */
  'error.DIOT_NO_ENTREGABLE.sat_batch.negative_net':
    '{who}: the month\'s net is negative ({fields}): what the month undid or returned exceeds what it paid. Bills of a payment unapplied or reversed in the month: {anyUndone, select, no {none} other {{undone}}}. The layout accepts no negative amounts and declares returns, discounts and rebates in its own fields of §3.2, which this file does not fill yet; capture it in the portal.',
  'error.DIOT_NO_ENTREGABLE.sat_batch.negative_net.field': 'field {field}: {amount}',
  'error.DIOT_NO_ENTREGABLE.sat_batch.proportion':
    'The policy diot_creditable_iva_proportion is set to "{proportion}": the entity applies the proportion of LIVA art. 5 frac. V, which this system does not compute yet. The creditable IVA is allocated by hand in the portal.',

  // ---- MNE-001-830 · I9 by folder, part 3b: the findings of the DIOT, src/services/sat/diot (issue #151) ----
  // A finding's message is rendered by the surface in its reader's language (`textIn`, src/utils/errors.ts);
  // the Spanish twin is the text each site wrote. Codes, party and operation types, policy keys and
  // values, the generic RFCs, §3.1 and LIVA articles are literals or parameters.
  // the RFC motive, a fragment of `no_rfc` and `no_rfc_declared_global` (list `reason`)
  'diot.rfc_reason.empty': 'has no RFC on file',
  'diot.rfc_reason.generic_national': 'has the generic RFC {rfc}, which is the one of the general public and identifies no one',
  'diot.rfc_reason.generic_foreign':
    'has the generic RFC {rfc}, which is the one of residents abroad: the DIOT identifies them by their tax identification number, not by it',
  'diot.rfc_reason.malformed':
    'has "{rfc}" as its RFC, which does not have the shape of a Mexican RFC (12 characters for a legal person or 13 for an individual: 3 or 4 letters, YYMMDD and a homoclave of 3)',
  'diot.rfc_reason.impossible_date': 'has "{rfc}" as its RFC, whose date ({date}) does not exist',
  'diot.rfc_reason.valid': 'RFC with a valid shape',
  // the third party
  'diot.finding.operation_type_not_allowed':
    'The vendor {name} is third-party type {partyType} and has operation type {operation} on file, which the 2025 DIOT catalogue does not accept for that type of third party (§3.1: {allowed}). Correct the vendor\'s operation type.',
  'diot.finding.operation_type_undeclared':
    'The vendor {name} has no declared operation type and the policy asks not to assume one. It is a datum of the VENDOR, not of the invoice: it is captured once and holds for every month.',
  'diot.finding.policy_out_of_catalogue':
    'The policy {policy} is set to "{value}", which is not {allowed}. Stopping is preferred to inventing an equivalence: the catalogue is set by the authority.',
  'diot.finding.operation_type_by_default':
    'The vendor {name} is declared with operation type {operation} by default: it has none on file. Refine it if its operation is another of those the catalogue accepts (§3.1: {allowed}).',
  /** `missing`: the items `.tax_id`, `.country`, `.nationality`, joined with ', '. */
  'diot.finding.foreign_incomplete':
    'The vendor {name} is declared as a foreign third party (05) and is missing: {missing}. The layout asks for all three, and the authority rejects an incomplete type 05 row when it receives the file, once the deadline has run.',
  'diot.finding.foreign_incomplete.tax_id': 'tax identification number',
  'diot.finding.foreign_incomplete.country': 'country of residence',
  'diot.finding.foreign_incomplete.nationality': 'nationality',
  'diot.finding.global_with_rfc':
    'The vendor {name} is marked as a global third party (15) and has the RFC {rfc} on file. Type 15 declares operations with no identifiable counterparty: it is declared with the generic {generic} and its real RFC does not travel. Check whether the third-party type is the right one.',
  'diot.finding.no_rfc_declared_global':
    'The vendor {name} {reason}, and by policy it is declared as a global third party (15) with the generic {generic}. The return will say those purchases had no identifiable counterparty, and the authority cross-checks it against what that vendor declared on its side.',
  'diot.finding.no_rfc':
    'The vendor {name} {reason}. Without an RFC that identifies it, it cannot be declared as a domestic third party, and type 15 is for the general public, not a drawer for vendors whose RFC nobody captured.',
  // the return itself
  'diot.finding.exempt_revenue_without_proportion':
    'The ledger records {exemptRevenue} of exempt revenue in the fiscal year (accounts with grouping code {groupingCodes}), and the policy diot_creditable_iva_proportion declares all the IVA as tied to exclusively taxed activities. With exempt activities the creditable IVA follows the proportion of art. 5 frac. V LIVA: answer the policy with "block" and allocate the IVA in the portal.',
  'diot.finding.proportion_by_default':
    'All the creditable IVA is declared as tied to exclusively taxed activities because the policy diot_creditable_iva_proportion is not answered. Confirm it if the entity has no exempt activities.',
  'diot.finding.exempt_base_policy_out_of_catalogue':
    'The policy diot_iva_exento_y_base is set to "{value}", which is not {first}, {second} or {third}.',
  'diot.finding.bill_without_lines':
    'The bill {billNumber} has no stored lines, so its IVA cannot be split by rate. The DIOT declares by rate, not a total.',
  'diot.finding.vendor_of_another_entity': 'The bills {bills} point to the vendor {vendorId}, which does not belong to this entity.',
  // the frame that lists the blocking findings: `findings`, one `.item` per finding, one per line
  'error.DIOT_NO_ENTREGABLE.blocking_findings':
    'The DIOT of {period} has {count, plural, one {# problem that prevents} other {# problems that prevent}} filing it:\n  · {findings}',
  /** `text`: the finding, a key rendered in the frame's language (list `text`) or prose (param `text`). */
  'error.DIOT_NO_ENTREGABLE.blocking_findings.item': '[{code}] {text}',
  // ---- MNE-001-731 · I9 by folder, part 8: the refusals of src/services/assets (issue #151) ----
  // `error.<CODE>.<area>.<case>`, codes unchanged. The Spanish twin is the text each site
  // printed. Fields, books, policy keys, their values and commands are literals or parameters.
  // asset-lookup.ts: the class and the book the operator names
  'error.VALIDATION_ERROR.asset.category_empty': '--category arrived empty: the asset needs its class.',
  'error.VALIDATION_ERROR.asset.category_ambiguous':
    '"{text}" matches {count} classes ({matches}). Type the full name or pass its id: taking the first one would depreciate against the accounts of another class for the whole life of the asset.',
  'error.VALIDATION_ERROR.asset.category_unknown': 'This entity has no asset class named "{text}". The ones it has: {known}.',
  'error.VALIDATION_ERROR.asset.book_unknown':
    '--book "{declared}" does not exist: the two books are {first} and {second} (the accounting one of NIF C-6 and the tax one of the LISR).',
  /** `defined`: `yes` when the firm answered the policy, `no` while its declared default governs. */
  'error.VALIDATION_ERROR.asset.book_contradicts_policy':
    '--book {requested} contradicts the panel: `base_depreciacion` is set to "{base}", so the book that reaches the ledger is {book}{defined, select, yes {} other { (declared default, nobody has answered)}}. This flag declares which book you believe you are operating on; it does not choose it: which of the two depreciations is posted is the firm\'s criterion, and it is answered with `mnemosine pending reopen base_depreciacion` (if it was already defined) and then `mnemosine pending define base_depreciacion`.',
  // asset-service.ts: the registration
  'error.VALIDATION_ERROR.asset.date_format': 'The date in {field} must come as "YYYY-MM-DD"; got "{value}".',
  'error.VALIDATION_ERROR.asset.life_not_positive_integer':
    'The useful life in {field} must be an integer greater than zero; got {value}.',
  'error.VALIDATION_ERROR.asset.life_missing':
    'Neither the registration nor the class says how long the asset lasts. Give `useful_life_years` or `useful_life_months`, or give the class its default life.',
  'error.VALIDATION_ERROR.asset.life_years_months_mismatch':
    'The years and months of useful life do not agree: {months} months fit in {derived} year(s) and {years} were declared. The years are the ceiling of the months divided by twelve (40 months are 4 years); correct one of the two, or leave the years out and they are derived.',
  'error.VALIDATION_ERROR.asset.amount_not_a_number': 'The amount of {field} is not a number: "{value}".',
  'error.VALIDATION_ERROR.asset.amount_not_finite': 'The amount of {field} is not finite: "{value}".',
  'error.VALIDATION_ERROR.asset.cost_not_positive': 'The acquisition cost must be greater than zero; got {cost}.',
  'error.VALIDATION_ERROR.asset.salvage_negative': 'The salvage value cannot be negative; got {salvage}.',
  'error.VALIDATION_ERROR.asset.salvage_reaches_cost':
    'The salvage value ({salvage}) cannot reach or exceed the acquisition cost ({cost}): the depreciable base would be zero or negative and the asset would not produce a single depreciation row.',
  'error.VALIDATION_ERROR.asset.name_empty': 'The asset needs a name: `asset_name` arrived empty.',
  'error.VALIDATION_ERROR.asset.category_inactive':
    'The class "{name}" is deactivated: it takes no new assets. Reactivate it or choose another.',
  'error.VALIDATION_ERROR.asset.start_before_acquisition':
    'Depreciation cannot start on {start}, before the acquisition ({acquired}). If what you want is the full-month convention, leave out `depreciation_start_date` and the system derives it from the panel.',
  'error.VALIDATION_ERROR.asset.accounts_missing':
    'The asset is missing accounts ({fields}) and the class "{name}" has no defaults for them. Pass them with the registration or complete the class\'s accounts.',
  'error.VALIDATION_ERROR.asset.accounts_rejected':
    'These accounts are not in this entity\'s chart, or are header accounts that take no postings: {fields}.',
  'error.RESOURCE_ALREADY_EXISTS.asset.number_taken': 'There is already an asset numbered "{number}" in this entity.',
  // depreciation.ts: the guards before the run
  'error.VALIDATION_ERROR.depreciation.policy_base_unknown':
    'The policy `base_depreciacion` is set to "{value}", which is neither of the two possible bases ({known}). Correct it with `mnemosine pending reopen base_depreciacion` (if it was already defined) and then `mnemosine pending define base_depreciacion` before running the depreciation.',
  'error.VALIDATION_ERROR.depreciation.policy_convention_unknown':
    'The policy `convencion_primer_mes` is set to "{value}", which is neither of the two possible conventions ({known}). Correct it with `mnemosine pending reopen convencion_primer_mes` (if it was already defined) and then `mnemosine pending define convencion_primer_mes` before running the depreciation.',
  'error.VALIDATION_ERROR.depreciation.tenant_unknown': 'The tenant of entity {entityId} could not be determined.',

  // ---- MNE-001-417 · the hand door of an issued CFDI, postIssuedCfdiByHand (issue #620) ----
  /** `ValidationError`: a CFDI the hand door does not post to receivables, by `reason`. */
  'error.ISSUED_CFDI_NOT_SUPPORTED':
    'CFDI {uuid} is not posted to receivables by hand: {reason, select, received {the entity received it; post it with: mnemosine bill inbox run {detail}} document_type {it is a {detail}, not a sale invoice} currency {it is in {detail}, and this path does not convert currencies} advance {it is an advance from a customer, a liability and not a sale} applies_advance {it applies an advance (TipoRelacion 07)} other {its case is {detail}, not a PUE or PPD sale}}. Nothing was posted.',
  /** `ValidationError` of the receivables core, at both doors: IEPS on a PPD sale is caused on collection, and this entity has no account for the role it waits in (MNE-001-505, #699). */
  'error.ISSUED_CFDI_PPD_IEPS':
    'CFDI {uuid} is a PPD sale that transfers IEPS ({ieps}): that IEPS is caused on collection (LIEPS art. 10) and waits in the role {role} (2181), which has no account on this entity. Add it with: npm run backfill:account-roles -- --aplicar. Nothing was posted.',
  /** `AccountingError('ISSUED_CFDI_NOT_OPEN')`: the pre-registration is completed, rejected or processing. */
  'error.ISSUED_CFDI_NOT_OPEN':
    'CFDI {uuid} is not open: its pre-registration is {status}{invoice, select, none {} other {, as customer invoice {invoice}}}. Nothing was posted.',
  /** `AccountingError('ISSUED_CFDI_DRAFT_IN_REVIEW')`: an AI draft of the same CFDI would book the sale twice. */
  'error.ISSUED_CFDI_DRAFT_IN_REVIEW':
    'CFDI {uuid} has an AI draft in review or approved: approve or reject it with: mnemosine review. Nothing was posted.',
  /** `AccountingError('CFDI_REQUIERE_DECISION')` at the hand door: `reason` is the classifier's, `commands` the panel keys that answer it. */
  'error.ISSUED_CFDI_HELD':
    'CFDI {uuid} is held and nothing was posted: {reason}{commands, select, none {} other {. Answer it with: {commands}, and run the command again}}',
  /** `AccountingError('ISSUED_CFDI_SUBSTITUTES_INVOICE')`: TipoRelacion 04 whose original is a live invoice. */
  'error.ISSUED_CFDI_SUBSTITUTES_INVOICE':
    'CFDI {uuid} substitutes a CFDI that is still customer invoice {invoice} ({status}): void that invoice first. Nothing was posted.',
  /** `ValidationError`: the concepts do not add up to the revenue of the CFDI. */
  'error.ISSUED_CFDI_REVENUE_LINES_MISMATCH':
    'The concepts of CFDI {uuid} add up to {lines} net of their discounts, and its SubTotal − Descuento is {revenue}: the revenue cannot be split by concept. Nothing was posted.',
  /** `ValidationError`: a revenue line coded to an account that is not a postable revenue account with a credit balance. */
  'error.ISSUED_CFDI_REVENUE_ACCOUNT':
    'Account {account} ({type}, {balance} balance){line, select, none {} other {, coded on line {line},}} cannot take the revenue of CFDI {uuid}: a sale credits an active, postable revenue account with a credit balance. Nothing was posted.',

  // ---- MNE-001-152 · the 422 of validateBody and validateQuery, one key per Zod issue (issue #151) ----
  // The English is the zod 3.25.76 wording the 422 has always had, byte for
  // byte (tests/api/golden/rest-body.golden.json pins it): `(s)` stays, because
  // it is the contract. Paths, enum values, bounds, formats, keys and the JSON
  // type names are interpolated raw and are never translated.
  /** `RequestValidationError` of `validateBody`: `issues` is the `<path>: <message>` list, joined with '; '. */
  'error.VALIDATION_ERROR.body': 'Invalid request body: {issues}',
  /** `RequestValidationError` of `validateQuery`: `name` is the parameter, `issues` its messages joined with '; '. */
  'error.VALIDATION_ERROR.query': 'Invalid query parameter: {name}: {issues}',
  /** `legacyIssueKey`, `invalid_type` or `invalid_value` with no input. */
  'error.VALIDATION_ERROR.issue.required': 'Required',
  /** `legacyIssueKey`, `invalid_type`: a number `.int()` refused, ±Infinity included. */
  'error.VALIDATION_ERROR.issue.integer_received_float': 'Expected integer, received float',
  /** `legacyIssueKey`, `invalid_type`: ±Infinity where zod 3 accepted a number (T1). */
  'error.VALIDATION_ERROR.issue.not_finite': 'Number must be finite',
  /** `legacyIssueKey`, `invalid_type`, and `invalid_value` given a non-string: `expected` and `received` are JSON type names or quoted enum values. */
  'error.VALIDATION_ERROR.issue.invalid_type': 'Expected {expected}, received {received}',
  /** `legacyIssueKey`, `invalid_value` of a literal: `expected` is the literal as JSON. */
  'error.VALIDATION_ERROR.issue.invalid_literal': 'Invalid literal value, expected {expected}',
  /** `legacyIssueKey`, `invalid_value` of an enum given a string. */
  'error.VALIDATION_ERROR.issue.invalid_enum_value': "Invalid enum value. Expected {expected}, received '{received}'",
  /** `legacyIssueKey`, `invalid_format`: `format` is `regex` or zod 3's name of the format. */
  'error.VALIDATION_ERROR.issue.invalid_format': '{format, select, regex {Invalid} other {Invalid {format}}}',
  /** `legacyIssueKey`, `invalid_format` of `starts_with`, `ends_with` or `includes`. */
  'error.VALIDATION_ERROR.issue.invalid_affix':
    'Invalid input: must {affix, select, starts_with {start with} ends_with {end with} other {include}} "{value}"',
  /** `legacyIssueKey`, `too_small` of an array: `bound` is exact, inclusive or exclusive. */
  'error.VALIDATION_ERROR.issue.too_small.array':
    'Array must contain {bound, select, exact {exactly} inclusive {at least} other {more than}} {minimum} element(s)',
  /** `legacyIssueKey`, `too_small` of a string. */
  'error.VALIDATION_ERROR.issue.too_small.string':
    'String must contain {bound, select, exact {exactly} inclusive {at least} other {over}} {minimum} character(s)',
  /** `legacyIssueKey`, `too_small` of a number, an integer or a bigint. */
  'error.VALIDATION_ERROR.issue.too_small.number':
    'Number must be {bound, select, exact {exactly equal to} inclusive {greater than or equal to} other {greater than}} {minimum}',
  /** `legacyIssueKey`, `too_big` of an array. */
  'error.VALIDATION_ERROR.issue.too_big.array':
    'Array must contain {bound, select, exact {exactly} inclusive {at most} other {less than}} {maximum} element(s)',
  /** `legacyIssueKey`, `too_big` of a string. */
  'error.VALIDATION_ERROR.issue.too_big.string':
    'String must contain {bound, select, exact {exactly} inclusive {at most} other {under}} {maximum} character(s)',
  /** `legacyIssueKey`, `too_big` of a number or an integer. */
  'error.VALIDATION_ERROR.issue.too_big.number':
    'Number must be {bound, select, exact {exactly} inclusive {less than or equal to} other {less than}} {maximum}',
  /** `legacyIssueKey`, `too_big` of a bigint. */
  'error.VALIDATION_ERROR.issue.too_big.bigint':
    'BigInt must be {bound, select, exact {exactly} inclusive {less than or equal to} other {less than}} {maximum}',
  /** `legacyIssueKey`, `not_multiple_of`. */
  'error.VALIDATION_ERROR.issue.not_multiple_of': 'Number must be a multiple of {divisor}',
  /** `legacyIssueKey`, `unrecognized_keys`: `keys` are quoted and joined with ', '. */
  'error.VALIDATION_ERROR.issue.unrecognized_keys': 'Unrecognized key(s) in object: {keys}',
  /** `legacyIssueKey`, `invalid_union` and `custom` (a refine with no message of its own). */
  'error.VALIDATION_ERROR.issue.invalid_input': 'Invalid input',
  // ---- MNE-001-588 · the messages the REST schemas set themselves, by key (issue #151) ----
  // Each English is the schema's own text of before, byte for byte
  // (tests/api/golden/rest-body.golden.json pins it). A schema writes them
  // through `schemaMessage` (src/utils/zod-client-errors.ts). Field names
  // are never translated.
  /** `.refine` of the PATCH bodies of accounts, customers and vendors: an empty body. */
  'error.VALIDATION_ERROR.schema.at_least_one_field': 'At least one field must be provided',
  /** `.refine` of the PATCH bodies of pre-registrations and processing rules: an empty body. */
  'error.VALIDATION_ERROR.schema.at_least_one_field_required': 'At least one field required',
  /** `.refine` of `POST /v1/upload`: neither `xml_content` nor a non-empty `xml_contents`. */
  'error.VALIDATION_ERROR.schema.xml_content_required': 'xml_content or xml_contents array is required',
  /** `.refine` of `POST /v1/customers`: a customer with no name of either kind. */
  'error.VALIDATION_ERROR.schema.customer_name_required': 'company_name or first_name is required',
  /** `.refine` of a journal entry line that carries both amounts. */
  'error.VALIDATION_ERROR.schema.line_debit_or_credit': 'Each line must have either debit_amount OR credit_amount, not both',
  /** `.refine` of the PAC preferences: a provider the adapters do not know. */
  'error.VALIDATION_ERROR.schema.unknown_pac': 'Unknown PAC provider',
  /** The error map of `matched_amount`: neither a string nor a number. */
  'error.VALIDATION_ERROR.schema.matched_amount_positive': 'matched_amount must be a positive decimal',
  /** `.refine` of `matched_amount`: not a plain positive decimal that fits DECIMAL(19,4). */
  'error.VALIDATION_ERROR.schema.matched_amount_scale':
    'matched_amount must be a positive decimal with at most 4 fractional digits',
  /** The array minimum of an invoice's `lines`. */
  'error.VALIDATION_ERROR.schema.invoice_min_lines': 'At least 1 line required',
  /** The array minimum of a journal entry's `lines`. */
  'error.VALIDATION_ERROR.schema.entry_min_lines': 'At least 2 lines required',
  /** The string minimum of `reason` when voiding an invoice or a journal entry. */
  'error.VALIDATION_ERROR.schema.void_reason_required': 'Reason is required for voiding',
  /** The regex of a calendar date field: the format it expects. */
  'error.VALIDATION_ERROR.schema.date_format': 'YYYY-MM-DD',
  // The array caps of the REST bodies (#407): `received` is how many
  // elements arrived and `maximum` the cap. Their
  // Spanish is the text every cap answered with before MNE-001-588.
  /** The cap of `transactions` on a bank statement import. */
  'error.VALIDATION_ERROR.cap.bank_transactions':
    '{received} transactions arrived and {maximum} fit in one request. Split the statement, or load it with `mnemosine bank statement import`, which inserts in batches.',
  /** The cap of a vendor bill's `lines`. */
  'error.VALIDATION_ERROR.cap.bill_lines':
    '{received} lines arrived and {maximum} fit in one request. Split the voucher: with more lines than that, what you have is an import.',
  /** The cap of `applications` on a vendor payment. */
  'error.VALIDATION_ERROR.cap.bill_payment_applications':
    '{received} applications arrived and {maximum} fit in one request. A payment against more documents than that is a remittance: record it as several payments.',
  /** The cap of an invoice's `lines`. */
  'error.VALIDATION_ERROR.cap.invoice_lines':
    '{received} lines arrived and {maximum} fit in one request. Split the invoice: no PAC stamps a voucher with more lines than that.',
  /** The cap of a journal entry's `lines`. */
  'error.VALIDATION_ERROR.cap.journal_entry_lines':
    '{received} lines arrived and {maximum} fit in one request. A journal entry longer than that is an import: split it, or use `mnemosine entry import`.',
  /** The cap of `ids` on a bulk pre-registration action. */
  'error.VALIDATION_ERROR.cap.pre_registration_ids':
    '{received} ids arrived and {maximum} fit in one request. Split the batch into several requests.',
  /** The cap of `xml_contents` on an upload. */
  'error.VALIDATION_ERROR.cap.xml_documents':
    '{received} documents arrived and {maximum} fit in one request. Split the batch, or load it with `mnemosine ingest`, which processes one file at a time.',
  // ---- MNE-001-150 · a path no route serves (issue #151) ----
  /** `AppError('ROUTE_NOT_FOUND')` from `routeNotFound`: no router served the method and path. Distinct from `RESOURCE_NOT_FOUND`, where the route exists and the record does not. */
  'error.ROUTE_NOT_FOUND': 'No route matches {method} {path}.',

  // ==== end of error.* ================================================

  // ==== policy.* — the policy panel, by key (I10 · #152, MNE-001-090) ====
  // `policy.<textKey>.{question,impact,rationale,why,what,if_skipped}` and
  // `policy.<textKey>.option.<segment>`. `textKey` is the English name the
  // vocabulary registry decided for the persisted key (owner decision on #152,
  // 2026-09-26), and `<segment>` is `optionKeySegment(value)` of the persisted
  // value: their spelling is the one `policyTextKey()`/`policyOptionKey()` in
  // `src/services/policy/policy-text-key.ts` produce, and
  // `tests/i18n/policy-panel-keys.spec.ts` fails on any key that drifts from
  // it. The English here is the catalog's prose, extracted as is;
  // `tests/i18n/policy-panel-keys.spec.ts` holds the two equal until the
  // readers render by key (MNE-001-090 part 2/2) and the prose leaves the spec.
  // A block of its own, so tranches that add other keys do not collide here.
  'policy.non_mexican_entity_chart.question':
    'What chart of accounts does an entity that does not keep Mexican books receive?',
  'policy.non_mexican_entity_chart.impact':
    'Decides what a foreign entity is born with. The house chart keeps it posting from day one; no base chart leaves it with the CFDI role accounts and the payroll mapping rows and nothing else, and until its own is imported every invoice fails with MISSING_ROLE_ACCOUNT and the first pay run fails too, because the roles and buckets that want bank, receivables, payables or revenue have no account to point at.',
  'policy.non_mexican_entity_chart.rationale':
    'An entity that can post on its first day beats one that cannot. The universal scaffolding is double-entry, not Mexican, so it fits any country; importing a chart later still works and never overwrites what the firm chose.',
  'policy.non_mexican_entity_chart.why':
    'Your foreign subsidiary can start with the same chart your Mexican entities use — minus the IVA, ISR and withholding accounts, which it will never use — or it can start without that chart because you plan to bring its existing one over from another system. Both are defensible; which one is right depends on whether that entity already has books elsewhere.',
  'policy.non_mexican_entity_chart.what':
    'On the house chart I seed the universal accounts plus a generic bank and sales-tax account, so invoices, bills and payments post immediately. On no base chart I skip THAT chart and nothing else: the entity is still born with the CFDI role accounts and the payroll mapping rows, so "no chart" does not mean an empty entity — expect roughly sixteen accounts. What it does not get is everything the base chart carries: bank, receivables, payables, revenue. Every invoice fails with MISSING_ROLE_ACCOUNT until the import lands, and so does the first pay run — the cash_payroll bucket is mandatory and points at a bank account (1111 in Mexico, 1115 on the neutral chart) that only the base chart creates, which is why `entity create` warns about it by name. `mnemosine doctor` lists the unmapped roles, so you know what the import still owes.',
  'policy.non_mexican_entity_chart.if_skipped':
    'Foreign entities get the house chart. If you were going to import their real chart, you will have a handful of unused accounts to deactivate.',
  'policy.non_mexican_entity_chart.option.base_neutro':
    'The house chart without the Mexican tax layer (generic bank and sales tax instead)',
  'policy.non_mexican_entity_chart.option.ninguno':
    'No base chart: the entity imports its own (role and payroll accounts are still created)',

  'policy.depreciation_basis.question':
    'Which depreciation drives the expense you post: book life or the tax rate?',
  'policy.depreciation_basis.impact':
    'Governs `depreciation run`. With "vida_util_nif" the monthly expense follows the useful life you set per asset (NIF C-6). With "tasa_lisr" it follows the tax rate stored on each asset, at most the maximum of its class (arts. 34-35 LISR), applied to the original investment with no salvage value subtracted (art. 31 LISR), which is what most Mexican SMEs book so that the accounting and the deduction do not diverge; "vida_util_nif" spreads the cost less the salvage value. Only ONE schedule is computed and posted: the other basis is not kept in parallel. An asset without a stored tax rate (registered before the rates existed) keeps running on its useful life, on cost less the salvage value, under either answer. An asset that already posted rows never switches basis: if you change this answer, the run refuses that asset with the reason instead of depreciating it on the other basis.',
  'policy.depreciation_basis.rationale':
    'It is what the financial statements are supposed to show, and it is the column the engine already used. Choosing the tax rate is a legitimate simplification, but it has to be chosen.',
  'policy.depreciation_basis.why':
    'A machine you expect to use for ten years can be deducted faster than that, or slower, depending on which rule you follow. Both answers are defensible and they post different amounts every month — so this is your firm\'s criterion, not something I can look up.',
  'policy.depreciation_basis.what':
    'I compute the monthly expense on the basis you pick and record which one I used on every schedule row, so a later run can prove it kept the same criterion. If you ever switch, the rows already posted keep saying what they were.',
  'policy.depreciation_basis.if_skipped':
    'I use the book useful life. Your deduction may then differ from your booked expense, which is normal but means a reconciliation at year end.',
  'policy.depreciation_basis.option.vida_util_nif':
    'Book: the useful life you assigned to the asset (NIF C-6)',
  'policy.depreciation_basis.option.tasa_lisr':
    'Tax: the LISR rate stored on the asset, at most its class maximum, so books and deduction agree',

  'policy.first_month_convention.question':
    'An asset bought mid-month: does it depreciate that whole month, or only the days it was owned?',
  'policy.first_month_convention.impact':
    'Governs the first and last amount of every asset. "mes_completo" charges the full month of the in-service date; "proporcional_dias" charges only the days owned and pushes the remainder to the final month. Over the life of the asset the total is identical — what changes is which period carries it, and therefore every monthly result in between.',
  'policy.first_month_convention.rationale':
    'It is what the income tax law counts, it is simpler to audit, and it avoids a partial amount that no one can reproduce a year later without knowing the exact purchase day.',
  'policy.first_month_convention.why':
    'You buy a machine on the 20th. Charging the whole month overstates that month slightly; charging eleven days understates it and leaves a stub at the end. Neither is wrong — your firm picks one and stays with it.',
  'policy.first_month_convention.what':
    'I apply the convention you pick to the first and last month of every asset, and I record it on the schedule row so the amount can be reproduced.',
  'policy.first_month_convention.if_skipped':
    'I charge the whole month, which matches how the tax law counts and is the easier of the two to defend.',
  'policy.first_month_convention.option.mes_completo':
    'Whole month from the month it entered service (LISR counts whole months)',
  'policy.first_month_convention.option.proporcional_dias':
    'Pro rata by days owned in the first and last month',

  'policy.depreciation_missing_at_close.question':
    'Closing a month with assets whose depreciation was never run: warn, or refuse?',
  'policy.depreciation_missing_at_close.impact':
    'Governs the "Depreciation calculated and posted" item on the close checklist. With "avisar" the month closes and the checklist says what is missing; with "bloquear" it refuses until the run happens. A month closed without depreciation overstates profit and the asset, and the error compounds because next month starts from the wrong book value.',
  'policy.depreciation_missing_at_close.rationale':
    'Same default as the other two close gates in this panel, and for the same reason: a hard block on a control that has just started producing data would stall the first close after this feature ships. Turn it on once the run is part of your routine.',
  'policy.depreciation_missing_at_close.why':
    'Forgetting the depreciation run is the easiest way to close a month that looks better than it was — and unlike most mistakes it does not correct itself: next month starts from a book value that is too high.',
  'policy.depreciation_missing_at_close.what':
    'I count the active assets with no posted depreciation for the period and either warn you or refuse to close, as you choose. Either way the checklist names them.',
  'policy.depreciation_missing_at_close.if_skipped':
    'I warn but let the month close, so the first month after this ships does not get stuck.',
  'policy.depreciation_missing_at_close.option.avisar':
    'Warn: the month closes and the checklist names what is missing',
  'policy.depreciation_missing_at_close.option.bloquear':
    'Refuse: no month closes with depreciation pending',

  'policy.capitalization_threshold_mxn.question':
    'From what amount is an item capitalized as a fixed asset instead of expensed?',
  'policy.capitalization_threshold_mxn.impact':
    'Determines when the system asks "expense or fixed asset" when loading a CFDI. A low threshold interrupts often; a high one capitalizes less than it should. Also affects future depreciation.',
  'policy.capitalization_threshold_mxn.rationale':
    'Most common threshold in Mexican practice. Not a legal rule: it is internal policy.',
  'policy.capitalization_threshold_mxn.why':
    'When an equipment invoice arrives I must decide whether it is this month\'s expense or an asset that depreciates over years. That line is your company\'s policy, not a SAT rule — the law sets depreciation rates, not the threshold for capitalizing.',
  'policy.capitalization_threshold_mxn.what':
    'Above that amount I stop and ask you case by case instead of deciding alone. Below it, I book it as an expense without interrupting you.',
  'policy.capitalization_threshold_mxn.if_skipped':
    'I keep asking at $20,000, which may interrupt you more (or less) than you want.',
  'policy.capitalization_threshold_mxn.option.5000':
    '$5,000 — conservative, capitalizes almost all equipment',
  'policy.capitalization_threshold_mxn.option.20000':
    '$20,000 — common in Mexican SMEs',
  'policy.capitalization_threshold_mxn.option.50000':
    '$50,000 — only significant investments',

  'policy.restaurant_meal_treatment.question':
    'Restaurant meals (8.5% deductible): how are they recorded?',
  'policy.restaurant_meal_treatment.impact':
    'Defines whether the system splits each meal into two lines (deductible / non-deductible) or sends everything to non-deductible with the adjustment made in the return. Affects the tax-book reconciliation.',
  'policy.restaurant_meal_treatment.rationale':
    'Keeps the books aligned with the actual deduction without extra work at close.',
  'policy.restaurant_meal_treatment.why':
    'The income tax law lets you deduct only 8.5% of restaurant meals. The other 91.5% is a real expense but not deductible, and mixing them makes the tax reconciliation harder at year-end.',
  'policy.restaurant_meal_treatment.what':
    'I split each restaurant invoice into two lines — deductible and non-deductible — or send it whole to non-deductible, whichever you choose.',
  'policy.restaurant_meal_treatment.if_skipped':
    'I split 8.5/91.5, which keeps the books aligned but adds a line to each meal.',
  'policy.restaurant_meal_treatment.option.split_85':
    'Split 8.5% deductible / 91.5% non-deductible in the entry',
  'policy.restaurant_meal_treatment.option.no_deducible':
    'All to non-deductible; adjust in the return',

  'policy.ieps_treatment.question':
    'Is the company an IEPS taxpayer that passes it on?',
  'policy.ieps_treatment.impact':
    'If it is not, the IEPS passed on to it becomes part of the cost. If it is, it is creditable. Determines the account for every purchase with IEPS (fuel, beverages, tobacco).',
  'policy.ieps_treatment.rationale':
    'Most companies are not IEPS taxpayers (LIEPS art. 4).',
  'policy.ieps_treatment.why':
    'IEPS is only creditable if your company is a taxpayer of that tax and passes it on. For everyone else it is part of the cost of the goods. I cannot tell which case you are from the invoice.',
  'policy.ieps_treatment.what':
    'It decides the account for every purchase carrying IEPS: fuel, beverages, tobacco.',
  'policy.ieps_treatment.if_skipped':
    'I treat it as cost, which is right for most companies but understates your creditable tax if you are an IEPS taxpayer.',
  'policy.ieps_treatment.option.costo':
    'Not a taxpayer: IEPS is part of the cost',
  'policy.ieps_treatment.option.acreditable':
    'Is a taxpayer: IEPS is creditable',

  'policy.fees_without_withholding.question':
    'An individual (regime 612) bills your company for professional services and the CFDI declares no ISR withheld. What happens?',
  'policy.fees_without_withholding.impact':
    'Governs received CFDIs from an individual under regime 612 whose concepts are all professional services (legal, consulting, accounting, engineering, software development, medical): a purchase of goods, or a CFDI with any concept that is not one of those services, is never taken for fees. "request_substitute_cfdi" holds the CFDI in the inbox, writes nothing to the ledger and says to ask the vendor for a substitute CFDI with the withholding. "withhold_by_law" computes 10 % of ISR and two thirds of the VAT from legal_parameters and holds that entry for review. "record_as_issued" posts the CFDI as it comes, with no withholding, and the close checklist lists it under fees-without-withholding.',
  'policy.fees_without_withholding.rationale':
    'A legal entity that pays fees without withholding is jointly liable for the tax (CFF 26-I) and the expense may not be deductible (LISR 27-V). The CFDI belongs to a third party: the clean remedy is a substitute from the vendor, and nothing is booked on a figure that will change.',
  'policy.fees_without_withholding.why':
    'When your company pays an individual for professional services it has to withhold part of the ISR and the VAT. If the invoice does not show the withholding, either the vendor made a mistake or the payment will be made in full. Whether to wait for a corrected invoice, withhold anyway or book it as it came is a call for your firm.',
  'policy.fees_without_withholding.what':
    'By default I hold the invoice and tell you to ask the vendor for a substitute. With "withhold_by_law" I propose the entry with the withholding the law requires and leave it for you to review. With "record_as_issued" I post it as it came and list it in the close checklist.',
  'policy.fees_without_withholding.if_skipped':
    'I hold those invoices until a substitute CFDI with the withholding arrives: nothing reaches your books.',
  'policy.fees_without_withholding.option.request_substitute_cfdi':
    'Hold it and ask the vendor for a substitute CFDI with the withholding',
  'policy.fees_without_withholding.option.withhold_by_law':
    'Compute the law\'s withholding and hold the entry for review',
  'policy.fees_without_withholding.option.record_as_issued':
    'Record it as issued, with a warning in the close checklist',

  'policy.withholding_mismatch.question':
    "A received CFDI declares a withholding (ISR or VAT) other than the one the law requires of your company as payer. What happens?",
  'policy.withholding_mismatch.impact':
    "Governs received CFDIs on which a legal entity withholds by law (an individual's fees or lease, land freight, an individual in RESICO) and whose declared withholding differs from the law's beyond rounding; professional fees under regime 612 that declare no ISR withheld follow fees_without_withholding instead. \"request_substitute_cfdi\" holds the CFDI in the inbox, writes nothing to the ledger and says to ask the vendor for a substitute CFDI. \"withhold_by_law\" proposes the entry with the law's withholding and holds it for review. \"record_as_issued\" posts the CFDI with its declared withholding, and the close checklist lists it under fees-without-withholding.",
  'policy.withholding_mismatch.rationale':
    "The payer is jointly liable for the tax it should have withheld (CFF 26-I) and the expense is deductible only if the withholding was made and paid (LISR 27-V). The CFDI belongs to a third party: the clean remedy is a substitute from the vendor, and nothing is booked on a figure that will change.",
  'policy.withholding_mismatch.why':
    "When your company withholds by law, the invoice has to show the same withholding the law requires. If it shows another, either the vendor made a mistake or the case is not the one the law describes. Whether to wait for a corrected invoice, withhold the law's amount anyway or book it as it came is a call for your firm.",
  'policy.withholding_mismatch.what':
    "By default I hold the invoice and tell you to ask the vendor for a substitute. With \"withhold_by_law\" I propose the entry with the law's withholding and leave it for you to review. With \"record_as_issued\" I post it as it came and list it in the close checklist.",
  'policy.withholding_mismatch.if_skipped':
    "I hold those invoices and ask you about each one: nothing reaches your books until a substitute arrives or you answer.",
  'policy.withholding_mismatch.option.request_substitute_cfdi':
    "Hold it and ask the vendor for a substitute CFDI",
  'policy.withholding_mismatch.option.withhold_by_law':
    "Book the law's withholding and hold the entry for review",
  'policy.withholding_mismatch.option.record_as_issued':
    "Record it as declared, with a warning in the close checklist",

  'policy.inventory_method.question':
    'Does the company keep perpetual inventories?',
  'policy.inventory_method.impact':
    'If it does, merchandise purchases go to inventory and cost is recognized on sale. If not, they go straight to cost. Changes the entry for every purchase of merchandise or raw materials.',
  'policy.inventory_method.rationale':
    'Asked case by case while undefined; the default avoids inventing inventories.',
  'policy.inventory_method.why':
    'If you keep perpetual inventories, a merchandise purchase goes to inventory and the cost is recognized when you sell. If you don\'t, it goes straight to cost of sales. The invoice looks identical either way.',
  'policy.inventory_method.what':
    'It changes the entry for every purchase of merchandise or raw materials.',
  'policy.inventory_method.if_skipped':
    'I ask you case by case on each merchandise purchase, which is safe but repetitive.',
  'policy.inventory_method.option.perpetuos':
    'Yes: purchases to inventory, cost on sale',
  'policy.inventory_method.option.directo':
    'No: purchases straight to cost of sales',

  'policy.cfdi_from_closed_period.question':
    'A CFDI from an already-closed period: in which period is it recorded?',
  'policy.cfdi_from_closed_period.impact':
    'Defines whether the system proposes the current open period or flags the document to reopen the original period. Affects the comparability of the financial statements.',
  'policy.cfdi_from_closed_period.rationale':
    'With no policy defined, each case is escalated instead of assumed.',
  'policy.cfdi_from_closed_period.why':
    'A December invoice that arrives in February has no obvious home: booking it in the closed period breaks comparability, booking it today distorts the current month. Firms handle this differently.',
  'policy.cfdi_from_closed_period.what':
    'It decides whether I propose the current open period, flag the document to reopen the original one, or ask you each time.',
  'policy.cfdi_from_closed_period.if_skipped':
    'I ask you each time, which is the safest default but the most interruptive.',
  'policy.cfdi_from_closed_period.option.periodo_actual':
    'Record in the current open period',
  'policy.cfdi_from_closed_period.option.preguntar':
    'Ask case by case',
  'policy.cfdi_from_closed_period.option.reabrir':
    'Reopen the original period (requires authorization)',

  'policy.cfdi_reconciliation_tolerance.question':
    'When an approved draft is checked against its CFDI, how much difference per figure still counts as rounding?',
  'policy.cfdi_reconciliation_tolerance.impact':
    'Approving the draft of a received CFDI creates the vendor bill, and the approved entry must match the XML figure by figure: total, transferred VAT, each withholding, and subtotal minus discount. A difference within the tolerance passes; anything larger rolls the whole approval back and names the figure. The difference is never absorbed by moving cents to another account.',
  'policy.cfdi_reconciliation_tolerance.rationale':
    'The SAT accepts rounding differences in per-line taxes (Anexo 20), and a cent per figure is what that rounding produces. More than a cent is not rounding: it is another amount than the one the CFDI supports (CFF 29 and 29-A; LIVA art. 5 fracc. II and III).',
  'policy.cfdi_reconciliation_tolerance.why':
    'When you approve the entry for a supplier invoice I check it against the XML. I need to know how much rounding you accept before I refuse it.',
  'policy.cfdi_reconciliation_tolerance.what':
    'Within the tolerance I create the bill and post the entry. Beyond it I refuse the approval and tell you which figure is off and by how much.',
  'policy.cfdi_reconciliation_tolerance.if_skipped':
    'I allow one cent per figure.',
  'policy.cfdi_reconciliation_tolerance.option.0_01':
    'One cent per figure — only true rounding',
  'policy.cfdi_reconciliation_tolerance.option.0':
    'Exact match or nothing',

  'policy.bill_lines_source.question':
    'When an approved draft creates the vendor bill, where do the bill lines come from?',
  'policy.bill_lines_source.impact':
    'The bill header (subtotal, taxes, total) always comes from the CFDI. This decides the lines: either your own coding in the approved entry, or one line per CFDI concept. Concepts only take an account when the entry splits one to one with them; otherwise the approval is refused, never prorated.',
  'policy.bill_lines_source.rationale':
    'Which accounts an expense goes to is an internal decision of whoever books it: several concepts can go to one account, or one concept can be split. The approved entry already records that decision, and the bill should reflect it rather than force the vendor\'s wording onto the ledger.',
  'policy.bill_lines_source.why':
    'Some firms want the bill to read like the supplier\'s invoice, concept by concept; others want it to follow how they coded the expense.',
  'policy.bill_lines_source.what':
    'By default each non-tax debit of the entry you approved becomes a bill line. With "conceptos_cfdi" I copy the concepts and refuse when your entry does not split the same way.',
  'policy.bill_lines_source.if_skipped':
    'The bill lines follow the entry you approved.',
  'policy.bill_lines_source.option.poliza':
    'One line per non-tax debit of the approved entry, with its account and amount',
  'policy.bill_lines_source.option.conceptos_cfdi':
    'One line per CFDI concept (description, quantity, SAT key); refused if the entry does not split one to one',

  'policy.unknown_vendor_on_approval.question':
    'When you approve the draft of a received CFDI whose issuer is not in the vendor catalog, what happens?',
  'policy.unknown_vendor_on_approval.impact':
    'Approving creates the vendor bill, and a bill needs a registered vendor. Registering one creates a counterparty from the name and RFC written inside a third party\'s XML. Either the approval is refused until someone registers the vendor, or `mnemosine review` asks you, and your yes registers the vendor, the bill and the entry in one transaction.',
  'policy.unknown_vendor_on_approval.rationale':
    'It is the rule `bill inbox run` already follows: no vendor is created without an explicit act by a person, and the approval of an entry is not, by itself, the approval of new master data.',
  'policy.unknown_vendor_on_approval.why':
    'Some firms register every supplier on purpose before booking anything; others prefer to confirm a new supplier while they review its first invoice.',
  'policy.unknown_vendor_on_approval.what':
    'By default I refuse the approval, nothing is posted, and I tell you the command that registers the vendor. With "preguntar", the review asks you, and only your yes creates the vendor.',
  'policy.unknown_vendor_on_approval.if_skipped':
    'I refuse the approval until the vendor is registered.',
  'policy.unknown_vendor_on_approval.option.rechazar':
    'Refuse the approval and name the command that registers the vendor',
  'policy.unknown_vendor_on_approval.option.preguntar':
    'Ask in `mnemosine review` whether to register the vendor; no means refuse',

  'policy.rep_payment_not_recorded.question':
    'A payment receipt (REP) arrives and no matching payment is on file: what happens?',
  'policy.rep_payment_not_recorded.impact':
    'Decides whether ingesting a REP can move money on its own. Creating the payment is what releases the parked VAT, because the release hangs off the payment applications — but it also means the system moves the bank without a human having recorded it.',
  'policy.rep_payment_not_recorded.rationale':
    'The REP is documentary proof that the money already moved: it carries the payment date and method. Creating the payment routes it through the single door that also releases the VAT. A third option — posting the cash directly, with no payment record — is deliberately NOT offered: it is what double-credits the bank when the payment was also captured by hand, and it leaves the VAT parked forever. There is no legacy behaviour to stay compatible with, because this door never worked: a type-P CFDI died with UNSUPPORTED_TYPE before reaching any posting.',
  'policy.rep_payment_not_recorded.why':
    'When your supplier sends the receipt for an invoice you paid, I can either take it as the record of that payment, or wait until someone confirms it. Firms that capture bank movements daily want to confirm; firms that book straight from CFDIs want me to take it.',
  'policy.rep_payment_not_recorded.what':
    'With "crear_pago" I record the payment and apply it to the invoices the receipt names, which is what lets me credit the VAT that was waiting. With "revision" I file the receipt and ask you.',
  'policy.rep_payment_not_recorded.if_skipped':
    'I create the payment. If you also capture payments by hand, tell me — otherwise we could end up with the same payment twice.',
  'policy.rep_payment_not_recorded.option.crear_pago':
    'Create the payment and apply it to each related document',
  'policy.rep_payment_not_recorded.option.revision':
    'Register the receipt and leave the link for a person to confirm',

  'policy.rep_amount_tolerance.question':
    'How much difference between the receipt and the recorded payment still counts as rounding?',
  'policy.rep_amount_tolerance.impact':
    'Used twice: to decide whether a hand-captured payment is the same event as the receipt, and to compare the VAT the receipt declares (ImpuestosDR) against the proration over the invoice. Beyond it, the receipt goes to review: matching a payment that is not the same one credits VAT for an amount different from what was actually paid.',
  'policy.rep_amount_tolerance.rationale':
    'The comparison runs per related document, not receipt-against-payment, and the VAT proration already settles its remainder on the last instalment. A difference larger than a cent is not rounding: it is another instalment, another exchange rate, or a different payment.',
  'policy.rep_amount_tolerance.why':
    'Receipts and your own records rarely differ, but when they do it matters whether it is a cent of rounding or a different payment altogether.',
  'policy.rep_amount_tolerance.what':
    'Within the tolerance I match them. Outside it I leave the receipt for you to look at.',
  'policy.rep_amount_tolerance.if_skipped':
    'I allow one cent.',
  'policy.rep_amount_tolerance.option.0_01':
    'One cent — only true rounding',
  'policy.rep_amount_tolerance.option.1_00':
    'One peso',
  'policy.rep_amount_tolerance.option.0':
    'Exact match or nothing',

  'policy.rep_unknown_document.question':
    'The receipt names an invoice the system does not have: what happens to that VAT?',
  'policy.rep_unknown_document.impact':
    "Without the original invoice there is no base to prorate the VAT of that instalment. Decides whether the receipt waits in review until a person runs mnemosine rep reconcile once its invoice is in the system, or the documents it knows go on as usual and the unknown one's share and VAT are never recorded from this receipt.",
  'policy.rep_unknown_document.rationale':
    'SAT bulk downloads arrive out of order, so a receipt reaching us before its invoice is normal, not exceptional. The VAT is not lost: it stays parked, which is exactly where LIVA art. 5 fracc. III wants it until a document supports it. When the receipt DOES carry ImpuestosDR, that figure is checked against the proration over the original invoice: if they diverge beyond the tolerance, the receipt goes to review instead of releasing either figure silently.',
  'policy.rep_unknown_document.why':
    'Receipts often arrive before the invoice they refer to. I can hold the tax until the invoice shows up, or move on without it.',
  'policy.rep_unknown_document.what':
    'By default I leave the receipt in review. Nothing retries it on its own: once its invoice is in the system, running mnemosine rep reconcile links it.',
  'policy.rep_unknown_document.if_skipped':
    'I wait. Nothing is lost — the tax stays where it was.',
  'policy.rep_unknown_document.option.esperar':
    'Wait: the whole payment in the receipt waits in review, the known invoices it pays included, and none of its VAT is transferred',
  'policy.rep_unknown_document.option.postear_sin_iva':
    'Match the cash and leave the VAT untransferred, with a warning',
  'policy.rep_unknown_document.option.preguntar':
    'Same as "Wait": the receipt waits in review and no VAT amount is asked for. Kept for firms that already chose it.',

  'policy.rep_voided_document.question':
    'A payment in a receipt (REP) covers a live invoice and one the books annulled: what happens?',
  'policy.rep_voided_document.impact':
    'Applies to a receipt the entity issued. With "review" the whole payment waits for a person, so the VAT of the live invoice stays as not yet collected until then. With "post_live_documents" the payment is recorded for the live invoices only and their VAT is released; the share of the annulled invoice stays unbooked, with a warning saved on the receipt.',
  'policy.rep_voided_document.rationale':
    'A receipt is issued only when the money is actually received (SAT, Guía de llenado del complemento para recepción de pagos, Apéndice 6, question 11), so one that names an invoice the books voided contradicts them, and only a person can say which is wrong; ADR-0006 picks the option that does not post without review, as `rep_documento_desconocido` does by waiting. A firm that books straight from CFDIs may post the live documents, whose VAT is caused when collected (LIVA arts. 1o.-B, 11 and 17).',
  'policy.rep_voided_document.why':
    'When one bank movement pays several invoices and one of them is void or cancelled in the books, either the receipt or the books are wrong. Some firms want to settle that before anything is recorded; others want the invoices that do stand collected at once.',
  'policy.rep_voided_document.what':
    'By default I send the whole payment to review and name the annulled invoice. With "post_live_documents" I collect the live invoices, apply nothing to the annulled one and save a warning that names it.',
  'policy.rep_voided_document.if_skipped':
    'The whole payment goes to review, naming the annulled invoice.',
  'policy.rep_voided_document.option.review':
    'Review: hold the whole payment and name the annulled invoice',
  'policy.rep_voided_document.option.post_live_documents':
    'Post the live invoices and leave the annulled one unbooked, with a warning',

  'policy.rep_match_window_days.question':
    'How many days apart can the receipt date and the recorded payment be and still be the same event?',
  'policy.rep_match_window_days.impact':
    'A window that is too narrow produces false negatives, and a false negative ends in a duplicated payment — which is the exact harm the matching exists to prevent.',
  'policy.rep_match_window_days.rationale':
    'The date is a matching heuristic, not a tax fact: what the SAT checks are the amounts and the chain of instalments. Payments captured by hand usually carry the statement date rather than the value date, and three days covers that gap without spanning two instalments of the same document.',
  'policy.rep_match_window_days.why':
    'Your records and the receipt rarely carry the exact same date. How far apart can they be before I stop assuming they are the same payment?',
  'policy.rep_match_window_days.what':
    'Within the window I consider them the same event and link them instead of creating a second payment.',
  'policy.rep_match_window_days.if_skipped':
    'I allow three days.',
  'policy.rep_match_window_days.option.0':
    'Same day exactly',
  'policy.rep_match_window_days.option.3':
    'Three calendar days',
  'policy.rep_match_window_days.option.15':
    'Fifteen days, for monthly capture',

  'policy.prepaid_amortization_convention.question':
    'A prepayment that starts mid-month: does the first month accrue in full, or only for the days it covers?',
  'policy.prepaid_amortization_convention.impact':
    'Sets every month of the schedule. An insurance policy running 20 March to 19 March accrues over 12 months by one convention and 13 by the other, and the last month of the fiscal year differs.',
  'policy.prepaid_amortization_convention.rationale':
    'It is what the accrual postulate (NIF A-1, chapter 20) actually says — the expense belongs to the period that consumed the service — and it is the only convention that keeps the schedule tied to the contract dates rather than to the calendar. Firms that prefer whole months for simplicity can say so here, but the default should be the one that is right rather than the one that is easy.',
  'policy.prepaid_amortization_convention.why':
    'Your insurance starts on the 20th, not on the 1st. By days it spreads over thirteen calendar months and by whole months over twelve, so the choice changes which month carries the expense and what the last month of the year shows.',
  'policy.prepaid_amortization_convention.what':
    'I accrue the days each month actually covers.',
  'policy.prepaid_amortization_convention.if_skipped':
    'I accrue by days.',
  'policy.prepaid_amortization_convention.option.proporcional_dias':
    'By days: the first and last months accrue only the days covered',
  'policy.prepaid_amortization_convention.option.meses_completos':
    'Whole months: the starting month accrues in full and the last one does not',

  'policy.prepaid_amortization_missing_at_close.question':
    'Closing a month with prepayment schedules whose amortisation was never run: warn, or refuse?',
  'policy.prepaid_amortization_missing_at_close.impact':
    'An unrun schedule means the expense of that month is missing and the asset is overstated by the same amount. It is the exact shape of the defect this system already fixed for depreciation. The same answer governs deferred-revenue schedules, whose unrun month leaves revenue in the liability.',
  'policy.prepaid_amortization_missing_at_close.rationale':
    'It is the same answer the firm already gets for depreciation, and consistency between two identical situations matters more here than the choice itself: a checklist where one accrual blocks and the other warns teaches nobody anything.',
  'policy.prepaid_amortization_missing_at_close.why':
    'If a schedule was never run, the month you are closing is missing that expense and the prepaid asset is overstated by the same amount — and you would be signing it either way.',
  'policy.prepaid_amortization_missing_at_close.what':
    'I flag it in the close checklist and let you decide.',
  'policy.prepaid_amortization_missing_at_close.if_skipped':
    'I warn.',
  'policy.prepaid_amortization_missing_at_close.option.avisar':
    'Warn: the checklist item goes red and the close continues',
  'policy.prepaid_amortization_missing_at_close.option.bloquear':
    'Refuse: the period does not close until every schedule is run',

  'policy.deferred_revenue_recognition_convention.question':
    'Revenue collected in advance for a service that starts mid-month: is the first month recognized in full, or only for the days it covers?',
  'policy.deferred_revenue_recognition_convention.impact':
    'Sets every month of a deferred-revenue schedule. An annual contract from 20 March recognizes over 13 months by days and over 12 by whole months, and the revenue of the fiscal year differs.',
  'policy.deferred_revenue_recognition_convention.rationale':
    'Revenue belongs to the period in which the service is rendered (NIF D-1; IFRS 15 para 39). By days, the first and the last month carry only the days the contract covers; whole months would recognize the first month in full before it is rendered, which is the less prudent side for revenue.',
  'policy.deferred_revenue_recognition_convention.why':
    'Your contract starts on the 20th, not on the 1st. By days the revenue spreads over thirteen calendar months and by whole months over twelve, so the choice changes how much revenue the year shows.',
  'policy.deferred_revenue_recognition_convention.what':
    'I recognize the days each month actually covers.',
  'policy.deferred_revenue_recognition_convention.if_skipped':
    'I recognize by days.',
  'policy.deferred_revenue_recognition_convention.option.proporcional_dias':
    'By days: the first and last months recognize only the days covered',
  'policy.deferred_revenue_recognition_convention.option.meses_completos':
    'Whole months: the starting month is recognized in full and the last one is not',

  'policy.prepaid_threshold_mxn.question':
    'Above what amount is a multi-period expense deferred to prepayments instead of expensed at once?',
  'policy.prepaid_threshold_mxn.impact':
    'Below the threshold the whole amount hits the month it was paid; above it, a schedule is created and the expense spreads. `prepaid create` reads your answer and stops below it unless you pass --force with a reason. At ingestion, the CFDI classifier compares against your answer too: it only offers the deferral on amounts at or above it (5,000 MXN until you answer).',
  'policy.prepaid_threshold_mxn.rationale':
    'Materiality (NIF A-4): a 900-peso annual subscription split into twelve entries of 75 costs more in bookkeeping than the precision it buys, and clutters the schedule with rows nobody will check. Five thousand is the order of magnitude where the split starts paying for itself.',
  'policy.prepaid_threshold_mxn.why':
    'Not every yearly subscription is worth spreading over twelve months; you decide where the line is.',
  'policy.prepaid_threshold_mxn.what':
    'I offer to defer multi-period expenses at or above your threshold (5,000 MXN by default) and expense the rest as they come.',
  'policy.prepaid_threshold_mxn.if_skipped':
    'I use 5,000 MXN.',
  'policy.prepaid_threshold_mxn.option.0':
    'No threshold: defer every multi-period expense',
  'policy.prepaid_threshold_mxn.option.5000':
    '5,000 MXN',
  'policy.prepaid_threshold_mxn.option.20000':
    '20,000 MXN',

  'policy.benefit_accrual_wage_base.question':
    'Which daily wage does the monthly benefit provision use as its base?',
  'policy.benefit_accrual_wage_base.impact':
    'Sets the amount of every aguinaldo, vacation and vacation-premium accrual. The integrated wage is larger than the nominal one, so the choice moves the provision — and the reported profit — every month.',
  'policy.benefit_accrual_wage_base.rationale':
    'The nominal wage is the number the firm actually agreed to and the one the payroll already holds. The SDI is a SOCIAL-SECURITY base (LSS art. 27) built to compute contributions, and borrowing it for a NIF D-3 accrual imports a fiscal convention into a financial-reporting figure. A firm that wants it declares it; the system does not inflate a liability on its own.',
  'policy.benefit_accrual_wage_base.why':
    'The nominal and the integrated wage give different provisions, and both are defensible. Only your firm knows which convention it follows.',
  'policy.benefit_accrual_wage_base.what':
    'I accrue benefits on the nominal daily wage.',
  'policy.benefit_accrual_wage_base.if_skipped':
    'I use the nominal daily wage.',
  'policy.benefit_accrual_wage_base.option.nominal':
    'Nominal daily wage — what the contract states',
  'policy.benefit_accrual_wage_base.option.integrado':
    'Integrated daily wage (SDI) — includes the benefits LFT art. 84 folds in',

  'policy.vacation_accrual_timing.question':
    'When does the vacation liability get recognised?',
  'policy.vacation_accrual_timing.impact':
    'Decides whether the vacation provision grows month by month or appears whole on each employee\'s work anniversary. The annual total is the same; the shape of eleven of the twelve monthly statements is not.',
  'policy.vacation_accrual_timing.rationale':
    'NIF D-3 recognises a short-term benefit as the employee RENDERS the service, not when the right becomes enforceable. Accruing on the anniversary concentrates twelve months of cost in one, which is the very distortion the accrual basis exists to remove. The alternative stays available because LFT art. 76 does make the right vest on that date, and some firms report on that reading.',
  'policy.vacation_accrual_timing.why':
    'The law vests the right on the anniversary; the accounting standard recognises it as it is earned. Both readings exist in practice.',
  'policy.vacation_accrual_timing.what':
    'I accrue vacations in proportion to time served, month by month.',
  'policy.vacation_accrual_timing.if_skipped':
    'I accrue proportionally.',
  'policy.vacation_accrual_timing.option.proporcional':
    'Month by month, in proportion to time served',
  'policy.vacation_accrual_timing.option.aniversario':
    'In full on the anniversary, when the right vests',

  'policy.monthly_ptu_accrual.question':
    'Does the firm provision PTU monthly, or only at year end?',
  'policy.monthly_ptu_accrual.impact':
    'A monthly PTU provision needs an ESTIMATE of the year\'s taxable profit, which is a judgement. Provisioning only at close leaves eleven months without the charge, and a twelfth carrying all of it.',
  'policy.monthly_ptu_accrual.rationale':
    'A monthly PTU accrual rests on an estimate of a figure that will not exist until the annual return, and a provision built on a guess is worse than a disclosed absence: it looks like a measurement. The firm that has a reliable forecast turns it on and owns the estimate.',
  'policy.monthly_ptu_accrual.why':
    'PTU is 10 % of taxable profit (LFT art. 120) and that profit is not known until the year closes. Whether to estimate it monthly is your firm\'s call, not mine.',
  'policy.monthly_ptu_accrual.what':
    'I record PTU at year end, when the taxable profit is known.',
  'policy.monthly_ptu_accrual.if_skipped':
    'I record it only at year end.',
  'policy.monthly_ptu_accrual.option.no':
    'Only at year end, once taxable profit is known',
  'policy.monthly_ptu_accrual.option.si':
    'Monthly, over estimated taxable profit',

  'policy.aguinaldo_days_per_year.question':
    'How many days of aguinaldo does the firm grant per year of service?',
  'policy.aguinaldo_days_per_year.impact':
    'Read by two calculations. The settlement (finiquito-calculator.ts) prorates these days per year over the days worked in the year of termination. The monthly benefit provision (provisions-run.ts, `payroll accrue` and the close) accrues aguinaldo on them every month. Both check the value against the legal minimum in force on their date (LFT art. 87) and refuse to compute below it.',
  'policy.aguinaldo_days_per_year.rationale':
    'LFT art. 87 sets fifteen days as the floor, and a floor is the only number the system can assume without knowing the contract. Anything above it is a benefit the employer granted and must be declared, never guessed.',
  'policy.aguinaldo_days_per_year.why':
    'The law sets a minimum of fifteen days; many firms pay more, and I cannot know which yours is.',
  'policy.aguinaldo_days_per_year.what':
    'I compute aguinaldo on the days you set per year, in proportion to time served.',
  'policy.aguinaldo_days_per_year.if_skipped':
    'I use the legal minimum of fifteen days.',
  'policy.aguinaldo_days_per_year.option.15':
    '15 days — the legal minimum (LFT art. 87)',
  'policy.aguinaldo_days_per_year.option.20':
    '20 days',
  'policy.aguinaldo_days_per_year.option.30':
    '30 days (one month)',

  'policy.vacation_premium_pct.question':
    'What vacation premium does the firm pay over the vacation days earned?',
  'policy.vacation_premium_pct.impact':
    'Applies to the settlement and to the monthly vacation provision alike.',
  'policy.vacation_premium_pct.rationale':
    'Same reasoning as the aguinaldo: LFT art. 80 sets 25 % as the floor, and the floor is the only figure that is safe to assume. A firm paying more is granting a benefit, and a benefit is declared, not inferred.',
  'policy.vacation_premium_pct.why':
    'The law sets 25 % as the minimum vacation premium; yours may be higher.',
  'policy.vacation_premium_pct.what':
    'I apply 25 % over the vacation days earned.',
  'policy.vacation_premium_pct.if_skipped':
    'I use the legal minimum of 25 %.',
  'policy.vacation_premium_pct.option.0_25':
    '25 % — the legal minimum (LFT art. 80)',
  'policy.vacation_premium_pct.option.0_50':
    '50 %',
  'policy.vacation_premium_pct.option.1_00':
    '100 %',

  'policy.usmo_isr_subsidy.question':
    'For the separation ISR, is the ISR of the last ordinary monthly salary (USMO) taken gross of the tariff, or net of the employment subsidy?',
  'policy.usmo_isr_subsidy.impact':
    'LISR art. 96, in its paragraph on the payments of art. 95, withholds the ISR of a seniority premium or an indemnity at a rate: the ISR of the last ordinary monthly salary divided by that salary. Read by the settlement (finiquito-calculator.ts), whose separation ISR withholds the taxable part at that rate. Net of the subsidy lowers the rate, so less is withheld.',
  'policy.usmo_isr_subsidy.rationale':
    'LISR art. 96, in its paragraph on the payments of art. 95 (third from the end; RLISR art. 172 nets the exemption out of those payments), divides «el impuesto correspondiente al último sueldo mensual ordinario» by that salary. The employment subsidy is a credit against the ISR withheld, not tax caused, so the tax that corresponds is the one of the tariff. Gross is the reading the owner chose in MNE-001-373 (ADR-0006, decision 1); net of the subsidy is the other reading, and it withholds less.',
  'policy.usmo_isr_subsidy.why':
    'The law builds the separation rate on the ISR of the last monthly salary, and does not say whether that ISR subtracts the employment subsidy. Your firm decides.',
  'policy.usmo_isr_subsidy.what':
    'I take the ISR of the last ordinary monthly salary by the monthly tariff, without subtracting the subsidy, and the settlement withholds the taxable separation pay at that ISR divided by the salary.',
  'policy.usmo_isr_subsidy.if_skipped':
    'I take it gross of the tariff, without subtracting the subsidy.',
  'policy.usmo_isr_subsidy.option.gross_of_tariff':
    'The ISR of the USMO by the monthly tariff, without subtracting the employment subsidy',
  'policy.usmo_isr_subsidy.option.net_of_subsidy':
    'The ISR of the USMO by the monthly tariff, minus the employment subsidy that salary would get',

  'policy.usmo_days_per_month.question':
    'How many days make the last ordinary monthly salary (USMO) of a settlement: 30 or 30.4?',
  'policy.usmo_days_per_month.impact':
    'The USMO is the daily wage times these days, and the separation ISR of LISR art. 96, in its paragraph on the payments of art. 95, is built on it. Read by the settlement (finiquito-calculator.ts), which reports the USMO in its basis, compares the separation pay with it and divides by it. On a daily wage of 300.00 the USMO is 9,000.00 at 30 days and 9,120.00 at 30.4.',
  'policy.usmo_days_per_month.rationale':
    'LFT art. 89 divides a monthly salary by thirty to get the daily wage, so the ordinary monthly salary of a daily wage is the daily wage × 30; LISR art. 96, in its paragraph on the payments of art. 95, builds the separation rate on that salary. 30 is the reading the owner chose in MNE-001-373 (ADR-0006, decision 1); 30.4 is the other reading, the month the monthly tariff and the subsidy decree prorate.',
  'policy.usmo_days_per_month.why':
    'The law names the last ordinary monthly salary but not how many days a month has. Your firm decides.',
  'policy.usmo_days_per_month.what':
    'I compute the USMO as the daily wage × 30; the settlement compares the separation pay with it and builds the withholding rate on it.',
  'policy.usmo_days_per_month.if_skipped':
    'I use 30 days.',
  'policy.usmo_days_per_month.option.30':
    'Daily wage × 30 (LFT art. 89 divides a monthly salary by thirty)',
  'policy.usmo_days_per_month.option.30_4':
    'Daily wage × 30.4 (the month of the monthly tariff)',

  'policy.separation_isr_usmo_comparison.question':
    'For the separation ISR, what is compared with the last ordinary monthly salary (USMO) to choose between the monthly tariff and the USMO rate: the total paid for separation, or only its taxable part?',
  'policy.separation_isr_usmo_comparison.impact':
    'LISR art. 96, in its paragraph on the payments of art. 95, withholds a seniority premium or an indemnity at the ISR of the USMO divided by the USMO, and applies the monthly tariff instead when «los pagos» are below the USMO. Read by the separation ISR of the settlement (separation-isr.ts). When the taxable part is below the USMO and the total paid is not, comparing the total withholds at the rate, more than the tariff on the small taxable part alone.',
  'policy.separation_isr_usmo_comparison.rationale':
    'LISR art. 96 applies the rate to «el ingreso total por este concepto» and switches to the tariff «Cuando los pagos por estos conceptos sean inferiores al último sueldo mensual ordinario»: the word is the payments, so the total paid is the literal reading, and, gross of the tariff, it never withholds less, because the average rate of the tariff rises with the income. Comparing only the taxable part follows RLISR art. 172, which nets the exemption of LISR art. 93 fr. XIII out of the art. 95 total, as the payroll CFDI builds IngresoAcumulable; it is the other common practice. The conservative default, under ADR-0006; an excess is credited in the annual calculation.',
  'policy.separation_isr_usmo_comparison.why':
    'The law compares «los pagos» with the last monthly salary without saying whether their exempt part counts. Comparing the total withholds at the USMO rate more often; comparing only the taxable part applies the monthly tariff more often. Your firm decides.',
  'policy.separation_isr_usmo_comparison.what':
    'I compare the total paid for separation with the USMO: below it, the monthly tariff on the taxable part; otherwise the USMO rate on the taxable part.',
  'policy.separation_isr_usmo_comparison.if_skipped':
    'I compare the total paid.',
  'policy.separation_isr_usmo_comparison.option.total_payments':
    'The total paid for separation, its exempt part included (the literal «pagos» of LISR art. 96)',
  'policy.separation_isr_usmo_comparison.option.taxable_payments':
    'Only the taxable part, after the 90 UMA exemption (RLISR art. 172)',

  'policy.cash_flow_method.question':
    'Is the statement of cash flows presented by the indirect or the direct method?',
  'policy.cash_flow_method.impact':
    'Decides the whole face of the statement. Before G1b the engine accepted a `method` parameter, echoed it back in the response and NEVER changed a number — every caller that asked for the direct method got the indirect one, labelled as direct.',
  'policy.cash_flow_method.rationale':
    'NIF B-2 allows both and Mexican practice overwhelmingly files the indirect one: it derives from the same balances the trial balance already has, while the direct method needs every cash movement classified by concept at the moment it is recorded. Offering «direct» over data that was never classified for it would produce a statement that looks right and is not.',
  'policy.cash_flow_method.why':
    'The two methods present the same cash differently, and the presentation is a firm decision, not a calculation.',
  'policy.cash_flow_method.what':
    'I build the statement by the indirect method and label it as such.',
  'policy.cash_flow_method.if_skipped':
    'I use the indirect method.',
  'policy.cash_flow_method.option.indirecto':
    'Indirect: start from net income and adjust for non-cash items and working-capital movements',
  'policy.cash_flow_method.option.directo':
    'Direct: gross collections and payments by concept (customers, suppliers, employees, taxes)',

  'policy.cash_flow_cash_accounts.question':
    'Which accounts count as «cash and cash equivalents» when the statement of cash flows is squared?',
  'policy.cash_flow_cash_accounts.impact':
    'The statement only means anything if its net movement equals the real change in cash, and that requires knowing which accounts ARE cash. Before G1b classification ran on account names matched with ILIKE «%receivable%» and «%payable%» — in English, against a chart of accounts this product itself seeds in Spanish, so it matched nothing and working capital came out zero.',
  'policy.cash_flow_cash_accounts.rationale':
    'The role map is the semantic layer this system already uses everywhere else to answer «which account is this» — it survives renamings, translations and imported charts, which is exactly what account names do not. Matching by name is how that defect got here.',
  'policy.cash_flow_cash_accounts.why':
    'To square the cash flow statement I have to know which accounts hold the cash it is talking about.',
  'policy.cash_flow_cash_accounts.what':
    'I take the accounts mapped to the bank and cash roles.',
  'policy.cash_flow_cash_accounts.if_skipped':
    'I use the role map.',
  'policy.cash_flow_cash_accounts.option.rol':
    'By role: the accounts account_roles marks as bank and cash',
  'policy.cash_flow_cash_accounts.option.subtipo':
    'By subtype: current-asset accounts explicitly flagged as cash',
  'policy.cash_flow_cash_accounts.option.lista':
    'A list of account codes the firm declares',

  'policy.cash_flow_mismatch.question':
    'When the cash flow statement does not equal the real movement of cash, do I publish it, name it, or refuse?',
  'policy.cash_flow_mismatch.impact':
    'A statement of cash flows that does not tie to cash is the one financial statement whose error is provable from the outside — anyone can compare it against the bank. Absorbing the residue into a line item hides exactly what the reader would have caught.',
  'policy.cash_flow_mismatch.rationale':
    'Refusing would leave the firm without a statement it may need for a filing deadline, and silence is how a wrong statement gets signed. Naming the residue keeps the document usable and puts the discrepancy where the preparer — and the auditor — will see it.',
  'policy.cash_flow_mismatch.why':
    'The derived statement and the real movement of cash can disagree. This is the one financial statement anybody can check against your bank, so whether the difference is stated or buried is your call, not mine.',
  'policy.cash_flow_mismatch.what':
    'I publish the statement and state the difference against real cash, with its amount.',
  'policy.cash_flow_mismatch.if_skipped':
    'I publish it and name the difference.',
  'policy.cash_flow_mismatch.option.avisar':
    'Publish it with the difference stated and quantified',
  'policy.cash_flow_mismatch.option.bloquear':
    'Refuse to emit the statement until it ties',
  'policy.cash_flow_mismatch.option.silencio':
    'Publish the computed net without contrasting it',

  'policy.diot_default_operation_type.question':
    'A national supplier with no operation type declared: which one does the DIOT report?',
  'policy.diot_default_operation_type.impact':
    'The DIOT reports each supplier under an operation type. For a national supplier the 2025 catalogue offers 02 transfer of goods, 03 professional services, 06 temporary use of goods, 08 import by virtual transfer and 85 other. It is per SUPPLIER, not per invoice, so a wrong default is wrong for every month until someone corrects it. Foreign suppliers have their own key, diot_default_operation_type_foreign.',
  'policy.diot_default_operation_type.rationale':
    'SAT, Instructivo para el armado del archivo de carga masiva DIOT (Enero 2025), §3.1: 85 "Otros" is the residual key for a national supplier whose operation is not one of the specific ones (02 goods, 03 professional services, 06 use of goods, 08 virtual-transfer import). The ledger does not know whether an undeclared supplier sold goods or services, so asserting 02, 03 or 06 by default would put a specific claim in your name; 85 claims only that no specific key was captured, and every supplier that takes it is listed so the ones that matter can be refined. 08 is not offered as a default: it requires a customs pedimento and cannot be a blanket answer. Refusing would block a monthly filing over a classification that does not change the tax.',
  'policy.diot_default_operation_type.why':
    'The form classifies each supplier by the kind of operation you have with them; the ones with a specific key you have to tell me.',
  'policy.diot_default_operation_type.what':
    'I report national suppliers with no declared type under 85, and list them so you can refine the ones that matter.',
  'policy.diot_default_operation_type.if_skipped':
    'I use 85 and tell you which suppliers took it.',
  'policy.diot_default_operation_type.option.85':
    'Other (85) — the residual key the catalogue provides',
  'policy.diot_default_operation_type.option.02':
    'Transfer of goods (02)',
  'policy.diot_default_operation_type.option.03':
    'Professional services (03)',
  'policy.diot_default_operation_type.option.06':
    'Temporary use or enjoyment of goods (06)',
  'policy.diot_default_operation_type.option.bloquear':
    'None: refuse to build the DIOT until every supplier declares one',

  'policy.diot_default_operation_type_foreign.question':
    'A foreign supplier with no operation type declared: which one does the DIOT report?',
  'policy.diot_default_operation_type_foreign.impact':
    'For a foreign supplier (third-party type 05) the 2025 DIOT catalogue accepts only 02 transfer of goods, 03 professional services and 07 import of goods or services. 85 and 06 are not accepted, so the national default cannot be reused for them.',
  'policy.diot_default_operation_type_foreign.rationale':
    'SAT, Instructivo para el armado del archivo de carga masiva DIOT (Enero 2025), §3.1 limits a foreign supplier to 02, 03 and 07. Under LIVA art. 24 (frac. I–V) bringing in goods, or acquiring or using in Mexico intangibles or services supplied by a non-resident, is an IMPORT, so 07 is the key that describes what the entity did in the usual case, and it matches the import boxes where the file already puts that IVA. 02 and 03 remain available for a firm whose foreign suppliers are better described that way; a supplier that differs declares its own key.',
  'policy.diot_default_operation_type_foreign.why':
    'Foreign suppliers cannot use the national "other" key, and the file is rejected if they carry it.',
  'policy.diot_default_operation_type_foreign.what':
    'I report foreign suppliers with no declared type under 07, and list them.',
  'policy.diot_default_operation_type_foreign.if_skipped':
    'I use 07 and tell you which suppliers took it.',
  'policy.diot_default_operation_type_foreign.option.07':
    'Import of goods or services (07)',
  'policy.diot_default_operation_type_foreign.option.03':
    'Professional services (03)',
  'policy.diot_default_operation_type_foreign.option.02':
    'Transfer of goods (02)',
  'policy.diot_default_operation_type_foreign.option.block':
    'None: refuse to build the DIOT until every foreign supplier declares one',

  'policy.diot_third_party_without_rfc.question':
    'A supplier with a missing, invalid or generic RFC when the DIOT is built: refuse, or report it as global?',
  'policy.diot_third_party_without_rfc.impact':
    'The DIOT identifies each national supplier by RFC. Today the system detects an EMPTY tax id and nothing else: neither a malformed one nor the generic XAXX010101000, which is precisely the value that turns a real supplier into an anonymous one on the filing.',
  'policy.diot_third_party_without_rfc.rationale':
    'Type 15 exists for genuine sales to the general public, not as a bin for suppliers whose RFC nobody captured. Using it that way files a declaration saying those operations had no identifiable counterparty, which is a statement about your books rather than a formatting choice — and it is the kind of thing the authority cross-checks against the suppliers own filings.',
  'policy.diot_third_party_without_rfc.why':
    'A supplier without a valid RFC cannot be identified on the filing, and the alternative to stopping is declaring that those purchases had no known counterparty.',
  'policy.diot_third_party_without_rfc.what':
    'I refuse to build the DIOT and name the suppliers whose RFC is missing, malformed or generic.',
  'policy.diot_third_party_without_rfc.if_skipped':
    'I refuse and name them.',
  'policy.diot_third_party_without_rfc.option.bloquear':
    'Refuse to build it and name the suppliers',
  'policy.diot_third_party_without_rfc.option.declarar_global':
    'Report them under type 15 (global, general public)',

  'policy.diot_exempt_vat_and_base.question':
    'How is exempt activity reported when the source document did not carry its base?',
  'policy.diot_exempt_vat_and_base.impact':
    'The DIOT declares the VALUE of the acts, not only the tax. An exempt line carries no tax amount and, until now, the parser dropped it entirely: a CFDI 4.0 exempt node has TipoFactor="Exento" and no Importe, so it was discarded in silence.',
  'policy.diot_exempt_vat_and_base.rationale':
    'Exempt activity is not the absence of an operation: it is an operation the DIOT wants counted, and understating it understates the total the authority reconciles against your VAT return. Deriving from the subtotal is right often enough to be dangerous — it silently breaks wherever a line mixes exempt and taxed concepts. The base is captured at ingestion: each bill line keeps the Base its CFDI declared on the VAT transfer as its value of the acts, so requiring it means requiring something the document already said. A Base the CFDI omitted stays unknown — it is never filled in from an amount — and so does the base of every line built from the approved entry when any concept of that CFDI omitted it; bills recorded before the capture existed lack it too.',
  'policy.diot_exempt_vat_and_base.why':
    'Exempt purchases still count on the filing, and they are the ones whose amount the system used to throw away without telling anyone.',
  'policy.diot_exempt_vat_and_base.what':
    'I stop and name the documents whose exempt base is unknown instead of guessing it.',
  'policy.diot_exempt_vat_and_base.if_skipped':
    'I require the base and name what is missing.',
  'policy.diot_exempt_vat_and_base.option.exigir_base':
    'Require the base: refuse to report a period with exempt lines whose value is unknown',
  'policy.diot_exempt_vat_and_base.option.derivar_del_subtotal':
    'Derive it from the line subtotal',
  'policy.diot_exempt_vat_and_base.option.omitir_y_avisar':
    'Leave those lines out and list them',

  'policy.diot_creditable_iva_proportion.question':
    'Does this entity credit its IVA through the LIVA art. 5 frac. V proportion?',
  'policy.diot_creditable_iva_proportion.impact':
    'The 2025 DIOT batch layout splits the creditable IVA of each supplier into two boxes: IVA tied EXCLUSIVELY to taxed activities, and IVA to which a proportion was applied because the entity also has exempt or non-taxed activities. The ledger credits every peso of IVA paid; it does not compute that proportion yet.',
  'policy.diot_creditable_iva_proportion.rationale':
    'LIVA art. 5 frac. V only requires the proportion when the taxpayer also performs exempt or non-taxed activities; a firm whose activities are all taxed credits the IVA in full, and that is exactly what the ledger already records in iva_acreditable. Declaring it in the exclusively-taxed box (SAT DIOT instructivo, Enero 2025, §3.3) keeps the file equal to the books and to the monthly VAT return. The DIOT refuses this default when the ledger shows exempt revenue in the fiscal year (accounts mapped to agrupador 401.07–401.09), and an entity that applies the proportion must answer "block": the proportional boxes are not computed here yet, and a factor nobody computed is not declared.',
  'policy.diot_creditable_iva_proportion.why':
    'Only you know whether the entity also has exempt activities, and that decides which box of the DIOT its creditable IVA belongs in.',
  'policy.diot_creditable_iva_proportion.what':
    'I declare all IVA paid as tied exclusively to taxed activities, and stop if the ledger shows exempt revenue.',
  'policy.diot_creditable_iva_proportion.if_skipped':
    'I declare it as exclusively taxed and remind you on every DIOT; answer "block" if the entity applies the proportion.',
  'policy.diot_creditable_iva_proportion.option.taxed_only':
    'No: every activity is taxed, so all IVA paid goes to the exclusively-taxed box',
  'policy.diot_creditable_iva_proportion.option.block':
    'Yes: refuse the SAT batch file until the proportional treatment exists (capture in the portal)',

  'policy.efirma_sealing_e_accounting.question':
    'Does the system seal the Anexo 24 files with your e.firma, or do you seal them yourself?',
  'policy.efirma_sealing_e_accounting.impact':
    'Sealing means the private key of the taxpayer is loaded and used by this software. The files it produces are a declaration to the tax authority signed in your name.',
  'policy.efirma_sealing_e_accounting.rationale':
    'The e.firma is the taxpayer signing, not the software. Producing the file and signing it are different acts and belong to different hands: this system builds the XML, shows you what it contains, and stops. The vault exists for the credentials the system genuinely needs; the signature on a declaration is not one of them. Firms that decide otherwise can say so here, and then every decryption is logged — but the default is that your key never enters this process.',
  'policy.efirma_sealing_e_accounting.why':
    'Sealing an Anexo 24 file means your private key is used by this software to sign a declaration in your name. That is not a technical detail I get to assume for you: it is your signature.',
  'policy.efirma_sealing_e_accounting.what':
    'I build the XML unsealed and hand it to you; the sealing and the transmission are yours.',
  'policy.efirma_sealing_e_accounting.if_skipped':
    'I never seal: your key does not enter this process.',
  'policy.efirma_sealing_e_accounting.option.nunca_sellar_en_el_sistema':
    'Never: the system produces the unsealed XML and you seal and transmit it yourself',
  'policy.efirma_sealing_e_accounting.option.sellar_con_custodia':
    'Seal here, with the key held in the credential vault and every use logged',

  'policy.anexo24_account_without_grouping_code.question':
    'Generating the Anexo 24 catalogue with accounts that have no grouping code: refuse, or emit them?',
  'policy.anexo24_account_without_grouping_code.impact':
    'The CtaCatalogo node requires CodigoAgrupador on every account. An account without one either gets left out of the file — so the balance references an account the catalogue does not declare — or goes in empty and the XSD rejects it.',
  'policy.anexo24_account_without_grouping_code.rationale':
    'Emitting an incomplete catalogue is worse than emitting none: the balance filed afterwards references accounts the catalogue never declared, and that inconsistency is exactly what the authority validates across filings. Stopping costs a mapping session; filing a catalogue that contradicts the balance costs a rejection with the deadline already spent.',
  'policy.anexo24_account_without_grouping_code.why':
    'Every account in the file needs its SAT grouping code, and I can either stop and tell you which ones are missing or hand you a catalogue that does not match the balance you will file next.',
  'policy.anexo24_account_without_grouping_code.what':
    'I refuse to generate and name the accounts that are missing their grouping code.',
  'policy.anexo24_account_without_grouping_code.if_skipped':
    'I refuse and name them.',
  'policy.anexo24_account_without_grouping_code.option.bloquear':
    'Refuse to generate until every account carries its grouping code',
  'policy.anexo24_account_without_grouping_code.option.omitir_y_avisar':
    'Leave them out of the file and list them',
  'policy.anexo24_voucher_money_without_trace.question':
    'A voucher moves bank money with no registered payment behind it (a bank fee, interest, a pay run, a transfer between own accounts): what do the Anexo 24 vouchers do?',
  'policy.anexo24_voucher_money_without_trace.impact':
    'Decides whether `e-accounting voucher generate` delivers a month with such entries. "block" refuses the file (exit 4) and names each voucher until a payment with its trace is captured. "warn" delivers it without the payment node and names each voucher. Neither changes the ledger. Declaring an OtrMetodoPago node instead is not offered: the XSD requires its Benef and RFC, and with no payment record the ledger has neither, so they would be invented.',
  'policy.anexo24_voucher_money_without_trace.rationale':
    'In PolizasPeriodo 1.3 (Anexo 24 RMF) the Cheque, Transferencia and OtrMetodoPago nodes are optional, and each "becomes required" when resources go out or come in by that method; Transferencia is also required for every transaction between the taxpayer\'s own accounts (the XSD documentation of each node). With no payment record the system cannot tell which of those cases an entry is, and a file that lacks a required node is incomplete books (CFF 28-IV). So the default refuses and names the voucher. A firm whose untraced entries are bank charges no instrument moved can answer "warn".',
  'policy.anexo24_voucher_money_without_trace.why':
    'Bank fees and interest move money that no cheque or transfer of yours moved. Whether your firm files those vouchers without a payment node or captures a payment first is your criterion.',
  'policy.anexo24_voucher_money_without_trace.what':
    'I apply your answer to every voucher that moves bank money with no registered payment, and I always name each one.',
  'policy.anexo24_voucher_money_without_trace.if_skipped':
    'I refuse the file and name each voucher.',
  'policy.anexo24_voucher_money_without_trace.option.block':
    'Refuse the file until each one has a registered payment with its trace',
  'policy.anexo24_voucher_money_without_trace.option.warn':
    'Deliver the file without the payment node and list the vouchers',

  'policy.chart_parent_child_coherence.question':
    'May a subaccount sit in a different section of the statements than its parent?',
  'policy.chart_parent_child_coherence.impact':
    'Nothing ties a child account to its parent today, so an expense account can hang under an asset and every statement still foots — the amount simply appears in the wrong section of a document somebody signs. Measured over the 80 parent-child pairs this product seeds, requiring the SAME CATEGORY would be wrong eleven times (1200 «Activo Fijo» is non_current_assets under 1000 «Activo», which is current_assets, and that is correct accounting); requiring the same SECTION holds for all 80. That is why equality is not on offer: it would refuse the catalogue the product itself ships.',
  'policy.chart_parent_child_coherence.rationale':
    'A figure in the wrong section of a signed statement is not caught downstream: the statement balances either way. Refusing costs one corrected account at the moment somebody is already looking at the chart; letting it through costs finding it in a filing. An account with no fs_category on either side is NOT judged — the SAT import leaves it empty on both sides of every edge it creates, and a rule that read absence as a breach would stop a firm migrating its own chart.',
  'policy.chart_parent_child_coherence.why':
    'Your chart already has parents and children, and I can either keep a subaccount inside its parent section or let you place it wherever the chart needs it.',
  'policy.chart_parent_child_coherence.what':
    'I refuse a subaccount whose category lands in a different section than its parent, and I name both.',
  'policy.chart_parent_child_coherence.if_skipped':
    'I refuse it and name both sides.',
  'policy.chart_parent_child_coherence.option.exigir_misma_seccion':
    'Refuse the account: a subaccount stays in its parent section',
  'policy.chart_parent_child_coherence.option.advertir_misma_seccion':
    'Name it and let it through',
  'policy.chart_parent_child_coherence.option.sin_regla':
    'No rule: the chart is the firm’s business',

  'policy.anexo24_levels_to_report.question':
    'Which levels of the chart go into the Anexo 24 catalogue?',
  'policy.anexo24_levels_to_report.impact':
    'The file declares the hierarchy through SubCtaDe and Nivel. Filing only the top levels hides the detail the authority uses to follow an entry; filing everything exposes a chart that may carry internal analytical accounts.',
  'policy.anexo24_levels_to_report.rationale':
    'The catalogue is the map the authority reads the balance and the entries against, so an account that appears in either must appear here. Trimming it creates references the file cannot resolve, and the hierarchy is precisely what SubCtaDe exists to carry.',
  'policy.anexo24_levels_to_report.why':
    'The file has to declare the hierarchy of your chart, and how deep it goes decides whether a later filing can reference an account this catalogue never mentioned.',
  'policy.anexo24_levels_to_report.what':
    'I include the whole chart with its parent-child structure.',
  'policy.anexo24_levels_to_report.if_skipped':
    'I include every account with its hierarchy.',
  'policy.anexo24_levels_to_report.option.jerarquia_completa':
    'Every account, with its parent and level',
  'policy.anexo24_levels_to_report.option.hasta_nivel_2':
    'Only rubros and first-level accounts',
  'policy.anexo24_levels_to_report.option.las_que_se_mueven':
    'Only accounts with posted movement, plus their parents',

  'policy.grouping_code_gate_scope.question':
    'Which accounts must carry a SAT grouping code before the books can be filed?',
  'policy.grouping_code_gate_scope.impact':
    'Decides who the gate accuses. It currently filters by account_level <= 2, which on a real chart reported 43 gaps of which 42 were accounts with no movement at all — while the one account that HAD moved without a grouping code was not reported. It fails in both directions.',
  'policy.grouping_code_gate_scope.rationale':
    'What the SAT reads is the balance and the entries, so an account that never moved cannot misgroup anything. Accusing the whole chart buries the one account that matters under dozens that do not, which is exactly how a gate stops being read.',
  'policy.grouping_code_gate_scope.why':
    'A chart of accounts always has rows nobody ever posts to. Telling you about those is noise, and noise is how a warning stops being read — but the account that DID move and has no grouping code is a filing you cannot make.',
  'policy.grouping_code_gate_scope.what':
    'I only flag accounts that actually moved in the period being filed.',
  'policy.grouping_code_gate_scope.if_skipped':
    'I flag accounts with movement.',
  'policy.grouping_code_gate_scope.option.cuentas_con_movimientos':
    'Only accounts with posted movement in the period',
  'policy.grouping_code_gate_scope.option.todas_las_de_detalle':
    'Every detail account, moved or not',
  'policy.grouping_code_gate_scope.option.todas':
    'Every account in the chart',

  'policy.grouping_code_missing_at_close.question':
    'Closing a month with accounts that moved and have no SAT grouping code: warn, or refuse?',
  'policy.grouping_code_missing_at_close.impact':
    'Without a grouping code those accounts cannot go into the Anexo 24 catalogue, so the filing for that month is impossible until someone maps them.',
  'policy.grouping_code_missing_at_close.rationale':
    'The close is an accounting act and the grouping code is a filing requirement: blocking the books because of a tax catalogue confuses two obligations with different deadlines. The warning is what gives you the days between closing and filing to fix it.',
  'policy.grouping_code_missing_at_close.why':
    'Closing the month and filing it with the SAT are two different deadlines, and an unmapped account only breaks the second one — so you may reasonably want to close anyway and map before you file.',
  'policy.grouping_code_missing_at_close.what':
    'I put the item in red on the close checklist, naming the accounts, and let the close proceed.',
  'policy.grouping_code_missing_at_close.if_skipped':
    'I warn and name them.',
  'policy.grouping_code_missing_at_close.option.avisar':
    'Warn: the checklist item goes red and the close continues',
  'policy.grouping_code_missing_at_close.option.bloquear':
    'Refuse to close until every moved account is mapped',

  'policy.grouping_code_outside_catalog.question':
    'A grouping code that is not in the official SAT catalogue for that year: accept or reject?',
  'policy.grouping_code_outside_catalog.impact':
    'The c_CodAgrup catalogue is revised by the authority, so a code valid in 2022 may not be in 2026, and a filing is validated against the catalogue in force for its fiscal year.',
  'policy.grouping_code_outside_catalog.rationale':
    'An invalid grouping code does not fail here: it fails at the SAT, after the file was sealed with the e.firma and transmitted, when the deadline has already run. Catching it at capture costs one message; catching it at the tax authority costs a rejected filing.',
  'policy.grouping_code_outside_catalog.why':
    'The SAT publishes and revises this catalogue, so a code that was right two years ago can be wrong today — and the file only gets rejected after you have already sealed and sent it.',
  'policy.grouping_code_outside_catalog.what':
    'I refuse a grouping code that is not in the catalogue in force for that year, and say which one it is.',
  'policy.grouping_code_outside_catalog.if_skipped':
    'I reject codes outside the catalogue.',
  'policy.grouping_code_outside_catalog.option.rechazar':
    'Reject: the code must exist in the catalogue in force',
  'policy.grouping_code_outside_catalog.option.avisar':
    'Accept it and warn',

  'policy.anexo24_trial_balance_opening_balance.question':
    'Where does the opening balance of the Anexo 24 trial balance come from?',
  'policy.anexo24_trial_balance_opening_balance.impact':
    'The SAT recomputes SaldoIni + Debe − Haber = SaldoFin on the filed balance. Today the opening balance is only seeded by the HARD close, so an entity that only soft-closes would file zeros in every account — a sealed declaration that the company opened the month at nothing.',
  'policy.anexo24_trial_balance_opening_balance.rationale':
    'The ledger already holds the answer and the reporting layer already knows how to ask for it, so deriving costs one query and is true whatever the period status. Requiring a hard close would make a filing obligation depend on an internal bookkeeping ceremony that the law does not mention.',
  'policy.anexo24_trial_balance_opening_balance.why':
    'Your opening balance is only stored when a period is closed hard, and the filing needs it every month — so I either take it from the ledger or refuse to build the balance at all.',
  'policy.anexo24_trial_balance_opening_balance.what':
    'I derive the opening balance from everything posted before the period, whatever its close status.',
  'policy.anexo24_trial_balance_opening_balance.if_skipped':
    'I derive it from the ledger.',
  'policy.anexo24_trial_balance_opening_balance.option.derivar_del_mayor':
    'Derive it from the ledger: sum everything posted before the period starts',
  'policy.anexo24_trial_balance_opening_balance.option.exigir_cierre_duro':
    'Require a hard close: refuse to build the balance without a seeded opening balance',

  'policy.opening_balance_load_mode.question':
    'When the Anexo 24 opening balance is loaded, is it posted or left as a draft?',
  'policy.opening_balance_load_mode.impact':
    'Posting puts the opening in the ledger in the same act, after the --dry-run and --yes. A draft keeps it out of the ledger until someone runs `entry post` on it, so a second person can review it first; its lines and its date cannot be edited, because moving the date would let a second load double every balance.',
  'policy.opening_balance_load_mode.rationale':
    'The load already shows the whole report with --dry-run and asks before writing, and the penny check compares it to the source afterwards. A draft adds a second step that only pays off when someone else reviews the opening before it is applied.',
  'policy.opening_balance_load_mode.why':
    'Some firms want a second person to look at the migrated opening before it reaches the ledger; others load it themselves.',
  'policy.opening_balance_load_mode.what':
    'I post the opening when the load is confirmed, or leave a locked draft for `entry post`.',
  'policy.opening_balance_load_mode.if_skipped':
    'I post it.',
  'policy.opening_balance_load_mode.option.contabilizar':
    'Post it: the opening is in the ledger once the load is confirmed',
  'policy.opening_balance_load_mode.option.borrador':
    'Leave a draft: `entry post` applies it after a review',

  'policy.census_cfdi_types.question':
    'Which CFDI types in the SAT census count toward completeness at close?',
  'policy.census_cfdi_types.impact':
    'The SAT census lists every CFDI issued and received: income (I), credit notes (E), payment receipts (P), payroll (N) and transfers (T). Every type is kept; this decides which of them the completeness check reports as missing when they are not posted. Adding N checks the payroll the entity stamped against the payroll it posted.',
  'policy.census_cfdi_types.rationale':
    'Owner decision of 2026-09-26 on issue 312: payroll and transfers do not show as missing by default. I, E and P are the CFDI that support the entries of revenue, purchases and their collection or payment (CFF art. 29 and 29-A; LISR art. 27 fr. III; LIVA art. 5 fr. II). A payroll CFDI (N, LISR art. 99 fr. III) supports an expense the payroll module posts as a whole, not one entry per receipt, and a transfer CFDI (T) records goods in transit with no consideration, so neither maps to a posted document one by one. A firm that also reconciles its stamped payroll chooses N.',
  'policy.census_cfdi_types.why':
    'The SAT lists payroll receipts and transfer documents too. Some firms check those against the books, others do not.',
  'policy.census_cfdi_types.what':
    'I count the CFDI of the types you choose when I tell you what is missing from the books; the rest stay in the census.',
  'policy.census_cfdi_types.if_skipped':
    'I count income, credit notes and payment receipts, and leave payroll and transfers out.',
  'policy.census_cfdi_types.option.invoices_and_payments':
    'Income, credit notes and payment receipts (I, E, P)',
  'policy.census_cfdi_types.option.plus_payroll':
    'Also payroll (I, E, P, N)',
  'policy.census_cfdi_types.option.all_types':
    'Every type, transfers included (I, E, P, N, T)',

  'policy.census_missing_at_close.question':
    'A CFDI the SAT lists is missing from the books at close: which direction stops the close?',
  'policy.census_missing_at_close.impact':
    'The SAT census is read against what was posted. A CFDI you issued that is not posted understates income and the IVA you owe; a CFDI you received that is not posted understates a deduction and the IVA you can credit. This decides whether each direction stops the close or only warns.',
  'policy.census_missing_at_close.rationale':
    'An issued CFDI is income the entity already stamped and the SAT already holds: leaving it unposted understates the ISR base and the IVA trasladado of the month (LISR art. 17; LIVA arts. 1-B and 17), and the books must record every operation (CFF art. 28 fr. I). A received CFDI that is not posted is a right not yet exercised: the deduction and the IVA acreditable can still be claimed in a later period (LISR art. 27 fr. III; LIVA art. 5), so it warns. A firm that wants the books to match the SAT both ways before any close chooses both_block.',
  'policy.census_missing_at_close.why':
    'Missing an issued CFDI and missing a received one do not cost the same, and firms differ on how much of that they accept at close.',
  'policy.census_missing_at_close.what':
    'I list what the SAT has and the books lack in the close checklist, and stop the close only for the directions you choose.',
  'policy.census_missing_at_close.if_skipped':
    'A missing issued CFDI stops the close and a missing received one warns.',
  'policy.census_missing_at_close.option.issued_blocks':
    'Issued stops the close; received warns',
  'policy.census_missing_at_close.option.both_block':
    'Both directions stop the close',
  'policy.census_missing_at_close.option.both_warn':
    'Both directions only warn',

  'policy.opening_payable_iva.question':
    'When a migrated vendor invoice does not say the IVA rate inside its open balance, what does the opening load do?',
  'policy.opening_payable_iva.impact':
    'A migrated vendor invoice becomes a bill. With its IVA rate, the bill carries the base and the IVA pending to credit, so paying it moves that IVA to creditable and the DIOT of that month declares it by rate. Without the rate, "require_rate" stops the load and names the documents; "assume_zero_rate" loads them at 0 %: paying them credits no IVA and the DIOT declares them as 0 % acts. The IVA of the documents must also be in the pending-IVA account of the opening.',
  'policy.opening_payable_iva.rationale':
    'Under cash-basis IVA the tax of an unpaid purchase becomes creditable when it is paid (LIVA art. 1-B and art. 5 fr. III), and the DIOT reports what was paid by rate (LIVA art. 32 fr. VIII). Assuming 0 % loses the credit and declares acts at a rate they did not have; asking for the rate costs one column in the file.',
  'policy.opening_payable_iva.why':
    'The old system gives me what is still owed to each vendor, not always how much of it is IVA. I either wait until you tell me, or I load it as having no IVA.',
  'policy.opening_payable_iva.what':
    'By default I stop the load and list the vendor documents without a rate. With "assume_zero_rate" I load them at 0 % and tell you which ones.',
  'policy.opening_payable_iva.if_skipped':
    'I stop the load until each vendor document says its IVA rate.',
  'policy.opening_payable_iva.option.require_rate':
    'Stop the load until each vendor document says its IVA rate',
  'policy.opening_payable_iva.option.assume_zero_rate':
    'Load them at 0 % and warn: no IVA is credited when they are paid',

  'policy.received_line_without_account.question':
    'When a line of a vendor CFDI reaches posting with no expense account, what do I do with it?',
  'policy.received_line_without_account.impact':
    'A received line posts to its own account, then to the one given for the whole document, then to a suggestion that is not a control account. This governs the line that has none of the three when the CFDI is posted from the inbox (`bill inbox run`). With "refuse" nothing is posted: the CFDI stays in the inbox and says which line has no account, until someone codes it. With "role_generic_account" the line goes to the account your chart gives the expense role the CFDI was classified under (general expenses for an ordinary purchase), and the bill is posted without anyone choosing the account; when the classification has no single expense role with an account, it is refused all the same and says why.',
  'policy.received_line_without_account.rationale':
    'A deduction has to be duly recorded in the books (LISR art. 27 fr. IV): an expense booked to a generic account nobody chose is recorded, but not as what it is. Refusing is the conservative option of ADR-0006, decision 1: nothing is posted without review, and coding the line takes one command.',
  'policy.received_line_without_account.why':
    'A vendor CFDI sometimes reaches posting with a line nobody gave an account and nothing in its history suggests one. I either wait for you to code it, or I book it to the generic expense account so the payable is not held up.',
  'policy.received_line_without_account.what':
    'By default I leave the CFDI in the inbox and tell you which line has no account. With "role_generic_account" I post that line to the account of the expense role I classified the CFDI under.',
  'policy.received_line_without_account.if_skipped':
    'I post nothing until every line has an account.',
  'policy.received_line_without_account.option.refuse':
    'Post nothing until someone gives the line an account',
  'policy.received_line_without_account.option.role_generic_account':
    'Post the line to the generic account of its expense role',

  'policy.vat_overcredit_correction_period.question':
    'Payments that released a CFDI\'s IEPS from 1135 to 1130 as VAT: in which period does the correction go?',
  'policy.vat_overcredit_correction_period.impact':
    'Until MNE-001-488 a vendor CFDI with IEPS kept VAT plus IEPS in its bill\'s header, and each payment credited its share of that sum as VAT. `npm run correct:vat-overcredit` lists each bill, payment and month, and with `--apply` posts DR 1135 / CR 1130 for the excess. This key decides the date of that entry. With "ask" nothing is posted and each bill is named with both options. With "current_period" one entry per bill is dated today, in the open period. With "payment_month" one entry per bill and month is dated in the month of each payment; a closed month is reopened only when the run says `--reopen`, and a locked month never is. Either way the complementary return of each month (CFF art. 32) is a person\'s to file, with the figures the census gives.',
  'policy.vat_overcredit_correction_period.rationale':
    'The VAT is creditable in the month it is paid (LIVA art. 5 fr. III), so the excess is an error of those months: NIF B-1 corrects it retrospectively and CFF art. 32 by a complementary return, while firms that do not reopen their books post it in the current period. The norm leaves room, so the default is the conservative option of ADR-0006, decision 1: nothing is posted and no closed month is reopened until a person chooses.',
  'policy.vat_overcredit_correction_period.why':
    'Payments of vendor CFDIs with IEPS credited part of the IEPS as VAT before the bill\'s header held VAT alone. The correction can be dated in each payment\'s month, reopening it if it is closed, or in the period open today.',
  'policy.vat_overcredit_correction_period.what':
    'By default I post nothing and name each bill with the two options. With "current_period" I post one correction per bill today; with "payment_month" one per bill and month, in that month.',
  'policy.vat_overcredit_correction_period.if_skipped':
    'I post no correction until you choose.',
  'policy.vat_overcredit_correction_period.option.ask':
    'Post nothing until someone chooses',
  'policy.vat_overcredit_correction_period.option.current_period':
    'Post one correction per bill, dated today in the open period',
  'policy.vat_overcredit_correction_period.option.payment_month':
    'Post one correction per bill and month, in each payment\'s month',

  'policy.discount_vat_correction_period.question':
    'Early-payment discounts posted before migration 341, whose VAT stayed in 1135: in which period does the correction go?',
  'policy.discount_vat_correction_period.impact':
    'Before migration 341 an early-payment discount went whole to 5200 and its share of the bill\'s VAT stayed in 1135, never creditable. `npm run correct:discount-vat` lists each bill, payment and month, and with `--apply` posts DR 5200 / CR 1135 for that share. This key decides the date of that entry. With "ask" nothing is posted and each bill is named with both options. With "current_period" one entry per bill and payment is dated today, in the open period. With "payment_month" one entry per bill, payment and month is dated on the day the discount was posted; a closed month is reopened only when the run says `--reopen`, and a locked month never is. The VAT declared does not change; the ISR deductions of the month the entry is dated in rise by the share.',
  'policy.discount_vat_correction_period.rationale':
    'A discount lowers the price and its VAT (LIVA art. 7), so its share is not creditable and not a cost: 5200 holds it in excess and the purchase cost, a deduction (LISR art. 27), is understated in the month of the discount. NIF B-1 corrects that error retrospectively, while immaterial errors and firms that do not reopen their books post it in the current period. The norm leaves room, so the default is the conservative option of ADR-0006, decision 1: nothing is posted and no closed month is reopened until a person chooses.',
  'policy.discount_vat_correction_period.why':
    'Discounts taken when paying a vendor, before migration 341, left their VAT in 1135 and counted it as a lower cost. The correction can be dated in the month of each discount, reopening it if it is closed, or in the period open today.',
  'policy.discount_vat_correction_period.what':
    'By default I post nothing and name each bill with the two options. With "current_period" I post one correction per bill and payment today; with "payment_month" one per bill, payment and month, in that month.',
  'policy.discount_vat_correction_period.if_skipped':
    'I post no correction until you choose.',
  'policy.discount_vat_correction_period.option.ask':
    'Post nothing until someone chooses',
  'policy.discount_vat_correction_period.option.current_period':
    'Post one correction per bill and payment, dated today in the open period',
  'policy.discount_vat_correction_period.option.payment_month':
    'Post one correction per bill and payment, in the month the discount was posted',

  'policy.closing_entries_in_reports.question':
    'When a report covers the date the year was closed, do its closing entries count as activity?',
  'policy.closing_entries_in_reports.impact':
    'The closing entry is dated at the END of the period it closes — inside the range the income statement queries. Counting it zeroes the year out: a company with 10,000 in sales prints «Net income 0.0000». Excluding it from the statement while keeping it in the trial balance is the only combination where both documents are true at once.',
  'policy.closing_entries_in_reports.rationale':
    'The income statement answers «what did the business earn», and the closing entry is not earnings: it is the act of putting earnings away. The trial balance answers «what do the books say», and there the entry IS part of the books — hiding it would break the tie with the general ledger that the Anexo 24 is checked against.',
  'policy.closing_entries_in_reports.why':
    'The entry that closes your year falls inside the range your year-end reports ask for, so I have to know whether to count it.',
  'policy.closing_entries_in_reports.what':
    'I leave closing entries out of the income statement and keep them in the trial balance.',
  'policy.closing_entries_in_reports.if_skipped':
    'I exclude them from the statement and include them in the trial balance.',
  'policy.closing_entries_in_reports.option.estado_sin_cierre_balanza_con_cierre':
    'Income statement excludes them; the trial balance includes them and says so',
  'policy.closing_entries_in_reports.option.excluir_siempre':
    'No report ever counts them',
  'policy.closing_entries_in_reports.option.incluir_siempre_y_advertir':
    'Every report counts them and warns the range contains a close',

  'policy.year_result_destination.question':
    'At year-end close, where does the result go: straight to retained earnings, or through «Result of the Period» first?',
  'policy.year_result_destination.impact':
    'Decides whether the balance sheet can still show what THIS year earned after the close. Sweeping straight to 3200 merges it with every prior year on the day of the close, before the shareholders have approved anything.',
  'policy.year_result_destination.rationale':
    'Mexican practice keeps the year result separate until the asamblea resolves what to do with it (dividends, reserva legal, capitalisation) — LGSM art. 19 forbids distributing profits until losses are absorbed, and that argument needs the year to still be identifiable. The account 3300 already exists in the seeded chart and nothing writes to it.',
  'policy.year_result_destination.why':
    'After closing December, your balance sheet either still shows what this year earned or folds it into the accumulated total. That is a presentation decision, and it is yours.',
  'policy.year_result_destination.what':
    'I close the year into 3300 and leave the move to 3200 as a separate, audited act.',
  'policy.year_result_destination.if_skipped':
    'I use the two-step route through «Result of the Period».',
  'policy.year_result_destination.option.dos_pasos_hasta_asamblea':
    'Close to «Result of the Period» (3300); a later audited reclassification moves it to Retained Earnings (3200)',
  'policy.year_result_destination.option.directo_a_acumulados':
    'Close straight to Retained Earnings (3200)',

  'policy.reclose_of_reopened_period.question':
    'If a year-end period that already emitted its closing entry is reopened and closed again, what happens to the first one?',
  'policy.reclose_of_reopened_period.impact':
    'Today the second close emits a COMPLETE second set of closing entries and nothing removes the first: retained earnings takes the result twice. `period reopen` made this reachable from the terminal, so the answer stopped being hypothetical.',
  'policy.reclose_of_reopened_period.rationale':
    'It is the only option that leaves the books stating one truth and shows how they got there: NIF B-1 corrects by reversal, never by edit, and the reversal is the evidence that the first close was undone on purpose. «Incremental» would depend on the first close having been right, which is precisely what a reopening puts in doubt.',
  'policy.reclose_of_reopened_period.why':
    'Reopening a closed year means its closing entry is already sitting in the books, and closing again will write a second one. I need to know whether to undo the first or leave it standing.',
  'policy.reclose_of_reopened_period.what':
    'I reverse the previous closing entry with its reason recorded, then close again from scratch.',
  'policy.reclose_of_reopened_period.if_skipped':
    'I reverse and re-emit.',
  'policy.reclose_of_reopened_period.option.reversar_y_reemitir':
    'Reverse the previous closing entry (own folio, audited reason) and emit the close again in full',
  'policy.reclose_of_reopened_period.option.incremental':
    'Leave the first close standing; the new one sweeps only what is left',
  'policy.reclose_of_reopened_period.option.prohibir':
    'Refuse: a period whose close was emitted is corrected by explicit reclassification, not by closing again',

  'policy.unswept_pl_accounts_severity.question':
    'If the year-end close finishes and some revenue or expense account still carries a balance, is that a warning or a failure?',
  'policy.unswept_pl_accounts_severity.impact':
    'A close that leaves accounts unswept has not closed the year, and the very defect this check exists to catch —the abs() that doubled returns instead of sweeping them— produced exactly that: accounts left at twice their balance while the entry itself balanced and every other indicator read green.',
  'policy.unswept_pl_accounts_severity.rationale':
    'The close is what makes the year final; a close that half-worked leaves the next year seeded from wrong opening balances, and by the time anyone notices the statements are signed. Stopping is recoverable — a wrong opening balance carried forward is not.',
  'policy.unswept_pl_accounts_severity.why':
    'When the close cannot sweep an account to zero, either it stops and tells you or it finishes and hopes you read the warning.',
  'policy.unswept_pl_accounts_severity.what':
    'I roll the close back and name the accounts that would not sweep.',
  'policy.unswept_pl_accounts_severity.if_skipped':
    'I refuse to complete a close that leaves results unswept.',
  'policy.unswept_pl_accounts_severity.option.bloquear_cierre':
    'Fail: the hard close rolls back and the period stays open',
  'policy.unswept_pl_accounts_severity.option.avisar':
    'Warn: the close completes and the residue is reported with its remedy',
  'policy.unswept_pl_accounts_severity.option.tolerancia':
    'Accept up to the entity\'s closing tolerance and fail above it',

  'policy.year_seal_with_unsealed_months.question':
    'Can a fiscal year be sealed while another of its periods is not hard-closed?',
  'policy.year_seal_with_unsealed_months.impact':
    'Governs the hard close of the last period of a fiscal year (period 13, or December in a year that kept twelve periods), the act that sweeps income and expenses into equity with what is posted at that moment. With "require_hard_close" that seal is refused while another period of the year is in soft close, open or future, and the refusal names each one; the soft close of the last period is not stopped. With "accept_unsealed" the year is sealed over them, and the close checklist warns and names them (box year-months-sealed). A period that is not hard-closed still takes entries, and none posted to it after the seal is swept.',
  'policy.year_seal_with_unsealed_months.rationale':
    'The seal sweeps the result with what is posted at that moment, and a period that is not hard-closed still takes entries: an income or an expense posted to it afterwards stays outside the result already swept, while costs and expenses belong to the period of the revenue they produce (NIF A-1, chapter 20). NIF B-1 corrects an error of a closed fiscal year with an adjusting entry in the current period against retained earnings, without reopening it, which presupposes that a closed year takes no more entries. No paragraph of the standards this system carries rules on the order between the monthly closes and the annual one, so none is cited for it: the default is the conservative option of ADR-0006, decision 1, the one that does not sweep a year that can still change.',
  'policy.year_seal_with_unsealed_months.why':
    'Some firms keep their months in soft close so that late adjustments still fit, and seal everything at year end; others hard-close every month first. The annual close sweeps the result on the day it is sealed, so I need to know whether it waits for the months.',
  'policy.year_seal_with_unsealed_months.what':
    'By default I refuse to seal the last period of the year while another period of that year is not hard-closed, and I name each one. With "accept_unsealed" I seal it, and the checklist warns which ones stayed unsealed.',
  'policy.year_seal_with_unsealed_months.if_skipped':
    'I refuse the annual seal until every other period of the year is hard-closed.',
  'policy.year_seal_with_unsealed_months.option.require_hard_close':
    'Refuse the annual seal until every other period of the year is hard-closed',
  'policy.year_seal_with_unsealed_months.option.accept_unsealed':
    'Seal the year over them: the checklist warns and names them',

  'policy.exchange_rate_source.question':
    'When I need an exchange rate for a date, which published source do I use?',
  'policy.exchange_rate_source.impact':
    'Every foreign-currency conversion reads the rate of this source for the operation date. If that source has no rate for that date, the conversion STOPS and says so — it never silently borrows a rate from another source, because that would be choosing tax criteria for you.',
  'policy.exchange_rate_source.rationale':
    'In Mexico the rate with legal effect is the one published in the Diario Oficial (art. 20 CFF): VAT creditable on a foreign-currency payment converts at the DOF rate, and the FIX is a different number for the same day. A Mexican books-first system defaults to the source the SAT will measure it against; firms with treasury reasons to prefer the FIX can say so here.',
  'policy.exchange_rate_source.why':
    'DOF and FIX for the same day are different numbers, and which one your books use is a criterion, not a preference.',
  'policy.exchange_rate_source.what':
    'I convert with the rate of the chosen source for the operation date, and stop if it is missing.',
  'policy.exchange_rate_source.if_skipped':
    'I use the DOF rate.',
  'policy.exchange_rate_source.option.dof':
    'DOF (Diario Oficial; the tax rate under art. 20 CFF)',
  'policy.exchange_rate_source.option.fix_banxico':
    'Banxico FIX (the reference rate, published as banco_mexico)',
  'policy.exchange_rate_source.option.manual':
    'Rates I set by hand with `fx rate set`',

  'policy.closing_exchange_rate_source.question':
    'At the close, which published rate revalues the open foreign-currency balances?',
  'policy.closing_exchange_rate_source.impact':
    "closing fx revalue revalues the foreign-currency receivables, payables and bank balances at the rate of this source for the period's last calendar day, exactly that day. If the source published no rate for it, the run stops and says so: it never takes the previous business day or another source.",
  'policy.closing_exchange_rate_source.rationale':
    'NIF B-15 revalues monetary items at the closing rate, and the realised difference of a later payment is measured with the source of the operations: closing with the same source keeps the unrealised and the realised halves of one difference on the same scale. For a Mexican firm that source is the DOF by default, the rate art. 20 CFF gives legal effect and the one the exchange gain or loss of LISR art. 8 is measured with.',
  'policy.closing_exchange_rate_source.why':
    'DOF and FIX for the same day are different numbers, and the revaluation posts the gap between the book rate and this one.',
  'policy.closing_exchange_rate_source.what':
    "I revalue at the chosen source's rate for the period's last day, and stop if it is missing.",
  'policy.closing_exchange_rate_source.if_skipped':
    'I use the same source as the operations: the DOF unless you changed it.',
  'policy.closing_exchange_rate_source.option.operations_source':
    'The same source as the operations (fuente_tipo_cambio; DOF unless changed)',
  'policy.closing_exchange_rate_source.option.dof':
    'DOF (Diario Oficial; the tax rate under art. 20 CFF), whatever the operations use',
  'policy.closing_exchange_rate_source.option.fix_banxico':
    'Banxico FIX (published as banco_mexico)',

  'policy.fx_revaluation_reversal.question':
    'Is the closing revaluation of foreign balances reversed on day 1 of the next period?',
  'policy.fx_revaluation_reversal.impact':
    'closing fx revalue posts the unrealised exchange difference on the last day of the period and its mirror on day 1 of the next one, which must exist and be open. The balance goes back to its historical rate, the one the realised difference of a later payment or collection is measured against.',
  'policy.fx_revaluation_reversal.rationale':
    'NIF B-15 revalues monetary items at the closing rate for the balance sheet. Payments and collections measure the realised difference against the document’s historical rate (ar-ap-posting.ts), so the revaluation must be reversed on day 1: otherwise the same difference would be recognised twice, once unrealised at the close and again when paid. Keeping the revaluation (no reversal) is not offered until payments read the book rate instead.',
  'policy.fx_revaluation_reversal.why':
    'Reversing or keeping the revaluation are both legitimate under NIF B-15; which one is right depends on how payments measure the realised difference.',
  'policy.fx_revaluation_reversal.what':
    'I post the mirror of the revaluation on day 1 of the next period.',
  'policy.fx_revaluation_reversal.if_skipped':
    'I reverse it on day 1 of the next period.',
  'policy.fx_revaluation_reversal.option.reverse_on_day_one':
    'Reverse it on day 1 of the next period',

  'policy.rep_foreign_currency.question':
    'A receipt in a currency other than the functional one: register it, or leave it for review?',
  'policy.rep_foreign_currency.impact':
    'Decides whether a foreign-currency REP creates its payment. When it does, it goes through the same payment engine as a payment typed by hand (vendor payments since R4, collections since MNE-001-082): each document is extinguished at the rate it was born with, the cash converts at the payment day\'s rate from `fuente_tipo_cambio`, the IVA becomes due at that same rate, and the gap is posted to the exchange gain/loss accounts. The REP\'s own TipoCambioP is not read; the firm\'s source is.',
  'policy.rep_foreign_currency.rationale':
    'NIF B-15 wants the realised difference in the period the payment settles the document, and for VAT the amount caused or creditable is the one actually paid converted at the rate of the payment date (LIVA arts. 1-B, 5-III and 11; art. 20 CFF). The payment engine now books both, so registering is sound; the default still stops at review because a REP the firm did not type is created with no bank account and a rate nobody looked at, and a person should see the first ones before they post. There is no option that matches at the document\'s rate and recognises no difference: that would leave the VAT at the wrong rate and hide a realised result B-15 requires.',
  'policy.rep_foreign_currency.why':
    'A payment in dollars settles documents booked at another rate: the difference is real money and lands in the exchange gain/loss accounts.',
  'policy.rep_foreign_currency.what':
    'I leave the receipt unmatched and tell you, or register it with its realised difference if you say so.',
  'policy.rep_foreign_currency.if_skipped':
    'I do not match foreign-currency receipts, and I say so each time.',
  'policy.rep_foreign_currency.option.no_casar':
    'Do not match: leave it for review with a multi-currency warning',
  'policy.rep_foreign_currency.option.payment_day_rate':
    'Register it through the payment engine, realising the exchange difference at the payment day\'s rate',

  'policy.efirma_max_daily_accesses.question':
    'How many e.firma decryptions per day are normal?',
  'policy.efirma_max_daily_accesses.impact':
    'This is the limit that triggers denial and the anomalous-access signal. Too high = the signal loses value; too low = it interrupts legitimate sync. It should come from the real download cadence.',
  'policy.efirma_max_daily_accesses.rationale':
    'One per hour: generous for any reasonable cadence, but it bounds abuse.',
  'policy.efirma_max_daily_accesses.why':
    'Your e.firma is decrypted every time I authenticate with the SAT. A limit turns an abnormal access pattern into a visible signal — but only if it reflects your real sync cadence.',
  'policy.efirma_max_daily_accesses.what':
    'Above that number of decryptions in 24 hours I deny access and log it as an anomaly.',
  'policy.efirma_max_daily_accesses.if_skipped':
    'I allow 24 per day (one per hour), which is generous: an abuse would have to be large before the signal fires.',
  'policy.efirma_max_daily_accesses.option.4':
    '4 — sync every 6 hours',
  'policy.efirma_max_daily_accesses.option.24':
    '24 — one per hour',
  'policy.efirma_max_daily_accesses.option.96':
    '96 — every 15 minutes',

  'policy.efirma_anomaly_action.question':
    'When an anomalous e.firma access pattern is detected, block or only alert?',
  'policy.efirma_anomaly_action.impact':
    'Blocking protects but can take down a client sync on a false positive. Alerting does not interrupt but requires someone watching. Defines whether you need on-call coverage.',
  'policy.efirma_anomaly_action.rationale':
    'The daily limit already denies the excess; blocking the whole credential without someone on call to handle it would leave the client without service until somebody notices.',
  'policy.efirma_anomaly_action.why':
    'When the access pattern looks wrong I can block the credential or just alert. Blocking protects but a false positive takes down your sync; alerting never interrupts but needs someone watching.',
  'policy.efirma_anomaly_action.what':
    'It decides what happens the moment an anomaly is detected.',
  'policy.efirma_anomaly_action.if_skipped':
    'I only alert. If nobody is watching the alerts, an abnormal access could continue unnoticed.',
  'policy.efirma_anomaly_action.option.bloquear':
    'Block the credential and notify',
  'policy.efirma_anomaly_action.option.alertar':
    'Only alert and let it continue',
  'policy.efirma_anomaly_action.option.bloquear_fuera_horario':
    'Block only outside the defined time window',

  'policy.ingest_auto_post.question':
    'Is auto-posting enabled for CFDI ingestion?',
  'policy.ingest_auto_post.impact':
    'With auto-post off, everything stays in draft for review. On, the system posts without intervention when the confidence, amount, and known-vendor thresholds are met.',
  'policy.ingest_auto_post.rationale':
    'Better to measure for several weeks how often it would get it right before letting it move money on its own.',
  'policy.ingest_auto_post.why':
    'I can classify an invoice and post it without asking, or always leave it as a draft for you to approve. Turning it on saves work; leaving it off means nothing reaches your books unreviewed.',
  'policy.ingest_auto_post.what':
    'With it off, every AI-classified invoice waits for your approval in `mnemosine review`. With it on, invoices meeting the confidence, amount and known-vendor thresholds post on their own.',
  'policy.ingest_auto_post.if_skipped':
    'It stays off: everything goes through your review, which is the safe way to start.',
  'policy.ingest_auto_post.option.off':
    'Off: everything goes to human review',
  'policy.ingest_auto_post.option.shadow':
    'Shadow: run every gate, record the verdict, post NOTHING — builds the track record',
  'policy.ingest_auto_post.option.on':
    'On with the configured thresholds',

  'policy.ingest_auto_post_max_amount.question':
    'What is the maximum amount the AI can post without human review?',
  'policy.ingest_auto_post_max_amount.impact':
    'Hard cap for auto-posting. Above this amount it always goes through review.',
  'policy.ingest_auto_post_max_amount.rationale':
    'Bounds the exposure while a track record is built.',
  'policy.ingest_auto_post_max_amount.why':
    'Even with auto-posting on, there is an amount above which you probably want to look yourself before it touches the books.',
  'policy.ingest_auto_post_max_amount.what':
    'It is a hard cap: above that amount an invoice always goes to review, no matter how confident the classification is.',
  'policy.ingest_auto_post_max_amount.if_skipped':
    'The cap stays at $10,000.',
  'policy.ingest_auto_post_max_amount.option.5000':
    '$5,000 — minor expenses only',
  'policy.ingest_auto_post_max_amount.option.10000':
    '$10,000',
  'policy.ingest_auto_post_max_amount.option.50000':
    '$50,000',

  'policy.rep_missing_received.question':
    'At close, a supplier payment on a PPD bill has no REP yet, though its VAT was already credited. Block the close, just warn, or not watch it at close?',
  'policy.rep_missing_received.impact':
    'With "bloquear", the soft close refuses while any period payment lacks its REP; with "avisar" it closes and the checklist records the unsupported credit; with "no_vigilar" the close ignores the supplier side and rep missing list is the only place that shows it.',
  'policy.rep_missing_received.rationale':
    'The VAT of a PPD bill is creditable when paid (LIVA art. 5 fr. III), and the supplier must issue the REP that supports that credit (CFF art. 29, RMF 2.7.1.35). A late supplier should not freeze your close, but a credit without its receipt is an audit exposure, so the close keeps it visible; rep missing list names the culprits.',
  'policy.rep_missing_received.why':
    'The REP is what supports crediting PPD VAT. Some firms refuse to close a month whose VAT credits still lack their REP; others close and chase the supplier; others track it outside the close.',
  'policy.rep_missing_received.what':
    'It decides whether getPeriodCloseStatus counts missing supplier REPs as a blocking issue, a warning, or not at all.',
  'policy.rep_missing_received.if_skipped':
    'It warns: the close proceeds and the checklist shows the pending REPs.',
  'policy.rep_missing_received.option.avisar':
    'Warn: close proceeds, the missing REP stays visible in the checklist',
  'policy.rep_missing_received.option.bloquear':
    'Block: no close until every payment has its REP',
  'policy.rep_missing_received.option.no_vigilar':
    'Do not watch at close: the credit is already booked; chase REPs from rep missing list',

  'policy.rep_missing_issued.question':
    'At close, a customer collection has no REP issued by us. Block the close or just warn?',
  'policy.rep_missing_issued.impact':
    'The REP for a collected PPD invoice is OUR filing obligation, with a SAT deadline. "bloquear" refuses the close while any collection lacks its REP; "avisar" closes and records it.',
  'policy.rep_missing_issued.rationale':
    'Warning keeps the close usable from day one; switch to bloquear when REP issuance (rep stamp) exists in the system and the obligation can be met from here.',
  'policy.rep_missing_issued.why':
    'Unlike the supplier case, this REP is ours to issue and the SAT deadline is ours to miss. Whether that blocks your close is firm policy.',
  'policy.rep_missing_issued.what':
    'It decides whether getPeriodCloseStatus counts our unissued REPs as a blocking issue or a warning.',
  'policy.rep_missing_issued.if_skipped':
    'It warns: the close proceeds and the checklist shows the obligation.',
  'policy.rep_missing_issued.option.bloquear':
    'Block: our own REP obligation must be met before closing',
  'policy.rep_missing_issued.option.avisar':
    'Warn: close proceeds, the obligation stays on the checklist',

  'policy.segregation_of_duties.question':
    'May the person who did the work also sign it off?',
  'policy.segregation_of_duties.impact':
    'Four-eyes control, on TWO acts that ask the same question. On the manual path: with "exigir", entry post rejects the drafter posting their own entry. On the bank path: it rejects the person who closed a reconciliation session also approving it. With "alertar" both go through and the audit row records the coincidence; off means no check. One key and not two on purpose — it is one decision about the firm\'s hands, and two keys for it would drift apart.',
  'policy.segregation_of_duties.rationale':
    'A one-person firm cannot separate duties; enforcing by default would freeze every posting. Turn it on when there are at least two users.',
  'policy.segregation_of_duties.why':
    'Separation of duties is the classic control against a single person inventing and applying an entry. Whether your firm can afford it depends on how many hands it has.',
  'policy.segregation_of_duties.what':
    'With "exigir", `entry post` refuses when the poster created the draft, and `bank reconciliation approve` refuses when the approver is the one who closed the session (system flows are exempt: they are traced by source). With "alertar", both go through and leave the fact in the audit log.',
  'policy.segregation_of_duties.if_skipped':
    'It stays off: no separation check, which is the only workable default for a single-user tenant — a one-person firm that had to find a second signer would never close a month.',
  'policy.segregation_of_duties.option.off':
    'Off: anyone may post what they drafted (single-person firm)',
  'policy.segregation_of_duties.option.alertar':
    'Warn: post succeeds, the audit trail records the coincidence',
  'policy.segregation_of_duties.option.exigir':
    'Enforce: the poster must be a different user than the drafter',

  'policy.reconciliation_tolerance.question':
    'Must a bank reconciliation come to exactly zero, or may a small residual be carried?',
  'policy.reconciliation_tolerance.impact':
    'Governs `bank reconciliation close`. With "cero_exacto" the session only reaches `balanced` when the two sides agree to the cent, and the close checklist can be read as proof the cash was verified. With a tolerance, anything under it is carried as a named reconciling item instead of blocking — faster to close, and the residual has to be chased later or it ages.',
  'policy.reconciliation_tolerance.rationale':
    'The close checklist reads a balanced session as evidence the cash balance was verified. A tolerance makes that evidence weaker than it looks, so it has to be asked for, never assumed.',
  'policy.reconciliation_tolerance.why':
    'A bank reconciliation that "almost" agrees is the oldest place for an error to hide: the residual is small every month and never the same small thing. Whether your firm closes on an exact zero is a real policy — some do, some carry a tolerance and chase it.',
  'policy.reconciliation_tolerance.what':
    'With "cero_exacto" I refuse to close a session whose two sides differ by a cent, and tell you what is unexplained. With a tolerance I close it and leave the residual as a reconciling item with an owner and a date, so it cannot quietly age.',
  'policy.reconciliation_tolerance.if_skipped':
    'I demand an exact zero. Nothing breaks; some months you will have to chase a cent before I close.',
  'policy.reconciliation_tolerance.option.cero_exacto':
    'Exactly zero: nothing closes until the two sides agree to the cent',
  'policy.reconciliation_tolerance.option.tolerancia_con_residual':
    'Allow a residual under the tolerance, carried as a named item',

  'policy.unexplained_bank_line_at_close.question':
    'At close, what happens to a bank line with no book entry to explain it?',
  'policy.unexplained_bank_line_at_close.impact':
    'Governs `bank reconciliation close` when the statement shows a movement the books never recorded and nobody has classified. "partida_conciliatoria" carries it as a named, owned, dated item; "bloquear_cierre" refuses to close until a person says what it is; "suspenso" parks it in a suspense account, which is a real practice and also the classic place for a difference to go to die.',
  'policy.unexplained_bank_line_at_close.rationale':
    'Keeps the movement visible and chaseable without stopping the close. Blocking is stricter but stalls the month on one unknown line; suspense hides it behind a balance.',
  'policy.unexplained_bank_line_at_close.why':
    'Sooner or later the bank shows a movement your books never recorded and nobody recognises. What you do with it on closing day is a choice between stopping the month, carrying it in the open, or parking it — and the third one is how differences disappear.',
  'policy.unexplained_bank_line_at_close.what':
    'By default I carry it as a reconciling item, so it appears in `bank reconciling-item list` with its age until somebody resolves it. If you choose "suspenso" I will still name it every month it stays there — a suspense account is not a place to stop looking.',
  'policy.unexplained_bank_line_at_close.if_skipped':
    'I carry it in the open as a reconciling item, which is the option that keeps it visible.',
  'policy.unexplained_bank_line_at_close.option.partida_conciliatoria':
    'Carry it as a reconciling item, with owner and expected date',
  'policy.unexplained_bank_line_at_close.option.bloquear_cierre':
    'Refuse to close until someone classifies it',
  'policy.unexplained_bank_line_at_close.option.suspenso':
    'Post it to a suspense account and clear it later',

  'policy.bank_statement_overlap.question':
    'When a new bank statement repeats movements already imported from another one, what happens?',
  'policy.bank_statement_overlap.impact':
    'Governs `bank statement import`. It compares each line of the new file, by its content fingerprint and counting repeats, against the lines of the OTHER statements of the same account. "block" refuses the whole file and names every repeated line and the statement it is already in; "mark" imports the file and records on each repeated line which statement it overlaps, visible in `bank statement show --lines`; "warn" imports the file and only names the repeated lines in the import output. With "mark" and "warn" the repeated movements ARE in the books twice until someone removes one. Two identical lines inside the same file are never touched by this: the bank charged twice.',
  'policy.bank_statement_overlap.rationale':
    'The only option where nothing enters the books twice without a person deciding it. A quarterly over a monthly is caught before it doubles January; the cost is that the operator has to cut the file or change this answer.',
  'policy.bank_statement_overlap.why':
    'Banks reissue statements and send quarterly files that contain the monthly ones. The same file twice I already refuse; two different files that share movements I cannot tell apart from two real movements without you deciding how careful to be.',
  'policy.bank_statement_overlap.what':
    'By default I refuse a statement that repeats movements of another one and tell you which lines and where they already are. If you choose "mark" I import it and leave a mark on each repeated line; with "warn" I import it and only tell you.',
  'policy.bank_statement_overlap.if_skipped':
    'I refuse the overlapping statement, which is the option that never counts a movement twice.',
  'policy.bank_statement_overlap.option.block':
    'Refuse the file and name the lines that are already imported',
  'policy.bank_statement_overlap.option.mark':
    'Import it and mark each repeated line with the statement it overlaps',
  'policy.bank_statement_overlap.option.warn':
    'Import it and only warn which lines were already imported',

  'policy.match_confidence_threshold.question':
    'How sure must the matching engine be before it pairs a bank line on its own?',
  'policy.match_confidence_threshold.impact':
    'Governs `bank match run`. Lower means fewer lines left for a human and more wrong pairs to undo; higher means the engine hands you more work but almost never guesses. A wrong match is not silent — `bank match unapply` undoes it and leaves the reason — but it costs the review it was meant to save.',
  'policy.match_confidence_threshold.rationale':
    'What the engine already used before anyone was asked. Named here so it stops being an accident of the code.',
  'policy.match_confidence_threshold.why':
    'Every bank line has to end up paired with something in your books. I can do that for you when the amount and the date line up, but "how close is close enough" is a judgement about your own tolerance for undoing my mistakes, not a fact I can look up.',
  'policy.match_confidence_threshold.what':
    'Above this number I pair the line and record how sure I was. Below it I leave it for you with my best candidate and the reason it fell short. Description similarity alone NEVER pairs anything, at any threshold.',
  'policy.match_confidence_threshold.if_skipped':
    'I use 0.85, which pairs on a close amount-and-date agreement and leaves the rest to you.',
  'policy.match_confidence_threshold.option.0_75':
    'Loose: pairs more on its own, expect to undo some',
  'policy.match_confidence_threshold.option.0_85':
    'Balanced: only pairs when amount and date agree closely',
  'policy.match_confidence_threshold.option.0_95':
    'Strict: the engine barely decides anything alone',

  'policy.match_max_auto_amount.question':
    'Above what amount must a human confirm a match, however sure the engine is?',
  'policy.match_max_auto_amount.impact':
    'A second gate on `bank match run`, independent of confidence: over this amount the line is left for a person even at 0.99. Combined with the unbreakable floor by Math.min, so the stricter of the two always wins and no setting here can raise it.',
  'policy.match_max_auto_amount.rationale':
    'Aligns with FLOOR_MAX_AUTO_POST so there is one number to reason about, not two. It is a ceiling on the engine, never a permission: the floor still clamps it.',
  'policy.match_max_auto_amount.why':
    'Confidence measures how well two records resemble each other, not how much it costs to be wrong. A big transfer that looks exactly like an invoice is still the one you would want to see with your own eyes.',
  'policy.match_max_auto_amount.what':
    'Over this amount I stop and show you the candidate instead of pairing it, no matter how sure I am. Under it, the confidence threshold decides.',
  'policy.match_max_auto_amount.if_skipped':
    'I stop at $50,000, the same ceiling that governs automatic posting.',
  'policy.match_max_auto_amount.option.10000':
    '$10,000 — a person sees every material movement',
  'policy.match_max_auto_amount.option.50000':
    '$50,000 — same ceiling the auto-posting floor uses',
  'policy.match_max_auto_amount.option.0':
    'No amount gate: confidence alone decides',

  'policy.short_payment_residual.question':
    'When a bill is closed paying less than it owed, where does the shortfall go?',
  'policy.short_payment_residual.impact':
    'Governs `payment apply --mode residual`. With "descuento_compras" the shortfall lands in 5200 (contra-cost), the same account as an early-payment discount, so the cost of the purchase drops. With "otros_ingresos" it is income of the period instead, leaving the cost untouched. With "prohibir" the mode is refused outright and the bill stays open until the vendor issues a credit note.',
  'policy.short_payment_residual.rationale':
    'It keeps a short payment and an early-payment discount in the same account, which is what they economically are: less paid for the same purchase. It also avoids inflating revenue with something that was never a sale.',
  'policy.short_payment_residual.why':
    'Sometimes a bill is settled for less than its balance — a disputed freight charge, a few pesos of rounding, an agreed deduction — and the remainder is never going to be paid. That remainder has to stop being a liability, and where you send it changes your cost of sales and your income. It is a criterion of your firm, not a rule of the SAT.',
  'policy.short_payment_residual.what':
    'When you close a bill short with `payment apply --mode residual --short-pay-reason "..."`, I post the shortfall to the account you choose here and write your reason into the entry, so the auditor reads why the liability disappeared. If you choose "prohibir", I refuse the operation and tell you to ask the vendor for a credit note.',
  'policy.short_payment_residual.if_skipped':
    'Shortfalls go to purchase discounts (5200). Nothing breaks, but if your criterion is to treat them as income, the cost of sales will be understated until you say so.',
  'policy.short_payment_residual.option.descuento_compras':
    'Contra-cost (5200): it reduces what the purchase cost, like a discount',
  'policy.short_payment_residual.option.otros_ingresos':
    'Other income: the cost stands and the shortfall is a gain of the period',
  'policy.short_payment_residual.option.prohibir':
    'Refuse: no bill closes short — demand the vendor credit note',

  'policy.received_credit_note_cost.question': 'When a vendor sends a credit note for a bill, which account takes the cost it lowers?',
  'policy.received_credit_note_cost.impact': 'Governs the entry of a received credit note posted from the inbox (`bill inbox run`). With "bill_accounts" the cost goes back to the expense accounts the bill debited, in proportion to its lines. With "purchase_returns" it goes to purchase returns and discounts (5200), whatever the bill debited. The payable and the VAT move the same either way.',
  'policy.received_credit_note_cost.rationale': 'It reverses what the bill booked, so nothing moves between cost of sales and operating expenses, two categories the chart keeps apart. In the seeded chart 5200 belongs to cost of sales, and the account an expense goes to by default (6100) to operating expenses: an operating expense lowered through 5200 would understate a cost of sales it never was part of. The reason is the chart; no paragraph of an accounting standard is cited for it.',
  'policy.received_credit_note_cost.why': 'A credit note lowers what a purchase cost. Some firms want that in the same account as the expense; others keep returns and discounts in their own account to see how much vendors give back.',
  'policy.received_credit_note_cost.what': 'When you run a vendor credit note from the inbox, I debit accounts payable for its total, take its VAT out of where the VAT of its bill is, and credit the cost to the account you choose here.',
  'policy.received_credit_note_cost.if_skipped': 'The cost goes back to the expense accounts of the bill.',
  'policy.received_credit_note_cost.option.bill_accounts': 'The accounts the bill debited: the note reverses what was booked',
  'policy.received_credit_note_cost.option.purchase_returns': 'Purchase returns and discounts (5200): what vendors give back is shown apart',

  'policy.employment_subsidy_paid_treatment.question':
    'The employment subsidy over the ISR that was handed to the worker in cash (the rule before 1 May 2024): a receivable from the tax authority or an expense of the firm?',
  'policy.employment_subsidy_paid_treatment.impact':
    'It decides whether the cash you hand over comes back as a credit against the ISR withheld from other workers, or lands in payroll expense and never comes back.',
  'policy.employment_subsidy_paid_treatment.rationale':
    'It is what the law allows and what the money actually is: the employer advances cash that the authority repays by way of credit. Expensing it is a decision to give up that credit, which some firms make deliberately when the amounts are small and the paperwork is not worth it — but it should be a decision, not the consequence of a default.',
  'policy.employment_subsidy_paid_treatment.why':
    'Until 30 April 2024, when the subsidy was larger than the ISR of the period the employer had to hand the difference to the worker in cash. That money left the firm and comes back only if you credit it, so where you book it changes both your payroll expense and what you owe the SAT. A paycheck paid from 1 May 2024 hands over nothing (decree DOF 01-05-2024): that is law, and this decision does not apply to it. It still applies to a paycheck already calculated with that cash.',
  'policy.employment_subsidy_paid_treatment.what':
    'For a paycheck that handed cash over, I post that cash to the account this policy names; with "cuenta_por_cobrar_fisco" I also net it against the ISR withheld that the monthly return reports. For a paycheck paid from 1 May 2024 I withhold no ISR, hand over nothing and post nothing for the excess, whatever this policy says.',
  'policy.employment_subsidy_paid_treatment.if_skipped':
    'It goes to a receivable from the authority. Nothing breaks; if your criterion is to absorb it, payroll expense will be understated until you say so.',
  'policy.employment_subsidy_paid_treatment.option.cuenta_por_cobrar_fisco':
    'A receivable: it is creditable against the ISR withheld from other workers',
  'policy.employment_subsidy_paid_treatment.option.gasto_del_patron':
    'An expense: the firm absorbs it and does not credit it',

  'policy.employment_subsidy_rounding.question':
    'How do you round the employment subsidy of a pay period shorter than a month: once, on the period amount, or first on the daily amount?',
  'policy.employment_subsidy_rounding.impact':
    'It moves the subsidy of a week or a quincena by a few cents, and with it the ISR withheld, the cash handed to the worker and the payroll CFDI. In 2026 only January changes: the quincena is 264.58 with one rounding and 264.60 rounding the daily amount first.',
  'policy.employment_subsidy_rounding.rationale':
    'One rounding, half up, on the result is the reading that follows the decree literally — a percentage of the monthly UMA, divided by 30.4 and multiplied by the days — without introducing an intermediate figure the decree never names. From February to December 2026 it gives 535.65 a month, 264.30 a quincena and 123.34 a week. The 536.22 of the decree recital is not an option: no rounding of the UMA in force produces it.',
  'policy.employment_subsidy_rounding.why':
    'The decree fixes the percentage of the UMA and says to divide by 30.4 and multiply by the days, but not where to round. Payroll software and firms do it both ways, and the difference reaches the worker and the SAT.',
  'policy.employment_subsidy_rounding.what':
    'Every Mexican pay run computes the monthly subsidy to the cent and derives the period from that rounded monthly amount, in the way you choose here. The payslip note names the rounding used.',
  'policy.employment_subsidy_rounding.if_skipped':
    'I round once, on the period amount. From February to December the two options give the same figures.',
  'policy.employment_subsidy_rounding.option.producto_al_centavo':
    'Once: the monthly amount to the cent, then monthly × days / 30.4 to the cent',
  'policy.employment_subsidy_rounding.option.diario_al_centavo':
    'The daily amount first: monthly / 30.4 to the cent, then × the days of the period',

  'policy.employment_subsidy_separate_run.question':
    'When a worker gets a second paycheck in the same pay period (an aguinaldo paid in its own run, for example), how much employment subsidy does it carry?',
  'policy.employment_subsidy_separate_run.impact':
    'It decides the subsidy, the ISR withheld, the cash handed to the worker and the payroll CFDI of each paycheck of the period. Either way the period never receives the subsidy twice; with the recomputation it follows the income of the whole period, and with "none" it stays on the regular paycheck.',
  'policy.employment_subsidy_separate_run.rationale':
    'The decree that governs the subsidy (DOF 31-12-2025) grants one amount per period to whoever earns no more than a monthly cap, so both the amount and the cap are measured on the income of the period, not of each payslip. Recomputing on the combined income applies that cap to the whole period, and a later paycheck credits only what the earlier ones did not. When the combined income is over the cap, the subsidy an earlier paycheck already caused was not due: the later paycheck credits nothing more, but that subsidy is not recovered, so the result then differs from paying the aguinaldo with the salary, which would give no subsidy at all.',
  'policy.employment_subsidy_separate_run.why':
    'The decree measures the subsidy and its income cap per pay period, not per payslip, and paying the aguinaldo in its own run is common. Without a rule the second paycheck of the period received the subsidy again and handed the part over its ISR to the worker as cash.',
  'policy.employment_subsidy_separate_run.what':
    'Before crediting the subsidy on a paycheck, I read the other calculated, approved or paid paychecks of the same worker and period. With "recompute_on_combined_income" I compute the subsidy on their income plus this one and credit the difference, never below zero. With "none_on_separate_paycheck" a paycheck of a run other than the regular one, or one that pays only aguinaldo, carries none, and the regular paycheck keeps its own whichever was calculated first.',
  'policy.employment_subsidy_separate_run.if_skipped':
    'I recompute on the combined income of the period and credit only the difference.',
  'policy.employment_subsidy_separate_run.option.recompute_on_combined_income':
    'Recompute it once on the income of both paychecks, and credit on the second only the difference',
  'policy.employment_subsidy_separate_run.option.none_on_separate_paycheck':
    'None on the separate paycheck: a run other than the regular one, or a paycheck that pays only aguinaldo, carries no subsidy; the regular paycheck keeps its own',

  'policy.separate_payment_isr.question':
    'When a worker gets a second paycheck in the same pay period (an aguinaldo paid in its own run, for example), on what base is its ISR withheld?',
  'policy.separate_payment_isr.impact':
    'It decides the ISR withheld, the net pay and the payroll CFDI of a paycheck that shares its pay period with another paycheck of the worker, or that is itself separate (a run other than the regular one, or a paycheck that pays only aguinaldo). Read by separate-payment-isr.ts. With "period_accumulated_base" the period\'s tariff is applied to the ISR base of the period\'s paychecks together, and the paycheck withholds that less the ISR the others already caused, never below zero, whichever was calculated first. With "own_paycheck_base" each paycheck is taxed on its own base alone. "regulation_optional_procedure" is refused: the separate paycheck is not calculated until the text of the procedure is in this system.',
  'policy.separate_payment_isr.rationale':
    'The tariff of LISR art. 96 is the one published for the pay period, and it is applied to the income of that period. Its marginal rate rises with the income, so the tariff on the period\'s income together never withholds less than the tariffs of each paycheck alone: it is the conservative option of ADR-0006, decision 1. The optional procedure of the Regulation for extraordinary payments (RLISR art. 174) is not compared, because this system does not carry its text.',
  'policy.separate_payment_isr.why':
    'Paying the aguinaldo in its own run is common, and its ISR can be computed on the income of the whole period, by the optional procedure of the Regulation, or on that paycheck alone: each gives a different withholding. Taxed on its own base, an aguinaldo of 10,000.00 paid apart from a fortnight of 10,000.00 withholds 541.53; on the period\'s base, 1,384.28.',
  'policy.separate_payment_isr.what':
    'Before withholding the ISR of a paycheck, I read the other calculated, approved or paid paychecks of the same worker and period. With "period_accumulated_base" I apply the period\'s tariff to their ISR base plus this one and withhold the difference with the ISR they caused, never below zero. With "own_paycheck_base" I apply it to this paycheck\'s base alone. With "regulation_optional_procedure" I refuse to calculate the separate paycheck and say why. The paycheck records the treatment and the figures in its calculation details.',
  'policy.separate_payment_isr.if_skipped':
    'I apply the period\'s tariff to the accumulated base of the period and withhold only the difference.',
  'policy.separate_payment_isr.option.period_accumulated_base':
    'On the period\'s accumulated base: the tariff on all the paychecks of the period together, less the ISR the others caused',
  'policy.separate_payment_isr.option.regulation_optional_procedure':
    'The optional procedure of the Regulation for extraordinary payments (RLISR art. 174): not available until its text is in this system',
  'policy.separate_payment_isr.option.own_paycheck_base':
    'On the paycheck alone: each paycheck taxed on its own base, as the engine did before',

  'policy.imss_old_age_band_edge.question':
    'When a worker\'s SBC falls just above the upper edge of a band of the employer cesantía en edad avanzada y vejez quota, which band does it pay?',
  'policy.imss_old_age_band_edge.impact':
    'It decides the rate of the employer quota for cesantía en edad avanzada y vejez of an SBC that falls between two bands of LSS art. 168 fr. II a), and with it the payslip, the payroll entry, the employer liability and the SUA file. In March 2026 an SBC of 352.00 (3.0006 UMA) pays 6.361 % with "above_upper_edge" (335.86 a quincena) and 6.026 % with "truncated_to_hundredths" (318.17); one of 316.00 (1.003 minimum wages) pays 6.026 % (285.63) or 3.150 % (149.31).',
  'policy.imss_old_age_band_edge.rationale':
    'LSS art. 168 fr. II a) charges every SBC but writes its bands to two decimals with no rounding rule; reading «1.51» as «more than 1.50» keeps every upper edge as written and never computes less than the table can require.',
  'policy.imss_old_age_band_edge.why':
    'The table writes its edges to two decimals («3.00 UMA», then «3.01 UMA») and gives no rounding rule, so the law does not say which band an SBC of 3.0006 UMA pays. If the program you determine your quotas with truncates, choose that option so both give the same figure.',
  'policy.imss_old_age_band_edge.what':
    'For each contribution day I place the SBC, capped at 25 UMA, with the UMA and the general minimum wage in force that day, and charge the rate of that band and year from the dated table. The calculation note names the band, the rate and the rule used.',
  'policy.imss_old_age_band_edge.if_skipped':
    'An SBC above an upper edge pays the next band.',
  'policy.imss_old_age_band_edge.option.above_upper_edge':
    'An SBC above a band\'s upper edge, by any amount, pays the next band',
  'policy.imss_old_age_band_edge.option.truncated_to_hundredths':
    'SBC ÷ minimum wage and SBC ÷ UMA are cut to two decimals, then placed in the table',

  'policy.imss_old_age_minimum_wage_area.question':
    'Which minimum wage measures the «1.00 SM» band of the employer cesantía en edad avanzada y vejez quota: the one of your employer registration\'s area, or the general zone\'s for every worker?',
  'policy.imss_old_age_minimum_wage_area.impact':
    'It decides which SBC pays the lowest rate of the employer quota for cesantía en edad avanzada y vejez (LSS art. 168 fr. II a). In March 2026, for an entity registered at the northern border, an SBC of 400.00 pays 3.150 % with "employer_registration_area" (189.00 a quincena, under its minimum of 440.87) and 6.361 % with "general_zone" (381.66, measured with 315.04).',
  'policy.imss_old_age_minimum_wage_area.rationale':
    'A general minimum wage applies to the workers of its own area (LFT art. 92), and the IMSS determines the quotas of each employer registration (LSS arts. 28 and 39), so the band is measured with the minimum of the registration\'s area. An entity that has not declared its zone is measured with the general minimum, and the calculation note says so.',
  'policy.imss_old_age_minimum_wage_area.why':
    'The table names its first band in minimum wages, and Mexico has two general minimums: the general zone and the Zona Libre de la Frontera Norte. If the program you determine your quotas with uses the general-zone minimum for every registration, choose that option so both give the same figure.',
  'policy.imss_old_age_minimum_wage_area.what':
    'For each contribution day I take the general minimum wage of the area this policy names, in force that day, and place the SBC in the band of the dated table. The calculation note names the minimum, its area and whether the entity declared it.',
  'policy.imss_old_age_minimum_wage_area.if_skipped':
    'I use the minimum of the area of the employer registration, which is the entity\'s declared zone, or the general minimum while none is declared.',
  'policy.imss_old_age_minimum_wage_area.option.employer_registration_area':
    'The general minimum of the area of the employer registration (the entity\'s declared zone)',
  'policy.imss_old_age_minimum_wage_area.option.general_zone':
    'The general-zone minimum for every worker, whatever the registration\'s area',

  'policy.filing_rounding_to_pesos.question':
    'In the monthly tax workpaper, which figures do you adjust to whole pesos: every line you capture, or only the amount payable?',
  'policy.filing_rounding_to_pesos.impact':
    'It can move the IVA payable by a peso or two: adjusting every line and adding whole pesos is not the same as adding cents and adjusting the result.',
  'policy.filing_rounding_to_pesos.rationale':
    'CFF art. 20 adjusts the amounts of a return to whole pesos (cents 1 to 50 go down, 51 to 99 go up), after rounding the ledger\'s four decimals to the cent. Adjusting each line before it is added keeps every captured figure a whole peso, as the law asks of each amount. Unverified assumption: that the current Declaraciones y Pagos IVA form captures each line in pesos; if it captures only bases and computes the tax itself, neither option models it.',
  'policy.filing_rounding_to_pesos.why':
    'CFF art. 20 says the amounts of a return are adjusted to whole pesos, but not at which step of the calculation. Firms do it both ways, and the IVA payable they declare can differ by a peso or two.',
  'policy.filing_rounding_to_pesos.what':
    'The workpaper always shows two columns, the cents traceable to the ledger and the pesos to capture, and derives the IVA payable or in favor the way you choose here.',
  'policy.filing_rounding_to_pesos.if_skipped':
    'I adjust every line to pesos before adding them.',
  'policy.filing_rounding_to_pesos.option.cada_renglon':
    'Every line: each captured figure is adjusted to pesos and the arithmetic continues in whole pesos',
  'policy.filing_rounding_to_pesos.option.solo_el_pago':
    'Only the payment: the arithmetic runs in cents and only the result is adjusted to pesos',
  'policy.iva_creditable_proration.question':
    'When the entity collects exempt or non-taxed acts next to taxed ones, which proportion credits the IVA it paid: the month\'s, or the prior year\'s?',
  'policy.iva_creditable_proration.impact':
    'It moves the creditable IVA of every month with mixed activities, and so the IVA payable. "monthly" divides the taxed acts collected in the month by all the acts collected in it; "annual" uses that proportion over the prior calendar year. Either way the proportion multiplies all the IVA paid in the month.',
  'policy.iva_creditable_proration.rationale':
    'LIVA art. 5 fr. V inc. c (inc. d num. 3 for investments) credits the IVA of what serves both taxed and exempt acts in the proportion the taxed acts bear to all the acts of the month: it is the rule of the law, and it follows the entity\'s activity as it changes. Art. 5-B, as in force since its last reform (DOF 12-11-2021), lets the taxpayer instead apply the prior calendar year\'s proportion, and binds it to that option for sixty months, so it is an election to make on purpose, not a default. The ledger does not say which expense serves only taxed acts (inc. a, credited whole) or only exempt ones (inc. b, not creditable), so the month\'s proportion is applied to all the IVA paid: that overstates the credit for an exempt-only expense and understates it for a taxed-only one, and the workpaper warns every time. Unverified assumption: the proportion is used as an exact quotient; if the Declaraciones y Pagos form captures it to a fixed number of decimals, the credit can differ by cents.',
  'policy.iva_creditable_proration.why':
    'The law gives both proportions and the choice is the taxpayer\'s. The annual one smooths the months, and once chosen it must be kept for sixty months.',
  'policy.iva_creditable_proration.what':
    'The monthly IVA workpaper credits all the IVA paid in the month times the proportion you choose here, shows the proportion and its acts, and subtracts only the credited share. With "annual", a prior year without any collected act, or one the ledger does not hold from January, stops the workpaper instead of guessing a proportion. I do not enforce the sixty-month lock of art. 5-B: changing this answer is on you.',
  'policy.iva_creditable_proration.if_skipped':
    'I use the month\'s proportion.',
  'policy.iva_creditable_proration.option.monthly':
    'The month\'s proportion, over all the IVA paid (LIVA art. 5 fr. V inc. c)',
  'policy.iva_creditable_proration.option.annual':
    'The prior calendar year\'s proportion, over all the IVA paid (LIVA art. 5-B)',
  'policy.provisional_isr_sales_returns.question':
    'In the provisional ISR, do sales returns, discounts and allowances lower the nominal income, or are they left to the annual return as a deduction?',
  'policy.provisional_isr_sales_returns.impact':
    'It moves the nominal income of every monthly ISR payment by the returns of the year, and the estimated profit by that amount times the coefficient.',
  'policy.provisional_isr_sales_returns.rationale':
    'LISR art. 14 fr. I takes as nominal income the accumulable income, less only the accumulable inflation adjustment, and LISR art. 25 fr. I makes the returns, discounts and allowances of the year a deduction, not a smaller income. The coefficient of the annual return divides the tax profit by that gross nominal income, so a monthly base built the same way is the one the coefficient was measured against. Unverified assumption: that the annual return the coefficient comes from declared the returns as a deduction; a firm whose return netted them picks the other option.',
  'policy.provisional_isr_sales_returns.why':
    'The law calls the returns a deduction, but firms that net them in their annual return also net them every month. The coefficient and the monthly nominal income have to be built the same way.',
  'policy.provisional_isr_sales_returns.what':
    'The workpaper lists the revenue accounts that carry the sales-returns role apart from the nominal income, and adds them to it or not as you choose here.',
  'policy.provisional_isr_sales_returns.if_skipped':
    'I leave the returns out of the nominal income, as a deduction of the annual return.',
  'policy.provisional_isr_sales_returns.option.deduction':
    'A deduction: the nominal income is gross, and the returns wait for the annual return',
  'policy.provisional_isr_sales_returns.option.net_of_income':
    'Net of income: the returns of the year are subtracted from the nominal income',
  'policy.overtime_isr_exemption.question':
    'Do you apply the ISR exemption of LISR art. 93 fr. I to the overtime you pay?',
  'policy.overtime_isr_exemption.impact':
    'It moves the ISR withheld on every paycheck with overtime, and the exempt part the payroll CFDI declares. "exempt_by_law" exempts 50 % of the double-paid hours within the LFT weekly limit, up to 5 daily UMA of the payment date per week of the period; triple-paid hours go as an earning of their own and are taxed whole. "taxed_in_full" taxes all overtime.',
  'policy.overtime_isr_exemption.rationale':
    'LISR art. 93 fr. I exempts 50 % of overtime pay within the labour-law limit (LFT art. 66, dated by the reform of DOF 01-05-2026), up to 5 times the minimum wage (the UMA since DOF 27-01-2016) per week of service. Withholding on the exempt half over-withholds the worker every period. Taxing it whole is for a firm that cannot evidence the overtime was worked, where the SAT would reject the exemption.',
  'policy.overtime_isr_exemption.why':
    'The law exempts part of the overtime, but only overtime that was really worked and recorded. A firm with time records applies the exemption; one without them may prefer to withhold on all of it.',
  'policy.overtime_isr_exemption.what':
    'With "exempt_by_law" I split each overtime line into its exempt and taxable part and compute the ISR on the taxable one. Every overtime line must carry its `hours`: a line without them, or hours that, added to the other lines and runs of the same period, pass the LFT weekly limit, stop the run before any paycheck is written. With "taxed_in_full" the whole line is taxed and no hours are needed.',
  'policy.overtime_isr_exemption.if_skipped':
    'I apply the exemption of the law.',
  'policy.overtime_isr_exemption.option.exempt_by_law':
    'Exempt it as LISR art. 93 fr. I says: half, up to 5 UMA a week',
  'policy.overtime_isr_exemption.option.taxed_in_full':
    'Tax all overtime, with no exemption',

  'policy.overtime_exempt_weeks.question':
    'How many weeks of service does a pay period count for the overtime cap of LISR art. 93 fr. I (5 UMA per week)?',
  'policy.overtime_exempt_weeks.impact':
    'It moves the exempt overtime of every period that is not a whole number of weeks, and the LFT hours limit of that period: a quincena gets 5 × 15/7 UMA (1 256.89 from February 2026) with "calendar_days_over_seven", and 5 × 2 UMA (1 173.10) with "whole_weeks_of_period". A weekly payroll gets 5 UMA either way.',
  'policy.overtime_exempt_weeks.rationale':
    'Fraction I caps the exemption "por cada semana de servicios" and neither the LISR, its regulation nor the RMF says how a period that is not a whole number of weeks counts them. Days / 7 scales the weekly cap to the days of the period, the way the ISR tariff of each period is scaled to its days (Anexo 8 RMF: weekly, ten-day, fifteen-day and monthly tariffs). Whole weeks is the stricter reading of the words, and never exempts a part of a week: it withholds more. Please confirm this default.',
  'policy.overtime_exempt_weeks.why':
    'The law caps overtime per week, but most payrolls pay by quincena or month, and there are two honest ways to count the weeks in them.',
  'policy.overtime_exempt_weeks.what':
    'I multiply the 5 UMA cap and the LFT weekly hours by the weeks this answer gives: the period\'s days / 7, or the whole weeks in it.',
  'policy.overtime_exempt_weeks.if_skipped':
    'I count the period\'s days / 7.',
  'policy.overtime_exempt_weeks.option.calendar_days_over_seven':
    'The period\'s calendar days / 7: a quincena is 15/7 weeks',
  'policy.overtime_exempt_weeks.option.whole_weeks_of_period':
    'Only the whole weeks in the period: a quincena is 2 weeks, a month 4',

  'policy.isn_taxing_state.question':
    'For the state payroll tax (ISN), which state does a worker belong to: the one where the work is performed, or the one of the firm\'s tax domicile?',
  'policy.isn_taxing_state.impact':
    'It decides which state you file in and at which rate — the rates run from about 1% to 4% and each state audits its own.',
  'policy.isn_taxing_state.rationale':
    'The ISN is a state tax on payroll paid for work performed within that state, so the work state is the one that can demand it. A firm whose workers all sit at the tax domicile gets the same answer either way; one with people in several states does not, and filing everything in the head office state is how a firm ends up owing another state for years without knowing.',
  'policy.isn_taxing_state.why':
    'Remote and multi-state workforces make this a real fork, and it is not a rule the system can settle: it depends on where your establishments are and what each state\'s law says about them.',
  'policy.isn_taxing_state.what':
    'I group each pay run by the state this policy points at, look up that state\'s rate for the period, and accrue one ISN liability per state. If a state has no rate captured, I say which state and which period rather than computing zero.',
  'policy.isn_taxing_state.if_skipped':
    'I use the employee\'s work state. If your establishments are all in one state, this changes nothing.',
  'policy.isn_taxing_state.option.centro_de_trabajo':
    'Where the work is performed (the employee\'s work state)',
  'policy.isn_taxing_state.option.domicilio_fiscal':
    'The state of the firm\'s tax domicile, for every worker',

  'policy.isn_recognition_basis.question':
    'Do you accrue the ISN when the payroll is earned, or when it is paid?',
  'policy.isn_recognition_basis.impact':
    'It moves the expense between months whenever a pay period straddles a month end.',
  'policy.isn_recognition_basis.rationale':
    'The payroll expense it rides on is accrued, and splitting the tax from its base puts the two in different months for no reason. Firms on a cash criterion for state taxes can say so here.',
  'policy.isn_recognition_basis.why':
    'A pay period that starts in one month and ends in the next has to land somewhere, and the two answers give different monthly results.',
  'policy.isn_recognition_basis.what':
    'I date the ISN liability by the criterion you choose here, and the due date by the state calendar either way.',
  'policy.isn_recognition_basis.if_skipped':
    'It accrues with the payroll that caused it.',
  'policy.isn_recognition_basis.option.devengo':
    'When earned, with the payroll it belongs to',
  'policy.isn_recognition_basis.option.pago':
    'When paid, with the cash that leaves',

  'policy.employer_contribution_accrual.question':
    'Do you accrue the employer IMSS and INFONAVIT contributions with every pay run, or once a month when they are paid?',
  'policy.employer_contribution_accrual.impact':
    'It decides whether a mid-month payroll shows its employer cost immediately or only at the month end.',
  'policy.employer_contribution_accrual.rationale':
    'The employer contribution is a cost of the same work the payroll pays for, and accruing it with its pay run keeps the cost of a period complete without waiting for the month end. Firms that reconcile against the SUA line by line often prefer the monthly accrual, and that is a real criterion, not an error.',
  'policy.employer_contribution_accrual.why':
    'IMSS and INFONAVIT are paid monthly and bimonthly, not per pay run, so there is a genuine choice between matching the cost and matching the payment.',
  'policy.employer_contribution_accrual.what':
    'I write one employer liability row per pay run or one per month according to this, and the SUA reconciliation reads whichever you chose.',
  'policy.employer_contribution_accrual.if_skipped':
    'They accrue with each pay run.',
  'policy.employer_contribution_accrual.option.por_corrida':
    'With every pay run, next to the payroll that caused it',
  'policy.employer_contribution_accrual.option.mensual_al_cierre':
    'Once a month, matching how they are actually paid',

  'policy.archived_accounts_in_reports.question':
    'Once an account is archived, does it keep its row in a trial balance where it has nothing to show?',
  'policy.archived_accounts_in_reports.impact':
    'Only affects an archived account that NEVER received a posted line before the cutoff — a line of the chart that was opened and retired without ever being used. The moment an archived account has any posted history, it is shown in every report and no setting here can hide it: that is what stopped a signed income statement from changing when the chart was tidied, and it is deliberately conservative — the rule errs towards showing, because the failure it exists to prevent is money disappearing from a signed statement. What this decides is whether the never-used retired line keeps its zero row, month after month.',
  'policy.archived_accounts_in_reports.rationale':
    'It is what archiving is FOR — the firm retired the line to stop seeing it — and it is what the reports already did, so no balanza gains rows it never had. Keeping it is a real criterion for a firm that reconciles the Anexo 24 against a fixed chart and wants the same set of rows every period; neither answer moves a figure, which is exactly why it is a preference and not a correction.',
  'policy.archived_accounts_in_reports.why':
    'Retiring a line of your chart at year end is routine. What is not obvious is whether that line should disappear from next year\'s trial balance or stay there at zero, and both are defensible bookkeeping.',
  'policy.archived_accounts_in_reports.what':
    'In the trial balance I always include an archived account that the ledger backs up to the report cutoff — ANY posted line up to it, not just movement in the range — so no figure ever vanishes. On "retirar" I leave out the archived accounts that never received one; on "mantener" I keep them, at zero, alongside the unused active accounts the balanza already lists. The income statement, the balance sheet and the ledger do not read this policy at all: they already show exactly the accounts that carry something in the period.',
  'policy.archived_accounts_in_reports.if_skipped':
    'An archived account that was never used drops off the trial balance. Every archived account with posted history stays, always.',
  'policy.archived_accounts_in_reports.option.retirar_cuando_no_tiene_nada':
    'Drop it: an archived line that was never used comes off the trial balance',
  'policy.archived_accounts_in_reports.option.mantener_en_la_balanza':
    'Keep it at zero, like any unused account, so the row set matches the chart every month',

  'policy.cash_flow_unclassified.question':
    'When an account moved but belongs to no section of the cash flow statement, do I publish the statement naming it, or refuse until it has one?',
  'policy.cash_flow_unclassified.impact':
    'This is NOT the same question as the statement not tying to cash. Two unclassified accounts whose amounts cancel leave the net tying perfectly against the bank while operating, investing and financing are each wrong by the part that belonged to them. The residue is invisible from the outside: nobody can catch it by comparing against the bank statement.',
  'policy.cash_flow_unclassified.rationale':
    'Refusing would leave the firm without a statement it may need for a filing deadline, and the remedy — giving the account an fs_category — is a catalog edit the preparer may not be able to make at that moment. Naming the accounts keeps the document usable and puts the gap where the preparer sees it.',
  'policy.cash_flow_unclassified.why':
    'Whether a statement with an unclassified account is publishable is your call. The one thing I will not do is stay quiet about it: an account that moved and fell in no section is a subtotal that is wrong without the total showing it.',
  'policy.cash_flow_unclassified.what':
    'I publish the statement and name every account that moved without a section.',
  'policy.cash_flow_unclassified.if_skipped':
    'I publish it and name them.',
  'policy.cash_flow_unclassified.option.avisar':
    'Publish it, naming every account that landed in no section',
  'policy.cash_flow_unclassified.option.bloquear':
    'Refuse to emit it until every account that moved has a section',

  'policy.withholding_accounts_layout.question':
    'On which accounts does the ISR and VAT this entity withholds from its suppliers accumulate?',
  'policy.withholding_accounts_layout.impact':
    'Decides where fees and lease withholdings are booked until the 17th pays them. Payroll ISR stays on 2140 in every layout. One account per tax gives the two lines of the monthly payment and of the DIOT without splitting a balance. Three accounts follow the SAT grouping code (216.03 leases, 216.04 professional services, 216.10 VAT); ISR withheld on anything that is not a lease, the 1.25 % of RESICO (LISR 113-J) on goods, services or freight included, is booked as professional services; a RESICO real-estate lease is booked as a lease. With one account per tax, 2141 holds lease and fees ISR together, so its grouping code in the Anexo 24 trial balance (CFF 28-IV) can only be one of the two. One account needs the working paper to split ISR from VAT, and the approval of a draft can only check their sum.',
  'policy.withholding_accounts_layout.rationale':
    'The withholder pays the ISR (LISR 106, 116) and the VAT (LIVA 1-A, 5-D) it withheld with the monthly return due on the 17th, as separate taxes, and the DIOT reports the VAT withheld per supplier (LIVA 32-VIII): a balance per tax is what both read without any split. It is what entities are seeded with.',
  'policy.withholding_accounts_layout.why':
    'Some firms keep one withholdings account, others one per tax, others follow the SAT grouping code line by line.',
  'policy.withholding_accounts_layout.what':
    'I point the two withholding roles at the accounts of the layout, create the ones missing, and book each withholding there.',
  'policy.withholding_accounts_layout.if_skipped':
    'I keep one account per tax: 2141 for ISR, 2142 for VAT.',
  'policy.withholding_accounts_layout.option.per_tax':
    'One account per tax: 2141 ISR withheld, 2142 VAT withheld',
  'policy.withholding_accounts_layout.option.single':
    'One account for both: 2143 ISR and VAT withheld',
  'policy.withholding_accounts_layout.option.by_concept':
    'Three accounts: 2144 ISR on leases (216.03), 2145 ISR on professional services (216.04), 2142 VAT (216.10)',

  'policy.withholding_accounts_existing.question':
    'When an existing entity\'s withholding roles do not follow the layout, what do I do?',
  'policy.withholding_accounts_existing.impact':
    'Governs entities seeded before the layout existed (both roles on 2140, with payroll ISR) or whose layout changed. "warn" names them in doctor and in the close checklist, without blocking, with the command that fixes them: `account role sync`, which has --dry-run. "repoint" runs it when this key or the layout is set, and warns about what it could not move. "keep" does neither. The command creates the missing accounts and repoints the roles, audited; it posts nothing and leaves past balances where they are. A mapping someone set by hand is never overwritten.',
  'policy.withholding_accounts_existing.rationale':
    'Repointing changes where next month\'s withholdings land, and the balance already on 2140 stays there until someone reclassifies it with an entry. The books must let each operation be traced to its account (CFF 28, RCFF 33): a change a person reviewed with --dry-run is one the firm can explain to an auditor, a change nobody looked at is not.',
  'policy.withholding_accounts_existing.why':
    'Moving the roles of a company that is already posting changes its books from the next entry on.',
  'policy.withholding_accounts_existing.what':
    'I warn and name `account role sync`; with "repoint" I run it myself when the layout is set.',
  'policy.withholding_accounts_existing.if_skipped':
    'I warn, and change nothing.',
  'policy.withholding_accounts_existing.option.warn':
    'Warn in doctor and in the close checklist, naming the command',
  'policy.withholding_accounts_existing.option.repoint':
    'Repoint them, audited, when the layout is set',
  'policy.withholding_accounts_existing.option.keep':
    'Leave them as they are, without warning',

  'policy.cheque_advance_before_cashing.question':
    'An advance received by cheque is applied to an invoice before the bank cashes the cheque, where it would cancel IVA not caused yet: what do I do?',
  'policy.cheque_advance_before_cashing.impact':
    'Governs `receipt apply` of a cheque with no cashing recorded whose cash carries its advance\'s IVA, to a PPD invoice or to a PUE one at another treatment. With "refuse" nothing is written, and the message names `bank check reconcile --receipt`, after which the application goes through. With "defer_to_cashing" an application to a PPD invoice posts now with no IVA line, and the cashing nets that IVA against the share the invoice releases that day; a PUE invoice at another treatment releases none, so it is still refused. A PUE invoice at the receipt\'s own treatment is applied either way.',
  'policy.cheque_advance_before_cashing.rationale':
    'LIVA art. 1-B, second paragraph: a price paid by cheque is collected, and its IVA caused, the day the bank cashes the cheque. Applying its advance before then would cancel in the ledger IVA nobody has caused yet, so the month would read less IVA than the paper. Refusing posts nothing without review, the conservative option of ADR-0006.',
  'policy.cheque_advance_before_cashing.why':
    'Some firms apply a customer\'s cheque to its invoice the day it arrives, before the bank cashes it. That works if the IVA of the advance is settled on the cashing day; refusing keeps every month exact until then.',
  'policy.cheque_advance_before_cashing.what':
    'With "refuse" I refuse the application and name the cashing command. With "defer_to_cashing" I apply it to a PPD invoice with no IVA line and net its IVA when the cashing is recorded; a PUE invoice at another treatment I still refuse.',
  'policy.cheque_advance_before_cashing.if_skipped': 'I refuse the application until the cashing is recorded.',
  'policy.cheque_advance_before_cashing.option.refuse': 'Refuse until the cashing is recorded',
  'policy.cheque_advance_before_cashing.option.defer_to_cashing':
    'Apply it to a PPD invoice now and net its IVA on the cashing day',

  'policy.plain_receipt_unapply_iva.question':
    'A receipt with no advance treatment is unapplied from a PPD invoice: does the IVA its collection caused stay caused, or go back to uncollected?',
  'policy.plain_receipt_unapply_iva.impact':
    'Governs `receipt unapply` of a receipt with no advance treatment on a PPD invoice whose collection released its IVA. With "keep_caused" the IVA stays in 2120 and the cash goes back to 2150 for its base, carrying that IVA, so applying it again nets it instead of causing it twice. With "repark_same_month" each allocation whose IVA was released in the calendar month of the unapply goes back to 2125, with the IEPS it moved; one released in an earlier month stays caused, and so does a cheque the bank has not cashed. The IVA workpaper keeps the IVA caused under either answer, and its tie-out names a re-park.',
  'policy.plain_receipt_unapply_iva.rationale':
    'LIVA art. 1-B, first paragraph: a price is collected when it is received, even as an advance, and an unapply returns no money. LIVA art. 7: only a documented return, discount or bonus takes the IVA back. Keeping it caused never lowers a month without a refund, the conservative option of ADR-0006. Re-parking in a later month would lower a month already declared, which takes an amended return (CFF art. 32), so neither answer does it.',
  'policy.plain_receipt_unapply_iva.why':
    'Some firms treat an unapply in the same month as the correction of a mistake, and want the invoice\'s IVA back as uncollected until the cash is applied again. Keeping it caused follows the law and nets when the cash is applied again.',
  'policy.plain_receipt_unapply_iva.what':
    'With "keep_caused" I leave the IVA in 2120 and record on the allocation what it kept. With "repark_same_month" I move back to 2125 the IVA of each allocation released in the month of the unapply, keep the rest caused, and the dry run says why.',
  'policy.plain_receipt_unapply_iva.if_skipped': 'I keep the IVA caused.',
  'policy.plain_receipt_unapply_iva.option.keep_caused': 'Keep the IVA caused and carry it on the cash back on account',
  'policy.plain_receipt_unapply_iva.option.repark_same_month':
    'Re-park it when the unapply is in the month the IVA was released',

  'policy.note_reversal_after_cashing_iva.question':
    'A credit note issued while a customer cheque was held is reversed after the bank cashed the cheque: in which month does the IVA paper count the IVA the note no longer restitutes?',
  'policy.note_reversal_after_cashing_iva.impact':
    'Governs the IVA workpaper after `entry reverse` or `entry void` of such a note. Under either answer the ledger posts DR 2150 / CR 2120 for that IVA, dated with the reversal, or with the cashing when the reversal is dated before it. With "reversal_month" the paper counts it in the month of that entry, so every month ties out with the ledger and no month already declared moves. With "cashing_month" the paper reads the note as never issued and counts it in the month of the cashing; the tie-out names the amended return that month needs and the correction in the month of the reversal.',
  'policy.note_reversal_after_cashing_iva.rationale':
    'LIVA art. 1-B and decision (A) on cash kept on account: the cash the note covered was owed back to the customer, not consideration, and the cancellation is the act that makes it consideration held on account again. The ledger dates that correction with the reversal (NIF B-1), and counting it there changes no month already declared and lowers none, the conservative option of ADR-0006. Reading the cancelled CFDI as never issued (CFF art. 29-A) is also accepted, and takes an amended return of the cashing\'s month (CFF art. 32).',
  'policy.note_reversal_after_cashing_iva.why':
    'Some firms treat a cancelled credit note as if it had never existed and amend the month it affected; others recognise the cancellation in the month it happens. The ledger is the same either way.',
  'policy.note_reversal_after_cashing_iva.what':
    'With "reversal_month" I count that IVA in the month of the reversal\'s correction. With "cashing_month" I count it in the month of the cashing and name, in the tie-out, the amended return and the correction.',
  'policy.note_reversal_after_cashing_iva.if_skipped': 'I count it in the month of the reversal.',
  'policy.note_reversal_after_cashing_iva.option.reversal_month': 'Count it in the month of the reversal, as the ledger does',
  'policy.note_reversal_after_cashing_iva.option.cashing_month':
    'Count it in the month of the cashing, as if the note had never been issued',

  'policy.vendor_undo_iva_month.question':
    'A vendor payment that released a bill\'s IVA is unapplied or reversed in a later month: in which month do the DIOT and the IVA workpaper take that IVA out?',
  'policy.vendor_undo_iva_month.impact':
    'Governs the DIOT and the IVA workpaper after `payment unapply` or `payment reverse` of a vendor payment applied in an earlier month; hechos.ts reads it once for each month either builds. Under either answer the ledger credits the creditable IVA (1130) on the day of the undo. With "undo_month" the papers take it out in the month of the undo, so the month it counted in keeps what it declared and every month ties out with the ledger. With "payment_month" the papers read the application as never having existed: the month it counted in no longer counts it and needs an amended return, and the month of the undo takes nothing out; the notice DIOT-PAYMENT-UNDONE says so in both months, and the tie-out names the cause in both. An undo dated in the month of the application nets there under either answer.',
  'policy.vendor_undo_iva_month.rationale':
    'The ledger takes the IVA out of 1130 on the day of the undo, and creditable IVA is the tax effectively paid on a bill (LIVA art. 5 fr. III, as the CFDI manual of this system carries it; the text of the LIVA is not in this system): after the undo the books show the bill owed again. Counting the undo in its own month changes no month already declared and keeps every month tied to the ledger, the conservative option of ADR-0006. When the application should never have existed, amending the month it counted in (CFF art. 32) is also accepted.',
  'policy.vendor_undo_iva_month.why':
    'A vendor reversal stores no cause, so I cannot tell a transfer that came back from an application that should never have existed. Some firms take the undo out in its own month, as the ledger does; others amend the month the payment counted in.',
  'policy.vendor_undo_iva_month.what':
    'With "undo_month" I take the undone IVA out in the month of the undo. With "payment_month" I count it in no month, and name, in the notice and the tie-out of both months, the amended return the month of the payment needs.',
  'policy.vendor_undo_iva_month.if_skipped': 'I take it out in the month of the undo.',
  'policy.vendor_undo_iva_month.option.undo_month': 'Take it out in the month of the undo, as the ledger does',
  'policy.vendor_undo_iva_month.option.payment_month': 'Count it in no month, and amend the month of the payment',

  'policy.cash_over_limit_outside_ingestion.question':
    'When a bill is settled in cash above the LISR limit outside the CFDI ingestion, what do I do?',
  'policy.cash_over_limit_outside_ingestion.impact':
    'Governs `bill approve` (for a bill whose CFDI says FormaPago 01) and `payment create --method cash`. With "signal" the operation returns a deductibility-at-risk finding and changes nothing. With "draft_reclassification" it also proposes, as a draft a person approves, moving the bill\'s expense and IVA to the non-deductible account. With "ignore" it says nothing. A bill the ingestion created is never judged again: its answer to `efectivo_no_deducible` stands.',
  'policy.cash_over_limit_outside_ingestion.rationale':
    'LISR art. 27 fr. III denies the deduction of what is paid in cash above the limit, and LIVA art. 5 fr. I denies the IVA credit with it; but the law keys on how the payment was really made, which a bill alone does not prove (the CFDI method may be the wrong one, the same exception the ingestion offers). The books keep what was posted (NIF A-1, faithful representation) and a person is told, with the figures, before the return is filed.',
  'policy.cash_over_limit_outside_ingestion.why':
    'Cash above the limit makes the expense non-deductible, but only if it really was paid in cash. Some firms want a draft ready, others only the warning.',
  'policy.cash_over_limit_outside_ingestion.what':
    'I compare the cash against the limit in force on the payment date and report it; with "draft_reclassification" I leave a draft in the review queue.',
  'policy.cash_over_limit_outside_ingestion.if_skipped': 'I signal it and change nothing.',
  'policy.cash_over_limit_outside_ingestion.option.signal': 'Signal it and change nothing: a person decides',
  'policy.cash_over_limit_outside_ingestion.option.draft_reclassification':
    'Signal it and propose the non-deductible reclassification as a draft',
  'policy.cash_over_limit_outside_ingestion.option.ignore': 'Say nothing',

  // MNE-001-345 · the finding text of LISR art. 27 fr. III cash above the limit.
  'cash_limit.finding.at_approve':
    '{bill}: the CFDI declares payment in cash for {amount} MXN (dated {date}), above the {limit} limit of LISR art. 27 fr. III: the deduction and the IVA credit (LIVA art. 5 fr. I) are at risk if it was really paid in cash. Nothing was reclassified.',
  'cash_limit.finding.at_payment':
    '{bill}: {amount} MXN paid in cash on {date} exceeds the {limit} limit of LISR art. 27 fr. III: the deduction and the IVA credit (LIVA art. 5 fr. I) are at risk. Nothing was reclassified.',
  'cash_limit.finding.unavailable':
    '{bill}: paid in cash on {date}, but no vigencia of the LISR art. 27 fr. III limit covers that date, so it could not be judged. Seed the legal parameter and review it.',
  'cash_limit.finding.draft_proposed': 'A reclassification draft was left in the review queue ({count}).',
  'cash_limit.finding.draft_failed': 'The reclassification draft could not be proposed: {reason}.',

  'policy.time_zone.question':
    'In which time zone does "today" fall for these books?',
  'policy.time_zone.impact':
    'Every date the system fills in by itself — a credit note created without --date, for one — is the calendar day in this zone at that moment. At 20:00 in Mexico City it is already the next day in UTC; a date taken from UTC lands the document in the next day, and on the last day of a month in the next period and folio series.',
  'policy.time_zone.rationale':
    'Most Mexican books keep central time, which has no daylight saving since 2022. Any IANA zone is accepted; one the runtime does not know is refused, because a misspelt zone would otherwise fall back to some other clock without saying so.',
  'policy.time_zone.why':
    'The server clock runs in UTC. Whether the day a document is dated is Mexico City\'s, Tijuana\'s or Cancún\'s is a fact about your books that I cannot guess.',
  'policy.time_zone.what':
    'I take the calendar day in this zone whenever a date is not given to me.',
  'policy.time_zone.if_skipped':
    'I use Mexico City\'s day.',
  'policy.time_zone.option.america_mexico_city':
    'Central Mexico (UTC−6 all year)',
  'policy.time_zone.option.america_tijuana':
    'Baja California (follows US daylight saving)',
  'policy.time_zone.option.america_cancun':
    'Quintana Roo (UTC−5 all year)',
  'policy.time_zone.option.america_hermosillo':
    'Sonora (UTC−7 all year)',
  // ==== end of policy.* ===============================================
  // ==== pending.* and policy_preview.* — the `pending` screen by key (I10 · #152, MNE-001-091) ====
  'pending.board.empty':
    'Nothing pending. All caught up.',
  'pending.board.work':
    '{count, plural, one {# thing to resolve} other {# things to resolve}}',
  'pending.board.warnings_only':
    'warnings only',
  'pending.board.draft':
    '{count, plural, one {# draft awaits} other {# drafts await}} your approval',
  'pending.board.question':
    '{count, plural, one {# unanswered question} other {# unanswered questions}} from the AI',
  'pending.board.outbox':
    '{count, plural, one {# queued write} other {# queued writes}} to {providers}',
  'pending.board.credential_expired':
    'your {kind, select, efirma {e.firma} other {CSD}} has ALREADY EXPIRED — renew it at the SAT',
  'pending.board.credential_expires':
    'your {label} expires in {days, plural, one {# day} other {# days}}',
  'pending.board.period_close':
    '{count, plural, one {# ended period remains} other {# ended periods remain}} unclosed',
  'pending.board.minimum_wage_zone':
    'the minimum wage zone is not declared: {count, plural, one {# worker is} other {# workers are}} computed with the general minimum',
  'pending.board.period_example':
    '{period} (ended {date})',
  'pending.policies.none':
    'No pending definitions.',
  'pending.policies.operating_with':
    ' — operating with: {value}',
  'pending.policies.no_default':
    ' — no default',
  'pending.policies.heading':
    'To define ({count})',
  'pending.policies.heading_note':
    ' — operating with defaults meanwhile',
  'pending.policies.define_hint':
    '→  mnemosine pending define <key> <value>',
  'pending.policies.label.impact':
    'impact',
  'pending.policies.label.why':
    'why I ask',
  'pending.policies.label.what':
    'what I do',
  'pending.policies.label.if_skipped':
    'if you skip it',
  'pending.policies.label.in_your_data':
    'in your data:',
  'pending.policies.label.why_default':
    'why that default',
  'pending.policies.already_defined':
    'Already defined',
  'pending.policies.dismissed_value':
    '(dismissed)',
  'pending.define.not_found':
    'There is no pending decision with key "{key}". List the open ones with: mnemosine pending',
  'pending.define.input_hint':
    '(number, free-form value, or empty to cancel)',
  'pending.define.cancelled':
    'Cancelled; still pending.',
  'pending.define.ambiguous':
    '"{typed}" is both option {typed} ({byPosition}) and the value {byValue}. Type p for option {typed}, v for the value {byValue}, or leave it empty to cancel.',
  'pending.define.done':
    '✔ {key} = {value}',
  'pending.define.remaining':
    '{count, plural, one {# definition} other {# definitions}} still pending.',
  'pending.dismiss.done':
    '✘ {key} dismissed.',
  'pending.reopen.done':
    '↻ {key} is pending again.',
  'policy_preview.threshold.intro':
    'Of your {count, plural, one {# received invoice} other {# received invoices}}:',
  'policy_preview.threshold.line':
    '  · with {threshold} → I would ask you {asked, plural, one {# time} other {# times}} ({pct})',
  'policy_preview.auto_post.intro':
    'Of the {total, plural, one {# draft} other {# drafts}} I have proposed so far:',
  'policy_preview.auto_post.counts':
    '  · {approved} you approved, {rejected} you rejected',
  'policy_preview.auto_post.rejected':
    '  · a rejection rate above zero is a reason to keep this off until it settles',
  'policy_preview.auto_post.track_record':
    '  · no rejections yet — a track record that supports turning it on',
  'policy_preview.auto_post.too_few':
    '  · too few yet to tell how often I would be right',
  'policy_preview.auto_post.shadow_some':
    '  · shadow: {verdicts, plural, one {# verdict} other {# verdicts}} over {days, plural, one {# day} other {# days}}, {decided} human-decided, agreement {agreement} (turning "on" requires at least {minDays} days, {minDecided} decided and {minAgreement} agreement)',
  'policy_preview.auto_post.shadow_none':
    '  · no shadow history yet: answer "shadow" first — "on" requires that evidence',
  'policy_preview.amounts.intro':
    'Your received invoices, by amount:',
  'policy_preview.amounts.half':
    '  · half are under {amount}',
  'policy_preview.amounts.nine_of_ten':
    '  · 9 out of 10 are under {amount}',
  'policy_preview.amounts.largest':
    '  · the largest was {amount}',
  'policy_preview.amounts.cap':
    '  · a cap of {cap} would cover {pct} of them',
  'policy_preview.inventory.some':
    'I see {count, plural, one {# posted movement} other {# posted movements}} in inventory accounts — you seem to keep them.',
  'policy_preview.inventory.none':
    'I see no movements in inventory accounts yet.',
  'policy_preview.restaurants.none':
    'No restaurant invoices in your history yet.',
  'policy_preview.restaurants.intro':
    '{count, plural, one {# restaurant invoice} other {# restaurant invoices}} for {total}:',
  'policy_preview.restaurants.deductible':
    '  · deductible ({rate}): {amount}',
  'policy_preview.restaurants.non_deductible':
    '  · non-deductible: {amount}',
  'policy_preview.efirma.none':
    'No e.firma accesses recorded yet.',
  'policy_preview.efirma.summary':
    '{count, plural, one {# access} other {# accesses}} counted toward the cap over {days, plural, one {# day} other {# days}} (~{perDay} per day).',
  'policy_preview.closed_period.some':
    '{count, plural, one {# invoice} other {# invoices}} in your history fall in already-closed periods.',
  'policy_preview.closed_period.none':
    'No invoices from closed periods so far.',
  // ==== end of pending.* and policy_preview.* ====================================

  // --- El kernel: confirmación y salida --------------------------------
  /** `src/cli/kernel/confirmacion.ts:76` (`noEntendi`, que ya la llama). El «y/s» del español
   *  es una gramática de DOS idiomas a la vez; en inglés sobra la mitad. */
  confirm_answer_not_understood:
    'did not understand “{answer}”: answer y or yes for yes, n or no for no',

  /** `src/cli/kernel/confirmacion.ts` (`yesNoPrompt`): the suffix of every yes/no
   *  prompt whose default is no. Written here once; no leaf writes it (#262). */
  confirm_yes_no_suffix: '[y/N]',

  /** The default-yes form (`yesNoPrompt(q, 'yes')`): the first-run prompt (#264). */
  confirm_yes_no_suffix_default_yes: '[Y/n]',

  /** `src/cli/batch-command.ts:268`, `src/cli/bank-command.ts:2010` y
   *  `src/cli/prepaid-command.ts:1072`. Tres copias idénticas: la prueba de que
   *  esto ya era una clave. */
  no_changes_ledger_untouched: 'No changes: the ledger was not touched.',

  /** `src/cli/batch-command.ts:269`, `src/cli/bank-command.ts:2011`. El aborto
   *  que NO es un fallo: sin terminal se nombra `-y` por su nombre. */
  no_changes_no_terminal:
    'No changes: there is no terminal to confirm at. Add -y so `{command}` runs ' +
    'without asking, or --dry-run to see the full effect without writing anything.',

  // --- Los ensayos, que dicen qué se deshizo ---------------------------
  /** `src/cli/bank-command.ts:3362` y `:3456`. «Se escribió de verdad» no es
   *  una floritura: el ensayo corre la escritura y la revierte, y un operador
   *  que crea que no se tocó la base no entiende por qué avanzó una secuencia. */
  dry_run_rolled_back: 'Dry run: it really was written, and then rolled back.',

  /** `src/cli/asset-command.ts:432`. */
  dry_run_no_asset_created: 'Dry run: the transaction was rolled back. No asset was created.',

  /** `src/cli/prepaid-command.ts:1060`. */
  dry_run_ledger_untouched: 'Dry run: the ledger was not touched and no row was written.',

  // --- Los tres `(s)` que el plural propio viene a jubilar -------------
  /** `src/cli/cfdi-command.ts:308`, hoy `${n} CFDI cancelado(s)`. */
  cfdi_cancelled_by_issuer:
    '{count, plural, one {# CFDI cancelled} other {# CFDIs cancelled}} by the issuer: ' +
    'check the accounting effect with cfdi list --json',

  /** `src/cli/diot-command.ts:743-744`, hoy `las ${n} verificación(es) pedidas`. */
  diot_checks_passed:
    'no findings: the DIOT passes {count, plural, one {the # check} other {the # checks}} requested.',

  /** `src/cli/diot-command.ts:752-753`, hoy `bloqueante(s), aviso(s)`. Dos
   *  cuentas en una frase, cada una con su propia rama. */
  diot_findings_summary:
    '{blocking, plural, one {# blocker} other {# blockers}}, ' +
    '{warnings, plural, one {# warning} other {# warnings}}. ' +
    'A blocker stops the return from being filed.',

  // --- El único `select` de la siembra ---------------------------------
  /** `src/cli/prepaid-command.ts:374-380`: cuatro llamadas a `omitido(...)`, una
   *  por causa. Eran cuatro cadenas sueltas en cuatro renglones; como `select`
   *  son UNA clave, y el día que aparezca una quinta causa el compilador no
   *  dirá nada pero la rama `other` sí, que para eso es obligatoria. */
  prepaid_row_skipped:
    '{reason, select, ' +
    'coverage_not_started {coverage has not started yet} ' +
    'coverage_ended {coverage already ended} ' +
    'zero_month_row {the row for this month is zero} ' +
    'no_balance_left {there is no balance left to accrue} ' +
    'other {there is nothing to accrue this month}}',

  // --- Prosa de listado ------------------------------------------------
  /** `src/cli/prepaid-command.ts:887`. */
  prepaid_no_live_schedule: 'No live schedule in this entity.',

  /** `src/cli/prepaid-command.ts:888`. `{date}` llega YA formateada: el
   *  formato de fecha lo fija la jurisdicción de la entidad, no este catálogo. */
  prepaid_no_schedule_covers_date: 'No schedule covers {date}. Use -a to list them all.',

  /** `src/cli/bank-command.ts:3428`. */
  bank_run_hit_cap:
    'The run hit its cap: some movements were left unevaluated. Run it again.',
  // ====================================================================
  // I7 · EL CROMO DEL CLI, EL KERNEL Y LAS HOJAS DE `mnemosine.ts`
  // (issue #149)
  //
  // Tres bloques, y conviene saber cuál es cuál antes de tocarlos:
  //
  //   · `cli.chrome.*` — lo que Commander 15 maqueta SOLO: los cinco títulos
  //     que `Help.styleTitle` recibe (`help.js:454`, `:478`, `:494`, `:507`,
  //     `:524`), la descripción de `-h, --help` y de `help [command]`
  //     (`command.js:422` y `:2591`, la misma frase, y por eso UNA sola clave)
  //     y la de `-V, --version` (`command.js:2213`).
  //   · `cli.error.*` — los mensajes que Commander escribe por
  //     `_outputConfiguration.outputError`. Se traducen por RECONOCIMIENTO del
  //     texto que él arma, y sólo los cinco de aquí: ver el porqué y el límite
  //     en `src/cli/kernel/help.ts`.
  //   · `cli.flag.*`, `cli.risk.*`, `cli.entity.*`, `cli.output.*`,
  //     `cli.exit.*` — las cadenas del kernel (`src/cli/kernel/**`).
  //   · `help.<familia>.<hoja>.description` — la descripción de cada hoja que
  //     `src/cli/mnemosine.ts` registra por su cuenta. Las demás familias
  //     viven en sus propios archivos y NO están aquí; su adopción es otro
  //     tramo, y decirlo es más útil que insinuar que ya están.
  //     Update (#314): families registered in their own files now adopt keys
  //     one per PR, each in its own block below (the first is `period`); the
  //     lane `help-descriptions-without-key` counts the families still pending.
  //
  // LAS DOS CARAS DE UNA DESCRIPCIÓN, Y POR QUÉ NO SON LA MISMA. Lo que se
  // guarda en el objeto de Commander (`Option.description`, `Command._description`)
  // sigue siendo el INGLÉS de estas claves, porque ese valor es superficie de
  // MÁQUINA: lo leen el censo de `scripts/ux-status.ts` (`prosaDe`, :467) y el
  // generador de `cli-reference.md`. Lo que se TRADUCE es el renderizado, en
  // `Help` — ver `src/cli/kernel/help.ts`. Una sola prosa, dos lectores.
  // ====================================================================

  // --- El cromo que Commander maqueta solo -----------------------------
  /** `node_modules/commander/lib/help.js:454`. */
  'cli.chrome.usage': 'Usage:',
  /** `help.js:478`. */
  'cli.chrome.arguments': 'Arguments:',
  /** `help.js:485` (el encabezado por omisión de un grupo de opciones). */
  'cli.chrome.options': 'Options:',
  /** `help.js:507`. */
  'cli.chrome.global_options': 'Global Options:',
  /** `help.js:515` (el encabezado por omisión de un grupo de comandos). */
  'cli.chrome.commands': 'Commands:',
  /** `command.js:422` y `command.js:2591`: la MISMA frase para `-h, --help` y
   *  para `help [command]`. Sale 389 veces en el árbol embarcado, una por
   *  nodo, y por eso es una clave y no dos. */
  'cli.chrome.help_description': 'display help for command',
  /** `command.js:2213`. */
  'cli.chrome.version_description': 'output the version number',

  // --- Los errores que Commander escribe por `outputError` -------------
  /** `command.js:2192`. */
  'cli.error.unknown_command': "error: unknown command '{name}'",
  /** `command.js:2147`. */
  'cli.error.unknown_option': "error: unknown option '{flag}'",
  /** `command.js:2047`. */
  'cli.error.missing_argument': "error: missing required argument '{name}'",
  /** `command.js:2059`. */
  'cli.error.option_missing_argument': "error: option '{flags}' argument missing",
  /** `command.js:2071`. */
  'cli.error.missing_mandatory_option': "error: required option '{flags}' not specified",
  /** El sufijo que Commander cuelga de los dos «unknown» (`command.js:2140`),
   *  y que `src/cli/mnemosine.ts` escribe también por su cuenta cuando la
   *  compuerta de la raíz ataja un tecleo antes de que Commander lo vea. */
  'cli.error.did_you_mean': '(Did you mean {suggestion}?)',
  /** `suggestSimilar.js:93`: la forma con empate. Va aparte y no como un
   *  `{suggestion}` con la lista dentro porque «one of» es prosa, y metida en
   *  el parámetro viajaría en inglés dentro de la frase española. */
  'cli.error.did_you_mean_one_of': '(Did you mean one of {suggestions}?)',

  // --- The machine error of a leaf asked for JSON (MNE-001-698) ---------
  /** `src/cli/kernel/error-envelope.ts`: the message of a failure of the
   *  driver or the system, whose raw text stays out of a machine error. */
  'cli.error.internal':
    'The command failed on an internal error (database, network or system); ' +
    'its details are not part of a machine error.',
  'cli.error.internal_remedy': 'Run the same command without --json to read the details.',

  // --- El diccionario de banderas (`src/cli/kernel/flags.ts`) ----------
  'cli.flag.entity': 'legal entity to operate on (defaults to the active one)',
  'cli.flag.tenant_scope': 'tenant (firm) whose data to scope to',
  'cli.flag.user': 'acting user, for attribution and permissions',
  'cli.flag.format': 'output format',
  'cli.flag.json': 'shorthand for --format json',
  'cli.flag.output': 'write to a file instead of stdout',
  'cli.flag.fields': 'comma-separated columns; with no value, lists the available ones',
  'cli.flag.quiet': 'identifiers only, one per line, for piping',
  'cli.flag.limit': 'maximum rows to return',
  'cli.flag.offset': 'skip this many rows',
  'cli.flag.status': 'filter by lifecycle state (repeatable)',
  'cli.flag.all': 'no default limit; include archived and closed',
  'cli.flag.period':
    'period selector: 2026-07, 2026-Q3, FY2026, last-month, 2026-01..2026-06',
  'cli.flag.since': 'inclusive lower bound (YYYY-MM-DD)',
  'cli.flag.until': 'inclusive upper bound (YYYY-MM-DD)',
  'cli.flag.as_of': 'valuation/balance date (YYYY-MM-DD)',
  'cli.flag.date_basis': 'which date the filters apply to',
  'cli.flag.strict': 'treat warnings as blocking (exit 4)',
  'cli.flag.force':
    'override a blocking validation (closed period, lock date, duplicate); requires --reason',
  'cli.flag.note': 'free annotation stored with the record',

  /** `src/cli/kernel/flags.ts:parsePositiveInt`. */
  'cli.flag.error_not_whole_number':
    '{name} must be a non-negative whole number; got "{value}".',
  /** `src/cli/web-command.ts:parsePort`. */
  'cli.flag.error_not_port': '{name} must be a port from 0 to 65535; got "{value}".',
  /** `src/cli/web-command.ts:parseOrigin` and `parseListenHost`. */
  'cli.flag.error_not_origin':
    '{name} must be an origin only, scheme, host and port, with no path; got "{value}".',
  'cli.flag.error_empty': '{name} cannot be empty.',
  /** `src/cli/kernel/flags.ts:parseDate`. */
  'cli.flag.error_not_date': '{name} must be a date as YYYY-MM-DD; got "{value}".',

  // --- Las banderas que inyecta la declaración de riesgo (risk.ts) -----
  'cli.flag.dry_run':
    'compute and show the full effect; write nothing and call nothing external',
  'cli.flag.yes': 'skip the confirmation prompt',
  'cli.flag.idempotency_key':
    'client dedupe key, stored on success: a retry with the same key and payload returns ' +
    'the recorded result',
  /** La bandera que se acepta y NO se honra: la hoja lo dice en su ayuda en
   *  vez de fingir. `src/cli/kernel/risk.ts`. */
  'cli.flag.idempotency_key_unhonored':
    'NOT honored by this command yet: a retry writes again instead of returning the ' +
    'recorded result',
  /** La que no hace falta porque el dominio ya deduplica. */
  'cli.flag.idempotency_key_unneeded':
    'not needed: this command already deduplicates on the state it writes; accepted and ignored',
  'cli.flag.live': 'perform the real external effect (default is the sandbox endpoint)',
  'cli.flag.reason': 'justification recorded in the audit trail (required)',

  // --- La compuerta de mutación (`src/cli/kernel/risk.ts`) -------------
  /** El `{command}` es la RUTA de la hoja, no su nombre suelto: hay más de un
   *  `apply` en el árbol. */
  'cli.risk.key_not_honored':
    '"{command}" accepts --idempotency-key because its risk class demands it, but DOES NOT ' +
    'HONOR IT YET: {reason}. The key "{key}" would deduplicate nothing: a retry would write ' +
    'again. Run it again WITHOUT the key after checking the state of the domain it touches ' +
    '(the document, the balance or the entry), or repeat it with --dry-run to see what it would do.',
  'cli.risk.undeclared':
    '"{command}" asks for a mutation gate without having declared its risk. Every leaf that ' +
    'mutates declares with `declareRisk` next to its registration; with no declaration there ' +
    'is no confirmation, no dry run, and no audit trail to speak of.',
  'cli.risk.force_needs_reason':
    '--force overrides a safety rule, so it requires --reason "<why>". The reason is written ' +
    'to the audit trail.',
  'cli.risk.undo_needs_reason':
    '"{command}" undoes or overrides something, so it requires --reason "<why>".',
  /** `src/cli/kernel/riesgos-retrofit.ts`, dentro del `preAction` que la tabla
   *  engancha. Es el ÚNICO texto de ese archivo que sale por pantalla: sus
   *  `writes` no los imprime nadie y por eso están en inglés ahí mismo, no
   *  aquí. `{flags}` llega ya unido con comas — una conjunción es gramática y
   *  no cabe en un `join` del sitio de llamada. */
  'cli.risk.gate_flags_not_honored':
    '"{command}" accepts {flags} but its handler does not honor them yet: it would really run ' +
    'while the flag promises the opposite. It is refused instead of pretending. (The flag ' +
    'exists because the risk class demands it; wiring the handler is CLI-F2 work.)',

  // --- La entidad activa (`src/cli/kernel/entity-context.ts`) ----------
  /** Dos causas, dos remedios opuestos: `entity use` NECESITA la base, así que
   *  ofrecerlo ante una conexión caída manda al usuario a otro fallo igual. */
  'cli.entity.database_unreachable':
    'Could not reach the database while resolving the active entity ({entity}): {detail}',
  'cli.entity.database_unreachable_remedy':
    'mnemosine doctor   (and check DATABASE_URL in .env)',
  'cli.entity.pinned_unresolved': 'The pinned entity ({entity}) could not be resolved: {detail}',
  'cli.entity.pinned_unresolved_remedy':
    'mnemosine entity use <id|name>   (or `mnemosine entity unset` to clear it)',
  /** Se dice en las dos ramas: el pin NO se borra por un fallo al resolverlo. */
  'cli.entity.pin_was_kept': 'The pinned entity was kept.',
  'cli.entity.must_be_named':
    'This command changes data, so it will not guess the entity. Name it with ' +
    '--entity <id|name> or pin one with `mnemosine entity use`.',

  // --- El renderizador (`src/cli/kernel/output.ts`) --------------------
  'cli.output.unknown_format': 'Unknown --format "{value}". Use one of: {formats}.',
  'cli.output.unknown_fields': 'Unknown field(s): {unknown}. Available: {available}.',

  // --- La salida (`src/cli/kernel/exit.ts`) ----------------------------
  /** El aborto por decisión del usuario, que NO es un fallo. */
  'cli.exit.aborted': 'Aborted.',

  // --- La raíz y sus dos banderas globales -----------------------------
  'help.root.description': 'AI accounting assistant — converse with your accounting from the terminal',
  'cli.flag.tenant_root':
    'Tenant to operate on. Precedence: this flag > MNEMOSINE_TENANT > mnemosine.config.json. ' +
    'Scopes EVERY query via RLS',
  /** Los escalones se nombran con parámetros y no a mano: la lista de locales
   *  y los nombres de las variables viven en `src/i18n/locale.ts` y una copia
   *  escrita aquí se desincronizaría en silencio. */
  'cli.flag.locale':
    'Language and formatting of what is PRINTED ({locales}). Precedence: this flag > {envVar} ' +
    '({envAlias} is a permanent alias) > ~/.mnemosine/config.json > ./mnemosine.config.json > ' +
    'the tenant setting > {fallback}. Never changes what is filed with an authority',

  // --- Las hojas que `src/cli/mnemosine.ts` registra por su cuenta ------
  'help.entities.description':
    'Lists the active legal entities (deprecated: use `mnemosine entity list`)',
  'help.providers.description':
    'Lists the configured model providers (built-in + mnemosine.config.json)',
  'help.ask.description': 'Asks a single question and exits',
  'help.chat.description': 'Opens an interactive chat session (default)',
  'help.sessions.description':
    'Lists recent chat sessions (resume one with: mnemosine chat --resume <id>)',
  'help.drafts.description': 'Lists the journal entry drafts created by the AI',
  'help.review.description':
    'Reviews pending drafts: approve (creates and posts the journal entry), correct then ' +
    'approve, or reject — a rejection can seed the criterion for next time',
  /** `src/cli/mnemosine.ts` renderDraft: a draft linked to a received CFDI (#318). The issuer name comes from the XML. */
  'review.draft.bill_to_be_born':
    'Approving creates the vendor bill of CFDI {uuid} · issuer {issuer} ({rfc}) · method {method} · total {total}',
  /** `src/cli/mnemosine.ts` renderDraft: a draft linked to a CFDI the entity issued (#320). The customer name comes from the XML. */
  'review.draft.invoice_to_be_born':
    'Approving creates the customer invoice of issued CFDI {uuid} · customer {customer} ({rfc}) · method {method} · total {total}',
  /** `src/cli/mnemosine.ts` review: `proveedor_desconocido_al_aprobar = preguntar` (#318). The name comes from the XML. */
  'review.vendor.register_prompt': 'Register vendor {name} (RFC {rfc})?',
  /** `src/cli/mnemosine.ts` review: the reviewer answered no to registering the vendor. */
  'review.vendor.not_registered': 'The vendor was not registered: nothing was posted and the draft stays pending.',
  'help.ingest.argument.files':
    'Paths to CFDI XML files; with --kind zip or metadata, the ZIP or metadata files downloaded from the SAT',
  'help.ingest.option.kind':
    'What the files are: xml (CFDI one by one), zip (a SAT package of CFDI XML: loads the census and ingests ' +
    'each XML) or metadata (the SAT `~` metadata file, bare or zipped: loads the census only)',
  // MNE-001-143 (#440): `src/cli/sat-download-commands.ts`, the bulk download of CFDI from the SAT.
  'help.sat.download.option.entity': 'Legal entity',
  'help.sat.download.option.user': 'Who acts (default: the sole active user)',
  'help.sat.download.option.json': 'Machine-readable output',
  'help.sat.download.option.format': 'Output format: table or json',
  'help.sat.download.argument.id': 'Download request: its local id or the id the SAT gave it',
  'help.sat.download.create.description':
    "Asks the SAT for a period's CFDI (refuses before calling when the lifetime XML limit is spent)",
  'help.sat.download.create.option.since': 'First day, YYYY-MM-DD',
  'help.sat.download.create.option.until': 'Last day, YYYY-MM-DD',
  'help.sat.download.create.option.direction': 'issued or received',
  'help.sat.download.create.option.kind':
    'metadata or xml (xml spends one of the 2 lifetime requests of the period)',
  'help.sat.download.check.description':
    'Asks the SAT for the state of a request and records it and its package ids (5004 is success with zero rows)',
  'help.sat.download.check.option.wait': 'Keep asking until the request is no longer open',
  'help.sat.download.check.option.timeout': 'Give up waiting after this many seconds',
  'help.sat.download.check.option.strict': 'Exit non-zero unless the request finished with packages',
  'help.sat.download.status.description':
    'Last known state of a request, read from the local mirror (does not call the SAT)',
  'help.sat.download.list.description': "The entity's download requests with their state, CFDI count and packages",
  'help.sat.download.list.option.status': 'Only this state',
  'help.sat.download.list.option.since': 'Only requests whose period ends on or after this day, YYYY-MM-DD',
  'help.sat.download.list.option.limit': 'How many to show',
  'help.sat.package.description': 'Packages of a finished download request',
  'help.sat.package.download.description':
    'Downloads the packages of a finished request, archives each ZIP by bytes, and with --import loads them',
  'help.sat.package.download.option.output': 'Also write each ZIP into this directory',
  'help.sat.package.download.option.package': 'Only this package of the request',
  'help.sat.package.download.option.import':
    'Load the census and run the XML through the regular ingestion (import_source sat_download)',
  'help.sat.quota.description': "The SAT's lifetime limit on identical XML requests",
  'help.sat.quota.show.description':
    'Which periods have their 2 lifetime XML requests spent and which have some left (reads the local counter)',
  'help.sat.quota.show.option.since': 'Periods ending on or after this day, YYYY-MM-DD',
  'help.sat.quota.show.option.until': 'Periods starting on or before this day, YYYY-MM-DD',
  // MNE-001-143 (#440): the runtime messages of `src/cli/sat-download-commands.ts`, by key.
  'sat.dl.bad_day':
    '{flag} must be a day, YYYY-MM-DD (got "{value}")',
  'sat.dl.bad_format':
    '--format must be table or json (got "{value}")',
  'sat.dl.bad_positive':
    '{flag} must be a whole number greater than 0 (got "{value}")',
  'sat.dl.bad_direction':
    '--direction must be issued or received (got "{value}")',
  'sat.dl.bad_kind':
    '--kind must be metadata or xml (got "{value}")',
  'sat.dl.since_after_until':
    '--since must be before --until',
  'sat.dl.request_not_found':
    'Download request {id} not found for this entity',
  'sat.dl.describe':
    '{id} · {direction} {kind} {from}..{to} · {status}{count}{packages}{error}',
  'sat.dl.describe.count':
    ' · {n} CFDI',
  'sat.dl.describe.packages':
    ' · {archived}/{total} package(s) archived',
  'sat.dl.create.plan':
    '{direction} {kind} {start}..{end} for {entity} ({rfc})',
  'sat.dl.create.plan_left':
    ' · lifetime XML requests left for this period by this entity\'s own counter: {n} (the SAT counts per RFC and parameters: another entity or firm may already have spent it)',
  'sat.dl.create.would':
    'Would ask the SAT for {plan}',
  'sat.dl.create.not_sent':
    'Not sent: {plan}',
  'sat.dl.create.spent':
    'The lifetime limit of this period is spent: a real run refuses before calling the SAT.',
  'sat.dl.create.dry_note':
    '(dry-run: nothing was written and the SAT was not called)',
  'sat.dl.create.live_note':
    'Asking the SAT uses the e.firma and is opt-in: re-run with --live.',
  'sat.dl.create.confirm':
    'This spends one of the {limit} lifetime XML requests of the period ({plan}). Type "yes": ',
  'sat.dl.create.cancelled':
    'Cancelled. Nothing was requested.',
  'sat.dl.create.done':
    '{repeat}{mark} request {id} · {status}{error}',
  'sat.dl.create.repeat':
    'Already requested with this key: ',
  'sat.dl.create.follow':
    'Follow it with: mnemosine sat download check {id} --live',
  'sat.dl.check.would':
    'Would ask the SAT about {request}',
  'sat.dl.check.not_asked':
    'Not asked: the SAT about {request}',
  'sat.dl.check.dry_note':
    '(dry-run: the SAT was not called)',
  'sat.dl.check.live_note':
    'Asking the SAT uses the e.firma: re-run with --live.',
  'sat.dl.check.rate_limit':
    'Stopped after {polls} ask(s): the daily limit of e.firma accesses is reached (0 left in this 24 h window). Every ask uses one, and downloading the packages needs some too: wait for the window to free up and run check --live again (packages expire 72 h after they are ready).',
  'sat.dl.check.budget':
    'Stopped after {polls} ask(s) to keep e.firma accesses for the package download. Run check --live again later.',
  'sat.dl.check.timeout':
    'Gave up waiting after {polls} ask(s); the request is still open. Run check --live again later.',
  'sat.dl.list.empty':
    'No download requests.',
  'sat.dl.quota.empty':
    'No XML requests counted. Metadata requests are not limited.',
  'sat.dl.quota.spent':
    '✘ spent (unrecoverable)',
  'sat.dl.quota.left':
    '· {n} left',
  'sat.dl.quota.line':
    '{state} · {direction} {from}..{to} · {made}/{limit} used',
  'sat.dl.package.no_data':
    'The SAT answered that this request has no data: there is nothing to download.',
  'sat.dl.package.rejected':
    'The SAT rejected this request: there are no packages. Fix the parameters and request again.',
  'sat.dl.package.expired':
    'This request expired at the SAT (packages last 72 h): request it again.',
  'sat.dl.package.open':
    'Request {id} is {status}: it has no packages yet. Run: mnemosine sat download check {id} --live',
  'sat.dl.package.failed':
    'Request {id} is {status}: it has no packages; see its state with `sat download status`.',
  'sat.dl.package.no_such':
    'Request {id} has no package {package}',
  'sat.dl.package.would':
    '{lead} {missing} of {total} package(s); {kept} already archived{import}.',
  'sat.dl.package.would_lead':
    'Would download',
  'sat.dl.package.not_lead':
    'Not downloaded:',
  'sat.dl.package.then_import':
    '; then load them with the ingestion',
  'sat.dl.package.dry_note':
    '(dry-run: the SAT was not called and nothing was written)',
  'sat.dl.package.live_note':
    'Downloading uses the e.firma and is opt-in: re-run with --live. Packages expire at the SAT 72 h after they are ready.',
  'sat.dl.package.archived':
    '✔ {id} · {bytes} bytes · sha256 {sha} · {where}',
  'sat.dl.package.where_archive':
    'already archived',
  'sat.dl.package.where_new':
    'archived',
  'sat.dl.package.output_written':
    '  wrote {file}',
  'sat.dl.package.output_same':
    '  {file} already holds these bytes',
  'sat.dl.package.output_differs':
    '{file} already exists with other bytes: it was not overwritten',
  'sat.dl.ingest.line':
    '  ingest: {counts}',
  'sat.dl.ingest.nothing':
    'nothing',
  'sat.dl.ingest.to_code':
    '{n} left in the inbox to code (no model provider, or it needs a decision)',
  // MNE-001-096 (#312): `src/cli/ingest-census.ts`, the SAT census loaded by `ingest --kind zip|metadata`.
  'ingest.census.bad_kind': 'expected one of {valid}',
  'ingest.census.flag_not_for_metadata':
    '{flags}: does not apply to --kind metadata, which loads the census only and ingests nothing',
  'ingest.census.no_rfc': 'The entity has no RFC: the census cannot tell issued from received.',
  'ingest.census.not_zip': '{file} is not a ZIP file.',
  'ingest.census.bad_zip': '{file}: the ZIP cannot be read ({detail}).',
  'ingest.census.not_metadata': '{file}: not a SAT metadata file (missing column(s) {columns}).',
  'ingest.census.invalid.field_count': '{found} fields, the header has {expected}',
  'ingest.census.invalid.status': 'Estatus «{value}» is neither 1 nor 0',
  'ingest.census.invalid.field': 'invalid {field}',
  'ingest.census.invalid.xml': 'not a readable CFDI ({detail})',
  'ingest.census.title': 'SAT census ({kind})',
  'ingest.census.summary': '{total} CFDI ({issued} issued, {received} received)',
  'ingest.census.by_month': 'by month: {months}',
  'ingest.census.completeness':
    '{counted} count toward completeness under {key} ({types}); {others} of other types are kept in the census',
  'ingest.census.counts': "{foreign} not this entity's · {invalid} invalid",
  'ingest.census.more_invalid': '… and {count} more',
  'ingest.census.loaded': 'Census loaded from {file}: {inserted} new, {refreshed} already known.',
  'ingest.census.dry_run': '(dry-run: the census was read, not loaded.)',
  // MNE-001-144 (#441): the SAT's cancellations of the census reach the mirror and the invoice;
  // MNE-001-431 (#643): and the bill.
  'ingest.census.marks':
    'Cancelled by the SAT: {mirror, plural, one {# CFDI} other {# CFDI}} marked in the mirror, ' +
    '{invoices, plural, one {# invoice} other {# invoices}} marked cancelled, ' +
    '{bills, plural, one {# bill} other {# bills}} marked.',
  'ingest.census.cancelled_booked':
    '{document} ({date}) carries CFDI {uuid}, which the SAT reports cancelled. Nothing was reversed: ' +
    'its status, entry and balance stay until the accountant decides.',
  'ingest.census.document.invoice': 'Invoice {number}',
  'ingest.census.document.credit_note': 'Credit note {number}',
  'ingest.census.document.bill': 'Bill {number}',
  'help.ingest.description':
    'Batch ingestion of CFDIs (XML): rules → AI classification → drafts (or auto-post by thresholds)',
  'help.lang.description':
    "Shows or sets your language: the CLI and the agent's answers (Spanish command aliases always work)",
  'help.onboard.description':
    "Imports a client's accounting from an external system (chart of accounts + opening balances)",
  'help.outbox.description':
    'Operations queued for external accounting systems: list, review and execute',
  'help.outbox.list.description': 'List queued external operations (default: pending)',
  'help.outbox.run.description':
    "Execute queued operations against the client's external system (the real effect requires --live)",
  'help.question.description':
    "The agent's pending questions: list, answer (saved as a precedent) or dismiss",
  'help.question.list.description': "List the agent's questions (default: pending)",
  'help.question.answer.description':
    'Answer a question (the answer is saved as a precedent), or work the pending queue',
  'help.login.description': 'Signs in with your identity provider (OIDC)',
  'help.logout.description': 'Deletes the stored credential',
  'help.whoami.description': 'Shows the active credential and its validity',
  'help.subscription.description':
    'Outbound event subscriptions: who we notify, and what we could not deliver',

  // --- W0 · `src/cli/web-command.ts`, the web gateway's operator entry ---
  'help.web.description': 'The browser board: a read-only gateway in front of the API',
  'help.web.start.description':
    'Starts the web gateway, which holds the browser session and relays reads to /v1; runs until ' +
    'Ctrl+C (production runs node dist/gateway/main.js instead)',
  'help.web.start.port': 'Port to listen on (default: GATEWAY_PORT, else 8080)',
  'help.web.start.host': 'Address to listen on (default: GATEWAY_HOST, else 127.0.0.1)',
  'help.web.start.api_url': 'Origin of the API it relays to (default: GATEWAY_API_URL)',
  'help.web.start.public_origin':
    'Origin the browser opens, which the gateway answers under (default: GATEWAY_PUBLIC_ORIGIN)',
  'web.start.listening': 'Open {origin} in a browser. Ctrl+C stops the gateway.',

  // ==== I7 · EL PILOTO: `src/cli/bank-command.ts` (issue #149) =====

  // Las cadenas que `bank`/`banco` imprime PARA UNA PERSONA. Lo que NO está
  // aquí, y se decidió midiendo (ver el informe de I7): `declareRisk({ writes })`
  // —19 literales, contados con `grep -c 'writes:' src/cli/bank-command.ts`—
  // porque ningún archivo de `src/` ni de `scripts/` lo imprime, sólo lo
  // afirman pruebas; los nombres de columna y la lista de `--fields`,
  // que son el contrato de `--json`; los alias españoles de comando, que D9 R8
  // manda conservar; y los bloques de `EJEMPLOS`, congelados por
  // `src/ai/docs/cli-reference.md`.
  // --- Los analizadores de bandera: uso (2), no validación (4) ---------
  'receipt.withholding.unreadable':
    'Cannot read the withholding "{spec}": write "isr:1000" or "iva:1066.67", and with several invoices put the invoice first ("INV-2026-00042:isr:1000").',
  'receipt.withholding.which_invoice':
    'With several invoices, the withholding "{spec}" has to say which one it belongs to ("INV-2026-00042:{spec}").',
  'receipt.withholding.not_applied':
    'The withholding "{spec}" names {invoice}, which is not one of the --invoice of this application.',
  'receipt.withholding.negative': 'A withholding cannot be negative ({amount}).',
  'receipt.withholding.cash_required':
    'The cash applied to {invoice} must be greater than zero (got {amount}): a withholding rides on a cash application, it is never applied alone.',
  'receipt.withholding.exceeds_due':
    '{invoice} owes {due} and {settled} would be applied ({cash} collected + {withheld} withheld).',
  'receipt.withholding.vat_cap': '{invoice} transfers {cap} of VAT: the customer cannot withhold more than that.',
  'receipt.withholding.isr_cap': '{invoice} has a subtotal of {cap}: the ISR withheld cannot exceed it.',
  'receipt.withholding.booked_at_issuance':
    '{invoice} already booked the customer\'s withholding ({amount}) when it was issued: its receivable is the net the customer pays. Apply only the cash; --withholding is for invoices whose receivable was booked gross.',
  // MNE-001-572 (#789): a held cheque's advance is not applied against IVA nobody has caused.
  'receipt.apply.cheque_advance_not_cashed':
    'The receipt {receipt} is a cheque the bank has not cashed, and applying it to {invoice} would cancel {iva} of its advance\'s IVA, which is not caused until the cashing (LIVA art. 1-B, second paragraph). Record the cashing first with `mnemosine bank check reconcile --receipt {receipt}`, then apply it; the panel key {key} governs this. Nothing was written.',
  'receipt.apply.cheque_advance_deferral_ppd_only':
    'The panel key {key} says defer_to_cashing, which nets the advance\'s IVA against the share a PPD invoice releases on the cashing day. {invoice} is a PUE invoice at another treatment than the receipt {receipt}: it releases no share, and applying it now would cancel {iva} of IVA nobody has caused (LIVA art. 1-B, second paragraph). Record the cashing first with `mnemosine bank check reconcile --receipt {receipt}`, then apply it. Nothing was written.',
  'receipt.unapply.iva_at_cashing':
    'The {iva} of IVA this cash carries back on account is caused the day the bank cashes the cheque (LIVA art. 1-B, second paragraph): recording that cashing with bank check reconcile --receipt posts it.',
  // MNE-001-574 (#792): a plain receipt's unapply keeps the IVA its collection caused.
  'receipt.unapply.iva_kept': 'IVA kept caused {iva} (LIVA art. 1-B)',
  // MNE-001-585 (#792): under repark_same_month a row released in an earlier month keeps its IVA caused.
  'receipt.unapply.iva_kept_later_month':
    'IVA kept caused {iva} (LIVA art. 1-B): {key} re-parks only in the month the IVA was released, and it was released before {month}, in a month that may already be declared',
  'receipt.apply.other_customer':
    '{invoice} belongs to customer {invoiceCustomer}, and collection {receipt} belongs to customer {receiptCustomer}: cash on account settles only invoices of its own customer. Record the collection under {invoiceCustomer}, or apply {receipt} to an invoice of {receiptCustomer}.',
  // MNE-001-460 (#623): an application and an unapply are dated.
  'receipt.apply.date_future':
    '{receipt} cannot be applied on {date}: that is after today ({today}) in the entity\'s time zone. Nothing was applied.',
  'receipt.unapply.date_future':
    '{receipt} cannot be unapplied on {date}: that is after today ({today}) in the entity\'s time zone. Nothing was unapplied.',
  'receipt.apply.date_before_last_event':
    '{receipt} was last posted on {since}: an application dated {date} would apply its cash before that happened. Date it {since} or later. Nothing was applied.',
  // MNE-001-779: `since` cannot see a cashing that posted no entry, the cash being still on account.
  'receipt.apply.date_before_cashing':
    'The bank cashed the cheque of {receipt} on {cashedOn}: an application dated {date} would apply its cash, and cause the IVA it collects, before the cheque was paid. Date it {cashedOn} or later. Nothing was applied.',
  'receipt.unapply.date_before_last_event':
    '{receipt} was last posted on {since}: an unapply dated {date} would undo it before it happened. Date it {since} or later. Nothing was unapplied.',
  'receipt.apply.date_before_invoice':
    '{invoice} is dated {invoiceDate}: cash applied on {date} would settle it before the sale existed. Date the application {invoiceDate} or later. Nothing was applied.',
  'credit_note.advance.exceeds_invoiced_advance':
    'Credit note {note} applies an advance of {requested}, and customer {customer} has {available} in advance invoices not yet applied. Nothing was posted. Cash on account is applied with `receipt apply`; an advance booked by a journal entry is applied by a journal entry.',
  // MNE-001-489 (#692): why a received credit note waits for a person.
  'credit_note.received.refusal.not_received': 'CFDI {note} is from {issuer} to {receiver}: the entity is not its receiver. Only a credit note a vendor issued to the entity is posted against a bill.',
  'credit_note.received.refusal.not_credit_note': 'CFDI {note} is type {type} with TipoRelacion {relation}. Only a type E with TipoRelacion 01 (credit note) or 03 (return) is posted against a bill.',
  'credit_note.received.refusal.note_foreign_currency': 'Credit note {note} is in {currency}. A received credit note is posted only when it and its bill are in the entity\'s currency; this one waits for a person.',
  'credit_note.received.refusal.other_taxes': 'Credit note {note} carries a tax other than transferred VAT (IEPS, a local tax or a withholding). It waits for a person.',
  'credit_note.received.refusal.related_bills': 'Credit note {note} has to name exactly one bill of this entity among its related CFDI, and it names {count}.',
  'credit_note.received.refusal.bill_foreign_currency': 'Bill {bill} is in {currency}. Credit note {note} is posted only when it and its bill are in the entity\'s currency; it waits for a person.',
  'credit_note.received.refusal.other_vendor': 'Credit note {note} was issued by {issuer}, and bill {bill} belongs to vendor {vendor}. A credit note lowers only a bill of its own issuer.',
  'credit_note.received.refusal.bill_not_payable': 'Bill {bill} is "{status}". Credit note {note} is posted only against a bill that is {payable}.',
  'credit_note.received.refusal.release_not_recorded': 'A payment applied to bill {bill} did not record the VAT it released, so what the bill still has in pending VAT cannot be known. Credit note {note} waits for a person.',
  'credit_note.received.refusal.exceeds_balance': 'Credit note {note} is for {total} and bill {bill} owes {due}. A credit note larger than the balance of its bill is not posted.',
  'credit_note.received.refusal.vat_out_of_proportion': 'Credit note {note} carries {vat} of VAT, and in the proportion of bill {bill} it would carry {expected}. A bill with more than one VAT rate does not say which part the note lowers; it waits for a person.',
  'credit_note.received.refusal.capitalised_line': 'Bill {bill} has a line on an account with the role {role}. Credit note {note} would lower an asset and not an expense; it waits for a person.',
  'credit_note.received.closed_period': 'Credit note {note} is dated {date}, in a period that is closed. It waits until the closed-period policy is answered: mnemosine pending define cfdi_periodo_cerrado periodo_actual',
  'payment.apply.other_vendor':
    '{bill} belongs to vendor {billVendor}, and payment {payment} belongs to vendor {paymentVendor}: cash on account settles only bills of its own vendor. Record the payment under {billVendor}, or apply {payment} to a bill of {paymentVendor}.',
  // MNE-001-678 (#787): a vendor application is dated.
  'payment.apply.date_future':
    '{payment} cannot be applied on {date}: that is after today ({today}) in the entity\'s time zone. Nothing was applied.',
  'payment.apply.date_before_last_event':
    '{payment} was last posted on {since}: an application dated {date} would apply its cash before that happened. Date it {since} or later. Nothing was applied.',
  // MNE-001-746: `since` cannot see a cashing that posted no entry, the cash being still on account.
  'payment.apply.date_before_cashing':
    'The bank cashed the cheque of {payment} on {cashedOn}: an application dated {date} would apply its cash, and credit the VAT it pays, before the cheque was paid. Date it {cashedOn} or later. Nothing was applied.',
  'payment.apply.date_before_bill':
    '{bill} is dated {billDate}: cash applied on {date} would settle it before the bill existed. Date the application {billDate} or later. Nothing was applied.',
  'payment.apply.date_period_closed':
    '{payment} cannot be applied on {date}: that day has no open fiscal period (it is hard-closed, locked or was never opened). Date the application in an open period. Nothing was applied.',
  // MNE-001-458 (#623): a customer advance recorded with its IVA treatment.
  'receipt.advance.treatment_unknown':
    'The IVA treatment "{value}" of an advance is not known: state one of {allowed}.',
  // MNE-001-462 (#623): the excess of a collection left on account is an advance.
  'receipt.advance.tax_rate_needs_on_account':
    'With an invoice, --tax-rate states the treatment of the excess a collection leaves on account, so it goes with --on-account. Without it the cash only settles the invoice. Nothing was recorded.',
  'receipt.advance.nothing_on_account':
    'A treatment was stated for the cash this receipt of {amount} leaves on account, and it leaves none: it applies all of it to invoices. Drop --tax-rate, or record the amount that exceeds what they owe. Nothing was recorded.',
  'receipt.excess.from': 'rate of {invoices}',
  'receipt.excess.from_highest': 'rate of {invoices}: it carries several, and the highest is assumed; --tax-rate states another',
  'receipt.excess.from_exempt': 'rate of {invoices}: none of its treatments carries IVA, and exempt is assumed; --tax-rate states another',
  'receipt.advance.not_mexican_books':
    'This entity does not keep Mexican books, so an advance takes no IVA treatment: record it without one and the whole amount goes to its customer advances account.',
  'receipt.advance.cheque_held':
    'Received by cheque, its IVA of {iva} is caused the day the bank cashes it (LIVA art. 1-B, second paragraph): until then the whole amount waits in customer advances, and recording the cashing with bank check reconcile --receipt moves the IVA to IVA charged on that day.',
  // MNE-001-421 (#623): the advance from the terminal.
  'receipt.advance.needs_customer':
    'Name the invoice this cash settles, or the customer who paid it with --customer: with no invoice it is recorded as an advance.',
  'receipt.advance.rate_required':
    'An advance with no invoice causes its IVA when it is collected (LIVA art. 1-B), and the rate of a sale that has not happened is a fact you state, never a default: add --tax-rate 16, 8, 0, exempt or not-subject. Nothing was recorded.',
  'receipt.advance.figures': 'base {base}, IVA {iva}, rate {rate}',
  'receipt.advance.label': 'Advance',
  'receipt.cheque.cashed_label': 'Cheque cashed',
  'receipt.cheque.cashed': '{date} · bank transaction {transaction}',
  'receipt.cheque.not_cashed': 'not recorded yet (`bank check reconcile --receipt`)',
  'receipt.advance.confirm':
    'Record {amount} received from {customer} as an advance with no invoice{figures} in {entity}? This posts to the ledger.',
  // MNE-001-509 (#701): a reversed receipt says what happened to the money.
  'receipt.reverse.cause_unknown':
    'The cause "{value}" of a reversal is not known: state not_collected (the money never became yours) or taken_back (it arrived and was taken back). Nothing was written.',
  'receipt.reverse.warning.card_not_collected':
    'This receipt was paid by card, and a card is paid when it is accepted (LIVA art. 1-B): not_collected says the money never became yours. If it arrived and the bank took it back, as in a chargeback, the cause is taken_back.',
  'receipt.reverse.warning.cause_not_stated':
    'No cause is stated, and only a cheque has one by default: the IVA of this receipt stays in the month it was collected until a cause is stated (not_collected or taken_back) with `receipt cause record`.',
  'receipt.reverse.cause.stated': 'cause {cause}',
  'receipt.reverse.cause.defaulted':
    'cause not_collected, taken by default: a cheque is paid the day the bank cashes it',
  'receipt.reverse.cause.none': 'no cause stated',
  // MNE-001-511 (#701): the cause of a receipt reversed with none, stated afterwards.
  'receipt.cause.not_reversed':
    'The receipt {number} is "{status}": a cause is stated only for a reversed receipt. Nothing was written.',
  'receipt.cause.balance_transfer':
    'The receipt {number} is a transfer of customer credit: it moved no money, so its reversal has no cause to state. Nothing was written.',
  'receipt.cause.none_for_transfer': 'none: a transfer of customer credit moved no money',
  'receipt.cause.already_stated':
    'The receipt {number} already has its cause, {cause}, stated at {stated_at}: a stated cause is not overwritten. Nothing was written.',
  'receipt.cause.reason_required':
    'Stating the cause of a reversal requires --reason "<why>": it is written to the audit trail.',
  'receipt.cause.would_state': 'Would state the cause {cause} for the reversal of {number}',
  'receipt.cause.confirm':
    'State {cause} as the cause of the reversal of {number}? It is written once and cannot be corrected; nothing posts to the ledger.',
  'receipt.cause.stated': '{number}: cause {cause}, stated at {stated_at}; nothing was posted',
  // MNE-001-605 (#809): the live allocation a reversed receipt still has, closed by a person.
  'receipt.allocation.close.not_reversed':
    'The receipt {number} is "{status}": only the live allocation of a reversed receipt is closed this way, because only a reversal already reopened its invoice. Nothing was written.',
  'receipt.allocation.close.nothing_live':
    'The receipt {number} has no live allocation on {invoice}: there is nothing to close. Nothing was written.',
  'receipt.allocation.close.after_reversal':
    'The live allocation of {number} on {invoice} was written after the receipt was reversed, so the reversal never reopened the invoice for it: closing it alone would leave the invoice short. Report it. Nothing was written.',
  'receipt.allocation.close.would_close':
    'Would close {count} live allocation(s) of {number} on {invoice}, {amount}, dated at the reversal ({closed_at}); nothing posts and the invoice is not touched',
  'receipt.allocation.close.confirm':
    'Close {count} live allocation(s) of the reversed receipt {number} on {invoice} ({amount})? The reversal already reopened the invoice and mirrored its entries; this only closes the row, dated at the reversal, and posts nothing. It cannot be undone.',
  'receipt.allocation.close.closed':
    '{number}: {count} allocation(s) on {invoice} closed ({amount}), dated at the reversal ({closed_at}); nothing was posted',
  'receipt.allocation.close.dry_run': 'Dry run: the close really ran and was rolled back; nothing was written.',
  'receipt.allocation.close.key_unneeded': 'a repeat finds no live allocation on that invoice and is refused',
  // MNE-001-498 (#695): a customer's cash on account, transferred to another customer.
  'receipt.transfer.reason_required':
    'Transferring a customer\'s credit requires --reason "<the agreement>": it is written to the audit trail and on the transfer. Nothing was written.',
  'receipt.transfer.amount_invalid':
    'The amount "{amount}" of a transfer must be greater than zero, with at most 4 decimals. Nothing was written.',
  'receipt.transfer.not_mexican_books':
    'This entity does not keep Mexican books: a transfer of customer credit is built for them (its IVA is caused when the credit settles an invoice, LIVA art. 1o.-B). Nothing was written.',
  'receipt.transfer.not_completed':
    'The receipt {receipt} is "{status}": only a completed receipt has cash on account to transfer. Nothing was written.',
  'receipt.transfer.not_functional_currency':
    'The receipt {receipt} is in {currency}: only cash on account in {functional} is transferred, because the transfer moves its amount in customer advances as it stands. Nothing was written.',
  'receipt.transfer.source_is_transfer':
    'The receipt {receipt} is itself a transfer of customer credit: it is not passed on to a third customer. To correct it, reverse it with `mnemosine receipt reverse {receipt} --reason "<why>"` and transfer from the original receipt. Nothing was written.',
  'receipt.transfer.kept_caused':
    'The cash on account of {receipt} came back from an unapply that kept its IVA or IEPS caused: that tax is read from this receipt\'s own allocations and cannot follow the credit to another customer. Apply it to this customer\'s invoices instead. Nothing was written.',
  'receipt.transfer.cheque_not_cashed':
    'The receipt {receipt} is a cheque the bank has not cashed: it is not collected until it is cashed (LIVA art. 1-B), and a bounce would have to undo a credit the other customer relies on. Record the cashing first with `mnemosine bank check reconcile --receipt {receipt}`. Nothing was written.',
  'receipt.transfer.same_customer':
    'The receipt {receipt} already belongs to {customer}: a transfer moves cash on account to another customer. Nothing was written.',
  'receipt.transfer.exceeds_on_account':
    'The receipt {receipt} has {onAccount} on account and {amount} would be transferred: the cash on account does not reach. Nothing was written.',
  'receipt.transfer.date_future':
    '{receipt} cannot be transferred on {date}: that is after today ({today}) in the entity\'s time zone. Nothing was written.',
  'receipt.transfer.date_before_last_event':
    '{receipt} was last posted on {since}: a transfer dated {date} would give away its cash before that happened. Date it {since} or later. Nothing was written.',
  // MNE-001-779: the bound of an application holds for a transfer, which takes a check only once cashed.
  'receipt.transfer.date_before_cashing':
    'The bank cashed the cheque of {receipt} on {cashedOn}: a transfer dated {date} would give away its cash before the cheque was paid. Date it {cashedOn} or later. Nothing was written.',
  'receipt.reverse.has_transfer':
    'Part of the cash on account of {receipt} was transferred to another customer ({transfers}): reversing the receipt would leave that credit with no money behind it. Reverse the transfer first with `mnemosine receipt reverse <transfer> --reason "<why>"`. Nothing was written.',
  'receipt.reverse.transfer_applied':
    'The transfer {receipt} is applied to {invoices}: reversing it would take back a credit that already settled them. Unapply it first. Nothing was written.',
  'receipt.reverse.transfer_carries_caused':
    'The cash on account of the transfer {receipt} came back from an unapply that kept its IVA or IEPS caused: reversing it would give the original receipt the cash without that tax. Apply it again to the customer\'s invoices instead. Nothing was written.',
  'receipt.reverse.transfer_cause':
    'The transfer {receipt} moved no money, so its reversal has no cause: run it without --cause. Nothing was written.',
  'receipt.transfer.carries': 'Carries an advance of base {base} and IVA {iva}, caused when the source was collected',
  'receipt.transfer.would_transfer': 'Would transfer {amount} of {source} from {from} to {to} on {date}',
  'receipt.transfer.on_account': '{party} on account: {before} → {after}',
  'receipt.transfer.confirm':
    'Transfer {amount} of the cash on account of {source} from {from} to {to} on {date} in {entity}? This posts to the ledger.',
  'receipt.transfer.recorded': '{number}: {amount} of {source} transferred from {from} to {to} on {date} · entry {entry}',
  // MNE-001-568 (#612): the trace of a registered payment, completed from its evidence.
  'payment.trace.nothing_given':
    'Say what to complete: --check-number, --to-account, --to-bank, --to-foreign-bank or --bank. Nothing was written.',
  'payment.trace.reason_required':
    'Completing the trace of a payment requires --reason "<why>", naming the evidence it comes from: it is written to the audit trail.',
  'payment.trace.too_long':
    '{flag} admits up to {max} characters in the payment node of the SAT journal file, and {length} were given. Nothing was written.',
  'payment.trace.not_completable':
    'The payment {number} is "{status}": only a completed or reversed payment has a posted entry whose voucher declares its trace. Nothing was written.',
  'payment.trace.already_captured':
    'The payment {number} already has {stored} in {flag}: only an empty field is completed, and correcting a captured value is not this command. Nothing was written.',
  'payment.trace.race': '{number} changed while its trace was being completed; nothing was written.',
  // MNE-001-571 (#612): the capture warning is the generator's finding for that voucher.
  'payment.capture.untraced_voucher':
    'When the SAT asks for the period vouchers, `mnemosine e-accounting voucher generate` will name voucher {entry} of {number}:',
  // MNE-001-401 (#532): 999 is "N/A" in c_Banco; alone it names no bank.
  'payment.capture.foreign_code_without_name':
    '--to-bank 999 is "N/A" in the SAT c_Banco catalogue and names no bank. For a foreign bank, give its name with --to-foreign-bank instead (the voucher adds 999); for a national one, its own code. The voucher will carry a warning.',
  // MNE-001-570 (#612): the trace of a registered receipt.
  'receipt.trace.nothing_given':
    'Say what to complete: --check-number, --payer-bank, --payer-account, --payer-foreign-bank or --bank. Nothing was written.',
  // MNE-001-594 (#695): a transfer of customer credit moved no money, so it has no trace.
  'receipt.trace.balance_transfer':
    '{number} is a transfer of customer credit from {source}: no money moved, so it has no cheque, payer bank or bank account to complete, and no voucher declares one. The trace belongs on {source}, the receipt that collected the money. Nothing was written.',
  // MNE-001-569 (#612): a bank account linked afterwards must be the one the entry moved.
  'payment.trace.bank_no_entry':
    'The payment {number} has no posted entry: there is no ledger line to check a bank account against. Nothing was written.',
  'payment.trace.bank_not_in_entry':
    'The entry {entry} of payment {number} moved {moved}; "{account}" posts to {candidate}. Linking it would make the voucher declare a bank the ledger did not move. Nothing was written.',
  'payment.trace.would_complete': 'Would complete {number}: {fields}',
  'payment.trace.confirm':
    'Complete {fields} on {number}? Only empty fields are filled, and nothing posts to the ledger.',
  'payment.trace.completed': '{number}: {fields} completed; nothing was posted',
  'payment.trace.unchanged': '{number}: {fields} already held that value; nothing was written for it',
  'payment.trace.period_not_open':
    'The period {period} is in {status}: no ledger figure changes; a journal file generated now will declare this datum.',
  'payment.trace.archived_files':
    '{count, plural, one {# journal file} other {# journal files}} of {period} were archived before this completion: they are kept as they are, and one generated now will differ from them.',
  'receipt.advance.cfdi_owed':
    'none owed: an advance is documented by the advance CFDI the client issues (Anexo 20, Apéndice 6), not by a REP',
  'receipt.advance.invoice_already_booked':
    '{customer} has {invoices} open, and its own entry already credited customer advances: an advance CFDI in the books. The cash of that advance is recorded against it (receipt record {invoice}), not as a new advance. Go on only if this is another advance.',
  // MNE-001-422 / MNE-001-461 (#623): an advance applied to its sale's invoice cancels the IVA it caused.
  'receipt.advance.iva_cancelled': 'advance IVA cancelled {iva}',
  'receipt.advance.iva_restored': 'advance IVA restored {iva}',
  // MNE-001-573 (#789): a PUE invoice of a month before its cheque advance was cashed.
  'receipt.advance.iva_before_cashing':
    'The advance\'s IVA of {iva} cancelled on {invoice} is caused on {cashed}, the day the bank cashed the cheque (LIVA art. 1-B, second paragraph), and {invoice}, a PUE, already caused it in {month}: that month\'s IVA charged carries what the cashing day should, and this application cancels the advance\'s in its own month. Review the return of {month}.',
  'receipt.advance.iva_caused_twice':
    'The advance\'s IVA of {iva} cancelled on {invoice} was also caused in {month} by that invoice, a PUE issued on or before the advance (LIVA art. 1-B): that month\'s IVA charged carried it twice, and this application cancels it in its own month. Review the return of {month}.',
  'bank.parse.date_invalid': '{flag} must be a real date in YYYY-MM-DD form; got "{value}".',
  'bank.parse.amount_invalid': '{flag} must be a decimal amount; got "{value}".',
  'bank.parse.rate_invalid': '{flag} must be a decimal rate; got "{value}".',
  'bank.parse.rate_out_of_range':
    '{flag} goes between 0 and 1, not as a percentage: 0.16 for 16%, 0.0125 for 1.25%, 0 for ' +
    'none. Got "{value}".',
  'bank.parse.account_type_unknown':
    '--type "{value}" is not an account type. The five are: {types}.',
  'bank.parse.account_status_unknown':
    '--status {values} does not exist for a bank account: only active and archived.',
  'bank.parse.transaction_status_unknown':
    '-s {values} does not exist for a bank transaction: only matched and unmatched. The rest of ' +
    'its state —which statement it came from, what explains it— is read with `bank transaction show`.',
  'bank.parse.unmatched_contradicts_status':
    '--unmatched and `-s matched` ask for opposite things. --unmatched is the shorthand for ' +
    '`-s unmatched`: pass one of the two.',
  'bank.parse.direction_unknown':
    '--direction "{value}" does not exist: in is money coming in (positive amount) and out is money going out.',
  'bank.parse.id_list_empty': '{flag} arrived empty: name at least one identifier.',
  'bank.parse.id_list_invalid':
    '{flag} {values} is not an identifier: comma-separated uuids are expected, like the ones ' +
    '`bank transaction list -q` prints.',
  'bank.parse.uuid_invalid': '{flag} "{value}" is not an identifier: a uuid is expected.',
  'bank.parse.matchable_type_unknown':
    '"{value}" is not a matchable type. The five are: {types}. Write <type>:<id>, or just <id> ' +
    'for a journal entry line.',
  'bank.parse.book_item_uuid_missing':
    '--book-item "{value}" carries no valid identifier after the type.',
  'bank.parse.residual_unknown':
    '--residual "{value}" does not exist. keep leaves the residual alive as a reconciling item; ' +
    'write-off cancels it against whatever account --write-off-account names.',
  'bank.parse.unapply_reason_required':
    '--reason is mandatory and it is a CODE, not prose: {codes}. A closed taxonomy is what lets ' +
    'you ask how many matches were undone for a cancelled document this quarter; a free-text ' +
    'field answers that with a grep.',
  'bank.parse.item_type_unknown':
    '--type "{value}" is not a reconciling item type. The six are: {types}.',
  'bank.parse.adjustment_type_unknown':
    '--type "{value}" is not a reconciliation adjustment type. The five are: {types}.',
  'bank.parse.run_step_unknown':
    '--stop-at "{value}" is not a step of the guided pass. The five, in order: {steps}. None of ' +
    'them reaches `approve` or `post`.',
  'bank.parse.session_status_one_only':
    '-s takes one status at a time on this leaf ({count} arrived): {statuses}. Without the flag ' +
    'all four come out.',
  'bank.parse.session_status_unknown':
    '-s "{value}" is not a reconciliation session status. The four are: {statuses}.',
  'bank.parse.item_status_unknown':
    '-s {values} does not exist for a reconciling item: only open and resolved. A resolved item ' +
    'stopped explaining a difference, and that is why it does not come out by default.',
  'bank.query.unclosed_quote': 'The query "{query}" opens a quote and does not close it.',
  'bank.query.term_unknown':
    'The query does not know the term "{term}:". The ones that exist are {terms}, and a word ' +
    'with no prefix searches the description. The rest is narrowed with flags (--account, ' +
    '--since, --until, --direction, --type).',
  'bank.query.term_without_value': 'The term "{term}" carries no value: write {key}:<value>.',
  'bank.query.amount_invalid':
    '"amt:{value}" is not an amount. The form is amt:250, amt:>1000, amt:<=99.99 or amt:-250 ' +
    '(with a sign it compares the amount as it stands; without one, the magnitude).',
  'bank.query.narrows_nothing':
    'The query "{query}" narrows nothing. Name at least one term ({terms}), or drop it to list everything.',

  // --- Lo que comparten todas las hojas de la familia -------------------
  /** El `(s)` de `fila(s)` era la ausencia del plural, no una elección. */
  'bank.list.hit_limit':
    'Listed {count, plural, one {# row} other {# rows}}, which is the --limit cap: there may be ' +
    'more. Raise --limit, or use --all on `{command}`.',
  'bank.offset.unsupported':
    '--offset is not implemented in this family: the query orders and caps with --limit, with no ' +
    'stable cursor. {alternative}',
  'bank.offset.narrow_accounts': 'Narrow with [query], --type or --currency, or ask for everything with --all.',
  'bank.offset.narrow_statements': 'Narrow with --account, --since or --until.',
  'bank.offset.narrow_sessions': 'Narrow with --account, --period or -s, or ask for everything with --all.',
  'bank.confirm.taken_as_no': '{reason}; I take it as a no.',
  'bank.aborted.no_changes': 'No changes.',
  'bank.idempotency.hit':
    'Idempotency hit: the key "{key}" already consummated this act — {what}. Nothing ran a second ' +
    'time; this is the recorded result.',

  // --- bank account -----------------------------------------------------
  'bank.account.create.dry_run':
    'Dry run: the insert really did run —unique index included— and was rolled back. Nothing was written.',
  /** La etiqueta de la ficha, no el valor de `account_type`: ese es dato. */
  'bank.account.show.liability': 'LIABILITY',
  // LOS ROTULOS DE LA FICHA DE `bank account show`.
  //
  // Estaban escritos en inglés dentro del archivo, y el carril del idioma no
  // los veía porque el carril mide ESPAÑOL: una etiqueta inglesa sin clave es
  // exactamente la misma deuda que una española —el operador que pide es-MX
  // lee la ficha en inglés— y sólo se distingue en que nadie la contaba.
  //
  // CLABE, IBAN y SWIFT/BIC NO ENTRAN, por la misma razón que `hash` no entró
  // en `bank.reconciliation.approve.*`: son los nombres de tres estándares,
  // se escriben igual en los dos idiomas, y una clave cuya traducción es la
  // fuente copiada es lo que `tests/i18n/sync.spec.ts` §5 rechaza por su
  // nombre. Se quedan como literales en el sitio de llamada, dicho allí.
  'bank.account.show.label.account_number': 'Account number',
  'bank.account.show.label.routing': 'Routing',
  'bank.account.show.label.sat_bank_key': 'SAT bank key',
  'bank.account.show.label.gl_account': 'GL account',
  'bank.account.show.label.book_balance': 'Book balance',
  'bank.account.show.label.bank_balance': 'Bank balance',
  'bank.account.show.label.difference': 'Difference',
  'bank.account.show.label.last_reconciled': 'Last reconciled',
  'bank.account.show.label.status': 'Status',
  /** El routing no se enseña nunca: sólo se dice que está, y que va cifrado. */
  'bank.account.show.routing_on_file': 'on file (encrypted)',
  'bank.account.show.gl_unmapped': 'unmapped',
  'bank.account.show.bank_balance_never_synced': 'never synced',
  'bank.account.show.never_reconciled': 'never',
  'bank.account.show.status_active': 'active',
  'bank.account.show.status_archived': 'archived',
  // MNE-001-502 · the foreign-bank mark: only a person sets it, always with a reason.
  'bank.account.show.label.foreign_bank': 'Foreign bank',
  'bank.account.show.foreign_bank_marked': 'not resident in Mexico',
  'bank.account.foreign_bank.reason_required':
    '--foreign-bank and --no-foreign-bank require --reason "<why>": the mark says whether the bank is ' +
    'resident in Mexico, and the vouchers file declares it. The reason is kept in the audit trail, which is append-only.',
  'bank.account.foreign_bank.keeps_sat_bank_code':
    'An account at a foreign bank has no SAT c_Banco code, and this edit leaves it with {code}. ' +
    'Clear it in the same edit with --sat-bank-code "", or remove the mark with --no-foreign-bank --reason "<why>".',
  'bank.account.foreign_bank.keeps_clabe':
    'An account at a foreign bank has no CLABE, which only a bank resident in Mexico issues, and this edit ' +
    'leaves it with one. Clear it in the same edit with --clabe "" --reason "<why>", or remove the mark with ' +
    '--no-foreign-bank --reason "<why>".',
  // MNE-001-615 · the mark at creation, and the warnings around it.
  'bank.account.create.foreign_bank.sat_bank_code':
    'An account at a foreign bank has no SAT c_Banco code, and this one would be created with {code}. ' +
    'Drop --sat-bank-code, or create it without --foreign-bank if its bank is resident in Mexico.',
  'bank.account.create.foreign_bank.clabe':
    'An account at a foreign bank has no CLABE, which only a bank resident in Mexico issues. ' +
    'Drop --clabe and give its --account-number, or create it without --foreign-bank if its bank is resident in Mexico.',
  'bank.account.create.no_sat_bank_code':
    'The account has no SAT c_Banco code: the vouchers file needs it for the origin and destination of a payment. ' +
    'Capture it with `bank account edit <account> --sat-bank-code <code>` or, if its bank is not resident in ' +
    'Mexico, mark it with `bank account edit <account> --foreign-bank --reason "<why>"`.',
  'bank.account.foreign_bank.name_too_long':
    'The bank name has {length} characters and the vouchers file declares a foreign bank in an attribute that ' +
    'takes {max}: each of its payments leaves its node out of the voucher, which is named, and the name is never cut. ' +
    'Shorten it with `bank account edit <account> --bank "<name of up to {max} characters>"`.',
  'bank.account.edit.nothing_to_change':
    'Nothing to change. Pass --name, --bank, --branch, --type, --currency, --clabe, ' +
    '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift, --iban, ' +
    '--foreign-bank or --no-foreign-bank.',
  'bank.account.edit.reason_required':
    '{fields} changes one of the identifiers the money leaves by ({sensitive}): it requires ' +
    '--reason "<why>". The reason is kept in the audit trail, which is append-only.',
  'bank.account.edit.confirm': 'You are about to change {fields} of "{account}". Continue?',
  'bank.account.edit.nothing_changed': 'Nothing changed: the values were already those.',
  'bank.account.edit.fields_changed': '{count, plural, one {# field} other {# fields}}',
  'bank.account.edit.dry_run': 'Dry run: the UPDATE really did run and was rolled back.',
  'bank.account.set.already_mapped':
    '{account} was already mapped to {gl}: nothing to write.',
  'bank.account.set.forced':
    'FORCED over {count, plural, one {# posted line} other {# posted lines}}',

  // --- bank statement ----------------------------------------------------
  'bank.dir.unreadable': 'Could not read --dir {dir}: {error}',
  'bank.dir.no_files': '--dir {dir} has no files to import.',
  'bank.import.no_file': 'Which file. Pass it as an argument or point at a folder with --dir.',
  'bank.import.counts':
    '{added, plural, one {# new} other {# new}}, ' +
    '{duplicated, plural, one {# already there} other {# already there}}',
  'bank.import.nothing_new':
    'Nothing new was stored: {count, plural, one {the only movement of the file is} other {all # movements of the file are}} ' +
    'already in {account} by native bank id' +
    '{held, select, none {} other {, in {statements}}}' +
    '{loose, plural, =0 {} other { (# entered with no statement)}}. ' +
    'No statement was created: work with what is already there.',
  'bank.import.findings':
    '{file}: {count, plural, one {# integrity finding} other {# integrity findings}}. They are ' +
    'in staging all the same — it is `bank statement check` that exits 4.',
  'bank.import.dry_run': 'Dry run: it was parsed, it was checked, and the write was rolled back.',
  'bank.import.staging_note':
    'Bank staging: none of this is in the ledger until it is matched and reconciled.',
  'bank.statement.list.status_not_applicable':
    '-s/--status does not apply to a bank statement: it has no lifecycle state. Its verdict is ' +
    'computed as it is read (the `chain` column), and what judges it is `bank statement check`, ' +
    'which exits 4.',
  'bank.statement.list.broken_chains':
    '{count, plural, one {# statement} other {# statements}} with a broken balance chain. ' +
    '`bank statement check` says which test failed and exits 4.',
  'bank.statement.show.line_count_mismatch':
    'The document carries {document, plural, one {# line} other {# lines}} and the database ' +
    'attributes {stored} to it: the missing ones were inferred against an earlier statement and ' +
    "keep that one's statement_id.",
  'bank.statement.show.lines_omitted':
    '{count, plural, one {# more line was} other {# more lines were}} not listed. Raise --limit.',
  'bank.statement.check.skipped':
    '{count, plural, one {# more statement} other {# more statements}} met the filter and were ' +
    'not checked: the run has a cap. Narrow with --account or with --since.',

  // --- bank transaction · book-item · match -------------------------------
  'bank.transaction.show.no_extractors':
    'No extractors yet ({fields}): what the bank wrote is in --raw. `bank transaction apply` will ' +
    'fill them in.',
  'bank.book_item.oldest_unseen':
    'The oldest one has gone {days, plural, one {# day} other {# days}} without showing up at the ' +
    'bank ({entry}). A check issued and never cashed lives here and never on the statement.',
  'bank.match.preview.needs_target':
    'Preview needs to know about what: pass a transaction id, or --account to sweep the unmatched ' +
    'ones of an account.',
  'bank.match.preview.no_proposal': 'no proposal',
  'bank.match.preview.candidate': 'confidence {confidence} · rule {rule}',
  'bank.match.preview.label.amount': 'amount',
  'bank.match.preview.label.date': 'date',
  'bank.match.preview.label.description': 'description',
  'bank.match.preview.label.period': 'period',
  'bank.match.preview.label.verdict': 'verdict',
  'bank.match.preview.amount_signal':
    '{bank} vs {candidate} · difference {difference} · exact {exact} · same direction {sameDirection}',
  'bank.match.preview.date_signal':
    '{days, plural, one {# day} other {# days}} · within window {withinWindow}',
  'bank.match.preview.description_signal': 'similarity {similarity}',
  'bank.match.preview.soft_signal': '(soft signal: never applies on its own)',
  'bank.match.preview.would_apply': '`run` would apply it',
  'bank.match.preview.not_applied': 'not applied',
  'bank.match.preview.summary':
    '{count, plural, one {movement} other {movements}} · {applicable} that `bank match run` would apply.',
  'bank.match.preview.hit_top':
    '{count} were previewed, which is the --top cap: there may be more.',
  'bank.match.applied': '{count, plural, one {# applied} other {# applied}}',
  'bank.match.run.tally':
    '· {already, plural, one {# already was} other {# already were}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}} · ' +
    '{evaluated, plural, one {# evaluated} other {# evaluated}}',
  'bank.match.apply.tally':
    '· {already, plural, one {# already was} other {# already were}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}}',
  'bank.match.apply.stdin_empty':
    'Standard input brought no id. `bank match preview -q` spits them out one per line.',
  'bank.match.apply.no_transactions':
    'Which transactions. Pass them as arguments, or pipe `bank match preview -q | mnemosine bank ' +
    'match apply --stdin`.',
  'bank.match.apply.confirm':
    'You are about to apply the match the engine proposes for ' +
    '{count, plural, one {# movement} other {# movements}}. Continue?',
  'bank.match.apply.no_terminal':
    'No changes: there is no terminal to confirm at (standard input is the pipe). Add -y to apply ' +
    'without asking.',
  'bank.match.create.write_off_declared':
    'The residual of {amount} is DECLARED written off against the account, but it is not posted: ' +
    'there is no journal entry behind it yet. Record it by hand or wait for F05c.',
  'bank.match.create.dry_run': 'Dry run: the group really was written, and then rolled back.',
  'bank.match.unapply.confirm':
    'You are about to unapply match {match} and every match in its group (the identity ' +
    'Σbank = Σbooks + Σadjustments does not survive having a leg taken off it). Continue?',
  'bank.match.unapply.closed':
    '{count, plural, one {# match closed} other {# matches closed}}',
  'bank.match.unapply.released':
    '· {transactions, plural, one {# transaction} other {# transactions}} and ' +
    '{items, plural, one {# item} other {# items}} back in the flow · reason {reason}',
  'bank.match.unapply.group': 'group {group}',
  'bank.match.unapply.closure_note':
    'Closure, not deletion: the row stays in the file with its reason, because the auditor asks ' +
    'why it was undone and a deleted row does not answer.',
  'bank.match.unapply.dry_run': 'Dry run: it really was closed, and then rolled back.',

  // --- bank reconciliation: la aritmética de dos lados ---------------------
  /** Un lado que nadie observó. NUNCA la palabra «cero». */
  'bank.reconciliation.not_observed': 'not observed',
  'bank.reconciliation.side.bank': 'BANK',
  'bank.reconciliation.side.books': 'BOOKS',
  'bank.reconciliation.label.statement_balance': 'statement balance',
  'bank.reconciliation.label.book_balance': 'book balance',
  'bank.reconciliation.label.adjusted': '= adjusted',
  'bank.reconciliation.label.variance': 'VARIANCE',
  'bank.reconciliation.variance_not_computed': 'NOT COMPUTED',
  'bank.reconciliation.variance_missing_side':
    'It is not zero: it is that a side is missing. A zero here would mean «nobody subtracted anything».',
  'bank.reconciliation.tolerance_line': 'tolerance {tolerance} · policy {policy}',
  'bank.reconciliation.counters.items_label': 'items',
  'bank.reconciliation.counters.items':
    '{total} · {unclassified} unclassified · {undated} undated · ' +
    '{resolved, plural, one {# resolved} other {# resolved}}',
  'bank.reconciliation.counters.statement_label': 'statement',
  'bank.reconciliation.counters.unexplained':
    '{count, plural, one {# movement} other {# movements}} with no match and no item ({amount})',
  'bank.reconciliation.frozen.title': 'FROZEN SUMMARY',
  'bank.reconciliation.frozen.caption': '(the assertion, not the answer)',
  'bank.reconciliation.frozen.never_computed':
    'nobody has done the arithmetic of this session: the row keeps variance {variance} by DEFAULT',
  'bank.reconciliation.frozen.line':
    'variance {variance} · books {books} · checks {checks} · deposits {deposits} · ' +
    'charges {charges} · credits {credits} · other {other}',
  'bank.reconciliation.frozen.computed_on': 'computed on {date}',
  'bank.reconciliation.frozen.drifted':
    'the live arithmetic says {live} and the session asserted {frozen}: something changed ' +
    'underneath since it was closed.',
  'bank.reconciliation.ready_to_close': 'ready for `bank reconciliation close`.',
  'bank.reconciliation.whats_missing': 'WHAT IS MISSING',
  'bank.reconciliation.session_label': 'session {session}',
  'bank.reconciliation.run.file_flags_without_file':
    '--format and --profile describe the file of --file, and there is no file. Pass --file, or ' +
    'drop them to take the statement already imported.',
  'bank.reconciliation.run.dry_run':
    'Dry run: the steps that write really did run, and were rolled back.',
  'bank.reconciliation.open.summary':
    'opening balance {opening} · bank close {closingBank} {currency} · statement {statement}',
  'bank.reconciliation.open.continues': 'continues {session}',
  'bank.reconciliation.open.baseline': 'starts from the baseline {balance} as of {date}',
  'bank.reconciliation.open.baseline_date_without_baseline':
    '--baseline-date is the date of --baseline, and there is no --baseline. Pass the reconciled balance with --baseline, or drop --baseline-date.',
  'bank.reconciliation.open.no_arithmetic_yet':
    'The session is born with no arithmetic (`arithmetic_computed_at` NULL): `bank reconciliation ' +
    'status` computes it live and `close` signs it. None of this touches the ledger.',
  'bank.reconciliation.open.dry_run':
    'Dry run: the session really was opened —continuity included— and was rolled back.',
  'bank.reconciliation.list.variance_blank':
    '{count, plural, one {# session} other {# sessions}} with the variance blank: nobody has done ' +
    "its arithmetic. The row's column is 0 by DEFAULT and that is why it is not printed.",
  'bank.reconciliation.status.needs_target':
    'Say which session: `bank reconciliation status <session>`, or --account for the one in ' +
    'progress on that account.',
  'bank.reconciliation.status.two_ways':
    'The identifier and --account say the same thing two ways: give one of the two. With ' +
    '--account the IN-PROGRESS session of that account is read.',
  'bank.reconciliation.status.statement_line':
    'statement {statement} · declared by the bank {declared} · opening balance {opening}',
  'bank.reconciliation.status.no_statement':
    'no statement attached: the bank balance CANNOT be observed',
  'bank.reconciliation.status.items_title': 'ITEMS',
  'bank.reconciliation.status.adjustments_title': 'ADJUSTMENTS',
  'bank.reconciliation.status.adjustments_caption': '(drafts: nothing posted itself)',

  // --- bank reconciling-item · adjustment · close · approve ----------------
  'bank.item.list.ageing':
    'The oldest one has been open {days, plural, one {# day} other {# days}}. ' +
    '{overdue, plural, one {# overdue} other {# overdue}} and {undated} with no expected date: an ' +
    'item with no date is not chased, it ages.',
  'bank.item.assign.expected_contradiction':
    '`--expected` and `--clear-expected` ask for opposite things: either a date is set or it is cleared.',
  'bank.item.assign.nothing_to_assign':
    'There is nothing to assign: name at least --owner, --expected, --clear-expected, ' +
    '--escalation or --note.',
  'bank.item.assign.escalation_unknown': '--escalation takes {values}; got "{value}".',
  'bank.adjustment.create.summary':
    '· {type} · {amount} · counterpart {account} · bank {bankAccount} · draft {draft}',
  'bank.adjustment.create.draft_note':
    'It is a DRAFT: wait for `mnemosine review`. `journal_entry_id` stays NULL until ' +
    '`bank reconciliation post` (F05d) posts it behind a signature.',
  'bank.reconciliation.close.refused':
    'Session {session} does not close: variance {variance}, ' +
    '{unclassified, plural, one {# unclassified item} other {# unclassified items}} and ' +
    '{undated} undated.',
  'bank.reconciliation.close.variance_missing_side': 'NOT COMPUTED (not zero: a side is missing)',
  'bank.reconciliation.close.what_balanced_would_claim':
    'Marking it "balanced" with this open would tell the close dashboard that the cash of this ' +
    'account is verified against the bank.',
  'bank.reconciliation.close.confirm':
    'You are about to sign that account {account} agrees with the bank as of {until} ' +
    '(variance {variance}). `period-close` will read it as the evidence that the cash was ' +
    'verified. Continue?',
  'bank.reconciliation.close.no_terminal':
    'No changes: there is no terminal to confirm at. Add -y to close without asking.',
  'bank.reconciliation.close.summary':
    '· {status} · variance {variance} · bank adjusted {bankAdjusted} = books adjusted {booksAdjusted}',
  'bank.reconciliation.close.frozen_summary':
    'frozen summary: books {books} · checks {checks} · deposits {deposits} · charges {charges} · ' +
    'credits {credits} · other {other}',
  'bank.reconciliation.close.arithmetic_stamp':
    'Arithmetic computed on {date}. Balanced is NOT approved and NOT posted: `approve` requires ' +
    'that the approver is not the preparer, and `post` is what moves the ledger.',
  'bank.reconciliation.close.dry_run': 'Dry run: it really was closed, and then rolled back.',
  'bank.reconciliation.approve.title': 'WHAT IS ABOUT TO BE SIGNED',
  'bank.reconciliation.approve.label.session': 'session',
  'bank.reconciliation.approve.label.account': 'account',
  'bank.reconciliation.approve.label.statement': 'statement',
  'bank.reconciliation.approve.label.variance': 'variance',
  'bank.reconciliation.approve.label.members': 'members',
  'bank.reconciliation.approve.label.segregation': 'segregation',
  'bank.reconciliation.approve.no_statement': 'none attached to the session',
  'bank.reconciliation.approve.variance_value': '{live} (frozen at close: {frozen})',
  'bank.reconciliation.approve.members_value':
    '{items, plural, one {# item} other {# items}} · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{adjustments, plural, one {# adjustment} other {# adjustments}}',
  'bank.reconciliation.approve.segregation_value': 'prepared by {preparer} · policy {policy}',
  'bank.reconciliation.approve.nobody_recorded': 'nobody recorded',
  'bank.reconciliation.approve.policy_default': '(by default)',
  'bank.reconciliation.approve.confirm':
    'You are about to SIGN session {session} with snapshot {hash}… ' +
    '({items, plural, one {# item} other {# items}}, ' +
    '{adjustments, plural, one {# adjustment} other {# adjustments}}, variance {variance}). ' +
    'Approving it again is refused; withdrawing it takes `bank reconciliation reopen` and a ' +
    'reason. Continue?',
  'bank.reconciliation.approve.already_signed': 'session {session} already signed',
  'bank.reconciliation.approve.summary': '· {status} · signed by {by} on {on}',
  'bank.reconciliation.approve.not_posted_yet':
    'Approved is NOT posted: the ledger is moved by `bank reconciliation post`, which posts the ' +
    'adjustments this signature has just frozen.',
  'bank.reconciliation.approve.dry_run':
    'Dry run: it really was signed, and then rolled back. The hash is the one that would remain.',

  'bank.reconciliation.reopen.title': 'WHAT IS ABOUT TO BE REOPENED',
  'bank.reconciliation.reopen.transition': 'session {session} · {from} → {to} · {previous} → in_progress',
  'bank.reconciliation.reopen.reversal':
    'entry {entry} reversed by {reversal} (never deleted); its adjustment is a pending draft again',
  'bank.reconciliation.reopen.withdrawn':
    'signature withdrawn: {by} on {on} (the audit trail keeps it with its snapshot)',
  'bank.reconciliation.reopen.confirm':
    'You are about to REOPEN session {session} and withdraw its signature {hash}…' +
    '{reversals, plural, =0 {} one { It reverses # posted entry.} other { It reverses # posted entries.}} ' +
    'Continue?',
  'bank.reconciliation.reopen.already_reopened': 'session {session} already reopened',
  'bank.reconciliation.reopen.summary': '· {status} · signature withdrawn',
  'bank.reconciliation.reopen.next':
    'Correct what was wrong, then `bank reconciliation close` and `approve` again over the same range.',
  'bank.reconciliation.reopen.dry_run': 'Dry run: it really was reopened, and then rolled back.',

  // --- bank reconciliation post · generate --------------------------------
  'bank.reconciliation.post.already_posted': 'The session is already posted',
  'bank.reconciliation.post.already_posted_detail':
    '{count, plural, one {# entry} other {# entries}} in the book and nothing to post.',
  'bank.reconciliation.post.already_posted_short': 'session {session} already posted',
  'bank.reconciliation.post.entries_title': 'ENTRIES ABOUT TO BE CREATED',
  'bank.reconciliation.post.no_entries': 'none: the session has no adjustments to post',
  'bank.reconciliation.post.adopted': 'adopted',
  'bank.reconciliation.post.new': 'new',
  'bank.reconciliation.post.entry_ref': '· entry {entry} · draft {draft}',
  'bank.reconciliation.post.counterpart_note':
    'the counterpart of each one: whatever `bank adjustment create` set in its draft',
  'bank.reconciliation.post.sealed_title': 'AND WHAT GETS SEALED',
  'bank.reconciliation.post.sealed_lines':
    '{count, plural, one {book line} other {book lines}} against the bank GL account',
  'bank.reconciliation.post.sealed_matches':
    '{count, plural, one {match} other {matches}} against the statement movement that explains them',
  'bank.reconciliation.post.sealed_items':
    '{count, plural, one {reconciling item} other {reconciling items}} the adjustment leaves without object',
  'bank.reconciliation.post.confirm_noop':
    'Session {session} is already posted and nothing will be posted. Continue anyway?',
  'bank.reconciliation.post.confirm':
    'You are about to POST {entries, plural, one {# new entry} other {# new entries}} into the ' +
    'ledger of session {session} and seal {lines, plural, one {# book line} other {# book lines}}. ' +
    'The ledger is immutable: this is only corrected by reversal. Continue?',
  'bank.reconciliation.post.summary':
    '· {status} · {posted, plural, one {# posted} other {# posted}} · ' +
    '{adopted, plural, one {# adopted} other {# adopted}} · ' +
    '{lines, plural, one {# line sealed} other {# lines sealed}} · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{items, plural, one {# item resolved} other {# items resolved}}',
  'bank.reconciliation.post.seal_note':
    'The seal says «this line is already explained by the bank», not «this session is over»: ' +
    'outstanding checks and deposits in transit stay open for next month’s matching.',
  'bank.reconciliation.post.dry_run':
    'Dry run: it really was posted, and then rolled back. There is no journal entry in the book.',
  'bank.reconciliation.generate.no_pdf_or_xlsx':
    '--format {format} does not exist yet: the project has no PDF or XLSX dependency and one is ' +
    'not added to fake a document that would end up in a file. What there is: --format json (the ' +
    'whole state, with both columns and the frozen summary), --format md|csv|tsv (the state as ' +
    'rows) and the default text output, which is the one that is printed and archived.',
  'bank.reconciliation.generate.title': 'BANK RECONCILIATION STATEMENT',
  'bank.reconciliation.generate.items_title': 'RECONCILING ITEMS',
  'bank.reconciliation.generate.drafts_caption': '(drafts)',
  'bank.reconciliation.generate.prepared_by': 'prepared',
  'bank.reconciliation.generate.approved_by': 'approved',
  'bank.reconciliation.generate.not_closed': 'not closed',
  'bank.reconciliation.generate.not_approved': 'not approved',

  // --- bank fee · interest · check ------------------------------------------
  'bank.skipped.title': 'SKIPPED',
  'bank.entry_ref': '{description} · entry {entry}',
  'bank.entry_number': 'entry {entry}',
  'bank.no_description': 'no description',
  'bank.entry_dry_run': '(dry run)',
  'bank.posting.dry_run':
    'Dry run: it really was posted, and then rolled back; the ids come out null.',
  'bank.fee.post.title': 'FEES',
  'bank.fee.post.nothing_to_post': 'no charge to post',
  'bank.fee.post.totals': 'totals: charge {charge} · expense {expense} · VAT {vat}',
  'bank.fee.post.confirm':
    'You are about to POST {count, plural, one {# fee} other {# fees}} from {from} to {to} on ' +
    'account {account}, for {total} (VAT {vat}; {released} moves to creditable). The ledger is ' +
    'immutable: this is only corrected by reversal. Continue?',
  'bank.fee.post.fees': '{count, plural, one {# fee} other {# fees}}',
  'bank.fee.post.summary':
    '· {posted, plural, one {# posted} other {# posted}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}} · charge {charge} · VAT {vat}',
  'bank.fee.post.vat_release_ref': 'fee VAT to creditable · entry {entry}',
  'bank.fee.post.vat_released_note':
    'The fees’ VAT ({vat}) moved from pending-creditable to creditable in the month of the ' +
    'charge. Keep the bank’s CFDI: without it the credit does not stand.',
  'bank.interest.post.title': 'INTEREST',
  'bank.interest.post.withholding': 'withholding {rate}',
  'bank.interest.post.nothing_to_post': 'no credit to post',
  'bank.interest.post.totals': 'totals: gross {gross} · withheld {withheld} · net {net}',
  'bank.interest.post.confirm':
    'You are about to POST {count, plural, one {# interest credit} other {# interest credits}} ' +
    'from {from} to {to} on account {account}: {gross} of gross income and {withheld} of ISR ' +
    'withheld in the entity’s favour. The ledger is immutable: this is only corrected by ' +
    'reversal. Continue?',
  'bank.interest.post.credits':
    '{count, plural, one {# interest credit} other {# interest credits}}',
  'bank.interest.post.summary':
    '· {posted, plural, one {# posted} other {# posted}} · ' +
    '{skipped, plural, one {# skipped} other {# skipped}} · gross {gross} · withheld {withheld}',
  'bank.interest.post.withholding_note':
    'The ISR withheld stays a prepayment IN THE ENTITY’S FAVOUR, not an expense: it is what gets ' +
    'credited against the year’s tax.',
  'bank.check.reconcile.title': 'THE MONTH THE ENTRY FALLS IN',
  'bank.check.reconcile.label.check': 'check',
  'bank.check.reconcile.label.cleared_on': 'cleared on',
  'bank.check.reconcile.check_value': '{check} · payment {payment}',
  'bank.check.reconcile.no_number': 'no number',
  'bank.check.reconcile.dated_by_bank':
    '(the bank dates it: transaction {transaction}, {amount})',
  'bank.check.reconcile.label.entry_date': 'entry dated',
  'bank.check.reconcile.entry_after_cashing':
    '(its bills were applied on that day, after the cashing: the VAT is credited on the later of the two days)',
  'bank.check.reconcile.no_open_period': 'no open period on that date',
  'bank.check.reconcile.no_period': 'no period',
  'bank.check.reconcile.why':
    'why: under the VAT law a payment by check counts as made on the day it CLEARED and not the ' +
    'day it was signed, so the VAT of this payment is credited in that month.',
  'bank.check.reconcile.entry_title': 'ENTRY',
  'bank.check.reconcile.no_vat': 'none: there is no VAT to reclassify',
  'bank.check.reconcile.total': 'total reclassified {amount}',
  'bank.check.reconcile.confirm':
    'You are about to record that the bank cleared check {check} on {date} and to reclassify ' +
    '{amount} of VAT in period {period}. The ledger is immutable: this is only corrected by ' +
    'reversal. Continue?',
  'bank.check.reconcile.already_cleared': 'check cleared on {date}',
  'bank.check.reconcile.changed_meanwhile':
    'Payment {payment} ("{status}") changed while the cashing of its cheque was being recorded, or it is not a completed payment. Nothing was written.',
  'bank.check.reconcile.several_release_days':
    'The bank cashed the cheque of payment {payment} on {cashedOn}, and the VAT of its applications is credited on the later of that day and the day each was applied: {days}. One cashing posts one entry with one date, so nothing was written. Unapply the applications dated after {first}, record the cashing, and apply them again.',
  'bank.check.reconcile.summary':
    '· cleared on {date} · period {period} · VAT reclassified {amount}',
  'bank.check.reconcile.dry_run':
    'Dry run: the clearing really was recorded, and then rolled back.',
  'bank.check.cashing.refused.not_a_cheque':
    'Receipt {receipt} was paid by "{method}", not by cheque: only a cheque is cashed on a later day.',
  'bank.check.cashing.refused.not_completed':
    'Receipt {receipt} is in "{status}": a cashing is recorded on a completed receipt only.',
  'bank.check.cashing.refused.already_cashed':
    'The cheque of receipt {receipt} is already cashed on {date} with bank transaction {transaction}. A cheque is cashed once.',
  'bank.check.cashing.refused.credit_used':
    'Bank transaction {transaction} is already the cashing of receipt {holder}, so it cannot pay receipt {receipt}.',
  'bank.check.cashing.refused.other_account':
    'Bank transaction {transaction} is in another bank account than receipt {receipt}. If the cheque was deposited there, correct the receipt.',
  'bank.check.cashing.refused.currency_differs':
    'Bank transaction {transaction} is in {creditCurrency} and receipt {receipt} in {currency}. Nothing is converted here.',
  'bank.check.cashing.refused.amount_differs':
    'Bank transaction {transaction} is {creditAmount} and receipt {receipt} needs a credit of exactly {amount}.',
  'bank.check.cashing.refused.credit_before_receipt':
    'Bank transaction {transaction} is dated {date} and receipt {receipt} {receiptDate}: a cheque is not cashed before it is received.',
  'bank.check.cashing.refused.period_closed':
    'The cashing of receipt {receipt} is dated {date}, and no open period holds that date. Its VAT belongs to that month and is not posted with another date: reopen the period first.',
  'bank.check.cashing.refused.entry_period_closed':
    'The bank cashed the cheque of receipt {receipt} on {cashedOn}, and its invoices applied on {date} cause their VAT that day, the later of the two, and no open period holds it. That VAT is not posted with another date: reopen the period first. Nothing was written.',
  'bank.check.cashing.note.already_released':
    'No entry: the receipt had already released this VAT on its own date.',
  'bank.check.cashing.note.nothing_to_release':
    'No entry: this receipt holds no VAT pending collection.',
  'bank.check.cashing.note.foreign_currency':
    'No entry: a cheque in a foreign currency releases its VAT on the receipt date.',
  'bank.check.cashing.refused.transaction_needed':
    'Receipt {receipt} names no bank account, so there is nowhere to look for its credit. Name the bank transaction with `--transaction`.',
  'bank.check.cashing.refused.no_credit':
    'No unused credit of {amount} from {date} is in the bank account of receipt {receipt}. Either the cheque is not cashed yet or the bank credited another amount: name the bank transaction with `--transaction`.',
  'bank.check.cashing.refused.several_credits':
    'Several credits of {amount} could be the cheque of receipt {receipt}: {candidates}. None is picked, because the wrong one dates its VAT in the wrong month. Name the right one with `--transaction`.',
  'bank.check.cashing.refused.as_of_differs':
    'Bank transaction {transaction} is dated {date}, not {asOf}, the date stated with `--as-of` for receipt {receipt}. The bank dates the cashing: check that this is the credit that paid the cheque.',
  'bank.check.cashing.refused.several_need_transaction':
    'Receipts {receipt} are cashed together by one bank credit: name it with `--transaction`. It is not searched by their sum, which the deposit of another day can match.',
  'bank.check.cashing.refused.sum_differs':
    'Bank transaction {transaction} is {creditAmount} and receipts {receipt} add up to {amount}: one credit cashes several cheques only when it is their exact sum.',
  'bank.check.cashing.refused.credit_matched':
    'Bank transaction {transaction} is tied by the live match {match} to {type} {matched}, which is not among receipts {receipt} nor a bank line of their entries: the credit paid something else. If that match is wrong, undo it with `bank match unapply {match}`.',
  'bank.check.cashing.check_value': '{check} · receipt {payment}',
  'bank.check.cashing.entry_after_cashing':
    '(its invoices were applied on that day, after the cashing: their VAT is caused on the later of the two days)',
  'bank.check.cashing.why':
    'why: under the VAT law a price paid by cheque counts as collected on the day the bank CASHED it and not ' +
    'the day it was received, so the VAT of this receipt is caused in that month.',
  'bank.check.reconcile.one_of':
    'Name exactly one cheque: the vendor payment <id>, or a customer receipt with --receipt <ref>.',
  'bank.transaction.show.unmatched': 'unmatched',
  'bank.match.create.summary':
    '· bank {bank} = books {books} + adjustments {adjustments} · residual {residual} ({mode}) · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{sealed, plural, one {# item sealed} other {# items sealed}}',
  // ==== fin del piloto bank (I7) ====================================
  // ==== I8 · the CLI leaves by key, one block per family (MNE-001-217, issue #262) ====
  // Seeded empty so the nine family PRs (MNE-001-218 to 230) each write inside
  // their own block and git merges them. Keep each family's keys between its
  // two markers; tests/i18n/sync.spec.ts checks they stay, once each, in order.
  // ==== I8.1 · CLI leaves by key, family report (issue #263) ====

  // MNE-001-218: `src/cli/cashflow-command.ts` and `src/cli/cashflow-reconcile-command.ts`.
  /** src/cli/cashflow-command.ts: `--gross` is refused, saying what is missing. */
  'report.cashflow.gross_unavailable':
    'The statement in GROSS terms (NIF B-2 §40 / ASC 230-10-45-7) cannot be built from these data, and the net is not returned labelled as gross. Gross needs receipts and payments kept apart, and that is a datum of the TRANSACTION, not of the account: the engine publishes a net per account, and splitting it into its debit and its credit does not give flows — disposing of an asset credits book value while the cash collected is another amount. The default output already shows every account of every section, which is the detail these books do support. Run it again without --gross.',
  /** `concept` of the `derivado` contrast row. */
  'report.cashflow_reconcile.derived_concept': 'Cash flow statement, net ({method} method)',
  /** `concept` of the `real` contrast row. */
  'report.cashflow_reconcile.ledger_concept': 'Cash and banks, change in the ledger',
  /** `concept` of the `residuo` contrast row. */
  'report.cashflow_reconcile.residue_concept': 'Residue (derived − actual)',
  /** The cash note: the accounts, the criterion (and whether it was answered) and the two balances. */
  'report.cashflow_reconcile.cash_accounts':
    'Cash: {accounts} ({defaulted, select, yes {criterion "{criterion}", by default} other {criterion "{criterion}"}}) · {opening} → {closing}',
  /** The statement ties to the real movement of cash. */
  'report.cashflow_reconcile.ties':
    'Ties: the cash flow statement equals the actual movement of cash.',
  /** The suspects offered with `--show-candidates`. */
  'report.cashflow_reconcile.suspects':
    '{count, plural, one {# suspect} other {# suspects}} — this is a LIST OF SUSPECTS, not a verdict: cash movements that no section of the statement seems to claim, or that it may be counting twice. Check them before touching anything.',
  /** How much of the residue the suspects explain. */
  'report.cashflow_reconcile.coverage':
    'They explain {explained} of the residue {amount}; {unexplained} remain that none of them explains.',
  /** A residue with no suspects to offer. */
  'report.cashflow_reconcile.no_suspects':
    'No suspects to offer: every cash movement of the period falls in a section of the statement, so the residue is in HOW they are added up, not in what was left out.',
  // ==== end of I8.1 ====

  // ==== I8.2 · CLI leaves by key, root family (issue #264) ====

  // MNE-001-219: `src/cli/mnemosine.ts` and `src/cli/close-command.ts`.
  /** `ingest`: the auto-post a flag or mnemosine.config.json asked for, and the panel does not authorize. */
  'root.ingest.auto_post_ignored':
    'Warning: the auto-post asked for by flag or by mnemosine.config.json is IGNORED: the firm\'s panel does not authorize it.',
  /** `ingest`: the second line of that warning, where turning it on belongs. */
  'root.ingest.auto_post_turn_on':
    'Turning it on belongs to the panel (`mnemosine pending`), and it requires the shadow evidence. Turning it off can be local.',
  /** `lang`: a language that is not one of the accepted spellings. */
  'root.lang.unsupported': 'Unsupported language "{language}". Options: {options}, or {languages}',
  /** The first-run prompt, asked with `yesNoPrompt(q, 'yes')`. */
  'root.setup.run_now': 'Run setup now?',
  // ==== end of I8.2 ====

  // ==== I8.3 · CLI leaves by key, family ar (issue #265) ====

  // MNE-001-220: receipt, invoice, customer and credit-note.
  /** `receipt apply` with no `--invoice`. */
  'ar.customer.show.book_value': 'Book value',
  'ar.receipt.invoice_missing':
    'Name the invoice or invoices: --invoice "INV-2026-00042:2500" (repeatable), or --invoice <ref> --amount <n>.',
  /** `receipt apply`: a bare invoice where its amount cannot come from --amount. */
  'ar.receipt.invoice_without_amount':
    'The invoice "{spec}" carries no amount. With several invoices each one carries its own ("number:amount"); with only one it can go in --amount.',
  /** `receipt record`: the key was already spent, and this is the recorded result. */
  'ar.receipt.idempotency_hit':
    '↩ Idempotency hit: the key "{key}" already spent this receipt ({number}). Nothing was written again; this is the recorded result.',
  /** `receipt show`: the REP of a receipt that has none. */
  'ar.receipt.no_rep': 'no REP — a tax obligation of its own, with a SAT deadline',
  /** The reason `receipt apply` does not honor --idempotency-key (`cli.risk.key_not_honored`). */
  'ar.receipt.retry_reallocates':
    'a retry allocates the on-account balance again and posts another entry',
  /** The reason `receipt unapply` does not honor --idempotency-key. */
  'ar.receipt.retry_unapplies': 'a retry unapplies again and posts another mirror',
  /** The reason `receipt reverse` does not honor --idempotency-key. */
  'ar.receipt.retry_reverses': 'a retry posts the mirrors of the reversal again',
  /** The reason `invoice issue` does not honor --idempotency-key. */
  'ar.invoice.retry_reissues': 'a retry issues again and posts the revenue a second time',
  /** The reason `invoice void` does not honor --idempotency-key. */
  'ar.invoice.retry_void_mirror': 'a retry posts the mirror of the void again',
  /** The reason `invoice delete` does not honor --idempotency-key. */
  'ar.invoice.delete_by_state':
    'the delete is unrepeatable only through the state of the draft, not through the key',
  /** The reason `credit-note issue` does not honor --idempotency-key. */
  'ar.credit_note.retry_reissues': 'a retry issues the note again and posts another entry',
  // ==== end of I8.3 ====

  // An invoice that holds a CFDI is not stamped again (MNE-001-763, #696).
  'ar.invoice.cfdi.already_stamped':
    'Invoice {id} was not stamped again: it already has a CFDI, folio {uuid} ({status}), stamped at ' +
    '{stamped_at}. A second stamp would be a second CFDI before the SAT for the same sale. Nothing was sent ' +
    'to the PAC and nothing was written.',
  'ar.invoice.cfdi.stamp_in_progress':
    'Invoice {id} was not stamped by this attempt: another stamp of it, or another change to it, is still in ' +
    'progress and this attempt stopped waiting. It sent nothing to the PAC and wrote nothing. Read the invoice ' +
    'before asking again: if the other stamp ended, the invoice carries its folio.',
  'ar.invoice.cfdi.stamped_not_recorded':
    'Invoice {id} WAS stamped: the PAC ({provider}) answered with folio {uuid}, and the folio could not be ' +
    'written on the invoice. Do not stamp it again. Keep this folio: the invoice does not carry it, and it is ' +
    'what a cancellation needs.',

  // ==== I8.4 · CLI leaves by key, family payroll (issue #266) ====

  // MNE-001-221: payroll accrue and the ISN leaves of payroll-isn.
  /** `payroll accrue` with no --period. */
  'payroll.accrue.period_required':
    '--period is missing. The benefit accrual belongs to one specific month and is not guessed from the clock: running "the current period" on the 1st at 00:05 would accrue the month that has just begun, and the entry cannot be deleted afterwards (mnemosine period list lists the entity\'s periods).',
  /** The reason of a skipped worker in the schedule. Stored English in the row; the table renders it. */
  'payroll.accrue.skip_already_accrued': 'already has a live row for this month',
  /** The other reason of a skipped worker. */
  'payroll.accrue.skip_zero_month': 'its accrual for the month is zero',
  /** The first line of a run: the period, the entry date, who accrues and the totals. */
  'payroll.accrue.summary':
    '{period} ({start}..{end}) · entry dated {entryDate} · {accruing, plural, one {# worker accrues} other {# workers accrue}}, {skipped, plural, one {# is skipped} other {# are skipped}} · aguinaldo {aguinaldo} · vacation {vacation} · premium {premium} · total {total}',
  /** The panel that governed the amounts, and which of it is a default. */
  'payroll.accrue.criteria':
    'salary base {baseDefaulted, select, yes {{base} (default)} other {{base}}} · vacation {vacationDefaulted, select, yes {{vacation} (default)} other {{vacation}}} · aguinaldo {days, plural, one {# day} other {# days}} · premium {premium}',
  /** When a declared default, not the firm, governs the amounts. */
  'payroll.accrue.default_criteria_warning':
    'At least one declared default governs here, not a choice of the firm: between `nominal` and `integrado` there is a 20 % difference in the amount of every month. Answer it with `mnemosine pending define provision_base_salarial` / `devengo_vacaciones`.',
  /** The heading over the entry the run would post. */
  'payroll.accrue.entry_heading':
    'The run\'s single entry, {lines, plural, one {# line} other {# lines}}:',
  /** A spent key whose recorded entry was reversed afterwards. */
  'payroll.accrue.key_entry_reversed':
    'The key "{key}" recorded entry {entry}, which was reversed afterwards. Returning that result would say the month is accrued when it is not. Run again with a new key (it is another run, not a retry) or without --idempotency-key.',
  /** A spent key: the recorded result is what is shown (two sites). */
  'payroll.accrue.idempotency_hit':
    'Idempotency key already spent: the recorded result is returned and nothing was accrued again.',
  /** A month with nobody to accrue. */
  'payroll.accrue.nothing_to_accrue':
    'Nothing to accrue in {period}: the ledger was not touched and no schedule row was written.',
  /** The dry run, which writes nothing. */
  'payroll.accrue.dry_run': 'Dry run: the ledger was not touched and no schedule row was written.',
  /** The confirmation question; the kernel adds the [y/N] suffix. */
  'payroll.accrue.confirm':
    'Accrue {amount} MXN for {count, plural, one {# worker} other {# workers}} in {period}? The ledger does not allow undoing it.',
  /** The person said no. */
  'payroll.accrue.aborted': 'Nothing changed: the ledger was not touched.',
  /** No terminal to ask on. */
  'payroll.accrue.aborted_no_terminal':
    'Nothing changed: there is no terminal to confirm on. Add -y to accrue without asking, or --dry-run to see the whole schedule without writing anything.',
  /** The run accrued another number of workers than the preview showed. */
  'payroll.accrue.preview_count_mismatch':
    'The preview showed {previewed, plural, one {# worker} other {# workers}} and the run accrued {processed}. Something changed between looking and posting: check the schedule before taking the month as closed.',
  /** The run accrued another total than the preview added up to. */
  'payroll.accrue.preview_total_mismatch':
    'The preview added up to {previewed} and the run accrued {posted}.',
  /** The done line, with the entry when there is one. */
  'payroll.accrue.done':
    '{count, plural, one {# worker accrued} other {# workers accrued}} in {period} {hasEntry, select, yes {for {total} · entry {entry}} other {for {total}}}.',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.state': 'state',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.rate': 'rate',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.regime': 'regime',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.monthly_exemption': 'monthly exemption',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.in_force': 'in force',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.legal_basis': 'legal basis',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.table': 'table',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.criterion': 'criterion',
  /** A label of the ISN capture preview. */
  'payroll.isn_rate_set.reaches': 'reaches',
  /** A rate captured with no end date. */
  'payroll.isn_rate_set.open_ended': '(no end: still in force)',
  /** What the ISN rate table is. */
  'payroll.isn_rate_set.table_note':
    '(catalogue, no tenant_id: the law is the same for every firm)',
  /** A policy nobody answered, read at its default (`policyPair`). */
  'payroll.isn.policy_default': '{value} (default, nobody answered)',
  // ==== end of I8.4 ====

  // ==== I8.5 · CLI leaves by key, family assets-inventory (issue #267) ====

  // MNE-001-222: depreciation run/post and asset create.
  /** `depreciation run --by` with a dimension that does not exist. */
  'assets.depreciation.by_unknown':
    '--by "{value}" does not exist. The four dimensions are: {dimensions} (asset is the asset-by-asset detail; class and account are the summaries by class and by expense destination the catalogue asks for).',
  /** `depreciation run`/`post` with no --period. */
  'assets.depreciation.period_required':
    '--period is missing. Depreciation belongs to one specific month and is not guessed from the clock: running "the current period" on the 1st at 00:05 would depreciate the month that has just begun.',
  /** The group of the assets with no class in `--by class`. Stored English in the row; the table renders it. */
  'assets.depreciation.no_class': '(no class)',
  /** The first line of a plan: the period, the book, the entry date and the fingerprint. */
  'assets.depreciation.header':
    '{period} ({start}..{end}) · {book} book · entries dated {entryDate} · fingerprint {fingerprint}',
  /** The criteria of a plan, which of them is a default, and who enters. */
  'assets.depreciation.criteria':
    'base {baseDefaulted, select, yes {{base} (default)} other {{base}}} · convention {conventionDefaulted, select, yes {{convention} (default)} other {{convention}}} · {entering, plural, one {# asset enters} other {# assets enter}}, {skipped, plural, one {# is skipped} other {# are skipped}}, total {total}',
  /** The warning when a declared default and not a choice of the firm governs the plan. */
  'assets.depreciation.default_criteria_warning':
    'At least one declared default governs here, not a choice of the firm. Answer it with `mnemosine pending define base_depreciacion` / `convencion_primer_mes`.',
  /** The heading of the skipped assets in the readable output. */
  'assets.depreciation.skipped_heading': 'Skipped ({count}):',
  /** The warning when assets are left owing their row for the period. */
  'assets.depreciation.missing_rows_warning':
    '{pending, plural, one {# asset is} other {# assets are}} left without a row for {period}, and the month should recognise it. The policy `depreciacion_faltante_al_cierre` is {defaulted, select, yes {"{policy}" (declared default)} other {"{policy}"}}.',
  /** `depreciation run` blocked by --strict or by the policy. */
  'assets.depreciation.run_blocked':
    '{pending, plural, one {# asset} other {# assets}} without a row for {period}. {cause, select, strict {--strict turns the warning into a block.} other {The policy `depreciacion_faltante_al_cierre` is set to "bloquear".}} `depreciation post` will refuse to post until they are resolved.',
  /** `depreciation run` with nothing that enters. */
  'assets.depreciation.nothing_this_book': 'Nothing to post in this period with this book.',
  /** `depreciation post --file` when the approved plan no longer matches. */
  'assets.depreciation.plan_changed':
    'The plan approved in {file} no longer matches what the run would do today, so nothing is posted: {differences}. Run `depreciation run` again, review the new plan and post against that one.',
  /** `depreciation post` refused by the policy while assets owe their row. */
  'assets.depreciation.post_blocked':
    'Nothing is posted: {pending, plural, one {# asset is} other {# assets are}} left without a row for {period} and the policy `depreciacion_faltante_al_cierre` is set to "bloquear". Resolve them (capture the period\'s production, correct the asset record) or change the policy with {hint}.',
  /** `depreciation post` with nothing that enters. */
  'assets.depreciation.nothing_to_post': 'Nothing to post in {period}: the ledger was not touched.',
  /** The note under the entry preview: N entries, N reversals. */
  'assets.depreciation.entries_note':
    '{count, plural, one {# two-line entry} other {# two-line entries}}, one per asset, not a single one for the run. Reversing this run takes {count, plural, one {# reversal} other {# reversals}}.',
  /** The confirmation of `depreciation post`. */
  'assets.depreciation.confirm':
    'Post {total} in {count, plural, one {# entry} other {# entries}} of the {book} book for {period}? The ledger does not allow undoing it.',
  /** A replayed idempotency key. */
  'assets.depreciation.idempotency_hit':
    'Idempotency key already spent: the recorded result is returned and nothing was posted again.',
  /** The run made a different number of entries than the plan showed. */
  'assets.depreciation.plan_count_mismatch':
    'The plan showed {planned, plural, one {# entry} other {# entries}} and the run made {processed}. The plan and the engine did not agree: check the errors before taking the month as closed.',
  /** The done line of `depreciation post`. */
  'assets.depreciation.done':
    '{count, plural, one {# entry posted} other {# entries posted}} in {period} ({book} book).',
  /** `asset create` with an amount that is not an unsigned decimal. */
  'assets.asset.amount_invalid':
    '{flag} must be an unsigned decimal amount; got "{value}". The point separates the decimals and the comma is ignored: 1,250,000.50 and 1250000.50 are the same.',
  /** `asset create` with a depreciation method that does not exist. */
  'assets.asset.method_unknown': '{flag} "{value}" does not exist. The six methods are: {methods}.',
  /** `asset create --capitalized` with a value it cannot read. */
  'assets.asset.capitalized_unknown':
    '--capitalized "{value}" is not understood: it is yes when the cost is ALREADY charged to the asset account in the ledger (the CFDI that was capitalised), and no when the record only registers the asset and the entry is pending. It has no default: assuming one doubles the asset or leaves it out of the ledger.',
  /** `asset create` without its required flags. */
  'assets.asset.create_missing':
    '{missing} missing. An asset with no class, no cost, no acquisition date or no statement of where its cost already is is not an incomplete record: it is a record that can be neither depreciated nor reconciled with the ledger.',
  /** `asset create --source-entry` together with `--capitalized no`. */
  'assets.asset.source_entry_contradiction':
    '--source-entry names the entry where the cost ALREADY is, so it cannot be passed with `--capitalized no`, which says the opposite. Decide which of the two is true.',

  // ==== end of I8.5 ====

  // ==== I8.6 · CLI leaves by key, family platform (issue #268) ====

  // MNE-001-223: the backup leaves (create, export, list, verify, restore).
  /** A backup or export with no manifest beside it. Stored English in `backup list`'s row; the table renders it. */
  'platform.backup.no_manifest': '(no manifest)',
  /** The schema a backup was taken at. */
  'platform.backup.schema_of': 'schema {schema}',
  /** The manifest beside a backup or an export. */
  'platform.backup.manifest_line': 'manifest: {file}',
  /** `backup create` with --tenant or --entity. */
  'platform.backup.create.not_scoped':
    '`backup create` dumps the WHOLE installation with pg_dump, which does not filter rows: narrowing it to one tenant or one entity is impossible by construction, and until now the flag was accepted and silently ignored.\nFor the archive of ONE firm: `mnemosine backup export --tenant <id>` (with `--entity <id|name>` for a single company).\nFor disaster recovery of the whole installation: `backup create` with no flags.',
  /** Whose data a whole-installation dump carries. */
  'platform.backup.create.unredacted':
    'It holds the UNREDACTED data of {tenants, plural, one {# tenant} other {# tenants}}: it is the whole installation, not one firm.',
  /** Where the archive of one firm comes from. */
  'platform.backup.create.one_tenant_hint': 'For the archive of one only: `mnemosine backup export --tenant <id>`.',
  /** The heading of what a dump does not carry. */
  'platform.backup.create.no_crypto': 'And it does NOT include the cryptographic material:',
  /** Why the vault key and ENCRYPTION_KEY are backed up separately. */
  'platform.backup.create.crypto_detail':
    'the vault key and ENCRYPTION_KEY live outside the database. Without them, after a restore the fiscal credentials and the bank data are unreadable. Back them up separately.',
  /** The reminder to rehearse the restore. */
  'platform.backup.create.untested_hint':
    'And an untested backup is not a backup: `mnemosine backup verify <file> --restore`.',
  /** `backup export` with no tenant. */
  'platform.backup.export.tenant_required':
    'There is no tenant to export. Name it with `--tenant <uuid>` or set MNEMOSINE_TENANT.\nA file that does not say whose it is cannot be kept in custody, so this is not guessed.',
  /** The owner of an entity-scoped export. */
  'platform.backup.export.entity_of': '{entity} (entity of {tenant})',
  /** The size of an export. */
  'platform.backup.export.size':
    '({mb} MB · {rows, plural, one {# row} other {# rows}} · {tables, plural, one {# table} other {# tables}})',
  /** The scope of an export and whose it is. */
  'platform.backup.export.scope_line': 'scope: {scope} — {owner}',
  /** How an export was read. */
  'platform.backup.export.read_as': 'read as {role}, subject to RLS, in a single REPEATABLE READ snapshot',
  /** Why an export is not a backup. */
  'platform.backup.export.not_a_backup': 'This is an EXPORT, not a backup: there is no tested way back.',
  /** Where disaster recovery comes from. */
  'platform.backup.export.disaster_hint': 'For disaster recovery: `mnemosine backup create` + `backup restore`.',
  /** The scoped tables an export leaves out. */
  'platform.backup.export.out_of_scope':
    '{count, plural, one {# scoped table is} other {# scoped tables are}} left outside this scope; the manifest names them one by one.',
  /** What an export carries. */
  'platform.backup.export.unredacted':
    "It carries the firm's unredacted data, third-party RFCs included: treat it as such.",
  /** `backup list --status`. */
  'platform.backup.list.no_status':
    '`backup list` has no status to filter: a backup is a file, not a document with a lifecycle.',
  /** `backup list` with --tenant or --entity. */
  'platform.backup.list.not_scoped':
    '`backup list` inventories a DIRECTORY, and it does not filter by scope yet: the flag was accepted and ignored.\nThe «scope» column of the output already says whose each file is (tenant, entity or whole installation), so for now the filter is done by reading it.',
  /** The scope of a whole-installation dump. Stored English in the row; the table renders it. */
  'platform.backup.list.scope_installation':
    'installation ({tenants, plural, one {# tenant} other {# tenants}})',
  /** The same, when an old manifest does not say how many tenants. */
  'platform.backup.list.scope_installation_unknown': 'installation (unknown tenants)',
  /** A backup whose hash still matches. Stored English in the row; the table renders it. */
  'platform.backup.list.intact_yes': 'yes',
  /** A backup whose restore was never rehearsed. Stored English in the row; the table renders it. */
  'platform.backup.list.never_verified': 'never',
  /** When the restore was last rehearsed, and its findings. Stored English in the row; the table renders it. */
  'platform.backup.list.verified_on': '{date} ({findings, plural, one {# finding} other {# findings}})',
  /** An export has no restore to rehearse. Stored English in the row; the table renders it. */
  'platform.backup.list.export_not_verified': 'n/a (export, not restorable)',
  /** `backup verify` of a file that is not there. */
  'platform.backup.verify.not_found': 'The backup {file} was not found',
  /** The cheap verify, when the hash matches. */
  'platform.backup.verify.hash_ok': 'hash and manifest match',
  /** The hash does not match the manifest. */
  'platform.backup.verify.hash_mismatch': 'the hash does NOT match the manifest',
  /** What the cheap verify does not prove. */
  'platform.backup.verify.not_proof': 'This does NOT prove the backup restores.',
  /** The reminder to rehearse the restore. */
  'platform.backup.verify.repeat_with_restore': 'An untested backup is not a backup: run it again with --restore.',
  /** The rehearsed restore worked. */
  'platform.backup.verify.restored': 'restored into a throwaway database',
  /** The rehearsed restore failed. */
  'platform.backup.verify.not_restored': 'did NOT restore',
  /** What the rehearsed restore checked. */
  'platform.backup.verify.counts':
    '{entities, plural, one {# entity checked} other {# entities checked}} · {findings, plural, one {# finding} other {# findings}}',
  /** Why `backup restore` does not honour an idempotency key. */
  'platform.backup.restore.retry_restores': 'a retry restores again over what was already restored',
  /** The dry run of `backup restore`. */
  'platform.backup.restore.would_restore': 'Would restore {file} into a NEW database "{database}"',
  /** The dry run writes nothing. */
  'platform.backup.restore.nothing_written': 'Nothing is written, and no existing database is ever touched.',
  /** The confirmation of `backup restore`. */
  'platform.backup.restore.confirm': 'Create database "{database}" and restore {file} into it?',
  /** `backup restore` with no terminal to confirm on. */
  'platform.backup.restore.no_terminal':
    '{question} — there is no terminal to ask on. Re-run with --yes once you are sure.',
  /** The done line of `backup restore`. */
  'platform.backup.restore.done': 'restored into the database {database}',
  /** The previous database is untouched. */
  'platform.backup.restore.previous_intact':
    'The previous database is still intact: pointing the application at the new one is a separate act.',
  /** The reminder to verify the restored database. */
  'platform.backup.restore.check_first': 'Check it first: mnemosine backup verify {file} --restore',


  // MNE-001-224: audit, ai stats and jobs run-due.
  /** `audit list --user` with an email that is not in the tenant. */
  'platform.audit.user_not_found':
    'User "{email}" in this tenant. The trail was not filtered: an email that does not exist would return zero rows and read as if that person did nothing.',
  /** `audit list --limit` with a value that is not a positive whole number. */
  'platform.audit.list.limit_invalid': '--limit must be a positive whole number; got "{value}".',
  /** `audit list --action` with an action outside the CHECK of audit_log. */
  'platform.audit.list.action_unknown':
    'Unknown action "{action}". The vocabulary is fixed by the CHECK of audit_log (migration 001): {actions}.',
  /** `audit list --actor agent`: the trail has no actor column yet. */
  'platform.audit.list.actor_agent_unsupported':
    'The trail does not tell the agent apart yet: `audit_log` has no actor column and each row is attributed to a human `user_id`. Filtering by "{actor}" would return zero rows, which would read as if the agent did nothing. The `actor` column (and `agent_session_id`) is missing, and the agent\'s bridge has to write it; until then, `--actor human` or no flag is all there is.',
  /** `audit list --actor` with any other value. */
  'platform.audit.list.actor_invalid': '--actor only accepts "human", "agent" or "agent:<session>"; got "{actor}".',
  /** `audit list --object` with an unknown family. */
  'platform.audit.list.object_unknown':
    'Unknown object family "{object}". Known: {families}. For an exact value of the column use --entity-type.',
  /** `audit list --object` and `--entity-type` that do not intersect. */
  'platform.audit.list.object_type_disjoint':
    '--object "{object}" and --entity-type "{type}" do not intersect: the family does not contain that type. Give one of the two.',
  /** The actor of a row whose user no longer exists. Stored English in the row; the table renders it. */
  'platform.audit.list.user_removed': '(user removed)',
  /** `audit list` with no rows. */
  'platform.audit.list.no_rows':
    'No rows. The trail belongs to the TENANT: `audit_log` has no legal-entity column, so --entity only chose which tenant to look at.',
  /** A label of `audit show`. */
  'platform.audit.show.when': 'when',
  /** A label of `audit show`. */
  'platform.audit.show.who': 'who',
  /** A label of `audit show`. */
  'platform.audit.show.why': 'why',
  /** `audit show` of a row whose user no longer exists. */
  'platform.audit.show.user_unknown': "(unknown user: the log is append-only and outlives the user's record)",
  /** `audit show` of a row with no reason. */
  'platform.audit.show.no_reason': '(no reason recorded)',
  /** `audit show` of a row with no values. */
  'platform.audit.show.no_values': 'no values: the row records the act, not the before and the after',
  /** The first line of `ai stats`. */
  'platform.ai.stats.header':
    'ai stats · {entity} · {drafts, plural, one {# draft} other {# drafts}}, {decided, plural, one {# decided} other {# decided}}',
  /** How much still goes through a person. */
  'platform.ai.stats.human_intervention':
    'human intervention {rate} ({human} approved + {rejected} rejected of {decided} decided; {policy} by policy, {auto} auto-posted)',
  /** The ingest runs and their cost, when the model has a price. */
  'platform.ai.stats.ingest':
    'ingest: {runs, plural, one {# run} other {# runs}}, {drafts, plural, one {# draft} other {# drafts}}{priced, select, yes {, ~${perDraft} USD per draft (total ${total})} other {, cost not estimable (model without a price)}}',
  /** The model's latency. */
  'platform.ai.stats.latency':
    'model latency: {average} ms average, {p95} ms p95 ({calls, plural, one {# call measured} other {# calls measured}})',
  /** The agent's events. */
  'platform.ai.stats.events':
    'events: {suspicions, plural, one {# injection suspicion} other {# injection suspicions}}, {nudges, plural, one {# grounding nudge} other {# grounding nudges}}, {failovers, plural, one {# failover} other {# failovers}}',
  /** The shadow history, and the floors `on` requires (src/ai/floor.ts). */
  'platform.ai.stats.shadow':
    'shadow: {verdicts, plural, one {# verdict} other {# verdicts}} over {days, plural, one {# day} other {# days}}, {decided, plural, one {# decided} other {# decided}} by a person, agreement {agreement} (turning "on" requires ≥{minDays} days, ≥{minDecided} decided and ≥{minAgreement})',
  /** Why `jobs run-due` does not honour an idempotency key. */
  'platform.jobs.run_due.retry_reruns': 'a retry runs the due jobs again',

  // MNE-001-453 (#646): which due jobs `jobs run-due` runs on its operator's credential.
  /** The first line of a tick under `jobs.run_due = all`. */
  'platform.jobs.run_due.all_first_line':
    'jobs.run_due is "all": this tick runs every due job of the entity on your credential, including jobs that other people created.',
  /** A due job a tick under `jobs.run_due = adopted` did not run. */
  'platform.jobs.run_due.skipped': '  not adopted, not run: {name}  {id} · adopt it: mnemosine jobs adopt {id}',
  /** A tick under `jobs.run_due = adopted` that found due jobs, none of them adopted. */
  'platform.jobs.run_due.no_adopted_due': 'No adopted job due.',
  /** The notice of an unset tick: the jobs it ran that its operator has not adopted. */
  'platform.jobs.run_due.hint.header':
    '{count, plural, one {This tick ran # job you have not adopted, on your credential:} other {This tick ran # jobs you have not adopted, on your credential:}}',
  /** The notice of an unset tick: the key and its two values. */
  'platform.jobs.run_due.hint.choose':
    'Set jobs.run_due in ~/.mnemosine/config.json to "adopted" to run only the jobs you adopted (mnemosine jobs adopt <id>), or to "all" to run every due job without this notice.',
  /** A project file that sets `jobs.run_due`, which is not read there. */
  'platform.jobs.run_due.project_key_ignored':
    '{file} sets jobs.run_due, which is not read there: whose credential a tick spends is each operator\'s choice, in ~/.mnemosine/config.json.',
  /** An unset tick whose list of adopted jobs does not read. */
  'platform.jobs.run_due.adoptions_unreadable': '{error} This tick runs every due job, as it does with jobs.run_due unset.',
  /** `jobs adopt` of a job. */
  'platform.jobs.adopt.done':
    'Job "{name}" adopted. With jobs.run_due set to "adopted", jobs run-due runs it on your credential. Recorded in {file}.',
  /** `jobs adopt` of a job already adopted. */
  'platform.jobs.adopt.already': 'Job "{name}" was already adopted ({file}).',
  /** `jobs adopt` of an id that is not a job of this entity. */
  'platform.jobs.adopt.not_found': 'Job {id} does not exist in this entity; nothing was adopted.',
  /** `jobs adopt` with both a job id and --list, or with neither. */
  'platform.jobs.adopt.id_xor_list': 'Give either a job id to adopt, or --list to see the jobs you adopted.',
  /** The header of `jobs adopt --list`. */
  'platform.jobs.adopt.list.header': 'Jobs you adopted in this entity ({file}):',
  /** `jobs adopt --list` with nothing adopted in this entity. */
  'platform.jobs.adopt.list.none': 'You have adopted no job of this entity. Adopt one with: mnemosine jobs adopt <id>',
  /** An adopted id that is no longer a job of this entity. */
  'platform.jobs.adopt.list.gone': '(no longer a job of this entity)',
  /** The last line of `jobs adopt --list`: the value of the key. */
  'platform.jobs.adopt.list.scope':
    'jobs.run_due in {file}: {scope, select, adopted {"adopted", so jobs run-due runs only these} all {"all", so jobs run-due runs every due job} other {unset, so jobs run-due runs every due job and names the ones you have not adopted}}',
  /** `jobs unadopt` of an adopted job. */
  'platform.jobs.unadopt.done': 'Job {id} is no longer adopted ({file}).',
  /** `jobs unadopt` of a job that was not adopted. */
  'platform.jobs.unadopt.not_adopted': 'Job {id} was not adopted; nothing changed.',
  /** `jobs create`: the new job is adopted for its creator. */
  'platform.jobs.create.adopted': '  Adopted for you: with jobs.run_due set to "adopted", your tick runs it.',
  /** `jobs create` whose adoption could not be written. */
  'platform.jobs.create.adopt_failed':
    'The job was created, but it could not be adopted for you ({error}). Adopt it with: mnemosine jobs adopt {id}',

  // MNE-001-587 (#268): what jobs prints to a person, English byte for byte as before.
  // The two «(s)» stay in English for that reason; Spanish takes the plural.
  /** `jobs list` with no job. */
  'platform.jobs.list.none': 'No jobs configured. Create one with `mnemosine jobs create`.',
  /** The header cells of `jobs list` (the ID column is a literal: the same word in both languages). */
  'platform.jobs.list.column.name': 'NAME',
  'platform.jobs.list.column.kind': 'KIND',
  'platform.jobs.list.column.schedule': 'SCHEDULE',
  'platform.jobs.list.column.enabled': 'ENABLED',
  'platform.jobs.list.column.fails': 'FAILS',
  'platform.jobs.list.column.next_run': 'NEXT RUN',
  /** The ENABLED cell of `jobs list`. */
  'platform.jobs.list.enabled': '{enabled, select, yes {yes} other {no}}',
  /** `jobs history` with no run. */
  'platform.jobs.history.none': 'No runs recorded yet.',
  /** The header cells of `jobs history`. */
  'platform.jobs.history.column.started': 'STARTED',
  'platform.jobs.history.column.job': 'JOB',
  'platform.jobs.history.column.status': 'STATUS',
  'platform.jobs.history.column.drafts': 'DRAFTS',
  'platform.jobs.history.column.detail': 'DETAIL',
  /** `jobs create`: the receipt, its summary line and the tick hint. */
  'platform.jobs.create.done': 'Job created: {id}',
  'platform.jobs.create.summary': '{name} ({kind}) · schedule {schedule} · next run {next}',
  'platform.jobs.create.wire_tick': 'Wire the tick: schedule `mnemosine jobs run-due` in cron/launchd.',
  /** `jobs enable` and `jobs disable`. */
  'platform.jobs.enable.done': 'Job "{name}" enabled · next run {next}',
  'platform.jobs.disable.done': 'Job "{name}" disabled.',
  /** `jobs run-due --dry-run --idempotency-key`: the key is read and ignored. */
  'platform.jobs.run_due.key_not_applied':
    '--idempotency-key does not apply to the tick: each due job is claimed atomically, and deduplicating ticks would silently skip legitimate runs.',
  /** A tick that finds no due job. */
  'platform.jobs.run_due.none': 'No jobs due.',
  /** A line of the dry run, and its next-run cell. */
  'platform.jobs.run_due.would_run': 'would run: {name}  {kind}  {next}',
  'platform.jobs.run_due.next_run': 'next_run {date}',
  /** The last line of the dry run. */
  'platform.jobs.run_due.dry_run_summary': '(dry-run: {count} job(s) due; nothing was claimed or run)',
  /** A tick without --live. */
  'platform.jobs.run_due.sandbox':
    'sandbox: jobs run without the external reads (external_pull / external_diff_trial_balance). A reconciliation cron needs the full surface: schedule `mnemosine jobs run-due --live`.',
  /** The drafts cell of each outcome of a tick. */
  'platform.jobs.run_due.outcome_drafts': 'drafts: {count}',
  /** A job its failure limit disabled during this tick. */
  'platform.jobs.run_due.auto_disabled':
    'Job "{name}" reached its failure limit and was auto-disabled. Re-enable with: mnemosine jobs enable {id}',
  /** A run the history could not record. */
  'platform.jobs.run_due.record_failed': 'Run of "{name}" could not be recorded in the history: {error}',
  /** The drafts a tick created. */
  'platform.jobs.run_due.drafts_created': '{count} draft(s) created — review them with `mnemosine review`.',

  /** Help of `jobs adopt`. */
  'help.jobs.adopt.description':
    'Adopt a job: with jobs.run_due set to "adopted" in ~/.mnemosine/config.json, jobs run-due runs only the jobs you adopted',
  /** Help of the job id of `jobs adopt`. */
  'help.jobs.adopt.argument.job_id': 'Job id (omit it with --list)',
  /** Help of `jobs adopt --list`. */
  'help.jobs.adopt.option.list': 'List the jobs you adopted in this entity, and the value of jobs.run_due',
  /** Help of `jobs unadopt`. */
  'help.jobs.unadopt.description': 'Stop adopting a job: with jobs.run_due set to "adopted", jobs run-due no longer runs it',
  /** Help of the job id of `jobs unadopt`. */
  'help.jobs.unadopt.argument.job_id': 'Job id',

  // ==== end of I8.6 ====

  // ==== I8.7 · CLI leaves by key, family fiscal-mx (issue #269) ====

  // MNE-001-225: e-accounting (catalog and balance: generate, check, the -o overwrite).
  /** The warning of every generate leaf: the file is not sealed and nothing was filed. */
  'fiscal_mx.e_accounting.unsealed.headline': 'THIS FILE IS NOT SEALED AND NOTHING WAS FILED WITH THE SAT.',
  /** Under the headline: building and signing are not the same act. */
  'fiscal_mx.e_accounting.unsealed.two_hands': 'Building the file and signing it are separate acts, by separate hands.',
  /** Step 1 of what is left to file. Stored English in the receipt's `falta_para_presentar`; the table renders it. */
  'fiscal_mx.e_accounting.unsealed.step_review':
    'Review the XML: it is the document you are going to file, and once it is sealed it is not touched again.',
  /** Step 2: the seal, outside the system or under sellar_con_custodia. */
  'fiscal_mx.e_accounting.unsealed.step_seal':
    'Seal it with the taxpayer\'s e.firma: outside this system or, if the firm declared sellar_con_custodia, with this family\'s seal leaf. No one will ask you for the e.firma by chat.',
  /** Step 3: the upload, which no command does. */
  'fiscal_mx.e_accounting.unsealed.step_upload':
    'Compress it and upload it yourself through the Buzón Tributario (Contabilidad electrónica).',
  /** Step 4: the acknowledgements, the only proof of filing. */
  'fiscal_mx.e_accounting.unsealed.step_acknowledgements':
    'Keep the acknowledgement of receipt and, later, the one of acceptance or rejection: it is the only proof that it was filed.',
  /** `catalog generate`/`seal` with no --period. */
  'fiscal_mx.e_accounting.catalog.period_missing':
    'The chart of accounts is filed by month: give --period YYYY-MM (for example --period 2026-02). Without it there is no Mes or Anio to declare in the header.',
  /** A --period that is not YYYY-MM. */
  'fiscal_mx.e_accounting.catalog.period_not_month':
    '--period "{value}" is not a month. The CtaCatalogo declares ONE month of ONE fiscal year, so only the form YYYY-MM (2026-02) is valid here. A quarter, a fiscal year or a range has nowhere to go in the file.',
  /** A month outside 01..12; 13 belongs to the closing balance. */
  'fiscal_mx.e_accounting.catalog.month_out_of_range':
    '--period "{value}": the month must run from 01 to 12. Month 13 belongs to the year-end balance (`balance generate --closing`), not to the chart of accounts.',
  /** The line beside the CtaCatalogo title. */
  'fiscal_mx.e_accounting.catalog.summary':
    'RFC {rfc} · {accounts, plural, one {# account} other {# accounts}} · {bytes, plural, one {# byte} other {# bytes}}',
  /** The three panel criteria the catalog was built with (their values are not translated). */
  'fiscal_mx.e_accounting.catalog.policies': 'levels {levels} · without grouping code {ungrouped} · sealing {sealing}',
  /** Accounts the levels criterion left out of the file. */
  'fiscal_mx.e_accounting.catalog.omitted':
    '{count, plural, one {# account left} other {# accounts left}} out of the file',
  /** No file: accounts without a grouping code under the blocking policy, or blocking findings. */
  'fiscal_mx.e_accounting.catalog.not_deliverable':
    'No deliverable file was produced. {reason, select, ungrouped {{count, plural, one {# account in scope has no grouping code} other {# accounts in scope have no grouping code}} and the policy `{policy}` is set to \'{value}\'. {count, plural, one {Assign it} other {Assign them}}, or change the policy with {hint}.} other {Resolve the blocking findings above and generate again.}}',
  /** A --type other than N or C. */
  'fiscal_mx.e_accounting.balance.type_unknown':
    '--type "{value}" does not exist: N is the normal balance and C the amended one. The year-end balance is not a type, it is --closing (filed as Mes 13).',
  /** `--check` names a check that does not exist. */
  'fiscal_mx.e_accounting.balance.check_unknown':
    '{count, plural, one {Unknown check} other {Unknown checks}}: {unknown}. The available ones are: {available}.',
  /** `--check` with only commas. */
  'fiscal_mx.e_accounting.balance.check_empty': '--check named no check. The available ones are: {available}.',
  /** The title of the balance header. */
  'fiscal_mx.e_accounting.balance.title': 'Trial balance {month}/{year}',
  /** The line beside the balance title. */
  'fiscal_mx.e_accounting.balance.header':
    'RFC {rfc} · {closing, select, yes {TipoEnvio {type} · closing (Mes 13)} other {TipoEnvio {type}}} · {period} {from} → {to} · {accounts, plural, one {# account} other {# accounts}}',
  /** The criteria of the balance, and whether its SaldoIni can still change. */
  'fiscal_mx.e_accounting.balance.header_policies':
    'levels {levels} · sealing {sealing} · SaldoIni from {origin}, {firm, select, yes {firm} other {MAY STILL CHANGE (the previous period is still open)}}',
  /** The SAT file name of the balance. */
  'fiscal_mx.e_accounting.balance.suggested_file':
    'suggested file {file} · {bytes, plural, one {# byte} other {# bytes}}',
  /** After `e_accounting.sealing.declared` in `balance generate`: where the seal is. */
  'fiscal_mx.e_accounting.balance.seal_hint': 'Review it and seal it with {command}.',
  /** The envelope of `balance check --json`, on stderr. */
  'fiscal_mx.e_accounting.balance.check_envelope':
    '{rfc} · trial balance {month}/{year} · {period} · {accounts, plural, one {# account} other {# accounts}} · checks: {checks}',
  /** The catalog the balance was checked against, if any. */
  'fiscal_mx.e_accounting.balance.check_catalog': 'matching catalog: {found, select, yes {{source}} other {none}}',
  /** The checks `balance check` ran. */
  'fiscal_mx.e_accounting.balance.checks_run': 'checks: {checks}',
  /** `balance check` with no findings. */
  'fiscal_mx.e_accounting.balance.check_clean':
    'no findings: the trial balance passes the {count, plural, one {# check} other {# checks}} asked for.',
  /** `balance check` with findings. `blocking` is a plural in both catalogues, with two equal English branches. */
  'fiscal_mx.e_accounting.balance.check_summary':
    '{blocking, plural, one {# blocking} other {# blocking}}, {warning, plural, one {# warning} other {# warnings}}. A blocking finding stops the file from being generated.',
  /** `-o` names a file that exists: it may be the sealed one. */
  'fiscal_mx.e_accounting.output.overwrite_question':
    '{target} already exists. If that file is already sealed, overwriting it leaves it without its seal. Replace it?',
  /** The overwrite was declined. */
  'fiscal_mx.e_accounting.output.kept':
    'Nothing was written: {target} is kept as it was. Use another path, or --yes if you really want to replace it.',

  // MNE-001-226: diot (generate, check, export: the not-filed block, the header and totals, the verdicts).
  /** The warning of every diot leaf: the DIOT was not filed, and the output is not the return. */
  'fiscal_mx.diot.unfiled.headline': 'THIS DIOT WAS NOT FILED AND THIS FILE IS NOT THE RETURN.',
  /** Under the headline: building the return and filing it are not the same act. */
  'fiscal_mx.diot.unfiled.two_hands': 'Building the return and filing it are separate acts, by separate hands.',
  /** Step 1 of what is left to file. Stored English in the receipt's `falta_para_presentar`; the table renders it. */
  'fiscal_mx.diot.unfiled.step_tie_out':
    'Tie the working paper out against the month\'s movement of the creditable IVA account: if it does not match to the cent, do not capture — "almost matches" is a request from the SAT within a year.',
  /** Step 2: the capture in the portal, which no command does. */
  'fiscal_mx.diot.unfiled.step_capture':
    'Capture or upload the return YOURSELF in the SAT portal. This binary does not enter the portal, does not load the e.firma and files nothing.',
  /** Step 3: the acknowledgement, the only proof of filing. */
  'fiscal_mx.diot.unfiled.step_acknowledgement':
    'Keep the acknowledgement with its operation number: it is the only proof that it was filed.',
  /** Step 4: recording the acknowledgement, which has no command yet. */
  'fiscal_mx.diot.unfiled.step_record':
    'Record the acknowledgement in the month\'s file. That record has NO command YET (`diot record` is not built).',
  /** `diot` with no --period. */
  'fiscal_mx.diot.period.missing':
    'The DIOT is filed by month: give --period YYYY-MM (for example --period 2026-02). Without it there is no period to declare.',
  /** A --period that is not YYYY-MM. */
  'fiscal_mx.diot.period.not_month':
    '--period "{value}" is not a month. The DIOT is monthly (LIVA art. 32 fr. VIII), so only the form YYYY-MM (2026-02) is valid here. A quarter or a fiscal year is not declared.',
  /** A month outside 01..12; 13 belongs to the year-end balance of Anexo 24. */
  'fiscal_mx.diot.period.month_out_of_range':
    '--period "{value}": the month must run from 01 to 12. Month 13 belongs to the year-end balance of Anexo 24 (`e-accounting balance generate --closing`); an informative return has no month 13.',
  /** What `--check hecho-pagado` verifies. Stored English in the `detalle` column; the table renders it. */
  'fiscal_mx.diot.check.paid_event':
    'the event the DIOT declares exists in the ledger and releases no more IVA than is parked',
  /** What `--check desglose-por-tasa` verifies. */
  'fiscal_mx.diot.check.rate_breakdown':
    'each expense is split by rate (16/8/0/exempt) and the sum reproduces the IVA of the header',
  /** What `--check base-de-lo-exento` verifies. */
  'fiscal_mx.diot.check.exempt_base':
    'exempt acts declare their base, which is what the DIOT reports even when there is no tax',
  /** What `--check tercero-identificado` verifies. */
  'fiscal_mx.diot.check.third_party_identified':
    'each third party arrives with a usable RFC, or with tax ID, country and nationality if foreign',
  /** What `--check tipo-de-operacion` verifies. */
  'fiscal_mx.diot.check.operation_type':
    'each third party carries a captured operation type that the 2025 catalogue allows for its type of third party, not an assumed one',
  /** What `--check creditable-iva-proportion` verifies (LIVA art. 5 frac. V). */
  'fiscal_mx.diot.check.creditable_iva_proportion':
    'all IVA is declared as tied exclusively to taxed activities only if the ledger has no exempt revenue in the fiscal year',
  /** What `--check politica-en-catalogo` verifies. */
  'fiscal_mx.diot.check.catalog_policy': 'the DIOT policies hold a value their own catalogue allows',
  /** The envelope of `diot check --json`, on stderr. */
  'fiscal_mx.diot.check.envelope':
    '{rfc} · DIOT {month}/{year} · {parties, plural, one {# third party} other {# third parties}} · creditable IVA paid {amount} · checks: {checks}',
  /** `diot check` with no findings. */
  'fiscal_mx.diot.check.clean':
    'no findings: the DIOT passes the {count, plural, one {# check} other {# checks}} asked for.',
  /** `diot check` with findings. `blocking` is a plural in both catalogues, with two equal English branches. */
  'fiscal_mx.diot.check.summary':
    '{blocking, plural, one {# blocking} other {# blocking}}, {warning, plural, one {# warning} other {# warnings}}. A blocking finding stops the return from being captured.',
  /** The line beside the DIOT title. */
  'fiscal_mx.diot.header.summary':
    'RFC {rfc} — {name} · {from} → {to} · {parties, plural, one {# third party} other {# third parties}} · {documents, plural, one {# document} other {# documents}}',
  /** The basis of the DIOT: paid, not accrued. */
  'fiscal_mx.diot.header.basis': 'basis: PAID transactions (LIVA art. 5 frac. III), not accrued',
  /** After a panel criterion nobody answered: its value is the default. */
  'fiscal_mx.diot.header.by_default': '(default)',
  /** The 8 % rate row of the totals. */
  'fiscal_mx.diot.totals.rate_8': '8 % (border zone)',
  /** The exempt row of the totals. */
  'fiscal_mx.diot.totals.exempt': 'exempt',
  /** A row for any other rate, with its label. */
  'fiscal_mx.diot.totals.other': 'other ({label})',
  /** The creditable IVA paid in the month; the amount is padded after it at the call site. */
  'fiscal_mx.diot.totals.creditable_paid': 'Creditable IVA paid in the month',
  /** The IVA withheld from third parties; the amount is padded after it at the call site. */
  'fiscal_mx.diot.totals.withheld': 'IVA withheld from third parties',
  /** Under the totals: tie them out before capturing. */
  'fiscal_mx.diot.totals.tie_out':
    'Tie it out against the month\'s movement of the creditable IVA account: if it does not match to the cent, do not capture.',
  /** `diot generate` with blocking findings. */
  'fiscal_mx.diot.generate.not_capturable':
    '{count, plural, one {# finding stops} other {# findings stop}} this DIOT from being captured as it is. {count, plural, one {Fix it} other {Fix them}} and build it again; `diot check --check` lists the checks by name so you can tackle them one at a time.',
  /** A --layout that does not exist. */
  'fiscal_mx.diot.export.layout_unknown':
    '--layout "{value}" does not exist. The layouts are: {layouts} (working-paper is the reconciliation by third party that is tied out before capturing; sat is the authority\'s batch file).',
  /** A period with no grounded batch layout: what to do meanwhile. `message` is the service's. */
  'fiscal_mx.diot.export.meanwhile':
    '{message}\n\nMeanwhile: `{command}` produces the reconciliation by third party to capture in the portal.',
  /** The working paper is not the file that is uploaded. */
  'fiscal_mx.diot.export.working_paper':
    'Layout "{layout}": this is a WORKING PAPER. It is not uploaded to the SAT portal.',
  /** The line of `diot export -o`: layout, size and where it went. */
  'fiscal_mx.diot.export.written':
    'layout {layout} · {bytes, plural, one {# byte} other {# bytes}} · target {target}',
  /** `diot export` wrote the file, but blocking findings stop the capture. */
  'fiscal_mx.diot.export.written_not_capturable':
    'The file was written, but {count, plural, one {# finding stops} other {# findings stop}} the return from being captured as it is.',
  /** `-o` names a file that exists, without --yes. */
  'fiscal_mx.diot.export.exists':
    '{target} already exists and is not overwritten unless asked: use another path, or --yes. A working paper reviewed and annotated by hand is not replaced silently.',

  // MNE-001-226: cfdi (show, status show, status sync, explain) and rep (missing list, reconcile).
  /** Above the line items of `cfdi show`. */
  'fiscal_mx.cfdi.show.lines': '{count, plural, one {# line item:} other {# line items:}}',
  /** `cfdi status show` for a UUID the mirror does not have. */
  'fiscal_mx.cfdi.status.not_in_mirror': 'CFDI {uuid} is not in the mirror of this entity.',
  /** `cfdi status show` of a CFDI never consulted with the SAT. */
  'fiscal_mx.cfdi.status.never_checked': 'Never consulted: run with --refresh to ask the SAT now.',
  /** `cfdi status sync` without --live: how many it would consult. */
  'fiscal_mx.cfdi.sync.pending':
    '{count, plural, one {# CFDI} other {# CFDIs}} to consult with the SAT{mode, select, dry_run { (dry-run: nothing was consulted)} other {. Run with --live to really consult {count, plural, one {it} other {them}}.}}',
  /** The tally of `cfdi status sync --live`. Plurals in both catalogues, some with equal English branches. */
  'fiscal_mx.cfdi.sync.done':
    '{checked, plural, one {# consulted} other {# consulted}}: {valid, plural, one {# valid} other {# valid}}, {cancelled, plural, one {# cancelled} other {# cancelled}}, {not_found, plural, one {# not found} other {# not found}}, {errors, plural, one {# error} other {# errors}}',
  /** After the tally: CFDIs the issuer cancelled. */
  'fiscal_mx.cfdi.sync.cancelled_warning':
    '{count, plural, one {# CFDI cancelled by its issuer: review its accounting effect} other {# CFDIs cancelled by their issuers: review their accounting effect}} with cfdi list --json',
  /** The header of `cfdi explain`. Direction and status are the mirror's values. */
  'fiscal_mx.cfdi.explain.header': '{uuid} · type {type} · {direction} · case {case} · {status}',
  /** After the header, when the CFDI has a journal entry. */
  'fiscal_mx.cfdi.explain.entry': 'entry {entry}',
  /** `cfdi explain` with no pending decision. */
  'fiscal_mx.cfdi.explain.no_decisions': 'No pending decisions: the case was resolved by the panel policies alone.',
  /** `rep missing list --direction issued`: our collections without a REP. */
  'fiscal_mx.rep.missing.issued':
    '{count, plural, one {# collection} other {# collections}} without an issued REP: our own tax obligation, with a SAT deadline.',
  /** `rep missing list` (received): paid PPD bills without the supplier REP. */
  'fiscal_mx.rep.missing.received':
    '{count, plural, one {# payment} other {# payments}} without the supplier REP: the receipt that supports crediting the IVA of {count, plural, one {that payment} other {those payments}} is missing.',
  /** Rows whose CFDI is not in the mirror, so their payment method is unknown. */
  'fiscal_mx.rep.missing.unknown_method':
    '{count, plural, one {# with an unknown payment method (the CFDI is not in the mirror): the ledger treated it as {method}; it is listed} other {# with an unknown payment method (the CFDI is not in the mirror): the ledger treated them as {method}; they are listed}} with the doubt stated — a PUE needs no REP.',
  /** A --min-amount that is not a number. */
  'fiscal_mx.rep.missing.min_amount_unreadable': '--min-amount is unreadable: "{value}".',
  /** `rep reconcile --dry-run`: how many parked REPs it would retry. */
  'fiscal_mx.rep.reconcile.would_retry':
    '{count, plural, one {# parked REP would be retried} other {# parked REPs would be retried}} (dry-run: nothing was touched).',
  /** The tally of `rep reconcile`. Plurals in both catalogues, some with equal English branches. */
  'fiscal_mx.rep.reconcile.done':
    '{retried, plural, one {# retried} other {# retried}}: {linked, plural, one {# linked} other {# linked}}, {parked, plural, one {# still parked} other {# still parked}}, {errors, plural, one {# error} other {# errors}}',

  // MNE-001-600: sat cred (add, status, audit, revoke) and the family's idempotency reasons.
  /** A --cer or --key path that does not exist. `label` is `.cer` or `.key`. */
  'fiscal_mx.sat.cred.file_missing': 'The {label} file does not exist: {file}',
  /** The file's permissions let other users of the system read it. */
  'fiscal_mx.sat.cred.file_exposed':
    'WARNING: {file} is readable by other users of the system (mode {mode}). Consider: chmod 600 {file}',
  /** --idempotency-key passed to a leaf that needs none. `reason` is the leaf's own key_unneeded. */
  'fiscal_mx.sat.cred.key_unneeded_note': '--idempotency-key does not apply here: {reason}.',
  /** Why `sat cred add` needs no idempotency key. */
  'fiscal_mx.sat.cred.add.key_unneeded': 'custody is guarded by the typed consent and the credential status',
  /** The title above the certificate summary. */
  'fiscal_mx.sat.cred.add.certificate_read': 'Certificate read',
  /** The certificate summary, one indented field per line. No secret: type, RFC, serial and validity are public. */
  'fiscal_mx.sat.cred.add.certificate':
    '  type: {type}\n  RFC: {rfc}\n  serial: {serial}\n  validity: {from} → {to}\n  target entity: {entity} ({taxId})',
  /** The certificate is a CSD, which the bulk download rejects. */
  'fiscal_mx.sat.cred.add.csd': 'This is a CSD (digital seal), not an e.firma. The SAT bulk download rejects it.',
  /** The certificate belongs to another RFC than the entity's. */
  'fiscal_mx.sat.cred.add.rfc_mismatch':
    'The certificate\'s RFC ({rfc}) does not match the entity "{entity}" ({taxId}).',
  /** After the RFC mismatch. */
  'fiscal_mx.sat.cred.add.pick_entity': 'Use --entity to pick the correct entity.',
  /** The certificate's validity ended. `date` is a calendar date. */
  'fiscal_mx.sat.cred.add.expired': 'The certificate expired on {date}. Renew it at the SAT.',
  /** `sat cred add --dry-run`: valid, and nothing stored. */
  'fiscal_mx.sat.cred.add.dry_run':
    '(dry-run: certificate valid for this entity. The real run asks the key password, verifies the pair and stores the material in the vault. Nothing was stored.)',
  /** Without --live: the local checks passed. */
  'fiscal_mx.sat.cred.add.validation_passed': 'Validation passed.',
  /** Without --live: the deposit is opt-in. */
  'fiscal_mx.sat.cred.add.live_needed':
    'Storing the e.firma in the vault is the real external effect and is opt-in: re-run with --live to be asked the password and complete the deposit.',
  /** The hidden prompt for the private key's password; what is typed is not echoed. */
  'fiscal_mx.sat.cred.add.password_prompt': 'Private key password (not shown)',
  /** The key does not open with that password, or is not the certificate's. */
  'fiscal_mx.sat.cred.add.bad_pair': 'The key does not match the certificate, or the password is incorrect.',
  /** The pair opened locally. */
  'fiscal_mx.sat.cred.add.pair_verified': 'Key pair verified locally.',
  /** The typed consent. `accept` is the literal word the leaf compares, in every language. */
  'fiscal_mx.sat.cred.add.consent_prompt':
    'Do you authorize storing this e.firma? type "accept" to continue (--yes does not skip this)',
  /** The consent was not given. */
  'fiscal_mx.sat.cred.add.cancelled': 'Cancelled. Nothing was saved.',
  /** The deposit receipt's first line. */
  'fiscal_mx.sat.cred.add.registered': 'e.firma registered for {entity}',
  /** Where the material is kept: the vault backend's name. */
  'fiscal_mx.sat.cred.add.custody': 'custody: {backend}',
  /** Whether unattended use is allowed, and the daily limit. */
  'fiscal_mx.sat.cred.add.unattended':
    'unattended use: {unattended, select, yes {allowed} other {forbidden}} · limit: {limit}/24h',
  /** The command that lists the accesses. */
  'fiscal_mx.sat.cred.add.audit_hint': 'audit: {command}',
  /** `sat cred status` with no credential. */
  'fiscal_mx.sat.cred.status.none': 'No credentials registered. Add one with: {command}',
  /** A credential past its validity. */
  'fiscal_mx.sat.cred.status.expired': '(expired)',
  /** Fewer than 60 days of validity left. */
  'fiscal_mx.sat.cred.status.expires_soon':
    '(expires in {days, plural, one {# day} other {# days}} — renew at the SAT)',
  /** Days of validity left. */
  'fiscal_mx.sat.cred.status.expires_in': '(expires in {days, plural, one {# day} other {# days}})',
  /** The certificate serial and the vault backend. */
  'fiscal_mx.sat.cred.status.custody': 'serial {serial} · custody {backend}',
  /** Unattended use, daily limit and last use. `last` is a timestamp or status.never_used. */
  'fiscal_mx.sat.cred.status.usage':
    'unattended: {unattended, select, yes {yes} other {no}} · limit {limit}/24h · last use: {last}',
  /** No use recorded yet. */
  'fiscal_mx.sat.cred.status.never_used': 'never',
  /** The vault's health check. `detail` is the backend's own text. */
  'fiscal_mx.sat.cred.status.vault': 'Vault: {health, select, ok {OK} other {ERROR}} — {detail}',
  /** `sat cred audit` with an empty log. */
  'fiscal_mx.sat.cred.audit.none': 'No accesses recorded.',
  /** Above the access log. */
  'fiscal_mx.sat.cred.audit.title': 'Accesses to the credential of {entity}',
  /** How an access was made. */
  'fiscal_mx.sat.cred.audit.mode': '{mode, select, unattended {unattended} other {with operator}}',
  /** Why `sat cred revoke` needs no idempotency key. */
  'fiscal_mx.sat.cred.revoke.key_unneeded': 'a second revoke is refused because no active credential remains',
  /** `sat cred revoke --dry-run` with no active credential. */
  'fiscal_mx.sat.cred.revoke.nothing_active': 'There is no active credential to revoke; the real run would refuse too.',
  /** The verb of revoke.would, printed in bold. */
  'fiscal_mx.sat.cred.revoke.would_revoke': 'Would revoke',
  /** `sat cred revoke --dry-run`: what the real run destroys. `verb` is revoke.would_revoke, `custody` revoke.custody. */
  'fiscal_mx.sat.cred.revoke.would':
    '{verb} the {type} of {entity} (serial {serial}) and cryptographically destroy its vault material {custody}',
  /** The vault backend, after revoke.would. */
  'fiscal_mx.sat.cred.revoke.custody': '(custody: {backend})',
  /** After revoke.would. */
  'fiscal_mx.sat.cred.revoke.dry_run': '(dry-run: nothing was revoked or destroyed)',
  /** Before the typed confirmation. */
  'fiscal_mx.sat.cred.revoke.about_to': 'You are about to delete the e.firma of {entity} from custody.',
  /** After revoke.about_to. */
  'fiscal_mx.sat.cred.revoke.irreversible':
    'The deletion is cryptographic and irreversible; it will have to be loaded again.',
  /** The confirmation prompt. */
  'fiscal_mx.sat.cred.revoke.confirm_prompt': 'Type the RFC of the entity to confirm',
  /** The typed RFC was not the entity's. */
  'fiscal_mx.sat.cred.revoke.cancelled': 'Cancelled.',
  /** The revocation finished. */
  'fiscal_mx.sat.cred.revoke.done': 'Credential revoked and material deleted from the vault.',
  /** Why `sat download check` needs no idempotency key. */
  'fiscal_mx.sat.download.check.key_unneeded': 'asking the state again is harmless and records the latest state',
  /** Why `sat package download` needs no idempotency key. */
  'fiscal_mx.sat.download.package.key_unneeded':
    'a package already archived is never downloaded again, and each CFDI deduplicates by UUID',
  /** Why `cfdi status sync` does not honor an idempotency key. */
  'fiscal_mx.cfdi.sync.retry_reconsults': 'a retry consults the SAT again and rewrites the cache',
  /** Why `cfdi post` needs no idempotency key. */
  'fiscal_mx.cfdi.post.key_unneeded':
    'one CFDI gives one invoice: a repeat finds its pre-registration closed, or an invoice with its UUID, and is refused',

  // ==== end of I8.7 ====

  // ==== I8.8 · CLI leaves by key, family ap (issue #270) ====
  // MNE-001-227: prepaid. The currency is the parameter {currency}, never text.
  /** A date flag that is not a real calendar day. */
  'ap.prepaid.flag.date_invalid': '{flag} must be a real date in YYYY-MM-DD form; got "{value}".',
  /** An amount flag that is not an unsigned decimal. */
  'ap.prepaid.flag.amount_invalid':
    '{flag} must be an unsigned decimal amount; got "{value}". The point separates the decimals and the comma is ignored: 1,250,000.50 and 1250000.50 are the same.',
  /** `prepaid run` without --period. */
  'ap.prepaid.run.period_missing':
    'Missing --period. The amortization is of one specific month and is not guessed from the clock: running «the current period» on day 1 at 00:05 would accrue the month that has just begun.',
  /** `prepaid create` without --origin. */
  'ap.prepaid.create.origin_missing':
    'Missing --origin. The three origins are: {origins} — the CFDI that was classified as prepaid (needs --source-entry), the balance that was already in account 1160 with no schedule, and the payment that was posted by hand. It has no default: assuming it leaves the trail pointing at an entry that is not the one.',
  /** An --origin outside the three. */
  'ap.prepaid.create.origin_unknown': '--origin "{value}" does not exist. The three are: {origins}.',
  /** A --convention outside the two. */
  'ap.prepaid.create.convention_unknown':
    '--convention "{value}" does not exist: the two conventions are {days} and {months} (the days each month covers, or the whole month).',
  /** A --convention that contradicts the panel. `source` is `answered` when someone answered the key. */
  'ap.prepaid.create.convention_contradicts_panel':
    '--convention {requested} contradicts the panel: `amortizacion_anticipados_convencion` is "{panel}"{source, select, answered {} other { (declared default, nobody has answered)}}, and that is what is frozen in the schedule. This flag declares which convention you believe you are creating with, it does not choose it: it is changed with {hint}.',
  /** The four required flags of `prepaid create`, named together. */
  'ap.prepaid.create.flags_missing':
    '{count, plural, one {Missing {flags}} other {Missing {flags}}}. A schedule with no amount, no coverage window or no word on where the charge came from is not an incomplete record: it is a record that cannot be accrued nor tied out against the account.',
  /** `--origin cfdi` without `--source-entry`. */
  'ap.prepaid.create.cfdi_needs_source_entry':
    '`--origin cfdi` needs `--source-entry <id>`: if the schedule is born from a bill already posted, the entry that charged the account is known, and not recording it loses it for good.',
  /** The reasons a schedule does not enter the month's run (`prepaid run`). */
  'ap.prepaid.skip.unknown_convention': 'unknown stored convention ("{convention}")',
  'ap.prepaid.skip.not_started': 'the coverage has not started yet',
  'ap.prepaid.skip.ended': 'the coverage has already ended',
  'ap.prepaid.skip.zero_row': 'the row of the month is zero',
  'ap.prepaid.skip.nothing_left': 'no balance is left to accrue',
  /** The posted balance of the prepaid account that no schedule will accrue. */
  'ap.prepaid.gap.warning':
    '{amount} {currency} posted to the prepaid expenses account that no schedule will accrue, in {count, plural, one {# entry} other {# entries}}. That expense will never reach the income statement. Each entry is adopted with `mnemosine prepaid create --origin saldo_preexistente --source-entry <id> --start <date> --end <date>`, with the coverage window the document states — it is not guessed: it lives in the journal entry, not in the CFDI.',
  /** The panel criteria above `create`. Each `*_source` is `answered` when someone answered the key. */
  'ap.prepaid.criteria.header':
    'convention {convention}{convention_source, select, answered {} other { (default)}} · threshold {threshold} {currency}{threshold_source, select, answered {} other { (default)}}',
  /** When a declared default rules instead of a choice of the firm. */
  'ap.prepaid.criteria.default_rules':
    'At least one declared default rules, not a choice of the firm. It is answered with `mnemosine pending define amortizacion_anticipados_convencion` / `umbral_anticipado_mxn`.',
  /** `create --dry-run` below the materiality threshold. */
  'ap.prepaid.create.below_threshold':
    '{amount} is below the threshold of {threshold} {currency} (`umbral_anticipado_mxn`): the real creation would stop for materiality (NIF A-4). With --force and --reason it is created anyway and the reason is written in the row.',
  /** `create --dry-run`: what it computed. */
  'ap.prepaid.create.dry_run_done':
    'Dry run: no row was written. {count, plural, one {# row} other {# rows}} for {amount} {currency}, convention {convention}.',
  /** `create --dry-run` does not check the backing in the account. */
  'ap.prepaid.create.dry_run_no_backing':
    'The dry run does NOT check the backing in the account —how much posted balance is left with no schedule—: that guard lives inside the creation and needs the ledger. The real creation may refuse for that reason.',
  /** The receipt of `prepaid create`. */
  'ap.prepaid.create.done':
    'Schedule of {count, plural, one {# row} other {# rows}} created. The ledger was not touched: the charge was already there. It is accrued with `mnemosine prepaid run --period <month>`.',
  /** `prepaid list -a` with nothing alive. */
  'ap.prepaid.list.none_alive': 'There is no live schedule in this entity.',
  /** `prepaid list` with no schedule covering the date. */
  'ap.prepaid.list.none_on_date': 'No schedule covers {date}. With -a all of them are listed.',
  /** `prepaid show` of a schedule whose stored convention is none of the declared ones. */
  'ap.prepaid.show.unknown_convention':
    'The schedule "{description}" stores the convention "{convention}", which is none of the declared ones ({conventions}). No amount can be computed with it.',
  /** The summary line under the `prepaid show` table. */
  'ap.prepaid.show.summary':
    '{description} · {total} {currency} · {convention} · origin {origin} · accrued {accrued}, {remaining} left',
  /** Why the `prepaid show` table is not a statement of what was posted. */
  'ap.prepaid.show.rows_are_schedule':
    'The rows are the schedule the run will follow, not what was already posted: what was posted is the accrued figure of the line above.',
  /** `prepaid show` with a reference that matches no schedule. */
  'ap.prepaid.show.not_found':
    'No live schedule matches "{ref}" in this entity. `mnemosine prepaid list -a` lists them all.',
  /** `prepaid show` with a reference that matches several. */
  'ap.prepaid.show.ambiguous':
    '"{ref}" matches {count} live schedules: {candidates}. Name the id, or a piece of the description that matches only one.',
  /** The header of `prepaid run`. */
  'ap.prepaid.run.header':
    '{period} ({from}..{to}) · entries dated {date} · {entering, plural, one {# schedule enters} other {# schedules enter}}, {skipped} skipped, {already} already have a row this month · total {total}',
  /** `prepaid run` with nothing to accrue. */
  'ap.prepaid.run.nothing': 'Nothing to accrue in {period}: the ledger was not touched.',
  /** A schedule that does not enter the run, and why. */
  'ap.prepaid.run.skipped_line': '{description} skipped: {reason}',
  /** A row capped against what is left to accrue. */
  'ap.prepaid.run.capped':
    '{description}: the theoretical row is {theoretical} and is capped at {amount} against what is left to accrue.',
  /** The run posts one entry per schedule, not one. */
  'ap.prepaid.run.entries_note':
    '{count, plural, one {# two-line adjusting entry} other {# two-line adjusting entries}}, one per schedule — not one for the run. Reversing this run takes {count, plural, one {# reversal} other {# reversals}}.',
  /** `prepaid run --dry-run`. */
  'ap.prepaid.run.dry_run_done': 'Dry run: the ledger was not touched and no row was written.',
  /** The confirmation of `prepaid run`. */
  'ap.prepaid.run.confirm':
    'Accrue {total} {currency} in {count, plural, one {# entry} other {# entries}} of {period}? The ledger cannot be undone.',
  /** `prepaid run` answered no. */
  'ap.prepaid.run.aborted': 'No changes: the ledger was not touched.',
  /** `prepaid run` with no terminal to confirm in. */
  'ap.prepaid.run.aborted_no_tty':
    'No changes: there is no terminal to confirm in. Add -y to accrue without asking, or --dry-run to see the full entries without writing anything.',
  /** The engine posted another number of entries than the preview showed. */
  'ap.prepaid.run.count_mismatch':
    'The preview showed {previewed, plural, one {# entry} other {# entries}} and the run made {processed}. The preview and the engine did not agree: review the errors before calling the month closed.',
  /** The engine accrued another total than the preview added. */
  'ap.prepaid.run.total_mismatch': 'The preview added up to {previewed} and the run accrued {accrued}.',
  /** The receipt of `prepaid run`. */
  'ap.prepaid.run.done':
    '{count, plural, one {# accrual entry} other {# accrual entries}} posted in {period} for {total}.',

  // MNE-001-228 part 1: ap reconcile, vendor and payment. Part 2 (bill) appends below.
  /** `ap reconcile --as-of` that is not a real calendar day. */
  'ap.reconcile.date_invalid': '{flag} must be a real date in YYYY-MM-DD form; got "{value}".',
  /** The table of `ap reconcile`: title, header and row labels. */
  'ap.reconcile.title': 'AP reconciliation',
  'ap.reconcile.header': '· control {code} {name} · as of {date}',
  'ap.reconcile.row.subledger': 'Subledger (open bills)',
  'ap.reconcile.row.foreign': 'of which {currency} {foreign}',
  'ap.reconcile.row.fx_revaluation': 'of which FX revaluation',
  'ap.reconcile.row.ledger': 'Control account (ledger)',
  'ap.reconcile.row.difference': 'Difference',
  'ap.reconcile.row.explained': 'Explained by items',
  'ap.reconcile.row.unexplained': 'Unexplained',
  /** The verdict under the rows. `owner` is `none` when part of the difference has no owner. */
  'ap.reconcile.balanced': 'Balanced.',
  'ap.reconcile.unbalanced':
    'Difference {difference} — {owner, select, none {{explained} named, {unexplained} with no owner.} other {every peso of it is named below.}}',
  /** The reconciling items: heading, the footnote under the table, and the prose heading of --explain. */
  'ap.reconcile.items_title': 'Reconciling items',
  'ap.reconcile.items_note':
    'importe = what this item adds to (subledger − ledger); the named ones sum to Explained, and with the residual row to Difference.',
  'ap.reconcile.items_rounding': 'Amounts are rounded per item; the column may differ from Explained by cents.',
  'ap.reconcile.why_title': 'Why each item is there',
  'ap.reconcile.no_manual_entries': 'No manual entries on the control account either.',
  /** More items than the listing shows, per probe. */
  'ap.reconcile.capped':
    '{count, plural, one {# more item exists and was not listed} other {# more items exist and were not listed}}: the listing is capped per probe. The totals (explained, unexplained) do include them.',
  /** `vendor show --include` with a part it cannot include. */
  'ap.vendor.show.include_unknown':
    'Cannot include "{part}". This command can include: {parts}. "compliance" needs the vendor_tax_profiles and vendor_compliance_checks tables, and "bank" needs the audited decrypt path — neither exists yet.',
  'ap.vendor.show.disappeared': 'Vendor {ref} disappeared while reading it.',
  /** `vendor create --tax-id`: which country's rule, said out loud. */
  'ap.vendor.create.no_default_tax_id_type':
    'This entity is incorporated in "{country}", which has no default tax id type. Say which one with --tax-id-type {types}.',
  'ap.vendor.create.tax_id_type_unknown': 'Unknown --tax-id-type "{value}". Use one of: {types}.',
  'ap.vendor.create.tax_id_type_alone': '--tax-id-type was given without --tax-id.',
  'ap.vendor.create.terms_not_understood':
    'Payment terms "{terms}" were not understood, so no due date could ever be computed from them. Use "Net 30", "2/10 Net 30" or "Due on receipt".',
  'ap.vendor.create.tax_id_accepted': 'Tax id {taxId} accepted under: {rule}.',
  'ap.vendor.create.no_tax_id':
    'No tax id on file. A received CFDI cannot be matched to this vendor and it cannot appear in a DIOT or a 1099.',
  'ap.vendor.edit.nothing_to_change':
    'Nothing to change. Pass --name, --contact, --email, --phone or --notes. Payment terms are `vendor terms set`; bank details are not editable from here.',
  'ap.vendor.edit.done': '{number} updated ({fields})',
  'ap.vendor.terms.nothing_to_set': 'Nothing to set. Pass --terms, --currency, or both.',
  /** How `vendor terms set` read the terms. `net` and `discount` are `none` when the terms have neither. */
  'ap.vendor.terms.read_as':
    'Read as: {net, select, none {no net term} other {due {days, plural, one {# day} other {# days}} after the bill date}}{discount, select, none {} other {, {pct}% off if paid within {discountDays, plural, one {# day} other {# days}}}}.',
  /** A `payment` question with no terminal to ask it on. */
  'ap.payment.confirm.no_terminal':
    '{question} — there is no terminal to ask on. Re-run with --yes once you are sure, or with --dry-run to see the effect first.',
  'ap.payment.dry_run': 'Dry run: nothing was written.',
  /** The account `--bank` resolved to, echoed because a fragment may match another. */
  'ap.payment.bank_account': 'Bank account: {name}',
  /** The entry a payment posted, after its result line. */
  'ap.payment.entry': 'entry {entry}',
  /** A bill that cannot be paid. `reason` is `paid`, `unapproved` or another status. */
  'ap.payment.create.not_payable':
    'Bill {bill} is "{status}". {reason, select, paid {It is already settled.} unapproved {Approve it first: the liability has to be in the ledger before it can be paid.} other {Only {payable} bills can be paid.}}',
  /** The confirmation of `payment create`. `bank` is `none` without --bank. */
  'ap.payment.create.confirm':
    'Record {amount} {currency} paid on {bill} ({before} → {after}){bank, select, none {} other { from {bankName}}} in {entity}? This posts to the ledger.',
  /** The key was already spent: before any work, and when the race is lost while writing. */
  'ap.payment.create.idempotency_hit':
    '↩ Idempotency hit: the key "{key}" already completed this act ({number}). Nothing was written again; this is the recorded result.',
  'ap.payment.create.idempotency_race':
    '↩ Idempotency hit: the key "{key}" already spent this payment ({number}). Nothing was written again; this is the recorded result.',
  'ap.payment.create.would_record': 'Would record {before} → {after} on {bill}',
  /** The flags of `payment apply`, paired by position. */
  'ap.payment.apply.bill_missing':
    'Name the bill it applies to: --bill <ref> --amount <amount>. Repeat them to split it among several.',
  'ap.payment.apply.pairs_mismatch':
    '{bills, plural, one {There is # --bill} other {There are # --bill}} and {amounts} --amount: they pair up by position, so there must be as many of each.',
  'ap.payment.apply.discounts_excess':
    '{discounts, plural, one {There is # --discount} other {There are # --discount}} for {bills} --bill: at least one is left over.',
  'ap.payment.apply.mode_invalid': '--mode takes "partial" or "residual"; got "{mode}".',
  /** The reason `payment apply` does not honor --idempotency-key (`cli.risk.key_not_honored`). */
  'ap.payment.apply.retry_reapplies': 'a retry splits the payment again and posts another entry',
  'ap.payment.apply.not_applicable': 'Bill {bill} is "{status}"; only {payable} bills can be applied to.',
  /** The confirmation of `payment apply`. `writeOff` is `none` when nothing is written off. */
  'ap.payment.apply.confirm':
    'Apply {count, plural, one {# document} other {# documents}} of {payment} on {date} in {entity}{writeOff, select, none {} other {, WRITING OFF {amount} that will stop being owed}}? This posts to the ledger.',
  'ap.payment.apply.would': 'Would apply {payment}',
  'ap.payment.apply.on_account': 'on account {before} → {after} · {date}',
  /** A discount the terms did not grant, named apart from an early-payment one. */
  'ap.payment.apply.discount_outside_terms': 'Discount taken outside the terms on {bills}',
  'ap.payment.apply.discount_outside_terms_why': 'it is a negotiated deduction, not an agreed early-payment discount.',
  /** The short payment, said out loud. */
  'ap.payment.apply.written_off': '{amount} stopped being owed (short payment)',
  'ap.payment.apply.write_off_default':
    'That account is the declared DEFAULT; nobody has decided it yet: `mnemosine pending --verbose` shows it and `mnemosine pending define pago_corto_residual` decides it.',
  'ap.payment.apply.iva_not_credited':
    '{amount} of IVA left {account} WITHOUT being credited: it was the tax on the part that was not paid, and under cash basis what is not paid is not credited.',
  /** `payment unapply`. `mode` is `dry_run` or `done`. */
  'ap.payment.unapply.confirm':
    'Unapply {amount} of {payment} from {bill} on {date} ({before} → {after})? The cash goes back on account.',
  'ap.payment.unapply.idempotency_hit': '↩ Idempotency hit: key "{key}" already unapplied this; nothing was written again.',
  'ap.payment.unapply.result': '{mode, select, dry_run {Would unapply {payment}} other {{payment} unapplied}} from {bill}',
  'ap.payment.unapply.detail': '{before} → {after} · on account {onAccount}',
  /** `payment reverse`. `mode` is `dry_run` or `done`. */
  'ap.payment.reverse.confirm':
    'Reverse {payment} on {date}? {entries, plural, one {# ledger entry gets a mirror} other {# ledger entries get a mirror}} and {bills, plural, one {# bill is owed again} other {# bills are owed again}}.',
  'ap.payment.reverse.idempotency_hit': '↩ Idempotency hit: key "{key}" already reversed this; nothing was written again.',
  'ap.payment.reverse.result': '{mode, select, dry_run {Would reverse {payment}} other {{payment} reversed}}',
  'ap.payment.reverse.detail': 'on {date} · {entries}',
  // MNE-001-614: bill (the last ap leaf).
  /** A date flag of `bill list`, `bill create` or `--query since|until` that is not YYYY-MM-DD. */
  'ap.bill.date_invalid': '{flag} must be a date as YYYY-MM-DD; got "{value}".',
  /** `bill line set --line` and `bill inbox edit --line` that is not a positive integer. */
  'ap.bill.line_number_invalid': '--line must be a line number; got "{line}".',
  'ap.bill.dry_run': 'Dry run: nothing was written.',
  /** `bill list`: the two time flags a bill list cannot answer. */
  'ap.bill.list.as_of_unsupported':
    '--as-of asks what was open on a date, which is an aging question this command cannot answer (it needs the payment history joined per bill). Use --until for the document date.',
  'ap.bill.list.date_basis_invalid':
    '--date-basis {basis} is not defined for a bill: a bill has a document date and, once approved, a posting date. Use document or posting.',
  /** `bill show`: the refusal and the headings of the stacked tables. */
  'ap.bill.show.disappeared': 'Bill {ref} disappeared while reading it.',
  'ap.bill.show.lines_title': 'Lines',
  'ap.bill.show.journal_title': 'Journal entry',
  'ap.bill.show.no_cfdi': 'None: this bill was not captured from an XML.',
  /** `bill create`: the refusals, the legacy tax= warning, the receipt and the draft note. */
  'ap.bill.create.vendor_missing': 'Which vendor? Pass it as the argument or with --vendor.',
  'ap.bill.create.lines_missing': 'A bill needs at least one line: --line "account=5100;qty=1;price=1000;tax-amount=160".',
  'ap.bill.create.line_without_account': 'Every line needs account=<code>: a line with no account cannot be posted.',
  'ap.bill.create.line_without_price': 'Line "account={account}" has no price=<amount>.',
  'ap.bill.create.no_due_date':
    'No due date, and "{terms}" implies none. Pass --due-date, or set terms a due date can be computed from with `vendor terms set`.',
  'ap.bill.create.legacy_tax_key':
    'tax= is the AMOUNT of the IVA of the line, not the rate; use tax-amount= so that it is explicit. tax= stops being accepted in version {version}.',
  'ap.bill.create.done': '· {subtotal} + {tax} tax = {total} {currency} · due {due}',
  'ap.bill.create.draft_note': 'Status draft: nothing is in the ledger until `bill approve`.',
  /** `bill create --from-file`. */
  'ap.bill.create.file_unreadable': 'Cannot read --from-file "{path}".',
  'ap.bill.create.file_not_json': '--from-file "{path}" is not valid JSON: {message}',
  'ap.bill.create.file_not_object': '--from-file "{path}" must contain a JSON object with a "lines" array.',
  /** `bill line set`: the receipt, before the dim total. */
  'ap.bill.line.set.done': '{bill} line {line} recoded',
  /** `bill approve`. `reason` is `posted` when the bill already has an entry; `posted` of the receipt is `entry` or `none`. */
  'ap.bill.approve.not_approvable':
    'Bill {bill} is "{status}", not {approvable}. {reason, select, posted {It is already in the ledger; reversing it is `bill reverse`, which has no backend yet.} other {Only a bill still being worked on can be approved.}}',
  /** The approvable statuses as a list: every one but the last, then the last. */
  'ap.bill.approve.statuses': '{list} or {last}',
  'ap.bill.approve.confirm': 'Post {bill} ({total} {currency}) to the ledger of {entity}? This cannot be undone.',
  'ap.bill.approve.no_terminal':
    'This posts to the ledger and there is no terminal to confirm at. Re-run with --yes when you mean it, or with --dry-run to see the entry.',
  'ap.bill.approve.done':
    '{bill} approved{posted, select, entry { · entry {entry} posted {date}} other { · no entry: it was already posted}}',
  'ap.bill.approve.key_not_needed':
    '--idempotency-key was not needed: approval is idempotent behind the bill status and its journal_entry_id.',
  'ap.bill.approve.no_entry': '{bill} produces no journal entry (already posted, or a zero total).',
  'ap.bill.approve.entry_title': 'Entry {entry} · {date}',
  /** The ledger refusals of `bill approve`; `message` is the engine's. */
  'ap.bill.approve.period_closed':
    '{bill} cannot be posted: {message}. Its bill date falls in a period that is closed or locked. Reopen the period, or post it in an open one once `bill edit` exists to move the date.',
  'ap.bill.approve.missing_role': '{bill} cannot be posted: {message}',
  /** `bill inbox`: shared by list, edit and run. */
  'ap.bill.inbox.id_invalid': '"{id}" is not a pre-registration id (uuid). Take it from `bill inbox list`.',
  'ap.bill.inbox.value_unknown': '{flag} "{value}" does not exist. The possible values are: {values}.',
  'ap.bill.inbox.unnamed_issuer': 'unnamed issuer',
  'ap.bill.inbox.no_rfc': 'no RFC',
  /** `bill inbox list`: the rows whose vendor is not in the catalog. `mark` is the marker of their cell. */
  'ap.bill.inbox.list.new_vendors':
    '{count} of {total} {count, plural, one {comes} other {come}} from a vendor that is NOT in the catalog (marked «{mark}»).',
  'ap.bill.inbox.list.new_vendors_note':
    '  Posting them would create the counterparty with the name and the RFC of the XML.\n  `bill inbox run` refuses them unless it carries --allow-new-vendor; the other way out\n  is to create them by hand with `vendor create`.',
  /** `bill inbox edit`. `target` is `default` or `line`. */
  'ap.bill.inbox.edit.cost_center_needs_line': '--cost-center codes one line: pass --line <n> too.',
  'ap.bill.inbox.edit.cost_center_invalid': '--cost-center must be a cost center id (uuid); got "{value}".',
  'ap.bill.inbox.edit.nothing_to_code': 'Nothing to code: pass --account, or --line with --account or --cost-center.',
  'ap.bill.inbox.edit.done': '{ref} {target, select, default {default account set} other {line {line} coded}}',
  'ap.bill.inbox.edit.uncoded':
    '· {count, plural, one {# line still without an account} other {# lines still without an account}}',
  'ap.bill.inbox.edit.post_with': 'Post it with `mnemosine bill inbox run {id}`.',
  /** `bill inbox run`: the flags and the selection. */
  'ap.bill.inbox.run.reason_missing': '--action reject discards a document: it requires --reason "<why>".',
  'ap.bill.inbox.run.batch_missing': '--action set-batch needs --batch <batch id or number>.',
  'ap.bill.inbox.run.action_unknown': '--action "{value}" does not exist. Use one of: {actions}.',
  'ap.bill.inbox.run.id_and_bulk': 'Pass an id, or --bulk with --query. The two together mean nothing.',
  'ap.bill.inbox.run.nothing_selected': 'On what? Pass the id of a pre-registration, or --bulk with --query "status=ready".',
  'ap.bill.inbox.run.bulk_without_query':
    '--bulk without --query would act on the WHOLE inbox. Name the selection: --query "status=ready,mode=manual" (keys: {keys}).',
  'ap.bill.inbox.run.query_unparsable':
    'Cannot read --query "{spec}". Each part is key=value separated by commas: --query "status=ready,mode=manual". Keys: {keys}.',
  'ap.bill.inbox.run.query_keys_unknown':
    '{count, plural, one {Key} other {Keys}} that --query does not know: {unknown}. Keys: {keys}.',
  'ap.bill.inbox.run.requires_approval_invalid': 'requires-approval only takes true or false; got "{value}".',
  'ap.bill.inbox.run.query_narrows_nothing': '--query "{spec}" narrows nothing. Name at least one criterion.',
  'ap.bill.inbox.run.batch_not_found': 'There is no processing batch "{ref}" in this entity.',
  'ap.bill.inbox.run.not_in_inbox': 'Pre-registration {id} is not in the inbox of {entity}.',
  'ap.bill.inbox.run.over_cap':
    'The selection goes over {cap} pre-registrations. A batch bigger than that is not an order someone has reviewed: narrow it with --query (status, mode, since, until, vendor).',
  'ap.bill.inbox.run.query_selects_none': 'The query "{query}" selects no pre-registration. Nothing to do.',
  'ap.bill.inbox.run.waiting':
    '  {count, plural, one {There is # pre-registration} other {There are # pre-registrations}} waiting for a human decision, which this query does not reach.',
  'ap.bill.inbox.run.waiting_note':
    '  They are seen with `bill inbox list --status draft`, and there are the ones that stopped\n  because they came with a new vendor: repeat them with --query "status=draft".',
  /** What the run would do, before it is asked. `totals` is the per-currency sum, with its leading « · ». */
  'ap.bill.inbox.run.summary':
    '{action}: {count, plural, one {# pre-registration} other {# pre-registrations}}{totals}',
  'ap.bill.inbox.run.already_posted':
    '  {count, plural, one {# is already posted and will be skipped.} other {# are already posted and will be skipped.}}',
  'ap.bill.inbox.run.new_vendors':
    '  {count, plural, one {# would create a NEW VENDOR} other {# would create NEW VENDORS}}: {vendors}',
  'ap.bill.inbox.run.new_vendor_allowed':
    '  --allow-new-vendor is set: they will be created with the name and the RFC of the XML.',
  'ap.bill.inbox.run.new_vendor_refused':
    '  Without --allow-new-vendor they are refused one by one, with the reason, and the rest goes on.',
  /** The question before the run. `kind` is `process` or the other actions. */
  'ap.bill.inbox.run.confirm':
    '{kind, select, process {Post {count, plural, one {# pre-registration} other {# pre-registrations}} to the books of {entity}? Each one is born as a POSTED bill with its entry. This cannot be undone.} other {Apply "{action}" to {count, plural, one {# pre-registration} other {# pre-registrations}} of {entity}?}}',
  'ap.bill.inbox.run.no_terminal':
    'There is no terminal to confirm at. Re-run with --yes once you have decided, or with --dry-run to see what it would do.',
  'ap.bill.inbox.run.idempotency_hit':
    '↩ Idempotency hit: key "{key}" already completed this act — {ok}/{total} {action}\n  Nothing was executed again; this is the recorded result.',
  /** The result line: done of total, then the skipped and the failed, each dim. */
  'ap.bill.inbox.run.done': '{action}: {ok} of {total}',
  'ap.bill.inbox.run.skipped': ' · {count} already done',
  'ap.bill.inbox.run.failed': ' · {count} not done',
  /** The `detail` column of each row: prose for the person, in its language. `status` is the code. */
  'ap.bill.inbox.run.detail.already_posted': 'already posted',
  'ap.bill.inbox.run.detail.bill': 'bill {bill}',
  'ap.bill.inbox.run.detail.entry': 'entry {entry}',
  'ap.bill.inbox.run.detail.payment': 'payment {payment}',
  'ap.bill.inbox.run.detail.posted': 'posted',
  'ap.bill.inbox.run.detail.approved': 'approved',
  'ap.bill.inbox.run.detail.rejected': 'rejected',
  'ap.bill.inbox.run.detail.scheduled': 'scheduled in batch {batch}',
  /** The refusals of one row. `type` is the pre-registration's document type, or the unknown one. */
  'ap.bill.inbox.run.vanished': 'it disappeared from the inbox while it was being processed',
  'ap.bill.inbox.run.not_a_bill':
    'it is a pre-registration of type "{type}", not a vendor bill nor its credit note. `bill inbox run` only posts expenses and the notes that lower them; an issued payment complement would record CUSTOMER RECEIPTS, which is not what this command says it does.',
  'ap.bill.inbox.run.type_unknown': 'unknown',
  'ap.bill.inbox.run.needs_approval':
    'it requires a prior approval and is at "{state}". Approve it first: `bill inbox run <id> --action approve`.',
  'ap.bill.inbox.run.not_pending': 'it was not pending approval (or it needs no approval, or it was already rejected)',
  'ap.bill.inbox.run.not_rejectable':
    'it is already posted or was already rejected: what is posted is not rejected, it is reversed',
  'ap.bill.inbox.run.not_schedulable': 'it is completed or rejected: it is no longer scheduled',

  // ==== end of I8.8 ====

  // ==== I8.9 · CLI leaves by key, family ledger (issue #271) ====
  // MNE-001-229: batch. The two aborts are the kernel's no_changes_* keys.
  /** The heading of every batch screen, and the bold of its receipts. */
  'ledger.batch.title': 'BATCH {id}',
  'ledger.batch.receipt_title': 'batch {id}',
  /** A row of the file, in check's report and in post's preview. */
  'ledger.batch.row': 'row {row}',
  /** The idempotency hit of post and reverse. `what` is post's or reverse's `recorded`. */
  'ledger.batch.idempotency_hit':
    '↩ Idempotency hit: key "{key}" already completed this act — {what}. Nothing was executed again; this is the recorded result.',
  /** `--status` with more than one value, or one the flow of the 045 does not have. */
  'ledger.batch.status.one_at_a_time':
    'One status at a time: the batch flow is short (staged → checked → posted) and a multiple filter answers no question that two runs do not answer better.',
  'ledger.batch.status.unknown':
    '--status "{value}" does not exist in the batch flow. The real statuses (045): {statuses}. The pending|running|completed|failed|cancelled vocabulary does not belong to this table.',
  /** `--check` with a category outside the service's closed list. */
  'ledger.batch.check.categories_unknown':
    '--check does not recognize: {unknown}. The closed categories are {categories}. The whole battery always runs; the filter only narrows the report.',
  /** `batch list`: the flags of the list contract it cannot honour, and its cap. */
  'ledger.batch.list.flag_unsupported':
    '{flag} does not apply to batches: a batch is filtered by when it was prepared, with --since (created_at >= date). There is no upper bound and no date basis to choose.',
  'ledger.batch.list.offset_unsupported':
    '--offset is not implemented in this family: the query orders by created_at and caps with --limit, with no stable cursor. Narrow with --since or raise --limit.',
  'ledger.batch.list.capped':
    '{count, plural, one {# batch was listed} other {# batches were listed}}, which is the --limit cap: there may be more. Raise --limit or narrow with --since.',
  /** `batch show`: the card, its labels and the rows. */
  'ledger.batch.show.file_label': 'file',
  'ledger.batch.show.rows_label': 'rows',
  'ledger.batch.show.prepared_label': 'prepared',
  'ledger.batch.show.unnamed': '(no name)',
  'ledger.batch.show.rows':
    '{total} total · {invalid} invalid · {posted, plural, one {# entry} other {# entries}} in the ledger',
  'ledger.batch.show.prepared': '{date} by {user}',
  'ledger.batch.show.rows_title': 'ROWS',
  'ledger.batch.show.empty': 'the batch is empty',
  'ledger.batch.show.no_parse_errors': 'no row with a parse error',
  'ledger.batch.show.errors_by_category': 'parse errors by category:',
  /** `batch check`: the heading, the report and its verdict. */
  'ledger.batch.check.rows_checked': '· {count, plural, one {# row checked} other {# rows checked}}',
  'ledger.batch.check.strict': ' · strict',
  'ledger.batch.check.narrowed': ' · report narrowed to {categories}',
  'ledger.batch.check.nothing_to_show': 'no finding to show',
  'ledger.batch.check.all_valid':
    "{count, plural, one {# valid row} other {# valid rows}}: the batch stays '{status}'.",
  'ledger.batch.check.some_invalid':
    "{invalid} invalid and {valid} valid: the batch stays '{status}'. Fix the file and import it again, or apply what is valid with `batch post --partial`.",
  'ledger.batch.check.hidden_blocking':
    '{count, plural, one {# blocking finding was} other {# blocking findings were}} left out of the report by --check; the exit code counts them all the same.',
  /** `batch post`: the preview, the question, the receipt and the dry-run note. */
  'ledger.batch.post.preview': '· {count, plural, one {# entry} other {# entries}} · Debit {total}{already}',
  'ledger.batch.post.already': ' · {count, plural, one {# was already there} other {# were already there}}',
  'ledger.batch.post.left_staged':
    '{count, plural, one {# row stays in staging:} other {# rows stay in staging:}}',
  'ledger.batch.post.confirm':
    'You are about to POST {count, plural, one {# entry} other {# entries}} of batch {id} for {total} (Debit){left}. The ledger is immutable: this is only corrected by a reversal. Continue?',
  'ledger.batch.post.confirm_left': ', leaving {count, plural, one {# row} other {# rows}} in staging',
  'ledger.batch.post.recorded': '{count, plural, one {# entry} other {# entries}} of batch {id}',
  'ledger.batch.post.receipt':
    "→ '{status}' · {posted} posted · {already} already there · {staged} in staging · Debit {total}",
  'ledger.batch.post.dry_run':
    'Dry run: it was posted for real and rolled back; the folios shown were not reserved.',
  /** `batch reverse`. */
  'ledger.batch.reverse.preview': '· {count, plural, one {# mirror} other {# mirrors}}{dated}',
  'ledger.batch.reverse.dated': ' dated {date}',
  'ledger.batch.reverse.confirm':
    'You are about to REVERSE batch {id}: {count, plural, one {# posted mirror} other {# posted mirrors}}, one per entry, in a single transaction. Each entry admits ONE reversal (041). Continue?',
  'ledger.batch.reverse.recorded': '{count, plural, one {# mirror} other {# mirrors}} of batch {id}',
  'ledger.batch.reverse.receipt':
    "· {count, plural, one {# mirror} other {# mirrors}} · the batch stays '{status}': the truth of the reversal lives in reversed_by_entry_id of each entry",
  'ledger.batch.reverse.dry_run': 'Dry run: the mirrors were created for real and rolled back; nothing was written.',
  // MNE-001-229: account. The English that was printed is the same, byte for byte.
  /** The tail of every dry run that writes nothing. */
  'ledger.account.dry_run_note': ' (dry-run: nothing was written)',
  /** `account list` and `account create`. */
  'ledger.account.type_unknown': 'Unknown --type "{value}". Use one of: {types}.',
  'ledger.account.normal_balance_unknown': 'Unknown --normal-balance "{value}". Use debit or credit.',
  'ledger.account.show.disappeared': 'Account {code} disappeared while reading it.',
  /** `account edit`. */
  'ledger.account.edit.nothing_to_change': 'Nothing to change. Pass --name, --description, --subtype or --fs-category.',
  'ledger.account.edit.done': '{code} updated.',
  /** `account archive`. `code` arrives in bold. */
  'ledger.account.archive.would_archive': '{code} would be archived. Lifetime balance: {balance}.',
  'ledger.account.archive.would_keep_history': ' It has posted history, which would stay intact.',
  'ledger.account.archive.done': '{code} archived. Reason: {reason}',
  'ledger.account.archive.forced': ' (with a live balance of {balance}, forced)',
  'ledger.account.archive.history_intact': ' Posted history stays intact.',
  /** `account set`: the dry run, and the pairs it reads. */
  'ledger.account.set.would_set': '{code} would set: {flags}',
  'ledger.account.set.pair_unreadable': 'Unreadable pair "{pair}": key=value is expected.',
  'ledger.account.set.key_unknown': 'Unknown key "{key}". Valid: {keys}.',
  'ledger.account.set.value_unreadable': 'Unreadable value "{value}" for {key}: use true or false.',
  /** `account balance show`, when a period is open. */
  'ledger.account.balance.open_period_note':
    'Note: beginning_balance is only seeded at the hard close; in open periods it reads the activity, not the cumulative balance.',
  /** `account role set` / `seed` / `sync`. */
  'ledger.account.role.set.would_point': 'The role {role}{qualifier} would point to {code} {name}',
  'ledger.account.role.seed.done':
    '{roles, plural, one {# role mapped} other {# roles mapped}}, {accounts, plural, one {# base account created} other {# base accounts created}}',
  'ledger.account.role.seed.unmapped': ' — unmapped: {roles}',
  'ledger.account.role.sync.not_mexican': 'This entity does not keep Mexican books: it has no withholding roles.',
  'ledger.account.role.sync.nothing': 'Nothing to change.',
  'ledger.account.role.sync.done': 'applied and audited; no entry was posted.',
  /** `account map set`. `clear` is `yes` for an empty --value; `name` is the official name, with its leading space. */
  'ledger.account.map.year_invalid': '--year must be a four-digit fiscal year; got "{value}".',
  'ledger.account.map.set.dry_run':
    '{code}: {scheme} {clear, select, yes {would be cleared} other {would be {value}{name}}} (dry-run)',
  /** `account map import`. `mode` is `dry_run` or `done`. */
  'ledger.account.map.import.no_pairs': 'The file {file} has no readable code,value pairs.',
  'ledger.account.map.import.done':
    '{applied}/{total} mappings {mode, select, dry_run {applicable} other {applied}} ({scheme})',
  'ledger.account.map.import.repeated': ' [repeated: the result of the first run]',
  'ledger.account.map.import.no_account': '  · {code}: does not exist in the chart',
  'ledger.account.map.import.empty_value': '  · {code}: empty value, skipped',
  /** `account map check`. `chosen` is `panel` when someone answered the scope key. */
  'ledger.account.map.check.available': 'Available checks: {checks}',
  'ledger.account.map.check.unknown': 'Unknown check: {unknown}. Available: {checks}.',
  'ledger.account.map.check.level_retired':
    '--level no longer applies: the gate measured by account level and that was the defect (43 gaps on a real entity, 42 of them accounts without a single movement, and the moved account without an agrupador left off the list for being at level 3). Today the population is set by the agrupador_alcance_de_la_compuerta policy; it is changed with {hint}.',
  'ledger.account.map.check.scope':
    'scope "{scope}", {chosen, select, panel {chosen in the panel} other {by default}}',
  'ledger.account.map.check.empty': '0 accounts in the {scope}: nothing was checked',
  'ledger.account.map.check.complete':
    '✔ full coverage: {count, plural, one {# account} other {# accounts}} with {scheme} ({scope})',
  'ledger.account.map.check.gaps':
    '{gaps} of {count, plural, one {# account} other {# accounts}} without {scheme} ({scope}): the catalog XML would come out incomplete',
  /** `account restore`. */
  'ledger.account.restore.done': '{code} is active again.',
  // MNE-001-230: fx. The English that was printed is the same, byte for byte.
  /** `fx rate list`. `source` is `none` when the policy names no source this reader maps. */
  'ledger.fx.list.status_unsupported':
    '--status does not apply here: a published exchange rate has no lifecycle state. Filter with --pair, --source, --rate-type, --since or --until.',
  'ledger.fx.list.policy':
    'The fuente_tipo_cambio policy of this firm is "{value}"{source, select, none {, which this reader maps to no source.} other { → source \'{source}\' (policy column: ✓).}}',
  'ledger.fx.list.no_entity': 'No active entity could be resolved: the source the firm policy uses could not be marked.',
  /** `fx rate show`: the not-found, and the card of a derived or carried rate. */
  'ledger.fx.show.not_found':
    'No {from}/{to} rate ({type}) can be resolved for {date}: not direct, not inverse, not crossed through USD. Capture it with fx rate set.',
  'ledger.fx.show.derived': ', derived from the inverse or a cross',
  'ledger.fx.show.inverse': 'inverse {pair} = {rate}',
  'ledger.fx.show.inverse_derived': ' (derived)',
  'ledger.fx.show.carried':
    '⚠ carried from {date}: there is no rate for the day asked. If you need that day\'s rate, capture it with fx rate set.',
  /** `fx rate set`. */
  'ledger.fx.set.source_required':
    '--source is required: say who published the rate ({sources}). DOF and FIX for the same day are different numbers and coexist since migration 057.',
  'ledger.fx.set.would_set': 'Would set {pair} {date} = {rate}',
  'ledger.fx.set.until': ', until {date}',
  'ledger.fx.set.done': 'set as {rate}',
  /** `fx rate download`: who publishes each source, and why running it fails closed. */
  'ledger.fx.publisher.dof':
    'the Federation Official Gazette (DOF; the tax rate of art. 20 CFF, and an operation takes the one published the business day before)',
  'ledger.fx.publisher.banxico_fix': 'Banxico FIX through the SIE (needs a SIE API token)',
  'ledger.fx.publisher.fed': 'Federal Reserve H.10',
  'ledger.fx.publisher.ecb': 'European Central Bank, reference rates',
  'ledger.fx.download.retry_calls_again': 'a retry calls the exchange-rate provider again',
  'ledger.fx.download.source_required': '--source is required: {sources}.',
  'ledger.fx.download.source_unknown': 'Unknown --source "{value}". Use one of: {sources}.',
  'ledger.fx.download.range_twice': '--as-of and --since/--until are two ways of saying the range; use one.',
  /** `why` is `sie` for banxico-fix, which needs a token; `source` is the schema's source. */
  'ledger.fx.download.no_connector':
    'The download connector does not exist yet: this project does not speak HTTP with third parties without a governed credential, and {why, select, sie {the Banxico SIE requires a token that no credential store of the system governs yet} other {there is no client declared for that source}}. Making up the rate would be the very fault the anti-simulation lock of the PACs prevents. Today the honest paths are: fx rate set <pair> <date> <rate> --source {source} with the published value, or fx rate import (phase 2) from a file.',
  'ledger.fx.download.would_download': 'Would download from {publisher}',
  'ledger.fx.download.dates': 'dates: {range}',
  'ledger.fx.download.today': '(today)',
  'ledger.fx.download.target':
    "target: exchange_rates with source='{source}' (057 lets DOF and FIX of the same day live side by side)",
  'ledger.fx.download.will_fail': '⚠ running it will fail: {reason}',
  // MNE-001-230: ledger. Its «Available checks» and its open-period note are account's keys.
  /** `ledger check`. `checks` is the names asked for, or `blocking_checks`. */
  'ledger.ledger.check.passes': '✔ the ledger passes {checks}',
  'ledger.ledger.check.blocking_checks': 'the blocking checks',
  'ledger.ledger.check.findings':
    '{blocking, plural, one {# blocking finding} other {# blocking findings}}, {warning, plural, one {# warning} other {# warnings}}',
  /** `ledger stale-draft list`. */
  'ledger.ledger.stale_draft.days_unreadable': 'Unreadable --days: "{value}".',
  'ledger.ledger.stale_draft.found':
    '{count, plural, one {# draft} other {# drafts}} older than {days, plural, one {# day} other {# days}}. Post them with entry post, or withdraw them.',
  /** `ledger auxiliary show`: the heading, why its beginning balance is not reliable, and the totals. */
  'ledger.ledger.auxiliary.heading': '{code} {name} · {period} ({status}) · beginning {beginning}{unreliable}',
  'ledger.ledger.auxiliary.no_carry': "no carry-forward: {period} is '{status}'",
  'ledger.ledger.auxiliary.no_previous': 'no previous period: there is no cumulative balance to carry',
  'ledger.ledger.auxiliary.totals': 'debits {debits} · credits {credits} · ending {ending}',
  'ledger.ledger.auxiliary.drift': ' (computed {computed}: there is drift — run ledger check)',
  /** `ledger balance show --dim`. */
  'ledger.ledger.balance.dim_unavailable':
    '--dim is not available yet: dimensions have no master record yet (dimension family).',
  // MNE-001-230: entry, its Spanish. Import's «row N» is batch's key.
  'ledger.entry.preview.heading': '{number} ({status}) · {period} · delta by account if it were posted:',
  'ledger.entry.preview.no_period': 'no period',
  'ledger.entry.edit.done': '{number} edited (still a draft; post it with entry post).',
  'ledger.entry.export.done':
    '{count, plural, one {# line exported} other {# lines exported}}. No XLSX yet: use --format csv and open it in the spreadsheet.',
  'ledger.entry.import.dry_run':
    '{valid, plural, one {# readable entry} other {# readable entries}}, {invalid} with errors (dry-run: nothing was staged)',
  'ledger.entry.import.done':
    'batch {id}: {valid, plural, one {# entry staged} other {# entries staged}}, {invalid} with errors',
  'ledger.entry.import.repeated': ' [repeated: the batch of the first run]',
  'ledger.entry.import.not_in_ledger':
    'The batch did NOT touch the ledger: it is checked and posted with the batch family (check/post); meanwhile, it can be inspected by batch_id.',
  // MNE-001-626: entry's English, which it printed without a key. The note on
  // the active entity is period's key, the question with no terminal is ap's,
  // and the unknown --status and --type are period's and account's. «{count}
  // lines» stays as English printed it, «1 lines» included: the acceptance
  // keeps the English byte for byte.
  /** `--line`, as `create` and `edit` read it. */
  'ledger.entry.line.no_account': 'Line "{spec}" has no account=<code>.',
  'ledger.entry.line.one_side': 'Line "{spec}" needs exactly one of debit=<amount> or credit=<amount> (cargo=/abono=).',
  /** A replayed `post`, `reverse` or `void`. `what` is the act's own `recorded` line. */
  'ledger.entry.idempotency_hit':
    '↩ Idempotency hit: key "{key}" already completed this act — {what}\n  Nothing was executed again; this is the recorded result.',
  /** `entry list`. */
  'ledger.entry.list.as_of_unsupported': '`entry list` filters a date RANGE: use --since and --until, not --as-of.',
  'ledger.entry.list.date_basis_unavailable':
    '--date-basis {value} is not available: journal_entries stores one date (entry_date, the ledger date). Only --date-basis posting is supported.',
  /** `entry show`: the card a terminal gets. */
  'ledger.entry.show.reference': 'reference: {reference}',
  'ledger.entry.show.reverses': 'reverses: {number}',
  'ledger.entry.show.reversed_by': 'reversed by: {number} (this entry is annulled)',
  'ledger.entry.show.totals': 'totals: {debits} debit / {credits} credit',
  /** `entry create` and `entry edit`. `number` arrives in bold in `drafted`. */
  'ledger.entry.lines_or_file': 'Pass either --line flags or a --file document, not both.',
  'ledger.entry.create.nothing_to_record':
    'Nothing to record. Give the lines with --line "account=<code>;debit=<amount>" (repeat it), or a JSON document with --file.',
  'ledger.entry.create.drafted': '{number} drafted',
  'ledger.entry.create.drafted_detail': '({count} lines, {debits} / {credits})',
  'ledger.entry.create.not_posted': 'Nothing moved in the ledger. Post it with: mnemosine entry post {number}',
  /** The verdict of `create --dry-run`, `check` and `post`: its headline, then where the entry lands. */
  'ledger.entry.verdict.would_draft': 'Would draft',
  'ledger.entry.verdict.checked': 'Checked',
  'ledger.entry.verdict.would_post': 'Would post',
  'ledger.entry.verdict.cannot_post': 'Cannot post',
  'ledger.entry.verdict.new_entry': '(new entry)',
  'ledger.entry.verdict.context': '{date} · {period} ({status}) · {count} lines',
  'ledger.entry.verdict.all_rules_pass': 'All seven rules pass.',
  'ledger.entry.verdict.no_blocking': 'No blocking errors.',
  /** `entry check`. */
  'ledger.entry.check.nothing_to_check': 'Nothing to check: pass --entry <number> or --file <path>.',
  'ledger.entry.check.one_at_a_time': 'Check one thing at a time: --entry or --file, not both.',
  /** `entry post`. `amounts` is the parenthesised total, dim on the receipt. */
  'ledger.entry.post.already_posted':
    '{number} is already posted ({date}). Correct it with `entry reverse`, which leaves an audit trail.',
  'ledger.entry.post.void': '{number} is void and can never be posted.',
  'ledger.entry.post.invalid': '{number} does not pass validation, so it was not posted.',
  'ledger.entry.post.question': 'Post {number} ({total}) to the ledger? This cannot be undone.',
  'ledger.entry.post.recorded': '{number} posted {amounts}',
  /** `entry reverse`. */
  'ledger.entry.reverse.not_posted':
    "{number} is '{status}' and never touched the ledger, so there is nothing to mirror. Use `entry void` on a draft.",
  'ledger.entry.reverse.already_reversed': '{number} already has a reversal. A second mirror would double the correction.',
  'ledger.entry.reverse.would_mirror': 'Would create the mirror of {number}',
  'ledger.entry.reverse.would_mirror_detail': 'dated {date}, posted immediately',
  'ledger.entry.reverse.stays_posted': '{number} stays posted and unchanged; the two are linked.',
  'ledger.entry.reverse.question': 'Reverse {number} ({total})? The mirror posts immediately.',
  'ledger.entry.reverse.recorded': '{number} posted as the reversal of {original}',
  'ledger.entry.reverse.linked': '{number} is unchanged and now linked to its mirror.',
  /** `entry void`. `state` is the dim «(now '…')». */
  'ledger.entry.void.already_void': '{number} is already void.',
  'ledger.entry.void.already_reversed':
    '{number} was already annulled by its reversal. A second one would double the correction.',
  'ledger.entry.void.effect_posted':
    '{number} is posted, so it will NOT change state: a linked mirror entry is created and posted, which is how a posted entry is annulled without making the trial balance disagree with the balances.',
  'ledger.entry.void.effect_draft':
    "{number} is '{status}' and never reached the ledger, so it is marked void. Its number is kept and never reused.",
  'ledger.entry.void.would_void': 'Would void {number}',
  'ledger.entry.void.question': 'Void {number} ({total})?',
  'ledger.entry.void.recorded': '{number} annulled {state}',
  'ledger.entry.void.state': "(now '{status}')",
  // MNE-001-230: period and year. «I take it as a no» is bank's key, and the
  // question with no terminal is ap's.
  /** The note of every write that lands in the active entity. */
  'ledger.period.active_entity': '→ {entity} (active entity; name another with --entity)',
  /** How to put a reopened period back (`reopenRemedy`). */
  'ledger.period.remedy.close_again': 'Close it again with: {close}',
  'ledger.period.remedy.seal': '  then seal it, which redoes its carry-forward: {close} --hard',
  /** `period list`. */
  'ledger.period.status_unknown': 'Unknown --status "{value}". Use one of: {statuses}.',
  'ledger.period.year_invalid': '--year "{value}" is not a four-digit year.',
  /** `period show`: the card. */
  'ledger.period.show.overdue': ' · overdue',
  'ledger.period.show.position': 'period {number} of fiscal year {year} · {type}',
  'ledger.period.show.soft_closed': 'soft closed {date}',
  'ledger.period.show.by': ' by {email}',
  'ledger.period.show.hard_closed': 'hard closed {date}',
  'ledger.period.show.entries': 'Entries',
  'ledger.period.show.entries_total': '({count} total)',
  'ledger.period.show.none': 'none',
  'ledger.period.show.checklist': 'Checklist saved at close',
  /** `period open`. `period` arrives in bold. */
  'ledger.period.open.would_open': 'Would open {period}',
  'ledger.period.open.done': '{period} is open',
  /** `period reopen`. */
  'ledger.period.reopen.locked':
    "{period} is 'locked': its information already left the system and it is not reopened — not even with --force. The correction goes in the nearest open period.",
  'ledger.period.reopen.not_closed': "{period} is '{status}': reopening is only for closed periods.",
  'ledger.period.reopen.hard_close':
    '{period} is in hard_close: its closing entries and the carry-forward of balances stay standing when it reopens (the ledger is not touched). If you really want to reopen it, repeat with --force --reason "<why>".',
  'ledger.period.reopen.would_reopen': 'Would reopen {period}',
  'ledger.period.reopen.dry_run':
    '(dry-run: nothing was written; the reopen would be recorded in the audit trail)',
  'ledger.period.reopen.question': 'Reopen {period} ({status} → open)?',
  'ledger.period.reopen.cancelled': 'Cancelled.',
  'ledger.period.reopen.idempotency_hit':
    '↩ Idempotency hit: key "{key}" already reopened {period} (was {previous}). Nothing was executed again.',
  'ledger.period.reopen.done': '{period} is open again',
  'ledger.period.reopen.done_detail': '(was {previous}, by {email}; reason recorded)',
  'ledger.period.reopen.stale':
    'Statements or filings derived from this period are now stale: regenerate them after re-closing.',
  /** `year list`, `year show` and `year create`. */
  'ledger.period.year.status_unknown': "Unknown --status \"{value}\". A fiscal year is 'open' or 'closed'.",
  'ledger.period.year.one_status': "A fiscal year is either 'open' or 'closed': pass one --status, or none.",
  'ledger.period.year.not_a_year': '"{value}" is not a four-digit year.',
  'ledger.period.year.title': 'Fiscal year {year}',
  'ledger.period.year.calendar': ' · calendar year',
  'ledger.period.year.exists':
    'Fiscal year {year} already exists for {entity} with {count, plural, one {# period} other {# periods}}. Nothing would be created.',
  'ledger.period.year.would_create': 'Would create fiscal year {year}',
  'ledger.period.year.would_create_detail':
    'with 12 monthly periods (calendar year) and the year-end adjustment period (13); months already past and the current one open, the rest future',
  /** `year` arrives in bold. */
  'ledger.period.year.created': 'Fiscal year {year} created',
  'ledger.period.year.created_detail': 'with 12 monthly periods and the year-end adjustment period (13)',
  'ledger.period.year.carried':
    '  Opening balances carried from {period}: {count, plural, one {# account} other {# accounts}}',
  'ledger.period.year.open_hint': '  Open a future month with: mnemosine period open <name>',
  /** `year carry-forward run` (MNE-001-645, #594). `period` arrives in bold in `corrected`. */
  'ledger.period.year.carry.corrected':
    'Opening balances of {period} corrected from {source}: {count, plural, one {# account} other {# accounts}}',
  'ledger.period.year.carry.corrected_detail':
    '  No entry was created or edited; the correction is in the audit trail, by {email}.',
  'ledger.period.year.carry.would_correct':
    'Would correct the opening balances of {period} from {source}: {count, plural, one {# account} other {# accounts}}',
  'ledger.period.year.carry.dry_run': '  Dry run: the carry really ran and was rolled back; nothing was written.',
  'ledger.period.year.carry.unchanged':
    'The opening balances of {period} already are the closing balances of {source}: nothing to correct, and nothing was written.',
  // ==== end of I8.9 ====
  // ==== I8b · run-time strings by key, family init, part 1 (MNE-001-479, issue #150) ====
  // `src/cli/init-command.ts`, `init/section.ts`, `init/s0-infra.ts` and
  // `init/s4-policies.ts`. The English is what those files printed, byte for
  // byte ("There are 1 decisions" included); the Spanish takes its plural.
  // Commands, paths and policy keys are parameters, never translated.
  'init.badge.ok': 'configured',
  'init.badge.partial': 'incomplete',
  'init.badge.missing': 'pending',
  'init.secret.skipped': '(skipped: no interactive terminal)',
  'init.status.title': 'Configuration status',
  'init.status.optional': '(optional)',
  'init.wizard.unknown_section': 'Unknown section: "{section}". Options: {options}',
  'init.wizard.rescue_intro':
    "Let's get you set up. Enter accepts the value in parentheses; Ctrl+C pauses — your progress is saved because state lives in the system, not a file.",
  'init.wizard.title': 'Mnemosine setup',
  'init.wizard.interactive': 'Only asking for what is missing. Enter accepts the value in parentheses.',
  'init.wizard.non_interactive': 'Non-interactive mode: using defaults and flags.',
  'init.wizard.already_configured': 'Already configured; moving on.',
  'init.wizard.configure_now': 'Configure now?',
  'init.wizard.skipped': 'Skipped. It will show as pending in init --status.',
  'init.wizard.final_verification': 'Final verification',
  'init.wizard.unresolved': 'Some items are still unresolved. Run again: {command}',
  'init.wizard.start_chat': 'Start chatting now?',
  /** The first message the chat sends for the person, chosen by whether the books hold data. */
  'init.wizard.seed_with_data': 'Say hello and give me a quick health check of my books.',
  'init.wizard.seed_fresh': 'Say hello and tell me what you can do once I load my accounting.',
  'init.wizard.opening_chat':
    'I\'ll open the chat and send your first message: "{seed}". (The agent reads your real data — this may take a few seconds.)',
  'init.wizard.open_chat_with': 'Open the chat with: {command}',
  'init.wizard.ready': 'Ready. Try:',
  'init.wizard.try.chat': 'converse with your accounting',
  'init.wizard.try.review': 'approve or reject pending drafts',
  'init.wizard.try.status': 'where things stand',
  'init.wizard.try.pending': 'what needs your attention',
  'init.wizard.try.doctor': 'system health',
  'init.infra.title': 'Infrastructure (database, migrations, encryption)',
  'init.infra.env_tightened': '{path} was mode {mode}; tightened to 600 (it holds secrets)',
  /** «No .env found. Here: <path>», and «User: <path>» under it with the colons aligned. */
  'init.infra.no_env': 'No .env found.',
  'init.infra.here': 'Here:',
  'init.infra.user_dir': 'User:',
  'init.infra.create_here': 'Create it here (Yes) or in the user directory (No)?',
  'init.infra.env_location': '.env location: {path}',
  'init.infra.chosen_without_asking': '(no terminal: chosen without asking)',
  'init.infra.created_from_example': 'Created {path} from .env.example',
  'init.infra.created_empty': 'Created an empty {path}',
  'init.infra.key_generated':
    'Generated a dedicated 256-bit ENCRYPTION_KEY (the previous one was the example key)',
  'init.infra.database_url': 'DATABASE_URL (Enter to keep the current one):',
  'init.infra.database_url_saved': 'Saved DATABASE_URL. Restart the command to reconnect.',
  'init.infra.start_postgres': 'Start PostgreSQL and run again: docker compose up -d postgres',
  'init.infra.apply_migrations': 'Apply the migrations now?',
  'init.infra.migrations_applied': 'Migrations applied',
  'init.infra.failed': 'Failed: {message}',
  'init.infra.run_manually': 'Run manually: {command}',
  'init.infra.fix': 'Fix: {fix}',
  'init.infra.rls.no_tenant': 'no tenant pinned yet (the identity section pins it)',
  'init.infra.rls.unscoped': 'app.current_tenant is "{applied}" instead of "{tenant}": queries would run unscoped',
  'init.infra.rls.unscoped_fix':
    'Check MNEMOSINE_TENANT in .env; the connection module must apply the tenant on every query',
  'init.infra.rls.scoped': 'tenant {tenant} scoped · {count} entities visible',
  'init.infra.rls.select_failed': 'scoped SELECT failed: {message}',
  'init.infra.rls.select_failed_fix': '{command} (the legal_entities table or its RLS policies may be missing)',
  'init.policies.title': 'Accounting policies',
  'init.policies.no_entity': 'No entity resolved yet; policies are configured after the entity exists.',
  'init.policies.all_defined': 'All policies are already defined.',
  'init.policies.intro_count': 'There are {count} decisions I cannot make on my own.',
  'init.policies.intro_firm': "They depend on your firm's criteria, not on a rule I can look up.",
  /** Wrapped at 68 columns where it is printed. */
  'init.policies.intro_skip':
    'You can skip any of them: each has a working default, and whatever you leave open stays visible in `{command}`.',
  'init.policies.non_interactive': 'Non-interactive mode: leaving {count} policies on their defaults.',
  'init.policies.none': '(none)',
  'init.policies.stopping': 'Stopping here. The rest stay on their defaults.',
  'init.policies.defined': 'Defined {answered} of {total}.',
  'init.policies.still_open': '{left} still open — see `{command}`.',
  'init.policies.nothing_open': 'Nothing left open.',
  'init.policies.why_i_ask': 'Why I ask:',
  'init.policies.what_i_do': 'What I do:',
  'init.policies.in_your_data': 'In your data:',
  'init.policies.current_default': '← current default',
  'init.policies.enter_keeps': 'Enter = keep the default ({value})   ·   q = stop asking',
  'init.policies.left_open': 'Left open: {text}',
  'init.policies.could_not_save': 'Could not save: {message}',
  'init.policies.check.not_seeded': 'Not seeded yet; run `{init}` or `{pending}`',
  'init.policies.check.summary': '{count} policies, {pending} still on defaults',
  'init.policies.check.high_impact': '{keys} still on defaults — they change how invoices are booked',
  'init.policies.check.could_not_read': 'Could not read: {message}',
  // ==== end of I8b · init, part 1 ====
  // ==== I8b · run-time strings by key, family init, part 2 (MNE-001-798, issue #150) ====
  // `init/s1-identity.ts`, `init/s2-users.ts` and `init/s3-ai.ts`. The English
  // is what those files printed, byte for byte ("entity(ies)", "already has 1
  // periods" included); the Spanish takes its plural. Commands, flags, file and
  // variable names, profile names and role keys are parameters or fixed text.
  // The probe's own text (s3-ai.ts `defaultProbe`) goes to the model: no key.
  'init.identity.title': 'Fiscal identity (tenant, legal entity, fiscal year)',
  'init.identity.check.no_open_periods': 'no open periods: no journal entry can be posted',
  'init.identity.check.periods_available': '{count} period(s) available',
  'init.identity.existing': 'There are already {count} entity(ies):',
  'init.identity.add_another': 'Add another entity?',
  'init.identity.name_prompt': 'Legal entity name:',
  'init.identity.country_prompt': 'Country [{choices}] ({default}):',
  'init.identity.no_name': 'Without a name I cannot create the entity; section incomplete.',
  'init.identity.no_tax_id': 'Without {label} I cannot create the entity; section incomplete.',
  'init.identity.created': 'Entity "{name}" created ({taxId}, {country}, {currency})',
  'init.identity.tenant_pinned': 'Tenant pinned in {path} (RLS isolation active)',
  'init.identity.chart_seeded': 'Chart of accounts seeded ({count} accounts)',
  'init.identity.chart_kept': 'Chart of accounts already present — kept as is',
  'init.identity.control_accounts': 'Control accounts added ({count})',
  'init.identity.roles_mapped': 'Account roles mapped ({count})',
  'init.identity.roles_unmapped': '{count} role(s) without an account in this chart:',
  'init.identity.expected_code': '{role} → expected code {code}',
  'init.identity.map_with': 'Map them with: {command}',
  'init.identity.year_created':
    'Fiscal year {year} created with 12 monthly periods and the year-end adjustment period (13)',
  'init.identity.year_empty':
    'Fiscal year {year} exists but has no periods — nothing can be posted. Delete the empty fiscal_years row and re-run, or build another year with `{command}`.',
  'init.identity.year_has': 'Fiscal year {year} already has {count} periods',
  'init.users.title': 'Users and roles',
  'init.users.check.none': 'no active user: review/outbox/questions cannot attribute',
  'init.users.check.no_owner': '{count} user(s) but none with the owner role',
  'init.users.check.summary': '{count} active, {owners} owner(s)',
  'init.users.check.multiple': 'with multiple users, review/questions require {flag}',
  'init.users.current': 'Current users:',
  'init.users.no_role': 'no role',
  'init.users.add_another': 'Add another user?',
  'init.users.email_prompt': 'User email:',
  'init.users.invalid_email': 'Invalid email; section incomplete.',
  'init.users.roles': 'Available roles:',
  'init.users.role_prompt': 'Role [1-{count}] (1):',
  'init.users.password_prompt': 'Password (minimum {min} characters):',
  'init.users.section_incomplete': 'Section incomplete.',
  'init.users.without_terminal': 'Without a terminal: {command}',
  'init.users.created': 'User {email} created with role {role}',
  'init.users.tenant_missing': 'Tenant {tenant} does not exist; section incomplete (see: {command}).',
  'init.users.no_tenant': 'Configure the identity section first (there is no tenant).',
  'init.users.many_tenants': 'This installation has more than one tenant: name the firm with {flag}.',
  'init.users.choosing_for_you': "Choosing for you could give this login another firm's books:",
  'init.ai.title': 'AI provider',
  'init.ai.verifying': 'Provider "{profile}" is already configured; verifying it live…',
  'init.ai.verified': 'Verified: responds to a minimal chat (config left untouched)',
  'init.ai.repair': 'Repair: pick a provider that does respond (the current config is kept until one verifies).',
  'init.ai.available': 'Available providers:',
  'init.ai.which_default': 'Which one do I use by default? ({suggested}):',
  'init.ai.unknown': '"{profile}" does not exist. Leaving the config as is.',
  'init.ai.get_credential': 'Get the credential at: {url}',
  'init.ai.key_prompt': '{variable} (Enter to skip):',
  'init.ai.key_saved': 'Saved {variable} to {path}',
  'init.ai.no_credential': 'Without a credential, {profile} cannot be used yet.',
  'init.ai.ollama_models': 'Models installed in Ollama:',
  'init.ai.model_prompt': 'Model (1):',
  'init.ai.try_another': 'Try another provider?',
  'init.ai.nothing_persisted': 'Nothing was persisted: the previous config (if any) is kept.',
  'init.ai.responds': 'Responds to a minimal chat',
  'init.ai.default_saved': 'Default provider: {profile}',
  'init.ai.env_wins': 'MNEMOSINE_PROVIDER={value} wins over the default_provider just saved.',
  'init.ai.env_wins_empty': 'Empty it (in your .env or shell) to use {profile} by default.',
  'init.ai.too_many': 'Too many failed attempts; nothing was persisted.',
  'init.ai.env_location': ".env location: {path} (yours; never the folder's ./.env)",
  'init.ai.removed_empty': 'Removed the empty {variable}= from {path}, which would hide your key',
  'init.ai.local_wins': '{variable} in {path} wins in {cwd}: that key serves everyone who runs mnemosine here.',
  'init.ai.tools_ok': 'Supports tool-calling (the accounting tools work)',
  'init.ai.tools_missing': 'Does NOT support tool-calling: fine for conversation, not for operating',
  'init.ai.tools_missing_fix': 'Mark tools:false in its profile, or choose another provider.',
  'init.ai.no_response': 'No response: {detail}',
  'init.ai.cause.auth': 'Cause: the credential was rejected (invalid, expired or missing permissions).',
  'init.ai.fresh_key': 'Get a fresh one at: {url}',
  /** Two printed lines, one key each. */
  'init.ai.cause.connection': 'Cause: could not reach the endpoint. Check base_url, your network,',
  'init.ai.cause.connection_more': 'and that the service is running (for local ones: ollama serve, hermes gateway…).',
  'init.ai.cause.other': 'Cause: the provider answered with an unexpected error (see the detail above).',
  'init.ai.project_readers': 'everyone who runs mnemosine in {cwd} reads {path}.',
  'init.ai.save_there': 'Save your choice there (No: in {path})?',
  'init.ai.still_decides': '{path} still decides in {cwd}; your file applies elsewhere.',
  'init.ai.not_copied': '"{profile}" is defined only in {source}; it is not copied into {target}, so nothing was saved.',
  'init.ai.saved_to': 'Saved to {path}',
  'init.ai.window': '{profile} declares a {tokens}-token context window for {declared}, not for {model}.',
  'init.ai.window_fix': 'If yours differs, set compaction.threshold_tokens in the config file.',
  // ==== end of I8b · init, part 2 ====
  // ==== I8b · run-time strings by key, family init, part 3 (MNE-001-799, issue #150) ====
  // `init/s5-import.ts`, `first-run.ts` and `provider-readiness.ts`. The English
  // is what those files printed, byte for byte ("account(s)", "line(s)" and
  // "CFDI(s)" included); the Spanish takes its plural. Commands, the RFC, the
  // provider, the defaults and file, menu and variable names are parameters or
  // fixed text. The `init.first_run.*` reasons are also read by
  // `repairCommandFor` (mnemosine.ts): each language keeps a word of its category.
  'init.import.title': 'Bring your accounting in',
  'init.import.no_entity': 'No entity resolved yet; the import comes after the entity exists.',
  'init.import.why': 'Why I ask: mnemosine is most useful when it sees your real books.',
  'init.import.what': 'What I do: everything lands as reviewable drafts — nothing posts without you.',
  'init.import.how': 'How would you like to start?',
  'init.import.door.api': 'Import from another accounting system by API ({product} today)',
  'init.import.door.xml': 'Ingest CFDI XML files from a folder',
  'init.import.door.fresh': 'Start fresh — you can import anytime later',
  'init.import.non_interactive': 'Non-interactive mode: starting fresh. You can import anytime: {command}',
  'init.import.choice_prompt': 'Choice [{choices}] ({default}):',
  'init.import.fresh': 'Starting fresh. You can import anytime: {command}',
  'init.import.system_prompt': 'External system ({default}):',
  'init.import.cutoff_prompt': 'Cutoff date, balances as of YYYY-MM-DD:',
  'init.import.cutoff_invalid': 'The cutoff must be YYYY-MM-DD. Nothing was imported — re-run when ready:',
  'init.import.reading': 'Reading the remote trial balance…',
  'init.import.plan_failed': 'Could not plan the import: {message}',
  'init.import.plan_failed_more': 'Nothing was created. Full control over the import: {command}',
  'init.import.plan_accounts': 'Remote accounts: {remote} · already exist: {existing} · to create: {create}',
  'init.import.plan_opening': 'Opening balance: {count} line(s) · debits {debits} · credits {credits}',
  'init.import.nothing': 'Nothing to import: the remote trial balance has no balances.',
  'init.import.unbalanced': 'The remote trial balance does not balance (difference {imbalance}).',
  'init.import.balancing_prompt': 'Balancing account code ({default}):',
  'init.import.confirm': 'Create {count} account(s) and the opening balance as a draft?',
  'init.import.cancelled': 'Cancelled. Nothing was created. You can import anytime: {command}',
  'init.import.accounts_created': '{count} account(s) created.',
  'init.import.opening_draft': 'Opening balance in draft {draftId} (ref {reference}).',
  'init.import.review': 'Review the drafts: {command}',
  'init.import.failed': 'Import failed: {message}',
  'init.import.retry_full': 'Retry with full control: {command}',
  'init.import.key.resume': 'Section left incomplete. Re-run to register it: {command}',
  'init.import.key.none': '{entity} has no usable {provider} key yet.',
  'init.import.key.same_rfc': 'Each entity reads and writes only with the key of its own company (same RFC).',
  'init.import.key.where': 'In {provider}: open the company with RFC {rfc} → {menu}.',
  'init.import.key.prompt': '{provider} API key for RFC {rfc} (Enter to skip):',
  'init.import.key.attest': 'This key opens the {provider} company with RFC {rfc}, and no other?',
  'init.import.key.not_attested': 'Not registered: a key for another company would write into its books.',
  'init.import.key.failed': 'Could not register the key: {message}',
  'init.import.key.registered': '{provider} key registered for RFC {rfc} (kept in the vault).',
  'init.import.xml.prompt': 'Folder with CFDI XML files:',
  'init.import.xml.no_folder': 'No folder given. You can ingest anytime: {command}',
  'init.import.xml.unreadable': 'Could not read the folder: {message}',
  'init.import.xml.anytime': 'You can ingest anytime: {command}',
  'init.import.xml.none': 'No *.xml files found there. You can ingest anytime: {command}',
  'init.import.xml.capped':
    'Found {count} files; taking the first {cap} on this first run so the review stays manageable. Ingest the rest with: {command}',
  'init.import.xml.found': 'Found {count} file(s).',
  'init.import.xml.done':
    'Done: {rules} by rules, {drafts} draft(s), {blocked} blocked, {duplicates} duplicate(s), {errors} with errors.',
  'init.import.xml.failed': 'Ingest failed: {message}',
  'init.import.xml.retry': 'Retry anytime: {command}',
  'init.import.check.data': '{entries, plural, one {# journal entry} other {# journal entries}}, {xmls} CFDI(s) ingested',
  'init.import.check.no_data': 'No accounting data yet',
  'init.import.check.no_data_fix': 'Import with `{onboard}` or ingest CFDIs with `{ingest}`',
  'init.import.check.drafts': '{count} opening-balance draft(s) awaiting approval',
  'init.import.check.drafts_fix': 'Approve or reject with `{command}`',
  'init.first_run.no_env': 'no .env file (never configured)',
  'init.first_run.no_database_url': '{variable} is not set (add it to your .env)',
  'init.first_run.database_unreachable': 'database unreachable: {message}',
  'init.first_run.timed_out': 'timed out after {ms}ms',
  'init.first_run.no_entities': 'no legal entities registered',
  'init.first_run.no_provider': 'AI provider not configured',
  'init.first_run.provider_missing': 'provider {name} does not exist',
  'init.first_run.check_failed': 'setup check failed: {message}',
  'provider.list.default': '← default',
  'provider.list.tools': 'tools',
  'provider.list.no_tools': 'no tools',
  'provider.list.config': 'Config: {source}',
  'provider.list.builtin':
    'Using built-in profiles. Customize with mnemosine.config.json (or ~/.mnemosine/config.json) and pick the default with "default_provider", MNEMOSINE_PROVIDER or --provider.',
  'provider.tick.no_config': 'provider: the configuration does not load ({command} says why)',
  'provider.tick.missing': 'provider {name} does not exist ({command} says more)',
  'provider.tick.line': 'provider {name} · {credential} · the credential of the user running this tick',
  // ==== end of I8b · init, part 3 ====
  // ==== I8b · run-time strings by key, family root, part 1 (MNE-001-800, issue #150) ====
  // `mnemosine.ts` above `chat` (the provider failures, the agent's question, the repair, broken-startup and rescue
  // lines, the tenant of the invocation, `entities`), `banner.ts`, `web-command.ts` and `trace-completion-output.ts`.
  // The English is what they printed, byte for byte. Commands, flags, variables, ids and counts are parameters or fixed text.
  'root.provider.anthropic_auth': 'Authentication error with the Anthropic API.',
  'root.provider.rejected': 'The provider rejected the credential (401).',
  'root.provider.rejected_remedy': 'Check the environment variable named by api_key_env in the profile (mnemosine providers).',
  'root.provider.unreachable': 'Could not connect to the provider endpoint.',
  'root.provider.unreachable_remedy': 'If it is a local model (ollama, hermes-agent), check that the server is running.',
  'root.provider.api_error': 'Provider API error ({status}): {message}',
  'root.ask.heading': '❓ The agent asks:',
  'root.ask.hint': '(option number or free text; empty = leave pending for `mnemosine questions`)',
  /** The prompt of the agent's question; the code adds the space after it. */
  'root.ask.prompt': 'answer>',
  'root.ask.left_pending': 'Left pending: nothing was recorded as a precedent.',
  'root.broken.heading': 'Something needs attention before we can chat:',
  'root.rescue.welcome': 'Welcome. Mnemosine is an AI accountant that keeps your books auditable: it drafts, you approve.',
  'root.tenant.flags_disagree': '--tenant says {root} and -t says {leaf}. Pick one: they are the same flag and two different tenants.',
  'root.tenant.from_config': 'the `tenant` key in mnemosine.config.json',
  'root.tenant.not_uuid': 'The tenant must be a UUID; {source} carries "{tenant}".',
  'root.tenant.not_uuid_remedy': 'mnemosine entity list --tenant <uuid>   (the id `mnemosine init` printed)',
  'root.tenant.flag_over_env': 'tenant {tenant} (--tenant); MNEMOSINE_TENANT={ignored} ignored',
  /** `origin` is the internal word of where the tenant came from, passed through. */
  'root.tenant.in_use': 'tenant {tenant} ({origin})',
  'root.tenant.no_context': 'no tenant context: every RLS-scoped query will return zero rows',
  'root.tunnel_established': 'SSH tunnel established',
  'root.tenant.missing': 'No tenant with id {tenant}. Nothing would be visible under it, and an empty report is not the same as an empty ledger.',
  'root.tenant.missing_remedy': 'check the id `mnemosine init` printed, or MNEMOSINE_TENANT in .env',
  'root.tenant.inherited_from': 'from {source}',
  'root.tenant.inactive': 'Tenant {tenant} exists but is not active. Its data stays where it is; reactivate it before operating on it.',
  'root.entities.renamed': '`mnemosine entities` is now `mnemosine entity list`; the old name still works.',
  'root.entities.none_active': 'No active entities in this tenant.',
  'root.entities.none_visible': 'No entities visible. If the database enforces tenant isolation, specify one with --tenant <uuid> or MNEMOSINE_TENANT.',
  'banner.tagline': 'Your books, remembered.',
  'banner.hint': 'chat: just type · /help for commands · mnemosine status for a checkup',
  /** The labels of the banner's right column, padded to the longest of the language plus one. */
  'banner.label.entity': 'entity',
  'banner.label.provider': 'provider',
  'banner.label.language': 'language',
  'banner.label.pending': 'pending',
  'banner.pending.drafts': '{count, plural, one {# draft} other {# drafts}}',
  'banner.pending.questions': '{count, plural, one {# question} other {# questions}}',
  'banner.pending.writes': '{count, plural, one {# queued write} other {# queued writes}}',
  'web.start.flag_against': '{flag} {value} against {origin}',
  'web.start.origin_mismatch': 'the browser reaches the gateway at {origin}, which this run does not listen on ({problems}). Pass --public-origin with the address the browser opens, set GATEWAY_PUBLIC_ORIGIN, or drop the flag.',
  /** `problems` are the gateway's own lines, joined by the code. */
  'web.start.refuses': 'the web gateway refuses to start:\n  - {problems}',
  'payment.trace.dry_run': 'Dry run: nothing was written.',
  // ==== end of I8b · root, part 1 ====
  // ==== I8b · run-time strings by key, family root, part 2 (MNE-001-859, issue #150) ====
  // `chat`, `sessions`, `drafts` and the review helpers above `review` (the draft card, the menu, the editor, the
  // precedent offer). The English is byte for byte ("older messages", "draft(s)", "message{s}" included).
  'root.chat.transcript_off': '(transcript disabled: {reason})',
  'root.chat.not_configured': 'Not configured. Run: mnemosine init',
  'root.chat.setup_anytime': 'You can set up anytime: mnemosine init',
  'root.chat.commands': 'Commands: /exit  /new (restart)  /provider [name] (switch model)  /help',
  'root.chat.session_missing': 'Session {id} does not exist in this entity.',
  'root.chat.no_previous': 'No previous session for this entity; starting a new one.',
  'root.chat.resuming': 'Resuming session {id}',
  'root.chat.last_active': '{title} · last active {when}',
  /** The two speakers of the transcript; the code pads them to the longer one. */
  'root.chat.you': 'you>',
  'root.chat.ai': 'ai>',
  'root.chat.reminder': '(reminder only — the model starts with a fresh context)',
  'root.chat.interrupted': 'Interrupted.',
  'root.chat.seed': 'Sending your first message: "{message}"',
  'root.chat.restarted': 'Conversation restarted.',
  'root.chat.current_provider': 'Current: {label}. Available: {profiles} (default: {default})',
  'root.chat.compacted': 'Compacted: summarized {dropped} older messages (~{dropTokens} tokens); kept ~{keepTokens} tokens intact.',
  'root.chat.nothing_to_compact': 'Nothing to compact.',
  'root.chat.help': 'Ask about your accounting in natural language. Examples:\n' +
    '  How is the trial balance doing?\n' +
    '  Which customers owe me and since when?\n' +
    '  record the August rent: 10,000 from banks\n' +
    '  /provider hermes   ← switch models mid-session\n' +
    '  /pending [-v]      ← policy decisions awaiting definition\n' +
    '  /compact           ← summarize older turns to free context\n' +
    '  mnemosine usage · status · jobs   ← more tools outside the chat',
  'root.chat.goodbye': 'Goodbye.',
  'root.chat.resume_hint': 'Resume this conversation:  mnemosine --continue',
  'root.sessions.none': 'No recorded sessions for this entity.',
  'root.sessions.untitled': '(untitled)',
  'root.sessions.meta': '({when} · {provider} · {model} · {count, plural, one {# message} other {# messages}})',
  'root.drafts.none': 'No drafts.',
  'root.drafts.none_with_status': 'No drafts with status {status}.',
  'root.drafts.meta': '({lines} lines · conf {confidence} · {status} · {id})',
  'root.review.card.heading': 'Draft {index}/{total}',
  'root.review.card.date': 'date:',
  'root.review.card.confidence': 'AI confidence:',
  'root.review.card.description': 'description:',
  'root.review.card.reference': 'reference:',
  'root.review.card.reasoning': 'reasoning:',
  /** The columns of the draft's lines, as wide as the English ones (10, 40, 11 and 11). */
  'root.review.column.account': 'account',
  'root.review.column.description': 'description',
  'root.review.column.debit': 'debit',
  'root.review.column.credit': 'credit',
  /** The letters are the keys the menu reads: a, e, r, q. The code adds the line break before and " > " after. */
  'root.review.menu': '[a]pprove and post  [e]dit then approve  [r]eject  ENTER next  [q]uit',
  'root.review.menu_yes': '«{said}» is a yes, and this is not a yes/no question: in Spanish it reads as «sí» and in English as «skip» — opposite outcomes. Type `a` to approve AND POST, or press ENTER to move on without touching this draft.',
  'root.review.menu_unclear': 'I did not understand «{said}»; the keys are above.',
  'root.review.editor.no_amount': 'no amount',
  'root.review.editor.which_line': 'Correct which line? (1-{count}, «d» description, ENTER done)',
  'root.review.editor.new_description': 'New description (ENTER keeps «{current}»)',
  'root.review.editor.gave_up': 'Still not understood; leaving the editor with what was corrected so far.',
  'root.review.editor.unclear': 'I did not understand «{said}»: a line number 1-{count}, «d», or ENTER.',
  'root.review.editor.account': 'Line {n} account code (ENTER keeps «{current}»)',
  'root.review.editor.amount': 'Line {n} {side} amount (ENTER keeps {current})',
  'root.review.editor.not_positive': '«{said}» is not a positive amount; line {n} keeps what it had.',
  'root.review.seed.offer': 'Precedent this could seed, so the AI stops repeating it:',
  'root.review.seed.when': 'when: {rule}',
  'root.review.seed.then': 'then: {criterion}',
  'root.review.seed.ask': 'Seed it as a firm criterion, attributed to you?',
  'root.review.seed.declined': 'Not seeded: the rejection stands and nothing was taught.',
  'root.review.seed.done': 'Criterion seeded by {email}; review it with: mnemosine memory',
  'root.review.seed.failed': 'The rejection stands; the criterion was not seeded.',
  // ==== end of I8b · root, part 2 ====
  // ==== I8b · run-time strings by key, family ar, part 1 (MNE-001-802, issue #150) ====
  // `src/cli/invoice-command.ts` and `src/cli/ar-command.ts`. The English is
  // what those files printed, byte for byte ("gap(s)" and "warning(s)"
  // included); the Spanish takes its plural. Commands are parameters, and
  // amounts and dates arrive already formatted.
  'ar.confirm.aborted': 'Aborted — {reason}.',
  'ar.invoice.line.legacy_tax_key': 'tax= in an invoice line is the RATE in percent; write tax-rate= so it cannot be read as an amount. tax= stops working in {version}.',
  'ar.invoice.line.no_price': 'Line "{spec}" has no price=<amount>.',
  'ar.invoice.due_before_date': '--due-date {due} falls before the invoice date {date}.',
  /** `(1160.00 MXN, due 2026-08-30)` after a created or edited invoice. */
  'ar.invoice.amount_due_on': '({amount} {currency}, due {date})',
  'ar.invoice.dry_run': 'Nothing was written.',
  'ar.invoice.file.unreadable': 'Cannot read {path} as JSON: {message}',
  'ar.invoice.file.not_array': '{path} must contain a JSON array of line objects.',
  'ar.invoice.file.line_not_object': '{path} contains a line that is not an object.',
  'ar.invoice.list.date_basis_value': '--date-basis value is not available on an invoice: the value date belongs to the cash that settles it, not to the document. Use --date-basis document or posting.',
  'ar.invoice.list.period_or_range': 'Use --period or --since/--until, not both.',
  'ar.invoice.show.disappeared': 'Invoice {ref} disappeared while reading it.',
  /** The facts of `invoice show`. Subtotal, Total and CFDI read the same in Spanish and stay in the code. */
  'ar.invoice.show.invoice_date': 'Invoice date',
  'ar.invoice.show.due_date': 'Due date',
  'ar.invoice.show.tax': 'Tax',
  'ar.invoice.show.paid': 'Paid',
  'ar.invoice.show.due': 'Due',
  'ar.invoice.show.po': 'PO',
  'ar.invoice.show.memo': 'Memo',
  'ar.invoice.show.ledger_entry': 'Ledger entry',
  'ar.invoice.show.not_posted': 'not posted — run `{command}`',
  'ar.invoice.show.not_stamped': 'not stamped — this is a local document',
  'ar.invoice.show.lines': 'Lines',
  'ar.invoice.show.cash_applied': 'Cash applied',
  'ar.invoice.create.customer_archived': '{number} is archived. Restore it with `{command}` before billing it.',
  'ar.invoice.create.lines_missing': 'An invoice needs at least one line: pass --line "account=<code>;qty=<n>;price=<amount>;tax-rate=<%>" (repeatable) or --from-file <path>.',
  'ar.invoice.create.terms_unreadable': 'Cannot derive a due date from this customer\'s terms ("{terms}"). Pass --due-date <YYYY-MM-DD>.',
  'ar.invoice.create.not_revenue': 'Note: {code} {name} has type "{type}", not revenue.',
  'ar.invoice.create.drafted': '{number} drafted for {customer}',
  'ar.invoice.create.not_posted': 'Nothing was posted and nothing was stamped. Post it with `{command}`.',
  'ar.invoice.issue.already_issued': '{number} was already issued and is in the ledger. Correct it with `{command}`, which reverses the entry and leaves the trail.',
  'ar.invoice.issue.never': '{number} is {status} and can never be issued.',
  'ar.invoice.issue.zero_total': '{number} totals {total}. An invoice with no amount posts nothing; add lines with `{command}` or void it.',
  'ar.invoice.issue.confirm': 'Post {number} ({amount} {currency}) to the ledger? This cannot be undone.',
  'ar.invoice.issue.would_post': 'Would post {number}',
  'ar.invoice.issue.as_entry': 'as {entry}',
  'ar.invoice.issue.no_entry': 'no entry',
  'ar.invoice.issue.issued': '{number} issued as {entry}',
  'ar.invoice.issue.dry_run_note': 'Nothing was written. Re-run without --dry-run to post it.',
  'ar.invoice.issue.posted_note': 'The document is posted, not stamped and not delivered.',
  'ar.invoice.void.paid': '{number} is paid. Unapply the cash first, or issue a credit note.',
  /** `reverse` is `yes` when the invoice reached the ledger. */
  'ar.invoice.void.confirm': 'Void {number} ({amount} {currency}){reverse, select, yes { and reverse its ledger entry} other {}}?',
  'ar.invoice.void.would_void': 'Would void {number}',
  'ar.invoice.void.voided': '{number} voided',
  'ar.invoice.void.would_reverse': 'and reverse its ledger entry.',
  'ar.invoice.void.reversed': 'and its ledger entry reversed.',
  'ar.invoice.void.never_posted': '(it had never reached the ledger).',
  'ar.invoice.edit.not_draft': '{number} is "{status}". Only a draft can be edited: correct an issued invoice with `{command}` or a credit note.',
  'ar.invoice.edit.edited': '{number} edited',
  'ar.invoice.edit.still_draft': 'Still a draft: nothing posted, nothing stamped.',
  'ar.invoice.delete.not_draft': '{number} is "{status}". Only a draft can be deleted; an issued invoice is voided, which leaves the reversal trail.',
  'ar.invoice.delete.would_delete': 'Would delete {number}',
  'ar.invoice.delete.would_delete_detail': '({amount} {currency}, draft). The folio would remain as a documented gap.',
  'ar.invoice.delete.confirm': 'Delete draft {number} ({amount} {currency})? The document is erased; only the audit trail keeps its numbers.',
  'ar.invoice.delete.deleted': '{number} deleted',
  'ar.invoice.delete.gap_note': 'the folio stays as a gap that `{command}` will report as explained.',
  'ar.invoice.series.list.no_status': '`{command}` has no lifecycle state to filter on: a folio series is a counter, not a document.',
  'ar.invoice.series.check.year_invalid': '--year must be a four-digit year; got "{value}".',
  'ar.invoice.series.check.usage': '{used} used, counter at {counter}',
  'ar.invoice.series.check.no_gaps': 'No gaps: the series is continuous.',
  'ar.invoice.series.check.unexplained': '{count} gap(s) WITHOUT a trail: a transaction rolled back mid-issue, or worse. Each folio needs an explanation an auditor will accept.',
  'ar.invoice.series.check.all_explained': 'Every gap has its audit trail (deleted drafts with a reason).',
  /** `ar reconcile`: the title, the header and the row labels. The signs (−, +) stay in the code. */
  'ar.reconcile.title': 'AR reconciliation',
  'ar.reconcile.header': 'control {code} {name}',
  'ar.reconcile.row.control_balance': 'Control account balance',
  'ar.reconcile.row.open_invoices': 'Open invoices',
  'ar.reconcile.row.unapplied_credit_notes': 'Credit notes unapplied',
  'ar.reconcile.row.fx_revaluation': 'FX revaluation (NIF B-15)',
  'ar.reconcile.row.subledger_net': 'Subledger net',
  'ar.reconcile.delta': 'Delta {delta} — the subledger and the ledger tell different stories.',
  'ar.reconcile.manual_entries': 'Manual entries touching the control account',
  'ar.reconcile.manual_note': 'A manual entry on a control account is the classic cause of a delta nobody can find.',
  /** `ar check`: the title and the summary, `{blocking} · {warnings}`, each in its colour. */
  'ar.check.title': 'AR checks',
  'ar.check.blocking': '{count} blocking',
  'ar.check.warnings': '{count} warning(s)',
  'ar.check.no_warnings': '0 warnings',
  // ==== end of I8b · ar, part 1 ====
  // ==== I8b · run-time strings by key, family ar, part 2 (MNE-001-803, issue #150) ====
  // `receipt`, `credit-note` and `customer`: their English byte for byte ("entry(ies)", "invoice(s)" and
  // "document(s)" included), the Spanish with its plural; commands, amounts and dates are parameters.
  /** `reason` is `paid`, `draft` or another status. */
  'ar.receipt.record.not_collectable': '{number} is "{status}". {reason, select, paid {It is already settled.} draft {Issue it first: an invoice has to be in the ledger before cash can be applied to it.} other {Only {collectable} invoices can be collected.}}',
  /** `balances` is ` (before → after)` or empty; `advance` is ` (Advance: …)` or empty; `left` and `bank` are `none` without one. */
  'ar.receipt.record.confirm': 'Record {amount} {currency} collected on {invoice}{balances}{left, select, none {} other { with {leftAmount} left on account}}{advance}{bank, select, none {} other { into {bankName}}} in {entity}? This posts to the ledger.',
  'ar.receipt.record.would_record_advance': 'Would record an advance on account',
  'ar.receipt.on_account': '{amount} on account',
  'ar.receipt.show.date': 'Date',
  'ar.receipt.show.amount': 'Amount',
  'ar.receipt.show.method': 'Method',
  'ar.receipt.show.reference': 'Reference',
  'ar.receipt.show.on_account': 'On account',
  'ar.receipt.show.reversed': 'Reversed',
  'ar.receipt.show.reversal_cause': 'Reversal cause',
  'ar.receipt.show.cause_not_stated': 'not stated',
  'ar.receipt.show.cause_stated': 'Cause stated',
  'ar.receipt.show.applications': 'Applications',
  'ar.receipt.list.status_filter': 'Filter collections with --unapplied or --needs-rep: the status column follows the money, not a workflow.',
  'ar.receipt.apply.confirm': 'Apply {documents} from {payment} (on account {before} → {after}) on {date} in {entity}? This posts to the ledger.',
  'ar.receipt.apply.would': 'Would apply',
  'ar.receipt.apply.applied': '{payment} applied',
  'ar.receipt.withheld': 'withheld {parts}',
  'ar.receipt.withheld.vat': 'VAT',
  'ar.receipt.unapply.would': 'Would unapply {amount} from {invoice}',
  'ar.receipt.unapply.would_detail': '({before} → {after}, back on account{withheld}{advance}) on {date}',
  /** `estimate` is `yes` when the re-parked IVA is a pro-rata estimate. */
  'ar.receipt.unapply.reparked': 'IVA re-parked {iva}{estimate, select, yes { (pro-rata estimate)} other {}}',
  'ar.receipt.unapply.confirm': 'Unapply {amount} of {payment} from {invoice} ({before} → {after}{withheld}{advance}) on {date}? The cash stays on account; the invoice reopens.{kept}',
  'ar.receipt.unapply.done': '{payment} unapplied from {invoice}',
  'ar.receipt.reverse.would': 'Would reverse {payment}',
  'ar.receipt.reverse.would_detail': '{entries} entry(ies) mirrored, {invoices} invoice(s) reopened',
  'ar.receipt.reverse.confirm': 'Reverse {payment} ({amount} {currency}; {cause})? {entries} ledger entry(ies) get a mirror and {invoices} invoice(s) reopen.',
  'ar.receipt.reverse.done': '{payment} reversed',
  'ar.receipt.reverse.reopened': '{count} invoice(s) reopened',
  'ar.receipt.cause.key_unneeded': 'a cause is written once: a repeat finds the receipt with its cause and is refused',
  'ar.receipt.trace.key_unneeded': 'only empty fields are filled: a repeat finds them filled and reports them unchanged',
  'ar.credit_note.create.target_missing': 'A credit note needs its target: --invoice <ref> (recommended: the fiscal tie drives the IVA) or --customer <ref> for a standalone note.',
  'ar.credit_note.create.drafted': '{number} drafted',
  /** `target` is `invoice`, `customer` or `none`. */
  'ar.credit_note.create.drafted_detail': '({type}, {amount} {currency}{target, select, invoice {, credits {invoice}} customer {, {customer}} other {}})',
  'ar.credit_note.create.not_posted': 'Nothing was posted. Post it with `{issue}`, then `{apply}`.',
  'ar.credit_note.show.type': 'Type',
  'ar.credit_note.show.credits_invoice': 'Credits invoice',
  'ar.credit_note.show.relates_to': 'Relates to CFDI',
  'ar.credit_note.show.applied': 'Applied',
  'ar.credit_note.show.available': 'Available',
  'ar.credit_note.show.reason': 'Reason',
  /** `posted` is `yes` when the note is already in the ledger. */
  'ar.credit_note.issue.not_draft': '{number} is "{status}"{posted, select, yes { and already in the ledger.} other { and can no longer be issued.}}',
  'ar.credit_note.issue.confirm': 'Post {number} ({amount} {currency} against the receivable) to the ledger? This cannot be undone.',
  'ar.credit_note.issue.nothing_written': 'nothing was written.',
  'ar.credit_note.issue.now_credit': 'the note is now the customer\'s credit; apply it with `{command}`.',
  'ar.credit_note.apply.invoice_missing': 'Say which invoice(s): --invoice "INV-2026-00042:2500" (repeatable), or --invoice <ref> --amount <n>. An issued note with nothing applied already IS the customer\'s credit — no command needed for that.',
  'ar.credit_note.apply.no_amount': 'The invoice "{spec}" has no amount. With several invoices each carries its own ("folio:amount"); with one it can go in --amount.',
  'ar.credit_note.apply.available': 'available {before} → {after}',
  'ar.credit_note.apply.confirm': 'Apply {number} to {documents} in {entity}?',
  'ar.credit_note.apply.applied': '{number} applied',
  'ar.credit_note.apply.applied_detail': 'available {available} · note {status}',
  'ar.customer.list.balance_not_number': '--balance-gt must be a number; got "{value}".',
  'ar.customer.list.status_unknown': 'Unknown --status "{value}". A customer\'s lifecycle state is its credit state: {statuses}.',
  'ar.customer.show.point_in_time': '`{command}` is a point-in-time card: use --as-of for the reference date. For a date range, use `{range}`.',
  'ar.customer.show.date_basis': '--date-basis does not apply to a customer balance: it is built from the document date of what was billed and the payment date of what was collected, both at once.',
  'ar.customer.show.disappeared': 'Customer {ref} disappeared while reading it.',
  'ar.customer.show.archived': '[archived]',
  'ar.customer.show.tax_id': 'Tax id',
  'ar.customer.show.email': 'Email',
  'ar.customer.show.phone': 'Phone',
  'ar.customer.show.terms': 'Terms',
  'ar.customer.show.currency': 'Currency',
  'ar.customer.show.credit_status': 'Credit status',
  'ar.customer.show.credit_limit': 'Credit limit',
  'ar.customer.show.amount_due': 'Amount due',
  'ar.customer.show.past_due': 'Past due',
  'ar.customer.show.oldest_due': 'Oldest due',
  'ar.customer.show.as_of': 'As of',
  'ar.customer.show.open_documents': 'Open documents',
  'ar.customer.show.recent_payments': 'Recent payments',
  'ar.customer.create.name_missing': 'A customer needs a name: pass --name "ACME SA" or --first-name.',
  'ar.customer.create.currency_invalid': '--currency must be a 3-letter code; got "{value}".',
  'ar.customer.edit.nothing_to_change': 'Nothing to change. Pass --name, --first-name, --last-name, --email, --phone, --terms or --notes.',
  'ar.customer.edit.updated': '{number} updated',
  'ar.customer.archive.archived': '{number} archived.',
  'ar.customer.archive.open_documents': '{count} open document(s) worth {balance} remain on the books.',
  'ar.customer.restore.active': '{number} is active again.',
  'ar.customer.tax.regime': 'Regime',
  'ar.customer.tax.postal_code': 'Postal code',
  'ar.customer.tax.complete': 'Complete: stamping has what the SAT padrón will be matched against.',
  'ar.customer.tax.missing': 'Missing {missing}: a CFDI for this customer would be rejected.',
  'ar.customer.tax.updated': '{number} fiscal profile updated',
  'ar.customer.tax.updated_complete': 'complete',
  'ar.customer.tax.still_missing': 'still missing {missing}',
  'ar.customer.tax.list_no_status': '`{command}` has no lifecycle filter: use --missing.',
  // ==== end of I8b · ar, part 2 ====
  // ==== I8b · run-time strings by key, family payroll (MNE-001-804, issue #150) ====
  // `isn`, `tax-deposit`, `employee`, `garnishment` and `pay-run`: their English byte for byte (every "(s)" plural
  // included), the Spanish with its plural; commands, panel keys, rates, amounts and dates are parameters, never translated.
  'payroll.isn.state_missing': 'Name the state: the ISN is a state tax and a rate without one belongs to nobody. Use the SAT c_Estado key as it is written on your workers (for example JAL, or JA).',
  'payroll.isn.state_invalid': '"{value}" is not a state key. It must be 2 or 3 letters — the SAT c_Estado key — and it has to match, character for character, what is stored on the worker (employees.work_state) or on the entity (legal_entities.state_province). The engine compares them uppercased and trimmed, and nothing else.',
  'payroll.isn.rate_missing': 'The rate is required: give it as a fraction (0.03) or as a percentage (3%).',
  'payroll.isn.rate_invalid': '"{value}" is not a rate. Write it as a fraction (0.03) or as a percentage (3%). A negative rate is not a thing the ISN has.',
  'payroll.isn.rate_too_precise': '{rate} has more than {decimals} decimals and the column keeps {decimals}. Rounding it here would store a rate nobody typed; round it yourself to the published figure and capture that.',
  'payroll.isn.rate_above_ceiling': '{rate} is above the {ceiling} ceiling the table enforces (migration 067). State payroll tax runs about 1% to 4%. If you meant three percent, write 0.03 or 3% — a bare 3 is three hundred percent.',
  'payroll.isn.date_not_real': '{name} "{value}" is not a real date.',
  'payroll.isn.regime_unknown': 'Unknown --regime "{value}". The table only knows: {regimes} (migration 067 puts them in a CHECK).',
  'payroll.isn.legal_basis_missing': '--legal-basis is required: a rate without the law behind it cannot be audited. Cite the state finance law and its article, and the official gazette that published the current figure — for example: "Ley de Hacienda del Estado de Jalisco art. 41, reforma publicada en el Periodico Oficial 2025-12-15".',
  'payroll.isn.legal_basis_too_short': '--legal-basis "{value}" is too short to be a citation. Name the law and the article: in two years the question will not be how much was paid, it will be where the rate came from.',
  'payroll.isn.exemption_missing': '--regime con_exencion requires --exemption <amount>: a regime that exempts has to say how much it exempts, or the engine cannot tell it from a flat rate.',
  'payroll.isn.exemption_invalid': '--exemption "{value}" is not an amount. Write it as a decimal, 8000.00.',
  'payroll.isn.exemption_not_allowed': '--exemption only belongs with --regime con_exencion; this one is "{regime}". The CHECK in migration 067 refuses the pair, and it refuses it because an exemption nobody applies is an exemption the reader believes was applied.',
  'payroll.isn.period_not_month': '--period "{value}" is not a month. Employer liabilities are filed monthly, so here it is YYYY-MM (2026-07).',
  'payroll.isn.period_month_range': '--period "{value}": the month runs from 01 to 12.',
  'payroll.isn.open_end': '(open)',
  'payroll.isn_rate_set.reaches_count': '{count} worker(s) carrying "{state}"',
  /** The mark that paints the line yellow; `reaches_nobody` opens with it. */
  'payroll.isn_rate_set.nobody': 'NOBODY',
  'payroll.isn_rate_set.reaches_nobody': 'NOBODY: no live worker of this entity carries "{state}" in {source}',
  'payroll.isn_rate_set.keys_in_use': 'keys actually in use: {keys}',
  'payroll.isn_rate_set.blank_key': '(blank)',
  'payroll.isn_rate_set.key_too_long': 'employees.work_state is VARCHAR(2) and this key is 3 letters: it can never match. Capture the 2-letter key your workers carry, or fix the workers.',
  /** A preview label, and the mark that paints the line yellow. */
  'payroll.isn_rate_set.overlap': 'OVERLAP',
  'payroll.isn_rate_set.overlap_detail': '{state} {from} -> {to} at {rate}: the trigger trg_isn_sin_solape will refuse this write.',
  'payroll.isn_rate_set.heading': 'About to capture an ISN rate',
  'payroll.isn_rate_set.regime_not_computed': 'NOTE: the engine only computes tasa_plana. Captured as "{regime}" it will refuse to compute and say so, which is the point: it will not apply the rate as if the regime were flat.',
  'payroll.isn_rate_set.effective_from_missing': "--effective-from is required: a rate without a vigencia is not a rate, it is a memory. State congresses move these by decree, and computing March payroll with December's rate gives a plausible number and a wrong one.",
  'payroll.isn_rate_set.superseded_before': '--superseded-on {to} is not after --effective-from {from}. A vigencia that ends before it starts is not a vigencia (the CHECK isn_vigencia_coherente of migration 067 refuses it too).',
  'payroll.isn_rate_set.dry_run': 'Dry run: nothing was written.',
  /** `to` is `none` for an open-ended period; `clashes` joins `payroll.isn_rate_set.clash`. */
  'payroll.isn_rate_set.overlap_refused': "{state} already has {count} vigencia(s) overlapping {from}{to, select, none { onwards} other {..{to}}}: {clashes}. Two overlapping vigencias make the month's ISN depend on which one gets read first. Close the previous one with --superseded-on and capture this one again.",
  'payroll.isn_rate_set.clash': '{from}->{to} at {rate}',
  'payroll.isn_rate_set.confirm': 'Capture {state} at {rate} from {from}? Every MX pay run of that state from that date on will multiply by it — for EVERY firm on this installation: the ISN rate table is public law, not tenant data, and it carries no tenant_id. Your user id is the only trace of who captured it.',
  'payroll.isn_rate_set.aborted': 'Nothing captured.',
  'payroll.isn_rate_set.aborted_no_terminal': 'Nothing captured: no terminal to confirm on. Add -y to capture without asking, or --dry-run to see what would be written.',
  /** `to` is `none` for an open-ended period. */
  'payroll.isn_rate_set.captured': 'Captured. {state} now computes at {rate} from {from}{to, select, none { onwards} other { until {to}}}. Nothing was accrued: the liability is written when a pay run closes.',
  'payroll.isn_rate_set.duplicate': '{state} already has a rate captured effective {from}. A rate is not edited blind: look at it first with `{command}`, and if it has to change, close it with a --superseded-on and capture the new one.',
  'payroll.isn_rate_set.db_refused': "The database refused the write: {message}. Two overlapping vigencias make the month's ISN depend on which one the engine reads first, so the trigger stops it. Close the previous one with --superseded-on and capture this one again.",
  'payroll.isn_rate_list.none_captured': 'No ISN rate is captured at all. The table ships empty on purpose (migration 067): thirty-two states remembered from memory are thirty-two invented numbers, so the engine refuses to compute instead of reporting a zero that looks like a result.',
  /** `state` is `none` without --state. */
  'payroll.isn_rate_list.none_in_force': 'Nothing is in force on {date}{state, select, none {} other { for {state}}}, though {count} vigencia(s) are captured. Use -a to see them.',
  'payroll.isn_rate_list.capture_hint': 'Capture one with: {command}',
  'payroll.isn_calculate.run_required': '--run <payRunId> is required: the ISN is computed from the paychecks of one pay run, because that is where the remunerations and the states are.',
  'payroll.isn_calculate.run_not_found': 'No pay run {id} in this entity. A run of another entity is not visible here on purpose: the ISN of a run belongs to the entity whose calendar produced it.',
  'payroll.isn_calculate.heading': 'ISN — pay run {id}',
  'payroll.isn_calculate.window': '{start} -> {end} ({status}) · accrual date {date}',
  /** The two commands carry the two ISN panel keys, untranslated. */
  'payroll.isn_calculate.defaults_unanswered': 'At least one criterion is a declared DEFAULT and not a decision of the firm. Answer them with `{stateCommand}` / `{momentCommand}`.',
  'payroll.isn_calculate.total': 'ISN computed: {amount} MXN across {count} state(s)',
  'payroll.isn_calculate.findings': '{blocking} blocking, {warnings} warning(s). A blocking finding means a base was NOT computed: that is a hole in the number above, not a zero.',
  'payroll.isn_calculate.not_accrued': 'Nothing was accrued here. The liability is written when the run closes.',
  'payroll.tax_deposit.status_unknown': 'Unknown --status: {values}. The table only has: {statuses} (migration 008).',
  'payroll.tax_deposit.status_empty': '--status named nothing. Available: {statuses}.',
  'payroll.tax_deposit.none': 'Nothing accrued matches. `employer_tax_liabilities` is written when a pay run CLOSES (approved or paid), not when it is computed — an empty list most often means no run has been closed for this window yet, not that nothing is owed.',
  /** `scope` is `all` with --all-entities. */
  'payroll.tax_deposit.summary': '{shown} of {total} row(s) · {amount} MXN shown · status {statuses}{scope, select, all { · all entities} other {}}',
  'payroll.tax_deposit.overdue': '{count} row(s) are past their due date and still open. Overdue employer tax accrues surcharges and updating by law; the date is the date.',
  'payroll.tax_deposit.due_date_rule': 'Due dates here follow the general rule (the 17th of the following month) and are NOT adjusted to a business day: article 12 of the CFF needs a holiday calendar this system does not have, and several states publish their own ISN calendar. Check the state calendar before you rely on an ISN date.',
  'payroll.employee.create.file_missing': 'Missing --file: identifiers are read from a file, never from flags.',
  'payroll.employee.create.file_not_json': '--file is not valid JSON.',
  'payroll.employee.create.file_not_object': '--file must hold ONE employee as a JSON object; bulk loading is `{command}`.',
  'payroll.employee.create.file_scoped': '--file may not set {fields}: the entity is the one named with -e/--entity.',
  'payroll.employee.create.file_unknown_fields': '--file has unknown fields: {fields}.',
  'payroll.employee.create.missing': 'Missing {fields}.',
  'payroll.employee.create.country_invalid': 'country_code "{value}": use MX or US.',
  'payroll.employee.create.hire_date_invalid': 'hire_date "{value}": use YYYY-MM-DD.',
  'payroll.employee.create.rehearsal': 'Rehearsal: the transaction was undone. No employee was saved.',
  'payroll.employee.list.status_unknown': '--status {values}: use one of {states}.',
  'payroll.employee.list.status_one': '--status takes one state at a time; use -a/--all for every state.',
  'payroll.employee.list.none': 'No employees matched in this entity.',
  'payroll.garnishment.not_whole_number': '{name} must be a whole number of 0 or more; got "{value}".',
  'payroll.garnishment.record.missing': 'Missing {flags}. An order with no type cannot be computed, one with no issuing authority cannot be traced back to the court that dictated it, and `start_date` is NOT NULL.',
  'payroll.garnishment.record.rehearsal': 'Rehearsal: the transaction was undone. No order was filed.',
  'payroll.garnishment.record.cascade': 'this worker now has {count} live orders. Payday takes them in this sequence (their combined ceilings were checked against disposable earnings before filing):',
  'payroll.garnishment.record.cascade_row': '{type} · rank {rank} · priority {priority} · {amountType} {amountValue}',
  'payroll.garnishment.list.status_unknown': '--status {values}: an order is either active or archived. Use -a/--all for both.',
  'payroll.garnishment.list.none': 'No garnishment orders matched. Nothing is being withheld here.',
  'payroll.garnishment.archive.stays_on_file': 'The order stays on file. What stopped is the withholding: the engine reads is_active and nothing else.',
  'payrun.type_unknown': 'expected one of {types}',
  // ==== end of I8b · payroll ====
  // ==== I8b · run-time strings by key, family report (MNE-001-807, issue #150) ====
  // `report`, `cashflow` and `cashflow reconcile`: their English byte for byte (every "(s)" plural included).
  // Commands, policy keys and values, flags, periods, dates and amounts are parameters, never translated.
  'report.period.calendar_fallback': '"{period}" matched no single fiscal period; using the calendar range {start} → {end}.',
  /** `command` is `cashflow generate` or `cashflow reconcile`. */
  'report.period.required': '{command} needs a period: pass --period (2026-07, 2026-Q3, FY2026) or both --since and --until. A statement of cash flows is a movement between two dates.',
  'report.status_not_applicable': '--status does not apply to "{command}": it reports posted balances, not a lifecycle state.',
  'report.scope.cumulative': 'cumulative to {date}',
  'report.scope.period': 'period {name}',
  /** A bound is `none` when the caller did not give it. */
  'report.scope.open_range': '{start, select, none {start} other {{start}}} → {end, select, none {today} other {{end}}}',
  'report.scope.full_history': 'full posted history',
  'report.scope.account': 'account {code}',
  'report.scope.as_of': 'as of {date}',
  'report.title.trial_balance': 'Trial balance',
  'report.title.balance_sheet': 'Balance sheet',
  'report.title.income_statement': 'Income statement',
  'report.title.general_ledger': 'General ledger',
  'report.title.aged_receivables': 'Aged receivables',
  'report.title.aged_payables': 'Aged payables',
  'report.title.views': 'Reporting views',
  'report.trial_balance.level_invalid': '--level must be a whole number of at least 1; got "{value}".',
  /** The four columns are named as the SAT's trial balance names them, the same in both catalogues. */
  'report.trial_balance.sat_mismatch': 'SaldoIni + Debe - Haber does not give SaldoFin in {count} account(s): {accounts}',
  'report.trial_balance.footing': 'Debits {debits}   Credits {credits}   ({count} accounts)',
  'report.trial_balance.balanced': '{footing}   balanced',
  'report.trial_balance.out_of_balance': '{footing}   OUT OF BALANCE by {difference}',
  'report.balance_sheet.unbalanced': 'The balance sheet does not balance: assets {assets} vs liabilities plus equity {total} — out by {difference}. The ledger itself is inconsistent at this date; run `mnemosine entry check` and reconcile the subledgers before relying on any statement.',
  'report.income_statement.period_required': 'An income statement covers a period. Pass --period <expr>, or both --since and --until.',
  'report.general_ledger.page_totals': 'Page debits {debits}   page credits {credits}   ({shown} of {total} movements)',
  'report.aging.as_of_due_dates_only': "--as-of {date} ages the due dates only. The amounts are today's open balances, not the balances as they stood on that date.",
  'report.view.scope': 'view totals vs the live ledger',
  'report.view.stale': 'At least one view no longer agrees with the ledger. The refresh trigger fires only when an entry becomes posted, so migrations and bulk loads leave the views behind. Rebuild them with `mnemosine report view sync`.',
  'report.view.fresh': 'Every reporting view agrees with the ledger.',
  'report.view.synced': 'Reporting views rebuilt for every entity in this installation.',
  'report.cashflow.method_unknown': '--method must be one of: indirect, direct (indirecto, directo); got "{value}". The method is not cosmetic: it decides how the statement is built.',
  /** `source` is `flag` when --method was given; `policy` is the panel key and `value` its answer. */
  'report.cashflow.method_label': 'method: {method} ({source, select, flag {--method} other {policy `{policy}`}} · {value})',
  /** The labels of the statement's rows: stored in English, rendered in the reader's language by the table. */
  'report.cashflow.row.non_cash_total': 'Total non-cash items',
  'report.cashflow.row.working_capital_total': 'Total change in working capital',
  'report.cashflow.row.operating_total': 'Net cash from operating activities',
  'report.cashflow.row.investing_total': 'Net cash from investing activities',
  'report.cashflow.row.financing_total': 'Net cash from financing activities',
  'report.cashflow.row.net_change': 'Net change in cash',
  'report.cashflow.row.unclassified_total': 'Total unclassified (outside every section, and outside the net above)',
  'report.cashflow.row.cash_opening': 'Cash and equivalents, opening balance',
  'report.cashflow.row.cash_movement': 'Cash and equivalents, movement in the ledger',
  'report.cashflow.row.cash_closing': 'Cash and equivalents, closing balance',
  'report.cashflow.row.residue': 'Residue (statement net − ledger movement)',
  'report.cashflow.heading': 'Statement of cash flows · {entity} · {currency} · {scope}',
  'report.cashflow.cash_accounts': 'Cash and equivalents: {accounts} (criterio «{criterion}»)',
  'report.cashflow.non_cash': '{count} non-cash investing/financing transaction(s), excluded from the statement and disclosed here: {transactions}',
  'report.cashflow.ties_unclassified': 'The statement net ties to cash ({net}), but it is not classified: {note} The subtotals above do not stand; the net does.',
  'report.cashflow.ties': 'Ties: the statement net equals the movement of cash and equivalents in the ledger.',
  'report.cashflow.untied': 'The statement does not tie to cash: it states a net of {net} and cash and equivalents moved {movement} in the ledger. Residue of {residue}, printed above and absorbed into no line. Run `mnemosine cashflow reconcile --show-candidates`.',
  /** `sentence` is `report.cashflow.untied`; `policy` and `value` are the panel's key and answer. */
  'report.cashflow.untied_blocking': '{sentence} Policy `{policy}` is «{value}»: the statement does not stand.',
  'report.cashflow.untied_silent': '{sentence} Policy `{policy}` is «{value}»: reported as a note, not as a finding.',
  'report.cashflow_reconcile.heading': 'Cash flow reconciliation · {entity} · {currency} · {scope}',
  // ==== end of I8b · report ====
  // ==== I8b · run-time strings by key, family close (MNE-001-805, issue #150) ====
  // `closing`, `close`, `closing fx` and the period resolver they share: their English byte for byte (every "(s)"
  // plural included), the Spanish with its plural; commands, steps, periods, statuses and check codes are parameters.
  /** `renderCasillas`: a `--check` filter that selected nothing. */
  'closing.check.none_selected': '(no checks selected)',
  /** `count` is how many codes were unknown; the English keeps its "(s)". */
  'closing.check.unknown_codes': '{count, plural, other {Unknown check code(s)}}: {codes}. Available: {available}.',
  /** The AI-side blockers `closing check` notes on stderr; `command` is the leaf that clears them. */
  'closing.check.ai_drafts': '{count} AI draft(s) dated inside the period block this close ({command})',
  'closing.check.ai_questions': '{count} unanswered AI question(s) ({command})',
  'closing.check.ai_outbox': '{count} queued external write(s) ({command})',
  /** `closing preview` and `close`: the headings over the engine's blockers and warnings. */
  'closing.readiness.blocking': 'Blocking:',
  'closing.readiness.warnings': 'Warnings:',
  'closing.preview.can_enter': 'The period can enter close.',
  'closing.preview.cannot_enter': 'The period cannot enter close yet: resolve the blocking items above.',
  /** `closing explain`: the remedy follows the label. */
  'closing.explain.fix_with': 'fix with:',
  'closing.explain.clean': 'nothing to explain: the check is clean for this period',
  /** `resolveClosablePeriod`: `available` lists the closable periods, or is `closing.period.none`. */
  'closing.period.none': 'none',
  'closing.period.not_found': 'No period matches "{ref}". Closable: {available}.',
  'closing.period.nothing_to_conduct': '{period} is already {status}: there is nothing left to conduct. Seal it with {command}.',
  'closing.period.not_closable': '{period} is {status}: only open or soft-closed periods can be closed. Closable: {available}.',
  'closing.period.none_to_preview': 'No open periods: nothing to preview or check.',
  'closing.period.none_to_conduct': 'No open periods: nothing to conduct.',
  'closing.period.none_to_seal': 'No closed period to seal yet. Name the period to seal an open one on purpose, e.g. {example}.',
  /** `reason` is the kernel's «did not understand» sentence. */
  'closing.confirm.taken_as_no': '{reason}; taking that as no.',
  /** `closing run`. */
  'closing.run.key_unneeded':
    'the engines never post the same month twice and an advisory lock keeps two conductors off the same period: running again, with --resume when a run is open, duplicates nothing',
  'closing.run.step_unknown': 'Unknown step "{step}". The steps are: {steps}.',
  /** `run` is the conductor's own description of the open run. */
  'closing.run.open_run': 'This period already has an open close run ({run}). Continue it with --resume, or look at it first with --dry-run.',
  'closing.run.nothing_to_resume': 'Nothing to resume: this period has no open close run. Run it without --resume to start one.',
  'closing.run.confirm':
    'Conduct the close of {period}? Four of its steps post to the ledger, which does not admit undo, and the last one hard-closes the period.',
  'closing.run.aborted': 'Nothing was done: the ledger was not touched.',
  'closing.run.aborted_no_tty':
    'Nothing was done: there is no terminal to confirm on. Add -y to conduct without asking, or --dry-run to see what is pending without writing.',
  'closing.run.prior_attempt': '(also recorded by an earlier attempt of this run)',
  /** `how` of the lines below: what a real run needs after a dry run. */
  'closing.run.how_fresh': 'run it without --dry-run',
  'closing.run.how_resume': 'run it with --resume',
  'closing.run.how_wait': 'wait until the conductor acting on its run stops, then run it with --resume',
  /** The last line of a run (`runClosingLine`); `command` and `seal` are commands, `step` a step name. */
  'closing.run.line.completed': 'The close is conducted. Seal the dossier with {command}.',
  'closing.run.line.stopped_seal': 'Stopped before the seal, as asked: the period is soft-closed. Seal it with {seal}.',
  'closing.run.line.stopped': 'Stopped before {step}, as asked. The period stays open; continue with --resume.',
  'closing.run.line.blocked': 'Blocked at {step}. Clear the blocking items, then continue with --resume.',
  'closing.run.line.failed_seal': 'Failed at the seal: the period is soft-closed. Fix the cause, then seal it with {seal}.',
  'closing.run.line.failed': 'Failed at {step}. Fix the cause, then continue with --resume.',
  'closing.run.line.previewed_stop': 'Nothing was written. A real run would stop before {step}; to conduct, {how}.',
  'closing.run.line.previewed_block': 'Nothing was written. The checklist would block at {step}: clear it, then {how}.',
  'closing.run.line.previewed': 'Nothing was written. To conduct, {how}.',
  /** `closing pack generate` and `closing pack verify`. */
  'closing.pack.verify_with': 'verify it with: {command}',
  'closing.pack.verify.cannot_read': 'Cannot read {file}.',
  'closing.pack.verify.wrong_entity': 'This dossier belongs to "{dossier}" and the active entity is "{active}". Name the right one with --entity.',
  'closing.pack.verify.as_of': '{entity} · as of {date}',
  'closing.pack.verify.seal': 'the file agrees with its seal',
  'closing.pack.verify.issued': 'these books issued a dossier with this seal',
  'closing.pack.verify.figures': 'the figures reproduce against the books',
  'closing.pack.verify.warning': 'warning:',
  'closing.pack.verify.identity_changed':
    'a name changed since sealing — the entity, the period or an account label (rows marked identity); no figure moved because of it',
  'closing.pack.verify.envelope_differs': 'the envelope (who, when, which run) is not the one registered when it was issued',
  /** The cells of the verify annex: English in the row (csv and tsv are read by scripts), labelled in the md table. */
  'closing.pack.verify.row.issued': 'issued by these books',
  'closing.pack.verify.row.not_issued': 'not issued',
  'closing.pack.verify.row.as_registered': 'as registered',
  'closing.pack.verify.row.differs': 'differs',
  'closing.fx.revalue.key_unneeded':
    'fx_revaluation_runs subtracts what earlier runs of the period posted: running it again posts only what moved since, or nothing',
  /** `close`. `kind` is `close.kind.hard` or `close.kind.soft`; `mode` is `hard` or `soft`. */
  'close.none_open': 'No open periods: nothing to close.',
  'close.ready': 'Ready to close.',
  'close.not_ready': 'Cannot close yet: resolve the blocking items above.',
  'close.kind.hard': 'HARD close (irreversible)',
  'close.kind.soft': 'soft close (reversible)',
  'close.confirm.proceed': 'Proceed with {kind}?',
  /** The same question as a nested key, so the English `message` of the no-terminal refusal stays English. */
  'close.confirm.proceed_as': 'Proceed with {mode, select, hard {HARD close (irreversible)} other {soft close (reversible)}}?',
  'close.confirm.type_name': 'A hard close cannot be undone. Type the period name ({period}) to confirm:',
  'close.confirm.mismatch': 'That does not match {period}: nothing was closed.',
  'close.dry_run.would': 'Would {mode, select, hard {hard} other {soft}} close {period}.',
  'close.dry_run.nothing': '(dry-run: nothing was written)',
  'close.idempotency_hit': 'Idempotency hit: key "{key}" already closed {period} (now {status}). Nothing was executed again.',
  'close.done': '{period} is now {status} (by {email})',
  'close.soft_reversible': 'Soft close is reversible. To seal it: {command}',
  /** `renderCarryForward`: what a hard close's carry-forward reached. */
  'close.carry.into': 'Beginning balances carried into: {periods}',
  'close.carry.locked': '{period} is locked: its beginning balances were NOT rewritten.',
  'close.carry.locked_detail': 'It and the periods after it still open at the old figures; book the correction in an open period.',
  // ==== end of I8b · close ====
  // ==== I8b · run-time strings by key, family platform, part 1 (MNE-001-808, issue #150) ====
  // `memory`, `entity`, `user` and `tenant`: their English byte for byte (every "(s)" plural included). Commands,
  // flags, variables, option values, ids, emails and amounts are parameters or fixed text.
  'platform.memory.title': 'Firm memory',
  'platform.memory.empty': 'No precedents yet.',
  'platform.memory.empty_hint': 'They are created by answering questions (mnemosine questions) or directly:',
  'platform.memory.retired_mark': '[retired]',
  'platform.memory.stats': '{active} active · {retired} retired · {taught} taught directly',
  'platform.memory.conflicts.title': 'Precedents in conflict',
  'platform.memory.conflicts.none_active': 'No active precedents yet: nothing can contradict anything.',
  'platform.memory.conflicts.none': 'None: the {scanned} active precedent(s) do not contradict each other.',
  /** `scope` is the conflict's: `topic`, or anything else for one question answered twice. */
  'platform.memory.conflicts.via': '{scope, select, topic {topic} other {same question}}',
  'platform.memory.conflicts.retire_hint': '→ mnemosine memory retire {id} --reason "lost to a conflicting precedent"',
  'platform.memory.conflicts.summary': '{decisions} decision(s) with contradicting criteria, out of {scanned} active precedent(s).',
  'platform.memory.conflicts.ai_applies_one': 'The AI reads all of them from the same memory: it will apply one and will not say which.',
  'platform.memory.conflicts.you_decide': 'Nobody but you decides which one stands: retire the others, or correct this one',
  'platform.memory.conflicts.correct_hint': '(mnemosine memory correct <id> "<the answer that holds>").',
  'platform.memory.conflicts.warning': '{decisions} decision(s) have contradicting precedents; the AI applies one without saying which.',
  'platform.memory.digest.hidden': '{hidden} of {active} active precedent(s) fall outside the session digest (it carries {visible}, max {max}): the AI only sees them if it searches.',
  'platform.memory.digest.retire_hint': 'Retire what no longer applies so what does fits: mnemosine memory retire <id> --reason "<why>"',
  'platform.memory.topics': 'Most frequent topics:',
  'platform.memory.taught': 'Criterion saved. The AI will use it from now on.',
  'platform.memory.corrected': 'Precedent corrected: {answer}',
  'platform.memory.retired': 'Precedent retired. The AI will no longer see it.',
  'platform.memory.restored': 'Precedent reactivated.',
  /** Stored in English in the row of `entity show`; only the human table reads it back in the reader's language. */
  'platform.entity.source.flag': 'named on the command line',
  'platform.entity.source.env': 'from MNEMOSINE_ENTITY',
  'platform.entity.source.stored': 'pinned with `mnemosine entity use`',
  'platform.entity.source.only': 'the only active entity',
  'platform.entity.zone_undeclared': '{zone} (not declared)',
  'platform.entity.use.active': 'Active entity: {name}',
  'platform.entity.use.stored_in': 'stored in {file}',
  'platform.entity.none_selected': 'No entity selected. Pin one with `mnemosine entity use <id|name>`, pass --entity, or set MNEMOSINE_ENTITY.',
  'platform.entity.create.country_unknown': 'Unknown --country "{country}". Supported: {supported}.',
  'platform.entity.create.chart_unknown': 'Unknown --chart "{chart}". Use auto, siempre or nunca.',
  /** The label column of `entity create` and `tenant create`: padded to the longest label of the language, plus two. */
  'platform.label.entity': 'entity',
  'platform.label.tenant': 'tenant',
  'platform.label.chart': 'chart',
  'platform.label.assets': 'assets',
  'platform.label.next': 'next',
  'platform.entity.create.chart': '{seeded} account(s) seeded, {roles} role account(s), {buckets} payroll bucket(s)',
  'platform.entity.create.assets': '{count} asset class(es) with their LISR art. 34/35 rate',
  'platform.entity.create.bucket_unmappable': 'payroll bucket {bucket} needs account {code}, which this chart lacks — map it before the first pay run',
  'platform.entity.create.system_attributed': "attributed to the tenant's system account (no user was in session)",
  'platform.entity.create.pin_hint': 'pin it with: mnemosine entity use {taxId}',
  'platform.entity.edit.profile_updated': '{name} fiscal profile updated',
  'platform.entity.edit.profile_detail': '(regime {regime}, postal code {postalCode})',
  'platform.entity.edit.zone_updated': '{name} minimum wage zone: {zone}',
  'platform.entity.archive.pin_cleared': 'it was the pinned entity; the pin was cleared',
  'platform.entity.unset.done': 'Unpinned {name}.',
  'platform.entity.unset.none': 'No entity was pinned.',
  /** `entity archive` and `user archive`. */
  'platform.archived': '{name} archived.',
  /** `kind` is `user` or `tenant`; `first` and `second` are its two lifecycle states, never translated. */
  'platform.lifecycle.status_unknown': '--status {unknown}: a {kind, select, user {user} other {tenant}} is either {first} or {second}.',
  'platform.user.password.two_sources': '--password-stdin and {variable} are both set; use one.',
  'platform.user.password.stdin_is_terminal': '--password-stdin expects a pipe; run without it on a terminal for a hidden prompt.',
  'platform.user.password.prompt': 'Password:',
  'platform.user.password.cancelled': 'Cancelled; nothing was created.',
  'platform.user.password.missing': 'No password: pipe it with --password-stdin or set {variable}. It is never accepted as an argument, where ps would show it.',
  'platform.user.create.email_required': '--email is required.',
  'platform.user.create.role_required': '--role is required: a login never gets a role by default.',
  // ==== end of I8b · platform, part 1 ====
  // ==== I8b · run-time strings by key, family platform, usage, webhooks, sweep and compact (MNE-001-809, issue #150) ====
  // `usage`, `webhooks`, `subscription delivery sweep` and `compact`: their English byte for byte (every "(s)", "(ies)"
  // and "(y/ies)" plural included). Commands, flags, option values, paths, ids and counts are parameters or fixed text.
  'platform.usage.since_capped': 'Invalid --since value "{value}": relative windows are capped at {max}d.',
  'platform.usage.since_out_of_range': 'Invalid --since value "{value}": the resulting date is out of range.',
  'platform.usage.since_invalid': 'Invalid --since value "{value}". Use Nd (e.g. 7d, 30d) or YYYY-MM-DD.',
  'platform.usage.by_invalid': 'Invalid --by value "{value}". Use one of: {choices}.',
  /** `groupBy` is the option value (model, provider, day, session), never translated. */
  'platform.usage.title': 'Usage by {groupBy} (costs are local estimates, not billing)',
  'platform.usage.prices_as_of': 'price table as of {date} — providers reprice without notice',
  'platform.usage.empty': 'No usage recorded for this entity in the selected window.',
  /** The numeric columns of `usage`, right-aligned in 11 characters. */
  'platform.usage.column.turns': 'TURNS',
  'platform.usage.column.input': 'INPUT',
  'platform.usage.column.output': 'OUTPUT',
  'platform.usage.column.cache_read': 'CACHE RD',
  'platform.usage.column.cache_write': 'CACHE WR',
  'platform.usage.column.cost': 'EST. USD',
  'platform.usage.unpriced': 'unpriced',
  'platform.usage.unpriced_turns': '{count} turn(s) on models missing from the local price table: tokens counted, cost excluded from the total.',
  /** `webhooks deliveries` and `subscription delivery sweep`. */
  'platform.limit_invalid': 'Invalid --limit "{limit}": use a positive number.',
  'platform.webhooks.source_invalid': 'Invalid --source "{value}". Use one of: {kinds}.',
  'platform.webhooks.created': 'Webhook token "{name}" created ({source}).',
  /** The label column of `webhooks create`: padded to the longest label of the language, plus two. */
  'platform.label.endpoint': 'Endpoint:',
  'platform.label.header': 'Header:',
  'platform.webhooks.save_token': 'SAVE THE TOKEN NOW. It is shown only this once: the database keeps only its hash and it cannot be recovered. If lost, disable this token and create a new one.',
  'platform.webhooks.none': 'No webhook tokens. Create one with `mnemosine webhooks create <name>`.',
  /** The columns of `webhooks list` and `webhooks deliveries`: each as wide as the English one, or its label plus two. */
  'platform.webhooks.column.name': 'NAME',
  'platform.webhooks.column.source': 'SOURCE',
  'platform.webhooks.column.state': 'STATE',
  'platform.webhooks.column.last_used': 'LAST USED',
  'platform.webhooks.column.received': 'RECEIVED',
  'platform.webhooks.column.status': 'STATUS',
  'platform.webhooks.column.drafts': 'DRAFTS',
  'platform.webhooks.column.document': 'DOCUMENT',
  'platform.webhooks.state': '{enabled, select, true {enabled} other {disabled}}',
  'platform.webhooks.never': 'never',
  'platform.webhooks.disabled': 'Webhook token "{name}" disabled.',
  'platform.webhooks.not_found': 'No enabled webhook token named "{name}" in this entity.',
  'platform.webhooks.no_deliveries': 'No webhook deliveries recorded for this entity.',
  'platform.webhooks.suspicious': '[suspicious content]',
  'platform.sweep.scope_required': 'The sweep needs a scope: pass --tenant <uuid> (or set MNEMOSINE_TENANT) to sweep one tenant, or --all-tenants to sweep every active tenant. It does not default to everything: crossing every tenant is a decision, not a fallback.',
  'platform.sweep.sandbox': "sandbox: nothing was sent. A webhook has no test endpoint — the URL is the customer's. Add --live to actually retry.",
  'platform.sweep.key_ignored': '--idempotency-key does not apply to the sweep: each delivery already carries its own stable key (X-Webhook-ID), and deduplicating whole passes would skip due deliveries.',
  /** `census` when nothing was sent (--dry-run, or no --live); anything else when the sweep posted. */
  'platform.sweep.verdict': '{mode, select, census {Would sweep} other {Swept}}',
  'platform.sweep.summary': 'tenants {tenants} · due {due} · delivered {delivered} · retryable {retryable} · dead {dead} · frozen {frozen}',
  'platform.sweep.frozen': '{count} due deliver(ies) belong to DISABLED subscriptions and were left untouched — neither retried nor killed.',
  'platform.sweep.dead': '{count} deliver(y/ies) exhausted their attempts and are now DEAD: they will not be retried again. Their ids are in the lines above; the CLI has no verb to list or resend them yet, the API does: `GET /v1/webhooks/<subscriptionId>/deliveries?status=failed` and `POST /v1/webhooks/deliveries/<deliveryId>/retry`.',
  'platform.compact.title': 'Compaction dry-run (offline estimate, ~4 chars/token)',
  /** The three lines under the title carry their own alignment, one per language; counts come formatted. */
  'platform.compact.session': 'session   {id}',
  'platform.compact.transcript': 'transcript {messages} messages, ~{tokens} tokens',
  'platform.compact.keep_tail': 'keep tail  ~{tokens} tokens (intact)',
  'platform.compact.nothing': 'Nothing to compact: the transcript fits within the recent-tail budget.',
  'platform.compact.would': 'A live /compact would:',
  'platform.compact.summarize': 'summarize {count} older messages (~{tokens} tokens)',
  'platform.compact.keep': 'keep {count} recent messages (~{tokens} tokens)',
  'platform.compact.dry_run_only': "Dry-run only: compaction rewrites the MODEL'S in-flight view, so it runs inside chat (/compact). The Postgres transcript is never modified.",
  'platform.compact.session_not_found': 'Session not found for this entity.',
  'platform.compact.no_sessions': 'No sessions yet for this entity.',
  // ==== end of I8b · platform, usage, webhooks, sweep and compact ====
  // ==== I8b · run-time strings by key, family platform, part 2 (MNE-001-843, issue #150) ====
  // `skills` and `approvals`: their English byte for byte (every "(s)" plural included). Modes, scopes, flags,
  // FLOOR_MAX_AUTO_POST and amounts are parameters or fixed text.
  'platform.skills.scan.missing': 'scan report missing or malformed — treat as flagged',
  'platform.skills.scan.clean': 'trust scan: clean',
  'platform.skills.scan.threats': 'trust scan: {count} threat(s) — approval requires --accept-risk',
  'platform.skills.scan.threat_line': '[{kind}] line {line}:',
  'platform.skills.title': 'Skills',
  'platform.skills.none_visible': 'No skills are visible for this entity.',
  'platform.skills.mark.invalid': '[invalid]',
  'platform.skills.mark.gated': '[gated]',
  'platform.skills.drafts_pending': '{count} staged change(s) await review: mnemosine skills drafts',
  'platform.skills.drafts.none': 'No skill drafts await review.',
  'platform.skills.drafts.not_a_terminal': '{count} skill draft(s) await review, but stdin is not a terminal.',
  'platform.skills.drafts.run_in_terminal': 'Run in a terminal to approve/reject interactively, or use --json for machine output.',
  'platform.skills.drafts.approved': 'Approved and written: skills/{name}',
  'platform.skills.drafts.rejected': 'Rejected.',
  'platform.skills.drafts.skipped': 'Skipped; still pending.',
  /** `flag` is `scope` or `mode`; `choices` lists its values, which are never translated. */
  'platform.approvals.option_invalid': 'Invalid --{flag} "{value}"; expected one of: {choices}',
  'platform.approvals.pattern_empty': 'The pattern is empty; specify at least one of --kind, --max-amount, --provider, --operation',
  'platform.approvals.none': 'No approval policies.',
  'platform.approvals.list.by': 'by {user}',
  'platform.approvals.list.last_used': 'last used {date}',
  'platform.approvals.granted': 'Approval policy granted: {id} ({scope}, {mode})',
  'platform.approvals.pattern': 'pattern: {pattern}',
  /** `cap` and `floor` come formatted; `always` is the mode's value and FLOOR_MAX_AUTO_POST the floor's name. */
  'platform.approvals.always_warning': "Warning: an 'always' policy stays active until revoked. Amounts it can authorize are capped at {cap} by the floor (FLOOR_MAX_AUTO_POST = {floor}); nothing can raise that limit.",
  'platform.approvals.revoked': 'Approval policy {id} revoked.',
  // ==== end of I8b · platform, part 2 ====
  // ==== I8b · run-time strings by key, family platform, status and prompt-size (MNE-001-855, issue #150) ====
  // `status` and `prompt-size`: their English byte for byte. The details `status --json` carries and the section
  // labels of `prompt-size --json` stay English in the data; only the human table reads them back by key.
  'platform.status.section.configuration': 'Configuration',
  'platform.status.section.database': 'Database',
  'platform.status.section.providers': 'Providers',
  /** The label column of `status`: padded to the longest label of the language, plus three. */
  'platform.status.label.config_file': 'config file',
  'platform.status.label.provider': 'provider',
  'platform.status.label.model': 'model',
  'platform.status.label.language': 'language',
  'platform.status.label.auto_post': 'auto-post',
  'platform.status.label.connection': 'connection',
  'platform.status.label.rls': 'RLS tenant scope',
  'platform.status.no_config': '(none — built-in defaults)',
  'platform.status.thresholds': '{on, select, true {on} other {off}}  min confidence {confidence}  max amount {max}',
  'platform.status.floor_cap': '(floor cap {cap})',
  'platform.status.mark': '{ok, select, true {ok} other {FAIL}}',
  'platform.status.rls_state': '{active, select, true {active} other {inactive}}',
  'platform.status.probe.skipped': 'probe skipped ({reason})',
  'platform.status.probe.ok': 'probe ok {ms}ms',
  'platform.status.probe.failed': 'probe FAIL [{category}] {detail}',
  'platform.status.probe.none': 'not probed',
  'platform.status.redacted': 'Redacted output: no keys, tokens or home paths. Safe to share in support tickets.',
  /** Written into the report in English (`--json` keeps them); the table reads them back in the reader's language. */
  'platform.status.detail.reachable': 'reachable',
  'platform.status.detail.key_cmd_failed': 'api_key_cmd failed to produce a credential',
  'platform.status.detail.no_tenant': 'no tenant context (set --tenant or MNEMOSINE_TENANT to scope by RLS)',
  'platform.status.detail.db_unreachable': 'skipped: database unreachable',
  'platform.prompt_size.title': 'Prompt budget (offline estimate, ~4 chars/token)',
  'platform.prompt_size.system_blocks': 'System blocks',
  /** Written into the budget in English (`--json` keeps them); the table reads them back in the reader's language. */
  'platform.prompt_size.section.role': 'role instructions (stable)',
  'platform.prompt_size.section.docs': 'docs index (stable)',
  'platform.prompt_size.section.chart': 'chart of accounts (stable)',
  'platform.prompt_size.section.volatile': 'volatile block (entity + date)',
  'platform.prompt_size.cached': '[cached]',
  'platform.prompt_size.uncached': '[uncached]',
  'platform.prompt_size.tools_title': 'Tool schemas (top {shown} of {count}, largest first)',
  'platform.prompt_size.more_tools': '… {count} more tools',
  'platform.prompt_size.all_tools': 'all tools ({count})',
  'platform.prompt_size.cached_prefix': 'cached prefix (tools + stable)',
  'platform.prompt_size.uncached_total': 'uncached (volatile)',
  // ==== end of I8b · platform, status and prompt-size ====
  // ==== I8b · run-time strings by key, kernel line-spec (MNE-001-806, issue #150) ====
  // The one --line grammar that entry, invoice and bill read: its English byte for byte ("key(s)" included), the
  // Spanish with its plural; the keys as typed, the separator, the sample lines and the version are never translated.
  /** `spec` is the line as typed; the sample after the colon is fixed text. */
  'cli.line.pair_unreadable':
    'Cannot read the line "{spec}". Each part is key=value, separated by ";": --line "account=5100;qty=2;price=350.00;description=Text".',
  /** `key` is the folded key; `first` and `second` are the two spellings the person typed. */
  'cli.line.key_twice': 'The line "{label}" gives "{key}" twice (as "{first}" and "{second}").',
  /** `count` is how many keys are unknown; the English keeps its "(s)". */
  'cli.line.unknown_keys': '{count, plural, other {Unknown key(s)}} in --line: {unknown}. Known keys: {known}.',
  /** `first` and `second` are the two keys of one `sameField` pair, as typed. */
  'cli.line.same_field': 'The line "{label}" gives one field twice: "{first}" and "{second}" are the same key. Give only one.',
  /** One stderr line per invocation of `bill create`; `version` is LEGACY_LINE_FORMS_RETIRE_IN. */
  'cli.line.legacy_comma':
    '--line pairs separated by "," are deprecated; separate them with ";" (account=5100;qty=1;price=1000;tax-amount=160). Commas stop working in {version}.',
  /** The heading of the key block that `lineKeysHelp` adds to `--help`. */
  'cli.line.keys_heading': 'Keys accepted in --line (key=value pairs separated by ";"; "_" and "-" are the same):',
  // ==== end of I8b · line-spec ====
  // ==== W1 · the browser board (issue #117) ========================
  // The keys of the web gateway's browser program, src/gateway/app. That
  // program imports this file and es.ts as modules, so what is written here is
  // served to the page as it is. Its runtime (src/gateway/app/messages.ts) only
  // fills plain {name} holes, with no plural and no select, and
  // tests/gateway/web-model.spec.ts holds every web.* message to that. Entity
  // names, period names, CLI commands and dates are data, never keys.
  'web.app.title': 'Firm board',
  'web.app.skip_to_content': 'Skip to content',
  'web.app.not_found': 'There is no such screen.',
  'web.session.sign_in': 'Sign in',
  'web.session.sign_out': 'Sign out',
  'web.session.sign_out_failed': 'Sign-out was not confirmed, so your session may still be open. Try again.',
  'web.session.signed_out': 'You are not signed in, or your session ended.',
  'web.session.no_access':
    'Your account cannot read this: it needs the accounts:read and journal_entries:read permissions.',
  'web.session.signin_failed': 'Sign-in did not complete, and no session was kept. Try again.',
  'web.portfolio.title': 'Firm portfolio',
  'web.portfolio.caption': 'Entities you can read, their current period and the work waiting on a person',
  'web.portfolio.column.entity': 'Entity',
  'web.portfolio.column.current_period': 'Current period',
  'web.portfolio.column.ended_open_periods': 'Ended periods still open',
  'web.portfolio.column.pending_drafts': 'Drafts to review',
  'web.portfolio.column.pending_questions': 'Open questions',
  'web.portfolio.no_calendar': 'no calendar',
  'web.portfolio.inactive': 'inactive',
  'web.portfolio.empty': 'Your token grants no entity that can be read here.',
  'web.portfolio.not_evaluated': 'Close readiness is not evaluated on this screen.',
  'web.portfolio.as_of': 'Server date {date}',
  'web.portfolio.fetched': 'Read at {time}, {minutes} min ago',
  'web.portfolio.stale': 'The refresh at {time} failed: these figures are from the last good read.',
  'web.portfolio.omitted': 'Entity ids in your token that produced no row: {count}',
  'web.portfolio.refresh': 'Refresh',
  'web.portfolio.loading': 'Reading the portfolio…',
  'web.portfolio.legend.title': 'What the colors say',
  'web.portfolio.legend.info': 'Blue: the current period is open or soft closed.',
  'web.portfolio.legend.balanced': 'Green: the current period is hard closed or locked.',
  'web.portfolio.legend.pending': 'Amber: work is waiting on a person.',
  'web.portfolio.legend.neutral': 'No color: nothing waiting, or no calendar yet.',
  'web.period_status.future': 'future',
  'web.period_status.open': 'open',
  'web.period_status.soft_close': 'soft close',
  'web.period_status.hard_close': 'hard close',
  'web.period_status.locked': 'locked',
  'web.entity.back': 'Back to the portfolio',
  'web.entity.loading': 'Reading the entity…',
  'web.entity.not_granted': 'Your token does not grant this entity, so its lists cannot be read here.',
  'web.entity.drafts': 'Drafts to review',
  'web.entity.drafts_limit': 'The API lists the 100 most recent drafts at most.',
  'web.entity.questions': 'Open questions',
  'web.entity.periods': 'Fiscal periods',
  'web.entity.none': 'None.',
  'web.entity.column.date': 'Date',
  'web.entity.column.description': 'Description',
  'web.entity.column.confidence': 'Confidence',
  'web.entity.column.question': 'Question',
  'web.entity.column.topic': 'Topic',
  'web.entity.column.period': 'Period',
  'web.entity.column.status': 'Status',
  'web.entity.column.start': 'Start',
  'web.entity.column.end': 'End',
  'web.entity.verify': 'The same lists in the terminal:',
  'web.error.upstream_unavailable': 'The API is not reachable right now.',
  'web.error.session_expired': 'Your session ended. Sign in again.',
  'web.error.unexpected': 'The answer could not be read.',
  // ==== MNE-001-018 · the Anexo 24 migration leaves ====================
  'migration.file_unreadable': 'Could not read the file "{file}".',
  'migration.subledger_not_array': '--subledger expects a JSON array of open documents.',
  'migration.chart.confirm': 'Create {count} account(s) in {entity}?',
  'migration.opening.confirm':
    'Post the opening of fiscal year {year} on {date} (Debit {debit} · Credit {credit})? ' +
    'The ledger cannot be undone.',
  'migration.opening.confirm_draft':
    'Leave the opening of fiscal year {year} on {date} as a DRAFT (Debit {debit} · Credit {credit})? ' +
    'It stays out of the ledger until you apply it with `entry post`.',
  'migration.check.as_of': 'As of {date} · {comparison}',
  // ---- MNE-001-419 (#621): what --chart refuses ----
  'migration.chart_option.other_rfc':
    'The --chart catalog belongs to RFC {fileRfc} and the entity is {entityRfc}. It is not used: the catalog of ' +
    'another taxpayer cannot say which accounts of this entity are memorandum accounts.',
  'migration.chart_option.not_importable':
    'The --chart catalog is one that chart import would not take, so it cannot say which accounts are ' +
    'memorandum accounts: {findings}. Fix the file at the source and export it again.',
  'migration.chart_option.hierarchy_cycle':
    'The hierarchy of the --chart catalog bites its own tail: {rows}. chart import refuses this file and so does ' +
    'the opening: fix the SubCtaDe at the source.',
  'migration.check.memorandum_inside_account':
    'The source hangs memorandum (8xx) money inside a ledger account, so the figure that account declares ' +
    'includes money that stays off the balance: {detail}. Each account is followed by its memorandum rows, with ' +
    'the figure the source declares, and by their net, debit positive. Nothing was compared: an opening that ' +
    'carries that money would come out equal with memorandum money on the balance sheet. Fix the hierarchy in ' +
    'the source catalog (SubCtaDe) and export both files again; see {doctrine}.',
  // ---- MNE-001-456 (#621): the load leaves the memorandum accounts out ----
  'migration.opening.memorandum_excluded':
    '"{account}" is a memorandum account (8xx), by its agrupador or because it hangs from one, and the source ' +
    'declares {amount} for it. It gets no line in the opening entry and stays out of the ledger: keep this ' +
    'figure with the working papers of the migration; see {doctrine}.',
  'migration.opening.memorandum_in_ledger':
    '"{account}" is a memorandum account (8xx), by its agrupador or because it hangs from one, and it already ' +
    'exists in this entity as {type}. It gets no line in the opening entry (the source declares {amount}), but ' +
    'by the doctrine ({doctrine}) it should not be in the ledger: review it by hand.',
  'migration.opening.memorandum_inside_account':
    'The figure "{account}" declares includes memorandum (8xx) money that hangs inside it and does not net to ' +
    'zero there: {rows}, net {net} with debit positive. Nothing is loaded: posting that figure would put ' +
    'memorandum money on the balance sheet, and posting less would fail opening-balance check. Fix the ' +
    'hierarchy in the source catalog (SubCtaDe) and export both files again; see {doctrine}.',
  'migration.opening.memorandum_document':
    'The document "{document}" hangs from "{account}", which is a memorandum account (8xx) and gets no line in ' +
    'the opening entry. A memorandum account has no receivable or payable behind it: take the document out of ' +
    'the --subledger file, or fix the account at the source; see {doctrine}.',
  'migration.opening.unknown_account_chart_hint':
    'If it is a memorandum account (8xx), pass the catalog of the same migration with --chart <file>: the ' +
    'load leaves it out of the entry and names it ({doctrine}).',
  'migration.opening.memorandum_excluded_header':
    'Memorandum accounts left out of the entry, with the figure the source declares ({doctrine}):',
  // ==== MNE-001-093 · help by key, pilot family `period` (issue #314) ====
  //
  // Key format decided on 2026-09-26 (#152): help.<cmd>[.<sub>…].description,
  // .option.<flag> and .argument.<name>, in snake_case; generic flags reuse
  // cli.flag.*. The lane `help-descriptions-without-key` counts what is left.
  'help.period.description': 'Fiscal periods: what exists, what state it is in, and opening a future one',
  'help.period.list.description': 'List every period with its state, dates and overdue mark',
  'help.period.list.option.year': 'only periods of this fiscal year',
  'help.period.show.description':
    'Show a period: state, who closed it, the checklist it closed with, its entries',
  'help.period.show.argument.name': 'period name, YYYY-MM, or id',
  'help.period.open.description': 'Open a future period so work can be captured in it',
  'help.period.open.argument.name': 'period name, YYYY-MM, or id',
  'help.period.open.option.reason': 'why it is being opened; recorded in the audit trail',
  'help.period.reopen.description':
    'Reopen a closed period so a correction can land in the month it belongs to',
  'help.period.reopen.argument.name': 'period name, YYYY-MM, or id',
  // ==== MNE-001-093 · help by key, the families merged from main (issue #314) ====
  //
  // Same format as `period`: help.<cmd>[.<sub>…].description, .option.<flag>
  // and .argument.<name>, in snake_case (`pay-run` → `pay_run`). A literal
  // brace cannot live in a message (it is a placeholder), so the one example
  // object of `pay-run calculate --file` travels as the parameter {shape}.
  'help.tenant.description': 'Create and list the firms (tenants) of this installation',
  'help.tenant.list.description': 'List the tenants of this installation, archived ones included',
  'help.tenant.create.description': 'Create a tenant for a new firm, with its system account',
  'help.tenant.create.argument.name': 'name of the firm',
  'help.tenant.create.option.subdomain': 'unique handle of the firm (derived from the name when omitted)',
  'help.tenant.create.option.json': 'JSON output',
  'help.user.description': 'Create, list and archive the logins of a firm, without a terminal',
  'help.user.list.description': 'List the users of the firm, archived ones included',
  'help.user.create.description': 'Create a user with one role of the catalog; the password comes from stdin, the environment or a hidden prompt',
  'help.user.create.option.email': 'email address the user signs in with',
  'help.user.create.option.role': 'role of src/auth/roles.ts (owner, admin, controller, contador, revisor, auditor, viewer) or its alias',
  'help.user.create.option.password_stdin': 'read the password from stdin (never pass it as an argument)',
  'help.user.create.option.json': 'JSON output',
  'help.user.archive.description': 'Archive a user: it can no longer sign in, and nothing it did is erased',
  'help.user.archive.argument.email': 'email of the user to archive',
  'cli.rls_bypass.notice': 'Warning: role "{role}" bypasses row level security ({reason}); isolation between firms depends on the code alone in this session. Connect as mnemosine_app (scripts/provision-roles.sql).',
  'help.account.role.sync.description': 'Point the withholding roles at the accounts withholding_accounts_layout chooses, creating the missing ones',
  'help.account.role.sync.option.dry_run': 'show the plan, without writing',
  // MNE-001-421 (#623): `receipt record` with no invoice records a customer advance.
  'help.receipt.record.description':
    'Record cash received: against an invoice, releasing the IVA it was holding, or with no invoice as a customer advance',
  'help.receipt.record.argument.invoice':
    'invoice number or id; without it the cash is an advance, and --customer names who paid it',
  'help.receipt.record.option.customer':
    'the customer who paid (number, name or id); required with no invoice, and with one it must be the invoice\'s own',
  'help.receipt.record.option.tax_rate':
    'IVA treatment of an advance: 16, 8, 0, exempt (exento) or not-subject (no-objeto); with no invoice it is required, and with one it states the treatment of the excess --on-account leaves; the IVA is caused on collection',
  'help.receipt.record.option.on_account':
    'let the amount exceed the invoice due: the excess stays on account as an advance and causes its IVA on collection (LIVA art. 1-B), at --tax-rate or the invoice\'s own rate',
  // #611: the payer's side of the Anexo 24 payment node.
  'help.receipt.record.option.check_number':
    'number of the customer\'s cheque (with --method check); the vouchers file declares it in the Cheque node',
  'help.receipt.record.option.payer_bank':
    'c_Banco code (3 digits) of the bank the customer paid from; checked against the SAT list',
  'help.receipt.record.option.payer_account':
    'account the customer paid from (for a cheque, the account it is drawn on); needs --payer-bank or --payer-foreign-bank',
  'help.receipt.record.option.payer_foreign_bank':
    'full name of the customer\'s bank when it is foreign, instead of --payer-bank',
  // MNE-001-422 (#623): the leaf says which procedure of Apéndice 6 it covers.
  'help.receipt.apply.description':
    'Apply the on-account balance of a collection to invoices: releases PPD IVA, and an advance cancels the IVA it caused instead of causing it again. It covers procedure A of Anexo 20, Appendix 6 (the sale invoiced whole); under procedure B the advance moves to revenue by a journal entry',
  'help.receipt.apply.option.withholding':
    'what the customer withheld, which settles the invoice with the cash: "isr:1000" or "iva:1066.67" (repeatable); with several invoices, "INV-2026-00042:isr:1000"',
  'help.receipt.apply.option.date':
    'day of the application (YYYY-MM-DD), which dates its entry, the allocation and the invoice\'s last payment; defaults to today in the entity\'s time zone',
  'help.receipt.unapply.option.date':
    'day of the unapply (YYYY-MM-DD), which dates its entry and the closed allocation; defaults to today in the entity\'s time zone',
  // MNE-001-509 (#701): the reversal states what happened to the money.
  'help.receipt.reverse.description':
    'Reverse a collection whose money did not stay, saying why: mirrors every entry, reopens invoices, re-parks IVA',
  'help.receipt.reverse.option.cause':
    'what happened to the money: not_collected (it never became yours) or taken_back (it arrived and was taken back, as in a chargeback); with none, a cheque takes not_collected and any other method keeps no cause',
  // MNE-001-511 (#701): the cause of a reversal, stated afterwards.
  'help.receipt.cause.description': 'The cause of a reversed collection: what happened to its money',
  'help.receipt.cause.record.description':
    'State the cause of a collection that was reversed with none: written once, audited, posts nothing',
  'help.receipt.cause.record.argument.ref': 'payment number or id',
  'help.receipt.cause.record.option.cause':
    'what happened to the money: not_collected (it never became yours) or taken_back (it arrived and was taken back, as in a chargeback)',
  'help.receipt.cause.record.option.json': 'JSON output',
  // MNE-001-605 (#809): the live allocation of a reversed receipt, closed by a person.
  'help.receipt.allocation.description': "A receipt's allocations to its invoices",
  'help.receipt.allocation.close.description':
    'Close the live allocation a reversed collection still has on an invoice (ar check: orphan-application): dated at the reversal, audited, posts nothing',
  'help.receipt.allocation.close.argument.ref': 'payment number or id of the reversed collection',
  'help.receipt.allocation.close.option.invoice': 'invoice number or id the live allocation settles',
  'help.receipt.allocation.close.option.reason': 'why it is closed: written to the audit trail',
  'help.receipt.allocation.close.option.json': 'JSON output',
  'help.receipt.allocation.close.examples':
    '\nExamples:\n' +
    '  ar check named PMT-2026-00042 (reversed) → INV-2026-00051 116.00 under orphan-application; see what would be closed:\n' +
    '    mnemosine receipt allocation close PMT-2026-00042 --invoice INV-2026-00051 --reason "Left live by its reversal" --dry-run\n' +
    '  Close it; the reversal already reopened the invoice, so nothing posts:\n' +
    '    mnemosine receipt allocation close PMT-2026-00042 --invoice INV-2026-00051 --reason "Left live by its reversal"\n',
  // MNE-001-568 (#612): the trace of a registered payment, completed afterwards.
  'help.payment.trace.description': 'The payment trace of a registered payment: its cheque, and the account and bank the money went to',
  'help.payment.trace.record.description':
    'Complete the empty trace fields of a registered payment from its evidence: only empty fields, audited, posts nothing',
  'help.payment.trace.record.argument.payment': 'payment number or id',
  'help.payment.trace.record.option.check_number': 'cheque number; only for a payment made by cheque',
  'help.payment.trace.record.option.to_account': 'account that received the money (CtaDest of the SAT voucher)',
  'help.payment.trace.record.option.to_bank': 'destination bank key from the SAT c_Banco catalogue (3 digits)',
  'help.payment.trace.record.option.to_foreign_bank': 'destination bank name when it is a foreign one',
  'help.payment.trace.record.option.bank': 'bank account (name or id) the payment went out of; only one that posts to the ledger account its entry moved',
  'help.payment.trace.record.option.json': 'JSON output',
  // MNE-001-570 (#612): the trace of a registered receipt, completed afterwards.
  'help.receipt.trace.description': "The payment trace of a registered receipt: the customer's bank and account, its cheque, and our bank account",
  'help.receipt.trace.record.description':
    'Complete the empty trace fields of a registered receipt from its evidence: only empty fields, audited, posts nothing',
  'help.receipt.trace.record.argument.receipt': 'receipt number or id',
  'help.receipt.trace.record.option.check_number': "cheque number; only for a receipt by the customer's cheque",
  'help.receipt.trace.record.option.payer_bank': 'c_Banco code (3 digits) of the bank the customer paid from, or that issued its cheque',
  'help.receipt.trace.record.option.payer_account': 'account the customer paid from, or the one its cheque is drawn on',
  'help.receipt.trace.record.option.payer_foreign_bank': "name of the customer's bank when it is a foreign one",
  'help.receipt.trace.record.option.bank': 'bank account (name or id) the money went into; only one that posts to the ledger account its entry moved',
  'help.receipt.trace.record.option.json': 'JSON output',
  // MNE-001-498 (#695): the transfer of a customer's cash on account.
  'help.receipt.transfer.description': "A transfer of a customer's cash on account to another customer",
  'help.receipt.transfer.record.description':
    "Transfer a customer's cash on account to another customer, as agreed: audited, posts DR/CR customer advances, no bank, revenue or IVA",
  'help.receipt.transfer.record.argument.ref': 'payment number or id of the receipt whose cash on account is transferred',
  'help.receipt.transfer.record.option.customer': 'the customer who receives the credit (number, name or id)',
  'help.receipt.transfer.record.option.amount': 'amount to transfer, at most the cash on account of the receipt',
  'help.receipt.transfer.record.option.date':
    'the agreed day of the transfer (YYYY-MM-DD), which dates its entry; defaults to today in the entity\'s time zone',
  'help.receipt.transfer.record.option.json': 'JSON output',
  'help.sat.download.description': 'Bulk download of CFDI from the SAT, and the census against the books',
  'help.sat.download.reconcile.description':
    'Read the SAT census of a month against what is posted: what is still to fetch, what is fetched and not posted, what the SAT cancelled and the books still carry, and what the books carry that the SAT does not list. Reads the census that `ingest --kind zip|metadata` loaded; it does not go to the SAT. Exits 4 when the month cannot be called complete',
  'help.sat.download.reconcile.option.period': 'month to reconcile, as YYYY-MM',
  'sat.reconcile.bad_period': 'The period must be a month as YYYY-MM, and "{value}" is not.',
  'sat.reconcile.summary':
    '{period}: {matched} agree · {fetch} to fetch · {post} to post · {cancelled} cancelled at the SAT but posted · {surplus} posted but not in the census ({cancelledUnbooked} cancelled and never posted: not a gap).',
  'sat.reconcile.not_loaded':
    'No census of {direction} CFDI covers this month: it is not loaded, which is not the same as nothing having been {direction}. Load it with `ingest --kind metadata`.',
  'help.closing.fx.description': 'Foreign currency at the close',
  'help.closing.fx.revalue.description':
    'Revalue the foreign-currency receivables, payables and banks at the closing rate, and reverse it on day 1 of the next period. It belongs after the soft close; a later run posts only what moved since',
  'help.closing.fx.revalue.argument.period': 'period to revalue: 2026-08, its id, or part of its name',

  'closing.fx.revalue.already_run':
    '{period} was already revalued (run {sequence}) and nothing has moved since; nothing was posted again.',
  'closing.fx.revalue.summary':
    '{period} at {rates} · gain {gain} · loss {loss} · reversed on {reversalDate}',
  'closing.fx.revalue.no_foreign_balance': 'no foreign balance',
  'closing.fx.revalue.supplement':
    'Supplementary run {sequence}: the difference is only what moved since the earlier runs of this period.',
  'closing.fx.revalue.dry_run': 'Dry run: the ledger was not touched.',
  'closing.fx.revalue.nothing': 'Nothing to revalue: the ledger was not touched.',
  'closing.fx.revalue.confirm':
    'Post the revaluation of {period} (gain {gain}, loss {loss}) and its mirror on {reversalDate}? The ledger does not admit undo.',
  'closing.fx.revalue.aborted': 'Nothing was posted.',
  'closing.fx.revalue.aborted_no_tty':
    'Nothing was posted: there is no terminal to confirm on. Add -y, or --dry-run to look first.',
  'closing.fx.revalue.posted': '✔ {entry} on {closingDate}, reversed by {reversal} on {reversalDate}.',
  'help.bill.rule.description': 'Firm processing rules: what codes an incoming CFDI with no model involved',
  'help.bill.rule.create.description':
    'Create a processing rule (conditions → actions) that the next ingest applies',
  'help.bill.rule.create.option.name': 'rule name, shown in the trace of every CFDI it decides',
  'help.bill.rule.create.option.when': 'repeatable, all must hold: "<field> <operator> <value>"',
  'help.bill.rule.create.option.then': 'repeatable: "<action>=<value>", e.g. set_account=6100',
  'help.bill.rule.create.option.type': 'rule type: {types}',
  'help.bill.rule.create.option.priority': 'lower runs first; a later match overrides an earlier one',
  'help.bill.rule.create.option.description': 'why the firm keeps this rule',
  'help.bill.rule.create.option.dry_run': 'validate and show the rule; write nothing',
  'help.bill.rule.create.option.json': 'JSON output',
  'help.bill.rule.list.description':
    'List the processing rules in evaluation order, with how often each one fired',
  'help.bill.rule.list.option.type': 'only this rule type: {types}',
  'help.pay_run.description':
    'Payroll runs of a pay period: create, calculate gross to net, approve, post the entry',
  'help.pay_run.create.description':
    'Create a draft run over a pay period; the tax year is fixed from the period, ' +
    'and a period holds one regular run',
  'help.pay_run.create.option.period': 'pay period of the active entity (its id)',
  'help.pay_run.create.option.type': 'run type: {types}',
  'help.pay_run.calculate.description':
    'Calculate gross to net for each employee in the inputs file and total the run; ' +
    'a run that is not approved can be calculated again, which rebuilds its paychecks',
  'help.pay_run.calculate.argument.id': 'pay run to calculate',
  'help.pay_run.calculate.option.file': 'JSON with the employee inputs: an array, or {shape}',
  'help.pay_run.approve.description':
    'Approve a calculated run, sealing its totals and writing the employer liability; irreversible',
  'help.pay_run.approve.argument.id': 'calculated pay run to approve',
  'help.pay_run.post.description':
    'Build the payroll entry of an approved run and leave it as a draft for `mnemosine review`; ' +
    '--post posts it directly',
  'help.pay_run.post.argument.id': 'approved pay run whose entry is built',
  'help.pay_run.post.option.post': 'post the entry to the ledger now instead of leaving a draft for review',
  'help.pay_schedule.description': 'Pay schedules of the entity: the frequency and dates its pay periods follow',
  'help.pay_schedule.create.description': 'Create a pay schedule with its frequency, first period start and pay day rule',
  'help.pay_schedule.create.option.name': 'name of the schedule, as the accountant knows it',
  'help.pay_schedule.create.option.frequency': 'how often it pays: {frequencies}',
  'help.pay_schedule.create.option.country': 'payroll country of the schedule',
  'help.pay_schedule.create.option.first_start': 'first day of the first period (YYYY-MM-DD)',
  'help.pay_schedule.create.option.pay_day_offset': 'days after the end of each period that it is paid (default 0)',
  'help.pay_schedule.list.description': 'List the pay schedules of the entity with their frequency and employees',
  'help.pay_schedule.list.option.all': 'include inactive schedules',
  'help.pay_period.description': 'Pay periods of the entity: create the next ones of a schedule, list them',
  'help.pay_period.create.description':
    'Create the next periods of a schedule, after its last one; a period already there is not written again',
  'help.pay_period.create.option.schedule': 'pay schedule of the entity (its id)',
  'help.pay_period.create.option.count': 'how many periods to create, 1 to {max}',
  'help.pay_period.list.description': 'List the pay periods of the entity with status, pay date and tax year',
  'help.pay_period.list.option.status': 'only periods in this state: {states}',
  'help.pay_period.list.option.year': 'only periods of this tax year (the year of the pay date)',
  'help.payslip.description': 'Paychecks of a pay run: list them, show one with its lines',
  'help.payslip.list.description': 'List the paychecks of a run with gross, net and stamp status; no tax identifiers',
  'help.payslip.list.option.run': 'pay run whose paychecks are listed (required)',
  'help.payslip.show.description':
    'Show one paycheck: totals from gross to net and every earning, deduction and tax line',
  'help.payslip.show.argument.id': 'paycheck id (from `payslip list --run`)',
  'help.payslip.show.option.redacted': 'hide RFC, CURP and NSS entirely, for a shared screen',
  'help.imss.description': 'IMSS obligations of the employer: the monthly SUA file',
  'help.imss.sua.description': 'The SUA import file of a month',
  'help.imss.sua.export.description':
    'Build the SUA import file of a month from the approved paychecks, checked against the employer liability',
  'help.imss.sua.export.option.period': 'month to export (YYYY-MM); the SUA is monthly',
  'help.imss.sua.export.option.output': 'write the SUA file to this path (without it, the file goes to stdout)',
  'help.imss.sua.export.option.yes': 'overwrite the file named by -o if it already exists',
  'help.imss.sua.export.option.dry_run': 'build and check the file without writing it or recording the filing',
  // ==== MNE-001-092 · help by key, the close and control families (issue #314) ====
  //
  // Same format as `period`: help.<cmd>[.<sub>…].description, .option.<flag>
  // and .argument.<name>, in snake_case (`opening-balance` → `opening_balance`).
  // Families: close, closing, year, chart, opening-balance, ar, ap, cashflow,
  // depreciation, diot. The English is the prose these commands already showed.
  'help.close.description': 'Month-end close: checks what is missing and closes the period',
  'help.close.option.period':
    'Period to close: 2026-08, its id, or an unambiguous part of its name (default: the oldest open one)',
  'help.close.option.list': 'List closable periods and exit',
  'help.close.option.check': 'Only check readiness, never close',
  'help.close.option.hard': 'Hard close (irreversible) instead of soft close',
  'help.close.option.reason': 'why this close happens now; recorded in the audit trail',
  'help.close.option.json': 'JSON output for scripts',
  'help.closing.description': 'The close as a process: conduct it, read it, and hand over the dossier that proves it',
  'help.closing.preview.description':
    'Read-only twin of closing start: says whether the period can enter close and what is missing',
  'help.closing.preview.argument.period':
    'open period: 2026-07, its id, or part of its name (default: the oldest open one)',
  'help.closing.check.description':
    'Run the close verification catalog, or only the named checks; bare --check lists the names',
  'help.closing.check.option.check': 'comma-separated check codes; with no value, prints the available ones',
  'help.closing.check.option.period':
    'period to check: 2026-07, its id, or part of its name (default: the oldest open one)',
  'help.closing.explain.description':
    'Print the offending rows of one check (ids, amounts, dates) and the exact command that fixes it',
  'help.closing.explain.argument.code': 'check code, one of: {codes}',
  'help.closing.explain.option.limit': 'maximum offending rows to print',
  'help.closing.explain.option.period':
    'period to explain: 2026-07, its id, or part of its name (default: the oldest open one)',
  'help.closing.run.description':
    'Conduct the close: accrue, amortize, depreciate, revalue foreign balances, verify the checklist, soft-close and hard-close, in that order',
  'help.closing.run.argument.period':
    'open period: 2026-07, its id, or part of its name (default: the oldest open one)',
  'help.closing.run.option.stop_at': 'stop BEFORE this step: {steps}',
  'help.closing.run.option.resume':
    'continue the open run of this period; every step runs again, posting only what is missing',
  'help.closing.pack.description': 'The dossier of a close: generate it, and verify that its figures still reproduce',
  'help.closing.pack.generate.description': 'Seal the period figures into a dossier a third party can re-run',
  'help.closing.pack.generate.argument.period':
    'period name, YYYY-MM or id, in any status (default: the most recently closed one)',
  'help.closing.pack.generate.option.output': 'write the dossier to this path (closing_packs keeps its own copy)',
  'help.closing.pack.verify.description':
    'Re-run a dossier against the books: was it issued here, do its figures still reproduce, and exactly what moved',
  'help.closing.pack.verify.argument.file': 'the dossier to verify',
  'help.year.description': 'Fiscal years: the calendar an entity keeps its books in',
  'help.year.list.description': 'List the fiscal years of the entity with their state and close progress',
  'help.year.show.description': 'Show a fiscal year with each of its periods and their states',
  'help.year.show.argument.year': 'four-digit year, e.g. 2026',
  'help.year.create.description':
    'Create a fiscal year: its twelve monthly periods and the year-end adjustment period (13)',
  'help.year.create.argument.year': 'four-digit year, e.g. 2027',
  'help.year.create.option.dry_run': 'show the calendar that would be created; write nothing',
  'help.year.create.option.json': 'JSON output',
  // MNE-001-645 (#594): the carry for a year that was created without opening balances.
  'help.year.carry_forward.description': 'The carry-forward of balances into a fiscal year',
  'help.year.carry_forward.run.description':
    'Carry the closing balances of the sealed year before it into the first period of a fiscal year that was created without them; a second run changes nothing',
  'help.year.carry_forward.run.argument.year': 'the fiscal year that receives the opening balances, e.g. 2028',
  'help.year.carry_forward.run.option.dry_run':
    'run the carry and roll it back: show each opening balance it would correct; write nothing',
  'help.year.carry_forward.run.option.json': 'JSON output',
  'help.year.carry_forward.run.examples':
    '\nExamples:\n' +
    '  2027 was sealed before 2028 existed, and January 2028 opens at zero; see what would be corrected:\n' +
    '    mnemosine year carry-forward run 2028 --dry-run\n' +
    '  Correct it. No entry is created or edited, and running it again changes nothing:\n' +
    '    mnemosine year carry-forward run 2028\n',
  'help.chart.description': 'Chart of accounts: bring a firm catalog in',
  'help.chart.import.description': 'Import an Anexo 24 CatalogoCuentas XML, keeping the firm codes and hierarchy',
  'help.chart.import.option.partial': 'write even if some rows are left out (default: all or nothing)',
  'help.chart.import.option.reason': 'why the chart is imported; goes to the audit log',
  'help.opening_balance.description':
    'Opening balances migrated from the Anexo 24 trial balance of the previous system',
  'help.opening_balance.import.description':
    'Post the opening entry from an Anexo 24 BalanzaComprobacion XML, on the day after its cutoff -- irreversible',
  'help.opening_balance.import.option.subledger':
    'JSON array with the open documents of the receivable and payable control accounts',
  'help.opening_balance.import.option.chart':
    'the CatalogoCuentas XML of the same migration: its memorandum accounts (8xx) are left out of the entry ' +
    'and named with the source figure',
  'help.opening_balance.import.option.reason': 'why the opening is loaded; goes to the audit log',
  'help.opening_balance.check.description':
    'Compare the source trial balance against the ledger on the opening day, to the peso; exits 4 if they differ',
  'help.opening_balance.check.option.chart':
    'the CatalogoCuentas XML of the same migration: its memorandum accounts (8xx) are left out of the footing ' +
    'and named with the source figure',
  'help.ar.description':
    'Receivables controls: reconcile the subledger against the control account, run named diagnostics',
  'help.ar.reconcile.description':
    'Subledger (open invoices − unapplied credit notes) vs the cxc control account, naming manual entries',
  'help.ar.reconcile.option.strict': 'exit 4 on any delta, however small the list of suspects',
  /** `ar check`, probe cross-party-application (MNE-001-530). */
  'ar.check.cross_party_application.found':
    "a customer's cash settles another customer's invoice: review it; nothing is blocked",
  'ar.check.cross_party_application.none': 'none',
  'ar.check.orphan_application.found':
    "a dead receipt's allocation still counts as collected, so its invoice's next collection releases none of its IVA. " +
    "On a reversed receipt the reversal already reopened the invoice and mirrored its entries, so only the row's close is missing: " +
    'close it with `receipt allocation close <receipt> --invoice <invoice> --reason "<why>"`, which posts nothing, ' +
    'before collecting that invoice again. On a void or failed receipt, report it',
  'ar.check.orphan_application.none': 'none',
  /** `ledger check`, check year-sweep (MNE-001-662): `sealed` is the year's last period; `accounts`, codes. */
  'ledger.check.year_sweep.found':
    'posted to {period} on {posted}, after {sealed} swept the fiscal year on {sealed_at}: {accounts} no longer agree with that sweep. Close {sealed} again (period reopen, then close twice), or reverse the entry',
  'help.ar.check.description':
    'Named receivables diagnostics; `--check` with no value lists them, `--check a,b` selects',
  'help.ar.check.option.check': 'comma-separated diagnostics to run; bare --check lists the battery',
  'help.ar.check.option.strict': 'exit 4 on warnings too, not only blocking findings',
  'help.ap.description':
    'Payables controls: reconcile the vendor subledger against the control account, and run the named checks',
  'help.ap.reconcile.description':
    'Vendor subledger (open bills) vs the cxp control account, naming the reconciling items',
  'help.ap.reconcile.option.as_of': 'cut-off for both sides of the reconciliation (YYYY-MM-DD; defaults to today)',
  'help.ap.reconcile.option.explain': 'spell out every reconciling item in prose, not just the table',
  'help.ap.check.description':
    'Named payables checks; `--check` with no value lists them, `--check a,b` selects',
  'help.ap.check.option.check': 'comma-separated checks to run; bare --check lists the battery',
  'ap.check.title': 'AP checks',
  'ap.check.cancelled_cfdi_open.found':
    'open bills whose received CFDI the SAT reports cancelled: hold the payment until the vendor sends the CFDI that replaces it; ' +
    'what it means for the deduction and the VAT is the accountant\'s call, and nothing was reversed',
  'ap.check.cancelled_cfdi_open.none': 'none',
  'ap.check.bill_line': '{bill} · {vendor} · {uuid} · owes {amount} {currency} · noted {noted}',
  /** MNE-001-610: the second probe of `ap check`, the paid bills with the mark. */
  'ap.check.cancelled_cfdi_paid.found':
    'paid bills whose received CFDI the SAT reports cancelled: their deduction and creditable VAT rest on a CFDI that no longer stands; ' +
    'ask the vendor for the CFDI that replaces it; whether to correct what was already declared is the accountant\'s call, and nothing was reversed',
  'ap.check.cancelled_cfdi_paid.none': 'none',
  'ap.check.paid_bill_line': '{bill} · {vendor} · {uuid} · paid {amount} {currency} · noted {noted}',
  'ap.check.summary':
    '{blocking, plural, one {# blocking} other {# blocking}} · {warnings, plural, one {# warning} other {# warnings}}',
  'help.cashflow.description': 'Statement of cash flows (NIF B-2 / ASC 230): build it, and tie it to real cash',
  'help.cashflow.generate.description': 'Build the statement of cash flows for a period, with the tie-out to real cash',
  'help.cashflow.generate.option.method':
    'method to build the statement with (default: the `flujo_efectivo_metodo` policy)',
  'help.cashflow.generate.option.gross':
    'present gross receipts and payments instead of net (NIF B-2 §40 / ASC 230-10-45-7); refused with a reason — these books cannot support it',
  'help.cashflow.reconcile.description':
    'Reconcile the derived statement of cash flows against the real movement of cash and equivalents, and print the residue instead of absorbing it',
  'help.cashflow.reconcile.option.show_candidates':
    'list the journal lines that most likely explain the residue (suspects, not a verdict)',
  'help.depreciation.description': 'The monthly depreciation run: compute it, look at it, then post it',
  'help.depreciation.run.description':
    'Compute the period run and show it asset by asset — writes nothing, posts nothing',
  'help.depreciation.run.option.period': 'period to compute: 2026-08, or any unambiguous part of its name',
  'help.depreciation.run.option.book': 'the depreciation book you believe you are running; checked against the panel',
  'help.depreciation.run.option.by': 'detail or summary: {dimensions} (asset is the per-asset detail)',
  'help.depreciation.post.description': 'Post the period run to the ledger — one journal entry per asset, irreversible',
  'help.depreciation.post.option.period': 'period to post: 2026-08, or any unambiguous part of its name',
  'help.depreciation.post.option.book': 'the depreciation book you believe you are posting; checked against the panel',
  'help.depreciation.post.option.file':
    'the approved plan (JSON from `depreciation run --format json`); refuses if the numbers moved',
  'help.filing.description': 'Tax returns of the entity: the working papers behind them, and the record of those filed',
  'help.filing.workpaper.description': 'The auditable working paper of the month, line by line',
  'help.filing.workpaper.generate.description':
    'Generate the month workpaper: IVA and provisional ISR, cents and pesos, with the entries behind each line',
  'help.filing.workpaper.generate.option.period': 'month to settle (the filing is monthly)',
  'help.filing.workpaper.generate.option.form': 'which settlement to include',
  'help.filing.workpaper.generate.option.ptu_paid': 'PTU paid in the year (ISR), captured by a person',
  'help.filing.workpaper.generate.option.prior_provisional':
    'provisional ISR already paid this year (ISR), captured by a person',
  'help.filing.workpaper.generate.option.prior_balance':
    'prior balance in favour (IVA) instead of the one the returns recorded with `filing record` give; needs --prior-balance-reason',
  'help.filing.workpaper.generate.option.prior_balance_reason': 'why the prior balance is overridden, shown on its line',
  'help.filing.workpaper.generate.footer':
    'This computes the paper. It does NOT file anything: a person reviews it and declares in the SAT portal.\n' +
    '\nExamples:\n' +
    '  The month IVA and ISR with their two columns and the entries behind each line:\n' +
    '    mnemosine filing workpaper generate --period 2026-05\n' +
    '  Only the IVA, the whole paper (with the entries) as JSON to a file:\n' +
    '    mnemosine filing workpaper generate --period 2026-05 --form iva --json -o papel-2026-05.json\n' +
    '  The ISR with the PTU paid in the year and the provisional payments already made:\n' +
    '    mnemosine filing workpaper generate --period 2026-05 --form isr --ptu-paid 24000 --prior-provisional 15000.40\n' +
    '  The IVA with a prior balance a person gives instead of the one the filed returns give:\n' +
    '    mnemosine filing workpaper generate --period 2026-05 --form iva --prior-balance 3000 --prior-balance-reason "return filed before the system"',
  'filing.workpaper.period_invalid': '--period "{value}" is not a month: use YYYY-MM (for example 2026-05).',
  'filing.workpaper.form_invalid': '--form "{value}" is not known: use iva, isr or all.',
  'filing.workpaper.label_blocks': 'BLOCKS',
  'filing.workpaper.label_warning': 'warning',
  'filing.workpaper.not_a_filing': 'This paper is not a filing: nothing was sent to the SAT.',
  'filing.workpaper.more_entries': '+{count} more',
  'filing.workpaper.prior_balance_override_incomplete':
    'An override of the prior balance in favour gives the amount and the reason for it, both (--prior-balance and --prior-balance-reason).',
  // ==== MNE-001-577 · filing record (issue #308, part 3/3) ====
  'help.filing.record.description':
    'Record a monthly IVA return already filed in the SAT portal: its acuse, what it left payable or in favour, its payment and the balances it credited',
  'help.filing.record.option.form': 'which return it is: {forms} (the monthly IVA)',
  'help.filing.record.option.period': 'month the return covers',
  'help.filing.record.option.filed_on': 'day the return was filed (YYYY-MM-DD), after its month ends',
  'help.filing.record.option.acuse': 'operation number of the acknowledgement («acuse»): how the record names this return',
  'help.filing.record.option.capture_line': 'payment reference the SAT gave with the filing (the capture line), when the return has something to pay',
  'help.filing.record.option.payable': 'amount payable the return left, up to two decimals (use 0 for a return at zero)',
  'help.filing.record.option.in_favor': 'balance in favour the return left, up to two decimals; never together with --payable',
  'help.filing.record.option.paid': 'what was paid with the capture line; goes with --paid-on',
  'help.filing.record.option.paid_on': 'day it was paid (YYYY-MM-DD), the day of the filing or later; goes with --paid',
  'help.filing.record.option.credit':
    'an earlier balance in favour this return credited (LIVA art. 6), as the acuse of the return that left it and the amount; repeat it for each',
  'help.filing.record.footer':
    'This records a return a person already filed. It sends nothing to the SAT, and a recorded return is never edited: each filed return is a new row.\n' +
    'An amended return («complementaria») is recorded with `mnemosine filing correct`.\n' +
    '\nExamples:\n' +
    '  See the row the July return would leave, with its balance in favour, writing nothing:\n' +
    '    mnemosine filing record --form iva --period 2026-07 --filed-on 2026-08-14 --acuse OP-0701 --in-favor 5000.00 --dry-run\n' +
    '  August: 8,000.00 of IVA less 3,000.00 credited from July, 5,000.00 payable and paid the next day:\n' +
    '    mnemosine filing record --form iva --period 2026-08 --filed-on 2026-09-15 --acuse OP-0801 --capture-line LC-0801 --payable 5000.00 --paid 5000.00 --paid-on 2026-09-16 --credit OP-0701:3000.00 --json',
  'filing.record.form_invalid': '--form "{value}" is not a return this command records: use {forms}. The provisional ISR is not recorded yet. Nothing was written.',
  'filing.record.period_invalid': '--period "{value}" is not a month: use YYYY-MM (for example 2026-08). Nothing was written.',
  'filing.record.date_invalid': '{flag} "{value}" is not a real day: use YYYY-MM-DD (for example 2026-09-15). Nothing was written.',
  'filing.record.acuse_required': 'Missing --acuse: the operation number of the acknowledgement is how the record names a return. Nothing was written.',
  'filing.record.capture_line_blank': '--capture-line is blank: give it, or leave it out when the return has nothing to pay. Nothing was written.',
  'filing.record.result_required': 'Say what the return left: --payable <amount> or --in-favor <amount> (--payable 0 for a return at zero). Nothing was written.',
  'filing.record.result_both': 'A return leaves an amount payable or a balance in favour, never both: give --payable or --in-favor, not the two. Nothing was written.',
  'filing.record.amount_invalid': '{flag} "{value}" is not an amount: use zero or more, with at most two decimals and no thousands separator (for example 5000.00). Nothing was written.',
  'filing.record.payment_incomplete': 'Missing {missing}: a payment states both what was paid (--paid) and the day (--paid-on). Nothing was written.',
  'filing.record.credit_invalid': '--credit "{value}" is not valid: use <acuse>:<amount>, the acuse of the earlier return and the amount credited (for example OP-0701:3000.00). Nothing was written.',
  'filing.record.filed_on_in_future': '--filed-on {value} is after today ({today}): only a return already filed is recorded. Nothing was written.',
  'filing.record.paid_on_in_future': '--paid-on {value} is after today ({today}): only a payment already made is recorded. Nothing was written.',
  'filing.record.dry_run': 'Dry run: the return is valid and was rolled back; nothing was written.',
  'filing.record.recorded': 'Recorded: {acuse} is the {period} return in force. Nothing was sent to the SAT.',
  // ==== MNE-001-629 · filing correct (issue #308) ====
  'help.filing.correct.description':
    'Record an amended monthly IVA return («complementaria») already filed in the SAT portal, linked to the return it replaces; both are kept',
  'help.filing.correct.option.replaces': 'acuse of the return in force this one replaces: the last one filed for that month',
  'help.filing.correct.footer':
    'This records an amended return a person already filed (CFF art. 32). It sends nothing to the SAT.\n' +
    'The return it replaces stays in the record. From now on the month is read from the amended one, and later working papers take its balance in favour from it.\n' +
    'An amended return states every figure again: repeat each --credit of the return it replaces, or this one credits nothing. --paid is what was paid with this return\'s own capture line.\n' +
    'It is refused when it leaves less in favour than later months already credited: amend those returns first.\n' +
    '\nExamples:\n' +
    '  See the row an amended July return would leave, with 4,200.00 in favour where 5,000.00 were declared, writing nothing:\n' +
    '    mnemosine filing correct --form iva --period 2026-07 --replaces OP-0701 --filed-on 2026-09-10 --acuse OP-0702 --in-favor 4200.00 --dry-run\n' +
    '  Amend August: 8,500.00 of IVA less the same 3,000.00 credited from July, 5,500.00 payable, and the 500.00 of difference paid that day:\n' +
    '    mnemosine filing correct --form iva --period 2026-08 --replaces OP-0801 --filed-on 2026-10-02 --acuse OP-0802 --capture-line LC-0802 --payable 5500.00 --paid 500.00 --paid-on 2026-10-02 --credit OP-0701:3000.00 --json',
  'filing.correct.replaces_required': 'Missing --replaces: give the acuse of the return in force this amended return replaces. The first return of a month is recorded with `mnemosine filing record`. Nothing was written.',
  'filing.correct.recorded': 'Recorded: {acuse} replaces {replaced} and is the {period} return in force. Both are kept. Nothing was sent to the SAT.',
  // ==== MNE-001-457 · annual figure record (issue #622) ====
  'help.annual.description': 'The annual return of the entity: the figures read off it once it is filed',
  'help.annual.figure.description': 'Figures of a filed annual return that the provisional payments need',
  'help.annual.figure.record.description': 'Record a figure of a filed annual return, with that return as its source and who captured it',
  'help.annual.figure.record.option.kind': 'which figure it is: {kinds}',
  'help.annual.figure.record.option.value': 'the figure as the return states it: zero or more, up to four decimals',
  'help.annual.figure.record.option.year': 'fiscal year of the annual return',
  'help.annual.figure.record.option.filed_on': 'day the return, or its amendment, was filed (YYYY-MM-DD)',
  'help.annual.figure.record.option.source': 'how you identify that return: its operation number',
  'help.annual.figure.record.option.updated_through': 'pending tax losses only: the INPC month they are already updated through (YYYY-MM, LISR art. 57)',
  'help.annual.figure.record.footer':
    'This records what a filed return states. It files nothing, and the latest capture of a return is the one in force.\n' +
    'A return that gave no coefficient is not captured: the paper then uses the latest return captured within five years (LISR art. 14 fr. I).\n' +
    '\nExamples:\n' +
    '  See the row the profit coefficient of the 2025 return would leave, writing nothing:\n' +
    '    mnemosine annual figure record --kind profit_coefficient --value 0.0875 --year 2025 --filed-on 2026-03-20 --source "operation 000111" --dry-run\n' +
    '  Its amendment, filed later: a new capture that takes over, and the earlier one stays:\n' +
    '    mnemosine annual figure record --kind profit_coefficient --value 0.0900 --year 2025 --filed-on 2026-05-02 --source "operation 000222" --json\n' +
    '  The pending tax losses of that return, updated through December 2025; zero is captured too:\n' +
    '    mnemosine annual figure record --kind pending_tax_losses --value 30000.00 --updated-through 2025-12 --year 2025 --filed-on 2026-03-20 --source "operation 000111"',
  'annual.figure.kind_invalid': '--kind "{value}" is not a figure this command records: use {kinds}. Nothing was written.',
  'annual.figure.value_invalid': '--value "{value}" is not valid: use zero or more, with up to fifteen digits before the point and four decimals (for example 0.0875). Nothing was written.',
  'annual.figure.year_invalid': '--year "{value}" is not valid: use the four digits of the return\'s fiscal year, from {min} to {max}. Nothing was written.',
  'annual.figure.filed_on_invalid': '--filed-on "{value}" is not a real day: use YYYY-MM-DD (for example 2026-03-20). Nothing was written.',
  'annual.figure.source_required': 'Missing --source: say which return the figure was read from (its operation number). Nothing was written.',
  'annual.figure.filed_on_not_after_year': '--filed-on {value} cannot be the filing date of the {year} return: an annual return is filed after its year ends. Nothing was written.',
  'annual.figure.filed_on_in_future': '--filed-on {value} is after today ({today}): only a return already filed is recorded. Nothing was written.',
  'annual.figure.updated_through_required': 'Missing --updated-through: pending tax losses say the INPC month they are updated through (YYYY-MM, for example 2025-12). Nothing was written.',
  'annual.figure.updated_through_not_allowed': '--updated-through does not go with --kind {kind}: only the pending tax losses carry an update month. Nothing was written.',
  'annual.figure.updated_through_invalid': '--updated-through "{value}" is not a month: use YYYY-MM (for example 2025-12). Nothing was written.',
  'annual.figure.updated_through_after_target': '--updated-through {value} is after {target}: the losses of the {year} return are applied by the next year\'s payments, which update them to that June at most (LISR art. 57). Nothing was written.',
  'annual.figure.dry_run': 'Dry run: the capture is valid; nothing was written.',
  'annual.figure.next': 'Next: `mnemosine filing workpaper generate --period <YYYY-MM> --form isr`.',
  // ==== MNE-001-298 · ptu close (issue #111) ====
  'help.ptu.description': 'The workers\' share in profits (PTU, LFT art. 117-131)',
  'help.ptu.close.description': 'Propose the PTU of the year as a draft entry in period 13, from the three figures of LISR art. 9 with their source',
  'help.ptu.close.option.year': 'fiscal year whose PTU is proposed (YYYY)',
  'help.ptu.close.option.accumulable_income': 'ingresos acumulables of the year, inflation adjustment included (LISR art. 9)',
  'help.ptu.close.option.authorized_deductions': 'deducciones autorizadas of the year, already net of the non-deductible exempt pay',
  'help.ptu.close.option.non_deductible_exempt_pay': 'the non-deductible part of exempt pay (LISR art. 28 fr. XXX), which the PTU base takes off',
  'help.ptu.close.option.source': 'where the three figures were read: the annual computation or return they come from',
  'help.ptu.close.footer':
    'The base is accumulable income less authorized deductions less the non-deductible exempt pay; neither the PTU paid nor the pending losses are subtracted (LISR art. 9).\n' +
    'The draft books the PTU less what the year already credited to the PTU provision, and posts nothing: review it and run `mnemosine entry post`.\n' +
    '\nExamples:\n' +
    '  See the PTU of 2026 without writing anything:\n' +
    '    mnemosine ptu close --year 2026 --accumulable-income 5000000 --authorized-deductions 3800000 --non-deductible-exempt-pay 94000 --source "annual computation 2026" --dry-run',
  'ptu.close.year_invalid': '--year "{value}" is not valid: use the four digits of the fiscal year, from {min} to {max}. Nothing was written.',
  'ptu.close.figure_invalid': '{flag} "{value}" is not valid: use zero or more, with up to fifteen digits before the point and four decimals. Nothing was written.',
  'ptu.close.source_required': 'Missing --source: say where the three figures were read. Nothing was written.',
  'ptu.close.dry_run': 'Dry run: this is the draft the PTU would leave; nothing was written.',
  'ptu.close.proposed': 'Draft {entry} left in period 13. Nothing was posted: review it, then `mnemosine entry post {entry}`.',
  'ptu.close.exists': 'The PTU of {year} with these figures is already entry {entry} ({status}). Nothing was written.',
  'ptu.close.nothing_to_propose': 'The year already provisioned exactly this PTU: there is nothing to propose. Nothing was written.',
  'ptu.finding.regime_undeclared': 'The entity declares no tax regime: the PTU base assumes the general regime (601, LISR art. 9).',
  'ptu.finding.first_year': 'The entity has no fiscal period before {year}: if this is its first year of operations, it owes no PTU for it (LFT art. 126 fr. I).',
  'error.VALIDATION_ERROR.ptu.regime': 'The entity is in tax regime {regime}: the PTU base of LISR art. 9 is the general regime\'s (601). Nothing was written.',
  'error.VALIDATION_ERROR.ptu.no_adjustment_period': 'The year {year} has no open year-end adjustment period (13) to hold the draft. Nothing was written.',
  'error.VALIDATION_ERROR.ptu.roles_missing': 'No account is mapped to {roles} in this entity, so the PTU has nowhere to be booked. Add it with: npm run backfill:account-roles -- --aplicar, or map it with `mnemosine account role set`. Nothing was written.',
  'error.VALIDATION_ERROR.ptu.rate_unavailable': 'The PTU percentage ({key}) is not in force on {date} ({gap}): it is seeded with the Comisión Nacional resolution\'s verified date, never assumed. Nothing was written.',
  'error.VALIDATION_ERROR.ptu.other_figures_draft': 'The PTU of {year} is already draft {entry}, with other figures. Void it (`mnemosine entry void {entry}`) and run this again. Nothing was written.',
  'error.VALIDATION_ERROR.ptu.other_figures_posted': 'The PTU of {year} is already posted as {entry}, with other figures. Reverse it (`mnemosine entry reverse {entry}`) and run this again. Nothing was written.',
  'income_tax_input.year_out_of_range': 'The fiscal year of the source return goes from {min} to {max}: {year} is outside.',
  'income_tax_input.filed_on_not_a_day': '"{value}" is not a real day (YYYY-MM-DD): it cannot be the filing date of the return.',
  'income_tax_input.value_too_large': '"{value}" does not fit: a figure has at most fifteen digits before the point.',
  'filed_return.obligation_not_written': 'Only the monthly IVA return is recorded for now: "{value}" is not. Nothing was written.',
  'filed_return.obligation_invalid': '"{value}" is not an obligation of the record of filed returns: use {obligations}.',
  'filed_return.period_invalid': '"{value}" is not a month: use YYYY-MM (for example 2026-08).',
  'filed_return.filed_on_not_a_day': 'The filing date "{value}" is not a real day: use YYYY-MM-DD (for example 2026-09-15). Nothing was written.',
  'filed_return.filed_before_period_ends': 'The return for {period} is filed once its month ends, on {earliest} or later: {value} cannot be its filing date. Nothing was written.',
  'filed_return.paid_on_not_a_day': 'The payment date "{value}" is not a real day: use YYYY-MM-DD (for example 2026-09-16). Nothing was written.',
  'filed_return.paid_before_filed': 'The payment on {paidOn} comes before the filing on {filedOn}: a return is paid with the capture line its filing gives, that day or later. Nothing was written.',
  'filed_return.payment_incomplete': 'A payment states both what was paid and the day it was paid. Nothing was written.',
  'filed_return.payable_and_in_favor': 'A return leaves an amount payable or a balance in favour, never both: {payable} payable and {inFavor} in favour. Nothing was written.',
  'filed_return.amount_invalid': '"{value}" is not an amount of a return: use zero or more, with at most two decimals and seventeen digits before the point (for example 5000.00). Nothing was written.',
  'filed_return.credit_amount_not_positive': 'A credited balance is above zero: leave out a credit of nothing. Nothing was written.',
  'filed_return.acknowledgement_required': 'Missing the operation number of the acknowledgement («acuse»): it is how the record names a return. Nothing was written.',
  'filed_return.capture_line_blank': 'The capture line is blank: give it, or leave it out when the return has nothing to pay. Nothing was written.',
  'filed_return.credit_repeated': 'The balance of return {acknowledgement} is credited twice in this return: put both amounts in one credit. Nothing was written.',
  'filed_return.credit_source_unknown': 'No return with operation number {acknowledgement} is recorded for this entity and tax: record that return first, then the one that credits its balance. Nothing was written.',
  'filed_return.credit_source_not_earlier': 'Return {acknowledgement} covers {sourcePeriod}: a return for {period} credits balances of earlier months only (LIVA art. 6). Nothing was written.',
  'filed_return.credit_source_no_balance': 'Return {acknowledgement} left no balance in favour: there is nothing of it to credit. Nothing was written.',
  'filed_return.credit_above_available': 'Return {acknowledgement} ({sourcePeriod}) has {available} of its balance in favour left to credit, after what the returns in force of other months credited, what was compensated and any refund request: {requested} cannot be credited from it (LIVA art. 6). Nothing was written.',
  'filed_return.amended_below_used': 'The amended return leaves {balance} in favour for {period}, but {used} of that balance is already used: {credited} credited by the returns in force {returns}, and {compensated} compensated. Amend those returns first, then record this one (LIVA art. 6, CFF art. 32). Nothing was written.',
  'filed_return.replaced_unknown': 'No return with operation number {acknowledgement} is recorded for this entity and tax: an amended return replaces one already recorded. Nothing was written.',
  'filed_return.replaced_other_period': 'Return {acknowledgement} covers {replacedPeriod}: an amended return for {period} replaces a return of the same month. Nothing was written.',
  'filed_return.amended_before_replaced': 'The amended return is filed on {filedOn}, before return {acknowledgement}, which it replaces, was filed on {replacedFiledOn}: an amendment comes after (CFF art. 32). Nothing was written.',
  'filed_return.acknowledgement_taken': 'The operation number {acknowledgement} is already recorded for this entity: each acknowledgement is one return. Nothing was written.',
  'filed_return.original_exists': 'The {period} return of this tax is already recorded: another return for that month is an amendment, which names the return in force it replaces. Nothing was written.',
  'filed_return.already_replaced': 'Return {acknowledgement} was already replaced by another amended return: an amendment replaces the return in force of {period}, the last one filed. Nothing was written.',
  'help.diot.description':
    'Mexican DIOT: build the month from paid transactions, check it, and export the working paper',
  'help.diot.generate.description':
    "Build the month's DIOT from paid transactions, broken down by third party and by rate",
  'help.diot.generate.option.period': 'month to declare (the DIOT is monthly; no month 13)',
  'help.diot.check.description':
    'Run the DIOT invariants by name: the paid fact, the rate breakdown, the exempt base, the third party and its operation type',
  'help.diot.check.option.period': 'month to check (the DIOT is monthly; no month 13)',
  'help.diot.check.option.check': 'comma-separated check names; with no value, prints the available ones',
  'help.diot.export.description':
    'Emit the DIOT file, byte-stable for diffing: the working paper, or the SAT batch file to upload',
  'help.diot.export.option.period': 'month to export (the DIOT is monthly; no month 13)',
  'help.diot.export.option.layout':
    'file layout: working-paper is the per-third-party reconciliation; sat is the authority batch file',
  'help.diot.export.option.yes': 'skip the overwrite prompt when -o names an existing file',
  'help.diot.export.option.output':
    'write the exported file to this path (without it, the file goes to stdout so it can be diffed)',
  // ==== MNE-001-234 · help by key, account and ledger (issue #314) ====
  //
  // Same format as `period`. The ledger series is keyed in two tasks (234 and
  // 235); this one takes `account` and `ledger`, with the English these
  // commands already showed. Every generic flag here is worded for its leaf and
  // keeps its own key. The lists travel as {types}, {roles}, {schemes} and
  // {checks}. The English of `account map check --level` opens with the
  // kernel's retired-option marker, `retired: ` (RETIRED_OPTION_PREFIX), which
  // the tools read from `option.description`; each language writes its own
  // marker, so es.ts says `retirada: `. The English of `account map import
  // <file>` was Spanish prose on develop; the owner chose on #314 (15 Nov 2026)
  // to give the author-prose nodes real English, so it is the one English text
  // this task changes.
  'help.account.description': 'Chart of accounts: inspect, create and retire accounts',
  'help.account.list.description': 'List accounts, filtered by type, state, parent or free text',
  'help.account.list.argument.search': 'match against code or name',
  'help.account.list.option.type': 'account type: {types}',
  'help.entity.option.minimum_wage_zone': '{zones}: minimum-wage area of the workplace, which caps the seniority premium (LFT art. 486)',
  'help.account.list.option.parent': 'only children of this account code',
  'help.account.list.option.inactive': 'show inactive accounts instead of active ones',
  'help.account.show.description': 'Show one account with its parent, flags and lifetime activity',
  'help.account.show.argument.code': 'account code or id',
  'help.account.show.option.no_balance': 'skip the lifetime activity lookup',
  'help.account.create.description': 'Create an account',
  'help.account.create.argument.code': 'account code, unique within the entity',
  'help.account.create.argument.name': 'account name',
  'help.account.create.option.type': 'account type: {types}',
  'help.account.create.option.normal_balance': 'debit or credit (defaults from the type)',
  'help.account.create.option.parent': 'parent account code',
  'help.account.create.option.currency': 'restrict the account to one currency (3 letters)',
  'help.account.create.option.subtype': 'account subtype',
  'help.account.create.option.fs_category': 'financial-statement caption',
  'help.account.create.option.description': 'description',
  'help.account.create.option.header': 'a grouping node: it accepts no manual entries',
  'help.account.create.option.json': 'JSON output',
  /** The Examples of `account create` (MNE-001-229). The command lines are parameters: they are typed, not translated. `comment` is the `#` a message cannot carry. */
  'help.account.create.examples':
    '\nExamples:\n' +
    '  {comment} A new expense account hanging off Gastos de Administracion (6100).\n' +
    '  {expense}\n' +
    '  {comment} A grouping node: --header means it accepts no manual entries.\n' +
    '  {header}\n',
  'help.account.edit.description': 'Change an account name, description, subtype or statement caption',
  'help.account.edit.argument.code': 'account code or id',
  'help.account.edit.option.name': 'new name',
  'help.account.edit.option.description': 'new description',
  'help.account.edit.option.subtype': 'new subtype',
  'help.account.edit.option.fs_category': 'new financial-statement caption',
  'help.account.archive.description':
    'Retire an account from active use (never deletes; requires zero balance unless --force)',
  'help.account.archive.argument.code': 'account code or id',
  'help.account.archive.option.dry_run': 'run the checks and report, without writing',
  'help.account.set.description': 'Set the governance flags of an account (who may post to it, and how)',
  'help.account.set.argument.code': 'account code or id',
  'help.account.set.argument.pairs': 'key=value: allow-manual, header, control-account, require-subsidiary, currency',
  'help.account.set.option.dry_run': 'validate and report, without writing',
  'help.account.set.option.reason': 'why these flags change; recorded in the audit trail',
  'help.account.balance.description': 'Balances of one account, decomposed by fiscal period',
  'help.account.balance.show.description': 'Beginning, debits, credits and ending by period, with the period status',
  'help.account.balance.show.argument.code': 'account code or id',
  'help.account.balance.show.option.period': 'only this period: 2026-07, its id, or part of its name',
  'help.account.balance.show.option.as_of': 'only the period containing this date (YYYY-MM-DD)',
  'help.account.role.description':
    'Semantic account roles (cxc, banco, iva_acreditable…) that automatic posting reads',
  'help.account.role.list.description': 'Each role and the account it points to, default and qualified variants',
  'help.account.role.list.option.role': 'only this role',
  'help.account.role.list.option.qualifier': 'only this qualified variant',
  'help.account.role.set.description': 'Repoint a role to another account, or create a qualified variant',
  'help.account.role.set.argument.role': 'one of: {roles}… (see role list)',
  'help.account.role.set.argument.code': 'account code the role should point to',
  'help.account.role.set.option.qualifier': 'per-context variant (NULL = the default mapping)',
  'help.account.role.set.option.note': 'why this role points here',
  'help.account.role.set.option.dry_run': 'validate and report, without writing',
  'help.account.role.seed.description':
    'Create the missing base accounts and map every unmapped role (never overwrites a manual choice)',
  'help.account.map.description': 'Statutory mappings per account: SAT agrupador (Anexo 24), US tax line, IFRS',
  'help.account.map.set.description': 'Map the account to a statutory scheme value',
  'help.account.map.set.argument.code': 'account code or id',
  'help.account.map.set.option.scheme': 'scheme: {schemes}',
  'help.account.map.set.option.value': 'the code in that scheme; empty clears the mapping',
  'help.account.map.set.option.year': "fiscal year whose SAT catalog validates the code (default: today's)",
  'help.account.map.set.option.dry_run': 'validate and report, without writing',
  'help.account.map.list.description': 'Every active account with its statutory mappings',
  'help.account.map.list.option.scheme': 'project only this scheme',
  'help.account.map.import.description':
    'Bulk-load a statutory scheme from CSV — the heaviest setup task of a Mexican firm',
  'help.account.map.import.argument.file': 'CSV: code,value (one account per line; comma or semicolon separator)',
  'help.account.map.import.option.scheme': 'scheme: {schemes}',
  'help.account.map.import.option.dry_run': 'parse and resolve everything, write nothing',
  'help.account.map.import.option.idempotency_key':
    'replay-safe key: the same key with the same file returns the first result',
  'help.account.map.check.description':
    'Coverage gate before the Anexo 24 catalog XML: which accounts still lack a mapping',
  'help.account.map.check.option.check': 'named checks to run (available: coverage; empty lists them)',
  'help.account.map.check.option.scheme': 'scheme to verify',
  'help.account.map.check.option.level': 'retired: the gate no longer measures by account level',
  'help.account.restore.description': 'Put a retired account back in service',
  'help.account.restore.argument.code': 'account code or id',
  'help.account.restore.option.reason': 'why the account comes back into service; recorded in the audit trail',
  'help.ledger.description': 'The general ledger itself: integrity checks, stale drafts, auxiliaries and balances',
  'help.ledger.check.description': 'Named ledger checks; with no flag runs the blocking ones and exits 4 on findings',
  'help.ledger.check.option.check': 'checks to run, comma-separated (available: {checks}; empty lists them)',
  'help.ledger.check.option.account': 'scope the balance check to one account',
  'help.ledger.check.option.period':
    'scope the balance check to one fiscal period: 2026-07, its id, or part of its name',
  'help.ledger.stale_draft.description': 'Draft journal entries that have sat unposted too long',
  'help.ledger.stale_draft.list.description':
    'Drafts older than N days — the number-one blocker of every close checklist',
  'help.ledger.stale_draft.list.option.days': 'minimum age in days',
  'help.ledger.stale_draft.list.option.period':
    'only drafts dated into this fiscal period: 2026-07, its id, or part of its name',
  'help.ledger.auxiliary.description': 'Account auxiliary: beginning balance, movements, ending — the SAT XC shape',
  'help.ledger.auxiliary.show.description': 'One account, one period: beginning → every movement → ending',
  'help.ledger.auxiliary.show.option.account': 'account code',
  'help.ledger.auxiliary.show.option.period': 'fiscal period: 2026-07, its id, or an unambiguous part of its name',
  'help.ledger.balance.description': 'One account balance decomposed by period, with the period status',
  'help.ledger.balance.show.description': 'Beginning, debits, credits and ending per period for one account',
  'help.ledger.balance.show.option.account': 'account code or id',
  'help.ledger.balance.show.option.as_of': 'only the period containing this date (YYYY-MM-DD)',
  'help.ledger.balance.show.option.period': 'only this period: 2026-07, its id, or part of its name',
  'help.ledger.balance.show.option.dim':
    'per-dimension breakdown (not available: the dimension family does not exist yet)',
  // ==== MNE-001-241 · help by key, employee, garnishment, isn and payroll (issue #314) ====
  //
  // The payroll task: the four families whole, roots included, English as
  // shown (`tax-deposit` shares payroll-isn-command.ts but is MNE-001-239's).
  // Every generic flag a leaf declares keeps a key of its own: the three
  // --dry-run say what each rehearsal shows, `isn rate set` declares its -y
  // before declareRisk, and `isn rate list` declares -n, --offset and -a by
  // hand, with its own parser, instead of withSelection.
  'help.employee.description': 'The payroll roll: register an employee, see one record, list the roll',
  'help.employee.create.description': 'Register one employee from a JSON file with their tax identifiers',
  'help.employee.create.option.file': 'JSON object with the employee record (required)',
  'help.employee.create.option.country': 'the country whose payroll applies; overrides the file',
  'help.employee.create.option.hire_date': 'hire date (YYYY-MM-DD); overrides the file',
  'help.employee.create.option.pay_schedule': 'a pay schedule of this entity; overrides the file',
  'help.employee.create.option.dry_run': 'run the real writer and roll it back: nothing is saved',
  'help.employee.show.description': 'Show one employee record with tax identifiers masked',
  'help.employee.show.argument.employee': 'employee number or id',
  'help.employee.show.option.redacted': 'hide identifiers, e-mail and phone entirely, for a shared screen',
  'help.employee.list.description': 'List the employees of the entity, active by default, with no tax identifiers',
  'help.employee.list.option.country': 'only employees of this country',
  'help.garnishment.description': 'Court-ordered wage withholding: file an order, see the cascade, stop it',
  'help.garnishment.record.description':
    'File a court order already dictated, with its basis, its authority and its caps',
  'help.garnishment.record.argument.employee': 'employee number or id the order is against',
  'help.garnishment.record.option.type': 'the order type, in the vocabulary the column stores',
  'help.garnishment.record.option.amount': 'a fixed amount per period',
  'help.garnishment.record.option.percent_disposable':
    'a percentage of DISPOSABLE earnings (gross minus employee taxes)',
  'help.garnishment.record.option.percent_gross':
    'a percentage of GROSS wages — different money from --percent-disposable',
  'help.garnishment.record.option.priority': 'tie-breaker WITHIN a statutory rank; it does not decide the rank',
  'help.garnishment.record.option.case': 'the court file number, unique per worker while the order is live',
  'help.garnishment.record.option.court': 'the authority that issued the order (required)',
  'help.garnishment.record.option.payee': 'who the withholding is remitted to',
  'help.garnishment.record.option.start':
    'the date the order bears (YYYY-MM-DD); withholding starts when it is ACTIVE',
  'help.garnishment.record.option.exempt_amount':
    'IRS Pub 1494 exempt amount; required on a tax levy, read by nothing else',
  'help.garnishment.record.option.supports_second_family':
    'does this worker support another family? decides a 50 % or 60 % CCPA cap — no default',
  'help.garnishment.record.option.arrears_12wk':
    'are arrears more than twelve weeks old? adds five points to the cap — no default',
  'help.garnishment.record.option.dry_run':
    'run the real path and undo it: shows the order and the cascade it would join',
  'help.garnishment.list.description':
    'List orders in the sequence money is taken: statutory rank, then priority, then date',
  'help.garnishment.list.argument.employee': 'narrow to one worker, by employee number or id',
  'help.garnishment.list.option.type': 'only orders of this type',
  'help.garnishment.archive.description':
    'Stop the withholding by clearing is_active, keeping the order and its history',
  'help.garnishment.archive.argument.id': 'the order id, as `garnishment list` prints it',
  'help.garnishment.archive.option.as_of':
    'the date the order ceased (YYYY-MM-DD), recorded in end_date alongside the halt',
  'help.isn.description':
    'Mexican state payroll tax: capture the state rates with their grounds, and see what a pay run owes',
  'help.isn.rate.description': 'State ISN rates, by state and by vigencia',
  'help.isn.rate.set.description': 'Capture one state rate with its vigencia and the law behind it',
  'help.isn.rate.set.argument.state': 'SAT c_Estado key, as it is written on your workers (JAL, NLE)',
  'help.isn.rate.set.argument.rate': 'the rate, as a fraction (0.03) or a percentage (3%)',
  'help.isn.rate.set.option.effective_from': 'first day this rate applies (YYYY-MM-DD)',
  'help.isn.rate.set.option.superseded_on':
    'day the next rate takes over and this one stops applying (YYYY-MM-DD); omit while it is the current one',
  'help.isn.rate.set.option.legal_basis': 'the law and article the rate comes from (required)',
  'help.isn.rate.set.option.regime': 'how the state charges it; the engine only computes tasa_plana',
  'help.isn.rate.set.option.exemption': 'monthly amount exempted; only with --regime con_exencion',
  'help.isn.rate.set.option.dry_run': 'show exactly what would be written, and who it reaches; write nothing',
  'help.isn.rate.set.option.yes': 'skip the confirmation prompt',
  'help.isn.rate.list.description': 'The captured state rates, with the one in force on a given date marked',
  'help.isn.rate.list.option.limit': 'maximum rows to return',
  'help.isn.rate.list.option.offset': 'skip this many rows',
  'help.isn.rate.list.option.all': 'every vigencia ever captured, not only the one in force',
  'help.isn.rate.list.option.state': 'only this state (SAT c_Estado key)',
  'help.isn.rate.list.option.as_of': 'which rate was in force on this date (YYYY-MM-DD; default today)',
  'help.isn.calculate.description':
    "One pay run's ISN, one row per state, naming every rate that is missing instead of computing zero",
  'help.isn.calculate.option.run': 'the pay run to compute (required)',
  'help.isn.calculate.option.state': 'narrow the rows to one state; findings are never hidden',
  'help.payroll.description': 'Payroll accounting: the benefit liability that is born on the day worked',
  'help.payroll.accrue.description':
    'Post the month benefit accrual -- aguinaldo, vacation and vacation premium, one adjusting entry, irreversible',
  'help.payroll.accrue.option.period': 'period to accrue: 2026-03, or any unambiguous part of its name',
  // ==== MNE-001-231 · help by key, bank account, statement and transaction (issue #314) ====
  //
  // Same format as `period`. The bank family is keyed by subcommand group in
  // three tasks (231 to 233); this one takes the root and these three groups,
  // with the English these commands already showed. Every generic flag here is
  // worded for its leaf and keeps its own key, except `bank account edit -y`,
  // which already said what cli.flag.yes says. The check names travel as {checks}.
  'help.bank.description': 'Bank accounts and bank statements: master data and imported statements',
  'help.bank.account.description': 'Bank accounts as master data: identifiers, currency and the 1:1 GL mapping',
  'help.bank.account.create.description':
    'Register a bank account, validating the CLABE check digit, the ABA routing checksum, ' +
    'the currency against the GL account and the 1:1 mapping',
  'help.bank.account.create.argument.name': 'name this account is known by inside the books',
  'help.bank.account.create.option.bank': 'name of the institution',
  'help.bank.account.create.option.gl_account': 'GL account this bank account maps to, 1:1 (code or id)',
  'help.bank.account.create.option.currency': '3-letter ISO code; must equal the GL account currency',
  'help.bank.account.create.option.type':
    'account nature; credit-card is a LIABILITY and maps to a liability GL account',
  'help.bank.account.create.option.clabe': 'CLABE; stored encrypted, only the last 4 are ever shown',
  'help.bank.account.create.option.account_number': 'account number; stored encrypted',
  'help.bank.account.create.option.routing_ach': 'ABA routing number for ACH',
  'help.bank.account.create.option.routing_wire': 'ABA routing number for wires',
  'help.bank.account.create.option.sat_bank_code': 'SAT c_Banco key; derived from the CLABE when omitted',
  'help.bank.account.create.option.branch': 'branch',
  'help.bank.account.create.option.swift': 'SWIFT/BIC',
  'help.bank.account.create.option.iban': 'IBAN',
  'help.bank.account.create.option.foreign_bank':
    'the bank is not resident in Mexico: vouchers declare c_Banco 999 and the bank name; requires --reason, ' +
    'and no --sat-bank-code or --clabe',
  'help.bank.account.create.option.reason': 'justification recorded in the audit trail; required with --foreign-bank',
  'help.bank.account.create.option.dry_run': 'run every validation and the insert, then roll it back',
  'help.bank.account.create.option.json': 'JSON output',
  'help.bank.account.list.description':
    'List the accounts with currency, type, GL account, book balance and the last approved reconciliation',
  'help.bank.account.list.argument.query': 'match against the account name or the bank name',
  'help.bank.account.list.option.type': 'only accounts of this nature',
  'help.bank.account.list.option.currency': 'only accounts in this currency',
  'help.bank.account.list.option.all_entities':
    "every entity of the tenant, for a firm's overview; still bounded inside the SQL",
  'help.bank.account.show.description':
    'Show one account: masked identifiers, SAT bank key, book vs bank balance and the reconciliation anchor',
  'help.bank.account.show.argument.account': 'account name or id',
  'help.bank.account.show.option.redacted': 'drop even the last 4 digits of the identifiers, for a shared screen',
  'help.bank.account.edit.description': 'Change master data, recording the before and after field by field',
  'help.bank.account.edit.argument.account': 'account name or id',
  'help.bank.account.edit.option.name': 'new account name',
  'help.bank.account.edit.option.bank': 'new institution name',
  'help.bank.account.edit.option.branch': 'branch; empty clears it',
  'help.bank.account.edit.option.type': 'account nature',
  'help.bank.account.edit.option.currency': 'currency; re-checked against the GL account',
  'help.bank.account.edit.option.clabe': 'CLABE; requires --reason. Empty clears it',
  'help.bank.account.edit.option.account_number': 'account number; requires --reason. Empty clears it',
  'help.bank.account.edit.option.routing_ach': 'ABA routing for ACH; requires --reason. Empty clears it',
  'help.bank.account.edit.option.routing_wire': 'ABA routing for wires; requires --reason. Empty clears it',
  'help.bank.account.edit.option.sat_bank_code': 'SAT c_Banco key; empty clears it',
  'help.bank.account.edit.option.swift': 'SWIFT/BIC; empty clears it',
  'help.bank.account.edit.option.iban': 'IBAN; empty clears it',
  'help.bank.account.edit.option.foreign_bank':
    'the bank is not resident in Mexico: vouchers declare c_Banco 999 and the bank name; requires --reason',
  'help.bank.account.edit.option.no_foreign_bank': 'remove the foreign-bank mark; requires --reason',
  'help.bank.account.edit.option.reason':
    'justification recorded in the audit trail; required for identifiers and the foreign-bank mark',
  'help.bank.account.edit.option.dry_run': 'apply the change and roll it back, showing what would differ',
  'help.bank.account.edit.option.json': 'JSON output',
  'help.bank.account.set.description':
    'Write the 1:1 GL mapping, refusing the change when the old account has posted entries',
  'help.bank.account.set.argument.account': 'account name or id',
  'help.bank.account.set.option.gl_account': 'GL account to map to (code or id)',
  'help.bank.account.set.option.reason': 'justification recorded in the audit trail; required by --force',
  'help.bank.account.set.option.dry_run': 'apply the remap and roll it back',
  'help.bank.account.set.option.json': 'JSON output',
  'help.bank.statement.description': 'Bank statements as documents: import, inspect and check their integrity',
  'help.bank.statement.import.description':
    'Parse, normalize and stage a bank statement, deduplicating by native id or content hash; ' +
    'posts NOTHING to the ledger',
  'help.bank.statement.import.argument.file': 'statement files; combine with --dir to take a whole folder',
  'help.bank.statement.import.option.account': 'bank account these statements belong to (name or id)',
  'help.bank.statement.import.option.format':
    'format of the FILE (not of the output; use --json for that); sniffed from the content when omitted',
  'help.bank.statement.import.option.profile': 'CSV column profile to read the file with',
  'help.bank.statement.import.option.dir': 'import every file in this folder as well',
  'help.bank.statement.import.option.closing_balance':
    'closing balance you assert, for a format that carries none (a CSV); refused if the file says otherwise',
  'help.bank.statement.import.option.dry_run': 'parse, run the seven checks and roll the write back',
  'help.bank.statement.import.option.json': 'JSON output',
  'help.bank.statement.list.description':
    'List imported statements by account and period, with opening and closing balance, line count and the balance chain',
  'help.bank.statement.list.option.account': 'only this bank account (name or id)',
  'help.bank.statement.list.option.since': 'statements whose period ENDS on or after this date (YYYY-MM-DD)',
  'help.bank.statement.list.option.until': 'statements whose period STARTS on or before this date (YYYY-MM-DD)',
  'help.bank.statement.show.description':
    'Show one statement: electronic sequence number, date range, hash of the original file and the profile applied',
  'help.bank.statement.show.argument.id': 'statement id',
  'help.bank.statement.show.option.lines': 'include the statement lines',
  'help.bank.statement.show.option.limit': 'maximum lines to list with --lines (default 500)',
  'help.bank.statement.check.description': 'Run the seven integrity checks and EXIT 4 naming which one broke',
  'help.bank.statement.check.argument.id': 'one statement; without it, the latest of each account',
  'help.bank.statement.check.option.check': 'comma-separated checks to run; bare --check lists them ({checks})',
  'help.bank.statement.check.option.all': 'every statement of the entity, not just the latest per account',
  'help.bank.statement.check.option.account': 'every statement of this bank account (name or id)',
  'help.bank.statement.check.option.since':
    'only statements whose period ends on or after this date (YYYY-MM-DD)',
  'help.bank.transaction.description': 'Bank transactions: what the bank says happened, before anyone explains it',
  'help.bank.transaction.list.description':
    'List bank transactions filtered by account, date range, direction, amount, text, type and match state',
  'help.bank.transaction.list.argument.query':
    'hledger-style terms: desc:<text>, amt:[>|<|>=|<=]<amount>; a bare word means desc:',
  'help.bank.transaction.list.option.account': 'only this bank account (name or id)',
  'help.bank.transaction.list.option.since': 'transactions on or after this date (YYYY-MM-DD)',
  'help.bank.transaction.list.option.until': 'transactions on or before this date (YYYY-MM-DD)',
  'help.bank.transaction.list.option.unmatched': 'only transactions with no live match; shorthand for -s unmatched',
  'help.bank.transaction.list.option.direction': 'money in (positive amount) or out (negative amount)',
  'help.bank.transaction.list.option.type': 'transaction nature as the bank classified it (not its direction)',
  'help.bank.transaction.show.description':
    'Show one transaction: the normalized line, the statement it came from and the live matches that explain it',
  'help.bank.transaction.show.argument.id': 'transaction id',
  'help.bank.transaction.show.option.raw':
    'include raw_data exactly as the bank published it; it can carry the counterparty in the clear',
  'help.bank.transaction.reclassify.description':
    'Correct what kind of line a bank transaction is (fee, interest, debit, credit, adjustment); ' +
    'refused when the sign disagrees, the line is matched, or a treasury entry already posted it',
  'help.bank.transaction.reclassify.argument.id': 'transaction id',
  'help.bank.transaction.reclassify.option.type': 'what the line really is',
  'help.bank.transaction.reclassify.option.reason': 'justification recorded in the audit trail',
  'help.bank.transaction.reclassify.option.dry_run': 'run every check and write nothing',
  'help.bank.transaction.reclassify.option.json': 'JSON output',
  // ==== MNE-001-232 · help by key, bank match, fee, interest, check and book-item (issue #314) ====
  //
  // The second of the three bank tasks: these five groups, with the English
  // they already showed. Every generic flag a leaf declares here is worded for
  // that leaf and keeps its own key; what declareRisk injects stays on
  // cli.flag.*. The matchable types travel as {types}, the unapply codes as {codes}.
  'help.bank.book_item.description':
    'The other side: posted journal lines against the bank GL account, still unsealed',
  'help.bank.book_item.list.description':
    'List posted journal lines against the bank GL account that are still unsealed, oldest first, with their age',
  'help.bank.book_item.list.argument.account':
    'bank account whose GL account the entries were posted to (name or id)',
  'help.bank.book_item.list.option.since': 'entries on or after this entry date (YYYY-MM-DD)',
  'help.bank.book_item.list.option.until': 'entries on or before this entry date (YYYY-MM-DD)',
  'help.bank.book_item.list.option.over_days':
    'only what has gone MORE than this many days without showing up at the bank',
  'help.bank.match.description': 'Matching a bank transaction to what the books already say about it',
  'help.bank.match.preview.description':
    'Show what the engine would propose, with the score broken into its signals and every gate’s verdict, ' +
    'WITHOUT applying anything',
  'help.bank.match.preview.argument.tx_id': 'one transaction; without it, every unmatched one of --account',
  'help.bank.match.preview.option.account': 'bank account to sweep when no transaction id is given',
  'help.bank.match.preview.option.since': 'transactions on or after this date (YYYY-MM-DD)',
  'help.bank.match.preview.option.until': 'transactions on or before this date (YYYY-MM-DD)',
  'help.bank.match.preview.option.top': 'maximum TRANSACTIONS to preview (not candidates per transaction)',
  'help.bank.match.preview.option.min_confidence':
    'raise the engine confidence a proposal needs before `run` would apply it (0..1); ' +
    'never below the panel (cotejo_umbral_confianza)',
  'help.bank.match.preview.option.max_amount':
    'lower the ceiling for an automatic match; the panel (cotejo_monto_maximo_auto) and the hard floor still win',
  'help.bank.match.preview.option.rules_only': 'a proposal outside the date window counts as not applicable',
  'help.bank.match.run.description':
    'Run the engine over one account and period, applying ONLY what clears the confidence threshold, ' +
    'the amount floor, an open period and an exact-amount hard signal',
  'help.bank.match.run.option.account': 'bank account to sweep (name or id)',
  'help.bank.match.run.option.since': 'transactions on or after this date (YYYY-MM-DD)',
  'help.bank.match.run.option.until': 'transactions on or before this date (YYYY-MM-DD)',
  'help.bank.match.run.option.min_confidence':
    'raise the engine confidence a proposal needs to be applied (0..1); ' +
    'never below the panel (cotejo_umbral_confianza)',
  'help.bank.match.run.option.max_amount':
    'lower the ceiling for an automatic match; the panel (cotejo_monto_maximo_auto) and the hard floor still win',
  'help.bank.match.run.option.rules_only': 'refuse a proposal outside the date window',
  'help.bank.match.run.option.top': 'maximum transactions to evaluate in this run',
  'help.bank.match.run.option.session': 'reconciliation session these matches belong to',
  'help.bank.match.run.option.dry_run': 'do the whole thing and roll it back',
  'help.bank.match.run.option.json': 'JSON output',
  'help.bank.match.apply.description':
    'Apply the engine’s proposal for the named transactions in ONE transaction, idempotently, ' +
    'linked to the session',
  'help.bank.match.apply.argument.id': 'bank transaction ids; or feed them through --stdin',
  'help.bank.match.apply.option.stdin': 'read the ids from standard input, whitespace separated',
  'help.bank.match.apply.option.session': 'reconciliation session these matches belong to',
  'help.bank.match.apply.option.dry_run': 'do the whole thing and roll it back',
  'help.bank.match.apply.option.yes': 'skip the grouped confirmation',
  'help.bank.match.apply.option.json': 'JSON output',
  'help.bank.match.create.description':
    'Build an explicit match group of N bank transactions against M book items plus adjustments, ' +
    'requiring Σbank = Σbooks + Σadjustments',
  'help.bank.match.create.option.account': 'bank account the whole group belongs to (name or id)',
  'help.bank.match.create.option.transaction': 'comma-separated bank transaction ids: the bank side',
  'help.bank.match.create.option.book_item':
    'comma-separated book side: <id> for a journal line, or <type>:<id> ({types})',
  'help.bank.match.create.option.adjust': 'declared adjustment (bank fee, FX difference); repeatable',
  'help.bank.match.create.option.residual':
    'what happens to what is left over: keep it live, or write it off against an account',
  'help.bank.match.create.option.write_off_account': 'GL account the residual is written off against',
  'help.bank.match.create.option.session': 'reconciliation session this group belongs to',
  'help.bank.match.create.option.dry_run': 'do the whole thing and roll it back',
  'help.bank.match.create.option.json': 'JSON output',
  'help.bank.match.unapply.description':
    'Undo a match with a typed reason, releasing the book-item seal; refuses if the session is ' +
    'already approved or posted, and touches no posted journal entry',
  'help.bank.match.unapply.argument.match_id': 'the match to undo; its whole group goes with it',
  'help.bank.match.unapply.option.reason': 'typed reason, required: {codes}',
  'help.bank.match.unapply.option.dry_run': 'do the whole thing and roll it back',
  'help.bank.match.unapply.option.yes': 'skip the confirmation',
  'help.bank.match.unapply.option.json': 'JSON output',
  'help.bank.fee.description':
    'Bank fees as an accounting act: the charge as an expense and its VAT moved to ' +
    'creditable in the month of the charge',
  'help.bank.fee.post.description':
    'Post the period’s bank fees from the statement, one entry per charge, and move their VAT ' +
    'from pending-creditable to creditable',
  'help.bank.fee.post.argument.account': 'bank account whose fees to post (name or id)',
  'help.bank.fee.post.option.period': 'month whose fees to post',
  'help.bank.fee.post.option.iva_rate':
    'VAT rate the charge already carries INSIDE it, as a fraction (0.16 for 16%); 0 for an ' +
    'exempt fee. No default: a default here is a tax decision nobody takes and nobody sees',
  'help.bank.fee.post.option.max_amount':
    'above this magnitude the charge is skipped and left for human eyes; it is a confidence ' +
    'gate, not a validation',
  'help.bank.fee.post.option.json': 'JSON output',
  'help.bank.interest.description':
    'Interest earned on bank balances: income at its GROSS amount and the tax the bank withheld ' +
    'as a prepayment in the entity’s favour',
  'help.bank.interest.post.description':
    'Post the period’s interest as income and the ISR the bank withheld as a provisional ' +
    'payment in the entity’s favour, never as an expense',
  'help.bank.interest.post.argument.account': 'bank account whose interest to post (name or id)',
  'help.bank.interest.post.option.period': 'month whose interest to post',
  'help.bank.interest.post.option.rate':
    'ISR WITHHOLDING rate the bank applied, as a fraction (0.0125 for 1.25%); 0 when it ' +
    'withheld nothing. This is NOT the interest rate: the interest is what the statement says',
  'help.bank.interest.post.option.json': 'JSON output',
  'help.bank.check.description':
    'Paper checks as a fiscal fact: when the bank actually paid one, which under the VAT law ' +
    'is when the payment counts',
  'help.bank.check.reconcile.description':
    'Prove the check against the bank movement that cleared it and post its VAT IN THE MONTH IT CLEARED: ' +
    'from pending to creditable for a vendor payment, from pending collection to charged for a customer receipt',
  'help.bank.check.reconcile.argument.id': 'vendor payment made by check; omit it with --receipt',
  'help.bank.check.reconcile.option.receipt':
    'customer receipt paid by cheque, by number (PMT-2026-00042) or id, instead of <id>; without ' +
    '--transaction the credit of its amount is searched in its bank account from its date. Repeat it for ' +
    'a deposit of several cheques: one credit of their exact sum, named with --transaction',
  'help.bank.check.reconcile.option.transaction':
    'the bank movement that paid it, named by hand; required when several charges match',
  'help.bank.check.reconcile.option.as_of':
    'the clearing date you assert (YYYY-MM-DD); it is CONTRASTED against the movement, never ' +
    'imposed — the bank dates the clearing',
  'help.bank.check.reconcile.option.json': 'JSON output',
  // ==== MNE-001-233 · help by key, bank reconciliation, reconciling-item and adjustment (issue #314) ====
  //
  // The last of the three bank tasks: these three groups, with the English
  // they already showed, so no bank help is left without a key. Every generic
  // flag a leaf declares is worded for it and keeps its own key; what the kernel
  // injects stays on cli.flag.*. The lists travel as the house's messages name
  // them: item types {types}, escalation states {values}, unseeded types {types}.
  'help.bank.reconciliation.description':
    'The reconciliation session: the two-sided arithmetic that makes `balanced` mean something',
  'help.bank.reconciliation.run.description':
    'Guided monthly pass over one account: statement, matching engine, session and reconciling ' +
    'items; it ALWAYS stops before approve and post, and prints what is missing',
  'help.bank.reconciliation.run.argument.account': 'bank account to reconcile (name or id)',
  'help.bank.reconciliation.run.option.period': 'period to reconcile; or give --since and --until together',
  'help.bank.reconciliation.run.option.since': 'first day of the period (YYYY-MM-DD)',
  'help.bank.reconciliation.run.option.until': 'last day of the period (YYYY-MM-DD)',
  'help.bank.reconciliation.run.option.file':
    'statement to import first; without it, the one already imported for the period is used',
  'help.bank.reconciliation.run.option.format':
    'format of the FILE given in --file (not of the output; use --json for that), as in `bank statement import`',
  'help.bank.reconciliation.run.option.profile': 'CSV column profile to read --file with',
  'help.bank.reconciliation.run.option.min_confidence':
    'raise the engine confidence a proposal needs to be applied (0..1); ' +
    'never below the panel (cotejo_umbral_confianza)',
  'help.bank.reconciliation.run.option.max_amount':
    'lower the ceiling for an automatic match; the panel (cotejo_monto_maximo_auto) and the hard floor still win',
  'help.bank.reconciliation.run.option.stop_at':
    'stop after this step; it never goes past `estado`, and never reaches approve or post',
  'help.bank.reconciliation.run.option.resume':
    'continue the session already open for this period instead of refusing',
  'help.bank.reconciliation.run.option.dry_run': 'walk the real path and roll it back',
  'help.bank.reconciliation.run.option.json': 'JSON output',
  'help.bank.reconciliation.open.description':
    'Open the period session, asserting the opening balance equals the previous session closing ' +
    'and refusing date gaps and overlaps',
  'help.bank.reconciliation.open.argument.account': 'bank account to open the session on (name or id)',
  'help.bank.reconciliation.open.option.period': 'period of the session; or give --since and --until together',
  'help.bank.reconciliation.open.option.since': 'first day of the period (YYYY-MM-DD)',
  'help.bank.reconciliation.open.option.until': 'last day of the period (YYYY-MM-DD)',
  'help.bank.reconciliation.open.option.closing_balance':
    'closing balance you assert; it is COMPARED against the statement, never substituted for it',
  'help.bank.reconciliation.open.option.statement':
    'the statement to tie the session to, when the period has more than one',
  'help.bank.reconciliation.open.option.baseline':
    'first session only: the reconciled balance the account starts from; ' +
    'refused unless it equals the books at --baseline-date',
  'help.bank.reconciliation.open.option.baseline_date':
    'date of --baseline (YYYY-MM-DD); by default the day before the period',
  'help.bank.reconciliation.open.option.dry_run': 'do the whole thing and roll it back',
  'help.bank.reconciliation.open.option.json': 'JSON output',
  'help.bank.reconciliation.list.description':
    'List sessions by account, state and period, with the FROZEN variance and how many items are still open',
  'help.bank.reconciliation.list.option.account': 'only sessions of this bank account (name or id)',
  'help.bank.reconciliation.list.option.period': 'sessions that overlap this period',
  'help.bank.reconciliation.list.option.since': 'sessions ending on or after this date (YYYY-MM-DD)',
  'help.bank.reconciliation.list.option.until': 'sessions starting on or before this date (YYYY-MM-DD)',
  'help.bank.reconciliation.list.option.all_entities':
    "every entity of the tenant, for a firm's overview; still bounded inside the SQL",
  'help.bank.reconciliation.status.description':
    'Recompute the variance LIVE and print the two-sided breakdown: bank balance, its items one ' +
    'by one, adjusted; books balance, its items, adjusted; and the difference',
  'help.bank.reconciliation.status.argument.session': 'session id; without it, the one in progress for --account',
  'help.bank.reconciliation.status.option.account': 'bank account whose in-progress session to read (name or id)',
  'help.bank.reconciliation.status.option.tolerance':
    'residual the close may absorb; only valid where the tolerance policy admits one',
  'help.bank.reconciliation.close.description':
    'Recompute the whole arithmetic and move the session to `balanced` ONLY if the variance is ' +
    'exactly zero (or within the policy tolerance) and every item is classified and dated',
  'help.bank.reconciliation.close.argument.session': 'session to close',
  'help.bank.reconciliation.close.option.tolerance':
    'residual this close may absorb; refused unless the tolerance policy admits one',
  'help.bank.reconciliation.close.option.dry_run': 'do the whole thing and roll it back',
  'help.bank.reconciliation.close.option.yes': 'skip the confirmation',
  'help.bank.reconciliation.close.option.json': 'JSON output',
  'help.bank.reconciliation.approve.description':
    'Sign the session, requiring that the approver is not the preparer, and freeze an immutable ' +
    'snapshot with a hash of its members and its balances',
  'help.bank.reconciliation.approve.argument.session': 'balanced session to sign',
  'help.bank.reconciliation.approve.option.reason':
    'why it is being signed; stored on the session and in the audit trail',
  'help.bank.reconciliation.approve.option.json': 'JSON output',
  'help.bank.reconciliation.reopen.description':
    'Reopen an approved or posted session to in_progress, withdrawing its signature (kept in ' +
    'the audit trail) and reversing the entries a post booked; refused under a closed ' +
    'fiscal period',
  'help.bank.reconciliation.reopen.argument.session': 'approved or posted session to reopen',
  'help.bank.reconciliation.reopen.option.json': 'JSON output',
  'help.bank.reconciliation.post.description':
    'Post the approved adjustment entries and seal the session’s book lines as reconciled, ' +
    'blocking their edit, their void and their date change',
  'help.bank.reconciliation.post.argument.session': 'approved session to post',
  'help.bank.reconciliation.post.option.json': 'JSON output',
  'help.bank.reconciliation.generate.description':
    'Produce the two-sided bank reconciliation statement for the audit file: json for the whole ' +
    'document, md/csv/tsv for the line-by-line statement, plain text to print',
  'help.bank.reconciliation.generate.argument.session': 'session to write the statement for',
  'help.bank.reconciling_item.description':
    'Reconciling items as rows: what explains the difference, with age, owner, due date and escalation',
  'help.bank.reconciling_item.list.description':
    'List the typed reconciling items of a session — outstanding checks, deposits in transit, ' +
    'bank charges, errors — with age, owner, expected settlement date and escalation',
  'help.bank.reconciling_item.list.argument.session': 'reconciliation session id',
  'help.bank.reconciling_item.list.option.type': 'only items of this type: {types}',
  'help.bank.reconciling_item.list.option.over_days':
    'only what has gone MORE than this many days since its date',
  'help.bank.reconciling_item.assign.description':
    'Give a reconciling item an owner, an expected settlement date and notes',
  'help.bank.reconciling_item.assign.argument.session': 'reconciliation session id',
  'help.bank.reconciling_item.assign.argument.item': 'reconciling item id',
  'help.bank.reconciling_item.assign.option.owner': 'who is chasing this item',
  'help.bank.reconciling_item.assign.option.expected': 'expected settlement date (YYYY-MM-DD)',
  'help.bank.reconciling_item.assign.option.clear_expected': 'remove the expected date instead of setting one',
  'help.bank.reconciling_item.assign.option.escalation': 'escalation state: {values}',
  'help.bank.reconciling_item.assign.option.note': 'note stored with the item',
  'help.bank.reconciling_item.assign.option.json': 'JSON output',
  'help.bank.reconciling_item.correct.description':
    'Say what a reconciling item really was, when the automatic proposal got it wrong',
  'help.bank.reconciling_item.correct.argument.session': 'reconciliation session id',
  'help.bank.reconciling_item.correct.argument.item': 'reconciling item id',
  'help.bank.reconciling_item.correct.option.type': 'what it really is: {types}',
  'help.bank.reconciling_item.correct.option.amount':
    'its new contribution to the reconciliation; required when the type changes side',
  'help.bank.reconciling_item.correct.option.json': 'JSON output',
  'help.bank.adjustment.description':
    'The fees, VAT, interest and withholdings a reconciliation uncovers, created as DRAFTS',
  'help.bank.adjustment.create.description':
    'Create the fee, VAT, interest, ISR withholding or error correction found in the session AS A ' +
    'DRAFT waiting for `mnemosine review`; it never posts anything itself',
  'help.bank.adjustment.create.argument.session': 'reconciliation session the adjustment belongs to',
  'help.bank.adjustment.create.option.type': 'what the adjustment is',
  'help.bank.adjustment.create.option.amount':
    'SIGNED by its effect on the bank account: negative leaves the account, positive enters it',
  'help.bank.adjustment.create.option.gl_account':
    'counterparty GL account; required for the types whose accounting role is not seeded yet ({types})',
  'help.bank.adjustment.create.option.item': 'the reconciling item this adjustment explains',
  'help.bank.adjustment.create.option.json': 'JSON output',
  // ==== MNE-001-236 · help by key, invoice and customer (issue #314) ====
  //
  // The first of the two receivables tasks: these two families whole, their
  // roots included, with the English they already showed. Every generic flag
  // a leaf declares is worded for it and keeps its own key; what the kernel
  // injects stays on cli.flag.*. The tax id types travel as {types}, and the
  // RFC mask as {shape}: the catalog check reads a literal # as an unfilled
  // plural count.
  'help.invoice.description': 'Customer invoices: draft, inspect, issue to the ledger and void (never stamped here)',
  'help.invoice.list.description': 'List invoices by customer, state, period or days past due',
  'help.invoice.list.argument.search': 'text to match in the invoice number or the customer name',
  'help.invoice.list.option.customer': 'only this customer (number, name or id)',
  'help.invoice.list.option.overdue_days': 'only open invoices at least this many days past due',
  'help.invoice.show.description': 'Show one invoice with its lines, the cash applied and its ledger entry',
  'help.invoice.show.argument.ref': 'invoice number (INV-2026-00042) or id',
  'help.invoice.create.description':
    'Create a DRAFT invoice from scratch: a local document, neither posted nor stamped',
  'help.invoice.create.option.customer': 'customer number, name or id',
  'help.invoice.create.option.line':
    'a line: "account=4100;qty=2;price=1500;tax-rate=16;description=…". tax-rate= is a RATE in % (16 means 16%), ' +
    'not an amount. See the key list below',
  'help.invoice.create.option.from_file': 'JSON array of lines instead of repeated --line',
  'help.invoice.create.option.date': 'invoice date (YYYY-MM-DD); defaults to today',
  'help.invoice.create.option.due_date': "due date; defaults to the customer's payment terms",
  'help.invoice.create.option.currency': "billing currency; defaults to the customer's",
  'help.invoice.create.option.terms': 'payment terms printed on the document',
  'help.invoice.create.option.memo': 'memo',
  'help.invoice.create.option.po_number': 'the customer purchase order this bills against',
  'help.invoice.create.option.json': 'JSON output',
  'help.invoice.issue.description':
    'Issue an invoice: post DR receivable / CR revenue / CR VAT. Does not stamp or send',
  'help.invoice.issue.argument.ref': 'invoice number or id',
  'help.invoice.issue.option.json': 'JSON output',
  'help.invoice.void.description':
    'Void a local invoice and reverse its ledger entry; refuses a stamped or paid one',
  'help.invoice.void.argument.ref': 'invoice number or id',
  'help.invoice.void.option.json': 'JSON output',
  'help.invoice.edit.description':
    'Edit a DRAFT invoice: dates, memo or its lines (issued ones are voided or credited, never edited)',
  'help.invoice.edit.argument.ref': 'invoice number or id',
  'help.invoice.edit.option.line':
    'REPLACE all lines: "account=4100;qty=2;price=1500;tax-rate=16;…" (repeatable). Key list in invoice create --help',
  'help.invoice.edit.option.from_file': 'JSON array of lines instead of repeated --line',
  'help.invoice.edit.option.date': 'new invoice date (YYYY-MM-DD)',
  'help.invoice.edit.option.due_date': 'new due date',
  'help.invoice.edit.option.memo': 'new memo',
  'help.invoice.edit.option.po_number': 'new purchase order reference',
  'help.invoice.edit.option.json': 'JSON output',
  'help.invoice.delete.description':
    'Delete a DRAFT that never touched the ledger; its folio stays as a documented gap',
  'help.invoice.delete.argument.ref': 'invoice number or id',
  'help.invoice.delete.option.json': 'JSON output',
  'help.invoice.series.description': 'Folio series: the counters this entity draws document numbers from',
  'help.invoice.series.list.description': 'List the folio counters, the last number issued and the next one',
  'help.invoice.series.check.description':
    'Report gaps in the invoice folio series; a gap with an audit trail is explained, one without is a finding',
  'help.invoice.series.check.option.year': 'only this fiscal year of the series',
  'help.invoice.series.check.option.strict': 'exit 4 even when every gap is explained',
  'help.customer.description': 'Customers: the AR master file, with the balance each one owes',
  'help.customer.list.description': 'List customers with terms, credit state and the balance they owe',
  'help.customer.list.argument.query': 'text to match in the customer name or number',
  'help.customer.list.option.overdue': 'only customers with something past due',
  'help.customer.list.option.balance_gt':
    'only customers whose balance at book value, in the functional currency, is more than this (a foreign document weighs at the rate it was posted at)',
  'help.customer.list.option.inactive': 'show archived customers instead of active ones',
  'help.customer.show.description': 'Show one customer: profile, tax id, credit, balance and open documents',
  'help.customer.show.argument.ref': 'customer number, name or id',
  'help.customer.create.description': 'Register a customer with its tax id, payment terms and currency',
  'help.customer.create.option.name': 'company name',
  'help.customer.create.option.first_name': 'given name, for an individual',
  'help.customer.create.option.last_name': 'family name, for an individual',
  'help.customer.create.option.tax_id': 'RFC (MX), EIN (US) or VAT number',
  'help.customer.create.option.tax_id_type': "one of: {types}; inferred from the entity's country",
  'help.customer.create.option.email': 'billing contact email',
  'help.customer.create.option.phone': 'contact phone',
  'help.customer.create.option.terms': 'payment terms, e.g. "Net 30"',
  'help.customer.create.option.currency': 'billing currency (3 letters)',
  'help.customer.create.option.json': 'JSON output',
  'help.customer.edit.description': 'Change commercial and contact data; never the tax profile or credit',
  'help.customer.edit.argument.ref': 'customer number, name or id',
  'help.customer.edit.option.name': 'new company name',
  'help.customer.edit.option.first_name': 'new given name',
  'help.customer.edit.option.last_name': 'new family name',
  'help.customer.edit.option.email': 'new billing email',
  'help.customer.edit.option.phone': 'new phone',
  'help.customer.edit.option.terms': 'new payment terms',
  'help.customer.edit.option.notes': 'free notes stored on the customer',
  'help.customer.edit.option.reason': 'justification recorded in the audit trail',
  'help.customer.archive.description': 'Deactivate a customer; refused while they still owe something',
  'help.customer.archive.argument.ref': 'customer number, name or id',
  'help.customer.restore.description': 'Put an archived customer back in service',
  'help.customer.restore.argument.ref': 'customer number, name or id',
  'help.customer.restore.option.reason': 'justification recorded in the audit trail',
  'help.customer.tax.description': 'The fiscal profile CFDI 4.0 stamps against: RFC, regime, postal code, UsoCFDI',
  'help.customer.tax.show.description':
    'Show the fiscal profile and what is missing before this customer can be stamped',
  'help.customer.tax.show.argument.ref': 'customer number, name or id',
  'help.customer.tax.set.description':
    'Set RFC, regime, postal code or UsoCFDI, validated against the SAT catalogs before writing',
  'help.customer.tax.set.argument.ref': 'customer number, name or id',
  'help.customer.tax.set.option.rfc': 'the RFC (form-validated: {shape})',
  'help.customer.tax.set.option.tax_regime': 'c_RegimenFiscal code: 601, 612, 626…',
  'help.customer.tax.set.option.postal_code': 'fiscal address postal code (5 digits)',
  'help.customer.tax.set.option.uso_cfdi': 'default c_UsoCFDI: G01, G03, P01…',
  'help.customer.tax.set.option.reason': 'justification recorded in the audit trail',
  'help.customer.tax.set.option.json': 'JSON output',
  'help.customer.tax.list.description':
    'The pre-billing control: customers whose fiscal profile is incomplete or malformed',
  'help.customer.tax.list.option.missing': 'only customers that could NOT be stamped today',
  // ==== MNE-001-237 · help by key, receipt, credit-note and rep (issue #314) ====
  //
  // The second receivables task: the descriptions of these three families that
  // earlier tasks had not keyed, roots included, with the English they already
  // showed. Every generic flag a leaf declares is worded for it and keeps its
  // own key; what the kernel injects stays on cli.flag.*. The credit note types
  // travel as {types}.
  'help.receipt.description':
    'Customer collections: record cash, apply on-account balance, unapply, and reverse bounced checks',
  'help.receipt.record.option.amount': 'amount, in the document currency',
  'help.receipt.record.option.date': 'value date (YYYY-MM-DD); defaults to today',
  'help.receipt.record.option.method': 'cash, check, ach, wire, spei, credit_card or other',
  'help.receipt.record.option.bank': "bank account name or id; without it the entity's `banco` role is used",
  'help.receipt.record.option.reference': 'bank reference or transfer number',
  'help.receipt.record.option.json': 'JSON output',
  'help.receipt.show.description':
    'Show one collection: its applications (live and history), REP status and ledger entry',
  'help.receipt.show.argument.ref': 'payment number (PMT-2026-00042) or id',
  'help.receipt.list.description': 'List collections by customer, date, application state or missing REP',
  'help.receipt.list.option.customer': 'only this customer (number, name or id)',
  'help.receipt.list.option.unapplied': 'only collections with an on-account remainder',
  'help.receipt.list.option.needs_rep': 'only completed collections with no REP linked',
  'help.receipt.apply.argument.ref': 'payment number or id',
  'help.receipt.apply.option.invoice':
    'invoice with amount: "INV-2026-00042:2500" (repeatable), or a bare ref with --amount',
  'help.receipt.apply.option.amount': 'amount for a single --invoice without an inline amount',
  'help.receipt.apply.option.json': 'JSON output',
  'help.receipt.unapply.description':
    'Unapply a collection from an invoice as a NEW event: reopens it and puts the cash back on account',
  'help.receipt.unapply.argument.ref': 'payment number or id',
  'help.receipt.unapply.option.invoice': 'the invoice to unapply from',
  'help.receipt.unapply.option.reason': 'why: it lands in the audit trail and the ledger description',
  'help.receipt.unapply.option.json': 'JSON output',
  'help.receipt.reverse.argument.ref': 'payment number or id',
  'help.receipt.reverse.option.fee':
    'bank fee charged for the return (not yet supported: needs a fee role account)',
  'help.receipt.reverse.option.json': 'JSON output',
  'help.credit_note.description':
    'Credit notes: returns, discounts and corrections against the receivable (never stamped here)',
  'help.credit_note.create.description':
    'Create a DRAFT credit note, linked to its invoice (fiscal tie) or standalone with an explicit customer',
  'help.credit_note.create.option.type': 'one of: {types}',
  'help.credit_note.create.option.amount': 'subtotal of the credit, before tax',
  'help.credit_note.create.option.tax': 'tax (IVA) portion of the credit',
  'help.credit_note.create.option.invoice': 'the invoice this note credits (recommended: it drives the IVA side)',
  'help.credit_note.create.option.customer': 'customer, when there is no linked invoice',
  'help.credit_note.create.option.relates_to': 'UUID of the original CFDI, when the invoice is not in the system',
  'help.credit_note.create.option.date':
    'credit date (YYYY-MM-DD); defaults to today in the zona_horaria policy zone',
  'help.credit_note.create.option.memo': 'memo',
  'help.credit_note.create.option.json': 'JSON output',
  'help.credit_note.show.description':
    'Show one credit note with its applications, available balance and ledger entry',
  'help.credit_note.show.argument.ref': 'credit note number (CN-2026-00042) or id',
  'help.credit_note.list.description': 'List credit notes by customer, type, state or unapplied balance',
  'help.credit_note.list.option.customer': 'only this customer (number, name or id)',
  'help.credit_note.list.option.type': 'only this type: {types}',
  'help.credit_note.list.option.open': 'only issued notes with balance left to apply (the live customer credit)',
  'help.credit_note.issue.description': 'Issue the note: post DR returns + DR VAT / CR receivable. Does not stamp',
  'help.credit_note.issue.argument.ref': 'credit note number or id',
  'help.credit_note.issue.option.json': 'JSON output',
  'help.credit_note.apply.description':
    'Apply an issued note to invoices; what is not applied stays as customer credit',
  'help.credit_note.apply.argument.ref': 'credit note number or id',
  'help.credit_note.apply.option.invoice':
    'invoice with amount: "INV-2026-00042:2500" (repeatable), or a bare ref with --amount',
  'help.credit_note.apply.option.amount': 'amount for a single --invoice without an inline amount',
  'help.credit_note.apply.option.dry_run': 'run the real path and roll back',
  'help.credit_note.apply.option.json': 'JSON output',
  'help.rep.description': 'Payment receipts (REP): what is missing one, and the parked ones to retry',
  'help.rep.missing.description': 'Payments and collections whose REP has not arrived or been issued',
  'help.rep.missing.list.description':
    'received: paid PPD bills without the supplier REP (the REP supports the VAT credit); issued: our collections without a REP',
  'help.rep.missing.list.option.direction': 'received (default) or issued',
  'help.rep.missing.list.option.min_amount': 'only payments at or above this amount',
  'help.rep.reconcile.description':
    'Retry the parked REPs (needs_review): safe to repeat, resolved nodes are skipped',
  'help.rep.reconcile.option.limit': 'maximum parked REPs to retry',
  'help.rep.reconcile.option.dry_run': 'list what would be retried, retry nothing',
  // ==== MNE-001-238 · help by key, bill and vendor (issue #314) ====
  //
  // The first payables task: both families whole, roots included, English as
  // shown (`bill rule` was keyed before). `bill approve --json` leaves
  // cli.flag.json (#314, answer 3: the leaf has no --format); the -y and
  // --idempotency-key of `bill inbox run`, already the kernel's words, take
  // cli.flag.*. Lists travel as {modes}, {keys}, {parts} and {types}, the JSON
  // shape of `bill create --from-file` as {shape}; `--1099` cannot start a key
  // segment, so its keys say is_1099, after the column it reads and writes.
  'help.bill.description': 'Vendor bills: capture, code, inspect and approve what we owe',
  'help.bill.list.description': 'List vendor bills by vendor, state, document date, posting date or due date',
  'help.bill.list.argument.search': 'match against bill number, the vendor invoice number or the vendor name',
  'help.bill.list.option.vendor': 'only this vendor (number, name or id)',
  'help.bill.list.option.due_before': 'only bills falling due on or before this date (YYYY-MM-DD)',
  'help.bill.list.option.open': 'only bills that still owe money (excludes paid, void and cancelled)',
  'help.bill.show.description': 'Show one bill with its lines, its journal entry and its source CFDI',
  'help.bill.show.argument.bill': 'bill number, vendor invoice number or id',
  'help.bill.show.option.no_lines': 'header only',
  'help.bill.show.option.journal': 'include the journal entry approval produced',
  'help.bill.show.option.cfdi': 'include the CFDI this bill came from, when it came from one',
  'help.bill.create.description': 'Capture a vendor bill with its lines and their account coding',
  'help.bill.create.argument.vendor': 'vendor number, name or id',
  'help.bill.create.option.vendor': 'vendor number, name or id (same as the positional argument)',
  'help.bill.create.option.vendor_invoice_number': "the vendor's own invoice number or folio",
  'help.bill.create.option.bill_date': 'document date (YYYY-MM-DD); defaults to today',
  'help.bill.create.option.due_date': "due date (YYYY-MM-DD); defaults to the vendor's terms",
  'help.bill.create.option.line':
    'one line, repeatable: "account=5100;qty=1;price=1000;tax-amount=160". See the key list below',
  'help.bill.create.option.currency': "3-letter ISO code; defaults to the vendor's currency",
  'help.bill.create.option.terms': 'payment terms recorded on the bill; defaults to the vendor terms',
  'help.bill.create.option.description': 'what this bill is for',
  'help.bill.create.option.from_file': 'read the bill as JSON instead: {shape}',
  'help.bill.create.option.json': 'JSON output',
  'help.bill.line.description': 'Line coding',
  'help.bill.line.set.description': 'Re-code one line of a bill that has not been approved yet',
  'help.bill.line.set.argument.bill': 'bill number, vendor invoice number or id',
  'help.bill.line.set.option.line': 'line number to change',
  'help.bill.line.set.option.account': 'expense account, by code',
  'help.bill.line.set.option.cost_center': 'cost center id',
  'help.bill.line.set.option.project': 'project id',
  'help.bill.line.set.option.description': 'line description',
  'help.bill.approve.description':
    'Approve a bill and recognize the liability in the ledger (DR expense + IVA / CR payables)',
  'help.bill.approve.argument.bill': 'bill number, vendor invoice number or id',
  'help.bill.approve.option.json': 'JSON output',
  'help.bill.inbox.description': 'CFDI inbox: pre-registrations waiting to become vendor bills',
  'help.bill.inbox.list.description': 'The CFDI queue: what arrived, whose it is, and what is holding it up',
  'help.bill.inbox.list.option.processing_mode': 'how it is meant to be processed: {modes}',
  'help.bill.inbox.list.option.requires_approval': 'only the ones held for a prior approval',
  'help.bill.inbox.list.option.vendor': 'only this vendor (number, name or id)',
  'help.bill.inbox.edit.description':
    'Code a pre-registration by hand: the account (and cost center) of a line, or its default account',
  'help.bill.inbox.edit.argument.id': 'one pre-registration, by id',
  'help.bill.inbox.edit.option.line':
    'line number to code; without it, --account is the default for every line with none',
  'help.bill.inbox.edit.option.account':
    'expense account, by code or id; for a CFDI this entity issued, the revenue account',
  'help.bill.inbox.edit.option.cost_center': 'cost center id of the --line',
  'help.bill.inbox.run.description':
    'Turn pre-registrations into vendor bills, or approve, reject and schedule them in bulk',
  'help.bill.inbox.run.argument.id': 'one pre-registration, by id',
  'help.bill.inbox.run.option.action': 'what to do with the selection',
  'help.bill.inbox.run.option.bulk': 'act on everything --query selects, instead of a single id',
  'help.bill.inbox.run.option.query': 'selection for --bulk, comma-separated key=value: {keys}',
  'help.bill.inbox.run.option.batch': 'processing batch to schedule into; required by --action set-batch',
  'help.bill.inbox.run.option.allow_new_vendor':
    'authorize creating the CFDI issuer as a vendor when the catalog does not have it; without it, those are refused',
  'help.bill.inbox.run.option.reason': 'why it is rejected; required by --action reject',
  'help.bill.inbox.run.option.note': 'annotation stored with the approval',
  'help.bill.inbox.run.option.dry_run': 'compute and show the full effect; write nothing',
  'help.bill.inbox.run.option.json': 'JSON output',
  'help.vendor.description': 'Vendor master: who we owe money to, on what terms, under which tax id',
  'help.vendor.list.description': 'List vendors, filtered by state, 1099 flag or a missing tax id',
  'help.vendor.list.argument.search': 'match against company name or vendor number',
  'help.vendor.list.option.inactive': 'show archived vendors instead of active ones',
  'help.vendor.list.option.is_1099': 'only vendors flagged for a US information return',
  'help.vendor.list.option.no_tax_id': 'only vendors with no tax id on file (the DIOT/1099 blockers)',
  'help.vendor.show.description': 'Show one vendor: identity, terms, currency and flags',
  'help.vendor.show.argument.vendor': 'vendor number, name or id',
  'help.vendor.show.option.include': 'extra sections, comma-separated: {parts}',
  'help.vendor.create.description':
    'Register a vendor with its tax id, terms, currency and default expense account',
  'help.vendor.create.argument.name': 'company name',
  'help.vendor.create.option.tax_id': 'RFC (Mexico), EIN (USA) or VAT number',
  'help.vendor.create.option.tax_id_type': "{types} (defaults from the entity's country)",
  'help.vendor.create.option.contact': 'contact person',
  'help.vendor.create.option.email': 'contact email',
  'help.vendor.create.option.phone': 'contact phone',
  'help.vendor.create.option.terms': 'payment terms: "Net 30", "2/10 Net 30", "Due on receipt"',
  'help.vendor.create.option.currency': "3-letter ISO code (defaults to the entity's functional currency)",
  'help.vendor.create.option.default_account': 'default expense account, by code',
  'help.vendor.create.option.is_1099': 'flag the vendor for a US information return',
  'help.vendor.create.option.json': 'JSON output',
  'help.vendor.edit.description': 'Change the non-banking, non-fiscal details of a vendor, leaving an audit row',
  'help.vendor.edit.argument.vendor': 'vendor number, name or id',
  'help.vendor.edit.option.name': 'new company name',
  'help.vendor.edit.option.contact': 'new contact person',
  'help.vendor.edit.option.email': 'new email',
  'help.vendor.edit.option.phone': 'new phone',
  'help.vendor.edit.option.notes': 'replace the notes',
  'help.vendor.edit.option.reason': 'why the change was made; recorded in the audit trail',
  'help.vendor.terms.description': 'Payment terms',
  'help.vendor.terms.set.description':
    'Set payment terms and settlement currency, validated so a due date can be computed',
  'help.vendor.terms.set.argument.vendor': 'vendor number, name or id',
  'help.vendor.terms.set.option.terms': '"Net 30", "2/10 Net 30", "Due on receipt"',
  'help.vendor.terms.set.option.currency': '3-letter ISO code',
  'help.vendor.terms.set.option.reason': 'why the change was made; recorded in the audit trail',
  // ==== MNE-001-239 · help by key, payment, prepaid and tax-deposit (issue #314) ====
  //
  // The second payables task: the three families whole, roots included,
  // English as shown (`payment trace` was keyed before). Every generic flag
  // keeps a key of its own: none of these leaves has a --format, their --reason
  // is not cli.flag.reason's text, and `prepaid list` declares -n and --offset
  // by hand. The two withSelection flags `tax-deposit list` rewords go through
  // describeOption. Lists travel as {conventions} and {states}.
  'help.payment.description': 'Vendor payments: record cash that already left the bank and settle the bill it pays',
  'help.payment.create.description': 'Record a payment made against a bill and recognize the IVA it was holding',
  'help.payment.create.argument.bill': 'bill number, vendor invoice number or id',
  'help.payment.create.option.amount': 'amount, in the document currency',
  'help.payment.create.option.date': 'value date (YYYY-MM-DD); defaults to today',
  'help.payment.create.option.method': 'cash, check, ach, wire, spei, credit_card or other',
  'help.payment.create.option.bank': "bank account name or id; without it the entity's `banco` role is used",
  'help.payment.create.option.json': 'JSON output',
  'help.payment.create.option.check_number': 'cheque number; only valid with --method check',
  'help.payment.create.option.to_account': 'account that received the money (CtaDest of the SAT voucher)',
  'help.payment.create.option.to_bank': 'destination bank key from the SAT c_Banco catalogue (3 digits)',
  'help.payment.create.option.to_foreign_bank': 'destination bank name when it is a foreign one',
  'help.payment.create.option.discount': 'early-payment discount taken',
  'help.payment.create.option.memo': 'note stored with the payment',
  'help.payment.apply.description':
    'Apply an existing payment to specific bills: partial, with discount, or short-paid',
  'help.payment.apply.argument.payment': 'payment number or id whose on-account balance is to be applied',
  'help.payment.apply.option.bill': 'bill to apply to; repeat it, paired in order with --amount',
  'help.payment.apply.option.amount': 'amount applied to the bill in the same position',
  'help.payment.apply.option.discount': 'early-payment discount for the bill in the same position',
  'help.payment.apply.option.mode': 'partial (leave the rest open) or residual (close it short)',
  'help.payment.apply.option.short_pay_reason':
    'why the unpaid balance is being written off; required by --mode residual',
  'help.payment.apply.option.date':
    'day of the application (YYYY-MM-DD), which dates its entry, the application and the bill\'s last payment; defaults to today in the entity\'s time zone',
  'help.payment.apply.option.json': 'JSON output',
  'help.payment.unapply.description':
    'Unapply a payment from a bill as a NEW dated event: the bill is owed again, the cash goes back on account',
  'help.payment.unapply.argument.payment': 'payment number or id',
  'help.payment.unapply.option.bill': 'the bill to unapply from',
  'help.payment.unapply.option.reason': 'why: it lands in the audit trail',
  'help.payment.unapply.option.date':
    'date of the unapply, for the closed row and its entry (YYYY-MM-DD); defaults to today in the entity\'s time zone',
  'help.payment.unapply.option.json': 'JSON output',
  'help.payment.reverse.description':
    'Reverse a payment that came back: mirrors every entry it posted, dated; its bills are owed again',
  'help.payment.reverse.argument.payment': 'payment number or id',
  'help.payment.reverse.option.reason': 'why: it lands in the audit trail',
  'help.payment.reverse.option.date':
    'date of the reversal, for its mirrors and the closed rows (YYYY-MM-DD); defaults to today',
  'help.payment.reverse.option.json': 'JSON output',
  // MNE-001-299 · the deferred-revenue family (NIF D-1).
  'help.deferred_revenue.description':
    'Revenue collected in advance: the schedule that turns the contract liability (2158) into revenue, month by month',
  'help.deferred_revenue.create.description':
    'Adopt a credit already on the contract liability and register its recognition schedule; posts nothing',
  'help.deferred_revenue.create.argument.description': 'what the contract covers, as it will read in the entries',
  'help.deferred_revenue.create.option.amount': 'amount to recognize, without IVA, as a decimal',
  'help.deferred_revenue.create.option.start': 'first day the service is rendered (YYYY-MM-DD)',
  'help.deferred_revenue.create.option.end': 'last day the service is rendered, inclusive (YYYY-MM-DD)',
  'help.deferred_revenue.create.option.origin': 'where the credit already on the liability came from — no default',
  'help.deferred_revenue.create.option.source_entry': 'the entry that credited the liability; required with --origin cfdi',
  'help.deferred_revenue.create.option.reference': 'the document this points at: contract, order, invoice number',
  'help.deferred_revenue.create.option.dry_run': 'show the schedule that would be registered; write nothing',
  'help.deferred_revenue.run.description': 'Recognize the month — one adjusting entry per schedule, irreversible',
  'help.deferred_revenue.run.option.period': 'period to recognize: 2026-08, or any unambiguous part of its name',
  'help.deferred_revenue.create.footer':
    'Examples:\n' +
    '  An annual support contract already credited to 2158; nothing posts here. First what it would register:\n' +
    '    mnemosine deferred-revenue create "Soporte anual 2026-2027" --amount 120000.00 --start 2026-03-20 --end 2027-03-19 --origin manual --dry-run\n' +
    '  Then the schedule itself:\n' +
    '    mnemosine deferred-revenue create "Soporte anual 2026-2027" --amount 120000.00 --start 2026-03-20 --end 2027-03-19 --origin manual',
  'help.deferred_revenue.run.footer':
    'Examples:\n' +
    '  First the dry run: the schedules that owe the month, posting nothing:\n' +
    '    mnemosine deferred-revenue run --period 2026-04 --dry-run\n' +
    '  Then the month itself:\n' +
    '    mnemosine deferred-revenue run --period 2026-04 --yes',
  'help.prepaid.description': 'Prepaid expenses: the schedule that takes them out of 1160, month by month',
  'help.prepaid.create.description':
    'Register the amortisation schedule of a charge already sitting in prepaid expenses — posts nothing',
  'help.prepaid.create.argument.description': 'what the prepayment covers, as it will read in the entries',
  'help.prepaid.create.option.amount': 'amount to accrue, as a decimal',
  'help.prepaid.create.option.start': 'first day the coverage runs (YYYY-MM-DD)',
  'help.prepaid.create.option.end': 'last day the coverage runs, inclusive (YYYY-MM-DD)',
  'help.prepaid.create.option.origin': 'where the charge already in the account came from — no default',
  'help.prepaid.create.option.source_entry':
    'the journal entry that charged the account; required with --origin cfdi',
  'help.prepaid.create.option.cfdi_uuid': 'the CFDI this prepayment came in on, for the trail',
  'help.prepaid.create.option.vendor': 'vendor name kept on the schedule',
  'help.prepaid.create.option.reference': 'the document this points at: policy number, contract, order',
  'help.prepaid.create.option.convention':
    'the convention you believe you are registering ({conventions}); checked against the panel',
  'help.prepaid.create.option.prepaid_account':
    'prepaid-expenses account the charge sits in (defaults to the `gasto_anticipado` role)',
  'help.prepaid.create.option.expense_account':
    'account the accrual will charge each month (defaults to the `gasto` role)',
  'help.prepaid.create.option.reason': 'why the threshold is being overridden; required with --force',
  'help.prepaid.create.option.dry_run': 'show the schedule that would be registered; write nothing',
  'help.prepaid.list.description': 'Live schedules with their remaining balance and how many periods are left',
  'help.prepaid.list.option.limit': 'maximum rows to return',
  'help.prepaid.list.option.offset': 'skip this many rows',
  'help.prepaid.list.option.all': 'every live schedule, including those not started yet and already ended',
  'help.prepaid.list.option.as_of':
    'only schedules whose coverage is open on this date (YYYY-MM-DD; default today)',
  'help.prepaid.show.description': 'One schedule with its period-by-period table',
  'help.prepaid.show.argument.id_or_description':
    'the schedule: its id, or enough of its description to be unambiguous',
  'help.prepaid.run.description': 'Post the month accrual — one adjusting entry per schedule, irreversible',
  'help.prepaid.run.option.period': 'period to accrue: 2026-08, or any unambiguous part of its name',
  'help.tax_deposit.description': 'Employer tax liabilities: what is owed, to whom, and by when',
  'help.tax_deposit.list.description':
    'Accrued employer liabilities with their due date and status, soonest due first',
  'help.tax_deposit.list.option.status': 'filter by liability status ({states}); repeatable',
  'help.tax_deposit.list.option.all': 'include what is already settled: deposited and waived rows too',
  'help.tax_deposit.list.option.period': 'only liabilities whose period touches this month',
  'help.tax_deposit.list.option.until': 'only what falls due on or before this date (YYYY-MM-DD)',
  'help.tax_deposit.list.option.all_entities': 'every entity of the tenant, not just the active one',
  // ==== MNE-001-240 · help by key, cfdi, e-accounting and sat (issue #314) ====
  //
  // Fiscal 1/2: the three families whole, roots included, English as shown
  // (the leaves keyed before, such as `cfdi post`, the seal leaves and `sat
  // download`, keep their keys). The author prose in Castilian of `cfdi list
  // --direction` and `cfdi status show --refresh` already got its English with
  // MNE-001-226 (#871). Every generic flag keeps a key of its own: `-o` of the
  // two generate leaves names the XML (withOutput's flag, reworded through
  // describeOption), their `--dry-run` and `-y` are the leaf's own, and the
  // `-e`, `-u` and `-n` of `sat cred` and `cfdi status sync` say other things
  // than cli.flag.*.
  'help.cfdi.description':
    'The CFDI mirror: list, inspect, SAT status, the classifier trail, and posting an issued CFDI',
  'help.cfdi.list.description': 'The mirror, filtered by direction, type, status and date',
  'help.cfdi.list.option.direction': 'emitido, recibido or ajeno (derived against the RFC of the entity)',
  'help.cfdi.list.option.type': 'filter by document_type, for example cfdi_ingreso, cfdi_egreso or cfdi_pago',
  'help.cfdi.show.description': 'One CFDI: header, lines, taxes and SAT status; --format xml prints the exact bytes',
  'help.cfdi.show.argument.uuid': 'CFDI UUID (timbre fiscal)',
  'help.cfdi.status.description': 'SAT status of the mirror (public ConsultaCFDIService; no e.firma involved)',
  'help.cfdi.status.show.description': 'Estado, EsCancelable and EstatusCancelacion as the SAT last answered',
  'help.cfdi.status.show.argument.uuid': 'CFDI UUID',
  'help.cfdi.status.show.option.refresh': 'ask the SAT now and update the sat_* cache of the document',
  'help.cfdi.status.sync.description': 'Re-check the whole mirror against the SAT: stale or never-consulted first',
  'help.cfdi.status.sync.option.limit': 'maximum CFDIs to consult in this run',
  'help.cfdi.status.sync.option.stale_hours': 'a consultation older than this is stale',
  'help.cfdi.explain.description': 'WHY it was recorded the way it was: case, facts and decisions the classifier left',
  'help.cfdi.explain.argument.uuid': 'CFDI UUID',
  'help.e_accounting.description': 'Mexican e-accounting (Anexo 24): build the XML the SAT expects, and check it',
  'help.e_accounting.catalog.description': 'The chart of accounts as the SAT wants it: CtaCatalogo 1.3',
  'help.e_accounting.catalog.generate.description':
    'Build and archive the CtaCatalogo 1.3 XML (NumCta, Desc, SubCtaDe, Nivel, Natur, CodAgrup) with its hash',
  'help.e_accounting.catalog.generate.option.output':
    'write the CtaCatalogo XML to this path (the artifact store keeps its own copy)',
  'help.e_accounting.catalog.generate.option.period': 'month the catalog declares (Mes and Anio of its header)',
  'help.e_accounting.catalog.generate.option.dry_run':
    'build it and show the verdict; archive nothing and write no file',
  'help.e_accounting.catalog.generate.option.yes': 'skip the overwrite prompt when -o names an existing file',
  'help.e_accounting.balance.description': 'The trial balance the SAT expects: BCE 1.3, normal, amended or year-end',
  'help.e_accounting.balance.generate.description':
    "Build and archive the period's trial balance XML (SaldoIni, Debe, Haber, SaldoFin) with its hash",
  'help.e_accounting.balance.generate.option.output':
    'write the Balanza XML to this path (the artifact store keeps its own copy)',
  'help.e_accounting.balance.generate.option.period': 'period to declare: 2026-02, its name, or the fiscal period id',
  'help.e_accounting.balance.generate.option.type': 'envelope type: N normal, C amended (needs --modified)',
  'help.e_accounting.balance.generate.option.closing': 'the year-end balance, filed as month 13 — not December again',
  'help.e_accounting.balance.generate.option.modified':
    'date the balance being amended was modified (FechaModBal); required with --type C',
  'help.e_accounting.balance.generate.option.dry_run':
    'build it and show the verdict; archive nothing and write no file',
  'help.e_accounting.balance.generate.option.yes': 'skip the overwrite prompt when -o names an existing file',
  'help.e_accounting.balance.check.description':
    'Run the invariants the SAT re-runs: SaldoIni + Debe − Haber = SaldoFin honouring Natur, every account in the catalog, ' +
    'and the SAT XSD over the file balance generate would build',
  'help.e_accounting.balance.check.option.period': 'period to check: 2026-02, its name, or the fiscal period id',
  'help.e_accounting.balance.check.option.closing': 'check the year-end balance (month 13) instead of a month',
  'help.e_accounting.balance.check.option.check':
    'comma-separated check names; with no value, prints the available ones',
  'help.sat.description': 'SAT services (e.firma credentials and the CFDI bulk download)',
  'help.sat.cred.description': 'Fiscal credentials (e.firma)',
  'help.sat.cred.add.description':
    'Registers the e.firma of an entity (validates locally; storing in the vault requires --live)',
  'help.sat.cred.add.option.cer': 'SAT .cer certificate (DER)',
  'help.sat.cred.add.option.key': 'SAT .key private key (DER)',
  'help.sat.cred.add.option.entity': 'Legal entity',
  'help.sat.cred.add.option.user': 'Who grants the consent',
  'help.sat.cred.add.option.no_unattended': 'Forbid use without an operator present',
  'help.sat.cred.add.option.max_diario': 'Access limit per 24 h',
  'help.sat.cred.status.description': 'Shows the entity credentials and their validity',
  'help.sat.cred.status.option.entity': 'Legal entity',
  'help.sat.cred.audit.description': 'Credential access history (who used it, when and what for)',
  'help.sat.cred.audit.option.entity': 'Legal entity',
  'help.sat.cred.audit.option.limit': 'How many events to show',
  'help.sat.cred.revoke.description': 'Revokes the credential and deletes the material from the vault (irreversible)',
  'help.sat.cred.revoke.option.entity': 'Legal entity',
  'help.sat.cred.revoke.option.user': 'Who revokes',
  // ==== MNE-001-427 · help by key, report and asset (issue #314) ====
  //
  // Fiscal and reports 2/2: the two families whole, roots included, English as
  // shown. The two aging groups come from one function and keep a key each.
  // The lists in `report view sync --view` and in `asset create --method` and
  // `--tax-method` are parameters: machine values, not translated. Every
  // generic flag a leaf declares keeps a key of its own: `asset create
  // --dry-run` says what the rehearsal shows.
  'help.report.description': 'Financial statements, trial balance, general ledger and ageing',
  'help.report.trial_balance.description': 'Trial balance',
  'help.report.trial_balance.show.description': 'Debits, credits and ending balance by account, with the footing',
  'help.report.trial_balance.show.option.level': 'roll up to at most this account level (default: every level)',
  'help.report.trial_balance.show.option.exclude_zero': 'omit accounts whose ending balance is exactly zero',
  'help.report.balance_sheet.description': 'Balance sheet',
  'help.report.balance_sheet.show.description': 'Assets, liabilities and equity at a cutoff date, in natural sign',
  'help.report.income_statement.description': 'Income statement',
  'help.report.income_statement.show.description': 'Revenue, expenses and net income for a period',
  'help.report.general_ledger.description': 'General ledger detail',
  'help.report.general_ledger.show.description': 'Posted movements line by line, filterable by account and date',
  'help.report.general_ledger.show.option.account': 'restrict to one account (code or id)',
  'help.report.aged_receivable.description': 'Aged receivables',
  'help.report.aged_receivable.show.description': 'Open customer invoices by age bucket, with the amount still due',
  'help.report.aged_payable.description': 'Aged payables',
  'help.report.aged_payable.show.description': 'Open vendor bills by age bucket, with the amount still due',
  'help.report.view.description': 'The reporting materialized views (mv_trial_balance, mv_account_balance_summary)',
  'help.report.view.show.description': 'Whether each reporting view still agrees with the ledger, and by how much',
  'help.report.view.sync.description': 'Rebuild the reporting materialized views from the ledger (firm-wide)',
  'help.report.view.sync.option.view': 'which views to rebuild (default: all of {views})',
  'help.report.view.sync.option.no_concurrently': 'rebuild with an exclusive lock; needed only for a never-populated view',
  'help.asset.description': 'Fixed asset register: the ledger of what the company owns and depreciates',
  'help.asset.create.description':
    'Register a fixed asset with its class, dates, cost and accounts — writes no journal entry',
  'help.asset.create.argument.name': 'what the asset is called in the register',
  'help.asset.create.option.category': 'asset class: its id, or enough of its name to be unambiguous',
  'help.asset.create.option.cost': 'original cost of the investment (MOI), as a decimal',
  'help.asset.create.option.acquired': 'acquisition date (YYYY-MM-DD)',
  'help.asset.create.option.in_service':
    'date depreciation starts (YYYY-MM-DD); defaults from the first-month convention on the panel',
  'help.asset.create.option.book': 'the depreciation book you believe you are working on; checked against the panel',
  'help.asset.create.option.capitalized':
    'whether the cost is ALREADY charged to the asset account in the ledger — no default',
  'help.asset.create.option.source_entry': 'the journal entry the cost already sits in, when it is known',
  'help.asset.create.option.salvage': 'residual value at the end of its life (default 0)',
  'help.asset.create.option.life_years': 'useful life in years',
  'help.asset.create.option.life_months': 'useful life in months; years are the ceiling of months over twelve',
  'help.asset.create.option.method': 'BOOK depreciation method: {methods}',
  'help.asset.create.option.tax_method': 'TAX depreciation method: {methods}',
  'help.asset.create.option.asset_account': 'GL account the cost sits in (defaults from the class)',
  'help.asset.create.option.accum_account': 'accumulated depreciation account (defaults from the class)',
  'help.asset.create.option.expense_account': 'depreciation expense account (defaults from the class)',
  'help.asset.create.option.number': 'asset number; generated from the entity series when omitted',
  'help.asset.create.option.description': 'what the asset is',
  'help.asset.create.option.vendor': 'vendor it was bought from',
  'help.asset.create.option.serial': 'serial number, so the register can find the physical thing',
  'help.asset.create.option.location': 'where it is',
  'help.asset.create.option.dry_run': 'run the real path and undo it: shows the asset that would be created',
  'help.asset.category.description': 'Asset classes: useful life, LISR rate and the three default accounts',
  'help.asset.category.seed.description':
    'Create the missing Mexican asset classes, with their LISR art. 34/35 maximum rate',
  // ==== MNE-001-242 · help by key, approvals, memory, pending, skills, ingest and question (issue #314) ====
  //
  // The first agent task: the six families whole, English as shown (the roots
  // of ingest and question, `ingest <files...>`, `--kind` and `question list`
  // were keyed before). Every generic flag keeps a key of its own: «Legal
  // entity», «Tenant» and «JSON output» are not the kernel's words, and none of
  // these leaves has a --format. Lists travel as {scopes} and {modes}.
  'help.approvals.description': 'Graduated approval policies for staged writes (once / session / always)',
  'help.approvals.list.description': 'List approval policies of the entity',
  'help.approvals.list.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.approvals.list.option.tenant': 'Tenant',
  'help.approvals.list.option.scope': 'Filter by scope ({scopes})',
  'help.approvals.list.option.all': 'Include revoked policies',
  'help.approvals.list.option.json': 'JSON output',
  'help.approvals.grant.description':
    'Grant a pattern-based approval policy (conservative matching; the floor always wins)',
  'help.approvals.grant.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.approvals.grant.option.tenant': 'Tenant',
  'help.approvals.grant.option.scope': 'Scope of the policy ({scopes})',
  'help.approvals.grant.option.mode': 'Policy mode ({modes})',
  'help.approvals.grant.option.kind':
    "Match field: candidate kind. For drafts this is the draft payload's " +
    '"kind" (or "entry_type") field, falling back to "journal_entry" when ' +
    'absent — kinds in use today: journal_entry (default), payroll',
  'help.approvals.grant.option.max_amount': 'Match field: maximum amount authorized (numeric string)',
  'help.approvals.grant.option.provider': 'Match field: external provider (e.g. contalink)',
  'help.approvals.grant.option.operation': 'Match field: external operation (e.g. create_policy)',
  'help.approvals.grant.option.session': 'Granting session id (required for --mode session)',
  'help.approvals.grant.option.user': 'Granting user (required when the tenant has several active users)',
  'help.approvals.revoke.description': 'Revoke an active approval policy',
  'help.approvals.revoke.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.approvals.revoke.option.tenant': 'Tenant',
  'help.memory.description': 'Firm precedents: what the AI learned and you control',
  'help.memory.option.entity': 'Legal entity',
  'help.memory.option.tenant': 'Tenant',
  'help.memory.option.search': 'Filter by text',
  'help.memory.option.all': 'Include retired ones',
  'help.memory.option.conflicts': 'Only the precedents that contradict each other, and how to resolve them',
  'help.memory.option.json': 'JSON output',
  'help.memory.teach.description': 'Seeds a firm criterion without waiting for the AI to ask',
  'help.memory.teach.argument.rule': 'The situation, e.g. "Telmex invoices"',
  'help.memory.teach.argument.criterion': 'What to do, e.g. "they go to 6130 Utilities"',
  'help.memory.teach.option.user': 'Who teaches it',
  'help.memory.teach.option.topic': 'Topic for grouping precedents',
  'help.memory.correct.description': 'Changes the answer of a precedent (the previous one stays in the history)',
  'help.memory.correct.argument.id': 'Precedent id',
  'help.memory.correct.argument.answer': 'The correct answer',
  'help.memory.correct.option.user': 'Who corrects',
  'help.memory.retire.description': 'The AI stops using this precedent (not deleted: the history remains)',
  'help.memory.retire.argument.id': 'Precedent id',
  'help.memory.retire.option.user': 'Who retires it',
  'help.memory.retire.option.reason': 'Why it no longer applies (kept in the precedent history)',
  'help.memory.restore.description': 'Reactivates a retired precedent',
  'help.memory.restore.argument.id': 'Precedent id',
  'help.pending.description': 'What you need to do: work to resolve and policy decisions to define',
  'help.pending.option.entity': 'Legal entity',
  'help.pending.option.verbose':
    'Explain each decision: why I ask, what I do, what skipping costs, and what your own data says',
  'help.pending.option.all': 'Include definitions already resolved and dismissed',
  'help.pending.define.description': 'Defines a pending decision (the value takes effect immediately)',
  'help.pending.define.argument.key': 'Decision key (see: mnemosine pending)',
  'help.pending.define.argument.value': 'Chosen value; if omitted, asked interactively',
  'help.pending.define.option.entity': 'Legal entity',
  'help.pending.define.option.user': 'Who defines it',
  'help.pending.define.option.note': 'Note or rationale',
  'help.pending.dismiss.description': 'Marks a definition as not applicable (leaves the agenda)',
  'help.pending.dismiss.option.entity': 'Legal entity',
  'help.pending.dismiss.option.user': 'Who dismisses it',
  'help.pending.dismiss.option.note': 'Why it does not apply',
  'help.pending.reopen.description': 'Reopens an already resolved definition (the policy changed)',
  'help.pending.reopen.option.entity': 'Legal entity',
  'help.skills.description': 'Firm skills: list, review staged changes, view content',
  'help.skills.list.description': 'Visible skills and how many staged changes await review',
  'help.skills.list.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.skills.list.option.tenant': 'Tenant',
  'help.skills.list.option.json': 'JSON output',
  'help.skills.drafts.description': 'Review staged skill changes: diff + trust-scan report, approve or reject',
  'help.skills.drafts.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.skills.drafts.option.tenant': 'Tenant',
  'help.skills.drafts.option.user': 'Reviewer',
  'help.skills.drafts.option.accept_risk':
    'Allow approving drafts the trust scanner flagged (recorded in the audit trail)',
  'help.skills.drafts.option.override_drift':
    'Approve even if the skill file drifted from the draft diff base (recorded in the audit trail)',
  'help.skills.drafts.option.json': 'List pending drafts as JSON (no interactive review)',
  'help.skills.view.description': "Print one skill's SKILL.md",
  'help.skills.view.argument.name': 'Skill name',
  'help.ingest.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.ingest.option.provider': 'Model provider (see: mnemosine providers)',
  'help.ingest.option.model': 'Override the profile model',
  'help.ingest.option.user': 'User the ingestion is attributed to (default: sole active user)',
  'help.ingest.option.auto_post': 'Enables threshold-based auto-posting (default: everything stays as draft)',
  'help.ingest.option.no_auto_post': 'Disables auto-posting even if the config has it turned on',
  'help.ingest.option.min_confidence': 'Minimum confidence for auto-post (0-1)',
  'help.ingest.option.max_amount': 'Maximum auto-postable amount',
  'help.ingest.option.retry':
    'Reprocess CFDI already registered whose processing failed, instead of reporting them as duplicates',
  'help.question.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.question.option.user': 'Who answers (default: sole active user of the tenant)',
  'help.question.option.list': 'Only list, without answering (deprecated: use `question list`)',
  'help.question.answer.argument.id': 'question id; omit to answer the pending queue interactively',
  'help.question.answer.argument.answer': 'the answer text, or the number of an option (requires <id>)',
  'help.question.answer.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.question.answer.option.user': 'Who answers (default: sole active user of the tenant)',
  // ==== MNE-001-235 · help by key, entry (issue #314) ====
  //
  // The second ledger task: the `entry` family whole, root included, English as
  // shown (`batch` and `fx` are MNE-001-426). Every generic flag a leaf declares
  // is worded for it and keeps its own key; what withContext, withOutput,
  // withSelection, withTime, withStrict and declareRisk add stays on cli.flag.*.
  // The lists travel as {types} and {layouts}. The English of `entry import
  // --layout` was Spanish author prose on develop ("aún sin parser"); the owner
  // chose on #314 (15 Nov 2026) to give those nodes real English, so it is the
  // one English text this task changes.
  'help.entry.description': 'Journal entries: draft, inspect, validate, post, reverse and void',
  'help.entry.list.description': 'Search journal entries by text, account, date, amount, state, type or source',
  'help.entry.list.argument.search': 'text to match in the description or reference',
  'help.entry.list.option.type': 'entry type (repeatable)',
  'help.entry.list.option.source': 'origin subledger: invoice, bill, payroll, manual…',
  'help.entry.list.option.account': 'only entries with a line on this account',
  'help.entry.list.option.min_amount': 'minimum total debits',
  'help.entry.list.option.max_amount': 'maximum total debits',
  'help.entry.show.description': 'Show one entry with its lines, totals, period and linked reversal',
  'help.entry.show.argument.number': 'entry number (JE-2026-00042) or id',
  'help.entry.show.option.no_lines': 'header only, without the lines',
  'help.entry.create.description': 'Create a journal entry — ALWAYS a draft; posting is a separate human step',
  'help.entry.create.option.line':
    'a line: "account=6120;debit=45000.00;description=…"; repeat for each line. See the key list below',
  'help.entry.create.option.file': 'JSON document with date, type, description and lines',
  'help.entry.create.option.date': 'entry date (YYYY-MM-DD); defaults to today',
  'help.entry.create.option.type': 'entry type: {types} (default: standard)',
  'help.entry.create.option.description': 'what the entry records',
  'help.entry.create.option.reference': 'external reference (document, folio, memo)',
  'help.entry.create.option.dry_run': 'validate and show the entry that would be drafted; write nothing',
  'help.entry.create.option.json': 'JSON output',
  'help.entry.check.description': 'Run the seven NIF validation rules over an entry or a document; writes nothing',
  'help.entry.check.option.entry': 'an existing entry, by number or id',
  'help.entry.check.option.file': 'a JSON entry document that does not exist yet',
  'help.entry.line.description': 'Ledger lines: from an account balance down to the entries behind it',
  'help.entry.line.list.description': 'Posted lines of one account, each with the entry it belongs to',
  'help.entry.line.list.argument.code': 'account code',
  'help.entry.preview.description':
    'The exact account_balances delta this entry would produce, without touching anything',
  'help.entry.preview.argument.number': 'entry number or id',
  'help.entry.edit.description': 'Edit a DRAFT entry: description, reference, note, date or full line replacement',
  'help.entry.edit.argument.number': 'entry number or id',
  'help.entry.edit.option.description': 'new description',
  'help.entry.edit.option.reference': 'new external reference',
  'help.entry.edit.option.note': 'new note',
  'help.entry.edit.option.date': 'new entry date (YYYY-MM-DD)',
  'help.entry.edit.option.line':
    'replace ALL lines: "account=6120;debit=45000.00;description=…" (key list in entry create --help)',
  'help.entry.edit.option.file': 'JSON document whose date/description/reference/lines replace the draft',
  'help.entry.export.description': 'Entries WITH their lines, flat, for audit or migration — no page cap',
  'help.entry.import.description':
    'Stage a file of entries into a batch (returns a batch_id); NEVER touches the ledger',
  'help.entry.import.argument.file': 'file of journal entries to stage',
  'help.entry.import.option.layout': 'file layout: {layouts} (contpaqi/aspel/iif/sat-polizas: no parser yet)',
  'help.entry.import.option.dry_run': 'parse and report, stage nothing',
  'help.entry.import.option.idempotency_key':
    'replay-safe key: the same key with the same file returns the first batch',
  'help.entry.post.description': 'Post ONE entry to the ledger: validates the seven rules, then moves balances',
  'help.entry.post.argument.number': 'entry number or id',
  'help.entry.post.option.json': 'JSON output',
  'help.entry.reverse.description': 'Create the linked posted mirror of an entry (NIF B-1: correct by reversal)',
  'help.entry.reverse.argument.number': 'the POSTED entry to reverse',
  'help.entry.reverse.option.date': 'date of the mirror entry (YYYY-MM-DD); defaults to today',
  'help.entry.void.description': 'Annul an entry: a draft is marked void, a posted one gets its linked mirror',
  'help.entry.void.argument.number': 'entry number or id',

  // ==== MNE-001-426 · help by key, batch and fx (issue #314) ====
  //
  // The last ledger task, split from 235 by answer 2: both families whole,
  // roots and the `fx rate` group included, with the English these commands
  // already showed. Every generic flag a leaf declares keeps its own key: the
  // `--json` of `batch post` and `batch reverse` (no --format there), and the
  // `--since`/`--until` of `fx rate list`, whose words are the kernel's but
  // which parse no date. Lists travel as {kinds} and {categories}. The
  // categories of `batch check --check` are values the user types (`cuenta`
  // among them): they move as they are in both languages, left for I23
  // (MNE-001-200), so ux-status keeps counting that node.
  'help.batch.description': 'Staged entry batches: list, inspect, check, post transactionally and reverse as a unit',
  'help.batch.list.description': 'List batches with their state, row counts, posted entries and content hash',
  'help.batch.list.option.kind': 'batch class (available: {kinds})',
  'help.batch.show.description':
    'One batch in full: rows with their generated entries, stored parse errors by category, and the file hash',
  'help.batch.show.argument.id': 'batch id',
  'help.batch.show.option.errors_only': 'only the rows whose parser rejected them',
  'help.batch.check.description':
    'Run the posting validations over every row and report each finding; exits 4 when any blocks',
  'help.batch.check.argument.id': 'batch id',
  'help.batch.check.option.check':
    'finding categories to display, comma-separated (available: {categories}); the full battery always runs',
  'help.batch.post.description':
    'Post the whole batch in one transaction; --partial applies the valid rows and leaves the rest staged',
  'help.batch.post.argument.id': 'batch id',
  'help.batch.post.option.partial':
    'apply the valid rows and leave the invalid ones in staging (accepts an unchecked batch)',
  'help.batch.post.option.json': 'JSON output',
  'help.batch.reverse.description':
    'Mirror every entry the batch posted, as one unit in one transaction — import errors are batch-shaped, not ' +
    'entry-shaped',
  'help.batch.reverse.argument.id': 'batch id',
  'help.batch.reverse.option.as_of': 'date for every mirror entry (YYYY-MM-DD); defaults to today',
  'help.batch.reverse.option.json': 'JSON output',
  'help.fx.description': 'Exchange rates: the origin every foreign-currency amount converts from',
  'help.fx.rate.description': 'Published exchange rates by pair, date, type and source',
  'help.fx.rate.list.description': 'List stored exchange rates by pair, date, type and source',
  'help.fx.rate.list.option.pair': 'currency pair, e.g. USD/MXN',
  'help.fx.rate.list.option.since': 'inclusive lower bound (YYYY-MM-DD)',
  'help.fx.rate.list.option.until': 'inclusive upper bound (YYYY-MM-DD)',
  'help.fx.rate.list.option.rate_type': 'only rates of this type',
  'help.fx.rate.list.option.source': 'only rates from this source',
  'help.fx.rate.show.description': 'Resolve the applicable rate: direct, then inverse, then crossed through USD',
  'help.fx.rate.show.argument.pair': 'currency pair, e.g. USD/MXN',
  'help.fx.rate.show.argument.date': 'date the rate applies to (YYYY-MM-DD)',
  'help.fx.rate.show.option.rate_type': 'rate type to resolve',
  'help.fx.rate.show.option.source': 'resolve using only this publisher',
  'help.fx.rate.set.description': 'Record an exchange rate, naming its source',
  'help.fx.rate.set.argument.pair': 'currency pair, e.g. USD/MXN',
  'help.fx.rate.set.argument.date': 'effective date (YYYY-MM-DD)',
  'help.fx.rate.set.argument.rate': 'the rate, up to 10 decimals',
  'help.fx.rate.set.option.source': 'who published the rate (required)',
  'help.fx.rate.set.option.rate_type': 'rate type',
  'help.fx.rate.set.option.until': 'last date the rate remains effective (YYYY-MM-DD)',
  'help.fx.rate.set.option.dry_run': 'show what would be recorded without writing',
  'help.fx.rate.download.description':
    'Download the DOF or Banxico FIX rate, stored per source (they differ on the same day)',
  'help.fx.rate.download.option.source': 'which publisher to download from (required)',
  'help.fx.rate.download.option.as_of': 'single date to download (YYYY-MM-DD)',
  'help.fx.rate.download.option.since': 'inclusive lower bound (YYYY-MM-DD)',
  'help.fx.rate.download.option.until': 'inclusive upper bound (YYYY-MM-DD)',
  // ==== MNE-001-243 · help by key, entity, init, onboard, lang, login, ask, chat, compact, drafts, review, sessions, prompt-size, ai, doctor and usage (issue #314) ====
  //
  // The setup and session families whole, English as shown (the roots of ask,
  // chat, sessions, drafts, review, lang, onboard and login, and entity's
  // --minimum-wage-zone, were keyed before; ai's prose got its English in
  // #844). `lang` is whole in MNE-001-469's block (#889): its argument key is
  // that one's. Every generic flag keeps a key of its own: none of these texts
  // is the kernel's, and none of these leaves has an output --format. The usage
  // groupings travel as {choices}.
  'help.entity.description': 'Select and inspect the legal entity commands operate on',
  'help.entity.list.description': 'List the active legal entities',
  'help.entity.show.description': 'Show one entity — with no argument, the one commands would use, and why',
  'help.entity.show.argument.id_or_name': 'entity to describe; omit for the active one',
  'help.entity.use.description': 'Pin the entity that later commands operate on',
  'help.entity.use.argument.id_or_name': 'entity id, tax id, or a fragment of the name',
  'help.entity.create.description': 'Create a legal entity with its chart of accounts, roles and payroll mapping',
  'help.entity.create.argument.name': 'legal name of the company',
  'help.entity.create.option.tax_id': 'RFC (Mexico) or EIN (USA)',
  'help.entity.create.option.country': 'MX or USA',
  'help.entity.create.option.currency': "functional currency (defaults to the country's)",
  'help.entity.create.option.chart': 'auto | siempre | nunca — whether to seed the base chart',
  'help.entity.create.option.tax_regime': 'c_RegimenFiscal code: 601, 612, 626…',
  'help.entity.create.option.tax_postal_code': 'fiscal address postal code (5 digits)',
  'help.entity.create.option.json': 'JSON output',
  'help.entity.edit.description': 'Set the tax regime, fiscal postal code or minimum-wage zone of an entity',
  'help.entity.edit.argument.id_or_name': 'entity id, tax id, or a fragment of the name',
  'help.entity.edit.option.tax_regime': 'c_RegimenFiscal code: 601, 612, 626…',
  'help.entity.edit.option.tax_postal_code': 'fiscal address postal code (5 digits)',
  'help.entity.edit.option.reason': 'justification recorded in the audit trail',
  'help.entity.edit.option.json': 'JSON output',
  'help.entity.archive.description': 'Archive an entity (never deletes: its ledger has to survive)',
  'help.entity.archive.argument.id_or_name': 'entity to archive',
  'help.entity.unset.description': 'Clear the pinned entity; commands go back to requiring --entity',
  'help.init.description': 'Guided setup: infrastructure, entity, users, AI provider, and your books',
  'help.init.option.status': 'Only show the status, configure nothing',
  'help.init.option.section': 'Configure a single section (language|infra|identity|users|ai|policies|import)',
  'help.init.option.yes': 'Non-interactive: use defaults and flags, ask nothing',
  'help.init.option.tenant': 'Tenant',
  'help.init.option.entity': 'Name of the legal entity to create',
  'help.init.option.rfc': 'RFC/EIN of the entity',
  'help.init.option.country': 'MX | USA',
  'help.init.option.currency': 'Functional currency',
  'help.init.option.provider': 'Default AI provider',
  'help.init.option.model': 'Provider model',
  'help.init.option.user': 'Email of the user to create',
  'help.onboard.option.provider': 'External system, e.g. contalink',
  'help.onboard.option.cutoff': 'Cutoff date: opening balances are taken as of this date',
  'help.onboard.option.from':
    'Start of the remote trial balance period (default: January 1st of the cutoff year)',
  'help.onboard.option.entity': 'Target legal entity (id, RFC or name fragment)',
  'help.onboard.option.user': 'Who runs it (default: sole active user of the tenant)',
  'help.onboard.option.balance_account':
    'Balancing account if the remote trial balance does not sum to zero (e.g. 3200)',
  'help.onboard.option.post':
    'Post the opening balance immediately (default: stays as a draft for mnemosine review)',
  'help.onboard.option.dry_run': 'Only show the plan, without executing anything',
  'help.login.option.device': 'Use the device-code flow (SSH, server without a browser)',
  'help.ask.argument.question': 'The question for the assistant',
  'help.ask.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.ask.option.provider': 'Model provider (see: mnemosine providers)',
  'help.ask.option.model': 'Override the profile model',
  'help.chat.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.chat.option.provider': 'Model provider (see: mnemosine providers)',
  'help.chat.option.model': 'Override the profile model',
  'help.chat.option.continue':
    'Resume the latest session of this terminal/entity (transcript continuity; the model context starts fresh)',
  'help.chat.option.resume': 'Resume a specific session by id (see: mnemosine sessions)',
  'help.chat.option.no_banner': 'Suppress the startup banner (also: MNEMOSINE_NO_BANNER=1)',
  'help.compact.description': 'Dry-run compaction report for a session transcript (no API calls)',
  'help.compact.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.compact.option.tenant': 'Tenant',
  'help.compact.option.session': 'Session id (default: the most recent session)',
  'help.compact.option.keep': 'Recent tail to keep intact, in tokens',
  'help.compact.option.json': 'JSON output',
  'help.drafts.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.drafts.option.status': 'pending_review | approved | rejected',
  'help.review.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.review.option.user': 'Reviewer email (default: first active user of the tenant)',
  'help.sessions.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.sessions.option.limit': 'Maximum number of sessions to show',
  'help.prompt_size.description': 'Offline breakdown of the system prompt and tool schemas (no API calls)',
  'help.prompt_size.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.prompt_size.option.tenant': 'Tenant',
  'help.prompt_size.option.json': 'JSON output',
  'help.ai.description': 'Metrics and calibration of the accounting agent',
  'help.ai.stats.description': 'Approval by confidence bucket, confidence-vs-reality delta, cost and events',
  'help.doctor.description': 'Diagnoses system health: DB, migrations, provider, credentials, isolation',
  'help.doctor.option.json': 'JSON output for scripts',
  'help.usage.description': 'Token usage and estimated cost from the local ledger (no API calls)',
  'help.usage.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.usage.option.tenant': 'Tenant',
  'help.usage.option.since': 'Window: Nd (e.g. 7d, 30d) or YYYY-MM-DD',
  'help.usage.option.by': 'Group by: {choices}',
  'help.usage.option.json': 'JSON output',
  // ==== MNE-001-244 · help by key, jobs, webhooks and outbox (issue #314) ====
  //
  // Operations 1/2: the three families whole, English as shown. `jobs adopt`,
  // `jobs unadopt`, `outbox list` and the `outbox` root were born keyed. The
  // lists of `jobs create --kind` and `webhooks create --source` are
  // parameters: machine values, not translated. Every generic flag a leaf
  // declares keeps a key of its own: «Legal entity (id, RFC or name fragment)»
  // and «Tenant» are not the texts of cli.flag.entity and cli.flag.tenant_scope.
  'help.jobs.description': 'Persisted scheduled agent tasks (all output is reviewable drafts, never direct writes)',
  'help.jobs.list.description': 'List the scheduled jobs of this entity',
  'help.jobs.list.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.jobs.list.option.tenant': 'Tenant',
  'help.jobs.create.description': 'Create a scheduled job',
  'help.jobs.create.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.jobs.create.option.tenant': 'Tenant',
  'help.jobs.create.option.name': 'Job name (unique per entity)',
  'help.jobs.create.option.kind': 'Job kind: {kinds}',
  'help.jobs.create.option.schedule': '5-field cron expression, e.g. "0 2 * * *" (nightly at 02:00)',
  'help.jobs.create.option.max_failures': 'Auto-disable after N consecutive failures (default 3)',
  'help.jobs.create.option.user': 'Who creates the job (audit)',
  'help.jobs.enable.description': 'Enable a job (resets its failure counter and recomputes the next run)',
  'help.jobs.enable.argument.job_id': 'Job id',
  'help.jobs.enable.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.jobs.enable.option.tenant': 'Tenant',
  'help.jobs.disable.description': 'Disable a job (it stays configured; runs stop)',
  'help.jobs.disable.argument.job_id': 'Job id',
  'help.jobs.disable.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.jobs.disable.option.tenant': 'Tenant',
  'help.jobs.run_due.description':
    'Tick entry point: claim and run every due job (call this from cron/launchd; --live enables the external reads)',
  'help.jobs.run_due.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.jobs.run_due.option.tenant': 'Tenant',
  'help.jobs.history.description': 'Execution log (most recent first)',
  'help.jobs.history.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.jobs.history.option.tenant': 'Tenant',
  'help.jobs.history.option.job': 'Only this job',
  'help.jobs.history.option.limit': 'Rows to show (default 20)',
  'help.webhooks.description': 'Inbound webhook tokens: dedicated credentials that wake a restricted reader agent',
  'help.webhooks.create.description': 'Create a webhook token (the raw token is shown ONCE and never stored)',
  'help.webhooks.create.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.webhooks.create.option.tenant': 'Tenant',
  'help.webhooks.create.option.source': 'Source kind: {kinds}',
  'help.webhooks.list.description': 'List webhook tokens (names and usage — never token values)',
  'help.webhooks.list.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.webhooks.list.option.tenant': 'Tenant',
  'help.webhooks.list.option.json': 'JSON output',
  'help.webhooks.disable.description': 'Disable a webhook token (deliveries with it start failing with 401)',
  'help.webhooks.disable.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.webhooks.disable.option.tenant': 'Tenant',
  'help.webhooks.deliveries.description': 'Recent inbound deliveries: status, drafts created and suspicion flags',
  'help.webhooks.deliveries.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.webhooks.deliveries.option.tenant': 'Tenant',
  'help.webhooks.deliveries.option.limit': 'Rows to show (1-200)',
  'help.webhooks.deliveries.option.json': 'JSON output',
  'help.outbox.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.outbox.option.user': 'Who executes (default: sole active user of the tenant)',
  'help.outbox.option.list': 'Only list, without executing (deprecated: use `outbox list`)',
  'help.outbox.run.argument.id': 'operation ids to execute; omit to review the whole queue interactively',
  'help.outbox.run.option.entity': 'Legal entity (id, RFC or name fragment)',
  'help.outbox.run.option.user': 'Who executes (default: sole active user of the tenant)',
  // ==== MNE-001-428 · help by key, audit, backup, status, subscription and completion (issue #314) ====
  'help.audit.description': 'Read the audit trail: who changed what, when, and from which value',
  'help.audit.list.description': 'Audit trail of mutations: who, when, which object, and which fields changed',
  'help.audit.list.option.user': 'only entries written by this user (email); this command attributes nothing',
  'help.audit.list.option.since': 'inclusive lower bound on the entry timestamp (YYYY-MM-DD)',
  'help.audit.list.option.until': 'inclusive upper bound on the entry timestamp (YYYY-MM-DD)',
  'help.audit.list.option.actor': 'human | agent | agent:<session> (see the note on --actor agent)',
  'help.audit.list.option.action': 'one of: {actions}',
  'help.audit.list.option.object': 'object family: {families}; with no value, lists them',
  'help.audit.list.option.entity_type': 'exact audit_log.entity_type value, when the family is not enough',
  'help.audit.show.description': 'One audit entry in full: the value before, the value after, and the reason',
  'help.audit.show.option.user': 'only entries written by this user (email); this command attributes nothing',
  'help.audit.show.argument.id': 'audit_log row id (the id column of `audit list`)',
  'help.backup.description':
    'Logical backups of the whole installation (create, list, verify by rehearsing the restore, restore) and per-tenant logical exports (export)',
  'help.backup.create.description': 'Take a logical dump of the WHOLE installation with its schema-version manifest',
  'help.backup.create.option.tenant':
    'NOT here: this dump is not scoped. A per-tenant archive is `mnemosine backup export --tenant <id>`',
  'help.backup.create.option.entity': 'NOT here: a per-entity archive is `mnemosine backup export --entity <idOrName>`',
  'help.backup.create.option.target': 'directory to write into (default: {dir})',
  'help.backup.create.option.json': 'JSON output',
  'help.backup.export.description':
    "Logical EXPORT of ONE tenant (or one entity): consistent, scoped by the database's own RLS, with a manifest. NOT a restorable backup",
  'help.backup.export.option.tenant': 'tenant (firm) to export (defaults to --tenant / MNEMOSINE_TENANT)',
  'help.backup.export.option.entity': 'narrow it further to one legal entity of that tenant',
  'help.backup.export.option.target': 'directory to write into (default: {dir})',
  'help.backup.export.option.json': 'JSON output',
  'help.backup.list.description':
    'List known backups and exports with their date, scope, size, schema version and whether their hash still matches',
  'help.backup.list.option.target': 'directory to read (default: {dir})',
  'help.backup.verify.description':
    'Verify a backup against its manifest; with --restore, rehearse the restore and run the ledger checks',
  'help.backup.verify.argument.file': 'backup file to verify',
  'help.backup.verify.option.restore':
    'RESTORE it into a throwaway database and run the ledger checks (the only real proof)',
  'help.backup.verify.option.strict': 'exit 4 on warnings too',
  'help.backup.restore.description': 'Restore a backup into a NEW database; never over an existing one',
  'help.backup.restore.argument.file': 'backup file to restore',
  'help.backup.restore.option.target': 'name of the NEW database to create and restore into',
  'help.backup.restore.option.json': 'JSON output',
  'help.status.description': 'Health snapshot: config, live provider probes, database and RLS (redacted, shareable)',
  'help.status.option.all': 'Probe every configured profile, not only the active failover chain',
  'help.status.option.tenant': 'Tenant (for the RLS-active check)',
  'help.status.option.json': 'JSON output (same redacted structure, for support tickets)',
  'help.status.option.strict':
    'Also exit 1 when any provider probe fails or is skipped (by default only database unreachability fails the command)',
  'help.subscription.delivery.description': 'Outbound delivery log and retries',
  'help.subscription.delivery.sweep.description':
    'Retry every outbound delivery whose retry time has passed, with exponential backoff; deliveries that exhaust their attempts are declared dead and reported (call this from cron)',
  'help.subscription.delivery.sweep.option.tenant': 'Tenant to sweep (defaults to MNEMOSINE_TENANT)',
  'help.subscription.delivery.sweep.option.all_tenants': 'Sweep every active tenant, each under its own tenant context',
  'help.subscription.delivery.sweep.option.limit': 'Max deliveries per tenant in this pass',
  'help.subscription.delivery.sweep.option.json': 'JSON output',
  'help.completion.description': 'Print a shell completion script (bash, zsh) on stdout',
  'help.completion.argument.shell': 'Shell to generate for: {list} or {last}',
  // ==== I11 · report labels (issue #153) ============================
  //
  // The section is identified by `key` since #253; these are its labels, and
  // only a HUMAN surface renders them. The service keeps coining English
  // `name`, the agent keeps consuming `key`, and the machine formats of the
  // CLI carry the key intact (kernel/output.ts, `labelled`).
  //
  // There are nineteen, not the six the issue counted: six sections plus the
  // thirteen subsections, which are not literals but the values of
  // `fs_category` — the twelve of migration 078's CHECK plus `other`.
  'report.section.assets': 'Assets',
  'report.section.liabilities': 'Liabilities',
  'report.section.equity': 'Equity',
  'report.section.revenue': 'Revenue',
  'report.section.expenses': 'Expenses',
  // Both words, always. The label does not depend on the sign — a
  // sign-dependent one would be a presentation criterion and would belong in
  // the configuration panel (decided in #153).
  'report.section.result_of_the_period': 'Profit (loss) for the period',
  'report.category.current_assets': 'Current assets',
  'report.category.non_current_assets': 'Non-current assets',
  'report.category.current_liabilities': 'Current liabilities',
  'report.category.long_term_liabilities': 'Long-term liabilities',
  'report.category.equity': 'Contributed capital',
  'report.category.earned_capital': 'Reserves and retained earnings',
  'report.category.ori': 'Other comprehensive income',
  'report.category.revenue': 'Revenue',
  'report.category.cogs': 'Cost of sales',
  'report.category.operating_expenses': 'Operating expenses',
  'report.category.other_income': 'Other income',
  'report.category.other_expenses': 'Other expenses',
  'report.category.tax': 'Taxes',
  'report.category.other': 'Other',
  'report.group.earned_capital': 'Earned capital',
  'report.total_of': 'Total {name}',
  'report.total_liabilities_and_equity': 'Total liabilities and equity',
  'report.net_income': 'Net income',
  'report.balance_check': 'Assets {assets} = Liabilities + Equity {total}',
  'report.income_summary': 'Revenue {revenue}   Expenses {expenses}   Net income {net}',

  // ==== MNE-001-647 · the totals of an aged listing, per currency (#596) ====
  'report.aging.total.receivable':
    'Total due {amount} {currency} across {count, plural, one {# open invoice} other {# open invoices}}',
  'report.aging.total.payable':
    'Total due {amount} {currency} across {count, plural, one {# open bill} other {# open bills}}',
  'report.aging.total_foreign.receivable':
    'Total due {amount} {currency} across {count, plural, one {# open invoice} other {# open invoices}}; book value {book} {functional}',
  'report.aging.total_foreign.payable':
    'Total due {amount} {currency} across {count, plural, one {# open bill} other {# open bills}}; book value {book} {functional}',
  'report.aging.book_value.receivable':
    'Book value of {count, plural, one {the open invoice} other {the # open invoices}}: {book} {functional}',
  'report.aging.book_value.payable':
    'Book value of {count, plural, one {the open bill} other {the # open bills}}: {book} {functional}',

  // ==== I11 · doctor by key (MNE-001-475, issue #153) ====
  //
  // The Spanish prose six checks of src/ai/doctor-service.ts wrote in place,
  // their one Spanish label, and the verdict of renderDoctor. `id` and `level`
  // are the machine's and stay out of the catalogue; commands, tables and
  // Postgres words inside the prose are typed or matched, so they stay as written.
  /** The label of `conflicting-permissions`; it must share no word with the id. */
  'doctor.check.permission_conflicts': 'Segregation of duties (user access)',
  'doctor.summary.title': 'Mnemosine health check',
  'doctor.summary.fail': 'There are failures that prevent operation. Resolve them in the order shown.',
  'doctor.summary.warn': 'Operational with warnings.',
  'doctor.summary.ok': 'All good.',
  /** `sample` is the first three `command: detail` of the audit, which #150 keeps untranslated. */
  'doctor.cli_consistency.new_violations': '{count, plural, one {# new violation} other {# new violations}} — {sample}',
  'doctor.cli_consistency.new_violations_fix':
    'The CLI surface stays consistent because every verb comes from a closed list and every flag from the single dictionary. ' +
    'Fix the command, or —if the change is deliberate— extend the vocabulary in src/cli/kernel/vocabulary.ts. ' +
    'The baseline in src/cli/kernel/audit.ts is NOT extended.',
  'doctor.cli_consistency.stale':
    '{count, plural, one {# baseline entry is no longer violated: delete it} other {# baseline entries are no longer violated: delete them}}',
  /** `stale` is empty, or « · » and the text of `doctor.cli_consistency.stale`. */
  'doctor.cli_consistency.inherited':
    'no new violations; {count, plural, one {# inherited one remains} other {# inherited ones remain}} in the baseline{stale}',
  'doctor.cli_consistency.clean': 'the surface meets every rule{stale}',
  'doctor.cli_consistency.inherited_fix':
    'The inherited ones are known, frozen debt: nine are naming decisions, three require retiring a short form already published, ' +
    'and eight ask for four listings to be paginated.',
  'doctor.ledger_integrity.ok': 'account_balances = Σ posted lines, and everything posted has its trail',
  /** `capped` is `yes` when the query hit its LIMIT 20. */
  'doctor.ledger_integrity.drift':
    '{count}{capped, select, yes {+} other {}} (account, period) where account_balances ≠ Σ posted lines — every report on top inherits the difference',
  'doctor.ledger_integrity.untraced':
    "{count, plural, one {# posted entry} other {# posted entries}} without a 'post' row in audit_log — facts with no author",
  'doctor.ledger_integrity.fix':
    'Balance drift is investigated BEFORE recalculating: since migration 041 a posted line cannot be edited, ' +
    'so a new difference points at the write path of account_balances, not at the lines.',
  'doctor.permission_conflicts.ok': 'no active user holds conflicting permissions',
  'doctor.permission_conflicts.fix':
    'Split the conflicting permissions between different users, or accept the risk knowingly ' +
    '(in a one-person firm it is unavoidable; the per-entry maker-checker lives in the panel: segregacion_de_funciones).',
  /** `list` is `table.trigger=state`, as pg_trigger spells it. */
  'doctor.guarantee_triggers.unsealed':
    '{loose} of {total, plural, one {# guarantee} other {# guarantees}} unsealed{off, plural, =0 {} other { (# DISABLED)}}: {list}',
  'doctor.guarantee_triggers.fix': 'ALTER TABLE <table> ENABLE ALWAYS TRIGGER <trigger>  — and find out WHO disabled it and why',
  'doctor.guarantee_triggers.ok':
    '{count, plural, one {# guarantee in ENABLE ALWAYS: not even session_replication_role silences it} other {# guarantees in ENABLE ALWAYS: not even session_replication_role silences them}}',
  'doctor.bank_statements.unnamed_file': '(unnamed)',
  /** How many tenants the check read: a green that does not say so is green by not looking. */
  'doctor.bank_statements.scope':
    '{tenants, plural, one {# tenant checked} other {# tenants checked}}{blind, plural, =0 {} other {, # could not be checked}}',
  'doctor.bank_statements.unrepaired': 'this database recorded migration 051 before its correction',
  'doctor.bank_statements.unique_index': 'the content index is UNIQUE and swallows legitimately identical transactions',
  'doctor.bank_statements.blind_trigger': 'the trigger does not watch content_hash, so the fingerprint can be forged by hand',
  'doctor.bank_statements.already_missing':
    '{lines, plural, one {# line is} other {# lines are}} already missing in {statements, plural, one {# statement} other {# statements}}: {detail}',
  'doctor.bank_statements.unrepaired_fix':
    'npm run migrate  — applies 072; lines already lost must be re-imported by hand: the remedy gives back the capacity, not the data',
  /** It does not say «missing»: a line skipped as a duplicate of an overlapping statement is not lost. */
  'doctor.bank_statements.short':
    '{lines, plural, one {# line declared and not present} other {# lines declared and not present}} in {statements, plural, one {# statement} other {# statements}} ({scope}): {detail}',
  'doctor.bank_statements.short_fix':
    'compare before touching anything: if those lines are in the account under ANOTHER statement of an overlapping period, ' +
    'the database is sound and this is the declared gap of 051. Only if they appear nowhere was there a loss, and then the file is ' +
    're-imported with the account in view of a human — never by removing the bank_statements row, which is evidence',
  'doctor.bank_statements.blind':
    'the catalogue is repaired, but {scope}: without reading their statements I cannot say they are complete',
  'doctor.bank_statements.blind_fix': 'check that the application role can query bank_statements with a tenant context',
  'doctor.bank_statements.ok':
    'the content index is not unique, the trigger enforces the fingerprint, and no statement has fewer lines than it declared ({scope})',
  'doctor.auditor_role.missing':
    'mnemosine_auditor does not exist: giving an outside auditor access today means lending them WRITE credentials over the books',
  'doctor.auditor_role.missing_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  (it does not fit in a migration: the migrator has no CREATEROLE, on purpose)',
  /** The four grave findings follow «mnemosine_auditor», joined by «; ». */
  'doctor.auditor_role.bypasses_rls': 'IGNORES RLS (BYPASSRLS): it sees the books of ALL tenants',
  'doctor.auditor_role.superuser': 'is a SUPERUSER',
  'doctor.auditor_role.creates_roles': 'can create roles',
  'doctor.auditor_role.writes': 'has WRITE on {grants}',
  'doctor.auditor_role.grave_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  — the script reasserts NOBYPASSRLS and revokes; also find out WHO granted it',
  'doctor.auditor_role.login':
    'mnemosine_auditor has LOGIN: it is meant as a privilege bundle granted to NAMED accounts (one per auditor), not as a shared account',
  'doctor.auditor_role.login_fix':
    'ALTER ROLE mnemosine_auditor NOLOGIN;  and issue one account per person: CREATE ROLE <auditor> LOGIN IN ROLE mnemosine_auditor',
  'doctor.auditor_role.matviews':
    'mnemosine_auditor reads {count, plural, one {# materialized view} other {# materialized views}} ({views}): ' +
    'RLS does not filter them and a role with BYPASSRLS builds them, so they hold the books of ALL tenants',
  'doctor.auditor_role.matviews_fix': "psql \"$SUPERUSER_URL\" -f scripts/rol-auditor.sql  — its block 4 revokes every relkind = 'm'",
  'doctor.auditor_role.coverage_unmeasured':
    'mnemosine_auditor exists and is well bounded, but its table coverage could not be measured',
  'doctor.auditor_role.coverage_unmeasured_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  (its verification block prints both counts)',
  'doctor.auditor_role.ungranted':
    'mnemosine_auditor reads only {readable} of the {total} isolated tables: ' +
    '{missing, plural, one {# table was} other {# tables were}} created after the last GRANT',
  'doctor.auditor_role.ungranted_fix':
    'psql "$SUPERUSER_URL" -f scripts/rol-auditor.sql  (grants again and sets the default privileges for whatever comes next)',
  'doctor.auditor_role.global_tables':
    'also {count, plural, other {# without a tenant, which must be global reference only}} ({tables})',
  /** `note` is empty, or «; » and the text of `doctor.auditor_role.global_tables`. */
  'doctor.auditor_role.ok': 'read-only on {count} isolated tables, NOLOGIN and subject to RLS{note}',
  // ==== end of I11 · doctor by key ====
  // ==== NVIDIA's hosted trial (MNE-001-448, #644 P8) ====
  // The terms init, chat and ask print before a session on the hosted catalog,
  // and the refusals of src/ai/providers/trial-endpoint.ts.
  'providers.trial.terms.what':
    "{profile} uses NVIDIA's hosted API catalog ({host}), a trial for development and evaluation.",
  'providers.trial.terms.records':
    "NVIDIA's API Trial Terms of Service let it record what you send and what comes back, and ask you not to send personal data: never send it a client's books or documents.",
  'providers.trial.terms.limits':
    'Its endpoints can be retired without notice. For client work choose another provider, or NVIDIA NIM on your own host.',
  'providers.trial.accept_default': 'Save {profile} as your default provider under these terms?',
  'providers.trial.not_saved': 'Terms not accepted: {profile} was not saved as the default.',
  'providers.trial.accept_session': 'Use {profile} for this session under these terms?',
  'providers.trial.refused.unattended':
    "{profile} is on NVIDIA's hosted trial ({host}), which records what it receives: ingest, jobs run-due and init's import never open a session there. Choose another provider for them.",
  'providers.trial.refused.no_terminal':
    "{profile} is on NVIDIA's hosted trial ({host}), whose terms need a yes at a terminal, and there is none here. Run it at a terminal, or choose another provider.",
  'providers.trial.refused.declined': 'Terms not accepted: no session was opened on {profile}.',
  'providers.trial.refused.not_accepted':
    "{profile} is on NVIDIA's hosted trial ({host}), and its terms were not accepted in this session. Start mnemosine chat --provider {profile} at a terminal to read and accept them.",
  // --- pay-run · corrida (MNE-001-068) -----------------------------------
  'payrun.file_invalid': 'The inputs file {path} cannot be used: {detail}. Nothing was calculated.',
  'payrun.file_duplicate_employee':
    'Employee {employee} appears twice in {path}: a run has one paycheck per employee. Nothing was calculated.',
  'payrun.create.period_required':
    'Missing --period: a run belongs to one pay period of the entity, and it is not guessed from the clock.',
  'payrun.create.next': 'Next: `mnemosine pay-run calculate {id} --file <inputs.json>`.',
  // A period holds one regular run (MNE-001-659, #601).
  'payrun.create.regular_run_exists':
    'Pay period {period} already has a regular run, {run}, in status {status}: a period holds one regular run. ' +
    'No run was created. That run is calculated again while it is not approved; a payment apart from the ' +
    'regular one (a year-end bonus, a final settlement, an off-cycle payment) goes in a run of that type ' +
    '(bonus, final, off_cycle).',
  'payrun.calculate.file_required':
    'Missing --file: the employee inputs of the period (earnings and deductions) come from a JSON file.',
  'payrun.calculate.next': 'Next: `mnemosine pay-run approve {id} --dry-run` to see what approving writes.',
  'payrun.calculate.paycheck_left_the_system':
    'Run {id} cannot be calculated again: {count, plural, one {# of its paychecks already has} ' +
    'other {# of its paychecks already have}} a payroll CFDI or a deposit batch, and calculating again ' +
    'replaces every paycheck of the run. Nothing was changed.',
  'payrun.calculate.changed_meanwhile': 'Run {id} changed while it was being calculated. Nothing was written.',
  // A yearly parameter whose new row is not loaded by the pay date (MNE-001-636, #953).
  'payrun.calculate.stale_parameter':
    '{parameter}: on the pay date {pay_date} the value in force is still {value}, which rules since {since}. ' +
    'Its new value was due from {due} and is not loaded, so the run is calculated with {value}; no amount ' +
    'was changed. Load the new value from its DOF publication and calculate the run again.',
  'payroll.parameter.minimum_wage_general': 'General minimum wage',
  'payroll.parameter.minimum_wage_border': 'Minimum wage of the northern border free zone',
  'payroll.parameter.uma_daily': 'Daily UMA',
  'payroll.parameter.uma_monthly': 'Monthly UMA',
  'payrun.approve.confirm':
    'You are about to APPROVE run {id} ({employees, plural, one {# employee} other {# employees}}, ' +
    'net pay {net}) and write its employer liability. Approval is not undone. Continue?',
  'payrun.approve.aborted': 'Nothing changed: the run was not approved.',
  'payrun.approve.done': 'Run {id} approved · {status}',
  'payrun.approve.repeated': 'Run {id} was already approved under this key: the recorded result is shown · {status}',
  'payrun.approve.dry_run': 'Dry run: run {id} was approved and rolled back; it is still {status}.',
  // --- pay-schedule (MNE-001-403, #587) · pay-period (MNE-001-404, #613) --
  'paycalendar.value_invalid': '{flag} {value} is not valid: use one of {allowed}. Nothing was written.',
  'paycalendar.number_invalid': '{flag} {value} is not valid: use a whole number from {min} to {max}.',
  'paycalendar.schedule.name_required': 'Missing --name: a pay schedule needs a name the accountant recognises.',
  'paycalendar.schedule.name_too_long': '--name is longer than {max} characters: shorten it. Nothing was written.',
  'paycalendar.schedule.first_start_invalid':
    '--first-start {value} is not a date (YYYY-MM-DD): it is the first day of the first period. Nothing was written.',
  'paycalendar.schedule.dry_run': 'Dry run: the schedule is valid; nothing was written.',
  'paycalendar.schedule.next': 'Next: `mnemosine pay-period create --schedule {id} --count <n> --dry-run`.',
  'paycalendar.schedule.empty': 'No pay schedule in this entity.',
  'paycalendar.period.schedule_required': 'Missing --schedule: periods belong to one pay schedule of the entity.',
  'paycalendar.period.count_required': 'Missing --count: how many periods to create, from 1 to {max}.',
  'paycalendar.period.dry_run':
    'Dry run: {count, plural, one {# period} other {# periods}} would be created; nothing was written.',
  'paycalendar.period.done':
    '{count, plural, =0 {No period created: they were already there.} one {# period created.} other {# periods created.}}',
  'paycalendar.period.empty': 'No pay period in this entity.',

  // --- `prepaid run` and its idempotency key (MNE-001-053, #317) ---------
  // MNE-001-299 · deferred-revenue create and run.
  'deferred_revenue.create.flags_missing':
    'Missing {flags}. A schedule with no amount, no service window or no word on where the credit came from cannot be recognized nor tied out against the liability.',
  'deferred_revenue.create.cfdi_needs_source_entry':
    '--origin cfdi needs --source-entry: the entry of the issued CFDI that credited the liability is known, and not keeping it loses it.',
  'deferred_revenue.create.dry_run_done':
    'Dry run: {count} month(s) of {amount}, cut {convention}. The real run first checks that the contract liability holds an unscheduled credit for it.',
  'deferred_revenue.create.done':
    'Schedule registered: {count} month(s), recognized by deferred-revenue run or by closing run.',
  'deferred_revenue.run.key_unneeded':
    'Not needed: the engine posts one row per schedule and period, so a retry of the same month posts nothing.',
  'deferred_revenue.run.nothing': 'No deferred-revenue schedule owes {period}.',
  'deferred_revenue.run.dry_run_done': 'Dry run: {count} schedule(s) would be recognized in {period}; nothing was posted.',
  'deferred_revenue.run.confirm': 'Post {count} recognition entry(ies) for {period}?',
  'deferred_revenue.run.aborted': 'Nothing was posted.',
  'deferred_revenue.run.done': '{count} schedule(s) recognized in {period}: {total} to revenue.',
  'prepaid.run.key_replayed':
    'Idempotency key already consumed: the recorded result is shown and nothing was accrued again.',
  /** `{entries}` are the ids the keyed run posted and someone reversed since. */
  'prepaid.run.key_reversed':
    'The key "{key}" recorded entries that were reversed afterwards ({entries}). Returning that ' +
    'result would say {period} is accrued when it is not. Run it again with a new key (it is ' +
    'another run, not a retry) or without --idempotency-key.',
  /** A keyed run that failed for some prepaids is not replayed while the month still misses any. */
  'prepaid.run.key_partial':
    'The key "{key}" recorded a run of {period} that failed for {failed} prepaid(s), and {pending} ' +
    'prepaid(s) are still not accrued in {period}. Replaying it would repeat that failure without ' +
    'trying again. Run it again with a new key (it is another run, not a retry) or without ' +
    '--idempotency-key; the errors are printed then.',
  /** `lock_timeout` ran out while another run with the same key was still working. */
  'prepaid.run.key_busy':
    'Another run with the key "{key}" is still working. Wait for it to finish and retry with the ' +
    'same key: the retry returns its recorded result.',

  // --- pay-run post · corrida contabilizar (MNE-001-069) ------------------
  'payrun.post.confirm':
    'You are about to POST the entry of run {id} to the ledger (debits {debits} = credits {credits}) ' +
    'without going through review. A posted entry is only undone by a reversal. Continue?',
  'payrun.post.aborted': 'Nothing changed: the entry was not posted.',
  'payrun.post.dry_run': 'Dry run: the entry of run {id} balances (debits {debits} = credits {credits}); nothing was written.',
  'payrun.post.drafted': 'Entry of run {id} left as draft {draft}: approve it with `mnemosine review`.',
  'payrun.post.posted': 'Entry of run {id} posted as {number}.',
  'payrun.post.repeated': 'The entry of run {id} was already written under this key: the recorded result is shown.',
  // Nothing leaves for a run nobody approved (MNE-001-720, #601).
  'payrun.cfdi.run_not_approved':
    'Paycheck {id} was not stamped: its run {run} is {status}, and a payroll CFDI is issued only for a run ' +
    'that is approved or paid. Nothing was sent to the PAC and nothing was written.',
  'payrun.deposit_file.run_not_approved':
    'No deposit file was built for run {id}: it is {status}, and a deposit file is built only for a run ' +
    'that is approved or paid. Nothing was written.',
  // A paycheck that holds a payroll CFDI is not stamped again (MNE-001-736, #601).
  'payrun.cfdi.already_stamped':
    'Paycheck {id} was not stamped again: it already has a payroll CFDI, folio {uuid} ({status}), stamped at ' +
    '{stamped_at}. A second stamp would be a second CFDI before the SAT for the same payment. Nothing was sent ' +
    'to the PAC and nothing was written.',
  'payrun.cfdi.stamp_in_progress':
    'Paycheck {id} was not stamped by this attempt: another stamp of it, or another change to it, is still in ' +
    'progress and this attempt stopped waiting. It sent nothing to the PAC and wrote nothing. Read the paycheck ' +
    'before asking again: if the other stamp ended, the paycheck carries its folio.',
  'payrun.cfdi.stamped_not_recorded':
    'Paycheck {id} WAS stamped: the PAC ({provider}) answered with folio {uuid}, and the folio could not be ' +
    'written on the paycheck. Do not stamp it again. Keep this folio: the paycheck does not carry it, and it is ' +
    'what a cancellation needs.',
  // The law row of the employment subsidy's excess over the ISR (#600).
  'payroll.separate_payment_isr.regulation_procedure_not_in_corpus':
    'The policy {key} says to withhold the ISR of this separate paycheck by the optional procedure of the Regulation (RLISR art. 174), and this system does not carry the text of that procedure, so it does not compute it from memory. Nothing was calculated. Answer {key} with another option in mnemosine pending, or have the text added to the normative corpus first.',
  'payroll.employment_subsidy.excess_rule_unknown':
    'The legal parameter {key} in force on the payment date {payDate} is {value} (row effective from {effectiveFrom}) ' +
    'and only 0 or 1 is a rule: 1 hands the subsidy in excess of the ISR to the worker in cash, 0 hands over nothing. ' +
    'Correct the row against its official source; no paycheck is calculated with a guessed share.',

  // --- e-accounting voucher|subledger generate (MNE-001-054, #328) --------
  'help.e_accounting.voucher.description': 'The period vouchers the SAT asks for on request: PolizasPeriodo 1.3',
  'help.e_accounting.voucher.generate.description':
    'Build and archive the period vouchers XML with the evidence node of each line (CompNal, Cheque, Transferencia, OtrMetodoPago) and its hash',
  'help.e_accounting.voucher.option.closing':
    'the vouchers of month 13, where the year-end adjustments fall; with it, --period names the fiscal year (2026)',
  'help.e_accounting.voucher.option.validate_uuids': 'also check the shape of every CFDI UUID the vouchers declare',
  'help.e_accounting.subledger.description': 'The auxiliaries the SAT asks for on request: voucher folios or accounts',
  'help.e_accounting.subledger.generate.description':
    'Build and archive the voucher-folio auxiliary (AuxiliarFolios 1.3) or the account and sub-account auxiliary (AuxiliarCtas 1.3) with its hash',
  'help.e_accounting.subledger.option.closing':
    'the auxiliary of month 13, where the year-end adjustments fall; with it, --period names the fiscal year (2026)',
  'help.e_accounting.subledger.option.kind': 'which auxiliary: folios (voucher folios) or accounts (account and sub-account); no default',
  'help.e_accounting.request.option.period':
    'period to declare: 2026-02, its name, or the fiscal period id; with --closing, the fiscal year (2026)',
  'help.e_accounting.request.option.request_type':
    'the request the file answers (TipoSolicitud): AF audit, FC compulsory check, DE refund, CO offset; no default',
  'help.e_accounting.request.option.order_number': 'audit order number (NumOrden), required with AF and FC: ABC1234567/26',
  'help.e_accounting.request.option.procedure_number': 'filing number (NumTramite), required with DE and CO: DE202600000009',
  'help.e_accounting.request.option.dry_run': 'build it and show the verdict; archive nothing and write no file',
  'help.e_accounting.request.option.output': 'write the XML to this path (the artifact store keeps its own copy)',
  'help.e_accounting.request.option.yes': 'skip the overwrite prompt when -o names an existing file',
  'e_accounting.request.type_missing':
    'Say which request the file answers with --request-type ({types}). Vouchers and auxiliaries are delivered on request, never on your own, and the file states which request it answers: there is no default.',
  'e_accounting.period.missing':
    'Say which month: --period YYYY-MM (or its name or id), or --closing for month 13 of the fiscal year.',
  'e_accounting.subledger.kind_missing':
    'Say which auxiliary with --kind: folios (voucher folios) or accounts (account and sub-account). There is no default: delivering the wrong one does not answer the request.',
  'e_accounting.subledger.kind_unknown': '--kind "{value}" does not exist: use folios or accounts.',
  'e_accounting.target.dry_run': '(dry run: nothing was written)',
  'e_accounting.target.not_written': '(not written: the file is blocked)',
  'e_accounting.request.type_unknown':
    'TipoSolicitud "{value}" does not exist. The Anexo 24 accepts {types}: AF audit, FC compulsory check, DE refund, CO offset. There is no default.',
  'e_accounting.request.order_missing':
    'TipoSolicitud {type} needs --order-number (NumOrden): the number of the audit order that asked for this file.',
  'e_accounting.request.order_not_filing':
    'TipoSolicitud {type} takes --order-number, not --procedure-number: both would say the file answers an audit and a refund or offset at once.',
  'e_accounting.request.filing_missing':
    'TipoSolicitud {type} needs --procedure-number (NumTramite): the number of the refund or offset filing this file supports.',
  'e_accounting.request.filing_not_order': 'TipoSolicitud {type} takes --procedure-number, not --order-number.',
  'e_accounting.request.order_shape':
    'NumOrden "{value}" does not have the SAT format: three letters, seven digits, a slash and two digits (ABC1234567/26). Any other value makes the schema reject the whole file.',
  'e_accounting.request.filing_shape':
    'NumTramite "{value}" does not have the SAT format: two letters and twelve digits (DE202600000009). Any other value makes the schema reject the whole file.',
  'e_accounting.target.store': '(artifact store)',
  'e_accounting.target.label': 'target {target}',
  'e_accounting.sealing.declared':
    'The firm declared "{policy}" in efirma_sellado_contabilidad_electronica, and this command does not seal: the file comes out without Sello, noCertificado or Certificado.',
  'e_accounting.dry_run.done': '--dry-run: nothing was archived and no file was written.',
  'e_accounting.archive.already_there':
    'These same bytes were already archived: no new version was created. The generator is deterministic.',
  'e_accounting.voucher.title': 'Vouchers {month}/{year}',
  'e_accounting.voucher.summary':
    '{vouchers, plural, one {# voucher} other {# vouchers}}, {traced} with payment trace · debit {debit} · credit {credit}',
  'e_accounting.voucher.blocked':
    'No deliverable file was produced: {blocking, plural, one {# blocking finding} other {# blocking findings}} above, each with its voucher number. Fix them and generate again.',
  'e_accounting.subledger.title_folios': 'Voucher-folio auxiliary {month}/{year}',
  'e_accounting.subledger.title_accounts': 'Account auxiliary {month}/{year}',
  'e_accounting.subledger.summary':
    '{vouchers, plural, one {# voucher} other {# vouchers}} · {lines, plural, one {# line} other {# lines}}',

  // --- payslip · recibo and imss sua export (MNE-001-070) -----------------
  'payslip.run_required': 'Missing --run: name the pay run whose paychecks you want (`pay-run create` printed its id).',
  'imss.sua.period_invalid': '--period "{period}": use the month as YYYY-MM, for example 2026-07.',
  'imss.sua.exists': '{path} already exists and is not overwritten without asking: use another path, or --yes.',
  'imss.sua.tty':
    'The SUA file carries the NSS, RFC and CURP of the whole roll and is not printed to a terminal: name a file with -o, or redirect stdout.',
  'imss.sua.mismatch': 'The SUA file does not match the employer liability already recorded, so it is not delivered: {findings}',
  'imss.sua.finding.no_liability':
    'the file declares {file} of {concept} and no employer liability is recorded for the month to check it against: the figure comes from one road only',
  'imss.sua.finding.mismatch': '{concept}: the file declares {file} and the recorded liability says {ledger}',
  'imss.sua.dry_run': 'Dry run: the SUA file of {count} employee(s) was built and checked; no file was written and nothing was recorded.',
  'payslip.status_invalid': '--status {status}: use one of {states}.',
  'imss.sua.not_filed':
    'SUA file of {count} employee(s) built and recorded as a draft filing. Nothing was sent: load it into the SUA and pay.',
  // --- e-accounting catalog|balance seal · sellar (EFIRMA-4, #442) --------
  'anexo24.seal.refused_by_policy':
    'Sealing is refused: the policy {policy} is "{value}", and the system seals with the e.firma only ' +
    'under "{optIn}". Nothing was decrypted and the access log has no row for this.',
  'anexo24.seal.done':
    'Sealed with the e.firma (certificate {certificate}): Sello, noCertificado and Certificado are set, ' +
    'and the file validates against the SAT XSD.',
  'anexo24.seal.nothing_filed':
    'NOTHING WAS FILED WITH THE SAT. The SAT has no web service to receive this file: upload it ' +
    'yourself in the SAT portal (Contabilidad electrónica) and keep the acknowledgement of receipt.',
  'help.e_accounting.catalog.seal.description':
    'Seal the archived CtaCatalogo of a month with the entity e.firma (only under sellar_con_custodia); files nothing',
  'help.e_accounting.balance.seal.description':
    'Seal the archived trial balance of a period with the entity e.firma (only under sellar_con_custodia); files nothing',
  'help.e_accounting.seal.option.period': 'month of the archived file: YYYY-MM (the fiscal year with --closing)',
  'help.e_accounting.catalog.seal.option.period': 'month of the archived catalog: YYYY-MM',
  'help.e_accounting.balance.check.option.type': 'envelope type to check: N normal, C amended (needs --modified)',
  'help.e_accounting.balance.check.option.modified': 'FechaModBal of the amended balance; required with --type C',
  'anexo24.seal.not_archived':
    'There is no archived, unsealed {document} for {period}: generate it first, review it, then seal it.',
  'anexo24.seal.rfc_mismatch':
    'The e.firma belongs to {certificateRfc} and the document declares {documentRfc}: it is not sealed.',
  'anexo24.seal.not_sat_serial':
    'The certificate serial {serial} is not a SAT certificate number (20 digits): it cannot go in noCertificado.',
  'anexo24.seal.separator_in_attribute':
    'It is not sealed: {element} (account {account}) has "|" in {attribute} ("{value}"). The Anexo 24 forbids "|" in ' +
    'any attribute because it separates the fields of the cadena original. Fix the value and generate again.',
  'anexo24.seal.source_invalid':
    'It is not sealed: the archived file does not validate against the SAT XSD ({errors}). Nothing was decrypted.',
  // --- e-accounting catalog|balance generate · the official XSD (#608) ----
  'anexo24.xsd.rejected':
    'The SAT XSD ({schema}) does not accept this file, so it is not deliverable: {errors}' +
    '{more, plural, =0 {} one {; and # more line} other {; and # more lines}}',
  'anexo24.xsd.not_validated':
    'This file was not validated against the SAT XSD ({schema}) because xmllint did not run ({cause}), so it is ' +
    'not deliverable. Install libxml2-utils (apt, apk) or libxml2 (Homebrew), confirm it with `mnemosine doctor` ' +
    'and generate again.',
  // --- balance check · the xsd check (MNE-001-774, #608) -----------------
  'anexo24.xsd.not_built':
    'No file was built to check against the SAT XSD ({schema}), so `balance generate` refuses it as well: {cause}',
  // --- end of MNE-001-774 ---
  // --- e-accounting balance · the builder's own rules (MNE-001-775, #608) ---
  'anexo24.balance.rfc':
    'The entity RFC «{rfc}» is not one the SAT XSD (BalanzaComprobacion_1_3.xsd) accepts: 3 or 4 letters, the ' +
    'date as YYMMDD (a month digit 0-1, a day digit 0-3) and a homoclave of 3. The Anexo 24 trial balance is ' +
    'filed by a Mexican taxpayer; an entity identified by an EIN or another number cannot file it.',
  'anexo24.balance.month':
    'Month «{month}» is not valid: the Anexo 24 takes 01..12, and 13 for the year-end balance (Mes).',
  'anexo24.balance.year': 'Anio {year} is outside the range the schema accepts ({min}..{max}).',
  'anexo24.balance.amended_without_date':
    'An amended balance (TipoEnvio C) needs FechaModBal, the date it was modified: without it the authority ' +
    'cannot tell which filing it corrects.',
  'anexo24.balance.normal_with_date':
    'FechaModBal only goes in an amended balance; this one is normal (TipoEnvio N). A normal balance with a ' +
    'modification date declares two things that contradict each other.',
  'anexo24.balance.modified_date':
    'FechaModBal «{date}» is not a date the SAT XSD accepts: a real day, YYYY-MM-DD, on or after 2015-01-01.',
  'anexo24.balance.no_accounts':
    'The balance {month}/{year} has no account to declare. A file with no Ctas node tells the authority there ' +
    'was no bookkeeping in that period.',
  'anexo24.balance.account_number_length':
    'Account «{account}» has a NumCta of {length, plural, one {# character} other {# characters}}; the SAT XSD ' +
    'accepts 1 to 100, and rejects the whole file.',
  'anexo24.balance.repeated_account':
    'Repeated NumCta in the balance: {accounts}. Two Ctas nodes with the same number declare two balances for ' +
    'one account, and the authority keeps one of them.',
  'anexo24.balance.amount_out_of_range':
    'Account {account} declares {column} {amount}, outside what the SAT XSD accepts for an amount (t_Importe: ' +
    'more than -9999999999999999999999.99 and at most 9999999999999999999999.99): it rejects the whole file.',
  // --- end of MNE-001-775 ---
  'help.e_accounting.seal.option.type': 'envelope type of the archived balance: N normal, C amended',
  'help.e_accounting.seal.option.closing': 'the year-end balance, archived as month 13',
  'help.e_accounting.seal.option.output': 'also write the sealed XML to this path',

  // ==== MNE-001-418 · help by key, cfdi post (issue #620) ====
  'help.cfdi.post.description':
    'Post a CFDI this entity issued to receivables: the customer invoice with its UUID, and its entry',
  'help.cfdi.post.argument.uuid': 'UUID of a CFDI this entity issued, as cfdi list prints it',
  'help.cfdi.post.option.account': 'revenue account, by code or id, of every concept with no account of its own',
  'help.cfdi.post.option.json': 'one row: invoice number, status, amount due, entry number and dry_run',
  'cfdi.lookup.same_uuid_twice':
    'CFDI {uuid} is stored {count} times in this entity, under UUIDs that differ only in letter case: {stored}. ' +
    'They are one fiscal folio, so none was picked. Until only one of them is kept, this CFDI cannot be read by its UUID.',
  'cfdi.post.bad_uuid':
    '"{uuid}" is not a CFDI UUID. List the issued CFDI to post with: mnemosine cfdi list --direction emitido --type cfdi_ingreso --status pending',
  'cfdi.post.confirm':
    'Post CFDI {uuid} ({rfc}, {total} {currency}, MetodoPago {method, select, none {missing} other {{method}}}) to receivables? This cannot be undone.',
  'cfdi.post.no_terminal':
    '{question} There is no terminal to ask on: run it again with --yes once you are sure, or with --dry-run to see the effect first.',
  'cfdi.post.would_post': 'Would post CFDI {uuid} as {invoice} for {rfc} · entry {entry}',
  'cfdi.post.posted': 'CFDI {uuid} posted as {invoice} for {rfc} · entry {entry} · {due} due',
  // MNE-001-431 (#643): `cfdi status sync` and `cfdi status show --refresh` report the bills they marked.
  'cfdi.status.bills_marked':
    '{count, plural, one {# bill} other {# bills}} carrying a CFDI the SAT reports cancelled got the mark. ' +
    'Nothing was reversed: status, entry and balance stay until the accountant decides.',
  'cfdi.post.nothing_written':
    'Nothing was written. To code one concept first: mnemosine bill inbox edit {id} --line <n> --account <code>',
  'cfdi.post.previous_account':
    'Line {line} held {code} {name} while this CFDI was stored as a vendor bill: a reference only, it is not posted.',
  'cfdi.post.next':
    '{method, select, PPD {Its VAT waits as not yet collected (2125 in the seeded chart) until its payment receipt (REP) arrives.{parked, select, yes { There are parked payment receipts: mnemosine rep reconcile links any that pays this invoice.} other {}}} other {Record its collection with: mnemosine receipt record {invoice}}}',
  'ingest.issued_left_to_code':
    'Left to post by hand ({reason}): this entity issued it, so it is a sale. Post it to receivables with `mnemosine cfdi post {uuid}`; `mnemosine cfdi list --direction emitido --type cfdi_ingreso --status pending` lists the ones waiting',
  'ingest.received_credit_note_to_inbox':
    'Received credit note: the model does not draft it. Post it against its bill with `mnemosine bill inbox run <id>`; `mnemosine bill inbox list` shows it, and the reason if it has to wait',
  'ingest.preview.route.received_credit_note':
    'received credit note: firm rules, then the inbox; no AI draft. A rule that requires this document type posts it, otherwise `mnemosine bill inbox run` does',
  'ingest.summary.issued_to_post':
    '{count} of them issued by this entity: post each to receivables with `mnemosine cfdi post <uuid>`; list them with `mnemosine cfdi list --direction emitido --type cfdi_ingreso --status pending`.',
  'bill.inbox.edit.issued_post_with': 'This entity issued it: post it to receivables with `mnemosine cfdi post {uuid}`.',
  'bill.inbox.run.issued_not_a_bill':
    'it is a CFDI this entity issued, a sale and not a vendor bill: post it to receivables with `mnemosine cfdi post {uuid}`',
  // ==== MNE-001-444 (#644): the readiness answer of a provider's credential ====
  // credential-state.ts builds the label every surface prints (doctor,
  // providers, status, init, the jobs tick, chat); provider-readiness.ts the
  // hint that a chat or ask with no credential prints. A label never carries a
  // value or a helper's command, only names.
  'provider.credential.env': '{variable} set',
  'provider.credential.helper': 'api_key_cmd',
  'provider.credential.helper_in': 'api_key_cmd in {file}',
  'provider.credential.helper_in_shared':
    'api_key_cmd in {file}, a project file shared by everyone who runs mnemosine in that folder',
  'provider.credential.local': 'local, no credential',
  'provider.credential.none': 'no credential configured',
  'provider.credential.missing': '{variable} missing',
  'provider.credential.missing_at': '{variable} missing (get it at {where})',
  'provider.credential.refused': '{variable} is not a provider credential',
  'provider.credential.folder_key':
    '{label}; {file} defines it, so that key serves everyone who runs mnemosine in that folder',
  'provider.credential.folder_empty': '{label}; the empty {variable}= in {file} hides ~/.mnemosine/.env',
  'provider.credential.anthropic.api_key': 'ANTHROPIC_API_KEY set, which the Anthropic SDK reads',
  'provider.credential.anthropic.auth_token': 'ANTHROPIC_AUTH_TOKEN set, a bearer token the Anthropic SDK sends',
  'provider.credential.anthropic.custom_header': 'an {header} line in ANTHROPIC_CUSTOM_HEADERS',
  'provider.credential.anthropic.profile': 'signed in: Anthropic profile {profile} in {file}',
  'provider.credential.anthropic.federation':
    'workload identity federation (ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID and an identity token)',
  'provider.credential.hint.missing':
    'Provider {name} has no credential: set {variable} in your shell or ~/.mnemosine/.env.',
  'provider.credential.hint.missing_at':
    'Provider {name} has no credential: set {variable} in your shell or ~/.mnemosine/.env (get it at {where}).',
  'provider.credential.hint.anthropic_alternative': 'Or sign in with `ant auth login`, or set ANTHROPIC_AUTH_TOKEN.',
  'provider.credential.hint.helper_alternative': 'Or give the profile an api_key_cmd in ~/.mnemosine/config.json.',
  'provider.credential.hint.refused':
    'Provider {name} names {variable} in api_key_env, which is not a provider credential: name a variable of its own that holds the key.',
  'provider.credential.hint.keyless':
    'Provider {name} has no credential configured: give it an api_key_env or an api_key_cmd. If its endpoint needs no key, start the chat with --provider {name}.',
  'provider.credential.hint.init': 'To set it up: mnemosine init --section ai',
  'provider.credential.anthropic_rejected': 'Set ANTHROPIC_API_KEY in your shell or ~/.mnemosine/.env, or run `ant auth login`.',
  'provider.switch.kept': 'The session stays on {current}.',
  'provider.switch.done': 'Provider switched to {label} ({credential}). New conversation.',
  // ==== end of MNE-001-444 ====
  // ==== MNE-001-452 (#645): what a shared project file may run ====
  'provider.credential.unapproved':
    'api_key_cmd in {file}, a shared project file, not approved here: it does not run until you approve it',
  'provider.credential.unbindable':
    'api_key_cmd in {file}, a shared project file, in a form that cannot be approved: it does not run until it is rewritten',
  'provider.credential.hint.unbindable':
    'Provider {name} runs an api_key_cmd from {file}, a shared project file, in a form that cannot be approved: ask whoever keeps it to point providers.{name}.api_key_cmd at a script inside the project, run directly or by sh/bash/node/python, or at a command outside it.',
  'provider.credential.unapproved_never':
    'api_key_cmd in {file}, a shared project file: "project_helpers" is "never" in ~/.mnemosine/config.json, so it does not run',
  'provider.credential.unapproved_pair':
    '{variable} set, but {file}, a shared project file, sends it to {host}, where its provider does not take it: not approved here',
  'provider.credential.unchecked_host': 'a host it could not check',
  'provider.credential.folder_routing':
    '{label}; {file} sets {variables}, which serve everyone who runs mnemosine in that folder',
  'provider.credential.hint.unapproved_pair':
    'Provider {name} in {file}, a shared project file, would send {variable} to {host}: if you trust that host with it, run `mnemosine providers approve {name}`.',
  'provider.credential.hint.unapproved':
    'Provider {name} runs an api_key_cmd from {file}, a shared project file, that you have not approved: read providers.{name}.api_key_cmd there and, if you trust it, run `mnemosine providers approve {name}`.',
  'provider.credential.hint.unapproved_never':
    'Provider {name} runs an api_key_cmd from {file}, a shared project file, and "project_helpers" is "never" in ~/.mnemosine/config.json: define the profile in your own file.',
  'help.providers.approve.description':
    'Approves, for you alone, what a profile of this folder\'s mnemosine.config.json runs or sends (as direnv allow)',
  'help.providers.approve.argument.profile': 'the profile, as the project file names it',
  'help.providers.approve.footer':
    'Examples:\n' +
    '  Read providers.vault.api_key_cmd in ./mnemosine.config.json first; then approve it for you:\n' +
    '    mnemosine providers approve vault',
  'provider.approve.builtin': '{name} is a built-in profile: there is nothing to approve.',
  'provider.approve.own_file': '{name} comes from your own {file}: there is nothing to approve.',
  'provider.approve.nothing':
    '{name} in {file} runs no api_key_cmd and sends no key to another host: there is nothing to approve.',
  'provider.approve.pair': 'Approved for you: providers.{name} in {file} may send {variable} to {host}. Another host asks again.',
  'provider.approve.helper':
    'Approved for you: the api_key_cmd of providers.{name} in {file}, for {host}. A changed command or host asks again.',
  'provider.approve.helper_scope':
    "It runs in this folder, with the folder's ./.env in its environment. A script of this project it names is approved by its content; a command found through PATH or npx is approved by its name only.",
  'provider.approve.never': '"project_helpers" is "never" in ~/.mnemosine/config.json, so it still does not run.',
  // ==== end of MNE-001-452 ====
  // ==== MNE-001-447 (#644): a failover walk skips a link with no credential ====
  // One dim line per skipped link; `mnemosine status` names what is missing.
  'provider.failover.unconfigured':
    'provider {from} has no usable credential here, so it was skipped (`mnemosine status` says why); trying {to}',
  // ==== end of MNE-001-447 ====
  // ==== MNE-001-470 · the first run and init offer the other language (issue #653) ====
  /** Printed in the language it offers, with `t(key, {}, other)`: each catalog offers its own. */
  'cli.lang.offer': 'To use Mnemosine in English: mnemosine lang en',
  /** Init's first step; the title and the question are rendered in every catalog, the run's first. */
  'cli.lang.step.title': 'Language',
  'cli.lang.step.prompt': 'Which language?',
  // ==== end of MNE-001-470 ====
  // ==== MNE-001-469 · lang names the rung that decided, and lang --unset (issue #653) ====
  'help.lang.argument.language':
    'the language to set: {choices}; omit it to see the language in effect and what decided it',
  'help.lang.option.unset':
    'remove the language saved in ~/.mnemosine/config.json, so the next source decides again',
  'cli.lang.examples':
    '\nExamples:\n' +
    '  Which language the CLI and the agent use right now, and what decided it:\n' +
    '    mnemosine lang\n' +
    '  Use Spanish for both; it is saved in ~/.mnemosine/config.json:\n' +
    '    mnemosine lang es\n' +
    '  Remove that choice, so the next source decides again:\n' +
    '    mnemosine lang --unset\n',
  'cli.lang.name.es': 'Spanish',
  'cli.lang.name.en': 'English',
  'cli.lang.in_effect': 'Language: {language} ({locale}), for the CLI and the agent. Decided by {rung}.',
  'cli.lang.rung.flag': 'the {flag} flag of this run',
  'cli.lang.rung.env': '{variable}={value} in the environment',
  'cli.lang.rung.user_config': 'your own choice, saved in {file}',
  'cli.lang.rung.project_config': "this folder's {file}",
  'cli.lang.rung.legacy_config': 'the legacy "language" key in {file}',
  'cli.lang.rung.entity': 'the language of the entity {entity}',
  'cli.lang.rung.default': 'the system default: nothing else chose one',
  'cli.lang.change_hint': 'Change it with: mnemosine lang {choices} (or the {variable} environment variable)',
  'cli.lang.unset_hint': 'Remove your saved choice with: mnemosine lang --unset',
  'cli.lang.set': 'Language set to {language} ({locale}) for the CLI and the agent, in {file}',
  'cli.lang.quarantined': 'Your previous {file} could not be read and was replaced; a copy is at {copy}',
  'cli.lang.takes_effect': 'Takes effect from the next command.',
  'cli.lang.shadowed_env': '{variable}={value} is set and takes precedence — unset it for this change to apply.',
  'cli.lang.shadowed': 'It does not apply yet: {rung} takes precedence; change it for this to apply.',
  'cli.lang.unset.done': 'Removed your language choice ({keys}) from {file}.',
  'cli.lang.unset.nothing': 'No language choice is saved in {file}; there is nothing to remove.',
  'cli.lang.unset_with_language': '--unset takes no language: it removes your saved choice (got "{language}").',
} as const;
