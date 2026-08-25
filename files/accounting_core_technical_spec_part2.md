# Accounting Core - Technical Specification Document (Part 2)
## API Specifications & Functional Modules

---

## 5. API Specifications

### 5.1 REST API Design

#### 5.1.1 Base Principles

**URL Structure:**
```
https://api.accounting-core.com/v1/{resource}
https://api.accounting-core.com/v1/entities/{entity_id}/{resource}
```

**Authentication:**
```
Authorization: Bearer {jwt_token}
X-Entity-ID: {entity_id} (optional, for multi-entity access)
```

**Standard Response Format:**
```json
{
  "data": { ... },
  "meta": {
    "request_id": "req_abc123",
    "timestamp": "2024-01-15T10:30:00Z",
    "version": "v1"
  },
  "errors": [] // Only present if errors occurred
}
```

**Pagination:**
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "per_page": 50,
    "total_pages": 10,
    "total_count": 500,
    "next_cursor": "cursor_xyz",
    "prev_cursor": null
  }
}
```

#### 5.1.2 Core Endpoints

**Chart of Accounts**

```typescript
// List accounts
GET /v1/accounts
Query params:
  - entity_id: UUID
  - account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
  - is_active: boolean
  - parent_id: UUID (filter by parent)
  - search: string (search code and name)
  - page: number
  - per_page: number (max 100)

