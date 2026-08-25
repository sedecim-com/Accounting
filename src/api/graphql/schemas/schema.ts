export const typeDefs = `#graphql
  scalar Date
  scalar DateTime
  scalar Decimal
  scalar JSON

  # ============================================================
  # ENUMS
  # ============================================================

  enum AccountType {
    ASSET
    LIABILITY
    EQUITY
    REVENUE
    EXPENSE
    CONTRA_ASSET
    CONTRA_LIABILITY
    CONTRA_EQUITY
  }

  enum NormalBalance {
    DEBIT
    CREDIT
  }

  enum FSCategory {
    CURRENT_ASSETS
    NON_CURRENT_ASSETS
    CURRENT_LIABILITIES
    LONG_TERM_LIABILITIES
    EQUITY
    REVENUE
    COGS
    OPERATING_EXPENSES
    OTHER_INCOME
    OTHER_EXPENSES
    TAX
  }

  enum JournalEntryType {
    STANDARD
    ADJUSTING
    CLOSING
    REVERSING
    CORRECTION
    AUTO_INVOICE
    AUTO_PAYMENT
    AUTO_DEPRECIATION
    AUTO_RECONCILIATION
  }

  enum JournalEntryStatus {
    DRAFT
    PENDING_APPROVAL
    APPROVED
    POSTED
    VOID
  }

  enum InvoiceStatus {
    DRAFT
    PENDING
    SENT
    VIEWED
    PAID
    PARTIALLY_PAID
    OVERDUE
    VOID
    CANCELLED
    UNCOLLECTIBLE
  }

  enum CfdiStatus {
    PENDING
    STAMPED
    CANCELLED
    FAILED
  }

  enum FiscalPeriodStatus {
    FUTURE
    OPEN
    SOFT_CLOSE
    HARD_CLOSE
    LOCKED
  }

  # ============================================================
  # TYPES
  # ============================================================

  type Account {
    id: ID!
    code: String!
    name: String!
    accountType: AccountType!
    normalBalance: NormalBalance!
    fsCategory: FSCategory
    parent: Account
    children: [Account!]!
    level: Int!
    fullCode: String
    isActive: Boolean!
    isHeader: Boolean!
    allowManualEntries: Boolean!
    entity: LegalEntity!
    currencyCode: String
    description: String
    tags: JSON
    currentBalance(periodId: ID): Decimal
    journalEntryLines(startDate: Date, endDate: Date, limit: Int): [JournalEntryLine!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type JournalEntry {
    id: ID!
    entryNumber: String!
    entryType: JournalEntryType!
    status: JournalEntryStatus!
    entity: LegalEntity!
    fiscalPeriod: FiscalPeriod!
    entryDate: Date!
    postedDate: DateTime
    totalDebits: Decimal!
    totalCredits: Decimal!
    description: String
    notes: String
    attachments: [JSON]
    lines: [JournalEntryLine!]!
    sourceType: String
    sourceId: ID
    isReversal: Boolean!
    createdAt: DateTime!
    createdBy: User
    postedBy: User
    approvedBy: User
  }

  type JournalEntryLine {
    id: ID!
    lineNumber: Int!
    account: Account!
    debitAmount: Decimal
    creditAmount: Decimal
    costCenter: String
    department: String
    project: String
    currencyCode: String
    foreignDebit: Decimal
    foreignCredit: Decimal
    exchangeRate: Decimal
    isReconciled: Boolean!
    description: String
    tags: JSON
  }

  type Invoice {
    id: ID!
    invoiceNumber: String!
    entity: LegalEntity!
    customer: Customer!
    subtotal: Decimal!
    taxAmount: Decimal!
    totalAmount: Decimal!
    amountPaid: Decimal!
    amountDue: Decimal!
    currencyCode: String!
    invoiceDate: Date!
    dueDate: Date!
    deliveryDate: Date
    status: InvoiceStatus!
    lines: [InvoiceLine!]!
    payments: [CustomerPayment!]!
    cfdiUuid: String
    cfdiStatus: CfdiStatus
    cfdiXmlUrl: String
    journalEntry: JournalEntry
    description: String
    memo: String
    terms: String
    poNumber: String
    sentAt: DateTime
    sentTo: String
    pdfUrl: String
    createdAt: DateTime!
  }

  type InvoiceLine {
    id: ID!
    lineNumber: Int!
    itemId: ID
    description: String
    quantity: Decimal!
    unitPrice: Decimal!
    revenueAccount: Account!
    taxCode: String
    taxRate: Decimal
    taxAmount: Decimal!
    lineAmount: Decimal!
    totalAmount: Decimal!
    cfdiProductCode: String
    cfdiUnitCode: String
  }

  type Customer {
    id: ID!
    customerNumber: String!
    companyName: String
    firstName: String
    lastName: String
    email: String
    phone: String
    taxId: String
    isActive: Boolean!
    creditStatus: String!
    invoices(status: InvoiceStatus, limit: Int): [Invoice!]!
  }

  type Vendor {
    id: ID!
    vendorNumber: String!
    companyName: String!
    email: String
    phone: String
    taxId: String
    isActive: Boolean!
    bills(status: String, limit: Int): [Bill!]!
  }

  type Bill {
    id: ID!
    billNumber: String!
    vendor: Vendor!
    subtotal: Decimal!
    taxAmount: Decimal!
    totalAmount: Decimal!
    amountPaid: Decimal!
    amountDue: Decimal!
    billDate: Date!
    dueDate: Date!
    status: String!
    lines: [BillLine!]!
  }

  type BillLine {
    id: ID!
    lineNumber: Int!
    accountId: ID!
    description: String
    quantity: Decimal!
    unitPrice: Decimal!
    lineAmount: Decimal!
    taxAmount: Decimal!
    totalAmount: Decimal!
  }

  type CustomerPayment {
    id: ID!
    paymentNumber: String!
    paymentAmount: Decimal!
    paymentMethod: String!
    paymentDate: Date!
    status: String!
  }

  type LegalEntity {
    id: ID!
    name: String!
    entityType: String!
    taxId: String!
    incorporationCountry: String!
    functionalCurrency: String!
    accountingStandard: String!
  }

  type FiscalPeriod {
    id: ID!
    periodNumber: Int!
    periodName: String!
    startDate: Date!
    endDate: Date!
    status: FiscalPeriodStatus!
  }

  type User {
    id: ID!
    email: String!
    firstName: String
    lastName: String
  }

  # ============================================================
  # REPORTS
  # ============================================================

  type TrialBalance {
    entityId: ID!
    fiscalPeriodId: ID
    asOfDate: Date
    accounts: [TrialBalanceAccount!]!
    totals: TrialBalanceTotals!
  }

  type TrialBalanceAccount {
    accountId: ID!
    accountCode: String!
    accountName: String!
    accountType: AccountType!
    debitTotal: Decimal!
    creditTotal: Decimal!
    endingBalance: Decimal!
  }

  type TrialBalanceTotals {
    totalDebits: Decimal!
    totalCredits: Decimal!
    isBalanced: Boolean!
  }

  type BalanceSheet {
    entityId: ID!
    asOfDate: Date!
    assets: BalanceSheetSection!
    liabilities: BalanceSheetSection!
    equity: BalanceSheetSection!
    totalLiabilitiesAndEquity: Decimal!
  }

  type BalanceSheetSection {
    name: String!
    total: Decimal!
    subsections: [BalanceSheetSubsection!]!
  }

  type BalanceSheetSubsection {
    name: String!
    total: Decimal!
    accounts: [BalanceSheetAccount!]!
  }

  type BalanceSheetAccount {
    id: ID!
    code: String!
    name: String!
    balance: Decimal!
  }

  type IncomeStatement {
    entityId: ID!
    startDate: Date!
    endDate: Date!
    revenue: IncomeStatementSection!
    expenses: IncomeStatementSection!
    netIncome: Decimal!
  }

  type IncomeStatementSection {
    name: String!
    total: Decimal!
    accounts: [IncomeStatementAccount!]!
  }

  type IncomeStatementAccount {
    id: ID!
    code: String!
    name: String!
    amount: Decimal!
  }

  # ============================================================
  # CONNECTION TYPES (Pagination)
  # ============================================================

  type AccountConnection {
    edges: [AccountEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type AccountEdge {
    node: Account!
    cursor: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  # ============================================================
  # INPUT TYPES
  # ============================================================

  input CreateAccountInput {
    code: String!
    name: String!
    accountType: AccountType!
    normalBalance: NormalBalance!
    parentId: ID
    entityId: ID!
    currencyCode: String
    allowManualEntries: Boolean
    description: String
    fsCategory: FSCategory
  }

  input UpdateAccountInput {
    name: String
    description: String
    isActive: Boolean
    fsCategory: FSCategory
    tags: JSON
  }

  input CreateJournalEntryInput {
    entityId: ID!
    entryDate: Date!
    entryType: JournalEntryType
    description: String
    lines: [JournalEntryLineInput!]!
    autoPost: Boolean
  }

  input JournalEntryLineInput {
    lineNumber: Int!
    accountId: ID!
    debitAmount: Decimal
    creditAmount: Decimal
    description: String
    costCenterId: ID
    projectId: ID
    currencyCode: String
    foreignDebit: Decimal
    foreignCredit: Decimal
    exchangeRate: Decimal
  }

  input CreateInvoiceInput {
    entityId: ID!
    customerId: ID!
    invoiceDate: Date!
    dueDate: Date!
    currencyCode: String
    lines: [InvoiceLineInput!]!
    terms: String
    memo: String
    poNumber: String
  }

  input InvoiceLineInput {
    lineNumber: Int!
    itemId: ID
    description: String
    quantity: Decimal!
    unitPrice: Decimal!
    revenueAccountId: ID!
    taxCode: String
    taxRate: Decimal
    projectId: ID
    cfdiProductCode: String
    cfdiUnitCode: String
  }

  # ============================================================
  # QUERIES
  # ============================================================

  type Query {
    account(id: ID!): Account
    accounts(entityId: ID!, accountType: AccountType, isActive: Boolean, search: String, first: Int, after: String): AccountConnection!

    journalEntry(id: ID!): JournalEntry
    journalEntries(entityId: ID!, fiscalPeriodId: ID, status: JournalEntryStatus, startDate: Date, endDate: Date, first: Int, after: String): [JournalEntry!]!

    invoice(id: ID!): Invoice
    invoices(entityId: ID!, customerId: ID, status: InvoiceStatus, startDate: Date, endDate: Date, first: Int): [Invoice!]!

    trialBalance(entityId: ID!, fiscalPeriodId: ID, asOfDate: Date, accountLevel: Int): TrialBalance!
    balanceSheet(entityId: ID!, asOfDate: Date!, consolidate: Boolean): BalanceSheet!
    incomeStatement(entityId: ID!, startDate: Date!, endDate: Date!, consolidate: Boolean): IncomeStatement!

    fiscalPeriods(entityId: ID!, status: FiscalPeriodStatus): [FiscalPeriod!]!
  }

  # ============================================================
  # MUTATIONS
  # ============================================================

  type Mutation {
    createAccount(input: CreateAccountInput!): Account!
    updateAccount(id: ID!, input: UpdateAccountInput!): Account!
    deleteAccount(id: ID!): Boolean!

    createJournalEntry(input: CreateJournalEntryInput!): JournalEntry!
    postJournalEntry(id: ID!): JournalEntry!
    voidJournalEntry(id: ID!, reason: String!): JournalEntry!
    reverseJournalEntry(id: ID!, reversalDate: Date): JournalEntry!

    createInvoice(input: CreateInvoiceInput!): Invoice!
    sendInvoice(id: ID!, to: String!, subject: String, message: String): Invoice!
    voidInvoice(id: ID!): Invoice!
    recordInvoicePayment(invoiceId: ID!, paymentDate: Date!, paymentAmount: Decimal!, paymentMethod: String!): Invoice!

    stampCfdi(invoiceId: ID!, pacProvider: String): Invoice!
    cancelCfdi(invoiceId: ID!, cancellationReason: String!, replacementUuid: String): Invoice!

    softClosePeriod(periodId: ID!, entityId: ID!): FiscalPeriod!
    hardClosePeriod(periodId: ID!, entityId: ID!): FiscalPeriod!
  }

  # ============================================================
  # SUBSCRIPTIONS
  # ============================================================

  type Subscription {
    journalEntryPosted(entityId: ID!): JournalEntry!
    invoicePaid(entityId: ID!): Invoice!
    periodClosed(entityId: ID!): FiscalPeriod!
    bankTransactionImported(bankAccountId: ID!): Int!
  }
`;
