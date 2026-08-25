import Decimal from 'decimal.js';

// ============================================================
// ENUMS
// ============================================================

export enum AccountType {
  ASSET = 'asset',
  LIABILITY = 'liability',
  EQUITY = 'equity',
  REVENUE = 'revenue',
  EXPENSE = 'expense',
  CONTRA_ASSET = 'contra_asset',
  CONTRA_LIABILITY = 'contra_liability',
  CONTRA_EQUITY = 'contra_equity',
}

export enum AccountSubtype {
  CURRENT_ASSET = 'current_asset',
  FIXED_ASSET = 'fixed_asset',
  OTHER_ASSET = 'other_asset',
  CURRENT_LIABILITY = 'current_liability',
  LONG_TERM_LIABILITY = 'long_term_liability',
  COMMON_STOCK = 'common_stock',
  RETAINED_EARNINGS = 'retained_earnings',
  OPERATING_REVENUE = 'operating_revenue',
  OTHER_REVENUE = 'other_revenue',
  COST_OF_GOODS = 'cost_of_goods',
  OPERATING_EXPENSE = 'operating_expense',
  OTHER_EXPENSE = 'other_expense',
}

export enum FSCategory {
  CURRENT_ASSETS = 'current_assets',
  NON_CURRENT_ASSETS = 'non_current_assets',
  CURRENT_LIABILITIES = 'current_liabilities',
  LONG_TERM_LIABILITIES = 'long_term_liabilities',
  EQUITY = 'equity',
  REVENUE = 'revenue',
  COGS = 'cogs',
  OPERATING_EXPENSES = 'operating_expenses',
  OTHER_INCOME = 'other_income',
  OTHER_EXPENSES = 'other_expenses',
  TAX = 'tax',
}

export enum NormalBalance {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

export enum JournalEntryType {
  STANDARD = 'standard',
  ADJUSTING = 'adjusting',
  CLOSING = 'closing',
  REVERSING = 'reversing',
  CORRECTION = 'correction',
  AUTO_INVOICE = 'auto_invoice',
  AUTO_BILL = 'auto_bill',
  AUTO_PAYMENT = 'auto_payment',
  AUTO_DEPRECIATION = 'auto_depreciation',
  AUTO_RECONCILIATION = 'auto_reconciliation',
  PAYROLL = 'payroll',
}

export enum JournalEntryStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  POSTED = 'posted',
  VOID = 'void',
}

export enum TransactionType {
  INVOICE = 'invoice',
  BILL = 'bill',
  PAYMENT_RECEIVED = 'payment_received',
  PAYMENT_MADE = 'payment_made',
  EXPENSE = 'expense',
  DEPOSIT = 'deposit',
  TRANSFER = 'transfer',
  ADJUSTMENT = 'adjustment',
}

export enum TransactionStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  APPROVED = 'approved',
  POSTED = 'posted',
  PAID = 'paid',
  PARTIALLY_PAID = 'partially_paid',
  VOID = 'void',
  CANCELLED = 'cancelled',
}

export enum InvoiceStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  SENT = 'sent',
  VIEWED = 'viewed',
  PAID = 'paid',
  PARTIALLY_PAID = 'partially_paid',
  OVERDUE = 'overdue',
  VOID = 'void',
  CANCELLED = 'cancelled',
  UNCOLLECTIBLE = 'uncollectible',
}

export enum BillStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  POSTED = 'posted',
  PAID = 'paid',
  PARTIALLY_PAID = 'partially_paid',
  VOID = 'void',
  CANCELLED = 'cancelled',
}

export enum PaymentMethod {
  CASH = 'cash',
  CHECK = 'check',
  ACH = 'ach',
  WIRE = 'wire',
  SPEI = 'spei',
  CREDIT_CARD = 'credit_card',
  DEBIT_CARD = 'debit_card',
  STRIPE = 'stripe',
  PAYPAL = 'paypal',
  OTHER = 'other',
}

export enum PaymentStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  VOID = 'void',
}

export enum FiscalPeriodStatus {
  FUTURE = 'future',
  OPEN = 'open',
  SOFT_CLOSE = 'soft_close',
  HARD_CLOSE = 'hard_close',
  LOCKED = 'locked',
}