Response:
{
  "data": [
    {
      "id": "acc_123",
      "code": "1000",
      "name": "Assets",
      "account_type": "asset",
      "normal_balance": "debit",
      "is_active": true,
      "current_balance": 50000.00,
      "currency_code": "USD",
      "children_count": 5,
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}

// Get single account
GET /v1/accounts/{account_id}
Query params:
  - include_balance: boolean (calculate current balance)
  - include_hierarchy: boolean (include parent/children)

// Create account
POST /v1/accounts
Body:
{
  "code": "1110",
  "name": "Checking Account",
  "account_type": "asset",
  "fs_category": "current_assets",
  "parent_id": "acc_parent_123",
  "entity_id": "entity_123",
  "currency_code": "USD",
  "normal_balance": "debit",
  "allow_manual_entries": true,
  "description": "Main operating account"
}

// Update account
PATCH /v1/accounts/{account_id}
Body: (partial update)
{
  "name": "Updated Name",
  "is_active": false
}

// Delete account (soft delete only if no transactions)
DELETE /v1/accounts/{account_id}
```

**Journal Entries**

```typescript
// List journal entries
GET /v1/journal-entries
Query params:
  - entity_id: UUID
  - fiscal_period_id: UUID
  - status: 'draft' | 'posted' | 'void'
  - entry_type: string
  - start_date: YYYY-MM-DD
  - end_date: YYYY-MM-DD
  - source_type: 'invoice' | 'bill' | 'payment' | 'manual'
  - source_id: UUID
  - page: number
  - per_page: number

// Get single entry with lines
GET /v1/journal-entries/{entry_id}
Query params:
  - include_lines: boolean (default true)
  - include_source: boolean (include source transaction)

Response:
{
  "data": {
    "id": "je_123",
    "entry_number": "JE-2024-00001",
    "entry_type": "standard",
    "entry_date": "2024-01-15",
    "status": "posted",
    "total_debits": 1000.00,
    "total_credits": 1000.00,
    "description": "Monthly rent",
    "lines": [
      {
        "id": "jel_1",
        "line_number": 1,
        "account": {
          "id": "acc_123",
          "code": "6200",
          "name": "Rent Expense"
        },
        "debit_amount": 1000.00,
        "credit_amount": null,
        "description": "Office rent - January"
      },
      {
        "id": "jel_2",
        "line_number": 2,
        "account": {
          "id": "acc_456",
          "code": "1111",
          "name": "Checking Account"
        },
        "debit_amount": null,
        "credit_amount": 1000.00,
        "description": "Office rent - January"
      }
    ],
    "created_at": "2024-01-15T10:00:00Z",
    "posted_at": "2024-01-15T10:05:00Z"
  }
}

// Create journal entry
POST /v1/journal-entries
Body:
{
  "entity_id": "entity_123",
  "entry_date": "2024-01-15",
  "entry_type": "standard",
  "description": "Monthly rent payment",
  "lines": [
    {
      "line_number": 1,
      "account_id": "acc_rent_expense",
      "debit_amount": 1000.00,
      "description": "Office rent - January",
      "cost_center_id": "cc_admin"
    },
    {
      "line_number": 2,
      "account_id": "acc_checking",
      "credit_amount": 1000.00,
      "description": "Office rent - January"
    }
  ],
  "auto_post": false
}

// Post journal entry
POST /v1/journal-entries/{entry_id}/post
Body: {}

Response: { "data": { "status": "posted", "posted_at": "..." } }

// Void journal entry
POST /v1/journal-entries/{entry_id}/void
Body:
{
  "reason": "Duplicate entry",
  "create_reversal": true
}

// Reverse journal entry
POST /v1/journal-entries/{entry_id}/reverse
Body:
{
  "reversal_date": "2024-01-20",
  "description": "Reversal of JE-2024-00001"
}
```

**Invoices**

```typescript
// List invoices
GET /v1/invoices
Query params:
  - entity_id: UUID
  - customer_id: UUID
  - status: 'draft' | 'sent' | 'paid' | 'overdue'
  - start_date: YYYY-MM-DD
  - end_date: YYYY-MM-DD
  - due_date_from: YYYY-MM-DD
  - due_date_to: YYYY-MM-DD
  - search: string (search invoice number, customer name)
  - page, per_page

// Get invoice
GET /v1/invoices/{invoice_id}

// Create invoice
POST /v1/invoices
Body:
{
  "entity_id": "entity_123",
  "customer_id": "cust_456",
  "invoice_date": "2024-01-15",
  "due_date": "2024-02-14",
  "currency_code": "USD",
  "lines": [
    {
      "line_number": 1,
      "description": "Consulting services - January",
      "quantity": 40,
      "unit_price": 150.00,
      "revenue_account_id": "acc_revenue",
      "tax_code": "SALES_TAX",
      "project_id": "proj_abc"
    }
  ],
  "terms": "Net 30",
  "memo": "Thank you for your business"
}

Response:
{
  "data": {
    "id": "inv_789",
    "invoice_number": "INV-2024-00001",
    "status": "draft",
    "subtotal": 6000.00,
    "tax_amount": 480.00,
    "total_amount": 6480.00,
    "amount_due": 6480.00,
    "pdf_url": "https://s3.../invoice.pdf",
    ...
  }
}

// Send invoice (email to customer)
POST /v1/invoices/{invoice_id}/send
Body:
{
  "to": "customer@example.com",
  "cc": ["accounting@example.com"],
  "subject": "Invoice INV-2024-00001",
  "message": "Please find attached your invoice.",
  "send_pdf": true
}

// Record payment
POST /v1/invoices/{invoice_id}/payments
Body:
{
  "payment_date": "2024-01-20",
  "payment_amount": 6480.00,
  "payment_method": "ach",
  "reference_number": "TXN_12345",
  "bank_account_id": "bank_123"
}

// Void invoice
POST /v1/invoices/{invoice_id}/void

// CFDI Timbrado (Mexico)
POST /v1/invoices/{invoice_id}/cfdi/stamp
Body:
{
  "pac_provider": "finkok",
  "certificate_id": "cert_123"
}

Response:
{
  "data": {
    "cfdi_uuid": "12345678-1234-1234-1234-123456789012",
    "cfdi_status": "stamped",
    "cfdi_xml_url": "https://s3.../cfdi.xml",
    "stamped_at": "2024-01-15T10:30:00Z"
  }
}

// Cancel CFDI
POST /v1/invoices/{invoice_id}/cfdi/cancel
Body:
{
  "cancellation_reason": "02", // SAT cancellation code
  "replacement_uuid": null
}
```

**Bills (Accounts Payable)**

```typescript
// List bills
GET /v1/bills
Query params: (similar to invoices)
  - entity_id, vendor_id, status, dates, etc.

// Create bill
POST /v1/bills
Body:
{
  "entity_id": "entity_123",
  "vendor_id": "vendor_456",
  "vendor_invoice_number": "VENDOR-INV-001",
  "bill_date": "2024-01-15",
  "due_date": "2024-02-14",
  "currency_code": "USD",
  "lines": [
    {
      "line_number": 1,
      "description": "Office supplies",
      "account_id": "acc_office_expense",
      "quantity": 10,
      "unit_price": 25.00,
      "tax_amount": 20.00
    }
  ],
  "terms": "Net 30",
  "attachments": [
    {
      "filename": "invoice_scan.pdf",
      "url": "https://s3.../scan.pdf"
    }
  ]
}

// Approve bill
POST /v1/bills/{bill_id}/approve

// Schedule payment
POST /v1/bills/{bill_id}/schedule-payment
Body:
{
  "payment_date": "2024-02-10",
  "payment_method": "ach",
  "bank_account_id": "bank_123",
  "apply_early_payment_discount": true
}

// Make payment
POST /v1/payments/vendors
Body:
{
  "entity_id": "entity_123",
  "vendor_id": "vendor_456",
  "payment_date": "2024-01-20",
  "payment_amount": 270.00,
  "payment_method": "ach",
  "bank_account_id": "bank_123",
  "bill_applications": [
    {
      "bill_id": "bill_789",
      "amount_applied": 270.00,
      "discount_amount": 5.00
    }
  ]
}
```

**Bank Reconciliation**

```typescript
// Import bank transactions
POST /v1/bank-accounts/{account_id}/import
Body:
{
  "source": "csv" | "ofx" | "api",
  "file_url": "https://s3.../transactions.csv", // for csv/ofx
  "start_date": "2024-01-01",
  "end_date": "2024-01-31"
}

Response:
{
  "data": {
    "import_batch_id": "batch_123",
    "transactions_imported": 150,
    "duplicates_skipped": 5,
    "errors": []
  }
}

// List unmatched bank transactions
GET /v1/bank-accounts/{account_id}/transactions/unmatched
Query params:
  - start_date, end_date

// Get matching suggestions
GET /v1/bank-transactions/{transaction_id}/match-suggestions

Response:
{
  "data": {
    "suggestions": [
      {
        "match_type": "invoice",
        "match_id": "inv_123",
        "match_confidence": 0.95,
        "details": {
          "invoice_number": "INV-2024-00001",
          "customer_name": "Acme Corp",
          "amount": 1000.00,
          "date": "2024-01-15"
        }
      },
      {
        "match_type": "bill",
        "match_id": "bill_456",
        "match_confidence": 0.85,
        ...
      }
    ]
  }
}

// Create match
POST /v1/bank-transactions/{transaction_id}/match
Body:
{
  "match_type": "invoice" | "bill" | "journal_entry_line",
  "match_id": "inv_123",
  "match_amount": 1000.00 // for partial matches
}

// Create reconciliation session
POST /v1/bank-accounts/{account_id}/reconciliations
Body:
{
  "start_date": "2024-01-01",
  "end_date": "2024-01-31",
  "ending_balance_per_bank": 25000.00
}

// Get reconciliation status
GET /v1/reconciliations/{reconciliation_id}

Response:
{
  "data": {
    "id": "recon_123",
    "status": "in_progress",
    "beginning_balance": 20000.00,
    "ending_balance_per_bank": 25000.00,
    "ending_balance_per_books": 24950.00,
    "variance": 50.00,
    "outstanding_checks": 100.00,
    "deposits_in_transit": 50.00,
    "bank_charges": 0.00,
    "adjusted_bank_balance": 24950.00,
    "is_balanced": true,
    "matched_transactions": 145,
    "unmatched_transactions": 5
  }
}

// Complete reconciliation
POST /v1/reconciliations/{reconciliation_id}/complete
```

**Reports**

```typescript
// Generate trial balance
GET /v1/reports/trial-balance
Query params:
  - entity_id: UUID
  - fiscal_period_id: UUID
  - as_of_date: YYYY-MM-DD
  - account_level: number (1-5, depth of hierarchy)
  - format: 'json' | 'pdf' | 'csv' | 'xlsx'

Response (JSON):
{
  "data": {
    "entity": { ... },
    "period": { ... },
    "as_of_date": "2024-01-31",
    "accounts": [
      {
        "code": "1000",
        "name": "Assets",
        "account_type": "asset",
        "beginning_balance": 100000.00,
        "debit_total": 50000.00,
        "credit_total": 10000.00,
        "ending_balance": 140000.00
      },
      ...
    ],
    "totals": {
      "total_debits": 500000.00,
      "total_credits": 500000.00,
      "variance": 0.00
    }
  }
}

// Generate balance sheet
GET /v1/reports/balance-sheet
Query params:
  - entity_id, as_of_date, format
  - comparison_date: YYYY-MM-DD (for comparative BS)
  - consolidate: boolean (consolidate subsidiaries)

// Generate income statement (P&L)
GET /v1/reports/income-statement
Query params:
  - entity_id
  - start_date, end_date
  - format
  - comparison_period: 'prior_month' | 'prior_quarter' | 'prior_year'
  - consolidate: boolean

// Generate cash flow statement
GET /v1/reports/cash-flow
Query params:
  - entity_id
  - start_date, end_date
  - method: 'direct' | 'indirect'
  - format

// General ledger detail
GET /v1/reports/general-ledger
Query params:
  - entity_id
  - account_id: UUID (optional, specific account)
  - start_date, end_date
  - format

// Aged receivables
GET /v1/reports/aged-receivables
Query params:
  - entity_id
  - as_of_date
  - customer_id: UUID (optional)
  - format

Response:
{
  "data": {
    "as_of_date": "2024-01-31",
    "summary": {
      "current": 50000.00,
      "1_30_days": 10000.00,
      "31_60_days": 5000.00,
      "61_90_days": 2000.00,
      "over_90_days": 1000.00,
      "total": 68000.00
    },
    "by_customer": [
      {
        "customer_id": "cust_123",
        "customer_name": "Acme Corp",
        "current": 10000.00,
        "1_30_days": 5000.00,
        ...
        "total": 15000.00,
        "invoices": [
          {
            "invoice_number": "INV-001",
            "invoice_date": "2024-01-15",
            "due_date": "2024-02-14",
            "amount": 10000.00,
            "days_outstanding": 16
          }
        ]
      }
    ]
  }
}

// Aged payables (similar structure to receivables)
GET /v1/reports/aged-payables

// Custom report execution
POST /v1/reports/custom/{report_id}/execute
Body:
{
  "parameters": {
    "start_date": "2024-01-01",
    "end_date": "2024-01-31",
    "entity_id": "entity_123"
  },
  "format": "pdf"
}
```

#### 5.1.3 Error Handling

**Standard Error Format:**
```json
{
  "errors": [
    {
      "code": "VALIDATION_ERROR",
      "message": "Debits must equal credits",
      "field": "journal_entry.lines",
      "details": {
        "total_debits": 1000.00,
        "total_credits": 900.00,
        "difference": 100.00
      }
    }
  ],
  "meta": {
    "request_id": "req_abc123",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

**HTTP Status Codes:**
- `200 OK` - Success
- `201 Created` - Resource created
- `204 No Content` - Success with no response body
- `400 Bad Request` - Validation error
- `401 Unauthorized` - Invalid/missing authentication
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource conflict (e.g., duplicate entry number)
- `422 Unprocessable Entity` - Business logic error
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server error
- `503 Service Unavailable` - Service temporarily unavailable

**Error Codes:**
```typescript
enum ErrorCode {
  // Validation
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  INVALID_FORMAT = 'INVALID_FORMAT',
  
  // Accounting
  DEBITS_CREDITS_MISMATCH = 'DEBITS_CREDITS_MISMATCH',
  PERIOD_CLOSED = 'PERIOD_CLOSED',
  ACCOUNT_INACTIVE = 'ACCOUNT_INACTIVE',
  ACCOUNT_NOT_ALLOWED = 'ACCOUNT_NOT_ALLOWED',
  DUPLICATE_ENTRY_NUMBER = 'DUPLICATE_ENTRY_NUMBER',
  
  // Resources
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS = 'RESOURCE_ALREADY_EXISTS',
  RESOURCE_IN_USE = 'RESOURCE_IN_USE',
  
  // Authorization
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  
  // Business Logic
  INVOICE_ALREADY_PAID = 'INVOICE_ALREADY_PAID',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  CREDIT_LIMIT_EXCEEDED = 'CREDIT_LIMIT_EXCEEDED',
  
  // External Services
  BANK_API_ERROR = 'BANK_API_ERROR',
  PAC_TIMBRADO_ERROR = 'PAC_TIMBRADO_ERROR',
  
  // System
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE'
}
```

### 5.2 GraphQL Schema

```graphql
"""
Core GraphQL Schema for Accounting System
"""

# Scalars
scalar Date
scalar DateTime
scalar Decimal
scalar JSON

# Account Types
type Account {
  id: ID!
  code: String!
  name: String!
  accountType: AccountType!
  normalBalance: BalanceType!
  fsCategory: FinancialStatementCategory
  
  # Hierarchy
  parent: Account
  children: [Account!]!
  level: Int!
  fullCode: String!
  
  # Properties
  isActive: Boolean!
  isHeader: Boolean!
  allowManualEntries: Boolean!
  
  # Balance
  currentBalance: Decimal
  beginningBalance(periodId: ID!): Decimal
  
  # Related
  entity: Entity!
  journalEntryLines(
    startDate: Date
    endDate: Date
    limit: Int
    offset: Int
  ): JournalEntryLineConnection!
  
  # Metadata
  description: String
  tags: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

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

enum BalanceType {
  DEBIT
  CREDIT
}

enum FinancialStatementCategory {
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

# Journal Entry Types
type JournalEntry {
  id: ID!
  entryNumber: String!
  entryType: EntryType!
  entryDate: Date!
  postedDate: DateTime
  
  status: JournalEntryStatus!
  
  # Amounts
  totalDebits: Decimal!
  totalCredits: Decimal!
  
  # Relationships
  entity: Entity!
  fiscalPeriod: FiscalPeriod!
  lines: [JournalEntryLine!]!
  
  # Source
  sourceType: String
  source: Transaction # Union type
  
  # Metadata
  description: String
  notes: String
  attachments: [Attachment!]
  
  # Audit
  createdAt: DateTime!
  createdBy: User!
  postedBy: User
  approvedBy: User
}

type JournalEntryLine {
  id: ID!
  journalEntry: JournalEntry!
  lineNumber: Int!
  
  account: Account!
  debitAmount: Decimal
  creditAmount: Decimal
  
  # Dimensions
  costCenter: CostCenter
  department: Department
  project: Project
  
  # Multi-currency
  currencyCode: String
  foreignDebit: Decimal
  foreignCredit: Decimal
  exchangeRate: Decimal
  
  # Reconciliation
  isReconciled: Boolean!
  reconciledAt: DateTime
  
  description: String
  tags: JSON
}

enum JournalEntryStatus {
  DRAFT
  PENDING_APPROVAL
  APPROVED
  POSTED
  VOID
}

enum EntryType {
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

# Invoice Types
type Invoice {
  id: ID!
  invoiceNumber: String!
  
  # Parties
  entity: Entity!
  customer: Customer!
  
  # Amounts
  subtotal: Decimal!
  taxAmount: Decimal!
  totalAmount: Decimal!
  amountPaid: Decimal!
  amountDue: Decimal!
  currencyCode: String!
  
  # Dates
  invoiceDate: Date!
  dueDate: Date!
  deliveryDate: Date
  
  status: InvoiceStatus!
  
  # Lines
  lines: [InvoiceLine!]!
  
  # Payment history
  payments: [CustomerPayment!]!
  
  # CFDI (Mexico)
  cfdiUuid: String
  cfdiStatus: CfdiStatus
  cfdiXmlUrl: String
  
  # Related
  journalEntry: JournalEntry
  salesOrder: SalesOrder
  
  # Metadata
  description: String
  memo: String
  terms: String
  poNumber: String
  
  # Delivery
  sentAt: DateTime
  sentTo: String
  pdfUrl: String
  
  createdAt: DateTime!
  updatedAt: DateTime!
}

type InvoiceLine {
  id: ID!
  invoice: Invoice!
  lineNumber: Int!
  
  # Item
  item: Item
  description: String!
  quantity: Decimal!
  unitPrice: Decimal!
  
  # Account
  revenueAccount: Account!
  
  # Tax
  taxCode: String
  taxRate: Decimal
  taxAmount: Decimal!
  
  # Amounts
  lineAmount: Decimal!
  totalAmount: Decimal!
  
  # Dimensions
  costCenter: CostCenter
  project: Project
  
  # CFDI
  cfdiProductCode: String
  cfdiUnitCode: String
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

# Report Types
type TrialBalance {
  entity: Entity!
  fiscalPeriod: FiscalPeriod
  asOfDate: Date!
  
  accounts: [TrialBalanceAccount!]!
  
  totals: TrialBalanceTotals!
}

type TrialBalanceAccount {
  account: Account!
  beginningBalance: Decimal!
  debitTotal: Decimal!
  creditTotal: Decimal!
  endingBalance: Decimal!
}

type TrialBalanceTotals {
  totalDebits: Decimal!
  totalCredits: Decimal!
  variance: Decimal!
}

type BalanceSheet {
  entity: Entity!
  asOfDate: Date!
  
  assets: BalanceSheetSection!
  liabilities: BalanceSheetSection!
  equity: BalanceSheetSection!
  
  totalAssets: Decimal!
  totalLiabilities: Decimal!
  totalEquity: Decimal!
}

type BalanceSheetSection {
  name: String!
  subsections: [BalanceSheetSubsection!]!
  total: Decimal!
}

type BalanceSheetSubsection {
  name: String!
  accounts: [BalanceSheetAccount!]!
  subtotal: Decimal!
}

type BalanceSheetAccount {
  account: Account!
  balance: Decimal!
}

type IncomeStatement {
  entity: Entity!
  startDate: Date!
  endDate: Date!
  
  revenue: IncomeStatementSection!
  cogs: IncomeStatementSection!
  operatingExpenses: IncomeStatementSection!
  otherIncome: IncomeStatementSection!
  otherExpenses: IncomeStatementSection!
  
  grossProfit: Decimal!
  operatingIncome: Decimal!
  netIncome: Decimal!
}

# Queries
type Query {
  # Accounts
  account(id: ID!): Account
  accounts(
    entityId: ID!
    accountType: AccountType
    isActive: Boolean
    search: String
    limit: Int
    offset: Int
  ): AccountConnection!
  
  # Journal Entries
  journalEntry(id: ID!): JournalEntry
  journalEntries(
    entityId: ID!
    fiscalPeriodId: ID
    status: JournalEntryStatus
    startDate: Date
    endDate: Date
    limit: Int
    offset: Int
  ): JournalEntryConnection!
  
  # Invoices
  invoice(id: ID!): Invoice
  invoices(
    entityId: ID!
    customerId: ID
    status: InvoiceStatus
    startDate: Date
    endDate: Date
    limit: Int
    offset: Int
  ): InvoiceConnection!
  
  # Reports
  trialBalance(
    entityId: ID!
    fiscalPeriodId: ID
    asOfDate: Date
    accountLevel: Int
  ): TrialBalance!
  
  balanceSheet(
    entityId: ID!
    asOfDate: Date!
    consolidate: Boolean
  ): BalanceSheet!
  
  incomeStatement(
    entityId: ID!
    startDate: Date!
    endDate: Date!
    consolidate: Boolean
  ): IncomeStatement!
}

# Mutations
type Mutation {
  # Accounts
  createAccount(input: CreateAccountInput!): Account!
  updateAccount(id: ID!, input: UpdateAccountInput!): Account!
  deleteAccount(id: ID!): DeleteResult!
  
  # Journal Entries
  createJournalEntry(input: CreateJournalEntryInput!): JournalEntry!
  updateJournalEntry(id: ID!, input: UpdateJournalEntryInput!): JournalEntry!
  postJournalEntry(id: ID!): JournalEntry!
  voidJournalEntry(id: ID!, reason: String!): JournalEntry!
  reverseJournalEntry(id: ID!, reversalDate: Date!): JournalEntry!
  
  # Invoices
  createInvoice(input: CreateInvoiceInput!): Invoice!
  updateInvoice(id: ID!, input: UpdateInvoiceInput!): Invoice!
  sendInvoice(id: ID!, input: SendInvoiceInput!): Invoice!
  voidInvoice(id: ID!): Invoice!
  recordInvoicePayment(
    id: ID!
    input: RecordInvoicePaymentInput!
  ): CustomerPayment!
  
  # CFDI
  stampCfdi(invoiceId: ID!, pacProvider: String!): Invoice!
  cancelCfdi(
    invoiceId: ID!
    cancellationReason: String!
    replacementUuid: String
  ): Invoice!
  
  # Period Close
  softClosePeriod(periodId: ID!): FiscalPeriod!
  hardClosePeriod(periodId: ID!): FiscalPeriod!
}

# Subscriptions (real-time updates)
type Subscription {
  journalEntryPosted(entityId: ID!): JournalEntry!
  invoicePaid(entityId: ID!): Invoice!
  periodClosed(entityId: ID!): FiscalPeriod!
  bankTransactionImported(bankAccountId: ID!): BankTransaction!
}

# Connection types (for pagination)
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

# Input types
input CreateAccountInput {
  code: String!
  name: String!
  accountType: AccountType!
  parentId: ID
  entityId: ID!
  currencyCode: String
  normalBalance: BalanceType!
  allowManualEntries: Boolean
  description: String
}

input CreateJournalEntryInput {
  entityId: ID!
  entryDate: Date!
  entryType: EntryType!
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
  foreignAmount: Decimal
  exchangeRate: Decimal
}

input CreateInvoiceInput {
  entityId: ID!
  customerId: ID!
  invoiceDate: Date!
  dueDate: Date!
  currencyCode: String!
  lines: [InvoiceLineInput!]!
  terms: String
  memo: String
  poNumber: String
}

input InvoiceLineInput {
  lineNumber: Int!
  itemId: ID
  description: String!
  quantity: Decimal!
  unitPrice: Decimal!
  revenueAccountId: ID!
  taxCode: String
  projectId: ID
  cfdiProductCode: String
  cfdiUnitCode: String
}
```

### 5.3 Webhooks System

```typescript
/**
 * Webhook Event System
 */

// Event Types
enum WebhookEvent {
  // Journal Entries
  'journal_entry.created',
  'journal_entry.updated',
  'journal_entry.posted',
  'journal_entry.void',
  
  // Invoices
  'invoice.created',
  'invoice.updated',
  'invoice.sent',
  'invoice.paid',
  'invoice.partially_paid',
  'invoice.overdue',
  'invoice.void',
  
  // CFDI
  'cfdi.stamped',
  'cfdi.cancelled',
  
  // Bills
  'bill.created',
  'bill.approved',
  'bill.paid',
  
  // Payments
  'payment.received',
  'payment.made',
  
  // Bank
  'bank_transaction.imported',
  'bank_transaction.matched',
  'reconciliation.completed',
  
  // Period
  'period.soft_closed',
  'period.hard_closed',
  
  // Accounts
  'account.created',
  'account.updated'
}

// Webhook Subscription
interface WebhookSubscription {
  id: string;
  tenant_id: string;
  url: string; // Endpoint to call
  events: WebhookEvent[]; // Events to subscribe to
  secret: string; // For signature verification
  is_active: boolean;
  retry_config: {
    max_retries: number;
    retry_interval_seconds: number;
  };
  created_at: Date;
}

// Webhook Payload
interface WebhookPayload {
  id: string; // Unique delivery ID
  event: WebhookEvent;
  timestamp: string; // ISO 8601
  data: any; // Event-specific data
  tenant_id: string;
  entity_id?: string;
}

// Example Payload: invoice.paid
{
  "id": "whd_abc123",
  "event": "invoice.paid",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "invoice": {
      "id": "inv_789",
      "invoice_number": "INV-2024-00001",
      "customer_id": "cust_456",
      "total_amount": 1000.00,
      "amount_paid": 1000.00,
      "amount_due": 0.00,
      "status": "paid",
      "paid_at": "2024-01-15T10:30:00Z"
    },
    "payment": {
      "id": "pmt_111",
      "payment_number": "PMT-2024-00001",
      "payment_amount": 1000.00,
      "payment_method": "ach",
      "payment_date": "2024-01-15"
    }
  },
  "tenant_id": "tenant_123",
  "entity_id": "entity_456"
}

// Signature Verification (HMAC SHA256)
const signature = crypto
  .createHmac('sha256', subscription.secret)
  .update(JSON.stringify(payload))
  .digest('hex');

// Headers sent with webhook
{
  'X-Webhook-ID': 'whd_abc123',
  'X-Webhook-Event': 'invoice.paid',
  'X-Webhook-Signature': 'sha256=...',
  'X-Webhook-Timestamp': '2024-01-15T10:30:00Z',
  'Content-Type': 'application/json'
}

// Delivery Status
interface WebhookDelivery {
  id: string;
  subscription_id: string;
  event: WebhookEvent;
  payload: WebhookPayload;
  url: string;
  
  // Delivery
  status: 'pending' | 'success' | 'failed';
  http_status_code?: number;
  response_body?: string;
  error_message?: string;
  
  // Retry
  attempt_count: number;
  next_retry_at?: Date;
  
  // Timing
  created_at: Date;
  delivered_at?: Date;
}

// API Endpoints for Webhooks
POST /v1/webhooks
Body:
{
  "url": "https://example.com/webhooks/accounting",
  "events": ["invoice.paid", "invoice.overdue"],
  "secret": "whsec_abc123..." // Client generates
}

GET /v1/webhooks
Response: { "data": [{ ... subscription ... }] }

GET /v1/webhooks/{webhook_id}
DELETE /v1/webhooks/{webhook_id}

// Test webhook
POST /v1/webhooks/{webhook_id}/test
Body:
{
  "event": "invoice.paid"
}
// Sends test payload to webhook URL

// Delivery logs
GET /v1/webhooks/{webhook_id}/deliveries
Query params:
  - status: 'success' | 'failed'
  - start_date, end_date
  - limit, offset

// Retry failed delivery
POST /v1/webhook-deliveries/{delivery_id}/retry
```

---

## 6. Functional Modules (Continued)

### 6.1 Bank Reconciliation Engine

```typescript
/**
 * Automatic Matching Algorithm
 */

interface MatchRule {
  priority: number;
  name: string;
  match: (bankTxn: BankTransaction, candidates: Matchable[]) => MatchResult | null;
}

interface Matchable {
  id: string;
  type: 'invoice' | 'bill' | 'payment' | 'journal_entry_line';
  amount: number;
  date: Date;
  description: string;
  customer_name?: string;
  vendor_name?: string;
}

interface MatchResult {
  bank_transaction_id: string;
  matches: {
    match_id: string;
    match_type: string;
    confidence: number; // 0.0 - 1.0
    matched_amount: number;
  }[];
}

// Rule 1: Exact amount + date match (highest priority)
const exactMatchRule: MatchRule = {
  priority: 1,
  name: 'exact_amount_date',
  match: (bankTxn, candidates) => {
    const exact = candidates.find(c => 
      Math.abs(c.amount - Math.abs(bankTxn.amount)) < 0.01 &&
      isSameDay(c.date, bankTxn.transaction_date)
    );
    
    if (exact) {
      return {
        bank_transaction_id: bankTxn.id,
        matches: [{
          match_id: exact.id,
          match_type: exact.type,
          confidence: 1.0,
          matched_amount: Math.abs(bankTxn.amount)
        }]
      };
    }
    
    return null;
  }
};

// Rule 2: Exact amount + date within ±3 days
const nearDateMatchRule: MatchRule = {
  priority: 2,
  name: 'exact_amount_near_date',
  match: (bankTxn, candidates) => {
    const matches = candidates.filter(c =>
      Math.abs(c.amount - Math.abs(bankTxn.amount)) < 0.01 &&
      Math.abs(daysBetween(c.date, bankTxn.transaction_date)) <= 3
    );
    
    if (matches.length === 1) {
      return {
        bank_transaction_id: bankTxn.id,
        matches: [{
          match_id: matches[0].id,
          match_type: matches[0].type,
          confidence: 0.90,
          matched_amount: Math.abs(bankTxn.amount)
        }]
      };
    }
    
    return null; // Ambiguous if multiple matches
  }
};

// Rule 3: Fuzzy description matching
const descriptionMatchRule: MatchRule = {
  priority: 3,
  name: 'fuzzy_description',
  match: (bankTxn, candidates) => {
    const scored = candidates
      .map(c => ({
        candidate: c,
        score: calculateDescriptionSimilarity(
          bankTxn.description,
          c.description
        )
      }))
      .filter(s => s.score > 0.7); // Threshold
    
    if (scored.length === 1 && scored[0].score > 0.85) {
      return {
        bank_transaction_id: bankTxn.id,
        matches: [{
          match_id: scored[0].candidate.id,
          match_type: scored[0].candidate.type,
          confidence: scored[0].score,
          matched_amount: Math.abs(bankTxn.amount)
        }]
      };
    }
    
    return null;
  }
};

function calculateDescriptionSimilarity(desc1: string, desc2: string): number {
  // Levenshtein distance + keyword matching
  const normalized1 = desc1.toLowerCase().trim();
  const normalized2 = desc2.toLowerCase().trim();
  
  // Extract keywords (remove common words)
  const keywords1 = extractKeywords(normalized1);
  const keywords2 = extractKeywords(normalized2);
  
  // Calculate overlap
  const intersection = keywords1.filter(k => keywords2.includes(k));
  const union = [...new Set([...keywords1, ...keywords2])];
  
  // Jaccard similarity
  return intersection.length / union.length;
}

// Rule 4: ML-based matching (trained model)
const mlMatchRule: MatchRule = {
  priority: 4,
  name: 'ml_prediction',
  match: async (bankTxn, candidates) => {
    // Feature engineering
    const features = candidates.map(c => ({
      amount_diff: Math.abs(c.amount - Math.abs(bankTxn.amount)),
      date_diff: Math.abs(daysBetween(c.date, bankTxn.transaction_date)),
      description_similarity: calculateDescriptionSimilarity(
        bankTxn.description,
        c.description
      ),
      transaction_type: c.type,
      // ... more features
    }));
    
    // Call ML model
    const predictions = await mlModel.predict(features);
    
    // Get highest confidence prediction
    const bestMatch = predictions
      .map((prob, idx) => ({ candidate: candidates[idx], probability: prob }))
      .sort((a, b) => b.probability - a.probability)[0];
    
    if (bestMatch && bestMatch.probability > 0.75) {
      return {
        bank_transaction_id: bankTxn.id,
        matches: [{
          match_id: bestMatch.candidate.id,
          match_type: bestMatch.candidate.type,
          confidence: bestMatch.probability,
          matched_amount: Math.abs(bankTxn.amount)
        }]
      };
    }
    
    return null;
  }
};

// Master matching engine
async function matchBankTransaction(
  bankTxn: BankTransaction
): Promise<MatchResult | null> {
  // Get candidates (unmatched invoices, bills, journal entries)
  const candidates = await getCandidates(
    bankTxn.bank_account_id,
    bankTxn.amount,
    bankTxn.transaction_date
  );
  
  // Apply rules in priority order
  const rules = [
    exactMatchRule,
    nearDateMatchRule,
    descriptionMatchRule,
    mlMatchRule
  ].sort((a, b) => a.priority - b.priority);
  
  for (const rule of rules) {
    const result = await rule.match(bankTxn, candidates);
    if (result) {
      // Found a match
      await saveMatch(result);
      await markBankTransactionMatched(bankTxn.id);
      return result;
    }
  }
  
  return null; // No match found
}
```

This continues the comprehensive technical specification. Would you like me to continue with more sections (Depreciation algorithms, Inventory costing, Security implementation, etc.)?

