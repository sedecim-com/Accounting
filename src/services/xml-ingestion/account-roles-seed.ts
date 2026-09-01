import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import type { AccountRole } from './cfdi-taxonomy.js';

// ============================================================
// SEED OF ACCOUNTING ROLES
// The CFDI taxonomy expresses entries with abstract ROLES; this
// maps them to concrete accounts. Accounts a Mexican chart needs
// but a minimal seed usually lacks (IVA pending credit, advances,
// withholdings receivable) are created here rather than silently
// mapped to something close enough.
// ============================================================

interface AccountSpec {
  code: string;
  name: string;
  account_type:
    | 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
    | 'contra_asset' | 'contra_liability' | 'contra_equity';
  normal_balance: 'debit' | 'credit';
  fs_category?: string;
  description: string;
}

/**
 * Accounts required by the taxonomy that a minimal chart lacks.
 * Codes follow the existing numbering so they slot in naturally.
 */
export const REQUIRED_ACCOUNTS: AccountSpec[] = [
  // ── Assets ──
  {
    // Lives in BASE_CHART_MX too, and it is listed HERE as well on purpose.
    // The base chart is only built when an entity has no accounts at all
    // (the 'auto' strategy), so a client onboarded with its own chart used to
    // end up with 1135 mapped and 1130 missing — which made every PUE bill
    // and every PPD release throw MISSING_ROLE_ACCOUNT. In Mexico the four
    // IVA accounts are not optional, so all four are seeded unconditionally.
    code: '1130', name: 'IVA Acreditable', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description:
      'IVA efectivamente pagado y por tanto acreditable en el mes. Es el destino del ' +
      '1135 cuando llega el REP.',
  },
  {
    code: '1135', name: 'IVA Pendiente de Acreditar', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description:
      'IVA de facturas PPD todavía no pagadas. En México el IVA se acredita al PAGAR ' +
      '(con el REP), no al recibir la factura: sin esta cuenta el acreditamiento del mes se infla.',
  },
  {
    code: '1145', name: 'ISR Retenido a Favor', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description: 'ISR que los clientes retuvieron a la empresa; se acredita contra el impuesto propio.',
  },
  {
    code: '1146', name: 'IVA Retenido a Favor', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description: 'IVA que los clientes retuvieron a la empresa.',
  },
  {
    code: '1150', name: 'Anticipo a Proveedores', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description: 'Anticipos pagados: es un derecho a recibir el bien o servicio, no un gasto.',
  },
  {
    code: '1160', name: 'Pagos Anticipados', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description: 'Seguros, rentas y suscripciones que cubren periodos futuros; se devengan mes a mes.',
  },
  {
    code: '1165', name: 'IEPS Acreditable', account_type: 'asset',
    normal_balance: 'debit', fs_category: 'current_assets',
    description: 'Solo para contribuyentes de IEPS; si no lo es, el IEPS es parte del costo.',
  },
  // ── Liabilities ──
  {
    // Same reason as 1130: seeded here as well as in the base chart, so an
    // onboarded chart cannot be left with the pending account but not the
    // due one.
    code: '2120', name: 'IVA Trasladado', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description:
      'IVA efectivamente cobrado y por tanto causado en el mes. Es el destino del ' +
      '2125 cuando se cobra la factura.',
  },
  {
    code: '2125', name: 'IVA Trasladado No Cobrado', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description:
      'IVA de ventas PPD aún no cobradas. El IVA se causa al COBRAR: llevarlo directo a ' +
      'IVA Trasladado adelanta el entero del impuesto.',
  },
  {
    code: '2150', name: 'Anticipos de Clientes', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Anticipos recibidos: pasivo hasta que se devenga el ingreso.',
  },
  {
    code: '2160', name: 'Sueldos por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Neto de nómina pendiente de pagar al trabajador.',
  },
  {
    code: '2170', name: 'IMSS por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'Cuotas obrero-patronales pendientes de entero.',
  },
  {
    code: '2180', name: 'IEPS por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'IEPS trasladado a clientes, pendiente de entero.',
  },
  {
    code: '2190', name: 'Impuestos Locales por Pagar', account_type: 'liability',
    normal_balance: 'credit', fs_category: 'current_liabilities',
    description: 'ISH y otros impuestos estatales; viven en su propio complemento del CFDI.',
  },
  // ── Results ──
  {
    code: '4400', name: 'Devoluciones y Descuentos sobre Ventas', account_type: 'revenue',
    normal_balance: 'debit', fs_category: 'revenue',
    description: 'Contra-ingreso: reduce las ventas, no es un gasto.',
  },
  {
    code: '5200', name: 'Devoluciones y Descuentos sobre Compras', account_type: 'expense',
    normal_balance: 'credit', fs_category: 'cogs',
    description: 'Contra-costo: reduce las compras.',
  },
  {
    code: '6900', name: 'Gastos No Deducibles', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description:
      'Consumos no deducibles, pagos en efectivo sobre el límite y demás partidas que no ' +
      'cumplen requisitos fiscales. Separarlas simplifica la conciliación fiscal-contable.',
  },
];