export enum FiscalPeriodType {
  REGULAR = 'regular',
  ADJUSTMENT = 'adjustment',
  CLOSING = 'closing',
}

export enum DepreciationMethod {
  STRAIGHT_LINE = 'straight_line',
  DECLINING_BALANCE_150 = 'declining_balance_150',
  DECLINING_BALANCE_200 = 'declining_balance_200',
  SUM_OF_YEARS_DIGITS = 'sum_of_years_digits',
  UNITS_OF_PRODUCTION = 'units_of_production',
  MACRS = 'macrs',
}

export enum AssetStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DISPOSED = 'disposed',
  FULLY_DEPRECIATED = 'fully_depreciated',
}

export enum InventoryCostingMethod {
  FIFO = 'fifo',
  LIFO = 'lifo',
  WEIGHTED_AVERAGE = 'weighted_average',
  SPECIFIC_IDENTIFICATION = 'specific_identification',
}

export enum CfdiStatus {
  PENDING = 'pending',
  STAMPED = 'stamped',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum BankTransactionType {
  DEBIT = 'debit',
  CREDIT = 'credit',
  FEE = 'fee',
  INTEREST = 'interest',
  ADJUSTMENT = 'adjustment',
}

export enum ReconciliationMatchType {
  AUTOMATIC = 'automatic',
  MANUAL = 'manual',
  SUGGESTED = 'suggested',
}

export enum ReconciliationSessionStatus {
  IN_PROGRESS = 'in_progress',
  BALANCED = 'balanced',
  APPROVED = 'approved',
  POSTED = 'posted',
}

export enum ExchangeRateSource {
  MANUAL = 'manual',
  BANCO_MEXICO = 'banco_mexico',
  ECB = 'ecb',
  FED = 'fed',
  XE = 'xe',
  OPEN_EXCHANGE_RATES = 'openexchangerates',
}

export enum ExchangeRateType {
  SPOT = 'spot',
  AVERAGE = 'average',
  BUDGET = 'budget',
  HISTORICAL = 'historical',
}

export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  POST = 'post',
  VOID = 'void',
  APPROVE = 'approve',
  CLOSE = 'close',
  REOPEN = 'reopen',
}

// ============================================================
// CORE INTERFACES
// ============================================================

export interface Account {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  account_level: number;
  full_code: string;
  account_type: AccountType;
  account_subtype: AccountSubtype | null;
  fs_category: FSCategory | null;
  is_control_account: boolean;
  is_system_account: boolean;
  allow_manual_entries: boolean;
  require_subsidiary: boolean;
  entity_id: string;
  currency_code: string | null;
  tax_line_id: string | null;
  us_gaap_code: string | null;
  mx_nif_code: string | null;
  ifrs_code: string | null;
  normal_balance: NormalBalance;
  is_active: boolean;
  is_header: boolean;
  description: string | null;
  tags: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  updated_by: string | null;
}

export interface JournalEntry {
  id: string;
  entry_number: string;
  entry_type: JournalEntryType;
  entity_id: string;
  fiscal_period_id: string;
  source_type: string | null;
  source_id: string | null;
  reference: string | null;
  entry_date: Date;
  posted_date: Date | null;
  status: JournalEntryStatus;
  is_reversal: boolean;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  description: string | null;
  notes: string | null;
  attachments: Record<string, unknown>[] | null;
  total_debits: string;
  total_credits: string;
  created_at: Date;
  created_by: string;
  posted_by: string | null;
  approved_by: string | null;
  lines?: JournalEntryLine[];
}

export interface JournalEntryLine {
  id: string;
  journal_entry_id: string;
  line_number: number;
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  cost_center_id: string | null;
  department_id: string | null;
  project_id: string | null;
  class_id: string | null;
  currency_code: string | null;
  foreign_debit: string | null;
  foreign_credit: string | null;
  exchange_rate: string | null;
  is_reconciled: boolean;
  reconciled_at: Date | null;
  reconciliation_id: string | null;
  description: string | null;
  tags: Record<string, unknown> | null;
}

