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
    key: 'rep_moneda_extranjera',
    category: 'contable',
    question: 'A receipt in a currency other than the functional one: what do we do with the exchange difference?',
    impact:
      'Decides whether foreign-currency receipts are matched at all. The system does not compute exchange ' +
      'differences today, so anything other than stopping would post an invented figure.',
    options: [
      { value: 'no_casar', label: 'Do not match: leave it for review with a multi-currency warning' },
      { value: 'tc_documento', label: "Match at the document's rate and recognise no difference" },
    ],
    defaultValue: 'no_casar',
    defaultRationale:
      'It is the only one that is currently true: nothing posts to the exchange gain/loss accounts, and ' +
      'the payment service requires payment and document to share a currency. The problem is also double, ' +
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
