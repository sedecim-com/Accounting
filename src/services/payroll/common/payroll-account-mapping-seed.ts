import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { withTransaction } from '../../../database/connection.js';

// ============================================================
// SEED OF THE PAYROLL → GL MAPPING
//
// `payroll_account_mapping` resolves the semantic buckets a pay run posts
// into (wages, employer taxes, cash, each withholding payable) to concrete
// accounts. It had a reader — gl-posting-service.ts — and NO WRITER anywhere
// in the repository, so the first pay run of any entity died with
// "Missing payroll_account_mapping for bucket: wages_expense".
//
// The base chart (chart-seed.ts) carries no payroll accounts at all, so this
// creates the ones it lacks rather than mapping a bucket to something close
// enough. Mapping "IMSS por pagar" onto a generic "Retenciones por Pagar"
// would make the account reconcile to nothing and the IDSE payment
// impossible to tie out.
//
// Idempotent by construction: it creates only missing accounts and maps only
// unmapped buckets, so re-running never overwrites a firm's own choice.
// ============================================================

export interface PayrollAccountSpec {
  code: string;
  name: string;
  account_type: 'asset' | 'liability' | 'expense';
  normal_balance: 'debit' | 'credit';
  fs_category: string;
  description: string;
}

/** Buckets `gl-posting-service` resolves. The first three are mandatory there. */
export const REQUIRED_BUCKETS = ['wages_expense', 'payroll_tax_expense', 'cash_payroll'] as const;

/**
 * Mexico. Codes follow the existing MX numbering (chart-seed.ts) so they slot
 * into the chart naturally; 2130 "ISR por Pagar" and 1111 already exist there
 * and are reused rather than duplicated.
 */
export const MX_PAYROLL_ACCOUNTS: PayrollAccountSpec[] = [
  {
    code: '5200', name: 'Sueldos y Salarios', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'Percepciones brutas del personal, antes de retenciones.',
  },
  {
    code: '5210', name: 'Cuotas Patronales IMSS e INFONAVIT', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description:
      'Aportaciones que paga el patrón, separadas del sueldo porque no son percepción ' +
      'del trabajador y no entran en su CFDI de nómina.',
  },
  {
    code: '2150', name: 'IMSS por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Cuota obrera retenida más cuota patronal, hasta enterarse por SUA/IDSE.',
  },
  {
    code: '2160', name: 'INFONAVIT por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Aportaciones y amortizaciones de crédito, bimestrales.',
  },
  {
    code: '2170', name: 'Otras Retenciones de Nómina', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Pensiones alimenticias, préstamos y descuentos posteriores al impuesto.',
  },
  {
    code: '2180', name: 'Prestaciones por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Deducciones anteriores al impuesto retenidas a favor de un tercero.',
  },
];

export const MX_BUCKET_MAP: Record<string, string> = {
  wages_expense: '5200',
  payroll_tax_expense: '5210',
  cash_payroll: '1111',        // Banco Nacional - MXN, from the base chart
  isr_payable: '2130',         // ISR por Pagar, from the base chart
  imss_payable: '2150',
  infonavit_payable: '2160',
  garnishment_payable: '2170',
  benefits_payable: '2180',
};

/**
 * United States. There is no US base chart in this repository, so every
 * account here is created. The numbering deliberately mirrors the MX scheme
 * already in use rather than inventing a second convention.
 */
export const US_PAYROLL_ACCOUNTS: PayrollAccountSpec[] = [
  {
    code: '5200', name: 'Salaries and Wages', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'Gross compensation before withholding.',
  },
  {
    code: '5210', name: 'Employer Payroll Taxes', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'Employer FICA, FUTA and SUTA — the employer cost, not the employee withholding.',
  },
  {
    code: '2150', name: 'Federal Income Tax Withheld', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'FIT withheld from employees, until deposited.',
  },
  {
    code: '2151', name: 'FICA Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Social Security and Medicare, employee and employer halves.',
  },
  {
    code: '2152', name: 'FUTA Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Federal unemployment tax.',
  },
  {
    code: '2153', name: 'SUTA Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'State unemployment tax.',
  },
  {
    code: '2154', name: 'State and Local Tax Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'State income tax and disability withholding.',
  },
  {
    code: '2170', name: 'Garnishments Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Post-tax deductions owed to a third party.',
  },
  {
    code: '2180', name: 'Benefits Payable', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Pre-tax deductions owed to a benefits provider.',
  },
  {
    code: '1111', name: 'Operating Bank Account', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description: 'Account the net pay leaves from.',
  },
];