export interface Transaction {
  id: string;
  transaction_number: string;
  transaction_type: TransactionType;
  entity_id: string;
  customer_id: string | null;
  vendor_id: string | null;
  amount: string;
  currency_code: string;
  exchange_rate: string;
  functional_amount: string;
  transaction_date: Date;
  due_date: Date | null;
  status: TransactionStatus;
  amount_paid: string;
  amount_due: string;
  journal_entry_id: string | null;
  description: string | null;
  memo: string | null;
  reference: string | null;
  terms: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
}

export interface FiscalYear {
  id: string;
  entity_id: string;
  year_number: number;
  start_date: Date;
  end_date: Date;
  is_calendar_year: boolean;
  status: 'open' | 'closed';
  created_at: Date;
  updated_at: Date;
}

export interface FiscalPeriod {
  id: string;
  fiscal_year_id: string;
  entity_id: string;
  period_number: number;
  period_name: string;
  start_date: Date;
  end_date: Date;
  period_type: FiscalPeriodType;
  status: FiscalPeriodStatus;
  soft_close_date: Date | null;
  hard_close_date: Date | null;
  closed_by: string | null;
  close_checklist: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: string;
  inverse_rate: string;
  effective_date: Date;
  effective_until: Date | null;
  source: ExchangeRateSource;
  source_metadata: Record<string, unknown> | null;
  rate_type: ExchangeRateType;
  created_at: Date;
  created_by: string;
}

// ============================================================
// AP/AR INTERFACES
// ============================================================

export interface Vendor {
  id: string;
  entity_id: string;
  vendor_number: string;
  company_name: string;
  contact_name: string | null;
  tax_id: string | null;
  tax_id_type: 'rfc' | 'ein' | 'vat' | null;
  is_1099_vendor: boolean;
  email: string | null;
  phone: string | null;
  website: string | null;
  billing_address: Record<string, unknown> | null;
  shipping_address: Record<string, unknown> | null;
  payment_terms: string;
  default_expense_account_id: string | null;
  currency_code: string;
  bank_account_number_encrypted: string | null;
  bank_routing_number_encrypted: string | null;
  bank_name: string | null;
  clabe_encrypted: string | null;
  auto_pay_enabled: boolean;
  credit_limit: string | null;
  is_active: boolean;
  tags: Record<string, unknown> | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
}

export interface Bill {
  id: string;
  entity_id: string;
  bill_number: string;
  vendor_id: string;
  vendor_invoice_number: string | null;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  currency_code: string;
  exchange_rate: string;
  bill_date: Date;
  due_date: Date;
  received_date: Date | null;
  status: BillStatus;
  amount_paid: string;
  amount_due: string;
  last_payment_date: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  purchase_order_id: string | null;
  journal_entry_id: string | null;
  description: string | null;
  memo: string | null;
  terms: string | null;
  attachments: Record<string, unknown>[] | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  lines?: BillLine[];
}

export interface BillLine {
  id: string;
  bill_id: string;
  line_number: number;
  account_id: string;
  item_id: string | null;
  description: string | null;
  quantity: string;
  unit_price: string;
  line_amount: string;
  tax_amount: string;
  total_amount: string;
  cost_center_id: string | null;
  project_id: string | null;
  tags: Record<string, unknown> | null;
}

export interface VendorPayment {
  id: string;
  entity_id: string;
  payment_number: string;
  vendor_id: string;
  payment_amount: string;
  currency_code: string;
  payment_method: PaymentMethod;
  check_number: string | null;
  reference_number: string | null;
  bank_account_id: string | null;
  payment_date: Date;
  status: PaymentStatus;
  journal_entry_id: string | null;
  memo: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
}

export interface Customer {
  id: string;
  entity_id: string;
  customer_number: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  tax_id: string | null;
  tax_id_type: 'rfc' | 'ein' | 'vat' | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  billing_address: Record<string, unknown> | null;
  shipping_address: Record<string, unknown> | null;
  payment_terms: string;
  credit_limit: string | null;
  currency_code: string;
  default_revenue_account_id: string | null;
  default_ar_account_id: string | null;
  dunning_profile_id: string | null;
  is_active: boolean;
  credit_status: 'approved' | 'on_hold' | 'suspended';
  tags: Record<string, unknown> | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
}

