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
    description:
      'ISR que terceros retuvieron a la empresa —clientes sobre honorarios y arrendamiento, y el ' +
      'banco sobre los intereses que paga— y que se acredita contra el impuesto propio. La ' +
      'descripción decía sólo «clientes» y por eso parecía que la retención bancaria necesitaba ' +
      'cuenta aparte: no la necesita, porque las dos son créditos contra el MISMO impuesto anual. ' +
      'Separarlas sería una cuenta más sin una pregunta detrás.',
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
    // 4300 y no 4200. El razonamiento de arriba es correcto y el número que
    // eligió lo contradecía: 4200 es «Ingresos por Servicios» en el catálogo
    // base, que corre ANTES, así que la guarda por código se saltaba esta
    // cuenta y el rol acababa apuntando a ingresos de operación — igual de
    // cotejables contra los CFDI emitidos que 4100, que es justo lo que la
    // descripción quería evitar. 4300 «Otros Ingresos» ya existe en el
    // catálogo base con este nombre exacto y este mismo fs_category; se
    // declara aquí ADEMÁS porque el catálogo base es condicional y sobre uno
    // importado la cuenta tiene que existir igual.
    code: '4300', name: 'Otros Ingresos', account_type: 'revenue',
    normal_balance: 'credit', fs_category: 'other_income',
    description:
      'Ingresos que no provienen de una venta. Existe porque la política ' +
      '`pago_corto_residual` permite tratar como ganancia el saldo que deja de ' +
      'deberse al cerrar un gasto pagando de menos, y esa ganancia no puede ' +
      'ensuciar 4100: las ventas se comparan contra los CFDI emitidos.',
  },
  {
    // F05d. Las comisiones NO van a 6300 «Gastos Financieros» aunque quepan:
    // ahí vive la pérdida cambiaria, y mezclar el costo de mover dinero con el
    // efecto de que el peso se movió empobrece el estado de resultados justo en
    // la línea donde un despacho mira si el banco le está saliendo caro.
    code: '6310', name: 'Comisiones y Gastos Bancarios', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'other_expenses',
    description:
      'Comisiones de manejo de cuenta, transferencias y devoluciones que cobra el banco. ' +
      'Su IVA se aparca en 1135 hasta que llega el CFDI del banco: sin comprobante no hay ' +
      'acreditamiento, por mucho que el cargo esté en el extracto.',
  },
  {
    // F05d. Separado de 4300 «Otros Ingresos» por la misma razón: el interés
    // que paga el banco es un producto financiero recurrente, y confundirlo con
    // lo esporádico esconde la única partida de ingreso que un tesorero mira.
    code: '4310', name: 'Productos Financieros', account_type: 'revenue',
    normal_balance: 'credit', fs_category: 'other_income',
    description:
      'Intereses ganados sobre saldos e inversiones. El ISR que el banco retiene sobre ellos ' +
      'NO es gasto: es pago provisional a favor (1145), y tratarlo como gasto lo pierde.',
  },
  {
    // F06a. La ficha del activo necesita a dónde mandar el gasto y el
    // acumulado, y una entidad que IMPORTÓ su catálogo puede no traer 1290 ni
    // 6140 — el mismo argumento que metió aquí a las cuatro cuentas de IVA.
    // La primera versión venía SIN rol «para no crear capacidad huérfana», y
    // la prueba de la casa la rechazó: toda cuenta de esta lista lleva su rol,
    // porque una cuenta sembrada que ningún rol nombra es exactamente la que
    // alguien cablea después a mano y por código.
    code: '1290', name: 'Depreciación Acumulada', account_type: 'contra_asset',
    normal_balance: 'credit', fs_category: 'non_current_assets',
    description: 'Contra-activo: el costo ya consumido de los activos fijos. La abona cada corrida mensual.',
  },
  {
    code: '6140', name: 'Depreciación', account_type: 'expense',
    normal_balance: 'debit', fs_category: 'operating_expenses',
    description: 'El gasto mensual por depreciación. Lo carga la corrida contra 1290.',
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
  otros_ingresos: '4300',
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
  depreciacion_acumulada: '1290',
  depreciacion_gasto: '6140',
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
  comision_bancaria: '6310',
  producto_financiero: '4310',
  utilidad_cambiaria: '4300',
  perdida_cambiaria: '6300',
};