/**
 * Role → account code. Where the chart already had a suitable account it is
 * reused; the rest point to the ones created above.
 */
export const ROLE_MAP: Record<AccountRole, string> = {
  // Income and collection
  ingreso: '4100',
  devolucion_ventas: '4400',
  anticipo_clientes: '2150',
  cxc: '1120',
  banco: '1110',
  iva_trasladado: '2120',
  iva_trasladado_no_cobrado: '2125',
  // Purchases, expenses and assets
  gasto: '6100',
  gasto_no_deducible: '6900',
  gasto_anticipado: '1160',
  inventario: '1140',
  activo_fijo: '1210',
  devolucion_compras: '5200',
  anticipo_proveedores: '1150',
  cxp: '2110',
  iva_acreditable: '1130',
  iva_pendiente_acreditar: '1135',
  // Withholdings
  isr_retenido_por_pagar: '2140',
  iva_retenido_por_pagar: '2140',
  isr_retenido_a_favor: '1145',
  iva_retenido_a_favor: '1146',
  // Other taxes
  ieps_acreditable: '1165',
  ieps_por_pagar: '2180',
  impuestos_locales_gasto: '6100',
  impuestos_locales_por_pagar: '2190',
  // Payroll
  sueldos_gasto: '6110',
  sueldos_por_pagar: '2160',
  isr_nomina_por_pagar: '2140',
  imss_por_pagar: '2170',
  // FX differences
  utilidad_cambiaria: '4300',
  perdida_cambiaria: '6300',
};

export interface SeedResult {
  accountsCreated: string[];
  rolesMapped: number;
  /** Roles whose account is missing from the chart and could not be mapped. */
  unmapped: Array<{ role: string; code: string }>;
}

/**
 * Idempotent: creates only the missing accounts and maps only the roles that
 * have no mapping yet, so re-running it never overwrites a manual choice.
 */
export async function seedAccountRoles(
  entityId: string,
  tenantId: string,
  createdBy: string,
  /** Corre dentro de la transacción del llamador en vez de abrir una propia:
   *  el alta de entidad siembra catálogo y roles en un solo acto. */
  options?: { client?: pg.PoolClient }
): Promise<SeedResult> {
  const run = async (client: pg.PoolClient): Promise<SeedResult> => {
    const existing = await client.query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1',
      [entityId]
    );
    const byCode = new Map(existing.rows.map((r) => [r.code, r.id]));
    const accountsCreated: string[] = [];

    for (const spec of REQUIRED_ACCOUNTS) {
      if (byCode.has(spec.code)) continue;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO accounts (
           code, name, account_type, normal_balance, fs_category, description,
           entity_id, allow_manual_entries, is_header, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,false,$8)
         RETURNING id`,
        [
          spec.code, spec.name, spec.account_type, spec.normal_balance,
          spec.fs_category ?? null, spec.description, entityId, createdBy,
        ]
      );
      byCode.set(spec.code, inserted.rows[0].id);
      accountsCreated.push(`${spec.code} ${spec.name}`);
    }

    let rolesMapped = 0;
    const unmapped: SeedResult['unmapped'] = [];
    for (const [role, code] of Object.entries(ROLE_MAP)) {
      const accountId = byCode.get(code);
      if (!accountId) {
        unmapped.push({ role, code });
        continue;
      }
      const r = await client.query(
        `INSERT INTO account_roles (tenant_id, entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)
         -- No target: uniqueness lives in two partial indexes (default role
         -- with qualifier NULL, and qualified role). Naming the old
         -- constraint would not protect the NULL case at all.
         ON CONFLICT DO NOTHING`,
        [tenantId, entityId, role, accountId]
      );
      rolesMapped += r.rowCount ?? 0;
    }

    return { accountsCreated, rolesMapped, unmapped };
  };

  return options?.client ? run(options.client) : withTransaction(run);
}