export interface Invoice {
  id: string;
  entity_id: string;
  invoice_number: string;
  customer_id: string;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  currency_code: string;
  exchange_rate: string;
  invoice_date: Date;
  due_date: Date;
  delivery_date: Date | null;
  status: InvoiceStatus;
  amount_paid: string;
  amount_due: string;
  last_payment_date: Date | null;
  cfdi_uuid: string | null;
  cfdi_xml_url: string | null;
  cfdi_status: CfdiStatus | null;
  pac_provider: string | null;
  stamped_at: Date | null;
  sales_order_id: string | null;
  journal_entry_id: string | null;
  description: string | null;
  memo: string | null;
  terms: string | null;
  po_number: string | null;
  sent_at: Date | null;
  sent_to: string | null;
  pdf_url: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  lines?: InvoiceLine[];
}

export interface InvoiceLine {
  id: string;
  invoice_id: string;
  line_number: number;
  item_id: string | null;
  description: string | null;
  quantity: string;
  unit_price: string;
  revenue_account_id: string;
  tax_code: string | null;
  tax_rate: string | null;
  tax_amount: string;
  line_amount: string;
  total_amount: string;
  cost_center_id: string | null;
  project_id: string | null;
  cfdi_product_code: string | null;
  cfdi_unit_code: string | null;
}

// ============================================================
// BANKING INTERFACES
// ============================================================

