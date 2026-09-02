import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * Catálogo de cuentas base para una entidad mexicana.
 *
 * Vivía embebido en src/database/seed.ts, donde solo lo alcanzaba `npm run
 * seed`. Se extrajo aquí porque `mnemosine init` NUNCA creaba catálogo: una
 * entidad recién creada no tenía ninguna de las cuentas que ROLE_MAP espera,
 * así que sembrar los roles a secas dejaba trece sin mapear —incluidos cxc,
 * cxp, banco, ingreso, gasto e IVA—, que son justo los que necesitan
 * postInvoiceEntry y postBillEntry.
 *
 * Las 38 filas están transcritas SIN cambios de código ni de nombre.
 */
export interface ChartAccountSpec {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
      | 'contra_asset' | 'contra_liability' | 'contra_equity';
  sub: string | null;
  fs: string;
  balance: 'debit' | 'credit';
  parent?: string;
  header?: boolean;
  system?: boolean;
}

// ── El catálogo, en tres estratos ────────────────────────────
//
// Vivía como una sola lista de 38 renglones llamada BASE_CHART_MX, y ese
// nombre escondía que sólo SEIS de sus cuentas son mexicanas. Las otras 32 son
// partida doble: activo, pasivo, capital, ingresos, costos y gastos, con los
// nombres en español porque el producto se usa en español, no porque el país
// las determine.
//
// Importaba porque `ensureEntityAccounting` sembraba la lista entera en TODA
// entidad sin mirar el país: una sociedad estadounidense nacía con «IVA
// Acreditable», «IVA Trasladado», «ISR por Pagar» y una cuenta de banco
// denominada en pesos. No estorbaban en silencio: son renglones del balance
// que se presentan, y el catálogo es lo primero que un contador revisa.

