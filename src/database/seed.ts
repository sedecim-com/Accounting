import { v4 as uuidv4 } from 'uuid';
import { closeDatabase, query } from './connection.js';

const TENANT_ID = uuidv4();
const ORG_ID = uuidv4();
const ENTITY_ID = uuidv4();
const USER_ID = uuidv4();
const FISCAL_YEAR_ID = uuidv4();

async function seed() {
  console.log('Seeding database...');

  // 1. Create tenant
  await query(
    `INSERT INTO public.tenants (id, name, subdomain, schema_name, plan)
     VALUES ($1, 'Demo Company', 'demo', 'public', 'professional')
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT_ID]
  );

  // 2. Create user
  await query(
    `INSERT INTO public.users (id, tenant_id, email, password_hash, first_name, last_name, roles, permissions, accessible_entities)
     VALUES ($1, $2, 'admin@demo.com', '$2b$10$dummyhash', 'Admin', 'User',
             '["owner"]', '["*"]', $3)
     ON CONFLICT (tenant_id, email) DO NOTHING`,
    [USER_ID, TENANT_ID, JSON.stringify([ENTITY_ID])]
  );

  // 3. Create organization
  await query(
    `INSERT INTO organizations (id, tenant_id, name, type)
     VALUES ($1, $2, 'Demo Corp', 'operating')
     ON CONFLICT DO NOTHING`,
    [ORG_ID, TENANT_ID]
  );

  // 4. Create legal entity
  await query(
    `INSERT INTO legal_entities (id, organization_id, tenant_id, name, entity_type, tax_id, tax_id_type, incorporation_country, functional_currency, accounting_standard)
     VALUES ($1, $2, $3, 'Demo Corp MX', 'sapi', 'XAXX010101000', 'rfc', 'MX', 'MXN', 'mx_nif')
     ON CONFLICT DO NOTHING`,
    [ENTITY_ID, ORG_ID, TENANT_ID]
  );

  // 5. Create fiscal year and periods (2026)
  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, 2026, '2026-01-01', '2026-12-31', true, 'open')
     ON CONFLICT DO NOTHING`,
    [FISCAL_YEAR_ID, ENTITY_ID]
  );

  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const periodIds: string[] = [];

  for (let i = 0; i < 12; i++) {
    const periodId = uuidv4();
    periodIds.push(periodId);
    const startDate = new Date(2026, i, 1);
    const endDate = new Date(2026, i + 1, 0);
    const status = i < 3 ? 'open' : 'future';

    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [periodId, FISCAL_YEAR_ID, ENTITY_ID, i + 1, `${months[i]} 2026`, startDate, endDate, status]
    );
  }

  // 6. Chart of Accounts (Standard Mexican COA)
  const accounts = [
    // Assets
    { code: '1000', name: 'Activo', type: 'asset', sub: null, fs: 'current_assets', balance: 'debit', header: true },
    { code: '1100', name: 'Activo Circulante', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', header: true, parent: '1000' },
    { code: '1110', name: 'Caja y Bancos', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1111', name: 'Banco Nacional - MXN', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1112', name: 'Banco Nacional - USD', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1120', name: 'Cuentas por Cobrar', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1130', name: 'IVA Acreditable', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1140', name: 'Inventarios', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1200', name: 'Activo Fijo', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', header: true, parent: '1000' },
    { code: '1210', name: 'Mobiliario y Equipo', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', parent: '1200' },
    { code: '1220', name: 'Equipo de Cómputo', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', parent: '1200' },
    { code: '1230', name: 'Equipo de Transporte', type: 'asset', sub: 'fixed_asset', fs: 'non_current_assets', balance: 'debit', parent: '1200' },
    { code: '1290', name: 'Depreciación Acumulada', type: 'contra_asset', sub: null, fs: 'non_current_assets', balance: 'credit', parent: '1200' },
    // Liabilities
    { code: '2000', name: 'Pasivo', type: 'liability', sub: null, fs: 'current_liabilities', balance: 'credit', header: true },
    { code: '2100', name: 'Pasivo Circulante', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', header: true, parent: '2000' },
    { code: '2110', name: 'Cuentas por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2120', name: 'IVA Trasladado', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2130', name: 'ISR por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2140', name: 'Retenciones por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    // Equity
    { code: '3000', name: 'Capital Contable', type: 'equity', sub: null, fs: 'equity', balance: 'credit', header: true },
    { code: '3100', name: 'Capital Social', type: 'equity', sub: 'common_stock', fs: 'equity', balance: 'credit', parent: '3000', system: true },
    { code: '3200', name: 'Resultado de Ejercicios Anteriores', type: 'equity', sub: 'retained_earnings', fs: 'equity', balance: 'credit', parent: '3000', system: true },
    { code: '3300', name: 'Resultado del Ejercicio', type: 'equity', sub: 'retained_earnings', fs: 'equity', balance: 'credit', parent: '3000' },
    { code: '3900', name: 'Resumen de Ingresos y Gastos', type: 'equity', sub: null, fs: 'equity', balance: 'credit', parent: '3000', system: true },
    // Revenue
    { code: '4000', name: 'Ingresos', type: 'revenue', sub: null, fs: 'revenue', balance: 'credit', header: true },
    { code: '4100', name: 'Ventas', type: 'revenue', sub: 'operating_revenue', fs: 'revenue', balance: 'credit', parent: '4000' },
    { code: '4200', name: 'Ingresos por Servicios', type: 'revenue', sub: 'operating_revenue', fs: 'revenue', balance: 'credit', parent: '4000' },
    { code: '4300', name: 'Otros Ingresos', type: 'revenue', sub: 'other_revenue', fs: 'other_income', balance: 'credit', parent: '4000' },
    // Expenses
    { code: '5000', name: 'Costos y Gastos', type: 'expense', sub: null, fs: 'operating_expenses', balance: 'debit', header: true },
    { code: '5100', name: 'Costo de Ventas', type: 'expense', sub: 'cost_of_goods', fs: 'cogs', balance: 'debit', parent: '5000' },
    { code: '6000', name: 'Gastos de Operación', type: 'expense', sub: null, fs: 'operating_expenses', balance: 'debit', header: true },
    { code: '6100', name: 'Gastos de Administración', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6000' },
    { code: '6110', name: 'Sueldos y Salarios', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6120', name: 'Renta de Oficina', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6130', name: 'Servicios Públicos', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6140', name: 'Depreciación', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6100' },
    { code: '6200', name: 'Gastos de Venta', type: 'expense', sub: 'operating_expense', fs: 'operating_expenses', balance: 'debit', parent: '6000' },
    { code: '6300', name: 'Gastos Financieros', type: 'expense', sub: 'other_expense', fs: 'other_expenses', balance: 'debit', parent: '6000' },
  ];

  // Build parent lookup
  const accountIds: Record<string, string> = {};
  for (const acct of accounts) {
    accountIds[acct.code] = uuidv4();
  }

  for (const acct of accounts) {
    const parentId = acct.parent ? accountIds[acct.parent] : null;
    await query(
      `INSERT INTO accounts (id, code, name, account_type, account_subtype, fs_category, normal_balance,
       entity_id, parent_id, is_header, is_system_account, allow_manual_entries, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (code, entity_id) DO NOTHING`,
      [
        accountIds[acct.code], acct.code, acct.name, acct.type,
        acct.sub || null, acct.fs, acct.balance,
        ENTITY_ID, parentId,
        acct.header || false,
        (acct as Record<string, unknown>).system || false,
        !(acct.header || false),
        USER_ID,
      ]
    );
  }

  // 7. Sample customer
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, email, payment_terms, currency_code, default_revenue_account_id, default_ar_account_id, created_by)
     VALUES ($1, $2, 'C-2026-00001', 'Cliente Demo SA de CV', 'XEXX010101000', 'rfc', 'cliente@demo.com', 'Net 30', 'MXN', $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [customerId, ENTITY_ID, accountIds['4100'], accountIds['1120'], USER_ID]
  );

  // 8. Sample vendor
  const vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, email, payment_terms, currency_code, default_expense_account_id, created_by)
     VALUES ($1, $2, 'V-2026-00001', 'Proveedor Demo SA', 'XAXX010101001', 'rfc', 'proveedor@demo.com', 'Net 30', 'MXN', $3, $4)
     ON CONFLICT DO NOTHING`,
    [vendorId, ENTITY_ID, accountIds['6100'], USER_ID]
  );

  // 9. Exchange rates
  await query(
    `INSERT INTO exchange_rates (id, from_currency, to_currency, rate, effective_date, source, rate_type, created_by)
     VALUES ($1, 'USD', 'MXN', 17.25, '2026-01-01', 'banco_mexico', 'spot', $2)
     ON CONFLICT DO NOTHING`,
    [uuidv4(), USER_ID]
  );

  // 10. Bank account
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, account_number_last4)
     VALUES ($1, $2, 'Cuenta Principal BBVA', 'BBVA', $3, 'MXN', '4567')
     ON CONFLICT DO NOTHING`,
    [uuidv4(), ENTITY_ID, accountIds['1111']]
  );

  console.log('Seed complete!');
  console.log(`
╔══════════════════════════════════════════════════╗
║  Seed Data Summary                               ║
╠══════════════════════════════════════════════════╣
║  Tenant ID:  ${TENANT_ID}  ║
║  Entity ID:  ${ENTITY_ID}  ║
║  User ID:    ${USER_ID}  ║
║  Email:      admin@demo.com                      ║
║  Accounts:   ${accounts.length} chart of accounts              ║
║  Periods:    12 fiscal periods (2026)            ║
║  Customer:   Cliente Demo SA de CV               ║
║  Vendor:     Proveedor Demo SA                   ║
╚══════════════════════════════════════════════════╝

Generate JWT token with:
  Entity ID: ${ENTITY_ID}
  User ID:   ${USER_ID}
  Tenant ID: ${TENANT_ID}
`);

  await closeDatabase();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
