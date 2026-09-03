// ============================================================
// POLICY DECISION CATALOG
// Everything the system can NOT decide on its own because it
// depends on the firm's judgment, company policy, or business
// information. Each one declares the default used while it is
// undefined, so the system never stops waiting for a definition.
// ============================================================

export interface PolicyOption {
  value: string;
  label: string;
}

export interface PolicySpec {
  key: string;
  category: 'contable' | 'fiscal' | 'seguridad' | 'operativa' | 'comercial';
  question: string;
  /** What changes in the system depending on the answer. */
  impact: string;
  options: PolicyOption[];
  /** Value in use while undefined. */
  defaultValue: string;
  defaultRationale: string;
  /** 1 = decide first. */
  priority: number;

  // ── Onboarding: the wizard explains before asking ──
  /**
   * Why the system needs the datum, from the user's point of view: what
   * it cannot decide on its own and why. Written for an accountant, not
   * for an operator.
   */
  whyAsking?: string;
  /** Exactly what the system will do with the answer. */
  whatIDo?: string;
  /** What happens if they skip it (beyond "the default is used"). */
  ifSkipped?: string;
}

export const POLICY_CATALOG: PolicySpec[] = [
  // ── Accounting ──
  {
    // El catálogo base se sembraba en TODA entidad sin mirar el país, así que
    // una sociedad estadounidense nacía con IVA, ISR y una cuenta de banco en
    // pesos. Que NO reciba el estrato fiscal mexicano es un hecho, no una
    // opinión: no hay despacho para el que eso sea correcto, y se arregló en
    // el código. Lo que sí es criterio del despacho es lo otro — si a esa
    // entidad se le siembra el catálogo de la casa o se le deja sin él para
    // traer el suyo—, y por eso vive aquí y no en un `if`.
    key: 'catalogo_entidad_no_mexicana',
    category: 'contable',
    question: 'What chart of accounts does an entity that does not keep Mexican books receive?',
    impact:
      'Decides what a foreign entity is born with. The house chart keeps it posting from day one; ' +
      'no base chart leaves it with the CFDI role accounts and the payroll mapping rows and nothing ' +
      'else, and until its own is imported every invoice fails with MISSING_ROLE_ACCOUNT and the ' +
      'first pay run fails too, because the roles and buckets that want bank, receivables, payables ' +
      'or revenue have no account to point at.',
    options: [
      {
        value: 'base_neutro',
        label: 'The house chart without the Mexican tax layer (generic bank and sales tax instead)',
      },
      {
        // El texto decía «No chart» y la entidad nacía con dieciséis cuentas:
        // el interruptor llega al catálogo base y NO a las otras dos semillas
        // —ver ensureEntityAccounting, donde está el porqué—. Una opción que
        // describe mal lo que hace es peor que no ofrecerla: el despacho la
        // escoge esperando una entidad vacía y luego no entiende el `doctor`.
        value: 'ninguno',
        label: 'No base chart: the entity imports its own (role and payroll accounts are still created)',
      },
    ],
    defaultValue: 'base_neutro',
    defaultRationale:
      'An entity that can post on its first day beats one that cannot. The universal scaffolding is ' +
      'double-entry, not Mexican, so it fits any country; importing a chart later still works and ' +
      'never overwrites what the firm chose.',
    whyAsking:
      'Your foreign subsidiary can start with the same chart your Mexican entities use — minus the ' +
      'IVA, ISR and withholding accounts, which it will never use — or it can start without that ' +
      'chart because you plan to bring its existing one over from another system. Both are ' +
      'defensible; which one is right depends on whether that entity already has books elsewhere.',
    whatIDo:
      'On the house chart I seed the universal accounts plus a generic bank and sales-tax account, so ' +
      'invoices, bills and payments post immediately. On no base chart I skip THAT chart and nothing ' +
      'else: the entity is still born with the CFDI role accounts and the payroll mapping rows, so ' +
      '"no chart" does not mean an empty entity — expect roughly sixteen accounts. What it does not ' +
      'get is everything the base chart carries: bank, receivables, payables, revenue. Every invoice ' +
      'fails with MISSING_ROLE_ACCOUNT until the import lands, and so does the first pay run — the ' +
      'cash_payroll bucket is mandatory and points at a bank account (1111 in Mexico, 1115 on the ' +
      'neutral chart) that only the base chart creates, which is why `entity create` warns about it ' +
      'by name. `mnemosine doctor` lists the unmapped roles, so you know what the import still owes.',
    ifSkipped:
      'Foreign entities get the house chart. If you were going to import their real chart, you will ' +
      'have a handful of unused accounts to deactivate.',
    priority: 35,
  },
  {
    // F06a · Qué depreciación rige el gasto que se postea. El esquema ya tenía
    // la dualidad desde la 003 —`book_depreciation_method` y
    // `tax_depreciation_method`— y nadie la leía: el motor usaba la columna
    // única y clavaba `schedule_type: 'book'`.
    key: 'base_depreciacion',
    category: 'contable',
    question: 'Which depreciation drives the expense you post: book life or the tax rate?',
    impact:
      'Governs `depreciation run`. With "vida_util_nif" the monthly expense follows the useful ' +
      'life you set per asset (NIF C-6). With "tasa_lisr" it follows the maximum rate the income ' +
      'tax law allows for that asset class (arts. 31-38 LISR), which is what most Mexican SMEs ' +
      'book so that the accounting and the deduction do not diverge. Either way BOTH schedules ' +
      'can be computed; this decides which one reaches the ledger.',
    options: [
      { value: 'vida_util_nif', label: 'Book: the useful life you assigned to the asset (NIF C-6)' },
      { value: 'tasa_lisr', label: 'Tax: the maximum LISR rate for its class, so books and deduction agree' },
    ],
    defaultValue: 'vida_util_nif',
    defaultRationale:
      'It is what the financial statements are supposed to show, and it is the column the engine ' +
      'already used. Choosing the tax rate is a legitimate simplification, but it has to be chosen.',
    whyAsking:
      'A machine you expect to use for ten years can be deducted faster than that, or slower, depending on which rule you follow. Both answers are defensible and they post different amounts every month — so this is your firm\'s criterion, not something I can look up.',
    whatIDo:
      'I compute the monthly expense on the basis you pick and record which one I used on every schedule row, so a later run can prove it kept the same criterion. If you ever switch, the rows already posted keep saying what they were.',
    ifSkipped:
      'I use the book useful life. Your deduction may then differ from your booked expense, which is normal but means a reconciliation at year end.',
    priority: 25,
  },
  {
    // F06a · El primer y el último mes de cada activo. El motor no tenía
    // convención: indexaba filas de un calendario.
    key: 'convencion_primer_mes',
    category: 'contable',
    question: 'An asset bought mid-month: does it depreciate that whole month, or only the days it was owned?',
    impact:
      'Governs the first and last amount of every asset. "mes_completo" charges the full month of ' +
      'the in-service date; "proporcional_dias" charges only the days owned and pushes the ' +
      'remainder to the final month. Over the life of the asset the total is identical — what ' +
      'changes is which period carries it, and therefore every monthly result in between.',
    options: [
      { value: 'mes_completo', label: 'Whole month from the month it entered service (LISR counts whole months)' },
      { value: 'proporcional_dias', label: 'Pro rata by days owned in the first and last month' },
    ],
    defaultValue: 'mes_completo',
    defaultRationale:
      'It is what the income tax law counts, it is simpler to audit, and it avoids a partial ' +
      'amount that no one can reproduce a year later without knowing the exact purchase day.',
    whyAsking:
      'You buy a machine on the 20th. Charging the whole month overstates that month slightly; charging eleven days understates it and leaves a stub at the end. Neither is wrong — your firm picks one and stays with it.',
    whatIDo:
      'I apply the convention you pick to the first and last month of every asset, and I record it on the schedule row so the amount can be reproduced.',
    ifSkipped:
      'I charge the whole month, which matches how the tax law counts and is the easier of the two to defend.',
    priority: 26,
  },
  {
    // F06a · ¿La casilla del cierre bloquea? Precedente exacto en este mismo
    // archivo: `rep_faltante_recibido` y `rep_faltante_emitido` preguntan lo
    // mismo y las lee `getPeriodCloseStatus`.
    key: 'depreciacion_faltante_al_cierre',
    category: 'operativa',
    question: 'Closing a month with assets whose depreciation was never run: warn, or refuse?',
    impact:
      'Governs the "Depreciation calculated and posted" item on the close checklist. With ' +
      '"avisar" the month closes and the checklist says what is missing; with "bloquear" it ' +
      'refuses until the run happens. A month closed without depreciation overstates profit and ' +
      'the asset, and the error compounds because next month starts from the wrong book value.',
    options: [
      { value: 'avisar', label: 'Warn: the month closes and the checklist names what is missing' },
      { value: 'bloquear', label: 'Refuse: no month closes with depreciation pending' },
    ],
    defaultValue: 'avisar',
    defaultRationale:
      'Same default as the other two close gates in this panel, and for the same reason: a hard ' +
      'block on a control that has just started producing data would stall the first close after ' +
      'this feature ships. Turn it on once the run is part of your routine.',
    whyAsking:
      'Forgetting the depreciation run is the easiest way to close a month that looks better than it was — and unlike most mistakes it does not correct itself: next month starts from a book value that is too high.',
    whatIDo:
      'I count the active assets with no posted depreciation for the period and either warn you or refuse to close, as you choose. Either way the checklist names them.',
    ifSkipped:
      'I warn but let the month close, so the first month after this ships does not get stuck.',
    priority: 27,
  },
  {
    key: 'umbral_capitalizacion_mxn',
    category: 'contable',
    question: 'From what amount is an item capitalized as a fixed asset instead of expensed?',
    impact:
      'Determines when the system asks "expense or fixed asset" when loading a CFDI. A low threshold ' +
      'interrupts often; a high one capitalizes less than it should. Also affects future depreciation.',
    options: [
      { value: '5000', label: '$5,000 — conservative, capitalizes almost all equipment' },
      { value: '20000', label: '$20,000 — common in Mexican SMEs' },
      { value: '50000', label: '$50,000 — only significant investments' },
    ],
    defaultValue: '20000',
    defaultRationale: 'Most common threshold in Mexican practice. Not a legal rule: it is internal policy.',
    whyAsking:
      "When an equipment invoice arrives I must decide whether it is this month's expense or an asset that depreciates over years. That line is your company's policy, not a SAT rule — the law sets depreciation rates, not the threshold for capitalizing.",
    whatIDo:
      'Above that amount I stop and ask you case by case instead of deciding alone. Below it, I book it as an expense without interrupting you.',
    ifSkipped:
      'I keep asking at $20,000, which may interrupt you more (or less) than you want.',
    priority: 10,
  },
  {
    key: 'politica_restaurantes',
    category: 'fiscal',
    question: 'Restaurant meals (8.5% deductible): how are they recorded?',
    impact:
      'Defines whether the system splits each meal into two lines (deductible / non-deductible) or sends ' +
      'everything to non-deductible with the adjustment made in the return. Affects the tax-book reconciliation.',
    options: [
      { value: 'split_85', label: 'Split 8.5% deductible / 91.5% non-deductible in the entry' },
      { value: 'no_deducible', label: 'All to non-deductible; adjust in the return' },
    ],
    defaultValue: 'split_85',
    defaultRationale: 'Keeps the books aligned with the actual deduction without extra work at close.',
    whyAsking:
      'The income tax law lets you deduct only 8.5% of restaurant meals. The other 91.5% is a real expense but not deductible, and mixing them makes the tax reconciliation harder at year-end.',
    whatIDo:
      'I split each restaurant invoice into two lines — deductible and non-deductible — or send it whole to non-deductible, whichever you choose.',
    ifSkipped:
      'I split 8.5/91.5, which keeps the books aligned but adds a line to each meal.',
    priority: 20,
  },
  {
    key: 'tratamiento_ieps',
    category: 'fiscal',
    question: 'Is the company an IEPS taxpayer that passes it on?',
    impact:
      'If it is not, the IEPS passed on to it becomes part of the cost. If it is, it is creditable. ' +
      'Determines the account for every purchase with IEPS (fuel, beverages, tobacco).',
    options: [
      { value: 'costo', label: 'Not a taxpayer: IEPS is part of the cost' },
      { value: 'acreditable', label: 'Is a taxpayer: IEPS is creditable' },
    ],
    defaultValue: 'costo',
    defaultRationale: 'Most companies are not IEPS taxpayers (LIEPS art. 4).',
    whyAsking:
      'IEPS is only creditable if your company is a taxpayer of that tax and passes it on. For everyone else it is part of the cost of the goods. I cannot tell which case you are from the invoice.',
    whatIDo:
      'It decides the account for every purchase carrying IEPS: fuel, beverages, tobacco.',
    ifSkipped:
      'I treat it as cost, which is right for most companies but understates your creditable tax if you are an IEPS taxpayer.',
    priority: 30,
  },
  {
    key: 'lleva_inventarios',
    category: 'contable',
    question: 'Does the company keep perpetual inventories?',
    impact:
      'If it does, merchandise purchases go to inventory and cost is recognized on sale. ' +
      'If not, they go straight to cost. Changes the entry for every purchase of merchandise or raw materials.',
    options: [
      { value: 'perpetuos', label: 'Yes: purchases to inventory, cost on sale' },
      { value: 'directo', label: 'No: purchases straight to cost of sales' },
    ],
    defaultValue: 'directo',
    defaultRationale: 'Asked case by case while undefined; the default avoids inventing inventories.',
    whyAsking:
      "If you keep perpetual inventories, a merchandise purchase goes to inventory and the cost is recognized when you sell. If you don't, it goes straight to cost of sales. The invoice looks identical either way.",
    whatIDo:
      'It changes the entry for every purchase of merchandise or raw materials.',
    ifSkipped:
      'I ask you case by case on each merchandise purchase, which is safe but repetitive.',
    priority: 25,
  },
  {
    key: 'cfdi_periodo_cerrado',
    category: 'contable',
    question: 'A CFDI from an already-closed period: in which period is it recorded?',
    impact:
      'Defines whether the system proposes the current open period or flags the document to reopen the ' +
      'original period. Affects the comparability of the financial statements.',
    options: [
      { value: 'periodo_actual', label: 'Record in the current open period' },
      { value: 'preguntar', label: 'Ask case by case' },
      { value: 'reabrir', label: 'Reopen the original period (requires authorization)' },
    ],
    defaultValue: 'preguntar',
    defaultRationale: 'With no policy defined, each case is escalated instead of assumed.',
    whyAsking:
      'A December invoice that arrives in February has no obvious home: booking it in the closed period breaks comparability, booking it today distorts the current month. Firms handle this differently.',
    whatIDo:
      'It decides whether I propose the current open period, flag the document to reopen the original one, or ask you each time.',
    ifSkipped:
      'I ask you each time, which is the safest default but the most interruptive.',
    priority: 40,
  },

  // ── Payment receipts (REP) ──
  //
  // A REP —CFDI type P, the payment-receipt complement— is the document that
  // proves a PPD invoice was actually paid. Under LIVA art. 5 fracc. III the
  // input VAT is creditable only once paid, so the REP is what moves VAT from
  // "pending" to "creditable". Every decision below changes which month a
  // peso of tax lands in, so none of them can be hard-coded: they are the
  // firm's criteria, not the system's.
  {
    key: 'rep_pago_no_registrado',
    category: 'contable',
    question: 'A payment receipt (REP) arrives and no matching payment is on file: what happens?',
    impact:
      'Decides whether ingesting a REP can move money on its own. Creating the payment is what releases ' +
      'the parked VAT, because the release hangs off the payment applications — but it also means the ' +
      'system moves the bank without a human having recorded it.',
    options: [
      { value: 'crear_pago', label: 'Create the payment and apply it to each related document' },
      { value: 'revision', label: 'Register the receipt and leave the link for a person to confirm' },
    ],
    defaultValue: 'crear_pago',
    defaultRationale:
      'The REP is documentary proof that the money already moved: it carries the payment date and method. ' +
      'Creating the payment routes it through the single door that also releases the VAT. ' +
      'A third option — posting the cash directly, with no payment record — is deliberately NOT offered: ' +
      'it is what double-credits the bank when the payment was also captured by hand, and it leaves the ' +
      'VAT parked forever. There is no legacy behaviour to stay compatible with, because this door never ' +
      'worked: a type-P CFDI died with UNSUPPORTED_TYPE before reaching any posting.',
    whyAsking:
      'When your supplier sends the receipt for an invoice you paid, I can either take it as the record of that payment, or wait until someone confirms it. Firms that capture bank movements daily want to confirm; firms that book straight from CFDIs want me to take it.',
    whatIDo:
      'With "crear_pago" I record the payment and apply it to the invoices the receipt names, which is what lets me credit the VAT that was waiting. With "revision" I file the receipt and ask you.',
    ifSkipped:
      'I create the payment. If you also capture payments by hand, tell me — otherwise we could end up with the same payment twice.',
    priority: 20,
  },
  {
    key: 'rep_tolerancia_importe',
    category: 'contable',
    question: 'How much difference between the receipt and the recorded payment still counts as rounding?',
    impact:
      'Used twice: to decide whether a hand-captured payment is the same event as the receipt, and to ' +
      'compare the VAT the receipt declares (ImpuestosDR) against the proration over the invoice. ' +
      'Beyond it, the receipt goes to review: matching a payment that is not the same one credits VAT ' +
      'for an amount different from what was actually paid.',
    options: [
      { value: '0.01', label: 'One cent — only true rounding' },
      { value: '1.00', label: 'One peso' },
      { value: '0', label: 'Exact match or nothing' },
    ],
    defaultValue: '0.01',
    defaultRationale:
      'The comparison runs per related document, not receipt-against-payment, and the VAT proration ' +
      'already settles its remainder on the last instalment. A difference larger than a cent is not ' +
      'rounding: it is another instalment, another exchange rate, or a different payment.',
    whyAsking:
      'Receipts and your own records rarely differ, but when they do it matters whether it is a cent of rounding or a different payment altogether.',
    whatIDo: 'Within the tolerance I match them. Outside it I leave the receipt for you to look at.',
    ifSkipped: 'I allow one cent.',
    priority: 45,
  },
  {
    key: 'rep_documento_desconocido',
    category: 'fiscal',
    question: 'The receipt names an invoice the system does not have: what happens to that VAT?',
    impact:
      'Without the original invoice there is no base to prorate the VAT of that instalment. Decides ' +
      'whether the tax waits, is skipped with a warning, or is asked about.',
    options: [
      { value: 'esperar', label: 'Wait: record the pending link and transfer no VAT for that document' },
      { value: 'postear_sin_iva', label: 'Match the cash and leave the VAT untransferred, with a warning' },
      { value: 'preguntar', label: 'Ask for the VAT amount' },
    ],
    defaultValue: 'esperar',
    defaultRationale:
      'SAT bulk downloads arrive out of order, so a receipt reaching us before its invoice is normal, not ' +
      'exceptional. The VAT is not lost: it stays parked, which is exactly where LIVA art. 5 fracc. III ' +
      'wants it until a document supports it. When the receipt DOES carry ImpuestosDR, that figure is ' +
      'checked against the proration over the original invoice: if they diverge beyond the tolerance, ' +
      'the receipt goes to review instead of releasing either figure silently.',
    whyAsking:
      'Receipts often arrive before the invoice they refer to. I can hold the tax until the invoice shows up, or move on without it.',
    whatIDo: 'By default I wait, and the link resolves itself the day the invoice is ingested.',
    ifSkipped: 'I wait. Nothing is lost — the tax stays where it was.',
    priority: 45,
  },
  {
    key: 'rep_ventana_dias',
    category: 'operativa',
    question: 'How many days apart can the receipt date and the recorded payment be and still be the same event?',
    impact:
      'A window that is too narrow produces false negatives, and a false negative ends in a duplicated ' +
      'payment — which is the exact harm the matching exists to prevent.',
    options: [
      { value: '0', label: 'Same day exactly' },
      { value: '3', label: 'Three calendar days' },
      { value: '15', label: 'Fifteen days, for monthly capture' },
    ],
    defaultValue: '3',
    defaultRationale:
      'The date is a matching heuristic, not a tax fact: what the SAT checks are the amounts and the ' +
      'chain of instalments. Payments captured by hand usually carry the statement date rather than the ' +
      'value date, and three days covers that gap without spanning two instalments of the same document.',
    whyAsking:
      'Your records and the receipt rarely carry the exact same date. How far apart can they be before I stop assuming they are the same payment?',
    whatIDo: 'Within the window I consider them the same event and link them instead of creating a second payment.',
    ifSkipped: 'I allow three days.',
    priority: 50,
  },
  {
    key: 'amortizacion_anticipados_convencion',
    category: 'contable',
    question: 'A prepayment that starts mid-month: does the first month accrue in full, or only for the days it covers?',
    impact:
      'Sets every month of the schedule. An insurance policy running 20 March to 19 March accrues over 12 ' +
      'months by one convention and 13 by the other, and the last month of the fiscal year differs.',
    options: [
      { value: 'proporcional_dias', label: 'By days: the first and last months accrue only the days covered' },
      { value: 'meses_completos', label: 'Whole months: the starting month accrues in full and the last one does not' },
    ],
    defaultValue: 'proporcional_dias',
    defaultRationale:
      'It is what the NIF A-2 accrual postulate actually says — the expense belongs to the period that ' +
      'consumed the service — and it is the only convention that keeps the schedule tied to the ' +
      'contract dates rather than to the calendar. Firms that prefer whole months for simplicity can ' +
      'say so here, but the default should be the one that is right rather than the one that is easy.',
    whyAsking:
      'Your insurance starts on the 20th, not on the 1st. By days it spreads over thirteen calendar '
      + 'months and by whole months over twelve, so the choice changes which month carries the '
      + 'expense and what the last month of the year shows.',
    whatIDo: 'I accrue the days each month actually covers.',
    ifSkipped: 'I accrue by days.',
    priority: 35,
  },
  {
    key: 'amortizacion_faltante_al_cierre',
    category: 'contable',
    question: 'Closing a month with prepayment schedules whose amortisation was never run: warn, or refuse?',
    impact:
      'An unrun schedule means the expense of that month is missing and the asset is overstated by the ' +
      'same amount. It is the exact shape of the defect this system already fixed for depreciation.',
    options: [
      { value: 'avisar', label: 'Warn: the checklist item goes red and the close continues' },
      { value: 'bloquear', label: 'Refuse: the period does not close until every schedule is run' },
    ],
    defaultValue: 'avisar',
    defaultRationale:
      'It is the same answer the firm already gets for depreciation, and consistency between two ' +
      'identical situations matters more here than the choice itself: a checklist where one accrual ' +
      'blocks and the other warns teaches nobody anything.',
    whyAsking:
      'If a schedule was never run, the month you are closing is missing that expense and the '
      + 'prepaid asset is overstated by the same amount — and you would be signing it either way.',
    whatIDo: 'I flag it in the close checklist and let you decide.',
    ifSkipped: 'I warn.',
    priority: 35,
  },
  {
    key: 'umbral_anticipado_mxn',
    category: 'contable',
    question: 'Above what amount is a multi-period expense deferred to prepayments instead of expensed at once?',
    impact:
      'Below the threshold the whole amount hits the month it was paid; above it, a schedule is created ' +
      'and the expense spreads. Today the CFDI classifier offers the deferral on ANY amount whose ' +
      'description matches a pattern, with no floor at all.',
    options: [
      { value: '0', label: 'No threshold: defer every multi-period expense' },
      { value: '5000', label: '5,000 MXN' },
      { value: '20000', label: '20,000 MXN' },
    ],
    defaultValue: '5000',
    defaultRationale:
      'Materiality (NIF A-4): a 900-peso annual subscription split into twelve entries of 75 costs more ' +
      'in bookkeeping than the precision it buys, and clutters the schedule with rows nobody will ' +
      'check. Five thousand is the order of magnitude where the split starts paying for itself.',
    whyAsking: 'Not every yearly subscription is worth spreading over twelve months; you decide where the line is.',
    whatIDo: 'I defer multi-period expenses of 5,000 MXN or more and expense the rest as they come.',
    ifSkipped: 'I use 5,000 MXN.',
    priority: 40,
  },
  {
    key: 'dias_aguinaldo',
    category: 'contable',
    question: 'How many days of aguinaldo does the firm grant per year of service?',
    impact:
      'Drives both the settlement calculation and the monthly provision. The engine currently hardcodes ' +
      'a value and never reads it from anywhere.',
    options: [
      { value: '15', label: '15 days — the legal minimum (LFT art. 87)' },
      { value: '20', label: '20 days' },
      { value: '30', label: '30 days (one month)' },
    ],
    defaultValue: '15',
    defaultRationale:
      'LFT art. 87 sets fifteen days as the floor, and a floor is the only number the system can assume ' +
      'without knowing the contract. Anything above it is a benefit the employer granted and must be ' +
      'declared, never guessed.',
    whyAsking: 'The law sets a minimum of fifteen days; many firms pay more, and I cannot know which yours is.',
    whatIDo: 'I compute aguinaldo on fifteen days per year, accrued in proportion to time served.',
    ifSkipped: 'I use the legal minimum of fifteen days.',
    priority: 40,
  },
  {
    key: 'prima_vacacional_pct',
    category: 'contable',
    question: 'What vacation premium does the firm pay over the vacation days earned?',
    impact: 'Applies to the settlement and to the monthly vacation provision alike.',
    options: [
      { value: '0.25', label: '25 % — the legal minimum (LFT art. 80)' },
      { value: '0.50', label: '50 %' },
      { value: '1.00', label: '100 %' },
    ],
    defaultValue: '0.25',
    defaultRationale:
      'Same reasoning as the aguinaldo: LFT art. 80 sets 25 % as the floor, and the floor is the only ' +
      'figure that is safe to assume. A firm paying more is granting a benefit, and a benefit is ' +
      'declared, not inferred.',
    whyAsking: 'The law sets 25 % as the minimum vacation premium; yours may be higher.',
    whatIDo: 'I apply 25 % over the vacation days earned.',
    ifSkipped: 'I use the legal minimum of 25 %.',
    priority: 40,
  },
  {
    key: 'flujo_efectivo_metodo',
    category: 'contable',
    question: 'Is the statement of cash flows presented by the indirect or the direct method?',
    impact:
      'Decides the whole face of the statement. Before G1b the engine accepted a `method` parameter, ' +
      'echoed it back in the response and NEVER changed a number — every caller that asked for the ' +
      'direct method got the indirect one, labelled as direct.',
    options: [
      {
        value: 'indirecto',
        label: 'Indirect: start from net income and adjust for non-cash items and working-capital movements',
      },
      {
        value: 'directo',
        label: 'Direct: gross collections and payments by concept (customers, suppliers, employees, taxes)',
      },
    ],
    defaultValue: 'indirecto',
    defaultRationale:
      'NIF B-2 allows both and Mexican practice overwhelmingly files the indirect one: it derives from ' +
      'the same balances the trial balance already has, while the direct method needs every cash ' +
      'movement classified by concept at the moment it is recorded. Offering «direct» over data that ' +
      'was never classified for it would produce a statement that looks right and is not.',
    whyAsking: 'The two methods present the same cash differently, and the presentation is a firm decision, not a calculation.',
    whatIDo: 'I build the statement by the indirect method and label it as such.',
    ifSkipped: 'I use the indirect method.',
    priority: 30,
  },
  {
    key: 'flujo_efectivo_cuentas_de_efectivo',
    category: 'contable',
    question: 'Which accounts count as «cash and cash equivalents» when the statement of cash flows is squared?',
    impact:
      'The statement only means anything if its net movement equals the real change in cash, and that ' +
      'requires knowing which accounts ARE cash. Before G1b classification ran on account names ' +
      'matched with ILIKE «%receivable%» and «%payable%» — in English, against a chart of accounts ' +
      'this product itself seeds in Spanish, so it matched nothing and working capital came out zero.',
    options: [
      { value: 'rol', label: 'By role: the accounts account_roles marks as bank and cash' },
      { value: 'subtipo', label: 'By subtype: current-asset accounts explicitly flagged as cash' },
      { value: 'lista', label: 'A list of account codes the firm declares' },
    ],
    defaultValue: 'rol',
    defaultRationale:
      'The role map is the semantic layer this system already uses everywhere else to answer «which ' +
      'account is this» — it survives renamings, translations and imported charts, which is exactly ' +
      'what account names do not. Matching by name is how that defect got here.',
    whyAsking: 'To square the cash flow statement I have to know which accounts hold the cash it is talking about.',
    whatIDo: 'I take the accounts mapped to the bank and cash roles.',
    ifSkipped: 'I use the role map.',
    priority: 30,
  },
  {
    key: 'flujo_efectivo_descuadre',
    category: 'contable',
    question: 'When the cash flow statement does not equal the real movement of cash, do I publish it, name it, or refuse?',
    impact:
      'A statement of cash flows that does not tie to cash is the one financial statement whose error ' +
      'is provable from the outside — anyone can compare it against the bank. Absorbing the residue ' +
      'into a line item hides exactly what the reader would have caught.',
    options: [
      { value: 'avisar', label: 'Publish it with the difference stated and quantified' },
      { value: 'bloquear', label: 'Refuse to emit the statement until it ties' },
      { value: 'silencio', label: 'Publish the computed net without contrasting it' },
    ],
    defaultValue: 'avisar',
    defaultRationale:
      'Refusing would leave the firm without a statement it may need for a filing deadline, and ' +
      'silence is how a wrong statement gets signed. Naming the residue keeps the document usable ' +
      'and puts the discrepancy where the preparer — and the auditor — will see it.',
    whyAsking:
      'The derived statement and the real movement of cash can disagree. This is the one financial '
      + 'statement anybody can check against your bank, so whether the difference is stated or '
      + 'buried is your call, not mine.',
    whatIDo: 'I publish the statement and state the difference against real cash, with its amount.',
    ifSkipped: 'I publish it and name the difference.',
    priority: 30,
  },
  {
    key: 'diot_tipo_operacion_por_omision',
    category: 'contable',
    question: 'A supplier with no operation type declared: which one does the DIOT report?',
    impact:
      'The DIOT reports each supplier under an operation type — 03 professional services, 06 ' +
      'property leasing, 85 other. It is per SUPPLIER, not per invoice, so a wrong default is ' +
      'wrong for every month until someone corrects it.',
    options: [
      { value: '85', label: 'Other (85) — the catch-all the catalogue provides' },
      { value: '03', label: 'Professional services (03)' },
      { value: 'bloquear', label: 'None: refuse to build the DIOT until every supplier declares one' },
    ],
    defaultValue: '85',
    defaultRationale:
      'The catalogue itself provides 85 as the residual category, so using it is not a guess: it is ' +
      'the answer the form expects when the operation is neither professional services nor leasing. ' +
      'Refusing would block a monthly filing over suppliers whose classification does not change the ' +
      'tax, and 03 or 06 asserted by default would put a specific claim in your name.',
    whyAsking:
      'The form classifies each supplier by the kind of operation you have with them, and most of them are neither professional services nor leasing — but the two that are, you have to tell me.',
    whatIDo: 'I report suppliers with no declared type under 85, and list them so you can refine the ones that matter.',
    ifSkipped: 'I use 85 and tell you which suppliers took it.',
    priority: 35,
  },
  {
    key: 'diot_tercero_sin_rfc',
    category: 'contable',
    question: 'A supplier with a missing, invalid or generic RFC when the DIOT is built: refuse, or report it as global?',
    impact:
      'The DIOT identifies each national supplier by RFC. Today the system detects an EMPTY tax id ' +
      'and nothing else: neither a malformed one nor the generic XAXX010101000, which is precisely ' +
      'the value that turns a real supplier into an anonymous one on the filing.',
    options: [
      { value: 'bloquear', label: 'Refuse to build it and name the suppliers' },
      { value: 'declarar_global', label: 'Report them under type 15 (global, general public)' },
    ],
    defaultValue: 'bloquear',
    defaultRationale:
      'Type 15 exists for genuine sales to the general public, not as a bin for suppliers whose RFC ' +
      'nobody captured. Using it that way files a declaration saying those operations had no ' +
      'identifiable counterparty, which is a statement about your books rather than a formatting ' +
      'choice — and it is the kind of thing the authority cross-checks against the suppliers own ' +
      'filings.',
    whyAsking:
      'A supplier without a valid RFC cannot be identified on the filing, and the alternative to stopping is declaring that those purchases had no known counterparty.',
    whatIDo: 'I refuse to build the DIOT and name the suppliers whose RFC is missing, malformed or generic.',
    ifSkipped: 'I refuse and name them.',
    priority: 30,
  },
  {
    key: 'diot_iva_exento_y_base',
    category: 'contable',
    question: 'How is exempt activity reported when the source document did not carry its base?',
    impact:
      'The DIOT declares the VALUE of the acts, not only the tax. An exempt line carries no tax ' +
      'amount and, until now, the parser dropped it entirely: a CFDI 4.0 exempt node has ' +
      'TipoFactor="Exento" and no Importe, so it was discarded in silence.',
    options: [
      { value: 'exigir_base', label: 'Require the base: refuse to report a period with exempt lines whose value is unknown' },
      { value: 'derivar_del_subtotal', label: 'Derive it from the line subtotal' },
      { value: 'omitir_y_avisar', label: 'Leave those lines out and list them' },
    ],
    defaultValue: 'exigir_base',
    defaultRationale:
      'Exempt activity is not the absence of an operation: it is an operation the DIOT wants counted, ' +
      'and understating it understates the total the authority reconciles against your VAT return. ' +
      'Deriving from the subtotal is right often enough to be dangerous — it silently breaks wherever ' +
      'a line mixes exempt and taxed concepts. Now that the base is captured at ingestion, requiring ' +
      'it means requiring something the document already said.',
    whyAsking:
      'Exempt purchases still count on the filing, and they are the ones whose amount the system used to throw away without telling anyone.',
    whatIDo: 'I stop and name the documents whose exempt base is unknown instead of guessing it.',
    ifSkipped: 'I require the base and name what is missing.',
    priority: 35,
  },
  {
    key: 'efirma_sellado_contabilidad_electronica',
    category: 'contable',
    question: 'Does the system seal the Anexo 24 files with your e.firma, or do you seal them yourself?',
    impact:
      'Sealing means the private key of the taxpayer is loaded and used by this software. The files ' +
      'it produces are a declaration to the tax authority signed in your name.',
    options: [
      {
        value: 'nunca_sellar_en_el_sistema',
        label: 'Never: the system produces the unsealed XML and you seal and transmit it yourself',
      },
      {
        value: 'sellar_con_custodia',
        label: 'Seal here, with the key held in the credential vault and every use logged',
      },
    ],
    defaultValue: 'nunca_sellar_en_el_sistema',
    defaultRationale:
      'The e.firma is the taxpayer signing, not the software. Producing the file and signing it are ' +
      'different acts and belong to different hands: this system builds the XML, shows you what it ' +
      'contains, and stops. The vault exists for the credentials the system genuinely needs; the ' +
      'signature on a declaration is not one of them. Firms that decide otherwise can say so here, ' +
      'and then every decryption is logged — but the default is that your key never enters this ' +
      'process.',
    whyAsking:
      'Sealing an Anexo 24 file means your private key is used by this software to sign a declaration in your name. That is not a technical detail I get to assume for you: it is your signature.',
    whatIDo: 'I build the XML unsealed and hand it to you; the sealing and the transmission are yours.',
    ifSkipped: 'I never seal: your key does not enter this process.',
    priority: 15,
  },
  {
    key: 'anexo24_cuenta_sin_agrupador',
    category: 'contable',
    question: 'Generating the Anexo 24 catalogue with accounts that have no grouping code: refuse, or emit them?',
    impact:
      'The CtaCatalogo node requires CodigoAgrupador on every account. An account without one either ' +
      'gets left out of the file — so the balance references an account the catalogue does not ' +
      'declare — or goes in empty and the XSD rejects it.',
    options: [
      { value: 'bloquear', label: 'Refuse to generate until every account carries its grouping code' },
      { value: 'omitir_y_avisar', label: 'Leave them out of the file and list them' },
    ],
    defaultValue: 'bloquear',
    defaultRationale:
      'Emitting an incomplete catalogue is worse than emitting none: the balance filed afterwards ' +
      'references accounts the catalogue never declared, and that inconsistency is exactly what the ' +
      'authority validates across filings. Stopping costs a mapping session; filing a catalogue that ' +
      'contradicts the balance costs a rejection with the deadline already spent.',
    whyAsking:
      'Every account in the file needs its SAT grouping code, and I can either stop and tell you which ones are missing or hand you a catalogue that does not match the balance you will file next.',
    whatIDo: 'I refuse to generate and name the accounts that are missing their grouping code.',
    ifSkipped: 'I refuse and name them.',
    priority: 25,
  },
  {
    key: 'anexo24_niveles_a_presentar',
    category: 'contable',
    question: 'Which levels of the chart go into the Anexo 24 catalogue?',
    impact:
      'The file declares the hierarchy through SubCtaDe and Nivel. Filing only the top levels hides ' +
      'the detail the authority uses to follow an entry; filing everything exposes a chart that may ' +
      'carry internal analytical accounts.',
    options: [
      { value: 'jerarquia_completa', label: 'Every account, with its parent and level' },
      { value: 'hasta_nivel_2', label: 'Only rubros and first-level accounts' },
      { value: 'las_que_se_mueven', label: 'Only accounts with posted movement, plus their parents' },
    ],
    defaultValue: 'jerarquia_completa',
    defaultRationale:
      'The catalogue is the map the authority reads the balance and the entries against, so an account ' +
      'that appears in either must appear here. Trimming it creates references the file cannot ' +
      'resolve, and the hierarchy is precisely what SubCtaDe exists to carry.',
    whyAsking:
      'The file has to declare the hierarchy of your chart, and how deep it goes decides whether a later filing can reference an account this catalogue never mentioned.',
    whatIDo: 'I include the whole chart with its parent-child structure.',
    ifSkipped: 'I include every account with its hierarchy.',
    priority: 30,
  },
  {
    key: 'agrupador_alcance_de_la_compuerta',
    category: 'contable',
    question: 'Which accounts must carry a SAT grouping code before the books can be filed?',
    impact:
      'Decides who the gate accuses. It currently filters by account_level <= 2, which on a real ' +
      'chart reported 43 gaps of which 42 were accounts with no movement at all — while the one ' +
      'account that HAD moved without a grouping code was not reported. It fails in both directions.',
    options: [
      { value: 'cuentas_con_movimientos', label: 'Only accounts with posted movement in the period' },
      { value: 'todas_las_de_detalle', label: 'Every detail account, moved or not' },
      { value: 'todas', label: 'Every account in the chart' },
    ],
    defaultValue: 'cuentas_con_movimientos',
    defaultRationale:
      'What the SAT reads is the balance and the entries, so an account that never moved cannot ' +
      'misgroup anything. Accusing the whole chart buries the one account that matters under dozens ' +
      'that do not, which is exactly how a gate stops being read.',
    whyAsking:
      'A chart of accounts always has rows nobody ever posts to. Telling you about those is noise, and noise is how a warning stops being read — but the account that DID move and has no grouping code is a filing you cannot make.',
    whatIDo: 'I only flag accounts that actually moved in the period being filed.',
    ifSkipped: 'I flag accounts with movement.',
    priority: 30,
  },
  {
    key: 'agrupador_faltante_al_cierre',
    category: 'contable',
    question: 'Closing a month with accounts that moved and have no SAT grouping code: warn, or refuse?',
    impact:
      'Without a grouping code those accounts cannot go into the Anexo 24 catalogue, so the filing ' +
      'for that month is impossible until someone maps them.',
    options: [
      { value: 'avisar', label: 'Warn: the checklist item goes red and the close continues' },
      { value: 'bloquear', label: 'Refuse to close until every moved account is mapped' },
    ],
    defaultValue: 'avisar',
    defaultRationale:
      'The close is an accounting act and the grouping code is a filing requirement: blocking the ' +
      'books because of a tax catalogue confuses two obligations with different deadlines. The ' +
      'warning is what gives you the days between closing and filing to fix it.',
    whyAsking:
      'Closing the month and filing it with the SAT are two different deadlines, and an unmapped account only breaks the second one — so you may reasonably want to close anyway and map before you file.',
    whatIDo: 'I put the item in red on the close checklist, naming the accounts, and let the close proceed.',
    ifSkipped: 'I warn and name them.',
    priority: 30,
  },
  {
    key: 'agrupador_valor_fuera_de_catalogo',
    category: 'contable',
    question: 'A grouping code that is not in the official SAT catalogue for that year: accept or reject?',
    impact:
      'The c_CodAgrup catalogue is revised by the authority, so a code valid in 2022 may not be in ' +
      '2026, and a filing is validated against the catalogue in force for its fiscal year.',
    options: [
      { value: 'rechazar', label: 'Reject: the code must exist in the catalogue in force' },
      { value: 'avisar', label: 'Accept it and warn' },
    ],
    defaultValue: 'rechazar',
    defaultRationale:
      'An invalid grouping code does not fail here: it fails at the SAT, after the file was sealed ' +
      'with the e.firma and transmitted, when the deadline has already run. Catching it at capture ' +
      'costs one message; catching it at the tax authority costs a rejected filing.',
    whyAsking:
      'The SAT publishes and revises this catalogue, so a code that was right two years ago can be wrong today — and the file only gets rejected after you have already sealed and sent it.',
    whatIDo: 'I refuse a grouping code that is not in the catalogue in force for that year, and say which one it is.',
    ifSkipped: 'I reject codes outside the catalogue.',
    priority: 35,
  },
  {
    key: 'anexo24_balanza_saldo_inicial',
    category: 'contable',
    question: 'Where does the opening balance of the Anexo 24 trial balance come from?',
    impact:
      'The SAT recomputes SaldoIni + Debe − Haber = SaldoFin on the filed balance. Today the opening ' +
      'balance is only seeded by the HARD close, so an entity that only soft-closes would file zeros ' +
      'in every account — a sealed declaration that the company opened the month at nothing.',
    options: [
      {
        value: 'derivar_del_mayor',
        label: 'Derive it from the ledger: sum everything posted before the period starts',
      },
      {
        value: 'exigir_cierre_duro',
        label: 'Require a hard close: refuse to build the balance without a seeded opening balance',
      },
    ],
    defaultValue: 'derivar_del_mayor',
    defaultRationale:
      'The ledger already holds the answer and the reporting layer already knows how to ask for it, ' +
      'so deriving costs one query and is true whatever the period status. Requiring a hard close ' +
      'would make a filing obligation depend on an internal bookkeeping ceremony that the law does ' +
      'not mention.',
    whyAsking:
      'Your opening balance is only stored when a period is closed hard, and the filing needs it every month — so I either take it from the ledger or refuse to build the balance at all.',
    whatIDo: 'I derive the opening balance from everything posted before the period, whatever its close status.',
    ifSkipped: 'I derive it from the ledger.',
    priority: 30,
  },
  {
    key: 'informes_asientos_de_cierre',
    category: 'contable',
    question:
      'When a report covers the date the year was closed, do its closing entries count as activity?',
    impact:
      'The closing entry is dated at the END of the period it closes — inside the range the income ' +
      'statement queries. Counting it zeroes the year out: a company with 10,000 in sales prints ' +
      '«Net income 0.0000». Excluding it from the statement while keeping it in the trial balance is ' +
      'the only combination where both documents are true at once.',
    options: [
      {
        value: 'estado_sin_cierre_balanza_con_cierre',
        label: 'Income statement excludes them; the trial balance includes them and says so',
      },
      { value: 'excluir_siempre', label: 'No report ever counts them' },
      { value: 'incluir_siempre_y_advertir', label: 'Every report counts them and warns the range contains a close' },
    ],
    defaultValue: 'estado_sin_cierre_balanza_con_cierre',
    defaultRationale:
      'The income statement answers «what did the business earn», and the closing entry is not ' +
      'earnings: it is the act of putting earnings away. The trial balance answers «what do the ' +
      'books say», and there the entry IS part of the books — hiding it would break the tie with ' +
      'the general ledger that the Anexo 24 is checked against.',
    whyAsking:
      'The entry that closes your year falls inside the range your year-end reports ask for, so I have to know whether to count it.',
    whatIDo: 'I leave closing entries out of the income statement and keep them in the trial balance.',
    ifSkipped: 'I exclude them from the statement and include them in the trial balance.',
    priority: 20,
  },
  {
    key: 'destino_del_resultado_del_ejercicio',
    category: 'contable',
    question: 'At year-end close, where does the result go: straight to retained earnings, or through «Result of the Period» first?',
    impact:
      'Decides whether the balance sheet can still show what THIS year earned after the close. Sweeping ' +
      'straight to 3200 merges it with every prior year on the day of the close, before the shareholders ' +
      'have approved anything.',
    options: [
      {
        value: 'dos_pasos_hasta_asamblea',
        label: 'Close to «Result of the Period» (3300); a later audited reclassification moves it to Retained Earnings (3200)',
      },
      { value: 'directo_a_acumulados', label: 'Close straight to Retained Earnings (3200)' },
    ],
    defaultValue: 'dos_pasos_hasta_asamblea',
    defaultRationale:
      'Mexican practice keeps the year result separate until the asamblea resolves what to do with it ' +
      '(dividends, reserva legal, capitalisation) — LGSM art. 19 forbids distributing profits until ' +
      'losses are absorbed, and that argument needs the year to still be identifiable. The account ' +
      '3300 already exists in the seeded chart and nothing writes to it.',
    whyAsking:
      'After closing December, your balance sheet either still shows what this year earned or folds it into the accumulated total. That is a presentation decision, and it is yours.',
    whatIDo: 'I close the year into 3300 and leave the move to 3200 as a separate, audited act.',
    ifSkipped: 'I use the two-step route through «Result of the Period».',
    priority: 25,
  },
  {
    key: 'cierre_recierre_de_periodo_reabierto',
    category: 'contable',
    question: 'If a year-end period that already emitted its closing entry is reopened and closed again, what happens to the first one?',
    impact:
      'Today the second close emits a COMPLETE second set of closing entries and nothing removes the ' +
      'first: retained earnings takes the result twice. `period reopen` made this reachable from the ' +
      'terminal, so the answer stopped being hypothetical.',
    options: [
      {
        value: 'reversar_y_reemitir',
        label: 'Reverse the previous closing entry (own folio, audited reason) and emit the close again in full',
      },
      { value: 'incremental', label: 'Leave the first close standing; the new one sweeps only what is left' },
      { value: 'prohibir', label: 'Refuse: a period whose close was emitted is corrected by explicit reclassification, not by closing again' },
    ],
    defaultValue: 'reversar_y_reemitir',
    defaultRationale:
      'It is the only option that leaves the books stating one truth and shows how they got there: ' +
      'NIF B-1 corrects by reversal, never by edit, and the reversal is the evidence that the first ' +
      'close was undone on purpose. «Incremental» would depend on the first close having been right, ' +
      'which is precisely what a reopening puts in doubt.',
    whyAsking:
      'Reopening a closed year means its closing entry is already sitting in the books, and closing again will write a second one. I need to know whether to undo the first or leave it standing.',
    whatIDo: 'I reverse the previous closing entry with its reason recorded, then close again from scratch.',
    ifSkipped: 'I reverse and re-emit.',
    priority: 25,
  },
  {
    key: 'severidad_resultado_sin_barrer',
    category: 'contable',
    question: 'If the year-end close finishes and some revenue or expense account still carries a balance, is that a warning or a failure?',
    impact:
      'A close that leaves accounts unswept has not closed the year, and the very defect this check ' +
      'exists to catch —the abs() that doubled returns instead of sweeping them— produced exactly ' +
      'that: accounts left at twice their balance while the entry itself balanced and every other ' +
      'indicator read green.',
    options: [
      { value: 'bloquear_cierre', label: 'Fail: the hard close rolls back and the period stays open' },
      { value: 'avisar', label: 'Warn: the close completes and the residue is reported with its remedy' },
      {
        value: 'tolerancia',
        label: "Accept up to the entity's closing tolerance and fail above it",
      },
    ],
    defaultValue: 'bloquear_cierre',
    defaultRationale:
      'The close is what makes the year final; a close that half-worked leaves the next year seeded ' +
      'from wrong opening balances, and by the time anyone notices the statements are signed. ' +
      'Stopping is recoverable — a wrong opening balance carried forward is not.',
    whyAsking:
      'When the close cannot sweep an account to zero, either it stops and tells you or it finishes and hopes you read the warning.',
    whatIDo: 'I roll the close back and name the accounts that would not sweep.',
    ifSkipped: 'I refuse to complete a close that leaves results unswept.',
    priority: 20,
  },
  {
    key: 'fuente_tipo_cambio',
    category: 'contable',
    question: 'When I need an exchange rate for a date, which published source do I use?',
    impact:
      'Every foreign-currency conversion reads the rate of this source for the operation date. If that ' +
      'source has no rate for that date, the conversion STOPS and says so — it never silently borrows a ' +
      'rate from another source, because that would be choosing tax criteria for you.',
    options: [
      { value: 'dof', label: 'DOF (Diario Oficial; the tax rate under art. 20 CFF)' },
      { value: 'fix_banxico', label: 'Banxico FIX (the reference rate, published as banco_mexico)' },
      { value: 'manual', label: 'Rates I set by hand with `fx rate set`' },
    ],
    defaultValue: 'dof',
    defaultRationale:
      'In Mexico the rate with legal effect is the one published in the Diario Oficial (art. 20 CFF): VAT ' +
      'creditable on a foreign-currency payment converts at the DOF rate, and the FIX is a different ' +
      'number for the same day. A Mexican books-first system defaults to the source the SAT will measure ' +
      'it against; firms with treasury reasons to prefer the FIX can say so here.',
    whyAsking:
      'DOF and FIX for the same day are different numbers, and which one your books use is a criterion, not a preference.',
    whatIDo: 'I convert with the rate of the chosen source for the operation date, and stop if it is missing.',
    ifSkipped: 'I use the DOF rate.',
    priority: 55,
  },
  {
    key: 'rep_moneda_extranjera',
    category: 'contable',
    question: 'A receipt in a currency other than the functional one: what do we do with the exchange difference?',
    impact:
      'Decides whether foreign-currency receipts are matched at all. Vendor payments now compute the ' +
      'realised difference (R4), but the REP matcher still does not, so matching here would post an ' +
      'invented figure.',
    options: [
      { value: 'no_casar', label: 'Do not match: leave it for review with a multi-currency warning' },
      { value: 'tc_documento', label: "Match at the document's rate and recognise no difference" },
    ],
    defaultValue: 'no_casar',
    defaultRationale:
      'Since R4 the vendor-payment path DOES post realised differences to the exchange gain/loss ' +
      'accounts, but the REP matcher does not share that engine yet. The problem is also double, ' +
      'not single: NIF B-15 wants the fluctuation in the period it occurs, while for VAT the creditable ' +
      'amount is the one actually paid converted at the DOF rate of the payment date — two different ' +
      'rates the system does not yet tell apart. Stopping and saying so is honest.',
    whyAsking:
      'A payment in dollars against an invoice in pesos creates an exchange difference that has to land somewhere. I cannot compute it correctly yet, so I would rather stop than invent it.',
    whatIDo: 'I leave the receipt unmatched and tell you, instead of guessing a rate.',
    ifSkipped: 'I do not match foreign-currency receipts, and I say so each time.',
    priority: 55,
  },

  // ── Security ──
  {
    key: 'efirma_max_accesos_diarios',
    category: 'seguridad',
    question: 'How many e.firma decryptions per day are normal?',
    impact:
      'This is the limit that triggers denial and the anomalous-access signal. Too high = the signal loses ' +
      'value; too low = it interrupts legitimate sync. It should come from the real download cadence.',
    options: [
      { value: '4', label: '4 — sync every 6 hours' },
      { value: '24', label: '24 — one per hour' },
      { value: '96', label: '96 — every 15 minutes' },
    ],
    defaultValue: '24',
    defaultRationale: 'One per hour: generous for any reasonable cadence, but it bounds abuse.',
    whyAsking:
      'Your e.firma is decrypted every time I authenticate with the SAT. A limit turns an abnormal access pattern into a visible signal — but only if it reflects your real sync cadence.',
    whatIDo:
      'Above that number of decryptions in 24 hours I deny access and log it as an anomaly.',
    ifSkipped:
      'I allow 24 per day (one per hour), which is generous: an abuse would have to be large before the signal fires.',
    priority: 15,
  },
  {
    key: 'efirma_accion_anomalia',
    category: 'seguridad',
    question: 'When an anomalous e.firma access pattern is detected, block or only alert?',
    impact:
      'Blocking protects but can take down a client sync on a false positive. ' +
      'Alerting does not interrupt but requires someone watching. Defines whether you need on-call coverage.',
    options: [
      { value: 'bloquear', label: 'Block the credential and notify' },
      { value: 'alertar', label: 'Only alert and let it continue' },
      { value: 'bloquear_fuera_horario', label: 'Block only outside the defined time window' },
    ],
    defaultValue: 'alertar',
    defaultRationale:
      'The daily limit already denies the excess; blocking the whole credential without someone on call ' +
      'to handle it would leave the client without service until somebody notices.',
    whyAsking:
      'When the access pattern looks wrong I can block the credential or just alert. Blocking protects but a false positive takes down your sync; alerting never interrupts but needs someone watching.',
    whatIDo:
      'It decides what happens the moment an anomaly is detected.',
    ifSkipped:
      'I only alert. If nobody is watching the alerts, an abnormal access could continue unnoticed.',
    priority: 18,
  },

  // ── Operations ──
  {
    key: 'ingest_auto_post',
    category: 'operativa',
    question: 'Is auto-posting enabled for CFDI ingestion?',
    impact:
      'With auto-post off, everything stays in draft for review. On, the system posts without ' +
      'intervention when the confidence, amount, and known-vendor thresholds are met.',
    options: [
      { value: 'off', label: 'Off: everything goes to human review' },
      { value: 'shadow', label: 'Shadow: run every gate, record the verdict, post NOTHING — builds the track record' },
      { value: 'on', label: 'On with the configured thresholds' },
    ],
    defaultValue: 'off',
    defaultRationale:
      'Better to measure for several weeks how often it would get it right before letting it move money on its own.',
    whyAsking:
      'I can classify an invoice and post it without asking, or always leave it as a draft for you to approve. Turning it on saves work; leaving it off means nothing reaches your books unreviewed.',
    whatIDo:
      'With it off, every AI-classified invoice waits for your approval in `mnemosine review`. With it on, invoices meeting the confidence, amount and known-vendor thresholds post on their own.',
    ifSkipped:
      'It stays off: everything goes through your review, which is the safe way to start.',
    priority: 12,
  },
  {
    key: 'ingest_auto_post_max_monto',
    category: 'operativa',
    question: 'What is the maximum amount the AI can post without human review?',
    impact: 'Hard cap for auto-posting. Above this amount it always goes through review.',
    options: [
      { value: '5000', label: '$5,000 — minor expenses only' },
      { value: '10000', label: '$10,000' },
      { value: '50000', label: '$50,000' },
    ],
    defaultValue: '10000',
    defaultRationale: 'Bounds the exposure while a track record is built.',
    whyAsking:
      'Even with auto-posting on, there is an amount above which you probably want to look yourself before it touches the books.',
    whatIDo:
      'It is a hard cap: above that amount an invoice always goes to review, no matter how confident the classification is.',
    ifSkipped:
      'The cap stays at $10,000.',
    priority: 13,
  },

  // ── Business ──
    // pac_ofrece_descarga se RETIRÓ en F02: la descarga masiva está bloqueada
  // por E3.2 y no existe camino de código cuya conducta la respuesta pueda
  // cambiar — una pregunta sin efecto posible viola E1.3 («contestar una
  // política cambia el comportamiento de alguien») y entrena al despacho a
  // ignorar el panel. Vuelve CON el flujo de descarga, como su primera clave.
  {
    // F02 · REP-2: qué hace el CIERRE con un pago a proveedor sin REP. El
    // IVA de ese pago sigue aparcado en 1135 y no es acreditable; cerrar el
    // mes con eso pendiente es una decisión del despacho, no del sistema.
    key: 'rep_faltante_recibido',
    category: 'fiscal',
    question: 'At close, a supplier payment still has no REP (its VAT is parked). Block the close or just warn?',
    impact:
      'With "bloquear", the soft close refuses while any period payment lacks its REP; with "avisar" it ' +
      'closes and the checklist records the parked VAT.',
    options: [
      { value: 'avisar', label: 'Warn: close proceeds, the parked VAT stays visible in the checklist' },
      { value: 'bloquear', label: 'Block: no close until every payment has its REP' },
    ],
    defaultValue: 'avisar',
    defaultRationale:
      'A supplier who is late with their REP should not freeze your whole close; the parked VAT is ' +
      'visible either way and rep missing list names the culprits.',
    whyAsking:
      'The REP is what makes PPD VAT creditable. Some firms refuse to close a month with parked VAT; others close and chase the supplier.',
    whatIDo:
      'It decides whether getPeriodCloseStatus counts missing supplier REPs as a blocking issue or a warning.',
    ifSkipped: 'It warns: the close proceeds and the checklist shows the pending REPs.',
    priority: 22,
  },
  {
    // F02 · REP-2: el espejo del anterior, pero con OBLIGACIÓN PROPIA — el
    // REP de un cobro nuestro lo debemos EMITIR nosotros, con plazo del SAT.
    key: 'rep_faltante_emitido',
    category: 'fiscal',
    question: 'At close, a customer collection has no REP issued by us. Block the close or just warn?',
    impact:
      'The REP for a collected PPD invoice is OUR filing obligation, with a SAT deadline. "bloquear" ' +
      'refuses the close while any collection lacks its REP; "avisar" closes and records it.',
    options: [
      { value: 'bloquear', label: 'Block: our own REP obligation must be met before closing' },
      { value: 'avisar', label: 'Warn: close proceeds, the obligation stays on the checklist' },
    ],
    defaultValue: 'avisar',
    defaultRationale:
      'Warning keeps the close usable from day one; switch to bloquear when REP issuance (rep stamp) ' +
      'exists in the system and the obligation can be met from here.',
    whyAsking:
      'Unlike the supplier case, this REP is ours to issue and the SAT deadline is ours to miss. Whether that blocks your close is firm policy.',
    whatIDo:
      'It decides whether getPeriodCloseStatus counts our unissued REPs as a blocking issue or a warning.',
    ifSkipped: 'It warns: the close proceeds and the checklist shows the obligation.',
    priority: 21,
  },
  {
    // F01 · maker-checker humano (segregación de funciones). La decisión §5
    // del plan maestro: no se difiere tácitamente ni se decide en código —
    // vive aquí, con default que no rompe al despacho unipersonal. Aplica
    // SOLO a pólizas manuales (source_type nulo): en los flujos del sistema
    // (nómina, aprobación de borradores de IA, reversas) creador=posteador
    // es intencional y el maker real queda trazado por source_type/source_id.
    key: 'segregacion_de_funciones',
    category: 'seguridad',
    question: 'May the person who did the work also sign it off?',
    impact:
      'Four-eyes control, on TWO acts that ask the same question. On the manual path: with "exigir", ' +
      'entry post rejects the drafter posting their own entry. On the bank path: it rejects the ' +
      'person who closed a reconciliation session also approving it. With "alertar" both go through ' +
      'and the audit row records the coincidence; off means no check. One key and not two on purpose ' +
      "— it is one decision about the firm's hands, and two keys for it would drift apart.",
    options: [
      { value: 'off', label: 'Off: anyone may post what they drafted (single-person firm)' },
      { value: 'alertar', label: 'Warn: post succeeds, the audit trail records the coincidence' },
      { value: 'exigir', label: 'Enforce: the poster must be a different user than the drafter' },
    ],
    defaultValue: 'off',
    defaultRationale:
      'A one-person firm cannot separate duties; enforcing by default would freeze every posting. ' +
      'Turn it on when there are at least two users.',
    whyAsking:
      'Separation of duties is the classic control against a single person inventing and applying an entry. Whether your firm can afford it depends on how many hands it has.',
    whatIDo:
      'With "exigir", `entry post` refuses when the poster created the draft, and `bank reconciliation approve` refuses when the approver is the one who closed the session (system flows are exempt: they are traced by source). With "alertar", both go through and leave the fact in the audit log.',
    ifSkipped:
      'It stays off: no separation check, which is the only workable default for a single-user tenant — a one-person firm that had to find a second signer would never close a month.',
    priority: 30,
  },
  {
    // F05c · Lo que «cuadra» significa. La fila 1247 del catálogo exige
    // variación EXACTAMENTE cero; la familia genérica de certificación habla
    // de tolerancia. El criterio es del despacho, no del programa.
    key: 'conciliacion_tolerancia',
    category: 'contable',
    question: 'Must a bank reconciliation come to exactly zero, or may a small residual be carried?',
    impact:
      'Governs `bank reconciliation close`. With "cero_exacto" the session only reaches `balanced` ' +
      'when the two sides agree to the cent, and the close checklist can be read as proof the cash ' +
      'was verified. With a tolerance, anything under it is carried as a named reconciling item ' +
      'instead of blocking — faster to close, and the residual has to be chased later or it ages.',
    options: [
      { value: 'cero_exacto', label: 'Exactly zero: nothing closes until the two sides agree to the cent' },
      { value: 'tolerancia_con_residual', label: 'Allow a residual under the tolerance, carried as a named item' },
    ],
    defaultValue: 'cero_exacto',
    defaultRationale:
      'The close checklist reads a balanced session as evidence the cash balance was verified. A ' +
      'tolerance makes that evidence weaker than it looks, so it has to be asked for, never assumed.',
    whyAsking:
      'A bank reconciliation that "almost" agrees is the oldest place for an error to hide: the residual is small every month and never the same small thing. Whether your firm closes on an exact zero is a real policy — some do, some carry a tolerance and chase it.',
    whatIDo:
      'With "cero_exacto" I refuse to close a session whose two sides differ by a cent, and tell you what is unexplained. With a tolerance I close it and leave the residual as a reconciling item with an owner and a date, so it cannot quietly age.',
    ifSkipped:
      'I demand an exact zero. Nothing breaks; some months you will have to chase a cent before I close.',
    priority: 36,
  },
  {
    // F05c · La línea de banco que nadie explica al cerrar.
    key: 'linea_banco_sin_partida_al_cierre',
    category: 'contable',
    question: 'At close, what happens to a bank line with no book entry to explain it?',
    impact:
      'Governs `bank reconciliation close` when the statement shows a movement the books never ' +
      'recorded and nobody has classified. "partida_conciliatoria" carries it as a named, owned, ' +
      'dated item; "bloquear_cierre" refuses to close until a person says what it is; "suspenso" ' +
      'parks it in a suspense account, which is a real practice and also the classic place for a ' +
      'difference to go to die.',
    options: [
      { value: 'partida_conciliatoria', label: 'Carry it as a reconciling item, with owner and expected date' },
      { value: 'bloquear_cierre', label: 'Refuse to close until someone classifies it' },
      { value: 'suspenso', label: 'Post it to a suspense account and clear it later' },
    ],
    defaultValue: 'partida_conciliatoria',
    defaultRationale:
      'Keeps the movement visible and chaseable without stopping the close. Blocking is stricter ' +
      'but stalls the month on one unknown line; suspense hides it behind a balance.',
    whyAsking:
      'Sooner or later the bank shows a movement your books never recorded and nobody recognises. What you do with it on closing day is a choice between stopping the month, carrying it in the open, or parking it — and the third one is how differences disappear.',
    whatIDo:
      'By default I carry it as a reconciling item, so it appears in `bank reconciling-item list` with its age until somebody resolves it. If you choose "suspenso" I will still name it every month it stays there — a suspense account is not a place to stop looking.',
    ifSkipped:
      'I carry it in the open as a reconciling item, which is the option that keeps it visible.',
    priority: 37,
  },
  {
    // F05b · El cotejo automático. `confidence >= 0.85` estaba escrito a mano
    // en el motor, sin bandera y sin que nadie lo hubiera elegido.
    key: 'cotejo_umbral_confianza',
    category: 'operativa',
    question: 'How sure must the matching engine be before it pairs a bank line on its own?',
    impact:
      'Governs `bank match run`. Lower means fewer lines left for a human and more wrong pairs to undo; ' +
      'higher means the engine hands you more work but almost never guesses. A wrong match is not ' +
      'silent — `bank match unapply` undoes it and leaves the reason — but it costs the review it ' +
      'was meant to save.',
    options: [
      { value: '0.75', label: 'Loose: pairs more on its own, expect to undo some' },
      { value: '0.85', label: 'Balanced: only pairs when amount and date agree closely' },
      { value: '0.95', label: 'Strict: the engine barely decides anything alone' },
    ],
    defaultValue: '0.85',
    defaultRationale:
      'What the engine already used before anyone was asked. Named here so it stops being an ' +
      'accident of the code.',
    whyAsking:
      'Every bank line has to end up paired with something in your books. I can do that for you when the amount and the date line up, but "how close is close enough" is a judgement about your own tolerance for undoing my mistakes, not a fact I can look up.',
    whatIDo:
      'Above this number I pair the line and record how sure I was. Below it I leave it for you with my best candidate and the reason it fell short. Description similarity alone NEVER pairs anything, at any threshold.',
    ifSkipped:
      'I use 0.85, which pairs on a close amount-and-date agreement and leaves the rest to you.',
    priority: 40,
  },
  {
    // F05b · El techo por importe. El catálogo manda engancharse al piso
    // existente y no inventar una compuerta paralela.
    key: 'cotejo_monto_maximo_auto',
    category: 'operativa',
    question: 'Above what amount must a human confirm a match, however sure the engine is?',
    impact:
      'A second gate on `bank match run`, independent of confidence: over this amount the line is ' +
      'left for a person even at 0.99. Combined with the unbreakable floor by Math.min, so the ' +
      'stricter of the two always wins and no setting here can raise it.',
    options: [
      { value: '10000', label: '$10,000 — a person sees every material movement' },
      { value: '50000', label: '$50,000 — same ceiling the auto-posting floor uses' },
      { value: '0', label: 'No amount gate: confidence alone decides' },
    ],
    defaultValue: '50000',
    defaultRationale:
      'Aligns with FLOOR_MAX_AUTO_POST so there is one number to reason about, not two. It is a ' +
      'ceiling on the engine, never a permission: the floor still clamps it.',
    whyAsking:
      'Confidence measures how well two records resemble each other, not how much it costs to be wrong. A big transfer that looks exactly like an invoice is still the one you would want to see with your own eyes.',
    whatIDo:
      'Over this amount I stop and show you the candidate instead of pairing it, no matter how sure I am. Under it, the confidence threshold decides.',
    ifSkipped:
      'I stop at $50,000, the same ceiling that governs automatic posting.',
    priority: 41,
  },
  {
    // F04 · El pago corto. `payment apply --mode residual` cierra un gasto
    // pagando MENOS de lo que debía: la diferencia deja de deberse y tiene que
    // ir a alguna cuenta. Cuál, es criterio del despacho — no del programa —
    // y por eso se pregunta aquí en vez de decidirse en el código.
    key: 'pago_corto_residual',
    category: 'contable',
    question: 'When a bill is closed paying less than it owed, where does the shortfall go?',
    impact:
      'Governs `payment apply --mode residual`. With "descuento_compras" the shortfall lands in ' +
      '5200 (contra-cost), the same account as an early-payment discount, so the cost of the ' +
      'purchase drops. With "otros_ingresos" it is income of the period instead, leaving the cost ' +
      'untouched. With "prohibir" the mode is refused outright and the bill stays open until the ' +
      'vendor issues a credit note.',
    options: [
      {
        value: 'descuento_compras',
        label: 'Contra-cost (5200): it reduces what the purchase cost, like a discount',
      },
      {
        value: 'otros_ingresos',
        label: 'Other income: the cost stands and the shortfall is a gain of the period',
      },
      {
        value: 'prohibir',
        label: 'Refuse: no bill closes short — demand the vendor credit note',
      },
    ],
    defaultValue: 'descuento_compras',
    defaultRationale:
      'It keeps a short payment and an early-payment discount in the same account, which is what ' +
      'they economically are: less paid for the same purchase. It also avoids inflating revenue ' +
      'with something that was never a sale.',
    whyAsking:
      'Sometimes a bill is settled for less than its balance — a disputed freight charge, a few pesos of rounding, an agreed deduction — and the remainder is never going to be paid. That remainder has to stop being a liability, and where you send it changes your cost of sales and your income. It is a criterion of your firm, not a rule of the SAT.',
    whatIDo:
      'When you close a bill short with `payment apply --mode residual --short-pay-reason "..."`, I post the shortfall to the account you choose here and write your reason into the entry, so the auditor reads why the liability disappeared. If you choose "prohibir", I refuse the operation and tell you to ask the vendor for a credit note.',
    ifSkipped:
      'Shortfalls go to purchase discounts (5200). Nothing breaks, but if your criterion is to treat them as income, the cost of sales will be understated until you say so.',
    priority: 35,
  },
];

export function getPolicySpec(key: string): PolicySpec | undefined {
  return POLICY_CATALOG.find((p) => p.key === key);
}