export const US_BUCKET_MAP: Record<string, string> = {
  wages_expense: '5200',
  payroll_tax_expense: '5210',
  cash_payroll: '1111',
  fit_payable: '2150',
  fica_payable: '2151',
  futa_payable: '2152',
  suta_payable: '2153',
  state_tax_payable: '2154',
  garnishment_payable: '2170',
  benefits_payable: '2180',
};

export interface PayrollSeedResult {
  country: 'MX' | 'USA';
  accountsCreated: string[];
  bucketsMapped: string[];
  /** Buckets already mapped by someone else; left exactly as they were. */
  bucketsAlreadyMapped: string[];
  /**
   * Buckets whose account this seeder does not create and the chart does not
   * have — the onboarded-chart case. The firm has to choose the account.
   */
  bucketsUnmappable: Array<{ bucket: string; code: string }>;
}

export function chartFor(country: string): { accounts: PayrollAccountSpec[]; buckets: Record<string, string> } {
  return country === 'USA'
    ? { accounts: US_PAYROLL_ACCOUNTS, buckets: US_BUCKET_MAP }
    : { accounts: MX_PAYROLL_ACCOUNTS, buckets: MX_BUCKET_MAP };
}

/**
 * Creates the payroll accounts an entity's chart lacks and maps every bucket
 * that has no mapping yet.
 *
 * `options.client` lets entity creation seed the chart, the roles and this
 * mapping inside one transaction, so an entity is never half-configured.
 */
export async function seedPayrollAccountMapping(
  entityId: string,
  tenantId: string,
  country: string,
  createdBy: string,
  options?: { client?: pg.PoolClient }
): Promise<PayrollSeedResult> {
  const run = async (client: pg.PoolClient): Promise<PayrollSeedResult> => {
    const { accounts, buckets } = chartFor(country);

    const existing = await client.query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1',
      [entityId]
    );
    const byCode = new Map(existing.rows.map((r) => [r.code, r.id]));
    const accountsCreated: string[] = [];

    for (const spec of accounts) {
      if (byCode.has(spec.code)) continue;
      const id = uuidv4();
      await client.query(
        `INSERT INTO accounts (
           id, code, name, account_type, normal_balance, fs_category,
           description, entity_id, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id, spec.code, spec.name, spec.account_type, spec.normal_balance,
          spec.fs_category, spec.description, entityId, createdBy,
        ]
      );
      byCode.set(spec.code, id);
      accountsCreated.push(spec.code);
    }

    const mapped = await client.query<{ bucket: string }>(
      'SELECT bucket FROM payroll_account_mapping WHERE entity_id = $1',
      [entityId]
    );
    const already = new Set(mapped.rows.map((r) => r.bucket));

    const bucketsMapped: string[] = [];
    const bucketsAlreadyMapped: string[] = [];
    const bucketsUnmappable: Array<{ bucket: string; code: string }> = [];
    for (const [bucket, code] of Object.entries(buckets)) {
      if (already.has(bucket)) {
        bucketsAlreadyMapped.push(bucket);
        continue;
      }
      const accountId = byCode.get(code);
      if (!accountId) {
        // Two codes are REUSED from the base chart rather than seeded here
        // (MX: 1111 the bank, 2130 ISR por pagar). An entity onboarded from
        // another system keeps its own chart — that is what the 'auto'
        // strategy is for — so those codes may simply not exist.
        //
        // Refusing to seed anything in that case would block the whole
        // mapping over one account the firm must choose for itself anyway;
        // inventing a bank account would be worse. So: map everything that
        // can be mapped, and report the rest. `doctor` surfaces it, and the
        // posting engine still fails loudly if a required bucket is used
        // before someone picks an account.
        bucketsUnmappable.push({ bucket, code });
        continue;
      }
      await client.query(
        `INSERT INTO payroll_account_mapping (id, tenant_id, entity_id, bucket, account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, entity_id, bucket) DO NOTHING`,
        [uuidv4(), tenantId, entityId, bucket, accountId]
      );
      bucketsMapped.push(bucket);
    }

    return {
      country: country === 'USA' ? 'USA' : 'MX',
      accountsCreated,
      bucketsMapped,
      bucketsAlreadyMapped,
      bucketsUnmappable,
    };
  };

  return options?.client ? run(options.client) : withTransaction(run);
}
