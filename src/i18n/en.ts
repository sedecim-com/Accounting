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
  /** `AccountingError('FX_REVALUATION_PLAN_CHANGED')`: the live run recomputed a different gain or loss than the plan the user confirmed. */
  'error.FX_REVALUATION_PLAN_CHANGED':
    'The revaluation of {period} changed between the plan you confirmed (gain {expectedGain}, loss {expectedLoss}) and the post (gain {gain}, loss {loss}): something was posted or a rate changed in between. Nothing was posted; run it again to see the new plan.',
  /** `AccountingError('FX_REVALUATION_MARKER_MISMATCH')`: fx_revaluation_runs no longer agrees with the ledger's fx_revaluation entries of the period. */
  'error.FX_REVALUATION_MARKER_MISMATCH':
    'The revaluation record of {period} does not agree with the ledger: the ledger holds {ledger} revaluation entries for it and the record {marker}, or their amounts differ. Running it again could post the revaluation twice, so nothing was posted; the record needs to be reviewed.',
  /** `AccountingError('FX_RATE_MISSING')` when the source was chosen by a panel key other than fuente_tipo_cambio (the closing revaluation). */
  'error.FX_RATE_MISSING':
    'There is no {from}→{to} rate from the source {source} for {date}. Enter it with: mnemosine fx rate set {from}/{to} {date} RATE --source {source}, or download it with: mnemosine fx rate download. No other source or date is taken silently: the source was chosen on the policy panel, and it is a criterion of the firm.',

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
    'Governs `depreciation run`. With "vida_util_nif" the monthly expense follows the useful life you set per asset (NIF C-6). With "tasa_lisr" it follows the tax rate stored on each asset, at most the maximum of its class (arts. 34-35 LISR), which is what most Mexican SMEs book so that the accounting and the deduction do not diverge. Only ONE schedule is computed and posted: the other basis is not kept in parallel. An asset without a stored tax rate (registered before the rates existed) keeps running on its useful life under either answer. An asset that already posted rows never switches basis: if you change this answer, the run refuses that asset with the reason instead of depreciating it on the other basis.',
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
    'Without the original invoice there is no base to prorate the VAT of that instalment. Decides whether the tax waits, is skipped with a warning, or is asked about.',
  'policy.rep_unknown_document.rationale':
    'SAT bulk downloads arrive out of order, so a receipt reaching us before its invoice is normal, not exceptional. The VAT is not lost: it stays parked, which is exactly where LIVA art. 5 fracc. III wants it until a document supports it. When the receipt DOES carry ImpuestosDR, that figure is checked against the proration over the original invoice: if they diverge beyond the tolerance, the receipt goes to review instead of releasing either figure silently.',
  'policy.rep_unknown_document.why':
    'Receipts often arrive before the invoice they refer to. I can hold the tax until the invoice shows up, or move on without it.',
  'policy.rep_unknown_document.what':
    'By default I wait, and the link resolves itself the day the invoice is ingested.',
  'policy.rep_unknown_document.if_skipped':
    'I wait. Nothing is lost — the tax stays where it was.',
  'policy.rep_unknown_document.option.esperar':
    'Wait: record the pending link and transfer no VAT for that document',
  'policy.rep_unknown_document.option.postear_sin_iva':
    'Match the cash and leave the VAT untransferred, with a warning',
  'policy.rep_unknown_document.option.preguntar':
    'Ask for the VAT amount',

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
    'An unrun schedule means the expense of that month is missing and the asset is overstated by the same amount. It is the exact shape of the defect this system already fixed for depreciation.',
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

  'policy.employment_subsidy_paid_treatment.question':
    'When the employment subsidy exceeds the ISR withheld and you hand the difference to the worker in cash, is that a receivable from the tax authority or an expense of the firm?',
  'policy.employment_subsidy_paid_treatment.impact':
    'It decides whether the cash you hand over comes back as a credit against the ISR withheld from other workers, or lands in payroll expense and never comes back.',
  'policy.employment_subsidy_paid_treatment.rationale':
    'It is what the law allows and what the money actually is: the employer advances cash that the authority repays by way of credit. Expensing it is a decision to give up that credit, which some firms make deliberately when the amounts are small and the paperwork is not worth it — but it should be a decision, not the consequence of a default.',
  'policy.employment_subsidy_paid_treatment.why':
    'When the subsidy is larger than the ISR of the period, the employer must hand the difference to the worker in cash. That money leaves the firm and comes back only if you credit it. Where you book it changes both your payroll expense and what you owe the SAT this month.',
  'policy.employment_subsidy_paid_treatment.what':
    'I compute the excess per paycheck, record it on the payslip as cash delivered, and post it to the account this policy names. With "cuenta_por_cobrar_fisco" I also net it against the ISR withheld that the monthly return reports.',
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

  // --- El kernel: confirmación y salida --------------------------------
  /** `src/cli/kernel/confirmacion.ts:76` (`noEntendi`, que ya la llama). El «y/s» del español
   *  es una gramática de DOS idiomas a la vez; en inglés sobra la mitad. */
  confirm_answer_not_understood:
    'did not understand “{answer}”: answer y or yes for yes, n or no for no',

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
  'review.vendor.register_prompt': 'Register vendor {name} (RFC {rfc})? [y/N] ',
  /** `src/cli/mnemosine.ts` review: the reviewer answered no to registering the vendor. */
  'review.vendor.not_registered': 'The vendor was not registered: nothing was posted and the draft stays pending.',
  'help.ingest.argument.files':
    'Paths to CFDI XML files; with --kind zip or metadata, the ZIP or metadata files downloaded from the SAT',
  'help.ingest.option.kind':
    'What the files are: xml (CFDI one by one), zip (a SAT package of CFDI XML: loads the census and ingests ' +
    'each XML) or metadata (the SAT `~` metadata file, bare or zipped: loads the census only)',
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
  'help.ingest.description':
    'Batch ingestion of CFDIs (XML): rules → AI classification → drafts (or auto-post by thresholds)',
  'help.lang.description':
    "Shows or sets the language of the AGENT's answers (CLI UI stays English; Spanish command " +
    'aliases always work)',
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
  'bank.account.edit.nothing_to_change':
    'Nothing to change. Pass --name, --bank, --branch, --type, --currency, --clabe, ' +
    '--account-number, --routing-ach, --routing-wire, --sat-bank-code, --swift or --iban.',
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
  'bank.check.reconcile.summary':
    '· cleared on {date} · period {period} · VAT reclassified {amount}',
  'bank.check.reconcile.dry_run':
    'Dry run: the clearing really was recorded, and then rolled back.',
  'bank.transaction.show.unmatched': 'unmatched',
  'bank.match.create.summary':
    '· bank {bank} = books {books} + adjustments {adjustments} · residual {residual} ({mode}) · ' +
    '{matches, plural, one {# match} other {# matches}} · ' +
    '{sealed, plural, one {# item sealed} other {# items sealed}}',
  // ==== fin del piloto bank (I7) ====================================
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
  'help.receipt.apply.option.withholding':
    'what the customer withheld, which settles the invoice with the cash: "isr:1000" or "iva:1066.67" (repeatable); with several invoices, "INV-2026-00042:isr:1000"',
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
    'Create a draft run over a pay period; the tax year is fixed from the period',
  'help.pay_run.create.option.period': 'pay period of the active entity (its id)',
  'help.pay_run.create.option.type': 'run type: {types}',
  'help.pay_run.calculate.description':
    'Calculate gross to net for each employee in the inputs file and total the run',
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
  'report.category.ori': 'Other comprehensive income',
  'report.category.revenue': 'Revenue',
  'report.category.cogs': 'Cost of sales',
  'report.category.operating_expenses': 'Operating expenses',
  'report.category.other_income': 'Other income',
  'report.category.other_expenses': 'Other expenses',
  'report.category.tax': 'Taxes',
  'report.category.other': 'Other',
  'report.total_of': 'Total {name}',
  'report.total_liabilities_and_equity': 'Total liabilities and equity',
  'report.net_income': 'Net income',
  'report.balance_check': 'Assets {assets} = Liabilities + Equity {total}',
  'report.income_summary': 'Revenue {revenue}   Expenses {expenses}   Net income {net}',
  // --- pay-run · corrida (MNE-001-068) -----------------------------------
  'payrun.file_invalid': 'The inputs file {path} cannot be used: {detail}. Nothing was calculated.',
  'payrun.file_duplicate_employee':
    'Employee {employee} appears twice in {path}: a run has one paycheck per employee. Nothing was calculated.',
  'payrun.create.period_required':
    'Missing --period: a run belongs to one pay period of the entity, and it is not guessed from the clock.',
  'payrun.create.next': 'Next: `mnemosine pay-run calculate {id} --file <inputs.json>`.',
  'payrun.calculate.file_required':
    'Missing --file: the employee inputs of the period (earnings and deductions) come from a JSON file.',
  'payrun.calculate.next': 'Next: `mnemosine pay-run approve {id} --dry-run` to see what approving writes.',
  'payrun.approve.confirm':
    'You are about to APPROVE run {id} ({employees, plural, one {# employee} other {# employees}}, ' +
    'net pay {net}) and write its employer liability. Approval is not undone. Continue?',
  'payrun.approve.aborted': 'Nothing changed: the run was not approved.',
  'payrun.approve.done': 'Run {id} approved · {status}',
  'payrun.approve.repeated': 'Run {id} was already approved under this key: the recorded result is shown · {status}',
  'payrun.approve.dry_run': 'Dry run: run {id} was approved and rolled back; it is still {status}.',

  // --- `prepaid run` and its idempotency key (MNE-001-053, #317) ---------
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
  'help.e_accounting.seal.option.type': 'envelope type of the archived balance: N normal, C amended',
  'help.e_accounting.seal.option.closing': 'the year-end balance, archived as month 13',
  'help.e_accounting.seal.option.output': 'also write the sealed XML to this path',
} as const;