export interface BankAccount {
  id: string;
  entity_id: string;
  account_name: string;
  account_number_encrypted: string | null;
  account_number_last4: string | null;
  routing_number_encrypted: string | null;
  bank_name: string;
  bank_branch: string | null;
  swift_code: string | null;
  iban: string | null;
  clabe: string | null;
  gl_account_id: string;
  currency_code: string;
  plaid_account_id: string | null;
  fintoc_account_id: string | null;
  belvo_account_id: string | null;
  auto_import_enabled: boolean;
  import_frequency: 'hourly' | 'daily' | 'weekly' | null;
  current_balance: string | null;
  available_balance: string | null;
  last_synced_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BankTransaction {
  id: string;
  bank_account_id: string;
  bank_transaction_id: string | null;
  transaction_date: Date;
  posted_date: Date | null;
  amount: string;
  transaction_type: BankTransactionType;
  description: string | null;
  merchant_name: string | null;
  category: string | null;
  raw_data: Record<string, unknown> | null;
  is_matched: boolean;
  matched_at: Date | null;
  matched_by: string | null;
  confidence_score: string | null;
  imported_at: Date;
  import_batch_id: string | null;
}

export interface ReconciliationSession {
  id: string;
  bank_account_id: string;
  entity_id: string;
  start_date: Date;
  end_date: Date;
  beginning_balance: string;
  ending_balance_per_bank: string;
  ending_balance_per_books: string;
  outstanding_checks: string;
  deposits_in_transit: string;
  bank_charges: string;
  bank_interest: string;
  other_adjustments: string;
  status: ReconciliationSessionStatus;
  variance: string;
  notes: string | null;
  completed_at: Date | null;
  completed_by: string | null;
  approved_by: string | null;
  created_at: Date;
  updated_at: Date;
}

// ============================================================
// FIXED ASSETS INTERFACES
// ============================================================

export interface FixedAsset {
  id: string;
  entity_id: string;
  asset_number: string;
  asset_name: string;
  description: string | null;
  category_id: string;
  acquisition_date: Date;
  acquisition_cost: string;
  vendor_id: string | null;
  purchase_order: string | null;
  salvage_value: string;
  useful_life_years: number;
  useful_life_months: number;
  depreciation_method: DepreciationMethod;
  book_depreciation_method: DepreciationMethod | null;
  tax_depreciation_method: DepreciationMethod | null;
  macrs_class: string | null;
  depreciation_start_date: Date;
  current_book_value: string;
  accumulated_depreciation: string;
  last_depreciation_date: Date | null;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
  serial_number: string | null;
  manufacturer: string | null;
  model: string | null;
  location: string | null;
  responsible_employee_id: string | null;
  cost_center_id: string | null;
  department_id: string | null;
  status: AssetStatus;
  disposal_date: Date | null;
  disposal_amount: string | null;
  disposal_method: string | null;
  gain_loss_amount: string | null;
  tags: Record<string, unknown> | null;
  notes: string | null;
  attachments: Record<string, unknown>[] | null;
  created_at: Date;
  updated_at: Date;
  created_by: string;
}

export interface DepreciationScheduleEntry {
  id: string;
  asset_id: string;
  fiscal_period_id: string;
  depreciation_date: Date;
  depreciation_expense: string;
  accumulated_depreciation: string;
  book_value: string;
  schedule_type: 'book' | 'tax' | 'projected';
  is_posted: boolean;
  journal_entry_id: string | null;
  calculation_metadata: Record<string, unknown> | null;
  created_at: Date;
}

// ============================================================
// INVENTORY INTERFACES
// ============================================================

export interface InventoryItem {
  id: string;
  entity_id: string;
  item_code: string;
  item_name: string;
  description: string | null;
  costing_method: InventoryCostingMethod;
  current_quantity: string;
  current_value: string;
  average_unit_cost: string | null;
  inventory_account_id: string;
  cogs_account_id: string;
  revenue_account_id: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface InventoryLayer {
  id: string;
  item_id: string;
  acquired_date: Date;
  quantity: string;
  remaining_quantity: string;
  unit_cost: string;
  total_cost: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: Date;
}

// ============================================================
// SECURITY INTERFACES
// ============================================================

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  user_id: string;
  tenant_id: string;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  reason: string | null;
  approver_id: string | null;
}

export interface JwtPayload {
  user_id: string;
  tenant_id: string;
  email: string;
  roles: string[];
  permissions: string[];
  entities: string[];
  session_id: string;
  iat: number;
  exp: number;
}

export interface WebhookSubscription {
  id: string;
  tenant_id: string;
  url: string;
  events: string[];
  secret: string;
  is_active: boolean;
  retry_config: {
    max_retries: number;
    retry_interval_seconds: number;
  };
  created_at: Date;
  updated_at: Date;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed';
  http_status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  attempt_count: number;
  next_retry_at: Date | null;
  created_at: Date;
  delivered_at: Date | null;
}

// ============================================================
// API TYPES
// ============================================================

export interface PaginationParams {
  page?: number;
  per_page?: number;
  cursor?: string;
}

export interface PaginationMeta {
  page: number;
  per_page: number;
  total_pages: number;
  total_count: number;
  next_cursor: string | null;
  prev_cursor: string | null;
}

export interface ApiResponse<T> {
  data: T;
  meta: {
    request_id: string;
    timestamp: string;
    version: string;
  };
  pagination?: PaginationMeta;
  errors?: ApiError[];
}

export interface ApiError {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

// ============================================================
// VALIDATION TYPES
// ============================================================

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidationRule {
  name: string;
  validate: (entry: JournalEntry, lines: JournalEntryLine[]) => Promise<ValidationResult>;
}

// ============================================================
// MULTI-TENANCY
// ============================================================

export interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  schema_name: string;
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  is_active: boolean;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface Organization {
  id: string;
  tenant_id: string;
  name: string;
  type: 'holding' | 'operating';
  parent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface LegalEntity {
  id: string;
  organization_id: string;
  tenant_id: string;
  name: string;
  entity_type: 'corporation' | 'llc' | 'partnership' | 'sapi' | 'sa' | 'sc';
  tax_id: string;
  tax_id_type: 'rfc' | 'ein' | 'vat';
  incorporation_country: string;
  functional_currency: string;
  accounting_standard: 'us_gaap' | 'mx_nif' | 'ifrs';
  fiscal_year_start_month: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// ============================================================
// REPORTING TYPES
// ============================================================

export interface TrialBalanceRow {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  beginning_balance: string;
  debit_total: string;
  credit_total: string;
  ending_balance: string;
}

export interface BalanceSheetSection {
  name: string;
  total: string;
  subsections: {
    name: string;
    total: string;
    accounts: {
      id: string;
      code: string;
      name: string;
      balance: string;
    }[];
  }[];
}

export interface IncomeStatementSection {
  name: string;
  total: string;
  accounts: {
    id: string;
    code: string;
    name: string;
    amount: string;
  }[];
}