// ── Qué de todo esto es mexicano ─────────────────────────────
//
// REQUIRED_ACCOUNTS y ROLE_MAP se sembraban ENTEROS en toda entidad, sin mirar
// el país, porque esta capa nació para el CFDI y el CFDI es mexicano por
// definición. Pero la lista mezcla dos cosas: impuestos mexicanos (IVA, IEPS,
// retenciones, IMSS) y contabilidad general que cualquier país necesita
// (anticipos de clientes y proveedores, pagos anticipados, sueldos por pagar,
// devoluciones sobre ventas y sobre compras).
//
// Separarlas no es cosmética: catorce de los treinta y un roles apuntan a
// códigos que sólo trae el catálogo base, y `ar-ap-posting.ts` exige cxc, cxp,
// banco, ingreso y gasto con requireRole en toda factura. Quitarle los roles a
// una entidad no mexicana la dejaría sin postear nada; quitarle sólo el
// estrato fiscal mexicano le quita exactamente lo que no puede usar.

/** Códigos de REQUIRED_ACCOUNTS que sólo existen en una contabilidad mexicana. */
const CODIGOS_FISCALES_MX = new Set([
  '1130', // IVA Acreditable
  '1135', // IVA Pendiente de Acreditar
  '1145', // ISR Retenido a Favor
  '1146', // IVA Retenido a Favor
  '1165', // IEPS Acreditable
  '2120', // IVA Trasladado
  '2125', // IVA Trasladado No Cobrado
  '2170', // IMSS por Pagar
  '2180', // IEPS por Pagar
  '2190', // Impuestos Locales por Pagar
]);

/**
 * Roles que no significan nada fuera de México. Los dos genéricos de impuesto
 * —iva_trasladado e iva_acreditable— NO están aquí a propósito: el motor los
 * pide en cuanto una factura trae impuesto, venga de donde venga, así que una
 * entidad no mexicana los conserva apuntando al estrato fiscal neutro.
 */
const ROLES_FISCALES_MX: readonly AccountRole[] = [
  'iva_trasladado_no_cobrado',
  'iva_pendiente_acreditar',
  'isr_retenido_por_pagar',
  'iva_retenido_por_pagar',
  'isr_retenido_a_favor',
  'iva_retenido_a_favor',
  'ieps_acreditable',
  'ieps_por_pagar',
  'impuestos_locales_gasto',
  'impuestos_locales_por_pagar',
  'isr_nomina_por_pagar',
  'imss_por_pagar',
];

/** Dónde caen los dos roles genéricos de impuesto en una entidad no mexicana. */
const ROLES_NEUTROS: Partial<Record<AccountRole, string>> = {
  iva_trasladado: '2135',   // Impuesto sobre Ventas por Pagar
  iva_acreditable: '1136',  // Impuesto Acreditable sobre Compras
};

/** Las cuentas que le tocan a la entidad según lleve o no libros mexicanos. */
export function cuentasRequeridasPara(esMexicana: boolean): AccountSpec[] {
  return esMexicana
    ? REQUIRED_ACCOUNTS
    : REQUIRED_ACCOUNTS.filter((a) => !CODIGOS_FISCALES_MX.has(a.code));
}

/**
 * Los roles que le tocan a la entidad.
 *
 * Se DERIVA de ROLE_MAP en vez de escribirse aparte: ROLE_MAP está tipado
 * `Record<AccountRole, string>`, así que el compilador obliga a mapear todo rol
 * nuevo de la taxonomía. Una segunda lista escrita a mano perdería esa
 * garantía y se desincronizaría en el primer rol que alguien añada.
 */
export function rolesPara(esMexicana: boolean): Partial<Record<AccountRole, string>> {
  if (esMexicana) return ROLE_MAP;
  const salida: Partial<Record<AccountRole, string>> = {};
  for (const [rol, codigo] of Object.entries(ROLE_MAP) as [AccountRole, string][]) {
    if (ROLES_FISCALES_MX.includes(rol)) continue;
    salida[rol] = ROLES_NEUTROS[rol] ?? codigo;
  }
  return salida;
}

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
   *  el alta de entidad siembra catálogo y roles en un solo acto.
   *  `esMexicana` por omisión true: ante la duda, contabilidad mexicana. */
  options?: { client?: pg.PoolClient; esMexicana?: boolean }
): Promise<SeedResult> {
  const esMexicana = options?.esMexicana ?? true;
  const run = async (client: pg.PoolClient): Promise<SeedResult> => {
    const existing = await client.query<{ code: string; id: string }>(
      'SELECT code, id FROM accounts WHERE entity_id = $1',
      [entityId]
    );
    const byCode = new Map(existing.rows.map((r) => [r.code, r.id]));
    const accountsCreated: string[] = [];

    for (const spec of cuentasRequeridasPara(esMexicana)) {
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
    for (const [role, code] of Object.entries(rolesPara(esMexicana))) {
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
