# Accounting Core

A production-grade, multi-country accounting engine built with Node.js, TypeScript, PostgreSQL, and Redis. Supports US GAAP, Mexican NIF, and IFRS standards with full double-entry bookkeeping, AP/AR automation, bank reconciliation, fixed asset management, inventory costing, and **triple-entry accounting** via blockchain attestation (zkVerify + Bitcoin anchoring).

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Project Structure](#project-structure)
4. [Database](#database)
5. [Authentication & Security](#authentication--security)
6. [REST API Reference](#rest-api-reference)
7. [GraphQL API](#graphql-api)
8. [Accounting Engine](#accounting-engine)
9. [Accounts Payable (AP)](#accounts-payable-ap)
10. [Accounts Receivable (AR)](#accounts-receivable-ar)
11. [Bank Reconciliation](#bank-reconciliation)
12. [Fixed Assets & Depreciation](#fixed-assets--depreciation)
13. [Inventory Costing](#inventory-costing)
14. [Mexico Compliance (CFDI/SAT)](#mexico-compliance-cfdisat)
15. [Webhooks](#webhooks)
16. [Caching](#caching)
17. [Rate Limiting](#rate-limiting)
18. [Reporting](#reporting)
19. [Triple-Entry Accounting (Blockchain)](#triple-entry-accounting-blockchain)
20. [Configuration](#configuration)
21. [Docker Deployment](#docker-deployment)
22. [Development Guide](#development-guide)

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+ (optional, enables caching and rate limiting)

### Installation

```bash
git clone <repo-url>
cd Accounting
npm install
```

### Configure Environment

```bash
cp .env.example .env
# Edit .env with your database credentials
# Key: DATABASE_URL=postgresql://youruser@localhost:5432/accounting_core
```

### Create Database

```bash
createdb accounting_core
```

### Run Migrations

```bash
npm run migrate
```

This executes 4 SQL migration files that create 35+ tables, triggers, materialized views, and indexes.

### Seed Demo Data

```bash
npm run seed
```

Creates a complete demo environment: tenant, organization, legal entity (Mexican SAPI company), 38-account chart of accounts, 12 fiscal periods, sample customer, vendor, bank account, and exchange rates.

### Start Development Server

```bash
npm run dev
```

The server starts at:
- **REST API**: http://localhost:3000/v1
- **GraphQL**: http://localhost:3000/graphql
- **Health Check**: http://localhost:3000/health

---

## Architecture Overview

```
Client Applications (Web, Mobile, API Clients)
        |
  API Gateway Layer
  ├── Authentication (JWT)
  ├── Rate Limiting (Redis)
  ├── Audit Logging
  └── Request Routing
        |
  Application Services
  ├── Accounting Engine (validation, posting, period close)
  ├── AP Service (vendors, bills, payments)
  ├── AR Service (customers, invoices, payments)
  ├── Banking Service (reconciliation, ML matching)
  ├── Asset Service (depreciation, disposal)
  ├── Inventory Service (FIFO, LIFO, weighted avg)
  ├── Reporting Service (trial balance, financials)
  ├── Webhook Service (event dispatch, retry)
  ├── CFDI Service (Mexico electronic invoicing)
  ├── XML Ingestion Service (CFDI parsing, rules engine, pre-registrations)
  ├── Integration Layer (multi-PAC failover, Stripe, Conekta, SendGrid, S3)
  ├── Cache Service (Redis layers)
  └── Blockchain Service (triple-entry attestation, ZK proofs, Bitcoin anchoring)
        |
  Data Layer
  ├── PostgreSQL 15 (OLTP, multi-tenant schemas)
  ├── Redis 7 (caching, rate limiting)
  ├── Elasticsearch 8 (full-text search, optional)
  └── Bitcoin / EVM / Solana (blockchain attestation, optional)
```

### Multi-Tenancy

The system uses **schema-per-tenant** isolation in PostgreSQL. Each tenant gets its own schema while authentication data lives in the shared `public` schema.

```
public schema  → tenants, users, sessions
tenant_abc     → accounts, journal_entries, invoices, ...
tenant_xyz     → accounts, journal_entries, invoices, ...
```

### Entity Hierarchy

```
Tenant (company)
  └── Organization (holding/operating)
        └── Legal Entity (corporation, LLC, SAPI, SA)
              ├── Chart of Accounts
              ├── Fiscal Periods
              ├── Journal Entries
              └── Transactions
```

Each legal entity has its own functional currency, accounting standard (US GAAP / Mexican NIF / IFRS), and fiscal year configuration.

---

## Project Structure

```
src/
├── index.ts                          # Express + Apollo server bootstrap
├── config/
│   └── index.ts                      # Centralized configuration
├── types/
│   └── index.ts                      # All TypeScript interfaces & enums (40+ types)
├── database/
│   ├── connection.ts                 # PostgreSQL pool, transactions, schema switching
│   ├── migrate.ts                    # Migration runner
│   ├── seed.ts                       # Demo data seeder
│   └── migrations/
│       ├── 001_core_schema.sql       # Tenants, accounts, journal entries, fiscal periods
│       ├── 002_ap_ar_schema.sql      # Vendors, bills, customers, invoices, payments
│       ├── 003_banking_assets_inventory.sql  # Banking, fixed assets, inventory, webhooks
│       └── 004_partitioning_and_views.sql    # Performance indexes, materialized views
├── api/
│   ├── rest/
│   │   ├── middleware/
│   │   │   ├── auth.ts               # JWT auth, RBAC, SoD enforcement
│   │   │   ├── audit.ts              # Mutation audit logging
│   │   │   ├── error-handler.ts      # Standardized error responses
│   │   │   └── rate-limiter.ts       # Redis-backed rate limiting
│   │   └── routes/
│   │       ├── accounts.ts           # Chart of accounts CRUD
│   │       ├── journal-entries.ts    # Journal entry lifecycle
│   │       ├── invoices.ts           # AR invoicing + CFDI
│   │       ├── bills.ts              # AP bill management
│   │       ├── customers.ts          # Customer master data
│   │       ├── vendors.ts            # Vendor master data
│   │       ├── reports.ts            # Financial reports
│   │       ├── bank-reconciliation.ts # Bank import & matching
│   │       ├── fiscal-periods.ts     # Period close management
│   │       ├── xml-ingestion.ts      # CFDI/XML upload, pre-registrations, processing batches
│   │       ├── blockchain.ts         # Blockchain config, attestations, disclosure config
│   │       ├── public-verification.ts # Public proof verification (no auth required)
│   │       └── webhooks.ts           # Webhook subscriptions
│   └── graphql/
│       ├── schemas/
│       │   └── schema.ts             # Full GraphQL type definitions
│       └── resolvers/
│           └── index.ts              # Query, Mutation, field resolvers
├── services/
│   ├── accounting/
│   │   ├── index.ts                  # Barrel exports
│   │   ├── validation.ts             # 6 journal entry validation rules
│   │   ├── posting.ts                # 5 auto-posting rules + posting engine
│   │   └── period-close.ts           # Soft/hard close + year-end closing entries
│   ├── banking/
│   │   └── matching.ts               # 4-tier ML matching algorithm
│   ├── assets/
│   │   └── depreciation.ts           # 6 depreciation methods + monthly runner
│   ├── inventory/
│   │   └── costing.ts                # FIFO, LIFO, weighted avg, specific ID
│   ├── mexico/
│   │   └── cfdi.ts                   # CFDI XML, SAT catalogs, PAC integration, DIOT
│   ├── xml-ingestion/
│   │   ├── cfdi-parser.ts            # CFDI 4.0 XML parsing & validation (fast-xml-parser)
│   │   ├── sat-validation.ts         # SAT structural & catalog validation rules
│   │   ├── rules-engine.ts           # Conditional rules engine (15 operators, account routing)
│   │   └── pre-registration-service.ts # Pre-processing pipeline with account suggestions
│   ├── integrations/
│   │   ├── base/
│   │   │   ├── adapter.interface.ts  # Base interfaces for all adapters
│   │   │   ├── circuit-breaker.ts    # Circuit breaker for failover resilience
│   │   │   ├── retry.ts              # Configurable retry with backoff
│   │   │   └── registry.ts           # Adapter registry
│   │   ├── mexico/pac/
│   │   │   ├── pac-router.ts         # Multi-PAC router with auto-failover
│   │   │   ├── finkok-adapter.ts     # Finkok PAC adapter
│   │   │   ├── sw-sapien-adapter.ts  # SW Sapien PAC adapter
│   │   │   └── edicom-adapter.ts     # Edicom PAC adapter
│   │   ├── payments/
│   │   │   ├── stripe-adapter.ts     # Stripe payment processing
│   │   │   └── conekta-adapter.ts    # Conekta payment processing (Mexico)
│   │   ├── email/
│   │   │   └── sendgrid-adapter.ts   # SendGrid transactional email
│   │   └── storage/
│   │       └── s3-adapter.ts         # AWS S3 document storage
│   ├── blockchain/
│   │   ├── crypto-service.ts         # SHA-256 hashing, Pedersen commitments, Merkle trees, range proofs
│   │   ├── zkverify-client.ts        # zkVerify integration (UltraPLONK proof submission)
│   │   ├── chain-adapters.ts         # EVM + Solana chain adapters (Arbitrum, Base, Polygon zkEVM)
│   │   ├── bitcoin-anchor.ts         # Bitcoin OP_RETURN anchoring (TRPA protocol)
│   │   └── orchestrator.ts           # Coordinates full triple-entry attestation flow
│   ├── cache/
│   │   └── redis.ts                  # 3-layer cache + rate limiting
│   └── webhooks/
│       └── webhook-service.ts        # Event dispatch, HMAC signing, retry
└── utils/
    ├── errors.ts                     # Error classes (Validation, NotFound, Accounting, etc.)
    ├── encryption.ts                 # AES-256-GCM encrypt/decrypt + HMAC
    └── sequence.ts                   # Auto-numbering (JE-2026-00001, INV-2026-00001)
```

---

## Database

### Migrations

The system uses 4 sequential SQL migrations:

| Migration | Tables | Purpose |
|-----------|--------|---------|
| `001_core_schema.sql` | 13 tables | Multi-tenancy, chart of accounts, journal entries, fiscal periods, exchange rates, audit log |
| `002_ap_ar_schema.sql` | 10 tables | Vendors, bills, customers, invoices, payments, allocations |
| `003_banking_assets_inventory.sql` | 11 tables | Bank accounts, transactions, reconciliation, fixed assets, depreciation, inventory layers, webhooks |
| `004_partitioning_and_views.sql` | 2 tables + views | Composite indexes, materialized views, scheduled payments, custom reports |
| `005_xml_ingestion.sql` | 5 tables | CFDI XML ingestion batches, parsed documents, pre-registrations, processing rules, validation errors |
| `006_blockchain_integration.sql` | 7 tables | Blockchain config, attestations, period commitments, Bitcoin anchors, ZK proofs, published aggregates, disclosure config |
| `007_integrations.sql` | — | PAC preferences, payment provider config, integration audit log, S3 document references |

### Key Database Features

- **Triggers**: Auto-compute account hierarchy paths (`full_code`), auto-update journal entry totals on line changes, auto-refresh materialized views on posting
- **Functions**: `get_exchange_rate()` with fallback to inverse rates and cross-rates via USD
- **Materialized Views**: `mv_trial_balance` and `mv_account_balance_summary` for fast reporting
- **Constraints**: Double-entry balance enforcement (`debits = credits` on posted entries), XOR on debit/credit amounts per line

### Running Migrations

```bash
npm run migrate    # Runs all pending migrations
npm run seed       # Seeds demo data
```

### Transactions

All multi-step operations use database transactions:

```typescript
import { withTransaction } from './database/connection.js';

const result = await withTransaction(async (client) => {
  await client.query('INSERT INTO ...');
  await client.query('UPDATE ...');
  return result;
});
// Auto COMMIT on success, ROLLBACK on error
```

---

## Authentication & Security

### JWT Authentication

All API requests (except `/health`) require a Bearer token:

```
Authorization: Bearer <jwt_token>
```

The JWT payload contains:

```json
{
  "user_id": "uuid",
  "tenant_id": "uuid",
  "email": "admin@company.com",
  "roles": ["owner"],
  "permissions": ["*"],
  "entities": ["entity-uuid"],
  "session_id": "uuid"
}
```

### Role-Based Access Control (RBAC)

Six predefined roles with granular permissions:

| Role | Access Level |
|------|-------------|
| **Owner** | Full access (`*` wildcard) |
| **Admin** | All operations except billing |
| **Controller** | Accounts, journal entries, period close, reports |
| **Accountant** | Read accounts, create entries/invoices/bills, read reports |
| **Viewer** | Read-only access to all modules |
| **Auditor** | Read-only + audit log access + export |

Permissions follow the format `resource:action`:
- `accounts:read`, `accounts:create`, `accounts:update`, `accounts:delete`
- `journal_entries:read`, `journal_entries:create`, `journal_entries:post`, `journal_entries:void`
- `invoices:read`, `invoices:create`, `invoices:send`, `invoices:void`
- `bills:read`, `bills:create`, `bills:approve`, `bills:void`
- `periods:close`, `periods:reopen`
- `reports:read`, `reports:export`

### Segregation of Duties (SoD)

Three enforced SoD rules prevent conflicts of interest:

| Rule | Conflicting Permissions | Severity |
|------|------------------------|----------|
| Vendor setup vs payment approval | `vendors:create` vs `bills:approve` | High |
| Entry creation vs posting | `journal_entries:create` vs `journal_entries:post` | Medium |
| Period close vs reopen | `periods:close` vs `periods:reopen` | Low |

### Encryption at Rest

Sensitive fields are encrypted using AES-256-GCM:
- Vendor bank account numbers
- Vendor routing numbers
- Mexican CLABE numbers

```typescript
import { encrypt, decrypt } from './utils/encryption.js';

const encrypted = encrypt('1234567890');  // "iv:authTag:ciphertext"
const original = decrypt(encrypted);       // "1234567890"
```

### Audit Logging

Every mutation (POST, PUT, PATCH, DELETE) is automatically logged to the `audit_log` table:
- User ID, tenant ID, action type
- Entity type and ID
- Request body (new values)
- IP address, user agent, request ID

---

## REST API Reference

### Base URL

```
https://your-domain.com/v1/{resource}
```

### Standard Response Format

```json
{
  "data": { ... },
  "meta": {
    "request_id": "uuid",
    "timestamp": "2026-04-14T00:00:00Z",
    "version": "v1"
  },
  "pagination": {
    "page": 1,
    "per_page": 50,
    "total_pages": 10,
    "total_count": 500
  }
}
```

### Error Response Format

```json
{
  "errors": [{
    "code": "VALIDATION_ERROR",
    "message": "Debits must equal credits",
    "field": "journal_entry.lines",
    "details": { "total_debits": 1000, "total_credits": 900 }
  }],
  "meta": { "request_id": "uuid", "timestamp": "...", "version": "v1" }
}
```

### Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| **Chart of Accounts** | | |
| GET | `/v1/accounts` | List accounts (filter by type, status, parent) |
| GET | `/v1/accounts/:id` | Get account with optional balance and hierarchy |
| POST | `/v1/accounts` | Create account |
| PATCH | `/v1/accounts/:id` | Update account |
| DELETE | `/v1/accounts/:id` | Soft delete (only if no transactions) |
| **Journal Entries** | | |
| GET | `/v1/journal-entries` | List entries (filter by period, status, type, dates) |
| GET | `/v1/journal-entries/:id` | Get entry with line items |
| POST | `/v1/journal-entries` | Create entry (minimum 2 lines) |
| POST | `/v1/journal-entries/:id/post` | Post entry to general ledger |
| POST | `/v1/journal-entries/:id/void` | Void entry (requires reason) |
| POST | `/v1/journal-entries/:id/reverse` | Create reversing entry |
| **Invoices (AR)** | | |
| GET | `/v1/invoices` | List invoices |
| GET | `/v1/invoices/:id` | Get invoice with lines |
| POST | `/v1/invoices` | Create invoice |
| POST | `/v1/invoices/:id/send` | Mark as sent |
| POST | `/v1/invoices/:id/payments` | Record payment |
| POST | `/v1/invoices/:id/void` | Void invoice |
| POST | `/v1/invoices/:id/cfdi/stamp` | Stamp CFDI (Mexico) |
| POST | `/v1/invoices/:id/cfdi/cancel` | Cancel CFDI (Mexico) |
| **Bills (AP)** | | |
| GET | `/v1/bills` | List bills |
| GET | `/v1/bills/:id` | Get bill with lines |
| POST | `/v1/bills` | Create bill |
| POST | `/v1/bills/:id/approve` | Approve bill |
| POST | `/v1/bills/:id/schedule-payment` | Schedule payment with discount |
| POST | `/v1/bills/payments` | Record vendor payment |
| **Customers** | | |
| GET | `/v1/customers` | List customers |
| GET | `/v1/customers/:id` | Get customer |
| POST | `/v1/customers` | Create customer |
| PATCH | `/v1/customers/:id` | Update customer |
| **Vendors** | | |
| GET | `/v1/vendors` | List vendors |
| GET | `/v1/vendors/:id` | Get vendor |
| POST | `/v1/vendors` | Create vendor (bank details encrypted) |
| PATCH | `/v1/vendors/:id` | Update vendor |
| **Bank Reconciliation** | | |
| POST | `/v1/bank-accounts/:id/import` | Import bank transactions |
| GET | `/v1/bank-accounts/:id/transactions/unmatched` | List unmatched transactions |
| GET | `/v1/bank-accounts/transactions/:id/suggestions` | Get ML match suggestions |
| POST | `/v1/bank-accounts/transactions/:id/match` | Manual match |
| POST | `/v1/bank-accounts/:id/auto-match` | Run ML auto-matching |
| POST | `/v1/bank-accounts/:id/reconciliations` | Start reconciliation session |
| GET | `/v1/bank-accounts/reconciliations/:id` | Get reconciliation status |
| POST | `/v1/bank-accounts/reconciliations/:id/complete` | Complete reconciliation |
| **Reports** | | |
| GET | `/v1/reports/trial-balance` | Trial balance |
| GET | `/v1/reports/balance-sheet` | Balance sheet |
| GET | `/v1/reports/income-statement` | Income statement (P&L) |
| GET | `/v1/reports/cash-flow` | Cash flow statement |
| GET | `/v1/reports/general-ledger` | General ledger detail |
| GET | `/v1/reports/aged-receivables` | AR aging |
| GET | `/v1/reports/aged-payables` | AP aging |
| **Fiscal Periods** | | |
| GET | `/v1/fiscal-periods` | List periods |
| GET | `/v1/fiscal-periods/:id/close-status` | Period close checklist |
| POST | `/v1/fiscal-periods/:id/soft-close` | Soft close period |
| POST | `/v1/fiscal-periods/:id/hard-close` | Hard close period |
| **XML Ingestion (CFDI)** | | |
| POST | `/v1/xml/upload` | Upload CFDI XML file(s) for processing |
| GET | `/v1/xml/pre-registrations` | List pre-registered XML documents |
| GET | `/v1/xml/pre-registrations/stats` | Aggregated ingestion statistics |
| GET | `/v1/xml/pre-registrations/:id` | Get pre-registration detail |
| PATCH | `/v1/xml/pre-registrations/:id` | Update pre-registration (account assignment) |
| POST | `/v1/xml/pre-registrations/:id/process` | Convert pre-registration into bill/journal entry |
| POST | `/v1/xml/pre-registrations/:id/approve` | Approve for auto-processing |
| POST | `/v1/xml/pre-registrations/:id/reject` | Reject document |
| POST | `/v1/xml/pre-registrations/bulk` | Bulk process multiple documents |
| GET | `/v1/xml/processing-rules` | List automation rules |
| POST | `/v1/xml/processing-rules` | Create automation rule |
| PUT | `/v1/xml/processing-rules/:id` | Update rule |
| DELETE | `/v1/xml/processing-rules/:id` | Delete rule |
| GET | `/v1/xml/processing-batches` | List processing batches |
| POST | `/v1/xml/processing-batches` | Create batch |
| POST | `/v1/xml/processing-batches/:id/execute` | Execute batch |
| GET | `/v1/xml/xml-documents` | List parsed XML documents |
| **Blockchain (Admin)** | | |
| GET | `/v1/admin/blockchain/config` | Get blockchain config |
| PUT | `/v1/admin/blockchain/config` | Update blockchain config |
| POST | `/v1/admin/blockchain/config/validate` | Validate chain connectivity |
| GET | `/v1/admin/blockchain/chains` | List supported chains |
| GET | `/v1/admin/disclosure-config` | Get aggregate disclosure settings |
| PUT | `/v1/admin/disclosure-config` | Update disclosure settings |
| **Public Verification (no auth)** | | |
| GET | `/public/v1/verify/:entryHash` | Verify journal entry blockchain attestation |
| **Webhooks** | | |
| POST | `/v1/webhooks` | Create subscription |
| GET | `/v1/webhooks` | List subscriptions |
| DELETE | `/v1/webhooks/:id` | Delete subscription |
| POST | `/v1/webhooks/:id/test` | Send test event |
| GET | `/v1/webhooks/:id/deliveries` | Delivery history |

---

## GraphQL API

Available at `POST /graphql` with the same JWT authentication.

### Queries

```graphql
query {
  # Single account
  account(id: "uuid") { id code name accountType currentBalance }

  # Account list with pagination
  accounts(entityId: "uuid", accountType: ASSET, isActive: true, first: 20) {
    edges { node { id code name } }
    totalCount
  }

  # Journal entries
  journalEntries(entityId: "uuid", status: POSTED, startDate: "2026-01-01") {
    id entryNumber totalDebits totalCredits
    lines { account { code name } debitAmount creditAmount }
  }

  # Invoices
  invoices(entityId: "uuid", status: PAID) {
    id invoiceNumber totalAmount customer { companyName }
  }

  # Reports
  trialBalance(entityId: "uuid") {
    accounts { accountCode accountName debitTotal creditTotal }
    totals { totalDebits totalCredits isBalanced }
  }

  balanceSheet(entityId: "uuid", asOfDate: "2026-12-31") {
    assets { total subsections { name total } }
    liabilities { total }
    equity { total }
  }
}
```

### Mutations

```graphql
mutation {
  createJournalEntry(input: {
    entityId: "uuid"
    entryDate: "2026-04-14"
    description: "Monthly rent"
    lines: [
      { lineNumber: 1, accountId: "expense-uuid", debitAmount: "15000.00" }
      { lineNumber: 2, accountId: "bank-uuid", creditAmount: "15000.00" }
    ]
    autoPost: true
  }) {
    id entryNumber status
  }

  postJournalEntry(id: "uuid") { id status postedDate }
  voidJournalEntry(id: "uuid", reason: "Duplicate entry") { id status }

  softClosePeriod(periodId: "uuid", entityId: "uuid") { id status }
  hardClosePeriod(periodId: "uuid", entityId: "uuid") { id status }
}
```

### Type System

The GraphQL schema includes 15+ types, 12 enums, and 5 input types covering accounts, journal entries, invoices, bills, customers, vendors, fiscal periods, and reports.

---

## Accounting Engine

### Double-Entry Validation

Every journal entry is validated against 6 rules before posting:

| Rule | What It Checks | Blocking? |
|------|---------------|-----------|
| **Balance** | Total debits = total credits (within 0.01 tolerance) | Yes |
| **Line Amount** | Each line has exactly one of debit or credit, both > 0 | Yes |
| **Account Type** | Warns if posting against normal balance direction | Warning |
| **Period Status** | Cannot post to hard-closed or locked periods | Yes |
| **Account Permission** | Account must be active, not a header, allow manual entries | Yes |
| **Currency** | Foreign currency lines require exchange rate and foreign amount | Yes |

### Automatic Posting Rules

When transactions are created, journal entries are auto-generated:

| Transaction | Debit | Credit |
|-------------|-------|--------|
| **Invoice** | Accounts Receivable | Revenue + Tax Payable |
| **Bill** | Expense + Tax Receivable (IVA) | Accounts Payable |
| **Customer Payment** | Cash/Bank | Accounts Receivable |
| **Vendor Payment** | Accounts Payable | Cash/Bank + Purchase Discount |
| **Depreciation** | Depreciation Expense | Accumulated Depreciation |

### Period Close Process

**Soft Close** checks a checklist before allowing closure:
- All journal entries posted
- Bank reconciliations complete
- All invoices reviewed
- Depreciation calculated and posted
- Trial balance balanced

**Hard Close** (requires prior soft close):
1. Generates closing entries for year-end periods
2. Closes revenue accounts to Income Summary
3. Closes expense accounts to Income Summary
4. Closes Income Summary to Retained Earnings
5. Locks all entries in the period

---

## Accounts Payable (AP)

### Vendor Management
- Create vendors with tax ID (RFC for Mexico, EIN for USA)
- Bank details encrypted at rest (AES-256-GCM)
- 1099 vendor flagging for US tax reporting
- Default expense account assignment

### Bill Lifecycle
```
Draft → Pending Approval → Approved → Posted → Paid
                                              → Partially Paid
```

### Payment Features
- Multi-bill payment application
- Early payment discount calculation (parses terms like "2/10 Net 30")
- Payment scheduling
- Payment methods: cash, check, ACH, wire, SPEI (Mexico)

---

## Accounts Receivable (AR)

### Customer Management
- Company and individual customer types
- Credit limit and credit status (approved, on hold, suspended)
- Tax ID support (RFC, EIN, VAT)
- Default revenue and AR account assignment

### Invoice Lifecycle
```
Draft → Pending → Sent → Viewed → Paid
                               → Partially Paid
                               → Overdue
                               → Uncollectible
```

### CFDI Integration (Mexico)
- CFDI 4.0 XML generation
- PAC provider integration (Finkok, sandbox mode)
- SAT cancellation with reason codes (01-04)
- CFDI UUID tracking per invoice

---

## Bank Reconciliation

### Transaction Import

Import bank transactions from multiple sources:
```json
POST /v1/bank-accounts/:id/import
{
  "transactions": [
    {
      "bank_transaction_id": "ext_123",
      "transaction_date": "2026-04-01",
      "amount": -1500.00,
      "transaction_type": "debit",
      "description": "Transfer to vendor"
    }
  ]
}
```

Supports integration with Plaid, Fintoc, and Belvo. Duplicate detection by `bank_transaction_id`.

### 4-Tier ML Matching Algorithm

The system automatically matches bank transactions to accounting records using a priority-based rule system:

| Priority | Rule | Confidence | Logic |
|----------|------|-----------|-------|
| 1 | Exact Amount + Date | 1.00 | Same amount and same day, single match |
| 2 | Exact Amount + Near Date | 0.90 | Same amount within 3 days, single match |
| 3 | Fuzzy Description | Variable | Levenshtein distance + Jaccard keyword similarity |
| 4 | ML Prediction | Variable | Feature-based scoring (amount diff, date diff, description similarity) |

**String matching utilities**:
- **Levenshtein distance**: Character-level edit distance for description comparison
- **Jaccard similarity**: Keyword-level set overlap (removes stop words)
- **Weighted scoring**: 40% Levenshtein + 60% Jaccard for description matching

**Auto-matching**: `POST /v1/bank-accounts/:id/auto-match` processes all unmatched transactions and auto-matches those with confidence >= 0.85.

---

## Fixed Assets & Depreciation

### 6 Depreciation Methods

| Method | Formula | Use Case |
|--------|---------|----------|
| **Straight-Line** | (Cost - Salvage) / Life | Default, equal monthly expense |
| **Declining Balance 150%** | Book Value x (1.5 / Life) | Accelerated, switches to SL when SL is higher |
| **Declining Balance 200%** | Book Value x (2.0 / Life) | Double-declining balance |
| **Sum-of-Years-Digits** | (Cost - Salvage) x (Remaining / SumOfYears) | Front-loaded depreciation |
| **MACRS** | IRS percentage tables (3-20 year classes) | US tax depreciation |
| **Units of Production** | (Cost - Salvage) x (Units / Total Capacity) | Usage-based (manufacturing) |

### MACRS Classes

Supports 3-year, 5-year, 7-year, 10-year, 15-year, and 20-year recovery periods with half-year convention.

### Monthly Depreciation Runner

```typescript
import { runMonthlyDepreciation } from './services/assets/depreciation.js';

const result = await runMonthlyDepreciation(entityId, fiscalPeriodId, userId);
// { processed: 15, errors: [] }
```

Automatically: calculates depreciation, creates journal entries (DR Expense, CR Accumulated), updates asset book values.

---

## Inventory Costing

### 4 Costing Methods

| Method | Description | Best For |
|--------|------------|----------|
| **FIFO** | First-In, First-Out — consumes oldest layers first | Most companies, matches physical flow |
| **LIFO** | Last-In, First-Out — consumes newest layers first | Tax optimization during inflation (US only) |
| **Weighted Average** | Average cost across all layers | Commodities, high-volume items |
| **Specific Identification** | Track individual units | High-value items, serialized goods |

### Layer-Based Tracking

Every purchase creates an inventory layer with quantity, unit cost, and acquisition date. Sales consume layers according to the costing method and create a 4-line journal entry:

```
DR  Accounts Receivable     (sale price)
CR  Sales Revenue            (sale price)
DR  Cost of Goods Sold       (calculated COGS)
CR  Inventory                (calculated COGS)
```

---

## XML Ingestion

The XML Ingestion module automates the processing of incoming CFDI documents from suppliers, converting them into bills and journal entries with minimal manual intervention.

### Processing Pipeline

```
XML Upload (CFDI 4.0)
        │
        ▼
  cfdi-parser.ts        → Parses XML, extracts emisor, receptor, concepts, taxes
  sat-validation.ts     → Validates RFC format, catalog codes, totals
        │
        ▼
  Pre-Registration      → Document stored with status: pending, approved, rejected
  rules-engine.ts       → Applies automation rules (account routing, approval flags)
        │
        ▼
  Process / Approve     → Creates bill + auto-posts journal entry
```

### Rules Engine

Automation rules can match any CFDI field using 15 operators:

| Operator | Example |
|----------|---------|
| `equals` | `emisor.rfc equals ABC010101XYZ` |
| `contains` | `concepto.descripcion contains "Nómina"` |
| `greater_than` | `total greater_than 50000` |
| `regex` | `folio regex ^FAC-[0-9]+` |
| `in` | `emisor.regimenFiscal in [601, 626]` |

Rules can trigger actions: `set_account`, `set_cost_center`, `set_department`, `set_project`, `set_processing_mode` (`auto`, `batch`, `manual`, `hold`), `require_approval`, `reject`.

### Batch Processing

Group multiple pre-registrations into a processing batch, execute them in one operation, and track progress per document.

---

## Integrations

### Multi-PAC Router (Mexico)

Rather than a single PAC provider, the system supports **three PAC adapters with automatic failover** using circuit breakers:

| Priority | Provider | Fallback |
|----------|----------|---------|
| Primary | Finkok | → Secondary |
| Secondary | SW Sapien | → Tertiary |
| Tertiary | Edicom | → Error |

Each PAC call goes through:
1. **Circuit Breaker**: If a PAC fails 5 consecutive times, it opens the circuit and skips it for 60 seconds
2. **Retry**: Up to 3 attempts with exponential backoff before failing over

PAC preferences are configurable per tenant via `PUT /v1/admin/pac-preferences`.

### Payment Adapters

| Adapter | Provider | Use Case |
|---------|----------|---------|
| `stripe-adapter.ts` | Stripe | US/international card payments, ACH |
| `conekta-adapter.ts` | Conekta | Mexican card payments, OXXO, SPEI |

### Email — SendGrid

Transactional emails for invoice delivery, payment receipts, and overdue notifications via SendGrid (`sendgrid-adapter.ts`).

### Document Storage — AWS S3

CFDI XML files and PDF attachments are stored in S3 (`s3-adapter.ts`). Uploaded documents are referenced by their S3 key in the database, keeping the database lean.

---

## Mexico Compliance (CFDI/SAT)

### SAT Catalogs

The system includes complete SAT catalog codes:

- **Regimen Fiscal**: 17 codes (601 General, 612 Personas Fisicas, 626 RESICO, etc.)
- **Uso CFDI**: 14 codes (G01 Mercancias, G03 Gastos, S01 Sin efectos, etc.)
- **Metodo de Pago**: PUE (single payment), PPD (installments)
- **Forma de Pago**: 25 codes (01 Efectivo, 03 Transferencia, 04 Tarjeta de credito, etc.)
- **IVA Rates**: 16% (general), 8% (border zone), 0% (exempt)
- **Cancellation Reasons**: 01-04 as required by SAT

### CFDI 4.0 XML Generation

```typescript
import { generateCfdiXml, stampWithPAC } from './services/mexico/cfdi.js';

const xml = generateCfdiXml({
  invoice, lines, emisor, receptor,
  metodo_pago: 'PUE', forma_pago: '03', moneda: 'MXN'
});

const { uuid, xml_timbrado } = await stampWithPAC(xml);
```

### DIOT Report

Generate the Declaracion Informativa de Operaciones con Terceros:

```typescript
import { generateDIOT } from './services/mexico/cfdi.js';

const diotLines = await generateDIOT(entityId, 4, 2026); // April 2026
// Returns pipe-delimited format per SAT specification
```

---

## Webhooks

### Event Types (18 events)

```
journal_entry.created    journal_entry.posted     journal_entry.void
invoice.created          invoice.sent             invoice.paid
invoice.partially_paid   invoice.overdue          invoice.void
cfdi.stamped             cfdi.cancelled
bill.created             bill.approved            bill.paid
payment.received         payment.made
bank_transaction.imported  bank_transaction.matched
reconciliation.completed
period.soft_closed       period.hard_closed
account.created          account.updated
```

### Delivery

- **HMAC-SHA256** signature verification via `X-Webhook-Signature` header
- **Exponential backoff** retry (up to 5 attempts)
- **30-second timeout** per delivery attempt
- **Delivery logs** with status, HTTP code, response body, and error tracking

### Creating a Subscription

```json
POST /v1/webhooks
{
  "url": "https://your-app.com/webhook",
  "events": ["invoice.paid", "payment.received"]
}
```

Returns subscription with a `secret` for HMAC verification.

---

## Caching

Three-layer Redis caching strategy:

| Layer | Data | TTL | Invalidation |
|-------|------|-----|-------------|
| 1 | Chart of Accounts | 1 hour | On account create/update |
| 2 | Exchange Rates | 24 hours | On rate import |
| 3 | Report Results | 30 minutes | On journal entry posting |

Caching is optional. If Redis is unavailable, the system operates normally with direct database queries.

---

## Rate Limiting

Redis-backed sliding window rate limiter. Configurable per tenant:

| Plan | Requests/Hour |
|------|--------------|
| Free | 100 |
| Starter | 1,000 |
| Professional | 10,000 |
| Enterprise | Unlimited |

Response headers:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 998
X-RateLimit-Reset: 1713060000
```

---

## Reporting

### Trial Balance

```
GET /v1/reports/trial-balance?entity_id=uuid&as_of_date=2026-12-31&account_level=3
```

Returns all accounts with debit/credit totals and validates that the books are balanced.

### Balance Sheet

```
GET /v1/reports/balance-sheet?entity_id=uuid&as_of_date=2026-12-31
```

Returns assets, liabilities, and equity sections with subsection breakdowns.

### Income Statement (P&L)

```
GET /v1/reports/income-statement?entity_id=uuid&start_date=2026-01-01&end_date=2026-12-31
```

Returns revenue, expenses, and net income.

### Cash Flow Statement

```
GET /v1/reports/cash-flow?entity_id=uuid&start_date=2026-01-01&end_date=2026-12-31&method=indirect
```

Returns operating activities (with depreciation add-back, AR/AP changes), investing activities (asset purchases/disposals), and net cash flow.

### General Ledger

```
GET /v1/reports/general-ledger?entity_id=uuid&account_id=uuid&start_date=2026-01-01&end_date=2026-03-31
```

Returns every posted transaction line for the specified account(s) with journal entry references.

### Aging Reports

```
GET /v1/reports/aged-receivables?entity_id=uuid&as_of_date=2026-04-14
GET /v1/reports/aged-payables?entity_id=uuid&as_of_date=2026-04-14
```

Returns outstanding invoices/bills grouped by customer/vendor with days overdue.

---

## Triple-Entry Accounting (Blockchain)

Beyond traditional double-entry bookkeeping, the system implements **triple-entry accounting**: every journal entry is cryptographically attested to one or more blockchains, creating an immutable third record outside the company's own database.

### Architecture

```
Journal Entry (posted)
        │
        ▼
  CryptoService
  ├── SHA-256 hash of entry + lines
  ├── Pedersen commitment on total_debits (ZK-compatible)
  └── Range proof (amount is valid without revealing it)
        │
        ▼
  zkVerify (UltraPLONK)
  └── Verifies proof off-chain → issues attestation ID + Merkle root
        │
        ▼
  Chain Adapters (configurable)
  ├── Primary chain (sync): Arbitrum One, Base, Polygon zkEVM, or Ethereum
  └── Secondary chains (async backup): any combination of supported chains
        │
        ▼
  Bitcoin Anchoring (batch, optional)
  └── Merkle tree of recent entries → OP_RETURN in Bitcoin tx (TRPA protocol)
```

### Key Concepts

**Entry Hash**: Each journal entry gets a deterministic SHA-256 hash computed from its ID, entity, fiscal period, date, totals, and all line items. The hash is stored on the `journal_entries` table (`entry_hash` column).

**Pedersen Commitment**: A cryptographic commitment to the debit total that allows proving the amount is within a valid range without revealing the actual figure.

**Period Commitment**: At period close, a Merkle tree is built from all posted entry hashes. The root is stored on-chain and in `period_commitments`, making the entire period's history tamper-evident.

**Bitcoin Anchoring (TRPA protocol)**: Entry hashes are batched into a Merkle tree and the root is embedded in a Bitcoin `OP_RETURN` output with the 4-byte protocol ID `TRPA`. Anyone can independently verify the anchor using only Bitcoin's public ledger.

### Supported Chains

| Chain | Network | Explorer |
|-------|---------|---------|
| Arbitrum One | EVM (L2) | arbiscan.io |
| Base | EVM (L2) | basescan.org |
| Polygon zkEVM | EVM (L2 ZK) | zkevm.polygonscan.com |
| Ethereum Mainnet | EVM (L1) | etherscan.io |
| Solana | SVM | solscan.io |
| Bitcoin | OP_RETURN | mempool.space |

### Redundancy Modes

| Mode | Behavior |
|------|---------|
| `none` | Primary chain only |
| `async_backup` | Primary sync + secondary chains async |
| `sync_multi` | All configured chains in parallel |
| `consensus` | Requires majority confirmation before resolving |

### API Usage

```typescript
import { blockchainOrchestrator } from './services/blockchain/orchestrator.js';

// Attest a single journal entry after posting
const result = await blockchainOrchestrator.attestJournalEntry({
  tenantId, entityId, journalEntryId,
});
// { attestationId: 'uuid', status: 'confirmed' }

// Commit an entire fiscal period (builds Merkle tree of all entries)
const commit = await blockchainOrchestrator.commitPeriod({
  tenantId, entityId, periodId,
});
// { commitmentId, merkleRoot, entryCount }

// Anchor recent entries to Bitcoin
const anchor = await blockchainOrchestrator.anchorToBitcoin({ tenantId });
// { anchorId, merkleRoot, entryCount }
```

### Bitcoin Proof Verification

```typescript
import { bitcoinAnchorService } from './services/blockchain/bitcoin-anchor.js';

const proof = await bitcoinAnchorService.getBitcoinProof(entryHash);
// Returns: bitcoinTxid, blockHeight, merkleProof, explorerUrl, verificationCode
```

The `verificationCode` field contains a ready-to-run Node.js snippet that independently verifies the Merkle proof against the on-chain `OP_RETURN` data using only public information.

### Database Tables (`006_blockchain_integration.sql`)

| Table | Purpose |
|-------|---------|
| `blockchain_config` | Per-tenant chain config (primary chain, redundancy mode, verification layer) |
| `blockchain_attestations` | Per-entry attestation records with ZK proof and chain results |
| `period_commitments` | Merkle root commitments per fiscal period |
| `bitcoin_anchors` | Bitcoin transaction records (txid, block, confirmations) |
| `bitcoin_anchor_entries` | Individual entry → Bitcoin anchor mappings with Merkle proofs |
| `published_aggregates` | Anonymized aggregate disclosures per dimension |
| `disclosure_config` | Privacy thresholds and rounding rules per entity |

---

## Configuration

All configuration is via environment variables (`.env` file):

**Core**

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment (`development`, `production`) | `development` |
| `PORT` | HTTP port | `3000` |
| `APP_NAME` | Application name (logs, headers) | `accounting-core` |
| `API_VERSION` | API version prefix | `v1` |

**Database**

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/accounting_core` |
| `DATABASE_POOL_MIN` | Minimum connection pool size | `5` |
| `DATABASE_POOL_MAX` | Maximum connection pool size | `20` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | Elasticsearch URL (optional) | `http://localhost:9200` |

**Security**

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret | `dev-secret-change-me` |
| `JWT_ACCESS_EXPIRATION` | Access token TTL | `1h` |
| `JWT_REFRESH_EXPIRATION` | Refresh token TTL | `30d` |
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM | Required |

**Mexico CFDI / PAC**

| Variable | Description | Default |
|----------|-------------|---------|
| `PAC_PROVIDER` | Primary PAC provider (`finkok`, `sw_sapien`, `edicom`) | `finkok` |
| `PAC_USERNAME` | PAC account username | — |
| `PAC_PASSWORD` | PAC account password | — |
| `PAC_ENVIRONMENT` | PAC environment (`sandbox`, `production`) | `sandbox` |

**Banking Integrations**

| Variable | Description | Default |
|----------|-------------|---------|
| `PLAID_CLIENT_ID` | Plaid client ID (USA banks) | — |
| `PLAID_SECRET` | Plaid secret | — |
| `PLAID_ENV` | Plaid environment (`sandbox`, `production`) | `sandbox` |

**AWS / Storage**

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | AWS access key | — |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | — |
| `AWS_REGION` | AWS region | `us-east-1` |
| `S3_BUCKET` | S3 bucket for document storage | `accounting-core-documents` |

**Webhooks & Rate Limiting**

| Variable | Description | Default |
|----------|-------------|---------|
| `WEBHOOK_MAX_RETRIES` | Max webhook delivery attempts | `5` |
| `WEBHOOK_RETRY_INTERVAL` | Seconds between retries | `60` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in ms | `3600000` (1 hour) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `1000` |

---

## Docker Deployment

### Development

```bash
docker compose -f docker/docker-compose.yml up -d
```

Starts PostgreSQL 15, Redis 7, Elasticsearch 8, and the application with hot-reload.

### Production

```bash
docker build -f docker/Dockerfile -t accounting-core .
docker run -p 3000:3000 --env-file .env accounting-core
```

The Dockerfile uses multi-stage builds: installs all deps, compiles TypeScript, then creates a slim production image with only runtime dependencies.

---

## Development Guide

### Available Scripts

```bash
npm run dev          # Start dev server with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled production build
npm run migrate      # Run pending database migrations
npm run seed         # Seed demo data
npm run test         # Run tests (vitest)
npm run lint         # Lint source code
npm run typecheck    # Type check without emitting
```

### Adding a New Endpoint

1. Create a route file in `src/api/rest/routes/`
2. Use `requirePermission()` middleware for authorization
3. Import in `src/index.ts` and mount with `app.use()`
4. Add corresponding GraphQL types/resolvers if needed

### Adding a New Migration

1. Create a file in `src/database/migrations/` (e.g., `005_new_feature.sql`)
2. Run `npm run migrate`
3. The migration runner auto-detects and executes new files in order

### Monetary Calculations

Always use `Decimal` from `decimal.js` for monetary amounts to avoid floating-point errors:

```typescript
import Decimal from 'decimal.js';

const subtotal = new Decimal('100.00');
const tax = subtotal.times('0.16');        // 16.00
const total = subtotal.plus(tax);          // 116.00
console.log(total.toFixed(4));             // "116.0000"
```

### Error Handling

Use the error classes from `src/utils/errors.ts`:

```typescript
throw new ValidationError('Amount must be positive', 'amount');
throw new NotFoundError('Invoice', invoiceId);
throw new AccountingError('PERIOD_CLOSED', 'Cannot post to closed period');
throw new ForbiddenError('Insufficient permissions');
```

All errors are automatically caught by the error handler middleware and returned as structured JSON.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Language | TypeScript 5+ |
| HTTP Framework | Express 4.18 |
| GraphQL | Apollo Server 4.10 |
| Database | PostgreSQL 15 |
| Cache | Redis 7 (ioredis) |
| Authentication | JWT (jsonwebtoken) |
| Encryption | AES-256-GCM (Node.js crypto) |
| Validation | Zod |
| Precision Math | Decimal.js |
| Job Queue | BullMQ (Redis-backed) |
| Logging | Winston + Morgan |
| Testing | Vitest |
| Container | Docker + Docker Compose |
| ZK Proofs | zkVerify (UltraPLONK) |
| Merkle Trees | merkletreejs |
| Blockchain (EVM) | ethers.js-compatible adapters (Arbitrum, Base, Polygon zkEVM, Ethereum) |
| Blockchain (Bitcoin) | OP_RETURN / OpenTimestamps (TRPA protocol) |

---

## License

Proprietary. All rights reserved.