/** Partida doble. Lo que necesita cualquier entidad, sea del país que sea. */
export const CATALOGO_UNIVERSAL: ChartAccountSpec[] = [
    // Assets
    { code: '1000', name: 'Activo', type: 'asset', sub: null, fs: 'current_assets', balance: 'debit', header: true },
    { code: '1100', name: 'Activo Circulante', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', header: true, parent: '1000' },
    { code: '1110', name: 'Caja y Bancos', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '1120', name: 'Cuentas por Cobrar', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
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

/**
 * Lo que sólo tiene sentido en una contabilidad mexicana.
 *
 * Las dos cuentas de banco están aquí y no en el estrato universal porque
 * llevan la moneda en el nombre: «Banco Nacional - MXN» en el catálogo de una
 * sociedad de Delaware es un renglón que nadie va a usar y que además miente
 * sobre la moneda funcional de la entidad.
 */
export const ESTRATO_FISCAL_MX: ChartAccountSpec[] = [
    { code: '1111', name: 'Banco Nacional - MXN', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1112', name: 'Banco Nacional - USD', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1130', name: 'IVA Acreditable', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '2120', name: 'IVA Trasladado', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2130', name: 'ISR por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
    { code: '2140', name: 'Retenciones por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
];

/**
 * El mínimo fiscal de una entidad NO mexicana.
 *
 * No es un plan de cuentas estadounidense: el plan de cierre declara el carril
 * de EE. UU. «deliberadamente somero», y un catálogo US GAAP completo es
 * justamente lo que corta del alcance. Son las tres cuentas sin las cuales el
 * motor que YA existe no puede postear:
 *
 *   · el banco, porque el rol `banco` y el bucket `cash_payroll` lo exigen;
 *   · las dos de impuesto, porque postInvoiceEntry y postBillEntry piden los
 *     roles iva_trasladado / iva_acreditable en cuanto `tax_amount > 0`
 *     (ar-ap-posting.ts). Una factura estadounidense CON impuesto sobre ventas
 *     reventaría con MISSING_ROLE_ACCOUNT si no hubiera dónde ponerlo.
 *
 * Los nombres son genéricos a propósito: «Impuesto sobre Ventas» sirve para el
 * sales tax estadounidense y para cualquier otro impuesto trasladado, y no
 * promete un tratamiento fiscal que este motor no implementa.
 *
 * Códigos propios y no los mexicanos: dos semillas no pueden declarar el mismo
 * código con nombres distintos (criterio E1.1), y además reusar 1130 para algo
 * que no es IVA acreditable haría ilegible el catálogo de las dos.
 */
export const ESTRATO_FISCAL_NEUTRO: ChartAccountSpec[] = [
    { code: '1115', name: 'Cuenta Bancaria Operativa', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1110' },
    { code: '1136', name: 'Impuesto Acreditable sobre Compras', type: 'asset', sub: 'current_asset', fs: 'current_assets', balance: 'debit', parent: '1100' },
    { code: '2135', name: 'Impuesto sobre Ventas por Pagar', type: 'liability', sub: 'current_liability', fs: 'current_liabilities', balance: 'credit', parent: '2100' },
];

/**
 * El catálogo mexicano completo, que es lo que este nombre significó siempre.
 * Se conserva porque hay código y pruebas que lo nombran, y porque una entidad
 * mexicana tiene que recibir EXACTAMENTE lo mismo que antes de partir la lista.
 *
 * El orden importa: `ensureBaseChart` resuelve parent_id leyendo lo que ya
 * insertó, así que el padre tiene que preceder al hijo. Todos los padres viven
 * en el estrato universal, de modo que concatenarlo primero lo garantiza.
 */
export const BASE_CHART_MX: ChartAccountSpec[] = [...CATALOGO_UNIVERSAL, ...ESTRATO_FISCAL_MX];

/** El catálogo que le toca a una entidad según lleve o no libros mexicanos. */
export function catalogoBasePara(esMexicana: boolean): ChartAccountSpec[] {
  return esMexicana
    ? BASE_CHART_MX
    : [...CATALOGO_UNIVERSAL, ...ESTRATO_FISCAL_NEUTRO];
}

/**
 * Crea las cuentas del catálogo base que falten en la entidad. Idempotente:
 * ON CONFLICT (code, entity_id) DO NOTHING y devuelve solo los códigos que
 * realmente creó. El arreglo está ordenado topológicamente (el padre siempre
 * precede al hijo), así que parent_id se resuelve leyendo lo ya insertado.
 *
 * `esMexicana` decide QUÉ catálogo se siembra, no si se siembra: una entidad
 * no mexicana recibe el mismo andamiaje de partida doble y, en lugar del
 * estrato fiscal mexicano, el neutro. Por omisión true, que es la regla de la
 * casa ante la duda (ver pais-contable.ts) y deja intacto a todo llamador que
 * no se entere de este parámetro.
 *
 * No abre transacción propia: trabaja sobre el cliente que recibe.
 */
export async function ensureBaseChart(
  client: pg.PoolClient,
  entityId: string,
  createdBy: string,
  esMexicana = true
): Promise<string[]> {
  const existentes = await client.query<{ code: string; id: string }>(
    'SELECT code, id FROM accounts WHERE entity_id = $1',
    [entityId]
  );
  const porCodigo = new Map(existentes.rows.map((r) => [r.code, r.id]));
  const creadas: string[] = [];

  for (const c of catalogoBasePara(esMexicana)) {
    if (porCodigo.has(c.code)) continue;
    const parentId = c.parent ? porCodigo.get(c.parent) ?? null : null;
    const id = uuidv4();
    const res = await client.query<{ id: string }>(
      `INSERT INTO accounts (id, code, name, account_type, account_subtype, fs_category,
        normal_balance, entity_id, parent_id, is_header, is_system_account,
        allow_manual_entries, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (code, entity_id) DO NOTHING
       RETURNING id`,
      [id, c.code, c.name, c.type, c.sub ?? null, c.fs, c.balance, entityId, parentId,
       c.header ?? false, c.system ?? false, !(c.header ?? false), createdBy]
    );
    // Si otra transacción ganó la carrera, el RETURNING viene vacío: releer.
    const idReal = res.rows[0]?.id
      ?? (await client.query<{ id: string }>(
            'SELECT id FROM accounts WHERE code = $1 AND entity_id = $2', [c.code, entityId]
         )).rows[0]?.id;
    if (idReal) {
      porCodigo.set(c.code, idReal);
      if (res.rows[0]?.id) creadas.push(c.code);
    }
  }
  return creadas;
}
